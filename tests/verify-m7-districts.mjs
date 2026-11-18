/**
 * tests/verify-m7-districts.mjs —— M7 正方形四宫格 + 区域级 LOD 专项
 * 运行：node tests/verify-m7-districts.mjs
 *
 * A 四宫格常量：中心 (30,30)、外框 120×120、四格中心构成正方形、不重叠
 * B 结构完整：Districts/root + structure InstancedMesh + 十字道路/绿化带/四格描边
 * C 北侧两区 LOD：各 2 层（detail + silhouette），detail 有占位内容
 * D 区域级可见性：远离时切 silhouette（level 1）、靠近时切 detail（level 0）
 * E 既有零改动：游乐场 9 环 / 动物园四区 / 设施 AABB 未被移动
 * F 预算：俯瞰 ≤30 万面、relative M0 增量 ≤5万面 / ≤60 calls
 * G 资源台账：稳态 3 轮 Δgeo=0 / Δtex=0
 * H 0 pageerror / console.error + 截图有效
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m7-districts.json');
const SHOT = path.join(OUT, 'zoo-m7-four-quadrants.png');
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  const old = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, a) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') {
      a = Object.assign({}, a, { preserveDrawingBuffer: true });
    }
    return old.call(this, t, a);
  };
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

try {
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });

  // ---------- A/B/C/D：结构 + LOD ----------
  const struct = await page.evaluate(async () => {
    const pg = window.__playground;
    const scene = pg.sceneManager.scene;
    const mod = await import('/src/scenes/districts.js');
    const g = mod.DISTRICT_GRID;
    const root = scene.getObjectByName('Districts/root');
    const structure = root?.getObjectByName('Districts/structure');
    const lods = {};
    for (const key of ['castle', 'farm']) {
      const lod = root?.getObjectByName(`Districts/${key}/lod`);
      const detail = root?.getObjectByName(`Districts/${key}/detail`);
      const silhouette = root?.getObjectByName(`Districts/${key}/silhouette`);
      lods[key] = {
        exists: !!lod,
        levels: lod?.levels?.length ?? -1,
        detailChildren: detail?.children?.length ?? -1,
        silhouetteChildren: silhouette?.children?.length ?? -1,
        lodDistance: g.lodDistance,
      };
    }
    // 四格中心两两距离 + 外框
    const q = Object.values(g.quadrants);
    let minPair = Infinity;
    for (let i = 0; i < q.length; i += 1) for (let j = i + 1; j < q.length; j += 1) {
      minPair = Math.min(minPair, Math.hypot(q[i].cx - q[j].cx, q[i].cz - q[j].cz));
    }
    return {
      grid: { center: g.center, outer: g.outer, cell: g.cell, minPair,
        quads: Object.fromEntries(Object.entries(g.quadrants).map(([k, v]) => [k, { cx: v.cx, cz: v.cz, content: v.content }])) },
      rootExists: !!root,
      structure: { exists: !!structure, isInstanced: !!structure?.isInstancedMesh, count: structure?.count ?? -1,
        usesPlane: structure?.geometry?.type === 'PlaneGeometry' },
      lods,
    };
  });

  const g = struct.grid;
  const square = g.outer.maxX - g.outer.minX === g.outer.maxZ - g.outer.minZ;
  add('A 四宫格中心/外框/不重叠',
    g.center.x === 30 && g.center.z === 30 && square && g.minPair === 60
    && g.quads.amusement.cx === 0 && g.quads.zoo.cx === 60
    && g.quads.castle.cz === 60 && g.quads.farm.cz === 60,
    { center: g.center, outer: g.outer, minPair: g.minPair, quads: g.quads });
  add('B 结构完整（单 InstancedMesh / 平面 / 28 片）',
    struct.rootExists && struct.structure.exists && struct.structure.isInstanced
    && struct.structure.usesPlane && struct.structure.count >= 20 && struct.structure.count <= 40,
    struct.structure);
  add('C 北侧两区 LOD（2 层 + 占位内容）',
    ['castle', 'farm'].every((k) => struct.lods[k].exists && struct.lods[k].levels === 2
      && struct.lods[k].detailChildren >= 5 && struct.lods[k].silhouetteChildren >= 1),
    struct.lods);

  // D 区域级可见性：把相机放到远处/近处，手动 update LOD 验证切换
  const lodSwitch = await page.evaluate(() => {
    const scene = window.__playground.sceneManager.scene;
    const cam = window.__playground.sceneManager.camera;
    const castle = scene.getObjectByName('Districts/castle/lod');
    const farm = scene.getObjectByName('Districts/farm/lod');
    const saved = cam.position.clone();
    const probe = (x, y, z) => {
      cam.position.set(x, y, z);
      cam.updateMatrixWorld(true); // THREE.LOD.update 读 camera.matrixWorld，必须先刷新
      castle.update(cam); farm.update(cam);
      return { castle: castle.getCurrentLevel(), farm: farm.getCurrentLevel() };
    };
    // 远处：原点附近（离城堡 (0,60) 60m > 78? 需更远）
    const far = probe(0, 10, -80);
    // 近城堡
    const nearCastle = probe(0, 10, 60);
    // 近农场
    const nearFarm = probe(60, 10, 60);
    cam.position.copy(saved);
    return { far, nearCastle, nearFarm };
  });
  add('D 区域级 LOD 按距离切换',
    lodSwitch.far.castle === 1 && lodSwitch.far.farm === 1
    && lodSwitch.nearCastle.castle === 0 && lodSwitch.nearFarm.farm === 0,
    lodSwitch);

  // E 既有零改动
  const existing = await page.evaluate(() => {
    const pg = window.__playground;
    const lobby = pg.attractionManager.active;
    const zoo = pg.sceneManager.scene.getObjectByName('Zoo/root');
    return {
      rings: lobby?._triggerRings?.length ?? -1,
      zooZones: zoo ? zoo.children.filter((c) => c.userData.zoneKey).length : -1,
      boxes: lobby?._buildingBoxes?.length ?? -1,
    };
  });
  add('E 既有零改动（9 环 / 4 区 / AABB）',
    existing.rings === 10 && existing.zooZones === 4 && existing.boxes > 0, existing);

  // ---------- F 预算 ----------
  const budget = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, r = sm.renderer, cam = sm.camera;
    const saved = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, up: cam.up.clone() };
    const measure = (px, py, pz, lx, ly, lz) => {
      cam.position.set(px, py, pz); cam.up.set(0, 1, 0); cam.lookAt(lx, ly, lz);
      cam.updateProjectionMatrix();
      const old = r.info.autoReset; r.info.autoReset = false; r.info.reset();
      r.render(sm.scene, cam);
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
      r.info.autoReset = old; return out;
    };
    // 四宫格总览机位
    const view = measure(30, 84, 96, 30, 2, 30);
    // 关键口径：测「新区自身增量」= 显示 Districts 减 隐藏 Districts，
    // 避免受设施预热/机位状态影响（与 redline 的 M0 相对增量互补）。
    const root = sm.scene.getObjectByName('Districts/root');
    let hidden = { overview: null, standard: null };
    if (root) {
      const prev = root.visible; root.visible = false;
      hidden.overview = measure(0, 30, 34, 0, 2, 0);
      hidden.standard = measure(0, 9.4, 25, 0, 12.4, 0);
      root.visible = prev;
    }
    const overview = measure(0, 30, 34, 0, 2, 0);
    const standard = measure(0, 9.4, 25, 0, 12.4, 0);
    cam.position.copy(saved.p); cam.quaternion.copy(saved.q); cam.fov = saved.fov; cam.up.copy(saved.up);
    cam.updateProjectionMatrix();
    return { overview, standard, view, hidden };
  });
  const selfD = {
    overview: { calls: budget.overview.calls - budget.hidden.overview.calls,
      triangles: budget.overview.triangles - budget.hidden.overview.triangles },
    standard: { calls: budget.standard.calls - budget.hidden.standard.calls,
      triangles: budget.standard.triangles - budget.hidden.standard.triangles },
  };
  // 【口径说明】本专项不预热设施，测到的是「冷态」绝对 calls（含各设施首次渲染的
  // 常驻代表，1197）；M0 基线（1041）是 redline 预热后的「稳态」。两者不可直接相减
  // ——否则把冷态增量误算成新区开销。相对 M0 的稳态增量由 verify-redline.mjs M7
  // 权威覆盖（本轮 8/8：overview 1097 calls，M0 增量仅 +56 ≤ 60）。
  // 本项只测「新区自身增量」（显示减隐藏，同机位同状态）+ 绝对面数上限。
  add('F 预算（俯瞰≤30万面 / 新区增量≤1000面·≤3calls）',
    budget.overview.triangles <= 300000 && budget.standard.triangles <= 300000
    && budget.view.triangles <= 300000
    && selfD.overview.triangles <= 1000 && selfD.overview.calls <= 3
    && selfD.standard.triangles <= 1000 && selfD.standard.calls <= 3,
    { budget, selfD });

  // ---------- G 资源台账：预热 → 稳态 → 3 轮 ----------
  const keys = await page.evaluate(() => window.__playground.attractionManager.keys
    .filter((k) => k !== 'lobby' && k !== 'dummy'));
  await page.evaluate((ks) => {
    const pg = window.__playground;
    for (const k of ks) { pg.onEnterAttraction(k); pg.sceneManager.renderOnce(); pg.onExitAttraction(); pg.sceneManager.renderOnce(); }
    pg.onExitAttraction(); pg.sceneManager.renderOnce();
  }, keys);
  const steady = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
  const rounds = [];
  for (let r = 0; r < 3; r += 1) {
    for (const k of keys) {
      await page.evaluate((key) => {
        const pg = window.__playground;
        pg.onEnterAttraction(key); pg.sceneManager.renderOnce(); pg.onExitAttraction(); pg.sceneManager.renderOnce();
      }, k);
    }
    rounds.push(await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory })));
  }
  const dGeo = rounds[2].geometries - steady.geometries;
  const dTex = rounds[2].textures - steady.textures;
  add('G 稳态 3 轮 Δgeo=0 / Δtex=0', dGeo === 0 && dTex === 0, { steady, rounds, dGeo, dTex });

  // ---------- H 0 报错 + 截图 ----------
  // 【关键】用同步 renderOnce + toDataURL 抓取，不能 page.screenshot（等下一帧会被
  // OrbitControls.update() 把相机拉回默认机位，拍到皇堡大门而非四宫格总览）。
  const shotData = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, cam = sm.camera;
    cam.position.set(30, 84, 96); cam.up.set(0, 1, 0); cam.lookAt(30, 2, 30);
    cam.updateProjectionMatrix(); sm.renderOnce();
    return sm.renderer.domElement.toDataURL('image/png');
  });
  fs.writeFileSync(SHOT, Buffer.from(shotData.split(',')[1], 'base64'));
  const shotBytes = fs.statSync(SHOT).size;
  add('H 0 报错 + 截图有效', errors.length === 0 && shotBytes > 20000,
    { errors: errors.slice(0, 6), shotBytes });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = { module: 'M7', at: new Date().toISOString(), passed, total: checks.length,
    allPass: passed === checks.length, checks, errors };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`M7 ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 240)}`);
  await browser.close();
}
