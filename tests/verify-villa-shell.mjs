/**
 * tests/verify-villa-shell.mjs —— Blender 别墅外壳精修资产回归
 *
 * 只验证「都会区商场旁那栋别墅」的外壳资产契约，不重复 villa-door / villa-embed
 * 已覆盖的进门与嵌入视图行为：
 *   ① root 名 City/villa + 8 个 Blender 材质桶 Mesh 就位
 *   ② 外壳总三角面数与导出台账一致（预算内）
 *   ③ 所有 geometry/material 登记进 owned 台账（dispose 可完整释放）
 *   ④ 门板拾取契约（villaDoor / facilityKey / _pickables）
 *   ⑤ 光环与碰撞盒保留
 *   ⑥ 进室内隐藏外壳、退出恢复
 *   ⑦ 0 pageerror / console.error
 *
 * 用法：node tests/verify-villa-shell.mjs（需 5173 dev server）
 */
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CHECKS = [], errs = [];
function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 320)}`);
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

const BUCKETS = ['wall', 'glass', 'frame', 'wood', 'door', 'dark', 'glow', 'green'];

try {
  await page.goto(`http://127.0.0.1:${PORT}/?t=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, { timeout: 30000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /进入游乐场/.test(b.textContent || ''));
    if (btn) btn.click();
  });
  await page.waitForTimeout(400);

  const shell = await page.evaluate((buckets) => {
    const pg = window.__playground;
    const lobby = pg.attractionManager.active;
    const vd = lobby._city?.villaDoor;
    const root = vd?.root;
    if (!root) return { ok: false };
    const meshes = buckets.map(n => root.getObjectByName('City/villa-' + n));
    const tris = meshes.filter(Boolean).reduce((s, m) => {
      const g = m.geometry;
      return s + (g.index ? g.index.count / 3 : g.attributes.position.count / 3);
    }, 0);
    const owned = lobby._city.owned;
    const tracked = meshes.filter(Boolean).every(m =>
      owned.geometries.includes(m.geometry) && owned.materials.includes(m.material));
    const door = root.getObjectByName('City/villa-door');
    return {
      ok: true,
      rootName: root.name,
      found: buckets.filter((n, i) => meshes[i]),
      missing: buckets.filter((n, i) => !meshes[i]),
      tris,
      statsTris: vd.stats?.tris,
      tracked,
      doorFlag: door?.userData?.villaDoor === true,
      facilityKey: door?.userData?.facilityKey ?? null,
      inPickables: lobby._pickables.includes(door),
      ring: !!root.getObjectByName('City/villa-ring'),
      colliders: vd.colliders?.length,
    };
  }, BUCKETS);

  check('① root 名 City/villa + 8 个 Blender 材质桶就位',
    shell.ok && shell.rootName === 'City/villa' && shell.missing.length === 0,
    { found: shell.found, missing: shell.missing });
  check('② 外壳 5612 tris 且与导出台账一致（≤12k 配额）',
    shell.tris === 5612 && shell.statsTris === 5612 && shell.tris <= 12000,
    { tris: shell.tris, stats: shell.statsTris });
  check('③ geometry/material 全登记 owned 台账', shell.tracked, { tracked: shell.tracked });
  check('④ 门板拾取契约（villaDoor / facilityKey / _pickables）',
    shell.doorFlag && shell.facilityKey === 'villa' && shell.inPickables,
    { doorFlag: shell.doorFlag, facilityKey: shell.facilityKey, inPickables: shell.inPickables });
  check('⑤ 光环与碰撞盒保留', shell.ring && shell.colliders === 1,
    { ring: shell.ring, colliders: shell.colliders });

  await page.evaluate(async () => { await window.__playground.onEnterAttraction?.('villa'); });
  await page.waitForTimeout(900);
  const inside = await page.evaluate(() => {
    const s = window.__playground.sceneManager.scene.getObjectByName('City/villa');
    return s ? !!s.visible : null;
  });
  await page.evaluate(async () => { await window.__playground.onExitAttraction?.(); });
  await page.waitForTimeout(900);
  const outside = await page.evaluate(() => {
    const s = window.__playground.sceneManager.scene.getObjectByName('City/villa');
    return s ? !!s.visible : null;
  });
  check('⑥ 进室内隐藏外壳、退出后恢复', inside === false && outside === true,
    { inside, outside });
  check('⑦ 运行期 0 pageerror / console.error', errs.length === 0, errs);
} catch (e) {
  check('验收脚本执行完成', false, String(e));
} finally {
  await browser.close();
}

const pass = CHECKS.filter(c => c.pass).length;
console.log(`\nVILLA_SHELL_RESULT ${pass}/${CHECKS.length} allPass=${pass === CHECKS.length}`);
process.exit(pass === CHECKS.length ? 0 : 1);
