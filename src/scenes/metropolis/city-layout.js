/**
 * 都会区布局（公园北侧，福田 CBD 风格）。
 * 坐标沿用游乐园世界系：+z 向北，主干道 x=24 直接接上 z=90 的公园北缘。
 * 路网全部为轴对齐走廊，塔楼只落在街区内，便于自动扫描"道路零侵入"。
 */
export const CITY = Object.freeze({
  center: Object.freeze({ x: 0, z: 170 }),
  pad: Object.freeze({ minX: -95, maxX: 95, minZ: 94, maxZ: 252, y: 1.16 }),
  horizon: Object.freeze({ size: 620, y: 0.82 }),
  boulevard: Object.freeze({ x: 24, width: 16, from: 90, to: 222 }),
  crossZ: Object.freeze([112, 150, 194]),
  crossWidth: 12,
  sideX: Object.freeze([-50, 70]),
  sideWidth: 9,
  parking: Object.freeze({ x: -30, z: 100, w: 26, d: 16 }),
  /** 公园入口旁的试驾车位：玩家出大门就能看到，避免“找不到车/开不了车”。 */
  demoParking: Object.freeze({ x: 35, z: 99, w: 6, d: 13 }),
});

export const CITY_ROADS = Object.freeze([
  { axis: 'z', center: CITY.boulevard.x, width: CITY.boulevard.width, min: 88, max: 232, kind: 'main' },
  ...CITY.crossZ.map((z) => ({ axis: 'x', center: z, width: CITY.crossWidth, min: -95, max: 95, kind: 'cross' })),
  ...CITY.sideX.map((x) => ({ axis: 'z', center: x, width: CITY.sideWidth, min: 106, max: 228, kind: 'side' })),
]);

/** 停车场进出车道：从 x=24 主干道西侧切线接入。 */
export const PARKING_DRIVE = Object.freeze({ z: 100, fromX: 16, toX: -17, width: 6 });

/**
 * 北侧 9 个原始街块合并为 6 座完整建筑：
 * 医院 / 学校 / 商场各吃 2 块，剩下 3 块分别做成大裤衩、尖塔、退台塔。
 * 所有体量离道路红线 ≥2m；入口均朝向 z- 侧（公园方向）。
 */
export const CITY_BLOCKS = Object.freeze([
  { role: 'hospital', lots: 2, x: -72, z: 134, w: 30, d: 18, h: 38, key: 'hospital' },
  { role: 'school', lots: 2, x: 52, z: 134, w: 30, d: 18, h: 18, key: 'school' },
  { role: 'mall', lots: 2, x: 0, z: 134, w: 28, d: 18, h: 32, key: 'mall' },
  { role: 'cctv', lots: 1, x: -22, z: 172, w: 24, d: 20, h: 72, key: 'cctv' },
  { role: 'spire', lots: 1, x: 52, z: 172, w: 18, d: 18, h: 108, key: 'spire' },
  { role: 'terrace', lots: 1, x: -72, z: 212, w: 26, d: 20, h: 58, key: 'terrace' },
]);

/**
 * 居民区：只保留西侧一栋与东侧一栋，腾出北侧整片草地做湖滨。
 * 旧版 6 栋居民楼把草地切得太碎，现已删除其中 4 栋（约三分之二），
 * 避免“草地突然长出一排高楼”的违和感；湖滨再用低层配套补足生活气息。
 */
export const CITY_RESIDENTIAL = Object.freeze([
  { key: 'res-w1', x: -78, z: 164, w: 20, d: 14, h: 26, floors: 8 },
  { key: 'res-e1', x: 84, z: 130, w: 16, d: 16, h: 24, floors: 7 },
]);

/** 北侧大湖与沙滩：位于西支路与主干道之间、北横街以北的空地。 */
export const CITY_LAKE = Object.freeze({
  x: -15, z: 224, w: 46, d: 40,
  beachW: 60, beachD: 52,
  waterY: 1.205, sandY: 1.175,
});

/** 行人可到达的步行 AABB；建筑按体量外扩 0.45m，街道保持畅通。 */
export function cityWalkColliders() {
  const out = [];
  for (const b of [...CITY_BLOCKS, ...CITY_RESIDENTIAL]) {
    out.push({
      minX: b.x - b.w / 2 - 0.45,
      maxX: b.x + b.w / 2 + 0.45,
      minZ: b.z - b.d / 2 - 0.45,
      maxZ: b.z + b.d / 2 + 0.45,
      city: true,
    });
  }
  // 入口门廊两柱：可穿过中间，不挡住玩家进入都会区。
  out.push({ minX: 13.2, maxX: 15.6, minZ: 92.6, maxZ: 95.4, city: true });
  out.push({ minX: 32.4, maxX: 34.8, minZ: 92.6, maxZ: 95.4, city: true });
  return out;
}

/** 兼容旧验收：TOWER_SLOTS 现在只代表 3 座异形塔。 */
export const TOWER_SLOTS = Object.freeze(CITY_BLOCKS.filter((b) => b.lots === 1));
export const CITY_BLOCK_COUNT = 9;

export const HOSPITAL = Object.freeze({
  x: -72, z: 134, w: 30, d: 18, h: 38,
  entrance: Object.freeze({ x: -72, z: 124.2 }),
});
export const SCHOOL = Object.freeze({
  x: 52, z: 134, w: 30, d: 18,
  entrance: Object.freeze({ x: 52, z: 124.2 }),
});
export const MALL = Object.freeze({
  x: 0, z: 134, w: 28, d: 18, h: 32,
  entrance: Object.freeze({ x: 0, z: 124.2 }),
});

/** 9 个信号化十字路口（主干道/西支路/东支路 × 三条横街）。 */
export const CITY_INTERSECTIONS = Object.freeze(
  [-50, 24, 70].flatMap((x) => CITY.crossZ.map((z) => ({
    x, z,
    halfX: (x === 24 ? CITY.boulevard.width : CITY.sideWidth) / 2,
    halfZ: CITY.crossWidth / 2,
  }))),
);

export const BUS_STOP = Object.freeze({ x: 32.4, z: 38, gate: { x: 0, z: 18 } });

export const isOnRoad = (x, z, margin = 0) => CITY_ROADS.some((r) => {
  if (r.axis === 'z') {
    return Math.abs(x - r.center) <= r.width / 2 + margin
      ? z >= r.min - margin && z <= r.max + margin
      : false;
  }
  return Math.abs(z - r.center) <= r.width / 2 + margin
    ? x >= r.min - margin && x <= r.max + margin
    : false;
});

/**
 * 公园四宫格的街道走廊（districts.js：13m 车行道 + 1.5m 人行道 = 16m 走廊，
 * axisX=24 / axisZ=27，外框 x -30…90 / z -30…90）+ 停车场车道。
 * 驾驶的路面判定必须包含它们：旧版只认都会路网，玩家在公园大沥青路上开车
 * 也被当成草地，全程 exp(-0.32·dt) 拖慢，怎么踩油门都跑不起来。
 */
export const PARK_CORRIDOR = Object.freeze({
  axisX: 24, axisZ: 27, half: 8, minX: -30, maxX: 90, minZ: -30, maxZ: 90,
});

export function isDrivable(x, z) {
  if (isOnRoad(x, z)) return true;
  const C = PARK_CORRIDOR;
  if (z >= C.minZ && z <= C.maxZ && Math.abs(x - C.axisX) <= C.half) return true;
  if (x >= C.minX && x <= C.maxX && Math.abs(z - C.axisZ) <= C.half) return true;
  const pk = CITY.parking, dp = CITY.demoParking, pd = PARKING_DRIVE;
  if (Math.abs(x - pk.x) <= pk.w / 2 && Math.abs(z - pk.z) <= pk.d / 2) return true;
  if (Math.abs(x - dp.x) <= dp.w / 2 + 1 && Math.abs(z - dp.z) <= dp.d / 2 + 1) return true;
  if (Math.abs(z - pd.z) <= pd.width / 2 && x >= pd.toX - 1 && x <= pd.fromX + 1) return true;
  return false;
}

/**
 * 都会基座南缘：沥青从 z=88 就开始铺（CITY_ROADS 的 min），
 * 旧版步行地面却按 pad.minZ=94 才抬高，玩家在门廊里脚陷 1.16m。
 */
export const CITY_GROUND_MIN_Z = Math.min(CITY.pad.minZ, ...CITY_ROADS.map((r) => r.min));
