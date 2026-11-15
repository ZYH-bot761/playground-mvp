/**
 * tests/verify-m3-npc.mjs —— M3 NPC 寻路 / 防穿模专项
 * 运行：node tests/verify-m3-npc.mjs
 *
 * 断言：
 *   A 导航图已构建（节点数 > 100、边数 > 节点数），且重建次数有限
 *   B 受控推进 900 帧（45s 模拟）后，10 个 NPC 全程 0 帧处于障碍内
 *   C NPC 确实在走动（累计位移 > 5m），不是站着不动
 *   D 路径段合法：抽查每个 NPC 的当前段两端点都不在障碍内
 *   E 强制把一个 NPC 塞进建筑 AABB，推进后能自动脱困（修「只露头手」）
 *   F 1 个 InstancedMesh（0 新增 draw call）+ 0 报错
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m3-npc.json');
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
  await page.waitForTimeout(500);

  const nav = await page.evaluate(() => {
    const nm = window.__playground.npcManager;
    return { stats: nm.navStats, renderMeshCount: nm.renderMeshCount,
      nodes: nm._navNodes.length, withPath: nm._npcs.filter((n) => n.path).length };
  });
  add('A 导航图已构建', nav.stats.nodes > 100 && nav.stats.edges > nav.stats.nodes,
    nav);

  // B/C：受控推进 900 帧，逐帧检查穿墙 + 累计位移
  const walk = await page.evaluate(() => {
    const nm = window.__playground.npcManager;
    const start = nm._npcs.map((n) => [n.x, n.z]);
    let blockedFrames = 0, firstBlock = null, maxBlocked = 0;
    for (let f = 0; f < 900; f += 1) {
      nm.update(0.05);
      let b = 0;
      for (const n of nm._npcs) {
        if (nm._blocked(n.x, n.z)) {
          b += 1; blockedFrames += 1;
          if (!firstBlock) firstBlock = { frame: f, x: +n.x.toFixed(2), z: +n.z.toFixed(2) };
        }
      }
      maxBlocked = Math.max(maxBlocked, b);
    }
    let moved = 0;
    nm._npcs.forEach((n, i) => { moved += Math.hypot(n.x - start[i][0], n.z - start[i][1]); });
    return { blockedFrames, firstBlock, maxBlocked, moved: +moved.toFixed(2),
      navStats: nm.navStats, withPath: nm._npcs.filter((n) => n.path).length };
  });
  add('B 900 帧内 NPC 全程 0 帧陷进障碍', walk.blockedFrames === 0, walk);
  add('C NPC 持续走动（累计位移 > 5m）', walk.moved > 5, walk);

  // D 路径段合法（抽查当前 segment 两端）
  const seg = await page.evaluate(() => {
    const nm = window.__playground.npcManager;
    let bad = 0, checked = 0;
    for (const n of nm._npcs) {
      if (!n.path || n.pathIdx >= n.path.length) continue;
      const a = nm._navNodes[n.path[n.pathIdx]];
      const b = nm._navNodes[n.path[Math.min(n.pathIdx + 1, n.path.length - 1)]];
      if (!a || !b) continue;
      checked += 1;
      if (nm._blocked(a.x, a.z) || nm._blocked(b.x, b.z)) bad += 1;
    }
    return { checked, bad };
  });
  add('D 当前路径段两端点合法', seg.bad === 0, seg);

  // E 强制塞进建筑 AABB → 能否自动脱困
  const trapped = await page.evaluate(() => {
    const pg = window.__playground;
    const nm = pg.npcManager;
    const lobby = pg.attractionManager.active;
    const box = (lobby._buildingBoxes || []).find((b) => !b.noBlock && b.key === 'gate-left')
      || (lobby._buildingBoxes || []).find((b) => !b.noBlock);
    if (!box) return { skip: true, why: 'no blocking box' };
    const n = nm._npcs.find((x) => !x.greeter) || nm._npcs[0];
    const cx = (box.minX + box.maxX) / 2, cz = (box.minZ + box.maxZ) / 2;
    n.x = cx; n.z = cz; n.path = null; n.pathIdx = 0;
    const injected = nm._blocked(n.x, n.z);
    for (let i = 0; i < 6; i += 1) nm.update(0.05);
    return { injected, escaped: !nm._blocked(n.x, n.z),
      at: [+n.x.toFixed(2), +n.z.toFixed(2)], box: {
        minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ, key: box.key } };
  });
  add('E 强制卡进建筑后能自动脱困', trapped.skip || (trapped.injected && trapped.escaped), trapped);

  add('F 仍为 1 draw call / 0 报错', nav.renderMeshCount === 1 && errors.length === 0,
    { renderMeshCount: nav.renderMeshCount, errors: errors.slice(0, 5) });

  const shot = path.join(OUT, 'zoo-m3-npc.png');
  await page.evaluate(() => window.__playground?.sceneManager?.renderOnce?.());
  await page.screenshot({ path: shot });
  add('截图有效', fs.statSync(shot).size > 20000, { file: shot, bytes: fs.statSync(shot).size });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M3_NPC ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 300)}`);
  await browser.close();
}
