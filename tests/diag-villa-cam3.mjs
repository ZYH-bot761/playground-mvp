import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady === true, { timeout: 60000 });
await page.click('.pg-start__enter[data-action="start"]');
await page.waitForFunction(() => window.__playground.sceneManager._running === true, { timeout: 30000 });
await page.waitForTimeout(1000);

const r = await page.evaluate(async () => {
  const pg = window.__playground;
  const samples = [];
  const rig = pg.cameraRig;
  await pg.onEnterAttraction('villa');
  const t0 = performance.now();
  for (let i = 0; i < 5; i += 1) {
    await new Promise((rr) => setTimeout(rr, 1000));
    samples.push({
      t: Math.round(performance.now() - t0),
      elapsed: +(rig._transition?.elapsed ?? -1).toFixed(2),
      trans: rig.isTransitioning,
      cam: [+pg.sceneManager.camera.position.x.toFixed(1), +pg.sceneManager.camera.position.y.toFixed(1), +pg.sceneManager.camera.position.z.toFixed(1)],
      running: pg.sceneManager._running,
      paused: pg.sceneManager.paused,
      deltaMs: +pg.sceneManager._timer?.getDelta?.().toFixed?.(3),
    });
  }
  return samples;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
