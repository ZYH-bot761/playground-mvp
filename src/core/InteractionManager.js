/**
 * ============================================================================
 * InteractionManager —— 射线拾取与事件分发（单例）
 * ============================================================================
 * 职责：监听画布上的点击（鼠标 / 触屏点击都会触发 click），用 THREE.Raycaster
 *       对场景做拾取，把命中的对象信息打包成 hitInfo，统一分发给
 *       「当前激活的 Attraction.onInteract(hitInfo)」。
 *
 * 设计要点：
 *   - 监听挂在 renderer.domElement 上，而不是 window，因此悬浮 UI 的按钮
 *     点击不会穿透成一次场景拾取；
 *   - 只负责「分发」，不持有任何几何体/材质，卸载项目时无需清理 GPU 资源；
 *   - 无命中时同样分发（hasHit=false），由项目自己决定要不要响应。
 * ============================================================================
 */

import * as THREE from 'three';

export class InteractionManager {
  static _instance = null;

  static getInstance() {
    if (!InteractionManager._instance) InteractionManager._instance = new InteractionManager();
    return InteractionManager._instance;
  }

  constructor() {
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._renderer = null;
    this._camera = null;
    this._scene = null;
    this._attractions = null;
    this._initialized = false;

    // 用箭头函数固定 this，便于 add/removeEventListener 成对解绑
    this._onClick = (event) => {
      if (!this._renderer || !this._camera || !this._scene) return;

      const rect = this._renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // 屏幕坐标 → NDC（-1 ~ +1）
      this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      this._raycaster.setFromCamera(this._pointer, this._camera);
      const intersections = this._raycaster.intersectObjects(this._scene.children, true);
      const first = intersections.length > 0 ? intersections[0] : null;

      /** hitInfo：交给项目的最小交互契约 */
      const hitInfo = {
        event,
        hasHit: Boolean(first),
        object: first ? first.object : null,
        point: first && first.point ? first.point.clone() : null,
        distance: first ? first.distance : Infinity,
        face: first ? first.face : null,
        uv: first && first.uv ? first.uv.clone() : null,
        intersections, // 完整命中列表，供需要「穿透点击」的项目使用
      };

      // 只分发给当前激活项目；未激活时静默丢弃
      if (this._attractions && this._attractions.active) {
        this._attractions.onInteract(hitInfo);
      }
    };
  }

  /**
   * @param {{renderer: THREE.WebGLRenderer, camera: THREE.Camera,
   *          scene: THREE.Scene, attractions: Object}} deps
   */
  init({ renderer, camera, scene, attractions }) {
    this._renderer = renderer;
    this._camera = camera;
    this._scene = scene;
    this._attractions = attractions;

    if (!this._initialized) {
      renderer.domElement.addEventListener('click', this._onClick);
      this._initialized = true;
    }
    return this;
  }

  /** 解绑事件，避免重复初始化造成多次分发 */
  dispose() {
    if (this._renderer && this._initialized) {
      this._renderer.domElement.removeEventListener('click', this._onClick);
    }
    this._initialized = false;
    this._attractions = null;
  }
}

export const interactionManager = InteractionManager.getInstance();
export default interactionManager;
