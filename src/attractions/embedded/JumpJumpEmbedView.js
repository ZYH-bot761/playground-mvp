/**
 * ============================================================================
 * JumpJumpEmbedView.js —— 跳一跳嵌入视图（v4 T08b，复用大厅、不建独立场景）
 * ============================================================================
 * 用户第 12 项：「跳一跳不要进去就是另外的界面，就在大厅环境里跳，要真实、
 * 不突兀」。旧 JumpJump.js 的 init() 会换 scene.background/fog、自建天空穹顶
 * 与地面、独立相机与全屏 UI —— 进入后是完全割裂的场景。本视图改为
 * IEmbeddedView：复用唯一 SceneContext.scene 里 Lobby 常驻的天空/地面/光照/
 * 昼夜/NPC，只在 propsRoot 下建方块池 + 玩家，把相机放进跳跳区。
 *
 * 【与 IEmbeddedView 六条硬禁令】
 *   不改 scene.background/fog；不建天空/地面；不碰 Lobby._shared/根节点；
 *   只 track() 本视图独占资源（1 geo + 1 mat for 方块池 + buildCharacter 的
 *   geometries/materials），dispose() 幂等释放；update() 热路径零 new。
 *
 * 【玩法（复刻 JumpJump.js 的确定性抛物线，数学一致、精简掉彩蛋/特效）】
 *   长按蓄力 power=chargeT/CHARGE_MAX → 预计算落点（沿当前块→下一块方向）、
 *   抛物线插值 → 落地中心判定：落在块上 +1，中心(PERFECT_RATIO)连击 +2*combo。
 *   【落点确定性】完整抛物线一次性预计算后只做插值，同力度落点误差 0。
 *   方块池用确定性伪随机（固定 seed），同一次构建布局完全可复现（探针友好）。
 *
 * 【相机 / 防眩晕】
 *   getCameraAnchor 返回跳跳区第一人称机位（玩家后上方，能看到方块池+大厅）。
 *   朝向四元数无 roll（right 恒水平）。update 软跟随用已验证模式：
 *   cameraRig.isTransitioning 时跳过写相机，过渡结束后指数软跟随 k=1-exp(-8dt)。
 *
 * 【输入 / UI / 位置】
 *   长按蓄力：pointerdown/up（仅 renderer.domElement）+ 空格；仅 active 后监听、
 *   deactivate/dispose 解绑；与 cameraRig.isTransitioning 互斥。
 *   UI 极简：分数/连击/蓄力条/返回提示，非全屏遮罩（用户要"就在大厅环境里"），
 *   z-index 与 .lb-ui(20) 协调，dispose 移除。
 *   跳跳区保守坐标 (26,0,2) 一带（FACILITIES jump-jump trigger (26,6) 附近空地）；
 *   【M4 已重做】改为第一人称沿中轴主路跑酷，路线见 ROAD_POINTS。
 * ============================================================================
 */
import * as THREE from 'three';
import { IEmbeddedView } from './IEmbeddedView.js';
import { buildCharacter } from '../../utils/ProceduralCharacter.js';
import { cameraRig } from '../../core/CameraRig.js';

/** 设施 key（与 FacilityRuntime.register / main.js EMBEDDED_KEYS 一致） */
export const JUMP_JUMP_KEY = 'jump-jump';

/* ---- 玩法常量（与 JumpJump.js:18-26 完全一致） ---- */
const MIN_DIST = 0.5, MAX_DIST = 6.0;
const CHARGE_MAX = 2.0;
const G = 24;
const PERFECT_RATIO = 0.42;  // 【M4】中心宽容度放宽（旧 0.18 太苛刻，容易「跳不进去」）
const OK_RATIO = 1.12;       // 【M4】落脚台判定放宽到台面外沿（旧 0.95）
const AUTO_JUMP_DELAY = 0.42; // 落地后自动续跳间隔（跑酷连续跳跃）
const ROAD_STEP = 5;          // 相邻路点间距（m）
const AUTO_CHARGE = ((ROAD_STEP - MIN_DIST) / (MAX_DIST - MIN_DIST)) * CHARGE_MAX;

/* ---- 【M4】主路跑酷路线 -------------------------------------------------
 * 旧实现是「原地蓄力跳随机方块池 + 第三人称俯视机位」，用户要求改成
 * 「进入后第一视角、沿游乐园主路跑酷式连续跳跃」。
 * 路线沿 M2 派生的大厅中轴主路（大门 (0,15) → 广场 (0,0) → 世纪钟 (0,-4)
 * → 魔法牌屋 (0,-13)），做成一条闭合折线，方块是路上的落脚台：
 *   (0,12) → (0,7) → (0,2) → (0,-3) → (0,-8) → (0,-12)
 *   → (0,-8) → (0,-3) → (0,2) → (0,7) → 回到 (0,12)
 * 10 个固定路点 = 10 个方块，闭环循环，跑酷不会「跳到场景外」。 */
const ROAD_POINTS = Object.freeze([
  [0, 12], [0, 7], [0, 2], [0, -3], [0, -8],
  [0, -12], [0, -8], [0, -3], [0, 2], [0, 7],
]);
const ROAD_COUNT = ROAD_POINTS.length;
const BLOCK_POOL = ROAD_COUNT;  // 必须在 ROAD_COUNT 之后声明（避免 TDZ）
const BLOCK_SIZE = 2.6;      // 落脚台边长（放宽落地判定用）
const FIRST_PERSON_EYE = 1.35; // 第一人称眼高（贴着玩家头顶）
const CAM_FOV = 72;          // 跑酷视野更宽
const FOLLOW_K = 10;         // 指数软跟随
const LOOK_SENS = 0.0045;
const PITCH_LIMIT = 0.85;
const BANK_ZERO = new THREE.Vector3(0, 1, 0); // 相机 up 恒世界 +Y

/** 确定性伪随机（固定 seed，同一次构建布局可复现；不依赖 Math.random） */
function makeRng(seed = 20261111) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class JumpJumpEmbedView extends IEmbeddedView {
  constructor() {
    super();
    this.key = JUMP_JUMP_KEY;

    // 独占资源根节点（挂 propsRoot）
    /** @type {THREE.Group|null} */
    this.root = null;
    /** @type {THREE.InstancedMesh|null} */
    this._blocksMesh = null;
    /** @type {THREE.Group|null} buildCharacter 玩家 group */
    this._player = null;

    // 方块池数据（对象池，固定 BLOCK_POOL，零运行中 new）
    /** @type {Array<{x:number,z:number,y:number,size:number,active:boolean}>} */
    this._blocks = [];
    this._current = 0;
    this._next = 1;
    this._rng = makeRng();
    this._score = 0;
    this._combo = 0;
    this._maxCombo = 0;
    this._state = 'ready'; // ready | charging | jumping | falling
    this._chargeT = 0;
    this._jumpT = 0;
    this._jumpDur = 0;
    this._vSpeed = 0;
    this._fallT = 0;

    // 预分配复用向量（零每帧 new）
    this._tmpV = new THREE.Vector3();
    this._jumpFrom = new THREE.Vector3();
    this._jumpTo = new THREE.Vector3();
    this._playerPos = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._dummy = new THREE.Object3D();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._fwd = new THREE.Vector3();
    /** @type {{position:THREE.Vector3,quaternion:THREE.Quaternion,lookAt:THREE.Vector3,fov:number}} */
    this._anchor = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      lookAt: new THREE.Vector3(),
      fov: CAM_FOV,
    };

    // 环顾
    this._lookYaw = 0;
    this._lookPitch = -0.16;
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;
    this._listenersBound = false;
    this._spaceHeld = false;

    // UI / 输入绑定
    this._ui = null;
    this._el = null;
    this._styleEl = null;
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerUp = () => this._pointerUp();
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
  }

  get score() { return this._score; }
  get combo() { return this._combo; }
  get maxCombo() { return this._maxCombo; }
  get state() { return this._state; }
  get lookYaw() { return this._lookYaw; }
  get lookPitch() { return this._lookPitch; }
  /** 只读当前落点快照（探针验证确定性；预分配向量，勿长期持有） */
  get jumpTo() { return this._jumpTo; }
  /** 独占资源计数（探针验证台账） */
  get ownedResourceCount() { return this._disposables.size; }

  /**
   * 注入共享上下文：只在 propsRoot 下建方块池 + 玩家（绝不碰 scene.background/fog /
   * Lobby._shared），绑输入（仅 active 生效）、建极简 UI。
   * @param {Object} ctx FacilityRuntime._ctx
   * @returns {this}
   */
  init(ctx) {
    super.init(ctx);
    this.root = new THREE.Group();
    this.root.name = 'JumpJumpEmbedView/root';
    const propsRoot = ctx?.propsRoot ?? ctx?.sceneContext?.propsRoot ?? null;
    if (propsRoot) propsRoot.add(this.root);

    this._buildBlocks();
    this._buildPlayer();
    this._buildUI();
    this._bindInput();

    this._rng = makeRng();
    this._resetGame();
    this._updateAnchor();
    return this;
  }

  /** 方块池：1 个 InstancedMesh + 1 geo + 1 mat，全部 track() */
  _buildBlocks() {
    const geo = this.track(new THREE.BoxGeometry(1, 1, 1));
    const mat = this.track(new THREE.MeshStandardMaterial({
      color: 0xffb648, roughness: 0.62, metalness: 0.08, flatShading: true,
    }));
    this._blocksMesh = new THREE.InstancedMesh(geo, mat, BLOCK_POOL);
    this._blocksMesh.name = 'JumpJumpEmbedView/blocks';
    this._blocksMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._blocksMesh.castShadow = false;
    this._blocksMesh.receiveShadow = true;
    this.root.add(this._blocksMesh);
    for (let i = 0; i < BLOCK_POOL; i += 1) {
      this._blocks.push({ x: 0, z: 0, y: 0, size: 1, active: false });
    }
  }

  /** 玩家：buildCharacter 的独占 geometries/materials 全部 track() */
  _buildPlayer() {
    const rig = buildCharacter({
      style: 'jumper',
      scale: 0.66,
      name: 'JumpJumpEmbedView/player',
      palette: {
        coat: 0x2b3038, pants: 0x252a31, skin: 0xe8bd94,
        hair: 0x241c18, shoe: 0x1b1e24,
        hairStyle: 'short', sleeve: 'long', accessory: 'none',
      },
    });
    for (const g of rig.userData.disposables.geometries) this.track(g);
    for (const m of rig.userData.disposables.materials) this.track(m);
    this._player = rig;
    this.root.add(rig);
  }

  /** 极简 UI：非全屏遮罩，z-index 22（高于 .lb-ui 20，低于暂停菜单），pointer-events 仅按钮 */
  _buildUI() {
    const style = document.createElement('style');
    style.id = 'jj-embed-ui-style';
    style.textContent = `
      .jj-embed{position:fixed;inset:0;z-index:22;pointer-events:none;
        font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#10202f}
      .jj-embed .hud{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));left:16px;
        display:flex;gap:14px;align-items:center;padding:8px 14px;border-radius:12px;
        background:rgba(255,255,255,.82);border:1px solid rgba(40,60,90,.18);font-weight:800}
      .jj-embed .score{font-size:22px;color:#e0653a;font-variant-numeric:tabular-nums}
      .jj-embed .combo{font-size:14px;color:#2b6cb0}
      .jj-embed .charge{position:absolute;bottom:calc(52px + env(safe-area-inset-bottom,0px));
        left:50%;transform:translateX(-50%);width:min(360px,46vw);height:12px;border-radius:8px;
        background:rgba(0,0,0,.2);overflow:hidden;opacity:0;transition:opacity .15s}
      .jj-embed .charge>i{display:block;height:100%;width:0;
        background:linear-gradient(90deg,#ffd24a,#ff7a3a)}
      .jj-embed .hint{position:absolute;bottom:calc(12px + env(safe-area-inset-bottom,0px));
        left:50%;transform:translateX(-50%);font-size:12px;padding:5px 12px;border-radius:999px;
        background:rgba(16,32,47,.6);color:#eaf2ff;white-space:nowrap}
      .jj-embed .back{pointer-events:auto;position:absolute;top:calc(14px + env(safe-area-inset-top,0px));
        right:16px;padding:8px 14px;border:0;border-radius:10px;cursor:pointer;
        font-size:13px;font-weight:700;color:#10202f;background:rgba(255,255,255,.9)}
    `;
    document.head.appendChild(style);
    this._styleEl = style;

    const ui = document.createElement('div');
    ui.className = 'jj-embed';
    ui.innerHTML = `
      <div class="hud"><span class="score" id="jj-embed-score">0</span><span class="combo" id="jj-embed-combo"></span></div>
      <button class="back" id="jj-embed-back">返回大厅</button>
      <div class="charge" id="jj-embed-charge"><i id="jj-embed-bar"></i></div>
      <div class="hint">第一人称主路跑酷 · 自动连续跳跃 · 空格/长按可手动蓄力 · 落中心连击翻倍</div>`;
    document.body.appendChild(ui);
    this._ui = ui;
    this._el = {
      score: ui.querySelector('#jj-embed-score'),
      combo: ui.querySelector('#jj-embed-combo'),
      charge: ui.querySelector('#jj-embed-charge'),
      bar: ui.querySelector('#jj-embed-bar'),
      back: ui.querySelector('#jj-embed-back'),
    };
    this._onBack = () => this.ctx?.runtime?.deactivate?.();
    this._el.back.addEventListener('click', this._onBack);
  }

  _bindInput() {
    const dom = this.ctx?.renderer?.domElement ?? this.ctx?.sceneContext?.renderer?.domElement ?? null;
    if (dom && !this._listenersBound) {
      dom.addEventListener('pointerdown', this._onPointerDown);
      dom.addEventListener('pointerup', this._onPointerUp);
      dom.addEventListener('pointercancel', this._onPointerUp);
      dom.addEventListener('pointermove', this._onPointerMove);
      this._dom = dom;
    }
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this._listenersBound = true;
  }

  _unbindInput() {
    if (this._dom) {
      this._dom.removeEventListener('pointerdown', this._onPointerDown);
      this._dom.removeEventListener('pointerup', this._onPointerUp);
      this._dom.removeEventListener('pointercancel', this._onPointerUp);
      this._dom.removeEventListener('pointermove', this._onPointerMove);
      this._dom = null;
    }
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this._listenersBound = false;
  }

  /* ==================== 玩法（复刻 JumpJump 数学） ==================== */

  /** 【M4】沿主路固定路点铺 10 个落脚台，闭环循环；只改已有对象，零 new */
  _resetGame() {
    this._score = 0; this._combo = 0; this._maxCombo = 0;
    this._state = 'ready'; this._chargeT = 0; this._jumpT = 0;
    for (let i = 0; i < ROAD_COUNT; i += 1) {
      const b = this._blocks[i];
      b.x = ROAD_POINTS[i][0];
      b.z = ROAD_POINTS[i][1];
      b.size = BLOCK_SIZE;
      b.y = BLOCK_SIZE / 2;
      b.active = true;
    }
    this._current = 0;
    this._next = 1 % ROAD_COUNT;
    // 【M4】进入即自动续跳（不需要玩家先按键），从源头修「无法进入/卡在 ready」
    this._state = 'charging';
    this._autoT = AUTO_JUMP_DELAY;
    this._chargeT = AUTO_CHARGE;
    this._syncInstances();
    this._placePlayerOnBlock(this._blocks[this._current]);
    this._syncHud();
  }

  /** 【M4】主路闭环：下一块 = (current+1) % ROAD_COUNT，不再随机生成 */
  _spawnNext() {
    this._current = this._next;
    this._next = (this._current + 1) % ROAD_COUNT;
  }

  /** 把固定路点写入 InstancedMesh（世界坐标 = 路点，无 POOL_ORIGIN 偏移） */
  _syncInstances() {
    for (let i = 0; i < this._blocks.length; i += 1) {
      const b = this._blocks[i];
      if (b.active) {
        this._dummy.position.set(b.x, b.y, b.z);
        this._dummy.scale.set(b.size, b.size, b.size);
      } else {
        this._dummy.position.set(0, -50, 0); // 移出视野
        this._dummy.scale.set(0.001, 0.001, 0.001);
      }
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.updateMatrix();
      this._blocksMesh.setMatrixAt(i, this._dummy.matrix);
    }
    this._blocksMesh.instanceMatrix.needsUpdate = true;
  }

  _placePlayerOnBlock(b) {
    this._playerPos.set(b.x, b.size, b.z);
    this._player.position.copy(this._playerPos);
    this._player.scale.set(1, 1, 1);
    this._player.rotation.set(0, 0, 0);
  }

  /**
   * 【M4】蓄力 → 落点。修复「跳不进去」：旧实现让玩家自己猜力度，
   * 落点方向与距离和下一个固定路点无关。现在蓄力只控制「跳多远」，
   * 方向永远锁定下一个落脚台；力度不足会落在台前（失败），充足则上台。
   */
  _releaseJump() {
    if (this._state !== 'charging') return false;
    this._state = 'jumping';
    if (this._el) this._el.charge.style.opacity = '0';
    const power = Math.min(this._chargeT / CHARGE_MAX, 1);
    const distance = MIN_DIST + power * (MAX_DIST - MIN_DIST);
    const cur = this._blocks[this._current];
    const nxt = this._blocks[this._next];
    this._tmpV.set(nxt.x - cur.x, 0, nxt.z - cur.z);
    if (this._tmpV.lengthSq() < 1e-6) this._tmpV.set(0, 0, -1);
    this._tmpV.normalize();
    this._jumpTo.set(cur.x + this._tmpV.x * distance, 0, cur.z + this._tmpV.z * distance);
    this._jumpFrom.set(cur.x, cur.size, cur.z);
    this._jumpDur = 0.55 + power * 0.35;
    this._vSpeed = 0.5 * G * this._jumpDur;
    this._jumpT = 0;
    this._player.scale.set(1, 1, 1);
    return true;
  }

  /** 落地判定：落脚台判定放宽 + 中心连击；落稳后自动续跳形成连续跑酷 */
  _land() {
    const nxt = this._blocks[this._next];
    const dx = this._jumpTo.x - nxt.x;
    const dz = this._jumpTo.z - nxt.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const r = nxt.size / 2;
    if (d <= r * OK_RATIO) {
      this._playerPos.set(this._jumpTo.x, nxt.size, this._jumpTo.z);
      this._player.position.copy(this._playerPos);
      this._player.rotation.set(0, 0, 0);
      if (d <= r * PERFECT_RATIO) {
        this._combo += 1;
        this._score += Math.min(this._combo * 2, 32);
      } else {
        this._score += 1;
        this._combo = 0;
      }
      this._maxCombo = Math.max(this._maxCombo, this._combo);
      this._current = this._next;
      this._next = (this._current + 1) % ROAD_COUNT;
      this._syncHud();
      // 【M4】自动续跳：落地后 0.42s 自动蓄满刚好够到下一台的力度
      this._state = 'charging';
      this._autoT = AUTO_JUMP_DELAY;
      this._chargeT = AUTO_CHARGE;
    } else {
      this._combo = 0;
      this._state = 'falling';
      this._fallT = 1.0;
      this._syncHud();
    }
  }

  _syncHud() {
    if (!this._el) return;
    this._el.score.textContent = String(this._score);
    this._el.combo.textContent = this._combo > 0 ? `${this._combo} 连击` : '';
  }

  /* ==================== 输入（仅 active，过渡互斥） ==================== */

  _inputAllowed() { return this._active && !this._disposed && !cameraRig.isTransitioning; }

  /** 【M4】手动蓄力：自动续跳期间按空格可打断，接管力度（不会卡在 ready） */
  _press() {
    if (!this._inputAllowed()) return false;
    if (this._state === 'ready') {
      this._state = 'charging';
      this._chargeT = 0;
      this._autoT = 0;
      if (this._el) this._el.charge.style.opacity = '1';
      return true;
    }
    if (this._state === 'charging' && this._autoT > 0) {
      this._autoT = 0;                 // 玩家接管：取消自动续跳倒计时
      this._chargeT = 0;
      if (this._el) this._el.charge.style.opacity = '1';
      return true;
    }
    return false;
  }
  _release() {
    if (!this._inputAllowed()) return false;
    return this._releaseJump();
  }
  _pointerDown(e) {
    if (!this._inputAllowed()) return;
    this._dragging = true;
    this._lastX = e.clientX ?? 0;
    this._lastY = e.clientY ?? 0;
    this._press();
  }
  _pointerUp() {
    if (!this._dragging) return;
    this._dragging = false;
    this._release();
  }
  _pointerMove(e) {
    if (!this._active || !this._dragging || cameraRig.isTransitioning) return;
    const dx = (e.clientX ?? 0) - this._lastX;
    const dy = (e.clientY ?? 0) - this._lastY;
    this._lastX = e.clientX ?? 0;
    this._lastY = e.clientY ?? 0;
    // 拖动超过阈值视为环顾（不误触蓄力落点）；蓄力中也允许小幅环顾看大厅
    this.addLook(-dx * LOOK_SENS, -dy * LOOK_SENS);
  }
  _keyDown(e) {
    const k = e.key?.toLowerCase();
    if (k === ' ' || k === 'spacebar') {
      e.preventDefault();
      if (!this._spaceHeld) { this._spaceHeld = true; this._press(); }
    }
  }
  _keyUp(e) {
    const k = e.key?.toLowerCase();
    if (k === ' ' || k === 'spacebar') { this._spaceHeld = false; this._release(); }
  }

  /** 环顾入口（供拖拽与探针）：过渡期拒绝；yaw 累加、pitch 限幅、无 roll */
  addLook(yawDelta, pitchDelta) {
    if (this._disposed || cameraRig.isTransitioning) return false;
    this._lookYaw += Number.isFinite(yawDelta) ? yawDelta : 0;
    const p = this._lookPitch + (Number.isFinite(pitchDelta) ? pitchDelta : 0);
    this._lookPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
    this._updateAnchor();
    return true;
  }

  /* ==================== 相机锚点 / 每帧 ==================== */

  /** 【M4】真第一人称机位：眼睛就在玩家头顶，朝向下一块落脚台（主路前进方向） */
  _updateAnchor() {
    const px = this._playerPos.x, pz = this._playerPos.z;
    const nxt = this._blocks[this._next];
    // 视线锁定下一落脚台；没有下一块时回退到主路 -Z 方向
    const dx = nxt ? nxt.x - px : 0;
    const dz = nxt ? nxt.z - pz : -1;
    const baseYaw = Math.atan2(-dx, -dz);
    this._anchor.position.set(px, this._playerPos.y + FIRST_PERSON_EYE, pz);
    this._euler.set(this._lookPitch, baseYaw + this._lookYaw, 0, 'YXZ');
    this._anchor.quaternion.setFromEuler(this._euler);
    this._fwd.set(0, 0, -1).applyQuaternion(this._anchor.quaternion);
    this._anchor.lookAt.copy(this._anchor.position).add(this._fwd);
    this._anchor.fov = CAM_FOV;
  }

  /**
   * @returns {{position:THREE.Vector3,quaternion:THREE.Quaternion,lookAt:THREE.Vector3,fov:number}}
   */
  getCameraAnchor() {
    this._updateAnchor();
    return {
      position: this._anchor.position.clone(),
      quaternion: this._anchor.quaternion.clone(),
      lookAt: this._anchor.lookAt.clone(),
      fov: this._anchor.fov,
    };
  }

  /**
   * 每帧：驱动蓄力/抛物线/落地/掉落 + 玩家姿态 + 相机软跟随。
   * 硬约束：热路径零 new；过渡期不写相机。
   * @param {number} dt 秒
   * @returns {this}
   */
  update(dt = 0) {
    if (this._disposed || !this._active) return this;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;

    if (this._state === 'charging' && step > 0) {
      // 【M4】落地后自动续跳：倒计时结束自动松手，形成沿主路连续跑酷
      if (this._autoT > 0) {
        this._autoT -= step;
        if (this._autoT <= 0) { this._autoT = 0; this._releaseJump(); }
      } else {
        this._chargeT = Math.min(this._chargeT + step, CHARGE_MAX);
      }
      const p = this._chargeT / CHARGE_MAX;
      this._player.scale.set(1 + p * 0.18, 1 - p * 0.22, 1 + p * 0.18); // 蓄力压扁
      if (this._el) this._el.bar.style.width = `${p * 100}%`;
    } else if (this._state === 'jumping' && step > 0) {
      this._jumpT += step;
      const u = Math.min(this._jumpT / this._jumpDur, 1);
      const lx = this._jumpFrom.x + (this._jumpTo.x - this._jumpFrom.x) * u;
      const lz = this._jumpFrom.z + (this._jumpTo.z - this._jumpFrom.z) * u;
      const h = this._vSpeed * this._jumpT - 0.5 * G * this._jumpT * this._jumpT;
      const nxtSize = this._blocks[this._next].size;
      this._playerPos.set(lx, this._jumpFrom.y + (nxtSize - this._jumpFrom.y) * u + Math.max(h, 0), lz);
      this._player.position.copy(this._playerPos);
      this._player.rotation.y = Math.atan2(this._jumpTo.x - this._jumpFrom.x, this._jumpTo.z - this._jumpFrom.z);
      if (this._jumpT >= this._jumpDur) this._land();
    } else if (this._state === 'falling' && step > 0) {
      this._fallT -= step;
      this._playerPos.y -= step * 6;
      this._player.position.copy(this._playerPos);
      this._player.rotation.x += step * 4;
      if (this._fallT <= 0) { this._resetGame(); }
    }

    this._updateAnchor();

    // 相机软跟随：过渡期跳过（与 cameraRig 单一仲裁互斥）
    if (!cameraRig.isTransitioning && step > 0) {
      const cam = this.ctx?.camera ?? null;
      if (cam) {
        const k = 1 - Math.exp(-FOLLOW_K * step);
        cam.position.lerp(this._anchor.position, k);
        cam.quaternion.slerp(this._anchor.quaternion, k);
        cam.up.copy(BANK_ZERO); // 恒世界上，无 roll
        if (cam.fov !== this._anchor.fov) { cam.fov = this._anchor.fov; cam.updateProjectionMatrix(); }
      }
    }
    return this;
  }

  activate() {
    super.activate();
    if (this.root) this.root.visible = true;
    if (this._ui) this._ui.style.display = '';
    this._dragging = false;
    this._spaceHeld = false;
    // 【M4】每次进入都从主路起点重新自动跑酷，避免停在上一局的 ready/卡死态
    this._resetGame();
    return this;
  }

  deactivate() {
    super.deactivate();
    if (this.root) this.root.visible = false;
    if (this._ui) this._ui.style.display = 'none';
    this._dragging = false;
    this._spaceHeld = false;
    this._state = 'ready';
    if (this._el) this._el.charge.style.opacity = '0';
    return this;
  }

  /**
   * 幂等清理：解绑输入、移除 UI/DOM、释放 track() 的全部独占资源（方块池 geo/mat +
   * buildCharacter 的 geo/mat）、root 从 propsRoot 摘除。不碰 Lobby._shared/背景雾/轮盘。
   */
  dispose() {
    if (this._disposed) return;
    this._unbindInput();
    if (this._el?.back && this._onBack) this._el.back.removeEventListener('click', this._onBack);
    if (this._ui) { this._ui.remove(); this._ui = null; }
    if (this._styleEl) { this._styleEl.remove(); this._styleEl = null; }
    this._el = null;
    // super.dispose() 会释放 _disposables 并把 root 从父节点摘除
    super.dispose();
    this._blocksMesh = null;
    this._player = null;
    this._blocks.length = 0;
  }
}

export default JumpJumpEmbedView;
