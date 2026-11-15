/**
 * ============================================================================
 * AttractionManager —— 项目注册 / 激活 / 卸载调度（单例）
 * ============================================================================
 * 职责：把「游乐项目」做成可插拔单元（PRD v1.0 目标：后续增加项目不推翻重来）。
 *   - register(key, factory)：登记项目工厂（工厂每次返回一个全新实例）
 *   - activate(key)：实例化 → 建立本轮专属 DisposableRegistry → 注入 ctx → init()
 *   - deactivate()：严格按契约顺序卸载
 *   - update(dt) / onInteract(hit)：只转发给当前激活项目
 *
 * 【卸载顺序：不可调整】
 *   ① active.dispose()          —— 项目自己释放几何体/材质/纹理/刚体
 *   ② registry.disposeAll()     —— 登记器兜底，补掉项目遗漏的资源
 *   ③ scene.remove(root)        —— 最后把根节点从场景摘除
 *   每一步单独 try/catch，任何一步抛错都不能阻断后续清理。
 * ============================================================================
 */

import { DisposableRegistry } from './disposable-registry.js';

export class AttractionManager {
  static _instance = null;

  static getInstance() {
    if (!AttractionManager._instance) AttractionManager._instance = new AttractionManager();
    return AttractionManager._instance;
  }

  constructor() {
    /** @type {Map<string, Function>} key → 项目实例工厂 */
    this._factories = new Map();
    this._active = null;
    this._activeKey = null;
    this._registry = null;
    this._baseCtx = {};
  }

  /** 注入所有项目共享的上下文（scene / camera / renderer / RAPIER / world …） */
  configure(baseCtx) {
    this._baseCtx = baseCtx || {};
    return this;
  }

  /** @param {string} key @param {Function} factory () => IAttraction */
  register(key, factory) {
    if (typeof factory !== 'function') {
      throw new Error(`[AttractionManager] ${key} 的工厂必须是函数`);
    }
    this._factories.set(key, factory);
    return this;
  }

  unregister(key) {
    if (this._activeKey === key) this.deactivate();
    this._factories.delete(key);
    return this;
  }

  /** 当前激活的项目实例（InteractionManager 据此判断是否分发） */
  get active() { return this._active; }
  get activeKey() { return this._activeKey; }
  get registry() { return this._registry; }
  get keys() { return [...this._factories.keys()]; }

  /**
   * 激活项目。若已有项目在跑，先完整卸载，保证「任意时刻最多一个项目」。
   * @param {string} key
   */
  activate(key) {
    const factory = this._factories.get(key);
    if (!factory) throw new Error(`[AttractionManager] 未注册的项目：${key}`);

    if (this._active) this.deactivate();

    // 每次激活都用全新的登记器，杜绝跨项目残留
    const registry = new DisposableRegistry(key);
    this._registry = registry;

    const instance = factory();
    for (const method of ['init', 'update', 'onInteract', 'dispose']) {
      if (typeof instance?.[method] !== 'function') {
        throw new Error(`[AttractionManager] ${key} 未实现 IAttraction.${method}()`);
      }
    }

    this._active = instance;
    this._activeKey = key;

    const ctx = {
      ...this._baseCtx,
      registry,
      registerDisposable: (obj) => registry.register(obj),
    };

    try {
      instance.init(ctx);
      console.info(`[AttractionManager] 已激活项目「${key}」| 登记资源 ${registry.size} 项`);
    } catch (err) {
      // 半初始化也要尽力清理，绝不能把半成品留在场景/世界里
      console.error(`[AttractionManager] 项目「${key}」init 失败，执行回滚清理：`, err);
      this.deactivate();
      throw err;
    }
    return instance;
  }

  /** 卸载当前项目，严格遵循 dispose → disposeAll → scene.remove 顺序 */
  deactivate() {
    if (!this._active && !this._registry) return;

    const instance = this._active;
    const root = instance?.root ?? null;
    const registry = this._registry;
    const key = this._activeKey;

    // ① 项目自身 dispose()（项目内部实现必须幂等）
    try {
      instance?.dispose?.();
    } catch (err) {
      console.error(`[AttractionManager] 项目「${key}」dispose() 抛错，继续兜底清理：`, err);
    }

    // ② 登记器兜底释放（同样是幂等的，二次 dispose 安全）
    try {
      registry?.disposeAll();
    } catch (err) {
      console.error(`[AttractionManager] registry.disposeAll() 抛错：`, err);
    }

    // ③ 最后从场景移除根节点；并兜底清除遗漏的、带 attractionRoot 标记的孤儿节点
    try {
      const scene = this._baseCtx.scene;
      if (scene) {
        if (root) scene.remove(root);
        for (const child of [...scene.children]) {
          if (child !== root && child.userData?.attractionRoot === true) scene.remove(child);
        }
      }
    } catch (err) {
      console.error(`[AttractionManager] 从场景移除「${key}」失败：`, err);
    }

    this._active = null;
    this._activeKey = null;
    this._registry = null;
    console.info(`[AttractionManager] 已卸载项目「${key}」`);
  }

  /** 由 SceneManager 渲染循环统一调用 */
  update(deltaTime) {
    try {
      this._active?.update?.(deltaTime);
    } catch (err) {
      console.error('[AttractionManager] update() 异常：', err);
    }
  }

  /** 由 InteractionManager 点击时统一分发 */
  onInteract(hitInfo) {
    try {
      this._active?.onInteract?.(hitInfo);
    } catch (err) {
      console.error('[AttractionManager] onInteract() 异常：', err);
    }
  }

  /** 整体关闭 */
  dispose() {
    this.deactivate();
    this._factories.clear();
  }
}

export const attractionManager = AttractionManager.getInstance();
export default attractionManager;
