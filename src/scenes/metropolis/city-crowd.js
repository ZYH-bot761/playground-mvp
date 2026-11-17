/**
 * 都会区行人（第二轮）：
 * - 18 名街区行人分布在中央/北/医院/东公寓/居民区五条人行道环线；
 * - 2 名医院访客 + 3 名每趟公交重新下客；
 * - 行人只走人行道，过机动车道必须等该路口倒计时绿灯，禁止斜穿；
 * - 医院访客在门诊入口与 sidewalk 之间进出；
 * - 行人之间做最小间距检查，避免互相穿透。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUS_STOP, HOSPITAL } from './city-layout.js';

/** 简单部件合并：腿 + 鞋只需一次合并，不引入额外 draw。 */
function mergeSimple(parts) {
  const normalized = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(normalized, false);
  parts.forEach((p) => p.dispose());
  normalized.forEach((p) => { if (!parts.includes(p)) p.dispose(); });
  return g;
}

function path(points, closed) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'catmullrom', 0.2,
  );
  const samples = curve.getSpacedPoints(160);
  return { samples, length: curve.getLength(), closed };
}

// 全城人行道环线：中央街区、北街区、医院西侧、东侧公寓、北侧居民区。
// 每条环线只在真正跨机动车道的那一段查询信号，不再让所有行人共用一条路径。
const WALK_NODES = Object.freeze([
  { x: 15.1, z: 119.75 }, { x: 15.1, z: 142.25 },
  { x: 32.9, z: 142.25 }, { x: 32.9, z: 119.75 },
]);
const NORTH_NODES = Object.freeze([
  { x: 15.1, z: 157.75 }, { x: 15.1, z: 182.25 },
  { x: 32.9, z: 182.25 }, { x: 32.9, z: 157.75 },
]);
const WEST_NODES = Object.freeze([
  { x: -90, z: 118.5 }, { x: -90, z: 145.5 },
  { x: -55, z: 145.5 }, { x: -55, z: 118.5 },
]);
const EAST_NODES = Object.freeze([
  { x: 75.6, z: 119 }, { x: 75.6, z: 141 },
  { x: 93.2, z: 141 }, { x: 93.2, z: 119 },
]);
// 北侧居民楼拆除后改为湖滨步道环线：绕湖一圈，不穿水、不压沙滩。
const RES_NODES = Object.freeze([
  { x: -44, z: 204 }, { x: 11, z: 204 },
  { x: 11, z: 248 }, { x: -44, z: 248 },
]);

function loopOf(nodes) {
  return Object.freeze(nodes.map((a, i) => {
    const b = nodes[(i + 1) % nodes.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minZ = Math.min(a.z, b.z), maxZ = Math.max(a.z, b.z);
    const crossesMain = minX < 32 && maxX > 16;
    const crossesCross = [112, 150, 194].some((z) => minZ < z + 6 && maxZ > z - 6);
    const crossing = crossesMain || crossesCross;
    return {
      ax: a.x, az: a.z, bx: b.x, bz: b.z, len,
      crossing, axis: crossesMain ? 'z' : (crossesCross ? 'x' : null),
      yaw: Math.atan2(b.x - a.x, b.z - a.z),
    };
  }));
}

const WALK_LOOPS = Object.freeze([
  loopOf(WALK_NODES), loopOf(NORTH_NODES), loopOf(WEST_NODES),
  loopOf(EAST_NODES), loopOf(RES_NODES),
]);
const WALK_SEGS = WALK_LOOPS[0];
const WALKER_COUNT = 18;
// 学校前场 / 商场入口 / 湖滨的停留人群：不再只有一条条环线，
// 大地方门口真的有人站着聊天、看手机、等同伴。
const IDLE_PEDS = Object.freeze([
  { x: 45.0, z: 123.0, yaw: 0.4 }, { x: 48.0, z: 122.4, yaw: -0.2 },
  { x: 54.5, z: 122.8, yaw: 2.7 }, { x: 57.2, z: 123.6, yaw: -2.4 },
  { x: 51.0, z: 121.2, yaw: 1.2 },
  { x: -4.2, z: 121.5, yaw: 0.2 }, { x: 0.4, z: 120.9, yaw: 2.8 },
  { x: 3.8, z: 121.8, yaw: -0.5 }, { x: 6.0, z: 123.0, yaw: 2.1 },
  { x: -29.0, z: 204.5, yaw: 0.5 }, { x: -18.0, z: 204.0, yaw: -1.0 },
  { x: 5.0, z: 205.0, yaw: 2.7 },
]);
const ALIGHT = path([[32.4, 38], [32.4, 29], [24, 27], [9, 25], [2, 19], [0, 12], [0, 7]], false);
const HOSPITAL_DOOR = Object.freeze({ x: HOSPITAL.entrance.x, z: HOSPITAL.entrance.z - 0.4 });
const HOSPITAL_WALK = Object.freeze({ x: HOSPITAL.entrance.x, z: HOSPITAL.entrance.z - 3.4 });

export class CityCrowd {
  constructor({ group, owned, signals }) {
    this.group = group;
    this.owned = owned;
    this.signals = signals;
    this.time = 0;
    this.peds = [];
    this.alighters = [];
    this._activated = false;
    this._dummy = new THREE.Object3D();
    this._build();
  }

  _build() {
    const g = this.group;
    // 旧版是“胶囊 + 球”的粗糙人偶；现在拆成躯干/头/头发/双臂/双腿，
    // 5 个 InstancedMesh 仍只有 5 draw，但轮廓、肩线、步态和肤色都完整了。
    // 腿部几何把脚掌包进去，避免走动时像两根悬空木棍。
    const bodyGeo = new THREE.CylinderGeometry(0.19, 0.245, 0.68, 8, 1);
    bodyGeo.translate(0, 0.34, 0);
    const headGeo = new THREE.SphereGeometry(0.165, 10, 8);
    headGeo.scale(1, 1.08, 0.96);
    const hairGeo = new THREE.SphereGeometry(0.176, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.56);
    hairGeo.scale(1, 1.05, 1);
    const armGeo = new THREE.CapsuleGeometry(0.055, 0.44, 2, 5);
    armGeo.translate(0, -0.28, 0);
    const legParts = [];
    const legCapsule = new THREE.CapsuleGeometry(0.075, 0.56, 2, 5);
    legCapsule.translate(0, -0.38, 0);
    legParts.push(legCapsule);
    const shoe = new THREE.BoxGeometry(0.15, 0.10, 0.28);
    shoe.translate(0, -0.78, 0.06);
    legParts.push(shoe);
    const legGeo = mergeSimple(legParts);
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.88 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const armMat = new THREE.MeshStandardMaterial({ roughness: 0.88 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2b323a, roughness: 0.95 });
    const total = WALKER_COUNT + 2 + 3 + IDLE_PEDS.length;
    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, total);
    this.head = new THREE.InstancedMesh(headGeo, skinMat, total);
    this.hair = new THREE.InstancedMesh(hairGeo, hairMat, total);
    this.arms = new THREE.InstancedMesh(armGeo, armMat, total * 2);
    this.legs = new THREE.InstancedMesh(legGeo, legMat, total * 2);
    this.body.name = 'City/ped-body';
    this.head.name = 'City/ped-head';
    this.hair.name = 'City/ped-hair';
    this.arms.name = 'City/ped-arms';
    this.legs.name = 'City/ped-legs';
    for (const m of [this.body, this.head, this.hair, this.arms, this.legs]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      g.add(m);
    }
    this.owned.geometries.push(bodyGeo, headGeo, hairGeo, armGeo, legGeo);
    this.owned.materials.push(bodyMat, skinMat, hairMat, armMat, legMat);

    const palette = [0x314a6e, 0x8c4a42, 0x4e6b50, 0xd0b06a, 0x5b4a72, 0x2f6776, 0xb8b4aa, 0x7a3f3a,
      0x2f5d4e, 0xb06a4e, 0x465a77, 0xd4c2a1];
    const skinPalette = [0xe8bd94, 0xd8a67e, 0xc48c62, 0xf1cba6, 0xa97655];
    const hairPalette = [0x2a211c, 0x3d2c22, 0x1f1a17, 0x6b4a32, 0x8a8074];
    const rng = (() => { let s = 7719; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
    for (let i = 0; i < WALKER_COUNT; i++) {
      const loopIndex = i % WALK_LOOPS.length;
      const segCount = WALK_LOOPS[loopIndex].length;
      this.peds.push({
        kind: 'walker', loopIndex, seg: (i * 2) % segCount,
        t: (0.08 + (i * 0.137) % 0.84),
        speed: 1.18 + rng() * 0.3,
        phase: rng() * Math.PI * 2, visible: true, waiting: false,
      });
    }
    // 医院访客：一进一出，进门后短暂隐藏再出来
    for (let i = 0; i < 2; i++) {
      this.peds.push({
        kind: 'visitor', x: HOSPITAL_WALK.x, z: HOSPITAL_WALK.z,
        targetInside: i === 0, speed: 0.95 + i * 0.08,
        wait: i === 0 ? 1.0 : 5.2, hidden: i !== 0, lateral: i === 0 ? -0.32 : 0.32,
        phase: rng() * Math.PI * 2, visible: true,
      });
    }
    // 公交下客
    for (let i = 0; i < 3; i++) {
      const p = {
        kind: 'alighter', route: ALIGHT, t: 0, speed: 1.0 + i * 0.08,
        dir: 1, phase: rng() * Math.PI * 2, alighter: true, active: false, visible: true,
        delay: 0, lateral: (i - 1) * 0.42,
      };
      this.peds.push(p);
      this.alighters.push(p);
    }
    // 校园/商场/湖滨的停留者：站位固定，头部和手臂仍缓慢动。
    IDLE_PEDS.forEach((p, i) => {
      this.peds.push({
        kind: 'idle', x: p.x, z: p.z, yaw: p.yaw,
        phase: 0.7 + i * 1.37, speed: 0, visible: true, hidden: false,
        idleGroup: i < 5 ? 'school' : i < 9 ? 'mall' : 'lake',
      });
    });

    this.peds.forEach((p, i) => {
      const coat = new THREE.Color(palette[i % palette.length]);
      this.body.setColorAt(i, coat);
      this.arms.setColorAt(i * 2, coat);
      this.arms.setColorAt(i * 2 + 1, coat);
      this.head.setColorAt(i, new THREE.Color(skinPalette[i % skinPalette.length]));
      this.hair.setColorAt(i, new THREE.Color(hairPalette[i % hairPalette.length]));
      p.scale = 0.93 + (i % 5) * 0.025;
    });
    for (const m of [this.body, this.arms, this.head, this.hair]) {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this._write(0);
  }

  /** 每一趟公交到站都重新放客；不再整局只触发一次。 */
  activateAlighters() {
    this._activated = true;
    for (const p of this.alighters) {
      p.active = true;
      p.t = 0;
      p.dir = 1;
      p.alighterSeen = false;
      p.delay = (p.lateral + 0.42) / 0.42 * 1.15;
      p.hidden = p.delay > 0;
    }
  }

  _posOfAlighter(p) {
    const r = p.route;
    const t = Math.max(0, Math.min(1, p.t));
    const idx = Math.floor(t * 160) % 160;
    const s = r.samples[idx];
    const s2 = r.samples[(idx + 1) % 160];
    let dx = s2.x - s.x, dz = s2.z - s.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const yaw = Math.atan2(dx, dz);
    const lat = p.lateral || 0;
    return { x: s.x + dz * lat, z: s.z - dx * lat, yaw, moving: true };
  }

  _walkerPos(p) {
    const seg = WALK_LOOPS[p.loopIndex][p.seg];
    const t = Math.max(0, Math.min(1, p.t));
    return {
      x: seg.ax + (seg.bx - seg.ax) * t,
      z: seg.az + (seg.bz - seg.az) * t,
      yaw: seg.yaw,
      moving: !p.waiting,
    };
  }

  _visitorPos(p) {
    const start = p.targetInside ? HOSPITAL_WALK : HOSPITAL_DOOR;
    const end = p.targetInside ? HOSPITAL_DOOR : HOSPITAL_WALK;
    const t = p.moveT ?? 0;
    return {
      x: start.x + (end.x - start.x) * t + (p.lateral || 0),
      z: start.z + (end.z - start.z) * t,
      yaw: p.targetInside ? Math.PI : 0,
      moving: !p.wait,
    };
  }

  _advanceWalker(p, dt) {
    const loop = WALK_LOOPS[p.loopIndex];
    if (p.waiting) {
      const seg = loop[p.seg];
      const clear = Math.max(1.2, seg.len / p.speed + 1.0);
      if (!this.signals.canPedCross(seg.axis, clear, seg.bx, seg.bz)) return;
      p.waiting = false;
    }
    const seg = loop[p.seg];
    p.t += (p.speed * dt) / seg.len;
    if (p.t < 1) return;
    p.t = 0;
    p.seg = (p.seg + 1) % loop.length;
    const next = loop[p.seg];
    if (next.crossing) {
      const clear = Math.max(1.2, next.len / p.speed + 1.0);
      p.waiting = !this.signals.canPedCross(next.axis, clear, next.bx, next.bz);
    }
  }

  _advanceVisitor(p, dt) {
    if (p.wait > 0) {
      p.wait -= dt;
      if (p.wait <= 0) {
        p.hidden = false;
        p.targetInside = !p.targetInside;
        p.moveT = 0;
      }
      return;
    }
    p.moveT = (p.moveT ?? 0) + p.speed * dt / 5.6;
    if (p.moveT >= 1) {
      p.moveT = 1;
      p.hidden = p.targetInside;
      p.wait = p.targetInside ? 4.5 : 1.8;
    }
  }

  _advanceAlighter(p, dt) {
    if (!p.active) return;
    if (p.delay > 0) {
      p.delay -= dt;
      if (p.delay <= 0) { p.delay = 0; p.hidden = false; }
      return;
    }
    p.t += (p.speed * dt) / p.route.length;
    if (p.t >= 1) {
      p.t = 1;
      p.dir = -1;
    }
    if (p.t <= 0) {
      p.t = 0;
      p.dir = 1;
    }
    // 下客后沿步道进出，不穿过机动车道
    p.moving = true;
  }

  _candidate(p) {
    if (p.kind === 'walker') return this._walkerPos(p);
    if (p.kind === 'visitor') return this._visitorPos(p);
    if (p.kind === 'idle') return { x: p.x, z: p.z, yaw: p.yaw, moving: false };
    return this._posOfAlighter(p);
  }

  _canMoveTo(p, x, z) {
    for (const o of this.peds) {
      if (o === p || o.hidden || !o.visible) continue;
      if (o.kind === 'alighter' && !o.active) continue;
      const q = this._candidate(o);
      const dx = q.x - x, dz = q.z - z;
      if (dx * dx + dz * dz < 0.44) return false;
    }
    return true;
  }

  _write(dt) {
    const d = this._dummy;
    this.peds.forEach((p, i) => {
      if (p.kind === 'alighter' && (!p.active || p.delay > 0)) {
        this._hide(i, d);
        return;
      }
      if (p.hidden) {
        this._hide(i, d);
        return;
      }
      let pos;
      if (p.kind === 'walker') {
        pos = this._walkerPos(p);
        if (dt > 0) {
          const before = pos;
          this._advanceWalker(p, dt);
          const after = this._walkerPos(p);
          if (!this._canMoveTo(p, after.x, after.z)) {
            // 被人挡住：保持原位，不推进标量
            p.t = Math.max(0, p.t - (p.speed * dt) / WALK_LOOPS[p.loopIndex][p.seg].len);
            pos = this._walkerPos(p);
          } else {
            pos = after;
          }
          void before;
        }
      } else if (p.kind === 'visitor') {
        if (dt > 0) this._advanceVisitor(p, dt);
        if (p.hidden) { this._hide(i, d); return; }
        pos = this._visitorPos(p);
      } else if (p.kind === 'idle') {
        pos = { x: p.x, z: p.z, yaw: p.yaw, moving: false };
      } else {
        if (dt > 0) this._advanceAlighter(p, dt);
        pos = this._posOfAlighter(p);
      }
      const s = p.scale || 1;
      const bob = pos.moving ? Math.sin(this.time * 7.4 + p.phase) * 0.026 : 0;
      const yaw = pos.yaw + (p.dir < 0 ? Math.PI : 0);
      const walk = pos.moving ? Math.sin(this.time * 9 + p.phase) : 0;
      d.position.set(pos.x, 1.16 + 0.86 * s + bob, pos.z);
      d.rotation.set(walk * 0.018, yaw, 0);
      d.scale.set(s, s, s);
      d.updateMatrix();
      this.body.setMatrixAt(i, d.matrix);

      const look = Math.sin(this.time * 0.52 + p.phase * 1.7) * (pos.moving ? 0.16 : 0.38);
      d.position.set(pos.x, 1.16 + 1.67 * s + bob, pos.z);
      d.rotation.set(0, yaw + look, 0);
      d.scale.set(s, s, s);
      d.updateMatrix();
      this.head.setMatrixAt(i, d.matrix);
      d.position.y = 1.16 + 1.70 * s + bob;
      d.updateMatrix();
      this.hair.setMatrixAt(i, d.matrix);

      for (let l = 0; l < 2; l += 1) {
        const swing = pos.moving ? Math.sin(this.time * 9 + p.phase + l * Math.PI) * 0.42 : 0;
        d.position.set(
          pos.x + Math.cos(yaw) * (l ? 0.105 : -0.105) * s,
          1.16 + 0.86 * s + bob,
          pos.z - Math.sin(yaw) * (l ? 0.105 : -0.105) * s,
        );
        d.rotation.set(swing, yaw, 0);
        d.scale.set(s, s, s);
        d.updateMatrix();
        this.legs.setMatrixAt(i * 2 + l, d.matrix);

        d.position.set(
          pos.x + Math.cos(yaw) * (l ? 0.225 : -0.225) * s,
          1.16 + 1.48 * s + bob,
          pos.z - Math.sin(yaw) * (l ? 0.225 : -0.225) * s,
        );
        d.rotation.set(-swing * 0.72, yaw, l ? -0.06 : 0.06);
        d.updateMatrix();
        this.arms.setMatrixAt(i * 2 + l, d.matrix);
      }
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    this.hair.instanceMatrix.needsUpdate = true;
    this.arms.instanceMatrix.needsUpdate = true;
    this.legs.instanceMatrix.needsUpdate = true;
  }

  _hide(i, d) {
    d.position.set(0, -50, 0);
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(0.001);
    d.updateMatrix();
    this.body.setMatrixAt(i, d.matrix);
    this.head.setMatrixAt(i, d.matrix);
    this.hair.setMatrixAt(i, d.matrix);
    for (let l = 0; l < 2; l++) {
      this.legs.setMatrixAt(i * 2 + l, d.matrix);
      this.arms.setMatrixAt(i * 2 + l, d.matrix);
    }
  }

  update(dt) {
    this.time += dt;
    this._write(dt);
  }

  getStats() {
    return {
      total: this.peds.length,
      walkers: this.peds.filter((p) => p.kind === 'walker').length,
      hospitalVisitors: this.peds.filter((p) => p.kind === 'visitor').length,
      idlers: this.peds.filter((p) => p.kind === 'idle').length,
      schoolVisitors: this.peds.filter((p) => p.idleGroup === 'school').length,
      mallVisitors: this.peds.filter((p) => p.idleGroup === 'mall').length,
      alighters: this.alighters.length,
      waitingAtLight: this.peds.filter((p) => p.waiting).length,
    };
  }
}
