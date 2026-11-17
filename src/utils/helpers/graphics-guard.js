/**
 * ============================================================================
 * GraphicsGuard —— 上线前的 GPU / 网络降级与故障兜底
 * ============================================================================
 * 目标：玩家在弱网、低内存手机、WebGL 上下文丢失时，不会只看到黑屏或无限卡死。
 *   · webglcontextlost：阻止默认行为、冻结逻辑、显示「图形渲染已中断」毛玻璃提示；
 *   · webglcontextrestored：解除冻结并提示；若仍异常提供刷新按钮；
 *   · offline / online：轻量 toast，明确网络状态，不打断当前玩法；
 *   · 低内存设备（deviceMemory ≤ 2）：提示已自动降低画质（真实档位由 QualityTier
 *     在 SceneManager 创建时落地：Bloom 关、阴影 512、pixelRatio ≤1.25）。
 *
 * 【纪律】只在安装时创建 DOM；不进入逐帧热路径，不新建 GPU 资源。
 * ============================================================================
 */

const STYLE_ID = 'pg-graphics-guard-style';

const CSS = `
.pg-gpu-guard{position:fixed;inset:0;z-index:75;display:flex;align-items:center;justify-content:center;
  padding:calc(14px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right))
    calc(14px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left));
  background:radial-gradient(120% 90% at 50% 40%,rgba(18,26,46,.58),rgba(2,6,14,.9));
  -webkit-backdrop-filter:blur(16px) saturate(135%);backdrop-filter:blur(16px) saturate(135%);
  font-family:var(--pg-ui-font,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif);
  color:#f4e9d6;pointer-events:auto}
.pg-gpu-guard[data-hidden='true']{display:none}
.pg-gpu-guard__card{width:min(430px,100%);padding:26px 24px 22px;border-radius:18px;text-align:center;
  background:linear-gradient(158deg,rgba(42,30,24,.95),rgba(12,18,30,.96));
  border:1px solid rgba(235,198,128,.5);box-shadow:0 30px 80px rgba(0,0,0,.66),
    inset 0 1px 0 rgba(255,246,214,.16),inset 0 0 46px rgba(255,188,96,.05)}
.pg-gpu-guard__icon{font-size:34px;line-height:1;margin-bottom:12px}
.pg-gpu-guard__title{margin:0 0 10px;font-size:20px;letter-spacing:1.5px;color:#ffe6b0}
.pg-gpu-guard__desc{margin:0 0 18px;font-size:13px;line-height:1.75;color:#c9d2e6}
.pg-gpu-guard__btn{width:100%;min-height:46px;padding:10px 16px;border-radius:11px;cursor:pointer;
  font-family:inherit;font-size:15px;font-weight:800;color:#231507;
  background:linear-gradient(145deg,#ffe6ad,#e9bf6f 55%,#c79443);
  border:1px solid rgba(255,247,218,.68);box-shadow:0 10px 26px rgba(232,183,92,.28),
    inset 0 1px 0 rgba(255,255,255,.62)}
.pg-guard-toast{position:fixed;left:50%;top:calc(90px + env(safe-area-inset-top,0px));
  transform:translate(-50%,-8px);z-index:52;max-width:min(88vw,520px);padding:9px 16px;border-radius:999px;
  font:600 12px/1.5 var(--pg-ui-font,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif);
  color:#eaf3ff;text-align:center;background:rgba(10,18,34,.88);
  border:1px solid rgba(255,214,140,.36);box-shadow:0 10px 30px rgba(0,0,0,.38);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);pointer-events:none;
  opacity:0;visibility:hidden;transition:opacity .2s,transform .2s,visibility .2s}
.pg-guard-toast[data-on='1']{opacity:1;visibility:visible;transform:translate(-50%,0)}
@media (max-width:600px){
  .pg-gpu-guard__card{padding:20px 18px 18px}
  .pg-gpu-guard__title{font-size:18px}
  .pg-gpu-guard__desc{font-size:12px}
  .pg-guard-toast{top:calc(96px + env(safe-area-inset-top,0px));font-size:11px}
}
`;

class GraphicsGuard {
  constructor() {
    this._installed = false;
    this._lost = false;
    this._overlay = null;
    this._toast = null;
    this._toastTimer = null;
    this._renderer = null;
    this._sceneManager = null;
    this._onCanvasLost = null;
    this._onCanvasRestored = null;
    this._onOffline = null;
    this._onOnline = null;
  }

  install({ renderer, sceneManager, qualityTier } = {}) {
    if (this._installed || typeof document === 'undefined') return this;
    this._installed = true;
    this._renderer = renderer || null;
    this._sceneManager = sceneManager || null;

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.className = 'pg-gpu-guard';
    overlay.dataset.hidden = 'true';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '图形渲染中断');
    overlay.innerHTML = `
      <div class="pg-gpu-guard__card">
        <div class="pg-gpu-guard__icon" aria-hidden="true">🛠️</div>
        <h2 class="pg-gpu-guard__title">图形渲染暂时中断</h2>
        <p class="pg-gpu-guard__desc" data-role="desc">设备显存或图形上下文出现异常。游戏已自动暂停，避免卡死或继续消耗资源。</p>
        <button type="button" class="pg-gpu-guard__btn" data-role="reload">重新加载游戏</button>
      </div>`;
    document.body.appendChild(overlay);
    this._overlay = overlay;
    overlay.querySelector('[data-role="reload"]')?.addEventListener('click', () => window.location.reload());

    const toast = document.createElement('div');
    toast.className = 'pg-guard-toast';
    toast.dataset.on = '0';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
    this._toast = toast;

    const canvas = this._renderer?.domElement;
    if (canvas) {
      this._onCanvasLost = (event) => {
        // 阻止浏览器默认的“上下文永久丢失”行为，给恢复留机会
        event.preventDefault();
        this._lost = true;
        this._sceneManager?.setPaused?.(true);
        this._show('图形渲染暂时中断', '设备显存或图形上下文出现异常。游戏已自动暂停，避免卡死或继续消耗资源。');
      };
      this._onCanvasRestored = () => {
        this._lost = false;
        this._sceneManager?.setPaused?.(false);
        this._show('图形渲染已恢复', '画面可能需要一帧重新上传纹理；若仍异常，请点击下方按钮重新加载。');
        window.setTimeout(() => this.hide(), 1800);
      };
      canvas.addEventListener('webglcontextlost', this._onCanvasLost, false);
      canvas.addEventListener('webglcontextrestored', this._onCanvasRestored, false);
    }

    this._onOffline = () => this.toast('网络已断开 · 已加载的场景仍可离线漫游，重新联网后自动恢复');
    this._onOnline = () => this.toast('网络已恢复');
    window.addEventListener('offline', this._onOffline);
    window.addEventListener('online', this._onOnline);

    // 仅提示真实已落地的降级：QualityTier=low 时 Bloom 关、阴影 512、pixelRatio≤1.25
    if (qualityTier === 'low') {
      window.setTimeout(() => {
        if (!this._lost) this.toast('检测到低性能设备 · 已自动降低画质、阴影与粒子密度');
      }, 1400);
    }
    return this;
  }

  get isLost() { return this._lost; }

  toast(text, duration = 4200) {
    if (!this._toast) return this;
    clearTimeout(this._toastTimer);
    this._toast.textContent = text;
    this._toast.dataset.on = '1';
    this._toastTimer = window.setTimeout(() => {
      if (this._toast) this._toast.dataset.on = '0';
    }, duration);
    return this;
  }

  _show(title, desc) {
    if (!this._overlay) return;
    const h = this._overlay.querySelector('.pg-gpu-guard__title');
    const p = this._overlay.querySelector('[data-role="desc"]');
    if (h) h.textContent = title;
    if (p) p.textContent = desc;
    this._overlay.dataset.hidden = 'false';
    this._overlay.querySelector('[data-role="reload"]')?.focus({ preventScroll: true });
  }

  hide() {
    if (this._overlay) this._overlay.dataset.hidden = 'true';
    return this;
  }

  /** 验收 / 诊断：只模拟 UI 状态，不向真实 WebGL 上下文派发事件（避免污染渲染器） */
  simulateContextLoss() {
    this._lost = true;
    this._sceneManager?.setPaused?.(true);
    this._show('图形渲染暂时中断', '设备显存或图形上下文出现异常。游戏已自动暂停，避免卡死或继续消耗资源。');
    return this;
  }

  simulateContextRestore() {
    this._lost = false;
    this._sceneManager?.setPaused?.(false);
    this.hide();
    return this;
  }

  dispose() {
    if (!this._installed) return;
    const canvas = this._renderer?.domElement;
    if (canvas && this._onCanvasLost) canvas.removeEventListener('webglcontextlost', this._onCanvasLost);
    if (canvas && this._onCanvasRestored) canvas.removeEventListener('webglcontextrestored', this._onCanvasRestored);
    if (this._onOffline) window.removeEventListener('offline', this._onOffline);
    if (this._onOnline) window.removeEventListener('online', this._onOnline);
    clearTimeout(this._toastTimer);
    this._overlay?.remove();
    this._toast?.remove();
    document.getElementById(STYLE_ID)?.remove();
    this._overlay = null;
    this._toast = null;
    this._installed = false;
  }
}

export const graphicsGuard = new GraphicsGuard();
export default graphicsGuard;
