/**
 * ============================================================================
 * SceneContext —— 唯一 3D 世界的共享上下文（v4 T01 建立骨架，T03 起正式使用）
 * ============================================================================
 * 职责：持有全工程唯一的 scene / camera / renderer，以及两个常驻根节点：
 *   - worldRoot ：大厅常驻外观（草坪 / 城堡门 / 世纪钟 / 树 / 站台 / 过山车轨道）
 *   - propsRoot ：进入设施时懒挂载的玩法专用件（座舱 / 跳跳方块 / 骑乘道具）
 *   - facilityAnchors：Map<key, THREE.Object3D>，每个设施的世界坐标锚点（相机目标）
 *
 * 【唯一世界不变量】
 * 全程只有 SceneManager.scene 一个 THREE.Scene。本类只持有引用、不 new Scene，
 * 也绝不改 scene.background / scene.fog —— 这是 v4 消除「大厅/设施割裂」的根基。
 *
 * 【为什么是空 Group 而不是业务对象】
 * T01 阶段 worldRoot / propsRoot 只建空 THREE.Group：没有 geometry / material /
 * texture，因此既不上传 GPU 资源，也不改变 renderer.info.memory 的 Δ0/0 基线。
 * 它们不打 attractionRoot 标记，AttractionManager.deactivate() 的孤儿清理不会误删。
 * T03 起由 FacilityRuntime 把设施外观 / 玩法件挂到这两个节点上。
 *
 * 【生命周期】
 *   sceneContext.configure({ scene, camera, renderer });  // bootstrap 早期，幂等
 *   sceneContext.setAnchor('carousel', [9, 1.6, 2], quat);
 *   const anchor = sceneContext.getAnchor('carousel');    // 未登记返回 null
 *   sceneContext.dispose();                                // 仅摘除自有节点，不碰 scene 资源
 * ============================================================================
 */

import * as THREE from 'three';

/** 把位置入参统一转成 Vector3（支持 Vector3 / [x,y,z] / {x,y,z}） */
function toVector3(value) {
  if (value?.isVector3) return value;
  if (Array.isArray(value)) {
    return new THREE.Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  }
  return new THREE.Vector3(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
}

/** 把朝向入参统一转成 Quaternion（支持 Quaternion / Euler / [x,y,z,w] / {x,y,z,w}） */
function toQuaternion(value) {
  if (value?.isQuaternion) return value;
  if (value?.isEuler) return new THREE.Quaternion().setFromEuler(value);
  if (Array.isArray(value)) {
    return new THREE.Quaternion(
      value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1
    );
  }
  return new THREE.Quaternion(
    value?.x ?? 0, value?.y ?? 0, value?.z ?? 0, value?.w ?? 1
  );
}

export class SceneContext {
  static _instance = null;

  static getInstance() {
    if (!SceneContext._instance) SceneContext._instance = new SceneContext();
    return SceneContext._instance;
  }

  constructor() {
    /** @type {THREE.Scene|null} 唯一场景，由 SceneManager 注入 */
    this.scene = null;
    /** @type {THREE.PerspectiveCamera|null} 唯一相机，由 SceneManager 注入 */
    this.camera = null;
    /** @type {THREE.WebGLRenderer|null} 唯一渲染器，由 SceneManager 注入 */
    this.renderer = null;

    /** 大厅常驻根节点（空 Group，零 GPU 资源） */
    this.worldRoot = new THREE.Group();
    this.worldRoot.name = 'SceneContext.worldRoot';
    this.worldRoot.userData.sceneContextRoot = 'world';

    /** 设施玩法件懒挂载根节点（空 Group，零 GPU 资源） */
    this.propsRoot = new THREE.Group();
    this.propsRoot.name = 'SceneContext.propsRoot';
    this.propsRoot.userData.sceneContextRoot = 'props';

    /** @type {Map<string, THREE.Object3D>} 设施 key → 世界坐标锚点 */
    this.facilityAnchors = new Map();

    this._configured = false;
  }

  /** 是否已完成 configure() */
  get isConfigured() { return this._configured; }

  /**
   * 注入 SceneManager 的三件套，并把两个空根节点挂进唯一场景（幂等）。
   * 换 scene 时会先把根节点从旧场景摘除，避免跨场景残留。
   * @param {{scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer}} refs
   * @returns {this}
   */
  configure({ scene, camera, renderer } = {}) {
    if (!scene || !camera || !renderer) {
      throw new Error('[SceneContext] configure 需要 { scene, camera, renderer } 三项');
    }
    if (this.scene && this.scene !== scene) {
      this.scene.remove(this.worldRoot, this.propsRoot);
    }
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;

    // 已 parent 时不重复 add（three 会自动从旧父节点摘除，这里显式判断更清晰）
    if (!this.worldRoot.parent) scene.add(this.worldRoot);
    if (!this.propsRoot.parent) scene.add(this.propsRoot);

    this._configured = true;
    return this;
  }

  /**
   * 登记 / 更新一个设施锚点。锚点是 worldRoot 下的空 Object3D，
   * 只提供世界坐标与朝向供 CameraRig / FacilityRuntime 取用，本身不渲染。
   * @param {string} key 设施 key（如 'carousel'）
   * @param {THREE.Vector3|number[]|{x?:number,y?:number,z?:number}} position 世界坐标
   * @param {THREE.Quaternion|THREE.Euler|number[]|{x?:number,y?:number,z?:number,w?:number}} [quaternion]
   *        可选朝向；省略时保留旧朝向（新锚点为单位四元数）
   * @returns {THREE.Object3D} 锚点对象
   */
  setAnchor(key, position, quaternion = null) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('[SceneContext] setAnchor: key 必须是非空字符串');
    }
    if (!this._configured) {
      throw new Error('[SceneContext] setAnchor: 必须先 configure()');
    }

    let anchor = this.facilityAnchors.get(key);
    if (!anchor) {
      anchor = new THREE.Object3D();
      anchor.name = `facility-anchor:${key}`;
      anchor.userData.facilityKey = key;
      this.facilityAnchors.set(key, anchor);
      this.worldRoot.add(anchor);
    }

    if (position != null) anchor.position.copy(toVector3(position));
    if (quaternion != null) anchor.quaternion.copy(toQuaternion(quaternion));
    anchor.updateMatrixWorld(true);
    return anchor;
  }

  /**
   * 读取设施锚点。
   * @param {string} key
   * @returns {THREE.Object3D|null} 未登记返回 null（不抛错，便于流式判空）
   */
  getAnchor(key) {
    return this.facilityAnchors.get(key) ?? null;
  }

  /**
   * 清理本类持有的节点与锚点。
   * 只摘节点、不 dispose：scene / camera / renderer 归 SceneManager 所有，
   * worldRoot / propsRoot 里将来挂的业务资源归各自 Attraction 的 registry 所有。
   */
  dispose() {
    this.scene?.remove(this.worldRoot, this.propsRoot);
    this.facilityAnchors.clear();
    this._configured = false;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
  }
}

export const sceneContext = SceneContext.getInstance();
export default sceneContext;
