/**
 * 都会区北侧湖滨：大水面 + 沙滩 + 棕榈 + 遮阳伞 + 脚踏船。
 * 位置选在西支路与主干道之间、北横街以北的整块空地；拆除原北侧 3 栋
 * 居民楼后，这里终于形成“城市边缘的湖岸公园”，而不是几栋楼孤零零站在草地。
 * 全部低模、贴图程序生成；水面只滚动 UV，热路径零分配。
 */
import * as THREE from 'three';
import { CITY_LAKE } from './city-layout.js';

const Y = 1.16;

function roundedRect(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function shapePlane(w, d, r) {
  const geo = new THREE.ShapeGeometry(roundedRect(w, d, r), 28);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function sandTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#d8c69c';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i += 1) {
    const v = 190 + Math.random() * 55;
    g.fillStyle = `rgba(${v},${v - 12},${v - 42},${0.10 + Math.random() * 0.28})`;
    const s = 0.5 + Math.random() * 1.8;
    g.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  // 潮线：几道很淡的弧
  for (let i = 0; i < 4; i += 1) {
    g.strokeStyle = 'rgba(120,104,74,.18)';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= 256; x += 8) {
      const y = 60 + i * 46 + Math.sin(x * 0.045 + i) * 7;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

function waterTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, '#2d7f95');
  grad.addColorStop(0.5, '#4ba3b2');
  grad.addColorStop(1, '#236f86');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i += 1) {
    const y = Math.random() * 256;
    g.strokeStyle = `rgba(225,250,245,${0.035 + Math.random() * 0.10})`;
    g.lineWidth = 0.8 + Math.random() * 1.8;
    g.beginPath();
    for (let x = 0; x <= 256; x += 10) {
      const yy = y + Math.sin(x * 0.055 + i) * 2.2;
      if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

/**
 * 水面波纹法线贴图：正弦波叠加生成 (dx,dy,1) 法线，让平静湖面有粼粼反光。
 * 与 waterTex 同 repeat，update 中同步 offset 滚动 → 流动反光。零增面。
 */
function waterNormalTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  // 高度场：多组不同方向的细波叠加
  const height = (x, y) => {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    return Math.sin(u * 6 + v * 2) * 0.5
      + Math.sin(u * 3 - v * 7) * 0.3
      + Math.sin(u * 11 + v * 9) * 0.2;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      const nx = -dx * 0.32, ny = -dy * 0.32, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const idx = (y * size + x) * 4;
      img.data[idx] = (nx * inv * 0.5 + 0.5) * 255;
      img.data[idx + 1] = (ny * inv * 0.5 + 0.5) * 255;
      img.data[idx + 2] = (nz * inv * 0.5 + 0.5) * 255;
      img.data[idx + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t; // 法线数据线性空间，不设 sRGB
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,40,44,.88)';
  g.fillRect(0, 0, 640, 160);
  g.strokeStyle = '#72d7c2'; g.lineWidth = 5; g.strokeRect(4, 4, 632, 152);
  g.fillStyle = '#e8fff9'; g.font = 'bold 58px "Microsoft YaHei",sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('翡翠湖 · 城市沙滩', 320, 64);
  g.fillStyle = 'rgba(195,245,235,.75)'; g.font = '25px "Microsoft YaHei",sans-serif';
  g.fillText('EMERALD BAY  ·  LAKESIDE PARK', 320, 116);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function boatGeometry() {
  const parts = [];
  const hull = new THREE.CylinderGeometry(0.9, 0.55, 2.5, 7, 1, false, 0, Math.PI);
  hull.rotateZ(Math.PI / 2);
  hull.rotateY(Math.PI / 2);
  hull.scale(0.55, 0.55, 1);
  hull.translate(0, 0.35, 0);
  parts.push(hull);
  const deck = new THREE.BoxGeometry(1.5, 0.10, 2.0);
  deck.translate(0, 0.42, 0);
  parts.push(deck);
  const seat = new THREE.BoxGeometry(1.5, 0.42, 0.36);
  seat.translate(0, 0.62, -0.25);
  parts.push(seat);
  const canopy = new THREE.ConeGeometry(1.15, 0.45, 6);
  canopy.scale(1, 0.7, 1);
  canopy.translate(0, 1.45, 0.05);
  parts.push(canopy);
  for (const sx of [-0.62, 0.62]) {
    const post = new THREE.CylinderGeometry(0.035, 0.035, 1.0, 5);
    post.translate(sx, 1.0, 0.05);
    parts.push(post);
  }
  const g = parts.reduce((acc, p) => {
    p.setAttribute('color', new THREE.Float32BufferAttribute(
      new Array(p.attributes.position.count * 3).fill(0).map((_, i) => {
        const c = new THREE.Color(i % 11 === 0 ? 0xf1e7d5 : 0x3f8c9b);
        return [c.r, c.g, c.b][i % 3];
      }), 3,
    ));
    return acc;
  }, null);
  void g;
  return parts;
}

function mergeParts(parts) {
  // 局部合并，避免运行时再依赖 addons 的命名差异；按属性统一为非索引。
  let total = 0;
  const normalized = parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p;
    total += q.attributes.position.count;
    return q;
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let off = 0;
  for (const p of normalized) {
    const n = p.attributes.position.count;
    pos.set(p.attributes.position.array, off * 3);
    if (p.attributes.normal) nor.set(p.attributes.normal.array, off * 3);
    if (p.attributes.color) col.set(p.attributes.color.array, off * 3);
    else col.fill(1, off * 3, (off + n) * 3);
    off += n;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function duckGeometry() {
  const parts = [];
  const body = new THREE.SphereGeometry(0.32, 7, 5);
  body.scale(1.1, 0.72, 1.45);
  body.translate(0, 0.2, 0);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.17, 7, 5);
  head.translate(0, 0.52, 0.34);
  parts.push(head);
  const beak = new THREE.ConeGeometry(0.08, 0.22, 5);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.50, 0.55);
  parts.push(beak);
  for (const p of parts) {
    p.setAttribute('color', new THREE.Float32BufferAttribute(
      new Array(p.attributes.position.count * 3).fill(1), 3,
    ));
  }
  return mergeParts(parts);
}

export function buildCityLake({ group, owned }) {
  const g = new THREE.Group();
  g.name = 'City/lake-district';
  group.add(g);

  const sandTex = sandTexture();
  const waterTex = waterTexture();
  /* 【风景提质】湖面加波纹法线贴图，反光随 UV 滚动流动，零增面 */
  const waterNormal = waterNormalTexture();
  owned.textures.push(sandTex, waterTex, waterNormal);

  // 沙滩从湿沙、干沙到草地，三层收边，避免水里直接切到柏油。
  const wetGeo = shapePlane(CITY_LAKE.w + 3.2, CITY_LAKE.d + 3.2, 8);
  const wetMat = new THREE.MeshStandardMaterial({ color: 0xb9a476, roughness: 1 });
  const wet = new THREE.Mesh(wetGeo, wetMat);
  wet.position.set(CITY_LAKE.x, Y + 0.025, CITY_LAKE.z);
  g.add(wet);

  const sandGeo = shapePlane(CITY_LAKE.beachW, CITY_LAKE.beachD, 13);
  const sandMat = new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 });
  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.position.set(CITY_LAKE.x, Y + 0.04, CITY_LAKE.z);
  g.add(sand);

  const waterGeo = shapePlane(CITY_LAKE.w, CITY_LAKE.d, 7);
  const waterMat = new THREE.MeshStandardMaterial({
    map: waterTex, color: 0xb8fff4, roughness: 0.16, metalness: 0.08,
    normalMap: waterNormal, normalScale: new THREE.Vector2(0.45, 0.45),
    transparent: true, opacity: 0.94, depthWrite: true,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(CITY_LAKE.x, CITY_LAKE.waterY, CITY_LAKE.z);
  g.add(water);

  // 浅水泡沫：比水面略大的一圈，半透明白边。
  const foamGeo = shapePlane(CITY_LAKE.w + 1.5, CITY_LAKE.d + 1.5, 8);
  const foamMat = new THREE.MeshBasicMaterial({
    color: 0xeafff8, transparent: true, opacity: 0.34, depthWrite: false,
  });
  const foam = new THREE.Mesh(foamGeo, foamMat);
  foam.position.set(CITY_LAKE.x, CITY_LAKE.waterY - 0.004, CITY_LAKE.z);
  g.add(foam);

  owned.geometries.push(wetGeo, sandGeo, waterGeo, foamGeo);
  owned.materials.push(wetMat, sandMat, waterMat, foamMat);

  // 木栈道 + 救生台：低模、合并，给沙滩一个可停留的边界。
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b6a44, roughness: 0.92 });
  const woodGeo = new THREE.BoxGeometry(1, 1, 1);
  owned.materials.push(woodMat);
  const boards = [];
  const addBoard = (x, z, w, d, y = Y + 0.08) => {
    const m = new THREE.Mesh(woodGeo, woodMat);
    m.position.set(x, y, z);
    m.scale.set(w, 0.12, d);
    g.add(m);
    boards.push(m);
  };
  // 不做“围一圈木栈道”的泳池感：北岸一条滨湖步道 + 两条伸进湖面的木码头。
  addBoard(CITY_LAKE.x, CITY_LAKE.z + 25.2, 56, 2.2);
  addBoard(CITY_LAKE.x - 33.5, CITY_LAKE.z - 3, 8.5, 2.4, Y + 0.14);
  addBoard(CITY_LAKE.x + 2.5, CITY_LAKE.z + 20.5, 2.4, 8.5, Y + 0.14);
  owned.geometries.push(woodGeo);

  // 棕榈：树干一个 InstancedMesh、叶冠一个 InstancedMesh。
  // 棕榈全部落在水面外的沙地边缘，避免“树从湖里长出来”。
  const palm = [
    [-42, 218], [11, 219], [-30, 248.5], [-8, 248.5], [8, 248.0], [-41, 238],
  ].map(([x, z], i) => ({ x, z, s: 0.86 + (i % 3) * 0.08, yaw: i * 1.31 }));
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 4.2, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x856746, roughness: 1 });
  const crownGeo = new THREE.ConeGeometry(2.0, 0.75, 7);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x3f8c4e, roughness: 0.9 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, palm.length);
  const crownMesh = new THREE.InstancedMesh(crownGeo, crownMat, palm.length);
  trunkMesh.name = 'City/lake-palm-trunks';
  crownMesh.name = 'City/lake-palm-crowns';
  const d = new THREE.Object3D();
  palm.forEach((p, i) => {
    d.position.set(p.x, Y + 2.1 * p.s, p.z);
    d.rotation.set(0, p.yaw, 0.035);
    d.scale.set(p.s, p.s, p.s);
    d.updateMatrix();
    trunkMesh.setMatrixAt(i, d.matrix);
    d.position.y = Y + 4.35 * p.s;
    d.rotation.set(0, p.yaw, 0);
    d.scale.set(1.35 * p.s, 1, 1.35 * p.s);
    d.updateMatrix();
    crownMesh.setMatrixAt(i, d.matrix);
  });
  g.add(trunkMesh, crownMesh);
  owned.geometries.push(trunkGeo, crownGeo);
  owned.materials.push(trunkMat, crownMat);

  // 沙滩伞
  // 阳伞也只在沙滩上：南岸 3 把、北岸 3 把，全部离开水线。
  const umbrellas = [
    [-31, 200.0, 0xe85d4a], [-16, 199.6, 0x3f9b86], [5, 200.0, 0xe9b44b],
    [-33, 248.0, 0x5b7fc4], [-15, 248.2, 0xe85d4a], [6, 248.0, 0x3f9b86],
  ].map(([x, z, color]) => ({ x, z, color }));
  const poleGeo = new THREE.CylinderGeometry(0.035, 0.045, 2.4, 5);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8d1bf, roughness: 0.7 });
  const shadeGeo = new THREE.ConeGeometry(1.45, 0.55, 8);
  const shadeMat = new THREE.MeshStandardMaterial({
    vertexColors: false, roughness: 0.8, side: THREE.DoubleSide,
  });
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, umbrellas.length);
  const shadeMesh = new THREE.InstancedMesh(shadeGeo, shadeMat, umbrellas.length);
  poleMesh.name = 'City/lake-umbrella-poles';
  shadeMesh.name = 'City/lake-umbrellas';
  umbrellas.forEach((u, i) => {
    d.position.set(u.x, Y + 1.2, u.z);
    d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix();
    poleMesh.setMatrixAt(i, d.matrix);
    d.position.y = Y + 2.35;
    d.rotation.set(0, i * 0.8, 0);
    d.updateMatrix();
    shadeMesh.setMatrixAt(i, d.matrix);
    shadeMesh.setColorAt(i, new THREE.Color(u.color));
  });
  if (shadeMesh.instanceColor) shadeMesh.instanceColor.needsUpdate = true;
  g.add(poleMesh, shadeMesh);
  owned.geometries.push(poleGeo, shadeGeo);
  owned.materials.push(poleMat, shadeMat);

  // 脚踏船：3 条，沿水面缓慢漂，不使用物理刚体。
  const boatParts = boatGeometry();
  const boatGeo = mergeParts(boatParts);
  const boatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.06 });
  const boats = [];
  for (let i = 0; i < 3; i += 1) {
    const m = new THREE.Mesh(boatGeo, boatMat);
    m.name = `City/lake-boat-${i}`;
    m.scale.setScalar(0.9);
    g.add(m);
    boats.push({ mesh: m, phase: i * 2.1, x: CITY_LAKE.x - 9 + i * 9, z: CITY_LAKE.z + 3 + (i % 2) * 7 });
  }
  owned.geometries.push(boatGeo);
  owned.materials.push(boatMat);

  // 水鸭：低模合并后 InstancedMesh，一只一个 draw。
  const duckGeo = duckGeometry();
  const duckMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 });
  const duckMesh = new THREE.InstancedMesh(duckGeo, duckMat, 6);
  duckMesh.name = 'City/lake-ducks';
  for (let i = 0; i < 6; i += 1) {
    duckMesh.setColorAt(i, new THREE.Color(i % 2 ? 0xf3f0df : 0x8b6b43));
  }
  if (duckMesh.instanceColor) duckMesh.instanceColor.needsUpdate = true;
  g.add(duckMesh);
  owned.geometries.push(duckGeo);
  owned.materials.push(duckMat);

  const signTex = signTexture();
  const signGeo = new THREE.PlaneGeometry(7.2, 1.8);
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, transparent: true, side: THREE.DoubleSide });
  const sign = new THREE.Mesh(signGeo, signMat);
  sign.name = 'City/lake-sign';
  // 正面朝南（+Z），从城市主路和沙滩入口都能读到正字。
  sign.position.set(CITY_LAKE.x - 18, Y + 2.1, CITY_LAKE.z - 25.5);
  g.add(sign);
  owned.geometries.push(signGeo);
  owned.materials.push(signMat);
  owned.textures.push(signTex);

  let time = 0;
  return {
    stats: { waterW: CITY_LAKE.w, waterD: CITY_LAKE.d, palms: palm.length, boats: boats.length, ducks: 6 },
    update(dt) {
      time += dt;
      waterTex.offset.x = (time * 0.012) % 1;
      waterTex.offset.y = (time * 0.006) % 1;
      // 法线贴图同步滚动 → 反光与波纹同向流动
      waterNormal.offset.x = waterTex.offset.x;
      waterNormal.offset.y = waterTex.offset.y;
      foamMat.opacity = 0.25 + Math.sin(time * 0.9) * 0.08;
      boats.forEach((b) => {
        b.mesh.position.set(
          b.x + Math.sin(time * 0.22 + b.phase) * 2.2,
          Y + 0.26 + Math.sin(time * 1.1 + b.phase) * 0.035,
          b.z + Math.cos(time * 0.18 + b.phase) * 1.4,
        );
        b.mesh.rotation.set(Math.sin(time * 1.3 + b.phase) * 0.018, b.phase + Math.sin(time * 0.2) * 0.2, Math.sin(time * 1.1) * 0.025);
      });
      for (let i = 0; i < 6; i += 1) {
        const a = time * (0.10 + i * 0.008) + i * 1.17;
        d.position.set(
          CITY_LAKE.x + Math.sin(a * 1.7) * (CITY_LAKE.w * 0.25) + (i - 2.5) * 2.2,
          CITY_LAKE.waterY + 0.02,
          CITY_LAKE.z + Math.cos(a * 1.1) * (CITY_LAKE.d * 0.26) + (i % 3 - 1) * 3.4,
        );
        d.rotation.set(0, a * 1.7 + 1.2, 0);
        d.scale.set(0.8, 0.8, 0.8);
        d.updateMatrix();
        duckMesh.setMatrixAt(i, d.matrix);
      }
      duckMesh.instanceMatrix.needsUpdate = true;
    },
    setNight(f) {
      waterMat.color.setRGB(0.72 - f * 0.45, 1.0 - f * 0.55, 0.96 - f * 0.50);
      waterMat.emissive?.setHex?.(f > 0.4 ? 0x0a2a33 : 0x000000);
      foamMat.color.setHex(f > 0.5 ? 0x9fc7c4 : 0xeafff8);
    },
  };
}
