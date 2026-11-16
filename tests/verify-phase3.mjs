/**
 * tests/verify-phase3.mjs —— 阶段三验收：城堡群 / 农家宝 / 材质光影
 * 运行：node tests/verify-phase3.mjs（需先 npm run dev）
 *
 * 覆盖：
 *  A 城堡群 8 塔、合并几何 + InstancedMesh、昼夜窗光
 *  B 农场三主田 + 菜圃、行列实例、叶片双面/alpha、株高区间
 *  C 五机位三角面 ≤300,000（俯瞰 / 城堡 / 农场 / redline / standard）
 *  D 城堡/农场自身增量与 draw call 结构
 *  E 5 轮进出城堡区/农家宝：Δgeo=0 / Δtex=0
 *  F 0 报错 + 白天/夜晚/玉米地截图
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-phase3.json');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const errors = [];
const add = (name, ok, detail) => checks.push({ name, pass: !!ok, detail });

const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  const old = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, a) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') {
      a = Object.assign({}, a, { preserveDrawingBuffer: true });
    }
    return old.call(this, t, a);
  };
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

try {
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });

  const data = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager;
    const r = sm.renderer;
    const cam = sm.camera;
    const scene = sm.scene;
    const districts = pg.attractionManager.active?._districts || null;
    const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), up: cam.up.clone(), fov: cam.fov };
    const views = {
      overview: [30, 84, 96, 30, 2, 30],
      castle: [34, 26, 98, 0, 12, 60],
      farm: [48, 14, 88, 60, 2, 60],
      redline: [0, 30, 34, 0, 2, 0],
      standard: [0, 9.4, 25, 0, 12.4, 0],
    };
    const measure = (v, cull = true) => {
      cam.position.set(v[0], v[1], v[2]);
      cam.up.set(0, 1, 0);
      cam.lookAt(v[3], v[4], v[5]);
      cam.updateProjectionMatrix();
      if (cull) districts?.update(cam);
      const old = r.info.autoReset;
      r.info.autoReset = false;
      r.info.reset();
      r.render(scene, cam);
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      r.info.autoReset = old;
      return out;
    };

    const budget = {};
    for (const [k, v] of Object.entries(views)) budget[k] = measure(v);

    const self = {};
    for (const key of ['castle', 'farm']) {
      const top = measure(views.overview);
      const lod = scene.getObjectByName(`Districts/${key}/lod`);
      const prev = lod.visible;
      lod.visible = false;
      const hidden = measure(views.overview, false);
      lod.visible = prev;
      self[key] = { calls: top.calls - hidden.calls, triangles: top.triangles - hidden.triangles };
    }

    const info = (node) => (node?.children || []).map((c) => ({
      name: c.name,
      isMesh: !!c.isMesh,
      isInstanced: !!c.isInstancedMesh,
      count: c.count ?? null,
      castShadow: c.castShadow,
      tris: c.geometry?.index ? c.geometry.index.count / 3 : (c.geometry?.attributes?.position?.count || 0) / 3,
    }));
    const castle = scene.getObjectByName('Districts/castle/detail');
    const farm = scene.getObjectByName('Districts/farm/detail');
    const castleBody = scene.getObjectByName('Districts/castle/body');
    const castleRoof = scene.getObjectByName('Districts/castle/roof');
    const castleWindows = scene.getObjectByName('Districts/castle/windows');
    const castleInfo = castle?.userData?.castle || null;
    const crops = ['rice', 'corn', 'wheat', 'veg-leaves', 'veg-fruits'].map((k) => {
      const im = scene.getObjectByName(`Districts/farm/crop-${k}`);
      return im ? {
        name: k,
        isInstanced: !!im.isInstancedMesh,
        count: im.count,
        heightRange: im.userData?.heightRange || null,
        rows: im.userData?.rows ?? null,
        cols: im.userData?.cols ?? null,
        rowGap: im.userData?.rowGap ?? null,
        colGap: im.userData?.colGap ?? null,
        hasMap: !!im.material?.map,
        alphaTest: im.material?.alphaTest ?? null,
        doubleSide: im.material?.side === 2,
      } : { name: k, missing: true };
    });

    // 夜间窗光
    pg.dayNightCycle.setMode('night');
    pg.dayNightCycle.applyImmediate();
    const night = {
      mode: pg.dayNightCycle.mode,
      windowIntensity: castleWindows?.material?.emissiveIntensity ?? null,
      exposure: r.toneMappingExposure,
    };
    pg.dayNightCycle.setMode('day');
    pg.dayNightCycle.applyImmediate();

    // 5 轮进出城堡区/农家宝
    for (const v of Object.values(views)) measure(v);
    const steady = { ...r.info.memory };
    const rounds = [];
    for (let i = 0; i < 5; i += 1) {
      measure(views.overview);
      measure(views.castle);
      measure(views.farm);
      measure(views.overview);
      rounds.push({ ...r.info.memory });
    }
    const dGeo = rounds[4].geometries - steady.geometries;
    const dTex = rounds[4].textures - steady.textures;

    cam.position.copy(saved.p); cam.quaternion.copy(saved.q); cam.up.copy(saved.up); cam.fov = saved.fov;
    cam.updateProjectionMatrix();

    return {
      budget, self, night,
      castle: {
        childCount: castle?.children?.length ?? -1,
        children: info(castle),
        body: { hasColor: !!castleBody?.geometry?.attributes?.color, tris: info(castle).find((c) => c.name.endsWith('/body'))?.tris },
        roof: { hasColor: !!castleRoof?.geometry?.attributes?.color },
        windows: { isInstanced: !!castleWindows?.isInstancedMesh, count: castleWindows?.count ?? -1 },
        meta: castleInfo,
      },
      farm: { childCount: farm?.children?.length ?? -1, children: info(farm), crops },
      memory: { steady, rounds, dGeo, dTex },
    };
  });

  const { budget, self, night, castle, farm, memory } = data;

  add('A 城堡群 8 塔 + 合并几何 + 实例窗',
    castle.childCount === 8
    && castle.meta?.towerCount === 8
    && castle.body.hasColor && castle.roof.hasColor
    && castle.windows.isInstanced && castle.windows.count >= 60 && castle.windows.count <= 220
    && castle.children.filter((c) => c.isMesh && !c.isInstanced).length <= 6,
    { childCount: castle.childCount, meta: castle.meta, windows: castle.windows });

  const rice = farm.crops.find((c) => c.name === 'rice');
  const corn = farm.crops.find((c) => c.name === 'corn');
  const wheat = farm.crops.find((c) => c.name === 'wheat');
  const veg = farm.crops.filter((c) => c.name.startsWith('veg'));
  const hOk = (c, lo, hi) => c?.heightRange && c.heightRange[0] >= lo && c.heightRange[1] <= hi;
  add('B 三主田 + 菜圃：高度/行列/双面叶片',
    farm.childCount >= 7
    && rice?.isInstanced && corn?.isInstanced && wheat?.isInstanced
    && hOk(rice, 1.0, 1.2) && hOk(corn, 1.8, 2.0) && hOk(wheat, 0.76, 0.84)
    && rice.rows > 1 && rice.cols > 1 && corn.rows > 1 && corn.cols > 1
    && rice.hasMap && corn.hasMap && wheat.hasMap
    && rice.doubleSide && corn.doubleSide && wheat.doubleSide
    && veg.length === 2,
    { rice, corn, wheat, veg, childCount: farm.childCount });

  const viewsOk = Object.entries(budget).every(([, v]) => v.triangles <= 300000);
  add('C 五机位三角面 ≤300,000', viewsOk, budget);
  add('D 城堡/农场自身增量与 draw call 结构',
    self.castle.calls <= 20 && self.castle.triangles <= 12000
    && self.farm.calls <= 20 && self.farm.triangles <= 30000,
    self);
  add('E 5 轮进出 Δgeo=0 / Δtex=0',
    memory.dGeo === 0 && memory.dTex === 0
    && memory.rounds.every((x) => x.geometries === memory.steady.geometries && x.textures === memory.steady.textures),
    memory);
  add('F 夜间窗光 + 0 报错',
    night.windowIntensity >= 1.8 && night.exposure < 1 && errors.length === 0,
    { night, errors: errors.slice(0, 6) });

  // ---------- 截图 ----------
  const shot = async (name, v, nightMode = false) => {
    const dataUrl = await page.evaluate(({ v, nightMode }) => {
      const pg = window.__playground;
      const sm = pg.sceneManager;
      const cam = sm.camera;
      const districts = pg.attractionManager.active?._districts;
      if (nightMode) { pg.dayNightCycle.setMode('night'); pg.dayNightCycle.applyImmediate(); }
      else { pg.dayNightCycle.setMode('day'); pg.dayNightCycle.applyImmediate(); }
      cam.position.set(v[0], v[1], v[2]);
      cam.up.set(0, 1, 0);
      cam.lookAt(v[3], v[4], v[5]);
      cam.updateProjectionMatrix();
      districts?.update(cam);
      sm.renderOnce();
      return sm.renderer.domElement.toDataURL('image/png');
    }, { v, nightMode });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  };
  await shot('phase3-overview.png', [30, 84, 96, 30, 2, 30]);
  await shot('phase3-castle-day.png', [34, 26, 98, 0, 12, 60], false);
  await shot('phase3-castle-night.png', [34, 26, 98, 0, 12, 60], true);
  await shot('phase3-farm-day.png', [48, 14, 88, 60, 2, 60], false);
  await shot('phase3-farm-corn.png', [72, 2.0, 64, 72, 2.0, 54], false);

  const shotSizes = ['phase3-overview.png', 'phase3-castle-day.png', 'phase3-castle-night.png', 'phase3-farm-day.png', 'phase3-farm-corn.png']
    .map((f) => ({ f, bytes: fs.statSync(path.join(OUT, f)).size }));
  add('G 截图有效', shotSizes.every((s) => s.bytes > 20000), shotSizes);

  const passed = checks.filter((c) => c.pass).length;
  const report = { module: 'Phase3', at: new Date().toISOString(), passed, total: checks.length, allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`Phase3 ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 320)}`);
} catch (err) {
  const report = { module: 'Phase3', at: new Date().toISOString(), passed: 0, total: 1, allPass: false, checks: [{ name: '脚本执行', pass: false, detail: String(err?.stack || err) }], errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('FATAL', String(err?.stack || err));
  console.log(errors);
} finally {
  await browser.close();
}
