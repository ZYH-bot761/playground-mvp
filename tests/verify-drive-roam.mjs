/**
 * ============================================================================
 * tests/verify-drive-roam.mjs —— 漫游模式 ↔ 驾驶集成验收（回归防复发）
 * ============================================================================
 * 背景：六项升级的 movementMode（F 漫游）与驾驶功能曾互斥——玩家用漫游
 * 走到车旁后，因 movementMode.isEngaged()=true 使车辆扫描 baseOk 恒 false，
 * 靠近车按 E 完全无反应。本脚本锁定修复后的正确行为。
 *
 * 检查项：
 *   ① 漫游地面模式（ground）靠近车：nearCar 命中 + 提示亮起
 *   ② 漫游地面模式按 E 能上车（真实键盘事件）
 *   ③ 驾驶中 movementMode 让位（isEngaged=false，但 engaged 标志保留）
 *   ④ 驾驶相机高度跟随车辆（不被 movementMode 锁在 1.7m）
 *   ⑤ 下车后 movementMode 自动恢复接管（无需重新按 F）
 *   ⑥ 漫游飞行模式（flight）高空不误扫车
 *
 * 用法：node tests/verify-drive-roam.mjs
 * ============================================================================
 */
import { chromium } from 'playwright';
const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CHECKS = [], errs = [];
function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errs.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${PORT}/?t=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 30000 });
  const p = await page.evaluate(() => window.__playground.attractionManager.active._city.traffic.getParkedPose(0));

  // 建立干净的漫游地面态并把相机放到车旁（受控推进，规避 headless rAF 节流）
  const setup = (mode) => page.evaluate(({ p, mode }) => {
    const pg = window.__playground, l = pg.attractionManager.active, cam = pg.sceneManager.camera;
    if (pg.vehicleSystem?.active) l._exitVehicle();
    pg.cameraRig.update(10);
    l._wasdBlendActive = false;
    l._inputMode = 'wasd';
    pg.cameraRig.setOwner('lobby-wasd');
    cam.position.set(p.x, 1.6, p.z + 3);
    cam.rotation.order = 'YXZ'; cam.lookAt(p.x, 1.6, p.z);
    l._wasd.resetFromCamera(cam);
    if (!pg.movementMode.isEngaged()) pg.movementMode.engage();
    pg.movementMode.setMode(mode);
    if (mode === 'ground') { cam.position.set(p.x, 1.6, p.z + 3); l._wasd.resetFromCamera(cam); }
    for (let i = 0; i < 5; i++) l.update(1 / 60);
    return {
      engaged: pg.movementMode.isEngaged(), mode: pg.movementMode.mode,
      nearCar: l._nearCar ? { d: +l._nearCar.distance.toFixed(2) } : null,
      promptOn: document.querySelector('[data-role="drive-hint"]')?.dataset.on,
    };
  }, { p, mode });

  const ground = await setup('ground');
  check('漫游地面模式靠近车：nearCar 命中 + 提示亮起',
    ground.engaged && ground.nearCar && ground.promptOn === '1', ground);

  await page.keyboard.press('e');
  await page.waitForTimeout(500);
  const seated = await page.evaluate(() => {
    const pg = window.__playground, d = pg.vehicleSystem, l = pg.attractionManager.active;
    for (let i = 0; i < 10; i++) l.update(1 / 60);
    const t = d._body?.translation();
    return {
      active: d.active,
      engagedRaw: pg.movementMode.engaged,
      engagedEffective: pg.movementMode.isEngaged(),
      camY: +pg.sceneManager.camera.position.y.toFixed(2),
      carY: t ? +t.y.toFixed(2) : null,
    };
  });
  check('漫游地面模式按 E 成功上车', seated.active, seated);
  check('驾驶中漫游层让位（engaged 标志保留、effective=false）',
    seated.engagedRaw === true && seated.engagedEffective === false, seated);
  check('驾驶相机跟随车辆（Y≈车高+0.68，未被锁 1.7m）',
    seated.carY != null && Math.abs(seated.camY - (seated.carY + 0.68)) < 0.15, seated);

  await page.keyboard.press('e'); // 下车
  await page.waitForTimeout(400);
  const exited = await page.evaluate(() => {
    const pg = window.__playground;
    return { active: pg.vehicleSystem?.active, engagedEffective: pg.movementMode.isEngaged() };
  });
  check('下车后漫游层自动恢复接管（无需重按 F）',
    !exited.active && exited.engagedEffective === true, exited);

  const flight = await setup('flight');
  check('漫游飞行模式高空不误扫车', flight.engaged && flight.nearCar === null, flight);
  check('运行期零 pageerror', errs.length === 0, errs.slice(0, 3));
} catch (e) {
  check('探针执行完成', false, String(e));
} finally {
  await browser.close();
}
const pass = CHECKS.filter((c) => c.pass).length;
console.log(`\nDRIVE_ROAM_RESULT ${pass}/${CHECKS.length} allPass=${pass === CHECKS.length}`);
process.exit(pass === CHECKS.length ? 0 : 1);
