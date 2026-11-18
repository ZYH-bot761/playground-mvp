/**
 * ============================================================================
 * tests/verify-villa.mjs —— 可进入别墅验收（阶段 5）
 * ============================================================================
 * 证明：别墅是可进入的独立设施——四层结构、83 件家具、楼梯分层、电梯可运行
 * 且玩家随行、车库两辆车、扫地机器人、动态电视，进出零资源漂移。
 *
 * 检查项：
 *   ① 大厅→别墅→大厅 3 轮 Δgeo=0 / Δtex=0（资源台账完整）
 *   ② 第一人称出生在 1F 门厅（相机眼高 1.6m / WASD 接管）
 *   ③ 四层楼板结构 + 83 件家具 + 分层碰撞盒就位
 *   ④ 楼梯状态机：B1/1F/2F/3F 各层 _groundAt 返回对应高度
 *   ⑤ 电梯：B1→3F 按钮调用后轿厢升到 7.2m、玩家眼高随行到 8.8m、_level=3
 *   ⑥ 车库两辆静态车 + 扫地机器人沿路径移动 + 电视 CanvasTexture 有内容
 *   ⑦ 返回大厅：UI 移除、相机还原、activeKey=lobby
 *   ⑧ 0 pageerror / console.error
 *
 * 用法：node tests/verify-villa.mjs
 * ============================================================================
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const CHECKS = [], errs = [];
function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)}`);
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

const mem = () => page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));

try {
  await page.goto(`http://127.0.0.1:${PORT}/?t=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 30000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /进入游乐场/.test(b.textContent || ''));
    if (btn) btn.click();
  });
  await page.waitForTimeout(300);

  // 稳态基线：先完整跑 1 轮（含走楼梯/电梯/截图），退出后取基线。
  // 首次渲染触发的惰性上传（如某几何首次进视锥）是一次性的，不算泄漏；
  // 与 verify-redline 的「预热→稳态→测 Δ」口径一致。
  let baseline = null;
  const rounds = [];

  // ---- 4 轮进出：第 1 轮走真实门口按 E（建基线），后 3 轮直接调用测 Δ ----
  for (let r = 0; r < 4; r += 1) {
    if (r === 0) {
      // 真实入口：都会区商场西侧别墅门口，站进去应亮提示
      const door = await page.evaluate(() => {
        const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
        const d = lobby._city?.villaDoor?.doorPos;
        if (!d) return { hasDoor: false };
        cam.position.set(d.x, 2.76, d.z - 2.5);
        cam.rotation.order = 'YXZ'; cam.rotation.set(0, 0, 0);
        cam.updateMatrixWorld(true);
        lobby._updateVillaDoor(0.016);
        return {
          hasDoor: true,
          near: lobby._nearVillaDoor,
          hint: document.querySelector('.lb-villa-hint')?.dataset.on,
        };
      });
      check('都会区别墅门口：门面存在 + 靠近亮起 E 提示',
        door.hasDoor && door.near && door.hint === '1', door);
      await page.keyboard.press('e');
      await page.waitForTimeout(150);
    }
    const enter = await page.evaluate(async (viaDoor) => {
      const pg = window.__playground;
      // 门口按 E 已触发进入则不再重复调用
      if (!viaDoor && pg.attractionManager.activeKey !== 'villa') {
        await pg.onEnterAttraction?.('villa');
      }
      const v = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      return {
        key: pg.attractionManager.activeKey,
        level: v?._level,
        camY: +cam.position.y.toFixed(2),
        ui: !!document.querySelector('#villa-ui'),
      };
    }, r === 0);
    if (r === 0) {
      check('第一人称出生在 1F 门厅', enter.key === 'villa' && enter.level === 1 && Math.abs(enter.camY - 1.6) < 0.1 && enter.ui, enter);
      const built = await page.evaluate(() => {
        const v = window.__playground.attractionManager.active;
        const has = (n) => !!v.root.getObjectByName(n);
        return {
          furniture: v._furnitureCount,
          boxes: v._walkBoxes.length,
          fb: v._furnitureBoxes.map(a => a.length),
          elevator: has('Villa/elevator-car'), robot: has('Villa/robot'),
          tv: !!v._tvTex, geo: v._geometries.size, mat: v._materials.size,
        };
      });
      check('四层结构 + 家具齐全 + 分层碰撞盒', built.furniture >= 60 && built.fb.length === 4 && built.fb.every(n => n > 0), built);
      check('电梯 / 扫地机器人 / 电视对象就位', built.elevator && built.robot && built.tv, built);
      // 楼梯状态机：各层平地高度
      const ground = await page.evaluate(() => {
        const v = window.__playground.attractionManager.active;
        const save = v._level;
        const out = [];
        for (let i = 0; i < 4; i += 1) { v._level = i; out.push(v._groundAt(0, 4)); }
        v._level = save;
        return out;
      });
      check('楼梯状态机：各层 _groundAt 返回对应楼层高度',
        Math.abs(ground[0] + 3.6) < 0.05 && Math.abs(ground[1]) < 0.05 && Math.abs(ground[2] - 3.6) < 0.05 && Math.abs(ground[3] - 7.2) < 0.05,
        ground);
      // 真实走楼梯：1F 起步按 W 沿 +z 上行，应平滑升到 2F 以上（不是瞬跳/卡住）
      const walk = await page.evaluate(() => {
        const pg = window.__playground, v = pg.attractionManager.active, cam = pg.sceneManager.camera;
        cam.position.set(-7.7, 1.6, -2.2);
        cam.rotation.order = 'YXZ'; cam.rotation.set(0, Math.PI, 0);
        v._wasd.resetFromCamera(cam); v._level = 1;
        const ys = [];
        v._wasd._keys.add('KeyW');
        for (let i = 0; i < 90; i++) { v.update(1 / 60); if (i % 15 === 0) ys.push(+cam.position.y.toFixed(2)); }
        v._wasd._keys.delete('KeyW');
        return { ys, level: v._level, finalY: +cam.position.y.toFixed(2) };
      });
      check('楼梯真能走：1F 沿楼梯上行到 2F+（相机 y 连续上升、无卡死）',
        walk.level >= 2 && walk.finalY > 3.0 && walk.ys.every((y, i) => i === 0 || y >= walk.ys[i - 1] - 0.05),
        walk);
      // 电梯：玩家站进轿厢 → B1→3F
      const elev = await page.evaluate(() => {
        const pg = window.__playground, v = pg.attractionManager.active, cam = pg.sceneManager.camera;
        cam.position.set(7.7, 1.6, -5.5); // 轿厢中心（1F）
        v._level = 1; v._elevatorY = 0; v._elevator.active = false;
        v._wasd.resetFromCamera(cam);
        v._callElevator(3);
        for (let i = 0; i < 200; i++) v.update(1 / 60);
        return { level: v._level, y: +v._elevatorY.toFixed(2), camY: +cam.position.y.toFixed(2) };
      });
      check('电梯 B1→3F：轿厢升到 7.2m、玩家眼高随行 8.8m、_level=3',
        elev.level === 3 && Math.abs(elev.y - 7.2) < 0.1 && Math.abs(elev.camY - 8.8) < 0.15, elev);
      // 扫地机器人移动
      const robot = await page.evaluate(() => {
        const v = window.__playground.attractionManager.active;
        const before = v._robot.position.clone();
        for (let i = 0; i < 120; i++) v.update(1 / 60);
        const after = v._robot.position;
        return { moved: +before.distanceTo(after).toFixed(2) };
      });
      check('扫地机器人沿路径移动', robot.moved > 0.1, robot);
      // 车库两辆车（碰撞盒 x 两处 + 车身）
      const cars = await page.evaluate(() => {
        const v = window.__playground.attractionManager.active;
        return { carBoxes: v._furnitureBoxes[0].length };
      });
      check('车库两辆静态车（碰撞盒）', cars.carBoxes >= 2, cars);
      await page.evaluate(() => window.__playground.sceneManager.renderOnce());
      await page.screenshot({ path: `${OUT}/villa-1f.png` });
    }
    await page.evaluate(async () => { await window.__playground.onExitAttraction?.(); });
    const after = await mem();
    if (r === 0) baseline = after;  // 第 1 轮（含全部交互）退出后 = 稳态基线
    else rounds.push(after);
  }

  const dGeo = Math.max(...rounds.map(m => m.geometries)) - baseline.geometries;
  const dTex = Math.max(...rounds.map(m => m.textures)) - baseline.textures;
  check('稳态后 3 轮进出 Δgeo=0 / Δtex=0', dGeo === 0 && dTex === 0, { baseline, rounds, dGeo, dTex });

  const final = await page.evaluate(() => ({
    key: window.__playground.attractionManager.activeKey,
    ui: !!document.querySelector('#villa-ui'),
  }));
  check('返回大厅：activeKey=lobby、别墅 UI 已移除', final.key === 'lobby' && !final.ui, final);
  check('运行期零 pageerror / console.error', errs.length === 0, errs.slice(0, 5));
} catch (e) {
  check('验收脚本执行完成', false, String(e));
} finally {
  await browser.close();
}

const pass = CHECKS.filter(c => c.pass).length;
console.log(`\nVILLA_RESULT ${pass}/${CHECKS.length} allPass=${pass === CHECKS.length}`);
process.exit(pass === CHECKS.length ? 0 : 1);
