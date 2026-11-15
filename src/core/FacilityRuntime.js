/**
 * ============================================================================
 * FacilityRuntime —— 嵌入视图协调器（v4 方案 A 的运行时核心，单例）
 * ============================================================================
 * 【职责】
 * 让「进入设施」从「卸载大厅 + 新建独立场景」变成「同一场景里换相机机位」：
 *   - 持有 Map<key, IEmbeddedView> 注册表 + activeView / activeKey；
 *   - 懒创建视图 → init(ctx) → CameraRig.save('lobby') → setOwner(key)
 *     → blendTo(anchor)（同一坐标系，0.8s smoothstep）；
 *   - deactivate() → CameraRig.restore('lobby') + releaseOwner → view.deactivate()，
 *     **绝不 dispose Lobby、绝不调 AttractionManager.activate/deactivate**；
 *   - update(dt) 由 main.js 的 frameDriver 每帧驱动：activeView.update + CameraRig.update。
 *
 * 【与 Lobby OrbitControls 的仲裁（关键）】
 * Lobby.update() 每帧调 `this._controls.update()`。T02 之后其 orbit 分支还会先
 * `enabled = true` 再 update，而 OrbitControls.update() 内部不检查 enabled ——
 * 只置 enabled=false 挡不住它逐帧按 target+球坐标重写相机（第二写者 → 座舱
 * 位置被拉回轨道球、真实 roll 抖动）。因此 activate() 时把 Lobby._controls.update
 * **临时替换为空操作**（并清掉累积的球面/平移增量），让 activeView.update 成为
 * 嵌入期间唯一相机写者；deactivate() 后**等 CameraRig 回位过渡结束**
 * （isTransitioning === false）才把原 update 与 enabled 原样还原。
 * 这里用 `attractionManager.active?._controls` 访问（Lobby.js 属他人文件，不改它）。
 *
 * 【资源纪律】
 * 运行时本身零 GPU 资源；视图独占资源由 IEmbeddedView.track/dispose 负责。
 * 已激活过的视图保留实例（dispose 只在整体销毁时调用），重复进出不重新上传 → Δ0/0。
 *
 * 【接口】
 *   configure({camera, scene, renderer, sceneContext, lobbyKey})
 *   register(key, factory) / has(key) / get keys()
 *   activate(key) → IEmbeddedView（幂等：同 key 重复调用直接返回）
 *   deactivate() → boolean
 *   update(dt)
 *   get activeView / activeKey / isEmbeddedActive / isTransitioning
 *   dispose()
 * ============================================================================
 */

import cameraRig from './CameraRig.js';
import sceneContext from './SceneContext.js';
import attractionManager from '../attractions/AttractionManager.js';

/** 大厅的 AttractionManager key（嵌入态下它必须保持激活，不被卸载） */
const LOBBY_KEY = 'lobby';
/** 相机过渡时长（秒），与架构文档约定一致 */
const DEFAULT_BLEND_SECONDS = 0.8;

export class FacilityRuntime {
  static _instance = null;

  static getInstance() {
    if (!FacilityRuntime._instance) FacilityRuntime._instance = new FacilityRuntime();
    return FacilityRuntime._instance;
  }

  constructor() {
    /** @type {Map<string, Function>} key → () => IEmbeddedView */
    this._factories = new Map();
    /** @type {Map<string, Object>} key → 已创建的视图实例（复用，避免重复上传） */
    this._views = new Map();
    /** @type {Object|null} 当前激活视图 */
    this.activeView = null;
    /** @type {string|null} 当前激活 key */
    this.activeKey = null;

    this._configured = false;
    this._ctx = null;
    this._lobbyKey = LOBBY_KEY;

    /** 被临时挂起的 Lobby OrbitControls（用于回位后精确恢复） */
    this._suspendedControls = null;
    /** 挂起前 OrbitControls.update 的原函数引用（嵌入期间替换为空操作） */
    this._controlsUpdateOriginal = null;
    /** 回位过渡结束后是否需要恢复 Lobby OrbitControls */
    this._pendingControlsRestore = false;
  }

  get isEmbeddedActive() { return this.activeView !== null; }
  get keys() { return [...this._factories.keys()]; }
  get isTransitioning() { return cameraRig.isTransitioning === true; }
  get isConfigured() { return this._configured; }

  /**
   * 注入共享三件套并配置 CameraRig（幂等）。
   * @param {{camera: THREE.Camera, scene?: THREE.Scene, renderer?: THREE.WebGLRenderer,
   *          sceneContext?: Object, lobbyKey?: string}} refs
   * @returns {this}
   */
  configure({ camera, scene, renderer, sceneContext: ctxRef, lobbyKey } = {}) {
    const cam = camera ?? ctxRef?.camera ?? sceneContext.camera;
    if (!cam) {
      throw new Error('[FacilityRuntime] configure 需要 camera（或已 configure 的 sceneContext）');
    }
    cameraRig.configure({ camera: cam });

    this._ctx = {
      scene: scene ?? sceneContext.scene,
      camera: cam,
      renderer: renderer ?? sceneContext.renderer,
      sceneContext: ctxRef ?? sceneContext,
      worldRoot: sceneContext.worldRoot,
      propsRoot: sceneContext.propsRoot,
      runtime: this,
    };
    this._lobbyKey = lobbyKey || LOBBY_KEY;
    // CameraRig 要求「当前有 owner」才接受任何写操作；大厅默认持有相机写权限
    cameraRig.setOwner(this._lobbyKey);
    this._configured = true;
    return this;
  }

  /**
   * 登记嵌入视图工厂。工厂每次 new 一个独立视图实例（运行时只调一次并缓存）。
   * @param {string} key
   * @param {Function} factory () => IEmbeddedView
   * @returns {this}
   */
  register(key, factory) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('[FacilityRuntime] register: key 必须是非空字符串');
    }
    if (typeof factory !== 'function') {
      throw new Error(`[FacilityRuntime] register("${key}"): factory 必须是函数`);
    }
    this._factories.set(key, factory);
    return this;
  }

  /** @param {string} key @returns {boolean} */
  has(key) { return this._factories.has(key); }

  /**
   * 激活嵌入视图：懒创建 → init → 挂起 Lobby 控制 → 相机 blend 到锚点。
   * 同 key 重复调用是 no-op（幂等）；切换不同 key 会先 deactivate 当前视图。
   * @param {string} key
   * @returns {Object} IEmbeddedView 实例
   */
  activate(key) {
    if (!this._configured) {
      throw new Error('[FacilityRuntime] activate: 必须先 configure()');
    }
    const factory = this._factories.get(key);
    if (!factory) {
      throw new Error(`[FacilityRuntime] 未注册的嵌入设施：${key}`);
    }
    if (this.activeKey === key && this.activeView) return this.activeView;
    // 是否从「大厅态」进入。嵌入设施之间直接互切时相机停在 A 的锚点，
    // 绝不能把这个锚点误存成 lobby 槽位，否则退出时会回不到真正的大厅机位。
    const fromLobby = !this.activeView;
    if (this.activeView) this.deactivate({ skipRestore: true });

    let view = this._views.get(key);
    if (!view) {
      view = factory();
      this._assertContract(view, key);
      view.init(this._ctx);
      this._views.set(key, view);
    }

    // ① 挂起 Lobby 的 OrbitControls，避免它逐帧把相机拉回轨道机位
    this._suspendLobbyControls();

    // ② 相机仲裁握手（顺序关键！CameraRig 无 owner 时拒绝一切写操作）：
    //    先取得写权限 → 再保存大厅机位 → 最后 blend 到设施锚点。
    //    lobby 槽位只在两种情况下刷新：
    //      a) 从大厅态进入（fromLobby）：玩家可能重新 orbit 过，存当前真实机位；
    //      b) 槽位不存在（首次 / 极端时序兜底）。
    //    嵌入互切（fromLobby=false）时相机停在上一个设施锚点，若在这里 save
    //    会把该锚点当成大厅机位，退出 restore 就再也回不到大厅 → 必须跳过。
    //    另外若上一次 restore 的回位过渡还没结束，相机是「中间插值姿态」，
    //    同样不能覆盖已存的大厅机位，已存槽位此时才是权威。
    cameraRig.setOwner(key);
    const hasLobbySlot = cameraRig.getPose(this._lobbyKey) !== null;
    if (!hasLobbySlot || (fromLobby && !cameraRig.isTransitioning)) {
      cameraRig.save(this._lobbyKey, key);
    }
    const anchor = view.getCameraAnchor();
    if (!anchor?.position || !anchor?.quaternion) {
      throw new Error(`[FacilityRuntime] ${key}.getCameraAnchor() 必须返回 position + quaternion`);
    }
    // pose.owner 显式声明 owner：若 T02 WASD 等并发抢走写权限，CameraRig 会
    // 拒绝本次 blendTo 而不是把相机写到一个已不属于本设施的 owner 上。
    cameraRig.blendTo({ ...anchor, owner: key }, DEFAULT_BLEND_SECONDS);

    // ③ 最后是视图自身进入（只切可见性 / 动效，不 dispose 任何共享资源）
    view.activate();
    this.activeView = view;
    this.activeKey = key;
    this._pendingControlsRestore = false;
    console.info(`[FacilityRuntime] 已进入嵌入视图「${key}」（大厅常驻，仅相机切换）`);
    return view;
  }

  /**
   * 退出嵌入视图：相机平滑回大厅、交还写权限、view.deactivate()。
   * 【不】dispose 视图、【不】碰 Lobby 根节点、【不】调 AttractionManager。
   * @param {{skipRestore?: boolean}} [options] skipRestore=true 用于「直接切到
   *        另一个嵌入视图」：不绕回大厅机位，直接从当前姿态 blend 到下一个锚点。
   * @returns {boolean} 是否确实退出了某个嵌入视图
   */
  deactivate({ skipRestore = false } = {}) {
    if (!this.activeView) return false;
    const key = this.activeKey;

    // CameraRig 握手（顺序关键）：restore 必须在【仍持有 owner】时发出；
    // 先 release 会让 owner=null，restore 会被 _canWrite() 拒绝。
    // restore 完成后再把写权限交还大厅（T02 WASD / OrbitControls 接管）。
    if (!skipRestore) {
      cameraRig.restore(this._lobbyKey, DEFAULT_BLEND_SECONDS, key);
    }
    cameraRig.releaseOwner(key);
    cameraRig.setOwner(this._lobbyKey);
    this.activeView.deactivate();
    this.activeView = null;
    this.activeKey = null;

    // OrbitControls 必须等相机回位后再启用，否则每帧与 CameraRig 打架
    this._pendingControlsRestore = !skipRestore && this._suspendedControls !== null;
    console.info(`[FacilityRuntime] 已退出嵌入视图「${key}」` +
      (skipRestore ? '（直接切往下一个嵌入视图）' : `，相机回大厅 (${DEFAULT_BLEND_SECONDS}s)`));
    return true;
  }

  /**
   * 每帧驱动：视图玩法矩阵 + CameraRig 插值 + 延迟恢复 Lobby 控制。
   * 由 main.js frameDriver.update 调用（在 SceneManager 暂停闸门内）。
   * @param {number} dt 秒
   */
  update(dt) {
    this.activeView?.update(dt);
    cameraRig.update(dt);
    if (this._pendingControlsRestore && !cameraRig.isTransitioning) {
      this._resumeLobbyControls();
    }
  }

  /** 挂起 Lobby 的 OrbitControls（唯一一处访问它的地方，Lobby.js 不改） */
  _suspendLobbyControls() {
    if (this._suspendedControls) return;
    const lobby = attractionManager.activeKey === this._lobbyKey
      ? attractionManager.active
      : null;
    const controls = lobby?._controls ?? null;
    if (!controls) return;
    const ctrl = controls;
    ctrl.enabled = false;
    // 【关键】只设 enabled=false 不够：T02 之后 Lobby.update() 的 orbit 分支
    // 每帧都会 `enabled = true; controls.update()`，而 OrbitControls.update()
    // 内部不检查 enabled，仍会按 target + 球坐标重算相机 → 成为「第二个写相机的人」，
    // 与嵌入视图的座舱软跟随逐帧打架（位置被拉回轨道球、真实 roll 抖动）。
    // 故嵌入期间把 update 临时替换为空操作（并清掉拖拽累积的球面/平移增量），
    // 让 activeView.update 成为唯一相机写者；回位结束后原样还原。
    this._controlsUpdateOriginal = ctrl.update;
    ctrl.update = () => {
      if (ctrl._sphericalDelta) ctrl._sphericalDelta.set(0, 0, 0);
      if (ctrl._panOffset) ctrl._panOffset.set(0, 0, 0);
      if (typeof ctrl._scale === 'number') ctrl._scale = 1;
    };
    this._suspendedControls = controls;
  }

  /** 回位过渡结束后恢复 Lobby 的 OrbitControls（连同原 update 一并还原） */
  _resumeLobbyControls() {
    const controls = this._suspendedControls;
    this._suspendedControls = null;
    this._pendingControlsRestore = false;
    if (!controls) return;
    if (this._controlsUpdateOriginal) {
      controls.update = this._controlsUpdateOriginal;
      this._controlsUpdateOriginal = null;
    }
    controls.enabled = true;
  }

  /** 契约自检：早失败好过运行到一半抛错 */
  _assertContract(view, key) {
    const required = ['init', 'getCameraAnchor', 'update', 'activate', 'deactivate', 'dispose'];
    for (const method of required) {
      if (typeof view?.[method] !== 'function') {
        throw new Error(`[FacilityRuntime] ${key} 未实现 IEmbeddedView.${method}()`);
      }
    }
  }

  /** 整体销毁：退出嵌入态、恢复控制、释放全部视图独占资源 */
  dispose() {
    this.deactivate();
    this._resumeLobbyControls();
    for (const view of this._views.values()) {
      try {
        view.dispose();
      } catch (err) {
        console.warn(`[FacilityRuntime] 视图 dispose 失败（已忽略）：`, err);
      }
    }
    this._views.clear();
    this._factories.clear();
    this.activeView = null;
    this.activeKey = null;
    this._ctx = null;
    this._configured = false;
  }
}

export const facilityRuntime = FacilityRuntime.getInstance();
export default facilityRuntime;
