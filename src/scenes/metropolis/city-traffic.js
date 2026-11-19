/**
 * 都会区交通（第一阶段大修）：
 * - 车辆大幅降密：10 辆行驶车 + 2 辆停放车 + 1 辆公交；
 * - 预采样路线 + 标量里程，运行时零曲线求值、零 new；
 * - 9 个路口的红灯停车、同路线跟车、跨路线近距避让；
 * - 夜间每辆车有头灯/尾灯以及路面光斑（全部 InstancedMesh）。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, CITY_INTERSECTIONS, BUS_STOP } from './city-layout.js';
import { createCarBodyGeometry, createCarCabinGeometry } from './city-car-blender-model.js';

/** 轮胎 + 轮毂 + 四根辐条合并成一个轮子几何：仍只 1 draw，但不再是光秃秃的圆柱。 */
function detailedWheelGeometry() {
  const parts = [];
  const paint = (g, hex) => {
    const c = new THREE.Color(hex);
    const a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    parts.push(g);
  };
  const tire = new THREE.CylinderGeometry(0.30, 0.30, 0.235, 12, 1);
  tire.rotateZ(Math.PI / 2);
  paint(tire, 0x171b1d);
  const rim = new THREE.CylinderGeometry(0.175, 0.175, 0.255, 8, 1);
  rim.rotateZ(Math.PI / 2);
  paint(rim, 0xaeb7ba);
  const hub = new THREE.CylinderGeometry(0.055, 0.055, 0.27, 6, 1);
  hub.rotateZ(Math.PI / 2);
  paint(hub, 0x555f63);
  for (let i = 0; i < 4; i += 1) {
    const spoke = new THREE.BoxGeometry(0.265, 0.035, 0.055);
    spoke.rotateX((i * Math.PI) / 4);
    paint(spoke, 0xd7dedf);
  }
  const sources = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const geo = mergeGeometries(sources, false);
  // toNonIndexed() 会返回新对象；只释放原 parts 会留下 7 份临时几何。
  sources.forEach((g) => { if (!parts.includes(g)) g.dispose(); });
  parts.forEach((p) => p.dispose());
  return geo;
}

/* 路线点全部放在“右行车道中心”，而不是道路中心线：
 * 主干道 16m → 北行 x=27.2 / 南行 x=20.8；横街 12m → 东行 z-3 / 西行 z+3。
 * 这样双向车流不会压黄线，也不会出现同车道对头车。 */
const ROUTE_POINTS = {
  city: [[27.2, 115], [27.2, 191], [66.8, 191], [66.8, 115]],
  west: [[-47.2, 116], [-47.2, 190], [-52.8, 190], [-52.8, 116]],
  park: [[27.2, -12], [27.2, 106], [20.8, 106], [20.8, -12]],
  // 公交不再只在公园门口折返：先沿主干道进都会区，绕一个完整街块后回公园。
  bus: [[28.2, -8], [28.2, 191], [66.8, 191], [66.8, 115], [20.8, 115], [20.8, -8]],
};

function lanePoint(route, t, lane) {
  const i = Math.floor(t * 256) % 256;
  const s = route.samples[i], n = route.normals[i];
  return { x: s.x + n.x * lane, z: s.z + n.z * lane, yaw: Math.atan2(n.dx, n.dz), dx: n.dx, dz: n.dz };
}

function makeRoute(points, closed = true) {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'catmullrom', 0.2,
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
  const length = curve.getLength();
  // 预计算信号停车点：路线首次进入路口外扩区（含斑马线）的里程
  const stops = [];
  for (const it of CITY_INTERSECTIONS) {
    let hit = -1;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (Math.abs(s.x - it.x) <= it.halfX + 1.9 && Math.abs(s.z - it.z) <= it.halfZ + 1.9) {
        hit = i;
        break;
      }
    }
    if (hit < 0) continue;
    // 用进入路口前约 1.5m 的切线判断车道轴，避免转弯段把 x 轴误判成 z 轴
    const probe = (hit - 6 + samples.length) % samples.length;
    const n = normals[probe];
    const axis = Math.abs(n.dx) >= Math.abs(n.dz) ? 'x' : 'z';
    const dist = ((hit / 256) * length - 4.0 + length) % length;
    stops.push({ dist, axis, ix: it.x, iz: it.z });
  }
  stops.sort((a, b) => a.dist - b.dist);
  return { samples, normals, length, stops };
}

function lightPoolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(255,250,220,.88)');
  grad.addColorStop(0.28, 'rgba(255,238,190,.30)');
  grad.addColorStop(1, 'rgba(255,225,175,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const side = g.createRadialGradient(64, 76, 4, 64, 76, 60);
  side.addColorStop(0, 'rgba(255,248,215,.55)');
  side.addColorStop(1, 'rgba(255,235,190,0)');
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = side;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function tailPoolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 44, 3, 64, 56, 62);
  grad.addColorStop(0, 'rgba(255,60,45,.65)');
  grad.addColorStop(0.5, 'rgba(235,30,24,.18)');
  grad.addColorStop(1, 'rgba(220,20,16,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function planeFlat(w, d) {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function srgb(hex) { return new THREE.Color(hex); }

export class CityTraffic {
  constructor({ group, owned, signals }) {
    this.group = group;
    this.owned = owned;
    this.signals = signals;
    this.time = 0;
    this._dummy = new THREE.Object3D();
    this._routes = Object.fromEntries(
      Object.entries(ROUTE_POINTS).map(([k, p]) => [k, makeRoute(p, true)]),
    );
    this._vehicles = [];
    this._parked = [];
    this._claimed = null;
    this._playerCar = null;
    this._build();
  }

  _build() {
    const g = this.group;
    // 【Blender 车模】车身/玻璃舱来自 tools/blender/build_city_car.py（3444 tris），
    // 原点与实例矩阵语义对齐（body 中心=实例位置，cabin 中心=实例位置），故实例缩放恒为 1。
    const bodyGeo = createCarBodyGeometry();
    const cabinGeo = createCarCabinGeometry();
    const wheelGeo = detailedWheelGeometry();
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.35, vertexColors: true });
    const cabinMat = new THREE.MeshStandardMaterial({ color: 0x182b33, roughness: 0.2, metalness: 0.4 });
    const wheelMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.16,
    });
    this.owned.geometries.push(bodyGeo, cabinGeo, wheelGeo);
    this.owned.materials.push(bodyMat, cabinMat, wheelMat);

    const moving = 10, parked = 2, total = moving + parked;
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
    const specs = [
      ...Array.from({ length: 4 }, (_, i) => ({ route: 'city', lane: 0, slot: i })),
      ...Array.from({ length: 3 }, (_, i) => ({ route: 'west', lane: 0, slot: i })),
      ...Array.from({ length: 3 }, (_, i) => ({ route: 'park', lane: 0, slot: i })),
    ];
    const byRoute = { city: 0, west: 0, park: 0 };
    // 初始点放在路段中部而不是矩形拐角：拐角就是路口，直接生成在路口里
    // 会制造“开局第一帧闯红灯”的假违规。
    const phases = {
      city: [0.13, 0.38, 0.63, 0.88],
      west: [0.08, 0.32, 0.62],
      park: [0.12, 0.36, 0.61],
    };
    specs.forEach((s, i) => {
      const route = this._routes[s.route];
      const t = phases[s.route][byRoute[s.route]] ?? 0.2;
      byRoute[s.route] += 1;
      this._vehicles.push({
        ...s, t: t % 1, s: t * route.length,
        speed: 5.8 + (i % 3) * 1.1,
        curSpeed: 4,
        x: 24, z: 100, yaw: 0, dx: 0, dz: 1, spin: 0,
        color: palette[i % palette.length],
      });
      this.body.setColorAt(i, srgb(palette[i % palette.length]));
    });
    for (let i = 0; i < parked; i++) {
      // 0 号留在停车场（旧验收 D1 仍可从原地找到车）；1 号放到公园入口试车位，
      // 让第一次进城的玩家不用走 80m 才知道“这游戏能开车”。
      this._parked.push(i === 0
        ? { x: -30, z: 98, yaw: Math.PI }
        : { x: CITY.demoParking.x, z: CITY.demoParking.z, yaw: 0 });
      this.body.setColorAt(moving + i, srgb(palette[(i + 3) % palette.length]));
    }
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;

    // 公交车
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
    this.bus = { t: 0.02, speed: 4.6, curSpeed: 4.2, hold: 0, stopped: false };
    this.onBusStop = null;
    this.playerPose = null;

    // 车灯：头灯/尾灯灯珠 + 地面光斑；白昼透明度为 0
    const lampGeo = new THREE.SphereGeometry(0.11, 5, 4);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff2c8, toneMapped: false, transparent: true, opacity: 0.25 });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff352c, toneMapped: false, transparent: true, opacity: 0.25 });
    const headPoolMat = new THREE.MeshBasicMaterial({
      map: lightPoolTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, color: 0xffecc0, toneMapped: false,
    });
    const tailPoolMat = new THREE.MeshBasicMaterial({
      map: tailPoolTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, color: 0xff2018, toneMapped: false,
    });
    const headPoolGeo = planeFlat(5.4, 9.2);
    const tailPoolGeo = planeFlat(3.4, 5.4);
    this.headLamps = new THREE.InstancedMesh(lampGeo, headMat, moving * 2);
    this.tailLamps = new THREE.InstancedMesh(lampGeo, tailMat, moving * 2);
    this.headPools = new THREE.InstancedMesh(headPoolGeo, headPoolMat, moving);
    this.tailPools = new THREE.InstancedMesh(tailPoolGeo, tailPoolMat, moving);
    for (const [name, m] of [
      ['City/car-head-lamps', this.headLamps], ['City/car-tail-lamps', this.tailLamps],
      ['City/car-head-pools', this.headPools], ['City/car-tail-pools', this.tailPools],
    ]) {
      m.name = name;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      g.add(m);
    }
    this._headMat = headMat;
    this._tailMat = tailMat;
    this._headPoolMat = headPoolMat;
    this._tailPoolMat = tailPoolMat;
    this.owned.geometries.push(lampGeo, headPoolGeo, tailPoolGeo);
    this.owned.materials.push(headMat, tailMat, headPoolMat, tailPoolMat);
    this.owned.textures.push(headPoolMat.map, tailPoolMat.map);

    this._buildShadows();
    this._writeParked();
    this._write(0);
  }

  _buildShadows() {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(48, 48, 4, 48, 48, 46);
    grad.addColorStop(0, 'rgba(0,0,0,.55)');
    grad.addColorStop(0.55, 'rgba(0,0,0,.22)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 96, 96);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = planeFlat(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.6, depthWrite: false, color: 0x0c110d,
    });
    const total = this._vehicles.length + this._parked.length + 1;
    this.carShadows = new THREE.InstancedMesh(geo, mat, total);
    this.carShadows.name = 'City/car-shadows';
    this.carShadows.frustumCulled = false;
    this.carShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.carShadows);
    this.owned.geometries.push(geo);
    this.owned.materials.push(mat);
    this.owned.textures.push(tex);
  }

  _writeShadow(slot, x, z, yaw, sx = 1.25, sz = 2.55, y = 1.205) {
    if (!this.carShadows) return;
    const d = this._dummy;
    d.position.set(x, y, z);
    d.rotation.set(0, yaw, 0);
    d.scale.set(sx, 1, sz);
    d.updateMatrix();
    this.carShadows.setMatrixAt(slot, d.matrix);
  }

  _writeParked() {
    const d = this._dummy;
    this._parked.forEach((p, i) => {
      const idx = 10 + i;
      d.position.set(p.x, 1.435, p.z);
      d.rotation.set(0, p.yaw, 0);
      d.scale.set(1, 1, 1);
      d.updateMatrix();
      this.body.setMatrixAt(idx, d.matrix);
      d.position.y = 1.96;
      d.scale.set(1, 1, 1);
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
        this.wheels.setMatrixAt(10 * 4 + i * 4 + w, d.matrix);
      }
    });
    this._parked.forEach((p, i) => this._writeShadow(10 + i, p.x, p.z, p.yaw));
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    if (this.carShadows) this.carShadows.instanceMatrix.needsUpdate = true;
  }

  _targetSpeed(v, i) {
    let target = v.speed;
    const route = this._routes[v.route];
    const L = route.length;
    // 按车辆真实行驶方向，找前方最近路口的停车线；黄灯同样停车
    let stopGap = Infinity;
    if (Math.abs(v.dx) + Math.abs(v.dz) > 0.05) {
      const axis = Math.abs(v.dx) >= Math.abs(v.dz) ? 'x' : 'z';
      if (this.signals.getVehicleState(axis, v.x, v.z) !== 'green') {
        const sign = axis === 'x' ? Math.sign(v.dx) : Math.sign(v.dz);
        for (const it of CITY_INTERSECTIONS) {
          let gap = Infinity;
          if (axis === 'x') {
            if (Math.abs(v.z - it.z) > it.halfZ + 1.2) continue;
            const stop = it.x - sign * (it.halfX + 4.2);
            gap = sign * (stop - v.x);
          } else {
            if (Math.abs(v.x - it.x) > it.halfX + 1.2) continue;
            const stop = it.z - sign * (it.halfZ + 4.2);
            gap = sign * (stop - v.z);
          }
          if (gap > 0.18 && gap < Math.max(12, v.curSpeed * v.curSpeed / 2.4)) stopGap = Math.min(stopGap, gap);
        }
      }
    }
    if (stopGap < Infinity) {
      if (stopGap < 1.2) target = 0;
      else target = Math.min(target, Math.sqrt(2 * 3.2 * Math.max(0, stopGap - 1.2)));
    }
    // 同路线跟车
    for (let j = 0; j < this._vehicles.length; j++) {
      if (j === i) continue;
      const o = this._vehicles[j];
      if (o.claimed || o.route !== v.route || o.lane !== v.lane) continue;
      let gap = (o.s - v.s + L) % L;
      if (gap < 0.1) gap += L;
      if (gap < 6.2) {
        const follow = Math.max(0, (gap - 2.3) * 1.5);
        target = Math.min(target, Math.min(o.curSpeed, follow));
      }
    }
    // 跨路线近距避让（防止路口合流时穿模）
    for (let j = 0; j < this._vehicles.length; j++) {
      if (j === i) continue;
      const o = this._vehicles[j];
      if (o.claimed) continue;
      const dx = o.x - v.x, dz = o.z - v.z;
      if (dx * dx + dz * dz > 18) continue;
      const ahead = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
      if (ahead > 0 && ahead < 4.2) target = Math.min(target, Math.max(0, ahead - 1.8));
    }
    // 玩家车进入 AI 前方时让行：不再出现 AI 车直接顶穿玩家车。
    if (this.playerPose) {
      const dx = this.playerPose.x - v.x, dz = this.playerPose.z - v.z;
      const ahead = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
      const side = Math.abs(dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw));
      if (ahead > 0 && ahead < 8.5 && side < 2.2) {
        target = Math.min(target, Math.max(0, (ahead - 3.2) * 1.2));
      }
    }
    return Math.max(0, target);
  }

  _write(idx, dt = 0) {
    const d = this._dummy;
    this._vehicles.forEach((v, i) => {
      if (v.claimed) return; // 被玩家驾驶的实例已隐藏，由玩家车接管
      const route = this._routes[v.route];
      if (dt > 0) {
        const target = this._targetSpeed(v, i);
        const lambda = target < v.curSpeed ? 8 : 2.2;
        v.curSpeed += (target - v.curSpeed) * (1 - Math.exp(-lambda * dt));
        if (v.curSpeed < 0.015 && target === 0) v.curSpeed = 0;
        v.s = (v.s + v.curSpeed * dt) % route.length;
        v.t = v.s / route.length;
      }
      const p = lanePoint(route, v.t, v.lane);
      v.x = p.x; v.z = p.z; v.yaw = p.yaw;
      v.dx = p.dx; v.dz = p.dz;
      // 车轮按真实滚动周长转动：速度越快转得越快。
      if (dt > 0) v.spin = (v.spin - (v.curSpeed * dt) / 0.30) % (Math.PI * 2);
      d.position.set(p.x, 1.435, p.z);
      d.rotation.set(0, p.yaw, 0);
      d.scale.set(1, 1, 1);
      d.updateMatrix();
      this.body.setMatrixAt(i, d.matrix);
      d.position.y = 1.96;
      d.scale.set(1, 1, 1);
      d.updateMatrix();
      this.cabin.setMatrixAt(i, d.matrix);
      for (let w = 0; w < 4; w++) {
        const ox = w % 2 ? 0.46 : -0.46, oz = w < 2 ? 0.68 : -0.68;
        d.position.set(
          p.x + Math.cos(p.yaw) * ox + Math.sin(p.yaw) * oz,
          1.435,
          p.z - Math.sin(p.yaw) * ox + Math.cos(p.yaw) * oz,
        );
        d.rotation.order = 'YXZ';
        d.rotation.set(v.spin, p.yaw, 0);
        d.scale.set(1, 1, 1);
        d.updateMatrix();
        this.wheels.setMatrixAt(i * 4 + w, d.matrix);
      }
      // 车灯与地面光斑
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      for (let k = 0; k < 2; k++) {
        const side = k ? 1 : -1;
        d.position.set(p.x + fx * 1.04 + Math.cos(p.yaw) * side * 0.34, 1.30, p.z + fz * 1.04 - Math.sin(p.yaw) * side * 0.34);
        d.rotation.set(0, p.yaw, 0); d.scale.set(1, 1, 1); d.updateMatrix();
        this.headLamps.setMatrixAt(i * 2 + k, d.matrix);
        d.position.set(p.x - fx * 1.04 + Math.cos(p.yaw) * side * 0.34, 1.28, p.z - fz * 1.04 - Math.sin(p.yaw) * side * 0.34);
        d.updateMatrix();
        this.tailLamps.setMatrixAt(i * 2 + k, d.matrix);
      }
      d.position.set(p.x + fx * 4.5, 1.19, p.z + fz * 4.5);
      d.rotation.set(0, p.yaw, 0); d.scale.set(1, 1, 1); d.updateMatrix();
      this.headPools.setMatrixAt(i, d.matrix);
      d.position.set(p.x - fx * 2.6, 1.18, p.z - fz * 2.6);
      d.updateMatrix();
      this.tailPools.setMatrixAt(i, d.matrix);
      this._writeShadow(i, p.x, p.z, p.yaw);
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.headLamps.instanceMatrix.needsUpdate = true;
    this.tailLamps.instanceMatrix.needsUpdate = true;
    this.headPools.instanceMatrix.needsUpdate = true;
    this.tailPools.instanceMatrix.needsUpdate = true;
    if (this.carShadows) this.carShadows.instanceMatrix.needsUpdate = true;
  }

  _updateBus(dt) {
    const route = this._routes.bus;
    const b = this.bus;
    let idx = Math.floor(b.t * 256) % 256;
    let s = route.samples[idx];
    let n = route.normals[idx];
    if (b.hold > 0) {
      b.hold -= dt;
    } else {
      // 公交也遵守路口信号：用与 AI 车相同的停车线/黄灯逻辑。
      const fake = {
        route: 'bus', lane: 0, claimed: false, x: s.x, z: s.z, dx: n.dx, dz: n.dz,
        yaw: Math.atan2(n.dx, n.dz), speed: b.speed, curSpeed: b.curSpeed, s: b.t * route.length,
      };
      const target = this._targetSpeed(fake, -1);
      const lambda = target < b.curSpeed ? 7 : 1.8;
      b.curSpeed += (target - b.curSpeed) * (1 - Math.exp(-lambda * dt));
      if (b.curSpeed < 0.02 && target === 0) b.curSpeed = 0;
      b.t = (b.t + (b.curSpeed * dt) / route.length) % 1;
      idx = Math.floor(b.t * 256) % 256;
      s = route.samples[idx];
      n = route.normals[idx];
      if (!b.stopped && Math.abs(s.z - BUS_STOP.z) < 1.6 && s.x > 22) {
        b.stopped = true;
        b.hold = 3.2;
        b.curSpeed = 0;
        // 每一趟都放一批新乘客，而不是整局只触发一次。
        this.onBusStop?.();
      }
      if (b.stopped && Math.abs(s.z - BUS_STOP.z) > 6) b.stopped = false;
    }
    idx = Math.floor(b.t * 256) % 256;
    s = route.samples[idx];
    n = route.normals[idx];
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
    this._writeShadow(12, s.x, s.z, yaw, 1.5, 4.2, 1.225);
    if (this.carShadows) this.carShadows.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------- 玩家载具 API（阶段四） ------------------------- */

  /** 找出离玩家最近的 AI 车（行驶中或停放），只做 O(12) 距离比较。 */
  findNearestCar(point, maxDist = 4.2) {
    if (!point || this._claimed) return null;
    const max2 = maxDist * maxDist;
    let best = null;
    for (let i = 0; i < this._vehicles.length; i++) {
      const v = this._vehicles[i];
      const dx = v.x - point.x, dz = v.z - point.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > max2) continue;
      if (!best || d2 < best.d2) best = { index: i, parked: false, x: v.x, z: v.z, yaw: v.yaw, d2 };
    }
    for (let i = 0; i < this._parked.length; i++) {
      const p = this._parked[i];
      const dx = p.x - point.x, dz = p.z - point.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > max2) continue;
      if (!best || d2 < best.d2) best = { index: i, parked: true, x: p.x, z: p.z, yaw: p.yaw, d2 };
    }
    if (best) best.distance = Math.sqrt(best.d2);
    return best;
  }

  /** 冻结并隐藏一辆 AI 车；返回上车点。 */
  claimCar(candidate) {
    if (!candidate || this._claimed) return null;
    const { index, parked } = candidate;
    if (parked) {
      if (!this._parked[index]) return null;
      const p = this._parked[index];
      this._claimed = { index, parked: true };
      this._hideVehicle(index, true);
      return { index, parked: true, x: p.x, z: p.z, yaw: p.yaw };
    }
    const v = this._vehicles[index];
    if (!v) return null;
    this._claimed = { index, parked: false };
    v.claimed = true;
    this._hideVehicle(index, false);
    return { index, parked: false, x: v.x, z: v.z, yaw: v.yaw };
  }

  /** 交还 AI 车：恢复实例矩阵并让路线继续推进。 */
  releaseCar() {
    if (!this._claimed) return false;
    const { index, parked } = this._claimed;
    this._claimed = null;
    if (parked) {
      this._writeParked();
    } else {
      const v = this._vehicles[index];
      if (v) v.claimed = false;
      this._write(0);
    }
    return true;
  }

  /**
   * 下车时把 AI 车放回玩家停车位置，而不是瞬移回上车点。
   * 行驶车吸附到路线最近采样点（下一帧继续按路线行驶）；停放车直接改车位。
   */
  releaseCarAt(pose) {
    if (!this._claimed || !pose) return this.releaseCar();
    const { index, parked } = this._claimed;
    if (parked) {
      const p = this._parked[index];
      if (p) { p.x = pose.x; p.z = pose.z; p.yaw = pose.yaw; }
      return this.releaseCar();
    }
    const v = this._vehicles[index];
    if (!v) return this.releaseCar();
    const route = this._routes[v.route];
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < route.samples.length; i++) {
      const s = route.samples[i];
      const dx = s.x - pose.x, dz = s.z - pose.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; bestI = i; }
    }
    v.t = bestI / 256;
    v.s = v.t * route.length;
    v.yaw = pose.yaw;
    return this.releaseCar();
  }

  getMovingPose(i) { const v = this._vehicles[i]; return v ? { x: v.x, z: v.z, yaw: v.yaw } : null; }
  getParkedPose(i) { const p = this._parked[i]; return p ? { x: p.x, z: p.z, yaw: p.yaw } : null; }
  setPlayerPose(pose) { this.playerPose = pose || null; }
  getBusPose() {
    const route = this._routes.bus;
    const s = route.samples[Math.floor(this.bus.t * 256) % 256];
    const n = route.normals[Math.floor(this.bus.t * 256) % 256];
    return { x: s.x, z: s.z, yaw: Math.atan2(n.dx, n.dz) };
  }
  get claimedCar() { return this._claimed ? { ...this._claimed } : null; }

  /** 零新增 geometry：复用 AI 车的 box/cylinder 几何，只新增一块车漆材质。 */
  createPlayerCar(color = 0x2f6fa8) {
    if (this._playerCar) return this._playerCar;
    const bodyGeo = this.body.geometry;
    const cabinGeo = this.cabin.geometry;
    const wheelGeo = this.wheels.geometry;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.34, metalness: 0.38 });
    const cabinMat = this.cabin.material;
    this.owned.materials.push(mat);
    const group = new THREE.Group();
    group.name = 'Lobby/player-car';
    const wheels = [];
    const body = new THREE.Mesh(bodyGeo, mat);
    body.scale.set(1, 1, 1);
    body.castShadow = false;
    group.add(body);
    const cabin = new THREE.Mesh(cabinGeo, cabinMat);
    cabin.position.y = 0.525;
    cabin.scale.set(1, 1, 1);
    group.add(cabin);
    for (let w = 0; w < 4; w++) {
      const wheel = new THREE.Mesh(wheelGeo, this.wheels.material);
      wheel.position.set(w % 2 ? 0.46 : -0.46, -0.04, w < 2 ? 0.68 : -0.68);
      group.add(wheel);
      wheels.push({ mesh: wheel, front: w < 2 });
    }
    // 玩家车灯：灯珠 + 地面光斑。只做加法透明，不新增实时点光/聚光灯。
    const lampGeo = new THREE.SphereGeometry(0.11, 5, 4);
    const headMat = new THREE.MeshBasicMaterial({
      color: 0xfff0c2, toneMapped: false, transparent: true, opacity: 0.16,
    });
    const tailMat = new THREE.MeshBasicMaterial({
      color: 0xff352c, toneMapped: false, transparent: true, opacity: 0.16,
    });
    const poolGeo = planeFlat(5.0, 8.2);
    const poolMat = new THREE.MeshBasicMaterial({
      map: this._headPoolMat.map, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: 0xffecc0,
    });
    this.owned.geometries.push(lampGeo, poolGeo);
    this.owned.materials.push(headMat, tailMat, poolMat);
    for (const side of [-1, 1]) {
      const h = new THREE.Mesh(lampGeo, headMat);
      h.position.set(side * 0.34, -0.05, 1.07);
      group.add(h);
      const t = new THREE.Mesh(lampGeo, tailMat);
      t.position.set(side * 0.34, -0.03, -1.07);
      group.add(t);
    }
    const headPool = new THREE.Mesh(poolGeo, poolMat);
    headPool.position.set(0, -0.30, 3.5);
    group.add(headPool);
    const host = this.group.parent || this.group;
    host.add(group);
    group.visible = false;
    this._playerCar = { group, bodyMat: mat, lightMats: [headMat, tailMat], headPool, wheels };
    return this._playerCar;
  }

  _hideVehicle(index, parked) {
    const d = this._dummy;
    const slot = parked ? 10 + index : index;
    d.position.set(0, -100, 0);
    d.rotation.set(0, 0, 0);
    d.scale.set(0.0001, 0.0001, 0.0001);
    d.updateMatrix();
    this.body.setMatrixAt(slot, d.matrix);
    this.cabin.setMatrixAt(slot, d.matrix);
    for (let w = 0; w < 4; w++) this.wheels.setMatrixAt(slot * 4 + w, d.matrix);
    if (!parked) {
      for (let k = 0; k < 2; k++) {
        this.headLamps.setMatrixAt(index * 2 + k, d.matrix);
        this.tailLamps.setMatrixAt(index * 2 + k, d.matrix);
      }
      this.headPools.setMatrixAt(index, d.matrix);
      this.tailPools.setMatrixAt(index, d.matrix);
    }
    if (this.carShadows) {
      d.position.set(0, -200, 0);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(0.0001);
      d.updateMatrix();
      this.carShadows.setMatrixAt(slot, d.matrix);
      this.carShadows.instanceMatrix.needsUpdate = true;
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.wheels.instanceMatrix.needsUpdate = true;
    if (!parked) {
      this.headLamps.instanceMatrix.needsUpdate = true;
      this.tailLamps.instanceMatrix.needsUpdate = true;
      this.headPools.instanceMatrix.needsUpdate = true;
      this.tailPools.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    if (this._playerCar) {
      this._playerCar.group.removeFromParent();
      this._playerCar.group.clear();
      this._playerCar = null;
    }
    this._claimed = null;
  }

  setNight(f) {
    this._headPoolMat.opacity = f * 0.58;
    this._tailPoolMat.opacity = f * 0.36;
    this._headMat.opacity = 0.22 + f * 0.78;
    this._tailMat.opacity = 0.22 + f * 0.78;
  }

  update(dt) {
    this.time += dt;
    this._write(0, dt);
    this._updateBus(dt);
  }

  getStats() {
    return {
      moving: this._vehicles.length,
      parked: this._parked.length,
      bus: 1,
      signalStops: Object.fromEntries(Object.entries(this._routes).map(([k, r]) => [k, r.stops.length])),
    };
  }
}
