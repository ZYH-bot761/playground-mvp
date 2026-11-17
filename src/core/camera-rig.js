/**
 * ============================================================================
 * CameraRig.js —— 全局相机仲裁单例（v4 T14）
 * ============================================================================
 * 职责：批次2「场景一体化」与 WASD 切换会同时存在多个相机控制源——
 *   - OrbitControls（鼠标拖拽 / 滚轮）
 *   - WASDController（键盘漫游）
 *   - 嵌入设施机位（摩天轮座舱 / 木马座位 / 海盗船 / 跳一跳 / 世纪钟设施）
 * 若三者各存各的 `_cameraSaved`、各自调 `lookAt`，会出现「相机双主控 dances」：
 * 互相覆盖、抖动、进出设施后视角错乱。本类是【唯一仲裁】：同一时刻只有
 * 一个 owner 能写相机；非 owner 的写操作被拒绝，杜绝互相覆盖。
 *
 * 【只管姿态，不碰输入 / 场景】
 *   - 不自己监听鼠标 / 键盘；owner 切换由调用方（T02/T03）显式 setOwner。
 *   - 绝不 camera.add() 到任何 Group（项目纪律：只读世界坐标再 copy）。
 *   - 不建 geometry / material / texture（零 GPU 资源）；不打 attractionRoot。
 *   - 不碰 scene.background / scene.fog。
 *   - 只用 THREE 数学对象做插值；相机引用由 SceneManager 注入。
 *
 * 【平滑 / 防眩晕】
 *   - 0.8s 默认过渡用 smoothstep 缓动 `t*t*(3-2*t)`（两端速度为 0），
 *     与 Lobby 坐姿插值同手法；无突变、无随机抖动、无 roll。
 *   - position 用 lerpVectors、quaternion 用 slerpQuaternions（最短弧，不累积 roll）、
 *     fov 线性插值、up 做 lerp+normalize。
 *   - 过渡中途收到新的 blendTo：起点永远取【相机当前姿态】→ 天然平滑接续，无跳变。
 *   - isTransitioning getter 供调用方在过渡期禁用 OrbitControls / WASD。
 *
 * 【典型接线（T02/T03 照此）】
 *   cameraRig.configure({ camera: sceneManager.camera });   // bootstrap 早期，幂等
 *   cameraRig.setOwner('lobby');
 *   cameraRig.save('lobby');                                 // 记录大厅机位
 *   // 进入设施（换相机）：
 *   cameraRig.setOwner('carousel');
 *   cameraRig.blendTo({ position:[9,3,2], lookAt:[0,1,0], fov:62 }, 0.8);
 *   // 退出设施：过渡结束后把控制权交还大厅
 *   cameraRig.restore('lobby', 0.8);
 *   cameraRig.setOwner('lobby');
 *   // 每帧（T03 挂进 frameDriver）：cameraRig.update(dt);
 *
 * 【严格仲裁（可选）】
 *   blendTo 的 pose 可带 `owner` 字段，save/restore 可带可选 ownerHint；
 *   若声明的 owner 与当前 owner 不符 → 拒绝（返回 false + console.warn）。
 *   任何写操作在【当前无 owner】时一律拒绝。
 *
 * 【两条写入通道，都受 owner 仲裁】
 *   - blendTo / restore：带 0.8s smoothstep 过渡，用于"进入/退出"这类一次性机位切换；
 *   - writePose：立即直写、无过渡，用于"每帧跟随"型 owner（驾驶舱跟随刚体、飞行动画）。
 *     直写者必须先 allowDirectWrite(key) 登记，未登记者被拒并告警；写入计入
 *     directWriteCount 审计。项目生产代码中所有相机写操作必须经本类这两条通道，
 *     禁止在子系统里裸写 camera.position / lookAt。
 *
 * 【生命周期】configure/attach 幂等；update 幂等；dispose 幂等，清槽位与 owner。
 * ============================================================================
 */
import * as THREE from 'three';

/** 复用的临时数学对象，模块级单例，零 GPU 资源 / 热路径零分配 */
const _TMP_MAT = new THREE.Matrix4();
const _TMP_V1 = new THREE.Vector3();
const _TMP_V2 = new THREE.Vector3();
const _TMP_Q = new THREE.Quaternion();
const _TMP_E = new THREE.Euler();

/**
 * 零分配读取向量：支持 [x,y,z] 与 {x,y,z}；缺省值沿用调用方给的数。
 * 不 new 任何对象，可直接用于每帧路径。
 */
function _readVec3(value, out, dx, dy, dz) {
  if (Array.isArray(value)) return out.set(value[0] ?? dx, value[1] ?? dy, value[2] ?? dz);
  return out.set(value?.x ?? dx, value?.y ?? dy, value?.z ?? dz);
}

/** 把位置入参统一转成 Vector3（Vector3 / [x,y,z] / {x,y,z}） */
function toVector3(value) {
  if (value?.isVector3) return value;
  if (Array.isArray(value)) {
    return new THREE.Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  }
  return new THREE.Vector3(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
}

/** 把朝向入参统一转成 Quaternion（Quaternion / Euler / [x,y,z,w] / {x,y,z,w}） */
function toQuaternion(value) {
  if (value?.isQuaternion) return value;
  if (value?.isEuler) return new THREE.Quaternion().setFromEuler(value);
  if (Array.isArray(value)) {
    return new THREE.Quaternion(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1);
  }
  return new THREE.Quaternion(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0, value?.w ?? 1);
}

export class CameraRig {
  static _instance = null;

  static getInstance() {
    if (!CameraRig._instance) CameraRig._instance = new CameraRig();
    return CameraRig._instance;
  }

  constructor() {
    /** @type {THREE.Camera|null} 由 SceneManager 注入的唯一相机 */
    this.camera = null;
    /** @type {string|null} 当前唯一拥有写权限的 owner */
    this._owner = null;
    /** @type {Map<string, {position:THREE.Vector3,quaternion:THREE.Quaternion,up:THREE.Vector3,rotationOrder:string,fov:number}>} */
    this._slots = new Map();
    /** @type {{from:Object,to:Object,elapsed:number,duration:number}|null} */
    this._transition = null;
    /** 受控直写审计：哪些 owner 用过 writePose、累计次数（调试面板/验收读取） */
    this._directWriters = new Set();
    this._directWriteCount = 0;
    this._disposed = false;
  }

  /** 是否已完成 configure 且未被 dispose */
  get isConfigured() { return Boolean(this.camera) && !this._disposed; }
  /** 当前 owner key（null 表示无人持有，此时所有写操作被拒） */
  get owner() { return this._owner; }
  /** 是否正在姿态过渡中（调用方可据此禁用 OrbitControls / WASD） */
  get isTransitioning() { return this._transition !== null; }
  /** 已登记的槽位数量（调试用） */
  get slotCount() { return this._slots.size; }
  /** 审计：累计受控直写次数 / 使用过的 owner 列表 */
  get directWriteCount() { return this._directWriteCount; }
  get directWriters() { return [...this._directWriters]; }

  /**
   * 注入相机单例（幂等）。重复调用可换相机（如测试重配）。
   * @param {{camera:THREE.Camera}} refs
   * @returns {this}
   */
  configure({ camera } = {}) {
    if (!camera) throw new Error('[CameraRig] configure 需要 { camera }');
    this.camera = camera;
    this._disposed = false;
    return this;
  }

  /** attach(camera) 是 configure({camera}) 的别名 */
  attach(camera) { return this.configure({ camera }); }

  /**
   * 取得相机写权限（独占）。这是唯一的 owner 变更入口。
   * 切换 owner 不打断正在进行的过渡——过渡是 rig 内部状态机，新 owner 可随时
   * 用 blendTo/restore 从当前姿态平滑接续，避免「切 owner 瞬间相机卡半路」。
   * @param {string} key 唯一标识（如 'lobby' / 'carousel' / 'ferris-cabin'）
   * @returns {boolean} 是否成功（key 非法或已 dispose 返回 false）
   */
  setOwner(key) {
    if (this._disposed) { this._warn('setOwner: 已 dispose'); return false; }
    if (typeof key !== 'string' || key.length === 0) { this._warn('setOwner: key 必须是非空字符串'); return false; }
    this._owner = key;
    return true;
  }

  /**
   * 释放写权限。只有当前 owner 本人（或当前无人持有时）可释放。
   * 释放后 owner=null，所有写操作被拒，直到下一个 setOwner。
   * @param {string} key
   * @returns {boolean}
   */
  releaseOwner(key) {
    if (this._owner !== null && this._owner !== key) {
      this._warn(`releaseOwner: 当前 owner=${this._owner}，不能由 ${key} 释放`);
      return false;
    }
    this._owner = null;
    return true;
  }

  /**
   * 把【当前】相机位姿存入以 key 命名的槽位（底层无条件覆盖，无法分辨当前是
   * 大厅机位 / 嵌入锚点 / 回位过渡的中间插值姿态）。
   *
   * ⚠️ 调用方须自行门控 save 时机，否则会污染槽位：
   *   - 嵌入 A→B 互切时相机停在 A 的锚点，此时 save('lobby') 会把 A 锚点误存为
   *     大厅机位，退出 restore 再也回不到大厅 —— 应只在「从大厅态进入」时刷新；
   *   - restore 回位过渡尚未结束时相机是中间插值姿态，也不应覆盖已存的大厅槽位。
   *   （FacilityRuntime.activate 已按此门控：`!hasSlot || (fromLobby && !isTransitioning)`）
   * T07/T08 接入新设施若自定义 save 流程，请复用同一门控，勿无条件 save。
   *
   * @param {string} key
   * @param {string} [ownerHint] 可选：声明调用方 owner；与当前 owner 不符则拒绝
   * @returns {boolean}
   */
  save(key, ownerHint = null) {
    if (!this._canWrite(ownerHint)) return false;
    if (typeof key !== 'string' || key.length === 0) { this._warn('save: key 必须是非空字符串'); return false; }
    const cam = this.camera;
    this._slots.set(key, {
      position: cam.position.clone(),
      quaternion: cam.quaternion.clone(),
      up: cam.up.clone(),
      rotationOrder: cam.rotation.order,
      fov: cam.fov,
    });
    return true;
  }

  /**
   * 读取槽位姿态快照（clone，防止外部改内部状态）。
   * @param {string} key
   * @returns {{position:THREE.Vector3,quaternion:THREE.Quaternion,up:THREE.Vector3,rotationOrder:string,fov:number}|null}
   */
  getPose(key) {
    const s = this._slots.get(key);
    if (!s) return null;
    return {
      position: s.position.clone(),
      quaternion: s.quaternion.clone(),
      up: s.up.clone(),
      rotationOrder: s.rotationOrder,
      fov: s.fov,
    };
  }

  /**
   * 从当前姿态平滑过渡到目标姿态（设施「进入=换相机」用这个）。
   * 目标可为 position+quaternion，或 position+lookAt（由 rig 算 quaternion）。
   * 缺省字段沿用当前相机值。过渡中途重复调用会从当前姿态平滑接续，无跳变。
   * @param {{position?:*,quaternion?:*,lookAt?:*,up?:*,fov?:number,rotationOrder?:string,owner?:string}} pose
   * @param {number} [duration=0.8] 秒；<=0 表示立即到位（不产生过渡）
   * @returns {boolean} 是否被接受（非 owner / 无 owner / 已 dispose 返回 false）
   */
  blendTo(pose = {}, duration = 0.8) {
    if (!pose || typeof pose !== 'object') { this._warn('blendTo: pose 必须是对象'); return false; }
    const ownerHint = pose.owner ?? null;
    if (!this._canWrite(ownerHint)) return false;
    const target = this._resolveTarget(pose);
    return this._startTransition(target, duration);
  }

  /**
   * 登记一个允许「受控直写」的 owner key。必须在首帧 writePose 之前调用（幂等）。
   * 未登记者调用 writePose 会被拒绝并告警——从机制上杜绝"偷偷多一个相机写者"。
   * @param {string} key 与 setOwner 同一个 key（如 'lobby-driving'）
   */
  allowDirectWrite(key) {
    if (typeof key !== 'string' || key.length === 0) { this._warn('allowDirectWrite: key 必须是非空字符串'); return false; }
    this._directWriters.add(key);
    return true;
  }

  /**
   * 【受控直写】立即把位姿写到相机，不产生过渡——专供"每帧跟随"型 owner：
   * 驾驶舱逐帧跟随 Rapier 刚体、动物园飞行逐帧 lerp。这类场景若走 blendTo
   * 会因 0.8s 过渡严重滞后目标，故提供这条受仲裁的即时通道。
   *
   * 与「裸写 camera.position / lookAt」的区别（这正是本方法存在的意义）：
   *   ① 必须持有 owner 且已 allowDirectWrite 登记，否则拒绝并告警；
   *   ② pose.owner 必须与实际 owner 一致（双重校验，防错写）；
   *   ③ 全部向量/四元数走模块级临时对象，热路径零分配；
   *   ④ 每次写入记入审计（directWriteCount / directWriters），可验收。
   *
   * pose 字段：position（必须）、quaternion | lookAt（二选一）、up、fov、
   * rotationOrder。与 blendTo 的 pose 同构，缺省字段沿用相机当前值。
   * @param {{position:*,quaternion?:*,lookAt?:*,up?:*,fov?:number,rotationOrder?:string,owner?:string}} pose
   * @returns {boolean} 是否被接受
   */
  writePose(pose = {}) {
    if (!pose || typeof pose !== 'object') { this._warn('writePose: pose 必须是对象'); return false; }
    const ownerHint = pose.owner ?? null;
    if (!this._canWrite(ownerHint)) return false;
    if (!this._directWriters.has(this._owner)) {
      this._warn(`受控直写被拒：当前 owner "${this._owner}" 未调用 allowDirectWrite 登记`);
      return false;
    }

    const cam = this.camera;
    if (pose.position != null && typeof pose.position !== 'function') {
      _readVec3(pose.position, _TMP_V1, cam.position.x, cam.position.y, cam.position.z);
      cam.position.copy(_TMP_V1);
    }
    if (pose.up != null && typeof pose.up !== 'function') {
      _readVec3(pose.up, _TMP_V2, cam.up.x, cam.up.y, cam.up.z);
      if (_TMP_V2.lengthSq() > 1e-8) cam.up.copy(_TMP_V2).normalize();
    }
    if (pose.rotationOrder && cam.rotation.order !== pose.rotationOrder) cam.rotation.order = pose.rotationOrder;
    if (pose.fov != null && Math.abs(cam.fov - pose.fov) > 1e-6) { cam.fov = pose.fov; cam.updateProjectionMatrix(); }
    // 朝向：quaternion 优先，其次 lookAt（相机 -Z 指向目标）。零分配，复用模块级临时对象。
    if (pose.quaternion != null && typeof pose.quaternion !== 'function') {
      if (Array.isArray(pose.quaternion)) {
        _TMP_Q.set(pose.quaternion[0] ?? 0, pose.quaternion[1] ?? 0, pose.quaternion[2] ?? 0, pose.quaternion[3] ?? 1);
      } else {
        _TMP_Q.set(pose.quaternion.x ?? 0, pose.quaternion.y ?? 0, pose.quaternion.z ?? 0, pose.quaternion.w ?? 1);
      }
      if (_TMP_Q.lengthSq() > 1e-8) cam.quaternion.copy(_TMP_Q.normalize());
    } else if (pose.lookAt != null && typeof pose.lookAt !== 'function') {
      _readVec3(pose.lookAt, _TMP_V2, cam.position.x, cam.position.y, cam.position.z - 1);
      _TMP_Q.setFromRotationMatrix(_TMP_MAT.lookAt(cam.position, _TMP_V2, cam.up));
      cam.quaternion.copy(_TMP_Q);
    }

    this._directWriteCount += 1;
    return true;
  }

  /**
   * 从当前姿态平滑插值回某个已存槽位（设施「退出=回大厅」用这个）。
   * 槽位不存在时拒绝并返回 false。
   * @param {string} key
   * @param {number} [duration=0.8]
   * @param {string} [ownerHint] 可选 owner 声明
   * @returns {boolean}
   */
  restore(key, duration = 0.8, ownerHint = null) {
    if (!this._canWrite(ownerHint)) return false;
    const slot = this._slots.get(key);
    if (!slot) { this._warn(`restore: 槽位 ${key} 不存在`); return false; }
    // 用 clone 作为目标，避免过渡逻辑持有 Map 内部对象引用
    return this._startTransition({
      position: slot.position.clone(),
      quaternion: slot.quaternion.clone(),
      up: slot.up.clone(),
      rotationOrder: slot.rotationOrder,
      fov: slot.fov,
    }, duration);
  }

  /**
   * 每帧驱动姿态插值（由 main.js frameDriver 调用；T03 接线，本类不改 main.js）。
   * dt<=0 / 非有限值时保持当前姿态（暂停帧不推进、不跳变）。幂等。
   * @param {number} [dt=0] 帧间隔秒
   * @returns {this}
   */
  update(dt = 0) {
    if (this._disposed || !this.camera) return this;
    const tr = this._transition;
    if (!tr) return this;
    if (!Number.isFinite(dt) || dt <= 0) return this; // 无时间推进：保持当前姿态

    tr.elapsed += dt;
    const raw = tr.elapsed / tr.duration;
    if (raw >= 1) {
      this._apply(tr.to);          // 结束帧精确落到目标，消除累积误差
      this._transition = null;
      return this;
    }

    // smoothstep：两端速度为 0，防眩晕、无突变
    const k = raw * raw * (3 - 2 * raw);
    const cam = this.camera;
    cam.position.lerpVectors(tr.from.position, tr.to.position, k);
    cam.quaternion.slerpQuaternions(tr.from.quaternion, tr.to.quaternion, k);
    cam.up.lerpVectors(tr.from.up, tr.to.up, k);
    if (cam.up.lengthSq() < 1e-8) cam.up.copy(tr.to.up); // 退化保护（up 近乎相反）
    cam.up.normalize();

    if (Math.abs(tr.to.fov - tr.from.fov) > 1e-6) {
      const fov = tr.from.fov + (tr.to.fov - tr.from.fov) * k;
      if (Math.abs(cam.fov - fov) > 1e-6) { cam.fov = fov; cam.updateProjectionMatrix(); }
    }
    // rotationOrder 是离散值，不插值；过渡期间统一用目标 order（四元数已定，视觉无变化）
    if (cam.rotation.order !== tr.to.rotationOrder) cam.rotation.order = tr.to.rotationOrder;
    return this;
  }

  /**
   * 清理：清槽位、清过渡、释放 owner、解绑相机。幂等。
   * scene / camera / renderer 归 SceneManager 所有，本类只解引用、不 dispose。
   */
  dispose() {
    this._slots.clear();
    this._transition = null;
    this._owner = null;
    this.camera = null;
    this._disposed = true;
  }

  /* ---------------------------------------------------------------------- */
  /* 内部                                                                    */
  /* ---------------------------------------------------------------------- */

  /** 写权限校验：已 dispose / 未注入相机 / 无 owner / owner 声明不符 → 拒绝 */
  _canWrite(ownerHint = null) {
    if (this._disposed) { this._warn('写操作被拒：已 dispose'); return false; }
    if (!this.camera) { this._warn('写操作被拒：未 configure({ camera })'); return false; }
    if (this._owner === null) { this._warn('写操作被拒：当前无 owner，请先 setOwner(key)'); return false; }
    if (ownerHint != null && ownerHint !== this._owner) {
      this._warn(`写操作被拒：owner 冲突（当前 owner=${this._owner}，声明=${ownerHint}）`);
      return false;
    }
    return true;
  }

  /**
   * 解析目标位姿：缺省字段沿用当前相机；lookAt → quaternion（相机 -Z 朝目标）。
   * 【防御】一律 clone 向量：① 不修改调用方对象（up.normalize 曾会原地改外部 Vector3）；
   * ② 过渡目标不被外部每帧复用的 anchor 对象漂移（设施座舱动画常原地改同一个 Vector3）。
   * 忽略 Object3D.lookAt() 方法——它会被 toVector3 误当成 (0,0,0) 目标导致朝向错误。
   */
  _resolveTarget(pose) {
    const cam = this.camera;
    const position = pose.position != null ? toVector3(pose.position).clone() : cam.position.clone();
    const up = pose.up != null ? toVector3(pose.up).clone().normalize() : cam.up.clone();
    const rotationOrder = pose.rotationOrder ?? cam.rotation.order;
    const fov = pose.fov != null ? pose.fov : cam.fov;
    let quaternion;
    if (pose.quaternion != null && typeof pose.quaternion !== 'function') {
      // quaternion 是权威朝向（T03 的 IEmbeddedView anchor 必填字段）；lookAt 仅在无 quaternion 时推算
      quaternion = toQuaternion(pose.quaternion).clone().normalize();
    } else if (pose.lookAt != null && typeof pose.lookAt !== 'function') {
      // Matrix4.lookAt 生成 +Z 背离 target 的基，即相机 -Z 指向 target（标准相机语义）
      quaternion = new THREE.Quaternion().setFromRotationMatrix(
        _TMP_MAT.lookAt(position, toVector3(pose.lookAt).clone(), up)
      );
    } else {
      quaternion = cam.quaternion.clone();
    }
    return { position, quaternion, up, rotationOrder, fov };
  }

  /**
   * 启动一次过渡。起点永远取【相机当前姿态】→ 中途新 blendTo 平滑接续、无跳变。
   * duration<=0 时立即到位（不产生 isTransitioning 状态）。
   * @returns {boolean}
   */
  _startTransition(to, duration) {
    const cam = this.camera;
    const from = {
      position: cam.position.clone(),
      quaternion: cam.quaternion.clone(),
      up: cam.up.clone(),
      rotationOrder: cam.rotation.order,
      fov: cam.fov,
    };
    const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (d === 0) { this._apply(to); return true; }
    this._transition = { from, to, elapsed: 0, duration: d };
    return true;
  }

  /** 立即把位姿应用到相机（瞬移 / 过渡收尾）；不改 scene 背景雾、不 add 到 Group */
  _apply(pose) {
    const cam = this.camera;
    cam.position.copy(pose.position);
    cam.quaternion.copy(pose.quaternion);
    cam.up.copy(pose.up);
    if (cam.rotation.order !== pose.rotationOrder) cam.rotation.order = pose.rotationOrder;
    if (cam.fov !== pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix(); }
  }

  _warn(msg) { console.warn(`[CameraRig] ${msg}`); }
}

export const cameraRig = CameraRig.getInstance();
export default cameraRig;
