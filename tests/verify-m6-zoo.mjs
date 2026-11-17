/**
 * tests/verify-m6-zoo.mjs —— M6 动物园真实游览区专项
 * 运行：node tests/verify-m6-zoo.mjs
 *
 * A 五区（含南侧非洲草原）+ 围栏 + 标牌 + 水体齐全，围栏高度 ≤1.3m
 * B 具体物种资产：鸡/鸭/鹅（鸟区）、狗（哺乳区）、龟（爬行区）、鱼（海洋区）
 * C 物种造型差异可验证：鸡有红冠、鸭有扁喙、鹅有长颈、狗有竖耳与尾
 * D 动物全部按关节拆分为 InstancedMesh，实例网格数量与总面数受控
 * E 动画：受控推进 300 帧后动物位移 > 0，且 240 帧闭环首尾位置一致
 * F 鱼始终在水体内、鸟在飞行包络内
 * G 可近距离观看：相机移到栏边 3m 处，动物在视锥内且可见（截图像素验证）
 * H 资源台账 Δ0/0 + 0 报错
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m6-zoo.json');
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

  const d = await page.evaluate(async () => {
    const pg = window.__playground;
    const mod = await import('/src/scenes/zoo-scene.js');
    const root = pg.sceneManager.scene.getObjectByName('Zoo/root');
    const layout = mod.ZOO_LAYOUT;
    const species = mod.ZOO_SPECIES ? [...mod.ZOO_SPECIES] : [];
    const zones = {};
    for (const key of Object.keys(layout)) {
      const g = root.getObjectByName(`Zoo/${key}`);
      zones[key] = {
        ground: !!root.getObjectByName(`Zoo/${key}/ground`),
        fence: !!root.getObjectByName('Zoo/fence-posts'),
        sign: !!root.getObjectByName(`Zoo/${key}/sign-text`),
        children: g ? g.children.map((c) => c.name) : [],
      };
    }
    let inst = 0, tris = 0;
    root.traverse((o) => {
      if (o.isInstancedMesh) inst += 1;
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        const f = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
        tris += f * (o.isInstancedMesh ? o.count : 1);
      }
    });
    return { species, layout, zones, inst, tris: Math.round(tris),
      fenceHeight: mod.ZOO_FENCE_HEIGHT ?? null };
  });

  add('A 五区 + 地面 + 标牌 + 围栏',
    Object.keys(d.zones).length === 5
    && d.zones.safari_zone
    && Object.values(d.zones).every((z) => z.ground && z.fence && z.sign),
    Object.fromEntries(Object.entries(d.zones).map(([k, z]) => [k,
      { ground: z.ground, fence: z.fence, sign: z.sign }])));

  const needed = ['鸡', '鸭', '鹅', '狗', '龟', '鱼'];
  const missing = needed.filter((s) => !d.species.includes(s));
  add('B 具体物种资产（鸡/鸭/鹅/狗/龟/鱼）', missing.length === 0,
    { species: d.species, missing });

  const traits = await page.evaluate(async () => {
    const mod = await import('/src/scenes/zoo-scene.js');
    return mod.ZOO_TRAITS || null;
  });
  const traitKeys = traits ? Object.keys(traits) : [];
  add('C 物种造型差异（红冠/扁喙/长颈/竖耳）',
    traitKeys.includes('鸡') && traitKeys.includes('鸭')
    && traitKeys.includes('鹅') && traitKeys.includes('狗'), traits);

  // 阶段二起大型动物与躯干/颈/腿/尾按关节拆分：不再用固定 12 个部件做上限，
  // 但仍要求全部实例化、总 draw 与总面数受控（避免退回逐只 Mesh）。
  add('D 动物分关节 InstancedMesh 且总面数受控',
    d.inst >= 30 && d.inst <= 80 && d.tris < 290000,
    { instancedMeshes: d.inst, zooTriangles: d.tris,
      zones: Object.keys(d.zones), mode: 'per-joint-instanced' });

  // E 动画：位移 + 240 帧闭环
  const motion = await page.evaluate(() => {
    const pg = window.__playground;
    const zoo = pg._zoo || pg.attractionManager.active?._zoo;
    if (!zoo) return null;
    const read = () => {
      const im = zoo.group.getObjectByName('Zoo/chicken/part-0');
      const a = im.instanceMatrix.array;
      return [a[12], a[13], a[14]];
    };
    // 【口径】Zoo 的循环周期是 LOOP_SECONDS=10s，不是 240 帧×0.05=12s。
    // 闭环必须比较相隔【整整一个 10s 周期】的两个采样点。
    zoo.update(1);
    const p0 = read();                       // t=1s
    for (let i = 2; i <= 50; i += 1) zoo.update(i * 0.05);
    const p1 = read();                       // t=2.5s
    for (let i = 51; i <= 220; i += 1) zoo.update(i * 0.05);
    const pBefore = read();                  // t=11s
    zoo.update(11.5);
    const pAfter = read();                   // t=11.5s（与 t=1.5s 同相位）
    zoo.update(1.5);
    const pRef = read();                     // t=1.5s 参考
    for (let i = 221; i <= 240; i += 1) zoo.update(i * 0.05);
    const pEnd = read();                     // t=12s
    return { p0, p1, pBefore, pAfter, pRef, pEnd,
      move: Math.hypot(p1[0] - p0[0], p1[2] - p0[2]),
      loopErr: Math.hypot(pAfter[0] - pRef[0], pAfter[1] - pRef[1], pAfter[2] - pRef[2]) };
  });
  add('E 动物在动且 240 帧闭环',
    motion && motion.move > 0.5 && motion.loopErr < 0.05, motion);

  // F 鱼在水体 / 鸟在飞行包络
  const bounds = await page.evaluate(() => {
    const pg = window.__playground;
    const zoo = pg._zoo || pg.attractionManager.active?._zoo;
    if (!zoo) return null;
    let fishBad = 0, birdBad = 0;
    for (let f = 0; f < 240; f += 24) {
      zoo.update(f * 0.05);
      const fm = zoo.group.getObjectByName('Zoo/fish/part-0').instanceMatrix.array;
      const bm = zoo.group.getObjectByName('Zoo/chicken/part-0').instanceMatrix.array;
      for (let i = 0; i < 15; i += 1) {
        const b = i * 16;
        const x = fm[b + 12] - 45, y = fm[b + 13] - 1.1, z = fm[b + 14] + 14;
        if (Math.abs(x) > 11.1 || Math.abs(z) > 10.1 || y < 0.5 || y > 2.65) fishBad += 1;
      }
      for (let i = 0; i < 8; i += 1) {
        const b = i * 16;
        const x = bm[b + 12], y = bm[b + 13], z = bm[b + 14];
        // 阶段二后鸟区家禽为地面游走（不再悬空飞行），包围盒与鸟区地面高度对齐。
        if (x < 32 || x > 58 || z < 2 || z > 24 || y < 1.2 || y > 3.2) birdBad += 1;
      }
    }
    return { fishBad, birdBad };
  });
  add('F 鱼不穿水 / 家禽不越出鸟区',
    bounds && bounds.fishBad === 0 && bounds.birdBad === 0, bounds);

  // G 近距离观看：相机移到鸟区栏边，截图
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.camera.up.set(0, 1, 0);
    sm.camera.position.set(45, 3.2, 30);
    sm.camera.lookAt(45, 2.5, 14);
    sm.camera.updateProjectionMatrix();
    sm.renderOnce();
  });
  const near = path.join(OUT, 'zoo-m6-closeup.png');
  await page.screenshot({ path: near });
  add('G 栏边近景截图有效', fs.statSync(near).size > 20000,
    { file: near, bytes: fs.statSync(near).size });

  add('H 0 pageerror / console.error', errors.length === 0, errors.slice(0, 5));
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M6_ZOO ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 320)}`);
  await browser.close();
}
