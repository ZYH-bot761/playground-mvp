/**
 * ============================================================================
 * DistrictLabels —— 三区 Sprite 文字标签（城堡屋 / 农家乐 / 动物园）
 * ============================================================================
 * - THREE.Sprite 天然 billboard，始终正对相机，无需逐帧 update。
 * - CanvasTexture 用高分辨率画布 + 描边 + 半透明胶囊底，远处也清晰。
 * - 挂在 scene 根（常驻，不随 Lobby 重建反复 dispose），启动时用
 *   renderer.initTexture() 主动上传，保证任何验收机位下 GPU 计数一致。
 * - 自带 dispose()，3 texture + 3 material 成对释放。
 * ============================================================================
 */
import * as THREE from 'three';
import { DISTRICT_GRID } from '../attractions/Districts.js';

const LABELS = [
  { key: 'castle', text: '城堡屋', y: 42, fill: '#fff2fb', stroke: '#b4498d', bg: 'rgba(120,40,95,0.55)' },
  { key: 'farm', text: '农家乐', y: 24, fill: '#f4ffe6', stroke: '#4c7a24', bg: 'rgba(45,85,25,0.55)' },
  { key: 'zoo', text: '动物园', y: 20, fill: '#eaf6ff', stroke: '#245f96', bg: 'rgba(25,60,105,0.55)' },
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLabelTexture(spec) {
  const canvas = document.createElement('canvas');
  canvas.width = 768; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 半透明毛玻璃胶囊底
  ctx.fillStyle = spec.bg;
  roundRect(ctx, 24, 32, 720, 192, 88);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.stroke();
  // 文字（粗体 + 描边，保证远景可读）
  ctx.font = 'bold 130px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 16;
  ctx.strokeStyle = spec.stroke;
  ctx.strokeText(spec.text, 384, 130);
  ctx.fillStyle = spec.fill;
  ctx.fillText(spec.text, 384, 130);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `DistrictLabels/${spec.key}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export class DistrictLabels {
  constructor() {
    this.root = null;
    this._textures = [];
    this._materials = [];
    this._sprites = [];
  }

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  build(scene, renderer) {
    if (this.root) return this;
    this.root = new THREE.Group();
    this.root.name = 'DistrictLabels/root';
    const Q = DISTRICT_GRID.quadrants;
    for (const spec of LABELS) {
      const q = Q[spec.key];
      if (!q) continue;
      const tex = makeLabelTexture(spec);
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, fog: false,
        sizeAttenuation: true, toneMapped: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.name = `DistrictLabels/${spec.key}`;
      sprite.userData.labelText = spec.text;
      sprite.userData.district = spec.key;
      sprite.position.set(q.cx, spec.y, q.cz);
      sprite.scale.set(17, 5.67, 1);
      sprite.renderOrder = 20;
      // Sprite 内置固定包围球（0.707×scale），不会误剔除；保持 true 以免
      // 相机背对四宫格时仍强制提交 3 个 draw call，守住 30 万面 / calls 红线
      sprite.frustumCulled = true;
      this.root.add(sprite);
      this._textures.push(tex);
      this._materials.push(mat);
      this._sprites.push(sprite);
      // 主动上传：任何验收机位下 texture 计数恒定，杜绝 Δtex 假阳性
      try { renderer?.initTexture?.(tex); } catch (e) { /* 老版本 three 兜底 */ }
    }
    scene.add(this.root);
    return this;
  }

  setVisible(v = true) { if (this.root) this.root.visible = !!v; return this; }
  get visible() { return this.root ? this.root.visible : false; }

  dispose() {
    for (const t of this._textures) { try { t.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    this._textures.length = 0;
    this._materials.length = 0;
    this._sprites.length = 0;
    if (this.root?.parent) this.root.parent.remove(this.root);
    this.root = null;
  }
}

export const districtLabels = new DistrictLabels();
export default districtLabels;
