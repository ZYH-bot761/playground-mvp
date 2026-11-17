/**
 * ============================================================================
 * Zoo.js —— 游乐场旁的「完整动物园」（网页 Three.js 版）
 * ============================================================================
 * 与 Blender 交付的 zoo/playground_zoo.blend 保持同一套坐标：
 *   四区 x∈[32,88] / z∈[-26,26]，每区 26×24m，区间 4m，不重叠、紧邻游乐场。
 *   bird(45,14) 天蓝 / reptile(75,14) 土黄 / marine(45,-14) 深蓝 / mammal(75,-14) 草绿。
 *
 * 【接入方式】由 Lobby.init 通过 buildZoo() 挂到 Lobby.root 下；所有
 * geometry / material / texture 都通过 track* 回调登记进 Lobby 台账，
 * 因此 Lobby.dispose() 会成对释放，5 轮来回切换的 Δgeo=0 / Δtex=0 不受影响。
 *
 * 【零新建资源】update(t) 只改 instanceMatrix 与少量已有对象的属性；
 * 动物轨迹在 build 阶段一次性烘焙成 240 帧闭环（CYCLES 语义），
 * 播放时对烘焙表取模插值，轨迹严格首尾相接、零 GC 压力。
 *
 * 【动效】鸟类沿闭合椭圆环绕飞行 + 上下浮动 + 振翅；鱼群 boids
 * （分离 / 对齐 / 聚合 + 水体边界约束）；爬行贴地随机游走避围栏；
 * 哺乳漫步 + 间歇停顿。32 只动物全部低多边形、全部归入对应分区。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildNPCCharacter, NPC_SCALE } from '../utils/helpers/procedural-character.js';

/** 四区布局（世界坐标，x / z 对应 Blender 的 x / y） */
export const ZOO_LAYOUT = Object.freeze({
  bird_zone: {
    cx: 45, cz: 10, w: 26, h: 16, color: 0x70bff2,
    cn: '家禽区', en: 'POULTRY ZONE', kind: 'poultry', count: 12,
  },
  reptile_zone: {
    cx: 75, cz: 10, w: 26, h: 16, color: 0xc29b57,
    cn: '爬行区', en: 'REPTILE ZONE', kind: 'reptile', count: 4,
  },
  marine_zone: {
    cx: 45, cz: -14, w: 26, h: 24, color: 0x14408c,
    cn: '海洋区', en: 'MARINE ZONE', kind: 'fish', count: 15,
  },
  mammal_zone: {
    cx: 75, cz: -14, w: 26, h: 24, color: 0x4c9e47,
    cn: '哺乳区', en: 'MAMMAL ZONE', kind: 'mammal', count: 5,
  },
  safari_zone: {
    cx: 60, cz: -42, w: 56, h: 26, color: 0xd8b06a,
    cn: '非洲草原', en: 'SAFARI', kind: 'safari', count: 7,
  },
});

/**
 * 【阶段二·模块 3】用户点名四类主角：鸡、鸭、狗、鹅 —— 全部改用
 * 「球体(ico)/圆柱(cyl)/圆锥(cone)/方体(box)」五部件拼搭，每类独立 spec：
 *   家禽区 12 只 = 鸡 5（红冠+黄羽）/ 鸭 4（扁喙+长颈）/ 鹅 3（长颈+橙喙+大体型）
 *   哺乳区 5 只 = 狗 5（竖耳 + 摇尾 + 间歇停顿）
 *   爬行区 4 只 = 龟 4（硬壳 + 短腿，保留）
 *   海洋区 15 条 = 鱼 15（尾鳍集群，保留）
 * 分区：家禽 / 爬行 / 海洋 / 哺乳 四区 + 南侧草原展区（大象/长颈鹿/狮子/老虎）。
 * 部件级动画：头颈点头（啄食节奏）、双翅扇合、双腿交替、狗摇尾、长鼻/长颈/摆尾。
 * 新增大体型动物继续用 InstancedMesh 分关节绘制，几何复用 G.* 与 2 个斑纹合并几何。
 */
export const ZOO_SPECIES = Object.freeze(['鸡', '鸭', '鹅', '狗', '龟', '鱼', '大象', '长颈鹿', '狮子', '老虎']);
export const ZOO_TRAITS = Object.freeze({
  鸡: Object.freeze({ zone: 'bird_zone', count: 5, feature: '红冠 + 黄羽 + 短喙', color: 0xffd23f }),
  鸭: Object.freeze({ zone: 'bird_zone', count: 4, feature: '扁喙 + 长颈 + 白羽', color: 0xf2f7ff }),
  鹅: Object.freeze({ zone: 'bird_zone', count: 3, feature: '长颈 + 橙喙 + 大体型', color: 0xeaf4ff }),
  狗: Object.freeze({ zone: 'mammal_zone', count: 5, feature: '竖耳 + 摇尾 + 间歇停顿', color: 0xb9793f }),
  龟: Object.freeze({ zone: 'reptile_zone', count: 4, feature: '硬壳 + 短腿 + 缩头', color: 0x66c25a }),
  鱼: Object.freeze({ zone: 'marine_zone', count: 15, feature: '流线体 + 尾鳍集群', color: 0x59c9f2 }),
  大象: Object.freeze({ zone: 'safari_zone', count: 1, feature: '整根长鼻摆动 + 大耳 + 象牙', color: 0x8d8f94 }),
  长颈鹿: Object.freeze({ zone: 'safari_zone', count: 2, feature: '长颈摆动 + 斑纹 + 高腿', color: 0xd6a458 }),
  狮子: Object.freeze({ zone: 'safari_zone', count: 2, feature: '鬃毛 + 摆尾 + 漫步', color: 0xc89a52 }),
  老虎: Object.freeze({ zone: 'safari_zone', count: 2, feature: '橙色虎纹 + 白吻 + 长尾', color: 0xe07a2a }),
});
/** 围栏高度（m）：低于旧围栏的 1.8m，站在栏边可平视动物 */
export const ZOO_FENCE_HEIGHT = 1.2;

/** 动物园俯瞰机位（OrbitControls maxDistance=50，cam↔tgt 距离约 49.0） */
export const ZOO_VIEW = Object.freeze({
  cam: [60, 33, 24],
  tgt: [60, 2, -14],
});

const BASE_Y = 1.1;          // 分区地面顶面，高于远处草丘最大起伏 0.9m
const LOOP_FRAMES = 240;     // 240 帧闭环，与 Blender 版一致
const BLEND_FRAMES = 24;     // 末段插值回首帧，保证周期首尾相接
const LOOP_SECONDS = 10;     // 240 帧 @24fps

/* 【热点修复】update 每帧每只动物的局部旋转：原实现 new 闭包 + new 数组（32 只 × ~8 次/帧），
 * 改为写入模块级共享变量，零分配。 */
let _rotX = 0;
let _rotZ = 0;
function rotZInto(cy, sy, x, z) {
  _rotX = x * cy + z * sy;
  _rotZ = -x * sy + z * cy;
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function makeLabelTexture(cn, en, hex) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d');
  const css = '#' + hex.toString(16).padStart(6, '0');
  g.fillStyle = 'rgba(8,18,34,0.92)';
  g.beginPath();
  if (g.roundRect) g.roundRect(6, 6, 500, 148, 22);
  else g.rect(6, 6, 500, 148);
  g.fill();
  g.strokeStyle = css;
  g.lineWidth = 7;
  g.stroke();
  g.fillStyle = css;
  g.fillRect(24, 24, 10, 112);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#f4f9ff';
  g.font = 'bold 62px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.fillText(cn, 272, 66);
  g.fillStyle = css;
  g.font = 'bold 26px "Segoe UI", Arial, sans-serif';
  g.fillText(en, 272, 122);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.name = `Zoo/sign/${cn}`;
  return tex;
}

function lerp(a, b, k) { return a + (b - a) * k; }

/* -------------------------------------------------------------------------- */
/* 主体                                                                        */
/* -------------------------------------------------------------------------- */

export class Zoo {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.root              挂载父节点（Lobby.root）
   * @param {(g:THREE.BufferGeometry)=>any} o.trackGeometry
   * @param {(m:THREE.Material)=>any} o.trackMaterial
   * @param {(t:THREE.Texture)=>any} o.trackTexture
   */
  constructor({ root, trackGeometry, trackMaterial, trackTexture }) {
    this.root = root;
    this._trackGeometry = trackGeometry;
    this._trackMaterial = trackMaterial;
    this._trackTexture = trackTexture;

    this.group = null;
    this._animals = [];       // { kind, count, parts:[{mesh,...}], layout }
    this._traj = new Map();   // kind -> Float32Array(LOOP_FRAMES * count * 3)
    this._time = 0;
    this._visitor = null;
    this._visitorTime = 0;

    // 复用的矩阵 / 向量（update 中零分配）
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._sampleLocal = [0, 0, 0];
    this._sampleNext = [0, 0, 0];
    this._cf = 0;
  }

  _geo(g) { this._trackGeometry(g); return g; }
  _mat(m) { this._trackMaterial(m); return m; }
  _tex(t) { this._trackTexture(t); return t; }

  _basic(color, opts = {}) {
    return this._mat(new THREE.MeshBasicMaterial({ color, ...opts }));
  }

  _mesh(parent, name, geo, mat, px, py, pz, sx, sy, sz) {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.position.set(px, py, pz);
    m.scale.set(sx, sy, sz);
    m.frustumCulled = false;   // 远处草丘 / 实例包围盒不准，统一常驻渲染
    parent.add(m);
    return m;
  }

  build() {
    const G = {
      box: this._geo(new THREE.BoxGeometry(1, 1, 1)),
      ico: this._geo(new THREE.IcosahedronGeometry(1, 0)),   // 20 面
      cone: this._geo(new THREE.ConeGeometry(1, 1, 6)),      // 12 面
      cyl: this._geo(new THREE.CylinderGeometry(1, 1, 1, 8)), // 【模块 3】约 32 面：鸭/鹅长颈
      plane: this._geo(new THREE.PlaneGeometry(1, 1)),
    };
    this._G = G;

    const M = {
      fence: this._basic(0x6b4a2c),
      post: this._basic(0x4a3320),
      board: this._basic(0x141c30),
      water: this._basic(0x2f8fd8, {
        transparent: true, opacity: 0.24, depthWrite: false, side: THREE.DoubleSide,
      }),
      arch: this._basic(0x1d5f86),
      archTrim: this._basic(0x8fd8ff),
      bird: this._basic(0xffd23f),
      birdWing: this._basic(0xfff0a8),
      comb: this._basic(0xd83a2a),     // 【模块 3】鸡冠红
      beak: this._basic(0xf28c28),     // 【模块 3】喙橙（鸡/鸭/鹅通用）
      goose: this._basic(0xe8eef6),    // 【模块 3】鹅灰白
      reptile: this._basic(0x66c25a),
      reptileLeg: this._basic(0x3f8b3a),
      fish: this._basic(0x59c9f2),
      fishTail: this._basic(0xff9a4d),
      mammal: this._basic(0xb9793f),
      mammalLeg: this._basic(0x7d4c28),
      elephant: this._basic(0x8d8f94),
      elephantEar: this._basic(0xa3a5a6),
      ivory: this._basic(0xf1e2c2),
      giraffe: this._basic(0xd6a458),
      giraffeSpot: this._basic(0x7b4d24),
      lion: this._basic(0xc89a52),
      lionMane: this._basic(0x6e3c20),
      tiger: this._basic(0xe07a2a),
      tigerStripe: this._basic(0x241610),
      belly: this._basic(0xf3ead8),
      dark: this._basic(0x101820),
      white: this._basic(0xf2f7ff),
    };
    this._M = M;

    const root = new THREE.Group();
    root.name = 'Zoo/root';
    root.userData.zooRoot = true;
    this.group = root;
    this.root.add(root);

    for (const [key, z] of Object.entries(ZOO_LAYOUT)) {
      const zone = new THREE.Group();
      zone.name = `Zoo/${key}`;
      zone.userData.zoneKey = key;
      root.add(zone);
      this._buildZoneGround(zone, key, z, G, M);
      this._buildSign(zone, key, z, G, M);
      if (key === 'marine_zone') this._buildWater(zone, z, G, M);
      if (key === 'reptile_zone') this._buildRocks(zone, z, G, M);
      if (key === 'mammal_zone') this._buildTrees(zone, z, G, M);
      if (key === 'safari_zone') this._buildSavanna(zone, z, G, M);
    }

    this._buildFenceAll(G, M);
    this._buildEntryArch(root, G, M);
    this._bakeAllTrajectories();
    this._buildAnimals(G, M);
    this._buildVisitors(root);
    this.update(0);
    return this;
  }

  /* ---------------- 分区地面 ---------------- */
  _buildZoneGround(zone, key, z, G, M) {
    const mat = this._basic(z.color);
    // 厚台基：顶面 BASE_Y，底面 -0.7，压住远处草丘（最高约 0.9m）
    this._mesh(zone, `Zoo/${key}/ground`, G.box, mat,
      z.cx, BASE_Y - 0.9, z.cz, z.w, 1.8, z.h);
    // 内圈浅色描边，四区边界一眼可辨
    const rim = this._basic(0xffffff, { transparent: true, opacity: 0.16, depthWrite: false });
    this._mesh(zone, `Zoo/${key}/rim`, G.plane, rim,
      z.cx, BASE_Y + 0.012, z.cz, z.w - 0.8, z.h - 0.8, 1)
      .rotation.x = -Math.PI / 2;
  }

  /* ---------------- 围栏（全区合并为 2 个 InstancedMesh，仅 2 draw call） ---- */
  _buildFenceAll(G, M) {
    const posts = [];
    const rails = [];
    for (const z of Object.values(ZOO_LAYOUT)) {
      const x0 = z.cx - z.w / 2, x1 = z.cx + z.w / 2;
      const z0 = z.cz - z.h / 2, z1 = z.cz + z.h / 2;
      const nx = Math.max(2, Math.round(z.w / 2.6));
      const nz = Math.max(2, Math.round(z.h / 2.6));
      for (let i = 0; i <= nx; i += 1) {
        const x = lerp(x0, x1, i / nx);
        posts.push([x, z0], [x, z1]);
      }
      for (let i = 1; i < nz; i += 1) {
        const zz = lerp(z0, z1, i / nz);
        posts.push([x0, zz], [x1, zz]);
      }
      // 【M6】围栏降到 1.2m（旧 1.8m 挡视线），两道横杆随之收窄
      for (const h of [0.42, 0.92]) {
        rails.push([z.cx, z0, z.w, 0.13, h], [z.cx, z1, z.w, 0.13, h]);
        rails.push([x0, z.cz, 0.13, z.h, h], [x1, z.cz, 0.13, z.h, h]);
      }
    }
    const mk = (name, list, mat, kind) => {
      const im = new THREE.InstancedMesh(G.box, mat, list.length);
      im.name = name;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const mm = new THREE.Matrix4();
      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        if (kind === 'posts') mm.compose(
          new THREE.Vector3(a[0], BASE_Y + ZOO_FENCE_HEIGHT / 2, a[1]),
          new THREE.Quaternion(),
          new THREE.Vector3(0.22, ZOO_FENCE_HEIGHT, 0.22),
        );
        else mm.compose(
          new THREE.Vector3(a[0], BASE_Y + a[4], a[1]),
          new THREE.Quaternion(),
          new THREE.Vector3(a[2], 0.12, a[3]),
        );
        im.setMatrixAt(i, mm);
      }
      im.instanceMatrix.needsUpdate = true;
      this.group.add(im);
      return im;
    };
    mk('Zoo/fence-posts', posts, M.post, 'posts');
    mk('Zoo/fence-rails', rails, M.fence, 'rails');
  }

  /* ---------------- 文字标牌 ---------------- */
  _buildSign(zone, key, z, G, M) {
    const tex = this._tex(makeLabelTexture(z.cn, z.en, z.color));
    const mat = this._mat(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, alphaTest: 0.06, side: THREE.DoubleSide, fog: false,
      toneMapped: false,
    }));
    const zz = z.cz + z.h / 2 + 0.25;
    this._mesh(zone, `Zoo/${key}/sign-post-l`, G.box, M.post,
      z.cx - 6.2, BASE_Y + 1.15, zz, 0.26, 2.3, 0.26);
    this._mesh(zone, `Zoo/${key}/sign-post-r`, G.box, M.post,
      z.cx + 6.2, BASE_Y + 1.15, zz, 0.26, 2.3, 0.26);
    this._mesh(zone, `Zoo/${key}/sign-board`, G.box, M.board,
      z.cx, BASE_Y + 3.05, zz + 0.06, 13.2, 2.5, 0.22);
    // 俯瞰机位在 +Z 侧，PlaneGeometry 默认法线 +Z 正好朝向相机
    this._mesh(zone, `Zoo/${key}/sign-text`, G.plane, mat,
      z.cx, BASE_Y + 3.05, zz + 0.20, 12.8, 2.3, 1);
  }

  /* ---------------- 水体 / 岩石 / 树木 ---------------- */
  _buildWater(zone, z, G, M) {
    this._mesh(zone, 'Zoo/marine_zone/water', G.box, M.water,
      z.cx, BASE_Y + 1.55, z.cz, z.w - 2, 2.9, z.h - 2);
    const rim = this._basic(0x8fd8ff, { transparent: true, opacity: 0.5, depthWrite: false });
    this._mesh(zone, 'Zoo/marine_zone/water-surface', G.plane, rim,
      z.cx, BASE_Y + 3.01, z.cz, z.w - 2.2, z.h - 2.2, 1).rotation.x = -Math.PI / 2;
  }

  _buildRocks(zone, z, G, M) {
    const rock = this._basic(0x8a857a);
    for (const [dx, dz, r] of [[-6, -5, 1.3], [5, 4, 1.6], [2, -7, 1.0]]) {
      this._mesh(zone, 'Zoo/reptile_zone/rock', G.ico, rock,
        z.cx + dx, BASE_Y + r * 0.5, z.cz + dz, r, r * 0.7, r);
    }
  }

  _buildTrees(zone, z, G, M) {
    const trunk = this._basic(0x6b4a2c);
    const leaf = this._basic(0x2f7a32);
    for (const [dx, dz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) {
      this._mesh(zone, 'Zoo/mammal_zone/tree-trunk', G.box, trunk,
        z.cx + dx, BASE_Y + 1.1, z.cz + dz, 0.45, 2.2, 0.45);
      this._mesh(zone, 'Zoo/mammal_zone/tree-crown', G.cone, leaf,
        z.cx + dx, BASE_Y + 3.2, z.cz + dz, 2.2, 2.6, 2.2);
    }
  }

  _buildSavanna(zone, z, G, M) {
    // 草原展区：少量金合欢树 + 岩石 + 水槽，树木同样用 InstancedMesh。
    const trunk = this._basic(0x73502f);
    const leaf = this._basic(0x6e8f3b);
    const trees = [[-22, 8], [-18, -8], [4, 9], [20, -9], [23, 7]];
    const tIM = new THREE.InstancedMesh(G.cyl, trunk, trees.length);
    tIM.name = 'Zoo/safari_zone/tree-trunk';
    const cIM = new THREE.InstancedMesh(G.ico, leaf, trees.length);
    cIM.name = 'Zoo/safari_zone/tree-crown';
    const dummy = new THREE.Object3D();
    for (let i = 0; i < trees.length; i += 1) {
      const [dx, dz] = trees[i];
      dummy.position.set(z.cx + dx, BASE_Y + 2.0, z.cz + dz);
      dummy.rotation.set(0, i * 1.3, 0);
      dummy.scale.set(0.32, 4.2, 0.32);
      dummy.updateMatrix();
      tIM.setMatrixAt(i, dummy.matrix);
      dummy.position.set(z.cx + dx, BASE_Y + 4.3, z.cz + dz);
      dummy.rotation.set(0, i * 1.7, 0);
      dummy.scale.set(2.5, 0.55, 2.5);
      dummy.updateMatrix();
      cIM.setMatrixAt(i, dummy.matrix);
    }
    for (const im of [tIM, cIM]) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.frustumCulled = true;
      zone.add(im);
    }
    const rock = this._basic(0x9b8d76);
    for (const [dx, dz, s] of [[-25, -10, 1.1], [0, 10, 0.8], [25, 0, 1.4]]) {
      this._mesh(zone, 'Zoo/safari_zone/rock', G.ico, rock,
        z.cx + dx, BASE_Y + s * 0.4, z.cz + dz, s, s * 0.55, s);
    }
  }

  /* ---------------- 入口拱门（默认机位右侧可见） ---------------- */
  _buildEntryArch(root, G, M) {
    const g = new THREE.Group();
    g.name = 'Zoo/entry-arch';
    root.add(g);
    const x = 34.2, z = 8;
    // 【阶段二·模块 3】立柱内收：±4.2 → ±3.2，留出 ≥4m 宽沥青路口供玩家进出
    this._mesh(g, 'Zoo/entry-pillar-l', G.box, M.arch,
      x, BASE_Y + 3.4, z - 3.2, 0.8, 6.8, 0.8);
    this._mesh(g, 'Zoo/entry-pillar-r', G.box, M.arch,
      x, BASE_Y + 3.4, z + 3.2, 0.8, 6.8, 0.8);
    this._mesh(g, 'Zoo/entry-beam', G.box, M.archTrim,
      x, BASE_Y + 6.9, z, 1.0, 0.5, 7.4);
    const tex = this._tex(makeLabelTexture('动物园', 'ZOO  →', 0x8fd8ff));
    const mat = this._mat(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, alphaTest: 0.06, side: THREE.DoubleSide, fog: false,
      toneMapped: false,
    }));
    this._mesh(g, 'Zoo/entry-board', G.box, M.board,
      x, BASE_Y + 8.4, z, 0.4, 2.6, 7.0);
    this._mesh(g, 'Zoo/entry-sign', G.plane, mat,
      x + 0.24, BASE_Y + 8.4, z, 6.6, 2.4, 1).rotation.y = Math.PI / 2;
    this._mesh(g, 'Zoo/entry-sign-2', G.plane, mat,
      x - 0.24, BASE_Y + 8.4, z, 6.6, 2.4, 1).rotation.y = -Math.PI / 2;
    // 【阶段二·模块 3】门内沙砾小径：从拱门铺进家禽区，引导玩家走进围观
    const pathMat = this._basic(0xb8a888);
    this._mesh(g, 'Zoo/entry-path', G.plane, pathMat,
      36.4, BASE_Y + 0.014, z, 4.2, 3.6, 1).rotation.x = -Math.PI / 2;
  }

  /* -------------------------------------------------------------------------- */
  /* 240 帧闭环轨迹烘焙（build 期一次性，运行期只取模插值）                     */
  /* -------------------------------------------------------------------------- */

  _bakeAllTrajectories() {
    this._bakeFish();
    // 【阶段二·模块 3】家禽混群烘焙：鸡(0-4) 鸭(5-8) 鹅(9-11) 一份轨迹，
    // 同群互相分离、共避岩石；狗独立烘焙（间歇停顿由 pause 控制）。
    this._bakeGroundWalk('poultry', 12, { pause: false, seed: 7704, boundsZ: 6.0 });
    this._bakeGroundWalk('dog', 5, { pause: true, seed: 7705 });
    this._bakeGroundWalk('reptile', 4, { pause: false, seed: 7706, boundsZ: 6.0 });
    this._bakeSafari();
  }

  _bakeFish() {
    const n = ZOO_LAYOUT.marine_zone.count;
    const z = ZOO_LAYOUT.marine_zone;
    const bx = 11.0, bz = 10.0, by0 = 0.55, by1 = 2.6;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    let seed = 20261111;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < n; i += 1) {
      pos[i * 3] = (rnd() - 0.5) * 16;
      pos[i * 3 + 1] = 1.2 + rnd() * 1.2;
      pos[i * 3 + 2] = (rnd() - 0.5) * 16;
      vel[i * 3] = (rnd() - 0.5) * 0.08;
      vel[i * 3 + 1] = (rnd() - 0.5) * 0.02;
      vel[i * 3 + 2] = (rnd() - 0.5) * 0.08;
    }
    const SIM = LOOP_FRAMES - BLEND_FRAMES;
    const traj = new Float32Array(LOOP_FRAMES * n * 3);
    const next = new Float32Array(n * 3);
    const dt = 1 / 24;
    for (let f = 0; f < SIM; f += 1) {
      for (let i = 0; i < n; i += 1) {
        const ix = i * 3;
        let sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0;
        let cx = 0, cy = 0, cz = 0, cnt = 0;
        for (let j = 0; j < n; j += 1) {
          if (i === j) continue;
          const jx = j * 3;
          const dx = pos[jx] - pos[ix];
          const dy = pos[jx + 1] - pos[ix + 1];
          const dz = pos[jx + 2] - pos[ix + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > 0.0001 && d2 < 2.6 * 2.6) {
            const w = 1 / d2;
            sx -= dx * w; sy -= dy * w; sz -= dz * w;
          }
          if (d2 < 5.5 * 5.5) {
            ax += vel[jx]; ay += vel[jx + 1]; az += vel[jx + 2];
            cx += pos[jx]; cy += pos[jx + 1]; cz += pos[jx + 2];
            cnt += 1;
          }
        }
        let vx = vel[ix] + sx * 0.030 * dt * 24;
        let vy = vel[ix + 1] + sy * 0.030 * dt * 24;
        let vz = vel[ix + 2] + sz * 0.030 * dt * 24;
        if (cnt) {
          vx += ((ax / cnt - vel[ix]) * 0.9 + (cx / cnt - pos[ix]) * 0.10) * dt;
          vy += ((ay / cnt - vel[ix + 1]) * 0.9 + (cy / cnt - pos[ix + 1]) * 0.10) * dt;
          vz += ((az / cnt - vel[ix + 2]) * 0.9 + (cz / cnt - pos[ix + 2]) * 0.10) * dt;
        }
        // 水体边界约束：提前转向 + 硬夹紧，鱼群永不穿出水体
        if (pos[ix] < -bx + 1.2) vx += 0.06;
        if (pos[ix] > bx - 1.2) vx -= 0.06;
        if (pos[ix + 1] < by0 + 0.5) vy += 0.02;
        if (pos[ix + 1] > by1 - 0.5) vy -= 0.02;
        if (pos[ix + 2] < -bz + 1.2) vz += 0.06;
        if (pos[ix + 2] > bz - 1.2) vz -= 0.06;
        // 轻微环流，保证长期不 stagnation
        vx += -pos[ix + 2] * 0.0006;
        vz += pos[ix] * 0.0006;
        const sp = Math.hypot(vx, vy, vz);
        const maxS = 0.115, minS = 0.022;
        if (sp > maxS) { const r = maxS / sp; vx *= r; vy *= r; vz *= r; }
        else if (sp < minS) { const r = minS / Math.max(sp, 1e-6); vx *= r; vy *= r; vz *= r; }
        next[ix] = vx; next[ix + 1] = vy; next[ix + 2] = vz;
      }
      for (let i = 0; i < n * 3; i += 1) {
        pos[i] += next[i];
      }
      for (let i = 0; i < n; i += 1) {
        const ix = i * 3;
        pos[ix] = Math.max(-bx, Math.min(bx, pos[ix]));
        pos[ix + 1] = Math.max(by0, Math.min(by1, pos[ix + 1]));
        pos[ix + 2] = Math.max(-bz, Math.min(bz, pos[ix + 2]));
      }
      traj.set(pos, f * n * 3);
    }
    this._closeLoop(traj, n, SIM);
    this._traj.set('fish', { data: traj, n, bounds: [bx, bz, by0, by1] });
  }

  _closeLoop(traj, n, sim) {
    const first = traj.subarray(0, n * 3);
    const last = traj.subarray((sim - 1) * n * 3, sim * n * 3);
    for (let k = 0; k < BLEND_FRAMES; k += 1) {
      const a = (k + 1) / BLEND_FRAMES;
      const off = (sim + k) * n * 3;
      for (let i = 0; i < n * 3; i += 1) {
        traj[off + i] = lerp(last[i], first[i], a);
      }
    }
  }

  _bakeGroundWalk(kind, n, { pause = false, seed = 7704, boundsZ = 9.8 } = {}) {
    const bx = 10.8, bz = boundsZ;
    const pos = new Float32Array(n * 3);
    let s = seed >>> 0;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < n; i += 1) {
      pos[i * 3] = (rnd() - 0.5) * 14;
      pos[i * 3 + 1] = 0.32;
      pos[i * 3 + 2] = (rnd() - 0.5) * 14;
    }
    const target = new Float32Array(n * 2);
    const pick = (i) => {
      target[i * 2] = (rnd() - 0.5) * 2 * (bx - 1.5);
      target[i * 2 + 1] = (rnd() - 0.5) * 2 * (bz - 1.5);
    };
    for (let i = 0; i < n; i += 1) pick(i);
    const SIM = LOOP_FRAMES - BLEND_FRAMES;
    const traj = new Float32Array(LOOP_FRAMES * n * 3);
    const step = new Float32Array(n * 2);
    // 避障锚点按烘焙种群所在分区：狗区有 4 棵树、龟区有 3 块岩石、家禽区无
    const rocks = kind === 'dog'
      ? [[-8, -8, 2.4], [8, -8, 2.4], [-8, 8, 2.4], [8, 8, 2.4]]
      : kind === 'reptile'
        ? [[-6, -5, 2.2], [5, 4, 2.5], [2, -7, 1.9]]
        : [];
    for (let f = 0; f < SIM; f += 1) {
      for (let i = 0; i < n; i += 1) {
        const ix = i * 3;
        // 狗：每 70 帧里前 20 帧间歇停顿（按个体错峰）；家禽不停
        const paused = pause && ((f + i * 17) % 70) < 20;
        if (paused) { step[i * 2] = 0; step[i * 2 + 1] = 0; }
        else {
          const dx = target[i * 2] - pos[ix];
          const dz = target[i * 2 + 1] - pos[ix + 2];
          const d = Math.hypot(dx, dz);
          if (d < 0.5 || (f + i * 9) % 38 === 0) pick(i);
          const sp = 0.075;
          let vx = d > 1e-5 ? dx / d * sp : 0;
          let vz = d > 1e-5 ? dz / d * sp : 0;
          // 围栏避障
          if (pos[ix] < -bx + 2) vx += 0.10;
          if (pos[ix] > bx - 2) vx -= 0.10;
          if (pos[ix + 2] < -bz + 2) vz += 0.10;
          if (pos[ix + 2] > bz - 2) vz -= 0.10;
          // 岩石 / 树木避障
          for (const [rx, rz, rr] of rocks) {
            const ddx = pos[ix] - rx, ddz = pos[ix + 2] - rz;
            const dd = Math.hypot(ddx, ddz);
            if (dd < rr + 1.0 && dd > 1e-4) {
              vx += ddx / dd * 0.09;
              vz += ddz / dd * 0.09;
            }
          }
          // 个体间分离
          for (let j = 0; j < n; j += 1) {
            if (j === i) continue;
            const ddx = pos[ix] - pos[j * 3], ddz = pos[ix + 2] - pos[j * 3 + 2];
            const dd = Math.hypot(ddx, ddz);
            if (dd < 1.8 && dd > 1e-4) {
              vx += ddx / dd * 0.05;
              vz += ddz / dd * 0.05;
            }
          }
          step[i * 2] = vx; step[i * 2 + 1] = vz;
        }
      }
      for (let i = 0; i < n; i += 1) {
        const ix = i * 3;
        pos[ix] = Math.max(-bx, Math.min(bx, pos[ix] + step[i * 2]));
        pos[ix + 2] = Math.max(-bz, Math.min(bz, pos[ix + 2] + step[i * 2 + 1]));
        pos[ix + 1] = 0.32 + 0.03 * Math.sin(f * 0.28 + i);
      }
      traj.set(pos, f * n * 3);
    }
    this._closeLoop(traj, n, SIM);
    this._traj.set(kind, { data: traj, n, bounds: [bx, bz] });
  }

  /** 草原展区：大体型动物各占独立小椭圆，速度慢、互不重叠；240 帧严格闭环。 */
  _bakeSafari() {
    const defs = {
      elephant: { centers: [[-14, 0]], rx: 2.4, rz: 1.5, speed: 0.55, phase: 0.4 },
      giraffe: { centers: [[-4, 6], [-4, -2]], rx: 1.25, rz: 0.9, speed: 0.48, phase: 1.1 },
      lion: { centers: [[8, 6], [8, -2]], rx: 1.25, rz: 1.0, speed: 0.62, phase: 2.2 },
      tiger: { centers: [[19, 6], [19, -6]], rx: 1.35, rz: 1.0, speed: 0.75, phase: 3.1 },
    };
    for (const [kind, d] of Object.entries(defs)) {
      const n = d.centers.length;
      const traj = new Float32Array(LOOP_FRAMES * n * 3);
      for (let f = 0; f < LOOP_FRAMES; f += 1) {
        const base = (f / LOOP_FRAMES) * Math.PI * 2 * d.speed * 10;
        for (let i = 0; i < n; i += 1) {
          const a = base + d.phase + i * 2.5;
          const o = (f * n + i) * 3;
          traj[o] = d.centers[i][0] + Math.cos(a) * d.rx;
          traj[o + 1] = 0.32;
          traj[o + 2] = d.centers[i][1] + Math.sin(a) * d.rz;
        }
      }
      this._traj.set(kind, { data: traj, n, bounds: [26, 11] });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* 【阶段二·模块 3】动物五部件拼搭（球体/圆柱/圆锥/方体 × InstancedMesh）      */
  /* 每部件 = 1 个 InstancedMesh；pair:2 表示左右成对（翅/腿/耳，count=2n）。     */
  /* anim: nod 头颈点头 | flap 扇翅 | legs 交替迈步 | tail 摇尾 | ear 竖耳 |      */
  /*       fswim 鱼尾摆 | 缺省 = 刚性随体                                        */
  /* -------------------------------------------------------------------------- */

  _buildAnimals(G, M) {
    // 长鼻：单个连续锥形圆柱弯成弧形，枢轴在鼻根；避免分节错位。
    const trunkGeo = new THREE.CylinderGeometry(0.17, 0.075, 1.85, 8, 10);
    trunkGeo.translate(0, -0.925, 0);
    const trunkPos = trunkGeo.attributes.position;
    for (let i = 0; i < trunkPos.count; i += 1) {
      const y = trunkPos.getY(i);
      const t = Math.min(1, Math.max(0, -y / 1.85));
      trunkPos.setZ(i, trunkPos.getZ(i) + t * t * 0.52);
    }
    trunkGeo.computeVertexNormals();
    trunkGeo.computeBoundingSphere();
    const elephantTrunkGeo = this._geo(trunkGeo);

    // 斑纹/虎纹：小体量部件合并成各自 1 个共享几何，避免每只动物新增 draw call。
    const spotParts = [];
    for (const [x, y, z, s] of [
      [-0.84, 3.04, -0.72, 0.20], [-0.86, 2.62, -0.20, 0.18], [-0.83, 3.18, 0.48, 0.17],
      [0.84, 2.92, -0.50, 0.19], [0.86, 3.28, 0.18, 0.17], [0.83, 2.55, 0.74, 0.18],
      [0, 3.60, -0.56, 0.16], [0, 3.62, 0.24, 0.15],
      [-0.235, 4.28, 0.64, 0.11], [0.235, 4.58, 0.64, 0.10],
      [-0.235, 4.78, 0.66, 0.09], [0.235, 4.02, 0.64, 0.10],
    ]) {
      const g = new THREE.IcosahedronGeometry(1, 0);
      g.scale(s * 0.34, s, s * 1.45);
      g.translate(x, y, z);
      spotParts.push(g);
    }
    const giraffeSpotGeo = this._geo(mergeGeometries(spotParts, false));
    spotParts.forEach((g) => g.dispose());

    const stripeParts = [];
    for (const [y, z, w] of [[1.08, 0.48, 0.46], [1.13, 0.02, 0.54], [1.09, -0.44, 0.44], [0.92, 0.86, 0.38]]) {
      const g = new THREE.BoxGeometry(0.98, 0.07, 0.11);
      g.rotateZ(0.16);
      g.translate(0, y, z);
      stripeParts.push(g);
      const g2 = new THREE.BoxGeometry(0.20, 0.08, w);
      g2.translate(0.34, y - 0.04, z);
      stripeParts.push(g2);
      const g3 = g2.clone();
      g3.translate(-0.68, 0, 0);
      stripeParts.push(g3);
    }
    const tigerStripeGeo = this._geo(mergeGeometries(stripeParts, false));
    stripeParts.forEach((g) => g.dispose());

    // 家禽混群：poultry 轨迹 12 只中 鸡占 0-4、鸭占 5-8、鹅占 9-11
    const K = {
      // —— 鸡：红冠 + 黄羽 + 短喙 ——
      chicken: {
        traj: 'poultry', off: 0, n: 5, zone: ZOO_LAYOUT.bird_zone,
        // instanceColor 与材质色相乘：以白为基的亮度变化，避免平方过暗
        colors: [0xffffff, 0xffe9a8, 0xffffff, 0xfff6d8, 0xffe9a8],
        parts: [
          { geo: G.ico, mat: M.bird, s: [0.34, 0.28, 0.44], o: [0, 0.30, 0] },
          { geo: G.ico, mat: M.white, s: [0.17, 0.17, 0.17], o: [0, 0.56, 0.28], anim: 'nod' },
          { geo: G.cone, mat: M.comb, s: [0.09, 0.13, 0.10], o: [0, 0.73, 0.26], anim: 'nod' },
          { geo: G.cone, mat: M.beak, s: [0.06, 0.12, 0.06], o: [0, 0.54, 0.43], anim: 'nod', rotX: Math.PI / 2 },
          { geo: G.ico, mat: M.birdWing, s: [0.26, 0.07, 0.18], o: [0, 0.34, -0.02], dx: 0.30, pair: 2, anim: 'flap' },
          { geo: G.box, mat: M.mammalLeg, s: [0.05, 0.20, 0.05], o: [0, 0.10, 0], dx: 0.09, pair: 2, anim: 'legs' },
        ],
      },
      // —— 鸭：扁喙 + 长颈 + 白羽 ——
      duck: {
        traj: 'poultry', off: 5, n: 4, zone: ZOO_LAYOUT.bird_zone,
        colors: [0xffffff, 0xe8ddd0, 0xffffff, 0xf0e8dc],
        parts: [
          { geo: G.ico, mat: M.white, s: [0.36, 0.26, 0.48], o: [0, 0.30, 0] },
          { geo: G.cyl, mat: M.white, s: [0.07, 0.30, 0.07], o: [0, 0.55, 0.26], anim: 'nod' },
          { geo: G.ico, mat: M.white, s: [0.16, 0.15, 0.18], o: [0, 0.74, 0.30], anim: 'nod' },
          { geo: G.box, mat: M.beak, s: [0.15, 0.05, 0.16], o: [0, 0.72, 0.47], anim: 'nod' },
          { geo: G.cone, mat: M.white, s: [0.14, 0.16, 0.10], o: [0, 0.42, -0.46], anim: 'tail', rotX: -1.9 },
          { geo: G.box, mat: M.mammalLeg, s: [0.05, 0.20, 0.05], o: [0, 0.10, 0], dx: 0.10, pair: 2, anim: 'legs' },
        ],
      },
      // —— 鹅：长颈 + 橙喙 + 大体型 ——
      goose: {
        traj: 'poultry', off: 9, n: 3, zone: ZOO_LAYOUT.bird_zone,
        colors: [0xffffff, 0xd8e4ee, 0xffffff],
        parts: [
          { geo: G.ico, mat: M.goose, s: [0.42, 0.32, 0.56], o: [0, 0.36, 0] },
          { geo: G.cyl, mat: M.goose, s: [0.06, 0.44, 0.06], o: [0, 0.76, 0.24], anim: 'nod' },
          { geo: G.ico, mat: M.goose, s: [0.15, 0.14, 0.18], o: [0, 1.02, 0.28], anim: 'nod' },
          { geo: G.cone, mat: M.beak, s: [0.055, 0.16, 0.055], o: [0, 1.00, 0.46], anim: 'nod', rotX: Math.PI / 2 },
          { geo: G.ico, mat: M.birdWing, s: [0.30, 0.08, 0.24], o: [0, 0.40, -0.04], dx: 0.36, pair: 2, anim: 'flap' },
          { geo: G.box, mat: M.mammalLeg, s: [0.06, 0.26, 0.06], o: [0, 0.13, 0], dx: 0.11, pair: 2, anim: 'legs' },
        ],
      },
      // —— 狗：竖耳 + 摇尾 + 间歇停顿 ——
      dog: {
        traj: 'dog', off: 0, n: 5, zone: ZOO_LAYOUT.mammal_zone,
        colors: [0xffffff, 0xe8c9a0, 0xffffff, 0xc9a06a, 0xe8c9a0],
        parts: [
          { geo: G.ico, mat: M.mammal, s: [0.40, 0.34, 0.56], o: [0, 0.42, 0] },
          { geo: G.ico, mat: M.mammal, s: [0.26, 0.24, 0.26], o: [0, 0.72, 0.40], anim: 'nod' },
          { geo: G.cone, mat: M.mammalLeg, s: [0.09, 0.20, 0.06], o: [0, 0.92, 0.36], dx: 0.13, pair: 2, anim: 'ear' },
          { geo: G.cone, mat: M.mammalLeg, s: [0.07, 0.26, 0.07], o: [0, 0.56, -0.52], anim: 'tail', rotX: -1.1 },
          { geo: G.box, mat: M.mammalLeg, s: [0.08, 0.30, 0.08], o: [0, 0.15, 0], dx: 0.13, pair: 2, anim: 'legs' },
        ],
      },
      // —— 龟（保留）：硬壳 + 短腿 ——
      reptile: {
        traj: 'reptile', off: 0, n: 4, zone: ZOO_LAYOUT.reptile_zone,
        colors: null,
        parts: [
          { geo: G.ico, mat: M.reptile, s: [0.36, 0.22, 0.58], o: [0, 0.22, 0] },
          { geo: G.ico, mat: M.reptile, s: [0.23, 0.19, 0.24], o: [0, 0.28, 0.55], anim: 'nod' },
          { geo: G.ico, mat: M.reptileLeg, s: [0.40, 0.18, 0.50], o: [0, 0.38, -0.02] },
          { geo: G.box, mat: M.reptileLeg, s: [0.10, 0.14, 0.10], o: [0, 0.07, 0.18], dx: 0.22, pair: 2, anim: 'legs' },
        ],
      },
      // —— 鱼（保留）：流线体 + 尾鳍集群 ——
      fish: {
        traj: 'fish', off: 0, n: ZOO_LAYOUT.marine_zone.count, zone: ZOO_LAYOUT.marine_zone,
        colors: null, aquatic: true,
        parts: [
          { geo: G.ico, mat: M.fish, s: [0.26, 0.22, 0.50], o: [0, 0, 0] },
          { geo: G.ico, mat: M.white, s: [0.17, 0.16, 0.17], o: [0, 0.02, 0.44] },
          { geo: G.cone, mat: M.fishTail, s: [0.30, 0.46, 0.30], o: [0, 0, -0.56], anim: 'fswim' },
        ],
      },
      // —— 大象：长鼻分三节摆动 + 大耳扇动 + 象牙 ——
      elephant: {
        traj: 'elephant', off: 0, n: 1, zone: ZOO_LAYOUT.safari_zone,
        colors: [0xffffff], bob: 0.035, gait: 2.9,
        parts: [
          { geo: G.ico, mat: M.elephant, s: [1.55, 1.18, 1.95], o: [0, 1.75, 0] },
          { geo: G.ico, mat: M.elephant, s: [0.86, 0.78, 0.88], o: [0, 2.22, 2.02], anim: 'nod' },
          { geo: G.ico, mat: M.elephantEar, s: [0.17, 0.74, 0.68], o: [0, 2.30, 1.76], dx: 0.88, pair: 2, anim: 'bigear' },
          { geo: G.cone, mat: M.ivory, s: [0.10, 0.64, 0.10], o: [0, 1.78, 2.48], dx: 0.36, pair: 2, rotX: 1.05 },
          { geo: elephantTrunkGeo, mat: M.elephant, s: [1, 1, 1], o: [0, 2.12, 2.38], anim: 'trunk' },
          { geo: G.box, mat: M.elephant, s: [0.30, 0.92, 0.34], o: [0, 0.48, 0.92], dx: 0.58, pair: 2, anim: 'legs' },
          { geo: G.box, mat: M.elephant, s: [0.30, 0.92, 0.34], o: [0, 0.48, -0.92], dx: 0.58, pair: 2, anim: 'legs', gaitOffset: Math.PI },
          { geo: G.cyl, mat: M.elephant, s: [0.08, 0.95, 0.08], o: [0, 0.95, -1.92], anim: 'tail', rotX: -0.35 },
        ],
      },
      // —— 长颈鹿：长颈摆动 + 斑纹 + 高腿 ——
      giraffe: {
        traj: 'giraffe', off: 0, n: 2, zone: ZOO_LAYOUT.safari_zone,
        colors: [0xffffff, 0xf0d0a0], bob: 0.04, gait: 3.6,
        parts: [
          { geo: G.ico, mat: M.giraffe, s: [0.82, 0.92, 1.40], o: [0, 2.75, 0] },
          { geo: giraffeSpotGeo, mat: M.giraffeSpot, s: [1, 1, 1], o: [0, 0, 0], anim: 'body' },
          { geo: G.cyl, mat: M.giraffe, s: [0.235, 2.55, 0.235], o: [0, 4.18, 0.62], anim: 'neck', rotX: 0.18 },
          { geo: G.ico, mat: M.giraffe, s: [0.40, 0.34, 0.56], o: [0, 5.64, 1.02], anim: 'neck' },
          { geo: G.box, mat: M.belly, s: [0.34, 0.22, 0.30], o: [0, 5.48, 1.46], anim: 'neck' },
          { geo: G.cone, mat: M.giraffeSpot, s: [0.07, 0.30, 0.07], o: [0, 5.98, 0.98], dx: 0.17, pair: 2, anim: 'neck' },
          { geo: G.box, mat: M.giraffe, s: [0.17, 1.82, 0.20], o: [0, 0.91, 0.82], dx: 0.46, pair: 2, anim: 'legs' },
          { geo: G.box, mat: M.giraffe, s: [0.17, 1.82, 0.20], o: [0, 0.91, -0.82], dx: 0.46, pair: 2, anim: 'legs', gaitOffset: Math.PI },
          { geo: G.cyl, mat: M.giraffeSpot, s: [0.07, 1.40, 0.07], o: [0, 0.95, -1.48], anim: 'tail', rotX: -0.3 },
        ],
      },
      // —— 狮子：鬃毛 + 摆尾 + 低伏漫步 ——
      lion: {
        traj: 'lion', off: 0, n: 2, zone: ZOO_LAYOUT.safari_zone,
        colors: [0xffffff, 0xe8c07a], bob: 0.025, gait: 5.2,
        parts: [
          { geo: G.ico, mat: M.lion, s: [0.68, 0.56, 1.18], o: [0, 0.92, 0] },
          { geo: G.ico, mat: M.lionMane, s: [0.68, 0.68, 0.44], o: [0, 1.24, 0.82], anim: 'nod' },
          { geo: G.ico, mat: M.lion, s: [0.44, 0.41, 0.45], o: [0, 1.30, 1.04], anim: 'nod' },
          { geo: G.box, mat: M.belly, s: [0.34, 0.20, 0.26], o: [0, 1.18, 1.40], anim: 'nod' },
          { geo: G.cone, mat: M.lionMane, s: [0.10, 0.18, 0.10], o: [0, 1.58, 0.98], dx: 0.28, pair: 2, anim: 'ear' },
          { geo: G.box, mat: M.lion, s: [0.17, 0.58, 0.19], o: [0, 0.34, 0.72], dx: 0.38, pair: 2, anim: 'legs' },
          { geo: G.box, mat: M.lion, s: [0.17, 0.58, 0.19], o: [0, 0.34, -0.72], dx: 0.38, pair: 2, anim: 'legs', gaitOffset: Math.PI },
          { geo: G.cyl, mat: M.lionMane, s: [0.07, 1.20, 0.07], o: [0, 0.55, -1.22], anim: 'tail', rotX: -0.45 },
        ],
      },
      // —— 老虎：橙底黑纹 + 白吻 + 低伏长尾 ——
      tiger: {
        traj: 'tiger', off: 0, n: 2, zone: ZOO_LAYOUT.safari_zone,
        colors: [0xffffff, 0xf0a050], bob: 0.03, gait: 6.4,
        parts: [
          { geo: G.ico, mat: M.tiger, s: [0.60, 0.50, 1.30], o: [0, 0.86, 0] },
          { geo: tigerStripeGeo, mat: M.tigerStripe, s: [1, 1, 1], o: [0, 0, 0], anim: 'body' },
          { geo: G.ico, mat: M.tiger, s: [0.42, 0.38, 0.44], o: [0, 1.16, 1.08], anim: 'nod' },
          { geo: G.box, mat: M.belly, s: [0.30, 0.18, 0.24], o: [0, 1.06, 1.40], anim: 'nod' },
          { geo: G.cone, mat: M.tigerStripe, s: [0.09, 0.17, 0.09], o: [0, 1.40, 1.04], dx: 0.25, pair: 2, anim: 'ear' },
          { geo: G.box, mat: M.tiger, s: [0.16, 0.54, 0.18], o: [0, 0.31, 0.76], dx: 0.34, pair: 2, anim: 'legs' },
          { geo: G.box, mat: M.tiger, s: [0.16, 0.54, 0.18], o: [0, 0.31, -0.76], dx: 0.34, pair: 2, anim: 'legs', gaitOffset: Math.PI },
          { geo: G.cyl, mat: M.tiger, s: [0.065, 1.40, 0.065], o: [0, 0.50, -1.30], anim: 'tail', rotX: -0.55 },
        ],
      },
    };

    for (const [kind, sp] of Object.entries(K)) {
      const host = this.group.children.find((c) => c.name === `Zoo/${this._zoneKeyOf(kind)}`)
        || this.group;
      const parts = sp.parts.map((part, k) => {
        const count = sp.n * (part.pair || 1);
        const im = new THREE.InstancedMesh(part.geo, part.mat, count);
        im.name = `Zoo/${kind}/part-${k}`;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (k === 0 && sp.colors) {
          for (let i = 0; i < sp.n; i += 1) {
            im.setColorAt(i, new THREE.Color(sp.colors[i % sp.colors.length]));
          }
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
        host.add(im);
        return im;
      });
      // 每只陆地动物一套独立“行为时钟”：站立张望、慢慢走到随机点、低头吃草，
      // 不再全园共享同一条 10 秒闭合轨迹（那会看起来像原地绕圈）。
      const beh = [];
      for (let i = 0; i < sp.n; i += 1) {
        this._sample(sp.traj, sp.off + i, (i * 37 + kind.length * 13) % LOOP_FRAMES, this._sampleLocal);
        const p0 = this._sampleLocal;
        const radius = kind === 'elephant' ? 3.0 : kind === 'giraffe' ? 2.4
          : kind === 'lion' || kind === 'tiger' ? 2.1 : kind === 'dog' ? 1.5 : 1.1;
        beh.push({
          hx: p0[0], hy: p0[1], hz: p0[2], x: p0[0], z: p0[2],
          yaw: 0, state: 'idle', timer: 0.8 + i * 0.9, radius,
          seed: (i + 1) * 91 + kind.length * 17, stateCount: 0,
          speed: kind === 'elephant' ? 0.42 : kind === 'giraffe' ? 0.38
            : kind === 'lion' ? 0.48 : kind === 'tiger' ? 0.55 : 0.32,
          moving: false,
        });
      }
      this._animals.push({ kind, n: sp.n, zone: sp.zone, spec: sp, parts, beh, lastT: -1 });
    }
  }

  _rand(n) {
    const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  /** 陆地动物随机行为：不产生对象分配，只在状态切换时用确定性哈希挑新目标。 */
  _advanceBehavior(b, dt) {
    b.timer -= dt;
    if (b.state === 'walk') {
      const dx = b.tx - b.x, dz = b.tz - b.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.12 || b.timer <= 0) {
        b.state = this._rand(b.seed + b.stateCount * 5.7) > 0.55 ? 'graze' : 'idle';
        b.timer = 2.4 + this._rand(b.seed + b.stateCount * 3.1) * 4.8;
        b.stateCount += 1;
        b.moving = false;
        return;
      }
      const step = Math.min(d, b.speed * dt);
      b.x += (dx / d) * step;
      b.z += (dz / d) * step;
      b.yaw = Math.atan2(dx, dz);
      b.moving = true;
      return;
    }
    b.moving = false;
    if (b.timer <= 0) {
      b.stateCount += 1;
      const a = this._rand(b.seed + b.stateCount * 11.3) * Math.PI * 2;
      const r = b.radius * (0.35 + this._rand(b.seed + b.stateCount * 7.9) * 0.65);
      b.tx = b.hx + Math.cos(a) * r;
      b.tz = b.hz + Math.sin(a) * r;
      const dist = Math.hypot(b.tx - b.x, b.tz - b.z);
      if (this._rand(b.seed + b.stateCount * 2.7) < 0.30) {
        b.state = 'idle';
        b.timer = 2.0 + this._rand(b.seed + b.stateCount) * 3.0;
      } else {
        b.state = 'walk';
        b.timer = Math.max(2.0, dist / b.speed + 1.0);
      }
    }
  }

  _zoneKeyOf(kind) {
    return {
      chicken: 'bird_zone', duck: 'bird_zone', goose: 'bird_zone',
      dog: 'mammal_zone', fish: 'marine_zone', reptile: 'reptile_zone',
      elephant: 'safari_zone', giraffe: 'safari_zone', lion: 'safari_zone', tiger: 'safari_zone',
    }[kind];
  }

  /** 从烘焙表取模插值，返回第 i 只动物在 t 秒的局部坐标（写入 out） */
  _sample(kind, i, phase, out) {
    const tr = this._traj.get(kind);
    const n = tr.n;
    const f0 = Math.floor(phase) % LOOP_FRAMES;
    const f1 = (f0 + 1) % LOOP_FRAMES;
    const k = phase - Math.floor(phase);
    const a = (f0 * n + i) * 3, b = (f1 * n + i) * 3;
    out[0] = lerp(tr.data[a], tr.data[b], k);
    out[1] = lerp(tr.data[a + 1], tr.data[b + 1], k);
    out[2] = lerp(tr.data[a + 2], tr.data[b + 2], k);
  }

  /** 动物园游客：1 个 InstancedMesh / 1 draw，站在栏杆边看动物、拍照、沿中央步道走。 */
  _buildVisitors(root) {
    const specs = [
      { x: 39.0, z: 19.2, yaw: Math.PI, wave: 1.0 },
      { x: 45.5, z: 19.2, yaw: Math.PI, wave: 0.0 },
      { x: 51.8, z: 19.2, yaw: Math.PI, wave: 0.7 },
      { x: 31.0, z: -7.0, yaw: Math.PI / 2, wave: 0.0 },
      { x: 31.0, z: -14.0, yaw: Math.PI / 2, wave: 0.8 },
      { x: 31.0, z: -21.0, yaw: Math.PI / 2, wave: 0.0 },
      { x: 67.0, z: 19.2, yaw: Math.PI, wave: 0.4 },
      { x: 82.5, z: 19.2, yaw: Math.PI, wave: 0.0 },
      { x: 44.0, z: -27.8, yaw: 0, wave: 0.9 },
      { x: 76.0, z: -27.8, yaw: 0, wave: 0.0 },
      { x: 60.0, z: 5.0, yaw: Math.PI, walk: 'z', range: 12.0, speed: 0.7, phase: 0.0 },
      { x: 60.0, z: -17.0, yaw: 0, walk: 'z', range: 7.0, speed: 0.55, phase: 9.0 },
    ];
    const count = specs.length;
    const char = buildNPCCharacter({ count });
    this._trackGeometry(char.geometry);
    this._trackMaterial(char.material);
    const coats = [0xe4572e, 0x2e86ab, 0xf2c14e, 0x6a994e, 0x8e6bbf,
      0xe07a5f, 0x4d908e, 0xef476f, 0x457b9d, 0xf4a261, 0x90be6d, 0x577590];
    for (let i = 0; i < count; i++) {
      char.setOutfit(i, { coat: coats[i % coats.length], pants: i % 2 ? 0x27374d : 0xc9b8a0 });
    }
    char.flushPalette();
    const mesh = new THREE.InstancedMesh(char.geometry, char.material, count);
    mesh.name = 'Zoo/visitors';
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.visitorCount = count;
    root.add(mesh);
    this._visitor = { mesh, char, specs, count };
  }

  _updateVisitors(t) {
    const v = this._visitor;
    if (!v) return;
    const m = this._m, p = this._p, q = this._q, s = this._s, e = this._e;
    const anim = v.char.attributes.aAnim;
    for (let i = 0; i < v.count; i++) {
      const sp = v.specs[i];
      let x = sp.x, z = sp.z, yaw = sp.yaw, moving = 0;
      if (sp.walk) {
        const span = sp.range * 2;
        const raw = (t * sp.speed + sp.phase) % span;
        const k = raw < sp.range ? raw : span - raw;
        const dir = raw < sp.range ? 1 : -1;
        if (sp.walk === 'z') { z += k; yaw = dir > 0 ? Math.PI : 0; }
        else { x += k; yaw = dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
        moving = 0.55;
      }
      p.set(x, BASE_Y - 0.18, z);
      q.setFromEuler(e.set(0, yaw, 0));
      s.setScalar(NPC_SCALE);
      m.compose(p, q, s);
      v.mesh.setMatrixAt(i, m);
      const a = i * 4;
      anim.array[a] = t * (5.2 + (sp.speed || 0) * 2) + i * 0.73;
      anim.array[a + 1] = moving;
      // 轻微抬手看动物即可；旧值会把整条手臂举成水平，像僵住。
      anim.array[a + 2] = sp.wave ? (0.08 + 0.16 * Math.max(0, Math.sin(t * 1.6 + i))) : 0;
      anim.array[a + 3] = Math.sin(t * 0.5 + i * 1.7) * 0.35;
    }
    v.mesh.instanceMatrix.needsUpdate = true;
    anim.needsUpdate = true;
    v.char.timeUniform.value = t;
  }

  /** 只改 instanceMatrix / 已有对象属性，绝不新建 GPU 资源 */
  update(t) {
    if (!this.group) return;
    this._time = t;
    this._updateVisitors(t);
    const phase = ((t % LOOP_SECONDS) / LOOP_SECONDS) * LOOP_FRAMES;
    const p = this._p, q = this._q, s = this._s, e = this._e, m = this._m;
    const local = this._sampleLocal;
    const nxt = this._sampleNext;

    for (const a of this._animals) {
      const { kind, n, zone, spec, parts, beh } = a;
      const aquatic = spec.aquatic === true;
      const dt = a.lastT < 0 ? 0 : Math.max(0, Math.min(0.08, t - a.lastT));
      a.lastT = t;
      for (let i = 0; i < n; i += 1) {
        let lx, ly, lz, yaw, flap;
        let moving = true;
        if (aquatic) {
          // 鱼：烘焙鱼群轨迹（边界/聚群/环流在烘焙期完成）
          this._sample(kind, i, phase, local);
          lx = local[0]; ly = local[1]; lz = local[2];
          const ph2 = (phase + 1) % LOOP_FRAMES;
          this._sample(kind, i, ph2, nxt);
          const dx = nxt[0] - lx, dz = nxt[2] - lz;
          yaw = (dx * dx + dz * dz) > 1e-7 ? Math.atan2(dx, dz) : 0;
          flap = Math.sin(t * 9 + i * 1.3) * 0.55;
        } else {
          // 陆生：独立行为状态机（站立/吃草/走向随机点），不再绕固定圈。
          const b = beh[i];
          if (dt > 0) this._advanceBehavior(b, dt);
          lx = b.x; ly = b.hy; lz = b.z;
          yaw = b.yaw;
          moving = b.moving;
          flap = Math.sin(t * 2.1 + b.seed) * (b.state === 'graze' ? 0.35 : 1);
        }

        const wx = zone.cx + lx;
        const bobY = spec.bob ? Math.sin(t * (kind === 'elephant' ? 1.4 : 2.3) + i * 1.7) * spec.bob : 0;
        const wy = BASE_Y + ly + bobY;
        const wz = zone.cz + lz;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);

        /* 部件级动画参数（每动物一次，部件间共享）：
         * nod —— 头颈啄食节奏：慢摆 + 偶发低头啄地（^6 峰值脉冲）
         * walkStep —— 迈步相位（左右腿反相） */
        const peck = Math.max(0, Math.sin(t * 1.3 + i * 2.4));
        const graze = !aquatic && beh[i].state === 'graze';
        const nod = Math.sin(t * 2.2 + i * 1.1) * 0.12
          + (graze ? 0.42 : 0) * Math.max(0, Math.sin(t * 1.25 + i * 2.4))
          + peck * peck * peck * peck * peck * peck * (moving ? 0.5 : 0.16);
        const gaitSpeed = spec.gait || (kind === 'dog' ? 6 : 8);
        const legAmp = kind === 'elephant' ? 0.16 : kind === 'giraffe' ? 0.22
          : kind === 'lion' ? 0.25 : kind === 'tiger' ? 0.28 : 0.5;
        const flapAmp = kind === 'goose'
          ? 0.10 + Math.max(0, Math.sin(t * 1.8 + i * 0.9)) ** 3 * 0.55
          : 0.08 + Math.max(0, flap) * 0.12;

        // 每个部件的实例槽按「动物序号 × 成对份数 + 左右份」直接定位。
        // 不能用跨部件累加游标：各 InstancedMesh 的 count 独立，会越界并把腿/鼻写错槽位。
        for (let k = 0; k < parts.length; k += 1) {
          const part = spec.parts[k];
          const copies = part.pair || 1;
          const im = parts[k];
          for (let j = 0; j < copies; j += 1) {
            const dxOff = (part.dx || 0) * (j === 0 ? 1 : -1);
            const legDrop = part.anim === 'legs' ? 0.32 : 0; // 延伸腿长，让四足动物踩实地面
            // 【热点修复】旋转写入共享变量，替代每帧 new 闭包/数组
            rotZInto(cy, sy, part.o[0] + dxOff, part.o[2]);
            p.set(wx + _rotX, wy + part.o[1] - legDrop * 0.5, wz + _rotZ);
            e.set(part.rotX || 0, yaw, 0);
            switch (part.anim) {
              case 'nod':  // 头颈/冠/喙：随啄食节奏点头（绕自身中心小幅俯仰）
                e.set((part.rotX || 0) + nod, yaw, 0);
                break;
              case 'flap': // 双翅：静息微张 + 周期扇合（左右镜像）
                e.set(0, yaw, (j === 0 ? 1 : -1) * flapAmp);
                break;
              case 'legs': // 双腿：交替迈步；站立吃草时逐步收住
                e.set(Math.sin(t * gaitSpeed + i * 2.1 + (part.gaitOffset || 0) + (j === 0 ? 0 : Math.PI))
                  * legAmp * (moving ? 1 : 0.08), yaw, 0);
                break;
              case 'trunk': // 大象长鼻：整根绕鼻根摆动
                e.set((part.rotX || 0) + Math.sin(t * 1.35 + i * 0.9) * 0.16,
                  yaw, Math.sin(t * 0.9) * 0.14);
                break;
              case 'neck': // 长颈鹿：长颈慢摆 + 头部微点
                e.set((part.rotX || 0) + Math.sin(t * 0.75 + i * 1.3) * 0.055,
                  yaw, Math.sin(t * 0.52 + i) * 0.075);
                break;
              case 'bigear': // 大象耳：左右扇动
                e.set(Math.sin(t * 0.9 + i) * 0.04, yaw, (j === 0 ? 1 : -1) * (0.12 + Math.sin(t * 1.5 + i) * 0.16));
                break;
              case 'body': // 斑纹随躯干呼吸，避免完全僵死
                e.set(Math.sin(t * 1.8 + i) * 0.008, yaw, 0);
                break;
              case 'tail': // 尾：狗摇尾 / 鸭尾上翘轻摆 / 大型猫科横向摆尾
                e.set((part.rotX || 0) + Math.sin(t * (kind === 'dog' ? 9 : 3) + i) * (kind === 'dog' ? 0.24 : 0.08),
                  yaw, (kind === 'lion' || kind === 'tiger') ? Math.sin(t * 2.2 + i) * 0.22 : 0);
                break;
              case 'ear':  // 狗耳：竖立 + 小幅抖动
                e.set(Math.sin(t * 3 + i * 1.3) * 0.1, yaw, 0);
                break;
              case 'fswim': // 鱼尾：左右摆（绕 Y）
                e.set(0, yaw + flap, 0);
                break;
              default: break; // 刚性部件（龟壳/鱼头等）
            }
            q.setFromEuler(e);
            s.set(part.s[0], part.s[1] + (part.anim === 'legs' ? 0.32 : 0), part.s[2]);
            m.compose(p, q, s);
            im.setMatrixAt(i * copies + j, m);
          }
        }
      }
      for (let k = 0; k < parts.length; k += 1) parts[k].instanceMatrix.needsUpdate = true;
    }

    // 标牌轻微呼吸光（只改材质属性，不新建资源）
    if (this._M.archTrim) {
      this._M.archTrim.color.setHSL(0.54, 0.75, 0.72 + 0.06 * Math.sin(t * 1.2));
    }
  }

  dispose() {
    if (this.group) {
      // instanceMatrix 是独立 GPU buffer，需在 root.clear() 之前成对释放
      this.group.traverse((o) => {
        if (o.isInstancedMesh && typeof o.dispose === 'function') {
          try { o.dispose(); } catch (err) { console.error('[Zoo] InstancedMesh dispose 失败：', err); }
        }
      });
      if (this.group.parent) this.group.parent.remove(this.group);
    }
    this._animals.length = 0;
    this._traj.clear();
    this.group = null;
  }
}

/** Lobby.init 调用入口 */
export function buildZoo(opts) {
  return new Zoo(opts).build();
}
