/** tests/qa-gov.mjs —— 帧率调速器生效验证（headless swiftshader 天然低 fps，正好触发降档） */
import { chromium } from 'playwright';
const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const errs = [];
const browser = await chromium.launch({ executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/?no-prewarm=1&t=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady, null, { timeout: 90000 });
await page.evaluate(() => document.querySelector('.pg-start__enter[data-action="start"]')?.click());
await page.waitForFunction(() => window.__playground.sceneManager._running === true, null, { timeout: 30000 });
await page.waitForFunction(() => !!window.__playground.attractionManager.active?._city?.ready, null, { timeout: 120000 });
await page.waitForTimeout(6000);
const r = await page.evaluate(() => {
  const sm = window.__playground.sceneManager;
  return { level: +sm._fpsGov.level.toFixed(3), pr: +sm.renderer.getPixelRatio().toFixed(3), tier: sm.qualityTier };
});
console.log('GOV', JSON.stringify(r), 'errs=', errs.length);
console.log(r.level < 1 && errs.length === 0 ? 'PASS 低帧率自动降档，无报错' : (errs.length ? 'FAIL 报错' : 'WARN 未触发降档（机器够快即正常）'));
await browser.close();
