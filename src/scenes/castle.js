/**
 * ============================================================================
 * Castle.js —— 阶段三：童话公主风城堡群（Districts 北侧 castle 区 detail 组）
 * ============================================================================
 * 体量：中央主堡 + 4 座贴角塔楼 + 4 座外围塔（南塔为门楼）+ 2 段侧翼 +
 *       闭合城墙/城垛。8 栋塔楼高度 22~36m，形成高低错落的城堡群。
 *
 * 性能：静态体块全部 mergeGeometries；窗/宝珠/灯珠用 InstancedMesh。
 *       目标 ≤8 draw call、可见面 ≤8k；绝不按塔拆成独立 Mesh。
 * 资源：只释放自有合并几何/材质；窗光、叶片、粗糙度纹理由 Lobby 共享台账释放。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { dayNightCycle } from '../utils/helpers/day-night-cycle.js';

/** 低饱和粉 / 蓝 / 白 / 金 */
const PALETTE = {
  ivory: 0xf2ede3,
  cream: 0xe8dfcf,
  blush: 0xe7bcd2,
  rose: 0xd39ab8,
  powder: 0xb9d3e8,
  sky: 0x94b9d6,
  gold: 0xd8b878,
  lightGold: 0xefd9a4,
  dark: 0x4a4453,
};

function colored(geo, hex) {
  const g = geo.clone();
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function place(geo, hex, pos, scale, rotY = 0) {
  const g = colored(geo, hex);
  const q = rotY
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY)
    : new THREE.Quaternion();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    q,
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
  g.applyMatrix4(m);
  return g;
}

/**
 * @param {THREE.Group} detail Districts 的 castle detail 组（世界坐标建，由 Districts rebase）
 * @param {object} S Lobby 共享几何/纹理/材质
 * @param {{cx:number, cz:number}} center 城堡区中心世界坐标
 */
export function buildCastle(detail, S, center) {
  const cx = center.cx;
  const cz = center.cz;
  const owned = { geometries: [], materials: [] };
  const mat = (hex, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: hex, ...opts });
    owned.materials.push(m);
    return m;
  };

  /* ---------------- 8 栋塔楼：4 角楼 + 4 外围塔 ---------------- */
  const corners = [
    { x: -8.4, z: -8.4, h: 34, rad: 2.3, color: PALETTE.blush },
    { x: 8.4, z: -8.4, h: 30, rad: 2.3, color: PALETTE.powder },
    { x: -8.4, z: 8.4, h: 31, rad: 2.3, color: PALETTE.cream },
    { x: 8.4, z: 8.4, h: 35, rad: 2.3, color: PALETTE.blush },
  ];
  const outers = [
    { x: 0, z: -18, h: 28, rad: 3.2, color: PALETTE.sky },
    { x: 18, z: 0, h: 24, rad: 3.0, color: PALETTE.ivory },
    { x: 0, z: 18, h: 26, rad: 3.4, color: PALETTE.rose }, // 南门楼
    { x: -18, z: 0, h: 22, rad: 3.0, color: PALETTE.cream },
  ];
  const towers = [...corners, ...outers].map((t) => ({ ...t, x: cx + t.x, z: cz + t.z }));
  const keepH = 26;

  // ---- 合并①：墙体主体（主堡、8 塔、侧翼、基座、腰线、城垛）----
  const bodyParts = [];
  const geoCylOpen = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
  bodyParts.push(place(S.geoBox, PALETTE.ivory, [cx, 13, cz], [16, keepH, 16]));
  bodyParts.push(place(S.geoBox, PALETTE.cream, [cx, 29, cz], [10, 6, 10]));

  for (const t of towers) {
    bodyParts.push(place(S.geoCylinder, t.color, [t.x, t.h / 2, t.z], [t.rad, t.h, t.rad]));
    // 基座用无盖圆柱 + 顶面环，避免夜间顶盖被 Bloom 打成一块白盘
    bodyParts.push(place(geoCylOpen, PALETTE.ivory,
      [t.x, 0.9, t.z], [t.rad * 1.42, 1.8, t.rad * 1.42]));
    // 金腰线：每塔一道，增加粉蓝白墙面的分层
    bodyParts.push(place(geoCylOpen, PALETTE.gold,
      [t.x, t.h * 0.62, t.z], [t.rad * 1.035, 0.42, t.rad * 1.035]));
  }

  // 两段低侧翼，让主堡不是孤立的方盒
  for (const side of [-1, 1]) {
    bodyParts.push(place(S.geoBox, PALETTE.cream, [cx + side * 11.5, 4.5, cz], [9, 9, 14]));
    bodyParts.push(place(S.geoBox, PALETTE.ivory, [cx + side * 11.5, 1, cz], [10, 2, 15]));
  }

  // ---- 城墙：连接 4 座外围塔的斜向墙段 + 城垛 ----
  const wallParts = [];
  const wallH = 6.5;
  for (let i = 0; i < 4; i += 1) {
    const a = outers[i];
    const b = outers[(i + 1) % 4];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dz, dx);
    const mx = cx + (a.x + b.x) / 2;
    const mz = cz + (a.z + b.z) / 2;
    wallParts.push(place(S.geoBox, PALETTE.ivory, [mx, wallH / 2, mz], [len, wallH, 1.6], yaw));
    const ux = dx / len;
    const uz = dz / len;
    for (let c = 0; c < 5; c += 1) {
      const t = ((c + 0.5) / 5 - 0.5) * len;
      wallParts.push(place(S.geoBox, PALETTE.cream,
        [mx + ux * t, wallH + 0.65, mz + uz * t], [1.25, 1.3, 1.8], yaw));
    }
  }

  const bodyGeo = mergeGeometries(bodyParts, false);
  if (!bodyGeo) throw new Error('[Castle] body mergeGeometries 失败');
  bodyGeo.computeBoundingSphere();
  bodyParts.forEach((g) => g.dispose());
  geoCylOpen.dispose();
  owned.geometries.push(bodyGeo);

  const wallGeo = mergeGeometries(wallParts, false);
  if (!wallGeo) throw new Error('[Castle] wall mergeGeometries 失败');
  wallGeo.computeBoundingSphere();
  wallParts.forEach((g) => g.dispose());
  owned.geometries.push(wallGeo);

  // ---- 合并②：尖顶 / 坡屋顶 ----
  const roofParts = [];
  const geoPyramid = new THREE.ConeGeometry(1, 1, 4);
  roofParts.push(place(S.geoCone, PALETTE.blush, [cx, keepH + 7, cz], [9.2, 14, 9.2]));
  corners.forEach((t, i) => {
    const wx = cx + t.x;
    const wz = cz + t.z;
    roofParts.push(place(S.geoCone, i % 2 ? PALETTE.powder : PALETTE.blush,
      [wx, t.h + 4.2, wz], [t.rad * 1.28, 8.4, t.rad * 1.28]));
  });
  outers.forEach((t, i) => {
    const wx = cx + t.x;
    const wz = cz + t.z;
    roofParts.push(place(S.geoCone, i % 2 ? PALETTE.rose : PALETTE.sky,
      [wx, t.h + 3.6, wz], [t.rad * 1.2, 7.2, t.rad * 1.2]));
  });
  for (const side of [-1, 1]) {
    roofParts.push(place(geoPyramid, PALETTE.blush,
      [cx + side * 11.5, 11.6, cz], [7.2, 5.2, 10], Math.PI / 4));
  }
  const roofGeo = mergeGeometries(roofParts, false);
  if (!roofGeo) throw new Error('[Castle] roof mergeGeometries 失败');
  roofGeo.computeBoundingSphere();
  roofParts.forEach((g) => g.dispose());
  geoPyramid.dispose();
  owned.geometries.push(roofGeo);

  // ---- 城门洞 + 金色门框（合并成 1 个 Mesh）----
  const gateParts = [];
  const gz = cz + 18 + 3.42;
  gateParts.push(place(S.geoBox, PALETTE.dark, [cx, 4.3, gz], [4.4, 7.2, 0.55]));
  gateParts.push(place(S.geoBox, PALETTE.gold, [cx, 8.1, gz + 0.05], [5.1, 0.45, 0.65]));
  for (const side of [-1, 1]) {
    gateParts.push(place(S.geoBox, PALETTE.gold,
      [cx + side * 2.35, 4.2, gz + 0.05], [0.38, 7.2, 0.65]));
  }
  const gateGeo = mergeGeometries(gateParts, false);
  if (!gateGeo) throw new Error('[Castle] gate mergeGeometries 失败');
  gateGeo.computeBoundingSphere();
  gateParts.forEach((g) => g.dispose());
  owned.geometries.push(gateGeo);

  // ---- 材质 ----
  const matStone = mat(0xffffff, {
    vertexColors: true, roughness: 0.88, metalness: 0,
    roughnessMap: S.texStoneRough, envMapIntensity: 0.35,
  });
  const matRoof = mat(0xffffff, {
    vertexColors: true, roughness: 0.55, metalness: 0.05,
    roughnessMap: S.texStoneRough, envMapIntensity: 0.5,
  });
  const matGate = mat(0xffffff, {
    vertexColors: true, roughness: 0.9, metalness: 0, roughnessMap: S.texStoneRough,
  });
  const matWindow = mat(0xffffff, {
    map: S.texWindowGlow, emissive: 0xffffff, emissiveMap: S.texWindowGlow,
    emissiveIntensity: 0.25, alphaTest: 0.42, side: THREE.DoubleSide,
    roughness: 0.35, metalness: 0,
  });
  const matFinial = mat(PALETTE.gold, {
    emissive: PALETTE.lightGold, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.6,
  });
  const matLights = mat(0xffc06a, {
    emissive: 0xffa94d, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.1,
  });
  const matFlags = mat(0xffffff, {
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.72, metalness: 0,
  });

  const body = new THREE.Mesh(bodyGeo, matStone);
  body.name = 'Districts/castle/body';
  body.frustumCulled = true;
  detail.add(body);

  const walls = new THREE.Mesh(wallGeo, matStone);
  walls.name = 'Districts/castle/walls';
  walls.frustumCulled = true;
  detail.add(walls);

  const roof = new THREE.Mesh(roofGeo, matRoof);
  roof.name = 'Districts/castle/roof';
  roof.frustumCulled = true;
  detail.add(roof);

  const gate = new THREE.Mesh(gateGeo, matGate);
  gate.name = 'Districts/castle/gate';
  gate.frustumCulled = true;
  detail.add(gate);

  // ---- 窗户：拱形贴图薄面 InstancedMesh（1 call）----
  const wins = [];
  const addWin = (x, y, z, yaw, w = 1.0, h = 1.55) => wins.push({ x, y, z, yaw, w, h });
  const addRing = (x, z, h, rad, rows, dirs = 4) => {
    for (const hy of rows) {
      for (let i = 0; i < dirs; i += 1) {
        const a = (i / dirs) * Math.PI * 2;
        addWin(x + Math.cos(a) * (rad + 0.055), hy, z + Math.sin(a) * (rad + 0.055),
          Math.atan2(Math.cos(a), Math.sin(a)));
      }
    }
  };
  // 主堡四面窗：每面 4 列 × 3 行
  for (const side of [-1, 1]) {
    for (const off of [-5.1, -1.7, 1.7, 5.1]) {
      for (const hy of [9, 15, 21]) {
        addWin(cx + off, hy, cz + side * 8.06, side > 0 ? 0 : Math.PI);
        addWin(cx + side * 8.06, hy, cz + off, side > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
    }
  }
  for (const t of corners) addRing(cx + t.x, cz + t.z, t.h, t.rad, [t.h * 0.34, t.h * 0.58, t.h * 0.82]);
  for (const t of outers) addRing(cx + t.x, cz + t.z, t.h, t.rad, [t.h * 0.3, t.h * 0.55, t.h * 0.8]);
  for (const side of [-1, 1]) {
    addWin(cx + side * 11.5, 5.4, cz + 7.06, 0, 1.1, 1.5);
    addWin(cx + side * 11.5, 5.4, cz - 7.06, Math.PI, 1.1, 1.5);
  }
  const windows = new THREE.InstancedMesh(S.geoPlane, matWindow, wins.length);
  windows.name = 'Districts/castle/windows';
  const d = new THREE.Object3D();
  wins.forEach((w, i) => {
    d.position.set(w.x, w.y, w.z);
    d.rotation.set(0, w.yaw, 0);
    d.scale.set(w.w, w.h, 1);
    d.updateMatrix();
    windows.setMatrixAt(i, d.matrix);
  });
  windows.instanceMatrix.needsUpdate = true;
  windows.computeBoundingSphere();
  windows.frustumCulled = true;
  detail.add(windows);

  // ---- 塔尖宝珠（InstancedMesh，复用共享 geoSphere）----
  const finialPos = [];
  finialPos.push([cx, keepH + 14.4, cz]);
  for (const t of corners) finialPos.push([t.x, t.h + 8.6, t.z]);
  for (const t of outers) finialPos.push([t.x, t.h + 7.4, t.z]);
  const finials = new THREE.InstancedMesh(S.geoSphere, matFinial, finialPos.length);
  finials.name = 'Districts/castle/finials';
  finialPos.forEach((p, i) => {
    d.position.set(p[0], p[1], p[2]);
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(0.88);
    d.updateMatrix();
    finials.setMatrixAt(i, d.matrix);
  });
  finials.instanceMatrix.needsUpdate = true;
  finials.computeBoundingSphere();
  finials.frustumCulled = true;
  detail.add(finials);

  // ---- 小旗帜：旗杆 + 旗面合并成 1 个 Mesh ----
  const flagParts = [];
  const geoPole = new THREE.CylinderGeometry(1, 1, 1, 4);
  const flagColors = [PALETTE.blush, PALETTE.powder, PALETTE.rose, PALETTE.sky];
  const flagSpots = [
    [cx, keepH + 14.4, cz],
    ...corners.map((t) => [t.x, t.h + 8.6, t.z]),
    [cx, outers[0].h + 7.4, cz + outers[0].z],
    [cx, outers[2].h + 7.4, cz + outers[2].z],
  ];
  flagSpots.forEach((p, i) => {
    flagParts.push(place(geoPole, PALETTE.gold,
      [p[0], p[1] + 1.0, p[2]], [0.035, 2.0, 0.035]));
    flagParts.push(place(S.geoPlane, flagColors[i % flagColors.length],
      [p[0] + 0.42, p[1] + 1.62, p[2]], [0.84, 0.5, 1], Math.PI / 4));
  });
  const flagGeo = mergeGeometries(flagParts, false);
  if (!flagGeo) throw new Error('[Castle] flag mergeGeometries 失败');
  flagGeo.computeBoundingSphere();
  flagParts.forEach((g) => g.dispose());
  geoPole.dispose();
  owned.geometries.push(flagGeo);
  const flags = new THREE.Mesh(flagGeo, matFlags);
  flags.name = 'Districts/castle/flags';
  flags.frustumCulled = true;
  detail.add(flags);

  // ---- 金色小灯珠：城门 + 城墙沿线 ----
  const lightPos = [];
  const gateLightCount = 5;
  for (let i = 0; i < gateLightCount; i += 1) {
    const t = (i / (gateLightCount - 1) - 0.5) * 4.4;
    lightPos.push([cx + t, 9.0 + Math.cos((i / (gateLightCount - 1) - 0.5) * Math.PI) * 1.2, gz + 0.55]);
  }
  for (const t of outers) {
    for (let k = 0; k < 4; k += 1) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      lightPos.push([cx + t.x + Math.cos(a) * (t.rad + 0.2), 3.4,
        cz + t.z + Math.sin(a) * (t.rad + 0.2)]);
    }
  }
  const lights = new THREE.InstancedMesh(S.geoIco0, matLights, lightPos.length);
  lights.name = 'Districts/castle/lights';
  lightPos.forEach((p, i) => {
    d.position.set(p[0], p[1], p[2]);
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(i < gateLightCount ? 0.075 : 0.1);
    d.updateMatrix();
    lights.setMatrixAt(i, d.matrix);
  });
  lights.instanceMatrix.needsUpdate = true;
  lights.computeBoundingSphere();
  lights.frustumCulled = true;
  detail.add(lights);

  // ---- 昼夜窗光：夜间亮起；dispose 时取消订阅 ----
  const applyGlow = (mode) => {
    const night = mode === 'night';
    const sunset = mode === 'sunset';
    matWindow.emissiveIntensity = night ? 2.0 : sunset ? 0.9 : 0.22;
    matLights.emissiveIntensity = night ? 0.95 : sunset ? 0.55 : 0.3;
    matFinial.emissiveIntensity = night ? 1.0 : sunset ? 0.55 : 0.28;
  };
  applyGlow(dayNightCycle.mode);
  const offGlow = dayNightCycle.onChange(({ mode }) => applyGlow(mode));

  detail.userData.castle = {
    towerCount: towers.length,
    heightRange: [Math.min(...towers.map((t) => t.h)), Math.max(...towers.map((t) => t.h))],
    windowCount: wins.length,
  };

  const dispose = () => {
    if (offGlow) offGlow();
    windows.dispose();
    finials.dispose();
    lights.dispose();
    for (const g of owned.geometries) {
      try { g.dispose(); } catch (e) { /* noop */ }
    }
    for (const m of owned.materials) {
      try { m.dispose(); } catch (e) { /* noop */ }
    }
    owned.geometries.length = 0;
    owned.materials.length = 0;
  };
  return { dispose, windowCount: wins.length, towerCount: towers.length };
}
