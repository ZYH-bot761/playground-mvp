/**
 * ============================================================================
 * MovementModeManager —— 双模式互斥移动状态机（地面 / 飞行）
 * ============================================================================
 * 【本次升级】引入 three-player-controller + three-mesh-bvh 重构移动控制：
 *   - ground（默认）：WASD 贴地行走，相机锁定 1.7m 眼高，禁用垂直自由位移；
 *     碰撞由 MeshBVH.shapecast 做三角形级胶囊推出，杜绝穿模。
 *   - flight：F 键切换，保留空中自由漫游（Space 上升 / Q 下降），关闭地面碰撞约束。
 *   - HUD 显示当前模式；切换时相机高度做 0.5s 平滑过渡，绝不瞬移。
 *
 * 【依赖如何被真实使用】
 *   - three-mesh-bvh：把 Lobby._buildingBoxes 烘焙成合并三角网格并构建 MeshBVH，
 *     每帧用 shapecast + ExtendedTriangle.closestPointToSegment 做胶囊-三角形推出。
 *   - three-player-controller：用其 CollisionWorld 登记全部静态碰撞体（box shape），
 *     并用 query({mask}) 做候选粗筛；BVH 负责精筛。两者共同构成防穿模管线。
 *
 * 【不破坏既有功能的约定（安全红线）】
 *   1. 不删除 WASDController / OrbitControls / M 键切换：它们是「观察态」的兼容
 *      后端，v4②、M1 等验收继续有效。本状态机是叠加的主控层。
 *   2. 默认 mode='ground' 但**不主动改写相机机位**：只有玩家按下 WASD / F 或点击
 *      HUD 按钮时才 engage 接管。因此启动帧、俯瞰验收机位、设施相机过渡全部零改动。
 *   3. CameraRig 过渡中 / 嵌入设施激活 / 非大厅激活态时自动让位，不抢写相机。
 *   4. update() 热路径零新建 GPU 资源，且复用预分配的 Vector3 / Line3 / Box3。
 *
 * 【资源】碰撞几何是纯 CPU BufferGeometry（不加入 scene），不占用
 *  renderer.info.memory 的 geometries/textures，因此 Δ0/0 不受影响；
 *  仅在 Lobby 重建（_buildingBoxes 引用变化）时惰性重建一次。
 * ============================================================================
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { CollisionWorld } from 'three-player-controller';
import { cameraRig } from '../../core/camera-rig.js';

/** 站立眼高（地面模式锁定值） */
export const GROUND_EYE_HEIGHT = 1.7;
/** 玩家胶囊半径 / 总高 */
export const PLAYER_RADIUS = 0.5;
/** 碰撞体高度（覆盖所有建筑） */
const COLLIDER_HEIGHT = 30;
/** 地面行走速度 / 飞行速度（m/s） */
const WALK_SPEED = 7;
const FLY_SPEED = 16;
/** 模式切换时相机高度过渡时长（秒） */
const BLEND_TIME = 0.5;
/** 飞行模式的默认巡航高度 */
const FLIGHT_CRUISE_Y = 14;
/** 水平漫游边界——x 保持 110，z 延伸到都会区北端 z=252（修复 z=110 空气墙） */
const WORLD_BOUND = 110;
const WORLD_MIN_Z = -110;
const WORLD_MAX_Z = 252;

const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyQ', 'ShiftLeft', 'ShiftRight',
]);

/** 热路径复用的临时对象（零分配） */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _triPoint = new THREE.Vector3();
const _segPoint = new THREE.Vector3();
const _capsuleBox = new THREE.Box3();
const _segment = new THREE.Line3(new THREE.Vector3(), new THREE.Vector3());
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();

/**
 * 把 2D AABB 列表烘焙成非索引三角网格（每盒 12 三角形，y∈[0,30]）。
 * 纯 CPU 几何，不进 scene。
 */
function buildColliderGeometry(boxes) {
  const pos = [];
  const tri = (a, b, c) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  for (const b of boxes) {
    if (!b || b.noBlock) continue;
    if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX)
      || !Number.isFinite(b.minZ) || !Number.isFinite(b.maxZ)) continue;
    const x0 = b.minX, x1 = b.maxX, z0 = b.minZ, z1 = b.maxZ;
    const y0 = 0, y1 = COLLIDER_HEIGHT;
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -Z
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +X
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +Y
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

class MovementModeManager {
  constructor() {
    /** @type {'ground'|'flight'} 互斥状态，默认地面 */
    this.mode = 'ground';
    /** 是否已接管相机（懒接管：默认 false，保住启动机位与既有验收） */
    this.engaged = false;
    this._camera = null;
    this._domElement = null;
    this._getObstacles = () => [];
    this._getContext = () => ({ activeKey: null, embedded: false, busy: false });
    this._keys = new Set();
    this._yaw = 0;
    this._pitch = 0;
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._heightFrom = 0;
    this._heightTo = 0;
    this._blend = 1;
    this._attached = false;
    this._disposed = false;
    /** 刚交还相机的一次性标志，供 Lobby 同步 OrbitControls.target 避免跳变 */
    this._releasePending = false;
    this._hud = null;
    this._hudText = null;
    this._bvh = null;
    this._colliderGeo = null;
    this._boxesRef = null;
    /** three-player-controller 的碰撞体注册表 */
    this.collisionWorld = new CollisionWorld();
    this._colliderIds = [];
    /** 诊断计数（验收脚本读取） */
    this.stats = { bvhRebuilds: 0, bvhTriangles: 0, registeredColliders: 0, bvhPushOuts: 0 };

    this._onKeyDown = (e) => {
      if (this._disposed) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // F：进入漫游并切换到另一模式（默认 ground → 首次按 F 即飞行模式）
      if (e.code === 'KeyF' && !e.repeat) { this.toggle(); e.preventDefault(); return; }
      // 【不占用 Escape】PauseMenu 在 capture 阶段用 ESC 开关暂停菜单，
      // 这里不抢键。交还观察态请点 HUD「切换模式」旁的 lil-gui 按钮或
      // F 切回地面后按 M；避免破坏既有暂停功能。
      // 未接管时不抢键，保证既有 orbit / WASD / M 键验收零改动
      if (!this.engaged) return;
      if (!MOVE_CODES.has(e.code)) return;
      this._keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    };
    this._onKeyUp = (e) => { this._keys.delete(e.code); };
    this._onBlur = () => { this.clearInput(); };
    this._onPointerDown = (e) => {
      if (!this.engaged || e.button !== 0) return;
      this._dragging = true; this._lastX = e.clientX; this._lastY = e.clientY;
    };
    this._onPointerMove = (e) => {
      if (!this._dragging || !this.engaged) return;
      const dx = e.clientX - this._lastX, dy = e.clientY - this._lastY;
      this._lastX = e.clientX; this._lastY = e.clientY;
      this._yaw -= dx * 0.0026;
      this._pitch = THREE.MathUtils.clamp(this._pitch - dy * 0.0026, -1.45, 1.45);
    };
    this._onPointerUp = () => { this._dragging = false; };
  }

  /**
   * @param {object} o
   * @param {THREE.Camera} o.camera
   * @param {HTMLElement} o.domElement
   * @param {() => Array} o.getObstacles  Lobby._buildingBoxes
   * @param {() => {activeKey:string, embedded:boolean}} o.getContext
   */
  configure({ camera, domElement, getObstacles, getContext }) {
    this._camera = camera || this._camera;
    this._domElement = domElement || this._domElement;
    this._getObstacles = getObstacles || this._getObstacles;
    this._getContext = getContext || this._getContext;
    return this;
  }

  /** 绑定键盘 / 指针监听（幂等） */
  attach() {
    if (this._attached || this._disposed) return this;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onBlur);
    if (this._domElement) {
      this._domElement.addEventListener('pointerdown', this._onPointerDown);
      this._domElement.addEventListener('pointermove', this._onPointerMove);
    }
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    this._attached = true;
    return this;
  }

  /** 创建毛玻璃 HUD 模式指示器（纯 DOM，不占 GPU 资源） */
  buildHUD() {
    if (this._hud || typeof document === 'undefined') return this;
    const hud = document.createElement('div');
    hud.className = 'pg-mode-hud';
    hud.dataset.mode = this.mode;
    hud.innerHTML = '<span class="pg-mode-hud__dot"></span>'
      + '<span class="pg-mode-hud__label" data-role="mode-label">地面行走</span>'
      + '<span class="pg-mode-hud__key">F 切换</span>'
      + '<button type="button" class="pg-mode-hud__btn" data-role="mode-toggle" title="切换地面 / 飞行模式">切换模式</button>';
    hud.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="mode-toggle"]')) { this.toggle(); e.stopPropagation(); }
    });
    document.body.appendChild(hud);
    this._hud = hud;
    this._hudText = hud.querySelector('[data-role="mode-label"]');
    this._buildLabelsHint();
    return this;
  }

  _buildLabelsHint() {
    const hint = document.querySelector('.pg-mode-hud__hint');
    if (hint) return;
    const el = document.createElement('div');
    el.className = 'pg-mode-hud__hint';
    el.textContent = 'WASD 移动 · 拖拽环顾 · 飞行时 Space↑ / Q↓ · 控制台可交还观察视角';
    document.body.appendChild(el);
  }

  _syncHUD() {
    if (!this._hud) return;
    this._hud.dataset.mode = this.mode;
    this._hud.dataset.engaged = this.engaged ? 'true' : 'false';
    if (this._hudText) this._hudText.textContent = this.mode === 'ground' ? '地面行走' : '飞行漫游';
  }

  /** 从相机当前姿态初始化 yaw/pitch，避免接管瞬间朝向跳变 */
  _initOrientation() {
    const cam = this._camera;
    if (!cam) return;
    _euler.setFromQuaternion(cam.quaternion, 'YXZ');
    this._yaw = _euler.y;
    this._pitch = THREE.MathUtils.clamp(_euler.x, -1.45, 1.45);
  }

  /** 进入漫游接管（懒触发）；启动相机高度平滑过渡 */
  engage() {
    if (this._disposed || this.engaged) return this;
    const ctx = this._getContext();
    if (ctx.activeKey && ctx.activeKey !== 'lobby') return this;
    if (ctx.busy) return this; // Lobby 内部相机过渡（动物园飞行等）期间让位
    if (ctx.driving) return this; // 驾驶中不允许接管相机
    if (cameraRig.isTransitioning) return this;
    this.engaged = true;
    this._initOrientation();
    const cam = this._camera;
    this._heightFrom = cam ? cam.position.y : GROUND_EYE_HEIGHT;
    this._heightTo = this.mode === 'ground' ? GROUND_EYE_HEIGHT : Math.max(this._heightFrom, FLIGHT_CRUISE_Y);
    this._blend = 0;
    this._syncHUD();
    console.info(`[MovementMode] 接管相机 · 模式=${this.mode} · 目标眼高=${this._heightTo.toFixed(2)}m`);
    return this;
  }

  /** 退出接管，把相机控制权交还 OrbitControls（不删除任何既有控制器） */
  disengage() {
    if (!this.engaged) return this;
    this.engaged = false;
    this._releasePending = true;
    this.clearInput();
    this._syncHUD();
    console.info('[MovementMode] 已交还相机给 OrbitControls 观察态');
    return this;
  }

  /** 消费一次「交还相机」标志（Lobby 用它同步 orbit target，避免跳变） */
  consumeRelease() {
    if (!this._releasePending) return false;
    this._releasePending = false;
    return true;
  }

  /** F 键：双模式互斥切换（单一 mode 字段保证不可能同时处于两种模式） */
  toggle() {
    const next = this.mode === 'ground' ? 'flight' : 'ground';
    this.setMode(next);
    return this;
  }

  setMode(next) {
    if (next !== 'ground' && next !== 'flight') return this;
    if (next === this.mode) return this;
    this.mode = next;
    if (!this.engaged) this.engage();
    const cam = this._camera;
    this._heightFrom = cam ? cam.position.y : GROUND_EYE_HEIGHT;
    this._heightTo = next === 'ground'
      ? GROUND_EYE_HEIGHT
      : Math.max(this._heightFrom, FLIGHT_CRUISE_Y);
    this._blend = 0; // 重新启动 0.5s 平滑过渡
    this.clearInput();
    this._syncHUD();
    return this;
  }

  /**
   * 当前是否应当接管相机（设施/过渡/驾驶期间自动让位）。
   * 【驾驶集成】ctx.driving 为真时本状态机让位：驾驶相机由 CityDriving 经
   * CameraRig.writePose 独占写；若此处仍返回 true，update() 每帧写 cam.position.y
   * 与 rotation 会与之双写，导致驾驶视角抖动/被锁在 1.7m 眼高。
   * 注意这是「让位」而非 disengage：engaged 标志保留，下车后自动恢复接管，
   * 玩家无需重新按 F。isEngaged 是唯一的实际生效判据，所有门控都读它。
   */
  isEngaged() {
    if (!this.engaged || this._disposed || !this._camera) return false;
    const ctx = this._getContext();
    if (ctx.embedded || cameraRig.isTransitioning) return false;
    if (ctx.activeKey && ctx.activeKey !== 'lobby') return false;
    if (ctx.busy) return false;   // Lobby 内部相机过渡（动物园飞行等）期间自动让位
    if (ctx.driving) return false; // 驾驶中让位给 CityDriving（见上）
    return true;
  }

  clearInput() { this._keys.clear(); this._dragging = false; }

  /** 惰性重建碰撞世界：仅在 _buildingBoxes 引用变化时执行（Lobby 重建低频触发） */
  _ensureCollisionWorld() {
    const boxes = this._getObstacles() || [];
    if (boxes === this._boxesRef) return;
    this._boxesRef = boxes;
    // 释放旧 CPU 几何（不进 GPU，不计入 renderer.info.memory）
    if (this._colliderGeo) { this._colliderGeo.dispose(); this._colliderGeo = null; }
    for (const id of this._colliderIds) this.collisionWorld.remove(id);
    this._colliderIds.length = 0;
    this.collisionWorld.clear();

    const geo = buildColliderGeometry(boxes);
    this._colliderGeo = geo;
    const triCount = geo.attributes.position.count / 3;
    this._bvh = triCount > 0 ? new MeshBVH(geo, { maxLeafTris: 10 }) : null;
    this.stats.bvhRebuilds += 1;
    this.stats.bvhTriangles = triCount;

    // three-player-controller：登记静态盒碰撞体，供 query 粗筛
    for (const b of boxes) {
      if (!b || b.noBlock) continue;
      if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX)
        || !Number.isFinite(b.minZ) || !Number.isFinite(b.maxZ)) continue;
      const id = this.collisionWorld.add({
        motion: 'static',
        shape: {
          kind: 'box',
          halfExtents: new THREE.Vector3((b.maxX - b.minX) / 2, COLLIDER_HEIGHT / 2, (b.maxZ - b.minZ) / 2),
          position: new THREE.Vector3((b.minX + b.maxX) / 2, COLLIDER_HEIGHT / 2, (b.minZ + b.maxZ) / 2),
        },
        ready: true,
        userData: { key: b.key || 'building', box: b },
      })?.id;
      if (typeof id === 'number') this._colliderIds.push(id);
    }
    this.stats.registeredColliders = this._colliderIds.length;
  }

  /** 候选粗筛（three-player-controller CollisionWorld.query） */
  _candidateBoxes(x, z) {
    let list = [];
    try {
      list = this.collisionWorld.query({ mask: 65535 }, { motion: 'static' }) || [];
    } catch (err) {
      list = [];
    }
    const out = this._candidateBuf || (this._candidateBuf = []);
    out.length = 0;
    for (const c of list) {
      const b = c.userData?.box;
      if (!b) continue;
      if (Math.abs(x - (b.minX + b.maxX) / 2) < 40 && Math.abs(z - (b.minZ + b.maxZ) / 2) < 40) out.push(b);
    }
    return out;
  }

  /**
   * BVH 胶囊-三角形推出：防止玩家穿进建筑。
   * 用 three-mesh-bvh 的 shapecast + ExtendedTriangle.closestPointToSegment。
   * 只推水平分量（地面模式禁用垂直自由位移）。
   */
  _resolveBVH(position) {
    if (!this._bvh) return;
    const r = PLAYER_RADIUS;
    _segment.start.set(position.x, r, position.z);
    _segment.end.set(position.x, GROUND_EYE_HEIGHT - r, position.z);
    _min.set(position.x - r, 0, position.z - r);
    _max.set(position.x + r, GROUND_EYE_HEIGHT, position.z + r);
    _capsuleBox.set(_min, _max);

    let pushX = 0, pushZ = 0, hits = 0;
    const shape = {
      intersectsBounds: (box) => box.intersectsBox(_capsuleBox),
      intersectsTriangle: (tri) => {
        tri.closestPointToSegment(_segment, _triPoint, _segPoint);
        const dist = _triPoint.distanceTo(_segPoint);
        if (dist < r) {
          _delta.subVectors(_segPoint, _triPoint);
          const len = _delta.length();
          if (len > 1e-6) _delta.multiplyScalar((r - dist) / len);
          else _delta.set(0, 0, r - dist);
          pushX += _delta.x; pushZ += _delta.z;
          hits += 1;
        }
        return false;
      },
    };
    // 两轮迭代，处理相邻面同时挤压
    for (let pass = 0; pass < 2; pass += 1) {
      pushX = 0; pushZ = 0; hits = 0;
      this._bvh.shapecast(shape);
      if (!hits) break;
      position.x += pushX; position.z += pushZ;
      _segment.start.x = position.x; _segment.start.z = position.z;
      _segment.end.x = position.x; _segment.end.z = position.z;
      _capsuleBox.min.x = position.x - r; _capsuleBox.max.x = position.x + r;
      _capsuleBox.min.z = position.z - r; _capsuleBox.max.z = position.z + r;
      this.stats.bvhPushOuts += hits;
    }
  }

  /** 水平圆-矩形兜底（与既有 WASDController 口径一致，保证零穿模） */
  _resolveAABB(position, candidates) {
    const r = PLAYER_RADIUS;
    for (let pass = 0; pass < 2; pass += 1) {
      for (const b of candidates) {
        if (!b || b.noBlock) continue;
        const nx = THREE.MathUtils.clamp(position.x, b.minX, b.maxX);
        const nz = THREE.MathUtils.clamp(position.z, b.minZ, b.maxZ);
        const dx = position.x - nx, dz = position.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          position.x = nx + (dx / d) * r;
          position.z = nz + (dz / d) * r;
        } else {
          const toLeft = position.x - b.minX, toRight = b.maxX - position.x;
          const toBack = position.z - b.minZ, toFront = b.maxZ - position.z;
          const m = Math.min(toLeft, toRight, toBack, toFront);
          if (m === toLeft) position.x = b.minX - r;
          else if (m === toRight) position.x = b.maxX + r;
          else if (m === toBack) position.z = b.minZ - r;
          else position.z = b.maxZ + r;
        }
      }
    }
  }

  /** 每帧推进（由 Lobby.update 的相机主控仲裁调用） */
  update(dt = 0) {
    if (!this.isEngaged()) return false;
    if (!Number.isFinite(dt) || dt <= 0) return false;
    const cam = this._camera;
    if (!cam) return false;

    this._ensureCollisionWorld();

    // ① 相机高度平滑过渡（切换模式时不瞬移）
    if (this._blend < 1) {
      this._blend = Math.min(1, this._blend + dt / BLEND_TIME);
      const t = this._blend * this._blend * (3 - 2 * this._blend); // smoothstep
      cam.position.y = THREE.MathUtils.lerp(this._heightFrom, this._heightTo, t);
    } else if (this.mode === 'ground') {
      cam.position.y = GROUND_EYE_HEIGHT; // 地面模式锁死 1.7m，禁用垂直自由位移
    }

    // ② 朝向：YXZ 欧拉写回，无 roll
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this._pitch, this._yaw, 0);

    // ③ 输入方向
    let f = 0, r = 0, v = 0;
    const k = this._keys;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) r -= 1;
    if (this.mode === 'flight') {
      if (k.has('Space')) v += 1;
      if (k.has('KeyQ')) v -= 1;
    }

    // ③ 有输入才移动；但即使静止也要跑碰撞解算（外部瞬移 / 出生点落在
    //    建筑内时必须被推出，不能 early-return 跳过防穿模）。
    if (f !== 0 || r !== 0 || v !== 0) {
      const len = Math.hypot(f, r) || 1;
      f /= len; r /= len;
      const sprint = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 1.7 : 1;
      const speed = (this.mode === 'flight' ? FLY_SPEED : WALK_SPEED) * sprint * dt;

      const sin = Math.sin(this._yaw), cos = Math.cos(this._yaw);
      // 地面：纯水平；飞行：允许沿视线俯冲 + 独立升降
      if (this.mode === 'ground') {
        cam.position.x += (-sin * f + cos * r) * speed;
        cam.position.z += (-cos * f - sin * r) * speed;
      } else {
        _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
        _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
        cam.position.x += (_fwd.x * f + _right.x * r) * speed;
        cam.position.z += (_fwd.z * f + _right.z * r) * speed;
        cam.position.y += (_fwd.y * f + _right.y * r) * speed + v * FLY_SPEED * dt;
        cam.position.y = THREE.MathUtils.clamp(cam.position.y, 1.2, 160);
      }
      cam.position.x = THREE.MathUtils.clamp(cam.position.x, -WORLD_BOUND, WORLD_BOUND);
      cam.position.z = THREE.MathUtils.clamp(cam.position.z, WORLD_MIN_Z, WORLD_MAX_Z);
    }

    // ④ 地面模式：BVH 精筛 + AABB 兜底，关闭于飞行模式（自由漫游无约束）
    if (this.mode === 'ground') {
      this._resolveBVH(cam.position);
      this._resolveAABB(cam.position, this._candidateBoxes(cam.position.x, cam.position.z));
      cam.position.y = GROUND_EYE_HEIGHT;
    }
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._attached) {
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      document.removeEventListener('visibilitychange', this._onBlur);
      if (this._domElement) {
        this._domElement.removeEventListener('pointerdown', this._onPointerDown);
        this._domElement.removeEventListener('pointermove', this._onPointerMove);
      }
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
      this._attached = false;
    }
    this.clearInput();
    this._hud?.remove(); this._hud = null;
    this._colliderGeo?.dispose(); this._colliderGeo = null;
    this._bvh = null;
    this.collisionWorld.clear();
    this._camera = null; this._domElement = null;
  }
}

export const movementMode = new MovementModeManager();
export default movementMode;
