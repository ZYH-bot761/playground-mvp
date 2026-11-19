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

const r = await page.evaluate(async () => {
  const pg = window.__playground;
  const snap = (tag) => {
    const cam = pg.sceneManager.camera;
    return {
      tag,
      cam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
      transitioning: pg.cameraRig?.isTransitioning,
      owner: pg.cameraRig?.owner,
      poses: pg.cameraRig?._poses ? Object.keys(pg.cameraRig._poses) : null,
      anchor: (() => { const v = pg.facilityRuntime.activeView; if (!v) return null; const a = v.getCameraAnchor(); return [+a.position.x.toFixed(2), +a.position.y.toFixed(2), +a.position.z.toFixed(2)]; })(),
    };
  };
  const out = [snap('before')];
  await pg.onEnterAttraction('villa');
  out.push(snap('t0'));
  await new Promise((rr) => setTimeout(rr, 300));
  out.push(snap('t300'));
  await new Promise((rr) => setTimeout(rr, 900));
  out.push(snap('t1200'));
  out.push({ paused: pg.sceneManager.paused, rigKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(pg.cameraRig)) });
  return out;
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
