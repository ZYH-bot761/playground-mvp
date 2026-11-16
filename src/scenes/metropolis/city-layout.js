/**
 * 都会区布局（公园北侧，福田 CBD 风格）。
 * 坐标沿用游乐园世界系：+z 向北，主干道 x=24 直接接上 z=90 的公园北缘。
 * 路网全部为轴对齐走廊，塔楼只落在街区内，便于自动扫描"道路零侵入"。
 */
export const CITY = Object.freeze({
  center: Object.freeze({ x: 0, z: 170 }),
  pad: Object.freeze({ minX: -95, maxX: 95, minZ: 94, maxZ: 245, y: 1.16 }),
  horizon: Object.freeze({ size: 620, y: 0.82 }),
  boulevard: Object.freeze({ x: 24, width: 16, from: 90, to: 222 }),
  crossZ: Object.freeze([112, 150, 194]),
  crossWidth: 12,
  sideX: Object.freeze([-50, 70]),
  sideWidth: 9,
  parking: Object.freeze({ x: -30, z: 100, w: 26, d: 16 }),
});

export const CITY_ROADS = Object.freeze([
  { axis: 'z', center: CITY.boulevard.x, width: CITY.boulevard.width, min: 88, max: 232, kind: 'main' },
  ...CITY.crossZ.map((z) => ({ axis: 'x', center: z, width: CITY.crossWidth, min: -95, max: 95, kind: 'cross' })),
  ...CITY.sideX.map((x) => ({ axis: 'z', center: x, width: CITY.sideWidth, min: 106, max: 228, kind: 'side' })),
]);

/** 停车场进出车道：从 x=24 主干道西侧切线接入。 */
export const PARKING_DRIVE = Object.freeze({ z: 100, fromX: 16, toX: -17, width: 6 });

/** 塔楼街区坐标（每个中心点都与道路走廊至少留 2m 绿化带）。 */
export const TOWER_SLOTS = Object.freeze([
  { x: -82, z: 130, h: 54, w: 14, d: 14 },
  { x: -62, z: 130, h: 78, w: 13, d: 15 },
  { x: -36, z: 130, h: 98, w: 12, d: 14 },
  { x: 0, z: 130, h: 62, w: 16, d: 16 },
  { x: 44, z: 130, h: 116, w: 12, d: 13 },
  { x: 58, z: 130, h: 48, w: 10, d: 12 },

  { x: -82, z: 172, h: 70, w: 14, d: 14 },
  { x: -62, z: 172, h: 46, w: 12, d: 13 },
  { x: -36, z: 172, h: 132, w: 11, d: 13 },
  { x: 0, z: 172, h: 84, w: 16, d: 16 },
  { x: 44, z: 172, h: 64, w: 12, d: 14 },
  { x: 58, z: 172, h: 104, w: 10, d: 12 },

  { x: -82, z: 212, h: 88, w: 14, d: 14 },
  { x: -62, z: 212, h: 58, w: 12, d: 14 },
  { x: -36, z: 212, h: 76, w: 11, d: 12 },
  { x: 0, z: 212, h: 108, w: 15, d: 16 },
  { x: 44, z: 212, h: 52, w: 12, d: 13 },
  { x: 58, z: 212, h: 92, w: 10, d: 12 },
]);

export const HOSPITAL = Object.freeze({ x: -62, z: 233, w: 22, d: 12 });
export const SCHOOL = Object.freeze({ x: 48, z: 232, w: 30, d: 20 });

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
