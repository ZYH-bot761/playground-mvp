/**
 * ============================================================================
 * SkyGarden.js —— 空中花园交通系统（太空电梯 + 太空高铁 + 高空轨道环）
 * ============================================================================
 * 【玩家可见的完整链路】
 *   ① 地面西侧「太空电梯」：走到基座旁按 E 进舱 → 舱厢垂直爬升 142m，
 *      全程以公园中心为视点，越升越俯；到顶停在 146m 的空中花园站台，按 E 下到地面。
 *   ② 地面「太空高铁」站台：站台上一列 4 节悬浮列车，按 E 登车 → 点「发车」/按 E
 *      列车沿一条长 ~200m 的爬升轨道一路升高，从云层中穿出，抵达轨道环上的空中站台；
 *      到站后按 E 返程，回到地面自动下车。
 *   ③ 146m 高空一圈 r=88 的环状轨道（环梁 + 踏步板 + 自发光灯带），
 *      可供后续在天上加装置（站台 / 花园 / 观景台）。本次只铺轨道与两个登乘点。
 *
 * 【为什么不做成嵌入视图（IEmbeddedView）】
 *   空中花园必须「从地面就看得见」，且电梯 / 高铁升空过程中地面大厅要一直存在——
 *   这正好不是嵌入视图（嵌入=换机位、隐藏城市外壳），而是与驾驶同类：
 *   Lobby 常驻，本模块只在乘梯 / 乘车期间借相机，逐帧 writePose。
 *
 * 【相机契约】
 *   所有相机写入走 cameraRig.writePose({ ..., owner: 当前 owner })，
 *   只在骑乘态接管；退出时用 0.55s 把机位插值回登乘前的姿态，再交还 Orbit/WASD。
 *   owner 不是 'lobby'（被设施接管）时绝不写，避免与 FacilityRuntime 抢相机。
 *
 * 【性能】
 *   全部静态资产一次性建完：环 1 个 Torus + 2 个 InstancedMesh，电梯 ~8 个 Mesh，
 *   轨道 1 个 Tube + 1 个 InstancedMesh 枕木，列车 3 个 InstancedMesh（4 节×3 层）。
 *   合计约 8.5k 三角面 / 约 18 draw call，热路径零新建几何、零新建材质。
 *   所有材质 fog:false —— 否则 45~130 的雾会把 146m 外的环糊成一团白。
 *
 * 【与大厅的接线点】（改这里时同步改 lobby-scene.js）
 *   - init：buildSkyGarden(...).build()，然后把 group 挂到 lobby root（资源由 lobby 统一 dispose）
 *   - update：骑乘态先关 OrbitControls，再在 _updateAnimations 之后调 sky.update(dt)
 *   - 输入：_onInteractKey 开头调 sky.handleInteract()（返回 true 表示 E 已被吃掉）
 *   - 输入互斥：WASD / 摇杆 / F 漫游的 isEnabled 追加 !sky.isRiding
 *   - 植被避让：_exclusionZones() 里 push SKY_SITES
 * ============================================================================
 */
import * as THREE from 'three';
import cameraRig from '../../core/camera-rig.js';

/* -------------------------------------------------------------------------- */
/* 尺寸与坐标（唯一权威，验收脚本直接读这些常量）                              */
/* -------------------------------------------------------------------------- */

/** 高空轨道环：水平圆环，中心 (cx,cz)，半径 r，高度 y */
export const SKY_RING = Object.freeze({ cx: 0, cz: 54, y: 146, r: 88, tube: 1.15 });

/** 太空电梯基座：正好落在轨道环的圆上（方位角 250°），舱厢垂直升到环 */
/* 电梯基座：刻意落在环体【外侧 6m】（半径 94，环半径 88）。
 * 若压着环走，舱厢上到 146m 时镜头会被 1.15m 管径的环梁顶在脸上，
 * 站到顶上也只能看到一根灰管子；外挂 6m + 顶端栈桥才看得到「空中走廊」。 */
export const SKY_ELEVATOR = Object.freeze({ x: -88.4, z: 21.9, baseR: 6.6 });

/* 电梯方位上的径向外法线 / 切向，供栈桥与到站机位复用 */
const _elevDx = SKY_ELEVATOR.x - SKY_RING.cx;
const _elevDz = SKY_ELEVATOR.z - SKY_RING.cz;
const _elevR = Math.hypot(_elevDx, _elevDz);
const _nx = _elevDx / _elevR;
const _nz = _elevDz / _elevR;
const _tx = -_nz;
const _tz = _nx;

/** 太空高铁地面站台（西侧空地，避开四宫格 / 森林公园 / 都会区） */
export const SKY_STATION = Object.freeze({ x: -64, z: -2 });

/** 列车在环上的停靠点（方位角 40°，正对都会区 CBD 上空） */
const DOCK_ANGLE = THREE.MathUtils.degToRad(40);
const DOCK = Object.freeze({
  x: SKY_RING.cx + SKY_RING.r * Math.sin(DOCK_ANGLE),
  z: SKY_RING.cz + SKY_RING.r * Math.cos(DOCK_ANGLE),
  angle: DOCK_ANGLE,
});

/** 植被 / 道具避让圈：由 lobby 的 _exclusionZones() 读取，保证不种树进站台 */
export const SKY_SITES = Object.freeze([
  { x: SKY_ELEVATOR.x, z: SKY_ELEVATOR.z, r: 13 },
  { x: SKY_STATION.x, z: SKY_STATION.z, r: 18 },
]);

const ELEV_TRAVEL = 12.5;      // 电梯单程秒数
const TRAIN_SPEED = 8.6;       // 列车巡航速度 m/s（约 31 km/h，看景不晕）
const INTRO_SECONDS = 0.55;    // 进出舱 / 上车下车的机位插值时长
const RIDE_FOV = 62;           // 骑乘态视场角
const NEAR_ELEV = 9.0;         // 电梯基座 E 判定半径
const NEAR_STATION = 15.0;     // 站台 E 判定半径（列车 4 节，站台较长）

/* ---- 空中漫步（deck 模式）---- */
const DECK_Y = SKY_RING.y + 0.85;   // 环上步行面（连续步道板上表面）
const DECK_EYE = 1.72;              // 第一人称眼高
const DECK_FOV = 68;               // 步行态视场角（比骑乘略宽，走着更舒服）
const DECK_IN = 84.2;               // 步道内沿（半径）
const DECK_OUT = 91.8;              // 步道外沿（半径）
const WALK_SPEED = 4.4;             // m/s
const WALK_SPRINT = 8.0;
const LOOK_SENS = 0.0026;           // 鼠标灵敏度（弧度 / 像素）

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

const _UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();   // 只给 _composeLook 当中间量，避免与 out 撞车
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
const _dummy = new THREE.Object3D();
const _HAZE = new THREE.Color(0xa6c3dd);   // 高空远景的雾色（向天蓝）
const _SKY_HIGH = new THREE.Color(0x93bad8); // 高空收起天穹后的天色

const smoothstep = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** 环上方位角 a 处的坐标（a=0 朝 +z 北，顺时针） */
function ringPoint(a, radius, out) {
  return out.set(
    SKY_RING.cx + radius * Math.sin(a),
    SKY_RING.y,
    SKY_RING.cz + radius * Math.cos(a),
  );
}

/** 环上方位角 a 处的切向（行驶方向，a 增大） */
function ringTangent(a, out) {
  return out.set(Math.cos(a), 0, -Math.sin(a)).normalize();
}

/** 两个方位角的最短夹角（-π..π），用于「避开功能区」判断 */
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* -------------------------------------------------------------------------- */
/* 主类                                                                        */
/* -------------------------------------------------------------------------- */

export class SkyGarden {
  /**
   * @param {{
   *   root: THREE.Object3D,
   *   camera: THREE.PerspectiveCamera,
   *   scene: THREE.Scene,
   *   getGroundHeight?: (x:number, z:number) => number,
   *   toast?: (text:string) => void,
   *   getNight?: () => number,
   * }} opts
   */
  constructor(opts) {
    this.root = opts.root;
    this.camera = opts.camera;
    this.scene = opts.scene;
    this.getGroundHeight = typeof opts.getGroundHeight === 'function' ? opts.getGroundHeight : () => 0;
    this.toast = typeof opts.toast === 'function' ? opts.toast : () => {};
    this.getNight = typeof opts.getNight === 'function' ? opts.getNight : () => 0;
    /* 扫描点：第一人称用相机位置，轨道俯瞰用视线落点（否则 maxDistance=50 的
     * 轨道相机永远凑不到基座 9m 内，站台上按 E 会毫无反应）。 */
    this.getScanPoint = typeof opts.getScanPoint === 'function' ? opts.getScanPoint : null;

    this.group = new THREE.Group();
    this.group.name = 'Sky/garden';

    this._geo = [];
    this._mat = [];
    this._instanced = [];

    /** 状态机：idle / elev-up / elev-top / elev-down
     *                  / train-boarded / train-up / train-docked / train-down */
    this._mode = 'idle';
    this._near = null;          // 'elevator' | 'station' | null
    this._introT = -1;          // >=0 表示正在做进出舱机位插值
    this._introFrom = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 55 };
    this._introDur = INTRO_SECONDS;
    this._introTo = 'ride';     // 'ride' | 'ground'

    this._carY = 0;
    this._elevT = 0;
    this._trainT = 0;
    this._rideT = 0;
    this._rideDur = ELEV_TRAVEL;

    this._saved = null;         // 登乘前的机位 + 雾
    this._baseFog = { near: 45, far: 130, color: null };

    this._hud = null;
    this._hudSig = '';
    this._disposed = false;
    this._time = 0;

    /* ---- 自由视角（乘梯 / 乘车 / 空中漫步通用）----
     * yaw / pitch 是叠加在「系统给出的基础机位」之上的偏移，
     * 拖鼠标就能左右环视、上下抬低头，而不是被钉死在一个朝向。 */
    this._look = { yaw: 0, pitch: 0, drag: false, lx: 0, ly: 0, zoom: 1 };

    /* ---- 空中漫步 ----
     * 站到环上以后不再被拴在舱里：WASD 沿步道走、鼠标自由转动，
     * 半径被夹在步道内外沿之间（不会掉下 146m）。 */
    this._deck = {
      angle: 0, r: SKY_RING.r, yaw: 0, pitch: -0.05,
      from: 'elevator',        // 'elevator' | 'train'
      keys: new Set(),
    };
    this._deckWalk = { x: 0, z: 0 };
    this._colliders = [];
    // 到站后第一次按 E 是「出舱漫步」，走完回来再按 E 才是下行 / 返程
    this._walked = null;

    /* 自由视角的鼠标 / 键盘绑定（build 时挂上，dispose 摘掉） */
    this._bindPointerLook();
    this._bindDeckKeys();

    /* 循环复用的相机姿态对象（热路径零分配） */
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._trainPos = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._trainTan = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  }

  /** 是否正在乘梯 / 乘车（大厅据此让出相机与输入） */
  get isRiding() {
    return this._mode !== 'idle';
  }

  /** 验收与调试读取的快照（纯数据，无引用） */
  get status() {
    return {
      mode: this._mode,
      riding: this.isRiding,
      near: this._near,
      intro: +this._introT.toFixed(2),
      altitude: +this.camera?.position.y?.toFixed(2) || 0,
      carY: +this._carY.toFixed(2),
      elevatorProgress: +this._elevT.toFixed(3),
      trainProgress: +this._trainT.toFixed(3),
      ringY: SKY_RING.y,
      dock: { x: +DOCK.x.toFixed(2), z: +DOCK.z.toFixed(2) },
      deck: { angle: +this._deck.angle.toFixed(3), r: +this._deck.r.toFixed(2), from: this._deck.from },
      yaw: +this._look.yaw.toFixed(3),
      pitch: +this._look.pitch.toFixed(3),
      zoom: +this._look.zoom.toFixed(2),
      walk: { x: +this._deckWalk.x.toFixed(2), z: +this._deckWalk.z.toFixed(2) },
    };
  }

  /* ======================================================================== */
  /* 构建                                                                     */
  /* ======================================================================== */

  build() {
    const baseY = Math.max(0, this.getGroundHeight(SKY_ELEVATOR.x, SKY_ELEVATOR.z));
    const stY = Math.max(0, this.getGroundHeight(SKY_STATION.x, SKY_STATION.z));
    this._baseY = baseY;
    this._stationY = stY;

    const fog = this.scene?.fog;
    if (fog) this._baseFog = { near: fog.near, far: fog.far, color: fog.color?.clone?.() ?? null };
    this._sceneFog = fog ?? null;

    this._buildMaterials();
    this._buildRing();
    this._buildElevator(baseY);
    this._buildStation(stY);
    this._buildRail(stY);
    this._buildTrain();
    this._buildGardenPods();
    this._buildSkyDistrict();

    this.root.add(this.group);

    // 天穹盒（scale 150）必须随相机升降，否则升到 146m 会穿出盒子外面看见虚空
    this._sky = this.root?.getObjectByName?.('Lobby/sky') ?? null;
    // 【升空后"一片白"的真凶】大厅的云不是一张贴图，而是三条独立网格
    // Lobby/cloud-band-118 / 96 / 72（Group Lobby/clouds 里只是它们的一部分）。
    // 146m 的甲板正好穿在这几条云带上方，天空一半被云糊白 —— 只藏 Group 没用，
    // 必须把名字里带 cloud 的节点全收进来逐个隐藏。
    this._cloudNodes = [];
    this.root?.traverse?.((o) => {
      if (o !== this.root && /cloud/i.test(o.name || '')) {
        this._cloudNodes.push({ node: o, visible: o.visible });
      }
    });
    this._cloudsOn = true;

    this._buildHud();

    // 首帧就把列车摆到站台、舱厢停在地面，避免"凭空出现"
    this._elevT = 0;
    this._updateElevatorCar(0);
    this._updateTrain(0);
    return this;
  }

  _track(geo) { this._geo.push(geo); return geo; }
  _trackMat(mat) { this._mat.push(mat); return mat; }

  _buildMaterials() {
    const M = (opts) => this._trackMat(new THREE.MeshStandardMaterial({ fog: false, ...opts }));
    this._matHull = M({ color: 0xf3f8fc, roughness: 0.42, metalness: 0.28 });
    this._matSteel = M({ color: 0x8ea2b4, roughness: 0.34, metalness: 0.82 });
    this._matDark = M({ color: 0x2b3542, roughness: 0.62, metalness: 0.45 });
    this._matGlass = M({
      color: 0x9ed8ea, roughness: 0.1, metalness: 0.15,
      transparent: true, opacity: 0.55, depthWrite: false,
      emissive: 0x1d5568, emissiveIntensity: 0.35,
    });
    this._matGlow = M({ color: 0x2a2113, emissive: 0xffcf87, emissiveIntensity: 0.9, roughness: 0.6 });
    this._matGlowCool = M({ color: 0x102028, emissive: 0x7fe3ff, emissiveIntensity: 0.85, roughness: 0.5 });
    this._matLeaf = M({ color: 0x63b984, roughness: 0.92, metalness: 0 });
    this._matPlanter = M({ color: 0x3b4756, roughness: 0.8, metalness: 0.15 });
    // 甲板：石板灰。整条步道若用白色，在 146m 的强光下会糊成一片白，
    // 换成中灰后才有"从白环梁上削出来一条深色跑道"的层次。
    this._matDeck = M({ color: 0x51606e, roughness: 0.9, metalness: 0.08 });
  }

  /** 高空轨道环：环梁 Torus + 踏步板 IM + 灯带 IM */
  _buildRing() {
    const ring = new THREE.Group();
    ring.name = 'Sky/ring';
    this.group.add(ring);

    const beamGeo = this._track(new THREE.TorusGeometry(SKY_RING.r, SKY_RING.tube, 5, 168));
    beamGeo.rotateX(-Math.PI / 2);
    const beam = new THREE.Mesh(beamGeo, this._matSteel);
    beam.name = 'Sky/ring-beam';
    beam.position.set(SKY_RING.cx, SKY_RING.y, SKY_RING.cz);
    ring.add(beam);

    // 踏步板：三排并行铺成 7m 宽的空中步道（84.5~91.5m 半径），
    // 既是环梁上的甲板，也是后面 deck 模式真正能走的落脚面。
    const plateRows = 3;
    const plateGeo = this._track(new THREE.BoxGeometry(4.05, 0.22, 2.98));
    const plates = new THREE.InstancedMesh(plateGeo, this._matDeck, 140 * plateRows);
    plates.name = 'Sky/ring-plates';
    plates.frustumCulled = false;
    let pi = 0;
    for (let row = 0; row < plateRows; row += 1) {
      const rr = SKY_RING.r + (row - 1) * 3.0;
      for (let i = 0; i < 140; i += 1) {
        const a = (i / 140) * Math.PI * 2;
        ringPoint(a, rr, _v1);
        _dummy.position.set(_v1.x, SKY_RING.y + 0.72, _v1.z);
        _dummy.rotation.set(0, a, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        plates.setMatrixAt(pi, _dummy.matrix);
        pi += 1;
      }
    }
    plates.instanceMatrix.needsUpdate = true;
    ring.add(plates);
    this._instanced.push(plates);

    // 内外护栏：两根细环梁 + 顶部扶手灯带，站上甲板有"高处"的边界感
    for (const [radius, mat] of [[DECK_IN + 0.2, this._matSteel], [DECK_OUT - 0.2, this._matSteel]]) {
      const railGeo = this._track(new THREE.TorusGeometry(radius, 0.11, 4, 168));
      railGeo.rotateX(-Math.PI / 2);
      const rail = new THREE.Mesh(railGeo, mat);
      rail.position.set(SKY_RING.cx, SKY_RING.y + 1.42, SKY_RING.cz);
      rail.name = 'Sky/ring-parapet';
      ring.add(rail);
      const stripGeo2 = this._track(new THREE.TorusGeometry(radius, 0.045, 4, 168));
      stripGeo2.rotateX(-Math.PI / 2);
      const strip2 = new THREE.Mesh(stripGeo2, this._matGlowCool);
      strip2.position.set(SKY_RING.cx, SKY_RING.y + 1.52, SKY_RING.cz);
      ring.add(strip2);
    }

    const stripGeo = this._track(new THREE.BoxGeometry(0.5, 0.1, 0.5));
    const strips = new THREE.InstancedMesh(stripGeo, this._matGlowCool, 140);
    strips.name = 'Sky/ring-lights';
    strips.frustumCulled = false;
    for (let i = 0; i < 140; i += 1) {
      const a = (i / 140) * Math.PI * 2;
      ringPoint(a, SKY_RING.r - 1.5, _v1);
      _dummy.position.set(_v1.x, SKY_RING.y + 0.86, _v1.z);
      _dummy.rotation.set(0, a, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      strips.setMatrixAt(i, _dummy.matrix);
    }
    strips.instanceMatrix.needsUpdate = true;
    ring.add(strips);
    this._instanced.push(strips);

    // 环上停靠站台（高铁下客点）+ 观景沿
    const dockPadGeo = this._track(new THREE.BoxGeometry(15, 0.5, 11));
    const dockPad = new THREE.Mesh(dockPadGeo, this._matHull);
    dockPad.name = 'Sky/dock-pad';
    dockPad.position.set(DOCK.x, SKY_RING.y + 0.88, DOCK.z);
    dockPad.rotation.y = DOCK.angle;
    ring.add(dockPad);

    const dockRailGeo = this._track(new THREE.BoxGeometry(15.4, 0.12, 0.2));
    for (let k = -1; k <= 1; k += 2) {
      const bar = new THREE.Mesh(dockRailGeo, this._matGlowCool);
      bar.position.set(DOCK.x, SKY_RING.y + 1.42, DOCK.z + k * 4.6 * Math.cos(DOCK.angle));
      bar.rotation.y = DOCK.angle;
      ring.add(bar);
    }
    this._dockPadY = SKY_RING.y + 1.13;
  }

  /** 太空电梯：基座 + 双导轨塔身 + 横肋 + 舱厢 + 顶端站台 */
  _buildElevator(baseY) {
    const g = new THREE.Group();
    g.name = 'Sky/elevator';
    this.group.add(g);

    const X = SKY_ELEVATOR.x;
    const Z = SKY_ELEVATOR.z;
    const topY = SKY_RING.y;
    const H = topY - baseY;

    const baseGeo = this._track(new THREE.CylinderGeometry(6.4, 7.2, 1.1, 24));
    const base = new THREE.Mesh(baseGeo, this._matDark);
    base.name = 'Sky/elevator-base';
    base.position.set(X, baseY + 0.55, Z);
    g.add(base);

    const padGeo = this._track(new THREE.CylinderGeometry(5.4, 5.4, 0.18, 24));
    const pad = new THREE.Mesh(padGeo, this._matHull);
    pad.position.set(X, baseY + 1.16, Z);
    g.add(pad);
    this._elevatorPadY = baseY + 1.16;

    // 双导轨（细长盒，代价极低；不做 lattice，避免 draw call 爆炸）
    const railGeoShaft = this._track(new THREE.BoxGeometry(0.55, H, 0.55));
    for (const [dx, dz] of [[-1.25, -1.25], [1.25, 1.25]]) {
      const shaft = new THREE.Mesh(railGeoShaft, this._matSteel);
      shaft.name = 'Sky/elevator-shaft';
      shaft.position.set(X + dx, baseY + H / 2, Z + dz);
      g.add(shaft);
    }

    // 横肋：每 12m 一圈
    const ribCount = Math.max(2, Math.floor(H / 12));
    const ribGeo = this._track(new THREE.BoxGeometry(3.6, 0.35, 3.6));
    const ribs = new THREE.InstancedMesh(ribGeo, this._matDark, ribCount);
    ribs.frustumCulled = false;
    for (let i = 0; i < ribCount; i += 1) {
      const y = baseY + 10 + i * (H - 10) / ribCount;
      _dummy.position.set(X, y, Z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      ribs.setMatrixAt(i, _dummy.matrix);
    }
    ribs.instanceMatrix.needsUpdate = true;
    g.add(ribs);
    this._instanced.push(ribs);

    // 顶端站台：贴在环下方，与环上踏步板齐平
    const topPadGeo = this._track(new THREE.CylinderGeometry(6.2, 6.2, 0.5, 20));
    const topPad = new THREE.Mesh(topPadGeo, this._matHull);
    topPad.name = 'Sky/elevator-top-pad';
    topPad.position.set(X, topY - 0.35, Z);
    g.add(topPad);
    this._elevatorTopY = topY - 0.6;

    // 栈桥：从顶端站台伸到环上，补上「电梯在环外」的那 6m 缺口
    const bridgeLen = (_elevR - SKY_RING.r) + 3.2;
    const ringEdgeX = SKY_RING.cx + _nx * SKY_RING.r;
    const ringEdgeZ = SKY_RING.cz + _nz * SKY_RING.r;
    const bridgeGeo = this._track(new THREE.BoxGeometry(bridgeLen, 0.42, 1.5));
    const bridge = new THREE.Mesh(bridgeGeo, this._matHull);
    bridge.name = 'Sky/elevator-bridge';
    bridge.position.set((X + ringEdgeX) / 2, topY - 0.42, (Z + ringEdgeZ) / 2);
    bridge.rotation.y = Math.atan2(-_nz, _nx);
    g.add(bridge);

    // 舱厢（跟随 _carY 的 Group，两片玻璃 + 底盘灯带）
    const car = new THREE.Group();
    car.name = 'Sky/elevator-car';
    const bodyGeo = this._track(new THREE.BoxGeometry(4.4, 3.4, 4.4));
    const body = new THREE.Mesh(bodyGeo, this._matHull);
    body.position.y = 1.7;
    car.add(body);
    const glassGeo = this._track(new THREE.BoxGeometry(4.46, 1.6, 4.46));
    const glass = new THREE.Mesh(glassGeo, this._matGlass);
    glass.position.y = 2.2;
    car.add(glass);
    const capGeo = this._track(new THREE.BoxGeometry(4.6, 0.4, 4.6));
    const cap = new THREE.Mesh(capGeo, this._matSteel);
    cap.position.y = 3.6;
    car.add(cap);
    const glowGeo = this._track(new THREE.BoxGeometry(4.5, 0.14, 4.5));
    const glow = new THREE.Mesh(glowGeo, this._matGlow);
    glow.position.y = 0.12;
    car.add(glow);
    g.add(car);
    this._car = car;
  }

  /** 太空高铁站台：悬浮导轨起点 + 站台板 + 顶棚 */
  _buildStation(stY) {
    const g = new THREE.Group();
    g.name = 'Sky/station';
    this.group.add(g);

    const slabGeo = this._track(new THREE.BoxGeometry(30, 0.6, 12));
    const slab = new THREE.Mesh(slabGeo, this._matHull);
    slab.name = 'Sky/station-slab';
    slab.position.set(SKY_STATION.x, stY + 0.5, SKY_STATION.z);
    g.add(slab);

    const edgeGeo = this._track(new THREE.BoxGeometry(30, 0.12, 0.3));
    for (let k = -1; k <= 1; k += 2) {
      const edge = new THREE.Mesh(edgeGeo, this._matGlow);
      edge.position.set(SKY_STATION.x, stY + 0.86, SKY_STATION.z + k * 5.6);
      g.add(edge);
    }

    const roofGeo = this._track(new THREE.BoxGeometry(30, 0.28, 12));
    const roof = new THREE.Mesh(roofGeo, this._matSteel);
    roof.name = 'Sky/station-roof';
    roof.position.set(SKY_STATION.x, stY + 8.2, SKY_STATION.z);
    g.add(roof);

    const pillarGeo = this._track(new THREE.BoxGeometry(0.5, 7.6, 0.5));
    const pillars = new THREE.InstancedMesh(pillarGeo, this._matDark, 6);
    pillars.frustumCulled = false;
    for (let i = 0; i < 6; i += 1) {
      const px = SKY_STATION.x - 12 + i * 4.8;
      const pz = SKY_STATION.z + (i < 3 ? -5.2 : 5.2);
      _dummy.position.set(px, stY + 4.2, pz);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      pillars.setMatrixAt(i, _dummy.matrix);
    }
    pillars.instanceMatrix.needsUpdate = true;
    g.add(pillars);
    this._instanced.push(pillars);

    this._stationRoofY = stY + 8.2;
  }

  /** 爬升导轨：一条 CatmullRom 曲线（地面站台 → 都会区上空的环上站台） */
  _buildRail(stY) {
    const pts = [
      new THREE.Vector3(SKY_STATION.x, stY + 3.2, SKY_STATION.z),
      new THREE.Vector3(-56, stY + 24, 12),
      new THREE.Vector3(-28, 62, 34),
      new THREE.Vector3(6, 100, 62),
      new THREE.Vector3(36, 128, 92),
      new THREE.Vector3(DOCK.x - Math.cos(DOCK.angle) * 8, SKY_RING.y + 0.2, DOCK.z + Math.sin(DOCK.angle) * 8),
    ];
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.28);
    this._curve = curve;
    this._railLen = curve.getLength();

    const tubeGeo = this._track(new THREE.TubeGeometry(curve, 190, 0.62, 6, false));
    const tube = new THREE.Mesh(tubeGeo, this._matSteel);
    tube.name = 'Sky/rail-tube';
    tube.frustumCulled = false;
    this.group.add(tube);

    // 枕木：沿曲线等距 120 段，用矩阵贴合切向
    const tieGeo = this._track(new THREE.BoxGeometry(4.6, 0.18, 1.1));
    const tieCount = 120;
    const ties = new THREE.InstancedMesh(tieGeo, this._matDark, tieCount);
    ties.frustumCulled = false;
    for (let i = 0; i < tieCount; i += 1) {
      const u = (i + 0.5) / tieCount;
      curve.getPointAt(u, _v1);
      curve.getTangentAt(u, _v2);
      _v3.copy(_UP).cross(_v2).normalize();       // 右
      _v4.copy(_v2).negate();                     // local +Z = 反向切向
      _m4.makeBasis(_v3, _UP, _v4);
      ties.setMatrixAt(i, _m4);
    }
    ties.instanceMatrix.needsUpdate = true;
    this.group.add(ties);
    this._instanced.push(ties);
  }

  /** 列车：4 节，车体 / 窗带 / 底盘灯三层各一个 InstancedMesh（共 3 draw call） */
  _buildTrain() {
    const CAR_COUNT = 4;
    const bodyGeo = this._track(new THREE.BoxGeometry(3.2, 2.7, 9.2));
    const bodies = new THREE.InstancedMesh(bodyGeo, this._matHull, CAR_COUNT);
    bodies.name = 'Sky/train-body';
    bodies.frustumCulled = false;
    this.group.add(bodies);
    this._instanced.push(bodies);

    const winGeo = this._track(new THREE.BoxGeometry(3.3, 1.15, 7.4));
    const wins = new THREE.InstancedMesh(winGeo, this._matGlass, CAR_COUNT);
    wins.name = 'Sky/train-window';
    wins.frustumCulled = false;
    this.group.add(wins);
    this._instanced.push(wins);

    const glowGeo = this._track(new THREE.BoxGeometry(3.3, 0.16, 9.2));
    const glows = new THREE.InstancedMesh(glowGeo, this._matGlowCool, CAR_COUNT);
    glows.name = 'Sky/train-glow';
    glows.frustumCulled = false;
    this.group.add(glows);
    this._instanced.push(glows);

    this._train = { bodies, wins, glows, count: CAR_COUNT, gap: 10.0 };
    this._trainProgress = 0;
  }

  /** 环上另两处小花园（后续加装置的锚点，也负责"空中花园"的观感） */
  _buildGardenPods() {
    const angles = [THREE.MathUtils.degToRad(140), THREE.MathUtils.degToRad(300)];
    const padGeo = this._track(new THREE.CylinderGeometry(5.4, 5.4, 0.4, 16));
    const boxGeo = this._track(new THREE.BoxGeometry(3.0, 1.0, 1.6));
    const leafGeo = this._track(new THREE.IcosahedronGeometry(1.35, 0));
    for (const a of angles) {
      ringPoint(a, SKY_RING.r, _v1);
      const pod = new THREE.Group();
      pod.name = 'Sky/garden-pod';
      pod.position.set(_v1.x, SKY_RING.y + 0.86, _v1.z);
      const pad = new THREE.Mesh(padGeo, this._matHull);
      pod.add(pad);
      for (let k = 0; k < 4; k += 1) {
        const ang = k * Math.PI / 2 + 0.4;
        const box = new THREE.Mesh(boxGeo, this._matPlanter);
        box.position.set(Math.cos(ang) * 3.2, 0.55, Math.sin(ang) * 3.2);
        box.rotation.y = -ang;
        pod.add(box);
        const leaf = new THREE.Mesh(leafGeo, this._matLeaf);
        leaf.position.set(Math.cos(ang) * 3.2, 2.0, Math.sin(ang) * 3.2);
        leaf.scale.set(1, 0.85, 1);
        pod.add(leaf);
      }
      this.group.add(pod);
    }
    this._podAngles = angles;
  }

  /**
   * 空中花园街区：站上环以后有东西可逛的一圈实景
   * - 电梯口的「云顶观景亭」（8 柱 + 穹顶 + 发光檐口）
   * - 140° 的玻璃温室（肋拱 + 内圈花坛 + 树冠）
   * - 40° 高铁到站口的喷泉广场（水池 / 长椅 / 灯柱）
   * - 205° / 320° 两座「空中墅」+ 300° 外悬玻璃观景台
   * 全部几何体复用 + InstancedMesh，新增绘制调用控制在 ~20 个以内。
   */
  _buildSkyDistrict() {
    const g = new THREE.Group();
    g.name = 'Sky/district';
    this.group.add(g);

    // 步道是 84.2~91.8m 的 7.6m 宽环形甲板。建筑统一挂在外带（r≈89~92）并缩到 0.78，
    // 内带 84.6~86.6 留成连续人行通道 —— 不然亭子 / 温室会把整条步道堵死，走不过去。
    const colliders = [];
    const addCollider = (x, z, r) => colliders.push({ x, z, r });
    const A = (deg) => (deg * Math.PI) / 180;
    const at = (a, r, y, out) => ringPoint(a, r, out).setY(y);
    const deckY = DECK_Y;

    /* ---- 通用小件 ---- */
    const colGeo = this._track(new THREE.CylinderGeometry(0.22, 0.26, 4.6, 10));
    const beamGeo = this._track(new THREE.BoxGeometry(0.26, 0.26, 4.2));
    const roofGeo = this._track(new THREE.ConeGeometry(5.6, 1.6, 8));
    const floorGeo = this._track(new THREE.CylinderGeometry(5.4, 5.2, 0.32, 16));
    const boxGeo = this._track(new THREE.BoxGeometry(4.2, 3.2, 3.0));
    const winGeo = this._track(new THREE.BoxGeometry(4.24, 1.5, 3.04));
    const treeTrunkGeo = this._track(new THREE.CylinderGeometry(0.16, 0.22, 1.6, 6));
    const treeLeafGeo = this._track(new THREE.IcosahedronGeometry(1.15, 1));
    const benchGeo = this._track(new THREE.BoxGeometry(1.9, 0.16, 0.62));
    const legGeo = this._track(new THREE.BoxGeometry(0.14, 0.5, 0.5));
    const poleGeo = this._track(new THREE.CylinderGeometry(0.08, 0.1, 3.0, 6));
    const lampGeo = this._track(new THREE.SphereGeometry(0.24, 8, 6));

    /* ---- ① 云顶观景亭（电梯口 250°）---- */
    {
      const a = A(250);
      const p = at(a, SKY_RING.r + 4.6, deckY + 0.16, _v1).clone();
      const pav = new THREE.Group();
      pav.name = 'Sky/pavilion';
      pav.position.copy(p);
      pav.rotation.y = a;
      pav.scale.setScalar(0.78);
      // 只挡 8 根柱子那圈（3.65m），人还能踩上亭子外沿的台面看景
      addCollider(p.x, p.z, 3.2);

      const floor = new THREE.Mesh(floorGeo, this._matHull);
      pav.add(floor);
      const rimGeo = this._track(new THREE.TorusGeometry(5.3, 0.12, 4, 32));
      rimGeo.rotateX(-Math.PI / 2);
      const rim = new THREE.Mesh(rimGeo, this._matGlowCool);
      rim.position.y = 0.2;
      pav.add(rim);

      for (let i = 0; i < 8; i += 1) {
        const ang = (i / 8) * Math.PI * 2;
        const col = new THREE.Mesh(colGeo, this._matSteel);
        col.position.set(Math.cos(ang) * 4.3, 2.4, Math.sin(ang) * 4.3);
        pav.add(col);
      }
      const roof = new THREE.Mesh(roofGeo, this._matHull);
      roof.position.y = 5.6;
      roof.rotation.y = 0.39;
      pav.add(roof);
      const crown = new THREE.Mesh(lampGeo, this._matGlow);
      crown.position.y = 6.6;
      crown.scale.setScalar(3.4);
      pav.add(crown);
      // 亭下的长椅
      for (let i = 0; i < 4; i += 1) {
        const ang = (i / 4) * Math.PI * 2 + 0.7;
        const bench = new THREE.Mesh(benchGeo, this._matPlanter);
        bench.position.set(Math.cos(ang) * 3.0, 0.45, Math.sin(ang) * 3.0);
        bench.rotation.y = -ang;
        pav.add(bench);
      }
      g.add(pav);
      this._pavilion = pav;
    }

    /* ---- ② 玻璃温室（140°）---- */
    {
      const a = A(140);
      const p = at(a, SKY_RING.r + 3.4, deckY + 0.16, _v1).clone();
      const gh = new THREE.Group();
      gh.name = 'Sky/greenhouse';
      gh.position.copy(p);
      gh.rotation.y = a;
      gh.scale.setScalar(0.78);
      addCollider(p.x, p.z, 3.9);

      const base = new THREE.Mesh(floorGeo, this._matPlanter);
      base.scale.set(0.92, 1, 0.92);
      gh.add(base);

      const domeGeo = this._track(new THREE.SphereGeometry(4.4, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2));
      const dome = new THREE.Mesh(domeGeo, this._matGlass);
      dome.position.y = 0.3;
      gh.add(dome);

      const ribGeo = this._track(new THREE.TorusGeometry(4.4, 0.06, 4, 20, Math.PI));
      for (let i = 0; i < 4; i += 1) {
        const rib = new THREE.Mesh(ribGeo, this._matSteel);
        rib.position.y = 0.3;
        rib.rotation.y = (i / 4) * Math.PI;
        gh.add(rib);
      }
      for (let i = 0; i < 7; i += 1) {
        const ang = (i / 7) * Math.PI * 2;
        const trunk = new THREE.Mesh(treeTrunkGeo, this._matPlanter);
        trunk.position.set(Math.cos(ang) * 2.2, 0.95, Math.sin(ang) * 2.2);
        gh.add(trunk);
        const leaf = new THREE.Mesh(treeLeafGeo, this._matLeaf);
        leaf.position.set(Math.cos(ang) * 2.2, 2.5, Math.sin(ang) * 2.2);
        leaf.scale.set(0.9, 1.15, 0.9);
        gh.add(leaf);
      }
      g.add(gh);
      this._greenhouse = gh;
    }

    /* ---- ③ 喷泉广场（40° 高铁到站口）---- */
    {
      const a = A(40);
      const p = at(a, SKY_RING.r + 3.2, deckY + 0.14, _v1).clone();
      const plaza = new THREE.Group();
      plaza.name = 'Sky/sky-plaza';
      plaza.position.copy(p);
      plaza.rotation.y = a;
      plaza.scale.setScalar(0.8);
      addCollider(p.x, p.z, 2.9);

      const basinGeo = this._track(new THREE.CylinderGeometry(3.4, 3.6, 0.55, 20));
      const basin = new THREE.Mesh(basinGeo, this._matHull);
      plaza.add(basin);
      const waterGeo = this._track(new THREE.CylinderGeometry(3.0, 3.0, 0.08, 20));
      const water = new THREE.Mesh(waterGeo, this._matGlowCool);
      water.position.y = 0.3;
      plaza.add(water);
      const jetGeo = this._track(new THREE.CylinderGeometry(0.09, 0.14, 2.4, 6));
      const jet = new THREE.Mesh(jetGeo, this._matGlowCool);
      jet.position.y = 1.5;
      plaza.add(jet);

      // 广场地标：一根 9m 玻璃方尖碑 + 悬浮光环。第一版的问题就是"上去什么都没有"，
      // 环上只有 1m 高的栏杆和矮树，平视出去整圈被天空吃掉；立一根竖向地标之后
      // 40m 外就能一眼认出"那边有东西"，也给了甲板一条清晰的指路标。
      const obeliskGeo = this._track(new THREE.CylinderGeometry(0.36, 0.95, 9.0, 4));
      const obelisk = new THREE.Mesh(obeliskGeo, this._matGlass);
      obelisk.position.y = 4.9;
      obelisk.rotation.y = 0.4;
      plaza.add(obelisk);
      const obeliskCore = new THREE.Mesh(this._track(new THREE.CylinderGeometry(0.12, 0.12, 8.2, 6)), this._matGlow);
      obeliskCore.position.y = 4.9;
      plaza.add(obeliskCore);
      const haloGeo = this._track(new THREE.TorusGeometry(2.1, 0.13, 6, 30));
      const halo = new THREE.Mesh(haloGeo, this._matGlowCool);
      halo.position.y = 10.2;
      halo.rotation.x = Math.PI / 2;
      plaza.add(halo);

      for (let i = 0; i < 6; i += 1) {
        const ang = (i / 6) * Math.PI * 2 + 0.5;
        const bench = new THREE.Mesh(benchGeo, this._matPlanter);
        bench.position.set(Math.cos(ang) * 5.6, 0.42, Math.sin(ang) * 5.6);
        bench.rotation.y = -ang + Math.PI / 2;
        plaza.add(bench);
        for (const s of [-0.7, 0.7]) {
          const leg = new THREE.Mesh(legGeo, this._matDark);
          leg.position.set(Math.cos(ang) * 5.6 + s * Math.sin(ang), 0.2, Math.sin(ang) * 5.6 + s * Math.cos(ang));
          leg.rotation.y = -ang + Math.PI / 2;
          plaza.add(leg);
        }
      }
      g.add(plaza);
      this._plaza = plaza;
    }

    /* ---- ④ 两座空中墅（205° / 320°）+ 外悬玻璃观景台（300°）---- */
    const villas = [{ a: 205, r: SKY_RING.r + 3.6 }, { a: 320, r: SKY_RING.r + 3.0 }];
    for (let vi = 0; vi < villas.length; vi += 1) {
      const { a: deg, r } = villas[vi];
      const a = A(deg);
      const p = at(a, r, deckY + 0.16, _v1).clone();
      const v = new THREE.Group();
      v.name = 'Sky/sky-villa';
      v.position.copy(p);
      v.rotation.y = a;
      v.scale.setScalar(0.78);
      addCollider(p.x, p.z, 4.3);

      const pad = new THREE.Mesh(floorGeo, this._matHull);
      pad.scale.set(1.05, 1, 1.05);
      v.add(pad);
      const body = new THREE.Mesh(boxGeo, this._matHull);
      body.position.y = 2.0;
      v.add(body);
      const win = new THREE.Mesh(winGeo, this._matGlass);
      win.position.y = 2.3;
      v.add(win);
      const capGeo = this._track(new THREE.BoxGeometry(4.6, 0.24, 3.4));
      const cap = new THREE.Mesh(capGeo, this._matDark);
      cap.position.y = 3.72;
      v.add(cap);
      const lamp = new THREE.Mesh(lampGeo, this._matGlow);
      lamp.position.set(0, 4.1, 0);
      lamp.scale.setScalar(1.6);
      v.add(lamp);
      // 支撑斜撑（把"空中"的重量感做出来）
      for (const s of [-1, 1]) {
        const strut = new THREE.Mesh(beamGeo, this._matSteel);
        strut.position.set(s * 1.5, 1.0, 0);
        strut.rotation.z = s * 0.28;
        v.add(strut);
      }
      g.add(v);
    }

    {
      const a = A(300);
      const p = at(a, SKY_RING.r + 5.2, deckY + 0.1, _v1).clone();
      const bal = new THREE.Group();
      bal.name = 'Sky/balcony';
      bal.position.copy(p);
      const slabGeo = this._track(new THREE.CylinderGeometry(5.2, 5.2, 0.28, 18));
      const slab = new THREE.Mesh(slabGeo, this._matHull);
      bal.add(slab);
      const railGeo2 = this._track(new THREE.TorusGeometry(5.0, 0.09, 4, 24));
      railGeo2.rotateX(-Math.PI / 2);
      const rail2 = new THREE.Mesh(railGeo2, this._matGlowCool);
      rail2.position.y = 1.0;
      bal.add(rail2);
      const glassGeo2 = this._track(new THREE.CylinderGeometry(5.0, 5.0, 0.9, 18, 1, true));
      const glass2 = new THREE.Mesh(glassGeo2, this._matGlass);
      glass2.position.y = 0.55;
      bal.add(glass2);
      g.add(bal);
      this._balcony = bal;
    }

    /* ---- ⑤ 灯柱 + 行道树（InstancedMesh，各 1 个 draw call）---- */
    const lampCount = 26;
    const poles = new THREE.InstancedMesh(poleGeo, this._matDark, lampCount);
    const lamps = new THREE.InstancedMesh(lampGeo, this._matGlow, lampCount);
    poles.name = 'Sky/deck-poles';
    lamps.name = 'Sky/deck-lamps';
    poles.frustumCulled = false;
    lamps.frustumCulled = false;
    for (let i = 0; i < lampCount; i += 1) {
      const a = (i / lampCount) * Math.PI * 2 + 0.12;
      const r = DECK_IN + 0.6;
      ringPoint(a, r, _v1);
      _dummy.position.set(_v1.x, deckY + 1.5, _v1.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      poles.setMatrixAt(i, _dummy.matrix);
      _dummy.position.set(_v1.x, deckY + 3.05, _v1.z);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      lamps.setMatrixAt(i, _dummy.matrix);
    }
    poles.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    g.add(poles, lamps);
    this._instanced.push(poles, lamps);
    this._deckLamps = lamps;

    const treeCount = 20;
    const trunks = new THREE.InstancedMesh(treeTrunkGeo, this._matPlanter, treeCount);
    const canopies = new THREE.InstancedMesh(treeLeafGeo, this._matLeaf, treeCount);
    trunks.name = 'Sky/deck-trunks';
    canopies.name = 'Sky/deck-trees';
    trunks.frustumCulled = false;
    canopies.frustumCulled = false;
    for (let i = 0; i < treeCount; i += 1) {
      const a = (i / treeCount) * Math.PI * 2 + 0.5;
      // 避开四个功能区（亭 / 温室 / 广场 / 别墅）的正面
      const blocked = Math.min(
        Math.abs(angDiff(a, A(250))), Math.abs(angDiff(a, A(140))),
        Math.abs(angDiff(a, A(40))), Math.abs(angDiff(a, A(300))),
      ) < 0.16;
      const sc = blocked ? 0 : 1;
      const r = DECK_IN + 0.9;
      ringPoint(a, r, _v1);
      _dummy.position.set(_v1.x, deckY + 1.15, _v1.z);
      _dummy.rotation.set(0, a, 0);
      _dummy.scale.set(sc, 1.45 * sc, sc);
      _dummy.updateMatrix();
      trunks.setMatrixAt(i, _dummy.matrix);
      _dummy.position.set(_v1.x, deckY + 3.15, _v1.z);
      _dummy.scale.set(0.86 * sc, 0.94 * sc, 0.86 * sc);
      _dummy.updateMatrix();
      canopies.setMatrixAt(i, _dummy.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    g.add(trunks, canopies);
    this._instanced.push(trunks, canopies);

    /* ---- ⑥ 沿路长凳（InstancedMesh）----
     * 五个功能区之间的空档最"空"，用一排面向环内的长凳把视线接起来；
     * 洞口的正右侧跳过，免得和亭子 / 别墅的座椅撞在一起。 */
    const seatCount = 14;
    const seatGeo = this._track(new THREE.BoxGeometry(1.9, 0.42, 0.66));
    const seats = new THREE.InstancedMesh(seatGeo, this._matPlanter, seatCount);
    seats.name = 'Sky/deck-benches';
    seats.frustumCulled = false;
    for (let i = 0; i < seatCount; i += 1) {
      const a = (i / seatCount) * Math.PI * 2 + 0.9;
      const near = Math.min(
        Math.abs(angDiff(a, A(250))), Math.abs(angDiff(a, A(140))),
        Math.abs(angDiff(a, A(40))), Math.abs(angDiff(a, A(205))), Math.abs(angDiff(a, A(320))),
      ) < 0.1;
      const sc = near ? 0 : 1;
      const r = DECK_OUT - 1.7;
      ringPoint(a, r, _v1);
      _dummy.position.set(_v1.x, deckY + 0.21, _v1.z);
      _dummy.rotation.set(0, a, 0);
      _dummy.scale.set(sc, sc, sc);
      _dummy.updateMatrix();
      seats.setMatrixAt(i, _dummy.matrix);
    }
    seats.instanceMatrix.needsUpdate = true;
    g.add(seats);
    this._instanced.push(seats);

    /* ---- ⑦ 四座「云灯塔」----
     * 甲板往外悬 5m 立四根 22m 高的细塔，塔顶一盏大灯。
     * 站在环上任意位置，抬头就有竖直的参考物，远处也能看出"这儿有座城"，
     * 而不是一条平铺的白带子。两个 InstancedMesh，2 个 draw call。 */
    const towerAngles = [95, 170, 235, 345];
    const shaftGeo = this._track(new THREE.CylinderGeometry(0.3, 1.15, 26, 8));
    const capGeo2 = this._track(new THREE.OctahedronGeometry(0.55, 0));
    const baseGeo2 = this._track(new THREE.CylinderGeometry(2.4, 2.8, 0.5, 10));
    const shafts = new THREE.InstancedMesh(shaftGeo, this._matSteel, towerAngles.length);
    const caps = new THREE.InstancedMesh(capGeo2, this._matGlow, towerAngles.length);
    const bases = new THREE.InstancedMesh(baseGeo2, this._matDark, towerAngles.length);
    shafts.name = 'Sky/sky-tower-shafts';
    caps.name = 'Sky/sky-tower-caps';
    bases.name = 'Sky/sky-tower-bases';
    for (const key of [shafts, caps, bases]) key.frustumCulled = false;
    towerAngles.forEach((deg, i) => {
      const a = A(deg);
      const r = DECK_OUT - 1.7;
      ringPoint(a, r, _v1);
      addCollider(_v1.x, _v1.z, 1.7);
      _dummy.rotation.set(0, a, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.position.set(_v1.x, deckY + 13.0, _v1.z);
      _dummy.updateMatrix();
      shafts.setMatrixAt(i, _dummy.matrix);
      _dummy.position.set(_v1.x, deckY + 26.6, _v1.z);
      _dummy.rotation.set(0, a, 0.4);
      _dummy.updateMatrix();
      caps.setMatrixAt(i, _dummy.matrix);
      _dummy.position.set(_v1.x, deckY + 0.25, _v1.z);
      _dummy.rotation.set(0, a, 0);
      _dummy.updateMatrix();
      bases.setMatrixAt(i, _dummy.matrix);
    });
    shafts.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    bases.instanceMatrix.needsUpdate = true;
    g.add(shafts, caps, bases);
    this._instanced.push(shafts, caps, bases);

    this._district = g;
    this._colliders = colliders;
  }

  /* ======================================================================== */
  /* 运动                                                                     */
  /* ======================================================================== */

  _updateElevatorCar(dt) {
    if (!this._car) return;
    const y0 = this._elevatorPadY + 1.4;
    const y1 = this._elevatorTopY - 1.0;
    const k = smoothstep(this._elevT);
    this._carY = y0 + (y1 - y0) * k;
    this._car.position.set(SKY_ELEVATOR.x, this._carY, SKY_ELEVATOR.z);
    void dt;
  }

  _updateTrain(dt) {
    if (!this._train || !this._curve) return;
    const { bodies, wins, glows, count, gap } = this._train;
    const len = this._railLen;
    const uGap = gap / len;
    const t = this._trainT;
    for (let i = 0; i < count; i += 1) {
      const u = Math.min(1, Math.max(0, t - i * uGap));
      this._curve.getPointAt(u, this._trainPos[i]);
      this._curve.getTangentAt(u, this._trainTan[i]);
      const p = this._trainPos[i];
      const f = this._trainTan[i];
      _v3.copy(_UP).cross(f).normalize();   // 右
      _v4.copy(f).negate();                 // local +Z 朝后 → -Z 朝行进方向
      _m4.makeBasis(_v3, _UP, _v4);
      _m4.setPosition(p.x, p.y + 1.75, p.z);
      bodies.setMatrixAt(i, _m4);

      // 车窗带 / 底盘灯带只需平移，不参与姿态，避免二次旋转造成错位
      _m4.setPosition(p.x, p.y + 2.25, p.z);
      wins.setMatrixAt(i, _m4);
      _m4.setPosition(p.x, p.y + 0.62, p.z);
      glows.setMatrixAt(i, _m4);
    }
    bodies.instanceMatrix.needsUpdate = true;
    wins.instanceMatrix.needsUpdate = true;
    glows.instanceMatrix.needsUpdate = true;
    void dt;
  }

  /* ======================================================================== */
  /* 交互                                                                     */
  /* ======================================================================== */

  /** 相机到电梯基座 / 站台板中心的最近距离，决定 E 该给谁 */
  _pickNear() {
    const cam = this.camera;
    if (!cam) return null;
    let p = cam.position;
    // 外部扫描点（轨道模式下的视线落点）可能取不到，取不到就退回相机位置，
    // 绝不能因为一个回调抛错把整帧 update 打断（否则 E 提示一辈子不刷新）。
    if (this.getScanPoint) {
      try {
        const sp = this.getScanPoint();
        if (sp && typeof sp.x === 'number') p = sp;
      } catch (e) { /* 忽略，用相机位置兜底 */ }
    }
    const q = cam.position;
    // 两个点都算命中：视线落点够近（轨道俯瞰）或双脚够近（第一人称）都算站在门口
    const dElev = Math.min(
      Math.hypot(p.x - SKY_ELEVATOR.x, p.z - SKY_ELEVATOR.z),
      Math.hypot(q.x - SKY_ELEVATOR.x, q.z - SKY_ELEVATOR.z),
    );
    const dStation = Math.min(
      Math.hypot(p.x - SKY_STATION.x, p.z - SKY_STATION.z),
      Math.hypot(q.x - SKY_STATION.x, q.z - SKY_STATION.z),
    );
    if (dElev <= NEAR_ELEV && dElev <= dStation) return 'elevator';
    if (dStation <= NEAR_STATION) return 'station';
    return null;
  }

  /**
   * E 键入口：返回 true 表示这次 E 属于空中花园，lobby 不要再看设施 / 别墅。
   * 优先级：正在运行 > 到站 > 登乘。
   */
  handleInteract() {
    if (this._disposed) return false;
    // 入场 / 回地面的机位插值期间不接受新指令，避免半路抢状态；
    // 但「正在落回地面」时按 E 不该被吞掉（玩家想立刻再乘一程），先瞬时落地再判定。
    if (this._introT >= 0) {
      if (this._introTo === 'ground') this._finishIntro();
      else return this.isRiding;
    }
    switch (this._mode) {
      case 'elev-up':
      case 'train-up':
        this.toast('正在上升 · 到站后按 E 返回地面');
        return true;
      case 'elev-down':
      case 'train-down':
        this.toast('正在下降 · 稍等');
        return true;
      case 'elev-top':
        if (this._walked === 'elevator') this._startElevator('down');
        else this._startDeck('elevator');
        return true;
      case 'train-docked':
        if (this._walked === 'train') this._startTrain('down');
        else this._startDeck('train');
        return true;
      case 'deck':
        this._leaveDeck();
        return true;
      case 'train-boarded':
        this._startTrain('up');
        return true;
      default:
        break;
    }
    const near = this._pickNear();
    if (near === 'elevator') { this._startElevator('up'); return true; }
    if (near === 'station') { this._startTrain('board'); return true; }
    return false;
  }

  /* ---- 电梯 ---- */
  _startElevator(dir) {
    if (!this._saved) { this._savePose(); this._captureIntroFrom(); }
    if (dir === 'up') { this._look.yaw = 0; this._look.pitch = 0; this._look.zoom = 1; this._walked = null; }
    this._introT = 0;
    this._introTo = 'ride';
    this._elevT = dir === 'up' ? 0 : 1;
    this._rideT = 0;
    this._rideDur = ELEV_TRAVEL;
    this._mode = dir === 'up' ? 'elev-up' : 'elev-down';
    this.toast(dir === 'up'
      ? '太空电梯启动 · 上行 142m，全程可看公园与全城'
      : '太空电梯返回地面');
  }

  /* ---- 高铁 ---- */
  _startTrain(phase) {
    if (phase === 'board') {
      if (!this._saved) { this._savePose(); this._captureIntroFrom(); }
      this._look.yaw = 0; this._look.pitch = 0; this._look.zoom = 1;
      this._walked = null;
      this._trainT = 0;
      this._introT = 0;
      this._introTo = 'ride';
      this._mode = 'train-boarded';
      this.toast('已登上太空高铁 · 点击「发车」或按 E 出发');
      return;
    }
    if (phase === 'up') {
      this._trainT = 0;
      this._rideT = 0;
      this._rideDur = Math.max(16, this._railLen / TRAIN_SPEED);
      this._mode = 'train-up';
      this.toast('发车 · 列车开始爬升，穿云而上');
      return;
    }
    // down：从环上站台返程
    this._trainT = 1;
    this._rideT = 0;
    this._rideDur = Math.max(16, this._railLen / TRAIN_SPEED);
    this._mode = 'train-down';
    this.toast('返程 · 正在下降回地面站台');
  }

  /** 大地图重建 / 离开大厅时：立刻落回地面，别把 146m 的机位写进大厅存档 */
  abortToGround() {
    if (!this._saved) return;
    this._mode = 'idle';
    this._introT = -1;
    this._deck.keys.clear();
    this._look.yaw = 0; this._look.pitch = 0; this._look.zoom = 1;
    this._look.drag = false;
    if (this.camera) {
      this.camera.position.copy(this._saved.position);
      this.camera.quaternion.copy(this._saved.quaternion);
      this.camera.fov = this._saved.fov;
      this.camera.updateProjectionMatrix();
    }
    this._restoreAtmosphere();
    this._saved = null;
  }

  /* ======================================================================== */
  /* 每帧                                                                     */
  /* ======================================================================== */

  update(dt) {
    if (this._disposed) return;
    const cam = this.camera;
    if (!cam) return;
    this._time += dt;

    const night = this.getNight();
    this._matGlow.emissiveIntensity = 0.85 + night * 2.4;
    this._matGlowCool.emissiveIntensity = 0.8 + night * 2.2;

    if (this._mode === 'idle') this._near = this._pickNear();
    else this._near = null;

    this._stepRide(dt);
    this._updateElevatorCar(dt);
    this._updateTrain(dt);

    if (this._introT >= 0) this._introCamera(dt);
    else if (this._mode === 'deck') this._updateDeck(dt);
    else if (this.isRiding) this._rideCamera();

    this._applyAtmosphere(cam, dt);
    this._refreshHud();
  }

  /** 状态机推进 */
  _stepRide(dt) {
    if (!this.isRiding) return;
    if (this._mode === 'deck') return;    // 步道漫步时不推进骑乘进度

    if (this._mode === 'elev-up' || this._mode === 'elev-down') {
      this._rideT += dt;
      const raw = Math.min(1, this._rideT / this._rideDur);
      this._elevT = this._mode === 'elev-up' ? raw : 1 - raw;
      if (raw >= 1) {
        if (this._mode === 'elev-up') {
          this._mode = 'elev-top';
          this.toast('已抵达空中花园 · 按 E 出舱漫步（WASD 行走 / 拖鼠标环视）');
        } else {
          this._mode = 'idle';
          this._beginGroundIntro();
        }
      }
      return;
    }

    if (this._mode === 'train-up' || this._mode === 'train-down') {
      this._rideT += dt;
      const raw = Math.min(1, this._rideT / this._rideDur);
      const k = smoothstep(raw);
      this._trainT = this._mode === 'train-up' ? k : 1 - k;
      if (raw >= 1) {
        if (this._mode === 'train-up') {
          this._mode = 'train-docked';
          this.toast('已抵达空中站台 · 按 E 出舱漫步（WASD 行走 / 拖鼠标环视）');
        } else {
          this._mode = 'idle';
          this._beginGroundIntro();
        }
      }
      return;
    }

    // 站台静止态：列车位置固定在站台 / 环上站台
    if (this._mode === 'train-boarded' || this._mode === 'train-docked') {
      this._trainT = this._mode === 'train-boarded' ? 0 : 1;
    }
  }

  /* ---- 相机 ---- */

  _savePose() {
    const cam = this.camera;
    this._saved = {
      position: cam.position.clone(),
      quaternion: cam.quaternion.clone(),
      fov: cam.fov,
    };
  }

  /** 记录「当前相机姿态」作为进出场的插值起点 */
  _captureIntroFrom() {
    const cam = this.camera;
    this._introFrom.position.copy(cam.position);
    this._introFrom.quaternion.copy(cam.quaternion);
    this._introFrom.fov = cam.fov;
  }

  _beginGroundIntro() {
    this._captureIntroFrom();
    this._introT = 0;
    this._introTo = 'ground';
    this._introDur = 0.55;
  }

  /** 立刻结束「落回地面」插值：相机、雾、天穹回到登乘前的状态。
   *  玩家在落地缓动里按 E 时用来跳过这 0.55s，避免按键被吞。 */
  _finishIntro() {
    this._introT = -1;
    this._look.yaw = 0; this._look.pitch = 0; this._look.zoom = 1;
    this._look.drag = false;
    if (this._introTo !== 'ground' || !this._saved || !this.camera) return;
    const cam = this.camera;
    cam.position.copy(this._saved.position);
    cam.quaternion.copy(this._saved.quaternion);
    if (Math.abs(cam.fov - this._saved.fov) > 1e-3) {
      cam.fov = this._saved.fov;
      cam.updateProjectionMatrix();
    }
    this._restoreAtmosphere();
    this._saved = null;
  }

  /** 位置 + 朝向目标（lookAt）→ 走 CameraRig 受控直写，失败时兜底直写 */
  _writeCamera(pos, look, fov) {
    const cam = this.camera;
    const owner = cameraRig.owner;
    const ok = owner ? cameraRig.writePose({ position: pos, lookAt: look, fov, owner }) : false;
    if (!ok) {
      cam.position.copy(pos);
      cam.lookAt(look);
      if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    }
    return ok;
  }

  /** 位置 + 四元数（插值回地面时用，避免 lookAt 与目标四元数打架） */
  _writeCameraQuat(pos, quat, fov) {
    const cam = this.camera;
    const owner = cameraRig.owner;
    const ok = owner ? cameraRig.writePose({ position: pos, quaternion: quat, fov, owner }) : false;
    if (!ok) {
      cam.position.copy(pos);
      cam.quaternion.copy(quat);
      if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    }
    return ok;
  }

  /** 计算当前应处的骑乘机位到 _camPos / _camLook（不写相机，供插值复用） */
  _computeRideCamera() {
    if (this._mode === 'deck') { this._computeDeckCamera(); return; }
    if (this._mode.startsWith('elev')) {
      const y = this._carY;
      const t = this._elevT;                       // 0 → 地面, 1 → 146m 站台
      const k = smoothstep((t - 0.45) / 0.55);     // 后半程逐渐切到"看甲板"的构图
      const out = 4.6 + 1.6 * k;                   // 挂在舱体外，不贴脸
      this._camPos.set(SKY_ELEVATOR.x + _nx * out, y + 6.2 - 1.2 * k, SKY_ELEVATOR.z + _nz * out);
      const parkX = SKY_RING.cx;
      const parkZ = SKY_RING.cz * 0.55;
      const parkLookY = Math.max(6, y * 0.56 + 6);
      // 后半程：机位压到"马上要站上去的甲板"上，朝环的切向看，
      // 一进舱就能看到步道、灯柱、长椅一路铺过去；按 E 下舱时也几乎无缝。
      const elevA = Math.atan2(SKY_ELEVATOR.x - SKY_RING.cx, SKY_ELEVATOR.z - SKY_RING.cz);
      ringPoint(elevA, 87.6, _v1);
      _v1.y = DECK_Y + 1.9;
      this._camPos.lerp(_v1, k);
      ringPoint(elevA - 0.42, 90, _v4);
      _v4.y = DECK_Y + 2.6;
      this._camLook.set(
        parkX + (_v4.x - parkX) * k,
        parkLookY + (_v4.y - parkLookY) * k,
        parkZ + (_v4.z - parkZ) * k,
      );
      return;
    }
    const p = this._trainPos[0];
    const f = this._trainTan[0];
    if (this._mode === 'train-docked') {
      // 到站：镜头偏向环的切向，展示「空中轨道一直延伸出去」
      ringTangent(DOCK.angle, _v3);
      // 抬到 14m、退到 26m 外：既有"列车停在站台、轨道继续延伸"的交代，
      // 又不会让车顶和近处树冠糊满画面（第一版那张构图就是这么废掉的）。
      this._camPos.copy(p).addScaledVector(_v3, -26);
      this._camPos.y += 14;
      this._camLook.copy(p).addScaledVector(_v3, 40);
      this._camLook.y += 1;
      return;
    }
    this._camPos.copy(p).addScaledVector(f, -13.5);
    this._camPos.y += 5.6;
    this._camLook.copy(p).addScaledVector(f, 10);
    this._camLook.y += 1.4;
  }

  /** 基础朝向（lookAt）+ 鼠标视角偏转（相机局部空间叠加）→ 目标四元数
   *  右乘偏移量 = 绕相机自身轴旋转，正是 FPS/自由视角的手感，不会因为
   *  目标点位置变化而放大或缩小转动的幅度。 */
  _composeLook(pos, target, yaw, pitch, out) {
    _m4.lookAt(pos, target, _UP);
    out.setFromRotationMatrix(_m4);
    if (yaw || pitch) {
      _eul.set(pitch, yaw, 0);
      _q3.setFromEuler(_eul);
      out.multiply(_q3);
    }
    return out;
  }

  _rideCamera() {
    this._computeRideCamera();
    const base = this._mode === 'train-docked' ? 66 : RIDE_FOV;
    const fov = base * this._look.zoom;
    this._composeLook(this._camPos, this._camLook, this._look.yaw, this._look.pitch, _q1);
    this._writeCameraQuat(this._camPos, _q1, fov);
  }

  _introCamera(dt) {
    const cam = this.camera;
    this._introT = Math.min(1, this._introT + dt / this._introDur);
    const k = smoothstep(this._introT);

    if (this._introTo === 'ride') {
      // 目标：骑乘机位；起点：登乘前的姿态。位置 lerp + 四元数 slerp，两端速度为 0
      this._computeRideCamera();
      const fov = (this._mode === 'train-docked' ? 66 : RIDE_FOV) * this._look.zoom;
      cam.position.lerpVectors(this._introFrom.position, this._camPos, k);
      // 用 lookAt 目标构造目标四元数（含鼠标偏转），再与起点四元数插值
      _v4.copy(this._camLook);
      this._composeLook(this._camPos, _v4, this._look.yaw, this._look.pitch, _q2);
      cam.quaternion.slerpQuaternions(this._introFrom.quaternion, _q2, k);
      const f = this._introFrom.fov + (fov - this._introFrom.fov) * k;
      _v1.copy(cam.position);
      this._writeCameraQuat(_v1, cam.quaternion, f);
      if (this._introT >= 1) this._introT = -1;
      return;
    }

    // 回到地面：插值回保存姿态，结束后交还 Orbit / WASD
    if (!this._saved) { this._introT = -1; return; }
    _v1.lerpVectors(this._introFrom.position, this._saved.position, k);
    _q1.slerpQuaternions(this._introFrom.quaternion, this._saved.quaternion, k);
    const f = this._introFrom.fov + (this._saved.fov - this._introFrom.fov) * k;
    this._writeCameraQuat(_v1, _q1, f);
    if (this._introT >= 1) {
      this._introT = -1;
      this._saved = null;
      this._look.yaw = 0; this._look.pitch = 0; this._look.zoom = 1;
      this._look.drag = false;
      this._restoreAtmosphere();
      this.toast('已回到地面 · 可继续逛园区');
    }
  }

  /* ---- 空中步道：自由行走 + 自由视角 ---- */

  /** 甲板机位（不含鼠标偏转）：位置 = 走位 + 眼高 */
  _computeDeckCamera() {
    this._camPos.set(this._deckWalk.x, DECK_Y + DECK_EYE, this._deckWalk.z);
    const cp = Math.cos(this._look.pitch);
    _v3.set(
      -Math.sin(this._look.yaw) * cp,
      Math.sin(this._look.pitch),
      -Math.cos(this._look.yaw) * cp,
    ).multiplyScalar(10);
    this._camLook.copy(this._camPos).add(_v3);
  }

  _startDeck(from) {
    if (this._deck.from === null) this._deck.from = from || 'elevator';
    else if (from) this._deck.from = from;
    const ang = this._deck.from === 'train'
      ? DOCK.angle
      : Math.atan2(SKY_ELEVATOR.x - SKY_RING.cx, SKY_ELEVATOR.z - SKY_RING.cz);
    this._deck.angle = ang;
    this._deck.r = SKY_RING.r - 0.4;
    ringPoint(ang, this._deck.r, _v1);
    this._deckWalk.x = _v1.x;
    this._deckWalk.z = _v1.z;
    // 初始朝向：沿轨道走向，一眼就能看到步道一直延伸出去
    this._look.yaw = Math.atan2(-Math.cos(ang), Math.sin(ang));
    this._look.pitch = -0.04;
    this._deck.keys.clear();
    this._mode = 'deck';
    this._hudDirty = true;
    this._captureIntroFrom();
    this._introT = 0;
    this._introTo = 'ride';
    this._introDur = 0.45;
    this.toast('已站上空中步道 · WASD 行走 / 拖鼠标环视，按 E 回舱');
  }

  _leaveDeck() {
    const from = this._deck.from || 'elevator';
    this._deck.keys.clear();
    this._mode = from === 'train' ? 'train-docked' : 'elev-top';
    this._walked = from;
    this._hudDirty = true;
    this._captureIntroFrom();
    this._introT = 0;
    this._introTo = 'ride';
    this._introDur = 0.4;
    this.toast(from === 'train' ? '已回到车厢 · 按 E 返程' : '已回到电梯舱 · 按 E 下到地面');
  }

  /** 把走位夹在步道带宽内（半径 84.6~91.4），角度允许无限绕行 */
  _constrainDeck(x, z) {
    // 建筑占外带：先把人从建筑圆里推出来，再夹半径，免得推进来看见「人在亭子里」
    const cols = this._colliders;
    if (cols && cols.length) {
      for (let i = 0; i < cols.length; i += 1) {
        const c = cols[i];
        const dx = x - c.x;
        const dz = z - c.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const need = c.r + 0.45;
        if (d < need) {
          let ux;
          let uz;
          if (d > 1e-4) { ux = dx / d; uz = dz / d; }
          else {
            // 正好站在建筑中心：往环内推，保证一定能出来
            const bx = SKY_RING.cx - c.x;
            const bz = SKY_RING.cz - c.z;
            const bl = Math.sqrt(bx * bx + bz * bz) || 1;
            ux = bx / bl;
            uz = bz / bl;
          }
          x = c.x + ux * need;
          z = c.z + uz * need;
        }
      }
    }
    const dx = x - SKY_RING.cx;
    const dz = z - SKY_RING.cz;
    let r = Math.sqrt(dx * dx + dz * dz);
    if (r < 1e-3) { this._deckWalk.x = SKY_RING.cx; this._deckWalk.z = SKY_RING.cz + SKY_RING.r; return; }
    const rc = Math.min(DECK_OUT - 0.4, Math.max(DECK_IN + 0.4, r));
    this._deckWalk.x = SKY_RING.cx + (dx / r) * rc;
    this._deckWalk.z = SKY_RING.cz + (dz / r) * rc;
    this._deck.r = rc;
    this._deck.angle = Math.atan2(dx, dz);
  }

  _updateDeck(dt) {
    const keys = this._deck.keys;
    let fwd = 0;
    let side = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) side += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) side -= 1;
    if (fwd || side) {
      const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
      const spd = (sprint ? WALK_SPRINT : WALK_SPEED) * Math.min(dt, 0.1);
      const norm = fwd && side ? 0.7071 : 1;
      const yaw = this._look.yaw;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      this._constrainDeck(
        this._deckWalk.x + (fx * fwd + rx * side) * spd * norm,
        this._deckWalk.z + (fz * fwd + rz * side) * spd * norm,
      );
    } else {
      // 只为让 status 的 angle/r 跟上（比如刚进来还没按键盘）
      this._constrainDeck(this._deckWalk.x, this._deckWalk.z);
    }
    this._computeDeckCamera();
    _eul.set(this._look.pitch, this._look.yaw, 0);
    _q1.setFromEuler(_eul);
    this._writeCameraQuat(this._camPos, _q1, DECK_FOV * this._look.zoom);
  }

  /* ---- 鼠标自由视角 / 甲板键盘 ---- */

  _bindPointerLook() {
    if (typeof window === 'undefined') return;
    this._onLookDown = (e) => {
      if (!this._canFreeLook()) return;
      if (e.target && e.target.closest && e.target.closest('.sky-hud')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this._look.drag = true;
      this._look.lx = e.clientX;
      this._look.ly = e.clientY;
    };
    this._onLookMove = (e) => {
      if (!this._look.drag || !this._canFreeLook()) return;
      const dx = e.clientX - this._look.lx;
      const dy = e.clientY - this._look.ly;
      this._look.lx = e.clientX;
      this._look.ly = e.clientY;
      const mul = this._look.zoom < 1 ? 1 / this._look.zoom : 1;   // 拉近时降灵敏度
      this._look.yaw -= dx * LOOK_SENS * mul;
      this._look.pitch -= dy * LOOK_SENS * mul;
      this._look.pitch = Math.max(-1.05, Math.min(1.15, this._look.pitch));
    };
    this._onLookUp = () => { this._look.drag = false; };
    this._onLookWheel = (e) => {
      if (!this._canFreeLook()) return;
      this._look.zoom = Math.max(0.72, Math.min(1.8, this._look.zoom + (e.deltaY > 0 ? 0.06 : -0.06)));
    };
    window.addEventListener('pointerdown', this._onLookDown, true);
    window.addEventListener('pointermove', this._onLookMove, true);
    window.addEventListener('pointerup', this._onLookUp, true);
    window.addEventListener('pointercancel', this._onLookUp, true);
    window.addEventListener('wheel', this._onLookWheel, { passive: true });
  }

  _bindDeckKeys() {
    if (typeof window === 'undefined') return;
    this._deckKeySet = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
    this._onDeckKeyDown = (e) => {
      if (this._mode !== 'deck' || !this._deckKeySet.has(e.code)) return;
      this._deck.keys.add(e.code);
      if (e.code.startsWith('Arrow')) e.preventDefault();
    };
    this._onDeckKeyUp = (e) => {
      if (this._deckKeySet && this._deckKeySet.has(e.code)) this._deck.keys.delete(e.code);
    };
    this._onDeckBlur = () => { this._deck.keys.clear(); this._look.drag = false; };
    window.addEventListener('keydown', this._onDeckKeyDown);
    window.addEventListener('keyup', this._onDeckKeyUp);
    window.addEventListener('blur', this._onDeckBlur);
  }

  _canFreeLook() {
    return this._mode !== 'idle';
  }

  /* ---- 大气：高空改雾 + 天穹跟随 ---- */

  _applyAtmosphere(cam, dt = 0.016) {
    const alt = cam.position.y;
    const high = smoothstep((alt - 20) / 90);   // 20m 起变化，110m 拉满
    // 高空整段关雾：地面那层灰雾被抬到 146m 后，40m 外就糊成一片白墙，
    // 环上的亭子 / 温室 / 广场全被吃掉（把 near 推到 240 也没用，糊白来自雾
    // 本身，只有 fog=null 才干净）。切雾只做一次，避免每帧重复编译材质。
    if (this._sceneFog) {
      if (high > 0.9) {
        if (!this._fogOff) { this.scene.fog = null; this._fogOff = true; }
      } else if (this._fogOff) {
        this._fogOff = false;
        this.scene.fog = this._sceneFog;
        this.scene.fog.near = this._baseFog.near;
        this.scene.fog.far = this._baseFog.far;
        if (this._baseFog.color && this.scene.fog.color) this.scene.fog.color.copy(this._baseFog.color);
      }
    }
    const fog = this.scene?.fog;
    if (fog) {
      const goalNear = this._baseFog.near + (235 - this._baseFog.near) * high;
      const goalFar = this._baseFog.far + (680 - this._baseFog.far) * high;
      // 指数平滑 + 按 dt 归一：低帧率（headless 1~4fps）时也能在半秒内收敛，
      // 不会出现「已经回到地面、雾还糊在 500m 外」的残留。
      const k = 1 - Math.exp(-8 * Math.max(0.001, Math.min(dt, 0.1)));
      fog.near += (goalNear - fog.near) * k;
      fog.far += (goalFar - fog.far) * k;
      if (fog.color && this._baseFog.color) {
        fog.color.copy(this._baseFog.color).lerp(_HAZE, high);
      }
    }

    // 天穹是 scale 150 的盒子，必须跟着相机一起升，否则相机会穿到盒子外面
    if (this._sky) {
      this._sky.position.y = Math.max(0, cam.position.y - 6);
      // 【高空奶白墙】Sky.js 是纯「视线方向」散射，抬到 146m 后整个半球被过曝成
      // 一片奶白（实测隐藏它、只留纯色背景，画面立刻通透、环上建筑全看得见）。
      // 高空收起天穹，落地时按原状态复原；背景色由昼夜系统每帧接管，不动它。
      const domeOff = high > 0.9;
      if (domeOff && this._skyUp !== true) {
        this._skyUp = true;
        this._skyVisibleBefore = this._sky.visible;
        this._sky.visible = false;
      } else if (!domeOff && this._skyUp === true) {
        this._skyUp = false;
        this._sky.visible = this._skyVisibleBefore;
      }
    }

    // 云层在 58~100m。升到 118m 以上就把云收起来，否则从甲板往下看全是白云，
    // 整座城市被盖住 —— 这正是上一版「上去什么都没有」的主要观感来源。
    const cloudOn = alt < 118;
    if (cloudOn !== this._cloudsOn) {
      this._cloudsOn = cloudOn;
      if (this._cloudNodes) for (const c of this._cloudNodes) c.node.visible = cloudOn && c.visible;
      if (this._clouds) this._clouds.visible = cloudOn;
    }
  }

  _restoreAtmosphere() {
    if (this._fogOff && this._sceneFog) {
      this.scene.fog = this._sceneFog;
      this._fogOff = false;
    }
    const fog = this.scene?.fog;
    if (fog) {
      fog.near = this._baseFog.near;
      fog.far = this._baseFog.far;
      if (this._baseFog.color) fog.color.copy(this._baseFog.color);
    }
    if (this._sky) {
      this._sky.position.y = 0;
      if (this._skyUp === true) {
        this._sky.visible = this._skyVisibleBefore;
        this._skyUp = false;
      }
    }
    if (this._cloudNodes) for (const c of this._cloudNodes) c.node.visible = c.visible;
    this._cloudsOn = true;
    if (this._clouds) this._clouds.visible = true;
  }

  /* ======================================================================== */
  /* HUD（自带一套极简玻璃面板，不碰 lobby 的 .lb-ui）                          */
  /* ======================================================================== */

  _buildHud() {
    if (typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.dataset.owner = 'sky-garden';
    style.textContent = `
.sky-hud{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));
  transform:translate(-50%,8px);display:flex;flex-direction:column;align-items:center;gap:8px;
  pointer-events:none;opacity:0;transition:opacity .22s ease,transform .22s ease;
  font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;z-index:60}
.sky-hud[data-on='1']{opacity:1;transform:translate(-50%,0)}
.sky-hud__line{pointer-events:none;padding:8px 18px;border-radius:999px;
  background:rgba(8,18,30,.82);border:1px solid rgba(126,227,255,.42);color:#eaf7ff;
  font-size:13px;font-weight:700;letter-spacing:.02em;box-shadow:0 8px 26px rgba(0,20,40,.32);
  backdrop-filter:blur(9px) saturate(150%);white-space:nowrap;max-width:calc(100vw - 40px);
  overflow:hidden;text-overflow:ellipsis}
.sky-hud__line b{color:#8fe9ff}
.sky-hud__btns{display:flex;gap:8px}
.sky-hud button{pointer-events:auto;padding:9px 20px;border-radius:999px;cursor:pointer;
  font-size:13px;font-weight:800;letter-spacing:.03em;color:#08222e;
  background:linear-gradient(135deg,#bff3ff,#6fd7f7);border:1px solid rgba(255,255,255,.55);
  box-shadow:0 8px 22px rgba(24,120,160,.34);transition:transform .12s ease,filter .12s ease}
.sky-hud button:hover{transform:translateY(-1px);filter:brightness(1.06)}
.sky-hud button[data-kind='ghost']{background:rgba(10,24,36,.86);color:#cfefff;
  border-color:rgba(126,227,255,.45);box-shadow:none}
.sky-hud button:disabled{opacity:.55;cursor:default;transform:none;filter:none}
`;
    document.head.appendChild(style);
    this._styleEl = style;

    const hud = document.createElement('div');
    hud.className = 'sky-hud';
    hud.dataset.on = '0';
    hud.innerHTML = '<div class="sky-hud__line" data-role="line"></div>'
      + '<div class="sky-hud__btns" data-role="btns"></div>';
    document.body.appendChild(hud);
    this._hud = hud;
    this._hudLine = hud.querySelector('[data-role="line"]');
    this._hudBtns = hud.querySelector('[data-role="btns"]');
    this._hud.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
    this._onHudClick = (e) => {
      const btn = e.target.closest?.('button');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'elevator') this._startElevator('up');
      else if (act === 'board') this._startTrain('board');
      else if (act === 'dispatch') this._startTrain('up');
      else if (act === 'descend') this._startElevator('down');
      else if (act === 'return') this._startTrain('down');
      else if (act === 'abort') this.abortToGround();
      else if (act === 'deck') this._startDeck(this._mode === 'train-docked' ? 'train' : 'elevator');
      else if (act === 'cabin') this._leaveDeck();
    };
    this._hudBtns.addEventListener('click', this._onHudClick);
  }

  _setHud(sig, html) {
    // 签名没变就什么都不重建；_button 靠 _hudDirty 判重，
    // 否则「到站」这种静止态每帧都会往按钮行里再追加一个同名按钮。
    if (!this._hud || sig === this._hudSig) { this._hudDirty = false; return; }
    this._hudDirty = true;
    this._hudSig = sig;
    this._hud.dataset.on = '1';
    this._hudLine.innerHTML = html;
    this._hudBtns.innerHTML = '';
  }

  _refreshHud() {
    if (!this._hud) return;
    const h = Math.round(this._carY);
    switch (this._mode) {
      case 'idle': {
        if (this._near === 'elevator') {
          this._setHud('near-elev', '太空电梯 · <b>按 E</b> 进舱，垂直升到 146m 空中花园');
          this._button('乘电梯上行', 'elevator');
        } else if (this._near === 'station') {
          this._setHud('near-station', '太空高铁 · <b>按 E</b> 登车，发车后沿轨道穿云而上');
          this._button('登车', 'board');
        } else {
          this._hud.dataset.on = '0';
          this._hudSig = '';
        }
        return;
      }
      case 'elev-up':
        this._setHud(`elev-${h}`, `太空电梯上行中 · 高度 <b>${h} m</b> / 146 m`);
        this._button('直接落回地面', 'abort', 'ghost');
        return;
      case 'elev-top':
        if (this._walked === 'elevator') {
          this._setHud('elev-top-back', '已回到电梯舱 · <b>按 E</b> 下到地面，也可再下舱走一圈');
          this._button('下到地面', 'descend', 'ghost');
          this._button('再逛逛', 'deck');
        } else {
          this._setHud('elev-top', '已抵达空中花园 · 146m · <b>按 E</b> 出舱漫步，可绕环自由行走');
          this._button('下舱漫步', 'deck');
          this._button('直接落地', 'abort', 'ghost');
        }
        return;
      case 'deck': {
        const deg = Math.round((((this._deck.angle * 180 / Math.PI) % 360) + 360) % 360);
        this._setHud(`deck-${deg}`, `空中花园甲板 · 方位 <b>${deg}°</b> · WASD 行走 / Shift 疾行 / 拖鼠标环视 / 滚轮缩放`);
        this._button('回舱', 'cabin', 'ghost');
        this._button('直接落地', 'abort', 'ghost');
        return;
      }
      case 'elev-down':
        this._setHud(`elewd-${h}`, `太空电梯下降中 · 高度 <b>${h} m</b>`);
        this._button('直接落回地面', 'abort', 'ghost');
        return;
      case 'train-boarded':
        this._setHud('train-board', '已登车 · 点<b>「发车」</b>或按 E，列车开始爬升');
        this._button('发车', 'dispatch');
        this._button('下车', 'abort', 'ghost');
        return;
      case 'train-up': {
        const p = Math.round(this._trainT * 100);
        this._setHud(`train-up-${p}`, `太空高铁爬升中 · 进度 <b>${p}%</b> · 穿云即将抵达环上站台`);
        return;
      }
      case 'train-docked':
        if (this._walked === 'train') {
          this._setHud('train-dock-back', '已回到车厢 · <b>按 E</b> 返程回地面站台');
          this._button('返程', 'return', 'ghost');
          this._button('再逛逛', 'deck');
        } else {
          this._setHud('train-dock', '已抵达空中站台 · 146m · <b>按 E</b> 出舱漫步');
          this._button('出舱漫步', 'deck');
          this._button('返程', 'return', 'ghost');
        }
        return;
      case 'train-down': {
        const p = Math.round((1 - this._trainT) * 100);
        this._setHud(`train-down-${p}`, `太空高铁返程中 · 已下降 <b>${p}%</b>`);
        this._button('直接落回地面', 'abort', 'ghost');
        return;
      }
      default:
        break;
    }
  }

  _button(label, act, kind = 'main') {
    if (!this._hudDirty) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.act = act;
    btn.dataset.kind = kind;
    btn.textContent = label;
    this._hudBtns.appendChild(btn);
  }

  /* ======================================================================== */
  /* 清理                                                                     */
  /* ======================================================================== */

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._mode = 'idle';
    this._restoreAtmosphere();
    if (this._hud) {
      this._hudBtns?.removeEventListener('click', this._onHudClick);
      this._hud.remove();
      this._hud = null;
    }
    if (this._styleEl) { this._styleEl.remove(); this._styleEl = null; }
    if (typeof window !== 'undefined') {
      if (this._onLookDown) {
        window.removeEventListener('pointerdown', this._onLookDown, true);
        window.removeEventListener('pointermove', this._onLookMove, true);
        window.removeEventListener('pointerup', this._onLookUp, true);
        window.removeEventListener('pointercancel', this._onLookUp, true);
        window.removeEventListener('wheel', this._onLookWheel, { passive: true });
      }
      if (this._onDeckKeyDown) {
        window.removeEventListener('keydown', this._onDeckKeyDown);
        window.removeEventListener('keyup', this._onDeckKeyUp);
        window.removeEventListener('blur', this._onDeckBlur);
      }
    }
    if (this.group.parent) this.group.parent.remove(this.group);
    for (const inst of this._instanced) {
      try { inst.dispose?.(); } catch (err) { /* 已随 lobby 资源一起释放 */ }
    }
    for (const g of this._geo) { try { g.dispose?.(); } catch (err) { /* noop */ } }
    for (const m of this._mat) { try { m.dispose?.(); } catch (err) { /* noop */ } }
    this._geo.length = 0;
    this._mat.length = 0;
    this._instanced.length = 0;
  }
}

/** 工厂：lobby 只调这一个函数，内部自律管理资源 */
export function buildSkyGarden(opts) {
  return new SkyGarden(opts).build();
}

export default buildSkyGarden;
