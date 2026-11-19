/** 都会区地面 / 路网 / 路灯 / 红绿灯 / 公交站：路灯与信号灯全部 InstancedMesh。 */
import * as THREE from 'three';
import { CITY, CITY_GROUND_MIN_Z, CITY_ROADS, CITY_INTERSECTIONS, PARKING_DRIVE, BUS_STOP } from './city-layout.js';
import { makeParkingTexture, makeAsphaltDetail } from './city-textures.js';

function planeGeo(w, d) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  return g;
}

function poolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,214,150,.85)');
  grad.addColorStop(0.45, 'rgba(255,184,96,.28)');
  grad.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signTexture(text, bg) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 256, 80);
  g.fillStyle = '#fff'; g.font = 'bold 40px "Microsoft YaHei",sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 42);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildCityBase({ group, owned }) {
  const y = CITY.pad.y;
  const horizonGeo = planeGeo(CITY.horizon.size, CITY.horizon.size);
  const horizonMat = new THREE.MeshStandardMaterial({ color: 0x4e6c46, roughness: 1 });
  const horizon = new THREE.Mesh(horizonGeo, horizonMat);
  horizon.position.set(0, CITY.horizon.y, 130);
  horizon.receiveShadow = false;
  group.add(horizon);
  owned.geometries.push(horizonGeo);
  owned.materials.push(horizonMat);

  const geo = planeGeo(1, 1);
  const items = [];
  const add = (x, z, w, d, color, yy = y + 0.01) => items.push({ x, z, w, d, color, y: yy });

  // 基座 / 人行道 / 车道：南缘必须铺到沥青起点（z=88），旧版基座从 94 开始，
  // 主干道 88…94 那段等于一块悬在公园上空 1.18m 的沥青舌头。
  add(0, (CITY_GROUND_MIN_Z + CITY.pad.maxZ) / 2, 190, CITY.pad.maxZ - CITY_GROUND_MIN_Z, 0x6d756d, y);
  for (const r of CITY_ROADS) {
    if (r.axis === 'z') {
      add(r.center, (r.min + r.max) / 2, r.width, r.max - r.min, 0x30373d, y + 0.025);
      add(r.center - r.width / 2 - 0.9, (r.min + r.max) / 2, 1.8, r.max - r.min, 0xa9a79b, y + 0.02);
      add(r.center + r.width / 2 + 0.9, (r.min + r.max) / 2, 1.8, r.max - r.min, 0xa9a79b, y + 0.02);
    } else {
      add((r.min + r.max) / 2, r.center, r.max - r.min, r.width, 0x30373d, y + 0.025);
      add((r.min + r.max) / 2, r.center - r.width / 2 - 0.8, r.max - r.min, 1.6, 0xa9a79b, y + 0.02);
      add((r.min + r.max) / 2, r.center + r.width / 2 + 0.8, r.max - r.min, 1.6, 0xa9a79b, y + 0.02);
    }
  }
  // 停车场进出车道
  add((PARKING_DRIVE.fromX + PARKING_DRIVE.toX) / 2, PARKING_DRIVE.z,
    PARKING_DRIVE.fromX - PARKING_DRIVE.toX, PARKING_DRIVE.width, 0x30373d, y + 0.03);

  /* 【风景提质】路面加近白骨料细节图（map + roughnessMap）：打破纯色沥青，
   * 与 instanceColor 相乘不脏色；仍是 1 个 InstancedMesh，零增面零增 call。 */
  const asphaltDetail = makeAsphaltDetail();
  owned.textures.push(asphaltDetail);
  const padMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
    map: asphaltDetail, roughnessMap: asphaltDetail, roughness: 0.92,
  }), items.length);
  padMesh.name = 'City/roads';
  padMesh.frustumCulled = false;
  padMesh.receiveShadow = false;
  const d = new THREE.Object3D();
  items.forEach((it, i) => {
    d.position.set(it.x, it.y, it.z);
    d.rotation.set(0, 0, 0);
    d.scale.set(it.w, 1, it.d);
    d.updateMatrix();
    padMesh.setMatrixAt(i, d.matrix);
    padMesh.setColorAt(i, new THREE.Color(it.color));
  });
  if (padMesh.instanceColor) padMesh.instanceColor.needsUpdate = true;
  group.add(padMesh);
  owned.geometries.push(geo);
  owned.materials.push(padMesh.material);

  // 车道虚线 / 斑马线：同一材质、一个 InstancedMesh
  const marks = [];
  for (const r of CITY_ROADS) {
    if (r.axis === 'z') {
      for (let z = r.min + 4; z < r.max - 3; z += 8) {
        marks.push({ x: r.center, z, w: 0.16, d: 3.2, c: 0xe8e5d2 });
        // 16m 主干道 = 双向四车道：±3.25m 车道分界虚线
        if (r.kind === 'main') {
          marks.push({ x: r.center - 3.25, z, w: 0.14, d: 3.2, c: 0xe8e5d2 });
          marks.push({ x: r.center + 3.25, z, w: 0.14, d: 3.2, c: 0xe8e5d2 });
        }
      }
      if (r.kind === 'main') {
        for (let z = r.min + 1; z < r.max - 1; z += 4) {
          marks.push({ x: r.center - 0.16, z, w: 0.12, d: 3.6, c: 0xe3b94a });
          marks.push({ x: r.center + 0.16, z, w: 0.12, d: 3.6, c: 0xe3b94a });
        }
      }
    } else {
      for (let x = r.min + 4; x < r.max - 3; x += 8) {
        marks.push({ x, z: r.center, w: 3.2, d: 0.16, c: 0xe8e5d2 });
      }
    }
  }
  // 9 个路口的四边斑马线；斑马线放在路口外沿，避免与转弯车流重叠
  for (const it of CITY_INTERSECTIONS) {
    const zEdge = it.halfZ + 1.75;
    const xEdge = it.halfX + 1.75;
    for (const s of [-1, 1]) {
      // 横穿南北向道路（行人沿 x 走）
      for (let k = -Math.floor(it.halfX / 1.05); k <= Math.floor(it.halfX / 1.05); k++) {
        const x = it.x + k * 1.05;
        if (Math.abs(x - it.x) > it.halfX - 0.4) continue;
        marks.push({ x, z: it.z + s * zEdge, w: 0.62, d: 3.4, c: 0xf0eddc });
      }
      // 横穿东西向道路（行人沿 z 走）
      for (let k = -Math.floor(it.halfZ / 1.05); k <= Math.floor(it.halfZ / 1.05); k++) {
        const z = it.z + k * 1.05;
        if (Math.abs(z - it.z) > it.halfZ - 0.4) continue;
        marks.push({ x: it.x + s * xEdge, z, w: 3.4, d: 0.62, c: 0xf0eddc });
      }
    }
  }
  // 公园入口斑马线
  for (let k = -3; k <= 3; k++) {
    marks.push({ x: 24 + k * 2.2, z: 20, w: 1.1, d: 4.4, c: 0xf0eddc });
  }
  // 都会区入口斑马线：玩家从公园跨入城市时先看到人行横道，而不是硬切路缘。
  for (let k = -3; k <= 3; k++) {
    marks.push({ x: 24 + k * 2.2, z: 91.2, w: 1.1, d: 4.0, c: 0xf0eddc });
  }
  // 公交站黄色停靠带
  for (let z = 34; z <= 43; z += 1.2) {
    marks.push({ x: 31.9, z, w: 0.18, d: 0.8, c: 0xe6c454 });
  }
  const markGeo = planeGeo(1, 1);
  const markMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const markMesh = new THREE.InstancedMesh(markGeo, markMat, marks.length);
  markMesh.name = 'City/road-marks';
  markMesh.frustumCulled = false;
  marks.forEach((m, i) => {
    d.position.set(m.x, y + 0.045, m.z);
    d.scale.set(m.w, 1, m.d);
    d.updateMatrix();
    markMesh.setMatrixAt(i, d.matrix);
    markMesh.setColorAt(i, new THREE.Color(m.c));
  });
  if (markMesh.instanceColor) markMesh.instanceColor.needsUpdate = true;
  group.add(markMesh);
  owned.geometries.push(markGeo);
  owned.materials.push(markMat);

  // 停车场铺装
  const pTex = makeParkingTexture();
  const pGeo = planeGeo(CITY.parking.w, CITY.parking.d);
  const pMat = new THREE.MeshStandardMaterial({ map: pTex, roughness: 0.95 });
  const pMesh = new THREE.Mesh(pGeo, pMat);
  pMesh.position.set(CITY.parking.x, y + 0.05, CITY.parking.z);
  group.add(pMesh);
  owned.textures.push(pTex);
  owned.geometries.push(pGeo);
  owned.materials.push(pMat);

  // ---- 路灯：杆 / 横臂 / 灯头 / 地面光斑，全部 InstancedMesh ----
  const polePos = [];
  for (let z = 100; z <= 216; z += 18) {
    // 8.55m = 路缘外 0.55m：旧值 7.3m 把灯杆插进了 16m 主干道。
    polePos.push({ x: 24 - 8.55, z, side: -1 });
    polePos.push({ x: 24 + 8.55, z, side: 1 });
  }
  for (const z of CITY.crossZ) {
    for (let x = -84; x <= 84; x += 22) {
      if (Math.abs(x - 24) < 12 || Math.abs(x + 50) < 9 || Math.abs(x - 70) < 9) continue;
      polePos.push({ x, z: z - 7.2, side: -1, axis: 'x' });
      polePos.push({ x, z: z + 7.2, side: 1, axis: 'x' });
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.17, 7.2, 6);
  const armGeo = new THREE.BoxGeometry(1.7, 0.13, 0.13);
  const headGeo = new THREE.SphereGeometry(0.32, 6, 4);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x354046, roughness: 0.65, metalness: 0.35 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffd9a3, emissive: 0xffb35c, emissiveIntensity: 0.15, roughness: 0.5,
  });
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, polePos.length);
  const armMesh = new THREE.InstancedMesh(armGeo, poleMat, polePos.length);
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, polePos.length);
  for (const m of [poleMesh, armMesh, headMesh]) {
    m.name = `City/streetlight-${m === poleMesh ? 'pole' : m === armMesh ? 'arm' : 'head'}`;
    m.frustumCulled = false;
    m.castShadow = false;
    group.add(m);
  }
  polePos.forEach((p, i) => {
    const towardRoad = p.axis === 'x' ? { x: 0, z: -p.side } : { x: -p.side, z: 0 };
    d.position.set(p.x, y + 3.6, p.z);
    d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix();
    poleMesh.setMatrixAt(i, d.matrix);
    d.position.set(p.x + towardRoad.x * 0.8, y + 7.1, p.z + towardRoad.z * 0.8);
    d.rotation.set(0, p.axis === 'x' ? 0 : Math.PI / 2, 0);
    d.updateMatrix();
    armMesh.setMatrixAt(i, d.matrix);
    d.position.set(p.x + towardRoad.x * 1.62, y + 7.02, p.z + towardRoad.z * 1.62);
    d.rotation.set(0, 0, 0); d.updateMatrix();
    headMesh.setMatrixAt(i, d.matrix);
  });
  owned.geometries.push(poleGeo, armGeo, headGeo);
  owned.materials.push(poleMat, headMat);

  const poolTex = poolTexture();
  const poolGeo = planeGeo(7.2, 7.2);
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, color: 0xffc887,
  });
  const poolMesh = new THREE.InstancedMesh(poolGeo, poolMat, polePos.length);
  poolMesh.name = 'City/streetlight-pools';
  poolMesh.frustumCulled = false;
  polePos.forEach((p, i) => {
    d.position.set(p.x + (p.axis === 'x' ? 0 : -p.side * 2.2), y + 0.06, p.z + (p.axis === 'x' ? -p.side * 2.2 : 0));
    d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix();
    poolMesh.setMatrixAt(i, d.matrix);
  });
  group.add(poolMesh);
  owned.textures.push(poolTex);
  owned.geometries.push(poolGeo);
  owned.materials.push(poolMat);

  // ---- 红绿灯由 city-signals.js 统一构建：9 路口 × 4 方向 + 倒计时 ----

  // ---- 公交站：顶棚 / 立柱 / 长椅 / 站牌 ----
  const stop = new THREE.Group();
  stop.name = 'City/bus-stop';
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x2b6e62, roughness: 0.5, metalness: 0.25 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x4b5558, roughness: 0.55, metalness: 0.3 });
  const roofGeo = new THREE.BoxGeometry(5.2, 0.18, 2.4);
  const postGeo = new THREE.CylinderGeometry(0.09, 0.09, 2.9, 5);
  const benchGeo = new THREE.BoxGeometry(3.4, 0.16, 0.5);
  const roof = new THREE.Mesh(roofGeo, roofMat); roof.position.set(0, 3.0, 0); stop.add(roof);
  for (const sx of [-2.2, 2.2]) {
    const p = new THREE.Mesh(postGeo, postMat); p.position.set(sx, 1.45, 0); stop.add(p);
  }
  const bench = new THREE.Mesh(benchGeo, postMat); bench.position.set(0, 0.55, 0.4); stop.add(bench);
  const sTex = signTexture('公交站 · BUS', '#1f6a5c');
  const sGeo = new THREE.PlaneGeometry(2.4, 0.75);
  const sMat = new THREE.MeshBasicMaterial({ map: sTex, transparent: true });
  const sign = new THREE.Mesh(sGeo, sMat); sign.position.set(0, 2.35, 1.23); stop.add(sign);
  stop.position.set(BUS_STOP.x, y, BUS_STOP.z);
  stop.rotation.y = -Math.PI / 2;
  group.add(stop);
  owned.geometries.push(roofGeo, postGeo, benchGeo, sGeo);
  owned.materials.push(roofMat, postMat, sMat);
  owned.textures.push(sTex);

  return {
    polePos,
    roadMat: padMesh.material,
    markMat: markMesh.material,
    horizonMat,
    setNight(f) {
      // 夜间路面与标线一起压暗，只让路灯/车灯叠加光斑发亮
      const road = 1 - f * 0.82;
      padMesh.material.color.setRGB(road, road, road);
      const mark = 1 - f * 0.84;
      markMesh.material.color.setRGB(mark, mark, mark);
      horizonMat.color.setHex(f > 0.45 ? 0x1a2620 : 0x4e6c46);
      headMat.emissiveIntensity = 0.15 + f * 2.1;
      poolMat.opacity = f * 0.52;
    },
  };
}
