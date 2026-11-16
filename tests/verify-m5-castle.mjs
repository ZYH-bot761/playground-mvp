/**
 * tests/verify-m5-castle.mjs —— M5 皇堡大门 / 建筑逻辑排布专项
 * 运行：node tests/verify-m5-castle.mjs
 *
 * A v4⑧ 判据保持：Lobby/gate 下 hasArch + towers>=2 + crenels>0
 * B 皇堡体量升级：中央主塔高度 >= 20m、塔楼总数 >= 4、尖顶 >= 3、有旗帜/纹章
 * C 建筑逻辑归组：root.userData.districts 给出中轴/左翼/右翼/后排，9 设施各属其一
 * D 门洞可通行：gate AABB 仍只挡左右两柱，中央 |x|<4 无阻挡
 * E M2 的 trigger 派生关系未被破坏（9 环仍由门位派生）
 * F 预算：相对 M0 基线新增面数 ≤ 5 万 / calls 增量 ≤ 60
 * G 0 报错 + 截图有效
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m5-castle.json');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const errors = [];
const add = (n, ok, d) => checks.push({ name: n, pass: !!ok, detail: d });

const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

try {
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForTimeout(400);

  const d = await page.evaluate(() => {
    const pg = window.__playground;
    const root = pg.sceneManager.scene.getObjectByName('Lobby');
    const gate = root.getObjectByName('Lobby/gate');
    const names = [];
    gate.traverse((o) => names.push(o.name));
    const tiers = [];
    gate.traverse((o) => {
      if (!o.isMesh) return;
      const box = new (o.geometry.boundingBox?.constructor || Object)();
      void box;
      tiers.push({ name: o.name, y: o.position.y, sy: o.scale.y,
        worldTop: o.position.y + (o.geometry?.parameters?.height || 1) * o.scale.y / 2 });
    });
    const boxes = (pg.attractionManager.active._buildingBoxes || [])
      .filter((b) => String(b.key).startsWith('gate-'));
    const layout = root.userData.layout || [];
    return {
      names, tiers, boxes, layout,
      districts: root.userData.districts || null,
      hasArch: names.some((n) => /arch/i.test(n)),
      towers: names.filter((n) => /tower/i.test(n)).length,
      crenels: names.filter((n) => /crenel|battlement|merlon/i.test(n)).length,
      spires: names.filter((n) => /spire|finial|flag|banner|pennant/i.test(n)).length,
      hasEmblem: names.some((n) => /emblem|coat|shield/i.test(n)),
      children: gate.children.length,
    };
  });

  add('A v4⑧ 判据保持（arch/tower/crenel）',
    d.hasArch && d.towers >= 2 && d.crenels > 0,
    { hasArch: d.hasArch, towers: d.towers, crenels: d.crenels });

  const mainTop = Math.max(...d.tiers.map((t) => t.worldTop || 0));
  add('B 皇堡体量升级（主塔 ≥20m / 塔楼 ≥4 / 尖顶 ≥3 / 纹章）',
    mainTop >= 20 && d.towers >= 4 && d.spires >= 3 && d.hasEmblem,
    { mainTop: +mainTop.toFixed(2), towers: d.towers, spires: d.spires,
      emblem: d.hasEmblem, children: d.children });

  const districts = d.districts;
  const assigned = districts ? Object.values(districts).flat() : [];
  const allAssigned = d.layout.length === 9
    && d.layout.every((f) => assigned.includes(f.key))
    && new Set(assigned).size === assigned.length;
  add('C 建筑逻辑归组（中轴/左翼/右翼/后排，9 设施各属其一）',
    !!districts && Object.keys(districts).length >= 4 && allAssigned,
    { districts, layoutKeys: d.layout.map((f) => f.key) });

  const gateBlocks = d.boxes.filter((b) => b.minX < 4 && b.maxX > -4);
  add('D 门洞中央可通行（AABB 不挡 |x|<4）', gateBlocks.length === 0,
    { gateBoxes: d.boxes, blockingCenter: gateBlocks });

  // E 触发圈派生关系仍成立
  const align = await page.evaluate(() => {
    const root = window.__playground.sceneManager.scene.getObjectByName('Lobby');
    const L = root.userData.layout || [];
    return L.map((f) => {
      const gap = (f.facadeFront ?? f.doorDepth) + 3;
      return Math.abs(f.trigger.x - (f.x + f.doorDir.dx * gap)) < 0.02
        && Math.abs(f.trigger.z - (f.z + f.doorDir.dz * gap)) < 0.02;
    });
  });
  add('E M2 trigger 派生关系未破坏', align.length === 9 && align.every(Boolean), align);

  const base = JSON.parse(fs.readFileSync(path.resolve('tests/redline-baseline.json'), 'utf-8'));
  // 【口径】必须与红线的 standard 基线同机位（renderer.info.render 是当前帧
  // 渲染量，俯瞰机位比近景能看到多得多，直接比会虚报 +176 calls）
  const budget = await page.evaluate((cam) => {
    const sm = window.__playground.sceneManager, r = sm.renderer, old = r.info.autoReset;
    const c = sm.camera;
    const save = { p: c.position.clone(), q: c.quaternion.clone(), f: c.fov };
    c.position.set(...cam.camera);
    c.lookAt(...cam.lookAt);
    c.updateProjectionMatrix();
    r.info.autoReset = false; r.info.reset();
    r.render(sm.scene, c);
    const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    r.info.autoReset = old;
    c.position.copy(save.p); c.quaternion.copy(save.q); c.fov = save.f;
    c.updateProjectionMatrix();
    return out;
  }, base.standard);
  const dCalls = budget.calls - base.standard.calls;
  const dTris = budget.triangles - base.standard.triangles;
  add('F 预算：新增 ≤5万面 / calls 增量 ≤60',
    dTris <= 50000 && dCalls <= 60, { base: base.standard, measured: budget, dCalls, dTris });

  add('G 0 pageerror / console.error', errors.length === 0, errors.slice(0, 5));

  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.camera.up.set(0, 1, 0);
    sm.camera.position.set(0, 9.4, 25);
    sm.camera.lookAt(0, 12.4, 0);
    sm.camera.updateProjectionMatrix();
    sm.renderOnce();
  });
  const shot = path.join(OUT, 'zoo-m5-castle-gate.png');
  await page.screenshot({ path: shot });
  add('截图有效', fs.statSync(shot).size > 20000, { file: shot, bytes: fs.statSync(shot).size });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M5_CASTLE ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 320)}`);
  await browser.close();
}
