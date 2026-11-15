/** diag-m7-quick.mjs —— M7 快速结构+预算诊断 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
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
    const sm = pg.sceneManager, r = sm.renderer, cam = sm.camera, scene = sm.scene;
    const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, up: cam.up.clone() };
    const mod = window.__m7Grid;
    const root = scene.getObjectByName('Districts/root');
    const measure = (px, py, pz, lx, ly, lz) => {
      cam.position.set(px, py, pz); cam.up.set(0, 1, 0); cam.lookAt(lx, ly, lz);
      cam.updateProjectionMatrix();
      const old = r.info.autoReset; r.info.autoReset = false; r.info.reset();
      r.render(scene, cam);
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      r.info.autoReset = old; return out;
    };
    const overview = measure(0, 30, 34, 0, 2, 0);
    const standard = measure(0, 9.4, 25, 0, 12.4, 0);
    // 结构
    const structure = root?.getObjectByName('Districts/structure');
    const lods = [];
    root?.traverse((o) => { if (o.isLOD) lods.push({ name: o.name, levels: o.levels.length,
      detailChildren: o.levels[0]?.object?.children?.length ?? -1 }); });
    // 分组预算贡献
    const hideMeasure = (names) => {
      const objs = names.map((n) => scene.getObjectByName(n)).filter(Boolean);
      const vis = objs.map((o) => o.visible);
      objs.forEach((o) => { o.visible = false; });
      const m = measure(0, 30, 34, 0, 2, 0);
      objs.forEach((o, i) => { o.visible = vis[i]; });
      return m;
    };
    let noDistrict = null, parts = {};
    if (root) {
      const p = root.visible; root.visible = false;
      noDistrict = measure(0, 30, 34, 0, 2, 0); root.visible = p;
      parts.withoutStructure = hideMeasure(['Districts/structure']);
      parts.withoutCastle = hideMeasure(['Districts/castle']);
      parts.withoutFarm = hideMeasure(['Districts/farm']);
      // LOD detail 单独测（强制把 detail level 设为当前）
      const castleLod = scene.getObjectByName('Districts/castle/lod');
      const farmLod = scene.getObjectByName('Districts/farm/lod');
      parts.lodLevels = { castle: castleLod?.getCurrentLevel?.(), farm: farmLod?.getCurrentLevel?.() };
    }
    // 四宫格常量（从 root.userData）
    const grid = root?.userData?.districtGrid;
    cam.position.copy(saved.p); cam.quaternion.copy(saved.q); cam.fov = saved.fov; cam.up.copy(saved.up);
    cam.updateProjectionMatrix();
    return {
      rootExists: !!root, structureCount: structure?.count ?? -1, lods,
      overview, standard, noDistrict, parts,
      grid: grid ? { center: grid.center, outer: grid.outer, quads: Object.fromEntries(
        Object.entries(grid.quadrants).map(([k, v]) => [k, { cx: v.cx, cz: v.cz, content: v.content }])) } : null,
      mem: { ...r.info.memory },
    };
  });
  fs.writeFileSync(path.join(OUT, 'diag-m7-quick.json'), JSON.stringify({ data, errors }, null, 2));
  console.log(JSON.stringify({ data, errors }, null, 2));
} catch (err) {
  console.error('FATAL', err?.stack || err);
} finally { await browser.close(); }
