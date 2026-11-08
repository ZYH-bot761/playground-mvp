/**
 * ============================================================================
 * BouncingBall —— 弹跳球（第四个游乐项目，单文件闭环）
 * ============================================================================
 * 玩法：夜色竞技场中央悬着一颗高金属度大弹跳球，地面有 3 个发光目标区与 5 个
 *       低多边形障碍箱。按住球体向后拖拽蓄力、松手把球甩出去；球撞障碍会被
 *       弹开并炸出碎片，穿过目标区光柱即 +10 分并立刻复位。30 秒倒计时结束
 *       后结算，可「再玩一次」或「返回游乐场」。
 *
 * 【单文件闭环】
 *   场景、物理、状态机、计分、特效、UI（DOM + CSS）、资源台账、清理全部写在
 *   本类内。只读使用 ctx 里的 scene / camera / renderer / RAPIER / world，
 *   不 import 也不修改 core/ 下任何模块，不新增任何第三方依赖。
 *
 * 【IAttraction 契约（src/attractions/IAttraction.js）】
 *   init(ctx) / update(dt) / onInteract(hitInfo) / dispose() 四方法齐全；
 *   root 挂到 ctx.scene，最终由 AttractionManager 第 ③ 步 scene.remove(root)；
 *   dispose() 幂等（_disposed 锁）；★ 项目内绝不调用 world.step()，物理推进
 *   由 PhysicsManager.step() 独占（契约硬性要求，双步进会导致速度翻倍与刚体
 *   卸载残留）。
 *
 * 【为什么不用 EventQueue，而用 world.intersectionPair】
 *   Rapier 0.21 的 EventQueue 只对「显式开启 ActiveEvents 的碰撞对」产出事件，
 *   还要额外维护 drain 时机；而本玩法只需要一个布尔判定「球此刻是否在目标区
 *   体积内」。intersectionPair(c1, c2) 的语义（dist/pipeline/world.d.ts:541）：
 *   「当 c1 与 c2 相交且至少一方是 sensor 时返回 true」——目标区正是 Fixed
 *   sensor，因此每帧直接查询即可，零事件队列、零额外分配、天然幂等。
 *   障碍物的撞击特效同样不依赖事件：球是半径已知的球体、障碍是轴对齐长方体，
 *   用「球心到 OBB 的最近距离 ≤ 半径 + 接触容差」做巡检，比订阅接触事件更
 *   可控（能精确控制每次撞击的特效冷却，不会被接触点的抖动刷屏）。
 *
 * 【物理参数依据（全部来自 node_modules 的类型定义，非记忆猜测）】
 *   - RigidBodyDesc.dynamic() / .setCcdEnabled(true) / .setLinearDamping()
 *     / .setAngularDamping()：dynamics/rigid_body.d.ts:703/792/801/819
 *   - ColliderDesc.ball() / .cuboid() / .cylinder() / .setDensity()
 *     / .setRestitution() / .setFriction() / .setSensor()
 *     / .setActiveCollisionTypes()：geometry/collider.d.ts:700/768/794/916/946/
 *       954/890/1009
 *   - world.intersectionPair(c1, c2)：pipeline/world.d.ts:545
 *   - body.applyImpulse(v, wakeUp)：dynamics/rigid_body.d.ts:541
 *
 *   · 球半径 0.55、密度 1.0 → 质量 4/3·π·0.55³ ≈ 0.697 kg。
 *     冲量上限 9.6 N·s ⇒ Δv ≈ 13.8 m/s，30 秒内足以横穿 24m 见方的场地；
 *     下限 1.6 N·s ⇒ Δv ≈ 2.3 m/s，保证轻点也有明确反馈。
 *   · 线性阻尼 0.12（低阻尼）：让球出手后仍能保持 ~85% 速度飞行 2 秒，
 *     既不会「一推就飘走」也不会「推不动」。角阻尼 0.35 只为让滚动自然停下。
 *   · restitution 0.8（球）/ 0.85（障碍与地面）：Rapier 默认合并规则是平均值，
 *     球×地面 ≈ 0.775、球×障碍 ≈ 0.825，接近真实橡胶球的手感又不至于永不静止。
 *   · CCD 必开：球最高速 13.8 m/s，60fps 下单帧位移 0.23m，看似小于球直径，
 *     但在拖拽瞬间与低帧率（移动端 30fps）下位移可达 0.46m，接近球直径；
 *     关闭 CCD 会在薄障碍上出现穿插。开启后 Rapier 用 shape-cast + 子步修正。
 *     本项目的障碍最小厚度 1.1m > 2×半径 1.1m，两层保险。
 *   · ActiveCollisionTypes.ALL = 60943（DYNAMIC_DYNAMIC=1 | DYNAMIC_FIXED=2 |
 *     DYNAMIC_KINEMATIC=12 | KINEMATIC_FIXED=8704 | FIXED_FIXED=32 | …）。
 *     DEFAULT=15 已包含 DYNAMIC_FIXED，理论上足够；这里显式写 ALL 是为了让
 *     「球(dynamic) × 目标(Fixed sensor)」的 intersectionPair 不依赖版本默认
 *     值漂移，且注释里能一眼看出依据（CoinPath 踩过 DEFAULT 不含
 *     KINEMATIC_FIXED 的坑）。
 *
 * 【资源台账与清理】
 *   · GPU：几何 6 个、材质 9 个、纹理 0 张，全部进 Set 台账 + ctx.registerDisposable
 *     二次兜底；无 CanvasTexture、无 HDR、无外部图片。
 *   · 物理：球 1、地面 1、障碍 5、目标 3、粒子 24（池）——全部通过
 *     world.removeRigidBody 释放；collider 一律挂在刚体上，removeRigidBody 会
 *     级联删除，因此【绝不】再单独 removeCollider（避免 double free）。
 *   · 粒子池：24 个 Mesh 与 24 个刚体在 init 一次性建好，运行期只做
 *     setEnabled/setTranslation/setLinvel，不再 new 几何体/材质/刚体。
 * ============================================================================
 */

import * as THREE from 'three';
import audioManager from '../core/AudioManager.js';
import { IAttraction } from './IAttraction.js';
import PauseMenu from '../ui/PauseMenu.js';

/* ========================================================================== */
/* 常量（参数锁定，无占位符）                                                  */
/* ========================================================================== */

const STATE = Object.freeze({ READY: 'ready', PLAYING: 'playing', OVER: 'over' });

/** 单局时长（秒） */
const ROUND_SECONDS = 30;
/** 每次进球得分 */
const SCORE_PER_TARGET = 10;
/** 进球后的判定锁（秒）：复位球 + 清速度之后仍短暂关闭判定，杜绝同帧/邻帧重复计分 */
const GOAL_LOCK = 0.35;

/* ---- 球体 ---- */
const BALL_RADIUS = 0.55;
/** 每局开始 / 进球 / 出界时的复位点（悬空，落下即有第一跳） */
const BALL_START = Object.freeze({ x: 0, y: 3.4, z: 2.4 });
const BALL_DENSITY = 1.0;
const BALL_LINEAR_DAMPING = 0.12;
const BALL_ANGULAR_DAMPING = 0.35;
const BALL_RESTITUTION = 0.8;
const BALL_FRICTION = 0.45;

/* ---- 场地 ---- */
const FLOOR_HALF = 12; // 地面半边长 → 24×24
const FLOOR_THICKNESS = 0.2;
const FLOOR_RESTITUTION = 0.85;
/** 边界巡检：越界即复位（不扣分，纯粹防止球飞出场外后彻底看不见） */
const BOUND_XZ = FLOOR_HALF + 1;
const BOUND_Y = -10;

/* ---- 目标区 ---- */
const TARGET_RADIUS = 1.05;
/** sensor 圆柱半高 0.9 → 覆盖 y 轴 0~1.8m；球心静止在 0.55m，滚动/低弹必过 */
const TARGET_SENSOR_HALF = 0.9;
const TARGET_EMISSIVE_BASE = 1.0;
const TARGET_FLASH_DECAY = 2.4; // flash 每秒衰减量 → 约 0.42 秒闪完

/* ---- 施力 ---- */
const IMPULSE_COOLDOWN = 0.5; // 硬性要求：防连点
const MAX_DRAG_PX = 190; // 拖到 190 CSS px 即为满力
const MIN_IMPULSE = 1.6; // N·s
const MAX_IMPULSE = 9.6; // N·s
const TAP_DEAD_ZONE_PX = 8; // 位移小于此值视作「点按」而非拖拽
const TAP_IMPULSE = 2.2; // 点按轻推
const UPWARD_BIAS = 0.18; // 施力方向的最小抬升分量：避免满力砸地
const CAMERA_FORWARD_MIX = 0.45; // 拖拽向量中「向场景深处」的权重

/* ---- 粒子池 ---- */
const PARTICLE_POOL_SIZE = 24;
const PARTICLES_PER_BURST = 6;
const GOAL_BURST = 10;
const PARTICLE_LIFE_MIN = 0.55;
const PARTICLE_LIFE_MAX = 0.95;
const PARTICLE_HALF = 0.075;
/** 池中待命刚体的停放高度（远离场地，即使被意外唤醒也不会进入视野） */
const PARTICLE_PARK_Y = -30;

/* ---- 障碍撞击 ---- */
const OBSTACLE_MIN_IMPACT_SPEED = 2.2; // 低于此速度视为「贴着/蹭着」，不刷特效
const OBSTACLE_CONTACT_EPS = 0.06; // 接触容差
const OBSTACLE_FX_COOLDOWN = 0.16; // 单障碍特效冷却，防止接触点抖动刷屏

/** 三个目标区（地面坐标；颜色只影响自发光，不影响物理） */
const TARGET_LAYOUT = Object.freeze([
  { x: -4.4, z: -2.6, color: 0x2ce0b0 },
  { x: 4.4, z: -2.6, color: 0xffb347 },
  { x: 0, z: 4.6, color: 0x9a8bff },
]);

/**
 * 五个轴对齐障碍箱：hx/hy/hz 是半尺寸，中心落在 y = hy（贴地摆放）。
 * 全部避开目标区圆柱（间距 > 目标半径 + 箱体对角线），保证「先撞箱再弹进区」
 * 才是有效路径，不会出现「箱子把球挤进传感器刷分」。
 */
const OBSTACLE_LAYOUT = Object.freeze([
  { x: 0, z: -1.0, hx: 0.7, hy: 0.85, hz: 0.7 },
  { x: -2.6, z: 1.4, hx: 0.65, hy: 0.7, hz: 0.65 },
  { x: 2.7, z: 1.5, hx: 0.6, hy: 0.55, hz: 0.95 },
  { x: -3.0, z: -5.2, hx: 0.8, hy: 0.45, hz: 0.8 },
  { x: 3.2, z: -5.4, hx: 0.55, hy: 0.6, hz: 0.55 },
]);

/* ========================================================================== */
/* 小工具                                                                      */
/* ========================================================================== */

/** 数值夹取（避免在热路径里用 Math.min/Math.max 嵌套） */
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 向量槽位逐个读取纹理 slot（MeshStandardMaterial 的标准槽位，不含 uniforms） */
const STANDARD_TEXTURE_SLOTS = Object.freeze([
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap', 'specularMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'anisotropyMap', 'iridescenceMap',
  'iridescenceThicknessMap', 'specularColorMap',
]);

/**
 * 递归扫描任意值里的 THREE.Texture，输出【不去重】的可断开引用路径。
 * 目的：ShaderMaterial.uniforms 里可能挂着 Texture、Texture[] 或结构体数组，
 * 只扫标准槽位会漏掉（IAttraction 契约第 3 条明确要求下钻 uniforms）。
 * @param {*} value 待扫描值
 * @param {string} path 当前路径（用于日志定位）
 * @param {Array<{texture: THREE.Texture, path: string, clear: Function}>} out 输出
 * @param {WeakSet<Object>} seen 环引用防护
 * @param {number} depth 递归深度上限
 * @param {(next: null) => void} replacer 断开引用写回器
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
      scanTextureValue(value[i], `${path}[${i}]`, out, seen, depth + 1, (next) => { value[i] = next; });
    }
    return;
  }
  for (const key of Object.keys(value)) {
    scanTextureValue(value[key], `${path}.${key}`, out, seen, depth + 1, (next) => { value[key] = next; });
  }
}

/**
 * 收集单个材质里的全部纹理引用（标准槽位 + uniforms 深度扫描）。
 * 本项目当前纹理数为 0，但契约要求释放逻辑对「以后加贴图」同样成立，
 * 因此保留这条通用路径，而不是写死「没有纹理所以不用管」。
 * @param {THREE.Material} material
 * @param {number} index 材质序号（仅用于路径可读性）
 * @returns {Array<{texture: THREE.Texture, path: string, clear: Function}>}
 */
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

/* 施力方向计算用的模块级临时向量：只在用户松手那一次用到，避免每帧分配 */
const _vRight = new THREE.Vector3();
const _vUp = new THREE.Vector3();
const _vForward = new THREE.Vector3();
const _vDir = new THREE.Vector3();

/* ========================================================================== */
/* UI 样式（类内注入 <style>，dispose 时整段移除）                              */
/* ========================================================================== */

const UI_CSS = `
.bb-ui{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
  color:#eef3ff;-webkit-tap-highlight-color:transparent;
  --bb-safe-top:env(safe-area-inset-top,0px);
  --bb-safe-bottom:env(safe-area-inset-bottom,0px);
  --bb-safe-left:env(safe-area-inset-left,0px);
  --bb-safe-right:env(safe-area-inset-right,0px)}
.bb-hud{position:absolute;top:calc(12px + var(--bb-safe-top));left:50%;
  transform:translateX(-50%);display:flex;gap:14px;align-items:center;
  white-space:nowrap;padding:9px 18px;border-radius:999px;
  background:rgba(12,18,34,.82);border:1px solid rgba(140,205,255,.32);
  box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:15px;letter-spacing:.5px}
.bb-hud b{color:#8fdcff;font-size:18px}
.bb-hud[data-hidden='true']{display:none}
.bb-hint{position:absolute;left:50%;transform:translateX(-50%);
  bottom:calc(16px + var(--bb-safe-bottom));padding:7px 14px;border-radius:999px;
  font-size:12px;line-height:1.5;white-space:nowrap;
  background:rgba(10,16,30,.72);border:1px solid rgba(140,205,255,.22);
  color:#a9bcdd;transition:color .18s,border-color .18s}
.bb-hint[data-cooling='true']{color:#ffb27a;border-color:rgba(255,150,90,.45)}
.bb-hint[data-warn='true']{color:#ff8f7a;border-color:rgba(255,110,90,.7)}
.bb-hint[data-hidden='true']{display:none}
.bb-power{position:absolute;left:50%;transform:translateX(-50%);
  bottom:calc(52px + var(--bb-safe-bottom));width:min(220px,52vw);height:8px;
  border-radius:999px;overflow:hidden;background:rgba(10,16,30,.8);
  border:1px solid rgba(140,205,255,.3);opacity:0;transition:opacity .12s}
.bb-power[data-visible='true']{opacity:1}
.bb-power i{display:block;height:100%;width:0;border-radius:999px;
  background:linear-gradient(90deg,#5ad1ff,#ffd166 70%,#ff8a5c)}
.bb-shade{position:absolute;inset:0;background:rgba(6,10,22,.55)}
.bb-shade[data-hidden='true']{display:none}
.bb-panel{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  pointer-events:auto;padding:24px 26px 20px;text-align:center;
  width:min(440px,calc(100vw - 40px - var(--bb-safe-left) - var(--bb-safe-right)));
  max-height:min(88vh,calc(100vh - 32px - var(--bb-safe-top) - var(--bb-safe-bottom)));
  overflow-y:auto;background:rgba(14,20,38,.95);
  border:1px solid rgba(140,205,255,.38);border-radius:16px;
  box-shadow:0 20px 60px rgba(0,0,0,.55)}
.bb-panel[data-hidden='true']{display:none}
.bb-panel__title{margin:0 0 10px;font-size:26px;font-weight:700;color:#9fe4ff;
  text-shadow:0 0 18px rgba(90,200,255,.35)}
.bb-panel__desc{margin:0 0 8px;font-size:14px;line-height:1.6;color:#c8d6f5}
.bb-panel__hint{margin:0 0 14px;font-size:12px;line-height:1.7;color:#8fa4cf}
.bb-panel__score{margin:0 0 16px;padding:12px;border-radius:10px;
  background:rgba(120,160,255,.12);font-size:15px;line-height:1.9}
.bb-panel__score[data-hidden='true']{display:none}
.bb-panel__score b{color:#ffce6a;font-size:19px}
.bb-panel__buttons{display:flex;gap:10px;justify-content:center;margin-bottom:12px}
.bb-btn{flex:1;min-height:44px;padding:10px 12px;font-size:14px;border-radius:9px;
  cursor:pointer;color:#dbe6ff;background:rgba(255,255,255,.08);
  border:1px solid rgba(160,190,255,.4);touch-action:manipulation}
.bb-btn:hover{background:rgba(140,180,255,.22);border-color:rgba(190,215,255,.7)}
.bb-btn--primary{color:#10162a;font-weight:700;background:#8fdcff;border-color:#8fdcff}
.bb-btn--primary:hover{background:#aee9ff;border-color:#aee9ff}
.bb-btn--exit{color:#ffe9b0;background:rgba(255,200,90,.14);border-color:rgba(255,200,90,.55)}
.bb-btn[data-hidden='true']{display:none}
@media (max-width:480px){
  .bb-hud{top:calc(8px + var(--bb-safe-top));gap:9px;font-size:13px;padding:7px 12px}
  .bb-hud b{font-size:15px}
  .bb-hint{font-size:11px;padding:6px 10px}
  .bb-panel{padding:18px 16px 16px}
  .bb-panel__title{font-size:21px}
  .bb-panel__desc{font-size:13px}
}
@media (max-height:430px) and (orientation:landscape){
  .bb-hud{top:calc(6px + var(--bb-safe-top));font-size:12px;padding:6px 10px;gap:8px}
  .bb-hint{bottom:calc(8px + var(--bb-safe-bottom));font-size:11px}
  .bb-panel{padding:14px 16px 12px}
  .bb-panel__title{font-size:19px;margin-bottom:6px}
  .bb-panel__hint{display:none}
  .bb-panel__score{margin-bottom:10px;padding:9px}
}
`;

/* ========================================================================== */
/* 项目实现                                                                    */
/* ========================================================================== */

export class BouncingBall extends IAttraction {
  /* ------------------------------------------------------------------------ */
  /* 指针 / 键盘处理器：全部定义为「具名类字段」（每个实例一份稳定引用），     */
  /* dispose 时按同一引用 removeEventListener，不依赖匿名函数                */
  /* ------------------------------------------------------------------------ */

  /**
   * 按下：射线命中球体才进入拖拽。命中即 preventDefault（避免长按选中 / 手势），
   * 但【仅在命中时】阻止，未命中球体的点击仍会正常落到 InteractionManager。
   * @param {PointerEvent} event
   */
  _onPointerDown = (event) => {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    const canvas = this._ctx?.renderer?.domElement;
    if (!canvas || event.target !== canvas) return; // 压在 UI 面板上的按下不进入拖拽
    if (event.pointerType === 'mouse' && event.button !== 0) return; // 仅鼠标左键
    if (this._drag.active) return; // 单指拖拽：忽略第二根手指 / 第二个鼠标键

    if (!this._pickBall(event)) return;

    if (event.cancelable) event.preventDefault();

    this._drag.active = true;
    this._drag.pointerId = event.pointerId;
    this._drag.startX = event.clientX;
    this._drag.startY = event.clientY;
    this._drag.x = event.clientX;
    this._drag.y = event.clientY;

    // 指针捕获：手指移出画布也能继续收到 move/up（部分浏览器不支持则静默降级，
    // 由 window 上的 pointerup 兜底）
    try {
      if (typeof canvas.setPointerCapture === 'function') {
        canvas.setPointerCapture(event.pointerId);
        this._drag.captured = true;
      }
    } catch {
      this._drag.captured = false;
    }

    this._setPower(0, true);
  };

  /**
   * 移动：只累计拖拽向量并刷新力度条，不产生任何物理调用（松手才施力）。
   * @param {PointerEvent} event
   */
  _onPointerMove = (event) => {
    if (this._disposed || !this._drag.active || event.pointerId !== this._drag.pointerId) return;
    this._drag.x = event.clientX;
    this._drag.y = event.clientY;
    const dist = Math.hypot(this._drag.x - this._drag.startX, this._drag.y - this._drag.startY);
    this._setPower(Math.min(1, dist / MAX_DRAG_PX), true);
    if (event.cancelable) event.preventDefault();
  };

  /**
   * 抬起：按拖拽方向 + 力度施力；位移不足死区则视为点按（轻推）。
   * 这是唯一的施力入口（pointerup），因此天然一手势一冲量；
   * 冷却再额外挡住「快速连点」。
   * @param {PointerEvent} event
   */
  _onPointerUp = (event) => {
    if (this._disposed || !this._drag.active || event.pointerId !== this._drag.pointerId) return;
    const dx = this._drag.x - this._drag.startX;
    const dy = this._drag.y - this._drag.startY;
    const dist = Math.hypot(dx, dy);
    this._endDrag(false);

    if (this._disposed || this._state !== STATE.PLAYING) return;
    if (dist < TAP_DEAD_ZONE_PX) this._applyTapImpulse();
    else this._applyDragImpulse(dx, dy);
  };

  /** 指针被系统取消（来电、手势抢占、切后台）：丢弃本次拖拽，不施力 */
  _onPointerCancel = () => {
    if (this._disposed) return;
    this._endDrag(true);
  };

  /** 键盘：空格 / 回车开局或重开；R 手动复位球（不扣分，专治球滚进死角） */
  _onKeyDown = (event) => {
    if (this._disposed) return;
    const tagName = event.target?.tagName;
    if (tagName === 'BUTTON' || tagName === 'INPUT' || tagName === 'TEXTAREA') return; // 焦点在控件上时交给原生行为
    if (event.code === 'Space' || event.code === 'Enter') {
      if (this._state === STATE.READY || this._state === STATE.OVER) {
        if (event.cancelable) event.preventDefault();
        this._startRound();
      }
      return;
    }
    if (event.code === 'KeyR' && this._state === STATE.PLAYING) {
      if (event.cancelable) event.preventDefault();
      this._resetBall();
    }
  };

  /** 窗口失焦：松开所有拖拽状态，避免回到页面时「手指还按着」的假象 */
  _onWindowBlur = () => {
    if (this._disposed) return;
    this._endDrag(true);
  };

  /** 页面切后台：同 blur；渲染循环由 SceneManager 的 Timer 自行处理 deltaTime */
  _onVisibilityChange = () => {
    if (this._disposed) return;
    if (document.hidden) this._endDrag(true);
  };

  /** 移动端长按会弹上下文菜单，命中球体时屏蔽（不影响 UI 按钮） */
  _onContextMenu = (event) => {
    if (this._disposed) return;
    if (this._drag.active && event.cancelable) event.preventDefault();
  };

  constructor() {
    super();

    /** 根节点：init 挂到 ctx.scene，卸载时由 AttractionManager 第 ③ 步移除 */
    this.root = new THREE.Group();
    this.root.name = 'BouncingBall';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._world = null;
    this._disposed = false;
    this._state = STATE.READY;

    // ---- 计时 / 计分 ----
    this._clock = 0; // 单调累计（update 内推进），用于施力冷却与 UI 警示
    this._roundTime = ROUND_SECONDS;
    this._score = 0;
    this._hits = 0;
    this._hitLock = 0; // 进球判定锁
    this._nextImpulseAt = 0; // 施力冷却到期时刻
    this._warnUntil = 0; // 冷却期内强行施力 → 提示条短暂告警
    this._scoringEnabled = true; // warmUp 期间置 false，保证试跑不参与计分

    // ---- 相机接管（dispose 最前段恢复）----
    this._cameraSaved = null;
    this._lastAspect = 0; // 视口自适应缓存：aspect 变化时才重算机位 / fov

    // ---- Three 资源台账（Set 去重；同时登记到 registry 作二次兜底）----
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._shared = {};
    this._targetMaterials = [];

    // ---- 物理台账 ----
    this._floorBody = null;
    this._ballBody = null;
    this._ballCollider = null;
    this._ballMesh = null;
    /** @type {Array<{ring: THREE.Mesh, beam: THREE.Mesh, mat: THREE.Material, x: number, z: number, flash: number, body: Object|null, collider: Object|null}>} */
    this._targets = [];
    /** @type {Array<{mesh: THREE.Mesh, x: number, y: number, z: number, hx: number, hy: number, hz: number, fxCooldown: number, body: Object|null, collider: Object|null}>} */
    this._obstacles = [];
    /** @type {Array<{mesh: THREE.Mesh, body: Object|null, collider: Object|null, alive: boolean, life: number, maxLife: number}>} */
    this._particles = [];
    this._particleCursor = 0; // 轮转分配游标（保证池内公平复用）
    this._standaloneColliders = []; // 未挂刚体的独立 collider（本项目为 0，契约兜底用）

    // ---- 拖拽状态 ----
    this._drag = { active: false, pointerId: -1, startX: 0, startY: 0, x: 0, y: 0, captured: false };
    this._raycaster = new THREE.Raycaster();
    this._pointerNdc = new THREE.Vector2(); // 拾取用的复用坐标（避免每次按下都新建）

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
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 创建场地、球、目标区、障碍、粒子池、物理刚体与 DOM UI，进入准备态。
   * 所有 GPU 资源在此一次性建完；update 只改属性，绝不在运行期新建几何/材质。
   * @param {Object} ctx IAttraction 契约上下文
   * @returns {void}
   */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;

    const { scene, camera, RAPIER, world } = ctx;
    if (!scene || !camera) throw new Error('[BouncingBall] 缺少 scene / camera');
    if (!RAPIER || !world) throw new Error('[BouncingBall] 缺少已初始化的 Rapier 世界');

    const ALL_TYPES = RAPIER.ActiveCollisionTypes && RAPIER.ActiveCollisionTypes.ALL;
    if (typeof ALL_TYPES !== 'number') {
      throw new Error('[BouncingBall] ActiveCollisionTypes.ALL 不可用，拒绝静默降级');
    }
    this._allTypes = ALL_TYPES;
    this._world = world;

    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    /* ---------- ① 接管相机（只改 ctx.camera 的运行时状态，不改 core） ---------- */
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    camera.position.set(0, 8.4, 10.4);
    camera.lookAt(0, 1.0, 0);
    camera.updateMatrixWorld(true);
    this._fitViewport(); // 竖屏立即切到适配机位，保证预热帧与正式帧一致

    /* ---------- ② 挂根节点（漏挂会造成「计数恒等基线」的假通过） ---------- */
    scene.add(this.root);

    /* ---------- ③ 共享资源池：6 几何 + 9 材质，一次性建完 ---------- */
    this._buildSharedResources();
    for (const geometry of this._geometries) register(geometry);
    for (const material of this._materials) register(material);
    for (const texture of this._textures) register(texture);

    /* ---------- ④ 静态视觉：地面 / 目标区 / 障碍箱 ---------- */
    this._buildStaticScene();

    /* ---------- ⑤ 物理：地面 / 目标 sensor / 障碍 / 球 ---------- */
    this._buildPhysics();

    /* ---------- ⑥ 粒子池：24 个 Mesh + 24 个刚体，全部预建 ---------- */
    this._buildParticlePool();

    /* ---------- ⑦ DOM UI ---------- */
    this._buildUI();
    this._pauseMenu = new PauseMenu({
      onRestart: () => this._startRound(),
      onExit: () => {
        this._pauseMenu?.dispose();
        this._ctx?.onExitAttraction?.();
      },
    }).attach();

    /* ---------- ⑧ 事件监听（具名引用，dispose 逐条解绑） ---------- */
    this._bindInputListeners();

    // HUD 刷新定时器（100ms，与 MemoryMatch 同频，避免每帧写 DOM）
    this._addInterval(() => this._renderHUD(), 100);

    // 物理清理的二次兜底：registry 在 dispose() 之后执行，本函数内部有 null 守卫
    register(() => this._removeAllPhysicsBodies());

    this._resetBall();
    this._setState(STATE.READY);

    const mass = this._readBallMass();
    console.info(
      `[BouncingBall] init 完成 | 球 r=${BALL_RADIUS} 质量≈${mass.toFixed(3)}kg ` +
      `CCD=on | 障碍=${this._obstacles.length} 目标=${this._targets.length} 粒子池=${this._particles.length} | ` +
      `几何=${this._geometries.size} 材质=${this._materials.size} 纹理=${this._textures.size} | ` +
      `ActiveCollisionTypes.ALL=${this._allTypes}`
    );
  }

  _trackGeometry(geometry) { this._geometries.add(geometry); return geometry; }
  _trackMaterial(material) { this._materials.add(material); return material; }
  _trackTexture(texture) { this._textures.add(texture); return texture; }

  /** 球质量（N·s ↔ m/s 换算与日志都用它；异常时按解析解回退） */
  _readBallMass() {
    try {
      const mass = this._ballBody?.mass?.();
      if (typeof mass === 'number' && mass > 0) return mass;
    } catch {
      // 忽略：回退到解析解
    }
    return BALL_DENSITY * (4 / 3) * Math.PI * BALL_RADIUS ** 3;
  }

  /**
   * 共享几何与材质。注意渲染器只统计「已上传」对象，因此这里建好的资源
   * 必须在本局至少被渲染一帧，warmUp() 会负责把它们全部点亮。
   */
  _buildSharedResources() {
    const geoFloor = this._trackGeometry(new THREE.BoxGeometry(FLOOR_HALF * 2, FLOOR_THICKNESS, FLOOR_HALF * 2));
    const geoObstacle = this._trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    const geoBall = this._trackGeometry(new THREE.SphereGeometry(BALL_RADIUS, 32, 20));
    const geoTargetRing = this._trackGeometry(new THREE.RingGeometry(0.6, TARGET_RADIUS, 48));
    const geoBeam = this._trackGeometry(new THREE.CylinderGeometry(0.85, 0.85, TARGET_SENSOR_HALF * 2, 20, 1, true));
    const geoParticle = this._trackGeometry(
      new THREE.BoxGeometry(PARTICLE_HALF * 2, PARTICLE_HALF * 2, PARTICLE_HALF * 2),
    );

    const matFloor = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x0e1526, metalness: 0.45, roughness: 0.72,
    }));
    const matObstacle = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x2a3552, metalness: 0.55, roughness: 0.42,
      emissive: 0x101a2e, emissiveIntensity: 0.55,
    }));
    // 高 metalness + 中等 roughness：靠 scene.environment 出金属反射形状，
    // 而不是靠 emissive 硬发光（避免与 Bloom 阈值叠加把球糊成光斑）
    const matBall = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x8fdcff, metalness: 0.92, roughness: 0.34,
      emissive: 0x0a2a45, emissiveIntensity: 0.65,
    }));
    const matBeam = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x0a1a22, emissive: 0x2ce0b0, emissiveIntensity: 0.75,
      metalness: 0, roughness: 0.9, transparent: true, opacity: 0.08,
      side: THREE.DoubleSide, depthWrite: false,
    }));

    // 每个目标区一份独立材质：进球时只让「被穿过的那个」emissive 闪烁
    for (const layout of TARGET_LAYOUT) {
      this._targetMaterials.push(this._trackMaterial(new THREE.MeshStandardMaterial({
        color: 0x07141a, emissive: layout.color,
        emissiveIntensity: TARGET_EMISSIVE_BASE, metalness: 0, roughness: 0.6,
        transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false,
      })));
    }

    // 碎片三色共享材质（粒子池轮转取用 → warmUp 一次 burst 就能覆盖三种）
    const matParticles = [
      this._trackMaterial(new THREE.MeshStandardMaterial({
        color: 0xffd166, emissive: 0xffb020, emissiveIntensity: 1.25, metalness: 0.4, roughness: 0.5,
      })),
      this._trackMaterial(new THREE.MeshStandardMaterial({
        color: 0x6fe3ff, emissive: 0x2ea8ff, emissiveIntensity: 1.15, metalness: 0.4, roughness: 0.5,
      })),
      this._trackMaterial(new THREE.MeshStandardMaterial({
        color: 0xf2f6ff, emissive: 0xa8c8ff, emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.4,
      })),
    ];

    this._shared = {
      geoFloor, geoObstacle, geoBall, geoTargetRing, geoBeam, geoParticle,
      matFloor, matObstacle, matBall, matBeam, matParticles,
    };
  }

  /** 地面 + 三个目标区（发光环 + 半透明光柱）+ 五个障碍箱 + 球体 */
  _buildStaticScene() {
    const S = this._shared;

    const floor = new THREE.Mesh(S.geoFloor, S.matFloor);
    floor.name = 'BouncingBall/floor';
    floor.position.set(0, -FLOOR_THICKNESS / 2, 0);
    floor.receiveShadow = true;
    this.root.add(floor);

    TARGET_LAYOUT.forEach((layout, index) => {
      const mat = this._targetMaterials[index];

      const ring = new THREE.Mesh(S.geoTargetRing, mat);
      ring.name = `BouncingBall/target-${index}`;
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(layout.x, 0.02, layout.z); // 抬高 2cm 防 z-fighting
      this.root.add(ring);

      const beam = new THREE.Mesh(S.geoBeam, S.matBeam);
      beam.name = `BouncingBall/target-beam-${index}`;
      beam.position.set(layout.x, TARGET_SENSOR_HALF, layout.z); // 与 sensor 圆柱同体积
      this.root.add(beam);

      this._targets.push({
        ring,
        beam,
        mat,
        x: layout.x,
        z: layout.z,
        flash: 0,
        body: null,
        collider: null,
      });
    });

    for (const spec of OBSTACLE_LAYOUT) {
      // 共享 1×1×1 BoxGeometry + mesh.scale 实现不同长宽高：省几何体，draw call 不变
      const mesh = new THREE.Mesh(S.geoObstacle, S.matObstacle);
      mesh.name = 'BouncingBall/obstacle';
      mesh.scale.set(spec.hx * 2, spec.hy * 2, spec.hz * 2);
      mesh.position.set(spec.x, spec.hy, spec.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);

      this._obstacles.push({
        mesh,
        x: spec.x,
        y: spec.hy,
        z: spec.z,
        hx: spec.hx,
        hy: spec.hy,
        hz: spec.hz,
        fxCooldown: 0,
        body: null,
        collider: null,
      });
    }
  }

  /**
   * 创建全部物理刚体。所有 collider 都挂在刚体上（不独立创建），
   * 因此卸载时只需 removeRigidBody，由 Rapier 级联删除 collider。
   * @returns {void}
   */
  _buildPhysics() {
    const RAPIER = this._ctx.RAPIER;
    const world = this._world;
    const ALL = this._allTypes;

    /* ---------- 地面：Fixed（球弹跳与碎片视觉都靠它兜底） ---------- */
    const floorBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -FLOOR_THICKNESS / 2, 0),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(FLOOR_HALF, FLOOR_THICKNESS / 2, FLOOR_HALF)
        .setRestitution(FLOOR_RESTITUTION)
        .setFriction(0.55),
      floorBody,
    );
    this._floorBody = floorBody;

    /* ---------- 目标区：Fixed + sensor（只做判定，不产生接触力） ---------- */
    for (const target of this._targets) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(target.x, TARGET_SENSOR_HALF, target.z),
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cylinder(TARGET_SENSOR_HALF, TARGET_RADIUS)
          .setSensor(true) // 仅判定；放在实体球路径上也不阻挡
          .setActiveCollisionTypes(ALL) // 显式 ALL，确保 intersectionPair 不受版本默认值影响
          .setFriction(0.2)
          .setRestitution(0.0),
        body,
      );
      target.body = body;
      target.collider = collider;
    }

    /* ---------- 障碍：Fixed + 实体 cuboid（球会被真实弹开） ---------- */
    for (const obstacle of this._obstacles) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(obstacle.x, obstacle.y, obstacle.z),
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(obstacle.hx, obstacle.hy, obstacle.hz)
          .setRestitution(0.85)
          .setFriction(0.4)
          .setActiveCollisionTypes(ALL),
        body,
      );
      obstacle.body = body;
      obstacle.collider = collider;
    }

    /* ---------- 球：Dynamic + CCD ---------- */
    const ballBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(BALL_START.x, BALL_START.y, BALL_START.z)
        .setLinearDamping(BALL_LINEAR_DAMPING)
        .setAngularDamping(BALL_ANGULAR_DAMPING)
        .setCcdEnabled(true), // ★ 防穿透：高速拖拽 + 低帧率下必备
    );
    const ballCollider = world.createCollider(
      RAPIER.ColliderDesc.ball(BALL_RADIUS)
        .setDensity(BALL_DENSITY)
        .setRestitution(BALL_RESTITUTION)
        .setFriction(BALL_FRICTION)
        .setActiveCollisionTypes(ALL),
      ballBody,
    );
    this._ballBody = ballBody;
    this._ballCollider = ballCollider;

    // 球体视觉：几何/材质来自共享池，整个项目只有这一个球
    const ballMesh = new THREE.Mesh(this._shared.geoBall, this._shared.matBall);
    ballMesh.name = 'BouncingBall/ball';
    ballMesh.castShadow = true;
    ballMesh.receiveShadow = true;
    this.root.add(ballMesh);
    this._ballMesh = ballMesh;
  }

  /**
   * 粒子池：init 一次性建好 24 个 Mesh 与 24 个 Dynamic sensor 刚体并全部 disable。
   * 运行期碰撞/进球只做「找空槽 → setEnabled(true) → setTranslation/setLinvel」，
   * 不 new 几何体、不 new 材质、不 new 刚体。
   */
  _buildParticlePool() {
    const RAPIER = this._ctx.RAPIER;
    const world = this._world;
    const S = this._shared;

    for (let i = 0; i < PARTICLE_POOL_SIZE; i += 1) {
      // 池内唯一一次 new Mesh；几何与材质全部共享
      const mesh = new THREE.Mesh(S.geoParticle, S.matParticles[i % S.matParticles.length]);
      mesh.name = `BouncingBall/particle-${i}`;
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.root.add(mesh);

      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, PARTICLE_PARK_Y - i * 0.4, 0)
          .setLinearDamping(0.55)
          .setAngularDamping(0.4)
          .setGravityScale(0.45), // 碎片轻飘，生命周期内不会垂直坠落太深
      );
      // sensor：碎片不参与任何接触求解，只做视觉（也不参与 intersectionPair 计分）
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(PARTICLE_HALF, PARTICLE_HALF, PARTICLE_HALF).setSensor(true),
        body,
      );
      body.setEnabled(false); // 池中待命：不参与积分，不占物理预算

      this._particles.push({
        mesh,
        body,
        collider,
        alive: false,
        life: 0,
        maxLife: 1,
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
    const id = setTimeout(() => {
      this._timeoutIds.delete(id);
      fn();
    }, ms);
    this._timeoutIds.add(id);
    return id;
  }

  /**
   * 注册 DOM 监听并记账；options 原样保存，保证 removeEventListener 参数一致
   * （passive 不参与匹配，但 capture 会，因此整体存下最稳妥）。
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListener} fn
   * @param {boolean|AddEventListenerOptions} [options]
   */
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

  _clearAllTimers() {
    for (const id of this._rafIds) cancelAnimationFrame(id);
    for (const id of this._intervalIds) clearInterval(id);
    for (const id of this._timeoutIds) clearTimeout(id);
    this._rafIds.clear();
    this._intervalIds.clear();
    this._timeoutIds.clear();
  }

  /** 键盘 / 指针 / 生命周期事件统一挂载（画布上的 pointerdown 是主入口） */
  _bindInputListeners() {
    const canvas = this._ctx?.renderer?.domElement;
    this._canvas = canvas || null;
    if (canvas) {
      // passive:false —— 命中球体时需要 preventDefault 抑制滚动手势
      this._addListener(canvas, 'pointerdown', this._onPointerDown, { passive: false });
      this._addListener(canvas, 'pointermove', this._onPointerMove, { passive: false });
      this._addListener(canvas, 'contextmenu', this._onContextMenu);
    }
    // 抬手挂在 window：指针捕获失败 / 移出画布时仍能收到
    this._addListener(window, 'pointerup', this._onPointerUp);
    this._addListener(window, 'pointercancel', this._onPointerCancel);
    this._addListener(window, 'keydown', this._onKeyDown);
    this._addListener(window, 'blur', this._onWindowBlur);
    this._addListener(document, 'visibilitychange', this._onVisibilityChange);
  }

  /* ------------------------------------------------------------------------ */
  /* UI                                                                       */
  /* ------------------------------------------------------------------------ */

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'bb-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'bb-ui';
    this._uiRoot.innerHTML = `
      <div class="bb-hud" data-role="hud">
        <span>剩余 <b data-role="time">30.0</b>s</span>
        <span>得分 <b data-role="score">0</b></span>
        <span>命中 <b data-role="hits">0</b></span>
      </div>
      <div class="bb-hint" data-role="hint" data-hidden="true">按住球体拖拽蓄力，松手施力 · 每次施力冷却 0.5 秒</div>
      <div class="bb-power" data-role="power" data-visible="false"><i data-role="power-fill"></i></div>
      <div class="bb-shade" data-role="shade"></div>
      <div class="bb-panel" data-role="panel">
        <h2 class="bb-panel__title" data-role="title">弹跳球</h2>
        <p class="bb-panel__desc" data-role="desc"></p>
        <p class="bb-panel__hint">按住发光弹跳球拖拽蓄力，松手把它甩向三个发光目标区（每次命中 +10 分）；障碍箱会把它弹开。30 秒内尽可能多进球，手机可直接用手指拖拽。</p>
        <div class="bb-panel__score" data-role="score-block" data-hidden="true"></div>
        <div class="bb-panel__buttons">
          <button type="button" class="bb-btn bb-btn--primary" data-action="start" data-role="primary">开始</button>
          <button type="button" class="bb-btn" data-action="restart">重新开始</button>
        </div>
        <div class="bb-panel__buttons">
          <button type="button" class="bb-btn bb-btn--exit" data-action="exit" data-role="exit" data-hidden="true">🎠 返回游乐场</button>
        </div>
      </div>
    `;
    document.body.appendChild(this._uiRoot);

    const q = (role) => this._uiRoot.querySelector(`[data-role="${role}"]`);
    this._ui = {
      hud: q('hud'),
      hint: q('hint'),
      power: q('power'),
      powerFill: q('power-fill'),
      shade: q('shade'),
      panel: q('panel'),
      title: q('title'),
      desc: q('desc'),
      scoreBlock: q('score-block'),
      time: q('time'),
      score: q('score'),
      hits: q('hits'),
      primary: q('primary'),
      exit: q('exit'),
    };

    // 单一事件委托：所有按钮共用一条监听，dispose 一次解绑
    this._addListener(this._uiRoot, 'click', (event) => {
      if (this._disposed) return;
      const button = event.target.closest?.('button[data-action]');
      if (!button || !this._uiRoot.contains(button)) return;
      const action = button.dataset.action;
      if (action === 'start') this._startRound();
      if (action === 'restart') {
        this._resetRound();
        this._setState(STATE.READY);
      }
      if (action === 'exit') {
        const exit = this._ctx?.onExitAttraction;
        if (typeof exit === 'function') exit();
        else console.warn('[BouncingBall] 缺少 ctx.onExitAttraction，无法返回游乐场');
      }
    });
  }

  /** 力度条：ratio 0~1；visible=false 时整条淡出 */
  _setPower(ratio, visible) {
    if (this._disposed || !this._ui.power) return;
    this._ui.power.dataset.visible = String(Boolean(visible));
    if (this._ui.powerFill) {
      this._ui.powerFill.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
    }
  }

  _renderHUD() {
    if (this._disposed || !this._ui.time) return;
    const timeLeft = this._state === STATE.PLAYING ? this._roundTime : ROUND_SECONDS;
    this._ui.time.textContent = Math.max(0, timeLeft).toFixed(1);
    this._ui.score.textContent = String(this._score);
    this._ui.hits.textContent = String(this._hits);

    if (this._ui.hint) {
      // 冷却 / 告警都走同一份时钟，不额外开定时器
      this._ui.hint.dataset.cooling = String(this._clock < this._nextImpulseAt);
      this._ui.hint.dataset.warn = String(this._clock < this._warnUntil);
    }
  }

  /**
   * 状态切换（READY / PLAYING / OVER），只改 DOM 可见性与文案。
   * @param {'ready'|'playing'|'over'} next
   */
  _setState(next) {
    this._state = next;
    if (this._disposed || !this._ui.panel) return;

    const playing = next === STATE.PLAYING;
    this._ui.panel.dataset.hidden = String(playing);
    this._ui.shade.dataset.hidden = String(playing);
    this._ui.hud.dataset.hidden = String(next === STATE.READY);
    this._ui.hint.dataset.hidden = String(!playing);
    this._ui.exit.dataset.hidden = String(next !== STATE.OVER);
    this._setPower(0, false);

    if (next === STATE.READY) {
      this._ui.title.textContent = '弹跳球';
      this._ui.desc.textContent = '按住发光弹跳球向后拖拽蓄力，松手把球甩向场地上的三个发光目标区。物体撞击与进球都会炸出碎片。30 秒一局。';
      this._ui.primary.textContent = '开始';
      this._ui.scoreBlock.dataset.hidden = 'true';
    } else if (next === STATE.PLAYING) {
      this._ui.title.textContent = '弹跳球';
      this._ui.desc.textContent = '';
      this._ui.primary.textContent = '开始';
      this._ui.scoreBlock.dataset.hidden = 'true';
    } else {
      this._ui.title.textContent = '本局结束';
      this._ui.desc.textContent = '30 秒到，球已停下。可以再玩一次，或返回游乐场。';
      this._ui.primary.textContent = '再玩一次';
      this._ui.scoreBlock.dataset.hidden = 'false';
    }
    this._renderHUD();
  }

  /* ------------------------------------------------------------------------ */
  /* 局流程                                                                   */
  /* ------------------------------------------------------------------------ */

  _startRound() {
    if (this._disposed) return;
    this._resetRound();
    this._setState(STATE.PLAYING);
    audioManager.playClick();
    console.info(
      `[BouncingBall] 开局 | ${ROUND_SECONDS}s 倒计时 | 目标 ${this._targets.length} 个 × ${SCORE_PER_TARGET} 分 | ` +
      `障碍 ${this._obstacles.length} 个 | 施力冷却 ${IMPULSE_COOLDOWN}s`
    );
  }

  /** 复位本局所有计分/计时/特效状态，并让球回到起始点、清速度 */
  _resetRound() {
    this._roundTime = ROUND_SECONDS;
    this._score = 0;
    this._hits = 0;
    this._hitLock = 0;
    this._nextImpulseAt = 0;
    this._warnUntil = 0;

    for (const obstacle of this._obstacles) obstacle.fxCooldown = 0;
    for (const target of this._targets) {
      target.flash = 0;
      target.mat.emissiveIntensity = TARGET_EMISSIVE_BASE;
    }

    this._recycleAllParticles();
    this._resetBall();
    this._endDrag(true);
    this._renderHUD();
  }

  /**
   * 球复位：位置回起点 + 线速度/角速度全部清零。
   * 进球后立刻调用（配合 GOAL_LOCK），因此「同一目标区连续计分」在物理上不可能
   * 发生——球已经不在 sensor 体积内。
   * @param {boolean} [silent=false] 是否跳过日志（每帧巡检复位时可静音）
   */
  _resetBall(silent = false) {
    const body = this._ballBody;
    if (!body) return;
    try {
      body.setTranslation({ x: BALL_START.x, y: BALL_START.y, z: BALL_START.z }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.wakeUp();
    } catch (err) {
      console.error('[BouncingBall] 复位球失败：', err);
    }
    this._syncBallMesh();
    if (!silent) console.info('[BouncingBall] 球已复位（位置回起点，线/角速度清零）');
  }

  _endRound() {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    this._endDrag(true);
    this._setState(STATE.OVER);
    if (this._ui.scoreBlock) {
      this._ui.scoreBlock.innerHTML =
        `本局得分 <b>${this._score}</b><br>` +
        `进球 <b>${this._hits}</b> 次 × ${SCORE_PER_TARGET} 分<br>` +
        `每次进球后球会自动复位，可以继续得分`;
    }
    audioManager.playScore();
    console.info(`[BouncingBall] 结算：${this._hits} 次进球，共 ${this._score} 分`);
  }

  /* ------------------------------------------------------------------------ */
  /* 指针拾取与施力                                                           */
  /* ------------------------------------------------------------------------ */

  /**
   * 屏幕坐标 → NDC → Raycaster 命中球体。
   * 只对球一个对象做拾取：场地/障碍/目标区都不接受拖拽，避免「点地板也施力」。
   * @param {PointerEvent} event
   * @returns {boolean} 是否命中球体
   */
  _pickBall(event) {
    const camera = this._ctx?.camera;
    const canvas = this._ctx?.renderer?.domElement;
    if (!camera || !canvas || !this._ballMesh) return false;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    this._pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(this._pointerNdc, camera);
    const hits = this._raycaster.intersectObject(this._ballMesh, false);
    return hits.length > 0;
  }

  /**
   * 拖拽施力：拖拽向量 → 相机右/上基向量 + 少量「向场景深处」分量，
   * 长度换算成冲量。相机基向量保证「往右拖 → 球往画面右侧飞」，与直觉一致。
   * @param {number} dx 水平拖拽位移（CSS px）
   * @param {number} dy 垂直拖拽位移（CSS px，向下为正）
   */
  _applyDragImpulse(dx, dy) {
    if (!this._canFireImpulse()) return;
    const camera = this._ctx?.camera;
    if (!camera || !this._ballBody) return;

    const dist = Math.hypot(dx, dy);
    const strength = MIN_IMPULSE
      + (MAX_IMPULSE - MIN_IMPULSE) * Math.min(1, dist / MAX_DRAG_PX);

    _vRight.setFromMatrixColumn(camera.matrixWorld, 0); // 相机 +X
    _vUp.setFromMatrixColumn(camera.matrixWorld, 1); // 相机 +Y
    camera.getWorldDirection(_vForward); // 相机 -Z（即前向）
    _vForward.y = 0;
    if (_vForward.lengthSq() < 1e-6) _vForward.set(0, 0, -1);
    _vForward.normalize();

    // 屏幕上「向上拖」应让球飞起来：dy 为负，故取 -dy
    _vDir.set(0, 0, 0)
      .addScaledVector(_vRight, dx)
      .addScaledVector(_vUp, -dy)
      .addScaledVector(_vForward, dist * CAMERA_FORWARD_MIX);

    if (_vDir.lengthSq() < 1e-8) _vDir.copy(_vForward); // 极端情况（零向量）兜底
    _vDir.normalize();
    if (_vDir.y < UPWARD_BIAS) {
      // 保持最小抬升角：防止满力下拉时球直接砸向脚边地板
      _vDir.y = UPWARD_BIAS;
      _vDir.normalize();
    }

    this._fireImpulse(_vDir, strength);
    console.info(
      `[BouncingBall] 拖拽施力 | ${dist.toFixed(0)}px → ${strength.toFixed(2)}N·s | ` +
      `预计初速 ≈ ${(strength / this._readBallMass()).toFixed(1)}m/s`
    );
  }

  /** 点按轻推：朝相机前向 + 抬升，给小力度，保证「点一下也有反馈」 */
  _applyTapImpulse() {
    if (!this._canFireImpulse()) return;
    const camera = this._ctx?.camera;
    if (!camera || !this._ballBody) return;

    camera.getWorldDirection(_vForward);
    _vForward.y = 0;
    if (_vForward.lengthSq() < 1e-6) _vForward.set(0, 0, -1);
    _vForward.normalize();

    _vDir.copy(_vForward).setY(0.55).normalize();
    this._fireImpulse(_vDir, TAP_IMPULSE);
  }

  /**
   * 施力冷却闸门。0.5 秒内第二次施力一律拒绝，并在提示条上打一次短告警。
   * @returns {boolean} 本次是否允许施力
   */
  _canFireImpulse() {
    if (this._disposed || this._state !== STATE.PLAYING) return false;
    if (!this._ballBody) return false;
    if (this._clock < this._nextImpulseAt) {
      this._warnUntil = this._clock + 0.3;
      this._renderHUD();
      return false;
    }
    return true;
  }

  /**
   * 物理施力的唯一出口（拖拽 / 点按 / warmUp 都走这里），保证冷却只写一处。
   * @param {THREE.Vector3} direction 单位方向
   * @param {number} strength 冲量大小（N·s）
   */
  _fireImpulse(direction, strength) {
    const body = this._ballBody;
    if (!body) return;
    body.wakeUp(); // 睡着时 applyImpulse 不会自动唤醒，必须显式
    body.applyImpulse(
      { x: direction.x * strength, y: direction.y * strength, z: direction.z * strength },
      true,
    );
    this._nextImpulseAt = this._clock + IMPULSE_COOLDOWN;
    this._renderHUD();
  }

  /** 结束拖拽（含释放指针捕获 / 隐藏力度条）；cancel=true 表示本次不施力 */
  _endDrag(cancel) {
    const drag = this._drag;
    if (!drag.active) {
      if (cancel) this._setPower(0, false);
      return;
    }
    const canvas = this._canvas;
    if (drag.captured && canvas && typeof canvas.releasePointerCapture === 'function') {
      try { canvas.releasePointerCapture(drag.pointerId); } catch { /* 指针已失效 */ }
    }
    drag.active = false;
    drag.captured = false;
    drag.pointerId = -1;
    if (cancel) {
      drag.startX = 0;
      drag.startY = 0;
      drag.x = 0;
      drag.y = 0;
    }
    this._setPower(0, false);
  }

  /* ------------------------------------------------------------------------ */
  /* 每帧判定与特效                                                           */
  /* ------------------------------------------------------------------------ */

  /** 视觉位置/朝向跟随刚体（物理权威，渲染跟随；绝不反写物理） */
  _syncBallMesh() {
    const body = this._ballBody;
    const mesh = this._ballMesh;
    if (!body || !mesh) return;
    const t = body.translation();
    const r = body.rotation();
    mesh.position.set(t.x, t.y, t.z);
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }

  /**
   * 进球判定：每帧对 3 个目标 sensor 做 intersectionPair（不使用 EventQueue）。
   * 命中 → +10 分、立刻复位球、上判定锁，避免连续计分。
   */
  _checkTargets() {
    if (this._hitLock > 0 || !this._world || !this._ballCollider) return;
    for (const target of this._targets) {
      let hit = false;
      try {
        hit = this._world.intersectionPair(this._ballCollider, target.collider);
      } catch (err) {
        console.error('[BouncingBall] intersectionPair 查询失败：', err);
        continue;
      }
      if (hit) {
        this._onGoal(target);
        return; // 一帧最多结算一次
      }
    }
  }

  /**
   * 进球结算：闪目标区 + 碎片 + 计分（warmUp 期间抑制计分）+ 立即复位球。
   * @param {Object} target 目标区记录
   */
  _onGoal(target) {
    target.flash = 1; // emissive 闪烁由 update 里的衰减驱动
    this._spawnBurst({ x: target.x, y: 0.65, z: target.z }, { x: 0, y: 1, z: 0 }, GOAL_BURST);
    audioManager.playScore();

    if (this._scoringEnabled) {
      this._score += SCORE_PER_TARGET;
      this._hits += 1;
      console.info(
        `[BouncingBall] 进球 +${SCORE_PER_TARGET} 分 | 得分 ${this._score} | ` +
        `目标区 (${target.x}, ${target.z}) | 球已复位`
      );
    }

    // 顺序很关键：先复位（球离开 sensor 体积），再上锁（挡住判定）
    this._resetBall(true);
    this._hitLock = GOAL_LOCK;
    this._renderHUD();
  }

  /** 边界巡检：落地过深或飞出水平范围 → 立刻复位，防止「球不见了」 */
  _checkBounds() {
    const body = this._ballBody;
    if (!body) return;
    const t = body.translation();
    if (t.y < BOUND_Y || Math.abs(t.x) > BOUND_XZ || Math.abs(t.z) > BOUND_XZ) {
      console.warn(
        `[BouncingBall] 球越界 (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})，立即复位`
      );
      this._resetBall(true);
    }
  }

  /**
   * 障碍撞击巡检（不订阅接触事件）：
   * 球心到轴对齐 OBB 的最近距离 ≤ 半径 + 容差 且速度超过阈值 → 炸碎片。
   * 每个障碍独立 0.16s 冷却，抵消接触点抖动导致的重复触发。
   * @param {number} dt
   */
  _checkObstacleImpacts(dt) {
    const body = this._ballBody;
    if (!body) return;

    const t = body.translation();
    const v = body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);

    for (const obstacle of this._obstacles) {
      if (obstacle.fxCooldown > 0) obstacle.fxCooldown = Math.max(0, obstacle.fxCooldown - dt);
    }
    if (speed < OBSTACLE_MIN_IMPACT_SPEED) return; // 贴地慢滚不刷特效

    for (const obstacle of this._obstacles) {
      if (obstacle.fxCooldown > 0) continue;
      const cx = clamp(t.x, obstacle.x - obstacle.hx, obstacle.x + obstacle.hx);
      const cy = clamp(t.y, obstacle.y - obstacle.hy, obstacle.y + obstacle.hy);
      const cz = clamp(t.z, obstacle.z - obstacle.hz, obstacle.z + obstacle.hz);
      const dx = t.x - cx;
      const dy = t.y - cy;
      const dz = t.z - cz;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > BALL_RADIUS + OBSTACLE_CONTACT_EPS) continue;

      obstacle.fxCooldown = OBSTACLE_FX_COOLDOWN;
      const normal = distance > 1e-4
        ? { x: dx / distance, y: dy / distance, z: dz / distance }
        : { x: 0, y: 1, z: 0 };
      this._spawnBurst({ x: cx, y: cy, z: cz }, normal, PARTICLES_PER_BURST);
      audioManager.playExplode();
      console.info(`[BouncingBall] 撞击障碍 | 速度 ${speed.toFixed(1)}m/s → 碎片 ${PARTICLES_PER_BURST} 个`);
    }
  }

  /**
   * 从池里取空槽炸出一簇碎片；池满时直接放弃本次剩余碎片（绝不再 new 资源）。
   * @param {{x:number,y:number,z:number}} origin 爆点
   * @param {{x:number,y:number,z:number}} normal 主要扩散方向（单位向量）
   * @param {number} count 期望数量
   */
  _spawnBurst(origin, normal, count) {
    if (this._disposed || !this._particles.length) return;

    const want = Math.min(count, this._particles.length);
    for (let k = 0; k < want; k += 1) {
      let slot = null;
      for (let i = 0; i < this._particles.length; i += 1) {
        const index = (this._particleCursor + i) % this._particles.length;
        const candidate = this._particles[index];
        if (!candidate.alive) {
          slot = candidate;
          this._particleCursor = (index + 1) % this._particles.length;
          break;
        }
      }
      if (!slot) return; // 池满：本次剩余碎片不再生成

      slot.alive = true;
      slot.maxLife = PARTICLE_LIFE_MIN + Math.random() * (PARTICLE_LIFE_MAX - PARTICLE_LIFE_MIN);
      slot.life = slot.maxLife;
      slot.mesh.visible = true;
      slot.mesh.scale.setScalar(0.7 + Math.random() * 0.6);

      const jitter = 0.12;
      try {
        slot.body.setEnabled(true);
        slot.body.setTranslation({
          x: origin.x + (Math.random() - 0.5) * jitter,
          y: origin.y + (Math.random() - 0.5) * jitter,
          z: origin.z + (Math.random() - 0.5) * jitter,
        }, true);
        const speed = 4 + Math.random() * 3.2;
        slot.body.setLinvel({
          x: normal.x * speed + (Math.random() - 0.5) * 2.4,
          y: Math.abs(normal.y) * speed + 1.4 + Math.random() * 2.4,
          z: normal.z * speed + (Math.random() - 0.5) * 2.4,
        }, true);
        slot.body.setAngvel({
          x: (Math.random() - 0.5) * 9,
          y: (Math.random() - 0.5) * 9,
          z: (Math.random() - 0.5) * 9,
        }, true);
        slot.body.wakeUp();
      } catch (err) {
        console.error('[BouncingBall] 唤醒池内粒子失败：', err);
        slot.alive = false;
        slot.mesh.visible = false;
        return;
      }
    }
  }

  /**
   * 粒子池推进：同步刚体位置/朝向 → 寿命到期回收（setEnabled(false) 回池）。
   * @param {number} dt
   */
  _updateParticles(dt) {
    for (const slot of this._particles) {
      if (!slot.alive) continue;
      slot.life -= dt;
      if (slot.life <= 0) {
        this._recycleParticle(slot);
        continue;
      }
      const t = slot.body.translation();
      const r = slot.body.rotation();
      slot.mesh.position.set(t.x, t.y, t.z);
      slot.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** 单个碎片回池：物理 disable（不删刚体）、视觉隐藏、标记空槽 */
  _recycleParticle(slot) {
    if (!slot.alive) return;
    slot.alive = false;
    slot.life = 0;
    slot.mesh.visible = false;
    // 回池时不 removeRigidBody：刚体复用是池化的核心，移除重建反而制造抖动与开销
    try { slot.body.setEnabled(false); } catch (err) { console.error('[BouncingBall] 回收粒子失败：', err); }
  }

  _recycleAllParticles() {
    for (const slot of this._particles) this._recycleParticle(slot);
  }

  /** 目标区闪烁衰减 + 环面自转（只改材质属性/旋转，不新建资源） */
  _updateTargetFlash(dt) {
    for (const target of this._targets) {
      if (target.flash > 0) target.flash = Math.max(0, target.flash - dt * TARGET_FLASH_DECAY);
      target.mat.emissiveIntensity = TARGET_EMISSIVE_BASE + target.flash * 6;
      target.ring.rotation.z += dt * 0.4;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* onInteract                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * InteractionManager 分发的 click。本项目的拖拽由 canvas 上的 pointer 链路
   * 独立完成（pointerdown 命中球体时已 preventDefault，正常情况下不会再产生
   * click），这里作为「没有 pointer 事件的降级环境 / 程序化 click」的兜底：
   * 命中球体就给一次轻推；冷却闸门天然挡住「拖拽后紧跟的 click」重复施力。
   * @param {Object} hitInfo { event, hasHit, object, point, distance, face, uv, intersections }
   */
  onInteract(hitInfo) {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    const event = hitInfo?.event;
    const canvas = this._ctx?.renderer?.domElement;
    if (!event || !canvas || event.target !== canvas) return; // UI 按钮点击不处理
    if (this._drag.active) return;

    const intersections = hitInfo?.intersections || [];
    const hitBall = intersections.some((item) => item && item.object === this._ballMesh);
    if (!hitBall) return;
    this._applyTapImpulse();
  }

  /* ------------------------------------------------------------------------ */
  /* update                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * 视口自适应：竖屏时相机整体后退 35% 并放宽 fov，保证最外侧目标区
   * （x=±4.4 + 靶半径 1.05）完整落在画面内；桌面 aspect≥1 时回到原机位 / 55°。
   * 只在 aspect 变化时执行（旋转手机 / 拖动窗口）。
   */
  _fitViewport() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    const a = camera.aspect;
    if (Math.abs(a - this._lastAspect) < 0.01) return;
    this._lastAspect = a;

    const k = a < 1 ? 1.35 : 1;
    const camY = 8.4 * k;
    const camZ = 10.4 * k;
    camera.position.set(0, camY, camZ);
    // 视线目标略低于场地中心：把近端紫色目标区（z=+4.6）抬离画面下缘，
    // 桌面 1920 宽屏下也不再被底边裁掉一半。
    camera.lookAt(0, 0.6, 0);

    // 相机到最外侧目标区（x=±4.4, z=-2.6）的纵深
    const dist = Math.hypot(camY - 0.6, camZ + 2.6);
    const need = 5.6; // 4.4 + 靶半径 1.05 + 光晕余量
    const tanV = need / (dist * Math.min(a, 1));
    const fov = THREE.MathUtils.clamp((2 * Math.atan(tanV) * 180) / Math.PI, 55, 88);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  }

  /**
   * 由 SceneManager 统一驱动（物理已在本帧之前被 PhysicsManager 推进过）。
   * 顺序：视觉同步 → 特效/粒子 → 倒计时 → 进球判定 → 边界巡检 → 撞击巡检。
   * @param {number} deltaTime 距上一帧的秒数
   */
  update(deltaTime) {
    if (this._disposed) return;
    this._fitViewport();
    const dt = Math.min(Math.max(deltaTime, 0), 0.1); // 与 SceneManager 的夹取口径一致
    this._clock += dt;

    this._syncBallMesh();
    this._updateTargetFlash(dt);
    this._updateParticles(dt);

    if (this._hitLock > 0) this._hitLock = Math.max(0, this._hitLock - dt);

    if (this._state === STATE.PLAYING) {
      this._roundTime = Math.max(0, this._roundTime - dt);
      this._checkTargets();
      this._checkBounds();
      this._checkObstacleImpacts(dt);
      if (this._roundTime <= 0) this._endRound();
    } else {
      // READY / OVER 也做一次边界巡检：球是被物理驱动的，仍可能滚出场地
      this._checkBounds();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 预热（供 main.js 固化基线使用）                                           */
  /* ------------------------------------------------------------------------ */

  /**
   * 预热：把「所有材质都进过一次渲染管线 + 粒子池完整跑一轮生命周期 + 进球路径
   * 空跑一次」压进一帧之前，且全程不参与计分。
   *
   * 步骤：
   *   ① 复位并临时进入 PLAYING（UI 不闪面板，因为下面就不再调用 renderOnce 前的 setState）；
   *   ② 炸一簇碎片（6 个 → 覆盖粒子池 3 种共享材质各 2 个）；
   *   ③ renderer.compile(scene, camera) 强制编译/链接当前场景全部可见材质
   *      —— 必须用【真实 scene】而不是 root：compile 会按场景内灯光数量生成
   *      program 变体，用 root 编译会得到「0 灯光」的错误变体，正式渲染时再
   *      编译一次，等于白预热；
   *   ④ 推进两个碎片生命周期窗口（验证 spawn → 同步 → 回收 → 复用）；
   *   ⑤ 调用一次 _onGoal（计分已关闭）→ 目标区闪烁 + 复位球 + 判定锁；
   *   ⑥ 标记 3 个目标区全部闪烁，确保每份独立 emissive 材质都被用到；
   *   ⑦ 全部回池、复位、回到 READY，打印「试跑得分前后都是 0」的自检结果。
   *
   * 注意：renderer.compile 只负责 shader/program；纹理与缓冲的最终上传仍以
   * main.js 随后的一次 sceneManager.renderOnce() 为准（与其它项目的预热口径一致）。
   * @returns {void}
   */
  warmUp() {
    if (this._disposed) return;
    const renderer = this._ctx?.renderer;
    const scene = this._ctx?.scene;
    const camera = this._ctx?.camera;

    this._scoringEnabled = false;
    this._resetRound();
    this._setState(STATE.PLAYING);

    // 计分基线取「复位之后」的值：_resetRound 本来就会把上一局分数归零，
    // 若拿复位前分数做对比，会把「正常的开新局」误报成「预热违规计分」。
    const scoreBeforeTrial = this._score;

    // ② 一次碎片爆发（6 个 → 三种材质各 2 个，全部进入可见状态）
    this._spawnBurst({ x: 0, y: 1.2, z: 0 }, { x: 0.25, y: 1, z: 0.3 }, PARTICLES_PER_BURST);

    // ③ 强制编译（用真实 scene 保证灯光数量与正式渲染一致）
    let compiled = false;
    try {
      if (renderer && typeof renderer.compile === 'function' && scene && camera) {
        renderer.compile(scene, camera);
        compiled = true;
      }
    } catch (err) {
      console.warn('[BouncingBall:warmUp] renderer.compile 失败（不影响后续 renderOnce 上传）：', err);
    }

    // ④ 推进两个寿命窗口：第一轮让首批碎片回池，第二轮复用同一批槽位
    //    统计口径：每次 update 前后的活跃槽位差值 = 本次真正发生的回收次数
    let recycleCount = 0;
    let peakAlive = 0;
    const advance = (seconds) => {
      const steps = Math.max(1, Math.round(seconds / 0.1));
      let alive = this._particles.filter((slot) => slot.alive).length;
      peakAlive = Math.max(peakAlive, alive);
      for (let step = 0; step < steps; step += 1) {
        this._updateParticles(0.1);
        const now = this._particles.filter((slot) => slot.alive).length;
        if (now < alive) recycleCount += alive - now;
        alive = now;
        peakAlive = Math.max(peakAlive, alive);
      }
    };
    advance(1.0);
    this._spawnBurst({ x: 0, y: 1.2, z: 0 }, { x: -0.3, y: 1, z: 0.2 }, PARTICLES_PER_BURST);
    peakAlive = Math.max(peakAlive, this._particles.filter((slot) => slot.alive).length);
    advance(1.0);

    // ⑤ 进球路径空跑一次（_scoringEnabled=false → 不加分）
    if (this._targets[0]) this._onGoal(this._targets[0]);
    const scoreAfterTrial = this._score;

    // ⑥ 三个目标区全部点亮（覆盖 3 份独立 Ring 材质）
    for (const target of this._targets) target.flash = 1;
    for (let step = 0; step < 4; step += 1) this._updateTargetFlash(0.1);

    // ⑦ 收尾：回池 → 复位 → READY
    this._recycleAllParticles();
    this._resetRound();
    this._setState(STATE.READY);
    this._scoringEnabled = true;

    const scoreAfter = this._score;
    const activeBodies = this._particles.filter((slot) => slot.alive).length;
    console.info(
      `[BouncingBall:warmUp] 预热完成 | compile=${compiled ? '是' : '否'} | ` +
      `粒子池 ${PARTICLE_POOL_SIZE} 槽（峰值活跃 ${peakAlive}，回收 ${recycleCount} 次，残留 ${activeBodies}） | ` +
      `目标区 ${this._targets.length} 个已全闪 | 试跑得分 ${scoreBeforeTrial}→${scoreAfterTrial}（应为 0→0） | ` +
      `预热后局面得分 ${scoreAfter}`
    );
    if (scoreAfterTrial !== scoreBeforeTrial) {
      console.error('[BouncingBall:warmUp] 预热期间发生计分，请检查 _scoringEnabled 闸门！');
    }
  }

  /* ------------------------------------------------------------------------ */
  /* dispose —— 七步清理（幂等）                                               */
  /* ------------------------------------------------------------------------ */

  /** 单步独立 try/catch：任一步失败只记日志，绝不中断后续清理 */
  _step(label, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[BouncingBall] dispose 步骤「${label}」失败（继续后续清理）：`, err);
    }
  }

  /**
   * 释放本项目创建的一切资源。AttractionManager 随后还会执行
   * registry.disposeAll() 兜底，因此本方法必须幂等（_disposed 锁）。
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* ---------- 步骤 0：通用暂停菜单清理（解绑 ESC / 移除 DOM / 恢复运行） ---------- */
    this._step('暂停菜单清理', () => this._pauseMenu?.dispose());
    this._pauseMenu = null;

    /* ---------- 步骤 1：相机恢复（最前段，独立 try/catch） ---------- */
    this._step('相机恢复', () => {
      const camera = this._ctx?.camera;
      if (camera && this._cameraSaved) {
        camera.rotation.order = this._cameraSaved.rotationOrder;
        camera.quaternion.copy(this._cameraSaved.quaternion);
        camera.position.copy(this._cameraSaved.position);
        camera.fov = this._cameraSaved.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      }
      this._cameraSaved = null;
    });

    /* ---------- 步骤 2：清除全部定时器（HUD interval 等） ---------- */
    this._step('定时器', () => this._clearAllTimers());

    /* ---------- 步骤 3：解绑具名监听 + 移除 UI / <style> ---------- */
    this._step('事件与UI', () => {
      this._endDrag(true); // 释放指针捕获，避免捕获目标消失后卡住
      this._removeAllListeners(); // 具名处理器：pointerdown/move/up/cancel、keydown、blur、visibilitychange、contextmenu、UI click
      this._uiRoot?.remove();
      this._uiStyle?.remove();
      this._uiRoot = null;
      this._uiStyle = null;
      this._ui = {};
      this._canvas = null;
    });

    /* ---------- 步骤 4：物理（球 / 障碍 / 目标 / 粒子 / 地面） ---------- */
    this._step('物理刚体', () => this._disposePhysics());

    /* ---------- 步骤 5：GPU 资源（几何 / 材质 / 纹理） ---------- */
    this._step('GPU资源', () => this._disposeThreeResources());

    /* ---------- 步骤 6：台账与数组引用清空 ---------- */
    this._step('台账清空', () => {
      this.root.clear(); // 从 scene 移除由 AttractionManager 第 ③ 步负责
      this._targets.length = 0;
      this._obstacles.length = 0;
      this._particles.length = 0;
      this._particleCursor = 0;
      this._targetMaterials.length = 0;
      this._standaloneColliders.length = 0;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
      this._shared = {};
      this._ballMesh = null;
      this._drag = { active: false, pointerId: -1, startX: 0, startY: 0, x: 0, y: 0, captured: false };
      this._state = STATE.OVER;
      this._scoringEnabled = false;
    });

    /* ---------- 步骤 7：上下文与临时句柄释放 ---------- */
    this._step('句柄释放', () => {
      this._ctx = null;
      this._world = null;
      this._raycaster = null;
      this._hitLock = 0;
      this._nextImpulseAt = 0;
    });

    console.info(
      '[BouncingBall] dispose 完成：相机 / 定时器 / 具名监听 / DOM+CSS / 物理刚体 / GPU 资源 / 台账 全部清理'
    );
  }

  /**
   * 物理释放。★ 关键约束：所有 collider 都是在 createCollider(desc, parentBody)
   * 时挂到刚体上的，removeRigidBody 会级联删除它们；因此这里【只】调
   * removeRigidBody，绝不额外 removeCollider（否则 double free，Rapier 会崩）。
   * 每移除一个就把引用置 null，使本方法可重复调用（registry 兜底时是空操作）。
   */
  _disposePhysics() {
    const world = this._world;
    if (!world) {
      // 已被上一步移除（正常路径不会到这里，仅在兜底重复调用时发生）
      this._floorBody = null;
      this._ballBody = null;
      this._ballCollider = null;
      return;
    }

    const counts = { particle: 0, obstacle: 0, target: 0, ball: 0, floor: 0 };

    // ① 粒子：存活的和待命的都要移除刚体（池里 24 个全是本项目创建的）
    for (const slot of this._particles) {
      if (slot.body) {
        try { world.removeRigidBody(slot.body); } catch (err) { console.error('[BouncingBall] 移除粒子刚体失败：', err); }
        slot.body = null;
        slot.collider = null; // collider 已被级联删除，仅断开 JS 引用
        counts.particle += 1;
      }
      slot.alive = false;
      slot.life = 0;
      slot.mesh = null;
    }

    // ② 障碍
    for (const obstacle of this._obstacles) {
      if (obstacle.body) {
        try { world.removeRigidBody(obstacle.body); } catch (err) { console.error('[BouncingBall] 移除障碍刚体失败：', err); }
        obstacle.body = null;
        obstacle.collider = null;
        counts.obstacle += 1;
      }
    }

    // ③ 目标区（Fixed + sensor，collider 同样挂在刚体上）
    for (const target of this._targets) {
      if (target.body) {
        try { world.removeRigidBody(target.body); } catch (err) { console.error('[BouncingBall] 移除目标区刚体失败：', err); }
        target.body = null;
        target.collider = null;
        counts.target += 1;
      }
    }

    // ④ 球
    if (this._ballBody) {
      try { world.removeRigidBody(this._ballBody); } catch (err) { console.error('[BouncingBall] 移除球刚体失败：', err); }
      this._ballBody = null;
      this._ballCollider = null;
      counts.ball = 1;
    }

    // ⑤ 地面
    if (this._floorBody) {
      try { world.removeRigidBody(this._floorBody); } catch (err) { console.error('[BouncingBall] 移除地面刚体失败：', err); }
      this._floorBody = null;
      counts.floor = 1;
    }

    // ⑥ 独立创建的 collider（本项目为 0；保留分支以完整履行契约第 4 条）
    for (const collider of this._standaloneColliders) {
      try { world.removeCollider(collider, true); } catch (err) { console.error('[BouncingBall] 移除独立 collider 失败：', err); }
    }
    this._standaloneColliders.length = 0;

    this._world = null;

    console.info(
      `[BouncingBall] 物理清理 | 球=${counts.ball} 地面=${counts.floor} 障碍=${counts.obstacle} ` +
      `目标=${counts.target} 粒子=${counts.particle}（全部 removeRigidBody 级联，collider 无重复移除）`
    );
  }

  /** 供 registry 二次兜底：dispose 已清理则无操作（_world 为 null 时直接返回） */
  _removeAllPhysicsBodies() {
    if (!this._world) return;
    this._disposePhysics();
  }

  /**
   * GPU 资源释放：台账 + root.traverse 兜底；纹理按「标准槽位 + uniforms 深度扫描」
   * 收集（本项目 0 张，但路径通用），并显式跳过 SceneManager 共享的 scene.environment。
   */
  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);
    const sceneEnvironment = this._ctx?.scene?.environment ?? null;

    // traverse 兜底：防止漏登记的 mesh
    this.root.traverse((object) => {
      if (!object.isMesh && !object.isLine && !object.isPoints) return;
      if (object.geometry) geometries.add(object.geometry);
      const material = object.material;
      if (Array.isArray(material)) material.forEach((item) => item && materials.add(item));
      else if (material) materials.add(material);
    });

    // 引用路径【不去重】（每一条都要断开），释放计划【Map 去重】（同一纹理只 dispose 一次）
    const references = [];
    let index = 0;
    for (const material of materials) {
      references.push(...collectMaterialTextureReferences(material, index));
      index += 1;
    }

    const texturePlan = new Map();
    const addTexture = (texture, source) => {
      if (!texture || !texture.isTexture) return;
      if (texture === sceneEnvironment) return; // 共享环境贴图归 SceneManager，绝不在此释放
      if (!texturePlan.has(texture)) texturePlan.set(texture, { sources: [], disposeCalled: false });
      texturePlan.get(texture).sources.push(source);
    };
    for (const texture of this._textures) addTexture(texture, '台账');
    for (const reference of references) addTexture(reference.texture, reference.path);

    for (const [texture, meta] of texturePlan) {
      try {
        texture.dispose();
        meta.disposeCalled = true;
      } catch (err) {
        console.error(`[BouncingBall:纹理] uuid=${texture.uuid} dispose 失败：`, err);
      }
    }

    for (const reference of references) {
      try { reference.clear(); } catch (err) { console.error(`[BouncingBall:纹理] 断开引用 ${reference.path} 失败：`, err); }
    }

    for (const material of materials) {
      try { material.dispose(); } catch (err) { console.error('[BouncingBall] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[BouncingBall] 几何体 dispose 失败：', err); }
    }

    console.info(
      `[BouncingBall] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} ` +
      `texture=${texturePlan.size}（纹理引用路径 ${references.length} 条已断开）`
    );
  }
}

export default BouncingBall;
