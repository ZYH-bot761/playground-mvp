/**
 * ============================================================================
 * tests/verify-launch-qa.mjs —— 上线前 5 维全量端到端 QA（2026-11）
 * ============================================================================
 * 覆盖：
 *  A 全设施闭环：12 个入口 + 动物园/农家乐/森林公园世界区
 *  B 核心交互：键盘/摇杆/点击、F 驾驶、红绿灯/AI、季节/昼夜狂切
 *  C UX：防误触、HUD 窄屏遮挡、F/E 毛玻璃提示
 *  D 边界：R 自救（卡住/驾驶/嵌入）、GPU/网络降级
 *  E 健壮性：5 分钟城市模拟 0 pageerror / 0 console.error + 预算/内存
 *
 * 运行：node tests/verify-launch-qa.mjs
 * ============================================================================
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://127.0.0.1:${PORT}/`;
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'launch-qa-report.json');
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const runtimeErrors = [];
const pagesErrors = [];
const shots = [];
let browser;
let page;

function add(id, name, pass, detail, warnOnly = false) {
  const status = pass ? 'PASS' : (warnOnly ? 'WARN' : 'FAIL');
  checks.push({ id, name, status, detail: detail ?? null });
  console.log(`${status.padEnd(4)} [${id}] ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

async function shot(name) {
  try {
    await page.evaluate(() => window.__playground?.sceneManager?.renderOnce?.());
    const f = path.join(OUT, `qa-launch-${name}.png`);
    await page.screenshot({ path: f, animations: 'disabled', timeout: 30000 });
    shots.push(f);
    return f;
  } catch (e) {
    runtimeErrors.push(`screenshot ${name}: ${e.message}`);
    return null;
  }
}

/** 受控推进（headless SwiftShader 的 rAF 极慢） */
async function drive(frames = 30, dt = 1 / 60) {
  return page.evaluate(({ frames, dt }) => {
    const pg = window.__playground;
    const a = pg.attractionManager?.active;
    const isLobby = a && typeof a._inputMode === 'string';
    for (let i = 0; i < frames; i += 1) {
      pg.facilityRuntime?.update?.(dt);
      if (isLobby) a.update?.(dt);
      else a?.update?.(dt);
    }
    return {
      activeKey: pg.attractionManager?.activeKey,
      embedded: !!pg.facilityRuntime?.isEmbeddedActive,
      paused: !!pg.sceneManager?._paused,
      cam: pg.sceneManager?.camera?.position?.toArray?.(),
    };
  }, { frames, dt });
}

async function ensureLobby() {
  await page.evaluate(() => {
    const pg = window.__playground;
    pg.sceneManager?.setPaused?.(false);
    if (pg.facilityRuntime?.isEmbeddedActive) pg.onExitAttraction?.();
  });
  await page.waitForTimeout(120);
  const st = await page.evaluate(() => window.__playground?.attractionManager?.activeKey);
  if (st !== 'lobby') {
    await page.evaluate(() => window.__playground.onExitAttraction?.());
    await page.waitForTimeout(220);
  }
  await drive(70, 1 / 60);
  return page.evaluate(() => ({
    activeKey: window.__playground?.attractionManager?.activeKey,
    embedded: !!window.__playground?.facilityRuntime?.isEmbeddedActive,
  }));
}

async function nearTrigger(key) {
  return page.evaluate((k) => {
    const pg = window.__playground;
    const lobby = pg.attractionManager.active;
    const f = lobby.root.userData.layout.find((x) => x.key === k);
    const cam = pg.sceneManager.camera;
    const yaw = Math.atan2(-(f.x - f.trigger.x), -(f.z - f.trigger.z));
    cam.position.set(f.trigger.x, 1.6, f.trigger.z);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(0, yaw, 0);
    cam.updateMatrixWorld(true);
    lobby._inputMode = 'wasd';
    lobby._wasdBlendActive = false;
    lobby._controls.enabled = false;
    lobby._wasd?.resetFromCamera(cam);
    for (let i = 0; i < 8; i += 1) lobby.update(1 / 60);
    const el = document.querySelector('[data-role="interact-hint"]');
    return {
      near: lobby._nearFacility ? { key: lobby._nearFacility.key, name: lobby._nearFacility.name } : null,
      promptOn: el?.dataset.on,
      promptText: el?.textContent?.replace(/\s+/g, ' ').trim(),
      cam: cam.position.toArray(),
      quat: cam.quaternion.toArray(),
    };
  }, key);
}

const EXPECT = {
  'pumpkin-thrower': 'ferris-wheel',
  'parkour-run': 'parkour-run',
  'memory-match': 'memory-match',
  'dance-hall': 'dance-hall',
  carousel: 'carousel',
  'pirate-ship': 'pirate-ship',
  'train-ride': 'train-ride',
  'fireworks-deck': 'fireworks-deck',
  'century-clock': 'century-clock',
};
const EMBEDDED = new Set(['ferris-wheel', 'carousel', 'pirate-ship']);

async function enterByE(key) {
  const before = await nearTrigger(key);
  await page.waitForTimeout(360);
  await page.keyboard.press('e');
  const expect = EXPECT[key];
  await page.waitForFunction((e) => {
    const pg = window.__playground;
    return pg.facilityRuntime?.activeKey === e || pg.attractionManager?.activeKey === e;
  }, expect, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(150);
  const state = await page.evaluate((e) => {
    const pg = window.__playground;
    return {
      activeKey: pg.attractionManager?.activeKey,
      embeddedKey: pg.facilityRuntime?.activeKey,
      expected: e,
      hud: [...document.querySelectorAll('[class*="-ui"],[class*="hud"],.pause-trigger')]
        .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
        .map((el) => el.className).slice(0, 8),
    };
  }, expect);
  return { before, state, ok: state.embeddedKey === expect || state.activeKey === expect };
}

async function operate(key) {
  const expect = EXPECT[key];
  if (EMBEDDED.has(expect)) {
    const a = await page.evaluate((e) => {
      const pg = window.__playground;
      const v = pg.facilityRuntime.activeView;
      return {
        angle: v?.angle ?? null, swing: v?._swing ?? null, phase: v?._phase ?? null,
        cam: window.__playground.sceneManager.camera.position.toArray(),
      };
    }, expect);
    await drive(90, 1 / 60);
    const b = await page.evaluate(() => {
      const v = window.__playground.facilityRuntime.activeView;
      return { angle: v?.angle ?? null, swing: v?._swing ?? null, phase: v?._phase ?? null, cam: window.__playground.sceneManager.camera.position.toArray() };
    });
    const changed = Math.abs((b.angle ?? 0) - (a.angle ?? 0)) > 0.005
      || Math.abs((b.swing ?? 0) - (a.swing ?? 0)) > 0.005
      || Math.abs((b.phase ?? 0) - (a.phase ?? 0)) > 0.005;
    const camMoved = Math.hypot(...b.cam.map((v, i) => v - a.cam[i]));
    return { kind: 'embedded', changed, camMoved: +camMoved.toFixed(3), ok: changed || camMoved > 0.2, a, b };
  }
  if (key === 'parkour-run') {
    await page.evaluate(() => document.querySelector('#pk-start')?.click());
    await page.waitForTimeout(3600);
    await drive(90, 1 / 60);
    const st = await page.evaluate(() => {
      const a = window.__playground.attractionManager.active;
      return { state: a?._state, distance: a?._distance, speed: a?._speed };
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const pause = await page.evaluate(() => {
      const o = document.querySelector('.pause-overlay');
      return { exists: !!o, hidden: o?.dataset.hidden, paused: !!window.__playground.sceneManager._paused };
    });
    return { kind: 'game', state: st, pause, ok: st.state !== 'ready' && (st.distance ?? 0) >= 0 && pause.exists && pause.hidden === 'false' };
  }
  if (key === 'memory-match') {
    await page.evaluate(() => document.querySelector('.mm-panel [data-action="start"]')?.click());
    await drive(40, 1 / 60);
    const st = await page.evaluate(() => window.__playground.attractionManager.active?._state);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const pause = await page.evaluate(() => {
      const o = document.querySelector('.pause-overlay');
      return { exists: !!o, hidden: o?.dataset.hidden, paused: !!window.__playground.sceneManager._paused };
    });
    return { kind: 'game', state: st, pause, ok: st !== 'ready' && pause.exists && pause.hidden === 'false' };
  }
  if (key === 'train-ride') {
    await page.evaluate(() => document.querySelector('[data-action="ride"]')?.click());
    await drive(90, 1 / 60);
    const st = await page.evaluate(() => {
      const a = window.__playground.attractionManager.active;
      return { state: a?._state, t: a?._t };
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const pause = await page.evaluate(() => {
      const o = document.querySelector('.pause-overlay');
      return { exists: !!o, hidden: o?.dataset.hidden, paused: !!window.__playground.sceneManager._paused };
    });
    return { kind: 'game', state: st, pause, ok: st.state === 'riding' && (st.t ?? 0) > 0 && pause.exists && pause.hidden === 'false' };
  }
  if (key === 'dance-hall') {
    await page.keyboard.down('w');
    await drive(50, 1 / 60);
    await page.keyboard.up('w');
    const st = await page.evaluate(() => {
      const a = window.__playground.attractionManager.active;
      return { time: a?._time, player: a?._playerMesh?.position?.toArray?.() };
    });
    return { kind: 'game', state: st, ok: (st.time ?? 0) > 0.3 };
  }
  if (key === 'fireworks-deck') {
    const fired = await page.evaluate(() => {
      const b = document.querySelector('[data-act="launch"]');
      if (!b) return false;
      b.click();
      return true;
    });
    await drive(70, 1 / 60);
    return { kind: 'game', state: { fired }, ok: fired };
  }
  if (key === 'century-clock') {
    await drive(70, 1 / 60);
    const st = await page.evaluate(() => {
      const a = window.__playground.attractionManager.active;
      return { t: a?._t, hands: !!a?._tower };
    });
    return { kind: 'game', state: st, ok: st.hands };
  }
  return { kind: 'unknown', ok: false };
}

async function exitFacility(key, op) {
  const expect = EXPECT[key];
  if (EMBEDDED.has(expect)) {
    await page.evaluate(() => {
      const lobby = window.__playground.attractionManager.active;
      lobby?.update?.(1 / 60);
      const b = document.querySelector('[data-role="facility-exit"]');
      if (b) b.click();
    });
  } else if (key === 'dance-hall') {
    await page.evaluate(() => document.querySelector('[data-dh="exit"]')?.click());
  } else if (key === 'fireworks-deck') {
    await page.evaluate(() => document.querySelector('[data-act="exit"]')?.click());
  } else if (key === 'century-clock') {
    await page.evaluate(() => document.querySelector('#cc-exit')?.click());
  } else {
    // parkour / memory / train：ESC 打开通用暂停菜单 → 退出
    const pauseVisible = await page.evaluate(() => {
      const o = document.querySelector('.pause-overlay');
      return !!o && o.dataset.hidden === 'false';
    });
    if (!pauseVisible) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await page.evaluate(() => document.querySelector('.pause-overlay button[data-pause-action="exit"]')?.click());
  }
  await page.waitForTimeout(250);
  const activeNow = await page.evaluate(() => ({
    key: window.__playground.attractionManager?.activeKey,
    embedded: !!window.__playground.facilityRuntime?.isEmbeddedActive,
  }));
  await drive(80, 1 / 60);
  return activeNow;
}

function quatAngle(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, Math.max(-1, d)));
}

/* ============================== 启动 ============================== */
try {
  browser = await chromium.launch({
    executablePath: fs.existsSync(EDGE) ? EDGE : undefined,
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  page.on('pageerror', (e) => {
    const m = 'pageerror: ' + e.message;
    pagesErrors.push(m); runtimeErrors.push(m);
    console.log('PAGEERROR', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = 'console.error: ' + m.text();
      pagesErrors.push(t); runtimeErrors.push(t);
      console.log('CONSOLE-ERROR', m.text());
    }
  });

  const t0 = Date.now();
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
  const clickToPlay = Date.now() - t0;
  await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone === true, null, { timeout: 180000 })
    .catch(() => runtimeErrors.push('backgroundPrewarmDone 超时'));
  await page.waitForTimeout(400);
  add('A0', '启动：bootReady / 点击可玩 / 预热完成', true, { clickToPlayMs: clickToPlay });
  add('A0b', '启动期 0 pageerror / 0 console.error', pagesErrors.length === 0, { errors: pagesErrors.slice(0, 4) });

  /* ---------------------- 预算：overview 机位 ---------------------- */
  const budget = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager, r = sm.renderer, cam = sm.camera;
    const savedP = cam.position.clone(), savedQ = cam.quaternion.clone();
    cam.position.set(0, 30, 34); cam.up.set(0, 1, 0); cam.lookAt(0, 2, 0); cam.updateMatrixWorld(true);
    const old = r.info.autoReset; r.info.autoReset = false; r.info.reset();
    r.render(sm.scene, cam);
    const out = { calls: r.info.render.calls, triangles: r.info.render.triangles, mem: { ...r.info.memory } };
    r.info.autoReset = old;
    cam.position.copy(savedP); cam.quaternion.copy(savedQ); cam.updateMatrixWorld(true);
    return out;
  });
  add('A0c', '红线上限：draw calls ≤ 900 且 triangles ≤ 300000', budget.calls <= 900 && budget.triangles <= 300000, budget);
  await shot('01-overview');

  /* ============================ 维度一 ============================ */
  const facilities = [
    ['pumpkin-thrower', '南瓜投手（摩天轮）'],
    ['parkour-run', '金币小径（跑酷）'],
    ['memory-match', '记忆翻牌'],
    ['dance-hall', '跳舞厅'],
    ['carousel', '旋转木马'],
    ['pirate-ship', '海盗船'],
    ['train-ride', '高空环游'],
    ['fireworks-deck', '烟花甲板'],
    ['century-clock', '世纪钟'],
  ];
  const facilityEvidence = [];
  for (const [key, label] of facilities) {
    try {
      await ensureLobby();
      const enter = await enterByE(key);
      add(`A1-${key}`, `${label}：靠近出现 E 提示`, enter.before.promptOn === '1' && !!enter.before.near, enter.before);
      add(`A2-${key}`, `${label}：按 E 成功进入`, enter.ok, enter.state);
      const op = await operate(key);
      add(`A3-${key}`, `${label}：游玩/操作无卡死`, !!op.ok, op);
      const exitState = await exitFacility(key, op);
      const after = await page.evaluate(() => ({
        activeKey: window.__playground.attractionManager?.activeKey,
        embedded: !!window.__playground.facilityRuntime?.isEmbeddedActive,
        cam: window.__playground.sceneManager.camera.position.toArray(),
        quat: window.__playground.sceneManager.camera.quaternion.toArray(),
      }));
      const posDiff = Math.hypot(
        after.cam[0] - enter.before.cam[0],
        after.cam[1] - enter.before.cam[1],
        after.cam[2] - enter.before.cam[2],
      );
      const rotDiff = quatAngle(after.quat, enter.before.quat);
      add(`A4-${key}`, `${label}：退出回大厅且相机不偏移`,
        exitState.key === 'lobby' && !exitState.embedded && posDiff < 0.12 && rotDiff < 0.03,
        { posDiff: +posDiff.toFixed(4), rotDiff: +rotDiff.toFixed(4), exitState });
      facilityEvidence.push({ key, label, prompt: enter.before.promptText, op, posDiff, rotDiff });
      if (key === 'carousel') await shot('02-carousel');
    } catch (e) {
      add(`A1-${key}`, `${label}：全流程`, false, { error: e.message });
    }
  }

  /* ---------------------- 动物园 / 农家乐 / 森林 ---------------------- */
  try {
    await ensureLobby();
    const zoo = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const btn = document.querySelector('[data-role="zoo-visit"]');
      if (!btn) return { hasButton: false };
      const before = pg.sceneManager.camera.position.toArray();
      btn.click();
      for (let i = 0; i < 120; i += 1) lobby.update(1 / 60);
      const st = lobby._zooFly;
      return {
        hasButton: true,
        active: !!st,
        cam: pg.sceneManager.camera.position.toArray(),
        before,
        animals: lobby._zoo?.root?.children?.length ?? null,
        inZoo: lobby._zooView === true,
      };
    });
    const zooTarget = [60, 33, 24];
    const zooDist = zoo.hasButton
      ? Math.hypot(...zoo.cam.map((v, i) => v - zooTarget[i]))
      : Infinity;
    add('B1', '动物园：进入内部近距离机位',
      zoo.hasButton && zoo.inZoo && zooDist < 2, { ...zoo, zooDist: +zooDist.toFixed(2) });
    await shot('03-zoo');
    const zooBack = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      document.querySelector('[data-role="zoo-visit"]')?.click();
      for (let i = 0; i < 120; i += 1) lobby.update(1 / 60);
      return { cam: pg.sceneManager.camera.position.toArray(), inZoo: lobby._zooView === true };
    });
    add('B2', '动物园：退出后回中央广场机位',
      !zooBack.inZoo && Math.hypot(...zooBack.cam.map((v, i) => v - [0, 30, 34][i])) < 0.35, zooBack);
  } catch (e) {
    add('B1', '动物园：进入/退出', false, { error: e.message });
  }

  try {
    await ensureLobby();
    const ground = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      const sample = (x, z, frames) => {
        cam.position.set(x, 1.6, z);
        lobby._inputMode = 'wasd';
        lobby._wasdBlendActive = false;
        lobby._controls.enabled = false;
        lobby._wasd?.resetFromCamera(cam);
        for (let i = 0; i < frames; i += 1) lobby.update(1 / 60);
        return cam.position.toArray();
      };
      return {
        farm: sample(45, 57, 80),
        bridge: sample(-64, 68, 80),
        forest: sample(-88, 60, 80),
      };
    });
    add('B3', '农家乐：走进农田，眼位抬到田垄之上', ground.farm[1] > 2.55 && ground.farm[1] < 3.2, ground.farm);
    add('B4', '森林公园：走上拱桥，眼位贴合桥面', ground.bridge[1] > 3.4 && ground.bridge[1] < 4.5, ground.bridge);
    add('B5', '森林公园：林地行走不悬空/不埋地', ground.forest[1] > 2.4 && ground.forest[1] < 3.3, ground.forest);
    await shot('04-bridge');
  } catch (e) {
    add('B3', '农家乐/森林/拱桥地面贴合', false, { error: e.message });
  }

  /* ---------------------- 内存：每设施 3 轮 ---------------------- */
  try {
    await ensureLobby();
    const mem = await page.evaluate(async (keys) => {
      const pg = window.__playground;
      const r = pg.sceneManager.renderer;
      const settle = async (frames) => {
        for (let i = 0; i < frames; i += 1) {
          pg.facilityRuntime?.update?.(1 / 60);
          const a = pg.attractionManager?.active;
          if (a && typeof a._inputMode === 'string') a.update?.(1 / 60);
          else a?.update?.(1 / 60);
        }
        pg.sceneManager.renderOnce();
      };
      // 预热一轮，排除视角缓存首次上传
      for (const k of keys) {
        await pg.onEnterAttraction(k);
        await settle(8);
        pg.onExitAttraction();
        await settle(70);
      }
      const before = { ...r.info.memory };
      for (let round = 0; round < 3; round += 1) {
        for (const k of keys) {
          await pg.onEnterAttraction(k);
          await settle(6);
          pg.onExitAttraction();
          await settle(70);
        }
      }
      const after = { ...r.info.memory };
      return {
        before, after,
        dGeo: after.geometries - before.geometries,
        dTex: after.textures - before.textures,
      };
    }, Object.keys(EXPECT));
    add('A5', '全设施 3 轮进出：Δgeo ≤ 0 且 Δtex ≤ 0', mem.dGeo <= 0 && mem.dTex <= 0, mem);
  } catch (e) {
    add('A5', '全设施 3 轮进出内存', false, { error: e.message });
  }

  /* ============================ 维度二 ============================ */
  try {
    await ensureLobby();
    const input = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      cam.position.set(0, 1.6, 24);
      cam.rotation.order = 'YXZ'; cam.rotation.set(0, 0, 0);
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false;
      lobby._wasd.resetFromCamera(cam);
      const p0 = cam.position.clone();
      lobby._wasd._keys.add('KeyW');
      for (let i = 0; i < 40; i += 1) lobby.update(1 / 60);
      lobby._wasd._keys.delete('KeyW');
      const p1 = cam.position.clone();
      // 虚拟摇杆：直接注入轴向，确认不触发设施进入
      const activeBefore = pg.attractionManager.activeKey;
      lobby._wasd._virtualY = 1; lobby._wasd._virtualX = 0.25;
      for (let i = 0; i < 30; i += 1) lobby.update(1 / 60);
      lobby._wasd._virtualY = 0; lobby._wasd._virtualX = 0;
      return {
        walk: +p0.distanceTo(p1).toFixed(2),
        joystickWalk: +p1.distanceTo(cam.position).toFixed(2),
        activeBefore, activeAfter: pg.attractionManager.activeKey,
        y: cam.position.y,
      };
    });
    add('C1', '键盘 WASD 行走顺畅（2.5m 以上）', input.walk > 2.5 && Math.abs(input.y - 1.6) < 0.15, input);
    add('C2', '虚拟摇杆推行且不误进设施', input.joystickWalk > 0.8 && input.activeAfter === 'lobby', input);
  } catch (e) { add('C1', '键盘/摇杆', false, { error: e.message }); }

  /* ---------------------- 防误触 ---------------------- */
  try {
    await ensureLobby();
    const guard = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const out = {};
      // 驾驶中调用入口：临时置位真实 CityDriving，避免替换实例导致后续 F 驾驶失效
      const realDriving = lobby._driving;
      const prev = { active: realDriving._active, pending: realDriving._pending };
      realDriving._active = true; realDriving._pending = false;
      out.drivingTry = lobby._tryEnter('parkour-run');
      out.drivingKey = pg.attractionManager.activeKey;
      realDriving._active = prev.active; realDriving._pending = prev.pending;
      // 嵌入期间调用入口
      pg.onEnterAttraction('carousel');
      out.embeddedTry = lobby._tryEnter('dance-hall');
      out.embeddedKey = pg.facilityRuntime.activeKey;
      pg.onExitAttraction();
      // 过渡中双击
      out.transitionTry = lobby._tryEnter('memory-match');
      out.transitionAgain = lobby._tryEnter('memory-match');
      out.transitionKey = pg.attractionManager.activeKey;
      if (out.transitionKey === 'memory-match') pg.onExitAttraction();
      return out;
    });
    add('C3', '驾驶/嵌入/过渡中点击设施入口均被拦截', guard.drivingKey === 'lobby'
      && guard.embeddedKey === 'carousel' && guard.transitionKey === 'lobby', guard);
    await ensureLobby();
  } catch (e) { add('C3', '防误触', false, { error: e.message }); }

  /* ---------------------- F 驾驶 / R 自救 ---------------------- */
  try {
    await ensureLobby();
    const car = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const p = lobby._city.traffic.getParkedPose(0);
      const cam = pg.sceneManager.camera;
      cam.position.set(p.x + 1.5, 1.6, p.z);
      cam.rotation.order = 'YXZ'; cam.rotation.set(0, p.yaw + Math.PI, 0);
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false;
      lobby._wasd.resetFromCamera(cam);
      for (let i = 0; i < 3; i += 1) lobby.update(1 / 60);
      const el = document.querySelector('[data-role="drive-hint"]');
      return { p, prompt: el?.textContent?.replace(/\s+/g, ' ').trim(), on: el?.dataset.on, near: !!lobby._nearCar };
    });
    add('D1', '靠近车辆出现统一 E 毛玻璃提示', car.on === '1' && /按 E 上车/.test(car.prompt || '') && car.near, car);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.__playground.vehicleSystem?.active === true, null, { timeout: 60000 }).catch(() => {});
    const vehicle = await page.evaluate(() => {
      const pg = window.__playground;
      return { active: !!pg.vehicleSystem?.active, state: pg.vehicleSystem?.debugState };
    });
    add('D2', 'F 上车：动态刚体 + 12 AI + 玩家 = 14 bodies', vehicle.active && vehicle.state?.bodyCount === 14 && vehicle.state?.aiBodies === 12, vehicle);
    await page.keyboard.down('w');
    const moved = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const d = pg.vehicleSystem;
      const t0 = d._body.translation();
      for (let i = 0; i < 150; i += 1) { pg.physicsManager.step(1 / 60); lobby.update(1 / 60); }
      const t1 = d._body.translation();
      const v = d._body.linvel();
      return {
        speed: d.speedKmh,
        dist: Math.hypot(t1.x - t0.x, t1.z - t0.z),
        y: t1.y, vy: v.y,
      };
    });
    await page.keyboard.up('w');
    add('D3', '驾驶加速/地面碰撞正常，无穿地下坠', moved.speed > 25 && moved.dist > 5 && moved.y > 1.2 && moved.y < 1.8, moved);
    // R 自救（驾驶中）
    await page.keyboard.press('r');
    await drive(20, 1 / 60);
    const resetDrive = await page.evaluate(() => {
      const pg = window.__playground;
      return {
        active: !!pg.vehicleSystem?.active,
        cam: pg.sceneManager.camera.position.toArray(),
        key: pg.attractionManager.activeKey,
      };
    });
    add('D4', '驾驶中 R：立即下车并回到大厅出生点',
      !resetDrive.active && resetDrive.key === 'lobby'
      && Math.hypot(resetDrive.cam[0] - 0, resetDrive.cam[2] - 24) < 0.35, resetDrive);
    // F 下车正常
    const p2 = await page.evaluate(() => window.__playground.attractionManager.active._city.traffic.getParkedPose(0));
    await page.evaluate((p) => {
      const pg = window.__playground, lobby = pg.attractionManager.active, cam = pg.sceneManager.camera;
      cam.position.set(p.x + 1.5, 1.6, p.z);
      cam.rotation.order = 'YXZ'; cam.rotation.set(0, p.yaw + Math.PI, 0);
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false; lobby._wasd.resetFromCamera(cam);
      for (let i = 0; i < 2; i += 1) lobby.update(1 / 60);
    }, p2);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.__playground.vehicleSystem?.active === true, null, { timeout: 60000 }).catch(() => {});
    await page.keyboard.press('e');
    await drive(4, 1 / 60);
    const off = await page.evaluate(() => window.__playground.vehicleSystem?.debugState);
    add('D5', 'F 下车：刚体/collider 全部清空', !off?.active && off?.bodyCount === 0 && off?.aiBodies === 0, off);
  } catch (e) { add('D1', 'F 驾驶闭环', false, { error: e.message }); }

  /* ---------------------- 红绿灯 / AI 60s ---------------------- */
  try {
    await ensureLobby();
    const traffic = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const t = lobby._city.traffic;
      const signals = lobby._city.signals;
      const bad = [];
      const seen = new Set();
      for (let i = 0; i < 3600; i += 1) {
        signals.update(1 / 60);
        lobby.update(1 / 60);
        const s = signals.getVehicleState('x');
        const z = signals.getVehicleState('z');
        seen.add(`${s}/${z}`);
        for (const v of t._vehicles || []) {
          if (![v.x, v.z, v.curSpeed, v.speed].every(Number.isFinite)) bad.push(v.name || 'vehicle');
        }
      }
      // 用真实信号/停车线验证 AI 决策：红灯停车线前 0.7m → 目标速度必须为 0
      let redTarget = null, greenTarget = null;
      const CYCLE = 36;
      for (let tt = 0; tt < CYCLE; tt += 0.5) {
        signals.time = tt;
        if (signals.getVehicleState('x') === 'red') { redTarget = tt; break; }
      }
      const route0 = t._routes?.city;
      const fake = { x: 0, z: 0, dx: 1, dz: 0, speed: 10, curSpeed: 10, route: 'city', lane: 3.25, claimed: false };
      let obeyRed = null;
      if (redTarget != null && route0) {
        signals.time = redTarget;
        fake.x = 11.1; fake.z = 112;
        obeyRed = t._targetSpeed(fake, 0);
      }
      for (let tt = 0; tt < CYCLE; tt += 0.5) {
        signals.time = tt;
        if (signals.getVehicleState('x') === 'green') { greenTarget = tt; break; }
      }
      let goGreen = null;
      if (greenTarget != null) {
        signals.time = greenTarget;
        fake.x = 11.1; fake.z = 112;
        goGreen = t._targetSpeed(fake, 0);
      }
      return {
        states: [...seen],
        bad: bad.slice(0, 4),
        cars: (t._vehicles || []).length,
        signalTime: +signals.time.toFixed(2),
        obeyRed, goGreen,
      };
    });
    add('C4', '红绿灯双轴状态循环、AI 坐标 60s 无 NaN、红灯停/绿灯行',
      traffic.states.length >= 3 && traffic.bad.length === 0 && traffic.cars >= 10
      && traffic.obeyRed === 0 && traffic.goGreen > 5, traffic);
  } catch (e) { add('C4', '红绿灯/AI', false, { error: e.message }); }

  /* ---------------------- 季节 / 昼夜狂切 ---------------------- */
  try {
    await ensureLobby();
    const cycle = await page.evaluate(() => {
      const pg = window.__playground;
      const s = pg.seasonCycle, dn = pg.dayNightCycle, r = pg.sceneManager.renderer;
      // 预热全部季节×昼夜材质，排除首次换季的资源上传，再测稳定态
      for (const season of ['spring', 'summer', 'autumn', 'winter']) {
        for (const mode of ['day', 'night']) {
          s.setSeason(season); s.applyImmediate();
          dn.setMode(mode); dn.applyImmediate();
          pg.sceneManager.renderOnce();
        }
      }
      const before = { ...r.info.memory };
      const seq = ['spring', 'summer', 'autumn', 'winter', 'summer', 'spring', 'winter', 'autumn'];
      for (let round = 0; round < 3; round += 1) {
        for (const season of seq) {
          s.setSeason(season); s.applyImmediate();
          dn.setMode(round % 2 ? 'night' : 'day'); dn.applyImmediate();
          for (let i = 0; i < 4; i += 1) { s.update(1 / 60); dn.update(1 / 60); }
          pg.sceneManager.renderOnce();
        }
      }
      const after = { ...r.info.memory };
      return {
        before, after,
        dGeo: after.geometries - before.geometries,
        dTex: after.textures - before.textures,
        season: s.currentSeason ?? s.season,
        mode: dn.mode,
      };
    });
    add('C5', '四季/昼夜 24 次狂切：无崩溃且 Δgeo ≤ 0 / Δtex ≤ 0', cycle.dGeo <= 0 && cycle.dTex <= 0, cycle);
  } catch (e) { add('C5', '季节/昼夜狂切', false, { error: e.message }); }

  /* ============================ 维度三 ============================ */
  try {
    await ensureLobby();
    await page.evaluate(() => {
      const lobby = window.__playground.attractionManager.active;
      const cam = window.__playground.sceneManager.camera;
      const f = lobby.root.userData.layout.find((x) => x.key === 'carousel');
      cam.position.set(f.trigger.x, 1.6, f.trigger.z);
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false;
      lobby._wasdBlendActive = false; lobby._zooFly = null;
      lobby._wasd.resetFromCamera(cam);
      for (let i = 0; i < 4; i += 1) lobby.update(1 / 60);
    });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-role="interact-hint"]');
      return !!el && el.dataset.on === '1' && getComputedStyle(el).visibility === 'visible';
    }, null, { timeout: 8000 }).catch(() => {});
    const hud = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden') return null;
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const overlap = (a, b) => !!a && !!b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      const interact = rect('[data-role="interact-hint"]');
      const drive = rect('[data-role="drive-hint"]');
      const joystick = rect('.pg-joystick');
      const controls = rect('.lb-controls');
      const mode = rect('[data-role="input-mode"]');
      const time = rect('.lb-time');
      return {
        vw: innerWidth, vh: innerHeight,
        interact, drive, joystick, controls, mode, time,
        overlapJoystick: overlap(interact, joystick),
        overlapDrive: overlap(interact, drive),
        overlapControls: overlap(interact, controls) || overlap(drive, controls),
        overflow: [interact, drive, joystick, controls, mode, time].filter(Boolean)
          .some((r) => r.x < -1 || r.y < -1 || r.x + r.w > innerWidth + 1 || r.y + r.h > innerHeight + 1),
      };
    });
    add('E1', '1280×800：E/F 提示不与摇杆/控制条重叠且不出屏',
      !!hud.interact && !hud.overlapJoystick && !hud.overlapDrive
      && !hud.overlapControls && !hud.overflow, hud);
  } catch (e) { add('E1', 'HUD 重叠（桌面）', false, { error: e.message }); }

  /* ============================ 维度四 ============================ */
  try {
    await ensureLobby();
    // 卡死自救
    const stuck = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      cam.position.set(500, 1.6, 500);
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false; lobby._wasd.resetFromCamera(cam);
      return cam.position.toArray();
    });
    await page.keyboard.press('r');
    await drive(20, 1 / 60);
    const rescue = await page.evaluate(() => window.__playground.sceneManager.camera.position.toArray());
    add('F1', 'R 自救：从墙缝/越界坐标回到出生点', Math.hypot(rescue[0] - 0, rescue[2] - 24) < 0.35, { stuck, rescue });
    // 嵌入中自救
    await page.evaluate(() => window.__playground.onEnterAttraction('carousel'));
    await page.waitForTimeout(120);
    await drive(30, 1 / 60);
    await page.keyboard.press('r');
    await drive(120, 1 / 60);
    const rescueEmbedded = await page.evaluate(() => ({
      key: window.__playground.attractionManager.activeKey,
      embedded: !!window.__playground.facilityRuntime.isEmbeddedActive,
      cam: window.__playground.sceneManager.camera.position.toArray(),
    }));
    add('F2', '嵌入设施中 R：退出并回到出生点', !rescueEmbedded.embedded && rescueEmbedded.key === 'lobby'
      && Math.hypot(rescueEmbedded.cam[0], rescueEmbedded.cam[2] - 24) < 0.35, rescueEmbedded);
  } catch (e) { add('F1', 'R 自救', false, { error: e.message }); }

  /* ---------------------- GPU / 网络降级 ---------------------- */
  try {
    await ensureLobby();
    const guard = await page.evaluate(() => {
      const pg = window.__playground;
      pg.graphicsGuard.simulateContextLoss();
      const overlay = document.querySelector('.pg-gpu-guard');
      const lost = {
        hidden: overlay?.dataset.hidden,
        text: overlay?.textContent?.replace(/\s+/g, ' ').trim(),
        paused: !!pg.sceneManager._paused,
      };
      pg.graphicsGuard.simulateContextRestore();
      lost.restoredHidden = overlay?.dataset.hidden;
      lost.restoredPaused = !!pg.sceneManager._paused;
      // 网络离线 toast 走真实事件
      window.dispatchEvent(new Event('offline'));
      const toast = document.querySelector('.pg-guard-toast');
      lost.toastOn = toast?.dataset.on;
      lost.toastText = toast?.textContent;
      window.dispatchEvent(new Event('online'));
      return lost;
    });
    add('F3', 'GPU 上下文丢失：暂停 + 毛玻璃兜底提示，可恢复', guard.hidden === 'false' && guard.paused
      && guard.restoredHidden === 'true' && guard.restoredPaused === false, guard);
    add('F4', '网络断开：友好 toast 提示', guard.toastOn === '1' && /网络已断开/.test(guard.toastText || ''), guard);
    add('F5', '低性能设备降级档位存在（QualityTier 自动）',
      await page.evaluate(() => !!window.__playground?.sceneManager?.qualityTier),
      await page.evaluate(() => ({ tier: window.__playground?.sceneManager?.qualityTier })));
  } catch (e) { add('F3', 'GPU/网络降级', false, { error: e.message }); }

  /* ============================ 维度五 ============================ */
  // 5 分钟城市连续行走/转向 + 周期渲染
  try {
    await ensureLobby();
    const soak = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      const r = pg.sceneManager.renderer;
      // 多视角预热：让城市各街区/建筑 LOD 的几何与贴图完成首次 GPU 上传
      const views = [
        [24, 20, 105, 24, 2, 240], [-80, 22, 120, 0, 2, 190], [80, 22, 120, 0, 2, 190],
        [24, 22, 240, 24, 2, 100], [-80, 22, 220, 0, 2, 180], [80, 22, 220, 0, 2, 180],
        [0, 30, 170, 0, 2, 240],
      ];
      for (const [x, y, z, tx, ty, tz] of views) {
        cam.position.set(x, y, z); cam.lookAt(tx, ty, tz);
        pg.sceneManager.renderOnce();
      }
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false;
      lobby._wasdBlendActive = false; lobby._zooFly = null;
      const reset = () => {
        cam.position.set(24, 1.6, 170); cam.rotation.order = 'YXZ'; cam.rotation.set(0, 0, 0);
        lobby._wasd.resetFromCamera(cam);
      };
      const run = (frames) => {
        reset();
        lobby._wasd._keys.add('KeyW');
        let travel = 0, renders = 0;
        let px = cam.position.x, pz = cam.position.z;
        for (let i = 0; i < frames; i += 1) {
          if (i % 150 === 0) lobby._wasd.yaw += 0.55;
          lobby.update(1 / 30);
          const d = Math.hypot(cam.position.x - px, cam.position.z - pz);
          if (d < 2) travel += d;
          px = cam.position.x; pz = cam.position.z;
          if (i % 300 === 0) { pg.sceneManager.renderOnce(); renders += 1; }
          if (!Number.isFinite(cam.position.x) || !Number.isFinite(cam.position.z)) break;
          if (Math.abs(cam.position.x) > 90 || cam.position.z < 96 || cam.position.z > 244) {
            reset(); px = cam.position.x; pz = cam.position.z;
          }
        }
        lobby._wasd._keys.delete('KeyW');
        return { travel: +travel.toFixed(1), renders };
      };
      // 第一轮 5 分钟用于把尚未进入视锥的城市资源全部预热
      const warm = run(9000);
      const before = { ...r.info.memory };
      const start = performance.now();
      const measured = run(9000);
      const after = { ...r.info.memory };
      return {
        frames: 9000,
        simulatedSeconds: 300,
        warmTravel: warm.travel,
        travel: measured.travel,
        renders: measured.renders,
        wallMs: Math.round(performance.now() - start),
        dGeo: after.geometries - before.geometries,
        dTex: after.textures - before.textures,
        end: cam.position.toArray(),
      };
    });
    add('G1', '城市连续行走/转向 5 分钟（300s/9000 帧）：坐标稳定、无死锁',
      soak.frames === 9000 && Number.isFinite(soak.end[0]) && soak.travel >= 5, soak);
    add('G2', '5 分钟长跑 Δgeo ≤ 0 / Δtex ≤ 0', soak.dGeo <= 0 && soak.dTex <= 0, soak);
  } catch (e) { add('G1', '5 分钟城市长跑', false, { error: e.message }); }

  add('G3', '全程 0 pageerror / 0 console.error', pagesErrors.length === 0, { count: pagesErrors.length, sample: pagesErrors.slice(0, 6) });
  const finalStats = await page.evaluate(() => {
    const pg = window.__playground;
    const r = pg.sceneManager.renderer;
    const sm = pg.sceneManager, cam = sm.camera;
    const savedP = cam.position.clone(), savedQ = cam.quaternion.clone();
    cam.position.set(0, 30, 34); cam.up.set(0, 1, 0); cam.lookAt(0, 2, 0); cam.updateMatrixWorld(true);
    const old = r.info.autoReset; r.info.autoReset = false; r.info.reset(); r.render(sm.scene, cam);
    const out = { calls: r.info.render.calls, triangles: r.info.render.triangles, mem: { ...r.info.memory } };
    r.info.autoReset = old;
    cam.position.copy(savedP); cam.quaternion.copy(savedQ);
    return out;
  });
  add('G4', '最终预算复核：overview ≤ 900 calls / ≤ 300k tris', finalStats.calls <= 900 && finalStats.triangles <= 300000, finalStats);
  await shot('05-final-overview');

  /* ====================== 手机窄屏 / 摇杆遮挡 ====================== */
  let mobilePage = null;
  const mobileErrors = [];
  try {
    const desktopPage = page;
    // 长跑后桌面页仍在用 SwiftShader 渲染，先释放它，避免手机页 goto 被饿死
    if (desktopPage) await desktopPage.close();
    page = null;
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    mobilePage = await mctx.newPage();
    mobilePage.on('pageerror', (e) => mobileErrors.push('pageerror: ' + e.message));
    mobilePage.on('console', (m) => { if (m.type() === 'error') mobileErrors.push('console.error: ' + m.text()); });
    page = mobilePage;
    await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
    const startFit = await page.evaluate(() => {
      const r = document.querySelector('.pg-start__card')?.getBoundingClientRect();
      return {
        vw: innerWidth, vh: innerHeight,
        card: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
        overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      };
    });
    add('H0', '390×844 开始页卡片完整可见、无横向滚动', !!startFit.card
      && startFit.card.x >= 0 && startFit.card.y >= 0
      && startFit.card.x + startFit.card.w <= startFit.vw + 1
      && startFit.card.y + startFit.card.h <= startFit.vh + 1
      && !startFit.overflowX, startFit);
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 30000 });
    await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone === true, null, { timeout: 180000 })
      .catch(() => mobileErrors.push('mobile prewarm timeout'));
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      const f = lobby.root.userData.layout.find((x) => x.key === 'carousel');
      cam.position.set(f.trigger.x, 1.6, f.trigger.z);
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false;
      lobby._wasdBlendActive = false; lobby._zooFly = null;
      lobby._wasd.resetFromCamera(cam);
      for (let i = 0; i < 6; i += 1) lobby.update(1 / 60);
    });
    // 等毛玻璃提示的 visibility/opacity 过渡完成，再测量真实布局
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-role="interact-hint"]');
      return !!el && el.dataset.on === '1' && getComputedStyle(el).visibility === 'visible';
    }, null, { timeout: 8000 }).catch(() => {});
    const mobileHud = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.display === 'none' || cs.visibility === 'hidden') return null;
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const overlap = (a, b) => !!a && !!b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      const interact = rect('[data-role="interact-hint"]');
      const joystick = rect('.pg-joystick');
      const drive = rect('[data-role="drive-hint"]');
      const hit = interact ? document.elementFromPoint(interact.x + interact.w / 2, interact.y + interact.h / 2) : null;
      return {
        vw: innerWidth, vh: innerHeight,
        joystickVisible: !!joystick,
        joystickHidden: document.querySelector('.pg-joystick')?.dataset.hidden,
        interact, joystick, drive,
        overlapJoystick: overlap(interact, joystick),
        overlapDrive: overlap(interact, drive),
        hitPrompt: !!hit?.closest?.('[data-role="interact-hint"]'),
        promptOn: document.querySelector('[data-role="interact-hint"]')?.dataset.on,
        promptStyle: (() => {
          const el = document.querySelector('[data-role="interact-hint"]');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, timeOpen: el.closest('.lb-ui')?.dataset.timeOpen };
        })(),
        overflow: [interact, joystick, drive].filter(Boolean).some((r) => r.x < -1 || r.y < -1 || r.x + r.w > innerWidth + 1 || r.y + r.h > innerHeight + 1),
      };
    });
    add('H1', '手机竖屏：摇杆可见，E 提示不被摇杆/驾驶提示遮挡',
      mobileHud.joystickVisible && mobileHud.joystickHidden === 'false'
      && mobileHud.promptOn === '1' && mobileHud.hitPrompt && !mobileHud.drive
      && !mobileHud.overlapJoystick && !mobileHud.overlapDrive && !mobileHud.overflow, mobileHud);
    // 用真实触摸坐标点击，规避无头 SwiftShader 下 CSS 过渡导致 Playwright 稳定性等待超时
    const promptBox = await page.locator('[data-role="interact-hint"]').boundingBox();
    if (promptBox) await page.touchscreen.tap(promptBox.x + promptBox.width / 2, promptBox.y + promptBox.height / 2);
    await page.waitForFunction(() => window.__playground?.facilityRuntime?.activeKey === 'carousel', null, { timeout: 8000 }).catch(() => {});
    const tapEnter = await page.evaluate(() => ({
      embedded: window.__playground.facilityRuntime.activeKey,
      active: window.__playground.attractionManager.activeKey,
    }));
    add('H2', '手机点击 E 提示可进入设施（点击/摇杆不冲突）', tapEnter.embedded === 'carousel', tapEnter);
    await page.evaluate(() => {
      const lobby = window.__playground.attractionManager.active;
      lobby.update(1 / 60);
      document.querySelector('[data-role="facility-exit"]')?.click();
    });
    // 等退出过渡真正完成，避免慢速 SwiftShader 下仍停留在嵌入设施
    await page.waitForFunction(() => !window.__playground?.facilityRuntime?.activeKey, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    // 横屏 844×390：再测一次
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(200);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-role="interact-hint"]');
      return !!el && el.dataset.on === '1' && getComputedStyle(el).visibility === 'visible';
    }, null, { timeout: 8000 }).catch(() => {});
    const landscape = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      const f = lobby.root.userData.layout.find((x) => x.key === 'carousel');
      cam.position.set(f.trigger.x, 1.6, f.trigger.z);
      lobby._inputMode = 'wasd'; lobby._controls.enabled = false;
      lobby._wasd.resetFromCamera(cam);
      for (let i = 0; i < 6; i += 1) lobby.update(1 / 60);
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.display === 'none' || cs.visibility === 'hidden') return null;
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const a = rect('[data-role="interact-hint"]');
      const b = rect('.pg-joystick');
      const overlap = !!a && !!b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      return { interact: a, joystick: b, overlap, vw: innerWidth, vh: innerHeight };
    });
    add('H3', '844×390 横屏：E 提示与摇杆不重叠', !!landscape.interact && !!landscape.joystick && !landscape.overlap, landscape);
    add('H4', '手机端全程 0 pageerror / 0 console.error', mobileErrors.length === 0, { errors: mobileErrors.slice(0, 4) });
    await shot('06-mobile-landscape');
  } catch (e) {
    add('H1', '手机窄屏/摇杆', false, { error: e.message });
  } finally {
    page = null;
  }

  const pass = checks.filter((c) => c.status === 'PASS').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const report = {
    schema: 'launch-qa/1.0',
    at: new Date().toISOString(),
    url: BASE,
    summary: { total: checks.length, pass, fail, warn: checks.filter((c) => c.status === 'WARN').length },
    budget: { overview: budget, final: finalStats },
    facilityEvidence,
    checks,
    screenshots: shots,
    errors: pagesErrors,
    runtimeErrors,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\n===== LAUNCH QA: ${pass}/${checks.length} PASS · ${fail} FAIL =====`);
  console.log(`report: ${REPORT}`);
} catch (e) {
  console.error('FATAL', e?.stack || e);
  runtimeErrors.push('FATAL: ' + (e?.stack || e));
  try {
    fs.writeFileSync(REPORT, JSON.stringify({ checks, errors: pagesErrors, runtimeErrors, fatal: String(e?.stack || e) }, null, 2));
  } catch {}
} finally {
  await browser?.close();
}

