/**
 * ============================================================================
 * PirateShipEmbedView —— 海盗船嵌入视图（阶段二·模块 2，零 GPU 资源）
 * ============================================================================
 * 用户诉求：「进入海盗船后背景不能是纯黑，要能透过镜头看到外面的大厅建筑和草坪」。
 * 旧路径是独立 IAttraction（activate 卸载大厅 → 背景只剩深色）；本视图改走
 * 嵌入架构（与摩天轮 T04b 同款）：Lobby 常驻不卸载，复用大厅常驻立面
 * `Lobby/facade-pirate-ship-pivot`（归 Lobby 所有，绝不 dispose），把相机放到
 * 船甲板上随船摆动，支持 360° 环顾。唯一场景里天空 / 草坪 / 城堡 / 木马 /
 * 世纪钟 / NPC 全在视野内 —— 「仍在同一个 3D 大厅」。
 *
 * 【甲板世界位姿（贴合 Lobby 立面结构）】
 *   group `Lobby/facade-pirate-ship` 在 (-7, 0, 5)，scale(1.25,1.35,1.25)；
 *   pivot `Lobby/facade-pirate-ship-pivot` 本地 (0,7.35,0)，rotation.z = 0.72·sin(2πt/3)；
 *   swing 子组 (0,-7.35,0)，甲板中心 swing 本地 (0,3.02,0) → pivot 本地 (0,-4.33,0)。
 *   相机锚点 = pivot.matrixWorld × pivot 本地点 (-0.85, -4.18, 0.42)
 *   （船中前部甲板，微靠舷侧，视点高度 ≈ 3.15×1.35+眼高补偿）。
 *
 * 【防眩晕】船体摆动 ±0.72rad 会让甲板倾斜，但相机恒水平无 roll
 *   （Euler(pitch, yaw, 0, 'YXZ')，up=(0,1,0)）；基础朝向指向大厅中心。
 * 【降级】找不到 pivot（隔离探针 / 未接线）时用内部 _t 以同款 ω/振幅自算
 *   摆动 + 常量锚点中心，算法一致，脱离 Lobby 亦可独立验证。
 * 【仲裁】cameraRig.isTransitioning 期间拒绝环顾与写相机。
 * 【资源】零 geometry/material/texture；root 仅空 Group 挂 propsRoot。
 * ============================================================================
 */
import * as THREE from 'three';
import { IEmbeddedView } from './i-embedded-view.js';
import { cameraRig } from '../../core/camera-rig.js';

/** 设施 key（与 FacilityRuntime.register / main.js EMBEDDED_KEYS 一致） */
export const PIRATE_EMBED_KEY = 'pirate-ship';

const TAU = Math.PI * 2;
const PIRATE_OMEGA = TAU / 3.0;   // 与 Lobby 摆动周期 3s 一致
const PIRATE_MAX_AMP = 0.72;      // 与 Lobby pivot.rotation.z 振幅一致
const FALLBACK_CENTER = new THREE.Vector3(-7, 0, 5); // Lobby FACILITIES pirate-ship
const FALLBACK_DECK_Y = 4.35;     // 降级甲板眼高（≈3.02×1.35+0.25）
const HALL_CENTER = new THREE.Vector3(0, 3, 0);      // 朝向大厅中心
const RIDE_FOV = 60;
const LOOK_SENS = 0.0045;
const PITCH_LIMIT = 1.1;
const FOLLOW_K = 8;

/** pivot 本地坐标的甲板站位（swing 本地 (-0.85, 3.17, 0.42) + (0,-7.35,0)） */
const DECK_LOCAL = new THREE.Vector3(-0.85, -4.18, 0.42);

export class PirateShipEmbedView extends IEmbeddedView {
  constructor() {
    super();
    this.key = PIRATE_EMBED_KEY;

    /** @type {THREE.Group|null} 共享摆动 pivot（只读，绝不 dispose） */
    this._pivot = null;
    this._isFallback = false;
    /** @type {number} 降级模式下自累积的摆动时间 */
    this._t = 0;

    // 环顾状态
    this._lookYaw = 0;
    this._lookPitch = -0.05;
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._listenersBound = false;

    // ===== 零每帧 new：全部预分配复用 =====
    this._deck = new THREE.Vector3();     // 甲板站位世界坐标
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._fwd = new THREE.Vector3();
    this._dir = new THREE.Vector3();
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

  get isFallback() { return this._isFallback; }
  get pivotGroup() { return this._pivot; }
  /** 当前摆动角（真实 pivot 读 rotation.z，降级按 ω 自算） */
  get swingAngle() {
    return this._pivot ? (this._pivot.rotation?.z ?? 0) : PIRATE_MAX_AMP * Math.sin(this._t * PIRATE_OMEGA);
  }

  /** 注入上下文：找共享 pivot（找不到降级），建空 root 挂 propsRoot，绑环顾监听 */
  init(ctx) {
    super.init(ctx);
    const scene = ctx?.scene ?? ctx?.sceneContext?.scene ?? null;
    this._pivot = scene?.getObjectByName?.('Lobby/facade-pirate-ship-pivot') ?? null;
    this._isFallback = this._pivot === null;

    this.root = new THREE.Group();
    this.root.name = 'PirateShipEmbedView/root';
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
    this._lookPitch = -0.05;
    return this;
  }

  /** 重算甲板站位世界位姿（预分配对象、零 new） */
  _recomputeAnchor() {
    if (this._pivot) {
      this._pivot.updateWorldMatrix?.(true, false);
      this._deck.copy(DECK_LOCAL).applyMatrix4(this._pivot.matrixWorld);
    } else {
      // 降级：常量船位 + 自算摆动（x 方向摆动，与 pivot.rotation.z 同轴语义）
      const ang = PIRATE_MAX_AMP * Math.sin(this._t * PIRATE_OMEGA);
      this._deck.copy(FALLBACK_CENTER);
      this._deck.x += Math.sin(ang) * 4.33;
      this._deck.y += FALLBACK_DECK_Y + (Math.cos(ang) - 1) * 4.33;
    }
    this._anchor.position.copy(this._deck);

    // 基础朝向：看向大厅中心（水平方位）；叠加玩家环顾偏移
    this._dir.set(HALL_CENTER.x - this._deck.x, 0, HALL_CENTER.z - this._deck.z);
    const baseYaw = Math.atan2(-this._dir.x, -this._dir.z);
    this._euler.set(this._lookPitch, baseYaw + this._lookYaw, 0, 'YXZ');
    this._anchor.quaternion.setFromEuler(this._euler);
    this._fwd.set(0, 0, -1).applyQuaternion(this._anchor.quaternion);
    this._anchor.lookAt.copy(this._anchor.position).add(this._fwd);
    this._anchor.fov = RIDE_FOV;
  }

  /** 【契约核心】甲板站位世界位姿（clone，防内部对象被外部改写） */
  getCameraAnchor() {
    this._recomputeAnchor();
    return {
      position: this._anchor.position.clone(),
      quaternion: this._anchor.quaternion.clone(),
      lookAt: this._anchor.lookAt.clone(),
      fov: this._anchor.fov,
    };
  }

  /** 每帧：推进降级摆动、重算 anchor、（非过渡期）软跟随摆动中的甲板 */
  update(dt = 0) {
    if (this._disposed) return this;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (!this._pivot && step > 0) this._t += step;
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

  /** 终态清理：解绑 pointer、摘空 root、清台账（0 个），只解引用共享 pivot。幂等 */
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
    this._pivot = null; // 只解引用；不 dispose、不隐藏 Lobby 立面
    this._dragging = false;
  }
}

export default PirateShipEmbedView;
