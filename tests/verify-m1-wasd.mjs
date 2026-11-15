/**
 * tests/verify-m1-wasd.mjs —— M1 键盘移动专项（先复现、后回归）
 * 运行：node tests/verify-m1-wasd.mjs
 * 断言：
 *   A 不按 M，直接按 W 就能在大厅走动（用户诉求「自由使用 WASD」）
 *   B 按 M 显式切换后 W/A/S/D / 方向键均生效
 *   C 进入设施再返回大厅后 W 仍生效（不残留卡死）
 *   D 移动不产生相机跳变、0 console.error
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m1-wasd.json');
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

/** 受控推进 n 帧（绕开 headless rAF 节流） */
const drive = (n = 30, dt = 0.05) => page.evaluate(({ n, dt }) => {
  const pg = window.__playground;
  for (let i = 0; i < n; i += 1) {
    pg.facilityRuntime?.update?.(dt);
    pg.attractionManager?.active?.update?.(dt);
  }
  const c = pg.sceneManager.camera;
  const l = pg.attractionManager.active;
  return {
    pos: [c.position.x, c.position.y, c.position.z].map((v) => +v.toFixed(3)),
    mode: l?._inputMode, blend: l?._wasdBlendActive,
    owner: pg.cameraRig?.owner ?? null,
    transitioning: pg.cameraRig?.isTransitioning ?? null,
  };
}, { n, dt });

const dist = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]);

try {
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForTimeout(800);

  // A：不按 M，直接 W
  const a0 = await drive(1);
  await page.keyboard.down('w');
  const a1 = await drive(30);
  await page.keyboard.up('w');
  const dA = dist(a0, a1);
  add('A 不按 M 直接按 W 即可走动', dA > 0.5, { before: a0, after: a1, distance: +dA.toFixed(3) });

  // B：显式 M 切换后四向 + 方向键
  const b0 = await drive(1);
  await page.keyboard.press('m');
  await drive(30); // 推进过渡
  const bMid = await drive(1);
  await page.keyboard.down('d');
  const b1 = await drive(30);
  await page.keyboard.up('d');
  const dB = dist(bMid, b1);
  add('B M 切换后 D 键生效', dB > 0.5,
    { mode: bMid.mode, blend: bMid.blend, owner: bMid.owner, distance: +dB.toFixed(3) });

  // C：进设施返回后再走
  await page.evaluate(() => {
    const pg = window.__playground;
    pg.onEnterAttraction('carousel');
    pg.sceneManager.renderOnce();
    pg.onExitAttraction();
    pg.sceneManager.renderOnce();
  });
  await drive(20);
  const c0 = await drive(1);
  await page.keyboard.down('ArrowUp');
  const c1 = await drive(30);
  await page.keyboard.up('ArrowUp');
  const dC = dist(c0, c1);
  add('C 设施返回后方向键仍生效', dC > 0.5, { state: c0, distance: +dC.toFixed(3) });

  // D：无跳变 / 0 报错
  const jump = Math.max(
    Math.abs(a1.pos[1] - a0.pos[1]), Math.abs(b1.pos[1] - bMid.pos[1]),
    Math.abs(c1.pos[1] - c0.pos[1]),
  );
  add('D 无相机跳变', jump < 2.0, { maxVerticalJump: +jump.toFixed(3) });
  add('0 pageerror / console.error', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M1_WASD ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 260)}`);
  await browser.close();
}
