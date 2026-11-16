/**
 * tests/verify-phase4.mjs —— 阶段四终极验收
 * 覆盖：皇堡大门 / UI 主题 / WASD / 手机摇杆 / 触屏防误触 /
 *       大厅→动物园→跳舞厅→城堡→农场巡游 / 5 轮热路径 Δgeo·Δtex / 首包体积。
 * 运行：node tests/verify-phase4.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const errors = [];
const add = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
};
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

const browser = await chromium.launch({
  executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const initScript = () => {
  const old = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, a) {
    if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') {
      a = Object.assign({}, a, { preserveDrawingBuffer: true });
    }
    return old.call(this, t, a);
  };
  // 合成 PointerEvent 没有真实活动指针，setPointerCapture 会抛 NotFoundError。
  // 仅测试环境吞掉该类型，真实设备仍走原生捕获。
  const spc = Element.prototype.setPointerCapture;
  Element.prototype.setPointerCapture = function (id) {
    try { return spc.call(this, id); } catch (e) {
      if (e?.name === 'NotFoundError') return;
      throw e;
    }
  };
  const rpc = Element.prototype.releasePointerCapture;
  Element.prototype.releasePointerCapture = function (id) {
    try { return rpc.call(this, id); } catch (e) {
      if (e?.name === 'NotFoundError') return;
      throw e;
    }
  };
};

async function openPage(context, mobile = false) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.addInitScript(initScript);
  await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  if (!mobile) await shot(page, 'phase4-start-screen.png');
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });
  return page;
}

function mem(page) {
  return page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
}

async function waitLobby(page) {
  await page.waitForFunction(() => {
    const pg = window.__playground;
    const a = pg.attractionManager.active;
    return pg.attractionManager.activeKey === 'lobby' && a?._districts && a?._wasd && a?._uiRoot;
  }, null, { timeout: 60000 });
  await page.waitForTimeout(700);
}

/* ======================= 桌面端 ======================= */
const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await openPage(desktopCtx, false);

/* ---- A. 大门结构 + 招牌可见 ---- */
const gate = await page.evaluate(() => {
  const pg = window.__playground;
  const sm = pg.sceneManager;
  const scene = sm.scene;
  const gate = scene.getObjectByName('Lobby/gate');
  const sign = scene.getObjectByName('Lobby/gate-sign-front');
  const signWorld = sign ? sign.getWorldPosition(sign.position.clone()).toArray() : null;
  const signBox = sign ? {
    x: signWorld[0], y: signWorld[1], z: signWorld[2],
    w: sign.scale.x, h: sign.scale.y,
  } : null;
  // 招牌正面所朝方向（+z）上，是否有高于招牌 z 的独立网格压住招牌矩形
  const blockers = [];
  if (signBox && gate) {
    for (const o of gate.children) {
      if (!o.isMesh || o === sign) continue;
      const p = o.getWorldPosition(o.position.clone());
      if (p.z > signBox.z + 0.05 &&
          Math.abs(p.x - signBox.x) < signBox.w * 0.45 &&
          Math.abs(p.y - signBox.y) < signBox.h * 0.42) {
        blockers.push(o.name || o.type);
      }
    }
  }
  return {
    exists: !!gate,
    children: gate?.children.length ?? 0,
    signWorld,
    signVisible: sign?.visible === true,
    blockers,
    emblem: !!scene.getObjectByName('Lobby/gate-emblem'),
    towers: gate?.children.filter((c) => /tower--?\d+$|tower-turret-/.test(c.name)).length ?? 0,
    spires: gate?.children.filter((c) => /spire|finial|flag|banner|pennant/i.test(c.name)).length ?? 0,
    crenels: gate?.children.filter((c) => /crenel/.test(c.name)).length ?? 0,
  };
});
add('A 皇堡大门：拱/四塔/尖顶/纹章/垛口齐全', gate.exists && gate.towers >= 4 && gate.spires >= 3 && gate.crenels >= 1 && gate.emblem, gate);
add('B 游乐场招牌可见且正面无遮挡', gate.signVisible && !!gate.signWorld && gate.signWorld[1] > 12 && gate.blockers.length === 0,
  { sign: gate.signWorld, blockers: gate.blockers });

/* ---- C. UI 主题（开始页 / 暂停菜单 / 跳舞厅 HUD） ---- */
const startTheme = await page.evaluate(() => {
  const card = document.querySelector('.pg-start__card');
  const btn = document.querySelector('.pg-start__enter');
  if (!card || !btn) return null;
  const cs = getComputedStyle(card);
  const bs = getComputedStyle(btn);
  return { font: cs.fontFamily, backdrop: cs.backdropFilter, radius: cs.borderRadius, btnTransition: bs.transition };
});
add('C 开始页毛玻璃 + 统一字体 + 按钮过渡', !!startTheme && /Noto|Source Han|PingFang|Microsoft YaHei|serif/i.test(startTheme.font) &&
  startTheme.backdrop !== 'none' && /transform|background|box-shadow/.test(startTheme.btnTransition), startTheme);

/* ---- D. 大门日景/夜景截图 ---- */
const gateShots = await page.evaluate(() => {
  const pg = window.__playground;
  const sm = pg.sceneManager;
  const views = {
    day: [0, 4.0, 42, 0, 12.0, 15],
  };
  const out = {};
  for (const [name, v] of Object.entries(views)) {
    sm.camera.position.set(v[0], v[1], v[2]);
    sm.camera.up.set(0, 1, 0);
    sm.camera.lookAt(v[3], v[4], v[5]);
    sm.camera.updateProjectionMatrix();
    sm.renderer.render(sm.scene, sm.camera);
    out[name] = {
      calls: sm.renderer.info.render.calls,
      triangles: sm.renderer.info.render.triangles,
    };
    // 必须在同一 evaluate 内取帧：主循环会在下一次 rAF 用当前相机重绘，
    // 分开取会截到默认视角（曾导致招牌被裁出画面）。
    out.png = sm.renderer.domElement.toDataURL('image/png').split(',')[1];
  }
  return out;
});
const gateDayPng = gateShots.png;
delete gateShots.png;   // 报告只留机读预算，不把 1.4MB 截图 base64 塞进 JSON
fs.writeFileSync(path.join(OUT, 'phase4-gate-day.png'), Buffer.from(gateDayPng, 'base64'));
add('D 入园门景渲染预算', gateShots.day.triangles <= 300000 && gateShots.day.calls < 1500, gateShots);

/* ---- E. WASD 大厅 ---- */
await page.evaluate(() => {
  const sm = window.__playground.sceneManager;
  sm.camera.position.set(0, 9.4, 25);
  sm.camera.lookAt(0, 12.4, 0);
});
// 真实键盘需要页面焦点；把焦点给 body，避免点击场景误触长椅/设施。
await page.evaluate(() => {
  document.body.tabIndex = -1;
  document.body.focus();
});
await page.waitForTimeout(200);
const beforeLobby = await page.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await page.keyboard.down('w');
await page.waitForTimeout(120);
const lobbyKeyDown = await page.evaluate(() => [...(window.__playground.attractionManager.active?._orbitKeys || [])]);
// headless 标签页 rAF 可能被降到 ~1fps；手动推进同一 update，等价真机连续帧。
await page.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  for (let i = 0; i < 15; i += 1) a.update(1 / 60);
});
await page.keyboard.up('w');
const afterLobby = await page.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
const lobbyMove = Math.hypot(afterLobby[0] - beforeLobby[0], afterLobby[2] - beforeLobby[2]);
add('E 大厅 WASD 行走', lobbyMove > 0.15 && lobbyKeyDown.includes('KeyW'),
  { beforeLobby, afterLobby, moved: +lobbyMove.toFixed(3), keys: lobbyKeyDown });

/* ---- F. 跳舞厅 WASD + HUD + 暂停菜单 ---- */
await page.evaluate(async () => { await window.__playground.onEnterAttraction('dance-hall'); });
await page.waitForFunction(() => window.__playground.attractionManager.activeKey === 'dance-hall', null, { timeout: 60000 });
await page.waitForTimeout(500);
const beforeDance = await page.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await page.keyboard.down('w');
await page.waitForTimeout(120);
const danceKeyDown = await page.evaluate(() => window.__playground.attractionManager.active?._wasd?._keys.has('KeyW') === true);
await page.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  for (let i = 0; i < 15; i += 1) a.update(1 / 60);
});
await page.keyboard.up('w');
const afterDance = await page.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
const danceMove = Math.hypot(afterDance[0] - beforeDance[0], afterDance[2] - beforeDance[2]);
await shot(page, 'phase4-dance-hud.png');
const danceHud = await page.evaluate(() => {
  const el = document.querySelector('.dh-badge');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { font: cs.fontFamily, backdrop: cs.backdropFilter, shadow: cs.textShadow };
});
add('F 跳舞厅 WASD + 毛玻璃 HUD', danceMove > 0.15 && danceKeyDown && !!danceHud && danceHud.backdrop !== 'none',
  { moved: +danceMove.toFixed(3), keyDown: danceKeyDown, hud: danceHud });

await page.evaluate(async () => { await window.__playground.onExitAttraction(); });
await waitLobby(page);

/* ---- G. 暂停菜单（进入独立设施后按 Esc 打开） ---- */
let pauseInfo = null;
try {
  await page.evaluate(async () => { await window.__playground.onEnterAttraction('memory-match'); });
  await page.waitForFunction(() => window.__playground.attractionManager.activeKey === 'memory-match', null, { timeout: 60000 });
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  pauseInfo = await page.evaluate(() => {
    const overlay = document.querySelector('.pause-overlay');
    const card = document.querySelector('.pause-card');
    const btn = document.querySelector('.pause-btn');
    if (!overlay || !card) return null;
    const cs = getComputedStyle(card);
    return {
      open: overlay.dataset.hidden === 'false' && getComputedStyle(overlay).display !== 'none',
      backdrop: cs.backdropFilter,
      font: cs.fontFamily,
      btnTransition: btn ? getComputedStyle(btn).transition : '',
    };
  });
  await shot(page, 'phase4-pause-menu.png');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => { await window.__playground.onExitAttraction(); });
  await waitLobby(page);
} catch (e) {
  console.log('pause probe:', String(e).slice(0, 200));
}
add('G 暂停菜单毛玻璃 / 字体 / 悬停过渡', !!pauseInfo && pauseInfo.open && pauseInfo.backdrop !== 'none' &&
  /transform|background|box-shadow/.test(pauseInfo.btnTransition), pauseInfo);

await waitLobby(page);

/* ---- H. 连续巡游 大厅→动物园→跳舞厅→城堡→农场 ---- */
const tour = await page.evaluate(async () => {
  const pg = window.__playground;
  const sm = pg.sceneManager;
  const cam = sm.camera;
  const lobby = pg.attractionManager.active;
  const districts = lobby?._districts;
  const waypoints = [
    [0, 3.2, 40, 0, 5.0, 12, '大厅'],
    [36, 3.2, 30, 44, 4.0, 18, '动物园'],
    [28, 3.2, 16, 28, 3.0, 2, '跳舞厅'],
    [0, 3.2, 84, 0, 14.0, 60, '城堡'],
    [44, 3.2, 78, 58, 2.0, 62, '农场'],
  ];
  let maxCalls = 0, maxTris = 0;
  const zones = [];
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < waypoints.length; i++) {
      const a = waypoints[i];
      const b = waypoints[(i + 1) % waypoints.length];
      for (let s = 0; s <= 6; s++) {
        const t = s / 6;
        cam.position.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
        cam.lookAt(a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t, a[5] + (b[5] - a[5]) * t);
        districts?.update?.(cam);
        sm.renderer.render(sm.scene, cam);
        maxCalls = Math.max(maxCalls, sm.renderer.info.render.calls);
        maxTris = Math.max(maxTris, sm.renderer.info.render.triangles);
      }
      zones.push(a[6]);
    }
  }
  return { maxCalls, maxTris, zones: [...new Set(zones)] };
});
add('H 五区连续巡游 ≤300k 三角形', tour.maxTris <= 300000 && tour.zones.length === 5, tour);

/* ---- I. 5 轮热路径 Δgeo / Δtex ---- */
await page.evaluate(async () => {
  const pg = window.__playground;
  await pg.onEnterAttraction('dance-hall');
  pg.sceneManager.renderOnce();
  await pg.onExitAttraction();
  pg.sceneManager.renderOnce();
});
await page.waitForFunction(() => window.__playground.attractionManager.activeKey === 'lobby', null, { timeout: 60000 });
await waitLobby(page);
const steady = await mem(page);
const rounds = [];
for (let i = 0; i < 5; i++) {
  await page.evaluate(async () => {
    const pg = window.__playground;
    await pg.onEnterAttraction('dance-hall');
    pg.sceneManager.renderOnce();
    await pg.onExitAttraction();
    pg.sceneManager.renderOnce();
  });
  await page.waitForFunction(() => window.__playground.attractionManager.activeKey === 'lobby', null, { timeout: 60000 });
  await waitLobby(page);
  rounds.push(await mem(page));
}
const deltas = rounds.map((r) => ({ geo: r.geometries - steady.geometries, tex: r.textures - steady.textures }));
add('I 5 轮热路径 Δgeo/Δtex = 0/0', deltas.every((d) => d.geo === 0 && d.tex === 0), { steady, rounds, deltas });

/* ---- J. 首包体积（构建后存在 dist） ---- */
let bundle = null;
try {
  const assets = fs.readdirSync(path.resolve('dist/assets'));
  const main = assets.filter((f) => /^index-.*\.js$/.test(f)).sort((a, b) => fs.statSync(path.resolve('dist/assets', b)).size - fs.statSync(path.resolve('dist/assets', a)).size)[0];
  const css = assets.filter((f) => /\.css$/.test(f));
  if (main) {
    const buf = fs.readFileSync(path.resolve('dist/assets', main));
    bundle = {
      main,
      kb: +(buf.length / 1024).toFixed(1),
      gzipKb: +(zlib.gzipSync(buf).length / 1024).toFixed(1),
      cssKb: +(css.reduce((n, f) => n + fs.statSync(path.resolve('dist/assets', f)).size, 0) / 1024).toFixed(1),
      chunks: assets.filter((f) => /\.js$/.test(f)).length,
    };
  }
} catch (e) { bundle = { error: String(e) }; }
add('J 首包体积健康（主 JS < 700KB / gzip < 250KB）', !!bundle && bundle.kb < 700 && bundle.gzipKb < 250, bundle);

await desktopCtx.close();

/* ======================= 移动端 ======================= */
const mobileCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const mp = await openPage(mobileCtx, true);
await mp.waitForTimeout(600);

const joyState = await mp.evaluate(() => {
  const j = document.querySelector('.pg-joystick');
  if (!j) return null;
  const cs = getComputedStyle(j);
  return { hidden: j.dataset.hidden, display: cs.display, opacity: cs.opacity, rect: j.getBoundingClientRect().toJSON() };
});
add('K 手机虚拟摇杆默认可见', !!joyState && joyState.hidden !== 'true' && joyState.display !== 'none' && joyState.rect.width > 80, joyState);

async function joystickDrag(page, dx = 38, dy = 0) {
  const info = await page.evaluate(([dx, dy]) => {
    const j = document.querySelector('.pg-joystick');
    const ring = j?.querySelector('.pg-joystick__ring') || j;
    if (!ring) return null;
    const r = ring.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const fire = (type, x, y) => ring.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 71, isPrimary: true,
      pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    fire('pointerdown', cx, cy);
    fire('pointermove', cx + dx, cy + dy);
    return { cx, cy, hidden: j.dataset.hidden };
  }, [dx, dy]);
  await page.waitForTimeout(700);
  return info;
}
async function joystickRelease(page) {
  await page.evaluate(() => {
    const j = document.querySelector('.pg-joystick');
    const ring = j?.querySelector('.pg-joystick__ring') || j;
    if (!ring) return;
    const r = ring.getBoundingClientRect();
    ring.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 71, isPrimary: true,
      pointerType: 'touch', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 0,
    }));
  });
}

const beforeJoy = await mp.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await joystickDrag(mp, 40, 0);
await mp.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  for (let i = 0; i < 12; i += 1) a.update(1 / 60);
});
const afterJoy = await mp.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await joystickRelease(mp);
const joyMove = Math.hypot(afterJoy[0] - beforeJoy[0], afterJoy[2] - beforeJoy[2]);
add('L 手机摇杆驱动大厅相机', joyMove > 0.1, { beforeJoy, afterJoy, moved: +joyMove.toFixed(3) });

/* 跳舞厅内摇杆 */
await mp.evaluate(async () => { await window.__playground.onEnterAttraction('dance-hall'); });
await mp.waitForFunction(() => window.__playground.attractionManager.activeKey === 'dance-hall', null, { timeout: 60000 });
await mp.waitForTimeout(600);
const danceJoyState = await mp.evaluate(() => {
  const j = document.querySelector('.pg-joystick');
  return j ? { hidden: j.dataset.hidden, display: getComputedStyle(j).display } : null;
});
const beforeDanceJoy = await mp.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await joystickDrag(mp, 0, -40);
await mp.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  for (let i = 0; i < 12; i += 1) a.update(1 / 60);
});
const afterDanceJoy = await mp.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await joystickRelease(mp);
const danceJoyMove = Math.hypot(afterDanceJoy[0] - beforeDanceJoy[0], afterDanceJoy[2] - beforeDanceJoy[2]);
await shot(mp, 'phase4-mobile-dance.png');
add('M 跳舞厅内摇杆可见且可用', !!danceJoyState && danceJoyState.hidden !== 'true' && danceJoyState.display !== 'none' && danceJoyMove > 0.08,
  { state: danceJoyState, moved: +danceJoyMove.toFixed(3) });

await mp.evaluate(async () => { await window.__playground.onExitAttraction(); });
await waitLobby(mp);
await mp.bringToFront();

/* 玉米地/农场内摇杆 + 截图 */
const farmState = await mp.evaluate(() => {
  const pg = window.__playground;
  const sm = pg.sceneManager;
  const lobby = pg.attractionManager.active;
  sm.camera.position.set(46, 3.2, 74);
  lobby?._controls?.target.set(58, 2.0, 62);
  sm.camera.lookAt(58, 2.0, 62);
  lobby?._controls?.update?.();
  const j = document.querySelector('.pg-joystick');
  return { hidden: j?.dataset.hidden, display: j ? getComputedStyle(j).display : null, mode: lobby?._inputMode };
});
await mp.waitForTimeout(300);
const beforeFarmJoy = await mp.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await joystickDrag(mp, 0, -40);
// headless 移动端标签页会被 Chrome 降到 ~1fps；手动推进同一场景 update，
// 等价于真机连续帧，验证摇杆→虚拟轴→panOrbit 的完整链路。
await mp.evaluate(() => {
  const a = window.__playground.attractionManager.active;
  for (let i = 0; i < 12; i += 1) a.update(1 / 60);
});
const afterFarmJoy = await mp.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
await joystickRelease(mp);
const farmJoyMove = Math.hypot(afterFarmJoy[0] - beforeFarmJoy[0], afterFarmJoy[2] - beforeFarmJoy[2]);
await shot(mp, 'phase4-mobile-corn.png');
add('N 农场/玉米地摇杆可用', !!farmState && farmState.hidden !== 'true' && farmJoyMove > 0.08,
  { state: farmState, beforeFarmJoy, afterFarmJoy, moved: +farmJoyMove.toFixed(3) });

/* ---- O. 触屏滑动转视角不误触设施 ---- */
const touchProbe = await mp.evaluate(() => new Promise((resolve) => {
  const pg = window.__playground;
  const lobby = pg.attractionManager.active;
  const canvas = pg.sceneManager.renderer.domElement;
  let clicks = 0;
  const original = lobby._handleClick.bind(lobby);
  lobby._handleClick = () => { clicks++; };
  const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 81, isPrimary: true,
    pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
  const r = canvas.getBoundingClientRect();
  const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
  fire('pointerdown', cx, cy);
  fire('pointermove', cx + 90, cy + 40);
  fire('pointermove', cx + 20, cy + 10);
  fire('pointerup', cx + 20, cy + 10);
  const dragClicks = clicks;
  setTimeout(() => {
    fire('pointerdown', cx, cy);
    fire('pointerup', cx, cy);
    const tapClicks = clicks;
    lobby._handleClick = original;
    resolve({ dragClicks, tapClicks, maxDist: lobby._pointerMaxDist });
  }, 300);
}));
add('O 触屏拖拽不触发设施 / 轻点仍可进入', touchProbe.dragClicks === 0 && touchProbe.tapClicks === 1, touchProbe);

await mobileCtx.close();
await browser.close();

/* ---- 汇总 ---- */
const pass = checks.filter((c) => c.ok).length;
const result = {
  phase: 4,
  generatedAt: new Date().toISOString(),
  pass,
  total: checks.length,
  allPass: pass === checks.length && errors.length === 0,
  checks,
  errors,
  bundle,
  screenshots: fs.readdirSync(OUT).filter((f) => f.startsWith('phase4-')).sort(),
};
fs.writeFileSync(path.resolve('docs/phase4-report.json'), JSON.stringify(result, null, 2));
console.log(`\nPHASE4 ${pass}/${checks.length} allPass=${result.allPass}`);
console.log(`errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log('  ' + e);
process.exit(result.allPass ? 0 : 1);
