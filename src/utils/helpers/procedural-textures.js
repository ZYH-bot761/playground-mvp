/**
 * ============================================================================
 * procedural-textures.js —— 阶段三：程序化粗糙度 / 窗光 / 作物叶片纹理
 * ============================================================================
 * 只产出 CanvasTexture，不创建场景对象、不持有材质。所有纹理由 Lobby
 * `_trackTexture()` 统一登记和释放；Castle / Farm 只引用，不重复 dispose。
 *
 * 纹理清单：
 *   createNoiseRoughnessTexture()  灰度多倍频噪声 → roughnessMap（柏油/石墙/泥土/漆面）
 *   createWindowGlowTexture()      拱窗 + 窗棂 + 暖光渐变 → 城堡窗户 map/emissiveMap
 *   createCropLeafAtlas()          3 格叶片图集 → 水稻/小麦/玉米叶片 alphaMap
 * ============================================================================
 */
import * as THREE from 'three';

/** 确定性哈希：同一 seed 每次得到同一张纹理，便于验收复现 */
function hash2(x, y, seed) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** 双线性插值的 value noise（周期网格） */
function valueNoise(x, y, grid, seed) {
  const gx = x * grid;
  const gy = y * grid;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

/**
 * 多倍频灰度噪声纹理，用于 roughnessMap。
 * 贴图值越大越粗糙；默认值域约 0.65~0.95，避免纯镜面/纯哑光。
 *
 * @param {{size?:number, base?:number, contrast?:number, repeat?:number|number[],
 *          seed?:number, name?:string, anisotropy?:number}} [opts]
 * @returns {THREE.CanvasTexture}
 */
export function createNoiseRoughnessTexture(opts = {}) {
  const size = opts.size ?? 256;
  const base = opts.base ?? 0.78;
  const contrast = opts.contrast ?? 0.16;
  const repeat = Array.isArray(opts.repeat) ? opts.repeat : [opts.repeat ?? 4, opts.repeat ?? 4];
  const seed = opts.seed ?? 7;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const n = valueNoise(u, v, 4, seed) * 0.45
        + valueNoise(u, v, 9, seed + 1) * 0.33
        + valueNoise(u, v, 23, seed + 2) * 0.22;
      // 细颗粒：模拟骨料 / 石粒 / 漆面橘皮
      const speck = (hash2(x, y, seed + 9) - 0.5) * 0.07;
      const value = Math.max(0, Math.min(1, base + (n - 0.5) * contrast * 2 + speck));
      const c = Math.round(value * 255);
      const i = (y * size + x) * 4;
      img.data[i] = c;
      img.data[i + 1] = c;
      img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = opts.name ?? 'procedural/roughness';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.colorSpace = THREE.NoColorSpace; // 数据纹理，禁止 sRGB 解码
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = opts.anisotropy ?? 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 拱窗发光贴图：透明背景 + 暗色石框 + 暖黄玻璃 + 十字窗棂。
 * 用作窗户材质的 map 与 emissiveMap；alphaTest 负责切出拱形轮廓。
 * @param {number} [anisotropy]
 * @returns {THREE.CanvasTexture}
 */
export function createWindowGlowTexture(anisotropy = 8) {
  const W = 128;
  const H = 192;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, W, H);

  const cx = W / 2;
  const top = 58;
  const bottom = H - 6;
  const left = 8;
  const right = W - 8;
  const radius = (right - left) / 2;

  // 外框：拱形深色石框
  g.beginPath();
  g.moveTo(left, bottom);
  g.lineTo(left, top);
  g.arc(cx, top, radius, Math.PI, Math.PI * 2, false);
  g.lineTo(right, bottom);
  g.closePath();
  g.fillStyle = '#2a2330';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#d8b878';
  g.stroke();

  // 内层玻璃：从暖橙到浅金渐变
  const inset = 7;
  g.beginPath();
  g.moveTo(left + inset, bottom - inset);
  g.lineTo(left + inset, top);
  g.arc(cx, top, radius - inset, Math.PI, Math.PI * 2, false);
  g.lineTo(right - inset, bottom - inset);
  g.closePath();
  const grad = g.createLinearGradient(0, top - radius, 0, bottom);
  grad.addColorStop(0, '#fff2b8');
  grad.addColorStop(0.45, '#ffd86b');
  grad.addColorStop(1, '#ff9e3d');
  g.fillStyle = grad;
  g.fill();

  // 十字窗棂：竖梃 + 两道横档
  g.strokeStyle = 'rgba(36,28,38,0.92)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(cx, top - radius + 10);
  g.lineTo(cx, bottom - inset);
  g.moveTo(left + inset + 2, 118);
  g.lineTo(right - inset - 2, 118);
  g.moveTo(left + inset + 2, bottom - 42);
  g.lineTo(right - inset - 2, bottom - 42);
  g.stroke();

  // 玻璃内的弱高光，避免整块死黄
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.beginPath();
  g.moveTo(left + 16, 100);
  g.lineTo(cx - 5, 74);
  g.lineTo(cx - 16, 74);
  g.lineTo(left + 20, 120);
  g.closePath();
  g.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'procedural/window-glow';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** 在 256 格内画一丛叶片（按作物上色 + alpha；顶点色保持白色参与细微明暗） */
function drawLeafCell(g, cellX, cellY, kind) {
  const baseX = cellX + 128;
  const baseY = cellY + 250;
  const tint = kind === 'rice' ? [118, 198, 86]
    : kind === 'wheat' ? [222, 184, 82]
      : [58, 126, 52];
  g.save();
  g.translate(baseX, baseY);
  g.globalCompositeOperation = 'source-over';

  const blade = (lean, height, width, curve) => {
    g.beginPath();
    g.moveTo(-width / 2, 0);
    g.quadraticCurveTo(lean * 0.45 + curve, -height * 0.55, lean, -height);
    g.quadraticCurveTo(lean * 0.35 - width * 0.2, -height * 0.45, width / 2, 0);
    g.closePath();
    const grad = g.createLinearGradient(0, 0, lean, -height);
    grad.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},0.98)`);
    grad.addColorStop(0.7, `rgba(${Math.round(tint[0] * 0.9)},${Math.round(tint[1] * 0.9)},${Math.round(tint[2] * 0.9)},0.96)`);
    grad.addColorStop(1, `rgba(${Math.round(tint[0] * 0.78)},${Math.round(tint[1] * 0.78)},${Math.round(tint[2] * 0.78)},0.9)`);
    g.fillStyle = grad;
    g.fill();
  };

  if (kind === 'rice') {
    for (let i = 0; i < 11; i += 1) {
      const lean = (i - 5) * 17 + (i % 2 ? 4 : -4);
      blade(lean, 202 + (i % 3) * 12, 16, (i - 5) * 1.8);
    }
    // 稻穗：顶端小颗粒串
    g.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},0.95)`;
    for (let i = 0; i < 7; i += 1) {
      g.beginPath();
      g.ellipse(-6 + (i % 2) * 12, -198 - i * 7, 3.2, 6.4, 0.2, 0, Math.PI * 2);
      g.fill();
    }
  } else if (kind === 'wheat') {
    for (let i = 0; i < 9; i += 1) {
      const lean = (i - 4) * 20;
      blade(lean, 206 + (i % 3) * 10, 15, (i - 4) * 1.6);
    }
    g.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},0.95)`;
    for (let i = 0; i < 6; i += 1) {
      g.beginPath();
      g.ellipse(-2 + (i % 2) * 10, -190 - i * 8, 3.4, 7.2, 0.15, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    // 玉米：宽大、密集的叶片，铺满整格，避免只看到稀疏叶脉
    for (let i = 0; i < 7; i += 1) {
      const side = i % 2 ? 1 : -1;
      const step = Math.floor(i / 2);
      const lean = side * (34 + step * 26);
      g.save();
      g.translate(0, -step * 5);
      blade(lean, 226 - step * 8, 56, side * 12);
      g.restore();
    }
  }
  g.restore();
}

/**
 * 3 格作物叶片图集（512×512）：左上水稻、右上小麦、左下玉米。
 * 颜色为白色/浅灰，实际色调由作物几何顶点色与实例色相乘。
 * @param {number} [anisotropy]
 * @returns {THREE.CanvasTexture}
 */
export function createCropLeafAtlas(anisotropy = 8) {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, S, S);
  drawLeafCell(g, 0, 0, 'rice');
  drawLeafCell(g, 256, 0, 'wheat');
  drawLeafCell(g, 0, 256, 'corn');
  // 右下空格填纯白：茎/果/穗等非叶片部件把 UV 收到这一格，
  // 这样同一张图集 + 同一材质即可用顶点色控制所有部件颜色。
  g.fillStyle = '#ffffff';
  g.fillRect(256, 256, 256, 256);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'procedural/crop-leaf-atlas';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}
