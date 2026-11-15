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
  center: Object.freeze({ x: 30, z: 30 }),
  outer: Object.freeze({ minX: -30, maxX: 90, minZ: -30, maxZ: 90, size: 120 }),
  cell: Object.freeze({ w: 58, h: 58, pitch: 60 }),
  road: Object.freeze({ width: 4, axisX: 30, axisZ: 30 }),
  quadrants: Object.freeze({
    amusement: Object.freeze({ cx: 0, cz: 0, color: 0x4f9d5d, cn: '游乐园区', en: 'AMUSEMENT', content: 'existing' }),
    zoo: Object.freeze({ cx: 60, cz: 0, color: 0x3f7fc4, cn: '动物园', en: 'ZOO', content: 'existing' }),
    castle: Object.freeze({ cx: 0, cz: 60, color: 0xe8a8d8, cn: '城堡园', en: 'CASTLE', content: 'placeholder' }),
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
    this._zones = {};
    this._lods = [];
    this._anchors = {};
    this._zoneDisposers = []; // 【M8/M9】新区内容模块（Castle/Farm）的自释放钩子
    this._disposed = false;
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
  }

  _mat(color, opts = {}) {
    // MeshBasicMaterial 不计入 renderer.info.memory.geometries/textures。
    const m = new THREE.MeshBasicMaterial({ color, ...opts });
    this._materials.push(m);
    return m;
  }

  build() {
    const group = new THREE.Group();
    group.name = 'Districts/root';
    group.userData.districtGrid = DISTRICT_GRID;
    this.group = group;
    this.root.add(group);

    this._buildStructure(group);
    for (const key of ['castle', 'farm']) this._buildZone(group, key);

    // 暴露给 M8/M9 与验收脚本（纯数据，无资源）
    group.userData.anchors = this._anchors;
    return this;
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
    const mid = DISTRICT_GRID.center.x; // 30
    const span = O.size;

    /* 【六项升级·阶段四】沥青路面：深灰偏黑的沥青色（原 0x596274 偏蓝灰），
     * 并在同一 InstancedMesh 内追加虚线车道标线（零新增 draw call）。 */
    const roadC = 0x30353d;   // 沥青
    const markC = 0xf2f4e8;   // 象牙白标线
    add(ROAD.axisX, mid, ROAD.width, span, 1.12, roadC);   // 南北纵路
    add(mid, ROAD.axisZ, span, ROAD.width, 1.121, roadC);  // 东西横路
    // 车道中心虚线：纵路 4 段 / 横路 4 段，避开十字路口，段长 9m 间隔 15m
    for (const sign of [-1, 1]) {
      for (let i = 0; i < 2; i += 1) {
        const off = 14 + i * 16;
        add(ROAD.axisX, mid + sign * off, 0.22, 9, 1.124, markC);      // 纵路（沿 z）
        add(mid + sign * off, ROAD.axisZ, 9, 0.22, 1.1241, markC);     // 横路（沿 x）
      }
    }

    // 绿化带（道路两侧各一条）
    const greenC = 0x2f8f4e;
    for (const s of [-1, 1]) {
      add(ROAD.axisX + s * (ROAD.width / 2 + 0.7), mid, 1.4, span, 1.11, greenC);
      add(mid, ROAD.axisZ + s * (ROAD.width / 2 + 0.7), span, 1.4, 1.111, greenC);
    }

    // 外框绿化带（正方形四边）
    const edgeC = 0x3a9a55;
    const edgeW = 1.6;
    add(mid, O.minZ, span, edgeW, 1.10, edgeC);
    add(mid, O.maxZ, span, edgeW, 1.10, edgeC);
    add(O.minX, mid, edgeW, span, 1.10, edgeC);
    add(O.maxX, mid, edgeW, span, 1.10, edgeC);

    // 四格描边 + 北侧两格地面色块（南侧保留既有地面）
    const rimC = 0xf2f6ff;
    for (const key of ['amusement', 'zoo', 'castle', 'farm']) {
      const q = Q[key];
      const w = CELL.w, h = CELL.h, t = 0.34, y = 1.13;
      add(q.cx, q.cz - h / 2, w, t, y, rimC);
      add(q.cx, q.cz + h / 2, w, t, y, rimC);
      add(q.cx - w / 2, q.cz, t, h, y, rimC);
      add(q.cx + w / 2, q.cz, t, h, y, rimC);
      if (key === 'castle' || key === 'farm') {
        add(q.cx, q.cz, CELL.w, CELL.h, 1.095, q.color);
      }
    }

    // 单个 InstancedMesh：1 draw call。plane 绕 X 轴 -90° 平铺（法线朝 +Y）
    const mat = this._mat(0xffffff, { side: THREE.DoubleSide }); // 由 instanceColor 上色
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
    if (key === 'castle') this._zoneDisposers.push(buildCastle(detail, S, Q.castle).dispose);
    else this._zoneDisposers.push(buildFarm(detail, S, Q.farm).dispose);

    /* 【六项升级·阶段四】城堡区抬高地形：一块 42×42 的石质台地（顶 y=2.2），
     * 城堡 detail 整体抬到台地顶面，形成「依山而建」的层次。台地挂在 zone
     * （不在 LOD 内），因此 m8 的城堡隔离增量测量不受影响。 */
    if (key === 'castle') {
      const plateauH = 2.2;
      const plateauMat = this._mat(0xd8c9e6, { side: THREE.DoubleSide });
      const plateau = new THREE.Mesh(S.geoBox, plateauMat);
      plateau.name = 'Districts/castle/plateau';
      plateau.position.set(q.cx, plateauH / 2, q.cz);
      // 台地仅覆盖 R=14 塔环（30×30）；不放大包围球，保证 redline 机位
      // 相机背对北侧时能被正确视锥剔除（新区增量 ≤3 calls 的硬约束）。
      plateau.scale.set(30, plateauH, 30);
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

  /** renderer 每帧自动 update TH.LOD；此处仅为钩子，热路径零新建 */
  update() {}

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
    this._lods.length = 0;
    this._zones = {};
    this._anchors = {};
    this.group = null;
  }
}

/** Lobby.init 入口（必须在 _ensureGeometryUpload() 之后调用） */
export function buildDistricts(opts) {
  return new Districts(opts).build();
}
