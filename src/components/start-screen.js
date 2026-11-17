/**
 * ============================================================================
 * StartScreen —— 开始页（全屏 DOM 覆盖层 / 零外部资源）
 * ============================================================================
 * 视觉：上半部日间天空渐变 → 地平线暖光 → 深色透视网格地面，叠加橙 / 紫 / 青
 *       三色霓虹光斑，对应 Lobby「日间蓝天 + 夜间霓虹泛光」的基调。
 *
 * 约束：
 *   - 所有效果都是 CSS 渐变 / blur / box-shadow，不加载字体、图片或 CDN；
 *   - 样式在 init() 时注入一次 <style>，dispose() 且无其他实例时移除；
 *   - import 本模块不创建 DOM、不注入样式、不绑定事件（零副作用）。
 *
 * 生命周期：
 *   const screen = new StartScreen({ onStart: () => {...} });
 *   screen.init();          // 首次调用时创建 DOM（幂等）
 *   screen.show();          // 淡入
 *   screen.hide();          // 淡出
 *   screen.dispose();       // 移除 DOM、样式与全部事件监听
 * ============================================================================
 */

/** 注入样式表的 id，用于避免重复插入与精确移除 */
const STYLE_ID = 'pg-start-styles';

/** 默认文案：可在构造 / init 时按需覆盖 */
const DEFAULT_OPTIONS = Object.freeze({
  eyebrow: 'PLAYGROUND · 3D',
  title: '霓虹游乐场',
  subtitle: '白天是蓝天、摩天轮和风；入夜后霓虹一盏盏亮起来。走进去，随便玩点什么。',
  buttonText: '进入游乐场',
  // T02 已上线：大厅支持「鼠标自由探索」与「WASD / 方向键漫游」两种模式，
  // 按 M 或左上角按钮切换；文案与实际实现保持一致，不提前承诺未实现的操作。
  hint: '拖拽环顾 / WASD 漫游（M 切换）· 靠近入口按 E · 车旁按 E · 卡住按 R 回出生点',
  onStart: null,
  autoHide: true,
});

const STYLE_TEXT = `
.pg-start {
  --pg-sky-top: #2f74bd;
  --pg-sky-mid: #9fd0f2;
  --pg-horizon: #ffe7bf;
  --pg-night: #080d1c;
  --pg-cyan: #27c8ff;
  --pg-violet: #9a63f0;
  --pg-amber: #ffb52e;
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  overflow: hidden;
  isolation: isolate;
  box-sizing: border-box;
  /* 刘海 / 圆角屏：卡片始终留在安全区内 */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  font-family: var(--pg-ui-font, 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  color: #eaf3ff;
  background: linear-gradient(
    180deg,
    var(--pg-sky-top) 0%,
    #63a5da 18%,
    var(--pg-sky-mid) 36%,
    var(--pg-horizon) 52%,
    #6c4a72 62%,
    #131a33 76%,
    var(--pg-night) 100%
  );
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.45s ease, visibility 0.45s ease;
}

.pg-start--visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

/* ---------- 天空与霓虹光斑 ---------- */
.pg-start__sun {
  position: absolute;
  left: 50%;
  top: 42%;
  width: min(62vw, 720px);
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle, rgba(255, 246, 224, 0.95) 0%, rgba(255, 214, 140, 0.45) 32%, rgba(255, 186, 100, 0) 68%);
  filter: blur(6px);
  z-index: 0;
  pointer-events: none;
}

.pg-start__glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(64px);
  opacity: 0.55;
  mix-blend-mode: screen;
  pointer-events: none;
  z-index: 1;
  animation: pg-start-float 9s ease-in-out infinite;
}

.pg-start__glow--cyan {
  width: 42vw;
  height: 42vw;
  left: -8vw;
  bottom: 4vh;
  background: radial-gradient(circle, rgba(39, 200, 255, 0.75) 0%, rgba(39, 200, 255, 0) 70%);
}

.pg-start__glow--violet {
  width: 46vw;
  height: 46vw;
  right: -10vw;
  bottom: 10vh;
  background: radial-gradient(circle, rgba(154, 99, 240, 0.7) 0%, rgba(154, 99, 240, 0) 70%);
  animation-delay: -3s;
}

.pg-start__glow--amber {
  width: 30vw;
  height: 30vw;
  right: 12vw;
  top: 16vh;
  background: radial-gradient(circle, rgba(255, 181, 46, 0.55) 0%, rgba(255, 181, 46, 0) 70%);
  animation-delay: -6s;
}

/* ---------- 透视网格地面 ---------- */
.pg-start__grid {
  position: absolute;
  left: -25%;
  right: -25%;
  bottom: -8%;
  height: 54%;
  z-index: 1;
  pointer-events: none;
  transform: perspective(420px) rotateX(64deg);
  transform-origin: 50% 100%;
  background-image:
    repeating-linear-gradient(90deg, rgba(39, 200, 255, 0.3) 0 2px, rgba(39, 200, 255, 0) 2px 76px),
    repeating-linear-gradient(0deg, rgba(154, 99, 240, 0.28) 0 2px, rgba(154, 99, 240, 0) 2px 76px);
  -webkit-mask-image: linear-gradient(to top, #000 8%, rgba(0, 0, 0, 0.55) 45%, transparent 88%);
  mask-image: linear-gradient(to top, #000 8%, rgba(0, 0, 0, 0.55) 45%, transparent 88%);
  animation: pg-start-grid 7s linear infinite;
}

/* ---------- 暗角：压住四周，把视线收进卡片 ---------- */
.pg-start__vignette {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    radial-gradient(120% 90% at 50% 48%, rgba(4, 8, 20, 0) 45%, rgba(4, 8, 20, 0.55) 100%),
    linear-gradient(180deg, rgba(4, 8, 20, 0.28) 0%, rgba(4, 8, 20, 0) 26%);
}

/* ---------- 内容卡片 ---------- */
.pg-start__card {
  position: relative;
  z-index: 3;
  width: min(580px, calc(100vw - 40px));
  padding: 44px 42px 34px;
  text-align: center;
  border: 1px solid rgba(235, 198, 128, 0.34);
  border-radius: 26px;
  background: linear-gradient(158deg, rgba(15, 20, 34, 0.78) 0%, rgba(10, 16, 30, 0.56) 100%);
  box-shadow:
    0 28px 90px rgba(3, 8, 20, 0.62),
    0 0 0 1px rgba(92, 56, 22, 0.42),
    0 0 70px rgba(39, 200, 255, 0.12),
    inset 0 1px 0 rgba(255, 246, 214, 0.2);
  backdrop-filter: blur(20px) saturate(145%);
  -webkit-backdrop-filter: blur(20px) saturate(145%);
  animation: pg-start-rise 0.7s cubic-bezier(0.2, 0.7, 0.3, 1) both;
}

.pg-start__card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 18%;
  right: 18%;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(39, 200, 255, 0), var(--pg-cyan), var(--pg-violet), var(--pg-amber), rgba(255, 181, 46, 0));
  opacity: 0.85;
}

.pg-start__eyebrow {
  margin: 0 0 14px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.34em;
  text-indent: 0.34em;
  color: #7fd1ff;
  text-transform: uppercase;
}

.pg-start__title {
  margin: 0;
  font-size: clamp(30px, 6vw, 54px);
  font-weight: 800;
  letter-spacing: 0.05em;
  line-height: 1.2;
  background: linear-gradient(100deg, #ffffff 6%, #8fe3ff 36%, #c2a9ff 64%, #ffcf85 94%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 0 26px rgba(90, 190, 255, 0.32));
}

.pg-start__subtitle {
  margin: 16px auto 0;
  max-width: 30em;
  font-size: 14px;
  line-height: 1.85;
  color: #c4d6ef;
}

.pg-start__enter {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 30px;
  padding: 15px 36px;
  font-family: inherit;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #06101f;
  cursor: pointer;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(118deg, #8fe3ff 0%, #b79bff 52%, #ffbe6b 100%);
  box-shadow:
    0 12px 32px rgba(80, 170, 255, 0.36),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
  transition: transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease;
  animation: pg-start-pulse 2.6s ease-in-out infinite;
  -webkit-tap-highlight-color: transparent;
}

.pg-start__enter:hover {
  transform: translateY(-2px);
  filter: saturate(1.08) brightness(1.04);
  box-shadow:
    0 18px 44px rgba(120, 190, 255, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.65);
}

.pg-start__enter:active {
  transform: translateY(0) scale(0.98);
}

.pg-start__enter:focus-visible {
  outline: 2px solid #9fe8ff;
  outline-offset: 4px;
}

.pg-start__arrow {
  font-size: 18px;
  line-height: 1;
  transition: transform 0.18s ease;
}

.pg-start__enter:hover .pg-start__arrow {
  transform: translateX(4px);
}

.pg-start__hint {
  margin: 20px 0 0;
  font-size: 12px;
  line-height: 1.75;
  color: #8ea4c6;
}

/* ---------- 动效 ---------- */
@keyframes pg-start-rise {
  from { opacity: 0; transform: translateY(22px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes pg-start-float {
  0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
  50%      { transform: translate3d(2vw, -3vh, 0) scale(1.06); }
}

@keyframes pg-start-grid {
  from { background-position: 0 0, 0 0; }
  to   { background-position: 0 76px, 0 76px; }
}

@keyframes pg-start-pulse {
  0%, 100% { box-shadow: 0 12px 32px rgba(80, 170, 255, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.55); }
  50%      { box-shadow: 0 16px 46px rgba(140, 120, 255, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.7); }
}

@media (max-width: 520px) {
  .pg-start__card { padding: 32px 22px 26px; border-radius: 20px; }
  .pg-start__subtitle { font-size: 13px; }
  .pg-start__enter { width: 100%; padding: 15px 20px; min-height: 48px; }
  .pg-start__hint { font-size: 11px; }
}

/* 手机横屏 / 矮视口：卡片允许内部滚动，避免被裁切且按钮始终可点 */
@media (max-height: 560px) {
  .pg-start__card {
    max-height: calc(100dvh - 20px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 22px 26px 18px;
    border-radius: 18px;
  }
  .pg-start__eyebrow { margin-bottom: 8px; }
  .pg-start__subtitle { margin-top: 8px; font-size: 12px; line-height: 1.6; }
  .pg-start__enter { margin-top: 16px; padding: 13px 24px; min-height: 48px; }
  .pg-start__hint { margin-top: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .pg-start,
  .pg-start__enter {
    transition-duration: 0.01ms;
  }
  .pg-start__glow,
  .pg-start__grid,
  .pg-start__card,
  .pg-start__enter {
    animation: none;
  }
}
`;

export class StartScreen {
  /**
   * 构造函数只保存配置，不触碰 DOM（保证 import / new 均无副作用）。
   * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
   */
  constructor(options = {}) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._root = null;
    this._button = null;
    this._fields = {};
    this._visible = false;
    this._rafId = 0;

    this._onClick = (event) => {
      const button = event.target.closest?.('[data-action="start"]');
      if (!button || !this._root || !this._root.contains(button)) return;
      this._handleStart(event);
    };
    // 按钮已获得焦点时，Enter / 空格会触发原生 click，这里跳过避免重复回调
    this._onKeyDown = (event) => {
      if (!this._visible) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target === this._button) return;
      event.preventDefault();
      this._handleStart(event);
    };
  }

  /**
   * 创建 DOM 并应用配置（幂等，可重复调用以更新文案）。
   * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
   * @returns {this}
   */
  init(options = {}) {
    this._mergeOptions(options);

    if (!this._root) {
      this._injectStyles();
      this._createDom();
      window.addEventListener('keydown', this._onKeyDown);
    }
    this._applyTexts();
    return this;
  }

  /** 淡入并聚焦「进入」按钮（Enter 可进入） */
  show() {
    this.init();
    if (!this._root) return this;

    this._visible = true;
    this._root.classList.add('pg-start--visible');
    this._root.setAttribute('aria-hidden', 'false');

    cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this._rafId = 0;
      this._button?.focus({ preventScroll: true });
    });
    return this;
  }

  /** 淡出（DOM 保留，便于下次 show() 快速复用） */
  hide() {
    this._visible = false;
    if (!this._root) return this;

    cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._root.classList.remove('pg-start--visible');
    this._root.setAttribute('aria-hidden', 'true');
    this._button?.blur();
    return this;
  }

  get visible() {
    return this._visible;
  }

  /** 移除 DOM、样式与全部事件监听 */
  dispose() {
    cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._visible = false;

    window.removeEventListener('keydown', this._onKeyDown);

    if (this._root) {
      this._root.removeEventListener('click', this._onClick);
      this._root.remove();
      this._root = null;
    }
    this._button = null;
    this._fields = {};
    this._options = { ...DEFAULT_OPTIONS };

    // 页面上已无其他开始页实例时才移除共享样式表
    if (!document.querySelector('.pg-start')) {
      document.getElementById(STYLE_ID)?.remove();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部实现                                                            */
  /* ------------------------------------------------------------------ */

  _mergeOptions(options) {
    if (!options || typeof options !== 'object') return;
    Object.keys(DEFAULT_OPTIONS).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        this._options[key] = options[key];
      }
    });
  }

  _injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }

  _createDom() {
    const root = document.createElement('div');
    root.className = 'pg-start';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="pg-start__sun" aria-hidden="true"></div>
      <div class="pg-start__glow pg-start__glow--cyan" aria-hidden="true"></div>
      <div class="pg-start__glow pg-start__glow--violet" aria-hidden="true"></div>
      <div class="pg-start__glow pg-start__glow--amber" aria-hidden="true"></div>
      <div class="pg-start__grid" aria-hidden="true"></div>
      <div class="pg-start__vignette" aria-hidden="true"></div>
      <div class="pg-start__card">
        <p class="pg-start__eyebrow" data-role="eyebrow"></p>
        <h1 class="pg-start__title" data-role="title"></h1>
        <p class="pg-start__subtitle" data-role="subtitle"></p>
        <button type="button" class="pg-start__enter" data-action="start">
          <span data-role="button-text"></span>
          <span class="pg-start__arrow" aria-hidden="true">→</span>
        </button>
        <p class="pg-start__hint" data-role="hint"></p>
      </div>
    `;

    this._root = root;
    this._button = root.querySelector('[data-action="start"]');
    this._fields = {
      eyebrow: root.querySelector('[data-role="eyebrow"]'),
      title: root.querySelector('[data-role="title"]'),
      subtitle: root.querySelector('[data-role="subtitle"]'),
      buttonText: root.querySelector('[data-role="button-text"]'),
      hint: root.querySelector('[data-role="hint"]'),
    };
    root.addEventListener('click', this._onClick);
    document.body.appendChild(root);
  }

  _applyTexts() {
    if (!this._root) return;
    const options = this._options;
    this._fields.eyebrow.textContent = options.eyebrow;
    this._fields.title.textContent = options.title;
    this._fields.subtitle.textContent = options.subtitle;
    this._fields.buttonText.textContent = options.buttonText;
    this._fields.hint.textContent = options.hint;
    this._root.setAttribute('aria-label', options.title);
  }

  _handleStart(event) {
    // show() 之外（已淡出 / 已隐藏）不接受触发，避免连点重复进入
    if (!this._visible) return;
    if (this._options.autoHide !== false) this.hide();

    const { onStart } = this._options;
    if (typeof onStart !== 'function') return;
    try {
      onStart(event);
    } catch (err) {
      console.error('[StartScreen] onStart 回调执行出错：', err);
    }
  }
}

export default StartScreen;

