/**
 * ============================================================================
 * Castle.js —— M8 童话公主风城堡园（挂在 Districts 北侧 castle 区的 detail 组）
 * ============================================================================
 * 【定位】玩家从十字道路进入城堡园，沿城堡周边行走感受高耸塔楼与尖顶。内部不开放。
 *
 * 【技术要求】大连通块几何用 mergeGeometries 合并；重复件（窗 / 塔尖宝珠）用
 * InstancedMesh；独立 Mesh ≤ 30；单区面数建议 ≤ 1.5 万。
 *
 * 【预算】本模块只在「相机距城堡中心 < 78m」时由 LOD 切换到 detail 渲染（远景区
 * 只渲染 1 个 12 面剪影）。redline 验收机位 (0,30,34)/(0,9.4,25) 朝 -z 看，城堡在
 * 相机背后被视锥剔除 → 不计入相对 M0 的 Δ 预算；仅在四宫格俯瞰机位 (30,84,96)
 * 计入绝对 30 万面上限（本城堡约 2.8k 面，余量充足）。
 *
 * 【坐标约定】buildCastle 直接往传入的 detail 组添加「世界坐标」子对象（与
 * Districts._buildCastlePlaceholder 一致）；Districts._rebase 会把它们减去区中心
 * 转成 LOD 局部坐标。因此本模块所有坐标都按 castle 区中心 (0,60) 的世界值书写。
 *
 * 【资源释放】只释放本模块「自有」资源：2 个合并几何 + 4 个材质。窗/宝珠
 * InstancedMesh 复用 Lobby 共享几何（geoBox/geoSphere），由 Districts.dispose 安全
 * 释放实例缓冲，绝不释放共享几何本体。
 * ============================================================================
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** 童话公主配色：粉 / 蓝 / 金 / 白 */
const PALETTE = {
  white: 0xf3e7f7,
  pink: 0xe87fbf,
  blue: 0xa9d4f5,
  gold: 0xf6d76b,
};

/** 给克隆几何写入顶点色（mergeGeometries 要求所有输入属性一致：pos/normal/uv/color） */
function colored(geo, hex) {
  const g = geo.clone();
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** 把几何放到世界坐标位置 + 缩放 + 可选 Y 轴旋转（城墙段需要切线朝向） */
function place(geo, hex, pos, scale, rotY = 0) {
  const g = colored(geo, hex);
  const q = rotY ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY) : new THREE.Quaternion();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    q,
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
  g.applyMatrix4(m);
  return g;
}

/**
 * @param {THREE.Group} detail  Districts 的 castle detail 组（世界坐标建，由 Districts rebase）
 * @param {object} S             Lobby 共享几何（geoBox/geoCylinder/geoCone/geoSphere/geoPlane）
 * @param {{cx:number, cz:number}} center  城堡区中心世界坐标
 * @returns {{dispose:()=>void}}
 */
export function buildCastle(detail, S, center) {
  const cx = center.cx;
  const cz = center.cz;
  const owned = { geometries: [], materials: [] };
  const mat = (hex, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({ color: hex, ...opts });
    owned.materials.push(m);
    return m;
  };

  // 主堡（5-6 层 ≈ 21m）+ 8 栋高低错落塔楼（7-8 层 ≈ 24/27/30m）
  const keepH = 21;
  const keepW = 12;
  const R = 14;
  const nT = 8;
  const towerColors = [PALETTE.pink, PALETTE.blue, PALETTE.gold, PALETTE.white];
  const towers = [];
  for (let i = 0; i < nT; i += 1) {
    const a = (i / nT) * Math.PI * 2;
    towers.push({
      x: cx + Math.cos(a) * R,
      z: cz + Math.sin(a) * R,
      h: 24 + (i % 3) * 3, // 24 / 27 / 30 → 错落
      rad: 2.6,
      col: towerColors[i % towerColors.length],
    });
  }

  // ---- 合并①：墙体主体（主堡 + 塔身 + 主堡雉堞 + 塔楼/主堡基座）----
  const bodyParts = [];
  bodyParts.push(place(S.geoBox, PALETTE.white, [cx, keepH / 2, cz], [keepW, keepH, keepW]));
  for (const t of towers) {
    bodyParts.push(place(S.geoCylinder, t.col, [t.x, t.h / 2, t.z], [t.rad, t.h, t.rad]));
  }
  // 塔楼基座（地面过渡，避免塔身直接插地坪；并入 body 合并几何，零新增 draw call）
  for (const t of towers) {
    bodyParts.push(place(S.geoCylinder, t.col, [t.x, 1.5, t.z], [t.rad * 1.5, 3, t.rad * 1.5]));
  }
  // 主堡基座平台（略宽于主堡，提供落地过渡）
  bodyParts.push(place(S.geoBox, PALETTE.white, [cx, 1.5, cz], [keepW + 3, 3, keepW + 3]));
  const bmCount = 8; // 主堡顶雉堞
  for (let i = 0; i < bmCount; i += 1) {
    const a = (i / bmCount) * Math.PI * 2;
    bodyParts.push(place(S.geoBox, PALETTE.white,
      [cx + Math.cos(a) * (keepW / 2 - 0.6), keepH + 1.5, cz + Math.sin(a) * (keepW / 2 - 0.6)],
      [1.4, 3, 1.4]));
  }
  /* 【六项升级·阶段四】城墙：连接 8 座塔楼形成闭合城廓 + 墙顶城垛。
   * 【预算口径】城墙单独合并成 1 个几何 / 1 个 Mesh，不并入 body：
   * 若并进去会让 body 包围球半径从 ~30 涨到 ~34，在 redline 机位
   * (0,30,34) 朝 -z 看时北侧城堡被误判为可见，凭空多出 5 个 draw call。
   * 独立几何的包围球半径 ~16（仅 R=14 的塔环），仍能被正确剔除。 */
  const wallParts = [];
  const wallH = 8;
  const wallR = R * Math.cos(Math.PI / 8);
  const wallLen = 2 * R * Math.sin(Math.PI / 8) * 1.02;
  for (let i = 0; i < nT; i += 1) {
    const a0 = (i / nT) * Math.PI * 2;
    const a1 = ((i + 1) / nT) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    // 相邻两塔连线（弦）方向；box 长边沿局部 X，绕 Y 旋转到该方向
    const dx = Math.cos(a1) - Math.cos(a0);
    const dz = Math.sin(a1) - Math.sin(a0);
    const yaw = Math.atan2(-dz, dx);
    const wx = cx + Math.cos(am) * wallR;
    const wz = cz + Math.sin(am) * wallR;
    wallParts.push(place(S.geoBox, PALETTE.white, [wx, wallH / 2, wz],
      [wallLen, wallH, 1.6], yaw));
    // 每段城墙 4 个城垛，沿弦方向等距排布
    const ux = dx / Math.hypot(dx, dz);
    const uz = dz / Math.hypot(dx, dz);
    for (let c = 0; c < 4; c += 1) {
      const t = ((c + 0.5) / 4 - 0.5) * wallLen;
      wallParts.push(place(S.geoBox, PALETTE.white,
        [wx + ux * t, wallH + 0.7, wz + uz * t], [1.2, 1.4, 1.7], yaw));
    }
  }
  const bodyGeo = mergeGeometries(bodyParts, false);
  if (!bodyGeo) throw new Error('[Castle] body mergeGeometries 失败');
  bodyGeo.computeBoundingSphere();
  bodyParts.forEach((g) => g.dispose());
  owned.geometries.push(bodyGeo);

  // ---- 合并②：尖顶（主堡尖顶 + 8 塔尖顶）----
  const roofParts = [];
  roofParts.push(place(S.geoCone, PALETTE.pink, [cx, keepH + 5, cz], [keepW * 0.95, 10, keepW * 0.95]));
  for (const t of towers) {
    roofParts.push(place(S.geoCone, PALETTE.pink, [t.x, t.h + 4, t.z], [t.rad * 1.1, 8, t.rad * 1.1]));
  }
  const roofGeo = mergeGeometries(roofParts, false);
  if (!roofGeo) throw new Error('[Castle] roof mergeGeometries 失败');
  roofGeo.computeBoundingSphere();
  roofParts.forEach((g) => g.dispose());
  owned.geometries.push(roofGeo);

  // 共享石质材质（顶点色驱动粉/蓝/金/白）
  const matStone = mat(0xffffff, { vertexColors: true, roughness: 0.82, metalness: 0.0 });
  const wallGeo = mergeGeometries(wallParts, false);
  if (!wallGeo) throw new Error('[Castle] wall mergeGeometries 失败');
  wallGeo.computeBoundingSphere();
  wallParts.forEach((g) => g.dispose());
  owned.geometries.push(wallGeo);

  const body = new THREE.Mesh(bodyGeo, matStone);
  body.name = 'Districts/castle/body';
  body.frustumCulled = true;
  detail.add(body);
  const walls = new THREE.Mesh(wallGeo, matStone);
  walls.name = 'Districts/castle/walls';
  walls.frustumCulled = true;
  detail.add(walls);
  const roof = new THREE.Mesh(roofGeo, matStone);
  roof.name = 'Districts/castle/roof';
  roof.frustumCulled = true;
  detail.add(roof);

  // ---- 金色宝珠（塔尖顶饰，InstancedMesh，复用共享 geoSphere）----
  const finialMat = mat(PALETTE.gold, { emissive: PALETTE.gold, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.6 });
  const finialPos = towers.map((t) => [t.x, t.h + 8.5, t.z]);
  finialPos.push([cx, keepH + 10.5, cz]);
  const finials = new THREE.InstancedMesh(S.geoSphere, finialMat, finialPos.length);
  finials.name = 'Districts/castle/finials';
  const d = new THREE.Object3D();
  finialPos.forEach((p, i) => {
    d.position.set(p[0], p[1], p[2]); d.scale.setScalar(0.9); d.updateMatrix();
    finials.setMatrixAt(i, d.matrix);
  });
  finials.instanceMatrix.needsUpdate = true;
  finials.frustumCulled = true;
  detail.add(finials);

  // ---- 发光窗户（InstancedMesh，复用共享 geoBox，emissive 模拟夜间亮灯）----
  const winMat = mat(0x000000, { emissive: 0xffd86b, emissiveIntensity: 1.5, roughness: 0.4 });
  const wins = [];
  const addWinRing = (x, z, h, rad) => {
    const heights = [h * 0.35, h * 0.6, h * 0.85];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const hy of heights) {
      for (const [dx, dz] of dirs) {
        wins.push({
          p: [x + dx * (rad + 0.15), hy, z + dz * (rad + 0.15)],
          s: [0.9, 1.4, 0.3],
          yaw: Math.atan2(dx, dz),
        });
      }
    }
  };
  addWinRing(cx, cz, keepH, keepW / 2);
  for (const t of towers) addWinRing(t.x, t.z, t.h, t.rad);
  const windows = new THREE.InstancedMesh(S.geoBox, winMat, wins.length);
  windows.name = 'Districts/castle/windows';
  wins.forEach((w, i) => {
    d.position.set(w.p[0], w.p[1], w.p[2]);
    d.rotation.set(0, w.yaw, 0);
    d.scale.set(w.s[0], w.s[1], w.s[2]);
    d.updateMatrix();
    windows.setMatrixAt(i, d.matrix);
  });
  windows.instanceMatrix.needsUpdate = true;
  windows.frustumCulled = true;
  detail.add(windows);

  // ---- 城门洞（朝南，正对纵路；暗色凹槽，仅装饰，内部不开放）----
  const gateMat = mat(0x2a2030, { roughness: 0.95 });
  const gate = new THREE.Mesh(S.geoBox, gateMat);
  gate.name = 'Districts/castle/gate';
  gate.position.set(cx, 5, cz - keepW / 2 - 0.1);
  gate.scale.set(5, 9, 0.6);
  gate.frustumCulled = true;
  detail.add(gate);

  const dispose = () => {
    for (const g of owned.geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of owned.materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    owned.geometries.length = 0;
    owned.materials.length = 0;
  };
  return { dispose };
}
