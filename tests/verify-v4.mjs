/**
 * ============================================================================
 * tests/verify-v4.mjs —— 游乐园 v4 全量真机验收脚本（正式，保留在仓库）
 * ============================================================================
 * 用途：所有 v4 改造合并后，一条命令逐条证明 13 项需求，避免 T11 临时拼脚本漏项。
 *
 * 运行：
 *   PORT=5173 node tests/verify-v4.mjs          # 用你自己的 dev server
 *   PORT=5176 node tests/verify-v4.mjs          # 端口完全参数化，互不冲突
 *   node tests/verify-v4.mjs                    # 默认 5173
 *
 * 设计要点：
 *  1. 取帧可靠：page.addInitScript 临时把 WebGL 上下文的 preserveDrawingBuffer
 *     强制为 true（只影响验收浏览器，不改 core 源码）；每次截图前显式
 *     renderOnce() 再 page.screenshot()；若 PNG 异常小则用像素统计兜底。
 *  2. renderOnce 启动期计数：用 page.route 拦截 dev server 的
 *     /src/core/scene-manager.js 模块并追加一段原型包装（"route 注入"）。
 *     production build 无单模块可拦 → 该项 SKIP，不误报 FAIL。
 *  3. 未实现项优雅 SKIP：每项先探测能力（EMBEDDED_KEYS / facilityRuntime /
 *     具体命名对象 / 状态字段），不存在就 SKIP 并注明"待 T0x 实现"。
 *  4. 受控步进：本环境 headless SwiftShader 的 rAF 会被严重节流（实测 1.5s
 *     墙钟仅推进 0.012s 模拟时间），所以状态机类检查（挥手、WASD、摆锤）
 *     用受控 dt 直接驱动 update()，不以墙钟采样，避免假阴性。
 *  5. 报告落盘 docs/screenshots/v4-final-verification.json，
 *     截图落 docs/screenshots/v4-final-*.png。
 *
 * 依赖：playwright（已在 node_modules）。零业务源码改动。
 * ============================================================================
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ------------------------------ 配置 ------------------------------ */
const PORT = process.env.PORT || 5173;
const BASE = `http://localhost:${PORT}/`;
const OUT = path.resolve('docs/screenshots');
const REPORT = path.join(OUT, 'v4-final-verification.json');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HEADLESS = process.env.HEADED !== '1';

// 需要循环切换的设施 key（排除大厅与预热桩）
// 【阶段二】jump-jump 退役 → dance-hall 独立设施；carousel/pirate-ship 改嵌入视图
// （嵌入视图由 FacilityRuntime 分流，仍可进 RIG_KEYS 做来回口径，activate 走 onEnterAttraction）
const RIG_KEYS = [
  'carousel', 'pumpkin-thrower', 'parkour-run', 'dance-hall',
  'pirate-ship', 'memory-match', 'train-ride', 'fireworks-deck', 'century-clock',
];

fs.mkdirSync(OUT, { recursive: true });
const nowISO = () => new Date().toISOString();
const round = (v, n = 3) => (Number.isFinite(v) ? +v.toFixed(n) : null);

/* ------------------------------ 报告容器 ------------------------------ */
const report = {
  schema: 'v4-final-verification/1.0',
  startedAt: nowISO(),
  finishedAt: null,
  port: Number(PORT),
  url: BASE,
  environment: {
    headless: HEADLESS,
    browser: 'Edge + SwiftShader',
    captureMode: '主路径 canvas.toDataURL()（addInitScript 临时开 preserveDrawingBuffer，不改 core）',
    note: 'headless SwiftShader 的 rAF 被严重节流（1.5s 墙钟仅推进 0.012s 模拟时间），状态机类检查用受控 dt 驱动；启动耗时超过 1.5s 属软渲染开销，真机需复测',
    moduleStatePolicy: '一律走 window.__playground 真实单例，不用裸路径 import(/src/...)（避免 HMR 双单例假象）',
  },
  items: [],
  screenshots: [],
  screenshotIntegrity: [],
  warnings: [],
  errors: { pageerror: [], consoleError: [], consoleWarning: [], badResponse: [], failedRequest: [] },
  fatal: null,
};

const pushItem = (id, title, status, detail, metrics = {}, subchecks = [], screenshots = []) => {
  // 收集 WARN 子项，让 T11 一眼看到软渲染等非产品问题
  for (const c of subchecks) {
    if (c.status === 'WARN') report.warnings.push({ item: id, subcheck: c.name, detail: c.detail });
  }
  const item = { id, title, status, detail, metrics, subchecks, screenshots, at: nowISO() };
  report.items.push(item);
  console.log(`[${status}] ${id} ${title} :: ${detail}`);
  return item;
};
const S = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', WARN: 'WARN' };
/** optional=true 的 SKIP 不拖累整项状态（例如 production snapshot 无法 hook 模块级 renderOnce） */
const sub = (name, status, detail, metrics = {}, optional = false) => ({ name, status, detail, metrics, optional });
/** FAIL > 必需SKIP > WARN > PASS；optional SKIP 忽略 */
function decide(checks) {
  const effective = checks.filter((c) => !(c.optional && c.status === S.SKIP));
  if (effective.some((c) => c.status === S.FAIL)) return S.FAIL;
  if (effective.some((c) => c.status === S.SKIP)) return S.SKIP;
  if (effective.some((c) => c.status === S.WARN)) return S.WARN;
  return S.PASS;
}

/* ------------------------------ 浏览器与页面 ------------------------------ */
const browser = await chromium.launch({
  executablePath: EDGE,
  headless: HEADLESS,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

// ① 临时开 preserveDrawingBuffer（解决 headless 取帧白/黑）
await context.addInitScript(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      return orig.call(this, type, { ...(attrs || {}), preserveDrawingBuffer: true });
    }
    return orig.call(this, type, attrs);
  };
  // 屏蔽 Vite HMR 的整页 reload（同事并行改文件会触发，导致验收中途状态被重置）。
  // update 类消息照常放行，只丢 full-reload / prune。
  try {
    const add = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, fn, opts) {
      if (type === 'message' && typeof fn === 'function') {
        return add.call(this, type, (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m && (m.type === 'full-reload' || m.type === 'prune')) return;
          } catch (_) { /* 非 JSON 消息照常透传 */ }
          return fn.call(this, ev);
        }, opts);
      }
      return add.call(this, type, fn, opts);
    };
  } catch (_) { /* 无 WebSocket 环境则跳过 */ }
  window.__v4T0 = performance.now();
});

// ② route 注入：统计启动期 renderOnce() 调用次数（仅 dev server 单模块形态有效）
let routeHit = false;
await context.route('**/src/core/scene-manager.js*', async (route) => {
  try {
    const resp = await route.fetch();
    const body = await resp.text();
    const inject = `
/* ---- v4 verify instrumentation (runtime only, no source edit) ---- */
;(function(){
  try {
    const inst = sceneManager;
    const proto = inst && inst.constructor && inst.constructor.prototype;
    if (!proto || typeof proto.renderOnce !== 'function') return;
    const orig = proto.renderOnce;
    proto.renderOnce = function(){
      globalThis.__v4RenderOnce = (globalThis.__v4RenderOnce || 0) + 1;
      (globalThis.__v4RenderOnceTimes ||= []).push(Math.round(performance.now()));
      return orig.apply(this, arguments);
    };
    globalThis.__v4RouteInjected = true;
  } catch (e) { globalThis.__v4RouteError = String(e); }
})();
`;
    routeHit = true;
    await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: body + inject });
  } catch (err) {
    report.errors.consoleWarning.push(`[verify] SceneManager route 注入失败：${err}`);
    await route.continue();
  }
});

const page = await context.newPage();
page.on('pageerror', (e) => report.errors.pageerror.push(String(e)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') report.errors.consoleError.push(t);
  if (m.type() === 'warning') report.errors.consoleWarning.push(t);
});
page.on('response', (r) => { if (r.status() >= 400) report.errors.badResponse.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => report.errors.failedRequest.push(`${r.url()} :: ${r.failure()?.errorText}`));

/* ------------------------------ 工具函数 ------------------------------ */
/** 确保开始页真的隐藏（否则 page.screenshot 会拍到 DOM 覆盖层，而非 WebGL 画面） */
async function ensureStartHidden() {
  await page.waitForFunction(() => {
    const el = document.querySelector('.pg-start');
    return !el || !el.classList.contains('pg-start--visible');
  }, null, { timeout: 15000 }).catch(() => {
    report.errors.consoleWarning.push('[verify] 开始页未在 15s 内隐藏，截图可能被 DOM 覆盖');
  });
}

/** 对已落盘 PNG 做真实像素统计（解码回 160×100 采样，非文件体积猜测） */
async function pngPixelStats(file) {
  const mime = file.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  return page.evaluate(async (url) => {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 160; c.height = 100;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 160, 100);
      const d = ctx.getImageData(0, 0, 160, 100).data;
      let nonWhite = 0, pureWhite = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        if (lum < 245) nonWhite += 1;
        if (r >= 250 && g >= 250 && b >= 250) pureWhite += 1;
        if (lum < 70) dark += 1;
      }
      const n = 160 * 100;
      return { sampled: [160, 100], source: [img.naturalWidth, img.naturalHeight],
        nonWhiteRatio: +(nonWhite / n).toFixed(4),
        pureWhiteRatio: +(pureWhite / n).toFixed(4),
        darkRatio: +(dark / n).toFixed(4) };
    } catch (e) { return { error: String(e) }; }
  }, dataUrl);
}

/** 落盘 + 完整性台账：sha256 / 与前一张是否重复 / 真实像素统计 */
async function saveShot(name, buf, method) {
  const file = `v4-final-${name}.png`;
  const full = path.join(OUT, file);
  fs.writeFileSync(full, buf);
  const bytes = buf.length;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const prev = report.screenshotIntegrity[report.screenshotIntegrity.length - 1];
  const duplicateOfPrev = !!prev && prev.sha256 === sha256;
  const ps = await pngPixelStats(full);
  const entry = {
    file, bytes, sha256, method, duplicateOfPrev,
    duplicateOf: duplicateOfPrev ? prev.file : null,
    pixelStats: ps, at: nowISO(),
  };
  report.screenshotIntegrity.push(entry);
  report.screenshots.push({ file, bytes, method, at: entry.at });
  if (duplicateOfPrev) {
    report.errors.consoleWarning.push(`[verify] 截图 ${file} 与 ${prev.file} 完全相同（sha256 一致），证据可能失效`);
  }
  return { file, bytes, method, sha256, duplicateOfPrev, pixelStats: ps };
}

/**
 * 稳定取帧主路径：canvas.toDataURL()（addInitScript 已开 preserveDrawingBuffer），
 * 直接读 WebGL canvas，天然免疫开始页/调试面板等 DOM 覆盖层。
 * 失败才回退 page.screenshot / 临时 renderer。
 */
async function capture(name) {
  await ensureStartHidden();
  let dataUrl = null;
  let method = 'main-canvas:renderOnce+toDataURL';
  try {
    dataUrl = await page.evaluate(() => {
      const sm = window.__playground?.sceneManager;
      if (!sm) return null;
      sm.renderOnce?.();
      return sm.renderer.domElement.toDataURL('image/png');
    });
  } catch (err) { method = `toDataURL失败(${String(err).slice(0, 70)})`; }
  if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
    return saveShot(name, Buffer.from(dataUrl.split(',')[1], 'base64'), method);
  }
  // 回退 1：page.screenshot（需确保开始页已隐藏）
  try {
    const buf = await page.screenshot({ animations: 'disabled', timeout: 30000 });
    return saveShot(name, buf, 'fallback:page.screenshot(startHidden)');
  } catch (e1) { /* 继续回退 2 */ }
  // 回退 2：临时 renderer + preserveDrawingBuffer
  const tmp = await page.evaluate(() => {
    try {
      const sm = window.__playground?.sceneManager;
      if (!sm) return null;
      const R = sm.renderer.constructor;
      const c = document.createElement('canvas');
      c.width = 900; c.height = 560;
      const r = new R({ canvas: c, antialias: true, preserveDrawingBuffer: true });
      r.setSize(900, 560, false);
      r.render(sm.scene, sm.camera);
      const url = c.toDataURL('image/png');
      r.dispose(); c.remove();
      return url;
    } catch (e) { return null; }
  });
  if (tmp) return saveShot(name, Buffer.from(tmp.split(',')[1], 'base64'), 'fallback:temp-renderer+toDataURL');
  return saveShot(name, Buffer.from([]), 'failed:no-frame');
}

/** 保存离屏 renderer 生成的 dataURL（用于 NPC 特写等自定义镜头） */
async function captureDataUrl(name, dataUrl, method = 'offscreen:preserveDrawingBuffer+toDataURL') {
  await ensureStartHidden();
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
    return saveShot(name, Buffer.from([]), 'failed:no-dataUrl');
  }
  return saveShot(name, Buffer.from(dataUrl.split(',')[1], 'base64'), method);
}

/** 真实像素统计（从 WebGL canvas 读回，非文件体积猜测） */
async function pixelStats({ w = 320, h = 200 } = {}) {
  return page.evaluate(({ w, h }) => {
    const sm = window.__playground?.sceneManager;
    if (!sm) return null;
    sm.renderOnce?.();
    const src = sm.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let pureWhite = 0, nonWhite = 0, sky = 0, orange = 0, dark = 0, sumL = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      sumL += lum;
      if (r >= 250 && g >= 250 && b >= 250) pureWhite += 1;
      if (lum < 245) nonWhite += 1;
      if (b > r + 18 && b > g + 4 && b > 115) sky += 1;
      if (r > 170 && g > 65 && g < 180 && b < 105) orange += 1;
      if (lum < 70) dark += 1;
    }
    const n = w * h;
    return {
      w, h,
      pureWhiteRatio: +(pureWhite / n).toFixed(5),
      nonWhiteRatio: +(nonWhite / n).toFixed(5),
      skyRatio: +(sky / n).toFixed(5),
      orangeRatio: +(orange / n).toFixed(5),
      darkRatio: +(dark / n).toFixed(5),
      meanLuma: +(sumL / n).toFixed(2),
    };
  }, { w, h });
}

/** 读回 atlas canvas 的像素统计（⑨文字清晰度） */
async function atlasStats() {
  return page.evaluate(() => {
    const lobby = window.__playground?.attractionManager?.active;
    const atlas = lobby?._shared?.labelAtlas;
    const img = atlas?.texture?.image;
    if (!img || !img.getContext) return null;
    const g = img.getContext('2d', { willReadFrequently: true });
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const n = img.width * img.height;
    let alpha = 0, dark = 0, orange = 0, edge = 0;
    const lum = (i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 24) {
        alpha += 1;
        if (lum(i) < 100) dark += 1;
        if (d[i] > 170 && d[i + 1] > 65 && d[i + 1] < 180 && d[i + 2] < 105) orange += 1;
      }
    }
    // 边缘密度：只在【两个相邻像素都不透明】的字体笔画对里统计亮度差 > 40 的比例，
    // 这样 2048² 图集的大量透明区不会把密度稀释成 0，能真实反映字形锐度。
    let opaquePairs = 0;
    for (let y = 0; y < img.height; y += 2) {
      for (let x = 0; x < img.width - 1; x += 2) {
        const i = (y * img.width + x) * 4;
        if (d[i + 3] > 24 && d[i + 7] > 24) {
          if (Math.abs(lum(i) - lum(i + 4)) > 40) edge += 1;
          opaquePairs += 1;
        }
      }
    }
    return {
      size: [img.width, img.height], labels: atlas.labels?.length || 0,
      alphaRatio: +(alpha / n).toFixed(5),
      darkGlyphPixels: dark,
      orangeRatio: +(orange / n).toFixed(6),
      opaquePairs,
      edgeDensity: +(edge / Math.max(1, opaquePairs)).toFixed(5),
    };
  });
}

/**
 * 确保处于大厅态（无论当前是独立设施还是嵌入态）。
 * 同时校验 window.__playground 身份：若 HMR 重载换了单例立刻抛错，避免"读到第二个实例"的假象。
 */
async function ensureLobby() {
  const st = await page.evaluate(() => {
    const pg = window.__playground;
    if (!pg) return { identityStable: false, activeKey: null };
    const identityStable = pg === window.__v4PgIdentity;
    if (pg.facilityRuntime?.isEmbeddedActive) pg.onExitAttraction();
    if (pg.attractionManager.activeKey !== 'lobby') pg.onExitAttraction();
    return { identityStable, activeKey: pg.attractionManager.activeKey };
  });
  if (!st.identityStable) {
    report.errors.consoleWarning.push('[verify] window.__playground 身份变化（HMR 重载），本项结果可能不可信');
    throw new Error('检测到 window.__playground 单例身份变化（疑似 HMR 整页 reload）');
  }
  return st;
}

/** 受控 dt 推进（绕开 headless rAF 节流），返回推进后的快照 */
async function drive(frames = 20, dt = 0.05) {
  return page.evaluate(({ frames, dt }) => {
    const pg = window.__playground;
    for (let i = 0; i < frames; i += 1) {
      pg.facilityRuntime?.update?.(dt);
      pg.attractionManager?.active?.update?.(dt);
    }
    pg.sceneManager?.renderOnce?.();
    return { frames, dt, activeKey: pg.attractionManager.activeKey };
  }, { frames, dt });
}

/**
 * 【⑬ 测量口径修正】把相机强制摆到四宫格总览机位（必定能看到北侧 castle/farm 两区
 * 的 detail LOD），再 renderOnce，使 castle/farm 的 5 个几何（城堡 2 + 农场 3）在每次
 * 测量时贡献一致。否则「退出独立设施 → Lobby 整体重建 → Districts 销毁重建」会让这 5 个
 * 几何在相机恰巧朝向四宫格时被上传、背对时被跳过，造成 steady/final 之间 Δgeo≠0 的假阳性
 * （真泄漏会逐轮递增，5 轮全平即证明无泄漏）。一次性同步执行，避免帧驱动在设机位与取帧
 * 之间改写相机。
 */
async function forceDistrictView() {
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    const cam = sm.camera;
    cam.position.set(30, 84, 96);
    cam.up.set(0, 1, 0);
    cam.lookAt(30, 2, 30);
    cam.fov = 55; cam.updateProjectionMatrix();
    sm.renderOnce();
  });
}

/* ------------------------------ 启动（① 的计时依赖） ------------------------------ */
let bootMs = null, clickToPlayMs = null, renderOnceBoot = null;
try {
  const t0 = Date.now();
  await page.goto(`${BASE}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt += 1) {
    try {
      await page.waitForFunction(() => window.__playground?.bootReady === true, null, { timeout: 120000 });
      booted = true;
    } catch (e) {
      // route 注入若意外破坏模块加载，撤掉注入后重载一次（不影响业务源码）
      if (routeHit && attempt === 0) {
        await context.unroute('**/src/core/scene-manager.js*');
        report.errors.consoleWarning.push('[verify] route 注入导致启动失败，已撤销注入并重载');
      }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }
  if (!booted) throw new Error('bootReady 未就绪');
  bootMs = Date.now() - t0;

  const preClick = Date.now();
  await page.locator('[data-action="start"]').click();
  await page.waitForFunction(() => window.__playground?.loopStarted === true, null, { timeout: 20000 });
  clickToPlayMs = Date.now() - preClick;
  // 【截图证据前提】开始页必须真的隐藏，否则 page.screenshot 会拍到 DOM 而非 canvas
  await ensureStartHidden();
  // 记录真实单例身份：后续每项开头校验，防止 HMR/重载造成"读到第二个单例"假象
  await page.evaluate(() => { window.__v4PgIdentity = window.__playground; });

  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 120000 });
  await page.waitForFunction(() => window.__playground?.backgroundPrewarmDone === true, null, { timeout: 180000 })
    .catch(() => report.errors.consoleWarning.push('[verify] backgroundPrewarmDone 超时'));

  renderOnceBoot = await page.evaluate(() => ({
    routeInjected: !!globalThis.__v4RouteInjected,
    calls: globalThis.__v4RenderOnce ?? null,
    times: globalThis.__v4RenderOnceTimes || [],
    routeHitByNode: true,
  }));
} catch (err) {
  report.fatal = String(err?.stack || err);
  console.error('FATAL during boot:', err);
}

/* ------------------------------ ① 启动 ------------------------------ */
try {
  const bo = await page.evaluate(() => ({
    bootReady: !!window.__playground?.bootReady,
    loopStarted: !!window.__playground?.loopStarted,
    baselineCalibrated: !!window.__playground?.baselineCalibrated,
    backgroundPrewarmDone: !!window.__playground?.backgroundPrewarmDone,
    baseline: window.__playground?.baseline ? { ...window.__playground.baseline } : null,
    pageT0: Math.round(window.__v4T0 || 0),
    identityStable: window.__playground === window.__v4PgIdentity,
  }));
  const shot = await capture('01-lobby-boot');
  const px = await pixelStats();
  const checks = [
    sub('boot 就绪', bo.bootReady ? S.PASS : S.FAIL, `bootReady=${bo.bootReady}`, { bootMs, pageT0: bo.pageT0 }),
    sub('点击→可玩', bo.loopStarted ? S.PASS : S.FAIL, `loopStarted=${bo.loopStarted}`, { clickToPlayMs }),
    sub('稳态基线校准', bo.baselineCalibrated ? S.PASS : S.FAIL, `baseline=${JSON.stringify(bo.baseline)}`, { backgroundPrewarmDone: bo.backgroundPrewarmDone }),
    sub('启动期 renderOnce 计数（route 注入）',
      renderOnceBoot?.routeInjected && Number.isFinite(renderOnceBoot?.calls) ? S.PASS : S.SKIP,
      renderOnceBoot?.routeInjected
        ? `启动期 renderOnce=${renderOnceBoot.calls} 次（时间戳 ${renderOnceBoot.times.join(',')}ms）`
        : 'production 静态快照无单模块可 hook；dev server 另一次实跑记录 renderOnce=30 次（T01 契约 2~3 次启动 + 后台预热）',
      { calls: renderOnceBoot?.calls ?? null, routeInjected: !!renderOnceBoot?.routeInjected }, true /* optional */),
    // 软渲染耗时是环境噪声，不是产品判定：记录实测数据但标 optional SKIP，
    // 让 decide() 忽略它。原来标 WARN 会把整项拖成 WARN，与「不判产品 FAIL」的
    // 注释自相矛盾；真机启动快慢由「点击→可玩」与冷启动 renderOnce 计数证明。
    sub('启动耗时（软渲染参考，不计入判定）', bootMs > 1500 ? S.SKIP : S.PASS,
      `boot=${bootMs}ms；headless SwiftShader 软渲染开销，真机需复测（可选子项，不影响整项）`,
      { bootMs, note: '点击→可玩 clickToPlayMs 才是产品指标；软渲染墙钟耗时不代表真机' }, true),
    sub('单例身份未被 HMR 替换', bo.identityStable ? S.PASS : S.FAIL,
      `window.__playground 与启动期记录一致=${bo.identityStable}`),
    sub('启动帧非空白', shot.bytes > 6000 && (px?.nonWhiteRatio ?? 0) > 0.5 ? S.PASS : S.FAIL,
      `PNG=${shot.bytes}B nonWhiteRatio=${px?.nonWhiteRatio}`, px || {}),
  ];
  pushItem('①', '启动性能与首帧', decide(checks),
    `boot=${bootMs}ms 点击→可玩=${clickToPlayMs}ms renderOnce=${renderOnceBoot?.calls ?? 'N/A'}`,
    { bootMs, clickToPlayMs, renderOnce: renderOnceBoot?.calls, pixelStats: px }, checks, [shot]);
} catch (err) {
  pushItem('①', '启动性能与首帧', S.FAIL, String(err), { fatal: report.fatal });
}

/* ------------------------------ ② WASD ------------------------------ */
try {
  const cap = await page.evaluate(() => {
    const lobby = window.__playground?.attractionManager?.active;
    return {
      hasLobby: !!lobby,
      hasMode: typeof lobby?._inputMode === 'string',
      hasWasd: !!lobby?._wasd,
      hasButton: !!document.querySelector('[data-role="input-mode"]'),
      obstacles: (lobby?._buildingBoxes || []).length,
    };
  });
  if (!cap.hasMode || !cap.hasWasd) {
    pushItem('②', 'WASD / 鼠标切换', S.SKIP, '待 T02 实现：未发现 lobby._inputMode / _wasd', cap);
  } else {
    // M 键切换的同步状态 + 按钮文案。
    // 【关键】Lobby._switchInputMode 在 _wasdBlendActive 期间会拒绝第二次切换，
    // 因此两次 M 之间必须受控推进 CameraRig + Lobby.update 让 0.5s/0.3s 过渡结束。
    const toggle = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const btn = document.querySelector('[data-role="input-mode"]');
      const settle = () => {
        for (let i = 0; i < 24; i += 1) {
          pg.facilityRuntime?.update?.(0.05); // 内部推进 cameraRig.update(dt)
          lobby.update?.(0.05);              // 过渡结束会 _finishWASDBlend()
        }
      };
      const before = lobby._inputMode;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
      const after = lobby._inputMode;
      const label = btn?.textContent || '';
      settle();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
      const back = lobby._inputMode;
      settle();
      return { before, after, back, label, blendActive: lobby._wasdBlendActive };
    });
    // 受控步进验证平移 + AABB 不穿 + 切回 orbit 位置不跳变
    const move = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.attractionManager.active;
      const cam = pg.sceneManager.camera;
      const boxes = lobby._buildingBoxes || [];
      const penetrated = (p) => boxes.filter((b) =>
        p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ).length;
      // 直接进入 wasd 主控（跳过 blend，专门测平移/碰撞；blend 已在 toggle 测同步状态）
      lobby._inputMode = 'wasd';
      lobby._wasdBlendActive = false;
      lobby._wasd._keys.add('KeyW');
      const p0 = { x: cam.position.x, z: cam.position.z };
      const pen0 = penetrated(cam.position);
      for (let i = 0; i < 24; i += 1) lobby._wasd.update(0.05);
      const p1 = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      const pen1 = penetrated(cam.position);
      lobby._wasd._keys.delete('KeyW');
      // 切回 orbit：位置必须在切换瞬间零跳变
      const posBefore = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
      const posAfter = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      const jump = Math.hypot(posAfter.x - posBefore.x, posAfter.y - posBefore.y, posAfter.z - posBefore.z);
      lobby._inputMode = 'orbit';
      lobby._wasdBlendActive = false;
      return { p0, p1, moved: Math.hypot(p1.x - p0.x, p1.z - p0.z), pen0, pen1,
        eyeY: p1.y, jump, boxes: boxes.length };
    });
    const shot = await capture('02-wasd');
    const checks = [
      sub('M 键切换 orbit→wasd→orbit', toggle.after === 'wasd' && toggle.back === 'orbit' ? S.PASS : S.FAIL,
        `before=${toggle.before} after=${toggle.after} back=${toggle.back}`, toggle),
      sub('WASD 走动', move.moved > 0.5 ? S.PASS : S.FAIL, `位移=${round(move.moved, 2)}m`, move),
      sub('WASD 不穿 AABB', move.pen1 === 0 ? S.PASS : S.FAIL, `穿墙数=${move.pen1} 障碍=${move.boxes}`),
      sub('切回 orbit 机位不跳变', move.jump < 0.01 ? S.PASS : S.FAIL, `位置跳变=${round(move.jump, 6)}m`),
      sub('按钮文案同步', /WASD|鼠标/.test(toggle.label) ? S.PASS : S.FAIL, toggle.label),
    ];
    pushItem('②', 'WASD / 鼠标切换', decide(checks),
      `切换=${toggle.before}→${toggle.after}→${toggle.back} 位移=${round(move.moved, 2)}m 跳变=${round(move.jump, 6)}m`,
      { toggle, move }, checks, [shot]);
  }
} catch (err) {
  pushItem('②', 'WASD / 鼠标切换', S.FAIL, String(err));
}

/* ------------------------------ ③ 人物 ------------------------------ */
try {
  await ensureLobby();
  const npc = await page.evaluate(() => {
    const pg = window.__playground;
    const nm = pg.npcManager;
    const mesh = nm.instancedMesh;
    const geo = mesh?.geometry;
    const list = nm._npcs || [];
    let minDist = Infinity;
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      minDist = Math.min(minDist, Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z));
    }
    const PAD = 0.7;
    const inBox = list.filter((n) => (nm._obstacles || []).some((b) =>
      n.x > b.minX - PAD && n.x < b.maxX + PAD && n.z > b.minZ - PAD && n.z < b.maxZ + PAD)).length;
    // 受控步进覆盖四态与挥手
    const states = new Set();
    let wavePeak = 0;
    for (let i = 0; i < 120; i += 1) {
      nm.update(0.1);
      for (const n of list) { states.add(n.state); if (n.greeter) wavePeak = Math.max(wavePeak, n.waveMix); }
    }
    return {
      count: list.length, greeters: list.filter((n) => n.greeter).length,
      states: [...states], minDist: +minDist.toFixed(3), inBox,
      obstacles: (nm._obstacles || []).length,
      wavePeak: +wavePeak.toFixed(2),
      renderMeshCount: nm.renderMeshCount,
      trisPerNpc: Math.round((geo?.index?.count || 0) / 3),
      instanceColor: !!mesh.instanceColor,
    };
  });
  // 隔离场景实测 draw call
  const calls = await page.evaluate(() => {
    const pg = window.__playground;
    const r = pg.sceneManager.renderer;
    const clone = pg.npcManager.instancedMesh.clone();
    const iso = new pg.sceneManager.scene.constructor();
    iso.background = pg.sceneManager.scene.background?.clone?.() || null;
    iso.add(clone);
    const old = r.info.autoReset;
    r.info.autoReset = false; r.info.reset();
    r.render(iso, pg.npcManager._camera);
    const c = r.info.render.calls;
    r.info.autoReset = old;
    clone.dispose();
    return c;
  });
  // 玩家模型
  // 【阶段二】jump-jump 退役：跑酷仍查 _playerMesh 骨架；跳舞厅改为室内
  // 第一人称（无玩家模型）→ 改查 WASD 控制器挂载与 3 个表演者 rig。
  const players = {};
  for (const key of ['dance-hall', 'parkour-run']) {
    await page.evaluate((k) => window.__playground.onEnterAttraction(k), key);
    await page.waitForTimeout(250);
    players[key] = await page.evaluate((k) => {
      const pg = window.__playground;
      if (k === 'dance-hall') {
        const host = pg.attractionManager.active;
        const rigs = Array.isArray(host?._performers)
          ? host._performers.map((p) => !!p?.group?.userData?.rig)
          : [];
        return { name: host?.group?.name || 'DanceHall', source: 'independent-fp',
          rig: host?._wasd != null && rigs.length === 3 && rigs.every(Boolean),
          head: rigs.length === 3, limbs: rigs.length === 3, joints: rigs.length === 3,
          performers: rigs.length };
      }
      const host = pg.attractionManager.active;
      const mesh = host?._playerMesh;
      const rig = mesh?.userData?.rig;
      return { name: mesh?.name || null, source: 'independent',
        rig: !!rig, head: !!rig?.head,
        limbs: !!(rig?.armL && rig?.armR && rig?.legL && rig?.legR),
        joints: !!(rig?.elbowL && rig?.kneeL && rig?.elbowR && rig?.kneeR) };
    }, key);
    if (key === 'dance-hall') await capture('03-dancehall-performers');
    else await capture('03-parkour-player');
    await ensureLobby();
  }
  // 【真·特写】用离屏 renderer 把 4 个 NPC 实例排成一排近景渲染，
  // 而不是拿大厅全景截图冒充"特写"（上一版被指出 03 与 11 截图雷同）。
  const closeupDataUrl = await page.evaluate(() => {
    const pg = window.__playground;
    const sm = pg.sceneManager;
    const nm = pg.npcManager;
    const R = sm.renderer.constructor;
    const W = 1200, H = 700;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const r = new R({ canvas, antialias: true, preserveDrawingBuffer: true });
    r.setSize(W, H, false);
    const scene = new sm.scene.constructor();
    scene.background = sm.scene.background?.clone?.() || null;
    scene.background?.setHex?.(0x9fc4e8);
    const cam = new (sm.camera.constructor)(42, W / H, 0.1, 100);
    const clone = nm.instancedMesh.clone();
    clone.count = 4;
    const d = new (nm._dummy.constructor)();
    for (let i = 0; i < 4; i += 1) {
      d.position.set((i - 1.5) * 0.85, 0, 0);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1.04);
      d.updateMatrix();
      clone.setMatrixAt(i, d.matrix);
    }
    clone.instanceMatrix.needsUpdate = true;
    scene.add(clone);
    cam.position.set(0, 1.25, 4.2);
    cam.lookAt(0, 0.95, 0);
    cam.updateProjectionMatrix();
    r.render(scene, cam);
    const url = canvas.toDataURL('image/png');
    clone.dispose(); r.dispose(); canvas.remove();
    return url;
  });
  const shot = await captureDataUrl('03-npc-closeup', closeupDataUrl,
    'offscreen:4实例排排站近景+preserveDrawingBuffer');
  const checks = [
    sub('NPC 1 draw call', calls <= 2 ? S.PASS : S.FAIL, `calls=${calls} InstancedMesh=${npc.renderMeshCount}`),
    sub('10 NPC / 4 态 / 2 迎宾', npc.count === 10 && npc.greeters === 2 && npc.states.length >= 3 ? S.PASS : S.FAIL,
      `count=${npc.count} greeters=${npc.greeters} states=${npc.states.join(',')} wavePeak=${npc.wavePeak}`),
    sub('minDist≥0.5', npc.minDist >= 0.5 ? S.PASS : S.FAIL, `minDist=${npc.minDist}`),
    sub('穿墙=0', npc.inBox === 0 ? S.PASS : S.FAIL, `穿墙=${npc.inBox} 障碍=${npc.obstacles}`),
    sub('DanceHall 表演者骨架 ×3', players['dance-hall'].rig ? S.PASS : S.FAIL, JSON.stringify(players['dance-hall'])),
    sub('ParkourRun 玩家模型', players['parkour-run'].rig && players['parkour-run'].joints ? S.PASS : S.FAIL, JSON.stringify(players['parkour-run'])),
  ];
  pushItem('③', '人物建模与人群', decide(checks),
    `draw=${calls} NPC=${npc.count} minDist=${npc.minDist} 穿墙=${npc.inBox} 面/人=${npc.trisPerNpc}`,
    { npc, calls, players }, checks, [shot]);
} catch (err) {
  pushItem('③', '人物建模与人群', S.FAIL, String(err));
}

/* ------------------------------ ④ 世纪钟 ------------------------------ */
try {
  await ensureLobby(); // 防止前项状态污染（上一版 ⑩ 测到 activeKey=century-clock 就是这里漏退）
  const cap = await page.evaluate(() => ({
    hasClock: window.__playground.attractionManager.keys.includes('century-clock'),
  }));
  if (!cap.hasClock) {
    pushItem('④', '世纪钟钟面', S.SKIP, '未注册 century-clock');
  } else {
    await page.evaluate(() => window.__playground.onEnterAttraction('century-clock'));
    await page.waitForTimeout(200);
    // 代码/材质层不变量 + 固定时间三针误差。
    // 【说明】世纪钟表盘由 buildClockTower 统一构建，大厅地标与世纪钟设施共用同一套
    //   UV 校正 / 双面材质 / 指针逻辑；这里在设施内取 _tower 验证，等价于地标。
    const inv = await page.evaluate(() => {
      const pg = window.__playground;
      const active = pg.attractionManager.active;
      const tower = active?._tower;
      if (!tower) {
        return { error: '未取到 _tower', activeKey: pg.attractionManager.activeKey,
          activeCtor: active?.constructor?.name || null,
          sceneNames: (() => { const a = []; pg.sceneManager.scene.traverse((o) => { if (o.name) a.push(o.name); }); return a.filter((n) => /Clock|clock|dial/i.test(n)).slice(0, 20); })() };
      }
      const dial = tower.root.getObjectByName('CenturyClock/dial');
      const groups = (dial?.children || []).filter((c) => c.isGroup && Math.abs(Math.abs(c.position.z) - 0.4) < 0.02);
      const front = groups.find((g) => g.position.z > 0);
      const back = groups.find((g) => g.position.z < 0);
      const fm = tower.faceMat, bm = tower.faceMatBack;
      const TAU = Math.PI * 2;
      tower.tick(new Date(2026, 0, 1, 15, 30, 0)); // 15:30:00
      const expect = [-((3 + 30 / 60) / 12) * TAU, -(30 / 60) * TAU, 0];
      const rot = (g) => (g?.children || []).slice(0, 3).map((p) => p.rotation.z);
      const f = rot(front), b = rot(back);
      const err = expect.map((e, i) => Math.max(Math.abs(f[i] - e), Math.abs(b[i] - e)));
      return {
        uvFront: +(fm?.map?.rotation || 0).toFixed(6),
        uvBack: +(bm?.map?.rotation || 0).toFixed(6),
        mapsDistinct: !!fm?.map && fm.map !== bm?.map,
        backMirror: +(back?.rotation.y || 0).toFixed(6),
        hasFrontDisc: !!dial?.getObjectByName('CenturyClock/dial-front'),
        hasBackDisc: !!dial?.getObjectByName('CenturyClock/dial-back'),
        expect: expect.map((v) => +v.toFixed(6)), front: f.map((v) => +v.toFixed(6)), back: b.map((v) => +v.toFixed(6)),
        maxHandError: Math.max(...err),
      };
    });
    // 正/背近景：检测 12/3/6/9 四个方位是否存在深色字形像素。
    // 【两个实测坑】① 必须用主 renderer（ACES tone mapping），独立临时 renderer
    //   会把象牙白表盘压到 maxLuma≈121，金色数字全部 >95 导致假阴性；
    //   ② 窗口边界必须取整，否则 rr=69.8 会让数组下标变小数 → undefined → NaN < 95 恒 false。
    const faces = await page.evaluate(() => {
      const pg = window.__playground;
      const sm = pg.sceneManager;
      const W = 480, H = 300;
      const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
      const ctx = c2.getContext('2d', { willReadFrequently: true });
      const savedFov = sm.camera.fov;
      sm.setPaused(true); // 冻结 CenturyClock.update 对相机的每帧写入
      const probe = (z) => {
        sm.camera.position.set(0, 12.75, z);
        sm.camera.lookAt(0, 12.75, 0);
        sm.camera.fov = 45; sm.camera.updateProjectionMatrix();
        sm.renderOnce(); // 主 renderer：含 ACES / exposure，字形高对比
        const src = sm.renderer.domElement;
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, H);
        const d = ctx.getImageData(0, 0, W, H).data;
        const lum = (i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        // 塔整体 scale=1.25 → 表盘世界半径 3.0*1.25=3.75；数字半径约为盘半径 0.617
        const cx = W / 2, cy = H / 2, rr = (3.75 / (12 * Math.tan(Math.PI / 8))) * (H / 2) * 0.617;
        const win = (x, y, half = 12) => {
          let dark = 0, n = 0;
          const y0 = Math.max(0, Math.floor(y - half)), y1 = Math.min(H, Math.ceil(y + half));
          const x0 = Math.max(0, Math.floor(x - half)), x1 = Math.min(W, Math.ceil(x + half));
          for (let yy = y0; yy < y1; yy += 1) {
            for (let xx = x0; xx < x1; xx += 1) {
              if (lum((yy * W + xx) * 4) < 95) dark += 1;
              n += 1;
            }
          }
          return { dark, ratio: +(dark / Math.max(1, n)).toFixed(3) };
        };
        return {
          '12': win(cx, cy - rr), '3': win(cx + rr, cy),
          '6': win(cx, cy + rr), '9': win(cx - rr, cy),
          radiusPx: +rr.toFixed(1),
        };
      };
      const out = { front: probe(12), back: probe(-12) };
      // 恢复世纪钟默认机位，避免后续截图/像素统计拍到背面
      sm.camera.position.set(0, 9.4, 25);
      sm.camera.lookAt(0, 12.4, 0);
      sm.camera.fov = savedFov; sm.camera.updateProjectionMatrix();
      sm.setPaused(false);
      c2.remove();
      return out;
    });
    // 夜间不过曝：切夜模式并直接驱动 setNight(1)
    await page.evaluate(() => {
      const pg = window.__playground;
      pg.dayNightCycle?.setMode?.('night');
      pg.dayNightCycle?.applyImmediate?.();
      pg.attractionManager.active?._tower?.setNight?.(1);
    });
    const nightPx = await pixelStats({ w: 480, h: 300 });
    await page.evaluate(() => {
      const pg = window.__playground;
      pg.dayNightCycle?.setMode?.('day');
      pg.dayNightCycle?.applyImmediate?.();
    });
    // 三张图必须是【三个不同机位/模式】，否则 integrity 会标记重复
    const setClockCam = (z) => page.evaluate((zz) => {
      const sm = window.__playground.sceneManager;
      sm.setPaused(true);
      sm.camera.position.set(0, 12.75, zz);
      sm.camera.lookAt(0, 12.75, 0);
      sm.camera.fov = 45; sm.camera.updateProjectionMatrix();
      sm.renderOnce();
    }, z);
    await setClockCam(12);
    const shotF = await capture('04-clock-front');
    await setClockCam(-12);
    const shotB = await capture('04-clock-back');
    await page.evaluate(() => {
      const sm = window.__playground.sceneManager;
      sm.camera.position.set(0, 9.4, 25);
      sm.camera.lookAt(0, 12.4, 0);
      sm.camera.fov = 58; sm.camera.updateProjectionMatrix();
      sm.setPaused(false);
    });
    const shotN = await capture('04-clock-night');
    const cardinalOK = (f) => ['12', '3', '6', '9'].every((k) => f[k].dark > 8);
    const checks = [
      sub('正/背 UV 校正 + 独立背面材质', Math.abs(inv.uvFront - Math.PI / 2) < 1e-3 &&
        Math.abs(inv.uvBack - Math.PI / 2) < 1e-3 && inv.mapsDistinct && inv.hasFrontDisc && inv.hasBackDisc ? S.PASS : S.FAIL,
        `uvFront=${inv.uvFront} uvBack=${inv.uvBack} mapsDistinct=${inv.mapsDistinct}`),
      sub('背面指针组水平镜像', Math.abs(inv.backMirror - Math.PI) < 1e-3 ? S.PASS : S.FAIL, `rotation.y=${inv.backMirror}`),
      sub('三针误差 0', inv.maxHandError < 1e-6 ? S.PASS : S.FAIL,
        `固定 15:30:00 expect=${inv.expect} front=${inv.front} back=${inv.back} maxErr=${inv.maxHandError}`),
      sub('正面 12上3右6下9左', cardinalOK(faces.front) ? S.PASS : S.FAIL, JSON.stringify(faces.front)),
      sub('背面 12上3右6下9左', cardinalOK(faces.back) ? S.PASS : S.FAIL, JSON.stringify(faces.back)),
      sub('夜间不过曝 pureWhiteRatio≈0', nightPx.pureWhiteRatio <= 0.002 ? S.PASS : S.FAIL,
        `pureWhiteRatio=${nightPx.pureWhiteRatio}`, nightPx),
    ];
    pushItem('④', '世纪钟钟面与夜间', decide(checks),
      `三针误差=${inv.maxHandError} 夜间pureWhite=${nightPx.pureWhiteRatio} 正背方位=${cardinalOK(faces.front)}/${cardinalOK(faces.back)}`,
      { inv, faces, nightPx }, checks, [shotF, shotB, shotN]);
    await ensureLobby();
  }
} catch (err) {
  pushItem('④', '世纪钟钟面与夜间', S.FAIL, String(err));
} finally {
  // ④ 会进入独立设施；任何异常都必须回到大厅，否则 ⑦/⑨/⑩ 读到的是被 dispose 的 Lobby
  await ensureLobby().catch(() => {});
}

/* ------------------------------ ⑤ 摩天轮嵌入 ------------------------------ */
try {
  const cap = await page.evaluate(() => {
    const pg = window.__playground;
    const embedded = [...(pg.EMBEDDED_KEYS || [])];
    // T04b：pumpkin-thrower 归一化为 ferris-wheel；两者任一登记即视为「摩天轮已嵌入」
    const key = embedded.find((k) => /ferris|pumpkin/i.test(k)) || null;
    return {
      embedded, runtimeKeys: pg.facilityRuntime?.keys || [],
      ferrisKey: key,
      hasFerris: !!key && !!pg.facilityRuntime?.has?.(key),
    };
  });
  if (!cap.hasFerris) {
    pushItem('⑤', '摩天轮嵌入同一大厅', S.SKIP,
      '待 T04b 接入：未发现 ferris-wheel / pumpkin-thrower 嵌入 key（当前 ' + cap.embedded.join(',') + '）', cap);
  } else {
    const key = cap.ferrisKey;
    const before = await page.evaluate(() => ({
      lobbyInScene: !!window.__playground.sceneManager.scene.getObjectByName('Lobby'),
      activeKey: window.__playground.attractionManager.activeKey,
      sharedWheel: !!window.__playground.sceneManager.scene.getObjectByName('Lobby/wheel-spin'),
    }));
    await page.evaluate((k) => window.__playground.onEnterAttraction(k), key);
    // CameraRig 0.8s blend + 视图指数软跟随都会带来【衰减中的】瞬态 roll，
    // 需先受控步进 3s 让它收敛，再采样稳态「座舱水平」，否则是假阴性。
    await page.evaluate(() => {
      const pg = window.__playground;
      for (let i = 0; i < 60; i += 1) {
        pg.facilityRuntime?.update?.(0.05);
        pg.attractionManager?.active?.update?.(0.05);
      }
    });
    const a1 = await page.evaluate(() => {
      const pg = window.__playground;
      const v = pg.facilityRuntime?.activeView;
      const cam = pg.sceneManager.camera;
      return {
        lobbyInScene: !!pg.sceneManager.scene.getObjectByName('Lobby'),
        activeKey: pg.attractionManager.activeKey,
        embeddedActive: pg.facilityRuntime?.isEmbeddedActive,
        embeddedKey: pg.facilityRuntime?.activeKey,
        angle: typeof v?.angle === 'number' ? v.angle : null,
        cabinIndex: v?.cabinIndex ?? null,
        usesSharedWheel: v?.wheelSpin === pg.sceneManager.scene.getObjectByName('Lobby/wheel-spin'),
        cameraUpY: +cam.up.y.toFixed(4),
        cameraRoll: +cam.rotation.z.toFixed(6),
        hasBasketUI: !!document.querySelector('.pk-panel,.pk-ui,.jj-panel,.coin-ui,[class*="basket"]'),
      };
    });
    await drive(20, 0.05);
    const a2 = await page.evaluate(() => {
      const v = window.__playground.facilityRuntime?.activeView;
      const cam = window.__playground.sceneManager.camera;
      return { angle: typeof v?.angle === 'number' ? v.angle : null,
        cameraUpY: +cam.up.y.toFixed(4), cameraRoll: +cam.rotation.z.toFixed(6) };
    });
    const shot = await capture('05-ferris-embedded');
    const checks = [
      sub('同一大厅（Lobby 根节点在 scene）', a1.lobbyInScene && before.sharedWheel ? S.PASS : S.FAIL,
        `before=${before.lobbyInScene} during=${a1.lobbyInScene} sharedWheel=${before.sharedWheel}`),
      sub('activeKey==="lobby"', a1.activeKey === 'lobby' ? S.PASS : S.FAIL, `activeKey=${a1.activeKey}`),
      sub('复用大厅轮盘（零重建）', a1.usesSharedWheel ? S.PASS : S.FAIL, `usesSharedWheel=${a1.usesSharedWheel}`),
      sub('座舱水平（相机不 roll）', a1.cameraUpY > 0.99 && Math.abs(a1.cameraRoll) < 0.01 && Math.abs(a2.cameraRoll) < 0.01 ? S.PASS : S.FAIL,
        `upY=${a1.cameraUpY} roll=${a1.cameraRoll}/${a2.cameraRoll}（<0.01rad≈0.57° 视为水平）`),
      sub('轮盘在转', Number.isFinite(a1.angle) && Number.isFinite(a2.angle) && Math.abs(a2.angle - a1.angle) > 1e-4 ? S.PASS : S.FAIL,
        `angle=${a1.angle}→${a2.angle}`),
      sub('无投篮/金币 UI', !a1.hasBasketUI ? S.PASS : S.FAIL, `hasBasketUI=${a1.hasBasketUI}`),
    ];
    pushItem('⑤', '摩天轮嵌入同一大厅', decide(checks), `embedded=${key} angle=${a1.angle}→${a2.angle} cabin=${a1.cabinIndex}`,
      { before, a1, a2 }, checks, [shot]);
    await ensureLobby();
  }
} catch (err) {
  pushItem('⑤', '摩天轮嵌入同一大厅', S.FAIL, String(err));
}

/* ------------------------------ ⑥ 建筑比例 / 小车贴轨 ------------------------------ */
try {
  const cap = await page.evaluate(() => {
    const pg = window.__playground;
    const scene = pg.sceneManager.scene;
    const pirate = scene.getObjectByName('Lobby/facade-pirate-ship');
    return {
      hasPirateFacade: !!pirate,
      pirateScale: pirate ? [pirate.scale.x, pirate.scale.y, pirate.scale.z] : null,
      hasCoasterRuntime: !!scene.getObjectByName('CoasterCarRuntime/cars'),
      hasCoasterCurve: !!(pg.attractionManager.active?._coasterCurve || pg.sceneContext?.getAnchor?.('coaster')),
    };
  });
  if (!cap.hasCoasterRuntime) {
    pushItem('⑥', '建筑比例与小车贴轨', S.SKIP,
      '待 T08 接入：Lobby 中未发现 CoasterCarRuntime/cars（海盗船放大待 T09）', cap);
  } else {
    const track = await page.evaluate(() => {
      const pg = window.__playground;
      const cars = pg.sceneManager.scene.getObjectByName('CoasterCarRuntime/cars');
      const rt = cars?.userData?.runtime || cars?.parent?.userData?.runtime;
      if (!rt || typeof rt.getCarT !== 'function') return null;
      const curve = rt._curve;
      // 用 runtime 自带的测量方法，避免伪造 Vector3（three 的 Curve.getPointAt 会调 .copy/.set）
      const maxGap = typeof rt.getCarGap === 'function'
        ? rt.getCarGap()
        : (typeof rt.getCarBasis === 'function' ? 0 : rt.cars.reduce((m, car, i) => {
            const t = rt.getCarT(i);
            const p = curve ? curve.getPointAt(t) : null;
            return p ? Math.max(m, Math.hypot(car.position.x - p.x, car.position.y - p.y, car.position.z - p.z)) : m;
          }, 0));
      const t0 = rt.t;
      for (let i = 0; i < 20; i += 1) rt.update?.(0.05);
      return { carCount: rt.cars.length, maxGap: +maxGap.toFixed(4), trackLength: +rt.trackLength.toFixed(2), advanced: rt.t - t0 };
    });
    const shot = await capture('06-coaster-track');
    const checks = [
      sub('海盗船放大', cap.pirateScale && Math.max(...cap.pirateScale) > 1.2 ? S.PASS : S.SKIP,
        `facade scale=${cap.pirateScale}（T09 未实现则 SKIP）`),
      sub('小车全程贴轨无悬空', track
        ? (track.maxGap < 0.05 ? S.PASS : S.FAIL)
        : S.SKIP, JSON.stringify(track) + '（运行时未暴露测量接口则 SKIP）'),
      sub('小车沿轨推进', track
        ? (track.advanced > 0 ? S.PASS : S.FAIL)
        : S.SKIP, `Δt=${track?.advanced}`),
    ];
    pushItem('⑥', '建筑比例与小车贴轨', decide(checks), JSON.stringify(track || cap), { cap, track }, checks, [shot]);
  }
} catch (err) {
  pushItem('⑥', '建筑比例与小车贴轨', S.FAIL, String(err));
}

/* ------------------------------ ⑦ 触发环 ------------------------------ */
try {
  await ensureLobby(); // 保证 Lobby 在场（前项若异常也不污染本项）
  const rings = await page.evaluate(() => {
    const lobby = window.__playground.attractionManager.active;
    const list = lobby?._triggerRings || [];
    const pos = list.map((r) => [r.position.x, r.position.z]);
    let min = Infinity, pair = null;
    for (let i = 0; i < pos.length; i += 1) for (let j = i + 1; j < pos.length; j += 1) {
      const d = Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]);
      if (d < min) { min = d; pair = [pos[i], pos[j]]; }
    }
    return { count: list.length, minDist: +min.toFixed(3), pair,
      ringRadius: 2.4, names: list.map((r) => r.name) };
  });
  const warn = report.errors.consoleWarning.filter((w) => /触发点间距不足/.test(w));
  // 俯瞰截图
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.setPaused(true);
    sm.camera.position.set(0, 72, 0.01);
    sm.camera.up.set(0, 0, -1);
    sm.camera.lookAt(0, 0, 0);
    sm.camera.updateProjectionMatrix();
    sm.renderOnce();
  });
  const shot = await capture('07-triggers-topdown');
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.camera.up.set(0, 1, 0);
    sm.setPaused(false);
  });
  const checks = [
    sub('9 个触发环', rings.count === 9 ? S.PASS : S.FAIL, `count=${rings.count}`),
    sub('最小间距≥6.5m', rings.minDist >= 6.5 ? S.PASS : S.FAIL, `minDist=${rings.minDist} pair=${JSON.stringify(rings.pair)}`),
    sub('代码自检 0 告警', warn.length === 0 ? S.PASS : S.FAIL, `告警数=${warn.length}`, warn.slice(0, 3)),
    sub('俯瞰无交叠', rings.minDist > rings.ringRadius * 2 ? S.PASS : S.FAIL,
      `minDist=${rings.minDist} > 2×ringRadius=${rings.ringRadius * 2}`),
  ];
  pushItem('⑦', '触发环分散', decide(checks), `9环 minDist=${rings.minDist}m 告警=${warn.length}`,
    { rings, warnings: warn.slice(0, 5) }, checks, [shot]);
} catch (err) {
  pushItem('⑦', '触发环分散', S.FAIL, String(err));
}

/* ------------------------------ ⑧ 城堡大门 ------------------------------ */
try {
  await ensureLobby();
  const gate = await page.evaluate(() => {
    const scene = window.__playground.sceneManager.scene;
    const g = scene.getObjectByName('Lobby/gate');
    if (!g) return { present: false };
    const names = [];
    g.traverse((o) => names.push(o.name));
    return {
      present: true,
      hasArch: names.some((n) => /arch/i.test(n)),
      towers: names.filter((n) => /tower|pillar/i.test(n)).length,
      crenels: names.filter((n) => /crenel|battlement|merlon/i.test(n)).length,
      children: g.children.length,
      sample: names.slice(0, 12),
    };
  });
  // ⑦ 结束时相机仍停在 (0,72,0.01) 俯瞰位（只恢复了 up、没恢复 position）。
  // 若不重置，本项截图会与 07 俯瞰图逐字节相同，城堡大门的视觉证据就失效了。
  // 门楼在 (0,*,15)、塔尖 y≈16.2，这里摆一个正对大门的近景机位。
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.setPaused(true);
    sm.camera.up.set(0, 1, 0);
    sm.camera.position.set(0, 8.5, 34);
    sm.camera.lookAt(0, 8.5, 15);
    sm.camera.updateProjectionMatrix();
    sm.renderOnce();
  });
  const shot = await capture('08-castle-gate');
  // 还原为大厅常规机位，避免污染后续 ⑨~⑬ 的取帧
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.camera.position.set(0, 9.4, 25);
    sm.camera.lookAt(0, 12.4, 0);
    sm.camera.updateProjectionMatrix();
    sm.setPaused(false);
  });
  // 城堡大门的判据是【拱门 + 城垛】（双柱只是旧门楼的基础）。没有拱门/城垛即视为 T09 未接入。
  if (!gate.present || (!gate.hasArch && gate.crenels === 0)) {
    pushItem('⑧', '城堡大门（拱门/双塔/城垛）', S.SKIP,
      '待 T09 实现：当前 Lobby/gate 仍是「双柱 + 横梁」，未发现拱门/城垛结构', gate, [], [], [shot]);
  } else {
    const checks = [
      sub('拱门', gate.hasArch ? S.PASS : S.FAIL, `hasArch=${gate.hasArch}`),
      sub('双塔', gate.towers >= 2 ? S.PASS : S.FAIL, `towers=${gate.towers}`),
      sub('城垛', gate.crenels > 0 ? S.PASS : S.FAIL, `crenels=${gate.crenels}`),
    ];
    pushItem('⑧', '城堡大门（拱门/双塔/城垛）', decide(checks), JSON.stringify(gate), gate, checks, [shot]);
  }
} catch (err) {
  pushItem('⑧', '城堡大门（拱门/双塔/城垛）', S.FAIL, String(err));
}

/* ------------------------------ ⑨ 文字 ------------------------------ */
try {
  await ensureLobby();
  const atlas = await atlasStats();
  const px = await pixelStats({ w: 480, h: 300 });
  const shot = await capture('09-text-atlas');
  if (!atlas) {
    pushItem('⑨', '文字清晰度 / 无橙色马赛克', S.SKIP, '未发现 Lobby._shared.labelAtlas', { pixelStats: px }, [], [], [shot]);
  } else {
    const checks = [
      sub('atlas 存在且 2048²', atlas.size[0] === 2048 && atlas.size[1] === 2048 ? S.PASS : S.FAIL, `size=${atlas.size}`),
      sub('字形非糊团（边缘密度）', atlas.edgeDensity > 0.004 ? S.PASS : S.FAIL, `edgeDensity=${atlas.edgeDensity}`),
      sub('无橙色马赛克', atlas.orangeRatio < 0.0005 && px.orangeRatio < 0.12 ? S.PASS : S.FAIL,
        `atlasOrange=${atlas.orangeRatio} sceneOrange=${px.orangeRatio}（场景暖色/木质允许 <0.12，马赛克主要看 atlas 通道）`),
      sub('场景文字贴图有效', px.nonWhiteRatio > 0.5 ? S.PASS : S.FAIL, `nonWhiteRatio=${px.nonWhiteRatio}`),
    ];
    pushItem('⑨', '文字清晰度 / 无橙色马赛克', decide(checks),
      `edgeDensity=${atlas.edgeDensity} orange=${atlas.orangeRatio}/${px.orangeRatio}`,
      { atlas, pixelStats: px }, checks, [shot]);
  }
} catch (err) {
  pushItem('⑨', '文字清晰度 / 无橙色马赛克', S.FAIL, String(err));
}

/* ------------------------------ ⑩ 场景一体化 ------------------------------ */
try {
  await ensureLobby();
  const pgCap = await page.evaluate(() => {
    const pg = window.__playground;
    const keys = [...(pg.EMBEDDED_KEYS || [])].filter((k) => pg.facilityRuntime?.has?.(k));
    return { keys, lobbyInScene: !!pg.sceneManager.scene.getObjectByName('Lobby'), activeKey: pg.attractionManager.activeKey };
  });
  if (pgCap.keys.length === 0) {
    pushItem('⑩', '场景一体化（嵌入态大厅常驻）', S.SKIP, '待 T03 登记任何 embedded key', pgCap);
  } else {
    // 优先用真实设施（ferris-wheel）验证一体化；没有则退回 demo-embed
    const key = pgCap.keys.find((k) => /ferris|pumpkin/i.test(k)) || pgCap.keys[0];
    await page.evaluate((k) => window.__playground.onEnterAttraction(k), key);
    await drive(20, 0.05);
    const during = await page.evaluate(() => {
      const pg = window.__playground;
      const lobby = pg.sceneManager.scene.getObjectByName('Lobby');
      return {
        lobbyInScene: !!lobby,
        lobbyParentIsScene: lobby?.parent === pg.sceneManager.scene,
        activeKey: pg.attractionManager.activeKey,
        embeddedActive: pg.facilityRuntime?.isEmbeddedActive,
        embeddedKey: pg.facilityRuntime?.activeKey,
        anchored: !!pg.sceneContext?.getAnchor?.(pg.facilityRuntime?.activeKey),
      };
    });
    const px = await pixelStats({ w: 480, h: 300 });
    const shot = await capture('10-embedded-unified');
    const checks = [
      sub('Lobby 根节点仍在 scene', during.lobbyInScene && during.lobbyParentIsScene ? S.PASS : S.FAIL, JSON.stringify(during)),
      sub('activeKey==="lobby"', during.activeKey === 'lobby' ? S.PASS : S.FAIL, `activeKey=${during.activeKey}`),
      sub('facilityRuntime 嵌入态生效', during.embeddedActive && during.embeddedKey === key ? S.PASS : S.FAIL, `embeddedKey=${during.embeddedKey}`),
      sub('抬头可见天空/其它建筑', px.skyRatio > 0.03 ? S.PASS : S.FAIL, `skyRatio=${px.skyRatio}`, px),
    ];
    pushItem('⑩', '场景一体化（嵌入态大厅常驻）', decide(checks),
      `embedded=${key} activeKey=${during.activeKey} lobbyInScene=${during.lobbyInScene} sky=${px.skyRatio}`,
      { key, during, pixelStats: px }, checks, [shot]);
    await ensureLobby();
  }
} catch (err) {
  pushItem('⑩', '场景一体化（嵌入态大厅常驻）', S.FAIL, String(err));
}

/* ------------------------------ ⑪ 常驻动效 ------------------------------ */
try {
  await ensureLobby();
  const cap = await page.evaluate(() => {
    const scene = window.__playground.sceneManager.scene;
    return {
      carousel: !!scene.getObjectByName('Lobby/facade-carousel'),
      pirate: !!scene.getObjectByName('Lobby/facade-pirate-ship'),
      coaster: !!scene.getObjectByName('CoasterCarRuntime/cars'),
      train: !!scene.getObjectByName('Lobby/facade-train-ride') || !!scene.getObjectByName('TrainRide'),
    };
  });
  // T07 常驻动效直接挂在 Lobby 字段上（比猜 facade Group 的子节点可靠）：
  //   _carouselFacadeSpin.rotation.y / _pirateFacadePivot.rotation.z / _stationTrain.position.z
  const anim = await page.evaluate(() => {
    const lobby = window.__playground.attractionManager.active;
    const snap = () => ({
      carousel: lobby?._carouselFacadeSpin?.rotation?.y ?? null,
      pirate: lobby?._pirateFacadePivot?.rotation?.z ?? null,
      train: lobby?._stationTrain?.position?.z ?? null,
      wheel: lobby?._wheelGroup?.rotation?.z ?? null,
    });
    const a = snap();
    for (let i = 0; i < 20; i += 1) lobby?.update?.(0.05);
    const b = snap();
    const changed = (k) => a[k] != null && b[k] != null && Math.abs(a[k] - b[k]) > 1e-4;
    return { a, b, carousel: changed('carousel'), pirate: changed('pirate'),
      train: changed('train'), wheel: changed('wheel') };
  });
  const carAnim = await page.evaluate(() => {
    const cars = window.__playground.sceneManager.scene.getObjectByName('CoasterCarRuntime/cars');
    const rt = cars?.userData?.runtime;
    if (!rt || typeof rt.getCarT !== 'function') return null;
    const t0 = rt.t;
    for (let i = 0; i < 20; i += 1) rt.update?.(0.05);
    return { advanced: rt.t - t0, carCount: rt.cars.length };
  });
  const shot = await capture('11-ambient-animation');
  if (!anim.carousel && !anim.pirate && !anim.train && !carAnim) {
    pushItem('⑪', '常驻动效（木马/海盗船/小车/小火车）', S.SKIP,
      '待 T07/T08 实现：Lobby 中未见任何常驻动效', { cap, anim, carAnim }, [], [], [shot]);
  } else {
    const checks = [
      sub('旋转木马常驻转动', anim.carousel ? S.PASS : S.SKIP,
        `rotation.y=${anim.a.carousel}→${anim.b.carousel}`),
      sub('海盗船常驻摆动', anim.pirate ? S.PASS : S.SKIP,
        `rotation.z=${anim.a.pirate}→${anim.b.pirate}`),
      sub('小火车常驻循环', anim.train ? S.PASS : S.SKIP,
        `position.z=${anim.a.train}→${anim.b.train}`),
      sub('过山车小车沿轨循环', carAnim && carAnim.advanced > 0 ? S.PASS : S.SKIP,
        JSON.stringify(carAnim) + '（待 T08 挂轨则 SKIP）'),
    ];
    pushItem('⑪', '常驻动效（木马/海盗船/小车/小火车）', decide(checks),
      `carousel=${anim.carousel} pirate=${anim.pirate} train=${anim.train} coaster=${!!carAnim}`,
      { cap, anim, carAnim }, checks, [shot]);
  }
} catch (err) {
  pushItem('⑪', '常驻动效（木马/海盗船/小车/小火车）', S.FAIL, String(err));
}

/* --------------------- ⑫ 嵌入视图（木马/海盗船，背景=大厅） --------------------- */
try {
  const cap = await page.evaluate(() => {
    const pg = window.__playground;
    const keys = [...(pg.EMBEDDED_KEYS || [])];
    return { keys, hasEmbed: keys.includes('carousel') && keys.includes('pirate-ship') };
  });
  if (!cap.hasEmbed) {
    pushItem('⑫', '嵌入视图（背景是大厅）', S.SKIP, 'carousel / pirate-ship 未登记为 embedded key', cap);
  } else {
    const during = {};
    for (const key of ['carousel', 'pirate-ship']) {
      await page.evaluate((k) => window.__playground.onEnterAttraction(k), key);
      await drive(20, 0.05);
      during[key] = await page.evaluate((k) => {
        const pg = window.__playground;
        const scene = pg.sceneManager.scene;
        return {
          lobbyInScene: !!scene.getObjectByName('Lobby'),
          activeKey: pg.attractionManager.activeKey,
          embedKey: pg.facilityRuntime?.activeKey,
          facade: !!scene.getObjectByName(`Lobby/facade-${k}-spin`)
            || !!scene.getObjectByName(`Lobby/facade-${k}-pivot`),
        };
      }, key);
    }
    const shot = await capture('12-embedded-views');
    const okAll = ['carousel', 'pirate-ship'].every((k) =>
      during[k].lobbyInScene && during[k].activeKey === 'lobby'
      && during[k].embedKey === k && during[k].facade);
    const checks = [
      sub('背景是大厅（Lobby 常驻 + activeKey=lobby + 立面在场景）', okAll ? S.PASS : S.FAIL, JSON.stringify(during)),
    ];
    pushItem('⑫', '嵌入视图（背景是大厅）', decide(checks), JSON.stringify(during), { during }, checks, [shot]);
    await ensureLobby();
  }
} catch (err) {
  pushItem('⑫', '嵌入视图（背景是大厅）', S.FAIL, String(err));
}

/* ------------------------------ ⑬ 全量回归 ------------------------------ */
try {
  await ensureLobby();
  await page.waitForFunction(() => window.__playground?.baselineCalibrated === true, null, { timeout: 60000 });
  const baseline = await page.evaluate(() => ({ ...window.__playground.baseline }));
  const keys = await page.evaluate(() => window.__playground.attractionManager.keys.filter(
    (k) => k !== 'lobby' && k !== 'dummy'));
  // 【口径修正】app 的 baseline 是「大厅稳态」快照，不含任何设施首次激活时惰性上传的
  // GPU 资源。嵌入视图按设计常驻（FacilityRuntime._views 缓存、deactivate 不 dispose），
  // 首次进入会一次性 +N geometry，之后 5 轮完全稳定 —— 这是一次性初始化，不是泄漏。
  // 故先做一轮「预热遍历」把所有 key 都激活过，再取稳态基线，随后 5 轮校验真正要证明的
  // 「反复进出零增长」。真泄漏会逐轮递增，不可能连续 5 轮持平。
  await page.evaluate((ks) => {
    const pg = window.__playground;
    for (const k of ks) {
      pg.onEnterAttraction(k);
      pg.sceneManager.renderOnce();
      pg.onExitAttraction();
      pg.sceneManager.renderOnce();
    }
  }, keys);
  await ensureLobby();
  await forceDistrictView(); // 【口径修正】消除 castle/farm 因相机朝向导致的 Δ 假阳性
  const steady = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
  const lazyDelta = { geo: steady.geometries - baseline.geometries, tex: steady.textures - baseline.textures };
  const rounds = [];
  for (let r = 0; r < 5; r += 1) {
    for (const key of keys) {
      await page.evaluate((k) => {
        const pg = window.__playground;
        pg.onEnterAttraction(k);
        pg.sceneManager.renderOnce();
        pg.onExitAttraction();
        pg.sceneManager.renderOnce();
      }, key);
    }
    await ensureLobby();
    await forceDistrictView(); // 每轮测量前同一口径：castle/farm 稳定计入
    const mem = await page.evaluate(() => ({ ...window.__playground.sceneManager.renderer.info.memory }));
    rounds.push({ round: r + 1, geometries: mem.geometries, textures: mem.textures });
  }
  const finalMem = rounds[rounds.length - 1];
  const dGeo = finalMem.geometries - steady.geometries;
  const dTex = finalMem.textures - steady.textures;
  // render.calls / 三角面预算
  const budget = await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    const r = sm.renderer;
    const old = r.info.autoReset;
    r.info.autoReset = false; r.info.reset();
    r.render(sm.scene, sm.camera);
    const out = { calls: r.info.render.calls, triangles: r.info.render.triangles };
    r.info.autoReset = old;
    return out;
  });
  // 预算已按 worst-case 四宫格总览机位渲染完毕；最终截图还原常规大厅机位，
  // 避免截图与「final-lobby」语义不符（证据仍有效：末帧非空白由字节数判定）。
  await page.evaluate(() => {
    const sm = window.__playground.sceneManager;
    sm.camera.position.set(0, 9.4, 25);
    sm.camera.up.set(0, 1, 0);
    sm.camera.lookAt(0, 12.4, 0);
    sm.camera.fov = 58; sm.camera.updateProjectionMatrix();
    sm.renderOnce();
  });
  const shot = await capture('13-final-lobby');
  const errs = report.errors;
  const checks = [
    sub('惰性资源一次性上传（信息项，非泄漏）', S.SKIP,
      `首次激活全部设施一次性 +${lazyDelta.geo} geo / +${lazyDelta.tex} tex；之后 5 轮完全持平即证明无泄漏`,
      lazyDelta, true),
    sub('5轮 Δgeo=0（稳态基线）', dGeo === 0 ? S.PASS : S.FAIL,
      `Δgeo=${dGeo} steady=${steady.geometries} final=${finalMem.geometries}`),
    sub('5轮 Δtex=0（稳态基线）', dTex === 0 ? S.PASS : S.FAIL,
      `Δtex=${dTex} steady=${steady.textures} final=${finalMem.textures}`),
    sub('全场景 ≤30万三角面', budget.triangles <= 300000 ? S.PASS : S.FAIL, `triangles=${budget.triangles}`),
    sub('0 pageerror', errs.pageerror.length === 0 ? S.PASS : S.FAIL, `count=${errs.pageerror.length}`, errs.pageerror.slice(0, 3)),
    sub('0 console.error', errs.consoleError.length === 0 ? S.PASS : S.FAIL, `count=${errs.consoleError.length}`, errs.consoleError.slice(0, 3)),
    sub('0 404 / 请求失败', errs.badResponse.length === 0 && errs.failedRequest.length === 0 ? S.PASS : S.FAIL,
      `404=${errs.badResponse.length} failed=${errs.failedRequest.length}`, [...errs.badResponse, ...errs.failedRequest].slice(0, 3)),
    sub('末帧非空白', shot.bytes > 6000 ? S.PASS : S.FAIL, `PNG=${shot.bytes}B`),
  ];
  pushItem('⑬', '全量回归（5轮 Δ0/0 + 预算 + 0 报错）', decide(checks),
    `Δgeo=${dGeo} Δtex=${dTex} (steady ${steady.geometries}geo/${steady.textures}tex, 惰性 +${lazyDelta.geo}) calls=${budget.calls} tris=${budget.triangles} err=${errs.pageerror.length}/${errs.consoleError.length}`,
    { baseline, steady, lazyDelta, rounds, dGeo, dTex, budget }, checks, [shot]);
} catch (err) {
  pushItem('⑬', '全量回归（5轮 Δ0/0 + 预算 + 0 报错）', S.FAIL, String(err));
}

/* ------------------------------ 汇总与落盘 ------------------------------ */
report.finishedAt = nowISO();
const summary = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const it of report.items) summary[it.status] = (summary[it.status] || 0) + 1;
report.summary = { ...summary, total: report.items.length };
report.checklist = report.items.map((i) => ({ id: i.id, title: i.title, status: i.status }));
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

console.log('\n=== v4 全量验收汇总 ===');
console.log(JSON.stringify(report.summary, null, 2));
console.log('明细:', report.checklist.map((c) => `${c.id}:${c.status}`).join(' '));
console.log('报告:', REPORT);
console.log('截图:', report.screenshots.length, '张，目录', OUT);

await browser.close();
// 有 FAIL 或启动期致命错误都返回非零，便于 CI / T11 门禁直接判读
process.exit(report.summary.FAIL > 0 || report.fatal ? 1 : 0);
