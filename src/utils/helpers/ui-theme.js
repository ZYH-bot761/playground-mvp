/**
 * ============================================================================
 * UITheme —— 全站 DOM 浮层统一视觉基线（阶段四·模块 2）
 * ============================================================================
 * 项目里的 DOM 浮层分散在开始页、暂停菜单、大厅 HUD、8 个设施视图和跳舞厅中，
 * 各自维护 CSS。本模块只注入一张【全局皮肤表】，做三件不侵入布局的事：
 *   ① 统一字体栈与字重渲染（不再落到系统默认黑体）；
 *   ② 统一按钮 hover / active / focus-visible 的放大、发光与颜色过渡；
 *   ③ 给面板 / HUD 增加毛玻璃 + 黄铜描边 + 统一的柔和文字阴影。
 *
 * 具体布局、尺寸、显隐仍由各模块自己的 <style> 控制；本表只覆盖颜色 / 字体 /
 * 动效 / 背景质感，且用 :where() 保持低优先级，个别组件仍可覆盖。
 * 零 GPU 资源、零网络字体、零依赖。
 * ============================================================================
 */

export const UI_FONT_STACK = '"Noto Sans SC","Source Han Sans SC","PingFang SC",'
  + '"Microsoft YaHei","Segoe UI",sans-serif';

const STYLE_ID = 'pg-ui-theme';

const ROOTS = [
  '.pg-start', '.pause-root', '.lb-ui', '.dh-ui',
  '.cr-ui', '.cc-ui', '.fw-ui', '.mm-ui', '.pk-ui', '.ps-ui', '.pt-ui', '.tr-ui',
  '.pg-mode-hud', '.pg-mode-hud__hint', '.pg-joystick',
].join(',');

const PANELS = [
  '.pause-card', '.mm-panel', '.pt-panel', '.tr-panel', '.ps-panel',
  '.pk-panel', '.cc-panel', '.fw-panel', '.cr-panel',
].join(',');

const HUDS = [
  '.mm-hud', '.pt-hud', '.tr-hud', '.ps-hud', '.pk-hud',
  '.cc-hud', '.fw-hud', '.cr-title', '.lb-title', '.lb-controls',
  '.pg-mode-hud', '.dh-badge',
].join(',');

const HEADINGS = [
  '.pause-title', '.mm-panel__title', '.pt-panel__title', '.tr-panel__title',
  '.ps-title', '.pk-title', '.cc-title', '.fw-title', '.cr-title',
  '.dh-badge b', '.lb-title', '.pg-start__title',
].join(',');

const CSS = `
:root{
  --pg-ui-font:${UI_FONT_STACK};
  --pg-brass:#e7c27c;
  --pg-brass-soft:rgba(231,194,124,.46);
  --pg-wood-deep:rgba(30,20,17,.92);
  --pg-glass:rgba(12,22,38,.55);
  --pg-glass-strong:rgba(10,18,32,.78);
  --pg-text-warm:#fff4dc;
  --pg-text-muted:#b9c9de;
  --pg-glow:0 0 22px rgba(255,196,104,.24);
}
${ROOTS}{
  font-family:var(--pg-ui-font) !important;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
}
${HEADINGS}{
  text-shadow:0 1px 2px rgba(0,0,0,.55),0 6px 24px rgba(0,0,0,.42);
}
${PANELS}{
  backdrop-filter:blur(20px) saturate(145%) !important;
  -webkit-backdrop-filter:blur(20px) saturate(145%) !important;
  border-color:var(--pg-brass-soft) !important;
  box-shadow:
    0 30px 80px rgba(2,8,18,.62),
    0 0 0 1px rgba(92,56,22,.55),
    inset 0 1px 0 rgba(255,246,214,.16),
    inset 0 0 42px rgba(255,188,96,.04) !important;
}
${HUDS}{
  backdrop-filter:blur(14px) saturate(140%);
  -webkit-backdrop-filter:blur(14px) saturate(140%);
  border-color:rgba(255,226,170,.28) !important;
  box-shadow:0 10px 30px rgba(3,9,20,.36),inset 0 1px 0 rgba(255,255,255,.14);
  text-shadow:0 1px 3px rgba(0,0,0,.48);
}
/* 按钮统一手感：所有浮层内的按钮都有位移 + 黄铜辉光，组件自带配色仍保留 */
:where(${ROOTS}) button{
  font-family:var(--pg-ui-font) !important;
  transition:
    transform .16s cubic-bezier(.2,.7,.3,1),
    filter .16s ease,
    background-color .18s ease,
    border-color .18s ease,
    box-shadow .18s ease,
    color .18s ease;
  -webkit-tap-highlight-color:transparent;
}
:where(${ROOTS}) button:hover{
  filter:brightness(1.09) saturate(1.06);
  box-shadow:0 8px 26px rgba(255,190,96,.18),var(--pg-glow);
}
:where(${ROOTS}) button:active{
  transform:translateY(1px) scale(.975);
  filter:brightness(.98);
}
:where(${ROOTS}) button:focus-visible{
  outline:2px solid rgba(255,224,164,.85);
  outline-offset:3px;
}
:where(${ROOTS}) button:disabled{
  cursor:not-allowed;
  filter:grayscale(.35) brightness(.85);
  box-shadow:none;
}
/* 选中的主按钮：黄铜渐变，不改组件自己的 layout */
:where(${ROOTS}) :is(.pause-btn--primary,.mm-btn--primary,.pt-btn--primary,.tr-btn--primary,
  .ps-btn--primary,.cc-btn--primary,.fw-btn--primary,.pk-btn--primary){
  background-image:linear-gradient(145deg,#ffe6ad 0%,#e9bf6f 52%,#c79443 100%) !important;
  border-color:rgba(255,247,218,.68) !important;
  color:#231507 !important;
  box-shadow:0 10px 26px rgba(232,183,92,.26),inset 0 1px 0 rgba(255,255,255,.62) !important;
}
:where(${ROOTS}) :is(.pause-btn--exit,.mm-btn--exit,.pt-btn--exit,.tr-btn--exit){
  border-color:rgba(255,205,126,.46) !important;
}
/* 设施 HUD / 面板滚动条统一 */
:where(${ROOTS}) *{
  scrollbar-width:thin;
  scrollbar-color:rgba(231,194,124,.42) rgba(10,18,30,.4);
}
:where(${ROOTS}) *::-webkit-scrollbar{width:7px;height:7px}
:where(${ROOTS}) *::-webkit-scrollbar-thumb{
  background:linear-gradient(180deg,rgba(241,207,144,.56),rgba(158,110,50,.62));
  border-radius:999px;
}
:where(${ROOTS}) *::-webkit-scrollbar-track{background:rgba(10,18,30,.28)}
::selection{background:rgba(255,197,106,.34);color:#fffaf0}

@media (prefers-reduced-motion: reduce){
  :where(${ROOTS}) button{transition-duration:.01ms}
}
`;

let installed = false;

/** 幂等注入全局皮肤；重复调用不会产生第二张 <style> */
export function installUITheme() {
  if (installed || typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) { installed = true; return; }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  installed = true;
}

installUITheme();

export default installUITheme;
