/**
 * tests/verify-villa-stairs.mjs —— 三段楼梯固定性验收
 * ① 1F → 2F 上行  ② 1F → B1 下行  ③ 2F → 3F 上行  ④ 3F → 2F 下行
 * ⑤ 楼梯井东侧栏板真的挡住（不能横着走进井里掉下去）
 * 全部要求：脚下高度逐帧连续（单帧落差 ≤0.4m）、最终楼层正确、不卡死
 */
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 5173);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CHECKS = [], errs = [];
const check = (name, pass, detail) => {
  CHECKS.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 260)}`);
};

const browser = await chromium.launch({ executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/?no-prewarm=1&t=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 60000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /进入游乐场/.test(b.textContent || ''));
    if (btn) btn.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(async () => { await window.__playground.onEnterAttraction('villa'); });
  await page.waitForTimeout(300);

  const walk = async (x, y, z, yaw, startLevel, targetLevel) => page.evaluate(({ x, y, z, yaw, startLevel, targetLevel }) => {
    const pg = window.__playground, v = pg.attractionManager.active, cam = pg.sceneManager.camera;
    cam.rotation.order = 'YXZ'; cam.rotation.set(0, yaw, 0);
    v._level = startLevel;
    v._elevatorGrace = 0;
    v._wasd.resetFromCamera(cam);           // 先复位（它会重置眼高）
    cam.position.set(x, y, z);              // 再摆位，避免复位那一下算成“坠落”
    cam.updateMatrixWorld(true);
    const ys = [], xs = [];
    let maxDrop = 0, done = -1;
    v._wasd._keys.add('KeyW');
    for (let i = 0; i < 200; i++) {
      const prev = cam.position.y;
      v.update(1 / 60);
      maxDrop = Math.max(maxDrop, Math.abs(cam.position.y - prev));
      if (i % 10 === 0) { ys.push(+cam.position.y.toFixed(2)); xs.push(+cam.position.x.toFixed(2)); }
      if (targetLevel < 4 && v._level === targetLevel && Math.abs(cam.position.y - 1.6 - [-3.6, 0, 3.6, 7.2][targetLevel]) < 0.15) { done = i; break; }
    }
    v._wasd._keys.delete('KeyW');
    return {
      level: v._level, foot: +(cam.position.y - 1.6).toFixed(2),
      camY: +cam.position.y.toFixed(2), x: +cam.position.x.toFixed(2), z: +cam.position.z.toFixed(2),
      maxDrop: +maxDrop.toFixed(4), frames: done, ys, xs,
    };
  }, { x, y, z, yaw, startLevel, targetLevel });

  // ① 1F 平台 → 上行 2F
  const up1 = await walk(-8.2, 1.6, -2.9, Math.PI, 1, 2);
  check('1F→2F 上行：落到 2F 且逐帧连续', up1.level === 2 && Math.abs(up1.foot - 3.6) < 0.25 && up1.maxDrop <= 0.4, up1);

  // ② 1F 平台 → 下行 B1
  const down1 = await walk(-8.2, 1.6, -2.9, 0, 1, 0);
  check('1F→B1 下行：落到 B1 且逐帧连续', down1.level === 0 && Math.abs(down1.foot + 3.6) < 0.25 && down1.maxDrop <= 0.4, down1);

  // ③ 2F 平台 → 上行 3F
  const up2 = await walk(-8.2, 5.2, 2.9, Math.PI, 2, 3);
  check('2F→3F 上行：落到 3F 且逐帧连续', up2.level === 3 && Math.abs(up2.foot - 7.2) < 0.25 && up2.maxDrop <= 0.4, up2);

  // ④ 3F 平台 → 下行 2F
  const down2 = await walk(-8.2, 8.8, 7.9, 0, 3, 2);
  check('3F→2F 下行：落到 2F 且逐帧连续', down2.level === 2 && Math.abs(down2.foot - 3.6) < 0.25 && down2.maxDrop <= 0.4, down2);

  // ⑤ 横穿楼梯井东侧：必须被栏板挡住（不会掉进井里）
  const sideways = await walk(-5.6, 1.6, 0.0, -Math.PI / 2, 1, 9);
  const sideways2 = await walk(-5.6, 1.6, 0.0, Math.PI / 2, 1, 9);
  check('楼梯井东侧栏板挡住（1F 两个方向都进不去）',
    Math.min(sideways.x, sideways2.x) > -6.95 && Math.abs(sideways.camY - 1.6) < 0.35 && Math.abs(sideways2.camY - 1.6) < 0.35 &&
    sideways.z === 0 && sideways2.z === 0,
    { a: sideways, b: sideways2 });

  // ⑥ 站在 1F 大厅各处不动 60 帧，楼层不得自己变（旧版“站着突然掉车库”）
  const idle = await page.evaluate(() => {
    const pg = window.__playground, v = pg.attractionManager.active, cam = pg.sceneManager.camera;
    const spots = [[0.5, 6.0], [-3.2, 1.5], [2.5, -4.0], [-6.0, 4.0], [4.5, 3.0]];
    const bad = [];
    for (const [x, z] of spots) {
      cam.position.set(x, 1.6, z);
      v._wasd.resetFromCamera(cam);
      v._level = 1;
      for (let i = 0; i < 60; i++) v.update(1 / 60);
      if (v._level !== 1 || Math.abs(cam.position.y - 1.6) > 0.05) bad.push({ x, z, lv: v._level, y: +cam.position.y.toFixed(2) });
    }
    return bad;
  });
  check('1F 各处静止 60 帧不自动掉层', idle.length === 0, idle);

  check('运行期零 pageerror / console.error', errs.length === 0, errs.slice(0, 4));
} catch (e) {
  check('脚本执行完成', false, String(e));
} finally {
  await browser.close();
}

const pass = CHECKS.filter(c => c.pass).length;
console.log(`\nVILLA_STAIRS_RESULT ${pass}/${CHECKS.length} allPass=${pass === CHECKS.length}`);
process.exit(pass === CHECKS.length ? 0 : 1);
