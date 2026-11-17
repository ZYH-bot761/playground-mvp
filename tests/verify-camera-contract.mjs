/**
 * ============================================================================
 * tests/verify-camera-contract.mjs —— 相机写者契约验收（阶段 5 工程底座）
 * ============================================================================
 * 证明：项目生产代码里所有相机写操作都经 CameraRig 两条受仲裁通道，
 * 且未登记 / 无 owner 的写者会被拒绝。
 *
 * 检查项：
 *   ① CameraRig 暴露 writePose / allowDirectWrite 受控 API
 *   ② 大厅内两处逐帧写者 owner（lobby / lobby-wasd）已登记
 *   ③ 动物园飞行逐帧写走 writePose（审计计数增长 + 相机确实移动）
 *   ④ 无 owner / 未登记 owner 时 writePose 被拒且相机不变（仲裁守门）
 *   ⑤ 运行期零 pageerror
 *
 * 用法：node tests/verify-camera-contract.mjs
 * ============================================================================
 */
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CHECKS = [];
const errs = [];
const warns = [];
function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
}

const browser = await chromium.launch({
  executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'warning' && /CameraRig|受控直写/.test(m.text())) warns.push(m.text());
});
page.on('pageerror', (e) => errs.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${PORT}/?t=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 30000 });

  const r = await page.evaluate(() => {
    const pg = window.__playground;
    const rig = pg.cameraRig;
    const out = {
      writers: rig.directWriters,
      countBefore: rig.directWriteCount,
      hasWritePose: typeof rig.writePose === 'function',
      hasAllow: typeof rig.allowDirectWrite === 'function',
    };

    // 动物园飞行按钮 → 逐帧受控直写
    const anyBtn = [...document.querySelectorAll('button')].find((b) => /动物园/.test(b.textContent || ''));
    if (anyBtn) {
      const camBefore = pg.sceneManager.camera.position.clone();
      anyBtn.click();
      const lobby = pg.attractionManager.active;
      for (let i = 0; i < 40; i++) lobby.update(1 / 60);
      out.zoo = {
        owner: rig.owner,
        countAfter: rig.directWriteCount,
        camMoved: +pg.sceneManager.camera.position.distanceTo(camBefore).toFixed(3),
      };
    } else out.zoo = null;

    // 无 owner 直写必须被拒
    const saved = rig.owner;
    if (saved) rig.releaseOwner(saved);
    const camB = pg.sceneManager.camera.position.clone();
    const accepted = rig.writePose({ position: [999, 999, 999] });
    const unchanged = pg.sceneManager.camera.position.distanceTo(camB) < 1e-6;
    if (saved) rig.setOwner(saved);
    out.guard = { accepted: accepted === true, unchanged };

    // 未登记 owner 直写必须被拒
    const priorOwner = rig.owner;
    rig.setOwner('__unregistered__');
    const accepted2 = rig.writePose({ position: [123, 123, 123] });
    rig.releaseOwner('__unregistered__');
    if (priorOwner) rig.setOwner(priorOwner);
    out.unregistered = { accepted: accepted2 === true };
    return out;
  });

  check('CameraRig 暴露 writePose / allowDirectWrite 受控 API', r.hasWritePose && r.hasAllow, {
    writePose: r.hasWritePose, allowDirectWrite: r.hasAllow,
  });
  check('大厅内两处逐帧写者 owner 已登记', ['lobby', 'lobby-wasd'].every((k) => r.writers.includes(k)), {
    writers: r.writers,
  });
  check('动物园飞行走受控直写：审计计数增长 + 相机移动',
    r.zoo && r.zoo.countAfter > r.countBefore && r.zoo.camMoved > 1, r.zoo);
  check('无 owner 时 writePose 被拒且相机不变', !r.guard.accepted && r.guard.unchanged, r.guard);
  check('未登记 owner 时 writePose 被拒', !r.unregistered.accepted, r.unregistered);
  check('运行期零 pageerror', errs.length === 0, errs.slice(0, 3));
  check('契约告警仅来自预期守门测试（≤3 条）', warns.length <= 3, warns);
} catch (e) {
  check('探针执行完成', false, String(e));
} finally {
  await browser.close();
}

const pass = CHECKS.filter((c) => c.pass).length;
console.log(`\nCAMERA_CONTRACT_RESULT ${pass}/${CHECKS.length} allPass=${pass === CHECKS.length}`);
process.exit(pass === CHECKS.length ? 0 : 1);
