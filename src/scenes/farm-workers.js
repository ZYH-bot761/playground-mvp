/**
 * ============================================================================
 * FarmWorkers.js —— 阶段二：弯腰插秧 / 挥锄头农民
 * ============================================================================
 * 5 名农民全部用「分关节合并几何 + InstancedMesh」绘制：
 *   - 3 名插秧农民：弯腰角度与左右手交替下探，形成插—抬—退的动作循环；
 *   - 2 名锄地农民：右臂抬锄过肩、落下发力，左臂扶柄，身体随动作前倾。
 *
 * 角色组位于 farm detail 内，实例矩阵以农场中心为局部原点；
 * Districts._rebase 只移动 group.position，因此动作坐标不受重定位影响。
 * 热路径仅写 instanceMatrix，不新建 geometry / material / texture。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const FARM_WORKERS = Object.freeze({
  planters: 3,
  hoers: 2,
  total: 5,
  cycle: Object.freeze({ planter: 5.2, hoer: 6.8 }),
});

const BASE_Y = 1.12;
const HIP_Y = 0.86;

function paint(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function box(hex, x, y, z, sx, sy, sz, rz = 0) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.scale(sx, sy, sz);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return paint(g, hex);
}
function sphere(hex, x, y, z, sx, sy, sz) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return paint(g, hex);
}
function cyl(hex, x, y, z, r, h) {
  const g = new THREE.CylinderGeometry(r, r * 1.15, h, 6);
  g.translate(x, y, z);
  return paint(g, hex);
}
function merge(parts, label) {
  const normalized = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(normalized, false);
  if (!g) throw new Error(`[FarmWorkers] ${label} merge 失败`);
  g.computeBoundingSphere();
  parts.forEach((p) => p.dispose());
  normalized.forEach((p) => { if (!parts.includes(p)) p.dispose(); });
  return g;
}

function makeLegsGeo() {
  return merge([
    box(0x32445c, -0.14, -0.44, 0, 0.17, 0.86, 0.19),
    box(0x32445c, 0.14, -0.44, 0, 0.17, 0.86, 0.19),
    box(0x23282d, -0.14, -0.84, 0.05, 0.20, 0.12, 0.32),
    box(0x23282d, 0.14, -0.84, 0.05, 0.20, 0.12, 0.32),
  ], 'legs');
}

function makeTorsoGeo(shirt, trim) {
  return merge([
    box(shirt, 0, 0.34, 0, 0.52, 0.70, 0.30),
    box(trim, 0, 0.07, 0, 0.54, 0.10, 0.32),
    sphere(0xe8bb8c, 0, 0.92, 0, 0.19, 0.21, 0.18),
    box(0x25201d, 0, 1.03, -0.01, 0.20, 0.08, 0.20),
    // 草帽：帽檐 + 帽冠
    ...(() => {
      const brim = new THREE.CylinderGeometry(0.37, 0.37, 0.035, 10);
      brim.translate(0, 1.08, 0);
      const crown = new THREE.CylinderGeometry(0.15, 0.20, 0.20, 8);
      crown.translate(0, 1.18, 0);
      return [paint(brim, 0xd8b86a), paint(crown, 0xc8a458)];
    })(),
  ], 'torso');
}

function makeArmGeo(sleeve, skin) {
  return merge([
    box(sleeve, 0, -0.22, 0, 0.11, 0.44, 0.12),
    sphere(skin, 0, -0.49, 0.02, 0.075, 0.09, 0.075),
  ], 'arm');
}

function makeHoeGeo() {
  return merge([
    cyl(0x7b5531, 0, -0.72, 0, 0.045, 1.45),
    box(0x8f969c, 0, -1.43, 0.16, 0.30, 0.11, 0.34, 0.10),
  ], 'hoe');
}

function makeSeedlingGeo() {
  const parts = [];
  for (let i = 0; i < 4; i += 1) {
    const g = new THREE.ConeGeometry(0.035, 0.28, 3);
    g.rotateZ((i - 1.5) * 0.17);
    g.translate((i - 1.5) * 0.035, -0.55, 0.06);
    parts.push(paint(g, i % 2 ? 0x85c74e : 0x5ca83a));
  }
  return merge(parts, 'seedling');
}

export function buildFarmWorkers(detail, center, owned) {
  const group = new THREE.Group();
  group.name = 'Districts/farm/workers';
  group.position.set(center.cx, 0, center.cz);
  detail.add(group);

  const trackGeo = (g) => { owned.geometries.push(g); return g; };
  const trackMat = (m) => { owned.materials.push(m); return m; };

  const mat = trackMat(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.92, metalness: 0,
  }));

  const G = {
    legs: trackGeo(makeLegsGeo()),
    torsoPlanter: trackGeo(makeTorsoGeo(0x4f79a8, 0x355770)),
    torsoHoer: trackGeo(makeTorsoGeo(0x9b6c43, 0x6c4b2e)),
    armPlanter: trackGeo(makeArmGeo(0x4f79a8, 0xe8bb8c)),
    armHoer: trackGeo(makeArmGeo(0x9b6c43, 0xe8bb8c)),
    hoe: trackGeo(makeHoeGeo()),
    seedling: trackGeo(makeSeedlingGeo()),
  };

  const addIM = (name, geo, count) => {
    const im = new THREE.InstancedMesh(geo, mat, count);
    im.name = name;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    group.add(im);
    return im;
  };

  const P = FARM_WORKERS.planters;
  const H = FARM_WORKERS.hoers;
  const meshes = {
    legs: addIM('Districts/farm/workers/legs', G.legs, FARM_WORKERS.total),
    torsoPlanter: addIM('Districts/farm/workers/torso-planters', G.torsoPlanter, P),
    torsoHoer: addIM('Districts/farm/workers/torso-hoers', G.torsoHoer, H),
    armLPlanter: addIM('Districts/farm/workers/arm-l-planters', G.armPlanter, P),
    armRPlanter: addIM('Districts/farm/workers/arm-r-planters', G.armPlanter, P),
    armLHoer: addIM('Districts/farm/workers/arm-l-hoers', G.armHoer, H),
    armRHoer: addIM('Districts/farm/workers/arm-r-hoers', G.armHoer, H),
    hoe: addIM('Districts/farm/workers/hoes', G.hoe, H),
    seedling: addIM('Districts/farm/workers/seedlings', G.seedling, P),
  };

  const planters = [
    { x: -17.0, z: -4.8, yaw: 0.12, phase: 0.0 },
    { x: -13.2, z: -0.4, yaw: -0.10, phase: 2.15 },
    { x: -9.4, z: 3.1, yaw: 0.16, phase: 4.25 },
  ];
  const hoers = [
    { x: 8.2, z: -2.3, yaw: -0.18, phase: 0.4 },
    { x: 13.1, z: 1.8, yaw: 0.14, phase: 3.45 },
  ];

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const e = new THREE.Euler();
  const bodyM = new THREE.Matrix4();
  const jointM = new THREE.Matrix4();
  const localM = new THREE.Matrix4();
  const armM = new THREE.Matrix4();
  const handM = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4();
  const tmpM2 = new THREE.Matrix4();

  const hip = (x, y, z, bend, yaw) => {
    pos.set(x, y, z);
    e.set(bend, yaw, 0, 'YXZ');
    quat.setFromEuler(e);
    bodyM.compose(pos, quat, one);
  };

  const update = (time) => {
    // —— 插秧：深弯腰 + 左右手交替插入，抬身时换苗 ——
    for (let i = 0; i < P; i += 1) {
      const w = planters[i];
      const a = time * (Math.PI * 2 / FARM_WORKERS.cycle.planter) + w.phase;
      const bend = 1.02 + 0.24 * Math.sin(a);                  // 58°~72° 前屈，插秧姿态清晰
      const side = Math.sin(a) * 0.10;
      const hx = w.x, hz = w.z;
      hip(hx, BASE_Y + HIP_Y, hz, bend, w.yaw + side);
      // 支撑腿
      jointM.makeTranslation(hx, BASE_Y + HIP_Y, hz);
      e.set(0, w.yaw, 0, 'YXZ');
      quat.setFromEuler(e);
      jointM.compose(pos.set(hx, BASE_Y + HIP_Y, hz), quat, one);
      meshes.legs.setMatrixAt(i, jointM);
      meshes.torsoPlanter.setMatrixAt(i, bodyM);

      for (const s of [-1, 1]) {
        const idx = s < 0 ? 0 : 1;
        const reach = -0.78 + Math.sin(a + (s < 0 ? 0 : Math.PI)) * 0.30;
        localM.makeTranslation(s * 0.34, 0.62, 0);
        jointM.copy(bodyM).multiply(localM);
        tmpM.makeRotationX(reach);
        armM.copy(jointM).multiply(tmpM);
        (s < 0 ? meshes.armLPlanter : meshes.armRPlanter).setMatrixAt(i, armM);
        if (s < 0) {
          // 左手秧苗随手腕，落点贴近水面
          tmpM.makeTranslation(0, -0.49, 0.02);
          handM.copy(armM).multiply(tmpM);
          meshes.seedling.setMatrixAt(i, handM);
        }
      }
    }

    // —— 锄地：右手举锄过肩—落锄—短暂停顿，左手随柄，身体前压 ——
    for (let i = 0; i < H; i += 1) {
      const w = hoers[i];
      const a = time * (Math.PI * 2 / FARM_WORKERS.cycle.hoer) + w.phase;
      const raised = (Math.sin(a) + 1) * 0.5;                  // 0=锄头落地 1=举过头顶
      const strike = Math.max(0, Math.sin(a + 1.9));
      const bend = 0.42 + 0.18 * raised + 0.10 * strike;
      hip(w.x, BASE_Y + HIP_Y, w.z, bend, w.yaw);
      e.set(0, w.yaw, 0, 'YXZ');
      quat.setFromEuler(e);
      jointM.compose(pos.set(w.x, BASE_Y + HIP_Y, w.z), quat, one);
      meshes.legs.setMatrixAt(P + i, jointM);
      meshes.torsoHoer.setMatrixAt(i, bodyM);

      // 右臂：抬举到 -2.25rad，落下时回 -0.30rad
      const armR = -0.30 - raised * 1.95;
      localM.makeTranslation(0.35, 0.62, 0);
      jointM.copy(bodyM).multiply(localM);
      tmpM.makeRotationX(armR);
      armM.copy(jointM).multiply(tmpM);
      meshes.armRHoer.setMatrixAt(i, armM);
      // 锄柄从右手向下延伸；举锄时略回收，落锄时前压
      tmpM.makeTranslation(0, -0.47, 0);
      handM.copy(armM).multiply(tmpM);
      tmpM2.makeRotationX(0.22 + strike * 0.28 - raised * 0.22);
      handM.multiply(tmpM2);
      meshes.hoe.setMatrixAt(i, handM);

      // 左臂扶柄中段
      const armL = -0.68 + raised * 0.35;
      localM.makeTranslation(-0.35, 0.62, 0);
      jointM.copy(bodyM).multiply(localM);
      tmpM.makeRotationX(armL);
      armM.copy(jointM).multiply(tmpM);
      meshes.armLHoer.setMatrixAt(i, armM);
    }

    for (const im of Object.values(meshes)) im.instanceMatrix.needsUpdate = true;
  };

  update(0);

  const dispose = () => {
    for (const im of Object.values(meshes)) {
      try { im.dispose(); } catch { /* noop */ }
    }
  };

  return {
    group,
    meshes,
    stats: {
      planters: P, hoers: H, total: FARM_WORKERS.total,
      planterBend: [0.78, 1.26], hoerArmSwing: [-2.25, -0.30],
      cycles: FARM_WORKERS.cycle,
    },
    update,
    dispose,
  };
}
