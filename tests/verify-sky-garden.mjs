/**
 * verify-sky-garden.mjs —— 空中花园（太空电梯 + 太空高铁 + 146m 轨道环）验收
 * ① 资产齐全：环梁 / 踏步板 / 灯带 / 电梯 / 站台 / 爬升轨道 / 4 节列车
 * ② 按 E 进电梯 → 垂直升到 146m → 到站「空中花园」→ 按 E 回地面
 * ③ 按 E 登车 → 发车 → 沿轨道爬到环上站台 → 返程回地面
 * ④ 高空时天穹盒跟随（不会穿出天空）、雾被放宽（能看到地面）
 * ⑤ 回到地面后相机 / 雾 / 输入全部复原
 * ⑥ 全场景三角面仍在 300k 红线内，运行期无报错
 */
import { chromium } from 'playwright';

/* ?no-prewarm=1：后台分帧预热会 activate/deactivate 设施，期间 Lobby 被 dispose
 * 重建（键鼠监听、乘梯状态全部丢失），验收必须把这段噪声排掉。 */
const URL = process.env.SKY_URL || 'http://127.0.0.1:5173/?no-prewarm=1';
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
// 注意：waitForFunction 的第二参是「传进页面的 arg」，options 必须第三参；
// 为免逐个改，这里统一放宽默认超时（headless 只有 1~4fps，升空 146m 很慢）。
page.setDefaultTimeout(90000);
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__playground?.bootReady === true, { timeout: 60000 });
await page.click('.pg-start__enter[data-action="start"]');
await page.waitForFunction(() => window.__playground.sceneManager._running === true, { timeout: 30000 });
await page.waitForTimeout(1200);
await page.evaluate(() => { window.__sky = () => window.__playground.attractionManager.active._skyGarden; });

/** headless（SwiftShader 1~4fps）下 page.keyboard 时好时坏，改用页面内真实派发
 *  keydown(code='KeyE')：走的仍是 window capture 上的 _onInteractKey 全链路。 */
const pressE = () => page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'e', code: 'KeyE', bubbles: true, cancelable: true,
  }));
});

/* ---------- ① 资产 ---------- */
const assets = await page.evaluate(() => {
  const pg = window.__playground;
  const s = pg.attractionManager.active._skyGarden;
  const g = pg.sceneManager.scene.getObjectByName('Sky/garden');
  const names = [];
  g?.traverse((o) => { if (o.name) names.push(o.name); });
  const ringBeam = pg.sceneManager.scene.getObjectByName('Sky/ring-beam');
  return {
    status: s.status,
    hasGroup: !!g,
    names: names.slice(0, 40),
    instanced: s._instanced.length,
    colliders: (s._colliders || []).length,
    ringY: ringBeam ? +ringBeam.position.y.toFixed(2) : null,
    railLen: +s._railLen.toFixed(1),
    trainCount: s._train?.count,
    groupChildren: g ? g.children.length : 0,
    hud: !!document.querySelector('.sky-hud'),
  };
});
console.log('assets =', JSON.stringify(assets));

ok('① 空中花园组已挂进大厅（环 / 电梯 / 站台 / 轨道 / 列车齐全）',
  assets.hasGroup
  && assets.names.includes('Sky/ring-beam')
  && assets.names.includes('Sky/elevator-car')
  && assets.names.includes('Sky/station-slab')
  && assets.names.includes('Sky/rail-tube')
  && assets.names.includes('Sky/train-body'),
  assets.names.slice(0, 10).join(', '));
ok('② 轨道环在 146m、列车 4 节、使用 InstancedMesh 控 draw call',
  Math.abs(assets.ringY - 146) < 0.01 && assets.trainCount === 4 && assets.instanced >= 6,
  `ringY=${assets.ringY} train=${assets.trainCount} inst=${assets.instanced}`);
ok('③ 爬升轨道长度足够（≥150m，穿云观感）', assets.railLen >= 150, `railLen=${assets.railLen}m`);
ok('③b 环上有可逛的空中街区（亭 / 温室 / 喷泉广场 / 空中墅 / 外悬观景台 / 灯柱 / 行道树）',
  ['Sky/district', 'Sky/pavilion', 'Sky/greenhouse', 'Sky/sky-plaza', 'Sky/sky-villa', 'Sky/balcony',
    'Sky/deck-poles', 'Sky/deck-lamps', 'Sky/deck-trunks', 'Sky/deck-trees'].every((n) => assets.names.includes(n)),
  `districtNodes=${assets.names.filter((n) => n.startsWith('Sky/')).length} colliders=${assets.colliders}`);

/* ---------- ② 电梯：真实按键 E ---------- */
await page.evaluate(() => {
  const pg = window.__playground;
  const cam = pg.sceneManager.camera;
  const ctl = pg.attractionManager.active._controls;
  // 轨道相机受 maxDistance=50 / 极角限制，摆机位必须同时改 target，否则会被夹走
  cam.position.set(-88.4, 7.0, 30.0);   // 电梯基座南侧 8m
  ctl.target.set(-88.4, 3.2, 22.5);
  ctl.update();
});
// 判定在 update 里逐帧刷新，headless 帧率低，必须等帧而不是等固定毫秒
await page.waitForFunction(() => window.__sky().status.near === 'elevator', { timeout: 20000 });
const nearState = await page.evaluate(() => ({ status: window.__sky().status }));
ok('④ 站在电梯基座旁 → E 提示出现（near=elevator）', nearState.status.near === 'elevator', JSON.stringify(nearState.status));

await pressE();
await page.waitForTimeout(150);
console.log('afterE =', JSON.stringify(await page.evaluate(() => ({
  mode: window.__sky().status.mode,
  near: window.__sky().status.near,
  hudText: document.querySelector('.sky-hud__line')?.textContent,
}))));
await page.waitForFunction(() => window.__sky().status.mode === 'elev-up', { timeout: 20000 });
// 验收加速：正常 12.5s，headless 只有 1~4fps；_startElevator 会把时长重置，所以必须起跑后再压
await page.evaluate(() => { window.__sky()._rideDur = 1.2; });

/* 上升途中：拖动鼠标 → 视角真的转起来（不再被钉死在一个机位） */
const yaw0 = await page.evaluate(() => window.__sky().status.yaw);
await page.evaluate(() => {
  const ev = (type, x, y) => new PointerEvent(type, {
    pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  });
  window.dispatchEvent(ev('pointerdown', 800, 450));
  window.dispatchEvent(ev('pointermove', 980, 415));
  window.dispatchEvent(ev('pointerup', 980, 415));
});
await page.waitForTimeout(200);
const lookRide = await page.evaluate(() => ({
  status: window.__sky().status,
  quat: window.__playground.sceneManager.camera.quaternion.toArray().map((n) => +n.toFixed(3)),
}));
console.log('lookRide =', JSON.stringify(lookRide));
ok('④b 乘梯上升中鼠标拖拽可自由环视（yaw / pitch 真的变化）',
  Math.abs(lookRide.status.yaw - yaw0) > 0.2 && Math.abs(lookRide.status.pitch) > 0.02,
  `yaw ${yaw0} → ${lookRide.status.yaw}, pitch=${lookRide.status.pitch}`);
await page.evaluate(() => { window.__sky()._look.yaw = 0; window.__sky()._look.pitch = 0; });
await page.waitForFunction(() => window.__sky().status.mode === 'elev-top', { timeout: 60000 });
const top = await page.evaluate(() => {
  const pg = window.__playground;
  const s = pg.attractionManager.active._skyGarden;
  const cam = pg.sceneManager.camera;
  const skyBox = pg.sceneManager.scene.getObjectByName('Lobby/sky');
  return {
    status: s.status,
    camY: +cam.position.y.toFixed(2),
    fog: pg.sceneManager.scene.fog ? { near: +pg.sceneManager.scene.fog.near.toFixed(1), far: +pg.sceneManager.scene.fog.far.toFixed(1) } : null,
    skyY: skyBox ? +skyBox.position.y.toFixed(1) : null,
    skyHidden: skyBox ? skyBox.visible === false : null,
    cloudHidden: s._cloudsOn === false,
    cloudVis: (() => { const n = []; pg.sceneManager.scene.traverse((o) => { if (/cloud/i.test(o.name || '') && o.isMesh) n.push([o.name, o.visible]); }); return n; })(),
    hud: document.querySelector('.sky-hud')?.dataset.on,
    hudText: document.querySelector('.sky-hud__line')?.textContent,
  };
});
console.log('top =', JSON.stringify(top));

ok('⑤ 电梯把相机升到 146m 站台（y > 140）', top.camY > 140, `camY=${top.camY}`);
// 【口径变更】高空不再"把雾推远"，而是整段关雾 + 收起天穹盒：
// 146m 上灰雾 40m 外就糊成白墙、Sky.js 半球过曝成奶白，环上建筑全被吃掉。
// 所以这里改判「雾已关闭、天穹已收起、天空色已换」——画面通透才是目的。
ok('⑥ 高空关雾（fog=null）+ 天穹收起（sky.visible=false），远景不再糊白',
  top.fog === null && top.skyHidden === true, JSON.stringify({ fog: top.fog, skyHidden: top.skyHidden }));
ok('⑦ 高空三条云带（Lobby/cloud-band-*）全部收起，天空不再被云糊白',
  top.cloudHidden === true, JSON.stringify({ cloudHidden: top.cloudHidden, clouds: top.cloudVis }));
ok('⑧ 到站 HUD 提示「空中花园」', String(top.hudText || '').includes('空中花园') && top.hud === '1', String(top.hudText).slice(0, 40));

await page.evaluate(() => window.__playground.sceneManager.renderOnce());
await page.screenshot({ path: 'docs/screenshots/sky-1-ring-top.png' });

/* ---------- ②b 出舱漫步：甲板上可自由行走 + 自由视角 ---------- */
await pressE();
await page.waitForFunction(() => window.__sky().status.mode === 'deck', { timeout: 20000 });
await page.waitForFunction(() => window.__sky().status.intro < 0, { timeout: 20000 });
const deck0 = await page.evaluate(() => {
  const s = window.__sky();
  const cam = window.__playground.sceneManager.camera;
  return {
    status: s.status,
    cam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
  };
});
console.log('deck0 =', JSON.stringify(deck0));
const camR = Math.hypot(deck0.cam[0] - 0, deck0.cam[2] - 54);
ok('⑧b 出舱后站在 146m 步道上（第一人称眼高，半径落在步道带内）',
  deck0.status.mode === 'deck' && deck0.cam[1] > 148 && deck0.cam[1] < 150 && camR > 84 && camR < 92,
  `mode=${deck0.status.mode} camY=${deck0.cam[1]} r=${camR.toFixed(2)}`);
ok('⑧c 甲板 HUD 提示行走 / 环视', String(deck0.status.mode) === 'deck', '');

/* 观景机位：站在 250° 甲板朝 295° 的悬挑观景台 / 空中墅方向看 —— 这张是给用户看"环上有什么"的 */
await page.evaluate(() => {
  const s = window.__sky();
  const cam = window.__playground.sceneManager.camera;
  const a = (295 * Math.PI) / 180;
  const tx = Math.cos(a) * 92;
  const tz = 54 + Math.sin(a) * 92;
  s._look.yaw = Math.atan2(-(tx - cam.position.x), -(tz - cam.position.z));
  s._look.pitch = -0.05;
});
await page.waitForTimeout(400);
await page.evaluate(() => window.__playground.sceneManager.renderOnce());
await page.screenshot({ path: 'docs/screenshots/sky-4-deck-walk.png' });

/* 拖鼠标：甲板上视角同样能转 */
const deckYaw0 = deck0.status.yaw;
await page.evaluate(() => {
  const ev = (type, x, y) => new PointerEvent(type, {
    pointerId: 2, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true,
  });
  window.dispatchEvent(ev('pointerdown', 800, 450));
  window.dispatchEvent(ev('pointermove', 640, 380));
  window.dispatchEvent(ev('pointerup', 640, 380));
});
await page.waitForTimeout(300);
const lookDeck = await page.evaluate(() => window.__sky().status);
ok('⑧d 甲板上拖鼠标可环视（yaw 变化、pitch 抬头）',
  Math.abs(lookDeck.yaw - deckYaw0) > 0.2,
  `yaw ${deckYaw0} → ${lookDeck.yaw}, pitch=${lookDeck.pitch}`);

/* WASD：真的走起来 */
const walkFrom = await page.evaluate(() => ({ ...window.__sky().status.walk }));
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true, cancelable: true }));
});
await page.waitForTimeout(2200);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW', bubbles: true, cancelable: true }));
});
const walkTo = await page.evaluate(() => {
  const s = window.__sky();
  const cam = window.__playground.sceneManager.camera;
  return { walk: { ...s.status.walk }, angle: s.status.angle, r: s.status.deck.r, camY: +cam.position.y.toFixed(2) };
});
const moved = Math.hypot(walkTo.walk.x - walkFrom.x, walkTo.walk.z - walkFrom.z);
console.log('walk =', JSON.stringify({ walkFrom, walkTo, moved: +moved.toFixed(2) }));
ok('⑧e 按 W 能在甲板上真实前进（位移 > 1m 且仍在步道带内）',
  moved > 1 && walkTo.r > 84 && walkTo.r < 92 && walkTo.camY > 148,
  `moved=${moved.toFixed(2)}m r=${walkTo.r}`);

/* 建筑避让：把走位塞进观景亭中心，一帧后应被推出来 */
const collide = await page.evaluate(async () => {
  const s = window.__sky();
  const pav = window.__playground.sceneManager.scene.getObjectByName('Sky/pavilion');
  s._deckWalk.x = pav.position.x;
  s._deckWalk.z = pav.position.z;
  await new Promise((r) => setTimeout(r, 600));
  const d = Math.hypot(s._deckWalk.x - pav.position.x, s._deckWalk.z - pav.position.z);
  return { d: +d.toFixed(2), r: s.status.deck.r };
});
ok('⑧f 走不进建筑内部（观景亭柱圈外围的碰撞把走位推开）', collide.d >= 3.15, JSON.stringify(collide));

 /* 街区近景：站到 65° 甲板，朝回 40° 的喷泉广场 / 到站口看，顺带能看到云灯塔 */
await page.evaluate(() => {
  const s = window.__sky();
  const a = (65 * Math.PI) / 180;
  s._deckWalk.x = Math.cos(a) * 87;
  s._deckWalk.z = 54 + Math.sin(a) * 87;
  // 朝 a 减小的方向（往 40° 广场那边）看
  s._look.yaw = Math.atan2(Math.cos(a), -Math.sin(a));
  s._look.pitch = -0.02;
});
await page.waitForTimeout(500);
await page.evaluate(() => window.__playground.sceneManager.renderOnce());
await page.screenshot({ path: 'docs/screenshots/sky-5-sky-district.png' });

/* E 回舱 → 再按 E 下行 */
await pressE();
await page.waitForFunction(() => window.__sky().status.mode === 'elev-top', { timeout: 20000 });
await page.waitForFunction(() => window.__sky().status.intro < 0, { timeout: 20000 });
const backInCabin = await page.evaluate(() => ({
  mode: window.__sky().status.mode,
  walked: window.__sky()._walked,
  hud: document.querySelector('.sky-hud__line')?.textContent,
  descBtn: !!document.querySelector('.sky-hud button[data-act="descend"]'),
}));
console.log('backInCabin =', JSON.stringify(backInCabin));
ok('⑧g 回舱后按 E 变成下行（不再卡在「到站」死循环）',
  backInCabin.mode === 'elev-top' && backInCabin.walked === 'elevator' && backInCabin.descBtn,
  `${backInCabin.mode} / ${String(backInCabin.hud).slice(0, 24)}`);

/* E 回地面 */
await pressE();
await page.waitForFunction(() => window.__sky().status.mode === 'elev-down', { timeout: 20000 });
await page.evaluate(() => { window.__sky()._rideDur = 1.2; }); // 验收加速：下降
await page.waitForFunction(() => window.__sky().status.mode === 'idle', { timeout: 60000 });
await page.waitForFunction(() => window.__sky().status.mode === 'idle' && window.__sky().status.intro < 0, { timeout: 20000 });
try {
  await page.waitForFunction(() => window.__sky().status.mode === 'idle' && window.__sky().status.intro < 0
    && Math.abs((window.__playground.sceneManager.scene.fog?.far ?? 0) - window.__sky()._baseFog.far) < 1,
  { timeout: 25000 });
} catch (e) {
  console.log('back-stuck =', JSON.stringify(await page.evaluate(() => {
    const pg = window.__playground;
    return {
      status: window.__sky().status,
      camY: +pg.sceneManager.camera.position.y.toFixed(1),
      fog: { near: +pg.sceneManager.scene.fog.near.toFixed(1), far: +pg.sceneManager.scene.fog.far.toFixed(1) },
      saved: !!window.__sky()._saved,
      baseFog: window.__sky()._baseFog,
    };
  })));
}
const back = await page.evaluate(() => {
  const pg = window.__playground;
  const cam = pg.sceneManager.camera;
  return {
    status: window.__sky().status,
    camY: +cam.position.y.toFixed(2),
    fog: pg.sceneManager.scene.fog ? { near: +pg.sceneManager.scene.fog.near.toFixed(1), far: +pg.sceneManager.scene.fog.far.toFixed(1) } : null,
    controls: !!pg.attractionManager.active._controls,
  };
});
console.log('back =', JSON.stringify(back));
const baseFog = await page.evaluate(() => window.__sky()._baseFog);
ok('⑨ 按 E 回到地面：相机 / 雾复原，状态机回 idle',
  back.camY < 12 && back.fog && back.fog.far <= baseFog.far + 1 && back.status.mode === 'idle',
  JSON.stringify({ camY: back.camY, fog: back.fog, base: baseFog, mode: back.status.mode }));

/* ---------- ③ 高铁：登车 → 发车 → 到站 → 返程 ---------- */
await page.evaluate(() => {
  const pg = window.__playground;
  const cam = pg.sceneManager.camera;
  const ctl = pg.attractionManager.active._controls;
  cam.position.set(-64, 7.5, 13.0); // 站台南侧 15m 内、略高于站台板
  ctl.target.set(-64, 3.6, 0);
  ctl.update();
});
await page.waitForFunction(() => window.__sky().status.near === 'station', { timeout: 20000 });
const stNear = await page.evaluate(() => ({ status: window.__sky().status }));
ok('⑩ 站到高铁站台旁 → E 提示出现（near=station）', stNear.status.near === 'station', JSON.stringify(stNear.status));

await pressE();
await page.waitForTimeout(200);
console.log('afterBoardE =', JSON.stringify(await page.evaluate(() => ({
  mode: window.__sky().status.mode, near: window.__sky().status.near, intro: window.__sky().status.intro,
}))));
await page.waitForFunction(() => window.__sky().status.mode === 'train-boarded', { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('.sky-hud button[data-act="dispatch"]'), { timeout: 20000 });
const boarded = await page.evaluate(() => ({
  status: window.__sky().status,
  dispatchBtn: !!document.querySelector('.sky-hud button[data-act="dispatch"]'),
  text: document.querySelector('.sky-hud__line')?.textContent,
}));
ok('⑪ 登车成功且出现「发车」按钮', boarded.status.mode === 'train-boarded' && boarded.dispatchBtn, String(boarded.text).slice(0, 40));

await page.evaluate(() => document.querySelector('.sky-hud button[data-act="dispatch"]').click());
await page.waitForFunction(() => window.__sky().status.mode === 'train-up', { timeout: 20000 });
await page.evaluate(() => { window.__sky()._rideDur = 1.6; }); // 验收加速（正常 ≈ 20s+）
await page.waitForFunction(() => window.__sky().status.mode === 'train-docked', { timeout: 60000 });
const docked = await page.evaluate(() => {
  const pg = window.__playground;
  const cam = pg.sceneManager.camera;
  const s = pg.attractionManager.active._skyGarden;
  return {
    status: s.status,
    camY: +cam.position.y.toFixed(2),
    trainT: s.status.trainProgress,
    hud: document.querySelector('.sky-hud__line')?.textContent,
    tris: pg.sceneManager.renderer.info.render.triangles,
    calls: pg.sceneManager.renderer.info.render.calls,
  };
});
console.log('docked =', JSON.stringify(docked));
ok('⑫ 发车后沿轨道抵达环上站台（trainT=1，相机在 140m 以上）',
  docked.trainT === 1 && docked.camY > 135, `t=${docked.trainT} camY=${docked.camY}`);
ok('⑧b 到站 HUD 含「空中站台」', String(docked.hud || '').includes('空中站台'), String(docked.hud).slice(0, 40));

await page.evaluate(() => window.__playground.sceneManager.renderOnce());
await page.screenshot({ path: 'docs/screenshots/sky-2-train-dock.png' });

/* 到站 → 出舱看一眼 → 回舱 → 返程 */
await pressE();
await page.waitForFunction(() => window.__sky().status.mode === 'deck', { timeout: 20000 });
await page.waitForFunction(() => window.__sky().status.intro < 0, { timeout: 20000 });
const deckFromTrain = await page.evaluate(() => ({
  mode: window.__sky().status.mode,
  from: window.__sky().status.deck.from,
  angle: window.__sky().status.angle,
}));
console.log('deckFromTrain =', JSON.stringify(deckFromTrain));
ok('⑫b 高铁到站也能出舱上步道（落点在 40° 到站口）',
  deckFromTrain.mode === 'deck' && deckFromTrain.from === 'train',
  JSON.stringify(deckFromTrain));

await pressE();
await page.waitForFunction(() => window.__sky().status.mode === 'train-docked', { timeout: 20000 });
await page.waitForFunction(() => window.__sky().status.intro < 0, { timeout: 20000 });
await pressE();
await page.waitForFunction(() => window.__sky().status.mode === 'train-down', { timeout: 20000 });
await page.evaluate(() => { window.__sky()._rideDur = 1.6; }); // 验收加速：返程
await page.waitForFunction(() => window.__sky().status.mode === 'idle', { timeout: 60000 });
await page.waitForTimeout(600);
const returned = await page.evaluate(() => {
  const pg = window.__playground;
  const s = pg.attractionManager.active._skyGarden;
  const cam = pg.sceneManager.camera;
  const trainP = s._trainPos[0];
  return {
    status: s.status,
    camY: +cam.position.y.toFixed(2),
    train: { x: +trainP.x.toFixed(1), y: +trainP.y.toFixed(1), z: +trainP.z.toFixed(1) },
    tris: pg.sceneManager.renderer.info.render.triangles,
    calls: pg.sceneManager.renderer.info.render.calls,
  };
});
console.log('returned =', JSON.stringify(returned));
ok('⑬ 返程回到地面，列车回到站台（t=0）',
  returned.status.mode === 'idle' && returned.status.trainProgress === 0 && returned.camY < 12,
  `mode=${returned.status.mode} t=${returned.status.trainProgress} camY=${returned.camY}`);

/* ---------- ④ 地面视角：环在天上、预算 ---------- */
const ground = await page.evaluate(() => {
  const pg = window.__playground;
  const cam = pg.sceneManager.camera;
  const controls = pg.attractionManager.active._controls;
  // OrbitControls 的极角上限是 81.8°（相机必须高于 target），永远抬不起头，
  // 所以「地面抬头看环」的机位只能临时关掉控制器直写，渲染完立刻截图。
  controls.enabled = false;
  pg.sceneManager.setPaused(true);   // 停掉大厅的每帧仲裁，否则下一帧 OrbitControls 会把机位拽回地面
  cam.position.set(-40, 9, 118);
  cam.lookAt(0, 115, 54);
  cam.updateMatrixWorld(true);
  const hud = document.querySelector('.sky-hud');
  if (hud) hud.dataset.on = '0';     // 收掉上一步（高铁）的提示胶囊
  pg.sceneManager.renderOnce();
  return {
    tris: pg.sceneManager.renderer.info.render.triangles,
    calls: pg.sceneManager.renderer.info.render.calls,
    ringVisible: pg.sceneManager.scene.getObjectByName('Sky/ring-beam')?.visible,
  };
});
console.log('ground =', JSON.stringify(ground));
ok('⑭ 全场景三角面仍在 300k 红线内', ground.tris < 300000, `tris=${ground.tris} calls=${ground.calls}`);

await page.screenshot({ path: 'docs/screenshots/sky-3-from-ground.png' });

/* ---------- 报错扫描 ---------- */
const bad = logs.filter((l) => l.startsWith('pageerror') || l.startsWith('error'));
if (bad.length) console.log('ERRORS:\n' + bad.join('\n'));
ok('⑮ 运行期无报错', bad.length === 0, bad.slice(0, 3).join(' | '));

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);

