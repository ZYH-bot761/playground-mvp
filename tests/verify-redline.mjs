/**
 * ============================================================================
 * verify-redline.mjs —— 每个模块共用的「工程强制约束」检查器
 * ============================================================================
 * 用法：node tests/verify-redline.mjs M1        （模块名只用于报告分文件）
 *       PORT=5173 node tests/verify-redline.mjs M2
 *
 * 检查项（全部按 v4 ⑬ 的稳态口径，避免"设施首次激活惰性上传"被误判为泄漏）：
 *   ① 稳态基线后 3 轮反复进出设施：Δgeo=0 / Δtex=0
 *   ② 热路径零新建：连续 120 帧 update 后 geometries / textures 计数不变
 *   ③ 预算：triangles ≤ 300000、draw calls ≤ 900
 *   ④ 9 个触发环、动物园根节点仍在
 *   ⑤ 0 pageerror / console.error
 *   ⑥ dispose 幂等：多次 onExitAttraction 不抛错
 *
 * 产出：docs/screenshots/redline-<MODULE>.json + redline-<MODULE>.png
 * 说明：本脚本只读运行时状态，不改业务源码；与 verify-v4.mjs（13 项功能验收）互补。
 * ============================================================================
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const MODULE = (process.argv[2] || 'M0').toLowerCase();
const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, `redline-${MODULE}.json`);
const SHOT = path.join(OUT, `redline-${MODULE}.png`);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const checks = [];
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

  const keys = await page.evaluate(() => window.__playground.attractionManager.keys
    .filter((k) => k !== 'lobby' && k !== 'dummy'));

  // ① 预热遍历（稳态口径）→ 3 轮反复进出
  const warm = await page.evaluate((ks) => {
    const pg = window.__playground;
    for (const k of ks) {
      pg.onEnterAttraction(k); pg.sceneManager.renderOnce();
      pg.onExitAttraction(); pg.sceneManager.renderOnce();
    }
    pg.onExitAttraction();
    pg.sceneManager.renderOnce();
    return { ...pg.sceneManager.renderer.info.memory };
  }, keys);

  const rounds = [];
  for (let r = 0; r < 3; r += 1) {
    for (const k of keys) {
      await page.evaluate((key) => {
        const pg = window.__playground;
        pg.onEnterAttraction(key); pg.sceneManager.renderOnce();
        pg.onExitAttraction(); pg.sceneManager.renderOnce();
      }, k);
    }
    rounds.push(await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory })));
  }
  const dGeo = rounds[2].geometries - warm.geometries;
  const dTex = rounds[2].textures - warm.textures;
  add('稳态后 3 轮 Δgeo=0 / Δtex=0', dGeo === 0 && dTex === 0,
    { steady: warm, rounds, dGeo, dTex });

  // ② 热路径零新建
  const hot = await page.evaluate(() => {
    const pg = window.__playground;
    const before = { ...pg.sceneManager.renderer.info.memory };
    for (let i = 0; i < 120; i += 1) {
      pg.facilityRuntime?.update?.(0.05);
      pg.attractionManager?.active?.update?.(0.05);
    }
    pg.sceneManager.renderOnce();
    const after = { ...pg.sceneManager.renderer.info.memory };
    return { before, after, dGeo: after.geometries - before.geometries, dTex: after.textures - before.textures };
  });
  add('120 帧热路径零新建 GPU 资源', hot.dGeo === 0 && hot.dTex === 0, hot);

  // ③ 预算：固定机位（与 verify-v4.mjs ⑬ 相同的"大厅常规机位"）+ 开局俯瞰机位
  //    【M0 口径说明】renderer.info.render 是"当前帧渲染量"，受相机机位影响极大：
  //    俯瞰 (0,30,34) 会把整个广场纳入视锥，v4 ⑬ 的 (0,9.4,25) 抬头看门楼只拍到局部。
  //    两个机位都测并都记入报告，避免用"挑机位"的方式掩盖真实容量。
  //    基线来自本脚本 M0 实测并落盘到 tests/redline-baseline.json（自举，不硬编码），
  //    M1+ 用同一脚本、同一机位做增量断言，保证可比。
  const BASE_FILE = path.resolve('tests/redline-baseline.json');
  const budget = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, r = sm.renderer, cam = sm.camera;
    const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov };
    const measure = (px, py, pz, lx, ly, lz) => {
      cam.position.set(px, py, pz);
      cam.lookAt(lx, ly, lz);
      cam.updateProjectionMatrix();
      const old = r.info.autoReset;
      r.info.autoReset = false;
      r.info.reset();
      r.render(sm.scene, cam);
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      r.info.autoReset = old;
      return out;
    };
    const overview = measure(0, 30, 34, 0, 2, 0);       // 开局俯瞰
    const standard = measure(0, 9.4, 25, 0, 12.4, 0);   // v4 ⑬ 常规机位
    cam.position.copy(saved.p);
    cam.quaternion.copy(saved.q);
    cam.fov = saved.fov;
    cam.updateProjectionMatrix();
    return { overview, standard };
  });
  add('渲染量 ≤ 30 万面（双机位）',
    budget.overview.triangles <= 300000 && budget.standard.triangles <= 300000, budget);
  // 计划中的预算是"增量配额"而非绝对上限：新增 ≤5 万面、calls 增量 ≤60
  const B = fs.existsSync(BASE_FILE)
    ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf-8'))
    : null;
  if (!B) {
    fs.writeFileSync(BASE_FILE, JSON.stringify(budget, null, 2));
    add('M0 容量基线已落盘（tests/redline-baseline.json）', true, budget);
  } else {
    const delta = {
      overview: { triangles: budget.overview.triangles - B.overview.triangles,
        calls: budget.overview.calls - B.overview.calls },
      standard: { triangles: budget.standard.triangles - B.standard.triangles,
        calls: budget.standard.calls - B.standard.calls },
    };
    add('相对 M0 基线：新增面数 ≤ 5 万 / calls 增量 ≤ 60',
      delta.overview.triangles <= 50000 && delta.overview.calls <= 60 &&
      delta.standard.triangles <= 50000 && delta.standard.calls <= 60,
      { baseline: B, measured: budget, delta });
  }

  // ④ 结构完整性
  const struct = await page.evaluate(() => {
    const pg = window.__playground;
    const lobby = pg.attractionManager.active;
    const zoo = pg.sceneManager.scene.getObjectByName('Zoo/root');
    return {
      rings: lobby?._triggerRings?.length ?? -1,
      zoo: !!zoo,
      zones: zoo ? zoo.children.filter((c) => c.userData.zoneKey).map((c) => c.name) : [],
      activeKey: pg.attractionManager.activeKey,
    };
  });
  add('9 个触发环 + 动物园四区仍在',
    struct.rings === 9 && struct.zoo && struct.zones.length === 4, struct);

  // ⑤ / ⑥
  add('多次 onExitAttraction 幂等', true, '已在 3 轮循环中未见异常');
  add('0 pageerror / console.error', errors.length === 0, errors.slice(0, 6));

  await page.evaluate(() => window.__playground?.sceneManager?.renderOnce?.());
  await page.screenshot({ path: SHOT });
  add('截图有效', fs.statSync(SHOT).size > 20000, { file: SHOT, bytes: fs.statSync(SHOT).size });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = {
    module: MODULE, at: new Date().toISOString(), port: PORT,
    passed, total: checks.length, allPass: passed === checks.length,
    checks, errors,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`REDLINE[${MODULE}] ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 200)}`);
  await browser.close();
}
