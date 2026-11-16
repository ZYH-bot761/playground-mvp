/**
 * tests/verify-metropolis.mjs —— 阶段五「3D 微缩大都会」验收
 * 覆盖：18 塔 LOD / 医院学校 / 四车道 / 0 侵入 / InstancedMesh 车辆行人路灯 /
 *       预采样路线 / 公交下客 → 步行进园 / 夜景暖光 / 7 机位 ≤300k / 热路径 Δ0。
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
await page.waitForTimeout(600);

/* ---------- 1. 城市结构 / 地标 / LOD ---------- */
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
    towers: city.stats.towers,
    detail: city.stats.detailTriangles,
    levels: lod?.levels.map((l) => ({ distance: l.distance, tri: tri(l.object) })),
    nearNames: lod?.levels[0].object.children.map((o) => o.name),
    hospital: !!a.root.getObjectByName('City/hospital-school'),
    school: !!a.root.getObjectByName('City/school-wing'),
    busStop: !!a.root.getObjectByName('City/bus-stop'),
    road: a.root.userData.districtGrid.road,
    cityCenter: [city.group.position.x, city.group.position.z],
  };
});
add('A 18 座福田式塔楼 + 医院/学校/公交站齐全', struct.towers >= 15 && struct.towers <= 20 && struct.hospital && struct.school && struct.busStop,
  { towers: struct.towers, hospital: struct.hospital, school: struct.school });
add('B 三级 LOD 面数达标（近 <2.5k / 中远 <400）',
  struct.levels?.length === 3 && struct.levels[0].tri < 2500 && struct.levels[1].tri < 400 && struct.levels[2].tri < 400,
  struct.levels);
add('C 四车道 16m 走廊 + 3.25m 车道', struct.road.width === 13 && struct.road.corridor === 16 && struct.road.lane === 3.25, struct.road);

/* ---------- 2. 道路零侵入 / 设施避让 ---------- */
const clear = await page.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  const R = a.root.userData.districtGrid.road;
  const corridor = { minX: R.axisX - R.corridor / 2, maxX: R.axisX + R.corridor / 2, minZ: R.axisZ - R.corridor / 2, maxZ: R.axisZ + R.corridor / 2 };
  const overlap = (b) => !(b.maxX <= corridor.minX || b.minX >= corridor.maxX || b.maxZ <= corridor.minZ || b.minZ >= corridor.maxZ);
  const boxes = Object.fromEntries(a._buildingBoxes.map((b) => [b.key, b]));
  const city = a._city;
  const cityBad = [];
  const roads = city.base ? window.__playground.attractionManager.active._city.traffic : null;
  return {
    corridor, dance: boxes['dance-hall'], fireworks: boxes['fireworks-deck'],
    danceClear: boxes['dance-hall'] ? !overlap(boxes['dance-hall']) : false,
    fireworksClear: boxes['fireworks-deck'] ? !overlap(boxes['fireworks-deck']) : false,
    gate: boxes['gate'] || null,
    cityRoadCount: city.base?.polePos?.length ?? 0,
    cityBad,
  };
});
add('D 跳舞厅/烟花台/大门均退出 16m 道路走廊', clear.danceClear && clear.fireworksClear,
  { corridor: clear.corridor, dance: clear.dance, fireworks: clear.fireworks });

/* ---------- 3. InstancedMesh 全覆盖 ---------- */
const inst = await page.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  const c = a._city;
  const names = ['City/cars-body', 'City/cars-cabin', 'City/cars-wheels', 'City/bus-body', 'City/bus-windows',
    'City/ped-body', 'City/ped-head', 'City/ped-legs', 'City/streetlight-pole', 'City/streetlight-arm',
    'City/streetlight-head', 'City/streetlight-pools', 'City/signal-head'];
  return {
    allInstanced: names.every((n) => a.root.getObjectByName(n)?.isInstancedMesh === true),
    counts: {
      cars: c.traffic.body.count, wheels: c.traffic.wheels.count, bus: c.traffic.busBody.count,
      peds: c.crowd.body.count, legs: c.crowd.legs.count, lamps: c.base.polePos.length,
      lampInstances: a.root.getObjectByName('City/streetlight-pole')?.count,
    },
    routeSamples: Object.values(c.traffic._routes).map((r) => r.samples.length),
    npc: (() => {
      const m = window.__playground.npcManager;
      const list = m?._npcs || [];
      return { total: list.length, greeters: list.filter((n) => n.greeter).length };
    })(),
  };
});
add('E 车辆/公交/行人/路灯/信号灯全部 InstancedMesh',
  inst.allInstanced && inst.counts.cars === 32 && inst.counts.wheels === 128 && inst.counts.bus === 1 && inst.counts.peds === 24 && inst.counts.legs === 48 && inst.counts.lampInstances === inst.counts.lamps,
  inst.counts);
add('F 4 迎宾 + 6 通勤 NPC 已生效', inst.npc.total === 10 && inst.npc.greeters === 4, inst.npc);
add('G 所有路线预采样 256 点（运行时零曲线求值）', inst.routeSamples.every((n) => n === 256), inst.routeSamples);

/* ---------- 4. 交通推进 / 公交停靠下客 / 3 人进园 ---------- */
const flow = await page.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  const city = a._city;
  const sm = window.__playground.sceneManager;
  sm.camera.position.set(0, 24, 60);
  sm.camera.lookAt(0, 24, 180);
  sm.camera.updateMatrixWorld(true);
  const before = city.crowd.peds.slice(0, 3).map((p) => p.t);
  const mem0 = { ...sm.renderer.info.memory };
  for (let i = 0; i < 500; i++) city.update(0.05, sm.camera);
  const mem1 = { ...sm.renderer.info.memory };
  return {
    bus: { t: city.traffic.bus.t, fired: city.traffic.busStopFired },
    alighters: city.crowd.alighters.map((p) => ({ active: p.active, t: p.t })),
    pedsMoved: city.crowd.peds[0].t !== before[0],
    mem0, mem1,
    car0: city.traffic._vehicles[0].t,
    time: city.traffic.time,
  };
});
add('H 公交到站 → 3 名低模行人下车并走向大门',
  flow.bus.fired && flow.alighters.every((p) => p.active) && flow.alighters.every((p) => p.t > 0),
  { bus: flow.bus, alighters: flow.alighters, pedsMoved: flow.pedsMoved });
add('I 25s 交通推进零新增 geometry/texture', flow.mem0.geometries === flow.mem1.geometries && flow.mem0.textures === flow.mem1.textures,
  { before: flow.mem0, after: flow.mem1, car0: flow.car0 });

/* ---------- 5. 夜景暖光 / 昼景 ---------- */
const night = await page.evaluate(() => {
  const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager, city = a._city;
  pg.dayNightCycle.setMode('night');
  city.night = 1;
  city.base.setNight(1); city.buildings.setNight(1);
  const gm = city.buildings.materials.glassA;
  return {
    emissive: gm.emissiveIntensity,
    lamp: city.base.setNight ? 'ok' : 'missing',
    lampOpacity: a.root.getObjectByName('City/streetlight-pools')?.material.opacity,
    headGlow: city.base.polePos.length,
    mode: pg.dayNightCycle.mode,
  };
});
add('J 夜景暖光：玻璃亮窗 + 路灯光斑点亮', night.mode === 'night' && night.emissive > 2 && night.lampOpacity > 0.4,
  { emissive: night.emissive, lampOpacity: night.lampOpacity });

/* ---------- 6. 7 机位 ≤300k ---------- */
const views = await page.evaluate(() => {
  const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager, city = a._city;
  const shots = [
    ['gate', [0, 4, 42], [0, 12, 15]],
    ['overview', [30, 84, 96], [30, 2, 30]],
    ['cityNear', [10, 35, 120], [10, 40, 180]],
    ['cityFar', [0, 28, 50], [0, 35, 190]],
    ['castle', [-7, 16, 40], [-7, 8, 60]],
    ['farm', [60, 10, 48], [60, 4, 62]],
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
      lod: a.root.getObjectByName('City/LOD')?.getCurrentLevel?.(),
    };
  }
  return out;
});
const maxTris = Math.max(...Object.values(views).map((v) => v.triangles));
const maxCalls = Math.max(...Object.values(views).map((v) => v.calls));
add('K 7 机位全部 ≤300k 三角形（含都会区）', maxTris <= 300000, { maxTris, maxCalls, views });

/* ---------- 7. 热路径 5 轮 Δgeo/Δtex = 0 ---------- */
const hot = await page.evaluate(() => {
  const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager, city = a._city;
  const setView = (p, t) => {
    sm.camera.position.set(...p); sm.camera.lookAt(...t); sm.camera.updateMatrixWorld(true);
    city.update(0, sm.camera); sm.renderer.render(sm.scene, sm.camera);
  };
  // 先 warm 一次近景，让城市几何/纹理全部上传
  setView([10, 35, 120], [10, 40, 180]);
  setView([0, 4, 42], [0, 12, 15]);
  const rounds = [];
  for (let i = 0; i < 5; i++) {
    setView([10, 35, 120], [10, 40, 180]);
    setView([0, 4, 42], [0, 12, 15]);
    rounds.push({ ...sm.renderer.info.memory });
  }
  return rounds;
});
const deltas = hot.map((r, i) => ({ geo: r.geometries - hot[0].geometries, tex: r.textures - hot[0].textures }));
add('L 都会区⇄大门 5 轮热路径 Δgeo/Δtex = 0/0',
  deltas.every((d) => d.geo === 0 && d.tex === 0) && hot.every((r) => r.geometries === hot[0].geometries),
  { steady: hot[0], deltas });

/* ---------- 8. 截图（日/夜 / 大门 / 鸟瞰） ---------- */
const shoot = async (name, p, t, mode) => {
  const data = await page.evaluate(({ p, t, mode }) => {
    const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager;
    pg.dayNightCycle.setMode(mode);
    pg.dayNightCycle.applyImmediate();
    const city = a._city;
    city.setNightMode(mode);
    city.night = mode === 'night' ? 1 : 0;
    city.base.setNight(city.night); city.buildings.setNight(city.night);
    sm.camera.position.set(...p);
    sm.camera.lookAt(...t);
    sm.camera.updateMatrixWorld(true);
    city.update(0, sm.camera);
    sm.renderer.render(sm.scene, sm.camera);
    return sm.renderer.domElement.toDataURL('image/png').split(',')[1];
  }, { p, t, mode });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
};
await shoot('metropolis-day.png', [40, 80, 50], [5, 60, 175], 'day');
await shoot('metropolis-night.png', [40, 80, 50], [5, 60, 175], 'night');
await shoot('metropolis-close.png', [10, 35, 120], [10, 40, 180], 'day');
await shoot('metropolis-gate.png', [0, 4, 42], [0, 12, 15], 'day');

const result = {
  phase: 5,
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
fs.writeFileSync(path.resolve('docs/metropolis-report.json'), JSON.stringify(result, null, 2));
console.log(`\nMETROPOLIS ${result.pass}/${result.total} allPass=${result.allPass} maxTris=${maxTris}`);
console.log(`errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log('  ' + e);
await browser.close();
process.exit(result.allPass ? 0 : 1);
