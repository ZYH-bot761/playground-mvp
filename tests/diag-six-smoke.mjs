/** 六项升级冒烟诊断：只报告状态，不做断言 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  const old = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, a) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') {
      a = Object.assign({}, a, { preserveDrawingBuffer: true });
    }
    return old.call(this, t, a);
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
try {
  await page.goto('http://127.0.0.1:5173/?t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });
  const snap = await page.evaluate(() => {
    const pg = window.__playground;
    const scene = pg.sceneManager.scene;
    const lod = scene.getObjectByName('Districts/castle/lod');
    const farm = scene.getObjectByName('Districts/farm/lod');
    const crops = [];
    scene.traverse((o) => { if (o.name?.startsWith('Districts/farm/crop-')) crops.push(o.name); });
    const labels = [];
    scene.traverse((o) => { if (o.name?.startsWith('DistrictsLabels/')) labels.push(o.name); });
    return {
      movement: { mode: pg.movementMode?.mode, engaged: pg.movementMode?.engaged, stats: { ...pg.movementMode?.stats } },
      optimizer: { ...pg.renderOptimizer?.stats, forceNoCull: pg.renderOptimizer?.forceNoCull },
      labels: pg.districtLabels?._sprites?.map((s) => ({ name: s.name, text: s.userData.labelText })),
      labelsFound: labels,
      fxaa: !!pg.sceneManager.fxaaPass,
      passes: pg.sceneManager.composer?.passes?.map((p) => p.constructor.name),
      lods: { castle: { autoUpdate: lod?.autoUpdate, levels: lod?.levels?.length }, farm: { autoUpdate: farm?.autoUpdate } },
      crops: crops.length,
      cropColor: !!scene.getObjectByName('Districts/farm/crop-水稻')?.instanceColor,
      plateau: !!scene.getObjectByName('Districts/castle/plateau'),
      hud: document.querySelector('.pg-mode-hud')?.textContent?.trim(),
      gui: !!document.querySelector('.pg-gui'),
      glass: getComputedStyle(document.querySelector('.pg-ui__panel')).backdropFilter,
      hudTitle: document.querySelector('.lb-title')?.textContent,
      mem: { ...pg.sceneManager.renderer.info.memory },
    };
  });
  console.log('SNAP', JSON.stringify(snap, null, 2));
  // 试按 F 切换
  await page.keyboard.press('f');
  const afterF = await page.evaluate(() => ({
    mode: window.__playground.movementMode.mode,
    engaged: window.__playground.movementMode.engaged,
    hud: document.querySelector('.pg-mode-hud')?.textContent?.trim(),
    y: window.__playground.sceneManager.camera.position.y,
  }));
  console.log('AFTER_F', JSON.stringify(afterF));
  await page.keyboard.press('f');
  const afterF2 = await page.evaluate(() => ({ mode: window.__playground.movementMode.mode }));
  console.log('AFTER_F2', JSON.stringify(afterF2));
} catch (e) {
  console.log('FATAL', String(e?.stack || e));
}
console.log('ERRORS', errors.length, JSON.stringify(errors.slice(0, 20), null, 2));
await browser.close();
