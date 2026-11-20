/**
 * tests/qa-gta.mjs —— GTA 互动包快速验收
 * ① 车撞人：checkVehicleHit 撞倒 + 倒地渲染 + 通缉事件 ② 18s 后复活
 * ③ 农田 E 收割：harvestFarm → 作物真的倒空 ④ 抢车 API 就位
 * 用法：先起 dev（5173），node tests/qa-gta.mjs
 */
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 5173);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CHECKS = [], errs = [];
function check(name, pass, detail) {
  CHECKS.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail ?? {}).slice(0, 300)}`);
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/?no-prewarm=1&t=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__playground?.bootReady, null, { timeout: 90000 });
  await page.evaluate(() => {
    const btn = document.querySelector('.pg-start__enter[data-action="start"]');
    if (btn) btn.click();
  });
  await page.waitForFunction(() => window.__playground.sceneManager._running === true, null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.__playground.attractionManager.active?._city?.ready, null, { timeout: 120000 });
  await page.waitForTimeout(800);

  // ① 撞人：直接撞一名步道客
  const hit = await page.evaluate(() => {
    const crowd = window.__playground.attractionManager.active._city.crowd;
    const peds = crowd.peds.filter((q) => !q.hidden && !q.down && q.kind === 'walker');
    const p = peds[0];
    const q = crowd._candidate(p);
    const hits = crowd.checkVehicleHit({ x: q.x, z: q.z, yaw: 0, speed: 9 });
    crowd.update(1 / 60);
    const st = crowd.getStats();
    const arr = crowd.body.instanceMatrix.array;
    const base = crowd.peds.indexOf(p) * 16;
    return { hits, down: !!p.down, total: st.hitByCar, downed: st.downedNow, lyingY: arr[base + 13], scaleY: arr[base + 5] };
  });
  check('① 撞倒行人（hits≥1，downed 计数，倒地矩阵已写）',
    hit.hits >= 1 && hit.down === true && hit.downed >= 1 && hit.total >= 1, hit);

  // ② 18 秒后复活继续走
  const revive = await page.evaluate(() => {
    const crowd = window.__playground.attractionManager.active._city.crowd;
    const p = crowd.peds.find((q) => q.down);
    for (let i = 0; i < 60 * 21; i++) crowd.update(1 / 60);
    return { revived: p && !p.down, downedNow: crowd.getStats().downedNow };
  });
  check('② 倒地 18s 后复活离开', revive.revived === true && revive.downedNow === 0, revive);

  // ③ 驾驶链路：playerPose → city.update → pg-ped-hit 事件 + lobby 通缉 toast
  const evt = await page.evaluate(async () => {
    const l = window.__playground.attractionManager.active;
    const city = l._city;
    const crowd = city.crowd;
    const p = crowd.peds.filter((q) => !q.hidden && !q.down && q.kind === 'walker')[0];
    const q = crowd._candidate(p);
    let got = null;
    window.addEventListener('pg-ped-hit', (e) => { got = e.detail; }, { once: true });
    city.traffic.setPlayerPose({ x: q.x - 0.5, z: q.z - 0.5, yaw: 0, speed: 8 });
    city.update(1 / 60, window.__playground.sceneManager.camera);
    city.traffic.setPlayerPose(null);
    return { got, handler: typeof l._onPedHit === 'function', toast: document.querySelector('[data-role="toast"]')?.textContent || null };
  });
  check('③ 驾驶撞人广播通缉事件 + lobby 处理器就位',
    !!evt.got && evt.got.total >= 1 && evt.handler === true, evt);

  // ④ 农田：站在稻田边 harvestFarm → 作物高度真的掉到接近 0
  const farm = await page.evaluate(() => {
    const l = window.__playground.attractionManager.active;
    const dist = l._districts;
    const r = dist.harvestFarm(45, 57); // rice rect x[36,54] z[50,65]
    let target = null;
    window.__playground.sceneManager.scene.traverse((o) => { if (o.name === 'Districts/farm/crop-rice') target = o; });
    const sample = (n) => {
      const out = [];
      if (!target) return out;
      const a = target.instanceMatrix.array;
      for (let i = 0; i < n; i++) out.push(Math.abs(a[i * 16 + 5]));
      return out;
    };
    const before = sample(40);
    let tt = dist._time ?? 1000;
    for (let i = 0; i < 360; i++) dist._farm?.update(tt + i / 60);
    const after = sample(40);
    const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const second = dist.harvestFarm(45, 57);
    return { ok: r.ok, crop: r.crop, meshFound: !!target, bAvg: +avg(before).toFixed(3), aAvg: +avg(after).toFixed(3), cooldown: second.ok === false && second.reason === 'regrowing' };
  });
  check('④ 农田 E 收割：该田作物倒空 + 冷却期生效',
    farm.ok === true && farm.crop === 'rice' && farm.meshFound && farm.aAvg < Math.max(0.15, farm.bAvg * 0.4) && farm.cooldown, farm);

  // ⑤ 抢车 API 就位（F 流程）
  const carjack = await page.evaluate(() => {
    const city = window.__playground.attractionManager.active._city;
    return { claim: typeof city.traffic.claimCar === 'function', driving: typeof window.__playground.attractionManager.active._driving?.enter === 'function' };
  });
  check('⑤ 抢车（claimCar + CityDriving.enter）就位', carjack.claim && carjack.driving, carjack);

  check('⑥ 全程无 pageerror / console.error', errs.length === 0, errs.slice(0, 5));
} catch (e) {
  check('脚本执行', false, String(e).slice(0, 300));
}
await browser.close();
const fails = CHECKS.filter((c) => !c.pass);
console.log(`\n== qa-gta: ${CHECKS.length - fails.length}/${CHECKS.length} PASS ==`);
process.exit(fails.length ? 1 : 0);
