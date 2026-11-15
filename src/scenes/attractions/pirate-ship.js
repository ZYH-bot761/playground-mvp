/**
 * ============================================================================
 * PirateShip.js —— 海盗船（M10 · 奇幻冒险风视觉升级 + 座位按钮点击修复）
 * ============================================================================
 * 【运动模型】（提示词 2.3，参数取值见交付报告）
 *   elapsed += clamp(dt, 0, 0.1)
 *   omega   = 2π / PERIOD                       PERIOD = 3.0s
 *   phase   = elapsed * omega                  ← 由累计时间算，杜绝相位漂移
 *   baseEnv = sin(π · min(elapsed / 30, 1))    开场 / 结算振幅为 0
 *   fadeIn  = smoothstep(0, 2.5, elapsed)      2.5s 缓入
 *   fadeOut = smoothstep(0, 3.0, 30 - elapsed) 最后 3s 缓出
 *   amp     = MAX_AMP · baseEnv · fadeIn · fadeOut   MAX_AMP = 1.0 rad ≈57.3°
 *   pivot.rotation.z = sin(phase) · amp
 *
 * 【防眩晕】FOV 92；晃动为 2 倍主频谐波（无随机 / noise），pitch/yaw ≤0.02rad、
 *   X/Y 平移 ≤0.03；晃动强度随 amp/MAX_AMP 缩放。
 *
 * 【视角·第三部分】甲板第一人称：camera.quaternion = 船体世界四元数 × 座位基准 ×
 *   环顾四元数（yaw±90°/pitch±45°，相对船体），相机始终垂直甲板随船倾斜；位置用
 *   帧率归一 lerp(0.2) 惯性延迟跟随，朝向 slerp(0.3)。V 键切第三人称侧后方全船；
 *   ESC 经 0.7s lerp/slerp 平滑回大厅。拖拽环顾仅在 RIDING/READY 生效。
 *
 * 【视觉】平滑曲面船体（SphereGeometry 顶点变形）+ 弧形 TubeGeometry 撞角、
 *   多层错落船尾舱室、发光舷窗、暖光提灯、鼓起的半透明船帆、细缆绳、
 *   拱门式木石支架、程序化木纹 / 帆布 / 海盗旗贴图；全面 MeshPhysicalMaterial。
 *
 * 【性能】静态部件用 mergeGeometries 合并，舷窗 / 提灯 / 座椅用 InstancedMesh，
 *   缆绳用单个 LineSegments。改造前 20 个 Mesh，本版仍控制在该预算内。
 *
 * 【点击修复】pointer-events 是继承属性：容器 .ps-ui 设为 none 后，
 *   .ps-panel / .ps-seat / .ps-btn 会一并继承 none，而全屏 .ps-shade 显式设了
 *   auto 把点击全部吃掉 → 座位按钮永远收不到事件。现在给所有可交互子元素
 *   显式恢复 pointer-events:auto。
 * ============================================================================
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { IAttraction } from './i-attraction.js';

/* ------------------------------- 参数 ------------------------------------ */

const STATE = Object.freeze({
  SELECT: 'select', READY: 'ready', RIDING: 'riding', OVER: 'over',
});

const PERIOD = 3.0;
const OMEGA = (Math.PI * 2) / PERIOD;
const MAX_AMP = 1.0;
const RIDE_SECONDS = 30;
const READY_SECONDS = 2.0;
const FADE_IN_SECONDS = 2.5;
const FADE_OUT_SECONDS = 3.0;
const SHAKE_HARMONIC = 2;
const CAMERA_FOV = 92;

/* ---- 视角（第三部分）：甲板第一人称 + 船体系环顾 + 惯性 + V 键第三人称 ---- */
const LOOK_YAW_LIMIT = Math.PI / 2;    // 环顾 yaw ±90°（相对船体）
const LOOK_PITCH_LIMIT = Math.PI / 4;  // 环顾 pitch ±45°（相对船体）
const FOLLOW_FACTOR = 0.2;             // 位置惯性延迟（手册 0.1~0.3，帧率归一）
const ORI_FACTOR = 0.3;                // 朝向 slerp：近甲板锁定又平滑 V 切换
const THIRD_POS = Object.freeze([-10.5, 7.5, 14.5]); // 第三人称侧后方机位
const THIRD_LOOK = Object.freeze([0, 5.0, 0]);
const EXIT_BLEND_SECONDS = 0.7;        // ESC 平滑回大厅
const DRAG_THRESHOLD_PX = 6;

/** 三档座位：偏移为 pivot 局部坐标，init 时预计算缓存，运行时只 copy */
const SEAT_DEFS = Object.freeze([
  {
    key: 'front', label: '前排 · 极致刺激',
    pos: [3.6, -4.8, 1.6], look: [10.0, -5.5, 1.6],
    shakeRot: 0.020, shakePos: 0.030,
    desc: '船头撞角附近，摆幅与失重感最强，视野最开阔',
  },
  {
    key: 'middle', label: '中间 · 平稳舒适',
    pos: [0, -3.4, 1.6], look: [9.0, -5.5, 3.2],
    shakeRot: 0.008, shakePos: 0.012,
    desc: '靠近摆动轴心，晃动最小，可完整欣赏全程',
  },
  {
    key: 'back', label: '后排 · 反向视角',
    pos: [-3.6, -4.8, 1.6], look: [-9.0, -5.5, 3.2],
    shakeRot: 0.014, shakePos: 0.020,
    desc: '朝支撑塔与后方景观，体感与前排不同',
  },
]);

/* --------------------------- 程序化纹理 ---------------------------------- */

/** 暖棕红木纹：年轮曲线 + 板缝 + 高光，全部 CanvasTexture 设 SRGBColorSpace */
function makeWoodTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const base = g.createLinearGradient(0, 0, 0, 256);
  base.addColorStop(0, '#8a4b2c'); base.addColorStop(0.5, '#a3603a'); base.addColorStop(1, '#713a22');
  g.fillStyle = base; g.fillRect(0, 0, 512, 256);
  // 木板缝
  for (let i = 0; i <= 8; i += 1) {
    const y = (i * 256) / 8;
    g.fillStyle = 'rgba(44,20,10,0.55)'; g.fillRect(0, y, 512, 3);
    g.fillStyle = 'rgba(240,186,126,0.20)'; g.fillRect(0, y + 3, 512, 2);
  }
  // 木纹年轮（贝塞尔曲线，粗细交替）
  for (let i = 0; i < 34; i += 1) {
    const y = (i * 256) / 34 + (i % 3) * 2;
    g.strokeStyle = i % 2 ? 'rgba(58,26,12,0.30)' : 'rgba(232,166,104,0.22)';
    g.lineWidth = 0.8 + (i % 3) * 0.7;
    g.beginPath(); g.moveTo(0, y);
    g.bezierCurveTo(150, y + 7 * Math.sin(i), 340, y - 8 * Math.cos(i * 0.7), 512, y + 3);
    g.stroke();
  }
  // 节疤
  for (let i = 0; i < 7; i += 1) {
    const x = 40 + i * 71, y = 30 + (i * 97) % 190;
    g.strokeStyle = 'rgba(50,22,10,0.45)'; g.lineWidth = 1.6;
    for (let r = 3; r < 13; r += 3) {
      g.beginPath(); g.ellipse(x, y, r, r * 0.55, 0.4, 0, Math.PI * 2); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'pirate/wood-grain';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 帆布：米色织纹 + 罗盘玫瑰图案 */
function makeSailTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f2e3c2'; g.fillRect(0, 0, 256, 256);
  // 织纹
  g.strokeStyle = 'rgba(160,130,86,0.16)'; g.lineWidth = 1;
  for (let i = 0; i < 256; i += 6) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  // 罗盘玫瑰
  g.translate(128, 128);
  g.fillStyle = 'rgba(92,48,38,0.82)';
  for (let k = 0; k < 8; k += 1) {
    g.rotate(Math.PI / 4);
    g.beginPath(); g.moveTo(0, -58); g.lineTo(11, -12); g.lineTo(0, 0); g.lineTo(-11, -12);
    g.closePath(); g.fill();
  }
  g.strokeStyle = 'rgba(92,48,38,0.7)'; g.lineWidth = 3;
  g.beginPath(); g.arc(0, 0, 66, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(0, 0, 74, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(92,48,38,0.9)';
  g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'pirate/sail-canvas';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 夜港水面：深蓝渐变 + 横向波纹 + 零星暖光倒影，让暖木色船体跳出来 */
function makeHarborTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2c4a68'); grad.addColorStop(1, '#16293e');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 46; i += 1) {
    const y = (i * 256) / 46;
    g.strokeStyle = i % 3 ? 'rgba(150,200,235,0.10)' : 'rgba(255,205,130,0.14)';
    g.lineWidth = 0.8 + (i % 4) * 0.5;
    g.beginPath(); g.moveTo(0, y);
    g.bezierCurveTo(80, y + 4, 170, y - 4, 256, y + 1);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'pirate/harbor-water';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 7);
  tex.needsUpdate = true;
  return tex;
}

/** 海盗旗：深红底 + 骷髅与交叉弯刀（纯程序化绘制） */
function makeFlagTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 160);
  grad.addColorStop(0, '#8f1f22'); grad.addColorStop(1, '#4a1116');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 160);
  g.strokeStyle = 'rgba(240,200,120,0.75)'; g.lineWidth = 4;
  g.strokeRect(8, 8, 240, 144);
  // 交叉弯刀
  g.strokeStyle = '#f2dfae'; g.lineWidth = 7; g.lineCap = 'round';
  g.beginPath(); g.moveTo(58, 118); g.quadraticCurveTo(128, 74, 198, 42); g.stroke();
  g.beginPath(); g.moveTo(198, 118); g.quadraticCurveTo(128, 74, 58, 42); g.stroke();
  // 骷髅
  g.fillStyle = '#f7ecd0';
  g.beginPath(); g.ellipse(128, 76, 27, 24, 0, 0, Math.PI * 2); g.fill();
  g.fillRect(114, 92, 28, 13);
  g.fillStyle = '#4a1116';
  g.beginPath(); g.ellipse(119, 74, 7, 9, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(137, 74, 7, 9, 0, 0, Math.PI * 2); g.fill();
  g.fillRect(125, 86, 6, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'pirate/flag-jolly';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------- 几何构建（只在 init 调用） -------------------------- */

/** 把若干「基础几何 + 变换」合并成一个 BufferGeometry */
function mergeParts(parts) {
  const clones = parts.map(({ geo, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] }) => {
    const g = geo.clone();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot));
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(...pos), q, new THREE.Vector3(...scale)
    ));
    return g;
  });
  const merged = mergeGeometries(clones, false);
  clones.forEach((g) => g.dispose());
  if (!merged) throw new Error('[PirateShip] mergeGeometries 失败：输入几何属性不一致');
  merged.computeBoundingSphere();
  return merged;
}

/** 平滑曲面船体：SphereGeometry 顶点变形 —— 两头收尖、甲板削平、船底收窄 */
function makeHullGeometry() {
  const g = new THREE.SphereGeometry(1, 32, 18);
  const p = g.attributes.position;
  const L = 4.35;
  for (let i = 0; i < p.count; i += 1) {
    let x = p.getX(i) * L;
    let y = p.getY(i) * 0.95;
    let z = p.getZ(i) * 1.58;
    const taper = Math.max(0.10, 1 - 0.80 * Math.pow(Math.abs(x) / L, 2.4));
    z *= taper;
    if (y > 0.22) y = 0.22 + (y - 0.22) * 0.14;   // 平甲板
    if (y < 0) { x *= 1 + y * 0.05; z *= 1 + y * 0.24; } // 圆润船底
    y += 0.20 * Math.pow(Math.max(0, x) / L, 3);   // 船头微翘
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 船形甲板：贝塞尔曲线 Shape + bevel 挤出，边缘柔和 */
function makeDeckGeometry() {
  const s = new THREE.Shape();
  s.moveTo(4.05, 0);
  s.bezierCurveTo(2.9, 1.34, -2.5, 1.30, -3.95, 0);
  s.bezierCurveTo(-2.5, -1.30, 2.9, -1.34, 4.05, 0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.12, bevelEnabled: true, bevelSize: 0.09,
    bevelThickness: 0.06, bevelSegments: 2, curveSegments: 18,
  });
  g.rotateX(-Math.PI / 2);
  g.clearGroups(); // 单材质渲染，去掉 Extrude 的材质组避免多余绘制
  g.computeVertexNormals();
  return g;
}

/** 弧形撞角：TubeGeometry 沿 CatmullRom 曲线向前上方卷起 */
function makeRamGeometry() {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(3.85, 0.05, 0),
    new THREE.Vector3(4.62, 0.38, 0),
    new THREE.Vector3(5.20, 1.05, 0),
    new THREE.Vector3(5.24, 1.78, 0),
  ]);
  return new THREE.TubeGeometry(curve, 20, 0.13, 10, false);
}

/** 鼓起的帆：PlaneGeometry 顶点沿法线推出，中央最鼓 */
function makeSailGeometry(w, h, bulge) {
  const g = new THREE.PlaneGeometry(w, h, 10, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i += 1) {
    const nx = p.getX(i) / (w / 2);
    const ny = p.getY(i) / (h / 2);
    p.setZ(i, bulge * (1 - nx * nx) * (1 - 0.25 * ny * ny));
  }
  g.computeVertexNormals();
  return g;
}

/** 缆绳：单个 LineSegments 的顶点对（桅顶 → 船头/尾/两舷 + 横桁斜拉） */
function makeRopeGeometry() {
  const pts = [];
  const seg = (a, b) => pts.push(...a, ...b);
  const top = [0, 4.35, 0];
  seg(top, [3.55, 0.55, 0]);
  seg(top, [-3.55, 0.55, 0]);
  seg(top, [0, 0.55, 1.42]);
  seg(top, [0, 0.55, -1.42]);
  seg([0, 3.55, 0], [1.75, 3.35, 0.35]);
  seg([0, 3.55, 0], [-1.75, 3.35, 0.35]);
  seg([0, 2.45, 0], [1.55, 2.30, -0.35]);
  seg([0, 2.45, 0], [-1.55, 2.30, -0.35]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/* ------------------------- 纹理引用扫描（清理用） ------------------------- */

function scanTextureValue(value, path, out, seen, depth, replacer) {
  if (value == null || depth > 4) return;
  if (typeof value === 'object' && value.isTexture === true) {
    out.push({ texture: value, path, clear: () => replacer(null) });
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanTextureValue(value[i], `${path}[${i}]`, out, seen, depth + 1, (nv) => { value[i] = nv; });
    }
    return;
  }
  for (const key of Object.keys(value)) {
    scanTextureValue(value[key], `${path}.${key}`, out, seen, depth + 1, (nv) => { value[key] = nv; });
  }
}

function collectMaterialTextureReferences(material, index) {
  const out = [];
  if (!material) return out;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture === true) {
      out.push({ texture: value, path: `materials[${index}].${key}`, clear: () => { material[key] = null; } });
    }
  }
  const uniforms = material.uniforms;
  if (!uniforms || typeof uniforms !== 'object') return out;
  const seen = new WeakSet();
  for (const name of Object.keys(uniforms)) {
    const uniform = uniforms[name];
    if (!uniform || typeof uniform !== 'object') continue;
    const value = 'value' in uniform ? uniform.value : uniform;
    scanTextureValue(value, `materials[${index}].uniforms.${name}.value`, out, seen, 0,
      (nv) => { uniform.value = nv; });
  }
  return out;
}

/* ------------------------------- UI -------------------------------------- */

const UI_CSS = `
.ps-ui{position:fixed;inset:0;z-index:22;pointer-events:none;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#f3f7ff}
/* 【修复】pointer-events 会继承：容器 none 后必须给面板/按钮显式恢复 auto，
   否则全屏 .ps-shade 的 auto 会吃掉所有点击，座位永远选不中。 */
.ps-panel,.ps-seat,.ps-btn,.ps-hud{pointer-events:auto}
.ps-shade{position:absolute;inset:0;background:rgba(8,12,26,.20);pointer-events:auto}
.ps-panel{position:absolute;top:50%;right:5%;left:auto;transform:translateY(-50%);
  width:min(420px,calc(100vw - 32px));padding:22px 24px;border-radius:16px;
  background:rgba(30,16,20,.94);border:1px solid rgba(240,190,120,.42);
  box-shadow:0 18px 50px rgba(0,0,0,.6);text-align:center}
.ps-panel[data-hidden='true'],.ps-shade[data-hidden='true'],.ps-hud[data-hidden='true'],
.ps-seats[data-hidden='true'],.ps-tip[data-hidden='true'],.ps-buttons[data-hidden='true']{display:none}
.ps-title{margin:0 0 8px;font-size:24px;font-weight:700;color:#ffd77a}
.ps-desc{margin:0 0 16px;font-size:13px;line-height:1.7;color:#dfd0c4}
.ps-tip{margin:0 0 16px;padding:9px 12px;border-radius:8px;font-size:12px;
  line-height:1.6;color:#ffe3b0;background:rgba(255,190,90,.12);
  border:1px solid rgba(255,190,90,.35)}
.ps-seats{display:flex;flex-direction:column;gap:9px;margin-bottom:10px}
.ps-seat{padding:12px 14px;border-radius:10px;cursor:pointer;text-align:left;
  color:#eef4ff;background:rgba(255,255,255,.07);border:1px solid rgba(220,170,120,.4)}
.ps-seat:hover{background:rgba(200,120,70,.28);border-color:rgba(255,210,150,.8)}
.ps-seat b{display:block;font-size:15px;margin-bottom:3px;color:#ffd77a}
.ps-seat span{font-size:12px;color:#d3c3b4}
.ps-btn{padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;
  color:#eef4ff;background:rgba(255,255,255,.09);border:1px solid rgba(220,170,120,.45)}
.ps-btn--primary{color:#241008;background:#ffd77a;border-color:#ffd77a}
.ps-buttons{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.ps-hud{position:absolute;top:18px;left:50%;transform:translateX(-50%);
  padding:9px 20px;border-radius:999px;white-space:nowrap;font-size:14px;font-weight:600;
  background:rgba(30,18,24,.8);border:1px solid rgba(255,215,120,.45);color:#ffe7b4}
@media (max-width:820px){.ps-panel{right:auto;left:50%;transform:translate(-50%,-50%)}}
@media (max-width:520px){.ps-panel{padding:16px}.ps-title{font-size:20px}}
`;

/* ========================================================================== */

export class PirateShip extends IAttraction {
  constructor() {
    super();
    this.root = new THREE.Group();
    this.root.name = 'PirateShip';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;
    this._cameraSaved = null;
    this._state = STATE.SELECT;
    this._seatIndex = -1;

    this._elapsed = 0;
    this._readyTimer = 0;
    this._currentAmplitude = 0;
    this._pivot = null;

    this._seats = [];
    this._tmpPos = null;
    this._tmpLook = null;
    // 视角状态（第三部分）：船体系环顾 / 惯性 / 第三人称 / 平滑退出
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._thirdPerson = false;
    this._dragging = false;
    this._lastPointer = null;
    this._downPos = null;
    this._exitBlend = -1;
    this._shipQuat = null;
    this._lookQuat = null;
    this._lookEuler = null;
    this._targetPos = null;
    this._targetQuat = null;
    this._blendPos = null;
    this._blendQuat = null;
    this._tmpMat = null;
    this._worldUp = null;
    // 提灯轻微呼吸（基于 elapsed 的正弦，不引入独立高频）
    this._lanternMaterial = null;

    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._listeners = [];
    this._uiRoot = null;
    this._uiStyle = null;
    this._ui = {};
  }

  _trackGeometry(g) { this._geometries.add(g); return g; }
  _trackMaterial(m) { this._materials.add(m); return m; }
  _trackTexture(t) { this._textures.add(t); return t; }

  _addListener(target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push({ target, type, fn });
  }

  /* ---------------------------------------------------------------------- */
  /* init                                                                   */
  /* ---------------------------------------------------------------------- */

  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera } = ctx;
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    // ① 接管相机
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      up: camera.up.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    camera.fov = CAMERA_FOV;
    camera.updateProjectionMatrix();

    // ② 座位缓存与临时向量（init 一次性分配，update 内零分配）
    const seatUp = new THREE.Vector3(0, 1, 0);
    const seatMat = new THREE.Matrix4();
    this._seats = SEAT_DEFS.map((def) => {
      const pos = new THREE.Vector3(...def.pos);
      const look = new THREE.Vector3(...def.look);
      // 座位基准朝向（船体系）：相机 -Z 对准 look，甲板上方为 up → 随船体倾斜
      seatMat.lookAt(pos, look, seatUp);
      return {
        key: def.key, label: def.label, desc: def.desc,
        pos, look,
        baseQuat: new THREE.Quaternion().setFromRotationMatrix(seatMat),
        shakeRot: def.shakeRot, shakePos: def.shakePos,
      };
    });
    this._tmpPos = new THREE.Vector3();
    this._tmpLook = new THREE.Vector3();
    this._shipQuat = new THREE.Quaternion();
    this._lookQuat = new THREE.Quaternion();
    this._lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._targetPos = new THREE.Vector3();
    this._targetQuat = new THREE.Quaternion();
    this._blendPos = new THREE.Vector3();
    this._blendQuat = new THREE.Quaternion();
    this._tmpMat = new THREE.Matrix4();
    this._worldUp = new THREE.Vector3(0, 1, 0);

    scene.add(this.root);

    // ③ merge 模板（内置索引几何，属性一致；模板本身也登记进台账）
    const shared = {
      box: this._trackGeometry(new THREE.BoxGeometry(1, 1, 1)),
      cylinder: this._trackGeometry(new THREE.CylinderGeometry(1, 1, 1, 12)),
      cone: this._trackGeometry(new THREE.ConeGeometry(1, 1, 10)),
      sphere: this._trackGeometry(new THREE.SphereGeometry(1, 10, 8)),
      torus: this._trackGeometry(new THREE.TorusGeometry(1, 0.12, 8, 20)),
      // 半圆拱（Torus arc=π，默认在 XY 平面，正好正对船身）
      arch: this._trackGeometry(new THREE.TorusGeometry(2.6, 0.17, 10, 28, Math.PI)),
    };

    // ④ 精细几何
    const geoHull = this._trackGeometry(makeHullGeometry());
    const geoDeck = this._trackGeometry(makeDeckGeometry());
    const geoRam = this._trackGeometry(makeRamGeometry());
    const geoRopes = this._trackGeometry(makeRopeGeometry());
    const geoGround = this._trackGeometry(new THREE.PlaneGeometry(90, 90));
    const geoFlag = this._trackGeometry(new THREE.PlaneGeometry(1.25, 0.78));
    const geoRing = this._trackGeometry(new THREE.TorusGeometry(0.24, 0.052, 8, 16));
    const geoGlow = this._trackGeometry(new THREE.CircleGeometry(0.19, 16));
    const geoLantern = this._trackGeometry(new THREE.SphereGeometry(0.115, 10, 8));
    const geoSeat = this._trackGeometry(new THREE.BoxGeometry(1, 1, 1));

    // 船尾多层错落舱室：木屋主体与红色屋顶各合并成 1 个几何（2 draw call）
    const geoCabin = this._trackGeometry(mergeParts([
      { geo: shared.box, pos: [-2.55, 0.72, 0], scale: [1.45, 0.85, 1.75] },
      { geo: shared.box, pos: [-3.25, 1.35, 0], scale: [0.85, 0.62, 1.25] },
      { geo: shared.box, pos: [-1.75, 1.15, 0.62], scale: [0.62, 0.48, 0.55] },
    ]));
    const geoRoofs = this._trackGeometry(mergeParts([
      { geo: shared.cone, pos: [-2.55, 1.35, 0], scale: [1.15, 0.55, 1.35] },
      { geo: shared.cone, pos: [-3.25, 1.85, 0], scale: [0.72, 0.42, 0.95] },
      { geo: shared.cone, pos: [-1.75, 1.55, 0.62], scale: [0.52, 0.34, 0.5] },
    ]));

    // 桅杆 + 横桁（合并）
    const geoMast = this._trackGeometry(mergeParts([
      { geo: shared.cylinder, pos: [0, 2.35, 0], scale: [0.10, 4.3, 0.10] },
      { geo: shared.cylinder, pos: [0, 3.45, 0], rot: [Math.PI / 2, 0, 0], scale: [0.065, 3.5, 0.065] },
      { geo: shared.cylinder, pos: [0, 2.35, 0], rot: [Math.PI / 2, 0, 0], scale: [0.055, 3.1, 0.055] },
      { geo: shared.sphere, pos: [0, 4.55, 0], scale: [0.16, 0.16, 0.16] },
    ]));

    // 3 张鼓帆合并成 1 个半透明几何
    const sailA = makeSailGeometry(2.9, 1.55, 0.42);
    const sailB = makeSailGeometry(2.5, 1.30, 0.34);
    const geoSails = this._trackGeometry(mergeParts([
      { geo: sailA, pos: [0, 3.85, 0.06] },
      { geo: sailB, pos: [0, 2.65, -0.10] },
      { geo: sailB, pos: [2.0, 3.50, 0.10], rot: [0, 0.18, 0], scale: [0.5, 0.78, 1] },
    ]));
    sailA.dispose(); sailB.dispose();

    // 拱门式支架：木石主体 + 金属包边，各合并成 1 个几何
    const woodParts = [];
    const metalParts = [];
    for (const z of [-4.2, 4.2]) {
      for (const x of [-2.4, 2.4]) {
        woodParts.push({ geo: shared.cylinder, pos: [x, 4.5, z], scale: [0.42, 9.0, 0.42] });
        metalParts.push({ geo: shared.torus, pos: [x, 0.28, z], rot: [Math.PI / 2, 0, 0], scale: [0.5, 0.5, 0.5] });
        metalParts.push({ geo: shared.torus, pos: [x, 8.72, z], rot: [Math.PI / 2, 0, 0], scale: [0.5, 0.5, 0.5] });
      }
      woodParts.push({ geo: shared.box, pos: [0, 9.0, z], scale: [5.5, 0.42, 0.46] });
      // 半圆拱（Torus arc=π 默认在 XY 平面，正好正对船身）
      metalParts.push({ geo: shared.arch, pos: [0, 6.55, z], scale: [1.02, 1.02, 1.02] });
    }
    metalParts.push({ geo: shared.cylinder, pos: [0, 9.25, 0], rot: [Math.PI / 2, 0, 0], scale: [0.30, 8.6, 0.30] });
    metalParts.push({ geo: shared.sphere, pos: [0, 9.6, -4.2], scale: [0.28, 0.28, 0.28] });
    metalParts.push({ geo: shared.sphere, pos: [0, 9.6, 4.2], scale: [0.28, 0.28, 0.28] });
    const geoTowerWood = this._trackGeometry(mergeParts(woodParts));
    const geoTowerMetal = this._trackGeometry(mergeParts(metalParts));

    // 金色腰线（沿船舷一圈的装饰细条，合并）
    const geoTrim = this._trackGeometry(mergeParts([
      { geo: shared.box, pos: [0, 0.34, 1.30], scale: [6.4, 0.075, 0.075] },
      { geo: shared.box, pos: [0, 0.34, -1.30], scale: [6.4, 0.075, 0.075] },
      { geo: shared.box, pos: [3.55, 0.34, 0], scale: [0.075, 0.075, 2.2] },
      { geo: shared.box, pos: [-3.55, 0.34, 0], scale: [0.075, 0.075, 2.2] },
    ]));

    // ⑤ 程序化纹理
    const texWood = this._trackTexture(makeWoodTexture());
    const texSail = this._trackTexture(makeSailTexture());
    const texFlag = this._trackTexture(makeFlagTexture());
    const texHarbor = this._trackTexture(makeHarborTexture());

    // ⑥ 材质：全面 MeshPhysicalMaterial
    const matHull = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texWood, color: 0xffffff, roughness: 0.74, metalness: 0,
      clearcoat: 0.28, clearcoatRoughness: 0.42,
    }));
    const matWood = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texWood, color: 0xe8c09a, roughness: 0.82, metalness: 0, clearcoat: 0.12,
    }));
    const matCabin = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x6f3a24, roughness: 0.78, metalness: 0, clearcoat: 0.2, flatShading: false,
    }));
    const matCabinRoof = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x8f2b26, roughness: 0.62, metalness: 0.05, clearcoat: 0.35,
    }));
    const matMetal = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xd8b878, roughness: 0.24, metalness: 1.0,
      clearcoat: 0.75, clearcoatRoughness: 0.18,
    }));
    const matGold = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xf6c866, roughness: 0.18, metalness: 1.0,
      clearcoat: 0.9, clearcoatRoughness: 0.1,
    }));
    const matSail = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texSail, roughness: 0.88, metalness: 0, side: THREE.DoubleSide,
      transparent: true, opacity: 0.94,
      sheen: 0.65, sheenColor: new THREE.Color(0xffe9c0),
    }));
    const matFlag = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texFlag, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
    }));
    const matRope = this._trackMaterial(new THREE.LineBasicMaterial({
      color: 0xe4cfa4, transparent: true, opacity: 0.85,
    }));
    const matPorthole = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffdf9c, emissive: 0xffae46, emissiveIntensity: 0.42,
      roughness: 0.28, metalness: 0.2, clearcoat: 0.8,
      side: THREE.DoubleSide,
    }));
    const matLantern = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffdda0, emissive: 0xff9a3c, emissiveIntensity: 0.72,
      roughness: 0.24, metalness: 0, clearcoat: 1.0,
    }));
    this._lanternMaterial = matLantern;
    const matAccent = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x9c2a24, roughness: 0.58, metalness: 0.08, clearcoat: 0.4,
    }));
    const matGround = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texHarbor, color: 0xffffff, roughness: 0.58, metalness: 0.16,
      clearcoat: 0.45, clearcoatRoughness: 0.35,
    }));
    // 远景礁石：低多边形深蓝灰，填补 92° 广角下原先大片空白的天空/海面
    const matRock = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x3d5468, roughness: 0.9, metalness: 0.05, flatShading: true,
    }));

    for (const g of this._geometries) register(g);
    for (const m of this._materials) register(m);
    for (const t of this._textures) register(t);

    // ⑦ 木栈道地面（给 92° 广角一个参照平面）
    const ground = new THREE.Mesh(geoGround, matGround);
    ground.name = 'PirateShip/ground';
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.root.add(ground);

    // ⑧ 拱门式支撑塔（2 draw call）
    const towerWood = new THREE.Mesh(geoTowerWood, matWood);
    towerWood.name = 'PirateShip/tower-wood';
    towerWood.castShadow = true;
    this.root.add(towerWood);
    const towerMetal = new THREE.Mesh(geoTowerMetal, matMetal);
    towerMetal.name = 'PirateShip/tower-metal';
    towerMetal.castShadow = true;
    this.root.add(towerMetal);

    // ⑨ 摆动 pivot 位于横梁中心，船体相对 pivot 向下偏移
    const pivot = new THREE.Group();
    pivot.name = 'PirateShip/pivot';
    pivot.position.set(0, 9.25, 0);
    this.root.add(pivot);
    this._pivot = pivot;

    const boat = new THREE.Group();
    boat.name = 'PirateShip/boat';
    boat.position.set(0, -6.0, 0);
    pivot.add(boat);

    const hull = new THREE.Mesh(geoHull, matHull);
    hull.name = 'PirateShip/hull-smooth';
    hull.castShadow = true;
    boat.add(hull);

    const deck = new THREE.Mesh(geoDeck, matWood);
    deck.name = 'PirateShip/deck-curved';
    deck.position.y = 0.30;
    boat.add(deck);

    const ram = new THREE.Mesh(geoRam, matGold);
    ram.name = 'PirateShip/ram-arc';
    ram.castShadow = true;
    boat.add(ram);

    const cabin = new THREE.Mesh(geoCabin, matCabin);
    cabin.name = 'PirateShip/stern-cabins';
    cabin.castShadow = true;
    boat.add(cabin);
    const roofs = new THREE.Mesh(geoRoofs, matCabinRoof);
    roofs.name = 'PirateShip/stern-roofs';
    roofs.castShadow = true;
    boat.add(roofs);
    const trim = new THREE.Mesh(geoTrim, matGold);
    trim.name = 'PirateShip/gold-trim';
    boat.add(trim);

    const mast = new THREE.Mesh(geoMast, matCabin);
    mast.name = 'PirateShip/mast';
    boat.add(mast);

    const sails = new THREE.Mesh(geoSails, matSail);
    sails.name = 'PirateShip/sails';
    boat.add(sails);

    const flag = new THREE.Mesh(geoFlag, matFlag);
    flag.name = 'PirateShip/flag';
    flag.position.set(0.66, 4.28, 0.06);
    flag.rotation.y = 0.16;
    boat.add(flag);

    const ropes = new THREE.LineSegments(geoRopes, matRope);
    ropes.name = 'PirateShip/rigging';
    boat.add(ropes);

    // ⑩ 舷窗 / 提灯 / 座椅：3 组 InstancedMesh（各 1 draw call）
    const dummy = new THREE.Object3D();
    const portX = [-2.7, -1.35, 0, 1.35, 2.7];
    const ringIM = new THREE.InstancedMesh(geoRing, matGold, 10);
    const glowIM = new THREE.InstancedMesh(geoGlow, matPorthole, 10);
    ringIM.name = 'PirateShip/porthole-rings';
    glowIM.name = 'PirateShip/porthole-glow';
    let k = 0;
    for (const side of [1, -1]) {
      for (const x of portX) {
        dummy.position.set(x, 0.02, side * 1.33);
        dummy.rotation.set(0, side > 0 ? 0 : Math.PI, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        ringIM.setMatrixAt(k, dummy.matrix);
        dummy.position.z = side * 1.345;
        dummy.updateMatrix();
        glowIM.setMatrixAt(k, dummy.matrix);
        k += 1;
      }
    }
    ringIM.instanceMatrix.needsUpdate = true;
    glowIM.instanceMatrix.needsUpdate = true;
    ringIM.frustumCulled = false; glowIM.frustumCulled = false;
    boat.add(ringIM, glowIM);

    const lanternIM = new THREE.InstancedMesh(geoLantern, matLantern, 6);
    lanternIM.name = 'PirateShip/lanterns';
    lanternIM.frustumCulled = false;
    k = 0;
    for (const side of [1, -1]) {
      for (const x of [-2.6, 0, 2.6]) {
        dummy.position.set(x, 0.82, side * 1.42);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        lanternIM.setMatrixAt(k, dummy.matrix);
        k += 1;
      }
    }
    lanternIM.instanceMatrix.needsUpdate = true;
    boat.add(lanternIM);

    const seatIM = new THREE.InstancedMesh(geoSeat, matAccent, 5);
    seatIM.name = 'PirateShip/seats';
    seatIM.frustumCulled = false;
    for (let i = 0; i < 5; i += 1) {
      dummy.position.set(-2.4 + i * 1.2, 0.55, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0.72, 0.38, 1.55);
      dummy.updateMatrix();
      seatIM.setMatrixAt(i, dummy.matrix);
    }
    seatIM.instanceMatrix.needsUpdate = true;
    boat.add(seatIM);

    // ⑪ 提灯暖光（2 盏 PointLight，不占 draw call）
    const l1 = new THREE.PointLight(0xffa85c, 0.57, 13, 2);
    l1.name = 'PirateShip/lantern-light-1';
    l1.position.set(-1.5, 1.4, 1.6);
    boat.add(l1);
    const l2 = new THREE.PointLight(0xffb870, 0.46, 12, 2);
    l2.name = 'PirateShip/lantern-light-2';
    l2.position.set(1.8, 1.4, -1.6);
    boat.add(l2);

    // ⑪-b 远景：礁石群 + 港口灯火（2 个 InstancedMesh，复用 geoLantern，零新增几何）
    // 固定在 root 下不随 pivot 摆动；让船上第一人称视角有地平线参照，减轻空旷感。
    const rocks = new THREE.InstancedMesh(geoLantern, matRock, 20);
    rocks.name = 'PirateShip/distant-rocks';
    rocks.frustumCulled = false;
    const farLights = new THREE.InstancedMesh(geoLantern, matPorthole, 24);
    farLights.name = 'PirateShip/distant-lights';
    farLights.frustumCulled = false;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 20; i += 1) {
      const a = (i / 20) * Math.PI * 2 + rnd() * 0.3;
      const r = 42 + rnd() * 46;
      const s = 22 + rnd() * 38;
      dummy.position.set(Math.cos(a) * r, -1.2 + rnd() * 1.6, Math.sin(a) * r);
      dummy.rotation.set(0, rnd() * Math.PI, 0);
      dummy.scale.set(s * 1.5, s * 0.7, s);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    }
    rocks.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2 + rnd() * 0.25;
      const r = 38 + rnd() * 44;
      // 灯火要「小而贴地」：放大后低多边形球在 92° 广角边缘会被拉成橄榄状，
      // 所以只给 3.5~6.5 倍缩放并压到礁石高度附近，读作远处港口的灯点。
      dummy.position.set(Math.cos(a) * r, 0.6 + rnd() * 2.2, Math.sin(a) * r);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(3.5 + rnd() * 3);
      dummy.updateMatrix();
      farLights.setMatrixAt(i, dummy.matrix);
    }
    farLights.instanceMatrix.needsUpdate = true;
    this.root.add(rocks, farLights);

    // ⑫ UI + 座位选择
    this._buildUI();
    this._setState(STATE.SELECT);

    // ⑬ 具名输入监听：拖拽环顾 / V 键第三人称 / ESC 平滑退出
    const canvas = ctx.renderer.domElement;
    this._addListener(canvas, 'pointerdown', (e) => this._onPointerDown(e));
    this._addListener(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._addListener(canvas, 'pointerup', (e) => this._onPointerUp(e));
    this._addListener(canvas, 'pointercancel', (e) => this._onPointerUp(e));
    this._addListener(window, 'keydown', (e) => this._onKeyDown(e));

    this._pivot.rotation.z = 0;
    this._pivot.updateMatrixWorld(true);
    camera.up.set(0, 1, 0);
    // 旁观机位：斜前方稍近，让船体 / 拱门 / 船帆在座位面板左侧完整露出
    // （原 (0,6.5,16.5) 太远，FOV 92 下船只占画面中央一小块，正好被面板盖住）
    camera.position.set(6.2, 6.6, 12.0);
    camera.lookAt(0, 5.0, 0);
    camera.updateMatrixWorld(true);

    console.info(
      `[PirateShip] init 完成 | 周期=${PERIOD}s ω=${OMEGA.toFixed(3)}rad/s ` +
      `最大摆角=${(MAX_AMP * 180 / Math.PI).toFixed(1)}° | 座位=${this._seats.length} | ` +
      `几何=${this._geometries.size} 材质=${this._materials.size} 纹理=${this._textures.size}`
    );
  }

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'ps-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'ps-ui';
    this._uiRoot.innerHTML = `
      <div class="ps-shade" data-role="shade"></div>
      <div class="ps-panel" data-role="panel">
        <div class="ps-title" data-role="title">🏴‍☠️ 海盗船</div>
        <p class="ps-desc" data-role="desc"></p>
        <p class="ps-tip" data-role="tip">如您容易感到眩晕，建议选择中间座位</p>
        <div class="ps-seats" data-role="seats">
          ${SEAT_DEFS.map((s, i) => `
            <button type="button" class="ps-seat" data-action="seat" data-seat="${i}">
              <b>${s.label}</b><span>${s.desc}</span>
            </button>`).join('')}
        </div>
        <div class="ps-buttons" data-role="buttons" data-hidden="true">
          <button type="button" class="ps-btn ps-btn--primary" data-action="again">再玩一次</button>
          <button type="button" class="ps-btn" data-action="exit">返回大厅</button>
        </div>
      </div>
      <div class="ps-hud" data-role="hud" data-hidden="true"></div>
    `;
    document.body.appendChild(this._uiRoot);

    const q = (role) => this._uiRoot.querySelector(`[data-role="${role}"]`);
    this._ui = {
      shade: q('shade'), panel: q('panel'), title: q('title'), desc: q('desc'),
      tip: q('tip'), seats: q('seats'), buttons: q('buttons'), hud: q('hud'),
    };

    // 单一事件委托；RIDING 期间不响应任何按钮（纯观赏）
    this._addListener(this._uiRoot, 'click', (event) => {
      if (this._disposed || this._state === STATE.RIDING) return;
      const button = event.target.closest?.('button[data-action]');
      if (!button || !this._uiRoot.contains(button)) return;
      const action = button.dataset.action;
      if (action === 'seat') this._selectSeat(Number(button.dataset.seat));
      if (action === 'again') this._setState(STATE.SELECT);
      if (action === 'exit') {
        const fn = this._ctx?.onExitAttraction;
        if (typeof fn === 'function') fn();
        else console.warn('[PirateShip] 缺少 ctx.onExitAttraction，无法返回大厅');
      }
    });
  }

  _setState(next) {
    this._state = next;
    if (this._disposed || !this._ui.panel) return;
    const ui = this._ui;
    const overlay = next !== STATE.RIDING;
    ui.panel.dataset.hidden = String(!overlay);
    ui.shade.dataset.hidden = String(!overlay);
    ui.hud.dataset.hidden = String(next !== STATE.RIDING);
    ui.seats.dataset.hidden = String(next !== STATE.SELECT);
    ui.tip.dataset.hidden = String(next !== STATE.SELECT);
    ui.buttons.dataset.hidden = String(next !== STATE.OVER);

    if (next === STATE.SELECT) {
      this._seatIndex = -1;
      this._elapsed = 0;
      this._currentAmplitude = 0;
      this._pivot.rotation.z = 0;
      this._pivot.updateMatrixWorld(true);
      ui.title.textContent = '🏴‍☠️ 海盗船 · 选择座位';
      ui.desc.textContent = '纯观赏体验：没有金币、没有计分，只有 30 秒的海上摆动。';
    } else if (next === STATE.READY) {
      ui.title.textContent = '准备出发';
      ui.desc.textContent = '船体静止，2 秒后开始缓慢起摆…';
    } else if (next === STATE.OVER) {
      ui.title.textContent = '体验结束';
      ui.desc.textContent = `您选择的是「${this._seats[this._seatIndex]?.label ?? '中间'}」。船已完全停稳。`;
    }
  }

  _selectSeat(index) {
    if (index < 0 || index >= this._seats.length) return;
    this._seatIndex = index;
    this._elapsed = 0;
    this._readyTimer = READY_SECONDS;
    this._currentAmplitude = 0;
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._thirdPerson = false;
    this._exitBlend = -1;
    this._pivot.rotation.z = 0;
    this._pivot.updateMatrixWorld(true);
    this._updateCamera(0.016);
    this._setState(STATE.READY);
    console.info(`[PirateShip] 座位锁定：${this._seats[index].label}`);
  }

  /* ------------------------- 输入：拖拽环顾 / V / ESC ------------------------- */

  _onPointerDown(event) {
    this._downPos = { x: event.clientX, y: event.clientY };
    if ((this._state === STATE.RIDING || this._state === STATE.READY) && !this._thirdPerson) {
      this._dragging = true;
      this._lastPointer = { x: event.clientX, y: event.clientY };
    }
  }

  _onPointerMove(event) {
    if (!this._dragging || this._thirdPerson || !this._lastPointer) return;
    const dx = event.clientX - this._lastPointer.x;
    const dy = event.clientY - this._lastPointer.y;
    this._lastPointer.x = event.clientX;
    this._lastPointer.y = event.clientY;
    // 环顾相对船体坐标系：yaw ±90° / pitch ±45°
    this._lookYaw = THREE.MathUtils.clamp(this._lookYaw - dx * 0.003, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
    this._lookPitch = THREE.MathUtils.clamp(this._lookPitch - dy * 0.0025, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT);
  }

  _onPointerUp() {
    this._dragging = false;
    this._lastPointer = null;
  }

  _onKeyDown(event) {
    if (event.repeat) return;
    if (event.code === 'KeyV' && (this._state === STATE.RIDING || this._state === STATE.READY)) {
      this._thirdPerson = !this._thirdPerson;
      this._dragging = false;
      console.info(`[PirateShip] 视角切换：${this._thirdPerson ? '第三人称侧后方' : '甲板第一人称'}`);
    } else if (event.code === 'Escape') {
      this._requestExit();
    }
  }

  _requestExit() {
    if (this._disposed || this._exitBlend >= 0) return;
    this._exitBlend = 0;
    this._dragging = false;
    this._blendPos.copy(this._ctx.camera.position);
    this._blendQuat.copy(this._ctx.camera.quaternion);
  }

  /* ---------------------------------------------------------------------- */
  /* update —— dt 由 SceneManager 驱动，已截断 0.1；这里再防御一次           */
  /* ---------------------------------------------------------------------- */

  update(deltaTime) {
    if (this._disposed) return;
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);

    // 提灯呼吸：与船体同时间基准的低频正弦，静止时回到基础亮度
    if (this._lanternMaterial) {
      const wave = 0.5 + 0.5 * Math.sin(this._elapsed * 1.6);
      this._lanternMaterial.emissiveIntensity = 0.59 + wave * 0.27; // ×0.38 抵消 exposure=1.0
    }

    // ESC 平滑退出：lerp 位置 + slerp 朝向回大厅存档机位，绝不直接赋值跳变
    if (this._exitBlend >= 0) {
      this._exitBlend = Math.min(1, this._exitBlend + dt / EXIT_BLEND_SECONDS);
      const s = THREE.MathUtils.smoothstep(this._exitBlend, 0, 1);
      const camera = this._ctx.camera;
      camera.position.lerpVectors(this._blendPos, this._cameraSaved.position, s);
      camera.quaternion.slerpQuaternions(this._blendQuat, this._cameraSaved.quaternion, s);
      camera.up.copy(this._worldUp);
      camera.updateMatrixWorld(true);
      if (this._exitBlend >= 1) this._ctx?.onExitAttraction?.();
      return;
    }

    if (this._state === STATE.SELECT || this._state === STATE.OVER) return;

    if (this._state === STATE.READY) {
      this._readyTimer -= dt;
      const left = Math.max(0, this._readyTimer);
      this._ui.hud.dataset.hidden = 'false';
      this._ui.hud.textContent = `准备出发 ${left.toFixed(1)} s`;
      this._updateCamera(dt); // 准备阶段相机已缓动落到座位
      if (this._readyTimer <= 0) {
        this._elapsed = 0;
        this._setState(STATE.RIDING);
      }
      return;
    }

    // ---- RIDING：单摆解析式 ----
    this._elapsed += dt;
    const t01 = Math.min(this._elapsed / RIDE_SECONDS, 1);
    const baseEnv = Math.sin(Math.PI * t01);
    const fadeIn = THREE.MathUtils.smoothstep(this._elapsed, 0, FADE_IN_SECONDS);
    const fadeOut = THREE.MathUtils.smoothstep(RIDE_SECONDS - this._elapsed, 0, FADE_OUT_SECONDS);
    const amp = MAX_AMP * baseEnv * fadeIn * fadeOut;
    this._currentAmplitude = amp;

    const phase = this._elapsed * OMEGA; // 由累计时间算，绝不增量累加角度
    this._pivot.rotation.z = Math.sin(phase) * amp;
    this._pivot.updateMatrixWorld(true);

    this._updateCamera(dt);

    const remaining = Math.max(0, RIDE_SECONDS - this._elapsed);
    const viewTag = this._thirdPerson ? '第三人称' : '拖拽环顾 · V 切换视角';
    this._ui.hud.textContent = `剩余 ${remaining.toFixed(1)} s · ${this._seats[this._seatIndex]?.label ?? ''} · ${viewTag} · ESC 退出`;

    if (this._elapsed >= RIDE_SECONDS) {
      this._currentAmplitude = 0;
      this._pivot.rotation.z = 0;
      this._pivot.updateMatrixWorld(true);
      this._updateCamera(dt);
      this._setState(STATE.OVER);
      console.info('[PirateShip] 缓出完成，船体与相机已完全静止，弹出结算');
    }
  }

  /**
   * 甲板第一人称：朝向 = 船体世界四元数 × 座位基准 × 自由环顾（含晃动），
   * 因此相机始终垂直于船体甲板、随船倾斜；位置用 lerp 惯性延迟跟随（手册
   * 0.1~0.3），摆动峰值处产生「坐在船上」的滞后感。V 键切第三人称侧后方。
   * 全程只 copy/lerp/slerp 复用对象，update 内零 new。
   */
  _updateCamera(dt) {
    const camera = this._ctx?.camera;
    const seat = this._seats[this._seatIndex];
    if (!camera || !seat) return;

    this._pivot.getWorldQuaternion(this._shipQuat);
    const norm = this._currentAmplitude / MAX_AMP;
    const h = OMEGA * SHAKE_HARMONIC;
    const shakePitch = Math.sin(this._elapsed * h) * seat.shakeRot * norm;
    const shakeYaw = Math.sin(this._elapsed * h * 1.3 + 0.6) * seat.shakeRot * norm;
    const dx = Math.sin(this._elapsed * h * 0.8) * seat.shakePos * norm;
    const dy = Math.sin(this._elapsed * h * 1.1 + 1.2) * seat.shakePos * norm;

    if (this._thirdPerson) {
      this._targetPos.set(...THIRD_POS);
      this._tmpMat.lookAt(this._targetPos, this._tmpLook.set(...THIRD_LOOK), this._worldUp);
      this._targetQuat.setFromRotationMatrix(this._tmpMat);
    } else {
      // 座位世界位置（船体系偏移 + 晃动）→ 惯性延迟的目标点
      this._targetPos.copy(seat.pos);
      this._targetPos.x += dx;
      this._targetPos.y += dy;
      this._targetPos.applyMatrix4(this._pivot.matrixWorld);
      // 环顾叠加在船体旋转之上：camera.quaternion = shipQuat * baseQuat * lookQuat
      this._lookEuler.set(this._lookPitch + shakePitch, this._lookYaw + shakeYaw, 0);
      this._lookQuat.setFromEuler(this._lookEuler);
      this._targetQuat.copy(this._shipQuat).multiply(seat.baseQuat).multiply(this._lookQuat);
    }

    const step = Math.min(Math.max(dt, 0), 0.1) * 60;
    const kPos = 1 - Math.pow(1 - FOLLOW_FACTOR, step);
    const kOri = 1 - Math.pow(1 - ORI_FACTOR, step);
    camera.position.lerp(this._targetPos, kPos);
    camera.quaternion.slerp(this._targetQuat, kOri);
    camera.up.copy(this._worldUp);
    camera.updateMatrixWorld(true);
  }

  onInteract(_hitInfo) {
    // 纯观赏：游玩期间无任何交互，也无 Raycaster / 对象池 / 点击判定
  }

  /** 预热：走一遍选座 → 摆动 → 环顾/第三人称 → 结算路径，让 shader/贴图在基线采集前上传 */
  warmUp() {
    this._selectSeat(1);
    this._state = STATE.RIDING;
    this._elapsed = RIDE_SECONDS * 0.5;
    this._currentAmplitude = MAX_AMP * 0.8;
    this._pivot.rotation.z = Math.sin(this._elapsed * OMEGA) * this._currentAmplitude;
    this._pivot.updateMatrixWorld(true);
    this._lookYaw = 0.4; this._lookPitch = 0.2; // 走一遍船体系环顾数学
    this._updateCamera(0.016);
    this._thirdPerson = true; // 走一遍第三人称 lookAt 路径
    this._updateCamera(0.016);
    this._thirdPerson = false;
    this._lookYaw = 0; this._lookPitch = 0;
    this._currentAmplitude = 0;
    this._pivot.rotation.z = 0;
    this._pivot.updateMatrixWorld(true);
    this._exitBlend = -1;
    this._setState(STATE.SELECT);
    // 预热帧必须用旁观相机：若停在船内，支撑塔会被视锥剔除而漏上传，
    // 首次正式进入时才惰性上传 → 造成「中途假泄漏」。
    const camera = this._ctx?.camera;
    if (camera) {
      camera.up.set(0, 1, 0);
      camera.position.set(6.2, 6.6, 12.0);
      camera.lookAt(0, 5.0, 0);
      camera.updateMatrixWorld(true);
    }
    return this;
  }

  /* ---------------------------------------------------------------------- */
  /* dispose —— 七步清理 + 幂等锁                                            */
  /* ---------------------------------------------------------------------- */

  _step(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[PirateShip] dispose 步骤「${label}」失败（继续后续清理）：`, err); }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._step('计时器与帧循环', () => {
      console.info('[PirateShip] 无自建 rAF / 计时器，由 _disposed 锁停止 update');
    });

    this._step('相机恢复', () => {
      const camera = this._ctx?.camera;
      if (camera && this._cameraSaved) {
        camera.rotation.order = this._cameraSaved.rotationOrder;
        camera.quaternion.copy(this._cameraSaved.quaternion);
        camera.up.copy(this._cameraSaved.up);
        camera.position.copy(this._cameraSaved.position);
        camera.fov = this._cameraSaved.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      }
      this._cameraSaved = null;
    });

    this._step('事件与 UI', () => {
      for (const { target, type, fn } of this._listeners) {
        try { target.removeEventListener(type, fn); } catch { /* 已解绑 */ }
      }
      this._listeners = [];
      this._uiRoot?.remove();
      this._uiStyle?.remove();
      this._uiRoot = null;
      this._uiStyle = null;
      this._ui = {};
    });

    this._step('物理与游戏化资源', () => {
      console.info('[PirateShip] 无 Rapier / 对象池 / Raycaster / localStorage，刚体 0 / collider 0');
    });

    this._step('GPU 资源', () => this._disposeThreeResources());

    this._step('座位缓存 / 晃动参数 / 台账清空', () => {
      this.root.clear();
      this._seats.length = 0;
      this._seatIndex = -1;
      this._currentAmplitude = 0;
      this._elapsed = 0;
      this._readyTimer = 0;
      this._tmpPos = null;
      this._tmpLook = null;
      this._pivot = null;
      this._lanternMaterial = null;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
    });

    this._step('句柄释放', () => {
      this._state = STATE.OVER;
      this._shipQuat = null;
      this._lookQuat = null;
      this._lookEuler = null;
      this._targetPos = null;
      this._targetQuat = null;
      this._blendPos = null;
      this._blendQuat = null;
      this._tmpMat = null;
      this._worldUp = null;
      this._downPos = null;
      this._lastPointer = null;
      this._ctx = null;
    });
    console.info('[PirateShip] dispose 完成 | 资源已释放，相机已归还');
  }

  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);
    this.root.traverse((obj) => {
      // InstancedMesh 额外持有 instanceMatrix / instanceColor 缓冲，必须显式 dispose
      if (obj.isInstancedMesh && typeof obj.dispose === 'function') {
        try { obj.dispose(); } catch (err) { console.error('[PirateShip] InstancedMesh dispose 失败：', err); }
      }
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      if (obj.geometry) geometries.add(obj.geometry);
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x && materials.add(x));
      else if (m) materials.add(m);
    });

    const refs = [];
    let index = 0;
    for (const material of materials) {
      refs.push(...collectMaterialTextureReferences(material, index));
      index += 1;
    }
    const texturePlan = new Map();
    for (const tex of this._textures) {
      if (!texturePlan.has(tex)) texturePlan.set(tex, { sources: [], disposeCalled: false });
      texturePlan.get(tex).sources.push('台账');
    }
    for (const ref of refs) {
      if (!texturePlan.has(ref.texture)) texturePlan.set(ref.texture, { sources: [], disposeCalled: false });
      const meta = texturePlan.get(ref.texture);
      if (!meta.sources.includes(ref.path)) meta.sources.push(ref.path);
    }
    for (const [texture, meta] of texturePlan) {
      try { texture.dispose(); meta.disposeCalled = true; }
      catch (err) { console.error(`[PirateShip:纹理] uuid=${texture.uuid} dispose 失败：`, err); }
    }
    const cleared = [];
    for (const ref of refs) {
      try { ref.clear(); cleared.push(ref.path); }
      catch (err) { console.error(`[PirateShip:纹理] 断开引用 ${ref.path} 失败：`, err); }
    }
    const clearedSet = new Set(cleared);
    console.table([...texturePlan].map(([texture, meta]) => ({
      uuid: texture.uuid,
      name: texture.name || '-',
      '来源': meta.sources.join(' | '),
      'dispose() 已调用': meta.disposeCalled ? '是' : '否',
      '引用已断开': refs.filter((r) => r.texture === texture).every((r) => clearedSet.has(r.path)) ? '是' : '否',
    })));
    for (const material of materials) {
      try { material.dispose(); } catch (err) { console.error('[PirateShip] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[PirateShip] 几何体 dispose 失败：', err); }
    }
    console.info(`[PirateShip] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} texture=${texturePlan.size} 引用路径=${cleared.length}`);
  }
}

export default PirateShip;
