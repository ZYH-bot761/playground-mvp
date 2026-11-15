/**
 * ============================================================================
 * Carousel.js —— 旋转木马（M10 · 梦幻童话风视觉升级）
 * ============================================================================
 * 【视觉】马戏团帐篷式多层顶棚（马卡龙条纹 + 波浪裙边）、48 盏呼吸灯泡、
 *        马赛克镜面中心柱、CapsuleGeometry 胶囊木马 + 高金属度金色马鞍。
 *        全部贴图由 Canvas API 程序化生成，零外部资源。
 *
 * 【性能】8 匹马的同类部件用 mergeGeometries 合并 + InstancedMesh 实例化：
 *        马身 / 马鞍 / 支杆 / 顶球各 1 个 draw call；灯泡 3 组 IM（相位差
 *        呼吸）、裙边波浪球 1 个 IM。总 Mesh 数远低于改造前的 68。
 *
 * 【契约对齐】
 *   · 相机：选择阶段 = OrbitControls（拖动旋转/滚轮缩放）；骑乘阶段 = 自定义
 *     第一人称（禁用 OrbitControls，二者互斥）；退出 = lerp/slerp 平滑过渡。
 *   · 无自建 rAF / Clock：SceneManager 用 THREE.Timer 统一驱动 update(dt)，
 *     本类再次把 dt 截断到 0.1s，所有运动基于 `elapsed += dt`。
 *   · 点击由基座 InteractionManager 分发 onInteract(hitInfo)；InstancedMesh
 *     的命中需从 hitInfo.intersections 取 instanceId。
 *   · 卸载顺序由 AttractionManager 保证：dispose → registry.disposeAll →
 *     scene.remove(root)；本类不自行 scene.remove。
 *   · 泄漏口径：回落「本次会话基线」（大厅激活态 17/24）。
 * ============================================================================
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IAttraction } from './i-attraction.js';

/* ------------------------------- 参数 ------------------------------------ */

const HORSE_COUNT = 8;
const BULB_COUNT = 48;
const BULB_GROUPS = 3;
const SKIRT_COUNT = 32;
const ROTATE_SPEED = 0.55;      // rad/s
const BOB_FREQ = 2.2;           // rad/s
const BOB_AMP = 0.42;
const BOOST_DURATION = 1.5;
const BOOST_RECOVER = 0.8;
const HORSE_COOLDOWN = 3.0;

/* ---- 视角（第三部分）：选择 = OrbitControls；骑乘 = 座位绑定第一人称 ---- */
const SELECT_CAM_POS = Object.freeze([13, 8.5, 13]); // 选择界面初始机位
const SELECT_TARGET = Object.freeze([0, 2.6, 0]);    // 环绕中心（转盘上方）
const SELECT_MIN_DIST = 7;                          // 不小于顶棚半径 6.3，防穿模
const SELECT_MAX_DIST = 30;
const RIDE_EYE = Object.freeze([0, 1.45, -0.35]);    // 马体系眼位：高过马耳、避开穿身支杆，视线越过马头
const LOOK_PITCH_LIMIT = Math.PI / 6;               // 俯仰 ±30°（拖拽/滚轮共用）
const RIDE_BLEND_SECONDS = 0.9;                     // 上马过渡时长
const EXIT_BLEND_SECONDS = 0.8;                     // 退出回大厅过渡时长
const HOVER_SCALE = 1.14;                           // 悬停放大系数
const DRAG_THRESHOLD_PX = 6;                        // 位移超过视为拖拽，不当点击

/** 马卡龙色系：淡粉 / 薄荷绿 / 奶油白 / 淡紫 / 天蓝 */
const MACARON = Object.freeze([
  0xffc9dd, 0xbdeede, 0xfff0cc, 0xd8c6f2, 0xbcdcf7, 0xffd9b8, 0xc9f0c4, 0xf7c9e8,
]);

/* --------------------------- 程序化纹理 ---------------------------------- */

/** 顶棚马卡龙条纹 + 金色滚边（CanvasTexture 必须设 SRGBColorSpace） */
function makeCanopyTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const colors = ['#f7a8c8', '#8fdfc0', '#f5dfa8', '#b9a0e0', '#96c8ee', '#f5b98c'];
  for (let i = 0; i < 24; i += 1) {
    g.fillStyle = colors[i % colors.length];
    g.fillRect((i * c.width) / 24, 0, c.width / 24 + 1, c.height);
    // 条纹内的柔和竖向明暗，模拟布幔褶皱
    const grad = g.createLinearGradient((i * c.width) / 24, 0, ((i + 1) * c.width) / 24, 0);
    grad.addColorStop(0, 'rgba(120,80,120,0.16)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(120,80,120,0.12)');
    g.fillStyle = grad;
    g.fillRect((i * c.width) / 24, 0, c.width / 24 + 1, c.height);
  }
  // 上下金色滚边 + 细密圆点花边
  g.fillStyle = 'rgba(240,196,104,0.92)';
  g.fillRect(0, 0, c.width, 12);
  g.fillRect(0, c.height - 16, c.width, 16);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  for (let x = 6; x < c.width; x += 18) {
    g.beginPath(); g.arc(x, 6, 2.6, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x, c.height - 8, 3, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'carousel/canopy-macaron';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 中心柱「彩色马赛克 / 镜面」：菱形拼片 + 高光，营造华丽感 */
function makeMosaicTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#6c4a8f'; g.fillRect(0, 0, 256, 256);
  const palette = ['#ffd9ea', '#b9f0dc', '#ffe9ad', '#c9dcff', '#e7c8ff', '#fff6e2', '#ffc4bd'];
  const step = 32;
  for (let row = -1; row < 9; row += 1) {
    for (let col = -1; col < 9; col += 1) {
      const x = col * step + (row % 2 ? step / 2 : 0);
      const y = row * step;
      const idx = Math.abs((row * 7 + col * 3 + 11)) % palette.length;
      g.fillStyle = palette[idx];
      g.beginPath();
      g.moveTo(x + step / 2, y);
      g.lineTo(x + step, y + step / 2);
      g.lineTo(x + step / 2, y + step);
      g.lineTo(x, y + step / 2);
      g.closePath(); g.fill();
      // 拼片左上高光 → 镜面质感
      g.fillStyle = 'rgba(255,255,255,0.34)';
      g.beginPath();
      g.moveTo(x + step / 2, y); g.lineTo(x + step, y + step / 2);
      g.lineTo(x + step / 2, y + step / 2);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,225,160,0.55)'; g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(x + step / 2, y); g.lineTo(x + step, y + step / 2);
      g.lineTo(x + step / 2, y + step); g.lineTo(x, y + step / 2);
      g.closePath(); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'carousel/mosaic-mirror';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.needsUpdate = true;
  return tex;
}

/** 底盘装饰环纹（奶油底 + 金色同心圆 + 星星） */
function makeDeckTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, '#fff3d6'); grad.addColorStop(1, '#e7c9a8');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(212,160,70,0.8)'; g.lineWidth = 5;
  for (const r of [44, 80, 116]) {
    g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke();
  }
  g.fillStyle = '#f4c95d';
  for (let i = 0; i < 20; i += 1) {
    const a = (i / 20) * Math.PI * 2;
    const x = 128 + Math.cos(a) * 98, y = 128 + Math.sin(a) * 98;
    g.beginPath();
    for (let k = 0; k < 8; k += 1) {
      const rr = k % 2 ? 3 : 7;
      const aa = (k / 8) * Math.PI * 2 + a;
      g.lineTo(x + Math.cos(aa) * rr, y + Math.sin(aa) * rr);
    }
    g.closePath(); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'carousel/deck-ornament';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------- 静态几何合并（只在 init 调用） ---------------------- */

/**
 * 把若干「共享基础几何 + 变换」合并成一个 BufferGeometry。
 * mergeGeometries 要求所有输入的属性/索引一致，这里统一用 three 内置
 * 索引几何（Capsule/Cylinder/Cone/Sphere/Box/Torus 均满足）。
 * 输入是 clone，合并后立即 dispose，绝不留在台账外。
 */
function mergeParts(parts) {
  const clones = parts.map(({ geo, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] }) => {
    const g = geo.clone();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot));
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos), q, new THREE.Vector3(...scale)
    );
    g.applyMatrix4(m);
    return g;
  });
  const merged = mergeGeometries(clones, false);
  clones.forEach((g) => g.dispose());
  if (!merged) throw new Error('[Carousel] mergeGeometries 失败：输入几何属性不一致');
  merged.computeBoundingSphere();
  return merged;
}

/** 一匹「胶囊木马」的全部木色部件（身体 / 颈 / 头 / 耳 / 四肢 / 鬃 / 尾） */
function buildHorseGeometry(shared) {
  const p = [];
  const { capsule, cylinder, cone, sphere } = shared;
  // 身体：Capsule 默认沿 Y，绕 X 转 90° 变成沿 Z（马的前后方向）
  p.push({ geo: capsule, pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0], scale: [0.40, 0.52, 0.40] });
  // 脖子 + 头（斜向前上方 -Z）
  p.push({ geo: capsule, pos: [0, 0.48, -0.62], rot: [0.62, 0, 0], scale: [0.19, 0.32, 0.19] });
  p.push({ geo: capsule, pos: [0, 0.82, -0.92], rot: [1.32, 0, 0], scale: [0.17, 0.24, 0.17] });
  // 耳朵
  for (const sx of [-0.11, 0.11]) {
    p.push({ geo: cone, pos: [sx, 1.06, -0.86], rot: [-0.2, 0, 0], scale: [0.07, 0.20, 0.07] });
  }
  // 四条腿（圆柱，略微外撇）
  for (const sx of [-0.28, 0.28]) {
    for (const sz of [-0.42, 0.42]) {
      p.push({
        geo: cylinder, pos: [sx, -0.62, sz],
        rot: [sz > 0 ? 0.12 : -0.12, 0, sx > 0 ? -0.08 : 0.08],
        scale: [0.078, 0.82, 0.078],
      });
    }
  }
  // 圆柱形马鬃：沿脖子一列错落小圆柱
  for (let i = 0; i < 6; i += 1) {
    p.push({
      geo: cylinder,
      pos: [0, 0.48 + i * 0.12, -0.48 - i * 0.075],
      rot: [0.62, 0, 0], scale: [0.075, 0.20, 0.075],
    });
  }
  // 尾巴：几节渐细圆柱
  for (let i = 0; i < 4; i += 1) {
    p.push({
      geo: cylinder, pos: [0, 0.18 - i * 0.15, 0.62 + i * 0.10],
      rot: [0.55, 0, 0], scale: [0.10 - i * 0.016, 0.28, 0.10 - i * 0.016],
    });
  }
  // 眼睛（两个小球，后续统一用马身材质，靠 instanceColor 上色）
  for (const sx of [-0.135, 0.135]) {
    p.push({ geo: sphere, pos: [sx, 0.87, -1.02], scale: [0.035, 0.035, 0.035] });
  }
  return mergeParts(p);
}

/** 金色马鞍 + 笼头 + 马镫（高 metalness + clearcoat 的单独材质） */
function buildSaddleGeometry(shared) {
  const p = [];
  const { box, torus, cylinder } = shared;
  p.push({ geo: box, pos: [0, 0.36, 0.02], scale: [0.62, 0.16, 0.72] });
  p.push({ geo: box, pos: [0, 0.46, -0.28], rot: [0.2, 0, 0], scale: [0.60, 0.20, 0.12] });
  // 笼头横带
  p.push({ geo: torus, pos: [0, 0.80, -0.99], rot: [1.32, 0, 0], scale: [0.20, 0.20, 0.20] });
  // 两侧马镫
  for (const sx of [-0.34, 0.34]) {
    p.push({ geo: torus, pos: [sx, -0.18, 0.02], rot: [0, Math.PI / 2, 0], scale: [0.13, 0.13, 0.13] });
    p.push({ geo: cylinder, pos: [sx, 0.10, 0.02], scale: [0.018, 0.54, 0.018] });
  }
  return mergeParts(p);
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
.cr-ui{position:fixed;inset:0;z-index:22;pointer-events:none;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#f3f7ff}
.cr-title{position:absolute;top:16px;left:50%;transform:translateX(-50%);
  pointer-events:auto;padding:8px 20px;border-radius:999px;white-space:nowrap;font-size:15px;font-weight:700;
  background:rgba(48,26,58,.72);border:1px solid rgba(255,206,232,.55);letter-spacing:1px;
  color:#ffe9f5;text-shadow:0 1px 8px rgba(255,150,200,.6)}
.cr-exit{position:absolute;top:18px;right:calc(18px + env(safe-area-inset-right,0px));
  pointer-events:auto;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600;
  color:#fff3d6;background:rgba(24,32,56,.86);border:1px solid rgba(255,210,120,.6);cursor:pointer}
.cr-exit:hover{background:rgba(90,70,40,.92)}
.cr-hint{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
  pointer-events:auto;padding:7px 16px;border-radius:999px;font-size:12px;white-space:nowrap;
  background:rgba(14,22,42,.6);color:#f6e3c8}
@media (max-width:520px){.cr-title{font-size:12px}.cr-hint{font-size:10px}}
`;

/* ========================================================================== */

export class Carousel extends IAttraction {
  constructor() {
    super();
    this.root = new THREE.Group();
    this.root.name = 'Carousel';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;
    this._cameraSaved = null;

    // 运动台账（全部基于 dt 累加）
    this._elapsed = 0;
    this._boostTimer = 0;
    this._boostRecover = 0;
    this._cooldownAt = new Float64Array(HORSE_COUNT).fill(-Infinity);
    this._carousel = null;

    // 视角状态机：select（OrbitControls 选马）→ riding（座位第一人称）→ exiting（平滑回大厅）
    this._state = 'select';
    this._rideIndex = -1;
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._hovered = -1;
    this._horseScale = new Float64Array(HORSE_COUNT).fill(1);
    this._controls = null;
    this._dragging = false;
    this._downPos = null;
    this._lastPointer = null;
    this._rideBlend = 1;
    this._exitBlend = 0;

    // 4 个动态 InstancedMesh：马身 / 马鞍 / 支杆 / 顶球
    this._horseIM = null;
    this._saddleIM = null;
    this._rodIM = null;
    this._knobIM = null;
    // 3 组灯泡材质（相位差呼吸）
    this._bulbMaterials = [];
    // 每帧复用的临时对象（update 内零分配）
    this._dummy = null;
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._horseBase = [];
    // 骑乘位姿 / 过渡混合复用对象
    this._blendPos = new THREE.Vector3();
    this._blendQuat = new THREE.Quaternion();
    this._seatPos = new THREE.Vector3();
    this._seatQuat = new THREE.Quaternion();
    this._horseQuat = new THREE.Quaternion();
    this._lookQuat = new THREE.Quaternion();
    this._lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._eyeOffset = new THREE.Vector3(...RIDE_EYE);
    // 悬停拾取复用对象
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    // 资源台账
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

  _addListener(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this._listeners.push({ target, type, fn, options });
  }

  /* ---------------------------------------------------------------------- */
  /* init                                                                   */
  /* ---------------------------------------------------------------------- */

  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera } = ctx;
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    // ① 接管相机：保存全部运行时字段
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      up: camera.up.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };

    // ② 根节点挂载（M3 教训：不挂就永远不渲染，形成「假通过」）
    scene.add(this.root);

    // ③ 基础共享几何（仅用于 merge 的模板，合并后 clone 会 dispose；
    //    模板本身仍登记进台账，确保 dispose 万无一失）
    const shared = {
      capsule: this._trackGeometry(new THREE.CapsuleGeometry(1, 1, 4, 10)),
      cylinder: this._trackGeometry(new THREE.CylinderGeometry(1, 1, 1, 10)),
      cone: this._trackGeometry(new THREE.ConeGeometry(1, 1, 10)),
      sphere: this._trackGeometry(new THREE.SphereGeometry(1, 10, 8)),
      box: this._trackGeometry(new THREE.BoxGeometry(1, 1, 1)),
      torus: this._trackGeometry(new THREE.TorusGeometry(1, 0.16, 8, 16)),
    };

    // 合并后的精细几何
    const geoHorse = this._trackGeometry(buildHorseGeometry(shared));
    const geoSaddle = this._trackGeometry(buildSaddleGeometry(shared));
    const geoRod = this._trackGeometry(new THREE.CylinderGeometry(0.055, 0.055, 4.0, 10));
    const geoKnob = this._trackGeometry(new THREE.SphereGeometry(0.15, 12, 8));
    const geoBulb = this._trackGeometry(new THREE.SphereGeometry(0.14, 12, 10));
    const geoSkirt = this._trackGeometry(new THREE.SphereGeometry(0.17, 10, 8));

    // 场景静态几何
    const geoPole = this._trackGeometry(new THREE.CylinderGeometry(0.48, 0.48, 4.6, 24));
    const geoRing = this._trackGeometry(new THREE.TorusGeometry(0.55, 0.09, 10, 24));
    const geoCanopyLow = this._trackGeometry(new THREE.CylinderGeometry(6.05, 6.3, 0.42, 40, 1, true));
    const geoCanopyMid = this._trackGeometry(new THREE.ConeGeometry(6.3, 1.75, 40, 1, true));
    const geoCanopyTop = this._trackGeometry(new THREE.ConeGeometry(3.5, 1.55, 28, 1, false));
    const geoEave = this._trackGeometry(new THREE.TorusGeometry(6.22, 0.17, 10, 64));
    const geoFinial = this._trackGeometry(new THREE.SphereGeometry(0.34, 14, 10));
    const geoDeck = this._trackGeometry(new THREE.CylinderGeometry(5.6, 5.6, 0.45, 48));
    const geoGround = this._trackGeometry(new THREE.CircleGeometry(15, 48));

    // ④ 程序化纹理（全部 SRGBColorSpace）
    const texCanopy = this._trackTexture(makeCanopyTexture());
    const texMosaic = this._trackTexture(makeMosaicTexture());
    const texDeck = this._trackTexture(makeDeckTexture());

    // ⑤ 材质：全面启用 MeshPhysicalMaterial
    const matCanopy = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texCanopy, roughness: 0.48, metalness: 0.08,
      clearcoat: 0.35, clearcoatRoughness: 0.4, side: THREE.DoubleSide,
      sheen: 0.5, sheenColor: new THREE.Color(0xffe9f5),
    }));
    const matCanopyLow = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xfff3dc, roughness: 0.42, metalness: 0.12,
      clearcoat: 0.5, side: THREE.DoubleSide,
    }));
    const matCanopyTop = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffc9dd, roughness: 0.38, metalness: 0.18, clearcoat: 0.6,
    }));
    const matGold = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xf6c866, roughness: 0.22, metalness: 1.0,
      clearcoat: 0.85, clearcoatRoughness: 0.15,
    }));
    const matPole = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texMosaic, color: 0xffffff, roughness: 0.16, metalness: 0.72,
      clearcoat: 1.0, clearcoatRoughness: 0.08,
    }));
    const matDeckTop = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      map: texDeck, roughness: 0.3, metalness: 0.35,
      clearcoat: 0.7, clearcoatRoughness: 0.2,
    }));
    const matRod = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xf7e6bc, roughness: 0.18, metalness: 0.95, clearcoat: 0.8,
    }));
    // 马身：白色基底 + instanceColor 逐匹上马卡龙色
    const matHorse = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.42, metalness: 0.06,
      clearcoat: 0.55, clearcoatRoughness: 0.28,
    }));
    const matSkirt = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.35, metalness: 0.1, clearcoat: 0.6,
    }));
    const matGround = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xead9c6, roughness: 0.92, metalness: 0,
    }));
    // 3 组灯泡材质：emissiveIntensity 由 update 按相位差正弦呼吸
    const matBulbs = [];
    for (let i = 0; i < BULB_GROUPS; i += 1) {
      matBulbs.push(this._trackMaterial(new THREE.MeshPhysicalMaterial({
        color: 0xfff0c0, emissive: 0xffc85a, emissiveIntensity: 0.84,
        roughness: 0.2, metalness: 0, clearcoat: 1.0,
      })));
    }
    this._bulbMaterials = matBulbs;

    for (const g of this._geometries) register(g);
    for (const m of this._materials) register(m);
    for (const t of this._textures) register(t);

    // ⑥ 地面（给旁观相机一个柔和的落点参照）
    const ground = new THREE.Mesh(geoGround, matGround);
    ground.name = 'Carousel/ground';
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.root.add(ground);

    // ⑦ 华丽中心柱：马赛克贴图 + 上下金环
    const pole = new THREE.Mesh(geoPole, matPole);
    pole.name = 'Carousel/center-pole';
    pole.position.y = 2.3;
    pole.castShadow = true;
    this.root.add(pole);
    for (const y of [0.16, 2.3, 4.44]) {
      const ring = new THREE.Mesh(geoRing, matGold);
      ring.name = 'Carousel/pole-ring';
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.root.add(ring);
    }

    // ⑧ 马戏团帐篷式多层顶棚
    const canopyLow = new THREE.Mesh(geoCanopyLow, matCanopyLow);
    canopyLow.name = 'Carousel/canopy-skirt';
    canopyLow.position.y = 4.62;
    this.root.add(canopyLow);

    const canopyMid = new THREE.Mesh(geoCanopyMid, matCanopy);
    canopyMid.name = 'Carousel/canopy-striped';
    canopyMid.position.y = 5.7;
    canopyMid.castShadow = true;
    this.root.add(canopyMid);

    const canopyTop = new THREE.Mesh(geoCanopyTop, matCanopyTop);
    canopyTop.name = 'Carousel/canopy-crown';
    canopyTop.position.y = 7.15;
    this.root.add(canopyTop);

    const eave = new THREE.Mesh(geoEave, matGold);
    eave.name = 'Carousel/eave';
    eave.rotation.x = Math.PI / 2;
    eave.position.y = 4.46;
    this.root.add(eave);

    const finial = new THREE.Mesh(geoFinial, matGold);
    finial.name = 'Carousel/finial';
    finial.position.y = 8.05;
    this.root.add(finial);

    // ⑨ 波浪裙边：一圈小球按 sin 起伏，马卡龙 instanceColor
    const skirt = new THREE.InstancedMesh(geoSkirt, matSkirt, SKIRT_COUNT);
    skirt.name = 'Carousel/scalloped-skirt';
    skirt.frustumCulled = false; // 动态实例矩阵，禁用视锥剔除避免误剔
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    for (let i = 0; i < SKIRT_COUNT; i += 1) {
      const a = (i / SKIRT_COUNT) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 6.25, 4.40 + Math.sin(a * 8) * 0.14, Math.sin(a) * 6.25);
      dummy.scale.setScalar(1 + Math.sin(a * 8) * 0.16);
      dummy.updateMatrix();
      skirt.setMatrixAt(i, dummy.matrix);
      skirt.setColorAt(i, col.setHex(MACARON[i % MACARON.length]));
    }
    skirt.instanceMatrix.needsUpdate = true;
    if (skirt.instanceColor) skirt.instanceColor.needsUpdate = true;
    this.root.add(skirt);

    // ⑩ 暖黄灯泡：48 盏分 3 组相位差呼吸，两圈布置
    const bulbCounts = new Array(BULB_GROUPS).fill(0);
    for (let i = 0; i < BULB_COUNT; i += 1) bulbCounts[i % BULB_GROUPS] += 1;
    const bulbIMs = matBulbs.map((mat, gi) => {
      const im = new THREE.InstancedMesh(geoBulb, mat, bulbCounts[gi]);
      im.name = `Carousel/bulbs-${gi}`;
      im.frustumCulled = false;
      return im;
    });
    // 48 盏统一挂在檐口外下缘：eave 在 (r=6.22, y=4.46)、裙边球在 (r=6.25, y=4.40)，
    // 灯泡放在更外、更低的 (r=6.36, y=4.12) 才不会被几何遮挡（第一版放内侧几乎全被挡住）。
    const cursor = new Array(BULB_GROUPS).fill(0);
    for (let i = 0; i < BULB_COUNT; i += 1) {
      const gi = i % BULB_GROUPS;
      const a = (i / BULB_COUNT) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 6.36, 4.12 + Math.sin(a * 12) * 0.045, Math.sin(a) * 6.36);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      bulbIMs[gi].setMatrixAt(cursor[gi], dummy.matrix);
      cursor[gi] += 1;
    }
    bulbIMs.forEach((im) => { im.instanceMatrix.needsUpdate = true; this.root.add(im); });

    // ⑪ 顶棚下暖光
    const lamp = new THREE.PointLight(0xffdda0, 0.76, 26, 2);
    lamp.name = 'Carousel/lamp';
    lamp.position.set(0, 4.0, 0);
    this.root.add(lamp);
    const lamp2 = new THREE.PointLight(0xffc6e0, 0.34, 18, 2);
    lamp2.name = 'Carousel/lamp-fill';
    lamp2.position.set(0, 6.4, 3.2);
    this.root.add(lamp2);

    // ⑫ 转盘 + 8 匹胶囊木马（4 个 InstancedMesh，共 4 draw call）
    const deck = new THREE.Group();
    deck.name = 'Carousel/spin-deck';
    this.root.add(deck);
    this._carousel = deck;

    const deckMesh = new THREE.Mesh(geoDeck, matDeckTop);
    deckMesh.name = 'Carousel/deck';
    deckMesh.position.y = 0.9;
    deckMesh.receiveShadow = true;
    deck.add(deckMesh);

    this._horseIM = new THREE.InstancedMesh(geoHorse, matHorse, HORSE_COUNT);
    this._saddleIM = new THREE.InstancedMesh(geoSaddle, matGold, HORSE_COUNT);
    this._rodIM = new THREE.InstancedMesh(geoRod, matRod, HORSE_COUNT);
    this._knobIM = new THREE.InstancedMesh(geoKnob, matGold, HORSE_COUNT);
    this._horseIM.name = 'Carousel/horses';
    this._horseIM.userData.carouselHorseRole = 'horse';
    this._saddleIM.name = 'Carousel/saddles';
    this._saddleIM.userData.carouselHorseRole = 'horse';
    for (const im of [this._horseIM, this._saddleIM, this._rodIM, this._knobIM]) {
      im.frustumCulled = false; // 每帧更新 instanceMatrix，禁用剔除
      im.castShadow = true;
      deck.add(im);
    }
    for (let i = 0; i < HORSE_COUNT; i += 1) {
      const a = (i / HORSE_COUNT) * Math.PI * 2;
      this._horseIM.setColorAt(i, col.setHex(MACARON[i % MACARON.length]));
      this._horseBase.push({ angle: a, baseY: 1.72, phase: a });
    }
    if (this._horseIM.instanceColor) this._horseIM.instanceColor.needsUpdate = true;
    this._dummy = dummy;
    this._syncHorseMatrices(0);

    // ⑬ UI + 选择阶段 OrbitControls（骑乘时禁用，二者互斥）
    this._buildUI();
    const canvas = ctx.renderer.domElement;
    camera.position.set(...SELECT_CAM_POS);
    camera.up.set(0, 1, 0);
    this._controls = new OrbitControls(camera, canvas);
    this._controls.target.set(...SELECT_TARGET);
    this._controls.minDistance = SELECT_MIN_DIST; // 防穿模：不小于顶棚半径
    this._controls.maxDistance = SELECT_MAX_DIST;
    this._controls.minPolarAngle = 0.15;
    this._controls.maxPolarAngle = Math.PI / 2.1; // 不允许钻到地面以下
    this._controls.enablePan = false;
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.update();

    // 具名监听：拖拽环顾 / 悬停高亮 / 滚轮俯仰 / ESC 退出
    this._addListener(canvas, 'pointerdown', (e) => this._onPointerDown(e));
    this._addListener(canvas, 'pointermove', (e) => this._onPointerMove(e));
    this._addListener(canvas, 'pointerup', (e) => this._onPointerUp(e));
    this._addListener(canvas, 'pointercancel', (e) => this._onPointerUp(e));
    this._addListener(canvas, 'wheel', (e) => this._onWheel(e), { passive: false });
    this._addListener(window, 'keydown', (e) => this._onKeyDown(e));
    this._updateUIForState();
    console.info(
      `[Carousel] init 完成 | 坐骑=${HORSE_COUNT} 灯泡=${BULB_COUNT} 裙边=${SKIRT_COUNT} ` +
      `| 几何=${this._geometries.size} 材质=${this._materials.size} 纹理=${this._textures.size}`
    );
  }

  /** 每帧把 8 匹马的位置写进 4 个 InstancedMesh；全程零 new */
  _syncHorseMatrices(elapsed) {
    const d = this._dummy;
    if (!d) return;
    const radius = 4.2;
    for (let i = 0; i < HORSE_COUNT; i += 1) {
      const h = this._horseBase[i];
      const bob = Math.sin(elapsed * BOB_FREQ + h.phase) * BOB_AMP;
      const x = Math.cos(h.angle) * radius;
      const z = Math.sin(h.angle) * radius;
      const y = h.baseY + bob;
      const rotY = -h.angle; // 切线朝前（与转盘 +Y 旋转的线速度同向）；旧值 -a+π/2 径向朝内是视觉 bug

      d.position.set(x, y, z);
      d.rotation.set(0, rotY, 0);
      d.scale.setScalar(this._horseScale[i]); // 悬停放大（选择阶段高亮反馈）
      d.updateMatrix();
      this._horseIM.setMatrixAt(i, d.matrix);
      this._saddleIM.setMatrixAt(i, d.matrix);

      // 支杆：从底盘直通顶棚，随马一起上下（不随悬停缩放）
      d.scale.setScalar(1);
      d.position.set(x, y + 1.35, z);
      d.updateMatrix();
      this._rodIM.setMatrixAt(i, d.matrix);

      d.position.set(x, y + 3.4, z);
      d.updateMatrix();
      this._knobIM.setMatrixAt(i, d.matrix);
    }
    for (const im of [this._horseIM, this._saddleIM, this._rodIM, this._knobIM]) {
      im.instanceMatrix.needsUpdate = true;
    }
  }

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'cr-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'cr-ui';
    this._uiRoot.innerHTML = `
      <div class="cr-title">🎠 梦幻旋转木马 · 选择坐骑</div>
      <button type="button" class="cr-exit" data-action="exit">返回大厅</button>
      <div class="cr-hint">拖动旋转视角 · 滚轮缩放 · 悬停高亮 · 点击木马开始骑乘</div>
    `;
    document.body.appendChild(this._uiRoot);
    this._ui = {
      exit: this._uiRoot.querySelector('[data-action="exit"]'),
      title: this._uiRoot.querySelector('.cr-title'),
      hint: this._uiRoot.querySelector('.cr-hint'),
    };

    this._addListener(this._uiRoot, 'click', (event) => {
      const button = event.target.closest?.('button[data-action="exit"]');
      if (!button || !this._uiRoot.contains(button)) return;
      this._requestExit(); // 与 ESC 一致：平滑过渡回大厅，不直接跳变
    });
  }

  /* ---------------------------------------------------------------------- */
  /* update —— 由 SceneManager 统一驱动，禁止自建 rAF / world.step()         */
  /* ---------------------------------------------------------------------- */

  update(deltaTime) {
    if (this._disposed) return;
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    this._elapsed += dt;

    // 加速系数：持续 1.5s 的 ×2，随后 0.8s 线性恢复到 1.0
    let factor = 1;
    if (this._boostTimer > 0) {
      this._boostTimer = Math.max(0, this._boostTimer - dt);
      factor = 2;
      if (this._boostTimer === 0) this._boostRecover = BOOST_RECOVER;
    } else if (this._boostRecover > 0) {
      this._boostRecover = Math.max(0, this._boostRecover - dt);
      factor = 1 + (this._boostRecover / BOOST_RECOVER);
    }
    this._carousel.rotation.y += ROTATE_SPEED * factor * dt;

    // 悬停高亮：选择阶段被指到的马缓动放大，其余回缩（帧率无关阻尼）
    for (let i = 0; i < HORSE_COUNT; i += 1) {
      const target = (this._state === 'select' && i === this._hovered) ? HOVER_SCALE : 1;
      this._horseScale[i] = THREE.MathUtils.damp(this._horseScale[i], target, 10, dt);
    }
    this._syncHorseMatrices(this._elapsed);

    // 灯泡呼吸：3 组相位差 2π/3 的正弦，亮度 1.5~3.6（只改 uniform，不重编译 shader）
    for (let i = 0; i < this._bulbMaterials.length; i += 1) {
      const wave = 0.5 + 0.5 * Math.sin(this._elapsed * 2.4 + (i * Math.PI * 2) / BULB_GROUPS);
      this._bulbMaterials[i].emissiveIntensity = 0.57 + wave * 0.8; // ×0.38 抵消 exposure=1.0
    }

    if (this._state === 'select') {
      this._controls?.update(); // OrbitControls 阻尼需每帧驱动
    } else if (this._state === 'riding') {
      this._updateRidingCamera(dt);
    } else if (this._state === 'exiting') {
      // 平滑过渡回大厅：lerp 位置 + slerp 朝向，绝不直接赋值产生跳变
      this._exitBlend = Math.min(1, this._exitBlend + dt / EXIT_BLEND_SECONDS);
      const s = THREE.MathUtils.smoothstep(this._exitBlend, 0, 1);
      const camera = this._ctx.camera;
      camera.position.lerpVectors(this._blendPos, this._cameraSaved.position, s);
      camera.quaternion.slerpQuaternions(this._blendQuat, this._cameraSaved.quaternion, s);
      if (this._exitBlend >= 1) this._ctx?.onExitAttraction?.();
    }
  }

  /** 马体系眼位 → 世界：转盘在原点纯旋转，世界 = 转盘四元数 × 局部（含 bob） */
  _computeRidePose(outPos, outQuat) {
    const h = this._horseBase[this._rideIndex];
    const bob = Math.sin(this._elapsed * BOB_FREQ + h.phase) * BOB_AMP;
    this._tmpVec.set(Math.cos(h.angle) * 4.2, h.baseY + bob, Math.sin(h.angle) * 4.2);
    this._horseQuat.setFromAxisAngle(this._up, -h.angle); // 与 _syncHorseMatrices 的 rotY 一致
    this._tmpVec2.copy(this._eyeOffset).applyQuaternion(this._horseQuat);
    outPos.copy(this._tmpVec).add(this._tmpVec2).applyQuaternion(this._carousel.quaternion);
    outQuat.copy(this._carousel.quaternion).multiply(this._horseQuat);
  }

  /** 骑乘相机：绑定座位随转盘旋转 + 上下起伏；上马 0.9s 平滑混合 */
  _updateRidingCamera(dt) {
    const camera = this._ctx.camera;
    this._computeRidePose(this._seatPos, this._seatQuat);
    this._lookEuler.set(this._lookPitch, this._lookYaw, 0);
    this._lookQuat.setFromEuler(this._lookEuler);
    this._seatQuat.multiply(this._lookQuat); // 朝向 = 马朝向 × 自由环顾（yaw 360° / pitch ±30°）
    if (this._rideBlend < 1) {
      this._rideBlend = Math.min(1, this._rideBlend + dt / RIDE_BLEND_SECONDS);
      const s = THREE.MathUtils.smoothstep(this._rideBlend, 0, 1);
      camera.position.lerpVectors(this._blendPos, this._seatPos, s);
      camera.quaternion.slerpQuaternions(this._blendQuat, this._seatQuat, s);
    } else {
      camera.position.copy(this._seatPos);
      camera.quaternion.copy(this._seatQuat);
    }
  }

  _startRide(index) {
    this._state = 'riding';
    this._rideIndex = index;
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._hovered = -1;
    this._rideBlend = 0;
    this._blendPos.copy(this._ctx.camera.position);
    this._blendQuat.copy(this._ctx.camera.quaternion);
    if (this._controls) this._controls.enabled = false; // 自定义控制激活时禁用 OrbitControls
    this._ctx.renderer.domElement.style.cursor = '';
    this._updateUIForState();
    console.info(`[Carousel] 上马 #${index}：${RIDE_BLEND_SECONDS}s 平滑过渡到第一人称`);
  }

  _requestExit() {
    if (this._disposed || this._state === 'exiting') return;
    this._state = 'exiting';
    this._exitBlend = 0;
    this._dragging = false;
    this._blendPos.copy(this._ctx.camera.position);
    this._blendQuat.copy(this._ctx.camera.quaternion);
    if (this._controls) this._controls.enabled = false;
    this._updateUIForState();
  }

  _updateUIForState() {
    if (!this._ui.title) return;
    if (this._state === 'select') {
      this._ui.title.textContent = '🎠 梦幻旋转木马 · 选择坐骑';
      this._ui.hint.textContent = '拖动旋转视角 · 滚轮缩放 · 悬停高亮 · 点击木马开始骑乘';
    } else if (this._state === 'riding') {
      this._ui.title.textContent = `🎠 骑乘中 · ${this._rideIndex + 1} 号木马`;
      this._ui.hint.textContent = '拖拽 360° 环顾 · 滚轮俯仰 ±30° · 点击加速 · ESC 返回大厅';
    } else {
      this._ui.title.textContent = '🎠 正在返回大厅…';
      this._ui.hint.textContent = '';
    }
  }

  /* ------------------------- 输入：拖拽 / 悬停 / 滚轮 / ESC ------------------------- */

  _onPointerDown(event) {
    this._downPos = { x: event.clientX, y: event.clientY };
    if (this._state === 'riding') {
      this._dragging = true;
      this._lastPointer = { x: event.clientX, y: event.clientY };
    }
  }

  _onPointerMove(event) {
    if (this._state === 'riding' && this._dragging && this._lastPointer) {
      const dx = event.clientX - this._lastPointer.x;
      const dy = event.clientY - this._lastPointer.y;
      this._lastPointer.x = event.clientX;
      this._lastPointer.y = event.clientY;
      this._lookYaw -= dx * 0.0035; // yaw 不限：360° 自由环顾
      this._lookPitch = THREE.MathUtils.clamp(this._lookPitch - dy * 0.0028, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT);
      return;
    }
    if (this._state !== 'select' || event.buttons !== 0 || event.pointerType === 'touch') return;
    // 选择阶段悬停：射线只打马身 / 马鞍两个 InstancedMesh，命中实例号即马号
    const canvas = this._ctx.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this._ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this._ctx.camera);
    const hits = this._raycaster.intersectObjects([this._horseIM, this._saddleIM], false);
    this._hovered = hits.length ? hits[0].instanceId : -1;
    canvas.style.cursor = this._hovered >= 0 ? 'pointer' : '';
  }

  _onPointerUp() {
    this._dragging = false;
    this._lastPointer = null;
  }

  _onWheel(event) {
    if (this._state !== 'riding') return; // 选择阶段滚轮由 OrbitControls 缩放接管
    event.preventDefault();
    this._lookPitch = THREE.MathUtils.clamp(
      this._lookPitch - event.deltaY * 0.0006, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT
    );
  }

  _onKeyDown(event) {
    if (event.code === 'Escape' && !event.repeat) this._requestExit();
  }

  /**
   * 点击坐骑：选择阶段 → 上马骑乘；骑乘阶段 → 短暂加速。
   * InstancedMesh 的命中实例号在 intersection.instanceId；
   * 拖拽（OrbitControls / 环顾）松手也会发 DOM click，位移超阈值一律不当点击。
   */
  onInteract(hitInfo) {
    if (this._disposed || !hitInfo?.hasHit) return;
    const ev = hitInfo.event;
    if (this._downPos && ev
      && Math.hypot(ev.clientX - this._downPos.x, ev.clientY - this._downPos.y) > DRAG_THRESHOLD_PX) return;
    const list = hitInfo.intersections || [];
    let index = -1;
    for (const it of list) {
      if (it.object?.userData?.carouselHorseRole === 'horse' && Number.isInteger(it.instanceId)) {
        index = it.instanceId;
        break;
      }
    }
    if (index < 0 || index >= HORSE_COUNT) return;
    if (this._state === 'select') {
      this._startRide(index);
      return;
    }
    if (this._state !== 'riding') return;
    if (this._elapsed - this._cooldownAt[index] < HORSE_COOLDOWN) return;
    this._cooldownAt[index] = this._elapsed;
    this._boostTimer = BOOST_DURATION;
    this._boostRecover = 0;
    console.info(`[Carousel] 坐骑 ${index} 触发加速 ×2 / ${BOOST_DURATION}s`);
  }

  /** 预热接口：走一遍选择 / 加速 / 骑乘位姿 / 呼吸灯路径，确保 shader 与贴图在基线前上传 */
  warmUp() {
    this.update(0.1); // select：OrbitControls.update + 悬停阻尼 + 灯泡
    this._boostTimer = BOOST_DURATION;
    this.update(0.1);
    // 骑乘位姿数学路径（不真正进入 riding 状态，避免触发退出回调）
    this._rideIndex = 0;
    this._rideBlend = 1;
    this._updateRidingCamera(0.016);
    this._rideIndex = -1;
    // 复位全部运行台账
    this._boostTimer = 0;
    this._boostRecover = 0;
    this._elapsed = 0;
    this._carousel.rotation.y = 0;
    this._hovered = -1;
    this._horseScale.fill(1);
    for (let i = 0; i < this._bulbMaterials.length; i += 1) {
      this._bulbMaterials[i].emissiveIntensity = 0.84;
    }
    this._syncHorseMatrices(0);
    for (let i = 0; i < HORSE_COUNT; i += 1) this._cooldownAt[i] = -Infinity;
    this._ctx.camera.position.set(...SELECT_CAM_POS);
    this._controls.target.set(...SELECT_TARGET);
    this._controls.update();
    return this;
  }

  /* ---------------------------------------------------------------------- */
  /* dispose —— 七步清理 + 幂等锁                                            */
  /* ---------------------------------------------------------------------- */

  _step(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[Carousel] dispose 步骤「${label}」失败（继续后续清理）：`, err); }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._step('计时器与帧循环', () => {
      console.info('[Carousel] 无自建 rAF / 计时器，由 _disposed 锁停止 update');
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
      this._controls?.dispose(); // OrbitControls 自带 canvas 监听，必须显式解绑
      this._controls = null;
      const canvas = this._ctx?.renderer?.domElement;
      if (canvas) canvas.style.cursor = '';
      for (const { target, type, fn, options } of this._listeners) {
        try { target.removeEventListener(type, fn, options); } catch { /* 已解绑 */ }
      }
      this._listeners = [];
      this._uiRoot?.remove();
      this._uiStyle?.remove();
      this._uiRoot = null;
      this._uiStyle = null;
      this._ui = {};
    });

    this._step('物理', () => {
      console.info('[Carousel] 物理资源：未使用 Rapier，刚体 0 / collider 0');
    });

    this._step('GPU 资源', () => this._disposeThreeResources());

    this._step('台账清空', () => {
      this.root.clear(); // scene.remove(root) 由 AttractionManager 第 ③ 步负责
      this._horseBase.length = 0;
      this._bulbMaterials.length = 0;
      this._carousel = null;
      this._horseIM = null;
      this._saddleIM = null;
      this._rodIM = null;
      this._knobIM = null;
      this._dummy = null;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
    });

    this._step('句柄释放', () => {
      this._tmpVec = null;
      this._tmpVec2 = null;
      this._blendPos = null;
      this._blendQuat = null;
      this._seatPos = null;
      this._seatQuat = null;
      this._horseQuat = null;
      this._lookQuat = null;
      this._lookEuler = null;
      this._eyeOffset = null;
      this._raycaster = null;
      this._ndc = null;
      this._downPos = null;
      this._lastPointer = null;
      this._horseScale = null;
      this._cooldownAt = null;
      this._ctx = null;
    });
    console.info('[Carousel] dispose 完成 | 资源已释放，相机已归还');
  }

  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);
    this.root.traverse((obj) => {
      // InstancedMesh 额外持有 instanceMatrix / instanceColor 缓冲，必须显式 dispose
      if (obj.isInstancedMesh && typeof obj.dispose === 'function') {
        try { obj.dispose(); } catch (err) { console.error('[Carousel] InstancedMesh dispose 失败：', err); }
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
      catch (err) { console.error(`[Carousel:纹理] uuid=${texture.uuid} dispose 失败：`, err); }
    }
    const cleared = [];
    for (const ref of refs) {
      try { ref.clear(); cleared.push(ref.path); }
      catch (err) { console.error(`[Carousel:纹理] 断开引用 ${ref.path} 失败：`, err); }
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
      try { material.dispose(); } catch (err) { console.error('[Carousel] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[Carousel] 几何体 dispose 失败：', err); }
    }
    console.info(`[Carousel] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} texture=${texturePlan.size} 引用路径=${cleared.length}`);
  }
}

export default Carousel;
