/**
 * ============================================================================
 * PhysicsManager —— Rapier 物理世界管理器（单例）
 * ============================================================================
 * 职责：异步初始化 Rapier WASM、持有唯一的 World、并以固定步长推进模拟。
 *
 * 【关键防御性要求 / 版本差异标注】
 * 本工程实际安装的是 @dimforge/rapier3d-compat@0.21.0。以下结论均来自
 * node_modules/@dimforge/rapier3d-compat 内的类型定义与 README，未凭记忆猜测：
 *
 *   - dist/init.d.ts            : export declare function init(): Promise<void>
 *                                 注释明确「Has to be called and awaited before
 *                                 using any library methods」
 *   - dist/exports.d.ts         : export * from "./init"（init 为具名导出）
 *   - dist/rapier.d.ts          : import * as RAPIER from "./exports";
 *                                 export default RAPIER;
 *                                 → 默认导入得到完整命名空间，RAPIER.init() 可用
 *   - dist/pipeline/world.d.ts  : constructor(gravity: Vector)
 *                                 step(eventQueue?, hooks?)
 *                                 set timestep(dt: number)
 *                                 removeRigidBody(body)
 *                                 removeCollider(collider, wakeUp: boolean)
 *                                 free()
 *   - README «Bundler support»  : -compat 版把 .wasm 以 base64 内联进 .js，
 *                                 因此必须在运行时解码实例化 → 必须 await init()
 *
 * 版本差异：非 compat 的 @dimforge/rapier3d（以及 -simd / -deterministic）
 *          由打包器直接加载 .wasm，不提供 / 不需要 await init()；
 *          PRD v1.0 §6 也明确首版用标准版、SIMD 作为后续升级项。
 *          若日后升级 Rapier，请先重新核对 dist/init.d.ts 与
 *          dist/pipeline/world.d.ts 的签名，再调整本文件，不要沿用旧写法。
 *
 * 【全局唯一约束】world.step() 只允许在本文件的 step() 中出现。
 *          项目（Attraction）内部禁止自行推进物理，否则会出现双重步进、
 *          卸载时残留刚体等难以排查的问题。
 * ============================================================================
 */

import RAPIER from '@dimforge/rapier3d-compat';

export class PhysicsManager {
  static _instance = null;

  static getInstance() {
    if (!PhysicsManager._instance) PhysicsManager._instance = new PhysicsManager();
    return PhysicsManager._instance;
  }

  constructor() {
    this._ready = false;
    this._world = null;
    this._gravity = { x: 0, y: -9.81, z: 0 };
    this._fixedStep = 1 / 60; // Rapier 的固定积分步长（秒）
    this._accumulator = 0;
    this._maxFrameDelta = 0.1; // 单帧最大计入时间，防止切后台回来后「补帧爆炸」
    this._maxSubSteps = 5;
  }

  get isReady() { return this._ready; }

  /** 供项目创建刚体/碰撞体时复用同一个模块命名空间 */
  get RAPIER() { return RAPIER; }

  /** 未初始化就取 world 会直接报错，避免项目在 WASM 就绪前创建刚体 */
  get world() {
    if (!this._ready) {
      throw new Error('[PhysicsManager] 物理世界尚未初始化，请先 await physicsManager.init()');
    }
    return this._world;
  }

  /**
   * 异步初始化。compat 版必须先 await RAPIER.init()，否则 new World() 会抛错。
   * @returns {Promise<PhysicsManager>}
   */
  async init() {
    if (this._ready) return this;

    // ↓↓↓ 全工程唯一的 WASM 初始化点，必须 await ↓↓↓
    await RAPIER.init();

    // Rapier 0.21.0 的 World 构造参数是普通向量对象 {x, y, z}
    this._world = new RAPIER.World(this._gravity);
    this._world.timestep = this._fixedStep;
    this._ready = true;

    console.info(
      `[PhysicsManager] Rapier 初始化完成 | version=${RAPIER.version()} | timestep=${this._world.timestep}s`
    );
    return this;
  }

  /**
   * 全局唯一推进物理的入口，由 SceneManager 的渲染循环每帧调用。
   * 采用「固定步长累加器」消费 deltaTime：既让参数真正生效，又避免
   * 帧率波动直接改变积分步长（world.d.ts 明确警告 timestep 不宜大幅变化）。
   * @param {number} deltaTime 距上一帧的秒数
   */
  step(deltaTime = this._fixedStep) {
    if (!this._ready) return;

    this._accumulator += Math.min(Math.max(deltaTime, 0), this._maxFrameDelta);
    let steps = 0;
    while (this._accumulator >= this._fixedStep && steps < this._maxSubSteps) {
      this._world.step(); // ← 全工程唯一 world.step() 调用点
      this._accumulator -= this._fixedStep;
      steps += 1;
    }
    // 超出上限的积压直接丢弃，宁可少算几步也不让主线程被物理拖死
    if (steps === this._maxSubSteps) this._accumulator = 0;
  }

  /** 整体关闭时释放 WASM 内存；卸载单个项目时不要调用 */
  dispose() {
    if (this._world) {
      try {
        this._world.free();
      } catch (err) {
        console.error('[PhysicsManager] world.free() 失败：', err);
      }
    }
    this._world = null;
    this._accumulator = 0;
    this._ready = false;
  }
}

export const physicsManager = PhysicsManager.getInstance();
export default physicsManager;
