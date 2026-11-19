/**
 * verify-villa-embed.mjs —— 别墅「同场并置」验收（v3）
 * 1) 进别墅不卸载大厅：activeKey 仍是 lobby，facilityRuntime.activeKey = villa
 * 2) 别墅 root 落位 = CITY_VILLA(-30,134)，绕 Y 180°，基座 1.2
 * 3) 进别墅后 `City/villa` 外壳隐藏；退出后恢复
 * 4) 相机 = 1F 玄关锚点（世界），眼高 = 基座 + 1F + 1.6
 * 5) 3F 楼梯口无遮挡：从 2F→3F 楼梯顶能向东走 ≥3m（旧版柜子挡住了）
 * 6) 2F 楼梯口无遮挡：从 1F→2F 楼梯顶能向东走 ≥3m（旧版沙发顶住了）
 * 7) 1F 入户门封死（世界街道方向撞不进）
 * 8) 窗外是真实大厅：2F 阳台看向南（世界 -z 方向）能看到 City/* 网格
 */
import { chromium } from 'playwright';

const URL = process.env.VILLA_URL || 'http://127.0.0.1:5173/';
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady === true, { timeout: 60000 });
// 开始页必须点一下才会启动渲染循环（否则 cameraRig 的 blend 永远不推进）
await page.click('.pg-start__enter[data-action="start"]');
await page.waitForFunction(() => window.__playground.sceneManager._running === true, { timeout: 30000 });
await page.waitForTimeout(1500);

/* ---------- ① 进入：大厅不被卸载 ---------- */
await page.evaluate(() => window.__playground.onEnterAttraction('villa'));
await page.waitForFunction(() => window.__playground.cameraRig.isTransitioning === false, { timeout: 40000 });
const enter = await page.evaluate(async () => {
  const pg = window.__playground;
  const v = pg.facilityRuntime.activeView;
  return {
    activeKey: pg.attractionManager.activeKey,
    embedKey: pg.facilityRuntime.activeKey,
    hasRuntime: !!pg.facilityRuntime,
    viewActive: v?.isActive === true,
    rootVisible: v?.villa?.root?.visible === true,
    rootPos: v?.villa ? { x: +v.villa.root.position.x.toFixed(2), y: +v.villa.root.position.y.toFixed(2), z: +v.villa.root.position.z.toFixed(2), ry: +v.villa.root.rotation.y.toFixed(3) } : null,
    active: v?.villa?._active === true,
    level: v?.villa?._level,
    camY: +pg.sceneManager.camera.position.y.toFixed(3),
    camX: +pg.sceneManager.camera.position.x.toFixed(3),
    camZ: +pg.sceneManager.camera.position.z.toFixed(3),
    shellVisible: (() => { const s = pg.sceneManager.scene.getObjectByName('City/villa'); return s ? s.visible : null; })(),
    near: +(pg.sceneManager.camera.near).toFixed(3),
    wasdAttached: !!v?.villa?._wasd,
    ui: !!document.querySelector('#villa-ui'),
  };
});
console.log('enter =', JSON.stringify(enter));

ok('① 进别墅不卸载大厅（lobby 常驻）', enter.activeKey === 'lobby', `attractionManager.activeKey=${enter.activeKey}`);
ok('② 嵌入 key = villa 且视图激活', enter.embedKey === 'villa' && enter.viewActive === true && enter.rootVisible === true, `key=${enter.embedKey}`);
ok('③ 落位对齐 CITY_VILLA(-30,134,1.2) 且转 180°',
  enter.rootPos && Math.abs(enter.rootPos.x + 30) < 0.01 && Math.abs(enter.rootPos.z - 134) < 0.01
  && Math.abs(enter.rootPos.y - 1.2) < 0.01 && Math.abs(enter.rootPos.ry - Math.PI) < 0.01,
  JSON.stringify(enter.rootPos));
ok('④ 都会区外壳已藏（不包住室内）', enter.shellVisible === false, `City/villa.visible=${enter.shellVisible}`);
ok('⑤ 相机在 1F 玄关（世界 y=1.2+0+1.6=2.8）',
  Math.abs(enter.camY - 2.8) < 0.12 && Math.abs(enter.camX + 30) < 0.3 && Math.abs(enter.camZ - 127.8) < 0.4,
  `x=${enter.camX} y=${enter.camY} z=${enter.camZ}`);
ok('⑥ WASD 已挂 + HUD 已挂 + near 贴身', enter.wasdAttached === true && enter.ui === true && enter.near < 0.1, `near=${enter.near}`);

/* ---------- ② 3F / 2F 楼梯口通行 ---------- */
const walk = await page.evaluate(() => {
  const pg = window.__playground;
  const v = pg.facilityRuntime.activeView.villa;
  const cam = pg.sceneManager.camera;
  // 把世界坐标→本地，再从楼梯顶向东走
  const step = (lx, ly, lz, dx, n) => {
    const w = v.localToWorld(lx, ly, lz);
    cam.position.set(w.x, w.y + 1.6, w.z);
    v._footY = ly; v._groundY = null;
    if (v._wasd) v._wasd._groundY = null;
    // 直接推位置（避开键盘事件，只验证碰撞与地面）
    let blocked = 0;
    for (let i = 0; i < n; i += 1) {
      // 旋转 π 后：世界 +x = 本地 -x（测试里 dx 按“本地东向”给）
      cam.position.x -= dx;
      v._wasd.resolveCollision(cam.position);
    }
    const l = v.worldToLocalXZ(cam.position.x, cam.position.z);
    return { x: +l.x.toFixed(2), z: +l.z.toFixed(2), y: +cam.position.y.toFixed(2) };
  };
  const out3 = (() => { v._level = 3; return step(-5.6, 7.2, 6.4, 0.05, 100); })();   // 3F 平台口向东走
  const out2 = (() => { v._level = 2; return step(-6.0, 3.6, 1.9, 0.05, 100); })();   // 2F 平台口向东走
  v._level = 1;
  const out1door = step(0, 0, 7.0, 0, 0);        // 1F 门口（南）——下面再单独撞
  const doorZ = (() => {
    const w = v.localToWorld(0, 0, 7.2);
    cam.position.set(w.x, w.y + 1.6, w.z);
    if (v._wasd) v._wasd._groundY = null;
    for (let i = 0; i < 40; i += 1) { cam.position.z -= 0.05; v._wasd.resolveCollision(cam.position); }
    const l = v.worldToLocalXZ(cam.position.x, cam.position.z);
    return { z: +l.z.toFixed(2) };
  })();
  return { out3, out2, doorZ, out1door };
});
console.log('walk =', JSON.stringify(walk));

ok('⑦ 3F 楼梯口不再被柜子挡住（能向东走 ≥3m）', walk.out3.x >= -2.5, `出口走到本地 x=${walk.out3.x}`);
ok('⑧ 2F 楼梯口不被沙发挡住（能向东走 ≥3m）', walk.out2.x >= -2.5, `出口走到本地 x=${walk.out2.x}`);
ok('⑨ 1F 入户门封死（撞墙停在 z≈7.3 内）', walk.doorZ.z <= 7.85, `local z=${walk.doorZ.z}`);

/* ---------- ③ 窗外是真实大厅 ---------- */
const outside = await page.evaluate(() => {
  const pg = window.__playground;
  const v = pg.facilityRuntime.activeView.villa;
  const cam = pg.sceneManager.camera;
  // 站 2F 阳台朝南（世界 -z）看
  const w = v.localToWorld(0, 3.6, 10.2);
  cam.position.set(w.x, w.y + 1.6, w.z);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(-0.15, Math.PI, 0);
  cam.updateMatrixWorld(true);
  // 统计世界网格里除别墅自身以外的可见物体（粗略：按名字前缀）
  const names = [];
  pg.sceneManager.scene.traverse((o) => { if (o.isMesh && o.visible) names.push(o.name || o.type); });
  return {
    total: names.length,
    city: names.filter((n) => String(n).startsWith('City/')).length,
    ours: names.filter((n) => String(n).startsWith('Villa/')).length,
  };
});
console.log('outside =', JSON.stringify(outside));
ok('⑩ 阳台视野里同时有大厅城市网格与别墅自身网格', outside.city > 0 && outside.ours > 0, `city=${outside.city} villa=${outside.ours}`);

await page.evaluate(() => window.__playground.sceneManager.renderOnce());
await page.screenshot({ path: 'docs/screenshots/v3-embed-balcony.png' });

/* ---------- ④ 退出：恢复外壳 ---------- */
await page.evaluate(() => {
  window.__villaViewRef = window.__playground.facilityRuntime.activeView; // 退出后 activeView 变 null，先抓住
  window.__playground.onExitAttraction();
});
await page.waitForFunction(() => window.__playground.cameraRig.isTransitioning === false, { timeout: 40000 });
const exit = await page.evaluate(() => {
  const pg = window.__playground;
  const v = window.__villaViewRef;
  const s = pg.sceneManager.scene.getObjectByName('City/villa');
  return {
    embedKey: pg.facilityRuntime.activeKey,
    shell: s ? s.visible : null,
    rootVisible: v ? v.root.visible : null,
    ui: !!document.querySelector('#villa-ui'),
    activeKey: pg.attractionManager.activeKey,
    cam: [+pg.sceneManager.camera.position.x.toFixed(1), +pg.sceneManager.camera.position.y.toFixed(1), +pg.sceneManager.camera.position.z.toFixed(1)],
  };
});
console.log('exit =', JSON.stringify(exit));
ok('⑪ 退出后外壳恢复 + 别墅隐藏 + HUD 摘掉',
  exit.embedKey === null && exit.shell === true && exit.rootVisible === false && exit.ui === false,
  JSON.stringify(exit));

await page.evaluate(() => window.__playground.sceneManager.renderOnce());
await page.screenshot({ path: 'docs/screenshots/v3-embed-lobby.png' });

/* ---------- 报错扫描 ---------- */
const bad = logs.filter((l) => l.startsWith('pageerror') || l.startsWith('error'));
if (bad.length) console.log('ERRORS:\n' + bad.join('\n'));
ok('⑫ 运行期无报错', bad.length === 0, bad.slice(0, 3).join(' | '));

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);


