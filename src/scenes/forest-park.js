/**
 * ============================================================================
 * ForestPark.js —— 阶段二「生态扩张」：都会区旁的森林公园
 * ============================================================================
 * 位置：都会区西南侧、城堡西侧空地，x∈[-104,-38] / z∈[44,92]。
 * 内容：草坪、纵向波纹河、石拱桥、步道、路灯长椅、130+ 棵实例化树木、
 *       4 名散步市民（其中 2 人遛狗）。
 *
 * 性能：
 *  - 静态铺装/拱桥各合并为 1 个 Mesh；树干、阔叶冠、针叶冠、灌木、花丛、
 *    长椅、狗身/狗腿全部为 InstancedMesh。
 *  - update 只写已有 instanceMatrix / shader uniform，热路径零 new。
 *  - 所有几何、材质、纹理登记到自有台账，dispose 成对释放。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildNPCCharacter, NPC_SCALE } from '../utils/helpers/procedural-character.js';

export const FOREST_PARK = Object.freeze({
  minX: -104,
  maxX: -38,
  minZ: 44,
  maxZ: 92,
  cx: -71,
  cz: 68,
  riverX: -64,
  riverWidth: 9,
  bridgeZ: 68,
  treeCount: 132,
  walkers: 4,
  dogs: 2,
});

export const FOREST_VIEW = Object.freeze({
  cam: [-20, 22, 104],
  tgt: [-66, 5, 66],
});

const BASE_Y = 1.14;
const Y = BASE_Y + 0.02;
const RIVER_DEPTH = 54;
const RIVER_SEGS = 96;
/** 蜿蜒中心线：在桥心 z=0 处为 0，桥仍然正对河道。 */
const riverMeander = (z) => 5.0 * Math.sin(z * 0.11) + 2.4 * Math.sin(z * 0.23);
/** 北段展开成一个小湖湾，南段收窄成溪流；桥附近保持可跨宽度。 */
const riverWidthAt = (z) => 9.0 * (1 + 0.52 * Math.exp(-(((z - 16) / 10) ** 2)));

function riverRibbon(extra, y) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= RIVER_SEGS; i += 1) {
    const t = i / RIVER_SEGS;
    const z = -RIVER_DEPTH / 2 + t * RIVER_DEPTH;
    const cx = riverMeander(z);
    const hw = riverWidthAt(z) / 2 + extra;
    positions.push(cx - hw, y, z, cx + hw, y, z);
    uvs.push(0, t, 1, t);
    if (i < RIVER_SEGS) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

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

function mergeParts(parts, label) {
  // Ico 为非索引、Box/Cylinder 为索引几何：统一转非索引后再合并，避免
  // mergeGeometries 因 index 属性不一致而整体失败。
  const normalized = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(normalized, false);
  if (!g) throw new Error(`[ForestPark] ${label} mergeGeometries 失败`);
  g.computeBoundingSphere();
  parts.forEach((p) => p.dispose());
  normalized.forEach((p) => { if (!parts.includes(p)) p.dispose(); });
  return g;
}

function makeGrassTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#4d8238';
  g.fillRect(0, 0, size, size);
  const rnd = makeRng(20261116);
  for (let i = 0; i < 26; i += 1) {
    g.globalAlpha = 0.08 + rnd() * 0.12;
    g.fillStyle = i % 2 ? '#7db34c' : '#2f5e24';
    g.beginPath();
    g.arc(rnd() * size, rnd() * size, 10 + rnd() * 34, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 0.5;
  for (let i = 0; i < 3000; i += 1) {
    g.strokeStyle = rnd() < 0.35 ? '#87b958' : '#365f28';
    g.lineWidth = 0.7;
    const x = rnd() * size, y = rnd() * size;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 2, y - 2 - rnd() * 4); g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 7);
  tex.anisotropy = 4;
  tex.name = 'ForestPark/grass';
  return tex;
}

function makeSignTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8,26,18,0.95)';
  g.beginPath();
  if (g.roundRect) g.roundRect(7, 7, 498, 178, 24); else g.rect(7, 7, 498, 178);
  g.fill();
  g.strokeStyle = '#9fd86a'; g.lineWidth = 8; g.stroke();
  g.fillStyle = '#9fd86a'; g.fillRect(26, 30, 10, 132);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#f4ffe8';
  g.font = 'bold 72px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.fillText('森林公园', 278, 76);
  g.fillStyle = '#9fd86a';
  g.font = 'bold 30px "Segoe UI", Arial, sans-serif';
  g.fillText('FOREST PARK', 278, 140);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.name = 'ForestPark/sign';
  return tex;
}

/* -------------------------------------------------------------------------- */
/* 主体                                                                        */
/* -------------------------------------------------------------------------- */

export class ForestPark {
  constructor({ root }) {
    this.root = root;
    this.group = null;
    this.ready = false;
    this.time = 0;
    this.owned = { geometries: [], materials: [], textures: [] };
    this._instanced = [];
    this._walkers = [];
    this._dogs = [];
    this._dummy = new THREE.Object3D();
    this._matrix = new THREE.Matrix4();
    this._bodyM = new THREE.Matrix4();
    this._legM = new THREE.Matrix4();
    this._color = new THREE.Color();
    this._build();
  }

  _trackGeo(g) { this.owned.geometries.push(g); return g; }
  _trackMat(m) { this.owned.materials.push(m); return m; }
  _trackTex(t) { this.owned.textures.push(t); return t; }

  _addIM(name, geo, mat, count, dynamic = false) {
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.name = name;
    im.instanceMatrix.setUsage(dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
    im.frustumCulled = false;
    this._instanced.push(im);
    this.group.add(im);
    return im;
  }

  _build() {
    const g = new THREE.Group();
    g.name = 'Lobby/forest-park';
    g.userData.forestPark = FOREST_PARK;
    this.group = g;
    this.root.add(g);

    const B = FOREST_PARK;
    const w = B.maxX - B.minX;
    const d = B.maxZ - B.minZ;

    // ---- 草坪 ----
    const grassTex = this._trackTex(makeGrassTexture());
    const lawnGeo = this._trackGeo(new THREE.PlaneGeometry(w, d, 1, 1));
    const lawnMat = this._trackMat(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: grassTex, roughness: 0.98, metalness: 0,
      envMapIntensity: 0.1,
    }));
    const lawn = new THREE.Mesh(lawnGeo, lawnMat);
    lawn.name = 'ForestPark/lawn';
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(B.cx, BASE_Y, B.cz);
    lawn.receiveShadow = true;
    g.add(lawn);

    // ---- 河：自定义顶点波纹 + 片元水纹，单 draw ----
    // 旧版是 9m 宽直河；这里改成会摆动的河心线，并在北段展开成湖湾。
    // 仍然只有一条 ribbon，1 个 draw，桥心 z=0 的偏移为 0，拱桥不用重算。
    const riverGeo = this._trackGeo(riverRibbon(0, 0));
    this._riverUniform = { value: 0 };
    const riverMat = this._trackMat(new THREE.ShaderMaterial({
      uniforms: { uTime: this._riverUniform },
      transparent: false,
      depthWrite: true,
      side: THREE.DoubleSide,
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          vec3 p = position;
          float w1 = sin(p.z * 1.35 + uTime * 1.55) * 0.055;
          float w2 = sin(p.z * 2.8 - uTime * 2.2 + p.x * 1.6) * 0.025;
          p.y += w1 + w2;
          vWave = w1 + w2;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          float r1 = sin(vUv.y * 86.0 - uTime * 2.8 + sin(vUv.x * 7.0 + uTime * 0.4) * 1.8);
          float r2 = sin(vUv.y * 33.0 + uTime * 1.4 + vUv.x * 12.0);
          float ripple = r1 * 0.55 + r2 * 0.45;
          float band = smoothstep(0.62, 0.98, ripple);
          vec3 deep = vec3(0.075, 0.245, 0.31);
          vec3 light = vec3(0.22, 0.55, 0.60);
          vec3 col = mix(deep, light, 0.28 + 0.20 * ripple + vWave * 1.2);
          col += band * vec3(0.22, 0.30, 0.31);
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
    const river = new THREE.Mesh(riverGeo, riverMat);
    river.name = 'ForestPark/river';
    river.position.set(B.riverX, BASE_Y + 0.16, B.cz);
    g.add(river);

    // 河岸湿沙/卵石带也跟着河心线走，避免水已经拐弯、岸还是直的。
    const bankGeo = this._trackGeo(riverRibbon(1.35, BASE_Y + 0.03));
    const bankMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x8b7d5f, roughness: 1 }));
    const bank = new THREE.Mesh(bankGeo, bankMat);
    bank.name = 'ForestPark/riverbank';
    bank.position.set(B.riverX, 0, B.cz);
    g.add(bank);

    // ---- 河岸 / 步道 / 桥体：合并材质（顶点色）----
    const baseBox = new THREE.BoxGeometry(1, 1, 1);
    const part = (hex, x, y, z, sx, sy, sz, rz = 0) => {
      const q = baseBox.clone();
      q.scale(sx, sy, sz);
      if (rz) q.rotateZ(rz);
      q.translate(x, y, z);
      paint(q, hex);
      return q;
    };

    const landParts = [];
    // 东西步道（桥两侧）
    landParts.push(part(0xa89a78, -78.2, BASE_Y + 0.09, B.bridgeZ, 19.6, 0.12, 3.2));
    landParts.push(part(0xa89a78, -49.8, BASE_Y + 0.09, B.bridgeZ, 19.6, 0.12, 3.2));
    // 东西两岸纵向步道
    landParts.push(part(0x9d906f, -51, BASE_Y + 0.085, 69, 3.2, 0.10, 40));
    landParts.push(part(0x9d906f, -88, BASE_Y + 0.085, 69, 3.0, 0.10, 40));
    // 入口小广场
    landParts.push(part(0xb0a07c, -44, BASE_Y + 0.10, 72, 8, 0.12, 10));
    const landGeo = this._trackGeo(mergeParts(landParts, 'land'));
    const landMat = this._trackMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0,
    }));
    const land = new THREE.Mesh(landGeo, landMat);
    land.name = 'ForestPark/paths';
    land.receiveShadow = true;
    g.add(land);

    // ---- 拱桥：弧形桥面 + 栏杆 + 桥台，合并 1 个 Mesh ----
    const bridgeParts = [];
    const span = 14;
    const x0 = B.riverX - span / 2;
    const deckY = (t) => BASE_Y + 0.58 + Math.sin(Math.PI * t) * 0.72;
    const segs = 22;
    for (let i = 0; i < segs; i += 1) {
      const t = (i + 0.5) / segs;
      const x = x0 + t * span;
      const slope = Math.cos(Math.PI * t) * Math.PI * 0.72 / span;
      bridgeParts.push(part(0xd8cbb0, x, deckY(t), B.bridgeZ, span / segs + 0.10, 0.18, 3.2, -Math.atan(slope)));
    }
    // 桥台
    bridgeParts.push(part(0x9b8f78, x0 - 0.6, BASE_Y + 0.42, B.bridgeZ, 1.2, 0.84, 4.0));
    bridgeParts.push(part(0x9b8f78, x0 + span + 0.6, BASE_Y + 0.42, B.bridgeZ, 1.2, 0.84, 4.0));
    // 栏杆：两侧立柱 + 扶手
    for (const side of [-1, 1]) {
      const zz = B.bridgeZ + side * 1.48;
      for (let i = 0; i <= segs; i += 2) {
        const t = i / segs;
        bridgeParts.push(part(0x8d7654, x0 + t * span, deckY(t) + 0.58, zz, 0.15, 1.15, 0.15));
      }
      for (let i = 0; i < segs; i += 2) {
        const t0 = i / segs, t1 = Math.min(1, (i + 2) / segs);
        const xa = x0 + t0 * span, xb = x0 + t1 * span;
        const y = (deckY(t0) + deckY(t1)) / 2 + 1.12;
        const len = Math.hypot(xb - xa, deckY(t1) - deckY(t0));
        const rz = -Math.atan2(deckY(t1) - deckY(t0), xb - xa);
        bridgeParts.push(part(0xa88d62, (xa + xb) / 2, y, zz, len, 0.12, 0.17, rz));
      }
    }
    const bridgeGeo = this._trackGeo(mergeParts(bridgeParts, 'bridge'));
    const bridgeMat = this._trackMat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0,
    }));
    const bridge = new THREE.Mesh(bridgeGeo, bridgeMat);
    bridge.name = 'ForestPark/arch-bridge';
    bridge.castShadow = false;
    g.add(bridge);

    // ---- 树木：全部 InstancedMesh（树干 / 阔叶冠 / 针叶冠 / 灌木）----
    const groundMinX = B.minX + 2.5, groundMaxX = B.maxX - 2.5;
    const groundMinZ = B.minZ + 2.5, groundMaxZ = B.maxZ - 2.5;
    const rnd = makeRng(20261116);
    const broad = [];
    const conifer = [];
    const shrubs = [];
    const blocked = (x, z) => {
      if (Math.abs(x - (B.riverX + riverMeander(z - B.cz))) < riverWidthAt(z - B.cz) / 2 + 2.0) return true;
      if (z > B.bridgeZ - 3.2 && z < B.bridgeZ + 3.2) return true;
      if (Math.abs(x + 51) < 2.6 && z > 47 && z < 91) return true;
      if (Math.abs(x + 88) < 2.5 && z > 47 && z < 91) return true;
      if (x > -49 && x < -38 && z > 67 && z < 78) return true; // 入口广场
      return false;
    };
    let guard = 0;
    while (broad.length + conifer.length < B.treeCount && guard < 3000) {
      guard += 1;
      const x = groundMinX + rnd() * (groundMaxX - groundMinX);
      const z = groundMinZ + rnd() * (groundMaxZ - groundMinZ);
      if (blocked(x, z)) continue;
      // 避免树木彼此过密
      let tooClose = false;
      for (const t of broad) if (Math.hypot(t.x - x, t.z - z) < 2.7) { tooClose = true; break; }
      if (!tooClose) for (const t of conifer) if (Math.hypot(t.x - x, t.z - z) < 2.7) { tooClose = true; break; }
      if (tooClose) continue;
      const item = { x, z, s: 0.85 + rnd() * 0.55, yaw: rnd() * Math.PI * 2, tone: rnd() };
      if (rnd() < 0.64) broad.push(item); else conifer.push(item);
    }
    for (let i = 0; i < 62; i += 1) {
      const x = groundMinX + rnd() * (groundMaxX - groundMinX);
      const z = groundMinZ + rnd() * (groundMaxZ - groundMinZ);
      if (blocked(x, z)) continue;
      shrubs.push({ x, z, s: 0.35 + rnd() * 0.5, tone: rnd() });
    }
    this.stats = { trees: broad.length + conifer.length, broad: broad.length, conifer: conifer.length, shrubs: shrubs.length };

    const trunkGeo = this._trackGeo(new THREE.CylinderGeometry(0.16, 0.24, 1, 6));
    const canopyGeo = this._trackGeo(new THREE.IcosahedronGeometry(1, 1));
    const coniferGeo = this._trackGeo(new THREE.ConeGeometry(1, 1, 7));
    const shrubGeo = this._trackGeo(new THREE.IcosahedronGeometry(1, 0));
    const trunkMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x765234, roughness: 0.96, metalness: 0 }));
    // 阔叶 / 针叶 / 灌木分材质，四季系统可分别控制；不新增 draw call（原本就是分 IM）。
    const leafMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }));
    const coniferMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0 }));
    const shrubMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0 }));
    this.seasonTargets = { lawn: lawnMat, broad: leafMat, conifer: coniferMat, shrub: shrubMat };

    const allTrees = broad.concat(conifer);
    const trunks = this._addIM('ForestPark/tree-trunks', trunkGeo, trunkMat, allTrees.length);
    const broadCrowns = this._addIM('ForestPark/tree-crowns-broad', canopyGeo, leafMat, broad.length);
    const coniferCrowns = this._addIM('ForestPark/tree-crowns-conifer', coniferGeo, coniferMat, conifer.length);
    const shrubIM = this._addIM('ForestPark/shrubs', shrubGeo, shrubMat, shrubs.length);
    const dm = this._dummy;
    for (let i = 0; i < allTrees.length; i += 1) {
      const t = allTrees[i];
      const h = (4.2 + t.s * 2.6) * 0.72;
      dm.position.set(t.x, BASE_Y + h / 2, t.z);
      dm.rotation.set(0, t.yaw, 0);
      dm.scale.set(t.s, h, t.s);
      dm.updateMatrix();
      trunks.setMatrixAt(i, dm.matrix);
      this._color.setHSL(0.27 + t.tone * 0.045, 0.42, 0.22 + t.tone * 0.09);
      trunks.setColorAt(i, this._color);
    }
    for (let i = 0; i < broad.length; i += 1) {
      const t = broad[i];
      const h = 3.0 + t.s * 1.9;
      dm.position.set(t.x, BASE_Y + h * 0.62 + 1.6 * t.s, t.z);
      dm.rotation.set(0, t.yaw, 0);
      dm.scale.set(1.6 * t.s, 1.25 * t.s, 1.6 * t.s);
      dm.updateMatrix();
      broadCrowns.setMatrixAt(i, dm.matrix);
      this._color.setHSL(0.27 + t.tone * 0.05, 0.48, 0.28 + t.tone * 0.10);
      broadCrowns.setColorAt(i, this._color);
    }
    for (let i = 0; i < conifer.length; i += 1) {
      const t = conifer[i];
      const h = 4.5 + t.s * 2.2;
      dm.position.set(t.x, BASE_Y + h * 0.50 + 1.2 * t.s, t.z);
      dm.rotation.set(0, t.yaw, 0);
      dm.scale.set(1.25 * t.s, h, 1.25 * t.s);
      dm.updateMatrix();
      coniferCrowns.setMatrixAt(i, dm.matrix);
      this._color.setHSL(0.31 + t.tone * 0.04, 0.48, 0.20 + t.tone * 0.08);
      coniferCrowns.setColorAt(i, this._color);
    }
    for (let i = 0; i < shrubs.length; i += 1) {
      const t = shrubs[i];
      dm.position.set(t.x, BASE_Y + 0.32 * t.s, t.z);
      dm.rotation.set(0, t.tone * 6.28, 0);
      dm.scale.set(t.s, t.s * 0.7, t.s);
      dm.updateMatrix();
      shrubIM.setMatrixAt(i, dm.matrix);
      this._color.setHSL(0.26 + t.tone * 0.07, 0.46, 0.24 + t.tone * 0.10);
      shrubIM.setColorAt(i, this._color);
    }
    for (const im of [trunks, broadCrowns, coniferCrowns, shrubIM]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
    }

    // ---- 长椅（合并几何 + 1 个 InstancedMesh）----
    const benchParts = [];
    benchParts.push(part(0x8c643e, 0, 0.45, 0, 1.8, 0.12, 0.55));
    benchParts.push(part(0x744d2f, 0, 0.78, -0.23, 1.8, 0.55, 0.10));
    benchParts.push(part(0x5a4533, -0.72, 0.22, 0, 0.12, 0.44, 0.48));
    benchParts.push(part(0x5a4533, 0.72, 0.22, 0, 0.12, 0.44, 0.48));
    const benchGeo = this._trackGeo(mergeParts(benchParts, 'bench'));
    const benchMat = this._trackMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
    const benchIM = this._addIM('ForestPark/benches', benchGeo, benchMat, 6);
    const benches = [
      [-51, 58, -Math.PI / 2], [-51, 79, -Math.PI / 2], [-88, 58, Math.PI / 2],
      [-88, 79, Math.PI / 2], [-47, 71, -Math.PI / 2], [-73, 62, 0],
    ];
    for (let i = 0; i < benches.length; i += 1) {
      const b = benches[i];
      dm.position.set(b[0], BASE_Y + 0.02, b[1]);
      dm.rotation.set(0, b[2], 0);
      dm.scale.set(1, 1, 1);
      dm.updateMatrix();
      benchIM.setMatrixAt(i, dm.matrix);
    }
    benchIM.instanceMatrix.needsUpdate = true;
    benchIM.computeBoundingSphere();

    // ---- 入口牌 ----
    const signTex = this._trackTex(makeSignTexture());
    const signMat = this._trackMat(new THREE.MeshBasicMaterial({
      map: signTex, transparent: true, alphaTest: 0.06, side: THREE.DoubleSide,
      toneMapped: false, fog: false,
    }));
    const signBoardMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x173027, roughness: 0.8, metalness: 0.1 }));
    const signPostMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x5c4630, roughness: 0.9, metalness: 0 }));
    const signGeo = this._trackGeo(new THREE.BoxGeometry(0.24, 2.6, 7.2));
    const postGeo = this._trackGeo(new THREE.BoxGeometry(0.30, 2.8, 0.30));
    const sign = new THREE.Mesh(signGeo, signBoardMat);
    sign.name = 'ForestPark/sign-board';
    sign.position.set(B.maxX - 0.35, BASE_Y + 3.2, 59);
    g.add(sign);
    for (const dz of [-2.7, 2.7]) {
      const p = new THREE.Mesh(postGeo, signPostMat);
      p.name = 'ForestPark/sign-post';
      p.position.set(B.maxX - 0.30, BASE_Y + 1.35, 59 + dz);
      g.add(p);
    }
    const signFaceGeo = this._trackGeo(new THREE.PlaneGeometry(6.8, 2.15));
    const signFace = new THREE.Mesh(signFaceGeo, signMat);
    signFace.name = 'ForestPark/sign-face';
    signFace.position.set(B.maxX - 0.21, BASE_Y + 3.2, 59);
    signFace.rotation.y = Math.PI / 2;
    g.add(signFace);

    // ---- 市民 + 狗 ----
    this._buildWalkers();
    this.ready = true;
    console.info(`[ForestPark] 草坪=${w}×${d} 树=${this.stats.trees}（阔叶${this.stats.broad}/针叶${this.stats.conifer}）` +
      ` 灌木=${this.stats.shrubs} 市民=${B.walkers} 狗=${B.dogs} | draw≈${this.group.children.length + 1}`);
  }

  _buildWalkers() {
    const char = buildNPCCharacter({ count: FOREST_PARK.walkers });
    this._trackGeo(char.geometry);
    this._trackMat(char.material);
    this._char = char;
    const mesh = this._addIM('ForestPark/citizens', char.geometry, char.material, FOREST_PARK.walkers, true);
    mesh.frustumCulled = false;
    this._npcMesh = mesh;
    const outfits = [
      { coat: 0x4f7fbe, pants: 0x2e3c58, skin: 0xf0c49a, hair: 0x3b2a22 },
      { coat: 0xd88f4f, pants: 0x4a4238, skin: 0xe5b083, hair: 0x1f1b18 },
      { coat: 0x79a86b, pants: 0x394a36, skin: 0xeac09b, hair: 0x5a3b27 },
      { coat: 0xa86d8b, pants: 0x3e3348, skin: 0xdca77d, hair: 0x2a1c16 },
    ];
    for (let i = 0; i < FOREST_PARK.walkers; i += 1) {
      char.setOutfit(i, outfits[i % outfits.length]);
    }
    char.flushPalette();
    this._npcAnim = char.attributes.aAnim;

    const routes = [
      // 东岸林间环线
      [[-51, 1.16, 48], [-51, 1.16, 88], [-55, 1.16, 90], [-55, 1.16, 48]],
      // 过桥往返（只在拱桥上过河）
      [[-89, 1.16, 68], [-71, 1.80, 68], [-64, 2.38, 68], [-57, 1.80, 68], [-43, 1.16, 68]],
      // 西岸林间环线
      [[-88, 1.16, 48], [-88, 1.16, 88], [-83, 1.16, 88], [-83, 1.16, 48]],
      // 东侧内圈
      [[-47, 1.16, 50], [-47, 1.16, 82], [-54, 1.16, 88], [-57, 1.16, 60]],
    ];
    const speeds = [1.35, 1.0, 1.25, 1.15];
    for (let i = 0; i < FOREST_PARK.walkers; i += 1) {
      const pts = routes[i].map((p) => ({ x: p[0], y: p[1], z: p[2] }));
      const lens = [];
      let total = 0;
      for (let k = 0; k < pts.length; k += 1) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        lens.push(len);
        total += len;
      }
      this._walkers.push({
        idx: i, pts, lens, total, speed: speeds[i],
        dist: total * (i / FOREST_PARK.walkers), pingpong: i === 1, dir: 1,
        x: pts[0].x, y: pts[0].y, z: pts[0].z, yaw: 0,
        phase: i * 1.7, hasDog: i === 0 || i === 2,
      });
    }

    // 狗：身体合并 1 个 IM，四腿 1 个 IM（2 狗 × 4 腿）
    const dogBodyParts = [];
    dogBodyParts.push(partIco(0xb9793f, 0, 0.42, 0, 0.36, 0.28, 0.58));
    dogBodyParts.push(partIco(0xc88a4d, 0, 0.60, 0.46, 0.27, 0.25, 0.27));
    dogBodyParts.push(partIco(0x8f5b2c, -0.14, 0.76, 0.40, 0.09, 0.16, 0.07, -0.18));
    dogBodyParts.push(partIco(0x8f5b2c, 0.14, 0.76, 0.40, 0.09, 0.16, 0.07, 0.18));
    dogBodyParts.push(partBox(0xd9c1a0, 0, 0.52, 0.69, 0.20, 0.13, 0.18));
    dogBodyParts.push(partBox(0x8f5b2c, 0, 0.52, -0.58, 0.09, 0.09, 0.28));
    const dogGeo = this._trackGeo(mergeParts(dogBodyParts, 'dog-body'));
    const dogMat = this._trackMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }));
    this._dogMesh = this._addIM('ForestPark/dogs', dogGeo, dogMat, FOREST_PARK.dogs, true);
    this._dogMesh.frustumCulled = false;
    const legGeo = this._trackGeo(new THREE.BoxGeometry(1, 1, 1));
    const legMat = this._trackMat(new THREE.MeshStandardMaterial({ color: 0x83502b, roughness: 0.9, metalness: 0 }));
    this._dogLegs = this._addIM('ForestPark/dog-legs', legGeo, legMat, FOREST_PARK.dogs * 4, true);
    for (let i = 0; i < FOREST_PARK.dogs; i += 1) {
      this._dogs.push({ idx: i, owner: this._walkers[i * 2], phase: i * 2.1, x: 0, y: 0, z: 0, yaw: 0 });
    }
    for (const w of this._walkers) {
      if (!w.hasDog) continue;
      w.x = w.pts[0].x; w.y = w.pts[0].y; w.z = w.pts[0].z;
    }
  }

  _sampleRoute(w, dt) {
    const step = w.speed * dt;
    if (w.pingpong) {
      w.dist += step * w.dir;
      if (w.dist >= w.total) { w.dist = w.total; w.dir = -1; }
      if (w.dist <= 0) { w.dist = 0; w.dir = 1; }
    } else {
      w.dist = (w.dist + step) % w.total;
    }
    let d = w.dist;
    let k = 0;
    while (k < w.lens.length - 1 && d > w.lens[k]) { d -= w.lens[k]; k += 1; }
    const a = w.pts[k];
    const b = w.pts[(k + 1) % w.pts.length];
    const len = Math.max(1e-5, w.lens[k]);
    const f = Math.min(1, d / len);
    w.x = a.x + (b.x - a.x) * f;
    w.y = a.y + (b.y - a.y) * f;
    w.z = a.z + (b.z - a.z) * f;
    const dx = b.x - a.x, dz = b.z - a.z;
    if (dx * dx + dz * dz > 1e-6) w.yaw = Math.atan2(dx, dz);
  }

  update(t, dt = 0.016) {
    if (!this.ready) return;
    const step = Math.min(0.1, Math.max(0, dt));
    this.time = t;
    this._riverUniform.value = t;

    const dm = this._dummy;
    const anim = this._npcAnim.array;
    for (const w of this._walkers) {
      this._sampleRoute(w, step);
      const bob = Math.sin(t * 5.0 + w.phase) * 0.035;
      dm.position.set(w.x, w.y + bob, w.z);
      dm.rotation.set(0, w.yaw, 0);
      dm.scale.setScalar(NPC_SCALE);
      dm.updateMatrix();
      this._npcMesh.setMatrixAt(w.idx, dm.matrix);
      const o = w.idx * 4;
      anim[o] = t * 5.0 + w.phase; // 步态相位
      anim[o + 1] = 1.0;           // 步行权重
      anim[o + 2] = 0.0;           // 不挥手
      anim[o + 3] = Math.sin(t * 0.7 + w.phase) * 0.35; // 张望
    }
    this._npcMesh.instanceMatrix.needsUpdate = true;
    this._npcAnim.needsUpdate = true;
    if (this._char?.timeUniform) this._char.timeUniform.value = t;

    // 狗跟随主人，在本侧半步位置；四腿交替摆动
    for (const dog of this._dogs) {
      const o = dog.owner;
      const rx = Math.cos(o.yaw), rz = -Math.sin(o.yaw);
      dog.x = o.x + rx * -0.95 + Math.sin(o.yaw) * -0.25;
      dog.z = o.z + rz * -0.95 + Math.cos(o.yaw) * -0.25;
      dog.y = o.y;
      dog.yaw = o.yaw;
      const bob = Math.sin(t * 7 + dog.phase) * 0.025;
      dm.position.set(dog.x, dog.y + bob, dog.z);
      dm.rotation.set(0, dog.yaw, 0);
      dm.scale.setScalar(1.0);
      dm.updateMatrix();
      this._dogMesh.setMatrixAt(dog.idx, dm.matrix);
      for (let leg = 0; leg < 4; leg += 1) {
        const sx = leg % 2 ? 0.20 : -0.20;
        const sz = leg < 2 ? 0.38 : -0.36;
        const swing = Math.sin(t * 8.0 + dog.phase + (leg % 2 ? Math.PI : 0)) * 0.42;
        dm.position.set(dog.x + Math.cos(dog.yaw) * sx + Math.sin(dog.yaw) * sz,
          dog.y + 0.26 + bob, dog.z - Math.sin(dog.yaw) * sx + Math.cos(dog.yaw) * sz);
        dm.rotation.set(swing, dog.yaw, 0);
        dm.scale.set(0.11, 0.34, 0.11);
        dm.updateMatrix();
        this._dogLegs.setMatrixAt(dog.idx * 4 + leg, dm.matrix);
      }
    }
    this._dogMesh.instanceMatrix.needsUpdate = true;
    this._dogLegs.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (!this.group) return;
    for (const im of this._instanced) {
      try { im.dispose(); } catch { /* noop */ }
    }
    this._instanced.length = 0;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
    for (const g of this.owned.geometries) { try { g.dispose(); } catch { /* noop */ } }
    for (const m of this.owned.materials) { try { m.dispose(); } catch { /* noop */ } }
    for (const t of this.owned.textures) { try { t.dispose(); } catch { /* noop */ } }
    this.owned.geometries.length = 0;
    this.owned.materials.length = 0;
    this.owned.textures.length = 0;
    this._walkers.length = 0;
    this._dogs.length = 0;
    this._npcMesh = null;
    this._dogMesh = null;
    this._dogLegs = null;
    this._char = null;
    this.group = null;
    this.ready = false;
  }
}

/* 狗身体局部部件：世界局部坐标合并，实例矩阵再定位到公园 */
function partIco(hex, x, y, z, sx, sy, sz, rotZ = 0) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  g.scale(sx, sy, sz);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  return paint(g, hex);
}
function partBox(hex, x, y, z, sx, sy, sz) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return paint(g, hex);
}

export function buildForestPark(opts) {
  return new ForestPark(opts);
}
