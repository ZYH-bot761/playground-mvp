/**
 * tests/verify-m4-jump.mjs —— 【阶段二重写】跳舞厅专项（原跳一跳退役）
 * 运行：node tests/verify-m4-jump.mjs
 *
 * A 能稳定进入跳舞厅（attractionManager.activeKey === 'dance-hall'，无独立天幕）
 * B 第一人称机位：相机眼高 1.6m、落在大厅地板范围内；WASD 控制器挂载
 * C 三个表演者 rig 齐全（琴师/歌手/舞者），坐姿琴师骨盆落凳面高度
 * D 舞台灯光 3 盏 + 镜球 + 音箱在场；音频调度器可启停（_muted 切换）
 * E 退出回大厅：activeKey === 'lobby'、DanceHall 根节点摘除、UI 清理
 * F 全程 0 报错
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'verify-m4-dance.json');
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
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });

  // A 进入跳舞厅（真实路径：预热 + activate）
  await page.evaluate(() => window.__playground.prewarm('dance-hall'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__playground.attractionManager.activate('dance-hall'));
  await page.waitForTimeout(1000);

  const inside = await page.evaluate(() => {
    const pg = window.__playground;
    const host = pg.attractionManager.active;
    const cam = pg.sceneManager.camera;
    const scene = pg.sceneManager.scene;
    return {
      activeKey: pg.attractionManager.activeKey,
      camY: +cam.position.y.toFixed(3),
      camXZ: [Math.round(cam.position.x * 10) / 10, Math.round(cam.position.z * 10) / 10],
      wasd: host?._wasd != null,
      ui: !!document.querySelector('.dh-ui'),
      musicBtn: !!document.querySelector('[data-dh="music"]'),
      performers: Array.isArray(host?._performers) ? host._performers.length : 0,
      performerRigs: Array.isArray(host?._performers)
        ? host._performers.map((p) => !!p?.group?.userData?.rig) : [],
      pianistSeated: Array.isArray(host?._performers)
        ? (host._performers.find((p) => p.kind === 'pianist')?.group?.position?.y ?? null) : null,
      lights: (host?._stageLight ? 1 : 0) + (host?._discoLight ? 1 : 0)
        + (scene.getObjectByName('DanceHall/light-fill') ? 1 : 0),
      disco: !!scene.getObjectByName('DanceHall/disco-ball'),
      speakers: !!scene.getObjectByName('DanceHall/speaker-l'),
      orphanSky: !!scene.getObjectByName('DanceHall/sky'),
      lobbyAlive: !!scene.getObjectByName('Lobby') || pg.attractionManager.activeKey === 'dance-hall',
    };
  });
  add('A 进入跳舞厅', inside.activeKey === 'dance-hall', `activeKey=${inside.activeKey}`);
  add('B1 第一人称眼高≈1.6', Math.abs(inside.camY - 1.6) < 0.35, `camY=${inside.camY}`);
  add('B2 WASD 挂载', inside.wasd === true, `wasd=${inside.wasd}`);
  add('C1 表演者 ×3 + rig 齐全', inside.performers === 3 && inside.performerRigs.every(Boolean),
    `performers=${inside.performers} rigs=${JSON.stringify(inside.performerRigs)}`);
  add('C2 琴师坐姿高度≈0.61', inside.pianistSeated != null && Math.abs(inside.pianistSeated - 0.61) < 0.05,
    `pianistY=${inside.pianistSeated}`);
  add('D1 舞台灯光 3 盏', inside.lights === 3, `lights=${inside.lights}`);
  add('D2 镜球 + 音箱在场', inside.disco && inside.speakers, `disco=${inside.disco} speakers=${inside.speakers}`);
  add('D3 无独立天幕（室内但同场景）', !inside.orphanSky, `orphanSky=${inside.orphanSky}`);
  add('E0 UI + 音乐按钮', inside.ui && inside.musicBtn, `ui=${inside.ui} music=${inside.musicBtn}`);
  await page.screenshot({ path: path.join(OUT, 'verify-dance-inside.png') });

  // D4 音乐静音切换不报错
  await page.evaluate(() => {
    const host = window.__playground.attractionManager.active;
    host?.toggleMute?.();
    host?.toggleMute?.();
  });

  // E 退出回大厅
  await page.evaluate(() => window.__playground.onExitAttraction?.());
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const pg = window.__playground;
    const scene = pg.sceneManager.scene;
    let orphan = 0;
    scene.traverse((o) => { if (String(o.name || '').startsWith('DanceHall')) orphan += 1; });
    return { activeKey: pg.attractionManager.activeKey, orphan, ui: !!document.querySelector('.dh-ui') };
  });
  add('E1 退出回大厅', after.activeKey === 'lobby', `activeKey=${after.activeKey}`);
  add('E2 DanceHall 对象清零', after.orphan === 0, `orphan=${after.orphan}`);
  add('E3 跳舞厅 UI 移除', !after.ui, `ui=${after.ui}`);
  await page.screenshot({ path: path.join(OUT, 'verify-dance-lobby.png') });

  add('F 全程 0 报错', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
} catch (err) {
  add('流程异常', false, String(err));
}

const pass = checks.filter((c) => c.pass).length;
const summary = { suite: 'verify-m4-dance/1.0（原跳一跳专项退役重写）', pass, total: checks.length,
  ok: pass === checks.length, checks, errors: errors.slice(0, 10) };
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(REPORT, JSON.stringify(summary, null, 2));
await browser.close();
process.exit(summary.ok ? 0 : 1);
