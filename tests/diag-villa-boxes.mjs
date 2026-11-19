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
await page.waitForTimeout(800);

const r = await page.evaluate(async () => {
  const pg = window.__playground;
  await pg.onEnterAttraction('villa');
  await new Promise((rr) => setTimeout(rr, 3500));
  const v = pg.facilityRuntime.activeView.villa;
  const targets = [{ lv: 3, x: -5.6, z: 7.5 }, { lv: 2, x: -5.6, z: 2.5 }, { lv: 1, x: -5.6, z: 2.5 }];
  const out = [];
  for (const t of targets) {
    v._level = t.lv;
    v._boxCache = null; v._worldCache = null;
    const boxes = v._walkBoxesByLevel().filter((b) => (
      t.x > b.minX - 0.6 && t.x < b.maxX + 0.6 && t.z > b.minZ - 0.6 && t.z < b.maxZ + 0.6
    )).map((b) => [b.minX, b.maxX, b.minZ, b.maxZ].map((n) => +n.toFixed(2)));
    out.push({ ...t, boxes });
  }
  return { out, cam: [+pg.sceneManager.camera.position.x.toFixed(1), +pg.sceneManager.camera.position.y.toFixed(1), +pg.sceneManager.camera.position.z.toFixed(1)] };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
