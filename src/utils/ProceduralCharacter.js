/**
 * ============================================================================
 * ProceduralCharacter.js —— v4 T10 程序化人物工厂（真实比例 / 关节化 / 1 draw call）
 * ============================================================================
 * 背景：旧版 NPCManager 用 CapsuleGeometry(0.30,0.88) + SphereGeometry(0.225)
 *       拼「胶囊人」，JumpJump / ParkourRun 玩家也是低模拼搭，无头发 / 五官 /
 *       两段式四肢。本模块用一套【共享的部件描述】产出两种形态：
 *
 *   ① buildCharacter()      → THREE.Group，带完整 pivot 层级（肩/肘/髋/膝），
 *                             适合玩家等单体角色；调用方每帧旋转 pivot 即可，
 *                             零 new / 零 GC。
 *   ② buildNPCCharacter()   → 一张合并后的 BufferGeometry + 单个材质，
 *                             配合 1 个 InstancedMesh 渲染 10 个 NPC = 1 draw call。
 *                             四肢摆动 / 挥手 / 张望全部在顶点着色器里完成，
 *                             CPU 每帧只写 10×4 个 aAnim 浮点 + 10 个 instanceMatrix。
 *
 * 【为什么不用 SkinnedMesh】three 的 InstancedMesh 不能直接用骨骼；
 *   若每个 NPC 一个 SkinnedMesh 就是 10 draw call，击穿 v3_spec.txt:248
 *   「NPC ≤ 2 draw call」硬约束。因此用「aMeta 编码关节 + aPivot 记录旋转中心
 *   + onBeforeCompile 注入 XYZ 欧拉旋转」把骨骼动画等价搬到 GPU。
 *
 * 【配色策略】几何体里烘焙【亮度 / 材质高光】，衣服 / 裤子 / 皮肤 / 头发四类
 *   主色作为 4 个 InstancedBufferAttribute 按实例传入（aCoat/aPants/aSkin/aHair）。
 *   因此 10 个 NPC 可拥有完全不同的服装与肤色，却仍共享一张几何体、一个材质。
 *   鞋 / 腰带 / 眼睛 / 纽扣等「固定色」直接烘焙进 color 属性（slot=FIXED）。
 *
 * 【资源】buildCharacter 返回的 group.userData.disposables 列出全部
 *   geometry / material，调用方登记到 ctx.registerDisposable 或自身数组即可；
 *   buildNPCCharacter 返回的 geometry / material 由 NPCManager 统一管理。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import modelLoader from './ModelLoader.js';

/* ============================== 常量 ============================== */

/** 关节编号（写入 aMeta 的高 3 位；与 NPCManager 的 WALK/WAVE/LOOK 状态解耦） */
export const JOINTS = Object.freeze({
  HEAD: 0,
  TORSO: 1,
  ARM_L: 2,
  ARM_R: 3,
  LEG_L: 4,
  LEG_R: 5,
  STATIC: 6,
});

/** 调色槽位（写入 aMeta 的低 3 位；4 = 固定色，不走实例调色板） */
const SLOT = Object.freeze({ COAT: 0, PANTS: 1, SKIN: 2, HAIR: 3, FIXED: 4 });
const META_STRIDE = 8;            // aMeta = joint * 8 + slot

/** 7.3 头身成年人基准（米），脚底 y=0 */
const H = 1.78;
const HEAD_RY = 0.122;            // 头半高 → 头高 0.244 → 1.78/0.244 ≈ 7.3 头身
const HEAD_RX = 0.104;
const HEAD_RZ = 0.103;
const HEAD_Y = 1.658;             // 头中心 → 头顶 1.780
const NECK_Y = 1.495;
const SHOULDER_Y = 1.445;
const SHOULDER_X = 0.212;
const ARM_X = 0.226;
const ELBOW_X = 0.238;
const ELBOW_Y = 1.115;
const HIP_Y = 0.925;
const HIP_HALF = 0.082;
const KNEE_Y = 0.505;
const TORSO_Z = 0.72;             // 躯干椭圆截面：z 方向压扁

/** NPC 相对基准的缩放：1.04 × 1.78 ≈ 1.85m，与旧版胶囊人顶部高度一致 */
export const NPC_SCALE = 1.04;

/** 烘焙光照方向（世界/局部空间一致，NPC 不受实时光照影响，夜间也清晰） */
const LIGHT_DIR = new THREE.Vector3(0.42, 0.84, 0.34).normalize();
const HALF_DIR = new THREE.Vector3().addVectors(LIGHT_DIR, new THREE.Vector3(0, 0, 1)).normalize();
const _color = new THREE.Color();
const _normal = new THREE.Vector3();

/** 材质分档：rig 版用 5 个共享 PBR 材质，真实区分布料 / 皮肤 / 皮革 / 金属 / 头发 */
const FINISH_PRESETS = Object.freeze({
  fabric: { roughness: 0.88, metalness: 0.0 },
  skin: { roughness: 0.74, metalness: 0.0 },
  leather: { roughness: 0.44, metalness: 0.03 },
  metal: { roughness: 0.24, metalness: 0.72 },
  hair: { roughness: 0.62, metalness: 0.0 },
});
const FINISHES = Object.keys(FINISH_PRESETS);

/** 风格预设：颜色均为 sRGB 十六进制，由 THREE.Color 自动转线性工作空间 */
export const STYLE_PRESETS = Object.freeze({
  visitor: Object.freeze({
    coat: 0x8a5a44, pants: 0x39434f, skin: 0xe8bd94, hair: 0x3a2b22,
    shoe: 0x302a26, hairStyle: 'short', sleeve: 'long', accessory: 'none',
  }),
  player: Object.freeze({
    coat: 0x3d5673, pants: 0x354052, skin: 0xf0c089, hair: 0x2c211b,
    shoe: 0x242833, hairStyle: 'short', sleeve: 'short', accessory: 'scarf',
  }),
  jumper: Object.freeze({
    coat: 0x2b3038, pants: 0x252a31, skin: 0xe8bd94, hair: 0x241c18,
    shoe: 0x1b1e24, hairStyle: 'short', sleeve: 'long', accessory: 'none',
  }),
});

/** 固定色（不随实例变化，直接烘焙进 color 属性） */
const FIXED_COLORS = Object.freeze({
  belt: 0x3c2a20,
  buckle: 0xc2bca8,
  zipper: 0x9aa0a8,
  button: 0x8f8574,
  collar: 0xe6dfd0,
  cuff: 0xe6dfd0,
  sock: 0xe4ded0,
  eyeWhite: 0xf2eee6,
  pupil: 0x20242c,
  mouth: 0x8a4a44,
  cap: 0x2f4858,
  glass: 0x2a2a2e,
  bag: 0x5a5148,
  strap: 0x4a423a,
  scarf: 0xb8493f,
});

/* ======================= 几何体小工具（绝对坐标） ======================= */

/** 统一构建：缩放 → 旋转 → 平移，返回已落到角色局部绝对坐标的几何体 */
function xform(geo, { sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0 } = {}) {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  if (x || y || z) geo.translate(x, y, z);
  return geo;
}

function ellipsoid(rx, ry, rz, x = 0, y = 0, z = 0, _segW, _segH) {
  // 【面数预算】按部件尺寸自适应分段：微小五官 6×4 / 中等 7×5 / 大块 8×6。
  // 调用点保留的可选段数参数被统一忽略，便于一处控制 10 NPC 的三角面总量。
  const size = Math.max(rx, ry, rz);
  const segW = size < 0.025 ? 6 : size < 0.15 ? 7 : 8;
  const segH = size < 0.025 ? 4 : size < 0.15 ? 5 : 6;
  const g = new THREE.SphereGeometry(1, segW, segH);
  return xform(g, { sx: rx, sy: ry, sz: rz, x, y, z });
}

function capsule(r, len, x = 0, y = 0, z = 0, _radial, _cap) {
  // 低模童话风：六边截面 + 2 段端帽，四肢仍有圆润轮廓但面数减半
  const g = new THREE.CapsuleGeometry(r, len, 2, 6);
  return xform(g, { x, y, z });
}

function box(w, h, d, x = 0, y = 0, z = 0, rz = 0, rx = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  return xform(g, { x, y, z, rz, rx });
}

function cyl(rt, rb, h, x = 0, y = 0, z = 0, _seg = 12, open = false, sz = 1) {
  // 衣领/袖口/袜子等小圆柱统一 6 边，足够在低模风格下保持轮廓
  const g = new THREE.CylinderGeometry(rt, rb, h, 6, 1, open);
  return xform(g, { sz, x, y, z });
}

function torus(r, tube, x = 0, y = 0, z = 0, arc = Math.PI * 2, sx = 1, sy = 1) {
  const g = new THREE.TorusGeometry(r, tube, 3, 8, arc);
  return xform(g, { rx: Math.PI / 2, sx, sy, x, y, z });
}

/** 头部：球体下半段收窄成下巴，并让下唇方向微凸，避免「外星人圆头」 */
function headGeometry() {
  const g = new THREE.SphereGeometry(1, 12, 9);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const nx = pos.getX(i), ny = pos.getY(i), nz = pos.getZ(i);
    const jaw = ny < 0 ? 1 + ny * 0.26 : 1;
    const chin = ny < -0.35 ? (-ny - 0.35) * 0.16 : 0;
    pos.setXYZ(i, nx * HEAD_RX * jaw, ny * HEAD_RY, nz * HEAD_RZ * jaw + chin * HEAD_RZ);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, HEAD_Y, 0);
  return g;
}

/** 躯干：LatheGeometry 旋转出肩宽腰细的椭圆截面（z 压扁 0.72） */
function torsoGeometry() {
  const profile = [
    [0.105, 0.885], [0.152, 0.905], [0.160, 0.950], [0.152, 1.010],
    [0.142, 1.075], [0.150, 1.160], [0.176, 1.300], [0.198, 1.395],
    [0.185, 1.445], [0.080, 1.472], [0.000, 1.480],
  ];
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 10);
  g.scale(1, 1, TORSO_Z);
  return g;
}

/** 头顶半球（发帽 / 帽子通用） */
function hairCap(scale = 1.055, theta = Math.PI * 0.42) {
  const g = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, theta);
  return xform(g, {
    sx: HEAD_RX * scale, sy: HEAD_RY * scale, sz: HEAD_RZ * scale,
    x: 0, y: HEAD_Y, z: 0,
  });
}

/* ======================= 顶点属性烘焙 ======================= */

/**
 * 给部件几何体写入 color / aMeta / aPivot。
 *  - mode='rig'：color = 真实基色（线性），由 MeshStandardMaterial 打光；
 *  - mode='npc'：color = 烘焙的亮度（固定色部件为 基色×亮度），主色交给实例调色板。
 * @param {THREE.BufferGeometry} geo
 * @param {{color:number, finish:string, slot:number, joint:number,
 *          pivot:number[], mode:string}} cfg
 * @returns {THREE.BufferGeometry}
 */
function paint(geo, cfg) {
  const { color: colorHex, finish, slot, joint, pivot, mode } = cfg;
  const count = geo.attributes.position.count;
  const normals = geo.attributes.normal;
  const colors = new Float32Array(count * 3);
  const meta = new Float32Array(count);
  const pivots = new Float32Array(count * 3);
  const metaValue = joint * META_STRIDE + slot;
  const fixed = slot === SLOT.FIXED;
  _color.setHex(colorHex);
  const br = _color.r, bg = _color.g, bb = _color.b;

  for (let i = 0; i < count; i += 1) {
    let shade = 1;
    if (mode === 'npc' && normals) {
      _normal.fromBufferAttribute(normals, i);
      const diffuse = Math.max(0, _normal.dot(LIGHT_DIR));
      shade = 0.60 + 0.40 * diffuse;
      const spec = Math.pow(Math.max(0, _normal.dot(HALF_DIR)), 20);
      if (finish === 'metal') shade += 0.78 * spec;
      else if (finish === 'leather') shade += 0.26 * spec;
      else if (finish === 'hair') shade += 0.20 * spec;
      else if (finish === 'skin') shade += 0.08 * spec;
      // 底部略暗，模拟地面环境遮蔽
      shade *= 0.90 + 0.10 * Math.max(0, _normal.y * 0.5 + 0.5);
    }
    if (mode === 'npc' && !fixed) {
      // 主色部件：仅烘焙亮度，调色板在 shader 中相乘
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade;
      colors[i * 3 + 2] = shade;
    } else {
      // rig 全色 / npc 固定色：真实基色 × 亮度
      colors[i * 3] = Math.min(1, br * shade);
      colors[i * 3 + 1] = Math.min(1, bg * shade);
      colors[i * 3 + 2] = Math.min(1, bb * shade);
    }
    meta[i] = metaValue;
    pivots[i * 3] = pivot[0];
    pivots[i * 3 + 1] = pivot[1];
    pivots[i * 3 + 2] = pivot[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 1));
  geo.setAttribute('aPivot', new THREE.BufferAttribute(pivots, 3));
  return geo;
}

/* ======================= 共享部件描述 ======================= */

const PIVOTS = Object.freeze({
  torso: [0, HIP_Y, 0],
  head: [0, NECK_Y, 0],
  armL: [-SHOULDER_X, SHOULDER_Y, 0],
  armR: [SHOULDER_X, SHOULDER_Y, 0],
  legL: [-HIP_HALF, HIP_Y, 0],
  legR: [HIP_HALF, HIP_Y, 0],
});

/**
 * 构造人物全部部件。每个部件的 geometry 已在「角色局部绝对坐标」中摆好，
 * 并携带 color / aMeta / aPivot；rig 与 NPC 两条路径共用同一份描述，
 * 因此两种形态的外观完全一致（仅着色方式不同）。
 *
 * @param {Object} opts 颜色 / 发型 / 袖长 / 配饰
 * @param {'rig'|'npc'} mode
 * @returns {Array<{geometry:THREE.BufferGeometry, finish:string,
 *                  attach:string, name:string}>}
 */
function collectParts(opts, mode) {
  const pal = { ...STYLE_PRESETS.visitor, ...(opts.palette || {}) };
  const parts = [];
  /**
   * NPC shader 只按【主关节】旋转：前臂随整条手臂绕肩、小腿随整条腿绕髋。
   * 【踩坑】attach 是 rig 层级用的 pivot 名（含 elbowL/kneeL），绝不能直接
   * 当作 shader 旋转中心 —— PIVOTS 里没有这些键，会回退 [0,0,0]，
   * 于是前臂/小腿绕脚底甩飞，出现「断臂悬浮」（实测截图抓到）。
   */
  const JOINT_PIVOT = {
    [JOINTS.HEAD]: PIVOTS.head,
    [JOINTS.TORSO]: PIVOTS.torso,
    [JOINTS.ARM_L]: PIVOTS.armL,
    [JOINTS.ARM_R]: PIVOTS.armR,
    [JOINTS.LEG_L]: PIVOTS.legL,
    [JOINTS.LEG_R]: PIVOTS.legR,
  };
  /** 注册一个部件 */
  const add = (geometry, name, finish, slot, joint, attach, colorHex) => {
    paint(geometry, {
      color: colorHex, finish, slot, joint,
      pivot: JOINT_PIVOT[joint] || [0, 0, 0],
      mode,
    });
    parts.push({ geometry, name, finish, attach });
  };
  const C = (key) => FIXED_COLORS[key];

  /* ---------------- 躯干 / 腰 / 领 / 配件 ---------------- */
  add(torsoGeometry(), 'torso', 'fabric', SLOT.COAT, JOINTS.TORSO, 'torso', pal.coat);
  add(cyl(0.052, 0.058, 0.10, 0, NECK_Y + 0.005, 0, 12, false, 0.86),
    'neck', 'skin', SLOT.SKIN, JOINTS.TORSO, 'torso', pal.skin);
  // 腰带（绕 Y 轴的水平环，z 压扁匹配躯干）
  add(torus(0.152, 0.016, 0, 1.075, 0, Math.PI * 2, 1, TORSO_Z),
    'belt', 'leather', SLOT.FIXED, JOINTS.TORSO, 'torso', C('belt'));
  add(box(0.050, 0.038, 0.014, 0, 1.075, 0.116),
    'buckle', 'metal', SLOT.FIXED, JOINTS.TORSO, 'torso', C('buckle'));
  for (const s of [-1, 1]) {
    add(box(0.058, 0.052, 0.012, s * 0.048, 1.452, 0.055, -s * 0.38),
      `collar${s}`, 'fabric', SLOT.FIXED, JOINTS.TORSO, 'torso', C('collar'));
    add(box(0.062, 0.068, 0.010, s * 0.095, 1.205, 0.104),
      `pocket${s}`, 'fabric', SLOT.COAT, JOINTS.TORSO, 'torso', pal.coat);
  }
  add(box(0.012, 0.22, 0.010, 0, 1.265, 0.117),
    'zipper', 'metal', SLOT.FIXED, JOINTS.TORSO, 'torso', C('zipper'));
  // 单颗胸口纽扣即可读作「有衣饰」，三颗小到 NPC 距离根本看不见且白耗面数
  add(ellipsoid(0.009, 0.009, 0.006, 0, 1.310, 0.124),
    'button', 'metal', SLOT.FIXED, JOINTS.TORSO, 'torso', C('button'));
  if (pal.accessory === 'backpack') {
    add(box(0.200, 0.260, 0.105, 0, 1.215, -0.135),
      'backpack', 'fabric', SLOT.FIXED, JOINTS.TORSO, 'torso', C('bag'));
    for (const s of [-1, 1]) {
      add(box(0.028, 0.320, 0.014, s * 0.090, 1.270, 0.100, 0, 0.10),
        `strap${s}`, 'fabric', SLOT.FIXED, JOINTS.TORSO, 'torso', C('strap'));
    }
  }
  if (pal.accessory === 'scarf') {
    add(torus(0.072, 0.020, 0, 1.472, 0, Math.PI * 2, 1, 0.80),
      'scarf', 'fabric', SLOT.FIXED, JOINTS.TORSO, 'torso', C('scarf'));
    for (const s of [-1, 1]) {
      add(box(0.044, 0.150, 0.016, s * 0.050, 1.380, 0.098, s * 0.12),
        `scarfTail${s}`, 'fabric', SLOT.FIXED, JOINTS.TORSO, 'torso', C('scarf'));
    }
  }

  /* ---------------- 头 / 五官 / 头发 ---------------- */
  add(headGeometry(), 'head', 'skin', SLOT.SKIN, JOINTS.HEAD, 'head', pal.skin);
  for (const s of [-1, 1]) {
    add(ellipsoid(0.014, 0.026, 0.018, s * 0.104, HEAD_Y - 0.006, 0, 8, 7),
      `ear${s}`, 'skin', SLOT.SKIN, JOINTS.HEAD, 'head', pal.skin);
    // 眼白 + 瞳孔
    add(ellipsoid(0.021, 0.015, 0.010, s * 0.041, HEAD_Y + 0.020, 0.094),
      `eyeWhite${s}`, 'fabric', SLOT.FIXED, JOINTS.HEAD, 'head', C('eyeWhite'));
    add(ellipsoid(0.009, 0.011, 0.006, s * 0.041, HEAD_Y + 0.020, 0.104),
      `pupil${s}`, 'fabric', SLOT.FIXED, JOINTS.HEAD, 'head', C('pupil'));
    // 眉毛（跟随发色）
    add(box(0.042, 0.008, 0.010, s * 0.042, HEAD_Y + 0.055, 0.096, -s * 0.10),
      `brow${s}`, 'hair', SLOT.HAIR, JOINTS.HEAD, 'head', pal.hair);
    // 鬓角在 NPC 距离不可辨，省下两个部件的面数给头发/五官主体
  }
  // 鼻子（圆锥指向 +Z）
  add(xform(new THREE.ConeGeometry(0.017, 0.050, 6), { rx: Math.PI / 2, x: 0, y: HEAD_Y - 0.015, z: 0.104 }),
    'nose', 'skin', SLOT.SKIN, JOINTS.HEAD, 'head', pal.skin);
  // 微笑嘴（半环翻转成向下弧）
  add(xform(new THREE.TorusGeometry(0.026, 0.004, 5, 12, Math.PI),
    { rz: Math.PI, sx: 1, sy: 0.55, x: 0, y: HEAD_Y - 0.055, z: 0.096 }),
    'mouth', 'fabric', SLOT.FIXED, JOINTS.HEAD, 'head', C('mouth'));
  // 嘴部半环已足够读作微笑，省略下唇高光（NPC 尺寸不可辨）

  // 发型
  if (pal.hairStyle === 'cap') {
    add(hairCap(1.070, Math.PI * 0.52), 'capCrown', 'fabric', SLOT.FIXED, JOINTS.HEAD, 'head', C('cap'));
    add(ellipsoid(0.105, 0.008, 0.062, 0, HEAD_Y + 0.052, 0.112, 14, 8),
      'capBrim', 'fabric', SLOT.FIXED, JOINTS.HEAD, 'head', C('cap'));
  } else {
    add(hairCap(), 'hairCap', 'hair', SLOT.HAIR, JOINTS.HEAD, 'head', pal.hair);
    add(ellipsoid(0.030, 0.024, 0.020, -0.055, HEAD_Y + 0.045, 0.088, 9, 7),
      'fringeL', 'hair', SLOT.HAIR, JOINTS.HEAD, 'head', pal.hair);
    add(ellipsoid(0.032, 0.026, 0.020, 0.018, HEAD_Y + 0.055, 0.096),
      'fringeM', 'hair', SLOT.HAIR, JOINTS.HEAD, 'head', pal.hair);
    if (pal.hairStyle === 'bob') {
      add(cyl(0.112, 0.118, 0.130, 0, HEAD_Y - 0.055, 0, 14, true, 0.95),
        'hairBob', 'hair', SLOT.HAIR, JOINTS.HEAD, 'head', pal.hair);
    } else if (pal.hairStyle === 'bun') {
      add(ellipsoid(0.045, 0.045, 0.045, 0, HEAD_Y + 0.122, -0.045, 10, 8),
        'hairBun', 'hair', SLOT.HAIR, JOINTS.HEAD, 'head', pal.hair);
    }
  }
  if (pal.accessory === 'glasses') {
    for (const s of [-1, 1]) {
      add(xform(new THREE.TorusGeometry(0.027, 0.0045, 5, 12),
        { sz: 0.5, x: s * 0.041, y: HEAD_Y + 0.020, z: 0.105 }),
        `glass${s}`, 'metal', SLOT.FIXED, JOINTS.HEAD, 'head', C('glass'));
      add(box(0.006, 0.006, 0.070, s * 0.103, HEAD_Y + 0.022, 0.055, 0, s * 0.10),
        `temple${s}`, 'metal', SLOT.FIXED, JOINTS.HEAD, 'head', C('glass'));
    }
    add(box(0.028, 0.004, 0.004, 0, HEAD_Y + 0.022, 0.108),
      'glassBridge', 'metal', SLOT.FIXED, JOINTS.HEAD, 'head', C('glass'));
  }

  /* ---------------- 手臂（肩 / 肘两个 pivot） ---------------- */
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const joint = s < 0 ? JOINTS.ARM_L : JOINTS.ARM_R;
    const ax = s * ARM_X, ex = s * ELBOW_X;
    add(ellipsoid(0.068, 0.062, 0.066, s * SHOULDER_X, SHOULDER_Y - 0.012, 0, 10, 8),
      `shoulder${side}`, 'fabric', SLOT.COAT, joint, `arm${side}`, pal.coat);
    add(capsule(0.058, 0.220, ax, 1.270, 0, 9, 3),
      `upperArm${side}`, 'fabric', SLOT.COAT, joint, `arm${side}`, pal.coat);
    add(ellipsoid(0.049, 0.049, 0.049, ex, ELBOW_Y, 0, 9, 7),
      `elbow${side}`, 'fabric', SLOT.COAT, joint, `arm${side}`, pal.coat);
    // 前臂：长袖=衣色，短袖=肤色
    const forearmSlot = pal.sleeve === 'short' ? SLOT.SKIN : SLOT.COAT;
    const forearmColor = pal.sleeve === 'short' ? pal.skin : pal.coat;
    add(capsule(0.044, 0.162, ex + s * 0.004, 0.990, 0, 9, 3),
      `forearm${side}`, pal.sleeve === 'short' ? 'skin' : 'fabric',
      forearmSlot, joint, `elbow${side}`, forearmColor);
    add(cyl(0.053, 0.050, 0.032, ex + s * 0.004, 0.882, 0, 10),
      `cuff${side}`, 'fabric', SLOT.FIXED, joint, `elbow${side}`, C('cuff'));
    add(ellipsoid(0.042, 0.062, 0.030, ex + s * 0.008, 0.822, 0.006, 9, 7),
      `hand${side}`, 'skin', SLOT.SKIN, joint, `elbow${side}`, pal.skin);
    add(ellipsoid(0.018, 0.026, 0.018, ex - s * 0.030, 0.830, 0.028, 8, 6),
      `thumb${side}`, 'skin', SLOT.SKIN, joint, `elbow${side}`, pal.skin);
  }

  /* ---------------- 腿（髋 / 膝两个 pivot） ---------------- */
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const joint = s < 0 ? JOINTS.LEG_L : JOINTS.LEG_R;
    const lx = s * HIP_HALF;
    add(capsule(0.072, 0.276, lx, 0.715, 0, 10, 3),
      `thigh${side}`, 'fabric', SLOT.PANTS, joint, `leg${side}`, pal.pants);
    add(ellipsoid(0.062, 0.062, 0.062, lx + s * 0.003, KNEE_Y, 0, 9, 7),
      `knee${side}`, 'fabric', SLOT.PANTS, joint, `leg${side}`, pal.pants);
    add(capsule(0.056, 0.278, lx + s * 0.005, 0.302, 0, 9, 3),
      `shin${side}`, 'fabric', SLOT.PANTS, joint, `knee${side}`, pal.pants);
    add(cyl(0.058, 0.055, 0.085, lx + s * 0.005, 0.148, 0, 10),
      `sock${side}`, 'fabric', SLOT.FIXED, joint, `knee${side}`, C('sock'));
    add(ellipsoid(0.080, 0.052, 0.132, lx + s * 0.005, 0.053, 0.042, 10, 8),
      `shoe${side}`, 'leather', SLOT.FIXED, joint, `knee${side}`, pal.shoe);
    add(box(0.166, 0.016, 0.272, lx + s * 0.005, 0.010, 0.042),
      `sole${side}`, 'leather', SLOT.FIXED, joint, `knee${side}`, 0x1e2025);
  }

  return parts;
}

/* ======================= 合并工具 ======================= */

/** 合并全部部件为一张几何体；源几何体合并后立即释放（从未上传 GPU） */
function mergeAll(parts) {
  const sources = parts.map((p) => p.geometry);
  const merged = mergeGeometries(sources, false);
  if (!merged) throw new Error('[ProceduralCharacter] mergeGeometries 失败：属性不一致');
  for (const g of sources) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * 按 (attach, finish) 分组分别合并，得到「每个 pivot 每类材质一张几何体」。
 * 这样玩家模型既有分级 pivot 动画，又把 draw call 控制在十几以内。
 */
function mergeByPivot(parts, disposables) {
  const groups = new Map();
  for (const p of parts) {
    const key = `${p.attach}|${p.finish}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.geometry);
  }
  const result = new Map();
  for (const [key, sources] of groups) {
    let geometry = null;
    if (sources.length === 1) {
      geometry = sources[0];
    } else {
      geometry = mergeGeometries(sources, false);
      if (!geometry) throw new Error(`[ProceduralCharacter] 分组 ${key} 合并失败`);
      for (const g of sources) g.dispose();
    }
    geometry.computeBoundingSphere();
    disposables.geometries.push(geometry);
    result.set(key, geometry);
  }
  return result;
}

/* ======================= NPC 顶点动画 shader ======================= */

/** 顶点着色器前置声明（所有属性在 InstancedMesh 上按实例/divisor 绑定） */
const NPC_VERT_DECL = `
uniform float uTime;    // 全局时钟（呼吸 / 挥手抖动），由 NPCManager 每帧写入
attribute float aMeta;
attribute vec3 aPivot;
attribute vec4 aAnim;   // x:走路相位  y:走路权重  z:挥手权重  w:张望偏航
attribute vec3 aCoat;
attribute vec3 aPants;
attribute vec3 aSkin;
attribute vec3 aHair;
`;

/**
 * 取代 <color_vertex>：按 aMeta 低 3 位选择实例调色板，再乘烘焙亮度。
 * 【r187 注意】color_pars_vertex 声明的是 `varying vec4 vColor`（不是 vec3！），
 * 因此必须先赋 vec4(1.0) 再改 .rgb，否则 GLSL 类型不匹配 → 整批 NPC 黑屏。
 */
const NPC_COLOR_VERTEX = `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  float _slot = mod(aMeta, 8.0);
  vec3 _pal = vec3(1.0);
  if (_slot < 0.5)       _pal = aCoat;
  else if (_slot < 1.5)  _pal = aPants;
  else if (_slot < 2.5)  _pal = aSkin;
  else if (_slot < 3.5)  _pal = aHair;
  vColor.rgb = color * _pal;
  vColor.a = 1.0;
#endif
`;

/** 取代 <begin_vertex>：按关节绕 pivot 做 XYZ 欧拉旋转（等价程序化骨骼） */
const NPC_BEGIN_VERTEX = `
vec3 transformed = vec3( position );
{
  float _joint = floor(aMeta / 8.0);
  float _t = aAnim.x;
  float _walk = aAnim.y;
  float _wave = aAnim.z;
  float _look = aAnim.w;
  // _t 已是弧度相位（n.bob 每帧 +dt*(6+speed*2)），故 sin(_t) 即在正确步频；
  // 呼吸与挥手抖动用全局时钟 uTime，避免与步频耦合导致「抽搐」。
  float _s = sin(_t) * 0.52 * _walk;
  float _breath = sin(uTime * 1.6);
  vec3 _rot = vec3(0.0);
  if (_joint < 0.5) {                 // HEAD：呼吸微点 + 张望偏航
    _rot = vec3(_breath * 0.012, _look, 0.0);
  } else if (_joint < 1.5) {          // TORSO：半步频左右轻摆
    _rot = vec3(_breath * 0.006, sin(_t * 0.5) * 0.05 * _walk, 0.0);
  } else if (_joint < 2.5) {          // ARM_L：与左腿反相摆动
    _rot = vec3(-_s, 0.0, 0.0);
  } else if (_joint < 3.5) {          // ARM_R：摆动 + 迎宾挥手（抬臂 + 抖动）
    float _raise = _wave * (2.05 + 0.16 * sin(uTime * 7.0));
    _rot = vec3(_s + _wave * 0.14 * sin(uTime * 7.0 + 1.0), 0.0, _raise);
  } else if (_joint < 4.5) {          // LEG_L
    _rot = vec3(_s, 0.0, 0.0);
  } else if (_joint < 5.5) {          // LEG_R
    _rot = vec3(-_s, 0.0, 0.0);
  }
  vec3 _v = transformed - aPivot;
  float _cx = cos(_rot.x), _sx = sin(_rot.x);
  _v = vec3(_v.x, _v.y * _cx - _v.z * _sx, _v.y * _sx + _v.z * _cx);
  float _cy = cos(_rot.y), _sy = sin(_rot.y);
  _v = vec3(_v.x * _cy + _v.z * _sy, _v.y, -_v.x * _sy + _v.z * _cy);
  float _cz = cos(_rot.z), _sz = sin(_rot.z);
  _v = vec3(_v.x * _cz - _v.y * _sz, _v.x * _sz + _v.y * _cz, _v.z);
  transformed = aPivot + _v;
}
`;

/**
 * 创建 NPC 单材质。MeshBasicMaterial 不依赖实时光照 → 夜间同样清晰
 * （沿用旧 NPCManager 的取舍），但顶点色里已烘焙方向光 / 高光 / AO，
 * 因此并非「纯色剪纸」，仍有体积感。
 * @returns {THREE.MeshBasicMaterial}
 */
export function createNPCMaterial() {
  // 全局时钟 uniform：在 onBeforeCompile 里挂到 shader.uniforms，
  // NPCManager 每帧写 .value 即可驱动呼吸 / 挥手，不占实例属性槽。
  const timeUniform = { value: 0 };
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    toneMapped: false,
    fog: true,
  });
  material.name = 'ProceduralCharacter/NPC';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = NPC_VERT_DECL + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', NPC_COLOR_VERTEX);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', NPC_BEGIN_VERTEX);
  };
  // 避免与其它 MeshBasicMaterial 复用同一 program（否则缺少自定义属性声明）
  material.customProgramCacheKey = () => 'procedural-character-npc-v1';
  material.userData.timeUniform = timeUniform;
  return material;
}

/* ======================= 对外工厂 ①：玩家 rig ======================= */

/**
 * 构建一个带完整关节层级的角色（单体玩家用）。
 *
 * 层级：group（scale 恒为 1）→ body（承载 options.scale）
 *          → torso → head / armL → elbowL / armR → elbowR
 *          → legL → kneeL / legR → kneeR
 * 每个 mesh 的 position = -父 pivot 的绝对坐标，因此几何体仍用「角色绝对坐标」
 * 描述，旋转 pivot 即可自然带动下游部件，无需逐帧 new 任何对象。
 *
 * @param {{style?:string, palette?:Object, scale?:number,
 *          hairStyle?:string, sleeve?:string, accessory?:string,
 *          name?:string}} [options]
 * @returns {THREE.Group} group.userData.rig / .disposables / .palette
 */
export function buildCharacter(options = {}) {
  const style = options.style || 'visitor';
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS.visitor;
  const opts = { palette: { ...preset, ...(options.palette || {}) } };
  const disposables = { geometries: [], materials: [] };
  const parts = collectParts(opts, 'rig');

  const group = new THREE.Group();
  group.name = options.name || `ProceduralCharacter/${style}`;
  group.userData.absPos = [0, 0, 0];
  // 【外层 group 恒为 scale=1】调用方（JumpJump 每局 scale.set(1,1,1) /
  // 蓄力压扁）直接操作外层不会覆盖人物基准尺寸；尺寸放在内层 body。
  const body = new THREE.Group();
  body.name = 'character-body';
  body.userData.absPos = [0, 0, 0];
  group.add(body);

  /** 创建 pivot：相对父级定位，并记录绝对坐标供 mesh 反偏移 */
  const mk = (name, abs, parent) => {
    const g = new THREE.Group();
    g.name = `pivot/${name}`;
    g.userData.absPos = abs;
    const pp = parent.userData.absPos;
    g.position.set(abs[0] - pp[0], abs[1] - pp[1], abs[2] - pp[2]);
    parent.add(g);
    return g;
  };
  const torso = mk('torso', PIVOTS.torso, body);
  const head = mk('head', PIVOTS.head, torso);
  const rig = {
    root: group,
    body,
    torso,
    head,
    legL: mk('legL', PIVOTS.legL, body),
    legR: mk('legR', PIVOTS.legR, body),
  };
  for (const side of ['L', 'R']) {
    rig[`arm${side}`] = mk(`arm${side}`, PIVOTS[`arm${side}`], torso);
    rig[`elbow${side}`] = mk(`elbow${side}`,
      [side === 'L' ? -ELBOW_X : ELBOW_X, ELBOW_Y, 0], rig[`arm${side}`]);
    rig[`knee${side}`] = mk(`knee${side}`,
      [side === 'L' ? -HIP_HALF : HIP_HALF, KNEE_Y, 0], rig[`leg${side}`]);
  }

  // 每个 finish 一个共享 PBR 材质（vertexColors 提供逐部件颜色）
  const materials = {};
  for (const finish of FINISHES) {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: FINISH_PRESETS[finish].roughness,
      metalness: FINISH_PRESETS[finish].metalness,
    });
    m.name = `ProceduralCharacter/${finish}`;
    materials[finish] = m;
    disposables.materials.push(m);
  }

  // 按 (pivot, finish) 合并 → 每类材质每关节一张几何体
  const grouped = mergeByPivot(parts, disposables);
  for (const [key, geometry] of grouped) {
    const [attach, finish] = key.split('|');
    const pivot = rig[attach];
    const mesh = new THREE.Mesh(geometry, materials[finish]);
    const p = pivot.userData.absPos;
    mesh.position.set(-p[0], -p[1], -p[2]);
    mesh.castShadow = true;
    mesh.name = `part/${key}`;
    pivot.add(mesh);
  }

  body.scale.setScalar(options.scale ?? 1);
  group.userData.rig = rig;
  group.userData.disposables = disposables;
  group.userData.palette = opts.palette;
  group.userData.height = H * (options.scale ?? 1);
  return group;
}

/* ======================= 对外工厂 ②：NPC 单几何体 ======================= */

/**
 * 构建 10 个 NPC 共享的「一张几何体 + 一个材质 + 5 个实例属性」。
 * render 时只需 1 个 InstancedMesh = 1 draw call；动作由 GPU 顶点着色器完成。
 *
 * @param {{count?:number, palette?:Object}} [options]
 *        palette 为共享风格预设；逐实例配色由调用方随后 setOutfit() 写入。
 * @returns {{geometry:THREE.BufferGeometry, material:THREE.Material,
 *            timeUniform:{value:number},
 *            attributes:{aAnim:THREE.InstancedBufferAttribute,
 *                        aCoat:THREE.InstancedBufferAttribute,
 *                        aPants:THREE.InstancedBufferAttribute,
 *                        aSkin:THREE.InstancedBufferAttribute,
 *                        aHair:THREE.InstancedBufferAttribute},
 *            setOutfit:(i:number,o:{coat:number,pants:number,skin:number,hair:number})=>void,
 *            flushPalette:()=>void,
 *            count:number, height:number}}
 */
export function buildNPCCharacter(options = {}) {
  const count = options.count || 10;
  const parts = collectParts({ palette: options.palette || STYLE_PRESETS.visitor }, 'npc');
  const geometry = mergeAll(parts);
  // MeshBasicMaterial 无 envMap / map，法线与 uv 只用内存、不进 shader
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');

  const aAnim = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
  aAnim.setUsage(THREE.DynamicDrawUsage);
  const aCoat = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const aPants = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const aSkin = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const aHair = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  for (const [name, attr] of Object.entries({ aAnim, aCoat, aPants, aSkin, aHair })) {
    geometry.setAttribute(name, attr);
  }

  /** 把 sRGB 十六进制写进实例属性（THREE.Color 自动转线性工作空间） */
  const writeColor = (attr, index, hex) => {
    _color.setHex(hex);
    const o = index * 3;
    attr.array[o] = _color.r;
    attr.array[o + 1] = _color.g;
    attr.array[o + 2] = _color.b;
  };
  const setOutfit = (index, outfit) => {
    if (index < 0 || index >= count || !outfit) return;
    writeColor(aCoat, index, outfit.coat ?? STYLE_PRESETS.visitor.coat);
    writeColor(aPants, index, outfit.pants ?? STYLE_PRESETS.visitor.pants);
    writeColor(aSkin, index, outfit.skin ?? STYLE_PRESETS.visitor.skin);
    writeColor(aHair, index, outfit.hair ?? STYLE_PRESETS.visitor.hair);
  };
  const flushPalette = () => {
    aCoat.needsUpdate = true;
    aPants.needsUpdate = true;
    aSkin.needsUpdate = true;
    aHair.needsUpdate = true;
  };

  const material = createNPCMaterial();
  return {
    geometry,
    material,
    timeUniform: material.userData.timeUniform,
    attributes: { aAnim, aCoat, aPants, aSkin, aHair },
    setOutfit,
    flushPalette,
    count,
    height: H,
  };
}

/**
 * 释放 buildCharacter() 产出的全部 GPU 资源（幂等由调用方保证）。
 * 注意：JumpJump / ParkourRun 会把这些资源同时登记进自身数组与
 * ctx.registerDisposable，两边都会调用 dispose；Three.js 的 dispose 幂等。
 * @param {THREE.Group} group buildCharacter() 的返回值
 */
export function disposeCharacter(group) {
  const d = group?.userData?.disposables;
  if (!d) return;
  for (const g of d.geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
  for (const m of d.materials) { try { m.dispose(); } catch (e) { /* noop */ } }
  d.geometries.length = 0;
  d.materials.length = 0;
}

/**
 * 【可选 · 默认不调用】登记 buddy-multimodal-generation 产出的游客群像 GLB。
 *
 * 实测结论：模型可用但【不适合】接入大厅 NPC —— 32.07MB / 单 Mesh 内含 7 个
 * Q 版儿童 / 18,305 面 / 0 骨骼 0 动画 / 无 instanceColor 通道。接入会击穿
 * 「NPC ≤2 draw call」「首屏体积」「7 头身写实比例」三项约束。故程序化人物
 * 仍是运行时主线，本函数只作为美术对照 / 未来静态展台的接入示例。
 *
 * 用法（仅在确认需要时调用）：
 *   const url = registerGeneratedVisitorAsset();
 *   const { scene, fallback } = await modelLoader.loadOrFallback(url, () => new THREE.Group());
 *
 * 【部署注意】此处用变量拼路径，Vite 不会把 32MB 资产复制进 dist（保持产物体积）。
 * dev 下可解析到 src/assets/models/；生产环境请把该 GLB 移到 public/models/
 * 并把下面的相对路径改为 '/models/visitor-ai.glb'。
 *
 * @returns {string} 已登记到 modelLoader.available 的资产 URL
 */
export function registerGeneratedVisitorAsset() {
  const relative = ['..', 'assets', 'models', 'visitor-ai.glb'].join('/');
  const url = new URL(relative, import.meta.url).href;
  modelLoader.registerAsset(url);
  return url;
}

export default {
  buildCharacter,
  buildNPCCharacter,
  createNPCMaterial,
  disposeCharacter,
  registerGeneratedVisitorAsset,
  STYLE_PRESETS,
  JOINTS,
  NPC_SCALE,
};
