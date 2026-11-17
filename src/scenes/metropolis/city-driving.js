/**
 * ============================================================================
 * CityDriving —— 都会区 GTA 式驾驶（阶段四）
 * ============================================================================
 * - 靠近 AI 车按 F：冻结并隐藏那辆 InstancedMesh 车，换成 6 个复用几何的
 *   玩家车网格 + 一个 Rapier 动态刚体；下车时把刚体与临时 collider 全部移除。
 * - 玩家车保留完整物理碰撞（地面 / 城市建筑 AABB / 11 辆 AI 简化包围盒）。
 *   AI 车是 kinematicPositionBased，不参与受力求解，只提供碰撞阻挡——这正是
 *   性能护栏允许的「AI 车简化碰撞体」。
 * - 相机由本类唯一写：第一人称驾驶位；退出后交还 Lobby 的 WASD 控制器。
 * - 热路径零 GPU 分配：车漆材质只在首次上车时创建一次，视觉网格复用
 *   CityTraffic 的 body / cabin / wheel 几何。
 * ============================================================================
 */
import * as THREE from 'three';
import physicsManager from '../../core/physics-manager.js';
import { cameraRig } from '../../core/camera-rig.js';
import { isOnRoad } from './city-layout.js';

const CAR_HALF_X = 0.92;
const CAR_HALF_Y = 0.32;
const CAR_HALF_Z = 1.95;
const CAR_SPAWN_Y = 1.85;
const MAX_FORWARD = 17.5;
const MAX_REVERSE = 6.2;
const MAX_BUILDING_COLLIDERS = 220;

const _Q = new THREE.Quaternion();
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
/** 相机直写用的模块级临时对象（热路径零分配） */
const _Q_DRIVE = new THREE.Quaternion();
const _E_DRIVE = new THREE.Euler();

function yawQuat(yaw, out = { x: 0, y: 0, z: 0, w: 1 }) {
  const h = yaw * 0.5;
  out.x = 0; out.y = Math.sin(h); out.z = 0; out.w = Math.cos(h);
  return out;
}

export class CityDriving {
  constructor({ camera, traffic, getObstacles = () => [] } = {}) {
    this.camera = camera;
    this.traffic = traffic;
    this.getObstacles = getObstacles;
    this._active = false;
    this._pending = false;
    this._disposed = false;
    this._token = 0;
    this._keys = new Set();
    this._body = null;
    this._car = null;
    this._bodies = [];
    this._ai = [];
    this._claim = null;
    this._speedKmh = 0;
    this._lastYaw = 0;
    this._fwd = new THREE.Vector3(0, 0, 1);
    this._q = new THREE.Quaternion();
    this._resetAvailable = false;
    this._view = 'first'; // first | third：C 键切换，驾驶时更易观察车身与路缘
    this._lightMats = [];
    this._headPool = null;
    this._analogThrottle = 0;
    this._analogSteer = 0;
    this._wheelSpin = 0;
    this._steerVisual = 0;
  }

  get active() { return this._active; }
  get pending() { return this._pending; }
  get speedKmh() { return this._speedKmh; }
  get keys() { return [...this._keys]; }
  get viewMode() { return this._view; }

  toggleView() {
    this._view = this._view === 'first' ? 'third' : 'first';
    return this._view;
  }

  get debugState() {
    const world = physicsManager.isReady ? physicsManager.world : null;
    return {
      active: this._active,
      pending: this._pending,
      speedKmh: +this._speedKmh.toFixed(1),
      bodyCount: world ? world.bodies.len() : 0,
      aiBodies: this._ai.length,
      hasCar: !!this._car,
      claim: this._claim ? { ...this._claim } : null,
    };
  }

  setKey(code, down) {
    if (down) this._keys.add(code);
    else this._keys.delete(code);
  }

  clearKeys() {
    this._keys.clear();
    this._analogThrottle = 0;
    this._analogSteer = 0;
  }

  /** 移动端虚拟摇杆：y 前推油门，x 右推转向（D 为正转向，故调用方取反）。 */
  setAnalog(throttle = 0, steer = 0) {
    this._analogThrottle = Number.isFinite(throttle) ? Math.max(-1, Math.min(1, throttle)) : 0;
    this._analogSteer = Number.isFinite(steer) ? Math.max(-1, Math.min(1, steer)) : 0;
    return this;
  }

  /**
   * 上车。先冻结 AI 车，再懒加载 Rapier；物理就绪前的 F 不会重复触发。
   * @returns {Promise<boolean>}
   */
  async enter(candidate) {
    if (this._active || this._pending || this._disposed) return false;
    const claim = this.traffic.claimCar(candidate);
    if (!claim) return false;
    this._pending = true;
    this._claim = claim;
    const token = ++this._token;
    try {
      await physicsManager.init();
    } catch (err) {
      console.error('[CityDriving] Rapier 初始化失败，取消上车：', err);
      this.traffic.releaseCar();
      this._pending = false;
      this._claim = null;
      return false;
    }
    if (this._disposed || token !== this._token) {
      this.traffic.releaseCar();
      this._pending = false;
      this._claim = null;
      return false;
    }

    const R = physicsManager.RAPIER;
    const world = physicsManager.world;
    this._bodies = [];
    this._ai = [];

    // ① 地面 + 城市场景静态 AABB：一次性 collider，全部挂在一个 fixed body 上。
    const staticBody = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    this._bodies.push(staticBody);
    // 地面延伸到都会区北端 z=245；旧 150×150 只到 z=150，车会莫名其妙掉落。
    world.createCollider(
      R.ColliderDesc.cuboid(180, 0.5, 190).setTranslation(0, 0.66, 55).setFriction(0.05),
      staticBody,
    );
    const boxes = (this.getObstacles() || []).filter((b) => b
      && !b.noBlock
      && Number.isFinite(b.minX) && Number.isFinite(b.maxX)
      && Number.isFinite(b.minZ) && Number.isFinite(b.maxZ)
      && b.maxZ > 95 && b.minZ < 250 && b.maxX > -125 && b.minX < 125);
    for (let i = 0; i < boxes.length && i < MAX_BUILDING_COLLIDERS; i++) {
      const b = boxes[i];
      const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
      if (w < 0.3 || d < 0.3 || w > 90 || d > 90) continue;
      world.createCollider(
        R.ColliderDesc.cuboid(w / 2, 7, d / 2)
          .setTranslation((b.minX + b.maxX) / 2, 8.16, (b.minZ + b.maxZ) / 2)
          .setFriction(0.85),
        staticBody,
      );
    }

    // ② 玩家车：完整动态刚体，只放开 Y 轴旋转，X/Z 锁死不会翻车。
    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(claim.x, CAR_SPAWN_Y, claim.z)
      .setRotation(yawQuat(claim.yaw))
      .setLinearDamping(0.42)
      .setAngularDamping(2.6)
      .setCcdEnabled(true);
    this._body = world.createRigidBody(bodyDesc);
    this._body.setEnabledRotations(false, true, false, true);
    world.createCollider(
      R.ColliderDesc.cuboid(CAR_HALF_X, CAR_HALF_Y, CAR_HALF_Z)
        .setDensity(70)
        // 盒体没有滚动的车轮，高摩擦会把引擎冲量吃掉；侧向抓地由上方代码显式衰减。
        .setFriction(0.08)
        .setRestitution(0.16),
      this._body,
    );
    this._bodies.push(this._body);

    // ③ AI 车简化包围盒：kinematic 只挡不推，避免 12 组车辆动力学求解。
    this._buildAiColliders(R, world);

    this._car = this.traffic.createPlayerCar();
    this._car.group.visible = true;
    this._active = true;
    this._pending = false;
    this._speedKmh = 0;
    this._lastYaw = claim.yaw;
    this._syncVisual();
    this.clearKeys();
    return true;
  }

  _buildAiColliders(R, world) {
    const skipMoving = this._claim?.parked === false ? this._claim.index : -1;
    const skipParked = this._claim?.parked === true ? this._claim.index : -1;
    const add = (kind, index, pose, half) => {
      if (!pose) return;
      const body = world.createRigidBody(
        R.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(pose.x, 1.90, pose.z)
          .setRotation(yawQuat(pose.yaw)),
      );
      world.createCollider(
        R.ColliderDesc.cuboid(half[0], half[1], half[2]).setFriction(0.35),
        body,
      );
      this._bodies.push(body);
      this._ai.push({ kind, index, body });
    };
    for (let i = 0; i < 10; i++) {
      if (i === skipMoving) continue;
      add('moving', i, this.traffic.getMovingPose(i), [CAR_HALF_X, CAR_HALF_Y, CAR_HALF_Z]);
    }
    for (let i = 0; i < 2; i++) {
      if (i === skipParked) continue;
      add('parked', i, this.traffic.getParkedPose(i), [CAR_HALF_X, CAR_HALF_Y, CAR_HALF_Z]);
    }
    add('bus', 0, this.traffic.getBusPose(), [1.2, 1.2, 3.8]);
  }

  _syncAi() {
    if (!this._ai.length) return;
    for (const rec of this._ai) {
      const pose = rec.kind === 'parked'
        ? this.traffic.getParkedPose(rec.index)
        : rec.kind === 'bus'
          ? this.traffic.getBusPose()
          : this.traffic.getMovingPose(rec.index);
      if (!pose) continue;
      rec.body.setNextKinematicTranslation({ x: pose.x, y: rec.kind === 'bus' ? 2.42 : 1.90, z: pose.z });
      rec.body.setNextKinematicRotation(yawQuat(pose.yaw));
    }
  }

  update(dt) {
    if (!this._active || !this._body) return;
    const step = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    if (step <= 0) return;
    this._syncAi();

    const R = physicsManager.RAPIER;
    if (!R) return;
    const body = this._body;
    const t = body.translation();
    const rot = body.rotation();
    this._q.set(rot.x, rot.y, rot.z, rot.w);
    this._fwd.set(0, 0, 1).applyQuaternion(this._q);
    const fx = this._fwd.x;
    const fz = this._fwd.z;
    const yaw = Math.atan2(fx, fz);

    const vel = body.linvel();
    let fwdSpeed = vel.x * fx + vel.z * fz;
    const rightX = -fz, rightZ = fx;
    let lat = vel.x * rightX + vel.z * rightZ;

    let throttle = (this._keys.has('KeyW') || this._keys.has('ArrowUp') ? 1 : 0)
      - (this._keys.has('KeyS') || this._keys.has('ArrowDown') ? 1 : 0);
    let steer = (this._keys.has('KeyA') || this._keys.has('ArrowLeft') ? 1 : 0)
      - (this._keys.has('KeyD') || this._keys.has('ArrowRight') ? 1 : 0);
    throttle = Math.max(-1, Math.min(1, throttle + this._analogThrottle));
    steer = Math.max(-1, Math.min(1, steer + this._analogSteer));
    const mass = Math.max(1, body.mass());

    // 加减速：向当前 forward 施加物理冲量；S 在前行时作为刹车。
    let accel = 0;
    if (throttle > 0 && fwdSpeed < MAX_FORWARD) accel = 10.5;
    else if (throttle < 0) {
      if (fwdSpeed > 0.4) accel = -13.5;
      else if (fwdSpeed > -MAX_REVERSE) accel = -5.2;
    }
    // 转向：速度越低转向越弱，倒车自动反向；只写 Y 角速度。
    const speedAbs = Math.abs(fwdSpeed);
    const steerAuthority = Math.min(1, speedAbs / 5.5) * (fwdSpeed < -0.15 ? -1 : 1);
    body.setAngvel({ x: 0, y: steer * 1.45 * steerAuthority, z: 0 }, true);

    // 路边/草地降速：在重建速度之前处理，不能把本帧冲量一起覆盖掉。
    const offRoad = !isOnRoad(t.x, t.z);
    if (offRoad) {
      const drag = Math.exp(-0.32 * step);
      fwdSpeed *= drag;
      lat *= drag;
    }

    // 侧向抓地：保留前向/竖直速度，快速衰减侧滑，避免像冰面。
    if (speedAbs > 0.1 || Math.abs(lat) > 0.05) {
      const grip = Math.exp(-8.5 * step);
      lat *= grip;
      if (fwdSpeed > MAX_FORWARD) fwdSpeed = MAX_FORWARD;
      if (fwdSpeed < -MAX_REVERSE) fwdSpeed = -MAX_REVERSE;
      body.setLinvel({ x: fx * fwdSpeed + rightX * lat, y: vel.y, z: fz * fwdSpeed + rightZ * lat }, true);
    }

    // 冲量必须写在抓地重建速度之后，否则会被 setLinvel 覆盖。
    if (accel !== 0) {
      const impulse = accel * mass * step;
      body.applyImpulse({ x: fx * impulse, y: 0, z: fz * impulse }, true);
    }

    // 防掉出世界：掉落或越界时回到上车点上方（不会产生新对象）。
    if (t.y < 0.35 || Math.abs(t.x) > 175 || t.z < -125 || t.z > 252) {
      body.setTranslation({ x: this._claim.x, y: CAR_SPAWN_Y, z: this._claim.z }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }

    this._lastYaw = yaw;
    this._speedKmh = Math.hypot(vel.x, vel.z) * 3.6;
    // 轮胎真实滚动 + 前轮随方向轻微转角；只改已有 Mesh 的 rotation。
    this._wheelSpin = (this._wheelSpin - (fwdSpeed * step) / 0.30) % (Math.PI * 2);
    this._steerVisual += (steer * 0.42 - this._steerVisual) * Math.min(1, step * 10);
    for (const wheel of this._car?.wheels || []) {
      wheel.mesh.rotation.order = 'YXZ';
      wheel.mesh.rotation.x = this._wheelSpin;
      wheel.mesh.rotation.y = wheel.front ? -this._steerVisual : 0;
    }
    this.traffic.setPlayerPose?.({ x: t.x, z: t.z, yaw, speed: this._speedKmh / 3.6 });
    this._syncVisual();
  }

  _syncVisual() {
    if (!this._body || !this._car) return;
    const t = this._body.translation();
    const r = this._body.rotation();
    this._car.group.position.set(t.x, t.y, t.z);
    this._car.group.quaternion.set(r.x, r.y, r.z, r.w);
    const yaw = Math.atan2(
      2 * (r.w * r.y + r.x * r.z),
      1 - 2 * (r.y * r.y + r.z * r.z),
    );
    const cam = this.camera;
    if (cam) {
      /* 【相机写者契约】驾驶相机走 CameraRig 受控直写（逐帧紧跟刚体，不能用过渡）。
       * 不显式传 owner → writePose 用当前 owner（lobby / lobby-wasd，均在
       * Lobby.init 登记为受控直写者）校验。若未持 owner / 未登记（上车竞态），
       * writePose 拒绝且不改相机——宁可停一帧，也不出现无人仲裁的相机双写。
       * 其它相机写者（OrbitControls/WASD/zooFly）在 _driving.active 时已被门控屏蔽。 */
      if (this._view === 'third') {
        // 第三人称追车：后 7.2m、上 2.4m，视线落在车头前方 3m。
        const dist = 7.2, up = 2.4;
        cameraRig.writePose({
          position: [t.x - Math.sin(yaw) * dist, t.y + up, t.z - Math.cos(yaw) * dist],
          lookAt: [t.x + Math.sin(yaw) * 3.0, t.y + 0.35, t.z + Math.cos(yaw) * 3.0],
        });
      } else {
        // 驾驶位：略高于车顶，避免看见车厢内壁；保持第一人称视野。
        // yaw+π 对应车头 -Z 朝向；转成 quaternion 供 rig 直写（零分配）。
        _Q_DRIVE.setFromEuler(_E_DRIVE.set(-0.055, yaw + Math.PI, 0, 'YXZ'));
        cameraRig.writePose({
          position: [t.x + Math.sin(yaw) * 0.12, t.y + 0.68, t.z + Math.cos(yaw) * 0.12],
          quaternion: _Q_DRIVE,
        });
      }
    }
  }

  /** 由 Lobby 每帧传入城市夜色 0…1；只调共享材质透明度，不新建灯。 */
  setNight(f) {
    const n = Math.max(0, Math.min(1, Number(f) || 0));
    const car = this._car;
    if (car?.lightMats) for (const m of car.lightMats) m.opacity = 0.16 + n * 0.84;
    if (car?.headPool) car.headPool.material.opacity = n * 0.55;
  }

  /**
   * 下车：移除全部临时刚体 / collider，交还 AI 车与相机姿态。
   * @returns {{x:number,z:number,yaw:number}|null}
   */
  exit() {
    if (!this._active || !this._body) return null;
    const t = this._body.translation();
    const r = this._body.rotation();
    this._q.set(r.x, r.y, r.z, r.w);
    this._fwd.set(0, 0, 1).applyQuaternion(this._q);
    const fx = this._fwd.x, fz = this._fwd.z;
    const yaw = Math.atan2(fx, fz);
    // 下车点 = 车身左侧 2.1m（forward 的左手方向），由 Lobby 再做 AABB 消解。
    const pose = { x: t.x + fz * 2.1, z: t.z - fx * 2.1, yaw };
    const carPose = { x: t.x, z: t.z, yaw };

    const world = physicsManager.isReady ? physicsManager.world : null;
    if (world) {
      for (const body of this._bodies) {
        try { world.removeRigidBody(body); } catch (err) { /* 已移除则忽略 */ }
      }
    }
    this._bodies.length = 0;
    this._ai.length = 0;
    this._body = null;
    if (this._car) this._car.group.visible = false;
    this.traffic.setPlayerPose?.(null);
    this.traffic.releaseCarAt(carPose);
    this._claim = null;
    this._active = false;
    this._pending = false;
    this._speedKmh = 0;
    this.clearKeys();
    return pose;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._token += 1;
    if (this._active) {
      this.exit();
    } else if (this._pending) {
      this.traffic.releaseCar();
      this._pending = false;
      this._claim = null;
    }
    this._car = null;
    this.camera = null;
  }
}

export default CityDriving;
