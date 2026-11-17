/**
 * tests/verify-metropolis.mjs —— 第一阶段「城市基建与交通大修」验收
 * 覆盖：9 街块→6 建筑 / 3 异形地标 / 9 路口 3D 倒计时信号 /
 *       车辆降密与红灯停车 / 行人斑马线过街 / 活动 NPC / 夜景柔和 /
 *       7 机位 ≤300k / 热路径 Δ0。
 * 运行：node tests/verify-metropolis.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const checks = [];
const errors = [];
const add = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
};

const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
await page.addInitScript(() => {
  const old = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, a) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') {
      a = Object.assign({}, a, { preserveDrawingBuffer: true });
    }
    return old.call(this, t, a);
  };
});
await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
await page.locator('[data-action="start"]').click();
await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });
await page.waitForFunction(() => {
  const a = window.__playground.attractionManager.active;
  return window.__playground.attractionManager.activeKey === 'lobby' && a?._city?.ready;
}, null, { timeout: 60000 });
await page.waitForTimeout(700);

/* ---------- 1. 建筑重组 / 地标 / LOD ---------- */
const struct = await page.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  const city = a._city;
  const lod = a.root.getObjectByName('City/LOD');
  const tri = (obj) => {
    let n = 0;
    obj.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    });
    return n;
  };
  return {
    stats: city.stats,
    buildStats: city.buildings.stats,
    levels: lod?.levels.map((l) => ({ distance: l.distance, tri: tri(l.object) })),
    names: {
      hospitalCross: !!a.root.getObjectByName('City/hospital-cross'),
      schoolTrack: !!a.root.getObjectByName('City/school-track'),
      mallSign: !!a.root.getObjectByName('City/sign-大都会广场'),
      publicWhite: !!a.root.getObjectByName('City/public-white'),
      busStop: !!a.root.getObjectByName('City/bus-stop'),
    },
    road: a.root.userData.districtGrid.road,
  };
});
add('A 9 街块重组为 6 建筑：医院/学校/商场 + 3 异形塔',
  struct.stats.blocks === 9 && struct.stats.buildings === 6 && struct.stats.towers === 3
  && ['hospital', 'school', 'mall', 'cctv', 'spire', 'terrace'].every((r) => struct.buildStats.roles.includes(r)),
  struct.stats);
add('B 医院红十字 / 学校跑道 / 商场玻璃幕墙与招牌齐全',
  struct.buildStats.hospitalCross && struct.buildStats.schoolTrack && struct.buildStats.mallGlass
  && struct.names.hospitalCross && struct.names.schoolTrack && struct.names.mallSign && struct.names.busStop,
  struct.names);
add('C 三级 LOD 面数达标（近 <3k / 中 <1k / 远 <1k）',
  struct.levels?.length === 3 && struct.levels[0].tri < 3000 && struct.levels[1].tri < 1000 && struct.levels[2].tri < 1000,
  struct.levels);
add('D 16m 四车道走廊与设施避让保持', struct.road.width === 13 && struct.road.corridor === 16 && struct.road.lane === 3.25, struct.road);

/* ---------- 2. 信号灯 / 降密 / InstancedMesh ---------- */
const inst = await page.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  const c = a._city;
  const names = [
    'City/cars-body', 'City/cars-cabin', 'City/cars-wheels', 'City/car-head-pools', 'City/car-tail-pools',
    'City/bus-body', 'City/bus-windows', 'City/ped-body', 'City/ped-head', 'City/ped-legs',
    'City/streetlight-pole', 'City/streetlight-arm', 'City/streetlight-head', 'City/streetlight-pools',
    'City/signal-pole', 'City/signal-head', 'City/signal-lamps', 'Lobby/park-actor-body',
  ];
  const counts = c.traffic.getStats();
  return {
    allInstanced: names.every((n) => a.root.getObjectByName(n)?.isInstancedMesh === true),
    chars: names.filter((n) => a.root.getObjectByName(n)?.isInstancedMesh !== true),
    cars: counts,
    pedStats: c.crowd.getStats(),
    parkStats: c.parkActors.getStats(),
    signals: c.signals.stats,
    panels: c.signals.panelMesh?.geometry?.index?.count ?? 0,
    atlas: {
      w: c.signals._atlas?.canvas?.width,
      h: c.signals._atlas?.canvas?.height,
      texture: c.signals._atlas?.tex?.isTexture,
    },
    samples: Object.values(c.traffic._routes).map((r) => r.samples.length),
    stopCounts: counts.signalStops,
  };
});
add('E 车辆 10 行驶 + 2 停放 + 1 公交，行人扩展到五条全城环线',
  inst.cars.moving === 10 && inst.cars.parked === 2 && inst.cars.bus === 1
  && inst.pedStats.total === 35 && inst.pedStats.walkers === 18 && inst.pedStats.hospitalVisitors === 2
  && inst.pedStats.schoolVisitors === 5 && inst.pedStats.mallVisitors === 4,
  { cars: inst.cars, peds: inst.pedStats });
add('F 9 路口 × 4 方向 3D 红绿灯与倒计时图集', inst.signals.intersections === 9 && inst.signals.heads === 36
  && inst.panels === 36 * 6 && inst.atlas.w === 1024 && inst.atlas.texture === true,
{ signals: inst.signals, panels: inst.panels, atlas: inst.atlas });
add('G 车辆/行人/路灯/信号灯/活动 NPC 全部 InstancedMesh',
  inst.allInstanced && inst.chars.length === 0, { missing: inst.chars });
add('H 所有路线预采样 256 点（运行时零曲线求值）', inst.samples.every((n) => n === 256), inst.samples);
add('I 游乐园活动 NPC：2 木马 + 1 火车 + 1 拍照', inst.parkStats.total === 4
  && inst.parkStats.carouselRiders === 2 && inst.parkStats.trainRiders === 1 && inst.parkStats.photographers === 1,
inst.parkStats);

/* ---------- 3. 60s 交通/行人/信号联合仿真 ---------- */
const sim = await page.evaluate(() => {
  const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager, city = a._city;
  sm.camera.position.set(30, 40, 100);
  sm.camera.lookAt(20, 10, 180);
  sm.camera.updateMatrixWorld(true);
  const its = city.signals.intersections;
  const inside = (x, z) => its.some((it) => Math.abs(x - it.x) <= it.halfX && Math.abs(z - it.z) <= it.halfZ);
  const prev = city.traffic._vehicles.map((v) => ({ x: v.x, z: v.z }));
  const violations = [];
  let redEntries = 0, stoppedAtRed = 0, pedWaits = 0, pedRoadChecks = 0, pedRoadBad = 0;
  let minCar = Infinity, minPed = Infinity;
  let carOverlaps = 0;
  const carOverlapSample = [];
  const obbOverlap = (a, b) => {
    const axes = [
      [Math.sin(a.yaw), Math.cos(a.yaw)], [Math.cos(a.yaw), -Math.sin(a.yaw)],
      [Math.sin(b.yaw), Math.cos(b.yaw)], [Math.cos(b.yaw), -Math.sin(b.yaw)],
    ];
    const dx = b.x - a.x, dz = b.z - a.z;
    for (const [ax, az] of axes) {
      const dist = Math.abs(dx * ax + dz * az);
      const ra = 2.15 * Math.abs(Math.sin(a.yaw) * ax + Math.cos(a.yaw) * az)
        + 0.50 * Math.abs(Math.cos(a.yaw) * ax - Math.sin(a.yaw) * az);
      const rb = 2.15 * Math.abs(Math.sin(b.yaw) * ax + Math.cos(b.yaw) * az)
        + 0.50 * Math.abs(Math.cos(b.yaw) * ax - Math.sin(b.yaw) * az);
      if (dist > ra + rb) return false;
    }
    return true;
  };
  const states = new Set();
  const visitors = { seenInside: false, seenOutside: false };
  const sampledFlow = [];
  for (let step = 0; step < 600; step++) {
    city.update(0.1, sm.camera);
    const vs = city.traffic._vehicles;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      const p = prev[i];
      const was = inside(p.x, p.z), now = inside(v.x, v.z);
      if (now && !was) {
        const dx = v.x - p.x, dz = v.z - p.z;
        const axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
        // 每个路口有独立相位，必须按车辆所在路口取灯，不能用全局单一时钟。
        if (city.signals.getVehicleState(axis, v.x, v.z) === 'red') {
          redEntries += 1;
          if (violations.length < 5) violations.push({ kind: 'car-red-entry', i, axis, x: v.x, z: v.z });
        }
      }
      if (v.curSpeed < 0.15 && city.signals.getVehicleState(Math.abs(v.x - 24) < 20 ? 'z' : 'x', v.x, v.z) === 'red') stoppedAtRed += 1;
      prev[i].x = v.x; prev[i].z = v.z;
      for (let j = i + 1; j < vs.length; j++) {
        const d = Math.hypot(v.x - vs[j].x, v.z - vs[j].z);
        if (d > 0.01) minCar = Math.min(minCar, d);
        if (obbOverlap(v, vs[j])) {
          carOverlaps += 1;
          if (carOverlapSample.length < 5) carOverlapSample.push({ t: +city.traffic.time.toFixed(1), i, j, d: +d.toFixed(2) });
        }
      }
    }
    // 行人：过街必须在绿灯窗口；同时记录最小间距
    const ps = city.crowd.peds.filter((p) => p.visible && !p.hidden && (p.kind !== 'alighter' || p.active));
    const pos = ps.map((p) => city.crowd._candidate(p));
    if (city.crowd.getStats().waitingAtLight > 0) pedWaits += 1;
    for (let i = 0; i < pos.length; i++) {
      const p = ps[i], q = pos[i];
      // 中央过街段：x 在机动车道范围内，z 在两条斑马线之间
      if (q.x > 16.05 && q.x < 31.95 && q.z > 118 && q.z < 144) {
        pedRoadChecks += 1;
        if (!city.signals.canPedCross('z', 0.05, q.x, q.z)) pedRoadBad += 1;
      }
      for (let j = i + 1; j < pos.length; j++) {
        const d = Math.hypot(q.x - pos[j].x, q.z - pos[j].z);
        if (d > 0.01) minPed = Math.min(minPed, d);
      }
    }
    for (const p of city.crowd.peds) {
      if (p.kind === 'visitor') {
        if (p.hidden) visitors.seenInside = true;
        else if (Math.hypot(p.x - (-72), p.z - 121) < 6) visitors.seenOutside = true;
      }
    }
    if (step % 10 === 0) {
      for (const act of city.parkActors.actors) states.add(act.state);
      sampledFlow.push({
        t: +(city.traffic.time).toFixed(1),
        z: city.signals.getSnapshot().z.color,
        x: city.signals.getSnapshot().x.color,
      });
    }
  }
  return {
    redEntries, stoppedAtRed, pedWaits, pedRoadChecks, pedRoadBad,
    violations: violations.slice(0, 5),
    carOverlaps, carOverlapSample,
    minCar: +minCar.toFixed(2), minPed: +minPed.toFixed(2),
    parkStates: [...states], visitors,
    signalSnapshot: city.signals.getSnapshot(),
    countdownPixels: (() => {
      const c = city.signals._atlas.ctx.getImageData(0, 0, 1024, 1024).data;
      let lit = 0;
      for (let i = 0; i < c.length; i += 4) if (c[i] + c[i + 1] + c[i + 2] > 180) lit += 1;
      return lit;
    })(),
    flow: sampledFlow,
  };
});
add('J 车辆在红灯前停车，红灯期间 0 次闯入路口', sim.redEntries === 0 && sim.stoppedAtRed > 0,
  { redEntries: sim.redEntries, stoppedAtRed: sim.stoppedAtRed, violations: sim.violations });
add('K 行人只在信号窗口内过街，且会出现路缘等待', sim.pedRoadBad === 0 && sim.pedRoadChecks > 0 && sim.pedWaits > 0,
  { bad: sim.pedRoadBad, checks: sim.pedRoadChecks, waitSamples: sim.pedWaits });
add('L 车辆/行人无互相穿透（车辆 OBB 不相交，人距 >0.5m）', sim.carOverlaps === 0 && sim.minPed > 0.5,
  { carOverlaps: sim.carOverlaps, samples: sim.carOverlapSample, minCar: sim.minCar, minPed: sim.minPed });
add('M 倒计时图集有可读像素，红绿灯状态循环', sim.countdownPixels > 500
  && sim.flow.some((f) => f.z === 'green') && sim.flow.some((f) => f.x === 'green'),
{ litPixels: sim.countdownPixels, states: { z: [...new Set(sim.flow.map((f) => f.z))], x: [...new Set(sim.flow.map((f) => f.x))] } });
add('N 游乐园 NPC 已进入木马/火车/拍照状态', ['ride', 'photo'].every((s) => sim.parkStates.includes(s)) && sim.parkStates.includes('ride'),
  { states: sim.parkStates });
add('O 医院门口访客有进出（隐藏进门 + 门外行走）', sim.visitors.seenInside && sim.visitors.seenOutside, sim.visitors);

/* ---------- 4. 夜景材质 ---------- */
const night = await page.evaluate(() => {
  const pg = window.__playground, a = pg.attractionManager.active, city = a._city;
  pg.dayNightCycle.setMode('night');
  city.night = 1;
  city.base.setNight(1); city.buildings.setNight(1); city.traffic.setNight(1);
  const road = city.base.roadMat.color;
  return {
    road: { r: +road.r.toFixed(3), g: +road.g.toFixed(3), b: +road.b.toFixed(3) },
    mark: +city.base.markMat.color.r.toFixed(3),
    window: city.buildings.materials.glassA.emissiveIntensity,
    farWindow: city.buildings.materials.farMat.emissiveIntensity,
    lampPool: a.root.getObjectByName('City/streetlight-pools')?.material.opacity,
    headPool: a.root.getObjectByName('City/car-head-pools')?.material.opacity,
    tailPool: a.root.getObjectByName('City/car-tail-pools')?.material.opacity,
    headLamp: a.root.getObjectByName('City/car-head-lamps')?.material.opacity,
  };
});
add('P 夜间路面与标线变暗，路灯/车灯形成地面光斑', night.road.r < 0.35 && night.mark < 0.3 && night.lampPool > 0.45 && night.headPool > 0.5 && night.tailPool > 0.3,
  night);
add('Q 窗光柔和不过曝（0.5 < emissive < 1.3）', night.window > 0.5 && night.window < 1.3,
  { window: night.window, far: night.farWindow });

/* ---------- 5. 7 机位 ≤300k ---------- */
const views = await page.evaluate(() => {
  const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager, city = a._city;
  const shots = [
    ['gate', [0, 4, 42], [0, 12, 15]],
    ['overview', [40, 72, 92], [10, 20, 172]],
    ['cityNear', [26, 34, 104], [15, 20, 150]],
    ['signals', [10, 8, 100], [24, 4, 118]],
    ['hospital', [-72, 30, 90], [-60, 18, 135]],
    ['mall', [0, 26, 90], [0, 14, 140]],
    ['south', [0, 16, 30], [0, 2, -10]],
  ];
  const out = {};
  for (const [name, p, t] of shots) {
    sm.camera.position.set(...p);
    sm.camera.lookAt(...t);
    sm.camera.updateMatrixWorld(true);
    city.update(0, sm.camera);
    sm.renderer.render(sm.scene, sm.camera);
    out[name] = {
      triangles: sm.renderer.info.render.triangles,
      calls: sm.renderer.info.render.calls,
      cityVisible: city.visible,
    };
  }
  return out;
});
const maxTris = Math.max(...Object.values(views).map((v) => v.triangles));
const maxCalls = Math.max(...Object.values(views).map((v) => v.calls));
add('R 7 机位全部 ≤300k 三角形（含都会区）', maxTris <= 300000, { maxTris, maxCalls, views });

/* ---------- 6. 热路径 ---------- */
const hot = await page.evaluate(() => {
  const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager, city = a._city;
  const setView = (p, t) => {
    sm.camera.position.set(...p); sm.camera.lookAt(...t); sm.camera.updateMatrixWorld(true);
    city.update(0, sm.camera); sm.renderer.render(sm.scene, sm.camera);
  };
  setView([26, 34, 104], [15, 20, 150]);
  setView([0, 4, 42], [0, 12, 15]);
  const rounds = [];
  for (let i = 0; i < 5; i++) {
    setView([26, 34, 104], [15, 20, 150]);
    setView([0, 4, 42], [0, 12, 15]);
    rounds.push({ ...sm.renderer.info.memory });
  }
  return rounds;
});
const deltas = hot.map((r) => ({ geo: r.geometries - hot[0].geometries, tex: r.textures - hot[0].textures }));
add('S 都会区⇄大门 5 轮热路径 Δgeo/Δtex = 0/0',
  deltas.every((d) => d.geo === 0 && d.tex === 0) && hot.every((r) => r.geometries === hot[0].geometries),
  { steady: hot[0], deltas });

/* ---------- 7. 截图 ---------- */
const shoot = async (name, p, t, mode) => {
  const data = await page.evaluate(({ p, t, mode }) => {
    const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager;
    pg.dayNightCycle.setMode(mode);
    pg.dayNightCycle.applyImmediate();
    const city = a._city;
    city.setNightMode(mode);
    city.night = mode === 'night' ? 1 : 0;
    city.base.setNight(city.night); city.buildings.setNight(city.night); city.traffic.setNight(city.night);
    sm.camera.position.set(...p);
    sm.camera.lookAt(...t);
    sm.camera.updateMatrixWorld(true);
    city.update(0, sm.camera);
    sm.renderer.render(sm.scene, sm.camera);
    return sm.renderer.domElement.toDataURL('image/png').split(',')[1];
  }, { p, t, mode });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
};
await shoot('metropolis-day.png', [55, 68, 80], [10, 20, 170], 'day');
await shoot('metropolis-night.png', [55, 68, 80], [10, 20, 170], 'night');
await shoot('metropolis-close.png', [26, 34, 104], [15, 20, 150], 'day');
await shoot('metropolis-gate.png', [10, 8, 100], [24, 4, 118], 'day');
await shoot('metropolis-signal.png', [32.8, 7.2, 114.2], [32.8, 7.2, 120.2], 'day');
await shoot('metropolis-hospital.png', [-72, 26, 78], [-72, 16, 128], 'day');
await shoot('metropolis-school.png', [52, 22, 82], [52, 10, 128], 'day');
await shoot('metropolis-mall.png', [0, 22, 82], [0, 12, 128], 'day');
await shoot('metropolis-night-road.png', [10, 7, 102], [24, 2, 130], 'night');

const result = {
  phase: 1,
  generatedAt: new Date().toISOString(),
  pass: checks.filter((c) => c.ok).length,
  total: checks.length,
  allPass: checks.every((c) => c.ok) && errors.length === 0,
  maxTris,
  maxCalls,
  checks,
  screenshots: fs.readdirSync(OUT).filter((f) => f.startsWith('metropolis-')).sort(),
  errors,
};
fs.writeFileSync(path.resolve('docs/phase1-city-report.json'), JSON.stringify(result, null, 2));
console.log(`\nCITY PHASE1 ${result.pass}/${result.total} allPass=${result.allPass} maxTris=${maxTris} maxCalls=${maxCalls}`);
console.log(`errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log('  ' + e);
await browser.close();
process.exit(result.allPass ? 0 : 1);
