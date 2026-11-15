/**
 * ============================================================================
 * Farm.js —— M9 农家宝（挂在 Districts 北侧 farm 区的 detail 组）
 * ============================================================================
 * 【定位】多片耕地与空地，玩家可走在田埂或走进麦田/玉米地。10-20 种作物按真实
 * 高度/形态区分（高水稻、粗玉米、矮甘蓝、地躺南瓜……）。
 *
 * 【技术要求】大量作物用 InstancedMesh；update 循环零新建对象；独立 Mesh ≤ 30；
 * 单区面数 ≤ 1.2 万。结构（谷仓+风车+田垄）用 mergeGeometries 合并。
 *
 * 【预算】与城堡同理，farm 在 redline 验收机位 (0,30,34)/(0,9.4,25) 朝 -z 看位于
 * 相机背后被视锥剔除，不计入相对 M0 的 Δ 预算；仅在四宫格俯瞰 (30,84,96)（距 farm
 * 中心约 96m > LOD 阈值 100? 实际 96<100 → 显示 detail）计入绝对 30 万面上限。
 * 本农场结构+作物合计约 1.1 万面，余量充足。
 *
 * 【坐标约定】同 Castle：直接往 detail 组以「世界坐标」添加子对象，由 Districts
 * 减去区中心 (60,60) rebase。所有坐标按 farm 区中心 (60,60) 书写。
 *
 * 【资源释放】自有资源：1 个合并结构几何 + 2 个克隆几何（交叉叶/矮柱）+ 每作物
 * 材质 + 结构材质。作物 InstancedMesh 复用共享 geoCone（不释放共享几何）。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** 14 种作物：按 shape 复用三类几何，用 scale/color 表现高度与形态差异 */
const CROPS = [
  // shape: 'blade' 高瘦（水稻/麦/草/芝麻/豆） 用交叉叶几何
  { name: '水稻', shape: 'blade', color: 0x6fbf4a, h: 1.5, w: 0.10, cell: [0, 0] },
  { name: '小麦', shape: 'blade', color: 0xd9b54a, h: 1.05, w: 0.12, cell: [1, 0] },
  { name: '大麦', shape: 'blade', color: 0xe6d27a, h: 0.95, w: 0.11, cell: [2, 0] },
  { name: '牧草', shape: 'blade', color: 0x5fae46, h: 0.7, w: 0.07, cell: [3, 0] },
  { name: '芝麻', shape: 'blade', color: 0x7bbf55, h: 0.8, w: 0.06, cell: [0, 1] },
  { name: '大豆', shape: 'blade', color: 0x6cae5a, h: 0.6, w: 0.08, cell: [1, 1] },
  // shape: 'post' 粗高（玉米/高粱） 用矮柱几何
  { name: '玉米', shape: 'post', color: 0x4f9d3a, h: 1.9, w: 0.26, cell: [2, 1] },
  { name: '高粱', shape: 'post', color: 0x9c5a3c, h: 1.6, w: 0.16, cell: [3, 1] },
  // shape: 'bulb' 矮圆/地躺（甘蓝/南瓜/西瓜/番茄/马铃薯/茄子） 用圆锥近似圆头
  { name: '甘蓝', shape: 'bulb', color: 0x9bd06a, h: 0.5, w: 0.6, cell: [0, 2] },
  { name: '南瓜', shape: 'bulb', color: 0xe08a2a, h: 0.35, w: 0.7, cell: [1, 2] },
  { name: '西瓜', shape: 'bulb', color: 0x3f8f3a, h: 0.35, w: 0.8, cell: [2, 2] },
  { name: '番茄', shape: 'bulb', color: 0xe2472f, h: 0.45, w: 0.45, cell: [3, 2] },
  { name: '马铃薯', shape: 'bulb', color: 0x9c7a4a, h: 0.22, w: 0.34, cell: [0, 3] },
  { name: '茄子', shape: 'bulb', color: 0x6a3f8f, h: 0.4, w: 0.42, cell: [1, 3] },
];

/** 给克隆几何写入顶点色（与 Castle 同款合并约定） */
function colored(geo, hex) {
  const g = geo.clone();
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function place(geo, hex, pos, scale, rotY = 0) {
  const g = colored(geo, hex);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
  const m = new THREE.Matrix4().compose(new THREE.Vector3(pos[0], pos[1], pos[2]), q, new THREE.Vector3(scale[0], scale[1], scale[2]));
  g.applyMatrix4(m);
  return g;
}

/**
 * @param {THREE.Group} detail  Districts 的 farm detail 组（世界坐标建，由 Districts rebase）
 * @param {object} S             Lobby 共享几何
 * @param {{cx:number, cz:number}} center  farm 区中心世界坐标
 * @returns {{dispose:()=>void}}
 */
export function buildFarm(detail, S, center) {
  const cx = center.cx;
  const cz = center.cz;
  const owned = { geometries: [], materials: [] };
  const mat = (hex, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: hex, ...opts });
    owned.materials.push(m);
    return m;
  };

  // ---- 自有几何：交叉叶（4 面）+ 矮柱（8 段，32 面），合并自共享几何/新建 ----
  const planeA = colored(S.geoPlane, 0xffffff);
  const planeB = colored(S.geoPlane, 0xffffff);
  planeB.rotateY(Math.PI / 2);
  const bladeGeo = mergeGeometries([planeA, planeB], false); // 交叉双叶
  if (!bladeGeo) throw new Error('[Farm] blade mergeGeometries 失败');
  bladeGeo.computeBoundingSphere();
  planeA.dispose(); planeB.dispose();
  owned.geometries.push(bladeGeo);

  // 矮柱用于玉米/高粱等"粗高"作物：8 段圆柱（32 面），比共享 16 段(64)省一半
  const postGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
  owned.geometries.push(postGeo);

  // ---- 4×4 地块网格：cell(0,0) 留给谷仓+风车，其余 15 格种 14 种作物 ----
  const gridN = 4, plot = 13, gap = 1.4;
  const gx0 = cx - (gridN * plot + (gridN - 1) * gap) / 2 + plot / 2;
  const gz0 = cz - (gridN * plot + (gridN - 1) * gap) / 2 + plot / 2;
  const cellCenter = (col, row) => [gx0 + col * (plot + gap), gz0 + row * (plot + gap)];

  // ---- 结构：谷仓 + 风车（含静态叶片）合并为 1 个顶点色几何，放在 cell(0,0) ----
  const barn = 0xc65b4a, roof = 0x8a5a34, white = 0xf4f1e6;
  const [stx, stz] = cellCenter(0, 0);
  const structParts = [];
  // 谷仓
  structParts.push(place(S.geoBox, barn, [stx - 3, 5, stz], [14, 9, 11]));
  structParts.push(place(S.geoCone, roof, [stx - 3, 12, stz], [10, 6, 9]));
  // 风车塔 + 顶 + 静态叶片（放在 cell 东侧）
  structParts.push(place(S.geoCylinder, white, [stx + 4, 8, stz + 2], [4, 15, 4]));
  structParts.push(place(S.geoCone, roof, [stx + 4, 17.5, stz + 2], [4.6, 5, 4.6]));
  structParts.push(place(S.geoBox, white, [stx + 4, 13, stz + 4.4], [12, 1.2, 0.5]));
  structParts.push(place(S.geoBox, white, [stx + 4, 13, stz + 4.4], [1.2, 12, 0.5], Math.PI / 2));
  const structGeo = mergeGeometries(structParts, false);
  if (!structGeo) throw new Error('[Farm] structure mergeGeometries 失败');
  structGeo.computeBoundingSphere();
  structParts.forEach((g) => g.dispose());
  owned.geometries.push(structGeo);
  const matStruct = mat(0xffffff, { vertexColors: true, roughness: 0.9, metalness: 0.0 });
  const structMesh = new THREE.Mesh(structGeo, matStruct);
  structMesh.name = 'Districts/farm/structure';
  structMesh.frustumCulled = true;
  detail.add(structMesh);

  // ---- 作物：每类型一个 InstancedMesh，散布在除 cell(0,0) 外的地块网格中 ----
  const d = new THREE.Object3D();
  const rndColor = new THREE.Color();
  /* 【六项升级·阶段四】确定性散列随机（替代旧 `%1` 取模：旧值可能为负、分布
   * 偏斜，导致整片作物朝向一致像「木棍」）。同一 seed 永远得到同一片田，
   * 但每株的朝向/倾斜/高矮/疏密/色相都独立变化。 */
  const rnd = (a) => {
    const s = Math.sin(a * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s); // [0,1)
  };
  let instCount = 0;
  // 生成 15 个可用格（排除 cell(0,0)），按顺序分配给 14 种作物
  const cellList = [];
  for (let row = 0; row < gridN; row += 1) {
    for (let col = 0; col < gridN; col += 1) {
      if (col === 0 && row === 0) continue;
      cellList.push([col, row]);
    }
  }
  CROPS.forEach((crop, ci) => {
    const [col, row] = cellList[ci];
    const [px, pz] = cellCenter(col, row);
    const step = 2.0; // 株距 2m
    const nx = Math.floor((plot - 1) / step);
    const nz = Math.floor((plot - 1) / step);
    const total = nx * nz;
    let geo, scaleFn;
    if (crop.shape === 'blade') { geo = bladeGeo; }
    else if (crop.shape === 'post') { geo = postGeo; }
    else { geo = S.geoCone; }
    const cropMat = mat(crop.color, { roughness: 0.7, metalness: 0.0, side: crop.shape === 'blade' ? THREE.DoubleSide : THREE.FrontSide });
    // 叶类用双面，避免背向消失
    const im = new THREE.InstancedMesh(geo, cropMat, total);
    im.name = `Districts/farm/crop-${crop.name}`;
    const seed = ci * 37.13 + 9.7;
    let idx = 0;
    for (let ix = 0; ix < nx; ix += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        // 簇状疏密：格内再做 0.75m 级抖动，避免整齐「木棍阵列」
        const jx = (rnd(seed + idx * 1.7) - 0.5) * 1.15;
        const jz = (rnd(seed + idx * 2.3 + 5) - 0.5) * 1.15;
        const wx = px - plot / 2 + 0.5 + ix * step + jx;
        const wz = pz - plot / 2 + 0.5 + iz * step + jz;
        // 每株独立 yaw（0~2π）、双向倾斜、高矮 0.72~1.32 倍
        const yaw = rnd(seed + idx * 3.1) * Math.PI * 2;
        const tilt = (rnd(seed + idx * 4.9) - 0.5) * 0.34;
        const lean = (rnd(seed + idx * 5.7) - 0.5) * 0.34;
        const grow = 0.72 + rnd(seed + idx * 7.3) * 0.6;
        const wide = 0.82 + rnd(seed + idx * 8.1) * 0.46;
        d.position.set(wx, crop.h * grow / 2 + 1.12, wz);
        d.rotation.set(lean, yaw, tilt);
        if (crop.shape === 'bulb') d.scale.set(crop.w * wide, crop.h * 2.2 * grow, crop.w * wide);
        else d.scale.set(crop.w * wide, crop.h * grow, crop.w * wide);
        d.updateMatrix();
        im.setMatrixAt(idx, d.matrix);
        // 每株色相/明度微扰，田块不再纯色平板（instanceColor 不新增 GPU 资源）
        rndColor.setHex(crop.color);
        const shade = 0.82 + rnd(seed + idx * 9.7) * 0.36;
        rndColor.multiplyScalar(shade);
        im.setColorAt(idx, rndColor);
        idx += 1;
      }
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere(); // 精确包围球，杜绝视锥内误剔除
    im.frustumCulled = true;
    detail.add(im);
    instCount += total;
  });

  const dispose = () => {
    for (const g of owned.geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of owned.materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    owned.geometries.length = 0;
    owned.materials.length = 0;
  };
  return { dispose, instCount };
}
