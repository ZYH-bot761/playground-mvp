/**
 * ============================================================================
 * FerrisWheelEmbedView.js —— 摩天轮嵌入视图（v4 T04b-a，零 GPU 资源）
 * ============================================================================
 * 用户第 5 项：「进入后就是在摩天轮里的场景，可以四处转欣赏，看到高空的大厅美景」。
 * 本视图【不重复建模】：复用大厅常驻轮盘 `Lobby/wheel-spin`（归 Lobby 所有，绝不
 * dispose），只把相机放到某个座舱里，随轮盘缓慢转动，并支持座舱内 360° 环顾。
 * 因为共用唯一 SceneContext.scene，进入后天空/草坪/城堡门/木马/海盗船/世纪钟/
 * NPC 全都还在视野里 —— 用户「仍在同一个 3D 大厅」。
 *
 * 【座舱世界位姿（严格贴合 Lobby.js 轮盘结构）】
 *   Lobby._buildPumpkinWheel（当前磁盘 1966-2030）：
 *     group `Lobby/pumpkin-wheel` 在 FACILITIES[0]（M2 后 x=-20, z=-16），无旋转；
 *     wheel `Lobby/wheel-spin` 是子 Group，local (0, 8.2, 0)，每帧 rotation.z += dt*0.13；
 *     10 个座舱（南瓜球）在 wheel local：(cos(a)*5.4, sin(a)*5.4, 0)，a = i/10*2π。
 *   轮心世界 = wheel.getWorldPosition()（含 group 位移）；
 *   座舱 i 世界 = 轮心 + 5.4 * (cos(θ+a), sin(θ+a), 0)，θ = wheel.rotation.z。
 *
 * 【防眩晕：座舱恒水平、无 roll】
 *   wheel 绕 Z 转会让挂在上面的座舱「倒转」，但相机绝不跟着 roll：
 *   quaternion 用 Euler(pitch, yaw, 0, 'YXZ')，roll 恒为 0，right 向量恒水平
 *   （right.y≈0），相机 up 始终朝世界 +Y。yaw 由「座舱→大厅中心」的方位 + 玩家环顾
 *   偏移决定，pitch 为有限俯仰。玩家可水平环顾 360°，不会天旋地转。
 *
 * 【降级（独立可测）】
 *   找不到 `Lobby/wheel-spin`（如隔离探针、T04b 尚未接线）时，用内部 `_angle`
 *   以同款 0.13 rad/s 累积，轮心用 Lobby FACILITIES[0]+(0,8.2,0) 的常量，
 *   其余算法完全一致 —— 保证本文件脱离 Lobby/main 也能独立验证。
 *
 * 【环顾与仲裁】
 *   自定义 pointer 拖拽（OrbitControls 绕 target 公转不适合「座舱内第一人称环顾」）。
 *   cameraRig.isTransitioning === true 时禁止环顾写相机/改朝向（与 T02 同一把锁）。
 *   进入过渡由 FacilityRuntime 调 cameraRig.blendTo(getCameraAnchor()) 完成；
 *   过渡结束后 update(dt) 以指数软跟随把相机平滑贴到「移动中的座舱」，无跳变。
 *
 * 【资源】零 geometry/material/texture；root 仅一个空 Group（挂 propsRoot，零 GPU）。
 *   dispose() 解绑监听、摘 root、清台账（本视图 track 的资源为 0），绝不碰 Lobby 轮盘。
 * ============================================================================
 */
import * as THREE from 'three';
import { IEmbeddedView } from './IEmbeddedView.js';
import { cameraRig } from '../../core/CameraRig.js';

/** 设施 key（与 FacilityRuntime.register / main.js EMBEDDED_KEYS 一致） */
export const FERRIS_WHEEL_KEY = 'ferris-wheel';

const TAU = Math.PI * 2;
const CABIN_COUNT = 10;          // 与 Lobby 南瓜座舱数一致
const WHEEL_RADIUS = 5.4;        // 与 Lobby 外轮圈 / 座舱半径一致
const WHEEL_HUB_Y = 8.2;         // wheel local position.y
const WHEEL_SPEED = 0.13;        // 与 Lobby 的 rotation.z += dt*0.13 一致
const HALL_CENTER = new THREE.Vector3(0, 3, 0); // 大厅中心（座舱朝向它，能看到全景）
/** 降级轮心（Lobby FACILITIES[0] 南瓜摩天轮 x=-20,z=-16 + (0,8.2,0)）；仅未接线/测试用 */
const FALLBACK_CENTER = new THREE.Vector3(-20, WHEEL_HUB_Y, -16);
const CABIN_FOV = 62;
const LOOK_SENS = 0.0045;        // rad / px
const PITCH_LIMIT = 1.1;         // ±63°，防过度仰俯
const FOLLOW_K = 8;              // 座舱软跟随系数（指数，无跳变）

export class FerrisWheelEmbedView extends IEmbeddedView {
  constructor() {
    super();
    this.key = FERRIS_WHEEL_KEY;

    /** @type {THREE.Group|null} 共享轮盘引用（只读，绝不 dispose） */
    this._wheel = null;
    this._isFallback = false;
    /** @type {number} 降级模式下自累积的轮盘角 */
    this._angle = 0;
    this._cabinIndex = 0;         // 默认座舱序号

    // 环顾状态（相对「座舱→大厅中心」基础朝向的偏移）
    this._lookYaw = 0;
    this._lookPitch = -0.08;      // 默认微俯视，能看到脚下大厅
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._listenersBound = false;

    // ===== 零每帧 new：全部预分配复用 =====
    this._center = new THREE.Vector3();     // 轮心世界坐标
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._fwd = new THREE.Vector3();
    /** @type {{position:THREE.Vector3, quaternion:THREE.Quaternion, lookAt:THREE.Vector3, fov:number}} */
    this._anchor = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      lookAt: new THREE.Vector3(),
      fov: CABIN_FOV,
    };

    // 保存绑定的监听函数引用，dispose 时精确解绑（箭头函数，this 自动绑定）
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = () => { this._dragging = false; };
  }

  get cabinIndex() { return this._cabinIndex; }
  get isFallback() { return this._isFallback; }
  get lookYaw() { return this._lookYaw; }
  get lookPitch() { return this._lookPitch; }
  get wheelSpin() { return this._wheel; }
  /** 当前轮盘角（真实轮盘读 rotation.z，降级读 _angle） */
  get angle() { return this._wheel ? (this._wheel.rotation?.z ?? 0) : this._angle; }
  /** 只读轮心快照（预分配向量，勿长期持有） */
  get wheelCenter() { return this._center; }

  /**
   * 注入共享上下文：按 name 找共享轮盘（找不到降级），建空 root 挂 propsRoot，绑环顾监听。
   * @param {Object} ctx FacilityRuntime._ctx（含 scene/camera/renderer/propsRoot/sceneContext）
   * @returns {this}
   */
  init(ctx) {
    super.init(ctx);
    const scene = ctx?.scene ?? ctx?.sceneContext?.scene ?? null;
    this._wheel = scene?.getObjectByName?.('Lobby/wheel-spin') ?? null;
    this._isFallback = this._wheel === null;

    // 空 root（零 GPU 资源，满足 IEmbeddedView「root 挂 propsRoot」契约）
    this.root = new THREE.Group();
    this.root.name = 'FerrisWheelEmbedView/root';
    const propsRoot = ctx?.propsRoot ?? ctx?.sceneContext?.propsRoot ?? null;
    if (propsRoot) propsRoot.add(this.root);

    // 环顾监听：仅绑在 renderer.domElement；无 renderer（隔离探针）时用 addLook 编程调用
    const dom = ctx?.renderer?.domElement ?? ctx?.sceneContext?.renderer?.domElement ?? null;
    if (dom && !this._listenersBound) {
      dom.addEventListener('pointerdown', this._onPointerDown);
      dom.addEventListener('pointermove', this._onPointerMove);
      dom.addEventListener('pointerup', this._onPointerUp);
      dom.addEventListener('pointercancel', this._onPointerUp);
      this._listenersBound = true;
    }

    this._recomputeAnchor();
    return this;
  }

  /** 进入：启用环顾标志、显示空 root（绝不碰共享轮盘） */
  activate() {
    super.activate();
    this._dragging = false;
    return this;
  }

  /** 退出：停环顾、隐藏 root，但【不 dispose】共享轮盘 */
  deactivate() {
    super.deactivate();
    this._dragging = false;
    this._lookYaw = 0;
    this._lookPitch = -0.08;
    return this;
  }

  /**
   * 重算座舱世界位姿（预分配对象、零 new）。
   * 轮心：真实轮盘 getWorldPosition；降级：FALLBACK_CENTER。
   * 角度：真实 wheel.rotation.z；降级 _angle。座舱 = 轮心 + R*(cos(θ+a), sin(θ+a), 0)。
   * 朝向：Euler(pitch, baseYaw+lookYaw, 0, 'YXZ')，roll 恒 0（无侧倾）。
   */
  _recomputeAnchor() {
    let theta = this._angle;
    if (this._wheel) {
      this._wheel.updateWorldMatrix?.(true, false);
      this._wheel.getWorldPosition?.(this._center);
      theta = this._wheel.rotation?.z ?? 0;
    } else {
      this._center.copy(FALLBACK_CENTER);
    }
    const a = this._cabinIndex * (TAU / CABIN_COUNT);
    const ang = theta + a;
    this._anchor.position.set(
      this._center.x + Math.cos(ang) * WHEEL_RADIUS,
      this._center.y + Math.sin(ang) * WHEEL_RADIUS,
      this._center.z
    );
    // 基础 yaw：让相机 -Z 指向大厅中心（水平方位）；叠加玩家环顾偏移
    const dx = HALL_CENTER.x - this._anchor.position.x;
    const dz = HALL_CENTER.z - this._anchor.position.z;
    const baseYaw = Math.atan2(-dx, -dz);
    this._euler.set(this._lookPitch, baseYaw + this._lookYaw, 0, 'YXZ');
    this._anchor.quaternion.setFromEuler(this._euler);
    // lookAt 仅作契约可选的调试读数（CameraRig 因 quaternion 优先会忽略它）
    this._fwd.set(0, 0, -1).applyQuaternion(this._anchor.quaternion);
    this._anchor.lookAt.copy(this._anchor.position).add(this._fwd);
    this._anchor.fov = CABIN_FOV;
  }

  /**
   * 【契约核心】返回当前座舱世界位姿（clone，避免内部复用对象被外部改写）。
   * @returns {{position:THREE.Vector3, quaternion:THREE.Quaternion, lookAt:THREE.Vector3, fov:number}}
   */
  getCameraAnchor() {
    this._recomputeAnchor(); // 保证未 update 时也正确（探针 init 后直接读）
    return {
      position: this._anchor.position.clone(),
      quaternion: this._anchor.quaternion.clone(),
      lookAt: this._anchor.lookAt.clone(),
      fov: this._anchor.fov,
    };
  }

  /**
   * 每帧：推进降级角、重算 anchor；active 且非 CameraRig 过渡时，把相机指数软跟随
   * 到「移动中的座舱」——过渡期绝不写相机（与 T02/CameraRig 单一仲裁一致）。
   * 硬约束：热路径零 new（只做向量/四元数的 set/lerp/slerp）。
   * @param {number} dt 秒
   * @returns {this}
   */
  update(dt = 0) {
    if (this._disposed) return this;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (!this._wheel && step > 0) this._angle = (this._angle + step * WHEEL_SPEED) % TAU;
    this._recomputeAnchor();

    if (this._active && !cameraRig.isTransitioning && step > 0) {
      const cam = this.ctx?.camera ?? null;
      if (cam) {
        const k = 1 - Math.exp(-FOLLOW_K * step); // 平滑软跟随，无跳变
        cam.position.lerp(this._anchor.position, k);
        cam.quaternion.slerp(this._anchor.quaternion, k);
        cam.up.set(0, 1, 0); // 恒世界上，绝不 roll
      }
    }
    return this;
  }

  /**
   * 环顾入口（供 pointer 拖拽与探针编程调用）。过渡期拒绝（返回 false），防止与
   * CameraRig.blendTo/restore 打架；非过渡期累加 yaw/pitch（pitch 限幅、无 roll）。
   * @param {number} yawDelta yaw 增量（弧度）
   * @param {number} pitchDelta pitch 增量（弧度）
   * @returns {boolean} 是否生效
   */
  addLook(yawDelta, pitchDelta) {
    if (this._disposed || cameraRig.isTransitioning) return false;
    this._lookYaw += Number.isFinite(yawDelta) ? yawDelta : 0;
    const p = this._lookPitch + (Number.isFinite(pitchDelta) ? pitchDelta : 0);
    this._lookPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
    this._recomputeAnchor();
    return true;
  }

  /** 选择座舱（0~9）；切换后下一帧 anchor 指向新座舱 */
  setCabinIndex(i) {
    const n = Math.floor(Number(i));
    if (Number.isFinite(n)) this._cabinIndex = ((n % CABIN_COUNT) + CABIN_COUNT) % CABIN_COUNT;
    this._recomputeAnchor();
    return this;
  }

  _pointerDown(e) {
    if (!this._active || cameraRig.isTransitioning) return;
    this._dragging = true;
    this._lastX = e.clientX ?? 0;
    this._lastY = e.clientY ?? 0;
  }

  _pointerMove(e) {
    if (!this._active || !this._dragging || cameraRig.isTransitioning) return;
    const dx = (e.clientX ?? 0) - this._lastX;
    const dy = (e.clientY ?? 0) - this._lastY;
    this._lastX = e.clientX ?? 0;
    this._lastY = e.clientY ?? 0;
    this.addLook(-dx * LOOK_SENS, -dy * LOOK_SENS);
  }

  /**
   * 终态清理：解绑 pointer、摘空 root、清独占台账（本视图为 0），
   * 【只解引用】共享轮盘，绝不 dispose 它或 Lobby._shared。幂等。
   */
  dispose() {
    if (this._disposed) return;
    if (this._listenersBound) {
      const dom = this.ctx?.renderer?.domElement ?? this.ctx?.sceneContext?.renderer?.domElement ?? null;
      if (dom) {
        dom.removeEventListener('pointerdown', this._onPointerDown);
        dom.removeEventListener('pointermove', this._onPointerMove);
        dom.removeEventListener('pointerup', this._onPointerUp);
        dom.removeEventListener('pointercancel', this._onPointerUp);
      }
      this._listenersBound = false;
    }
    super.dispose();          // 摘 root、释放 track 的资源（本视图 0 个）、清 ctx、置 _disposed
    this._wheel = null;       // 只解引用共享轮盘；不 dispose、不隐藏
    this._dragging = false;
  }
}

export default FerrisWheelEmbedView;
