/**
 * tests/verify-zoo.mjs —— 网页版动物园可验证验收
 * 运行：node tests/verify-zoo.mjs            （默认 http://localhost:5173）
 *       PORT=5176 node tests/verify-zoo.mjs
 * 产出：docs/screenshots/zoo-*.png + docs/screenshots/zoo-verification.json
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'zoo-verification.json');
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
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    return old.call(this, type, attrs);
  };
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

const shot = async (name) => {
  await page.evaluate(() => window.__playground?.sceneManager?.renderOnce?.());
  const file = path.join(OUT, `zoo-${name}.png`);
  await page.screenshot({ path: file });
  return { file, bytes: fs.statSync(file).size };
};

try {
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const pg = window.__playground;
    const scene = pg.sceneManager.scene;
    const zoo = scene.getObjectByName('Zoo/root');
    const out = { present: !!zoo };
    if (!zoo) return out;
    const zones = zoo.children.filter((c) => c.name.startsWith('Zoo/') && c.userData.zoneKey);
    out.zones = zones.map((z) => z.name);
    const inst = [];
    zoo.traverse((o) => { if (o.isInstancedMesh) inst.push({ name: o.name, count: o.count }); });
    out.instanced = inst;
    out.animalParts = inst.filter((i) => /part-/.test(i.name));
    out.animalCounts = {};
    for (const p of out.animalParts) {
      const k = p.name.split('/')[1];
      out.animalCounts[k] = p.count;
    }
    out.signs = [];
    zoo.traverse((o) => { if (/sign-text|entry-sign/.test(o.name)) out.signs.push(o.name); });
    out.fence = inst.filter((i) => /fence-/.test(i.name)).map((i) => [i.name, i.count]);
    out.water = !!scene.getObjectByName('Zoo/marine_zone/water');
    out.entryArch = !!scene.getObjectByName('Zoo/entry-arch');
    out.zooBtn = !!document.querySelector('[data-role="zoo-visit"]');
    out.triggers = pg.attractionManager.active?._triggerRings?.length ?? -1;
    return out;
  });

  add('动物园根节点挂在 Lobby 场景', info.present, info.present ? 'Zoo/root' : '缺失');
  add('四区 Collection 齐全', info.zones?.length === 4, info.zones);
  add('动物数量 8/4/15/5',
    info.animalCounts?.bird === 8 && info.animalCounts?.reptile === 4 &&
    info.animalCounts?.fish === 15 && info.animalCounts?.mammal === 5,
    info.animalCounts);
  add('围栏 / 标牌 / 水体 / 入口拱门',
    (info.fence?.length === 2) && (info.signs?.length >= 4) && info.water && info.entryArch,
    { fence: info.fence, signs: info.signs?.length, water: info.water, arch: info.entryArch });
  add('HUD 动物园按钮存在', info.zooBtn, info.zooBtn);
  add('既有 9 个触发环未被污染', info.triggers === 9, info.triggers);

  const bootShot = await shot('01-default-view');
  add('默认机位截图有效', bootShot.bytes > 20000, bootShot);

  // 一次性读取动物实例矩阵，稍后对比动画是否真的在动
  const snap = async () => page.evaluate(() => {
    const zoo = window.__playground.sceneManager.scene.getObjectByName('Zoo/root');
    const o = zoo.getObjectByName('Zoo/bird/part-0');
    const f = zoo.getObjectByName('Zoo/fish/part-0');
    const r = zoo.getObjectByName('Zoo/reptile/part-0');
    const m = zoo.getObjectByName('Zoo/mammal/part-0');
    const pick = (im) => Array.from(im.instanceMatrix.array.slice(12, 15)).map((v) => +v.toFixed(4));
    return { bird: pick(o), fish: pick(f), reptile: pick(r), mammal: pick(m) };
  });
  const s0 = await snap();
  await page.evaluate(() => {
    const pg = window.__playground;
    for (let i = 0; i < 60; i += 1) {
      pg.facilityRuntime?.update?.(0.05);
      pg.attractionManager?.active?.update?.(0.05);
    }
    pg.sceneManager?.renderOnce?.();
  });
  const s1 = await snap();
  const moved = Object.keys(s0).filter((k) =>
    s0[k].some((v, i) => Math.abs(v - s1[k][i]) > 0.02));
  add('四类动物在 3s 内均发生位移', moved.length === 4, { before: s0, after: s1, moved });

  // 鱼群不穿出水体：读取 15 条鱼的局部坐标（相对 marine 区中心）
  const fishOK = await page.evaluate(() => {
    const zoo = window.__playground.sceneManager.scene.getObjectByName('Zoo/root');
    const im = zoo.getObjectByName('Zoo/fish/part-0');
    const a = im.instanceMatrix.array;
    let bad = 0;
    let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (let i = 0; i < im.count; i += 1) {
      const b = i * 16;
      const x = a[b + 12] - 45, y = a[b + 13] - 1.1, z = a[b + 14] + 14;
      if (Math.abs(x) > 11.05 || Math.abs(z) > 10.05 || y < 0.5 || y > 2.65) bad += 1;
      min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
      max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
    }
    return { bad, min: min.map((v) => +v.toFixed(2)), max: max.map((v) => +v.toFixed(2)) };
  });
  add('15 条鱼始终在水体内', fishOK.bad === 0, fishOK);

  // 点击「去动物园」→ 平滑飞到俯瞰机位
  await page.locator('[data-role="zoo-visit"]').click();
  await page.evaluate(() => {
    const pg = window.__playground;
    for (let i = 0; i < 30; i += 1) {
      pg.facilityRuntime?.update?.(0.05);
      pg.attractionManager?.active?.update?.(0.05);
    }
    pg.sceneManager?.renderOnce?.();
  });
  const camInfo = await page.evaluate(() => {
    const c = window.__playground.sceneManager.camera;
    const l = window.__playground.attractionManager.active;
    return { cam: [c.position.x, c.position.y, c.position.z].map((v) => +v.toFixed(2)),
      tgt: l._controls?.target ? [l._controls.target.x, l._controls.target.y, l._controls.target.z].map((v) => +v.toFixed(2)) : null,
      btn: document.querySelector('[data-role="zoo-visit"]')?.textContent?.trim() };
  });
  add('一键直达动物园俯瞰机位', Math.abs(camInfo.cam[0] - 60) < 1 && Math.abs(camInfo.cam[2] - 36) < 1, camInfo);
  const zooShot = await shot('02-zoo-overview');
  add('动物园俯瞰截图有效', zooShot.bytes > 20000, zooShot);

  // 三角面预算
  const budget = await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    const r = sm.renderer, old = r.info.autoReset;
    r.info.autoReset = false; r.info.reset();
    r.render(sm.scene, sm.camera);
    const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    r.info.autoReset = old;
    return out;
  });
  add('全场景 ≤30 万三角面', budget.triangles <= 300000, budget);

  // 资源计数 Δ=0（与 verify-v4.mjs ⑬ 同口径：先预热全部设施，再取稳态基线）
  // 【M0 定性】原实现直接把"大厅稳态"当基线，未计入设施首次激活时惰性上传的
  // geometry（嵌入视图按设计常驻），导致 +20 geo 被误判为泄漏。这不是产品 bug，
  // 是验收脚本口径错误。改为 v4 ⑬ 的「预热遍历 → steady → 5 轮」口径。
  const deltas = await page.evaluate(() => {
    const pg = window.__playground;
    const read = () => ({ ...pg.sceneManager.renderer.info.memory });
    const keys = pg.attractionManager.keys.filter((k) => k !== 'lobby' && k !== 'dummy');
    for (const k of keys) {
      pg.onEnterAttraction(k); pg.sceneManager.renderOnce();
      pg.onExitAttraction(); pg.sceneManager.renderOnce();
    }
    pg.onExitAttraction(); pg.sceneManager.renderOnce();
    const steady = read();
    const rounds = [];
    for (let r = 0; r < 5; r += 1) {
      for (const k of keys) {
        pg.onEnterAttraction(k); pg.sceneManager.renderOnce();
        pg.onExitAttraction(); pg.sceneManager.renderOnce();
      }
      rounds.push(read());
    }
    const m = rounds[rounds.length - 1];
    return { steady, rounds, dGeo: m.geometries - steady.geometries, dTex: m.textures - steady.textures };
  });
  add('稳态后 5 轮 Δgeo=0 / Δtex=0', deltas.dGeo === 0 && deltas.dTex === 0, deltas);

  add('0 pageerror / console.error', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { at: new Date().toISOString(), port: PORT, passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`ZOO_VERIFY ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 220)}`);
  await browser.close();
}
