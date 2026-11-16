/** 都会区行人：24 个低模通勤者，身体/头/腿 3 个 InstancedMesh；公交到站后 3 人下车走向大门。 */
import * as THREE from 'three';
import { BUS_STOP } from './city-layout.js';

function path(points, closed) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'catmullrom', 0.2,
  );
  const samples = curve.getSpacedPoints(160);
  return { samples, length: curve.getLength(), closed };
}

const LOOP = path([[16.4, 112], [16.4, 208], [31.7, 208], [31.7, 112]], true);
const ALIGHT = path([[32.4, 38], [32.4, 29], [24, 27], [9, 25], [2, 19], [0, 12], [0, 7]], false);

export class CityCrowd {
  constructor({ group, owned }) {
    this.group = group;
    this.owned = owned;
    this.time = 0;
    this.peds = [];
    this.alighters = [];
    this._activated = false;
    this._alpha = 0;
    this._dummy = new THREE.Object3D();
    this._build();
  }

  _build() {
    const g = this.group;
    const bodyGeo = new THREE.CapsuleGeometry(0.22, 0.62, 1, 5);
    const headGeo = new THREE.SphereGeometry(0.17, 6, 4);
    const legGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.5, 4);
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd7a67e, roughness: 0.9 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2b323a, roughness: 0.95 });
    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, 24);
    this.head = new THREE.InstancedMesh(headGeo, skinMat, 24);
    this.legs = new THREE.InstancedMesh(legGeo, legMat, 48);
    this.body.name = 'City/ped-body';
    this.head.name = 'City/ped-head';
    this.legs.name = 'City/ped-legs';
    for (const m of [this.body, this.head, this.legs]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      g.add(m);
    }
    this.owned.geometries.push(bodyGeo, headGeo, legGeo);
    this.owned.materials.push(bodyMat, skinMat, legMat);

    const palette = [0x314a6e, 0x8c4a42, 0x4e6b50, 0xd0b06a, 0x5b4a72, 0x2f6776, 0xb8b4aa, 0x7a3f3a];
    const rng = (() => { let s = 7719; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
    for (let i = 0; i < 24; i++) {
      const p = {
        route: i < 21 ? LOOP : ALIGHT,
        t: i < 21 ? i / 21 : (i - 21) / 3,
        speed: 0.75 + rng() * 0.45,
        dir: 1,
        phase: rng() * Math.PI * 2,
        alighter: i >= 21,
        active: i < 21,
      };
      this.peds.push(p);
      if (p.alighter) this.alighters.push(p);
      this.body.setColorAt(i, new THREE.Color(palette[i % palette.length]));
    }
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    this._write(0);
  }

  activateAlighters() {
    if (this._activated) return;
    this._activated = true;
    for (const p of this.alighters) {
      p.active = true;
      p.t = 0;
      p.dir = 1;
    }
  }

  _posOf(p) {
    const r = p.route;
    let t = p.t;
    if (r.closed) t = ((t % 1) + 1) % 1;
    else t = Math.max(0, Math.min(1, t));
    const idx = Math.floor(t * 160) % 160;
    const s = r.samples[idx];
    const s2 = r.samples[(idx + 1) % 160];
    const yaw = Math.atan2(s2.x - s.x, s2.z - s.z);
    return { x: s.x, z: s.z, yaw };
  }

  _write(dt) {
    const d = this._dummy;
    this.peds.forEach((p, i) => {
      if (!p.active) {
        d.position.set(0, -50, 0); d.scale.setScalar(0.001);
        d.rotation.set(0, 0, 0); d.updateMatrix();
        this.body.setMatrixAt(i, d.matrix);
        this.head.setMatrixAt(i, d.matrix);
        for (let l = 0; l < 2; l++) this.legs.setMatrixAt(i * 2 + l, d.matrix);
        return;
      }
      if (dt > 0) {
        if (p.route.closed) {
          p.t = (p.t + (p.speed * dt) / p.route.length) % 1;
        } else {
          p.t += (p.speed * dt * p.dir) / p.route.length;
          if (p.t >= 1) { p.t = 1; p.dir = -1; }
          if (p.t <= 0) { p.t = 0; p.dir = 1; }
        }
      }
      const s = this._posOf(p);
      const bob = Math.sin(this.time * 7 + p.phase) * 0.035;
      d.position.set(s.x, 1.16 + 0.63 + bob, s.z);
      d.rotation.set(0, s.yaw + (p.dir < 0 ? Math.PI : 0), 0);
      d.scale.set(1, 1, 1);
      d.updateMatrix();
      this.body.setMatrixAt(i, d.matrix);
      d.position.y = 1.16 + 1.2 + bob;
      d.updateMatrix();
      this.head.setMatrixAt(i, d.matrix);
      for (let l = 0; l < 2; l++) {
        const swing = Math.sin(this.time * 9 + p.phase + l * Math.PI) * 0.18;
        d.position.set(s.x, 1.16 + 0.27, s.z);
        d.rotation.set(0, s.yaw + (p.dir < 0 ? Math.PI : 0), 0);
        d.translateZ(0.18);
        d.translateX(l ? 0.1 : -0.1);
        d.rotateX(swing);
        d.updateMatrix();
        this.legs.setMatrixAt(i * 2 + l, d.matrix);
      }
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    this.legs.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    this._write(dt);
  }
}
