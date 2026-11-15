/**
 * ============================================================================
 * IEmbeddedView —— 嵌入视图契约（v4 方案 A：双层契约 + 相机即视图）
 * ============================================================================
 * 【它解决什么】
 * 旧 IAttraction 的「进入 = 卸载大厅、new 一座设施场景」正是用户抱怨的
 * 「大厅和具体游戏割裂」根源。IEmbeddedView 是与 IAttraction **并行**的第二
 * 契约：实现它的设施不拥有独立场景，而是把玩法件挂进唯一场景的
 * SceneContext.propsRoot，通过 CameraRig.blendTo(anchor) 只换相机机位。
 *
 * 【硬禁令（违反即破坏一体化与 Δ0/0）】
 *  1. 禁止 new THREE.Scene() / 换 renderer 目标 —— 全程只有 SceneManager.scene；
 *  2. 禁止改 scene.background / scene.fog —— 天空、雾、昼夜由 Lobby + 全局单例常驻；
 *  3. 禁止 dispose Lobby 的 _shared 几何 / 材质 / 纹理 —— 那些归 Lobby 所有；
 *  4. 禁止隐藏 Lobby 根节点 —— 用户必须「仍在同一个 3D 世界里」；
 *  5. 只 track() 自己独占的 GPU 资源，dispose() 时统一释放；
 *  6. update(dt) 热路径禁止 new 任何几何 / 材质 / 纹理（保持 Δ0/0）。
 *
 * 【契约方法】
 *   init(ctx)                 生命周期：注入共享上下文，建玩法件（只挂 propsRoot）
 *   getCameraAnchor()         必填：返回本设施座位的世界位姿，供 CameraRig.blendTo
 *   update(dt)                每帧驱动自有玩法矩阵（木马转 / 海盗船摆 / …）
 *   activate() / deactivate() 只切可见性与动效开关，绝不 dispose 共享资源
 *   dispose()                 终态：摘 root、释放 track() 的独占资源、解绑监听
 *
 * 【getCameraAnchor() 返回形状】
 *   {
 *     position:   THREE.Vector3,       // 世界坐标
 *     quaternion: THREE.Quaternion,    // 世界朝向（-Z 为视线前方）
 *     lookAt?:    THREE.Vector3,       // 可选目标点，CameraRig 可据此校准
 *     fov?:       number,              // 可选视场角，省略则沿用当前相机
 *   }
 *
 * 【与 FacilityRuntime 的分工】
 * FacilityRuntime 负责注册 / 懒创建 / CameraRig 仲裁 / 挂起 Lobby OrbitControls /
 * 每帧 update；本基类只规定视图自身的生命周期与资源纪律。
 * ============================================================================
 */

import * as THREE from 'three';

export class IEmbeddedView {
  constructor() {
    /** @type {string} 设施 key（与 FacilityRuntime.register 的 key 一致） */
    this.key = '';
    /** @type {Object|null} init() 注入的共享上下文 */
    this.ctx = null;
    /** @type {THREE.Group|null} 本视图独占的玩法件根节点，挂在 propsRoot 下 */
    this.root = null;
    /** @type {Set<Object>} 本视图独占的 GPU 资源（需有 dispose()） */
    this._disposables = new Set();
    this._active = false;
    this._disposed = false;
  }

  get isActive() { return this._active; }
  get isDisposed() { return this._disposed; }

  /**
   * 注入共享上下文。基类只保存 ctx；子类在这里建自己的 root 并挂 ctx.propsRoot。
   * @param {{scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer,
   *          sceneContext: Object, worldRoot: THREE.Group, propsRoot: THREE.Group}} ctx
   * @returns {this}
   */
  init(ctx) {
    if (this._disposed) {
      throw new Error(`[IEmbeddedView] ${this.key} 已 dispose，不能重新 init`);
    }
    this.ctx = ctx || null;
    return this;
  }

  /**
   * 【必须实现】返回本设施内座位的世界位姿，供 CameraRig.blendTo() 使用。
   * @returns {{position: THREE.Vector3, quaternion: THREE.Quaternion,
   *            lookAt?: THREE.Vector3, fov?: number}}
   */
  getCameraAnchor() {
    throw new Error(`[IEmbeddedView] ${this.key} 必须实现 getCameraAnchor()`);
  }

  /**
   * 每帧更新自有玩法矩阵。默认空实现（纯观赏锚点可省略）。
   * 硬约束：热路径禁止 new geometry / material / texture。
   * @param {number} _dt 秒
   */
  update(_dt) {
    // 默认无操作
  }

  /**
   * 进入视图：只切可见性与动效开关，绝不 dispose 共享资源。
   * @returns {this}
   */
  activate() {
    if (this._disposed) return this;
    if (this.root) this.root.visible = true;
    this._active = true;
    return this;
  }

  /**
   * 退出视图：停止动效、隐藏玩法件，但【不 dispose】，供下次进入复用。
   * @returns {this}
   */
  deactivate() {
    this._active = false;
    if (this.root) this.root.visible = false;
    return this;
  }

  /**
   * 登记本视图独占的 GPU 资源，dispose() 时统一释放。
   * @param {Object} resource 需带 dispose() 方法
   * @returns {Object} 原对象，便于链式使用
   */
  track(resource) {
    if (resource && typeof resource.dispose === 'function') {
      this._disposables.add(resource);
    }
    return resource;
  }

  /**
   * 终态清理：摘除 root、释放独占资源、解绑监听。
   * 【禁止】碰 Lobby 的 _shared / scene.background / scene.fog / Lobby 根节点。
   */
  dispose() {
    if (this._disposed) return;
    this._active = false;
    if (this.root) {
      this.root.parent?.remove(this.root);
      this.root = null;
    }
    for (const resource of this._disposables) {
      try {
        resource.dispose();
      } catch (err) {
        console.warn(`[IEmbeddedView] ${this.key} 释放资源失败（已忽略）：`, err);
      }
    }
    this._disposables.clear();
    this.ctx = null;
    this._disposed = true;
  }
}

export default IEmbeddedView;
