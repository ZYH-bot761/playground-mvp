/**
 * ============================================================================
 * Farm.js —— 阶段三：农家宝三主田 + 菜圃（水稻 / 玉米 / 小麦 / 南瓜甘蓝）
 * ============================================================================
 * 布局：谷仓+风车在北侧；水稻田（西）、玉米地（东）、小麦田（南）、
 *       小菜圃（东南）。所有作物按行列矩阵整齐种植，行间留田埂/过道，
 *       作物无碰撞，玩家可走进田里，玉米高度 1.85~2.0m 可没过头顶。
 *
 * 几何：叶片用十字交叉 PlaneGeometry + 3 格叶片图集 alphaTest；每类作物
 *       一个 InstancedMesh；茎/穗/果/土垄/结构全部合并。目标 ≤8 draw call。
 * 资源：自有几何/材质在 dispose 释放；叶片/泥土粗糙度纹理由 Lobby 共享。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildFarmWorkers } from './farm-workers.js';

/** 图集 UV 子矩形（Canvas 左上 → Three UV 左下） */
const CELL = {
  rice: [0, 0.5, 0.5, 1.0],
  wheat: [0.5, 0.5, 1.0, 1.0],
  corn: [0, 0, 0.5, 0.5],
  white: [0.5, 0, 1.0, 0.5],
};

const RICE = { leaf: 0x78c850, head: 0xd8d26a, h: [1.0, 1.2] };
const CORN = { leaf: 0x3f7f32, stalk: 0x2f6b2a, cob: 0x9c6a24, tassel: 0x8a6428, h: [1.85, 2.0] };
const WHEAT = { leaf: 0xd9b54a, head: 0xf0d27a, h: [0.78, 0.82] };

function paint(g, hex) {
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

function remapUV(g, cell) {
  const uv = g.attributes.uv;
  if (!uv) return g;
  const [u0, v0, u1, v1] = cell;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return g;
}

/** 一片叶：底边落在 y=0，高度 h，宽度 w，可绕 Y 旋转/绕 Z 倾斜 */
function leafPart(baseGeo, hex, cell, w, h, rotY = 0, tiltZ = 0) {
  const g = baseGeo.clone();
  remapUV(g, cell);
  g.scale(w, h, 1);
  g.translate(0, h / 2, 0);
  if (tiltZ) g.rotateZ(tiltZ);
  if (rotY) g.rotateY(rotY);
  return paint(g, hex);
}

/** 实体部件：可缩放/平移/旋转，UV 收到图集纯白格，颜色由顶点色控制 */
function solidPart(geo, hex, pos, scale, rot = [0, 0, 0]) {
  const g = geo.clone();
  remapUV(g, CELL.white);
  paint(g, hex);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
  g.applyMatrix4(m);
  return g;
}

function mergeParts(parts, label) {
  const geo = mergeGeometries(parts, false);
  if (!geo) throw new Error(`[Farm] ${label} mergeGeometries 失败`);
  geo.computeBoundingSphere();
  parts.forEach((g) => g.dispose());
  return geo;
}

function buildRice(S) {
  const parts = [];
  for (let i = 0; i < 2; i += 1) {
    parts.push(leafPart(S.geoPlane, 0xffffff, CELL.rice, 0.55, 1.0, (i * Math.PI) / 2));
  }
  parts.push(solidPart(new THREE.ConeGeometry(1, 1, 2), RICE.head, [0, 0.9, 0], [0.11, 0.26, 0.11]));
  return mergeParts(parts, 'rice');
}

function buildWheat(S) {
  const parts = [];
  for (let i = 0; i < 2; i += 1) {
    parts.push(leafPart(S.geoPlane, 0xffffff, CELL.wheat, 0.5, 1.0, (i * Math.PI) / 2));
  }
  parts.push(solidPart(new THREE.ConeGeometry(1, 1, 2), WHEAT.head, [0, 0.93, 0], [0.09, 0.24, 0.09]));
  return mergeParts(parts, 'wheat');
}

function buildCorn(S) {
  const parts = [];
  // 粗茎：5 面开口圆柱，10 面
  parts.push(solidPart(new THREE.CylinderGeometry(0.04, 0.06, 1, 5, 1, true),
    CORN.stalk, [0, 0.5, 0], [1, 1, 1]));
  // 3 片宽叶，绕茎 120° 分布
  for (let i = 0; i < 3; i += 1) {
    const g = leafPart(S.geoPlane, 0xffffff, CELL.corn, 0.65, 0.72,
      (i * Math.PI * 2) / 3, (i % 2 ? 1 : -1) * 0.22);
    g.translate(0, 0.28, 0);
    parts.push(g);
  }
  // 玉米棒：中上部，金黄；顶部雄穗
  parts.push(solidPart(new THREE.CylinderGeometry(0.028, 0.022, 0.16, 4, 1, true),
    CORN.cob, [0.06, 0.56, 0.02], [1, 1, 1], [0.18, 0, 0.28]));
  parts.push(solidPart(new THREE.ConeGeometry(0.03, 0.1, 2),
    CORN.tassel, [0, 1.0, 0], [1, 1, 1]));
  return mergeParts(parts, 'corn');
}

function buildVegLeaves(S) {
  const parts = [];
  for (let i = 0; i < 3; i += 1) {
    parts.push(leafPart(S.geoPlane, 0xffffff, CELL.rice, 0.44, 0.46,
      (i * Math.PI * 2) / 3, (i % 2 ? 1 : -1) * 0.3));
  }
  return mergeParts(parts, 'veg-leaves');
}

/**
 * @param {THREE.Group} detail Districts 的 farm detail 组（世界坐标建，由 Districts rebase）
 * @param {object} S Lobby 共享几何/纹理
 * @param {{cx:number, cz:number}} center farm 区中心世界坐标
 */
export function buildFarm(detail, S, center) {
  const cx = center.cx;
  const cz = center.cz;
  const baseY = 1.12;
  const owned = { geometries: [], materials: [] };
  const mat = (opts) => {
    const m = new THREE.MeshStandardMaterial(opts);
    owned.materials.push(m);
    return m;
  };
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const rnd = (a) => {
    const s = Math.sin(a * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  };

  // ---- 地块定义（x0/z0 为左上角，w/d 为田块尺寸）----
  const fields = {
    rice: { x0: cx - 24, z0: cz - 10, w: 18, d: 15, rows: 18, cols: 20 },
    corn: { x0: cx + 2, z0: cz - 10, w: 20, d: 16, rows: 14, cols: 12 },
    wheat: { x0: cx - 24, z0: cz + 12, w: 26, d: 12, rows: 15, cols: 24 },
    veg: { x0: cx + 6, z0: cz + 12, w: 14, d: 10, rows: 4, cols: 10 },
  };

  // ---- 土垄 / 田块底板 / 田埂：合并成 1 个 Mesh ----
  const soilParts = [];
  const soilBase = 0x5a4632;
  const soilRidge = 0x6b5238;
  const pathColor = 0x9a8a6a;
  for (const f of Object.values(fields)) {
    soilParts.push(solidPart(S.geoBox, soilBase,
      [f.x0 + f.w / 2, 1.105, f.z0 + f.d / 2], [f.w, 0.06, f.d]));
    const rowStep = f.d / f.rows;
    for (let row = 0; row < f.rows; row += 1) {
      soilParts.push(solidPart(S.geoBox, soilRidge,
        [f.x0 + f.w / 2, 1.18, f.z0 + (row + 0.5) * rowStep],
        [f.w * 0.98, 0.16, Math.max(0.24, rowStep * 0.45)]));
    }
  }
  // 十字田埂：东西向 + 南北向
  soilParts.push(solidPart(S.geoBox, pathColor,
    [cx - 3, 1.135, cz + 7], [8, 0.05, 38]));
  soilParts.push(solidPart(S.geoBox, pathColor,
    [cx - 2, 1.135, cz + 8.5], [50, 0.05, 5]));
  const soilGeo = mergeParts(soilParts, 'soil');
  owned.geometries.push(soilGeo);
  const matSoil = mat({
    vertexColors: true, roughnessMap: S.texSoilRough, roughness: 0.96, metalness: 0,
  });
  const soil = new THREE.Mesh(soilGeo, matSoil);
  soil.name = 'Districts/farm/soil';
  soil.frustumCulled = true;
  detail.add(soil);

  // ---- 谷仓 + 风车 + 筒仓 + 围栏：合并成 1 个 Mesh ----
  const structParts = [];
  const barnX = cx - 17;
  const barnZ = cz - 18;
  structParts.push(solidPart(S.geoBox, 0xc65b4a,
    [barnX, 4, barnZ], [12, 8, 10]));
  structParts.push(solidPart(S.geoCone, 0x8a5a34,
    [barnX, 10.6, barnZ], [9.2, 5.2, 8.2]));
  structParts.push(solidPart(S.geoBox, 0xf4f1e6,
    [barnX, 4.2, barnZ + 5.05], [5.4, 4.4, 0.25]));
  // 筒仓
  structParts.push(solidPart(S.geoCylinder, 0xd8d2c2,
    [cx - 24, 4.5, cz - 20], [2.1, 9, 2.1]));
  structParts.push(solidPart(S.geoCone, 0x8a5a34,
    [cx - 24, 9.9, cz - 20], [2.5, 2.4, 2.5]));
  // 风车塔
  structParts.push(solidPart(S.geoCylinder, 0xf4f1e6,
    [cx - 9, 6, cz - 20], [2.5, 12, 2.5]));
  structParts.push(solidPart(S.geoCone, 0x8a5a34,
    [cx - 9, 13.4, cz - 20], [2.9, 3.2, 2.9]));
  // 静态叶片：十字四叶
  structParts.push(solidPart(S.geoBox, 0xf4f1e6,
    [cx - 9, 10.2, cz - 17.3], [0.45, 5.2, 0.22]));
  structParts.push(solidPart(S.geoBox, 0xf4f1e6,
    [cx - 9, 10.2, cz - 17.3], [5.2, 0.45, 0.22]));
  // 南侧围栏：8 根柱 + 2 根横杆
  for (let i = 0; i < 8; i += 1) {
    const x = cx - 24 + i * 6.6;
    structParts.push(solidPart(S.geoBox, 0x8a6242,
      [x, 1.7, cz + 26], [0.22, 1.4, 0.22]));
  }
  structParts.push(solidPart(S.geoBox, 0x8a6242,
    [cx - 1, 2.05, cz + 26], [48, 0.18, 0.18]));
  structParts.push(solidPart(S.geoBox, 0x8a6242,
    [cx - 1, 1.45, cz + 26], [48, 0.18, 0.18]));
  const structGeo = mergeParts(structParts, 'structure');
  owned.geometries.push(structGeo);
  const matStruct = mat({
    vertexColors: true, roughnessMap: S.texSoilRough, roughness: 0.9, metalness: 0,
  });
  const struct = new THREE.Mesh(structGeo, matStruct);
  struct.name = 'Districts/farm/structure';
  struct.frustumCulled = true;
  detail.add(struct);

  // ---- 作物几何（每类 1 个 InstancedMesh）----
  const riceGeo = buildRice(S);
  const cornGeo = buildCorn(S);
  const wheatGeo = buildWheat(S);
  const vegLeafGeo = buildVegLeaves(S);
  const vegFruitGeo = remapUV(S.geoIco0.clone(), CELL.white);
  owned.geometries.push(riceGeo, cornGeo, wheatGeo, vegLeafGeo, vegFruitGeo);

  const matCrop = mat({
    vertexColors: true, map: S.texCropLeaf, alphaTest: 0.45,
    side: THREE.DoubleSide, roughness: 0.95, metalness: 0, envMapIntensity: 0.12,
  });
  const matFruit = mat({ color: 0xffffff, roughness: 0.72, metalness: 0 });

  const cropMeshes = [];
  let instCount = 0;

  const plantField = (type, f, geo, material, spec) => {
    const count = f.rows * f.cols;
    const im = new THREE.InstancedMesh(geo, material, count);
    im.name = `Districts/farm/crop-${type}`;
    const xStep = f.w / f.cols;
    const zStep = f.d / f.rows;
    const bases = [];
    let idx = 0;
    for (let row = 0; row < f.rows; row += 1) {
      for (let col = 0; col < f.cols; col += 1) {
        const h = spec.h[0] + rnd(type.length * 19 + idx * 3.1) * (spec.h[1] - spec.h[0]);
        const yaw = rnd(type.length * 31 + idx * 7.7) * Math.PI * 2;
        const wide = 0.9 + rnd(type.length * 43 + idx * 5.3) * 0.2;
        dummy.position.set(f.x0 + (col + 0.5) * xStep, baseY, f.z0 + (row + 0.5) * zStep);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(wide, h, wide);
        dummy.updateMatrix();
        im.setMatrixAt(idx, dummy.matrix);
        const shade = 0.88 + rnd(type.length * 61 + idx * 9.1) * 0.2;
        color.setScalar(shade);
        im.setColorAt(idx, color);
        bases.push({
          x: f.x0 + (col + 0.5) * xStep, z: f.z0 + (row + 0.5) * zStep,
          yaw, wide, h, jitter: rnd(type.length * 71 + idx * 4.7) * 0.12,
        });
        idx += 1;
      }
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.frustumCulled = true;
    im.userData = {
      crop: type, heightRange: spec.h, rows: f.rows, cols: f.cols,
      rowGap: zStep, colGap: xStep, walkable: true, instanceCount: count,
      instances: bases,
    };
    detail.add(im);
    cropMeshes.push(im);
    instCount += count;
  };

  plantField('rice', fields.rice, riceGeo, matCrop, RICE);
  plantField('corn', fields.corn, cornGeo, matCrop, CORN);
  plantField('wheat', fields.wheat, wheatGeo, matCrop, WHEAT);

  // ---- 菜圃：4 种蔬菜（南瓜/甘蓝/番茄/马铃薯），叶与果各 1 个 InstancedMesh ----
  const vegTypes = [
    { name: 'pumpkin', color: 0xe08a2a, s: [0.3, 0.22, 0.3], y: 0.28 },
    { name: 'cabbage', color: 0x7fb84a, s: [0.27, 0.2, 0.27], y: 0.25 },
    { name: 'tomato', color: 0xe2472f, s: [0.13, 0.13, 0.13], y: 0.34 },
    { name: 'potato', color: 0x9c7a4a, s: [0.2, 0.12, 0.2], y: 0.2 },
  ];
  const f = fields.veg;
  const vegCount = f.rows * f.cols;
  const vegLeaves = new THREE.InstancedMesh(vegLeafGeo, matCrop, vegCount);
  vegLeaves.name = 'Districts/farm/crop-veg-leaves';
  const vegFruits = new THREE.InstancedMesh(vegFruitGeo, matFruit, vegCount);
  vegFruits.name = 'Districts/farm/crop-veg-fruits';
  const vx = f.w / f.cols;
  const vz = f.d / f.rows;
  const vegBases = [];
  let vi = 0;
  for (let row = 0; row < f.rows; row += 1) {
    const t = vegTypes[row % vegTypes.length];
    for (let col = 0; col < f.cols; col += 1) {
      const x = f.x0 + (col + 0.5) * vx;
      const z = f.z0 + (row + 0.5) * vz;
      const wide = 0.9 + rnd(vi * 3.7) * 0.25;
      dummy.position.set(x, baseY, z);
      dummy.rotation.set(0, rnd(vi * 7.1) * Math.PI * 2, 0);
      dummy.scale.set(wide, 0.9 + rnd(vi * 5.9) * 0.3, wide);
      dummy.updateMatrix();
      vegLeaves.setMatrixAt(vi, dummy.matrix);
      const leafYaw = dummy.rotation.y;
      color.setScalar(0.9 + rnd(vi * 9.3) * 0.18);
      vegLeaves.setColorAt(vi, color);
      dummy.position.set(x, baseY + t.y, z);
      dummy.rotation.set(0, rnd(vi * 11.3) * Math.PI * 2, 0);
      dummy.scale.set(t.s[0], t.s[1], t.s[2]);
      dummy.updateMatrix();
      vegFruits.setMatrixAt(vi, dummy.matrix);
      color.setHex(t.color);
      vegFruits.setColorAt(vi, color);
      vegBases.push({
        x, z, leafYaw, leafWide: wide,
        fruitYaw: dummy.rotation.y, kind: t, jitter: rnd(vi * 13.7) * 0.1,
      });
      vi += 1;
    }
  }
  for (const im of [vegLeaves, vegFruits]) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.frustumCulled = true;
    detail.add(im);
  }
  vegLeaves.userData = {
    crop: 'veg-leaves', heightRange: [0.3, 0.5], rows: f.rows, cols: f.cols,
    rowGap: vz, colGap: vx, walkable: true, instanceCount: vegCount,
    instances: vegBases,
  };
  vegFruits.userData = {
    crop: 'veg-fruits', kinds: vegTypes.map((v) => v.name), instanceCount: vegCount,
    instances: vegBases,
  };
  cropMeshes.push(vegLeaves, vegFruits);
  instCount += vegCount * 2;

  // 【阶段二】弯腰插秧 / 挥锄头农民：分关节 InstancedMesh，动作全部写矩阵。
  const workers = buildFarmWorkers(detail, center, owned);

  /* ---------------- 农事循环：生长 → 成熟 → 收割 → 空地 → 再播种 ---------------- */
  // 玩家一进农场就能看到接近成熟的田，之后每隔二十多秒真的会收割空一垄，
  // 再慢慢长回来；不是永远一片“塑料庄稼”占着地。
  const CYCLE = 28;
  const fieldPhase = {
    rice: 0.58, corn: 0.66, wheat: 0.73, veg: 0.61,
  };
  const growthAt = (t, offset, jitter) => {
    const p = (((t / CYCLE) + offset + jitter) % 1 + 1) % 1;
    if (p < 0.52) return { g: 0.06 + 0.94 * (p / 0.52), phase: 'grow' };
    if (p < 0.76) return { g: 1, phase: 'ripe' };
    if (p < 0.90) return { g: Math.max(0.02, 1 - (p - 0.76) / 0.14), phase: 'harvest' };
    return { g: 0.02, phase: 'fallow' };
  };
  let lastT = -1;
  let farmAccum = 0;
  let lastPhase = 'ripe';
  const updateFarm = (t) => {
    const dt = lastT < 0 ? 0 : Math.max(0, Math.min(0.25, t - lastT));
    lastT = t;
    farmAccum += dt;
    workers.update(t); // 农民动作每帧连续，不抽帧
    if (farmAccum < 0.12) return;
    farmAccum = 0;

    for (const im of [cropMeshes[0], cropMeshes[1], cropMeshes[2]]) {
      if (!im?.userData?.instances) continue;
      const off = fieldPhase[im.userData.crop] ?? 0.6;
      im.userData.instances.forEach((b, i) => {
        const st = growthAt(t, off, b.jitter);
        lastPhase = st.phase;
        const g = st.g;
        dummy.position.set(b.x, baseY, b.z);
        dummy.rotation.set(0, b.yaw, 0);
        const sc = Math.max(0.0001, g);
        dummy.scale.set(b.wide * (0.35 + 0.65 * sc), Math.max(0.0001, b.h * (0.10 + 0.90 * sc)), b.wide * (0.35 + 0.65 * sc));
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
    }

    const bases = vegLeaves.userData.instances;
    bases?.forEach((b, i) => {
      const st = growthAt(t, fieldPhase.veg, b.jitter);
      const g = st.g;
      dummy.position.set(b.x, baseY, b.z);
      dummy.rotation.set(0, b.leafYaw, 0);
      dummy.scale.set(b.leafWide * (0.3 + 0.7 * g), 0.9 * (0.12 + 0.88 * g), b.leafWide * (0.3 + 0.7 * g));
      dummy.updateMatrix();
      vegLeaves.setMatrixAt(i, dummy.matrix);
      const t2 = b.kind;
      dummy.position.set(b.x, baseY + t2.y * (0.2 + 0.8 * g), b.z);
      dummy.rotation.set(0, b.fruitYaw, 0);
      const fs = g > 0.82 ? Math.min(1, (g - 0.82) / 0.16) : 0.0001;
      dummy.scale.set(t2.s[0] * fs, t2.s[1] * fs, t2.s[2] * fs);
      dummy.updateMatrix();
      vegFruits.setMatrixAt(i, dummy.matrix);
    });
    vegLeaves.instanceMatrix.needsUpdate = true;
    vegFruits.instanceMatrix.needsUpdate = true;
  };

  const dispose = () => {
    workers.dispose();
    for (const im of cropMeshes) {
      try { im.dispose(); } catch (e) { /* noop */ }
    }
    for (const g of owned.geometries) {
      try { g.dispose(); } catch (e) { /* noop */ }
    }
    for (const m of owned.materials) {
      try { m.dispose(); } catch (e) { /* noop */ }
    }
    owned.geometries.length = 0;
    owned.materials.length = 0;
    cropMeshes.length = 0;
  };
  return {
    dispose,
    instCount,
    update: updateFarm,
    workers: { ...workers.stats, cropCycleSeconds: CYCLE, cropPhase: () => lastPhase },
    stats: { cropCycleSeconds: CYCLE, fieldsWithGrowth: 4 },
  };
}
