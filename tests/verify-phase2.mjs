/**
 * ============================================================================
 * verify-phase2.mjs —— 阶段二「生态扩张」验收
 * ============================================================================
 * A 森林公园：草坪 / 波纹河 / 拱桥 / InstancedMesh 树林 / 遛狗市民
 * B 动物园：五区、四类大型动物 + 基础动画、道路红线净空、四足落地
 * C 农家乐：3 插秧 + 2 锄地农民，弯腰/挥锄矩阵循环
 * D 预算：新增机位 calls ≤ 900、全部机位 triangles ≤ 300k
 * E 热路径：240 帧 Δgeo=0 / Δtex=0，无每帧新建 GPU 资源
 * F 0 pageerror / console.error + 最终截图
 * ============================================================================
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const OUT = path.resolve('docs/screenshots');
const REPORT = path.resolve('docs/phase2-eco-report.json');
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

const browser = await chromium.launch({
  executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
await page.addInitScript(() => {
  const old = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, a) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') {
      a = Object.assign({}, a, { preserveDrawingBuffer: true });
    }
    return old.call(this, t, a);
  };
});

let report = null;
try {
  await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone === true, null, { timeout: 120000 })
    .catch(() => { /* 预热超时不阻断结构检查 */ });
  await page.waitForTimeout(1200);

  /* ---------------- A/B/C：结构与动作 ---------------- */
  const sceneData = await page.evaluate(async () => {
    const mod = await import('/src/scenes/zoo-scene.js');
    const pg = window.__playground;
    const a = pg.attractionManager.active;
    const scene = pg.sceneManager.scene;
    const forest = a._forest;
    const zoo = a._zoo;
    const dist = a._districts;

    const bbox = (obj, skipInstanced = false) => {
      if (!obj) return null;
      obj.updateWorldMatrix(true, true);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      obj.traverse((o) => {
        if (!o.isMesh) return;
        if (skipInstanced && o.isInstancedMesh) return;
        const g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox, e = o.matrixWorld.elements;
        for (let i = 0; i < 8; i += 1) {
          const x = i & 1 ? bb.max.x : bb.min.x;
          const y = i & 2 ? bb.max.y : bb.min.y;
          const z = i & 4 ? bb.max.z : bb.min.z;
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          lo[0] = Math.min(lo[0], wx); lo[1] = Math.min(lo[1], wy); lo[2] = Math.min(lo[2], wz);
          hi[0] = Math.max(hi[0], wx); hi[1] = Math.max(hi[1], wy); hi[2] = Math.max(hi[2], wz);
        }
      });
      return { min: lo, max: hi };
    };
    const rank = (b, r) => !!b
      && b.min[0] < r.x1 - 0.01 && b.max[0] > r.x0 + 0.01
      && b.min[2] < r.z1 - 0.01 && b.max[2] > r.z0 + 0.01;
    const matSlice = (im, idx = 0) => Array.from(
      im.instanceMatrix.array.slice(idx * 16, idx * 16 + 16),
    );
    const matDiff = (p, q) => p.reduce((m, v, i) => Math.max(m, Math.abs(v - q[i])), 0);
    const instMinY = (im, idx = 0) => {
      im.geometry.computeBoundingBox();
      const b = im.geometry.boundingBox, e = im.instanceMatrix.array;
      const o = idx * 16;
      let minY = Infinity;
      for (let i = 0; i < 8; i += 1) {
        const x = i & 1 ? b.max.x : b.min.x;
        const y = i & 2 ? b.max.y : b.min.y;
        const z = i & 4 ? b.max.z : b.min.z;
        minY = Math.min(minY, e[o + 1] * x + e[o + 5] * y + e[o + 9] * z + e[o + 13]);
      }
      return minY;
    };

    /* ---- A 森林 ---- */
    forest.update(5.0, 0.016);
    const forestGroup = scene.getObjectByName('Lobby/forest-park');
    const trees = scene.getObjectByName('ForestPark/tree-trunks');
    const broad = scene.getObjectByName('ForestPark/tree-crowns-broad');
    const conifer = scene.getObjectByName('ForestPark/tree-crowns-conifer');
    const shrubs = scene.getObjectByName('ForestPark/shrubs');
    const bridge = scene.getObjectByName('ForestPark/arch-bridge');
    const river = scene.getObjectByName('ForestPark/river');
    const lawn = scene.getObjectByName('ForestPark/lawn');
    const npcIm = scene.getObjectByName('ForestPark/citizens');
    const dogIm = scene.getObjectByName('ForestPark/dogs');
    const dogLegs = scene.getObjectByName('ForestPark/dog-legs');
    const bridgeBox = bbox(bridge);
    const riverBefore = river.material.uniforms.uTime.value;
    forest.update(9.5, 0.016);
    const riverAfter = river.material.uniforms.uTime.value;

    const npcBefore = matSlice(npcIm, 0).slice(12, 15);
    const dogBefore = matSlice(dogIm, 0).slice(12, 15);
    const ownedBefore = forest.owned.geometries.length + forest.owned.materials.length + forest.owned.textures.length;
    forest.update(10.5, 1.0);
    const npcAfter = matSlice(npcIm, 0).slice(12, 15);
    const dogAfter = matSlice(dogIm, 0).slice(12, 15);
    const ownedAfter = forest.owned.geometries.length + forest.owned.materials.length + forest.owned.textures.length;
    const moved = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

    const forestData = {
      exists: !!forestGroup,
      lawn: !!lawn,
      river: !!river && river.material?.isShaderMaterial === true,
      riverUniform: [riverBefore, riverAfter],
      bridge: bridgeBox,
      bridgeArchHeight: bridgeBox ? bridgeBox.max[1] - bridgeBox.min[1] : 0,
      trees: trees?.count || 0,
      treesInstanced: !!trees?.isInstancedMesh && !!broad?.isInstancedMesh && !!conifer?.isInstancedMesh,
      shrubs: shrubs?.count || 0,
      walkers: forest._walkers.length,
      dogs: forest._dogs.length,
      dogLegInstances: dogLegs?.count || 0,
      npcMoved: moved(npcBefore, npcAfter),
      dogMoved: moved(dogBefore, dogAfter),
      ownedStable: ownedBefore === ownedAfter,
      bounds: forestGroup?.userData?.forestPark || null,
    };

    /* ---- B 动物园 ---- */
    zoo.update(5.0);
    const zoneGroups = {};
    for (const key of Object.keys(mod.ZOO_LAYOUT)) {
      const g = scene.getObjectByName(`Zoo/${key}`);
      zoneGroups[key] = { box: bbox(g, true), raw: g || null };
    }
    const entry = scene.getObjectByName('Zoo/entry-arch');
    const entryBox = bbox(entry);
    const issues = [];
    const roadN = { x0: 16, x1: 32, z0: -30, z1: 90 }; // 13m 车道 + 两侧 1.5m 人行道
    const roadE = { x0: -30, x1: 90, z0: 19, z1: 35 };
    for (const [key, z] of Object.entries(zoneGroups)) {
      if (rank(z.box, roadN)) issues.push(`${key}:N-S`);
      if (rank(z.box, roadE)) issues.push(`${key}:E-W`);
    }
    if (rank(entryBox, roadN) || rank(entryBox, roadE)) issues.push('entry:road');

    const animalCounts = {};
    for (const a of zoo._animals) animalCounts[a.kind] = (animalCounts[a.kind] || 0) + a.n;
    const large = {};
    for (const kind of ['elephant', 'giraffe', 'lion', 'tiger']) {
      const item = zoo._animals.find((x) => x.kind === kind);
      large[kind] = { n: item?.n || 0, parts: item?.parts.length || 0 };
    }
    const part = (name) => scene.getObjectByName(name);
    zoo.update(5.0);
    const animA = {
      elephant: matSlice(part('Zoo/elephant/part-4')),
      giraffe: matSlice(part('Zoo/giraffe/part-2')),
      lion: matSlice(part('Zoo/lion/part-7')),
      tiger: matSlice(part('Zoo/tiger/part-7')),
    };
    zoo.update(9.2);
    const animB = {};
    for (const k of Object.keys(animA)) animB[k] = matSlice(part(`Zoo/${k}/part-${k === 'elephant' ? 4 : k === 'giraffe' ? 2 : 7}`));
    const animDiff = Object.fromEntries(Object.keys(animA).map((k) => [k, matDiff(animA[k], animB[k])]));

    const groundY = {};
    for (const [kind, idx] of [['elephant', 5], ['giraffe', 6], ['lion', 5], ['tiger', 5]]) {
      groundY[kind] = instMinY(part(`Zoo/${kind}/part-${idx}`));
    }
    const safariBodies = [];
    for (const kind of ['elephant', 'giraffe', 'lion', 'tiger']) {
      const item = zoo._animals.find((x) => x.kind === kind);
      const im = part(`Zoo/${kind}/part-0`);
      for (let i = 0; i < item.n; i += 1) {
        const m = matSlice(im, i);
        safariBodies.push({ kind, x: m[12], z: m[14] });
      }
    }
    const safariBox = mod.ZOO_LAYOUT.safari_zone;
    const safariInside = safariBodies.every((p) => p.x >= safariBox.cx - safariBox.w / 2 - 0.01
      && p.x <= safariBox.cx + safariBox.w / 2 + 0.01
      && p.z >= safariBox.cz - safariBox.h / 2 - 0.01
      && p.z <= safariBox.cz + safariBox.h / 2 + 0.01);
    const trunkBox = bbox(part('Zoo/elephant/part-4'));

    const zooData = {
      zones: Object.keys(zoneGroups).length,
      species: [...mod.ZOO_SPECIES],
      animalCounts,
      large,
      roadIssues: issues,
      northMaxZ: Math.max(zoneGroups.bird_zone.box.max[2], zoneGroups.reptile_zone.box.max[2]),
      entryBox,
      safariBox: bbox(scene.getObjectByName('Zoo/safari_zone'), true),
      safariInside,
      animDiff,
      groundY,
      trunkHeight: trunkBox ? trunkBox.max[1] - trunkBox.min[1] : 0,
      camera: mod.ZOO_VIEW,
    };

    /* ---- C 农民 ---- */
    const wg = scene.getObjectByName('Districts/farm/workers');
    const farmDetail = scene.getObjectByName('Districts/farm/detail');
    const torsoP = scene.getObjectByName('Districts/farm/workers/torso-planters');
    const torsoH = scene.getObjectByName('Districts/farm/workers/torso-hoers');
    const armH = scene.getObjectByName('Districts/farm/workers/arm-r-hoers');
    const hoe = scene.getObjectByName('Districts/farm/workers/hoes');
    const pitchAt = (t) => {
      dist._zoneUpdates.farm(t);
      const m = matSlice(torsoP, 0);
      return Math.atan2(m[6], m[10]);
    };
    const pitches = [];
    for (let t = 0; t < 6.8; t += 0.2) pitches.push(pitchAt(t));
    dist._zoneUpdates.farm(1.1);
    const pA = matSlice(torsoP, 0), hA = matSlice(armH, 0), hoeA = matSlice(hoe, 0);
    dist._zoneUpdates.farm(3.4);
    const pB = matSlice(torsoP, 0), hB = matSlice(armH, 0), hoeB = matSlice(hoe, 0);
    const workerPos = [];
    for (let i = 0; i < 3; i += 1) {
      const m = matSlice(torsoP, i); workerPos.push({ role: 'planter', x: m[12], z: m[14] });
    }
    for (let i = 0; i < 2; i += 1) {
      const m = matSlice(torsoH, i); workerPos.push({ role: 'hoer', x: m[12], z: m[14] });
    }
    const farmData = {
      group: !!wg,
      meshes: wg?.children.length || 0,
      stats: farmDetail?.userData?.farmWorkers || null,
      planterTorsoCount: torsoP?.count || 0,
      hoerTorsoCount: torsoH?.count || 0,
      pitchRange: [Math.min(...pitches), Math.max(...pitches)],
      planterDiff: matDiff(pA, pB),
      hoerArmDiff: matDiff(hA, hB),
      hoeDiff: matDiff(hoeA, hoeB),
      workerPos,
    };

    return { forest: forestData, zoo: zooData, farm: farmData };
  });

  const F = sceneData.forest;
  add('A1 森林公园根 / 草坪 / 波纹河 / 拱桥齐备',
    F.exists && F.lawn && F.river && F.bridgeArchHeight >= 1.0,
    { exists: F.exists, lawn: F.lawn, river: F.river, archHeight: F.bridgeArchHeight });
  add('A2 河水 uTime 随 update 推进', Math.abs(F.riverUniform[1] - 9.5) < 1e-6,
    F.riverUniform);
  add('A3 树林 100+ 且树干/树冠/灌木全部 InstancedMesh',
    F.trees >= 100 && F.treesInstanced && F.shrubs > 0,
    { trees: F.trees, instanced: F.treesInstanced, shrubs: F.shrubs });
  add('A4 4 名市民 + 2 只狗，位置随帧推进',
    F.walkers === 4 && F.dogs === 2 && F.dogLegInstances === 8
      && F.npcMoved > 0.01 && F.dogMoved > 0.01,
    { walkers: F.walkers, dogs: F.dogs, legs: F.dogLegInstances, npcMoved: F.npcMoved, dogMoved: F.dogMoved });
  add('A5 森林热更新不扩张资源台账', F.ownedStable,
    { ownedStable: F.ownedStable, bounds: F.bounds });

  const Z = sceneData.zoo;
  add('B1 动物园扩充为五区 / 十种动物', Z.zones === 5 && Z.species.length === 10,
    { zones: Z.zones, species: Z.species });
  add('B2 四类大型动物齐全且各有动画部件',
    ['elephant', 'giraffe', 'lion', 'tiger'].every((k) => Z.large[k].n >= 1 && Z.large[k].parts >= 7),
    Z.large);
  add('B3 大象长鼻 / 长颈鹿脖 / 狮虎尾巴矩阵随时间变化',
    ['elephant', 'giraffe', 'lion', 'tiger'].every((k) => Z.animDiff[k] > 1e-3),
    Z.animDiff);
  add('B4 大型四足动物踩地（脚底 y≈1.1）',
    Object.values(Z.groundY).every((y) => y >= 1.02 && y <= 1.22),
    Z.groundY);
  add('B5 大型动物全部留在草原展区围栏内',
    Z.safariInside, { inside: Z.safariInside, bodies: Z.safariBox });
  add('B6 动物园建筑与道路净空（北区退到 z≤19，入口移出 x≤32）',
    Z.roadIssues.length === 0 && Z.northMaxZ <= 19.001 && Z.entryBox.min[0] >= 32.4,
    { roadIssues: Z.roadIssues, northMaxZ: Z.northMaxZ, entryMinX: Z.entryBox.min[0] });

  const W = sceneData.farm;
  add('C1 农家乐 3 插秧 + 2 锄地，全部由 InstancedMesh 分关节绘制',
    W.group && W.meshes >= 9 && W.stats?.planters === 3 && W.stats?.hoers === 2
      && W.planterTorsoCount === 3 && W.hoerTorsoCount === 2,
    { meshes: W.meshes, stats: W.stats, planters: W.planterTorsoCount, hoers: W.hoerTorsoCount });
  add('C2 插秧弯腰角在 45°~75°，身体矩阵持续变化',
    W.pitchRange[1] > 0.85 && W.pitchRange[1] - W.pitchRange[0] > 0.25 && W.planterDiff > 1e-3,
    { pitchRange: W.pitchRange, diff: W.planterDiff });
  add('C3 挥锄右臂 / 锄头 / 站位真实循环',
    W.hoerArmDiff > 1e-3 && W.hoeDiff > 1e-3 && W.workerPos.length === 5,
    { armDiff: W.hoerArmDiff, hoeDiff: W.hoeDiff, positions: W.workerPos });

  /* ---------------- D：预算 ---------------- */
  const budget = await page.evaluate(() => {
    const pg = window.__playground, sm = pg.sceneManager, a = pg.attractionManager.active;
    const shots = [
      ['zoo', [60, 33, 24], [60, 2, -14]],
      ['safari', [60, 12, -70], [58, 2, -43]],
      ['forest', [-70, 20, 86], [-70, 2, 67]],
      ['farm', [36, 11, 47], [44, 1.5, 57]],
      ['overview', [0, 30, 34], [0, 2, 0]],
      ['districtOverview', [30, 84, 96], [30, 2, 30]],
    ];
    const saved = sm.camera.position.clone(), q = sm.camera.quaternion.clone();
    const out = {};
    for (const [name, p, t] of shots) {
      sm.camera.position.set(...p); sm.camera.lookAt(...t); sm.camera.updateMatrixWorld(true);
      a._zoo?.update(12); a._forest?.update(12, 0.016);
      a._districts?._zoneUpdates?.farm?.(12);
      sm.renderer.info.autoReset = false; sm.renderer.info.reset();
      sm.renderer.render(sm.scene, sm.camera);
      out[name] = { calls: sm.renderer.info.render.calls, triangles: sm.renderer.info.render.triangles };
    }
    sm.renderer.info.autoReset = true;
    sm.camera.position.copy(saved); sm.camera.quaternion.copy(q);
    return out;
  });
  const contentViews = ['zoo', 'safari', 'forest', 'farm'];
  const contentCalls = Math.max(...contentViews.map((k) => budget[k].calls));
  const maxTris = Math.max(...Object.values(budget).map((v) => v.triangles));
  add('D1 新增内容机位 draw calls ≤ 900',
    contentCalls <= 900, { contentCalls, views: Object.fromEntries(contentViews.map((k) => [k, budget[k].calls])) });
  add('D2 六个机位 triangles ≤ 300k', maxTris <= 300000, { maxTris, views: budget });

  /* ---------------- E：热路径 ---------------- */
  const hot = await page.evaluate(() => {
    const pg = window.__playground, sm = pg.sceneManager, a = pg.attractionManager.active;
    const forest = a._forest, zoo = a._zoo, farm = a._districts?._zoneUpdates?.farm;
    for (let i = 0; i < 3; i += 1) sm.renderOnce();
    const before = { ...sm.renderer.info.memory };
    const arrays = {
      walkers: forest._walkers.length, dogs: forest._dogs.length,
      owned: forest.owned.geometries.length + forest.owned.materials.length + forest.owned.textures.length,
    };
    for (let i = 0; i < 240; i += 1) {
      const t = 20 + i * 0.016;
      forest.update(t, 0.016);
      zoo.update(t);
      farm?.(t);
      if (i % 40 === 0) sm.renderOnce();
    }
    sm.renderOnce();
    const after = { ...sm.renderer.info.memory };
    return {
      before, after, dGeo: after.geometries - before.geometries, dTex: after.textures - before.textures,
      arraysAfter: {
        walkers: forest._walkers.length, dogs: forest._dogs.length,
        owned: forest.owned.geometries.length + forest.owned.materials.length + forest.owned.textures.length,
      },
      arraysBefore: arrays,
    };
  });
  add('E1 240 帧热路径 Δgeo=0 / Δtex=0',
    hot.dGeo === 0 && hot.dTex === 0, hot);
  add('E2 森林行走数组 / 资源台账不增长',
    hot.arraysAfter.walkers === hot.arraysBefore.walkers
      && hot.arraysAfter.dogs === hot.arraysBefore.dogs
      && hot.arraysAfter.owned === hot.arraysBefore.owned,
    { before: hot.arraysBefore, after: hot.arraysAfter });

  /* ---------------- F：截图 ---------------- */
  await page.evaluate(() => {
    const a = window.__playground.attractionManager.active;
    if (a._uiRoot) a._uiRoot.style.display = 'none';
  });
  const shot = async (name, cam, tgt) => {
    await page.evaluate(({ cam, tgt }) => {
      const pg = window.__playground, a = pg.attractionManager.active, sm = pg.sceneManager;
      a._zooFly = null;
      sm.camera.position.set(...cam);
      a._controls.target.set(...tgt);
      sm.camera.lookAt(...tgt);
      a._controls.update();
    }, { cam, tgt });
    await page.waitForTimeout(450);
    const file = path.join(OUT, name);
    await page.screenshot({ path: file });
    return path.relative(path.resolve('.'), file).replaceAll('\\', '/');
  };
  const shots = [];
  shots.push(await shot('phase2-forest.png', [-70, 18, 86], [-70, 2, 67]));
  shots.push(await shot('phase2-zoo.png', [60, 33, 24], [60, 2, -14]));
  shots.push(await shot('phase2-safari.png', [60, 12, -70], [58, 2, -43]));
  shots.push(await shot('phase2-farm.png', [36, 11, 47], [44, 1.5, 57]));
  shots.push(await shot('phase2-overview.png', [30, 84, 96], [30, 2, 30]));
  await page.evaluate(() => {
    const a = window.__playground.attractionManager.active;
    if (a._uiRoot) a._uiRoot.style.display = '';
  });

  add('F1 0 pageerror / console.error', errors.length === 0, errors.slice(0, 6));
  add('F2 截图文件均生成', shots.every((f) => fs.existsSync(path.resolve(f))), shots);

  report = {
    phase: 2,
    title: '生态扩张：森林公园 / 动物升级 / 农家劳作',
    at: new Date().toISOString(),
    pass: checks.filter((c) => c.ok).length,
    total: checks.length,
    allPass: checks.every((c) => c.ok) && errors.length === 0,
    checks,
    scene: sceneData,
    budget,
    hot,
    screenshots: shots,
    errors,
  };
} catch (err) {
  errors.push('FATAL: ' + (err?.stack || String(err)));
  add('测试流程完成', false, String(err));
} finally {
  await browser.close();
}

if (!report) {
  report = {
    phase: 2,
    pass: checks.filter((c) => c.ok).length,
    total: checks.length,
    allPass: false,
    checks,
    errors,
  };
}
report.pass = checks.filter((c) => c.ok).length;
report.total = checks.length;
report.allPass = checks.every((c) => c.ok) && errors.length === 0;
report.errors = errors;
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(`PHASE2 ${report.pass}/${report.total} allPass=${report.allPass}`);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 420)}`);
}
if (errors.length) for (const e of errors.slice(0, 8)) console.log('ERR ' + e);
process.exit(report.allPass ? 0 : 1);
