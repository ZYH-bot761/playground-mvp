import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.setDefaultNavigationTimeout(300000);
page.setDefaultTimeout(300000);
await page.goto('http://localhost:5176/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__playground, null, { timeout: 300000, polling: 'raf' });
await page.locator('.pg-start__enter').click();
await page.waitForFunction(() => window.__playground?.baselineCalibrated === true && window.__playground?.backgroundPrewarmDone === true, null, { timeout: 300000, polling: 500 });

const out = await page.evaluate(async () => {
  const p = window.__playground;
  const lobby = p.attractionManager.active;
  const ctrl = lobby._controls;
  const originalUpdate = ctrl.update;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const idle = async () => { for (let i = 0; i < 400 && p.facilityRuntime.isTransitioning; i += 1) await frame(); };

  const before = {
    updateIsOriginal: ctrl.update === originalUpdate,
    controlsEnabled: ctrl.enabled,
    _controlsUpdateOriginal: p.facilityRuntime._controlsUpdateOriginal === null,
  };
  p.onEnterAttraction('pumpkin-thrower');
  await frame();
  const during = {
    updateIsNoop: ctrl.update !== originalUpdate,
    controlsEnabled: ctrl.enabled,
    _controlsUpdateOriginalStored: p.facilityRuntime._controlsUpdateOriginal === originalUpdate,
    embedded: p.facilityRuntime.isEmbeddedActive,
  };
  await idle();
  p.onExitAttraction();
  await idle();
  await frame();
  const after = {
    updateIsOriginal: ctrl.update === originalUpdate,
    controlsEnabled: ctrl.enabled,
    _controlsUpdateOriginalCleared: p.facilityRuntime._controlsUpdateOriginal === null,
    suspendedControlsNull: p.facilityRuntime._suspendedControls === null,
    embedded: p.facilityRuntime.isEmbeddedActive,
  };
  return { before, during, after };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
