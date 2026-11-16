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

export function makeNightWindows() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 512);
  for (let fy = 0; fy < 32; fy++) {
    for (let fx = 0; fx < 16; fx++) {
      if (Math.random() < 0.68) continue;
      const warm = Math.random() < 0.72;
      g.fillStyle = warm
        ? `rgba(255,${180 + Math.random() * 55 | 0},${110 + Math.random() * 60 | 0},${0.45 + Math.random() * 0.55})`
        : `rgba(${140 + Math.random() * 50 | 0},${210 + Math.random() * 40 | 0},255,${0.35 + Math.random() * 0.5})`;
      g.fillRect(4 + fx * 16, 4 + fy * 16, 10, 9);
    }
  }
  return srgb(new THREE.CanvasTexture(c));
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
