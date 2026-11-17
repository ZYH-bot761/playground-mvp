/**
 * ============================================================================
 * Districts.js —— M7 正方形四宫格骨架 + 区域级可见性/LOD
 * ============================================================================
 * 四宫格以 (30,30) 为中心、外框 120×120（x/z∈[-30,90]），十字道路分隔：
 *
 *   z=90  ┌───────────────┬───────────────┐
 *         │   城堡园       │   农家宝       │  ← 北侧（M7 骨架 / M8·M9 内容）
 *         │   (0,60)      │   (60,60)     │
 *   z=30  ├───────────────┼───────────────┤  ← 东西横路 + 绿化带
 *         │   游乐园区     │   动物园       │  ← 南侧（既有，坐标零改动）
 *         │   (0,0)       │   (60,0)      │
 *  z=-30  └───────────────┴───────────────┘
 *         x=-30         x=30           x=90
 *                       ↑ 南北纵路 + 绿化带
 *
 * 【为何不平移既有设施】v4 全部验收机位锚定原点附近、朝 -z 看；FACILITIES /
 * ZOO_LAYOUT / 触发环 / NPC / 地面 / 雾全是硬编码。整体平移会让 v4 13 项全线
 * 崩溃。本模块「保持既有 + 北侧扩建」，用十字道路/绿化带把园区逻辑与视觉上都
 * 组织成正方形 2×2。既有跑酷长廊沿 -z 延伸属场地内纵深，不视为越界。
 *
 * 【预算与 Δ0/0 红线】俯瞰机位只剩约 1600 面、calls 增量余量仅 6：
 *  1. 零新增 geometry / texture —— 全部复用 Lobby._shared 的 geoBox/geoCone/
 *     geoCylinder；仅新建少量 MeshBasicMaterial（不计入 renderer.info.memory 的
 *     geometries/textures），并自行成对释放。
 *  2. 所有静态结构（道路/绿化带/地面/描边）合并进【1 个 InstancedMesh】
 *     + instanceColor，1 个 draw call。
 *  3. 在 Lobby._ensureGeometryUpload()【之后】构建，且保持 frustumCulled=true，
 *     不被强制常驻渲染；北侧新区在俯瞰/常规验收机位视锥外 → 自动剔除。
 *  4. 区域级 LOD：北侧两区各包一层 THREE.LOD（近景 detail / 远景 silhouette），
 *     renderer 投影阶段自动 update，热路径零新建。M8/M9 只需往 detail 组填内容，
 *     即自动获得「远离时不渲染」的预算保护。
 * ============================================================================
 */
import * as THREE from 'three';
import { buildCastle } from './castle.js'; // 【M8】童话公主风城堡（挂在 castle 区 detail）
import { buildFarm } from './farm.js';    // 【M9】农家宝（挂在 farm 区 detail）

/** 四宫格坐标：单一真相源。世界 x/z；四格中心构成 60×60 正方形。 */
export const DISTRICT_GRID = Object.freeze({
  center: Object.freeze({ x: 24, z: 27 }),
  outer: Object.freeze({ minX: -30, maxX: 90, minZ: -30, maxZ: 90, size: 120 }),
  cell: Object.freeze({ w: 58, h: 58, pitch: 60 }),
  // 13m 车行道（双向四车道 × 3.25m）+ 两侧 1.5m 人行道 = 16m 走廊。
  road: Object.freeze({ width: 13, axisX: 24, axisZ: 27, walk: 1.5, lane: 3.25, corridor: 16 }),
  quadrants: Object.freeze({
    amusement: Object.freeze({ cx: 0, cz: 0, color: 0x4f9d5d, cn: '游乐园区', en: 'AMUSEMENT', content: 'existing' }),
    zoo: Object.freeze({ cx: 60, cz: 0, color: 0x3f7fc4, cn: '动物园', en: 'ZOO', content: 'existing' }),
    castle: Object.freeze({ cx: -7, cz: 60, color: 0xe8a8d8, cn: '城堡园', en: 'CASTLE', content: 'placeholder' }),
    farm: Object.freeze({ cx: 60, cz: 60, color: 0x8fbf5a, cn: '农家宝', en: 'FARM', content: 'placeholder' }),
  }),
  /**
   * LOD 阈值：相机距区中心 < 该值显示完整 detail，否则显示远景剪影。
   * 取 100 的原因：四宫格总览机位 (30,84,96) 距城堡/农家宝中心约 96m，若阈值
   * 取 78 则总览只看到远景剪影（一个色块），无法展示城堡/农场真容；提至 100
   * 让总览即显示 detail。redline 验收机位 (0,30,34)/(0,9.4,25) 朝 -z 看，北侧
   * 两区在相机背后被视锥剔除（与阈值无关），故本改动不影响相对 M0 的 Δ 预算；
   * 绝对俯瞰面数 252,866+城堡/农场 detail≈7k≈26 万，仍远低于 30 万上限。
   */
  lodDistance: 100,
});

/** 四宫格总览机位（同时框住游乐场与四区） */
export const DISTRICT_VIEW = Object.freeze({
  cam: [30, 84, 96],
  tgt: [30, 2, 30],
});

/** 阶段五验收：从公园北缘看都会区天际线（相机在公园内，城市在北侧） */
export const METROPOLIS_VIEW = Object.freeze({
  cam: [32, 20, 76],
  tgt: [8, 30, 172],
});

const Q = DISTRICT_GRID.quadrants;
const CELL = DISTRICT_GRID.cell;
const ROAD = DISTRICT_GRID.road;
const O = DISTRICT_GRID.outer;

/* -------------------------------------------------------------------------- */
/*  Districts                                                                  */
/* -------------------------------------------------------------------------- */

export class Districts {
  /** @param {{root:THREE.Group, shared:object}} opts */
  constructor(opts) {
    this.root = opts.root;
    this.S = opts.shared;
    this.group = null;
    this._materials = [];
    this._textures = [];      // 【模块 4】入口牌 CanvasTexture 台账
    this._zones = {};
    this._lods = [];
    this._anchors = {};
    this._zoneDisposers = []; // 【M8/M9】新区内容模块（Castle/Farm）的自释放钩子
    this._zoneUpdates = {};   // 【阶段二】Farm 农活动画更新器
    this._time = 0;
    this._disposed = false;
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
    this._camDir = new THREE.Vector3();
  }

  _mat(color, opts = {}) {
    // MeshBasicMaterial 不计入 renderer.info.memory.geometries/textures。
    const m = new THREE.MeshBasicMaterial({ color, ...opts });
    this._materials.push(m);
    return m;
  }

  /** 【模块 4】入口牌纹理台账（dispose 成对释放） */
  _tex(t) {
    this._textures.push(t);
    return t;
  }

  build() {
    const group = new THREE.Group();
    group.name = 'Districts/root';
    group.userData.districtGrid = DISTRICT_GRID;
    this.group = group;
    this.root.add(group);

    this._buildStructure(group);
    for (const key of ['castle', 'farm']) this._buildZone(group, key);
    // 【阶段二·模块 4】三区入口立柱 + 双面 CanvasTexture 牌（动物园/城堡屋/农家宝）
    this._buildDistrictSigns(group);

    // 暴露给 M8/M9 与验收脚本（纯数据，无资源）
    group.userData.anchors = this._anchors;
    return this;
  }

  /* ---------------- 三区入口牌：双柱 + 双面 CanvasTexture 板 ----------------
   * 【阶段二·模块 4】用户点名三处入口要有立体牌子。每块牌 = 2 根共享方柱 +
   * 1 块板 + 1 张 512×256 CanvasTexture（双面同图，正看反看不镜像——
   * 双面同 UV 时背面文字天然镜像，故每块牌建正/背两片 Mesh 各自法线朝外，
   * 与大门「游乐园」招牌同款做法）。纹理/材质全部登记自清。 */
  _buildDistrictSigns(group) {
    const S = this.S;
    const postMat = this._mat(0x4a3320);
    const boardMat = this._mat(0x141c30);
    const signs = [
      { cn: '动物园', en: 'ZOO', hex: 0x8fd8ff, x: 34.5, z: 0, rotY: Math.PI / 2 },
      { cn: '城堡屋', en: 'CASTLE', hex: 0xe8a8d8, x: -7, z: 38, rotY: 0 },
      { cn: '农家宝', en: 'FARM', hex: 0x9fd86a, x: 60, z: 38, rotY: 0 },
    ];
    for (const s of signs) {
      const holder = new THREE.Group();
      holder.name = `Districts/sign-${s.en}`;
      holder.position.set(s.x, 0, s.z);
      holder.rotation.y = s.rotY;
      group.add(holder);
      // 双柱 + 横板（共享几何，MeshBasic 不计 GPU 台账，材质随 this._materials 释放）
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(S.geoBox, postMat);
        post.name = `Districts/sign-${s.en}/post`;
        post.position.set(side * 1.9, 2.35, 0);
        post.scale.set(0.26, 2.5, 0.26);
        holder.add(post);
      }
      const board = new THREE.Mesh(S.geoBox, boardMat);
      board.name = `Districts/sign-${s.en}/board`;
      board.position.set(0, 4.05, -0.05);
      board.scale.set(4.6, 1.7, 0.16);
      holder.add(board);
      // 文字面：一张 CanvasTexture，正/背两片各朝一侧（背面 rotY π 不镜像）
      const tex = this._tex(this._makeSignTexture(s.cn, s.en, s.hex));
      const faceMat = this._mat(0xffffff, {
        map: tex, transparent: true, alphaTest: 0.06, toneMapped: false,
      });
      for (const face of [1, -1]) {
        const plane = new THREE.Mesh(S.geoPlane, faceMat);
        plane.name = `Districts/sign-${s.en}/face-${face > 0 ? 'front' : 'back'}`;
        plane.position.set(0, 4.05, 0.05 * face);
        plane.scale.set(4.4, 1.55, 1);
        if (face < 0) plane.rotation.y = Math.PI;
        holder.add(plane);
      }
    }
  }

  /** 512×256 入口牌纹理：深底圆角 + 彩条 + 大字区名 + 小字英文（自清理） */
  _makeSignTexture(cn, en, hex) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const g = c.getContext('2d');
    const css = '#' + hex.toString(16).padStart(6, '0');
    g.fillStyle = 'rgba(8,18,34,0.94)';
    g.beginPath();
    if (g.roundRect) g.roundRect(8, 8, 496, 240, 26);
    else g.rect(8, 8, 496, 240);
    g.fill();
    g.strokeStyle = css;
    g.lineWidth = 10;
    g.stroke();
    g.fillStyle = css;
    g.fillRect(30, 34, 14, 188);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f4f9ff';
    g.font = 'bold 104px "Microsoft YaHei", "PingFang SC", sans-serif';
    g.fillText(cn, 276, 108);
    g.fillStyle = css;
    g.font = 'bold 44px "Segoe UI", Arial, sans-serif';
    g.fillText(en, 276, 196);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.name = `Districts/sign/${cn}`;
    return tex;
  }

  /* ---------------- 静态结构：单 InstancedMesh + instanceColor ----------------
   * 全部用共享 geoPlane（2 三角形/实例）平铺在 XZ 平面，而非 geoBox（12 面）。
   * 四宫格本就是平面布局，28 实例仅 56 面（box 版需 672 面）——这是俯瞰机位
   * 预算余量只剩不到 1000 面时能承担的唯一形态。地面抬到 y=1.12 压住最高 0.9m
   * 的草丘起伏，避免 z-fighting；描边略高 0.01。 */
  _buildStructure(group) {
    const S = this.S;
    const items = [];
    // add(cx, cz, sizeX, sizeZ, y, color)：矩形平铺，尺寸沿世界 X / Z
    const add = (x, z, sx, sz, y, color) => items.push({ x, z, sx, sz, y, color });
    const midX = (O.minX + O.maxX) / 2;
    const midZ = (O.minZ + O.maxZ) / 2;
    const span = O.size;
    const ax = ROAD.axisX;
    const az = ROAD.axisZ;
    const half = ROAD.width / 2;
    const lane = ROAD.lane;

    const roadC = 0x30353d;   // 沥青
    const markC = 0xf2f4e8;   // 象牙白标线
    const walkC = 0x9aa6b2;   // 人行道
    const greenC = 0x2f8f4e;

    // 13m 双向四车道 + 两侧 1.5m 人行道
    add(ax, midZ, ROAD.width, span, 1.12, roadC);
    add(midX, az, span, ROAD.width, 1.121, roadC);
    for (const s of [-1, 1]) {
      add(ax + s * (half + ROAD.walk / 2), midZ, ROAD.walk, span, 1.126, walkC);
      add(midX, az + s * (half + ROAD.walk / 2), span, ROAD.walk, 1.127, walkC);
    }

    // 车道边界：中央双黄线 + 两侧虚线分道线（3.25m 一条车道）
    for (const s of [-1, 1]) {
      add(ax + s * 0.09, midZ, 0.10, span, 1.13, 0xe8c14a);
      add(midX, az + s * 0.09, span, 0.10, 1.1301, 0xe8c14a);
    }
    for (const off of [-lane, lane]) {
      for (let z = O.minZ + 2; z < O.maxZ - 2; z += 8) {
        if (Math.abs(z - az) > 9) add(ax + off, z, 0.11, 4.2, 1.131, markC);
      }
      for (let x = O.minX + 2; x < O.maxX - 2; x += 8) {
        if (Math.abs(x - ax) > 9) add(x, az + off, 4.2, 0.11, 1.1311, markC);
      }
    }

    // 斑马线：四个路口臂各 6 条，避开中心 3m
    for (const side of [-1, 1]) {
      for (let i = -2.5; i <= 2.5; i += 1) {
        add(ax + i * 1.05, az + side * (half + 2.0), 0.62, 2.6, 1.132, markC);
        add(ax + side * (half + 2.0), az + i * 1.05, 2.6, 0.62, 1.1321, markC);
      }
    }

    // 绿化带（人行道外）
    for (const s of [-1, 1]) {
      add(ax + s * (half + ROAD.walk + 0.7), midZ, 1.4, span, 1.11, greenC);
      add(midX, az + s * (half + ROAD.walk + 0.7), span, 1.4, 1.111, greenC);
    }

    // 外框绿化带（正方形四边）
    const edgeC = 0x3a9a55;
    const edgeW = 1.6;
    add(midX, O.minZ, span, edgeW, 1.10, edgeC);
    add(midX, O.maxZ, span, edgeW, 1.10, edgeC);
    add(O.minX, midZ, edgeW, span, 1.10, edgeC);
    add(O.maxX, midZ, edgeW, span, 1.10, edgeC);

    // 北侧两格地面色块；不再铺内部白描边，避免白线横穿新路面。
    for (const key of ['castle', 'farm']) {
      const q = Q[key];
      add(q.cx, q.cz, CELL.w, CELL.h, 1.095, q.color);
    }

    // 单个 InstancedMesh：1 draw call。plane 绕 X 轴 -90° 平铺（法线朝 +Y）
    // 【阶段三】路面改 Standard + 程序化粗糙度：柏油/草地/标线不再是无光照纯色。
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughnessMap: this.S.texAsphaltRough,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.2,
      side: THREE.DoubleSide,
    }); // 由 instanceColor 上色
    this._materials.push(mat);
    const im = new THREE.InstancedMesh(S.geoPlane, mat, items.length);
    im.name = 'Districts/structure';
    im.frustumCulled = true;
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const d = this._dummy;
    const qFlat = this._flatQuat || (this._flatQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI / 2, 0, 0)));
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      d.position.set(it.x, it.y, it.z);
      d.quaternion.copy(qFlat);
      // plane 局部 X→世界 X，局部 Y→世界 Z（旋转 -90° 后）；scale.y 映射世界 Z 尺寸
      d.scale.set(it.sx, it.sz, 1);
      d.updateMatrix();
      im.setMatrixAt(i, d.matrix);
      this._color.setHex(it.color);
      im.setColorAt(i, this._color);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    group.add(im);
    this._structure = im;
    this._structureCount = items.length;
  }

  /* ---------------- 北侧新区：地面标识 + 区域级 LOD ---------------- */
  _buildZone(group, key) {
    const S = this.S;
    const q = Q[key];
    const zone = new THREE.Group();
    zone.name = `Districts/${key}`;
    zone.userData.quadrant = key;
    group.add(zone);
    this._zones[key] = zone;

    const detail = new THREE.Group();
    detail.name = `Districts/${key}/detail`;
    const silhouette = new THREE.Group();
    silhouette.name = `Districts/${key}/silhouette`;

    // 近景地标造型（M8 城堡 / M9 农家宝，均为正式内容）
    if (key === 'castle') {
      this._zoneDisposers.push(buildCastle(detail, S, Q.castle).dispose);
    } else {
      const farm = buildFarm(detail, S, Q.farm);
      this._zoneDisposers.push(farm.dispose);
      this._zoneUpdates.farm = farm.update;
      detail.userData.farmWorkers = farm.workers;
    }

    /* 【六项升级·阶段四】城堡区抬高地形：一块 42×42 的石质台地（顶 y=2.2），
     * 城堡 detail 整体抬到台地顶面，形成「依山而建」的层次。台地挂在 zone
     * （不在 LOD 内），因此 m8 的城堡隔离增量测量不受影响。 */
    if (key === 'castle') {
      const plateauH = 2.2;
      // 台地要承托 R=18 的外围塔，半边长取 23（46×46）；用 Standard 材质
      // 让台面随昼夜变暗，避免夜间纯色 MeshBasic 被 Bloom 抬成一块白盘。
      const plateauMat = new THREE.MeshStandardMaterial({
        color: 0xb7a6cf, roughness: 0.95, metalness: 0,
      });
      this._materials.push(plateauMat);
      const plateau = new THREE.Mesh(S.geoBox, plateauMat);
      plateau.name = 'Districts/castle/plateau';
      plateau.position.set(q.cx, plateauH / 2, q.cz);
      plateau.scale.set(46, plateauH, 46);
      plateau.frustumCulled = true;
      zone.add(plateau);
      detail.position.y = plateauH; // 城堡整体坐落台地顶面
      silhouette.position.y = plateauH;
    }

    // 远景剪影：1 个低模体块（视锥内时仅 12 面）
    const silMat = this._mat(key === 'castle' ? 0xd08fd0 : 0x8fbf5a);
    this._plainMesh(silhouette, `Districts/${key}/silhouette-mass`, S.geoBox, silMat,
      q.cx, 5, q.cz, 22, 10, 22);

    // 子对象用世界坐标建，再 rebase 到 LOD 局部坐标（LOD 位于区中心）
    this._rebase(detail, q.cx, q.cz);
    this._rebase(silhouette, q.cx, q.cz);

    const lod = new THREE.LOD();
    lod.name = `Districts/${key}/lod`;
    lod.position.set(q.cx, 0, q.cz);
    lod.addLevel(detail, 0);
    lod.addLevel(silhouette, DISTRICT_GRID.lodDistance);
    zone.add(lod);
    this._lods.push({ key, lod, detail, silhouette });
    this._anchors[key] = detail; // M8/M9 内容挂点
  }

  _plainMesh(parent, name, geo, mat, px, py, pz, sx, sy, sz) {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.position.set(px, py, pz);
    m.scale.set(sx, sy, sz);
    m.frustumCulled = true;
    parent.add(m);
    return m;
  }

  /** 把组内直接子对象的 x/z 减去区中心（转为 LOD 局部坐标） */
  _rebase(group, cx, cz) {
    for (const child of group.children) {
      child.position.x -= cx;
      child.position.z -= cz;
    }
  }

  /** M8/M9 内容挂点：返回某新区的 detail 组（局部坐标，原点=区中心） */
  getDetailAnchor(key) { return this._anchors[key] || null; }

  /** 当前相机所在宫格（供 HUD / 测试） */
  getActiveQuadrant(camera) {
    if (!camera) return null;
    const x = camera.position.x, z = camera.position.z;
    if (x < ROAD.axisX && z < ROAD.axisZ) return 'amusement';
    if (x >= ROAD.axisX && z < ROAD.axisZ) return 'zoo';
    if (x < ROAD.axisX && z >= ROAD.axisZ) return 'castle';
    return 'farm';
  }

  /**
   * 【阶段三】区域级“背向剔除”：LOD 的包围球很大，相机站在城堡/农场南侧
   * 背对它们时，球体仍会与视锥相交，导致背后 1.6 万面被渲染。每帧用
   * 相机朝向与区中心方向做一次点积，背向且距离 >15m 时整区隐藏；
   * 玩家转身后下一帧立即恢复。热路径零新建。
   */
  update(camera, dt = 0) {
    if (!camera) return;
    this._time += Math.min(0.1, Math.max(0, dt));
    camera.getWorldDirection(this._camDir);
    for (const z of this._lods) {
      const q = Q[z.key];
      const vx = q.cx - camera.position.x;
      const vz = q.cz - camera.position.z;
      const dist = Math.hypot(vx, vz);
      const dot = dist > 0.001 ? (vx * this._camDir.x + vz * this._camDir.z) / dist : 0;
      z.lod.visible = !(dist > 15 && dot < -0.15);
    }
    // 【阶段二】农活循环只在农家乐 detail 真正上屏时推进，背向时零成本。
    const farmLod = this._lods.find((z) => z.key === 'farm')?.lod;
    if (farmLod && farmLod.visible && farmLod.getCurrentLevel() === 0) {
      this._zoneUpdates.farm?.(this._time);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    // 【M8/M9】先释放新区内容模块的自有资源（合并几何 / 材质），再释放骨架
    for (const fn of this._zoneDisposers) { try { fn(); } catch (err) { console.error('[Districts] zone dispose 失败：', err); } }
    this._zoneDisposers.length = 0;
    if (this.group) {
      this.group.traverse((o) => {
        if (o.isInstancedMesh && typeof o.dispose === 'function') {
          try { o.dispose(); } catch (err) { console.error('[Districts] InstancedMesh dispose 失败：', err); }
        }
      });
      if (this.group.parent) this.group.parent.remove(this.group);
    }
    for (const m of this._materials) {
      try { m.dispose(); } catch (err) { console.error('[Districts] material dispose 失败：', err); }
    }
    this._materials.length = 0;
    for (const t of this._textures) {
      try { t.dispose(); } catch (err) { console.error('[Districts] texture dispose 失败：', err); }
    }
    this._textures.length = 0;
    this._lods.length = 0;
    this._zoneUpdates = {};
    this._zones = {};
    this._anchors = {};
    this.group = null;
  }
}

/** Lobby.init 入口（必须在 _ensureGeometryUpload() 之后调用） */
export function buildDistricts(opts) {
  return new Districts(opts).build();
}
