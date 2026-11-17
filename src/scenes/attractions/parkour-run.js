/**
 * ============================================================================
 * ParkourRun.js —— 模块 1：三轨道无尽跑酷（替换旧「金币小径」CoinPath.js）
 * ============================================================================
 * 对标《地铁跑酷》：三轨道左右切换 + 跳跃/滑铲躲避障碍 + 沿途收集金币 + 道具。
 *
 * 【IAttraction 契约】
 *   init(ctx)            建 root、存相机、建资源；不调用 world.step()
 *   update(dt)           每帧运动/动画/计时；dt 已 clamp(≤0.1)
 *   onInteract(hit)      本设施 UI 全 DOM，点击不依赖 3D 拾取，故为空实现
 *   dispose()            幂等；释放所有 geometry/material/texture，还原相机
 *
 * 【性能纪律（模块 0.6 / 0.7）】
 *   - 金币：单个 InstancedMesh（1 draw call，容量 160）
 *   - 障碍：固定对象池（≤ 22 个 Mesh），游玩中几何体数量恒定 → 无泄漏
 *   - 侧景：左右各 1 个 InstancedMesh（建筑），滚动复用不无限生成
 *   - 相机跟随：读取世界坐标 → lerp，禁止 camera.add 进 Group
 *   - 所有 CanvasTexture 显式 colorSpace = SRGBColorSpace（0.5）
 *
 * 验收：三轨切换跟手、连续 5 分钟不掉帧、无死局（生成器最多封堵 2 轨）、
 *      对象池几何数恒定；init→play→dispose 后 geometries/textures 回落基线。
 * ============================================================================
 */
import * as THREE from 'three';
import { buildCharacter } from '../../utils/helpers/procedural-character.js';
import { PauseMenu } from '../../components/pause-menu.js';

/* ----------------------------- 常量 ----------------------------- */
const LANE_X = [-2.3, 0, 2.3];          // 三条轨道横向坐标（间距 2.3）
const GROUND_Y = 0;                     // 地面（脚底）高度
const PLAYER_HALF_W = 0.4;              // 玩家碰撞盒半宽/半深
const PLAYER_STAND_H = 1.7;             // 站立高度
const PLAYER_SLIDE_H = 0.7;             // 滑铲高度
const SPAWN_Z = -95;                    // 生成处（远端）
const DESPAWN_Z = 12;                   // 越过相机后回收
const JUMP_V = 7.2;                     // 起跳速度 → 滞空 ~0.65s、顶点 ~1.18
const GRAVITY = 22;                     // 游戏感重力（非真实 9.8）
const SLIDE_TIME = 0.5;                 // 滑铲持续
const LANE_LERP = 0.16;                 // 变轨到位比例/帧（约 0.15s）
const INPUT_BUFFER = 0.1;               // 起跳输入缓冲
const COIN_CAP = 160;                   // 金币实例容量
const OBSTACLE_POOL = 22;               // 障碍池大小
const POWERUP_POOL = 4;                 // 道具池大小
const BUILDINGS_PER_SIDE = 9;           // 每侧建筑数

const START_SPEED = 14;                 // 起始速度
const MAX_SPEED = 30;                   // 速度上限
const SPEED_RAMP = 0.75;                // 每 10 秒增速
const LANE_COUNT = 3;

/* ---- 视角（第三部分）：第三人称追尾 + 鼠标微调回正 + 跑步晃动 ---- */
const CAM_BACK = 4.4;            // 追尾距离（手册 3~5 单位）
const CAM_HEIGHT = 2.55;         // 略高于角色头部，形成俯视
const CAM_FOLLOW = 0.08;         // 平滑跟随 lerp（手册 0.05~0.1，帧率归一）
const CAM_YAW_LIMIT = Math.PI / 6; // 鼠标水平微调 ±30°
const CAM_BOB_AMP = 0.07;        // 跑步上下晃动（手册 0.05~0.1，与步频同步）

/** 障碍类型 */
const OBS = {
  LOW: 'low',        // 低矮箱 → 跳
  HIGH: 'high',      // 高空横杆 → 滑铲
  WALL: 'wall',      // 整轨墙 → 换轨
  TRAIN: 'train',    // 列车车厢 → 换轨 / 跳上车顶
};

/* ------------------------------ 工具 ------------------------------ */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));

export class ParkourRun {
  constructor() {
    this.root = null;
    this._disposed = false;
    this._ctx = null;
    this._pauseMenu = null;

    // 运行状态
    this._state = 'ready';      // ready | countdown | running | dead | result
    this._time = 0;             // 内部累计时间（受暂停闸门影响）
    this._distance = 0;         // 已跑距离
    this._coinCount = 0;            // 金币数
    this._speed = START_SPEED;

    // 玩家
    this._lane = 1;             // 当前目标轨（0/1/2）
    this._playerX = 0;          // 实际 x（平滑）
    this._playerY = 0;          // 脚底高度
    this._vy = 0;
    this._grounded = true;
    this._sliding = false;
    this._slideT = 0;
    this._jumpBuffer = 0;       // 起跳缓冲剩余
    this._runPhase = 0;

    // 道具
    this._magnetT = 0;
    this._doubleT = 0;
    this._jetT = 0;
    this._shield = false;

    // 生成调度
    this._distSinceSpawn = 0;
    this._coinSeq = 0;

    // 死亡慢动作
    this._deathT = 0;

    // 输入
    this._keys = new Set();

    // 相机微调（第三部分）：鼠标水平拖拽 ±30°，松手自动回正；跑步晃动
    this._camYaw = 0;
    this._camYawTarget = 0;
    this._camDragging = false;
    this._camLastX = 0;
    this._camBaseY = CAM_HEIGHT;

    // 预分配临时对象（禁止循环内 new）
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._dummy = new THREE.Object3D();
    this._colA = new THREE.Box3();
    this._colB = new THREE.Box3();
    this._playerBox = new THREE.Box3();

    // 资源登记（dispose 兜底）
    this._geometries = [];
    this._materials = [];
    this._textures = [];
    this._instancedMeshes = []; // IM 的 instanceMatrix/instanceColor 缓冲归 IM 所有，需单独 dispose

    // 池
    this._obstacles = [];       // {group, type, lane, active, half:{x,y,z}, top, bottom}
    this._coins = [];           // 逻辑记录（与 instanced 对应）
    this._powerups = [];        // {group, type, lane, active}
    this._buildings = [];       // 每个 InstancedMesh 一条 {mesh, span}（逐实例登记会导致滚动重复叠加）
    this._countTimer = 0;

    // HUD 写入缓存（写变化检测 + 道具条节流），消灭每帧 innerHTML 重建
    this._hudScore = -1;
    this._hudCoins = -1;
    this._hudFrame = 0;

    // DOM
    this._ui = null;
    this._styleEl = null;

    // 绑定（便于解绑）
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onCamPointerDown = this._onCamPointerDown.bind(this);
    this._onCamPointerMove = this._onCamPointerMove.bind(this);
    this._onCamPointerUp = this._onCamPointerUp.bind(this);
  }

  /* ============================ init ============================ */
  init(ctx) {
    if (this._disposed) return;
    this._ctx = ctx;
    const { scene, camera, renderer } = ctx;

    // ① 接管相机
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      up: camera.up.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };

    // ② 根节点
    this.root = new THREE.Group();
    this.root.name = 'ParkourRun';
    this.root.userData.attractionRoot = true;
    scene.add(this.root);

    // ③ 场景氛围（覆盖大厅背景/雾；dispose 还原）
    // 颜色线性空间 ×0.38：抵消基座 exposure=1.0（手册 P5）
    this._sceneBgSaved = scene.background;
    this._sceneFogSaved = scene.fog;
    scene.background = new THREE.Color(0x9ec9ef).multiplyScalar(0.38);
    scene.fog = new THREE.Fog(new THREE.Color(0x9ec9ef).multiplyScalar(0.38), 60, 160);

    // ④ 光照（跑酷专属，独立不依赖昼夜系统）
    // 光强 ×0.38 抵消曝光；阴影由基座方向光承担（±30 视锥覆盖玩家区，
    // 本太阳灯只做补光，避免双阴影贴图的开销 —— 手册 P5 注意事项）
    this._light = new THREE.HemisphereLight(0xffffff, 0x9fb8c8, 0.34);
    this.root.add(this._light);
    this._sun = new THREE.DirectionalLight(0xfff2d8, 0.42);
    this._sun.position.set(-8, 20, 6);
    this.root.add(this._sun);

    this._buildLanes();
    this._buildScenery();
    this._buildPlayer();
    this._buildCoins();
    this._buildObstaclePool();
    this._buildPowerupPool();
    this._buildUI();
    // 【上线 QA】补齐 ESC / 手机暂停按钮 → 退出本局闭环（此前只能在死亡结算页返回）
    this._pauseMenu = new PauseMenu({
      onRestart: () => this._restart(),
      onExit: () => {
        this._pauseMenu?.dispose();
        this._pauseMenu = null;
        this._ctx?.onExitAttraction?.();
      },
    }).attach();

    // ⑤ 输入
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    const cv = renderer.domElement;
    cv.addEventListener('touchstart', this._onTouchStart, { passive: false });
    cv.addEventListener('touchend', this._onTouchEnd, { passive: false });
    // 鼠标拖拽微调相机（仅 mouse，避免与触摸滑屏操作冲突）
    cv.addEventListener('pointerdown', this._onCamPointerDown);
    cv.addEventListener('pointermove', this._onCamPointerMove);
    cv.addEventListener('pointerup', this._onCamPointerUp);
    cv.addEventListener('pointercancel', this._onCamPointerUp);

    // ⑥ 资源登记（兜底）
    for (const g of this._geometries) ctx.registerDisposable?.(g);
    for (const m of this._materials) ctx.registerDisposable?.(m);
    for (const t of this._textures) ctx.registerDisposable?.(t);

    // 初始相机位姿（第三人称）
    this._placeCameraInstant();
    this._setHUD();
  }

  /* --------------------------- 资源注册辅助 --------------------------- */
  _geo(g) { this._geometries.push(g); return g; }
  _mat(m) { this._materials.push(m); return m; }
  _tex(t) { t.colorSpace = THREE.SRGBColorSpace; this._textures.push(t); return t; }

  /* ----------------------------- 跑道 ----------------------------- */
  _buildLanes() {
    const laneTex = this._tex(this._makeLaneTexture());
    laneTex.wrapS = laneTex.wrapT = THREE.RepeatWrapping;
    laneTex.repeat.set(1, 40);
    const mat = this._mat(new THREE.MeshStandardMaterial({
      map: laneTex, roughness: 0.85, metalness: 0.0, color: 0x6f7378,
    }));
    const geo = this._geo(new THREE.BoxGeometry(2.0, 0.4, 220));
    for (let i = 0; i < LANE_COUNT; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(LANE_X[i], -0.2, SPAWN_Z / 2 + 10);
      m.receiveShadow = true;
      this.root.add(m);
    }
    // 两侧地台（暗色，边界感）
    const sideMat = this._mat(new THREE.MeshStandardMaterial({ color: 0x4a5260, roughness: 0.95 }));
    const sideGeo = this._geo(new THREE.BoxGeometry(6, 0.4, 220));
    for (const sx of [-7.6, 7.6]) {
      const m = new THREE.Mesh(sideGeo, sideMat);
      m.position.set(sx, -0.2, SPAWN_Z / 2 + 10);
      m.receiveShadow = true;
      this.root.add(m);
    }
  }

  _makeLaneTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#6f7378'; g.fillRect(0, 0, 64, 128);
    // 砖石/沥青颗粒
    for (let i = 0; i < 240; i++) {
      const x = Math.random() * 64, y = Math.random() * 128;
      const v = 90 + Math.random() * 40 | 0;
      g.fillStyle = `rgb(${v},${v},${v + 6})`;
      g.fillRect(x, y, 2, 2);
    }
    // 中线虚线
    g.fillStyle = 'rgba(255,225,120,0.55)';
    g.fillRect(30, 0, 4, 40); g.fillRect(30, 64, 4, 40);
    return new THREE.CanvasTexture(c);
  }

  /* ----------------------------- 侧景 ----------------------------- */
  _buildScenery() {
    const bGeo = this._geo(new THREE.BoxGeometry(1, 1, 1));
    const palette = [0x8a6f5a, 0x6d7b8c, 0x9b8068, 0x7a6f86, 0x5f7d6b];
    const bMat = this._mat(new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 0.9, metalness: 0.0 }));
    for (const side of [-1, 1]) {
      const inst = new THREE.InstancedMesh(bGeo, bMat, BUILDINGS_PER_SIDE);
      inst.frustumCulled = false;
      this._instancedMeshes.push(inst);
      const span = 200;
      for (let i = 0; i < BUILDINGS_PER_SIDE; i++) {
        const w = 2 + Math.random() * 2.4;
        const d = 2 + Math.random() * 2.4;
        const h = 6 + Math.random() * 16;
        const x = side * (9 + Math.random() * 5);
        const z = SPAWN_Z + (i / BUILDINGS_PER_SIDE) * span + Math.random() * 4;
        this._dummy.position.set(x, h / 2 - 0.4, z);
        this._dummy.scale.set(w, h, d);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.updateMatrix();
        inst.setMatrixAt(i, this._dummy.matrix);
        // 逐实例色调（低饱和，反 AI 感）
        const col = new THREE.Color(palette[(i + (side > 0 ? 2 : 0)) % palette.length]).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08);
        inst.setColorAt(i, col);
      }
      inst.instanceColor.needsUpdate = true;
      this.root.add(inst);
      this._buildings.push({ mesh: inst, span });
    }
    // 路灯（简单柱+顶光感，纯装饰）
    const poleGeo = this._geo(new THREE.CylinderGeometry(0.08, 0.1, 3.2, 6));
    const poleMat = this._mat(new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.8 }));
    const lampInst = new THREE.InstancedMesh(poleGeo, poleMat, BUILDINGS_PER_SIDE * 2);
    lampInst.frustumCulled = false;
    this._instancedMeshes.push(lampInst);
    let li = 0;
    for (const side of [-1, 1]) {
      for (let i = 0; i < BUILDINGS_PER_SIDE; i++) {
        const z = SPAWN_Z + (i / BUILDINGS_PER_SIDE) * 200 + 2;
        this._dummy.position.set(side * 8.3, 1.2, z);
        this._dummy.scale.set(1, 1, 1);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.updateMatrix();
        lampInst.setMatrixAt(li++, this._dummy.matrix);
      }
    }
    this.root.add(lampInst);
  }

  /* ----------------------------- 玩家 ----------------------------- */
  _buildPlayer() {
    // v4 T10：旧版「胶囊躯干 + 球头 + 4 根木棍」升级为 7.3 头身关节化角色。
    // scale 0.955 → 高约 1.70m，正好匹配 PLAYER_STAND_H 碰撞高度。
    // 尺寸在 rig.body 内层；外层 group 只承载位置/前后倾，不与逻辑打架。
    const rig = buildCharacter({
      style: 'player',
      scale: 0.955,
      name: 'parkour-player',
      palette: {
        coat: 0xd23b3b, pants: 0x2b3a55, skin: 0xf0c089,
        hair: 0x2c211b, shoe: 0x242833,
        hairStyle: 'short', sleeve: 'short', accessory: 'scarf',
      },
    });
    for (const g of rig.userData.disposables.geometries) this._geo(g);
    for (const m of rig.userData.disposables.materials) this._mat(m);

    // 复用原有的 _legL/_legR/_armL/_armR 契约；新增肘/膝二级关节。
    const r = rig.userData.rig;
    this._legL = r.legL;
    this._legR = r.legR;
    this._armL = r.armL;
    this._armR = r.armR;
    this._elbowL = r.elbowL;
    this._elbowR = r.elbowR;
    this._kneeL = r.kneeL;
    this._kneeR = r.kneeR;

    this._playerMesh = rig;
    this.root.add(rig);
  }

  /* ----------------------------- 金币 ----------------------------- */
  _buildCoins() {
    const geo = this._geo(new THREE.OctahedronGeometry(0.32, 0));
    const mat = this._mat(new THREE.MeshStandardMaterial({
      color: 0xffcf3a, metalness: 1.0, roughness: 0.05,
      emissive: 0x553300, emissiveIntensity: 0.21,
    }));
    this._coinMesh = new THREE.InstancedMesh(geo, mat, COIN_CAP);
    this._coinMesh.frustumCulled = false;
    this._instancedMeshes.push(this._coinMesh);
    this._coinMesh.count = COIN_CAP;
    // 初始全部缩到 0（隐藏）
    this._dummy.scale.set(0, 0, 0);
    this._dummy.position.set(0, -100, 0);
    this._dummy.updateMatrix();
    for (let i = 0; i < COIN_CAP; i++) this._coinMesh.setMatrixAt(i, this._dummy.matrix);
    this._coinMesh.instanceMatrix.needsUpdate = true;
    this.root.add(this._coinMesh);
    for (let i = 0; i < COIN_CAP; i++) {
      this._coins.push({ active: false, lane: 1, x: 0, y: 0.9, z: 0, spin: 0, idx: i });
    }
  }

  /* ----------------------------- 障碍池 ----------------------------- */
  _buildObstaclePool() {
    const boxGeo = this._geo(new THREE.BoxGeometry(1, 1, 1));
    const mats = {
      [OBS.LOW]: this._mat(new THREE.MeshStandardMaterial({ color: 0xe0a32e, roughness: 0.7, metalness: 0.1 })),
      [OBS.HIGH]: this._mat(new THREE.MeshStandardMaterial({ color: 0xc23b3b, roughness: 0.5, metalness: 0.2 })),
      [OBS.WALL]: this._mat(new THREE.MeshStandardMaterial({ color: 0x556070, roughness: 0.85, metalness: 0.05 })),
      [OBS.TRAIN]: this._mat(new THREE.MeshStandardMaterial({ color: 0x3a7d5c, roughness: 0.6, metalness: 0.25 })),
    };
    for (let i = 0; i < OBSTACLE_POOL; i++) {
      const mesh = new THREE.Mesh(boxGeo, mats[OBS.LOW]);
      mesh.castShadow = true; mesh.visible = false;
      this.root.add(mesh);
      this._obstacles.push({
        mesh, type: OBS.LOW, lane: 1, active: false,
        hx: 0.85, hy: 0.4, hz: 0.6, top: 0.8, bottom: 0,
      });
    }
    this._obstacleMats = mats;
  }

  _configureObstacle(o, type, lane) {
    o.type = type; o.lane = lane; o.active = true;
    o.mesh.material = this._obstacleMats[type];
    let w = 1.6, h, d = 1.0;
    if (type === OBS.LOW) { h = 0.8; o.top = 0.8; o.bottom = 0; }
    else if (type === OBS.HIGH) { h = 1.0; o.top = 2.2; o.bottom = 1.2; }
    else if (type === OBS.WALL) { h = 3.0; o.top = 3.0; o.bottom = 0; }
    else { h = 1.5; d = 3.2; o.top = 1.5; o.bottom = 0; } // TRAIN
    o.hx = w / 2; o.hy = h / 2; o.hz = d / 2;
    o.mesh.scale.set(w, h, d);
    o.mesh.visible = true;
  }

  /* ----------------------------- 道具池 ----------------------------- */
  _buildPowerupPool() {
    const boxGeo = this._geo(new THREE.BoxGeometry(0.5, 0.5, 0.5));
    const edgeMat = this._mat(new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x66ccff, emissiveIntensity: 0.34, roughness: 0.3, metalness: 0.4,
    }));
    for (let i = 0; i < POWERUP_POOL; i++) {
      const g = new THREE.Group();
      const cube = new THREE.Mesh(boxGeo, edgeMat);
      cube.castShadow = true;
      // 丝带（十字薄片）
      const ribbonMat = this._mat(new THREE.MeshStandardMaterial({ color: 0xff5a8a, roughness: 0.5 }));
      const ribbonGeo = this._geo(new THREE.BoxGeometry(0.52, 0.12, 0.52));
      const r1 = new THREE.Mesh(ribbonGeo, ribbonMat);
      const r2 = new THREE.Mesh(ribbonGeo, ribbonMat); r2.rotation.y = Math.PI / 2;
      g.add(cube, r1, r2);
      g.visible = false;
      this.root.add(g);
      this._powerups.push({ group: g, type: 'magnet', lane: 1, active: false, z: 0, spin: 0 });
    }
  }

  /* ------------------------------ UI ------------------------------ */
  _buildUI() {
    const style = document.createElement('style');
    style.id = 'parkour-style';
    style.textContent = `
      .pk-ui{position:fixed;inset:0;z-index:50;pointer-events:none;font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;color:#fff}
      .pk-ui *{box-sizing:border-box}
      .pk-hud{position:absolute;top:14px;left:16px;pointer-events:none;text-shadow:0 2px 6px rgba(0,0,0,.6)}
      .pk-score{font-size:30px;font-weight:800;letter-spacing:.5px}
      .pk-score small{font-size:14px;font-weight:600;opacity:.8}
      .pk-coins{position:absolute;top:14px;right:16px;font-size:22px;font-weight:800;text-shadow:0 2px 6px rgba(0,0,0,.6);pointer-events:none}
      .pk-power{position:absolute;top:54px;right:16px;display:flex;gap:8px;pointer-events:none}
      .pk-chip{background:rgba(0,0,0,.42);border:1px solid rgba(255,255,255,.25);border-radius:10px;padding:4px 8px;font-size:12px;font-weight:700;display:flex;align-items:center;gap:5px}
      .pk-chip .pk-bar{width:40px;height:5px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden}
      .pk-chip .pk-bar>i{display:block;height:100%;background:#ffd24a;width:100%}
      .pk-count{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%);font-size:120px;font-weight:900;text-shadow:0 4px 18px rgba(0,0,0,.5);pointer-events:none;opacity:0;transition:opacity .2s}
      .pk-panel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto;background:rgba(8,14,24,.55);backdrop-filter:blur(3px)}
      .pk-card{background:linear-gradient(160deg,#1c2740,#0e1626);border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:26px 30px;width:min(420px,86vw);text-align:center;box-shadow:0 18px 60px rgba(0,0,0,.5)}
      .pk-card h1{margin:0 0 6px;font-size:26px}
      .pk-card p{margin:6px 0;font-size:14px;opacity:.85;line-height:1.5}
      .pk-btn{margin:10px 6px 0;padding:11px 20px;border:0;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;color:#0c1322;background:#ffd24a;pointer-events:auto;transition:transform .1s}
      .pk-btn:hover{transform:translateY(-1px)}
      .pk-btn.sub{background:rgba(255,255,255,.14);color:#fff}
      .pk-keys{display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap}
      .pk-keys span{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:6px 9px;font-size:12px}
      .pk-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}
      .pk-stats div{background:rgba(255,255,255,.06);border-radius:10px;padding:8px}
      .pk-stats b{display:block;font-size:22px}
    `;
    document.head.appendChild(style);
    this._styleEl = style;

    const ui = document.createElement('div');
    ui.className = 'pk-ui';
    ui.innerHTML = `
      <div class="pk-hud"><div class="pk-score" id="pk-score"><b id="pk-score-num">0</b><small> 分</small></div></div>
      <div class="pk-coins" id="pk-coins">◎ 0</div>
      <div class="pk-power" id="pk-power"></div>
      <div class="pk-count" id="pk-count">3</div>
      <div class="pk-panel" id="pk-panel">
        <div class="pk-card">
          <h1>极限跑酷</h1>
          <p>三轨无尽跑酷：左右切换轨道、跳跃越障、滑铲穿杠，沿途吃金币。</p>
          <div class="pk-keys">
            <span>← → / A D 切轨</span><span>↑ W 空格 跳</span><span>↓ S 滑铲</span>
            <span>触屏：左右/上/下滑动</span>
          </div>
          <button class="pk-btn" id="pk-start">开始跑酷</button>
        </div>
      </div>`;
    document.body.appendChild(ui);
    this._ui = ui;

    this._el = {
      score: ui.querySelector('#pk-score'),
      scoreNum: ui.querySelector('#pk-score-num'),
      coins: ui.querySelector('#pk-coins'),
      power: ui.querySelector('#pk-power'),
      count: ui.querySelector('#pk-count'),
      panel: ui.querySelector('#pk-panel'),
      start: ui.querySelector('#pk-start'),
    };
    this._el.start.addEventListener('click', () => this._startCountdown());
  }

  /* ============================ 输入 ============================ */
  _onKeyDown(e) {
    const k = e.key.toLowerCase();
    this._keys.add(k);
    if (k === 'arrowleft' || k === 'a') this._switchLane(-1);
    else if (k === 'arrowright' || k === 'd') this._switchLane(1);
    else if (k === 'arrowup' || k === 'w' || k === ' ') { e.preventDefault(); this._tryJump(); }
    else if (k === 'arrowdown' || k === 's') this._trySlide();
  }
  _onKeyUp(e) { this._keys.delete(e.key.toLowerCase()); }
  _onBlur() { this._keys.clear(); this._camDragging = false; }

  /* --------------------- 鼠标相机微调（第三部分） --------------------- */
  _onCamPointerDown(e) {
    if (e.pointerType !== 'mouse') return; // 触摸留给滑屏操作
    this._camDragging = true;
    this._camLastX = e.clientX;
  }
  _onCamPointerMove(e) {
    if (!this._camDragging || e.pointerType !== 'mouse') return;
    const dx = e.clientX - this._camLastX;
    this._camLastX = e.clientX;
    this._camYawTarget = clamp(this._camYawTarget + dx * 0.003, -CAM_YAW_LIMIT, CAM_YAW_LIMIT);
  }
  _onCamPointerUp(e) {
    if (e.pointerType !== 'mouse') return;
    this._camDragging = false; // 松手 → _updateCamera 中目标角自动回正
  }

  _onTouchStart(e) {
    const t = e.changedTouches[0];
    this._touchX = t.clientX; this._touchY = t.clientY; this._touchT = performance.now();
  }
  _onTouchEnd(e) {
    if (this._touchX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - this._touchX, dy = t.clientY - this._touchY;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (Math.max(adx, ady) < 30) return; // 阈值 30px
    if (adx > ady) this._switchLane(dx > 0 ? 1 : -1);
    else if (dy < 0) this._tryJump();
    else this._trySlide();
    this._touchX = null;
  }

  _switchLane(dir) {
    if (this._state !== 'running' && this._state !== 'countdown') return;
    this._lane = clamp(this._lane + dir, 0, LANE_COUNT - 1);
  }
  _tryJump() {
    if (this._state !== 'running') return;
    if (this._grounded && !this._sliding) this._doJump();
    else this._jumpBuffer = INPUT_BUFFER; // 缓冲
  }
  _trySlide() {
    if (this._state !== 'running') return;
    if (this._grounded && !this._sliding) { this._sliding = true; this._slideT = SLIDE_TIME; }
  }
  _doJump() {
    this._vy = JUMP_V; this._grounded = false; this._jumpBuffer = 0;
  }

  /* ============================ 流程 ============================ */
  _startCountdown() {
    if (this._state !== 'ready') return;
    this._state = 'countdown';
    this._countdown = 3;
    this._countT = 0;
    this._el.panel.style.display = 'none';
    this._showCount(3);
  }
  _beginRunning() {
    this._state = 'running';
    this._distance = 0; this._coinCount = 0; this._speed = START_SPEED;
    this._playerX = 0; this._lane = 1; this._playerY = 0; this._vy = 0;
    this._grounded = true; this._sliding = false;
    this._magnetT = this._doubleT = this._jetT = 0; this._shield = false;
    this._distSinceSpawn = 0; this._time = 0;
    this._setHUD();
  }

  /* ============================ update ============================ */
  update(dt) {
    if (this._disposed) return;
    if (this._ctx?.isPaused?.()) return; // 暂停闸门
    dt = Math.min(dt, 0.1);

    if (this._state === 'countdown') {
      this._countT += dt;
      const prev = Math.ceil(this._countdown - this._countT);
      if (this._countT >= 1) {
        this._countT -= 1; this._countdown -= 1;
        if (this._countdown <= 0) { this._beginRunning(); }
        else this._showCount(this._countdown);
      }
      this._updateCamera(dt, true);
      return;
    }
    if (this._state === 'dead') {
      this._deathT -= dt;
      const sdt = dt * 0.3; // 慢动作
      this._advanceWorld(sdt);
      this._updatePlayerVisual(sdt);
      this._updateCamera(dt, false, true);
      if (this._deathT <= 0) this._showResult();
      return;
    }
    if (this._state !== 'running') {
      // ready / result：相机轻摆
      this._updateCamera(dt, false);
      return;
    }

    // —— running ——
    this._time += dt;
    // 速度曲线
    const ramp = (this._time / 10) * SPEED_RAMP;
    this._speed = Math.min(START_SPEED + ramp, MAX_SPEED);
    this._distance += this._speed * dt;

    // 道具计时
    if (this._magnetT > 0) this._magnetT = Math.max(0, this._magnetT - dt);
    if (this._doubleT > 0) this._doubleT = Math.max(0, this._doubleT - dt);
    if (this._jetT > 0) { this._jetT = Math.max(0, this._jetT - dt); }

    this._advanceWorld(dt);
    this._updatePlayer(dt);
    this._updatePlayerVisual(dt);
    this._updateCoins(dt);
    this._updatePowerups(dt);
    this._checkCollisions();
    this._updateCamera(dt, false);
    this._setHUD();
  }

  /** 推进世界（障碍/金币/侧景/生成），与速度相关 */
  _advanceWorld(dt) {
    const move = this._speed * dt;
    // 障碍
    for (const o of this._obstacles) {
      if (!o.active) continue;
      o.mesh.position.z += move;
      if (o.mesh.position.z > DESPAWN_Z) { o.active = false; o.mesh.visible = false; }
    }
    // 金币
    for (const c of this._coins) {
      if (!c.active) continue;
      c.z += move;
      c.spin += dt * 3;
      if (c.z > DESPAWN_Z) { c.active = false; }
    }
    // 道具
    for (const p of this._powerups) {
      if (!p.active) continue;
      p.z += move; p.spin += dt * 2;
      if (p.z > DESPAWN_Z) { p.active = false; p.group.visible = false; }
    }
    // 侧景（InstancedMesh 每帧更新矩阵）
    this._scrollBuildings(move);

    // 生成调度
    this._distSinceSpawn += move;
    const gap = clamp(22 - this._speed * 0.35, 10, 22);
    if (this._distSinceSpawn >= gap) {
      this._distSinceSpawn = 0;
      this._spawnRow();
    }
  }

  _scrollBuildings(move) {
    for (const b of this._buildings) {
      const inst = b.mesh;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, this._dummy.matrix);
        this._dummy.matrix.decompose(this._dummy.position, this._dummy.quaternion, this._dummy.scale);
        this._dummy.position.z += move;
        if (this._dummy.position.z > DESPAWN_Z + 10) this._dummy.position.z -= b.span;
        this._dummy.updateMatrix();
        inst.setMatrixAt(i, this._dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
    }
  }

  _spawnRow() {
    // 选择封堵轨道数：0/1/2（绝不为 3 → 无死局）
    const r = Math.random();
    const blockN = r < 0.35 ? 0 : r < 0.85 ? 1 : 2;
    const lanes = [0, 1, 2];
    // 洗牌取 blockN 条封堵
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0; [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    const blocked = lanes.slice(0, blockN);

    // 障碍
    for (const lane of blocked) {
      const o = this._obstacles.find((x) => !x.active);
      if (!o) break;
      const type = this._pickObstacleType();
      this._configureObstacle(o, type, lane);
      o.mesh.position.set(LANE_X[lane], type === OBS.HIGH ? (o.top + o.bottom) / 2 : o.hy, SPAWN_Z);
    }

    // 自由轨：金币 + 偶尔道具
    const free = lanes.slice(blockN);
    for (const lane of free) {
      // 一串金币（直线）
      const n = 3 + ((Math.random() * 3) | 0);
      let placed = 0;
      for (let i = 0; i < COIN_CAP && placed < n; i++) {
        const c = this._coins[i];
        if (c.active) continue;
        c.active = true; c.lane = lane; c.hidden = false;
        c.x = LANE_X[lane]; c.y = 0.9;
        c.z = SPAWN_Z - placed * 2.2;
        c.spin = 0;
        placed++;
      }
    }
    // 道具（约 12% 概率，放在某自由轨）
    if (free.length && Math.random() < 0.12) {
      const p = this._powerups.find((x) => !x.active);
      if (p) {
        const types = ['magnet', 'double', 'jetpack'];
        p.type = types[(Math.random() * types.length) | 0];
        p.lane = free[(Math.random() * free.length) | 0];
        p.active = true; p.z = SPAWN_Z;
        p.group.visible = true;
        p.group.position.set(LANE_X[p.lane], 1.0, SPAWN_Z);
      }
    }
  }

  _pickObstacleType() {
    const r = Math.random();
    if (r < 0.34) return OBS.LOW;
    if (r < 0.6) return OBS.HIGH;
    if (r < 0.82) return OBS.WALL;
    return OBS.TRAIN;
  }

  /* --------------------------- 玩家垂直/姿态 --------------------------- */
  _updatePlayer(dt) {
    // 横向平滑变轨
    const targetX = LANE_X[this._lane];
    this._playerX = damp(this._playerX, targetX, 1 / LANE_LERP, dt);

    // 跳跃 / 重力
    if (!this._grounded) {
      this._vy -= GRAVITY * dt;
      this._playerY += this._vy * dt;
      if (this._playerY <= GROUND_Y) {
        this._playerY = GROUND_Y; this._vy = 0; this._grounded = true;
        if (this._jumpBuffer > 0) this._doJump();
      }
    }
    // 喷射背包：强制抬高
    if (this._jetT > 0) {
      this._playerY = damp(this._playerY, 6.0, 6, dt);
      this._grounded = false;
    } else if (this._grounded && this._jetT === 0 && this._playerY > 0) {
      this._playerY = damp(this._playerY, 0, 8, dt);
    }
    // 滑铲计时
    if (this._sliding) {
      this._slideT -= dt;
      if (this._slideT <= 0) this._sliding = false;
    }
    // 跑步相位
    if (this._grounded && this._jetT <= 0) this._runPhase += dt * (8 + this._speed * 0.25);
    else this._runPhase += dt * 3;
  }

  _updatePlayerVisual(dt) {
    const g = this._playerMesh;
    g.position.set(this._playerX, this._playerY, 0);
    // 姿态
    if (this._sliding) {
      g.rotation.x = -1.15;
      g.position.y += 0.35;
    } else if (!this._grounded || this._jetT > 0) {
      g.rotation.x = -0.25; // 起跳前倾
    } else {
      g.rotation.x = 0;
    }
    // 摆臂摆腿（沿用原有 pivot 契约，不改动输入/碰撞/相机）
    const s = Math.sin(this._runPhase);
    const s2 = Math.sin(this._runPhase + Math.PI);
    const sw = this._grounded && this._jetT <= 0 ? 0.7 : 0.15;
    this._legL.rotation.x = s * sw;
    this._legR.rotation.x = s2 * sw;
    this._armL.rotation.x = s2 * sw * 0.8;
    this._armR.rotation.x = s * sw * 0.8;

    // v4 T10：两段式四肢——肘/膝二级关节随步频弯曲，摆脱「木棍摆动」观感。
    // 肘向前弯（负 X，与对侧摆臂同步）；膝向后弯（正 X，摆动腿抬膝更明显）。
    const moving = this._grounded && this._jetT <= 0 && !this._sliding;
    const bend = moving ? 1 : 0.12;
    this._elbowL.rotation.x = -0.28 - Math.max(0, -s) * 0.80 * bend;
    this._elbowR.rotation.x = -0.28 - Math.max(0, s) * 0.80 * bend;
    this._kneeL.rotation.x = 0.10 + Math.max(0, s) * 0.90 * bend;
    this._kneeR.rotation.x = 0.10 + Math.max(0, -s) * 0.90 * bend;

    if (this._sliding) {
      // 滑铲：root 已整体后仰 -1.15，这里双臂贴身前伸、双腿收起
      this._armL.rotation.x = -1.25; this._armR.rotation.x = -1.25;
      this._elbowL.rotation.x = -0.15; this._elbowR.rotation.x = -0.15;
      this._legL.rotation.x = 0.30; this._legR.rotation.x = -0.10;
      this._kneeL.rotation.x = 0.85; this._kneeR.rotation.x = 0.45;
      this._armL.rotation.z = 0; this._armR.rotation.z = 0;
    } else if (!this._grounded || this._jetT > 0) {
      // 腾空 / 喷射：双臂上举微张
      this._armL.rotation.x = -1.95; this._armR.rotation.x = -1.95;
      this._armL.rotation.z = -0.25; this._armR.rotation.z = 0.25;
      this._elbowL.rotation.x = -0.30; this._elbowR.rotation.x = -0.30;
    } else {
      this._armL.rotation.z = 0; this._armR.rotation.z = 0;
    }
  }

  /* ----------------------------- 金币 ----------------------------- */
  _updateCoins(dt) {
    const center = this._tmpV.set(this._playerX, this._playerY + 0.9, 0);
    for (const c of this._coins) {
      if (!c.active) {
        // 回收/拾取后缩到 0，避免残留可见。【优化】只写一次零矩阵，不再每帧重复写 160 次
        if (!c.hidden) {
          c.hidden = true;
          this._dummy.position.set(0, -1000, 0);
          this._dummy.rotation.set(0, 0, 0);
          this._dummy.scale.set(0, 0, 0);
          this._dummy.updateMatrix();
          this._coinMesh.setMatrixAt(c.idx, this._dummy.matrix);
        }
        continue;
      }
      c.hidden = false;
      // 磁铁吸附
      if (this._magnetT > 0) {
        const dx = center.x - c.x, dy = center.y - c.y, dz = center.z - c.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 36) { // 6 单位
          const k = 1 - Math.exp(-6 * dt);
          c.x += dx * k; c.y += dy * k; c.z += dz * k;
        }
      }
      // 写入实例矩阵
      this._dummy.position.set(c.x, c.y, c.z);
      this._dummy.rotation.set(0, c.spin, 0);
      this._dummy.scale.set(1, 1, 1);
      this._dummy.updateMatrix();
      this._coinMesh.setMatrixAt(c.idx, this._dummy.matrix);
    }
    this._coinMesh.instanceMatrix.needsUpdate = true;
  }

  /* ----------------------------- 道具 ----------------------------- */
  _updatePowerups(dt) {
    for (const p of this._powerups) {
      if (!p.active) continue;
      p.group.position.set(LANE_X[p.lane], 1.0 + Math.sin(this._time * 2 + p.z) * 0.12, p.z);
      p.group.rotation.y = p.spin;
    }
  }

  /* --------------------------- 碰撞判定 --------------------------- */
  _checkCollisions() {
    if (this._jetT > 0) {
      // 喷射中：无视障碍，但仍吃金币（下面处理）
    }
    // 玩家盒
    const ph = this._sliding ? PLAYER_SLIDE_H : PLAYER_STAND_H;
    this._playerBox.min.set(this._playerX - PLAYER_HALF_W, this._playerY, -PLAYER_HALF_W);
    this._playerBox.max.set(this._playerX + PLAYER_HALF_W, this._playerY + ph, PLAYER_HALF_W);

    // 障碍
    if (this._jetT <= 0) {
      for (const o of this._obstacles) {
        if (!o.active) continue;
        const op = o.mesh.position;
        // 轨道不同且未重叠（x 方向）快速剔除
        if (Math.abs(op.x - this._playerX) > o.hx + PLAYER_HALF_W) continue;
        if (Math.abs(op.z) > o.hz + PLAYER_HALF_W) continue;
        // y 区间重叠？
        const obMin = o.bottom, obMax = o.top;
        // 玩家脚底高于障碍顶 → 站在顶上（跳上车顶/越过）
        if (this._playerY >= obMax - 0.12) continue;
        if (this._playerBox.max.y < obMin || this._playerY > obMax) continue;
        // 命中
        if (this._shield) { this._shield = false; o.active = false; o.mesh.visible = false; this._flashShield(); continue; }
        this._die();
        return;
      }
    }
    // 金币拾取
    const pickR = this._magnetT > 0 ? 0.9 : 0.6;
    const cy = this._playerY + 0.9;
    for (const c of this._coins) {
      if (!c.active) continue;
      if (Math.abs(c.x - this._playerX) > 0.6) continue;
      if (Math.abs(c.z) > pickR) continue;
      // 喷射飞行时无视高度差，收集头顶金币层
      if (this._jetT <= 0 && Math.abs(c.y - cy) > 1.2) continue;
      c.active = false;
      this._coins_collect();
    }
    // 道具拾取
    for (const p of this._powerups) {
      if (!p.active) continue;
      if (Math.abs(p.z) > 0.9) continue;
      if (Math.abs(LANE_X[p.lane] - this._playerX) > 0.7) continue;
      p.active = false; p.group.visible = false;
      this._activatePower(p.type);
    }
  }

  _coins_collect() {
    this._coinCount += 1;
  }

  _activatePower(type) {
    if (type === 'magnet') this._magnetT = 8;
    else if (type === 'double') this._doubleT = 10;
    else if (type === 'jetpack') this._jetT = 5;
    else if (type === 'shield') this._shield = true;
  }

  _flashShield() {
    // 简易：护盾消耗时短暂降速感（不实现视觉特效，避免新增资源）
  }

  /* --------------------------- 相机跟随 --------------------------- */
  _placeCameraInstant() {
    const cam = this._ctx.camera;
    this._camYaw = 0; this._camYawTarget = 0;
    this._camBaseY = CAM_HEIGHT;
    cam.position.set(this._playerX, CAM_HEIGHT, CAM_BACK);
    cam.lookAt(this._playerX, 1.1, -5);
    cam.fov = 65; cam.updateProjectionMatrix();
  }
  _updateCamera(dt, idle, deathPull = false) {
    const cam = this._ctx.camera;
    // 松手自动回正到角色正后方；拖拽时目标角保持
    if (!this._camDragging) this._camYawTarget = damp(this._camYawTarget, 0, 6, dt);
    this._camYaw = damp(this._camYaw, this._camYawTarget, 10, dt);
    const sin = Math.sin(this._camYaw), cos = Math.cos(this._camYaw);
    // 目标 = 角色位置 + 后方偏移（经朝向旋转）；死亡拉远抬高
    this._camTarget.set(
      this._playerX + sin * CAM_BACK,
      this._playerY + CAM_HEIGHT + (deathPull ? 1.5 : 0),
      cos * CAM_BACK + (deathPull ? 3 : 0)
    );
    const k = 1 - Math.pow(1 - CAM_FOLLOW, Math.min(dt, 0.1) * 60); // 帧率归一 lerp 0.08
    cam.position.x = lerp(cam.position.x, this._camTarget.x, k);
    cam.position.z = lerp(cam.position.z, this._camTarget.z, k);
    // Y 单独追踪基准高度，晃动叠加在基准之上（避免逐帧累积）
    this._camBaseY = lerp(this._camBaseY, this._camTarget.y, k);
    let bob = 0;
    if (!idle && !deathPull && this._state === 'running' && this._grounded && this._jetT <= 0) {
      bob = Math.sin(this._runPhase * 2) * CAM_BOB_AMP; // 2× 腿摆频 = 步频，与跑步同步
    }
    cam.position.y = this._camBaseY + bob;
    this._camLook.set(this._playerX - sin * 5, this._playerY + 1.1, -cos * 5);
    cam.lookAt(this._camLook);
    const targetFov = lerp(65, 75, clamp((this._speed - START_SPEED) / (MAX_SPEED - START_SPEED), 0, 1));
    if (Math.abs(cam.fov - targetFov) > 0.05) { cam.fov = damp(cam.fov, targetFov, 4, dt); cam.updateProjectionMatrix(); }
  }

  /* ----------------------------- HUD ----------------------------- */
  /* 【热点修复】原来 running 态每帧重建 score/power 两处 innerHTML（60/s DOM 拼串+解析）：
   *  - 分数：数值只在整数变化时写 <b> 的 textContent（"<small> 分</small>" 静态化，不再进 innerHTML）；
   *  - 金币：textContent 仅在变化时写；
   *  - 道具条：进度条肉眼无感，节流到 ~10Hz 重建一次 innerHTML。 */
  _setHUD() {
    const score = Math.floor(this._distance) + this._coinCount * (this._doubleT > 0 ? 2 : 1);
    if (score !== this._hudScore) {
      this._hudScore = score;
      this._el.scoreNum.textContent = String(score);
    }
    if (this._coinCount !== this._hudCoins) {
      this._hudCoins = this._coinCount;
      this._el.coins.textContent = `◎ ${this._coinCount}`;
    }
    // 道具条节流（6 帧 ≈ 0.1s）；拾取/失效的瞬间最多延迟 0.1s 显示，视觉无感
    if (++this._hudFrame >= 6) {
      this._hudFrame = 0;
      const chips = [];
      if (this._magnetT > 0) chips.push(this._chip('磁铁', this._magnetT / 8));
      if (this._doubleT > 0) chips.push(this._chip('双倍', this._doubleT / 10));
      if (this._jetT > 0) chips.push(this._chip('飞行', this._jetT / 5));
      if (this._shield) chips.push(`<div class="pk-chip">护盾</div>`);
      this._el.power.innerHTML = chips.join('');
    }
  }
  _chip(name, ratio) {
    const pct = clamp(ratio, 0, 1) * 100;
    return `<div class="pk-chip">${name}<div class="pk-bar"><i style="width:${pct}%"></i></div></div>`;
  }
  _showCount(n) {
    this._el.count.textContent = n;
    this._el.count.style.opacity = '1';
    clearTimeout(this._countTimer);
    this._countTimer = setTimeout(() => { if (this._el) this._el.count.style.opacity = '0'; }, 600);
  }

  /* ----------------------------- 死亡/结算 ----------------------------- */
  _die() {
    if (this._state !== 'running') return;
    this._state = 'dead';
    this._deathT = 0.5;
  }
  _showResult() {
    this._state = 'result';
    const score = Math.floor(this._distance) + this._coinCount * (this._doubleT > 0 ? 2 : 1);
    const best = Number(localStorage.getItem('parkour_best') || 0);
    const isNew = score > best;
    if (isNew) localStorage.setItem('parkour_best', String(score));
    this._el.panel.innerHTML = `
      <div class="pk-card">
        <h1>本局结束</h1>
        <div class="pk-stats">
          <div>得分<b>${score}</b></div>
          <div>金币<b>${this._coinCount}</b></div>
          <div>距离<b>${Math.floor(this._distance)}m</b></div>
          <div>最高<b>${Math.max(best, score)}</b></div>
        </div>
        ${isNew ? '<p style="color:#ffd24a">🎉 新纪录！</p>' : ''}
        <button class="pk-btn" id="pk-retry">再来一次</button>
        <button class="pk-btn sub" id="pk-lobby">返回大厅</button>
      </div>`;
    this._el.panel.style.display = 'flex';
    this._el.panel.querySelector('#pk-retry').addEventListener('click', () => this._restart());
    this._el.panel.querySelector('#pk-lobby').addEventListener('click', () => this._ctx.onExitAttraction?.());
  }
  _restart() {
    // 清场
    for (const o of this._obstacles) { o.active = false; o.mesh.visible = false; }
    for (const c of this._coins) c.active = false;
    for (const p of this._powerups) { p.active = false; p.group.visible = false; }
    this._dummy.scale.set(0, 0, 0); this._dummy.position.set(0, -100, 0); this._dummy.updateMatrix();
    for (let i = 0; i < COIN_CAP; i++) this._coinMesh.setMatrixAt(i, this._dummy.matrix);
    this._coinMesh.instanceMatrix.needsUpdate = true;
    this._el.panel.style.display = 'none';
    this._beginRunning();
  }

  /* ============================ onInteract ============================ */
  onInteract() { /* UI 由 DOM 驱动，无需 3D 拾取 */ }

  /* ============================ dispose ============================ */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    clearTimeout(this._countTimer);
    this._pauseMenu?.dispose();
    this._pauseMenu = null;

    // 输入解绑
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    const cv = this._ctx?.renderer?.domElement;
    if (cv) {
      cv.removeEventListener('touchstart', this._onTouchStart);
      cv.removeEventListener('touchend', this._onTouchEnd);
      cv.removeEventListener('pointerdown', this._onCamPointerDown);
      cv.removeEventListener('pointermove', this._onCamPointerMove);
      cv.removeEventListener('pointerup', this._onCamPointerUp);
      cv.removeEventListener('pointercancel', this._onCamPointerUp);
    }
    // DOM 移除
    if (this._ui && this._ui.parentNode) this._ui.parentNode.removeChild(this._ui);
    if (this._styleEl && this._styleEl.parentNode) this._styleEl.parentNode.removeChild(this._styleEl);
    this._ui = null; this._styleEl = null;

    // 还原场景背景/雾
    const scene = this._ctx?.scene;
    if (scene) {
      scene.background = this._sceneBgSaved ?? null;
      scene.fog = this._sceneFogSaved ?? null;
    }
    // 还原相机
    const cam = this._ctx?.camera;
    if (cam && this._cameraSaved) {
      cam.position.copy(this._cameraSaved.position);
      cam.quaternion.copy(this._cameraSaved.quaternion);
      cam.up.copy(this._cameraSaved.up);
      cam.rotation.order = this._cameraSaved.rotationOrder;
      cam.fov = this._cameraSaved.fov;
      cam.updateProjectionMatrix();
    }
    // 释放资源（几何体/材质/纹理/实例缓冲）
    for (const im of this._instancedMeshes) { try { im.dispose(); } catch (e) {} }
    for (const g of this._geometries) { try { g.dispose(); } catch (e) {} }
    for (const m of this._materials) { try { m.dispose(); } catch (e) {} }
    for (const t of this._textures) { try { t.dispose(); } catch (e) {} }
    this._instancedMeshes.length = 0;
    this._geometries.length = 0; this._materials.length = 0; this._textures.length = 0;
  }

  /* ============================ warmUp（验收） ============================ */
  warmUp() {
    // 直接进入 running 并跑一段，覆盖生成/碰撞/拾取/道具路径；结束后复位
    this._beginRunning();
    for (let i = 0; i < 240; i++) {
      this._advanceWorld(0.016);
      // 偶尔变轨/跳/滑，触发各分支
      if (i % 20 === 0) this._switchLane(i % 2 ? 1 : -1);
      if (i % 25 === 0) this._tryJump();
      if (i % 35 === 0) this._trySlide();
      this._updatePlayer(0.016);
      this._updatePlayerVisual(0.016);
      this._updateCoins(0.016);
      this._updatePowerups(0.016);
      this._checkCollisions();
      this._updateCamera(0.016, false);
    }
    // 触发一次道具激活
    this._activatePower('magnet');
    this._activatePower('double');
    this._activatePower('jetpack');
    for (let i = 0; i < 60; i++) { this._advanceWorld(0.016); this._updateCoins(0.016); this._checkCollisions(); }
    // 复位（保持对象池，几何数恒定）
    for (const o of this._obstacles) { o.active = false; o.mesh.visible = false; }
    for (const c of this._coins) c.active = false;
    for (const p of this._powerups) { p.active = false; p.group.visible = false; }
    this._dummy.scale.set(0, 0, 0); this._dummy.position.set(0, -100, 0); this._dummy.updateMatrix();
    for (let i = 0; i < COIN_CAP; i++) this._coinMesh.setMatrixAt(i, this._dummy.matrix);
    this._coinMesh.instanceMatrix.needsUpdate = true;
    this._state = 'ready';
    return this;
  }
}

export default ParkourRun;
