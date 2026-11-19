import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady === true, { timeout: 60000 });

const r = await page.evaluate(async () => {
  const pg = window.__playground;
  const rig = pg.cameraRig;
  const origUpdate = rig.update.bind(rig);
  window.__rigCalls = [];
  rig.update = (dt) => { window.__rigCalls.push(dt); return origUpdate(dt); };
  const origVillaUpdate = () => {};
  let viewUpdates = 0;
  await pg.onEnterAttraction('villa');
  const v = pg.facilityRuntime.activeView;
  const origV = v.update.bind(v);
  v.update = (dt) => { viewUpdates += 1; return origV(dt); };
  await new Promise((rr) => setTimeout(rr, 1200));
  return {
    rigCalls: window.__rigCalls.length,
    sample: window.__rigCalls.slice(0, 5),
    viewUpdates,
    transitioning: rig.isTransitioning,
    hasTransition: !!rig._transition,
    elapsed: rig._transition?.elapsed,
    duration: rig._transition?.duration,
  };
});
console.log(JSON.stringify(r));
await browser.close();
