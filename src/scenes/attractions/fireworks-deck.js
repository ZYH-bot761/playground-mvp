/**
 * ============================================================================
 * FireworksDeck.js —— 模块 7：烟花观礼台（IAttraction 独立设施）
 * ============================================================================
 * 第七部分 / 指令 3：玩家进入后站在观礼台上，通过控制台放烟花。
 *
 * 【IAttraction 契约】
 *   init(ctx) 建 root / 存相机 / 建资源 / 注册 UI；不调用 world.step()
 *   update(dt) 队列发射、自动模式、天幕渐变、相机缓动；dt 已 clamp
 *   onInteract() UI 全 DOM 驱动，无需 3D 拾取（空实现）
 *   dispose()  幂等；释放全部 geometry/material/纹理，移除 DOM，还原相机
 *
 * 【与全局单例的边界（重要）】
 *  - 天空色 / 三盏基座灯 / Bloom / 太阳月亮星空：全部由 dayNightCycle 管。
 *    本设施只 setContext('fireworks-deck') 让昼夜系统保持激活，不重复接管。
 *  - 粒子：全部由 fireworkSystem 的全局 Points 承担，本设施零粒子资源。
 *  - 本设施自建的 background/fog 是【自己新建的对象】并保存/还原，
 *    绝不污染 SceneManager 的原始 Color 对象（避免夜色串到其它设施）。
 *  - 天幕球是唯一的天空视觉：颜色每帧读 scene.background 平滑跟随昼夜模式，
 *    因此白天/黄昏/黑夜自动适配，且不需要跨模块传参。
 *
 * 【性能】
 *  观礼台栏杆/发射筒用 InstancedMesh；天幕 1 geo+1 mat；
 *  连续发射走 0.32s 队列 + 自动模式 2.2s/发，配合粒子系统 0.12s 频率闸门，
 *  绝不过密。运行期不新建任何 GPU 资源。
 * ============================================================================
 */
import * as THREE from 'three';
import { IAttraction } from './i-attraction.js';
import { fireworkSystem, FIREWORK_COLORS, FIREWORK_TYPES } from '../../utils/helpers/particle-system.js';
import { dayNightCycle } from '../../utils/helpers/day-night-cycle.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 烟花在相机前方的世界锚点（相机看向此处上空） */
const ANCHOR = new THREE.Vector3(0, 19, -22);

/** 自动模式花型池：排除 text（文字必须走 launchText 专用链路，不能进 launch()）。
 *  原实现用硬编码 (rand*3)|0 隐式排除第 4 项，配置一旦调整就会漏型/崩溃——改为显式过滤。 */
const AUTO_TYPES = FIREWORK_TYPES.filter((t) => t.key !== 'text');

export class FireworksDeck extends IAttraction {
  constructor() {
    super();
    this.root = null;
    this._disposed = false;
    this._ctx = null;

    this._geometries = [];
    this._materials = [];
    /** InstancedMesh 台账：instanceMatrix/instanceColor 的 GL 缓冲必须走 IM.dispose() 释放，
     *  geometry/material dispose 不覆盖它们（原实现漏掉 → 每次进出设施累积泄漏）。 */
    this._instancedMeshes = [];

    // 相机
    this._cameraSaved = null;
    this._bgSaved = null;
    this._fogSaved = null;
    this._camPhase = 0;

    // 天幕
    this._sky = null;
    this._skyTop = new THREE.Color(0x0a1030);
    this._skyHorizon = new THREE.Color(0x22305e);

    // 控制台状态
    this._color = FIREWORK_COLORS[0].hex;
    this._type = 'burst';
    this._text = '';
    this._auto = false;
    this._autoT = 0;
    this._queue = [];
    this._queueT = 0;

    // DOM
    this._ui = null;
    this._styleEl = null;
    this._onPanelClick = null;
    this._onInput = null;
    this._onKeyDown = null;

    this._tmpColor = new THREE.Color();
  }

  /* ============================ init ============================ */
  init(ctx) {
    if (this._disposed) return;
    this._ctx = ctx;
    const { scene, camera } = ctx;

    // ① 接管相机 / 背景 / 雾（保存完整快照）
    this._cameraSaved = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      up: camera.up.clone(),
      rotationOrder: camera.rotation.order,
      fov: camera.fov,
    };
    this._bgSaved = scene.background;
    this._fogSaved = scene.fog;
    // 必须新建对象：昼夜系统会 copy 修改当前 background，
    // 若复用 SceneManager 的原始 Color，会把夜色写进全局基线对象。
    // 【不要设 scene.fog = null】昼夜系统的 _restoreBaseline 会跳过 null 雾，
    // 退出站台后 fog 会一直残留为 null，可能让其它设施假设「雾一定存在」的代码报错。
    // 保留 fog 对象，由昼夜系统按当前模式染色即可。
    scene.background = new THREE.Color(0x0a0a2e).multiplyScalar(0.38);

    this.root = new THREE.Group();
    this.root.name = 'FireworksDeck';
    this.root.userData.attractionRoot = true;
    scene.add(this.root);

    this._buildSkyDome();
    this._buildDeck();
    this._placeCamera(camera);
    this._buildUI();

    // ② 全局单例上下文： fireworks-deck 属于「昼夜生效场景」
    dayNightCycle.setContext('fireworks-deck');
    fireworkSystem.setContext('fireworks-deck');
    this._syncBrightness();

    // ③ 资源登记兜底
    for (const g of this._geometries) ctx.registerDisposable?.(g);
    for (const m of this._materials) ctx.registerDisposable?.(m);
  }

  _geo(g) { this._geometries.push(g); return g; }
  _mat(m) { this._materials.push(m); return m; }

  /* --------------------------- 渐变天幕 --------------------------- */
  _buildSkyDome() {
    const geo = this._geo(new THREE.SphereGeometry(1, 24, 16));
    const mat = this._mat(new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: this._skyTop.clone() },
        uHorizon: { value: this._skyHorizon.clone() },
      },
      vertexShader: /* glsl */`
        varying float vY;
        void main() {
          vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        varying float vY;
        void main() {
          float h = clamp(vY * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.86, h));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }));
    const dome = new THREE.Mesh(geo, mat);
    dome.name = 'FireworksDeck/sky-dome';
    dome.scale.setScalar(120);       // camera.far=200 内
    dome.renderOrder = -1000;
    dome.frustumCulled = false;
    this.root.add(dome);
    this._sky = dome;
  }

  /* --------------------------- 观礼台 --------------------------- */
  _buildDeck() {
    const deckMat = this._mat(new THREE.MeshStandardMaterial({
      color: 0x2b3550, roughness: 0.75, metalness: 0.18,
    }));
    const trimMat = this._mat(new THREE.MeshStandardMaterial({
      color: 0x8ea8d8, roughness: 0.45, metalness: 0.55,
      emissive: 0x14213c, emissiveIntensity: 0.5,
    }));
    const glowMat = this._mat(new THREE.MeshStandardMaterial({
      color: 0xffc94a, emissive: 0xff9a2b, emissiveIntensity: 1.1, roughness: 0.4,
    }));

    // 圆形平台
    const platGeo = this._geo(new THREE.CylinderGeometry(9, 9.6, 0.7, 40));
    const plat = new THREE.Mesh(platGeo, deckMat);
    plat.position.y = -0.35;
    plat.receiveShadow = true;
    this.root.add(plat);

    // 平台外圈发光边
    const ringGeo = this._geo(new THREE.TorusGeometry(9.05, 0.09, 8, 64));
    const ring = new THREE.Mesh(ringGeo, trimMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    this.root.add(ring);

    // 栏杆立柱 + 横杆（InstancedMesh，1 draw call）
    const postGeo = this._geo(new THREE.CylinderGeometry(0.075, 0.075, 1.1, 6));
    const N = 32;
    const posts = new THREE.InstancedMesh(postGeo, trimMat, N);
    this._instancedMeshes.push(posts); // 【泄漏修复】登记实例缓冲，dispose 时必须释放
    posts.frustumCulled = false;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      // 前侧留缺口作为观景方向
      if (Math.abs(Math.sin(a)) > 0.86 && Math.cos(a) < 0) continue;
      dummy.position.set(Math.cos(a) * 8.6, 0.55, Math.sin(a) * 8.6);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      posts.setMatrixAt(i, dummy.matrix);
    }
    // 未设置的实例默认单位矩阵会堆在原点 → 缩到 0 隐藏
    for (let i = 0; i < N; i++) {
      if (posts.instanceMatrix.array[i * 16] === 0) {
        dummy.position.set(0, -999, 0); dummy.scale.set(0, 0, 0);
        dummy.updateMatrix(); posts.setMatrixAt(i, dummy.matrix);
      }
    }
    posts.instanceMatrix.needsUpdate = true;
    this.root.add(posts);

    // 发射筒（InstancedMesh，1 draw call）
    const tubeGeo = this._geo(new THREE.CylinderGeometry(0.34, 0.42, 1.7, 10));
    const tubes = new THREE.InstancedMesh(tubeGeo, trimMat, 6);
    this._instancedMeshes.push(tubes); // 【泄漏修复】
    tubes.frustumCulled = false;
    for (let i = 0; i < 6; i++) {
      const a = -0.55 + (i / 5) * 1.1;
      dummy.position.set(Math.sin(a) * 6.4, 0.85, -3.2 - Math.cos(a) * 0.6);
      dummy.rotation.set(-0.22, a, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      tubes.setMatrixAt(i, dummy.matrix);
    }
    tubes.instanceMatrix.needsUpdate = true;
    this.root.add(tubes);

    // 筒口发光环
    const capGeo = this._geo(new THREE.TorusGeometry(0.34, 0.055, 6, 16));
    const caps = new THREE.InstancedMesh(capGeo, glowMat, 6);
    this._instancedMeshes.push(caps); // 【泄漏修复】
    caps.frustumCulled = false;
    for (let i = 0; i < 6; i++) {
      const a = -0.55 + (i / 5) * 1.1;
      dummy.position.set(Math.sin(a) * 6.4, 1.66, -3.2 - Math.cos(a) * 0.6);
      dummy.rotation.set(-Math.PI / 2 - 0.22, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      caps.setMatrixAt(i, dummy.matrix);
    }
    caps.instanceMatrix.needsUpdate = true;
    this.root.add(caps);

    // 控制台（玩家身前的发光台）
    const boxGeo = this._geo(new THREE.BoxGeometry(1, 1, 1));
    const consoleMesh = new THREE.Mesh(boxGeo, deckMat);
    consoleMesh.scale.set(2.2, 1.0, 0.9);
    consoleMesh.position.set(0, 0.7, 7.4);
    this.root.add(consoleMesh);
    const panel = new THREE.Mesh(boxGeo, glowMat);
    panel.scale.set(1.9, 0.06, 0.72);
    panel.position.set(0, 1.23, 7.4);
    this.root.add(panel);

    // 自建氛围灯（挂 root，dispose 随 root 移除，不污染基座）
    const fill = new THREE.HemisphereLight(0x9fb6ff, 0x1a2038, 0.5);
    this.root.add(fill);
    const warm = new THREE.PointLight(0xffb066, 22, 26, 2);
    warm.position.set(0, 4.2, 5.2);
    this.root.add(warm);
  }

  /* --------------------------- 相机 --------------------------- */
  _placeCamera(camera) {
    camera.position.set(0, 2.8, 9.2);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 13.5, -22);
    camera.fov = 68;
    camera.updateProjectionMatrix();
  }

  /* --------------------------- UI --------------------------- */
  _buildUI() {
    const style = document.createElement('style');
    style.id = 'fw-ui-style';
    style.textContent = `
      .fw-ui{position:fixed;inset:0;z-index:50;pointer-events:none;
        font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#eef3ff}
      .fw-ui *{box-sizing:border-box}
      .fw-hdr{position:absolute;top:calc(16px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);
        padding:8px 20px;border-radius:999px;white-space:nowrap;font-size:15px;font-weight:700;letter-spacing:2px;
        background:rgba(9,18,38,.62);border:1px solid rgba(125,180,255,.3);text-shadow:0 0 14px rgba(90,160,255,.6)}
      .fw-panel{position:absolute;bottom:calc(16px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);
        width:min(680px,94vw);padding:14px 16px;border-radius:16px;pointer-events:auto;
        background:linear-gradient(160deg,rgba(20,30,54,.94),rgba(10,16,32,.96));
        border:1px solid rgba(130,175,255,.28);box-shadow:0 16px 50px rgba(0,0,0,.55)}
      .fw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:9px}
      .fw-row:last-child{margin-bottom:0}
      .fw-lab{font-size:12px;color:#9fb6dd;min-width:48px;letter-spacing:1px}
      .fw-sw{width:26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,.25);
        cursor:pointer;pointer-events:auto;transition:transform .12s,border-color .12s;padding:0}
      .fw-sw:hover{transform:scale(1.12)}
      .fw-sw[data-on='1']{border-color:#fff;transform:scale(1.16);box-shadow:0 0 12px currentColor}
      .fw-tab{padding:7px 14px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;pointer-events:auto;
        color:#cdd9f2;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)}
      .fw-tab[data-on='1']{color:#0c1322;background:#ffd24a;border-color:#ffd24a}
      .fw-input{flex:1;min-width:120px;padding:8px 11px;border-radius:9px;font-size:14px;color:#fff;
        background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.2);outline:none;pointer-events:auto}
      .fw-input:focus{border-color:#7fb0ff}
      .fw-btn{padding:9px 18px;border:0;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;
        pointer-events:auto;color:#0c1322;background:#ffd24a;transition:transform .1s}
      .fw-btn:hover{transform:translateY(-1px)}
      .fw-btn.sub{background:rgba(255,255,255,.14);color:#eaf1ff}
      .fw-btn.on{background:#4ade80;color:#06210f}
      .fw-hint{font-size:11px;color:#8ea6cf;margin-left:auto;white-space:nowrap}
      @media (max-width:640px),(max-height:520px){
        .fw-hdr{font-size:12px;padding:5px 12px;top:6px}
        .fw-panel{padding:10px;bottom:6px}
        .fw-row{gap:6px;margin-bottom:6px}
        .fw-lab{min-width:38px;font-size:11px}
        .fw-sw{width:22px;height:22px}
        .fw-tab{padding:5px 9px;font-size:11px}
        .fw-hint{display:none}
      }
    `;
    document.head.appendChild(style);
    this._styleEl = style;

    const swatches = FIREWORK_COLORS.map((c, i) =>
      `<button class="fw-sw" data-act="color" data-i="${i}" data-on="${i === 0 ? 1 : 0}" ` +
      `style="background:#${c.hex.toString(16).padStart(6, '0')};color:#${c.hex.toString(16).padStart(6, '0')}" title="${c.name}"></button>`
    ).join('');
    const tabs = FIREWORK_TYPES.map((t, i) =>
      `<button class="fw-tab" data-act="type" data-k="${t.key}" data-on="${i === 0 ? 1 : 0}">${t.label}</button>`
    ).join('');

    const ui = document.createElement('div');
    ui.className = 'fw-ui';
    ui.innerHTML = `
      <div class="fw-hdr">烟花观礼台 · <span id="fw-mode">夜晚效果最佳</span></div>
      <div class="fw-panel" id="fw-panel">
        <div class="fw-row"><span class="fw-lab">颜色</span>${swatches}</div>
        <div class="fw-row"><span class="fw-lab">花型</span>${tabs}</div>
        <div class="fw-row">
          <input class="fw-input" id="fw-text" type="text" maxlength="12" placeholder="文字烟花：输入文字后选「文字」并发射" />
        </div>
        <div class="fw-row">
          <button class="fw-btn" data-act="launch">发射烟花</button>
          <button class="fw-btn sub" data-act="auto" id="fw-auto">自动模式：关</button>
          <button class="fw-btn sub" data-act="night">切到夜晚</button>
          <button class="fw-btn sub" data-act="exit">返回大厅</button>
          <span class="fw-hint" id="fw-queue">可连续点发射 · 队列 0</span>
        </div>
      </div>`;
    document.body.appendChild(ui);
    this._ui = ui;

    this._onPanelClick = (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !ui.contains(el)) return;
      const act = el.dataset.act;
      if (act === 'color') {
        this._color = FIREWORK_COLORS[Number(el.dataset.i)].hex;
        ui.querySelectorAll('.fw-sw').forEach((n) => { n.dataset.on = n === el ? '1' : '0'; });
      } else if (act === 'type') {
        this._type = el.dataset.k;
        ui.querySelectorAll('.fw-tab').forEach((n) => { n.dataset.on = n === el ? '1' : '0'; });
      } else if (act === 'launch') {
        this._enqueue();
      } else if (act === 'auto') {
        this._auto = !this._auto;
        this._autoT = 0;
        el.textContent = `自动模式：${this._auto ? '开' : '关'}`;
        el.classList.toggle('on', this._auto);
      } else if (act === 'night') {
        dayNightCycle.setMode('night');
        this._syncBrightness();
        this._updateModeLabel();
      } else if (act === 'exit') {
        this._ctx?.onExitAttraction?.();
      }
    };
    this._onInput = (e) => {
      if (e.target?.id === 'fw-text') this._text = e.target.value;
    };
    this._onKeyDown = (e) => {
      if (e.key === 'Enter' && e.target?.id === 'fw-text') { e.preventDefault(); this._enqueue(); }
    };
    ui.addEventListener('click', this._onPanelClick);
    ui.addEventListener('input', this._onInput);
    ui.addEventListener('keydown', this._onKeyDown);

    this._updateModeLabel();
  }

  _updateModeLabel() {
    const el = this._ui?.querySelector('#fw-mode');
    if (!el) return;
    const m = dayNightCycle.mode;
    el.textContent = m === 'night' ? '夜晚 · 效果最佳' : m === 'sunset' ? '黄昏 · 效果良好' : '白天 · 效果减弱';
  }

  _syncBrightness() {
    const m = dayNightCycle.mode;
    if (m === this._lastMode) return; // 只在模式变化时写 DOM，避免每帧 querySelector
    this._lastMode = m;
    const b = m === 'night' ? 1 : m === 'sunset' ? 0.78 : 0.5;
    fireworkSystem.setBrightness(b);
    this._updateModeLabel();
  }

  _updateQueueLabel() {
    const el = this._ui?.querySelector('#fw-queue');
    if (el) el.textContent = `可连续点发射 · 队列 ${this._queue.length}`;
  }

  /** 连续发射：入队而非立即全发，避免瞬间塞满粒子池 / 频率闸门丢弃 */
  _enqueue() {
    if (this._queue.length >= 6) return;
    this._queue.push({ type: this._type, color: this._color, text: this._text });
    this._updateQueueLabel();
    // 第一发立即出队，手感跟手
    if (this._queueT <= 0) this._fireOne();
  }

  _fireOne() {
    const job = this._queue.shift();
    if (!job) { this._updateQueueLabel(); return; }
    const px = ANCHOR.x + (Math.random() - 0.5) * 15;
    const py = ANCHOR.y + (Math.random() - 0.5) * 7;
    const pz = ANCHOR.z;
    if (job.type === 'text') {
      const txt = (job.text || '').trim() || '游乐园';
      fireworkSystem.launchText({ x: ANCHOR.x, y: py, z: pz }, txt, job.color, 2.0);
    } else {
      fireworkSystem.launch({ x: px, y: py, z: pz }, job.type, job.color, 1.15, 2.3);
    }
    this._queueT = 0.32;
    this._updateQueueLabel();
  }

  /* ============================ update ============================ */
  update(dt) {
    if (this._disposed) return;
    if (this._ctx?.isPaused?.()) return;
    const d = Math.min(Math.max(dt, 0), 0.1);
    this._camPhase += d;

    // 天幕颜色平滑跟随昼夜系统写入的 scene.background（线性空间）
    const bg = this._ctx.scene?.background;
    if (bg?.isColor) {
      const k = 1 - Math.exp(-2.0 * d);
      // 从当前值平滑趋向目标（不得先 copy 目标值，否则插值失效会突变）
      const tR = bg.r * 0.62, tG = bg.g * 0.62, tB = bg.b * 0.72;
      const hR = bg.r * 1.45, hG = bg.g * 1.30, hB = bg.b * 1.55;
      this._skyTop.setRGB(
        lerp(this._skyTop.r, tR, k), lerp(this._skyTop.g, tG, k), lerp(this._skyTop.b, tB, k),
      );
      this._skyHorizon.setRGB(
        lerp(this._skyHorizon.r, hR, k), lerp(this._skyHorizon.g, hG, k), lerp(this._skyHorizon.b, hB, k),
      );
      if (this._sky) {
        this._sky.material.uniforms.uTop.value.copy(this._skyTop);
        this._sky.material.uniforms.uHorizon.value.copy(this._skyHorizon);
      }
    }

    // 相机极缓摇移（防眩晕：幅度 < 0.05）
    const cam = this._ctx.camera;
    cam.position.x = Math.sin(this._camPhase * 0.16) * 0.16;
    cam.position.y = 2.8 + Math.sin(this._camPhase * 0.22) * 0.06;
    cam.lookAt(0, 13.5, -22);

    // 队列出队
    if (this._queueT > 0) this._queueT -= d;
    if (this._queue.length && this._queueT <= 0) this._fireOne();

    // 自动模式：2.2s/发，随机花型，频率克制
    if (this._auto) {
      this._autoT += d;
      if (this._autoT >= 2.2) {
        this._autoT = 0;
        const t = AUTO_TYPES[(Math.random() * AUTO_TYPES.length) | 0].key;
        const c = FIREWORK_COLORS[(Math.random() * FIREWORK_COLORS.length) | 0].hex;
        fireworkSystem.launch(
          { x: ANCHOR.x + (Math.random() - 0.5) * 15, y: ANCHOR.y + (Math.random() - 0.5) * 7, z: ANCHOR.z },
          t, c, 1.1, 2.3,
        );
      }
    }

    // 昼夜模式可能被大厅控制台改变 → 亮度与文案同步
    this._syncBrightness();
  }

  /* ============================ onInteract ============================ */
  onInteract() { /* UI 全 DOM 驱动 */ }

  /* ============================ warmUp ============================ */
  /** 预热：覆盖四种花型 + 文字的发射路径，随后清场；不改游戏状态 */
  warmUp() {
    const p = { x: 0, y: 18, z: -22 };
    fireworkSystem.warmUp(p);
    return this;
  }

  /* ============================ dispose ============================ */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._queue.length = 0;
    this._auto = false;

    // UI / 事件
    if (this._ui) {
      this._ui.removeEventListener('click', this._onPanelClick);
      this._ui.removeEventListener('input', this._onInput);
      this._ui.removeEventListener('keydown', this._onKeyDown);
      this._ui.remove();
    }
    this._styleEl?.remove();
    this._ui = null; this._styleEl = null;
    this._onPanelClick = this._onInput = this._onKeyDown = null;

    // 全局单例：清空本设施发射的粒子，避免串到下一个场景
    fireworkSystem.clear();

    // 还原背景 / 雾 / 相机
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

    // GPU 资源（登记器会二次兜底，dispose 幂等）
    for (const im of this._instancedMeshes) { try { im.dispose(); } catch (e) { /* noop */ } }
    this._instancedMeshes.length = 0;
    for (const g of this._geometries) { try { g.dispose(); } catch (e) { /* noop */ } }
    for (const m of this._materials) { try { m.dispose(); } catch (e) { /* noop */ } }
    this._geometries.length = 0;
    this._materials.length = 0;
    this._sky = null;
    this.root = null;
  }
}

export default FireworksDeck;
