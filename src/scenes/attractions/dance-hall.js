/**
 * ============================================================================
 * DanceHall —— 跳舞厅（阶段二·模块 1，取代退役的「跳一跳」）
 * ============================================================================
 * 玩法：室内观赏设施。低多边形拼搭的封闭舞厅——发光舞蹈地板、舞台（钢琴 /
 *       立麦 / 舞位）、霓虹灯球、音箱堆、观众席长凳；舞台上三名虚拟人物
 *       （procedural-character 的 buildCharacter 关节骨架）分别做【弹琴 /
 *       唱歌 / 跳舞】的循环关节动画，与 118BPM 合成节拍同相。
 *       玩家以第一人称进厅：WASD / 方向键走动、左键拖拽环顾（复用大厅
 *       WASDController 的输入与圆-AABB 碰撞口径），UI 提供「返回大厅」。
 *
 * 【单文件闭环】场景、动画、音乐调度、UI（DOM+CSS）、资源清理全部在本类内；
 *   不 import / 不修改 core/ 任何基座模块（与 MemoryMatch 同约定）。
 *
 * 【IAttraction 契约】init(ctx) / update(dt) / onInteract(hitInfo) / dispose()
 *   四方法齐全；dispose() 幂等；root 挂到 ctx.scene；全程不用 Rapier。
 *
 * ---------------------------------------------------------------------------
 * 【热基线验收口径】init 一次性建完所有 geometry / material / texture，
 *   update() 只改属性（关节旋转 / 灯光强度 / 自转 / emissive 脉动），
 *   绝不惰性新建 GPU 资源 → redline 多轮「大厅→跳舞厅→大厅」Δgeo=Δtex=0。
 *   音乐调度器（WebAudio）按 16 分格 lookahead 排程，振荡器为 CPU 侧节点、
 *   与 GPU 资源台账无关；interval id 全登记，dispose 先停表再 close()。
 *
 * 【灯光】自建 3 盏 PointLight（castShadow=false）；天花板 castShadow 挡掉
 *   基座平行光直射，室内明暗由自建灯光 + 全局半球光共同决定。
 * ============================================================================
 */

import * as THREE from 'three';
import { IAttraction } from './i-attraction.js';
import { buildCharacter, disposeCharacter } from '../../utils/helpers/procedural-character.js';
import { WASDController } from '../../utils/controls/wasd-controller.js';

/* ========================================================================== */
/* 常量配置                                                                    */
/* ========================================================================== */

/** 厅体尺寸（米）：x ∈ [-13,13] / z ∈ [-9,9] / 层高 8.5 */
const ROOM = Object.freeze({ W: 26, D: 18, H: 8.5 });
/** 舞台（位于 -z 端）：台面 y=0.9 */
const STAGE = Object.freeze({ CX: 0, CZ: -6, W: 10, D: 4, H: 0.9 });
/** 节拍：118 BPM（kick 每 0.5085s 一拍） */
const BPM = 118;
const SPB = 60 / BPM;          // 一拍秒数
const W2 = (Math.PI * 2) / (SPB * 2);  // 双拍周期角速度（人物动画主频）
const W1 = W2 / 2;                     // 单倍频（缓慢摆动）
const W4 = W2 * 2;                     // 四倍频（快速细节）

/** 音量 / 调度 */
const BEAT_VOLUME = 0.16;
const SCHEDULE_AHEAD = 0.22;   // 提前排程秒数
const SCHEDULE_TICK = 60;      // 调度器轮询间隔 ms

/** 贝斯线（2 小节 × 16 分格，0 = 休止）：Am → F 走向 */
const BASS_PATTERN = Object.freeze([
  55.00, 0, 55.00, 0, 0, 55.00, 0, 65.41, 55.00, 0, 0, 55.00, 0, 82.41, 73.42, 65.41,
  87.31, 0, 87.31, 0, 0, 87.31, 0, 65.41, 87.31, 0, 0, 87.31, 0, 73.42, 65.41, 55.00,
]);

/* ========================================================================== */
/* Canvas 纹理（init 一次性绘制，dispose 释放）                                */
/* ========================================================================== */

/** 舞蹈地板：紫 / 蓝棋盘格 + 走线，同时用作 emissiveMap（节拍脉动） */
function makeDanceFloorTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 384;
  const g = c.getContext('2d');
  const TW = 32, TH = 32;
  for (let iy = 0; iy < c.height / TH; iy += 1) {
    for (let ix = 0; ix < c.width / TW; ix += 1) {
      const even = (ix + iy) % 2 === 0;
      g.fillStyle = even ? '#3b2a6e' : '#23408f';
      g.fillRect(ix * TW, iy * TH, TW, TH);
      if (even) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(ix * TW + 4, iy * TH + 4, TW - 8, TH - 8); }
    }
  }
  g.strokeStyle = 'rgba(180,220,255,0.35)'; g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, c.width - 3, c.height - 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 镜球贴图：深底 + 白色点阵（emissive 闪烁感由贴图对比度直接给出） */
function makeDiscoBallTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#20242e'; g.fillRect(0, 0, c.width, c.height);
  const CELL = 12;
  for (let y = 0; y < c.height / CELL; y += 1) {
    for (let x = 0; x < c.width / CELL; x += 1) {
      const l = 150 + ((x * 7 + y * 13) % 5) * 18;
      g.fillStyle = `rgb(${l},${l + 8},${l + 20})`;
      g.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ========================================================================== */
/* DanceHall                                                                   */
/* ========================================================================== */

export class DanceHall extends IAttraction {
  constructor() {
    super();

    this.root = new THREE.Group();
    this.root.name = 'DanceHall';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;

    /** 累计时间（动画相位源） */
    this._time = 0;

    // ---- 相机接管（dispose 最前段恢复） ----
    this._cameraSaved = null;

    // ---- 输入 ----
    this._wasd = null;

    // ---- Three 资源台账（Set 去重；登记进 registry 二次兜底） ----
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();

    /** 走动碰撞盒（世界 2D AABB，含四墙 / 舞台 / 音箱 / 长凳） */
    this._walkBoxes = [];

    /** 表演者台账：{ kind, group, rig } */
    this._performers = [];

    /** InstancedMesh 台账（dispose 需逐个 .dispose() 释放 instanceMatrix buffer） */
    this._instancedMeshes = [];

    // ---- 动效引用 ----
    this._discoBall = null;
    this._discoLight = null;
    this._stageLight = null;
    this._floorMat = null;
    this._stripMats = [];

    // ---- 音乐调度 ----
    this._audio = null;          // AudioContext
    this._beatMaster = null;     // GainNode
    this._beatNoise = null;      // 共享噪声 buffer
    this._schedId = null;        // setInterval id
    this._beatStep = 0;
    this._beatNext = 0;
    this._muted = false;

    // ---- DOM / 事件登记 ----
    this._uiRoot = null;
    this._uiStyle = null;
    this._listeners = [];
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                      */
  /* ------------------------------------------------------------------------ */

  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera, renderer } = ctx;
    if (!scene || !camera) throw new Error('[DanceHall] 缺少 scene / camera');
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    /* ---------- ① 接管相机：出生在门内，看向舞台 ---------- */
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    camera.position.set(0, 1.6, 7.4);
    camera.lookAt(0, 2.4, -6);
    camera.updateMatrixWorld(true);

    /* ---------- 关键：挂根节点（漏了 = 计数恒等基线的假通过） ---------- */
    scene.add(this.root);

    /* ---------- ② 共享资源池一次性建完 ---------- */
    this._buildSharedResources();
    for (const geo of this._geometries) register(geo);
    for (const mat of this._materials) register(mat);
    for (const tex of this._textures) register(tex);

    /* ---------- ③ 场景拼搭 ---------- */
    this._buildRoom();
    this._buildStage();
    this._buildPiano();
    this._buildMicStand();
    this._buildDiscoBall();
    this._buildSpeakers();
    this._buildAudience();
    this._buildPerformers();
    this._buildLights();

    /* ---------- ④ 输入：WASD 走动 + 拖拽环顾（复用大厅控制器） ---------- */
    this._wasd = new WASDController({
      camera,
      domElement: renderer?.domElement || null,
      getObstacles: () => this._walkBoxes,
      isEnabled: () => !this._disposed,
    });
    this._wasd.resetFromCamera(camera);
    this._wasd.attach();

    /* ---------- ⑤ UI ---------- */
    this._buildUI();

    /* ---------- ⑥ 节拍音乐 ---------- */
    this._startBeat();

    console.info(
      `[DanceHall] init 完成 | 表演者=${this._performers.length} | ` +
        `几何=${this._geometries.size} 材质=${this._materials.size} 纹理=${this._textures.size} | ` +
        `节拍=${BPM}BPM | 不使用 Rapier，走动复用 WASDController`
    );
  }

  _trackGeometry(geo) { this._geometries.add(geo); return geo; }
  _trackMaterial(mat) { this._materials.add(mat); return mat; }
  _trackTexture(tex) { this._textures.add(tex); return tex; }

  /* ------------------------------------------------------------------------ */
  /* 共享资源池                                                                */
  /* ------------------------------------------------------------------------ */

  _buildSharedResources() {
    const G = (geo) => this._trackGeometry(geo);
    const M = (mat) => this._trackMaterial(mat);
    const S = (this._shared = {});

    /* 几何 */
    S.geoFloor = G(new THREE.PlaneGeometry(ROOM.W, ROOM.D));
    S.geoCeil = G(new THREE.BoxGeometry(ROOM.W, 0.3, ROOM.D));
    S.geoWallBack = G(new THREE.BoxGeometry(ROOM.W, ROOM.H, 0.5));
    S.geoWallSide = G(new THREE.BoxGeometry(0.5, ROOM.H, ROOM.D));
    S.geoStage = G(new THREE.BoxGeometry(STAGE.W, STAGE.H, STAGE.D));
    S.geoStageFront = G(new THREE.BoxGeometry(STAGE.W, 0.55, 0.18));
    S.geoBox = G(new THREE.BoxGeometry(1, 1, 1));
    S.geoCyl = G(new THREE.CylinderGeometry(0.5, 0.5, 1, 14));
    S.geoCone = G(new THREE.ConeGeometry(0.5, 1, 12));
    S.geoSphere = G(new THREE.SphereGeometry(0.5, 14, 10));
    S.geoDisco = G(new THREE.SphereGeometry(0.62, 18, 14));
    S.geoStrip = G(new THREE.BoxGeometry(1, 0.09, 0.09));
    S.geoBenchSeat = G(new THREE.BoxGeometry(4.2, 0.16, 0.75));
    S.geoBenchBack = G(new THREE.BoxGeometry(4.2, 0.55, 0.1));
    S.geoBenchLeg = G(new THREE.BoxGeometry(0.12, 0.42, 0.6));
    S.geoBlackKey = G(new THREE.BoxGeometry(0.055, 0.05, 0.3));
    S.geoPlaneGlow = G(new THREE.PlaneGeometry(1, 1));

    /* 材质 */
    S.matFloor = M(new THREE.MeshStandardMaterial({
      map: this._trackTexture(makeDanceFloorTexture()),
      emissive: new THREE.Color(0x9fb4ff),
      emissiveIntensity: 0.22,
      roughness: 0.42, metalness: 0.08,
    }));
    S.matFloor.emissiveMap = S.matFloor.map; // 同一张图既作 albedo 又作发光图
    this._floorMat = S.matFloor;

    S.matWall = M(new THREE.MeshStandardMaterial({ color: 0x2a2333, roughness: 0.92, metalness: 0.02 }));
    S.matCeil = M(new THREE.MeshStandardMaterial({ color: 0x1c1826, roughness: 0.95 }));
    S.matStage = M(new THREE.MeshStandardMaterial({ color: 0x3a2f4d, roughness: 0.6, metalness: 0.15 }));
    S.matStageSkirt = M(new THREE.MeshStandardMaterial({ color: 0x8b2d5c, roughness: 0.55, metalness: 0.2 }));
    S.matDark = M(new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 0.85 }));
    S.matWood = M(new THREE.MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.7 }));
    S.matIvory = M(new THREE.MeshStandardMaterial({ color: 0xf3efe2, roughness: 0.35 }));
    S.matBlackKey = M(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.4, metalness: 0.3 }));
    S.matMetal = M(new THREE.MeshStandardMaterial({ color: 0x8f96a3, roughness: 0.3, metalness: 0.85 }));
    S.matDisco = M(new THREE.MeshStandardMaterial({
      map: this._trackTexture(makeDiscoBallTexture()),
      emissive: new THREE.Color(0xffffff), emissiveMap: null, emissiveIntensity: 0.5,
      roughness: 0.25, metalness: 0.6,
    }));
    S.matDisco.emissiveMap = S.matDisco.map;

    /* 自有霓虹条材质（update 里做呼吸脉动；不与任何人共享） */
    S.matStripPink = M(new THREE.MeshStandardMaterial({
      color: 0x3d1d33, emissive: new THREE.Color(0xff5fb0), emissiveIntensity: 0.9, roughness: 0.4,
    }));
    S.matStripBlue = M(new THREE.MeshStandardMaterial({
      color: 0x14243d, emissive: new THREE.Color(0x53c2ff), emissiveIntensity: 0.9, roughness: 0.4,
    }));
    this._stripMats = [S.matStripPink, S.matStripBlue];

    S.matSpeakerGrill = M(new THREE.MeshStandardMaterial({ color: 0x24242c, roughness: 0.95 }));
    S.matBench = M(new THREE.MeshStandardMaterial({ color: 0x6e2f4f, roughness: 0.8 }));
  }

  /* ------------------------------------------------------------------------ */
  /* 场景拼搭                                                                  */
  /* ------------------------------------------------------------------------ */

  /** 通用件：新建 Mesh（几何 / 材质取自共享池），登记阴影开关 */
  _mesh(parent, name, geo, mat, sx, sy, sz, x, y, z, { rot = null, shadow = true, receive = true } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.name = `DanceHall/${name}`;
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = shadow;
    m.receiveShadow = receive;
    parent.add(m);
    return m;
  }

  _buildRoom() {
    const S = this._shared;
    // 地板（PlaneGeometry 旋转平铺； receiveShadow 承接舞者与灯光）
    const floor = this._mesh(this.root, 'floor', S.geoFloor, S.matFloor, 1, 1, 1, 0, 0, 0,
      { rot: [-Math.PI / 2, 0, 0], shadow: false, receive: true });
    floor.receiveShadow = true;
    // 天花板（castShadow 挡平行光 → 室内只吃自建灯 + 全局半球光）
    this._mesh(this.root, 'ceiling', S.geoCeil, S.matCeil, 1, 1, 1, 0, ROOM.H - 0.15, 0, { shadow: true, receive: false });
    // 四面墙（背 / 前 / 左 / 右）
    this._mesh(this.root, 'wall-back', S.geoWallBack, S.matWall, 1, 1, 1, 0, ROOM.H / 2, -ROOM.D / 2 - 0.25);
    this._mesh(this.root, 'wall-front', S.geoWallBack, S.matWall, 1, 1, 1, 0, ROOM.H / 2, ROOM.D / 2 + 0.25);
    this._mesh(this.root, 'wall-left', S.geoWallSide, S.matWall, 1, 1, 1, -ROOM.W / 2 - 0.25, ROOM.H / 2, 0);
    this._mesh(this.root, 'wall-right', S.geoWallSide, S.matWall, 1, 1, 1, ROOM.W / 2 + 0.25, ROOM.H / 2, 0);

    // 墙顶霓虹勾边：前墙 / 背墙横向长条（粉 / 蓝交替），update 做呼吸
    const stripY = ROOM.H - 0.7;
    this._mesh(this.root, 'strip-back-p', S.geoStrip, S.matStripPink, ROOM.W - 1, 1, 1, 0, stripY, -ROOM.D / 2 + 0.35, { shadow: false });
    this._mesh(this.root, 'strip-back-b', S.geoStrip, S.matStripBlue, ROOM.W - 1, 1, 1, 0, stripY - 0.55, -ROOM.D / 2 + 0.35, { shadow: false });
    this._mesh(this.root, 'strip-front-p', S.geoStrip, S.matStripPink, ROOM.W - 1, 1, 1, 0, stripY, ROOM.D / 2 - 0.35, { shadow: false });
    this._mesh(this.root, 'strip-front-b', S.geoStrip, S.matStripBlue, ROOM.W - 1, 1, 1, 0, stripY - 0.55, ROOM.D / 2 - 0.35, { shadow: false });
    // 侧墙竖条
    this._mesh(this.root, 'strip-side-l', S.geoStrip, S.matStripBlue, 1, 1, ROOM.D - 2, -ROOM.W / 2 + 0.35, stripY - 1.4, 0, { rot: [0, 0, Math.PI / 2], shadow: false });
    this._mesh(this.root, 'strip-side-r', S.geoStrip, S.matStripPink, 1, 1, ROOM.D - 2, ROOM.W / 2 - 0.35, stripY - 1.4, 0, { rot: [0, 0, Math.PI / 2], shadow: false });

    // 正门装饰（前墙内侧：双开玻璃门 + 门楣，纯装饰）
    this._mesh(this.root, 'door-frame', S.geoBox, S.matWood, 3.4, 0.28, 0.3, 0, 3.15, ROOM.D / 2 - 0.1, { shadow: false });
    this._mesh(this.root, 'door-glass-l', S.geoPlaneGlow, S.matStageSkirt, 1.45, 2.9, 1, -0.78, 1.55, ROOM.D / 2 - 0.12, { rot: [0, Math.PI, 0], shadow: false });
    this._mesh(this.root, 'door-glass-r', S.geoPlaneGlow, S.matStageSkirt, 1.45, 2.9, 1, 0.78, 1.55, ROOM.D / 2 - 0.12, { rot: [0, Math.PI, 0], shadow: false });

    /* 走动碰撞盒（世界 2D AABB；WASD 玩家半径 0.5 由控制器内处理） */
    const B = this._walkBoxes;
    B.push({ minX: -ROOM.W / 2, maxX: ROOM.W / 2, minZ: -ROOM.D / 2 - 1, maxZ: -ROOM.D / 2 + 0.2 });       // 背墙
    B.push({ minX: -ROOM.W / 2, maxX: ROOM.W / 2, minZ: ROOM.D / 2 - 0.2, maxZ: ROOM.D / 2 + 1 });         // 前墙
    B.push({ minX: -ROOM.W / 2 - 1, maxX: -ROOM.W / 2 + 0.2, minZ: -ROOM.D / 2, maxZ: ROOM.D / 2 });       // 左墙
    B.push({ minX: ROOM.W / 2 - 0.2, maxX: ROOM.W / 2 + 1, minZ: -ROOM.D / 2, maxZ: ROOM.D / 2 });         // 右墙
  }

  _buildStage() {
    const S = this._shared;
    const y = STAGE.H / 2;
    const stage = this._mesh(this.root, 'stage-deck', S.geoStage, S.matStage, 1, 1, 1, STAGE.CX, y, STAGE.CZ);
    stage.receiveShadow = true;
    // 前裙边（玫红幕布质感）
    this._mesh(this.root, 'stage-skirt', S.geoStageFront, S.matStageSkirt, 1, 1, 1, STAGE.CX, 0.45, STAGE.CZ + STAGE.D / 2 + 0.02, { shadow: false });
    // 台口霓虹框（左右竖条 + 顶横条）
    this._mesh(this.root, 'stage-neon-l', S.geoStrip, S.matStripPink, 1, 1, 1, -STAGE.W / 2, STAGE.H + 1.6, STAGE.CZ + STAGE.D / 2 + 0.3, { rot: [0, 0, Math.PI / 2], shadow: false });
    this._mesh(this.root, 'stage-neon-r', S.geoStrip, S.matStripPink, 1, 1, 1, STAGE.W / 2, STAGE.H + 1.6, STAGE.CZ + STAGE.D / 2 + 0.3, { rot: [0, 0, Math.PI / 2], shadow: false });
    this._mesh(this.root, 'stage-neon-top', S.geoStrip, S.matStripBlue, STAGE.W, 1, 1, STAGE.CX, STAGE.H + 3.1, STAGE.CZ + STAGE.D / 2 + 0.3, { shadow: false });
    // 背景幕（背墙前的深色大幕，微凹造型用三块拼接）
    this._mesh(this.root, 'curtain-l', S.geoBox, S.matDark, 4.6, 5.4, 0.3, -4.9, 2.7, STAGE.CZ - STAGE.D / 2 + 0.4, { shadow: false });
    this._mesh(this.root, 'curtain-r', S.geoBox, S.matDark, 4.6, 5.4, 0.3, 4.9, 2.7, STAGE.CZ - STAGE.D / 2 + 0.4, { shadow: false });
    this._mesh(this.root, 'curtain-c', S.geoBox, S.matDark, 3.2, 6.2, 0.3, 0, 3.1, STAGE.CZ - STAGE.D / 2 + 0.9, { shadow: false });
    // 舞台阻挡（玩家不可上台，围栏语义由碰撞盒承担）
    this._walkBoxes.push({
      minX: STAGE.CX - STAGE.W / 2 - 0.9, maxX: STAGE.CX + STAGE.W / 2 + 0.9,
      minZ: STAGE.CZ - STAGE.D / 2 - 1, maxZ: STAGE.CZ + STAGE.D / 2 + 0.35,
    });
  }

  _buildPiano() {
    const S = this._shared;
    const g = new THREE.Group();
    g.name = 'DanceHall/piano';
    g.position.set(-3.3, STAGE.H, -6.2);
    g.rotation.y = Math.PI / 2; // 琴键朝向琴师（-x 侧）
    this.root.add(g);
    // 琴体 + 掀开的琴盖
    this._mesh(g, 'body', S.geoBox, S.matBlackKey, 1.55, 0.34, 1.0, 0, 1.06, 0);
    const lid = this._mesh(g, 'lid', S.geoBox, S.matBlackKey, 1.55, 0.05, 0.95, 0, 1.42, -0.24, { rot: [-0.62, 0, 0], shadow: false });
    lid.castShadow = false;
    // 三条琴腿 + 踏板座
    for (const sx of [-0.62, 0, 0.62]) {
      this._mesh(g, `leg-${sx}`, S.geoCyl, S.matBlackKey, 0.09, 0.9, 0.09, sx, 0.45, sx === 0 ? 0.34 : 0);
    }
    // 琴键（白键条 + 黑键 InstancedMesh 7 颗）
    this._mesh(g, 'keys-white', S.geoBox, S.matIvory, 1.42, 0.07, 0.3, 0, 1.0, 0.42, { shadow: false });
    const black = new THREE.InstancedMesh(S.geoBlackKey, S.matBlackKey, 7);
    black.name = 'DanceHall/piano-black-keys';
    this._instancedMeshes.push(black);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 7; i += 1) {
      dummy.position.set(-0.6 + i * 0.2, 1.055, 0.34);
      dummy.updateMatrix();
      black.setMatrixAt(i, dummy.matrix);
    }
    black.instanceMatrix.needsUpdate = true;
    black.castShadow = false;
    g.add(black);
    // 琴谱架（斜板）
    this._mesh(g, 'music-stand', S.geoBox, S.matDark, 0.62, 0.42, 0.03, 0, 1.5, 0.18, { rot: [-0.35, 0, 0], shadow: false });
    // 琴凳（独立于琴，供琴师落座）
    const bench = new THREE.Group();
    bench.name = 'DanceHall/piano-bench';
    bench.position.set(-2.0, STAGE.H, -6.2);
    bench.rotation.y = Math.PI / 2;
    this.root.add(bench);
    this._mesh(bench, 'seat', S.geoBox, S.matWood, 0.72, 0.1, 0.5, 0, 0.55, 0);
    for (const sx of [-0.28, 0.28]) {
      this._mesh(bench, `bench-leg-${sx}`, S.geoBox, S.matWood, 0.08, 0.5, 0.42, sx, 0.25, 0, { shadow: false });
    }
  }

  _buildMicStand() {
    const S = this._shared;
    const g = new THREE.Group();
    g.name = 'DanceHall/mic-stand';
    g.position.set(0.34, STAGE.H, -4.72);
    this.root.add(g);
    this._mesh(g, 'base', S.geoCyl, S.matMetal, 0.5, 0.06, 0.5, 0, 0.03, 0, { shadow: false });
    this._mesh(g, 'pole', S.geoCyl, S.matMetal, 0.045, 1.52, 0.045, 0, 0.79, 0);
    // 话筒头（向歌者方向微倾）
    const mic = this._mesh(g, 'mic-head', S.geoCyl, S.matDark, 0.09, 0.2, 0.09, -0.02, 1.66, 0.02, { rot: [0.5, 0, 0], shadow: false });
    mic.castShadow = false;
  }

  _buildDiscoBall() {
    const S = this._shared;
    const g = new THREE.Group();
    g.name = 'DanceHall/disco-ball';
    g.position.set(0, 0, -1.2);
    this.root.add(g);
    // 吊杆 + 球体
    this._mesh(g, 'rod', S.geoCyl, S.matMetal, 0.03, ROOM.H - 7.0, 0.03, 0, ROOM.H - (ROOM.H - 7.0) / 2, 0, { shadow: false });
    const ball = this._mesh(g, 'ball', S.geoDisco, S.matDisco, 1, 1, 1, 0, 6.62, 0, { shadow: false });
    this._discoBall = ball;
  }

  _buildSpeakers() {
    const S = this._shared;
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.name = `DanceHall/speaker-${side < 0 ? 'l' : 'r'}`;
      const x = side * 7.7;
      g.position.set(x, 0, -8.2);
      this.root.add(g);
      this._mesh(g, 'cab-main', S.geoBox, S.matDark, 1.5, 2.4, 1.15, 0, 1.2, 0);
      this._mesh(g, 'cab-top', S.geoBox, S.matDark, 1.15, 1.5, 1.0, 0, 3.15, 0);
      // 两个喇叭纸盆（扁圆柱贴面）
      this._mesh(g, 'woofer', S.geoCyl, S.matSpeakerGrill, 0.52, 0.06, 0.52, 0, 1.0, 0.62, { rot: [Math.PI / 2, 0, 0], shadow: false });
      this._mesh(g, 'tweeter', S.geoCyl, S.matSpeakerGrill, 0.3, 0.06, 0.3, 0, 3.3, 0.56, { rot: [Math.PI / 2, 0, 0], shadow: false });
      this._walkBoxes.push({ minX: x - 0.95, maxX: x + 0.95, minZ: -8.95, maxZ: -7.45 });
    }
  }

  _buildAudience() {
    const S = this._shared;
    const rows = [2.9, 5.0];
    const cols = [-5.4, 0, 5.4];
    const seats = [];
    const backs = [];
    const legs = [];
    for (const z of rows) {
      for (const x of cols) {
        seats.push([x, 0.44, z]);
        backs.push([x, 0.78, z + 0.42]);
        legs.push([x - 1.9, 0.21, z], [x + 1.9, 0.21, z]);
        this._walkBoxes.push({ minX: x - 2.3, maxX: x + 2.3, minZ: z - 0.55, maxZ: z + 0.65 });
      }
    }
    const dummy = new THREE.Object3D();
    const seatIM = new THREE.InstancedMesh(S.geoBenchSeat, S.matBench, seats.length);
    seatIM.name = 'DanceHall/bench-seats';
    this._instancedMeshes.push(seatIM);
    for (let i = 0; i < seats.length; i += 1) {
      dummy.position.set(...seats[i]); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
      dummy.updateMatrix(); seatIM.setMatrixAt(i, dummy.matrix);
    }
    seatIM.instanceMatrix.needsUpdate = true;
    seatIM.castShadow = true;
    this.root.add(seatIM);

    const backIM = new THREE.InstancedMesh(S.geoBenchBack, S.matBench, backs.length);
    backIM.name = 'DanceHall/bench-backs';
    this._instancedMeshes.push(backIM);
    for (let i = 0; i < backs.length; i += 1) {
      dummy.position.set(...backs[i]); dummy.updateMatrix(); backIM.setMatrixAt(i, dummy.matrix);
    }
    backIM.instanceMatrix.needsUpdate = true;
    backIM.castShadow = false;
    this.root.add(backIM);

    const legIM = new THREE.InstancedMesh(S.geoBenchLeg, S.matDark, legs.length);
    legIM.name = 'DanceHall/bench-legs';
    this._instancedMeshes.push(legIM);
    for (let i = 0; i < legs.length; i += 1) {
      dummy.position.set(...legs[i]); dummy.updateMatrix(); legIM.setMatrixAt(i, dummy.matrix);
    }
    legIM.instanceMatrix.needsUpdate = true;
    legIM.castShadow = false;
    this.root.add(legIM);
  }

  /* ------------------------------------------------------------------------ */
  /* 表演者（procedural-character 关节骨架）                                    */
  /* ------------------------------------------------------------------------ */

  _buildPerformers() {
    /** 三个角色的调色板（buildCharacter 的 palette 直传） */
    const PALETTES = {
      pianist: { coat: 0x3a2f4d, pants: 0x241f2e, skin: 0xe8bd94, hair: 0x1d1712, shoe: 0x18141c, hairStyle: 'bun', sleeve: 'long', accessory: 'none' },
      singer: { coat: 0xc2477e, pants: 0x8a2c55, skin: 0xf0c089, hair: 0x51200f, shoe: 0x3c1f4a, hairStyle: 'bob', sleeve: 'short', accessory: 'none' },
      dancer: { coat: 0x2ec4b6, pants: 0x1b6e68, skin: 0xd9a066, hair: 0x2c211b, shoe: 0xe8e4d8, hairStyle: 'short', sleeve: 'short', accessory: 'scarf' },
    };
    const SPEC = [
      { kind: 'pianist', x: -2.35, z: -6.2, rotY: -Math.PI / 2, seated: true },
      { kind: 'singer', x: 0.0, z: -5.35, rotY: 0, seated: false },
      { kind: 'dancer', x: 3.0, z: -5.6, rotY: 0, seated: false },
    ];
    for (const spec of SPEC) {
      const char = buildCharacter({ palette: PALETTES[spec.kind], name: `DanceHall/${spec.kind}` });
      char.name = `DanceHall/performer-${spec.kind}`;
      // 站姿：脚踩舞台面（y=0.9）；坐姿：骨盆枢轴(局部 0.925)落在琴凳面
      // (0.9+0.55+0.08=1.53) → group.y = 1.53-0.925 ≈ 0.61
      char.position.set(spec.x, spec.seated ? 0.61 : STAGE.H, spec.z);
      char.rotation.y = spec.rotY;
      this.root.add(char);
      this._performers.push({ kind: spec.kind, group: char, rig: char.userData.rig, seated: spec.seated });
    }
  }

  /** 逐人关节动画：全部 sin/cos，与节拍同相（118BPM），零新建 */
  _animatePerformers(t) {
    for (const p of this._performers) {
      const rig = p.rig;
      if (!rig) continue;
      if (p.kind === 'pianist') {
        // 坐姿：大腿前伸 + 小腿垂下；双臂交替敲击；头部看键位
        rig.legL.rotation.x = -1.5; rig.legR.rotation.x = -1.5;
        rig.kneeL.rotation.x = 1.5; rig.kneeR.rotation.x = 1.5;
        rig.torso.rotation.x = 0.14;
        rig.armL.rotation.x = -0.92 + Math.sin(t * W2) * 0.22;
        rig.armR.rotation.x = -0.92 + Math.sin(t * W2 + Math.PI) * 0.22;
        rig.armL.rotation.z = -0.16; rig.armR.rotation.z = 0.16;
        rig.elbowL.rotation.x = -0.5 + Math.sin(t * W2) * 0.1;
        rig.elbowR.rotation.x = -0.5 + Math.sin(t * W2 + Math.PI) * 0.1;
        rig.head.rotation.x = 0.24 + Math.sin(t * W2) * 0.04;
        rig.head.rotation.y = Math.sin(t * W1) * 0.18;
        rig.body.rotation.z = Math.sin(t * W2) * 0.02;
      } else if (p.kind === 'singer') {
        // 立麦前：右手持麦姿态，身体随拍弹跳，头部扫视观众
        rig.armR.rotation.x = -0.62;
        rig.armR.rotation.z = 0.32;
        rig.elbowR.rotation.x = -0.95;
        rig.armL.rotation.x = Math.sin(t * W2 + 1.2) * 0.16 - 0.12;
        rig.armL.rotation.z = -0.2 - Math.max(0, Math.sin(t * W1)) * 0.55;
        rig.body.position.y = Math.abs(Math.sin(t * W2)) * 0.045;
        rig.body.rotation.x = 0.05 + Math.sin(t * W2) * 0.02;
        rig.head.rotation.x = 0.06 + Math.sin(t * W2) * 0.05;
        rig.head.rotation.y = Math.sin(t * W1) * 0.4;
        rig.legL.rotation.x = Math.sin(t * W2) * 0.05;
        rig.legR.rotation.x = -Math.sin(t * W2) * 0.05;
      } else {
        // 舞者：双臂大开大合绕环 + 髋部摆动 + 重心弹跳 + 缓慢转身
        const s = Math.sin(t * W2);
        rig.armL.rotation.z = -0.95 - (0.55 + 0.45 * Math.sin(t * W2 + Math.PI * 0.5));
        rig.armR.rotation.z = 0.95 + (0.55 + 0.45 * Math.sin(t * W2 + Math.PI));
        rig.armL.rotation.x = s * 0.3;
        rig.armR.rotation.x = -s * 0.3;
        rig.elbowL.rotation.x = -0.35; rig.elbowR.rotation.x = -0.35;
        rig.body.rotation.z = Math.sin(t * W2) * 0.075;
        rig.body.position.y = Math.abs(Math.sin(t * W2)) * 0.06;
        rig.head.rotation.z = -Math.sin(t * W2) * 0.14;
        rig.legL.rotation.x = s * 0.34;
        rig.legR.rotation.x = -s * 0.34;
        rig.kneeL.rotation.x = Math.max(0, -s) * 0.5;
        rig.kneeR.rotation.x = Math.max(0, s) * 0.5;
        p.group.rotation.y = Math.sin(t * W1) * 0.85;
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 灯光                                                                      */
  /* ------------------------------------------------------------------------ */

  _buildLights() {
    // 舞台暖光主灯
    this._stageLight = new THREE.PointLight(0xffd2a0, 62, 26, 2);
    this._stageLight.name = 'DanceHall/light-stage';
    this._stageLight.position.set(0, 6.0, -5.4);
    this.root.add(this._stageLight);
    // 镜球冷光（update 里随节拍呼吸）
    this._discoLight = new THREE.PointLight(0x7fb4ff, 34, 22, 2);
    this._discoLight.name = 'DanceHall/light-disco';
    this._discoLight.position.set(0, 6.5, -1.2);
    this.root.add(this._discoLight);
    // 观众席补光（粉紫）
    const fill = new THREE.PointLight(0xff7bc4, 26, 20, 2);
    fill.name = 'DanceHall/light-fill';
    fill.position.set(0, 3.6, 4.2);
    this.root.add(fill);
  }

  /* ------------------------------------------------------------------------ */
  /* 节拍音乐（WebAudio 全合成，无音频文件）                                    */
  /* ------------------------------------------------------------------------ */

  _startBeat() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this._audio = new AC();
    } catch {
      this._audio = null;
      return;
    }
    const ac = this._audio;
    if (ac.state === 'suspended') ac.resume?.().catch(() => {});

    this._beatMaster = ac.createGain();
    this._beatMaster.gain.value = this._muted ? 0 : BEAT_VOLUME;
    this._beatMaster.connect(ac.destination);

    // 共享噪声 buffer（hat / clap 用；init 一次）
    const len = Math.floor(ac.sampleRate * 0.4);
    this._beatNoise = ac.createBuffer(1, len, ac.sampleRate);
    const data = this._beatNoise.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;

    this._beatStep = 0;
    this._beatNext = ac.currentTime + 0.1;
    this._schedId = setInterval(() => this._scheduleBeat(), SCHEDULE_TICK);
  }

  _scheduleBeat() {
    const ac = this._audio;
    if (!ac || this._disposed) return;
    const S16 = SPB / 4;
    while (this._beatNext < ac.currentTime + SCHEDULE_AHEAD) {
      const step = this._beatStep % 32;
      const t = this._beatNext;
      if (step % 4 === 0) this._kick(t);                       // 四踩
      if (step % 8 === 4) this._clap(t);                       // 2/4 拍 clap
      if (step % 4 === 2) this._hat(t, 0.5);                   // 反拍 hat（重音）
      else if (step % 2 === 0) this._hat(t, 0.26);             // 其余 8 分弱 hat
      const f = BASS_PATTERN[step];
      if (f) this._bass(t, f);
      if (step % 16 === 0) this._stab(t, step === 0 ? 220.0 : 174.61); // Am / F 和弦垫
      this._beatNext += S16;
      this._beatStep += 1;
    }
  }

  /** 底鼓：正弦 150→44Hz 快速下滑 + 指数衰减 */
  _kick(t) {
    const ac = this._audio;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(0.95, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g).connect(this._beatMaster);
    osc.start(t); osc.stop(t + 0.24);
  }

  /** 军鼓位 clap：带通噪声短脉冲 ×2 */
  _clap(t) {
    const ac = this._audio;
    for (const dt of [0, 0.012]) {
      const src = ac.createBufferSource();
      src.buffer = this._beatNoise;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 1.1;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.5, t + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.09);
      src.connect(bp).connect(g).connect(this._beatMaster);
      src.start(t + dt); src.stop(t + dt + 0.1);
    }
  }

  /** 踩镲：高通噪声，极短衰减 */
  _hat(t, vol) {
    const ac = this._audio;
    const src = ac.createBufferSource();
    src.buffer = this._beatNoise;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7200;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    src.connect(hp).connect(g).connect(this._beatMaster);
    src.start(t); src.stop(t + 0.04);
  }

  /** 贝斯：锯齿波 + 低通，八分音符短音 */
  _bass(t, freq) {
    const ac = this._audio;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 2.2;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(lp).connect(g).connect(this._beatMaster);
    osc.start(t); osc.stop(t + 0.22);
  }

  /** 和弦垫：三振荡器（根音 + 纯四 + 大六）齐奏短衰减 */
  _stab(t, root) {
    const ac = this._audio;
    for (const mul of [1, 4 / 3, 1.5]) {
      const osc = ac.createOscillator();
      osc.type = 'square';
      osc.frequency.value = root * mul * 2;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.075, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      osc.connect(g).connect(this._beatMaster);
      osc.start(t); osc.stop(t + 0.26);
    }
  }

  _stopBeat() {
    if (this._schedId != null) {
      clearInterval(this._schedId);
      this._schedId = null;
    }
    if (this._audio) {
      const ac = this._audio;
      this._audio = null;
      this._beatMaster = null;
      this._beatNoise = null;
      try { ac.close().catch(() => {}); } catch { /* 已关闭 */ }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* UI                                                                        */
  /* ------------------------------------------------------------------------ */

  _buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      .dh-ui { position: fixed; top: 14px; left: 14px; z-index: 60; display: flex;
        align-items: center; gap: 10px; font-family: var(--pg-ui-font,'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif);
        user-select: none; pointer-events: none; }
      .dh-badge { background: linear-gradient(158deg,rgba(38,26,26,.78),rgba(12,18,30,.7));
        border: 1px solid rgba(235,198,128,.44);
        border-radius: 13px; padding: 9px 15px; color: #ffe9f4; font-size: 14px; line-height: 1.5;
        box-shadow: 0 12px 32px rgba(4,8,18,.42), inset 0 1px 0 rgba(255,246,214,.16);
        backdrop-filter: blur(16px) saturate(140%); -webkit-backdrop-filter: blur(16px) saturate(140%); pointer-events: auto; }
      .dh-badge b { color: #ff8fc8; font-size: 15px; letter-spacing: 1px;
        text-shadow: 0 1px 2px rgba(0,0,0,.55), 0 0 18px rgba(255,95,176,.38); }
      .dh-badge small { color: #c7c2bc; display: block; font-size: 11.5px; margin-top: 2px; }
      .dh-btn { pointer-events: auto; cursor: pointer; border-radius: 11px;
        border: 1px solid rgba(235,198,128,.34);
        background: linear-gradient(155deg,rgba(64,30,48,.72),rgba(26,18,34,.78));
        color: #ffe9f4; font-size: 13.5px; padding: 10px 15px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.1); }
      .dh-btn:hover { background: linear-gradient(155deg,rgba(116,48,84,.86),rgba(46,26,46,.9));
        border-color: rgba(255,206,156,.68); transform: translateY(-2px) scale(1.03);
        box-shadow: 0 8px 24px rgba(255,95,176,.2), 0 0 20px rgba(255,196,104,.18); }
    `;
    document.head.appendChild(style);
    this._uiStyle = style;

    const root = document.createElement('div');
    root.className = 'dh-ui';
    root.innerHTML = `
      <div class="dh-badge"><b>🎵 跳舞厅</b><small>WASD / 方向键走动 · 拖拽环顾 · 手机左侧摇杆移动</small></div>
      <button class="dh-btn" data-dh="music">🔊 音乐</button>
      <button class="dh-btn" data-dh="exit">⏻ 返回大厅</button>
    `;
    document.body.appendChild(root);
    this._uiRoot = root;

    const onMusic = () => {
      this._muted = !this._muted;
      const btn = root.querySelector('[data-dh="music"]');
      if (btn) btn.textContent = this._muted ? '🔇 音乐' : '🔊 音乐';
      if (this._beatMaster && this._audio) {
        const target = this._muted ? 0 : BEAT_VOLUME;
        try { this._beatMaster.gain.setTargetAtTime(target, this._audio.currentTime, 0.05); } catch { /* ignore */ }
      }
    };
    const onExit = () => { if (!this._disposed) this._ctx?.onExitAttraction?.(); };
    const onKey = (e) => { if (e.code === 'Escape' && !this._disposed) onExit(); };

    root.querySelector('[data-dh="music"]')?.addEventListener('click', onMusic);
    root.querySelector('[data-dh="exit"]')?.addEventListener('click', onExit);
    window.addEventListener('keydown', onKey);
    this._listeners.push(
      ['music', root.querySelector('[data-dh="music"]'), onMusic],
      ['exit', root.querySelector('[data-dh="exit"]'), onExit],
      ['key', window, onKey],
    );
  }

  _removeUI() {
    for (const [, target, fn] of this._listeners) {
      if (target) target.removeEventListener?.('click', fn);
      if (target === window) window.removeEventListener('keydown', fn);
    }
    this._listeners.length = 0;
    this._uiRoot?.remove();
    this._uiRoot = null;
    this._uiStyle?.remove();
    this._uiStyle = null;
  }

  /* ------------------------------------------------------------------------ */
  /* update / onInteract / dispose                                             */
  /* ------------------------------------------------------------------------ */

  update(deltaTime) {
    if (this._disposed) return;
    const dt = Math.min(Math.max(Number(deltaTime) || 0, 0), 0.1);
    this._time += dt;
    const t = this._time;

    // WASD 走动（控制器内部处理碰撞 / 边界 / 姿态回写）
    this._wasd?.update(dt);

    // 表演者关节动画
    this._animatePerformers(t);

    // 镜球自转 + 冷光呼吸（四拍包络）
    if (this._discoBall) this._discoBall.rotation.y += dt * 0.85;
    const beatPhase = (t / SPB) % 1;
    const env = Math.pow(1 - beatPhase, 3); // 踩点攻击-衰减包络
    if (this._discoLight) this._discoLight.intensity = 24 + 26 * env;
    if (this._stageLight) this._stageLight.intensity = 54 + 10 * env;

    // 地板 / 霓虹条呼吸（自有材质，不共享）
    if (this._floorMat) this._floorMat.emissiveIntensity = 0.16 + 0.3 * env;
    const breath = 0.55 + 0.45 * Math.sin(t * W2);
    if (this._stripMats[0]) this._stripMats[0].emissiveIntensity = 0.45 + 0.75 * breath;
    if (this._stripMats[1]) this._stripMats[1].emissiveIntensity = 0.45 + 0.75 * (1 - breath);
  }

  onInteract(_hitInfo) { /* 厅内无拾取交互；点击全部走 DOM 按钮 */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* ① 音乐调度器先停（interval + AudioContext） */
    this._stopBeat();

    /* ② 输入控制器解绑 */
    this._wasd?.dispose();
    this._wasd = null;

    /* ③ UI 移除 */
    this._removeUI();

    /* ④ 相机恢复（MemoryMatch 同口径） */
    const cam = this._ctx?.camera;
    if (cam && this._cameraSaved) {
      cam.position.copy(this._cameraSaved.position);
      cam.quaternion.copy(this._cameraSaved.quaternion);
      cam.rotation.order = this._cameraSaved.rotationOrder;
      cam.fov = this._cameraSaved.fov;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      this._cameraSaved = null;
    }

    /* ⑤ 表演者骨架 GPU 资源（procedural-character 自带台账） */
    for (const p of this._performers) disposeCharacter(p.group);
    this._performers.length = 0;

    /* ⑤-b InstancedMesh 显式释放（instanceMatrix 的 GL buffer 不随 geometry.dispose
     *     回收——fireworks-deck 泄漏同款教训，必须逐个 dispose） */
    if (this._instancedMeshes) {
      for (const im of this._instancedMeshes) {
        try { im.dispose(); } catch { /* 幂等 */ }
      }
      this._instancedMeshes.length = 0;
    }

    /* ⑥ 自建 Three 资源台账（Set 去重，THREE dispose 幂等） */
    for (const tex of this._textures) tex.dispose();
    for (const mat of this._materials) mat.dispose();
    for (const geo of this._geometries) geo.dispose();
    this._textures.clear();
    this._materials.clear();
    this._geometries.clear();
    this._walkBoxes.length = 0;
    this._discoBall = null;
    this._discoLight = null;
    this._stageLight = null;
    this._floorMat = null;
    this._stripMats.length = 0;
    this._shared = null;
    this._ctx = null;
  }
}

export default DanceHall;
