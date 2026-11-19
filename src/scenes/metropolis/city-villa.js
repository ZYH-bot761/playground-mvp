/**
 * 都会区别墅门面：商场西侧空地 (-30,134) 的一栋现代简约三层别墅。
 * 玩家走到南门（z 减小方向）门口按 E → onEnterAttraction('villa') 进入室内场景。
 *
 * 【Blender 精修】外壳几何由 tools/blender/build_city_villa.py 离线建模：
 * 三层错落体量 / 内凹玻璃幕墙分格 / 挑檐腰线 / 玻璃栏板阳台 / 雨棚门廊 /
 * 屋顶设备层 / 庭院阔叶树景观，按 8 个材质桶导出量化顶点数据并编译进
 * city-villa-blender-model.js（5612 tris）。沿用现有 MeshStandardMaterial +
 * owned 台账体系，零 GLB / 零外部资产 / 不增 InstancedMesh。
 *
 * 交互骨架保持原契约：root 名 'City/villa'（进室内时整体隐藏）、门板
 * 'City/villa-door'（点击拾取）、'City/villa-ring'、doorPos、colliders。
 */
import * as THREE from 'three';
import { createVillaShellParts, VILLA_SHELL_TRIS } from './city-villa-blender-model.js';

/** 别墅在世界坐标的位置（商场 x0 z134 正西空地） */
export const CITY_VILLA = Object.freeze({
  x: -30, z: 134,
  w: 20, d: 16, h: 9,
  door: Object.freeze({ x: -30, z: 125.7 }), // 南门门口（玩家站这里按 E）
  enterRadius: 4.2,
});

/** Blender 外壳基座抬升（与室内 VILLA_ORIGIN.y=1.2 近似对齐） */
const SHELL_BASE_Y = 1.16;

/** 每个材质桶的基色；顶点色作为明暗调制（白=基色，灰=阴影/次要构件）。 */
const SHELL_MATERIALS = Object.freeze({
  WALL: { color: 0xe8e4dc, roughness: 0.86, metalness: 0.02 },
  GLASS: {
    color: 0x8fb8c8, roughness: 0.12, metalness: 0.24,
    transparent: true, opacity: 0.72, depthWrite: false,
  },
  FRAME: { color: 0x3a4046, roughness: 0.38, metalness: 0.62 },
  WOOD: { color: 0x9c7549, roughness: 0.74, metalness: 0.0 },
  DOOR: { color: 0x7a5232, roughness: 0.64, metalness: 0.0 },
  DARK: { color: 0x2c3238, roughness: 0.84, metalness: 0.08 },
  GREEN: { color: 0x4f8a46, roughness: 0.90, metalness: 0.0 },
});

export function buildCityVilla({ group, owned }) {
  const V = CITY_VILLA;
  const geos = [], mats = [], texes = [];
  const G = (g) => { geos.push(g); return g; };
  const M = (m) => { mats.push(m); return m; };

  const root = new THREE.Group();
  root.name = 'City/villa';
  group.add(root);

  // ---- Blender 离线建模外壳：8 个桶各 1 draw call，几何平移到世界坐标
  const parts = createVillaShellParts();
  for (const [name, geo] of Object.entries(parts)) {
    geo.translate(V.x, SHELL_BASE_Y, V.z);
    G(geo);
    const spec = SHELL_MATERIALS[name];
    const mat = spec
      ? M(new THREE.MeshStandardMaterial({ ...spec, vertexColors: true }))
      // 发光灯带：不受光照/色调映射影响，夜间自发光
      : M(new THREE.MeshBasicMaterial({ color: 0xffd9a0, vertexColors: true, toneMapped: false }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name === 'DOOR' ? 'City/villa-door' : `City/villa-${name.toLowerCase()}`;
    if (name === 'DOOR') mesh.userData.villaDoor = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
  }

  // ---- 入口光环（玩家一眼看到"这里能进"）—— 世界坐标，不随外壳平移
  const glowMat = M(new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false }));
  const ring = new THREE.Mesh(G(new THREE.TorusGeometry(1.6, 0.08, 6, 24)), glowMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(V.door.x, SHELL_BASE_Y + 0.03, V.door.z);
  ring.name = 'City/villa-ring';
  root.add(ring);
  // 门口地垫光斑
  const glow = new THREE.Mesh(G(new THREE.CircleGeometry(1.5, 20)), M(new THREE.MeshBasicMaterial({
    color: 0xffcf80, transparent: true, opacity: 0.18, toneMapped: false, depthWrite: false,
  })));
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(V.door.x, SHELL_BASE_Y + 0.02, V.door.z);
  root.add(glow);

  // ---- 招牌（CanvasTexture 程序化文字）
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g2 = c.getContext('2d');
  g2.fillStyle = 'rgba(18,26,32,.85)'; g2.fillRect(0, 0, 512, 128);
  g2.strokeStyle = '#ffd9a0'; g2.lineWidth = 5; g2.strokeRect(4, 4, 504, 120);
  g2.fillStyle = '#fff5df'; g2.font = 'bold 54px "Microsoft YaHei", sans-serif';
  g2.textAlign = 'center'; g2.textBaseline = 'middle';
  g2.fillText('我 的 别 墅', 256, 64);
  const signTex = new THREE.CanvasTexture(c);
  signTex.colorSpace = THREE.SRGBColorSpace;
  texes.push(signTex);
  const sign = new THREE.Mesh(G(new THREE.PlaneGeometry(6, 1.5)), M(new THREE.MeshBasicMaterial({
    map: signTex, transparent: true, toneMapped: false,
  })));
  sign.position.set(V.x, SHELL_BASE_Y + V.h - 1.0, V.z - V.d / 2 - 0.2);
  root.add(sign);

  // ---- 统一登记台账（构建期一次性，dispose 时由 metropolis-scene 释放）
  owned.geometries.push(...geos);
  owned.materials.push(...mats);
  owned.textures.push(...texes);

  // ---- 碰撞：别墅本体（门洞不挡，玩家可走到门口）
  const colliders = [];
  colliders.push({ minX: V.x - V.w / 2, maxX: V.x + V.w / 2, minZ: V.z - V.d / 2, maxZ: V.z + V.d / 2 });

  return {
    root,
    colliders,
    ring,
    doorPos: { ...V.door },
    stats: { x: V.x, z: V.z, doorZ: V.door.z, tris: VILLA_SHELL_TRIS },
  };
}
