/**
 * ============================================================================
 * PerfMonitor —— 手册 P6「集成 stats.js 实时监测」的零依赖等价实现
 * ============================================================================
 * 仅开发环境 + URL ?perf=1 时挂载左上角面板：FPS / 单帧 ms / GPU 几何 / 纹理。
 * 不引入外部包（手册硬约束：不下载外部资源）；采样窗口 500ms，DOM 只改 textContent。
 * 生产构建 import.meta.env.DEV=false → maybeCreate 直接返回 null，零开销。
 * ============================================================================
 */

export class PerfMonitor {
  constructor(renderer) {
    this._renderer = renderer;
    this._frames = 0;
    this._windowStart = performance.now();
    this._el = document.createElement('div');
    this._el.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;'
      + 'font:12px/1.5 monospace;color:#0f0;background:rgba(0,0,0,0.72);'
      + 'padding:6px 10px;border-radius:6px;pointer-events:none;white-space:pre;';
    this._el.textContent = 'perf: warming up…';
    document.body.appendChild(this._el);
  }

  static maybeCreate(renderer) {
    if (!import.meta.env.DEV) return null;
    if (!new URLSearchParams(window.location.search).has('perf')) return null;
    return new PerfMonitor(renderer);
  }

  /** 渲染循环每帧调用；满 500ms 窗口才写一次 DOM */
  sample(now = performance.now()) {
    this._frames += 1;
    const span = now - this._windowStart;
    if (span < 500) return;
    const fps = (this._frames * 1000) / span;
    const ms = span / this._frames;
    const mem = this._renderer.info.memory;
    this._el.textContent = `FPS ${fps.toFixed(1)}  |  ${ms.toFixed(2)} ms\n`
      + `geo ${mem.geometries}  tex ${mem.textures}`;
    this._frames = 0;
    this._windowStart = now;
  }

  dispose() {
    this._el.remove();
    this._el = null;
  }
}

export default PerfMonitor;