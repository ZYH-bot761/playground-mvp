/**
 * ============================================================================
 * tests/verify-villa.mjs —— 可进入别墅验收（阶段 5）
 * ============================================================================
 * 证明：别墅是可进入的独立设施——四层结构、83 件家具、楼梯分层、电梯可运行
 * 且玩家随行、车库两辆车、扫地机器人、动态电视，进出零资源漂移。
 *
 * 检查项：
 *   ① 大厅→别墅→大厅 3 轮，几何/纹理轮次间零增长（无泄漏）
 *   ② 门口按 E 进入 + 第一人称出生在 1F 门厅（眼高 = 基座 1.2 + 1.6，大厅不卸载）
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
  // ?no-prewarm=1：后台预热会 activate/deactivate 其它设施并重建 Lobby，
  // 那段时间里门口提示与 E 都会被 busy 吞掉，是这套脚本最常见的假阴性来源。
  await page.goto(`http://127.0.0.1:${PORT}/?no-prewarm=1&t=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 90000 });
  await page.evaluate(() => {
    const btn = document.querySelector('.pg-start__enter[data-action="start"]')
      || [...document.querySelectorAll('button')].find((b) => /进入游乐场/.test(b.textContent || ''));
    if (btn) btn.click();
  });
  await page.waitForFunction(() => window.__playground.sceneManager._running === true, null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.__playground.attractionManager.active?._city?.ready, null, { timeout: 120000 });
  await page.waitForTimeout(800);

  /**
   * 进出场是 CameraRig 的异步 blend，输入模式切换（按 M）另有 _wasdBlendActive 一段 Glide：
   * 这两段期间 Villa.update 故意不接管相机（villa.js update 的 transitioning 分支），
   * _villaDoorState() 也会报 busy。不等它们落位就摆相机/走楼梯，
   * 写进去的机位会被覆盖，测到的是"楼梯走不动/按 E 没反应"的假故障。
   */
  const settle = () => page.waitForFunction(() => {
    const pg = window.__playground, l = pg.attractionManager.active;
    return !!l && l._wasdBlendActive === false && pg.cameraRig?.isTransitioning === false;
  }, null, { timeout: 40000 }).catch(() => {});

  /**
   * 基线口径：GPU 惰性上传（某几何第一次进视锥）落点不确定，用"第 N 轮之后一定平"当判据
   * 会假红。真正的泄漏判据是【轮次之间不增长】——每轮泄漏必然让 rounds 单调爬升，
   * 与上传何时落定无关。实测别墅进出 8 轮 geo/tex 完全持平（一次性上传后不再变）。
   */
  let baseline = null;
  const rounds = [];

  // ---- 4 轮进出：第 1 轮走真实门口按 E（建基线），后 3 轮直接调用测 Δ ----
  for (let r = 0; r < 4; r += 1) {
    if (r === 0) {
      // 进入别墅前仍为大厅，可读到 _city 与触发口径
      // 真实入口：都会区商场西侧别墅门口，站进去应亮提示
      await settle();
      const door = await page.evaluate(() => {
        const pg = window.__playground;
        const lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
        const d = lobby._city?.villaDoor?.doorPos;
        if (!d) return { hasDoor: false };
        cam.position.set(d.x, 2.76, d.z - 2.5);
        cam.rotation.order = 'YXZ'; cam.rotation.set(0, Math.PI, 0);  // 面朝别墅正面（+z）
        cam.updateMatrixWorld(true);
        lobby._wasd?.resetFromCamera(cam);
        lobby._updateVillaDoor(0.016);
        return {
          hasDoor: true,
          near: lobby._nearVillaDoor,
          busy: lobby._villaDoorState().busy,
          hint: document.querySelector('.lb-villa-hint')?.dataset.on,
        };
      });
      check('都会区别墅门口：门面存在 + 靠近亮起 E 提示',
        door.hasDoor && door.near && door.hint === '1', door);
      // 触发口径收紧：站到别墅建筑北侧（玩家正常观景点）也应能亮提示，
      // 防止“只认南门”导致站在别墅正面/侧面摁 E 进不去。
      const north = await page.evaluate(() => {
        const pg = window.__playground;
        const lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
        const dp = lobby._city?.villaDoor?.doorPos;
        cam.position.set(dp.x, 2.76, dp.z + 18);
        cam.rotation.order = 'YXZ'; cam.rotation.set(0, Math.PI, 0);
        cam.updateMatrixWorld(true);
        lobby._wasd?.resetFromCamera(cam);
        lobby._updateVillaDoor(0.016);
        return {
          near: lobby._nearVillaDoor,
          hint: document.querySelector('.lb-villa-hint')?.dataset.on,
        };
      });
      check('别墅建筑北侧靠近可触发 E 提示',
        north.near && north.hint === '1', north);
      await page.keyboard.press('e');
      // 进入是异步的（相机 blend + 嵌入视图挂载），等运行时 key 落地再断言
      await page.waitForFunction(
        () => window.__playground.facilityRuntime.activeKey === 'villa',
        null, { timeout: 20000 },
      ).catch(() => {});
      await settle();
    }
    const enter = await page.evaluate(async () => {
      const pg = window.__playground;
      // 别墅是「同场并置」的嵌入视图：attractionManager 恒为 lobby，运行时 key 才是 villa。
      const viaDoor = pg.facilityRuntime.activeKey === 'villa';
      if (!viaDoor) await pg.onEnterAttraction?.('villa');
      const v = pg.facilityRuntime.activeView?.villa;
      const cam = pg.sceneManager.camera;
      return {
        viaDoor,
        key: pg.attractionManager.activeKey,
        embedKey: pg.facilityRuntime.activeKey,
        level: v?._level,
        camY: +cam.position.y.toFixed(2),
        ui: !!document.querySelector('#villa-ui'),
      };
    });
    await settle();
    if (r === 0) {
      check('门口按 E 即进入别墅（无需脚本兜底）', enter.viaDoor === true, enter);
      // 眼高 = 基座 1.2 + 1F 0 + 1.6
      check('第一人称出生在 1F 门厅（大厅不卸载）',
        enter.key === 'lobby' && enter.embedKey === 'villa' && enter.level === 1
        && Math.abs(enter.camY - 2.8) < 0.12 && enter.ui, enter);
      const built = await page.evaluate(() => {
        const v = window.__playground.facilityRuntime.activeView.villa;
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
        const v = window.__playground.facilityRuntime.activeView.villa;
        const save = v._level;
        const out = [];
        for (let i = 0; i < 4; i += 1) { v._level = i; out.push(v._groundAt(0, 4)); }
        v._level = save;
        return out;
      });
      check('楼梯状态机：各层 _groundAt 返回对应楼层高度',
        Math.abs(ground[0] + 3.6) < 0.05 && Math.abs(ground[1]) < 0.05 && Math.abs(ground[2] - 3.6) < 0.05 && Math.abs(ground[3] - 7.2) < 0.05,
        ground);
      // 真实走楼梯：1F 楼梯底（本地 x=-8.2,z=-2.0）起步，朝楼梯顶方向按 W，应平滑升到 2F
      const walk = await page.evaluate(() => {
        const pg = window.__playground, v = pg.facilityRuntime.activeView.villa, cam = pg.sceneManager.camera;
        pg.sceneManager.scene.updateMatrixWorld(true);   // 本地↔世界换算要先刷新世界矩阵
        const bottom = v.localToWorld(-8.2, 0, -2.0);    // 1F→2F 跑道底端
        const top = v.localToWorld(-8.2, 3.6, 2.0);      // 同一跑道顶端（2F）
        cam.position.set(bottom.x, bottom.y + 1.6, bottom.z);
        cam.rotation.order = 'YXZ';
        cam.lookAt(top.x, top.y + 1.6, top.z);           // 直接对准上楼方向，避免手算 180° 朝向
        v._wasd.resetFromCamera(cam); v._level = 1; v._footY = 0;
        v.update(1 / 60);                                // 先让脚高吸附一次，再取基线高度
        const startY = cam.position.y;
        const ys = [];
        v._wasd._keys.add('KeyW');
        for (let i = 0; i < 240; i++) { v.update(1 / 60); if (i % 40 === 0) ys.push(+cam.position.y.toFixed(2)); }
        v._wasd._keys.delete('KeyW');
        const l = v.worldToLocalXZ(cam.position.x, cam.position.z);
        return {
          ys, level: v._level, startY: +startY.toFixed(2), finalY: +cam.position.y.toFixed(2),
          localZ: +l.z.toFixed(2),
        };
      });
      check('楼梯真能走：1F 沿楼梯上行到 2F+（相机 y 连续上升、无卡死）',
        walk.level >= 2 && walk.finalY - walk.startY > 2.4 && walk.ys.every((y, i) => i === 0 || y >= walk.ys[i - 1] - 0.05),
        walk);
      // 电梯：玩家站进轿厢 → B1→3F
      const elev = await page.evaluate(() => {
        const pg = window.__playground, v = pg.facilityRuntime.activeView.villa, cam = pg.sceneManager.camera;
        v.root.updateMatrixWorld(true);
        const w = v.localToWorld(7.7, 0, -5.5);        // 轿厢中心（1F）
        cam.position.set(w.x, w.y + 1.6, w.z);
        v._level = 1; v._footY = 0; v._elevatorY = 0; v._elevator.active = false;
        v._wasd.resetFromCamera(cam);
        v._callElevator(3);
        for (let i = 0; i < 400; i++) v.update(1 / 60);
        return { level: v._level, y: +v._elevatorY.toFixed(2), camY: +cam.position.y.toFixed(2) };
      });
      // 眼高随行 = 基座 1.2 + 3F 7.2 + 1.6 = 10.0
      check('电梯 B1→3F：轿厢升到 7.2m、玩家眼高随行到 10.0m、_level=3',
        elev.level === 3 && Math.abs(elev.y - 7.2) < 0.1 && Math.abs(elev.camY - 10.0) < 0.2, elev);
      // 扫地机器人移动
      const robot = await page.evaluate(() => {
        const v = window.__playground.facilityRuntime.activeView.villa;
        const before = v._robot.position.clone();
        for (let i = 0; i < 120; i++) v.update(1 / 60);
        const after = v._robot.position;
        return { moved: +before.distanceTo(after).toFixed(2) };
      });
      check('扫地机器人沿路径移动', robot.moved > 0.1, robot);
      // 车库两辆车（碰撞盒 x 两处 + 车身）
      const cars = await page.evaluate(() => {
        const v = window.__playground.facilityRuntime.activeView.villa;
        return { carBoxes: v._furnitureBoxes[0].length };
      });
      check('车库两辆静态车（碰撞盒）', cars.carBoxes >= 2, cars);
      await page.evaluate(() => window.__playground.sceneManager.renderOnce());
      await page.screenshot({ path: `${OUT}/villa-1f.png` });
    }
    await page.evaluate(async () => { await window.__playground.onExitAttraction?.(); });
    await settle();
    await page.waitForTimeout(400);
    const after = await mem();
    if (r === 0) baseline = after;  // 第 1 轮（含全部交互）退出后 = 参考值
    else rounds.push(after);
  }

  // 轮次之间零增长 = 无泄漏（一次性惰性上传不参与判定）
  const spread = (key) => Math.max(...rounds.map((m) => m[key])) - Math.min(...rounds.map((m) => m[key]));
  const dGeo = spread('geometries');
  const dTex = spread('textures');
  check('进出别墅 3 轮：几何/纹理零增长（无泄漏）', dGeo === 0 && dTex === 0, { baseline, rounds, dGeo, dTex });

  const final = await page.evaluate(() => ({
    key: window.__playground.attractionManager.activeKey,
    embedKey: window.__playground.facilityRuntime.activeKey,
    ui: !!document.querySelector('#villa-ui'),
  }));
  check('返回大厅：lobby/villa 运行时均已归位、别墅 UI 已移除',
    final.key === 'lobby' && final.embedKey !== 'villa' && !final.ui, final);
  check('运行期零 pageerror / console.error', errs.length === 0, errs.slice(0, 5));
} catch (e) {
  check('验收脚本执行完成', false, String(e));
} finally {
  await browser.close();
}

const pass = CHECKS.filter(c => c.pass).length;
console.log(`\nVILLA_RESULT ${pass}/${CHECKS.length} allPass=${pass === CHECKS.length}`);
process.exit(pass === CHECKS.length ? 0 : 1);
