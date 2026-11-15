/**
 * ============================================================================
 * main.js —— 全站唯一入口（M6 开始页 + 音频 / v4 T01 冷启动 + T03 一体化基座）
 * ============================================================================
 * 顺序：创建并显示开始页（纯 DOM，循环之外） → 装配 SceneContext 世界骨架
 *       → await 物理初始化 → 装配各管理器（注入 onEnter/onExit 回调）→ 注册全部项目
 *       → 装配 FacilityRuntime + 注册嵌入视图 → 全局单例 init + warmUp
 *       → 【仅 Lobby】预热一次并固化会话基线（不再 dispose 重建）
 *       → 悬浮 UI → 等待开始页「进入」→ 启动渲染循环。
 *
 * 【v4 T03 + T04b：双层契约 + 相机即视图】
 * onEnterAttraction/onExitAttraction 按 EMBEDDED_KEYS 分流：
 *  - 嵌入设施（demo-embed / ferris-wheel，后续木马/海盗船/跳一跳）：
 *    FacilityRuntime 只把唯一相机 blend 到锚点，Lobby 根节点与天空/NPC 全程常驻；
 *    大厅「南瓜摩天轮」触发环发 pumpkin-thrower，由 TRIGGER_KEY_ALIASES
 *    归一化为 ferris-wheel → 进真实轮盘座舱，而非旧独立投篮场景。
 *  - 独立设施（跑酷 / 记忆翻牌等玩法类）：仍走 AttractionManager 原路径
 *    （activate 会 deactivate Lobby），符合用户「跑酷除外」的明确要求。
 * 全程只有一个 THREE.Scene；嵌入视图禁止 new Scene / 改 background/fog。
 * 后台预热队列对 EMBEDDED_KEYS（含 pumpkin-thrower）整体跳过，绝不误卸大厅。
 *
 * 【v4 T01：只预热 Lobby + 全局单例，其余 10 个设施改为懒激活】
 * 旧方案串行预热 10 个设施（每个 activate / warmUp / deactivate + 3~4 次
 * renderOnce），主链路 renderOnce 高达 35 次，每次都走完整 EffectComposer
 * （RenderPass + UnrealBloomPass + OutputPass）的 shader 编译 / 纹理上传。
 * 现在删除全部 10 个设施预热块，并砍掉 Lobby 的 dispose + 二次构建：
 * 冷启动只 activate 一次 Lobby 就直接作为正式大厅，主链路 renderOnce 降到
 * 3 次（冷基线 1 + 全局单例 1 + Lobby 1）。
 *
 * 【emptyBaseline 延迟校准】
 * 全局单例后（A 点）读到的纯空场是 5 几何 / 17 纹理，但 Lobby 首帧渲染会
 * 惰性上传 1 几何 / 1 纹理常驻资源，真实卸载态是 6/18 —— A 点值不可冒充
 * 卸载基线。因此 emptyBaseline 启动时为 null，首次真实 onDeactivate 才用
 * readMemory() 精确覆盖；A 点值只存入 emptyBaselinePre 作内部诊断，
 * logMemory 在未校准时只报绝对值、绝不输出假 Δ0/0 或假泄漏。
 *
 * 【稳态基线校准（循环第 3 帧）】
 * 预热帧读到的 baseline 会漏掉惰性上传的常驻纹理（天空 / 星空 / bloom /
 * 材质），导致后续 logMemory 把 9 张纹理误报为「泄漏」。因此循环启动后的
 * 第 3 个【已渲染帧】用 readMemory() 覆盖 baseline；emptyBaseline 仍保持 null
 * 直到首次真实卸载才以实测空场景计数精确校准（此前 logMemory 只报绝对值）。
 *
 * 【后台分帧预热（稳态校准之后才启动）】
 * 用 requestIdleCallback（不支持则 setTimeout 分片）逐个预热非 Lobby 设施，
 * 每次之间强制让出 ≥1 帧；用户不在大厅时整体暂停，避免重建其正在游玩的设施。
 * 用户主动进入过的设施登记到 prewarmedKeys，后台队列跳过，杜绝重复工作。
 *
 * 【开始页与循环】预热只用 renderOnce()，绝不在开始页背后跑 rAF：
 *   startGameplayLoop() 同时要求 startRequested && bootReady，且 loopStarted、
 *   SceneManager._running 双重幂等，因此不会黑屏、也不会双循环。
 *
 * 【为什么每处都要强制 renderOnce()】
 * Three.js 的 GPU 资源是惰性上传的：新建 geometry / texture 时它们只是 JS 对象，
 * 只有在真正渲染（经 SceneManager 的 EffectComposer）时才会创建 WebGL 缓冲与纹理，
 * renderer.info.memory 统计的正是「已上传的对象数」。
 *
 * 【M5a 基线口径】
 * 本阶段验收对象是「大厅 → 小游戏 → 大厅」的来回切换：起点与终点都是
 * 【大厅激活态】，因此基线取【循环启动后第 3 帧的稳态】大厅激活态计数
 * （预热帧只是占位，惰性纹理上传完毕后才在稳态帧固化），而非空场景。
 * 另记录 emptyBaseline（空场景）供左上角「卸载测试」日志对照：启动为 null，
 * 首次真实卸载时以实测值精确复校准，未校准前 logMemory 只报绝对值。
 * 注意：基线里的 textures 含 three r187 的 dfgLUT 内部纹理，不是泄漏。
 * ============================================================================
 */

import './style.css';
import sceneManager from './core/scene-manager.js';
import physicsManager from './core/physics-manager.js';
import interactionManager from './core/interaction-manager.js';
import uiManager from './core/ui-manager.js';
import audioManager from './core/audio-manager.js';
import modelLoader from './utils/loaders/model-loader.js';
import StartScreen from './components/start-screen.js';
import attractionManager from './core/attraction-manager.js';
import sceneContext from './core/scene-context.js';
import facilityRuntime from './core/facility-runtime.js';
import { DemoEmbedView, DEMO_EMBED_KEY } from './components/embedded-views/demo-embed-view.js';
import { FerrisWheelEmbedView, FERRIS_WHEEL_KEY } from './components/embedded-views/ferris-wheel-embed-view.js';
import { JumpJumpEmbedView, JUMP_JUMP_KEY } from './components/embedded-views/jump-jump-embed-view.js';
import { DummyAttraction } from './scenes/attractions/dummy-attraction.js';
import { PumpkinThrower } from './scenes/attractions/pumpkin-thrower.js';
import { ParkourRun } from './scenes/attractions/parkour-run.js';
import { MemoryMatch } from './scenes/attractions/memory-match.js';
import { JumpJump } from './scenes/attractions/jump-jump.js';
import { TrainRide } from './scenes/attractions/train-ride.js';
import { Carousel } from './scenes/attractions/carousel.js';
import { PirateShip } from './scenes/attractions/pirate-ship.js';
import { Lobby } from './scenes/lobby-scene.js';
import { FireworksDeck } from './scenes/attractions/fireworks-deck.js';
import { CenturyClock } from './scenes/attractions/century-clock.js';
import { dayNightCycle } from './utils/helpers/day-night-cycle.js';
import { fireworkSystem } from './utils/helpers/particle-system.js';
import { npcManager } from './utils/helpers/npc-manager.js';
/* 【六项升级】移动双模式 / 渲染优化 / 区域标签 / lil-gui 调试面板 */
import { movementMode } from './components/controllers/movement-mode-manager.js';
import { renderOptimizer } from './core/render-optimizer.js';
import { districtLabels } from './components/labels/district-labels.js';
import { debugPanel } from './components/debug-panel.js';

/** M2 预热桩：仅用于渲染器预热，保证 dfgLUT 等内部资源就绪 */
const DUMMY_KEY = 'dummy';
/** M3 项目：投掷类「南瓜投手」（大厅「南瓜摩天轮」可进入） */
const PUMPKIN_KEY = 'pumpkin-thrower';
/** M4 项目（v3 模块1）：三轨道跑酷「极限跑酷」（大厅「跑酷跑道」可进入） */
const PARKOUR_KEY = 'parkour-run';
/** M5b 项目：记忆类「记忆翻牌」（大厅「魔法牌屋」可进入） */
const MEMORY_KEY = 'memory-match';
/** M7 项目（v3 模块2）：复刻「跳一跳」（大厅「跳跳乐」可进入） */
const JUMP_KEY = 'jump-jump';
/** M8 项目：观景类「高空环游」（大厅「小火车站台」可进入） */
const TRAIN_KEY = 'train-ride';
/** M9 项目：观赏类「旋转木马」 */
const CAROUSEL_KEY = 'carousel';
/** M9 项目：身临其境观赏类「海盗船」（三档座位，无金币计分） */
const PIRATE_KEY = 'pirate-ship';
/** 模块 7 项目：烟花观礼台（大厅「烟花观礼台」可进入） */
const FIREWORKS_KEY = 'fireworks-deck';
/** 模块 8 项目：天津世纪钟（大厅中央地标，可进入近距离观赏） */
const CLOCK_KEY = 'century-clock';
/** M5a 项目：可漫游的游乐场大厅 */
const LOBBY_KEY = 'lobby';
/** 当前正式激活的项目 */
const ACTIVE_KEY = LOBBY_KEY;

/**
 * 【v4 T03】嵌入设施 key 集合：这些设施全程仍在同一大厅场景里，进入时
 * 只由 FacilityRuntime 换相机机位，绝不 deactivate Lobby / 卸掉大厅根节点。
 * T04b 起接入真实摩天轮；T07(木马/海盗船/小火车)/T08(跳一跳) 后续在此登记。
 */
const EMBEDDED_KEYS = new Set([
  DEMO_EMBED_KEY,
  FERRIS_WHEEL_KEY,
  JUMP_JUMP_KEY,
  // 【T04b】legacy 触发环 key 也登记为「嵌入态」： FACILITIES[0] 仍发
  // 'pumpkin-thrower'，实际进入由 TRIGGER_KEY_ALIASES 归一化到 FERRIS_WHEEL_KEY。
  // 登记此 key 的关键目的：让 ④⑤ 后台预热队列对它真正跳过，绝不再构建旧
  // PumpkinThrower 投篮场景（用户明确「不要什么投的、金币啥的都不用」）。
  // 旧 PumpkinThrower 仍保留注册，仅供 attractionManager 直接激活的兼容路径。
  PUMPKIN_KEY,
]);

/**
 * 【v4 T04b】Lobby 触发环兼容映射。
 * Lobby.js 的 FACILITIES[0] 触发环仍发 PUMPKIN_KEY（'pumpkin-thrower'，标签「南瓜摩天轮」），
 * 而 Lobby.js 属他人文件（T06/T02），本任务不改它。这里把该 key 重定向到真实
 * 摩天轮嵌入视图 FERRIS_WHEEL_KEY：用户在广场点「南瓜摩天轮」环 → 进座舱俯瞰大厅，
 * 而不是进入旧的独立投篮场景。旧独立 PumpkinThrower 仍保留注册（且不删 any key），
 * 但不再作为大厅入口；如需直接进入旧投篮玩法可用
 * window.__playground.attractionManager.activate('pumpkin-thrower')。
 */
const TRIGGER_KEY_ALIASES = Object.freeze({ [PUMPKIN_KEY]: FERRIS_WHEEL_KEY });

/** 项目显示名映射：调试面板动态读取，不写死任何里程碑 / 项目名 */
const PROJECT_NAMES = Object.freeze({
  [DUMMY_KEY]: 'M2 预热桩',
  [PUMPKIN_KEY]: '南瓜投手',
  [PARKOUR_KEY]: '极限跑酷',
  [MEMORY_KEY]: '记忆翻牌',
  [JUMP_KEY]: '跳一跳',
  [TRAIN_KEY]: '高空环游',
  [CAROUSEL_KEY]: '旋转木马',
  [PIRATE_KEY]: '海盗船',
  [FIREWORKS_KEY]: '烟花观礼台',
  [CLOCK_KEY]: '世纪钟',
  [FERRIS_WHEEL_KEY]: '南瓜摩天轮',
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

/** 本次会话基线（M5a = Lobby 激活态计数） */
let baseline = { geometries: 0, textures: 0 };
/**
 * 卸载后空场景基线。启动时为 null（尚无真实卸载态可测），首次真实
 * onDeactivate 时用 readMemory() 精确覆盖。绝不拿 A 点诊断值 emptyBaselinePre
 * 冒充，否则「卸载测试」日志会误报 +1/+1 假泄漏（实测两者就差 1 几何/1 纹理）。
 * @type {{geometries: number, textures: number}|null}
 */
let emptyBaseline = null;
/** A 点诊断量：全局单例后、Lobby 首帧前的纯空场计数，仅供内部诊断 */
let emptyBaselinePre = null;
let switchCount = 0;
let roundTripCount = 0;

function readMemory() {
  const { geometries, textures } = sceneManager.renderer.info.memory;
  return { geometries, textures };
}

/**
 * 打印资源计数，并与指定参照基线对比（默认用本次会话基线）。
 * 【卸载基线未校准】ref === null 时只报绝对值、不做差值判定：绝不拿 A 点
 * 诊断值冒充卸载基线，避免打印基于错误参照的假 Δ0/0 或假泄漏。
 */
function logMemory(tag, ref = baseline) {
  const current = readMemory();
  if (ref === null) {
    console.log(
      `%c[资源计数] ${tag}`,
      'color:#7fd1ff;font-weight:bold',
      `\n  geometries = ${current.geometries}  (卸载基线待首次卸载校准，本次仅报绝对值)` +
        `\n  textures   = ${current.textures}` +
        `\n  是否回落至基线: 未判定`,
      current
    );
    return current;
  }
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
/* v4 T01 收尾：稳态基线校准 + 后台分帧预热                                   */
/* ========================================================================== */

/**
 * 设施切换时同步全局昼夜/烟花的生效上下文。
 * 【v4 T03】嵌入视图虽有自己的 key（如 demo-embed），但相机仍在大厅场景里，
 * 天空 / NPC / 烟花必须继续可见 → 统一映射成 LOBBY_KEY 给三个全局单例。
 * 这样也避免改 NPCManager.js / ParticleSystem.js（它们是其它工程师的文件），
 * 它们的白名单只认 'lobby' / 'fireworks-deck'。DayNightCycle 另外也登记了
 * 嵌入 key，双重保险。
 */
function syncGlobalContext(key) {
  // 触发环别名（pumpkin-thrower → ferris-wheel）统一在这里收敛，
  // 保证「旧 key 进入」与「新 key 进入」得到完全相同的昼夜上下文。
  const normalizedKey = TRIGGER_KEY_ALIASES[key] ?? key;
  const effectiveKey = EMBEDDED_KEYS.has(normalizedKey) ? LOBBY_KEY : normalizedKey;
  dayNightCycle.setContext(effectiveKey);
  fireworkSystem.setContext(effectiveKey);
  npcManager.setContext(effectiveKey);
}

/**
 * 已预热的设施 key 集合。用户主动进入过的设施也登记进来，后台队列因此跳过
 * 重复预热；prewarm() 内部 activate→renderOnce→deactivate→renderOnce 虽幂等，
 * 但重复执行会多花一次 GPU 上传且短暂占用主线程，避免无谓工作。
 * @type {Set<string>}
 */
const prewarmedKeys = new Set();

/** 后台分帧预热队列是否全部完成（供 window.__playground 与验收脚本读取） */
let backgroundPrewarmDone = false;
/** 稳态基线是否已校准（循环第 3 帧后） */
let baselineCalibrated = false;
/** 空场景基线是否已在首次真实卸载时精确校准 */
let emptyBaselineCalibrated = false;
/** prewarm 重入闸门（同步流程本不会并发，留作防御） */
let prewarmInFlight = false;

/**
 * 按需预热单个设施（调试 / 后台队列 / 未来 FacilityRuntime 共用）。
 * 固定四步：activate(key) → renderOnce() → deactivate() → renderOnce()。
 * 若调用前已有激活设施（含大厅），结束时原样恢复，避免留下空场景。
 * @param {string} key 已注册的设施 key
 * @returns {boolean} 是否成功完成；已有预热在进行时返回 false
 */
function prewarmFacility(key) {
  if (!attractionManager.keys.includes(key)) {
    console.warn(`[基座] prewarm: 未注册的项目「${key}」`);
    return false;
  }
  if (EMBEDDED_KEYS.has(key)) {
    // 嵌入视图全程共享大厅场景，没有独立的 AttractionManager 资源可上传；
    // 走 activate 反而会误卸大厅。其 GPU 资源（若有）由 IEmbeddedView 首次
    // activate 时自建，且常驻 propsRoot 计入基线，无需冷启动预热。
    console.info(`[基座] prewarm("${key}")：嵌入视图共享大厅，跳过 AttractionManager 预热`);
    return true;
  }
  if (facilityRuntime.isEmbeddedActive) {
    // 【T04b】正在嵌入设施里时，任何独立设施的 activate 都会 dispose Lobby，
    // 直接拒绝本次手动预热调用（后台队列另有 isEmbeddedActive 暂停闸门）。
    console.warn(`[基座] prewarm("${key}")：当前在嵌入视图中，跳过以免卸载大厅`);
    return false;
  }
  if (prewarmInFlight) {
    console.warn(`[基座] prewarm("${key}")：已有预热在进行，跳过本次`);
    return false;
  }
  prewarmInFlight = true;
  const previousKey = attractionManager.activeKey;
  if (previousKey === key) {
    console.info(`[基座] prewarm("${key}")：该项目已激活，无需预热`);
    prewarmInFlight = false;
    return true;
  }
  try {
    attractionManager.activate(key);
    sceneManager.renderOnce();
    attractionManager.deactivate();
    sceneManager.renderOnce();
    console.info(`[基座] prewarm("${key}") 完成`);
    return true;
  } catch (err) {
    console.error(`[基座] prewarm("${key}") 失败：`, err);
    try { attractionManager.deactivate(); sceneManager.renderOnce(); } catch (e2) {
      console.warn('[基座] prewarm 异常清理失败（可忽略）：', e2);
    }
    return false;
  } finally {
    // 调用前若有激活设施（含大厅），预热后原样恢复，避免留下空场景
    if (previousKey && attractionManager.activeKey === null) {
      try {
        attractionManager.activate(previousKey);
        syncGlobalContext(previousKey);
        sceneManager.renderOnce();
      } catch (e3) {
        console.warn(`[基座] prewarm 恢复「${previousKey}」失败：`, e3);
      }
    }
    prewarmInFlight = false;
  }
}

/**
 * 把一次性空闲任务交给浏览器：优先 requestIdleCallback（2s 超时兜底，
 * 避免主线程持续繁忙时队列饿死），不支持则退化为 setTimeout 分片。
 * @param {Function} task 空闲时执行的回调
 * @returns {number} 可用于取消的句柄
 */
function scheduleIdle(task) {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(task, { timeout: 2000 });
  }
  return window.setTimeout(
    () => task({ didTimeout: true, timeRemaining: () => 16 }),
    32
  );
}

/**
 * 后台分帧预热的设施顺序：观赏类优先（大厅里最常进入），玩法类随后，
 * M2 预热桩与南瓜投手最后。全部 10 个非 Lobby 注册项都覆盖。
 * 【T04b】PUMPKIN_KEY 现在也在 EMBEDDED_KEYS（大厅触发环已改走嵌入摩天轮），
 * prewarmFacility 会在 EMBEDDED_KEYS 分支直接跳过它——绝不构建旧投篮场景、
 * 不 dispose Lobby。故队列仍列 10 项，但实际只预热 9 个独立设施。
 * 若某设施预热抛错会被跳过，不影响队列继续推进。
 */
const BACKGROUND_PREWARM_KEYS = Object.freeze([
  CAROUSEL_KEY, PIRATE_KEY, JUMP_KEY, TRAIN_KEY, CLOCK_KEY,
  FIREWORKS_KEY, MEMORY_KEY, PARKOUR_KEY, PUMPKIN_KEY, DUMMY_KEY,
]);

/**
 * 循环启动 + 稳态基线校准之后，用空闲时间逐个预热非 Lobby 设施。
 * - 每次之间强制让出 ≥1 帧（rAF → idle），不阻塞用户操作；
 * - 用户不在大厅（activeKey !== lobby，含进入设施 / 点了卸载）时整体暂停，
 *   避免 prewarm 的 activate/deactivate 重建玩家正在游玩的设施、丢失状态；
 * - 已预热 / 用户已进入过的设施由 prewarmedKeys 跳过。
 */
function startBackgroundPrewarm() {
  let index = 0;
  const step = () => {
    // 【T04b】嵌入视图下 attractionManager.activeKey 仍是 'lobby'（大厅没被卸），
    // 但此时 prewarm 的 activate/deactivate 会把 Lobby dispose 掉、让座舱失去共享轮盘，
    // 所以必须把「嵌入态」也纳入暂停条件。600ms 后重试，不抢占游玩状态。
    if (attractionManager.activeKey !== LOBBY_KEY || facilityRuntime.isEmbeddedActive) {
      window.setTimeout(step, 600);
      return;
    }
    while (index < BACKGROUND_PREWARM_KEYS.length &&
           prewarmedKeys.has(BACKGROUND_PREWARM_KEYS[index])) {
      index += 1;
    }
    if (index >= BACKGROUND_PREWARM_KEYS.length) {
      backgroundPrewarmDone = true;
      console.info(`[基座] 后台分帧预热完成（${prewarmedKeys.size}/${BACKGROUND_PREWARM_KEYS.length}）`);
      return;
    }
    const key = BACKGROUND_PREWARM_KEYS[index];
    index += 1;
    try {
      if (prewarmFacility(key)) prewarmedKeys.add(key);
    } catch (err) {
      console.warn(`[基座] 后台预热「${key}」失败（已跳过）：`, err);
    }
    // 先让出 1 帧，再排下一次空闲任务，保证两次预热之间 ≥1 帧
    requestAnimationFrame(() => scheduleIdle(step));
  };
  scheduleIdle(step);
}

/**
 * 稳态基线校准：循环启动后的第 3 个【已渲染帧】读 baseline。
 * 用独立 rAF 链，注册在 sceneManager.start() 之后，因此每次回调都发生在
 * SceneManager.loop() 的 composer.render() 之后；此时惰性纹理（天空 / 星空 /
 * bloom / 材质）已上传完毕，读到的是真正的稳态会话基线。
 * 若用户抢先进入设施则推迟校准，避免在设施态读到错误计数。
 */
function scheduleSteadyBaselineCalibration() {
  let renderedFrames = 0;
  const onFrame = () => {
    if (attractionManager.activeKey !== LOBBY_KEY) {
      requestAnimationFrame(onFrame);
      return;
    }
    renderedFrames += 1;
    if (renderedFrames < 3) {
      requestAnimationFrame(onFrame);
      return;
    }
    const steady = readMemory();
    // 启动帧 → 稳态帧新增的资源（惰性上传），多为常驻全局纹理（天空 / 星空 /
    // bloom）。emptyBaseline 保持 null 直到首次真实卸载才能给出可信值；
    // 若此前已发生过卸载（极端时序），才把这份常驻增量同步过去。
    const lazyDelta = {
      geometries: steady.geometries - baseline.geometries,
      textures: steady.textures - baseline.textures,
    };
    baseline = steady;
    if (emptyBaselineCalibrated) {
      emptyBaseline = {
        geometries: Math.max(0, emptyBaseline.geometries + lazyDelta.geometries),
        textures: Math.max(0, emptyBaseline.textures + lazyDelta.textures),
      };
    }
    baselineCalibrated = true;
    console.info('[基座] 稳态基线已校准（循环第 3 帧）', {
      baseline, emptyBaseline, lazyDelta,
    });
    logMemory('稳态基线校准后');
    // 必须在稳态基线校准之后启动，避免预热资源污染初始 baseline 判定
    startBackgroundPrewarm();
  };
  requestAnimationFrame(onFrame);
}

/* ========================================================================== */
/* 开始页与音频（M6 接入）                                                    */
/* ========================================================================== */

/**
 * 开始页显示期间【不启动渲染循环】：场景只做 bootstrap 用的 renderOnce()，
 * 真正跑起来必须同时满足「用户点了进入」+「基座就绪（bootReady）」。
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
  // 独立 rAF 链排在本 start() 注册的 loop 之后：第 3 个已渲染帧校准稳态基线，
  // 校准完成后才启动后台分帧预热队列（避免预热资源污染初始 baseline）。
  scheduleSteadyBaselineCalibration();
  console.info('[基座] 渲染循环已启动（用户在开始页确认进入后）');
}

/**
 * 开始页：纯 DOM / CSS，在 WebGL 循环之外。
 * 点击进入后才 hide()，若此时基座尚未就绪（bootReady=false）则保持覆盖，
 * 等 bootstrap 完成后自动进入，避免露出未完成的画面（黑屏 / 半成品帧）。
 * T01 后就绪通常在数百毫秒内，但这里不承诺「瞬时」，只保证不黑屏。
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
      console.info('[开始页] 已确认进入，场景就绪后自动进入…');
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
  // 【六项升级】成对释放：Sprite 标签 / 调试面板 / 双模式控制器
  try { districtLabels.dispose(); } catch (err) { console.warn('[六项升级] 标签释放失败：', err); }
  try { debugPanel.dispose(); } catch (err) { console.warn('[六项升级] 面板释放失败：', err); }
  try { movementMode.dispose(); } catch (err) { console.warn('[六项升级] 移动控制器释放失败：', err); }
};
window.addEventListener('pagehide', onPageHide);

async function bootstrap() {
  const bootStartedAt = performance.now();

  /* ---------- ⓪ v4 T01：注入唯一世界骨架（SceneContext） ----------
   * worldRoot / propsRoot 是空 THREE.Group，不建 geometry / texture，
   * 因此不改变 renderer.info.memory 基线；也不打 attractionRoot 标记，
   * 不会被 AttractionManager.deactivate() 误删。T03 一体化基座在此地基上挂设施。 */
  sceneContext.configure({
    scene: sceneManager.scene,
    camera: sceneManager.camera,
    renderer: sceneManager.renderer,
  });
  console.info('[基座] SceneContext 世界骨架已注入（worldRoot / propsRoot / facilityAnchors）');

  /* ---------- ⓪-b 【六项升级】全局装配 ----------------------------------
   * 必须在 Lobby 预热（④-b 读取 baseline）之前创建常驻资源，让它们的 GPU
   * 上传计入会话基线，保证 v4⑬ / redline 的稳态 Δ0/0 口径不变。
   * - districtLabels：3 个 Sprite 文字标签（城堡屋 / 农家乐 / 动物园）
   * - movementMode：双模式互斥状态机 + BVH 碰撞（闭包延迟读取 active Lobby）
   * - renderOptimizer：LOD 高模 / mipmap / 包围体修正
   * - debugPanel：lil-gui 毛玻璃调试面板（纯 DOM，零 GPU 资源）
   */
  districtLabels.build(sceneManager.scene, sceneManager.renderer);
  movementMode.configure({
    camera: sceneManager.camera,
    domElement: sceneManager.renderer.domElement,
    getObstacles: () => attractionManager.active?._buildingBoxes || [],
    getContext: () => ({
      activeKey: attractionManager.activeKey,
      embedded: !!facilityRuntime.isEmbeddedActive,
    }),
  }).attach().buildHUD();
  renderOptimizer.configure({
    scene: sceneManager.scene,
    renderer: sceneManager.renderer,
  });
  console.info('[六项升级] 全局装配完成：Sprite 标签 / 双模式移动 / 渲染优化');

  audioManager.init({ volume: 0.7 });
  modelLoader.init(); // 第四部分：glTF/DRACO 单例就绪（资产缺失时设施走程序化占位）

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
    /** 供项目查询基座暂停闸门；定时器回调据此避免在冻结期改动物理世界 */
    isPaused: () => sceneManager.paused,

    /**
     * 【v4 T03】大厅 → 设施，按 isEmbedded 分流：
     *  - 嵌入设施（EMBEDDED_KEYS）：FacilityRuntime 只换相机机位，Lobby 根节点常驻，
     *    AttractionManager.activeKey 保持 'lobby'（这是「不割裂」的硬证据）；
     *  - 独立设施（跑酷 / 记忆翻牌等玩法类）：走原 AttractionManager 路径，
     *    activate() 内部会先 deactivate Lobby，dispose 并把 orbit 机位写入 _lobbyMemory。
     */
    onEnterAttraction: (key) => {
      // 【T04b】Lobby 触发环兼容：pumpkin-thrower → ferris-wheel（嵌入摩天轮）
      const resolvedKey = TRIGGER_KEY_ALIASES[key] ?? key;
      const isEmbedded = EMBEDDED_KEYS.has(resolvedKey);
      if (!isEmbedded && !attractionManager.keys.includes(resolvedKey)) {
        console.warn(`[基座] 未注册的项目：${key}`);
        return;
      }
      audioManager.playClick();
      setDebugPanel(`基座状态: ${projectName(resolvedKey)}运行中`, { showUnload: true });

      if (isEmbedded) {
        facilityRuntime.activate(resolvedKey);
        prewarmedKeys.add(resolvedKey);
        syncGlobalContext(resolvedKey);
        sceneManager.setPaused(false);
        console.info(`[基座] 进入嵌入视图「${projectName(resolvedKey)}」，大厅常驻、仅相机切换`);
      } else {
        // 若当前停在嵌入视图，先干净退出（相机回大厅、控制权交还），
        // 否则 embedded activeView 会残留并被 frameDriver 继续驱动。
        if (facilityRuntime.isEmbeddedActive) {
          facilityRuntime.deactivate();
        }
        attractionManager.activate(resolvedKey);
        prewarmedKeys.add(resolvedKey);
        syncGlobalContext(resolvedKey);
        sceneManager.setPaused(false);
        sceneManager.renderOnce();
        console.info(`[基座] 进入独立设施「${projectName(resolvedKey)}」，Lobby 已 dispose 并存档`);
      }
    },

    /**
     * 【v4 T03】设施 → 大厅，同样按 isEmbedded 分流：
     *  - 嵌入态：FacilityRuntime.deactivate() 让相机 0.8s 平滑回大厅原机位，
     *    **不重建 Lobby**（Lobby 从未被卸载），也没有 renderOnce / Δ 波动；
     *  - 独立态：原路径重建 Lobby，init() 从 _lobbyMemory 恢复 orbit 机位。
     */
    onExitAttraction: () => {
      audioManager.playClick();
      setDebugPanel(`基座状态: ${projectName(LOBBY_KEY)}运行中`, { showUnload: false });

      // 已在大厅态且无嵌入视图：no-op，避免 AttractionManager 重复构建 Lobby
      if (attractionManager.activeKey === LOBBY_KEY && !facilityRuntime.isEmbeddedActive) {
        console.info('[基座] 已在大厅态且无嵌入视图，退出为 no-op（避免重复构建 Lobby）');
        return;
      }
      if (facilityRuntime.isEmbeddedActive) {
        facilityRuntime.deactivate();
        syncGlobalContext(LOBBY_KEY);
        sceneManager.setPaused(false);
        roundTripCount += 1;
        logMemory(`返回大厅（第 ${roundTripCount} 轮来回 · 嵌入视图）`);
        console.info('[基座] 已退出嵌入视图，相机平滑回大厅（Lobby 根节点全程未卸载）');
      } else {
        attractionManager.activate(LOBBY_KEY);
        syncGlobalContext(LOBBY_KEY);
        sceneManager.setPaused(false);
        sceneManager.renderOnce();
        roundTripCount += 1;
        logMemory(`返回大厅（第 ${roundTripCount} 轮来回）`);
        console.info('[基座] 已返回大厅，orbit 机位与目标点由 _lobbyMemory 恢复');
      }
    },
  };

  /* ---------- ③-a 模块 7 全局单例：昼夜 + 烟花 ----------
   * 必须在【Lobby 预热 renderOnce 之前】init：太阳/月亮/星空 root 与粒子 Points
   * 常驻 scene（不属于任何设施），紧接着的 renderOnce() 会把它们的 GPU 资源
   * 上传并计入本次会话基线，保证来回切换 Δ0/0。
   * 灯光引用直接取 SceneManager 的三盏常驻灯，昼夜系统保存完整快照后接管。
   */
  dayNightCycle.init({
    scene: sceneManager.scene,
    renderer: sceneManager.renderer,
    camera: sceneManager.camera,
    bloomPass: sceneManager.bloomPass,
    lights: {
      ambient: sceneManager.ambientLight,
      hemisphere: sceneManager.hemisphereLight,
      directional: sceneManager.directionalLight,
    },
  });
  fireworkSystem.init({
    scene: sceneManager.scene,
    camera: sceneManager.camera,
    renderer: sceneManager.renderer,
  });
  npcManager.init({ scene: sceneManager.scene, camera: sceneManager.camera });
  dayNightCycle.warmUp();    // 临时点亮全部天体 → 一次性上传所有几何（不可删，否则夜间星空首帧缺失）
  sceneManager.renderOnce(); // 上传全局单例资源 → 计入基线
  dayNightCycle.applyImmediate(); // 复原正常可见性（此后每帧 update 接管）
  window.addEventListener('resize', () => fireworkSystem.resize());

  /* 全局单例 + FacilityRuntime 每帧驱动：SceneManager 循环只调 attractions.update(dt)。
   * 用包装对象把四者串起来，零 core 改动；仍在 SceneManager 的暂停闸门内，
   * 因此暂停时昼夜/烟花/相机过渡一起冻结，符合既有约定。 */
  const frameDriver = {
    update(dt) {
      attractionManager.update(dt);
      facilityRuntime.update(dt);
      dayNightCycle.update(dt);
      fireworkSystem.update(dt);
      npcManager.update(dt);
      // 【六项升级·阶段三】Lobby 重建后惰性重扫 LOD / 包围体 / mipmap；
      // 平时只有一次引用比较，热路径零新建 GPU 资源。
      renderOptimizer.update(attractionManager.active?.root ?? null);
    },
  };
  sceneManager.configure({ physics: physicsManager, attractions: frameDriver });
  interactionManager.init({
    renderer: sceneManager.renderer,
    camera: sceneManager.camera,
    scene: sceneManager.scene,
    attractions: attractionManager,
  });
  attractionManager.configure(baseCtx);
  attractionManager.register(DUMMY_KEY, () => new DummyAttraction());
  attractionManager.register(PUMPKIN_KEY, () => new PumpkinThrower());
  attractionManager.register(PARKOUR_KEY, () => new ParkourRun());
  attractionManager.register(MEMORY_KEY, () => new MemoryMatch());
  attractionManager.register(JUMP_KEY, () => new JumpJump());
  attractionManager.register(TRAIN_KEY, () => new TrainRide());
  attractionManager.register(CAROUSEL_KEY, () => new Carousel());
  attractionManager.register(PIRATE_KEY, () => new PirateShip());
  attractionManager.register(FIREWORKS_KEY, () => new FireworksDeck());
  attractionManager.register(CLOCK_KEY, () => new CenturyClock());
  attractionManager.register(LOBBY_KEY, () => new Lobby());

  /* ---------- ③-b v4 T03：嵌入视图运行时（唯一场景 + 相机即视图） ----------
   * DemoEmbedView 是最小闭环验证用（零 GPU 资源）；后续 T04/T07/T08 在这里
   * register 各自的真实 IEmbeddedView 并往 EMBEDDED_KEYS 里加 key 即可。 */
  facilityRuntime.configure({
    scene: sceneManager.scene,
    camera: sceneManager.camera,
    renderer: sceneManager.renderer,
    sceneContext,
    lobbyKey: LOBBY_KEY,
  });
  facilityRuntime.register(DEMO_EMBED_KEY, () => new DemoEmbedView());
  facilityRuntime.register(FERRIS_WHEEL_KEY, () => new FerrisWheelEmbedView());
  facilityRuntime.register(JUMP_JUMP_KEY, () => new JumpJumpEmbedView());
  dayNightCycle.registerEmbeddedContext(JUMP_JUMP_KEY);
  dayNightCycle.registerEmbeddedContext(DEMO_EMBED_KEY);
  dayNightCycle.registerEmbeddedContext(FERRIS_WHEEL_KEY);

  /* ---------- ④ 预热阶段整体容错：任一步失败都不连累大厅加载 ----------
   * 【v4 T01 收官】除 Lobby + 全局单例外，10 个设施已改为懒激活，且 Lobby
   * 只构建一次（不再 dispose + 重建）。主链路 renderOnce 由 35 → 3 次
   * （冷基线 1 + 全局单例 1 + Lobby 1）。首次进入某设施时才上传 GPU 资源；
   * 稳态校准完成后的后台队列会用 window.__playground.prewarm(key) 逐个预热。
   * 下方 window.__playground 的 warmupPeak getter 已恒为 null（兼容旧脚本）。
   */
  try {
    /* ---------- ④-a A 点诊断：全局单例后的纯空场（仅内部参考，不作验收基线） ----------
     * 实测此态 5 几何 / 17 纹理；Lobby 首帧会惰性上传 1 几何 / 1 纹理常驻资源，
     * 真实卸载态是 6/18。故 emptyBaseline 不在此时固化，留给首次真实卸载实测。
     */
    emptyBaselinePre = readMemory();
    console.info('[基座] A 点空场诊断基线（仅内部参考，不作卸载基线）=', emptyBaselinePre);

    /* ---------- ④-b M5a Lobby 预热（唯一一次构建，直接作为正式大厅） ----------
     * 激活 Lobby → renderOnce() 上传全部新材质 + 阴影贴图 → 记录「本次基线」。
     * 关键：这里不再 deactivate / renderOnce / 重建 —— 这是冷启动最大的可砍项。
     */
    console.info('[基座] === Lobby 预热 / 固化会话基线开始 ===');
    attractionManager.activate(LOBBY_KEY);
    // 【六项升级·阶段三】Lobby 构建完成后立刻钉死高模 LOD / 修正包围体 /
    // 统一 mipmap，随后同一帧上传 GPU（不额外增加 renderOnce 次数，保住 v4①）。
    renderOptimizer.applyNow(attractionManager.active?.root ?? null);
    // 渐变星光天穹 / 暗色反光广场 / 发光拱门方块招牌 / 摩天轮 / 金币长廊 /
    // 触发圆环，以及【阴影贴图】全部在这一帧完成 shader 编译与纹理上传。
    sceneManager.renderOnce();
    baseline = readMemory(); // ← 本次会话基线（Lobby 激活态）
    console.info('[基座] === Lobby 预热 / 固化会话基线结束 ===');
    console.log('[基座] 本次会话基线（Lobby 激活态）=', baseline,
      '| A 点空场诊断 =', emptyBaselinePre, '| 冷基线（仅参考）=', coldBaseline,
      '| 卸载基线 = null（待首次真实卸载校准）');
  } catch (warmErr) {
    // 任一步预热抛错都被隔离：绝不连累大厅加载。
    console.error('[基座] 预热阶段某步出错（已隔离，继续加载大厅）：', warmErr);
    try { attractionManager.deactivate(); sceneManager.renderOnce(); } catch (e2) {
      console.warn('[基座] 预热异常清理也失败（可忽略）：', e2);
    }
  }

  /* ---------- ⑤ 正式大厅：复用 ④-b 的唯一 Lobby 实例，不再二次构建 ----------
   * 原流程在此 deactivate → renderOnce → activate(ACTIVE_KEY) → renderOnce 会
   * 把整个 Lobby 重建一次（~30 几何 / 10+ CanvasTexture），是冷启动最大可砍项。
   * 现在用 activeKey 守卫：已激活则 no-op，绝不重复上传；其余照旧同步上下文。
   */
  if (attractionManager.activeKey !== ACTIVE_KEY) {
    attractionManager.activate(ACTIVE_KEY);
  }
  syncGlobalContext(ACTIVE_KEY);
  logMemory(`初始（${projectName(ACTIVE_KEY)} 已激活 · 启动帧口径）`);

  /* ---------- ⑥ 悬浮 UI ---------- */
  uiManager.init({
    onDeactivate: () => {
      audioManager.playClick();
      // 【v4 T03】嵌入态下「卸载测试」= 退出嵌入视图（相机回大厅），
      // 绝不能走 AttractionManager.deactivate() 卸掉常驻的 Lobby 根节点。
      // 退出后 Lobby 仍是 active，因此不进入下面的「真实卸载」分支。
      if (facilityRuntime.isEmbeddedActive) {
        facilityRuntime.deactivate();
        syncGlobalContext(LOBBY_KEY);
        sceneManager.setPaused(false);
        roundTripCount += 1;
        logMemory(`退出嵌入视图（第 ${roundTripCount} 轮来回，大厅仍常驻）`);
        setDebugPanel(`基座状态: ${projectName(LOBBY_KEY)}运行中`, { showUnload: false });
        console.info('[基座] 嵌入视图已退出，Lobby 根节点从未卸载');
        return;
      }
      if (!attractionManager.active) {
        console.warn('[基座] 当前没有激活的项目，无需卸载。');
        return;
      }
      // 严格走 AttractionManager.deactivate()：dispose → registry.disposeAll → scene.remove
      attractionManager.deactivate();
      syncGlobalContext(null); // 无设施激活 → 全局系统挂起并还原基座灯光
      sceneManager.setPaused(false);
      sceneManager.renderOnce();
      // 首次真实卸载时以实测空场景计数精确校准 emptyBaseline：A 点诊断值
      // （emptyBaselinePre）漏掉 Lobby 首帧才惰性上传的 1 几何 / 1 纹理常驻资源，
      // 所以启动期保持 null，到这里才固化为真实卸载态，杜绝假泄漏误报。
      if (!emptyBaselineCalibrated) {
        emptyBaseline = readMemory();
        emptyBaselineCalibrated = true;
        console.info('[基座] 空场景基线已在首次卸载时精确校准', emptyBaseline,
          '| A 点诊断值（未采用）=', emptyBaselinePre);
      }
      switchCount += 1;
      logMemory(`卸载后（第 ${switchCount} 次切换）`, emptyBaseline);
      setDebugPanel(`基座状态: 已卸载 · 累计 ${switchCount} 次切换`, { showUnload: true });
    },
    onReactivate: () => {
      audioManager.playClick();
      // 【T04b】嵌入视图下大厅从未卸载，无需也不能重建（重建会 dispose Lobby、
      // 让座舱失去共享轮盘）。只复位暂停闸门并提示，保留当前嵌入态。
      if (facilityRuntime.isEmbeddedActive) {
        sceneManager.setPaused(false);
        console.info('[基座] 嵌入视图中：大厅常驻，无需重新激活');
        return;
      }
      attractionManager.activate(ACTIVE_KEY);
      syncGlobalContext(ACTIVE_KEY);
      sceneManager.setPaused(false);
      sceneManager.renderOnce();
      logMemory('重新激活后');
      setDebugPanel(`基座状态: ${projectName(ACTIVE_KEY)}运行中`, { showUnload: false });
    },
  });
  setDebugPanel(`基座状态: ${projectName(ACTIVE_KEY)}运行中`, { showUnload: false });
  /* 【六项升级·阶段一/五】lil-gui 毛玻璃调试面板（默认折叠，不影响开始页） */
  debugPanel.build({ sceneManager });

  /* ---------- ⑦ 基座就绪：只有用户已在开始页点「进入」时才启动渲染循环 ---------- */
  bootReady = true;
  if (startRequested) {
    startScreen.hide();
    startGameplayLoop();
    console.info('[开始页] 已进入游乐场');
  } else {
    console.info('[基座] 场景就绪，等待开始页点击进入…');
  }

  /* ---------- ⑧ 控制台调试句柄 ---------- */
  window.__playground = {
    sceneManager,
    physicsManager,
    interactionManager,
    uiManager,
    attractionManager,
    audioManager,
    modelLoader,
    dayNightCycle,
    fireworkSystem,
    npcManager,
    sceneContext,
    facilityRuntime,
    /* 【六项升级】验收脚本用只读句柄 */
    movementMode,
    renderOptimizer,
    districtLabels,
    debugPanel,
    EMBEDDED_KEYS,
    /** T04b 验收用：真实摩天轮嵌入 key（触发环 pumpkin-thrower 归一化到它） */
    get ferrisWheelKey() { return FERRIS_WHEEL_KEY; },
    /** T04b 验收用：触发环 key → 嵌入 key 的兼容映射（只读副本） */
    get triggerKeyAliases() { return { ...TRIGGER_KEY_ALIASES }; },
    get startScreen() { return startScreen; },
    get bootReady() { return bootReady; },
    get loopStarted() { return loopStarted; },
    startGameplayLoop,
    logMemory,
    onEnterAttraction: baseCtx.onEnterAttraction,
    onExitAttraction: baseCtx.onExitAttraction,
    get baseline() { return baseline; },
    /** 卸载后空场景基线：首次真实卸载前为 null（未校准，不作任何差值参照） */
    get emptyBaseline() { return emptyBaseline; },
    /** A 点诊断量：全局单例后、Lobby 首帧前的纯空场计数，仅供内部诊断 */
    get emptyBaselinePre() { return emptyBaselinePre; },
    get baselineCalibrated() { return baselineCalibrated; },
    get emptyBaselineCalibrated() { return emptyBaselineCalibrated; },
    get backgroundPrewarmDone() { return backgroundPrewarmDone; },
    get prewarmedKeys() { return [...prewarmedKeys]; },

    /* T01 懒激活：除 Lobby 外不再预热任何设施，以下 warmupPeak 恒为 null。
     * 保留 getter 是为兼容既有验收脚本的外部引用（避免 ReferenceError）；
     * 要实测某设施首次进入的上传成本请用下面的 prewarm(key)。 */
    get lobbyWarmupPeak() { return null; },
    get parkourWarmupPeak() { return null; },
    get memoryWarmupPeak() { return null; },
    get jumpWarmupPeak() { return null; },
    get trainWarmupPeak() { return null; },
    get carouselWarmupPeak() { return null; },
    get pirateWarmupPeak() { return null; },
    get fireworksWarmupPeak() { return null; },
    get clockWarmupPeak() { return null; },
    get switchCount() { return switchCount; },
    get roundTripCount() { return roundTripCount; },

    /**
     * 【调试 / 后台队列 / 未来 FacilityRuntime 用】按需预热单个设施。
     * 固定四步：activate(key) → renderOnce() → deactivate() → renderOnce()；
     * 若调用前已有激活设施（含大厅），结束时原样恢复，避免留下空场景。
     * 启动流程的冷启动阶段绝不调用它；只有稳态校准完成后的后台队列、以及
     * 手动调试才会触发。
     * @param {string} key 已注册的设施 key
     * @returns {boolean} 是否成功完成
     */
    prewarm: prewarmFacility,
  };
  console.info(
    `[基座] 初始化完成（${(performance.now() - bootStartedAt).toFixed(0)}ms），` +
      '可用 window.__playground 验收来回切换 / prewarm(key) 按需预热。'
  );
}

bootstrap().catch((err) => {
  console.error('[基座] 初始化失败，已停止：', err);
  // 初始化失败时收起开始页，让错误状态面板可见；此时渲染循环不会启动
  startScreen?.hide();
  setDebugPanel('基座状态: 初始化失败，请查看控制台', { showUnload: true });
});
