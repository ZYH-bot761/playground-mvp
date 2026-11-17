/**
 * 大裤衩屋顶停机坪 + 城市空中交通。
 * - CCTV 顶冠上加 17m 停机坪：H 标、边灯、风向袋、支撑桁架；
 * - 一架 eVTOL 空中出租车按“进近 → 垂直下降 → 停靠 → 起飞 → 巡航”闭环；
 * - 两架高空客机绕城飞行，只做低模与旋转，不参与物理。
 */
import * as THREE from 'three';
import { CITY } from './city-layout.js';

const Y = CITY.pad.y;
const PAD_X = -22;
const PAD_Z = 172;
const PAD_Y = Y + 75.3;

function box(w, h, d, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.25 });
  return new THREE.Mesh(g, m);
}

function makeHelipad(owned) {
  const g = new THREE.Group();
  g.name = 'City/helipad';
  const deckGeo = new THREE.CylinderGeometry(8.4, 8.4, 0.62, 24);
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x37444a, roughness: 0.86, metalness: 0.2 });
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.y = PAD_Y;
  g.add(deck);
  owned.geometries.push(deckGeo);
  owned.materials.push(deckMat);

  // 黄色识别圈 + H
  const ringGeo = new THREE.TorusGeometry(7.1, 0.16, 5, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xf3c84b, toneMapped: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = PAD_Y + 0.34;
  g.add(ring);
  const hMat = new THREE.MeshBasicMaterial({ color: 0xf6f1dc });
  const hParts = [];
  for (const x of [-2.8, 2.8]) {
    const geo = new THREE.BoxGeometry(0.9, 0.05, 6.2);
    geo.translate(x, 0, 0);
    hParts.push(geo);
  }
  const cross = new THREE.BoxGeometry(5.6, 0.05, 0.9);
  hParts.push(cross);
  const hGeo = hParts.reduce((acc, geo) => {
    const q = geo.index ? geo.toNonIndexed() : geo;
    acc.push(q);
    return acc;
  }, []);
  // 手动合并三块 H，避免额外 draw。
  const pos = [];
  const idx = [];
  let base = 0;
  for (const q of hGeo) {
    pos.push(...q.attributes.position.array);
    for (let i = 0; i < q.attributes.position.count; i += 1) idx.push(base + i);
    base += q.attributes.position.count;
    q.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setIndex(idx);
  merged.computeVertexNormals();
  const h = new THREE.Mesh(merged, hMat);
  h.rotation.x = 0;
  h.position.y = PAD_Y + 0.37;
  g.add(h);
  owned.geometries.push(ringGeo, merged);
  owned.materials.push(ringMat, hMat);

  // 支撑桁架，从大裤衩顶冠托起圆盘
  const strutMat = new THREE.MeshStandardMaterial({ color: 0x6f7b80, roughness: 0.5, metalness: 0.55 });
  owned.materials.push(strutMat);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const geo = new THREE.CylinderGeometry(0.12, 0.12, 4.4, 5);
    geo.rotateZ(Math.cos(a) * 0.28);
    geo.rotateX(Math.sin(a) * 0.28);
    geo.translate(Math.cos(a) * 6.6, PAD_Y - 2.4, Math.sin(a) * 6.6);
    const m = new THREE.Mesh(geo, strutMat);
    g.add(m);
    owned.geometries.push(geo);
  }

  // 边灯一圈，夜间是清晰的一圈暖白。
  const lampGeo = new THREE.SphereGeometry(0.12, 6, 4);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffe6a8, toneMapped: false });
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, 12);
  lamps.name = 'City/helipad-lights';
  const d = new THREE.Object3D();
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    d.position.set(Math.cos(a) * 7.85, PAD_Y + 0.38, Math.sin(a) * 7.85);
    d.updateMatrix();
    lamps.setMatrixAt(i, d.matrix);
  }
  lamps.position.set(PAD_X, 0, PAD_Z);
  g.add(lamps);
  owned.geometries.push(lampGeo);
  owned.materials.push(lampMat);
  g.position.set(PAD_X, 0, PAD_Z);

  return { group: g, lampMat, padTop: PAD_Y + 0.4 };
}

function makeShuttle(owned) {
  const g = new THREE.Group();
  g.name = 'City/air-taxi';
  const white = new THREE.MeshStandardMaterial({ color: 0xe8eef0, roughness: 0.34, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d3138, roughness: 0.28, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x2c9eb4, roughness: 0.4, metalness: 0.3 });
  owned.materials.push(white, dark, accent);
  const bodyGeo = new THREE.CapsuleGeometry(0.66, 2.4, 3, 8);
  bodyGeo.rotateX(Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, white);
  body.scale.set(1, 0.72, 1);
  g.add(body);
  const glassGeo = new THREE.SphereGeometry(0.58, 8, 5);
  const glass = new THREE.Mesh(glassGeo, dark);
  glass.scale.set(0.9, 0.55, 1.15);
  glass.position.set(0, 0.13, 0.85);
  g.add(glass);
  owned.geometries.push(glassGeo);
  const wingGeo = new THREE.BoxGeometry(5.4, 0.12, 0.9);
  const wing = new THREE.Mesh(wingGeo, accent);
  wing.position.z = 0.05;
  g.add(wing);
  const tailGeo = new THREE.BoxGeometry(0.12, 0.9, 1.2);
  const tail = new THREE.Mesh(tailGeo, accent);
  tail.position.set(0, 0.5, -1.35);
  g.add(tail);
  const rotorGeo = new THREE.CylinderGeometry(0.58, 0.58, 0.045, 10);
  const rotorMat = new THREE.MeshBasicMaterial({ color: 0xa6bcc2, transparent: true, opacity: 0.72 });
  owned.materials.push(rotorMat);
  const rotors = [];
  const pods = [];
  for (const [x, z] of [[-2.2, 0.7], [2.2, 0.7], [-2.2, -0.8], [2.2, -0.8]]) {
    const podGeo = new THREE.CylinderGeometry(0.16, 0.20, 0.55, 6);
    const pod = new THREE.Mesh(podGeo, dark);
    pod.position.set(x, -0.02, z);
    g.add(pod);
    pods.push(podGeo);
    const rotor = new THREE.Mesh(rotorGeo, rotorMat);
    rotor.position.set(x, 0.30, z);
    g.add(rotor);
    rotors.push(rotor);
  }
  owned.geometries.push(bodyGeo, wingGeo, tailGeo, rotorGeo, ...pods);
  const navGeo = new THREE.SphereGeometry(0.10, 5, 4);
  const navMat = new THREE.MeshBasicMaterial({ color: 0xff5546, toneMapped: false });
  owned.geometries.push(navGeo);
  owned.materials.push(navMat);
  const nav = new THREE.Mesh(navGeo, navMat);
  nav.position.set(0, 0.5, -1.95);
  g.add(nav);
  return { group: g, rotors, navMat };
}

function makeAirliner(owned, tint) {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xe5edf0, roughness: 0.42, metalness: 0.3 });
  const stripe = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.46, metalness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b343d, roughness: 0.24, metalness: 0.4 });
  owned.materials.push(hull, stripe, glass);
  const bodyGeo = new THREE.CylinderGeometry(0.8, 0.8, 9, 8);
  bodyGeo.rotateX(Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, hull);
  g.add(body);
  const noseGeo = new THREE.SphereGeometry(0.8, 8, 5);
  const nose = new THREE.Mesh(noseGeo, hull);
  nose.scale.set(1, 1, 1.4);
  nose.position.z = 4.2;
  g.add(nose);
  const wingGeo = new THREE.BoxGeometry(12, 0.18, 2.4);
  const wing = new THREE.Mesh(wingGeo, stripe);
  wing.position.z = 0.3;
  g.add(wing);
  const tailWing = new THREE.BoxGeometry(4, 0.14, 1.2);
  const tail = new THREE.Mesh(tailWing, stripe);
  tail.position.set(0, 0.4, -4.0);
  g.add(tail);
  const finGeo = new THREE.BoxGeometry(0.15, 2.1, 1.8);
  const fin = new THREE.Mesh(finGeo, stripe);
  fin.position.set(0, 1.0, -4.2);
  g.add(fin);
  const engineGeo = new THREE.CylinderGeometry(0.38, 0.34, 1.5, 7);
  engineGeo.rotateX(Math.PI / 2);
  const engines = [];
  for (const x of [-3.7, 3.7]) {
    const e = new THREE.Mesh(engineGeo, glass);
    e.position.set(x, -0.46, 0.6);
    g.add(e);
    engines.push(e);
  }
  // 必须登记实际用于机头的 noseGeo；旧写法又新建了一个未使用的球，
  // 导致每次城市重建泄漏 2 个已上传 geometry（两架客机各 1 个）。
  owned.geometries.push(bodyGeo, wingGeo, tailWing, finGeo, engineGeo, noseGeo);
  return g;
}

export function buildCityAir({ group, owned }) {
  const root = new THREE.Group();
  root.name = 'City/air-traffic';
  group.add(root);

  const pad = makeHelipad(owned);
  root.add(pad.group);
  const shuttle = makeShuttle(owned);
  root.add(shuttle.group);
  const planeA = makeAirliner(owned, 0x287e9d);
  const planeB = makeAirliner(owned, 0xb7553b);
  root.add(planeA, planeB);

  // 闭环关键帧：远处巡航 → 进近 → 下降 → 停靠 → 起飞 → 爬升离场。
  // 用平滑插值，不在运行时重建曲线。
  const keys = [
    [0.00, 54, 242, 102],
    [0.16, 8, 210, 94],
    [0.30, -22, 178, 86],
    [0.38, -22, 172, PAD_Y + 1.0],
    [0.52, -22, 172, PAD_Y + 1.0],
    [0.62, -22, 172, PAD_Y + 12],
    [0.76, 24, 205, 96],
    [0.90, 58, 238, 108],
    [1.00, 54, 242, 102],
  ];
  const smooth = (x) => x * x * (3 - 2 * x);
  const sample = (p, out) => {
    for (let i = 0; i < keys.length - 1; i += 1) {
      const a = keys[i], b = keys[i + 1];
      if (p >= a[0] && p <= b[0]) {
        const k = smooth((p - a[0]) / Math.max(0.0001, b[0] - a[0]));
        out.set(a[1] + (b[1] - a[1]) * k, a[3] + (b[3] - a[3]) * k, a[2] + (b[2] - a[2]) * k);
        return;
      }
    }
    out.set(keys[0][1], keys[0][3], keys[0][2]);
  };
  const pos = new THREE.Vector3();
  const prev = new THREE.Vector3(54, 102, 242);
  let time = 0;
  let lastY = 0;
  return {
    stats: { helipad: [PAD_X, PAD_Y, PAD_Z], shuttle: true, airliners: 2 },
    update(dt) {
      time += dt;
      const p = (time % 46) / 46;
      sample(p, pos);
      const dx = pos.x - prev.x;
      const dz = pos.z - prev.z;
      // 用“上一帧位置”求航向；原先复制 position 后再相减恒为 0，机身永远朝北。
      if (Math.hypot(dx, dz) > 1e-4) shuttle.group.rotation.y = Math.atan2(dx, dz);
      prev.copy(pos);
      shuttle.group.position.copy(pos);
      const rotorSpeed = p > 0.40 && p < 0.60 ? 6 : 34;
      for (const rotor of shuttle.rotors) rotor.rotation.y += dt * rotorSpeed;
      const bank = Math.sin(p * Math.PI * 2) * 0.05;
      shuttle.group.rotation.z = bank;
      // 客机绕城巡航，高度不同，避免重叠。
      const a1 = time * 0.035;
      const a2 = time * 0.026 + 2.3;
      planeA.position.set(Math.cos(a1) * 152, 118 + Math.sin(time * 0.2) * 2.5, 168 + Math.sin(a1) * 152);
      planeA.rotation.y = -a1;
      planeA.rotation.z = 0.08;
      planeB.position.set(Math.cos(a2) * 188, 142 + Math.sin(time * 0.17 + 1) * 3, 168 + Math.sin(a2) * 188);
      planeB.rotation.y = -a2;
      planeB.rotation.z = -0.05;
      lastY = pos.y;
    },
    setNight(f) {
      pad.lampMat.color.setHex(f > 0.3 ? 0xffe6a8 : 0xfff3cf);
      shuttle.navMat.color.setHex(Math.sin(time * 6) > 0 ? 0xff5546 : 0x5a1a16);
    },
    get altitude() { return lastY; },
  };
}
