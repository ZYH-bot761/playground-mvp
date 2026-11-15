/**
 * ============================================================================
 * JumpJump.js —— 模块 2：跳一跳（替换旧「弹跳碰碰球」BouncingBall.js）
 * ============================================================================
 * 复刻微信《跳一跳》：黑色小人在方块间跳跃；长按蓄力、松手沿抛物线飞出；
 * 落空即结束；落块 +1、中心 +2 且连击递增；特殊方块停留触发彩蛋加分。
 *
 * 【契约】init/update/onInteract/dispose（onInteract 无 3D 拾取，UI 全 DOM）。
 * 【资源】固定对象池（方块 ~14 个），游玩中几何数恒定 → 无泄漏。
 * 【物理】预计算完整抛物线再插值（不逐帧积分），同力度落点确定性一致（误差 0）。
 * 【相机】始终朝向球体、固定距离；跳跃垂直延迟跟随（lerp 0.1）；蓄力拉近 8→5；落地向下冲击 0.2 后恢复。
 * 【色彩】所有 CanvasTexture 设 SRGBColorSpace（0.5）。
 * ============================================================================
 */
import * as THREE from 'three';
import { buildCharacter } from '../../utils/helpers/procedural-character.js';

const MIN_DIST = 0.5, MAX_DIST = 6.0;     // 蓄力距离区间
const CHARGE_MAX = 2.0;                    // 蓄力上限（秒）
const G = 24;                              // 游戏感重力
const PERFECT_RATIO = 0.18;               // 完美中心判定的半径比例
const OK_RATIO = 0.95;                    // 落在方块内的最大半径比例
const BLOCK_POOL = 14;
const STAY_TRIGGER = 2.0;                  // 特殊方块停留触发秒数
const BASE_SIZE = 2.0, MIN_SIZE = 0.6;
const SHRINK_PER_500 = 0.05;              // 每 500 分边长 ×0.95

const CAM_DIST_NORMAL = 8.0;              // 常态相机到球距离
const CAM_DIST_CHARGE = 5.0;              // 蓄力拉近目标距离
const CAM_FOLLOW = 0.1;                   // 跟随 lerp 系数（手册 0.05~0.15）
const CAM_DIP = 0.2;                      // 落地向下冲击幅度

const SPECIAL = ['music', 'convenience', 'cube', 'manhole'];
const SPECIAL_BONUS = { music: 30, convenience: 15, cube: 10, manhole: 5 };

export class JumpJump {
  constructor() {
    this.root = null;
    this._disposed = false;
    this._ctx = null;

    this._state = 'ready';      // ready | charging | jumping | falling | result
    this._score = 0;
    this._combo = 0;
    this._maxCombo = 0;
    this._specialHit = 0;

    this._chargeT = 0;
    this._jumpT = 0;
    this._jumpDur = 0;
    this._jumpFrom = new THREE.Vector3();
    this._jumpTo = new THREE.Vector3();
    this._jumpFromTop = 0; this._jumpToTop = 0;
    this._vSpeed = 0;

    this._current = -1;         // 当前所站方块索引
    this._next = -1;            // 目标方块索引
    this._lastSpecial = null;

    this._stayT = 0;            // 停留计时（特殊方块彩蛋）
    this._fallT = 0;

    this._tmpV = new THREE.Vector3();
    this._camDesired = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camBase = new THREE.Vector3();
    this._camDir = new THREE.Vector3(0, 0, -1);
    this._camDist = CAM_DIST_NORMAL;
    this._camDip = 0;
    this._dummy = new THREE.Object3D();

    this._geometries = [];
    this._materials = [];
    this._textures = [];

    this._blocks = [];
    this._ui = null;
    this._styleEl = null;

    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  /* --------------------------- 资源登记辅助 --------------------------- */
  _geo(g) { this._geometries.push(g); return g; }
  _mat(m) { this._materials.push(m); return m; }
  _tex(t) { t.colorSpace = THREE.SRGBColorSpace; this._textures.push(t); return t; }

  /* ============================ init ============================ */
  init(ctx) {
    if (this._disposed) return;
    this._ctx = ctx;
    const { scene, camera, renderer } = ctx;

    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      up: camera.up.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };

    this.root = new THREE.Group();
    this.root.name = 'JumpJump';
    this.root.userData.attractionRoot = true;
    scene.add(this.root);

    this._sceneBgSaved = scene.background;
    this._sceneFogSaved = scene.fog;
    // 颜色线性空间 ×0.38：抵消基座 exposure=1.0（手册 P5）
    scene.background = new THREE.Color(0xdfe9f2).multiplyScalar(0.38);
    scene.fog = new THREE.Fog(new THREE.Color(0xdfe9f2).multiplyScalar(0.38), 40, 140);

    this._buildSky();
    this._buildGround();
    this._buildLights();
    this._buildPlayer();
    this._buildBlockPool();
    this._buildUI();

    window.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    for (const g of this._geometries) ctx.registerDisposable?.(g);
    for (const m of this._materials) ctx.registerDisposable?.(m);
    for (const t of this._textures) ctx.registerDisposable?.(t);

    this._resetGame();
    this._snapCamera();
  }

  _buildSky() {
    const tex = this._tex(this._makeGradient());
    const geo = this._geo(new THREE.SphereGeometry(120, 24, 16));
    // 手册 P5 弃用 Basic：天空穹顶用 Standard「黑 color + emissiveMap」等效无 lit，
    // emissiveIntensity 0.38 抵消 exposure=1.0，成像与旧方案一致。
    const mat = this._mat(new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.38,
      side: THREE.BackSide, fog: false,
    }));
    this._sky = new THREE.Mesh(geo, mat);
    this.root.add(this._sky);
  }
  _makeGradient() {
    const c = document.createElement('canvas'); c.width = 16; c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#aacbf0'); grd.addColorStop(0.5, '#cfe0f0'); grd.addColorStop(1, '#f3ede2');
    g.fillStyle = grd; g.fillRect(0, 0, 16, 256);
    return new THREE.CanvasTexture(c);
  }

  _buildGround() {
    const geo = this._geo(new THREE.PlaneGeometry(400, 400));
    // 手册 P5：禁止纯色地面 → 程序化地砖（方格+缝隙+噪点）+ 缝凹凸法线
    const texTiles = this._tex(this._makeTiles());
    texTiles.wrapS = texTiles.wrapT = THREE.RepeatWrapping;
    texTiles.repeat.set(25, 25);
    const texNormal = this._makeTileNormal(); // 数据纹理：不设 SRGB，直接登记
    this._textures.push(texNormal);
    texNormal.wrapS = texNormal.wrapT = THREE.RepeatWrapping;
    texNormal.repeat.set(25, 25);
    const mat = this._mat(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: texTiles, normalMap: texNormal,
      normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.9, metalness: 0,
    }));
    this._ground = new THREE.Mesh(geo, mat);
    this._ground.rotation.x = -Math.PI / 2;
    this._ground.position.y = 0;
    this._ground.receiveShadow = true;
    this.root.add(this._ground);
  }

  /** 地砖 albedo：512×512，4×4 块 + 深色砖缝 + 逐块色差 + 细噪点 */
  _makeTiles() {
    const size = 512;
    const tile = size / 4;
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#b8ac97'; // 砖缝
    g.fillRect(0, 0, size, size);
    let seed = 12345;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let ty = 0; ty < 4; ty += 1) {
      for (let tx = 0; tx < 4; tx += 1) {
        const v = 0.92 + rnd() * 0.12;
        g.fillStyle = `rgb(${Math.round(233 * v)}, ${Math.round(226 * v)}, ${Math.round(212 * v)})`;
        g.fillRect(tx * tile + 3, ty * tile + 3, tile - 6, tile - 6);
      }
    }
    // 细噪点：打破「纯平色块」感
    const img = g.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 14;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  }

  /** 地砖法线：砖缝凹陷的高度场 → 中心差分编码（与 albedo 同一 4×4 布局） */
  _makeTileNormal() {
    const size = 256;
    const tile = size / 4;
    const height = new Float32Array(size * size);
    let seed = 9876;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const lx = x % tile; const ly = y % tile;
        const edge = Math.min(lx, tile - 1 - lx, ly, tile - 1 - ly);
        height[y * size + x] = Math.min(edge / 3, 1) * 0.6 + (rnd() - 0.5) * 0.08;
      }
    }
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2;
        const dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const i = (y * size + x) * 4;
        img.data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
        img.data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
        img.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  }

  _buildLights() {
    // 光强 ×0.38：抵消基座 exposure=1.0（手册 P5），成像与旧方案等价
    this._light = new THREE.HemisphereLight(0xffffff, 0xd8cdb8, 0.38);
    this.root.add(this._light);
    this._sun = new THREE.DirectionalLight(0xfff4e0, 0.42);
    this._sun.position.set(8, 18, 10);
    this._sun.castShadow = true;
    this._sun.shadow.mapSize.set(1024, 1024);
    this._sun.shadow.camera.near = 1; this._sun.shadow.camera.far = 60;
    this._sun.shadow.camera.left = -30; this._sun.shadow.camera.right = 30;
    this._sun.shadow.camera.top = 30; this._sun.shadow.camera.bottom = -30;
    this.root.add(this._sun);
    this.root.add(this._sun.target);
  }

  _buildPlayer() {
    // v4 T10：旧版「黑色胶囊 + 圆球」升级为 7.3 头身关节化角色。
    // 尺寸放在 rig.body 内层（scale 0.66 → 高约 1.17m，贴合跳一跳小人的
    // 棋盘比例）；外层 group 恒为 scale=1，蓄力压扁 / 每局复位不会被覆盖。
    const rig = buildCharacter({
      style: 'jumper',
      scale: 0.66,
      name: 'JumpJump/player',
      palette: {
        coat: 0x2b3038, pants: 0x252a31, skin: 0xe8bd94,
        hair: 0x241c18, shoe: 0x1b1e24,
        hairStyle: 'short', sleeve: 'long', accessory: 'none',
      },
    });
    for (const g of rig.userData.disposables.geometries) this._geo(g);
    for (const m of rig.userData.disposables.materials) this._mat(m);
    this._playerRig = rig.userData.rig;
    this._charPhase = 0;
    this._playerMesh = rig;
    this.root.add(rig);
  }

  /**
   * 纯视觉关节动画：不影响蓄力/抛物线/落点判定，逐帧只改 rotation，零 new。
   * 保持原有「ready 站立 → charging 下蹲 → jumping 腾空 → falling 掉落」节奏。
   */
  _animatePlayer(dt) {
    const rig = this._playerRig;
    if (!rig) return;
    this._charPhase += dt * 4.2;
    const s = Math.sin(this._charPhase);
    // 每帧从自然站姿出发再按状态叠加，避免状态切换残留上一姿态
    rig.armL.rotation.set(0, 0, 0);
    rig.armR.rotation.set(0, 0, 0);
    rig.elbowL.rotation.set(0, 0, 0);
    rig.elbowR.rotation.set(0, 0, 0);
    rig.legL.rotation.set(0, 0, 0);
    rig.legR.rotation.set(0, 0, 0);
    rig.kneeL.rotation.set(0, 0, 0);
    rig.kneeR.rotation.set(0, 0, 0);
    rig.head.rotation.set(0, 0, 0);
    if (this._state === 'jumping') {
      // 腾空：双臂上举、双腿收拢，强化抛物线手感
      rig.armL.rotation.x = -2.1;
      rig.armR.rotation.x = -2.1;
      rig.elbowL.rotation.x = -0.4;
      rig.elbowR.rotation.x = -0.4;
      rig.legL.rotation.x = -0.55;
      rig.legR.rotation.x = 0.35;
      rig.kneeL.rotation.x = 0.75;
      rig.kneeR.rotation.x = 0.35;
    } else if (this._state === 'falling') {
      // 落空：手臂张开扑腾
      rig.armL.rotation.set(-1.1, 0, -0.9 + s * 0.35);
      rig.armR.rotation.set(-1.1, 0, 0.9 - s * 0.35);
      rig.legL.rotation.x = 0.5 + s * 0.25;
      rig.legR.rotation.x = -0.4 - s * 0.25;
    } else if (this._state === 'charging') {
      // 蓄力：屈膝、双臂后摆，与外层 group 的压扁叠加
      rig.legL.rotation.x = 0.28;
      rig.legR.rotation.x = -0.28;
      rig.kneeL.rotation.x = 0.55;
      rig.kneeR.rotation.x = 0.55;
      rig.armL.rotation.x = 0.45;
      rig.armR.rotation.x = 0.45;
      rig.elbowL.rotation.x = -0.9;
      rig.elbowR.rotation.x = -0.9;
    } else {
      // ready / result：轻微呼吸摆臂 + 左右张望
      rig.armL.rotation.x = s * 0.10;
      rig.armR.rotation.x = -s * 0.10;
      rig.elbowL.rotation.x = -0.12;
      rig.elbowR.rotation.x = -0.12;
      rig.head.rotation.y = s * 0.05;
    }
  }

  _buildBlockPool() {
    // 共享几何（单位 1，靠缩放出不同尺寸）
    const boxGeo = this._geo(new THREE.BoxGeometry(1, 1, 1));
    const cylGeo = this._geo(new THREE.CylinderGeometry(0.5, 0.5, 1, 20));
    this._boxGeo = boxGeo; this._cylGeo = cylGeo;
    // 材质库
    this._blockMats = {
      normal: this._mat(new THREE.MeshStandardMaterial({ color: 0xb9c4d0, roughness: 0.7, metalness: 0.05 })),
      cube: this._mat(new THREE.MeshStandardMaterial({ color: 0x4aa3d8, roughness: 0.25, metalness: 0.3 })),
      manhole: (() => {
        const t = this._tex(this._makeRust());
        return this._mat(new THREE.MeshStandardMaterial({ map: t, color: 0x8a8f96, roughness: 0.35, metalness: 0.9 }));
      })(),
      convenience: this._mat(new THREE.MeshStandardMaterial({ color: 0xe8d9b0, roughness: 0.6 })),
      music: this._mat(new THREE.MeshStandardMaterial({ color: 0xd98ca8, roughness: 0.5 })),
    };
    const winMat = this._mat(new THREE.MeshStandardMaterial({ color: 0x6fb7e0, roughness: 0.3, emissive: 0x224455, emissiveIntensity: 0.15 }));
    this._winMat = winMat;

    for (let i = 0; i < BLOCK_POOL; i++) {
      const group = new THREE.Group();
      const geo = boxGeo;
      const mesh = new THREE.Mesh(geo, this._blockMats.normal);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
      // 特殊方块附加件（默认隐藏）
      const disc = new THREE.Mesh(cylGeo, this._mat(new THREE.MeshStandardMaterial({ color: 0xffe27a, roughness: 0.4 })));
      disc.scale.set(0.5, 0.06, 0.5); disc.position.y = 0.5; disc.visible = false;
      const shutter = new THREE.Mesh(boxGeo, this._mat(new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5 })));
      shutter.visible = false;
      group.add(disc, shutter);
      group.visible = false;
      this.root.add(group);
      this._blocks.push({
        group, mesh, disc, shutter, type: 'normal', active: false,
        x: 0, z: 0, size: BASE_SIZE, top: BASE_SIZE, half: BASE_SIZE / 2,
        special: false, triggered: false, effectT: 0, baseY: 0,
      });
    }
  }

  _makeRust() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#8a8f96'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 200; i++) {
      const x = Math.random() * 128, y = Math.random() * 128;
      g.fillStyle = `rgba(${90 + Math.random() * 60 | 0},${50 + Math.random() * 40 | 0},${30 + Math.random() * 30 | 0},0.5)`;
      g.fillRect(x, y, 3, 3);
    }
    return new THREE.CanvasTexture(c);
  }

  /* ------------------------------ UI ------------------------------ */
  _buildUI() {
    const style = document.createElement('style');
    style.id = 'jump-style';
    style.textContent = `
      .jj-ui{position:fixed;inset:0;z-index:50;pointer-events:none;font-family:system-ui,'PingFang SC',sans-serif;color:#23303f}
      .jj-score{position:absolute;top:18px;left:20px;font-size:46px;font-weight:900;text-shadow:0 2px 8px rgba(255,255,255,.6)}
      .jj-combo{position:absolute;top:74px;left:22px;font-size:20px;font-weight:800;color:#e0653a}
      .jj-best{position:absolute;top:20px;right:20px;font-size:16px;font-weight:700;opacity:.7}
      .jj-charge{position:absolute;bottom:60px;left:50%;transform:translateX(-50%);width:46vw;max-width:380px;height:14px;background:rgba(0,0,0,.18);border-radius:8px;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .15s}
      .jj-charge>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ffd24a,#ff7a3a)}
      .jj-charge span{position:absolute;top:-22px;left:50%;transform:translateX(-50%);font-size:13px;font-weight:800;color:#23303f}
      .jj-pop{position:absolute;font-size:20px;font-weight:900;color:#e0653a;pointer-events:none;opacity:0;transition:all .9s ease-out;text-shadow:0 2px 6px rgba(0,0,0,.2)}
      .jj-panel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto;background:rgba(20,30,45,.4)}
      .jj-card{background:linear-gradient(160deg,#fff,#eef3f8);border-radius:18px;padding:26px 30px;width:min(400px,86vw);text-align:center;box-shadow:0 18px 60px rgba(0,0,0,.4)}
      .jj-card h1{margin:0 0 6px;font-size:26px;color:#23303f}
      .jj-card p{margin:6px 0;font-size:14px;color:#555}
      .jj-btn{margin:10px 6px 0;padding:11px 20px;border:0;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;color:#fff;background:#ff7a3a;pointer-events:auto}
      .jj-btn.sub{background:rgba(0,0,0,.15);color:#23303f}
      .jj-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}
      .jj-stats div{background:rgba(0,0,0,.05);border-radius:10px;padding:8px}
      .jj-stats b{display:block;font-size:22px}`;
    document.head.appendChild(style);
    this._styleEl = style;

    const ui = document.createElement('div');
    ui.className = 'jj-ui';
    ui.innerHTML = `
      <div class="jj-score" id="jj-score">0</div>
      <div class="jj-combo" id="jj-combo"></div>
      <div class="jj-best" id="jj-best"></div>
      <div class="jj-charge" id="jj-charge"><span id="jj-cnum">0%</span><i id="jj-cbar"></i></div>
      <div class="jj-panel" id="jj-panel">
        <div class="jj-card">
          <h1>跳一跳</h1>
          <p>长按蓄力（鼠标/触摸/空格），松手起跳。落在方块上加分，落中心连击翻倍；特殊方块停留 2 秒有惊喜。</p>
          <button class="jj-btn" id="jj-start">开始游戏</button>
        </div>
      </div>`;
    document.body.appendChild(ui);
    this._ui = ui;
    this._el = {
      score: ui.querySelector('#jj-score'),
      combo: ui.querySelector('#jj-combo'),
      best: ui.querySelector('#jj-best'),
      charge: ui.querySelector('#jj-charge'),
      cnum: ui.querySelector('#jj-cnum'),
      cbar: ui.querySelector('#jj-cbar'),
      panel: ui.querySelector('#jj-panel'),
      start: ui.querySelector('#jj-start'),
    };
    this._el.start.addEventListener('click', () => this._startGame());
  }

  /* ============================ 游戏流程 ============================ */
  _resetGame() {
    this._score = 0; this._combo = 0; this._maxCombo = 0; this._specialHit = 0;
    this._lastSpecial = null;
    for (const b of this._blocks) { b.active = false; b.group.visible = false; b.triggered = false; b.effectT = 0; }
    // 起始 5 块：第一块在原点，其余向前生成
    let prevX = 0, prevZ = 0;
    for (let i = 0; i < 5; i++) {
      const b = this._blocks[i];
      this._configureBlock(b, i === 0 ? 'normal' : this._nextType(), prevX, prevZ);
      prevX = b.x; prevZ = b.z;
    }
    this._current = 0; this._next = 1;
    // 玩家站第一块
    const cb = this._blocks[this._current];
    this._playerMesh.position.set(cb.x, cb.top, cb.z);
    this._playerMesh.scale.set(1, 1, 1);
    this._playerMesh.rotation.set(0, 0, 0);
    this._setHUD();
  }

  _nextType() {
    if (Math.random() < 0.15 && this._lastSpecial !== 'special') {
      const t = SPECIAL[(Math.random() * SPECIAL.length) | 0];
      this._lastSpecial = 'special';
      return t;
    }
    this._lastSpecial = null;
    return 'normal';
  }

  _configureBlock(b, type, fromX, fromZ) {
    b.active = true; b.group.visible = true;
    b.type = type; b.special = SPECIAL.includes(type);
    b.triggered = false; b.effectT = 0;
    b.group.rotation.set(0, 0, 0);
    b.group.position.y = 0;
    const size = Math.max(MIN_SIZE, BASE_SIZE * Math.pow(0.95, Math.floor(this._score / 500) * SHRINK_PER_500 / 0.05 * 1));
    b.size = size; b.half = size / 2; b.top = size; b.baseY = 0;
    // 方向 ±35°，距离 1.2~5.2（首块用 2.4 固定间距）
    const ang = (fromX === 0 && fromZ === 0) ? 0 : (Math.random() * 70 - 35) * Math.PI / 180;
    const dist = (fromX === 0 && fromZ === 0) ? 2.4 : (1.2 + Math.random() * 4.0);
    b.x = fromX + Math.sin(ang) * dist;
    b.z = fromZ - Math.cos(ang) * dist;
    // 几何
    b.mesh.geometry = (type === 'manhole') ? this._cylGeo : this._boxGeo;
    b.mesh.material = this._blockMats[type] || this._blockMats.normal;
    b.mesh.scale.set(size, size, size);
    b.mesh.position.y = size / 2;
    b.group.position.set(b.x, 0, b.z);
    // 特殊附加件
    b.disc.visible = (type === 'music');
    b.shutter.visible = (type === 'convenience');
    if (type === 'convenience') {
      b.shutter.scale.set(size * 0.7, size * 0.6, 0.05);
      b.shutter.position.set(0, size * 0.7, size / 2 + 0.01);
    }
    if (type === 'manhole') { b.mesh.scale.set(size * 0.9, size * 0.3, size * 0.9); b.mesh.position.y = size * 0.15; b.top = size * 0.3; }
  }

  _startGame() {
    if (this._state !== 'ready') return;
    this._el.panel.style.display = 'none';
  }

  /* ============================ 输入 ============================ */
  _onDown() {
    // 面板（开始/结算）可见时不响应，避免点击按钮误触屏幕蓄力
    if (this._el.panel.style.display !== 'none') return;
    if (this._state === 'ready') {
      this._state = 'charging';
      this._chargeT = 0;
      this._el.charge.style.opacity = '1';
    }
  }
  _onUp() { this._releaseJump(); }
  _onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') { e.preventDefault(); this._onDown(); }
  }
  _onKeyUp(e) {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') this._onUp();
  }
  _releaseJump() {
    if (this._state !== 'charging') return;
    this._state = 'jumping';
    this._el.charge.style.opacity = '0';
    const power = Math.min(this._chargeT / CHARGE_MAX, 1);
    const distance = MIN_DIST + power * (MAX_DIST - MIN_DIST);
    const cur = this._blocks[this._current];
    const nxt = this._blocks[this._next];
    this._tmpV.set(nxt.x - cur.x, 0, nxt.z - cur.z);
    if (this._tmpV.lengthSq() < 1e-6) this._tmpV.set(0, 0, -1);
    this._tmpV.normalize();
    this._jumpTo.set(cur.x + this._tmpV.x * distance, 0, cur.z + this._tmpV.z * distance);
    this._jumpFrom.set(cur.x, cur.top, cur.z);
    this._jumpFromTop = cur.top; this._jumpToTop = nxt.top;
    this._jumpDur = 0.55 + power * 0.35;
    this._vSpeed = 0.5 * G * this._jumpDur;
    this._jumpT = 0;
    // 起身（蓄力压扁复位）
    this._playerMesh.scale.set(1, 1, 1);
  }

  /* ============================ update ============================ */
  update(dt) {
    if (this._disposed) return;
    if (this._ctx?.isPaused?.()) return;
    dt = Math.min(dt, 0.1);
    this._animatePlayer(dt); // 纯视觉：姿态随状态切换

    if (this._state === 'charging') {
      this._chargeT = Math.min(this._chargeT + dt, CHARGE_MAX);
      const p = this._chargeT / CHARGE_MAX;
      // 蓄力压扁
      this._playerMesh.scale.set(1 + p * 0.2, 1 - p * 0.25, 1 + p * 0.2);
      this._el.cbar.style.width = `${p * 100}%`;
      this._el.cnum.textContent = `${Math.round(p * 100)}%`;
      this._updateCamera(dt);
      return;
    }
    if (this._state === 'jumping') {
      this._jumpT += dt;
      const u = Math.min(this._jumpT / this._jumpDur, 1);
      const px = lerp(this._jumpFrom.x, this._jumpTo.x, u);
      const pz = lerp(this._jumpFrom.z, this._jumpTo.z, u);
      const h = this._vSpeed * this._jumpT - 0.5 * G * this._jumpT * this._jumpT;
      const py = this._jumpFromTop + (this._jumpToTop - this._jumpFromTop) * u + Math.max(h, 0);
      this._playerMesh.position.set(px, py, pz);
      this._playerMesh.rotation.y = Math.atan2(this._jumpTo.x - this._jumpFrom.x, this._jumpTo.z - this._jumpFrom.z);
      if (this._jumpT >= this._jumpDur) this._land();
      this._updateCamera(dt);
      return;
    }
    if (this._state === 'falling') {
      this._fallT -= dt;
      this._playerMesh.position.y -= dt * 6;
      this._playerMesh.rotation.x += dt * 4;
      if (this._fallT <= 0) this._showResult();
      this._updateCamera(dt);
      return;
    }
    if (this._state === 'result') { this._updateCamera(dt); return; }

    // ready：特殊方块停留计时
    const cb = this._blocks[this._current];
    if (cb && cb.special && !cb.triggered) {
      this._stayT += dt;
      if (this._stayT >= STAY_TRIGGER) this._triggerSpecial(cb);
    }
    this._updateEffects(dt);
    this._updateCamera(dt);
  }

  _land() {
    const cur = this._blocks[this._current];
    const nxt = this._blocks[this._next];
    // 落点相对下一块中心的水平距离
    const dx = this._jumpTo.x - nxt.x;
    const dz = this._jumpTo.z - nxt.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const r = nxt.half;
    if (d <= r * OK_RATIO) {
      // 成功
      this._playerMesh.position.set(this._jumpTo.x, nxt.top, this._jumpTo.z);
      this._playerMesh.rotation.set(0, 0, 0);
      if (d <= r * PERFECT_RATIO) {
        this._combo += 1;
        const add = Math.min(this._combo * 2, 32);
        this._score += add;
        this._popText(`完美 +${add}`, nxt.x, nxt.top + 1.2, nxt.z);
        this._spawnRing(nxt);
      } else {
        this._score += 1; this._combo = 0;
      }
      this._maxCombo = Math.max(this._maxCombo, this._combo);
      // 当前关 -> 下一块
      this._current = this._next;
      this._spawnNext();
      this._stayT = 0;
      this._setHUD();
      // 必须回到 ready：否则下一帧 _jumpT 仍 ≥ _jumpDur，会用旧落点对新块再判一次，必落空
      this._state = 'ready';
      this._camDip = CAM_DIP;   // 落地瞬间相机向下冲击 0.2，随后恢复
    } else {
      // 落空 → 掉落结算
      this._playerMesh.position.set(this._jumpTo.x, nxt.top, this._jumpTo.z);
      this._state = 'falling'; this._fallT = 1.0;
    }
  }

  _spawnNext() {
    // 回收最远块（active 中离当前最远者），复用其对象
    let farIdx = -1, farD = -1;
    for (let i = 0; i < this._blocks.length; i++) {
      const b = this._blocks[i];
      if (!b.active || i === this._current) continue;
      const dd = (b.x - this._blocks[this._current].x) ** 2 + (b.z - this._blocks[this._current].z) ** 2;
      if (dd > farD) { farD = dd; farIdx = i; }
    }
    const cur = this._blocks[this._current];
    this._configureBlock(this._blocks[farIdx], this._nextType(), cur.x, cur.z);
    this._next = farIdx;
  }

  _triggerSpecial(b) {
    b.triggered = true;
    const bonus = SPECIAL_BONUS[b.type] || 0;
    this._score += bonus; this._specialHit += 1;
    this._popText(`彩蛋 +${bonus}`, b.x, b.top + 1.2, b.z);
    b.effectT = 2.0;
    this._setHUD();
  }

  _updateEffects(dt) {
    for (const b of this._blocks) {
      if (!b.active || b.effectT <= 0) continue;
      b.effectT -= dt;
      if (b.type === 'music') b.disc.rotation.y += dt * 3;
      else if (b.type === 'convenience') b.shutter.position.y = b.size * 0.7 + Math.sin((2 - b.effectT) * 3) * 0.3 * (b.effectT > 1 ? 1 : b.effectT);
      else if (b.type === 'cube') b.group.rotation.y += dt * Math.PI;
      else if (b.type === 'manhole') b.group.position.y = -Math.sin((2 - b.effectT) * 2) * 0.2;
      if (b.effectT <= 0 && b.type === 'manhole') b.group.position.y = 0;
    }
  }

  /* ----------------------------- 视觉反馈 ----------------------------- */
  _popText(txt, x, y, z) {
    const el = document.createElement('div');
    el.className = 'jj-pop';
    el.textContent = txt;
    this._ui.appendChild(el);
    // 世界→屏幕
    this._tmpV.set(x, y, z).project(this._ctx.camera);
    const sx = (this._tmpV.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-this._tmpV.y * 0.5 + 0.5) * window.innerHeight;
    el.style.left = `${sx}px`; el.style.top = `${sy}px`;
    el.style.opacity = '1';
    el.style.transform = 'translateY(-40px)';
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 950);
  }
  _spawnRing(b) {
    // 简易：缩放一圈线框
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(b.half * 0.9, b.half, 24),
      new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: 0xffffff, emissiveIntensity: 0.38,
        transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(b.x, b.top + 0.02, b.z);
    this.root.add(ring);
    // 登记以便释放
    this._geometries.push(ring.geometry); this._materials.push(ring.material);
    let t = 0;
    const anim = () => {
      if (this._disposed) { return; }
      t += 0.03;
      ring.scale.setScalar(1 + t * 2);
      ring.material.opacity = Math.max(0, 0.9 - t);
      if (t < 1) requestAnimationFrame(anim);
      else { this.root.remove(ring); ring.geometry.dispose(); ring.material.dispose(); }
    };
    requestAnimationFrame(anim);
  }

  /* ----------------------------- 相机 ----------------------------- */
  _snapCamera() {
    this._camDist = CAM_DIST_NORMAL;
    this._camDip = 0;
    this._jumpDir(this._camDir);
    this._computeCamDesired();
    this._camBase.copy(this._camDesired);
    const cam = this._ctx.camera;
    cam.position.copy(this._camBase);
    cam.lookAt(this._camLook);
    cam.fov = 50; cam.updateProjectionMatrix();
  }
  // 当前块→下一块的水平单位向量（相机后退方向基准）
  _jumpDir(out) {
    const cur = this._blocks[this._current];
    const nxt = this._blocks[this._next];
    if (cur && nxt) {
      out.set(nxt.x - cur.x, 0, nxt.z - cur.z);
      if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
      out.normalize();
    } else {
      out.set(0, 0, -1);
    }
    return out;
  }
  _computeCamDesired() {
    const ball = this._playerMesh.position;
    // 后上方 45°：相机到球距离 = _camDist（蓄力 8→5），始终朝向球体
    const back = this._camDist * Math.SQRT1_2;
    const up = this._camDist * Math.SQRT1_2;
    this._camDesired.set(
      ball.x - this._camDir.x * back,
      ball.y + up,
      ball.z - this._camDir.z * back
    );
    this._camLook.set(ball.x, ball.y + 0.6, ball.z);
  }
  _updateCamera(dt) {
    // 方向缓动：落块换向后相机不瞬移
    this._jumpDir(this._tmpV);
    this._camDir.lerp(this._tmpV, 1 - Math.exp(-4 * dt)).normalize();
    // 距离缓动：蓄力缓慢拉近（8→5），松开缓慢恢复
    const targetDist = (this._state === 'charging')
      ? lerp(CAM_DIST_NORMAL, CAM_DIST_CHARGE, clamp(this._chargeT / CHARGE_MAX, 0, 1))
      : CAM_DIST_NORMAL;
    this._camDist = damp(this._camDist, targetDist, 3, dt);
    this._computeCamDesired();
    // 位置延迟跟随：lerp 系数 0.05~0.15，帧率无关（60fps 时恰为系数值）
    const follow = (this._state === 'ready') ? 0.15 : CAM_FOLLOW;
    const k = 1 - Math.pow(1 - follow, dt * 60);
    this._camBase.lerp(this._camDesired, k);
    const cam = this._ctx.camera;
    cam.position.copy(this._camBase);
    cam.position.y -= this._camDip;   // 落地向下冲击（叠加在跟随结果上）
    cam.lookAt(this._camLook);
    this._camDip = damp(this._camDip, 0, 8, dt);   // 冲击后快速恢复
  }

  /* ----------------------------- HUD ----------------------------- */
  _setHUD() {
    this._el.score.textContent = String(this._score);
    this._el.combo.textContent = this._combo > 1 ? `连击 ×${this._combo}` : '';
    const best = Number(localStorage.getItem('jump_best') || 0);
    this._el.best.textContent = `最高 ${Math.max(best, this._score)}`;
  }

  /* ----------------------------- 结算 ----------------------------- */
  _showResult() {
    this._state = 'result';
    const best = Number(localStorage.getItem('jump_best') || 0);
    const isNew = this._score > best;
    if (isNew) localStorage.setItem('jump_best', String(this._score));
    this._el.panel.innerHTML = `
      <div class="jj-card">
        <h1>游戏结束</h1>
        <div class="jj-stats">
          <div>得分<b>${this._score}</b></div>
          <div>最高连击<b>×${this._maxCombo}</b></div>
          <div>彩蛋<b>${this._specialHit}</b></div>
          <div>历史最高<b>${Math.max(best, this._score)}</b></div>
        </div>
        ${isNew ? '<p style="color:#e0653a;font-weight:800">🎉 新纪录！</p>' : ''}
        <button class="jj-btn" id="jj-retry">再来一次</button>
        <button class="jj-btn sub" id="jj-lobby">返回大厅</button>
      </div>`;
    this._el.panel.style.display = 'flex';
    this._el.panel.querySelector('#jj-retry').addEventListener('click', () => this._restart());
    this._el.panel.querySelector('#jj-lobby').addEventListener('click', () => this._ctx.onExitAttraction?.());
  }
  _restart() {
    for (const b of this._blocks) { b.active = false; b.group.visible = false; b.group.rotation.set(0, 0, 0); b.group.position.y = 0; }
    this._state = 'ready';
    this._resetGame();
    this._el.panel.style.display = 'none';
    this._snapCamera();
  }

  /* ============================ onInteract ============================ */
  onInteract() { /* UI 由 DOM 驱动 */ }

  /* ============================ dispose ============================ */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    window.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    if (this._ui && this._ui.parentNode) this._ui.parentNode.removeChild(this._ui);
    if (this._styleEl && this._styleEl.parentNode) this._styleEl.parentNode.removeChild(this._styleEl);
    this._ui = null; this._styleEl = null;

    const scene = this._ctx?.scene;
    if (scene) {
      scene.background = this._sceneBgSaved ?? null;
      scene.fog = this._sceneFogSaved ?? null;
    }
    const cam = this._ctx?.camera;
    if (cam && this._cameraSaved) {
      cam.position.copy(this._cameraSaved.position);
      cam.quaternion.copy(this._cameraSaved.quaternion);
      cam.up.copy(this._cameraSaved.up);
      cam.rotation.order = this._cameraSaved.rotationOrder;
      cam.fov = this._cameraSaved.fov;
      cam.updateProjectionMatrix();
    }
    // 阴影贴图（map 颜色 + depthTexture 共 2 个 GPU 纹理）由灯光 dispose 释放
    try { this._sun?.dispose(); } catch (e) {}
    for (const g of this._geometries) { try { g.dispose(); } catch (e) {} }
    for (const m of this._materials) { try { m.dispose(); } catch (e) {} }
    for (const t of this._textures) { try { t.dispose(); } catch (e) {} }
    this._geometries.length = 0; this._materials.length = 0; this._textures.length = 0;
  }

  /* ============================ warmUp ============================ */
  warmUp() {
    this._startGame();
    // 模拟若干次蓄力→起跳→落点（含完美/普通/落空路径），覆盖全部分支
    for (let n = 0; n < 40; n++) {
      // 直跳：使距离≈到下一块中心 → 完美
      this._state = 'charging'; this._chargeT = (0.5 + (Math.random() - 0.5) * 1.6);
      const cur = this._blocks[this._current];
      const nxt = this._blocks[this._next];
      const need = Math.hypot(nxt.x - cur.x, nxt.z - cur.z);
      const power = (need - MIN_DIST) / (MAX_DIST - MIN_DIST);
      this._chargeT = clamp(power, 0, 1) * CHARGE_MAX;
      this._releaseJump();
      // 推进跳跃
      let guard = 0;
      while (this._state === 'jumping' && guard++ < 200) this.update(0.016);
      // 触发特殊彩蛋分支
      if (this._blocks[this._current]?.special) { this._stayT = STAY_TRIGGER; this.update(0.016); }
    }
    // 落空路径
    this._state = 'charging'; this._chargeT = CHARGE_MAX; this._releaseJump();
    let g2 = 0; while (this._state === 'jumping' && g2++ < 200) this.update(0.016);
    if (this._state === 'falling') { this._fallT = 0.01; this.update(0.016); }
    this._state = 'ready';
    return this;
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));

export default JumpJump;
