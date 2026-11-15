import { chromium } from 'playwright';
import fs from 'node:fs';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
page.setDefaultNavigationTimeout(300000);
page.setDefaultTimeout(300000);
const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(String(e?.stack || e)));
page.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });

// 从加载起就捕获所有 console，用于证明后台预热从未 activate 旧投篮场景
await page.goto('http://localhost:5176/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__playground, null, { timeout: 300000, polling: 'raf' });
await page.locator('.pg-start__enter').click();
await page.waitForFunction(() => window.__playground?.baselineCalibrated === true
  && window.__playground?.backgroundPrewarmDone === true,
  null, { timeout: 300000, polling: 500 });

const report = {};

/* ---- (e) 最关键：后台预热不误卸大厅 + 跳过旧投篮 key ---- */
report.prewarmSafety = {
  legacyPumpkinActivatedLogs: logs.filter((l) => l.includes('已激活项目「pumpkin-thrower」')),
  skipLogs: logs.filter((l) => l.includes('prewarm("pumpkin-thrower")')),
  prewarmDoneLogs: logs.filter((l) => l.includes('后台分帧预热完成')),
  atRest: await page.evaluate(() => {
    const p = window.__playground;
    return {
      lobbyRootPresent: !!p.sceneManager.scene.getObjectByName('Lobby'),
      lobbyRootParentIsScene: p.sceneManager.scene.getObjectByName('Lobby')?.parent === p.sceneManager.scene,
      activeKey: p.attractionManager.activeKey,
      embeddedKeys: [...p.EMBEDDED_KEYS],
      ferrisWheelKey: p.ferrisWheelKey,
      triggerKeyAliases: p.triggerKeyAliases,
      memory: { ...p.sceneManager.renderer.info.memory },
      baseline: { ...p.baseline },
      backgroundPrewarmDone: p.backgroundPrewarmDone,
      baselineCalibrated: p.baselineCalibrated,
    };
  }),
};

/* ---- (a) 触发环 key → 嵌入摩天轮，Lobby 常驻，无投篮 UI ---- */
report.enter = await page.evaluate(async () => {
  const p = window.__playground;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  p.onEnterAttraction('pumpkin-thrower');
  await frame();
  const view = p.facilityRuntime.activeView;
  const wheel = p.sceneManager.scene.getObjectByName('Lobby/wheel-spin');
  return {
    facilityRuntimeActiveKey: p.facilityRuntime.activeKey,
    attractionManagerActiveKey: p.attractionManager.activeKey,
    lobbyRootParentIsScene: p.sceneManager.scene.getObjectByName('Lobby')?.parent === p.sceneManager.scene,
    lobbyChildren: p.sceneManager.scene.getObjectByName('Lobby')?.children?.length,
    viewClass: view?.constructor?.name,
    viewKey: view?.key,
    isFallback: view?.isFallback,
    wheelSpinFound: !!wheel,
    wheelSpinIsShared: view?.wheelSpin === wheel,
    dayNightActive: p.dayNightCycle.isActive,
    npcActive: p.npcManager.isActive,
    memory: { ...p.sceneManager.renderer.info.memory },
    shootingUi: {
      pumpkinPanel: !!document.querySelector('.pt-ui, .pumpkin-ui, [class*="pumpkin"], [data-role="score"]'),
      bodyHasScore: /得分|金币|投中|投篮|score|coin/i.test(document.body.innerText),
    },
  };
});

/* ---- (c) 轮盘 2 秒内确实在转 + 座舱水平 ---- */
await page.waitForFunction(() => window.__playground?.facilityRuntime?.isTransitioning === false,
  null, { timeout: 120000, polling: 'raf' });
const spinStart = await page.evaluate(() => ({
  angle: window.__playground.sceneManager.scene.getObjectByName('Lobby/wheel-spin').rotation.z,
  t: performance.now(),
}));
await page.waitForTimeout(2000);
const spinEnd = await page.evaluate(() => {
  const p = window.__playground;
  const wheel = p.sceneManager.scene.getObjectByName('Lobby/wheel-spin');
  const cam = p.sceneManager.camera;
  const q = cam.quaternion;
  return {
    angle: wheel.rotation.z,
    t: performance.now(),
    camUp: [cam.up.x, cam.up.y, cam.up.z],
    rightY: 2 * (q.z * q.w + q.x * q.y), // 世界 right 的 y 分量，≈0 表示无 roll
    radiusToCenter: (() => {
      const c = p.facilityRuntime.activeView.wheelCenter;
      return Math.hypot(cam.position.x - c.x, cam.position.y - c.y, cam.position.z - c.z);
    })(),
  };
});
report.spin = {
  angleStart: spinStart.angle,
  angleEnd: spinEnd.angle,
  angleDelta: spinEnd.angle - spinStart.angle,
  elapsedMs: Math.round(spinEnd.t - spinStart.t),
  camUp: spinEnd.camUp,
  rightY: spinEnd.rightY,
  radiusToCenter: spinEnd.radiusToCenter,
};

/* ---- (d) 四个方向真实鼠标拖拽：yaw/pitch 变化、quaternion 变化、up 不变 ---- */
const box = await page.locator('canvas').first().boundingBox();
const cx = Math.round(box.x + box.width / 2);
const cy = Math.round(box.y + box.height / 2);
const beforeDrag = await page.evaluate(() => {
  const v = window.__playground.facilityRuntime.activeView;
  const c = window.__playground.sceneManager.camera;
  return { yaw: v.lookYaw, pitch: v.lookPitch, q: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w] };
});
const drags = [
  { name: 'left', dx: -120, dy: 0 },
  { name: 'right', dx: 120, dy: 0 },
  { name: 'up', dx: 0, dy: -90 },
  { name: 'down', dx: 0, dy: 90 },
];
const dragResults = [];
for (const d of drags) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + d.dx, cy + d.dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const s = await page.evaluate(() => {
    const v = window.__playground.facilityRuntime.activeView;
    const c = window.__playground.sceneManager.camera;
    const q = c.quaternion;
    return {
      yaw: v.lookYaw,
      pitch: v.lookPitch,
      q: [q.x, q.y, q.z, q.w],
      up: [c.up.x, c.up.y, c.up.z],
      rightY: 2 * (q.z * q.w + q.x * q.y),
      activeKey: window.__playground.attractionManager.activeKey,
      stillEmbedded: window.__playground.facilityRuntime.isEmbeddedActive,
    };
  });
  dragResults.push({ dir: d.name, ...s });
}
report.lookAround = {
  before: beforeDrag,
  afterEach: dragResults,
  upAlwaysWorldY: dragResults.every((r) => Math.abs(r.up[1] - 1) < 1e-3 && Math.abs(r.up[0]) < 1e-3 && Math.abs(r.up[2]) < 1e-3),
  noRoll: dragResults.every((r) => Math.abs(r.rightY) < 1e-2),
  yawChanged: dragResults.some((r) => Math.abs(r.yaw - beforeDrag.yaw) > 0.05),
  pitchChanged: dragResults.some((r) => Math.abs(r.pitch - beforeDrag.pitch) > 0.05),
  quaternionChanged: dragResults.some((r) => Math.hypot(...r.q.map((v, i) => v - beforeDrag.q[i])) > 0.01),
  stillEmbeddedThroughout: dragResults.every((r) => r.stillEmbedded && r.activeKey === 'lobby'),
};

/* ---- (b) 截图：座舱内看大厅高空景观 ---- */
const dataUrl = await page.evaluate(() => {
  window.__playground.sceneManager.renderOnce();
  return window.__playground.sceneManager.renderer.domElement.toDataURL('image/png');
});
const png = Buffer.from(dataUrl.split(',')[1], 'base64');
fs.writeFileSync('D:/playground-mvp/docs/screenshots/v4-t04-ferris-embedded.png', png);
report.screenshot = { path: 'docs/screenshots/v4-t04-ferris-embedded.png', bytes: png.length };

/* ---- (f) 5 轮进出 Δ0/0 + 退出回大厅机位误差 <0.01 ---- */
report.rounds = await page.evaluate(async () => {
  const p = window.__playground;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const idle = async () => { for (let i = 0; i < 400 && p.facilityRuntime.isTransitioning; i += 1) await frame(); };
  const cam = p.sceneManager.camera;
  const lobbyPose = [cam.position.x, cam.position.y, cam.position.z];
  // 先退出当前嵌入态，记录大厅机位
  if (p.facilityRuntime.isEmbeddedActive) { p.onExitAttraction(); await idle(); }
  const home = [cam.position.x, cam.position.y, cam.position.z];
  const base = { ...p.baseline };
  const rows = [];
  for (let i = 1; i <= 5; i += 1) {
    p.onEnterAttraction('pumpkin-thrower');
    await idle();
    const during = {
      activeKey: p.attractionManager.activeKey,
      runtimeKey: p.facilityRuntime.activeKey,
      lobbyPresent: !!p.sceneManager.scene.getObjectByName('Lobby'),
      dayNightActive: p.dayNightCycle.isActive,
    };
    p.onExitAttraction();
    await idle();
    rows.push({
      round: i, during,
      after: { activeKey: p.attractionManager.activeKey, lobbyPresent: !!p.sceneManager.scene.getObjectByName('Lobby') },
      dGeo: p.sceneManager.renderer.info.memory.geometries - base.geometries,
      dTex: p.sceneManager.renderer.info.memory.textures - base.textures,
      restoreError: Math.hypot(cam.position.x - home[0], cam.position.y - home[1], cam.position.z - home[2]),
    });
  }
  return { home, base, rows };
});

/* ---- (g) 非嵌入设施不回归 ---- */
report.standalone = await page.evaluate(async () => {
  const p = window.__playground;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const rows = [];
  for (const key of ['carousel', 'parkour-run', 'memory-match']) {
    p.onEnterAttraction(key);
    await frame();
    const entered = {
      activeKey: p.attractionManager.activeKey,
      embeddedActive: p.facilityRuntime.isEmbeddedActive,
      lobbyPresent: !!p.sceneManager.scene.getObjectByName('Lobby'),
    };
    p.onExitAttraction();
    await frame();
    rows.push({ key, entered, exited: {
      activeKey: p.attractionManager.activeKey,
      lobbyPresent: !!p.sceneManager.scene.getObjectByName('Lobby'),
      dGeo: p.sceneManager.renderer.info.memory.geometries - p.baseline.geometries,
      dTex: p.sceneManager.renderer.info.memory.textures - p.baseline.textures,
    } });
  }
  return rows;
});

report.finalGetters = await page.evaluate(() => {
  const p = window.__playground;
  return {
    baselineCalibrated: p.baselineCalibrated,
    emptyBaseline: p.emptyBaseline,
    emptyBaselineCalibrated: p.emptyBaselineCalibrated,
    backgroundPrewarmDone: p.backgroundPrewarmDone,
  };
});
report.errors = errors;
report.consoleErrors = logs.filter((l) => l.startsWith('[error]'));
report.keyLogs = logs.filter((l) =>
  l.includes('pumpkin-thrower') || l.includes('嵌入视图') || l.includes('后台分帧预热完成') || l.includes('[资源计数]'));

await browser.close();
console.log(JSON.stringify(report, null, 2));
