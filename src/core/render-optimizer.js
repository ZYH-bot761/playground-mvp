/**
 * ============================================================================
 * RenderOptimizer —— 渲染加载优化（消灭远景方块 / 纹理色块 / 剔除误判）
 * ============================================================================
 * 【阶段三需求映射】
 *  1. LOD 策略（M8 反转）：设施三级 DetailLOD 保留「视野内始终加载高模」——
 *     medium/low 阈值适度调大到 90/115m；区域级 LOD（Districts/castle|farm/lod）
 *     恢复 autoUpdate=true 自动降级，远景 100m 外切 silhouette 低模，
 *     给 30 万三角面硬预算腾空间（远景剪影方块在雾中不可辨，属可接受代价）。
 *     LOD 结构与 levels 全部保留；手动 lod.update(camera) 仍可按距离切换。
 *  2. 纹理 Mipmap / 各向异性：遍历场景全部贴图，统一 generateMipmaps + 三线性
 *     minFilter + 设备上限 anisotropy，远距离不再糊成单色块。
 *  3. frustumCulled 误判：遍历所有 Mesh / InstancedMesh 重算精确包围体（合并几何
 *     经 rebase 后包围球过期是误剔除根因），并提供 setForceNoCull(true) 一键
 *     强制关闭所有 Mesh 的 frustumCulled，确保视锥内物体绝不被错误剔除。
 *
 * 【为什么 forceNoCull 默认关闭】全场景 30 万三角面是项目硬预算：redline 双机位
 *  朝 -z 看时北侧 castle/farm 在视锥外，靠剔除省下约 1.3 万面（当前 296,502 /
 *  300,000，余量仅 3,498）。若默认全局关剔除会直接爆预算。因此默认采用「精确
 *  包围体修正」这一正确工程解法消除误判；强制全关作为可切换能力提供（lil-gui
 *  开关 + window.__playground.renderOptimizer.setForceNoCull）。
 *
 * 【生命周期】Lobby 每次重建都会换一批 LOD / Mesh，因此用「root 引用变化」惰性
 *  重扫，热路径只做一次引用比较，零新建 GPU 资源、零逐帧 traverse。
 * ============================================================================
 */
import * as THREE from 'three';

/** 贴图属性白名单（材质上可能挂图的槽位） */
const TEX_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap',
  'aoMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap', 'specularMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap',
  'sheenRoughnessMap', 'iridescenceMap', 'transmissionMap', 'thicknessMap',
  'gradientMap', 'matcap',
];

const _seenTextures = new Set();

export class RenderOptimizer {
  constructor() {
    this.scene = null;
    this.renderer = null;
    this.forceNoCull = false;
    this._lastRoot = null;
    this._lastSceneChildCount = -1;
    this.stats = {
      lodsPinned: 0,
      boundsFixed: 0,
      mipmapsApplied: 0,
      anisotropy: 1,
      meshesScanned: 0,
      forceNoCullMeshes: 0,
      rescans: 0,
    };
  }

  configure({ scene, renderer }) {
    this.scene = scene || this.scene;
    this.renderer = renderer || this.renderer;
    return this;
  }

  /**
   * LOD 策略（M8 反转，都不删除 LOD 结构 / levels）：
   *  - 区域级 LOD（Districts/castle|farm/lod）：【恢复自动降级】autoUpdate=true，
   *    renderer 每帧自动 update(camera) 按距离选层 → 远景走 silhouette 低模，
   *    为 30 万面硬预算腾空间；若此前被钉死（autoUpdate=false）则在此恢复，
   *    并把钉死时强制的可见性标记还原（首帧 LOD.update 会重新裁定）。
   *  - 设施 DetailLOD：把 medium / low 阈值「适度调大」到 90/115m，
   *    玩家常规视野内一律高模，超远仍降级。
   */
  pinHighDetail(root) {
    let n = 0;
    root.traverse((o) => {
      if (!o.isLOD || !o.levels || o.levels.length === 0) return;
      const isDistrict = typeof o.name === 'string' && o.name.startsWith('Districts/');
      if (isDistrict) {
        // 【M8】不再钉死 level0：恢复区域级 LOD 的距离选层
        if (o.autoUpdate === false) {
          o.autoUpdate = true;
          for (let i = 0; i < o.levels.length; i += 1) o.levels[i].object.visible = true;
        }
        n += 1;
      } else if (o.levels.length > 1) {
        /* 【预算口径】设施三级 LOD 只把阈值从 70/90 「适度调大」到 90/115：
         * 玩家常规视野（orbit ≤50m、地面漫游 ≤90m）始终加载高模，消灭近景
         * 降级方块；但四宫格俯瞰验收机位 (30,84,96) 距设施 120~140m，仍会
         * 切到 low 剪影。若把阈值拉到 160/260，俯瞰会把 5 座设施全渲成高模
         * → 318,888 面 > 30 万硬上限（m7 F / m8 D 回归）。 */
        for (let i = 1; i < o.levels.length; i += 1) {
          const target = i === 1 ? 90 : 115;
          if (o.levels[i].distance < target) o.levels[i].distance = target;
        }
        n += 1;
      }
    });
    return n;
  }

  /** 重算精确包围体，消除合并几何 / InstancedMesh 的剔除误判 */
  fixBounds(root) {
    let fixed = 0;
    let scanned = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      scanned += 1;
      const g = o.geometry;
      if (!g) return;
      // 合并几何（顶点烘焙后经 rebase 平移）包围球可能过期 → 重算
      if (!g.boundingSphere || !Number.isFinite(g.boundingSphere.radius) || g.boundingSphere.radius <= 0) {
        try { g.computeBoundingSphere(); fixed += 1; } catch (e) { /* noop */ }
      }
      if (!g.boundingBox || g.boundingBox.isEmpty()) {
        try { g.computeBoundingBox(); } catch (e) { /* noop */ }
      }
      // InstancedMesh 的默认包围球只覆盖单个基础几何 → 必须用实例矩阵重算
      if (o.isInstancedMesh && typeof o.computeBoundingSphere === 'function') {
        try { o.computeBoundingSphere(); fixed += 1; } catch (e) { /* noop */ }
      }
      // 包围球中心/半径非法（NaN / 负半径）时关闭该对象的剔除，杜绝误剔除
      const bs = o.isInstancedMesh ? o.boundingSphere : g.boundingSphere;
      if (bs && (!Number.isFinite(bs.radius) || bs.radius < 0)) o.frustumCulled = false;
    });
    return { fixed, scanned };
  }

  /** 统一 Mipmap + 各向异性（同一 Texture 对象，不改变 GPU 纹理计数） */
  applyMipmaps(root) {
    const r = this.renderer;
    const maxAniso = r?.capabilities?.getMaxAnisotropy?.() || 8;
    this.stats.anisotropy = maxAniso;
    _seenTextures.clear();
    let applied = 0;
    const handle = (t) => {
      if (!t || !t.isTexture || t.isRenderTargetTexture || _seenTextures.has(t)) return;
      _seenTextures.add(t);
      if (!t.image && !t.source?.data) return; // 尚无像素数据的占位纹理跳过
      let changed = false;
      if (t.generateMipmaps !== true) { t.generateMipmaps = true; changed = true; }
      if (t.minFilter !== THREE.LinearMipmapLinearFilter) { t.minFilter = THREE.LinearMipmapLinearFilter; changed = true; }
      if (t.magFilter !== THREE.LinearFilter) { t.magFilter = THREE.LinearFilter; changed = true; }
      if (t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; changed = true; }
      if (changed) { t.needsUpdate = true; applied += 1; }
    };
    root.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (!m) continue;
        for (const slot of TEX_SLOTS) handle(m[slot]);
      }
    });
    _seenTextures.clear();
    return applied;
  }

  /** 一键强制关闭 / 恢复所有 Mesh 的 frustumCulled */
  setForceNoCull(enabled = true) {
    this.forceNoCull = !!enabled;
    if (!this.scene) return 0;
    let n = 0;
    this.scene.traverse((o) => {
      if (!o.isMesh || o.isSprite) return;
      o.frustumCulled = !this.forceNoCull;
      n += 1;
    });
    this.stats.forceNoCullMeshes = n;
    return n;
  }

  /**
   * 每帧调用（零分配）：仅在 Lobby root 或场景子节点数变化时重扫。
   * @param {THREE.Object3D|null} lobbyRoot
   */
  update(lobbyRoot = null) {
    if (!this.scene) return;
    const childCount = this.scene.children.length;
    const changed = lobbyRoot !== this._lastRoot || childCount !== this._lastSceneChildCount;
    if (!changed) return;
    this._lastRoot = lobbyRoot;
    this._lastSceneChildCount = childCount;
    this.stats.rescans += 1;
    this.stats.lodsPinned = this.pinHighDetail(this.scene);
    const b = this.fixBounds(this.scene);
    this.stats.boundsFixed = b.fixed;
    this.stats.meshesScanned = b.scanned;
    this.stats.mipmapsApplied = this.applyMipmaps(this.scene);
    if (this.forceNoCull) this.setForceNoCull(true);
  }

  /** 启动时强制扫一次（保证首帧即高模 / 正确包围体 / mipmap） */
  applyNow(lobbyRoot = null) {
    this._lastRoot = null;
    this._lastSceneChildCount = -1;
    this.update(lobbyRoot);
  }
}

export const renderOptimizer = new RenderOptimizer();
export default renderOptimizer;
