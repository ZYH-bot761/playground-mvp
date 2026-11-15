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

/** 四区布局（世界坐标，x / z 对应 Blender 的 x / y） */
export const ZOO_LAYOUT = Object.freeze({
  bird_zone: {
    cx: 45, cz: 14, w: 26, h: 24, color: 0x70bff2,
    cn: '鸟类区', en: 'BIRD ZONE', kind: 'bird', count: 8,
  },
  reptile_zone: {
    cx: 75, cz: 14, w: 26, h: 24, color: 0xc29b57,
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
});

/**
 * 【M6】具体物种清单与造型特征（用户点名：鸡、狗、鸭、鹅）。
 * 四区里不再是泛化的「鸟/兽/龟/鱼」，而是可辨认的家禽家畜：
 *   鸟区 8 只 = 鸡 3 / 鸭 3 / 鹅 2（红冠、扁喙、长颈各有造型件）
 *   哺乳区 5 只 = 狗 5（竖耳 + 上翘尾）
 *   爬行区 4 只 = 龟 4（硬壳 + 短腿，贴地爬行）
 *   海洋区 15 条 = 鱼 15（尾鳍摆动集群）
 * 造型差异用「每类 3 个 InstancedMesh + instanceColor 局部染色 + 特征部件」实现，
 * 不增加 draw call（仍是每类 3 个 = 12 个 InstancedMesh）。
 */
export const ZOO_SPECIES = Object.freeze(['鸡', '鸭', '鹅', '狗', '龟', '鱼']);
export const ZOO_TRAITS = Object.freeze({
  鸡: Object.freeze({ zone: 'bird_zone', count: 3, feature: '红冠 + 短喙 + 短尾', color: 0xffd23f }),
  鸭: Object.freeze({ zone: 'bird_zone', count: 3, feature: '扁喙 + 圆头 + 白羽', color: 0xf2f7ff }),
  鹅: Object.freeze({ zone: 'bird_zone', count: 2, feature: '长颈 + 橙喙 + 大体型', color: 0xeaf4ff }),
  狗: Object.freeze({ zone: 'mammal_zone', count: 5, feature: '竖耳 + 上翘尾 + 项圈', color: 0xb9793f }),
  龟: Object.freeze({ zone: 'reptile_zone', count: 4, feature: '硬壳 + 短腿 + 缩头', color: 0x66c25a }),
  鱼: Object.freeze({ zone: 'marine_zone', count: 15, feature: '流线体 + 尾鳍集群', color: 0x59c9f2 }),
});
/** 围栏高度（m）：低于旧围栏的 1.8m，站在栏边可平视动物 */
export const ZOO_FENCE_HEIGHT = 1.2;

/** 动物园俯瞰机位（OrbitControls maxDistance=50，cam↔tgt 距离约 46.9） */
export const ZOO_VIEW = Object.freeze({
  cam: [60, 32, 36],
  tgt: [60, 2, 0],
});

const BASE_Y = 1.1;          // 分区地面顶面，高于远处草丘最大起伏 0.9m
const LOOP_FRAMES = 240;     // 240 帧闭环，与 Blender 版一致
const BLEND_FRAMES = 24;     // 末段插值回首帧，保证周期首尾相接
const LOOP_SECONDS = 10;     // 240 帧 @24fps

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

    // 复用的矩阵 / 向量（update 中零分配）
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._e = new THREE.Euler();
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
      reptile: this._basic(0x66c25a),
      reptileLeg: this._basic(0x3f8b3a),
      fish: this._basic(0x59c9f2),
      fishTail: this._basic(0xff9a4d),
      mammal: this._basic(0xb9793f),
      mammalLeg: this._basic(0x7d4c28),
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
    }

    this._buildFenceAll(G, M);
    this._buildEntryArch(root, G, M);
    this._bakeAllTrajectories();
    this._buildAnimals(G, M);
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
    const zz = z.cz + z.h / 2 + 0.55;
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

  /* ---------------- 入口拱门（默认机位右侧可见） ---------------- */
  _buildEntryArch(root, G, M) {
    const g = new THREE.Group();
    g.name = 'Zoo/entry-arch';
    root.add(g);
    const x = 30, z = 8;
    this._mesh(g, 'Zoo/entry-pillar-l', G.box, M.arch,
      x, BASE_Y + 3.4, z - 4.2, 0.8, 6.8, 0.8);
    this._mesh(g, 'Zoo/entry-pillar-r', G.box, M.arch,
      x, BASE_Y + 3.4, z + 4.2, 0.8, 6.8, 0.8);
    this._mesh(g, 'Zoo/entry-beam', G.box, M.archTrim,
      x, BASE_Y + 6.9, z, 1.0, 0.5, 9.4);
    const tex = this._tex(makeLabelTexture('动物园', 'ZOO  →', 0x8fd8ff));
    const mat = this._mat(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, alphaTest: 0.06, side: THREE.DoubleSide, fog: false,
      toneMapped: false,
    }));
    this._mesh(g, 'Zoo/entry-board', G.box, M.board,
      x, BASE_Y + 8.4, z, 0.4, 2.6, 9.0);
    this._mesh(g, 'Zoo/entry-sign', G.plane, mat,
      x + 0.24, BASE_Y + 8.4, z, 8.6, 2.4, 1).rotation.y = Math.PI / 2;
    this._mesh(g, 'Zoo/entry-sign-2', G.plane, mat,
      x - 0.24, BASE_Y + 8.4, z, 8.6, 2.4, 1).rotation.y = -Math.PI / 2;
  }

  /* -------------------------------------------------------------------------- */
  /* 240 帧闭环轨迹烘焙（build 期一次性，运行期只取模插值）                     */
  /* -------------------------------------------------------------------------- */

  _bakeAllTrajectories() {
    this._bakeFish();
    this._bakeGroundWalk('reptile', 4);
    this._bakeGroundWalk('mammal', 5);
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

  _bakeGroundWalk(kind, n) {
    const isMammal = kind === 'mammal';
    const bx = 10.8, bz = 9.8;
    const pos = new Float32Array(n * 3);
    let seed = isMammal ? 7705 : 7704;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
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
    const rocks = isMammal
      ? [[-8, -8, 2.4], [8, -8, 2.4], [-8, 8, 2.4], [8, 8, 2.4]]
      : [[-6, -5, 2.2], [5, 4, 2.5], [2, -7, 1.9]];
    for (let f = 0; f < SIM; f += 1) {
      for (let i = 0; i < n; i += 1) {
        const ix = i * 3;
        // 哺乳动物：每 70 帧里前 20 帧间歇停顿（按个体错峰）
        const paused = isMammal && ((f + i * 17) % 70) < 20;
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

  /* -------------------------------------------------------------------------- */
  /* 动物（每类 3 个 InstancedMesh：body / head / limb，共 12 draw call）        */
  /* -------------------------------------------------------------------------- */

  _buildAnimals(G, M) {
    const spec = {
      bird: {
        zone: ZOO_LAYOUT.bird_zone, geo: [G.ico, G.ico, G.box],
        mats: [M.bird, M.white, M.birdWing],
        scale: [[0.34, 0.28, 0.46], [0.20, 0.20, 0.20], [0.62, 0.07, 0.30]],
        off: [[0, 0, 0], [0, 0.06, 0.42], [0, 0.10, 0]],
      },
      fish: {
        zone: ZOO_LAYOUT.marine_zone, geo: [G.ico, G.ico, G.cone],
        mats: [M.fish, M.white, M.fishTail],
        scale: [[0.26, 0.22, 0.50], [0.17, 0.16, 0.17], [0.30, 0.46, 0.30]],
        off: [[0, 0, 0], [0, 0.02, 0.44], [0, 0, -0.56]],
      },
      reptile: {
        zone: ZOO_LAYOUT.reptile_zone, geo: [G.ico, G.ico, G.cone],
        mats: [M.reptile, M.reptile, M.reptileLeg],
        scale: [[0.36, 0.22, 0.58], [0.23, 0.19, 0.24], [0.16, 0.48, 0.16]],
        off: [[0, 0, 0], [0, 0.06, 0.55], [0, 0.02, -0.62]],
      },
      mammal: {
        zone: ZOO_LAYOUT.mammal_zone, geo: [G.ico, G.ico, G.box],
        mats: [M.mammal, M.mammal, M.mammalLeg],
        scale: [[0.44, 0.40, 0.62], [0.27, 0.27, 0.27], [0.15, 0.62, 0.15]],
        off: [[0, 0, 0], [0, 0.36, 0.58], [0, -0.34, 0]],
      },
    };
    /* 【M6】每个物种的「特征件」：鸡冠 / 鸭扁喙 / 鹅长颈 / 狗竖耳+尾 / 龟壳 / 鱼尾鳍。
     * 用第 4 个 InstancedMesh 承载，四区共 16 个 InstancedMesh（≤16 draw call 预算）。 */
    const features = {
      // [geo, mat, scale, offset, 摆动方式] —— 特征件跟随 body 一起移动
      bird: [G.cone, M.birdWing, [0.12, 0.26, 0.12], [0, 0.30, 0.28], 'comb'],
      fish: [G.cone, M.fishTail, [0.30, 0.46, 0.30], [0, 0, -0.56], 'tail'],
      reptile: [G.ico, M.reptileLeg, [0.40, 0.18, 0.50], [0, 0.16, -0.02], 'shell'],
      mammal: [G.cone, M.mammalLeg, [0.14, 0.40, 0.14], [0, 0.50, -0.30], 'ear'],
    };
    // 物种配色（每只动物的 body 用 instanceColor 区分：黄鸡 / 白鸭 / 灰白鹅 / 棕狗…）
    const palette = {
      bird: [0xffd23f, 0xf2f7ff, 0xeaf4ff, 0xffd23f, 0xf2f7ff, 0xeaf4ff, 0xffd23f, 0xf2f7ff],
      fish: null, reptile: null, mammal: null,
    };

    for (const [kind, s] of Object.entries(spec)) {
      const n = s.zone.count;
      const host = this.group.children.find((c) => c.name === `Zoo/${this._zoneKeyOf(kind)}`)
        || this.group;
      const parts = s.geo.map((geo, k) => {
        const im = new THREE.InstancedMesh(geo, s.mats[k], n);
        im.name = `Zoo/${kind}/part-${k}`;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (k === 0 && palette[kind]) {
          for (let i = 0; i < n; i += 1) {
            im.setColorAt(i, new THREE.Color(palette[kind][i % palette[kind].length]));
          }
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
        host.add(im);
        return im;
      });
      // 第 4 个实例网格：物种特征件（鸡冠 / 龟壳 / 狗耳…）
      const f = features[kind];
      const feat = new THREE.InstancedMesh(f[0], f[1], n);
      feat.name = `Zoo/${kind}/feature`;
      feat.frustumCulled = false;
      feat.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      host.add(feat);
      parts.push(feat);
      this._animals.push({ kind, n, zone: s.zone, spec: s, parts, feature: f });
    }
  }

  _zoneKeyOf(kind) {
    return {
      bird: 'bird_zone', fish: 'marine_zone',
      reptile: 'reptile_zone', mammal: 'mammal_zone',
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

  /** 只改 instanceMatrix / 已有对象属性，绝不新建 GPU 资源 */
  update(t) {
    if (!this.group) return;
    this._time = t;
    const phase = ((t % LOOP_SECONDS) / LOOP_SECONDS) * LOOP_FRAMES;
    const p = this._p, q = this._q, s = this._s, e = this._e, m = this._m;
    const local = [0, 0, 0];
    const nxt = [0, 0, 0];

    for (const a of this._animals) {
      const { kind, n, zone, spec, parts, feature } = a;
      const isBird = kind === 'bird';
      const isFish = kind === 'fish';
      for (let i = 0; i < n; i += 1) {
        let lx, ly, lz, yaw, flap;
        if (isBird) {
          // 闭合椭圆环绕飞行 + 上下浮动（纯周期函数）
          // 【M6 修复】周期必须严格 = LOOP_SECONDS(10s)，否则与其余三类
          // 240 帧烘焙表不同步，整场动画在 t=10s 处不闭环（实测误差 10.99m）。
          const th = (t / LOOP_SECONDS) * Math.PI * 2 + (i / n) * Math.PI * 2;
          lx = 9.2 * Math.cos(th);
          lz = 7.0 * Math.sin(th);
          ly = 4.6 + 1.5 * Math.sin(3 * th + i * 0.4);
          // 局部 +Z 为前进方向：绕 Y 旋转 yaw 后 +Z → (sin yaw, 0, cos yaw)
          yaw = Math.atan2(-9.2 * Math.sin(th), 7.0 * Math.cos(th));
          flap = Math.sin(t * 7.5 + i) * 0.65;
        } else {
          this._sample(kind, i, phase, local);
          lx = local[0]; ly = local[1]; lz = local[2];
          // 用下一帧方向求 yaw（烘焙表已闭环，f1 自动回卷）
          const ph2 = (phase + 1) % LOOP_FRAMES;
          this._sample(kind, i, ph2, nxt);
          const dx = nxt[0] - lx, dz = nxt[2] - lz;
          yaw = (dx * dx + dz * dz) > 1e-7 ? Math.atan2(dx, dz) : 0;
          flap = Math.sin(t * (isFish ? 9 : 6) + i * 1.3) * (isFish ? 0.55 : 0.40);
        }

        const wx = zone.cx + lx;
        const wy = BASE_Y + (isFish ? ly : ly);
        const wz = zone.cz + lz;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const rotZ = (x, z) => [x * cy + z * sy, -x * sy + z * cy];

        for (let k = 0; k < 3; k += 1) {
          const [ox, oy, oz] = spec.off[k];
          const [rx, rz] = rotZ(ox, oz);
          p.set(wx + rx, wy + oy, wz + rz);
          e.set(0, yaw, 0);
          if (k === 2) {
            // 翅 / 尾 / 腿：绕局部轴摆动，形成骨骼式循环动画
            if (isBird) e.set(0, yaw, flap);
            else if (isFish) e.set(0, yaw + flap, 0);
            else e.set(flap * 0.5, yaw, 0);
          }
          q.setFromEuler(e);
          s.set(spec.scale[k][0], spec.scale[k][1], spec.scale[k][2]);
          m.compose(p, q, s);
          parts[k].setMatrixAt(i, m);
        }

        // 【M6】物种特征件：鸡冠 / 鸭扁喙 / 鹅长颈 / 狗竖耳 / 龟壳 / 鱼尾鳍
        // 复用同一套 wx/wy/wz/yaw，不新建任何对象，随身体一起循环摆动
        if (feature) {
          const [fgeo, fmat, fscale, foff, fkind] = feature;
          void fgeo; void fmat;
          const [ox, oy, oz] = foff;
          const [rx, rz] = rotZ(ox, oz);
          p.set(wx + rx, wy + oy + (fkind === 'comb' ? 0.04 * Math.sin(t * 3 + i) : 0), wz + rz);
          e.set(0, yaw, 0);
          if (fkind === 'tail') e.set(0, yaw + flap, 0);          // 鱼尾鳍摆动
          else if (fkind === 'comb') e.set(0, yaw, flap * 0.15);  // 鸡冠轻晃
          else if (fkind === 'ear') e.set(flap * 0.3, yaw, 0);    // 狗耳竖动
          q.setFromEuler(e);
          s.set(fscale[0], fscale[1], fscale[2]);
          m.compose(p, q, s);
          parts[3].setMatrixAt(i, m);
        }
      }
      for (const im of parts) im.instanceMatrix.needsUpdate = true;
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
