/**
 * 都会区第二轮扩建：居民区 + 远景天际线 + 航空障碍灯。
 * - 居民楼带阳台、空调机位、屋顶水箱、底层小店；
 * - 远景楼群一个合并网格，只占 1 个 draw call；
 * - 不进入 City/LOD 的近景统计，避免把远景算进近景面数。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, CITY_RESIDENTIAL } from './city-layout.js';
import { makeNightWindows } from './city-textures.js';

const Y0 = CITY.pad.y;

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  // 盒子每个面默认 UV 0…1，直接贴窗纹会变成“一栋楼一扇窗”。
  // 按 3m 层高 / 4m 开间重复，低层住宅才有正常尺度。
  const uv = g.attributes.uv;
  const su = Math.max(0.7, Math.max(w, d) / 4);
  const sv = Math.max(0.7, h / 3);
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

function homeFacadeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#cbbfa9';
  g.fillRect(0, 0, 256, 256);
  // 每 128px 一层：两开间，窗洞带窗台和暖色窗帘
  for (let row = 0; row < 2; row += 1) {
    const y = row * 128;
    g.fillStyle = '#b9ac96';
    g.fillRect(0, y + 116, 256, 12);
    for (let col = 0; col < 2; col += 1) {
      const x = col * 128;
      g.fillStyle = '#7d8d89';
      g.fillRect(x + 24, y + 28, 78, 70);
      g.fillStyle = '#415a63';
      g.fillRect(x + 29, y + 33, 68, 60);
      g.fillStyle = 'rgba(255,205,130,.55)';
      g.fillRect(x + 31, y + 35, 20, 56);
      g.fillStyle = '#e6ddc9';
      g.fillRect(x + 20, y + 96, 86, 8);
      g.fillStyle = '#9c907c';
      g.fillRect(x + 60, y + 33, 5, 60);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function signTexture(text, sub) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(30,18,12,.88)';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#d9a45d';
  g.lineWidth = 4;
  g.strokeRect(4, 4, 504, 120);
  g.fillStyle = '#ffe3b0';
  g.font = 'bold 48px "Microsoft YaHei", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 48);
  g.fillStyle = 'rgba(255,235,200,.7)';
  g.font = '22px "Microsoft YaHei", sans-serif';
  g.fillText(sub, 256, 92);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildCityExpansion({ group, owned }) {
  const g = new THREE.Group();
  g.name = 'City/expansion';
  // 与 CITY_BLOCKS 一样使用“相对城市中心”的局部坐标，避免两套坐标混用。
  g.position.set(CITY.center.x, 0, CITY.center.z);
  group.add(g);

  const homeMap = homeFacadeTexture();
  const nightMap = makeNightWindows();
  owned.textures.push(homeMap, nightMap);

  const facadeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: homeMap, emissive: 0xffc07a, emissiveMap: nightMap,
    emissiveIntensity: 0.0, roughness: 0.92, metalness: 0.0,
  });
  const balconyMat = new THREE.MeshStandardMaterial({ color: 0xb7ad9b, roughness: 0.94 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x5a5f5a, roughness: 0.95 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x8c7a61, roughness: 0.74 });
  const acMat = new THREE.MeshStandardMaterial({ color: 0xaab0ad, roughness: 0.65, metalness: 0.25 });
  owned.materials.push(facadeMat, balconyMat, roofMat, trimMat, acMat);

  const bodies = [];
  const balconies = [];
  const roofs = [];
  const trims = [];
  const acs = [];

  for (const b of CITY_RESIDENTIAL) {
    const x = b.x - CITY.center.x;
    const z = b.z - CITY.center.z;
    const bodyH = b.h;
    bodies.push(box(b.w, bodyH, b.d, x, Y0 + bodyH / 2, z));
    // 屋顶水箱 / 楼梯间 / 女儿墙
    roofs.push(box(b.w + 0.5, 0.5, b.d + 0.5, x, Y0 + bodyH + 0.25, z));
    roofs.push(box(3.0, 2.2, 3.0, x - b.w * 0.22, Y0 + bodyH + 1.6, z + 1.0));
    roofs.push(box(2.2, 1.8, 2.2, x + b.w * 0.26, Y0 + bodyH + 1.4, z - 1.4));
    // 南向阳台：每层一块板 + 一根栏杆；山墙侧挂空调。
    const floors = b.floors;
    for (let f = 1; f <= floors; f += 1) {
      const y = Y0 + (f / floors) * bodyH - 1.0;
      balconies.push(box(b.w * 0.72, 0.16, 1.25, x, y, z - b.d / 2 - 0.55));
      balconies.push(box(b.w * 0.72, 0.62, 0.10, x, y + 0.36, z - b.d / 2 - 1.14));
      if (f % 2 === 0) {
        acs.push(box(0.8, 0.55, 0.45, x - b.w / 2 - 0.18, y + 0.6, z - 1.2));
        acs.push(box(0.8, 0.55, 0.45, x + b.w / 2 + 0.18, y + 0.6, z + 0.8));
      }
    }
    // 底层门头与竖向分隔，给街道一个 3m 高的“店招带”。
    trims.push(box(b.w + 0.6, 0.35, b.d + 0.6, x, Y0 + 3.2, z));
    trims.push(box(0.35, 3.2, b.d + 0.3, x - b.w / 2, Y0 + 1.6, z));
    trims.push(box(0.35, 3.2, b.d + 0.3, x + b.w / 2, Y0 + 1.6, z));
  }

  const merge = (arr, mat, name) => {
    if (!arr.length) return null;
    const geo = mergeGeometries(arr, false);
    arr.forEach((x) => x.dispose());
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    g.add(mesh);
    owned.geometries.push(geo);
    return mesh;
  };
  merge(bodies, facadeMat, 'City/residential-bodies');
  merge(balconies, balconyMat, 'City/residential-balconies');
  merge(roofs, roofMat, 'City/residential-roofs');
  merge(trims, trimMat, 'City/residential-trims');
  merge(acs, acMat, 'City/residential-ac');

  // 居民区入口牌：跟着保留下来的西侧公寓走，不再悬在北侧空草地上。
  const homeTex = signTexture('都会公寓 · 幸福里', 'METRO RESIDENCES');
  const homeGeo = new THREE.PlaneGeometry(8.4, 1.7);
  const homeMat = new THREE.MeshBasicMaterial({ map: homeTex, transparent: true });
  const home = new THREE.Mesh(homeGeo, homeMat);
  home.name = 'City/residential-sign';
  home.position.set(-78 - CITY.center.x, Y0 + 4.9, 164 - CITY.center.z - 7.25);
  home.rotation.y = Math.PI;
  g.add(home);
  owned.geometries.push(homeGeo);
  owned.materials.push(homeMat);
  owned.textures.push(homeTex);

  /* 远景天际线环已按用户要求删除：那圈玻璃塔落在城市路网之外的草坪上，
   * 又被雾切成半截白块，观感是"显示不完整"。城市天际线由路网内真实建筑承担。 */

  return {
    stats: {
      residential: CITY_RESIDENTIAL.length,
      skylineTowers: 0,
      beacons: 0,
    },
    setNight(f) {
      facadeMat.emissiveIntensity = 0.018 + f * 0.82;
      homeMat.opacity = 1;
    },
  };
}
