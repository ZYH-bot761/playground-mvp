/**
 * tests/verify-villa-door.mjs —— 都会区别墅门口交互验收（修复回归）
 * ============================================================================
 * 复现并守住「走到家门口按 E 没反应」这一类问题：
 *   ① WASD 第一人称站门口按 E → 进入 1F
 *   ② 地面漫游（F×2，MovementMode 接管）按 E → 同样能进（旧版被 isEngaged 拦死）
 *   ③ 飞行漫游（F×1）按 E → 不进入，但给出「先按 F 切回地面」的 toast
 *   ④ 站在别墅旁但没到触发圈（12m）按 E → 不进入，给出「再走近一点」的 toast
 *   ⑤ 点提示条 → 进入（手机无键盘可用）
 *   ⑥ 门洞已接入点击拾取（key=villa，走独立入口分支）
 *   ⑦ 退出后回大厅、机位还原、可再次按 E 进入（状态无残留）
 *   ⑧ 0 pageerror / console.error
 *
 * 用法：node tests/verify-villa-door.mjs   （需 dev server 先启动）
 */
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const CHECKS = [];
const errs = [];
function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)}`);
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });

const read = (page) => page.evaluate(() => {
  const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
  return {
    key: pg.attractionManager.activeKey,
    // 【v3 同场并置】别墅是嵌入视图：大厅常驻，所以「是否在家」看 facilityRuntime.activeKey
    embed: pg.facilityRuntime?.activeKey ?? null,
    mode: lobby?._inputMode,
    near: lobby?._nearVillaDoor,
    hint: document.querySelector('.lb-villa-hint')?.dataset.on,
    hintText: document.querySelector('.lb-villa-hint')?.textContent,
    engaged: pg.movementMode.isEngaged(),
    mM: pg.movementMode.mode,
    cam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
  };
});

async function boot() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/?t=${Date.now()}&no-prewarm=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 60000 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /进入游乐场/.test(x.textContent || ''));
    b?.click();
  });
  // 后台预热会 activate/deactivate 其它设施并重建 Lobby，期间按键不属于门口交互。
  // 本脚本用 ?no-prewarm=1 把这段噪声直接关掉（main.js 中的 QA 钩子）。
  await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone, { timeout: 20000 });
  await page.waitForTimeout(500);
  return page;
}

/** 把相机放到 (-30, y, z)，朝向 +z（别墅正面） */
const setCam = (page, z, y) => page.evaluate(({ z, y }) => {
  const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
  cam.position.set(-30, y, z);
  cam.rotation.order = 'YXZ'; cam.rotation.set(0, Math.PI, 0);
  cam.updateMatrixWorld(true);
  lobby._wasd?.resetFromCamera(cam);
}, { z, y });

/** 等输入模式切换的相机 blend / 过渡结束（2.2s 固定等待在低帧率下不够） */
const settle = (page) => page.waitForFunction(() => {
  const pg = window.__playground, l = pg.attractionManager.active;
  return !!l && l._wasdBlendActive === false && pg.cameraRig.isTransitioning === false;
}, { timeout: 8000 }).catch(() => {});

/** 等门口提示亮起（渲染帧稀疏时固定 sleep 不可靠） */
const waitHint = (page) => page.waitForFunction(
  () => document.querySelector('.lb-villa-hint')?.dataset.on === '1', { timeout: 6000 }).catch(() => {});

const pressE = async (page) => { await page.keyboard.press('e'); await page.waitForTimeout(800); };

/* ① WASD 第一人称 */
{
  const page = await boot();
  await page.keyboard.press('m');
  await settle(page);
  await setCam(page, 125.4, 2.76);
  await waitHint(page);
  const before = await read(page);
  await pressE(page);
  const after = await read(page);
  check('① WASD 第一人称站门口按 E 进入 1F', after.embed === 'villa' && after.key === 'lobby' && before.hint === '1', { before, after });
  await page.close();
}

/* ② 地面漫游（MovementMode 接管） */
{
  const page = await boot();
  await page.keyboard.press('f');
  await page.waitForTimeout(400);
  await page.keyboard.press('f');
  await settle(page);
  await setCam(page, 125.4, 1.6);
  const before = await read(page);
  await pressE(page);
  const after = await read(page);
  check('② 地面漫游（F×2）按 E 也能进入（不再被漫游层拦死）',
    before.engaged && before.mM === 'ground' && after.embed === 'villa', { before, after });
  await page.close();
}

/* ③ 飞行漫游：拒绝 + 明确提示（同一 tick 内取结果，避开低帧率下的相机漂移） */
{
  const page = await boot();
  await page.keyboard.press('f');
  await settle(page);
  const r = await page.evaluate(() => {
    const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
    cam.position.set(-30, 30, 125.4);
    cam.updateMatrixWorld(true);
    const entered = lobby._tryEnterVilla();
    return { entered, toast: lobby._ui.toast?.textContent ?? null, key: pg.attractionManager.activeKey, mM: pg.movementMode.mode, engaged: pg.movementMode.isEngaged() };
  });
  check('③ 飞行漫游按 E 不进入，但提示「先按 F 切回地面」',
    r.engaged && r.mM === 'flight' && r.entered === false && r.key === 'lobby' && /切回地面/.test(r.toast || ''), r);
  await page.close();
}

/* ④ 站在别墅旁但没进触发圈：给出「再走近一点」而不是静默 */
{
  const page = await boot();
  await page.keyboard.press('m');
  await settle(page);
  const r = await page.evaluate(() => {
    const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
    cam.position.set(-30, 2.76, 113.5); // 距 AABB 约 12.5m
    cam.updateMatrixWorld(true);
    const entered = lobby._tryEnterVilla();
    return { entered, toast: lobby._ui.toast?.textContent ?? null, key: pg.attractionManager.activeKey };
  });
  check('④ 距门口 12m 按 E 不进入，但提示「再走近一点」',
    r.entered === false && r.key === 'lobby' && /再走近一点/.test(r.toast || ''), r);
  await page.close();
}

/* ⑤ 点提示条进入 */
{
  const page = await boot();
  // orbit 模式：把 target 一起挪到别墅，否则 OrbitControls 会把相机按
  // maxDistance 拉回原点（瞬移会被下一帧的 controls.update() 推翻）
  await page.evaluate(() => {
    const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
    lobby._controls.target.set(-30, 1, 135);
    cam.position.set(-30, 2.4, 125.4);
    lobby._controls.update();
    cam.updateMatrixWorld(true);
  });
  await waitHint(page);
  const before = await read(page);
  await page.evaluate(() => document.querySelector('.lb-villa-hint')?.click());
  await page.waitForTimeout(800);
  const after = await read(page);
  check('⑤ 点提示条可直接进入（手机/鼠标可用）', before.hint === '1' && after.embed === 'villa', { before, after });
  await page.close();
}

/* ⑥ 门洞接线：确认已进入点击拾取，且 key=villa 走独立入口分支 */
{
  const page = await boot();
  const wired = await page.evaluate(() => {
    const lobby = window.__playground.attractionManager.active;
    const door = lobby._city.villaDoor.root.getObjectByName('City/villa-door');
    return { key: door?.userData?.facilityKey ?? null, inPickables: lobby._pickables.includes(door) };
  });
  check('⑥ 门洞已接入点击拾取（key=villa）', wired.key === 'villa' && wired.inPickables, wired);
  await page.close();
}

/* ⑦ 往返闭环：进入→退出→再次按 E */
{
  const page = await boot();
  await page.keyboard.press('m');
  await settle(page);
  await setCam(page, 125.4, 2.76);
  await waitHint(page);
  await pressE(page);
  const inVilla = await read(page);
  await page.evaluate(async () => { await window.__playground.onExitAttraction(); });
  await page.waitForTimeout(1500);
  const back = await read(page);
  await setCam(page, 125.4, 2.76);
  await waitHint(page);
  await pressE(page);
  const again = await read(page);
  check('⑦ 退出后回大厅、机位还原，可再次按 E 进入',
    inVilla.embed === 'villa' && back.embed === null && again.embed === 'villa'
    && Math.abs(back.cam[0] + 30) < 2 && Math.abs(back.cam[2] - 125.4) < 2,
    { inVilla: inVilla.embed, back, again: again.embed });
  await page.close();
}

check('⑧ 运行期零 pageerror / console.error', errs.length === 0, errs.slice(0, 4));

await browser.close();
const pass = CHECKS.filter(c => c.pass).length;
console.log(`\nVILLA_DOOR_RESULT ${pass}/${CHECKS.length} allPass=${pass === CHECKS.length}`);
process.exit(pass === CHECKS.length ? 0 : 1);


