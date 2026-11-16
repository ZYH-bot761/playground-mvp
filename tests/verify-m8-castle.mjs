/**
 * tests/verify-m8-castle.mjs —— M8 童话公主风城堡园专项
 * 运行：node tests/verify-m8-castle.mjs   （需先 npm run dev 起 5173）
 *
 * A 城堡结构：detail 含 body/walls/roof/gate/windows/finials/flags/lights（8 子对象）
 * B 几何形态：body/roof 为合并几何且带顶点色；windows/finials 为 InstancedMesh
 * C 体量合理：body 几何三角面在 [500, 4000]，窗户实例数 [60, 220]
 * D 预算：四宫格俯瞰 ≤30 万面；城堡自身增量 ≤1.2 万面 / ≤20 calls
 * E 资源台账：预热→3 轮 Δgeo=0 / Δtex=0（城堡在 redline 机位被剔除，不计入 Δ）
 * F 0 pageerror / console.error + 城堡近景截图有效
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m8-castle.json');
const SHOT = path.join(OUT, 'zoo-m8-castle.png');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const errors = [];
const add = (n, ok, d) => checks.push({ name: n, pass: !!ok, detail: d });

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

  // ---------- A/B/C 结构与几何 ----------
  const castle = await page.evaluate(() => {
    const scene = window.__playground.sceneManager.scene;
    const detail = scene.getObjectByName('Districts/castle/detail');
    const names = (detail?.children || []).map((c) => c.name);
    const byName = (n) => detail?.getObjectByName(n);
    const body = byName('Districts/castle/body');
    const roof = byName('Districts/castle/roof');
    const wins = byName('Districts/castle/windows');
    const fins = byName('Districts/castle/finials');
    const gate = byName('Districts/castle/gate');
    const tri = (g) => g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ? g.attributes.position.count / 3 : -1);
    return {
      childCount: detail?.children?.length ?? -1,
      names,
      body: { isMerged: !!body && body.isMesh && !body.isInstancedMesh, hasColor: !!body?.geometry?.attributes?.color, tris: tri(body?.geometry) },
      roof: { isMerged: !!roof && roof.isMesh && !roof.isInstancedMesh, hasColor: !!roof?.geometry?.attributes?.color, tris: tri(roof?.geometry) },
      wins: { isInstanced: !!wins?.isInstancedMesh, count: wins?.count ?? -1 },
      fins: { isInstanced: !!fins?.isInstancedMesh, count: fins?.count ?? -1 },
      gate: !!gate,
    };
  });
  add('A 城堡结构（detail 含 8 子对象）',
    castle.childCount >= 8 && castle.names.includes('Districts/castle/body')
    && castle.names.includes('Districts/castle/roof') && castle.names.includes('Districts/castle/windows')
    && castle.names.includes('Districts/castle/finials') && castle.names.includes('Districts/castle/gate')
    && castle.names.includes('Districts/castle/flags') && castle.names.includes('Districts/castle/lights'),
    castle);
  add('B 几何形态（合并+顶点色 / 实例窗与宝珠）',
    castle.body.isMerged && castle.body.hasColor && castle.roof.isMerged && castle.roof.hasColor
    && castle.wins.isInstanced && castle.fins.isInstanced, castle);
  add('C 体量合理（body 500-4000 面 / 窗 60-220）',
    castle.body.tris >= 500 && castle.body.tris <= 4000 && castle.wins.count >= 60 && castle.wins.count <= 220,
    { bodyTris: castle.body.tris, winCount: castle.wins.count, finCount: castle.fins.count });

  // ---------- E 资源台账（先做，默认机位剔除城堡 → Δ0/0）----------
  const keys = await page.evaluate(() => window.__playground.attractionManager.keys
    .filter((k) => k !== 'lobby' && k !== 'dummy'));
  await page.evaluate((ks) => {
    const pg = window.__playground;
    for (const k of ks) { pg.onEnterAttraction(k); pg.sceneManager.renderOnce(); pg.onExitAttraction(); pg.sceneManager.renderOnce(); }
    pg.onExitAttraction(); pg.sceneManager.renderOnce();
  }, keys);
  const steady = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
  const rounds = [];
  for (let r = 0; r < 3; r += 1) {
    for (const k of keys) {
      await page.evaluate((key) => {
        const pg = window.__playground;
        pg.onEnterAttraction(key); pg.sceneManager.renderOnce(); pg.onExitAttraction(); pg.sceneManager.renderOnce();
      }, k);
    }
    rounds.push(await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory })));
  }
  const dGeo = rounds[2].geometries - steady.geometries;
  const dTex = rounds[2].textures - steady.textures;
  add('E 稳态 3 轮 Δgeo=0 / Δtex=0', dGeo === 0 && dTex === 0, { steady, rounds, dGeo, dTex });

  // ---------- D 预算（四宫格俯瞰：城堡可见）----------
  const budget = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, r = sm.renderer, cam = sm.camera;
    const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, up: cam.up.clone() };
    const measure = (px, py, pz, lx, ly, lz) => {
      cam.position.set(px, py, pz); cam.up.set(0, 1, 0); cam.lookAt(lx, ly, lz);
      cam.updateProjectionMatrix();
      const old = r.info.autoReset; r.info.autoReset = false; r.info.reset();
      r.render(sm.scene, cam);
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      r.info.autoReset = old; return out;
    };
    const top = measure(30, 84, 96, 30, 2, 30); // 四宫格俯瞰
    // 城堡自身增量：显隐整个城堡 LOD（detail.visible 会被 render 的 LOD.update 覆盖，
    // 故直接切 LOD 根可见性以测得真实增量）
    const lod = sm.scene.getObjectByName('Districts/castle/lod');
    const prev = lod.visible; lod.visible = false;
    const hidden = measure(30, 84, 96, 30, 2, 30);
    lod.visible = prev;
    cam.position.copy(saved.p); cam.quaternion.copy(saved.q); cam.fov = saved.fov; cam.up.copy(saved.up);
    cam.updateProjectionMatrix();
    return { top, self: { calls: top.calls - hidden.calls, triangles: top.triangles - hidden.triangles } };
  });
  add('D 预算（俯瞰≤30万面 / 城堡增量≤1.2万面·≤20calls）',
    budget.top.triangles <= 300000 && budget.self.triangles <= 12000 && budget.self.calls <= 20,
    budget);

  // ---------- F 报错 + 城堡近景截图（同步 renderOnce + toDataURL）----------
  const shotData = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, cam = sm.camera;
    // 规范 3/4 正视角（南偏东、抬高），避免低角度直视背面造成的塔顶透视重叠假象
    cam.position.set(34, 26, 98); cam.up.set(0, 1, 0); cam.lookAt(0, 12, 60);
    cam.updateProjectionMatrix(); sm.renderOnce();
    return sm.renderer.domElement.toDataURL('image/png');
  });
  fs.writeFileSync(SHOT, Buffer.from(shotData.split(',')[1], 'base64'));
  const shotBytes = fs.statSync(SHOT).size;
  add('F 0 报错 + 城堡近景截图有效', errors.length === 0 && shotBytes > 20000,
    { errors: errors.slice(0, 6), shotBytes });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { module: 'M8', at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M8 ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 240)}`);
  await browser.close();
}
