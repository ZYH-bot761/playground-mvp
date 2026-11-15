/**
 * ============================================================================
 * WASDController —— 大厅第一人称键盘漫游（v4 T02）
 * ============================================================================
 * 用户诉求：进入大厅后不该只有鼠标拖拽一种操控，应提供 WASD / 方向键选择。
 * 本类只负责【输入 → 相机平移 / 环顾】，不碰场景、不建 GPU 资源：
 *   - 眼高固定 1.6m，纯水平移动（无跳跃 / 飞行）。
 *   - 按住鼠标左键拖拽环顾；OrbitControls 由 Lobby 在 WASD 模式禁用，
 *     两者永不同时响应同一次拖拽（互斥由 Lobby._inputMode 仲裁）。
 *   - 碰撞复用 Lobby._buildingBoxes（AABB，2D 圆-矩形，玩家半径 0.5m）。
 *     noBlock:true（可穿行门廊 / 帐篷）按 Lobby 既有语义跳过。
 *   - 边界 ±30m clamp，速度 6m/s，Shift 1.8×加速。
 *
 * 【生命周期】attach() / dispose() 成对绑定 window+canvas 监听；clearInput()
 * 在失焦时清空按键，避免"切走窗口回来还在走"。所有监听都由本类自己回收，
 * 不经 Lobby._listeners 台账（职责单一，dispose 幂等）。
 * ============================================================================
 */

import * as THREE from 'three';

/** 站立眼高（与 Lobby 提示文案一致） */
export const WASD_EYE_HEIGHT = 1.6;
/** 常规行走速度（m/s） */
export const WASD_WALK_SPEED = 6;
/** Shift 加速倍率 */
export const WASD_SPRINT_MULTIPLIER = 1.8;
/** 玩家碰撞半径（m）；_buildingBoxes 本身已按 AABB_PAD=1 外扩 */
export const WASD_PLAYER_RADIUS = 0.5;
/** 大厅水平边界（m） */
export const WASD_WORLD_BOUND = 30;

const LOOK_SENSITIVITY = 0.0026;
const PITCH_LIMIT = 1.45; // ≈83°，不翻过头顶
/** orbit 模式水平平移的世界边界（四宫格扩建后仍够用） */
export const ORBIT_PAN_BOUND = 120;

/** 移动键白名单（Lobby 的 orbit 平移监听与 WAController 共用，避免两处各写一份） */
export const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight',
]);

/** 复用的 Euler，避免每次 update 新建对象 */
const _TMP_EULER = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * 从相机四元数取水平朝向（xz 归一化）。近乎垂直俯视时回退到 -Z。
 * @param {THREE.Quaternion} q
 * @returns {{x:number, z:number}}
 */
export function horizontalForward(q) {
  const v = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const len = Math.hypot(v.x, v.z);
  if (len < 0.01) return { x: 0, z: -1 };
  return { x: v.x / len, z: v.z / len };
}

/**
 * 第一人称 WASD 控制器。
 *
 * @param {{
 *   camera: THREE.PerspectiveCamera,
 *   domElement: HTMLElement,
 *   getObstacles: () => Array<{minX:number,maxX:number,minZ:number,maxZ:number,noBlock?:boolean}>,
 *   isEnabled: () => boolean,
 * }} options 全部必填；getObstacles/isEnabled 每帧读取，天然跟随 Lobby 重建
 */
export class WASDController {
  constructor({ camera = null, domElement = null, getObstacles = () => [], isEnabled = () => false } = {}) {
    /** @type {THREE.Camera|null} */
    this.camera = camera;
    /** @type {HTMLElement|null} */
    this.domElement = domElement;
    /** @type {() => Array} */
    this.getObstacles = getObstacles;
    /** @type {() => boolean} */
    this.isEnabled = isEnabled;

    // 朝向状态（相机四元数由本类按 YXZ 顺序写回，无 roll）
    this.yaw = 0;
    this.pitch = 0;

    /** @type {Set<string>} 当前按住的移动键 code */
    this._keys = new Set();
    /** 复用的方向向量：panOrbit 每帧只写不 new（热路径零分配） */
    this._panDir = new THREE.Vector3();
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._attached = false;
    this._disposed = false;

    // ---- 稳定回调引用，attach / dispose 成对解绑 ----
    this._onKeyDown = (event) => {
      if (!this.isEnabled()) return;
      if (event.repeat && !MOVE_CODES.has(event.code)) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!MOVE_CODES.has(event.code)) return;
      this._keys.add(event.code);
      // 方向键在浏览器里会滚动页面，必须拦截
      if (event.code.startsWith('Arrow')) event.preventDefault();
    };
    this._onKeyUp = (event) => {
      // 即使已禁用也要清键，杜绝"切换模式时按键卡住"
      this._keys.delete(event.code);
    };
    this._onPointerDown = (event) => {
      if (!this.isEnabled() || event.button !== 0) return;
      this._dragging = true;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
    };
    this._onPointerMove = (event) => {
      if (!this._dragging || !this.isEnabled()) return;
      const dx = event.clientX - this._lastX;
      const dy = event.clientY - this._lastY;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      // 拖右看右（yaw 减小）、拖下看下（pitch 减小）
      this.yaw -= dx * LOOK_SENSITIVITY;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - dy * LOOK_SENSITIVITY,
        -PITCH_LIMIT, PITCH_LIMIT
      );
    };
    this._onPointerUp = () => { this._dragging = false; };
    this._onPointerCancel = () => { this._dragging = false; };
    this._onBlur = () => { this.clearInput(); };
  }

  /** 绑定监听（幂等） */
  attach() {
    if (this._attached || this._disposed) return this;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onBlur);
    if (this.domElement) {
      this.domElement.addEventListener('pointerdown', this._onPointerDown);
      this.domElement.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerCancel);
    }
    this._attached = true;
    return this;
  }

  /** 解绑全部监听并清空按键（幂等） */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._attached) {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      document.removeEventListener('visibilitychange', this._onBlur);
      if (this.domElement) {
        this.domElement.removeEventListener('pointerdown', this._onPointerDown);
        this.domElement.removeEventListener('pointermove', this._onPointerMove);
        window.removeEventListener('pointerup', this._onPointerUp);
        window.removeEventListener('pointercancel', this._onPointerCancel);
      }
      this._attached = false;
    }
    this.clearInput();
    this.camera = null;
    this.domElement = null;
  }

  /** 失焦 / 模式切换时清空输入状态，避免按键粘滞 */
  clearInput() {
    this._keys.clear();
    this._dragging = false;
  }

  /**
   * 从相机当前姿态初始化 yaw/pitch，并把眼高落到 1.6m。
   * 用于 orbit→wasd 姿态过渡结束、以及坐姿起身后的重新接管。
   * @param {THREE.Camera} camera
   */
  resetFromCamera(camera) {
    const cam = camera || this.camera;
    if (!cam) return this;
    _TMP_EULER.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = _TMP_EULER.y;
    this.pitch = THREE.MathUtils.clamp(_TMP_EULER.x, -PITCH_LIMIT, PITCH_LIMIT);
    cam.rotation.order = 'YXZ';
    cam.position.y = WASD_EYE_HEIGHT;
    this.clearInput();
    return this;
  }

  /**
   * 2D 圆-矩形碰撞消解 + ±30 边界 clamp（原地修改 position.x/z）。
   * 供 WASD 每帧调用，也供 Lobby 在 orbit→wasd 落地时预解算出生点。
   * @param {{x:number,z:number}} position
   * @returns {{x:number,z:number}} 同一对象
   */
  resolveCollision(position) {
    const boxes = this.getObstacles();
    const list = Array.isArray(boxes) ? boxes : [];
    // 两轮消解：相邻 AABB 同时挤压时给第二次机会收敛
    for (let pass = 0; pass < 2; pass += 1) {
      for (const b of list) {
        if (!b || b.noBlock) continue;
        if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX)
          || !Number.isFinite(b.minZ) || !Number.isFinite(b.maxZ)) continue;
        // 最近点（矩形内时 clamp 结果就是圆心自身 → d=0，走内部分支）
        const nx = THREE.MathUtils.clamp(position.x, b.minX, b.maxX);
        const nz = THREE.MathUtils.clamp(position.z, b.minZ, b.maxZ);
        const dx = position.x - nx;
        const dz = position.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= WASD_PLAYER_RADIUS * WASD_PLAYER_RADIUS) continue;
        if (d2 > 1e-8) {
          // 圆在矩形外但擦到边：沿法线推出到半径外
          const d = Math.sqrt(d2);
          position.x = nx + (dx / d) * WASD_PLAYER_RADIUS;
          position.z = nz + (dz / d) * WASD_PLAYER_RADIUS;
        } else {
          // 圆心已在矩形内：沿穿透最浅的一条边推出
          const toLeft = position.x - b.minX;
          const toRight = b.maxX - position.x;
          const toBack = position.z - b.minZ;
          const toFront = b.maxZ - position.z;
          const m = Math.min(toLeft, toRight, toBack, toFront);
          if (m === toLeft) position.x = b.minX - WASD_PLAYER_RADIUS;
          else if (m === toRight) position.x = b.maxX + WASD_PLAYER_RADIUS;
          else if (m === toBack) position.z = b.minZ - WASD_PLAYER_RADIUS;
          else position.z = b.maxZ + WASD_PLAYER_RADIUS;
        }
      }
    }
    position.x = THREE.MathUtils.clamp(position.x, -WASD_WORLD_BOUND, WASD_WORLD_BOUND);
    position.z = THREE.MathUtils.clamp(position.z, -WASD_WORLD_BOUND, WASD_WORLD_BOUND);
    return position;
  }

  /**
   * 每帧推进相机。只写 camera.rotation / position，绝不新建 GPU 资源。
   * @param {number} dt 帧间隔秒（Lobby 已 clamp 到 0..0.1）
   * @returns {boolean} 是否真的发生了平移
   */
  update(dt = 0) {
    if (!this.isEnabled() || !this.camera) return false;
    if (!Number.isFinite(dt) || dt <= 0) return false;
    const cam = this.camera;

    // 朝向：YXZ 欧拉写回，three 会同步 quaternion，无 roll
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.pitch, this.yaw, 0);

    let forward = 0;
    let right = 0;
    if (this._keys.has('KeyW') || this._keys.has('ArrowUp')) forward += 1;
    if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) forward -= 1;
    if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) right += 1;
    if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) right -= 1;
    if (forward === 0 && right === 0) return false;

    // 斜向归一化，避免对角线加速
    const len = Math.hypot(forward, right) || 1;
    forward /= len;
    right /= len;
    const sprint = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight')
      ? WASD_SPRINT_MULTIPLIER : 1;
    const step = WASD_WALK_SPEED * sprint * dt;

    // yaw=0 时相机朝 -Z；right 为 forward 绕 Y 轴 -90° 的结果
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    cam.position.x += (-sin * forward + cos * right) * step;
    cam.position.z += (-cos * forward - sin * right) * step;
    cam.position.y = WASD_EYE_HEIGHT;
    this.resolveCollision(cam.position);
    return true;
  }

  /**
   * 【M1】orbit（鼠标漫游）模式下的水平平移。
   *
   * 用户诉求「在大厅能自由使用 WASD 移动」：旧实现默认 orbit 且只有切到
   * wasd 第一人称才接管键盘，导致直接按 W 毫无反应；而切设施再回来又会
   * 把模式重置回 orbit。这里让 WASD / 方向键在 orbit 下也能推动相机，
   * **不切换输入模式、不改俯仰/朝向、不改眼高**，因此 v4② 的
   * 「orbit→wasd→orbit 切换 + 零跳变」验收假设完全不变。
   *
   * camera.position 与 controls.target 同步平移，二者相对球坐标不变，
   * OrbitControls 下一帧不会把机位拉回。俯瞰相机在 30m 高空，不套用
   * 地面 AABB（那是给第一人称用的），只做世界边界 clamp。
   *
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {{target:THREE.Vector3}} controls
   * @param {Set<string>} keys 由 Lobby 维护的 orbit 按键集合
   * @returns {boolean} 是否真的平移了
   */
  panOrbit(dt, camera, controls, keys) {
    const cam = camera || this.camera;
    if (!cam || !controls?.target || !keys || keys.size === 0) return false;
    if (!Number.isFinite(dt) || dt <= 0) return false;

    let forward = 0;
    let right = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) forward += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) right += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= 1;
    if (forward === 0 && right === 0) return false;

    const len = Math.hypot(forward, right) || 1;
    forward /= len;
    right /= len;
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight')
      ? WASD_SPRINT_MULTIPLIER : 1;
    const step = WASD_WALK_SPEED * sprint * dt;

    // 水平朝向 = 相机 forward 的 XZ 投影；right = (-fz, 0, fx)
    cam.getWorldDirection(this._panDir);
    let fx = this._panDir.x;
    let fz = this._panDir.z;
    const fl = Math.hypot(fx, fz);
    if (fl < 0.01) { fx = 0; fz = -1; }
    else { fx /= fl; fz /= fl; }
    const dx = (fx * forward - fz * right) * step;
    const dz = (fz * forward + fx * right) * step;

    const nx = THREE.MathUtils.clamp(cam.position.x + dx, -ORBIT_PAN_BOUND, ORBIT_PAN_BOUND);
    const nz = THREE.MathUtils.clamp(cam.position.z + dz, -ORBIT_PAN_BOUND, ORBIT_PAN_BOUND);
    const ax = nx - cam.position.x;
    const az = nz - cam.position.z;
    if (ax === 0 && az === 0) return false;
    cam.position.x = nx;
    cam.position.z = nz;
    controls.target.x += ax;
    controls.target.z += az;
    return true;
  }
}

export default WASDController;
