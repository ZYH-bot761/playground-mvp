/** 都会区建筑：18 座塔楼 + 医院 + 学校，三级 LOD 全部合并顶点。 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY, TOWER_SLOTS, HOSPITAL, SCHOOL } from './city-layout.js';
import { makeGlassFacade, makeNightWindows, makeTrackTexture } from './city-textures.js';

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

function labelTexture(text, accent) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8,18,24,.72)'; g.fillRect(0, 0, 512, 96);
  g.strokeStyle = accent; g.lineWidth = 4; g.strokeRect(3, 3, 506, 90);
  g.fillStyle = '#fff'; g.font = 'bold 46px "Microsoft YaHei", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildCityBuildings({ group, owned }) {
  const mapGlass = makeGlassFacade('#2f6776');
  const mapNight = makeNightWindows();
  const mapTrack = makeTrackTexture();
  owned.textures.push(mapGlass, mapNight, mapTrack);

  const mkGlass = (color) => {
    const m = new THREE.MeshStandardMaterial({
      color, map: mapGlass, emissive: 0xffc38a, emissiveMap: mapNight,
      emissiveIntensity: 0.0, roughness: 0.52, metalness: 0.16,
    });
    owned.materials.push(m);
    return m;
  };
  const glassA = mkGlass(0xffffff);
  const glassB = mkGlass(0x9ed0cc);
  const glassC = mkGlass(0xb9c6cf);
  const roof = new THREE.MeshStandardMaterial({ color: 0x33454f, roughness: 0.82, metalness: 0.1 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe4eef2, roughness: 0.7 });
  const red = new THREE.MeshStandardMaterial({ color: 0xb8403a, roughness: 0.65 });
  const beige = new THREE.MeshStandardMaterial({ color: 0xe6dcc2, roughness: 0.85 });
  const trackMat = new THREE.MeshStandardMaterial({ map: mapTrack, roughness: 0.95 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.55 });
  owned.materials.push(roof, white, red, beige, trackMat, glow);

  const detail = {
    a: [], b: [], c: [], roof: [], white: [], red: [], beige: [], glow: [],
  };
  const mid = { a: [], b: [], c: [], white: [], beige: [] };
  const far = [];
  const nearExtras = [];
  const cx = CITY.center.x, cz = CITY.center.z;
  const glassMats = [glassA, glassB, glassC];
  const glassKeys = ['a', 'b', 'c'];

  // ---- 18 座塔楼：三段收分 + 屋顶 + 部分天线，近距离为合并几何 ----
  TOWER_SLOTS.forEach((t, i) => {
    const x = t.x - cx, z = t.z - cz;
    const h = t.h, w = t.w, d = t.d;
    const h1 = h * 0.55, h2 = h * 0.30, h3 = h * 0.15;
    const w2 = w * 0.76, w3 = w * 0.52;
    const key = glassKeys[i % 3];
    detail[key].push(boxGeo(w, h1, d, x, Y0 + h1 / 2, z));
    detail[key].push(boxGeo(w2, h2, w2 * (d / w), x, Y0 + h1 + h2 / 2, z));
    detail[key].push(boxGeo(w3, h3, w3 * (d / w), x, Y0 + h1 + h2 + h3 / 2, z));
    detail.roof.push(boxGeo(w3 * 1.12, 1.7, w3 * 1.12, x, Y0 + h + 0.85, z));
    // 立面竖向遮阳肋：只给近景 6 座最高塔，保持细节但不爆面
    if (h > 90) {
      for (let k = -2; k <= 2; k++) {
        detail.roof.push(boxGeo(0.32, h1, 0.5, x + k * (w / 5), Y0 + h1 / 2, z + d / 2 - 0.1));
      }
    }
    if (i % 4 === 0) {
      const ant = new THREE.CylinderGeometry(0.22, 0.34, 7 + (i % 3) * 3, 5);
      ant.translate(x, Y0 + h + 4.5, z);
      detail.roof.push(ant);
    }
    mid[key].push(boxGeo(w, h, d, x, Y0 + h / 2, z));
    far.push(boxGeo(w, h, d, x, Y0 + h / 2, z));
  });

  // ---- 医院：白体量 + 玻璃带 + 屋顶红十字 + 停机坪 ----
  {
    const x = HOSPITAL.x - cx, z = HOSPITAL.z - cz, w = HOSPITAL.w, d = HOSPITAL.d;
    detail.white.push(boxGeo(w, 27, d, x, Y0 + 13.5, z));
    detail.white.push(boxGeo(w * 0.46, 19, d * 1.35, x - w * 0.39, Y0 + 9.5, z + 1));
    detail.a.push(boxGeo(w - 1.4, 22, 0.3, x, Y0 + 12.5, z + d / 2 + 0.17, 0.5));
    detail.red.push(boxGeo(4.2, 1.15, 0.42, x, Y0 + 24.2, z + d / 2 + 0.38));
    detail.red.push(boxGeo(1.15, 4.2, 0.42, x, Y0 + 24.2, z + d / 2 + 0.38));
    const pad = new THREE.CylinderGeometry(5, 5, 0.3, 12);
    pad.translate(x, Y0 + 27.2, z);
    detail.white.push(pad);
    mid.white.push(boxGeo(w, 27, d, x, Y0 + 13.5, z));
    far.push(boxGeo(w, 27, d, x, Y0 + 13.5, z));

    const tex = labelTexture('市人民医院', '#e25b52');
    owned.textures.push(tex);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(8.5, 1.6), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    owned.materials.push(sign.material);
    sign.position.set(x, Y0 + 19.2, z + d / 2 + 0.48);
    nearExtras.push(sign);
    owned.geometries.push(sign.geometry);
  }

  // ---- 学校：教学楼 + 体育馆 + 标准跑道/球场 ----
  {
    const x = SCHOOL.x - cx, z = SCHOOL.z - cz;
    detail.white.push(boxGeo(21, 13, 9, x - 2, Y0 + 6.5, z + 4));
    detail.beige.push(boxGeo(11, 9, 10, x + 9, Y0 + 4.5, z - 3));
    detail.a.push(boxGeo(20, 4.2, 0.3, x - 2, Y0 + 5.6, z + 8.7, 0.5));
    const track = new THREE.PlaneGeometry(27, 16);
    track.rotateX(-Math.PI / 2);
    track.translate(x, Y0 + 0.035, z - 2);
    const trackMesh = new THREE.Mesh(track, trackMat);
    nearExtras.push(trackMesh);
    owned.geometries.push(track);
    mid.white.push(boxGeo(21, 13, 9, x - 2, Y0 + 6.5, z + 4));
    mid.beige.push(boxGeo(11, 9, 10, x + 9, Y0 + 4.5, z - 3));
    far.push(boxGeo(21, 13, 9, x - 2, Y0 + 6.5, z + 4));
    far.push(boxGeo(11, 9, 10, x + 9, Y0 + 4.5, z - 3));

    const tex = labelTexture('实验学校', '#4da3d8');
    owned.textures.push(tex);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.35), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    owned.materials.push(sign.material);
    sign.position.set(x - 2, Y0 + 10.5, z + 8.72);
    nearExtras.push(sign);
    owned.geometries.push(sign.geometry);
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

  // LOD：近景全部（3 + 屋顶 + 医院 + 学校），中景单盒，远景纯色体块
  const lod = new THREE.LOD();
  lod.name = 'City/LOD';
  const near = new THREE.Group();
  near.name = 'City/near';
  for (const e of nearExtras) near.add(e);
  for (const k of glassKeys) {
    const m = addMerged(detail[k], glassMats[glassKeys.indexOf(k)], `City/tower-${k}`);
    if (m) near.add(m);
  }
  const roofMesh = addMerged(detail.roof, roof, 'City/roofs');
  if (roofMesh) near.add(roofMesh);
  const whiteMesh = addMerged(detail.white, white, 'City/hospital-school');
  if (whiteMesh) near.add(whiteMesh);
  const redMesh = addMerged(detail.red, red, 'City/hospital-cross');
  if (redMesh) near.add(redMesh);
  const beigeMesh = addMerged(detail.beige, beige, 'City/school-wing');
  if (beigeMesh) near.add(beigeMesh);

  const midGroup = new THREE.Group();
  midGroup.name = 'City/mid';
  for (const k of glassKeys) {
    const m = addMerged(mid[k], glassMats[glassKeys.indexOf(k)], `City/mid-${k}`);
    if (m) midGroup.add(m);
  }
  const mw = addMerged(mid.white, white, 'City/mid-hospital');
  if (mw) midGroup.add(mw);
  const mb = addMerged(mid.beige, beige, 'City/mid-school');
  if (mb) midGroup.add(mb);

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
  lod.addLevel(midGroup, 95);
  lod.addLevel(farGroup, 185);
  lod.position.set(cx, 0, cz);
  group.add(lod);
  owned.lod = lod;

  return {
    materials: { glassA, glassB, glassC, roof, white, red, beige, farMat },
    setNight(f) {
      const e = 0.015 + f * 3.5;
      for (const m of glassMats) m.emissiveIntensity = e;
      glow.opacity = 0.25 + f * 0.7;
      farMat.emissiveIntensity = e * 0.8;
      farMat.color.setHex(f > 0.5 ? 0x506a72 : 0x8fb3b5);
    },
    stats: { towers: TOWER_SLOTS.length, detailTriangles: 0 },
  };
}
