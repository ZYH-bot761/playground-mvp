/**
 * ============================================================================
 * FacilityTextures —— 大厅设施名称牌「单图集 + 单材质」文字方案（T06）
 * ============================================================================
 * 背景：旧方案 makeTextPixels() 把文字画到 260×88 canvas 后按 5px 步长采样成
 *       InstancedMesh 小方块，5 字标签实际只有 ~52 个采样列；再叠高饱和漆面
 *       材质 + Bloom，1080p 下糊成橙色马赛克团。
 *
 * 本模块把全部标签（9 个设施名 + 大门「游乐园」）画进【一张 2048×2048
 * CanvasTexture】。每个标签独占一个 512×512 格子，返回紧贴字形的 UV 子矩形；
 * Lobby 侧只需：
 *   ① 1 张纹理（登记进 _textures 台账）
 *   ② 1 个共享 MeshBasicMaterial（登记进 _materials 台账）
 *   ③ 每个标签一个 4 顶点轻量 PlaneGeometry（克隆 geoPlane 改 uv）
 * 即可获得「高分辨率字形 + 深色描边 + 不被 Bloom 拾取」的清晰文字。
 *
 * 【UV 约定】Canvas 原点左上，Three UV 原点左下：
 *   u = x / SIZE
 *   v = 1 - (y + h) / SIZE
 * 返回的 { offsetX, offsetY, width, height } 已换算为 Three UV 坐标，可直接
 * 用 applyAtlasUV() 线性映射到标准 PlaneGeometry 的默认 uv(0..1)。
 * 额外返回 aspect = 子矩形像素宽/高，供调用方决定世界平面的宽高比（避免把
 * 文字拉扁或留大片透明留白）。
 *
 * 【零外部资源】只用浏览器 Canvas 2D 与 three 自带类型；无字体文件、无图片。
 * ============================================================================
 */

import * as THREE from 'three';

/** 图集边长（px）。4×4 格子 × 512px = 2048px，恰好一张 2 的幂纹理。 */
export const LABEL_ATLAS_SIZE = 2048;
/** 图集列数 */
export const LABEL_ATLAS_COLS = 4;
/** 图集行数 */
export const LABEL_ATLAS_ROWS = 4;
/** 单格边长（px） */
export const LABEL_ATLAS_CELL = LABEL_ATLAS_SIZE / LABEL_ATLAS_COLS;
/** 图集最大标签数 */
export const LABEL_ATLAS_CAPACITY = LABEL_ATLAS_COLS * LABEL_ATLAS_ROWS;

/** 字体栈：与项目其它 Canvas 文字保持一致，中文优先雅黑/苹方 */
const FONT_STACK = '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Noto Sans SC",sans-serif';

/**
 * 【幂等台账】已映射过 UV 的几何体。
 * 注意：three r187 的 BufferGeometry.copy() 是 `this.userData = source.userData`
 * （浅引用共享），若把「已映射」标记写进 geometry.userData，第一块克隆会把标记
 * 同步给源 geoPlane，后续所有克隆都会误判为「已映射」而跳过 UV 改写 ——
 * 结果除第一块牌外的全部名称牌都采样到图集空白角落、完全不可见。
 * 因此改用 WeakSet 按【对象实例】记账，克隆之间互不干扰。
 */
const UV_MAPPED_GEOMETRIES = new WeakSet();

/**
 * 把单张标签的 UV 子矩形映射到一块 PlaneGeometry（原地修改 uv attribute）。
 * 传入的 geometry 必须是【新克隆】的 PlaneGeometry；本函数带幂等保护，
 * 同一块几何体重复调用不会把 UV 二次缩放。
 *
 * @param {THREE.BufferGeometry} geometry 待改写的平面几何
 * @param {{offsetX:number, offsetY:number, width:number, height:number}} uv 图集 UV 子矩形
 * @returns {THREE.BufferGeometry} 同一块 geometry，便于链式调用
 */
export function applyAtlasUV(geometry, uv) {
  if (!geometry || !uv) return geometry;
  if (UV_MAPPED_GEOMETRIES.has(geometry)) return geometry;
  const attr = geometry.getAttribute('uv');
  if (!attr) return geometry;
  for (let i = 0; i < attr.count; i += 1) {
    const u = uv.offsetX + attr.getX(i) * uv.width;
    const v = uv.offsetY + attr.getY(i) * uv.height;
    attr.setXY(i, u, v);
  }
  attr.needsUpdate = true;
  UV_MAPPED_GEOMETRIES.add(geometry);
  return geometry;
}

/**
 * 把所有标签绘制到一张 2048×2048 的 CanvasTexture 图集。
 *
 * @param {string[]} labels 标签列表；顺序即格子序号（第 0 个在左上格）。
 *        重复项只画一次，getUV 返回首次出现的格子。
 * @param {THREE.WebGLRenderer|null} renderer 仅用于读取 maxAnisotropy，可为空。
 * @returns {{
 *   texture: THREE.CanvasTexture,
 *   labels: string[],
 *   getUV: (label:string) => ({offsetX:number, offsetY:number, width:number, height:number, aspect:number, pixelWidth:number, pixelHeight:number}|null),
 *   dispose: () => void
 * }} 图集句柄。texture 由 Lobby 用 _trackTexture() 登记；dispose() 幂等。
 */
export function createFacilityLabelAtlas(labels, renderer = null) {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('[FacilityTextures] createFacilityLabelAtlas 需要非空标签数组');
  }
  if (labels.length > LABEL_ATLAS_CAPACITY) {
    throw new Error(
      `[FacilityTextures] 标签数 ${labels.length} 超出图集容量 ${LABEL_ATLAS_CAPACITY}`
    );
  }

  /* ---------- devicePixelRatio 感知 ----------
   * 图集物理尺寸锁定 2048²（纹理预算硬约束）。DPR 提升时收紧 gutter/padding、
   * 抬高基准字号：在同样 512px 的格子里给字形更多像素，抵消高 DPR 屏上
   * 「同一世界尺寸占更多设备像素」带来的采样压力。
   */
  const dpr = Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 2);
  const gutter = dpr >= 1.5 ? 12 : 16;      // 格子四周透明隔离带，防 mipmap 串格
  const pad = dpr >= 1.5 ? 18 : 24;         // 字形到子矩形边缘的留白
  const outerStroke = dpr >= 1.5 ? 12 : 14; // 深色外描边宽度
  const innerStroke = 7;                    // 内层压边，进一步锁住字形边缘
  const baseFont = Math.round(150 * (0.85 + 0.15 * dpr));
  const maxTextWidth = LABEL_ATLAS_CELL - 2 * gutter - 2 * (pad + outerStroke / 2);

  const canvas = document.createElement('canvas');
  canvas.width = LABEL_ATLAS_SIZE;
  canvas.height = LABEL_ATLAS_SIZE;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, LABEL_ATLAS_SIZE, LABEL_ATLAS_SIZE); // 全透明背景
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  g.miterLimit = 2;

  /** @type {Map<string, object>} */
  const uvByLabel = new Map();

  labels.forEach((label, index) => {
    if (typeof label !== 'string' || label.length === 0) return;
    if (uvByLabel.has(label)) return; // 重复标签：保留第一次的格子

    const col = index % LABEL_ATLAS_COLS;
    const row = Math.floor(index / LABEL_ATLAS_COLS);
    const cellX = col * LABEL_ATLAS_CELL;
    const cellY = row * LABEL_ATLAS_CELL;
    const cx = cellX + LABEL_ATLAS_CELL / 2;
    const cy = cellY + LABEL_ATLAS_CELL / 2;

    /* 字号：基准值先按字数/格宽收缩，再逐步微调到 measureText 真正装得下。
     * 5 字标签约 84px、3 字标签约 140px —— 相比旧 48px 点阵提升近 3 倍，
     * 且是【连续纹理采样】而非 5px 方块采样，细节完整保留。 */
    let fontSize = Math.min(baseFont, Math.floor(maxTextWidth / label.length));
    fontSize = Math.max(fontSize, 32);
    const setFont = () => {
      g.font = `bold ${fontSize}px ${FONT_STACK}`;
    };
    setFont();
    let metrics = g.measureText(label);
    let guard = 0;
    while (metrics.width > maxTextWidth && fontSize > 32 && guard < 32) {
      fontSize -= 4;
      setFont();
      metrics = g.measureText(label);
      guard += 1;
    }

    const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
      ? metrics.actualBoundingBoxAscent : fontSize;
    const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
      ? metrics.actualBoundingBoxDescent : Math.round(fontSize * 0.22);
    const glyphW = Math.min(metrics.width, maxTextWidth);
    const glyphH = ascent + descent;
    // 字形包围盒垂直居中于格子（alphabetic 基线补偿）
    const drawY = cy + (ascent - descent) / 2;

    // 深色描边：压住暖色 Bloom 与明亮天空，保证逆光也读得清
    g.lineWidth = outerStroke;
    g.strokeStyle = 'rgba(8,14,26,0.96)';
    g.strokeText(label, cx, drawY, maxTextWidth);
    g.lineWidth = innerStroke;
    g.strokeStyle = 'rgba(26,48,74,0.92)';
    g.strokeText(label, cx, drawY, maxTextWidth);

    // 浅色填充：上白下暖的细微渐变，像烤漆立体字而不是发光糊团
    const grad = g.createLinearGradient(0, cy - glyphH / 2, 0, cy + glyphH / 2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.55, '#fff6e2');
    grad.addColorStop(1, '#ffe3ad');
    g.fillStyle = grad;
    g.fillText(label, cx, drawY, maxTextWidth);

    /* 紧贴字形（含描边与留白）的矩形，并夹在格子的 gutter 内。
     * 相邻格子边缘都是透明像素 → mipmap 降采样不会把邻格颜色串进来。 */
    const rectW = glyphW + outerStroke + pad * 2;
    const rectH = glyphH + outerStroke + pad * 2;
    const x0 = Math.max(cellX + gutter, cx - rectW / 2);
    const y0 = Math.max(cellY + gutter, cy - rectH / 2);
    const x1 = Math.min(cellX + LABEL_ATLAS_CELL - gutter, cx + rectW / 2);
    const y1 = Math.min(cellY + LABEL_ATLAS_CELL - gutter, cy + rectH / 2);
    const pixelWidth = Math.max(1, x1 - x0);
    const pixelHeight = Math.max(1, y1 - y0);

    uvByLabel.set(label, {
      // Canvas 左上 → Three UV 左下
      offsetX: x0 / LABEL_ATLAS_SIZE,
      offsetY: 1 - y1 / LABEL_ATLAS_SIZE,
      width: pixelWidth / LABEL_ATLAS_SIZE,
      height: pixelHeight / LABEL_ATLAS_SIZE,
      aspect: pixelWidth / pixelHeight,
      pixelWidth,
      pixelHeight,
    });
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'lb/facility-label-atlas';
  // sRGB：Canvas 里写的是显示空间颜色，采样时由 GPU 解码到线性空间。
  texture.colorSpace = THREE.SRGBColorSpace;
  // 各向异性拉满：俯瞰斜视地面上的悬浮牌时字形不糊。
  texture.anisotropy = Math.max(1, renderer?.capabilities?.getMaxAnisotropy?.() || 8);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  // 子矩形采样不能越过 atlas 边界
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  let disposed = false;
  return {
    texture,
    labels: Array.from(uvByLabel.keys()),
    /** @param {string} label @returns {object|null} 找不到时返回 null，调用方可降级/告警 */
    getUV(label) { return uvByLabel.get(label) || null; },
    /** 幂等释放；Lobby 已用 _trackTexture 登记时无需手动调用（避免重复 dispose） */
    dispose() {
      if (disposed) return;
      disposed = true;
      texture.dispose();
    },
  };
}

/**
 * 显式释放图集句柄（与返回对象上的 dispose() 等价，幂等）。
 * Lobby 走 _trackTexture() 台账统一释放，此导出供独立使用/测试时调用。
 *
 * @param {{dispose:()=>void}|null} atlas createFacilityLabelAtlas 的返回值
 */
export function disposeFacilityLabelAtlas(atlas) {
  if (atlas && typeof atlas.dispose === 'function') atlas.dispose();
}
