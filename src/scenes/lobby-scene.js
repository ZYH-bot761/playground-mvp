/**
 * ============================================================================
 * Lobby —— OrbitControls 自由探索「日光游乐场广场」
 * ============================================================================
 * 目标：把 M3/M4 的小游戏整合成一个可自由探索的 3D 大世界。开局以轨道相机
 *       俯瞰中央广场；拖拽旋转、滚轮缩放自由观察；每个设施入口有发光描边 +
 *       向下箭头 + 图集文字名称牌，hover 高亮；点击入口标识进入小游戏；
 *       结算后返回， orbit 机位与目标点不变。
 *
 * 【零侵入 core/】Lobby 作为 IAttraction 注册，只使用 ctx 注入的
 *   scene / camera / renderer / registerDisposable / onEnterAttraction /
 *   onExitAttraction，不 import、不修改 core/ 任何模块。
 *   相机姿态、背景/雾、外部灯光强度、renderer.shadowMap 都在 init() 里
 *   「保存原值 → 临时接管」，在 dispose() 里逐项恢复。
 *
 * 【销毁重建 + 状态存档】切换小游戏时 AttractionManager 会 deactivate() →
 *   dispose() 彻底销毁本类。模块级单例 _lobbyMemory 保存 orbit 相机位置与目标点，
 *   dispose() 写入、init() 读回；JS 模块只求值一次，故跨重建持续存活。
 *
 * 【全程禁用 Rapier】本类不创建任何刚体 / collider，也不调用 world.step()。
 *   探索由 OrbitControls 驱动（旋转 / 缩放），不做第一人称行走。
 *
 * 【阴影资源是本次重构的最大泄漏风险】
 *   DirectionalLight.castShadow = true 时，three 会为 light.shadow.map 分配
 *   WebGLRenderTarget（含 color texture + depthTexture），两者都会计入
 *   renderer.info.memory.textures。它由渲染器惰性创建、不归项目 Mesh 台账所有，
 *   若不在 dispose() 里显式 light.shadow.dispose()，每轮「大厅→小游戏→大厅」
 *   都会残留一张纹理 → 计数逐轮 +1 漂移。已在 dispose 步骤 0-c 处理。
 *
 * 【IAttraction 契约】init / update / onInteract / dispose 四方法齐全；
 *   dispose 幂等、七步清理、每步独立 try/catch；root 挂到 ctx.scene，
 *   从场景移除交给 AttractionManager 第 ③ 步，本类不自行 scene.remove。
 * ============================================================================
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DetailLOD } from '../utils/helpers/detail-lod.js';
import { createFacilityLabelAtlas, applyAtlasUV } from '../utils/helpers/facility-textures.js';
import { cameraRig } from '../core/camera-rig.js';
import { WASDController, WASD_EYE_HEIGHT, horizontalForward, MOVE_CODES } from '../utils/controls/wasd-controller.js';
import { movementMode } from '../components/controllers/movement-mode-manager.js';
import { IAttraction } from './attractions/i-attraction.js';
import { dayNightCycle, MODE_LABELS } from '../utils/helpers/day-night-cycle.js';
import { fireworkSystem, FIREWORK_COLORS } from '../utils/helpers/particle-system.js';
import { npcManager } from '../utils/helpers/npc-manager.js';
import { buildClockTower } from './attractions/century-clock.js';
import { CoasterCarRuntime } from '../utils/helpers/coaster-car-runtime.js';
import { buildZoo, ZOO_VIEW } from './zoo-scene.js';
import { buildDistricts, DISTRICT_VIEW, DISTRICT_GRID } from './districts.js';

/* ========================================================================== */
/* 模块级单例：跨「销毁重建」保存 orbit 相机位置与目标点                       */
/* ========================================================================== */

/** @type {{cam:{x:number,y:number,z:number}, tgt:{x:number,y:number,z:number}}} */
const _lobbyMemory = {
  cam: { x: 0, y: 30, z: 34 },  // 开局俯瞰机位：越过大门横梁，广场与七个入口尽收眼底
  tgt: { x: 0, y: 2, z: 0 },    // 轨道目标：广场中心
};

/* ========================================================================== */
/* 常量（参数锁定）                                                            */
/* ========================================================================== */

const ORBIT_MIN_DIST = 5;                 // 手册 P3§6 / P9 验收：minDistance=5
const ORBIT_MAX_DIST = 50;                // maxDistance=50
const ORBIT_MIN_POLAR = 0;                // minPolarAngle=0
const ORBIT_MAX_POLAR = Math.PI / 2.2;    // maxPolarAngle=π/2.2（不钻到地面下）
const ORBIT_DAMPING = 0.08;               // 阻尼系数
const DRAG_THRESHOLD = 6;        // pointerdown/up 位移 >6px 视为拖拽旋转
const CLICK_DEBOUNCE = 200;      // ms 防抖
const AABB_PAD = 1;              // 建筑 AABB 长宽各扩张 1 米
const SIT_PROMPT_RANGE = 8;      // 模块 8：长椅「坐下」提示的相机 3D 距离上限（3~5 核心区 + 俯瞰余量）
const SIT_EYE_H = 1.0;           // 坐姿眼高（站立 1.6 → 降低 0.6，落在提示词 0.5~0.8 区间）

/* ---------- T06：触发区尺寸单一真相源 ----------
 * 旧代码把 4.6 / 2.4 / 2.6 / 0.85 等数字散落在 _buildTriggers 与 update 里，
 * 触发点一挪就容易尺寸漂移。现在全部由 TRIGGER_RADIUS 派生：
 *   disc 直径 = TRIGGER_RADIUS*2 = 4.6m（与原视觉一致）
 *   自检下限 = 直径 + 1.9m 安全间隙 = 6.5m
 */
const TRIGGER_RADIUS = 2.3;
const TRIGGER_RING_RADIUS = TRIGGER_RADIUS + 0.1;   // 2.4，环略大于圆盘边缘
const TRIGGER_POST_OFFSET = TRIGGER_RADIUS * 1.13;  // 2.599，光柱落在盘外沿
const LABEL_WORLD_W_PER_CHAR = TRIGGER_RADIUS * 0.37; // 0.851m/字，5 字牌 4.255m
const GATE_LABEL = '游乐园';                         // 大门招牌文字（图集第 0 格）

/* ---------- T02：输入模式切换 ----------
 * orbit = OrbitControls 自由探索（默认）；wasd = 第一人称键盘漫游。
 * 切换用 CameraRig 做短过渡；相机位置在过渡中保持不变或平滑落地，绝不瞬移。
 */
const MODE_BLEND_ENTER = 0.5;    // orbit → wasd：从俯瞰平滑降到 1.6m 眼高
const MODE_BLEND_EXIT = 0.3;     // wasd → orbit：只平滑朝向，位置零跳变
const ORBIT_TARGET_DIST = 10;    // 切回 orbit 时 target 放在正前方 10m（满足 minDistance=5 / maxDistance=50）
const ORBIT_TARGET_DROP = 1.6;   // target 比相机低 1.6m → polar≈80.9° < maxPolarAngle≈81.8°，OrbitControls.update 不会夹动相机

/* ---------- T04b-c：真摩天轮几何契约（必须与 FerrisWheelEmbedView.js:48-54 一致） ----------
 * 座舱中心必须落在半径 5.4 的圆周、轮心 local y=8.2、轮盘 name='Lobby/wheel-spin'；
 * 否则 EmbedView 用 getWorldPosition + R*(cos(θ+a),sin(θ+a),0) 算出的锚点
 * 会落在座舱外，玩家"坐在空中"。改这三个数前先同步改 EmbedView。 */
const FERRIS_CABIN_COUNT = 10;
const FERRIS_WHEEL_RADIUS = 5.4;
const FERRIS_HUB_Y = 8.2;
/** 复用的部件矩阵（热路径零 new；单线程渲染循环，无重入） */
const _WHEEL_PART_MATRIX = new THREE.Matrix4();

/* ---------- T07：大厅设施常驻动效参数 ----------
 * 木马取真实 Carousel.js ROTATE_SPEED=0.55 的 0.64 倍（大厅是远景装饰，慢一点更稳）；
 * 海盗船与真实 PirateShip.js 同周期 3.0s，但幅度降到 0.72rad（≈41°）——
 * 真实设施的 1.0rad 会让大厅立面船体横向摆出 ±4m、越过 AABB 与相邻触发环，
 * 0.72rad 时横摆 ≈3.16m 仍落在 ±3.4 的立面 AABB 内。 */
const LOBBY_CAROUSEL_SPIN_SPEED = 0.35;
const LOBBY_PIRATE_MAX_AMP = 0.72;
const LOBBY_PIRATE_OMEGA = (Math.PI * 2) / 3.0;
const LOBBY_TRAIN_BASE_Z = -0.3;   // 车体中心在站台 local 坐标的 z
const LOBBY_TRAIN_TRAVEL = 1.35;   // 往返振幅（轨道 ±2.7，车体半长 1.25）
const LOBBY_TRAIN_OMEGA = 0.45;    // 约 14s 一个完整往返
const LOBBY_TRAIN_WHEEL_R = 0.3;   // 与 station-wheel 的 x/z scale 一致

/**
 * 九个可进入的设施。trigger 是设施入口处发光圆环 / 箭头 / 名称牌的中心（点击即进入）。
 *
 * 【T06 触发环分散】设施本体 x/z 一律不动；只把 trigger 拉开到两两 ≥7.0m：
 *   - 原 parkour(13,2) ↔ carousel(9,2)、pumpkin(-13,2) ↔ pirate(-9,2) 仅相距 4m，
 *     小于 4.6m 盘径 → 必然交叠；5 字名称牌 4.25m 宽也会擦碰。
 *   - 新坐标全部排在 z=1 的横轴上（跳一跳/小火车/烟花台再向两侧纵向延伸），
 *     与大厅地面引导线共线，玩家一眼就能看清"这是九个独立入口"。
 *   - 距喷泉 (0,6) 最近 6.40m > 4.6m；距大门 (0,15) 最近 14.6m。
 */
/**
 * 【M2：坐标单一真相源】
 * 旧实现把 trigger 当成与本体无关的自由坐标手写（T06 为拉开环间距，把圈从
 * 建筑门口挪开 5–7m，甚至斜向偏移），导致「触发圈没对齐大门」。现在：
 *   door      = 本体中心 + doorDir × doorDepth   （大门）
 *   trigger   = door + doorDir × TRIGGER_FRONT_GAP （圈在门正前方）
 * 两者全部由本体坐标派生，**禁止再手写 trigger**；间距靠重排本体解决。
 *
 * 布局逻辑（中轴 + 左右两翼 + 后排，不再随机堆放）：
 *   中轴：大门 (0,15) → 世纪钟 (0,-4) → 魔法牌屋 (0,-20)
 *   左翼：小火车 (-26,-2) / 海盗船 (-7,9) / 南瓜摩天轮 (-20,-12)
 *   右翼：跳跳乐 (26,-2) / 旋转木马 (9,5) / 跑酷 (13,-16) / 烟花台 (22,20)
 * 南瓜摩天轮与海盗船本体净距由原 12.6m 拉到 24.7m，彻底解决拥挤。
 */
const TRIGGER_FRONT_GAP = 3.0;

const FACILITY_SPECS = Object.freeze([
  {
    key: 'pumpkin-thrower', name: '南瓜投手', label: '南瓜摩天轮',
    x: -20, z: -16, doorDir: { dx: 0, dz: 1 }, doorDepth: 5,
  },
  {
    // x=13 是唯一同时避开魔法牌屋（左界 >6.4）与跳跳乐长廊门柱（右界 <19.6）的位置
    key: 'parkour-run', name: '极限跑酷', label: '跑酷跑道',
    x: 13, z: -16, doorDir: { dx: 0, dz: 1 }, doorDepth: 5,
  },
  {
    key: 'memory-match', name: '记忆翻牌', label: '魔法牌屋',
    x: 0, z: -20, doorDir: { dx: 0, dz: 1 }, doorDepth: 4,
  },
  {
    key: 'jump-jump', name: '跳一跳', label: '跳跳乐',
    x: 26, z: -2, doorDir: { dx: 0, dz: 1 }, doorDepth: 5,
  },
  {
    key: 'train-ride', name: '高空环游', label: '小火车站台',
    x: -26, z: -2, doorDir: { dx: 0, dz: 1 }, doorDepth: 5,
  },
  {
    key: 'carousel', name: '旋转木马', label: '旋转木马',
    x: 9, z: 7.5, doorDir: { dx: 0, dz: -1 }, doorDepth: 4,
  },
  {
    key: 'pirate-ship', name: '海盗船', label: '海盗船',
    x: -7, z: 5, doorDir: { dx: 0, dz: -1 }, doorDepth: 4,
  },
  {
    key: 'fireworks-deck', name: '烟花观礼台', label: '烟花观礼台',
    x: 22, z: 20, doorDir: { dx: 0, dz: -1 }, doorDepth: 3,
  },
  {
    key: 'century-clock', name: '世纪钟', label: '世纪钟',
    x: 0, z: -4, doorDir: { dx: 0, dz: 1 }, doorDepth: 3,
  },
]);

/** 由本体 + 大门朝向派生触发圈坐标（门正前方 TRIGGER_FRONT_GAP 米） */
function triggerOf(f) {
  const d = f.doorDepth + TRIGGER_FRONT_GAP;
  return Object.freeze({
    x: +(f.x + f.doorDir.dx * d).toFixed(3),
    z: +(f.z + f.doorDir.dz * d).toFixed(3),
  });
}

const FACILITIES = Object.freeze(FACILITY_SPECS.map((f) => Object.freeze({
  ...f,
  trigger: triggerOf(f),
})));

/**
 * 【大厅实体化】过山车高架轨道：直接复用 TrainRide.js 的 24 点 lemniscate
 * 高度表（6m 谷底 → 40m 顶点、两处陡坡 + 中央上下交叉），水平半轴按广场尺度
 * 缩到 20/14（玩法里是 80/52），整体放在左侧站台 (-26,-2) 的后方，
 * 保证一进大门就能在左前方看到陡坡与急转，而不是只有一个小站台。
 */
const COASTER = Object.freeze({
  // 低段 (θ=0/180) 落在 x≈-14 → 屏幕 x≈425，避开左上调试面板；
  // 峰顶 (θ=90) 落在 x≈3、正对大门，抬头即见 40m 高点。
  // 与摩天轮 (-13,-6) 前后错开 ≥13m，不与站台/牌屋抢同一块视野。
  cx: -14, cz: -26,
  lobeA: 17, lobeB: 14,
  heights: Object.freeze([
    6, 10, 16, 25, 33, 39, 40, 33, 22, 10, 5, 16,
    26, 24, 18, 14, 24, 34, 31, 22, 14, 8, 6, 6,
  ]),
});

/* ========================================================================== */
/* 程序化纹理 / 字体点阵工具（全部零外部资源）                                 */
/* ========================================================================== */

/** 确定性伪随机：同一次构建、每次重建都得到完全相同的纹理，截图可复现 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 草坪 albedo：1024×1024 可无缝平铺。
 * 叠法：深草绿底 → 大色斑（修剪过的草坪色差）→ 26 条修剪条纹 → 6000 根草丝
 * → 整体轻微噪点。无缝：所有元素按 ±size 各画一次（九宫格），接缝连续。
 */
function makeGrassTexture() {
  const size = 1024;
  const rnd = makeRng(20261108);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');

  // 整体 albedo 压暗约 15%（#4f8a34 → #43752c），并把色斑/条纹/草丝的
  // 明暗差拉大，抵消远处 mipmap 把颜色平均成灰绿、再被雾+Bloom 抬亮的问题。
  g.fillStyle = '#43752c';
  g.fillRect(0, 0, size, size);

  const blob = (x, y, r, color, alpha) => {
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const cx = x + ox * size;
        const cy = y + oy * size;
        if (cx < -r || cx > size + r || cy < -r || cy > size + r) continue;
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = alpha;
        g.fillStyle = grad;
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  };

  for (let i = 0; i < 24; i += 1) blob(rnd() * size, rnd() * size, 90 + rnd() * 130, '#325922', 0.38);
  for (let i = 0; i < 20; i += 1) blob(rnd() * size, rnd() * size, 70 + rnd() * 110, '#629b36', 0.32);

  // 修剪条纹：让重复平铺读作「有意设计的草坪」，不像贴图翻转
  const stripes = 26;
  for (let i = 0; i < stripes; i += 1) {
    g.globalAlpha = 0.075; // 条纹对比提高，远处 mipmap 后仍能读出草坪纹理
    g.fillStyle = i % 2 === 0 ? '#ffffff' : '#000000';
    g.fillRect(0, (i * size) / stripes, size, size / stripes);
  }
  g.globalAlpha = 1;

  // 草丝：短线 + 明度/色相抖动，是「像草地」而不是「像噪点」的关键
  g.lineWidth = 1.6;
  for (let i = 0; i < 6000; i += 1) {
    const x = rnd() * size;
    const y = rnd() * size;
    const len = 3 + rnd() * 4;
    const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.2;
    const hue = 92 + rnd() * 24;
    const light = 20 + rnd() * 24; // 草丝明度跨度拉大（原来 26~42 太平均）
    g.strokeStyle = `hsla(${hue}, 68%, ${light}%, ${0.45 + rnd() * 0.35})`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'lb/grass-albedo';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(26, 26);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 掠射角各向异性过滤拉到设备上限：20~40m 处 mipmap 不再把草色平均成灰绿
  tex.anisotropy = 8; // 建纹理时的保守值，init 时会被 renderer 上限覆盖
  tex.needsUpdate = true;
  return tex;
}

/** 草坪 roughnessMap：512×512 灰度（0.55~0.95），让高光碎片化而不是塑料一片 */
function makeGrassRoughness() {
  const size = 512;
  const rnd = makeRng(77);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = 0.74 + 0.16 * Math.sin(x * 0.09) * Math.cos(y * 0.07) + (rnd() - 0.5) * 0.12;
      const c = Math.max(0, Math.min(255, Math.round(v * 255)));
      const i = (y * size + x) * 4;
      img.data[i] = c;
      img.data[i + 1] = c;
      img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'lb/grass-roughness';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(13, 13);
  tex.needsUpdate = true;
  return tex;
}

/**
 * 程序化法线贴图通用流程：先生成灰度高度场，再用中心差分求切线空间法线。
 * 数据纹理保持 NoColorSpace（默认），不能设 SRGB —— 否则法线向量被伽马扭曲。
 */
function heightFieldToNormalCanvas(height, size, strength) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const img = g.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** 草坪法线：低频起伏 + 逐像素草丝颗粒凹凸（手册 P5：地面法线贴图增加凹凸感） */
function makeGrassNormal() {
  const size = 512;
  const rnd = makeRng(4242);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      height[y * size + x] =
        0.35 * Math.sin(x * 0.045) * Math.cos(y * 0.038) + (rnd() - 0.5) * 0.55;
    }
  }
  const tex = new THREE.CanvasTexture(heightFieldToNormalCanvas(height, size, 1.6));
  tex.name = 'lb/grass-normal';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(26, 26);
  tex.needsUpdate = true;
  return tex;
}

/** 建筑金属板缝法线：横向板缝 + 细噪点，用于门楼横梁/立柱等烤漆金属件 */
function makePanelNormal() {
  const size = 256;
  const rnd = makeRng(777);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    // 每 64px 一条板缝：缝内凹陷（正弦谷），缝两侧轻微凸边
    const seam = Math.cos((y % 64) / 64 * Math.PI * 2);
    for (let x = 0; x < size; x += 1) {
      height[y * size + x] = seam * 0.4 + (rnd() - 0.5) * 0.12;
    }
  }
  const tex = new THREE.CanvasTexture(heightFieldToNormalCanvas(height, size, 2.0));
  tex.name = 'lb/panel-normal';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.needsUpdate = true;
  return tex;
}

/**
 * 云朵 Sprite 贴图：256×128 RGBA，白色团簇 + 边缘虚化。
 * 顶部实、底部虚；底部再纵向削薄，模拟云底透光，避免贴片感。
 */
function makeCloudTexture(seed) {
  const w = 256;
  const h = 128;
  const rnd = makeRng(seed);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');

  const puff = (x, y, r, alpha) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(0.55, `rgba(250,252,255,${alpha * 0.86})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };

  for (let i = 0; i < 13; i += 1) {
    puff(40 + rnd() * (w - 80), 62 + (rnd() - 0.5) * 26, 22 + rnd() * 26, 0.55 + rnd() * 0.3);
  }
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 22; i += 1) {
    puff(50 + rnd() * (w - 100), 56 + (rnd() - 0.5) * 22, 10 + rnd() * 14, 0.3);
  }
  g.globalCompositeOperation = 'source-over';

  const fade = g.createLinearGradient(0, h * 0.55, 0, h);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = fade;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `lb/cloud-${seed}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 移动端降级：2048×512 环形云带（一张贴图环绕 360°），3 条圆柱 → 3 draw call */
function makeCloudBandTexture() {
  const w = 2048;
  const h = 512;
  const rnd = makeRng(991);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const puff = (x, y, r, alpha) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  for (let i = 0; i < 26; i += 1) {
    const x = rnd() * w;
    const y = 150 + rnd() * 240;
    const r = 60 + rnd() * 110;
    puff(x, y, r, 0.5 + rnd() * 0.3);
    puff(x - w, y, r, 0.5 + rnd() * 0.3);
    puff(x + w, y, r, 0.5 + rnd() * 0.3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'lb/cloud-band';
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 接触阴影贴片：128×128 径向渐变（中心黑 alpha 0.5 → 边缘 0） */
function makeContactShadowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'lb/contact-shadow';
  tex.needsUpdate = true;
  return tex;
}

/** 假光柱：64×256 竖向渐变（两端透明、中段白），左右再羽化 → additive 叠加 */
function makeShaftTexture() {
  const w = 64;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const v = g.createLinearGradient(0, 0, 0, h);
  v.addColorStop(0, 'rgba(255,248,220,0)');
  // 【可见性关键】峰值放在 0.78（光柱下段、靠近草地），底部仍留 0.35 alpha：
  // 原来峰值在 0.4~0.55、两端归零，最亮处投影在亮天空上，additive 完全看不出，
  // 而落到暗草地的那一端恰好全透明。现在光柱「从天空洒落到草地」且下半段最亮。
  v.addColorStop(0.35, 'rgba(255,248,220,0.25)');
  v.addColorStop(0.78, 'rgba(255,246,214,1.0)');
  v.addColorStop(1, 'rgba(255,240,200,0.35)');
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
  const hz = g.createLinearGradient(0, 0, w, 0);
  hz.addColorStop(0, 'rgba(0,0,0,1)');
  hz.addColorStop(0.5, 'rgba(0,0,0,0)');
  hz.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = hz;
  g.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'lb/light-shaft';
  tex.needsUpdate = true;
  return tex;
}

/* 【T06 已移除】makeTextPixels()：260×88 canvas + 5px 采样点阵 → InstancedMesh
 * 小方块 → 高饱和漆面 + Bloom，5 字标签只剩 ~52 个采样列，1080p 下糊成橙色
 * 马赛克团。现改用 FacilityTextures.js 的 2048² 单图集 + 共享 MeshBasicMaterial，
 * 文字为连续纹理采样，只 +1 张纹理、+1 个材质，零点阵方块。 */

/* ========================================================================== */
/* 纹理引用扫描（沿用 M2 修复后的契约：路径数组绝不去重，逐条断开引用）       */
/* ========================================================================== */

/** 递归扫描任意值里的 THREE.Texture，输出【不去重】的可断开引用路径 */
function scanTextureValue(value, path, out, seen, depth, replacer) {
  if (value == null || depth > 4) return;
  if (typeof value === 'object' && value.isTexture === true) {
    out.push({ texture: value, path, clear: () => replacer(null) });
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanTextureValue(value[i], `${path}[${i}]`, out, seen, depth + 1, (nv) => { value[i] = nv; });
    }
    return;
  }
  for (const key of Object.keys(value)) {
    scanTextureValue(value[key], `${path}.${key}`, out, seen, depth + 1, (nv) => { value[key] = nv; });
  }
}

/** 收集材质里所有纹理引用路径（标准槽位 + ShaderMaterial.uniforms 递归） */
function collectMaterialTextureReferences(material, index) {
  const out = [];
  if (!material) return out;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture === true) {
      out.push({ texture: value, path: `materials[${index}].${key}`, clear: () => { material[key] = null; } });
    }
  }
  const uniforms = material.uniforms;
  if (!uniforms || typeof uniforms !== 'object') return out;
  const seen = new WeakSet();
  for (const name of Object.keys(uniforms)) {
    const uniform = uniforms[name];
    if (!uniform || typeof uniform !== 'object') continue;
    const value = 'value' in uniform ? uniform.value : uniform;
    scanTextureValue(value, `materials[${index}].uniforms.${name}.value`, out, seen, 0,
      (nv) => { uniform.value = nv; });
  }
  return out;
}

/* ========================================================================== */
/* 天空与地形参数                                                              */
/* ========================================================================== */

/** 微地形：平地半径（设施基座/触发区在此范围内强制归零，避免顶穿底座） */
const TERRAIN_FLAT_RADIUS = 18;
/** 微地形：主起伏幅度（活动区，坡度 < 2%，不影响走位手感） */
const TERRAIN_AMP_IN = 0.10;
/** 微地形：远处草地起伏幅度 */
const TERRAIN_AMP_OUT = 0.9;

/** 白天天空（Sky.js）参数：晴朗、太阳偏左后上方 */
const SKY_TURBIDITY = 2.1;
const SKY_RAYLEIGH = 1.4;
const SKY_MIE_COEFFICIENT = 0.0025;
const SKY_MIE_DIRECTIONAL_G = 0.75;
const SKY_SUN_ELEVATION = 46;
const SKY_SUN_AZIMUTH = 40;

/* ========================================================================== */
/* DOM Overlay（全层 pointer-events:none，绝不遮挡画布拖拽 / 点击）           */
/* ========================================================================== */

const UI_CSS = `
/* 【六项升级·阶段五】统一半透明毛玻璃 UI，去除高对比实色边框 */
.lb-ui{position:fixed;inset:0;z-index:20;pointer-events:none;overflow:hidden;
  font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:var(--pg-glass-text,#eef6ff);
  --glass:var(--pg-glass-bg,rgba(18,28,44,.42));
  --edge:var(--pg-glass-edge,rgba(255,255,255,.14));
  --blur:var(--pg-glass-blur,blur(18px) saturate(150%));
  --shadow:var(--pg-glass-shadow,0 12px 40px rgba(4,10,24,.28),inset 0 1px 0 rgba(255,255,255,.12))}
.lb-vignette{position:absolute;inset:0;
  background:radial-gradient(ellipse at 50% 46%,rgba(0,0,0,0) 38%,rgba(2,4,12,.42) 100%)}
.lb-title{position:absolute;top:calc(16px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
  padding:9px 22px;border-radius:999px;white-space:nowrap;
  background:var(--glass);border:1px solid var(--edge);box-shadow:var(--shadow);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  font-size:16px;font-weight:700;letter-spacing:2px;
  text-shadow:0 1px 8px rgba(0,0,0,.35)}
.lb-controls{position:absolute;top:calc(56px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
  padding:6px 16px;border-radius:999px;white-space:nowrap;font-size:12px;
  background:var(--glass);border:1px solid var(--edge);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  color:var(--pg-glass-muted,rgba(198,216,238,.72));letter-spacing:.5px}
.lb-toast[data-hidden='true']{display:none}
.lb-toast{position:absolute;top:62%;left:50%;transform:translateX(-50%);
  padding:10px 22px;border-radius:14px;font-size:14px;white-space:nowrap;max-width:92vw;
  background:var(--pg-glass-bg-strong,rgba(14,24,40,.55));border:1px solid var(--edge);
  box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.lb-compass{position:absolute;bottom:calc(18px + env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);
  font-size:11px;color:var(--pg-glass-muted,rgba(198,216,238,.72));letter-spacing:1px;white-space:nowrap;
  background:var(--glass);border:1px solid var(--edge);padding:5px 14px;border-radius:999px;
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
/* ---- T02 输入模式切换（左上角；M 键等价） ---- */
.lb-mode{position:absolute;top:calc(16px + env(safe-area-inset-top, 0px));
  left:calc(16px + env(safe-area-inset-left, 0px));pointer-events:auto}
.lb-mode-btn{padding:9px 15px;border-radius:999px;cursor:pointer;pointer-events:auto;
  font-size:12px;font-weight:700;letter-spacing:.5px;white-space:nowrap;color:var(--pg-glass-text,#eef6ff);
  background:var(--glass);border:1px solid var(--edge);box-shadow:var(--shadow);
  backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  text-shadow:0 1px 6px rgba(0,0,0,.3);transition:transform .12s,background .2s}
.lb-mode-btn:hover{transform:translateY(-1px);background:rgba(255,255,255,.2)}
.lb-mode-btn[data-mode='wasd']{color:#10243a;background:rgba(176,220,255,.82);border-color:rgba(255,255,255,.3);text-shadow:none}
/* ---- 动物园一键直达（右上角；与左上输入模式 / 右下时间台互不遮挡） ---- */
.lb-zoo{position:absolute;top:calc(16px + env(safe-area-inset-top, 0px));
  right:calc(16px + env(safe-area-inset-right, 0px));pointer-events:auto}
.lb-zoo-btn{padding:9px 16px;border-radius:999px;cursor:pointer;pointer-events:auto;
  font-size:12px;font-weight:700;letter-spacing:.5px;white-space:nowrap;color:#06212f;
  background:linear-gradient(135deg,rgba(143,227,168,.9),rgba(143,208,255,.9));border:1px solid rgba(255,255,255,.34);
  box-shadow:var(--shadow);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
  transition:transform .12s,filter .2s}
.lb-zoo-btn:hover{transform:translateY(-1px);filter:brightness(1.08)}
.lb-zoo-btn[data-at='zoo']{background:linear-gradient(135deg,#ffd98f,#ffb3a7)}
/* ---- 模块 7 时间控制台（右下角；父层 pointer-events:none，子层显式 auto） ---- */
.lb-time{position:absolute;right:calc(16px + env(safe-area-inset-right,0px));
  bottom:calc(16px + env(safe-area-inset-bottom,0px));pointer-events:auto;
  display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.lb-time-toggle{padding:9px 15px;border-radius:999px;cursor:pointer;pointer-events:auto;
  font-size:13px;font-weight:700;letter-spacing:1px;color:#eaf3ff;
  background:rgba(9,18,38,.72);border:1px solid rgba(125,180,255,.38);
  text-shadow:0 0 10px rgba(90,160,255,.6);transition:transform .12s}
.lb-time-toggle:hover{transform:translateY(-1px)}
.lb-time-box{width:230px;padding:12px 13px;border-radius:14px;pointer-events:auto;
  background:linear-gradient(160deg,rgba(20,30,54,.95),rgba(10,16,32,.97));
  border:1px solid rgba(130,175,255,.3);box-shadow:0 14px 44px rgba(0,0,0,.55)}
.lb-time-box[data-open='false']{display:none}
.lb-time-title{font-size:12px;color:#9fb6dd;letter-spacing:1px;margin-bottom:9px;
  display:flex;justify-content:space-between;align-items:center}
.lb-time-title b{color:#ffd24a;font-size:12px}
.lb-time-modes{display:flex;gap:6px;margin-bottom:10px}
.lb-time-modes button{flex:1;padding:8px 0;border-radius:9px;cursor:pointer;pointer-events:auto;
  font-size:12px;font-weight:700;color:#cdd9f2;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16)}
.lb-time-modes button[data-on='1']{color:#0c1322;background:#ffd24a;border-color:#ffd24a}
.lb-time-auto{display:flex;align-items:center;justify-content:space-between;
  font-size:12px;color:#b9cbe8;margin-bottom:9px}
.lb-time-auto button{padding:5px 12px;border-radius:8px;cursor:pointer;pointer-events:auto;
  font-size:11px;font-weight:700;color:#eaf1ff;background:rgba(255,255,255,.12);
  border:1px solid rgba(255,255,255,.16)}
.lb-time-auto button[data-on='1']{background:#4ade80;color:#06210f;border-color:#4ade80}
.lb-time-fire{width:100%;padding:8px 0;border-radius:9px;cursor:pointer;pointer-events:auto;
  font-size:12px;font-weight:700;color:#0c1322;background:#8fd0ff;border:0}
.lb-time-tip{font-size:10px;color:#7f9dc8;margin-top:8px;line-height:1.4}
/* ---- 模块 8 长椅坐下休息 ---- */
.lb-sit-hint{position:absolute;bottom:calc(84px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);
  padding:9px 18px;border-radius:999px;font-size:13px;font-weight:700;white-space:nowrap;
  background:rgba(9,18,38,.78);border:1px solid rgba(125,180,255,.4);
  text-shadow:0 0 12px rgba(90,160,255,.6);pointer-events:none}
.lb-sit-hint[data-hidden='true']{display:none}
.lb-sit-bar{position:absolute;left:50%;bottom:calc(88px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);
  display:flex;align-items:center;gap:14px;padding:10px 16px;border-radius:14px;white-space:nowrap;
  pointer-events:auto;background:rgba(9,18,38,.86);border:1px solid rgba(125,180,255,.36);
  box-shadow:0 12px 38px rgba(0,0,0,.5)}
.lb-sit-bar[data-hidden='true']{display:none}
.lb-sit-bar span{font-size:14px;font-weight:700;letter-spacing:1px;color:#ffd24a}
.lb-sit-bar button{padding:7px 16px;border:0;border-radius:9px;cursor:pointer;pointer-events:auto;
  font-size:13px;font-weight:700;color:#0c1322;background:#8fd0ff}
.lb-sit-vignette{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .5s;
  background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 42%,rgba(2,4,12,.62) 100%)}
.lb-sit-vignette[data-on='1']{opacity:1}
@media (max-width:900px), (max-height:520px){
  .lb-title{font-size:13px;padding:6px 12px;top:calc(8px + env(safe-area-inset-top, 0px));letter-spacing:1px}
  .lb-controls{font-size:10px;padding:4px 10px;max-width:94vw;white-space:normal;text-align:center;
    top:calc(40px + env(safe-area-inset-top, 0px))}
  .lb-compass{display:none} /* 装饰性文字，避免与刘海区重叠 */
  .lb-mode{top:calc(8px + env(safe-area-inset-top, 0px));left:calc(8px + env(safe-area-inset-left, 0px))}
  .lb-mode-btn{font-size:10px;padding:6px 10px}
  .lb-toast{font-size:13px;white-space:normal;text-align:center}
}
`;

/* ========================================================================== */
/* Lobby                                                                       */
/* ========================================================================== */

export class Lobby extends IAttraction {
  constructor() {
    super();

    this.root = new THREE.Group();
    this.root.name = 'Lobby';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false;

    // ---- OrbitControls 自由探索（init 时由 _lobbyMemory 恢复机位/目标） ----
    this._controls = null;
    this._time = 0;
    this._hoverKey = null;
    this._entranceSigns = new Map();   // key → { meshes:[{mesh,mat}], label? }
    this._entranceArrows = [];
    this._billboardLabels = [];        // T06：{mesh,x,z} 名称牌每帧绕 Y 轴正对相机

    // ---- T02 输入模式：orbit（默认） / wasd ----
    this._inputMode = 'orbit';
    this._wasd = null;                 // WASDController 实例（init 创建，dispose 回收）
    this._wasdBlendActive = false;     // CameraRig 姿态过渡中：屏蔽移动与 OrbitControls
    this._wasdBlendKind = null;        // 'wasd' | 'orbit'
    this._pendingOrbitTarget = null;   // 切回 orbit 的目标点（过渡结束后写回 controls.target）
    this._rigOwner = null;             // 本类持有的 CameraRig owner key
    /** 【M1】orbit 模式下按住的移动键；由 _onWalkKey* 维护，dispose 清空 */
    this._orbitKeys = new Set();

    // ---- 输入（点击 vs 拖拽旋转判别） ----
    this._dragging = false;
    this._pointerDown = null;
    this._lastPointer = null;
    this._lastClickAt = -Infinity;
    this._lastEnterAt = -Infinity;
    // 竖屏时放宽 fov，让大厅设施在窄画幅里仍有足够的可视范围
    this._lastAspect = 0;

    // ---- 场景状态接管（保存原值，dispose 逐项恢复） ----
    this._cameraSaved = null;
    this._sceneSaved = null;
    this._externalLights = [];
    this._shadowSaved = null;
    this._ambientLight = null;
    this._dirLight = null;

    // ---- Three 台账 ----
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._shared = {};
    this._instancedMeshes = [];
    this._pickables = [];
    this._buildingBoxes = [];
    this._standaloneColliders = []; // 全程禁用 Rapier，恒为空；保留以完整履行契约
    this._districts = null;            // 【M7】四宫格骨架 + 区域级 LOD

    // ---- 动画对象（init 一次性创建，update 只改属性，绝不惰性新建资源） ----
    this._wheelGroup = null;
    // T04b-c：10 个真摩天轮座舱（变换宿主）+ 复用 S 共享几何/材质的实例化部件
    this._wheelCabins = [];
    this._wheelCabinParts = [];
    // T07：大厅常驻动效宿主（零 GPU 资源，只改 rotation / position）
    this._carouselFacadeSpin = null;
    this._pirateFacadePivot = null;
    this._stationTrain = null;
    this._stationTrainWheels = [];
    this._coasterCurve = null;  // T08：与实际过山车轨道共享同一条曲线
    this._coasterCars = null;   // T08：挂轨小车运行时（自建资源，dispose 配对释放）
    this._coinMeshes = [];
    this._memoryCards = [];
    this._bounceBall = null;
    this._bounceHalo = null;
    this._particleClouds = [];
    this._triggerRings = [];
    this._fountainWater = null;
    this._lods = {};
    this._lodCenters = {};
    this._sky = null;
    this._clouds = null;
    this._cloudLayers = [];
    this._cloudSprites = null;
    this._contactShadows = null;
    this._treePositions = [];

    // ---- 模块 8：世纪钟大厅地标 ----
    this._clockTower = null;
    this._clockTickT = 0;
    this._clockNightF = 0;

    // ---- 模块 8：长椅坐下休息 ----
    this._benchSpots = [];          // {x,z,yaw}
    this._benchPickables = [];      // 长椅点击代理（Raycaster）
    this._sitState = 'none';        // none | entering | seated | leaving
    this._sitT = 0;                 // 过渡进度 0..1
    this._sitSaved = null;          // 相机 / controls 快照
    this._sitBench = null;
    this._sitYaw = 0;
    this._sitPitch = 0;
    this._sitPhase = 0;
    this._sitQuatA = new THREE.Quaternion();
    this._sitQuatB = new THREE.Quaternion();
    this._sitPosA = new THREE.Vector3();
    this._sitPosB = new THREE.Vector3();

    // ---- 定时器 / DOM / 事件 ----
    this._rafIds = new Set();
    this._intervalIds = new Set();
    this._timeoutIds = new Set();
    this._uiRoot = null;
    this._uiStyle = null;
    this._listeners = [];
    this._ui = {};
    this._toastTimeoutId = null;

    // ---- 射线 ----
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    // ---- 稳定回调（引用固定，可成对解绑） ----
    this._onBlur = () => {
      this._dragging = false;
      this._pointerDown = null;
      this._lastPointer = null;
      // T02：失焦时清空 WASD 按键，避免"切走窗口回来还在走"
      this._wasd?.clearInput();
    };
    this._onPointerDown = (event) => {
      this._dragging = true;
      this._pointerDown = { x: event.clientX, y: event.clientY };
      this._lastPointer = { x: event.clientX, y: event.clientY };
    };
    // 旋转由 OrbitControls 自有监听驱动；这里只做入口标识 hover 高亮。
    // 【模块 8】坐下时 OrbitControls 已禁用，改由这段拖拽驱动自由环顾。
    this._onPointerMove = (event) => {
      if (this._sitState === 'seated' && this._dragging && this._lastPointer) {
        const dx = event.clientX - this._lastPointer.x;
        const dy = event.clientY - this._lastPointer.y;
        this._sitYaw -= dx * 0.0032;
        this._sitPitch = Math.max(-0.62, Math.min(0.62, this._sitPitch - dy * 0.0026));
      }
      this._lastPointer = { x: event.clientX, y: event.clientY };
      if (this._sitState === 'none') this._updateHover(event);
    };
    this._onPointerUp = (event) => {
      this._dragging = false;
      const start = this._pointerDown;
      this._pointerDown = null;
      this._lastPointer = null;
      if (!start) return;
      // ① 位移判定：拖拽旋转视角不算点击
      const dist = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (dist > DRAG_THRESHOLD) return;
      // ② 200ms 防抖
      const now = performance.now();
      if (now - this._lastClickAt < CLICK_DEBOUNCE) return;
      this._lastClickAt = now;
      this._handleClick(event);
    };
    this._onPointerCancel = () => {
      this._dragging = false;
      this._pointerDown = null;
      this._lastPointer = null;
    };
    // 绑定一次固定引用，保证 _addListener / removeEventListener 成对解绑
    this._onSitKey = this._onSitKey.bind(this);
    this._onModeKey = this._onModeKey.bind(this);
  }

  /* ------------------------------------------------------------------------ */
  /* init                                                                     */
  /* ------------------------------------------------------------------------ */

  /** @param {Object} ctx IAttraction 上下文（含 onEnterAttraction 回调） */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene } = ctx;
    const register = typeof ctx.registerDisposable === 'function' ? ctx.registerDisposable : () => {};

    /* ---------- ① 状态存档恢复：退出小游戏后 orbit 机位与目标点保持不变 ---------- */
    this._time = 0;
    console.info(
      `[Lobby] OrbitControls 恢复存档 cam=(${_lobbyMemory.cam.x.toFixed(2)}, ${_lobbyMemory.cam.y.toFixed(2)}, ${_lobbyMemory.cam.z.toFixed(2)}) ` +
      `tgt=(${_lobbyMemory.tgt.x.toFixed(2)}, ${_lobbyMemory.tgt.y.toFixed(2)}, ${_lobbyMemory.tgt.z.toFixed(2)})`
    );

    /* ---------- ② 接管场景外观 / 光影 / 阴影渲染器状态 ---------- */
    this._takeOverScene(ctx);

    // 【M3 教训】必须挂根节点，否则项目不渲染 → 计数恒等于基线的「假通过」
    scene.add(this.root);
    // 【M2】把派生的布局表挂到根节点，供验收脚本与后续四宫格模块读取（纯数据，无资源）
    this.root.userData.layout = FACILITIES.map((f) => ({
      key: f.key, x: f.x, z: f.z,
      trigger: { x: f.trigger.x, z: f.trigger.z },
      doorDir: { dx: f.doorDir.dx, dz: f.doorDir.dz },
      doorDepth: f.doorDepth,
    }));
    /* 【M5】建筑逻辑归组：与 M2 的「中轴 + 两翼 + 后排」布局一一对应，
     * 9 个设施各属其一、无重复；供四宫格扩建（M7）与验收读取。 */
    this.root.userData.districts = Object.freeze({
      central: ['century-clock', 'memory-match'],
      westWing: ['train-ride', 'pirate-ship', 'pumpkin-thrower'],
      eastWing: ['jump-jump', 'carousel', 'fireworks-deck'],
      southRow: ['parkour-run'],
    });

    /* ---------- ③ 共享资源池：所有几何 / 材质 / 纹理在 init 一次性建完 ----------
     * 关键：update() 里绝不新建任何 geometry/material/texture，否则首次上传会
     * 发生在预热之后，造成「游戏中途假泄漏」。
     */
    this._buildSharedResources();
    for (const geo of this._geometries) register(geo);
    for (const mat of this._materials) register(mat);
    for (const tex of this._textures) register(tex);

    /* ---------- ④ 场景奇观（全程序化几何拼搭） ---------- */
    this._buildSky();
    this._buildGround();
    this._buildVegetation();
    // 街道氛围物必须在 _buildFurniture 之前：后者末尾统一按 _treePositions 铺接触阴影
    this._buildStreetProps();
    this._buildFurniture();
    this._buildLightShafts();
    this._buildGate();
    this._buildFountain();
    this._buildPumpkinWheel();
    this._buildCoinCorridor();
    this._buildMemoryHouse();
    this._buildBouncingArena();
    this._buildTrainStation();
    // 实体化外观：40m 过山车 / 巨型南瓜与魔法帐篷 / 竞技场围栏
    this._buildCoasterTrack();
    this._buildFacilityFacades();
    this._buildArenaFences();
    this._buildM9Facades();
    this._buildFireworksDeckFacade();
    this._buildCenturyClockFacade();
    this._applyExteriorLOD();
    this._buildTriggers();

    /* ---------- ④-a 动物园：挂到 Lobby.root，资源全部登记进本轮台账 ----------
     * 坐标与 Blender 交付的 playground_zoo.blend 一致（x∈[32,88] / z∈[-26,26]），
     * 只新增对象，不改动任何既有设施 / 触发环 / AABB / 机位。 */
    this._zoo = buildZoo({
      root: this.root,
      trackGeometry: (g) => this._trackGeometry(g),
      trackMaterial: (m) => this._trackMaterial(m),
      trackTexture: (t) => this._trackTexture(t),
    });
    this._zooView = false;
    this._zooFly = null;

    /* ---------- ④-b 资源上传防线：让资源计数与玩家所处视角无关 ----------
     * renderer.info.memory.geometries 只统计「已被渲染上传」的 geometry。
     * 玩家可能在任意位置 / 任意 yaw 退出小游戏；若重建后某种共享几何体的
     * 所有 Mesh 都落在视锥外，renderOnce() 那一帧就不会上传它，计数会比基线
     * 少 1（并非泄漏，但会让「差值恒为 0」判定失败）。
     * 因此给每个 geometry 保留一个 frustumCulled=false 的代表对象。
     */
    this._ensureGeometryUpload();

    /* ---------- ④-d 【M7】正方形四宫格骨架 + 区域级 LOD ----------
     * 必须在 _ensureGeometryUpload() 之后：新区的 mesh 保持 frustumCulled=true，
     * 不被强制常驻渲染；俯瞰/常规验收机位朝 -z 看，北侧 z≥30 两区在视锥外，
     * 自动剔除 → 预算零增量。全部复用共享几何，零新增 geometry/texture → Δ0/0。 */
    this._districts = buildDistricts({
      root: this.root,
      shared: this._shared,
    });
    this.root.userData.districtView = DISTRICT_VIEW;
    this.root.userData.districtGrid = DISTRICT_GRID;

    /* ---------- ⑤ 相机 / UI / 输入 ---------- */
    const { camera, renderer } = ctx;
    this._controls = new OrbitControls(camera, renderer.domElement);
    this._controls.minDistance = ORBIT_MIN_DIST;
    this._controls.maxDistance = ORBIT_MAX_DIST;
    this._controls.minPolarAngle = ORBIT_MIN_POLAR;
    this._controls.maxPolarAngle = ORBIT_MAX_POLAR;
    this._controls.enableDamping = true;
    this._controls.dampingFactor = ORBIT_DAMPING;
    this._controls.enablePan = false;
    camera.position.set(_lobbyMemory.cam.x, _lobbyMemory.cam.y, _lobbyMemory.cam.z);
    this._controls.target.set(_lobbyMemory.tgt.x, _lobbyMemory.tgt.y, _lobbyMemory.tgt.z);
    this._controls.update(); // init 立即摆好 orbit 机位，保证随后 renderOnce 上传全部资源

    /* ---------- ⑤-b T02：第一人称 WASD 控制器（与 OrbitControls 互斥） ----------
     * CameraRig 是全局单例，configure 幂等；owner 只在模式切换/过渡期间持有。
     * getObstacles/isEnabled 都是闭包，每帧读本实例的实时状态，天然跟随重建。 */
    cameraRig.configure({ camera });
    this._wasd = new WASDController({
      camera,
      domElement: renderer.domElement,
      getObstacles: () => this._buildingBoxes,
      isEnabled: () => !this._disposed
        && this._inputMode === 'wasd'
        && this._sitState === 'none'
        && !this._wasdBlendActive
        /* 【T03 集成修复】相机被嵌入视图 / 设施过渡接管时，WASD 必须让位，
         * 否则第一人称平移会和 CameraRig 的 blend/restore 逐帧抢写相机。
         * FacilityRuntime.configure() 把大厅默认 owner 设为 'lobby'；
         * activate(key) 会改成设施 key，这段期间 owner 不在白名单内 → 禁用。 */
        && !cameraRig.isTransitioning
        && (cameraRig.owner === null
          || cameraRig.owner === 'lobby'
          || cameraRig.owner === 'lobby-wasd'),
    });
    this._wasd.attach();

    this._buildUI();
    this._bindInput();

    /* ---------- ④-c 模块 7 昼夜系统接线 ----------
     * Lobby 每次切换都被完整 dispose + 重建，Sky 球与所有材质都会换新实例，
     * 因此必须【每次 init 重新注册】，dispose 再注销，避免悬挂已释放的材质。
     * 注册后立刻 applyImmediate：保证从烟花站台/小游戏返回大厅时，
     * 当前昼夜模式在第一帧就生效，不会先闪一下白天再渐变。
     */
    dayNightCycle.registerSky(this._sky?.material ?? null);
    dayNightCycle.registerLobbyMaterials(this._materials);
    dayNightCycle.setContext('lobby');
    dayNightCycle.applyImmediate();
    fireworkSystem.setContext('lobby');
    // 【模块 8】把真实建筑 AABB 注入 NPC 寻路（Lobby 每次重建都会换一批）
    npcManager.setObstacles(this._buildingBoxes);
    npcManager.setContext('lobby');
    this._syncTimePanel();

    console.info(
      `[Lobby] init 完成 | OrbitControls 自由探索 | 设施=${FACILITIES.length} | 拾取体=${this._pickables.length} | ` +
      `AABB=${this._buildingBoxes.length} | 几何=${this._geometries.size} 材质=${this._materials.size} ` +
      `纹理=${this._textures.size} | 全程禁用 Rapier`
    );
  }

  _trackGeometry(geo) { this._geometries.add(geo); return geo; }
  _trackMaterial(mat) { this._materials.add(mat); return mat; }
  _trackTexture(tex) { this._textures.add(tex); return tex; }

  /**
   * 保存并接管：相机姿态、背景/雾、基座已有灯光强度、renderer.shadowMap。
   * 不修改 core/ 文件，只在运行时通过 ctx 调整；dispose() 会逐项还原。
   */
  _takeOverScene(ctx) {
    const { scene, camera, renderer } = ctx;

    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    this._sceneSaved = { background: scene.background, fog: scene.fog };
    // 日间游乐场：背景作为天空之外的兜底色，雾很薄，远端设施融进远景而不糊。
    // 颜色线性空间 ×0.38：抵消基座 exposure=1.0（手册 P5），成像与旧 0.38 曝光等价。
    scene.background = new THREE.Color(0x8fc3e8).multiplyScalar(0.38);
    // 线性雾 45→130：45m 内完全无雾，20~40m 的草地不再被雾抬亮；
    // 地面半径 110m 处已接近雾色，远端与天空平滑衔接，不再留硬亮带。
    scene.fog = new THREE.Fog(new THREE.Color(0xa8b0b4).multiplyScalar(0.38), 45, 130);

    // 夜间照明方案已统一在 SceneManager：一主光（方向光投影）+ 半球光 + 极弱环境光。
    // 本类不再压暗/接管外部灯光，只登记原值，确保 dispose 时能够逐一还原。
    this._externalLights = [];
    for (const child of scene.children) {
      if (!child.isLight) continue;
      this._externalLights.push({
        light: child,
        intensity: child.intensity,
        castShadow: child.castShadow,
      });
    }

    // 阴影配置归 SceneManager 常驻所有，本类只登记快照、不改写。
    // 旧版在这里重复赋值 THREE.PCFSoftShadowMap，但该枚举在 three r187 已移除，
    // WebGLShadowMap 每次都会告警并回退到 PCFShadowMap（见 core/SceneManager.js）。
    this._shadowSaved = {
      enabled: renderer.shadowMap.enabled,
      type: renderer.shadowMap.type,
    };
  }

  /** 几何 / 材质 / 纹理全部共享，避免 draw call 与资源计数随场景复杂度膨胀 */
  _buildSharedResources() {
    const geoBox = this._trackGeometry(new THREE.BoxGeometry(1, 1, 1));
    const geoSphere = this._trackGeometry(new THREE.IcosahedronGeometry(1, 1));
    const geoIco0 = this._trackGeometry(new THREE.IcosahedronGeometry(1, 0));
    const geoCone = this._trackGeometry(new THREE.ConeGeometry(1, 1, 7));
    const geoTorus = this._trackGeometry(new THREE.TorusGeometry(1, 0.055, 8, 56));
    const geoCylinder = this._trackGeometry(new THREE.CylinderGeometry(1, 1, 1, 16));
    const geoCoin = this._trackGeometry(new THREE.CylinderGeometry(1, 1, 0.1, 20));
    const geoPlane = this._trackGeometry(new THREE.PlaneGeometry(1, 1));
    // 草地：独立的大平面几何（96×96 分段用于顶点位移，与共享 geoPlane 分开）
    const geoGround = this._trackGeometry(new THREE.PlaneGeometry(220, 220, 96, 96));
    // 云带降级用：开口圆柱，法线朝内
    const geoCloudBand = this._trackGeometry(new THREE.CylinderGeometry(1, 1, 1, 32, 1, true));

    const texGrass = this._trackTexture(makeGrassTexture());
    const texGrassRough = this._trackTexture(makeGrassRoughness());
    const texGrassNormal = this._trackTexture(makeGrassNormal());
    const texPanelNormal = this._trackTexture(makePanelNormal());
    // 各向异性拉满（SwiftShader/集显通常 16，独显可能更高），只影响采样质量，
    // 不新增纹理对象，因此不动 17/24 的热基线。
    const maxAniso = this._ctx?.renderer?.capabilities?.getMaxAnisotropy?.() || 8;
    texGrass.anisotropy = maxAniso;
    texGrassRough.anisotropy = maxAniso;
    texGrass.needsUpdate = true;
    texGrassRough.needsUpdate = true;
    const texCloudA = this._trackTexture(makeCloudTexture(11));
    const texCloudB = this._trackTexture(makeCloudTexture(23));
    const texCloudC = this._trackTexture(makeCloudTexture(41));
    const texCloudBand = this._trackTexture(makeCloudBandTexture());
    const texContact = this._trackTexture(makeContactShadowTexture());
    const texShaft = this._trackTexture(makeShaftTexture());

    /* ---------- T06 文字图集：10 个标签共用 1 张 2048² 纹理 ----------
     * 必须在材质之前创建（matLabelAtlas.map 指向它）。renderer 从 ctx 传入，
     * 用于读取 maxAnisotropy；纹理与材质都登记进台账，dispose 幂等。 */
    const labelAtlas = createFacilityLabelAtlas(
      [GATE_LABEL, ...FACILITIES.map((f) => f.label)],
      this._ctx?.renderer || null
    );
    this._trackTexture(labelAtlas.texture);
    const matLabelAtlas = this._trackMaterial(new THREE.MeshBasicMaterial({
      map: labelAtlas.texture,
      color: 0xffffff,
      transparent: true,
      alphaTest: 0.35,       // 干净边缘，去掉半透明毛边
      depthWrite: false,
      toneMapped: false,
      fog: false,            // 远景名称牌不被雾洗白
      side: THREE.FrontSide, // 每块牌只占一面，正/反两块 Mesh 共享同一几何
    }));

    /* ---------- 漆面霓虹（白天）：高饱和实体色 + 微弱自发光 ---------- */
    // 白天不再需要灯管自发光；albedo 直接给高饱和色，emissive 只补一点点
    // 「像漆面在阳光下的通透感」，同时保证 Bloom(threshold 0.9) 不会误拾取。
    const makePainted = (color, emissive) => this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color, emissive, emissiveIntensity: 0.046, // 0.12×0.38：抵消 exposure=1.0
      metalness: 0.05, roughness: 0.42,
      clearcoat: 1.0, clearcoatRoughness: 0.12,
    }));
    const matNeonWarm = makePainted(0xff5a2b, 0x3a1000);
    const matNeonViolet = makePainted(0x8b5cf6, 0x1b0a3a);
    const matNeonCyan = makePainted(0x0ea5e9, 0x002a3d);
    const matNeonGold = makePainted(0xffb020, 0x3a2200);
    const matTrackLine = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x2f9bd8, emissive: 0x0a2c44, emissiveIntensity: 0.076,
      metalness: 0.1, roughness: 0.38,
    }));

    /* ---------- 植被（树 / 灌木）：共用材质，靠 instanceColor 做色差 ---------- */
    const matBark = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x8a6242, roughnessMap: texGrassRough, metalness: 0, roughness: 0.78,
      flatShading: true,
    }));
    const matLeaf = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 0, roughness: 0.92, flatShading: true,
      // 树冠只靠 instanceColor 上色，环境反射会把它冲成粉彩；压到 0.1 保留暗部
      envMapIntensity: 0.1,
    }));
    const matFlower = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffd83a, emissive: 0x3a2600, emissiveIntensity: 0.076,
      metalness: 0, roughness: 0.5, flatShading: true,
    }));

    /* ---------- 云 / 接触阴影 / 假光柱 ----------
     * Sprite/Points 是无 lit 材质，颜色直接进 OutputPass：×0.38 抵消曝光。 */
    const unlitComp = (hex) => new THREE.Color(hex).multiplyScalar(0.38);
    const matCloudA = this._trackMaterial(new THREE.SpriteMaterial({
      map: texCloudA, color: unlitComp(0xffffff), transparent: true, depthWrite: false, fog: false, opacity: 0.85,
    }));
    const matCloudB = this._trackMaterial(new THREE.SpriteMaterial({
      map: texCloudB, color: unlitComp(0xffffff), transparent: true, depthWrite: false, fog: false, opacity: 0.85,
    }));
    const matCloudC = this._trackMaterial(new THREE.SpriteMaterial({
      map: texCloudC, color: unlitComp(0xffffff), transparent: true, depthWrite: false, fog: false, opacity: 0.85,
    }));
    // 手册 P5 全面弃用 MeshBasicMaterial：无lit 贴片改用 Standard 的
    // 「color=黑 + emissiveMap」等效自发光通道（emissiveIntensity 0.38 抵消曝光）。
    // map 同贴一张：Standard 的 alpha 只取自 map/opacity，emissiveMap 不带 alpha，
    // 不挂 map 会丢失云团/光柱的羽化边缘，露出整块矩形。
    const matCloudBand = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x000000, map: texCloudBand, emissive: 0xffffff, emissiveMap: texCloudBand, emissiveIntensity: 0.38,
      transparent: true, depthWrite: false, fog: false,
      side: THREE.BackSide, opacity: 0.85,
    }));
    const matContactShadow = this._trackMaterial(new THREE.MeshStandardMaterial({
      map: texContact, transparent: true, depthWrite: false, fog: false,
      color: 0x000000, opacity: 0.9, metalness: 0, roughness: 1,
    }));
    // additive + 不写深度；透明度 0.28 让光柱真能看见，靠「窄 + 位置准」控量。
    const matShaft = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x000000, map: texShaft, emissive: 0xffffff, emissiveMap: texShaft, emissiveIntensity: 0.38,
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0.28,
    }));
    /* ---------- 材质总则（白天阳光游乐场） ----------
     * 金属件   metalness 0.9~1.0，roughness 0.25~0.4（真实反射，配 clearcoat）
     * 非金属件 metalness 0，roughness 0.4~0.9
     * 霓虹灯管 → 高饱和漆面：albedo 就是最终颜色，emissive 只留 0.15~0.3
     *           的微弱提亮，靠日光与软阴影出体积，不再靠自发光。
     * clearcoat 只给金属/烤漆件用（MeshPhysicalMaterial 比 Standard 重，
     *           材质数量控制在 5 个以内，靠复用来分摊 shader 编译成本）。
     */
    const matGround = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texGrass, roughnessMap: texGrassRough,
      normalMap: texGrassNormal, normalScale: new THREE.Vector2(0.5, 0.5),
      metalness: 0, roughness: 1.0, envMapIntensity: 0.3,
    }));
    // 金属立柱：亮银 + clearcoat，白天顶光下有清晰的高光带；板缝法线给烤漆面细节
    const matPillar = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xc9d3dd, metalness: 1, roughness: 0.28,
      normalMap: texPanelNormal, normalScale: new THREE.Vector2(0.22, 0.22),
      clearcoat: 1.0, clearcoatRoughness: 0.08,
    }));
    const matWheelFrame = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xb7c2cf, metalness: 1, roughness: 0.32,
      clearcoat: 0.9, clearcoatRoughness: 0.1,
    }));
    const matTrack = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xb9b3a4, map: texGrass, roughnessMap: texGrassRough,
      metalness: 0, roughness: 0.78,
    }));

    const matPumpkinOrange = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xff8a24, emissive: 0x5c1f00, emissiveIntensity: 0.19,
      metalness: 0, roughness: 0.62, flatShading: true,
    }));
    const matPumpkinViolet = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9a63e0, emissive: 0x2a1250, emissiveIntensity: 0.19,
      metalness: 0, roughness: 0.62, flatShading: true,
    }));
    const matCoinGold = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffc94a, emissive: 0x7a4c00, emissiveIntensity: 0.38,
      metalness: 1, roughness: 0.12,
    }));

    const matTriggerRing = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9fe8ff, emissive: 0x2fa8d8, emissiveIntensity: 0.61,
      metalness: 0, roughness: 0.6, transparent: true, opacity: 0.7,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    }));
    const matTriggerDisc = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x6fb8e8, emissive: 0x2f7ac0, emissiveIntensity: 0.38,
      metalness: 0, roughness: 0.7, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    }));
    const matParticleWarm = this._trackMaterial(new THREE.PointsMaterial({
      color: unlitComp(0xffb45c), size: 0.34, sizeAttenuation: true,
      transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }));
    const matParticleGold = this._trackMaterial(new THREE.PointsMaterial({
      color: unlitComp(0xffd97a), size: 0.3, sizeAttenuation: true,
      transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }));
    // 点击代理盒：完全不写颜色/深度，视觉不可见，但 Raycaster 可命中
    const matPickProxy = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
      metalness: 0, roughness: 1,
    }));

    this._shared = {
      geoBox, geoSphere, geoIco0, geoCone, geoTorus, geoCylinder, geoCoin, geoPlane,
      geoGround, geoCloudBand,
      matGround, matPillar, matWheelFrame, matTrack,
      matNeonWarm, matNeonViolet, matNeonCyan, matNeonGold, matTrackLine,
      matBark, matLeaf, matFlower,
      matCloudA, matCloudB, matCloudC, matCloudBand,
      matContactShadow, matShaft,
      matPumpkinOrange, matPumpkinViolet, matCoinGold,
      matTriggerRing, matTriggerDisc,
      matParticleWarm, matParticleGold, matPickProxy,
      labelAtlas, matLabelAtlas,
    };
  }

  /**
   * T06：为单个标签克隆一块轻量 PlaneGeometry，并把 uv 改到图集对应格子。
   * 每块几何只有 4 顶点 / 2 三角形，登记进 _geometries 台账；
   * 纹理与材质全部共享，不随标签数增长。
   *
   * @param {string} label 标签文字（必须是建图集时传入的 10 个之一）
   * @returns {{geo:THREE.PlaneGeometry, uv:object}|null} 图集缺字时返回 null
   */
  _atlasLabelGeometry(label) {
    const uv = this._shared.labelAtlas.getUV(label);
    if (!uv) {
      console.warn(`[Lobby] 文字图集缺少标签「${label}」，该名称牌已跳过`);
      return null;
    }
    const geo = this._trackGeometry(this._shared.geoPlane.clone());
    applyAtlasUV(geo, uv);
    return { geo, uv };
  }

  /** 小工具：拼一个封闭 Box 部件（射线从任意角度都能命中，不受背面剔除影响） */
  _box(parent, name, mat, sx, sy, sz, px, py, pz, { key = null, shadow = false } = {}) {
    const mesh = new THREE.Mesh(this._shared.geoBox, mat);
    mesh.name = `Lobby/${name}`;
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(px, py, pz);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (key) {
      mesh.userData.facilityKey = key;
      this._pickables.push(mesh);
    }
    parent.add(mesh);
    return mesh;
  }

  /** 小工具：拼一个球体部件 */
  _ball(parent, name, mat, radius, px, py, pz, { key = null, shadow = false } = {}) {
    const mesh = new THREE.Mesh(this._shared.geoSphere, mat);
    mesh.name = `Lobby/${name}`;
    mesh.scale.setScalar(radius);
    mesh.position.set(px, py, pz);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (key) {
      mesh.userData.facilityKey = key;
      this._pickables.push(mesh);
    }
    parent.add(mesh);
    return mesh;
  }

  /* ------------------------------------------------------------------------ */
  /* ① 白天天空（three/addons Sky.js 大气散射）+ 三层 Canvas 云                 */
  /* ------------------------------------------------------------------------ */

  _buildSky() {
    const sky = new Sky();
    sky.name = 'Lobby/sky';
    // Sky 内部是 1×1×1 Box，缩放需落在 camera.far(200) 内；每帧跟随相机水平位移
    sky.scale.setScalar(150);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = SKY_TURBIDITY;
    uniforms.rayleigh.value = SKY_RAYLEIGH;
    uniforms.mieCoefficient.value = SKY_MIE_COEFFICIENT;
    uniforms.mieDirectionalG.value = SKY_MIE_DIRECTIONAL_G;
    const phi = THREE.MathUtils.degToRad(90 - SKY_SUN_ELEVATION);
    const theta = THREE.MathUtils.degToRad(SKY_SUN_AZIMUTH);
    uniforms.sunPosition.value.setFromSphericalCoords(1, phi, theta);

    // Sky.js 在 ACES 下整体偏亮（尤其太阳晕），给最终颜色加一道增益压低。
    // 【地平线白带实测归因】压完通道增益后，1280×720 截图的 y=340~360 仍是
    // RGB(227,236,241)/亮度0.92，而它正下方 y=370 已降到 0.63 —— 白带来自
    // 天空侧（Sky 地平线散射 + 云），不是雾。故在增益里再乘一个随视线高度
    // 恢复的 horizonDim：direction.y≈0 的地平线压到 0.52，抬到约 9° 后恢复，
    // 平滑无硬边。direction 由 Sky.js 片元着色器第 241 行算出，可直接复用。
    //
    // 【模块 7 昼夜】把原先硬编码的 vec3(0.55,0.62,0.78) 换成两个 uniform：
    //   uSkyTint      —— 白天偏蓝 / 黄昏暖橙 / 黑夜深蓝
    //   uSkyBrightness —— 白天 1.0 / 黄昏 0.88 / 黑夜 0.34
    // DayNightCycle 每帧 lerp 它们并驱动 sunPosition/散射参数；默认值与旧的
    // 白天常量完全一致，因此不改任何日间外观（基线不变）。
    sky.material.uniforms.uSkyTint = { value: new THREE.Vector3(0.55, 0.62, 0.78) };
    sky.material.uniforms.uSkyBrightness = { value: 1.0 };
    sky.material.fragmentShader = 'uniform vec3 uSkyTint;\nuniform float uSkyBrightness;\n' +
      sky.material.fragmentShader.replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        'gl_FragColor = vec4( texColor * uSkyTint * uSkyBrightness * ' +
        'mix(0.40, 1.0, smoothstep(0.0, 0.16, clamp(direction.y, 0.0, 1.0))), 1.0 );',
      );
    sky.material.depthWrite = false;
    sky.material.fog = false;
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    // Sky 的 geometry/material 是构造时自建的，必须手动登记才能进 dispose 流程
    this._trackGeometry(sky.geometry);
    this._trackMaterial(sky.material);
    this._sky = sky;
    this.root.add(sky);

    this._buildClouds();
  }

  /**
   * 云：桌面 24 张 Sprite（3 层 × 8 张，3 个共享 SpriteMaterial）；
   * 触屏/低性能设备降级为 3 条环形云带（3 draw call）。
   * 云组每帧跟随相机水平位移、按层给不同视差系数 → 无限远的错觉。
   */
  _buildClouds() {
    const S = this._shared;
    const coarse = this._isCoarseDevice();
    const group = new THREE.Group();
    group.name = 'Lobby/clouds';
    // renderOrder 紧跟天空，保证云在天空之后、场景之前绘制
    group.renderOrder = -999;
    this.root.add(group);
    this._clouds = group;
    this._cloudLayers = [];

    if (coarse) {
      // 降级：3 条环绕圆柱云带，一张 2048×512 贴图，3 个 draw call
      const layers = [
        { radius: 118, height: 26, y: 48, opacity: 0.5 },
        { radius: 96, height: 20, y: 36, opacity: 0.6 },
        { radius: 72, height: 14, y: 56, opacity: 0.42 },
      ];
      for (const layer of layers) {
        const mat = S.matCloudBand.clone();
        mat.opacity = layer.opacity;
        this._trackMaterial(mat);
        mat.map.repeat.set(3, 1);
        const band = new THREE.Mesh(S.geoCloudBand, mat);
        band.name = `Lobby/cloud-band-${layer.radius}`;
        band.scale.set(layer.radius, layer.height, layer.radius);
        band.rotation.y = 0;
        band.position.y = layer.y;
        band.frustumCulled = false;
        group.add(band);
        this._cloudLayers.push({ object: band, parallax: 0.9, spin: 0.006 });
      }
      return;
    }

    // 桌面：3 层 sprite，每层 8 张（共 24 张）
    const mats = [S.matCloudA, S.matCloudB, S.matCloudC];
    // 云层抬高 + 压低不透明度：实测 1280×720 截图 y=240 是纯白云(249,250,251)、
    // y=340~360 仍是亮度 0.85 的浅带，说明低层云堆在地平线是白带主因。
    // 最低层从 alt46/op0.75 抬到 alt58/op0.45，其余两层同步降一档。
    const layers = [
      { alt: 82, spread: 96, sizeMin: 40, sizeMax: 70, opacity: 0.38, parallax: 0.88 },
      { alt: 58, spread: 70, sizeMin: 22, sizeMax: 38, opacity: 0.45, parallax: 0.94 },
      { alt: 100, spread: 120, sizeMin: 55, sizeMax: 90, opacity: 0.26, parallax: 0.985 },
    ];
    layers.forEach((layer, li) => {
      const rnd = makeRng(1000 + li);
      for (let i = 0; i < 8; i += 1) {
        const mat = mats[i % mats.length].clone();
        mat.opacity = layer.opacity * (0.7 + rnd() * 0.3);
        mat.rotation = (rnd() - 0.5) * 0.12;
        this._trackMaterial(mat);
        const sprite = new THREE.Sprite(mat);
        sprite.name = `Lobby/cloud-${li}-${i}`;
        const size = layer.sizeMin + rnd() * (layer.sizeMax - layer.sizeMin);
        sprite.scale.set(size, size * 0.5, 1);
        sprite.position.set((rnd() - 0.5) * layer.spread * 2, layer.alt + (rnd() - 0.5) * 8, (rnd() - 0.5) * layer.spread * 2);
        sprite.frustumCulled = false;
        group.add(sprite);
      }
      this._cloudLayers.push({ object: null, parallax: layer.parallax, spin: 0 });
    });
    this._cloudSprites = group.children;
  }

  /** 触屏 / 低像素密度设备判定（自动降级开关，不加 UI） */
  _isCoarseDevice() {
    const coarse = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false;
    const lowMem = typeof navigator !== 'undefined' &&
      !!navigator.deviceMemory && navigator.deviceMemory <= 4;
    // 【兜底】CDP / 部分真机的 matchMedia(coarse) 恒为 false、deviceMemory 也可能缺失，
    // 导致移动端仍跑 24 张 Sprite 云。maxTouchPoints>0 是触屏最可靠的信号：
    // 命中时切到 3 条云带（3 draw call），几何/材质/纹理均已登记到台账。
    const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
    return Boolean(coarse || lowMem || touch);
  }

  /* ------------------------------------------------------------------------ */
  /* ② 草坪地面（程序化草地纹理 + 顶点微起伏）+ 发光引导线                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 地形高度：活动区（半径 18 内）强制为 0，保证设施基座、触发环、引导线不被顶穿；
   * 18~34 之间做 0.10 幅度的缓坡（坡度约 1.5%，走位无感）；更远处放大到 0.9 做草丘。
   */
  _terrainHeight(x, z) {
    const r = Math.hypot(x, z);
    if (r <= TERRAIN_FLAT_RADIUS) return 0;
    const wave = Math.sin(x * 0.17) * Math.cos(z * 0.13) * 0.6 + Math.sin((x + z) * 0.29) * 0.4;
    const inner = THREE.MathUtils.clamp((r - TERRAIN_FLAT_RADIUS) / 16, 0, 1);
    const outer = THREE.MathUtils.clamp((r - 34) / 30, 0, 1);
    const amp = TERRAIN_AMP_IN * (1 - outer) + TERRAIN_AMP_OUT * outer;
    return wave * amp * inner;
  }

  _buildGround() {
    const S = this._shared;

    // 顶点位移：96×96 分段，半径 18 内严格 0，远处才起伏
    const pos = S.geoGround.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = -pos.getY(i); // 平面旋转 -90° 后，几何 y 对应世界 -z
      pos.setZ(i, this._terrainHeight(x, z));
    }
    pos.needsUpdate = true;
    S.geoGround.computeVertexNormals();

    const ground = new THREE.Mesh(S.geoGround, S.matGround);
    ground.name = 'Lobby/ground';
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.root.add(ground);

    /* 【M2】引导线全部从 triggerOf() 派生的门位坐标生成，绝不再写死任何坐标。
     * 结构：一条中轴主路（大门 → 广场中心 → 魔法牌屋），加上从广场中心
     * 放射到每个设施大门的支路。布局变了，路自动跟着变。 */
    const trig = (key) => FACILITIES.find((f) => f.key === key).trigger;
    const gateZ = 15;
    const memoryZ = trig('memory-match').z;

    this._box(this.root, 'guide-center', S.matNeonCyan,
      0.16, 0.02, gateZ - memoryZ, 0, 0.035, (gateZ + memoryZ) / 2);
    this._box(this.root, 'guide-center-front', S.matNeonViolet,
      0.16, 0.02, 6, 0, 0.035, memoryZ - 0.5);

    for (const f of FACILITIES) {
      if (f.key === 'memory-match' || f.key === 'century-clock') continue; // 已在中轴上
      const t = f.trigger;
      const len = Math.hypot(t.x, t.z);
      if (len < 1) continue;
      const line = this._box(this.root, `guide-${f.key}`, S.matNeonGold,
        0.14, 0.02, len, t.x / 2, 0.035, t.z / 2);
      // +Z 轴旋转到 (dx,dz) 方向：R_y(θ) 把 +Z 映射到 (sinθ, cosθ)
      line.rotation.y = Math.atan2(t.x, t.z);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* ②-b 植被：3 种树型 / 45 棵，全部 InstancedMesh（约 11 draw call）          */
  /* ------------------------------------------------------------------------ */

  /** 设施与建筑的占位禁区（种树/摆家具时避让，避免穿模与挡动线） */
  _exclusionZones() {
    const zones = [
      { x: 0, z: 15, r: 9 },   // 大门
      { x: 0, z: -9, r: 9 },   // 魔法牌屋
    ];
    for (const f of FACILITIES) zones.push({ x: f.x, z: f.z, r: 10 });
    for (const f of FACILITIES) {
      if (f.trigger) zones.push({ x: f.trigger.x, z: f.trigger.z, r: 4.5 });
    }
    // 过山车桥墩下方留空，避免树 / 长椅长在轨道支柱里
    zones.push({ x: COASTER.cx, z: COASTER.cz, r: COASTER.lobeA + 2 });
    return zones;
  }

  _isBlocked(x, z, zones, extra = 0) {
    return zones.some((zone) => Math.hypot(x - zone.x, z - zone.z) < zone.r + extra);
  }

  _buildVegetation() {
    const S = this._shared;
    const zones = this._exclusionZones();
    const rnd = makeRng(31415);
    const trash = [];

    // ---- 生成位置：环状分布，半径越大越密，避开设施禁区与引导线 ----
    const pick = (rMin, rMax, count, minGap) => {
      const out = [];
      let guard = 0;
      while (out.length < count && guard < count * 40) {
        guard += 1;
        const a = rnd() * Math.PI * 2;
        const r = rMin + rnd() * (rMax - rMin);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (this._isBlocked(x, z, zones, 1.2)) continue;
        // 与已有树保持间距，避免树冠互穿
        if (out.some((p) => Math.hypot(p.x - x, p.z - z) < minGap)) continue;
        out.push({ x, z });
      }
      return out;
    };

    const broadleaf = pick(34, 62, 18, 6.5);
    const conifers = pick(38, 66, 15, 7.5);
    const shrubs = pick(20, 38, 12, 4.2);

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    // 【树冠泛粉彩的根因】THREE.Color.setHSL 默认写「线性工作空间」分量，
    // 经 OutputPass 做 sRGB 编码后，显示亮度会明显高于这里的 l 值；
    // 再叠加半球光 groundColor 的草绿反照 + RoomEnvironment 环境反射，
    // 深绿就会泛成薄荷/粉彩。故把 l 压一档、饱和度提到 0.72~0.78，
    // 并在 SceneManager 里把半球光 groundColor 改深（不再从下方打亮树冠）。
    const leafColor = (h, s, l) => color.setHSL(h, s, l);

    const addInstanced = (name, geo, mat, count, castShadow = true) => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.name = name;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      trash.push(mesh);
      return mesh;
    };

    // ---- 阔叶树：树干 + 3 团树冠 ----
    const trunkGeo = S.geoCylinder;
    const broadTrunks = addInstanced('Lobby/tree-trunk-broad', trunkGeo, S.matBark, broadleaf.length);
    const broadCanopy = [
      addInstanced('Lobby/tree-canopy-broad-0', S.geoSphere, S.matLeaf, broadleaf.length),
      addInstanced('Lobby/tree-canopy-broad-1', S.geoIco0, S.matLeaf, broadleaf.length),
      addInstanced('Lobby/tree-canopy-broad-2', S.geoIco0, S.matLeaf, broadleaf.length),
    ];
    broadleaf.forEach((p, i) => {
      const scale = 0.9 + rnd() * 0.45;
      const trunkH = 3.2 * scale;
      const rot = rnd() * Math.PI * 2;
      dummy.position.set(p.x, trunkH / 2, p.z);
      dummy.rotation.set(0, rot, 0);
      dummy.scale.set(0.22 * scale, trunkH, 0.22 * scale);
      dummy.updateMatrix();
      broadTrunks.setMatrixAt(i, dummy.matrix);
      const hue = 0.26 + rnd() * 0.09;
      const light = 0.13 + rnd() * 0.05; // 浓绿：原 0.18~0.24 线性值显示后偏粉彩
      broadCanopy.forEach((mesh, k) => {
        const off = k === 0 ? 0 : 1;
        dummy.position.set(
          p.x + (k === 0 ? 0 : (rnd() - 0.5) * 1.9 * scale),
          trunkH + (k === 0 ? 1.6 : 0.9 + rnd() * 1.4) * scale,
          p.z + (k === 0 ? 0 : (rnd() - 0.5) * 1.9 * scale),
        );
        dummy.rotation.set(rnd() * 0.6, rnd() * Math.PI, 0);
        const s = (k === 0 ? 2.0 : 1.35 + rnd() * 0.5) * scale;
        dummy.scale.set(s, s * (k === 0 ? 1.0 : 0.9), s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        leafColor(hue + k * 0.01, 0.78, light + off * 0.015);
        mesh.setColorAt(i, color);
      });
      this._treePositions.push({ x: p.x, z: p.z, r: 2.0 * scale });
    });

    // ---- 针叶树：树干 + 3 层锥体（逐层收窄） ----
    const coniferTrunks = addInstanced('Lobby/tree-trunk-conifer', trunkGeo, S.matBark, conifers.length);
    const coniferCrown = [
      addInstanced('Lobby/tree-conifer-0', S.geoCone, S.matLeaf, conifers.length),
      addInstanced('Lobby/tree-conifer-1', S.geoCone, S.matLeaf, conifers.length),
      addInstanced('Lobby/tree-conifer-2', S.geoCone, S.matLeaf, conifers.length),
    ];
    conifers.forEach((p, i) => {
      const scale = 0.95 + rnd() * 0.5;
      const trunkH = 1.9 * scale;
      dummy.position.set(p.x, trunkH / 2, p.z);
      dummy.rotation.set(0, rnd() * Math.PI, 0);
      dummy.scale.set(0.2 * scale, trunkH, 0.2 * scale);
      dummy.updateMatrix();
      coniferTrunks.setMatrixAt(i, dummy.matrix);
      const hue = 0.3 + rnd() * 0.05;
      coniferCrown.forEach((mesh, k) => {
        const h = 2.6 - k * 0.55;
        dummy.position.set(p.x, trunkH + k * 1.45 * scale + h / 2, p.z);
        dummy.rotation.set(0, rnd() * Math.PI, 0);
        const rad = (1.5 - k * 0.38) * scale;
        dummy.scale.set(rad, h * scale, rad);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        leafColor(hue, 0.74, 0.105 + k * 0.03);
        mesh.setColorAt(i, color);
      });
      this._treePositions.push({ x: p.x, z: p.z, r: 1.2 * scale });
    });

    // ---- 灌木 + 花：3 团小球 + 6 朵花 ----
    const shrubBlobs = [
      addInstanced('Lobby/shrub-0', S.geoIco0, S.matLeaf, shrubs.length, false),
      addInstanced('Lobby/shrub-1', S.geoIco0, S.matLeaf, shrubs.length, false),
      addInstanced('Lobby/shrub-2', S.geoIco0, S.matLeaf, shrubs.length, false),
    ];
    const flowerMesh = addInstanced('Lobby/shrub-flower', S.geoIco0, S.matFlower, shrubs.length * 4, false);
    let flowerIndex = 0;
    shrubs.forEach((p, i) => {
      const scale = 0.8 + rnd() * 0.5;
      shrubBlobs.forEach((mesh, k) => {
        const a = (k / 3) * Math.PI * 2;
        dummy.position.set(p.x + Math.cos(a) * 0.5 * scale, 0.55 * scale, p.z + Math.sin(a) * 0.5 * scale);
        dummy.rotation.set(rnd() * Math.PI, rnd() * Math.PI, 0);
        const s = (0.7 + rnd() * 0.25) * scale;
        dummy.scale.set(s, s * 0.85, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        leafColor(0.28 + rnd() * 0.04, 0.68, 0.20 + rnd() * 0.06);
        mesh.setColorAt(i, color);
      });
      for (let k = 0; k < 4; k += 1) {
        const a = rnd() * Math.PI * 2;
        dummy.position.set(p.x + Math.cos(a) * 0.75 * scale, 0.95 * scale, p.z + Math.sin(a) * 0.75 * scale);
        dummy.rotation.set(rnd() * Math.PI, rnd() * Math.PI, 0);
        dummy.scale.setScalar(0.16 * scale);
        dummy.updateMatrix();
        flowerMesh.setMatrixAt(flowerIndex, dummy.matrix);
        leafColor(0.12 + rnd() * 0.06, 0.85, 0.6);
        flowerMesh.setColorAt(flowerIndex, color);
        flowerIndex += 1;
      }
      this._treePositions.push({ x: p.x, z: p.z, r: 1.0 * scale });
    });

    // ---- 小草簇（手册 P5：草地 InstancedMesh 批量渲染）：400 株细锥，1 draw call ----
    const tufts = pick(16, 58, 400, 0.9);
    const grassMesh = addInstanced('Lobby/grass-tufts', S.geoCone, S.matLeaf, tufts.length, false);
    tufts.forEach((p, i) => {
      const h = 0.16 + rnd() * 0.14;
      dummy.position.set(p.x, h / 2, p.z);
      dummy.rotation.set((rnd() - 0.5) * 0.5, rnd() * Math.PI, (rnd() - 0.5) * 0.5);
      dummy.scale.set(0.05 + rnd() * 0.03, h, 0.05 + rnd() * 0.03);
      dummy.updateMatrix();
      grassMesh.setMatrixAt(i, dummy.matrix);
      leafColor(0.27 + rnd() * 0.06, 0.7, 0.12 + rnd() * 0.06);
      grassMesh.setColorAt(i, color);
    });

    for (const mesh of trash) mesh.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------------ */
  /* ②-c 长椅 / 路灯 / 花坛（InstancedMesh）                                    */
  /* ------------------------------------------------------------------------ */

  _buildFurniture() {
    const S = this._shared;
    const rnd = makeRng(2718);
    const zones = this._exclusionZones();
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const trash = [];
    const addIM = (name, geo, mat, count, castShadow = true) => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.name = name;
      mesh.castShadow = castShadow;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      trash.push(mesh);
      return mesh;
    };

    // ---- 长椅：8 张，沿半径 22 的环均布，朝向广场中心 ----
    // 【模块 8 修正】不能直接用 _exclusionZones()（每个设施 r=10 的种树禁区）：
    // 新增烟花台/世纪钟后会把半径 22 环吃掉大半，实测 8 张只剩 2 张。
    // 长椅本就该放在设施旁供游客歇脚，这里改用「只避实体建筑本体」的小半径集。
    const benchZones = [
      { x: 0, z: 15, r: 6 },                                   // 大门门楼
      { x: 0, z: -9, r: 6 },                                  // 魔法牌屋
      { x: COASTER.cx, z: COASTER.cz, r: COASTER.lobeA - 3 }, // 过山车桥墩带
      ...FACILITIES.map((f) => ({ x: f.x, z: f.z, r: 4.2 })),
    ];
    const benchCount = 8;
    const seat = addIM('Lobby/bench-seat', S.geoBox, S.matBark, benchCount);
    const back = addIM('Lobby/bench-back', S.geoBox, S.matBark, benchCount);
    const legs = addIM('Lobby/bench-leg', S.geoBox, S.matPillar, benchCount * 2);
    const benchSpots = [];
    const usedIdx = new Set();
    for (let i = 0; i < benchCount; i += 1) {
      const a = (i / benchCount) * Math.PI * 2 + 0.35;
      const x = Math.cos(a) * 22;
      const z = Math.sin(a) * 22;
      if (this._isBlocked(x, z, benchZones, 0.6)) continue;
      usedIdx.add(i);
      const yaw = -a + Math.PI / 2;
      benchSpots.push({ x, z, yaw });
      dummy.position.set(x, 0.45, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(2.2, 0.12, 0.62);
      dummy.updateMatrix();
      seat.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x + Math.cos(yaw) * 0 + Math.sin(yaw) * -0.3, 0.75, z + Math.cos(yaw) * -0.3);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(2.2, 0.45, 0.1);
      dummy.updateMatrix();
      back.setMatrixAt(i, dummy.matrix);
      for (const side of [-1, 1]) {
        dummy.position.set(x + Math.cos(yaw) * side * 0.85, 0.2, z - Math.sin(yaw) * side * 0.85);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(0.14, 0.4, 0.5);
        dummy.updateMatrix();
        legs.setMatrixAt(i * 2 + (side < 0 ? 0 : 1), dummy.matrix);
      }
    }
    // 【修正】被 benchZones 排除的索引，InstancedMesh 会保留默认单位矩阵，
    // 在原点留下一堆 1×1×1 的方块。把未使用的实例统一缩到 0 隐藏。
    for (let i = 0; i < benchCount; i++) {
      if (usedIdx.has(i)) continue;
      dummy.position.set(0, -1000, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      seat.setMatrixAt(i, dummy.matrix);
      back.setMatrixAt(i, dummy.matrix);
      legs.setMatrixAt(i * 2, dummy.matrix);
      legs.setMatrixAt(i * 2 + 1, dummy.matrix);
    }
    seat.instanceMatrix.needsUpdate = true;
    back.instanceMatrix.needsUpdate = true;
    legs.instanceMatrix.needsUpdate = true;
    for (const p of benchSpots) this._treePositions.push({ x: p.x, z: p.z, r: 1.5 });

    /* 【模块 8】把长椅位置存档，并给每张椅子加一个不可见点击代理：
     * 代理复用共享 geoBox + matPickProxy（零新增 GPU 资源），
     * 只在 userData 上打 benchIndex 标记，供 _handleClick 识别「坐下」。 */
    this._benchSpots = benchSpots.map((p) => ({ ...p }));
    for (let i = 0; i < this._benchSpots.length; i++) {
      const p = this._benchSpots[i];
      const proxy = this._box(this.root, `Lobby/bench-proxy-${i}`, S.matPickProxy,
        2.6, 1.5, 1.3, p.x, 0.75, p.z);
      proxy.userData.benchIndex = i;
      // 关键：不加入 _pickables，否则椅子代理会抢在设施入口前被命中，
      // 让 _pickKey 返回 null → 点击设施入口失效。单独数组单独 raycast。
      this._benchPickables.push(proxy);
    }

    // ---- 路灯：6 根，半径 16.5，暖白色小球灯罩 ----
    const lampCount = 6;
    const pole = addIM('Lobby/lamp-pole', S.geoCylinder, S.matPillar, lampCount);
    const head = addIM('Lobby/lamp-head', S.geoSphere, S.matNeonGold, lampCount, false);
    const lampSpots = [];
    for (let i = 0; i < lampCount; i += 1) {
      const a = (i / lampCount) * Math.PI * 2 + 0.9;
      const x = Math.cos(a) * 16.5;
      const z = Math.sin(a) * 16.5;
      if (this._isBlocked(x, z, zones, 0.8)) continue;
      lampSpots.push({ x, z });
      dummy.position.set(x, 2.3, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0.16, 4.6, 0.16);
      dummy.updateMatrix();
      pole.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, 4.75, z);
      dummy.scale.setScalar(0.34);
      dummy.updateMatrix();
      head.setMatrixAt(i, dummy.matrix);
      color.setHSL(0.11, 0.8, 0.62);
      head.setColorAt(i, color);
    }
    for (const p of lampSpots) this._treePositions.push({ x: p.x, z: p.z, r: 0.7 });

    // ---- 花坛：4 个圆柱花池 + 顶部花球 ----
    const bedCount = 4;
    const bed = addIM('Lobby/flowerbed-rim', S.geoCylinder, S.matTrack, bedCount);
    const bedFlowers = addIM('Lobby/flowerbed-flower', S.geoIco0, S.matFlower, bedCount * 5, false);
    let fi = 0;
    for (let i = 0; i < bedCount; i += 1) {
      const a = (i / bedCount) * Math.PI * 2 + 0.6;
      const x = Math.cos(a) * 13.5;
      const z = Math.sin(a) * 13.5;
      dummy.position.set(x, 0.3, z);
      dummy.rotation.set(0, rnd() * Math.PI, 0);
      dummy.scale.set(1.5, 0.6, 1.5);
      dummy.updateMatrix();
      bed.setMatrixAt(i, dummy.matrix);
      for (let k = 0; k < 5; k += 1) {
        const aa = (k / 5) * Math.PI * 2;
        dummy.position.set(x + Math.cos(aa) * 0.75, 0.75, z + Math.sin(aa) * 0.75);
        dummy.rotation.set(rnd() * Math.PI, rnd() * Math.PI, 0);
        dummy.scale.setScalar(0.28 + rnd() * 0.1);
        dummy.updateMatrix();
        bedFlowers.setMatrixAt(fi, dummy.matrix);
        color.setHSL(0.95 + rnd() * 0.12, 0.75, 0.55);
        bedFlowers.setColorAt(fi, color);
        fi += 1;
      }
      this._treePositions.push({ x, z, r: 1.6 });
    }

    for (const mesh of trash) mesh.instanceMatrix.needsUpdate = true;

    this._buildContactShadows();
  }

  /** 接触阴影贴片：一个 InstancedMesh 铺满树下/长椅/路灯/花坛，1 draw call */
  _buildContactShadows() {
    const S = this._shared;
    const spots = this._treePositions || [];
    if (!spots.length) return;
    const mesh = new THREE.InstancedMesh(S.geoPlane, S.matContactShadow, spots.length);
    mesh.name = 'Lobby/contact-shadows';
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    const dummy = new THREE.Object3D();
    spots.forEach((p, i) => {
      dummy.position.set(p.x, 0.022, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      const s = p.r * 2.2;
      dummy.scale.set(s, s, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.root.add(mesh);
    this._contactShadows = mesh;
  }

  /* ------------------------------------------------------------------------ */
  /* ②-d 假光柱（丁达尔替代方案）：3 片 additive 渐变平面，几乎零成本            */
  /* ------------------------------------------------------------------------ */

  _buildLightShafts() {
    const S = this._shared;
    // 只留 3 片，且全部放在「树带与建筑边缘之间的缝隙」：
    // 避开中轴 (|x|<8)、避开 5 个触发环 (±13,2)/(0,-8.5)/(±26,6)，
    // 不整片铺开；宽度从 4.2~6.4 收到 2.6~3.0，配合 opacity 0.24 才亮而不糊。
    const shafts = [
      { x: -7.5, z: 6, h: 14, w: 2.2, tilt: 0.15, rot: -0.3 }, // 中轴与南瓜设施之间
      { x: 7.5, z: 6, h: 14, w: 2.2, tilt: 0.15, rot: 0.3 },   // 中轴与金币长廊之间
      { x: 0, z: -11, h: 17, w: 2.4, tilt: 0.18, rot: 0.08 },  // 牌屋前树间
    ];
    for (const s of shafts) {
      const mesh = new THREE.Mesh(S.geoPlane, S.matShaft);
      mesh.name = 'Lobby/light-shaft';
      mesh.position.set(s.x, s.h / 2, s.z);
      mesh.rotation.set(0, s.rot, s.tilt);
      mesh.scale.set(s.w, s.h, 1);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* ③ 宏伟入口大门（z=15）：双立柱 + 横梁 + 发光方块拼「游乐园」            */
  /* ------------------------------------------------------------------------ */

  /* ------------------------------------------------------------------------ */
  /* ②-b2 中心喷泉（手册 P5 水体：transmission 透明感 + 逐顶点水面波动）         */
  /* ------------------------------------------------------------------------ */

  /**
   * 广场喷泉：盆环/水面各 1 个新几何，柱/碗/水柱复用共享几何；
   * 石材 Standard（roughness 0.85）+ 水 Physical（transmission 0.9 / roughness 0.05）。
   * 水面 RingGeometry 343 顶点，update 内逐顶点正弦波纹 + 重算法线。
   */
  _buildFountain() {
    const S = this._shared;
    const group = new THREE.Group();
    group.name = 'Lobby/fountain';
    // (0,6)：默认机位视线从大门横梁下方穿过（梁底 y≈11.6），喷泉正好落在门洞景框里；
    // 放 (0,-2) 会被门楼「游乐园」字牌挡住。
    group.position.set(0, 0, 6);
    this.root.add(group);

    const matStone = this._trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9aa0a6, metalness: 0, roughness: 0.85,
    }));
    const matWater = this._trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x2f8fba, metalness: 0, roughness: 0.05,
      transmission: 0.9, thickness: 0.4, ior: 1.33,
    }));

    const geoBasin = this._trackGeometry(new THREE.TorusGeometry(2.3, 0.28, 12, 40));
    const basin = new THREE.Mesh(geoBasin, matStone);
    basin.name = 'Lobby/fountain-basin';
    basin.rotation.x = -Math.PI / 2;
    basin.position.y = 0.42;
    basin.castShadow = true;
    basin.receiveShadow = true;
    group.add(basin);

    const geoWater = this._trackGeometry(new THREE.RingGeometry(0.05, 2.3, 48, 6));
    const water = new THREE.Mesh(geoWater, matWater);
    water.name = 'Lobby/fountain-water';
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.42;
    group.add(water);
    this._fountainWater = water;

    const column = new THREE.Mesh(S.geoCylinder, matStone);
    column.scale.set(0.28, 1.1, 0.28);
    column.position.y = 0.55;
    column.castShadow = true;
    group.add(column);
    const bowl = new THREE.Mesh(S.geoSphere, matStone);
    bowl.scale.setScalar(0.42);
    bowl.position.y = 1.15;
    bowl.castShadow = true;
    group.add(bowl);
    const jet = new THREE.Mesh(S.geoCone, matWater);
    jet.scale.set(0.12, 0.9, 0.12);
    jet.position.y = 1.75;
    group.add(jet);
  }

  /* ------------------------------------------------------------------------ */
  /* ②-b3 外观三级 LOD（手册 P6）：近全模 / 70m 简化轮廓 / 90m 极简剪影          */
  /* ------------------------------------------------------------------------ */

  _applyExteriorLOD() {
    const S = this._shared;
    const specs = [
      ['Lobby/pumpkin-wheel', S.matPumpkinOrange],
      ['Lobby/coin-corridor', S.matCoinGold],
      ['Lobby/memory-house', S.matNeonViolet],
      ['Lobby/bouncing-arena', S.matNeonCyan],
      ['Lobby/train-station', S.matPillar],
    ];
    this._lodCenters = {};
    this._lods = {};
    for (const [name, mat] of specs) {
      const group = this.root.getObjectByName(name);
      if (!group) continue;
      const lod = DetailLOD.wrap(group, S.geoIco0, S.geoBox, mat);
      this._lodCenters[name.replace('Lobby/', '')] = lod.position.clone();
      this._lods[name.replace('Lobby/', '')] = lod;
    }
  }

  _buildGate() {
    const S = this._shared;
    const gate = new THREE.Group();
    gate.name = 'Lobby/gate';
    gate.position.set(0, 0, 15);
    this.root.add(gate);

    for (const side of [-1, 1]) {
      const x = side * 6.5;
      const pillar = new THREE.Mesh(S.geoCylinder, S.matPillar);
      pillar.name = `Lobby/gate-pillar-${side}`;
      pillar.scale.set(1.1, 12, 1.1);
      pillar.position.set(x, 6, 0);
      pillar.castShadow = true;
      gate.add(pillar);
      this._ball(gate, `gate-orb-${side}`, S.matNeonWarm, 1.25, x, 12.5, 0);
      // 立柱正面的紫色发光竖条
      this._box(gate, `gate-strip-${side}`, S.matNeonViolet, 0.22, 10.6, 0.22, x, 6, 1.15);
    }

    this._box(gate, 'gate-beam', S.matPillar, 15, 1.5, 1.8, 0, 12.4, 0, { shadow: true });
    this._box(gate, 'gate-beam-glow-top', S.matNeonWarm, 15.2, 0.16, 0.2, 0, 13.24, 0.98);
    this._box(gate, 'gate-beam-glow-bottom', S.matNeonWarm, 15.2, 0.16, 0.2, 0, 11.56, 0.98);

    // T06：「游乐园」招牌改为图集文字牌（1 张纹理 / 1 个共享材质，零矩阵方块）。
    // 正/反两块 Mesh 共用同一块 UV 几何，背面文字也不会镜像；两片法线相反，
    // 配合 FrontSide 各自只在本侧可见，不会 z-fighting。
    const signInfo = this._atlasLabelGeometry(GATE_LABEL);
    if (signInfo) {
      const worldW = 10.5;
      const worldH = worldW / signInfo.uv.aspect;
      /* 【六项升级·阶段五】「游乐场」招牌沿 Y 轴下移：原 13.45 高于横梁
       * (y=11.65~13.15) 且 z=0.35 埋在梁体内部，会被门楼塔尖/梁体遮挡。
       * 下移到横梁正面 (y≈11.6 底边、z=1.02 在梁前表面 0.98 之外)，
       * 既醒目又不遮发光条。 */
      const signY = 11.6 + worldH / 2;
      for (const side of [1, -1]) {
        const sign = new THREE.Mesh(signInfo.geo, S.matLabelAtlas);
        sign.name = `Lobby/gate-sign-${side > 0 ? 'front' : 'back'}`;
        sign.position.set(0, signY, 1.02);
        sign.scale.set(worldW, worldH, 1);
        if (side < 0) sign.rotation.y = Math.PI;
        gate.add(sign);
      }
    }

    /* ---------- T09：城堡门楼（哥特尖拱 + 双塔 + 城垛 + 纹章） ----------
     * 全部复用 S 共享几何/材质，零新增 geometry/material/texture；
     * 只加普通 Mesh + 1 个 InstancedMesh（城垛 1 draw call）。
     * 底部通行区与 gate-left/right AABB 完全不动 → 第 7 项触发点分散成果不受影响。 */
    // ① 尖拱：两根斜梁在门洞上方汇成 ∧ 形，中央拱心石（name 含 arch）
    for (const side of [-1, 1]) {
      const arch = this._box(gate, `gate-arch-${side > 0 ? 'right' : 'left'}`,
        S.matCoinGold, 0.5, 5.2, 0.75, side * 2.0, 9.4, 0.12, { shadow: true });
      arch.rotation.z = side * 0.62;
    }
    this._box(gate, 'gate-arch-keystone', S.matNeonWarm, 1.0, 0.9, 0.9, 0, 11.35, 0.12);
    // 纹章：拱内金色盾牌 + 光环
    this._box(gate, 'gate-emblem', S.matCoinGold, 1.35, 1.6, 0.3, 0, 10.15, 0.55);
    const emblemRing = new THREE.Mesh(S.geoTorus, S.matNeonWarm);
    emblemRing.name = 'Lobby/gate-emblem-ring';
    emblemRing.scale.set(1.0, 1.0, 0.1);
    emblemRing.position.set(0, 10.15, 0.75);
    gate.add(emblemRing);
    // ② 双塔：柱身上段加宽成方形塔楼 + 锥顶 + 塔尖宝珠（name 含 tower）
    for (const side of [-1, 1]) {
      const x = side * 6.5;
      this._box(gate, `gate-tower-${side}`, S.matPillar, 2.6, 4.2, 2.6, x, 10.4, 0, { shadow: true });
      const spire = new THREE.Mesh(S.geoCone, S.matNeonViolet);
      spire.name = `Lobby/gate-tower-spire-${side}`;
      spire.scale.set(1.95, 3.4, 1.95);
      spire.position.set(x, 14.3, 0);
      spire.castShadow = true;
      gate.add(spire);
      this._ball(gate, `gate-tower-finial-${side}`, S.matCoinGold, 0.4, x, 16.2, 0);
    }
    // ③ 城垛：横梁上沿两侧各 5 个，避开中央 10.5m 宽的 atlas 招牌
    const crenelXs = [];
    for (let i = 0; i < 5; i += 1) crenelXs.push(-8.4 + i * 0.6, 6.0 + i * 0.6);
    const crenels = new THREE.InstancedMesh(S.geoBox, S.matPillar, crenelXs.length);
    crenels.name = 'Lobby/gate-crenels';
    crenels.castShadow = true;
    const cd = new THREE.Object3D();
    crenelXs.forEach((cx, i) => {
      cd.position.set(cx, 13.7, 0);
      cd.scale.set(0.42, 1.15, 1.5);
      cd.updateMatrix();
      crenels.setMatrixAt(i, cd.matrix);
    });
    crenels.instanceMatrix.needsUpdate = true;
    gate.add(crenels);

    /* ---------- 【M5】皇堡升级：中央主塔 + 侧翼塔 + 尖顶 + 旗帜 ----------
     * 继续复用 S.geoBox / S.geoCone / S.geoCylinder 与既有共享材质，
     * 零新增 geometry / material / texture；重复件一律 InstancedMesh。
     * 所有新增体量都在 y≥12 的门洞上方，AABB 与可通行区域完全不变。 */
    // ① 中央主塔（三层收分 + 尖顶 + 宝珠），塔顶约 24.5m
    this._box(gate, 'gate-keep-base', S.matPillar,
      7.4, 3.4, 3.4, 0, 15.1, 0, { shadow: true });
    this._box(gate, 'gate-keep-mid', S.matPillar,
      5.4, 3.0, 3.0, 0, 18.3, 0, { shadow: true });
    this._box(gate, 'gate-keep-upper', S.matPillar,
      3.8, 2.6, 2.6, 0, 21.1, 0, { shadow: true });
    const keepSpire = new THREE.Mesh(S.geoCone, S.matNeonViolet);
    keepSpire.name = 'Lobby/gate-keep-spire';
    keepSpire.scale.set(2.4, 4.2, 2.4);
    keepSpire.position.set(0, 24.5, 0);
    keepSpire.castShadow = true;
    gate.add(keepSpire);
    this._ball(gate, 'Lobby/gate-keep-finial', S.matCoinGold, 0.65, 0, 27.0, 0);
    // 主塔正面皇家纹章（蓝底 + 金冠 + 暖光宝珠）
    this._box(gate, 'gate-royal-shield', S.matNeonViolet, 2.4, 3.0, 0.35, 0, 17.6, 1.75);
    this._box(gate, 'gate-royal-crown', S.matCoinGold, 2.0, 0.5, 0.42, 0, 19.3, 1.8);
    this._ball(gate, 'gate-royal-jewel', S.matNeonWarm, 0.34, 0, 17.8, 2.0);

    // ② 侧翼塔加高：在 T09 双塔顶再加一层塔身 + 第二道尖顶 + 旗杆旗面
    for (const side of [-1, 1]) {
      const x = side * 6.5;
      this._box(gate, `gate-wing-upper-${side}`, S.matPillar,
        2.0, 2.4, 2.0, x, 15.6, 0, { shadow: true });
      const spire2 = new THREE.Mesh(S.geoCone, S.matNeonViolet);
      spire2.name = `Lobby/gate-wing-spire-${side}`;
      spire2.scale.set(1.5, 2.6, 1.5);
      spire2.position.set(x, 18.3, 0);
      spire2.castShadow = true;
      gate.add(spire2);
      // 旗杆 + 旗面（金色，迎风方向固定，零动画零新建）
      this._box(gate, `gate-flag-pole-${side}`, S.matPillar,
        0.12, 2.2, 0.12, x, 20.4, 0);
      this._box(gate, `gate-flag-banner-${side}`, S.matCoinGold,
        1.3, 0.85, 0.08, x + side * 0.7, 21.1, 0);
    }

    // ③ 门洞上方双层皇冠拱：比 T09 单拱更厚重，且仍在 |x|<4 的上方
    for (const side of [-1, 1]) {
      const crown = this._box(gate, `gate-crown-arch-${side}`, S.matCoinGold,
        0.42, 6.6, 0.9, side * 2.6, 11.0, 0.55, { shadow: true });
      crown.rotation.z = side * 0.5;
    }
    this._box(gate, 'gate-crown-keystone', S.matNeonWarm,
      1.2, 1.0, 1.0, 0, 13.7, 0.55);

    // AABB：只挡两根立柱，中间留出可通行的门洞（M5 皇堡结构全在门洞上部，不改碰撞）
    this._buildingBoxes.push(
      { key: 'gate-left', minX: -7.6 - AABB_PAD, maxX: -5.4 + AABB_PAD, minZ: 15 - 1.2 - AABB_PAD, maxZ: 15 + 1.2 + AABB_PAD },
      { key: 'gate-right', minX: 5.4 - AABB_PAD, maxX: 7.6 + AABB_PAD, minZ: 15 - 1.2 - AABB_PAD, maxZ: 15 + 1.2 + AABB_PAD }
    );
  }

  /* ------------------------------------------------------------------------ */
  /* ④ 南瓜摩天轮设施：真实 10 座舱轮盘 + 浮动粒子                           */
  /*    （旧「南瓜投手」玩法文件 PumpkinThrower.js 保留，但大厅入口已重定向     */
  /*     到 FerrisWheelEmbedView，见 main.js TRIGGER_KEY_ALIASES）            */
  /* ------------------------------------------------------------------------ */

  _buildPumpkinWheel() {
    const S = this._shared;
    const facility = FACILITIES[0];
    const group = new THREE.Group();
    group.name = 'Lobby/pumpkin-wheel';
    group.position.set(facility.x, 0, facility.z);
    this.root.add(group);

    // 基座 + 两根斜支架
    /* 【T09 重要约束】轮组「禁止整体 scale」：FerrisWheelEmbedView.js 硬编码
     * CABIN_COUNT=10 / WHEEL_RADIUS=5.4 / WHEEL_HUB_Y=8.2，并用 Lobby/wheel-spin
     * 的世界变换算座舱相机锚点。若放大 group 或 wheel-spin，玩家会「坐在座舱外」，
     * 直接击穿已验收的 ⑤⑩。故本次只放大不参与锚点计算的基座与支架装饰。 */
    const base = new THREE.Mesh(S.geoCylinder, S.matWheelFrame);
    base.name = 'Lobby/wheel-base';
    base.scale.set(4.3, 0.9, 4.3);
    base.position.y = 0.45;
    base.castShadow = true;
    group.add(base);
    for (const side of [-1, 1]) {
      const brace = this._box(group, `wheel-brace-${side}`, S.matWheelFrame,
        0.42, 8.6, 0.42, side * 2.1, 4.3, 0, { key: facility.key, shadow: true });
      brace.rotation.z = -side * 0.26;
    }

    // 轮组：整体绕 z 轴缓慢旋转（update 中只改 rotation，不新建资源）
    const wheel = new THREE.Group();
    wheel.name = 'Lobby/wheel-spin';
    wheel.position.set(0, FERRIS_HUB_Y, 0);
    group.add(wheel);
    this._wheelGroup = wheel;

    for (const [name, mat, radius] of [
      ['wheel-ring-outer', S.matNeonWarm, FERRIS_WHEEL_RADIUS],
      ['wheel-ring-inner', S.matNeonViolet, 3.9],
    ]) {
      const ring = new THREE.Mesh(S.geoTorus, mat);
      ring.name = `Lobby/${name}`;
      ring.scale.set(radius, radius, radius);
      ring.userData.facilityKey = facility.key;
      wheel.add(ring);
      this._pickables.push(ring);
    }
    for (let i = 0; i < 8; i += 1) {
      const spoke = this._box(wheel, `wheel-spoke-${i}`, S.matWheelFrame,
        0.12, 10.8, 0.12, 0, 0, 0, { key: facility.key });
      spoke.rotation.z = (i * Math.PI) / 8;
    }
    /* T04b-c：10 个真座舱取代原南瓜球。
     * 10 个 Group 只做变换宿主（位置严格落在 R=5.4 圆周，rotation.z 每帧抵消轮盘自转 →
     * 吊篮口永远朝上）；可见部件用 7 个 InstancedMesh，全部复用 S 的共享几何/材质，
     * 零新增 geometry/material/texture。instanceMatrix buffer 由 dispose 的
     * isInstancedMesh 分支成对回收。 */
    this._wheelCabins = [];
    this._wheelCabinParts = [];
    const cabinDummy = new THREE.Object3D();
    const cabinColors = [S.matNeonWarm, S.matNeonViolet, S.matNeonCyan, S.matNeonGold];
    const colorCounts = [0, 0, 0, 0];
    const colorCursor = [0, 0, 0, 0];
    for (let i = 0; i < FERRIS_CABIN_COUNT; i += 1) colorCounts[i % 4] += 1;

    for (let i = 0; i < FERRIS_CABIN_COUNT; i += 1) {
      const a = (i / FERRIS_CABIN_COUNT) * Math.PI * 2;
      const cabin = new THREE.Group();
      cabin.name = `Lobby/wheel-cabin-${i}`;
      // 与 FerrisWheelEmbedView._recomputeAnchor() 完全同式：轮心 + R*(cos,sin,0)
      cabin.position.set(Math.cos(a) * FERRIS_WHEEL_RADIUS, Math.sin(a) * FERRIS_WHEEL_RADIUS, 0);
      cabin.userData.facilityKey = facility.key;
      cabin.userData.cabinIndex = i;
      wheel.add(cabin);
      this._wheelCabins.push(cabin);
    }

    /** 登记一个实例化部件：local 矩阵 init 时算一次，update 只做 cabin.matrix × local */
    const addCabinPart = (name, geo, mat, count, px, py, pz, rx, sx, sy, sz, shadow = false) => {
      const im = new THREE.InstancedMesh(geo, mat, count);
      im.name = `Lobby/${name}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = shadow;
      im.userData.facilityKey = facility.key;
      wheel.add(im);
      this._pickables.push(im);
      cabinDummy.position.set(px, py, pz);
      cabinDummy.rotation.set(rx, 0, 0);
      cabinDummy.scale.set(sx, sy, sz);
      cabinDummy.updateMatrix();
      this._wheelCabinParts.push({
        mesh: im,
        local: cabinDummy.matrix.clone(), // init 期分配一次，非热路径
        slot: new Int8Array(FERRIS_CABIN_COUNT).fill(-1),
      });
      return im;
    };

    // 舱体：暖 / 紫 / 青 / 金四色交替，每色仅 2~3 个实例（紧凑槽位，不浪费）
    // 直径 1.44m ≈ 轮盘半径的 0.27，比旧 0.78m 南瓜球更像可乘坐的吊篮；
    // 相机锚点在舱体几何中心，舱内净空约 0.72m 水平 / 0.7m 顶棚。
    for (let c = 0; c < 4; c += 1) {
      addCabinPart(`wheel-cabin-body-${c}`, S.geoCylinder, cabinColors[c],
        colorCounts[c], 0, 0, 0, 0, 0.72, 1.00, 0.72, true);
    }
    // 地板（银）/ 锥顶棚（金）/ 舷窗环（青，水平放置；半径略大于舱体才露在表面）
    addCabinPart('wheel-cabin-floor', S.geoCylinder, S.matWheelFrame,
      FERRIS_CABIN_COUNT, 0, -0.50, 0, 0, 0.76, 0.12, 0.76);
    addCabinPart('wheel-cabin-roof', S.geoCone, S.matCoinGold,
      FERRIS_CABIN_COUNT, 0, 0.70, 0, 0, 0.82, 0.56, 0.82, true);
    addCabinPart('wheel-cabin-window', S.geoTorus, S.matNeonCyan,
      FERRIS_CABIN_COUNT, 0, -0.22, 0, -Math.PI / 2, 0.74, 0.74, 0.09);
    // 槽位映射：前 4 个部件是四色舱体，后 3 个是每个座舱都有的通用件
    for (let i = 0; i < FERRIS_CABIN_COUNT; i += 1) {
      const c = i % 4;
      this._wheelCabinParts[c].slot[i] = colorCursor[c];
      colorCursor[c] += 1;
      for (let p = 4; p < this._wheelCabinParts.length; p += 1) {
        this._wheelCabinParts[p].slot[i] = i;
      }
    }
    this._syncWheelCabins(); // 首帧前写入矩阵，避免原点出现重叠舱体
    this._ball(wheel, 'wheel-hub', S.matNeonWarm, 1.1, 0, 0, 0, { key: facility.key });

    // 点击代理盒：让「指向设施点击」稳定命中，且不产生任何可见像素
    this._pickProxy(group, facility.key, 13, 15, 13, 0, 7.5, 0);
    // 周围浮动发光粒子（init 建好，update 只改 position attribute）
    this._buildParticleCloud(group, facility.key, 46, S.matParticleWarm,
      { rx: 9, ry: 11, rz: 7, cy: 7 });
    // 设施 AABB（比视觉略小，玩家可站到触发点）
    this._buildingBoxes.push({
      key: facility.key,
      minX: facility.x - 4.5 - AABB_PAD, maxX: facility.x + 4.5 + AABB_PAD,
      minZ: facility.z - 4.5 - AABB_PAD, maxZ: facility.z + 4.5 + AABB_PAD,
    });
  }

  /**
   * T04b-c：座舱自反转保持水平 + 把变换写进 7 个 InstancedMesh。
   * cabin 是 wheel 的子对象，故 cabin.matrix（local to wheel）可直接作为
   * instanceMatrix 的父变换；每个部件的 local 矩阵在 init 时算好，热路径只做
   * 一次 Matrix4.multiplyMatrices + setMatrixAt，零 new。
   */
  _syncWheelCabins() {
    const wheel = this._wheelGroup;
    if (!wheel || this._wheelCabins.length === 0) return;
    const theta = wheel.rotation.z;
    for (let i = 0; i < this._wheelCabins.length; i += 1) {
      const cabin = this._wheelCabins[i];
      cabin.rotation.z = -theta; // 抵消轮盘自转，吊篮口永远朝上
      cabin.updateMatrix();      // 只更新 local matrix，不碰 GPU
    }
    for (let p = 0; p < this._wheelCabinParts.length; p += 1) {
      const part = this._wheelCabinParts[p];
      const mesh = part.mesh;
      for (let i = 0; i < this._wheelCabins.length; i += 1) {
        const slot = part.slot[i];
        if (slot < 0) continue;
        _WHEEL_PART_MATRIX.multiplyMatrices(this._wheelCabins[i].matrix, part.local);
        mesh.setMatrixAt(slot, _WHEEL_PART_MATRIX);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** 不可见点击代理（不写颜色/深度，但 Raycaster 可命中） */
  _pickProxy(parent, key, sx, sy, sz, px, py, pz) {
    const proxy = new THREE.Mesh(this._shared.geoBox, this._shared.matPickProxy);
    proxy.name = `Lobby/pick-proxy-${key}`;
    proxy.scale.set(sx, sy, sz);
    proxy.position.set(px, py, pz);
    proxy.userData.facilityKey = key;
    parent.add(proxy);
    this._pickables.push(proxy);
    return proxy;
  }

  /** 浮动发光粒子云：Points + 预分配 BufferGeometry，绝不在 update 里新建 */
  _buildParticleCloud(parent, key, count, material, { rx, ry, rz, cy = 0, cz = 0 }) {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      // 确定性伪随机，保证每次重建的资源与预热一致
      const r1 = ((i * 9301 + 49297) % 233280) / 233280;
      const r2 = ((i * 4523 + 137) % 233280) / 233280;
      const r3 = ((i * 7919 + 811) % 233280) / 233280;
      positions[i * 3] = (r1 - 0.5) * rx;
      positions[i * 3 + 1] = cy + (r2 - 0.5) * ry;
      positions[i * 3 + 2] = cz + (r3 - 0.5) * rz;
    }
    const geo = this._trackGeometry(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geo, material);
    points.name = `Lobby/particles-${key}`;
    points.frustumCulled = false;
    parent.add(points);
    this._particleClouds.push({
      points, attribute: geo.attributes.position,
      base: Float32Array.from(positions), count,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤ 金币小径设施：无尽发光长廊 + 悬空金币 + 迷雾                          */
  /* ------------------------------------------------------------------------ */

  _buildCoinCorridor() {
    const S = this._shared;
    const facility = FACILITIES[1];
    const group = new THREE.Group();
    group.name = 'Lobby/coin-corridor';
    group.position.set(facility.x, 0, 0); // 沿 -z 延伸
    this.root.add(group);

    // 跑道：长 130 单位，远端被 FogExp2 吞没，视觉上「看不到尽头」
    const track = new THREE.Mesh(S.geoPlane, S.matTrack);
    track.name = 'Lobby/corridor-track';
    track.rotation.x = -Math.PI / 2;
    track.scale.set(7.5, 130, 1);
    track.position.set(0, 0.06, -60);
    track.receiveShadow = true;
    group.add(track);

    for (const side of [-1, 1]) {
      this._box(group, `corridor-rail-${side}`, S.matTrackLine,
        0.22, 0.1, 130, side * 3.85, 0.14, -60, { key: facility.key });
      const post = new THREE.Mesh(S.geoCylinder, S.matPillar);
      post.name = `Lobby/corridor-post-${side}`;
      post.scale.set(0.7, 6, 0.7);
      post.position.set(side * 4.6, 3, 1);
      post.castShadow = true;
      group.add(post);
      this._ball(group, `corridor-orb-${side}`, S.matNeonGold, 0.9, side * 4.6, 6.3, 1,
        { key: facility.key });
    }
    // 节奏光条：每 6 米一道，产生向前延伸的透视节奏
    for (let i = 0; i < 20; i += 1) {
      this._box(group, `corridor-tick-${i}`, S.matNeonGold,
        7.3, 0.03, 0.16, 0, 0.1, -2 - i * 6, { key: facility.key });
    }

    // 两侧一排排悬空发光金币（扁圆柱，圆面朝 ±z，update 中缓慢翻转 / 浮动）
    for (let side of [-1, 1]) {
      for (let i = 0; i < 18; i += 1) {
        const coin = new THREE.Mesh(S.geoCoin, S.matCoinGold);
        coin.name = `Lobby/coin-${side}-${i}`;
        coin.scale.setScalar(0.62);
        coin.rotation.x = Math.PI / 2;
        const baseY = 2.1 + (i % 3) * 0.62;
        coin.position.set(side * 2.7, baseY, -4 - i * 5);
        coin.castShadow = false;
        coin.userData.facilityKey = facility.key;
        group.add(coin);
        this._pickables.push(coin);
        this._coinMeshes.push({ mesh: coin, baseY, phase: i * 0.7 + (side + 1) * 1.3 });
      }
    }

    // 白天不再需要夜间的局部迷雾平面（会在日光下变成白色光斑），
    // 纵深改由真实雾效 FogExp2 + 远处草坡承担。

    this._pickProxy(group, facility.key, 11, 10, 24, 0, 4.5, -8);
    this._buildParticleCloud(group, facility.key, 44, S.matParticleGold,
      { rx: 10, ry: 8, rz: 30, cy: 4.5, cz: -16 });

    // AABB：只挡入口两根门柱，中央跑道可自由走进
    for (const side of [-1, 1]) {
      const cx = facility.x + side * 4.6;
      this._buildingBoxes.push({
        key: `${facility.key}-post-${side}`,
        minX: cx - 0.7 - AABB_PAD, maxX: cx + 0.7 + AABB_PAD,
        minZ: 1 - 0.7 - AABB_PAD, maxZ: 1 + 0.7 + AABB_PAD,
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤-b 记忆翻牌设施：魔法牌屋（悬浮发光牌阵 + 符文基座）                    */
  /* ------------------------------------------------------------------------ */

  _buildMemoryHouse() {
    const S = this._shared;
    const facility = FACILITIES[2];
    const group = new THREE.Group();
    group.name = 'Lobby/memory-house';
    group.position.set(facility.x, 0, facility.z); // 中轴线尽头
    this.root.add(group);

    // 基座：厚圆盘 + 地面符文环，承接「魔法阵」的视觉语义
    const base = new THREE.Mesh(S.geoCylinder, S.matWheelFrame);
    base.name = 'Lobby/memory-base';
    base.scale.set(4.4, 0.55, 4.4);
    base.position.y = 0.28;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const runeRing = new THREE.Mesh(S.geoTorus, S.matNeonViolet);
    runeRing.name = 'Lobby/memory-rune-ring';
    runeRing.rotation.x = -Math.PI / 2;
    runeRing.scale.setScalar(3.3);
    runeRing.position.y = 0.6;
    group.add(runeRing); // 装饰环不做拾取，避免与牌阵抢命中

    // 左右立柱 + 顶部横梁（与另外两处设施相同的金属骨架语言）
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(S.geoCylinder, S.matPillar);
      pillar.name = `Lobby/memory-pillar-${side}`;
      pillar.scale.set(0.72, 7.4, 0.72);
      pillar.position.set(side * 4.2, 3.7, 0);
      pillar.castShadow = true;
      group.add(pillar);
      this._ball(group, `memory-orb-${side}`, S.matNeonViolet, 0.88,
        side * 4.2, 7.7, 0, { key: facility.key });
    }
    this._box(group, 'memory-beam', S.matPillar, 9.6, 0.6, 0.9, 0, 7.7, 0, { shadow: true });
    this._box(group, 'memory-beam-glow', S.matNeonViolet, 9.7, 0.14, 0.9, 0, 7.4, 0);

    // 悬浮牌阵：5 张大小不一的发光卡牌，update 中只改 rotation / position
    const cardSpecs = [
      { x: 0, y: 4.6, z: 0, w: 2.6, h: 3.5, mat: S.matNeonViolet, speed: 0.55, phase: 0 },
      { x: -2.95, y: 3.5, z: 0.35, w: 1.9, h: 2.6, mat: S.matNeonCyan, speed: 0.8, phase: 1.15 },
      { x: 2.95, y: 3.5, z: 0.35, w: 1.9, h: 2.6, mat: S.matNeonGold, speed: 0.8, phase: 1.15 },
      { x: -1.55, y: 6.5, z: -0.55, w: 1.5, h: 2.0, mat: S.matNeonWarm, speed: 1.0, phase: 2.3 },
      { x: 1.55, y: 6.5, z: -0.55, w: 1.5, h: 2.0, mat: S.matNeonViolet, speed: 1.0, phase: 2.3 },
    ];
    for (const spec of cardSpecs) {
      const card = this._box(group, 'memory-card', spec.mat, spec.w, spec.h, 0.16,
        spec.x, spec.y, spec.z, { key: facility.key });
      card.castShadow = false;
      this._memoryCards.push({
        mesh: card, baseY: spec.y, phase: spec.phase, speed: spec.speed,
      });
    }

    // 地面外圈符文（装饰，不做拾取）
    const floorRing = new THREE.Mesh(S.geoTorus, S.matNeonViolet);
    floorRing.name = 'Lobby/memory-floor-ring';
    floorRing.rotation.x = -Math.PI / 2;
    floorRing.scale.setScalar(4.7);
    floorRing.position.y = 0.05;
    group.add(floorRing);

    // 不可见点击代理 + 浮动光点
    this._pickProxy(group, facility.key, 11, 9.6, 5.6, 0, 4.5, 0);
    this._buildParticleCloud(group, facility.key, 40, S.matParticleWarm,
      { rx: 10, ry: 8, rz: 4.6, cy: 4.5 });

    // AABB：只挡建筑本体；触发环（z=-8.5）在建筑前方 2 米，玩家可自由站上去
    this._buildingBoxes.push({
      key: facility.key,
      minX: facility.x - 4.4 - AABB_PAD, maxX: facility.x + 4.4 + AABB_PAD,
      minZ: facility.z - 3.4 - AABB_PAD, maxZ: facility.z + 3.4 + AABB_PAD,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤-d 弹跳碰碰球竞技场（右侧前场 x=26 / z=-2）                              */
  /* ------------------------------------------------------------------------ */
  _buildBouncingArena() {
    const S = this._shared;
    const facility = FACILITIES[3];
    const group = new THREE.Group();
    group.name = 'Lobby/bouncing-arena';
    group.position.set(facility.x, 0, facility.z);
    this.root.add(group);

    // 环形场地基座 + 发光围边（复用共享几何，零新增资源）
    const base = new THREE.Mesh(S.geoCylinder, S.matWheelFrame);
    base.name = 'Lobby/bounce-base';
    base.scale.set(5.4, 0.6, 5.4);
    base.position.y = 0.3;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const rim = new THREE.Mesh(S.geoTorus, S.matTrackLine);
    rim.name = 'Lobby/bounce-rim';
    rim.rotation.x = -Math.PI / 2;
    rim.scale.setScalar(5.25);
    rim.position.y = 0.62;
    group.add(rim); // 装饰环不做拾取

    // 场地内 3 个彩色弹性桩（对应游戏内三种球色）
    const bumperMats = [S.matNeonViolet, S.matNeonWarm, S.matTrackLine];
    const bumperPos = [
      { x: -2.6, z: -1.5 }, { x: 2.6, z: -1.5 }, { x: 0, z: 2.4 },
    ];
    bumperPos.forEach((p, i) => {
      const post = new THREE.Mesh(S.geoCylinder, S.matPillar);
      post.name = `Lobby/bounce-post-${i}`;
      post.scale.set(0.48, 2.2, 0.48);
      post.position.set(p.x, 1.1, p.z);
      post.castShadow = true;
      group.add(post);
      this._ball(group, `bounce-orb-${i}`, bumperMats[i], 0.78, p.x, 2.35, p.z,
        { key: facility.key, shadow: true });
    });

    // 悬浮主球 + 光环：update 里只改 position / rotation
    const mainBall = new THREE.Mesh(S.geoSphere, S.matPumpkinOrange);
    mainBall.name = 'Lobby/bounce-main-ball';
    mainBall.scale.setScalar(1.5);
    mainBall.position.set(0, 5.4, 0);
    mainBall.castShadow = true;
    group.add(mainBall);
    this._bounceBall = mainBall;

    const halo = new THREE.Mesh(S.geoTorus, S.matTrackLine);
    halo.name = 'Lobby/bounce-halo';
    halo.rotation.x = -Math.PI / 2;
    halo.scale.setScalar(2.15);
    halo.position.set(0, 5.4, 0);
    group.add(halo);
    this._bounceHalo = halo;

    // 不可见点击代理 + 浮动光点
    this._pickProxy(group, facility.key, 11, 10, 11, 0, 4.6, 0);
    this._buildParticleCloud(group, facility.key, 36, S.matParticleGold,
      { rx: 9, ry: 7.5, rz: 9, cy: 4.4 });

    // AABB：只挡场地本体；触发环（z=6）在场地外 1.6 米，玩家可自由站上去
    this._buildingBoxes.push({
      key: facility.key,
      minX: facility.x - 5.4 - AABB_PAD, maxX: facility.x + 5.4 + AABB_PAD,
      minZ: facility.z - 5.4 - AABB_PAD, maxZ: facility.z + 5.4 + AABB_PAD,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤-d 小火车站台：方块拼搭 + 发光柱（第五个可进入设施）                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 站台完全由共享几何体拼搭，不新增任何 geometry / material / texture，
   * 因此热基线与四个既有设施保持一致：
   *   · 金属件（立柱 / 包边 / 顶棚 / 车轮） matPillar、matWheelFrame（metalness=1）
   *   · 非金属件（台基 / 枕木）             matTrack（metalness=0，石材纹理）
   *   · 发光件（檐灯 / 站前柱灯 / 站牌）      matNeonWarm / matNeonGold / matNeonViolet
   * 位置 x=-26 / z=-2，与右侧「弹跳竞技场」对称，不压左侧引导线（x≤-13）；
   * AABB 只包住站台本体，触发环在 z=6（台基前方），站上去不受阻挡。
   */
  _buildTrainStation() {
    const S = this._shared;
    const facility = FACILITIES[4];
    const group = new THREE.Group();
    group.name = 'Lobby/train-station';
    group.position.set(facility.x, 0, facility.z);
    // 【T09】站台整体放大；pickProxy / 小火车 / 轨道是 group 子对象，自动等比。
    // AABB 同步 5.3→6.36、3.0→3.6（见下方）。站台位于 x=-26 开阔处，不与邻设施重叠。
    group.scale.set(1.2, 1.3, 1.2);
    this.root.add(group);

    // 台基（非金属石材）+ 前后金属包边
    this._box(group, 'station-deck', S.matTrack, 10.6, 0.52, 6.0, 0, 0.26, 0,
      { key: facility.key, shadow: true });
    this._box(group, 'station-trim-front', S.matPillar, 10.7, 0.14, 0.22, 0, 0.55, 3.0);
    this._box(group, 'station-trim-back', S.matPillar, 10.7, 0.14, 0.22, 0, 0.55, -3.0);

    // 四根金属立柱 + 金属顶棚
    for (const sx of [-4.5, 4.5]) {
      for (const sz of [-2.6, 2.6]) {
        const col = new THREE.Mesh(S.geoCylinder, S.matPillar);
        col.name = `Lobby/station-column-${sx}-${sz}`;
        col.scale.set(0.28, 4.7, 0.28);
        col.position.set(sx, 2.75, sz);
        col.castShadow = true;
        col.receiveShadow = true;
        group.add(col);
      }
    }
    this._box(group, 'station-canopy', S.matWheelFrame, 11.2, 0.3, 6.6, 0, 5.25, 0,
      { shadow: true });
    // 檐灯：不铺满长条（10.9m 连续自发光在 Bloom 下会糊成一条白带），
    // 改成一排小灯珠，既保留「站台灯带」的工业感，又不把站台糊白
    for (const lx of [-4.2, -2.5, -0.8, 0.8, 2.5, 4.2]) {
      this._box(group, `station-eave-${lx}`, S.matNeonWarm, 0.9, 0.09, 0.14, lx, 5.06, 3.22);
    }

    // 顶棚吊灯（暖光球）
    for (const lx of [-2.6, 2.6]) {
      this._ball(group, `station-lamp-${lx}`, S.matNeonWarm, 0.26, lx, 4.86, 0,
        { key: facility.key });
    }

    // 站前发光柱（三根，远近都能一眼认出入口）
    for (const px of [-3.8, 0, 3.8]) {
      const post = new THREE.Mesh(S.geoCylinder, S.matPillar);
      post.name = `Lobby/station-post-${px}`;
      post.scale.set(0.09, 3.2, 0.09);
      post.position.set(px, 1.9, 3.45);
      post.castShadow = true;
      group.add(post);
      this._ball(group, `station-post-orb-${px}`, S.matNeonGold, 0.24, px, 3.7, 3.45,
        { key: facility.key });
    }

    // 台面上的轨道：两条金属轨 + 六根枕木
    for (const rx of [-1.35, 1.35]) {
      this._box(group, `station-rail-${rx}`, S.matPillar, 0.16, 0.12, 5.4, rx, 0.64, 0);
    }
    for (let i = 0; i < 6; i += 1) {
      this._box(group, `station-tie-${i}`, S.matTrack, 1.9, 0.1, 0.26, 0, 0.58, -2.2 + i * 0.88);
    }

    // T07：整列车（车体 / 驾驶室 / 车窗 / 烟囱 / 车轮）挂到独立 Group，
    // 以车体中心为原点做站台往返 + 到头平滑掉头；update 只改 position.z / rotation.y。
    const train = new THREE.Group();
    train.name = 'Lobby/station-train';
    train.position.set(0, 0, LOBBY_TRAIN_BASE_Z);
    group.add(train);
    this._stationTrain = train;
    this._stationTrainWheels = [];
    // 原站台坐标 → 以车体中心为原点的局部坐标
    const tz = -LOBBY_TRAIN_BASE_Z;
    const trainBox = (name, mat, sx, sy, sz, px, py, pz, opt = {}) =>
      this._box(train, name, mat, sx, sy, sz, px, py, pz + tz, opt);

    trainBox('station-train-body', S.matPumpkinOrange, 1.5, 0.9, 2.5, 0, 1.16, -0.3,
      { key: facility.key, shadow: true });
    trainBox('station-train-cab', S.matCoinGold, 1.3, 0.72, 1.0, 0, 1.85, -1.0,
      { key: facility.key, shadow: true });
    trainBox('station-train-window', S.matNeonCyan, 1.34, 0.34, 0.62, 0, 1.9, -1.0);
    trainBox('station-train-stack', S.matPillar, 0.3, 0.6, 0.3, 0, 1.55, 0.78);
    for (const wx of [-0.8, 0.8]) {
      const wheel = new THREE.Mesh(S.geoCylinder, S.matPillar);
      wheel.name = `Lobby/station-wheel-${wx}`;
      wheel.rotation.z = Math.PI / 2;
      wheel.scale.set(0.3, 0.16, 0.3);
      wheel.position.set(wx, 0.78, 0.1 + tz);
      wheel.castShadow = true;
      train.add(wheel);
      this._stationTrainWheels.push(wheel);
    }

    // 站名牌（紫色发光块）+ 不可见点击代理 + 浮动光点
    this._box(group, 'station-sign', S.matNeonViolet, 4.2, 0.7, 0.14, 0, 4.1, 3.14);
    this._pickProxy(group, facility.key, 11.4, 6.2, 7.2, 0, 2.9, 0);
    this._buildParticleCloud(group, facility.key, 24, S.matParticleWarm,
      { rx: 5.0, ry: 4.6, rz: 3.2, cy: 3.2 });

    this._buildingBoxes.push({
      key: facility.key,
      // T09：与 group.scale.x/z = 1.2 同步（5.3×1.2=6.36、3.0×1.2=3.6）
      minX: facility.x - 6.36 - AABB_PAD, maxX: facility.x + 6.36 + AABB_PAD,
      minZ: facility.z - 3.6 - AABB_PAD, maxZ: facility.z + 3.6 + AABB_PAD,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* ⑤-b 实体化外观：40m 过山车 / 设施立面 / 围栏 / 街道氛围                  */
  /*   性能约定：一律用 InstancedMesh + _shared 里已登记的几何与材质，
   *   不新增任何 geometry / material / texture，因此热基线 17/24 不变、
   *   draw call 增量只有每个 InstancedMesh 一次。                              */
  /* ------------------------------------------------------------------------ */

  /**
   * 通用实例化构建器。未写入的实例先初始化为极小尺度，
   * 避免零矩阵实例意外堆在原点。
   */
  _instanced(name, geo, mat, count, { shadow = false, key = null } = {}) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = `Lobby/${name}`;
    mesh.castShadow = shadow;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // 实例散布整座广场，包围盒不可靠
    if (key) mesh.userData.facilityKey = key;
    this.root.add(mesh);
    const dummy = new THREE.Object3D();
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, dummy.matrix);
    return mesh;
  }

  _flushInstances(meshes) {
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 40m 盘旋高架轨道：与 TrainRide 同一条 24 点闭合 lemniscate 曲线，
   * 三组 InstancedMesh（双轨 / 枕木 / 落地桥墩）共 3 个 draw call。
   * 高架桥墩落在地面，但轨道本体在空中，因此 AABB 只用于触发、不阻挡行走。
   */
  _buildCoasterTrack() {
    const S = this._shared;
    const key = FACILITIES[4].key; // train-ride
    const points = COASTER.heights.map((h, i) => {
      const a = (i / COASTER.heights.length) * Math.PI * 2;
      return new THREE.Vector3(
        COASTER.cx + COASTER.lobeA * Math.sin(a),
        h,
        COASTER.cz + COASTER.lobeB * Math.sin(a) * Math.cos(a)
      );
    });
    const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.5);
    curve.arcLengthDivisions = 400;
    // T08：把同一条曲线存下来供 CoasterCarRuntime 挂轨，天然与实际轨道一致
    this._coasterCurve = curve;
    // T08：复用同一 curve 引用建挂轨小车，天然与轨道 100% 一致（接法①，零同步风险）
    this._coasterCars = new CoasterCarRuntime({ curve: this._coasterCurve, carCount: 3, period: 42 });
    this._coasterCars.init(this.root);
    const length = curve.getLength();

    const railSegments = Math.max(2, Math.round(length / 1.5));
    const tieCount = Math.max(2, Math.round(length / 3.0));
    const pillarCount = Math.max(2, Math.round(length / 6.5));

    const rails = this._instanced('coaster-rails', S.geoBox, S.matPumpkinOrange, railSegments * 2);
    const ties = this._instanced('coaster-ties', S.geoBox, S.matCoinGold, tieCount);
    const pillars = this._instanced('coaster-pillars', S.geoBox, S.matPillar, pillarCount);

    const dummy = new THREE.Object3D();
    const pos = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const quat = new THREE.Quaternion();
    const segLen = length / railSegments;

    let ri = 0;
    for (let i = 0; i < railSegments; i += 1) {
      const t = i / railSegments;
      curve.getPointAt(t, pos);
      curve.getTangentAt(t, tan).normalize();
      quat.setFromUnitVectors(zAxis, tan);
      right.crossVectors(tan, up);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0); // 陡坡处切线接近竖直的兜底
      right.normalize();
      for (const side of [-1, 1]) {
        dummy.position.copy(pos).addScaledVector(right, side * 0.9);
        dummy.quaternion.copy(quat);
        dummy.scale.set(0.44, 0.34, segLen * 1.08);
        dummy.updateMatrix();
        rails.setMatrixAt(ri, dummy.matrix);
        ri += 1;
      }
    }
    for (let i = 0; i < tieCount; i += 1) {
      const t = i / tieCount;
      curve.getPointAt(t, pos);
      curve.getTangentAt(t, tan).normalize();
      quat.setFromUnitVectors(zAxis, tan);
      dummy.position.copy(pos);
      dummy.quaternion.copy(quat);
      dummy.scale.set(2.4, 0.34, 0.46);
      dummy.updateMatrix();
      ties.setMatrixAt(i, dummy.matrix);
    }
    for (let i = 0; i < pillarCount; i += 1) {
      curve.getPointAt(i / pillarCount, pos);
      const h = Math.max(0.4, pos.y - 0.5);
      dummy.position.set(pos.x, h / 2, pos.z);
      dummy.quaternion.identity();
      dummy.scale.set(1.25, h, 1.25);
      dummy.updateMatrix();
      pillars.setMatrixAt(i, dummy.matrix);
    }
    this._flushInstances([rails, ties, pillars]);

    // 交互：大范围点击代理 + 只用于距离触发的 AABB（高架下方依旧可通行）
    // 点击代理只覆盖轨道所在的远侧空域（z∈[-36,-16]、x∈[-38,-6]），
    // 既罩住高架轨道，又不横在南瓜摩天轮 / 牌屋前面抢射线。
    this._pickProxy(this.root, key,
      COASTER.lobeA * 2 - 8, 42, 20,
      COASTER.cx, 20, COASTER.cz);
    this._buildingBoxes.push({
      key,
      // 按轨道实际占地收边（不是整个 lobe 直径），避免在牌屋附近误提示高空环游
      minX: COASTER.cx - COASTER.lobeA - 2, maxX: COASTER.cx + COASTER.lobeA - 8,
      minZ: COASTER.cz - COASTER.lobeB * 0.5 - 2,
      maxZ: COASTER.cz + COASTER.lobeB * 0.5 + 2,
      noBlock: true,
    });
    console.info(`[Lobby] 过山车实体 | 轨长 ${length.toFixed(1)}m | 最高 40m | ` +
      `实例 ${railSegments * 2 + tieCount + pillarCount} 个 / 3 draw call`);
  }

  /** 设施立面：巨型南瓜标志 + 魔法帐篷与悬浮卡牌阵 */
  _buildFacilityFacades() {
    const S = this._shared;
    const pumpkin = FACILITIES[0];
    const memory = FACILITIES[2];

    // ① 摩天轮顶端：巨型南瓜（球体 + 8 条瓜棱 + 瓜蒂），一眼认出「南瓜投手」
    const gourd = this._ball(this.root, 'facade-giant-pumpkin',
      S.matPumpkinOrange, 2.7, pumpkin.x, 16.8, pumpkin.z,
      { key: pumpkin.key, shadow: true });
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      const rib = this._box(this.root, `facade-pumpkin-rib-${i}`, S.matPumpkinViolet,
        0.2, 4.9, 0.2,
        pumpkin.x + Math.cos(a) * 2.2, 16.8, pumpkin.z + Math.sin(a) * 2.2,
        { key: pumpkin.key });
      rib.rotation.z = 0.12;
    }
    this._box(this.root, 'facade-pumpkin-stem', S.matBark,
      0.5, 1.1, 0.5, pumpkin.x, 19.8, pumpkin.z, { key: pumpkin.key });

    // ② 魔法帐篷：锥顶 + 底座 + 8 根发光帐柱 + 顶旗
    const tent = new THREE.Group();
    tent.name = 'Lobby/facade-magic-tent';
    tent.position.set(memory.x, 0, memory.z);
    this.root.add(tent);
    const roof = new THREE.Mesh(S.geoCone, S.matNeonViolet);
    roof.name = 'Lobby/tent-roof';
    roof.scale.set(7.6, 6.4, 7.6);
    roof.position.y = 8.2;
    roof.castShadow = true;
    roof.userData.facilityKey = memory.key;
    tent.add(roof);
    this._pickables.push(roof);
    this._box(tent, 'tent-base', S.matWheelFrame, 15.2, 0.6, 15.2, 0, 1.0, 0,
      { key: memory.key, shadow: true });
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      this._box(tent, `tent-pole-${i}`, S.matNeonCyan, 0.42, 5.6, 0.42,
        Math.cos(a) * 7.0, 4.4, Math.sin(a) * 7.0, { key: memory.key });
    }
    this._box(tent, 'tent-flagpole', S.matPillar, 0.16, 3.2, 0.16, 0, 12.6, 0);
    this._box(tent, 'tent-flag', S.matNeonGold, 1.8, 0.9, 0.1, 0.95, 13.4, 0,
      { key: memory.key });

    // ③ 悬浮卡牌阵：复用牌屋已有的浮动动画台账，不新增 update 逻辑
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      const card = this._box(tent, `tent-card-${i}`,
        i % 2 === 0 ? S.matCoinGold : S.matNeonCyan,
        1.5, 2.1, 0.14, Math.cos(a) * 9.2, 5.2, Math.sin(a) * 9.2,
        { key: memory.key });
      card.rotation.y = a;
      this._memoryCards.push({ mesh: card, baseY: card.position.y, phase: i * 0.9, speed: 0.8 + i * 0.1 });
    }
    this._pickProxy(tent, memory.key, 20, 15, 20, 0, 7, 0);
    this._buildingBoxes.push({
      key: memory.key,
      minX: memory.x - 8.4, maxX: memory.x + 8.4,
      minZ: memory.z - 8.4, maxZ: memory.z + 8.4,
      noBlock: true, // 帐篷是「可穿行的开放门廊」，边缘靠近即可触发
    });
  }

  /** 金币长廊 / 碰碰球竞技场：实例化围栏立柱 + 顶球 + 横杆 */
  _buildArenaFences() {
    const S = this._shared;
    const posts = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 10; i += 1) {
        posts.push({ x: FACILITIES[1].x + side * 4.6, z: 2 - i * 4.5 });
      }
    }
    const ringCount = 24;
    for (let i = 0; i < ringCount; i += 1) {
      const a = (i / ringCount) * Math.PI * 2;
      posts.push({ x: FACILITIES[3].x + Math.cos(a) * 7.0, z: FACILITIES[3].z + Math.sin(a) * 7.0 });
    }
    const postIM = this._instanced('arena-fence-post', S.geoCylinder, S.matPillar, posts.length);
    const capIM = this._instanced('arena-fence-cap', S.geoSphere, S.matNeonGold, posts.length);
    const railIM = this._instanced('arena-fence-rail', S.geoBox, S.matTrackLine, ringCount + 2);
    const dummy = new THREE.Object3D();
    posts.forEach((p, i) => {
      dummy.position.set(p.x, 0.75, p.z);
      dummy.quaternion.identity();
      dummy.scale.set(0.14, 1.5, 0.14);
      dummy.updateMatrix();
      postIM.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, 1.6, p.z);
      dummy.scale.setScalar(0.22);
      dummy.updateMatrix();
      capIM.setMatrixAt(i, dummy.matrix);
    });
    // 环形横杆：相邻两柱连线
    for (let i = 0; i < ringCount; i += 1) {
      const a = (i / ringCount) * Math.PI * 2;
      const b = ((i + 1) / ringCount) * Math.PI * 2;
      const x1 = FACILITIES[3].x + Math.cos(a) * 7.0, z1 = FACILITIES[3].z + Math.sin(a) * 7.0;
      const x2 = FACILITIES[3].x + Math.cos(b) * 7.0, z2 = FACILITIES[3].z + Math.sin(b) * 7.0;
      const dx = x2 - x1, dz = z2 - z1;
      dummy.position.set((x1 + x2) / 2, 1.1, (z1 + z2) / 2);
      dummy.rotation.set(0, Math.atan2(dx, dz), 0);
      dummy.quaternion.setFromEuler(dummy.rotation);
      dummy.scale.set(0.12, 0.12, Math.hypot(dx, dz) * 1.04);
      dummy.updateMatrix();
      railIM.setMatrixAt(i, dummy.matrix);
    }
    // 长廊两侧连续横杆
    for (let s = 0; s < 2; s += 1) {
      dummy.position.set(FACILITIES[1].x + (s === 0 ? -4.6 : 4.6), 1.1, -18);
      dummy.rotation.set(0, 0, 0);
      dummy.quaternion.identity();
      dummy.scale.set(0.12, 0.12, 42);
      dummy.updateMatrix();
      railIM.setMatrixAt(ringCount + s, dummy.matrix);
    }
    this._flushInstances([postIM, capIM, railIM]);
  }

  /**
   * M10 两个新设施的大厅实体外观（童话 / 奇幻风升级版）。
   * 严格零新增 geometry / material / texture —— 全部复用 _shared，
   * 因此热基线 17/24 不变；重复部件一律 InstancedMesh，draw call 不升反降。
   */
  /**
   * 【模块 8】大厅里的天津世纪钟地标。
   * 与可进入设施共用 buildClockTower()，保证「大厅看到的」与「进去看到的」
   * 是同一座钟；scale 0.62 让它与 40m 过山车、11m 摩天轮的比例协调。
   * 所有 geometry/material/texture 都登记进 Lobby 台账，dispose 统一释放。
   */
  _buildCenturyClockFacade() {
    const f = FACILITIES.find((x) => x.key === 'century-clock');
    if (!f) return;
    const tower = buildClockTower({
      scale: 0.62,
      track: {
        geo: (g) => this._trackGeometry(g),
        mat: (m) => this._trackMaterial(m),
        tex: (t) => this._trackTexture(t),
      },
    });
    tower.root.position.set(f.x, 0, f.z);
    tower.root.rotation.y = -0.42; // 钟面略转向大门方向，一进门就能看到表盘
    this.root.add(tower.root);
    this._clockTower = tower;

    // 点击代理 + 建筑 AABB（NPC 避障 / 玩家阻挡共用）
    this._pickProxy(this.root, f.key, 6.4, 10, 6.4, f.x, 5, f.z);
    this._buildingBoxes.push({
      key: f.key,
      minX: f.x - 3.1, maxX: f.x + 3.1,
      minZ: f.z - 3.1, maxZ: f.z + 3.1,
    });
    console.info('[Lobby] 模块8 世纪钟地标已建入大厅（与设施内共用同一造型）');
  }

  /**
   * 【模块 7/8】烟花观礼台的大厅外观：一组发射筒 + 圆台 + 霓虹环，
   * 避免它在大厅里只剩一个孤零零的触发环。全部复用共享几何与材质。
   */
  _buildFireworksDeckFacade() {
    const f = FACILITIES.find((x) => x.key === 'fireworks-deck');
    if (!f) return;
    const S = this._shared;
    const group = new THREE.Group();
    group.name = 'Lobby/facade-fireworks-deck';
    group.position.set(f.x, 0, f.z);
    this.root.add(group);

    const deck = this._box(group, 'fw-deck', S.matPillar,
      7.4, 0.5, 7.4, 0, 0.25, 0);
    deck.userData.facilityKey = f.key;
    this._pickables.push(deck);
    const rim = new THREE.Mesh(S.geoTorus, S.matNeonCyan);
    rim.name = 'Lobby/fw-deck-rim';
    rim.rotation.x = Math.PI / 2;
    rim.scale.set(4.1, 4.1, 0.14);
    rim.position.y = 0.55;
    group.add(rim);

    // 6 根斜置发射筒（共享圆柱几何，1 个 InstancedMesh）
    const tubes = new THREE.InstancedMesh(S.geoCylinder, S.matNeonGold, 6);
    tubes.name = 'Lobby/fw-deck-tubes';
    tubes.frustumCulled = false;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 2.3, 1.15, Math.sin(a) * 2.3);
      dummy.rotation.set(0, 0, -Math.cos(a) * 0.18);
      dummy.scale.set(0.22, 1.9, 0.22);
      dummy.updateMatrix();
      tubes.setMatrixAt(i, dummy.matrix);
    }
    tubes.instanceMatrix.needsUpdate = true;
    tubes.userData.facilityKey = f.key;
    this._pickables.push(tubes);
    group.add(tubes);

    this._buildingBoxes.push({
      key: f.key,
      minX: f.x - 3.6, maxX: f.x + 3.6,
      minZ: f.z - 3.6, maxZ: f.z + 3.6,
    });
  }

  _buildM9Facades() {
    const S = this._shared;
    const dummy = new THREE.Object3D();

    // 【模块 8 修正】不能再用 FACILITIES.slice(5)：新增「烟花观礼台 / 世纪钟」
    // 后会被这个 else 分支误建成一艘海盗船。显式白名单只处理两个 M9 设施，
    // 新设施由各自的 _buildXxxFacade() 负责外观。
    const M9_FACADE_KEYS = new Set(['carousel', 'pirate-ship']);
    for (const f of FACILITIES.filter((x) => M9_FACADE_KEYS.has(x.key))) {
      const group = new THREE.Group();
      group.name = `Lobby/facade-${f.key}`;
      group.position.set(f.x, 0, f.z);
      // 【T09】外观按真实比例放大（用户「海盗船显得太小」）。触发环是独立对象、
      // 坐标不动 → 第 7 项的 7.0m 间距与 _assertTriggerSpacing() 自检保持 0 告警。
      // pickProxy / 粒子云是 group 子对象，随 scale 自动等比放大，无需单独改；
      // 2D AABB 半宽 3.4 → 4.25 同步（见下方）。T07 摆动横幅 ×1.25≈3.95m 仍落在框内。
      group.scale.set(1.25, 1.35, 1.25);
      this.root.add(group);

      /** 单件：用共享几何 + 变换拼一个部件（parent 默认立面 group，T07 动效可改挂 pivot） */
      const part = (name, geo, mat, scale, pos, { rot = null, pick = false, parent = group } = {}) => {
        const m = new THREE.Mesh(geo, mat);
        m.name = `Lobby/${f.key}-${name}`;
        m.scale.set(...scale);
        m.position.set(...pos);
        if (rot) m.rotation.set(...rot);
        m.castShadow = true;
        m.receiveShadow = true;
        if (pick) { m.userData.facilityKey = f.key; this._pickables.push(m); }
        parent.add(m);
        return m;
      };
      /** 批量件：同类部件合并成一个 InstancedMesh（1 draw call） */
      const inst = (name, geo, mat, list, { pick = false, parent = group } = {}) => {
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        im.name = `Lobby/${f.key}-${name}`;
        im.castShadow = true;
        im.frustumCulled = false;
        if (pick) im.userData.facilityKey = f.key;
        list.forEach((t, i) => {
          dummy.position.set(...t.p);
          dummy.rotation.set(...(t.r || [0, 0, 0]));
          dummy.scale.set(...(t.s || [1, 1, 1]));
          dummy.updateMatrix();
          im.setMatrixAt(i, dummy.matrix);
        });
        im.instanceMatrix.needsUpdate = true;
        if (pick) this._pickables.push(im);
        parent.add(im);
        return im;
      };

      if (f.key === 'carousel') {
        /* ---------- 梦幻旋转木马：双层帐篷顶 + 金檐 + 灯泡 + 胶囊木马 ----------
         * T07：所有可见部件挂到 spin Group，update 只改它的 rotation.y（零 new）。
         * 圆盘/圆环/锥顶外观旋转不可见，但木马与灯泡会绕中轴真实转起来。 */
        const spin = new THREE.Group();
        spin.name = 'Lobby/facade-carousel-spin';
        group.add(spin);
        this._carouselFacadeSpin = spin;
        const sp = { parent: spin };
        part('deck', S.geoCylinder, S.matWheelFrame, [3.3, 0.38, 3.3], [0, 0.72, 0], sp);
        part('deck-gold-rim', S.geoTorus, S.matCoinGold, [3.35, 3.35, 0.14], [0, 0.92, 0], { ...sp, rot: [Math.PI / 2, 0, 0] });
        part('pole', S.geoCylinder, S.matNeonViolet, [0.32, 4.3, 0.32], [0, 2.85, 0], sp);
        // 柱身三道金环，模拟马赛克镜面柱的分节
        inst('pole-rings', S.geoTorus, S.matCoinGold,
          [1.05, 2.85, 4.65].map((y) => ({ p: [0, y, 0], r: [Math.PI / 2, 0, 0], s: [0.42, 0.42, 0.10] })), sp);
        // 双层马戏团帐篷顶（下宽上尖）+ 金色檐口
        part('canopy-low', S.geoCone, S.matNeonWarm, [3.75, 1.55, 3.75], [0, 5.15, 0], { ...sp, pick: true });
        part('canopy-crown', S.geoCone, S.matNeonViolet, [2.05, 1.25, 2.05], [0, 6.35, 0], sp);
        part('finial', S.geoSphere, S.matCoinGold, [0.3, 0.3, 0.3], [0, 7.05, 0], sp);
        part('eave', S.geoTorus, S.matCoinGold, [3.72, 3.72, 0.13], [0, 4.42, 0], { ...sp, rot: [Math.PI / 2, 0, 0] });
        // 檐口下 24 盏暖光灯泡（1 个 InstancedMesh）
        inst('bulbs', S.geoSphere, S.matNeonGold,
          Array.from({ length: 24 }, (_, i) => {
            const a = (i / 24) * Math.PI * 2;
            return { p: [Math.cos(a) * 3.74, 4.24, Math.sin(a) * 3.74], s: [0.13, 0.13, 0.13] };
          }), sp);
        // 8 匹低多边形胶囊木马：身体 / 头 / 支杆各 1 个 InstancedMesh
        const horses = Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return { x: Math.cos(a) * 2.65, z: Math.sin(a) * 2.65, a };
        });
        inst('horse-bodies', S.geoIco0, S.matNeonWarm,
          horses.map((h) => ({ p: [h.x, 1.62, h.z], r: [0, -h.a, 0], s: [0.46, 0.36, 0.68] })), { ...sp, pick: true });
        inst('horse-heads', S.geoIco0, S.matNeonCyan,
          horses.map((h) => ({ p: [h.x - Math.sin(h.a) * 0.44, 1.95, h.z - Math.cos(h.a) * 0.44], s: [0.24, 0.30, 0.28] })), sp);
        inst('horse-rods', S.geoCylinder, S.matPillar,
          horses.map((h) => ({ p: [h.x, 2.95, h.z], s: [0.045, 3.4, 0.045] })), sp);
      } else {
        /* ---------- 奇幻海盗船：拱门塔 + 圆润船体 + 发光舷窗 + 帆缆 ----------
         * T07：pivot 放在 axle 高度 (0,7.35,0)，其下 swing 反向平移 -7.35，
         * 于是所有摆动部件仍可沿用原立面坐标；update 只改 pivot.rotation.z。 */
        const pivot = new THREE.Group();
        pivot.name = 'Lobby/facade-pirate-ship-pivot';
        pivot.position.set(0, 7.35, 0);
        group.add(pivot);
        const swing = new THREE.Group();
        swing.name = 'Lobby/facade-pirate-ship-swing';
        swing.position.set(0, -7.35, 0);
        pivot.add(swing);
        this._pirateFacadePivot = pivot;
        const sw = { parent: swing };

        // 4 根圆柱立柱（比原来的方柱柔和）+ 2 根横梁 —— 支架固定，不摆
        inst('tower-columns', S.geoCylinder, S.matPillar,
          [-2.1, 2.1].flatMap((z) => [-2.0, 2.0].map((x) => ({ p: [x, 3.5, z], s: [0.34, 7.0, 0.34] }))));
        inst('tower-beams', S.geoCylinder, S.matPillar,
          [-2.1, 2.1].map((z) => ({ p: [0, 7.0, z], r: [0, 0, Math.PI / 2], s: [0.22, 4.6, 0.22] })));
        // 两座金色拱门（完整 Torus 竖立，视觉上像古老圆拱）
        inst('tower-arches', S.geoTorus, S.matCoinGold,
          [-2.1, 2.1].map((z) => ({ p: [0, 5.4, z], s: [2.05, 2.05, 0.20] })));
        part('axle', S.geoCylinder, S.matWheelFrame, [0.24, 4.5, 0.24], [0, 7.35, 0], { rot: [Math.PI / 2, 0, 0] });
        // 以下全部挂在 swing 下，绕轴心摆动
        part('hanger', S.geoCylinder, S.matPillar, [0.085, 4.2, 0.085], [0, 5.15, 0], sw);
        // 平滑船体：拉长压扁的球 + 弧形金撞角（不再是方盒子）
        part('hull', S.geoSphere, S.matBark, [2.9, 0.62, 1.06], [0, 2.55, 0], { ...sw, pick: true });
        part('deck', S.geoCylinder, S.matBark, [2.55, 0.09, 0.88], [0, 3.02, 0], sw);
        part('ram', S.geoCone, S.matCoinGold, [0.62, 1.35, 0.62], [3.05, 2.72, 0], { ...sw, rot: [0, 0, -Math.PI / 2 - 0.35] });
        part('gold-rim', S.geoTorus, S.matCoinGold, [2.72, 0.95, 0.10], [0, 2.80, 0], { ...sw, rot: [Math.PI / 2, 0, 0] });
        // 错落船尾舱室 + 红顶
        part('cabin-1', S.geoBox, S.matBark, [0.95, 0.72, 1.15], [-1.85, 3.38, 0], sw);
        part('cabin-2', S.geoBox, S.matBark, [0.62, 0.52, 0.82], [-2.35, 3.98, 0], sw);
        part('roof-1', S.geoCone, S.matPumpkinViolet, [0.82, 0.48, 0.92], [-1.85, 3.98, 0], sw);
        part('roof-2', S.geoCone, S.matPumpkinViolet, [0.55, 0.38, 0.62], [-2.35, 4.42, 0], sw);
        // 桅杆 + 鼓帆（两个交叉平面，避免单面剔除）+ 红旗
        part('mast', S.geoCylinder, S.matBark, [0.09, 2.9, 0.09], [0, 4.45, 0], sw);
        part('sail', S.geoPlane, S.matNeonWarm, [1.85, 1.45, 1], [0, 4.85, 0.02], { ...sw, pick: true });
        part('sail-side', S.geoPlane, S.matNeonWarm, [1.85, 1.45, 1], [0, 4.85, 0.02], { ...sw, rot: [0, Math.PI / 2, 0] });
        part('flag', S.geoPlane, S.matPumpkinOrange, [0.72, 0.42, 1], [0.38, 5.82, 0.02], sw);
        // 6 个发光舷窗 + 4 盏提灯（各 1 个 InstancedMesh）
        inst('portholes', S.geoTorus, S.matCoinGold,
          [-1.6, 0, 1.6].flatMap((x) => [1.0, -1.0].map((z) => ({ p: [x, 2.62, z], r: [0, Math.PI / 2, 0], s: [0.19, 0.19, 0.06] }))), sw);
        inst('lanterns', S.geoSphere, S.matNeonGold,
          [-1.9, 1.9].flatMap((x) => [1.0, -1.0].map((z) => ({ p: [x, 3.18, z], s: [0.13, 0.13, 0.13] }))), sw);
      }

      // 点击代理 + 距离触发 AABB（框收在外观内，触发环 z=2 留在框外可站立）
      this._pickProxy(group, f.key, 9.5, 9, 9.5, 0, 4, 0);
      this._buildingBoxes.push({
        key: f.key,
        // T09：与 group.scale.x/z = 1.25 同步（3.4 × 1.25 = 4.25）
        minX: f.x - 4.25, maxX: f.x + 4.25,
        minZ: f.z - 4.25, maxZ: f.z + 4.25,
      });
    }
    console.info('[Lobby] M10 设施外观（童话木马 / 奇幻海盗船）已建入大厅');
  }

  /** 街道氛围：道路两旁批量长椅 / 复古路灯 / 垃圾桶 / 指示路牌 */
  _buildStreetProps() {
    const S = this._shared;
    const zones = this._exclusionZones();
    const dummy = new THREE.Object3D();
    const MAX = 12;
    const seat = this._instanced('street-bench-seat', S.geoBox, S.matBark, MAX);
    const back = this._instanced('street-bench-back', S.geoBox, S.matBark, MAX);
    const pole = this._instanced('street-lamp-pole', S.geoCylinder, S.matPillar, MAX);
    const head = this._instanced('street-lamp-head', S.geoSphere, S.matNeonGold, MAX);
    const bin = this._instanced('street-bin-body', S.geoCylinder, S.matWheelFrame, MAX);
    const lid = this._instanced('street-bin-lid', S.geoCylinder, S.matPillar, MAX);
    const signPost = this._instanced('street-sign-post', S.geoCylinder, S.matPillar, MAX);
    const signBoard = this._instanced('street-sign-board', S.geoBox, S.matNeonCyan, MAX);
    const n = { bench: 0, lamp: 0, bin: 0, sign: 0 };

    for (let i = 0; i < 16; i += 1) {
      const z = 11 - i * 2.5;
      for (const side of [-1, 1]) {
        const x = side * 9.6;
        if (this._isBlocked(x, z, zones, 0.8)) continue;
        const kind = i % 4;
        dummy.quaternion.identity();
        if (kind === 0 && n.bench < MAX) {
          const j = n.bench;
          dummy.position.set(x, 0.48, z);
          dummy.rotation.set(0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0);
          dummy.quaternion.setFromEuler(dummy.rotation);
          dummy.scale.set(2.0, 0.14, 0.6);
          dummy.updateMatrix(); seat.setMatrixAt(j, dummy.matrix);
          dummy.position.set(x - side * 0.28, 0.82, z);
          dummy.scale.set(2.0, 0.5, 0.1);
          dummy.updateMatrix(); back.setMatrixAt(j, dummy.matrix);
          n.bench += 1;
        } else if (kind === 1 && n.lamp < MAX) {
          const j = n.lamp;
          dummy.rotation.set(0, 0, 0); dummy.quaternion.identity();
          dummy.position.set(x, 2.1, z);
          dummy.scale.set(0.14, 4.2, 0.14);
          dummy.updateMatrix(); pole.setMatrixAt(j, dummy.matrix);
          dummy.position.set(x, 4.35, z);
          dummy.scale.setScalar(0.32);
          dummy.updateMatrix(); head.setMatrixAt(j, dummy.matrix);
          n.lamp += 1;
        } else if (kind === 2 && n.bin < MAX) {
          const j = n.bin;
          dummy.rotation.set(0, 0, 0); dummy.quaternion.identity();
          dummy.position.set(x, 0.5, z);
          dummy.scale.set(0.42, 1.0, 0.42);
          dummy.updateMatrix(); bin.setMatrixAt(j, dummy.matrix);
          dummy.position.set(x, 1.05, z);
          dummy.scale.set(0.48, 0.12, 0.48);
          dummy.updateMatrix(); lid.setMatrixAt(j, dummy.matrix);
          n.bin += 1;
        } else if (kind === 3 && n.sign < MAX) {
          const j = n.sign;
          dummy.rotation.set(0, 0, 0); dummy.quaternion.identity();
          dummy.position.set(x, 1.4, z);
          dummy.scale.set(0.1, 2.8, 0.1);
          dummy.updateMatrix(); signPost.setMatrixAt(j, dummy.matrix);
          dummy.position.set(x - side * 0.55, 2.6, z);
          dummy.scale.set(1.3, 0.6, 0.1);
          dummy.updateMatrix(); signBoard.setMatrixAt(j, dummy.matrix);
          n.sign += 1;
        }
        this._treePositions.push({ x, z, r: 0.9 }); // 供接触阴影统一铺设
      }
    }
    this._flushInstances([seat, back, pole, head, bin, lid, signPost, signBoard]);
    console.info(`[Lobby] 街道氛围 | 长椅${n.bench} 路灯${n.lamp} 垃圾桶${n.bin} 路牌${n.sign} / 8 draw call`);
  }

  /* ------------------------------------------------------------------------ */
  /* ⑥ 触发区：地面发光圆环 + 半透明圆盘（同时可点击）                       */
  /* ------------------------------------------------------------------------ */

  _buildTriggers() {
    const S = this._shared;
    for (const facility of FACILITIES) {
      const { x, z } = facility.trigger;
      const signMeshes = [];

      const disc = new THREE.Mesh(S.geoPlane, S.matTriggerDisc);
      disc.name = `Lobby/trigger-disc-${facility.key}`;
      disc.rotation.x = -Math.PI / 2;
      disc.scale.set(TRIGGER_RADIUS * 2, TRIGGER_RADIUS * 2, 1);
      disc.position.set(x, 0.075, z);
      this.root.add(disc);

      const ring = new THREE.Mesh(S.geoTorus, S.matTriggerRing);
      ring.name = `Lobby/trigger-ring-${facility.key}`;
      ring.rotation.x = -Math.PI / 2;
      ring.scale.setScalar(TRIGGER_RING_RADIUS);
      ring.position.set(x, 0.11, z);
      ring.userData.facilityKey = facility.key;
      ring.userData.entranceSign = true;
      this.root.add(ring);
      this._pickables.push(ring);
      this._triggerRings.push(ring);

      // 触发区两侧的小光柱，让入口在夜色里一眼可辨
      for (const side of [-1, 1]) {
        const p = this._box(this.root, `trigger-post-${facility.key}-${side}`,
          S.matNeonCyan, 0.16, 2.2, 0.16, x + side * TRIGGER_POST_OFFSET, 1.1, z,
          { key: facility.key });
        p.castShadow = false;
        p.userData.entranceSign = true;
        const orb = this._ball(this.root, `trigger-orb-${facility.key}-${side}`,
          S.matNeonCyan, 0.22, x + side * TRIGGER_POST_OFFSET, 2.3, z, { key: facility.key });
        orb.userData.entranceSign = true;
        signMeshes.push({ mesh: p, mat: S.matNeonCyan }, { mesh: orb, mat: S.matNeonCyan });
      }

      // 入口引导①：悬浮下指箭头（圆锥翻转 π 尖端朝下，动画里上下浮动）
      const arrow = new THREE.Mesh(S.geoCone, S.matNeonCyan);
      arrow.name = `Lobby/entrance-arrow-${facility.key}`;
      arrow.rotation.x = Math.PI;
      arrow.scale.set(0.42, 0.9, 0.42);
      arrow.position.set(x, 3.6, z);
      arrow.userData.facilityKey = facility.key;
      arrow.userData.entranceSign = true;
      this.root.add(arrow);
      this._pickables.push(arrow);
      this._entranceArrows.push({ mesh: arrow, baseY: 3.6, phase: this._entranceArrows.length * 1.3 });
      signMeshes.push({ mesh: arrow, mat: S.matNeonCyan });

      /* 入口引导②：T06 图集文字名称牌
       * 1 张 atlas 纹理 + 1 个共享 MeshBasicMaterial + 1 块 4 顶点 PlaneGeometry。
       * 世界宽度由 TRIGGER_RADIUS 派生（5 字 4.255m），高度按 atlas 子矩形
       * 的真实宽高比计算 → 字形不被拉扁，也没有大片透明留白。 */
      const labelInfo = this._atlasLabelGeometry(facility.label);
      if (labelInfo) {
        const worldW = facility.label.length * LABEL_WORLD_W_PER_CHAR;
        const worldH = worldW / labelInfo.uv.aspect;
        const label = new THREE.Mesh(labelInfo.geo, S.matLabelAtlas);
        label.name = `Lobby/entrance-label-${facility.key}`;
        label.position.set(x, 4.9, z);
        label.scale.set(worldW, worldH, 1);
        label.userData.facilityKey = facility.key;
        label.userData.entranceSign = true;
        this.root.add(label);
        this._pickables.push(label);
        this._billboardLabels.push({ mesh: label, x, z });
        signMeshes.push({
          mesh: label, mat: S.matLabelAtlas,
          isAtlasLabel: true, w: worldW, h: worldH,
        });
      }

      this._entranceSigns.set(facility.key, { meshes: signMeshes });
    }
    this._assertTriggerSpacing();
  }

  /**
   * T06 防回归自检：任意两个触发点的水平距离必须 ≥「盘径 + 1.9m 安全间隙」。
   * 6.5m 的门槛同时给名称牌（最宽 4.255m）留出 2m 以上的净空。
   * 开发期断言 + 明细告警，避免以后调坐标又把两个圈叠回一起。
   */
  _assertTriggerSpacing() {
    const min = TRIGGER_RADIUS * 2 + 1.9;
    const tooClose = [];
    let minDist = Infinity;
    let minPair = '';
    for (let i = 0; i < FACILITIES.length; i += 1) {
      for (let j = i + 1; j < FACILITIES.length; j += 1) {
        const a = FACILITIES[i];
        const b = FACILITIES[j];
        const d = Math.hypot(
          a.trigger.x - b.trigger.x,
          a.trigger.z - b.trigger.z
        );
        if (d < minDist) { minDist = d; minPair = `${a.label} ↔ ${b.label}`; }
        const msg = `[Lobby] 触发点间距不足：${a.label}(${a.trigger.x},${a.trigger.z}) ↔ ` +
          `${b.label}(${b.trigger.x},${b.trigger.z}) 距离 ${d.toFixed(2)}m < ${min.toFixed(2)}m`;
        console.assert(d >= min, msg);
        if (d < min) tooClose.push(msg);
      }
    }
    if (tooClose.length > 0) {
      console.warn(`[Lobby] 触发点间距不足（共 ${tooClose.length} 对）：`, tooClose.join('；'));
    } else {
      console.info(
        `[Lobby] 触发点间距自检通过：${FACILITIES.length} 个点，` +
        `最小 ${minDist.toFixed(2)}m（${minPair}）≥ ${min.toFixed(2)}m`
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  /* ⑦ 全局光影：环境光 + 方向光（开启真实阴影）                             */
  /* ------------------------------------------------------------------------ */

  _buildLights() {
    // 日光方案统一收敛到 SceneManager：一主光（方向光，castShadow）+ 半球光 + 极弱环境光。
    // 本类不再自建第二盏投影光（否则会重复投影并过曝）；字段保持为 null，
    // dispose() 中的 _dirLight / _ambientLight 分支因此自然跳过。
    this._ambientLight = null;
    this._dirLight = null;
  }

  /**
   * 为每个共享 geometry 指定一个「常驻渲染」代表对象。
   * 只关闭这 9 个对象的视锥剔除，其余部件仍可正常剔除，性能影响极小。
   */
  _ensureGeometryUpload() {
    const seen = new Set();
    this.root.traverse((obj) => {
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      const geo = obj.geometry;
      if (!geo || seen.has(geo)) return;
      seen.add(geo);
      obj.frustumCulled = false;
    });
    console.info(`[Lobby] 资源上传防线：${seen.size} 个共享几何体已设常驻渲染代表`);
  }

  /* ------------------------------------------------------------------------ */
  /* 定时器 / 事件登记                                                         */
  /* ------------------------------------------------------------------------ */

  _addTimeout(fn, ms) {
    const id = setTimeout(() => { this._timeoutIds.delete(id); fn(); }, ms);
    this._timeoutIds.add(id);
    return id;
  }

  _addListener(target, type, fn, tag = 'ui', options) {
    target.addEventListener(type, fn, options);
    // options 必须一起入账：removeEventListener 的匹配包含 capture 标志，
    // 一旦漏传，带 { capture: true } 的监听会永远解绑不掉（真泄漏）。
    this._listeners.push({ target, type, fn, tag, options });
  }

  _removeListenersByTag(tag) {
    const keep = [];
    for (const item of this._listeners) {
      if (item.tag === tag) {
        try { item.target.removeEventListener(item.type, item.fn, item.options); }
        catch (err) { console.error(`[Lobby] 解绑 ${item.type} 失败：`, err); }
      } else keep.push(item);
    }
    this._listeners = keep;
  }

  _clearAllTimers() {
    for (const id of this._rafIds) cancelAnimationFrame(id);
    for (const id of this._intervalIds) clearInterval(id);
    for (const id of this._timeoutIds) clearTimeout(id);
    this._rafIds.clear();
    this._intervalIds.clear();
    this._timeoutIds.clear();
  }

  /** 指针事件登记（全部 tag='input'，dispose 前段统一解绑）；
   *  旋转 / 缩放由 OrbitControls 自有监听驱动（其 dispose() 会成对解绑）。 */
  _bindInput() {
    const canvas = this._ctx.renderer.domElement;
    this._addListener(window, 'blur', this._onBlur, 'input');
    this._addListener(document, 'visibilitychange', this._onBlur, 'input');
    this._addListener(canvas, 'pointerdown', this._onPointerDown, 'input');
    this._addListener(canvas, 'pointermove', this._onPointerMove, 'input');
    this._addListener(canvas, 'pointerup', this._onPointerUp, 'input');
    this._addListener(canvas, 'pointercancel', this._onPointerCancel, 'input');
    // 【模块 8】E 键坐下 / 起身；坐下时拖拽环顾由 _onPointerMove 驱动
    this._addListener(window, 'keydown', this._onSitKey, 'input');
    // 【T02】M 键切换鼠标 / WASD；WASDController 自己的监听由其 dispose 回收
    this._addListener(window, 'keydown', this._onModeKey, 'input');

    /* 【M1】orbit 模式下的 WASD / 方向键平移监听 --------------------------
     * 旧实现只在切到 wasd 第一人称后接管键盘 → 默认进大厅按 W 毫无反应；
     * 且设施往返会把 _inputMode 重置为 orbit，键盘再次失效。
     * 这里独立维护一份按键集合，交给 WASDController.panOrbit() 每帧平移，
     * 不改输入模式 / 不改视角 / 不改眼高，v4② 的切换验收假设保持不变。 */
    this._onWalkKeyDown = (event) => {
      if (!MOVE_CODES.has(event.code)) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (this._inputMode !== 'orbit' || this._disposed) return;
      this._orbitKeys.add(event.code);
      if (event.code.startsWith('Arrow')) event.preventDefault();
    };
    this._onWalkKeyUp = (event) => { this._orbitKeys.delete(event.code); };
    this._onWalkBlur = () => { this._orbitKeys.clear(); };
    this._addListener(window, 'keydown', this._onWalkKeyDown, 'input');
    this._addListener(window, 'keyup', this._onWalkKeyUp, 'input');
    this._addListener(window, 'blur', this._onWalkBlur, 'input');
    this._addListener(document, 'visibilitychange', this._onWalkBlur, 'input');
  }

  /** T02：M 键切换输入模式（坐姿期间屏蔽，避免与坐姿环顾抢输入） */
  _onModeKey(event) {
    if (event.code !== 'KeyM' || event.repeat) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (this._sitState !== 'none') return;
    this._toggleInputMode();
  }

  _onSitKey(event) {
    if (event.key !== 'e' && event.key !== 'E' && event.key !== 'Escape') return;
    // 输入框聚焦时不抢键（时间控制台目前无文本输入，但防御性保留）
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (this._sitState === 'seated' || this._sitState === 'entering') {
      this._standUp();
      return;
    }
    if (this._sitState !== 'none' || event.key === 'Escape') return;
    const idx = this._hoveredBench();
    if (idx >= 0) this._sitDown(idx);
  }

  /* ------------------------------------------------------------------------ */
  /* T02：输入模式仲裁（orbit ↔ wasd，CameraRig 平滑过渡）                    */
  /* ------------------------------------------------------------------------ */

  /**
   * 由当前相机姿态算出「合法 orbit target」：正前方 10m、比相机低 1.6m。
   * 这样 (camera.position - target) 的距离≈10.13∈[5,50]、极角≈80.9°<maxPolarAngle，
   * OrbitControls.update() 不会夹动相机 → 切回 orbit 零位置跳变。
   * @param {THREE.Camera} cam
   * @returns {THREE.Vector3}
   */
  _orbitTargetFromPose(cam) {
    const f = horizontalForward(cam.quaternion);
    return new THREE.Vector3(
      cam.position.x + f.x * ORBIT_TARGET_DIST,
      cam.position.y - ORBIT_TARGET_DROP,
      cam.position.z + f.z * ORBIT_TARGET_DIST
    );
  }

  /** 切换输入模式（M 键 / HUD 按钮共用入口）。坐姿与过渡中一律拒绝。 */
  _toggleInputMode() {
    if (this._disposed || this._sitState !== 'none' || this._wasdBlendActive) return;
    const cam = this._ctx?.camera;
    const controls = this._controls;
    if (!cam || !controls || !this._wasd) return;

    /* 【T03 集成修复】嵌入视图 / 设施过渡持有相机时禁止抢 owner。
     * FacilityRuntime.activate(key) 会 setOwner(key) 并 blendTo(anchor, 0.8s)；
     * 若此时这里 setOwner('lobby-wasd')，嵌入视图后续带 owner 校验的
     * blendTo/restore 会被 CameraRig 拒绝，相机卡在半路。owner 白名单之外的
     * 一律视为「他方持有」，本模式切换直接放弃（不弹错、不打断玩法）。 */
    const foreignOwner = cameraRig.owner !== null
      && cameraRig.owner !== 'lobby'
      && cameraRig.owner !== 'lobby-wasd';
    if (cameraRig.isTransitioning || foreignOwner) {
      console.info(
        `[Lobby] 相机正由其他系统接管（owner=${cameraRig.owner}, ` +
        `transitioning=${cameraRig.isTransitioning}），M 切换暂不可用`
      );
      return;
    }

    const next = this._inputMode === 'orbit' ? 'wasd' : 'orbit';
    if (!cameraRig.isConfigured) cameraRig.configure({ camera: cam });
    if (!cameraRig.setOwner('lobby-wasd')) {
      console.warn('[Lobby] CameraRig owner 获取失败，输入模式切换已中止');
      return;
    }
    this._rigOwner = 'lobby-wasd';

    // 从 orbit 离开前清掉阻尼残量（此时相机仍是合法 orbit 姿态）。
    // 反方向（wasd→orbit）不需要：进入 WASD 时残量已被清零，且此时 controls.target
    // 可能是旧值，贸然 update 会把 WASD 机位夹走。
    if (this._inputMode === 'orbit') {
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update(); // damping=false 时 OrbitControls 会清空 sphericalDelta
      controls.enableDamping = damping;
    }
    controls.enabled = false;

    let pose;
    if (next === 'wasd') {
      // 俯瞰机位平滑降到第一人称眼高，水平位置沿用当前俯瞰点，避开建筑 AABB
      const endPos = new THREE.Vector3(cam.position.x, WASD_EYE_HEIGHT, cam.position.z);
      this._wasd.resolveCollision(endPos);
      const f = horizontalForward(cam.quaternion);
      const lookAt = endPos.clone().add(new THREE.Vector3(f.x, 0, f.z).multiplyScalar(10));
      pose = { position: endPos, lookAt, fov: cam.fov, owner: 'lobby-wasd' };
      this._pendingOrbitTarget = null;
    } else {
      // 位置全程不变，只把朝向平滑落到合法 orbit target
      const target = this._orbitTargetFromPose(cam);
      this._pendingOrbitTarget = target;
      pose = { position: cam.position.clone(), lookAt: target, fov: cam.fov, owner: 'lobby-wasd' };
    }

    this._inputMode = next;
    this._wasdBlendActive = true;
    this._wasdBlendKind = next;
    this._wasd.clearInput();
    this._orbitKeys.clear();   // 【M1】模式切换时清掉 orbit 平移键，避免粘滞

    const ok = cameraRig.blendTo(pose, next === 'wasd' ? MODE_BLEND_ENTER : MODE_BLEND_EXIT);
    if (!ok) {
      // 理论上 configure + setOwner 后必成功；失败则完整回滚，不留半切换状态
      this._inputMode = next === 'wasd' ? 'orbit' : 'wasd';
      this._wasdBlendActive = false;
      this._wasdBlendKind = null;
      this._pendingOrbitTarget = null;
      controls.enabled = true;
      cameraRig.releaseOwner('lobby-wasd');
      this._rigOwner = null;
      console.warn('[Lobby] CameraRig.blendTo 被拒，输入模式切换已回滚');
      return;
    }
    this._syncInputModeUI();
    this._showToast(next === 'wasd'
      ? '已切换：WASD / 方向键漫游 · Shift 加速 · 按 M 切回鼠标'
      : '已切换：鼠标自由探索 · 按 M 切 WASD');
    console.info(`[Lobby] 输入模式 → ${next === 'wasd' ? 'WASD 第一人称' : 'OrbitControls 鼠标'}`);
  }

  /** CameraRig 过渡结束：交还对应控制器，绝不在这里瞬移相机。 */
  _finishWASDBlend() {
    const kind = this._wasdBlendKind;
    this._wasdBlendActive = false;
    this._wasdBlendKind = null;
    const cam = this._ctx?.camera;
    const controls = this._controls;
    if (!cam || !controls) return;

    if (kind === 'wasd') {
      this._wasd?.resetFromCamera(cam);
      this._syncInputModeUI();
      console.info('[Lobby] WASD 就绪：W/A/S/D / 方向键平移，按住画面拖拽环顾，M 切回鼠标');
      return;
    }

    // wasd → orbit：位置全程未变；把 target 写到正前下方，再让 controls 接管。
    const target = this._pendingOrbitTarget || this._orbitTargetFromPose(cam);
    controls.target.copy(target);
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update(); // sphericalDelta 已清零，target 合法 → 位置不变
    controls.enableDamping = damping;
    controls.enabled = true;
    this._pendingOrbitTarget = null;
    if (this._rigOwner === 'lobby-wasd') {
      cameraRig.releaseOwner('lobby-wasd');
      // T03：FacilityRuntime.configure() 约定大厅默认 owner 为 'lobby'。
      // 切回 orbit 后必须还回去，不能留 null，否则后续嵌入视图的
      // blendTo/restore 握手会因「当前无 owner」被 CameraRig 拒绝。
      cameraRig.setOwner('lobby');
      this._rigOwner = null;
    }
    this._syncInputModeUI();
    console.info('[Lobby] OrbitControls 就绪：拖拽旋转 / 滚轮缩放，M 切 WASD');
  }

  /* ------------------------------------------------------------------------ */
  /* UI                                                                       */
  /* ------------------------------------------------------------------------ */

  _buildUI() {
    this._uiStyle = document.createElement('style');
    this._uiStyle.id = 'lb-ui-style';
    this._uiStyle.textContent = UI_CSS;
    document.head.appendChild(this._uiStyle);

    this._uiRoot = document.createElement('div');
    this._uiRoot.className = 'lb-ui';
    this._uiRoot.innerHTML = `
      <div class="lb-vignette"></div>
      <div class="lb-title" data-role="time-title">日光游乐场 · 中央广场</div>
      <div class="lb-mode">
        <button class="lb-mode-btn" data-role="input-mode" data-mode="orbit" title="WASD 可直接走动；按 M 切第一人称 / 鼠标">◧ 鼠标漫游 · WASD 走动 · M 切第一人称</button>
      </div>
      <div class="lb-zoo">
        <button class="lb-zoo-btn" data-role="zoo-visit" data-at="plaza" title="一键飞到游乐场旁的动物园">🦁 去动物园</button>
      </div>
      <div class="lb-controls" data-role="controls-hint">拖拽旋转 · 滚轮 / 双指缩放 · 点击设施入口标识进入</div>
      <div class="lb-toast" data-role="toast" data-hidden="true"></div>
      <div class="lb-compass" data-role="compass-hint">OrbitControls 自由探索 · 缩放范围 5–50</div>
      <div class="lb-sit-vignette" data-role="sit-vignette" data-on="0"></div>
      <div class="lb-sit-hint" data-role="sit-hint" data-hidden="true">点击长椅或按 E 坐下休息</div>
      <div class="lb-sit-bar" data-role="sit-bar" data-hidden="true">
        <span>休息中… · 拖拽环顾</span>
        <button data-role="sit-stand">起身</button>
      </div>
      <div class="lb-time">
        <div class="lb-time-box" data-open="false" data-role="time-box">
          <div class="lb-time-title"><span>时间控制台</span><b data-role="time-mode">白天</b></div>
          <div class="lb-time-modes">
            <button data-time="day" data-on="1">白天</button>
            <button data-time="sunset" data-on="0">黄昏</button>
            <button data-time="night" data-on="0">黑夜</button>
          </div>
          <div class="lb-time-auto">
            <span>自动昼夜循环 · 8 分钟/轮</span>
            <button data-role="time-auto" data-on="0">关</button>
          </div>
          <button class="lb-time-fire" data-role="time-fire">放一束烟花</button>
          <div class="lb-time-tip">黑夜霓虹会自动亮起；到「烟花观礼台」可放文字烟花。</div>
        </div>
        <button class="lb-time-toggle" data-role="time-toggle">◑ 时间 · <span data-role="time-toggle-label">白天</span></button>
      </div>
    `;
    document.body.appendChild(this._uiRoot);
    this._ui = {
      toast: this._uiRoot.querySelector('[data-role="toast"]'),
      modeBtn: this._uiRoot.querySelector('[data-role="input-mode"]'),
      zooBtn: this._uiRoot.querySelector('[data-role="zoo-visit"]'),
      controlsHint: this._uiRoot.querySelector('[data-role="controls-hint"]'),
      compassHint: this._uiRoot.querySelector('[data-role="compass-hint"]'),
      timeBox: this._uiRoot.querySelector('[data-role="time-box"]'),
      timeMode: this._uiRoot.querySelector('[data-role="time-mode"]'),
      timeToggleLabel: this._uiRoot.querySelector('[data-role="time-toggle-label"]'),
      timeAuto: this._uiRoot.querySelector('[data-role="time-auto"]'),
      timeTitle: this._uiRoot.querySelector('[data-role="time-title"]'),
      sitHint: this._uiRoot.querySelector('[data-role="sit-hint"]'),
      sitBar: this._uiRoot.querySelector('[data-role="sit-bar"]'),
      sitVignette: this._uiRoot.querySelector('[data-role="sit-vignette"]'),
    };

    // 事件委托：一个 click 监听覆盖整个时间控制台，dispose 时统一解绑
    this._onTimeClick = (event) => {
      const el = event.target.closest('[data-role], [data-time]');
      if (!el || !this._uiRoot.contains(el)) return;
      const mode = el.dataset.time;
      const role = el.dataset.role;
      if (mode) {
        dayNightCycle.setMode(mode);
      } else if (role === 'time-toggle') {
        const box = this._ui.timeBox;
        box.dataset.open = box.dataset.open === 'true' ? 'false' : 'true';
      } else if (role === 'time-auto') {
        dayNightCycle.toggleAuto();
      } else if (role === 'time-fire') {
        this._lobbyFirework();
      } else if (role === 'sit-stand') {
        this._standUp();
      } else if (role === 'input-mode') {
        this._toggleInputMode();
      } else if (role === 'zoo-visit') {
        this._visitZoo();
      }
      this._syncTimePanel();
    };
    this._addListener(this._uiRoot, 'click', this._onTimeClick, 'ui');

    // 自动循环会自行改变模式 → 订阅后刷新面板
    this._offTimeChange = dayNightCycle.onChange(() => this._syncTimePanel());
    this._syncInputModeUI(); // T02：HUD 初始文案与默认 orbit 模式对齐
  }

  /** T02：HUD 按钮 / 提示文案随输入模式同步（M 键与按钮共用同一状态源） */
  _syncInputModeUI() {
    const { modeBtn, controlsHint, compassHint } = this._ui || {};
    if (!modeBtn) return;
    const wasd = this._inputMode === 'wasd';
    modeBtn.dataset.mode = this._inputMode;
    modeBtn.textContent = wasd
      ? '⌨ WASD 第一人称 · M 切回鼠标'
      : '◧ 鼠标漫游 · WASD 走动 · M 切第一人称';
    if (controlsHint) {
      controlsHint.textContent = wasd
        ? 'W / A / S / D 或方向键移动 · Shift 加速 · 按住画面拖拽环顾 · 点击入口进入'
        : 'WASD / 方向键走动 · 拖拽旋转 · 滚轮缩放 · 点击设施入口标识进入';
    }
    if (compassHint) {
      compassHint.textContent = wasd
        ? '第一人称漫游 · 眼高 1.6m · 按 M 切回鼠标'
        : 'OrbitControls 自由探索 · 缩放范围 5–50';
    }
  }

  /** 同步时间控制台的选中态 / 文案（含自动循环推进的模式变化） */
  _syncTimePanel() {
    if (!this._ui?.timeBox) return;
    const { timeBox, timeMode, timeToggleLabel, timeAuto, timeTitle } = this._ui;
    const label = MODE_LABELS[dayNightCycle.mode] ?? '白天';
    const parkName = { day: '日光游乐场', sunset: '夕照游乐场', night: '星夜游乐场' }[dayNightCycle.mode] ?? '日光游乐场';
    timeMode.textContent = label;
    timeToggleLabel.textContent = label;
    if (timeTitle) timeTitle.textContent = `${parkName} · 中央广场`;
    timeBox.querySelectorAll('[data-time]').forEach((b) => {
      b.dataset.on = (!dayNightCycle.isAuto && b.dataset.time === dayNightCycle.mode) ? '1' : '0';
    });
    timeAuto.dataset.on = dayNightCycle.isAuto ? '1' : '0';
    timeAuto.textContent = dayNightCycle.isAuto ? '开' : '关';
  }

  /** 大厅内快速放一束烟花（不必进入观礼台） */
  _lobbyFirework() {
    const cam = this._ctx?.camera;
    if (!cam) return;
    const target = this._controls?.target ?? new THREE.Vector3(0, 0, 0);
    const p = {
      x: target.x + (Math.random() - 0.5) * 16,
      y: 16 + Math.random() * 7,
      z: target.z - 18,
    };
    const color = FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0].hex;
    fireworkSystem.setBrightness(dayNightCycle.mode === 'day' ? 0.55 : 1);
    fireworkSystem.launch(p, 'burst', color, 1.2, 2.4);
  }

  /* ------------------------------------------------------------------------ */
  /* 模块 8：长椅坐下休息                                                      */
  /* ------------------------------------------------------------------------ */

  /** 当前鼠标 hover 到的长椅索引（供 E 键坐下）；-1 表示没有 */
  _hoveredBench() {
    return this._hoverBenchIndex ?? -1;
  }

  /**
   * 坐下：接管相机与 OrbitControls，0.8s 平滑过渡到坐姿第一人称视角。
   * 坐姿眼高 1.15（站姿 1.6，降低 0.45~0.5），朝向沿用长椅 yaw（面向广场中心）。
   */
  _sitDown(index) {
    if (this._sitState !== 'none') return;
    const bench = this._benchSpots[index];
    const cam = this._ctx?.camera;
    const controls = this._controls;
    if (!bench || !cam || !controls) return;

    this._sitBench = bench;
    this._sitState = 'entering';
    this._sitT = 0;
    this._sitPhase = 0;
    this._sitYaw = bench.yaw;
    this._sitPitch = -0.04;

    this._sitSaved = {
      position: cam.position.clone(),
      quaternion: cam.quaternion.clone(),
      rotationOrder: cam.rotation.order,
      fov: cam.fov,
      target: controls.target.clone(),
    };
    // 起点 / 终点位姿
    this._sitPosA.copy(cam.position);
    this._sitQuatA.copy(cam.quaternion);
    this._sitPosB.set(bench.x, SIT_EYE_H, bench.z);
    this._sitQuatB.setFromEuler(new THREE.Euler(this._sitPitch, this._sitYaw, 0, 'YXZ'));

    controls.enabled = false; // 坐下期间禁 orbit，改由自有 yaw/pitch 环顾
    this._setSitUI(true);
    this._showToast('坐下休息 · 拖拽环顾，按 E 或点「起身」退出');
    console.info(`[Lobby] 坐下休息 → 长椅 #${index} @(${bench.x.toFixed(1)}, ${bench.z.toFixed(1)})`);
  }

  /** 起身：0.8s 平滑插值回站立机位，结束后交还 OrbitControls */
  _standUp() {
    if (this._sitState !== 'seated' && this._sitState !== 'entering') return;
    const cam = this._ctx?.camera;
    if (!cam || !this._sitSaved) return;
    this._sitPosA.copy(cam.position);
    this._sitQuatA.copy(cam.quaternion);
    this._sitPosB.copy(this._sitSaved.position);
    this._sitQuatB.copy(this._sitSaved.quaternion);
    this._sitState = 'leaving';
    this._sitT = 0;
    this._setSitUI(false);
  }

  _setSitUI(seated) {
    const { sitHint, sitBar, sitVignette } = this._ui;
    if (sitHint) sitHint.dataset.hidden = 'true';
    if (sitBar) sitBar.dataset.hidden = seated ? 'false' : 'true';
    if (sitVignette) sitVignette.dataset.on = seated ? '1' : '0';
  }

  /** 每帧驱动坐下 / 起身 / 坐姿环顾（含微呼吸） */
  _updateSit(dt) {
    if (this._sitState === 'none') return;
    const cam = this._ctx?.camera;
    if (!cam) return;

    if (this._sitState === 'entering' || this._sitState === 'leaving') {
      this._sitT = Math.min(1, this._sitT + dt / 0.8);
      // smoothstep 缓动，无突变
      const t = this._sitT * this._sitT * (3 - 2 * this._sitT);
      cam.position.lerpVectors(this._sitPosA, this._sitPosB, t);
      cam.quaternion.slerpQuaternions(this._sitQuatA, this._sitQuatB, t);
      cam.rotation.order = 'YXZ';

      if (this._sitT >= 1) {
        if (this._sitState === 'entering') {
          this._sitState = 'seated';
          cam.fov = 60; cam.updateProjectionMatrix();
        } else {
          // 起身完成：完整归还相机与 controls
          this._sitState = 'none';
          const s = this._sitSaved;
          cam.position.copy(s.position);
          cam.quaternion.copy(s.quaternion);
          cam.rotation.order = s.rotationOrder;
          cam.fov = s.fov;
          cam.updateProjectionMatrix();
          const controls = this._controls;
          if (controls) {
            controls.target.copy(s.target);
            if (this._inputMode === 'wasd') {
              // 起身回到 WASD 漫游：不调 controls.update()，否则旧 target 会把机位夹走
              controls.enabled = false;
              this._wasd?.resetFromCamera(cam);
            } else {
              controls.enabled = true;
              controls.update();
            }
          }
          this._sitSaved = null;
          this._sitBench = null;
          this._setSitUI(false);
        }
      }
      return;
    }

    if (this._sitState === 'seated') {
      this._sitPhase += dt;
      const bench = this._sitBench;
      if (bench) {
        // 极轻的呼吸起伏（幅度 0.012，不眩晕）
        const breathe = Math.sin(this._sitPhase * 1.6) * 0.012;
        cam.position.set(bench.x, SIT_EYE_H + breathe, bench.z);
      }
      cam.rotation.order = 'YXZ';
      cam.rotation.set(this._sitPitch, this._sitYaw, 0);
    }
  }

  _showToast(text) {
    if (!this._ui.toast) return;
    if (this._toastTimeoutId !== null) {
      clearTimeout(this._toastTimeoutId);
      this._timeoutIds.delete(this._toastTimeoutId);
    }
    this._ui.toast.textContent = text;
    this._ui.toast.dataset.hidden = 'false';
    this._toastTimeoutId = this._addTimeout(() => {
      if (this._ui.toast) this._ui.toast.dataset.hidden = 'true';
      this._toastTimeoutId = null;
    }, 1600);
  }

  /* ------------------------------------------------------------------------ */
  /* 交互                                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * 点击处理：Raycaster 必须传入 intersectObjects(pickables, true)（沿用 M5a 硬约束）。
   * pointerdown/up 位移已在 _onPointerUp 中判拖拽，200ms 防抖也已生效。
   */
  _handleClick(event) {
    const canvas = this._ctx?.renderer?.domElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this._ctx.camera);

    // 【模块 8】坐下中：点击画布不触发任何设施进入（状态互斥）
    if (this._sitState !== 'none') return;

    // 【模块 8】长椅点击代理单独 raycast（不与 _pickables 混用，避免劫持入口）
    const benchHits = this._raycaster.intersectObjects(this._benchPickables, false);
    if (benchHits.length) {
      const idx = benchHits[0].object.userData.benchIndex;
      if (typeof idx === 'number') { this._sitDown(idx); return; }
    }

    // 【硬性约束】必须传入 pickables 数组与 recursive=true
    const hits = this._raycaster.intersectObjects(this._pickables, true);
    if (hits.length === 0) return;

    const key = this._pickKey(hits);
    if (!key) return;
    const facility = FACILITIES.find((f) => f.key === key);
    if (!facility) return;
    // OrbitControls 俯瞰视角下允许直接点击任意可见入口进入，不做距离门槛
    this._tryEnter(key);
  }

  /** 进入设施：两个项目都已开放，统一走 ctx.onEnterAttraction(key) */
  _tryEnter(key) {
    const now = performance.now();
    if (now - this._lastEnterAt < CLICK_DEBOUNCE) return; // 防抖：E + 点击不重复触发
    this._lastEnterAt = now;

    const facility = FACILITIES.find((f) => f.key === key);
    if (!facility) return;
    const fn = this._ctx?.onEnterAttraction;
    if (typeof fn !== 'function') {
      console.warn('[Lobby] 缺少 ctx.onEnterAttraction 回调，无法进入项目');
      return;
    }
    console.info(`[Lobby] 进入「${facility.name}」→ ${key}`);
    fn(key);
  }

  /**
   * IAttraction 契约方法。
   * 点击由自有 pointerdown/pointerup + Raycaster 链路处理（需要位移判拖拽与
   * 200ms 防抖，基座 onInteract 只提供 click，无法区分）；这里刻意不重复触发，
   * 避免双重切换。
   */
  onInteract(_hitInfo) {
    // 故意留空：见上方说明
  }

  /* ------------------------------------------------------------------------ */
  /* 入口标识 hover 高亮                                                        */
  /* ------------------------------------------------------------------------ */

  /** 射线检测鼠标下的入口标识 → 整套入口标识高亮（拖拽旋转时不做 hover） */
  _updateHover(event) {
    if (this._dragging) return;
    const canvas = this._ctx?.renderer?.domElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this._ctx.camera);

    // 【模块 8】长椅 hover：单独 raycast，命中时记录索引 + 显示「坐下」提示
    const benchHit = this._raycaster.intersectObjects(this._benchPickables, false)[0];
    let benchIdx = -1;
    if (benchHit && this._sitState === 'none') {
      const b = this._benchSpots[benchHit.object.userData.benchIndex];
      if (b) {
        const camPos = this._ctx.camera.position;
        // OrbitControls 俯瞰相机可拉近到 minDistance=5，用 3D 距离判定「走近」；
        // 阈值 8 覆盖 3~5 的核心交互区，同时允许俯瞰视角下正常显示提示。
        const dist = Math.hypot(camPos.x - b.x, camPos.y - 1.0, camPos.z - b.z);
        if (dist <= SIT_PROMPT_RANGE) benchIdx = benchHit.object.userData.benchIndex;
      }
    }
    this._hoverBenchIndex = benchIdx;
    if (this._ui.sitHint) {
      this._ui.sitHint.dataset.hidden = benchIdx >= 0 ? 'false' : 'true';
    }

    const hits = this._raycaster.intersectObjects(this._pickables, true);
    const key = this._pickKey(hits);
    this._setHover(key);
  }

  /** 射线结果优先取入口标识（箭头/名称牌/光柱/触发环）：相邻设施的隐形点击
   *  代理盒可能在空间上罩住本设施标识，取 hits[0] 会把 hover/点击劫持到邻设施。 */
  _pickKey(hits) {
    const hit = hits.find((h) => h.object.userData.entranceSign) || hits[0];
    return hit ? (hit.object.userData.facilityKey || null) : null;
  }

  /** 高亮切换：入口标识在共享常态材质 ↔ 共享热材质间互换，零新增 GPU 资源 */
  _setHover(key) {
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    const S = this._shared;
    for (const [facilityKey, sign] of this._entranceSigns) {
      const hot = facilityKey === key;
      for (const item of sign.meshes) {
        if (item.isAtlasLabel) {
          // 文字牌共用 1 个材质，不能像霓虹件那样换材质；改用轻微放大做 hover 反馈。
          const k = hot ? 1.08 : 1;
          item.mesh.scale.set(item.w * k, item.h * k, 1);
        } else {
          item.mesh.material = hot ? S.matNeonGold : item.mat;
        }
      }
    }
    const canvas = this._ctx?.renderer?.domElement;
    if (canvas) canvas.style.cursor = key ? 'pointer' : '';
  }

  /**
   * 视口自适应：只在宽高比跨过阈值时改一次 fov（不新建资源）。
   * 竖屏窄画幅下放宽到 70°，保证左右设施与地面边界不被裁掉；桌面维持 55°。
   */
  _fitViewport() {
    const camera = this._ctx?.camera;
    if (!camera) return;
    const a = camera.aspect;
    if (Math.abs(a - this._lastAspect) < 0.01) return;
    this._lastAspect = a;
    const fov = a < 0.8 ? 70 : a < 1.15 ? 62 : 55;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 动物园一键直达：OrbitControls 姿态在 1.1s 内平滑过渡，不改动任何设施      */
  /* ------------------------------------------------------------------------ */

  _visitZoo() {
    const cam = this._ctx?.camera;
    const controls = this._controls;
    if (!cam || !controls || this._disposed) return;

    // 飞行期间强制 orbit 模式，避免 WASDController 与过渡同时写相机
    if (this._inputMode === 'wasd') {
      this._inputMode = 'orbit';
      this._wasdBlendActive = false;
      this._wasdBlendKind = null;
      this._syncInputModeUI();
    }
    if (cameraRig.owner === 'lobby-wasd') {
      cameraRig.releaseOwner('lobby-wasd');
      cameraRig.setOwner('lobby');
    }

    this._zooView = !this._zooView;
    const toCam = this._zooView ? ZOO_VIEW.cam : [0, 30, 34];
    const toTgt = this._zooView ? ZOO_VIEW.tgt : [0, 2, 0];
    this._zooFly = {
      t: 0,
      dur: 1.1,
      fromCam: cam.position.clone(),
      fromTgt: controls.target.clone(),
      toCam: new THREE.Vector3(...toCam),
      toTgt: new THREE.Vector3(...toTgt),
    };
    const btn = this._ui?.zooBtn;
    if (btn) {
      btn.dataset.at = this._zooView ? 'zoo' : 'plaza';
      btn.textContent = this._zooView ? '🏰 返回中央广场' : '🦁 去动物园';
    }
  }

  _updateZooFly(dt) {
    const f = this._zooFly;
    const cam = this._ctx?.camera;
    const controls = this._controls;
    if (!f || !cam || !controls) { this._zooFly = null; return; }
    f.t = Math.min(f.t + dt, f.dur);
    const k = f.t / f.dur;
    const e = k * k * (3 - 2 * k);          // smoothstep
    cam.position.lerpVectors(f.fromCam, f.toCam, e);
    controls.target.lerpVectors(f.fromTgt, f.toTgt, e);
    cam.lookAt(controls.target);
    controls.enabled = false;
    if (k >= 1) {
      this._zooFly = null;
      controls.enabled = true;
      controls.update();
    }
  }

  /** 全部动画只改已有对象的属性，绝不新建任何 GPU 资源 */
  _updateAnimations(dt) {
    this._time += dt;
    const t = this._time;

    // 动物园：32 只动物 / 四区循环动画（只写 instanceMatrix，零新建 GPU 资源）
    this._zoo?.update(t);

    // 手册 P6：远处物体动画暂停 —— LOD 已切到中/远景（外观被隐藏）时跳过装饰动画
    const lodOn = (key) => {
      const lod = this._lods[key];
      return !lod || lod.getCurrentLevel() === 0;
    };

    if (this._wheelGroup && lodOn('pumpkin-wheel')) {
      this._wheelGroup.rotation.z += dt * 0.13;
      // T04b-c：与轮盘同一 LOD 门控（远景角度不变，无需重算实例矩阵）
      this._syncWheelCabins();
    }

    /* ---------- T07：大厅设施常驻动效（只改已有对象属性，热路径零 new） ---------- */
    // 木马：立面不是 DetailLOD 项，lodOn('carousel') 恒为 true；仍按规格保留门控写法。
    if (this._carouselFacadeSpin && lodOn('carousel')) {
      this._carouselFacadeSpin.rotation.y += dt * LOBBY_CAROUSEL_SPIN_SPEED;
    }
    // 海盗船：与真实设施同周期 3s；由累计时间算相位，杜绝增量漂移。
    if (this._pirateFacadePivot && lodOn('pirate-ship')) {
      this._pirateFacadePivot.rotation.z = LOBBY_PIRATE_MAX_AMP * Math.sin(t * LOBBY_PIRATE_OMEGA);
    }
    // 小火车：站台短轨往返，到两端按速度符号平滑掉头；车轮按位移量滚动。
    if (this._stationTrain && lodOn('train-station')) {
      const phase = t * LOBBY_TRAIN_OMEGA;
      const nextZ = LOBBY_TRAIN_BASE_Z + LOBBY_TRAIN_TRAVEL * Math.sin(phase);
      const dz = nextZ - this._stationTrain.position.z;
      this._stationTrain.position.z = nextZ;
      // 车头朝本地 -Z：速度向 +Z 时 yaw=π，向 -Z 时 yaw=0；指数逼近防瞬间翻转
      const targetYaw = Math.cos(phase) >= 0 ? Math.PI : 0;
      let delta = targetYaw - this._stationTrain.rotation.y;
      delta = ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      this._stationTrain.rotation.y += delta * (1 - Math.exp(-dt * 6));
      const dSpin = dz / LOBBY_TRAIN_WHEEL_R;
      for (const w of this._stationTrainWheels) w.rotation.x += dSpin;
    }

    // 过山车小车：挂在真实轨道上，参数 t 随 dt 推进（贴轨由 CoasterCarRuntime 保证，热路径零 new）
    if (this._coasterCars && lodOn('coaster')) {
      this._coasterCars.update(dt);
    }

    if (lodOn('coin-corridor')) {
      for (const c of this._coinMeshes) {
        c.mesh.rotation.y += dt * 1.5;
        c.mesh.position.y = c.baseY + Math.sin(t * 1.7 + c.phase) * 0.22;
      }
    }

    // 魔法牌屋的悬浮牌阵：细微偏转 + 上下浮动（只改属性，不新建资源）
    if (lodOn('memory-house')) {
      for (const c of this._memoryCards) {
        c.mesh.rotation.y = Math.sin(t * 0.5 * c.speed + c.phase) * 0.26;
        c.mesh.position.y = c.baseY + Math.sin(t * 1.1 + c.phase) * 0.22;
      }
    }

    // 弹跳竞技场：主球自转 + 上下弹跳感 + 光环缩放
    if (this._bounceBall && lodOn('bouncing-arena')) {
      this._bounceBall.rotation.y += dt * 0.7;
      this._bounceBall.rotation.x += dt * 0.25;
      this._bounceBall.position.y = 5.4 + Math.sin(t * 1.35) * 0.32;
    }
    if (this._bounceHalo && lodOn('bouncing-arena')) {
      this._bounceHalo.scale.setScalar(2.15 * (1 + 0.05 * Math.sin(t * 1.35)));
      this._bounceHalo.position.y = this._bounceBall ? this._bounceBall.position.y : 5.4;
    }

    for (const cloud of this._particleClouds) {
      const arr = cloud.attribute.array;
      for (let i = 0; i < cloud.count; i += 1) {
        arr[i * 3 + 1] = cloud.base[i * 3 + 1] + Math.sin(t * 0.9 + i * 0.73) * 0.55;
      }
      cloud.attribute.needsUpdate = true;
    }

    for (let i = 0; i < this._triggerRings.length; i += 1) {
      const s = TRIGGER_RING_RADIUS * (1 + 0.06 * Math.sin(t * 2.4 + i * 1.6));
      this._triggerRings[i].scale.setScalar(s);
    }

    // 喷泉水面：径向正弦波纹（边缘衰减），343 顶点逐帧位移 + 重算法线
    if (this._fountainWater) {
      const pos = this._fountainWater.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 1) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        pos.setZ(i, Math.sin(r * 4 - t * 2.5) * 0.03 * (1 - r / 2.4));
      }
      pos.needsUpdate = true;
      this._fountainWater.geometry.computeVertexNormals();
    }

    // 入口箭头上下浮动，提示可点击
    for (const a of this._entranceArrows) {
      a.mesh.position.y = a.baseY + Math.sin(t * 2.2 + a.phase) * 0.25;
    }

    const cam = this._ctx?.camera;

    // T06：图集文字牌绕 Y 轴始终正对相机。OrbitControls 可 360° 环绕，
    // 若固定朝向 +z，转到背面文字就会消失（FrontSide 剔除）或镜像。
    // 只改 rotation.y，不新建任何资源，也不影响光柱/箭头这些固定锚点。
    if (cam) {
      for (const item of this._billboardLabels) {
        item.mesh.rotation.y = Math.atan2(
          cam.position.x - item.x,
          cam.position.z - item.z
        );
      }
    }

    // 天空与云跟随相机水平位移：天空盒必须始终以相机为中心，
    // 云按层不同视差系数 → 无限远、有纵深的效果，且不随视角旋转漂移。
    if (cam) {
      if (this._sky) this._sky.position.set(cam.position.x, 0, cam.position.z);
      if (this._clouds) {
        this._clouds.position.set(cam.position.x, 0, cam.position.z);
        if (this._cloudSprites) {
          // 桌面 sprite 云：按层整体轻微自转，制造缓慢漂移
          this._clouds.rotation.y = Math.sin(t * 0.02) * 0.05;
        }
        if (this._cloudLayers) {
          for (const layer of this._cloudLayers) {
            if (layer.object) layer.object.rotation.y += layer.spin * dt;
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* update —— 由基座 SceneManager 统一驱动；本类不自建 rAF、不 world.step()  */
  /* ------------------------------------------------------------------------ */

  update(deltaTime) {
    if (this._disposed) return;
    const dt = Math.min(Math.max(deltaTime, 0), 0.1);
    if (this._sitState === 'none') this._fitViewport();

    /* 【六项升级·阶段二】漫游态按 Esc 交还相机时，用当前姿态重算 orbit target，
     * 否则 OrbitControls.update() 会按旧 target 把相机瞬间拉回 → 跳变。 */
    if (movementMode.consumeRelease() && this._controls && this._ctx?.camera) {
      const cam = this._ctx.camera;
      const f = horizontalForward(cam.quaternion);
      this._controls.target.set(
        cam.position.x + f.x * ORBIT_TARGET_DIST,
        cam.position.y - ORBIT_TARGET_DROP,
        cam.position.z + f.z * ORBIT_TARGET_DIST
      );
      cam.updateMatrixWorld(true);
    }

    /* T02 相机主控仲裁（同一时刻只有一个写相机的人）：
     * 坐姿 → _updateSit 独立接管；过渡 → CameraRig；wasd → WASDController；
     * orbit → OrbitControls。三者互斥，杜绝"双主控抖相机"。 */
    if (this._sitState !== 'none') {
      // 坐姿 / 起身由 _updateSit 在下方驱动，这里不碰 controls / WASD
    } else if (movementMode.isEngaged()) {
      /* 【六项升级·阶段二】双模式互斥状态机接管相机：ground 1.7m 贴地 + BVH
       * 防穿模 / flight 自由升降。engaged 默认 false（仅按 F 或点 HUD 才接管），
       * 因此既有 orbit / WASD / M 键验收路径完全不变，无删除、无抢写。 */
      this._controls.enabled = false;
      this._orbitKeys.clear();
      movementMode.update(dt);
    } else if (this._wasdBlendActive) {
      /* 【T03 集成修复】CameraRig 由 FacilityRuntime.update(dt) 每帧【唯一】推进
       * （main.js frameDriver.update 无条件调用它）。Lobby 这里【绝不】再调
       * cameraRig.update(dt)——否则一次过渡被推进两次、时长腰斩、切回不跳变失真。
       * 本分支只检测过渡是否已由 FacilityRuntime 收尾。 */
      if (!cameraRig.isTransitioning) this._finishWASDBlend();
    } else if (this._inputMode === 'wasd') {
      this._controls.enabled = false;
      this._wasd?.update(dt);
    } else {
      // 动物园飞行过渡期间由 _updateZooFly 独占相机，避免 OrbitControls 抢写
      this._controls.enabled = !this._zooFly;
      if (!this._zooFly) this._controls.update();

      /* 【M1】orbit 模式下 WASD / 方向键直接平移。
       * 只在相机由大厅持有、无 CameraRig 过渡、非坐姿、非动物园飞行时生效，
       * 嵌入设施接管相机期间（owner=设施 key）自动让位，避免抢写锚点。 */
      if (!this._zooFly && this._sitState === 'none'
        && !cameraRig.isTransitioning
        && (cameraRig.owner === null || cameraRig.owner === 'lobby')) {
        this._wasd?.panOrbit(dt, this._ctx?.camera, this._controls, this._orbitKeys);
      }
    }

    if (this._zooFly) this._updateZooFly(dt);

    // 【M7】四宫格区域级 LOD：THREE.LOD 由 renderer 投影阶段自动 update，
    // 热路径只做一次 O(1) 的主矿区查询供 UI/测试读取，零新建 GPU 资源。
    this._districts?.update(this._ctx?.camera);

    this._updateAnimations(dt);

    // 【模块 8】坐下 / 起身相机插值 + 坐姿环顾
    this._updateSit(dt);

    // 【模块 8】世纪钟大厅地标：每帧读系统时间（平滑扫秒），夜色平滑跟随昼夜模式
    if (this._clockTower) {
      this._clockTower.tick(new Date());
      const target = dayNightCycle.mode === 'night' ? 1 : dayNightCycle.mode === 'sunset' ? 0.5 : 0;
      this._clockNightF += (target - this._clockNightF) * (1 - Math.exp(-3 * dt));
      this._clockTower.setNight(this._clockNightF);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* dispose —— 七步清理 + 状态存档（每步独立 try/catch，单步失败不中断）     */
  /* ------------------------------------------------------------------------ */

  _step(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[Lobby] dispose 步骤「${label}」失败（继续后续清理）：`, err); }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    /* ---------- 步骤 0：相机交接（保持当前 orbit 视角，不还原接管前的旧机位） ----------
     * 下一个设施 init 会把「当前相机」存为 _cameraSaved，其退出过渡/恢复的
     * 目标即大厅视角，与 lobby.init 从 _lobbyMemory 还原的机位一致 → 无缝。
     * OrbitControls 的相机姿态就是当前姿态，无需任何 snap，只刷新世界矩阵。
     * fov 同样保持大厅当前值，交由下次 init 的 _fitViewport 复算。
     */
    /* ---------- 步骤 0-a：【模块 8】坐立状态还原 ----------
     * 若玩家正坐着就切设施，直接 dispose 会把坐姿机位写进 _lobbyMemory，
     * 退出后视角会卡在椅子里。这里强制还原站立机位并交还 OrbitControls。 */
    this._step('坐下状态还原', () => {
      if (this._sitState === 'none') return;
      const cam = this._ctx?.camera;
      const controls = this._controls;
      if (cam && this._sitSaved) {
        cam.position.copy(this._sitSaved.position);
        cam.quaternion.copy(this._sitSaved.quaternion);
        cam.rotation.order = this._sitSaved.rotationOrder;
        cam.fov = this._sitSaved.fov;
        cam.updateProjectionMatrix();
      }
      if (controls && this._sitSaved) {
        controls.target.copy(this._sitSaved.target);
        if (this._inputMode === 'wasd') {
          controls.enabled = false; // WASD 模式仍由第一人称控制器持有相机
          if (cam) this._wasd?.resetFromCamera(cam);
        } else {
          controls.enabled = true;
          controls.update();
        }
      }
      this._sitState = 'none';
      this._sitSaved = null;
      this._sitBench = null;
      this._setSitUI(false);
    });

    try {
      const camera = this._ctx?.camera;
      if (camera) camera.updateMatrixWorld(true);
    } catch (err) {
      console.error('[Lobby] dispose 步骤「相机交接」失败（继续后续清理）：', err);
    }

    /* ---------- 步骤 0-b：【M5a 核心】状态存档 ----------
     * 大厅每次切换小游戏都被彻底 dispose；把 orbit 机位与目标点写入模块级
     * 单例，下一次 init() 读回 → 退出后视角与缩放完全不变。
     */
    this._step('状态存档 _lobbyMemory', () => {
      const camera = this._ctx?.camera;
      const controls = this._controls;
      // T02：WASD 模式下 controls.target 还是进入前的旧值。先用当前第一人称
      // 机位反算一个合法 orbit target，下次 init 的 controls.update() 才不会夹走机位。
      if (camera && controls && this._inputMode === 'wasd') {
        controls.target.copy(this._orbitTargetFromPose(camera));
      }
      const target = controls?.target;
      if (camera) {
        _lobbyMemory.cam.x = camera.position.x;
        _lobbyMemory.cam.y = camera.position.y;
        _lobbyMemory.cam.z = camera.position.z;
      }
      if (target) {
        _lobbyMemory.tgt.x = target.x;
        _lobbyMemory.tgt.y = target.y;
        _lobbyMemory.tgt.z = target.z;
      }
      console.info(
        `[Lobby] 已存档 cam=(${_lobbyMemory.cam.x.toFixed(2)}, ${_lobbyMemory.cam.y.toFixed(2)}, ${_lobbyMemory.cam.z.toFixed(2)}) ` +
        `tgt=(${_lobbyMemory.tgt.x.toFixed(2)}, ${_lobbyMemory.tgt.y.toFixed(2)}, ${_lobbyMemory.tgt.z.toFixed(2)})`
      );
    });

    /* ---------- 步骤 0-c：场景外观 / 外部灯光 / 阴影配置恢复 ----------
     * 【审查修正】旧版此处有一段 `if (this._dirLight) shadow.dispose()`，并把它
     * 注释成「最关键的泄漏防线」。但白天化重构后 _dirLight / _ambientLight
     * 恒为 null，该分支永不进入 —— 是误导性的死代码。
     * 真实归属：投影光是 SceneManager 的常驻方向光，其 shadow.map
     * （WebGLRenderTarget，color + depthTexture 计入 info.memory.textures）
     * 由渲染器惰性创建并常驻，归 SceneManager.dispose() 释放。每次切换都
     * 【不应】释放它，否则下次激活要重新分配、基线反而波动。
     * 因此本步骤只恢复登记过的全局状态，不触碰常驻阴影贴图。
     */
    this._step('场景外观 / 灯光 / 阴影配置恢复', () => {
      const { scene, renderer } = this._ctx || {};
      if (scene && this._sceneSaved) {
        scene.background = this._sceneSaved.background;
        scene.fog = this._sceneSaved.fog;
      }
      for (const item of this._externalLights) {
        item.light.intensity = item.intensity;
        item.light.castShadow = item.castShadow;
      }
      this._externalLights = [];

      if (renderer && this._shadowSaved) {
        renderer.shadowMap.enabled = this._shadowSaved.enabled;
        renderer.shadowMap.type = this._shadowSaved.type;
      }
      // 本类不自建光源：这两项自白天化重构后恒为 null，仅置空保持台账一致
      this._dirLight = null;
      this._ambientLight = null;
    });

    /* ---------- 步骤 1：指针事件解绑 + OrbitControls 销毁 ---------- */
    this._step('指针事件解绑 / OrbitControls 销毁', () => {
      this._removeListenersByTag('input'); // blur / visibilitychange / pointer(M) / pointerdown/move/up/cancel
      // T02：WASDController 自己持有监听，必须显式 dispose。
      // 【T03 集成修复】一次性收尾【只针对本类自己的未完过渡】；若此刻是嵌入视图
      // 的 blend/restore 在跑（cameraRig.owner !== 'lobby-wasd'），绝不能用 update(1e6)
      // 把别人的过渡瞬间做完 —— 那会让 FacilityRuntime 的相机握手错乱。
      if (this._wasdBlendActive && cameraRig.isTransitioning) cameraRig.update(1e6);
      this._wasd?.dispose();
      this._wasd = null;
      if (cameraRig.owner === 'lobby-wasd') {
        cameraRig.releaseOwner('lobby-wasd');
        cameraRig.setOwner('lobby'); // 还原 FacilityRuntime 的大厅默认 owner
      }
      this._rigOwner = null;
      this._wasdBlendActive = false;
      this._wasdBlendKind = null;
      this._pendingOrbitTarget = null;
      this._inputMode = 'orbit';
      this._controls?.dispose(); // 成对解绑 OrbitControls 挂在 canvas/window 上的全部监听
      this._controls = null;
      this._dragging = false;
      this._pointerDown = null;
      this._lastPointer = null;
      const canvas = this._ctx?.renderer?.domElement;
      if (canvas) canvas.style.cursor = '';
    });

    /* ---------- 步骤 2：清除全部定时器 ---------- */
    this._step('定时器', () => {
      this._clearAllTimers();
      this._toastTimeoutId = null;
    });

    /* ---------- 步骤 3：移除 DOM 监听 / UI 节点 / <style> ---------- */
    this._step('UI 与监听', () => {
      this._removeListenersByTag('ui');
      for (const { target, type, fn, options } of this._listeners) {
        try { target.removeEventListener(type, fn, options); } catch { /* 已解绑 */ }
      }
      this._listeners = [];
      // 【模块 7】注销昼夜系统对本轮 Sky / 材质的引用，避免悬挂已释放对象；
      // 同时解绑 onChange 订阅（否则每次来回切换都会累积一个闭包 → 真泄漏）。
      try { this._offTimeChange?.(); } catch (err) { /* 已解绑 */ }
      this._offTimeChange = null;
      dayNightCycle.unregisterSky();
      dayNightCycle.clearLobbyMaterials();
      // 【模块 8】清空本轮 AABB 引用，避免悬挂到已释放的场景对象
      npcManager.setObstacles([]);
      this._uiRoot?.remove();
      this._uiStyle?.remove();
      this._uiRoot = null;
      this._uiStyle = null;
      this._ui = {};
      // 动物园：instanceMatrix 等独立 buffer 成对释放（GPU 资源步骤已遍历过一次）
      this._zoo?.dispose();
      this._zoo = null;
      this._zooFly = null;
      this._zooView = false;
      // 【M7】四宫格骨架：移除 group + 释放 instanceMatrix / 自建材质（幂等）
      this._districts?.dispose();
      this._districts = null;
      this._orbitKeys.clear();   // 【M1】orbit 平移按键状态随实例一起释放
    });

    /* ---------- 步骤 4：Rapier 刚体（本类全程禁用，确认为 0） ---------- */
    this._step('物理刚体', () => {
      for (const c of this._standaloneColliders || []) {
        this._ctx?.world?.removeCollider(c, true);
      }
      this._standaloneColliders = [];
      console.info('[Lobby] 物理资源：全程禁用 Rapier，刚体数 0');
    });

    /* ---------- 步骤 5：GPU 资源（几何 / 材质 / 纹理 + uniforms 扫描） ---------- */
    this._step('GPU 资源', () => this._disposeThreeResources());

    /* ---------- 步骤 6：台账与状态清空 ---------- */
    this._step('台账清空', () => {
      this.root.clear(); // 从 scene 移除由 AttractionManager 第 ③ 步负责
      this._pickables.length = 0;
      this._buildingBoxes.length = 0;
      this._instancedMeshes.length = 0;
      this._entranceSigns.clear();
      this._entranceArrows.length = 0;
      this._billboardLabels.length = 0;
      this._hoverKey = null;
      this._controls = null;
      this._wheelGroup = null;
      // T04b-c：清空座舱变换宿主与部件描述（instanceMatrix 由 GPU 资源步骤的
      // isInstancedMesh.dispose() 成对回收；几何/材质都是 S 共享，不在此处释放）
      this._wheelCabins.length = 0;
      this._wheelCabinParts.length = 0;
      // T07：常驻动效宿主均为空 Group / 共享几何 Mesh，只清引用，GPU 资源走既有台账
      this._carouselFacadeSpin = null;
      this._pirateFacadePivot = null;
      this._stationTrain = null;
      this._stationTrainWheels.length = 0;
      this._coasterCurve = null;
      this._coasterCars?.dispose();
      this._coasterCars = null;
      this._coinMeshes.length = 0;
      this._memoryCards.length = 0;
      this._particleClouds.length = 0;
      this._triggerRings.length = 0;
      this._fountainWater = null;
      this._lods = {};
      this._lodCenters = {};
      this._sky = null;
      this._clouds = null;
      this._cloudLayers = [];
      this._cloudSprites = null;
      this._contactShadows = null;
      this._treePositions = [];
      // 【模块 8】钟塔资源已通过 track 登记进上面三个台账，会随台账统一释放；
      // 这里只清引用（不再调 tower.dispose()，避免重复 dispose）。
      this._clockTower = null;
      this._clockNightF = 0;
      this._benchSpots = [];
      this._benchPickables = [];
      this._hoverBenchIndex = -1;
      this._geometries.clear();
      this._materials.clear();
      this._textures.clear();
      this._shared = {};
      this._cameraSaved = null;
      this._sceneSaved = null;
      this._shadowSaved = null;
      this._ctx = null;
    });

    console.info(
      `[Lobby] dispose 完成 | _listeners=${this._listeners.length} ` +
      `刚体=0 | OrbitControls 已销毁 | 存档已写入`
    );
  }

  _disposeThreeResources() {
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);

    this.root.traverse((obj) => {
      // InstancedMesh 的 instanceMatrix 是独立 GPU buffer，需单独释放
      if (obj.isInstancedMesh && typeof obj.dispose === 'function') {
        try { obj.dispose(); } catch (err) { console.error('[Lobby] InstancedMesh dispose 失败：', err); }
      }
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      if (obj.geometry) geometries.add(obj.geometry);
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x && materials.add(x));
      else if (m) materials.add(m);
    });

    const refs = [];
    let index = 0;
    for (const material of materials) {
      refs.push(...collectMaterialTextureReferences(material, index));
      index += 1;
    }
    const texturePlan = new Map();
    const add = (texture, source) => {
      if (!texture || !texture.isTexture) return;
      if (!texturePlan.has(texture)) texturePlan.set(texture, { sources: [], disposeCalled: false });
      const meta = texturePlan.get(texture);
      if (!meta.sources.includes(source)) meta.sources.push(source);
    };
    for (const tex of this._textures) add(tex, '台账');
    for (const ref of refs) add(ref.texture, ref.path);

    for (const [texture, meta] of texturePlan) {
      try { texture.dispose(); meta.disposeCalled = true; }
      catch (err) { console.error(`[Lobby:纹理] uuid=${texture.uuid} dispose 失败：`, err); }
    }
    // 路径数组【不去重】：共享纹理的每条引用都要断开（M2 修复结论）
    const cleared = [];
    for (const ref of refs) {
      try { ref.clear(); cleared.push(ref.path); }
      catch (err) { console.error(`[Lobby:纹理] 断开引用 ${ref.path} 失败：`, err); }
    }
    const clearedSet = new Set(cleared);
    const summary = [];
    for (const [texture, meta] of texturePlan) {
      const own = refs.filter((r) => r.texture === texture).map((r) => r.path);
      summary.push({
        uuid: texture.uuid,
        name: texture.name || '-',
        '来源': meta.sources.join(' | '),
        'dispose() 已调用': meta.disposeCalled ? '是' : '否',
        '引用已断开': own.every((p) => clearedSet.has(p)) ? '是' : '否',
      });
    }
    console.table(summary);
    for (const material of materials) {
      try { material.dispose(); } catch (err) { console.error('[Lobby] 材质 dispose 失败：', err); }
    }
    for (const geometry of geometries) {
      try { geometry.dispose(); } catch (err) { console.error('[Lobby] 几何体 dispose 失败：', err); }
    }
    console.info(
      `[Lobby] GPU 资源释放 | geometry=${geometries.size} material=${materials.size} ` +
      `texture=${texturePlan.size} 引用路径=${cleared.length}`
    );
  }
}

export default Lobby;
