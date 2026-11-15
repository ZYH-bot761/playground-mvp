/**
 * ============================================================================
 * verify-six-upgrades.mjs —— 六项深度升级 · 浏览器真机验收
 * 运行：node tests/verify-six-upgrades.mjs   （需 dev server 5173）
 * ============================================================================
 * ① 依赖安装与 Three.js 兼容
 * ② 移动双模式互斥状态机（F 切换 / 1.7m 锁定 / 飞行升降 / BVH 防穿模 / HUD / 平滑过渡）
 * ③ 渲染加载优化（LOD 高模 / mipmap / 包围体 / 强制关闭剔除）
 * ④ 场景模型与布局（作物随机化 / 城墙 / 沥青标线 / 台地）
 * ⑤ UI 与标识（EffectComposer + Bloom + FXAA / 3 Sprite 标签 / 招牌下移 / 毛玻璃）
 * ⑥ 交付（0 报错 + 截图 + 资源稳态）
 * ============================================================================
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-six-upgrades.json');
const SHOT = path.join(OUT, 'six-upgrades-final.png');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const errors = [];
const add = (name, ok, detail) => checks.push({ name, pass: !!ok, detail });

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
  /* ---------------- ① 依赖 ---------------- */
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const wanted = ['three-player-controller', 'three-mesh-bvh', 'lil-gui'];
  add('① 三个新依赖写入 package.json',
    wanted.every((k) => typeof deps[k] === 'string'),
    Object.fromEntries(wanted.map((k) => [k, deps[k] ?? null])));
  const threeVer = JSON.parse(fs.readFileSync(path.resolve('node_modules/three/package.json'), 'utf8')).version;
  add('① Three.js 版本兼容（>=0.159）',
    Number(threeVer.split('.')[1]) >= 159, { three: threeVer, controller: deps['three-player-controller'] });

  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });

  const boot = await page.evaluate(() => {
    const pg = window.__playground;
    return {
      hasMovement: !!pg.movementMode, hasOptimizer: !!pg.renderOptimizer,
      hasLabels: !!pg.districtLabels, hasPanel: !!pg.debugPanel,
      collisionWorld: typeof pg.movementMode?.collisionWorld?.query === 'function',
      bvh: pg.renderOptimizer?.stats?.bvhRebuilds !== undefined,
    };
  });
  add('① 依赖运行时已引入（CollisionWorld / BVH / lil-gui）',
    boot.hasMovement && boot.hasOptimizer && boot.hasLabels && boot.hasPanel && boot.collisionWorld, boot);

  /* ---------------- ② 移动模式 ---------------- */
  const modeResult = await page.evaluate(() => {
    const pg = window.__playground, mm = pg.movementMode, cam = pg.sceneManager.camera;
    const out = {};
    out.initial = { mode: mm.mode, engaged: mm.engaged, y: cam.position.y };
    // F 键真实键盘事件切换
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', bubbles: true }));
    out.afterF1 = { mode: mm.mode, engaged: mm.engaged, hud: document.querySelector('.pg-mode-hud__label')?.textContent };
    for (let i = 0; i < 40; i += 1) mm.update(0.05);
    mm._keys.add('Space');
    for (let i = 0; i < 20; i += 1) mm.update(0.05);
    out.flightUp = +cam.position.y.toFixed(2);
    mm._keys.delete('Space'); mm._keys.add('KeyQ');
    const yBeforeDown = cam.position.y;
    for (let i = 0; i < 10; i += 1) mm.update(0.05);
    out.flightDown = +(yBeforeDown - cam.position.y).toFixed(2);
    mm._keys.delete('KeyQ');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', bubbles: true }));
    out.afterF2 = { mode: mm.mode, hud: document.querySelector('.pg-mode-hud__label')?.textContent };
    out.blendStart = { blend: mm._blend, y: +cam.position.y.toFixed(2) };
    for (let i = 0; i < 40; i += 1) mm.update(0.05);
    out.ground = { mode: mm.mode, y: +cam.position.y.toFixed(4), blend: mm._blend };
    // 地面行走：y 恒定
    mm._keys.add('KeyW');
    const z0 = cam.position.z;
    for (let i = 0; i < 20; i += 1) mm.update(0.05);
    out.walk = { moved: +Math.abs(cam.position.z - z0).toFixed(2), y: +cam.position.y.toFixed(4) };
    mm._keys.delete('KeyW');
    // BVH 防穿模：塞进建筑 AABB 中心
    const boxes = pg.attractionManager.active?._buildingBoxes || [];
    const b = boxes.find((bb) => !bb.noBlock && Number.isFinite(bb.minX));
    if (b) {
      cam.position.set((b.minX + b.maxX) / 2, 1.7, (b.minZ + b.maxZ) / 2);
      mm.update(0.016);
      out.pushOut = {
        inside: cam.position.x > b.minX && cam.position.x < b.maxX
          && cam.position.z > b.minZ && cam.position.z < b.maxZ,
      };
    }
    // BVH 三角形级擦墙实证：把胶囊放到盒壁外侧 0.35m（< 半径 0.5），
    // 单独调 _resolveBVH，必须把玩家推到半径外并累计 bvhPushOuts。
    if (b) {
      const before = mm.stats.bvhPushOuts;
      cam.position.set(b.minX - 0.35, 1.7, (b.minZ + b.maxZ) / 2);
      mm._resolveBVH(cam.position);
      out.bvhGraze = {
        hit: mm.stats.bvhPushOuts > before,
        x: +cam.position.x.toFixed(3),
        wallX: b.minX,
        pushedOutside: cam.position.x <= b.minX - 0.49,
      };
    }
    out.stats = { ...mm.stats };
    // 互斥性：mode 只能是两者之一
    out.mutex = mm.mode === 'ground' || mm.mode === 'flight';
    return out;
  });
  add('② 默认地面模式 + F 键互斥切换（ground ↔ flight）',
    modeResult.initial.mode === 'ground' && modeResult.afterF1.mode === 'flight'
    && modeResult.afterF2.mode === 'ground' && modeResult.mutex, modeResult);
  add('② 地面模式：WASD 贴地移动 + 相机锁定 1.7m + 禁用垂直位移',
    modeResult.ground.y === 1.7 && modeResult.walk.moved > 0.5 && modeResult.walk.y === 1.7,
    { ground: modeResult.ground, walk: modeResult.walk });
  add('② 飞行模式：Space 上升 / Q 下降，关闭地面碰撞约束',
    modeResult.flightUp > 30 && modeResult.flightDown > 0.5,
    { flightUp: modeResult.flightUp, flightDown: modeResult.flightDown });
  add('② BVH 高性能碰撞防穿模（MeshBVH + CollisionWorld + 三角形级擦墙推出）',
    modeResult.stats.bvhTriangles > 0 && modeResult.stats.registeredColliders > 0
    && modeResult.pushOut?.inside === false
    && modeResult.bvhGraze?.hit === true && modeResult.bvhGraze?.pushedOutside === true,
    { stats: modeResult.stats, pushOut: modeResult.pushOut, bvhGraze: modeResult.bvhGraze });
  add('② HUD 模式指示器 + 切换时相机高度平滑过渡',
    modeResult.afterF1.hud?.includes('飞行') && modeResult.afterF2.hud?.includes('地面')
    && modeResult.blendStart.blend === 0 && modeResult.ground.blend === 1,
    { hud1: modeResult.afterF1.hud, hud2: modeResult.afterF2.hud, blend: modeResult.blendStart, ground: modeResult.ground });

  /* ---------------- ③ 渲染优化 ---------------- */
  const render = await page.evaluate(() => {
    const pg = window.__playground, scene = pg.sceneManager.scene, ro = pg.renderOptimizer;
    let lods = 0, pinned = 0, meshWithBounds = 0, meshes = 0, mipmapTextures = 0, badTextures = 0;
    const seen = new Set();
    scene.traverse((o) => {
      if (o.isLOD) { lods += 1; if (o.autoUpdate === false) pinned += 1; }
      if (o.isMesh) {
        meshes += 1;
        const bs = o.isInstancedMesh ? o.boundingSphere : o.geometry?.boundingSphere;
        if (bs && Number.isFinite(bs.radius) && bs.radius > 0) meshWithBounds += 1;
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of mats) {
          for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
            const t = m?.[key];
            if (!t || seen.has(t)) continue;
            seen.add(t);
            if (t.minFilter === 1008 || t.minFilter === 1007 || t.minFilter === 1006) mipmapTextures += 1;
            else if (t.image && !t.isRenderTargetTexture) badTextures += 1;
          }
        }
      }
    });
    const castleLod = scene.getObjectByName('Districts/castle/lod');
    const farmLod = scene.getObjectByName('Districts/farm/lod');
    const stats = { ...ro.stats };
    // 强制关闭所有 Mesh 的 frustumCulled（验证能力，之后还原）
    const n = ro.setForceNoCull(true);
    let allOff = true;
    scene.traverse((o) => { if (o.isMesh && !o.isSprite && o.frustumCulled) allOff = false; });
    ro.setForceNoCull(false);
    let restored = true;
    scene.traverse((o) => { if (o.isMesh && !o.isSprite && !o.frustumCulled && !ro.forceNoCull) restored = false; });
    return {
      lods, pinned, meshes, meshWithBounds, mipmapTextures, badTextures, stats,
      districtLodPinned: castleLod?.autoUpdate === false && farmLod?.autoUpdate === false,
      forceNoCullMeshes: n, allOff, restored,
    };
  });
  add('③ LOD 禁用自动降级，视野内始终高模（远景方块消除）',
    render.districtLodPinned && render.stats.lodsPinned >= 2, render);
  add('③ 纹理 Mipmap / 各向异性设置正确',
    render.mipmapTextures > 0 && render.badTextures === 0 && render.stats.anisotropy >= 2,
    { mipmapTextures: render.mipmapTextures, badTextures: render.badTextures, anisotropy: render.stats.anisotropy });
  add('③ 全 Mesh 包围体精确修正 + 强制关闭 frustumCulled 能力',
    render.meshWithBounds === render.meshes && render.allOff && render.restored
    && render.forceNoCullMeshes > 100,
    { meshes: render.meshes, meshWithBounds: render.meshWithBounds, forceNoCullMeshes: render.forceNoCullMeshes, allOff: render.allOff, restored: render.restored });

  /* ---------------- ④ 模型与布局 ---------------- */
  const layout = await page.evaluate(() => {
    const pg = window.__playground, scene = pg.sceneManager.scene;
    const crops = [];
    scene.traverse((o) => { if (o.name?.startsWith('Districts/farm/crop-')) crops.push(o); });
    // 随机旋转/缩放：取同一 InstancedMesh 前 4 个实例矩阵，比较差异
    const rice = scene.getObjectByName('Districts/farm/crop-水稻');
    let distinct = 0, colored = 0;
    if (rice) {
      const arr = rice.instanceMatrix.array;
      const vals = [];
      for (let i = 0; i < 4; i += 1) vals.push(arr[i * 16].toFixed(3) + ',' + arr[i * 16 + 5].toFixed(3));
      distinct = new Set(vals).size;
      colored = !!rice.instanceColor;
    }
    const struct = scene.getObjectByName('Districts/structure');
    const castleBody = scene.getObjectByName('Districts/castle/body');
    const castleWalls = scene.getObjectByName('Districts/castle/walls');
    const sign = scene.getObjectByName('Lobby/gate-sign-front');
    const tris = (m) => m?.geometry?.index
      ? m.geometry.index.count / 3
      : (m?.geometry?.attributes?.position?.count ?? 0) / 3;
    return {
      cropTypes: crops.length,
      cropInstances: crops.reduce((a, o) => a + o.count, 0),
      randomDistinct: distinct, colored,
      structureCount: struct?.count ?? -1,
      castleBodyTris: tris(castleBody),
      castleWallsTris: tris(castleWalls),
      plateau: !!scene.getObjectByName('Districts/castle/plateau'),
      plateauY: scene.getObjectByName('Districts/castle/plateau')?.position.y,
      castleDetailY: scene.getObjectByName('Districts/castle/detail')?.position.y,
      signY: sign?.position.y, signZ: sign?.position.z,
      roadMarkings: (() => {
        // 标线是 structure 内 y>1.12 的窄长实例
        let n = 0;
        if (struct) {
          const a = struct.instanceMatrix.array;
          for (let i = 0; i < struct.count; i += 1) if (a[i * 16 + 13] > 1.122) n += 1;
        }
        return n;
      })(),
    };
  });
  add('④ 农作物随机旋转 / 缩放 / 色差（消除木棍感，仍为 InstancedMesh）',
    layout.cropTypes === 14 && layout.cropInstances >= 300 && layout.randomDistinct >= 3 && layout.colored,
    { cropTypes: layout.cropTypes, cropInstances: layout.cropInstances, randomDistinct: layout.randomDistinct, colored: layout.colored });
  add('④ 城堡程序化重构（塔楼 + 城墙 + 城垛 + 屋顶，合并几何）',
    layout.castleBodyTris >= 500 && layout.castleBodyTris <= 4000
    && layout.castleWallsTris >= 400,
    { castleBodyTris: layout.castleBodyTris, castleWallsTris: layout.castleWallsTris });
  add('④ 沥青马路 + 车道标线 + 城堡区抬高地形',
    layout.structureCount >= 30 && layout.roadMarkings >= 6
    && layout.plateau && layout.plateauY > 0 && layout.castleDetailY > 0,
    { structureCount: layout.structureCount, roadMarkings: layout.roadMarkings, plateauY: layout.plateauY, castleDetailY: layout.castleDetailY });

  /* ---------------- ⑤ UI 与标识 ---------------- */
  const ui = await page.evaluate(() => {
    const pg = window.__playground, sm = pg.sceneManager, scene = sm.scene;
    const labels = [];
    scene.traverse((o) => { if (o.isSprite && o.name?.startsWith('DistrictLabels/')) labels.push({ name: o.name, text: o.userData.labelText }); });
    const panel = document.querySelector('.pg-ui__panel');
    const styles = panel ? getComputedStyle(panel) : null;
    return {
      passes: sm.composer?.passes?.map((p) => p.constructor.name) ?? [],
      hasBloom: !!sm.bloomPass, bloomStrength: sm.bloomPass?.strength,
      hasFXAA: !!sm.fxaaPass,
      labels,
      glass: styles?.backdropFilter || styles?.webkitBackdropFilter,
      gui: !!document.querySelector('.pg-gui'),
      signY: scene.getObjectByName('Lobby/gate-sign-front')?.position.y,
      signZ: scene.getObjectByName('Lobby/gate-sign-front')?.position.z,
    };
  });
  add('⑤ 后处理链 EffectComposer + UnrealBloomPass(轻微光晕) + FXAAPass',
    ui.passes.includes('RenderPass') && ui.passes.includes('UnrealBloomPass')
    && ui.passes.includes('ShaderPass') && ui.hasFXAA
    && ui.bloomStrength > 0 && ui.bloomStrength < 0.3,
    { passes: ui.passes, bloomStrength: ui.bloomStrength });
  add('⑤ 三区 Sprite 文字标签（城堡屋 / 农家乐 / 动物园，始终面向相机）',
    ui.labels.length === 3 && ['城堡屋', '农家乐', '动物园'].every((t) => ui.labels.some((l) => l.text === t)),
    ui.labels);
  add('⑤ 「游乐场」招牌下移 Y 轴 + 前移避免遮挡',
    ui.signY < 15 && ui.signZ > 0.9, { signY: ui.signY, signZ: ui.signZ });
  add('⑤ 半透明毛玻璃 UI + lil-gui 调试面板',
    /blur/.test(ui.glass || '') && ui.gui, { glass: ui.glass, gui: ui.gui });

  /* ---------------- ⑥ 稳态 + 截图 ---------------- */
  await page.evaluate(() => {
    const pg = window.__playground;
    pg.movementMode.disengage();
    pg.onExitAttraction?.();
  });
  const keys = await page.evaluate(() => window.__playground.attractionManager.keys
    .filter((k) => k !== 'lobby' && k !== 'dummy'));
  await page.evaluate((ks) => {
    const pg = window.__playground;
    for (const k of ks) { pg.onEnterAttraction(k); pg.sceneManager.renderOnce(); pg.onExitAttraction(); pg.sceneManager.renderOnce(); }
  }, keys);
  const steady = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
  const rounds = [];
  for (let r = 0; r < 3; r += 1) {
    await page.evaluate((ks) => {
      const pg = window.__playground;
      for (const k of ks) { pg.onEnterAttraction(k); pg.sceneManager.renderOnce(); pg.onExitAttraction(); pg.sceneManager.renderOnce(); }
    }, keys);
    rounds.push(await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory })));
  }
  const dGeo = rounds[2].geometries - steady.geometries;
  const dTex = rounds[2].textures - steady.textures;
  add('⑥ 资源台账稳态 3 轮 Δgeo=0 / Δtex=0', dGeo === 0 && dTex === 0, { steady, rounds, dGeo, dTex });

  const shotData = await page.evaluate(() => {
    const sm = window.__playground.sceneManager, cam = sm.camera;
    cam.position.set(30, 84, 96); cam.up.set(0, 1, 0);
    cam.lookAt(30, 2, 30); cam.fov = 55; cam.updateProjectionMatrix();
    sm.renderOnce();
    return sm.renderer.domElement.toDataURL('image/png');
  });
  fs.writeFileSync(SHOT, Buffer.from(shotData.split(',')[1], 'base64'));
  const shotBytes = fs.statSync(SHOT).size;
  add('⑥ 0 pageerror / console.error + 六项总览截图',
    errors.length === 0 && shotBytes > 20000,
    { errors: errors.slice(0, 8), shotBytes });
} catch (err) {
  add('脚本执行', false, String(err?.stack || err));
} finally {
  const passed = checks.filter((c) => c.pass).length;
  const report = {
    module: 'six-upgrades', at: new Date().toISOString(),
    passed, total: checks.length, allPass: passed === checks.length,
    checks, errors,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`SIX-UPGRADES ${passed}/${checks.length} allPass=${report.allPass}`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 300)}`);
  await browser.close();
}
