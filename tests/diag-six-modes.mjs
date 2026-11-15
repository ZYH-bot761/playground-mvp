/** 双模式行为诊断：F 切换 / 1.7m 锁定 / 飞行升降 / BVH 碰撞 / 过渡 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  const old = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, a) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') a = Object.assign({}, a, { preserveDrawingBuffer: true });
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
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });

  // 进入飞行并受控推进（用 manager.update 直接驱动，绕开 rAF 节流）
  const r = await page.evaluate(() => {
    const pg = window.__playground, mm = pg.movementMode, cam = pg.sceneManager.camera;
    const log = {};
    log.initial = { mode: mm.mode, engaged: mm.engaged, y: cam.position.y };
    mm.toggle(); // ground -> flight
    for (let i = 0; i < 40; i += 1) mm.update(0.05);
    log.flight = { mode: mm.mode, y: +cam.position.y.toFixed(3), blend: mm._blend };
    mm._keys.add('Space');
    for (let i = 0; i < 20; i += 1) mm.update(0.05);
    log.flightUp = +cam.position.y.toFixed(3);
    mm._keys.delete('Space'); mm._keys.add('KeyQ');
    for (let i = 0; i < 10; i += 1) mm.update(0.05);
    log.flightDown = +cam.position.y.toFixed(3);
    mm._keys.delete('KeyQ');
    mm.toggle(); // flight -> ground
    log.blendStart = { y: +cam.position.y.toFixed(3), blend: mm._blend };
    for (let i = 0; i < 40; i += 1) mm.update(0.05);
    log.ground = { mode: mm.mode, y: +cam.position.y.toFixed(4), blend: mm._blend };
    mm._keys.add('KeyW');
    for (let i = 0; i < 20; i += 1) mm.update(0.05);
    log.groundWalk = { x: +cam.position.x.toFixed(2), z: +cam.position.z.toFixed(2), y: +cam.position.y.toFixed(4) };
    mm._keys.delete('KeyW');
    log.stats = { ...mm.stats };
    log.hud = document.querySelector('.pg-mode-hud')?.textContent?.trim();
    // 手动塞进一个建筑 AABB，验证 BVH 推出
    const boxes = pg.attractionManager.active?._buildingBoxes || [];
    const b = boxes.find((bb) => !bb.noBlock && Number.isFinite(bb.minX));
    if (b) {
      cam.position.x = (b.minX + b.maxX) / 2;
      cam.position.z = (b.minZ + b.maxZ) / 2;
      cam.position.y = 1.7;
      mm.update(0.016);
      log.bvhPush = {
        inside: cam.position.x > b.minX && cam.position.x < b.maxX && cam.position.z > b.minZ && cam.position.z < b.maxZ,
        x: +cam.position.x.toFixed(2), z: +cam.position.z.toFixed(2),
        pushOuts: mm.stats.bvhPushOuts,
      };
    }
    return log;
  });
  console.log('MODES', JSON.stringify(r, null, 2));
  // 截图（四宫格俯瞰）
  const shot = await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.camera.position.set(30, 84, 96); sm.camera.up.set(0, 1, 0);
    sm.camera.lookAt(30, 2, 30); sm.camera.fov = 55; sm.camera.updateProjectionMatrix();
    sm.renderOnce();
    return sm.renderer.domElement.toDataURL('image/png');
  });
  fs.writeFileSync('docs/screenshots/six-overview.png', Buffer.from(shot.split(',')[1], 'base64'));
  console.log('SHOT bytes', fs.statSync('docs/screenshots/six-overview.png').size);
} catch (e) { console.log('FATAL', String(e?.stack || e)); }
console.log('ERRORS', errors.length, JSON.stringify(errors.slice(0, 15), null, 2));
await browser.close();
