/**
 * ============================================================================
 * HandTracker.js —— 摄像头手势识别（阶段 1：独立纯逻辑模块，v4）
 * ============================================================================
 * 职责：封装 getUserMedia + MediaPipe HandLandmarker，对外只暴露手势枚举、
 *   21 点归一化坐标与捏合点。供阶段 3「手幻仙牛」游乐设施复用。
 *
 * 【严格边界（阶段 1 只做本模块）】
 *   - 独立、无 Three.js 依赖：本文件禁止 import three，不耦合任何 3D 场景逻辑。
 *   - 不碰 DOM 结构：只接收外部传入的 <video> 元素，读写其 srcObject。
 *     video 与叠加 canvas 由阶段 3 设施层创建/移除，本模块不负责。
 *   - 不含任何 UI、不引入小窝建筑、不修改 Lobby.js / main.js。
 *
 * 【坐标镜像只做一次】见 getLandmarks() / getPinchPoint() 说明。
 * 【生命周期】stop() close、start() 重建（与 CAREMA 不同），见 stop() 说明。
 * 【性能】rAF 循环体及其调用链内零分配：所有数组/对象在构造时预分配复用。
 * ============================================================================
 */

/** 必须与 package.json dependencies["@mediapipe/tasks-vision"] 严格一致；改版本须同时改两处 */
export const MEDIAPIPE_VERSION = '0.10.3';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

/**
 * 供后续验证脚本比对 npm 包版本与 WASM CDN 版本是否一致。
 * 纯函数：只比较入参，不读取 package.json（不把整个 package.json import 进 bundle）。
 * @param {string} packageJsonVersion dependencies["@mediapipe/tasks-vision"] 的值
 * @returns {true} 一致时返回 true
 * @throws {Error} 不一致时抛错
 */
export function assertMediapipeVersion(packageJsonVersion) {
  if (packageJsonVersion !== MEDIAPIPE_VERSION) {
    throw new Error(
      `[HandTracker] MediaPipe 版本不一致：HandTracker.js=${MEDIAPIPE_VERSION}，package.json=${packageJsonVersion}；WASM CDN 与 npm 包必须同版本`
    );
  }
  return true;
}

/** 模型由 Vite 静态托管：public/models/ → dist/models/；不用 import 引入 .task */
const MODEL_ASSET_PATH = '/models/hand_landmarker.task';

/**
 * 摄像头分辨率集中配置；阶段 4 性能调优时可降到 320x240。
 * facingMode 用 ideal（非 exact），避免在不支持的设备上直接 OverconstrainedError。
 */
const VIDEO_CONSTRAINTS = Object.freeze({
  audio: false,
  video: Object.freeze({
    facingMode: Object.freeze({ ideal: 'user' }),
    width: Object.freeze({ ideal: 640 }),
    height: Object.freeze({ ideal: 480 }),
    frameRate: Object.freeze({ ideal: 30, max: 60 }),
  }),
});

const READY_TIMEOUT_MS = 10000;   // 等待 video.readyState >= 2 的超时
const READY_POLL_MS = 50;         // 轮询间隔

/** 沿用 CAREMA index.html:3952-3954 原值 */
const CAREMA_DETECT_CONFIDENCE = Object.freeze({
  minHandDetectionConfidence: 0.55, // 沿用 CAREMA index.html:3952 原值
  minHandPresenceConfidence: 0.55,  // 沿用 CAREMA index.html:3953 原值
  minTrackingConfidence: 0.5,       // 沿用 CAREMA index.html:3954 原值
});

/** 默认每帧 detect；阶段 4 性能调优时改为 2 或 3，中间帧沿用上次结果 + Lerp 平滑 */
const DETECT_EVERY_N_FRAMES = 1;

/** 输入平滑系数（任务书要求 0.15~0.25）；小牛目标位姿的 Lerp 属于阶段 3 设施层，本模块只平滑输入 */
const LERP_K = 0.2;

/** 去抖帧数（任务书建议 3~5）：同一候选连续稳定 4 帧才确认切换 */
const GESTURE_DEBOUNCE_FRAMES = 4;

const LANDMARK_COUNT = 21;
const WAVE_SAMPLE_CAP = 24;       // 掌心 x 历史样本上限（约 300ms @30fps 只需 ~9 帧）

/** 手势枚举，冻结，值即字符串，便于上层持久化 / 日志 */
export const GESTURES = Object.freeze({
  NONE: 'NONE',
  OPEN: 'OPEN',
  PINCH: 'PINCH',
  FIST: 'FIST',
  POINT: 'POINT',
  SCISSORS: 'SCISSORS',
  WAVE: 'WAVE',
});

/** 判定优先级集中在此，方便调参；不要散落在 update 逻辑中 */
const GESTURE_PRIORITY = Object.freeze([
  GESTURES.PINCH,
  GESTURES.FIST,
  GESTURES.POINT,
  GESTURES.SCISSORS,
  // 挥手必须排在 OPEN 之前：用户挥动整只手时手掌通常是张开的，
  // 若 OPEN 在前会把 WAVE 完全遮蔽，导致任务书 3.5 的
  // 「左右挥动整只手 → 小牛转头 / 摇尾巴」永远触发不了。
  GESTURES.WAVE,
  GESTURES.OPEN,
  GESTURES.NONE,
]);

/**
 * CAREMA 源码 4 指伸直判定阈值（D:\TRAE项目文件夹\carema\index.html:1629-1652）。
 * ⚠️ 以下是逐行核实的源码原值，禁止臆改：CAREMA 没有捏合、没有「指尖到腕点
 * 平均距离」判定、没有指向与挥手计数（任务模板里的 0.05/0.25/0.4 不是源码原值）。
 */
const CAREMA_THRESHOLDS = Object.freeze({
  IDX: 2.28,             // 沿用 CAREMA index.html:1639-1642 原值（食指 mcp5/pip6/dip7/tip8）
  MID: 2.28,             // 沿用 CAREMA index.html:1639-1642 原值（中指 9/10/11/12）
  RNG: 2.15,             // 沿用 CAREMA index.html:1639-1642 原值（无名指 13/14/15/16）
  PNK: 2.05,             // 沿用 CAREMA index.html:1639-1642 原值（小指 17/18/19/20）
  TIP_FAR_RATIO: 1.08,   // 沿用 CAREMA index.html:1639-1642 原值（同源于 1633-1634 的 *1.08）
  DIP_MIN: 1.95,         // 沿用 CAREMA index.html:1639-1642 原值（同源于 1635 的 aDip > 1.95）
  OPEN_MIN_EXTENDED: 3,  // 沿用 CAREMA index.html:1639-1642 原值（同源于 1652 的 extended >= 3）
});

/**
 * ⚠️ 以下为 v4 新增阈值，CAREMA 源码无对应实现，未经真机验证，属未确认项，
 * 需按任务书 5.3 说明验证方式（真机摄像头逐手势采样后回归标定）。
 */
const V4_NEW_THRESHOLDS = Object.freeze({
  PINCH_DIST: 0.05,        // 点 4↔8 归一化距离 < 0.05（未确认）
  FIST_AVG_DIST: 0.25,     // 四指尖(8,12,16,20)到腕点0平均距离 < 0.25（未确认）
  WAVE_WINDOW_MS: 300,     // 掌心 x 往返检测窗口约 300ms（未确认）
  WAVE_MIN_DELTA: 0.12,    // 掌心 x 窗口内位移 > 0.12（未确认）
  WAVE_EPS: 0.004,         // 相邻样本方向判定的死区，抑制抖动（未确认）
  WAVE_MIN_SAMPLES: 3,     // 窗口内至少有效样本数（未确认）
  WAVE_MIN_REVERSALS: 1,   // 窗口内至少方向反转次数（未确认）
});

/** 错误分类文案（中文）。键为原生 DOMException.name 或本模块自定义 name */
export const TRACKER_ERRORS = Object.freeze({
  InsecureContext: '摄像头功能需要 HTTPS 或 localhost 环境访问',
  Unsupported: '当前浏览器不支持摄像头访问',
  NotAllowedError: '摄像头权限被拒绝，请在浏览器地址栏允许后重试',
  PermissionDeniedError: '摄像头权限被拒绝，请在浏览器地址栏允许后重试',
  NotFoundError: '未检测到摄像头设备，请检查连接',
  DevicesNotFoundError: '未检测到摄像头设备，请检查连接',
  NotReadableError: '摄像头被其他程序占用，请关闭后重试',
  TrackStartError: '摄像头被其他程序占用，请关闭后重试',
  OverconstrainedError: '摄像头不支持请求的分辨率，请重试',
  ModelLoadError: '手部识别模型加载失败，请检查网络（WASM 来自 CDN）',
  Fallback: '摄像头启动失败：{原始 message}',
});

/* -------------------------------------------------------------------------- */
/* 模块级纯函数 / 预分配工具（循环体内只调用，不再分配任何对象）               */
/* -------------------------------------------------------------------------- */

/** 沿用 CAREMA index.html:881 原值 */
function _clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/** 沿用 CAREMA index.html:883 原值：2D 距离（只用 x/y，不用 z） */
function _dist2d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/** 沿用 CAREMA index.html:1617-1626 原值：Math.acos(dot)，弧度 */
function _angleAt(a, b, c) {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y) || 1;
  const l2 = Math.hypot(v2x, v2y) || 1;
  const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
  return Math.acos(_clamp(dot, -1, 1));
}

/**
 * 数值镜像：CAREMA 用 CSS 镜像（index.html:117-127 transform:scaleX(-1)），
 * 本项目 3D 场景改用数值镜像；阶段 3 设施层禁止再镜像一次，否则左右方向反掉。
 * 只在 getLandmarks() / getPinchPoint() 对外返回时各调用一次。
 */
function _mirrorX(x) { return 1 - x; }

/** 模块级预定义：stop() 里 getTracks().forEach(_stopTrack)，避免在 stop 内建箭头闭包 */
function _stopTrack(t) { t.stop(); }

/** 轮询等待用的延时（不在 rAF 循环体内，用普通函数避免箭头闭包） */
function _delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 构造时一次性建好 21 个 {x,y,z} 点 */
function _allocLandmarks() {
  const arr = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) arr.push({ x: 0, y: 0, z: 0 });
  return arr;
}

/** 构造时一次性建好 WAVE 历史样本（元素预分配，循环内只赋值字段） */
function _allocWaveSamples(cap) {
  const arr = [];
  for (let i = 0; i < cap; i++) arr.push({ t: 0, x: 0 });
  return arr;
}

/* -------------------------------------------------------------------------- */
/* HandTracker                                                                 */
/* -------------------------------------------------------------------------- */

export class HandTracker {
  static _instance = null;

  static getInstance() {
    if (!HandTracker._instance) HandTracker._instance = new HandTracker();
    return HandTracker._instance;
  }

  constructor() {
    // 21 点平滑输入（内部，未镜像；判定与 Lerp 都基于它）
    this._smooth = _allocLandmarks();
    // 21 点对外输出（镜像后，预分配引用；getLandmarks() 每次从头覆盖，绝不累积翻转）
    this._landmarks = _allocLandmarks();
    // 捏合点：内部分量 + 对外镜像后的预分配对象
    this._pinchSmooth = { x: 0, y: 0 };
    this._pinchPoint = { x: 0, y: 0 };
    // WAVE 掌心 x 历史（线性缓冲，满时左移；循环内零分配）
    this._waveSamples = _allocWaveSamples(WAVE_SAMPLE_CAP);
    this._waveCount = 0;

    // 回调数组预分配；stop() 用 length=0 清空但保留数组对象
    this._errorCallbacks = [];
    this._gestureCallbacks = [];

    // rAF 回调在构造时预绑定一次，循环体内不再创建闭包 / 箭头函数
    this._boundLoop = this._loop.bind(this);

    this._rafId = 0;
    this._stream = null;
    this._landmarker = null;
    this._video = null;
    this._running = false;

    this._gesture = GESTURES.NONE;
    this._candidate = GESTURES.NONE;   // 去抖：当前候选
    this._candidateFrames = 0;         // 去抖：候选连续稳定帧数
    this._lastTs = 0;                  // detectForVideo 时间戳严格递增
    this._frameCount = 0;
    this._hasSmoothed = false;         // 首帧直接初始化，不做 Lerp
  }

  /**
   * 启动摄像头 + 初始化识别器。失败抛出带 name / userMessage 的 Error 并触发 onError。
   * 前置安全检查必须在任何 getUserMedia 之前：非安全上下文（http://局域网IP）下
   * navigator.mediaDevices 是 undefined，不先判断会抛
   * TypeError: Cannot read property 'getUserMedia' of undefined。
   * @param {HTMLVideoElement} videoElement 由阶段 3 设施层创建并传入
   * @returns {Promise<void>}
   */
  async start(videoElement) {
    if (this._running) return;   // 幂等：重复 start 不再初始化，避免重复 rAF / WASM 堆

    try {
      // 1) 前置安全检查（必须在 getUserMedia 之前）
      if (!window.isSecureContext) {
        throw this._makeError('InsecureContext', TRACKER_ERRORS.InsecureContext);
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw this._makeError('Unsupported', TRACKER_ERRORS.Unsupported);
      }
      if (!videoElement) {
        throw new Error('start(videoElement) 需要一个 <video> 元素');
      }

      // 2) 请求摄像头（分辨率集中在 VIDEO_CONSTRAINTS）
      this._stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);

      // 3) 绑定流 + 播放 + 等待 readyState >= 2（轮询 + 超时）
      this._video = videoElement;
      videoElement.srcObject = this._stream;
      await videoElement.play();
      await this._waitForReadyState(videoElement);

      // 4) 动态 import + FilesetResolver（WASM 走 npm 同版本 CDN，不拷贝 libs/wasm）
      let vision;
      let fileset;
      try {
        vision = await import('@mediapipe/tasks-vision');
        fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      } catch (err) {
        throw this._modelError(err);
      }

      // 5) 创建识别器：GPU 优先，失败自动降级 CPU 并重试一次，两次都失败才抛
      const opts = {
        baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: CAREMA_DETECT_CONFIDENCE.minHandDetectionConfidence,
        minHandPresenceConfidence: CAREMA_DETECT_CONFIDENCE.minHandPresenceConfidence,
        minTrackingConfidence: CAREMA_DETECT_CONFIDENCE.minTrackingConfidence,
      };
      let landmarker = null;
      try {
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts);
      } catch (gpuErr) {
        opts.baseOptions.delegate = 'CPU';
        try {
          landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts);
        } catch (cpuErr) {
          throw this._modelError(cpuErr, gpuErr);
        }
      }
      this._landmarker = landmarker;

      // 6) 复位逐帧状态并启动 rAF 循环
      this._frameCount = 0;
      this._lastTs = 0;
      this._hasSmoothed = false;
      this._waveCount = 0;
      this._gesture = GESTURES.NONE;
      this._candidate = GESTURES.NONE;
      this._candidateFrames = 0;
      this._running = true;
      this._rafId = requestAnimationFrame(this._boundLoop);
    } catch (err) {
      // stop() 按 v4 生命周期会清空回调数组，故错误上报必须在 stop 之前完成；
      // throw 仍在 stop 之后 —— 满足「先 stop() 清理半成品再抛」，
      // 异常既不能静默吞掉也不能让应用冻结。
      const e = this._classifyError(err);
      this._emitError(e);
      this.stop();
      throw e;
    }
  }

  /**
   * 停止并逐项清理；幂等，可重复调用不抛错。
   * ⑥ 不要移除 DOM：video 与叠加 canvas 由阶段 3 设施层创建并移除，本模块不负责，
   *    避免两处重复移除或都漏掉。
   * 与 CAREMA 不同（CAREMA 从不 close）：本模块按 v4 生命周期要求 stop() 时 close、
   * start() 时重建，避免多次进入设施累积 WASM 堆。
   */
  stop() {
    // ① 停 rAF 循环
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;

    // ② 关闭摄像头轨道（模块级 _stopTrack，不在 stop 内建箭头闭包）
    if (this._stream) {
      this._stream.getTracks().forEach(_stopTrack);
      this._stream = null;
    }

    // ③ close 识别器（与 CAREMA 差异见方法注释）
    try {
      if (this._landmarker && this._landmarker.close) this._landmarker.close();
    } catch (closeErr) {
      console.warn('[HandTracker] landmarker.close() 异常', closeErr);
    }
    this._landmarker = null;

    // ④ 解绑 video（不动 DOM 结构）
    if (this._video) this._video.srcObject = null;
    this._video = null;

    // ⑤ 清空回调数组（保留预分配数组对象）、复位状态。
    //    任务书 3.7「移除所有 addEventListener」指 DOM 事件监听，本模块不绑 DOM 事件；
    //    这里清空内部回调是为了防止多次进出设施时回调累积（阶段 3 每次 start 前重注册）。
    //    注意：start() 失败时 _emitError 必须在 stop() 之前调用，否则回调已被清空收不到。
    this._errorCallbacks.length = 0;
    this._gestureCallbacks.length = 0;
    this._running = false;
    this._gesture = GESTURES.NONE;
    this._candidate = GESTURES.NONE;
    this._candidateFrames = 0;
    this._lastTs = 0;
    this._frameCount = 0;
    this._waveCount = 0;
    this._hasSmoothed = false;
    this._resetLandmarks();
  }

  /** 当前手势枚举字符串 */
  getGesture() { return this._gesture; }

  /**
   * 21 点归一化坐标（x,y∈[0,1]；z 为相对腕部深度，MediaPipe 原生即此项，直接返回）。
   * ⚠️ 返回模块内预分配数组的引用：勿修改、勿长期持有（下一帧会被覆盖）。
   * 【坐标镜像只做一次】CAREMA 用 CSS 镜像（index.html:117-127），本项目 3D 场景
   * 改用数值镜像；阶段 3 设施层禁止再镜像一次，否则左右方向反掉。
   * @returns {Array<{x:number,y:number,z:number}>}
   */
  getLandmarks() {
    const sm = this._smooth;
    const out = this._landmarks;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      out[i].x = _mirrorX(sm[i].x);   // 唯一一次镜像（每次从头覆盖，不累积）
      out[i].y = sm[i].y;
      out[i].z = sm[i].z;             // z 为深度，不参与左右镜像
    }
    return out;
  }

  /**
   * 拇指尖 4 与食指尖 8 中点的屏幕归一化坐标 {x,y}。
   * ⚠️ 返回模块内预分配对象的引用：勿修改、勿长期持有。
   * 同样只在这里做一次数值镜像，阶段 3 设施层禁止再镜像一次。
   * @returns {{x:number,y:number}}
   */
  getPinchPoint() {
    this._pinchPoint.x = _mirrorX(this._pinchSmooth.x);  // 唯一一次镜像
    this._pinchPoint.y = this._pinchSmooth.y;
    return this._pinchPoint;
  }

  /** 是否正在运行 */
  isRunning() { return this._running; }

  /**
   * 注册错误回调，返回取消注册函数（循环内不得创建闭包，故在此用普通函数声明）。
   * ⚠️ 生命周期约定：stop() 会清空回调数组（见 stop() ⑤），因此阶段 3 设施层
   *    必须在**每次 start() 之前重新注册** onError / onGestureChange；
   *    也可用返回的取消函数在 dispose() 里显式解绑，两者都做最稳妥。
   */
  onError(cb) { return this._register(this._errorCallbacks, cb); }

  /**
   * 注册手势切换回调，返回取消注册函数；确认切换后才触发，回调收到手势字符串。
   * ⚠️ 同样受 stop() 清空回调影响，见 onError 的生命周期约定。
   */
  onGestureChange(cb) { return this._register(this._gestureCallbacks, cb); }

  /* ------------------------------------------------------------------------ */
  /* 内部：启动辅助                                                            */
  /* ------------------------------------------------------------------------ */

  _makeError(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
  }

  /** 模型 / WASM 加载失败：统一成 ModelLoadError，message 保留 GPU/CPU 原始原因 */
  _modelError(err, gpuErr) {
    const cpuMsg = (err && err.message) || String(err);
    const detail = gpuErr
      ? `GPU: ${(gpuErr && gpuErr.message) || gpuErr}; CPU: ${cpuMsg}`
      : cpuMsg;
    const e = new Error(`${TRACKER_ERRORS.ModelLoadError}（${detail}）`);
    e.name = 'ModelLoadError';
    e.cause = err;              // 保留原生异常（含原生 name）供排查
    return e;
  }

  /** 等待 video.readyState >= 2（轮询 + 超时），超时抛带明确原因的错误 */
  async _waitForReadyState(video) {
    const deadline = performance.now() + READY_TIMEOUT_MS;
    while (video.readyState < 2) {
      if (performance.now() >= deadline) {
        throw this._makeError(
          'ReadyStateTimeout',
          `摄像头视频流就绪超时（${READY_TIMEOUT_MS}ms），readyState=${video.readyState}`
        );
      }
      await _delay(READY_POLL_MS);
    }
  }

  /**
   * 规整异常：保留原生 name 优先（便于上层按 NotAllowedError 等分类），
   * 补上中文 userMessage；未知 name 走兜底文案。
   */
  _classifyError(err) {
    let e = err;
    if (!(e instanceof Error)) e = new Error(String(e));
    const name = e.name && e.name !== 'Error' ? e.name : 'Error';
    e.name = name;
    e.userMessage = TRACKER_ERRORS[name]
      || TRACKER_ERRORS.Fallback.replace('{原始 message}', e.message || String(e));
    return e;
  }

  _register(arr, cb) {
    if (typeof cb !== 'function') {
      return function _noop() { /* 非法回调：返回空取消函数 */ };
    }
    if (arr.indexOf(cb) === -1) arr.push(cb);
    return function _unregister() {
      const i = arr.indexOf(cb);
      if (i !== -1) arr.splice(i, 1);
    };
  }

  _emitError(err) {
    const arr = this._errorCallbacks;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](err);
      } catch (cbErr) {
        console.error('[HandTracker] onError 回调异常', cbErr);
      }
    }
  }

  _emitGestureChange(gesture) {
    const arr = this._gestureCallbacks;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](gesture);
      } catch (cbErr) {
        console.error('[HandTracker] onGestureChange 回调异常', cbErr);
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 内部：rAF 检测循环（零分配热路径）                                        */
  /* 循环体及其调用链内严禁：new、对象/数组字面量、map/filter/reduce、         */
  /* 箭头函数/闭包创建、模板字符串拼接新对象。所有中间状态均为预分配字段。     */
  /* ------------------------------------------------------------------------ */

  _loop() {
    if (!this._running) return;
    const video = this._video;

    // 循环开头：video 未就绪时排下一帧并 return，绝不抛错
    if (!video || video.readyState < 2) {
      this._rafId = requestAnimationFrame(this._boundLoop);
      return;
    }

    this._frameCount++;
    if (this._frameCount % DETECT_EVERY_N_FRAMES === 0 && this._landmarker) {
      // 时间戳必须来自 performance.now()，且严格单调递增
      let ts = performance.now();
      if (ts <= this._lastTs) ts = this._lastTs + 1;
      this._lastTs = ts;

      let result;
      try {
        // result 由 MediaPipe 库分配，直接读取、不复制、不转换
        result = this._landmarker.detectForVideo(video, ts);
      } catch (err) {
        // 检测异常为罕见路径：不构造新对象、不中断 rAF 链；
        // 原样通过 onError 上报（既不静默吞掉，也不让循环冻结）。
        this._emitError(err);
        this._rafId = requestAnimationFrame(this._boundLoop);
        return;
      }

      const hands = result && result.landmarks;
      if (hands && hands.length > 0) {
        this._smoothLandmarks(hands[0]);          // 内部未镜像坐标
        this._updatePinchSmooth();
        this._applyDebounce(this._classifyGesture(ts));
      } else {
        this._applyDebounce(GESTURES.NONE);       // 无手：候选 NONE，去抖后回落到 NONE
      }
    }
    // DETECT_EVERY_N_FRAMES > 1 的中间帧：不 detect，沿用上次结果（含 Lerp 后的平滑值）

    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  /** 21 点逐点 Lerp 到预分配平滑数组；首帧直接初始化。小牛目标位姿的 Lerp 属于阶段 3。 */
  _smoothLandmarks(raw) {
    const sm = this._smooth;
    if (!this._hasSmoothed) {
      for (let i = 0; i < LANDMARK_COUNT; i++) {
        sm[i].x = raw[i].x;
        sm[i].y = raw[i].y;
        sm[i].z = raw[i].z;
      }
      this._hasSmoothed = true;
    } else {
      for (let i = 0; i < LANDMARK_COUNT; i++) {
        sm[i].x += (raw[i].x - sm[i].x) * LERP_K;
        sm[i].y += (raw[i].y - sm[i].y) * LERP_K;
        sm[i].z += (raw[i].z - sm[i].z) * LERP_K;
      }
    }
  }

  /** 拇指尖 4 与食指尖 8 中点，写入预分配对象（未镜像） */
  _updatePinchSmooth() {
    const t = this._smooth[4];
    const f = this._smooth[8];
    this._pinchSmooth.x = (t.x + f.x) * 0.5;
    this._pinchSmooth.y = (t.y + f.y) * 0.5;
  }

  /** CAREMA index.html:1629-1636 原值：指尖比 PIP 更远离手腕 + 指节角度接近伸直 */
  _isFingerStraight(lm, mcp, pip, dip, tip, threshold) {
    const aPip = _angleAt(lm[mcp], lm[pip], lm[tip]);
    const aDip = _angleAt(lm[pip], lm[dip], lm[tip]);
    const wrist = lm[0];
    const tipFar = _dist2d(lm[tip], wrist) > _dist2d(lm[pip], wrist) * CAREMA_THRESHOLDS.TIP_FAR_RATIO;
    const mcpFar = _dist2d(lm[tip], lm[mcp]) > _dist2d(lm[pip], lm[mcp]) * CAREMA_THRESHOLDS.TIP_FAR_RATIO;
    return tipFar && mcpFar && aPip > threshold && aDip > CAREMA_THRESHOLDS.DIP_MIN;
  }

  /**
   * 按 GESTURE_PRIORITY 依次判定，命中即返回。
   * CAREMA 原值：SCISSORS = idx && mid && !rng && !pnk；OPEN = !scissors && extended >= 3。
   * v4 补齐：PINCH / FIST / POINT / WAVE（阈值见 V4_NEW_THRESHOLDS，属未确认项）。
   * OPEN 只沿用 CAREMA 的 extended>=3，不再引入平均距离法，避免两套 OPEN 冲突。
   */
  _classifyGesture(now) {
    const lm = this._smooth;

    // 掌心 x（点 0/5/9/13/17 均值），供 WAVE 往返检测；先入历史窗口
    const palmX = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) * 0.2;
    this._pushWaveSample(now, palmX);

    const idx = this._isFingerStraight(lm, 5, 6, 7, 8, CAREMA_THRESHOLDS.IDX);
    const mid = this._isFingerStraight(lm, 9, 10, 11, 12, CAREMA_THRESHOLDS.MID);
    const rng = this._isFingerStraight(lm, 13, 14, 15, 16, CAREMA_THRESHOLDS.RNG);
    const pnk = this._isFingerStraight(lm, 17, 18, 19, 20, CAREMA_THRESHOLDS.PNK);
    const extended = (idx ? 1 : 0) + (mid ? 1 : 0) + (rng ? 1 : 0) + (pnk ? 1 : 0);
    const scissors = idx && mid && !rng && !pnk;

    for (let i = 0; i < GESTURE_PRIORITY.length; i++) {
      const g = GESTURE_PRIORITY[i];
      let hit = false;
      if (g === GESTURES.PINCH) {
        hit = _dist2d(lm[4], lm[8]) < V4_NEW_THRESHOLDS.PINCH_DIST;
      } else if (g === GESTURES.FIST) {
        const avg = (
          _dist2d(lm[8], lm[0]) + _dist2d(lm[12], lm[0]) +
          _dist2d(lm[16], lm[0]) + _dist2d(lm[20], lm[0])
        ) * 0.25;
        hit = avg < V4_NEW_THRESHOLDS.FIST_AVG_DIST;
      } else if (g === GESTURES.POINT) {
        hit = idx && !mid && !rng && !pnk;
      } else if (g === GESTURES.SCISSORS) {
        hit = scissors;                       // 沿用 CAREMA 原值
      } else if (g === GESTURES.OPEN) {
        hit = !scissors && extended >= CAREMA_THRESHOLDS.OPEN_MIN_EXTENDED;  // 沿用 CAREMA 原值
      } else if (g === GESTURES.WAVE) {
        hit = this._detectWave(now);
      } else if (g === GESTURES.NONE) {
        hit = true;
      }
      if (hit) return g;
    }
    return GESTURES.NONE;
  }

  /** WAVE 历史写入：线性缓冲，满时整体左移一格（字段复制，不分配对象） */
  _pushWaveSample(t, x) {
    const buf = this._waveSamples;
    let slot;
    if (this._waveCount < WAVE_SAMPLE_CAP) {
      slot = this._waveCount;
      this._waveCount++;
    } else {
      for (let k = 0; k < WAVE_SAMPLE_CAP - 1; k++) {
        buf[k].t = buf[k + 1].t;
        buf[k].x = buf[k + 1].x;
      }
      slot = WAVE_SAMPLE_CAP - 1;
    }
    buf[slot].t = t;
    buf[slot].x = x;
  }

  /** WAVE 判定：窗口内掌心 x 位移 > 阈值且出现方向反转（往返） */
  _detectWave(now) {
    const buf = this._waveSamples;
    const cutoff = now - V4_NEW_THRESHOLDS.WAVE_WINDOW_MS;
    let minX = 1e9;
    let maxX = -1e9;
    let prevX = 0;
    let prevSign = 0;
    let reversals = 0;
    let n = 0;
    for (let i = 0; i < this._waveCount; i++) {
      const s = buf[i];
      if (s.t < cutoff) continue;
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (n > 0) {
        const dx = s.x - prevX;
        const sign = dx > V4_NEW_THRESHOLDS.WAVE_EPS
          ? 1
          : (dx < -V4_NEW_THRESHOLDS.WAVE_EPS ? -1 : 0);
        if (sign !== 0 && prevSign !== 0 && sign !== prevSign) reversals++;
        if (sign !== 0) prevSign = sign;
      }
      prevX = s.x;
      n++;
    }
    return n >= V4_NEW_THRESHOLDS.WAVE_MIN_SAMPLES
      && (maxX - minX) > V4_NEW_THRESHOLDS.WAVE_MIN_DELTA
      && reversals >= V4_NEW_THRESHOLDS.WAVE_MIN_REVERSALS;
  }

  /** 去抖：候选连续稳定 GESTURE_DEBOUNCE_FRAMES 帧才确认切换，并触发 onGestureChange */
  _applyDebounce(candidate) {
    if (candidate === this._candidate) {
      this._candidateFrames++;
    } else {
      this._candidate = candidate;
      this._candidateFrames = 1;
    }
    if (this._candidateFrames >= GESTURE_DEBOUNCE_FRAMES && this._candidate !== this._gesture) {
      this._gesture = this._candidate;
      this._emitGestureChange(this._gesture);   // 传手势字符串，不构造新对象
    }
  }

  /** 复位坐标（不清空预分配数组对象，只把字段归零） */
  _resetLandmarks() {
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      const s = this._smooth[i];
      s.x = 0; s.y = 0; s.z = 0;
      const o = this._landmarks[i];
      o.x = 0; o.y = 0; o.z = 0;
    }
    this._pinchSmooth.x = 0;
    this._pinchSmooth.y = 0;
    this._pinchPoint.x = 0;
    this._pinchPoint.y = 0;
  }
}

export const handTracker = HandTracker.getInstance();
export default handTracker;
