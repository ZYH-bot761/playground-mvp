/**
 * ============================================================================
 * IAttraction 接口契约 v1.0（注释形式的技术级契约文档）
 * ============================================================================
 * 对应 PRD v1.0 附录 B「技术契约」与《游乐场 MVP 功能详细设计 v0.1》§7：
 * PRD 回答「做什么」，详细设计回答「有什么」，本契约回答「代码怎么写、资源怎么释放」。
 * 所有游乐项目（当前仅 DummyAttraction，后续 5 类玩法）必须实现四个方法。
 *
 * ---------------------------------------------------------------------------
 * 生命周期（由 AttractionManager 统一调度，项目不得自行改变顺序）
 * ---------------------------------------------------------------------------
 *   register(key, factory) → activate(key) → [每帧 update(dt)] → deactivate()
 *   切出项目时严格为：
 *       ① 项目 dispose()
 *       ② DisposableRegistry.disposeAll()
 *       ③ 从 scene 移除项目根节点
 *
 * ---------------------------------------------------------------------------
 * init(ctx)：创建物体、材质、纹理和物理刚体，并登记到
 *            ctx.registerDisposable(...) 或自身内部数组（二选一或并用）。
 *   ctx 字段：
 *     scene / camera / renderer : THREE 三大件
 *     RAPIER                    : @dimforge/rapier3d-compat 模块命名空间
 *     world                     : Rapier World（已 await init() 完成）
 *     physics                   : PhysicsManager（只读，禁止借它推进物理）
 *     ui / interaction          : UIManager / InteractionManager
 *     registerDisposable(obj)   : 本轮激活专属的 DisposableRegistry.register
 *     registry                  : 本轮激活专属的 DisposableRegistry 实例
 *   要求：根节点挂到 ctx.scene，并暴露为实例属性 root（供管理器移除）。
 *
 * update(deltaTime)：每帧更新逻辑，deltaTime 单位为秒。
 *   ★ 绝对禁止在此调用 world.step()：物理推进由 PhysicsManager.step() 独占。
 *
 * onInteract(hitInfo)：响应 InteractionManager 分发的点击事件。
 *   hitInfo = { event, hasHit, object, point, distance, face, uv, intersections }
 *
 * dispose()：【最高风险】必须完整释放本项目创建的一切资源，缺一即造成
 *            PRD §9.2「资源计数不回落 / 连续切换漂移」。逐项检查：
 *
 *   1. 几何体：遍历自身所有 Mesh 的 geometry，逐一 geometry.dispose()。
 *   2. 材质：逐一 material.dispose()（材质本身不进 info.memory 计数，
 *      但不释放会残留 shader program）。
 *   3. 纹理：除标准纹理槽位（map / normalMap / roughnessMap / aoMap /
 *      emissiveMap / alphaMap / envMap …）外，
 *      ★ 必须额外检查 ShaderMaterial.uniforms 对象中所有「值为 THREE.Texture」
 *        的属性并逐一 dispose()。uniform.value 还可能是 Texture[]、
 *        结构体数组等，需递归下钻，只用固定槽位列表会漏掉这类纹理。
 *      用 Set 去重，避免同一纹理被重复释放。
 *   4. 物理：创建的每个 Rapier 刚体必须 world.removeRigidBody(body)；
 *      独立创建（未挂在刚体上）的 Collider 必须 world.removeCollider(c, true)。
 *      ★ 顺序：removeRigidBody 会级联删除「挂载在该刚体上」的 collider，
 *        因此独立 collider 先单独移除，刚体后移除；已被级联删除的 collider
 *        绝不能再次 removeCollider，否则 double free。
 *   5. dispose() 必须幂等：AttractionManager 会先调 dispose()、再调
 *      registry.disposeAll()（兜底），因此内部要有 _disposed 锁。
 *
 * 参考实现：DummyAttraction.dispose() 是上述第 3、4 条的可运行范例；
 *           后续真实项目可直接复用其纹理收集与物理移除写法。
 * ============================================================================
 */

/** 抽象基类：仅用于声明契约，四个方法必须由子类覆盖 */
export class IAttraction {
  /** @param {Object} ctx 上下文，见上方契约 */
  init(_ctx) {
    throw new Error('[IAttraction] 子类必须实现 init(ctx)');
  }

  /** @param {number} _deltaTime 距上一帧的秒数 */
  update(_deltaTime) {
    throw new Error('[IAttraction] 子类必须实现 update(deltaTime)');
  }

  /** @param {Object} _hitInfo 射线拾取结果 */
  onInteract(_hitInfo) {
    throw new Error('[IAttraction] 子类必须实现 onInteract(hitInfo)');
  }

  /** 释放全部 GPU / 物理资源，必须幂等 */
  dispose() {
    throw new Error('[IAttraction] 子类必须实现 dispose()【最高风险】');
  }
}

export default IAttraction;
