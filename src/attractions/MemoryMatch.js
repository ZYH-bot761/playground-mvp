/**
 * ============================================================================
 * MemoryMatch —— 记忆翻牌（第三个游乐项目）
 * ============================================================================
 * 玩法：悬空魔法阵上摆 12 张背面朝上的卡牌（6 对图案）。点击翻牌，一次最多
 *       翻开两张；图案相同则保持翻开并 +5 分，不同则 0.8 秒后自动翻回。
 *       6 对全部配对后按用时结算奖励分（60 秒内每提前 1 秒 +1 分，上限 40）。
 *
 * 【单文件闭环】场景、动画、状态机、计时、存档、UI（DOM + CSS）、资源清理
 *   全部在本类内实现；不 import、不修改 core/ 下任何基座模块。
 *
 * 【IAttraction 契约】init(ctx) / update(dt) / onInteract(hitInfo) / dispose()
 *   四方法齐全；dispose() 幂等；root 挂到 ctx.scene，从场景移除交由
 *   AttractionManager 第 ③ 步；项目内绝不调用 world.step()。
 *
 * ---------------------------------------------------------------------------
 * 【本项目关键实现约定】
 *   1. 全程不使用 Rapier：没有刚体 / collider；点击靠 InteractionManager 分发的
 *      Raycaster 命中列表（hitInfo.intersections）向上找 userData.mmCardIndex。
 *   2. 翻面是补间动画：每张卡记录 openAmount(0=背面朝观众, 1=正面朝观众)，
 *      update 里按 easeOutCubic 推进 FLIP_DURATION 秒，旋转 mesh.rotation.y =
 *      π·(1-openAmount)，绝不瞬变；同一卡在动画期间拒绝再次点击。
 *   3. 卡牌是带厚度的 BoxGeometry。默认 BoxGeometry 每面一个 group → 6 次
 *      draw call；这里把「非正面」合并成一个 group，只保留 3 组：
 *        indices 0..23 → 侧面/上下（统一金边材质）
 *        indices 24..29 → +z 正面（该对的 CanvasTexture 图案）
 *        indices 30..35 → -z 背面（统一深色花纹）
 *   4. 正面图案全部用 Canvas 2D 程序化绘制到 CanvasTexture（星星 / 南瓜 /
 *      幽灵 / 蝙蝠 / 水晶 / 糖果），无任何外部图片；6 张正面纹理 + 1 张背面
 *      纹理共 7 张 CanvasTexture，全部进 _textures 台账并在 dispose 中释放。
 *   5. 0.8 秒翻回不依赖 setTimeout，而是 update 内累计 _mismatchTimer，
 *      卸载后自然停止，不会留下定时器。
 * ---------------------------------------------------------------------------
 * 【热基线验收口径】main.js 在本项目预热后固定 Lobby 基线；多轮
 *   「大厅 → 记忆翻牌 → 大厅」后 renderer.info.memory 的 geometries /
 *   textures 必须回到基线（差值 0）。因此 init 一次性建完所有几何 / 材质 /
 *   纹理，update 只改属性，绝不惰性新建 GPU 资源。
 * ============================================================================
 */

import * as THREE from 'three';
import audioManager from '../core/AudioManager.js';
import { IAttraction } from './IAttraction.js';
import PauseMenu from '../ui/PauseMenu.js';

/* ========================================================================== */
/* 常量配置（参数锁定，无占位符）                                              */
/* ========================================================================== */

const STATE = Object.freeze({ READY: 'ready', PLAYING: 'playing', OVER: 'over' });

const CARD_COUNT = 12; // 12 张卡
const PAIR_COUNT = 6; // 6 对
const SCORE_PER_PAIR = 5; // 每配对成功 5 分
const FLIP_DURATION = 0.45; // 翻面补间时长（秒）
const MISMATCH_DELAY = 0.8; // 不匹配后自动翻回的等待（秒）
const BONUS_WINDOW = 60; // 用时奖励窗口（秒）
const BONUS_MAX = 40; // 用时奖励上限
const BEST_SCORE_KEY = 'playground.memory-match.bestScore';

const CARD_W = 1.5;
const CARD_H = 2.0;
const CARD_T = 0.14; // 卡牌厚度（BoxGeometry 的 z 向尺寸）
const COLS = 4;
const ROWS = 3;
const SPACING_X = 2.05;
const SPACING_Y = 2.55;
const FIRST_ROW_Y = 1.2;

/**
 * 固定的牌面分布（每对恰好出现两次，确定性布局 → 预热与运行时完全一致）。
 * 0..5 依次对应 SYMBOLS 的六个图案。
 */
const PAIR_LAYOUT = Object.freeze([0, 3, 1, 4, 2, 5, 4, 0, 5, 2, 3, 1]);

/** 六种正面图案的配色（绘制阶段用） */
const SYMBOLS = Object.freeze([
  { key: 'star', accent: '#ffd166', glow: 'rgba(255,209,102,0.40)' },
  { key: 'pumpkin', accent: '#ff9a3c', glow: 'rgba(255,154,60,0.40)' },
  { key: 'ghost', accent: '#e2edff', glow: 'rgba(200,225,255,0.40)' },
  { key: 'bat', accent: '#b389ff', glow: 'rgba(179,137,255,0.40)' },
  { key: 'crystal', accent: '#6fe3ff', glow: 'rgba(111,227,255,0.40)' },
  { key: 'candy', accent: '#ff8fc4', glow: 'rgba(255,143,196,0.40)' },
]);

/* ========================================================================== */
/* 程序化 Canvas 纹理（零外部资源）                                            */
/* ========================================================================== */

/** 正面：深蓝紫卡面 + 金色描边 + 居中发光图案 */
function makeFrontTexture(symbol) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');

  // 底：斜向深蓝紫渐变
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#2d3868');
  grad.addColorStop(0.55, '#1b2246');
  grad.addColorStop(1, '#0e1430');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // 细斜纹（工艺感）
  g.strokeStyle = 'rgba(130,170,255,0.09)';
  g.lineWidth = 1;
  for (let i = -size; i < size * 2; i += 12) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + size, size);
    g.stroke();
  }

  // 双层金色描边
  g.strokeStyle = '#e8c472';
  g.lineWidth = 5;
  g.strokeRect(10, 10, size - 20, size - 20);
  g.strokeStyle = 'rgba(232,196,114,0.45)';
  g.lineWidth = 2;
  g.strokeRect(20, 20, size - 40, size - 40);

  // 四角菱形装饰
  g.fillStyle = 'rgba(232,196,114,0.75)';
  for (const [dx, dy] of [[26, 26], [size - 26, 26], [26, size - 26], [size - 26, size - 26]]) {
    g.beginPath();
    g.moveTo(dx, dy - 7);
    g.lineTo(dx + 7, dy);
    g.lineTo(dx, dy + 7);
    g.lineTo(dx - 7, dy);
    g.closePath();
    g.fill();
  }

  // 图案底光
  const cx = size / 2;
  const cy = size / 2 - 4;
  const halo = g.createRadialGradient(cx, cy, 6, cx, cy, 96);
  halo.addColorStop(0, symbol.glow);
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(cx, cy, 96, 0, Math.PI * 2);
  g.fill();

  // 图案本体（局部坐标，s = 图案半径）
  g.save();
  g.translate(cx, cy);
  g.shadowColor = symbol.accent;
  g.shadowBlur = 18;
  drawSymbol(g, symbol.key, 66, symbol.accent);
  g.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `mm/front-${symbol.key}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 背面：统一深色花纹（暗蓝底 + 金线菱形网格 + 中央八角徽记） */
function makeBackTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');

  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#18203f');
  grad.addColorStop(0.6, '#101733');
  grad.addColorStop(1, '#080c1e');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // 菱形网格
  g.strokeStyle = 'rgba(201,162,74,0.20)';
  g.lineWidth = 1.5;
  const step = 26;
  for (let i = -size; i < size * 2; i += step) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + size, size);
    g.stroke();
    g.beginPath();
    g.moveTo(i, size);
    g.lineTo(i + size, 0);
    g.stroke();
  }

  // 外框
  g.strokeStyle = '#c9a24a';
  g.lineWidth = 5;
  g.strokeRect(9, 9, size - 18, size - 18);
  g.strokeStyle = 'rgba(201,162,74,0.35)';
  g.lineWidth = 1.5;
  g.strokeRect(19, 19, size - 38, size - 38);

  // 中央八角徽记
  const cx = size / 2;
  const cy = size / 2;
  g.save();
  g.translate(cx, cy);
  g.strokeStyle = 'rgba(226,190,110,0.85)';
  g.lineWidth = 3;
  g.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const r = 52;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.stroke();
  g.beginPath();
  g.arc(0, 0, 26, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(0, 0, 9, 0, Math.PI * 2);
  g.fillStyle = 'rgba(226,190,110,0.9)';
  g.fill();
  g.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'mm/card-back';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 六种图案路径（全部 Canvas 2D 矢量，居中绘制，s 为半径） */
function drawSymbol(g, key, s, accent) {
  g.fillStyle = accent;
  g.strokeStyle = accent;
  g.lineWidth = 3;

  if (key === 'star') {
    g.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const r = i % 2 === 0 ? s : s * 0.44;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
  } else if (key === 'pumpkin') {
    g.shadowBlur = 0;
    for (const dx of [-s * 0.58, 0, s * 0.58]) {
      g.beginPath();
      g.ellipse(dx, 0, s * (dx === 0 ? 0.62 : 0.4), s * 0.78, 0, 0, Math.PI * 2);
      g.fill();
    }
    // 瓜蒂
    g.fillStyle = '#4c7a2e';
    g.beginPath();
    g.moveTo(-s * 0.07, -s * 0.72);
    g.lineTo(s * 0.09, -s * 0.72);
    g.lineTo(s * 0.15, -s * 1.02);
    g.lineTo(-s * 0.13, -s * 1.02);
    g.closePath();
    g.fill();
    // 眼睛与锯齿嘴（灯笼感）
    g.fillStyle = '#2a1200';
    for (const dx of [-s * 0.28, s * 0.28]) {
      g.beginPath();
      g.moveTo(dx - s * 0.13, -s * 0.18);
      g.lineTo(dx + s * 0.13, -s * 0.18);
      g.lineTo(dx, s * 0.02);
      g.closePath();
      g.fill();
    }
    g.beginPath();
    g.moveTo(-s * 0.26, s * 0.26);
    g.lineTo(-s * 0.13, s * 0.38);
    g.lineTo(0, s * 0.26);
    g.lineTo(s * 0.13, s * 0.38);
    g.lineTo(s * 0.26, s * 0.26);
    g.strokeStyle = '#2a1200';
    g.lineWidth = 3;
    g.stroke();
  } else if (key === 'ghost') {
    g.shadowBlur = 0;
    g.beginPath();
    g.arc(0, -s * 0.16, s * 0.64, Math.PI, 0);
    g.lineTo(s * 0.64, s * 0.46);
    g.quadraticCurveTo(s * 0.42, s * 0.28, s * 0.20, s * 0.50);
    g.quadraticCurveTo(0, s * 0.30, -s * 0.20, s * 0.50);
    g.quadraticCurveTo(-s * 0.42, s * 0.28, -s * 0.64, s * 0.46);
    g.closePath();
    g.fill();
    g.fillStyle = '#1b2144';
    for (const dx of [-s * 0.24, s * 0.24]) {
      g.beginPath();
      g.ellipse(dx, -s * 0.20, s * 0.11, s * 0.15, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.beginPath();
    g.arc(0, s * 0.10, s * 0.14, 0, Math.PI);
    g.fill();
  } else if (key === 'bat') {
    g.shadowBlur = 0;
    g.beginPath();
    g.moveTo(0, -s * 0.12);
    g.quadraticCurveTo(-s * 0.48, -s * 0.62, -s * 0.98, -s * 0.30);
    g.quadraticCurveTo(-s * 0.60, -s * 0.02, -s * 0.38, s * 0.30);
    g.quadraticCurveTo(-s * 0.16, s * 0.06, 0, s * 0.34);
    g.quadraticCurveTo(s * 0.16, s * 0.06, s * 0.38, s * 0.30);
    g.quadraticCurveTo(s * 0.60, -s * 0.02, s * 0.98, -s * 0.30);
    g.quadraticCurveTo(s * 0.48, -s * 0.62, 0, -s * 0.12);
    g.closePath();
    g.fill();
    // 双耳
    for (const dx of [-1, 1]) {
      g.beginPath();
      g.moveTo(dx * s * 0.14, -s * 0.12);
      g.lineTo(dx * s * 0.30, -s * 0.56);
      g.lineTo(dx * s * 0.40, -s * 0.16);
      g.closePath();
      g.fill();
    }
    // 眼睛
    g.fillStyle = '#20122f';
    for (const dx of [-s * 0.16, s * 0.16]) {
      g.beginPath();
      g.ellipse(dx, -s * 0.04, s * 0.07, s * 0.09, 0, 0, Math.PI * 2);
      g.fill();
    }
  } else if (key === 'crystal') {
    g.beginPath();
    g.moveTo(0, -s * 0.98);
    g.lineTo(s * 0.62, -s * 0.18);
    g.lineTo(s * 0.30, s * 0.86);
    g.lineTo(-s * 0.30, s * 0.86);
    g.lineTo(-s * 0.62, -s * 0.18);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(0, -s * 0.98);
    g.lineTo(-s * 0.30, s * 0.86);
    g.moveTo(0, -s * 0.98);
    g.lineTo(s * 0.30, s * 0.86);
    g.moveTo(-s * 0.62, -s * 0.18);
    g.lineTo(s * 0.62, -s * 0.18);
    g.stroke();
  } else {
    // candy：中央糖果 + 两侧糖纸三角
    g.beginPath();
    g.arc(0, 0, s * 0.48, 0, Math.PI * 2);
    g.fill();
    for (const dir of [-1, 1]) {
      g.beginPath();
      g.moveTo(dir * s * 0.46, -s * 0.14);
      g.lineTo(dir * s * 0.98, -s * 0.62);
      g.lineTo(dir * s * 0.92, s * 0.34);
      g.lineTo(dir * s * 0.46, s * 0.14);
      g.closePath();
      g.fill();
    }
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 0, s * 0.26, 0.4, Math.PI * 1.5);
    g.stroke();
  }
}

/* ========================================================================== */
/* 纹理引用扫描（沿用 M2 修复后的契约：路径数组绝不去重，逐条断开引用）       */
/* ========================================================================== */

/** 递归扫描任意值里的 THREE.Texture，输出【不去重】的可断开引用路径 */
function scanTextureValue(value, path, out, seen, depth, replacer) {
  if (value == null || depth > 4) return;
  if (typeof value === 'object' && value.isTexture === true) {
    out.push({ texture: value, path, clear: () => replacer(null) });
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanTextureValue(value[i], `${path}[${i}]`, out, seen, depth + 1, (nv) => { value[i] = nv; });
    }
    return;
  }
  for (const k of Object.keys(value)) {
    scanTextureValue(value[k], `${path}.${k}`, out, seen, depth + 1, (nv) => { value[k] = nv; });
  }
}

/** 收集材质里所有纹理引用路径（标准槽位 + ShaderMaterial.uniforms 递归） */
function collectMaterialTextureReferences(material, index) {
  const out = [];
  if (!material) return out;
  for (const k of Object.keys(material)) {
    const value = material[k];
    if (value && value.isTexture === true) {
      out.push({ texture: value, path: `materials[${index}].${k}`, clear: () => { material[k] = null; } });
    }
  }
  const uniforms = material.uniforms;
  if (!uniforms || typeof uniforms !== 'object') return out;
  const seen = new WeakSet();
  for (const name of Object.keys(uniforms)) {
    const uniform = uniforms[name];
    if (!uniform || typeof uniform !== 'object') continue;
    const value = 'value' in uniform ? uniform.value : uniform;
    scanTextureValue(value, `materials[${index}].uniforms.${name}.value`, out, seen, 0,
      (nv) => { uniform.value = nv; });
  }
  return out;
}

/** 缓动：翻牌前段快、末段收，手感接近实体翻卡 */
function easeOutCubic(t) {
  const p = 1 - t;
  return 1 - p * p * p;
}

/* ========================================================================== */
/* DOM Overlay 样式（类内注入 <style>，dispose 时移除）                       */
/* ========================================================================== */

const UI_CSS = `
.mm-ui{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#eef3ff}
.mm-hud{position:absolute;top:calc(14px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
  display:flex;gap:16px;padding:9px 18px;border-radius:999px;white-space:nowrap;
  background:rgba(12,18,34,.82);border:1px solid rgba(150,180,255,.3);
  box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:15px;letter-spacing:.5px}
.mm-hud b{color:#ffce6a;font-size:18px}
.mm-hud[data-hidden='true']{display:none}
.mm-shade{position:absolute;inset:0;background:rgba(6,10,22,.55)}
.mm-panel{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  pointer-events:auto;width:min(440px,calc(100vw - 32px));padding:24px 26px 20px;
  max-height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  background:rgba(14,20,38,.95);border:1px solid rgba(190,165,255,.38);
  border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.55);text-align:center}
.mm-panel[data-hidden='true'],.mm-shade[data-hidden='true']{display:none}
.mm-panel__title{margin:0 0 10px;font-size:26px;font-weight:700;color:#ffd27a;
  text-shadow:0 0 18px rgba(255,190,90,.35)}
.mm-panel__desc{margin:0 0 8px;font-size:14px;line-height:1.6;color:#c8d6f5}
.mm-panel__hint{margin:0 0 14px;font-size:12px;line-height:1.7;color:#8fa4cf}
.mm-panel__score{margin:0 0 16px;padding:12px;border-radius:10px;
  background:rgba(120,160,255,.12);font-size:15px;line-height:1.9}
.mm-panel__score[data-hidden='true']{display:none}
.mm-panel__score b{color:#ffce6a;font-size:19px}
.mm-panel__buttons{display:flex;gap:10px;justify-content:center;margin-bottom:12px}
.mm-btn{flex:1;padding:10px 12px;font-size:14px;border-radius:9px;cursor:pointer;
  color:#dbe6ff;background:rgba(255,255,255,.08);border:1px solid rgba(160,190,255,.4)}
.mm-btn:hover{background:rgba(140,180,255,.22);border-color:rgba(190,215,255,.7)}
.mm-btn--primary{color:#10162a;font-weight:700;background:#ffce6a;border-color:#ffce6a}
.mm-btn--primary:hover{background:#ffdc92;border-color:#ffdc92}
.mm-btn[data-hidden='true']{display:none}
.mm-btn--exit{color:#ffe9b0;background:rgba(255,200,90,.14);border-color:rgba(255,200,90,.55)}
.mm-panel__note{margin:0;font-size:11px;line-height:1.6;color:#7f92b8}
@media (max-width:560px){
  .mm-hud{top:calc(8px + env(safe-area-inset-top, 0px));gap:8px;font-size:12px;padding:6px 12px;
    max-width:calc(100vw - 112px);flex-wrap:wrap;justify-content:center;
    white-space:normal;line-height:1.4}
  .mm-hud b{font-size:14px}
  .mm-panel{padding:18px 18px 16px}
  .mm-panel__title{font-size:22px}
  .mm-panel__buttons{flex-direction:column}
  .mm-btn{min-height:44px;font-size:15px}
}
@media (max-height:520px){
  .mm-panel{padding:16px 20px 14px;max-height:calc(100dvh - 20px)}
  .mm-panel__title{font-size:20px;margin-bottom:6px}
  .mm-panel__hint{display:none}
}
`;

/* ========================================================================== */
/* 项目实现                                                                    */
/* ========================================================================== */

export class MemoryMatch extends IAttraction {
  constructor() {
    super();

    /** 根节点：init 挂到 ctx.scene，由 AttractionManager 卸载时移除 */
    this.root = new THREE.Group();
    this.root.name = 'MemoryMatch';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;
    this._state = STATE.READY;

    // ---- 时钟 / 计分 ----
    this._time = 0;
    this._roundTime = 0;
    this._score = 0; // 本局配对分（进行中 HUD 显示）
    this._bestScore = 0;
    this._matchedPairs = 0;
    this._hudAccumulator = 0;

    // ---- 翻牌状态机 ----
    this._selected = [];
    this._locked = false;
    this._comparePending = false;
    this._mismatchTimer = 0;

    // ---- 相机接管（dispose 最前段恢复）----
    this._cameraSaved = null;
    this._lastAspect = 0; // 视口自适应：记录上次宽高比，避免每帧重算

    // ---- 卡牌台账 ----
    this._cards = [];
    this._pairMaterials = [];
    this._runeRings = [];

    // ---- Three 资源台账（Set 去重；登记到 registry 作二次兜底）----
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._shared = {};

    // ---- 定时器全登记 ----
    this._rafIds = new Set();
    this._intervalIds = new Set();
    this._timeoutIds = new Set();

    // ---- DOM / 事件登记 ----
    this._uiRoot = null;
    this._uiStyle = null;
    this._listeners = [];
    this._ui = {};
    this._pauseMenu = null;
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 创建魔法阵、12 张卡牌、7 张 CanvasTexture、DOM UI，进入准备态。
   * @param {Object} ctx IAttraction 契约上下文
   */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, camera } = ctx;
    if (!scene || !camera) throw new Error('[MemoryMatch] 缺少 scene / camera');
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    /* ---------- ① 接管相机（只改 ctx.camera 运行时状态，不改 core） ---------- */
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    camera.position.set(0, 3.7, 11.5);
    camera.lookAt(0, 3.7, 0);
    camera.updateMatrixWorld(true);
    this._fitViewport();

    /* ---------- 关键：挂根节点（漏了会造成「计数恒等基线」的假通过） ---------- */
    scene.add(this.root);

    /* ---------- ② 共享资源池：几何 / 材质 / 纹理一次性建完 ----------
     * update() 里绝不新建任何 GPU 资源，避免预热之后才惰性上传 = 「假泄漏」。
     */
    this._buildSharedResources();

    // Three 资源登记进 registry 作二次兜底（THREE dispose 幂等）
    for (const geo of this._geometries) register(geo);
    for (const mat of this._materials) register(mat);
    for (const tex of this._textures) register(tex);

    /* ---------- ③ 魔法阵 + 12 张卡 ---------- */
    this._buildBoard();

    /* ---------- ④ DOM UI ---------- */
    this._buildUI();
    this._pauseMenu = new PauseMenu({
      onRestart: () => this._startRound(),
      onExit: () => {
        this._pauseMenu?.dispose();
        this._ctx?.onExitAttraction?.();
      },
    }).attach();
    this._bestScore = this._readBestScore();
    this._setState(STATE.READY);

    // HUD 刷新定时器（真实用途，ID 登记）
    this._addInterval(() => this._renderHUD(), 100);

    console.info(
      `[MemoryMatch] init 完成 | 卡牌=${this._cards.length} 对=${PAIR_COUNT} | ` +
      `几何=${this._geometries.size} 材质=${this._materials.size} 纹理=${this._textures.size} | ` +
      `不使用 Rapier，点击走 Raycaster`
    );
  }

  _trackGeometry(geo) { this._geometries.add(geo); return geo; }
  _trackMaterial(mat) { this._materials.add(mat); return mat; }
  _trackTexture(tex) { this._textures.add(tex); return tex; }

  /** 几何 / 材质 / 纹理全部共享；纹理含 6 张正面 CanvasTexture + 1 张背面 */
  _buildSharedResources() {
    const geoPlatform = this._trackGeometry(new THREE.CylinderGeometry(5.3, 5.7, 0.55, 48));
    const geoRim = this._trackGeometry(new THREE.TorusGeometry(5.3, 0.07, 8, 72));
    const geoRune = this._trackGeometry(new THREE.TorusGeometry(1, 0.03, 8, 96));
    const geoHalo = this._trackGeometry(new THREE.PlaneGeometry(9.8, 9.8));

    // 卡牌盒：默认 6 个 group（每面一个）。合并为非正面 / 正面 / 背面 3 组，
    // 使每张卡只产生 3 次 draw call；材质数组顺序必须与 group 的 materialIndex 对齐。
    const geoCard = this._trackGeometry(new THREE.BoxGeometry(CARD_W, CARD_H, CARD_T));
    geoCard.clearGroups();
    geoCard.addGroup(0, 24, 0); // +x / -x / +y / -y：统一金边
    geoCard.addGroup(24, 6, 1); // +z：正面图案
    geoCard.addGroup(30, 6, 2); // -z：统一背面花纹

    const texBack = this._trackTexture(makeBackTexture());
    const frontTextures = SYMBOLS.map((s) => this._trackTexture(makeFrontTexture(s)));

    const matEdge = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xd9bd74, metalness: 0.85, roughness: 0.28,
    }));
    const matDeck = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x141c34, metalness: 0.55, roughness: 0.42,
    }));
    const matBack = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texBack, metalness: 0.25, roughness: 0.52,
      emissive: 0x0a1028, emissiveIntensity: 0.23,
    }));
    const matRuneGold = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x2a2416, emissive: 0xffb651, emissiveIntensity: 0.57,
      metalness: 0, roughness: 0.65, toneMapped: true,
      transparent: true, opacity: 0.85, depthWrite: false,
    }));
    const matRuneViolet = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x1d1630, emissive: 0x9a63f0, emissiveIntensity: 0.8,
      metalness: 0, roughness: 0.65, toneMapped: true,
      transparent: true, opacity: 0.8, depthWrite: false,
    }));
    const matHalo = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x0a1030, emissive: 0x1b3a8a, emissiveIntensity: 0.42,
      metalness: 0, roughness: 0.9,
      transparent: true, opacity: 0.26, side: THREE.DoubleSide,
      depthWrite: false, toneMapped: true,
    }));

    // 六对正面材质：共享同一 CanvasTexture，配对成功时成对高亮
    const pairMaterials = [];
    for (let i = 0; i < PAIR_COUNT; i += 1) {
      pairMaterials.push(this._trackMaterial(new THREE.MeshStandardMaterial({
        color: 0xffffff, map: frontTextures[i], metalness: 0.18, roughness: 0.54,
        emissive: 0x141a34, emissiveIntensity: 0.21,
      })));
    }
    this._pairMaterials = pairMaterials;

    this._shared = {
      geoPlatform, geoRim, geoRune, geoHalo, geoCard,
      matEdge, matDeck, matBack, matRuneGold, matRuneViolet, matHalo,
      texBack, frontTextures,
    };
  }

  /** 悬空平台 + 边缘金环 + 背景双层魔法阵 + 12 张背面朝上的卡 */
  _buildBoard() {
    const S = this._shared;

    const platform = new THREE.Mesh(S.geoPlatform, S.matDeck);
    platform.name = 'MemoryMatch/platform';
    platform.position.y = -0.32;
    platform.castShadow = true;
    platform.receiveShadow = true;
    this.root.add(platform);

    const rim = new THREE.Mesh(S.geoRim, S.matEdge);
    rim.name = 'MemoryMatch/platform-rim';
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = -0.04;
    rim.castShadow = false;
    this.root.add(rim);

    // 背景光晕盘（半透明，只负责氛围，不参与拾取）
    const halo = new THREE.Mesh(S.geoHalo, S.matHalo);
    halo.name = 'MemoryMatch/halo';
    halo.position.set(0, 3.75, -1.1);
    this.root.add(halo);

    // 双层发光符文环：init 建好，update 只改 scale（微弱的呼吸感）
    const ringSpecs = [
      { radius: 4.75, mat: S.matRuneGold, speed: 1.6, phase: 0 },
      { radius: 3.55, mat: S.matRuneViolet, speed: 2.1, phase: 1.4 },
      { radius: 2.35, mat: S.matRuneGold, speed: 2.6, phase: 2.9 },
    ];
    for (const spec of ringSpecs) {
      const ring = new THREE.Mesh(S.geoRune, spec.mat);
      ring.name = 'MemoryMatch/rune-ring';
      ring.scale.setScalar(spec.radius);
      ring.position.set(0, 3.75, -0.98);
      this.root.add(ring);
      this._runeRings.push({ mesh: ring, radius: spec.radius, speed: spec.speed, phase: spec.phase });
    }

    // 12 张卡：确定性布局，初始 rotation.y = π（-z 面朝观众 = 背面）
    for (let i = 0; i < CARD_COUNT; i += 1) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = (col - (COLS - 1) / 2) * SPACING_X;
      const y = FIRST_ROW_Y + row * SPACING_Y;
      const pairId = PAIR_LAYOUT[i];

      const mesh = new THREE.Mesh(S.geoCard, [S.matEdge, this._pairMaterials[pairId], S.matBack]);
      mesh.name = `MemoryMatch/card-${i}`;
      mesh.position.set(x, y, 0);
      mesh.rotation.y = Math.PI;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.mmCardIndex = i; // Raycaster 命中后据此回查卡牌记录
      this.root.add(mesh);

      this._cards.push({
        index: i,
        pairId,
        mesh,
        state: 'closed', // closed / opening / open / closing / matched
        openAmount: 0, // 0 = 背面朝观众，1 = 正面朝观众
        flipFrom: 0,
        flipTo: 0,
        flipElapsed: 0,
        flipping: false,
        matched: false,
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 定时器 / 事件登记助手                                                     */
  /* ------------------------------------------------------------------------ */

  _addInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this._intervalIds.add(id);
    return id;
  }

  _addTimeout(fn, ms) {
    const id = setTimeout(() => {
      this._timeoutIds.delete(id);
      fn();
    }, ms);
    this._timeoutIds.add(id);
    return id;
  }

  _addListener(target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push({ target, type, fn });
  }

  _clearAllTimers() {
    for (const id of this._rafIds) cancelAnimationFrame(id);
    for (const id of this._intervalIds) clearInterval(id);
    for (const id of this._timeoutIds) clearTimeout(id);
    this._rafIds.clear();
    this._intervalIds.clear();
    this._timeoutIds.clear();
  }

  /* ------------------------------------------------------------------------ */
  /* UI                                                                       */
  /* ------------------------------------------------------------------------ */

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'mm-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'mm-ui';
    this._uiRoot.innerHTML = `
      <div class="mm-hud" data-mm-interactive data-role="hud">
        <span>用时 <b data-role="time">0.0</b> s</span>
        <span>得分 <b data-role="score">0</b></span>
        <span>配对 <b data-role="pairs">0/6</b></span>
      </div>
      <div class="mm-shade" data-role="shade"></div>
      <div class="mm-panel" data-mm-interactive data-role="panel">
        <div class="mm-panel__title" data-role="title">记忆翻牌</div>
        <p class="mm-panel__desc" data-role="desc"></p>
        <p class="mm-panel__hint">点击卡牌翻开，一次最多两张；图案相同即配对成功（每对 +5 分），不同则 0.8 秒后自动翻回。6 对全部配对后按用时结算奖励分。</p>
        <div class="mm-panel__score" data-role="score-block"></div>
        <div class="mm-panel__buttons">
          <button type="button" class="mm-btn mm-btn--primary" data-action="start" data-role="primary">开始</button>
          <button type="button" class="mm-btn" data-action="restart">重新开始</button>
        </div>
        <div class="mm-panel__buttons">
          <button type="button" class="mm-btn mm-btn--exit" data-action="exit" data-role="exit" data-hidden="true">🎠 返回游乐场</button>
        </div>
        <p class="mm-panel__note">退出本项目也可使用左上角卸载按钮；结算后点「🎠 返回游乐场」回到大厅。</p>
      </div>
    `;
    document.body.appendChild(this._uiRoot);

    const q = (role) => this._uiRoot.querySelector(`[data-role="${role}"]`);
    this._ui = {
      hud: q('hud'), shade: q('shade'), panel: q('panel'),
      title: q('title'), desc: q('desc'), scoreBlock: q('score-block'),
      time: q('time'), score: q('score'), pairs: q('pairs'),
      primary: q('primary'), exit: q('exit'),
    };

    // 单一事件委托监听器，登记后统一解绑
    this._addListener(this._uiRoot, 'click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || !this._uiRoot.contains(button)) return;
      if (button.dataset.action === 'start') this._startRound();
      if (button.dataset.action === 'restart') this._resetToReady();
      if (button.dataset.action === 'exit') {
        const fn = this._ctx?.onExitAttraction;
        if (typeof fn === 'function') fn();
        else console.warn('[MemoryMatch] 缺少 ctx.onExitAttraction，无法返回游乐场');
      }
    });
  }

  /** 判断落点是否压在 UI 上（HUD / 面板），防止 UI 点击穿透到卡牌 */
  _isPointerOverUI(event) {
    if (!this._uiRoot || !event) return false;
    const nodes = this._uiRoot.querySelectorAll('[data-mm-interactive]');
    for (const node of nodes) {
      if (node.offsetParent === null) continue; // display:none
      const r = node.getBoundingClientRect();
      if (event.clientX >= r.left && event.clientX <= r.right &&
          event.clientY >= r.top && event.clientY <= r.bottom) return true;
    }
    return false;
  }

  _renderHUD() {
    if (this._disposed || !this._ui.time) return;
    this._ui.time.textContent = this._roundTime.toFixed(1);
    this._ui.score.textContent = String(this._score);
    this._ui.pairs.textContent = `${this._matchedPairs}/${PAIR_COUNT}`;
  }

  _setState(next, reason = '') {
    this._state = next;
    if (this._disposed || !this._ui.panel) return;
    const playing = next === STATE.PLAYING;
    this._ui.panel.dataset.hidden = String(playing);
    this._ui.shade.dataset.hidden = String(playing);
    this._ui.hud.dataset.hidden = String(next === STATE.READY);
    if (this._ui.exit) this._ui.exit.dataset.hidden = String(next !== STATE.OVER);

    if (next === STATE.READY) {
      this._ui.title.textContent = '记忆翻牌';
      this._ui.desc.textContent = '悬空魔法阵上的 12 张卡牌，翻开两张找相同图案。6 对全部配对即可通关。';
      this._ui.primary.textContent = '开始';
      this._ui.scoreBlock.dataset.hidden = 'true';
    } else if (next === STATE.OVER) {
      this._ui.title.textContent = reason === '全部配对！' ? '全部配对！' : '本局结束';
      this._ui.desc.textContent = '12 张卡牌已全部翻开，可以再来一局挑战更高分。';
      this._ui.primary.textContent = '再玩一次';
      this._ui.scoreBlock.dataset.hidden = 'false';
    }
    this._renderHUD();
  }

  _startRound() {
    if (this._disposed) return;
    this._resetRound();
    this._setState(STATE.PLAYING);
    console.info('[MemoryMatch] 开局：6 对 / 每对 5 分 / 用时奖励');
  }

  /** 「重新开始」= 清空本局并回到准备态（不卸载项目，出口在左上角 / 结算面板） */
  _resetToReady() {
    if (this._disposed) return;
    this._resetRound();
    this._setState(STATE.READY);
    console.info('[MemoryMatch] 已重新开始（回到准备态）');
  }

  /** 复位卡牌与本局状态（开局 / 重新开始 / 预热结束共用） */
  _resetRound() {
    this._roundTime = 0;
    this._score = 0;
    this._matchedPairs = 0;
    this._selected = [];
    this._locked = false;
    this._comparePending = false;
    this._mismatchTimer = 0;
    this._hudAccumulator = 0;

    for (const card of this._cards) {
      card.state = 'closed';
      card.openAmount = 0;
      card.flipFrom = 0;
      card.flipTo = 0;
      card.flipElapsed = 0;
      card.flipping = false;
      card.matched = false;
      card.mesh.rotation.y = Math.PI;
    }
    for (const mat of this._pairMaterials) {
      mat.emissive.setHex(0x141a34);
      mat.emissiveIntensity = 0.21;
    }
    this._renderHUD();
  }

  _endRound() {
    if (this._disposed || this._state !== STATE.PLAYING) return;

    const base = this._score; // 6 对 × 5 = 30
    const bonus = Math.max(0, Math.min(BONUS_MAX, Math.floor(BONUS_WINDOW - this._roundTime)));
    const total = base + bonus;

    if (total > this._bestScore) {
      this._bestScore = total;
      this._writeBestScore(this._bestScore);
    }

    this._setState(STATE.OVER, '全部配对！');
    if (this._ui.scoreBlock) {
      this._ui.scoreBlock.innerHTML =
        `本局得分 <b>${total}</b><br>` +
        `配对 <b>${this._matchedPairs}/${PAIR_COUNT}</b> · 配对分 <b>${base}</b> · 用时奖励 <b>+${bonus}</b><br>` +
        `用时 <b>${this._roundTime.toFixed(1)}</b> s · 历史最高分 <b>${this._bestScore}</b>`;
    }
    console.info(
      `[MemoryMatch] 结算：配对分 ${base} + 用时奖励 ${bonus} = ${total} 分 | ` +
      `用时 ${this._roundTime.toFixed(1)}s | 最高 ${this._bestScore} 分`
    );
  }

  _readBestScore() {
    try {
      const n = Number.parseInt(window.localStorage.getItem(BEST_SCORE_KEY) ?? '0', 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0; // 隐私模式 / 禁用 storage 时静默降级
    }
  }

  _writeBestScore(value) {
    try {
      window.localStorage.setItem(BEST_SCORE_KEY, String(value));
    } catch {
      // 写入失败不影响游玩
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 翻牌状态机                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * 翻开一张卡。三道闸门：① 进行中；② 未处于比较锁；③ 该卡完全闭合。
   * 一次最多两张：第二张选完后立刻上锁，直到匹配结算 / 自动翻回结束。
   */
  _pickCard(card) {
    if (this._disposed || this._state !== STATE.PLAYING) return false;
    if (this._locked) return false;
    if (!card || card.matched || card.state !== 'closed') return false;

    this._selected.push(card);
    this._startFlip(card, true);
    audioManager.playFlip(); // 未解锁 / 静音时静默返回 false，不抛错
    this._renderHUD();

    if (this._selected.length === 2) {
      this._locked = true;
      this._comparePending = true;
    }
    return true;
  }

  /** 启动一次补间翻面（open=true 正面朝观众，false 背面朝观众） */
  _startFlip(card, open) {
    card.flipFrom = card.openAmount;
    card.flipTo = open ? 1 : 0;
    card.flipElapsed = 0;
    card.flipping = true;
    card.state = open ? 'opening' : 'closing';
  }

  /** 每帧推进翻面补间；全部翻完时结算这一对 */
  _updateFlips(dt) {
    let settled = false;
    for (const card of this._cards) {
      if (!card.flipping) continue;
      card.flipElapsed += dt;
      const t = Math.min(1, card.flipElapsed / FLIP_DURATION);
      const e = easeOutCubic(t);
      card.openAmount = card.flipFrom + (card.flipTo - card.flipFrom) * e;
      card.mesh.rotation.y = Math.PI * (1 - card.openAmount);

      if (t >= 1) {
        card.openAmount = card.flipTo;
        card.mesh.rotation.y = Math.PI * (1 - card.openAmount);
        card.flipping = false;
        card.state = card.matched ? 'matched' : (card.flipTo === 1 ? 'open' : 'closed');
        settled = true;
      }
    }
    if (settled) this._afterFlipSettled();
  }

  /** 两张都翻开后判定：相同 → 立即配对；不同 → 启动 0.8s 翻回计时 */
  _afterFlipSettled() {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    if (!this._comparePending || this._selected.length !== 2) return;
    const [a, b] = this._selected;
    if (a.openAmount < 1 || b.openAmount < 1) return; // 还在等另一张翻完

    this._comparePending = false;

    if (a.pairId === b.pairId) {
      // 配对成功：两张保持翻开并高亮
      a.matched = true;
      b.matched = true;
      a.state = 'matched';
      b.state = 'matched';
      const mat = this._pairMaterials[a.pairId];
      mat.emissive.setHex(0x8a6a12);
      mat.emissiveIntensity = 0.57;

      this._score += SCORE_PER_PAIR;
      this._matchedPairs += 1;
      audioManager.playScore(); // 配对得分音
      this._selected = [];
      this._locked = false;
      this._renderHUD();

      console.info(
        `[MemoryMatch] 配对成功 +${SCORE_PER_PAIR} 分 | 已完成 ${this._matchedPairs}/${PAIR_COUNT}`
      );
      if (this._matchedPairs >= PAIR_COUNT) this._endRound();
    } else {
      // 不匹配：0.8 秒后自动翻回（计时在 update 内推进，不依赖 setTimeout）
      this._mismatchTimer = MISMATCH_DELAY;
      console.info('[MemoryMatch] 图案不同，0.8 秒后自动翻回');
    }
  }

  /** 翻回两张不匹配的卡并解锁 */
  _flipBackSelected() {
    for (const card of this._selected) {
      if (!card.matched) this._startFlip(card, false);
    }
    this._selected = [];
    this._locked = false;
  }

  /* ------------------------------------------------------------------------ */
  /* onInteract                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * InteractionManager 分发的点击：从命中列表里找第一张带 mmCardIndex 的卡。
   * 所有遮挡物（平台 / 符文环 / 光晕盘）都在卡牌之后或不相交，取「首个卡牌」
   * 语义即可；不在 canvas 上或压在 UI 面板上的点击一律忽略。
   */
  onInteract(hitInfo) {
    if (this._disposed || this._state !== STATE.PLAYING) return;
    const event = hitInfo?.event;
    const canvas = this._ctx?.renderer?.domElement;
    if (!event || !canvas || event.target !== canvas) return;
    if (this._isPointerOverUI(event)) return;

    const intersections = hitInfo?.intersections || [];
    let target = null;
    for (const hit of intersections) {
      const idx = hit?.object?.userData?.mmCardIndex;
      if (typeof idx === 'number') {
        target = this._cards[idx];
        break;
      }
    }
    if (!target) return;
    this._pickCard(target);
  }

  /* ------------------------------------------------------------------------ */
  /* update                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * 视口自适应：竖屏时先适度后退、再补 fov，让 4 列卡阵（含外框）完整入画；桌面保持 55° 与 11.5 机位。
   * 只在宽高比变化时执行。
   */
  _fitViewport() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    const a = camera.aspect;
    if (Math.abs(a - this._lastAspect) < 0.01) return;
    this._lastAspect = a;

    const baseDist = 11.5; // 桌面机位
    const need = 5.5; // 最外圈装饰环半径 5.3 + 光晕余量（此前 4.75 会把它裁掉）
    const ringDepth = 1.1; // 外环位于卡阵平面之后（z=-1.1），按最深处计算水平半宽
    const a1 = Math.min(a, 1);
    const tanBase = Math.tan((55 * Math.PI) / 360); // 55° 的一半
    // 竖屏：优先后退（最多 1.35 倍），不够再用更大的 fov 兜底，避免过度广角变形
    const dist = a1 >= 1 ? baseDist : Math.min(baseDist * 1.35, need / (tanBase * a1));
    camera.position.set(0, 3.7, dist);
    camera.lookAt(0, 3.7, 0);

    const tanV = need / ((dist + ringDepth) * a1);
    const fov = THREE.MathUtils.clamp((2 * Math.atan(tanV) * 180) / Math.PI, 55, 88);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  }

  /** 由基座 SceneManager 统一驱动；不自建 rAF、不调用 world.step() */
  update(deltaTime) {
    if (this._disposed) return;
    this._fitViewport();
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    this._time += dt;

    // 翻面补间始终推进（结算后也让最后一张翻完）
    this._updateFlips(dt);

    if (this._state === STATE.PLAYING) {
      this._roundTime += dt;
      if (this._mismatchTimer > 0) {
        this._mismatchTimer -= dt;
        if (this._mismatchTimer <= 0) {
          this._mismatchTimer = 0;
          this._flipBackSelected();
        }
      }
    }

    this._animateRunes();

    this._hudAccumulator += dt;
    if (this._hudAccumulator >= 0.25) {
      this._hudAccumulator = 0;
      this._renderHUD();
    }
  }

  /** 符文环呼吸：只改 scale，绝不新建资源 */
  _animateRunes() {
    const t = this._time;
    for (const r of this._runeRings) {
      const s = r.radius * (1 + 0.028 * Math.sin(t * r.speed + r.phase));
      r.mesh.scale.setScalar(s);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 预热接口（仅供 main.js 固化基线使用）                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 强制走一遍「配对成功 + 不匹配翻回」的完整运行路径，确保：
   *   ① 6 张正面 CanvasTexture / 背面纹理 / 高亮材质全部参与渲染并上传；
   *   ② 翻面补间的矩阵更新路径被真实执行过一次。
   * main.js 在本方法后需调用一次 renderOnce() 才真正触发上传。
   */
  warmUpFlip() {
    if (this._disposed) return;
    this._resetRound();
    this._setState(STATE.PLAYING);

    // ① 一对匹配：翻开同 pairId 的两张，推进到翻面完成
    const a = this._cards.find((c) => c.pairId === 0);
    const b = this._cards.find((c) => c.pairId === 0 && c !== a);
    this._pickCard(a);
    this._pickCard(b);
    this._updateFlips(FLIP_DURATION + 0.01);

    // ② 一次不匹配：翻开两个不同图案，再推进 0.8s 触发自动翻回
    const c = this._cards.find((card) => card.pairId === 1);
    const d = this._cards.find((card) => card.pairId === 2);
    this._pickCard(c);
    this._pickCard(d);
    this._updateFlips(FLIP_DURATION + 0.01);
    this._updateFlips(MISMATCH_DELAY + 0.02);
    this._updateFlips(FLIP_DURATION + 0.01);

    const scoreAfterWarmUp = this._score;
    this._resetRound();
    this._setState(STATE.READY);
    console.info(
      `[MemoryMatch:warmUp] 配对+不匹配翻回到位 | 预热得分=${scoreAfterWarmUp} ` +
      `| 已复位：配对=${this._matchedPairs}/${PAIR_COUNT}`
    );
  }

  /* ------------------------------------------------------------------------ */
  /* dispose —— 七步清理，不破坏基座标准                                       */
  /* ------------------------------------------------------------------------ */

  /** 每个清理步骤独立 try/catch：单步失败只记日志，不中断整体 */
  _step(label, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[MemoryMatch] dispose 步骤「${label}」失败（继续后续清理）：`, err);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* ---------- 步骤 -1：通用暂停菜单清理（解绑 ESC / 移除 DOM / 恢复运行） ---------- */
    try {
      this._pauseMenu?.dispose();
    } catch (err) {
      console.error('[MemoryMatch] 暂停菜单清理失败：', err);
    }
    this._pauseMenu = null;

    /* ---------- 步骤 0：相机恢复（最前段 + 独立 try/catch） ---------- */
    try {
      const camera = this._ctx?.camera;
      if (camera && this._cameraSaved) {
        camera.rotation.order = this._cameraSaved.rotationOrder;
        camera.quaternion.copy(this._cameraSaved.quaternion);
        camera.position.copy(this._cameraSaved.position);
        camera.fov = this._cameraSaved.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
      }
    } catch (err) {
      console.error('[MemoryMatch] dispose 步骤「相机恢复」失败（继续后续清理）：', err);
    }

    /* ---------- 步骤 1：清除全部定时器（HUD interval 等） ---------- */
    this._step('定时器', () => this._clearAllTimers());

    /* ---------- 步骤 2：移除 DOM 事件监听、UI 节点与 <style> ---------- */
    this._step('UI 与监听', () => {
      for (const { target, type, fn } of this._listeners) {
        try { target.removeEventListener(type, fn); } catch { /* 已解绑 */ }
      }
      this._listeners.length = 0;
      this._uiRoot?.remove();
      this._uiStyle?.remove();
      this._uiRoot = null;
      this._uiStyle = null;
      this._ui = {};
    });

    /* ---------- 步骤 3：物理（本项目全程不使用 Rapier，确认为 0） ---------- */
    this._step('物理刚体', () => {
      console.info('[MemoryMatch] 物理资源：未使用 Rapier，刚体数 0');
    });

    /* ---------- 步骤 4：收集并释放几何体 / 材质 / 纹理（含 CanvasTexture） ---------- */
    this._step('GPU 资源', () => this._disposeThreeResources());

    /* ---------- 步骤 5：台账与状态清空 ---------- */
    this._step('台账清空', () => {
      this.root.clear(); // 从 scene 移除由 AttractionManager 第 ③ 步负责
      this._cards.length = 0;
      this._pairMaterials.length = 0;
      this._runeRings.length = 0;
      this._selected = [];
      this._locked = false;
      this._comparePending = false;
      this._mismatchTimer = 0;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
      this._shared = {};
      this._cameraSaved = null;
      this._state = STATE.OVER;
      this._ctx = null;
    });

    console.info('[MemoryMatch] dispose 完成：相机 / 定时器 / DOM / GPU 资源 / 台账全部清理');
  }

  /** Three 资源释放：台账 + traverse 兜底；纹理含标准槽位与 uniforms 深度扫描 */
  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);

    // traverse 兜底：防止漏登记的 mesh / points
    this.root.traverse((obj) => {
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      if (obj.geometry) geometries.add(obj.geometry);
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x && materials.add(x));
      else if (m) materials.add(m);
    });

    // 引用路径【不去重】；释放计划【Map 去重】——沿用 M2 修复结论
    const refs = [];
    let index = 0;
    for (const material of materials) {
      refs.push(...collectMaterialTextureReferences(material, index));
      index += 1;
    }

    const texturePlan = new Map();
    const add = (texture, source) => {
      if (!texture || !texture.isTexture) return;
      if (!texturePlan.has(texture)) texturePlan.set(texture, { sources: [], disposeCalled: false });
      const meta = texturePlan.get(texture);
      if (!meta.sources.includes(source)) meta.sources.push(source);
    };
    for (const tex of this._textures) add(tex, '台账');
    for (const ref of refs) add(ref.texture, ref.path);

    // 逐张 dispose（CanvasTexture 同样是 Texture，走同一路径）
    for (const [texture, meta] of texturePlan) {
      try {
        texture.dispose();
        meta.disposeCalled = true;
      } catch (err) {
        console.error(`[MemoryMatch:纹理] uuid=${texture.uuid} dispose 失败：`, err);
      }
    }

    // dispose 之后逐路径断开引用（material.map=null / uniforms.xxx.value=null）
    const cleared = [];
    for (const ref of refs) {
      try {
        ref.clear();
        cleared.push(ref.path);
      } catch (err) {
        console.error(`[MemoryMatch:纹理] 断开引用 ${ref.path} 失败：`, err);
      }
    }

    const clearedSet = new Set(cleared);
    const summary = [];
    for (const [texture, meta] of texturePlan) {
      const own = refs.filter((r) => r.texture === texture).map((r) => r.path);
      summary.push({
        uuid: texture.uuid,
        name: texture.name || '-',
        '来源': meta.sources.join(' | '),
        'dispose() 已调用': meta.disposeCalled ? '是' : '否',
        '引用已断开': own.every((p) => clearedSet.has(p)) ? '是' : '否',
      });
    }
    console.table(summary);

    for (const material of materials) {
      try { material.dispose(); } catch (err) { console.error('[MemoryMatch] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[MemoryMatch] 几何体 dispose 失败：', err); }
    }

    console.info(
      `[MemoryMatch] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} ` +
      `texture=${texturePlan.size} 引用路径=${cleared.length}`
    );
  }
}

export default MemoryMatch;
