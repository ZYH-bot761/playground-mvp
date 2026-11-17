/**
 * 阶段四验收：GTA 式驾驶
 * - 靠近 AI 车出现「按 E 上车」
 * - E 上车 → Rapier 动态刚体 + 第一人称驾驶位 + AI 车隐藏
 * - W/S 冲量加减速、A/D 转向；AI 车为简化 kinematic 包围盒
 * - E 下车 → 刚体/collider 全清、AI 车归还、相机回到 1.6m 步行
 * - 驾驶视觉复用现有几何，Δgeo=0 / Δtex=0
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 5173);
const URL = `http://127.0.0.1:${PORT}/?t=${Date.now()}`;
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT_DIR = 'docs/screenshots';
const CHECKS = [];
const errors = [];
const shots = [];

function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
}

const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGEERROR', e.message); });
page.on('console', (m) => {
  if (m.type() === 'error') { errors.push('console: ' + m.text()); console.log('CONSOLE-ERROR', m.text()); }
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
await page.locator('[data-action="start"]').click();
await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone === true, null, { timeout: 180000 });
await page.waitForTimeout(300);

const ready = await page.evaluate(() => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const p = lobby._city.traffic.getParkedPose(0);
  lobby._inputMode = 'wasd';
  lobby._wasdBlendActive = false;
  lobby._controls.enabled = false;
  const cam = pg.sceneManager.camera;
  cam.position.set(p.x + 1.5, 1.6, p.z);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(0, p.yaw + Math.PI, 0);
  lobby._wasd.resetFromCamera(cam);
  lobby.update(0.016);
  const before = { ...pg.sceneManager.renderer.info.memory };
  return {
    p,
    prompt: (() => { const el = document.querySelector('[data-role="drive-hint"]'); return { on: el?.dataset.on, text: el?.textContent?.replace(/\s+/g, ' ').trim() }; })(),
    near: lobby._nearCar,
    bodyCount: pg.vehicleSystem.debugState.bodyCount,
    mem: before,
    cam: cam.position.toArray(),
  };
});
check('靠近 AI 车出现「按 E 上车」', ready.prompt.on === '1' && /按 E 上车/.test(ready.prompt.text) && !!ready.near, ready.prompt);
check('上车前无物理刚体（Rapier 仍懒加载）', ready.bodyCount === 0, ready.bodyCount);

// 截图 1：上车提示
await page.evaluate(() => window.__playground.sceneManager.setPaused(true));
await page.evaluate(() => {
  const pg = window.__playground, cam = pg.sceneManager.camera, p = pg.attractionManager.active._city.traffic.getParkedPose(0);
  cam.position.set(p.x + 2.8, 3.2, p.z + 2.8);
  cam.rotation.order = 'YXZ';
  cam.lookAt(p.x, 1.6, p.z);
  cam.updateMatrixWorld(true);
  pg.sceneManager.renderOnce();
});
const boardFile = `${OUT_DIR}/phase4-board.png`;
await page.screenshot({ path: boardFile });
shots.push(boardFile);
check('截图：车旁上车提示', fs.existsSync(boardFile), boardFile);
await page.evaluate(() => window.__playground.sceneManager.setPaused(false));
// 截图机位只用于拍照，回到步行位并刷新 nearCar 后再按 E
await page.evaluate(() => {
  const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
  const p = lobby._city.traffic.getParkedPose(0);
  cam.position.set(p.x + 1.5, 1.6, p.z);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(0, p.yaw + Math.PI, 0);
  lobby._wasd.resetFromCamera(cam);
  lobby.update(0.016);
});
await page.keyboard.press('e');
await page.waitForFunction(() => window.__playground.vehicleSystem?.active === true, null, { timeout: 60000 }).catch(() => {});
const seated = await page.evaluate(() => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const d = pg.vehicleSystem;
  lobby.update(0.016);
  const el = document.querySelector('[data-role="drive-hint"]');
  const body = d._body;
  const t = body?.translation();
  const vel = body?.linvel();
  const world = pg.physicsManager.world;
  return {
    state: d.debugState,
    bodyType: body?.bodyType?.(),
    mass: body?.mass?.(),
    colliders: body?.numColliders?.(),
    worldColliders: world?.colliders?.len?.(),
    cam: pg.sceneManager.camera.position.toArray(),
    carPos: t ? [t.x, t.y, t.z] : null,
    vel: vel ? [vel.x, vel.y, vel.z] : null,
    carVisible: !!lobby._city.traffic._playerCar?.group.visible,
    claimed: lobby._city.traffic.claimedCar,
    text: el?.textContent?.replace(/\s+/g, ' ').trim(),
    wasdEnabled: lobby._wasd.isEnabled(),
  };
});
check('E 上车成功并生成完整动态刚体', seated.state.active && seated.bodyType === 0 && seated.colliders >= 1 && seated.mass > 100, seated);
check('AI 车冻结隐藏，玩家车视觉启用', !!seated.claimed && seated.carVisible, { claimed: seated.claimed, carVisible: seated.carVisible });
check('第一人称驾驶相机（高于步行眼高）', seated.cam[1] > 1.9 && Math.abs(seated.cam[1] - (seated.carPos?.[1] + 0.68)) < 0.2, { camY: seated.cam[1], bodyY: seated.carPos?.[1] });
check('12 个 AI 简化包围盒 + 地面/建筑静态 collider 已建立', seated.state.aiBodies === 12 && seated.state.bodyCount === 14, { aiBodies: seated.state.aiBodies, bodies: seated.state.bodyCount, colliders: seated.worldColliders });

// 驾驶：真实 keydown 必须进入控制器；手动推进物理+逻辑（headless rAF 极慢）
await page.keyboard.down('w');
const keys = await page.evaluate(() => window.__playground.vehicleSystem.keys);
const drive = await page.evaluate(() => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const d = pg.vehicleSystem;
  const t0 = d._body.translation();
  for (let i = 0; i < 150; i++) { pg.physicsManager.step(1 / 60); lobby.update(1 / 60); }
  const t1 = d._body.translation();
  const v = d._body.linvel();
  return {
    speed: d.speedKmh,
    distance: Math.hypot(t1.x - t0.x, t1.z - t0.z),
    from: [t0.x, t0.y, t0.z], to: [t1.x, t1.y, t1.z],
    vy: v.y,
    keys: d.keys,
  };
});
await page.keyboard.up('w');
check('W 键被驾驶系统捕获', keys.includes('KeyW'), keys);
check('W 加速：车辆明显位移且速度 > 35km/h', drive.speed > 35 && drive.distance > 8, drive);
check('地面碰撞生效：车辆未穿透地面', drive.to[1] > 1.2 && drive.to[1] < 1.8, { y: drive.to[1] });

// A 转向：yaw 改变，车辆横向移动
await page.keyboard.down('w');
await page.keyboard.down('a');
const steer = await page.evaluate(() => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const d = pg.vehicleSystem;
  const y0 = d._lastYaw;
  const t0 = d._body.translation();
  for (let i = 0; i < 75; i++) { pg.physicsManager.step(1 / 60); lobby.update(1 / 60); }
  const t1 = d._body.translation();
  return { y0, y1: d._lastYaw, dx: t1.x - t0.x, dz: t1.z - t0.z, speed: d.speedKmh };
});
await page.keyboard.up('a');
await page.keyboard.up('w');
check('A 键转向：偏航角与横向轨迹发生变化', Math.abs(steer.y1 - steer.y0) > 0.12 && Math.abs(steer.dx) > 0.5, steer);

// 第一人称/第三人称截图（暂停逻辑，防 rAF 覆盖相机）
await page.evaluate(() => window.__playground.sceneManager.setPaused(true));
const firstFile = `${OUT_DIR}/phase4-drive-first.png`;
await page.evaluate(() => { window.__playground.sceneManager.renderOnce(); });
await page.screenshot({ path: firstFile });
shots.push(firstFile);
check('截图：第一人称驾驶位', fs.existsSync(firstFile), firstFile);
const thirdFile = `${OUT_DIR}/phase4-drive-third.png`;
await page.evaluate(() => {
  const pg = window.__playground, d = pg.vehicleSystem, cam = pg.sceneManager.camera;
  const t = d._body.translation();
  const q = d._body.rotation();
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  cam.position.set(t.x - Math.sin(yaw) * 8 - Math.cos(yaw) * 4.2, t.y + 4.2, t.z - Math.cos(yaw) * 8 + Math.sin(yaw) * 4.2);
  cam.rotation.order = 'YXZ';
  cam.lookAt(t.x, t.y + 0.4, t.z);
  cam.updateMatrixWorld(true);
  pg.sceneManager.renderOnce();
});
await page.screenshot({ path: thirdFile });
shots.push(thirdFile);
check('截图：第三人称车辆与城市', fs.existsSync(thirdFile), thirdFile);
await page.evaluate(() => window.__playground.sceneManager.setPaused(false));

const memDrive = await page.evaluate(() => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const r = pg.sceneManager.renderer;
  const t = lobby._city.traffic;
  const src = new Set([t.body.geometry, t.cabin.geometry, t.wheels.geometry]);
  const carGroup = t._playerCar.group;
  const coreParts = carGroup.children.filter((m) => src.has(m.geometry)).length;
  const reusedGeo = coreParts === 6;
  /* 先把相机摆到测量机位并渲染一次：renderer.info.memory 统计的是「已上传到 GPU」
   * 的几何体，城市中尚未进入过视锥的静态物件会在首次可见时才计入。若直接取基线，
   * 这 30 帧内新入镜的既有物件会被误判成驾驶泄漏（实测偶发 +3）。 */
  const placeCam = () => {
    const body = pg.vehicleSystem._body;
    const bt = body.translation(), bq = body.rotation();
    const yaw = Math.atan2(2 * (bq.w * bq.y + bq.x * bq.z), 1 - 2 * (bq.y * bq.y + bq.z * bq.z));
    const cam = pg.sceneManager.camera;
    cam.position.set(bt.x - Math.sin(yaw) * 8 - Math.cos(yaw) * 4.2, bt.y + 4.2, bt.z - Math.cos(yaw) * 8 + Math.sin(yaw) * 4.2);
    cam.rotation.order = 'YXZ';
    cam.lookAt(bt.x, bt.y + 0.4, bt.z);
    cam.updateMatrixWorld(true);
  };
  placeCam();
  pg.sceneManager.renderOnce();
  const before = { ...r.info.memory };
  for (let i = 0; i < 30; i++) { pg.physicsManager.step(1 / 60); lobby.update(1 / 60); }
  placeCam();
  pg.sceneManager.renderOnce();
  const after = { ...r.info.memory };
  return { before, after, dGeo: after.geometries - before.geometries, dTex: after.textures - before.textures, reusedGeo, coreParts, parts: carGroup.children.length };
});
check('玩家车复用主体几何 6 部件；车灯为一次性新增资源', memDrive.reusedGeo && memDrive.parts === 11, { reusedGeo: memDrive.reusedGeo, coreParts: memDrive.coreParts, parts: memDrive.parts });
check('驾驶循环 + 渲染后 Δgeo=0 / Δtex=0', memDrive.dGeo === 0 && memDrive.dTex === 0, memDrive);

// 下车
await page.keyboard.press('e');
const exited = await page.evaluate(() => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const d = pg.vehicleSystem;
  for (let i = 0; i < 4; i++) lobby.update(1 / 60);
  const el = document.querySelector('[data-role="drive-hint"]');
  return {
    state: d.debugState,
    cam: pg.sceneManager.camera.position.toArray(),
    input: lobby._inputMode,
    wasdEnabled: lobby._wasd.isEnabled(),
    carVisible: lobby._city.traffic._playerCar?.group.visible,
    claimed: lobby._city.traffic.claimedCar,
    promptOn: el?.dataset.on,
    promptText: el?.textContent?.replace(/\s+/g, ' ').trim(),
    carY: d._body ? d._body.translation().y : null,
  };
});
check('E 下车：物理刚体与临时 collider 全部清空', !exited.state.active && exited.state.bodyCount === 0 && exited.state.aiBodies === 0, exited.state);
check('下车后 AI 车归还、玩家车隐藏', !exited.claimed && exited.carVisible === false, { claimed: exited.claimed, carVisible: exited.carVisible });
check('恢复第一人称步行：城市地面 1.16m + 眼高 1.6m + WASD 重新启用', Math.abs(exited.cam[1] - 2.76) < 0.1 && exited.wasdEnabled && exited.input === 'wasd', exited);
check('下车后相机回到车旁且重新出现上车提示', exited.promptOn === '1' && /按 E 上车/.test(exited.promptText || ''), { promptOn: exited.promptOn, promptText: exited.promptText, cam: exited.cam });

// 再次上下车：幂等，无刚体残留
await page.keyboard.press('e');
await page.waitForFunction(() => window.__playground.vehicleSystem?.active === true, null, { timeout: 60000 }).catch(() => {});
const second = await page.evaluate(() => window.__playground.vehicleSystem.debugState);
await page.keyboard.press('e');
await page.evaluate(() => {
  const pg = window.__playground, lobby = pg.attractionManager.active;
  for (let i = 0; i < 3; i++) lobby.update(1 / 60);
});
const secondExit = await page.evaluate(() => window.__playground.vehicleSystem.debugState);
check('二次上下车幂等：无重复刚体残留', second.active && second.bodyCount === 14 && !secondExit.active && secondExit.bodyCount === 0, { second, secondExit });

check('运行期零 console error / pageerror', errors.length === 0, errors);

const report = {
  module: 'phase4-driving',
  at: new Date().toISOString(),
  passed: CHECKS.filter((c) => c.pass).length,
  total: CHECKS.length,
  allPass: CHECKS.every((c) => c.pass),
  checks: CHECKS,
  screenshots: shots,
  ready,
  seated,
  drive,
  steer,
  exited,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'verify-driving.json'), JSON.stringify(report, null, 2));
console.log(`DRIVE_RESULT ${report.passed}/${report.total} allPass=${report.allPass}`);
await browser.close();
if (!report.allPass) process.exitCode = 1;

