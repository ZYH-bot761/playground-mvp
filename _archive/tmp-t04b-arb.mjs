import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
page.setDefaultNavigationTimeout(300000);
page.setDefaultTimeout(300000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e?.stack || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5176/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__playground, null, { timeout: 300000, polling: 'raf' });
await page.locator('.pg-start__enter').click();
await page.waitForFunction(() => window.__playground?.baselineCalibrated === true && window.__playground?.backgroundPrewarmDone === true, null, { timeout: 300000, polling: 500 });

const snap = () => page.evaluate(() => {
  const p = window.__playground;
  const v = p.facilityRuntime.activeView;
  const cam = p.sceneManager.camera;
  const a = v?._anchor;
  const q = cam.quaternion;
  const lobby = p.attractionManager.active;
  const ctrl = lobby?._controls;
  return {
    embedded: p.facilityRuntime.isEmbeddedActive,
    runtimeKey: p.facilityRuntime.activeKey,
    isFallback: v?.isFallback,
    wheelShared: v?.wheelSpin === p.sceneManager.scene.getObjectByName('Lobby/wheel-spin'),
    posErr: a ? Math.hypot(cam.position.x - a.position.x, cam.position.y - a.position.y, cam.position.z - a.position.z) : null,
    camRightY: 2 * (q.z * q.w + q.x * q.y),
    camUp: [cam.up.x, cam.up.y, cam.up.z],
    controlsEnabled: ctrl?.enabled,
    updateIsNoop: !!ctrl && /_sphericalDelta/.test(String(ctrl.update)),
    updateIsOriginal: !!ctrl && !/_sphericalDelta/.test(String(ctrl.update)),
    inputMode: lobby?._inputMode,
    transitioning: p.facilityRuntime.isTransitioning,
    memory: { ...p.sceneManager.renderer.info.memory },
    baseline: { ...p.baseline },
  };
});

const out = {};
// --- orbit 模式进入 ---
await page.evaluate(() => window.__playground.onEnterAttraction('pumpkin-thrower'));
await page.waitForFunction(() => window.__playground?.facilityRuntime?.isTransitioning === false, null, { timeout: 120000, polling: 'raf' });
await page.waitForTimeout(1500);
out.orbitModeRide = await snap();

// 拖拽环顾后再看收敛
const box = await page.locator('canvas').first().boundingBox();
const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 140, cy - 60, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(1500);
out.orbitModeAfterDrag = await snap();

// 退出 → 检查 controls.update 还原 + orbit 仍可用（相机能回大厅机位）
await page.evaluate(() => window.__playground.onExitAttraction());
await page.waitForFunction(() => window.__playground?.facilityRuntime?.isTransitioning === false, null, { timeout: 120000, polling: 'raf' });
await page.waitForTimeout(500);
out.afterExit = await snap();

// --- 切 WASD 模式后再进入嵌入（owner 仲裁） ---
await page.evaluate(() => {
  const p = window.__playground;
  const lobby = p.attractionManager.active;
  // T02 暴露的方法名未知，尝试常见名；若没有则跳过
  if (typeof lobby?._toggleInputMode === 'function') lobby._toggleInputMode();
  else if (typeof lobby?._setInputMode === 'function') lobby._setInputMode('wasd');
});
await page.waitForTimeout(300);
out.wasdModeBefore = await page.evaluate(() => ({ inputMode: window.__playground.attractionManager.active?._inputMode }));
await page.evaluate(() => window.__playground.onEnterAttraction('pumpkin-thrower'));
await page.waitForFunction(() => window.__playground?.facilityRuntime?.isTransitioning === false, null, { timeout: 120000, polling: 'raf' });
await page.waitForTimeout(1200);
out.wasdModeRide = await snap();
// WASD 期间按住 W，看相机是否被抢
await page.keyboard.down('w');
await page.waitForTimeout(600);
await page.keyboard.up('w');
await page.waitForTimeout(600);
out.wasdModeAfterW = await snap();
await page.evaluate(() => window.__playground.onExitAttraction());
await page.waitForFunction(() => window.__playground?.facilityRuntime?.isTransitioning === false, null, { timeout: 120000, polling: 'raf' });
await page.waitForTimeout(500);
out.wasdAfterExit = await snap();

out.errors = errors;
console.log(JSON.stringify(out, null, 2));
await browser.close();
