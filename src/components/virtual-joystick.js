/**
 * ============================================================================
 * VirtualJoystick —— 移动端虚拟摇杆（单文件闭环 / 零外部资源）
 * ============================================================================
 * 用户诉求：手机端在大厅、跳舞厅、玉米地等所有可走动场景都必须能移动。
 * 本组件只负责 DOM 与指针 → 归一化轴向，不碰相机 / Three / 业务状态：
 *   · 左半屏固定摇杆，`pointerdown` 起拖、`pointerup/cancel` 归零；
 *   · 输出 x = 右正、y = 前正，长度 clamp 到 1，内置 0.12 死区；
 *   · 仅粗指针设备显示；桌面不占屏。调试可用 ?joystick=1 强制显示。
 *   · 指针捕获 + touch-action:none，拖动时不会把事件漏给画布触发环。
 *
 * WASDController 负责把轴向叠加到键盘输入，并决定何时显示。
 * ============================================================================
 */

const STYLE_ID = 'pg-joystick-style';
const COARSE_QUERY = '(hover: none) and (pointer: coarse)';
const DEAD_ZONE = 0.12;

const CSS = `
.pg-joystick{position:fixed;
  left:calc(18px + env(safe-area-inset-left,0px));
  bottom:calc(20px + env(safe-area-inset-bottom,0px));
  width:132px;height:132px;z-index:44;touch-action:none;
  pointer-events:auto;user-select:none;-webkit-user-select:none;
  -webkit-tap-highlight-color:transparent;
  filter:drop-shadow(0 10px 24px rgba(4,10,22,.42));
  transition:opacity .18s ease,transform .18s ease}
.pg-joystick[data-hidden='true']{display:none}
.pg-joystick__ring{position:absolute;inset:0;border-radius:50%;
  background:
    radial-gradient(circle at 42% 32%,rgba(255,255,255,.16),rgba(255,255,255,0) 40%),
    radial-gradient(circle at 50% 58%,rgba(16,30,52,.34),rgba(8,16,30,.56));
  border:1px solid rgba(255,218,150,.46);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.18),
    inset 0 0 26px rgba(255,198,104,.10),
    0 0 0 3px rgba(255,208,128,.07);
  -webkit-backdrop-filter:blur(10px) saturate(145%);
  backdrop-filter:blur(10px) saturate(145%)}
.pg-joystick__ring::before{content:'';position:absolute;inset:11px;border-radius:50%;
  border:1px dashed rgba(255,226,174,.26)}
.pg-joystick__ring::after{content:'';position:absolute;inset:26px;border-radius:50%;
  border:1px solid rgba(255,238,200,.13)}
.pg-joystick__knob{position:absolute;left:50%;top:50%;width:54px;height:54px;
  margin:-27px 0 0 -27px;border-radius:50%;will-change:transform;
  background:
    radial-gradient(circle at 36% 28%,#fff8e6,rgba(255,238,196,0) 38%),
    linear-gradient(150deg,#f6d49a 0%,#c99a52 48%,#8a5f2c 100%);
  border:1px solid rgba(255,245,218,.62);
  box-shadow:0 8px 18px rgba(4,10,20,.42),
    inset 0 2px 5px rgba(255,255,255,.5),
    inset 0 -4px 8px rgba(80,44,12,.38);
  transition:box-shadow .16s ease}
.pg-joystick[data-active='true'] .pg-joystick__knob{
  box-shadow:0 8px 22px rgba(4,10,20,.48),
    0 0 20px rgba(255,196,96,.46),
    inset 0 2px 5px rgba(255,255,255,.6),
    inset 0 -4px 8px rgba(80,44,12,.36)}
.pg-joystick__cap{position:absolute;left:50%;top:50%;width:12px;height:12px;
  margin:-6px 0 0 -6px;border-radius:50%;
  background:radial-gradient(circle at 36% 30%,#fffdf5,#e9c37e 58%,#9b6c30);
  box-shadow:0 1px 4px rgba(60,34,8,.5)}
.pg-joystick__label{position:absolute;left:50%;top:-23px;transform:translateX(-50%);
  padding:3px 10px;border-radius:999px;white-space:nowrap;
  font:600 11px/1.2 var(--pg-ui-font,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif);
  letter-spacing:1.5px;color:#ffe8bd;text-shadow:0 1px 6px rgba(0,0,0,.6);
  background:rgba(10,20,36,.46);border:1px solid rgba(255,218,150,.26);
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
@media (max-width:560px){
  .pg-joystick{width:116px;height:116px;left:calc(12px + env(safe-area-inset-left,0px));
    bottom:calc(14px + env(safe-area-inset-bottom,0px))}
  .pg-joystick__knob{width:48px;height:48px;margin:-24px 0 0 -24px}
}
@media (max-height:440px) and (orientation:landscape){
  .pg-joystick{width:100px;height:100px;left:calc(10px + env(safe-area-inset-left,0px));
    bottom:calc(10px + env(safe-area-inset-bottom,0px))}
  .pg-joystick__knob{width:42px;height:42px;margin:-21px 0 0 -21px}
  .pg-joystick__label{display:none}
}
`;

/** 触屏设备判定：maxTouchPoints 对 Android/iPad 最可靠；媒体查询兜底 */
function isCoarsePointer() {
  if (typeof window === 'undefined') return false;
  try {
    // 媒体查询优先：桌面（含触屏笔记本）保持纯键鼠 HUD，不显示摇杆
    if (window.matchMedia) {
      if (window.matchMedia(COARSE_QUERY).matches) return true;
      if (window.matchMedia('(pointer: fine)').matches) {
        return new URLSearchParams(window.location.search).get('joystick') === '1';
      }
    }
    if ((navigator.maxTouchPoints || 0) > 0) return true;
  } catch { /* 不支持 matchMedia 时按桌面处理 */ }
  // 显式调试开关：桌面浏览器也可验收摇杆 DOM 与事件链
  try {
    return new URLSearchParams(window.location.search).get('joystick') === '1';
  } catch { return false; }
}

export class VirtualJoystick {
  /**
   * @param {{
   *   onChange?: (x:number, y:number) => void,
   *   onStart?: () => void,
   *   onEnd?: () => void,
   *   force?: boolean,
   * }} [options]
   */
  constructor({ onChange = null, onStart = null, onEnd = null, force = false } = {}) {
    this._onChange = typeof onChange === 'function' ? onChange : null;
    this._onStart = typeof onStart === 'function' ? onStart : null;
    this._onEnd = typeof onEnd === 'function' ? onEnd : null;
    this._force = force === true;
    this._available = false;
    this._attached = false;
    this._visible = false;
    this._active = false;
    this._pointerId = null;
    this._x = 0;
    this._y = 0;
    this._root = null;
    this._ring = null;
    this._knob = null;

    this._onPointerDown = (event) => {
      if (!this._visible || !this._root) return;
      if (event.isPrimary === false) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this._pointerId = event.pointerId;
      this._active = true;
      this._root.dataset.active = 'true';
      try { this._ring.setPointerCapture(event.pointerId); } catch { /* 指针已释放 */ }
      this._onStart?.();
      this._updateFromEvent(event);
    };

    this._onPointerMove = (event) => {
      if (!this._active || event.pointerId !== this._pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this._updateFromEvent(event);
    };

    this._onPointerUp = (event) => {
      if (event.pointerId !== this._pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this.reset();
    };

    this._onLostCapture = (event) => {
      if (event.pointerId === this._pointerId) this.reset();
    };
  }

  get available() { return this._available; }
  get value() { return { x: this._x, y: this._y }; }

  /** 创建 DOM / 样式并绑定指针（幂等） */
  attach() {
    if (this._attached || typeof document === 'undefined') return this;
    this._available = this._force || isCoarsePointer();

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.className = 'pg-joystick';
    root.dataset.hidden = 'true';
    root.dataset.active = 'false';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', '移动摇杆');
    root.innerHTML = `
      <span class="pg-joystick__label">移动</span>
      <div class="pg-joystick__ring" data-role="ring">
        <div class="pg-joystick__knob" data-role="knob">
          <span class="pg-joystick__cap" aria-hidden="true"></span>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this._root = root;
    this._ring = root.querySelector('[data-role="ring"]');
    this._knob = root.querySelector('[data-role="knob"]');

    this._ring.addEventListener('pointerdown', this._onPointerDown);
    this._ring.addEventListener('pointermove', this._onPointerMove);
    this._ring.addEventListener('pointerup', this._onPointerUp);
    this._ring.addEventListener('pointercancel', this._onPointerUp);
    this._ring.addEventListener('lostpointercapture', this._onLostCapture);
    this._attached = true;
    return this;
  }

  /** 显隐由控制器每帧给出；重复同值调用不会碰 DOM */
  setVisible(visible) {
    const next = !!visible && this._available;
    if (next === this._visible) return this;
    this._visible = next;
    if (!next) this.reset();
    if (this._root) this._root.dataset.hidden = next ? 'false' : 'true';
    return this;
  }

  /** 归零摇杆并通知业务层，用于隐藏 / 失焦 / 场景切换 */
  reset() {
    const hadInput = this._x !== 0 || this._y !== 0;
    this._x = 0;
    this._y = 0;
    this._active = false;
    this._pointerId = null;
    if (this._root) this._root.dataset.active = 'false';
    if (this._knob) this._knob.style.transform = 'translate3d(0,0,0)';
    if (hadInput) {
      this._onChange?.(0, 0);
      this._onEnd?.();
    }
    return this;
  }

  /** 解绑、移除 DOM 与只属于本组件的样式（幂等） */
  dispose() {
    if (!this._attached) return this;
    this.reset();
    this._visible = false;
    if (this._ring) {
      this._ring.removeEventListener('pointerdown', this._onPointerDown);
      this._ring.removeEventListener('pointermove', this._onPointerMove);
      this._ring.removeEventListener('pointerup', this._onPointerUp);
      this._ring.removeEventListener('pointercancel', this._onPointerUp);
      this._ring.removeEventListener('lostpointercapture', this._onLostCapture);
    }
    this._root?.remove();
    this._root = null;
    this._ring = null;
    this._knob = null;
    this._attached = false;
    if (!document.querySelector('.pg-joystick')) document.getElementById(STYLE_ID)?.remove();
    this._onChange = null;
    this._onStart = null;
    this._onEnd = null;
    return this;
  }

  /* ------------------------------------------------------------------ */

  _updateFromEvent(event) {
    if (!this._ring) return;
    const rect = this._ring.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2 - 12);
    let dx = (event.clientX - cx) / radius;
    let dy = (cy - event.clientY) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    const outLen = Math.hypot(dx, dy);
    if (outLen < DEAD_ZONE) { dx = 0; dy = 0; }

    this._x = dx;
    this._y = dy;
    const px = dx * radius;
    const py = -dy * radius;
    if (this._knob) this._knob.style.transform = `translate3d(${px.toFixed(2)}px,${py.toFixed(2)}px,0)`;
    this._onChange?.(dx, dy);
  }
}

export default VirtualJoystick;
