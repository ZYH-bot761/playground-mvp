/** 定位 Districts/root 在 redline overview 机位下贡献的 calls 来源 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto('http://127.0.0.1:5173/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
await page.locator('[data-action="start"]').click();
await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });
const r = await page.evaluate(() => {
  const pg = window.__playground, sm = pg.sceneManager, r = sm.renderer, cam = sm.camera;
  cam.position.set(0, 30, 34); cam.up.set(0, 1, 0); cam.lookAt(0, 2, 0); cam.fov = 55;
  cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  const measure = () => { const old = r.info.autoReset; r.info.autoReset = false; r.info.reset(); r.render(sm.scene, cam); const o = { calls: r.info.render.calls, tris: r.info.render.triangles }; r.info.autoReset = old; return o; };
  const root = sm.scene.getObjectByName('Districts/root');
  const full = measure();
  root.visible = false;
  const hidden = measure();
  root.visible = true;
  const contributions = [];
  const meshes = [];
  root.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes.push(o); });
  for (const o of meshes) {
    if (!o.visible) continue;
    const saved = o.visible;
    // 逐级向上检查祖先可见性
    let p = o.parent, chainVisible = true;
    while (p && p !== root.parent) { if (p.visible === false) chainVisible = false; p = p.parent; }
    if (!chainVisible) continue;
    o.visible = false;
    const m = measure();
    o.visible = saved;
    const d = full.calls - m.calls;
    if (d > 0) contributions.push({ name: o.name || o.type, calls: d, tris: full.tris - m.triangles, frustumCulled: o.frustumCulled });
  }
  // 俯瞰机位面数
  cam.position.set(30, 84, 96); cam.lookAt(30, 2, 30); cam.updateMatrixWorld(true);
  const view = measure();
  return { full, hidden, self: { calls: full.calls - hidden.calls, tris: full.tris - hidden.triangles }, contributions, meshCount: meshes.length, view };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
