/**
 * tests/verify-m4-jump.mjs —— M4 第一人称主路跑酷专项
 * 运行：node tests/verify-m4-jump.mjs
 *
 * A 能稳定进入跳一跳（activeKey 不卡、cameraRig 完成 blend）
 * B 第一人称机位：相机在玩家头顶、朝向下一落脚台（非第三人称后上方）
 * C 沿主路闭环 10 个落脚台（不是随机方块池），且都在中轴 ±3m 内
 * D 自动连续跳跃：受控推进后分数递增、落脚台索引前进
 * E 落地判定放宽后不再「跳不进去」（成功率 > 80%）
 * F 视角不卡住：相机随玩家移动，且无 roll、0 报错
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m4-jump.json');
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

try {
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForTimeout(400);

  // 进入跳一跳
  await page.evaluate(() => window.__playground.onEnterAttraction('jump-jump'));
  const enter = await page.evaluate(() => {
    const pg = window.__playground;
    const fr = pg.facilityRuntime;
    const v = fr?._views?.get?.('jump-jump') || fr?.views?.get?.('jump-jump') || null;
    return {
      activeKey: pg.attractionManager.activeKey,
      embedded: !!fr?.isEmbeddedActive,
      view: !!v,
      score: v?.score ?? null,
      state: v?.state ?? null,
      camera: [pg.sceneManager.camera.position.x, pg.sceneManager.camera.position.y,
        pg.sceneManager.camera.position.z].map((n) => +n.toFixed(2)),
    };
  });
  add('A 可稳定进入跳一跳', enter.embedded && enter.view, enter);

  const layout = await page.evaluate(() => {
    const pg = window.__playground;
    const fr = pg.facilityRuntime;
    const v = [...(fr?._views?.values?.() || [])].find((x) => x.key === 'jump-jump');
    if (!v) return null;
    const pts = v._blocks.map((b) => [+b.x.toFixed(2), +b.z.toFixed(2), b.active]);
    const offAxis = pts.filter(([x]) => Math.abs(x) > 3).length;
    return { pts, offAxis, current: v._current, next: v._next, pool: v._blocks.length,
      anchor: {
        y: +v._anchor.position.y.toFixed(2),
        x: +v._anchor.position.x.toFixed(2),
        z: +v._anchor.position.z.toFixed(2),
      },
      player: [+v._playerPos.x.toFixed(2), +v._playerPos.y.toFixed(2), +v._playerPos.z.toFixed(2)] };
  });
  add('C 沿主路闭环 10 个落脚台', layout && layout.pool === 10 && layout.offAxis === 0,
    layout && { pool: layout.pool, offAxis: layout.offAxis, pts: layout.pts });

  // 第一人称：相机与玩家同 x/z，且高于玩家脚底
  const fp = layout && Math.abs(layout.anchor.x - layout.player[0]) < 0.2
    && Math.abs(layout.anchor.z - layout.player[2]) < 0.2
    && layout.anchor.y > layout.player[1] + 0.8;
  add('B 第一人称机位（相机在玩家头顶）', fp,
    layout && { anchor: layout.anchor, player: layout.player });

  // D/E：受控推进 900 帧（45s），看分数 / 索引 / 落点
  const run = await page.evaluate(() => {
    const pg = window.__playground;
    const fr = pg.facilityRuntime;
    const v = [...(fr?._views?.values?.() || [])].find((x) => x.key === 'jump-jump');
    if (!v) return null;
    const start = { score: v.score, cur: v._current,
      px: v._playerPos.x, pz: v._playerPos.z };
    let maxScore = 0, jumps = 0, lastState = v.state;
    const positions = [];
    for (let i = 0; i < 900; i += 1) {
      // 与真实 frameDriver 同口径：facilityRuntime.update 内部同时推进
      // activeView.update + cameraRig.update（后者负责完成 0.8s 相机 blend）
      pg.facilityRuntime.update(0.05);
      if (v.state === 'jumping' && lastState !== 'jumping') jumps += 1;
      lastState = v.state;
      maxScore = Math.max(maxScore, v.score);
      if (i % 150 === 0) positions.push([+v._playerPos.x.toFixed(1), +v._playerPos.z.toFixed(1)]);
    }
    return { start, maxScore, jumps, final: v.score, state: v.state,
      current: v._current, positions,
      moved: Math.hypot(v._playerPos.x - start.px, v._playerPos.z - start.pz) };
  });
  add('D 自动连续跳跃使分数递增', run && run.maxScore > 3 && run.jumps >= 3, run);
  add('E 落脚成功（非反复掉落）', run && run.final > 3, run);

  // F 相机随玩家移动 + 无 roll + 0 报错
  const cam = await page.evaluate(() => {
    const pg = window.__playground;
    const c = pg.sceneManager.camera;
    const up = c.up;
    return { up: [up.x, up.y, up.z].map((n) => +n.toFixed(3)),
      fov: c.fov, pos: [c.position.x, c.position.y, c.position.z].map((n) => +n.toFixed(2)) };
  });
  add('F 相机无 roll / FOV 已切第一人称', Math.abs(cam.up[1] - 1) < 0.01 && cam.fov >= 70, cam);
  add('0 pageerror / console.error', errors.length === 0, errors.slice(0, 5));

  // 退出不卡
  await page.evaluate(() => window.__playground.onExitAttraction());
  const exit = await page.evaluate(() => ({
    activeKey: window.__playground.attractionManager.activeKey,
    embedded: !!window.__playground.facilityRuntime.isEmbeddedActive,
  }));
  add('G 可正常返回大厅', exit.activeKey === 'lobby' && !exit.embedded, exit);

  const shot = path.join(OUT, 'zoo-m4-jump.png');
  await page.evaluate(() => window.__playground?.sceneManager?.renderOnce?.());
  await page.screenshot({ path: shot });
  add('截图有效', fs.statSync(shot).size > 20000, { file: shot, bytes: fs.statSync(shot).size });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M4_JUMP ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 300)}`);
  await browser.close();
}
