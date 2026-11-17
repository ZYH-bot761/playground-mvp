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
