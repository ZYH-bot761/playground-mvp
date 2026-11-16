/**
 * ============================================================================
 * CenturyClock.js —— 第八部分：天津世纪钟（大厅地标 + 可进入设施）
 * ============================================================================
 * 造型参考天津世纪钟：巨大双面钟盘 + 金属环框 + 齿轮/日月星辰意象 + 石材
 * 钟楼主体与阶梯基座。刻意避开「AI 感」的圆球+发光环套路，用真实的
 * 建筑比例（宽基座 → 收分塔身 → 顶部大钟盘）和克制的配色。
 *
 * 【可复用构建】
 *   buildClockTower({ scale, track }) 同时被
 *     · Lobby._buildCenturyClockFacade()  —— 大厅里的地标外观
 *     · CenturyClock 设施 init()          —— 玩家进入后的近距离观赏模型
 *   使用，保证「大厅看到的」和「进去看到的」是同一座钟（v3 模块3 思路）。
 *
 * 【钟面 / T05 双面对齐】
 *   createClockFaceTexture() 用 CanvasTexture 画白底 + 黑色刻度 + 阿拉伯数字
 *   + 内圈分钟点阵 + 「世纪钟 / CENTURY CLOCK」铭牌，色空间 SRGB。
 *   CylinderGeometry 端盖 UV 配合 rotation.x=π/2 会让贴图偏转 90°；正反两面贴图
 *   （含发光遮罩）统一 center(0.5,0.5)+rotation=π/2 校正，使两面都是 12上/3右/
 *   6下/9左；背面独立材质与 clone 贴图全部登记台账，dispose 幂等、Δ0/0。
 *   时/分/秒三针为 BoxGeometry 深色金属，绕钟盘法线旋转；tick(new Date())
 *   读系统真实时间；背面指针组 rotation.y=π 已做镜像，正反用同一角度即两面同读时。
 *
 * 【夜间】
 *   正背两面各用一张「黑底发光遮罩」emissiveMap（只点亮刻度/数字，白底不发光，
 *   避免过曝成白球）+ emissiveIntensity 插值，setNight 同步两面；钟盘内侧
 *   PointLight，塔顶 SpotLight 向下打亮基座与台阶；由 setNight(0..1) 平滑驱动，无突变。
 *
 * 【IAttraction 契约】
 *   init / update / onInteract / dispose 齐全；dispose 幂等，释放全部
 *   geometry / material / texture，移除 DOM，完整还原相机与背景/雾。
 *   不调用 world.step()。
 * ============================================================================
 */
import * as THREE from 'three';
import { IAttraction } from './i-attraction.js';
import { dayNightCycle } from '../../utils/helpers/day-night-cycle.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** 每帧复用的共享 Date（update 热路径读时用 setTime 原地刷新，不再 new Date()） */
const _sharedClockDate = new Date();

/* -------------------------------------------------------------------------- */
/* 钟面贴图（1024²，纯 Canvas 程序化，零外部资源）                            */
/* -------------------------------------------------------------------------- */
export function createClockFaceTexture() {
  const SIZE = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const R = SIZE / 2;

  // 象牙白表盘（略微暖色，避免纯白在 ACES 下过曝）
  const bg = g.createRadialGradient(R, R, 40, R, R, R);
  bg.addColorStop(0, '#fdfaf2');
  bg.addColorStop(0.72, '#f3efe4');
  bg.addColorStop(1, '#ded8c8');
  g.fillStyle = bg;
  g.beginPath(); g.arc(R, R, R - 6, 0, TAU); g.fill();

  // 外圈双环（金属压边观感）
  g.strokeStyle = '#2b2f36'; g.lineWidth = 10;
  g.beginPath(); g.arc(R, R, R - 16, 0, TAU); g.stroke();
  g.strokeStyle = '#7d828c'; g.lineWidth = 3;
  g.beginPath(); g.arc(R, R, R - 34, 0, TAU); g.stroke();

  // 分钟刻度：60 格，整点加粗加长
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU - Math.PI / 2;
    const major = i % 5 === 0;
    const rOuter = R - 44;
    const rInner = rOuter - (major ? 46 : 20);
    g.strokeStyle = major ? '#1c2026' : '#5c626b';
    g.lineWidth = major ? 9 : 4;
    g.beginPath();
    g.moveTo(R + Math.cos(a) * rInner, R + Math.sin(a) * rInner);
    g.lineTo(R + Math.cos(a) * rOuter, R + Math.sin(a) * rOuter);
    g.stroke();
  }

  // 内圈分钟点阵（天津世纪钟的精致刻度意象）
  g.fillStyle = '#9aa0a8';
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * TAU - Math.PI / 2;
    const r = R - 108;
    g.beginPath(); g.arc(R + Math.cos(a) * r, R + Math.sin(a) * r, 2.4, 0, TAU); g.fill();
  }
  g.strokeStyle = '#c7c2b4'; g.lineWidth = 2;
  g.beginPath(); g.arc(R, R, R - 132, 0, TAU); g.stroke();

  // 阿拉伯数字 1-12
  g.fillStyle = '#171a20';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 92px Georgia, "Times New Roman", serif';
  for (let n = 1; n <= 12; n++) {
    const a = (n / 12) * TAU - Math.PI / 2;
    const r = R - 196;
    g.fillText(String(n), R + Math.cos(a) * r, R + Math.sin(a) * r + 4);
  }

  // 铭牌：世纪钟 / CENTURY CLOCK / 千禧纪年
  g.fillStyle = '#2b3038';
  g.font = '700 46px "Microsoft YaHei", system-ui, sans-serif';
  g.fillText('世 纪 钟', R, R - 108);
  g.font = '600 25px Georgia, serif';
  g.fillStyle = '#6b7079';
  g.fillText('C E N T U R Y   C L O C K', R, R - 58);
  g.font = '500 30px Georgia, serif';
  g.fillText('MMXXVI', R, R + 170);
  // 日月星辰小意象（细线，不喧宾夺主）
  g.strokeStyle = '#8a8f98'; g.lineWidth = 3;
  g.beginPath(); g.arc(R, R + 118, 15, 0, TAU); g.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    g.beginPath();
    g.moveTo(R + Math.cos(a) * 22, R + 118 + Math.sin(a) * 22);
    g.lineTo(R + Math.cos(a) * 30, R + 118 + Math.sin(a) * 30);
    g.stroke();
  }

  // 中心轴盖
  g.fillStyle = '#1c2026';
  g.beginPath(); g.arc(R, R, 18, 0, TAU); g.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 发光遮罩贴图：黑底 + 只把「刻度 / 数字 / 铭牌」画成亮色。
 * 若直接用表盘贴图当 emissiveMap，象牙白底会被整体点亮 → 夜间过曝成白球，
 * 刻度和指针全部消失。用这张遮罩后，夜间只有刻度与数字发光，表盘保持
 * 可辨识的白色（受环境光），字形清晰。
 */
export function createClockGlowMaskTexture() {
  const SIZE = 512;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const R = SIZE / 2;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, SIZE, SIZE);

  // 分钟 / 小时刻度
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const major = i % 5 === 0;
    const rOuter = R - 22;
    const rInner = rOuter - (major ? 23 : 10);
    g.strokeStyle = major ? '#ffffff' : '#8e8e8e';
    g.lineWidth = major ? 5 : 2;
    g.beginPath();
    g.moveTo(R + Math.cos(a) * rInner, R + Math.sin(a) * rInner);
    g.lineTo(R + Math.cos(a) * rOuter, R + Math.sin(a) * rOuter);
    g.stroke();
  }
  // 数字
  g.fillStyle = '#ffffff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 46px Georgia, "Times New Roman", serif';
  for (let n = 1; n <= 12; n++) {
    const a = (n / 12) * Math.PI * 2 - Math.PI / 2;
    const r = R - 98;
    g.fillText(String(n), R + Math.cos(a) * r, R + Math.sin(a) * r + 2);
  }
  // 铭牌
  g.font = '700 23px "Microsoft YaHei", system-ui, sans-serif';
  g.fillText('世 纪 钟', R, R - 54);
  g.font = '600 13px Georgia, serif';
  g.fillText('C E N T U R Y   C L O C K', R, R - 29);
  // 外环
  g.strokeStyle = '#ffd98a'; g.lineWidth = 4;
  g.beginPath(); g.arc(R, R, R - 8, 0, Math.PI * 2); g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* -------------------------------------------------------------------------- */
/* 钟塔构建（大厅实体 / 设施内共用）                                          */
/* -------------------------------------------------------------------------- */
/**
 * @param {object} o
 * @param {number} [o.scale=1] 整体缩放
 * @param {{geo:Function, mat:Function, tex:Function}} o.track 资源登记回调
 * @returns {{root:THREE.Group, tick:Function, setNight:Function, dispose:Function, faceMat:Object}}
 */
export function buildClockTower({ scale = 1, track }) {
  const reg = track || { geo: (x) => x, mat: (x) => x, tex: (x) => x };
  const geometries = [], materials = [], textures = [];
  const geo = (g) => { geometries.push(g); return reg.geo(g); };
  const mat = (m) => { materials.push(m); return reg.mat(m); };
  const tex = (t) => { textures.push(t); return reg.tex(t); };

  const root = new THREE.Group();
  root.name = 'CenturyClock/tower';
  root.scale.setScalar(scale);

  // 石材：高粗糙度、无金属度，天津世纪钟的花岗岩/不锈钢混合质感
  const stone = mat(new THREE.MeshStandardMaterial({
    color: 0xb9b2a4, roughness: 0.88, metalness: 0.02,
  }));
  const stoneDark = mat(new THREE.MeshStandardMaterial({
    color: 0x8d8779, roughness: 0.9, metalness: 0.02,
  }));
  const steel = mat(new THREE.MeshStandardMaterial({
    color: 0x59626e, roughness: 0.42, metalness: 0.78,
  }));
  const steelDark = mat(new THREE.MeshStandardMaterial({
    color: 0x252b33, roughness: 0.38, metalness: 0.82,
  }));
  const gold = mat(new THREE.MeshStandardMaterial({
    color: 0xc8a44c, roughness: 0.5, metalness: 0.7,
  }));

  const box = geo(new THREE.BoxGeometry(1, 1, 1));
  const cyl = geo(new THREE.CylinderGeometry(1, 1, 1, 24));
  const boxAt = (parent, material, sx, sy, sz, x, y, z) => {
    const m = new THREE.Mesh(box, material);
    m.scale.set(sx, sy, sz); m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  };
  const cylAt = (parent, material, rTop, rBot, h, x, y, z) => {
    const m = new THREE.Mesh(cyl, material);
    m.scale.set(1, h, 1);
    // CylinderGeometry 半径 1，用 scale.x/z 控制半径
    m.scale.set(Math.max(rTop, rBot), h, Math.max(rTop, rBot));
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  };

  /* ---- 阶梯基座（三级，宽→窄，建筑感） ---- */
  boxAt(root, stoneDark, 9.0, 0.42, 9.0, 0, 0.21, 0);
  boxAt(root, stone, 7.8, 0.42, 7.8, 0, 0.63, 0);
  boxAt(root, stoneDark, 6.8, 0.36, 6.8, 0, 1.02, 0);

  /* ---- 塔身：四角立柱 + 收分主体 ---- */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      cylAt(root, stone, 0.42, 0.42, 4.6, sx * 2.35, 3.5, sz * 2.35);
      boxAt(root, steelDark, 1.1, 0.24, 1.1, sx * 2.35, 5.9, sz * 2.35);
    }
  }
  boxAt(root, stone, 4.5, 4.4, 4.5, 0, 3.5, 0);        // 主体方块
  boxAt(root, stoneDark, 5.0, 0.32, 5.0, 0, 5.86, 0);  // 檐口
  // 正面竖向凹槽（真实石材分缝，去掉塑料感）
  for (const sx of [-1.4, -0.47, 0.47, 1.4]) {
    boxAt(root, stoneDark, 0.09, 3.2, 0.06, sx, 3.4, 2.28);
  }

  /* ---- 顶部钟盘支架 + 双面钟盘 ---- */
  boxAt(root, steelDark, 5.4, 0.3, 5.4, 0, 6.16, 0);
  // 支撑颈
  cylAt(root, steel, 0.9, 0.9, 1.0, 0, 6.8, 0);

  const clockGroup = new THREE.Group();
  clockGroup.name = 'CenturyClock/dial';
  clockGroup.position.set(0, 10.2, 0);
  root.add(clockGroup);

  // 钟壳：LatheGeometry 做收边金属环（提示词要求 Lathe/Cylinder）
  const lathePts = [
    new THREE.Vector2(3.02, -0.34), new THREE.Vector2(3.14, -0.28),
    new THREE.Vector2(3.2, 0), new THREE.Vector2(3.14, 0.28),
    new THREE.Vector2(3.02, 0.34),
  ];
  const latheGeo = geo(new THREE.LatheGeometry(lathePts, 48));
  const shell = new THREE.Mesh(latheGeo, steel);
  shell.rotation.x = Math.PI / 2; // 让环面朝向 ±Z
  shell.castShadow = true;
  clockGroup.add(shell);

  const faceTex = tex(createClockFaceTexture());
  // 夜间发光只作用于刻度/数字遮罩，不点亮白底 → 表盘清晰可读不过曝
  const glowTex = tex(createClockGlowMaskTexture());
  // 【T05 修复 · 真根因】CylinderGeometry 端盖 UV 用 (cosθ, sinθ*sign) 径向映射；
  // 配合本文件把圆柱轴从 +Y「躺倒」到 ±Z 的 disc.rotation.x=π/2，Canvas 贴图从正反
  // 两面看都会整体【顺时针偏转 90°】（12 跑到右侧、9 跑到上方）。两个端盖从各自外侧
  // 看布局本就一致（sign 与视向翻转互相抵消），因此【并不存在水平镜像】——不能用
  // repeat.x=-1 去「修」（那会把数字变成反字）。只需把 map/emissiveMap 的 UV 绕中心
  // 旋转 +π/2，即可让两面同时归位为 12上/3右/6下/9左。
  const DIAL_UV_CORRECTION = Math.PI / 2;
  for (const t of [faceTex, glowTex]) {
    t.center.set(0.5, 0.5);
    t.rotation = DIAL_UV_CORRECTION;
    t.needsUpdate = true;
  }
  const faceMat = mat(new THREE.MeshStandardMaterial({
    map: faceTex,
    emissiveMap: glowTex,
    emissive: new THREE.Color(0xffd27a),
    emissiveIntensity: 0.05,
    roughness: 0.72,
    metalness: 0.0,
  }));
  // 【T05】背面使用独立材质：贴图各自 clone 并登记进台账（dispose 幂等、Δ0/0）。
  // 两面共用同一方向的 UV 校正（无水平镜像），保证正反视觉一致、字形都是正像。
  const faceTexBack = tex(faceTex.clone());
  const glowTexBack = tex(glowTex.clone());
  for (const [src, dst] of [[faceTex, faceTexBack], [glowTex, glowTexBack]]) {
    dst.center.set(0.5, 0.5);
    dst.rotation = DIAL_UV_CORRECTION;
    dst.colorSpace = src.colorSpace;
    dst.anisotropy = src.anisotropy;
    dst.needsUpdate = true;
  }
  const faceMatBack = mat(faceMat.clone());
  faceMatBack.map = faceTexBack;
  faceMatBack.emissiveMap = glowTexBack;

  // 双面表盘：正反各一个圆盘，各自独立材质并命名，便于运行时定位与验收
  const discGeo = geo(new THREE.CylinderGeometry(3.0, 3.0, 0.30, 48));
  const discs = [
    { z: 0.17, material: faceMat, name: 'CenturyClock/dial-front' },
    { z: -0.17, material: faceMatBack, name: 'CenturyClock/dial-back' },
  ];
  for (const { z, material, name } of discs) {
    const disc = new THREE.Mesh(discGeo, material);
    disc.name = name;
    disc.rotation.x = Math.PI / 2;
    disc.position.z = z;
    disc.castShadow = false;
    clockGroup.add(disc);
  }
  // 外圈刻度环（金属）
  const rimGeo = geo(new THREE.TorusGeometry(3.18, 0.075, 8, 56));
  const rim = new THREE.Mesh(rimGeo, gold);
  clockGroup.add(rim);

  /* ---- 三针（BoxGeometry 深色金属），绕 Z 轴旋转 ---- */
  const handGroup = new THREE.Group();
  handGroup.position.z = 0.40;
  clockGroup.add(handGroup);
  const mkHand = (len, w, d, material, yOffset) => {
    const pivot = new THREE.Group();
    handGroup.add(pivot);
    const m = new THREE.Mesh(box, material);
    m.scale.set(w, len, d);
    m.position.y = len / 2 - yOffset; // 以轴心为旋转中心，向 12 点方向延伸
    m.castShadow = false;
    pivot.add(m);
    return pivot;
  };
  const hourHand = mkHand(1.55, 0.19, 0.09, steelDark, 0.30);
  const minuteHand = mkHand(2.30, 0.13, 0.075, steelDark, 0.42);
  const secondHand = mkHand(2.62, 0.055, 0.055, gold, 0.55);
  // 秒针尾配重
  const tail = new THREE.Mesh(box, gold);
  tail.scale.set(0.09, 0.55, 0.055);
  tail.position.y = -0.28;
  secondHand.add(tail);
  // 中心轴盖
  const cap = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.16, 0.16, 0.14, 16)), gold);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = 0.46;
  clockGroup.add(cap);
  // 背面也放一套指针（双面钟），共用旋转逻辑
  const backHandGroup = new THREE.Group();
  backHandGroup.position.z = -0.40;
  backHandGroup.rotation.y = Math.PI;
  clockGroup.add(backHandGroup);
  const mkBackHand = (len, w, material, yOffset) => {
    const pivot = new THREE.Group();
    backHandGroup.add(pivot);
    const m = new THREE.Mesh(box, material);
    m.scale.set(w, len, 0.07);
    m.position.y = len / 2 - yOffset;
    pivot.add(m);
    return pivot;
  };
  const hourBack = mkBackHand(1.55, 0.19, steelDark, 0.30);
  const minuteBack = mkBackHand(2.30, 0.13, steelDark, 0.42);
  const secondBack = mkBackHand(2.62, 0.055, gold, 0.55);

  /* ---- 塔尖装饰：日月星辰金属球 + 收分尖顶 ---- */
  cylAt(root, steel, 0.55, 0.8, 1.1, 0, 13.6, 0);
  const finial = new THREE.Mesh(geo(new THREE.IcosahedronGeometry(0.52, 1)), gold);
  finial.position.set(0, 14.35, 0);
  finial.castShadow = true;
  root.add(finial);

  /* ---- 夜间灯光：钟面内侧 PointLight + 塔顶向下 SpotLight ---- */
  const faceLight = new THREE.PointLight(0xffe1a8, 0, 22, 2);
  faceLight.position.set(0, 10.2, 1.6);
  root.add(faceLight);

  const spot = new THREE.SpotLight(0xfff0cf, 0, 34, Math.PI / 4.6, 0.5, 1.4);
  spot.position.set(0, 14.0, 0);
  spot.castShadow = false; // 不额外创建阴影贴图，避免资源泄漏
  const spotTarget = new THREE.Object3D();
  spotTarget.position.set(0, 0, 2.4);
  root.add(spotTarget);
  spot.target = spotTarget;
  root.add(spot);

  let disposed = false;
  /** finial 材质上一次的昼夜状态（null=未初始化）——只在阈值穿越时换材质，
   *  修复原来每帧赋值 finial.material 导致阈值附近 shader 编译/切换抖动。 */
  let nightGold = null;

  /** 读取系统真实时间驱动三针；秒针含毫秒平滑扫秒（提示词允许「平滑旋转」） */
  const tick = (date = new Date()) => {
    if (disposed) return;
    const s = date.getSeconds() + date.getMilliseconds() / 1000;
    const m = date.getMinutes();
    const h = date.getHours() % 12;
    const hourA = -((h + m / 60) / 12) * TAU;
    const minA = -((m + s / 60) / 60) * TAU;
    const secA = -(s / 60) * TAU;
    // 【T05】正反两面共用同一角度：backHandGroup.rotation.y=π 已把背面指针组做了
    // 水平镜像，与「从 -Z 方向观察」的视向翻转互相抵消，读时与正面完全一致（顺时针）。
    // 切勿给背面取反（-angle）：那会让背面 3:00 指向 9 点，变成逆时针读时。
    for (const p of [hourHand, hourBack]) p.rotation.z = hourA;
    for (const p of [minuteHand, minuteBack]) p.rotation.z = minA;
    for (const p of [secondHand, secondBack]) p.rotation.z = secA;
  };

  /** 夜色浓度 0..1 → 钟面自发光 + 两盏灯平滑亮起（无突变） */
  const setNight = (f) => {
    if (disposed) return;
    const k = clamp(f, 0, 1);
    // 遮罩贴图只有刻度/数字是亮的，0.85 已足够醒目；再高会把字形糊成一团。
    // 灯光也相应压低，避免 Bloom 把整个钟盘吃成白球。
    // 【T05】正反两个表盘材质的发光强度必须同步，否则背面夜间不亮/错位。
    const faceEmissive = 0.05 + k * 0.8;
    faceMat.emissiveIntensity = faceEmissive;
    faceMatBack.emissiveIntensity = faceEmissive;
    faceLight.intensity = k * 1.1 * scale;
    spot.intensity = k * 1.3 * scale;
    // 【热点修复】阈值状态机：仅在 0.5 穿越（gold↔steel）那一帧换材质
    const wantGold = k > 0.5;
    if (wantGold !== nightGold) {
      nightGold = wantGold;
      finial.material = wantGold ? gold : steel;
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    nightGold = null;
    root.clear();
    for (const g of geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    for (const t of textures) { try { t.dispose(); } catch (e) { /* noop */ } }
    geometries.length = materials.length = textures.length = 0;
  };

  tick(new Date());
  return { root, tick, setNight, dispose, faceMat, faceMatBack };
}

/* -------------------------------------------------------------------------- */
/* 可进入设施                                                                  */
/* -------------------------------------------------------------------------- */
export class CenturyClock extends IAttraction {
  constructor() {
    super();
    this.root = null;
    this._disposed = false;
    this._ctx = null;
    this._tower = null;
    this._cameraSaved = null;
    this._bgSaved = null;
    this._fogSaved = null;
    this._ui = null;
    this._styleEl = null;
    this._onExit = null;
    this._timeT = 0;
    this._lastShownSecond = -1;
    this._nightF = 0;
    this._phase = 0;
  }

  init(ctx) {
    if (this._disposed) return;
    this._ctx = ctx;
    const { scene, camera } = ctx;

    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      up: camera.up.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    this._bgSaved = scene.background;
    this._fogSaved = scene.fog;

    this.root = new THREE.Group();
    this.root.name = 'CenturyClock';
    this.root.userData.attractionRoot = true;
    scene.add(this.root);

    this._tower = buildClockTower({
      scale: 1.25,
      track: {
        geo: (g) => { ctx.registerDisposable?.(g); return g; },
        mat: (m) => { ctx.registerDisposable?.(m); return m; },
        tex: (t) => { ctx.registerDisposable?.(t); return t; },
      },
    });
    this.root.add(this._tower.root);

    // 观景地面（让塔基有落脚感，不悬空）
    const groundGeo = new THREE.CylinderGeometry(26, 26, 0.2, 48);
    ctx.registerDisposable?.(groundGeo);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x6d7268, roughness: 0.95 });
    ctx.registerDisposable?.(groundMat);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.12;
    ground.receiveShadow = true;
    this.root.add(ground);
    this._groundGeo = groundGeo;
    this._groundMat = groundMat;

    // 相机：正对钟面、略仰视，缓慢左右摇移（幅度极小防眩晕）
    camera.position.set(0, 9.4, 25);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 12.4, 0);
    camera.fov = 58;
    camera.updateProjectionMatrix();

    this._buildUI();
    // 让昼夜系统在设施内继续生效（夜空/星空/月亮可见，钟面夜间发光）
    dayNightCycle.setContext('century-clock');
    this._nightF = dayNightCycle.mode === 'night' ? 1 : dayNightCycle.mode === 'sunset' ? 0.5 : 0;
    this._tower.setNight(this._nightF);
  }

  _buildUI() {
    const style = document.createElement('style');
    style.id = 'cc-ui-style';
    style.textContent = `
      .cc-ui{position:fixed;inset:0;z-index:50;pointer-events:none;
        font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#eef3ff}
      .cc-hdr{position:absolute;top:calc(16px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);
        padding:8px 20px;border-radius:999px;white-space:nowrap;font-size:15px;font-weight:700;letter-spacing:2px;
        background:rgba(9,18,38,.66);border:1px solid rgba(125,180,255,.32)}
      .cc-panel{position:absolute;bottom:calc(20px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);
        text-align:center;padding:12px 22px;border-radius:14px;pointer-events:auto;
        background:linear-gradient(160deg,rgba(20,30,54,.94),rgba(10,16,32,.96));
        border:1px solid rgba(130,175,255,.3);box-shadow:0 14px 44px rgba(0,0,0,.55)}
      .cc-time{font-size:32px;font-weight:800;letter-spacing:3px;color:#ffd24a;font-variant-numeric:tabular-nums}
      .cc-sub{font-size:11px;color:#9fb6dd;margin:4px 0 10px;letter-spacing:1px}
      .cc-btn{padding:8px 18px;border:0;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;
        pointer-events:auto;color:#0c1322;background:#8fd0ff}
      @media (max-width:640px){.cc-hdr{font-size:12px;padding:5px 12px}.cc-time{font-size:24px}}
    `;
    document.head.appendChild(style);
    this._styleEl = style;

    const ui = document.createElement('div');
    ui.className = 'cc-ui';
    ui.innerHTML = `
      <div class="cc-hdr">天津世纪钟 · 千禧纪念</div>
      <div class="cc-panel">
        <div class="cc-time" id="cc-time">--:--:--</div>
        <div class="cc-sub">指针与数字均读取本机真实时间 · 夜间钟面自发光</div>
        <button class="cc-btn" id="cc-exit">返回大厅</button>
      </div>`;
    document.body.appendChild(ui);
    this._ui = ui;
    this._onExit = () => this._ctx?.onExitAttraction?.();
    ui.querySelector('#cc-exit').addEventListener('click', this._onExit);
    this._updateClockText(new Date());
  }

  _updateClockText(d) {
    const el = this._ui?.querySelector('#cc-time');
    if (!el) return;
    const p = (n) => String(n).padStart(2, '0');
    el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  update(dt) {
    if (this._disposed || !this._tower) return;
    if (this._ctx?.isPaused?.()) return;
    const d = Math.min(Math.max(dt, 0), 0.1);
    this._timeT += d;
    this._phase += d;

    // 每帧驱动三针（平滑扫秒）；数字只在跨秒时刷新，省 DOM 写入。
    // 【热点修复】复用模块级共享 Date（setTime 原地更新），消灭 60/s new Date() 分配。
    _sharedClockDate.setTime(Date.now());
    const now = _sharedClockDate;
    this._tower.tick(now);
    if (now.getSeconds() !== this._lastShownSecond) {
      this._lastShownSecond = now.getSeconds();
      this._updateClockText(now);
    }
    // 夜色跟随昼夜模式平滑过渡
    const target = dayNightCycle.mode === 'night' ? 1 : dayNightCycle.mode === 'sunset' ? 0.5 : 0;
    this._nightF += (target - this._nightF) * (1 - Math.exp(-3 * d));
    this._tower.setNight(this._nightF);

    // 极缓摇移（防眩晕：位置幅度 <0.25，无 roll、无随机）
    const cam = this._ctx.camera;
    cam.position.x = Math.sin(this._phase * 0.12) * 0.22;
    cam.lookAt(0, 12.4, 0);
  }

  onInteract() { /* UI 全 DOM 驱动 */ }

  /** 预热：覆盖 tick / setNight（同步正背两面材质）/ 纹理上传路径，不改状态 */
  warmUp() {
    this._tower?.tick(new Date());
    this._tower?.setNight(1);
    this._tower?.setNight(0);
    return this;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this._ui) {
      const btn = this._ui.querySelector('#cc-exit');
      if (btn && this._onExit) btn.removeEventListener('click', this._onExit);
      this._ui.remove();
    }
    this._styleEl?.remove();
    this._ui = null; this._styleEl = null; this._onExit = null;

    const { scene, camera } = this._ctx || {};
    if (scene) {
      scene.background = this._bgSaved ?? null;
      scene.fog = this._fogSaved ?? null;
    }
    if (camera && this._cameraSaved) {
      camera.position.copy(this._cameraSaved.position);
      camera.quaternion.copy(this._cameraSaved.quaternion);
      camera.up.copy(this._cameraSaved.up);
      camera.rotation.order = this._cameraSaved.rotationOrder;
      camera.fov = this._cameraSaved.fov;
      camera.updateProjectionMatrix();
    }

    this._tower?.dispose();
    this._tower = null;
    try { this._groundGeo?.dispose(); } catch (e) { /* noop */ }
    try { this._groundMat?.dispose(); } catch (e) { /* noop */ }
    this._groundGeo = this._groundMat = null;
    this.root = null;
  }
}

export default CenturyClock;
