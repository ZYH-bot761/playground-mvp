/**
 * 阶段三验收：四季天气
 * - UI 四季按钮 / 材质 lerp / 针叶与阔叶分离
 * - 四类天气粒子全部来自 FireworkSystem 固定对象池，clear 后槽位归零
 * - 切换过程中 geometry / texture 零增长
 * - 四张实机截图（森林视角，时间控制台展开）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT || 5173);
const URL = `http://127.0.0.1:${PORT}/?t=${Date.now()}`;
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT_DIR = 'docs/screenshots';
const CHECKS = [];
const errors = [];
const shots = [];

function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
}

const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGEERROR', e.message); });
page.on('console', (m) => {
  if (m.type() === 'error') { errors.push('console: ' + m.text()); console.log('CONSOLE-ERROR', m.text()); }
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
await page.locator('[data-action="start"]').click();
await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
// 后台预热会短暂卸载/重建 Lobby，等它结束再测量，避免把正常重建误判成泄漏。
await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone === true, null, { timeout: 180000 });
await page.waitForTimeout(300);

const boot = await page.evaluate(() => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const season = pg.seasonCycle;
  return {
    season: season.season,
    patchedGround: lobby._shared.matGround.userData.seasonPatched,
    patchedBroad: lobby._shared.matLeaf.userData.seasonRole,
    patchedConifer: lobby._shared.matLeafConifer.userData.seasonRole,
    targets: season._targets.length,
    buttons: [...document.querySelectorAll('[data-season]')].map((b) => ({ s: b.dataset.season, t: b.textContent, on: b.dataset.on })),
    mem: { ...pg.sceneManager.renderer.info.memory },
  };
});
check('四季按钮齐全且默认春季选中', boot.buttons.length === 4 && boot.buttons[0].on === '1' && boot.season === 'spring', boot.buttons);
check('地面/阔叶/针叶材质已注入且角色分离', boot.patchedGround && boot.patchedBroad === 'broad' && boot.patchedConifer === 'conifer' && boot.targets >= 6, { targets: boot.targets, roles: [boot.patchedBroad, boot.patchedConifer] });

// 点击 UI：秋季按钮必须真正切换 seasonCycle 并同步选中态
await page.evaluate(() => document.querySelector('[data-season="autumn"]')?.click());
const uiSwitch = await page.evaluate(() => ({
  season: window.__playground.seasonCycle.season,
  on: [...document.querySelectorAll('[data-season]')].map((b) => [b.dataset.season, b.dataset.on]),
}));
check('点击「秋」切换季节并同步按钮选中态', uiSwitch.season === 'autumn' && uiSwitch.on.find(([s]) => s === 'autumn')?.[1] === '1', uiSwitch);

// 平滑 lerp：只推进一帧，颜色应严格落在起点与终点之间
const lerp = await page.evaluate(() => {
  const s = window.__playground.seasonCycle;
  s.setSeason('spring');
  s.applyImmediate();
  s.setSeason('autumn');
  const start = s._uniforms.ground.uSeasonColor.value.clone();
  s.update(1 / 60);
  const mid = s._uniforms.ground.uSeasonColor.value.clone();
  const target = s._target.ground.clone();
  for (let i = 0; i < 180; i++) s.update(1 / 60);
  const end = s._uniforms.ground.uSeasonColor.value.clone();
  return {
    start: start.getHexString(), mid: mid.getHexString(), target: target.getHexString(), end: end.getHexString(),
    midDifferent: mid.getHexString() !== start.getHexString() && mid.getHexString() !== target.getHexString(),
    settled: Math.abs(end.r - target.r) + Math.abs(end.g - target.g) + Math.abs(end.b - target.b) < 0.002,
  };
});
check('材质颜色按帧 lerp（非瞬切）', lerp.midDifferent && lerp.settled, lerp);
check('秋季配色：草地黄、阔叶橙红、针叶保持深绿', lerp.end === 'b2a34b', lerp.end);

const autumnRoles = await page.evaluate(() => {
  const s = window.__playground.seasonCycle;
  return {
    ground: s._uniforms.ground.uSeasonColor.value.getHexString(),
    broad: s._uniforms.broad.uSeasonColor.value.getHexString(),
    conifer: s._uniforms.conifer.uSeasonColor.value.getHexString(),
  };
});
check('秋季针叶不与阔叶一起变橙', autumnRoles.broad === 'd65b24' && autumnRoles.conifer === '3c6937', autumnRoles);

// 天气粒子：四种类型都从同一个池发射，清空后槽位全部归还
const weather = await page.evaluate(() => {
  const pg = window.__playground;
  const s = pg.seasonCycle;
  const f = pg.fireworkSystem;
  const out = {};
  for (const [season, kind] of [['spring', 'petal'], ['autumn', 'leaf'], ['winter', 'snow'], ['summer', 'rain']]) {
    s.applyImmediate();
    s.setSeason(season);
    s.applyImmediate();
    f.clearWeather();
    s._emitTimer = 0;
    if (season === 'summer') { s.forceShower(true); s.update(0.016); }
    else s.update(0.016);
    out[season] = { count: f.weatherCount, kind: s.weatherKind, freeTop: f._freeTop, batches: f._batches.filter((b) => b.live).map((b) => b.kind) };
    if (season === 'summer') {
      for (let i = 0; i < 30; i++) s.update(1 / 60);
      out.summer.rainUniform = s._uniforms.ground.uRain.value;
      out.summer.countLater = f.weatherCount;
    }
  }
  f.clearWeather();
  out.cleared = { count: f.weatherCount, freeTop: f._freeTop };
  return out;
});
check('春/秋/冬分别发射花瓣/落叶/雪花', weather.spring.count > 0 && weather.autumn.count > 0 && weather.winter.count > 0, weather);
check('夏季阵雨开启地面波纹并发射雨滴', weather.summer.kind === 'rain' && weather.summer.count > 0 && weather.summer.rainUniform > 0.8, weather.summer);
check('clearWeather 后天气粒子与槽位全部归还对象池', weather.cleared.count === 0 && weather.cleared.freeTop === 3000, weather.cleared);

// 池上限：连续发射也不得超过 760
const cap = await page.evaluate(() => {
  const pg = window.__playground;
  const s = pg.seasonCycle;
  const f = pg.fireworkSystem;
  s.setSeason('winter'); s.applyImmediate();
  f.clearWeather();
  for (let i = 0; i < 240; i++) { s._emitTimer = 0; s.update(0.05); }
  const peak = f.weatherCount;
  f.clearWeather();
  return { peak, cleared: f.weatherCount, freeTop: f._freeTop };
});
check('天气粒子复用对象池且峰值 ≤760', cap.peak > 0 && cap.peak <= 760 && cap.cleared === 0 && cap.freeTop === 3000, cap);

// 四张截图：先暂停 rAF，避免 OrbitControls 在 evaluate 返回与截图之间把相机拉回。
await page.evaluate(() => window.__playground.sceneManager.setPaused(true));
const views = {
  spring: { primary: 'petal' },
  summer: { primary: 'rain' },
  autumn: { primary: 'leaf' },
  winter: { primary: 'snow' },
};
for (const season of ['spring', 'summer', 'autumn', 'winter']) {
  const info = await page.evaluate(({ season, primary }) => {
    const pg = window.__playground;
    const s = pg.seasonCycle;
    const f = pg.fireworkSystem;
    const cam = pg.sceneManager.camera;
    s.setSeason(season); s.applyImmediate();
    if (season === 'summer') s.forceShower(true);
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    f.clearWeather();
    for (let i = 0; i < 3; i++) {
      f.emitWeather(primary, { x: cam.position.x, y: cam.position.y - 8, z: cam.position.z }, 28);
      f.update(0.035);
    }
    // 展开时间控制台
    const box = document.querySelector('[data-role="time-box"]');
    if (box?.dataset.open !== 'true') document.querySelector('[data-role="time-toggle"]')?.click();
    cam.position.set(-20, 22, 104);
    cam.rotation.order = 'YXZ';
    cam.lookAt(-66, 5, 66);
    cam.updateMatrixWorld(true);
    pg.sceneManager.renderOnce();
    return { weather: s.weatherKind, count: f.weatherCount, mem: { ...pg.sceneManager.renderer.info.memory }, calls: pg.sceneManager.renderer.info.render.calls, cam: cam.position.toArray() };
  }, { season, primary: views[season].primary });
  const file = `${OUT_DIR}/phase3-${season}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  check(`截图 ${season}（${info.weather}）`, fs.existsSync(file), info);
}

// 零新增 GPU 资源：四套材质与四类天气都渲染过后，再切换 8 次并渲染。
const memory = await page.evaluate(() => {
  const pg = window.__playground;
  const s = pg.seasonCycle;
  const f = pg.fireworkSystem;
  const r = pg.sceneManager.renderer;
  const before = { ...r.info.memory };
  for (const season of ['spring', 'summer', 'autumn', 'winter', 'spring', 'winter', 'summer', 'autumn']) {
    s.setSeason(season); s.applyImmediate();
    for (let i = 0; i < 4; i++) s.update(1 / 60);
    pg.sceneManager.renderOnce();
  }
  const after = { ...r.info.memory };
  f.clearWeather();
  return { before, after, dGeo: after.geometries - before.geometries, dTex: after.textures - before.textures };
});
check('8 次季节切换后 Δgeo=0 / Δtex=0（无泄漏）', memory.dGeo === 0 && memory.dTex === 0, memory);
await page.evaluate(() => window.__playground.sceneManager.setPaused(false));

check('运行期零 console error / pageerror', errors.length === 0, errors);

const report = {
  module: 'phase3-season',
  at: new Date().toISOString(),
  passed: CHECKS.filter((c) => c.pass).length,
  total: CHECKS.length,
  allPass: CHECKS.every((c) => c.pass),
  checks: CHECKS,
  screenshots: shots,
  memory,
  bootMem: boot.mem,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'verify-season.json'), JSON.stringify(report, null, 2));
console.log(`SEASON_RESULT ${report.passed}/${report.total} allPass=${report.allPass}`);
await browser.close();
if (!report.allPass) process.exitCode = 1;
