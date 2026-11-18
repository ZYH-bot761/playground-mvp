/**
 * 都会区别墅门面：商场西侧空地 (-30,134) 的一栋现代简约小楼。
 * 玩家走到南门（z 减小方向）门口按 E → onEnterAttraction('villa') 进入室内场景。
 *
 * 只是【外观 + 入口标记】：室内是独立的 Villa 设施，进/出时大厅都会 dispose，
 * 所以这里不复用室内几何，独立建一栋低模门面即可（零增面压力）。
 */
import * as THREE from 'three';

/** 别墅在世界坐标的位置（商场 x0 z134 正西空地） */
export const CITY_VILLA = Object.freeze({
  x: -30, z: 134,
  w: 20, d: 16, h: 9,
  door: Object.freeze({ x: -30, z: 125.7 }), // 南门门口（玩家站这里按 E）
  enterRadius: 4.2,
});

export function buildCityVilla({ group, owned }) {
  const V = CITY_VILLA;
  const geos = [], mats = [], texes = [];
  const G = (g) => { geos.push(g); return g; };
  const M = (m) => { mats.push(m); return m; };

  const root = new THREE.Group();
  root.name = 'City/villa';
  group.add(root);

  const wallMat = M(new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.88 }));
  const trimMat = M(new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.5, metalness: 0.3 }));
  const glassMat = M(new THREE.MeshStandardMaterial({ color: 0x8fb8c8, roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.7 }));
  const woodMat = M(new THREE.MeshStandardMaterial({ color: 0x9c7549, roughness: 0.8 }));
  const glowMat = M(new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false }));

  // 主体两层白色体量 + 深色平屋顶（现代简约）
  const body = new THREE.Mesh(G(new THREE.BoxGeometry(V.w, V.h, V.d)), wallMat);
  body.position.set(V.x, 1.16 + V.h / 2, V.z);
  root.add(body);
  const roof = new THREE.Mesh(G(new THREE.BoxGeometry(V.w + 0.6, 0.4, V.d + 0.6)), trimMat);
  roof.position.set(V.x, 1.16 + V.h + 0.2, V.z);
  root.add(roof);

  // 南立面：门洞（深色门框）+ 两侧玻璃 + 木格栅
  const frontZ = V.z - V.d / 2;
  const door = new THREE.Mesh(G(new THREE.BoxGeometry(2.2, 3.0, 0.18)), woodMat);
  door.position.set(V.door.x, 1.16 + 1.5, frontZ - 0.1);
  door.name = 'City/villa-door';
  door.userData.villaDoor = true;
  root.add(door);
  const frame = new THREE.Mesh(G(new THREE.BoxGeometry(2.6, 3.3, 0.12)), trimMat);
  frame.position.set(V.door.x, 1.16 + 1.6, frontZ - 0.04);
  root.add(frame);
  for (const s of [-1, 1]) {
    const win = new THREE.Mesh(G(new THREE.BoxGeometry(4.5, 2.6, 0.12)), glassMat);
    win.position.set(V.x + s * 6.2, 1.16 + 2.2, frontZ - 0.1);
    root.add(win);
    for (let k = 0; k < 5; k += 1) {
      const slat = new THREE.Mesh(G(new THREE.BoxGeometry(0.09, 2.6, 0.1)), woodMat);
      slat.position.set(V.x + s * 6.2 - 1.8 + k * 0.9, 1.16 + 2.2, frontZ - 0.18);
      root.add(slat);
    }
  }
  // 二层阳台 + 栏杆
  const balcony = new THREE.Mesh(G(new THREE.BoxGeometry(V.w - 2, 0.2, 1.6)), trimMat);
  balcony.position.set(V.x, 1.16 + 4.8, frontZ - 0.8);
  root.add(balcony);
  for (let k = 0; k < 9; k += 1) {
    const rail = new THREE.Mesh(G(new THREE.BoxGeometry(0.06, 1.0, 0.06)), trimMat);
    rail.position.set(V.x - 8 + k * 2, 1.16 + 5.35, frontZ - 1.5);
    root.add(rail);
  }

  // 入口光环（玩家一眼看到"这里能进"）
  const ring = new THREE.Mesh(G(new THREE.TorusGeometry(1.6, 0.08, 6, 24)), glowMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(V.door.x, 1.16 + 0.03, V.door.z);
  ring.name = 'City/villa-ring';
  root.add(ring);
  // 门口地垫光斑
  const glow = new THREE.Mesh(G(new THREE.CircleGeometry(1.5, 20)), new THREE.MeshBasicMaterial({
    color: 0xffcf80, transparent: true, opacity: 0.18, toneMapped: false, depthWrite: false,
  }));
  mats.push(glow.material);
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(V.door.x, 1.16 + 0.02, V.door.z);
  root.add(glow);

  // 招牌（CanvasTexture 程序化文字）
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
  const sign = new THREE.Mesh(G(new THREE.PlaneGeometry(6, 1.5)), new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false }));
  mats.push(sign.material);
  sign.position.set(V.x, 1.16 + V.h - 1.0, frontZ - 0.2);
  root.add(sign);

  // 统一登记台账（构建期一次性）
  owned.geometries.push(...geos);
  owned.materials.push(...mats);
  owned.textures.push(...texes);

  // 碰撞：别墅本体（门洞不挡，玩家可走到门口）
  const colliders = [];
  colliders.push({ minX: V.x - V.w / 2, maxX: V.x + V.w / 2, minZ: V.z - V.d / 2, maxZ: V.z + V.d / 2 });

  return {
    root,
    colliders,
    ring,
    doorPos: { ...V.door },
    stats: { x: V.x, z: V.z, doorZ: V.door.z },
  };
}
