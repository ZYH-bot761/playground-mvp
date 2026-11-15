/**
 * ============================================================================
 * PumpkinThrower —— 投掷类游乐项目「南瓜投手」（M3）
 * ============================================================================
 * 依据《游乐场 MVP 功能详细设计 v0.1》§3 项目 1 / §4 UI / §6.1：
 *   5 个上下浮动靶子（幽灵/木桶/星星）；点击投掷南瓜；小靶 1 分、
 *   中靶 3 分、大靶 5 分；30 秒倒计时；时间到自动结算，无失败；命中爆粒子。
 *
 * 【单文件闭环】场景、物理、粒子、UI（DOM + CSS）、状态机、计时、存档、
 *   资源清理全部在本类内实现；不 import、不修改 core/ 下任何基座模块。
 *
 * 【IAttraction 契约】init(ctx) / update(dt) / onInteract(hitInfo) / dispose()
 *   四方法齐全；dispose() 幂等；root 挂到 ctx.scene 并由 AttractionManager 移除。
 *
 * ---------------------------------------------------------------------------
 * 【编写前 API 复核结论 · Rapier 0.21.0】（硬性约束 1）
 *   - 指定查阅的 dist/rapier.d.ts 只有 3 行：
 *       import * as RAPIER from "./exports"; export * from "./exports";
 *       export default RAPIER;
 *     即纯 re-export barrel，未包含任何 intersectionPair 语义说明。
 *   - 继续追踪真实定义：
 *       dist/pipeline/world.d.ts:541        intersectionPair(c1, c2): boolean
 *       dist/geometry/narrow_phase.d.ts:44 同上
 *     注释仅写「Returns true if collider1 and collider2 intersect and
 *     at least one of them is a sensor」，没有定义命中/冲量语义。
 *   ⇒ 按约束采用【距离判定 + 扫掠线段】作为权威命中判定，
 *     完全不依赖 intersectionPair；靶子 collider 一律 setSensor(true)，
 *     从物理层面杜绝任何接触力 / 冲量传递。
 *
 * 【物理隔离硬约束】
 *   - 靶子刚体一律 RigidBodyDesc.fixed()（必须是 Fixed）；
 *   - 命中帧内第一动作就是 world.removeRigidBody(南瓜)，
 *     之后才计分、闪色、生成粒子（处理靶子）；
 *   - 靶子唯一位移来自本类按 Math.sin 主动 setTranslation 的视觉浮动，
 *     物理求解器不会对其施加任何冲量，linvel() 恒为 0（运行时有校验日志）。
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { IAttraction } from './IAttraction.js';
import PauseMenu from '../ui/PauseMenu.js';

/* ========================================================================== */
/* 常量配置                                                                    */
/* ========================================================================== */

/** 三态状态机 */
const STATE = Object.freeze({ READY: 'ready', PLAYING: 'playing', OVER: 'over' });

const ROUND_SECONDS = 30; // 单局 30 秒
const THROW_COOLDOWN = 0.5; // 投掷冷却（秒），防连点炸物理世界
const PARTICLES_PER_HIT = 6; // 设计稿要求 5~8 个
const PARTICLE_TTL = 0.8; // 粒子存活时长（秒）
const BEST_SCORE_KEY = 'playground.pumpkin-thrower.bestScore';

const LAUNCH_POINT = Object.freeze({ x: 0, y: -5, z: 10 }); // 屏幕下方固定发射点
const PUMPKIN_RADIUS = 0.32;
const GRAVITY = 9.81; // 与 PhysicsManager 的 world 重力 -9.81 对应
const FLIGHT_TIME = 0.85; // 抛物线解算用的固定飞行时长（秒）
const HIT_TOLERANCE = 0.12; // 命中判定容差

/** 手册 P6 碰撞组：membership 高 16 位 / filter 低 16 位。
 *  只保留「南瓜↔地面」「南瓜↔靶」两类配对；南瓜互撞、碎屑配对全部跳过窄相位。 */
const G_BIT = 1 << 0; // 地面
const T_BIT = 1 << 1; // 靶（sensor）
const P_BIT = 1 << 2; // 南瓜（dynamic）
const X_BIT = 1 << 3; // 碎屑（sensor，纯视觉）
const GROUP_GROUND_MEM = G_BIT << 16;
const FILTER_GROUND = P_BIT;
const GROUP_TARGET_MEM = T_BIT << 16;
const FILTER_TARGET = P_BIT;
const GROUP_PUMPKIN_MEM = P_BIT << 16;
const FILTER_PUMPKIN = G_BIT | T_BIT;
const GROUP_PARTICLE_MEM = X_BIT << 16;
const FILTER_PARTICLE = 0;

const MAX_PUMPKINS = 10; // 存活南瓜上限（边界保护）
const MAX_PARTICLES = 60; // 存活粒子上限（边界保护）
const PUMPKIN_MAX_AGE = 8; // 南瓜最长存活（秒）
const BODY_LIMIT_Y = -20; // y < -20 立即回收
const BODY_LIMIT_XZ = 60; // |x| / |z| > 60 立即回收
const BODY_LIMIT_Z_NEG = -80; // z < -80 立即回收

/** 5 个靶子：x / 基准 y / 半径 / 分值 / 造型（详细设计 §6.1 分值=[1,3,5]） */
const TARGET_LAYOUT = Object.freeze([
  { x: -6.0, y: 2.2, z: 0, radius: 0.55, score: 1, kind: 'ghost' },
  { x: -3.0, y: 3.0, z: 0, radius: 0.55, score: 1, kind: 'barrel' },
  { x: 0.0, y: 2.0, z: 0, radius: 0.8, score: 3, kind: 'ghost' },
  { x: 3.0, y: 3.0, z: 0, radius: 0.8, score: 3, kind: 'barrel' },
  { x: 6.0, y: 2.4, z: 0, radius: 1.1, score: 5, kind: 'star' },
]);

/* ========================================================================== */
/* 模块级无副作用工具函数                                                      */
/* ========================================================================== */

/** 生成一张程序化 DataTexture（PRD 附录 A：优先程序化生成，零成本） */
function makeCheckerTexture(name, colorA, colorB, size = 8) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const c = (x + y) % 2 === 0 ? colorA : colorB;
      const i = (y * size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
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
 * 点到线段的最短距离平方（纯数值，避免每帧分配 Vector3）。
 * 用「上一帧位置 → 当前帧位置」的扫掠线段，防止高速南瓜穿透靶子。
 */
function pointSegmentDistanceSq(px, py, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const lenSq = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (lenSq > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  const cz = az + t * dz - pz;
  return cx * cx + cy * cy + cz * cz;
}

/**
 * 递归扫描一个值，把其中所有 THREE.Texture 记录成「可断开的引用路径」。
 * 与 M2 修复一致：释放计划（Map 去重）与引用路径（数组【不去重】）必须分离，
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

/** 星星靶子的 ShaderMaterial：故意让一张纹理【只存在 uniforms 里】，验证清理路径 */
const STAR_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const STAR_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec3 uTint;
  varying vec2 vUv;
  void main() {
    vec4 texel = texture2D(uTex, vUv);
    gl_FragColor = vec4(texel.rgb * uTint, 1.0);
  }
`;

/** 悬浮 UI 的样式（类内注入 <style>，dispose 时移除） */
const UI_CSS = `
.pt-ui{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#eef3ff}
.pt-hud{position:absolute;top:calc(14px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
  display:flex;gap:18px;padding:9px 18px;border-radius:999px;
  background:rgba(12,18,34,.82);border:1px solid rgba(150,180,255,.3);
  box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:15px;letter-spacing:.5px;white-space:nowrap}
.pt-hud b{color:#ffc247;font-size:18px}
.pt-hud[data-hidden='true']{display:none}
.pt-shade{position:absolute;inset:0;background:rgba(6,10,22,.55)}
.pt-panel{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  pointer-events:auto;width:min(420px,calc(100vw - 32px));padding:24px 26px 20px;
  max-height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  background:rgba(14,20,38,.95);border:1px solid rgba(150,180,255,.35);
  border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.55);text-align:center}
.pt-panel[data-hidden='true'],.pt-shade[data-hidden='true']{display:none}
.pt-panel__title{margin:0 0 10px;font-size:26px;font-weight:700;color:#ffd27a}
.pt-panel__desc{margin:0 0 8px;font-size:14px;line-height:1.6;color:#c8d6f5}
.pt-panel__hint{margin:0 0 14px;font-size:12px;line-height:1.7;color:#8fa4cf}
.pt-panel__score{margin:0 0 16px;padding:12px;border-radius:10px;
  background:rgba(120,160,255,.12);font-size:15px;line-height:1.9}
.pt-panel__score[data-hidden='true']{display:none}
.pt-panel__score b{color:#ffc247;font-size:20px}
.pt-panel__buttons{display:flex;gap:10px;justify-content:center;margin-bottom:12px}
.pt-btn{flex:1;padding:10px 12px;font-size:14px;border-radius:9px;cursor:pointer;
  color:#dbe6ff;background:rgba(255,255,255,.08);border:1px solid rgba(160,190,255,.4);
  transition:background .15s,border-color .15s}
.pt-btn:hover{background:rgba(140,180,255,.22);border-color:rgba(190,215,255,.7)}
.pt-btn--primary{color:#10162a;font-weight:700;background:#ffc247;border-color:#ffc247}
.pt-btn--primary:hover{background:#ffd473;border-color:#ffd473}
.pt-btn[data-hidden='true']{display:none}
.pt-btn--exit{color:#ffe9b0;background:rgba(255,200,90,.14);border-color:rgba(255,200,90,.55)}
.pt-panel__note{margin:0;font-size:11px;line-height:1.6;color:#7f92b8}
@media (max-width:560px){
  .pt-hud{top:calc(8px + env(safe-area-inset-top, 0px));gap:8px;font-size:12px;padding:6px 12px;
    max-width:calc(100vw - 112px);flex-wrap:wrap;justify-content:center;
    white-space:normal;line-height:1.4}
  .pt-hud b{font-size:14px}
  .pt-panel{padding:18px 18px 16px}
  .pt-panel__title{font-size:22px}
  .pt-panel__buttons{flex-direction:column}
  .pt-btn{min-height:44px;font-size:15px}
}
@media (max-height:520px){
  .pt-panel{padding:16px 20px 14px;max-height:calc(100dvh - 20px)}
  .pt-panel__title{font-size:20px;margin-bottom:6px}
  .pt-panel__hint{display:none}
}
`;

/* ========================================================================== */
/* 项目实现                                                                    */
/* ========================================================================== */

export class PumpkinThrower extends IAttraction {
  constructor() {
    super();

    /** 项目根节点：交给 ctx.scene，由 AttractionManager 卸载时移除 */
    this.root = new THREE.Group();
    this.root.name = 'PumpkinThrower';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;
    this._state = STATE.READY;

    // ---- 时钟与状态 ----
    this._time = 0; // 用于 Math.sin 浮动的总时钟
    this._elapsed = 0; // 单调时钟，用于投掷冷却
    this._lastThrowAt = -Infinity;
    this._timeLeft = ROUND_SECONDS;
    this._score = 0;
    this._bestScore = 0;
    this._hudAccumulator = 0;

    // ---- 相机接管（dispose 最前段恢复）----
    this._cameraSaved = null;
    this._lastAspect = 0; // 视口自适应：记录上次宽高比，避免每帧重算

    // ---- 物理台账（Rapier 句柄移除不幂等，只由本类 dispose 负责）----
    this._targets = [];
    this._pumpkins = [];
    this._particles = [];
    this._groundBody = null;
    this._standaloneColliders = [];

    // ---- Three 资源台账（Set 去重；登记到 registry 作二次兜底）----
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

    // ---- 交互辅助 ----
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._aimPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z = 0
    this._aimPoint = new THREE.Vector3();
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 创建场景、物理刚体、共享资源池与 DOM UI，并进入准备态。
   * @param {Object} ctx IAttraction 契约上下文
   */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera, RAPIER, world } = ctx;
    if (!RAPIER || !world) {
      throw new Error('[PumpkinThrower] 缺少已初始化的 Rapier 世界');
    }
    const register = typeof ctx.registerDisposable === 'function'
      ? ctx.registerDisposable
      : () => {};

    /* ---------- ① 接管相机（不改 core，只改 ctx.camera 的运行时状态） ---------- */
    // 基座机位 (0,2,7) 会让发射点 (0,-5,10) 落在相机身后；
    // 临时切到 (0,0,22) 看向原点，使发射点位于画面下缘、5 靶横向可见。
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
    };
    camera.position.set(0, 0, 22);
    camera.lookAt(0, 0, 0);
    this._fitViewport();

    /* ---------- 关键：把项目根节点挂到场景 ----------
     * 不挂就永远不会被 renderer.render() 遍历，几何/材质/纹理不会上传，
     * 画面空白，且资源计数恒等于基线（会造成「假通过」的归零误判）。
     * 卸载时由 AttractionManager 第 ③ 步 scene.remove(root)，本类不自行移除。
     */
    scene.add(this.root);

    /* ---------- ② 共享资源池：几何/材质只创建一次，投掷次数不增长计数 ---------- */
    const geoUnitSphere = this._trackGeometry(new THREE.SphereGeometry(1, 16, 12));
    const geoUnitCylinder = this._trackGeometry(new THREE.CylinderGeometry(1, 1, 1, 10));
    const geoOcta = this._trackGeometry(new THREE.OctahedronGeometry(1, 0));
    const geoBox = this._trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    const geoPlane = this._trackGeometry(new THREE.PlaneGeometry(40, 24));
    const geoStem = this._trackGeometry(new THREE.CylinderGeometry(0.05, 0.07, 1, 6));

    const texPumpkin = this._trackTexture(makeCheckerTexture('pt/pumpkin', [255, 150, 40, 255], [225, 100, 20, 255]));
    const texStar = this._trackTexture(makeCheckerTexture('pt/star', [255, 235, 130, 255], [255, 190, 60, 255]));
    const texGround = this._trackTexture(makeCheckerTexture('pt/ground', [96, 124, 98, 255], [74, 100, 84, 255]));
    texPumpkin.colorSpace = THREE.SRGBColorSpace;
    texStar.colorSpace = THREE.SRGBColorSpace;
    texGround.colorSpace = THREE.SRGBColorSpace;

    const matPumpkin = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texPumpkin, roughness: 0.62, metalness: 0.04,
      emissive: 0x2a1500, emissiveIntensity: 0.11,
    }));
    const matStem = this._trackMaterial(new THREE.MeshStandardMaterial({ color: 0x3f6b32, roughness: 0.9 }));
    const matEye = this._trackMaterial(new THREE.MeshStandardMaterial({ color: 0x20223a, roughness: 0.8 }));
    const matBarrel = this._trackMaterial(new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.85 }));
    const matBand = this._trackMaterial(new THREE.MeshStandardMaterial({ color: 0x4d3a24, roughness: 0.8 }));
    const matParticleA = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffb43c, emissive: 0x592600, roughness: 0.5,
    }));
    const matParticleB = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffe08a, emissive: 0x4a3200, roughness: 0.5,
    }));
    const matGround = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texGround, roughness: 1, metalness: 0,
    }));

    this._shared = {
      geoUnitSphere, geoUnitCylinder, geoOcta, geoBox, geoPlane, geoStem,
      matPumpkin, matStem, matEye, matBarrel, matBand, matGround,
      matParticles: [matParticleA, matParticleB],
      texStar,
    };

    // Three 资源登记到 registry：dispose() 之外的第二道安全网。
    // THREE 的 dispose 幂等，双重释放安全；Rapier 句柄绝不登记。
    for (const geo of this._geometries) register(geo);
    for (const mat of this._materials) register(mat);
    for (const tex of this._textures) register(tex);

    /* ---------- ③ 地面：让 restitution 有可见的弹跳对象 ---------- */
    const groundMesh = new THREE.Mesh(geoPlane, matGround);
    groundMesh.name = 'PumpkinThrower/ground';
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.set(0, -8, 0);
    this.root.add(groundMesh);
    const groundDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -8, 0);
    this._groundBody = world.createRigidBody(groundDesc);
    const groundCollider = RAPIER.ColliderDesc.cuboid(20, 0.5, 12).setRestitution(0.5)
      .setCollisionGroups(GROUP_GROUND_MEM | FILTER_GROUND);
    world.createCollider(groundCollider, this._groundBody);

    /* ---------- ④ 5 个靶子：Fixed 刚体 + sensor collider（零冲量） ---------- */
    this._buildTargets(ctx);

    /* ---------- ⑤ DOM UI ---------- */
    this._buildUI();
    this._pauseMenu = new PauseMenu({
      onRestart: () => this._startRound(),
      onExit: () => {
        this._pauseMenu?.dispose();
        this._ctx?.onExitAttraction?.();
      },
    }).attach();
    this._bestScore = this._readBestScore();
    this._setState(STATE.READY);

    // HUD 刷新定时器（真实用途，ID 登记）
    this._addInterval(() => this._renderHUD(), 100);

    console.info('[PumpkinThrower] init 完成 | 靶子=5 Fixed | 准备态 | 退出请用左上角卸载按钮');
  }

  /** 资源台账登记助手 */
  _trackGeometry(geo) { this._geometries.add(geo); return geo; }
  _trackMaterial(mat) { this._materials.add(mat); return mat; }
  _trackTexture(tex) { this._textures.add(tex); return tex; }

  /**
   * 构建 5 个靶子。
   * 【硬约束】每个靶子都是 RigidBodyDesc.fixed()，collider 设 sensor(true)：
   * 物理求解器不会在南瓜与靶子之间产生任何接触力/冲量，靶子永不被撞飞。
   * 靶子位移只来自 _animateTargets() 主动 setTranslation 的正弦视觉浮动。
   */
  _buildTargets(ctx) {
    const { RAPIER, world } = ctx;
    const S = this._shared;

    TARGET_LAYOUT.forEach((layout, index) => {
      const group = new THREE.Group();
      group.name = `PumpkinThrower/target-${index}-${layout.kind}`;
      group.position.set(layout.x, layout.y, layout.z);

      let material;
      if (layout.kind === 'star') {
        // 这张 texStar 只挂在 ShaderMaterial.uniforms.uTex.value 上，
        // 专门用来验证 dispose 的 uniforms 深度扫描（IAttraction 契约最高风险项）。
        material = this._trackMaterial(new THREE.ShaderMaterial({
          uniforms: {
            uTex: { value: S.texStar },
            uTint: { value: new THREE.Color(0xffffff) },
          },
          vertexShader: STAR_VERTEX_SHADER,
          fragmentShader: STAR_FRAGMENT_SHADER,
          // 显式参与色调映射标记，避免与 ACES 的全局 tonemapping 语义冲突
          toneMapped: true,
        }));
        const star = new THREE.Mesh(S.geoOcta, material);
        star.name = 'star-body';
        star.scale.setScalar(layout.radius);
        group.add(star);
      } else if (layout.kind === 'barrel') {
        material = this._trackMaterial(S.matBarrel.clone());
        const body = new THREE.Mesh(S.geoUnitCylinder, material);
        body.name = 'barrel-body';
        body.scale.set(layout.radius, layout.radius * 1.5, layout.radius);
        group.add(body);
        const band = new THREE.Mesh(S.geoUnitCylinder, S.matBand);
        band.name = 'barrel-band';
        band.scale.set(layout.radius * 1.06, layout.radius * 0.18, layout.radius * 1.06);
        group.add(band);
      } else {
        // 幽灵：白色球体 + 两只眼睛（简单几何组合）
        material = this._trackMaterial(new THREE.MeshStandardMaterial({
          color: 0xf2f6ff, roughness: 0.7, emissive: 0x26365c, emissiveIntensity: 0.23,
        }));
        const body = new THREE.Mesh(S.geoUnitSphere, material);
        body.name = 'ghost-body';
        body.scale.setScalar(layout.radius);
        group.add(body);
        for (const dx of [-0.32, 0.32]) {
          const eye = new THREE.Mesh(S.geoUnitSphere, S.matEye);
          eye.name = 'ghost-eye';
          eye.scale.setScalar(layout.radius * 0.13);
          eye.position.set(dx * layout.radius, layout.radius * 0.18, layout.radius * 0.9);
          group.add(eye);
        }
      }

      this.root.add(group);

      // Fixed 刚体（硬性约束），collider 为 sensor → 无冲量
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(layout.x, layout.y, layout.z);
      const rigidBody = world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.ball(layout.radius).setSensor(true)
        .setCollisionGroups(GROUP_TARGET_MEM | FILTER_TARGET);
      const collider = world.createCollider(colliderDesc, rigidBody);

      this._targets.push({
        group, rigidBody, collider, material, layout,
        baseY: layout.y,
        phase: index * 1.17,
        bobAmp: 0.28 + index * 0.04,
        bobSpeed: 1.1 + index * 0.13,
        flash: 0,
      });
    });
  }

  /* ------------------------------------------------------------------------ */
  /* 定时器 / DOM 登记助手                                                     */
  /* ------------------------------------------------------------------------ */

  _addInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this._intervalIds.add(id);
    return id;
  }

  _addTimeout(fn, ms) {
    const id = setTimeout(() => {
      this._timeoutIds.delete(id);
      if (this._disposed) return;
      // 【审查修复】ESC 暂停时 SceneManager 只冻结 attractions.update(dt)，
      // 浏览器 setTimeout 仍会触发；粒子 TTL 兜底若在此执行会调用
      // world.removeRigidBody()，等于在冻结期异步改动物理世界。
      // 直接丢弃该兜底回调：粒子 age 由 dt 驱动（同样被冻结），恢复后
      // _sweepParticles() 会按 TTL 正常回收，语义一致且无残留。
      if (this._ctx?.isPaused?.()) return;
      fn();
    }, ms);
    this._timeoutIds.add(id);
    return id;
  }

  _addRaf(fn) {
    const id = requestAnimationFrame(() => {
      this._rafIds.delete(id);
      fn();
    });
    this._rafIds.add(id);
    return id;
  }

  _addListener(target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push({ target, type, fn });
  }

  /** 统一清理全部定时器（硬性约束：ID 全部登记、全部清除） */
  _clearAllTimers() {
    for (const id of this._rafIds) cancelAnimationFrame(id);
    for (const id of this._intervalIds) clearInterval(id);
    for (const id of this._timeoutIds) clearTimeout(id);
    this._rafIds.clear();
    this._intervalIds.clear();
    this._timeoutIds.clear();
  }

  /* ------------------------------------------------------------------------ */
  /* UI（DOM Overlay，绝不使用 CSS2DRenderer）                                 */
  /* ------------------------------------------------------------------------ */

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'pt-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'pt-ui';
    this._uiRoot.innerHTML = `
      <div class="pt-hud" data-pt-interactive data-role="hud">
        <span>剩余时间 <b data-role="time">30</b> s</span>
        <span>得分 <b data-role="score">0</b></span>
      </div>
      <div class="pt-shade" data-role="shade"></div>
      <div class="pt-panel" data-pt-interactive data-role="panel">
        <div class="pt-panel__title" data-role="title">南瓜投手</div>
        <p class="pt-panel__desc" data-role="desc"></p>
        <p class="pt-panel__hint">点击场景任意位置投掷南瓜；小靶 1 分 / 中靶 3 分 / 大靶 5 分，30 秒内尽量拿高分。</p>
        <div class="pt-panel__score" data-role="score-block"></div>
        <div class="pt-panel__buttons">
          <button type="button" class="pt-btn pt-btn--primary" data-action="start" data-role="primary">开始</button>
          <button type="button" class="pt-btn" data-action="restart">重新开始</button>
        </div>
        <div class="pt-panel__buttons">
          <button type="button" class="pt-btn pt-btn--exit" data-action="exit" data-role="exit" data-hidden="true">🎠 返回游乐场</button>
        </div>
        <p class="pt-panel__note">退出本项目请使用左上角卸载按钮；结算后也可点「🎠 返回游乐场」回到大厅。</p>
      </div>
    `;
    document.body.appendChild(this._uiRoot);

    const q = (role) => this._uiRoot.querySelector(`[data-role="${role}"]`);
    this._ui = {
      hud: q('hud'), shade: q('shade'), panel: q('panel'),
      title: q('title'), desc: q('desc'), scoreBlock: q('score-block'),
      time: q('time'), score: q('score'), primary: q('primary'), exit: q('exit'),
    };

    // 单一事件委托监听器，登记后统一解绑
    this._addListener(this._uiRoot, 'click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || !this._uiRoot.contains(button)) return;
      if (button.dataset.action === 'start') this._startRound();
      if (button.dataset.action === 'restart') this._resetToReady();
      if (button.dataset.action === 'exit') {
        // M5a：由基座注入的回调切回 Lobby（大厅会从 _lobbyMemory 恢复位置）
        const fn = this._ctx?.onExitAttraction;
        if (typeof fn === 'function') fn();
        else console.warn('[PumpkinThrower] 缺少 ctx.onExitAttraction，无法返回游乐场');
      }
    });
  }

  /** 判断落点是否压在 UI 上（HUD / 面板），防止 UI 点击触发投掷 */
  _isPointerOverUI(event) {
    if (!this._uiRoot || !event) return false;
    const nodes = this._uiRoot.querySelectorAll('[data-pt-interactive]');
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
  }

  /** 状态机驱动的面板渲染 */
  _setState(next) {
    this._state = next;
    if (this._disposed || !this._ui.panel) return;
    const playing = next === STATE.PLAYING;
    this._ui.panel.dataset.hidden = String(playing);
    this._ui.shade.dataset.hidden = String(playing);
    this._ui.hud.dataset.hidden = String(next === STATE.READY);
    // M5a：「🎠 返回游乐场」只在结算态出现
    if (this._ui.exit) this._ui.exit.dataset.hidden = String(next !== STATE.OVER);

    if (next === STATE.READY) {
      this._ui.title.textContent = '南瓜投手';
      this._ui.desc.textContent = '点击瞄准点投掷南瓜，命中漂浮的靶子得分。30 秒一局，看看能拿多少分。';
      this._ui.primary.textContent = '开始';
      this._ui.scoreBlock.dataset.hidden = 'true';
    } else if (next === STATE.OVER) {
      this._ui.title.textContent = '本局结束';
      this._ui.desc.textContent = '时间到！可以再来一局挑战最高分。';
      this._ui.primary.textContent = '再玩一次';
      this._ui.scoreBlock.dataset.hidden = 'false';
      this._ui.scoreBlock.innerHTML =
        `本局得分 <b>${this._score}</b><br>历史最高分 <b>${this._bestScore}</b>`;
    }
    this._renderHUD();
  }

  _startRound() {
    if (this._disposed) return;
    this._score = 0;
    this._timeLeft = ROUND_SECONDS;
    this._lastThrowAt = -Infinity;
    this._clearLiveEntities();
    this._setState(STATE.PLAYING);
    console.info('[PumpkinThrower] 开局：30 秒');
  }

  /** 「重新开始」= 清空本局状态并回到准备态（不卸载项目，出口在左上角） */
  _resetToReady() {
    if (this._disposed) return;
    this._score = 0;
    this._timeLeft = ROUND_SECONDS;
    this._lastThrowAt = -Infinity;
    this._clearLiveEntities();
    this._setState(STATE.READY);
    console.info('[PumpkinThrower] 已重新开始（回到准备态）');
  }

  _endRound() {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    this._timeLeft = 0;
    // 时间到：暂停逻辑，清空所有存活南瓜 / 粒子及其刚体，靶子停止浮动
    this._clearLiveEntities();
    if (this._score > this._bestScore) {
      this._bestScore = this._score;
      this._writeBestScore(this._bestScore);
    }
    this._setState(STATE.OVER);
    console.info(`[PumpkinThrower] 结算：本局 ${this._score} 分 / 最高 ${this._bestScore} 分`);
  }

  _readBestScore() {
    try {
      const raw = window.localStorage.getItem(BEST_SCORE_KEY);
      const n = Number.parseInt(raw ?? '0', 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0; // 隐私模式 / 禁用 storage 时静默降级
    }
  }

  _writeBestScore(value) {
    try {
      window.localStorage.setItem(BEST_SCORE_KEY, String(value));
    } catch {
      // 写入失败不影响游玩
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 投掷 / 命中 / 粒子                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * 从固定发射点抛出一粒南瓜。速度按「重力补偿的抛物线」解算：
   *   x/z 匀速，y 满足 y(T) = y0 + vy·T − ½g·T² = aim.y
   * 其中 T = FLIGHT_TIME 固定，保证手感一致。
   * @param {THREE.Vector3} aim 瞄准点（射线与 z=0 平面交点）
   * @returns {Object} 南瓜记录
   */
  _throwPumpkin(aim) {
    const { RAPIER, world } = this._ctx;
    const S = this._shared;

    const tx = THREE.MathUtils.clamp(aim.x, -10, 10);
    const ty = THREE.MathUtils.clamp(aim.y, -2, 8);
    const tz = 0;
    const T = FLIGHT_TIME;
    const vx = (tx - LAUNCH_POINT.x) / T;
    const vy = (ty - LAUNCH_POINT.y + 0.5 * GRAVITY * T * T) / T;
    const vz = (tz - LAUNCH_POINT.z) / T;

    // Dynamic 刚体：受重力、开 CCD 防穿透、轻微线性阻尼
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(LAUNCH_POINT.x, LAUNCH_POINT.y, LAUNCH_POINT.z)
      .setLinvel(vx, vy, vz)
      .setCcdEnabled(true)
      .setLinearDamping(0.08);
    const body = world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.ball(PUMPKIN_RADIUS)
      .setRestitution(0.55)
      .setDensity(1.1)
      .setCollisionGroups(GROUP_PUMPKIN_MEM | FILTER_PUMPKIN);
    const collider = world.createCollider(colliderDesc, body);

    // 视觉：共享单位球 + 共享南瓜材质 + 共享瓜蒂（不新建 geometry/material）
    const mesh = new THREE.Mesh(S.geoUnitSphere, S.matPumpkin);
    mesh.name = 'PumpkinThrower/pumpkin';
    mesh.scale.setScalar(PUMPKIN_RADIUS);
    const stem = new THREE.Mesh(S.geoStem, S.matStem);
    stem.name = 'pumpkin-stem';
    stem.scale.set(1, 0.18 / PUMPKIN_RADIUS, 1);
    stem.position.y = 1.08;
    mesh.add(stem);
    mesh.position.set(LAUNCH_POINT.x, LAUNCH_POINT.y, LAUNCH_POINT.z);
    this.root.add(mesh);

    const record = {
      mesh, body, collider, age: 0,
      prev: new THREE.Vector3(LAUNCH_POINT.x, LAUNCH_POINT.y, LAUNCH_POINT.z),
    };
    this._pumpkins.push(record);
    this._lastThrowAt = this._elapsed;
    return record;
  }

  /**
   * 【硬性约束 1】命中帧处理顺序不可调整：
   *   ① 先从物理世界移除南瓜刚体（_removePumpkin 内第一句即 removeRigidBody）
   *   ② 之后才「处理靶子」：计分、闪色、在碰撞点生成粒子
   * 靶子 collider 为 sensor 且刚体 Fixed，全程零冲量；linvel 运行时校验为 0。
   */
  _resolveHit(pumpkin, target) {
    // ① 先移除南瓜（物理 + 视觉）
    this._removePumpkin(pumpkin, 'hit');

    // ② 再处理靶子
    this._score += target.layout.score;
    target.flash = 1;
    const p = target.rigidBody.translation();
    this._spawnParticles(p.x, p.y, p.z);

    const v = target.rigidBody.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed > 1e-6) {
      console.warn(`[PumpkinThrower] 异常：靶子出现物理速度 ${speed}，应恒为 0`);
    }
    console.info(
      `[PumpkinThrower] 命中 ${target.layout.kind} +${target.layout.score} 分 | ` +
      `南瓜刚体已先移除 | 靶子 linvel=${speed.toFixed(6)}（Fixed，恒定不动）`
    );
    this._renderHUD();
  }

  /** 距离 + 扫掠线段命中判定（不依赖 intersectionPair 的 sensor 语义） */
  _detectHit(pumpkin) {
    const cur = pumpkin.body.translation();
    const prev = pumpkin.prev;
    for (const target of this._targets) {
      const c = target.rigidBody.translation();
      const dSq = pointSegmentDistanceSq(
        c.x, c.y, c.z,
        prev.x, prev.y, prev.z,
        cur.x, cur.y, cur.z
      );
      const r = target.layout.radius + PUMPKIN_RADIUS + HIT_TOLERANCE;
      if (dSq <= r * r) return target;
    }
    return null;
  }

  /** 命中点生成 5~8 个碎片：Dynamic 刚体 + sensor 小立方 + 共享几何/材质 */
  _spawnParticles(x, y, z) {
    const { RAPIER, world } = this._ctx;
    const S = this._shared;
    for (let i = 0; i < PARTICLES_PER_HIT; i += 1) {
      if (this._particles.length >= MAX_PARTICLES) {
        this._removeParticle(this._particles[0], 'cap');
      }
      const dirX = (Math.random() - 0.5) * 7;
      const dirY = 2 + Math.random() * 5;
      const dirZ = (Math.random() - 0.5) * 7;

      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinvel(dirX, dirY, dirZ)
        .setLinearDamping(0.35);
      const body = world.createRigidBody(bodyDesc);
      // sensor：粒子不与其他物体产生接触力，杜绝任何冲量传递；
      // filter=0 进一步跳过全部窄相位配对（纯视觉碎屑，只积分重力）
      const colliderDesc = RAPIER.ColliderDesc.cuboid(0.08, 0.08, 0.08).setSensor(true)
        .setCollisionGroups(GROUP_PARTICLE_MEM | FILTER_PARTICLE);
      const collider = world.createCollider(colliderDesc, body);

      const mesh = new THREE.Mesh(S.geoBox, S.matParticles[i % S.matParticles.length]);
      mesh.name = 'PumpkinThrower/particle';
      mesh.scale.setScalar(0.16 + Math.random() * 0.12);
      mesh.position.set(x, y, z);
      this.root.add(mesh);

      const particle = { mesh, body, collider, age: 0, timeoutId: null };
      // TTL 兜底：即使 update 停摆（例如后台标签页），setTimeout 也会回收
      particle.timeoutId = this._addTimeout(
        () => this._removeParticle(particle, 'timeout'),
        PARTICLE_TTL * 1000 + 80
      );
      this._particles.push(particle);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 实体回收（边界保护 + 粒子 TTL）                                           */
  /* ------------------------------------------------------------------------ */

  _removePumpkin(pumpkin, reason) {
    // 【硬性约束】命中/越界回收时，第一动作就是从物理世界移除刚体
    const world = this._ctx?.world;
    if (pumpkin.body) {
      try {
        world?.removeRigidBody(pumpkin.body); // 级联删除挂载 collider，绝不重复 removeCollider
      } catch (err) {
        console.error(`[PumpkinThrower] 移除南瓜刚体失败(${reason})：`, err);
      }
      pumpkin.body = null;
      pumpkin.collider = null;
    }
    if (pumpkin.mesh) {
      pumpkin.mesh.removeFromParent();
      pumpkin.mesh.clear();
      pumpkin.mesh = null;
    }
    const i = this._pumpkins.indexOf(pumpkin);
    if (i >= 0) this._pumpkins.splice(i, 1);
  }

  _removeParticle(particle, reason) {
    if (particle.timeoutId !== null) {
      clearTimeout(particle.timeoutId);
      this._timeoutIds.delete(particle.timeoutId);
      particle.timeoutId = null;
    }
    const world = this._ctx?.world;
    if (particle.body) {
      try {
        world?.removeRigidBody(particle.body);
      } catch (err) {
        console.error(`[PumpkinThrower] 移除粒子刚体失败(${reason})：`, err);
      }
      particle.body = null;
      particle.collider = null;
    }
    if (particle.mesh) {
      particle.mesh.removeFromParent();
      particle.mesh = null;
    }
    const i = this._particles.indexOf(particle);
    if (i >= 0) this._particles.splice(i, 1);
  }

  /** 清空所有存活南瓜与粒子（开局、结算、卸载共用） */
  _clearLiveEntities() {
    for (const p of [...this._pumpkins]) this._removePumpkin(p, 'clear');
    for (const p of [...this._particles]) this._removeParticle(p, 'clear');
    this._pumpkins.length = 0;
    this._particles.length = 0;
  }

  /** 边界保护 + 粒子 TTL 到期回收（每帧执行） */
  _sweepEntities(dt) {
    for (const pumpkin of [...this._pumpkins]) {
      pumpkin.age += dt;
      const p = pumpkin.body?.translation();
      if (!p) { this._removePumpkin(pumpkin, 'no-body'); continue; }
      const out =
        p.y < BODY_LIMIT_Y ||
        Math.abs(p.x) > BODY_LIMIT_XZ ||
        Math.abs(p.z) > BODY_LIMIT_XZ ||
        p.z < BODY_LIMIT_Z_NEG ||
        pumpkin.age > PUMPKIN_MAX_AGE;
      if (out) {
        this._removePumpkin(pumpkin, 'boundary');
        continue;
      }
      pumpkin.mesh?.position.set(p.x, p.y, p.z);
      pumpkin.prev.set(p.x, p.y, p.z);
    }
    for (const particle of [...this._particles]) {
      particle.age += dt;
      if (particle.age >= PARTICLE_TTL) {
        this._removeParticle(particle, 'ttl');
        continue;
      }
      const p = particle.body?.translation();
      if (p && particle.mesh) {
        particle.mesh.position.set(p.x, p.y, p.z);
        particle.mesh.rotation.x += dt * 4;
        particle.mesh.rotation.y += dt * 6;
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* onInteract                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * 响应 InteractionManager 分发的点击。
   * 三道闸门：① 点在画布游戏区域而非 UI；② PLAYING 态；③ 0.5s 冷却 + 存活上限。
   * 之后自建 Raycaster 与 z=0 平面求交得到瞄准点，再抛南瓜。
   * @param {Object} hitInfo 来自 InteractionManager 的拾取信息
   */
  onInteract(hitInfo) {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    const event = hitInfo?.event;
    const canvas = this._ctx?.renderer?.domElement;
    if (!event || !canvas || event.target !== canvas) return; // 不是画布 → 忽略
    if (this._isPointerOverUI(event)) return; // 压在 HUD/面板上 → 忽略
    if (this._elapsed - this._lastThrowAt < THROW_COOLDOWN) return; // 冷却
    if (this._pumpkins.length >= MAX_PUMPKINS) return;

    // 先射线检测：屏幕坐标 → NDC → 与 z=0 平面求交
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this._ctx.camera);
    if (!this._raycaster.ray.intersectPlane(this._aimPlane, this._aimPoint)) return;

    this._throwPumpkin(this._aimPoint);
  }

  /* ------------------------------------------------------------------------ */
  /* update                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * 视口自适应：竖屏时相机后退 25% + 适度放宽 fov，保证最外侧靶（x=±6，半径 1.1）连同光晕完整入画；
   * 桌面（宽高比 ≥1）保持 55° 与 z=22 原机位。只在宽高比变化时执行。
   */
  _fitViewport() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    const a = camera.aspect;
    if (Math.abs(a - this._lastAspect) < 0.01) return;
    this._lastAspect = a;

    const k = a < 1 ? 1.25 : 1; // 竖屏后退换视野
    camera.position.set(0, 0, 22 * k);
    // 竖屏时视线略微下压：靶行从画面正中上移到上三分之一处，
    // 下方留出南瓜抛物线与地面的可视空间，上下留白更平衡。
    camera.lookAt(0, a < 1 ? -1.2 : 0, 0);

    const dist = 22 * k; // 相机到靶面距离（跟随实际机位，避免死分支）
    const need = 8; // 最外侧靶 7.1 + 光晕余量
    const tanV = need / (dist * Math.min(a, 1));
    const fov = THREE.MathUtils.clamp((2 * Math.atan(tanV) * 180) / Math.PI, 55, 88);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  }

  /** 由基座 SceneManager 统一驱动；本类【不自建 rAF 循环】、绝不调用 world.step() */
  update(deltaTime) {
    if (this._disposed) return;
    this._fitViewport();
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    this._time += dt;
    this._elapsed += dt;

    if (this._state === STATE.PLAYING) {
      this._timeLeft = Math.max(0, this._timeLeft - dt);
      if (this._timeLeft <= 0) this._endRound();
    }

    // 靶子浮动：结算态停止；位移仅由本类主动 setTranslation，物理不改变它
    if (this._state !== STATE.OVER) this._animateTargets(dt);

    // 命中检测必须在物理步进之后（PhysicsManager.step 已在基座循环里先执行）
    if (this._state === STATE.PLAYING) {
      for (const pumpkin of [...this._pumpkins]) {
        const target = this._detectHit(pumpkin);
        if (target) this._resolveHit(pumpkin, target); // 内部先移除南瓜刚体
      }
    }

    this._sweepEntities(dt);

    // HUD 由 setInterval 刷新；这里只做逐帧节流兜底
    this._hudAccumulator += dt;
    if (this._hudAccumulator >= 0.25) {
      this._hudAccumulator = 0;
      this._renderHUD();
    }
  }

  /** 正弦浮动 + 命中闪色；Fixed 刚体仅被主动 setTranslation，不产生冲量 */
  _animateTargets(dt) {
    const world = this._ctx?.world;
    if (!world) return;
    for (const target of this._targets) {
      const y = target.baseY + Math.sin(this._time * target.bobSpeed + target.phase) * target.bobAmp;
      target.group.position.y = y;
      try {
        target.rigidBody.setTranslation({ x: target.layout.x, y, z: target.layout.z }, true);
      } catch (err) {
        console.error('[PumpkinThrower] 靶子位置同步失败：', err);
      }
      if (target.flash > 0) {
        target.flash = Math.max(0, target.flash - dt * 2.5);
        if (target.material.uniforms?.uTint?.value?.setRGB) {
          target.material.uniforms.uTint.value.setRGB(1, 0.55 + 0.45 * (1 - target.flash), 0.4);
        } else if (target.material.emissive?.setRGB) {
          target.material.emissive.setRGB(target.flash * 0.8, target.flash * 0.35, 0);
        }
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 预热接口（仅供 main.js 固化基线使用）                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 模拟「一次投掷 + 一次命中 + 粒子生成」，让南瓜材质、粒子材质、
   * 命中特效的全部 shader 被编译、贴图被上传。
   * main.js 在本方法后需调用一次 renderer.render() 才真正触发上传。
   */
  warmUpThrowHit() {
    if (this._disposed || this._targets.length === 0) return;
    this._setState(STATE.PLAYING);
    this._lastThrowAt = -Infinity;
    const target = this._targets[2]; // 中靶（3 分）
    const aim = new THREE.Vector3(target.layout.x, target.layout.y, target.layout.z);
    const pumpkin = this._throwPumpkin(aim);
    // 把南瓜直接摆到靶心，模拟命中帧
    pumpkin.body.setTranslation({ x: aim.x, y: aim.y, z: aim.z }, true);
    pumpkin.prev.set(aim.x, aim.y, aim.z);
    this._resolveHit(pumpkin, target); // 先移除南瓜刚体，再处理靶子 + 粒子
    console.info(`[PumpkinThrower:warmUp] 投掷+命中完成，存活粒子=${this._particles.length}`);
  }

  /** 模拟一次粒子 TTL 到期回收，确保粒子生命周期路径也完成一次 */
  warmUpExpire() {
    if (this._disposed) return;
    this._sweepEntities(PARTICLE_TTL + 1);
    console.info(`[PumpkinThrower:warmUp] 粒子 TTL 到期，剩余粒子=${this._particles.length}`);
  }

  /* ------------------------------------------------------------------------ */
  /* dispose —— 七步清理，不破坏 M2 标准                                      */
  /* ------------------------------------------------------------------------ */

  /** 每个清理步骤独立 try/catch：单步失败只记日志，不中断整体 */
  _step(label, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[PumpkinThrower] dispose 步骤「${label}」失败（继续后续清理）：`, err);
    }
  }

  /**
   * 【最高风险】严格按 IAttraction 契约释放全部资源，且必须幂等。
   * 顺序按硬性约束 3：相机恢复放在最前段并单独 try/catch；
   * 其后每一步各自独立 try/catch，互不中断。
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* ---------- 步骤 -1：通用暂停菜单清理（解绑 ESC / 移除 DOM / 恢复运行） ---------- */
    try {
      this._pauseMenu?.dispose();
    } catch (err) {
      console.error('[PumpkinThrower] 暂停菜单清理失败：', err);
    }
    this._pauseMenu = null;

    /* ---------- 步骤 0：相机恢复（硬性约束：最前段 + try/catch） ---------- */
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
      console.error('[PumpkinThrower] dispose 步骤「相机恢复」失败（继续后续清理）：', err);
    }

    /* ---------- 步骤 1：清除全部定时器（rAF / interval / timeout） ---------- */
    this._step('定时器', () => {
      this._clearAllTimers();
      for (const p of this._particles) {
        if (p.timeoutId !== null) clearTimeout(p.timeoutId);
        p.timeoutId = null;
      }
    });

    /* ---------- 步骤 2：移除 DOM 事件监听、UI 节点与 <style> ---------- */
    this._step('UI 与监听', () => {
      for (const { target, type, fn } of this._listeners) {
        target.removeEventListener(type, fn);
      }
      this._listeners.length = 0;
      this._uiRoot?.remove();
      this._uiStyle?.remove();
      this._uiRoot = null;
      this._uiStyle = null;
      this._ui = {};
    });

    /* ---------- 步骤 3：物理刚体全量移除 ----------
     * removeRigidBody 会级联删除挂载其上的 collider，绝不重复 removeCollider；
     * 只有无父刚体的独立 collider 才单独 removeCollider(c, true)。
     */
    this._step('物理刚体', () => this._disposePhysics());

    /* ---------- 步骤 4：收集并释放几何体 / 材质 / 纹理 ---------- */
    this._step('GPU 资源', () => this._disposeThreeResources());

    /* ---------- 步骤 5：状态与台账清空 ---------- */
    this._step('台账清空', () => {
      this.root.clear(); // 只清子节点；从 scene 移除由 AttractionManager 第 ③ 步负责
      this._targets.length = 0;
      this._pumpkins.length = 0;
      this._particles.length = 0;
      this._standaloneColliders.length = 0;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
      this._shared = {};
      this._groundBody = null;
      this._cameraSaved = null;
      this._state = STATE.OVER;
      this._ctx = null;
    });

    console.info('[PumpkinThrower] dispose 完成：相机已恢复 / 定时器 / DOM / 刚体 / GPU 资源 / 台账全部清理');
  }

  /** 物理清理：南瓜、粒子、靶子、地面，以及独立 collider */
  _disposePhysics() {
    const world = this._ctx?.world;
    if (!world) {
      this._targets.length = 0;
      this._pumpkins.length = 0;
      this._particles.length = 0;
      this._groundBody = null;
      return;
    }

    // ① 存活南瓜（含未命中的）
    for (const p of [...this._pumpkins]) {
      if (p.body) { world.removeRigidBody(p.body); p.body = null; p.collider = null; }
    }
    // ② 尚未消失的粒子物理体
    for (const p of [...this._particles]) {
      if (p.body) { world.removeRigidBody(p.body); p.body = null; p.collider = null; }
    }
    // ③ 靶子（Fixed）
    for (const t of this._targets) {
      if (t.rigidBody) { world.removeRigidBody(t.rigidBody); t.rigidBody = null; t.collider = null; }
    }
    // ④ 地面
    if (this._groundBody) {
      world.removeRigidBody(this._groundBody);
      this._groundBody = null;
    }
    // ⑤ 独立创建的 collider（本类当前为 0，保留以完整履行契约）
    for (const c of this._standaloneColliders) {
      world.removeCollider(c, true);
    }
    this._standaloneColliders.length = 0;

    console.info('[PumpkinThrower] 物理刚体已全量 removeRigidBody（南瓜/粒子/靶子/地面）');
  }

  /** Three 资源释放：台账 + traverse 兜底；纹理含标准槽位与 uniforms 深度扫描 */
  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);

    // 遍历兜底：防止有漏登记的 mesh / line / points
    this.root.traverse((obj) => {
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      if (obj.geometry) geometries.add(obj.geometry);
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x && materials.add(x));
      else if (m) materials.add(m);
    });

    // 引用路径【不去重】；释放计划【Map 去重】——沿用 M2 修复结论
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

    // ④-a 逐张 dispose，打印 uuid + 调用标记（与 M2 验收日志格式一致）
    for (const [texture, meta] of texturePlan) {
      try {
        texture.dispose();
        meta.disposeCalled = true;
      } catch (err) {
        console.error(`[PumpkinThrower:纹理] uuid=${texture.uuid} dispose 失败：`, err);
      }
    }

    // ④-b dispose 之后逐路径断开引用（material.map=null / uniforms.uTex.value=null）
    const cleared = [];
    for (const ref of refs) {
      try {
        ref.clear();
        cleared.push(ref.path);
      } catch (err) {
        console.error(`[PumpkinThrower:纹理] 断开引用 ${ref.path} 失败：`, err);
      }
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
      try { material.dispose(); } catch (err) { console.error('[PumpkinThrower] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[PumpkinThrower] 几何体 dispose 失败：', err); }
    }

    console.info(
      `[PumpkinThrower] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} ` +
      `texture=${texturePlan.size} 引用路径=${cleared.length}`
    );
  }
}

export default PumpkinThrower;
