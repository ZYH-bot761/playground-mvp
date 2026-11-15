/**
 * ============================================================================
 * QualityTier —— 手册 P6 移动端 / 低端设备自动降级
 * ============================================================================
 * 检测依据（手册指定）：navigator.hardwareConcurrency + 指针粗精（触控设备）。
 * 三档预设只改「渲染开销旋钮」，不改玩法逻辑：
 *   high   桌面：pixelRatio≤2、Bloom 开、阴影 2048、折射半分辨率
 *   medium 中端手机：pixelRatio≤2（手册上限）、Bloom 关、阴影 1024、折射 0.35
 *   low    低端（≤4 核）：pixelRatio≤1.25、Bloom 关、阴影 512、折射 0.25
 * URL ?quality=high|medium|low 可强制档位（验收 /  profiling 用）。
 * ============================================================================
 */

export const QUALITY_PRESETS = Object.freeze({
  high: Object.freeze({ pixelRatioCap: 2, bloom: true, shadowMapSize: 2048, transmissionScale: 0.5 }),
  medium: Object.freeze({ pixelRatioCap: 2, bloom: false, shadowMapSize: 1024, transmissionScale: 0.35 }),
  low: Object.freeze({ pixelRatioCap: 1.25, bloom: false, shadowMapSize: 512, transmissionScale: 0.25 }),
});

export function detectQualityTier() {
  const override = new URLSearchParams(window.location.search).get('quality');
  if (override === 'high' || override === 'medium' || override === 'low') return override;
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 4) return 'low';
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  return coarse ? 'medium' : 'high';
}