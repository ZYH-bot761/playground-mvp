/**
 * 都会区街道首层细节（第二轮城市真实感）：
 * - 抬高人行道 + 路缘石，行人有真正的“街沿”；
 * - 行道树 / 长椅 / 垃圾桶 / 防撞柱全部 InstancedMesh；
 * - 商场/学校/医院/居民楼底层雨棚、橱窗、店门；
 * - 停止线、直行箭头、路名、都会区入口门架；
 * - 入园试驾车位与“按 E 上车”导视；
 * - 树池/家具的假接触阴影，零实时阴影开销。
 * 所有新增资源都登记到 Metropolis.owned，dispose 时统一释放。
 */
import * as THREE from 'three';
import { CITY, CITY_ROADS, CITY_INTERSECTIONS, CITY_RESIDENTIAL, HOSPITAL, SCHOOL, MALL, BUS_STOP } from './city-layout.js';

const Y = CITY.pad.y;
const WALK_Y = Y + 0.12;
const _d = new THREE.Object3D();
const _c = new THREE.Color();

function makeCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signTexture(title, sub, accent = '#f4c15d') {
  return makeCanvas(512, 160, (g, w, h) => {
    g.fillStyle = 'rgba(8,18,24,.90)';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = accent;
    g.lineWidth = 5;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#fff';
    g.font = 'bold 52px "Microsoft YaHei", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(title, w / 2, sub ? 58 : 82);
    if (sub) {
      g.fillStyle = 'rgba(235,245,250,.82)';
      g.font = '26px "Microsoft YaHei", sans-serif';
      g.fillText(sub, w / 2, 112);
    }
  });
}

function arrowTexture() {
  return makeCanvas(128, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#f2efdf';
    g.beginPath();
    g.moveTo(64, 16);
    g.lineTo(112, 92);
    g.lineTo(82, 92);
    g.lineTo(82, 236);
    g.lineTo(46, 236);
    g.lineTo(46, 92);
    g.lineTo(16, 92);
    g.closePath();
    g.fill();
  });
}

function softShadowTexture() {
  return makeCanvas(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,.52)');
    grad.addColorStop(0.55, 'rgba(0,0,0,.24)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  });
}

function addInstanced(group, owned, name, geo, mat, items, write) {
  if (!items.length) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  mesh.name = name;
  mesh.frustumCulled = false;
  items.forEach((it, i) => {
    write(it, i);
    mesh.setMatrixAt(i, _d.matrix);
    if (it.color != null) mesh.setColorAt(i, _c.set(it.color));
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  owned.geometries.push(geo);
  owned.materials.push(mat);
  return mesh;
}

/** 建筑临街面雨棚/橱窗的横向位置。 */
function shopFronts() {
  const out = [];
  const push = (x, z, w, color) => out.push({ x, z, w, color });
  for (let x = -11; x <= 11; x += 4.4) push(MALL.x + x, MALL.z - MALL.d / 2 - 0.7, 3.4, 0xd7a34c);
  // 学校不挂商业雨棚：旧版整排雨棚压在操场上，看起来像“操场长出一排牌子”。
  // 只在入口雨棚两侧各留一块校牌底座。
  push(SCHOOL.x - 3.4, SCHOOL.z - 9 - 0.45, 2.4, 0x4f9bc4);
  push(SCHOOL.x + 3.4, SCHOOL.z - 9 - 0.45, 2.4, 0x4f9bc4);
  for (let x = -48; x <= -36; x += 4) push(HOSPITAL.x + x, HOSPITAL.z - HOSPITAL.d / 2 - 0.7, 3.0, 0x3f8d79);
  for (const b of CITY_RESIDENTIAL) {
    const n = Math.max(2, Math.floor(b.w / 5));
    for (let i = 0; i < n; i++) {
      const x = b.x - b.w / 2 + (i + 0.5) * (b.w / n);
      push(x, b.z - b.d / 2 - 0.7, Math.min(3.6, b.w / n - 0.5), i % 2 ? 0xb45b4d : 0xc79a4d);
    }
  }
  return out;
}

export function buildCityDetails({ group, owned }) {
  const g = new THREE.Group();
  g.name = 'City/street-details';
  group.add(g);
  const stats = { trees: 0, benches: 0, awnings: 0, signs: 0, marks: 0 };

  /* ---------------- 人行道 + 路缘石 ---------------- */
  const slabs = [];
  const curbs = [];
  const addWalk = (axis, at, from, to, side) => {
    if (to - from < 1) return;
    const len = to - from;
    const mid = (from + to) / 2;
    // axis='z'：沿 z 走，at 是 x；side 为正时在道路 +x 侧
    if (axis === 'z') {
      slabs.push({ x: at + side * 0.9, z: mid, w: 1.8, d: len });
      curbs.push({ x: at + side * 0.08, z: mid, w: 0.3, d: len });
    } else {
      slabs.push({ x: mid, z: at + side * 0.9, w: len, d: 1.8 });
      curbs.push({ x: mid, z: at + side * 0.08, w: len, d: 0.3 });
    }
  };
  // 主干道：在三条横街处断开；东侧入口试车区再断开一段。
  const zBreaks = [94, ...CITY.crossZ.flatMap((z) => [z - 7, z + 7]), 232];
  for (let i = 0; i < zBreaks.length; i += 2) {
    const a = zBreaks[i], b = zBreaks[i + 1];
    addWalk('z', 16, a, b, -1);
    const east = a < 107 && b > 92 ? [[a, 92], [107, b]] : [[a, b]];
    for (const [c, d] of east) addWalk('z', 32, c, d, 1);
  }
  // 横街：在支路处断开
  for (const z of CITY.crossZ) {
    const xs = [-95, -57, -43, 17, 31, 63, 77, 95];
    for (let i = 0; i < xs.length; i += 2) {
      addWalk('x', z - 6, xs[i], xs[i + 1], -1);
      addWalk('x', z + 6, xs[i], xs[i + 1], 1);
    }
  }
  // 南北支路
  for (const x of [-50, 70]) {
    const zs = [106, 118, 144, 156, 188, 200, 228];
    for (let i = 0; i < zs.length; i += 2) {
      addWalk('z', x - 4.5, zs[i], zs[i + 1], -1);
      addWalk('z', x + 4.5, zs[i], zs[i + 1], 1);
    }
  }

  const sideMat = new THREE.MeshStandardMaterial({ color: 0x9c9a8d, roughness: 0.96 });
  const curbMat = new THREE.MeshStandardMaterial({ color: 0x6f7069, roughness: 0.9 });
  const slabGeo = new THREE.BoxGeometry(1, 0.16, 1);
  const curbGeoBox = new THREE.BoxGeometry(1, 0.22, 1);
  addInstanced(g, owned, 'City/sidewalks', slabGeo, sideMat, slabs, (s) => {
    _d.position.set(s.x, WALK_Y, s.z);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(s.w, 1, s.d);
    _d.updateMatrix();
  });
  addInstanced(g, owned, 'City/curbs', curbGeoBox, curbMat, curbs, (s) => {
    _d.position.set(s.x, Y + 0.11, s.z);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(s.w, 1, s.d);
    _d.updateMatrix();
  });

  /* ---------------- 行道树 + 接触阴影 ---------------- */
  const trees = [];
  const nearCross = (z) => CITY.crossZ.some((c) => Math.abs(z - c) < 9.5);
  for (let z = 103; z <= 208; z += 11) {
    if (nearCross(z) || Math.abs(z - BUS_STOP.z) < 5) continue;
    trees.push({ x: 14.5, z, s: 0.86 + ((z * 7) % 11) / 42 });
    // 入口试车区 z 92…106 留空，避免树池压住车位。
    if (z > 108) trees.push({ x: 33.5, z, s: 0.88 + ((z * 5) % 13) / 46 });
  }
  for (const z of CITY.crossZ) {
    for (let x = -88; x <= 88; x += 15) {
      if (Math.abs(x - 24) < 11 || Math.abs(x + 50) < 8 || Math.abs(x - 70) < 8) continue;
      trees.push({ x, z: z - 7.0, s: 0.82 + (Math.abs(x) % 9) / 38 });
      trees.push({ x, z: z + 7.0, s: 0.82 + (Math.abs(x + 3) % 9) / 38 });
    }
  }
  // 公园入口两侧补树，城市与公园之间不出现硬切。
  for (const x of [-6, 9, 39, 54]) trees.push({ x, z: 86, s: 0.95 });
  stats.trees = trees.length;

  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.4, 5);
  const leafGeo = new THREE.IcosahedronGeometry(1.15, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5e4630, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4c7a43, roughness: 0.96 });
  addInstanced(g, owned, 'City/tree-trunks', trunkGeo, trunkMat, trees, (t) => {
    _d.position.set(t.x, WALK_Y + 1.2 * t.s, t.z);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(t.s, t.s, t.s);
    _d.updateMatrix();
  });
  addInstanced(g, owned, 'City/tree-canopies', leafGeo, leafMat, trees, (t, i) => {
    _d.position.set(t.x, WALK_Y + 3.0 * t.s, t.z);
    _d.rotation.set(0, i * 0.7, 0);
    _d.scale.set(1.0 * t.s, 0.9 * t.s, 1.0 * t.s);
    _d.updateMatrix();
    const tint = [0x4c7a43, 0x5c8a4c, 0x3f6d3f, 0x6b8d4b][i % 4];
    _c.set(tint);
    // 通过临时字段让 addInstanced 写入实例色
    t.color = tint;
    void _c;
  });

  /* ---------------- 长椅 / 垃圾桶 / 防撞柱 ---------------- */
  const benches = [];
  for (let z = 124; z <= 204; z += 26) {
    benches.push({ x: 14.2, z, yaw: Math.PI / 2 });
    benches.push({ x: 33.8, z: z + 8, yaw: -Math.PI / 2 });
  }
  for (const z of CITY.crossZ) {
    benches.push({ x: -60, z: z - 7.1, yaw: 0 });
    benches.push({ x: 52, z: z + 7.1, yaw: Math.PI });
  }
  stats.benches = benches.length;
  const benchGeo = new THREE.BoxGeometry(2.2, 0.16, 0.62);
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x7b5a3a, roughness: 0.9 });
  addInstanced(g, owned, 'City/benches', benchGeo, benchMat, benches, (b) => {
    _d.position.set(b.x, WALK_Y + 0.48, b.z);
    _d.rotation.set(0, b.yaw, 0);
    _d.scale.set(1, 1, 1);
    _d.updateMatrix();
  });

  const bins = [];
  for (let z = 118; z <= 206; z += 30) {
    bins.push({ x: 13.9, z });
    bins.push({ x: 34.1, z: z + 6 });
  }
  const binGeo = new THREE.CylinderGeometry(0.3, 0.34, 0.85, 7);
  const binMat = new THREE.MeshStandardMaterial({ color: 0x3f5a4d, roughness: 0.75, metalness: 0.15 });
  addInstanced(g, owned, 'City/bins', binGeo, binMat, bins, (b) => {
    _d.position.set(b.x, WALK_Y + 0.43, b.z);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(1, 1, 1);
    _d.updateMatrix();
  });

  const bollards = [];
  for (let x = 17.5; x <= 31; x += 2.6) {
    bollards.push({ x, z: 91.4 });
    bollards.push({ x, z: 96.8 });
  }
  for (const z of CITY.crossZ) {
    for (const x of [-44, 15, 33, 75]) bollards.push({ x, z: z - 8.2 });
  }
  const bollardGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.8, 6);
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0xc8c6b8, roughness: 0.65 });
  addInstanced(g, owned, 'City/bollards', bollardGeo, bollardMat, bollards, (b) => {
    _d.position.set(b.x, WALK_Y + 0.4, b.z);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(1, 1, 1);
    _d.updateMatrix();
  });

  /* ---------------- 底层雨棚 / 橱窗 / 店门 ---------------- */
  const shops = shopFronts();
  stats.awnings = shops.length;
  const awnGeo = new THREE.BoxGeometry(1, 0.16, 1.4);
  const awnMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72 });
  addInstanced(g, owned, 'City/shop-awnings', awnGeo, awnMat, shops, (s) => {
    _d.position.set(s.x, Y + 2.75, s.z);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(s.w, 1, 1);
    _d.updateMatrix();
  });
  const glassGeo = new THREE.BoxGeometry(1, 1, 0.12);
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x7fb6bd, emissive: 0xffc27a, emissiveIntensity: 0.25,
    roughness: 0.25, metalness: 0.25,
  });
  addInstanced(g, owned, 'City/shop-windows', glassGeo, glassMat, shops, (s) => {
    _d.position.set(s.x, Y + 1.25, s.z + 0.12);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(s.w - 0.5, 1.7, 1);
    _d.updateMatrix();
  });
  const doorItems = [
    { x: HOSPITAL.entrance.x, z: HOSPITAL.entrance.z, w: 4.2, h: 2.9, color: 0x26363b },
    { x: SCHOOL.entrance.x, z: SCHOOL.entrance.z, w: 5.6, h: 2.5, color: 0x2d3d44 },
    { x: MALL.entrance.x, z: MALL.entrance.z, w: 6.4, h: 2.8, color: 0x1f3038 },
    ...CITY_RESIDENTIAL.slice(3).map((b) => ({ x: b.x, z: b.z - b.d / 2 - 0.2, w: 1.7, h: 2.4, color: 0x44372c })),
  ];
  const doorGeo = new THREE.BoxGeometry(1, 1, 0.16);
  const doorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.2 });
  addInstanced(g, owned, 'City/shop-doors', doorGeo, doorMat, doorItems, (s) => {
    _d.position.set(s.x, Y + s.h / 2, s.z + 0.38);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(s.w, s.h, 1);
    _d.updateMatrix();
  });

  /* ---------------- 停止线 / 直行箭头 ---------------- */
  const stopBars = [];
  const arrows = [];
  for (const it of CITY_INTERSECTIONS) {
    // 横街东西向：右行右侧分别为 -z / +z
    stopBars.push({ x: it.x - it.halfX - 3.4, z: it.z - 3.0, w: 0.5, d: 5.6, yaw: 0 });
    stopBars.push({ x: it.x + it.halfX + 3.4, z: it.z + 3.0, w: 0.5, d: 5.6, yaw: 0 });
    // 主干/支路南北向：右行右侧分别为 +x / -x
    stopBars.push({ x: it.x + (it.halfX + 3.4) * 0.5, z: it.z - it.halfZ - 3.4, w: it.halfX, d: 0.5, yaw: 0 });
    stopBars.push({ x: it.x - (it.halfX + 3.4) * 0.5, z: it.z + it.halfZ + 3.4, w: it.halfX, d: 0.5, yaw: 0 });
    arrows.push({ x: it.x - it.halfX - 9.5, z: it.z - 3.0, yaw: Math.PI / 2 });
    arrows.push({ x: it.x + it.halfX + 9.5, z: it.z + 3.0, yaw: -Math.PI / 2 });
    arrows.push({ x: it.x + 4, z: it.z - it.halfZ - 9.5, yaw: 0 });
    arrows.push({ x: it.x - 4, z: it.z + it.halfZ + 9.5, yaw: Math.PI });
  }
  const barGeo = new THREE.PlaneGeometry(1, 1);
  barGeo.rotateX(-Math.PI / 2);
  const barMat = new THREE.MeshBasicMaterial({ color: 0xf1eee0 });
  addInstanced(g, owned, 'City/stop-bars', barGeo, barMat, stopBars, (s) => {
    _d.position.set(s.x, Y + 0.055, s.z);
    _d.rotation.set(0, s.yaw, 0);
    _d.scale.set(s.w, 1, s.d);
    _d.updateMatrix();
  });
  const arrTex = arrowTexture();
  const arrGeo = new THREE.PlaneGeometry(1.5, 3.4);
  arrGeo.rotateX(-Math.PI / 2);
  const arrMat = new THREE.MeshBasicMaterial({ map: arrTex, transparent: true, depthWrite: false });
  addInstanced(g, owned, 'City/turn-arrows', arrGeo, arrMat, arrows, (s) => {
    _d.position.set(s.x, Y + 0.06, s.z);
    _d.rotation.set(0, s.yaw, 0);
    _d.scale.set(1, 1, 1);
    _d.updateMatrix();
  });
  owned.textures.push(arrTex);
  stats.marks = stopBars.length + arrows.length;

  /* ---------------- 树池/家具假阴影 ---------------- */
  const shadows = [];
  for (const t of trees) shadows.push({ x: t.x, z: t.z, w: 2.2 * t.s, d: 2.2 * t.s });
  for (const b of benches) shadows.push({ x: b.x, z: b.z, w: 2.6, d: 1.0 });
  for (const b of bins) shadows.push({ x: b.x, z: b.z, w: 0.9, d: 0.9 });
  for (const s of shops) shadows.push({ x: s.x, z: s.z, w: s.w, d: 1.6 });
  const shTex = softShadowTexture();
  const shGeo = new THREE.PlaneGeometry(1, 1);
  shGeo.rotateX(-Math.PI / 2);
  const shMat = new THREE.MeshBasicMaterial({
    map: shTex, transparent: true, opacity: 0.55, depthWrite: false, color: 0x11160f,
  });
  addInstanced(g, owned, 'City/contact-shadows', shGeo, shMat, shadows, (s) => {
    _d.position.set(s.x, WALK_Y + 0.018, s.z);
    _d.rotation.set(0, 0, 0);
    _d.scale.set(s.w, 1, s.d);
    _d.updateMatrix();
  });
  owned.textures.push(shTex);

  /* ---------------- 入口门架 / 路名 / 试驾车位 ---------------- */
  const gateMat = new THREE.MeshStandardMaterial({ color: 0x35434a, roughness: 0.55, metalness: 0.35 });
  const gateGlow = new THREE.MeshBasicMaterial({ color: 0x55d7ff, toneMapped: false });
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xece7d3 });
  owned.materials.push(gateMat, gateGlow, lineMat);
  const addBox = (name, w, h, d, x, y, z, mat = gateMat) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set(x, y, z);
    g.add(mesh);
    owned.geometries.push(geo);
    return mesh;
  };
  addBox('City/gate-pylon-w', 1.5, 7.2, 1.8, 14.4, Y + 3.6, 94.0);
  addBox('City/gate-pylon-e', 1.5, 7.2, 1.8, 33.6, Y + 3.6, 94.0);
  addBox('City/gate-beam', 20.7, 1.0, 1.2, 24, Y + 7.3, 94.0);
  addBox('City/gate-light-w', 0.35, 4.4, 0.35, 15.0, Y + 3.4, 94.9, gateGlow);
  addBox('City/gate-light-e', 0.35, 4.4, 0.35, 33.0, Y + 3.4, 94.9, gateGlow);
  const gateTex = signTexture('都会区 · 中央商务区', 'CENTRAL CITY  ·  公园北侧', '#59d8ff');
  const gateSignGeo = new THREE.PlaneGeometry(13.2, 2.0);
  const gateSignMat = new THREE.MeshBasicMaterial({ map: gateTex, transparent: true });
  const gateSign = new THREE.Mesh(gateSignGeo, gateSignMat);
  gateSign.name = 'City/gate-sign';
  gateSign.position.set(24, Y + 6.2, 94.65);
  g.add(gateSign);
  owned.geometries.push(gateSignGeo);
  owned.materials.push(gateSignMat);
  owned.textures.push(gateTex);
  stats.signs += 1;

  // 试驾车位：从主干道切出一个铺装口袋，车头朝北。
  const padGeo = new THREE.PlaneGeometry(CITY.demoParking.w, CITY.demoParking.d);
  padGeo.rotateX(-Math.PI / 2);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x3c4448, roughness: 0.95 });
  const pad = new THREE.Mesh(padGeo, padMat);
  pad.name = 'City/demo-parking';
  pad.position.set(CITY.demoParking.x, Y + 0.055, CITY.demoParking.z);
  g.add(pad);
  owned.geometries.push(padGeo);
  owned.materials.push(padMat);
  for (const z of [93.5, 104.5]) {
    addBox('City/demo-parking-line', 5.8, 0.02, 0.22, CITY.demoParking.x, Y + 0.07, z, lineMat);
  }
  const demoPoleGeo = new THREE.CylinderGeometry(0.08, 0.1, 2.6, 6);
  const demoPole = new THREE.Mesh(demoPoleGeo, gateMat);
  demoPole.position.set(31.2, Y + 1.3, 91.8);
  g.add(demoPole);
  owned.geometries.push(demoPoleGeo);
  const demoTex = signTexture('试驾车', 'TEST DRIVE · 靠近按 E / 点击提示上车', '#f4c15d');
  const demoGeo = new THREE.PlaneGeometry(4.4, 1.4);
  const demoMat = new THREE.MeshBasicMaterial({ map: demoTex, transparent: true, side: THREE.DoubleSide });
  const demoSign = new THREE.Mesh(demoGeo, demoMat);
  demoSign.name = 'City/demo-drive-sign';
  // PlaneGeometry 正面朝 +Z；停车位和玩家都在北侧，正面直接朝向城市，
  // 旧版多转了 180°，从停车位看到的是镜像文字。
  demoSign.position.set(31.2, Y + 2.5, 91.8);
  g.add(demoSign);
  owned.geometries.push(demoGeo);
  owned.materials.push(demoMat);
  owned.textures.push(demoTex);
  stats.signs += 1;

  // 路名：立在公园入口与中央路口，低频但能迅速建立方位感。
  const streetNames = [
    { text: '深南大道', sub: 'SHENNAN AVE', x: 14.1, z: 108.5, yaw: -Math.PI / 2, color: '#4fa9d6' },
    { text: '福华路', sub: 'FUHUA RD', x: -42, z: 105.1, yaw: Math.PI, color: '#64b78b' },
    { text: '都会北街', sub: 'METRO NORTH', x: 65.0, z: 118.5, yaw: Math.PI / 2, color: '#d0a04c' },
  ];
  for (const s of streetNames) {
    const tex = signTexture(s.text, s.sub, s.color);
    const geo = new THREE.PlaneGeometry(3.6, 1.1);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `City/street-name-${s.text}`;
    mesh.position.set(s.x, Y + 3.15, s.z);
    mesh.rotation.y = s.yaw;
    g.add(mesh);
    owned.geometries.push(geo);
    owned.materials.push(mat);
    owned.textures.push(tex);
    stats.signs += 1;
  }

  return {
    stats,
    setNight(f) {
      glassMat.emissiveIntensity = 0.22 + f * 0.95;
      gateGlow.color.setHSL(0.52, 0.9, 0.55 + f * 0.1);
      shMat.opacity = 0.42 + f * 0.08;
    },
  };
}
