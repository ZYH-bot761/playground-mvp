import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady === true, { timeout: 60000 });
const r = await page.evaluate(async () => {
  const pg = window.__playground;
  let frames = 0;
  const orig = pg.sceneManager.constructor.prototype.renderOnce;
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => { frames += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(); };
    requestAnimationFrame(tick);
  });
  return {
    rafFrames: frames,
    running: pg.sceneManager._running,
    rafId: pg.sceneManager._rafId ?? null,
    paused: pg.sceneManager.paused,
    deps: Object.keys(pg.sceneManager._deps || {}),
    hasAttractionsDep: !!pg.sceneManager._deps?.attractions,
    startCalls: pg.sceneManager._running,
  };
});
console.log(JSON.stringify(r));
await browser.close();
