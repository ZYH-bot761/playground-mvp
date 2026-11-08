/**
 * ============================================================================
 * CoinPath —— 收集类游乐项目「金币小径」（M4）
 * ============================================================================
 * 依据《游乐场 MVP 功能详细设计 v0.1》§3 项目 2 / §4 UI / §6.1：
 *   玩家控制低多边形小球移动，收集沿路金币、避开木箱障碍；
 *   键盘 WASD / 方向键，移动端虚拟摇杆或点按移动；
 *   【参数锁定】金币 30 枚（每枚 1 分）、60 秒、障碍 8 个；
 *   时间到自动结算，撞障碍只扣时间（-2s）不结束游戏；
 *   金币旋转发光、障碍为低多边形木箱、地面有引导路径。
 *
 * 【单文件闭环】场景、物理、粒子、UI（DOM + CSS）、状态机、计时、存档、
 *   键盘 / 虚拟按键、资源清理全部在本类内；不 import、不修改 core/。
 *
 * 【IAttraction 契约】init(ctx) / update(dt) / onInteract(hitInfo) / dispose()
 *   四方法齐全；dispose() 幂等；root 挂到 ctx.scene 交由 AttractionManager 移除；
 *   项目内绝不调用 world.step()（由 PhysicsManager 独占）。
 *
 * ---------------------------------------------------------------------------
 * 【编写前 API 复核 · Rapier 0.21.0】（硬性约束：ActiveCollisionTypes.ALL）
 *   dist/geometry/collider.d.ts:65-106  ActiveCollisionTypes 枚举：
 *     DYNAMIC_DYNAMIC=1 / DYNAMIC_KINEMATIC=12 / DYNAMIC_FIXED=2
 *     KINEMATIC_KINEMATIC=52224 / KINEMATIC_FIXED=8704 / FIXED_FIXED=32
 *     DEFAULT=15  → 注释原文：「enabling collisions between a dynamic body
 *                    and another body of any type, but NOT enabling collisions
 *                    between two non-dynamic bodies」
 *     ALL=60943   → 含 KINEMATIC_FIXED(8704)
 *   dist/geometry/collider.d.ts:1009      ColliderDesc.setActiveCollisionTypes(t)
 *   dist/pipeline/world.d.ts:545          intersectionPair(c1,c2): boolean
 *     注释：「Returns true if collider1 and collider2 intersect and at least
 *            one of them is a sensor.」
 *   dist/dynamics/rigid_body.d.ts:626     RigidBodyDesc.kinematicPositionBased()
 *   dist/dynamics/rigid_body.d.ts:280     RigidBody.setNextKinematicTranslation(t)
 *   dist/geometry/index.d.ts:4            export * from "./collider"
 *     ⇒ RAPIER.ActiveCollisionTypes.ALL 可从默认命名空间直接取到（运行时实测 60943）。
 *
 *   ★★★ 本次最大物理坑 ★★★
 *   角色是 KinematicPositionBased，金币 / 障碍是 Fixed + sensor。
 *   两者都是「非 dynamic 刚体」，DEFAULT(15) 不含 KINEMATIC_FIXED(8704)，
 *   若不显式设置 setActiveCollisionTypes(ALL)，窄相根本不会生成这对
 *   intersection pair，world.intersectionPair() 将【永远返回 false】，
 *   金币吃不到、障碍也撞不上。因此对参与查询的【三方 collider 全部】
 *   （角色 / 金币 / 障碍）设置 ALL，并把依据写在此处与调用点注释中。
 *   粒子不参与 intersectionPair 查询，无需 ALL，避免产生大量无用窄相对。
 * ---------------------------------------------------------------------------
 * 【M3 经验沿用】
 *   - init() 必须 scene.add(this.root)，否则项目不渲染 → 计数恒等于基线的「假通过」；
 *   - 命中/收集帧第一动作先 removeRigidBody，再计分与特效；
 *   - 相机接管后 dispose 最前段 try/catch 恢复；
 *   - 预热必须触发全部 shader/贴图上传，否则首次游玩才惰性上传 = 「假泄漏」。
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { IAttraction } from './IAttraction.js';
import PauseMenu from '../ui/PauseMenu.js';

/* ========================================================================== */
/* 常量配置（参数锁死，无占位符）                                              */
/* ========================================================================== */

const STATE = Object.freeze({ READY: 'ready', PLAYING: 'playing', OVER: 'over' });

const COIN_COUNT = 30; // 详细设计 §6.1：金币数量=30
const COIN_SCORE = 1; // 每枚 1 分
const ROUND_SECONDS = 60; // 时间=60s
const OBSTACLE_COUNT = 8; // 障碍物数量=8
const OBSTACLE_PENALTY = 2; // 撞障碍扣 2 秒，不结束游戏
const HIT_COOLDOWN = 0.8; // 同一障碍重复触发保护（秒）
const BEST_SCORE_KEY = 'playground.coin-path.bestScore';

const PLAYER_RADIUS = 0.45;
const PLAYER_Y = 0.45;
const PLAYER_START_Z = 12;
const PLAYER_SPEED = 6.5; // 单位/秒
const COIN_RADIUS = 0.4;
const OBSTACLE_HALF = 0.6;
const BOUNDS = Object.freeze({ minX: -9, maxX: 9, minZ: -14, maxZ: 14 }); // 数学钳制边界

const PARTICLES_PER_EVENT = 6;
const PARTICLE_TTL = 0.8;
const MAX_PARTICLES = 60;
const TAP_DEADZONE = 0.25;

/** 30 枚金币的确定性蛇形路径（5 行 × 6 列），保证不随机、每轮可复现 */
const COIN_LAYOUT = (() => {
  const out = [];
  for (let row = 0; row < 5; row += 1) {
    const z = -11 + row * 5.5;
    for (let col = 0; col < 6; col += 1) {
      const t = col / 5;
      const x = row % 2 === 0 ? -7 + t * 14 : 7 - t * 14;
      out.push({ x, y: 0.55, z: z + Math.sin(t * Math.PI) * 0.8 });
    }
  }
  return Object.freeze(out);
})();

/** 8 个低多边形木箱障碍的固定布局 */
const OBSTACLE_LAYOUT = Object.freeze([
  { x: -4.6, z: -8.3 }, { x: 4.6, z: -8.3 },
  { x: -2.6, z: -2.8 }, { x: 2.6, z: -2.8 },
  { x: -5.2, z: 2.8 }, { x: 5.2, z: 2.8 },
  { x: -3.2, z: 8.3 }, { x: 3.2, z: 8.3 },
]);

/* ========================================================================== */
/* 无副作用工具函数                                                            */
/* ========================================================================== */

/** 程序化 DataTexture（PRD 附录 A：优先程序化生成，零成本） */
function makeCheckerTexture(name, colorA, colorB, size = 8) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const c = (x + y) % 2 === 0 ? colorA : colorB;
      const i = (y * size + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3];
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = name;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 递归扫描任意值，把其中所有 THREE.Texture 记录成「可断开的引用路径」。
 * 【M2 修复结论】释放计划（Map 去重）与引用路径（数组【不去重】）必须分离，
 * 否则共享纹理的某条引用会被跳过，下一帧可能被重新上传。
 */
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

/** 收集单个材质里所有纹理引用路径（标准槽位 + ShaderMaterial.uniforms 递归） */
function collectMaterialTextureReferences(material, index) {
  const out = [];
  if (!material) return out;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture === true) {
      out.push({
        texture: value,
        path: `materials[${index}].${key}`,
        clear: () => { material[key] = null; },
      });
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

/** 金币光晕用 ShaderMaterial：texGlow 只挂在 uniforms 里，延续 M3 已验证的清理路径 */
const GLOW_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const GLOW_FRAGMENT = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec3 uTint;
  varying vec2 vUv;
  void main() {
    vec4 texel = texture2D(uTex, vUv);
    gl_FragColor = vec4(texel.rgb * uTint, texel.a * 0.85);
  }
`;

/** 悬浮 UI 样式（类内注入 <style>，dispose 移除） */
const UI_CSS = `
.cp-ui{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#eef3ff}
.cp-hud{position:absolute;top:calc(14px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
  display:flex;gap:16px;padding:9px 18px;border-radius:999px;white-space:nowrap;
  background:rgba(12,18,34,.82);border:1px solid rgba(150,180,255,.3);
  box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:15px;letter-spacing:.5px}
.cp-hud b{color:#ffd75e;font-size:18px}
.cp-hud[data-hidden='true']{display:none}
.cp-shade{position:absolute;inset:0;background:rgba(6,10,22,.55)}
.cp-panel{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  pointer-events:auto;width:min(420px,calc(100vw - 32px));padding:24px 26px 20px;
  max-height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  background:rgba(14,20,38,.95);border:1px solid rgba(150,180,255,.35);
  border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.55);text-align:center}
.cp-panel[data-hidden='true'],.cp-shade[data-hidden='true']{display:none}
.cp-panel__title{margin:0 0 10px;font-size:26px;font-weight:700;color:#ffd75e}
.cp-panel__desc{margin:0 0 8px;font-size:14px;line-height:1.6;color:#c8d6f5}
.cp-panel__hint{margin:0 0 14px;font-size:12px;line-height:1.7;color:#8fa4cf}
.cp-panel__score{margin:0 0 16px;padding:12px;border-radius:10px;
  background:rgba(120,160,255,.12);font-size:15px;line-height:1.9}
.cp-panel__score[data-hidden='true']{display:none}
.cp-panel__score b{color:#ffd75e;font-size:20px}
.cp-panel__buttons{display:flex;gap:10px;justify-content:center;margin-bottom:12px}
.cp-btn{flex:1;padding:10px 12px;font-size:14px;border-radius:9px;cursor:pointer;
  color:#dbe6ff;background:rgba(255,255,255,.08);border:1px solid rgba(160,190,255,.4)}
.cp-btn:hover{background:rgba(140,180,255,.22);border-color:rgba(190,215,255,.7)}
.cp-btn--primary{color:#10162a;font-weight:700;background:#ffd75e;border-color:#ffd75e}
.cp-btn--primary:hover{background:#ffe38c;border-color:#ffe38c}
.cp-btn[data-hidden='true']{display:none}
.cp-btn--exit{color:#ffe9b0;background:rgba(255,200,90,.14);border-color:rgba(255,200,90,.55)}
.cp-panel__note{margin:0;font-size:11px;line-height:1.6;color:#7f92b8}
.cp-dpad{position:absolute;bottom:calc(18px + env(safe-area-inset-bottom, 0px));
  left:calc(18px + env(safe-area-inset-left, 0px));display:grid;
  grid-template-columns:repeat(3,52px);grid-template-rows:repeat(3,52px);gap:4px;
  pointer-events:auto;touch-action:none;user-select:none}
.cp-pad{display:flex;align-items:center;justify-content:center;font-size:20px;
  color:#e8f0ff;background:rgba(14,22,42,.82);border:1px solid rgba(150,180,255,.45);
  border-radius:10px;cursor:pointer;touch-action:none;user-select:none}
.cp-pad:active,.cp-pad[data-active='true']{background:rgba(255,215,94,.55);color:#10162a}
.cp-pad--up{grid-area:1/2}.cp-pad--left{grid-area:2/1}
.cp-pad--right{grid-area:2/3}.cp-pad--down{grid-area:3/2}
.cp-dpad[data-hidden='true']{display:none}
@media (max-width:560px){
  .cp-hud{top:calc(8px + env(safe-area-inset-top, 0px));gap:8px;font-size:12px;padding:6px 12px;
    max-width:calc(100vw - 112px);flex-wrap:wrap;justify-content:center;
    white-space:normal;line-height:1.4}
  .cp-hud b{font-size:14px}
  .cp-dpad{grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,48px)}
  .cp-panel{padding:18px 18px 16px}
  .cp-panel__title{font-size:22px}
  .cp-panel__buttons{flex-direction:column} /* 拇指好按，也避免两按钮挤成窄条 */
  .cp-btn{min-height:44px;font-size:15px}
}
@media (max-height:520px){
  .cp-panel{padding:16px 20px 14px;max-height:calc(100dvh - 20px)}
  .cp-panel__title{font-size:20px;margin-bottom:6px}
  .cp-panel__hint{display:none}
}
/* 手机横屏：方向键整体压到 138px（屏高 390 时约 35%），仍满足 44px 触控目标 */
@media (max-height:430px) and (orientation:landscape){
  .cp-dpad{grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);gap:3px;
    bottom:calc(8px + env(safe-area-inset-bottom, 0px));
    left:calc(10px + env(safe-area-inset-left, 0px))}
  .cp-pad{font-size:16px;border-radius:8px}
}
`;

/* ========================================================================== */
/* 项目实现                                                                    */
/* ========================================================================== */

export class CoinPath extends IAttraction {
  constructor() {
    super();

    /** 根节点：init 挂到 ctx.scene，由 AttractionManager 卸载时移除 */
    this.root = new THREE.Group();
    this.root.name = 'CoinPath';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;
    this._state = STATE.READY;

    // ---- 时钟 / 状态 ----
    this._time = 0;
    this._elapsed = 0;
    this._timeLeft = ROUND_SECONDS;
    this._score = 0;
    this._collected = 0;
    this._bestScore = 0;
    this._hudAccumulator = 0;

    // ---- 输入（硬性约束：_keys 必须在 dispose 前段置空） ----
    this._keys = new Set();
    this._tapTarget = null;
    this._playerTarget = { x: 0, y: PLAYER_Y, z: PLAYER_START_Z };

    // ---- 相机接管 ----
    this._cameraSaved = null;
    this._lastAspect = 0; // 视口自适应：记录上次宽高比，避免每帧重算

    // ---- 物理台账 ----
    this._playerBody = null;
    this._playerCollider = null;
    this._coins = [];
    this._obstacles = [];
    this._particles = [];
    this._standaloneColliders = [];

    // ---- Three 台账 ----
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._shared = {};

    // ---- 定时器全登记 ----
    this._rafIds = new Set();
    this._intervalIds = new Set();
    this._timeoutIds = new Set();

    // ---- DOM / 事件登记 ----
    this._uiRoot = null;
    this._uiStyle = null;
    this._listeners = [];
    this._ui = {};
    this._pauseMenu = null;

    // ---- 射线辅助 ----
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._tapPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // 地面 y = 0
    this._tapPoint = new THREE.Vector3();

    // ---- 稳定的事件回调引用（必须能成对解绑） ----
    this._onKeyDown = (event) => {
      if (!CoinPath.isGameKey(event.code)) return;
      this._keys.add(event.code);
      // 仅在游戏进行中拦截方向键滚动，不劫持浏览器快捷键
      if (this._state === STATE.PLAYING) event.preventDefault();
    };
    this._onKeyUp = (event) => {
      this._keys.delete(event.code);
    };
    this._onBlur = () => {
      // 切后台 / 失焦时清空残留输入，防止摄像机乱飘
      this._keys.clear();
      this._tapTarget = null;
    };
    this._onVisibility = () => {
      if (document.hidden) {
        this._keys.clear();
        this._tapTarget = null;
      }
    };
    this._onGlobalPointerUp = () => {
      // 虚拟按键兜底：任何抬手都清掉全部方向键状态
      for (const code of ['PadUp', 'PadDown', 'PadLeft', 'PadRight']) this._keys.delete(code);
      if (this._ui.dpad) {
        for (const btn of this._ui.dpad.querySelectorAll('.cp-pad')) btn.dataset.active = 'false';
      }
    };
  }

  /** 受支持的键盘码（使用 event.code，与键盘布局无关） */
  static isGameKey(code) {
    return code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD' ||
      code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight';
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 创建场景、物理刚体、共享资源池、DOM UI 与键盘监听，进入准备态。
   * @param {Object} ctx IAttraction 契约上下文
   */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera, RAPIER, world } = ctx;
    if (!RAPIER || !world) throw new Error('[CoinPath] 缺少已初始化的 Rapier 世界');

    /* ---------- 【硬性约束】取 ActiveCollisionTypes.ALL 并写明依据 ----------
     * collider.d.ts:98-101 明确：DEFAULT=15 只启用 dynamic 与其它类型的碰撞，
     * 「not enabling collisions between two non-dynamic bodies」。
     * 本项目 角色(Kinematic) × 金币/障碍(Fixed sensor) 属于 KINEMATIC_FIXED=8704，
     * 不在 DEFAULT 内 ⇒ 必须 ALL=60943，否则 world.intersectionPair() 恒为 false。
     * 运行时已实测 RAPIER.ActiveCollisionTypes.ALL === 60943。
     */
    const ALL_TYPES = RAPIER.ActiveCollisionTypes && RAPIER.ActiveCollisionTypes.ALL;
    if (typeof ALL_TYPES !== 'number') {
      throw new Error('[CoinPath] RAPIER.ActiveCollisionTypes.ALL 不可用，拒绝以 DEFAULT 静默降级');
    }
    this._allTypes = ALL_TYPES;
    this._collisionEvents = RAPIER.ActiveEvents.COLLISION_EVENTS;
    console.info(
      `[CoinPath] 碰撞类型已设 ALL=${ALL_TYPES}（含 KINEMATIC_FIXED=${RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED}），` +
      `DEFAULT=${RAPIER.ActiveCollisionTypes.DEFAULT} 不含该位`
    );

    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    /* ---------- 相机接管（不改 core，仅改 ctx.camera 运行时状态） ---------- */
    this._cameraSaved = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov };
    camera.position.set(0, 16, 16);
    camera.lookAt(0, 0, 0);
    this._fitViewport();

    /* ---------- 关键：挂根节点（M3 教训，漏了会造成「假通过」） ---------- */
    scene.add(this.root);

    /* ---------- 共享资源池：几何 / 材质只建一次 ---------- */
    const geoPlayer = this._trackGeometry(new THREE.IcosahedronGeometry(1, 1));
    const geoTorus = this._trackGeometry(new THREE.TorusGeometry(0.3, 0.11, 8, 16));
    const geoGlow = this._trackGeometry(new THREE.PlaneGeometry(1.2, 1.2));
    const geoBox = this._trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    const geoGround = this._trackGeometry(new THREE.PlaneGeometry(20, 30));
    const geoPath = this._trackGeometry(new THREE.PlaneGeometry(3.2, 28));

    const texGround = this._trackTexture(makeCheckerTexture('cp/ground', [42, 66, 52, 255], [34, 54, 44, 255]));
    const texWood = this._trackTexture(makeCheckerTexture('cp/wood', [150, 100, 56, 255], [112, 72, 38, 255]));
    // 这张纹理【只】挂在 ShaderMaterial.uniforms.uTex.value，专门验证深度扫描
    const texGlow = this._trackTexture(makeCheckerTexture('cp/glow-uniform-only', [255, 226, 130, 255], [255, 186, 60, 255]));
    texGround.colorSpace = THREE.SRGBColorSpace;
    texWood.colorSpace = THREE.SRGBColorSpace;
    texGlow.colorSpace = THREE.SRGBColorSpace;

    const matPlayer = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x59d8ff, emissive: 0x104a66, roughness: 0.35, metalness: 0.1,
    }));
    const matCoin = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffcc33, emissive: 0x7a4a00, metalness: 0.55, roughness: 0.3,
    }));
    const matGlow = this._trackMaterial(new THREE.ShaderMaterial({
      uniforms: { uTex: { value: texGlow }, uTint: { value: new THREE.Color(0xffdd77) } },
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    }));
    const matGround = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texGround, roughness: 1, metalness: 0,
    }));
    const matPath = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9fd6b0, emissive: 0x153322, roughness: 1,
    }));
    const matParticleA = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffd75e, emissive: 0x5a3d00, roughness: 0.5,
    }));
    const matParticleB = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x8ef0c0, emissive: 0x1d5533, roughness: 0.5,
    }));

    this._shared = {
      geoPlayer, geoTorus, geoGlow, geoBox, geoGround, geoPath,
      matPlayer, matCoin, matGlow, matGround, matPath,
      matParticles: [matParticleA, matParticleB],
      matWoodBase: this._trackMaterial(new THREE.MeshStandardMaterial({
        color: 0xffffff, map: texWood, roughness: 0.9,
      })),
    };

    // Three 资源登记进 registry 作二次兜底（THREE dispose 幂等）；Rapier 句柄不登记
    for (const geo of this._geometries) register(geo);
    for (const mat of this._materials) register(mat);
    for (const tex of this._textures) register(tex);

    /* ---------- 地面 + 引导路径 ---------- */
    const ground = new THREE.Mesh(geoGround, matGround);
    ground.name = 'CoinPath/ground';
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    this.root.add(ground);

    const pathStrip = new THREE.Mesh(geoPath, matPath);
    pathStrip.name = 'CoinPath/guide-path';
    pathStrip.rotation.x = -Math.PI / 2;
    pathStrip.position.set(0, 0.012, 0);
    this.root.add(pathStrip);

    /* ---------- 角色：KinematicPositionBased ---------- */
    this._buildPlayer(ctx);

    /* ---------- 30 金币 + 8 障碍 ---------- */
    this._buildObstacles(ctx);
    this._rebuildCoins(ctx);

    /* ---------- DOM UI 与键盘监听 ---------- */
    this._buildUI();
    this._pauseMenu = new PauseMenu({
      onRestart: () => this._startRound(),
      onExit: () => {
        this._pauseMenu?.dispose();
        this._ctx?.onExitAttraction?.();
      },
    }).attach();
    this._bindInput();
    this._bestScore = this._readBestScore();
    this._setState(STATE.READY);

    // HUD 刷新定时器（真实用途，ID 登记）
    this._addInterval(() => this._renderHUD(), 100);

    console.info(
      `[CoinPath] init 完成 | 金币=${this._coins.length} 障碍=${this._obstacles.length} ` +
      `| 60s | KinematicPositionBased | 退出请用左上角卸载按钮`
    );
  }

  _trackGeometry(geo) { this._geometries.add(geo); return geo; }
  _trackMaterial(mat) { this._materials.add(mat); return mat; }
  _trackTexture(tex) { this._textures.add(tex); return tex; }

  /**
   * 角色刚体：KinematicPositionBased + setNextKinematicTranslation 驱动。
   * 【ALL 依据】player collider 是 intersectionPair 查询的参与方，必须 ALL；
   * 否则与 Fixed sensor 的窄相对不会生成（DEFAULT 不含 KINEMATIC_FIXED）。
   */
  _buildPlayer(ctx) {
    const { RAPIER, world } = ctx;
    const S = this._shared;

    const group = new THREE.Group();
    group.name = 'CoinPath/player';
    const ball = new THREE.Mesh(S.geoPlayer, S.matPlayer);
    ball.name = 'player-ball';
    ball.scale.setScalar(PLAYER_RADIUS);
    group.add(ball);
    group.position.set(0, PLAYER_Y, PLAYER_START_Z);
    this.root.add(group);
    this._playerGroup = group;

    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(0, PLAYER_Y, PLAYER_START_Z);
    this._playerBody = world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
      .setActiveCollisionTypes(this._allTypes) // ← 硬性约束：ALL
      .setActiveEvents(this._collisionEvents);
    this._playerCollider = world.createCollider(colliderDesc, this._playerBody);
  }

  /** 8 个 Fixed + sensor 木箱障碍（每个独立材质以便单独闪色） */
  _buildObstacles(ctx) {
    const { RAPIER, world } = ctx;
    const S = this._shared;
    for (let i = 0; i < OBSTACLE_COUNT; i += 1) {
      const layout = OBSTACLE_LAYOUT[i % OBSTACLE_LAYOUT.length];
      const material = this._trackMaterial(S.matWoodBase.clone());
      const mesh = new THREE.Mesh(S.geoBox, material);
      mesh.name = `CoinPath/obstacle-${i}`;
      mesh.scale.set(OBSTACLE_HALF * 2, OBSTACLE_HALF * 2, OBSTACLE_HALF * 2);
      mesh.position.set(layout.x, OBSTACLE_HALF, layout.z);
      this.root.add(mesh);

      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(layout.x, OBSTACLE_HALF, layout.z);
      const body = world.createRigidBody(bodyDesc);
      // 【ALL 依据】障碍 collider 是 intersectionPair 查询参与方（Fixed sensor）
      const colliderDesc = RAPIER.ColliderDesc.cuboid(OBSTACLE_HALF, OBSTACLE_HALF, OBSTACLE_HALF)
        .setSensor(true)
        .setActiveCollisionTypes(this._allTypes) // ← 硬性约束：ALL
        .setActiveEvents(this._collisionEvents);
      const collider = world.createCollider(colliderDesc, body);

      this._obstacles.push({
        mesh, body, collider, material, layout,
        wasIntersecting: false, cooldown: 0, flash: 0,
      });
    }
  }

  /** 重建 30 枚金币（init / 开局 / 重新开始 / 提前结算后重玩都走这里） */
  _rebuildCoins(ctx) {
    const context = ctx || this._ctx;
    const { RAPIER, world } = context;
    const S = this._shared;

    // 先移除上一局残留的金币刚体与 Mesh（共享几何/材质不释放）
    for (const coin of this._coins) {
      if (coin.body) {
        try { world.removeRigidBody(coin.body); } catch (err) {
          console.error('[CoinPath] 重建金币时移除旧刚体失败：', err);
        }
      }
      coin.group?.removeFromParent();
      coin.body = null; coin.collider = null; coin.group = null;
    }
    this._coins.length = 0;

    for (let i = 0; i < COIN_COUNT; i += 1) {
      const p = COIN_LAYOUT[i % COIN_LAYOUT.length];
      const group = new THREE.Group();
      group.name = `CoinPath/coin-${i}`;
      group.position.set(p.x, p.y, p.z);

      const ring = new THREE.Mesh(S.geoTorus, S.matCoin);
      ring.name = 'coin-ring';
      group.add(ring);

      const glow = new THREE.Mesh(S.geoGlow, S.matGlow);
      glow.name = 'coin-glow';
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = -0.02;
      group.add(glow);
      this.root.add(group);

      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z);
      const body = world.createRigidBody(bodyDesc);
      // 【ALL 依据】金币 collider 是 intersectionPair 查询参与方（Fixed sensor）
      const colliderDesc = RAPIER.ColliderDesc.ball(COIN_RADIUS)
        .setSensor(true)
        .setActiveCollisionTypes(this._allTypes) // ← 硬性约束：ALL
        .setActiveEvents(this._collisionEvents);
      const collider = world.createCollider(colliderDesc, body);

      this._coins.push({
        group, body, collider, position: p, alive: true,
        phase: i * 0.73,
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 定时器 / 事件登记助手                                                     */
  /* ------------------------------------------------------------------------ */

  _addInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this._intervalIds.add(id);
    return id;
  }

  _addTimeout(fn, ms) {
    const id = setTimeout(() => { this._timeoutIds.delete(id); fn(); }, ms);
    this._timeoutIds.add(id);
    return id;
  }

  _addListener(target, type, fn, tag = 'ui') {
    target.addEventListener(type, fn);
    this._listeners.push({ target, type, fn, tag });
  }

  /** 按 tag 解绑并从台账移除（输入事件在 dispose 前段调用） */
  _removeListenersByTag(tag) {
    const keep = [];
    for (const item of this._listeners) {
      if (item.tag === tag) {
        try { item.target.removeEventListener(item.type, item.fn); }
        catch (err) { console.error(`[CoinPath] 解绑 ${item.type} 失败：`, err); }
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

  /**
   * 【硬性约束】键盘监听：字面使用 window.addEventListener('keydown'/'keyup')。
   * 另登记 blur / visibilitychange / 全局 pointerup 作残留输入防护。
   */
  _bindInput() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this._addListener(window, 'blur', this._onBlur, 'input');
    this._addListener(document, 'visibilitychange', this._onVisibility, 'input');
    this._addListener(window, 'pointerup', this._onGlobalPointerUp, 'input');
    this._addListener(window, 'pointercancel', this._onGlobalPointerUp, 'input');
  }

  /* ------------------------------------------------------------------------ */
  /* UI（DOM Overlay + 虚拟 D-pad，绝不使用 CSS2DRenderer）                    */
  /* ------------------------------------------------------------------------ */

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'cp-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'cp-ui';
    this._uiRoot.innerHTML = `
      <div class="cp-hud" data-cp-interactive data-role="hud">
        <span>剩余时间 <b data-role="time">60</b> s</span>
        <span>得分 <b data-role="score">0</b></span>
        <span>金币 <b data-role="coins">0/30</b></span>
      </div>
      <div class="cp-shade" data-role="shade"></div>
      <div class="cp-panel" data-cp-interactive data-role="panel">
        <div class="cp-panel__title" data-role="title">金币小径</div>
        <p class="cp-panel__desc" data-role="desc"></p>
        <p class="cp-panel__hint">WASD / 方向键移动，或用左下角方向键；也可点击地面自动前进。收集 30 枚金币，撞木箱扣 2 秒，60 秒一局。</p>
        <div class="cp-panel__score" data-role="score-block"></div>
        <div class="cp-panel__buttons">
          <button type="button" class="cp-btn cp-btn--primary" data-action="start" data-role="primary">开始</button>
          <button type="button" class="cp-btn" data-action="restart">重新开始</button>
        </div>
        <div class="cp-panel__buttons">
          <button type="button" class="cp-btn cp-btn--exit" data-action="exit" data-role="exit" data-hidden="true">🎠 返回游乐场</button>
        </div>
        <p class="cp-panel__note">退出本项目请使用左上角卸载按钮；结算后也可点「🎠 返回游乐场」回到大厅。</p>
      </div>
      <div class="cp-dpad" data-cp-interactive data-role="dpad">
        <button type="button" class="cp-pad cp-pad--up" data-dir="up">↑</button>
        <button type="button" class="cp-pad cp-pad--left" data-dir="left">←</button>
        <button type="button" class="cp-pad cp-pad--right" data-dir="right">→</button>
        <button type="button" class="cp-pad cp-pad--down" data-dir="down">↓</button>
      </div>
    `;
    document.body.appendChild(this._uiRoot);

    const q = (role) => this._uiRoot.querySelector(`[data-role="${role}"]`);
    this._ui = {
      hud: q('hud'), shade: q('shade'), panel: q('panel'), dpad: q('dpad'),
      title: q('title'), desc: q('desc'), scoreBlock: q('score-block'),
      time: q('time'), score: q('score'), coins: q('coins'), primary: q('primary'),
      exit: q('exit'),
    };

    // 面板按钮：事件委托
    this._addListener(this._uiRoot, 'click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || !this._uiRoot.contains(button)) return;
      if (button.dataset.action === 'start') this._startRound();
      if (button.dataset.action === 'restart') this._resetToReady();
      if (button.dataset.action === 'exit') {
        // M5a：由基座注入的回调切回 Lobby（大厅从 _lobbyMemory 恢复位置与视角）
        const fn = this._ctx?.onExitAttraction;
        if (typeof fn === 'function') fn();
        else console.warn('[CoinPath] 缺少 ctx.onExitAttraction，无法返回游乐场');
      }
    }, 'ui');

    // 虚拟 D-pad：纯 DOM，pointerdown/up/cancel/leave 写入同一 _keys
    const DIR_CODE = { up: 'PadUp', down: 'PadDown', left: 'PadLeft', right: 'PadRight' };
    for (const button of this._ui.dpad.querySelectorAll('.cp-pad')) {
      const code = DIR_CODE[button.dataset.dir];
      this._addListener(button, 'pointerdown', (event) => {
        event.preventDefault();
        this._keys.add(code);
        button.dataset.active = 'true';
      }, 'ui');
      const release = (event) => {
        event.preventDefault();
        this._keys.delete(code);
        button.dataset.active = 'false';
      };
      this._addListener(button, 'pointerup', release, 'ui');
      this._addListener(button, 'pointercancel', release, 'ui');
      this._addListener(button, 'pointerleave', release, 'ui');
    }
  }

  /** 判断落点是否压在 UI 上（HUD / 面板 / 虚拟按键），防止误触 */
  _isPointerOverUI(event) {
    if (!this._uiRoot || !event) return false;
    const nodes = this._uiRoot.querySelectorAll('[data-cp-interactive]');
    for (const node of nodes) {
      if (node.offsetParent === null) continue; // display:none
      const r = node.getBoundingClientRect();
      if (event.clientX >= r.left && event.clientX <= r.right &&
          event.clientY >= r.top && event.clientY <= r.bottom) return true;
    }
    return false;
  }

  _renderHUD() {
    if (this._disposed || !this._ui.time) return;
    this._ui.time.textContent = String(Math.ceil(this._timeLeft));
    this._ui.score.textContent = String(this._score);
    this._ui.coins.textContent = `${this._collected}/${COIN_COUNT}`;
  }

  _setState(next, reason = '') {
    this._state = next;
    if (this._disposed || !this._ui.panel) return;
    const playing = next === STATE.PLAYING;
    this._ui.panel.dataset.hidden = String(playing);
    this._ui.shade.dataset.hidden = String(playing);
    this._ui.hud.dataset.hidden = String(next === STATE.READY);
    this._ui.dpad.dataset.hidden = String(!playing);
    // M5a：「🎠 返回游乐场」只在结算态出现
    if (this._ui.exit) this._ui.exit.dataset.hidden = String(next !== STATE.OVER);

    if (next === STATE.READY) {
      this._ui.title.textContent = '金币小径';
      this._ui.desc.textContent = '控制小球沿引导路径收集金币，避开木箱。60 秒内收集越多越好。';
      this._ui.primary.textContent = '开始';
      this._ui.scoreBlock.dataset.hidden = 'true';
    } else if (next === STATE.OVER) {
      this._ui.title.textContent = reason === '全部收集！' ? '全部收集！' : '本局结束';
      this._ui.desc.textContent = reason === '全部收集！'
        ? '30 枚金币全部收入囊中，漂亮！可以再来一局。'
        : '时间到！可以再来一局挑战最高分。';
      this._ui.primary.textContent = '再玩一次';
      this._ui.scoreBlock.dataset.hidden = 'false';
      this._ui.scoreBlock.innerHTML =
        `本局得分 <b>${this._score}</b><br>收集金币 <b>${this._collected}/${COIN_COUNT}</b><br>历史最高分 <b>${this._bestScore}</b>`;
    }
    this._renderHUD();
  }

  _startRound() {
    if (this._disposed) return;
    this._score = 0;
    this._collected = 0;
    this._timeLeft = ROUND_SECONDS;
    this._keys.clear();
    this._tapTarget = null;
    this._playerTarget = { x: 0, y: PLAYER_Y, z: PLAYER_START_Z };
    this._clearParticles();
    this._rebuildCoins();
    this._setState(STATE.PLAYING);
    console.info('[CoinPath] 开局：60 秒 / 30 枚金币 / 8 个障碍');
  }

  /** 「重新开始」= 清空本局并回到准备态（不卸载项目，出口在左上角） */
  _resetToReady() {
    if (this._disposed) return;
    this._score = 0;
    this._collected = 0;
    this._timeLeft = ROUND_SECONDS;
    this._keys.clear();
    this._tapTarget = null;
    this._playerTarget = { x: 0, y: PLAYER_Y, z: PLAYER_START_Z };
    this._clearParticles();
    this._rebuildCoins();
    this._setState(STATE.READY);
    console.info('[CoinPath] 已重新开始（回到准备态）');
  }

  /** 结算：时间到 或 全部收集（提前结算），暂停逻辑 */
  _endRound(reason) {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    if (reason !== '全部收集！') this._timeLeft = 0;
    this._keys.clear();
    this._tapTarget = null;
    this._clearParticles();
    if (this._score > this._bestScore) {
      this._bestScore = this._score;
      this._writeBestScore(this._bestScore);
    }
    this._setState(STATE.OVER, reason);
    console.info(`[CoinPath] 结算（${reason}）：本局 ${this._score} 分 / 最高 ${this._bestScore} 分`);
  }

  _readBestScore() {
    try {
      const n = Number.parseInt(window.localStorage.getItem(BEST_SCORE_KEY) ?? '0', 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch { return 0; }
  }

  _writeBestScore(value) {
    try { window.localStorage.setItem(BEST_SCORE_KEY, String(value)); } catch { /* 静默降级 */ }
  }

  /* ------------------------------------------------------------------------ */
  /* 移动 / 碰撞 / 粒子                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * 由 _keys 合成移动向量并钳制边界，然后用 setNextKinematicTranslation 驱动刚体。
   * 键盘优先；无按键时若有 _tapTarget（点按移动）则朝目标转向。
   * 视觉 Mesh 用同一 target 立即同步；物理位置在下一次 world.step() 生效，
   * 因此 intersectionPair 查询相对视觉有一帧延迟（60fps 下可忽略）。
   */
  _applyMovement(dt) {
    let dx = 0;
    let dz = 0;
    const has = (...codes) => codes.some((c) => this._keys.has(c));
    if (has('KeyW', 'ArrowUp', 'PadUp')) dz -= 1;
    if (has('KeyS', 'ArrowDown', 'PadDown')) dz += 1;
    if (has('KeyA', 'ArrowLeft', 'PadLeft')) dx -= 1;
    if (has('KeyD', 'ArrowRight', 'PadRight')) dx += 1;

    if (dx !== 0 || dz !== 0) {
      this._tapTarget = null; // 键盘 / 虚拟按键优先于点按目标
    } else if (this._tapTarget) {
      const tx = this._tapTarget.x - this._playerTarget.x;
      const tz = this._tapTarget.z - this._playerTarget.z;
      const dist = Math.hypot(tx, tz);
      if (dist > TAP_DEADZONE) { dx = tx / dist; dz = tz / dist; }
      else this._tapTarget = null;
    }

    if (dx !== 0 || dz !== 0) {
      const len = Math.hypot(dx, dz);
      const step = PLAYER_SPEED * dt;
      this._playerTarget.x = THREE.MathUtils.clamp(
        this._playerTarget.x + (dx / len) * step, BOUNDS.minX, BOUNDS.maxX
      );
      this._playerTarget.z = THREE.MathUtils.clamp(
        this._playerTarget.z + (dz / len) * step, BOUNDS.minZ, BOUNDS.maxZ
      );
    }

    // 【硬性约束】每帧用 setNextKinematicTranslation 驱动 KinematicPositionBased 刚体
    this._ctx.world && this._playerBody?.setNextKinematicTranslation({
      x: this._playerTarget.x, y: PLAYER_Y, z: this._playerTarget.z,
    });
    this._syncPlayerMesh();
  }

  _syncPlayerMesh() {
    if (this._playerGroup) {
      this._playerGroup.position.set(this._playerTarget.x, PLAYER_Y, this._playerTarget.z);
    }
  }

  /** 金币旋转 + 上下浮动；木箱命中闪色衰减 */
  _animateCoins(dt) {
    for (const coin of this._coins) {
      if (!coin.alive || !coin.group) continue;
      coin.group.rotation.y += dt * 2.4;
      coin.group.position.y = coin.position.y + Math.sin(this._time * 2.2 + coin.phase) * 0.12;
    }
    for (const obs of this._obstacles) {
      if (obs.flash > 0) {
        obs.flash = Math.max(0, obs.flash - dt * 2.5);
        obs.material.emissive.setRGB(obs.flash * 0.7, obs.flash * 0.18, 0);
      }
    }
  }

  /**
   * 【核心碰撞逻辑】窄相已在基座 physics.step(dt) 中更新，此处只查询。
   * - world.intersectionPair(player, coin)  → 收集
   * - world.intersectionPair(player, obs)   → 上升沿 + 冷却触发 -2s
   * 三方 collider 均已 setActiveCollisionTypes(ALL)（见 init 注释依据）。
   */
  _checkCollisions(dt) {
    const world = this._ctx?.world;
    if (!world || !this._playerCollider) return;

    // ① 金币：sensor，intersectionPair 判定收集
    for (const coin of this._coins) {
      if (!coin.alive || !coin.collider) continue;
      let hit = false;
      try { hit = world.intersectionPair(this._playerCollider, coin.collider); }
      catch (err) { console.error('[CoinPath] 金币 intersectionPair 失败：', err); }
      if (hit) this._collectCoin(coin);
    }

    // ② 障碍：sensor + 上升沿 + 冷却，避免站在箱子里每帧扣分
    for (const obs of this._obstacles) {
      let hit = false;
      try { hit = world.intersectionPair(this._playerCollider, obs.collider); }
      catch (err) { console.error('[CoinPath] 障碍 intersectionPair 失败：', err); }
      if (hit && !obs.wasIntersecting && obs.cooldown <= 0) this._hitObstacle(obs);
      obs.wasIntersecting = hit;
      obs.cooldown = Math.max(0, obs.cooldown - dt);
    }
  }

  /** 收集：第一动作先移除刚体，再计分 / 特效（M3 纪律） */
  _collectCoin(coin) {
    const world = this._ctx?.world;
    coin.alive = false;
    if (coin.body) {
      try { world?.removeRigidBody(coin.body); } // removeRigidBody 级联删挂载 collider
      catch (err) { console.error('[CoinPath] 移除金币刚体失败：', err); }
      coin.body = null;
      coin.collider = null;
    }
    coin.group?.removeFromParent();
    coin.group = null;

    this._score += COIN_SCORE;
    this._collected += 1;
    this._spawnParticles(coin.position.x, coin.position.y, coin.position.z, 0);

    if (this._collected >= COIN_COUNT) {
      this._endRound('全部收集！'); // 提前结算
    } else {
      this._renderHUD();
    }
  }

  /** 撞障碍：只扣 2 秒，不结束游戏（时间扣到 0 才由 update 结算） */
  _hitObstacle(obs) {
    this._timeLeft = Math.max(0, this._timeLeft - OBSTACLE_PENALTY);
    obs.cooldown = HIT_COOLDOWN;
    obs.flash = 1;
    this._spawnParticles(obs.layout.x, OBSTACLE_HALF, obs.layout.z, 1);
    this._renderHUD();
    console.info(`[CoinPath] 撞到木箱 -${OBSTACLE_PENALTY}s，剩余 ${this._timeLeft.toFixed(1)}s`);
  }

  /** 粒子：Dynamic + sensor 小立方 + 共享几何/材质，TTL 与 setTimeout 双保险 */
  _spawnParticles(x, y, z, variant) {
    const { RAPIER, world } = this._ctx;
    const S = this._shared;
    for (let i = 0; i < PARTICLES_PER_EVENT; i += 1) {
      if (this._particles.length >= MAX_PARTICLES) this._removeParticle(this._particles[0], 'cap');
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinvel((Math.random() - 0.5) * 7, 2 + Math.random() * 5, (Math.random() - 0.5) * 7)
        .setLinearDamping(0.35);
      const body = world.createRigidBody(bodyDesc);
      // 粒子不参与 intersectionPair 查询，无需 ALL，避免生成大量无用窄相对
      const colliderDesc = RAPIER.ColliderDesc.cuboid(0.08, 0.08, 0.08).setSensor(true);
      const collider = world.createCollider(colliderDesc, body);

      const mesh = new THREE.Mesh(S.geoBox, S.matParticles[(i + variant) % S.matParticles.length]);
      mesh.name = 'CoinPath/particle';
      mesh.scale.setScalar(0.16 + Math.random() * 0.12);
      mesh.position.set(x, y, z);
      this.root.add(mesh);

      const particle = { mesh, body, collider, age: 0, timeoutId: null };
      particle.timeoutId = this._addTimeout(
        () => this._removeParticle(particle, 'timeout'), PARTICLE_TTL * 1000 + 80
      );
      this._particles.push(particle);
    }
  }

  _removeParticle(particle, reason) {
    if (particle.timeoutId !== null) {
      clearTimeout(particle.timeoutId);
      this._timeoutIds.delete(particle.timeoutId);
      particle.timeoutId = null;
    }
    if (particle.body) {
      try { this._ctx?.world?.removeRigidBody(particle.body); }
      catch (err) { console.error(`[CoinPath] 移除粒子刚体失败(${reason})：`, err); }
      particle.body = null; particle.collider = null;
    }
    particle.mesh?.removeFromParent();
    particle.mesh = null;
    const i = this._particles.indexOf(particle);
    if (i >= 0) this._particles.splice(i, 1);
  }

  _clearParticles() {
    for (const p of [...this._particles]) this._removeParticle(p, 'clear');
    this._particles.length = 0;
  }

  /** 粒子 TTL 到期回收 + 位置同步 */
  _sweepParticles(dt) {
    for (const particle of [...this._particles]) {
      particle.age += dt;
      if (particle.age >= PARTICLE_TTL) { this._removeParticle(particle, 'ttl'); continue; }
      const p = particle.body?.translation();
      if (p && particle.mesh) {
        particle.mesh.position.set(p.x, p.y, p.z);
        particle.mesh.rotation.x += dt * 4;
        particle.mesh.rotation.y += dt * 6;
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* onInteract —— 点按移动通道                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * 双通道之「点按移动」：射线打到地面 y=0 平面得到目标点，无按键时自动前进。
   * 防误触：必须点在 canvas 上且不在任何 UI 交互区域内。
   */
  onInteract(hitInfo) {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    const event = hitInfo?.event;
    const canvas = this._ctx?.renderer?.domElement;
    if (!event || !canvas || event.target !== canvas) return;
    if (this._isPointerOverUI(event)) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this._ctx.camera);
    if (!this._raycaster.ray.intersectPlane(this._tapPlane, this._tapPoint)) return;

    this._tapTarget = new THREE.Vector3(
      THREE.MathUtils.clamp(this._tapPoint.x, BOUNDS.minX, BOUNDS.maxX),
      PLAYER_Y,
      THREE.MathUtils.clamp(this._tapPoint.z, BOUNDS.minZ, BOUNDS.maxZ)
    );
  }

  /* ------------------------------------------------------------------------ */
  /* update                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * 视口自适应：竖屏时相机后退并放宽 fov，保证 ±9 的可玩边界仍在画面内；桌面保持原机位与 55°。
   * 只在宽高比变化时执行（旋转 / 打开不同窗口）。
   */
  _fitViewport() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    const a = camera.aspect;
    if (Math.abs(a - this._lastAspect) < 0.01) return;
    this._lastAspect = a;

    const k = a < 1 ? 1.4 : 1.25; // 竖屏后退 40%、横屏/桌面后退 25%，换取横向视野
    camera.position.set(0, 16 * k, 16 * k);
    // 玩家球出生于 z=+12；相机沿原视线后退 25% 后，它在桌面/横屏下从「画面外」
    // 回到下方三分之一处，同时远端金币仍在视野内。
    camera.lookAt(0, 0, 0);

    const dist = 16 * k * Math.SQRT2;
    const need = 10; // 可玩边界 ±9 + 余量
    const tanV = need / (dist * Math.min(a, 1));
    const fov = THREE.MathUtils.clamp((2 * Math.atan(tanV) * 180) / Math.PI, 55, 88);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** 由基座 SceneManager 统一驱动；不自建 rAF、绝不调用 world.step() */
  update(deltaTime) {
    if (this._disposed) return;
    this._fitViewport();
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    this._time += dt;
    this._elapsed += dt;

    if (this._state === STATE.PLAYING) {
      this._timeLeft = Math.max(0, this._timeLeft - dt);
      if (this._timeLeft <= 0) this._endRound('时间到');
    }

    if (this._state === STATE.PLAYING) {
      this._applyMovement(dt);
      this._checkCollisions(dt); // 窄相已在 physics.step 中更新
    }
    if (this._state !== STATE.OVER) this._animateCoins(dt);
    this._sweepParticles(dt);

    this._hudAccumulator += dt;
    if (this._hudAccumulator >= 0.25) {
      this._hudAccumulator = 0;
      this._renderHUD();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 预热接口（仅供 main.js 固化基线使用）                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 【硬性约束】强制模拟「一次移动 + 吃一枚金币 + 生成粒子特效」。
   * 契约禁止项目调用 world.step()，因此不伪造物理帧，而是直接调用与运行时
   * 完全相同的 _applyMovement / _collectCoin / _hitObstacle 路径，
   * 让金币光晕、粒子、木箱闪色等全部材质在随后的 renderOnce() 中被上传。
   */
  warmUpMoveCollect() {
    if (this._disposed) return;
    this._setState(STATE.PLAYING);

    // ① 一次键盘移动
    this._keys.add('KeyW');
    this._applyMovement(0.1);
    this._keys.delete('KeyW');

    // ② 一次收集（走运行时同一路径：先移除刚体 → 计分 → 粒子）
    const coin = this._coins.find((c) => c.alive);
    if (coin) this._collectCoin(coin);

    // ③ 一次撞障碍（走运行时同一路径：扣分 → 闪色 → 粒子）
    if (this._obstacles.length > 0) this._hitObstacle(this._obstacles[0]);

    console.info(`[CoinPath:warmUp] 移动+收集+撞障碍完成，存活粒子=${this._particles.length}`);
  }

  /** 模拟一次粒子 TTL 到期回收，确保粒子生命周期路径也完整跑过一轮 */
  warmUpExpire() {
    if (this._disposed) return;
    this._sweepParticles(PARTICLE_TTL + 1);
    console.info(`[CoinPath:warmUp] 粒子 TTL 到期，剩余粒子=${this._particles.length}`);
  }

  /* ------------------------------------------------------------------------ */
  /* dispose —— 七步清理（M2/M3 标准 + M4 键盘前置解绑）                     */
  /* ------------------------------------------------------------------------ */

  _step(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[CoinPath] dispose 步骤「${label}」失败（继续后续清理）：`, err); }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* ---------- 步骤 -1：通用暂停菜单清理（解绑 ESC / 移除 DOM / 恢复运行） ---------- */
    try {
      this._pauseMenu?.dispose();
    } catch (err) {
      console.error('[CoinPath] 暂停菜单清理失败：', err);
    }
    this._pauseMenu = null;

    /* ---------- 步骤 0：相机恢复（最前段 + 独立 try/catch） ---------- */
    try {
      const camera = this._ctx?.camera;
      if (camera && this._cameraSaved) {
        camera.position.copy(this._cameraSaved.position);
        camera.quaternion.copy(this._cameraSaved.quaternion);
        camera.fov = this._cameraSaved.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      }
    } catch (err) {
      console.error('[CoinPath] dispose 步骤「相机恢复」失败（继续后续清理）：', err);
    }

    /* ---------- 步骤 1：【M4 硬性约束】键盘监听前段独立解绑 + _keys 置空 ----------
     * keydown / keyup 是 window 级监听，若残留会导致卸载后按键仍被响应、
     * 甚至影响后续项目。必须最先解绑并清空输入状态，且用独立 try/catch。
     */
    this._step('键盘与输入事件解绑 / _keys 置空', () => {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      this._removeListenersByTag('input'); // blur / visibilitychange / 全局 pointerup
      this._keys.clear();                  // ← 硬性约束：置空 _keys
      this._tapTarget = null;
      this._onGlobalPointerUp();           // 清虚拟按键态（内部只操作 DOM dataset）
    });

    /* ---------- 步骤 2：清除全部定时器 ---------- */
    this._step('定时器', () => {
      this._clearAllTimers();
      for (const p of this._particles) {
        if (p.timeoutId !== null) clearTimeout(p.timeoutId);
        p.timeoutId = null;
      }
    });

    /* ---------- 步骤 3：移除剩余 DOM 监听、UI 节点与 <style> ---------- */
    this._step('UI 与监听', () => {
      this._removeListenersByTag('ui');
      // 兜底：确保台账清空
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

    /* ---------- 步骤 4：物理刚体全量移除 ---------- */
    this._step('物理刚体', () => this._disposePhysics());

    /* ---------- 步骤 5：GPU 资源（几何 / 材质 / 纹理 + uniforms 扫描） ---------- */
    this._step('GPU 资源', () => this._disposeThreeResources());

    /* ---------- 步骤 6：台账与状态清空 ---------- */
    this._step('台账清空', () => {
      this.root.clear(); // 从 scene 移除由 AttractionManager 第 ③ 步负责
      this._coins.length = 0;
      this._obstacles.length = 0;
      this._particles.length = 0;
      this._standaloneColliders.length = 0;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
      this._shared = {};
      this._playerBody = null;
      this._playerCollider = null;
      this._playerGroup = null;
      this._cameraSaved = null;
      this._state = STATE.OVER;
      this._ctx = null;
    });

    console.info(
      `[CoinPath] dispose 完成 | _keys=${this._keys.size} _listeners=${this._listeners.length} ` +
      `刚体/定时器/DOM/相机/GPU资源 全部清理`
    );
  }

  _disposePhysics() {
    const world = this._ctx?.world;
    if (!world) {
      this._coins.length = 0;
      this._obstacles.length = 0;
      this._particles.length = 0;
      this._playerBody = null;
      return;
    }
    // ① 存活粒子
    for (const p of [...this._particles]) {
      if (p.body) { world.removeRigidBody(p.body); p.body = null; p.collider = null; }
    }
    // ② 未收集的金币
    for (const coin of this._coins) {
      if (coin.body) { world.removeRigidBody(coin.body); coin.body = null; coin.collider = null; }
    }
    // ③ 障碍
    for (const obs of this._obstacles) {
      if (obs.body) { world.removeRigidBody(obs.body); obs.body = null; obs.collider = null; }
    }
    // ④ 角色
    if (this._playerBody) { world.removeRigidBody(this._playerBody); this._playerBody = null; }
    this._playerCollider = null;
    // ⑤ 独立创建的 collider（本类当前为 0，保留以完整履行契约）
    for (const c of this._standaloneColliders) world.removeCollider(c, true);
    this._standaloneColliders.length = 0;
    console.info('[CoinPath] 物理刚体已全量 removeRigidBody（粒子/金币/障碍/角色）');
  }

  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);

    // traverse 兜底：防止漏登记的 mesh
    this.root.traverse((obj) => {
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      if (obj.geometry) geometries.add(obj.geometry);
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x && materials.add(x));
      else if (m) materials.add(m);
    });

    // 引用路径【不去重】；释放计划【Map 去重】
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
      catch (err) { console.error(`[CoinPath:纹理] uuid=${texture.uuid} dispose 失败：`, err); }
    }
    const cleared = [];
    for (const ref of refs) {
      try { ref.clear(); cleared.push(ref.path); }
      catch (err) { console.error(`[CoinPath:纹理] 断开引用 ${ref.path} 失败：`, err); }
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
      try { material.dispose(); } catch (err) { console.error('[CoinPath] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[CoinPath] 几何体 dispose 失败：', err); }
    }
    console.info(
      `[CoinPath] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} ` +
      `texture=${texturePlan.size} 引用路径=${cleared.length}`
    );
  }
}

export default CoinPath;
