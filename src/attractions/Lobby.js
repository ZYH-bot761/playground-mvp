/**
 * ============================================================================
 * Lobby —— 第一人称沉浸式「日光游乐场广场」
 * ============================================================================
 * 目标：把 M3/M4 的小游戏整合成一个可自由漫游的 3D 大世界。开局玩家以
 *       第一人称站在宏伟入口大门前，平视前方；拖拽环顾四周天色与发光设施；
 *       走近「南瓜摩天轮」或「金币长廊」的触发区，按 E 或点击进入小游戏；
 *       结算后返回，仍站在刚才的位置、朝向不变。
 *
 * 【零侵入 core/】Lobby 作为 IAttraction 注册，只使用 ctx 注入的
 *   scene / camera / renderer / registerDisposable / onEnterAttraction /
 *   onExitAttraction，不 import、不修改 core/ 任何模块。
 *   相机姿态、背景/雾、外部灯光强度、renderer.shadowMap 都在 init() 里
 *   「保存原值 → 临时接管」，在 dispose() 里逐项恢复。
 *
 * 【销毁重建 + 状态存档】切换小游戏时 AttractionManager 会 deactivate() →
 *   dispose() 彻底销毁本类。模块级单例 _lobbyMemory 保存 { px, pz, yaw, pitch }，
 *   dispose() 写入、init() 读回；JS 模块只求值一次，故跨重建持续存活。
 *
 * 【全程禁用 Rapier】本类不创建任何刚体 / collider，也不调用 world.step()。
 *   移动、±30 边界、建筑阻挡全部用纯数学（2D AABB 扩张 1m）。
 *
 * 【阴影资源是本次重构的最大泄漏风险】
 *   DirectionalLight.castShadow = true 时，three 会为 light.shadow.map 分配
 *   WebGLRenderTarget（含 color texture + depthTexture），两者都会计入
 *   renderer.info.memory.textures。它由渲染器惰性创建、不归项目 Mesh 台账所有，
 *   若不在 dispose() 里显式 light.shadow.dispose()，每轮「大厅→小游戏→大厅」
 *   都会残留一张纹理 → 计数逐轮 +1 漂移。已在 dispose 步骤 0-c 处理。
 *
 * 【IAttraction 契约】init / update / onInteract / dispose 四方法齐全；
 *   dispose 幂等、七步清理、每步独立 try/catch；root 挂到 ctx.scene，
 *   从场景移除交给 AttractionManager 第 ③ 步，本类不自行 scene.remove。
 * ============================================================================
 */

import * as THREE from 'three';
import { IAttraction } from './IAttraction.js';

/* ========================================================================== */
/* 模块级单例：跨「销毁重建」保存第一人称玩家坐标与视角                       */
/* ========================================================================== */

/** @type {{px:number, pz:number, yaw:number, pitch:number}} */
const _lobbyMemory = {
  px: 0,      // 开局站在中轴线上
  pz: 20,     // 大门在 z=15，玩家在其正前方 5 米
  yaw: 0,     // yaw=0 → 相机朝 -z，正对大门
  pitch: 0,   // 平视（人眼高度 1.6）
};

/* ========================================================================== */
/* 常量（参数锁定）                                                            */
/* ========================================================================== */

const EYE_HEIGHT = 1.6;          // 人眼高度：相机 y 恒为该值
const PLAYER_SPEED = 7.5;        // 单位 / 秒
const BOUND = 30;                // 数学边界钳制 ±30
const PITCH_LIMIT = Math.PI / 4; // 上下各 45°
const DRAG_THRESHOLD = 6;        // pointerdown/up 位移 >6px 视为拖拽视角
const CLICK_DEBOUNCE = 200;      // ms 防抖
const ENTER_DISTANCE = 5.0;      // 触发区提示 / E 键判定半径
const CLICK_MAX_DISTANCE = 10.0; // 射线命中后允许进入的最远距离（防远处误触）
const AABB_PAD = 1;              // 建筑 AABB 长宽各扩张 1 米
const DOME_RADIUS = 140;         // 天穹球半径（camera.far = 200，安全）
const FOG_COLOR = 0x060a18;      // 深邃夜雾

/**
 * 四个可进入的设施。trigger 是设施入口处的发光圆环中心（玩家需走到此处）。
 * 南瓜投手 / 金币小径 / 记忆翻牌 / 弹跳碰碰球 均已开发完成，不再是置灰占位。
 */
const FACILITIES = Object.freeze([
  {
    key: 'pumpkin-thrower', name: '南瓜投手', label: '南瓜摩天轮',
    x: -13, z: -6, trigger: { x: -13, z: 2 },
  },
  {
    key: 'coin-path', name: '金币小径', label: '金币长廊',
    x: 13, z: -8, trigger: { x: 13, z: 2 },
  },
  {
    key: 'memory-match', name: '记忆翻牌', label: '魔法牌屋',
    x: 0, z: -15, trigger: { x: 0, z: -8.5 },
  },
  {
    key: 'bouncing-ball', name: '弹跳碰碰球', label: '弹跳竞技场',
    x: 26, z: -2, trigger: { x: 26, z: 6 },
  },
  {
    key: 'train-ride', name: '高空环游', label: '小火车站台',
    x: -26, z: -2, trigger: { x: -26, z: 6 },
  },
]);

/* ========================================================================== */
/* 程序化纹理 / 字体点阵工具（全部零外部资源）                                 */
/* ========================================================================== */

/**
 * 浅色广场地砖：亮底 + 每 16px 一道砖缝 + 细噪点（日光下的水泥/石材观感）。
 * 用 DataTexture 生成，作为 MeshStandardMaterial.map（标准纹理槽位清理路径）。
 */
function makeGroundTexture() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const seam = (x % 16 === 0 || y % 16 === 0);
      const n = ((x * 37 + y * 91) % 17) - 8; // 确定性噪点，避免 Math.random 造成帧间差异
      const base = seam ? 205 : 170;
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, base + n * 0.5);
      data[i + 1] = Math.max(0, base + 4 + n * 0.6);
      data[i + 2] = Math.max(0, base + 14 + n * 0.8);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'lb/ground';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(28, 28);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 星光噪声：绝大多数像素是暗噪，极少数是亮点。天穹 ShaderMaterial 用
 * smoothstep(0.90, 0.995, s) 只取亮点，配合 uTime 做闪烁。
 * ★ 这张纹理【只挂在 ShaderMaterial.uniforms.uStars.value】上，不在任何
 *   material.map 等标准槽位里，专门验证 dispose 的 uniforms 深度扫描清理路径。
 */
function makeStarTexture() {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const h = (x * 73856093) ^ (y * 19349663) ^ ((x + y) * 83492791);
      const r = (h >>> 0) % 1000;
      const v = r < 6 ? 255 : 18 + (r % 22);
      const i = (y * size + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'lb/star-field-uniform-only';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 用 Canvas 2D 把中文渲染成点阵，返回像素格坐标。
 * 只用来生成「发光方块」的摆放位置，不创建任何 THREE.Texture →
 * 既满足「全程序化生成」，也不引入额外 GPU 纹理。
 */
function makeTextPixels(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 260;
  canvas.height = 88;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#fff';
  g.font = 'bold 66px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const pixels = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const step = 5;
  const cells = [];
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      if (pixels[(y * canvas.width + x) * 4] > 110) cells.push({ x, y });
    }
  }
  return { cells, width: canvas.width, height: canvas.height, step };
}

/* ========================================================================== */
/* 纹理引用扫描（沿用 M2 修复后的契约：路径数组绝不去重，逐条断开引用）       */
/* ========================================================================== */

/** 递归扫描任意值里的 THREE.Texture，输出【不去重】的可断开引用路径 */
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

/** 收集材质里所有纹理引用路径（标准槽位 + ShaderMaterial.uniforms 递归） */
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

/* ========================================================================== */
/* 天穹 ShaderMaterial（夜间渐变；fog:false / BackSide / 不写深度）            */
/* 说明：渐变亮度只是「背景」，必须压在地平线亮度以下，否则整屏被天光拉爆。   */
/* ========================================================================== */

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vDir = normalize(worldPos.xyz - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  varying vec3 vDir;

  void main() {
    float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uBottom, uHorizon, smoothstep(0.34, 0.52, h));
    col = mix(col, uTop, smoothstep(0.52, 0.98, h));
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ========================================================================== */
/* DOM Overlay（全层 pointer-events:none，绝不遮挡画布拖拽 / 点击）           */
/* ========================================================================== */

const UI_CSS = `
.lb-ui{position:fixed;inset:0;z-index:20;pointer-events:none;overflow:hidden;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#eaf3ff}
.lb-vignette{position:absolute;inset:0;
  background:radial-gradient(ellipse at 50% 46%,rgba(0,0,0,0) 38%,rgba(2,4,12,.55) 100%)}
.lb-title{position:absolute;top:calc(16px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
  padding:8px 20px;border-radius:999px;white-space:nowrap;
  background:rgba(9,18,38,.58);border:1px solid rgba(125,180,255,.28);
  font-size:16px;font-weight:700;letter-spacing:2px;
  text-shadow:0 0 14px rgba(90,160,255,.65)}
.lb-controls{position:absolute;top:calc(56px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
  padding:6px 16px;border-radius:999px;white-space:nowrap;font-size:12px;
  background:rgba(9,18,38,.46);color:#a9c4e8;letter-spacing:.5px}
.lb-crosshair{position:absolute;top:50%;left:50%;width:7px;height:7px;
  transform:translate(-50%,-50%);border-radius:50%;
  border:1px solid rgba(200,230,255,.75);box-shadow:0 0 8px rgba(110,190,255,.8);
  background:rgba(220,240,255,.18)}
.lb-prompt{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  padding:14px 28px;border-radius:14px;white-space:nowrap;max-width:92vw;
  font-size:17px;font-weight:600;letter-spacing:1px;text-align:center;
  color:#eaf5ff;background:rgba(8,16,34,.62);
  border:1px solid rgba(130,200,255,.45);
  box-shadow:0 0 34px rgba(50,130,255,.28),inset 0 0 22px rgba(70,140,255,.10);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  text-shadow:0 0 12px rgba(120,190,255,.6)}
.lb-prompt b{color:#ffd977;text-shadow:0 0 14px rgba(255,190,80,.8)}
.lb-prompt[data-hidden='true'],.lb-toast[data-hidden='true']{display:none}
.lb-toast{position:absolute;top:62%;left:50%;transform:translateX(-50%);
  padding:10px 22px;border-radius:10px;font-size:14px;white-space:nowrap;max-width:92vw;
  background:rgba(10,20,40,.86);border:1px solid rgba(150,200,255,.4)}
.lb-compass{position:absolute;bottom:calc(18px + env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);
  font-size:11px;color:#7f9dc8;letter-spacing:1px;white-space:nowrap;
  background:rgba(8,16,34,.42);padding:5px 14px;border-radius:999px}
/* 移动端虚拟摇杆：默认隐藏，触屏设备才显示（data-active='true'） */
.lb-stick{position:absolute;left:calc(20px + env(safe-area-inset-left, 0px));
  bottom:calc(20px + env(safe-area-inset-bottom, 0px));
  width:min(132px,34vw);height:min(132px,34vw);display:none;
  pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;
  -webkit-tap-highlight-color:transparent}
.lb-stick[data-active='true']{display:block}
.lb-stick-base{position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle at 50% 50%,rgba(60,110,190,.30),rgba(8,18,38,.42));
  border:1px solid rgba(125,180,255,.35);
  box-shadow:0 0 22px rgba(60,130,255,.20),inset 0 0 26px rgba(40,90,180,.18)}
.lb-stick-knob{position:absolute;left:50%;top:50%;width:40px;height:40px;
  margin:-20px 0 0 -20px;border-radius:50%;
  background:rgba(120,180,255,.55);border:1px solid rgba(200,230,255,.7);
  box-shadow:0 0 18px rgba(110,190,255,.55);will-change:transform}
@media (max-width:900px), (max-height:520px){
  .lb-title{font-size:13px;padding:6px 12px;top:calc(8px + env(safe-area-inset-top, 0px));letter-spacing:1px}
  .lb-controls{display:none} /* 触屏 / 矮屏用摇杆，键盘提示无意义且会与 HUD 抢位 */
  .lb-compass{display:none} /* 装饰性文字，避免与摇杆、刘海区重叠 */
  .lb-prompt{font-size:14px;padding:11px 18px;white-space:normal;line-height:1.5}
  .lb-toast{font-size:13px;white-space:normal;text-align:center}
}
`;

/* ========================================================================== */
/* Lobby                                                                       */
/* ========================================================================== */

export class Lobby extends IAttraction {
  constructor() {
    super();

    this.root = new THREE.Group();
    this.root.name = 'Lobby';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;

    // ---- 第一人称玩家状态（init 时由 _lobbyMemory 恢复） ----
    this._playerPos = { x: _lobbyMemory.px, z: _lobbyMemory.pz };
    this._yaw = _lobbyMemory.yaw;
    this._pitch = _lobbyMemory.pitch;
    this._time = 0;
    this._nearFacility = null;

    // ---- 输入 ----
    this._keys = new Set();
    this._dragging = false;
    this._pointerDown = null;
    this._lastPointer = null;
    this._lastClickAt = -Infinity;
    this._lastEnterAt = -Infinity;

    // ---- 移动端虚拟摇杆状态（归一化 -1..1，x 向右为正，y 向下为正） ----
    // 触屏判定用媒体查询而不是 UA：iPad 的「桌面模式」UA 会伪装成 Mac，
    // 但 pointer:coarse / hover:none 依然成立，判定稳定。
    this._stickEnabled = typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false;
    this._stick = { active: false, x: 0, y: 0, touchId: null };
    // 竖屏时放宽 fov，让大厅设施在窄画幅里仍有足够的可视范围
    this._lastAspect = 0;

    // ---- 场景状态接管（保存原值，dispose 逐项恢复） ----
    this._cameraSaved = null;
    this._sceneSaved = null;
    this._externalLights = [];
    this._shadowSaved = null;
    this._ambientLight = null;
    this._dirLight = null;

    // ---- Three 台账 ----
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._shared = {};
    this._instancedMeshes = [];
    this._pickables = [];
    this._buildingBoxes = [];
    this._standaloneColliders = []; // 全程禁用 Rapier，恒为空；保留以完整履行契约

    // ---- 动画对象（init 一次性创建，update 只改属性，绝不惰性新建资源） ----
    this._wheelGroup = null;
    this._coinMeshes = [];
    this._memoryCards = [];
    this._bounceBall = null;
    this._bounceHalo = null;
    this._particleClouds = [];
    this._triggerRings = [];
    this._domeMaterial = null;

    // ---- 定时器 / DOM / 事件 ----
    this._rafIds = new Set();
    this._intervalIds = new Set();
    this._timeoutIds = new Set();
    this._uiRoot = null;
    this._uiStyle = null;
    this._listeners = [];
    this._ui = {};
    this._toastTimeoutId = null;

    // ---- 射线 ----
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    // ---- 稳定回调（引用固定，可成对解绑） ----
    this._onKeyDown = (event) => {
      if (event.code === 'KeyE') {
        if (event.repeat) return;
        if (this._nearFacility) this._tryEnter(this._nearFacility.key);
        return;
      }
      if (Lobby.isGameKey(event.code)) {
        this._keys.add(event.code);
        event.preventDefault();
      }
    };
    this._onKeyUp = (event) => { this._keys.delete(event.code); };
    this._onBlur = () => {
      this._keys.clear();
      this._dragging = false;
      this._pointerDown = null;
      this._lastPointer = null;
      this._releaseStick();
    };
    this._onPointerDown = (event) => {
      this._dragging = true;
      this._pointerDown = { x: event.clientX, y: event.clientY };
      this._lastPointer = { x: event.clientX, y: event.clientY };
    };
    this._onPointerMove = (event) => {
      if (!this._dragging || !this._lastPointer) return;
      const dx = event.clientX - this._lastPointer.x;
      const dy = event.clientY - this._lastPointer.y;
      this._lastPointer = { x: event.clientX, y: event.clientY };
      // 左右改 yaw（右拖 → 视角右转）；上下改 pitch（上拖 → 抬头），钳制 ±45°
      this._yaw -= dx * 0.0028;
      this._pitch = THREE.MathUtils.clamp(
        this._pitch - dy * 0.0028, -PITCH_LIMIT, PITCH_LIMIT
      );
      this._updateCamera();
    };
    this._onPointerUp = (event) => {
      this._dragging = false;
      const start = this._pointerDown;
      this._pointerDown = null;
      this._lastPointer = null;
      if (!start) return;
      // ① 位移判定：拖拽旋转视角不算点击
      const dist = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (dist > DRAG_THRESHOLD) return;
      // ② 200ms 防抖
      const now = performance.now();
      if (now - this._lastClickAt < CLICK_DEBOUNCE) return;
      this._lastClickAt = now;
      this._handleClick(event);
    };
    this._onPointerCancel = () => {
      this._dragging = false;
      this._pointerDown = null;
      this._lastPointer = null;
    };

    /* ---- 移动端虚拟摇杆（仅触屏设备绑定） ----
     * 摇杆在 UI 覆盖层的独立节点上，不是 canvas 子节点；仍显式 stopPropagation，
     * 防止触摸事件冒泡到任何可能挂在外层的指针监听，和拖拽转视角手势互斥。
     */
    this._onStickStart = (event) => {
      event.stopPropagation();
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      event.preventDefault(); // 阻止页面滚动 / 双击缩放
      this._stick.active = true;
      this._stick.touchId = touch.identifier;
      this._updateStick(touch);
    };
    this._onStickMove = (event) => {
      if (!this._stick.active) return;
      const touches = Array.from(event.changedTouches || []);
      const touch = touches.find((t) => t.identifier === this._stick.touchId);
      if (!touch) return;
      event.preventDefault();
      event.stopPropagation();
      this._updateStick(touch);
    };
    this._onStickEnd = (event) => {
      event.stopPropagation();
      const touches = Array.from(event.changedTouches || []);
      if (touches.some((t) => t.identifier === this._stick.touchId)) this._releaseStick();
    };
  }

  /**
   * 触点 → 归一化向量（x 向右为正，y 向下为正，模长 0..1）。
   * 中心取底盘实测 rect，超出最大半径时按比例收回到圆内；12% 死区避免手指抖动漂移。
   */
  _updateStick(touch) {
    const base = this._ui?.stickBase;
    const knob = this._ui?.stickKnob;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const max = Math.max(1, rect.width / 2 - 20); // 20 = 摇杆头半径
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > max) {
      const k = max / dist;
      dx *= k;
      dy *= k;
    }
    // 统一缩放到 [-1,1] 后套死区，再按剩余行程还原幅度，保摇杆边缘仍为满速
    let nx = dx / max;
    let ny = dy / max;
    const mag = Math.hypot(nx, ny);
    const dead = 0.12;
    if (mag < dead) {
      nx = 0;
      ny = 0;
    } else if (mag > 0) {
      const k = (mag - dead) / ((1 - dead) * mag);
      nx *= k;
      ny *= k;
    }
    this._stick.x = nx;
    this._stick.y = ny;
    if (knob) knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  }

  _releaseStick() {
    this._stick.active = false;
    this._stick.touchId = null;
    this._stick.x = 0;
    this._stick.y = 0;
    const knob = this._ui?.stickKnob;
    if (knob) knob.style.transform = 'translate(0px, 0px)';
  }

  static isGameKey(code) {
    return code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD' ||
      code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight';
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                     */
  /* ------------------------------------------------------------------------ */

  /** @param {Object} ctx IAttraction 上下文（含 onEnterAttraction 回调） */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene } = ctx;
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    /* ---------- ① 状态存档恢复：退出小游戏后仍站在原地、朝向不变 ---------- */
    this._playerPos = { x: _lobbyMemory.px, z: _lobbyMemory.pz };
    this._yaw = _lobbyMemory.yaw;
    this._pitch = THREE.MathUtils.clamp(_lobbyMemory.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this._time = 0;
    console.info(
      `[Lobby] 第一人称恢复存档 px=${this._playerPos.x.toFixed(2)} pz=${this._playerPos.z.toFixed(2)} ` +
      `yaw=${this._yaw.toFixed(3)} pitch=${this._pitch.toFixed(3)} 眼高=${EYE_HEIGHT}`
    );

    /* ---------- ② 接管场景外观 / 光影 / 阴影渲染器状态 ---------- */
    this._takeOverScene(ctx);

    // 【M3 教训】必须挂根节点，否则项目不渲染 → 计数恒等于基线的「假通过」
    scene.add(this.root);

    /* ---------- ③ 共享资源池：所有几何 / 材质 / 纹理在 init 一次性建完 ----------
     * 关键：update() 里绝不新建任何 geometry/material/texture，否则首次上传会
     * 发生在预热之后，造成「游戏中途假泄漏」。
     */
    this._buildSharedResources();
    for (const geo of this._geometries) register(geo);
    for (const mat of this._materials) register(mat);
    for (const tex of this._textures) register(tex);

    /* ---------- ④ 场景奇观（全程序化几何拼搭） ---------- */
    this._buildSky();
    this._buildGround();
    this._buildGate();
    this._buildPumpkinWheel();
    this._buildCoinCorridor();
    this._buildMemoryHouse();
    this._buildBouncingArena();
    this._buildTrainStation();
    this._buildTriggers();

    /* ---------- ④-b 资源上传防线：让资源计数与玩家所处视角无关 ----------
     * renderer.info.memory.geometries 只统计「已被渲染上传」的 geometry。
     * 玩家可能在任意位置 / 任意 yaw 退出小游戏；若重建后某种共享几何体的
     * 所有 Mesh 都落在视锥外，renderOnce() 那一帧就不会上传它，计数会比基线
     * 少 1（并非泄漏，但会让「差值恒为 0」判定失败）。
     * 因此给每个 geometry 保留一个 frustumCulled=false 的代表对象。
     */
    this._ensureGeometryUpload();

    /* ---------- ⑤ 相机 / UI / 输入 ---------- */
    this._updateCamera(); // init 立即摆好第一人称机位，保证随后 renderOnce 上传全部资源
    this._buildUI();
    this._bindInput();

    console.info(
      `[Lobby] init 完成 | 第一人称 | 设施=${FACILITIES.length} | 拾取体=${this._pickables.length} | ` +
      `AABB=${this._buildingBoxes.length} | 几何=${this._geometries.size} 材质=${this._materials.size} ` +
      `纹理=${this._textures.size} | 全程禁用 Rapier`
    );
  }

  _trackGeometry(geo) { this._geometries.add(geo); return geo; }
  _trackMaterial(mat) { this._materials.add(mat); return mat; }
  _trackTexture(tex) { this._textures.add(tex); return tex; }

  /**
   * 保存并接管：相机姿态、背景/雾、基座已有灯光强度、renderer.shadowMap。
   * 不修改 core/ 文件，只在运行时通过 ctx 调整；dispose() 会逐项还原。
   */
  _takeOverScene(ctx) {
    const { scene, camera, renderer } = ctx;

    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    this._sceneSaved = { background: scene.background, fog: scene.fog };
    // 夜间游乐场：背景与雾同色，天穹球负责可见的渐变，纯色只在极远处兜底
    scene.background = new THREE.Color(0x0a1226);
    // 夜间指数雾：与天空同色系，远端设施柔和融入夜色（密度降低，避免糊成一片）
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.010);

    // 夜间照明方案已统一在 SceneManager：一主光（方向光投影）+ 半球光 + 极弱环境光。
    // 本类不再压暗/接管外部灯光，只登记原值，确保 dispose 时能够逐一还原。
    this._externalLights = [];
    for (const child of scene.children) {
      if (!child.isLight) continue;
      this._externalLights.push({
        light: child,
        intensity: child.intensity,
        castShadow: child.castShadow,
      });
    }

    this._shadowSaved = {
      enabled: renderer.shadowMap.enabled,
      type: renderer.shadowMap.type,
    };
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  /** 几何 / 材质 / 纹理全部共享，避免 draw call 与资源计数随场景复杂度膨胀 */
  _buildSharedResources() {
    const geoBox = this._trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    const geoSphere = this._trackGeometry(new THREE.IcosahedronGeometry(1, 1));
    const geoTorus = this._trackGeometry(new THREE.TorusGeometry(1, 0.055, 8, 56));
    const geoCylinder = this._trackGeometry(new THREE.CylinderGeometry(1, 1, 1, 16));
    const geoCoin = this._trackGeometry(new THREE.CylinderGeometry(1, 1, 0.1, 20));
    const geoPlane = this._trackGeometry(new THREE.PlaneGeometry(1, 1));
    const geoDome = this._trackGeometry(new THREE.SphereGeometry(DOME_RADIUS, 40, 24));

    const texGround = this._trackTexture(makeGroundTexture());
    const texStars = this._trackTexture(makeStarTexture());

    const matSky = this._trackMaterial(new THREE.ShaderMaterial({
      uniforms: {
        uStars: { value: texStars }, // 保留 uniforms 纹理引用，继续覆盖深度扫描清理路径
        uTime: { value: 0 },
        uTop: { value: new THREE.Color(0x101c38) },      // 夜空顶：深蓝
        uHorizon: { value: new THREE.Color(0x2a4676) },  // 地平线：蓝调时刻的冷蓝
        uBottom: { value: new THREE.Color(0x0a1226) },   // 地平线以下：与雾/背景同色
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      // 自定义 ShaderMaterial 显式声明参与色调映射，避免与 ACES 双重作用
      toneMapped: true,
    }));
    this._domeMaterial = matSky;

    /* ---------- 材质总则（夜间工业风） ----------
     * 所有实体部件统一 MeshStandardMaterial：
     *   金属件   metalness = 1，roughness 0.3~0.4（只做反射，不做高光镜面）
     *   非金属件 metalness = 0，roughness 0.7~0.9
     * 关键：夜景下 albedo 必须压暗。浅色 + metalness=1 + RoomEnvironment 反射
     *       会在 ACES 之前就冲到 1.0 以上，再叠 Bloom 就是白屏。
     * 发光件用「深色底 + 适度自发光」的 MeshStandardMaterial，由 UnrealBloom
     * （threshold 0.6）拾取，只让灯带本身发光，不把整屏推过阈值。
     */
    const matGround = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x6b7d99, map: texGround, metalness: 0, roughness: 0.82,
    }));
    const matPillar = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xb9c8dd, metalness: 1, roughness: 0.35,
    }));
    const matWheelFrame = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xa8b8cf, metalness: 1, roughness: 0.4,
    }));
    const matTrack = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9c9482, map: texGround, metalness: 0, roughness: 0.78,
    }));

    // 发光件工厂：metalness=0 / roughness=0.7；emissiveIntensity 2.0 在 ACES 下
    // 只保留「亮而不白」的灯管观感（原 2.4 + 无色调映射 = 纯白泛光）
    const makeNeon = (emissive) => this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x1a1a22, emissive, emissiveIntensity: 2.0,
      metalness: 0, roughness: 0.7, toneMapped: true,
    }));
    const matNeonWarm = makeNeon(0xff8a2b);
    const matNeonViolet = makeNeon(0x9a63f0);
    const matNeonCyan = makeNeon(0x27c8ff);
    const matNeonGold = makeNeon(0xffb52e);
    const matTrackLine = makeNeon(0x2f9bd8);

    const matPumpkinOrange = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xff8a24, emissive: 0x5c1f00, emissiveIntensity: 0.5,
      metalness: 0, roughness: 0.62, flatShading: true,
    }));
    const matPumpkinViolet = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9a63e0, emissive: 0x2a1250, emissiveIntensity: 0.5,
      metalness: 0, roughness: 0.62, flatShading: true,
    }));
    const matCoinGold = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffc94a, emissive: 0x7a4c00, emissiveIntensity: 1.0,
      metalness: 1, roughness: 0.12,
    }));

    const matFog = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xdfefff, transparent: true, opacity: 0.04,
      metalness: 0, roughness: 0.9,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    }));
    const matTriggerRing = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9fe8ff, emissive: 0x2fa8d8, emissiveIntensity: 1.6,
      metalness: 0, roughness: 0.6, transparent: true, opacity: 0.7,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    }));
    const matTriggerDisc = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x6fb8e8, emissive: 0x2f7ac0, emissiveIntensity: 1.0,
      metalness: 0, roughness: 0.7, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    }));
    const matParticleWarm = this._trackMaterial(new THREE.PointsMaterial({
      color: 0xffb45c, size: 0.34, sizeAttenuation: true,
      transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }));
    const matParticleGold = this._trackMaterial(new THREE.PointsMaterial({
      color: 0xffd97a, size: 0.3, sizeAttenuation: true,
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }));
    // 点击代理盒：完全不写颜色/深度，视觉不可见，但 Raycaster 可命中
    const matPickProxy = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
      metalness: 0, roughness: 1,
    }));

    this._shared = {
      geoBox, geoSphere, geoTorus, geoCylinder, geoCoin, geoPlane, geoDome,
      texGround, texStars,
      matSky, matGround, matPillar, matWheelFrame, matTrack,
      matNeonWarm, matNeonViolet, matNeonCyan, matNeonGold, matTrackLine,
      matPumpkinOrange, matPumpkinViolet, matCoinGold,
      matFog, matTriggerRing, matTriggerDisc,
      matParticleWarm, matParticleGold, matPickProxy,
    };
  }

  /** 小工具：拼一个封闭 Box 部件（射线从任意角度都能命中，不受背面剔除影响） */
  _box(parent, name, mat, sx, sy, sz, px, py, pz, { key = null, shadow = false } = {}) {
    const mesh = new THREE.Mesh(this._shared.geoBox, mat);
    mesh.name = `Lobby/${name}`;
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(px, py, pz);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (key) {
      mesh.userData.facilityKey = key;
      this._pickables.push(mesh);
    }
    parent.add(mesh);
    return mesh;
  }

  /** 小工具：拼一个球体部件 */
  _ball(parent, name, mat, radius, px, py, pz, { key = null, shadow = false } = {}) {
    const mesh = new THREE.Mesh(this._shared.geoSphere, mat);
    mesh.name = `Lobby/${name}`;
    mesh.scale.setScalar(radius);
    mesh.position.set(px, py, pz);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (key) {
      mesh.userData.facilityKey = key;
      this._pickables.push(mesh);
    }
    parent.add(mesh);
    return mesh;
  }

  /* ------------------------------------------------------------------------ */
  /* ① 渐变星光天穹（大球体反转法线）                                         */
  /* ------------------------------------------------------------------------ */

  _buildSky() {
    const dome = new THREE.Mesh(this._shared.geoDome, this._shared.matSky);
    dome.name = 'Lobby/sky-dome';
    dome.renderOrder = -1000;
    dome.frustumCulled = false;
    this.root.add(dome);
  }

  /* ------------------------------------------------------------------------ */
  /* ② 暗色反光广场地面 + 发光引导线                                          */
  /* ------------------------------------------------------------------------ */

  _buildGround() {
    const S = this._shared;
    const ground = new THREE.Mesh(S.geoPlane, S.matGround);
    ground.name = 'Lobby/ground';
    ground.rotation.x = -Math.PI / 2;
    ground.scale.set(220, 220, 1);
    ground.receiveShadow = true;
    this.root.add(ground);

    // 中轴线 + 左右分岔的发光引导线，把玩家从大门引向三个设施触发区
    this._box(this.root, 'guide-center', S.matNeonCyan, 0.16, 0.02, 22, 0, 0.035, 6);
    // 中轴线继续向前延伸到「魔法牌屋」触发区（z=-8.5）
    this._box(this.root, 'guide-center-front', S.matNeonViolet, 0.16, 0.02, 8, 0, 0.035, -9);
    this._box(this.root, 'guide-left', S.matNeonCyan, 13, 0.02, 0.16, -6.5, 0.035, 2);
    this._box(this.root, 'guide-right', S.matNeonCyan, 13, 0.02, 0.16, 6.5, 0.035, 2);
    // 右侧延长线 → 「弹跳竞技场」触发区（x=26 / z=6）
    this._box(this.root, 'guide-right-far', S.matNeonCyan, 10, 0.02, 0.16, 20, 0.035, 2);
    this._box(this.root, 'guide-arena', S.matNeonGold, 0.16, 0.02, 5, 26, 0.035, 4.2);
    // 左侧延长线 → 「小火车站台」触发区（x=-26 / z=6），与右侧竞技场对称
    this._box(this.root, 'guide-left-far', S.matNeonCyan, 10, 0.02, 0.16, -20, 0.035, 2);
    this._box(this.root, 'guide-station', S.matNeonGold, 0.16, 0.02, 5, -26, 0.035, 4.2);
  }

  /* ------------------------------------------------------------------------ */
  /* ③ 宏伟入口大门（z=15）：双立柱 + 横梁 + 发光方块拼「游乐园」            */
  /* ------------------------------------------------------------------------ */

  _buildGate() {
    const S = this._shared;
    const gate = new THREE.Group();
    gate.name = 'Lobby/gate';
    gate.position.set(0, 0, 15);
    this.root.add(gate);

    for (const side of [-1, 1]) {
      const x = side * 6.5;
      const pillar = new THREE.Mesh(S.geoCylinder, S.matPillar);
      pillar.name = `Lobby/gate-pillar-${side}`;
      pillar.scale.set(1.1, 12, 1.1);
      pillar.position.set(x, 6, 0);
      pillar.castShadow = true;
      gate.add(pillar);
      this._ball(gate, `gate-orb-${side}`, S.matNeonWarm, 1.25, x, 12.5, 0);
      // 立柱正面的紫色发光竖条
      this._box(gate, `gate-strip-${side}`, S.matNeonViolet, 0.22, 10.6, 0.22, x, 6, 1.15);
    }

    this._box(gate, 'gate-beam', S.matPillar, 15, 1.5, 1.8, 0, 12.4, 0, { shadow: true });
    this._box(gate, 'gate-beam-glow-top', S.matNeonWarm, 15.2, 0.16, 0.2, 0, 13.24, 0.98);
    this._box(gate, 'gate-beam-glow-bottom', S.matNeonWarm, 15.2, 0.16, 0.2, 0, 11.56, 0.98);

    // 「游乐园」三个字：Canvas 2D 点阵 → InstancedMesh 发光小方块（一次 draw call）
    const layout = makeTextPixels('游乐园');
    const sign = new THREE.InstancedMesh(S.geoBox, S.matNeonWarm, layout.cells.length);
    sign.name = 'Lobby/gate-sign-instanced';
    sign.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const dummy = new THREE.Object3D();
    const worldW = 11;
    const worldH = worldW * (layout.height / layout.width);
    layout.cells.forEach((cell, i) => {
      const cx = cell.x + layout.step / 2;
      const cy = cell.y + layout.step / 2;
      dummy.position.set(
        (cx / layout.width - 0.5) * worldW,
        (0.5 - cy / layout.height) * worldH + 15.4,
        0.35
      );
      dummy.scale.set(0.38, 0.38, 0.26);
      dummy.updateMatrix();
      sign.setMatrixAt(i, dummy.matrix);
    });
    sign.instanceMatrix.needsUpdate = true;
    sign.frustumCulled = false;
    gate.add(sign);
    this._instancedMeshes.push(sign);

    // AABB：只挡两根立柱，中间留出可通行的门洞
    this._buildingBoxes.push(
      { key: 'gate-left', minX: -7.6 - AABB_PAD, maxX: -5.4 + AABB_PAD, minZ: 15 - 1.2 - AABB_PAD, maxZ: 15 + 1.2 + AABB_PAD },
      { key: 'gate-right', minX: 5.4 - AABB_PAD, maxX: 7.6 + AABB_PAD, minZ: 15 - 1.2 - AABB_PAD, maxZ: 15 + 1.2 + AABB_PAD }
    );
  }

  /* ------------------------------------------------------------------------ */
  /* ④ 南瓜投手设施：发光摩天轮 + 橙紫南瓜球 + 浮动粒子                      */
  /* ------------------------------------------------------------------------ */

  _buildPumpkinWheel() {
    const S = this._shared;
    const facility = FACILITIES[0];
    const group = new THREE.Group();
    group.name = 'Lobby/pumpkin-wheel';
    group.position.set(facility.x, 0, facility.z);
    this.root.add(group);

    // 基座 + 两根斜支架
    const base = new THREE.Mesh(S.geoCylinder, S.matWheelFrame);
    base.name = 'Lobby/wheel-base';
    base.scale.set(3.4, 0.7, 3.4);
    base.position.y = 0.35;
    base.castShadow = true;
    group.add(base);
    for (const side of [-1, 1]) {
      const brace = this._box(group, `wheel-brace-${side}`, S.matWheelFrame,
        0.42, 8.6, 0.42, side * 2.1, 4.3, 0, { key: facility.key, shadow: true });
      brace.rotation.z = -side * 0.26;
    }

    // 轮组：整体绕 z 轴缓慢旋转（update 中只改 rotation，不新建资源）
    const wheel = new THREE.Group();
    wheel.name = 'Lobby/wheel-spin';
    wheel.position.set(0, 8.2, 0);
    group.add(wheel);
    this._wheelGroup = wheel;

    for (const [name, mat, radius] of [
      ['wheel-ring-outer', S.matNeonWarm, 5.4],
      ['wheel-ring-inner', S.matNeonViolet, 3.9],
    ]) {
      const ring = new THREE.Mesh(S.geoTorus, mat);
      ring.name = `Lobby/${name}`;
      ring.scale.set(radius, radius, radius);
      ring.userData.facilityKey = facility.key;
      wheel.add(ring);
      this._pickables.push(ring);
    }
    for (let i = 0; i < 8; i += 1) {
      const spoke = this._box(wheel, `wheel-spoke-${i}`, S.matWheelFrame,
        0.12, 10.8, 0.12, 0, 0, 0, { key: facility.key });
      spoke.rotation.z = (i * Math.PI) / 8;
    }
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      this._ball(wheel, `wheel-pumpkin-${i}`,
        i % 2 === 0 ? S.matPumpkinOrange : S.matPumpkinViolet,
        0.78, Math.cos(a) * 5.4, Math.sin(a) * 5.4, 0,
        { key: facility.key, shadow: true });
    }
    this._ball(wheel, 'wheel-hub', S.matNeonWarm, 1.1, 0, 0, 0, { key: facility.key });

    // 点击代理盒：让「指向设施点击」稳定命中，且不产生任何可见像素
    this._pickProxy(group, facility.key, 13, 15, 13, 0, 7.5, 0);
    // 周围浮动发光粒子（init 建好，update 只改 position attribute）
    this._buildParticleCloud(group, facility.key, 46, S.matParticleWarm,
      { rx: 9, ry: 11, rz: 7, cy: 7 });
    // 设施 AABB（比视觉略小，玩家可站到触发点）
    this._buildingBoxes.push({
      key: facility.key,
      minX: facility.x - 4.5 - AABB_PAD, maxX: facility.x + 4.5 + AABB_PAD,
      minZ: facility.z - 4.5 - AABB_PAD, maxZ: facility.z + 4.5 + AABB_PAD,
    });
  }

  /** 不可见点击代理（不写颜色/深度，但 Raycaster 可命中） */
  _pickProxy(parent, key, sx, sy, sz, px, py, pz) {
    const proxy = new THREE.Mesh(this._shared.geoBox, this._shared.matPickProxy);
    proxy.name = `Lobby/pick-proxy-${key}`;
    proxy.scale.set(sx, sy, sz);
    proxy.position.set(px, py, pz);
    proxy.userData.facilityKey = key;
    parent.add(proxy);
    this._pickables.push(proxy);
    return proxy;
  }

  /** 浮动发光粒子云：Points + 预分配 BufferGeometry，绝不在 update 里新建 */
  _buildParticleCloud(parent, key, count, material, { rx, ry, rz, cy = 0, cz = 0 }) {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      // 确定性伪随机，保证每次重建的资源与预热一致
      const r1 = ((i * 9301 + 49297) % 233280) / 233280;
      const r2 = ((i * 4523 + 137) % 233280) / 233280;
      const r3 = ((i * 7919 + 811) % 233280) / 233280;
      positions[i * 3] = (r1 - 0.5) * rx;
      positions[i * 3 + 1] = cy + (r2 - 0.5) * ry;
      positions[i * 3 + 2] = cz + (r3 - 0.5) * rz;
    }
    const geo = this._trackGeometry(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geo, material);
    points.name = `Lobby/particles-${key}`;
    points.frustumCulled = false;
    parent.add(points);
    this._particleClouds.push({
      points, attribute: geo.attributes.position,
      base: Float32Array.from(positions), count,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤ 金币小径设施：无尽发光长廊 + 悬空金币 + 迷雾                          */
  /* ------------------------------------------------------------------------ */

  _buildCoinCorridor() {
    const S = this._shared;
    const facility = FACILITIES[1];
    const group = new THREE.Group();
    group.name = 'Lobby/coin-corridor';
    group.position.set(facility.x, 0, 0); // 沿 -z 延伸
    this.root.add(group);

    // 跑道：长 130 单位，远端被 FogExp2 吞没，视觉上「看不到尽头」
    const track = new THREE.Mesh(S.geoPlane, S.matTrack);
    track.name = 'Lobby/corridor-track';
    track.rotation.x = -Math.PI / 2;
    track.scale.set(7.5, 130, 1);
    track.position.set(0, 0.06, -60);
    track.receiveShadow = true;
    group.add(track);

    for (const side of [-1, 1]) {
      this._box(group, `corridor-rail-${side}`, S.matTrackLine,
        0.22, 0.1, 130, side * 3.85, 0.14, -60, { key: facility.key });
      const post = new THREE.Mesh(S.geoCylinder, S.matPillar);
      post.name = `Lobby/corridor-post-${side}`;
      post.scale.set(0.7, 6, 0.7);
      post.position.set(side * 4.6, 3, 1);
      post.castShadow = true;
      group.add(post);
      this._ball(group, `corridor-orb-${side}`, S.matNeonGold, 0.9, side * 4.6, 6.3, 1,
        { key: facility.key });
    }
    // 节奏光条：每 6 米一道，产生向前延伸的透视节奏
    for (let i = 0; i < 20; i += 1) {
      this._box(group, `corridor-tick-${i}`, S.matNeonGold,
        7.3, 0.03, 0.16, 0, 0.1, -2 - i * 6, { key: facility.key });
    }

    // 两侧一排排悬空发光金币（扁圆柱，圆面朝 ±z，update 中缓慢翻转 / 浮动）
    for (let side of [-1, 1]) {
      for (let i = 0; i < 18; i += 1) {
        const coin = new THREE.Mesh(S.geoCoin, S.matCoinGold);
        coin.name = `Lobby/coin-${side}-${i}`;
        coin.scale.setScalar(0.62);
        coin.rotation.x = Math.PI / 2;
        const baseY = 2.1 + (i % 3) * 0.62;
        coin.position.set(side * 2.7, baseY, -4 - i * 5);
        coin.castShadow = false;
        coin.userData.facilityKey = facility.key;
        group.add(coin);
        this._pickables.push(coin);
        this._coinMeshes.push({ mesh: coin, baseY, phase: i * 0.7 + (side + 1) * 1.3 });
      }
    }

    // 局部迷雾平面：半透明叠加，强化神秘纵深（fog:false 保持自身蓝雾色）
    for (let i = 0; i < 5; i += 1) {
      const haze = new THREE.Mesh(S.geoPlane, S.matFog);
      haze.name = `Lobby/corridor-haze-${i}`;
      haze.scale.set(15, 10, 1);
      haze.position.set(0, 4.5, -16 - i * 20);
      group.add(haze);
    }

    this._pickProxy(group, facility.key, 11, 10, 24, 0, 4.5, -8);
    this._buildParticleCloud(group, facility.key, 44, S.matParticleGold,
      { rx: 10, ry: 8, rz: 30, cy: 4.5, cz: -16 });

    // AABB：只挡入口两根门柱，中央跑道可自由走进
    for (const side of [-1, 1]) {
      const cx = facility.x + side * 4.6;
      this._buildingBoxes.push({
        key: `${facility.key}-post-${side}`,
        minX: cx - 0.7 - AABB_PAD, maxX: cx + 0.7 + AABB_PAD,
        minZ: 1 - 0.7 - AABB_PAD, maxZ: 1 + 0.7 + AABB_PAD,
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤-b 记忆翻牌设施：魔法牌屋（悬浮发光牌阵 + 符文基座）                    */
  /* ------------------------------------------------------------------------ */

  _buildMemoryHouse() {
    const S = this._shared;
    const facility = FACILITIES[2];
    const group = new THREE.Group();
    group.name = 'Lobby/memory-house';
    group.position.set(facility.x, 0, facility.z); // 中轴线尽头
    this.root.add(group);

    // 基座：厚圆盘 + 地面符文环，承接「魔法阵」的视觉语义
    const base = new THREE.Mesh(S.geoCylinder, S.matWheelFrame);
    base.name = 'Lobby/memory-base';
    base.scale.set(4.4, 0.55, 4.4);
    base.position.y = 0.28;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const runeRing = new THREE.Mesh(S.geoTorus, S.matNeonViolet);
    runeRing.name = 'Lobby/memory-rune-ring';
    runeRing.rotation.x = -Math.PI / 2;
    runeRing.scale.setScalar(3.3);
    runeRing.position.y = 0.6;
    group.add(runeRing); // 装饰环不做拾取，避免与牌阵抢命中

    // 左右立柱 + 顶部横梁（与另外两处设施相同的金属骨架语言）
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(S.geoCylinder, S.matPillar);
      pillar.name = `Lobby/memory-pillar-${side}`;
      pillar.scale.set(0.72, 7.4, 0.72);
      pillar.position.set(side * 4.2, 3.7, 0);
      pillar.castShadow = true;
      group.add(pillar);
      this._ball(group, `memory-orb-${side}`, S.matNeonViolet, 0.88,
        side * 4.2, 7.7, 0, { key: facility.key });
    }
    this._box(group, 'memory-beam', S.matPillar, 9.6, 0.6, 0.9, 0, 7.7, 0, { shadow: true });
    this._box(group, 'memory-beam-glow', S.matNeonViolet, 9.7, 0.14, 0.9, 0, 7.4, 0);

    // 悬浮牌阵：5 张大小不一的发光卡牌，update 中只改 rotation / position
    const cardSpecs = [
      { x: 0, y: 4.6, z: 0, w: 2.6, h: 3.5, mat: S.matNeonViolet, speed: 0.55, phase: 0 },
      { x: -2.95, y: 3.5, z: 0.35, w: 1.9, h: 2.6, mat: S.matNeonCyan, speed: 0.8, phase: 1.15 },
      { x: 2.95, y: 3.5, z: 0.35, w: 1.9, h: 2.6, mat: S.matNeonGold, speed: 0.8, phase: 1.15 },
      { x: -1.55, y: 6.5, z: -0.55, w: 1.5, h: 2.0, mat: S.matNeonWarm, speed: 1.0, phase: 2.3 },
      { x: 1.55, y: 6.5, z: -0.55, w: 1.5, h: 2.0, mat: S.matNeonViolet, speed: 1.0, phase: 2.3 },
    ];
    for (const spec of cardSpecs) {
      const card = this._box(group, 'memory-card', spec.mat, spec.w, spec.h, 0.16,
        spec.x, spec.y, spec.z, { key: facility.key });
      card.castShadow = false;
      this._memoryCards.push({
        mesh: card, baseY: spec.y, phase: spec.phase, speed: spec.speed,
      });
    }

    // 地面外圈符文（装饰，不做拾取）
    const floorRing = new THREE.Mesh(S.geoTorus, S.matNeonViolet);
    floorRing.name = 'Lobby/memory-floor-ring';
    floorRing.rotation.x = -Math.PI / 2;
    floorRing.scale.setScalar(4.7);
    floorRing.position.y = 0.05;
    group.add(floorRing);

    // 不可见点击代理 + 浮动光点
    this._pickProxy(group, facility.key, 11, 9.6, 5.6, 0, 4.5, 0);
    this._buildParticleCloud(group, facility.key, 40, S.matParticleWarm,
      { rx: 10, ry: 8, rz: 4.6, cy: 4.5 });

    // AABB：只挡建筑本体；触发环（z=-8.5）在建筑前方 2 米，玩家可自由站上去
    this._buildingBoxes.push({
      key: facility.key,
      minX: facility.x - 4.4 - AABB_PAD, maxX: facility.x + 4.4 + AABB_PAD,
      minZ: facility.z - 3.4 - AABB_PAD, maxZ: facility.z + 3.4 + AABB_PAD,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤-d 弹跳碰碰球竞技场（右侧前场 x=26 / z=-2）                              */
  /* ------------------------------------------------------------------------ */
  _buildBouncingArena() {
    const S = this._shared;
    const facility = FACILITIES[3];
    const group = new THREE.Group();
    group.name = 'Lobby/bouncing-arena';
    group.position.set(facility.x, 0, facility.z);
    this.root.add(group);

    // 环形场地基座 + 发光围边（复用共享几何，零新增资源）
    const base = new THREE.Mesh(S.geoCylinder, S.matWheelFrame);
    base.name = 'Lobby/bounce-base';
    base.scale.set(5.4, 0.6, 5.4);
    base.position.y = 0.3;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const rim = new THREE.Mesh(S.geoTorus, S.matTrackLine);
    rim.name = 'Lobby/bounce-rim';
    rim.rotation.x = -Math.PI / 2;
    rim.scale.setScalar(5.25);
    rim.position.y = 0.62;
    group.add(rim); // 装饰环不做拾取

    // 场地内 3 个彩色弹性桩（对应游戏内三种球色）
    const bumperMats = [S.matNeonViolet, S.matNeonWarm, S.matTrackLine];
    const bumperPos = [
      { x: -2.6, z: -1.5 }, { x: 2.6, z: -1.5 }, { x: 0, z: 2.4 },
    ];
    bumperPos.forEach((p, i) => {
      const post = new THREE.Mesh(S.geoCylinder, S.matPillar);
      post.name = `Lobby/bounce-post-${i}`;
      post.scale.set(0.48, 2.2, 0.48);
      post.position.set(p.x, 1.1, p.z);
      post.castShadow = true;
      group.add(post);
      this._ball(group, `bounce-orb-${i}`, bumperMats[i], 0.78, p.x, 2.35, p.z,
        { key: facility.key, shadow: true });
    });

    // 悬浮主球 + 光环：update 里只改 position / rotation
    const mainBall = new THREE.Mesh(S.geoSphere, S.matPumpkinOrange);
    mainBall.name = 'Lobby/bounce-main-ball';
    mainBall.scale.setScalar(1.5);
    mainBall.position.set(0, 5.4, 0);
    mainBall.castShadow = true;
    group.add(mainBall);
    this._bounceBall = mainBall;

    const halo = new THREE.Mesh(S.geoTorus, S.matTrackLine);
    halo.name = 'Lobby/bounce-halo';
    halo.rotation.x = -Math.PI / 2;
    halo.scale.setScalar(2.15);
    halo.position.set(0, 5.4, 0);
    group.add(halo);
    this._bounceHalo = halo;

    // 不可见点击代理 + 浮动光点
    this._pickProxy(group, facility.key, 11, 10, 11, 0, 4.6, 0);
    this._buildParticleCloud(group, facility.key, 36, S.matParticleGold,
      { rx: 9, ry: 7.5, rz: 9, cy: 4.4 });

    // AABB：只挡场地本体；触发环（z=6）在场地外 1.6 米，玩家可自由站上去
    this._buildingBoxes.push({
      key: facility.key,
      minX: facility.x - 5.4 - AABB_PAD, maxX: facility.x + 5.4 + AABB_PAD,
      minZ: facility.z - 5.4 - AABB_PAD, maxZ: facility.z + 5.4 + AABB_PAD,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤-d 小火车站台：方块拼搭 + 发光柱（第五个可进入设施）                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 站台完全由共享几何体拼搭，不新增任何 geometry / material / texture，
   * 因此热基线与四个既有设施保持一致：
   *   · 金属件（立柱 / 包边 / 顶棚 / 车轮） matPillar、matWheelFrame（metalness=1）
   *   · 非金属件（台基 / 枕木）             matTrack（metalness=0，石材纹理）
   *   · 发光件（檐灯 / 站前柱灯 / 站牌）      matNeonWarm / matNeonGold / matNeonViolet
   * 位置 x=-26 / z=-2，与右侧「弹跳竞技场」对称，不压左侧引导线（x≤-13）；
   * AABB 只包住站台本体，触发环在 z=6（台基前方），站上去不受阻挡。
   */
  _buildTrainStation() {
    const S = this._shared;
    const facility = FACILITIES[4];
    const group = new THREE.Group();
    group.name = 'Lobby/train-station';
    group.position.set(facility.x, 0, facility.z);
    this.root.add(group);

    // 台基（非金属石材）+ 前后金属包边
    this._box(group, 'station-deck', S.matTrack, 10.6, 0.52, 6.0, 0, 0.26, 0,
      { key: facility.key, shadow: true });
    this._box(group, 'station-trim-front', S.matPillar, 10.7, 0.14, 0.22, 0, 0.55, 3.0);
    this._box(group, 'station-trim-back', S.matPillar, 10.7, 0.14, 0.22, 0, 0.55, -3.0);

    // 四根金属立柱 + 金属顶棚
    for (const sx of [-4.5, 4.5]) {
      for (const sz of [-2.6, 2.6]) {
        const col = new THREE.Mesh(S.geoCylinder, S.matPillar);
        col.name = `Lobby/station-column-${sx}-${sz}`;
        col.scale.set(0.28, 4.7, 0.28);
        col.position.set(sx, 2.75, sz);
        col.castShadow = true;
        col.receiveShadow = true;
        group.add(col);
      }
    }
    this._box(group, 'station-canopy', S.matWheelFrame, 11.2, 0.3, 6.6, 0, 5.25, 0,
      { shadow: true });
    // 檐灯：不铺满长条（10.9m 连续自发光在 Bloom 下会糊成一条白带），
    // 改成一排小灯珠，既保留「站台灯带」的工业感，又不把站台糊白
    for (const lx of [-4.2, -2.5, -0.8, 0.8, 2.5, 4.2]) {
      this._box(group, `station-eave-${lx}`, S.matNeonWarm, 0.9, 0.09, 0.14, lx, 5.06, 3.22);
    }

    // 顶棚吊灯（暖光球）
    for (const lx of [-2.6, 2.6]) {
      this._ball(group, `station-lamp-${lx}`, S.matNeonWarm, 0.26, lx, 4.86, 0,
        { key: facility.key });
    }

    // 站前发光柱（三根，远近都能一眼认出入口）
    for (const px of [-3.8, 0, 3.8]) {
      const post = new THREE.Mesh(S.geoCylinder, S.matPillar);
      post.name = `Lobby/station-post-${px}`;
      post.scale.set(0.09, 3.2, 0.09);
      post.position.set(px, 1.9, 3.45);
      post.castShadow = true;
      group.add(post);
      this._ball(group, `station-post-orb-${px}`, S.matNeonGold, 0.24, px, 3.7, 3.45,
        { key: facility.key });
    }

    // 台面上的轨道：两条金属轨 + 六根枕木
    for (const rx of [-1.35, 1.35]) {
      this._box(group, `station-rail-${rx}`, S.matPillar, 0.16, 0.12, 5.4, rx, 0.64, 0);
    }
    for (let i = 0; i < 6; i += 1) {
      this._box(group, `station-tie-${i}`, S.matTrack, 1.9, 0.1, 0.26, 0, 0.58, -2.2 + i * 0.88);
    }

    // 停在站台中央的方块小火车（车体 / 驾驶室 / 发光车窗 / 烟囱 / 车轮）
    this._box(group, 'station-train-body', S.matPumpkinOrange, 1.5, 0.9, 2.5, 0, 1.16, -0.3,
      { key: facility.key, shadow: true });
    this._box(group, 'station-train-cab', S.matCoinGold, 1.3, 0.72, 1.0, 0, 1.85, -1.0,
      { key: facility.key, shadow: true });
    this._box(group, 'station-train-window', S.matNeonCyan, 1.34, 0.34, 0.62, 0, 1.9, -1.0);
    this._box(group, 'station-train-stack', S.matPillar, 0.3, 0.6, 0.3, 0, 1.55, 0.78);
    for (const wx of [-0.8, 0.8]) {
      const wheel = new THREE.Mesh(S.geoCylinder, S.matPillar);
      wheel.name = `Lobby/station-wheel-${wx}`;
      wheel.rotation.z = Math.PI / 2;
      wheel.scale.set(0.3, 0.16, 0.3);
      wheel.position.set(wx, 0.78, 0.1);
      wheel.castShadow = true;
      group.add(wheel);
    }

    // 站名牌（紫色发光块）+ 不可见点击代理 + 浮动光点
    this._box(group, 'station-sign', S.matNeonViolet, 4.2, 0.7, 0.14, 0, 4.1, 3.14);
    this._pickProxy(group, facility.key, 11.4, 6.2, 7.2, 0, 2.9, 0);
    this._buildParticleCloud(group, facility.key, 24, S.matParticleWarm,
      { rx: 5.0, ry: 4.6, rz: 3.2, cy: 3.2 });

    this._buildingBoxes.push({
      key: facility.key,
      minX: facility.x - 5.3 - AABB_PAD, maxX: facility.x + 5.3 + AABB_PAD,
      minZ: facility.z - 3.0 - AABB_PAD, maxZ: facility.z + 3.0 + AABB_PAD,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑥ 触发区：地面发光圆环 + 半透明圆盘（同时可点击）                       */
  /* ------------------------------------------------------------------------ */

  _buildTriggers() {
    const S = this._shared;
    for (const facility of FACILITIES) {
      const { x, z } = facility.trigger;

      const disc = new THREE.Mesh(S.geoPlane, S.matTriggerDisc);
      disc.name = `Lobby/trigger-disc-${facility.key}`;
      disc.rotation.x = -Math.PI / 2;
      disc.scale.set(4.6, 4.6, 1);
      disc.position.set(x, 0.075, z);
      this.root.add(disc);

      const ring = new THREE.Mesh(S.geoTorus, S.matTriggerRing);
      ring.name = `Lobby/trigger-ring-${facility.key}`;
      ring.rotation.x = -Math.PI / 2;
      ring.scale.setScalar(2.4);
      ring.position.set(x, 0.11, z);
      ring.userData.facilityKey = facility.key;
      this.root.add(ring);
      this._pickables.push(ring);
      this._triggerRings.push(ring);

      // 触发区两侧的小光柱，让入口在夜色里一眼可辨
      for (const side of [-1, 1]) {
        const p = this._box(this.root, `trigger-post-${facility.key}-${side}`,
          S.matNeonCyan, 0.16, 2.2, 0.16, x + side * 2.6, 1.1, z,
          { key: facility.key });
        p.castShadow = false;
        this._ball(this.root, `trigger-orb-${facility.key}-${side}`,
          S.matNeonCyan, 0.22, x + side * 2.6, 2.3, z, { key: facility.key });
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* ⑦ 全局光影：环境光 + 方向光（开启真实阴影）                             */
  /* ------------------------------------------------------------------------ */

  _buildLights() {
    // 日光方案统一收敛到 SceneManager：一主光（方向光，castShadow）+ 半球光 + 极弱环境光。
    // 本类不再自建第二盏投影光（否则会重复投影并过曝）；字段保持为 null，
    // dispose() 中的 _dirLight / _ambientLight 分支因此自然跳过。
    this._ambientLight = null;
    this._dirLight = null;
  }

  /**
   * 为每个共享 geometry 指定一个「常驻渲染」代表对象。
   * 只关闭这 9 个对象的视锥剔除，其余部件仍可正常剔除，性能影响极小。
   */
  _ensureGeometryUpload() {
    const seen = new Set();
    this.root.traverse((obj) => {
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      const geo = obj.geometry;
      if (!geo || seen.has(geo)) return;
      seen.add(geo);
      obj.frustumCulled = false;
    });
    console.info(`[Lobby] 资源上传防线：${seen.size} 个共享几何体已设常驻渲染代表`);
  }

  /* ------------------------------------------------------------------------ */
  /* 定时器 / 事件登记                                                         */
  /* ------------------------------------------------------------------------ */

  _addTimeout(fn, ms) {
    const id = setTimeout(() => { this._timeoutIds.delete(id); fn(); }, ms);
    this._timeoutIds.add(id);
    return id;
  }

  _addListener(target, type, fn, tag = 'ui', options) {
    target.addEventListener(type, fn, options);
    this._listeners.push({ target, type, fn, tag });
  }

  _removeListenersByTag(tag) {
    const keep = [];
    for (const item of this._listeners) {
      if (item.tag === tag) {
        try { item.target.removeEventListener(item.type, item.fn); }
        catch (err) { console.error(`[Lobby] 解绑 ${item.type} 失败：`, err); }
      } else keep.push(item);
    }
    this._listeners = keep;
  }

  _clearAllTimers() {
    for (const id of this._rafIds) cancelAnimationFrame(id);
    for (const id of this._intervalIds) clearInterval(id);
    for (const id of this._timeoutIds) clearTimeout(id);
    this._rafIds.clear();
    this._intervalIds.clear();
    this._timeoutIds.clear();
  }

  /** 键盘 / 指针事件登记（全部 tag='input'，dispose 前段统一解绑） */
  _bindInput() {
    const canvas = this._ctx.renderer.domElement;
    // 字面使用 window.addEventListener('keydown' / 'keyup')
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this._listeners.push({ target: window, type: 'keydown', fn: this._onKeyDown, tag: 'input' });
    this._listeners.push({ target: window, type: 'keyup', fn: this._onKeyUp, tag: 'input' });
    this._addListener(window, 'blur', this._onBlur, 'input');
    this._addListener(document, 'visibilitychange', this._onBlur, 'input');
    this._addListener(canvas, 'pointerdown', this._onPointerDown, 'input');
    this._addListener(canvas, 'pointermove', this._onPointerMove, 'input');
    this._addListener(canvas, 'pointerup', this._onPointerUp, 'input');
    this._addListener(canvas, 'pointercancel', this._onPointerCancel, 'input');

    // 虚拟摇杆：只有触屏设备才绑定。touchmove 必须 passive:false 才能 preventDefault
    if (this._stickEnabled && this._ui?.stick) {
      const stick = this._ui.stick;
      this._addListener(stick, 'touchstart', this._onStickStart, 'input', { passive: false });
      this._addListener(stick, 'touchmove', this._onStickMove, 'input', { passive: false });
      this._addListener(stick, 'touchend', this._onStickEnd, 'input');
      this._addListener(stick, 'touchcancel', this._onStickEnd, 'input');
    }
  }

  /* ------------------------------------------------------------------------ */
  /* UI                                                                       */
  /* ------------------------------------------------------------------------ */

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'lb-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'lb-ui';
    this._uiRoot.innerHTML = `
      <div class="lb-vignette"></div>
      <div class="lb-title">日光游乐场 · 中央广场</div>
      <div class="lb-controls">WASD / 方向键移动 · 按住画面拖拽环顾四周 · 走近设施按 E 或点击进入</div>
      <div class="lb-crosshair"></div>
      <div class="lb-prompt" data-role="prompt" data-hidden="true"></div>
      <div class="lb-toast" data-role="toast" data-hidden="true"></div>
      <div class="lb-stick" data-role="stick" data-active="false">
        <div class="lb-stick-base" data-role="stick-base">
          <div class="lb-stick-knob" data-role="stick-knob"></div>
        </div>
      </div>
      <div class="lb-compass">第一人称漫游 · 不使用 PointerLock</div>
    `;
    document.body.appendChild(this._uiRoot);
    this._ui = {
      prompt: this._uiRoot.querySelector('[data-role="prompt"]'),
      toast: this._uiRoot.querySelector('[data-role="toast"]'),
      stick: this._uiRoot.querySelector('[data-role="stick"]'),
      stickBase: this._uiRoot.querySelector('[data-role="stick-base"]'),
      stickKnob: this._uiRoot.querySelector('[data-role="stick-knob"]'),
    };
    // 触屏设备才显示摇杆；键盘用户保持零干扰
    if (this._ui.stick) this._ui.stick.dataset.active = this._stickEnabled ? 'true' : 'false';
    const controls = this._uiRoot.querySelector('.lb-controls');
    if (controls && this._stickEnabled) {
      controls.textContent = '左下摇杆移动 · 按住画面拖拽环顾 · 走近设施点击进入';
    }
  }

  /** 屏幕正中央半透明提示：按 E 键 或 点击 进入 [设施名称] */
  _showPrompt(html) {
    if (!this._ui.prompt) return;
    this._ui.prompt.innerHTML = html;
    this._ui.prompt.dataset.hidden = 'false';
  }

  _hidePrompt() {
    if (this._ui.prompt) this._ui.prompt.dataset.hidden = 'true';
  }

  _showToast(text) {
    if (!this._ui.toast) return;
    if (this._toastTimeoutId !== null) {
      clearTimeout(this._toastTimeoutId);
      this._timeoutIds.delete(this._toastTimeoutId);
    }
    this._ui.toast.textContent = text;
    this._ui.toast.dataset.hidden = 'false';
    this._toastTimeoutId = this._addTimeout(() => {
      if (this._ui.toast) this._ui.toast.dataset.hidden = 'true';
      this._toastTimeoutId = null;
    }, 1600);
  }

  /* ------------------------------------------------------------------------ */
  /* 交互                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 点击处理：Raycaster 必须传入 intersectObjects(pickables, true)（沿用 M5a 硬约束）。
   * pointerdown/up 位移已在 _onPointerUp 中判拖拽，200ms 防抖也已生效。
   */
  _handleClick(event) {
    const canvas = this._ctx?.renderer?.domElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this._ctx.camera);
    // 【硬性约束】必须传入 pickables 数组与 recursive=true
    const hits = this._raycaster.intersectObjects(this._pickables, true);
    if (hits.length === 0) return;
    const key = hits[0].object.userData.facilityKey;
    if (!key) return;
    const facility = FACILITIES.find((f) => f.key === key);
    if (!facility) return;
    // 距离保护：射线能打到远处设施，但不能隔空传送进入
    const d = Math.hypot(this._playerPos.x - facility.trigger.x, this._playerPos.z - facility.trigger.z);
    if (d > CLICK_MAX_DISTANCE) {
      this._showToast('请走近设施入口再进入');
      return;
    }
    this._tryEnter(key);
  }

  /** 进入设施：两个项目都已开放，统一走 ctx.onEnterAttraction(key) */
  _tryEnter(key) {
    const now = performance.now();
    if (now - this._lastEnterAt < CLICK_DEBOUNCE) return; // 防抖：E + 点击不重复触发
    this._lastEnterAt = now;

    const facility = FACILITIES.find((f) => f.key === key);
    if (!facility) return;
    const fn = this._ctx?.onEnterAttraction;
    if (typeof fn !== 'function') {
      console.warn('[Lobby] 缺少 ctx.onEnterAttraction 回调，无法进入项目');
      return;
    }
    console.info(`[Lobby] 进入「${facility.name}」→ ${key}`);
    fn(key);
  }

  /**
   * IAttraction 契约方法。
   * 点击由自有 pointerdown/pointerup + Raycaster 链路处理（需要位移判拖拽与
   * 200ms 防抖，基座 onInteract 只提供 click，无法区分）；这里刻意不重复触发，
   * 避免双重切换。
   */
  onInteract(_hitInfo) {
    // 故意留空：见上方说明
  }

  /* ------------------------------------------------------------------------ */
  /* 第一人称移动 / 相机 / 距离检测                                            */
  /* ------------------------------------------------------------------------ */

  _blocked(x, z) {
    return this._buildingBoxes.some(
      (b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ
    );
  }

  /**
   * 视口自适应：只在宽高比跨过阈值时改一次 fov（不新建资源）。
   * 竖屏窄画幅下放宽到 70°，保证左右设施与地面边界不被裁掉；桌面维持 55°。
   */
  _fitViewport() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    const a = camera.aspect;
    if (Math.abs(a - this._lastAspect) < 0.01) return;
    this._lastAspect = a;
    const fov = a < 0.8 ? 70 : a < 1.15 ? 62 : 55;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * 按当前相机水平朝向计算移动：按 W 永远朝视野正前方走。
   * forward = (-sin(yaw), -cos(yaw))；right = (cos(yaw), -sin(yaw))
   * 与 camera.rotation.y = yaw（order='YXZ'）时的视线方向完全一致。
   */
  _applyMovement(dt) {
    const has = (...codes) => codes.some((c) => this._keys.has(c));
    const kf = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
    const ks = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);
    // 摇杆并入同一套方向盘语义：推上(y<0) → 前进，推右(x>0) → 右移
    const f = kf - this._stick.y;
    const s = ks + this._stick.x;
    if (f === 0 && s === 0) return;

    const len = Math.hypot(f, s);
    // 键盘量级为 0/±1，摇杆为 0..1 模拟量：只在合成模长 >1 时归一化，
    // 既保留摇杆轻推慢走的比例，又避免 W+D 这类斜向比直行更快。
    const scale = len > 1 ? 1 / len : 1;
    const forward = { x: -Math.sin(this._yaw), z: -Math.cos(this._yaw) };
    const right = { x: Math.cos(this._yaw), z: -Math.sin(this._yaw) };
    const dx = (forward.x * f + right.x * s) * scale * PLAYER_SPEED * dt;
    const dz = (forward.z * f + right.z * s) * scale * PLAYER_SPEED * dt;

    // 数学边界钳制 ±30
    const nx = THREE.MathUtils.clamp(this._playerPos.x + dx, -BOUND, BOUND);
    const nz = THREE.MathUtils.clamp(this._playerPos.z + dz, -BOUND, BOUND);
    // 2D AABB 阻挡：分轴判定，允许沿墙滑动
    if (!this._blocked(nx, this._playerPos.z)) this._playerPos.x = nx;
    if (!this._blocked(this._playerPos.x, nz)) this._playerPos.z = nz;
  }

  /** 第一人称：相机就是玩家眼睛，y 恒为 1.6；rotation.order='YXZ' 保证 yaw 水平 */
  _updateCamera() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    camera.rotation.order = 'YXZ';
    camera.rotation.set(this._pitch, this._yaw, 0);
    camera.position.set(this._playerPos.x, EYE_HEIGHT, this._playerPos.z);
    camera.updateMatrixWorld(true);
  }

  /** 每帧距离判定：<5.0 时屏幕正中央显示半透明提示 */
  _updateProximity() {
    let near = null;
    let minDist = Infinity;
    for (const f of FACILITIES) {
      const d = Math.hypot(this._playerPos.x - f.trigger.x, this._playerPos.z - f.trigger.z);
      if (d < ENTER_DISTANCE && d < minDist) { near = f; minDist = d; }
    }
    this._nearFacility = near;
    if (!near) { this._hidePrompt(); return; }
    this._showPrompt(this._stickEnabled
      ? `点击进入 <b>${near.name}</b>`
      : `按 E 键 或 点击 进入 <b>${near.name}</b>`);
  }

  /** 全部动画只改已有对象的属性，绝不新建任何 GPU 资源 */
  _updateAnimations(dt) {
    this._time += dt;
    const t = this._time;

    if (this._wheelGroup) this._wheelGroup.rotation.z += dt * 0.13;

    for (const c of this._coinMeshes) {
      c.mesh.rotation.y += dt * 1.5;
      c.mesh.position.y = c.baseY + Math.sin(t * 1.7 + c.phase) * 0.22;
    }

    // 魔法牌屋的悬浮牌阵：细微偏转 + 上下浮动（只改属性，不新建资源）
    for (const c of this._memoryCards) {
      c.mesh.rotation.y = Math.sin(t * 0.5 * c.speed + c.phase) * 0.26;
      c.mesh.position.y = c.baseY + Math.sin(t * 1.1 + c.phase) * 0.22;
    }

    // 弹跳竞技场：主球自转 + 上下弹跳感 + 光环缩放
    if (this._bounceBall) {
      this._bounceBall.rotation.y += dt * 0.7;
      this._bounceBall.rotation.x += dt * 0.25;
      this._bounceBall.position.y = 5.4 + Math.sin(t * 1.35) * 0.32;
    }
    if (this._bounceHalo) {
      this._bounceHalo.scale.setScalar(2.15 * (1 + 0.05 * Math.sin(t * 1.35)));
      this._bounceHalo.position.y = this._bounceBall ? this._bounceBall.position.y : 5.4;
    }

    for (const cloud of this._particleClouds) {
      const arr = cloud.attribute.array;
      for (let i = 0; i < cloud.count; i += 1) {
        arr[i * 3 + 1] = cloud.base[i * 3 + 1] + Math.sin(t * 0.9 + i * 0.73) * 0.55;
      }
      cloud.attribute.needsUpdate = true;
    }

    for (let i = 0; i < this._triggerRings.length; i += 1) {
      const s = 2.4 * (1 + 0.06 * Math.sin(t * 2.4 + i * 1.6));
      this._triggerRings[i].scale.setScalar(s);
    }

    if (this._domeMaterial?.uniforms?.uTime) this._domeMaterial.uniforms.uTime.value = t;
  }

  /* ------------------------------------------------------------------------ */
  /* update —— 由基座 SceneManager 统一驱动；本类不自建 rAF、不 world.step()  */
  /* ------------------------------------------------------------------------ */

  update(deltaTime) {
    if (this._disposed) return;
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    this._fitViewport();
    this._applyMovement(dt);
    this._updateCamera();
    this._updateAnimations(dt);
    this._updateProximity();
  }

  /* ------------------------------------------------------------------------ */
  /* dispose —— 七步清理 + 状态存档（每步独立 try/catch，单步失败不中断）     */
  /* ------------------------------------------------------------------------ */

  _step(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[Lobby] dispose 步骤「${label}」失败（继续后续清理）：`, err); }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* ---------- 步骤 0：相机姿态恢复（最前段，显式 try/catch 包裹） ---------- */
    try {
      const camera = this._ctx?.camera;
      if (camera && this._cameraSaved) {
        // 先还原 rotation.order，再 copy quaternion，Euler 才会按原 order 正确重算
        camera.rotation.order = this._cameraSaved.rotationOrder;
        camera.quaternion.copy(this._cameraSaved.quaternion);
        camera.position.copy(this._cameraSaved.position);
        camera.fov = this._cameraSaved.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      }
    } catch (err) {
      console.error('[Lobby] dispose 步骤「相机姿态恢复」失败（继续后续清理）：', err);
    }

    /* ---------- 步骤 0-b：【M5a 核心】状态存档 ----------
     * 大厅每次切换小游戏都被彻底 dispose；把玩家坐标与视角写入模块级单例，
     * 下一次 init() 读回 → 退出后仍站在原地、朝向不变。
     */
    this._step('状态存档 _lobbyMemory', () => {
      _lobbyMemory.px = this._playerPos.x;
      _lobbyMemory.pz = this._playerPos.z;
      _lobbyMemory.yaw = this._yaw;
      _lobbyMemory.pitch = this._pitch;
      console.info(
        `[Lobby] 已存档 px=${_lobbyMemory.px.toFixed(2)} pz=${_lobbyMemory.pz.toFixed(2)} ` +
        `yaw=${_lobbyMemory.yaw.toFixed(3)} pitch=${_lobbyMemory.pitch.toFixed(3)}`
      );
    });

    /* ---------- 步骤 0-c：场景外观 / 外部灯光 / 阴影贴图恢复 ----------
     * ★【本次重构最关键的泄漏防线】
     * DirectionalLight.shadow.map 是 WebGLRenderTarget，其 color texture 与
     * depthTexture 都会计入 renderer.info.memory.textures。它是渲染器惰性创建的，
     * 不在 Mesh 台账里，普通的 geometry/material/texture.dispose() 扫不到。
     * 必须显式 shadow.dispose()（内部会 map.dispose() → deallocateRenderTarget
     * → 释放 color + depth 两张纹理），否则每轮切换残留 1~2 张，计数逐轮漂移。
     */
    this._step('场景外观 / 灯光 / 阴影贴图恢复', () => {
      const { scene, renderer } = this._ctx || {};
      if (scene && this._sceneSaved) {
        scene.background = this._sceneSaved.background;
        scene.fog = this._sceneSaved.fog;
      }
      for (const item of this._externalLights) {
        item.light.intensity = item.intensity;
        item.light.castShadow = item.castShadow;
      }
      this._externalLights = [];

      if (this._dirLight) {
        this._dirLight.castShadow = false;
        if (this._dirLight.shadow) {
          this._dirLight.shadow.dispose();
          console.info('[Lobby] 阴影贴图已释放（shadow.map + depthTexture）');
        }
        this.root.remove(this._dirLight);
      }
      if (this._ambientLight) this.root.remove(this._ambientLight);
      this._dirLight = null;
      this._ambientLight = null;

      if (renderer && this._shadowSaved) {
        renderer.shadowMap.enabled = this._shadowSaved.enabled;
        renderer.shadowMap.type = this._shadowSaved.type;
      }
    });

    /* ---------- 步骤 1：键盘 / 指针事件前段独立解绑 + _keys 置空 ---------- */
    this._step('键盘鼠标事件解绑 / _keys 置空', () => {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      this._removeListenersByTag('input'); // blur / visibilitychange / pointerdown/move/up/cancel
      this._keys.clear();
      this._dragging = false;
      this._pointerDown = null;
      this._lastPointer = null;
      this._nearFacility = null;
      this._releaseStick(); // 摇杆归零 + 摇杆头复位（DOM 稍后整块移除）
    });

    /* ---------- 步骤 2：清除全部定时器 ---------- */
    this._step('定时器', () => {
      this._clearAllTimers();
      this._toastTimeoutId = null;
    });

    /* ---------- 步骤 3：移除 DOM 监听 / UI 节点 / <style> ---------- */
    this._step('UI 与监听', () => {
      this._removeListenersByTag('ui');
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

    /* ---------- 步骤 4：Rapier 刚体（本类全程禁用，确认为 0） ---------- */
    this._step('物理刚体', () => {
      for (const c of this._standaloneColliders || []) {
        this._ctx?.world?.removeCollider(c, true);
      }
      this._standaloneColliders = [];
      console.info('[Lobby] 物理资源：全程禁用 Rapier，刚体数 0');
    });

    /* ---------- 步骤 5：GPU 资源（几何 / 材质 / 纹理 + uniforms 扫描） ---------- */
    this._step('GPU 资源', () => this._disposeThreeResources());

    /* ---------- 步骤 6：台账与状态清空 ---------- */
    this._step('台账清空', () => {
      this.root.clear(); // 从 scene 移除由 AttractionManager 第 ③ 步负责
      this._pickables.length = 0;
      this._buildingBoxes.length = 0;
      this._instancedMeshes.length = 0;
      this._wheelGroup = null;
      this._coinMeshes.length = 0;
      this._memoryCards.length = 0;
      this._particleClouds.length = 0;
      this._triggerRings.length = 0;
      this._domeMaterial = null;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
      this._shared = {};
      this._cameraSaved = null;
      this._sceneSaved = null;
      this._shadowSaved = null;
      this._ctx = null;
    });

    console.info(
      `[Lobby] dispose 完成 | _keys=${this._keys.size} _listeners=${this._listeners.length} ` +
      `刚体=0 | 阴影已释放 | 存档已写入`
    );
  }

  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);

    this.root.traverse((obj) => {
      // InstancedMesh 的 instanceMatrix 是独立 GPU buffer，需单独释放
      if (obj.isInstancedMesh && typeof obj.dispose === 'function') {
        try { obj.dispose(); } catch (err) { console.error('[Lobby] InstancedMesh dispose 失败：', err); }
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
    const add = (texture, source) => {
      if (!texture || !texture.isTexture) return;
      if (!texturePlan.has(texture)) texturePlan.set(texture, { sources: [], disposeCalled: false });
      const meta = texturePlan.get(texture);
      if (!meta.sources.includes(source)) meta.sources.push(source);
    };
    for (const tex of this._textures) add(tex, '台账');
    for (const ref of refs) add(ref.texture, ref.path);

    for (const [texture, meta] of texturePlan) {
      try { texture.dispose(); meta.disposeCalled = true; }
      catch (err) { console.error(`[Lobby:纹理] uuid=${texture.uuid} dispose 失败：`, err); }
    }
    // 路径数组【不去重】：共享纹理的每条引用都要断开（M2 修复结论）
    const cleared = [];
    for (const ref of refs) {
      try { ref.clear(); cleared.push(ref.path); }
      catch (err) { console.error(`[Lobby:纹理] 断开引用 ${ref.path} 失败：`, err); }
    }
    const clearedSet = new Set(cleared);
    const summary = [];
    for (const [texture, meta] of texturePlan) {
      const own = refs.filter((r) => r.texture === texture).map((r) => r.path);
      summary.push({
        uuid: texture.uuid,
        name: texture.name || '-',
        '来源': meta.sources.join(' | '),
        'dispose() 已调用': meta.disposeCalled ? '是' : '否',
        '引用已断开': own.every((p) => clearedSet.has(p)) ? '是' : '否',
      });
    }
    console.table(summary);
    for (const material of materials) {
      try { material.dispose(); } catch (err) { console.error('[Lobby] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[Lobby] 几何体 dispose 失败：', err); }
    }
    console.info(
      `[Lobby] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} ` +
      `texture=${texturePlan.size} 引用路径=${cleared.length}`
    );
  }
}

export default Lobby;
