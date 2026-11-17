/**
 * ============================================================================
 * SeasonCycle —— 四季天气系统（单例 / 零新增几何 / 复用粒子对象池）
 * ============================================================================
 * 职责：
 *  1. 春 / 夏 / 秋 / 冬 四套地表与树冠配色，全部通过材质 uniform + CPU lerp
 *     平滑过渡，不替换 geometry / texture / material。
 *  2. 花瓣、落叶、雪、雨滴全部调用现有 FireworkSystem 的固定容量对象池
 *     （emitWeather），热路径绝不 new 粒子 / 不新建 GPU 资源。
 *  3. 夏季阵雨给地面材质增加程序化扩散雨圈；冬季把地表与树冠渐变为雪色。
 *  4. 切换场景时只停天气与注销材质引用，不保留已释放 Lobby 材质的悬挂指针。
 *
 * 性能口径：
 *  - 不创建 Mesh / BufferGeometry / Texture；只给既有 MeshStandardMaterial 注入
 *    一段片元着色器，材质数量与 draw call 不变。
 *  - 每帧只做 5 个角色颜色 lerp、若干 uniform 写入和固定频率的池发射。
 *  - 季节切换完成后继续写入同一组 uniform，不分配对象。
 * ============================================================================
 */
import * as THREE from 'three';
import { fireworkSystem } from './particle-system.js';
import { dayNightCycle } from './day-night-cycle.js';

export const SEASONS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const SEASON_LABELS = Object.freeze({
  spring: '春', summer: '夏', autumn: '秋', winter: '冬',
});
export const SEASON_FULL_LABELS = Object.freeze({
  spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季',
});

/** 角色：地表 / 阔叶冠 / 针叶冠 / 灌木 / 草丛 */
export const SEASON_ROLES = Object.freeze(['ground', 'broad', 'conifer', 'shrub', 'grass']);

const PRESETS = Object.freeze({
  spring: {
    label: '春季', weather: 'petal',
    ground: 0x7fbf62, broad: 0x9bd66a, conifer: 0x3f8047, shrub: 0x86c75c, grass: 0x8acb60,
    snow: 0, rain: 0, sunScale: 1.02,
  },
  summer: {
    label: '夏季', weather: 'rain',
    ground: 0x2f6f35, broad: 0x245f2c, conifer: 0x174d2d, shrub: 0x2f722f, grass: 0x397a32,
    snow: 0, rain: 1, sunScale: 1.20,
  },
  autumn: {
    label: '秋季', weather: 'leaf',
    ground: 0xb2a34b, broad: 0xd65b24, conifer: 0x3c6937, shrub: 0xcd7d2d, grass: 0xb39b4a,
    snow: 0, rain: 0, sunScale: 0.98,
  },
  winter: {
    label: '冬季', weather: 'snow',
    ground: 0xe4edf2, broad: 0xd9e4ea, conifer: 0xc8dae2, shrub: 0xdbe7ec, grass: 0xe4edf2,
    snow: 1, rain: 0, sunScale: 0.82,
  },
});

const WEATHER_INTERVAL = Object.freeze({
  petal: 0.26, leaf: 0.24, snow: 0.18, rain: 0.13,
});
const WEATHER_COUNT = Object.freeze({
  petal: 16, leaf: 16, snow: 24, rain: 36,
});
const WEATHER_CAP = 760;
const TRANSITION_LAMBDA = 3.8;

function hexColor(hex) { return new THREE.Color(hex); }

/** 每个材质角色共享一套 uniform，四个材质角色共 4 组，避免逐材质重复写。 */
function makeUniforms() {
  return {
    uSeasonColor: { value: new THREE.Color(0xffffff) },
    uSeasonMix: { value: 0.58 },
    uSnow: { value: 0 },
    uRain: { value: 0 },
    uRainTime: { value: 0 },
  };
}

class SeasonCycleImpl {
  constructor() {
    this._inited = false;
    this._disposed = false;
    this._active = false;
    this._contextKey = 'lobby';
    this._camera = null;
    this._time = 0;

    this._season = 'spring';
    this._previous = 'spring';
    this._weather = 'petal';
    this._weatherEnabled = true;
    this._emitTimer = 0.1;
    this._lastWeatherCount = 0;

    /** @type {Object<string, THREE.Color>} */
    this._current = {};
    this._target = {};
    for (const role of SEASON_ROLES) {
      this._current[role] = hexColor(PRESETS.spring[role]);
      this._target[role] = hexColor(PRESETS.spring[role]);
    }
    this._uniforms = {};
    for (const role of SEASON_ROLES) this._uniforms[role] = makeUniforms();
    this._uniforms.ground.uSeasonMix.value = 0.84;
    this._uniforms.broad.uSeasonMix.value = 0.62;
    this._uniforms.conifer.uSeasonMix.value = 0.44;
    this._uniforms.shrub.uSeasonMix.value = 0.62;
    this._uniforms.grass.uSeasonMix.value = 0.60;

    this._sunScale = PRESETS.spring.sunScale;
    this._sunTarget = PRESETS.spring.sunScale;
    this._snow = 0;
    this._snowTarget = 0;
    this._rain = 0;
    this._rainTarget = 0;
    this._showerLeft = 0;
    this._showerCooldown = 6;
    this._forceShower = false;

    /** 已注入的季节材质（不持有几何/纹理；clearTargets 只断引用） */
    this._targets = [];
    this._registered = new Set();

    this._tmpColor = new THREE.Color();
  }

  /* ----------------------------- 生命周期 ----------------------------- */

  init({ camera = null } = {}) {
    if (this._inited || this._disposed) return this;
    this._camera = camera;
    this._inited = true;
    this.applyImmediate();
    console.info('[SeasonCycle] 初始化完成 | 季节=春 | 材质注入=零新增几何 | 粒子池复用=FireworkSystem');
    return this;
  }

  setCamera(camera) {
    this._camera = camera || this._camera;
    return this;
  }

  get season() { return this._season; }
  get label() { return SEASON_LABELS[this._season]; }
  get weatherKind() { return this._weather; }
  get active() { return this._active; }
  get snowAmount() { return this._snow; }
  get rainAmount() { return this._rain; }
  get showerActive() { return this._showerLeft > 0; }
  get isAuto() { return false; }
  get sunScale() { return this._sunScale; }
  get weatherParticles() { return this._lastWeatherCount; }

  /** 切场景：只有大厅（含同一场景内的城市/森林）启用天气。 */
  setContext(key) {
    this._contextKey = key;
    const on = key === 'lobby';
    this._active = on;
    if (!on) {
      this._showerLeft = 0;
      this._rainTarget = 0;
      fireworkSystem.clearWeather();
    }
    return this;
  }

  /** 注册一块既有材质。role 决定季节配色语义。 */
  registerMaterial(material, role = 'surface') {
    if (!this._inited || !material || !material.isMeshStandardMaterial) return false;
    const resolved = SEASON_ROLES.includes(role) ? role : (role === 'surface' ? 'ground' : 'broad');
    if (this._registered.has(material)) return true;
    this._registered.add(material);
    const uniforms = this._uniforms[resolved];
    this._patchStandardMaterial(material, resolved, uniforms);
    this._targets.push({ material, role: resolved, uniforms });
    this._applyRole(resolved);
    return true;
  }

  /**
   * 从一个根节点按名称收集树冠/灌木材质（供动物园等未显式暴露材质的模块用）。
   * 仅收集 MeshStandardMaterial，不注册地表，避免误染道路。
   */
  registerCanopiesFrom(root) {
    if (!root || typeof root.traverse !== 'function') return 0;
    const matcher = /(tree-crown|tree-canopy|conifer|shrub|safari.*crown)/i;
    let n = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.material || !matcher.test(o.name || '')) return;
      if (this.registerMaterial(o.material, /conifer/i.test(o.name) ? 'conifer' : 'broad')) n += 1;
    });
    return n;
  }

  /** Lobby rebuild / dispose：只断开材质引用，材质本身由 Lobby 台账释放。 */
  clearTargets() {
    this._targets.length = 0;
    this._registered.clear();
    this._active = false;
    this._showerLeft = 0;
    this._rain = 0;
    this._rainTarget = 0;
    fireworkSystem.clearWeather();
    return this;
  }

  /* ----------------------------- 材质注入 ----------------------------- */

  _patchStandardMaterial(material, role, uniforms) {
    const snowStrength = role === 'ground' || role === 'grass' ? 0.96
      : role === 'conifer' ? 0.82 : 0.88;
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (typeof previous === 'function') previous.call(material, shader, renderer);
      shader.uniforms.uSeasonColor = uniforms.uSeasonColor;
      shader.uniforms.uSeasonMix = uniforms.uSeasonMix;
      shader.uniforms.uSnow = uniforms.uSnow;
      shader.uniforms.uRain = uniforms.uRain;
      shader.uniforms.uRainTime = uniforms.uRainTime;
      shader.fragmentShader = `
        uniform vec3 uSeasonColor;
        uniform float uSeasonMix;
        uniform float uSnow;
        uniform float uRain;
        uniform float uRainTime;
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float pgSeasonLum = clamp(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
        vec3 pgSeasonTint = uSeasonColor * (0.72 + pgSeasonLum * 0.72);
        diffuseColor.rgb = mix(diffuseColor.rgb, pgSeasonTint, uSeasonMix);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.96, 1.0), uSnow * ${snowStrength.toFixed(2)});
        #ifdef USE_MAP
        if (uRain > 0.001) {
          vec2 pgRc = vMapUv * 19.0;
          vec2 pgCell = floor(pgRc);
          vec2 pgF = fract(pgRc) - 0.5;
          float pgH = fract(sin(dot(pgCell, vec2(12.9898, 78.233))) * 43758.5453);
          float pgPhase = fract(uRainTime * 0.55 + pgH);
          float pgRing = abs(length(pgF) - pgPhase * 0.46);
          float pgRipple = smoothstep(0.045, 0.0, pgRing) * (1.0 - pgPhase);
          diffuseColor.rgb += pgRipple * uRain * vec3(0.22, 0.32, 0.38);
        }
        #endif
        `,
      );
    };
    material.customProgramCacheKey = () => `pg-season-${role}-v1`;
    material.userData.seasonRole = role;
    material.userData.seasonPatched = true;
    material.needsUpdate = true;
  }

  /* ----------------------------- 季节切换 ----------------------------- */

  setSeason(key) {
    const next = SEASONS.includes(key) ? key : 'spring';
    if (next === this._season) {
      this.applyImmediate();
      return this;
    }
    this._previous = this._season;
    this._season = next;
    const p = PRESETS[next];
    this._weather = p.weather;
    this._snowTarget = p.snow;
    this._sunTarget = p.sunScale;
    this._rainTarget = 0;
    this._showerLeft = 0;
    this._forceShower = false;
    this._showerCooldown = next === 'summer' ? 4 : 7;
    this._emitTimer = 0.05;
    for (const role of SEASON_ROLES) this._target[role].setHex(p[role]);
    if (this._active && next === 'summer') this._showerCooldown = Math.min(this._showerCooldown, 3.5);
    return this;
  }

  /** 测试 / 演示用：立即开启或结束一场阵雨。 */
  forceShower(on = true) {
    if (on) {
      this._showerLeft = 8;
      this._showerCooldown = 999;
      this._forceShower = true;
      if (this._season !== 'summer') this.setSeason('summer');
    } else {
      this._showerLeft = 0;
      this._forceShower = false;
      this._showerCooldown = 5;
    }
    return this;
  }

  applyImmediate() {
    if (!this._inited) return this;
    const p = PRESETS[this._season];
    this._weather = p.weather;
    this._snow = p.snow;
    this._snowTarget = p.snow;
    this._sunScale = p.sunScale;
    this._sunTarget = p.sunScale;
    this._rain = 0;
    this._rainTarget = 0;
    for (const role of SEASON_ROLES) {
      this._current[role].setHex(p[role]);
      this._target[role].setHex(p[role]);
    }
    for (const role of SEASON_ROLES) this._applyRole(role);
    dayNightCycle.setSeasonLightScale(this._sunScale);
    return this;
  }

  _applyRole(role) {
    const u = this._uniforms[role];
    if (!u) return;
    u.uSeasonColor.value.copy(this._current[role]);
    u.uSnow.value = this._snow;
    u.uRain.value = role === 'ground' || role === 'grass' ? this._rain : 0;
    u.uRainTime.value = this._time;
  }

  /* ----------------------------- 每帧 ----------------------------- */

  update(dt) {
    if (!this._inited || this._disposed) return;
    const step = Math.min(Math.max(Number(dt) || 0, 0), 0.1);
    this._time += step;
    this._lastWeatherCount = fireworkSystem.weatherCount;

    if (!this._active) {
      this._sunScale += (this._sunTarget - this._sunScale) * (1 - Math.exp(-TRANSITION_LAMBDA * step));
      dayNightCycle.setSeasonLightScale(this._sunScale);
      return;
    }

    const k = 1 - Math.exp(-TRANSITION_LAMBDA * step);
    for (const role of SEASON_ROLES) this._current[role].lerp(this._target[role], k);
    this._snow += (this._snowTarget - this._snow) * k;
    this._sunScale += (this._sunTarget - this._sunScale) * k;
    for (const role of SEASON_ROLES) this._applyRole(role);
    dayNightCycle.setSeasonLightScale(this._sunScale);

    // 夏季阵雨（每 18~28s 一次，持续 5~8s）；其余季节常驻对应粒子。
    if (this._season === 'summer') {
      if (this._showerLeft > 0) {
        this._showerLeft = Math.max(0, this._showerLeft - step);
      } else {
        this._showerCooldown -= step;
        if (this._showerCooldown <= 0) {
          this._showerLeft = 5 + Math.random() * 3;
          this._showerCooldown = 18 + Math.random() * 10;
        }
      }
      this._rainTarget = this._showerLeft > 0 ? 0.95 : 0;
    } else {
      this._showerLeft = 0;
      this._rainTarget = 0;
    }
    this._rain += (this._rainTarget - this._rain) * (1 - Math.exp(-4.0 * step));
    this._uniforms.ground.uRain.value = this._rain;
    this._uniforms.grass.uRain.value = this._rain;
    this._uniforms.ground.uRainTime.value = this._time;
    this._uniforms.grass.uRainTime.value = this._time;

    if (!this._weatherEnabled) return;
    const kind = this._season === 'summer'
      ? (this._showerLeft > 0 ? 'rain' : null)
      : this._weather;
    if (!kind) return;
    this._emitTimer -= step;
    if (this._emitTimer > 0) return;
    this._emitTimer = WEATHER_INTERVAL[kind];
    const room = WEATHER_CAP - fireworkSystem.weatherCount;
    if (room <= 0) return;
    const cam = this._camera;
    fireworkSystem.emitWeather(kind, cam?.position ?? null, Math.min(WEATHER_COUNT[kind], room));
  }

  dispose() {
    if (this._disposed) return;
    this.clearTargets();
    this._disposed = true;
    this._inited = false;
    this._camera = null;
  }
}

export const seasonCycle = new SeasonCycleImpl();
export default seasonCycle;
