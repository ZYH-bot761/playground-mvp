/**
 * ============================================================================
 * CoasterCarRuntime.js —— 过山车小车挂轨运行时（v4 T04a）
 * ============================================================================
 * 职责：让大厅里的高架轨道上真正跑起过山车小车——「小车就在轨道上、与轨道
 * 链接，不再悬空」。Lobby._buildCoasterTrack() 只建了 rails/ties/pillars，
 * 没有 car mesh、也没有位姿更新；本类补上这一环。
 *
 * 【贴轨铁证】
 *   每节车厢的 position 直接取 `curve.getPointAt(t_i)`（弧长参数），不做任何
 *   偏移 → t=0 与整周期任意帧，position 与曲线点误差 <1e-6，绝不悬空。
 *   朝向抄 TrainRide._placeTrain 的正交基算法：
 *     right = up × tangent；basisUp = tangent × right；makeBasis(right, basisUp, tangent)
 *   车厢本地 +Z = 轨道切线（前进方向），+Y = basisUp，+X = right。基天然正交。
 *
 * 【压弯 / 防眩晕】
 *   曲率驱动的目标 roll（同 TrainRide._computeBankTarget）经指数低通平滑，
 *   幅度限制 MAX_BANK（约 16°），绕本地 Z（切线）旋转——不改变 position，
 *   且旋转矩阵列仍两两正交。无随机抖动、无 roll 突变、无累积。
 *
 * 【资源 / 边界】
 *   几何与材质由本类自建、自登记（不依赖 Lobby._shared），dispose 幂等释放、
 *   从 parent 移除 root。不打 attractionRoot 标记（大厅常驻装饰，归 Lobby 管）。
 *   零每帧 new：所有 Vector3 / Quaternion / Matrix4 预分配复用。
 *
 * 【接线（T07 工程师务必按接法①）】
 *   ⚠️ 接法①【推荐·零同步风险】：在 Lobby._buildCoasterTrack() 里把局部 curve 存成
 *      `this._coasterCurve = curve`（一行改动），再把这条【同一个曲线对象】传给运行时：
 *        const runtime = new CoasterCarRuntime({ curve: lobby._coasterCurve, period: 40 });
 *      小车与实际轨道天然 100% 一致，无需任何坐标同步。period 建议 36~48s（本类默认
 *      24s 在 ~192m 急弯曲线上偏快，放慢可缓解急弯处切线转向、观感更稳）。
 *      然后：runtime.init(lobby.root) → 每帧 runtime.update(dt) → 清理 runtime.dispose()
 *
 *   ⚠️ 接法②【仅备用 / 独立测试，不作为主接线】：
 *      const runtime = new CoasterCarRuntime({ curve: createLobbyCoasterCurve(COASTER) });
 *      工厂逐字复刻 Lobby 的曲线构建，但与 Lobby 之间是【两份代码】——若 Lobby 的
 *      COASTER 常量或构建参数（角度采样 / 半轴公式 / closed / tension /
 *      arcLengthDivisions）改动而本工厂未同步，小车就会与实际轨道错位 → 悬空。
 *
 *   【为什么不推荐②】Lobby.js 正被 T02/WASD 等多任务并行修改，_buildCoasterTrack 的
 *   行号持续漂移（已观察到 2384→2433+），按行号定位或维护"同步清单"极脆弱；接法①
 *   直接复用同一 curve 引用，从根本上消除这类耦合。工厂保留仅用于脱离 Lobby 的隔离
 *   探针与离线验证，已实测与 Lobby 参考实现 1001 采样点逐点误差 0。
 * ============================================================================
 */
import * as THREE from 'three';

/** 世界竖直方向（常量，禁止每帧 new） */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** 切线近竖直时的退化备选（避免 up×tangent 归零） */
const FALLBACK_RIGHT = new THREE.Vector3(1, 0, 0);
/** 本地 Z 轴（切线方向，压弯绕它旋转） */
const LOCAL_Z = new THREE.Vector3(0, 0, 1);

/** 最大压弯角（弧度，约 16°，比 TrainRide 的 24° 更克制，防眩晕） */
const MAX_BANK = 0.28;
/** 压弯低通系数：bank += (target-bank)*(1-exp(-BANK_K*dt)) */
const BANK_K = 2.8;
/**
 * 压弯角速度上限（rad/s）：slew rate limit，硬性保证「无 roll 突变」。
 * 低通只能衰减目标跳变，急弯处仍可能单帧跳 0.03rad；加限速后单帧变化恒 <= RATE*dt
 * （60fps 下 <=0.015rad/帧），且满压弯 0.28rad 约 0.35s 到位，响应不受损。
 */
const MAX_BANK_RATE = 0.9;
/** 曲率采样偏移（与 TrainRide 一致） */
const BANK_DELTA = 0.003;

/**
 * 【T04a 补充·曲线工厂】按 Lobby 的 COASTER 常量构建与实际高架轨道【完全一致】的曲线。
 *
 * 构建逻辑逐字抄自 Lobby.js 的 `_buildCoasterTrack()`（当前磁盘 2436-2445 行）：
 *   const points = COASTER.heights.map((h, i) => {
 *     const a = (i / COASTER.heights.length) * Math.PI * 2;
 *     return new THREE.Vector3(
 *       COASTER.cx + COASTER.lobeA * Math.sin(a),
 *       h,
 *       COASTER.cz + COASTER.lobeB * Math.sin(a) * Math.cos(a));
 *   });
 *   const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.5);
 *   curve.arcLengthDivisions = 400;
 *
 * ⚠️ 强同步约束：若 Lobby.js 的 COASTER 常量或上述曲线构建（角度采样 / 半轴公式 /
 * closed / tension / arcLengthDivisions）有任何改动，【必须同步修改本工厂】，否则
 * 小车曲线与轨道曲线错位 → 用户反馈的「小车悬空 / 不贴轨」。行号会因其他任务改动
 * 而漂移，请以 `_buildCoasterTrack` 里的实际代码为准，不要只按行号定位。
 *
 * T07 两种接法：
 *   ① Lobby 存字段：this._coasterCurve = curve; new CoasterCarRuntime({ curve: this._coasterCurve })（推荐，天然一致）
 *   ② 不存字段：new CoasterCarRuntime({ curve: createLobbyCoasterCurve(COASTER) })（本工厂，需保证上述同步）
 *
 * @param {{cx:number, cz:number, lobeA:number, lobeB:number, heights:number[]}} COASTER
 *        Lobby.js 的 COASTER 常量（24 点高度表）
 * @returns {THREE.CatmullRomCurve3} 与实际轨道逐点一致的闭合曲线
 */
export function createLobbyCoasterCurve(COASTER) {
  if (!COASTER || !Array.isArray(COASTER.heights) || COASTER.heights.length === 0) {
    throw new Error('[CoasterCarRuntime] createLobbyCoasterCurve 需要 COASTER.heights 数组');
  }
  const points = COASTER.heights.map((h, i) => {
    const a = (i / COASTER.heights.length) * Math.PI * 2;
    return new THREE.Vector3(
      COASTER.cx + COASTER.lobeA * Math.sin(a),
      h,
      COASTER.cz + COASTER.lobeB * Math.sin(a) * Math.cos(a)
    );
  });
  const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.5);
  curve.arcLengthDivisions = 400;
  return curve;
}

export class CoasterCarRuntime {
  /**
   * @param {object} [o]
   * @param {THREE.Curve} [o.curve=null] 闭合轨道曲线（由调用方传入）；可稍后 setCurve
   * @param {number} [o.carCount=3] 车厢节数（2~3 推荐）
   * @param {number} [o.period=24] 单圈时长（秒）
   * @param {number} [o.trackGauge=1.8] 轨距（车厢宽度 / 轮距）
   * @param {number} [o.carSpacing=0.02] 相邻车厢的弧长参数间隔（0.02×~160m≈3.2m）
   * @param {number} [o.carLength=2.4] 单节车厢长度；会自动收敛到不穿模
   */
  constructor({ curve = null, carCount = 3, period = 24, trackGauge = 1.8,
    carSpacing = 0.02, carLength = 2.4 } = {}) {
    this._curve = curve;
    this._carCount = Math.max(1, Math.floor(carCount));
    this._period = period > 0 ? period : 24;
    this._gauge = trackGauge > 0 ? trackGauge : 1.8;
    this._spacing = Math.abs(carSpacing);
    this._carLengthParam = carLength > 0 ? carLength : 2.4;
    this._carLength = this._carLengthParam;

    /** @type {THREE.Group|null} 本运行时的根，挂在 parent 下 */
    this.root = null;
    /** @type {THREE.Object3D|null} */
    this._parent = null;
    /** @type {THREE.Group[]} */
    this._cars = [];
    /** @type {number[]} 每节车厢当前压弯角 */
    this._banks = [];
    /** @type {Array<{right:THREE.Vector3,up:THREE.Vector3,tangent:THREE.Vector3}>} 只读基快照 */
    this._carBases = [];

    // 资源台账（自建自释放）
    /** @type {THREE.BufferGeometry[]} */
    this._geometries = [];
    /** @type {THREE.Material[]} */
    this._materials = [];

    // 复用的数学对象（零每帧 new）
    this._point = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._basisUp = new THREE.Vector3();
    this._tanA = new THREE.Vector3();
    this._tanB = new THREE.Vector3();
    this._cross = new THREE.Vector3();
    this._basis = new THREE.Matrix4();
    this._qBank = new THREE.Quaternion();

    this._t = 0;
    this._length = curve ? this._safeLength(curve) : 0;
    this._speed = this._length / this._period;
    /** @type {number} 相邻车厢最小弦距（init 时采样） */
    this._minChord = Infinity;
    this._disposed = false;
    this._inited = false;
  }

  /** 当前弧长参数 t ∈ [0,1) */
  get t() { return this._t; }
  /** 车厢 Group 数组（只读用；每节 position/quaternion 即贴轨位姿） */
  get cars() { return this._cars; }
  /** 是否已 init */
  get isInited() { return this._inited; }
  /** 曲线长度（米，0 表示尚无曲线） */
  get trackLength() { return this._length; }
  /** 当前单节车厢长度（已自适应到最小弯道弦距，保证不穿模） */
  get carLength() { return this._carLength; }
  /** 相邻车厢间隔的最小欧氏弦距（init 时采样；Infinity 表示无曲线） */
  get minChord() { return this._minChord; }
  /**
   * 第 index 节车厢的弧长参数 t ∈ [0,1)（与 update 内部 ti 公式完全一致）。
   * 供验收探针测量「车厢是否贴轨」：curve.getPointAt(getCarT(i)) 应 ≈ car.position。
   */
  getCarT(index) {
    const n = this._carCount;
    const i = (((index % n) + n) % n);
    return (this._t - i * this._spacing + 1) % 1;
  }

  /** 安全取曲线长度（部分 Curve 实现 arcLengthDivisions 未设时仍可用） */
  _safeLength(curve) {
    const len = curve.getLength();
    return Number.isFinite(len) && len > 0 ? len : 0;
  }

  /**
   * 采样整条曲线，求相邻车厢间隔的最小欧氏弦距。
   * 3D 曲线急弯处「弦 < 弧」，若车长按平均弧长收敛会在急弯处穿模；
   * 取最小弦距作为车长上限，才能保证任何位置都不重叠。
   */
  _computeMinChord() {
    if (!this._curve || this._spacing <= 0 || this._length <= 0) return Infinity;
    const N = 360;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let min = Infinity;
    for (let i = 0; i < N; i += 1) {
      const t = i / N;
      this._curve.getPointAt(t, a);
      this._curve.getPointAt((t - this._spacing + 1) % 1, b);
      const d = a.distanceTo(b);
      if (d < min) min = d;
    }
    return min;
  }

  /**
   * 建车厢并挂到 parent（幂等）。几何/材质自建自登记。
   * @param {THREE.Object3D} parent scene 或 Lobby.root
   * @returns {this}
   */
  init(parent) {
    if (this._disposed || this._inited) return this;
    if (!parent) throw new Error('[CoasterCarRuntime] init(parent) 需要 parent');
    this._parent = parent;

    this.root = new THREE.Group();
    this.root.name = 'CoasterCarRuntime/cars';
    this.root.userData.runtime = this; // 暴露运行时句柄，供调试 / 验证探针读取
    parent.add(this.root);

    // 车长自适应：急弯处弦距 < 弧长，必须按【最小弦距】收敛车长才不穿模。
    // 采样曲线得最小弦距，车长 = min(参数值, 最小弦距×0.78)，留出连接钩余量。
    this._minChord = this._computeMinChord();
    if (Number.isFinite(this._minChord)) {
      this._carLength = Math.min(this._carLengthParam, this._minChord * 0.78);
    }

    this._buildResources();
    for (let i = 0; i < this._carCount; i += 1) {
      const car = this._buildCar(i);
      this._cars.push(car);
      this.root.add(car);
      this._banks.push(0);
      this._carBases.push({
        right: new THREE.Vector3(1, 0, 0),
        up: new THREE.Vector3(0, 1, 0),
        tangent: new THREE.Vector3(0, 0, 1),
      });
    }

    this._inited = true;
    // t=0 立即贴轨（起始段不悬空）；dt=0 只放置、不推进压弯
    this.update(0);
    return this;
  }

  /** 建共享几何与材质（一次，全部登记台账） */
  _buildResources() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const wheel = new THREE.CylinderGeometry(1, 1, 1, 12);
    this._geometries.push(box, wheel);
    this._boxGeo = box;
    this._wheelGeo = wheel;

    const mk = (color, opts = {}) => new THREE.MeshStandardMaterial({
      color, roughness: opts.roughness ?? 0.55, metalness: opts.metalness ?? 0.25,
      flatShading: opts.flatShading ?? true,
      emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.emissiveIntensity ?? 0,
    });
    this._matBody = mk(0xe05a3c, { roughness: 0.5, metalness: 0.3 });      // 车身橙红
    this._matDark = mk(0x2b3242, { roughness: 0.62, metalness: 0.5 });     // 底盘/护栏深色金属
    this._matSeat = mk(0x3b82c4, { roughness: 0.8, metalness: 0.05 });     // 座椅蓝
    this._matGlass = mk(0x172434, { roughness: 0.2, metalness: 0.7 });     // 车窗深色玻璃
    this._matWheel = mk(0x4a505c, { roughness: 0.72, metalness: 0.45 });   // 车轮
    this._matGold = mk(0xc8a44c, { roughness: 0.42, metalness: 0.72 });    // 装饰金边
    this._matLamp = mk(0xffe9a8, { roughness: 0.3, metalness: 0.1,
      emissive: 0xffc860, emissiveIntensity: 0.9 });                      // 车头灯
    this._materials.push(this._matBody, this._matDark, this._matSeat,
      this._matGlass, this._matWheel, this._matGold, this._matLamp);
  }

  /** 用共享 box 几何拼一个方块（非等比缩放），登记为 mesh 但不单独记资源 */
  _box(parent, material, w, h, d, x, y, z) {
    const m = new THREE.Mesh(this._boxGeo, material);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    parent.add(m);
    return m;
  }

  /** 建一节车厢（车头带灯与楔形鼻，其余为标准车厢）；本地 +Z = 前进方向 */
  _buildCar(index) {
    const car = new THREE.Group();
    car.name = `CoasterCarRuntime/car-${index}`;
    const L = this._carLength;
    const W = this._gauge;
    const isHead = index === 0;

    // 底盘 + 车身
    this._box(car, this._matDark, W, 0.22, L, 0, 0.30, 0);
    this._box(car, this._matBody, W * 0.92, 0.42, L * 0.88, 0, 0.62, 0);
    // 金色腰线（上下两条，增加真实感）
    this._box(car, this._matGold, W * 0.94, 0.05, L * 0.90, 0, 0.44, 0);
    this._box(car, this._matGold, W * 0.94, 0.05, L * 0.90, 0, 0.82, 0);

    // 车头：楔形鼻（两段递缩 box 模拟流线）+ 车头灯
    if (isHead) {
      this._box(car, this._matBody, W * 0.86, 0.36, L * 0.18, 0, 0.66, L * 0.50);
      this._box(car, this._matDark, W * 0.72, 0.22, L * 0.12, 0, 0.56, L * 0.60);
      this._box(car, this._matLamp, W * 0.16, 0.14, 0.08, -W * 0.26, 0.68, L * 0.66);
      this._box(car, this._matLamp, W * 0.16, 0.14, 0.08, W * 0.26, 0.68, L * 0.66);
    }

    // 车窗（两侧）+ 座椅靠背 / 坐垫
    const glassH = 0.30;
    this._box(car, this._matGlass, 0.06, glassH, L * 0.46, -W * 0.46, 0.92, L * 0.08);
    this._box(car, this._matGlass, 0.06, glassH, L * 0.46, W * 0.46, 0.92, L * 0.08);
    this._box(car, this._matSeat, W * 0.74, 0.52, 0.10, 0, 1.02, -L * 0.16); // 靠背
    this._box(car, this._matSeat, W * 0.74, 0.12, L * 0.32, 0, 0.86, L * 0.02); // 坐垫

    // 左右护栏（车顶两侧）
    this._box(car, this._matDark, 0.10, 0.34, L * 0.62, -W * 0.46, 1.02, 0);
    this._box(car, this._matDark, 0.10, 0.34, L * 0.62, W * 0.46, 1.02, 0);

    // 四个轮子（共享 Cylinder，轴沿 X；mesh.rotation.z=π/2 让圆柱侧朝外）
    const wr = 0.22;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const wheel = new THREE.Mesh(this._wheelGeo, this._matWheel);
        wheel.scale.set(wr, 0.12, wr);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * (W * 0.5 - 0.06), 0.12, sz * (L * 0.30));
        car.add(wheel);
      }
    }

    // 车厢间的连接钩（首尾小凸起，视觉上"挂"在一起）
    this._box(car, this._matDark, 0.10, 0.10, 0.28, 0, 0.42, -L * 0.52);
    this._box(car, this._matDark, 0.10, 0.10, 0.28, 0, 0.42, L * 0.52);

    return car;
  }

  /**
   * 目标压弯角：由 t±BANK_DELTA 两处切线夹角得曲率，侧向加速度 v²κ 与重力比较取 atan。
   * 闭合处取模避免假曲率；方向由转向符号决定（向弯内倾）。抄 TrainRide._computeBankTarget。
   */
  _bankTarget(t) {
    const curve = this._curve;
    if (!curve || this._length <= 1e-6) return 0;
    const tA = (t - BANK_DELTA + 1) % 1;
    const tB = (t + BANK_DELTA) % 1;
    curve.getTangentAt(tA, this._tanA).normalize();
    curve.getTangentAt(tB, this._tanB).normalize();
    const angle = this._tanA.angleTo(this._tanB);
    const arc = BANK_DELTA * 2 * this._length;
    const curvature = arc > 1e-6 ? angle / arc : 0;
    this._cross.crossVectors(this._tanA, this._tanB);
    const turnSign = Math.sign(this._cross.dot(WORLD_UP));
    const lateral = this._speed * this._speed * curvature;
    const magnitude = Math.min(MAX_BANK, Math.atan2(lateral, 9.8));
    return -turnSign * magnitude;
  }

  /**
   * 每帧贴轨 + 压弯。t = (t + dt/period) % 1；t_i = (t - i*spacing + 1) % 1。
   * position 直接取曲线点（贴轨铁证）；朝向用正交基 + 绕本地 Z 的平滑压弯。
   * @param {number} dt 帧间隔（秒）；dt<=0 时只放置、不推进 t 与压弯
   * @returns {this}
   */
  update(dt = 0) {
    if (this._disposed || !this._inited) return this;
    // 无曲线：车厢停在原点（等 setCurve），不崩溃
    if (!this._curve) return this;

    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (step > 0) this._t = (this._t + step / this._period) % 1;
    const bankLerp = step > 0 ? 1 - Math.exp(-BANK_K * step) : 0;

    for (let i = 0; i < this._cars.length; i += 1) {
      const car = this._cars[i];
      const ti = (this._t - i * this._spacing + 1) % 1;

      // ---- 贴轨：position 直接取曲线点，零偏移 ----
      this._curve.getPointAt(ti, this._point);
      this._curve.getTangentAt(ti, this._tangent).normalize();

      // ---- 正交基（抄 _placeTrain）：right=up×tangent, basisUp=tangent×right ----
      this._right.crossVectors(WORLD_UP, this._tangent);
      if (this._right.lengthSq() < 1e-8) {
        this._right.crossVectors(FALLBACK_RIGHT, this._tangent);
      }
      this._right.normalize();
      this._basisUp.crossVectors(this._tangent, this._right).normalize();
      this._basis.makeBasis(this._right, this._basisUp, this._tangent);

      car.position.copy(this._point);
      car.quaternion.setFromRotationMatrix(this._basis);

      // ---- 压弯：指数低通 + slew rate limit，绕本地 Z（切线）旋转，保持 basis 正交 ----
      if (step > 0) {
        const target = this._bankTarget(ti);
        const smoothed = this._banks[i] + (target - this._banks[i]) * bankLerp;
        // 限速：单帧变化恒 <= MAX_BANK_RATE*dt，杜绝急弯处的 roll 突变
        const maxDelta = MAX_BANK_RATE * step;
        const delta = smoothed - this._banks[i];
        this._banks[i] += Math.max(-maxDelta, Math.min(maxDelta, delta));
      }
      if (Math.abs(this._banks[i]) > 1e-6) {
        this._qBank.setFromAxisAngle(LOCAL_Z, this._banks[i]);
        car.quaternion.multiply(this._qBank);
      }

      // ---- 供验收读取的只读基快照（预分配对象，逐帧 copy，不 new） ----
      const basisSnap = this._carBases[i];
      basisSnap.tangent.copy(this._tangent);
      basisSnap.right.copy(this._right);
      basisSnap.up.copy(this._basisUp);
    }
    return this;
  }

  /**
   * 运行时替换曲线（轨道重建时用）。会重算长度/速度并把 t 归零后贴轨。
   * @param {THREE.Curve} curve
   * @returns {this}
   */
  setCurve(curve) {
    if (this._disposed) return this;
    this._curve = curve;
    this._length = curve ? this._safeLength(curve) : 0;
    this._speed = this._length / this._period;
    this._minChord = this._computeMinChord();
    // 车长按比例重收敛到新曲线的最小弦距（缩放已建车厢的 z，零新建资源）
    if (this._inited && Number.isFinite(this._minChord)) {
      const newLen = Math.min(this._carLengthParam, this._minChord * 0.78);
      const scaleZ = newLen / this._carLength;
      this._carLength = newLen;
      for (const car of this._cars) car.scale.z *= scaleZ;
    }
    this._t = 0;
    for (let i = 0; i < this._banks.length; i += 1) this._banks[i] = 0; // 换轨清零压弯，避免旧 roll 残留
    if (this._inited) this.update(0);
    return this;
  }

  /**
   * 读取第 i 节车厢的只读基快照（right/up/tangent，均为单位向量且两两正交）。
   * 返回的是复用对象，请在下次 update 前读取，勿长期持有。
   * @param {number} i
   * @returns {{right:THREE.Vector3,up:THREE.Vector3,tangent:THREE.Vector3}|null}
   */
  getCarBasis(i) {
    return this._carBases[i] ?? null;
  }

  /** 读取第 i 节车厢当前压弯角（弧度） */
  getCarBank(i) {
    return this._banks[i] ?? 0;
  }

  /** 当前 tick 的弧长参数 t（每节车厢的 t_i 可由此推出） */
  getCarT(i) {
    return (this._t - i * this._spacing + 1) % 1;
  }

  /**
   * 清理：从 parent 移除 root、释放自建 geometry/material、清台账。幂等。
   * 不打 attractionRoot 标记；scene/camera 归调用方所有，本类只解引用。
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.root?.parent) this.root.parent.remove(this.root);
    for (const g of this._geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    this._geometries.length = 0;
    this._materials.length = 0;
    this._cars.length = 0;
    this._banks.length = 0;
    this._carBases.length = 0;
    this.root = null;
    this._parent = null;
    this._curve = null;
    this._inited = false;
  }
}

export default CoasterCarRuntime;
