/**
 * 都会区交通：CatmullRomCurve3 预采样路线 + InstancedMesh。
 * 运行时只推进标量 t、写矩阵，无物理、无逐帧曲线求值。
 */
import * as THREE from 'three';
import { CITY, BUS_STOP } from './city-layout.js';

const ROUTE_POINTS = {
  city: [[24, 108], [24, 188], [70, 188], [70, 112], [24, 112]],
  west: [[-50, 110], [-50, 188], [24, 188], [24, 110]],
  park: [[24, -12], [24, 108], [28, 108], [28, -12]],
  bus: [[26.5, -8], [26.5, 104], [28.2, 104], [28.2, -8]],
  parking: [[24, 100], [-17, 100], [-24, 102], [-24, 108], [-17, 108], [24, 108]],
};

function sampleRoute(points, closed = true) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'catmullrom', 0.25,
  );
  const samples = curve.getSpacedPoints(256).slice(0, 256);
  const normals = [];
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i], b = samples[(i + 1) % samples.length];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    normals.push({ x: dz, z: -dx, dx, dz });
  }
  return { samples, normals, length: curve.getLength() };
}

function srgb(hex) { return new THREE.Color(hex); }

export class CityTraffic {
  constructor({ group, owned }) {
    this.group = group;
    this.owned = owned;
    this.time = 0;
    this._dummy = new THREE.Object3D();
    this._m = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
    this._routes = Object.fromEntries(Object.entries(ROUTE_POINTS).map(([k, p]) => [k, sampleRoute(p, true)]));
    this._vehicles = [];
    this._parked = [];
    this._build();
  }

  _build() {
    const g = this.group;
    const bodyGeo = new THREE.BoxGeometry(1, 1, 1);
    const cabinGeo = new THREE.BoxGeometry(1, 1, 1);
    const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.2, 6);
    wheelGeo.rotateZ(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.35 });
    const cabinMat = new THREE.MeshStandardMaterial({ color: 0x182b33, roughness: 0.2, metalness: 0.4 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.9 });
    this.owned.geometries.push(bodyGeo, cabinGeo, wheelGeo);
    this.owned.materials.push(bodyMat, cabinMat, wheelMat);

    const moving = 28, parked = 4, total = moving + parked;
    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, total);
    this.cabin = new THREE.InstancedMesh(cabinGeo, cabinMat, total);
    this.wheels = new THREE.InstancedMesh(wheelGeo, wheelMat, moving * 4 + parked * 4);
    this.body.name = 'City/cars-body';
    this.cabin.name = 'City/cars-cabin';
    this.wheels.name = 'City/cars-wheels';
    for (const m of [this.body, this.cabin, this.wheels]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      g.add(m);
    }
    const palette = [0xe9edf0, 0x222a30, 0x2f6fa8, 0xb8453c, 0xd6b24a, 0x5b7f68, 0xd9d4c8, 0x6d4a7c];
    const rng = (() => { let s = 20261116; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
    const specs = [
      ...Array.from({ length: 12 }, (_, i) => ({ route: 'city', lane: i % 2 ? 1.65 : -1.65 })),
      ...Array.from({ length: 8 }, (_, i) => ({ route: 'west', lane: i % 2 ? 1.65 : -1.65 })),
      ...Array.from({ length: 5 }, (_, i) => ({ route: 'park', lane: i % 2 ? 1.6 : -1.6 })),
      ...Array.from({ length: 3 }, (_, i) => ({ route: 'parking', lane: 0 })),
    ];
    specs.forEach((s, i) => {
      const route = this._routes[s.route];
      this._vehicles.push({
        ...s, t: (i * 0.137) % 1,
        speed: 7.5 + rng() * 4.5,
        color: palette[i % palette.length],
      });
      this.body.setColorAt(i, srgb(palette[i % palette.length]));
    });
    // 停车场静置车位
    for (let i = 0; i < parked; i++) {
      this._parked.push({ x: -30 + (i % 2) * 4.2, z: 98 + Math.floor(i / 2) * 5.2, yaw: Math.PI });
      this.body.setColorAt(moving + i, srgb(palette[(i + 3) % palette.length]));
    }
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;

    // 公交车：单独 2 个 InstancedMesh（车身 / 窗带）
    const busGeo = new THREE.BoxGeometry(2.4, 2.5, 7.6);
    const busWinGeo = new THREE.BoxGeometry(2.46, 0.85, 6.4);
    const busMat = new THREE.MeshStandardMaterial({ color: 0x2f8f6a, roughness: 0.4, metalness: 0.2 });
    const busWinMat = new THREE.MeshStandardMaterial({ color: 0x17313c, roughness: 0.15, metalness: 0.4 });
    this.owned.geometries.push(busGeo, busWinGeo);
    this.owned.materials.push(busMat, busWinMat);
    this.busBody = new THREE.InstancedMesh(busGeo, busMat, 1);
    this.busWin = new THREE.InstancedMesh(busWinGeo, busWinMat, 1);
    this.busBody.name = 'City/bus-body';
    this.busWin.name = 'City/bus-windows';
    for (const m of [this.busBody, this.busWin]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      g.add(m);
    }
    this.bus = { t: 0.02, speed: 5.2, hold: 0, stopped: false };
    this.busStopFired = false;
    this.onBusStop = null;
    this._writeParked();
    this._write(0);
  }

  _writeParked() {
    const d = this._dummy;
    this._parked.forEach((p, i) => {
      const idx = 28 + i;
      d.position.set(p.x, 1.435, p.z);
      d.rotation.set(0, p.yaw, 0);
      d.scale.set(1.0, 0.55, 2.15);
      d.updateMatrix();
      this.body.setMatrixAt(idx, d.matrix);
      d.position.y = 1.96;
      d.scale.set(0.82, 0.5, 1.25);
      d.updateMatrix();
      this.cabin.setMatrixAt(idx, d.matrix);
      for (let w = 0; w < 4; w++) {
        const ox = w % 2 ? 0.5 : -0.5, oz = w < 2 ? 0.65 : -0.65;
        d.position.set(
          p.x + Math.cos(p.yaw) * ox + Math.sin(p.yaw) * oz,
          1.435,
          p.z - Math.sin(p.yaw) * ox + Math.cos(p.yaw) * oz,
        );
        d.rotation.set(0, p.yaw, 0);
        d.scale.set(1, 1, 1);
        d.updateMatrix();
        this.wheels.setMatrixAt(28 * 4 + i * 4 + w, d.matrix);
      }
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
  }

  _write(idx, dt = 0) {
    const d = this._dummy;
    this._vehicles.forEach((v, i) => {
      const route = this._routes[v.route];
      v.t = (v.t + (v.speed * dt) / route.length) % 1;
      const f = v.t * 256;
      const i0 = Math.floor(f) % 256;
      const s = route.samples[i0], n = route.normals[i0];
      const yaw = Math.atan2(n.dx, n.dz);
      const x = s.x + n.x * v.lane;
      const z = s.z + n.z * v.lane;
      d.position.set(x, 1.435, z);
      d.rotation.set(0, yaw, 0);
      d.scale.set(1.0, 0.55, 2.15);
      d.updateMatrix();
      this.body.setMatrixAt(i, d.matrix);
      this._m.copy(d.matrix);
      d.position.y = 1.96;
      d.scale.set(0.82, 0.5, 1.22);
      d.updateMatrix();
      this.cabin.setMatrixAt(i, d.matrix);
      for (let w = 0; w < 4; w++) {
        const ox = w % 2 ? 0.46 : -0.46, oz = w < 2 ? 0.68 : -0.68;
        d.position.set(
          x + Math.cos(yaw) * ox + Math.sin(yaw) * oz,
          1.435,
          z - Math.sin(yaw) * ox + Math.cos(yaw) * oz,
        );
        d.rotation.set(0, yaw, 0);
        d.scale.set(1, 1, 1);
        d.updateMatrix();
        this.wheels.setMatrixAt(i * 4 + w, d.matrix);
      }
      void this._local;
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
  }

  _updateBus(dt) {
    const route = this._routes.bus;
    const b = this.bus;
    if (b.hold > 0) {
      b.hold -= dt;
    } else {
      b.t = (b.t + (b.speed * dt) / route.length) % 1;
      const s = route.samples[Math.floor(b.t * 256) % 256];
      // 公交站：进入 z=38±2 且尚未停靠过 → 停 3.2s，触发下客
      if (!b.stopped && Math.abs(s.z - BUS_STOP.z) < 1.6 && s.x > 22) {
        b.stopped = true;
        b.hold = 3.2;
        if (!this.busStopFired) {
          this.busStopFired = true;
          this.onBusStop?.();
        }
      }
      if (b.stopped && Math.abs(s.z - BUS_STOP.z) > 6) b.stopped = false;
    }
    const s = route.samples[Math.floor(b.t * 256) % 256];
    const n = route.normals[Math.floor(b.t * 256) % 256];
    const yaw = Math.atan2(n.dx, n.dz);
    const d = this._dummy;
    d.position.set(s.x, 2.42, s.z);
    d.rotation.set(0, yaw, 0);
    d.scale.set(1, 1, 1);
    d.updateMatrix();
    this.busBody.setMatrixAt(0, d.matrix);
    d.position.y = 2.95;
    d.updateMatrix();
    this.busWin.setMatrixAt(0, d.matrix);
    this.busBody.instanceMatrix.needsUpdate = true;
    this.busWin.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    this.time += dt;
    this._write(0, dt);
    this._updateBus(dt);
  }

  getSignalPhase() {
    return (Math.floor(this.time / 9) % 2) === 0 ? 'green' : 'red';
  }
}
