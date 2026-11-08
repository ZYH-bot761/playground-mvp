/**
 * ============================================================================
 * DisposableRegistry —— 资源清理登记器
 * ============================================================================
 * 职责：为「每一个游乐项目实例」维护一份独立的资源登记数组，作为项目自身
 *       dispose() 之外的第二道安全网，对应 PRD v1.0 §6 与 §9.2 的
 *       「切换项目后无明显内存持续增长 / 资源计数回落至基线」。
 *
 * 登记约定：
 *   ① 带 dispose() 方法的对象：THREE.BufferGeometry / Material / Texture 等；
 *   ② 一个清理函数 () => void：用于 Rapier 刚体、DOM 事件等自定义清理；
 *   ③ 其它值会被忽略并给出警告，避免误登记导致 disposeAll 整体崩溃。
 *
 * 释放策略：
 *   - 逆序释放（后创建的资源往往依赖先创建的资源）；
 *   - 每个条目单独 try/catch，整体再包一层 try/catch：任何单个资源释放
 *     失败都不得中断其余资源的释放；
 *   - 无论成功失败，最后都清空数组，保证可重复调用、不残留引用。
 *
 * 备注：THREE 的 geometry / material / texture 的 dispose() 本身是幂等的
 *      （渲染器在首次 dispose 事件里就移除了监听器），因此「项目 dispose()」
 *      与「登记器兜底」形成的双重释放是安全且被刻意设计的。
 * ============================================================================
 */

export class DisposableRegistry {
  /** @param {string} label 仅用于日志定位，便于多项目切换时排查 */
  constructor(label = 'attraction') {
    this.label = label;
    /** @type {Array<{ dispose: () => void } | (() => void)>} */
    this._items = [];
  }

  /** 当前登记的资源数量，验收时可用于观察是否被清空 */
  get size() {
    return this._items.length;
  }

  /**
   * 登记一个可释放资源。
   * @param {{dispose: Function}|Function|*} obj
   * @returns {*} 原样返回，方便写 const tex = registry.register(new Texture())
   */
  register(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'function' || (typeof obj === 'object' && typeof obj.dispose === 'function')) {
      this._items.push(obj);
    } else {
      console.warn(`[DisposableRegistry:${this.label}] 对象既不是函数也没有 dispose()，已忽略登记：`, obj);
    }
    return obj;
  }

  /** 按逆序释放全部登记资源，并清空数组 */
  disposeAll() {
    try {
      for (let i = this._items.length - 1; i >= 0; i -= 1) {
        const item = this._items[i];
        try {
          if (typeof item === 'function') item();
          else item.dispose();
        } catch (err) {
          // 单个资源失败只记录，继续释放剩余资源
          console.error(`[DisposableRegistry:${this.label}] 第 ${i} 项释放失败，继续：`, err);
        }
      }
    } catch (err) {
      // 整体防御：即使数组被外部意外改写，也不把异常抛给卸载流程
      console.error(`[DisposableRegistry:${this.label}] disposeAll 发生异常：`, err);
    } finally {
      this._items.length = 0;
    }
  }

  /** 只丢弃登记引用、不执行释放（切换项目时通常不用，保留给特殊场景） */
  clear() {
    this._items.length = 0;
  }
}

export default DisposableRegistry;
