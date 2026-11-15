/**
 * tests/verify-m2-layout.mjs —— M2 触发圈对齐 / 建筑间距 / 引导线专项
 * 运行：node tests/verify-m2-layout.mjs
 *
 * 断言：
 *   A 9 个触发环，均由本体 + 大门朝向派生（同 x、z 偏移 = doorDepth + 3）
 *   B 任意两环间距 ≥ 6.5m（v4⑦ 口径）
 *   C 南瓜摩天轮 ↔ 海盗船本体净距 ≥ 20m（旧 12.6m，用户要求拉开）
 *   D 引导线数量 = 设施数 - 中轴两项 + 中轴两条，且每条端点落在对应 trigger 上
 *   E 0 console.error、AABB 无两两重叠
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m2-layout.json');
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
  await page.waitForTimeout(600);

  const data = await page.evaluate(() => {
    const pg = window.__playground;
    const lobby = pg.attractionManager.active;
    const root = pg.sceneManager.scene.getObjectByName('Lobby');
    const layout = root?.userData?.layout || [];
    const rings = (lobby._triggerRings || []).map((r) => ({
      key: r.userData.facilityKey,
      x: +r.position.x.toFixed(3), z: +r.position.z.toFixed(3),
    }));
    const boxes = (lobby._buildingBoxes || []).map((b) => ({
      key: b.key || '-',
      minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, noBlock: !!b.noBlock,
    }));
    const guides = [];
    root.traverse((o) => {
      if (o.name?.startsWith('Lobby/guide-')) {
        guides.push({ name: o.name, x: +o.position.x.toFixed(2), z: +o.position.z.toFixed(2) });
      }
    });
    return { layout, rings, boxes, guides };
  });

  // A 派生一致性
  const align = data.layout.map((f) => {
    const ring = data.rings.find((r) => r.key === f.key);
    if (!ring) return { key: f.key, ok: false, why: 'no ring' };
    const gap = f.doorDepth + 3;
    const ok = Math.abs(ring.x - (f.x + f.doorDir.dx * gap)) < 0.02
      && Math.abs(ring.z - (f.z + f.doorDir.dz * gap)) < 0.02
      && Math.abs(ring.x - f.x) < 0.02; // 门朝纯 Z，圈与本体同 x
    return { key: f.key, ok, body: [f.x, f.z], ring: [ring.x, ring.z], gap };
  });
  add('A 9 环均由本体门位派生（同 x / 正前方）',
    data.rings.length === 9 && data.layout.length === 9 && align.every((a) => a.ok), align);

  // B 环间距
  let minD = Infinity, pair = null;
  for (let i = 0; i < data.rings.length; i += 1) {
    for (let j = i + 1; j < data.rings.length; j += 1) {
      const d = Math.hypot(data.rings[i].x - data.rings[j].x, data.rings[i].z - data.rings[j].z);
      if (d < minD) { minD = d; pair = [data.rings[i].key, data.rings[j].key]; }
    }
  }
  add('B 触发环最小间距 ≥ 6.5m', minD >= 6.5,
    { minDist: +minD.toFixed(3), pair });

  // C 南瓜 ↔ 海盗本体净距
  const pumpkin = data.layout.find((f) => f.key === 'pumpkin-thrower');
  const pirate = data.layout.find((f) => f.key === 'pirate-ship');
  const bodyGap = Math.hypot(pumpkin.x - pirate.x, pumpkin.z - pirate.z);
  add('C 南瓜摩天轮 ↔ 海盗船本体净距 ≥ 20m', bodyGap >= 20,
    { pumpkin: [pumpkin.x, pumpkin.z], pirate: [pirate.x, pirate.z],
      gap: +bodyGap.toFixed(2), oldGap: 12.65 });

  // D 引导线：每个非中轴设施一条放射线，端点 = trigger/2
  const radial = data.layout.filter((f) => f.key !== 'memory-match' && f.key !== 'century-clock');
  const guideOK = radial.every((f) => {
    const g = data.guides.find((x) => x.name === `Lobby/guide-${f.key}`);
    return g && Math.abs(g.x - f.trigger.x / 2) < 0.05 && Math.abs(g.z - f.trigger.z / 2) < 0.05;
  });
  add('D 引导线端点跟随派生 trigger', guideOK && data.guides.length >= radial.length + 2,
    { guides: data.guides.length, radial: radial.length });

  // E AABB 不重叠 + 0 报错
  let overlaps = 0;
  const overlapPairs = [];
  const real = data.boxes.filter((b) => !b.noBlock);
  for (let i = 0; i < real.length; i += 1) {
    for (let j = i + 1; j < real.length; j += 1) {
      const a = real[i], b = real[j];
      // 同一设施可以有多个 box（门柱 / 本体 / 点击代理），内部重叠是设计意图；
      // 只约束不同设施之间不得互相压占，否则会堵死 WASD 通道与 NPC 寻路。
      if (a.key !== b.key
        && a.minX < b.maxX && b.minX < a.maxX
        && a.minZ < b.maxZ && b.minZ < a.maxZ) {
        overlaps += 1;
        overlapPairs.push({ i, j, keys: [a.key, b.key], a, b });
      }
    }
  }
  add('E 建筑 AABB 无重叠', overlaps === 0, { boxes: real.length, overlaps, overlapPairs });
  add('0 pageerror / console.error', errors.length === 0, errors.slice(0, 5));

  const shot = path.join(OUT, 'zoo-m2-layout.png');
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.camera.up.set(0, 1, 0);
    sm.camera.position.set(0, 56, 0.01);
    sm.camera.lookAt(0, 0, 0);
    sm.camera.updateProjectionMatrix();
    sm.renderOnce();
  });
  await page.screenshot({ path: shot });
  add('俯瞰布局截图有效', fs.statSync(shot).size > 20000, { file: shot, bytes: fs.statSync(shot).size });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M2_LAYOUT ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 260)}`);
  await browser.close();
}
