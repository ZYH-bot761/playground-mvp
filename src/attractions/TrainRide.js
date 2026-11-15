/**
 * ============================================================================
 * TrainRide —— 高空环游（方块像素风 / 纯观景第一人称过山车）
 * ============================================================================
 * 定位：第五个游乐项目（载具 / 观赏类）。没有任何收集、点击、计分或 Raycaster
 *      交互 —— 这是一趟纯观景的第一人称过山车。onInteract 仅为满足 IAttraction
 *      契约而存在的空实现。
 *
 * 【玩法】
 *   READY（开始）→ RIDING（自动绕行一圈）→ OVER（回到起点，再坐一次 / 返回游乐场）。
 *   一圈时长由「高度 → 速度」的能量模型逐段积分后一次性校准到约 48 秒：
 *   爬坡慢（顶部最低速约 4~5 m/s）、俯冲快（谷底最高速约 15~20 m/s）。
 *   速度是高度的纯函数，因此同一圈里每一段的快慢都是稳定可复现的。
 *
 * 【第一人称相机】
 *   机位固定在车厢最前排（轨道中心线上方约 1.35m、向前 0.35m），
 *   朝向由轨道切线决定，并叠加：
 *     · 曲率驱动、低通平滑的压弯 roll（最大约 24°，过弯真的会侧倾）；
 *     · 固定 6° 俯角 —— 轨道向前伸展、下坡时脚下悬空一览无余。
 *   相机每帧直接跟随轨道，不做第三人称插值；只有 roll 做平滑，避免侧倾突变。
 *
 * 【轨道设计】
 *   · 闭合 CatmullRomCurve3（24 控制点，lemniscate 图-8 走向，跨度约 160m）。
 *   · 高度 5m ~ 40m：两处高坡 + 两段陡降 + 中段急转，中央有一次「上下交叉」
 *     （低段 6m 从高段 26m 下方穿过），最高点 40m 可俯瞰整座方块游乐场。
 *   · 轨道由三组 InstancedMesh 组成：块状钢轨、方块枕木、落地桥墩 ——
 *     全部共享 1 个立方体几何，运行期不新增任何 GPU 资源。
 *
 * 【视觉：方块像素风】
 *   · 全场景只有 1 个 BoxGeometry(1,1,1)，所有物体用非等比缩放拼方块；
 *   · 材质统一 MeshStandardMaterial + flatShading（手册 P5 弃用 Lambert），
 *     硬边平直着色保留，金属/木材/涂料按 PBR 规范分类参数；
 *   · 方块游乐场全景：草坪广场、中央大厅、摩天轮、四座设施、树木。
 *
 * 【暂停】
 *   复用通用 PauseMenu（ESC + 右上角按钮）。打开时 sceneManager.setPaused(true)，
 *   SceneManager 会跳过 attractionManager.update()，因此轨道 t、相机、摩天轮、
 *   计时全部真正冻结。本类不新建任何暂停 UI。
 *
 * 【资源契约】
 *   IAttraction 四接口、带 _disposed 幂等锁的七步 dispose、资源台账、
 *   warmUp()（把全部材质送进渲染管线一次，且不改变乘坐进度）。
 *   类名 / DOM 类名前缀统一为 tr-。
 * ============================================================================
 */

import * as THREE from 'three';
import audioManager from '../core/AudioManager.js';
import { IAttraction } from './IAttraction.js';
import PauseMenu from '../ui/PauseMenu.js';

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

const STATE = Object.freeze({ READY: 'ready', RIDING: 'riding', OVER: 'over' });

/** 目标单圈时长（秒）；速度系数由 init 时的积分校准到这个值 */
const TARGET_LAP_SECONDS = 50;

/* ---- 轨道外形：lemniscate 图-8 ---- */
const LOBE_A = 80; // 左右半轴
const LOBE_B = 52; // 前后半轴
const TRACK_POINT_COUNT = 24;

/**
 * 24 个控制点的高度（按角度 15° 递增）。
 * 5m 谷底 → 40m 顶点，形成两座高坡、两段陡降与一次中央上下交叉：
 *   · θ=0°   y=6   低段穿过中央
 *   · θ=90°  y=40  右顶点（全景）
 *   · θ=135° y=10  陡降
 *   · θ=150° y=5   谷底（最快）
 *   · θ=180° y=26  高段再次穿过中央（比低段高 20m）
 *   · θ=255° y=34  第二座高坡
 */
const TRACK_HEIGHTS = Object.freeze([
  6, 10, 16, 25, 33, 39, 40, 33, 22, 10, 5, 16,
  26, 24, 18, 14, 24, 34, 31, 22, 14, 8, 6, 6,
]);

/* ---- 速度模型 ---- */
const SPEED_TOP = 3.8; // 顶点附近的最低速度（m/s）
const SPEED_GRAVITY = 4.2; // 换算重力（调低 → 坡度带来的加速更温和）
const SPEED_MIN_CLAMP = 2.5;
const SPEED_MAX_CLAMP = 26;

/* ---- 第一人称相机 ---- */
// 视点：略微抬高到车头上方，避免坐在车厢内部时视线被车身顶面 / 座椅靠背糊死
// （只影响取景，不参与速度、压弯、轨道等玩法与物理参数）
const EYE_HEIGHT = 1.75; // 视点高度（轨道中心线上方）
const EYE_FORWARD = 1.05; // 视点前移：越过车身前沿，能看到车头与轨道
const CAM_PITCH_DEG = 6; // 固定俯角：看得到轨道与脚下的悬空
const CAM_FOV_LANDSCAPE = 76;
const CAM_FOV_PORTRAIT = 84;
const MAX_BANK = 0.42; // 最大压弯 24°
const BANK_SMOOTH = 7; // 侧倾低通系数（越大越跟手；7 ≈ 每帧滚动 <3.1°，约 185°/s）

/* ---- 自由转头 / 朝向惯性（手册 §5） ---- */
const LOOK_YAW_LIMIT = (Math.PI * 2) / 3; // 相对车厢 yaw ±120°
const LOOK_PITCH_LIMIT = Math.PI / 3; // 相对车厢 pitch ±60°
const LOOK_SENS = 0.0032; // 拖动灵敏度 rad/px
const ORI_FACTOR = 0.08; // 朝向 slerp 系数（0.05~0.1，60fps 基准）→ 转弯惯性延迟

/* ---- 轨道造型 ---- */
const RAIL_HALF = 0.46; // 双轨中心到中线距离
const RAIL_W = 0.16;
const RAIL_H = 0.14;
const RAIL_LIFT = 0.2;
const TIE_W = 1.5;
const TIE_H = 0.16;
const TIE_D = 0.36;
const PILLAR_INTERVAL = 7;

/* ---- UI ---- */
const UI_CSS = `
.tr-ui{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#eef3ff}
.tr-shade{position:absolute;inset:0;background:rgba(5,9,20,.58)}
.tr-panel{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  pointer-events:auto;width:min(430px,calc(100vw - 32px));padding:24px 26px 20px;
  max-height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  background:rgba(14,20,38,.95);border:1px solid rgba(190,165,255,.38);
  border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.55);text-align:center}
.tr-panel[data-hidden='true'],.tr-shade[data-hidden='true']{display:none}
.tr-panel__title{margin:0 0 10px;font-size:26px;font-weight:700;color:#ffd27a;
  text-shadow:0 0 18px rgba(255,190,90,.35)}
.tr-panel__desc{margin:0 0 8px;font-size:14px;line-height:1.65;color:#c8d6f5}
.tr-panel__hint{margin:0 0 16px;font-size:12px;line-height:1.7;color:#8fa4cf}
.tr-panel__stat{margin:0 0 16px;padding:11px;border-radius:10px;
  background:rgba(120,160,255,.12);font-size:14px;line-height:1.9;color:#c8d6f5}
.tr-panel__stat b{color:#ffce6a}
.tr-panel__stat[data-hidden='true']{display:none}
.tr-panel__buttons{display:flex;gap:10px;justify-content:center;margin-bottom:10px}
.tr-btn{flex:1;padding:11px 12px;font-size:14px;border-radius:9px;cursor:pointer;
  color:#dbe6ff;background:rgba(255,255,255,.08);border:1px solid rgba(160,190,255,.4)}
.tr-btn:hover{background:rgba(140,180,255,.22);border-color:rgba(190,215,255,.7)}
.tr-btn--primary{color:#10162a;font-weight:700;background:#ffce6a;border-color:#ffce6a}
.tr-btn--primary:hover{background:#ffdc92;border-color:#ffdc92}
.tr-btn--exit{color:#ffe9b0;background:rgba(255,200,90,.14);border-color:rgba(255,200,90,.55)}
.tr-btn[data-hidden='true']{display:none}
.tr-panel__note{margin:0;font-size:11px;line-height:1.6;color:#7f92b8}
@media (max-width:560px){
  .tr-panel{padding:18px 18px 16px}
  .tr-panel__title{font-size:22px}
  .tr-panel__buttons{flex-direction:column}
  .tr-btn{min-height:44px;font-size:15px}
}
@media (max-height:520px){
  .tr-panel{padding:16px 20px 14px;max-height:calc(100dvh - 20px)}
  .tr-panel__title{font-size:20px;margin-bottom:6px}
  .tr-panel__hint{display:none}
}
`;

/* ---- 标准纹理槽位（本项目 0 张贴图，保留通用释放路径以履行契约） ---- */
const STANDARD_TEXTURE_SLOTS = Object.freeze([
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap', 'specularMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'anisotropyMap', 'iridescenceMap',
  'iridescenceThicknessMap', 'specularColorMap',
]);

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
      scanTextureValue(value[i], `${path}[${i}]`, out, seen, depth + 1, (next) => { value[i] = next; });
    }
    return;
  }
  for (const key of Object.keys(value)) {
    scanTextureValue(value[key], `${path}.${key}`, out, seen, depth + 1, (next) => { value[key] = next; });
  }
}

/** 收集单个材质里的全部纹理引用（标准槽位 + ShaderMaterial.uniforms 深度扫描） */
function collectMaterialTextureReferences(material, index) {
  const out = [];
  if (!material) return out;

  for (const slot of STANDARD_TEXTURE_SLOTS) {
    const value = material[slot];
    if (value && value.isTexture === true) {
      out.push({
        texture: value,
        path: `materials[${index}].${slot}`,
        clear: () => { material[slot] = null; },
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
    scanTextureValue(
      value,
      `materials[${index}].uniforms.${name}.value`,
      out,
      seen,
      0,
      (next) => { uniform.value = next; },
    );
  }
  return out;
}

/** 方块像素风的确定性伪随机（树木布局用，避免每次刷新变样） */
function makeSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/* ========================================================================== */
/* 实现                                                                        */
/* ========================================================================== */

export class TrainRide extends IAttraction {
  constructor() {
    super();

    /** 根节点：init 挂到 ctx.scene，卸载时由 AttractionManager 第 ③ 步移除 */
    this.root = new THREE.Group();
    this.root.name = 'TrainRide';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;
    this._state = STATE.READY;

    // ---- 乘坐进度 / 速度 ----
    this._clock = 0; // 单调时钟（update 推进；暂停即停）
    this._t = 0; // 轨道弧长参数 0~1
    this._lapTime = 0;
    this._speed = 0; // 当前速度 m/s
    this._bank = 0; // 当前压弯 roll（弧度）
    this._bankTarget = 0;

    // ---- 相机接管 ----
    this._cameraSaved = null;
    this._lastAspect = 0;

    // ---- 自由转头（相对车厢朝向） ----
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._lookDragging = false;
    this._lookLastX = 0;
    this._lookLastY = 0;

    // ---- 资源台账 ----
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._shared = {};

    // ---- 场景对象 ----
    this._curve = null;
    this._length = 0;
    this._train = null;
    this._wheel = null;

    // ---- 速度校准结果（诊断用）----
    this._speedScale = 1;
    this._speedMin = 0;
    this._speedMax = 0;
    this._crestY = 0;

    // ---- 热路径复用对象（零分配）----
    this._up = new THREE.Vector3(0, 1, 0);
    this._point = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._basisUp = new THREE.Vector3();
    this._bankedUp = new THREE.Vector3();
    this._basis = new THREE.Matrix4();
    this._bankQuat = new THREE.Quaternion();
    this._baseQuat = new THREE.Quaternion();
    this._lookQuat = new THREE.Quaternion();
    this._targetQuat = new THREE.Quaternion();
    this._lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._camMat = new THREE.Matrix4();
    this._lookPoint = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._tanA = new THREE.Vector3();
    this._tanB = new THREE.Vector3();
    this._cross = new THREE.Vector3();
    // 构建期临时对象（只在 init / placeTrain 使用）
    this._tmpPos = new THREE.Vector3();
    this._tmpTan = new THREE.Vector3();
    this._tmpRight = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpScale = new THREE.Vector3();
    this._tmpMat = new THREE.Matrix4();

    // ---- 监听 ----
    this._listeners = [];
    this._uiRoot = null;
    this._uiStyle = null;
    this._ui = {};
    this._pauseMenu = null;
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                     */
  /* ------------------------------------------------------------------------ */

  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;

    const { scene, camera } = ctx;
    if (!scene || !camera) throw new Error('[TrainRide] 缺少 scene / camera');

    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    /* ---------- ① 接管相机（保存全部运行时字段，dispose 恢复） ---------- */
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      up: camera.up.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };

    /* ---------- ② 根节点挂载 ---------- */
    scene.add(this.root);

    /* ---------- ③ 共享方块几何 + 调色板材质 ---------- */
    this._buildSharedResources();
    for (const geometry of this._geometries) register(geometry);
    for (const material of this._materials) register(material);
    for (const texture of this._textures) register(texture);

    /* ---------- ④ 速度校准（一次性积分，决定快慢节奏） ---------- */
    /* ---------- ⑤ 场景：轨道 / 方块游乐场 / 火车 ---------- */
    this._buildTrack();
    this._calibrateSpeed();
    this._buildPark();
    this._buildTrain();

    /* ---------- ⑥ UI + 通用暂停组件 ---------- */
    this._buildUI();
    this._pauseMenu = new PauseMenu({
      // 与另外四个玩法一致：桌面走 ESC，触屏才在右上角显示「暂停」按钮
      onRestart: () => this._startRide(),
      onExit: () => {
        this._pauseMenu?.dispose();
        this._ctx?.onExitAttraction?.();
      },
    }).attach();

    /* ---------- ⑦ 具名监听 ---------- */
    this._bindInputListeners();

    /* ---------- ⑧ 初始化视口 + 归位 ---------- */
    this._adaptFov();
    this._resetRide();
    this._setState(STATE.READY);

    console.info(
      `[TrainRide] init 完成 | 闭合轨道 长度=${this._length.toFixed(1)}m 顶点=${this._crestY.toFixed(1)}m | ` +
      `校准单圈=${TARGET_LAP_SECONDS}s 速度=${this._speedMin.toFixed(1)}~${this._speedMax.toFixed(1)}m/s | ` +
      `几何=${this._geometries.size} 材质=${this._materials.size} 纹理=${this._textures.size} | ` +
      `第一人称 / 无计分 / 无交互`
    );
  }

  _trackGeometry(geometry) { this._geometries.add(geometry); return geometry; }
  _trackMaterial(material) { this._materials.add(material); return material; }

  /**
   * 全场景唯一的立方体几何 + 方块调色板。
   * 所有物体都用这个 1×1×1 立方体按非等比缩放拼出来 —— 方块像素风的根基，
   * 也把几何体数量压到 1 个，dispose 只需释放一次。
   */
  _buildSharedResources() {
    const cube = this._trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    cube.name = 'TrainRide/voxel-cube';

    const palette = {
      rail: 0x394150,
      tie: 0x8a5a33,
      pillar: 0x6b7280,
      grass: 0x4c8b3f,
      hall: 0xd9c9a8,
      hallDark: 0x2f3545,
      roof: 0x8c3b3b,
      wheel: 0x2f6f8f,
      cabin: 0xe8b23a,
      train: 0xe05a3c,
      trainDark: 0x2b3242,
      seat: 0x3b82c4,
      markA: 0xb8483f,
      markB: 0xd0762a,
      markC: 0x7a4fa8,
      markD: 0x2f8f86,
      leaf: 0x2f6a3a,
    };

    const materials = {};
    // 手册 P5：弃用 Lambert → Standard + flatShading（保留方块硬边），
    // 按手册 PBR 规范分类：金属 1.0/0.3，木材 0/0.85，涂料 0.15/0.55，植被 0/0.9
    const pbr = (key) => {
      if (key === 'rail' || key === 'pillar' || key === 'wheel') return { metalness: 1.0, roughness: 0.3 };
      if (key === 'tie') return { metalness: 0.0, roughness: 0.85 };
      if (key === 'grass' || key === 'leaf') return { metalness: 0.0, roughness: 0.9 };
      return { metalness: 0.15, roughness: 0.55 };
    };
    for (const key of Object.keys(palette)) {
      materials[key] = this._trackMaterial(new THREE.MeshStandardMaterial({
        color: palette[key],
        flatShading: true,
        ...pbr(key),
      }));
    }

    this._shared = { cube, materials };
  }

  /**
   * 速度校准：对整圈采样，按 v(y)=sqrt(v_top² + 2g(crest-y)) 逐段累加耗时，
   * 再求一个统一缩放系数，使总时长正好等于 TARGET_LAP_SECONDS。
   * 这样「爬坡慢 / 下坡快」的形状固定，总时长又稳定落在 40~60s 区间内。
   */
  _calibrateSpeed() {
    const steps = 1000;
    let total = 0;
    let rawMin = Infinity;
    let rawMax = 0;
    let crest = 0;

    for (let i = 0; i <= steps; i += 1) {
      this._curve.getPointAt(Math.min(i / steps, 1), this._tmpPos);
      if (this._tmpPos.y > crest) crest = this._tmpPos.y;
    }
    this._crestY = crest;

    for (let i = 0; i < steps; i += 1) {
      this._curve.getPointAt(i / steps, this._tmpPos);
      const v = this._baseSpeed(this._tmpPos.y, crest);
      total += (this._length / steps) / v;
      if (v < rawMin) rawMin = v;
      if (v > rawMax) rawMax = v;
    }

    this._speedScale = total > 0 ? total / TARGET_LAP_SECONDS : 1;
    this._speedMin = Math.min(SPEED_MAX_CLAMP, Math.max(SPEED_MIN_CLAMP, rawMin * this._speedScale));
    this._speedMax = Math.min(SPEED_MAX_CLAMP, Math.max(SPEED_MIN_CLAMP, rawMax * this._speedScale));

    console.info(
      `[TrainRide] 速度校准 | 轨道长度 ${this._length.toFixed(1)}m | 原始单圈 ${total.toFixed(1)}s | ` +
      `系数 ${this._speedScale.toFixed(3)} | 速度 ${this._speedMin.toFixed(1)}~${this._speedMax.toFixed(1)}m/s`
    );
  }

  /** 能量模型：高度越低越快（crest 为整圈最高点） */
  _baseSpeed(y, crest = this._crestY) {
    const drop = Math.max(0, crest - y);
    return Math.sqrt(SPEED_TOP * SPEED_TOP + 2 * SPEED_GRAVITY * drop);
  }

  /* ------------------------------------------------------------------------ */
  /* 轨道                                                                     */
  /* ------------------------------------------------------------------------ */

  _buildTrack() {
    const points = [];
    for (let i = 0; i < TRACK_POINT_COUNT; i += 1) {
      const angle = (i / TRACK_POINT_COUNT) * Math.PI * 2;
      points.push(new THREE.Vector3(
        LOBE_A * Math.sin(angle),
        TRACK_HEIGHTS[i],
        LOBE_B * Math.sin(angle) * Math.cos(angle),
      ));
    }

    // 闭合曲线：首尾自动接上；弧长参数保证 t 恒速（真正的快慢由速度模型控制）
    const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.5);
    curve.arcLengthDivisions = 400;
    this._curve = curve;
    this._length = curve.getLength();

    const S = this._shared;

    /* ---------- 双轨：块状钢轨（两个实例 / 段） ---------- */
    const railSegments = Math.max(2, Math.round(this._length / 0.95));
    const rails = new THREE.InstancedMesh(S.cube, S.materials.rail, railSegments * 2);
    rails.name = 'TrainRide/rails';
    rails.castShadow = false;
    rails.receiveShadow = false;

    const segLen = this._length / railSegments;
    let railIndex = 0;
    for (let i = 0; i < railSegments; i += 1) {
      const t = i / railSegments;
      this._frameAt(t, this._tmpPos, this._tmpQuat, this._tmpRight, this._tmpUp);

      for (const side of [-1, 1]) {
        this._tmpPos.addScaledVector(this._tmpRight, side * RAIL_HALF);
        this._tmpPos.addScaledVector(this._tmpUp, RAIL_LIFT);
        this._tmpScale.set(RAIL_W, RAIL_H, segLen * 1.06);
        this._tmpMat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
        rails.setMatrixAt(railIndex, this._tmpMat);
        railIndex += 1;
        // 复位到轨道中心，避免两侧偏移累加
        this._tmpPos.addScaledVector(this._tmpRight, -side * RAIL_HALF);
        this._tmpPos.addScaledVector(this._tmpUp, -RAIL_LIFT);
      }
    }
    rails.instanceMatrix.needsUpdate = true;
    rails.frustumCulled = false; // 包围盒随实例分散，关闭剔除避免误裁
    this.root.add(rails);

    /* ---------- 方块枕木 ---------- */
    const ties = Math.max(2, Math.round(this._length / 2.3));
    const tieMesh = new THREE.InstancedMesh(S.cube, S.materials.tie, ties);
    tieMesh.name = 'TrainRide/ties';
    for (let i = 0; i < ties; i += 1) {
      this._frameAt(i / ties, this._tmpPos, this._tmpQuat, this._tmpRight, this._tmpUp);
      this._tmpPos.addScaledVector(this._tmpUp, -0.15);
      this._tmpScale.set(TIE_W, TIE_H, TIE_D);
      this._tmpMat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
      tieMesh.setMatrixAt(i, this._tmpMat);
    }
    tieMesh.instanceMatrix.needsUpdate = true;
    tieMesh.frustumCulled = false;
    this.root.add(tieMesh);

    /* ---------- 落地桥墩（方块柱子） ---------- */
    const pillarCount = Math.max(2, Math.round(this._length / PILLAR_INTERVAL));
    const pillars = new THREE.InstancedMesh(S.cube, S.materials.pillar, pillarCount);
    pillars.name = 'TrainRide/pillars';
    this._tmpQuat.identity();
    for (let i = 0; i < pillarCount; i += 1) {
      this._curve.getPointAt(i / pillarCount, this._tmpPos);
      const height = Math.max(0.4, this._tmpPos.y - 0.6);
      this._tmpPos.y = height / 2;
      this._tmpScale.set(0.62, height, 0.62);
      this._tmpMat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
      pillars.setMatrixAt(i, this._tmpMat);
    }
    pillars.instanceMatrix.needsUpdate = true;
    pillars.frustumCulled = false;
    this.root.add(pillars);

    this._shared.railSegments = railSegments;
    this._shared.ties = ties;
    this._shared.pillars = pillarCount;
  }

  /**
   * 计算 t 处的轨道坐标系：位置、+Z 对齐切线的四元数、右向量、上向量。
   * 供实例化轨道与火车共用；全部写入传入的复用对象，零分配。
   */
  _frameAt(t, outPos, outQuat, outRight, outUp) {
    this._curve.getPointAt(t, outPos);
    this._curve.getTangentAt(t, this._tmpTan).normalize();

    outRight.crossVectors(this._up, this._tmpTan).normalize();
    outUp.crossVectors(this._tmpTan, outRight).normalize();
    this._tmpMat.makeBasis(outRight, outUp, this._tmpTan);
    outQuat.setFromRotationMatrix(this._tmpMat);
  }

  /* ------------------------------------------------------------------------ */
  /* 方块游乐场全景                                                            */
  /* ------------------------------------------------------------------------ */

  _addBlock(w, h, d, x, y, z, material, parent = this.root) {
    const mesh = new THREE.Mesh(this._shared.cube, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  _buildPark() {
    const M = this._shared.materials;

    /* ---------- 草坪广场 ---------- */
    const plaza = this._addBlock(230, 0.8, 150, 0, -0.4, 0, M.grass);
    plaza.castShadow = false;

    /* ---------- 中央大厅（放在轨道圈外的南侧，避免和中央交叉段打架） ---------- */
    this._addBlock(28, 10, 18, 0, 5, -46, M.hall);
    this._addBlock(20, 5, 12, 0, 12.5, -46, M.hall);
    this._addBlock(30, 1.4, 20, 0, 15.7, -46, M.roof);
    this._addBlock(7, 6.5, 0.8, 0, 3.4, -36.9, M.hallDark);
    this._addBlock(3, 3, 0.9, -7, 4.2, -36.9, M.roof);

    /* ---------- 摩天轮（方块轮辐，缓慢自转；暂停即停） ---------- */
    const wheelGroup = new THREE.Group();
    wheelGroup.position.set(54, 0, 46);
    wheelGroup.name = 'TrainRide/ferris-wheel';
    this.root.add(wheelGroup);
    this._wheel = wheelGroup;

    const hubY = 15;
    this._addBlock(2.2, 2.2, 2.2, 0, hubY, 0, M.wheel, wheelGroup);

    const rimCount = 16;
    for (let i = 0; i < rimCount; i += 1) {
      const angle = (i / rimCount) * Math.PI * 2;
      this._addBlock(1.7, 1.7, 1.7, Math.cos(angle) * 13, hubY + Math.sin(angle) * 13, 0, M.wheel, wheelGroup);
      if (i % 2 === 0) {
        const cabin = this._addBlock(1.9, 1.9, 1.9, Math.cos(angle) * 14.8, hubY + Math.sin(angle) * 14.8, 0, M.cabin, wheelGroup);
        cabin.castShadow = true;
      }
    }

    // 8 根方块辐条：把单位立方体沿 Y 拉长，再绕 Z 旋转到目标方向
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      const spoke = this._addBlock(0.35, 13, 0.35, Math.cos(angle) * 6.5, hubY + Math.sin(angle) * 6.5, 0, M.wheel, wheelGroup);
      spoke.rotation.z = angle - Math.PI / 2;
    }

    // 两条支撑腿 + 底座
    this._addBlock(0.9, hubY + 1, 0.9, -5.2, (hubY + 1) / 2, 0, M.wheel, wheelGroup);
    this._addBlock(0.9, hubY + 1, 0.9, 5.2, (hubY + 1) / 2, 0, M.wheel, wheelGroup);
    this._addBlock(14, 0.8, 3, 0, 0.4, 0, M.pillar, wheelGroup);

    /* ---------- 四座设施（对应大厅里的四个游乐项目） ---------- */
    const builds = [
      { x: -52, z: 34, mat: M.markA, h: 7 },
      { x: 52, z: 34, mat: M.markB, h: 6 },
      { x: -52, z: -34, mat: M.markC, h: 8 },
      { x: 52, z: -34, mat: M.markD, h: 7 },
    ];
    for (const build of builds) {
      this._addBlock(12, build.h, 12, build.x, build.h / 2 + 0.4, build.z, build.mat);
      this._addBlock(8, 1.2, 8, build.x, build.h + 1, build.z, M.roof);
      this._addBlock(1.2, 5, 1.2, build.x + 4.6, 2.9, build.z + 4.6, M.pillar);
    }

    /* ---------- 方块树（确定性布局） ---------- */
    const random = makeSeededRandom(20261108);
    for (let i = 0; i < 14; i += 1) {
      const x = (random() - 0.5) * 70;
      const z = (random() - 0.5) * 40;
      if (Math.abs(x) < 8 && Math.abs(z) < 8) continue; // 中央交叉塔附近留空
      this._addBlock(1, 1.6, 1, x, 0.8, z, M.tie);
      this._addBlock(3.2, 2.4, 3.2, x, 2.8, z, M.leaf);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 方块车厢                                                                  */
  /* ------------------------------------------------------------------------ */

  _buildTrain() {
    const M = this._shared.materials;
    const train = new THREE.Group();
    train.name = 'TrainRide/train';
    this.root.add(train);
    this._train = train;

    // 本地坐标：+Z 朝前（与轨道切线一致），y=0 位于轨道中心线
    this._addBlock(1.9, 0.3, 3.1, 0, 0.62, 0, M.trainDark, train); // 底盘
    this._addBlock(1.8, 0.45, 2.7, 0, 0.98, 0, M.train, train); // 车身
    this._addBlock(1.5, 0.42, 0.62, 0, 1.02, 1.72, M.train, train); // 车头
    this._addBlock(1.9, 0.22, 0.9, 0, 1.28, 1.5, M.trainDark, train); // 车头盖
    this._addBlock(0.16, 0.56, 2.4, -0.88, 1.22, 0, M.trainDark, train); // 左护栏
    this._addBlock(0.16, 0.56, 2.4, 0.88, 1.22, 0, M.trainDark, train); // 右护栏
    this._addBlock(1.5, 0.8, 0.18, 0, 1.5, -0.78, M.seat, train); // 座椅靠背
    this._addBlock(1.5, 0.18, 0.62, 0, 1.16, 0.1, M.seat, train); // 坐垫
  }

  /* ------------------------------------------------------------------------ */
  /* 位姿 / 相机                                                              */
  /* ------------------------------------------------------------------------ */

  /** 把火车放到弧长参数 t 处，并同步 _point / _tangent（相机与压弯共用） */
  _placeTrain(t) {
    if (!this._curve || !this._train) return;

    this._curve.getPointAt(t, this._point);
    this._curve.getTangentAt(t, this._tangent).normalize();

    this._right.crossVectors(this._up, this._tangent).normalize();
    this._basisUp.crossVectors(this._tangent, this._right).normalize();
    this._basis.makeBasis(this._right, this._basisUp, this._tangent);

    this._train.position.copy(this._point);
    this._train.quaternion.setFromRotationMatrix(this._basis);
  }

  /**
   * 目标压弯角：由 t±0.003 两处切线的夹角得到局部曲率，
   * 侧向加速度 v²κ 与重力比较后取 atan，方向由转向符号决定（向弯内倾）。
   * 切线跨过 0/1 时取模，保证闭合处不出现假曲率。
   */
  _computeBankTarget(t, speed) {
    const delta = 0.003;
    const tA = (t - delta + 1) % 1;
    const tB = (t + delta) % 1;

    this._curve.getTangentAt(tA, this._tanA).normalize();
    this._curve.getTangentAt(tB, this._tanB).normalize();

    const angle = this._tanA.angleTo(this._tanB);
    const arc = delta * 2 * this._length;
    const curvature = arc > 1e-6 ? angle / arc : 0;

    this._cross.crossVectors(this._tanA, this._tanB);
    const turnSign = Math.sign(this._cross.dot(this._up)); // >0 右转，<0 左转

    const lateral = speed * speed * curvature;
    const magnitude = Math.min(MAX_BANK, Math.atan2(lateral, 9.8));
    return -turnSign * magnitude; // 向弯内倾
  }

  /**
   * 第一人称相机：机位 = 轨道点 + 切线*EYE_FORWARD + 侧倾后的上向量*EYE_HEIGHT（车厢前排）。
   * 朝向 = 车厢基准朝向（切线 + 固定俯角 + 压弯 roll）× 自由转头（yaw/pitch，相对车厢），
   * 再用 Quaternion.slerp(系数 ORI_FACTOR) 平滑 → 轨道转弯时朝向有惯性延迟，不完全同步车厢。
   * @param {number} dt
   * @param {boolean} [snap] true 时不做侧倾/朝向平滑（开局 / 重开用）
   */
  _updateCamera(dt, snap = false) {
    const camera = this._ctx?.camera;
    if (!camera) return;

    this._bankTarget = this._computeBankTarget(this._t, this._speed);
    if (snap) {
      this._bank = this._bankTarget;
    } else {
      this._bank += (this._bankTarget - this._bank) * (1 - Math.exp(-BANK_SMOOTH * dt));
    }

    this._bankQuat.setFromAxisAngle(this._tangent, this._bank);
    this._bankedUp.copy(this._basisUp).applyQuaternion(this._bankQuat);

    this._eye.copy(this._point)
      .addScaledVector(this._tangent, EYE_FORWARD)
      .addScaledVector(this._bankedUp, EYE_HEIGHT);

    camera.position.copy(this._eye);
    camera.up.copy(this._bankedUp);

    // 车厢基准朝向：沿切线、固定俯角、roll 由 bankedUp 体现
    const pitchDrop = Math.tan((CAM_PITCH_DEG * Math.PI) / 180) * 10;
    this._lookPoint.copy(this._eye)
      .addScaledVector(this._tangent, 10)
      .addScaledVector(this._bankedUp, -pitchDrop);
    this._camMat.lookAt(this._eye, this._lookPoint, this._bankedUp);
    this._baseQuat.setFromRotationMatrix(this._camMat);

    // 自由转头（相对车厢朝向）：yaw 绕本地 up、pitch 绕本地 right
    this._lookEuler.set(this._lookPitch, this._lookYaw, 0);
    this._lookQuat.setFromEuler(this._lookEuler);
    this._targetQuat.copy(this._baseQuat).multiply(this._lookQuat);

    if (snap) {
      camera.quaternion.copy(this._targetQuat);
    } else {
      // 帧率无关 slerp：60fps 时 t 恰为 ORI_FACTOR（0.05~0.1）→ 转弯惯性延迟
      const k = 1 - Math.pow(1 - ORI_FACTOR, dt * 60);
      camera.quaternion.slerp(this._targetQuat, k);
    }
  }

  /** 视口自适应：竖屏放宽 fov，保证轨道与轨道下方的悬空都在画面里 */
  _adaptFov() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    const aspect = camera.aspect;
    if (Math.abs(aspect - this._lastAspect) < 0.01) return;
    this._lastAspect = aspect;

    const fov = aspect < 1 ? CAM_FOV_PORTRAIT : CAM_FOV_LANDSCAPE;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* UI / 监听                                                                */
  /* ------------------------------------------------------------------------ */

  _addListener(target, type, fn, options = false) {
    target.addEventListener(type, fn, options);
    this._listeners.push({ target, type, fn, options });
  }

  _removeAllListeners() {
    for (const { target, type, fn, options } of this._listeners) {
      try { target.removeEventListener(type, fn, options); } catch { /* 目标已销毁，忽略 */ }
    }
    this._listeners.length = 0;
  }

  _onKeyDown = (event) => {
    if (this._disposed) return;
    const tagName = event.target?.tagName;
    if (tagName === 'BUTTON' || tagName === 'INPUT' || tagName === 'TEXTAREA') return;
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    if (this._state === STATE.READY || this._state === STATE.OVER) {
      if (event.cancelable) event.preventDefault();
      this._startRide();
    }
  };

  /* ---- 自由转头拖动（仅鼠标；触屏留给 UI） ---- */
  _onLookDown = (event) => {
    if (this._disposed || this._state === STATE.OVER) return;
    if (event.pointerType !== 'mouse') return;
    this._lookDragging = true;
    this._lookLastX = event.clientX;
    this._lookLastY = event.clientY;
  };
  _onLookMove = (event) => {
    if (!this._lookDragging || this._disposed) return;
    const dx = event.clientX - this._lookLastX;
    const dy = event.clientY - this._lookLastY;
    this._lookLastX = event.clientX;
    this._lookLastY = event.clientY;
    this._lookYaw = clamp(this._lookYaw - dx * LOOK_SENS, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
    this._lookPitch = clamp(this._lookPitch - dy * LOOK_SENS, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT);
  };
  _onLookUp = () => { this._lookDragging = false; };

  _bindInputListeners() {
    this._addListener(window, 'keydown', this._onKeyDown);
    const canvas = this._ctx?.renderer?.domElement;
    if (canvas) {
      this._addListener(canvas, 'pointerdown', this._onLookDown);
      this._addListener(canvas, 'pointermove', this._onLookMove);
      this._addListener(canvas, 'pointerup', this._onLookUp);
      this._addListener(canvas, 'pointercancel', this._onLookUp);
    }
  }

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'tr-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'tr-ui';
    this._uiRoot.innerHTML = `
      <div class="tr-shade" data-role="shade"></div>
      <div class="tr-panel" data-role="panel">
        <div class="tr-panel__title" data-role="title">高空环游</div>
        <p class="tr-panel__desc" data-role="desc"></p>
        <p class="tr-panel__hint">第一人称坐在车厢最前排：轨道会在脚下向前伸展，最高处约 40 米。按住鼠标拖动可左右上下环顾（±120°/±60°）。ESC 或右上角「暂停」可随时停下。</p>
        <div class="tr-panel__stat" data-role="stat" data-hidden="true"></div>
        <div class="tr-panel__buttons">
          <button type="button" class="tr-btn tr-btn--primary" data-action="ride" data-role="primary">开始乘坐</button>
          <button type="button" class="tr-btn tr-btn--exit" data-action="exit" data-role="exit" data-hidden="true">🎠 返回游乐场</button>
        </div>
        <p class="tr-panel__note">纯观景项目：没有收集与计分，绕行一圈自动回到起点。</p>
      </div>
    `;
    document.body.appendChild(this._uiRoot);

    const q = (role) => this._uiRoot.querySelector(`[data-role="${role}"]`);
    this._ui = {
      shade: q('shade'),
      panel: q('panel'),
      title: q('title'),
      desc: q('desc'),
      stat: q('stat'),
      primary: q('primary'),
      exit: q('exit'),
    };

    // 单一事件委托：所有按钮共用一条监听
    this._addListener(this._uiRoot, 'click', (event) => {
      if (this._disposed) return;
      const button = event.target.closest?.('button[data-action]');
      if (!button || !this._uiRoot.contains(button)) return;
      const action = button.dataset.action;
      if (action === 'ride' || action === 'restart') this._startRide();
      if (action === 'exit') {
        const exit = this._ctx?.onExitAttraction;
        if (typeof exit === 'function') exit();
        else console.warn('[TrainRide] 缺少 ctx.onExitAttraction，无法返回游乐场');
      }
    });
  }

  _setState(next) {
    this._state = next;
    if (this._disposed || !this._ui.panel) return;

    const riding = next === STATE.RIDING;
    this._ui.panel.dataset.hidden = String(riding);
    this._ui.shade.dataset.hidden = String(riding);

    if (next === STATE.READY) {
      this._ui.title.textContent = '高空环游';
      this._ui.desc.textContent = '坐上方块小火车，沿 40 米高空轨道绕整座游乐场一圈。';
      this._ui.primary.textContent = '开始乘坐';
      this._ui.stat.dataset.hidden = 'true';
      this._ui.exit.dataset.hidden = 'true';
    } else if (next === STATE.OVER) {
      this._ui.title.textContent = '环游结束';
      this._ui.desc.textContent = '小火车已经回到起点。';
      this._ui.primary.textContent = '再坐一次';
      this._ui.stat.dataset.hidden = 'false';
      this._ui.stat.innerHTML =
        `本圈用时 <b>${this._lapTime.toFixed(1)}</b> s<br>` +
        `最高点 <b>${this._crestY.toFixed(0)}</b> m · 最高时速 <b>${(this._speedMax * 3.6).toFixed(0)}</b> km/h`;
      this._ui.exit.dataset.hidden = 'false';
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 局流程                                                                   */
  /* ------------------------------------------------------------------------ */

  _startRide() {
    if (this._disposed) return;
    this._resetRide();
    this._setState(STATE.RIDING);
    audioManager.playClick();
    console.info(`[TrainRide] 开始乘坐 | 校准单圈 ${TARGET_LAP_SECONDS}s`);
  }

  /** 归位：进度 / 计时 / 速度 / 压弯 / 火车 / 相机 */
  _resetRide() {
    this._t = 0;
    this._lapTime = 0;
    this._speed = 0;
    this._bank = 0;
    this._bankTarget = 0;
    this._clock = 0;
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._lookDragging = false;

    this._placeTrain(0);
    this._updateCamera(0, true);
  }

  /** 绕回起点：冻结画面，弹出结算层（无得分） */
  _endRound() {
    if (this._disposed || this._state !== STATE.RIDING) return;
    this._speed = 0;
    this._setState(STATE.OVER);
    console.info(
      `[TrainRide] 回到起点 | 单圈 ${this._lapTime.toFixed(2)}s | 最高点 ${this._crestY.toFixed(1)}m | ` +
      `速度 ${this._speedMin.toFixed(1)}~${this._speedMax.toFixed(1)}m/s`
    );
  }

  /* ------------------------------------------------------------------------ */
  /* update                                                                   */
  /* ------------------------------------------------------------------------ */

  update(deltaTime) {
    if (this._disposed) return;

    this._adaptFov();
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);

    // 结算后完全定格（只有渲染继续）
    if (this._state === STATE.OVER) return;

    this._clock += dt;

    if (this._state === STATE.RIDING) {
      // 先按当前高度算速度（爬坡慢 / 下坡快），再推进弧长参数
      this._speed = this._baseSpeed(this._point.y) * this._speedScale;

      this._placeTrain(this._t);
      this._updateCamera(dt);

      this._t += (this._speed * dt) / this._length;
      this._lapTime += dt;

      if (this._t >= 1) {
        this._t = 1;
        this._endRound();
      }
    } else {
      // READY：火车停在起点，相机对齐，摩天轮缓慢自转
      this._placeTrain(0);
      this._updateCamera(dt);
      this._speed = 0;
    }

    // 摩天轮缓慢自转（用单调时钟 → 暂停/结算即停）
    if (this._wheel) this._wheel.rotation.z = this._clock * 0.12;
  }

  /* ------------------------------------------------------------------------ */
  /* onInteract：本玩法没有交互                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * 纯观景项目，不做任何点击收集。保留空实现以满足 IAttraction 契约。
   * @param {Object} _hitInfo InteractionManager 的拾取结果（忽略）
   */
  onInteract(_hitInfo) {
    /* 无交互 */
  }

  /* ------------------------------------------------------------------------ */
  /* 预热                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 把轨道 / 火车 / 方块游乐场的全部材质送进渲染管线一次，且不改变乘坐进度。
   * 流程：复位 → 两个位姿采样（覆盖 getPointAt / getTangentAt / 压弯 / 相机）
   * → renderer.compile → 复位回 READY。
   */
  warmUp() {
    if (this._disposed) return;

    const renderer = this._ctx?.renderer;
    const scene = this._ctx?.scene;
    const camera = this._ctx?.camera;

    this._resetRide();

    // ① 采样两处位姿：把轨道高段 / 交叉段 / 相机的矩阵路径都走一遍
    this._speed = this._speedMax;
    this._placeTrain(0.46);
    this._updateCamera(0.016, true);
    this._placeTrain(0.88);
    this._updateCamera(0.016, true);

    // ② 强制编译（用真实 scene，保证灯光数量与正式渲染一致）
    let compiled = false;
    if (renderer && typeof renderer.compile === 'function' && scene && camera) {
      try {
        renderer.compile(scene, camera);
        compiled = true;
      } catch (err) {
        console.warn('[TrainRide:warmUp] renderer.compile 失败（不影响正式 renderOnce 上传）：', err);
      }
    }

    // ③ 复位回起点（不改变任何进度 / 状态）
    this._resetRide();
    this._setState(STATE.READY);

    console.info(
      `[TrainRide:warmUp] 预热完成 | compile=${compiled ? '是' : '否'} | ` +
      `几何 ${this._geometries.size} / 材质 ${this._materials.size} / 纹理 ${this._textures.size} | ` +
      `进度复位 t=${this._t} state=${this._state}`
    );
  }

  /* ------------------------------------------------------------------------ */
  /* dispose：七步清理（幂等）                                                 */
  /* ------------------------------------------------------------------------ */

  _step(label, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[TrainRide] dispose 步骤「${label}」失败（继续后续清理）：`, err);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* 0：通用暂停菜单（解绑 ESC / 移除 DOM / 恢复运行） */
    this._step('暂停菜单', () => this._pauseMenu?.dispose());
    this._pauseMenu = null;

    /* 1：相机恢复（位置 / 四元数 / up / fov / 旋转顺序） */
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

    /* 2：定时器（本玩法未使用 interval / timeout，保持与其它项目同构的显式断言） */
    this._step('定时器', () => {
      console.info('[TrainRide] 定时器：本项目未创建任何 interval/timeout');
    });

    /* 3：事件监听 + DOM 覆盖层 */
    this._step('事件与UI', () => {
      this._removeAllListeners();
      this._uiRoot?.remove();
      this._uiStyle?.remove();
      this._uiRoot = null;
      this._uiStyle = null;
      this._ui = {};
    });

    /* 4：物理（无 Rapier） */
    this._step('物理', () => {
      console.info('[TrainRide] 物理资源：未使用 Rapier，刚体 0 / collider 0');
    });

    /* 5：GPU 资源 */
    this._step('GPU资源', () => this._disposeThreeResources());

    /* 6：台账 / 场景对象引用 */
    this._step('台账清空', () => {
      this.root.clear(); // 从 scene 移除仍由 AttractionManager 第 ③ 步负责
      this._train = null;
      this._wheel = null;
      this._curve = null;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
      this._shared = {};
      this._state = STATE.OVER;
    });

    /* 7：上下文与数学对象 */
    this._step('句柄释放', () => {
      this._ctx = null;
      this._point = null;
      this._tangent = null;
      this._right = null;
      this._basisUp = null;
      this._bankedUp = null;
      this._basis = null;
      this._bankQuat = null;
      this._eye = null;
      this._look = null;
      this._lapTime = 0;
      this._speed = 0;
    });

    console.info('[TrainRide] dispose 完成：相机 / 监听 / DOM+CSS / GPU 资源 / 台账 全部清理');
  }

  /** Three 资源释放：台账 + root.traverse 兜底；InstancedMesh 额外释放实例缓冲 */
  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);
    const sceneEnvironment = this._ctx?.scene?.environment ?? null;

    this.root.traverse((object) => {
      if (!object.isMesh && !object.isLine && !object.isPoints) return;
      if (object.geometry) geometries.add(object.geometry);
      const material = object.material;
      if (Array.isArray(material)) material.forEach((item) => item && materials.add(item));
      else if (material) materials.add(material);
    });

    // 实例缓冲（instanceMatrix）独立于几何体，先释放
    this.root.traverse((object) => {
      if (object.isInstancedMesh && typeof object.dispose === 'function') {
        try { object.dispose(); } catch (err) { console.error('[TrainRide] InstancedMesh dispose 失败：', err); }
      }
    });

    // 纹理：标准槽位 + uniforms 递归；引用路径不去重，释放计划 Map 去重
    const references = [];
    let index = 0;
    for (const material of materials) {
      references.push(...collectMaterialTextureReferences(material, index));
      index += 1;
    }

    const texturePlan = new Map();
    const addTexture = (texture, source) => {
      if (!texture || !texture.isTexture) return;
      if (texture === sceneEnvironment) return; // 共享环境贴图归 SceneManager
      if (!texturePlan.has(texture)) texturePlan.set(texture, { sources: [] });
      texturePlan.get(texture).sources.push(source);
    };
    for (const texture of this._textures) addTexture(texture, '台账');
    for (const reference of references) addTexture(reference.texture, reference.path);

    for (const texture of texturePlan.keys()) {
      try { texture.dispose(); } catch (err) { console.error('[TrainRide:纹理] dispose 失败：', err); }
    }
    for (const reference of references) {
      try { reference.clear(); } catch (err) { console.error(`[TrainRide:纹理] 断开引用 ${reference.path} 失败：`, err); }
    }

    for (const material of materials) {
      try { material.dispose(); } catch (err) { console.error('[TrainRide] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[TrainRide] 几何体 dispose 失败：', err); }
    }

    console.info(
      `[TrainRide] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} texture=${texturePlan.size}`
    );
  }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export default TrainRide;
