/**
 * ============================================================================
 * DebugPanel —— lil-gui 调试面板（半透明毛玻璃风格）
 * ============================================================================
 * 【阶段一/五】lil-gui 取代默认调试 UI 的丑陋边框，提供六项升级的实时开关：
 *   移动模式互斥切换、Bloom 轻微光晕、FXAA、LOD 高模策略、标签显隐、
 *   强制关闭 frustumCulled、实时渲染统计。
 * 纯 DOM，不占 renderer.info.memory 的 geometry/texture → 不影响 Δ0/0。
 * 默认折叠（close），并避开右上/右下既有 HUD 按钮。
 * ============================================================================
 */
import GUI from 'lil-gui';
import { movementMode } from '../core/MovementModeManager.js';
import { renderOptimizer } from '../core/RenderOptimizer.js';
import { districtLabels } from './DistrictLabels.js';

export class DebugPanel {
  constructor() {
    this.gui = null;
    this._statsTimer = 0;
    this._controllers = [];
  }

  build({ sceneManager }) {
    if (this.gui) return this;
    const gui = new GUI({ title: '⚙ 游乐场 · 升级控制台', autoPlace: false, width: 288 });
    gui.domElement.classList.add('pg-gui');
    gui.domElement.style.position = 'fixed';
    gui.domElement.style.right = '16px';
    gui.domElement.style.bottom = '116px';
    gui.domElement.style.zIndex = '30';
    document.body.appendChild(gui.domElement);
    this.gui = gui;

    const state = {
      mode: movementMode.mode,
      engaged: movementMode.engaged,
      eyeHeight: 1.7,
      bloom: sceneManager?.bloomPass?.strength ?? 0.06,
      fxaa: sceneManager?.fxaaPass?.enabled ?? true,
      forceNoCull: renderOptimizer.forceNoCull,
      labels: districtLabels.visible !== false,
      calls: 0,
      triangles: 0,
      fps: 0,
    };

    const fMove = gui.addFolder('🚶 移动模式（F 切换 / Esc 交还）');
    const cMode = fMove.add(state, 'mode', { '地面行走 (1.7m)': 'ground', '飞行漫游': 'flight' })
      .name('当前模式')
      .onChange((v) => movementMode.setMode(v));
    fMove.add(state, 'engaged').name('接管相机').listen()
      .onChange((v) => { if (v) movementMode.engage(); else movementMode.disengage(); });
    fMove.add({ switchMode: () => { movementMode.toggle(); state.mode = movementMode.mode; cMode.updateDisplay(); } }, 'switchMode').name('切换模式 [F]');
    fMove.add({ release: () => { movementMode.disengage(); state.engaged = false; } }, 'release').name('交还观察视角 [Esc]');
    fMove.add(movementMode.stats, 'registeredColliders').name('BVH 登记碰撞体').listen();
    fMove.add(movementMode.stats, 'bvhTriangles').name('BVH 三角形数').listen();
    fMove.add(movementMode.stats, 'bvhPushOuts').name('BVH 防穿模推出次数').listen();

    const fRender = gui.addFolder('✨ 渲染 / 后处理');
    fRender.add(state, 'bloom', 0, 0.6, 0.01).name('Bloom 光晕强度')
      .onChange((v) => { if (sceneManager?.bloomPass) sceneManager.bloomPass.strength = v; });
    fRender.add(state, 'fxaa').name('FXAA 抗锯齿')
      .onChange((v) => { if (sceneManager?.fxaaPass) sceneManager.fxaaPass.enabled = v; });
    fRender.add(state, 'forceNoCull').name('强制关闭视锥剔除')
      .onChange((v) => renderOptimizer.setForceNoCull(v));
    fRender.add(renderOptimizer.stats, 'lodsPinned').name('高模 LOD 数').listen();
    fRender.add(renderOptimizer.stats, 'boundsFixed').name('包围体修正数').listen();
    fRender.add(renderOptimizer.stats, 'mipmapsApplied').name('Mipmap 修正数').listen();

    const fUI = gui.addFolder('🏷 区域标识');
    fUI.add(state, 'labels').name('显示区域标签')
      .onChange((v) => districtLabels.setVisible(v));

    const fStats = gui.addFolder('📊 实时统计');
    const cCalls = fStats.add(state, 'calls').name('draw calls').listen().disable();
    const cTris = fStats.add(state, 'triangles').name('triangles').listen().disable();
    const cFps = fStats.add(state, 'fps').name('FPS').listen().disable();

    // FPS 用独立 rAF 计数（不向主渲染循环注入事件 / 不在热路径 new 对象）
    let frames = 0;
    let last = performance.now();
    let rafId = 0;
    const tick = () => { frames += 1; rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
    this._stopTick = () => cancelAnimationFrame(rafId);
    this._statsTimer = window.setInterval(() => {
      const info = sceneManager?.renderer?.info?.render;
      const now = performance.now();
      state.calls = info?.calls ?? 0;
      state.triangles = info?.triangles ?? 0;
      state.fps = Math.round((frames * 1000) / Math.max(1, now - last));
      frames = 0; last = now;
      cCalls.updateDisplay(); cTris.updateDisplay(); cFps.updateDisplay();
      cMode.updateDisplay();
    }, 1000);

    gui.close(); // 默认折叠，不遮挡画面
    return this;
  }

  dispose() {
    if (this._statsTimer) window.clearInterval(this._statsTimer);
    this._stopTick?.();
    this.gui?.destroy();
    this.gui = null;
  }
}

export const debugPanel = new DebugPanel();
export default debugPanel;
