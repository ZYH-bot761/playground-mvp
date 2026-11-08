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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** 夜空底色（与雾色同色系，远处平滑融入） */
const SKY_COLOR = 0x0a1226;
const FOG_COLOR = 0x0a1226;

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
    this.scene.background = new THREE.Color(SKY_COLOR);
    // 夜间指数雾：与背景同色系，远端物体平滑隐入天色
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.010);

    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200);
    this.camera.position.set(0, 2.0, 7);
    this.camera.lookAt(0, 0.6, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // 夜景基准曝光：ACES 会把 1.0 线性压到 ~0.8 显示亮度，0.9 让暗部保留细节
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    // RoomEnvironment 是按「室内白天」烘焙的，亮度远高于夜景预期；
    // 直接作为 environment 会把 metalness=1 的材质整片反射成白墙。
    // 压低到 0.3 只保留「金属有反射形状」的信息量，不再贡献主亮度。
    this.scene.environmentIntensity = 0.3;
    roomEnvironment.dispose();
    this._pmremGenerator.dispose();
    this._pmremGenerator = null;

    /* ---------- 灯光：一主光（方向光，投影）+ 辅助（半球光 + 极弱环境光） ----------
     * 夜景合成：主光 0.6（冷白，模拟月光/场地顶灯）+ 半球光 0.5（上冷下暖的反差）
     * + 环境光 0.16（只抬死黑，不参与照明）。三者相加才是画面亮度来源，
     * 任何一项上调都必须先扣掉另一项，否则叠乘后整体过曝。
     */
    this.ambientLight = new THREE.AmbientLight(0xbfd4ff, 0.16);

    this.hemisphereLight = new THREE.HemisphereLight(0x9fc4ff, 0x1b2a1c, 0.5);
    this.hemisphereLight.position.set(0, 12, 0);

    this.directionalLight = new THREE.DirectionalLight(0xdce8ff, 0.6);
    this.directionalLight.position.set(22, 32, 18);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.set(1024, 1024);
    this.directionalLight.shadow.bias = -0.0005;
    this.directionalLight.shadow.normalBias = 0.02;
    const shadowCamera = this.directionalLight.shadow.camera;
    shadowCamera.left = -45;
    shadowCamera.right = 45;
    shadowCamera.top = 45;
    shadowCamera.bottom = -45;
    shadowCamera.near = 1;
    shadowCamera.far = 110;
    shadowCamera.updateProjectionMatrix();

    this.scene.add(this.ambientLight, this.hemisphereLight, this.directionalLight);

    /* ---------- 后期：EffectComposer + Bloom + OutputPass ----------
     * Bloom：threshold 0.6 只让真正的高亮/自发光（霓虹灯管、金币高光）泛光；
     *        radius 0.3 收紧光晕半径避免糊成一片；strength 0.6 做轻微辉光。
     *        原 0.85/0.4/1.2 配合「无色调映射 + 浅色金属 albedo」会让整屏都
     *        过阈 → 整屏泛白。
     * OutputPass 必须放在最后：它负责 ACES 色调映射 + sRGB 编码（见文件头说明）。
     */
    // autoClear=false 已在构造初期设置（PMREMGenerator 内部会自行临时接管并还原，互不影响）
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.6, // strength
      0.3, // radius
      0.6 // threshold
    );
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    this.composer.setSize(width, height);

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.composer?.setSize(width, height);
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
