/**
 * 双人联机浏览器验收：
 *   node tests/verify-multiplayer.mjs
 *
 * 前置：npm run dev 已在 5173 启动（联机服务与 Vite 同端口）。
 * 用两个独立浏览器分别登录 player1 / player2，验证：
 *   ① 登录页由服务端校验，成功后进入开始页
 *   ② 两个客户端在大厅互相看到远端角色
 *   ③ 一方的相机移动会同步到另一方的远端目标位置
 *   ④ 「一起回家」一键把双方都带进别墅，且同 zone 时远端角色可见
 *
 * 说明：headless SwiftShader 同时渲染两个 3D 页面容易把 Chromium 拖死，
 * 因此 player1 进入后先暂停渲染循环，等 player2 就绪后再恢复；联机消息
 * 走 250ms HTTP 轮询（/api/room），不依赖 rAF。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const URL = process.env.MULTIPLAYER_URL || `http://127.0.0.1:${PORT}/`;
const ROOM = process.env.MP_ROOM || `e2e-${Date.now().toString(36)}`;
const GAME_URL = `${URL}${URL.includes('?') ? '&' : '?'}no-prewarm=1&room=${encodeURIComponent(ROOM)}`;
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.resolve('docs/screenshots');
const HEADLESS = process.env.HEADED !== '1';

fs.mkdirSync(OUT, { recursive: true });

const results = [];
const logs = { player1: [], player2: [] };
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const launch = () => chromium.launch({
  executablePath: EDGE,
  headless: HEADLESS,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

async function openGame(browser, user, pass, autoLogin = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => logs[user].push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'debug') logs[user].push(`${msg.type()}: ${msg.text()}`);
  });

  const url = autoLogin
    ? `${GAME_URL}&u=${encodeURIComponent(user)}&p=${encodeURIComponent(pass)}`
    : GAME_URL;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });

  if (autoLogin) {
    /* 分享链接形态：打开即自动登录，最终停在开始页 */
    try {
      await page.waitForFunction(
        () => document.querySelector('.pg-start--visible') && !document.querySelector('.pg-login--visible'),
        null,
        { timeout: 45000 },
      );
    } catch (err) {
      const error = await page.textContent('[data-role="error"]').catch(() => '');
      throw new Error(`${user} 链接自动登录失败：${error || err.message}`);
    }
  } else {
    await page.waitForFunction(() => document.querySelector('.pg-login--visible'), null, { timeout: 90000 });
    await page.fill('[data-role="user"]', user);
    await page.fill('[data-role="pass"]', pass);
    await page.click('[data-role="submit"]');
    try {
      await page.waitForFunction(() => !document.querySelector('.pg-login--visible'), null, { timeout: 30000 });
    } catch (err) {
      const error = await page.textContent('[data-role="error"]').catch(() => '');
      throw new Error(`${user} 登录失败：${error || err.message}`);
    }
    await page.waitForFunction(() => document.querySelector('.pg-start--visible'), null, { timeout: 20000 });
  }

  await page.click('.pg-start__enter[data-action="start"]');
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 240000 });
  await page.waitForFunction(() => window.__playground.multiplayer.connected === true, null, { timeout: 20000 });

  return page;
}

async function dumpState(page, label) {
  const debug = await page.evaluate(() => {
    const pg = window.__playground;
    const mp = pg.multiplayer;
    return {
      me: mp.me,
      connected: mp.connected,
      room: mp.room,
      hasToken: Boolean(mp._token),
      zone: mp.zone,
      peers: [...mp.peers.keys()],
      peerZones: [...mp.peers.values()].map((p) => p.zone),
      remoteChildren: mp._remoteRoot?.children.length ?? null,
      sceneReady: mp._sceneReady,
      activeKey: pg.facilityRuntime.activeKey,
      canAutoEnter: typeof mp._canAutoEnter === 'function' ? mp._canAutoEnter() : null,
      hasEnterHome: typeof mp._enterHome === 'function',
      lastSyncAt: mp._lastSyncAt,
      toast: document.querySelector('.mp-toast')?.textContent,
      hud: document.querySelector('.mp-hud')?.textContent,
    };
  });
  console.error(`${label} 状态：`, JSON.stringify(debug));
  return debug;
}

let browser1 = null;
let browser2 = null;
let page1 = null;
let page2 = null;

try {
  browser1 = await launch();
  page1 = await openGame(browser1, 'player1', 'play1234', true);
  await page1.waitForTimeout(800);
  ok('① 链接自动登录 player1 并进入游戏', true, 'link ?u=player1 -> start -> loopStarted');

  /* 先暂停 player1 的渲染，给 player2 一个干净的加载窗口 */
  await page1.evaluate(() => window.__playground.sceneManager.stop());
  browser2 = await launch();
  page2 = await openGame(browser2, 'player2', 'play1234', true);
  await page1.evaluate(() => window.__playground.sceneManager.start());
  await page2.waitForTimeout(800);
  ok('② 链接自动登录 player2 并进入游戏', true, 'link ?u=player2 -> start -> loopStarted');

  try {
    await page1.waitForFunction(() => window.__playground.multiplayer.peers.size === 1, null, { timeout: 20000 });
    await page2.waitForFunction(() => window.__playground.multiplayer.peers.size === 1, null, { timeout: 20000 });
  } catch {
    await dumpState(page1, 'player1');
    await dumpState(page2, 'player2');
    throw new Error('双方未互相看到远端角色');
  }

  const peerInfo = await page1.evaluate(() => {
    const mp = window.__playground.multiplayer;
    const peer = [...mp.peers.values()][0];
    return {
      name: peer?.name,
      inScene: Boolean(peer?.group?.parent),
      rootChildren: mp._remoteRoot?.children.length ?? 0,
    };
  });
  ok('③ 双方互相看到远端角色', peerInfo.name === '小月' && peerInfo.inScene && peerInfo.rootChildren === 1,
    JSON.stringify(peerInfo));

  await page1.screenshot({ path: path.join(OUT, 'verify-multiplayer-lobby.png') });

  /* 受控 dt 驱动 WASD：headless 下 rAF 被节流，不能靠墙钟等待 */
  const before = await page1.evaluate(() => {
    const p = window.__playground;
    p.movementMode.engage();
    const c = p.sceneManager.camera;
    return { x: c.position.x, z: c.position.z };
  });
  await page1.evaluate(() => {
    const p = window.__playground;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    for (let i = 0; i < 18; i += 1) p.movementMode.update(0.08);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
  });
  // 线上联机是 250ms HTTP 轮询：等下一次 sync 把新位置发出去
  await sleep(700);
  const after = await page1.evaluate(() => {
    const c = window.__playground.sceneManager.camera;
    return { x: c.position.x, y: c.position.y, z: c.position.z };
  });
  const moved = Math.hypot(after.x - before.x, after.z - before.z);

  let syncOk = false;
  let peerTarget = null;
  try {
    await page2.waitForFunction((pos) => {
      const mp = window.__playground.multiplayer;
      const peer = [...mp.peers.values()][0];
      if (!peer) return false;
      return Math.hypot(peer.target.x - pos.x, peer.target.z - pos.z) < 1.2;
    }, after, { timeout: 8000 });
    syncOk = true;
  } catch {
    /* 落到下方统一输出 */
  }
  peerTarget = await page2.evaluate(() => {
    const peer = [...window.__playground.multiplayer.peers.values()][0];
    return peer ? { x: +peer.target.x.toFixed(2), y: +peer.target.y.toFixed(2), z: +peer.target.z.toFixed(2), zone: peer.zone } : null;
  });
  ok('④ 大厅移动同步到队友客户端', moved > 0.5 && syncOk,
    `moved=${moved.toFixed(2)}m from(${before.x.toFixed(1)},${before.z.toFixed(1)}) to(${after.x.toFixed(1)},${after.z.toFixed(1)}) peerTarget=${JSON.stringify(peerTarget)}`);

  /* 一起回家：player1 点 HUD 按钮，player2 应自动跟随 */
  await page1.click('.mp-hud__home');
  await page1.waitForFunction(() => window.__playground.facilityRuntime.activeKey === 'villa', null, { timeout: 30000 });
  try {
    await page2.waitForFunction(() => window.__playground.facilityRuntime.activeKey === 'villa', null, { timeout: 45000 });
  } catch {
    await dumpState(page1, 'player1');
    await dumpState(page2, 'player2');
    throw new Error('player2 未跟随进入别墅');
  }
  await page1.waitForTimeout(1000);

  /* 服务端同步的 target 先落到别墅玄关；远端角色的渲染位置由插值追赶，
   * 这里手动推进若干步，避免 headless 节流导致“仍在穿墙路上”的误判。 */
  await page1.waitForFunction(() => {
    const peer = [...window.__playground.multiplayer.peers.values()][0];
    return Boolean(peer) && Math.abs(peer.target.x + 30) < 14 && Math.abs(peer.target.z - 134) < 18;
  }, null, { timeout: 30000 });
  await page1.evaluate(() => {
    const mp = window.__playground.multiplayer;
    for (let i = 0; i < 40; i += 1) mp.update(0.05);
  });

  const home = await page1.evaluate(() => {
    const pg = window.__playground;
    const mp = pg.multiplayer;
    const peer = [...mp.peers.values()][0];
    const cam = pg.sceneManager.camera;
    return {
      myZone: mp.zone,
      peerZone: peer?.zone,
      peerVisible: peer?.group?.visible === true,
      peerPos: peer ? { x: +peer.group.position.x.toFixed(2), z: +peer.group.position.z.toFixed(2) } : null,
      cam: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
      embedKey: pg.facilityRuntime.activeKey,
      lobbyStillActive: pg.attractionManager.activeKey === 'lobby',
    };
  });
  const peerInVilla = Boolean(home.peerPos)
    && Math.abs(home.peerPos.x + 30) < 12 && Math.abs(home.peerPos.z - 134) < 14;

  ok('⑤ 一起回家：双方都进入别墅', home.myZone === 'villa' && home.peerZone === 'villa' && home.embedKey === 'villa',
    JSON.stringify(home));
  ok('⑥ 别墅内能看到队友（同一 zone）', home.peerVisible && peerInVilla, JSON.stringify(home.peerPos));
  ok('⑦ 大厅常驻未卸载', home.lobbyStillActive === true, `activeKey(lobby)=${home.lobbyStillActive}`);

  /* 证据截图布置：page2 停在玄关内侧，page1 站到客厅回望玄关。
   * 只用于让「同一 zone 内互相可见」在画面上可读，不改任何联机逻辑。 */
  await page2.evaluate(() => {
    const pg = window.__playground;
    pg.sceneManager.stop();
    pg.sceneManager.camera.position.set(-31.6, 2.8, 130.5);
    pg.sceneManager.camera.updateMatrixWorld(true);
  });
  // 给 250ms 轮询一次发送机会
  await page2.waitForTimeout(700);
  await page1.waitForFunction(() => {
    const peer = [...window.__playground.multiplayer.peers.values()][0];
    return Boolean(peer) && Math.abs(peer.target.x + 31.6) < 1.5 && Math.abs(peer.target.z - 130.5) < 1.5;
  }, null, { timeout: 8000 });

  await page1.evaluate(() => {
    const pg = window.__playground;
    const cam = pg.sceneManager.camera;
    const villa = pg.facilityRuntime.activeView?.villa;
    cam.position.set(-30, 2.8, 136.5);
    if (villa?._wasd) {
      villa._wasd.yaw = 0;   // 面向世界 -Z（玄关 / 门口方向）
      villa._wasd.pitch = 0;
      villa._wasd.update(0.05);
    }
    cam.updateMatrixWorld(true);
    const mp = pg.multiplayer;
    for (let i = 0; i < 50; i += 1) mp.update(0.05);
  });
  await page1.waitForTimeout(500);

  const view = await page1.evaluate(() => {
    const pg = window.__playground;
    const peer = [...pg.multiplayer.peers.values()][0];
    const cam = pg.sceneManager.camera;
    const probe = peer.group.position.clone();
    probe.y += 1.0;
    probe.project(cam);
    return {
      visible: peer.group.visible,
      ndc: { x: +probe.x.toFixed(2), y: +probe.y.toFixed(2), z: +probe.z.toFixed(2) },
      pos: { x: +peer.group.position.x.toFixed(2), y: +peer.group.position.y.toFixed(2), z: +peer.group.position.z.toFixed(2) },
      cam: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
    };
  });
  const inView = view.visible && Math.abs(view.ndc.x) < 1 && Math.abs(view.ndc.y) < 1 && view.ndc.z < 1;
  ok('⑧ 队友角色处于玩家相机视野内', inView, JSON.stringify(view));

  await page1.screenshot({ path: path.join(OUT, 'verify-multiplayer-home.png') });

  const failCount = results.filter((r) => !r.pass).length;
  console.log(`\n联机浏览器验收：${results.length - failCount}/${results.length} 通过`);
  if (failCount) process.exitCode = 1;
} catch (err) {
  console.error('\n验收中断：', err?.message || err);
  if (page1) await page1.screenshot({ path: path.join(OUT, 'verify-multiplayer-error-1.png') }).catch(() => {});
  if (page2) await page2.screenshot({ path: path.join(OUT, 'verify-multiplayer-error-2.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  for (const [label, list] of Object.entries(logs)) {
    const errors = list.filter((line) => line.startsWith('pageerror') || line.startsWith('error'));
    if (errors.length) console.log(`${label} 控制台错误：\n${errors.slice(0, 8).join('\n')}`);
    if (process.exitCode === 1 && list.length) {
      console.log(`${label} 控制台尾部：\n${list.slice(-12).join('\n')}`);
    }
  }
  await browser1?.close().catch(() => {});
  await browser2?.close().catch(() => {});
}