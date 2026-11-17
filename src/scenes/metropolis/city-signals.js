/**
 * 都会区信号系统（第一阶段）：
 * 9 个十字路口 × 4 个方向 = 36 个 3D 灯头，带真实倒计时。
 * 灯杆 / 灯头 / 三色灯珠各 1 个 InstancedMesh；36 块倒计时牌共享
 * 一张 1024² 图集，只改 canvas 像素，不新增 texture，也不在 update 里 new。
 */
import * as THREE from 'three';
import { CITY_INTERSECTIONS } from './city-layout.js';

export const SIGNAL_TIMING = Object.freeze({
  nsGreen: 13,
  yellow: 2,
  allRed: 1,
  ewGreen: 17,
});
const CYCLE = SIGNAL_TIMING.nsGreen + SIGNAL_TIMING.yellow + SIGNAL_TIMING.allRed
  + SIGNAL_TIMING.ewGreen + SIGNAL_TIMING.yellow + SIGNAL_TIMING.allRed;

const NS_END = SIGNAL_TIMING.nsGreen;
const NS_YELLOW_END = NS_END + SIGNAL_TIMING.yellow;
const EW_START = NS_YELLOW_END + SIGNAL_TIMING.allRed;
const EW_END = EW_START + SIGNAL_TIMING.ewGreen;
const EW_YELLOW_END = EW_END + SIGNAL_TIMING.yellow;

const AXIS_LABEL = Object.freeze({ z: '南北', x: '东西' });

/** 每个路口一个固定相位差：不再让 9 个路口像同一块钟表同时变色。
 * 主干道 × 公园侧横街 (24,112) 的相位固定为 0，保持旧测试的可预测性。 */
function phaseOf(x, z) {
  const raw = (x - 24) * 0.31 + (z - 112) * 0.53;
  return ((raw % CYCLE) + CYCLE) % CYCLE;
}

function axisState(axis, t) {
  if (axis === 'z') {
    if (t < NS_END) return { color: 'green', remain: NS_END - t };
    if (t < NS_YELLOW_END) return { color: 'yellow', remain: NS_YELLOW_END - t };
    return { color: 'red', remain: CYCLE - t };
  }
  if (t < EW_START) return { color: 'red', remain: EW_START - t };
  if (t < EW_END) return { color: 'green', remain: EW_END - t };
  if (t < EW_YELLOW_END) return { color: 'yellow', remain: EW_YELLOW_END - t };
  return { color: 'red', remain: CYCLE - t + EW_START };
}

function countdownTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#050807';
  g.fillRect(0, 0, 1024, 1024);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { canvas: c, ctx: g, tex };
}

const COL = Object.freeze({
  green: '#63ff9d',
  yellow: '#ffd45a',
  red: '#ff6b5f',
  off: '#111715',
});

export class CitySignals {
  constructor({ group, owned }) {
    this.group = group;
    this.owned = owned;
    this.time = 0;
    this.intersections = CITY_INTERSECTIONS;
    this.heads = [];
    this.stats = { intersections: this.intersections.length, heads: 0, panels: 0 };
    this._dummy = new THREE.Object3D();
    this._lastKey = '';
    this._build();
  }

  _build() {
    const y = 1.16;
    // 每个路口四角：北向来车（远侧 NE）/ 南向来车（SW）/ 东向（SE）/ 西向（NW）
    for (const it of this.intersections) {
      const { x, z, halfX, halfZ } = it;
      this.heads.push(
        { x: x + halfX + 1.55, z: z + halfZ + 1.55, yaw: Math.PI, axis: 'z', dir: '+z', it },
        { x: x - halfX - 1.55, z: z - halfZ - 1.55, yaw: 0, axis: 'z', dir: '-z', it },
        { x: x + halfX + 1.55, z: z - halfZ - 1.55, yaw: -Math.PI / 2, axis: 'x', dir: '+x', it },
        { x: x - halfX - 1.55, z: z + halfZ + 1.55, yaw: Math.PI / 2, axis: 'x', dir: '-x', it },
      );
    }
    const n = this.heads.length;
    this.stats.heads = n;
    this.stats.panels = n;

    const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 4.55, 6);
    const headGeo = new THREE.BoxGeometry(0.72, 1.8, 0.38);
    const lampGeo = new THREE.SphereGeometry(0.125, 7, 5);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x354046, roughness: 0.7, metalness: 0.35 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x202a2d, roughness: 0.85 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.owned.geometries.push(poleGeo, headGeo, lampGeo);
    this.owned.materials.push(poleMat, headMat, lampMat);

    this.poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, n);
    this.headMesh = new THREE.InstancedMesh(headGeo, headMat, n);
    this.lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, n * 3);
    this.poleMesh.name = 'City/signal-pole';
    this.headMesh.name = 'City/signal-head';
    this.lampMesh.name = 'City/signal-lamps';
    for (const m of [this.poleMesh, this.headMesh, this.lampMesh]) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      this.group.add(m);
    }
    this.lampMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const panelPos = [];
    const panelUv = [];
    const panelIdx = [];
    const right = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const d = this._dummy;
    const half = 0.30;
    this.heads.forEach((h, i) => {
      const nx = Math.sin(h.yaw), nz = Math.cos(h.yaw);
      right.set(Math.cos(h.yaw), 0, -Math.sin(h.yaw));
      normal.set(nx, 0, nz);
      // 灯杆
      d.position.set(h.x, y + 2.27, h.z);
      d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix();
      this.poleMesh.setMatrixAt(i, d.matrix);
      // 灯头（正面朝向来车）
      d.position.set(h.x, y + 5.15, h.z);
      d.rotation.set(0, h.yaw, 0); d.scale.set(1, 1, 1); d.updateMatrix();
      this.headMesh.setMatrixAt(i, d.matrix);
      // 三色灯珠
      for (let k = 0; k < 3; k++) {
        const ly = y + 5.70 - k * 0.53;
        d.position.set(h.x + normal.x * 0.22, ly, h.z + normal.z * 0.22);
        d.rotation.set(0, h.yaw, 0); d.scale.set(1, 1, 1); d.updateMatrix();
        this.lampMesh.setMatrixAt(i * 3 + k, d.matrix);
        this.lampMesh.setColorAt(i * 3 + k, new THREE.Color(COL.off));
      }
      // 倒计时牌几何：世界坐标四角，UV 指向图集单元格
      const px = h.x + normal.x * 0.225;
      const pz = h.z + normal.z * 0.225;
      const py = y + 6.12;
      const verts = [
        [-half, -half], [half, -half], [half, half], [-half, half],
      ];
      const col = i % 6, row = Math.floor(i / 6);
      const u0 = col / 6, u1 = (col + 1) / 6;
      const v1 = 1 - row / 6, v0 = 1 - (row + 1) / 6;
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      const base = panelPos.length / 3;
      for (let q = 0; q < 4; q++) {
        const [sx, sy] = verts[q];
        panelPos.push(
          px + right.x * sx, py + sy, pz + right.z * sx,
        );
        panelUv.push(...uvs[q]);
      }
      panelIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    this.poleMesh.instanceMatrix.needsUpdate = true;
    this.headMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.instanceMatrix.needsUpdate = true;
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;

    const panelGeo = new THREE.BufferGeometry();
    panelGeo.setAttribute('position', new THREE.Float32BufferAttribute(panelPos, 3));
    panelGeo.setAttribute('uv', new THREE.Float32BufferAttribute(panelUv, 2));
    panelGeo.setIndex(panelIdx);
    this._atlas = countdownTexture();
    this.panelMat = new THREE.MeshBasicMaterial({
      map: this._atlas.tex, toneMapped: false, transparent: false,
    });
    this.panelMesh = new THREE.Mesh(panelGeo, this.panelMat);
    this.panelMesh.name = 'City/signal-countdown';
    this.panelMesh.frustumCulled = false;
    this.group.add(this.panelMesh);
    this.owned.geometries.push(panelGeo);
    this.owned.materials.push(this.panelMat);
    this.owned.textures.push(this._atlas.tex);

    this._apply(true);
  }

  /** 找到 (x,z) 所属路口；没有传入位置则使用全局时钟（保留旧 API）。 */
  _localTime(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return this.time % CYCLE;
    let best = null, bestD = Infinity;
    for (const it of this.intersections) {
      const dx = Math.abs(x - it.x), dz = Math.abs(z - it.z);
      const d = Math.max(dx - it.halfX, dz - it.halfZ);
      if (d < bestD) { bestD = d; best = it; }
    }
    if (!best || bestD > 26) return this.time % CYCLE;
    return (this.time + phaseOf(best.x, best.z)) % CYCLE;
  }

  getVehicleState(axis, x, z) {
    return axisState(axis, this._localTime(x, z)).color;
  }

  /** 行人要横穿某条车流轴；必须等该轴全红且剩余绿灯足够。 */
  canPedCross(axis, clearanceSeconds = 2, x, z) {
    const t = this._localTime(x, z);
    if (axis === 'z') {
      const safe = t >= EW_START && t < EW_END;
      return safe && (EW_END - t) >= clearanceSeconds;
    }
    const safe = t < NS_END;
    return safe && (NS_END - t) >= clearanceSeconds;
  }

  getSnapshot() {
    const t = this.time % CYCLE;
    return { t, cycle: CYCLE, z: axisState('z', t), x: axisState('x', t) };
  }

  _apply(force = false) {
    const t = this.time % CYCLE;
    const st = { z: axisState('z', t), x: axisState('x', t) };
    const key = `${Math.floor(t * 2)}|${st.z.color}|${st.x.color}`;
    if (!force && key === this._lastKey) return;
    this._lastKey = key;
    const colors = {
      red: new THREE.Color(0xff302b),
      yellow: new THREE.Color(0xffc32e),
      green: new THREE.Color(0x2dff85),
      off: new THREE.Color(COL.off),
    };
    this.heads.forEach((h, i) => {
      const s = axisState(h.axis, (t + phaseOf(h.it.x, h.it.z)) % CYCLE);
      const sec = Math.max(0, Math.ceil(s.remain));
      // 灯珠顺序从上到下：红 / 黄 / 绿
      const active = s.color === 'red' ? 0 : s.color === 'yellow' ? 1 : 2;
      for (let k = 0; k < 3; k++) {
        this.lampMesh.setColorAt(i * 3 + k, colors[k === active ? s.color : 'off']);
      }
      // 图集格子：每 1 秒最多重绘一次
      const col = i % 6, row = Math.floor(i / 6);
      const cx = col * 170 + 85, cy = row * 170 + 85;
      const g = this._atlas.ctx;
      g.fillStyle = '#050807';
      g.fillRect(col * 170 + 2, row * 170 + 2, 166, 166);
      g.strokeStyle = '#1a2522';
      g.lineWidth = 5;
      g.strokeRect(col * 170 + 7, row * 170 + 7, 156, 156);
      g.fillStyle = COL[s.color];
      g.font = 'bold 82px "Consolas", "Microsoft YaHei", monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(Math.min(99, sec)).padStart(2, '0'), cx, cy - 9);
      g.fillStyle = 'rgba(220,235,230,.55)';
      g.font = 'bold 23px "Microsoft YaHei", sans-serif';
      g.fillText(AXIS_LABEL[h.axis], cx, cy + 60);
    });
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
    this._atlas.tex.needsUpdate = true;
  }

  update(dt) {
    this.time += Math.min(Math.max(dt, 0), 0.1);
    this._apply();
  }
}
