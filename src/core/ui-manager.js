/**
 * ============================================================================
 * UIManager —— HTML 悬浮 UI 控制（单例）
 * ============================================================================
 * 职责：在 canvas 之上创建一块轻量控制面板，提供 M2 验收所需的
 *       「卸载测试」按钮，并额外提供「重新激活」以便反复切换 5 次
 *       验证资源计数不漂移（PRD v1.0 §9.2）。
 *
 * 设计要点：
 *   - UI 是纯 DOM，不占用 renderer.info.memory 的 geometry/texture 计数，
 *     因此不会污染双归零基线；
 *   - 采用事件委托，dispose() 时一次解绑 + 移除根节点即可；
 *   - 只通过回调与业务层通信，不直接依赖 AttractionManager。
 * ============================================================================
 */

export class UIManager {
  static _instance = null;

  static getInstance() {
    if (!UIManager._instance) UIManager._instance = new UIManager();
    return UIManager._instance;
  }

  constructor() {
    this._root = null;
    this._status = null;
    this._handlers = { onDeactivate: null, onReactivate: null };
    this._onClick = (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || !this._root || !this._root.contains(button)) return;
      const action = button.dataset.action;
      if (action === 'toggle') {
        const open = this._root.dataset.open === 'true';
        this._root.dataset.open = open ? 'false' : 'true';
        button.setAttribute('aria-expanded', open ? 'false' : 'true');
        button.textContent = open ? '调试' : '收起';
        return;
      }
      if (action === 'deactivate') this._handlers.onDeactivate?.();
      if (action === 'reactivate') this._handlers.onReactivate?.();
    };
  }

  /**
   * @param {{onDeactivate: Function, onReactivate: Function}} handlers
   */
  init({ onDeactivate, onReactivate } = {}) {
    this._handlers.onDeactivate = onDeactivate;
    this._handlers.onReactivate = onReactivate;

    if (this._root) return this; // 幂等，避免重复创建 DOM

    this._root = document.createElement('div');
    this._root.className = 'pg-ui';
    this._root.dataset.open = 'false';
    this._root.innerHTML = `
      <button type="button" class="pg-ui__toggle" data-action="toggle" aria-expanded="false" aria-controls="pg-ui-panel">调试</button>
      <div class="pg-ui__panel" id="pg-ui-panel">
        <div class="pg-ui__title">游乐场基座 · M2 验证</div>
        <div class="pg-ui__status" data-role="status">初始化中…</div>
        <div class="pg-ui__buttons">
          <button type="button" data-action="deactivate" class="pg-ui__btn pg-ui__btn--primary">卸载测试</button>
          <button type="button" data-action="reactivate" class="pg-ui__btn">重新激活</button>
        </div>
        <p class="pg-ui__hint">
          点击球体可验证射线拾取。卸载后请查看控制台的 geometries / textures 是否回落至基线；
          可反复「重新激活 → 卸载」5 次验证不漂移。
        </p>
      </div>
    `;
    this._status = this._root.querySelector('[data-role="status"]');
    this._root.addEventListener('click', this._onClick);
    document.body.appendChild(this._root);
    return this;
  }

  /** @param {string} text 状态栏文本 */
  setStatus(text) {
    if (this._status) this._status.textContent = text;
  }

  dispose() {
    if (!this._root) return;
    this._root.removeEventListener('click', this._onClick);
    this._root.remove();
    this._root = null;
    this._status = null;
    this._handlers = { onDeactivate: null, onReactivate: null };
  }
}

export const uiManager = UIManager.getInstance();
export default uiManager;
