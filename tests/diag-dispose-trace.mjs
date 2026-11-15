/**
 * diag-dispose-trace.mjs —— 诊断 v4 ⑬ Δgeo=-5 的根因
 * 在 steady→final 之间逐 key 记录 renderer.info.memory.geometries 轨迹，
 * 并 hook BufferGeometry.prototype.dispose 记录被释放几何的 uuid + 调用栈，
 * 定位究竟是哪 5 个几何在若干轮进出后被释放却未重建（真泄漏/真 churn）。
 * 运行：PORT=5173 node tests/diag-dispose-trace.mjs
 */
import { chromium } from 'playwright';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      return orig.call(this, type, { ...(attrs || {}), preserveDrawingBuffer: true });
    }
    return orig.call(this, type, attrs);
  };
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.ERROR:', m.text()); });

try {
  const t0 = Date.now();
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 20000 });
  await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone === true, null, { timeout: 180000 }).catch(() => {});
  console.log('boot done', Date.now() - t0, 'ms');

  // 安装 dispose 追踪器：用场景里任意 geometry 拿到 BufferGeometry.prototype
  await page.evaluate(() => {
    let proto = null;
    window.__playground.sceneManager.scene.traverse((o) => { if (o.geometry && !proto) proto = o.geometry.constructor.prototype; });
    if (!proto) { globalThis.__noProto = true; return; }
    const orig = proto.dispose;
    globalThis.__disp = [];
    proto.dispose = function () {
      const stack = (new Error().stack || '').split('\n').slice(1, 5).map((s) => s.replace(/^\s*at\s*/, '').trim());
      globalThis.__disp.push({ uuid: this.uuid, name: this.userData?.name || '', stack });
      return orig.apply(this, arguments);
    };
  });
  const noProto = await page.evaluate(() => !!globalThis.__noProto);
  if (noProto) { console.log('无法取得 BufferGeometry.prototype，退出'); process.exit(2); }

  const baseline = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
  const keys = await page.evaluate(() => window.__playground.attractionManager.keys.filter((k) => k !== 'lobby' && k !== 'dummy'));
  console.log('baseline', baseline, '\nkeys', keys);

  const enterExit = async (k) => {
    await page.evaluate((key) => {
      const pg = window.__playground;
      pg.onEnterAttraction(key);
      pg.sceneManager.renderOnce();
      pg.onExitAttraction();
      pg.sceneManager.renderOnce();
    }, k);
  };

  // 强制一个【确定可见四宫格】的机位，使 castle/farm detail LOD 必定上传，
  // 从而让 castle/farm 的 5 个几何在每次测量时贡献一致（消除相机/LOD 非确定性）。
  const forceDistrictView = async () => {
    await page.evaluate(() => {
      const sm = window.__playground.sceneManager;
      sm.setPaused(true);
      sm.camera.position.set(30, 84, 96);
      sm.camera.lookAt(30, 2, 30);
      sm.camera.fov = 55; sm.camera.updateProjectionMatrix();
      sm.renderOnce();
      sm.setPaused(false);
    });
  };

  // warmup（与 verify-v4 ⑬ 完全一致）
  for (const k of keys) await enterExit(k);
  await page.evaluate(() => window.__playground.onExitAttraction?.());
  await forceDistrictView();
  const steady = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
  console.log('steady (district-view, 应含 castle/farm):', steady);

  // 清空追踪，开始记录 rounds 之间的 dispose
  await page.evaluate(() => { globalThis.__disp = []; });

  // 跑 2 轮（确认用，2 轮已足以证明无增长）；每轮结束强制 district-view 后测量
  const trajectory = [];
  for (let r = 0; r < 2; r += 1) {
    for (const k of keys) await enterExit(k);
    await page.evaluate(() => window.__playground.onExitAttraction?.());
    await forceDistrictView();
    const mem = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
    trajectory.push({ round: r + 1, geo: mem.geometries, tex: mem.textures });
  }
  const finalMem = trajectory[trajectory.length - 1];
  const disp = await page.evaluate(() => globalThis.__disp);
  console.log('final', finalMem);

  // 汇总 dispose 调用栈（按首帧 stack 分组）
  const byStack = {};
  for (const d of disp) {
    const key = d.stack.find((s) => /Dispose|dispose|Lobby|Castle|Farm|Districts|deactivate|activate/.test(s)) || d.stack[0] || '?';
    byStack[key] = (byStack[key] || 0) + 1;
  }
  console.log('\n=== 5 轮间 dispose 事件总数:', disp.length, '===');
  console.log('按关键调用栈分组：');
  for (const [k, v] of Object.entries(byStack)) console.log(`  x${v}  ${k}`);

  console.log('\n=== 5 轮轨迹（每轮结束 district-view 下的几何数）===');
  let prev = steady.geometries;
  for (const t of trajectory) {
    const delta = t.geo - prev;
    console.log(`  R${t.round} geo=${t.geo} (Δ${delta >= 0 ? '+' : ''}${delta})`);
    prev = t.geo;
  }
  const allFlat = trajectory.every((t) => t.geo === trajectory[0].geo) && trajectory[0].geo === steady.geometries;
  console.log('\n结论：steady==各轮==final 全平？', allFlat, ` (steady=${steady.geometries}, final=${finalMem.geometries})`);
} catch (err) {
  console.error('FATAL', err);
} finally {
  await browser.close();
}
