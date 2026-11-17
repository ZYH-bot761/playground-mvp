/**
 * ============================================================================
 * ParticleSystem.js —— 全局烟花粒子系统（单例 / GPU 加速 / 对象池）
 * ============================================================================
 * 第七部分 / 指令 2：标准爆炸 · 闪烁星形 · 瀑布 · 文字烟花。
 *
 * 【性能设计（指令 6 是本模块的硬指标）】
 *  - 全系统只有【1 个 THREE.Points + 1 个 BufferGeometry + 1 个 ShaderMaterial】，
 *    3000 个粒子的全部属性在 init 时一次性分配 TypedArray，绝不每帧新建几何体。
 *  - 物理在【顶点着色器】里算：pos = start + vel*age - 0.5*g*age²，
 *    CPU 每帧只更新一个 uTime uniform → 零逐粒子循环、零 GC。
 *  - 对象池：空闲槽索引栈 + 64 个预分配「批次」环形复用。发射时只写一段
 *    TypedArray（addUpdateRange 局部上传），过期批次整批归还，无 new、无 splice。
 *  - 频率闸门：最小发射间隔 0.12s + 活跃粒子上限，避免过密导致掉帧。
 *
 * 【文字烟花为什么清晰】
 *  launchText 用一张可复用 canvas 把文字栅格化，按像素采样成点阵；粒子目标点
 *  依据【当前相机的 right/up 基向量】铺开，天然 billboard 始终正对镜头，
 *  粒子从爆心平滑聚拢到字形后悬停 3.5s 才淡出，点距固定 → 字形稳定可读。
 *
 * 【与设施生命周期的关系】
 *  root 常驻 scene（不打 attractionRoot 标记），由 main.js 包装的 update 链驱动。
 *  setContext() 只在 lobby / fireworks-deck 激活时更新与可见，切到别的项目
 *  立即 clear()，杜绝烟花粒子串到跑酷/海盗船场景。
 * ============================================================================
 */
import * as THREE from 'three';

/** 8 色调色板（时间控制台/烟花站台共用） */
export const FIREWORK_COLORS = Object.freeze([
  { name: '金', hex: 0xffd24a },
  { name: '红', hex: 0xff4a5e },
  { name: '橙', hex: 0xff8a3c },
  { name: '粉', hex: 0xff6fbf },
  { name: '紫', hex: 0xa06bff },
  { name: '蓝', hex: 0x4aa8ff },
  { name: '青', hex: 0x3ee0d0 },
  { name: '绿', hex: 0x6ee06a },
]);

export const FIREWORK_TYPES = Object.freeze([
  { key: 'burst', label: '标准' },
  { key: 'star', label: '星形' },
  { key: 'waterfall', label: '瀑布' },
  { key: 'text', label: '文字' },
]);

const CAP = 3000;          // 粒子容量
const MAX_PER_BURST = 620; // 单发最多粒子（文字点阵上限）
const BATCH_CAP = 64;      // 预分配批次数
const MIN_INTERVAL = 0.12; // 最小发射间隔（秒）

/**
 * 天气配色表（模块级冻结常量）。
 * 【热路径纪律】emitWeather 每个粒子都要取色，若把数组字面量写在循环体里，
 * 每次发射会 new 数十个临时数组。提到模块级后发射路径零 JS 分配。
 * kind 见 TYPE_ID 映射：4=petal 5=leaf 6=snow 7=rain。
 */
const WEATHER_PALETTES = Object.freeze({
  petal: Object.freeze([0xffb6cf, 0xffc8dd, 0xf59fbe, 0xffd7e6]),
  leaf: Object.freeze([0xe3a52b, 0xd8741f, 0xb84c1b, 0xf0c04a]),
  snow: Object.freeze([0xf4f8ff, 0xe7f1ff, 0xffffff]),
  rain: Object.freeze([0x9dc8df, 0xb8d9ea, 0x8fbcd4]),
});

/** 天气批次 kind 下界：≥4 为环境天气，0 为烟花/文字批次。 */
const WEATHER_KIND_MIN = 4;

/* -------------------------------------------------------------------------- */
/* 着色器                                                                      */
/* -------------------------------------------------------------------------- */
const VERT = /* glsl */`
  attribute vec3 aVel;
  attribute vec3 aColor;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute float aType;
  attribute float aSeed;

  uniform float uTime;
  uniform float uGravity;
  uniform float uPixelRatio;
  uniform float uViewportH;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vTwinkle;
  varying float vType;

  void main() {
    float age = uTime - aBirth;
    if (aLife <= 0.0 || age < 0.0 || age > aLife || aType > 3.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }

    float t = age / aLife;
    vec3 p;

    if (aType > 2.5) {
      // 文字：aVel 复用为「目标点 - 爆心」偏移，聚拢后悬停，仅缓慢下沉
      float rise = smoothstep(0.0, 0.22, t);
      p = position + aVel * rise + vec3(0.0, -0.35 * t * t, 0.0)
        + vec3(sin(aSeed * 31.0 + uTime * 1.6) * 0.012, 0.0, 0.0);
      vAlpha = (1.0 - smoothstep(0.72, 1.0, t)) * (0.82 + 0.18 * sin(uTime * 7.0 + aSeed * 17.0));
    } else {
      float g = uGravity * (aType > 1.5 ? 1.65 : 1.0);
      p = position + aVel * age - vec3(0.0, 0.5 * g * age * age, 0.0);
      // 瀑布：额外持续下坠 + 轻微横向飘摆
      if (aType > 1.5) {
        p.y -= age * 1.15;
        p.x += sin(aSeed * 12.0 + age * 3.0) * 0.12 * age;
      }
      vAlpha = 1.0 - smoothstep(0.42, 1.0, t);
    }

    // 星形高频闪烁
    vTwinkle = (aType > 0.5 && aType < 1.5)
      ? 0.55 + 0.45 * sin(uTime * 22.0 + aSeed * 40.0)
      : 1.0;

    vColor = aColor;
    vType = aType;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float persp = uViewportH * 0.5 / max(1.0, -mv.z);
    // 文字粒子更小更密，保证字形锐利；爆裂粒子随生命收缩
    float shrink = aType > 2.5 ? 1.0 : (1.0 - 0.45 * t);
    gl_PointSize = clamp(aSize * uPixelRatio * persp * shrink, 1.0, 42.0);
  }
`;

/* -------------------------------------------------------------------------- */
/* 季节天气：同一组粒子属性，第二个 Points 通道用普通 alpha 混合               */
/* 类型 4 花瓣 / 5 落叶 / 6 雪 / 7 雨；对象池、批次与烟花完全共用。             */
/* -------------------------------------------------------------------------- */
const ENV_VERT = /* glsl */`
  attribute vec3 aVel;
  attribute vec3 aColor;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute float aType;
  attribute float aSeed;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uViewportH;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vType;

  void main() {
    float age = uTime - aBirth;
    if (aLife <= 0.0 || age < 0.0 || age > aLife || aType < 3.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      return;
    }
    float t = clamp(age / max(aLife, 0.001), 0.0, 1.0);
    float g = aType > 6.5 ? 0.0 : (aType > 5.5 ? 0.08 : (aType > 4.5 ? 0.38 : 0.20));
    vec3 p = position + aVel * age - vec3(0.0, 0.5 * g * age * age, 0.0);
    if (aType < 5.5) {
      p.x += sin(aSeed * 8.0 + age * 1.7) * 0.48 * t;
      p.z += cos(aSeed * 5.0 + age * 1.2) * 0.38 * t;
    }
    vColor = aColor;
    vType = aType;
    vAlpha = smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.72, 1.0, t));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float persp = uViewportH * 0.5 / max(1.0, -mv.z);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uPixelRatio * persp, 1.0, 28.0);
  }
`;

const ENV_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  varying float vType;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d;
    if (vType > 6.5) {
      d = length(vec2(uv.x * 2.4, uv.y));
    } else {
      d = length(uv);
    }
    if (d > 0.5) discard;
    float a = (1.0 - smoothstep(0.18, 0.5, d)) * vAlpha;
    if (a <= 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  varying float vTwinkle;
  varying float vType;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    // 软圆核 + 光晕，中心更亮
    float core = 1.0 - smoothstep(0.06, 0.5, d);
    float halo = (1.0 - smoothstep(0.18, 0.5, d)) * 0.45;
    float a = (core + halo) * vAlpha * vTwinkle;
    if (a <= 0.002) discard;
    vec3 col = vColor * (0.85 + core * 1.35);
    gl_FragColor = vec4(col, a);
  }
`;

class FireworkSystemImpl {
  constructor() {
    this._inited = false;
    this._disposed = false;
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    this._root = null;
    this._points = null;
    this._envPoints = null;
    this._envMat = null;
    this._geo = null;
    this._mat = null;

    this._time = 0;
    this._lastLaunch = -1;
    this._brightness = 1.0;
    this._active = true;
    this._contextKey = 'lobby';

    // 对象池
    this._free = new Int32Array(CAP);
    this._freeTop = 0;
    this._batches = [];
    this._batchCursor = 0;

    // 复用临时对象（禁止热路径 new）
    this._tmpColor = new THREE.Color();
    this._tmpRight = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3();
    this._tmpTarget = new THREE.Vector3();
    this._canvas = null;
    this._ctx2d = null;
  }

  /* ----------------------------- 生命周期 ----------------------------- */

  /** 幂等。必须在预热 renderOnce 之前调用，让粒子 GPU 资源计入本次基线。 */
  init({ scene, camera, renderer }) {
    if (this._inited || this._disposed) return this;
    if (!scene || !camera || !renderer) {
      console.warn('[FireworkSystem] init 缺少依赖，跳过');
      return this;
    }
    this._scene = scene;
    this._camera = camera;
    this._renderer = renderer;

    for (let i = 0; i < CAP; i++) this._free[i] = CAP - 1 - i;
    this._freeTop = CAP;

    const geo = new THREE.BufferGeometry();
    const mk = (n, itemSize) => {
      const a = new THREE.BufferAttribute(new Float32Array(n * itemSize), itemSize);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const pos = mk(CAP, 3);
    pos.name = 'position';
    geo.setAttribute('position', pos);
    geo.setAttribute('aVel', mk(CAP, 3));
    geo.setAttribute('aColor', mk(CAP, 3));
    geo.setAttribute('aBirth', mk(CAP, 1));
    geo.setAttribute('aLife', mk(CAP, 1));
    geo.setAttribute('aSize', mk(CAP, 1));
    geo.setAttribute('aType', mk(CAP, 1));
    geo.setAttribute('aSeed', mk(CAP, 1));
    // 全部粒子初始为「未激活」
    const life = geo.getAttribute('aLife');
    life.array.fill(0);
    // 包围球无意义（position 只是爆心），关闭视锥剔除
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: 9.2 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uViewportH: { value: window.innerHeight || 720 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });

    this._geo = geo;
    this._mat = mat;
    this._points = new THREE.Points(geo, mat);
    this._points.name = 'FireworkSystem/particles';
    this._points.frustumCulled = false;
    this._points.renderOrder = 60;

    this._root = new THREE.Group();
    this._root.name = 'FireworkSystem/global';
    this._root.add(this._points);

    // 天气复用同一份 BufferGeometry / 同一组对象池槽位，只增加一个绘制通道。
    this._envMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uViewportH: { value: window.innerHeight || 720 },
      },
      vertexShader: ENV_VERT,
      fragmentShader: ENV_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      fog: false,
      toneMapped: false,
    });
    this._envPoints = new THREE.Points(geo, this._envMat);
    this._envPoints.name = 'FireworkSystem/weather';
    this._envPoints.frustumCulled = false;
    this._envPoints.renderOrder = 59;
    this._root.add(this._envPoints);

    this._scene.add(this._root);

    // 预分配批次对象，环形复用；indices 固定长度，零 GC
    for (let i = 0; i < BATCH_CAP; i++) {
      this._batches.push({ indices: new Int32Array(MAX_PER_BURST), count: 0, expire: -1, live: false, kind: 0 });
    }

    // 文字栅格化用的可复用 canvas（不是 GPU 资源，不影响资源计数）
    this._canvas = document.createElement('canvas');
    this._ctx2d = this._canvas.getContext('2d', { willReadFrequently: true });

    this._inited = true;
    console.info(`[FireworkSystem] 初始化完成 | 容量=${CAP} | 批次池=${BATCH_CAP} | draw call=1`);
    return this;
  }

  /** 窗口尺寸 / DPR 变化时同步 uniform */
  resize() {
    if (!this._inited || this._disposed) return;
    this._mat.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
    this._mat.uniforms.uViewportH.value = window.innerHeight || 720;
    if (this._envMat) {
      this._envMat.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
      this._envMat.uniforms.uViewportH.value = window.innerHeight || 720;
    }
  }

  /** 白天效果减弱（0.45~1.0），由 FireworksDeck 依据昼夜模式设置 */
  setBrightness(v) {
    this._brightness = Math.min(1, Math.max(0.3, Number(v) || 1));
    return this;
  }
  get brightness() { return this._brightness; }

  /** 仅 lobby / fireworks-deck 生效；切到其它设施立即清场 */
  setContext(key) {
    this._contextKey = key;
    const on = key === 'lobby' || key === 'fireworks-deck';
    this._active = on;
    if (this._root) this._root.visible = on;
    if (!on) this.clear();
    return this;
  }

  get activeCount() {
    let n = 0;
    for (const b of this._batches) if (b.live) n += b.count;
    return n;
  }

  /** 当前天气粒子数（批次 kind >= 4），供四季验收读取。 */
  get weatherCount() {
    let n = 0;
    for (const b of this._batches) if (b.live && b.kind >= 4) n += b.count;
    return n;
  }

  /** 清空天气批次，只把对应槽位 aLife 置 0，不碰仍在播放的烟花。 */
  clearWeather() {
    if (!this._inited) return this;
    const life = this._geo.getAttribute('aLife');
    for (const b of this._batches) {
      if (!b.live || b.kind < 4) continue;
      for (let i = 0; i < b.count; i += 1) life.array[b.indices[i]] = 0;
      this._releaseBatch(b);
    }
    if (typeof life.clearUpdateRanges === 'function') life.clearUpdateRanges();
    life.needsUpdate = true;
    return this;
  }

  /* ----------------------------- 对象池 ----------------------------- */

  /**
   * 环形找一个空闲批次；若全忙，强制回收最老的一批（覆盖式，绝不 new）。
   * @param {number} n 需求粒子数（保留签名，供未来按容量挑批）
   * @param {number} [minKind=0] 可回收批次的最小 kind。天气传 WEATHER_KIND_MIN，
   *   保证池满时只回收天气批次，不误杀正在播放的烟花（kind=0）。
   *   若没有任何符合 minKind 的批次，则退化为回收全局最老的一批（保发射不中断）。
   */
  _allocBatch(n, minKind = 0) {
    for (let k = 0; k < BATCH_CAP; k++) {
      const idx = (this._batchCursor + k) % BATCH_CAP;
      const b = this._batches[idx];
      if (!b.live) { this._batchCursor = (idx + 1) % BATCH_CAP; return b; }
    }
    let oldest = null;
    let oldestAny = this._batches[0];
    for (const b of this._batches) {
      if (b.expire < oldestAny.expire) oldestAny = b;
      if (b.kind >= minKind && (!oldest || b.expire < oldest.expire)) oldest = b;
    }
    this._releaseBatch(oldest ?? oldestAny);
    return oldest ?? oldestAny;
  }

  _releaseBatch(b) {
    if (!b.live) return;
    for (let i = 0; i < b.count; i++) this._free[this._freeTop++] = b.indices[i];
    b.live = false;
    b.count = 0;
    b.expire = -1;
    b.kind = 0;
  }

  _reap() {
    for (const b of this._batches) {
      if (b.live && b.expire <= this._time) this._releaseBatch(b);
    }
  }

  /** 清空所有活跃粒子（切设施 / 重开时用） */
  clear() {
    if (!this._inited) return this;
    for (const b of this._batches) this._releaseBatch(b);
    const life = this._geo.getAttribute('aLife');
    life.array.fill(0);
    if (typeof life.clearUpdateRanges === 'function') life.clearUpdateRanges();
    life.needsUpdate = true;
    return this;
  }

  /**
   * 预热：把四种花型 + 文字的发射路径全走一遍（上传 shader / attribute），
   * 随后立即清场。绕过 MIN_INTERVAL 频率闸门，仅用于 main.js 预热阶段。
   */
  warmUp(position = { x: 0, y: 18, z: -22 }) {
    if (!this._inited || this._disposed) return this;
    const prevActive = this._active;
    this._active = true;
    const types = ['burst', 'star', 'waterfall'];
    for (const t of types) {
      this._lastLaunch = -Infinity;
      this._emit(position, 40, t, 0xffd24a, 1, 1.0, null);
    }
    this._lastLaunch = -Infinity;
    const cells = this._rasterizeText('烟花');
    // 传原数组（其上挂有 step/canvasH，slice 会丢失 → dotSize 变 NaN）
    if (cells.length) this._emit(position, Math.min(cells.length, 60), 'text', 0xffd24a, 1.5, 1.0, cells);
    // 预热天气着色器，避免第一次入秋/入冬时现场编译造成掉帧
    for (const kind of ['petal', 'leaf', 'snow', 'rain']) {
      this.emitWeather(kind, position, 12);
    }
    this.clear();
    this._lastLaunch = -Infinity;
    this._active = prevActive;
    return this;
  }

  /* ----------------------------- 发射 ----------------------------- */

  /**
   * 发射一枚烟花。
   * @param {THREE.Vector3|{x,y,z}} position 爆心（世界坐标）
   * @param {'burst'|'star'|'waterfall'|'text'|number} type
   * @param {number|THREE.Color} color 主色
   * @param {number} size 尺寸（世界单位，约 0.5~2）
   * @param {number} duration 寿命（秒）
   */
  launch(position, type = 'burst', color = 0xffd24a, size = 1, duration = 2.2) {
    if (!this._inited || this._disposed || !this._active) return false;
    if (this._time - this._lastLaunch < MIN_INTERVAL) return false;
    const p = position || { x: 0, y: 12, z: 0 };
    const tKey = typeof type === 'number' ? (['burst', 'star', 'waterfall', 'text'][type] || 'burst') : type;
    if (tKey === 'text') return false; // 文字必须走 launchText
    this._lastLaunch = this._time;

    const n = tKey === 'waterfall' ? 190 : tKey === 'star' ? 170 : 210;
    return this._emit(p, n, tKey, color, size, duration, null);
  }

  /**
   * 文字烟花：canvas 栅格化 → 像素点阵 → 面向相机的目标点。
   * @param {THREE.Vector3|{x,y,z}} position 爆心（文字中心最终所在处）
   * @param {string} text 文字内容（最多 12 字符）
   * @param {number|THREE.Color} color
   * @param {number} fontSize 每个字的世界高度（0.6~3）
   */
  launchText(position, text, color = 0xffd24a, fontSize = 1.4) {
    if (!this._inited || this._disposed || !this._active) return false;
    if (this._time - this._lastLaunch < MIN_INTERVAL) return false;
    const str = String(text ?? '').trim().slice(0, 12);
    if (!str) return false;
    this._lastLaunch = this._time;

    const cells = this._rasterizeText(str);
    if (!cells.length) return false;
    const p = position || { x: 0, y: 16, z: 0 };
    return this._emit(p, Math.min(cells.length, MAX_PER_BURST), 'text', color,
      Math.min(2.2, Math.max(0.6, fontSize)), 3.6, cells);
  }

  /** 用可复用 canvas 采样文字像素，返回归一化到 [-0.5,0.5] 的点集 */
  _rasterizeText(str) {
    const g = this._ctx2d;
    if (!g) return [];
    const FONT_PX = 76;
    const pad = 12;
    this._canvas.width = Math.ceil(FONT_PX * str.length * 1.05) + pad * 2;
    this._canvas.height = FONT_PX + pad * 2;
    g.clearRect(0, 0, this._canvas.width, this._canvas.height);
    g.font = `900 ${FONT_PX}px system-ui, "Microsoft YaHei", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(str, this._canvas.width / 2, this._canvas.height / 2);

    const img = g.getImageData(0, 0, this._canvas.width, this._canvas.height).data;
    const W = this._canvas.width, H = this._canvas.height;
    // 自适应步长，保证点数 <= MAX_PER_BURST（点阵清晰且稳定）
    let step = 3;
    let cells = [];
    for (; step <= 12; step++) {
      cells = [];
      for (let y = 0; y < H; y += step) {
        for (let x = 0; x < W; x += step) {
          if (img[(y * W + x) * 4 + 3] > 110) cells.push([x, y]);
        }
      }
      if (cells.length <= MAX_PER_BURST) break;
    }
    if (cells.length > MAX_PER_BURST) {
      // 均匀抽样，不破坏字形整体轮廓
      const out = [];
      const k = cells.length / MAX_PER_BURST;
      for (let i = 0; i < MAX_PER_BURST; i++) out.push(cells[Math.floor(i * k)]);
      cells = out;
    }
    const mapped = cells.map(([x, y]) => ({
      nx: (x / W - 0.5),
      ny: (0.5 - y / H),
      aspect: W / H,
    }));
    // 点距（canvas 像素步长 / 画布高）随点阵一起传给发射器，
    // 用于让粒子直径 ≈ 点距，保证任意距离下字形都清晰不糊。
    mapped.step = step;
    mapped.canvasH = H;
    return mapped;
  }

  /**
   * 季节天气发射：复用烟花对象池与 BufferGeometry，不走 MIN_INTERVAL，
   * 也不新建任何数组/粒子对象。
   * @param {'petal'|'leaf'|'snow'|'rain'} kind
   * @param {{x:number,y:number,z:number}|null} center 观察者附近
   * @param {number} n 本次粒子数
   */
  emitWeather(kind, center, n = 20) {
    if (!this._inited || this._disposed) return false;
    const typeId = { petal: 4, leaf: 5, snow: 6, rain: 7 }[kind];
    if (!typeId) return false;
    const count = Math.max(1, Math.min(48, Math.floor(n)));
    // 【池回收隔离】只回收天气批次（kind>=4），绝不误杀正在播放的烟花/文字。
    // 天气是持续背景效果，被回收一批肉眼难察；烟花是一次性演出，被截断很显眼。
    if (this._freeTop < count) {
      let guard = 0;
      while (this._freeTop < count && guard++ < BATCH_CAP) {
        let oldest = null;
        for (const b of this._batches) {
          if (b.live && b.kind >= WEATHER_KIND_MIN && (!oldest || b.expire < oldest.expire)) oldest = b;
        }
        if (!oldest) break;
        this._releaseBatch(oldest);
      }
    }
    if (this._freeTop < count) return false;

    const batch = this._allocBatch(count, WEATHER_KIND_MIN);
    const idxs = batch.indices;
    for (let i = 0; i < count; i += 1) idxs[i] = this._free[--this._freeTop];

    const geo = this._geo;
    const aPos = geo.getAttribute('position');
    const aVel = geo.getAttribute('aVel');
    const aCol = geo.getAttribute('aColor');
    const aBirth = geo.getAttribute('aBirth');
    const aLife = geo.getAttribute('aLife');
    const aSize = geo.getAttribute('aSize');
    const aType = geo.getAttribute('aType');
    const aSeed = geo.getAttribute('aSeed');
    const cx = center?.x ?? 0;
    const cy = center?.y ?? 8;
    const cz = center?.z ?? 0;
    const span = kind === 'rain' ? 30 : 26;
    const dropY = kind === 'rain' ? 13 : 9;
    let minIdx = CAP, maxIdx = -1;

    for (let i = 0; i < count; i += 1) {
      const idx = idxs[i];
      if (idx < minIdx) minIdx = idx;
      if (idx > maxIdx) maxIdx = idx;
      const i3 = idx * 3;
      const r = Math.random;
      aPos.array[i3] = cx + (r() * 2 - 1) * span;
      aPos.array[i3 + 1] = cy + dropY + r() * (kind === 'rain' ? 10 : 9);
      aPos.array[i3 + 2] = cz + (r() * 2 - 1) * span;

      if (kind === 'rain') {
        aVel.array[i3] = (r() - 0.5) * 0.4;
        aVel.array[i3 + 1] = -13 - r() * 5;
        aVel.array[i3 + 2] = (r() - 0.5) * 0.4;
      } else if (kind === 'snow') {
        aVel.array[i3] = (r() - 0.5) * 0.7;
        aVel.array[i3 + 1] = -0.55 - r() * 0.35;
        aVel.array[i3 + 2] = (r() - 0.5) * 0.7;
      } else if (kind === 'leaf') {
        aVel.array[i3] = (r() - 0.5) * 1.5;
        aVel.array[i3 + 1] = -0.9 - r() * 0.7;
        aVel.array[i3 + 2] = (r() - 0.5) * 1.5;
      } else {
        aVel.array[i3] = (r() - 0.5) * 1.5;
        aVel.array[i3 + 1] = -0.55 - r() * 0.55;
        aVel.array[i3 + 2] = (r() - 0.5) * 1.5;
      }

      const life = kind === 'rain' ? 1.15 + r() * 0.45 : 6.0 + r() * 2.5;
      aBirth.array[idx] = this._time + r() * 0.08;
      aLife.array[idx] = life;
      aSize.array[idx] = kind === 'rain' ? 0.34 : kind === 'snow' ? 0.24 : kind === 'leaf' ? 0.34 : 0.28;
      aType.array[idx] = typeId;
      aSeed.array[idx] = r() * 100;

      const palette = WEATHER_PALETTES[kind]; // 模块级常量：热路径零 new 数组
      this._tmpColor.setHex(palette[(r() * palette.length) | 0]);
      aCol.array[i3] = this._tmpColor.r;
      aCol.array[i3 + 1] = this._tmpColor.g;
      aCol.array[i3 + 2] = this._tmpColor.b;
    }

    const start = minIdx;
    const length = maxIdx - minIdx + 1;
    for (const a of [aPos, aVel, aCol, aBirth, aLife, aSize, aType, aSeed]) {
      if (typeof a.clearUpdateRanges === 'function') a.clearUpdateRanges();
      if (typeof a.addUpdateRange === 'function') a.addUpdateRange(start * a.itemSize, length * a.itemSize);
      a.needsUpdate = true;
    }
    batch.count = count;
    batch.expire = this._time + 10.2;
    batch.live = true;
    batch.kind = typeId;
    return true;
  }

  /** 内部统一发射：写一段 TypedArray，局部上传 */
  _emit(p, n, type, color, size, duration, cells) {
    if (this._freeTop < n) {
      // 空间不足：优先回收最老的烟花批次（kind<4），天气批次作为次选。
      // 与 emitWeather 的隔离策略对称：两类效果互不误杀，池满时仍有兜底。
      let guard = 0;
      while (this._freeTop < n && guard++ < BATCH_CAP) {
        let oldest = null;
        let fallback = null;
        for (const b of this._batches) {
          if (!b.live) continue;
          if (!fallback || b.expire < fallback.expire) fallback = b;
          if (b.kind < WEATHER_KIND_MIN && (!oldest || b.expire < oldest.expire)) oldest = b;
        }
        const victim = oldest ?? fallback;
        if (!victim) break;
        this._releaseBatch(victim);
      }
    }
    const count = Math.min(n, this._freeTop);
    if (count <= 0) return false;

    const batch = this._allocBatch(count);
    const batchIndices = batch.indices;
    for (let i = 0; i < count; i++) batchIndices[i] = this._free[--this._freeTop];

    const geo = this._geo;
    const aPos = geo.getAttribute('position');
    const aVel = geo.getAttribute('aVel');
    const aCol = geo.getAttribute('aColor');
    const aBirth = geo.getAttribute('aBirth');
    const aLife = geo.getAttribute('aLife');
    const aSize = geo.getAttribute('aSize');
    const aType = geo.getAttribute('aType');
    const aSeed = geo.getAttribute('aSeed');

    // 主色固化成 3 个标量：循环里 _tmpColor 还会被「混入调色板」复用，
    // 直接持有 Color 引用会让后续粒子的主色被上一次混色污染。
    this._tmpColor.set(color ?? 0xffd24a);
    const baseR = this._tmpColor.r, baseG = this._tmpColor.g, baseB = this._tmpColor.b;
    const bx = p.x ?? 0, by = p.y ?? 12, bz = p.z ?? 0;
    const typeId = type === 'star' ? 1 : type === 'waterfall' ? 2 : type === 'text' ? 3 : 0;
    const bright = this._brightness;
    // 文字：粒子直径 ≈ 点距（step/canvasH × 世界字高）×1.45，
    // 保证任意相机距离下笔画连续、字形不糊也不糊成一片。
    // 世界字高 = fontSize × 3.2：20~35m 观看距离下点约 3~5px，加 Bloom 后清晰。
    const worldScale = cells ? Math.max(0.6, size) * 3.2 : 1;
    const dotSize = cells ? (cells.step / cells.canvasH) * worldScale * 1.45 : 0;

    // 文字：取相机 right/up 基向量，让点阵始终正对镜头
    if (cells) {
      this._camera.updateMatrixWorld();
      const e = this._camera.matrixWorld.elements;
      this._tmpRight.set(e[0], e[1], e[2]).normalize();
      this._tmpUp.set(e[4], e[5], e[6]).normalize();
    }

    let minIdx = CAP, maxIdx = -1;
    for (let i = 0; i < count; i++) {
      const idx = batchIndices[i];
      if (idx < minIdx) minIdx = idx;
      if (idx > maxIdx) maxIdx = idx;
      const i3 = idx * 3;
      const seed = Math.random();
      aBirth.array[idx] = this._time + Math.random() * 0.06;
      aLife.array[idx] = duration * (0.85 + Math.random() * 0.3);
      aSize.array[idx] = cells ? dotSize : size * (0.7 + Math.random() * 0.6);
      aType.array[idx] = typeId;
      aSeed.array[idx] = seed * 100;

      // 颜色：主色 + 调色板随机混入（标准爆炸多色混合），并乘白天衰减
      let r = baseR, gg = baseG, b = baseB;
      if (!cells && Math.random() < 0.38) {
        const mix = FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0].hex;
        this._tmpColor.set(mix);
        const k = 0.35 + Math.random() * 0.3;
        r += (this._tmpColor.r - r) * k;
        gg += (this._tmpColor.g - gg) * k;
        b += (this._tmpColor.b - b) * k;
      }
      const lum = bright * (0.82 + Math.random() * 0.35);
      aCol.array[i3] = r * lum;
      aCol.array[i3 + 1] = gg * lum;
      aCol.array[i3 + 2] = b * lum;

      aPos.array[i3] = bx;
      aPos.array[i3 + 1] = by;
      aPos.array[i3 + 2] = bz;

      if (cells) {
        // aVel 复用为「目标点 - 爆心」的世界偏移
        const c = cells[i];
        const w = c.nx * c.aspect * worldScale;
        const h = c.ny * worldScale;
        aVel.array[i3] = this._tmpRight.x * w + this._tmpUp.x * h;
        aVel.array[i3 + 1] = this._tmpRight.y * w + this._tmpUp.y * h;
        aVel.array[i3 + 2] = this._tmpRight.z * w + this._tmpUp.z * h;
      } else if (type === 'waterfall') {
        const a = Math.random() * Math.PI * 2;
        const r2 = Math.random() * 1.5;
        aVel.array[i3] = Math.cos(a) * r2;
        aVel.array[i3 + 1] = -1.2 - Math.random() * 1.4;
        aVel.array[i3 + 2] = Math.sin(a) * r2;
      } else if (type === 'star') {
        // 5 角星：角度量化到 5 个尖角，内外半径交替
        const spoke = Math.floor(Math.random() * 5);
        const ang = (spoke / 5) * Math.PI * 2 + (Math.random() - 0.5) * 0.16;
        const inner = Math.random() < 0.32;
        const sp = (inner ? 2.2 : 5.4) * (0.85 + Math.random() * 0.3);
        aVel.array[i3] = Math.cos(ang) * sp;
        aVel.array[i3 + 1] = Math.sin(ang) * sp + 1.1;
        aVel.array[i3 + 2] = (Math.random() - 0.5) * 1.1;
      } else {
        // 标准球形：均匀球面方向
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const sp = (4.2 + Math.random() * 3.2) * (0.7 + size * 0.3);
        aVel.array[i3] = Math.cos(th) * s * sp;
        aVel.array[i3 + 1] = u * sp + 1.4;
        aVel.array[i3 + 2] = Math.sin(th) * s * sp;
      }
    }

    // 局部上传（索引连续时最省；不连续则整段 [min,max]）
    const start = minIdx, length = maxIdx - minIdx + 1;
    for (const a of [aPos, aVel, aCol, aBirth, aLife, aSize, aType, aSeed]) {
      if (typeof a.clearUpdateRanges === 'function') a.clearUpdateRanges();
      if (typeof a.addUpdateRange === 'function') a.addUpdateRange(start * a.itemSize, length * a.itemSize);
      a.needsUpdate = true;
    }

    batch.count = count;
    batch.expire = this._time + duration * 1.2 + 0.2;
    batch.live = true;
    batch.kind = 0;
    return true;
  }

  /* ----------------------------- 每帧 ----------------------------- */

  update(dt) {
    if (!this._inited || this._disposed || !this._active) return;
    this._time += Math.min(Math.max(dt, 0), 0.1);
    this._mat.uniforms.uTime.value = this._time;
    if (this._envMat) this._envMat.uniforms.uTime.value = this._time;
    this._reap();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.clear();
    if (this._root) {
      this._scene?.remove(this._root);
      this._root.clear();
      this._root = null;
    }
    try { this._geo?.dispose(); } catch (e) { /* noop */ }
    try { this._mat?.dispose(); } catch (e) { /* noop */ }
    try { this._envMat?.dispose(); } catch (e) { /* noop */ }
    this._geo = null; this._mat = null; this._points = null;
    this._envMat = null; this._envPoints = null;
    this._batches.length = 0;
    this._canvas = null; this._ctx2d = null;
    this._inited = false;
  }
}

/** 全局唯一实例 */
export const fireworkSystem = new FireworkSystemImpl();
export default fireworkSystem;
