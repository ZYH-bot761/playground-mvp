/**
 * ============================================================================
 * NPCManager.js —— 第八部分：迎宾 NPC 与动态人群（全局单例 / v4 T10 升级）
 * ============================================================================
 * 10 个【真实比例 7.3 头身】游客：头发、五官、两段式四肢、皮带/鞋袜/衣领。
 *
 * 【性能（验收：10 个 NPC 仍 60fps 且 ≤2 draw call）】
 *  - 全系统只有【1 个 InstancedMesh】：由 ProceduralCharacter 把身体 + 头 +
 *    四肢 + 五官合并成【一张共享 BufferGeometry】，5 类主色以 4 个
 *    InstancedBufferAttribute 传入 → 10 个 NPC 服装/肤色各异却只占 1 draw call。
 *  - 走路摆臂/摆腿、迎宾挥手、张望、呼吸摆动全部在 vertex shader 里按
 *    aMeta 关节编号 + aPivot 旋转中心完成；CPU 每帧只写 10×4 个 aAnim 浮点
 *    与 10 个 instanceMatrix，零 new、零 GC。
 *  - MeshBasicMaterial 不受光照，夜间也可见（旧版同款取舍）；顶点色已烘焙
 *    方向光/高光/AO，因此不是纯色剪纸。castShadow=false → 不进 shadow pass。
 *  - 远离相机 >45m 的 NPC 暂停位置/状态机更新（矩阵保持）。
 *  - root 常驻 scene（不打 attractionRoot 标记），预热前上传 → 计入基线。
 *
 * 【为什么不用 Rapier 刚体（与提示词的取舍）】
 *  Lobby 的既定架构是「全程禁用 Rapier」（见 Lobby.js 头部契约与 dispose 里
 *  刚体数 0 的断言）。为 10 个纯装饰 NPC 引入物理会破坏该约束。这里改用
 *  【建筑真实 AABB 避障 + 脚底贴地】实现等效效果，零物理开销。
 *
 * 【避障数据源】
 *  Lobby.init() 调 setObstacles(this._buildingBoxes)。过滤 noBlock:true ——
 *  那是「可穿行的开放门廊/帐篷」，只用于玩家阻挡，不是实体墙。
 * ============================================================================
 */
import * as THREE from 'three';
import { buildNPCCharacter, NPC_SCALE } from './procedural-character.js';

export const NPC_COUNT = 10;
const GREETER_COUNT = 4;          // 入口迎宾（挥手）：4 人一排，余下 6 人为巡游通勤者
const WALK_MIN = 0.5, WALK_MAX = 1.5;
const SEPARATION = 1.05;         // 最小间距（排斥力）
const CULL_DIST2 = 45 * 45;      // 超过 45m 暂停动画
const ARENA_MIN_R = 7, ARENA_MAX_R = 27;
const PAD = 0.7;                 // AABB 外扩（NPC 半径）
/** 【M3】导航图参数：2.4m 网格，八邻域，线段不穿 AABB 才连边 */
const NAV_RADIUS = 31;           // 合法活动半径（M7 四宫格可 setBounds 扩展）
const NAV_STEP = 2.4;
const NAV_LINK_MAX = NAV_STEP * 1.5;
const NAV_EDGE_SAMPLES = 5;      // 每条候选边的中点采样数（防斜穿墙角）
const NAV_RETRY_MAX = 8;
/** 【阶段二·模块 3】前瞻探测距离（m）：贴墙走时提前换向，避免蹭墙 */
const LOOKAHEAD = 1.2;
/** 换向冷却（s）：防止「探测→换向→再探测」每帧抖动 */
const RETARGET_COOLDOWN = 0.6;

const ST = Object.freeze({ WALK: 0, IDLE: 1, LOOK: 2, WAVE: 3 });

/** 衣服调色板：低饱和、互不雷同，避免「AI 感」的高饱和糖果色 */
const OUTFITS = [
  { coat: 0x8a5a44, pants: 0x3d4652 },
  { coat: 0x3f5b7a, pants: 0x464a52 },
  { coat: 0x6b6f52, pants: 0x3f444c },
  { coat: 0x7a4a5c, pants: 0x44404a },
  { coat: 0x4a6b6a, pants: 0x3b464b },
  { coat: 0x8a7048, pants: 0x4a4650 },
  { coat: 0x555f7a, pants: 0x3e4650 },
  { coat: 0x6a5570, pants: 0x42404e },
  { coat: 0x4e6b4c, pants: 0x3f4843 },
  { coat: 0x7a5a3f, pants: 0x484348 },
];
const SKIN = [0xe8bd94, 0xd9a97e, 0xf0cba4, 0xc99a72];
const HAIR = [0x3a2b22, 0x241c18, 0x6b4a2a, 0x1e1b19];

/** 确定性伪随机，避免每次热更新人群布局全变 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

class NPCManagerImpl {
  constructor() {
    this._inited = false;
    this._disposed = false;
    this._scene = null;
    this._camera = null;
    this._root = null;
    this._mesh = null;        // 唯一 InstancedMesh（1 draw call）
    this._char = null;        // buildNPCCharacter 返回的几何/材质/属性集
    this._anim = null;        // aAnim InstancedBufferAttribute
    this._geometries = [];
    this._materials = [];

    this._active = false;
    this._contextKey = null;
    this._obstacles = [];
    this._npcs = [];
    this._time = 0;

    /* 【M3】导航图：障碍变化时一次性重建，update 热路径只做 BFS + 读路径，
     * 绝不新建 geometry / material / texture，也不每帧分配对象。 */
    this._navRadius = NAV_RADIUS;
    this._navNodes = [];    // [{x,z,nb:Int32Array}] 合法采样点 + 邻接
    this._navGrid = null;   // Map<gridKey, nodeIndex>
    this._navDirty = true;
    this._bfsPrev = null;   // Int32Array，BFS 复用
    this._bfsQueue = null;  // Int32Array，BFS 复用
    this._navStats = { nodes: 0, edges: 0, rebuilds: 0, blockedRetargets: 0 };

    // 复用临时对象
    this._dummy = new THREE.Object3D();
    this._tmpV = new THREE.Vector3();
  }

  /** 幂等初始化；必须在预热 renderOnce 之前调用，资源计入基线 */
  init({ scene, camera }) {
    if (this._inited || this._disposed) return this;
    if (!scene || !camera) return this;
    this._scene = scene;
    this._camera = camera;

    // ① 一张合并几何体 + 一个材质 + 5 个实例属性（4 调色板 + 1 动画）
    const char = buildNPCCharacter({ count: NPC_COUNT });
    this._char = char;
    this._anim = char.attributes.aAnim;
    this._geometries.push(char.geometry);
    this._materials.push(char.material);

    const mesh = new THREE.InstancedMesh(char.geometry, char.material, NPC_COUNT);
    mesh.name = 'NPCManager/characters';
    mesh.frustumCulled = false;   // 实例分布广，避免整批被误剔除
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;      // 1 draw call：不产生 shadow pass 绘制
    mesh.receiveShadow = false;
    this._mesh = mesh;

    this._root = new THREE.Group();
    this._root.name = 'NPCManager/global';
    this._root.add(mesh);
    this._scene.add(this._root);

    // ② 人群状态 + 逐实例调色板
    const rand = rng(20261110);
    for (let i = 0; i < NPC_COUNT; i++) {
      const greeter = i < GREETER_COUNT;
      // 迎宾固定在大门内侧两边，其余在环带随机撒点
      const a = rand() * Math.PI * 2;
      const r = ARENA_MIN_R + rand() * (ARENA_MAX_R - ARENA_MIN_R);
      const x = greeter ? [-4.4, -2.2, 2.2, 4.4][i] : Math.cos(a) * r;
      const z = greeter ? 10.5 : Math.sin(a) * r;
      this._npcs.push({
        x, z,
        yaw: greeter ? Math.PI : a + Math.PI,
        speed: WALK_MIN + rand() * (WALK_MAX - WALK_MIN),
        state: greeter ? ST.WAVE : ST.WALK,
        stateT: greeter ? 1.2 + rand() * 2 : 0,
        targetX: x, targetZ: z,
        /** 【M3】BFS 路径（节点索引）与当前段序号；热路径只读，不新建对象 */
        path: null, pathIdx: 0,
        bob: rand() * Math.PI * 2,
        lookDir: rand() < 0.5 ? -1 : 1,
        wavePhase: rand() * Math.PI * 2,
        greeter,
        visible: true,
        // 动画权重：状态切换时缓动，避免走路↔站立、挥手↔放下瞬间跳变
        walkMix: greeter ? 0 : 1,
        waveMix: 0,
      });
      char.setOutfit(i, {
        ...OUTFITS[i % OUTFITS.length],
        skin: SKIN[i % SKIN.length],
        hair: HAIR[i % HAIR.length],
      });
    }
    char.flushPalette();

    // 一进场就走动：先建一次导航图，再给非迎宾 NPC 派发目标点
    this._rebuildNav();
    for (const n of this._npcs) if (!n.greeter) this._pickTarget(n, rand);

    // 初始写一次矩阵（含 aAnim），保证预热帧能看到并上传
    this._writeMatrices(0);
    this._inited = true;
    console.info(
      `[NPCManager] 初始化完成 | NPC=${NPC_COUNT} 迎宾=${GREETER_COUNT} | ` +
      `draw call=1 (InstancedMesh=${this.renderMeshCount}) | ` +
      `三角面/人≈${Math.round((char.geometry.index?.count || char.geometry.attributes.position.count) / 3)}`
    );
    return this;
  }

  /**
   * Lobby 每次重建都会产生新的 AABB 数组，需重新注入。
   * 【关键】过滤 noBlock:true —— 那是「可穿行的开放门廊 / 帐篷」，
   * 只用于玩家阻挡判定，不是实体墙。
   */
  setObstacles(boxes) {
    this._obstacles = Array.isArray(boxes) ? boxes.filter((b) => !b.noBlock && b.minX !== undefined) : [];
    this._navDirty = true;
    // 【M3】障碍一变就重建导航图；再把「出生在障碍里」的 NPC 挪到最近合法点
    if (this._inited && this._obstacles.length) {
      this._rebuildNav();
      for (const n of this._npcs) {
        if (!this._blocked(n.x, n.z)) continue;
        if (this._relocate(n) && n.greeter) { n.targetX = n.x; n.targetZ = n.z; }
        else if (!n.greeter) this._pickTarget(n, Math.random);
      }
    }
    return this;
  }

  /** M7 四宫格扩建时扩大合法活动半径；只重建导航图，不创建任何 GPU 资源 */
  setBounds(radius) {
    const r = Number(radius);
    if (!Number.isFinite(r) || r < 12 || Math.abs(r - this._navRadius) < 0.01) return this;
    this._navRadius = r;
    this._navDirty = true;
    if (this._inited) this._rebuildNav();
    return this;
  }

  /** 仅在大厅显示并更新；切到其它设施立即隐藏 + 停止计算 */
  setContext(key) {
    this._contextKey = key;
    this._active = key === 'lobby';
    if (this._root) this._root.visible = this._active;
    return this;
  }

  get isActive() { return this._active; }
  get count() { return this._npcs.length; }
  /** 供验收读取导航图规模 / 重建次数（证明寻路不依赖直线猜测） */
  get navStats() { return { ...this._navStats }; }
  /** 供验收脚本读取：NPC 渲染所用的 InstancedMesh 数量（= draw call 数） */
  get renderMeshCount() { return this._mesh ? 1 : 0; }
  get instancedMesh() { return this._mesh; }
  get palette() { return this._char; }

  /* --------------------------- 寻路辅助 --------------------------- */
  _blocked(x, z) {
    for (const b of this._obstacles) {
      if (x > b.minX - PAD && x < b.maxX + PAD && z > b.minZ - PAD && z < b.maxZ + PAD) return true;
    }
    // 合法活动边界（M7 四宫格可用 setBounds 扩展）
    return Math.hypot(x, z) > this._navRadius;
  }

  /** 目标从导航图节点里选：天然合法，且已算好一条不穿墙的最短路 */
  _pickTarget(n, rand) {
    const nodes = this._navNodes;
    if (!nodes.length) {
      if (this._navDirty) this._rebuildNav();
      if (!this._navNodes.length) { n.targetX = n.x; n.targetZ = n.z; n.path = null; return; }
    }
    const list = this._navNodes;
    for (let tries = 0; tries < NAV_RETRY_MAX; tries += 1) {
      const p = list[(rand() * list.length) | 0];
      if (Math.hypot(p.x - n.x, p.z - n.z) < ARENA_MIN_R * 0.55) continue;
      n.targetX = p.x;
      n.targetZ = p.z;
      n.path = this._findPath(n.x, n.z, p.x, p.z);
      n.pathIdx = 0;
      return;
    }
    n.targetX = n.x; n.targetZ = n.z; n.path = null; n.pathIdx = 0;
  }

  /* --------------------------- 导航图（M3） --------------------------- */

  /** 线段是否穿过障碍：中点采样，防止斜穿墙角 */
  _segmentBlocked(x0, z0, x1, z1) {
    for (let s = 1; s <= NAV_EDGE_SAMPLES; s += 1) {
      const t = s / (NAV_EDGE_SAMPLES + 1);
      if (this._blocked(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return true;
    }
    return false;
  }

  _gridKey(ix, iz) { return ix * 4096 + iz; }

  /** 障碍变化时重建一次：网格采样合法点 + 八邻域，边不穿 AABB 才连 */
  _rebuildNav() {
    this._navDirty = false;
    const R = this._navRadius;
    const S = NAV_STEP;
    const nodes = [];
    const grid = new Map();
    const n = Math.ceil(R / S);
    for (let ix = -n; ix <= n; ix += 1) {
      for (let iz = -n; iz <= n; iz += 1) {
        const x = ix * S, z = iz * S;
        if (this._blocked(x, z)) continue;
        grid.set(this._gridKey(ix, iz), nodes.length);
        nodes.push({ x, z, nb: null });
      }
    }
    const links = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i += 1) links[i] = [];
    let edgeCount = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      const gx = Math.round(a.x / S), gz = Math.round(a.z / S);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oz = -1; oz <= 1; oz += 1) {
          if (ox === 0 && oz === 0) continue;
          const j = grid.get(this._gridKey(gx + ox, gz + oz));
          if (j === undefined || j <= i) continue;
          const b = nodes[j];
          if (Math.hypot(a.x - b.x, a.z - b.z) > NAV_LINK_MAX) continue;
          if (this._segmentBlocked(a.x, a.z, b.x, b.z)) continue;
          links[i].push(j);
          links[j].push(i);
          edgeCount += 1;
        }
      }
    }
    for (let i = 0; i < nodes.length; i += 1) nodes[i].nb = Int32Array.from(links[i]);
    this._navNodes = nodes;
    this._navGrid = grid;
    this._bfsPrev = new Int32Array(nodes.length);
    this._bfsQueue = new Int32Array(nodes.length);
    this._navStats = {
      nodes: nodes.length, edges: edgeCount,
      rebuilds: (this._navStats?.rebuilds || 0) + 1,
      blockedRetargets: this._navStats?.blockedRetargets || 0,
      radius: R,
    };
  }

  _nearestNode(x, z) {
    const nodes = this._navNodes;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      const dx = nodes[i].x - x, dz = nodes[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** BFS 最短路，返回节点索引数组（运行期复用 Int32Array 缓冲，零新建对象） */
  _findPath(sx, sz, tx, tz) {
    if (this._navDirty || !this._navNodes.length) this._rebuildNav();
    const nodes = this._navNodes;
    const s = this._nearestNode(sx, sz);
    const t = this._nearestNode(tx, tz);
    if (s < 0 || t < 0 || s === t) return null;
    const prev = this._bfsPrev, queue = this._bfsQueue;
    prev.fill(-1);
    let head = 0, tail = 0;
    queue[tail++] = s;
    prev[s] = s;
    while (head < tail && prev[t] < 0) {
      const cur = queue[head++];
      const nb = nodes[cur].nb;
      for (let k = 0; k < nb.length; k += 1) {
        const next = nb[k];
        if (prev[next] >= 0) continue;
        prev[next] = cur;
        queue[tail++] = next;
        if (next === t) break;
      }
    }
    if (prev[t] < 0) return null;
    const path = [];
    let cur = t;
    while (cur !== s) { path.push(cur); cur = prev[cur]; }
    path.reverse();
    return path.length ? Int32Array.from(path) : null;
  }

  /** 卡进障碍时强制挪到最近合法导航点（修「只露头手」） */
  _relocate(n) {
    const idx = this._nearestNode(n.x, n.z);
    if (idx < 0) return false;
    const p = this._navNodes[idx];
    n.x = p.x; n.z = p.z;
    n.targetX = p.x; n.targetZ = p.z;
    n.path = null; n.pathIdx = 0;
    return true;
  }

  /* --------------------------- 每帧 --------------------------- */
  update(dt) {
    if (!this._inited || this._disposed || !this._active) return;
    const d = Math.min(Math.max(dt, 0), 0.1);
    this._time += d;
    const rand = Math.random;
    const cam = this._camera.position;

    for (let i = 0; i < this._npcs.length; i++) {
      const n = this._npcs[i];
      const dx = cam.x - n.x, dz = cam.z - n.z;
      const far = dx * dx + dz * dz > CULL_DIST2;
      if (far) { n.visible = false; continue; } // 远处暂停更新（矩阵保持）
      n.visible = true;

      n.stateT -= d;

      if (n.greeter) {
        // 迎宾：原地周期性挥手（WAVE ↔ IDLE），不巡游
        if (n.stateT <= 0) {
          if (n.state === ST.WAVE) { n.state = ST.IDLE; n.stateT = 1.5 + rand() * 2.0; }
          else { n.state = ST.WAVE; n.stateT = 2.0 + rand() * 2.5; }
        }
        n.bob += d * 3.4;
        continue;
      }

      // 【M3】每帧先做合法性体检：一旦卡进建筑立即挪到最近导航点。
      // 这是「只露头手 / 卡进墙里」的根治点 —— 旧实现 trapped 时反而允许
      // 继续朝目标走，导致越陷越深。
      if (this._blocked(n.x, n.z)) {
        if (this._relocate(n)) n.path = null;
      }
      if (this._navDirty) this._rebuildNav();

      if (n.state === ST.WALK) {
        // 沿 BFS 路径逐点走；路径点本身合法、相邻点之间不穿 AABB
        if (n.path && n.pathIdx < n.path.length) {
          const p = this._navNodes[n.path[n.pathIdx]];
          if (p) {
            n.targetX = p.x;
            n.targetZ = p.z;
            if (Math.hypot(p.x - n.x, p.z - n.z) < 0.6) n.pathIdx += 1;
          } else {
            n.path = null;
          }
        }
        const tx = n.targetX - n.x, tz = n.targetZ - n.z;
        const dist = Math.hypot(tx, tz);
        if (dist < 0.55) {
          // 到达 → 停留（IDLE）或张望（LOOK）
          n.state = rand() < 0.55 ? ST.LOOK : ST.IDLE;
          n.stateT = 2.0 + rand() * 3.0;
          n.path = null;
        } else {
          let vx = (tx / dist) * n.speed;
          let vz = (tz / dist) * n.speed;
          // 排斥力：与其它 NPC 保持最小间距，避免重叠
          for (let j = 0; j < this._npcs.length; j++) {
            if (j === i) continue;
            const o = this._npcs[j];
            const rx = n.x - o.x, rz = n.z - o.z;
            const r2 = rx * rx + rz * rz;
            if (r2 > 0.0001 && r2 < SEPARATION * SEPARATION) {
              const r = Math.sqrt(r2);
              const push = (SEPARATION - r) / SEPARATION * 1.6;
              vx += (rx / r) * push;
              vz += (rz / r) * push;
            }
          }
          /* 【阶段二·模块 3】步进前三重防线（用户点名「行走前必须检测」）：
           * ① 整段位移线采样（复用建图 _segmentBlocked 口径，斜穿墙角也拦）；
           * ② 整段被挡 → 轴滑动（滑动分量同样做整段采样，而非只验终点）；
           * ③ 滑动也不通 → 立即换向重选目标（带 0.6s 冷却防抖动）。
           * 另加前瞻探测：贴墙走时提前 1.2m 换向，避免「蹭着墙走」。 */
          const nx = n.x + vx * d, nz = n.z + vz * d;
          let moved = false;
          if (!this._segmentBlocked(n.x, n.z, nx, nz)) {
            n.x = nx; n.z = nz;
            moved = true;
          } else if (!this._segmentBlocked(n.x, n.z, nx, n.z)) {
            n.x = nx;
            moved = true;
          } else if (!this._segmentBlocked(n.x, n.z, n.x, nz)) {
            n.z = nz;
            moved = true;
          } else {
            // 三面皆墙 → 换向：重算 BFS 路径 / 直接重选目标（防抖冷却统一在下一段递减）
            if ((n.retargetT || 0) <= 0) {
              this._navStats.blockedRetargets = (this._navStats.blockedRetargets || 0) + 1;
              n.path = this._findPath(n.x, n.z, n.targetX, n.targetZ);
              n.pathIdx = 0;
              if (!n.path) { this._relocate(n); this._pickTarget(n, rand); }
              n.retargetT = RETARGET_COOLDOWN;
            }
          }
          // 前瞻探测：沿当前速度方向看 1.2m，被挡且本帧正常移动 → 提前换向
          n.retargetT = (n.retargetT || 0) - d;
          if (moved && (n.retargetT || 0) <= 0) {
            const inv = 1 / Math.max(1e-5, Math.hypot(vx, vz));
            const ax = n.x + vx * inv * LOOKAHEAD;
            const az = n.z + vz * inv * LOOKAHEAD;
            if (this._segmentBlocked(n.x, n.z, ax, az)) {
              this._navStats.blockedRetargets = (this._navStats.blockedRetargets || 0) + 1;
              this._pickTarget(n, rand);
              n.retargetT = RETARGET_COOLDOWN;
            }
          }
          // 朝向行走方向（平滑）
          const want = Math.atan2(vx, vz);
          let diff = want - n.yaw;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          n.yaw += diff * Math.min(1, d * 6);
          n.bob += d * (6 + n.speed * 2);
        }
      } else if (n.state === ST.LOOK) {
        // 张望：原地左右转头（由 shader 的 HEAD 关节 yaw 偏移实现）
        n.bob += d * 1.2;
        if (n.stateT <= 0) { this._pickTarget(n, rand); n.state = ST.WALK; }
      } else if (n.state === ST.IDLE) {
        n.bob += d * 0.8;
        if (n.stateT <= 0) { this._pickTarget(n, rand); n.state = ST.WALK; }
      }
    }

    this._writeMatrices(d);
  }

  /**
   * 写 10 个实例矩阵 + 10×4 个 aAnim 浮点。
   * 身体整体只负责位置/朝向/步态起伏；摆臂摆腿/挥手/张望交给 vertex shader
   * 按 aMeta 关节编号绕 aPivot 旋转，因此不需要 10×N 个矩阵。
   * @param {number} dt 本帧时长；warmUp 传 0（只写矩阵不推进权重缓动）
   */
  _writeMatrices(dt) {
    const mesh = this._mesh;
    if (!mesh || !this._anim) return;
    const anim = this._anim.array;
    const d = this._dummy;
    const ease = dt > 0 ? Math.min(1, dt * 8) : 0;
    for (let i = 0; i < this._npcs.length; i++) {
      const n = this._npcs[i];
      const walking = n.state === ST.WALK;
      const waving = n.state === ST.WAVE;
      const looking = n.state === ST.LOOK;
      n.walkMix += ((walking ? 1 : 0) - n.walkMix) * ease;
      n.waveMix += ((waving ? 1 : 0) - n.waveMix) * ease;

      const bobY = walking ? Math.abs(Math.sin(n.bob)) * 0.055 : 0;
      const sway = walking ? Math.sin(n.bob) * 0.045 : waving ? Math.sin(n.bob * 1.6) * 0.075 : 0;
      const waveLift = waving ? 0.045 + Math.sin(n.bob * 1.6) * 0.045 : 0;

      // 角色几何体脚底在 y=0（旧版胶囊中心 0.74 的补偿已不需要）
      d.position.set(n.x, bobY + waveLift, n.z);
      d.rotation.set(0, n.yaw, sway);
      d.scale.setScalar(NPC_SCALE);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);

      const headYaw = looking ? Math.sin(this._time * 1.8 + n.wavePhase) * 0.6 * n.lookDir : 0;
      const o = i * 4;
      anim[o] = n.bob;        // 相位（走路摆动，与 bob 同步）
      anim[o + 1] = n.walkMix;
      anim[o + 2] = n.waveMix;
      anim[o + 3] = headYaw;  // LOOK 状态头部左右张望
    }
    mesh.instanceMatrix.needsUpdate = true;
    this._anim.needsUpdate = true;
    // shader 的呼吸/挥手抖动使用全局时钟（uniform，不额外占实例属性槽）
    if (this._char?.material?.userData?.timeUniform) {
      this._char.material.userData.timeUniform.value = this._time;
    }
  }

  /** 预热：把全部实例矩阵写一遍并上传，之后清回初态 */
  warmUp() {
    if (!this._inited) return this;
    this._writeMatrices(0);
    return this;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._root) {
      this._scene?.remove(this._root);
      this._root.clear();
      this._root = null;
    }
    for (const g of this._geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    this._geometries.length = 0;
    this._materials.length = 0;
    for (const n of this._npcs) { n.path = null; }
    this._npcs.length = 0;
    this._obstacles = [];
    // 【M3】导航图只占普通 JS 内存，dispose 一并清空，避免悬挂引用
    this._navNodes.length = 0;
    this._navGrid = null;
    this._bfsPrev = null;
    this._bfsQueue = null;
    this._navDirty = true;
    this._navStats = { nodes: 0, edges: 0, rebuilds: 0, blockedRetargets: 0 };
    this._mesh = this._char = this._anim = null;
    this._inited = false;
  }
}

/** 全局唯一实例 */
export const npcManager = new NPCManagerImpl();
export default npcManager;
