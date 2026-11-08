/**
 * ============================================================================
 * main.js —— 全站唯一入口（M6 开始页 + 音频接入版）
 * ============================================================================
 * 顺序：创建并显示开始页（纯 DOM，循环之外） → await 物理初始化
 *       → 装配各管理器（注入 onEnter/onExit 回调）→ 注册全部项目
 *       → M2 桩 / M3 / M4 / M5b / Lobby 逐级预热
 *       → 【Lobby 激活态】固化本次会话基线 → 卸载 → 正式激活 Lobby
 *       → 悬浮 UI → 等待开始页「进入」→ 启动渲染循环。
 *
 * 【开始页与循环】预热只用 renderOnce()，绝不在开始页背后跑 rAF：
 *   startGameplayLoop() 同时要求 startRequested && bootReady，且 loopStarted、
 *   SceneManager._running 双重幂等，因此不会黑屏、也不会双循环。

 * 【为什么每处都要强制 renderOnce()】
 * Three.js 的 GPU 资源是惰性上传的：新建 geometry / texture 时它们只是 JS 对象，
 * 只有在真正渲染（经 SceneManager 的 EffectComposer）时才会创建 WebGL 缓冲与纹理，
 * renderer.info.memory 统计的正是「已上传的对象数」。
 *
 * 【M5a 基线口径】
 * 本阶段验收对象是「大厅 → 小游戏 → 大厅」的来回切换：起点与终点都是
 * 【大厅激活态】，因此基线取 Lobby 预热时激活态的计数（而非空场景）。
 * 另记录 emptyBaseline（空场景）供左上角「卸载测试」日志对照。
 * 注意：基线里的 textures 含 three r187 的 dfgLUT 内部纹理，不是泄漏。
 * ============================================================================
 */

import './style.css';
import sceneManager from './core/SceneManager.js';
import physicsManager from './core/PhysicsManager.js';
import interactionManager from './core/InteractionManager.js';
import uiManager from './core/UIManager.js';
import audioManager from './core/AudioManager.js';
import StartScreen from './ui/StartScreen.js';
import attractionManager from './attractions/AttractionManager.js';
import { DummyAttraction } from './attractions/DummyAttraction.js';
import { PumpkinThrower } from './attractions/PumpkinThrower.js';
import { CoinPath } from './attractions/CoinPath.js';
import { MemoryMatch } from './attractions/MemoryMatch.js';
import { BouncingBall } from './attractions/BouncingBall.js';
import { TrainRide } from './attractions/TrainRide.js';
import { Lobby } from './attractions/Lobby.js';

/** M2 预热桩：仅用于渲染器预热，保证 dfgLUT 等内部资源就绪 */
const DUMMY_KEY = 'dummy';
/** M3 项目：投掷类「南瓜投手」（大厅「南瓜摩天轮」可进入） */
const PUMPKIN_KEY = 'pumpkin-thrower';
/** M4 项目：收集类「金币小径」（大厅「金币长廊」可进入） */
const COIN_KEY = 'coin-path';
/** M5b 项目：记忆类「记忆翻牌」（大厅「魔法牌屋」可进入） */
const MEMORY_KEY = 'memory-match';
/** M7 项目：物理类「弹跳碰碰球」（大厅「弹跳竞技场」可进入） */
const BOUNCE_KEY = 'bouncing-ball';
/** M8 项目：观景类「高空环游」（大厅「小火车站台」可进入） */
const TRAIN_KEY = 'train-ride';
/** M5a 项目：可漫游的游乐场大厅 */
const LOBBY_KEY = 'lobby';
/** 当前正式激活的项目 */
const ACTIVE_KEY = LOBBY_KEY;

/** 项目显示名映射：调试面板动态读取，不写死任何里程碑 / 项目名 */
const PROJECT_NAMES = Object.freeze({
  [DUMMY_KEY]: 'M2 预热桩',
  [PUMPKIN_KEY]: '南瓜投手',
  [COIN_KEY]: '金币小径',
  [MEMORY_KEY]: '记忆翻牌',
  [BOUNCE_KEY]: '弹跳碰碰球',
  [TRAIN_KEY]: '高空环游',
  [LOBBY_KEY]: '游乐场大厅',
});

function projectName(key) {
  return PROJECT_NAMES[key] || key;
}

/**
 * 统一刷新左上角基座调试面板。
 * 【不改 core/】UIManager 里写死的「游乐场基座 · M2 验证」标题与 M2 提示语
 * 在这里从 main.js 运行时覆盖成通用文案；状态行动态显示当前项目名。
 * @param {string} text 状态栏文案
 * @param {{showUnload?: boolean}} options showUnload=true 显示「卸载测试」按钮
 *        （大厅时隐藏，进入小游戏时显示）
 */
function setDebugPanel(text, { showUnload = false } = {}) {
  const title = document.querySelector('.pg-ui__title');
  const hint = document.querySelector('.pg-ui__hint');
  const unloadBtn = document.querySelector('[data-action="deactivate"]');
  if (title) title.textContent = '游乐场基座 · 资源验收';
  if (hint) {
    hint.textContent = '第一人称漫游：WASD / 方向键移动、按住画面拖拽环顾四周；走近发光圆环按 E 或点击进入小游戏，结算后可返回大厅。资源归零请以控制台差值为准。';
  }
  // 【M5a】大厅隐藏 / 小游戏显示「卸载测试」按钮
  if (unloadBtn) unloadBtn.style.display = showUnload ? '' : 'none';
  uiManager.setStatus(text);
}

/** 本次会话基线（M5a = Lobby 激活态计数）；emptyBaseline 为卸载后空场景计数 */
let baseline = { geometries: 0, textures: 0 };
let emptyBaseline = { geometries: 0, textures: 0 };
let switchCount = 0;
let roundTripCount = 0;

function readMemory() {
  const { geometries, textures } = sceneManager.renderer.info.memory;
  return { geometries, textures };
}

/** 打印资源计数，并与指定参照基线对比（默认用本次会话基线） */
function logMemory(tag, ref = baseline) {
  const current = readMemory();
  const dGeometries = current.geometries - ref.geometries;
  const dTextures = current.textures - ref.textures;
  const isBackToBaseline = dGeometries === 0 && dTextures === 0;

  console.log(
    `%c[资源计数] ${tag}`,
    'color:#7fd1ff;font-weight:bold',
    `\n  geometries = ${current.geometries}  (基线 ${ref.geometries}, 差值 ${dGeometries})` +
      `\n  textures   = ${current.textures}  (基线 ${ref.textures}, 差值 ${dTextures})` +
      `\n  是否回落至基线: ${isBackToBaseline ? '是' : '否'}`,
    current
  );
  return current;
}

/* ========================================================================== */
/* 开始页与音频（M6 接入）                                                    */
/* ========================================================================== */

/**
 * 开始页显示期间【不启动渲染循环】：场景只做预热用的 renderOnce()，
 * 真正跑起来必须同时满足「用户点了进入」+「boot 预热完成」。
 */
let startScreen = null;
let startRequested = false;
let bootReady = false;
let loopStarted = false;

/**
 * 启动统一渲染循环（幂等）。
 * SceneManager.start() 内部有 _running 闸门，这里再用 loopStarted 兜底，
 * 保证任何路径都不会出现双循环。
 */
function startGameplayLoop() {
  if (loopStarted || !startRequested || !bootReady) return;
  loopStarted = true;
  sceneManager.start();
  console.info('[基座] 渲染循环已启动（用户在开始页确认进入后）');
}

/**
 * 开始页：纯 DOM / CSS，在 WebGL 循环之外。
 * 点击进入后才 hide()，若此时预热尚未完成则保持覆盖，等 bootReady 再进入，
 * 避免露出未完成的画面（黑屏 / 半成品帧）。
 */
startScreen = new StartScreen({
  autoHide: false,
  onStart: () => {
    if (startRequested) return;
    startRequested = true;
    // 手势内先尝试发声；未解锁时 AudioManager.play 静默返回 false，不抛错
    audioManager.playClick();

    if (bootReady) {
      startScreen.hide();
      startGameplayLoop();
      console.info('[开始页] 已进入游乐场');
    } else {
      console.info('[开始页] 已确认进入，等待资源预热完成后自动进入…');
    }
  },
});
startScreen.init();
startScreen.show();

/* 页面卸载统一收尾：开始页 DOM / 样式 / 监听，以及 AudioContext */
const onPageHide = (event) => {
  // bfcache 场景（event.persisted === true）页面会被冻结后原样恢复，
  // 此时若销毁开始页与 AudioContext，返回页面将无法再进入/发声，故跳过；
  // 跳过时保留监听，等真正的卸载再收尾（不能使用 { once: true }）。
  if (event.persisted) return;
  window.removeEventListener('pagehide', onPageHide);
  try {
    startScreen?.dispose();
  } catch (err) {
    console.error('[基座] 开始页清理失败：', err);
  }
  try {
    audioManager.dispose();
  } catch (err) {
    console.error('[基座] 音频清理失败：', err);
  }
};
window.addEventListener('pagehide', onPageHide);

async function bootstrap() {
  audioManager.init({ volume: 0.7 });

  /* ---------- ① 冷基线（仅作参考，不作为验收依据） ---------- */
  sceneManager.renderOnce();
  const coldBaseline = readMemory();
  console.log('[基座] 空场景冷基线（仅参考）=', coldBaseline);
  console.info(
    '[基座] 计数口径：renderer.info.memory.geometries / textures 是「已上传 GPU 的资源对象数」，' +
      '回落至本次会话基线即算归零；renderer.info.render.calls / triangles 是帧内绘制计数，' +
      '每帧自动重置，不用于归零验收。'
  );
  console.info(
    '[基座] 注意：three r187 的 MeshStandardMaterial 首次渲染会惰性创建渲染器内部的 ' +
      'dfgLUT 采样纹理，由 renderer 常驻持有、不归任何项目所有；' +
      '它包含在基线中，不是泄漏。'
  );

  /* ---------- ② Rapier 异步初始化（全工程唯一 await init()） ---------- */
  await physicsManager.init();

  /* ---------- ③ 装配：共享上下文 + M5a 双向切换回调 ---------- */
  const baseCtx = {
    scene: sceneManager.scene,
    camera: sceneManager.camera,
    renderer: sceneManager.renderer,
    RAPIER: physicsManager.RAPIER,
    world: physicsManager.world,
    physics: physicsManager,
    ui: uiManager,
    interaction: interactionManager,

    /**
     * 【M5a】大厅 → 小游戏。
     * 显示「卸载测试」按钮后激活项目；activate() 内部会先 deactivate()
     * 当前 Lobby，触发 Lobby.dispose() 把玩家坐标/视角写入 _lobbyMemory。
     */
    onEnterAttraction: (key) => {
      if (!attractionManager.keys.includes(key)) {
        console.warn(`[基座] 未注册的项目：${key}`);
        return;
      }
      audioManager.playClick();
      setDebugPanel(`基座状态: ${projectName(key)}运行中`, { showUnload: true });
      attractionManager.activate(key);
      sceneManager.renderOnce();
      console.info(`[基座] 进入「${projectName(key)}」，Lobby 已 dispose 并存档`);
    },

    /**
     * 【M5a】小游戏 → 大厅。
     * 隐藏「卸载测试」按钮后重建 Lobby；init() 从 _lobbyMemory 恢复位置，
     * 因此玩家仍站在刚才的建筑门口。随后打印本轮来回的资源差值。
     */
    onExitAttraction: () => {
      audioManager.playClick();
      setDebugPanel(`基座状态: ${projectName(LOBBY_KEY)}运行中`, { showUnload: false });
      attractionManager.activate(LOBBY_KEY);
      sceneManager.renderOnce();
      roundTripCount += 1;
      logMemory(`返回大厅（第 ${roundTripCount} 轮来回）`);
      console.info('[基座] 已返回大厅，角色位置与视角由 _lobbyMemory 恢复');
    },
  };

  sceneManager.configure({ physics: physicsManager, attractions: attractionManager });
  interactionManager.init({
    renderer: sceneManager.renderer,
    camera: sceneManager.camera,
    scene: sceneManager.scene,
    attractions: attractionManager,
  });
  attractionManager.configure(baseCtx);
  attractionManager.register(DUMMY_KEY, () => new DummyAttraction());
  attractionManager.register(PUMPKIN_KEY, () => new PumpkinThrower());
  attractionManager.register(COIN_KEY, () => new CoinPath());
  attractionManager.register(MEMORY_KEY, () => new MemoryMatch());
  attractionManager.register(BOUNCE_KEY, () => new BouncingBall());
  attractionManager.register(TRAIN_KEY, () => new TrainRide());
  attractionManager.register(LOBBY_KEY, () => new Lobby());

  /* ---------- ④ M2 桩预热（dfgLUT 等渲染器一次性资源就绪） ---------- */
  console.info('[基座] === M2 桩预热开始（不计入验收）===');
  attractionManager.activate(DUMMY_KEY);
  sceneManager.renderOnce();
  attractionManager.deactivate();
  sceneManager.renderOnce();
  console.info('[基座] === M2 桩预热结束 ===');
  console.log('[基座] 中间计数（M2 后，仅参考）=', readMemory(), '| 冷基线 =', coldBaseline);

  /* ---------- ④-b M3 预热：南瓜投手（大厅里可进入，必须提前上传其材质） ---------- */
  console.info('[基座] === M3 项目预热开始（不计入验收）===');
  const warm3 = attractionManager.activate(PUMPKIN_KEY);
  sceneManager.renderOnce();
  warm3.warmUpThrowHit();
  sceneManager.renderOnce();
  warm3.warmUpExpire();
  sceneManager.renderOnce();
  attractionManager.deactivate();
  sceneManager.renderOnce();
  console.info('[基座] === M3 项目预热结束 ===');
  console.log('[基座] 中间计数（M3 后，仅参考）=', readMemory());

  /* ---------- ④-c M4 预热：金币小径（大厅「金币长廊」可进入，必须提前上传材质） ---------- */
  console.info('[基座] === M4 项目预热开始（不计入验收）===');
  const warm4 = attractionManager.activate(COIN_KEY);
  sceneManager.renderOnce();
  warm4.warmUpMoveCollect();
  sceneManager.renderOnce();
  const m4WarmupPeak = readMemory();
  warm4.warmUpExpire();
  sceneManager.renderOnce();
  attractionManager.deactivate();
  sceneManager.renderOnce();
  console.info('[基座] === M4 项目预热结束 ===');
  console.log('[基座] 中间计数（M4 后，仅参考）=', readMemory(), '| M4 预热峰值 =', m4WarmupPeak);

  /* ---------- ④-d M5b 预热：记忆翻牌（大厅「魔法牌屋」可进入） ----------
   * 必须在下一条「Lobby 基线」之前完成：本项目的 7 张 CanvasTexture 与
   * 翻牌材质在这一帧真正上传，随后 dispose 归零，不会污染 Lobby 基线。
   */
  console.info('[基座] === M5b 记忆翻牌预热开始（不计入验收）===');
  const warm5 = attractionManager.activate(MEMORY_KEY);
  sceneManager.renderOnce(); // 12 张卡正反面 + 7 张 CanvasTexture 首次上传
  warm5.warmUpFlip(); // 配对成功 + 不匹配翻回的完整补间路径
  sceneManager.renderOnce();
  const memoryWarmupPeak = readMemory();
  attractionManager.deactivate();
  sceneManager.renderOnce();
  console.info('[基座] === M5b 记忆翻牌预热结束 ===');
  console.log('[基座] 中间计数（M5b 后，仅参考）=', readMemory(), '| M5b 预热峰值 =', memoryWarmupPeak);

  /* ---------- ④-d2 M7 预热：弹跳碰碰球（大厅「弹跳竞技场」可进入） ----------
   * 必须在下一条「Lobby 基线」之前完成：刚体、粒子池材质、三种碎片材质
   * 与目标区光环在这一帧全部上传；warmUp() 内部已关闭计分（_scoringEnabled）。
   */
  console.info('[基座] === M7 弹跳碰碰球预热开始（不计入验收）===');
  const warmBounce = attractionManager.activate(BOUNCE_KEY);
  sceneManager.renderOnce();
  warmBounce.warmUp();
  sceneManager.renderOnce();
  const bounceWarmupPeak = readMemory();
  attractionManager.deactivate();
  sceneManager.renderOnce();
  console.info('[基座] === M7 弹跳碰碰球预热结束 ===');
  console.log('[基座] 中间计数（M7 后，仅参考）=', readMemory(), '| M7 预热峰值 =', bounceWarmupPeak);

  /* ---------- ④-d3 M8 预热：高空环游（大厅「小火车站台」可进入） ----------
   * 同样必须在 Lobby 基线之前完成：TRAIN 的 1 个共享方块几何 + 17 个调色板
   * 材质、轨道 / 枕木 / 桥墩三个 InstancedMesh、方块游乐场全景，以及
   * 相机位姿路径（getPointAt / 压弯 / 俯角）都在 warmUp() 内走一遍。
   * warmUp() 内部会 _resetRide() 并回到 READY：不推进轨道进度、无计分。
   */
  console.info('[基座] === M8 高空环游预热开始（不计入验收）===');
  const warmTrain = attractionManager.activate(TRAIN_KEY);
  sceneManager.renderOnce();
  warmTrain.warmUp();
  sceneManager.renderOnce();
  const trainWarmupPeak = readMemory();
  attractionManager.deactivate();
  sceneManager.renderOnce();
  console.info('[基座] === M8 高空环游预热结束 ===');
  console.log('[基座] 中间计数（M8 后，仅参考）=', readMemory(), '| M8 预热峰值 =', trainWarmupPeak);

  /* ---------- ④-e M5a Lobby 预热（硬性约束） ----------
   * 激活 Lobby → renderOnce() 上传全部新材质 → 记录「此时基线」
   * → deactivate() → renderOnce() → 正式激活 Lobby。
   */
  console.info('[基座] === Lobby 预热开始（不计入验收）===');
  attractionManager.activate(LOBBY_KEY);
  // 渐变星光天穹 / 暗色反光广场 / 发光拱门方块招牌 / 摩天轮 / 金币长廊 /
  // 触发圆环，以及【阴影贴图】全部在这一帧完成 shader 编译与纹理上传。
  sceneManager.renderOnce();
  baseline = readMemory(); // ← 本次会话基线（Lobby 激活态）
  const lobbyWarmupPeak = { ...baseline };
  attractionManager.deactivate();
  sceneManager.renderOnce();
  emptyBaseline = readMemory(); // 空场景基线，仅供「卸载测试」日志对照
  console.info('[基座] === Lobby 预热结束 ===');
  console.log('[基座] 本次会话基线（Lobby 激活态）=', baseline,
    '| 空场景基线 =', emptyBaseline, '| 冷基线（仅参考）=', coldBaseline);

  /* ---------- ⑤ 正式激活 Lobby 并打印初始计数 ---------- */
  attractionManager.activate(ACTIVE_KEY);
  sceneManager.renderOnce();
  logMemory(`初始（${projectName(ACTIVE_KEY)} 已激活）`);

  /* ---------- ⑥ 悬浮 UI ---------- */
  uiManager.init({
    onDeactivate: () => {
      audioManager.playClick();
      if (!attractionManager.active) {
        console.warn('[基座] 当前没有激活的项目，无需卸载。');
        return;
      }
      // 严格走 AttractionManager.deactivate()：dispose → registry.disposeAll → scene.remove
      attractionManager.deactivate();
      sceneManager.renderOnce();
      switchCount += 1;
      logMemory(`卸载后（第 ${switchCount} 次切换）`, emptyBaseline);
      setDebugPanel(`基座状态: 已卸载 · 累计 ${switchCount} 次切换`, { showUnload: true });
    },
    onReactivate: () => {
      audioManager.playClick();
      attractionManager.activate(ACTIVE_KEY);
      sceneManager.renderOnce();
      logMemory('重新激活后');
      setDebugPanel(`基座状态: ${projectName(ACTIVE_KEY)}运行中`, { showUnload: false });
    },
  });
  setDebugPanel(`基座状态: ${projectName(ACTIVE_KEY)}运行中`, { showUnload: false });

  /* ---------- ⑦ 预热完成：只有用户已在开始页点「进入」时才启动渲染循环 ---------- */
  bootReady = true;
  if (startRequested) {
    startScreen.hide();
    startGameplayLoop();
    console.info('[开始页] 预热完成，已进入游乐场');
  } else {
    console.info('[基座] 预热完成，等待开始页点击进入…');
  }

  /* ---------- ⑧ 控制台调试句柄 ---------- */
  window.__playground = {
    sceneManager,
    physicsManager,
    interactionManager,
    uiManager,
    attractionManager,
    audioManager,
    get startScreen() { return startScreen; },
    startGameplayLoop,
    logMemory,
    onEnterAttraction: baseCtx.onEnterAttraction,
    onExitAttraction: baseCtx.onExitAttraction,
    get baseline() { return baseline; },
    get emptyBaseline() { return emptyBaseline; },
    get lobbyWarmupPeak() { return lobbyWarmupPeak; },
    get m4WarmupPeak() { return m4WarmupPeak; },
    get memoryWarmupPeak() { return memoryWarmupPeak; },
    get bounceWarmupPeak() { return bounceWarmupPeak; },
    get trainWarmupPeak() { return trainWarmupPeak; },
    get switchCount() { return switchCount; },
    get roundTripCount() { return roundTripCount; },
  };
  console.info('[基座] 初始化完成。可用 window.__playground 手动验收 5 轮来回切换。');
}

bootstrap().catch((err) => {
  console.error('[基座] 初始化失败，已停止：', err);
  // 初始化失败时收起开始页，让错误状态面板可见；此时渲染循环不会启动
  startScreen?.hide();
  setDebugPanel('基座状态: 初始化失败，请查看控制台', { showUnload: true });
});
