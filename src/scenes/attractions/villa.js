/**
 * ============================================================================
 * Villa —— 可进入的现代别墅（玩家自己的家）· v2 精修版
 * ============================================================================
 * 玩法：玩家以第一人称从大厅触发环进入，站在别墅 1F 玄关。四层空间：
 *   B1 车库 + 洗衣房 + 储藏 + 设备
 *   1F 玄关 / 客厅 / 厨房 / 餐厅 / 客卫 / 家政角
 *   2F 起居 / 健身 / 娱乐 / 浴室 / 南向阳台
 *   3F 主卧 / 衣帽间 / 书房 / 主卫 / 南向露台
 *   三段楼梯 B1↔1F、1F↔2F、2F↔3F 各占一条 z 向跑道，两侧井壁封死，
 *   楼板在楼梯到达处真实开洞；电梯 B1/1F/2F/3F 四层可乘。
 *
 * ---------------------------------------------------------------------------
 * 【v2 修了什么】（对照用户三条反馈）
 *  ①「画面一直闪 / 像卡住」——旧版每层额外建了一块 y+H-0.1 的“天花板 lid”，
 *     与上一层楼板（y+H-0.24 ~ y+H）大面积共面重叠，深度值互顶 → 大面积
 *     z-fighting 闪烁；同时 4 块 lid 还 castShadow，阴影贴图也跟着抖。
 *     v2 直接删掉 lid：楼板本身就是下一层的顶棚，全屋不再有共面重叠面；
 *     玻璃改为 depthWrite:false，避免透明面排序闪烁。
 *  ②「楼梯有 BUG：上楼一扭头就没了 / 往下走突然到地下 / 站着突然掉车库」
 *     根因是旧 `_groundAt` 靠 `_level` 这个可写状态选“服务当前层的楼梯段”，
 *     `_syncLevel` 又用相机 y 反推楼层；一旦相机横向离开楼梯 x 带，就按
 *     最近楼层取整 —— 脚下一帧从 3.6 变成 0 或 -3.6，WASD 的指数平滑把
 *     3.6m 落差摊成 0.3s 的自由落体，看起来就是“突然掉到车库”。
 *     v2 的 `_groundAt` 改为【支撑面求解】：候选 = 电梯轿厢地板 / 楼梯按 z
 *     插值的斜面 / 当前楼层楼板，取【离当前脚下高度最近且在 1.7m 步距内】的
 *     那个。上下楼时脚高连续变化，候选自然接力，不存在瞬跳；`_level` 只由
 *     脚高反推用于显示与碰撞过滤，绝不反过来决定地面高度。
 *     另外旧版楼板没有开洞，楼梯是“穿模”穿过上层楼板的，v2 按到达位置开洞。
 *  ③「每层功能分区」——B1 车库/洗衣、1F 玄关/客厅/餐厨/客卫、2F 起居/健身/
 *     娱乐/浴室/阳台、3F 主卧/衣帽/书房/主卫/露台，家具与灯具不跨层复用。
 *  ④「阳台能看到外面」——2F/3F 南向阳台真实可走出（栏杆 + 碰撞），并补了
 *     院子草地、树、绿篱、远处摩天轮与园区剪影，站在阳台能看见整片园区。
 *
 * 【单文件闭环】场景 / 家具 / 电梯状态机 / UI / 资源清理全部在本类内；
 *   不 import、不修改 core/ 任何基座模块（与 DanceHall / MemoryMatch 同约定）。
 *
 * 【IAttraction 契约】init(ctx)/update(dt)/onInteract(hitInfo)/dispose() 四方法齐全；
 *   dispose() 幂等；root 挂 ctx.scene；全程不用 Rapier（车是静态展示模型）。
 *
 * 【热基线】init 一次性建完全部 geometry/material/texture，update 只改属性
 *   （电梯位置 / 机器人矩阵 / 电视贴图内容），绝不惰性新建 GPU 资源 →
 *   多轮「大厅→别墅→大厅」Δgeo=Δtex=0。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { IAttraction } from './i-attraction.js';
import { WASDController } from '../../utils/controls/wasd-controller.js';
import { CITY_VILLA } from '../metropolis/city-villa.js';

/* ========================================================================== */
/* 尺寸与坐标（本地坐标，别墅中心为原点）                                      */
/* ========================================================================== */

/**
 * 【v3 同场并置】别墅不再是“独立场景”，而是**真实盖在都会区那栋别墅的地址上**：
 * 本地原点对齐 CITY_VILLA(x,z)，绕 Y 转 180°（本地 +z 面是南门，城市的门也朝南），
 * 楼层再抬一个基座高度 BASE_Y。这样从 2F/3F 阳台和所有窗户看出去，
 * 就是大厅里真实的那条街、那栋大都会，而不是另画的一片假草地。
 */
export const VILLA_ORIGIN = Object.freeze({ x: CITY_VILLA.x, z: CITY_VILLA.z, yaw: Math.PI, y: 1.2 });

/** 房屋占地与层高：x∈[-10,10]，z∈[-8,8]，层高 3.6m，楼板 0.18m，外墙 0.3m */
const HOUSE = Object.freeze({ W: 20, D: 16, H: 3.6, WALL: 0.3, SLAB: 0.18 });
/** 四层地板基准 y（脚下高度）：B1, 1F, 2F, 3F */
const LEVELS = Object.freeze([-3.6, 0, 3.6, 7.2]);
const LEVEL_NAMES = Object.freeze(['B1', '1F', '2F', '3F']);
/** 楼板到下一层楼板底的有效墙高（层高减楼板） */
const WALL_H = HOUSE.H - HOUSE.SLAB;

/** 楼梯跑道（西侧）：x 向固定，三段 z 区间互不重叠且首尾各留 1.0m 平台 */
const STAIR_X = Object.freeze({ x0: -9.55, x1: -6.85 });
const STAIRS = Object.freeze([
  Object.freeze({ k: 0, z0: -7.0, z1: -3.0 }), // B1(-3.6) → 1F(0)
  Object.freeze({ k: 1, z0: -2.0, z1: 2.0 }),  // 1F(0)     → 2F(3.6)
  Object.freeze({ k: 2, z0: 3.0, z1: 7.0 }),   // 2F(3.6)   → 3F(7.2)
]);
/** 楼梯井东侧井壁（贴着跑道右边缘，贯通两层的竖向实体墙） */
const STAIR_WALL_T = 0.2;

/** 电梯井：东北角，x∈[6.4,9.0] z∈[-6.8,-4.2]，贯通四层，南侧每层开门 */
const SHAFT = Object.freeze({ x0: 6.4, x1: 9.0, z0: -6.8, z1: -4.2 });
/** 南向阳台 / 露台（2F、3F 共用同一平面尺寸，便于共用一组栏杆碰撞） */
const BALCONY = Object.freeze({ x0: -3.6, x1: 3.6, z0: 8.0, z1: 10.8 });

/** 出生点：1F 玄关，面向 -z（屋内纵深） */
const SPAWN = Object.freeze({ x: 0, y: 0, z: 6.2, yaw: 0 });

/** 上下楼的最大“步距”：脚高与候选支撑面相差超过它就判定为另一层 */
const STEP_TOLERANCE = 1.7;

/** 现代简约配色（sRGB hex） */
const C = Object.freeze({
  wall: 0xeae7e0, wallAccent: 0xd6d0c4, floor: 0xc9a87c, floorDark: 0x8a8b86,
  ceiling: 0xf4f2ec, trim: 0x2f3338, glass: 0x9fc4cf, metal: 0x9aa3ab,
  fabric: 0x6b7681, fabricLight: 0xb9c0c6, wood: 0x9c7549, woodDark: 0x5d4530,
  black: 0x1e2226, white: 0xf4f4f0, green: 0x5b8a4a, greenDark: 0x3e6b39,
  warm: 0xffd9a0, screen: 0x142028, red: 0xb8503f, blue: 0x3d6a86,
  stone: 0xbfb9ad, concrete: 0x93948f, tile: 0xe2e4e2,
});

const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ========================================================================== */
/* Villa                                                                     */
/* ========================================================================== */
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
    this._lights = [];
    /** 全局生效的碰撞盒（外墙 / 楼梯井壁 / 电梯井壁） */
    this._walkBoxes = [];
    /** 分层生效的碰撞盒（家具 / 隔断 / 阳台栏杆 / 楼层外墙洞口段） */
    this._furnitureBoxes = [[], [], [], []];
    this._staticGroups = new Map();
    this._level = 1;      // 当前楼层索引（1=1F 出生）；由脚高反推，只用于显示/碰撞
    this._footY = 0;      // 上一帧脚下高度（支撑面求解的连续性依据）
    this._elevatorY = 0;  // 轿厢地板高度
    this._elevatorJustArrived = false;
    this._time = 0;
    /** 是否正“在家”（由 activate()/deactivate() 切换；决定 metadata 可见性与键盘监听） */
    this._active = false;
    this._uiAttached = false;
    this._worldCache = null;
    this._worldCacheKey = '';
    this._dummy = new THREE.Object3D();
    this._tmpColor = new THREE.Color();
    this._boxCache = null;
    this._boxCacheKey = -1;
  }

  /* ---------- 台账工具 ---------- */
  _geo(g) { this._geometries.add(g); return g; }
  _mat(m) { this._materials.add(m); return m; }
  _tex(t) { this._textures.add(t); return t; }

  /** 给几何整体刷顶点色（合并后由 vertexColors 材质驱动，一个桶只吃一次绘制） */
  _paint(g, color) {
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    this._tmpColor.setHex(color);
    for (let i = 0; i < n; i += 1) {
      col[i * 3] = this._tmpColor.r;
      col[i * 3 + 1] = this._tmpColor.g;
      col[i * 3 + 2] = this._tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }

  _push(bucket, g, color) {
    if (color != null) this._paint(g, color);
    if (!this._staticGroups.has(bucket)) this._staticGroups.set(bucket, []);
    this._staticGroups.get(bucket).push(g);
    return g;
  }

  /** 盒子 → 材质桶（顶点落在本地坐标，最后统一 merge） */
  _box(bucket, w, h, d, x, y, z, color, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return this._push(bucket, g, color);
  }

  /** 圆柱 → 材质桶；rx/rz 为弧度，可躺倒成轮子/灯管 */
  _cyl(bucket, rt, rb, h, seg, x, y, z, color, rx = 0, rz = 0) {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    if (rx) g.rotateX(rx);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return this._push(bucket, g, color);
  }

  /** 2D 碰撞盒（全局生效，WASDController 口径：minX/maxX/minZ/maxZ） */
  _block(x0, x1, z0, z1) {
    this._walkBoxes.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 });
  }

  /** 2D 碰撞盒（只在某一层生效：脚高与该层地板相差 <1m 时才参与消解） */
  _fb(level, x0, x1, z0, z1) {
    this._furnitureBoxes[level].push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 });
  }

  /* ======================================================================== */
  /* init                                                                      */
  /* ======================================================================== */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera, renderer } = ctx;
    if (!scene || !camera) throw new Error('[Villa] 缺少 scene / camera');
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    // 【v3】不再抢相机：相机由 FacilityRuntime 的 CameraRig 在 activate() 时 blend 过来
    this._cameraSaved = null;
    this._level = 1;
    this._footY = LEVELS[1];
    this._elevatorY = LEVELS[1];

    // 别墅落在大厅里的真实地址（与都会区 city-villa 同一块地）
    this.root.position.set(VILLA_ORIGIN.x, VILLA_ORIGIN.y, VILLA_ORIGIN.z);
    this.root.rotation.set(0, VILLA_ORIGIN.yaw, 0);
    this.root.visible = false;   // 只在自己“在家”时才亮出来
    scene.add(this.root);
    this.root.updateMatrixWorld(true);
    this._inv = this.root.matrixWorld.clone().invert();
    this._baseY = VILLA_ORIGIN.y;

    this._buildStructure();
    this._buildFurniture();
    this._mergeStatics(register);

    this._buildElevator(register);
    this._buildRobot();
    this._buildTV();
    this._buildLights();

    // WASD 漫游不在这里挂：由 activate() 每次“回家”现建现挂，deactivate() 立刻摘掉，
    // 保证在大厅里别墅不抢键盘、不写相机。
    this._wasd = null;

    for (const g of this._geometries) register(g);
    for (const m of this._materials) register(m);
    for (const t of this._textures) register(t);

    console.info(
      `[Villa] init 完成（同场并置 @${VILLA_ORIGIN.x},${VILLA_ORIGIN.z}）| 层=4 家具件=${this._furnitureCount || 0} | ` +
      `geo=${this._geometries.size} mat=${this._materials.size} tex=${this._textures.size} | 静态桶=${this._staticGroups.size}`,
    );
  }

  /* ======================================================================== */
  /* 本地 ↔ 世界（别墅落在大厅里之后，所有外部接口都在世界坐标）                 */
  /* ======================================================================== */

  /** 本地 (x,y,z) → 世界（含 180° 旋转与基座高度） */
  localToWorld(x, y, z) {
    return new THREE.Vector3(x, y, z).applyMatrix4(this.root.matrixWorld);
  }

  /** 世界 (x,z) → 本地的水平坐标（供地面求解/碰撞） */
  worldToLocalXZ(x, z) {
    const v = new THREE.Vector3(x, 0, z).applyMatrix4(this._inv);
    return { x: v.x, z: v.z };
  }

  /** 世界坐标的地面高度（= 本地地面 + 基座高度），给 WASDController 用 */
  _worldGroundAt(x, z) {
    const l = this.worldToLocalXZ(x, z);
    return this._groundAt(l.x, l.z) + this._baseY;
  }

  /** 本地碰撞盒 → 世界 AABB（180° 旋转后仍是轴对齐矩形，只需换两个角） */
  _worldBoxes() {
    const key = `${this._level}|${this._elevator?.active ? this._elevator.target : -1}|${this._elevatorY.toFixed(2)}`;
    const src = this._walkBoxesByLevel();
    if (this._worldCacheKey === key && this._worldCache) return this._worldCache;
    const out = [];
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    for (const b of src) {
      p1.set(b.minX, 0, b.minZ).applyMatrix4(this.root.matrixWorld);
      p2.set(b.maxX, 0, b.maxZ).applyMatrix4(this.root.matrixWorld);
      out.push({
        minX: Math.min(p1.x, p2.x), maxX: Math.max(p1.x, p2.x),
        minZ: Math.min(p1.z, p2.z), maxZ: Math.max(p1.z, p2.z),
        noBlock: b.noBlock === true,
      });
    }
    this._worldCache = out;
    this._worldCacheKey = key;
    return out;
  }

  /** 合并每个材质桶为一个 Mesh，顶点色驱动，省 draw call */
  _mergeStatics(register) {
    for (const [name, geos] of this._staticGroups) {
      if (!geos.length) continue;
      // mergeGeometries 要求所有源几何属性集一致；这里统一补齐 position/normal/uv/color
      for (const g of geos) {
        if (!g.attributes.color) {
          const n = g.attributes.position.count;
          g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
        }
      }
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) throw new Error(`[Villa] 材质桶 ${name} 合并失败（属性不一致）`);
      this._geo(merged);

      let mat;
      if (name === 'emissive') {
        mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
      } else if (name === 'sky') {
        mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false });
      } else if (name === 'glass') {
        // depthWrite=false：透明面不再互相抢深度，避免窗/淋浴玻璃闪烁
        mat = new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 0.1, metalness: 0.05,
          transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
        });
      } else if (name === 'metal') {
        mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.6 });
      } else if (name === 'fabric') {
        mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
      } else if (name === 'floor') {
        mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0.02 });
      } else {
        mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02 });
      }
      this._mat(mat);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `Villa/static-${name}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
    }
    // 源几何合并后释放（从未上传 GPU，dispose 只是标记）
    for (const geos of this._staticGroups.values()) for (const g of geos) g.dispose();
    this._staticGroups.clear();
  }

  /* ======================================================================== */
  /* 建筑骨架                                                                  */
  /* ======================================================================== */
  _buildStructure() {
    this._buildFloors();
    this._buildOuterWalls();
    this._buildFacade();
    this._buildStairShafts();
    this._buildStairs();
    this._buildElevatorShaft();
    this._buildBalconies();
    // 【v3】不再自建院子/天空/远景：窗外就是大厅真实的都会区
  }

  /** 立面细节：勒脚、层间腰线、屋顶女儿墙（让外观不再是一个白盒子） */
  _buildFacade() {
    const W = HOUSE.W / 2, D = HOUSE.D / 2;
    // 一圈“凸出墙面 out”的横带（内表面嵌进墙里，外表面凸出，不与墙面共面）
    const ring = (y, h, out, color) => {
      const t = 0.2 + out;
      const oy = y + h / 2;
      this._box('plain', W * 2 + out * 2, h, t, 0, oy, D + 0.05 + out / 2, color);
      this._box('plain', W * 2 + out * 2, h, t, 0, oy, -D - 0.05 - out / 2, color);
      this._box('plain', t, h, D * 2 + out * 2, W + 0.05 + out / 2, oy, 0, color);
      this._box('plain', t, h, D * 2 + out * 2, -W - 0.05 - out / 2, oy, 0, color);
    };
    // 勒脚（1F 地面一圈深色踢脚）
    ring(-0.02, 0.42, 0.08, C.concrete);
    // 层间腰线（每层楼板高度一圈浅色带）
    for (const lv of [1, 2, 3]) ring(LEVELS[lv] - 0.06, 0.14, 0.1, C.wallAccent);
    // 屋顶女儿墙（沿屋顶外沿围 0.45 高）
    const ry0 = LEVELS[3] + HOUSE.H;
    const py = ry0 + 0.205, pt = 0.28;
    this._box('plain', W * 2 + 0.6, 0.45, pt, 0, py, D + 0.15, C.wall);
    this._box('plain', W * 2 + 0.6, 0.45, pt, 0, py, -D - 0.15, C.wall);
    this._box('plain', pt, 0.45, D * 2 + 0.6, W + 0.15, py, 0, C.wall);
    this._box('plain', pt, 0.45, D * 2 + 0.6, -W - 0.15, py, 0, C.wall);
    // 电梯井顶盖（把屋顶上的洞口封住）
    this._box('plain', SHAFT.x1 - SHAFT.x0 + 0.1, 0.14, SHAFT.z1 - SHAFT.z0 + 0.1,
      (SHAFT.x0 + SHAFT.x1) / 2, LEVELS[3] + HOUSE.H + 0.02, (SHAFT.z0 + SHAFT.z1) / 2, C.wall);
  }

  /** 楼板：真实扣掉楼梯井与电梯井的洞（旧版整块楼板导致楼梯穿模 + 上下层互相挡） */
  _buildFloors() {
    for (let lv = 0; lv < 4; lv += 1) {
      const holes = [{ x0: SHAFT.x0 - 0.1, x1: SHAFT.x1 + 0.1, z0: SHAFT.z0 - 0.1, z1: SHAFT.z1 + 0.1 }];
      if (lv > 0) {
        const s = STAIRS[lv - 1];
        // 楼梯到达处整段开洞：从外墙内表面到井壁，长度覆盖整段楼梯
        holes.push({ x0: -10, x1: STAIR_X.x1, z0: s.z0, z1: s.z1 });
      }
      this._slab(lv, holes, lv === 0 ? C.floorDark : C.floor);
    }
    // 屋顶（3F 顶棚）：整块，只扣电梯井（电梯到 3F 为止，井口上方封闭）
    const roofY = LEVELS[3] + HOUSE.H;
    this._slabBox(-10.3, 10.3, -8.3, 8.3, roofY, 0.2, C.ceiling, [
      { x0: SHAFT.x0 - 0.1, x1: SHAFT.x1 + 0.1, z0: SHAFT.z0 - 0.1, z1: SHAFT.z1 + 0.1 },
    ]);
  }

  _slab(lv, holes, color) {
    this._slabBox(-HOUSE.W / 2, HOUSE.W / 2, -HOUSE.D / 2, HOUSE.D / 2, LEVELS[lv], HOUSE.SLAB, color, holes);
  }

  /** 把一块矩形板扣掉若干矩形洞后，用网格切分成若干实心盒（一次性进桶合并） */
  _slabBox(x0, x1, z0, z1, yTop, thick, color, holes) {
    const xs = [x0, x1];
    const zs = [z0, z1];
    for (const h of holes || []) {
      xs.push(clamp(h.x0, x0, x1), clamp(h.x1, x0, x1));
      zs.push(clamp(h.z0, z0, z1), clamp(h.z1, z0, z1));
    }
    const ux = [...new Set(xs)].sort((a, b) => a - b);
    const uz = [...new Set(zs)].sort((a, b) => a - b);
    for (let i = 0; i < ux.length - 1; i += 1) {
      for (let j = 0; j < uz.length - 1; j += 1) {
        const ax = ux[i], bx = ux[i + 1], az = uz[j], bz = uz[j + 1];
        if (bx - ax < 0.02 || bz - az < 0.02) continue;
        const cx = (ax + bx) / 2, cz = (az + bz) / 2;
        let inHole = false;
        for (const h of holes || []) {
          if (cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1) { inHole = true; break; }
        }
        if (inHole) continue;
        // 楼板两层：白色顶棚层 + 上方地板层，错缝叠合（不共面、不留缝）
        const ft = thick - 0.04;
        this._box('floor', bx - ax, ft, bz - az, cx, yTop - ft / 2, cz, color);
        this._box('plain', bx - ax, 0.05, bz - az, cx, yTop - thick + 0.02, cz, C.ceiling);
      }
    }
  }

  /** 四面外墙：逐层建，按门窗洞分段；碰撞分成“全局段 + 分层段”两套 */
  _buildOuterWalls() {
    const W = HOUSE.W, D = HOUSE.D;
    const halfW = W / 2, halfD = D / 2;
    const southDoor = [{ a0: -1.6, a1: 1.6, h: 2.4, sill: 0, glass: false }];
    // 【v3】1F 入户门现在是“关着的玻璃门”：别墅已经盖进都会区，门外就是真实街道，
    // 若留成敞口，玩家能从屋里直接走到大街上（大厅 WASD 此时是关的，会露馅）。
    // 2F/3F 的南门通向阳台，保持可走。
    const southDoorGlass = [{ a0: -1.6, a1: 1.6, h: 2.4, sill: 0, glass: true }];
    const winN = [{ a0: -2.4, a1: 2.4, h: 2.5, sill: 0.95, glass: true }];

    for (let lv = 0; lv < 4; lv += 1) {
      const y = LEVELS[lv];
      const color = lv === 0 ? C.concrete : C.wall;
      // 南墙（z=+8）：2F/3F 留阳台门洞；1F 是玻璃门；B1 只留一扇小窗
      this._wallRun('z', halfD, -halfW, halfW, y, WALL_H,
        lv === 0 ? [{ a0: -1.2, a1: 1.2, h: 1.8, sill: 1.0, glass: true }]
          : (lv === 1 ? southDoorGlass : southDoor), color);
      // 北墙（z=-8）：1F..3F 窗
      this._wallRun('z', -halfD, -halfW, halfW, y, WALL_H, lv === 0 ? [] : winN, color);
      // 西墙（x=-10）：楼梯井采光窗（只有楼梯竖井那一竖条）
      this._wallRun('x', -halfW, -halfD, halfD, y, WALL_H,
        lv === 0 ? [] : [{ a0: -1.2, a1: 1.2, h: 2.4, sill: 0.6, glass: true }], color);
      // 东墙（x=+10）：2F/3F 侧窗
      this._wallRun('x', halfW, -halfD, halfD, y, WALL_H,
        lv >= 2 ? [{ a0: 0.0, a1: 3.6, h: 2.4, sill: 1.0, glass: true }] : [], color);
    }

    // ---- 碰撞 ----
    // 全局：除南墙正中那段（x∈[-3.6,3.6]）以外，四面外墙对所有层生效
    this._block(-halfW - 1, -halfW + HOUSE.WALL, -halfD, halfD);        // 西
    this._block(halfW - HOUSE.WALL, halfW + 1, -halfD, halfD);          // 东
    this._block(-halfW, halfW, -halfD - 1, -halfD + HOUSE.WALL);        // 北
    this._block(-halfW, -BALCONY.x1, halfD - HOUSE.WALL, halfD + 1);    // 南（西段）
    this._block(BALCONY.x1, halfW, halfD - HOUSE.WALL, halfD + 1);      // 南（东段）
    // 分层：南墙正中 x∈[-3.6,3.6]，2F/3F 留出阳台门洞；B1、1F 封死
    for (let lv = 0; lv < 4; lv += 1) {
      if (lv === 0 || lv === 1) this._fb(lv, BALCONY.x0, BALCONY.x1, halfD - HOUSE.WALL, halfD);
      else {
        this._fb(lv, BALCONY.x0, -1.6, halfD - HOUSE.WALL, halfD);
        this._fb(lv, 1.6, BALCONY.x1, halfD - HOUSE.WALL, halfD);
      }
    }
  }

  /**
   * 一面墙按洞口分段。axis='z' 表示墙沿 x 展开、固定在某个 z；
   * axis='x' 表示墙沿 z 展开、固定在某个 x。
   * opening: {a0,a1,h,sill,glass}，h/sill 相对本层地板。
   */
  _wallRun(axis, at, a0, a1, yBase, h, openings, color) {
    const T = HOUSE.WALL;
    // 墙体上下各嵌进楼板 0.04m：避免“墙底/墙顶与楼板面共面”引起的逐像素闪烁
    const yb = yBase - 0.04;
    const yt = yBase + h + 0.04;
    const put = (lo, hi, y0, hh, col = color) => {
      if (hi - lo < 0.02 || hh < 0.02) return;
      if (axis === 'z') this._box('plain', hi - lo, hh, T, (lo + hi) / 2, y0 + hh / 2, at, col);
      else this._box('plain', T, hh, hi - lo, at, y0 + hh / 2, (lo + hi) / 2, col);
    };
    const ops = (openings || []).slice().sort((p, q) => p.a0 - q.a0);
    let cur = a0;
    for (const op of ops) {
      const lo = Math.max(a0, op.a0);
      const hi = Math.min(a1, op.a1);
      if (lo > cur) put(cur, lo, yb, yt - yb);
      // 洞上过梁
      put(lo, hi, yBase + op.h, yt - (yBase + op.h));
      // 窗台
      if (op.sill > 0) put(lo, hi, yb, yBase + op.sill - yb);
      // 玻璃（嵌在洞口里，不与墙面共面）
      if (op.glass) {
        const gh = op.h - op.sill;
        if (axis === 'z') this._box('glass', hi - lo, gh, 0.05, (lo + hi) / 2, yBase + op.sill + gh / 2, at, C.glass);
        else this._box('glass', 0.05, gh, hi - lo, at, yBase + op.sill + gh / 2, (lo + hi) / 2, C.glass);
      }
      // 门/窗框
      put(lo, hi, yBase + op.h - 0.06, 0.06, C.trim);
      cur = hi;
    }
    if (cur < a1) put(cur, a1, yb, yt - yb);
  }

  /**
   * 楼梯井东侧栏板（不再是实心墙）：玻璃 + 金属压顶，站在大厅就能看见楼梯；
   * 碰撞依旧把这条竖线封死，只在各层 1m 平台处留出入口 → 严格卡住、不会掉下去。
   */
  _buildStairShafts() {
    const R = 1.05;      // 栏板高
    const X = STAIR_X.x1;
    // 每段楼梯：本层（出发层）地板上立一道玻璃栏板，上层（到达层）在楼板洞口处再立一道，
    // 但【到达层要留 1.1m 平台口】给玩家走出楼梯 —— 这就是「上楼一扭头就没了」和
    // 「3F 楼梯口被柜子/墙挡住」的真正修复点：出口永远 ≥1.1m，且只在到达层放行。
    const runs = STAIRS;
    for (const s of runs) {
      const yLow = LEVELS[s.k];
      const yHigh = LEVELS[s.k + 1];
      const cz = (s.z0 + s.z1) / 2;
      const len = s.z1 - s.z0;

      // ① 出发层：整段栏板（视觉 + 碰撞）
      this._box('glass', 0.03, R - 0.12, len, X, yLow + (R - 0.12) / 2 + 0.02, cz, C.glass);
      this._box('metal', 0.1, 0.05, len + 0.02, X, yLow + R, cz, C.metal);
      for (const zz of [s.z0 + 0.12, cz, s.z1 - 0.12]) {
        this._box('metal', 0.06, R - 0.1, 0.06, X, yLow + (R - 0.1) / 2, zz, C.metal);
      }
      this._fb(s.k, X - 0.04, X + 0.16, s.z0, s.z1);

      // ② 到达层：楼板洞口护栏（末端 1.1m 不放，留作平台进出口）
      const openZ = 1.1;
      const gz0 = s.z0;
      const gz1 = s.z1 - openZ;
      const gl = gz1 - gz0;
      if (gl > 0.2) {
        const gcz = (gz0 + gz1) / 2;
        this._box('glass', 0.03, R - 0.12, gl, X, yHigh + (R - 0.12) / 2 + 0.02, gcz, C.glass);
        this._box('metal', 0.1, 0.05, gl + 0.02, X, yHigh + R, gcz, C.metal);
        for (const zz of [gz0 + 0.12, gcz, gz1 - 0.12]) {
          this._box('metal', 0.06, R - 0.1, 0.06, X, yHigh + (R - 0.1) / 2, zz, C.metal);
        }
        this._fb(s.k + 1, X - 0.04, X + 0.16, gz0, gz1);
      }
      // 平台口的“扶手端头”，明确提示这里是进出口
      this._box('metal', 0.14, 0.12, 0.14, X, yLow + R, s.z0, C.trim);
      this._box('metal', 0.14, 0.12, 0.14, X, yHigh + R, s.z1, C.trim);
    }
  }

  /** 三段楼梯：实体台阶（从本层地板堆到台阶顶面，不留悬空踏面） */
  _buildStairs() {
    const steps = 15;
    const xw = STAIR_X.x1 - STAIR_X.x0;
    const cx = (STAIR_X.x0 + STAIR_X.x1) / 2;
    for (const s of STAIRS) {
      const yLow = LEVELS[s.k];
      const yHigh = LEVELS[s.k + 1];
      const rise = (yHigh - yLow) / steps;
      const run = (s.z1 - s.z0) / steps;
      for (let i = 0; i < steps; i += 1) {
        const z0 = s.z0 + i * run;
        const yTop = yLow + (i + 1) * rise;
        const hh = yTop - yLow;
        this._box('floor', xw, hh, run + 0.01, cx, yLow + hh / 2, z0 + run / 2, C.wood);
        // 踏面板（浅色，盖住台阶顶面 0.01m，错缝不进同一个面）
        this._box('plain', xw - 0.1, 0.04, run - 0.02, cx, yTop + 0.01, z0 + run / 2, C.floor);
        // 踏面前沿防滑条 + 鼻线（深色，让每一级都看得清）
        this._box('trim', xw - 0.12, 0.025, 0.05, cx, yTop + 0.028, z0 + run - 0.04, C.woodDark);
      }
      // 东西两侧扶手（斜置细杆）+ 东侧立柱，视觉上把楼梯“夹住”
      const slope = Math.atan2(yHigh - yLow, s.z1 - s.z0);
      const len = Math.hypot(s.z1 - s.z0, yHigh - yLow);
      for (const x of [STAIR_X.x0 + 0.06, STAIR_X.x1 - 0.06]) {
        const g = new THREE.BoxGeometry(0.06, 0.06, len);
        g.rotateX(-slope);
        g.translate(x, (yLow + yHigh) / 2 + 0.95, (s.z0 + s.z1) / 2);
        this._push('metal', g, C.metal);
      }
      // 东侧立柱（顶端与斜扶手对齐，底端落在踏步上）
      for (const t of [0.04, 0.5, 0.96]) {
        const zz = s.z0 + t * (s.z1 - s.z0);
        const yy = yLow + t * (yHigh - yLow);
        this._box('metal', 0.05, 0.92, 0.05, STAIR_X.x1 - 0.06, yy + 0.46, zz, C.metal);
      }
    }
  }

  /** 电梯井：三面井壁 + 南面每层开门，井口南侧无轿厢时由动态挡板封住 */
  _buildElevatorShaft() {
    const { x0, x1, z0, z1 } = SHAFT;
    const yLow = LEVELS[0];
    const top = LEVELS[3] + HOUSE.H;
    const h = top - yLow;
    const cy = yLow + h / 2;
    const T = 0.18;
    this._box('plain', T, h, z1 - z0, x0 + T / 2, cy, (z0 + z1) / 2, C.wallAccent);
    this._box('plain', T, h, z1 - z0, x1 - T / 2, cy, (z0 + z1) / 2, C.wallAccent);
    this._box('plain', x1 - x0, h, T, (x0 + x1) / 2, cy, z0 + T / 2, C.wallAccent);

    // 南面：每层在门洞两侧 + 过梁处补墙（中间 1.35m 是电梯门）
    const doorX0 = (x0 + x1) / 2 - 0.68;
    const doorX1 = (x0 + x1) / 2 + 0.68;
    for (let lv = 0; lv < 4; lv += 1) {
      const y = LEVELS[lv];
      this._box('plain', doorX0 - x0, WALL_H, T, (x0 + doorX0) / 2, y + WALL_H / 2, z1 - T / 2, C.wallAccent);
      this._box('plain', x1 - doorX1, WALL_H, T, (doorX1 + x1) / 2, y + WALL_H / 2, z1 - T / 2, C.wallAccent);
      this._box('plain', doorX1 - doorX0, WALL_H - 2.3, T, (doorX0 + doorX1) / 2,
        y + 2.3 + (WALL_H - 2.3) / 2, z1 - T / 2, C.wallAccent);
      // 层牌（发光）
      this._box('emissive', 0.46, 0.3, 0.04, x1 + 0.14, y + 1.9, z1 - 0.1, lv === 1 ? 0x66ddaa : 0x445566);
      // 门套
      this._box('metal', 0.06, 2.3, 0.08, doorX0, y + 1.15, z1 - 0.06, C.trim);
      this._box('metal', 0.06, 2.3, 0.08, doorX1, y + 1.15, z1 - 0.06, C.trim);
    }
    // 井壁碰撞（三面）
    this._block(x0 - 0.2, x0 + 0.2, z0, z1);
    this._block(x1 - 0.2, x1 + 0.2, z0, z1);
    this._block(x0, x1, z0 - 0.2, z0 + 0.2);
    // 南面两侧挡墙（门洞常开，是否封住由 _walkBoxesByLevel 动态补）
    this._block(x0, doorX0, z1 - 0.2, z1 + 0.2);
    this._block(doorX1, x1, z1 - 0.2, z1 + 0.2);
    this._shaftDoor = { x0: doorX0, x1: doorX1, z0: z1 - 0.12, z1: z1 + 0.12 };
  }

  /** 2F / 3F 南向阳台：楼板 + 玻璃栏杆 + 分层碰撞，真的能走出去 */
  _buildBalconies() {
    // 只做 2F / 3F；1F 南门直接通向院子（地面齐平，不需要栏板）
    for (let lv = 2; lv <= 3; lv += 1) {
      const y = LEVELS[lv];
      const depth = BALCONY.z1 - BALCONY.z0;
      const w = BALCONY.x1 - BALCONY.x0;
      // 阳台板（顶面与楼层齐平；z 向严格从 8.0 起，不与室内楼板重叠共面）
      this._box('floor', w + 0.2, 0.18, depth, 0, y - 0.09, (BALCONY.z0 + BALCONY.z1) / 2, C.floor);
      // 栏板：三面（南 + 东西），玻璃 + 金属压顶
      const railH = 1.05;
      this._box('glass', w, railH - 0.12, 0.05, 0, y + (railH - 0.12) / 2, BALCONY.z1 - 0.1, C.glass);
      this._box('metal', w + 0.1, 0.06, 0.1, 0, y + railH, BALCONY.z1 - 0.1, C.metal);
      for (const sx of [-1, 1]) {
        this._box('glass', 0.05, railH - 0.12, depth, sx * (BALCONY.x1 - 0.05), y + (railH - 0.12) / 2,
          (BALCONY.z0 + BALCONY.z1) / 2, C.glass);
        this._box('metal', 0.1, 0.06, depth + 0.1, sx * (BALCONY.x1 - 0.05), y + railH,
          (BALCONY.z0 + BALCONY.z1) / 2, C.metal);
      }
      // 立柱
      for (const px of [BALCONY.x0 + 0.05, 0, BALCONY.x1 - 0.05]) {
        this._box('metal', 0.08, railH, 0.08, px, y + railH / 2, BALCONY.z1 - 0.1, C.metal);
      }
      // 分层碰撞：南栏板 + 两条侧栏板
      this._fb(lv, BALCONY.x0 - 0.1, BALCONY.x1 + 0.1, BALCONY.z1 - 0.2, BALCONY.z1 + 0.1);
      this._fb(lv, BALCONY.x0 - 0.2, BALCONY.x0, BALCONY.z0 - 0.1, BALCONY.z1);
      this._fb(lv, BALCONY.x1, BALCONY.x1 + 0.2, BALCONY.z0 - 0.1, BALCONY.z1);
      // 阳台家具：每层不一样（2F 会客、3F 躺椅）
      if (lv === 2) {
        this._table(y, 0.4, 9.6, 1.0, 0.6, 0.42, C.woodDark);
        this._chair(y, -0.8, 9.5, -Math.PI / 2);
        this._chair(y, 1.6, 9.5, Math.PI / 2);
        this._plant(y, 2.9, 10.3, 1.0);
        this._plant(y, -2.9, 10.3, 0.9);
      } else if (lv === 3) {
        for (const dx of [-1.4, 1.4]) {
          this._box('fabric', 0.7, 0.18, 1.7, dx, y + 0.26, 9.5, C.fabricLight, 0);
          this._box('plain', 0.7, 0.34, 0.18, dx, y + 0.5, 8.7, C.woodDark, 0);
        }
        this._table(y, 0, 9.8, 0.5, 0.5, 0.4, C.wood);
        this._plant(y, 3.0, 10.3, 1.1);
        this._plant(y, -3.0, 10.3, 1.0);
      }
      // 阳台照明
      this._box('emissive', 0.34, 0.34, 0.2, 0, y + 2.9, 8.5, C.warm);
    }
  }

  /* 【v3】院子 / 天空 / 远景剪影已整体删除：别墅并入了大厅真实坐标，
     窗外看到的就是都会区的街道、大都会与草坪，不再自建一套假环境。 */

  /* ======================================================================== */
  /* 家具（按真实别墅分区，四层不重复）                                        */
  /* ======================================================================== */
  _buildFurniture() {
    this._furnitureCount = 0;
    this._furnishB1();
    this._furnish1F();
    this._furnish2F();
    this._furnish3F();
  }

  _f() { this._furnitureCount += 1; }

  /** 低矮隔断（1.1m，不挡视线，挡人是够的） */
  _partition(lv, x0, x1, z0, z1, h = 1.1, color = C.wallAccent) {
    const y = LEVELS[lv];
    this._box('plain', x1 - x0, h, z1 - z0, (x0 + x1) / 2, y + h / 2, (z0 + z1) / 2, color);
    this._fb(lv, x0, x1, z0, z1);
    this._f();
  }

  /** 房间实墙（2.6m）带门洞：axis='z' 墙沿 x 展开 */
  _roomWall(lv, axis, at, a0, a1, doorA0 = null, doorA1 = null, color = C.wall) {
    const y = LEVELS[lv];
    const T = 0.14;
    const h = 2.6;
    const put = (lo, hi, y0, hh) => {
      if (hi - lo < 0.02) return;
      if (axis === 'z') this._box('plain', hi - lo, hh, T, (lo + hi) / 2, y0 + hh / 2, at, color);
      else this._box('plain', T, hh, hi - lo, at, y0 + hh / 2, (lo + hi) / 2, color);
    };
    if (doorA0 == null) {
      put(a0, a1, y, h);
      if (axis === 'z') this._fb(lv, a0, a1, at - T / 2, at + T / 2);
      else this._fb(lv, at - T / 2, at + T / 2, a0, a1);
      return;
    }
    put(a0, doorA0, y, h);
    put(doorA1, a1, y, h);
    put(doorA0, doorA1, y + 2.15, h - 2.15);
    if (axis === 'z') {
      this._fb(lv, a0, doorA0, at - T / 2, at + T / 2);
      this._fb(lv, doorA1, a1, at - T / 2, at + T / 2);
    } else {
      this._fb(lv, at - T / 2, at + T / 2, a0, doorA0);
      this._fb(lv, at - T / 2, at + T / 2, doorA1, a1);
    }
  }

  /* ---------- 通用家具构件（全部相对所在层地板 y） ---------- */

  _sofa(y, cx, cz, ry = 0, color = C.fabric, w = 2.8) {
    const rot = (dx, dz) => ({
      x: cx + dx * Math.cos(ry) + dz * Math.sin(ry),
      z: cz - dx * Math.sin(ry) + dz * Math.cos(ry),
    });
    const p = rot(0, 0);
    this._box('fabric', w, 0.42, 1.0, p.x, y + 0.32, p.z, color, ry); this._f();
    const b = rot(0, -0.44);
    this._box('fabric', w, 0.72, 0.2, b.x, y + 0.72, b.z, color, ry); this._f();
    for (const s of [-1, 1]) {
      const a = rot(s * (w / 2 - 0.12), 0);
      this._box('fabric', 0.22, 0.52, 1.0, a.x, y + 0.56, a.z, color, ry); this._f();
    }
  }

  _armchair(y, cx, cz, ry = 0, color = C.fabricLight) {
    this._box('fabric', 0.8, 0.42, 0.8, cx, y + 0.32, cz, color, ry); this._f();
    const bz = cz - 0.34 * Math.cos(ry);
    this._box('fabric', 0.8, 0.6, 0.16, cx + 0.34 * Math.sin(ry), y + 0.62, bz, color, ry); this._f();
  }

  _table(y, cx, cz, w = 1.4, d = 0.8, h = 0.75, color = C.wood) {
    this._box('plain', w, 0.08, d, cx, y + h, cz, color); this._f();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this._box('metal', 0.07, h, 0.07, cx + sx * (w / 2 - 0.1), y + h / 2, cz + sz * (d / 2 - 0.1), C.trim);
    }
  }

  _chair(y, cx, cz, ry = 0, color = C.wood) {
    this._box('plain', 0.46, 0.07, 0.46, cx, y + 0.45, cz, color, ry); this._f();
    this._box('plain', 0.46, 0.5, 0.07, cx + Math.sin(ry) * -0.2, y + 0.72, cz - Math.cos(ry) * 0.2, color, ry); this._f();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this._box('metal', 0.04, 0.45, 0.04, cx + sx * 0.18, y + 0.22, cz + sz * 0.18, C.trim);
    }
  }

  _bed(y, cx, cz, w = 1.8, d = 2.1, color = C.woodDark) {
    this._box('plain', w, 0.38, d, cx, y + 0.24, cz, color); this._f();
    this._box('fabric', w - 0.08, 0.24, d - 0.12, cx, y + 0.55, cz, C.white); this._f();
    this._box('fabric', w - 0.26, 0.12, 0.52, cx, y + 0.72, cz - d / 2 + 0.36, C.fabricLight); this._f();
    this._box('plain', w + 0.24, 0.86, 0.1, cx, y + 0.66, cz - d / 2 - 0.02, color); this._f();
  }

  _cabinet(y, cx, cz, w = 1.6, h = 2.1, d = 0.55, color = C.woodDark) {
    this._box('plain', w, h, d, cx, y + h / 2, cz, color); this._f();
    for (let i = 1; i < 4; i += 1) this._box('metal', w - 0.06, 0.02, 0.01, cx, y + (h / 4) * i, cz + d / 2 + 0.008, C.trim);
    this._box('metal', 0.03, 0.22, 0.03, cx - w / 4, y + h / 2, cz + d / 2 + 0.02, C.metal);
  }

  _plant(y, cx, cz, scale = 1) {
    const s = scale;
    // 陶盆（上大下小）+ 盆土
    this._cyl('plain', 0.22 * s, 0.15 * s, 0.4 * s, 10, cx, y + 0.2 * s, cz, C.woodDark); this._f();
    this._cyl('plain', 0.19 * s, 0.19 * s, 0.03 * s, 10, cx, y + 0.4 * s, cz, C.stone);
    // 主干 + 一簇球形叶团（比旧版的“几片绿板”更像绿植）
    this._cyl('fabric', 0.035 * s, 0.05 * s, 0.55 * s, 6, cx, y + 0.68 * s, cz, C.greenDark);
    const nodes = [
      [0, 0.95, 0, 0.34], [0.2, 0.85, 0.1, 0.22], [-0.18, 0.88, -0.12, 0.24],
      [0.05, 0.78, -0.22, 0.2], [-0.1, 1.08, 0.06, 0.18],
    ];
    for (const [dx, dy, dz, r] of nodes) {
      const g = new THREE.SphereGeometry(r * s, 9, 7);
      g.translate(cx + dx * s, y + dy * s, cz + dz * s);
      this._push('fabric', g, C.green);
    }
  }

  _lamp(y, cx, cz) {
    this._cyl('metal', 0.03, 0.03, 1.45, 8, cx, y + 0.72, cz, C.trim); this._f();
    this._cyl('emissive', 0.2, 0.28, 0.26, 10, cx, y + 1.52, cz, C.warm); this._f();
  }

  /** 吊灯（餐厅/吧台上方，往下吊 1.0m） */
  _pendant(y, cx, cz, h = 1.0, color = C.warm) {
    // 吊线从顶棚一直拉到灯罩（顶部嵌进楼板 0.02，不留悬空缝）
    this._cyl('metal', 0.02, 0.02, 0.72, 6, cx, y + 3.06, cz, C.trim);
    this._cyl('emissive', 0.26, 0.3, 0.2, 10, cx, y + 3.06 - 0.4, cz, color);
    this._f();
  }

  /** 吸顶灯（发光板，贴着楼板底但不是同一平面） */
  _ceilingLight(y, cx, cz, w = 1.2, d = 0.4) {
    this._box('emissive', w, 0.05, d, cx, y + WALL_H - 0.1, cz, C.warm);
  }

  _rug(y, cx, cz, w = 4.4, d = 3.2, color = C.fabricLight) {
    this._box('fabric', w, 0.03, d, cx, y + 0.02, cz, color);
  }

  _art(y, cx, cz, w, h, color, axis = 'z', at = null) {
    if (axis === 'z') this._box('plain', w, h, 0.04, cx, y + 1.7, at, color);
    else this._box('plain', 0.04, h, w, at, y + 1.7, cz, color);
  }

  /* ---------- B1：车库 + 洗衣房 + 储藏 + 设备 ---------- */
  _furnishB1() {
    const y = LEVELS[0];
    // 车位线与两辆车
    for (const x of [-3.6, 2.4]) {
      this._box('emissive', 2.5, 0.02, 0.08, x, y + 0.02, -2.0, 0xd8d8c8);
      this._box('emissive', 2.5, 0.02, 0.08, x, y + 0.02, 2.8, 0xd8d8c8);
    }
    this._staticCar(y, -3.6, 0.4, 0x3d6a86, 'sedan');
    this._staticCar(y, 2.4, 0.4, 0x8a3f3f, 'suv');

    // 工作台 + 工具墙（北侧）
    this._box('plain', 6.0, 0.1, 0.7, -1.4, y + 0.92, -7.2, C.woodDark); this._f();
    for (const x of [-4.2, 1.2]) this._box('metal', 0.08, 0.9, 0.08, x, y + 0.45, -7.2, C.trim);
    this._box('plain', 6.0, 1.2, 0.06, -1.4, y + 1.8, -7.55, C.metal);
    for (let i = 0; i < 5; i += 1) {
      this._box('metal', 0.05, 0.5 + (i % 3) * 0.12, 0.05, -4.0 + i * 1.1, y + 1.9, -7.5, C.trim);
    }
    this._fb(0, -4.5, 1.6, -7.6, -6.9);

    // 洗衣房（东南角）：洗衣机 + 烘干机 + 洗衣池 + 晾衣架 + 篮子
    const lx = 7.0;
    for (const [dx, col] of [[0, C.white], [1.25, C.white]]) {
      this._box('plain', 0.75, 0.85, 0.7, lx + dx, y + 0.42, -1.0, col); this._f();
      this._cyl('glass', 0.24, 0.24, 0.06, 14, lx + dx, y + 0.5, -0.62, C.glass, Math.PI / 2, 0);
      this._box('metal', 0.6, 0.04, 0.02, lx + dx, y + 0.8, -0.63, C.metal);
    }
    this._box('plain', 0.9, 0.9, 0.6, 9.2, y + 0.45, -2.4, C.tile); this._f();
    this._box('metal', 0.5, 0.06, 0.4, 9.2, y + 0.9, -2.4, C.metal);
    this._fb(0, 6.5, 9.7, -2.9, -0.5);
    // 晾衣架（两根杆 + 几件衣服）
    this._box('metal', 0.05, 1.9, 0.05, 7.0, y + 0.95, 1.9, C.metal);
    this._box('metal', 0.05, 1.9, 0.05, 9.4, y + 0.95, 1.9, C.metal);
    this._box('metal', 2.5, 0.05, 0.05, 8.2, y + 1.9, 1.9, C.metal);
    for (const [dx, col] of [[-0.6, C.blue], [0.0, C.white], [0.6, C.red]]) {
      this._box('fabric', 0.5, 0.8, 0.04, 8.2 + dx, y + 1.45, 1.9, col);
    }

    // 储物架（东墙）+ 纸箱/工具箱
    for (let i = 0; i < 3; i += 1) this._box('metal', 0.45, 0.05, 3.2, 9.6, y + 0.6 + i * 0.7, 4.0, C.metal);
    for (const [dz, col] of [[3.0, C.wood], [4.0, C.stone], [5.0, C.wood]]) {
      this._box('plain', 0.5, 0.45, 0.8, 9.6, y + 1.0, dz, col);
    }
    this._fb(0, 9.2, 9.8, 2.4, 5.6);

    // 设备间（西侧）：热水器 + 配电箱
    this._cyl('metal', 0.42, 0.42, 1.5, 12, -5.8, y + 0.95, -6.3, C.white);
    this._box('plain', 0.6, 0.8, 0.25, -5.8, y + 1.7, -7.3, C.trim); this._f();
    this._fb(0, -6.3, -5.3, -6.7, -5.9);

    // 车库顶灯 + 地面标识
    for (const [cx, cz] of [[-3.6, 0.4], [2.4, 0.4], [7.8, -1.0]]) this._ceilingLight(y, cx, cz, 1.6, 0.4);
    this._box('emissive', 3.0, 0.04, 0.3, 0, y + 2.7, -3.6, 0x9fd8c8);
  }

  /** 静态展示车（复用盒/柱几何，不加载 Rapier）：轿车 / SUV 两种比例 */
  _staticCar(y, cx, cz, color, kind) {
    const suv = kind === 'suv';
    const bodyH = suv ? 0.85 : 0.62, bodyW = 1.9, bodyL = suv ? 4.4 : 4.2;
    this._box('metal', bodyW, bodyH, bodyL, cx, y + 0.55 + bodyH / 2, cz, color); this._f();
    this._box('glass', bodyW - 0.24, suv ? 0.85 : 0.62, bodyL * 0.46,
      cx, y + 0.55 + bodyH + (suv ? 0.4 : 0.3), cz - 0.15, C.glass); this._f();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const g = new THREE.CylinderGeometry(suv ? 0.42 : 0.36, suv ? 0.42 : 0.36, 0.22, 12);
      g.rotateZ(Math.PI / 2);
      g.translate(cx + sx * (bodyW / 2 - 0.05), y + (suv ? 0.42 : 0.36), cz + sz * (bodyL / 2 - 0.75));
      this._push('plain', g, C.black);
    }
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      this._box('emissive', 0.26, 0.12, 0.05, cx + sx * 0.6, y + 0.92, cz + sz * (bodyL / 2 + 0.02),
        sz < 0 ? 0xfff3d0 : 0xc8322a);
    }
    this._fb(0, cx - bodyW / 2, cx + bodyW / 2, cz - bodyL / 2, cz + bodyL / 2);
  }

  /* ---------- 1F：玄关 / 客厅 / 餐厨 / 客卫 / 家政 ---------- */
  _furnish1F() {
    const y = LEVELS[1];

    // 玄关
    this._box('plain', 1.9, 0.92, 0.5, -2.5, y + 0.46, 7.4, C.wood); this._f();
    this._fb(1, -3.5, -1.5, 7.1, 7.7);
    this._box('fabric', 1.0, 0.45, 0.42, 1.8, y + 0.24, 7.4, C.fabric); this._f();
    this._box('glass', 1.3, 1.1, 0.04, 3.6, y + 1.7, 7.86, C.glass); // 穿衣镜
    this._cyl('metal', 0.04, 0.04, 1.7, 8, -5.5, y + 0.85, 7.3, C.trim);
    this._box('plain', 0.9, 0.35, 0.06, -6.0, y + 1.55, 7.3, C.wood); // 挂衣杆

    // 客厅（电视墙把它和北侧餐厅隔开，避免电视悬空）
    this._roomWall(1, 'z', -3.9, -4.9, -1.4, null, null, C.wall);
    this._rug(y, -3.2, 0.7, 5.2, 3.8);
    this._sofa(y, -3.2, 2.9, Math.PI, C.fabric, 3.0);
    this._fb(1, -4.8, -1.6, 2.4, 3.4);
    this._table(y, -3.2, 0.4, 1.6, 0.9, 0.42, C.woodDark);
    this._fb(1, -4.0, -2.4, -0.05, 0.85);
    this._box('plain', 3.0, 0.5, 0.5, -3.2, y + 0.3, -3.6, C.woodDark); this._f(); // 电视柜
    this._fb(1, -4.7, -1.7, -3.85, -3.35);
    this._armchair(y, 0.6, 1.2, Math.PI - 0.6, C.fabric);
    this._fb(1, 0.0, 1.2, 0.6, 1.8);
    this._lamp(y, -6.0, 4.6);
    this._plant(y, -6.1, -2.6, 1.05);
    this._plant(y, 4.2, 6.6, 0.9);
    this._ceilingLight(y, -3.0, 1.2, 2.4, 0.5);

    // 厨房（北墙一字型 + 中岛）
    this._box('plain', 5.6, 0.9, 0.66, 2.8, y + 0.45, -7.3, C.woodDark); this._f();
    this._box('metal', 5.7, 0.06, 0.72, 2.8, y + 0.93, -7.3, C.metal);
    this._fb(1, -0.1, 5.7, -7.7, -6.95);
    // 中岛
    this._box('plain', 2.0, 0.9, 0.9, 2.3, y + 0.45, -5.4, C.wood); this._f();
    this._box('metal', 2.1, 0.06, 1.0, 2.3, y + 0.93, -5.4, C.metal);
    this._fb(1, 1.2, 3.4, -5.9, -4.9);
    // 灶台 + 锅 + 抽油烟机
    this._box('black', 0.7, 0.04, 0.55, 1.1, y + 0.97, -7.3, C.black);
    for (const [dx, dz] of [[-0.16, -0.14], [0.16, -0.14], [-0.16, 0.14], [0.16, 0.14]]) {
      this._cyl('metal', 0.08, 0.08, 0.02, 10, 1.1 + dx, y + 1.0, -7.3 + dz, C.trim);
    }
    this._cyl('metal', 0.2, 0.16, 0.22, 12, 1.1, y + 1.13, -7.3, C.metal);
    this._box('metal', 0.8, 0.5, 0.5, 1.1, y + 2.1, -7.5, C.metal);
    // 水槽 + 龙头
    this._box('metal', 0.7, 0.04, 0.5, 3.6, y + 0.95, -7.3, C.metal);
    this._box('metal', 0.04, 0.3, 0.04, 3.6, y + 1.1, -7.55, C.metal);
    // 菜刀架 + 三把刀（用户点名要的“菜刀”）
    this._box('plain', 0.26, 0.12, 0.22, 4.6, y + 1.01, -7.3, C.woodDark); this._f();
    for (let i = 0; i < 3; i += 1) {
      this._box('metal', 0.03, 0.26, 0.008, 4.54 + i * 0.06, y + 1.19, -7.3, 0xcfd6da);
      this._box('plain', 0.05, 0.09, 0.03, 4.54 + i * 0.06, y + 1.34, -7.3, C.trim);
    }
    // 砧板 + 调料瓶
    this._box('plain', 0.4, 0.03, 0.28, 4.15, y + 1.0, -7.3, C.wood);
    for (let i = 0; i < 3; i += 1) this._cyl('plain', 0.03, 0.03, 0.14, 8, 4.95 + i * 0.1, y + 1.04, -7.25, i === 0 ? C.red : C.green);
    // 吊柜
    for (let i = 0; i < 3; i += 1) {
      this._box('plain', 1.4, 0.6, 0.34, 0.9 + i * 1.8, y + 2.2, -7.5, C.white);
    }
    // 冰箱（东侧，靠楼梯口以外的位置）
    this._box('metal', 0.92, 1.9, 0.78, 5.3, y + 0.95, -6.6, 0xdfe3e6); this._f();
    this._box('metal', 0.86, 0.02, 0.02, 5.3, y + 1.3, -6.2, C.trim);
    this._box('metal', 0.04, 0.34, 0.04, 5.66, y + 1.72, -6.2, C.metal);
    this._fb(1, 4.8, 5.8, -7.0, -6.2);

    // 餐厅（西北，与厨房同层不同侧）
    this._table(y, -3.2, -5.4, 2.2, 1.0, 0.76, C.wood);
    this._fb(1, -4.4, -2.0, -6.0, -4.8);
    for (const [dx, dz, ry] of [[-0.75, -0.75, 0], [0.75, -0.75, 0], [-0.75, 0.75, Math.PI], [0.75, 0.75, Math.PI], [0, -1.0, 0], [0, 1.0, Math.PI]]) {
      this._chair(y, -3.2 + dx, -5.4 + dz, ry);
    }
    // 岛台上方两盏吊灯（餐厅在电视矮墙后面，改用嵌顶灯，避免只看见吊线）
    this._pendant(y, 1.85, -5.4, 1.0);
    this._pendant(y, 2.75, -5.4, 1.0);
    this._ceilingLight(y, -3.2, -5.4, 1.6, 0.5);
    this._plant(y, -5.8, -6.4, 1.0);

    // 客卫（东南）：实墙 + 门洞 + 马桶/台盆/淋浴
    this._roomWall(1, 'x', 6.6, 1.2, 6.4, 3.4, 4.4);
    this._roomWall(1, 'z', 1.2, 6.6, 9.7, null, null);
    this._roomWall(1, 'z', 6.4, 6.6, 9.7, null, null);
    this._box('white', 1.0, 0.85, 0.5, 7.5, y + 0.42, 3.0, C.white); this._f();
    this._cyl('white', 0.24, 0.24, 0.4, 12, 7.3, y + 0.2, 5.4, C.white);
    this._box('white', 0.5, 0.5, 0.2, 7.3, y + 0.7, 5.6, C.white);
    this._box('glass', 1.2, 2.0, 0.05, 8.7, y + 1.0, 5.0, C.glass);
    this._box('glass', 0.05, 2.0, 1.2, 8.2, y + 1.0, 5.6, C.glass);
    this._box('metal', 0.04, 0.5, 0.04, 8.7, y + 2.1, 4.7, C.metal);
    this._fb(1, 6.9, 8.1, 2.7, 3.35);

    // 家政角（扫地机基站，见 _buildRobot）
    this._box('fabric', 1.6, 0.03, 1.0, -6.0, y + 0.02, -1.2, C.fabricLight);
    this._ceilingLight(y, 2.3, -5.4, 1.6, 0.4);
    this._ceilingLight(y, 8.2, 3.6, 1.2, 0.4);
  }

  /* ---------- 2F：起居 / 健身 / 娱乐 / 浴室 / 阳台 ---------- */
  _furnish2F() {
    const y = LEVELS[2];

    // 起居室（电视墙把它和北侧健身区隔开）
    this._roomWall(2, 'z', -3.8, -4.9, -1.2, null, null, C.wall);
    this._rug(y, -3.4, 1.6, 5.0, 4.6);
    // 沙发往南挪：楼梯口（z 2..3）必须留出 ≥1.3m 的出梯走廊，否则上到 2F 就被顶住
    this._sofa(y, -3.4, 3.9, Math.PI, C.fabricLight, 3.0);
    this._fb(2, -5.0, -1.8, 3.35, 4.45);
    this._table(y, -3.4, 0.9, 1.6, 0.9, 0.42, C.woodDark);
    this._fb(2, -4.2, -2.6, 0.45, 1.35);
    this._box('plain', 2.9, 0.5, 0.5, -3.4, y + 0.3, -3.5, C.woodDark); this._f();
    this._box('black', 2.4, 1.4, 0.08, -3.4, y + 1.5, -3.74, C.black);
    this._box('emissive', 2.2, 1.24, 0.02, -3.4, y + 1.5, -3.69, 0x1a2430);
    this._fb(2, -4.9, -1.9, -3.75, -3.25);
    this._armchair(y, -0.6, 2.2, Math.PI + 0.5, C.fabric);
    this._lamp(y, -5.9, 4.2);
    this._plant(y, 2.6, 6.6, 1.0);
    this._ceilingLight(y, -3.2, 1.0, 2.4, 0.5);

    // 健身区（西北）：跑步机 + 哑铃架 + 瑜伽垫 + 镜墙
    this._box('black', 1.0, 0.12, 2.0, -4.7, y + 0.16, -6.0, C.black); this._f();
    this._box('metal', 0.9, 0.08, 0.1, -4.7, y + 0.9, -6.95, C.metal);
    this._box('metal', 0.06, 1.0, 0.06, -5.1, y + 0.6, -6.95, C.metal);
    this._box('metal', 0.06, 1.0, 0.06, -4.3, y + 0.6, -6.95, C.metal);
    this._box('metal', 0.5, 0.06, 0.1, -4.7, y + 1.1, -6.95, C.trim);
    this._fb(2, -5.3, -4.1, -7.1, -4.9);
    this._box('metal', 1.4, 0.06, 0.35, -1.8, y + 1.2, -6.6, C.metal);
    for (let i = 0; i < 4; i += 1) {
      this._cyl('plain', 0.1, 0.1, 0.36, 8, -2.2 + i * 0.28, y + 0.35, -6.6, C.black, 0, Math.PI / 2);
    }
    this._fb(2, -2.6, -1.0, -6.9, -6.3);
    this._box('fabric', 1.8, 0.03, 0.9, -3.4, y + 0.02, -4.6, 0x9fb7c8);
    this._box('glass', 2.6, 1.8, 0.04, -3.6, y + 1.5, -7.84, C.glass);
    this._ceilingLight(y, -3.6, -5.6, 1.6, 0.4);

    // 娱乐区（东北）：台球桌 + 街机 + 飞镖盘
    this._box('plain', 2.4, 0.12, 1.3, 3.4, y + 0.86, -4.8, C.woodDark); this._f();
    this._box('fabric', 2.1, 0.04, 1.05, 3.4, y + 0.9, -4.8, 0x2e6b4f);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this._box('plain', 0.12, 0.86, 0.12, 3.4 + sx * 1.1, y + 0.43, -4.8 + sz * 0.56, C.woodDark);
    }
    for (const [dx, dz] of [[0, 0], [0.6, -0.3], [-0.5, 0.25], [0.3, 0.3]]) {
      this._box('emissive', 0.08, 0.08, 0.08, 3.4 + dx, y + 0.95, -4.8 + dz, 0xf2e6c8);
    }
    this._fb(2, 2.2, 4.6, -5.5, -4.1);
    this._box('black', 0.8, 1.8, 0.7, 5.6, y + 0.9, -6.9, C.black); this._f();
    this._box('emissive', 0.6, 0.5, 0.02, 5.6, y + 1.2, -6.54, 0x4fd0ff);
    this._fb(2, 5.2, 6.0, -7.3, -6.5);
    this._box('plain', 0.5, 0.5, 0.05, 1.8, y + 1.9, -7.82, C.black);
    this._box('emissive', 0.12, 0.12, 0.02, 1.8, y + 1.9, -7.79, 0xff5a4a);

    // 浴室（东南）：实墙 + 浴缸 + 双台盆 + 淋浴
    this._roomWall(2, 'x', 6.6, -3.6, 6.4, 1.0, 2.0);
    this._roomWall(2, 'z', -3.6, 6.6, 9.7, null, null);
    this._roomWall(2, 'z', 6.4, 6.6, 9.7, null, null);
    this._box('white', 1.8, 0.55, 0.85, 8.2, y + 0.28, -1.5, C.white); this._f();
    this._box('plain', 1.5, 0.06, 0.6, 8.2, y + 0.5, -1.5, C.tile);
    this._box('white', 1.3, 0.8, 0.5, 7.4, y + 0.42, 1.8, C.white); this._f();
    this._box('glass', 0.9, 1.1, 0.04, 7.4, y + 1.6, 1.55, C.glass);
    this._cyl('white', 0.24, 0.24, 0.4, 12, 7.2, y + 0.2, 5.6, C.white);
    this._box('white', 0.5, 0.5, 0.2, 7.2, y + 0.7, 5.8, C.white);
    this._box('glass', 1.3, 2.0, 0.05, 8.6, y + 1.0, 4.9, C.glass);
    this._box('glass', 0.05, 2.0, 1.3, 8.0, y + 1.0, 5.6, C.glass);
    this._fb(2, 7.8, 9.5, 4.5, 6.2);

    // 飘窗/落地灯
    this._ceilingLight(y, 3.8, -4.8, 1.6, 0.4);
    this._ceilingLight(y, 8.2, 1.2, 1.2, 0.4);
  }

  /* ---------- 3F：主卧 / 衣帽间 / 书房 / 主卫 / 露台 ---------- */
  _furnish3F() {
    const y = LEVELS[3];

    // 主卧
    this._rug(y, 0, 3.4, 4.6, 3.4);
    this._bed(y, 0, 2.2, 2.0, 2.2, C.woodDark);
    this._fb(3, -1.2, 1.2, 1.0, 3.4);
    for (const sx of [-1, 1]) {
      this._box('plain', 0.5, 0.5, 0.42, sx * 1.36, y + 0.25, 1.4, C.wood); this._f();
      this._cyl('emissive', 0.09, 0.12, 0.22, 8, sx * 1.36, y + 0.6, 1.4, C.warm);
    }
    this._box('fabric', 1.4, 0.32, 0.5, 0, y + 0.3, 3.9, C.fabric); this._f();
    this._ceilingLight(y, 0, 2.2, 2.2, 0.5);

    // 衣帽间（西侧）：衣柜沿北墙横排 + 试衣镜贴在隔墙上。
    // 【关键】z 5.9~7.7 必须完全空出来 —— 那是 3F 楼梯平台口走出来的走廊，
    // 旧版在这里放了一排 0.6×3.4 的长柜，正好堵死楼梯出口（用户说的“像柜子挡住”）。
    this._box('plain', 2.9, 0.06, 0.72, -5.34, y + 2.12, 3.62, C.wood);   // 衣柜顶板
    for (let i = 0; i < 3; i += 1) {
      const cx = -6.35 + i * 0.92;
      this._box('plain', 0.9, 2.05, 0.62, cx, y + 1.04, 3.62, i === 1 ? C.wood : C.woodDark); this._f();
      this._box('metal', 0.035, 0.03, 0.06, cx + 0.36, y + 1.1, 3.3, C.metal);   // 拉手
      this._box('black', 0.012, 1.95, 0.02, cx + 0.45, y + 1.04, 3.316, C.black); // 门缝
    }
    this._fb(3, -6.8, -3.9, 3.29, 3.95);
    this._box('plain', 0.58, 1.0, 1.15, -4.1, y + 0.5, 5.0, C.wood); this._f();
    this._fb(3, -4.4, -3.8, 4.42, 5.58);
    this._box('glass', 0.04, 1.85, 1.4, -3.5, y + 1.25, 5.15, C.glass);
    // 隔墙缩到 z=6.2，给「衣帽间 ↔ 主卧」留出 1.5m 通道
    this._partition(3, -3.6, -3.45, 3.0, 6.2, 1.15);
    // 书房（东侧）：书桌 + 椅 + 书架
    this._table(y, 5.0, 3.4, 1.9, 0.85, 0.75, C.woodDark);
    this._chair(y, 5.0, 2.35, Math.PI);
    this._fb(3, 3.9, 6.1, 2.95, 3.9);
    for (let i = 0; i < 3; i += 1) {
      this._box('plain', 1.7, 0.06, 0.34, 5.4, y + 0.6 + i * 0.6, 5.7, C.woodDark);
      for (let k = 0; k < 6; k += 1) {
        this._box('plain', 0.07, 0.4, 0.26, 4.7 + k * 0.28, y + 0.83 + i * 0.6, 5.7,
          [C.red, C.blue, C.green, C.warm, C.fabricLight, C.white][k]);
      }
    }
    this._box('plain', 0.07, 2.0, 0.34, 4.5, y + 1.0, 5.7, C.woodDark);
    this._box('plain', 0.07, 2.0, 0.34, 6.3, y + 1.0, 5.7, C.woodDark);
    this._lamp(y, 6.0, 3.4);
    this._fb(3, 4.5, 6.3, 5.4, 6.0);

    // 主卫（东北）
    this._roomWall(3, 'x', 6.6, -3.6, 6.4, 1.6, 2.6);
    this._roomWall(3, 'z', -3.6, 6.6, 9.7, null, null);
    this._roomWall(3, 'z', 6.4, 6.6, 9.7, null, null);
    this._box('white', 1.9, 0.58, 0.9, 8.2, y + 0.3, 0.4, C.white); this._f();
    this._box('plain', 1.6, 0.06, 0.62, 8.2, y + 0.52, 0.4, C.tile);
    this._box('white', 1.2, 0.8, 0.5, 7.4, y + 0.42, 3.2, C.white); this._f();
    this._box('glass', 0.9, 1.1, 0.04, 7.4, y + 1.6, 2.95, C.glass);
    this._box('glass', 1.3, 2.0, 0.05, 8.6, y + 1.0, 5.4, C.glass);
    this._box('glass', 0.05, 2.0, 1.3, 8.0, y + 1.0, 6.0, C.glass);
    this._cyl('white', 0.24, 0.24, 0.4, 12, 7.2, y + 0.2, 5.2, C.white);
    this._fb(3, 7.8, 9.5, 4.8, 6.4);
    this._ceilingLight(y, 8.2, 2.6, 1.2, 0.4);
  }

  /* ======================================================================== */
  /* 电梯                                                                      */
  /* ======================================================================== */
  _buildElevator(register) {
    const { x0, x1, z0, z1 } = SHAFT;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const w = x1 - x0 - 0.34, d = z1 - z0 - 0.34;
    const car = new THREE.Group();
    car.name = 'Villa/elevator-car';
    const floorGeo = this._geo(new THREE.BoxGeometry(w, 0.14, d));
    const wallGeo = this._geo(new THREE.BoxGeometry(w, 2.5, 0.1));
    const sideGeo = this._geo(new THREE.BoxGeometry(0.1, 2.5, d));
    const ceilGeo = this._geo(new THREE.BoxGeometry(w, 0.1, d));
    const matCar = this._mat(new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.4, metalness: 0.45 }));
    const matFloor = this._mat(new THREE.MeshStandardMaterial({ color: C.floorDark, roughness: 0.7 }));
    const matLight = this._mat(new THREE.MeshBasicMaterial({ color: C.warm, toneMapped: false }));
    const fl = new THREE.Mesh(floorGeo, matFloor); fl.position.y = -0.07; car.add(fl);
    const back = new THREE.Mesh(wallGeo, matCar); back.position.set(0, 1.25, -d / 2); car.add(back);
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(sideGeo, matCar); side.position.set(s * w / 2, 1.25, 0); car.add(side);
    }
    const ceil = new THREE.Mesh(ceilGeo, matCar); ceil.position.y = 2.5; car.add(ceil);
    const lamp = new THREE.Mesh(this._geo(new THREE.BoxGeometry(0.5, 0.04, 0.5)), matLight);
    lamp.position.set(0, 2.42, 0); car.add(lamp);
    // 轿厢门（朝南）
    const doorMat = this._mat(new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.7 }));
    for (const s of [-1, 1]) {
      const panel = new THREE.Mesh(this._geo(new THREE.BoxGeometry(w / 2 - 0.02, 2.2, 0.06)), doorMat);
      panel.position.set(s * w / 4, 1.1, d / 2); car.add(panel);
    }
    car.position.set(cx, this._elevatorY, cz);
    this.root.add(car);
    this._elevatorCar = car;

    const panel = new THREE.Mesh(
      this._geo(new THREE.BoxGeometry(0.06, 0.7, 0.4)),
      this._mat(new THREE.MeshStandardMaterial({ color: C.trim, roughness: 0.5 })),
    );
    panel.position.set(-w / 2 + 0.09, 1.2, d / 2 - 0.5); car.add(panel);

    this._elevator = { active: false, fromY: 0, toY: 0, target: 1, doorHint: 0 };
    this._elevatorGrace = 0;
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
        this._elevatorGrace = 1.2; // 到站 1.2s 内不按脚高反驳，等玩家走出轿厢
        this._elevatorJustArrived = true;
        this._toast(`已到达 ${LEVEL_NAMES[e.target]}`);
      }
    }
    if (this._elevatorGrace > 0) this._elevatorGrace -= dt;
    if (this._elevatorCar) this._elevatorCar.position.y = this._elevatorY;
    // 轿厢升降期间 WASD 已被 isEnabled 关掉，这里直接接管眼高，玩家才真的“随车走”
    if (e.active && this._ctx?.camera) {
      this._ctx.camera.position.y = this._baseY + this._elevatorY + 1.6;
      if (this._wasd) this._wasd._groundY = this._baseY + this._elevatorY;
    }
    if (this._elevatorJustArrived) {
      this._elevatorJustArrived = false;
      // 刚停稳：把平滑基准对齐，避免到站后还缓慢下沉/上浮
      if (this._wasd) this._wasd._groundY = this._baseY + this._elevatorY;
      if (this._ctx?.camera) this._ctx.camera.position.y = this._baseY + this._elevatorY + 1.6;
    }
  }

  /* ---------- 扫地机器人：沿 1F 客厅路径巡游，回基站停 4s ---------- */
  _buildRobot() {
    const y = LEVELS[1];
    const bodyGeo = this._geo(new THREE.CylinderGeometry(0.2, 0.2, 0.09, 16));
    const mat = this._mat(new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.5, metalness: 0.3 }));
    const ledMat = this._mat(new THREE.MeshBasicMaterial({ color: 0x55ddaa, toneMapped: false }));
    const robot = new THREE.Group();
    robot.name = 'Villa/robot';
    robot.add(new THREE.Mesh(bodyGeo, mat));
    const led = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.03, 8, 6)), ledMat);
    led.position.set(0, 0.06, 0.16); robot.add(led);
    robot.position.set(-6.0, y + 0.01, -1.2);
    this.root.add(robot);
    this._robotPath = Object.freeze([
      [-6.0, -1.2], [-5.9, 2.6], [-3.2, 5.0], [-0.4, 4.6],
      [-0.6, 0.2], [-0.9, -2.4], [-3.2, -1.4], [-6.0, -1.2],
    ]);
    this._robot = robot;
    this._robotT = 0;
    this._robotPause = 0;
  }

  _updateRobot(dt) {
    if (!this._robot) return;
    const pts = this._robotPath;
    if (this._robotPause > 0) { this._robotPause -= dt; return; }
    this._robotT += dt * 0.1;
    const seg = this._robotT % (pts.length - 1);
    const i = Math.floor(seg), f = seg - i;
    const a = pts[i], b = pts[i + 1];
    this._robot.position.x = a[0] + (b[0] - a[0]) * f;
    this._robot.position.z = a[1] + (b[1] - a[1]) * f;
    this._robot.rotation.y = Math.atan2(b[0] - a[0], b[1] - a[1]);
    if (this._robotT >= pts.length - 1) { this._robotT = 0; this._robotPause = 4; }
  }

  /* ---------- 电视：程序化动态画面（CanvasTexture 节流重绘） ---------- */
  _buildTV() {
    this._tvCanvas = document.createElement('canvas');
    this._tvCanvas.width = 256; this._tvCanvas.height = 144;
    this._tvCtx = this._tvCanvas.getContext('2d');
    const tex = this._tex(new THREE.CanvasTexture(this._tvCanvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    const screenMat = this._mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const screen = new THREE.Mesh(this._geo(new THREE.PlaneGeometry(2.2, 1.24)), screenMat);
    screen.position.set(-3.2, LEVELS[1] + 1.55, -3.78);
    this.root.add(screen);
    this._box('black', 2.4, 1.44, 0.08, -3.2, LEVELS[1] + 1.55, -3.84, C.black);
    this._tvScreen = screen;
    this._tvTex = tex;
    this._tvAcc = 0;
    this._drawTV(0);
  }

  _drawTV(t) {
    const g = this._tvCtx;
    if (!g) return;
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

  /* ---------- 灯光：每层一盏点光（无阴影，避免阴影贴图抖） ---------- */
  _buildLights() {
    for (let i = 0; i < 4; i += 1) {
      const light = new THREE.PointLight(0xffd9a8, 2.4, 19, 1.5);
      light.position.set(-1.2, LEVELS[i] + 3.0, 1.2);
      light.castShadow = false;
      this.root.add(light);
      this._lights.push(light);
    }
    // 屋外补一盏冷调补光：现在别墅在真实街区里，挪到阳台外侧当“街灯”
    const out = new THREE.PointLight(0xbfe3ff, 1.2, 22, 1.4);
    out.position.set(0, 6.4, 9.6);
    out.castShadow = false;
    this.root.add(out);
    this._lights.push(out);
  }

  /* ======================================================================== */
  /* 支撑面求解（核心）                                                        */
  /* ======================================================================== */

  /** 判断点是否在电梯井内（含轿厢外形余量） */
  _inShaft(x, z) {
    return x > SHAFT.x0 - 0.05 && x < SHAFT.x1 + 0.05 && z > SHAFT.z0 - 0.05 && z < SHAFT.z1 + 0.05;
  }

  /**
   * WASDController.getGroundHeight 回调：脚下支撑面高度。
   *
   * 旧版用 `_level` 选择“服务当前层的楼梯段”，一旦横向离开楼梯 x 带就按
   * 最近楼层取整，脚下一帧瞬变 3.6m —— 这就是“一扭头楼梯没了 / 突然掉车库”。
   *
   * 新版不看 `_level`，而是“取离当前脚高最近、且在 1.7m 步距内的支撑面”：
   *   · 电梯井内 → 轿厢地板（动态）；
   *   · 楼梯跑道内 → 按 z 线性插值的斜面，只有与脚高相差 ≤1.7 才采用；
   *   · 阳台范围内 → 取与脚高最接近的那层阳台板；
   *   · 屋内其余位置 → 当前楼层楼板；
   *   · 屋外 → 院子地面 0。
   * 上下楼时脚高是连续变化的，候选面自然接力，永远不会瞬跳。
   */
  _groundAt(x, z) {
    if (this._inShaft(x, z)) return this._elevatorY;

    // 阳台：三层阳台同尺寸，取离脚高最近的一层
    if (z >= BALCONY.z0 - 0.05 && z <= BALCONY.z1 + 0.05 && Math.abs(x) <= BALCONY.x1 + 0.15) {
      let best = null, bestD = Infinity;
      for (let lv = 1; lv <= 3; lv += 1) {
        const d = Math.abs(this._footY - LEVELS[lv]);
        if (d < bestD) { bestD = d; best = lv; }
      }
      if (bestD <= 0.75) return LEVELS[best];
      return 0; // 站到阳台外面（理论上被栏杆挡住）→ 落回院子
    }

    // 楼梯跑道：取与脚高连续的那段斜面
    for (const s of STAIRS) {
      if (x >= STAIR_X.x0 - 0.15 && x <= STAIR_X.x1 + 0.15 && z >= s.z0 - 0.05 && z <= s.z1 + 0.05) {
        const t = clamp((z - s.z0) / (s.z1 - s.z0), 0, 1);
        const h = LEVELS[s.k] + t * (LEVELS[s.k + 1] - LEVELS[s.k]);
        if (Math.abs(h - this._footY) <= STEP_TOLERANCE) return h;
      }
    }

    // 屋内 → 当前楼层；屋外 → 院子
    if (x < -HOUSE.W / 2 || x > HOUSE.W / 2 || z < -HOUSE.D / 2 || z > HOUSE.D / 2) return 0;
    return LEVELS[this._level];
  }

  /**
   * 由脚高反推当前楼层（只影响显示与分层碰撞过滤，绝不反向决定地面高度）。
   * 楼梯中段离两层都远时保持上一帧楼层，避免抖动。
   */
  _syncLevel() {
    const cam = this._ctx?.camera;
    if (!cam) return;
    if (this._elevatorGrace > 0) return;
    const l = this.worldToLocalXZ(cam.position.x, cam.position.z);
    if (this._inShaft(l.x, l.z)) return;
    const footY = cam.position.y - 1.6 - this._baseY;
    let best = this._level, bestD = Infinity;
    for (let i = 0; i < LEVELS.length; i += 1) {
      const d = Math.abs(footY - LEVELS[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD < 1.0) this._level = best;
  }

  /** 碰撞盒按层过滤；电梯不在本层时，井道门用动态挡板封住 */
  _walkBoxesByLevel() {
    const lv = this._level;
    const carHome = Math.abs(this._elevatorY - LEVELS[lv]) < 0.2;
    const key = lv * 2 + (carHome ? 1 : 0);
    if (this._boxCache && this._boxCacheKey === key) return this._boxCache;
    const base = this._baseBoxes || (this._baseBoxes = this._walkBoxes.slice());
    const out = base.concat(this._furnitureBoxes[lv] || []);
    if (!carHome && this._shaftDoor) out.push(this._shaftDoor);
    this._boxCache = out;
    this._boxCacheKey = key;
    return out;
  }

  /* ======================================================================== */
  /* UI                                                                        */
  /* ======================================================================== */
  _buildUI() {
    if (this._uiRoot) return;
    const root = document.createElement('div');
    root.id = 'villa-ui';
    root.innerHTML = `
      <style>
        #villa-ui{position:fixed;inset:0;pointer-events:none;font-family:"Microsoft YaHei",sans-serif;z-index:60}
        #villa-ui .card{position:absolute;top:20px;left:20px;background:rgba(20,28,34,.86);color:#eaf4f8;
          border:1px solid rgba(150,200,220,.35);border-radius:12px;padding:14px 16px;backdrop-filter:blur(8px)}
        #villa-ui h3{margin:0 0 6px;font-size:15px;font-weight:500;letter-spacing:1px}
        #villa-ui .lv{font-size:13px;color:#9fd8c8;margin-bottom:10px}
        #villa-ui .hint{font-size:11px;color:#a9bcc6;line-height:1.7;max-width:240px}
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
        <div class="lv" id="villa-lv">当前：1F 玄关</div>
        <div class="hint">WASD / 方向键走动 · 拖拽环顾<br>三段楼梯：B1↔1F↔2F↔3F（平台口可出）<br>2F/3F 南向阳台推门就出去 —— 看到的就是大厅真实街景，Esc 返回大厅</div>
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
    this._uiListeners = [
      ['exit', root.querySelector('[data-villa="exit"]'), onExit, 'click'],
      ['floor', root, onFloor, 'click'],
      ['key', window, onKey, 'keydown'],
    ];
  }

  /** 挂 HUD（每次“回家”才出现，回大厅即摘掉） */
  _attachUI() {
    if (this._uiAttached) return;
    if (!this._uiRoot) this._buildUI();
    if (this._uiRoot && !this._uiRoot.parentNode) document.body.appendChild(this._uiRoot);
    // 同屏别再叠两层 HUD：进入别墅时把大厅 HUD 与调试面板收起来，退出时原样恢复
    this._hiddenHud = [];
    for (const sel of ['.lb-ui', '.pg-ui']) {
      const el = document.querySelector(sel);
      if (el && el.style.display !== 'none') {
        this._hiddenHud.push([el, el.style.display]);
        el.style.display = 'none';
      }
    }
    this._uiAttached = true;
  }

  _detachUI() {
    if (!this._uiAttached) return;
    this._uiAttached = false;
    for (const [el, prev] of this._hiddenHud || []) el.style.display = prev || '';
    this._hiddenHud = null;
    for (const [, target, fn, evt] of this._uiListeners || []) target?.removeEventListener?.(evt, fn);
    this._uiListeners = null;
    if (this._uiRoot?.parentNode) this._uiRoot.parentNode.removeChild(this._uiRoot);
    this._uiRoot = null;
    clearTimeout(this._toastTimer);
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
    if (!el) return;
    const text = `当前：${LEVEL_NAMES[this._level]}`;
    if (el.textContent !== text) el.textContent = text;
  }

  /* ======================================================================== */
  /* 嵌入视图生命周期（FacilityRuntime 的 IEmbeddedView 契约）                  */
  /* ======================================================================== */

  /** 相机锚点（世界坐标）：1F 玄关，面朝屋内 */
  getCameraAnchor() {
    const position = this.localToWorld(SPAWN.x, SPAWN.y + 1.6, SPAWN.z);
    const e = new THREE.Euler(0, SPAWN.yaw + VILLA_ORIGIN.yaw, 0, 'YXZ');
    return { position, quaternion: new THREE.Quaternion().setFromEuler(e) };
  }

  /** 建一台新的 WASD（控制器 dispose 是终态，所以每次回家重建） */
  _mkWASD() {
    const camera = this._ctx?.camera;
    if (!camera) return null;
    return new WASDController({
      camera,
      domElement: this._ctx?.renderer?.domElement || null,
      getObstacles: () => this._worldBoxes(),
      getGroundHeight: (x, z) => this._worldGroundAt(x, z),
      isEnabled: () => !this._disposed && this._active === true && !this._elevator?.active,
    });
  }

  /** 回到 1F 玄关并接管漫游 */
  activate() {
    if (this._disposed) return this;
    this._active = true;
    this.root.visible = true;
    // 同址的都会区外壳（一个实心盒子）必须先藏掉，否则我们等于站在盒子内壁里
    const scene = this._ctx?.scene;
    this._cityShell = scene?.getObjectByName('City/villa') || null;
    if (this._cityShell) this._cityShell.visible = false;

    const cam = this._ctx?.camera;
    this._level = 1;
    this._footY = LEVELS[1];
    this._elevatorY = LEVELS[1];
    if (this._elevator) this._elevator.active = false;
    if (this._elevatorCar) this._elevatorCar.position.y = this._elevatorY;

    if (cam) {
      cam.near = 0.06; // 室内贴墙/上楼梯不裁面
      cam.updateProjectionMatrix();
    }

    // 相机本体交给 CameraRig 的 blendTo（它在 activate 之前已经发出），
    // 这里只把人眼朝向对齐到锚点，绝不直接写 camera.position，否则会和过渡打架。
    this._wasd?.dispose();
    this._wasd = this._mkWASD();
    if (this._wasd) {
      const a = this.getCameraAnchor();
      const e = new THREE.Euler().setFromQuaternion(a.quaternion, 'YXZ');
      this._wasd.yaw = e.y;
      this._wasd.pitch = e.x;
      this._wasd._groundY = null;   // 下一帧直接采样真实楼面，不做缓动
      this._wasd.attach();
    }
    this._attachUI();
    this._toast('已回到家 · 1F 玄关');
    return this;
  }

  /** 离开：藏几何、摘监听、还原外壳 */
  deactivate() {
    this._active = false;
    this.root.visible = false;
    if (this._cityShell) { this._cityShell.visible = true; this._cityShell = null; }
    this._wasd?.dispose();
    this._wasd = null;
    this._detachUI();
    const cam = this._ctx?.camera;
    if (cam && Math.abs(cam.near - 0.06) < 1e-6) { cam.near = 0.1; cam.updateProjectionMatrix(); }
    return this;
  }

  /* ======================================================================== */
  /* update / onInteract / dispose                                             */
  /* ======================================================================== */
  update(dt) {
    if (this._disposed || !this._active) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this._time += dt;

    // 先记下“上一帧脚下高度”（本地系），_groundAt 用它做连续性判断
    const cam = this._ctx?.camera;
    if (cam) this._footY = cam.position.y - 1.6 - this._baseY;

    // CameraRig 还在做进出场 blend 时不要抢相机
    const transitioning = this._ctx?.cameraRig?.isTransitioning === true
      || this._ctx?.runtime?.isTransitioning === true;
    if (!transitioning) {
      this._wasd?.update(dt);
      this._updateElevator(dt);
    } else if (this._elevator?.active) {
      this._updateElevator(dt);
    }
    this._syncLevel();
    this._updateRobot(dt);
    this._updateUILevel();

    // 电视每 0.25s 重绘一次（避免每帧上传贴图）
    this._tvAcc += dt;
    if (this._tvAcc >= 0.25) { this._tvAcc = 0; this._drawTV(this._time); }
  }

  onInteract(_hitInfo) { /* 交互全部走 DOM 按钮 */ }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    clearTimeout(this._toastTimer);
    this._detachUI();
    this._wasd?.dispose(); this._wasd = null;
    for (const [key, target, fn, evt] of this._listeners) {
      if (target) target.removeEventListener?.(evt || 'click', fn);
    }
    this._listeners.length = 0;
    if (this._uiRoot?.parentNode) this._uiRoot.parentNode.removeChild(this._uiRoot);
    this._uiRoot = null;
    for (const l of this._lights) l.parent?.remove(l);
    this._lights.length = 0;
    // 退出时把同址的都会区外壳恢复可见，再把自己从场景摘掉
    if (this._cityShell) { this._cityShell.visible = true; this._cityShell = null; }
    this.root.parent?.remove(this.root);
    this.root.visible = false;
    // 相机恢复（嵌入模式下由 CameraRig 负责，这里只在有存档时兜底）
    const cam = this._ctx?.camera;
    if (cam && this._cameraSaved) {
      cam.position.copy(this._cameraSaved.position);
      cam.quaternion.copy(this._cameraSaved.quaternion);
      cam.rotation.order = this._cameraSaved.rotationOrder;
      cam.fov = this._cameraSaved.fov;
      cam.near = this._cameraSaved.near ?? 0.1;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      this._cameraSaved = null;
    }
    for (const t of this._textures) t.dispose();
    for (const m of this._materials) m.dispose();
    for (const g of this._geometries) g.dispose();
    this._textures.clear(); this._materials.clear(); this._geometries.clear();
    this._walkBoxes.length = 0; this._baseBoxes = null;
    this._boxCache = null; this._boxCacheKey = -1;
    this._tvScreen = null; this._tvTex = null; this._tvCtx = null;
    this._robot = null; this._elevatorCar = null; this._elevator = null;
    this._ctx = null;
  }
}

export default Villa;
