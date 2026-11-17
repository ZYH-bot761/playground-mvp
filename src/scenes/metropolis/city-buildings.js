/**
 * 北侧街区建筑（第一阶段）：
 * 9 个原始街块重组为 6 座建筑——医院 / 学校 / 商场（各合并 2 块）
 * + 大裤衩 / 尖塔 / 退台塔（3 座异形地标）。
 * 三级 LOD；近景按材质合并，细节只保留入口、红十字、跑道、招牌。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, CITY_BLOCKS, TOWER_SLOTS, HOSPITAL, SCHOOL, MALL } from './city-layout.js';
import {
  makeGlassFacade, makeNightWindows, makeTrackTexture,
  makeGlassNormalMap, makeGlassRoughness,
} from './city-textures.js';

const Y0 = CITY.pad.y;

function boxGeo(w, h, d, x, y, z, uv = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const uvAttr = g.attributes.uv;
  const su = Math.max(0.35, (Math.max(w, d) / 12) * uv);
  const sv = Math.max(0.35, (h / 12) * uv);
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setXY(i, uvAttr.getX(i) * su, uvAttr.getY(i) * sv);
  }
  return g;
}

function cylinderGeo(rt, rb, h, seg, x, y, z) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
  g.translate(x, y, z);
  return g;
}

function labelTexture(text, accent, sub = '') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 112;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8,18,24,.78)'; g.fillRect(0, 0, 512, 112);
  g.strokeStyle = accent; g.lineWidth = 4; g.strokeRect(3, 3, 506, 106);
  g.fillStyle = '#fff'; g.font = 'bold 44px "Microsoft YaHei", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, sub ? 44 : 56);
  if (sub) {
    g.fillStyle = 'rgba(235,245,250,.78)';
    g.font = '22px "Microsoft YaHei", sans-serif';
    g.fillText(sub, 256, 84);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSign(text, accent, sub, w, h, x, y, z) {
  const tex = labelTexture(text, accent, sub);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = Math.PI; // 立面朝南（公园方向），避免招牌朝北看不见
  mesh.name = `City/sign-${text}`;
  return { mesh, geo, mat, tex };
}

export function buildCityBuildings({ group, owned }) {
  const mapGlass = makeGlassFacade('#2f6776');
  const mapNight = makeNightWindows();
  const mapTrack = makeTrackTexture();
  /* 【视觉提质】玻璃幕墙加程序化法线贴图 + 粗糙度贴图（零增面 / 零 draw call）：
   * 窗框有真实凹凸高光、玻璃有镜面变化，告别"平贴纸"塑料感。
   * 一次性生成并登记 owned.textures，dispose 成对释放，Δtex 不漂。 */
  const mapGlassNormal = makeGlassNormalMap();
  const mapGlassRough = makeGlassRoughness();
  owned.textures.push(mapGlass, mapNight, mapTrack, mapGlassNormal, mapGlassRough);

  const mkGlass = (color, emissiveIntensity = 0) => {
    const m = new THREE.MeshStandardMaterial({
      color, map: mapGlass, emissive: 0xffc38a, emissiveMap: mapNight,
      emissiveIntensity, roughness: 0.52, metalness: 0.16,
      normalMap: mapGlassNormal, roughnessMap: mapGlassRough,
      normalScale: new THREE.Vector2(0.55, 0.55),
    });
    owned.materials.push(m);
    return m;
  };
  const glassA = mkGlass(0xffffff);
  const glassB = mkGlass(0xa8d4d0);
  const glassC = mkGlass(0xc0ccd4);
  const roof = new THREE.MeshStandardMaterial({ color: 0x33454f, roughness: 0.82, metalness: 0.1 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe4eef2, roughness: 0.7 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc23b34, roughness: 0.6 });
  const beige = new THREE.MeshStandardMaterial({ color: 0xe6dcc2, roughness: 0.85 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x7d8e96, roughness: 0.5, metalness: 0.35 });
  const trackMat = new THREE.MeshStandardMaterial({ map: mapTrack, roughness: 0.95 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.25 });
  owned.materials.push(roof, white, red, beige, accent, trackMat, glow);

  const detail = { a: [], b: [], c: [], roof: [], white: [], red: [], beige: [], accent: [], glow: [] };
  const mid = { a: [], b: [], c: [], white: [], beige: [], accent: [] };
  const far = [];
  const cx = CITY.center.x, cz = CITY.center.z;
  const glassMats = [glassA, glassB, glassC];
  const glassKeys = ['a', 'b', 'c'];
  const nearExtras = [];

  const addSign = (cfg) => {
    nearExtras.push(cfg.mesh);
    owned.geometries.push(cfg.geo);
    owned.materials.push(cfg.mat);
    owned.textures.push(cfg.tex);
  };

  // ---- 医院：双翼合并体量 + 中央连廊 + 红十字 + 入口雨棚 ----
  {
    const x = HOSPITAL.x - cx, z = HOSPITAL.z - cz, w = HOSPITAL.w, d = HOSPITAL.d;
    detail.white.push(boxGeo(11, 32, d, x - 8.2, Y0 + 16, z));
    detail.white.push(boxGeo(11, 29, d, x + 8.2, Y0 + 14.5, z));
    detail.white.push(boxGeo(7, 18, d * 0.72, x, Y0 + 9, z + 1));
    detail.a.push(boxGeo(w - 1.2, 22, 0.36, x, Y0 + 15.5, z - d / 2 - 0.18, 0.6));
    // 屋顶红十字 + 入口红十字（朝南）
    detail.red.push(boxGeo(7.4, 1.35, 0.55, x - 8.2, Y0 + 34.2, z - d / 2 - 0.36));
    detail.red.push(boxGeo(1.35, 7.4, 0.55, x - 8.2, Y0 + 34.2, z - d / 2 - 0.36));
    detail.red.push(boxGeo(3.2, 0.75, 0.32, x, Y0 + 15.5, z - d / 2 - 0.44));
    detail.red.push(boxGeo(0.75, 3.2, 0.32, x, Y0 + 15.5, z - d / 2 - 0.44));
    // 【屋顶设备层】女儿墙压顶 + 两座机房 + 冷却塔，让医院天际线不空
    detail.roof.push(boxGeo(11.4, 0.5, d + 0.2, x - 8.2, Y0 + 32.4, z));
    detail.roof.push(boxGeo(11.4, 0.5, d + 0.2, x + 8.2, Y0 + 29.4, z));
    detail.accent.push(boxGeo(3.0, 1.8, 2.6, x - 10, Y0 + 33.3, z + 1));
    detail.accent.push(boxGeo(2.2, 1.2, 2.0, x - 6.5, Y0 + 32.9, z - 1));
    detail.roof.push(cylinderGeo(0.9, 1.1, 1.4, 8, x + 9.5, Y0 + 30.2, z + 1));
    // 入口雨棚与落客区
    detail.accent.push(boxGeo(9, 0.28, 4.2, HOSPITAL.entrance.x - cx, Y0 + 4.1, HOSPITAL.entrance.z - cz));
    detail.glow.push(boxGeo(7.4, 0.14, 2.9, HOSPITAL.entrance.x - cx, Y0 + 0.08, HOSPITAL.entrance.z - cz));
    mid.white.push(boxGeo(w, 31, d, x, Y0 + 15.5, z));
    far.push(boxGeo(w, 31, d, x, Y0 + 15.5, z));
    addSign(makeSign(
      '市人民医院', '#e25b52', '急诊 · 门诊 · 住院',
      10.5, 2.1, x - 8.2, Y0 + 25.2, z - d / 2 - 0.42,
    ));
  }

  // ---- 学校：教学楼 + 体育馆 + 标准跑道（前场朝南） ----
  {
    const x = SCHOOL.x - cx, z = SCHOOL.z - cz;
    // 教学楼在东侧，体育馆在西侧，跑道放在南侧前场
    detail.white.push(boxGeo(14, 11, 7, x + 5, Y0 + 5.5, z + 2));
    detail.beige.push(boxGeo(9, 8, 8, x - 8, Y0 + 4, z + 3));
    detail.a.push(boxGeo(13.4, 3.2, 0.3, x + 5, Y0 + 5.2, z - 1.62, 0.55));
    // 入口雨棚
    detail.accent.push(boxGeo(7.5, 0.24, 3.4, SCHOOL.entrance.x - cx, Y0 + 3.5, SCHOOL.entrance.z - cz));
    // 跑道贴图：放在校园南侧前场，避免和教学楼重叠
    const track = new THREE.PlaneGeometry(17, 7);
    track.rotateX(-Math.PI / 2);
    track.translate(x - 8, Y0 + 0.045, z - 9.4);
    const trackMesh = new THREE.Mesh(track, trackMat);
    trackMesh.name = 'City/school-track';
    nearExtras.push(trackMesh);
    owned.geometries.push(track);
    mid.white.push(boxGeo(14, 11, 7, x + 5, Y0 + 5.5, z + 2));
    mid.beige.push(boxGeo(9, 8, 8, x - 8, Y0 + 4, z + 3));
    far.push(boxGeo(14, 11, 7, x + 5, Y0 + 5.5, z + 2));
    far.push(boxGeo(9, 8, 8, x - 8, Y0 + 4, z + 3));
    // 校牌贴入口雨棚前沿，不再挂到操场/跑道上方。
    addSign(makeSign(
      '实验学校', '#4da3d8', '小学 · 初中 · 体育馆',
      5.2, 1.0, x, Y0 + 4.25, z - 9.86,
    ));
  }

  // ---- 商场：整面玻璃幕墙 + 入口中庭 + 屋顶招牌（朝南） ----
  {
    const x = MALL.x - cx, z = MALL.z - cz, w = MALL.w, d = MALL.d;
    detail.b.push(boxGeo(w, 28, d, x, Y0 + 14, z));
    // 正面玻璃幕墙（比主体外凸 0.3m，朝公园）
    detail.b.push(boxGeo(w - 1.8, 25, 0.34, x, Y0 + 13.2, z - d / 2 - 0.2, 0.7));
    detail.white.push(boxGeo(w + 1.2, 3.6, d + 1.2, x, Y0 + 1.8, z));
    detail.accent.push(boxGeo(13.2, 0.32, 4.8, MALL.entrance.x - cx, Y0 + 4.25, MALL.entrance.z - cz));
    // 中庭玻璃穹顶（半球，8×5 段）
    const dome = new THREE.SphereGeometry(4.2, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    dome.translate(x, Y0 + 28, z + 1);
    detail.b.push(dome);
    // 立面竖梃，只加在正面，形成商场辨识度
    for (let k = -5; k <= 5; k++) {
      detail.accent.push(boxGeo(0.12, 24, 0.42, x + k * 2.15, Y0 + 13.2, z - d / 2 - 0.48));
    }
    // 【屋顶设备】穹顶两侧机房 + 女儿墙压顶 + 排风塔
    detail.roof.push(boxGeo(w + 0.4, 0.55, d + 0.4, x, Y0 + 28.3, z));
    for (const s of [-1, 1]) {
      detail.accent.push(boxGeo(2.8, 1.9, 2.4, x + s * (w / 2 - 2.6), Y0 + 29.3, z + 2));
      detail.roof.push(cylinderGeo(0.45, 0.45, 2.4, 6, x + s * (w / 2 - 4.2), Y0 + 29.5, z - 2));
    }
    detail.glow.push(boxGeo(10.6, 0.18, 3.2, MALL.entrance.x - cx, Y0 + 0.09, MALL.entrance.z - cz));
    mid.b.push(boxGeo(w, 28, d, x, Y0 + 14, z));
    far.push(boxGeo(w, 28, d, x, Y0 + 14, z));
    addSign(makeSign(
      '大都会广场', '#d8a54a', '购物 · 餐饮 · 影院',
      10.8, 2.2, x, Y0 + 23.3, z - d / 2 - 0.55,
    ));
  }

  // ---- 大裤衩：两条斜腿在顶部连成悬挑环 ----
  {
    const b = CITY_BLOCKS.find((v) => v.role === 'cctv');
    const x = b.x - cx, z = b.z - cz;
    // 每侧 6 段，逐段向中轴内收，形成两条连续斜腿
    for (let side = -1; side <= 1; side += 2) {
      const baseX = x + side * 8.7;
      for (let s = 0; s < 6; s++) {
        const h = 10.5;
        const y = Y0 + s * h + h / 2;
        const shift = -side * s * 0.72;
        detail.c.push(boxGeo(6.4, h + 0.18, 8.6 + s * 0.28, baseX + shift, y, z));
        detail.accent.push(boxGeo(0.38, h, 8.95 + s * 0.28, baseX + shift + side * 3.1, y, z));
      }
    }
    // 悬挑连廊 / 顶冠
    detail.c.push(boxGeo(22.5, 8.2, 9.8, x, Y0 + 67.2, z));
    detail.accent.push(boxGeo(23.2, 0.7, 10.4, x, Y0 + 71.6, z));
    detail.roof.push(boxGeo(6.2, 1.0, 6.2, x, Y0 + 73.6, z));
    // 【顶冠设备】天线阵列 + 航标灯座，强化悬挑环的工业细节
    for (const s of [-1, 1]) {
      detail.accent.push(boxGeo(0.28, 4.2, 0.28, x + s * 9.5, Y0 + 74.0, z));
      detail.roof.push(cylinderGeo(0.34, 0.34, 0.5, 6, x + s * 9.5, Y0 + 76.3, z));
    }
    // 中间留空的“裤裆”由两条腿自然形成，不填实
    mid.c.push(boxGeo(23, 63, 10, x, Y0 + 31.5, z));
    far.push(boxGeo(23, 63, 10, x, Y0 + 31.5, z));
  }

  // ---- 尖塔：八边形收分塔身 + 高耸锥顶 ----
  {
    const b = CITY_BLOCKS.find((v) => v.role === 'spire');
    const x = b.x - cx, z = b.z - cz;
    detail.a.push(cylinderGeo(6.0, 9.2, 70, 8, x, Y0 + 35, z));
    detail.a.push(cylinderGeo(4.2, 6.0, 22, 8, x, Y0 + 81, z));
    const crown = new THREE.ConeGeometry(4.2, 17, 8);
    crown.translate(x, Y0 + 100.5, z);
    detail.white.push(crown);
    // 【观景台】塔身 60m 处加一圈外挑环廊 + 顶部设备环，打破单调收分
    detail.accent.push(cylinderGeo(8.4, 8.4, 1.6, 8, x, Y0 + 60, z));
    detail.roof.push(cylinderGeo(7.6, 8.0, 1.0, 8, x, Y0 + 92, z));
    detail.accent.push(cylinderGeo(0.22, 0.42, 11, 5, x, Y0 + 112.5, z));
    detail.roof.push(cylinderGeo(9.5, 9.9, 1.5, 8, x, Y0 + 1, z));
    mid.a.push(cylinderGeo(6.8, 9.2, 82, 8, x, Y0 + 41, z));
    far.push(boxGeo(15, 82, 15, x, Y0 + 41, z));
  }

  // ---- 退台塔：三段退台 + 空中花园 + 斜切屋顶 ----
  {
    const b = CITY_BLOCKS.find((v) => v.role === 'terrace');
    const x = b.x - cx, z = b.z - cz;
    const levels = [
      { w: 26, d: 20, h: 21, y: 10.5 },
      { w: 20.5, d: 16, h: 17, y: 29.5 },
      { w: 15, d: 12, h: 14, y: 45 },
    ];
    levels.forEach((l, i) => {
      detail[i === 1 ? 'b' : 'c'].push(boxGeo(l.w, l.h, l.d, x, Y0 + l.y, z));
      detail.accent.push(boxGeo(l.w + 0.8, 0.55, l.d + 0.8, x, Y0 + l.y + l.h / 2, z));
      // 退台边缘绿化带
      detail.glow.push(boxGeo(l.w + 0.3, 0.22, l.d + 0.3, x, Y0 + l.y + l.h / 2 + 0.42, z));
    });
    const cap = new THREE.BoxGeometry(15, 4.5, 12);
    cap.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.14));
    cap.translate(x, Y0 + 54.2, z);
    detail.white.push(cap);
    // 【屋顶机房】斜切顶盖旁的设备房 + 两组排风筒
    detail.roof.push(boxGeo(4.0, 1.6, 3.4, x - 4, Y0 + 52.5, z));
    for (const s of [-1, 1]) {
      detail.accent.push(cylinderGeo(0.42, 0.42, 1.8, 6, x + s * 3, Y0 + 53.2, z - 2));
    }
    detail.roof.push(boxGeo(1.1, 14, 1.1, x, Y0 + 62, z));
    mid.c.push(boxGeo(25, 50, 18, x, Y0 + 25, z));
    far.push(boxGeo(25, 50, 18, x, Y0 + 25, z));
  }

  const addMerged = (geos, material, name) => {
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) return null;
    owned.geometries.push(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  };

  const lod = new THREE.LOD();
  lod.name = 'City/LOD';
  const near = new THREE.Group();
  near.name = 'City/near';
  for (const e of nearExtras) near.add(e);
  for (const k of glassKeys) {
    const m = addMerged(detail[k], glassMats[glassKeys.indexOf(k)], `City/block-${k}`);
    if (m) near.add(m);
  }
  for (const [key, material, name] of [
    ['roof', roof, 'City/roofs'],
    ['white', white, 'City/public-white'],
    ['red', red, 'City/hospital-cross'],
    ['beige', beige, 'City/school-wing'],
    ['accent', accent, 'City/facade-trim'],
    ['glow', glow, 'City/warm-trim'],
  ]) {
    const m = addMerged(detail[key], material, name);
    if (m) near.add(m);
  }

  const midGroup = new THREE.Group();
  midGroup.name = 'City/mid';
  for (const k of glassKeys) {
    const m = addMerged(mid[k], glassMats[glassKeys.indexOf(k)], `City/mid-${k}`);
    if (m) midGroup.add(m);
  }
  const mw = addMerged(mid.white, white, 'City/mid-white');
  if (mw) midGroup.add(mw);
  const mb = addMerged(mid.beige, beige, 'City/mid-beige');
  if (mb) midGroup.add(mb);
  const ma = addMerged(mid.accent, accent, 'City/mid-accent');
  if (ma) midGroup.add(ma);

  const farMat = new THREE.MeshStandardMaterial({
    color: 0x8fb3b5, map: mapGlass, emissive: 0xffc38a, emissiveMap: mapNight,
    emissiveIntensity: 0.0, roughness: 0.9, metalness: 0.05,
  });
  owned.materials.push(farMat);
  const farGroup = new THREE.Group();
  farGroup.name = 'City/far';
  const fm = addMerged(far, farMat, 'City/far-merged');
  if (fm) farGroup.add(fm);

  lod.addLevel(near, 0);
  lod.addLevel(midGroup, 160);
  lod.addLevel(farGroup, 260);
  lod.position.set(cx, 0, cz);
  group.add(lod);
  owned.lod = lod;

  return {
    materials: { glassA, glassB, glassC, roof, white, red, beige, accent, farMat },
    setNight(f) {
      // 柔和窗光：夜间单窗亮度约 0.74，不过曝；远景色块更暗
      const e = 0.012 + f * 0.73;
      for (const m of glassMats) m.emissiveIntensity = e;
      farMat.emissiveIntensity = e * 0.68;
      farMat.color.setHex(f > 0.5 ? 0x40555c : 0x8fb3b5);
      glow.opacity = 0.18 + f * 0.30;
    },
    stats: {
      towers: TOWER_SLOTS.length,
      blocks: CITY_BLOCKS.reduce((n, b) => n + b.lots, 0),
      buildings: CITY_BLOCKS.length,
      roles: CITY_BLOCKS.map((b) => b.role),
      hospital: true, school: true, mall: true,
      hospitalCross: true, schoolTrack: true, mallGlass: true,
      detailTriangles: 0,
    },
  };
}
