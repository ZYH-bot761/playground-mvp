/** 程序化城市纹理：蓝绿玻璃幕墙、夜间亮窗、学校跑道。全部 1 次生成后共享。 */
import * as THREE from 'three';

const srgb = (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
};

export function makeGlassFacade(tint = '#2d6070') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  const base = g.createLinearGradient(0, 0, 256, 512);
  base.addColorStop(0, tint);
  base.addColorStop(0.45, '#356f7d');
  base.addColorStop(1, '#23505d');
  g.fillStyle = base; g.fillRect(0, 0, 256, 512);
  // 玻璃竖向反射噪点
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 256, y = Math.random() * 512;
    g.fillStyle = `rgba(${120 + Math.random() * 110},${190 + Math.random() * 60},${205 + Math.random() * 50},${0.025 + Math.random() * 0.09})`;
    g.fillRect(x, y, 1 + Math.random() * 3, 4 + Math.random() * 22);
  }
  // 楼层横梁 + 竖梃
  g.fillStyle = 'rgba(180,215,222,.30)';
  for (let y = 0; y < 512; y += 16) g.fillRect(0, y, 256, 2);
  g.fillStyle = 'rgba(210,235,240,.24)';
  for (let x = 0; x < 256; x += 16) g.fillRect(x, 0, 2, 512);
  // 日间少量反射亮窗
  for (let i = 0; i < 70; i++) {
    const x = 4 + Math.floor(Math.random() * 15) * 16;
    const y = 4 + Math.floor(Math.random() * 31) * 16;
    g.fillStyle = `rgba(170,230,245,${0.04 + Math.random() * 0.10})`;
    g.fillRect(x, y, 10, 10);
  }
  return srgb(new THREE.CanvasTexture(c));
}

/**
 * 夜间亮窗。提质：从"每格独立随机"改为带空间相关性的城市夜景——
 * ① 整层成簇亮灯（同层同向办公室一起亮）；② 楼层节律（低层商铺常亮、
 * 中段办公、顶层稀疏）；③ 色温分区（一层偏暖或偏冷，不逐格乱跳）；
 * ④ 窗帘/百叶半遮挡（下半窗拉帘的暖光更暗更长）；⑤ 少量空暗层做节奏。
 * 仍是 256×512 CanvasTexture，零增面、零 draw call、三档 LOD 共用。
 */
export function makeNightWindows() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 512);
  // 每层一个"色温"与"活跃度"，制造成簇亮灯而非椒盐噪点
  const floorWarm = [];
  const floorActivity = [];
  for (let fy = 0; fy < 32; fy++) {
    floorWarm.push(Math.random() < 0.72);
    // 低层(0-3)商铺活跃度高；顶层(28-31)稀疏；中段随机但同层一致
    const low = fy < 4, top = fy >= 28;
    floorActivity.push(low ? 0.72 : top ? 0.16 : 0.24 + Math.random() * 0.34);
  }
  for (let fy = 0; fy < 32; fy++) {
    const warm = floorWarm[fy];
    const lum = floorActivity[fy];
    // 每 4-6 层随机留一层全暗（设备层/空置层），增加竖向节奏
    const darkFloor = fy % 5 === 3 && Math.random() < 0.6;
    for (let fx = 0; fx < 16; fx++) {
      if (darkFloor || Math.random() > lum) continue;
      const px = 4 + fx * 16, py = 4 + fy * 16;
      const lit = 0.55 + Math.random() * 0.45;
      if (warm) {
        g.fillStyle = `rgba(255,${178 + Math.random() * 52 | 0},${104 + Math.random() * 58 | 0},${lit})`;
      } else {
        g.fillStyle = `rgba(${146 + Math.random() * 46 | 0},${212 + Math.random() * 36 | 0},255,${lit * 0.92})`;
      }
      g.fillRect(px, py, 10, 9);
      // 窗帘/百叶：约 30% 亮窗下半部拉帘，用同色低透覆盖，形成"半亮窗"
      if (Math.random() < 0.30) {
        g.fillStyle = warm ? 'rgba(120,74,44,.55)' : 'rgba(48,72,96,.5)';
        g.fillRect(px, py + 4, 10, 5);
      }
    }
  }
  return srgb(new THREE.CanvasTexture(c));
}

/**
 * 玻璃幕墙法线贴图。由与 makeGlassFacade 相同的 16px 横梁/竖梃网格生成，
 * 让玻璃在光照下有真实的窗框凹凸高光，告别"平面贴纸"观感。
 * 零增面；返回线性数据纹理（非 sRGB）。
 */
export function makeGlassNormalMap() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  // 平法线底色 (128,128,255)
  g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, 256, 512);
  const S = 16;
  // 竖梃：左右两侧法线向 ±X 倾斜
  for (let x = 0; x < 256; x += S) {
    g.fillStyle = 'rgb(78,128,242)'; g.fillRect(x, 0, 2, 512);
    g.fillStyle = 'rgb(178,128,242)'; g.fillRect(x + 2, 0, 2, 512);
  }
  // 横梁：上下两侧法线向 ±Y 倾斜
  for (let y = 0; y < 512; y += S) {
    g.fillStyle = 'rgb(128,80,242)'; g.fillRect(0, y, 256, 2);
    g.fillStyle = 'rgb(128,176,242)'; g.fillRect(0, y + 2, 256, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  // 法线贴图保持 NoColorSpace（线性），不要走 srgb()
  return tex;
}

/**
 * 玻璃/屋顶粗糙度贴图：打破"整栋一个 roughness 常数"。
 * 灰阶：窗框略粗糙、玻璃镜面、随机水渍/污痕。零增面。
 */
export function makeGlassRoughness() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, 256, 512); // 基础 roughness ≈0.35
  // 玻璃格内更光滑
  for (let y = 0; y < 512; y += 16) {
    for (let x = 0; x < 256; x += 16) {
      const v = 60 + Math.random() * 40 | 0;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x + 2, y + 2, 12, 12);
    }
  }
  // 窗框略粗糙
  g.fillStyle = '#8a8a8a';
  for (let y = 0; y < 512; y += 16) g.fillRect(0, y, 256, 2);
  for (let x = 0; x < 256; x += 16) g.fillRect(x, 0, 2, 512);
  // 少量竖向水渍（低粗糙带）
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(40,40,40,${0.04 + Math.random() * 0.06})`;
    g.fillRect(Math.random() * 256, Math.random() * 400, 1 + Math.random() * 2, 40 + Math.random() * 90);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export function makeTrackTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 320;
  const g = c.getContext('2d');
  g.fillStyle = '#4d9a55'; g.fillRect(0, 0, 512, 320);
  g.fillStyle = '#b34b3e';
  g.beginPath(); g.ellipse(256, 160, 220, 128, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#4d9a55';
  g.beginPath(); g.ellipse(256, 160, 150, 68, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#f4f1e6'; g.lineWidth = 3;
  for (const r of [[220, 128], [150, 68]]) {
    g.beginPath(); g.ellipse(256, 160, r[0], r[1], 0, 0, Math.PI * 2); g.stroke();
  }
  // 足球场草纹
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2;
  g.strokeRect(176, 120, 160, 80);
  g.beginPath(); g.moveTo(256, 120); g.lineTo(256, 200); g.stroke();
  g.beginPath(); g.arc(256, 160, 24, 0, Math.PI * 2); g.stroke();
  return srgb(new THREE.CanvasTexture(c));
}

/**
 * 沥青路面细节：接近白色的骨料噪点（作 map 与 instanceColor 相乘不脏色），
 * 加淡砖缝给人行道质感。作 roughnessMap 打破整条路一个 roughness 常数。
 */
export function makeAsphaltDetail() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  // 近白底：与 instanceColor 相乘几乎不改变原色，只叠加细节
  g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 256, 256);
  // 沥青骨料细点
  for (let i = 0; i < 5200; i += 1) {
    const v = 200 + ((Math.random() * 55) | 0);
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
  }
  // 稀疏裂纹/接缝（低对比，避免脏）
  g.strokeStyle = 'rgba(120,120,120,0.18)'; g.lineWidth = 1;
  for (let i = 0; i < 14; i += 1) {
    const x = Math.random() * 256, y = Math.random() * 256;
    g.beginPath(); g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 40);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.anisotropy = 4;
  return tex;
}

/** 人行道砖纹：淡灰白砖缝，作 map 给纯色人行道条带质感。 */
export function makePavementDetail() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(110,112,108,0.22)'; g.lineWidth = 2;
  for (let y = 0; y <= 256; y += 32) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  for (let row = 0; row < 8; row += 1) {
    const off = row % 2 ? 16 : 0;
    for (let x = off; x <= 256; x += 32) {
      g.beginPath(); g.moveTo(x, row * 32); g.lineTo(x, row * 32 + 32); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.anisotropy = 4;
  return tex;
}

export function makeParkingTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3b4249'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#e8e3cd'; g.lineWidth = 4;
  for (let x = 20; x < 256; x += 52) {
    g.beginPath(); g.moveTo(x, 10); g.lineTo(x, 120); g.stroke();
  }
  return srgb(new THREE.CanvasTexture(c));
}
