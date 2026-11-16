/**
 * tests/verify-m9-farm.mjs —— M9 农家宝专项
 * 运行：node tests/verify-m9-farm.mjs   （需先 npm run dev 起 5173）
 *
 * A 农场结构：detail 含 structure/soil + 5 个 crop InstancedMesh（≥7 子对象）
 * B 几何形态：structure 为合并几何且带顶点色；crop 均为 InstancedMesh
 * C 作物合理：水稻/玉米/小麦 3 主田 + 菜圃叶/果；实例总数 [900, 1050]
 * D 预算：四宫格俯瞰 ≤30 万面；农场隔离 ≤3 万面 / ≤20 calls
 * E 资源台账：预热→3 轮 Δgeo=0 / Δtex=0
 * F 0 pageerror / console.error + 农场近景截图有效
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m9-farm.json');
const SHOT = path.join(OUT, 'zoo-m9-farm.png');
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
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') a = Object.assign({}, a, { preserveDrawingBuffer: true });
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

  // ---------- A/B/C ----------
  const farm = await page.evaluate(() => {
    const scene = window.__playground.sceneManager.scene;
    const detail = scene.getObjectByName('Districts/farm/detail');
    const children = (detail?.children || []).map((c) => ({ name: c.name, instanced: !!c.isInstancedMesh, mesh: !!c.isMesh && !c.isInstancedMesh }));
    const struct = detail?.getObjectByName('Districts/farm/structure');
    const crops = children.filter((c) => c.instanced && c.name.startsWith('Districts/farm/crop-'));
    const info = {};
    let instTotal = 0;
    for (const c of crops) {
      const im = detail.getObjectByName(c.name);
      instTotal += im.count;
      info[c.name.replace('Districts/farm/crop-', '')] = {
        count: im.count,
        rows: im.userData?.rows ?? -1,
        cols: im.userData?.cols ?? -1,
        heightRange: im.userData?.heightRange ?? null,
        map: im.material?.map?.name || null,
        alphaTest: im.material?.alphaTest ?? 0,
        doubleSide: im.material?.side === 2,
      };
    }
    return {
      childCount: detail?.children?.length ?? -1,
      names: children.map((c) => c.name),
      structMerged: !!struct && struct.isMesh && !struct.isInstancedMesh && !!struct.geometry?.attributes?.color,
      structTris: struct?.geometry?.index ? struct.geometry.index.count / 3 : (struct?.geometry?.attributes?.position?.count ?? -1) / 3,
      soil: !!detail?.getObjectByName('Districts/farm/soil'),
      cropCount: crops.length,
      instTotal,
      crops: info,
    };
  });
  const rice = farm.crops.rice;
  const corn = farm.crops.corn;
  const wheat = farm.crops.wheat;
  const veg = [farm.crops['veg-leaves'], farm.crops['veg-fruits']].filter(Boolean);
  const heightOk = (c, lo, hi) => !!c?.heightRange && c.heightRange[0] >= lo && c.heightRange[1] <= hi;
  add('A 农场结构（detail ≥7 子对象）',
    farm.childCount >= 7 && farm.soil && farm.names.includes('Districts/farm/structure'), farm);
  add('B 几何形态（合并+顶点色结构 / 5 作物实例网格）',
    farm.structMerged && farm.cropCount === 5, farm);
  add('C 作物合理（3 主田+菜圃 / 实例 900-1050）',
    farm.cropCount === 5 && farm.instTotal >= 900 && farm.instTotal <= 1050
    && rice && corn && wheat && veg.length === 2
    && heightOk(rice, 1.0, 1.2) && heightOk(corn, 1.8, 2.0) && heightOk(wheat, 0.76, 0.84)
    && rice.rows > 1 && rice.cols > 1 && corn.rows > 1 && corn.cols > 1
    && rice.map && corn.map && wheat.map
    && rice.alphaTest > 0 && rice.doubleSide && corn.doubleSide && wheat.doubleSide,
    farm);

  // ---------- E 资源台账（先做，默认机位剔除 farm → Δ0/0）----------
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

  // ---------- D 预算（隔离农场 LOD 测得真实成本，避免全场景噪声）----------
  const budget = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, r = sm.renderer, cam = sm.camera, scene = sm.scene;
    const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, up: cam.up.clone() };
    const measure = () => {
      cam.position.set(30, 84, 96); cam.up.set(0, 1, 0); cam.lookAt(30, 2, 30);
      cam.updateProjectionMatrix();
      const old = r.info.autoReset; r.info.autoReset = false; r.info.reset();
      r.render(scene, cam);
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      r.info.autoReset = old; return out;
    };
    // 先测全场景四宫格俯瞰总览（含城堡+农场+既有）
    const top = measure();
    // 隔离：隐藏整个场景，仅保留 farm LOD 及其祖先链
    const savedVis = [];
    scene.traverse((o) => { savedVis.push([o, o.visible]); o.visible = false; });
    const lod = scene.getObjectByName('Districts/farm/lod');
    let a = lod; while (a) { a.visible = true; a = a.parent; }
    lod.traverse((o) => { o.visible = true; }); // 还原 farm 子树（detail 及其作物/结构）
    const farmOnly = measure();
    // 还原
    savedVis.forEach(([o, v]) => { o.visible = v; });
    cam.position.copy(saved.p); cam.quaternion.copy(saved.q); cam.fov = saved.fov; cam.up.copy(saved.up);
    cam.updateProjectionMatrix();
    return { top, farmOnly };
  });
  add('D 预算（俯瞰≤30万面 / 农场隔离≤3万面·≤20calls）',
    budget.top.triangles <= 300000 && budget.farmOnly.triangles <= 30000 && budget.farmOnly.calls <= 20,
    budget);

  // ---------- F 报错 + 农场近景截图 ----------
  const shotData = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, cam = sm.camera;
    cam.position.set(48, 14, 88); cam.up.set(0, 1, 0); cam.lookAt(60, 2, 60);
    cam.updateProjectionMatrix(); sm.renderOnce();
    return sm.renderer.domElement.toDataURL('image/png');
  });
  fs.writeFileSync(SHOT, Buffer.from(shotData.split(',')[1], 'base64'));
  const shotBytes = fs.statSync(SHOT).size;
  add('F 0 报错 + 农场近景截图有效', errors.length === 0 && shotBytes > 20000,
    { errors: errors.slice(0, 6), shotBytes });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { module: 'M9', at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M9 ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 240)}`);
  await browser.close();
}
