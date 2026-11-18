/**
 * ============================================================================
 * Villa —— 可进入的现代简约别墅（玩家自己的家）
 * ============================================================================
 * 玩法：玩家以第一人称从大厅触发环进入，立刻站在别墅 1F 门厅。四层空间——
 *   B1 地下车库（轿车 + SUV + 工具墙）、1F 玄关客厅客卧卫浴、2F 起居层
 *   （客厅 / 餐厨 / 次卧 / 阳台）、3F 主卧层（主卧套间 / 衣帽间 / 书房 / 屋顶阳台）。
 *   楼梯三层可真实步行（高度由 z 坐标决定），电梯按 B1/1/2/3 按钮真实升降、
 *   玩家站立随行；家具齐全（床/沙发/电视/餐桌椅/橱柜/冰箱/书桌/衣柜/卫浴…），
 *   扫地机器人沿路径巡游并回基站，电视程序化动态画面。
 *
 * 【单文件闭环】场景 / 家具 / 电梯状态机 / UI / 资源清理全部在本类内；
 *   不 import、不修改 core/ 任何基座模块（与 DanceHall / MemoryMatch 同约定）。
 *
 * 【IAttraction 契约】init(ctx)/update(dt)/onInteract(hitInfo)/dispose() 四方法齐全；
 *   dispose() 幂等；root 挂 ctx.scene；全程不用 Rapier（车是静态展示模型）。
 *
 * ---------------------------------------------------------------------------
 * 【多层高度】WASDController.getGroundHeight(x,z) 是纯平面函数，无法表达
 *   电梯井（同一 x/z 不同时刻不同高度）。本类用【高度状态机】统一解：
 *   _groundAt(x,z) 内部读 this._level / this._elevator 状态——
 *     · 电梯井区域 → 返回轿厢地板高度 this._elevatorY；
 *     · 楼梯区域   → 按该段楼梯的 z 进度线性插值楼层高度；
 *     · 其余区域   → 返回当前楼层基准高度。
 *   楼梯段的 x/z 区域互不重叠，故同一坐标不会歧义；电梯运行时 isEnabled 关闭
 *   水平移动，避免走出轿厢。楼层切换由 update 中 _syncLevel() 按相机 y 推断。
 *
 * 【热基线】init 一次性建完全部 geometry/material/texture，update 只改属性
 *   （电梯位置 / 机器人矩阵 / 电视贴图内容），绝不惰性新建 GPU 资源 →
 *   多轮「大厅→别墅→大厅」Δgeo=Δtex=0。
 *
 * 【省 draw call】静态几何（墙/地板/家具）按材质用 mergeGeometries 合并成少数
 *   Mesh；动态物体（电梯轿厢/机器人/电视屏）独立，因它们每帧变形或移动。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { IAttraction } from './i-attraction.js';
import { WASDController } from '../../utils/controls/wasd-controller.js';

/* ========================================================================== */
/* 尺寸与坐标（本地坐标，别墅中心为原点；整体作为独立场景，不叠在大厅上）       */
/* ========================================================================== */

/** 房屋占地与层高：x∈[-10,10]，z∈[-8,8]，层高 3.6m */
const HOUSE = Object.freeze({ W: 20, D: 16, H: 3.6, WALL: 0.28 });
/** 四层地板基准 y（脚下高度）：B1, 1F, 2F, 3F */
const LEVELS = Object.freeze([-3.6, 0, 3.6, 7.2]);
const LEVEL_NAMES = Object.freeze(['B1', '1F', '2F', '3F']);
/** 电梯井：东北角，x∈[6.4,9.0] z∈[-6.8,-4.2]，贯通四层 */
const SHAFT = Object.freeze({ x0: 6.4, x1: 9.0, z0: -6.8, z1: -4.2 });
/**
 * 楼梯：西南角 x∈[-8.8,-6.6]。三段楼梯在 z 上互不重叠，每段连接相邻两层：
 *   段0 B1↔1F、段1 1F↔2F、段2 2F↔3F。
 * 同 x/z 不同层的歧义由 _level 状态消解：_groundAt 只采用“服务当前层”的那段。
 */
const STAIRS = Object.freeze([
  { k: 0, x0: -8.8, x1: -6.6, z0: -6.6, z1: -2.6 }, // B1(-3.6) ↔ 1F(0)
  { k: 1, x0: -8.8, x1: -6.6, z0: -2.0, z1: 2.0 },  // 1F(0) ↔ 2F(3.6)
  { k: 2, x0: -8.8, x1: -6.6, z0: 2.6, z1: 6.6 },   // 2F(3.6) ↔ 3F(7.2)
]);
/** 出生点：1F 门厅，面向 -z（屋内纵深） */
const SPAWN = Object.freeze({ x: 0, y: 0, z: 6.2, yaw: 0 });

/** 现代简约配色（sRGB hex） */
const C = Object.freeze({
  wall: 0xeae7e0, wallAccent: 0xd8d3c8, floor: 0xc9a87c, floorDark: 0x8a6f4e,
  ceiling: 0xf4f2ec, trim: 0x2f3338, glass: 0x9fc4cf, metal: 0x9aa3ab,
  fabric: 0x6b7681, fabricLight: 0xb9c0c6, wood: 0x9c7549, woodDark: 0x5d4530,
  skin: 0xe8bd94, black: 0x1e2226, white: 0xf4f4f0, green: 0x5b8a4a,
  warm: 0xffd9a0, screen: 0x142028, red: 0xb8503f, blue: 0x3d6a86,
});

const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Villa extends IAttraction {
  constructor() {
    super();
    this.root = new THREE.Group();
    this.root.name = 'Villa/root';
    this._disposed = false;
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._listeners = [];
    this._walkBoxes = [];
    this._furnitureBoxes = [[], [], [], []]; // 分层家具/隔断碰撞盒（构造函数即初始化，供 _buildStructure 用）
    this._staticGroups = new Map();  // 材质名 -> geometry[]（合并前）
    this._level = 1;                 // 当前楼层索引（1=1F 出生）
    this._elevatorY = 0;             // 轿厢地板当前高度
    this._time = 0;
    this._dummy = new THREE.Object3D();
    this._tmpColor = new THREE.Color();
  }

  /* ---------- 台账工具 ---------- */
  _geo(g) { this._geometries.add(g); return g; }
  _mat(m) { this._materials.add(m); return m; }
  _tex(t) { this._textures.add(t); return t; }

  /** 把一个盒状静态几何登记到指定材质桶（稍后合并），顶点直接落在世界本地坐标 */
  _box(bucket, w, h, d, x, y, z, color, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    if (color != null) {
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      this._tmpColor.setHex(color);
      for (let i = 0; i < n; i += 1) {
        col[i * 3] = this._tmpColor.r; col[i * 3 + 1] = this._tmpColor.g; col[i * 3 + 2] = this._tmpColor.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (!this._staticGroups.has(bucket)) this._staticGroups.set(bucket, []);
    this._staticGroups.get(bucket).push(g);
    return g;
  }

  /** 圆柱静态几何登记到桶 */
  _cyl(bucket, rt, rb, h, seg, x, y, z, color) {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    g.translate(x, y, z);
    if (color != null) {
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      this._tmpColor.setHex(color);
      for (let i = 0; i < n; i += 1) {
        col[i * 3] = this._tmpColor.r; col[i * 3 + 1] = this._tmpColor.g; col[i * 3 + 2] = this._tmpColor.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (!this._staticGroups.has(bucket)) this._staticGroups.set(bucket, []);
    this._staticGroups.get(bucket).push(g);
    return g;
  }

  /** 2D 碰撞盒（WASDController 口径：minX/maxX/minZ/maxZ） */
  _block(x0, x1, z0, z1) { this._walkBoxes.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 }); }

  /* ======================================================================== */
  /* init                                                                      */
  /* ======================================================================== */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera, renderer } = ctx;
    if (!scene || !camera) throw new Error('[Villa] 缺少 scene / camera');
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    // 保存并接管相机（出生在 1F 门厅）
    this._cameraSaved = {
      position: camera.position.clone(), quaternion: camera.quaternion.clone(),
      rotationOrder: camera.rotation.order, fov: camera.fov,
    };
    camera.position.set(SPAWN.x, SPAWN.y + 1.6, SPAWN.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(0, SPAWN.yaw, 0);
    camera.updateMatrixWorld(true);
    this._level = 1;
    this._elevatorY = LEVELS[1];

    scene.add(this.root);

    // 建全部静态几何（分类到桶）→ 合并成少数 Mesh
    this._buildStructure();
    this._buildFurniture();
    this._mergeStatics(register);

    // 动态物体（每帧变形/移动）
    this._buildElevator(register);
    this._buildRobot(register);
    this._buildTV(register);

    // 灯光
    this._buildLights();

    // WASD 漫游：高度由状态机给出，碰撞按当前层过滤
    this._wasd = new WASDController({
      camera,
      domElement: renderer?.domElement || null,
      getObstacles: () => this._walkBoxesByLevel(),
      getGroundHeight: (x, z) => this._groundAt(x, z),
      isEnabled: () => !this._disposed && !this._elevator.active,
    });
    this._wasd.resetFromCamera(camera);
    this._wasd.attach();

    this._buildUI();

    for (const g of this._geometries) register(g);
    for (const m of this._materials) register(m);
    for (const t of this._textures) register(t);

    console.info(
      `[Villa] init 完成 | 层=4 家具件=${this._furnitureCount || 0} | ` +
      `geo=${this._geometries.size} mat=${this._materials.size} tex=${this._textures.size} | 静态桶=${this._staticGroups.size}`,
    );
  }

  /** 合并每个材质桶为一个 Mesh，顶点色驱动，省 draw call */
  _mergeStatics(register) {
    for (const [name, geos] of this._staticGroups) {
      if (!geos.length) continue;
      // 归一化顶点属性：mergeGeometries 要求所有源几何属性集一致。
      // 少数几何体（楼梯侧梁/车轮/井壁）没写 color，这里统一补白色，
      // 否则 merge 返回 null（实测踩坑）。所有几何都带 position/normal/uv/color。
      for (const g of geos) {
        if (!g.attributes.color) {
          const n = g.attributes.position.count;
          const col = new Float32Array(n * 3).fill(1);
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        }
      }
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) throw new Error(`[Villa] 材质桶 ${name} 合并失败（属性不一致）`);
      this._geo(merged);
      const useVertexColor = Boolean(merged.attributes.color);
      let mat;
      if (name === 'emissive') {
        mat = new THREE.MeshBasicMaterial({ vertexColors: useVertexColor, toneMapped: false });
      } else if (name === 'glass') {
        mat = new THREE.MeshStandardMaterial({
          vertexColors: useVertexColor, color: useVertexColor ? 0xffffff : C.glass,
          roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
        });
      } else if (name === 'metal') {
        mat = new THREE.MeshStandardMaterial({
          vertexColors: useVertexColor, color: useVertexColor ? 0xffffff : C.metal,
          roughness: 0.3, metalness: 0.65,
        });
      } else {
        const rough = name === 'floor' ? 0.62 : name === 'fabric' ? 0.92 : 0.85;
        mat = new THREE.MeshStandardMaterial({
          vertexColors: useVertexColor, color: useVertexColor ? 0xffffff : C.wall,
          roughness: rough, metalness: 0.02,
        });
      }
      this._mat(mat);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `Villa/static-${name}`;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    // 源几何合并后释放（从未上传 GPU，dispose 只是标记）
    for (const geos of this._staticGroups.values()) {
      for (const g of geos) g.dispose();
    }
    this._staticGroups.clear();
  }

  /* ======================================================================== */
  /* 建筑骨架：四层楼板 / 外墙 / 门洞 / 楼梯 / 电梯井                          */
  /* ======================================================================== */
  _buildStructure() {
    const H = HOUSE.H, W = HOUSE.W, D = HOUSE.D, T = HOUSE.WALL;
    const halfW = W / 2, halfD = D / 2;

    // 四层楼板 + 天花板。天花板单独建（castShadow 挡掉基座平行光直射，
    // 否则室内被太阳照成一片白——DanceHall 同款踩坑）。
    const ceilGeo = this._geo(new THREE.BoxGeometry(W, 0.2, D));
    const ceilMat = this._mat(new THREE.MeshStandardMaterial({ color: C.ceiling, roughness: 0.9 }));
    for (let i = 0; i < 4; i += 1) {
      const y = LEVELS[i];
      this._box('floor', W, 0.24, D, 0, y - 0.12, 0, i === 0 ? C.floorDark : C.floor);
      const lid = new THREE.Mesh(ceilGeo, ceilMat);
      lid.position.set(0, y + H - 0.1, 0);
      lid.castShadow = true;
      lid.receiveShadow = true;
      this.root.add(lid);
      // 地板踢脚线（沿四边）
      this._box('trim', W, 0.1, 0.06, 0, y + 0.05, -halfD + 0.1, C.trim);
      this._box('trim', W, 0.1, 0.06, 0, y + 0.05, halfD - 0.1, C.trim);
    }

    // 外墙：逐层四面墙，留门洞/窗洞。用分段盒拼出开口。
    for (let i = 0; i < 4; i += 1) {
      const y0 = LEVELS[i];
      const wallH = H - 0.24;
      const cy = y0 + wallH / 2 + 0.12;
      const wallColor = i === 0 ? C.wallAccent : C.wall;
      // 南墙（z=+halfD）：1F 中间留入户门洞；其余层留阳台门（2F/3F）
      this._wallWithOpening('plain', -halfW, halfW, cy, wallH, halfD,
        i === 1 ? [-1.4, 1.4] : (i >= 2 ? [-1.6, 1.6] : []), wallColor, 'z');
      // 北墙（z=-halfD）：留窄窗
      this._wallWithOpening('plain', -halfW, halfW, cy, wallH, -halfD,
        i === 0 ? [] : [-2.2, 2.2], wallColor, 'z', true);
      // 东/西墙
      this._wallWithOpening('plain', -halfD, halfD, cy, wallH, -halfW, [], wallColor, 'x');
      this._wallWithOpening('plain', -halfD, halfD, cy, wallH, halfW, [], wallColor, 'x');
    }

    // 电梯井四壁（贯通 B1..3F，顶部留空），井壁作为碰撞
    this._buildShaftWalls();
    // 楼梯（三段，逐级台阶 + 侧梁 + 扶手）
    this._buildStairs();
    // 室内隔墙（分层）
    this._buildInteriorWalls();

    // 外墙碰撞：四周（整栋范围），避免走出屋外
    this._block(-halfW - 1, -halfW + T, -halfD, halfD);
    this._block(halfW - T, halfW + 1, -halfD, halfD);
    this._block(-halfW, halfW, -halfD - 1, -halfD + T);
    this._block(-halfW, halfW, halfD - T, halfD + 1);
  }

  /** 一面墙，中间可用 opening=[x0,x1] 开洞；axis='z' 墙沿 x 展开，='x' 沿 z 展开 */
  _wallWithOpening(bucket, a0, a1, cy, h, fixed, opening, color, axis, windowMode = false) {
    const T = HOUSE.WALL;
    const put = (lo, hi, y, hh) => {
      if (hi - lo < 0.02) return;
      if (axis === 'z') this._box(bucket, hi - lo, hh, T, (lo + hi) / 2, y, fixed, color);
      else this._box(bucket, T, hh, hi - lo, fixed, y, (lo + hi) / 2, color);
    };
    if (!opening || opening.length !== 2) { put(a0, a1, cy, h); return; }
    const [o0, o1] = opening;
    // 洞两侧
    put(a0, o0, cy, h);
    put(o1, a1, cy, h);
    // 洞上过梁
    const doorH = windowMode ? 1.5 : 2.6;
    const lintelY = cy - h / 2 + doorH + (h - doorH) / 2;
    put(o0, o1, lintelY, h - doorH);
    // 窗台（窗模式，洞下部补墙到 0.9m）
    if (windowMode) {
      const sillY = cy - h / 2 + 0.45;
      put(o0, o1, sillY, 0.9);
      // 玻璃
      if (axis === 'z') this._box('glass', o1 - o0, doorH - 0.9, 0.05, (o0 + o1) / 2, cy - h / 2 + 0.9 + (doorH - 0.9) / 2, fixed, C.glass);
      else this._box('glass', 0.05, doorH - 0.9, o1 - o0, fixed, cy - h / 2 + 0.9 + (doorH - 0.9) / 2, (o0 + o1) / 2, C.glass);
    }
  }

  _buildShaftWalls() {
    const { x0, x1, z0, z1 } = SHAFT;
    const y0 = LEVELS[0], top = LEVELS[3] + HOUSE.H;
    const h = top - y0, cy = y0 + h / 2, T = 0.18;
    this._box('plain', T, h, z1 - z0, x0, cy, (z0 + z1) / 2, C.wallAccent);
    this._box('plain', T, h, z1 - z0, x1, cy, (z0 + z1) / 2, C.wallAccent);
    this._box('plain', x1 - x0, h, T, (x0 + x1) / 2, cy, z0, C.wallAccent);
    // 井口南侧每层留门（不封死），用短墙+过梁
    this._box('plain', x1 - x0, h - 2.4, T, (x0 + x1) / 2, y0 + 2.4 + (h - 2.4) / 2, z1, C.wallAccent);
    // 电梯井门框碰撞：只挡井壁三面（南侧门可进）
    this._block(x0 - 0.2, x0 + 0.2, z0, z1);
    this._block(x1 - 0.2, x1 + 0.2, z0, z1);
    this._block(x0, x1, z0 - 0.2, z0 + 0.2);
  }

  _buildStairs() {
    const steps = 12;
    for (const s of STAIRS) {
      const { x0, x1, z0, z1, k } = s;
      const spanZ = z1 - z0;
      const yLow = LEVELS[k], yHigh = LEVELS[k + 1];
      // 台阶：从低层端 z0 到高层端 z1，高度线性升高 3.6m
      for (let i = 0; i < steps; i += 1) {
        const t = (i + 0.5) / steps;
        const y = yLow + t * (yHigh - yLow);
        const z = z0 + t * spanZ;
        this._box('floor', x1 - x0, 0.14, spanZ / steps + 0.02, (x0 + x1) / 2, y, z, C.woodDark);
      }
      // 侧梁
      const slope = Math.atan2(yHigh - yLow, spanZ);
      const len = Math.hypot(spanZ, yHigh - yLow);
      for (const x of [x0, x1]) {
        const g = new THREE.BoxGeometry(0.09, 0.09, len);
        g.rotateX(-slope);
        g.translate(x, (yLow + yHigh) / 2 + 0.9, (z0 + z1) / 2);
        if (!this._staticGroups.has('metal')) this._staticGroups.set('metal', []);
        this._staticGroups.get('metal').push(g);
      }
      // 楼梯两侧挡住（防侧向掉落），通道中间不挡
      this._block(x0 - 0.3, x0 + 0.05, z0, z1);
      this._block(x1 - 0.05, x1 + 0.3, z0, z1);
    }
  }

  _buildInteriorWalls() {
    // 分层内墙：用低矮隔断（1.2m）划分功能区，不挡视线也提供碰撞
    const partitions = [
      // [level, x0,x1, z0,z1]
      // 注意：楼梯通道 x∈[-8.8,-6.6] 全 z 段贯通，任何隔断不得横跨该 x 区间
      [1, -6.3, -5.5, 1.5, 1.8],  // 1F 客卧隔断（让出楼梯通道）
      [1, 4.5, 10, 1.5, 1.8],     // 1F 卫浴隔断
      [2, -6.3, -4.5, -1.0, -0.7],// 2F 厨房隔断（让出楼梯通道）
      [2, 3.0, 10, -1.0, -0.7],   // 2F 餐厨隔断
      [3, -6.3, -5.0, 2.0, 2.3],  // 3F 衣帽间隔断（让出楼梯通道）
      [3, 3.5, 10, 2.0, 2.3],     // 3F 书房隔断
    ];
    for (const [lv, x0, x1, z0, z1] of partitions) {
      const y = LEVELS[lv];
      this._box('plain', x1 - x0, 1.2, z1 - z0, (x0 + x1) / 2, y + 0.6, (z0 + z1) / 2, C.wallAccent);
      // 隔断只在本层生效（分层碰撞）：否则 2F 隔断会挡住 1F 楼梯通道（实测踩坑）
      this._fb(lv, x0, x1, z0, z1);
    }
  }

  /* ======================================================================== */
  /* 家具：现代简约，按层布置（全部静态几何，进桶合并）                        */
  /* ======================================================================== */
  _buildFurniture() {
    this._furnitureCount = 0;
    // 分层家具碰撞盒已在构造函数初始化（_buildStructure 的隔断也写入其中）
    this._furnishB1();
    this._furnish1F();
    this._furnish2F();
    this._furnish3F();
  }
  _f() { this._furnitureCount += 1; }
  /** 在指定层登记一个家具碰撞盒 */
  _fb(level, x0, x1, z0, z1) { this._furnitureBoxes[level].push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 }); }

  /** 通用家具构件（相对某层地板 y） */
  _sofa(y, cx, cz, ry = 0, color = C.fabric) {
    const rot = (dx, dz) => ({ x: cx + dx * Math.cos(ry) + dz * Math.sin(ry), z: cz - dx * Math.sin(ry) + dz * Math.cos(ry) });
    const p = rot(0, 0);
    this._box('fabric', 2.6, 0.42, 1.0, p.x, y + 0.32, p.z, color, ry); this._f();
    const b = rot(0, -0.42);
    this._box('fabric', 2.6, 0.75, 0.22, b.x, y + 0.72, b.z, color, ry); this._f();
    for (const s of [-1, 1]) {
      const a = rot(s * 1.28, 0);
      this._box('fabric', 0.22, 0.5, 1.0, a.x, y + 0.55, a.z, color, ry); this._f();
    }
  }
  _table(y, cx, cz, w = 1.4, d = 0.8, h = 0.75, color = C.wood) {
    this._box('plain', w, 0.1, d, cx, y + h, cz, color); this._f();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this._box('metal', 0.07, h, 0.07, cx + sx * (w / 2 - 0.12), y + h / 2, cz + sz * (d / 2 - 0.12), C.trim);
    }
  }
  _chair(y, cx, cz, ry = 0) {
    this._box('plain', 0.5, 0.08, 0.5, cx, y + 0.45, cz, C.wood, ry); this._f();
    this._box('plain', 0.5, 0.55, 0.08, cx, y + 0.75, cz - 0.21, C.wood, ry); this._f();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this._box('metal', 0.05, 0.45, 0.05, cx + sx * 0.2, y + 0.22, cz + sz * 0.2, C.trim);
    }
  }
  _bed(y, cx, cz, w = 1.8, d = 2.1) {
    this._box('plain', w, 0.4, d, cx, y + 0.25, cz, C.woodDark); this._f();
    this._box('fabric', w - 0.1, 0.22, d - 0.1, cx, y + 0.55, cz, C.white); this._f();
    this._box('fabric', w - 0.2, 0.12, 0.5, cx, y + 0.7, cz - d / 2 + 0.35, C.fabricLight); this._f(); // 枕头
    this._box('plain', w + 0.2, 0.9, 0.12, cx, y + 0.7, cz - d / 2, C.woodDark); this._f(); // 床头板
  }
  _cabinet(y, cx, cz, w = 1.6, h = 2.1, d = 0.55) {
    this._box('plain', w, h, d, cx, y + h / 2, cz, C.woodDark); this._f();
    for (let i = 1; i < 4; i += 1) this._box('metal', w, 0.02, 0.01, cx, y + (h / 4) * i, cz + d / 2 + 0.01, C.trim);
    this._box('metal', 0.03, 0.24, 0.03, cx - 0.15, y + h / 2, cz + d / 2 + 0.02, C.metal);
  }
  _plant(y, cx, cz, scale = 1) {
    this._cyl('plain', 0.22 * scale, 0.16 * scale, 0.36 * scale, 8, cx, y + 0.18 * scale, cz, C.woodDark); this._f();
    this._cyl('fabric', 0.02 * scale, 0.03 * scale, 0.5 * scale, 6, cx, y + 0.55 * scale, cz, C.green);
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      this._box('fabric', 0.34 * scale, 0.04 * scale, 0.14 * scale,
        cx + Math.cos(a) * 0.18 * scale, y + (0.72 + (i % 2) * 0.12) * scale, cz + Math.sin(a) * 0.18 * scale, C.green, a);
    }
  }
  _lamp(y, cx, cz) {
    this._cyl('metal', 0.03, 0.03, 1.5, 8, cx, y + 0.75, cz, C.trim); this._f();
    this._cyl('emissive', 0.22, 0.3, 0.28, 10, cx, y + 1.55, cz, C.warm); this._f();
  }

  /** B1 车库：两辆车 + 工具墙 + 储物架 */
  _furnishB1() {
    const y = LEVELS[0];
    // 地面车位线
    for (const x of [-4.5, 3.0]) {
      this._box('emissive', 2.6, 0.02, 0.08, x, y + 0.02, -1.2, 0xddddcc);
      this._box('emissive', 2.6, 0.02, 0.08, x, y + 0.02, 2.2, 0xddddcc);
    }
    this._staticCar(y, -4.5, 0.5, 0x3d6a86, 'sedan');
    this._staticCar(y, 3.0, 0.5, 0x8a3f3f, 'suv');
    // 工具墙 + 储物架（西墙）
    for (let i = 0; i < 3; i += 1) this._box('metal', 0.4, 0.06, 3, -9.4, y + 0.6 + i * 0.7, -3, C.metal);
    for (const z of [-4.4, -1.6]) this._box('plain', 0.5, 2.1, 0.08, -9.4, y + 1.05, z, C.woodDark);
    this._f();
    // 车库灯
    this._box('emissive', 1.2, 0.06, 0.3, 0, y + HOUSE.H - 0.3, -2, C.warm);
  }

  /** 静态展示车（复用盒/柱几何，不加载 Rapier）：轿车 / SUV 两种比例 */
  _staticCar(y, cx, cz, color, kind) {
    const suv = kind === 'suv';
    const bodyH = suv ? 0.85 : 0.62, bodyW = 1.9, bodyL = suv ? 4.4 : 4.2;
    this._box('metal', bodyW, bodyH, bodyL, cx, y + 0.55 + bodyH / 2, cz, color); this._f();
    // 座舱（略窄，深色玻璃）
    this._box('glass', bodyW - 0.24, suv ? 0.85 : 0.62, bodyL * 0.46,
      cx, y + 0.55 + bodyH + (suv ? 0.4 : 0.3), cz - 0.15, C.glass); this._f();
    // 四轮（圆柱躺倒）
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const g = new THREE.CylinderGeometry(suv ? 0.42 : 0.36, suv ? 0.42 : 0.36, 0.22, 12);
      g.rotateZ(Math.PI / 2);
      g.translate(cx + sx * (bodyW / 2 - 0.05), y + (suv ? 0.42 : 0.36), cz + sz * (bodyL / 2 - 0.75));
      if (!this._staticGroups.has('black')) this._staticGroups.set('black', []);
      this._staticGroups.get('black').push(g);
    }
    // 前后灯
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      this._box('emissive', 0.28, 0.14, 0.06, cx + sx * 0.62, y + 0.95, cz + sz * (bodyL / 2 + 0.02), sz < 0 ? 0xfff3d0 : 0xc8322a);
    }
    // 碰撞盒（车库车只在 B1 挡住）
    this._fb(0, cx - bodyW / 2, cx + bodyW / 2, cz - bodyL / 2, cz + bodyL / 2);
  }

  /** 1F 玄关层 */
  _furnish1F() {
    const y = LEVELS[1];
    // 玄关鞋柜 + 玄关桌
    this._box('plain', 2.2, 0.9, 0.5, -3.5, y + 0.45, 7.2, C.wood); this._f();
    this._table(y, 3.5, 7.0, 1.6, 0.45, 0.8, C.wood);
    // 客厅：沙发 + 茶几 + 电视柜（电视屏是动态物体，单独建）
    this._sofa(y, -2.5, 2.5, 0);
    this._table(y, -2.5, 0.3, 1.5, 0.9, 0.42, C.woodDark);
    this._box('plain', 2.8, 0.5, 0.45, -2.5, y + 0.3, -2.6, C.woodDark); this._f();
    // 地毯
    this._box('fabric', 4.2, 0.03, 3.0, -2.5, y + 0.02, 0.8, C.fabricLight);
    // 客卧（西北角）
    this._bed(y, -7.8, 4.2, 1.5, 2.0);
    this._cabinet(y, -9.2, 2.2, 1.2, 1.9, 0.5);
    this._table(y, -6.2, 4.2, 0.9, 0.5, 0.55, C.wood); // 床头柜
    // 卫浴（东北角）：洗手台 + 马桶 + 淋浴隔断
    this._box('white', 1.4, 0.85, 0.55, 7.2, y + 0.55, 5.8, C.white); this._f();
    this._box('glass', 1.5, 2.0, 0.06, 7.2, y + 1.2, 5.4, C.glass);
    this._cyl('white', 0.32, 0.34, 0.5, 12, 8.6, y + 0.25, 6.0, C.white); this._f();
    // 扫地机器人基站（客厅角落）
    this._box('black', 0.7, 0.5, 0.7, -8.6, y + 0.25, -4.8, C.black); this._f();
    this._box('emissive', 0.4, 0.02, 0.4, -8.6, y + 0.51, -4.8, 0x66ccaa);
    // 立式灯 + 盆栽
    this._lamp(y, 0.5, 4.5);
    this._plant(y, 4.0, 6.2, 1.1);
    this._plant(y, -4.5, 5.5, 0.8);
    // 1F 家具碰撞（分层）
    this._fb(1, -3.8, -1.2, 2.0, 3.1);   // 沙发
    this._fb(1, -3.3, -1.7, -0.2, 0.8);  // 茶几
    this._fb(1, -8.6, -7.0, 3.2, 5.2);   // 客卧床
    this._fb(1, -9.9, -8.6, 1.9, 2.5);   // 客卧衣柜
    this._fb(1, 6.4, 8.0, 5.4, 6.2);     // 卫浴洗手台
    this._fb(1, -4.7, -2.3, 7.0, 7.5);   // 鞋柜
  }

  /** 2F 起居层 */
  _furnish2F() {
    const y = LEVELS[2];
    // 客厅（南向阳台门旁）：L 型沙发 + 茶几 + 电视柜（电视动态）
    this._sofa(y, -3.0, 3.5, 0, C.fabricLight);
    this._sofa(y, -5.5, 1.0, Math.PI / 2, C.fabricLight);
    this._table(y, -3.0, 1.2, 1.6, 1.0, 0.42, C.woodDark);
    this._box('plain', 3.0, 0.5, 0.45, -3.0, y + 0.3, -2.4, C.woodDark); this._f();
    this._box('fabric', 5.0, 0.03, 4.0, -3.0, y + 0.02, 1.0, C.fabricLight); // 地毯
    // 餐厅：餐桌 + 4 椅
    this._table(y, 5.5, -1.0, 2.4, 1.1, 0.76, C.wood);
    for (const [dx, dz, ry] of [[-0.9, -0.9, 0], [0.9, -0.9, 0], [-0.9, 0.9, Math.PI], [0.9, 0.9, Math.PI]]) {
      this._chair(y, 5.5 + dx, -1.0 + dz, ry);
    }
    // 厨房：橱柜 + 台面 + 冰箱 + 水槽
    this._box('plain', 5.0, 0.9, 0.6, -7.0, y + 0.45, -5.6, C.woodDark); this._f();
    this._box('metal', 5.0, 0.06, 0.65, -7.0, y + 0.93, -5.6, C.metal);
    this._box('metal', 1.0, 2.0, 0.7, -3.6, y + 1.0, -5.5, C.metal); this._f(); // 冰箱
    this._box('white', 0.7, 0.18, 0.5, -5.2, y + 1.0, -5.5, C.white); // 水槽
    // 次卧（东北）
    this._bed(y, 7.2, 4.5, 1.5, 2.0);
    this._cabinet(y, 9.0, 2.5, 1.0, 1.9, 0.5);
    // 阳台家具（南墙外挑平台，在屋内 z=7.2 一侧摆桌椅）
    this._table(y, 2.5, 6.4, 1.0, 0.6, 0.7, C.wood);
    this._chair(y, 2.5, 5.5, 0);
    this._plant(y, 5.5, 6.5, 1.0);
    this._lamp(y, -6.0, 4.0);
    // 2F 家具碰撞（分层）
    this._fb(2, -4.4, -1.6, 3.0, 4.1);   // 客厅沙发
    this._fb(2, -3.8, -2.2, 0.7, 1.7);   // 茶几
    this._fb(2, 4.2, 6.8, -1.6, -0.4);   // 餐桌
    this._fb(2, -9.5, -4.5, -5.9, -5.3); // 厨房橱柜
    this._fb(2, -4.1, -3.1, -5.9, -5.1); // 冰箱
    this._fb(2, 6.4, 8.0, 3.5, 5.5);     // 次卧床
  }

  /** 3F 主卧层 */
  _furnish3F() {
    const y = LEVELS[3];
    // 主卧套间：大床 + 双床头柜 + 床尾凳
    this._bed(y, 0, 2.0, 2.0, 2.2);
    for (const s of [-1, 1]) this._table(y, s * 1.5, 3.4, 0.5, 0.45, 0.55, C.wood);
    this._box('fabric', 1.2, 0.35, 0.5, 0, y + 0.32, 4.9, C.fabric); this._f();
    // 衣帽间（西北）：L 型衣柜
    this._cabinet(y, -8.6, 4.0, 1.2, 2.2, 0.55);
    this._cabinet(y, -6.5, 5.8, 2.4, 2.2, 0.55);
    // 书房（东）：书桌 + 书架 + 办公椅
    this._table(y, 6.5, 3.0, 2.0, 0.9, 0.75, C.woodDark);
    this._chair(y, 6.5, 4.2, Math.PI);
    for (let i = 0; i < 3; i += 1) this._box('plain', 2.4, 0.08, 0.35, 6.5, y + 0.5 + i * 0.6, -1.0, C.woodDark);
    this._box('plain', 0.08, 2.0, 0.35, 5.3, y + 1.1, -1.0, C.woodDark);
    this._box('plain', 0.08, 2.0, 0.35, 7.7, y + 1.1, -1.0, C.woodDark);
    // 沙发角
    this._sofa(y, -5.5, -2.5, 0, C.fabric);
    this._plant(y, 3.5, 5.5, 1.2);
    this._plant(y, -3.5, -4.5, 0.9);
    this._lamp(y, 3.0, 2.0);
    // 屋顶阳台（南墙外挑）：户外桌 + 椅 + 栏杆
    this._table(y, -2.0, 6.6, 1.2, 0.7, 0.72, C.wood);
    this._chair(y, -3.2, 6.6, Math.PI / 2);
    this._chair(y, -0.8, 6.6, -Math.PI / 2);
    for (let i = 0; i < 6; i += 1) this._box('metal', 0.05, 1.0, 0.05, -4 + i * 1.6, y + 0.5, 7.7, C.metal);
    this._box('metal', 9.0, 0.06, 0.06, 0, y + 1.0, 7.7, C.metal);
    // 3F 家具碰撞（分层）
    this._fb(3, -1.1, 1.1, 0.9, 3.1);    // 主卧床
    this._fb(3, -9.2, -8.0, 3.7, 4.3);   // 衣帽间衣柜
    this._fb(3, -7.7, -5.3, 5.5, 6.1);   // 衣帽间L柜
    this._fb(3, 5.5, 7.5, 2.5, 3.5);     // 书桌
    this._fb(3, -6.8, -4.2, -3.1, -1.9); // 沙发角
  }

  /* ======================================================================== */
  /* 电梯：按钮 → 轿厢升降 → 玩家随行                                          */
  /* ======================================================================== */
  _buildElevator(register) {
    const { x0, x1, z0, z1 } = SHAFT;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const w = x1 - x0 - 0.3, d = z1 - z0 - 0.3;
    // 轿厢是一个 Group，整体沿 y 移动；地板/三壁/顶/灯
    const car = new THREE.Group();
    car.name = 'Villa/elevator-car';
    const floorGeo = this._geo(new THREE.BoxGeometry(w, 0.16, d));
    const wallGeo = this._geo(new THREE.BoxGeometry(w, 2.5, 0.12));
    const sideGeo = this._geo(new THREE.BoxGeometry(0.12, 2.5, d));
    const ceilGeo = this._geo(new THREE.BoxGeometry(w, 0.12, d));
    const matCar = this._mat(new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.4, metalness: 0.4 }));
    const matFloor = this._mat(new THREE.MeshStandardMaterial({ color: C.floorDark, roughness: 0.7 }));
    const matLight = this._mat(new THREE.MeshBasicMaterial({ color: C.warm, toneMapped: false }));
    const fl = new THREE.Mesh(floorGeo, matFloor); fl.position.y = 0; car.add(fl);
    const back = new THREE.Mesh(wallGeo, matCar); back.position.set(0, 1.25, -d / 2); car.add(back);
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(sideGeo, matCar); side.position.set(s * w / 2, 1.25, 0); car.add(side);
    }
    const ceil = new THREE.Mesh(ceilGeo, matCar); ceil.position.y = 2.5; car.add(ceil);
    const lamp = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.5, 0.04, 0.5)), matLight);
    lamp.position.set(0, 2.42, 0); car.add(lamp);
    car.position.set(cx, this._elevatorY, cz);
    this.root.add(car);
    this._elevatorCar = car;

    // 轿厢内楼层按钮面板（3D 小盒，交互走 DOM，这里只做视觉）
    const panel = new THREE.Mesh(
      this._geo(new THREE.BoxGeometry(0.06, 0.7, 0.4)),
      this._mat(new THREE.MeshStandardMaterial({ color: C.trim, roughness: 0.5 })),
    );
    panel.position.set(-w / 2 + 0.09, 1.2, d / 2 - 0.5); car.add(panel);
    this._elevatorPanel = panel;

    // 楼层显示牌（井道外，每层一个，静态）
    for (let i = 0; i < 4; i += 1) {
      this._box('emissive', 0.5, 0.32, 0.04, x1 + 0.12, LEVELS[i] + 1.9, z1, i === this._level ? 0x66ddaa : 0x445566);
    }

    this._elevator = { active: false, fromY: 0, toY: 0, target: 1, doorHint: 0 };
  }

  /** 电梯 Called from DOM 按钮：target 层索引 0..3 */
  _callElevator(target) {
    if (this._disposed || !this._elevator || this._elevator.active) return;
    target = clamp(Math.round(target), 0, 3);
    if (target === this._level && Math.abs(this._elevatorY - LEVELS[target]) < 0.05) {
      this._toast(`已在 ${LEVEL_NAMES[target]}`);
      return;
    }
    this._elevator.active = true;
    this._elevator.fromY = this._elevatorY;
    this._elevator.toY = LEVELS[target];
    this._elevator.target = target;
    this._toast(`电梯前往 ${LEVEL_NAMES[target]}…`);
  }

  _updateElevator(dt) {
    const e = this._elevator;
    if (!e) return;
    if (e.active) {
      this._elevatorY = damp(this._elevatorY, e.toY, 2.2, dt);
      if (Math.abs(this._elevatorY - e.toY) < 0.03) {
        this._elevatorY = e.toY;
        e.active = false;
        this._level = e.target;
        this._elevatorGrace = 1.5; // 到站后 1.5s 内 _syncLevel 不反驳，防被拉回旧层
        this._toast(`已到达 ${LEVEL_NAMES[e.target]}`);
      }
    }
    if (this._elevatorGrace > 0) this._elevatorGrace -= dt;
    if (this._elevatorCar) this._elevatorCar.position.y = this._elevatorY;
  }

  /* ---------- 扫地机器人：沿矩形路径巡游，累了回基站 ---------- */
  _buildRobot(register) {
    const y = LEVELS[1];
    const bodyGeo = this._geo(new THREE.CylinderGeometry(0.22, 0.22, 0.09, 16));
    const mat = this._mat(new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.5, metalness: 0.3 }));
    const ledMat = this._mat(new THREE.MeshBasicMaterial({ color: 0x55ddaa, toneMapped: false }));
    const robot = new THREE.Group();
    robot.name = 'Villa/robot';
    const body = new THREE.Mesh(bodyGeo, mat); robot.add(body);
    const led = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.035, 8, 6)), ledMat);
    led.position.set(0, 0.06, 0.18); robot.add(led);
    robot.position.set(-8.6, y + 0.06, -4.8);
    this.root.add(robot);
    // 巡游路径（1F 客厅一圈）；基站 (-8.6,-4.8)
    this._robotPath = Object.freeze([
      [-8.6, -4.8], [-6.0, -3.0], [-6.0, 3.5], [-2.5, 4.8],
      [1.0, 3.5], [1.0, -3.0], [-3.0, -3.8], [-8.6, -4.8],
    ]);
    this._robot = robot;
    this._robotT = 0;
    this._robotPause = 0;
  }

  _updateRobot(dt) {
    if (!this._robot) return;
    const pts = this._robotPath;
    if (this._robotPause > 0) { this._robotPause -= dt; return; }
    this._robotT += dt * 0.12; // 一圈约 66s（8 段）
    const seg = this._robotT % (pts.length - 1);
    const i = Math.floor(seg), f = seg - i;
    const a = pts[i], b = pts[i + 1];
    const x = a[0] + (b[0] - a[0]) * f;
    const z = a[1] + (b[1] - a[1]) * f;
    this._robot.position.x = x;
    this._robot.position.z = z;
    this._robot.rotation.y = Math.atan2(b[0] - a[0], b[1] - a[1]);
    if (this._robotT >= pts.length - 1) { this._robotT = 0; this._robotPause = 4; } // 回基站停 4s
  }

  /* ---------- 电视：程序化动态画面（CanvasTexture 每帧节流重绘） ---------- */
  _buildTV(register) {
    this._tvCanvas = document.createElement('canvas');
    this._tvCanvas.width = 256; this._tvCanvas.height = 144;
    this._tvCtx = this._tvCanvas.getContext('2d');
    const tex = this._tex(new THREE.CanvasTexture(this._tvCanvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    const screenMat = this._mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    // 2F 客厅电视（挂在电视柜上方，朝 +z）
    const screen = new THREE.Mesh(this._geo(new THREE.PlaneGeometry(2.2, 1.24)), screenMat);
    screen.position.set(-3.0, LEVELS[2] + 1.55, -2.78);
    this.root.add(screen);
    // 边框
    this._box('black', 2.4, 1.44, 0.08, -3.0, LEVELS[2] + 1.55, -2.84, C.black);
    this._tvScreen = screen;
    this._tvTex = tex;
    this._tvAcc = 0;
    this._drawTV(0);
  }

  _drawTV(t) {
    const g = this._tvCtx;
    if (!g) return;
    // 循环三种画面：彩色条 / 时钟 / 渐变风景，每 8 秒切换
    const phase = Math.floor(t / 8) % 3;
    if (phase === 0) {
      const cols = ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2980b9', '#8e44ad'];
      const w = 256 / cols.length;
      cols.forEach((c, i) => { g.fillStyle = c; g.fillRect(i * w, 0, w + 1, 144); });
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 118, 256, 26);
      g.fillStyle = '#fff'; g.font = '16px sans-serif'; g.fillText('VILLA  TV  •  LIVE', 12, 136);
    } else if (phase === 1) {
      g.fillStyle = '#0e1b26'; g.fillRect(0, 0, 256, 144);
      g.strokeStyle = '#2c4a63'; g.lineWidth = 2; g.strokeRect(8, 8, 240, 128);
      const d = new Date();
      g.fillStyle = '#eaf4ff'; g.font = 'bold 46px sans-serif'; g.textAlign = 'center';
      g.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, 128, 78);
      g.font = '13px sans-serif'; g.fillStyle = '#8fb8cf';
      g.fillText('MODERN  VILLA', 128, 106); g.textAlign = 'left';
    } else {
      const grad = g.createLinearGradient(0, 0, 0, 144);
      grad.addColorStop(0, '#2b6a8f'); grad.addColorStop(0.6, '#7fb4c9'); grad.addColorStop(1, '#d9c08a');
      g.fillStyle = grad; g.fillRect(0, 0, 256, 144);
      g.fillStyle = '#3c6b46'; g.beginPath(); g.arc(200, 110, 44, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#e8e2c8'; g.beginPath(); g.arc(60, 34, 14, 0, Math.PI * 2); g.fill();
    }
    if (this._tvTex) this._tvTex.needsUpdate = true;
  }

  /* ---------- 灯光（少量 PointLight，castShadow=false） ---------- */
  _buildLights() {
    // 全局渲染走 ACESFilmic + 曝光 1.0，而项目其它灯光已按 EXPOSURE_COMP=0.38
    // 预乘标定。这里点光强度必须同量级（2.2），否则室内一片过曝白（实测踩坑）。
    for (let i = 0; i < 4; i += 1) {
      const light = new THREE.PointLight(0xffd9a8, 2.2, 20, 1.6);
      light.position.set(-1, LEVELS[i] + 3.0, 1);
      light.castShadow = false;
      this.root.add(light);
      // 每层的暖色吸顶灯（视觉发光条）
      const panel = new THREE.Mesh(
        this._geo(new THREE.BoxGeometry(1.6, 0.04, 0.5)),
        this._mat(new THREE.MeshBasicMaterial({ color: 0xffe6bc, toneMapped: false, transparent: true, opacity: 0.85 })),
      );
      panel.position.set(-1, LEVELS[i] + HOUSE.H - 0.16, 1);
      this.root.add(panel);
    }
  }

  /* ======================================================================== */
  /* 多层高度状态机（核心）                                                    */
  /* ======================================================================== */

  /** 判断点是否在电梯井内 */
  _inShaft(x, z) {
    return x > SHAFT.x0 - 0.1 && x < SHAFT.x1 + 0.1 && z > SHAFT.z0 - 0.1 && z < SHAFT.z1 + 0.1;
  }
  /** 找出服务当前层的楼梯段（k = _level-1 下行 或 k = _level 上行） */
  _stairForLevel() {
    const out = [];
    for (const s of STAIRS) {
      if (s.k === this._level || s.k === this._level - 1) out.push(s);
    }
    return out;
  }

  /**
   * WASDController.getGroundHeight 回调：脚下地面高度。
   * 电梯井 → 轿厢地板（动态）；楼梯 → 仅采用“服务当前层”的段，按 z 插值；
   * 其余 → 当前层基准高度。用 _level 消解同 x/z 不同层的歧义。
   */
  _groundAt(x, z) {
    if (this._inShaft(x, z)) return this._elevatorY;
    for (const s of this._stairForLevel()) {
      if (x > s.x0 - 0.15 && x < s.x1 + 0.15 && z >= s.z0 - 0.05 && z <= s.z1 + 0.05) {
        const t = clamp((z - s.z0) / (s.z1 - s.z0), 0, 1);
        return LEVELS[s.k] + t * (LEVELS[s.k + 1] - LEVELS[s.k]);
      }
    }
    return LEVELS[this._level];
  }

  /** 按当前楼层过滤碰撞盒：墙体碰撞要多带一个“地板边界”逻辑，家具按层记录 */
  _walkBoxesByLevel() {
    // 外墙和电梯井对所有层生效；家具层盒存在 _furnitureBoxes[level]
    const base = this._baseBoxes || (this._baseBoxes = this._walkBoxes.slice());
    const extra = this._furnitureBoxes && this._furnitureBoxes[this._level];
    return extra ? base.concat(extra) : base;
  }

  /** 楼梯上行/到顶或离开后，用相机 y 推断并锁定楼层 */
  _syncLevel() {
    const cam = this._ctx?.camera;
    if (!cam) return;
    const footY = cam.position.y - 1.6;
    if (this._inShaft(cam.position.x, cam.position.z)) return; // 电梯内由 _callElevator 管
    if (this._elevatorGrace > 0) return; // 到站保护期：玩家正走出轿厢，不改层
    // 楼梯段内：走到顶/底才切层，中途保持（避免反复跳）
    for (const s of STAIRS) {
      if (cam.position.x > s.x0 - 0.2 && cam.position.x < s.x1 + 0.2
        && cam.position.z >= s.z0 - 0.1 && cam.position.z <= s.z1 + 0.1) {
        if (cam.position.z > s.z1 - 0.35 && this._level === s.k) {
          this._level = s.k + 1; // 上到高层
        } else if (cam.position.z < s.z0 + 0.35 && this._level === s.k + 1) {
          this._level = s.k;     // 下到低层
        }
        return;
      }
    }
    // 平地区：锁定到最近层
    let best = 0, bestD = Infinity;
    for (let i = 0; i < LEVELS.length; i += 1) {
      const d = Math.abs(footY - LEVELS[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD < 1.4) this._level = best;
  }

  /* ======================================================================== */
  /* UI：楼层指示 + 电梯按钮 + 返回大厅                                        */
  /* ======================================================================== */
  _buildUI() {
    const root = document.createElement('div');
    root.id = 'villa-ui';
    root.innerHTML = `
      <style>
        #villa-ui{position:fixed;inset:0;pointer-events:none;font-family:"Microsoft YaHei",sans-serif;z-index:60}
        #villa-ui .card{position:absolute;top:20px;left:20px;background:rgba(20,28,34,.86);color:#eaf4f8;
          border:1px solid rgba(150,200,220,.35);border-radius:12px;padding:14px 16px;backdrop-filter:blur(8px)}
        #villa-ui h3{margin:0 0 6px;font-size:15px;font-weight:500;letter-spacing:1px}
        #villa-ui .lv{font-size:13px;color:#9fd8c8;margin-bottom:10px}
        #villa-ui .hint{font-size:11px;color:#a9bcc6;line-height:1.7;max-width:230px}
        #villa-ui .btns{position:absolute;right:20px;top:20px;display:flex;flex-direction:column;gap:6px;pointer-events:auto}
        #villa-ui button{background:rgba(20,28,34,.86);color:#eaf4f8;border:1px solid rgba(150,200,220,.35);
          border-radius:8px;padding:9px 14px;font-size:13px;cursor:pointer;min-width:96px}
        #villa-ui button:hover{background:rgba(46,90,110,.9)}
        #villa-ui .elev{position:absolute;right:20px;bottom:120px;display:flex;flex-direction:column;gap:5px;pointer-events:auto}
        #villa-ui .elev b{font-size:11px;color:#9fd8c8;text-align:center;margin-bottom:2px}
        #villa-ui .toast{position:absolute;bottom:80px;left:50%;transform:translateX(-50%);
          background:rgba(20,28,34,.9);color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .25s}
      </style>
      <div class="card">
        <h3>现代别墅 · 我的家</h3>
        <div class="lv" id="villa-lv">当前：1F</div>
        <div class="hint">WASD / 方向键走动 · 拖拽环顾<br>走楼梯上下楼，或用右侧电梯按钮<br>Esc 返回大厅</div>
      </div>
      <div class="btns"><button data-villa="exit">← 返回大厅</button></div>
      <div class="elev">
        <b>电梯</b>
        <button data-villa="floor" data-floor="3">3F 主卧</button>
        <button data-villa="floor" data-floor="2">2F 起居</button>
        <button data-villa="floor" data-floor="1">1F 玄关</button>
        <button data-villa="floor" data-floor="0">B1 车库</button>
      </div>
      <div class="toast" id="villa-toast"></div>`;
    document.body.appendChild(root);
    this._uiRoot = root;

    const onExit = () => { if (!this._disposed) this._ctx?.onExitAttraction?.(); };
    const onFloor = (e) => {
      const btn = e.target.closest('[data-floor]');
      if (btn) this._callElevator(Number(btn.dataset.floor));
    };
    const onKey = (e) => { if (e.code === 'Escape' && !this._disposed) onExit(); };
    root.querySelector('[data-villa="exit"]')?.addEventListener('click', onExit);
    root.querySelectorAll('[data-villa="floor"]').forEach((b) => b.addEventListener('click', onFloor));
    window.addEventListener('keydown', onKey);
    this._listeners.push(
      ['exit', root.querySelector('[data-villa="exit"]'), onExit, 'click'],
      ['floor', root, onFloor, 'click'],
      ['key', window, onKey, 'keydown'],
    );
  }

  _toast(msg) {
    const el = this._uiRoot?.querySelector('#villa-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
  }

  _updateUILevel() {
    const el = this._uiRoot?.querySelector('#villa-lv');
    if (el && el.textContent !== `当前：${LEVEL_NAMES[this._level]}`) {
      el.textContent = `当前：${LEVEL_NAMES[this._level]}`;
    }
  }

  /* ======================================================================== */
  /* update / onInteract / dispose                                             */
  /* ======================================================================== */
  update(dt) {
    if (this._disposed) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this._time += dt;
    this._wasd?.update(dt);
    this._updateElevator(dt);
    this._updateRobot(dt);
    this._syncLevel();
    this._updateUILevel();
    // 电视每 0.25s 重绘一次（避免每帧上传）
    this._tvAcc += dt;
    if (this._tvAcc >= 0.25) { this._tvAcc = 0; this._drawTV(this._time); }
  }

  onInteract(_hitInfo) { /* 交互全部走 DOM 按钮 */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    clearTimeout(this._toastTimer);
    this._wasd?.dispose(); this._wasd = null;
    for (const [key, target, fn, evt] of this._listeners) {
      if (target) target.removeEventListener?.(evt || 'click', fn);
    }
    this._listeners.length = 0;
    if (this._uiRoot?.parentNode) this._uiRoot.parentNode.removeChild(this._uiRoot);
    this._uiRoot = null;
    // 相机恢复
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
    for (const t of this._textures) t.dispose();
    for (const m of this._materials) m.dispose();
    for (const g of this._geometries) g.dispose();
    this._textures.clear(); this._materials.clear(); this._geometries.clear();
    this._walkBoxes.length = 0; this._baseBoxes = null;
    this._tvScreen = null; this._tvTex = null; this._tvCtx = null;
    this._robot = null; this._elevatorCar = null; this._elevator = null;
    this._ctx = null;
  }
}

export default Villa;
