/**
 * ============================================================================
 * SceneManager —— 场景 / 相机 / 渲染器（单例）
 * ============================================================================
 * 职责：
 *   1) 夜间游乐场基座：深蓝夜空背景 + 同色雾 + 环境反射 + 冷调主光；
 *   2) 持有唯一的 WebGLRenderer（ACES Filmic 色调映射 + PCF 软阴影），
 *      并提供窗口 resize 适配；
 *   3) 驱动全工程唯一的渲染循环（经 EffectComposer + UnrealBloom + OutputPass）：
 *         physics.step(dt) → attractionManager.update(dt) → composer.render()
 *
 * 【色调映射必须在 OutputPass 里做】
 *   three 的材质在「渲染到 RenderTarget」时会强制 NoToneMapping
 *   （WebGLPrograms: currentRenderTarget !== null → toneMapping = NoToneMapping）。
 *   EffectComposer 的 RenderPass / UnrealBloomPass 都写 RenderTarget，且
 *   UnrealBloomPass 的合成 shader 不含 tone mapping / sRGB 转换 —— 若链路末尾
 *   没有 OutputPass，最终画面就是「未色调映射的线性 HDR 直写 8bit 画布」，
 *   高光全部截白、整屏泛白。OutputPass 会读取 renderer.toneMapping 与
 *   outputColorSpace，在最后一步完成 ACES + sRGB。
 *   OutputPass 复用 Pass.js 的模块级共享全屏三角形几何，不新增几何/纹理。
 *
 * 【环境光照：零外部依赖】
 *   不加载任何 HDR 文件（避免 CORS / 404 黑屏），改用 PMREMGenerator 对
 *   three 内置的 RoomEnvironment 做一次离屏烘焙，得到可复用的 PMREM 纹理。
 *   scene.environment 只负责材质反射；背景仍是独立的纯色 Color，不把
 *   RoomEnvironment 赋给 background（否则会被当成天空盒显示）。
 *
 * 【Bloom 资源生命周期】
 *   EffectComposer / RenderPass / UnrealBloomPass / OutputPass 内部各持有
 *   RenderTarget、材质与全屏四边形。它们不归任何 Attraction 所有，因此必须在
 *   dispose() 里按「passes → renderTarget1/2 → composer」的顺序彻底释放。
 * ============================================================================
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { detectQualityTier, QUALITY_PRESETS } from '../utils/helpers/quality-tier.js';
import { PerfMonitor } from '../utils/helpers/perf-monitor.js';

/** 白天大气透视：线性雾（45m 内完全无雾，130m 处已基本融入雾色）。
 *  衰减终点收在 130 而非 190：地面平面半径 110m，far=190 时远端只混合 45%，
 *  绿地面与亮天空之间仍留一条硬边界（截图实测为浅色横带）。 */
const SKY_COLOR = 0x8fc3e8;
const FOG_COLOR = 0xa8b0b4;
/** 手册 P5 要求 exposure=1.0；旧方案 0.38 的成像亮度由「光强/自发光/无lit 颜色
 *  统一 ×0.38」承担（线性空间预缩放，ACES 输入不变 → 画面等价）。 */
const EXPOSURE_COMP = 0.38;

export class SceneManager {
  static _instance = null;

  static getInstance() {
    if (!SceneManager._instance) SceneManager._instance = new SceneManager();
    return SceneManager._instance;
  }

  constructor() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.scene = new THREE.Scene();
    // 背景/雾色在线性空间预乘 0.38：OutputPass 的 exposure=1.0 会把它抬回原亮度
    this.scene.background = new THREE.Color(SKY_COLOR).multiplyScalar(EXPOSURE_COMP);
    // 白天大气透视：薄雾，远处草坪与天空平滑衔接
    this.scene.fog = new THREE.Fog(new THREE.Color(FOG_COLOR).multiplyScalar(EXPOSURE_COMP), 45, 130);

    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);
    this.camera.position.set(0, 2.0, 7);
    this.camera.lookAt(0, 0.6, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // 手册 P5：exposure = 1.0。原 0.38 方案的亮度改由「光强/自发光 ×0.38」
    // 承担（见下方灯光与 attractions 内 emissiveIntensity），成像亮度等价。
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    // 手册 P6 画质档位：移动端关 Bloom / 降阴影分辨率 / 降折射分辨率（见 QualityTier）。
    // transmission 折射 pass 会整场景重渲：实测全分辨率把大厅从 82fps 打到 21fps，
    // high 档取 0.5（1/4 像素）回升 70fps；水面小面积折射肉眼无差。
    this.qualityTier = detectQualityTier();
    this._qualityPreset = QUALITY_PRESETS[this.qualityTier];
    this.renderer.transmissionResolutionScale = this._qualityPreset.transmissionScale;
    // three r187 已移除 PCFSoftShadowMap：WebGLShadowMap 每次遇到该值都会
    // 打警告并回退到 PCFShadowMap（见 three/src/renderers/webgl/WebGLShadowMap.js:99）。
    // 直接使用 PCFShadowMap，行为一致且不再刷屏告警。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 后期合成的每个 pass 自己负责清屏，渲染器不再自动 clear
    this.renderer.autoClear = false;
    this.renderer.domElement.setAttribute('aria-label', '3D 游乐场画布');

    const container = document.getElementById('app') || document.body;
    container.appendChild(this.renderer.domElement);

    /* ---------- 环境反射：PMREM + RoomEnvironment，全程无外部文件 ---------- */
    this._pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const roomEnvironment = new RoomEnvironment();
    this.environmentTarget = this._pmremGenerator.fromScene(roomEnvironment, 0.04);
    this.scene.environment = this.environmentTarget.texture;
    // 白天环境反射：RoomEnvironment 本身就是室内白天光照；×0.38 抵消 exposure=1.0
    this.scene.environmentIntensity = 1.1 * EXPOSURE_COMP;
    roomEnvironment.dispose();
    this._pmremGenerator.dispose();
    this._pmremGenerator = null;

    /* ---------- 灯光：日光主光（方向光，投影）+ 天空半球光 + 微弱环境光 ----------
     * 手册 P5：exposure=1.0、HemisphereLight 0.3~0.5。旧方案（exposure 0.38，
     * 主光 1.8 / 半球 0.5 / 环境 0.18）的等效光强 ×0.38 后半球只有 0.19，
     * 低于手册下限 → 半球取 0.3，主光相应从 0.684 扣到 0.58 补回亮度差。
     */
    this.ambientLight = new THREE.AmbientLight(0xffe9d0, 0.07);

    // groundColor 改深：原草绿 0x6b8f45 会从下方把树冠反照成薄荷色；
    // 换成深绿棕后只保留极弱地面反光，配合 Lobby 压低 instanceColor 明度得到浓绿。
    this.hemisphereLight = new THREE.HemisphereLight(0xbfe3ff, 0x24331c, 0.3);
    this.hemisphereLight.position.set(0, 12, 0);

    this.directionalLight = new THREE.DirectionalLight(0xfff4e0, 0.58);
    this.directionalLight.position.set(22, 32, 18);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.set(2048, 2048);
    // 手册 P5 阴影参数：near 0.5 / far 100 / 视锥 ±30 / bias -0.001
    this.directionalLight.shadow.bias = -0.001;
    this.directionalLight.shadow.normalBias = 0.02;
    const shadowCamera = this.directionalLight.shadow.camera;
    shadowCamera.left = -30;
    shadowCamera.right = 30;
    shadowCamera.top = 30;
    shadowCamera.bottom = -30;
    shadowCamera.near = 0.5;
    shadowCamera.far = 100;
    shadowCamera.updateProjectionMatrix();

    this.scene.add(this.ambientLight, this.hemisphereLight, this.directionalLight);

    /* ---------- 后期：EffectComposer + Bloom + OutputPass + ColorGrade ----------
     * Bloom：白天阈值必须抬高（0.88），只让太阳高光/金属反光泛光；
     *        否则白云和浅色建筑会整片糊成雾。strength 0.25 / radius 0.4。
     * OutputPass 负责 ACES 色调映射 + sRGB 编码，必须在其之前。
     * ColorGradePass 放在 OutputPass 之后，在显示空间做饱和/对比微调。
     */
    // autoClear=false 已在构造初期设置（PMREMGenerator 内部会自行临时接管并还原，互不影响）
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.06, // strength（白天天空很亮，过强会整屏泛白雾）
      0.35, // radius
      1.4 // threshold（草地是大面积中亮度，阈值再抬一档，不让它进 Bloom）
    );
    this.outputPass = new OutputPass();
    /* 【六项升级·阶段五】补齐后处理链：EffectComposer 已有 RenderPass +
     * UnrealBloomPass(轻微光晕 0.06) + OutputPass，这里新增 FXAAPass 抗锯齿。
     * 顺序与 three 官方 webgl_postprocessing_fxaa 一致（FXAA 在 OutputPass 之前），
     * ShaderPass 复用 Pass 的模块级共享全屏三角形，不新增 geometry / texture。 */
    this.fxaaPass = new ShaderPass(FXAAShader);
    const pr = this.renderer.getPixelRatio();
    this.fxaaPass.material.uniforms.resolution.value.set(1 / (width * pr), 1 / (height * pr));
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.fxaaPass);
    this.composer.addPass(this.outputPass);
    this.composer.setSize(width, height);

    // 档位落地：像素比上限 / Bloom 开关 / 阴影分辨率（手册 P6 移动端简化效果）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._qualityPreset.pixelRatioCap));
    this.bloomPass.enabled = this._qualityPreset.bloom;
    this.directionalLight.shadow.mapSize.set(this._qualityPreset.shadowMapSize, this._qualityPreset.shadowMapSize);
    console.info(`[SceneManager] 画质档位=${this.qualityTier} | bloom=${this.bloomPass.enabled} | shadow=${this._qualityPreset.shadowMapSize} | pixelRatioCap=${this._qualityPreset.pixelRatioCap}`);

    this._deps = { physics: null, attractions: null };

    // THREE.Clock 自 r183 起已废弃，官方推荐 THREE.Timer（从 core 导出）。
    // Timer 需每帧 update(timestamp) 后再读 getDelta()；connect(document)
    // 启用 Page Visibility API，避免切后台回来出现巨大的 deltaTime。
    this._timer = new THREE.Timer();
    this._timer.connect(document);
    this._running = false;
    this._rafId = 0;
    /** 通用暂停闸门：true 时渲染循环跳过 physics.step 与 attractions.update */
    this._paused = false;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._perf = PerfMonitor.maybeCreate(this.renderer);
  }

  /**
   * 通用暂停闸门（由 PauseMenu 调用）。
   * true 时物理推进与项目 update 全部跳过，画面仍在渲染（定格帧），
   * 因此倒计时、角色移动、update 内的计时累加与冷却都不会推进。
   * @param {boolean} paused
   */
  setPaused(paused = true) {
    this._paused = Boolean(paused);
    return this;
  }

  get paused() { return this._paused; }

  /**
   * 注入渲染循环依赖。用注入而非直接 import，避免 core 与 attractions 循环依赖。
   * @param {{physics: Object, attractions: Object}} deps
   */
  configure({ physics, attractions }) {
    this._deps.physics = physics ?? null;
    this._deps.attractions = attractions ?? null;
    return this;
  }

  /** 窗口尺寸变化时同步相机宽高比与渲染尺寸（含移动端基础适配） */
  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._qualityPreset.pixelRatioCap));
    this.renderer.setSize(width, height);
    this.composer?.setSize(width, height);
    // FXAA 需要按实际像素尺寸更新 resolution，否则高 DPI 下抗锯齿强度漂移
    if (this.fxaaPass) {
      const pr = this.renderer.getPixelRatio();
      this.fxaaPass.material.uniforms.resolution.value.set(1 / (width * pr), 1 / (height * pr));
    }
  }

  /**
   * 只渲染一帧、不推进物理、不驱动项目 update。
   * 用途：GPU 资源在首次渲染时才真正上传，renderer.info.memory 只统计
   *      「已上传」的对象，因此验收前后都需要显式渲染一帧再读计数。
   * 【注意】走 composer 而不是 renderer.render()，否则后期链上的资源
   *       （Bloom 的降采样 RenderTarget / 全屏材质）不会被上传，基线失真。
   */
  renderOnce() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** 启动统一渲染循环 */
  start() {
    if (this._running) return;
    this._running = true;
    this._timer.reset();

    // requestAnimationFrame 回调的 timestamp 与 performance.now() 同一时间原点，
    // 直接交给 Timer.update()，比 Timer 内部再取一次 performance.now() 更准确。
    const loop = (timestamp) => {
      if (!this._running) return;
      this._rafId = requestAnimationFrame(loop);

      this._timer.update(timestamp);
      const deltaTime = Math.min(this._timer.getDelta(), 0.1);
      const { physics, attractions } = this._deps;

      // ⓪ 暂停闸门：冻结物理与逻辑（渲染继续，画面定格在菜单后面）
      if (!this._paused) {
        // ① 物理：全局唯一推进点（项目内禁止自行调用 world.step()）
        if (physics) physics.step(deltaTime);
        // ② 逻辑：统一驱动当前激活项目
        if (attractions) attractions.update(deltaTime);
      }
      // ③ 渲染：EffectComposer（RenderPass + UnrealBloomPass + OutputPass），替代 renderer.render()
      if (this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
      this._perf?.sample(timestamp);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._rafId);
  }

  /** 整体关闭：解绑监听、停止循环、释放后期链 / 环境贴图 / Timer / 渲染器 */
  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this._perf?.dispose();
    this._perf = null;

    // ① 后期：先释放各 pass 自有的 RenderTarget / 材质，再释放组合器缓冲
    try {
      this.composer?.passes.forEach((pass) => {
        try { pass.dispose?.(); } catch (err) { console.error('[SceneManager] pass.dispose() 失败：', err); }
      });
      this.composer?.renderTarget1?.dispose();
      this.composer?.renderTarget2?.dispose();
      this.composer?.dispose();
    } catch (err) {
      console.error('[SceneManager] 后期资源释放失败：', err);
    }
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
    this.outputPass = null;

    // ② 环境光照：PMREM 输出的 RenderTarget 是渲染器常驻资源，必须显式释放
    try {
      this.scene.environment = null;
      this.environmentTarget?.dispose();
      this.environmentTarget = null;
    } catch (err) {
      console.error('[SceneManager] 环境贴图释放失败：', err);
    }

    // ③ 阴影贴图（方向光惰性创建的 RenderTarget）
    try {
      this.directionalLight?.shadow?.dispose();
    } catch (err) {
      console.error('[SceneManager] 阴影贴图释放失败：', err);
    }

    // ④ Timer 与渲染器。禁止 forceContextLoss()：会丢上下文且无法恢复
    this._timer.dispose(); // 内部会 disconnect()，移除 visibilitychange 监听
    this.renderer.dispose();
  }
}

export const sceneManager = SceneManager.getInstance();
export default sceneManager;
