/**
 * ============================================================================
 * tests/villa-capture.mjs —— 别墅内景截图（人工目视检查用，不是验收项）
 * ============================================================================
 * 进入别墅后把 `_wasd` 摘掉（否则相机每帧被眼高逻辑拉回本层 1.6m），
 * 逐个机位摆好相机 → renderOnce → 截图，输出到 docs/screenshots/v2-*.png。
 *
 * 用法：node tests/villa-capture.mjs [机位名...]   （不带参数=全部）
 * 前置：dev server 在 5173 跑着。
 * ============================================================================
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

// [名字, 楼层(仅记录), 相机位置, 看向的点]
const VIEWS = [
  ['v2-1f-hall', 1, [1.6, 1.6, 5.4], [-4.0, 1.5, -4.0]],
  ['v2-1f-living', 1, [2.2, 1.6, 3.2], [-6.5, 1.1, -2.5]],
  ['v2-1f-kitchen', 1, [0.4, 1.6, -3.0], [3.2, 1.3, -7.2]],
  ['v2-1f-stair-look', 1, [-4.6, 1.6, 2.2], [-8.6, 2.2, -0.6]],
  ['v2-2f', 2, [0.6, 5.2, 6.6], [-4.5, 4.2, -6.0]],
  ['v2-2f-bath', 2, [7.2, 5.2, 3.4], [8.6, 4.4, -2.0]],
  ['v2-3f', 3, [1.0, 8.8, 5.6], [-2.0, 8.0, -4.0]],
  ['v2-3f-study', 3, [6.0, 8.8, 2.0], [2.0, 8.0, -6.0]],
  ['v2-balcony', 2, [0.0, 5.2, 9.6], [0.0, 4.6, 30.0]],
  ['v2-b1', 0, [1.4, -2.0, -1.6], [-6.0, -2.6, -6.0]],
  ['v2-yard', 1, [0.0, 1.7, 20.0], [0.0, 4.0, 8.0]],
  ['v2-overview', 1, [30.0, 22.0, 34.0], [0.0, 4.0, 0.0]],
];

const only = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/?no-prewarm=1&t=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 30000 });
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /进入游乐场/.test(b.textContent || ''));
  if (btn) btn.click();
});
await page.waitForTimeout(300);
await page.evaluate(async () => { await window.__playground.onEnterAttraction?.('villa'); });
await page.waitForTimeout(400);

// 摘掉 WASD，锁住相机（截图专用；刷新即恢复）
await page.evaluate(() => {
  const v = window.__playground.attractionManager.active;
  v._wasd = null;
});

for (const [name, , pos, look] of VIEWS) {
  if (only.length && !only.includes(name)) continue;
  await page.evaluate(([p, l]) => {
    const pg = window.__playground, cam = pg.sceneManager.camera;
    cam.position.set(p[0], p[1], p[2]);
    cam.lookAt(l[0], l[1], l[2]);
    pg.sceneManager.renderOnce();
  }, [pos, look]);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
}

console.log('ERRS', JSON.stringify(errs).slice(0, 400));
await browser.close();
