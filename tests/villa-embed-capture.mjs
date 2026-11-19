/**
 * villa-embed-capture.mjs —— 同场并置后的机位截图（看看窗外是不是真大厅）
 * 用法：node tests/villa-embed-capture.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady === true, { timeout: 60000 });
await page.click('.pg-start__enter[data-action="start"]');
await page.waitForFunction(() => window.__playground.sceneManager._running === true, { timeout: 30000 });
await page.evaluate(() => window.__playground.onEnterAttraction('villa'));
await page.waitForFunction(() => window.__playground.cameraRig.isTransitioning === false, { timeout: 40000 });
// 截图期间要“锁机位”：摘掉 WASD（否则它每帧把自己的 yaw/眼高写回相机）
await page.evaluate(() => {
  const v = window.__playground.facilityRuntime.activeView.villa;
  v._wasd?.dispose();
  v._wasd = null;
});

const shots = [
  // [文件名, 本地 x, 本地 y(眼高以上), 本地 z, yaw(0=朝南/世界-z, π=朝北)]
  ['v3-1f-south-glass', 0, 1.6, 2.0, 0],
  ['v3-2f-balcony-south', 0, 5.2, 9.6, 0],
  ['v3-3f-balcony-south', -0.5, 8.8, 9.6, 0.25],
  ['v3-1f-north-window', 0, 1.6, -2.4, Math.PI],
  ['v3-2f-west-stair', -5.2, 5.2, 4.0, Math.PI * 0.72],
  ['v3-3f-stair-top', -6.2, 8.8, 6.6, Math.PI],
];

for (const [name, lx, ly, lz, yaw] of shots) {
  await page.evaluate(({ lx, ly, lz, yaw }) => {
    const pg = window.__playground;
    const v = pg.facilityRuntime.activeView.villa;
    const w = v.localToWorld(lx, ly, lz);
    const cam = pg.sceneManager.camera;
    cam.position.set(w.x, w.y, w.z);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(-0.06, yaw, 0);
    cam.updateMatrixWorld(true);
    v._footY = ly - 1.6;
    pg.sceneManager.renderOnce();
  }, { lx, ly, lz, yaw });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `docs/screenshots/${name}.png` });
  console.log('shot', name);
}

await browser.close();

