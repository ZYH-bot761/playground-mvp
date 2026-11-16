/**
 * ============================================================================
 * CarouselEmbedView —— 旋转木马嵌入视图（阶段二·模块 2，零 GPU 资源）
 * ============================================================================
 * 用户诉求：「进入木马后，背景不能是纯黑，要透过镜头看到外面的大厅建筑和草坪」。
 * 旧路径把 carousel 作为独立 IAttraction 激活 → AttractionManager 卸载整个
 * Lobby，大厅建筑从场景中消失，只剩设施自己的深色背景 —— 与诉求相反。
 *
 * 本视图改走 v4 嵌入架构（与摩天轮 T04b 同款）：Lobby 常驻不卸载，复用大厅
 * 常驻立面 `Lobby/facade-carousel-spin`（归 Lobby 所有，绝不 dispose），把相机
 * 放上木马背位随立面旋转，支持 360° 环顾。唯一场景里天空 / 草坪 / 城堡门 /
 * 海盗船 / 世纪钟 / NPC 全在视野内 —— 「仍在同一个 3D 大厅」。
 *
 * 【骑乘位世界位姿（贴合 Lobby 立面结构）】
 *   group `Lobby/facade-carousel` 在 FACILITIES carousel (9, 0, 7.5)，scale(1.25,1.35,1.25)；
 *   spin `Lobby/facade-carousel-spin` 每帧 rotation.y += dt*0.35；
 *   8 匹木马 spin 本地 (cos(a)*2.65, 1.62, sin(a)*2.65)，a = i/8*2π。
 *   世界半径 R = 2.65×1.25 = 3.3125；骑乘眼高 ≈ 1.62×1.35 + 0.28 ≈ 2.47。
 *   世界方位角 φ = θ - a（rotation.y=θ 把本地 +x 旋到 (cosθ,0,-sinθ)）。
 *
 * 【防眩晕】相机恒水平无 roll（Euler(pitch, yaw, 0, 'YXZ')，up=(0,1,0)）；
 *   环顾偏移叠加在「木马位 → 径向朝外」的基础朝向上。
 * 【降级】找不到 spin（隔离探针 / 未接线）时用内部 _angle 以同款 0.35 rad/s
 *   累积 + 常量轮心 (9,0,7.5)，算法完全一致，脱离 Lobby 亦可独立验证。
 * 【仲裁】cameraRig.isTransitioning 期间拒绝环顾与写相机（T02 同一把锁）。
 * 【资源】零 geometry/material/texture；root 仅空 Group 挂 propsRoot。
 * ============================================================================
 */
import * as THREE from 'three';
import { IEmbeddedView } from './i-embedded-view.js';
import { cameraRig } from '../../core/camera-rig.js';

/** 设施 key（与 FacilityRuntime.register / main.js EMBEDDED_KEYS 一致） */
export const CAROUSEL_EMBED_KEY = 'carousel';

const TAU = Math.PI * 2;
const HORSE_COUNT = 8;           // 与 Lobby 立面木马数一致
const SPIN_RADIUS_LOCAL = 2.65;  // 木马 spin 本地半径
const FACADE_SCALE_XZ = 1.25;    // Lobby 立面 group.scale.xz
const FACADE_SCALE_Y = 1.35;
const HORSE_BODY_Y_LOCAL = 1.62; // 木马背高（spin 本地）
const RIDE_EYE_LIFT = 0.30;      // 骑乘眼高于马背的距离
const SPIN_SPEED = 0.35;         // 与 Lobby rotation.y += dt*0.35 一致
const FALLBACK_CENTER = new THREE.Vector3(9, 0, 7.5); // Lobby FACILITIES carousel
const RIDE_FOV = 60;
const LOOK_SENS = 0.0045;
const PITCH_LIMIT = 1.1;
const FOLLOW_K = 8;

export class CarouselEmbedView extends IEmbeddedView {
  constructor() {
    super();
    this.key = CAROUSEL_EMBED_KEY;

    /** @type {THREE.Group|null} 共享立面 spin（只读，绝不 dispose） */
    this._spin = null;
    this._isFallback = false;
    /** @type {number} 降级模式下自累积的旋转角 */
    this._angle = 0;
    this._horseIndex = 0;

    // 环顾状态（叠加在基础朝向上）
    this._lookYaw = 0;
    this._lookPitch = -0.06;
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._listenersBound = false;

    // ===== 零每帧 new：全部预分配复用 =====
    this._center = new THREE.Vector3();   // spin 原点世界坐标
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._out = new THREE.Vector3();      // 径向朝外单位向量
    this._fwd = new THREE.Vector3();
    this._anchor = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      lookAt: new THREE.Vector3(),
      fov: RIDE_FOV,
    };

    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = () => { this._dragging = false; };
  }

  get horseIndex() { return this._horseIndex; }
  get isFallback() { return this._isFallback; }
  get spinGroup() { return this._spin; }
  /** 当前立面旋转角（真实 spin 读 rotation.y，降级读 _angle） */
  get angle() { return this._spin ? (this._spin.rotation?.y ?? 0) : this._angle; }

  /**
   * 注入上下文：按 name 找共享 spin（找不到降级），建空 root 挂 propsRoot，绑环顾监听。
   */
  init(ctx) {
    super.init(ctx);
    const scene = ctx?.scene ?? ctx?.sceneContext?.scene ?? null;
    this._spin = scene?.getObjectByName?.('Lobby/facade-carousel-spin') ?? null;
    this._isFallback = this._spin === null;

    this.root = new THREE.Group();
    this.root.name = 'CarouselEmbedView/root';
    const propsRoot = ctx?.propsRoot ?? ctx?.sceneContext?.propsRoot ?? null;
    if (propsRoot) propsRoot.add(this.root);

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

  activate() {
    super.activate();
    this._dragging = false;
    return this;
  }

  deactivate() {
    super.deactivate();
    this._dragging = false;
    this._lookYaw = 0;
    this._lookPitch = -0.06;
    return this;
  }

  /** 重算骑乘位世界位姿（预分配对象、零 new） */
  _recomputeAnchor() {
    let theta = this._angle;
    if (this._spin) {
      this._spin.updateWorldMatrix?.(true, false);
      this._spin.getWorldPosition?.(this._center);
      theta = this._spin.rotation?.y ?? 0;
    } else {
      this._center.copy(FALLBACK_CENTER);
    }
    const R = SPIN_RADIUS_LOCAL * FACADE_SCALE_XZ;
    const a = this._horseIndex * (TAU / HORSE_COUNT);
    const phi = theta - a; // 世界方位角（rotation.y 映射推导见文件头）
    const eyeY = HORSE_BODY_Y_LOCAL * FACADE_SCALE_Y + RIDE_EYE_LIFT;
    this._anchor.position.set(
      this._center.x + Math.cos(phi) * R,
      this._center.y + eyeY,
      this._center.z - Math.sin(phi) * R
    );
    // 基础朝向：径向朝外（面朝大厅建筑与草坪），叠加玩家环顾偏移
    this._out.set(Math.cos(phi), 0, -Math.sin(phi));
    const baseYaw = Math.atan2(-this._out.x, -this._out.z);
    this._euler.set(this._lookPitch, baseYaw + this._lookYaw, 0, 'YXZ');
    this._anchor.quaternion.setFromEuler(this._euler);
    this._fwd.set(0, 0, -1).applyQuaternion(this._anchor.quaternion);
    this._anchor.lookAt.copy(this._anchor.position).add(this._fwd);
    this._anchor.fov = RIDE_FOV;
  }

  /** 【契约核心】骑乘位世界位姿（clone，防内部对象被外部改写） */
  getCameraAnchor() {
    this._recomputeAnchor();
    return {
      position: this._anchor.position.clone(),
      quaternion: this._anchor.quaternion.clone(),
      lookAt: this._anchor.lookAt.clone(),
      fov: this._anchor.fov,
    };
  }

  /** 每帧：推进降级角、重算 anchor、（非过渡期）把相机软跟随到旋转中的骑乘位 */
  update(dt = 0) {
    if (this._disposed) return this;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (!this._spin && step > 0) this._angle = (this._angle + step * SPIN_SPEED) % TAU;
    this._recomputeAnchor();

    if (this._active && !cameraRig.isTransitioning && step > 0) {
      const cam = this.ctx?.camera ?? null;
      if (cam) {
        const k = 1 - Math.exp(-FOLLOW_K * step);
        cam.position.lerp(this._anchor.position, k);
        cam.quaternion.slerp(this._anchor.quaternion, k);
        cam.up.set(0, 1, 0); // 恒世界上，绝不 roll
      }
    }
    return this;
  }

  /** 环顾入口（pointer 拖拽 / 探针编程调用）；过渡期拒绝 */
  addLook(yawDelta, pitchDelta) {
    if (this._disposed || cameraRig.isTransitioning) return false;
    this._lookYaw += Number.isFinite(yawDelta) ? yawDelta : 0;
    const p = this._lookPitch + (Number.isFinite(pitchDelta) ? pitchDelta : 0);
    this._lookPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
    this._recomputeAnchor();
    return true;
  }

  /** 选择木马（0~7）；下一帧 anchor 指向新马位 */
  setHorseIndex(i) {
    const n = Math.floor(Number(i));
    if (Number.isFinite(n)) this._horseIndex = ((n % HORSE_COUNT) + HORSE_COUNT) % HORSE_COUNT;
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

  /** 终态清理：解绑 pointer、摘空 root、清台账（0 个），只解引用共享 spin。幂等 */
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
    super.dispose();
    this._spin = null; // 只解引用；不 dispose、不隐藏 Lobby 立面
    this._dragging = false;
  }
}

export default CarouselEmbedView;
