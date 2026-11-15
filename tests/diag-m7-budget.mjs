/**
 * diag-m7-budget.mjs —— M7 预算构成诊断（只读，不改业务源码）
 * 测量三个验收机位的面数，并逐组隐藏以得出各组真实贡献。
 */
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
    const sm = pg.sceneManager, r = sm.renderer, cam = sm.camera;
    const scene = sm.scene;
    const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, up: cam.up.clone() };
    const measure = (px, py, pz, lx, ly, lz) => {
      cam.position.set(px, py, pz); cam.up.set(0, 1, 0); cam.lookAt(lx, ly, lz);
      cam.updateProjectionMatrix();
      const old = r.info.autoReset; r.info.autoReset = false; r.info.reset();
      r.render(scene, cam);
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      r.info.autoReset = old;
      return out;
    };
    const VIEWS = {
      overview: [0, 30, 34, 0, 2, 0],
      standard: [0, 9.4, 25, 0, 12.4, 0],
      castleDir: [0, 9.4, 25, 0, 9, 90],   // 朝向 +z（北侧新区）
    };
    const out = {};
    for (const [name, v] of Object.entries(VIEWS)) out[name] = { full: measure(...v) };

    // 逐组隐藏测贡献（仅 overview）
    const groups = ['Zoo/root', 'Lobby/ground', 'Lobby/gate'];
    out.groups = {};
    for (const gname of groups) {
      const o = scene.getObjectByName(gname);
      if (!o) { out.groups[gname] = 'MISSING'; continue; }
      const prev = o.visible; o.visible = false;
      out.groups[gname] = { hidden: measure(...VIEWS.overview), delta: out.overview.full.triangles - measure(...VIEWS.overview).triangles };
      o.visible = prev;
    }

    // 场景顶层子对象
    out.tops = scene.children.map((c) => c.name || c.type);
    // 动物园面数
    const zoo = scene.getObjectByName('Zoo/root');
    let zooTris = 0; zoo?.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        const f = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
        zooTris += f * (o.isInstancedMesh ? o.count : 1);
      }
    });
    out.zooTris = Math.round(zooTris);

    // 材质/几何/纹理
    out.mem = { ...r.info.memory };

    cam.position.copy(saved.p); cam.quaternion.copy(saved.q); cam.fov = saved.fov; cam.up.copy(saved.up);
    cam.updateProjectionMatrix();
    return out;
  });
  fs.writeFileSync(path.join(OUT, 'diag-m7-budget.json'), JSON.stringify({ data, errors }, null, 2));
  console.log(JSON.stringify({ data, errors }, null, 2));
} catch (err) {
  console.error('FATAL', err?.stack || err);
} finally {
  await browser.close();
}
