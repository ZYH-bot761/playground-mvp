import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
page.setDefaultNavigationTimeout(300000);
page.setDefaultTimeout(300000);
await page.goto('http://localhost:5176/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__playground, null, { timeout: 300000, polling: 'raf' });
await page.locator('.pg-start__enter').click();
await page.waitForFunction(() => window.__playground?.baselineCalibrated === true && window.__playground?.backgroundPrewarmDone === true, null, { timeout: 300000, polling: 500 });
await page.evaluate(() => window.__playground.onEnterAttraction('pumpkin-thrower'));
await page.waitForFunction(() => window.__playground?.facilityRuntime?.isTransitioning === false, null, { timeout: 120000, polling: 'raf' });
const snap = () => page.evaluate(() => {
  const p = window.__playground;
  const v = p.facilityRuntime.activeView;
  const cam = p.sceneManager.camera;
  const a = v._anchor;
  const lobby = p.attractionManager.active;
  const q = cam.quaternion;
  const aq = a.quaternion;
  const dq = Math.hypot(q.x - aq.x, q.y - aq.y, q.z - aq.z, q.w - aq.w);
  return {
    camPos: [cam.position.x, cam.position.y, cam.position.z],
    anchorPos: [a.position.x, a.position.y, a.position.z],
    posErr: Math.hypot(cam.position.x - a.position.x, cam.position.y - a.position.y, cam.position.z - a.position.z),
    quatErr: dq,
    camUp: [cam.up.x, cam.up.y, cam.up.z],
    camRightY: 2 * (q.z * q.w + q.x * q.y),
    anchorRightY: 2 * (aq.z * aq.w + aq.x * aq.y),
    controlsEnabled: lobby?._controls?.enabled,
    inputMode: lobby?._inputMode,
    lookYaw: v.lookYaw,
    transitioning: p.facilityRuntime.isTransitioning,
  };
});
const s0 = await snap();
await page.waitForTimeout(1500);
const s1 = await snap();
// 再拖一次左，等 1.5s 让软跟随收敛
const box = await page.locator('canvas').first().boundingBox();
const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 120, cy, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(1500);
const s2 = await snap();
console.log(JSON.stringify({ settled: s0, after15s: s1, afterDragSettled: s2 }, null, 2));
await browser.close();
