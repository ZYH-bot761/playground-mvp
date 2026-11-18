/**
 * ============================================================================
 * DayNightCycle.js —— 全局昼夜循环系统（单例）
 * ============================================================================
 * 第七部分 / 指令 1：白天 · 黄昏 · 黑夜三模式 + 平滑过渡 + 太阳/月亮 + 霓虹。
 *
 * 【为什么不能直接照抄提示词的强度数值】
 * 本项目 SceneManager 使用 `toneMappingExposure = 1.0`，并把背景/雾/自发光
 * 在「线性空间」预乘 EXPOSURE_COMP=0.38 来抵消曝光；基座主光只有 0.58、
 * 环境光 0.07。提示词给的 sunIntensity 1.5 / ambientIntensity 0.4 是常规
 * three 场景（exposure≈0.38）下的数值，直接写进来会整屏过曝。因此下面
 * PRESETS 保留了提示词给出的**色值**（skyColor / sunColor / ambientColor），
 * 强度按本项目基准标定：主光 1.5→0.58（×0.387）、环境 0.4→0.07（×0.175），
 * 黄昏/黑夜按同一比例缩放。视觉意图（暖阳 / 暗蓝 / 霓虹）完全保留。
 *
 * 【与 Lobby 的冲突处理（本项目特有，必须先读源码）】
 *  1) Lobby 用 Sky.js 天空球（scale 150）盖住 scene.background，且对
 *     fragmentShader 做了硬编码偏蓝增益。只改 background 看不到天空变化。
 *     → Lobby 把那段增益改成 uSkyTint / uSkyBrightness 两个 uniform，
 *       本类 registerSky() 后每帧 lerp 它们 + sunPosition + 散射参数。
 *  2) Lobby.dispose() 只还原外部灯的 intensity / castShadow，**不还原 color /
 *     position**。若本类改了灯颜色而不还原，切到跑酷等设施会串成夜色。
 *     → 本类 init() 保存三盏基座灯的【完整快照】，setContext() 切到非大厅
 *       设施时调用 _restoreBaseline() 逐项还原（含 color / groundColor / 位置）。
 *  3) 全局单例每帧无人驱动：SceneManager 循环只调 physics.step + attractions.update。
 *     → main.js 包装 attractionManager.update 链，零 core 改动，暂停闸门仍生效。
 *  4) 太阳/月亮/星空 root 常驻 scene（不打 attractionRoot 标记，不会被
 *     AttractionManager.deactivate 清理），在预热前 renderOnce 上传 → 计入基线。
 *
 * 【API】
 *   init({ scene, renderer, camera, bloomPass, lights })  幂等初始化
 *   setMode('day'|'sunset'|'night')                       手动切模式（会关自动）
 *   setAuto(bool) / toggleAuto() / autoPeriod             5~10 分钟自动循环
 *   setContext(attractionKey)                           设施切换时挂载/还原
 *   registerSky(skyMaterial) / unregisterSky()           Lobby 天空球
 *   registerLobbyMaterials(set) / clearLobbyMaterials()   霓虹 emissive 提亮
 *   update(dt) / applyImmediate() / onChange(fn)
 *   dispose()
 * ============================================================================
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;
const EXPOSURE_COMP = 0.38;

export const DAY_NIGHT_MODES = Object.freeze(['day', 'sunset', 'night']);
export const MODE_LABELS = Object.freeze({ day: '白天', sunset: '黄昏', night: '黑夜' });

/**
 * 【v4 T03】昼夜生效的「大厅态」上下文白名单。
 * 嵌入视图（IEmbeddedView）全程仍在大厅场景里，只是换了相机机位，因此必须
 * 继续让天空 / 太阳 / 星空 / 霓虹发光生效，绝不能像跑酷那样 _restoreBaseline。
 * T04/T07/T08 接入新嵌入设施时调用 dayNightCycle.registerEmbeddedContext(key)
 * 即可，无需再改本文件。
 */
const LOBBY_LIKE_CONTEXTS = new Set([
  'lobby', 'fireworks-deck', 'century-clock', 'demo-embed',
]);

/** 提示词原始参数（保留作为配置来源与审计依据） */
export const DAY_NIGHT_SPEC = Object.freeze({
  day:    { skyColor: 0x87CEEB, sunColor: 0xFFFFF0, sunIntensity: 1.5, ambientColor: 0x404060, ambientIntensity: 0.4 },
  sunset: { skyColor: 0xFF7F50, sunColor: 0xFF6347, sunIntensity: 0.8, ambientColor: 0x302040, ambientIntensity: 0.25 },
  night:  { skyColor: 0x0a0a2e, sunColor: 0x4466AA, sunIntensity: 0.1, ambientColor: 0x101030, ambientIntensity: 0.15 },
});

/** 本项目标定后的强度系数（见文件头说明） */
const SUN_SCALE = 0.387;   // 1.5 → 0.58
const AMB_SCALE = 0.175;   // 0.4 → 0.07

const C = (hex) => new THREE.Color(hex);

/**
 * 完整状态。颜色一律用 THREE.Color（构造时已 sRGB→线性），
 * 数值用 number；_lerpState 据此逐通道/逐标量插值，保证切换无突变。
 */
function makePreset(name, o, extra) {
  const spec = DAY_NIGHT_SPEC[name];
  return {
    sky: C(spec.skyColor),
    fog: C(o.fogColor),
    sunLight: C(spec.sunColor),
    sunIntensity: spec.sunIntensity * SUN_SCALE,
    ambient: C(spec.ambientColor),
    ambientIntensity: Math.max(spec.ambientIntensity * AMB_SCALE, o.ambientFloor ?? 0),
    hemiSky: C(o.hemiSky),
    hemiGround: C(o.hemiGround),
    hemiIntensity: o.hemiIntensity,
    envIntensity: o.envIntensity,
    exposure: o.exposure,
    bloomStrength: o.bloomStrength,
    bloomThreshold: o.bloomThreshold,
    skyTint: new THREE.Vector3(...o.skyTint),
    skyBrightness: o.skyBrightness,
    rayleigh: o.rayleigh,
    turbidity: o.turbidity,
    mie: o.mie,
    sunElevation: o.sunElevation,
    lightElevation: o.lightElevation,
    azimuth: o.azimuth ?? 40,
    sunOpacity: o.sunOpacity,
    moonOpacity: o.moonOpacity,
    starOpacity: o.starOpacity,
    neonBoost: o.neonBoost,
    ...extra,
  };
}

const PRESETS = Object.freeze({
  // 白天：与当前日间大厅完全一致（基线值），不产生任何视觉/资源回归
  day: makePreset('day', {
    fogColor: 0xa8b0b4, hemiSky: 0xbfe3ff, hemiGround: 0x24331c,
    hemiIntensity: 0.30, envIntensity: 1.1 * EXPOSURE_COMP, exposure: 1.0,
    bloomStrength: 0.06, bloomThreshold: 1.4,
    skyTint: [0.55, 0.62, 0.78], skyBrightness: 1.0,
    rayleigh: 1.4, turbidity: 2.1, mie: 0.0025,
    sunElevation: 46, lightElevation: 46,
    sunOpacity: 1, moonOpacity: 0, starOpacity: 0, neonBoost: 1,
  }),
  // 黄昏：太阳压到 6°，瑞利散射增强出橙红，阴影拉长，天空暖橙
  sunset: makePreset('sunset', {
    fogColor: 0xc08a6a, hemiSky: 0xffb27a, hemiGround: 0x2a1c18,
    hemiIntensity: 0.22, envIntensity: 0.72 * EXPOSURE_COMP, exposure: 0.94,
    bloomStrength: 0.22, bloomThreshold: 0.95,
    skyTint: [0.98, 0.60, 0.42], skyBrightness: 0.88,
    rayleigh: 3.0, turbidity: 4.2, mie: 0.006,
    sunElevation: 6, lightElevation: 8,
    sunOpacity: 1, moonOpacity: 0, starOpacity: 0.06, neonBoost: 1.7,
  }),
  // 黑夜：日轮隐去、月亮升起、星空显现、环境转暗蓝、霓虹 + Bloom 拉满
  night: makePreset('night', {
    fogColor: 0x141a34, hemiSky: 0x35406e, hemiGround: 0x0a0c18,
    hemiIntensity: 0.13, envIntensity: 0.30 * EXPOSURE_COMP, exposure: 0.86,
    bloomStrength: 0.55, bloomThreshold: 0.55,
    skyTint: [0.30, 0.36, 0.72], skyBrightness: 0.34,
    rayleigh: 0.7, turbidity: 2.0, mie: 0.0018,
    sunElevation: -12, lightElevation: 28,
    sunOpacity: 0, moonOpacity: 1, starOpacity: 1, neonBoost: 3.6,
    ambientFloor: 0.055, // 全黑会看不见路，给一点月光底
  }),
});

const NUM_KEYS = [
  'sunIntensity', 'ambientIntensity', 'hemiIntensity', 'envIntensity', 'exposure',
  'bloomStrength', 'bloomThreshold', 'skyBrightness', 'rayleigh', 'turbidity',
  'mie', 'sunElevation', 'lightElevation', 'azimuth',
  'sunOpacity', 'moonOpacity', 'starOpacity', 'neonBoost',
];
const COLOR_KEYS = ['sky', 'fog', 'sunLight', 'ambient', 'hemiSky', 'hemiGround'];
const VEC_KEYS = ['skyTint'];

function cloneState(s) {
  const o = {};
  for (const k of NUM_KEYS) o[k] = s[k];
  for (const k of COLOR_KEYS) o[k] = s[k].clone();
  for (const k of VEC_KEYS) o[k] = s[k].clone();
  return o;
}

function lerpState(a, b, t, out) {
  for (const k of NUM_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  for (const k of COLOR_KEYS) out[k].copy(a[k]).lerp(b[k], t);
  for (const k of VEC_KEYS) out[k].copy(a[k]).lerp(b[k], t);
  return out;
}

const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

class DayNightCycleImpl {
  constructor() {
    this._inited = false;
    this._disposed = false;
    this._scene = null;
    this._renderer = null;
    this._camera = null;
    this._bloom = null;
    this._lights = null;
    this._baseline = null;

    this._mode = 'day';
    this._auto = false;
    this._autoPeriod = 480;      // 8 分钟一轮（5~10 分钟区间内）
    this._autoElapsed = 0;
    this._time = 0;
    /** 四季光照倍率：只乘主光强度，不改变昼夜预设本身 */
    this._seasonSunScale = 1;

    this._active = true;         // 只在 lobby / fireworks-deck 生效
    this._contextKey = 'lobby';
    this._skyMat = null;
    this._neonMats = [];
    this._listeners = new Set();

    this._target = cloneState(PRESETS.day);
    this._cur = cloneState(PRESETS.day);
    this._tmpState = cloneState(PRESETS.day);

    // 场景资源（dispose 释放）
    this._root = null;
    this._geometries = [];
    this._materials = [];
    this._sun = null; this._moon = null; this._stars = null;

    this._dirV = new THREE.Vector3();
    this._scratch = new THREE.Color();
  }

  /* ----------------------------- 生命周期 ----------------------------- */

  /**
   * 幂等初始化。必须在任何设施预热之前调用（main.js bootstrap 早期），
   * 这样 root 的 GPU 资源会在预热 renderOnce() 时上传并计入本次会话基线。
   */
  init({ scene, renderer, camera, bloomPass, lights }) {
    if (this._inited || this._disposed) return this;
    if (!scene || !renderer || !camera) {
      console.warn('[DayNightCycle] init 缺少 scene/renderer/camera，跳过');
      return this;
    }
    this._scene = scene;
    this._renderer = renderer;
    this._camera = camera;
    this._bloom = bloomPass ?? null;
    this._lights = lights ?? {
      ambient: scene.children.find((o) => o.isAmbientLight),
      hemisphere: scene.children.find((o) => o.isHemisphereLight),
      directional: scene.children.find((o) => o.isDirectionalLight),
    };

    this._saveBaseline();
    this._buildScene();
    this._inited = true;
    this._apply(); // 默认白天 = 基线值，不改变任何外观
    this._emit();
    console.info('[DayNightCycle] 初始化完成 | 模式=白天 | 自动循环关闭 | 周期=480s');
    return this;
  }

  _saveBaseline() {
    const { ambient, hemisphere, directional } = this._lights;
    this._baseline = {
      background: this._scene.background?.isColor ? this._scene.background.clone() : null,
      fogColor: this._scene.fog?.color ? this._scene.fog.color.clone() : null,
      fogNear: this._scene.fog?.near ?? 45,
      fogFar: this._scene.fog?.far ?? 130,
      envIntensity: this._scene.environmentIntensity ?? 0.418,
      exposure: this._renderer.toneMappingExposure,
      bloomStrength: this._bloom?.strength ?? 0.06,
      bloomThreshold: this._bloom?.threshold ?? 1.4,
      lights: {},
    };
    for (const [key, light] of Object.entries({ ambient, hemisphere, directional })) {
      if (!light) continue;
      this._baseline.lights[key] = {
        color: light.color.clone(),
        groundColor: light.groundColor ? light.groundColor.clone() : null,
        intensity: light.intensity,
        position: light.position.clone(),
        castShadow: light.castShadow,
      };
    }
  }

  /** 太阳 / 月亮 / 星空：1 个共享球几何 + 1 个 Points 几何，全部常驻 */
  _buildScene() {
    const root = new THREE.Group();
    root.name = 'DayNightCycle/global';
    // 不打 attractionRoot 标记 → AttractionManager.deactivate 不会误删
    root.renderOrder = -900;

    const sphere = new THREE.SphereGeometry(1, 20, 14);
    this._geometries.push(sphere);

    const mkBody = (color, radius) => {
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0, depthWrite: false,
        fog: false, toneMapped: false,
      });
      const glowMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
      });
      this._materials.push(mat, glowMat);
      const g = new THREE.Group();
      const body = new THREE.Mesh(sphere, mat);
      body.scale.setScalar(radius);
      body.frustumCulled = false;
      const glow = new THREE.Mesh(sphere, glowMat);
      glow.scale.setScalar(radius * 2.15);
      glow.frustumCulled = false;
      g.add(body, glow);
      g.userData = { mat, glowMat };
      root.add(g);
      return g;
    };

    this._sun = mkBody(0xfff3c4, 3.1);
    this._moon = mkBody(0xd8e4ff, 2.5);

    // 星空：600 个点，均匀分布在半径 70 的上半球壳
    const N = 600;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random();
      const phi = Math.random() * Math.PI * 2;
      const y = 0.06 + u * 0.94;             // 只在地平线以上
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const R = 68 + Math.random() * 4;
      pos[i * 3] = Math.cos(phi) * r * R;
      pos[i * 3 + 1] = y * R;
      pos[i * 3 + 2] = Math.sin(phi) * r * R;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._geometries.push(starGeo);
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.9, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false,
      fog: false, toneMapped: false,
    });
    this._materials.push(starMat);
    this._stars = new THREE.Points(starGeo, starMat);
    this._stars.frustumCulled = false;
    root.add(this._stars);

    this._root = root;
    this._scene.add(root);
  }

  /* ----------------------------- 公共 API ----------------------------- */

  get mode() { return this._mode; }
  get modeLabel() { return MODE_LABELS[this._mode]; }
  get isAuto() { return this._auto; }
  get autoPeriod() { return this._autoPeriod; }
  get isActive() { return this._active; }

  /** 手动切换模式；会关闭自动循环（符合直觉） */
  setMode(mode) {
    if (!DAY_NIGHT_MODES.includes(mode)) return this;
    this._auto = false;
    this._mode = mode;
    this._emit();
    return this;
  }

  setAuto(on) {
    this._auto = Boolean(on);
    if (this._auto) this._autoElapsed = this._autoPhaseForMode(this._mode);
    else this._mode = this._nearestMode();
    this._emit();
    return this;
  }

  toggleAuto() { return this.setAuto(!this._auto); }

  setAutoPeriod(seconds) {
    this._autoPeriod = Math.min(600, Math.max(300, Number(seconds) || 480));
    return this;
  }

  onChange(fn) {
    if (typeof fn === 'function') this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn({ mode: this._mode, auto: this._auto, period: this._autoPeriod }); }
      catch (err) { console.warn('[DayNightCycle] onChange 回调异常：', err); }
    }
  }

  /**
   * v4 T03：登记一个新嵌入设施 key 为「大厅态」上下文（昼夜继续生效）。
   * 幂等；返回 this 便于链式调用。禁止传空 key。
   * @param {string} key
   * @returns {this}
   */
  registerEmbeddedContext(key) {
    if (typeof key === 'string' && key.length > 0) LOBBY_LIKE_CONTEXTS.add(key);
    return this;
  }

  /**
   * 设施切换上下文：大厅态白名单（lobby / fireworks-deck / century-clock /
   * 所有已登记的嵌入设施）生效。切到独立场景（跑酷 / 记忆翻牌等）时
   * 【完整还原】基座灯光（含 color/position，Lobby 不还原它们），
   * 并隐藏太阳/月亮/星空，杜绝夜色串味。
   */
  setContext(key) {
    this._contextKey = key;
    const shouldBeActive = LOBBY_LIKE_CONTEXTS.has(key);
    if (shouldBeActive === this._active && this._inited) {
      if (shouldBeActive) this.applyImmediate();
      return this;
    }
    this._active = shouldBeActive;
    if (!this._inited) return this;
    if (shouldBeActive) {
      if (this._root) this._root.visible = true;
      this.applyImmediate();
    } else {
      // 只还原「全局渲染状态」：灯色/强度/位置、Bloom、曝光、环境反射强度。
      // 【不要动 background / fog】—— 新设施 init 时刚设好自己的天空与雾，
      // 若这里一起覆盖回基线，会把跑酷的蓝天、海盗船的雾等改掉（真冲突）。
      // Lobby.dispose 与各设施 dispose 都会自行保存/还原 bg/fog，不会串味。
      this._restoreBaseline(false);
      if (this._root) this._root.visible = false;
      this._clearNeonBoost();
    }
    return this;
  }

  /** Lobby 每次 init 都会新建 Sky 球，需重新注册 */
  registerSky(skyMaterial) {
    this._skyMat = skyMaterial || null;
    if (this._skyMat?.uniforms) this._applySkyUniforms();
    return this;
  }

  unregisterSky() {
    this._skyMat = null;
    return this;
  }

  /** Lobby 把自身全部材质集合注册进来，夜间统一提升 emissiveIntensity */
  registerLobbyMaterials(collection) {
    this._clearNeonBoost();
    this._neonMats = [];
    if (!collection) return this;
    for (const mat of collection) {
      // 跳过带 emissiveMap 的云带 / 光柱（白天氛围物，夜间应淡出而非变亮）
      if (!mat?.emissive || mat.emissiveMap) continue;
      if (typeof mat.emissiveIntensity !== 'number') continue;
      if (mat.emissiveIntensity <= 0 && mat.emissive.getHex() === 0) continue;
      this._neonMats.push({ mat, base: mat.emissiveIntensity });
    }
    this._applyNeonBoost();
    return this;
  }

  clearLobbyMaterials() {
    this._clearNeonBoost();
    this._neonMats = [];
    return this;
  }

  /* ----------------------------- 每帧 ----------------------------- */

  update(dt) {
    if (!this._inited || this._disposed || !this._active) return;
    const d = Math.min(Math.max(dt, 0), 0.1);
    this._time += d;

    if (this._auto) {
      this._autoElapsed += d;
      this._computeAutoTarget();
    } else {
      this._target = PRESETS[this._mode];
    }

    // 指数阻尼接近目标：切换时连续、无帧跳变、无闪烁。
    // λ=3.2 → 约 0.9s 收敛到 95%，兼顾「平滑」与「时间控制台响应迅速」。
    const k = 1 - Math.exp(-3.2 * d);
    for (const key of NUM_KEYS) this._cur[key] = damp(this._cur[key], this._target[key] ?? this._cur[key], 3.2, d);
    for (const key of COLOR_KEYS) this._cur[key].lerp(this._target[key], k);
    for (const key of VEC_KEYS) this._cur[key].lerp(this._target[key], k);

    this._apply();
  }

  /**
   * 预热：临时让太阳/月亮/星空全部可见（opacity=0 不产生任何像素），
   * 让 GPU 在预热那一帧上传【全部】几何体，计入本次会话基线。
   * 否则星空只在黄昏/黑夜首次显示时才惰性上传 → renderer.info.memory
   * 从 21 跳到 22，破坏「来回切换 Δ0/0」验收。随后每帧 _apply 会复原。
   */
  warmUp() {
    if (!this._inited || !this._root) return this;
    for (const g of [this._sun, this._moon]) {
      if (!g) continue;
      g.visible = true;
      g.userData.mat.opacity = 0;
      g.userData.glowMat.opacity = 0;
    }
    if (this._stars) {
      this._stars.visible = true;
      this._stars.material.opacity = 0;
    }
    return this;
  }

  /** 四季系统每帧写入的太阳强度倍率（春 1.02 / 夏 1.20 / 秋 0.98 / 冬 0.82） */
  setSeasonLightScale(scale) {
    const v = Number(scale);
    if (Number.isFinite(v)) this._seasonSunScale = Math.min(1.35, Math.max(0.65, v));
    return this;
  }

  get seasonLightScale() { return this._seasonSunScale; }

  /** 立刻吸附到当前目标（上下文切换时用，避免一帧白天闪回） */
  applyImmediate() {
    if (!this._inited) return this;
    if (this._auto) this._computeAutoTarget();
    else this._target = PRESETS[this._mode];
    this._cur = cloneState(this._target);
    this._apply();
    return this;
  }

  _autoPhaseForMode(mode) {
    const i = DAY_NIGHT_MODES.indexOf(mode);
    return (i / 3) * this._autoPeriod;
  }

  _nearestMode() {
    // 从当前插值状态挑最接近的预设，作为关闭自动后的落点
    let best = 'day', bestD = Infinity;
    for (const m of DAY_NIGHT_MODES) {
      const p = PRESETS[m];
      const d = Math.abs(p.sunOpacity - this._cur.sunOpacity) + Math.abs(p.starOpacity - this._cur.starOpacity);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  /**
   * 自动循环：8 分钟一轮，白天→黄昏→黑夜→白天。
   * 每段前 78% 保持、后 22% 用 smoothstep 融到下一段；段边界天然连续，
   * 因此不会出现硬切。周期落在提示词要求的 5~10 分钟。
   */
  _computeAutoTarget() {
    const phase = (this._autoElapsed % this._autoPeriod) / this._autoPeriod * 3;
    const i = Math.floor(phase) % 3;
    const f = phase - Math.floor(phase);
    const blend = smoothstep(0.78, 1.0, f);
    const a = PRESETS[DAY_NIGHT_MODES[i]];
    const b = PRESETS[DAY_NIGHT_MODES[(i + 1) % 3]];
    this._tmpState = lerpState(a, b, blend, this._tmpState);
    this._target = this._tmpState;
    const label = DAY_NIGHT_MODES[blend > 0.5 ? (i + 1) % 3 : i];
    if (label !== this._mode) { this._mode = label; this._emit(); }
  }

  /* ----------------------------- 应用状态 ----------------------------- */

  _apply() {
    const s = this._cur;
    const scene = this._scene;
    if (!scene) return;

    // ① 背景 / 雾（线性空间预乘 0.38，抵消 exposure=1.0）
    if (scene.background?.isColor) {
      scene.background.copy(s.sky).multiplyScalar(EXPOSURE_COMP);
    }
    if (scene.fog?.color) {
      scene.fog.color.copy(s.fog).multiplyScalar(EXPOSURE_COMP);
    }
    if (scene.environment) scene.environmentIntensity = s.envIntensity;

    // ② 三盏基座常驻灯：颜色 / 强度 / 位置（阴影长度）
    const { ambient, hemisphere, directional } = this._lights;
    if (ambient) {
      ambient.color.copy(s.ambient);
      ambient.intensity = s.ambientIntensity;
    }
    if (hemisphere) {
      hemisphere.color.copy(s.hemiSky);
      if (hemisphere.groundColor) hemisphere.groundColor.copy(s.hemiGround);
      hemisphere.intensity = s.hemiIntensity;
    }
    if (directional) {
      directional.color.copy(s.sunLight);
      directional.intensity = s.sunIntensity * this._seasonSunScale;
      this._setLightDirection(directional.position, s.lightElevation, s.azimuth, 32);
    }

    // ③ Bloom：夜间降低阈值 + 提高强度，让 neon 明显泛光
    if (this._bloom) {
      this._bloom.strength = s.bloomStrength;
      this._bloom.threshold = s.bloomThreshold;
    }
    this._renderer.toneMappingExposure = s.exposure;

    // ④ Sky.js 天空球
    this._applySkyUniforms();

    // ⑤ 太阳 / 月亮 / 星空
    this._applyCelestial();

    // ⑥ 霓虹 emissive
    this._applyNeonBoost();
  }

  _setLightDirection(out, elevation, azimuth, radius) {
    const el = elevation * DEG, az = azimuth * DEG;
    const h = Math.cos(el) * radius;
    out.set(Math.sin(az) * h, Math.sin(el) * radius, Math.cos(az) * h);
    return out;
  }

  _applySkyUniforms() {
    const mat = this._skyMat;
    if (!mat?.uniforms) return;
    const u = mat.uniforms;
    const s = this._cur;
    if (u.uSkyTint) u.uSkyTint.value.set(s.skyTint.x, s.skyTint.y, s.skyTint.z);
    if (u.uSkyBrightness) u.uSkyBrightness.value = s.skyBrightness;
    if (u.rayleigh) u.rayleigh.value = s.rayleigh;
    if (u.turbidity) u.turbidity.value = s.turbidity;
    if (u.mieCoefficient) u.mieCoefficient.value = s.mie;
    if (u.sunPosition) {
      // 太阳低于地平线时 Sky.js 自然变暗；夜里再加一层 tint/brightness 压暗
      const el = s.sunElevation * DEG, az = s.azimuth * DEG;
      u.sunPosition.value.set(
        Math.sin(az) * Math.cos(el),
        Math.sin(el),
        Math.cos(az) * Math.cos(el),
      );
    }
  }

  _applyCelestial() {
    if (!this._root) return;
    const s = this._cur;
    // root 跟随相机水平位移：无论玩家走到广场哪里，天体都在「无限远」
    this._root.position.set(this._camera.position.x, 0, this._camera.position.z);

    // 太阳缓慢划过天空（提示词：白天太阳在天空移动）
    const drift = Math.sin(this._time * 0.012) * 6;
    this._setLightDirection(this._sun.position, s.sunElevation, s.azimuth + drift, 62);
    this._setLightDirection(this._moon.position, 34, s.azimuth + 180 - drift, 62);

    const sm = this._sun.userData, mm = this._moon.userData;
    sm.mat.opacity = s.sunOpacity * 0.98;
    sm.glowMat.opacity = s.sunOpacity * 0.30;
    mm.mat.opacity = s.moonOpacity * 0.92;
    mm.glowMat.opacity = s.moonOpacity * 0.22;
    this._sun.visible = s.sunOpacity > 0.005;
    this._moon.visible = s.moonOpacity > 0.005;
    if (this._stars) {
      // 【风景提质】夜空星星缓慢闪烁：整体 opacity 做小幅正弦调制，
      // 只写一个标量、零 GPU 分配；白天 starOpacity≈0 自然不受影响。
      const twinkle = 0.86 + 0.14 * Math.sin(this._time * 1.7);
      this._stars.material.opacity = s.starOpacity * 0.9 * twinkle;
      this._stars.visible = s.starOpacity > 0.005;
      this._stars.rotation.y = this._time * 0.0035;
    }
  }

  _applyNeonBoost() {
    const boost = this._active ? this._cur.neonBoost : 1;
    for (const { mat, base } of this._neonMats) {
      // 上限 1.5：避免 emissive 过曝成一片白
      mat.emissiveIntensity = Math.min(base * boost, 1.5);
    }
  }

  _clearNeonBoost() {
    for (const { mat, base } of this._neonMats) mat.emissiveIntensity = base;
  }

  /**
   * 还原到基座快照（含 color / groundColor / position，这些是 Lobby.dispose 不会还原的）。
   * @param {boolean} includeBgFog 是否连 background/fog 一起还原。
   *   dispose() 用 true（彻底复原）；setContext(非大厅设施) 用 false —— 新设施
   *   init 刚设好自己的天空与雾，覆盖它们会毁掉跑酷蓝天/海盗船雾（真冲突）。
   */
  _restoreBaseline(includeBgFog = true) {
    const b = this._baseline;
    if (!b) return;
    const scene = this._scene;
    if (includeBgFog) {
      if (scene.background?.isColor && b.background) scene.background.copy(b.background);
      if (scene.fog?.color && b.fogColor) {
        scene.fog.color.copy(b.fogColor);
        scene.fog.near = b.fogNear;
        scene.fog.far = b.fogFar;
      }
    }
    scene.environmentIntensity = b.envIntensity;
    if (this._bloom) {
      this._bloom.strength = b.bloomStrength;
      this._bloom.threshold = b.bloomThreshold;
    }
    this._renderer.toneMappingExposure = b.exposure;
    for (const [key, snap] of Object.entries(b.lights)) {
      const light = this._lights[key];
      if (!light) continue;
      light.color.copy(snap.color);
      if (snap.groundColor && light.groundColor) light.groundColor.copy(snap.groundColor);
      light.intensity = snap.intensity;
      light.position.copy(snap.position);
      light.castShadow = snap.castShadow;
    }
  }

  /* ----------------------------- 销毁 ----------------------------- */

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearNeonBoost();
    this._neonMats = [];
    this._restoreBaseline();
    this._skyMat = null;
    this._listeners.clear();
    if (this._root) {
      this._scene?.remove(this._root);
      this._root.clear();
      this._root = null;
    }
    for (const g of this._geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    this._geometries.length = 0;
    this._materials.length = 0;
    this._sun = this._moon = this._stars = null;
    this._inited = false;
  }
}

/** 全局唯一实例 */
export const dayNightCycle = new DayNightCycleImpl();
export default dayNightCycle;
