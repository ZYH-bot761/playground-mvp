/**
 * ============================================================================
 * PauseMenu —— 小游戏通用「暂停 / 重玩 / 退出」菜单（单文件闭环）
 * ============================================================================
 * 职责：
 *   · 桌面端：ESC 打开/关闭菜单；移动端：右上角「暂停」按钮（≥44px，避让安全区）
 *   · 菜单为纯 DOM 覆盖层，类名统一 pause- 前缀，半透明磨砂黑底
 *   · 打开时调用 sceneManager.setPaused(true)：SceneManager 渲染循环会跳过
 *     physics.step() 与 attractionManager.update()，因此倒计时、角色移动、
 *     物理推进、update 内的计时累加全部真正冻结；渲染仍在继续（画面定格）。
 *   · 关闭时恢复；dispose() 解绑全部监听、移除 DOM 与注入样式，且幂等。
 *
 * 【只在小游戏内生效】
 *   本类只在四个小游戏的 init() 里 attach；大厅 Lobby 不创建实例，因此
 *   大厅里按 ESC 不会弹菜单，也不会拦截任何按键。
 *
 * 【暂停期间按键隔离】
 *   keydown 以 capture 阶段挂在 window：菜单打开时除 ESC 外的按键
 *   stopPropagation()，避免游戏的 R / 空格 / 方向键在冻结期间被触发。
 * ============================================================================
 */

import sceneManager from '../core/scene-manager.js';

const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)';

const CSS = `
.pause-overlay{position:fixed;inset:0;z-index:60;display:flex;
  align-items:center;justify-content:center;
  padding:calc(12px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
          calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
  background:rgba(6,10,20,.62);-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px);
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
  color:#eef3ff;pointer-events:auto;-webkit-tap-highlight-color:transparent}
.pause-overlay[data-hidden='true']{display:none}
.pause-card{width:min(360px,100%);padding:24px 22px 20px;border-radius:16px;text-align:center;
  background:rgba(13,19,36,.94);border:1px solid rgba(140,205,255,.34);
  box-shadow:0 24px 70px rgba(0,0,0,.6);max-height:calc(100dvh - 48px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  overflow-y:auto}
.pause-title{margin:0 0 18px;font-size:22px;font-weight:700;letter-spacing:1px;color:#9fe4ff;
  text-shadow:0 0 18px rgba(90,200,255,.35)}
.pause-actions{display:flex;flex-direction:column;gap:10px}
.pause-btn{width:100%;min-height:46px;padding:10px 14px;font-size:15px;border-radius:10px;
  cursor:pointer;color:#dbe6ff;background:rgba(255,255,255,.08);
  border:1px solid rgba(160,190,255,.4);touch-action:manipulation;
  font-family:inherit;transition:background .15s,border-color .15s}
.pause-btn:hover{background:rgba(140,180,255,.22);border-color:rgba(190,215,255,.7)}
.pause-btn--primary{color:#10162a;font-weight:700;background:#8fdcff;border-color:#8fdcff}
.pause-btn--primary:hover{background:#aee9ff;border-color:#aee9ff}
.pause-btn--exit{color:#ffe9b0;background:rgba(255,200,90,.14);border-color:rgba(255,200,90,.55)}
.pause-trigger{position:fixed;top:calc(10px + env(safe-area-inset-top));
  right:calc(10px + env(safe-area-inset-right));z-index:55;
  display:none;align-items:center;justify-content:center;gap:4px;
  min-width:74px;height:44px;padding:0 12px;border-radius:999px;
  font-family:inherit;font-size:13px;letter-spacing:.5px;cursor:pointer;
  color:#dfeaff;background:rgba(12,18,34,.72);border:1px solid rgba(140,205,255,.32);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
  touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.pause-trigger[data-active='true']{display:flex}
.pause-trigger:hover{background:rgba(30,48,82,.82);border-color:rgba(170,215,255,.6)}
@media (max-height:430px) and (orientation:landscape){
  .pause-trigger{top:calc(6px + env(safe-area-inset-top));height:44px;min-width:66px;font-size:12px}
  .pause-card{padding:16px 18px 14px;max-height:calc(100dvh - 20px - env(safe-area-inset-top) - env(safe-area-inset-bottom))}
  .pause-title{font-size:18px;margin-bottom:12px}
  .pause-actions{gap:8px}
  .pause-btn{min-height:44px;font-size:14px;padding:8px 12px}
}
`;

export class PauseMenu {
  /**
   * @param {Object} options
   * @param {Function} [options.onRestart] 「重玩本局」回调：清空进度重开当前局
   * @param {Function} [options.onExit]    「退出本局」回调：结束本局并回大厅
   * @param {boolean}  [options.coarse]    是否强制显示移动端暂停按钮（默认按媒体查询）
   */
  constructor({ onRestart, onExit, coarse } = {}) {
    this._onRestart = typeof onRestart === 'function' ? onRestart : null;
    this._onExit = typeof onExit === 'function' ? onExit : null;

    this._open = false;
    this._disposed = false;
    this._root = null;
    this._style = null;
    this._trigger = null;
    this._listeners = [];

    this._coarse = typeof coarse === 'boolean'
      ? coarse
      : Boolean(window.matchMedia && window.matchMedia(COARSE_POINTER_QUERY).matches);

    /** keydown 必须 capture：菜单打开时抢在游戏的 bubble 监听之前拦截按键 */
    this._onKeyDown = (event) => {
      if (this._disposed) return;
      const isEsc = event.key === 'Escape' || event.code === 'Escape';
      if (isEsc) {
        // 长按 ESC 会连续触发 keydown；不设防抖会在 open/close 之间高频抖动，
        // 反复改写 sceneManager._paused，甚至让恢复态错乱。
        if (event.repeat) return;
        if (event.cancelable) event.preventDefault();
        this.toggle();
        return;
      }
      // 暂停期间冻结游戏输入（方向键 / 空格 / R 等）；ESC 已在上面处理
      if (this._open) {
        event.stopPropagation();
        // 方向键 / 空格在未传播到页面时仍可能滚动视口，一并阻止默认行为
        if (event.cancelable) event.preventDefault();
      }
    };

    /** 移动端「暂停」按钮：只负责开/关菜单 */
    this._onTriggerClick = (event) => {
      if (this._disposed) return;
      if (event?.cancelable) event.preventDefault();
      if (this._open) this.close();
      else this.open();
    };

    this._onClick = (event) => {
      if (this._disposed) return;
      const button = event.target.closest?.('button[data-pause-action]');
      if (!button || !this._root?.contains(button)) return;
      const action = button.dataset.pauseAction;
      if (action === 'resume') {
        this.close();
      } else if (action === 'restart') {
        this.close();
        this._onRestart?.();
      } else if (action === 'exit') {
        this.close();
        this._onExit?.();
      }
    };
  }

  get isOpen() { return this._open; }

  /** 创建 DOM / 样式并挂载监听；返回 this 便于链式调用 */
  attach() {
    if (this._disposed || this._root) return this;

    this._style = document.createElement('style');
    this._style.id = 'pause-ui-style';
    this._style.textContent = CSS;
    document.head.appendChild(this._style);

    const root = document.createElement('div');
    root.className = 'pause-root';
    root.innerHTML = `
      <button type="button" class="pause-trigger" data-active="${this._coarse ? 'true' : 'false'}"
        aria-label="暂停游戏">⏸ 暂停</button>
      <div class="pause-overlay" data-hidden="true" role="dialog" aria-modal="true" aria-label="游戏暂停">
        <div class="pause-card">
          <h2 class="pause-title">游戏暂停</h2>
          <div class="pause-actions">
            <button type="button" class="pause-btn pause-btn--primary" data-pause-action="resume">继续游戏</button>
            <button type="button" class="pause-btn" data-pause-action="restart">重玩本局</button>
            <button type="button" class="pause-btn pause-btn--exit" data-pause-action="exit">退出本局</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this._root = root;
    this._trigger = root.querySelector('.pause-trigger');

    root.addEventListener('click', this._onClick);
    window.addEventListener('keydown', this._onKeyDown, true);
    this._listeners.push(
      { target: root, type: 'click', fn: this._onClick, options: false },
      { target: window, type: 'keydown', fn: this._onKeyDown, options: true },
    );
    // 暂停按钮只在粗指针（手机）显示；桌面走 ESC
    if (this._trigger) {
      this._trigger.addEventListener('click', this._onTriggerClick);
      this._listeners.push({
        target: this._trigger, type: 'click', fn: this._onTriggerClick, options: false,
      });
    }
    return this;
  }

  /** 打开菜单：真正冻结物理与 update */
  open() {
    if (this._disposed || this._open || !this._root) return;
    this._open = true;
    this._root.querySelector('.pause-overlay').dataset.hidden = 'false';
    sceneManager.setPaused(true);
  }

  /** 关闭菜单：恢复物理与 update */
  close() {
    if (this._disposed || !this._root) return;
    const overlay = this._root.querySelector('.pause-overlay');
    if (overlay) overlay.dataset.hidden = 'true';
    if (this._open) {
      this._open = false;
      sceneManager.setPaused(false);
    }
  }

  toggle() {
    if (this._open) this.close();
    else this.open();
  }

  /** 幂等清理：解绑监听、移除 DOM 与样式、恢复暂停前的运行状态 */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    // 先恢复运行状态，避免退出小游戏后整个场景仍被冻结
    try {
      if (this._open) sceneManager.setPaused(false);
    } catch (err) {
      console.warn('[PauseMenu] 恢复运行状态失败：', err);
    }
    this._open = false;

    for (const { target, type, fn, options } of this._listeners) {
      try { target.removeEventListener(type, fn, options); } catch { /* 目标已销毁，忽略 */ }
    }
    this._listeners.length = 0;

    try { this._root?.remove(); } catch { /* 忽略 */ }
    try { this._style?.remove(); } catch { /* 忽略 */ }
    this._root = null;
    this._style = null;
    this._trigger = null;
  }
}

export default PauseMenu;
