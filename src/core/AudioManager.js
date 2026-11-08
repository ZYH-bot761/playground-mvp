/**
 * ============================================================================
 * AudioManager —— 全局音效管理器（单例 / Web Audio 实时合成）
 * ============================================================================
 * 职责：
 *   1) 统一封装「点击 / 得分 / 翻牌 / 爆炸」四类基础音效，供各项目调用；
 *   2) 工程内没有任何外部音频文件，全部用振荡器 + 噪声 + 包络现场合成，
 *      不产生网络请求，也不会因 404 / CORS 出现静音以外的问题；
 *   3) 处理浏览器自动播放策略：AudioContext 只在 init() 时创建（初始为
 *      suspended），首次用户手势再 resume()；未解锁时 play() 静默返回 false，
 *      绝不抛错打断调用方。
 *
 * 【零副作用】模块顶层只定义类与音色实现，不创建 AudioContext、不绑定事件；
 *             必须显式调用 init() 之后才具备发声能力。
 *
 * 用法：
 *   import audioManager from './AudioManager.js';
 *   audioManager.init();                 // 启动时调用一次（可传音量 / 静音）
 *   audioManager.play('click');          // 用户手势内调用
 *   audioManager.setVolume(0.5);         // 0 ~ 1
 *   audioManager.setMuted(true);         // 静音开关
 *   audioManager.dispose();              // 整体关闭，释放 AudioContext
 * ============================================================================
 */

/** 默认主音量（0 ~ 1） */
const DEFAULT_VOLUME = 0.7;

/** 支持的音效名：play(name) 的合法入参 */
export const SOUND_NAMES = Object.freeze(['click', 'score', 'flip', 'explode']);

/** 把任意输入夹到 [0, 1] */
function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

export class AudioManager {
  static _instance = null;

  static getInstance() {
    if (!AudioManager._instance) AudioManager._instance = new AudioManager();
    return AudioManager._instance;
  }

  constructor() {
    /** @type {AudioContext|null} 首次 init() 才创建 */
    this._ctx = null;
    /** @type {GainNode|null} 总音量节点，所有音效都挂在它下面 */
    this._master = null;
    /** @type {AudioBuffer|null} 噪声缓冲，首次用到时生成并复用 */
    this._noiseBuffer = null;
    /** @type {Set<AudioNode>} 仍在播 / 排队中的节点，dispose() 时强制断开兜底 */
    this._liveNodes = new Set();
    this._volume = DEFAULT_VOLUME;
    this._muted = false;
    this._unlockBound = false;
    // 手势监听必须保持同一引用，dispose() 时才能精确解绑
    this._onGesture = () => this.unlock();
  }

  /**
   * 初始化音频上下文（幂等）。
   * @param {{volume?: number, muted?: boolean}} [options]
   * @returns {this}
   */
  init({ volume, muted } = {}) {
    if (typeof volume === 'number') this._volume = clamp01(volume);
    if (typeof muted === 'boolean') this._muted = muted;

    if (this._ctx) {
      this._applyMasterGain();
      return this;
    }

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) {
      console.warn('[AudioManager] 当前环境不支持 Web Audio，音效将静默跳过。');
      return this;
    }

    try {
      this._ctx = new AudioCtor();
      this._master = this._ctx.createGain();
      this._master.connect(this._ctx.destination);
      this._applyMasterGain();
      // 自动播放策略：先挂手势监听，首次交互时 resume
      this._bindUnlock();
    } catch (err) {
      console.error('[AudioManager] 创建 AudioContext 失败：', err);
      // 上下文可能已创建、仅后续节点装配失败：一并关闭，避免留下半初始化资源
      const broken = this._ctx;
      this._ctx = null;
      this._master = null;
      if (broken && broken.state !== 'closed') {
        try {
          const closing = broken.close();
          if (closing && typeof closing.catch === 'function') closing.catch(() => {});
        } catch (closeErr) {
          /* 忽略 */
        }
      }
    }
    return this;
  }

  /**
   * 尝试解锁音频（需在用户手势调用栈内效果最好）。
   * 未初始化或已关闭时返回 false，不抛错。
   * @returns {Promise<boolean>}
   */
  unlock() {
    const ctx = this._ctx;
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'closed') {
      this._unbindUnlock();
      return Promise.resolve(false);
    }
    if (ctx.state === 'running') {
      this._unbindUnlock();
      return Promise.resolve(true);
    }
    try {
      const resumed = ctx.resume();
      return Promise.resolve(resumed)
        .then(() => {
          // dispose() 后若已重建上下文，旧 Promise 不得改动新实例的监听状态
          if (this._ctx !== ctx) return false;
          const running = ctx.state === 'running';
          if (running) this._unbindUnlock();
          return running;
        })
        .catch((err) => {
          console.warn('[AudioManager] 音频解锁失败（等待下一次用户手势）：', err);
          return false;
        });
    } catch (err) {
      console.warn('[AudioManager] 音频解锁异常：', err);
      return Promise.resolve(false);
    }
  }

  /**
   * 播放一个音效。
   * @param {'click'|'score'|'flip'|'explode'} name
   * @param {{volume?: number, rate?: number}} [options] volume 相对该音效的倍率，rate 变调倍率
   * @returns {boolean} 是否真正发声（未初始化 / 未解锁 / 静音时返回 false）
   */
  play(name = 'click', { volume = 1, rate = 1 } = {}) {
    const ctx = this._ctx;
    const synth = SYNTHS[name];
    if (!synth) {
      console.warn(`[AudioManager] 未知音效：${name}，可用值：${SOUND_NAMES.join(' / ')}`);
      return false;
    }
    if (!ctx || !this._master || this._muted) return false;
    if (ctx.state !== 'running') {
      // 静默跳过并顺手尝试解锁；不等待 Promise，避免在渲染循环里制造微任务抖动
      this.unlock();
      return false;
    }
    try {
      synth.call(this, ctx, ctx.currentTime + 0.001, {
        volume: clamp01(volume),
        rate: Math.max(0.25, Number(rate) || 1),
      });
      return true;
    } catch (err) {
      console.warn(`[AudioManager] 播放「${name}」失败：`, err);
      return false;
    }
  }

  /** 便捷方法：点击音 */
  playClick(options) {
    return this.play('click', options);
  }

  /** 便捷方法：得分音 */
  playScore(options) {
    return this.play('score', options);
  }

  /** 便捷方法：翻牌音 */
  playFlip(options) {
    return this.play('flip', options);
  }

  /** 便捷方法：爆炸音 */
  playExplode(options) {
    return this.play('explode', options);
  }

  /** @param {number} value 0 ~ 1，超界自动夹取 */
  setVolume(value) {
    this._volume = clamp01(value);
    this._applyMasterGain();
    return this;
  }

  get volume() {
    return this._volume;
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this._muted = Boolean(muted);
    this._applyMasterGain();
    return this;
  }

  get muted() {
    return this._muted;
  }

  toggleMute() {
    return this.setMuted(!this._muted);
  }

  /** 上下文是否已就绪（可发声） */
  get unlocked() {
    return this._ctx?.state === 'running';
  }

  /**
   * 整体关闭：解绑手势监听 → 停止/断开所有存活音频节点 → 关闭 AudioContext。
   * 重复调用安全；关闭后仍可再次 init() 重建（单例对象不会被销毁）。
   */
  dispose() {
    this._unbindUnlock();

    // ① 仍在播 / 已排队但未结束的节点：正常播完会自解绑，这里作为兜底强制断开
    this._liveNodes.forEach((node) => {
      try {
        node.stop?.();
      } catch (err) {
        /* 已停止或非可停止节点，忽略 */
      }
      try {
        node.disconnect();
      } catch (err) {
        /* 已断开，忽略 */
      }
    });
    this._liveNodes.clear();

    const ctx = this._ctx;
    const master = this._master;
    this._ctx = null;
    this._master = null;
    this._noiseBuffer = null;

    // ② 总音量节点
    if (master) {
      try {
        master.disconnect();
      } catch (err) {
        console.warn('[AudioManager] 断开总音量节点失败：', err);
      }
    }

    // ③ AudioContext：close() 会释放底层音频线程与节点资源
    if (ctx && ctx.state !== 'closed') {
      try {
        const closing = ctx.close();
        if (closing && typeof closing.catch === 'function') {
          closing.catch((err) => console.warn('[AudioManager] 关闭 AudioContext 失败：', err));
        }
      } catch (err) {
        console.warn('[AudioManager] 关闭 AudioContext 失败：', err);
      }
    }

    // ④ 状态复位：下次 init() 从默认音量 / 非静音开始，避免沿用上一次的静音态
    this._volume = DEFAULT_VOLUME;
    this._muted = false;
    this._unlockBound = false;
  }

  /* ------------------------------------------------------------------ */
  /* 内部实现                                                            */
  /* ------------------------------------------------------------------ */

  _applyMasterGain() {
    const ctx = this._ctx;
    const master = this._master;
    if (!ctx || !master) return;
    const target = this._muted ? 0 : this._volume;
    try {
      // 短时间常数平滑，避免调音量 / 静音时出现爆音
      master.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
    } catch (err) {
      master.gain.value = target;
    }
  }

  _bindUnlock() {
    if (this._unlockBound) return;
    const options = { passive: true };
    window.addEventListener('pointerdown', this._onGesture, options);
    window.addEventListener('keydown', this._onGesture, options);
    window.addEventListener('touchstart', this._onGesture, options);
    this._unlockBound = true;
  }

  _unbindUnlock() {
    if (!this._unlockBound) return;
    window.removeEventListener('pointerdown', this._onGesture);
    window.removeEventListener('keydown', this._onGesture);
    window.removeEventListener('touchstart', this._onGesture);
    this._unlockBound = false;
  }

  /**
   * 单个振荡器 + 指数包络。
   * @param {AudioContext} ctx
   * @param {number} time 起始时间（AudioContext 时间轴）
   * @param {{type?: OscillatorType, freq: number, endFreq?: number, duration?: number,
   *          gain?: number, attack?: number, detune?: number}} tone
   */
  _tone(ctx, time, {
    type = 'sine',
    freq = 440,
    endFreq = freq,
    duration = 0.2,
    gain = 0.2,
    attack = 0.006,
    detune = 0,
  }) {
    const startFreq = Math.max(20, freq);
    const stopFreq = Math.max(20, endFreq);

    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = type;
    osc.detune.setValueAtTime(detune, time);
    osc.frequency.setValueAtTime(startFreq, time);
    if (stopFreq !== startFreq) {
      // exponentialRamp 不接受 0，频率已夹到 20Hz 以上
      osc.frequency.exponentialRampToValueAtTime(stopFreq, time + duration);
    }

    const peak = Math.max(0.0001, gain);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(peak, time + Math.min(attack, duration * 0.5));
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(env);
    env.connect(this._master);
    this._liveNodes.add(osc);
    this._liveNodes.add(env);
    osc.start(time);
    osc.stop(time + duration + 0.02);
    osc.onended = () => {
      this._liveNodes.delete(osc);
      this._liveNodes.delete(env);
      try {
        osc.disconnect();
        env.disconnect();
      } catch (err) {
        /* 节点已随上下文回收，忽略 */
      }
    };
  }

  /**
   * 白噪声 + 带通/低通扫频，用于「翻牌」「爆炸」的质感层。
   * @param {AudioContext} ctx
   * @param {number} time
   * @param {{duration?: number, gain?: number, filterType?: BiquadFilterType,
   *          startFreq?: number, endFreq?: number, q?: number}} noise
   */
  _noise(ctx, time, {
    duration = 0.3,
    gain = 0.2,
    filterType = 'lowpass',
    startFreq = 1800,
    endFreq = 200,
    q = 0.8,
  }) {
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    source.buffer = this._getNoiseBuffer(ctx);
    filter.type = filterType;
    filter.Q.setValueAtTime(q, time);
    filter.frequency.setValueAtTime(Math.max(20, startFreq), time);
    if (endFreq !== startFreq) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), time + duration);
    }

    const peak = Math.max(0.0001, gain);
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(peak, time + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(this._master);
    this._liveNodes.add(source);
    this._liveNodes.add(filter);
    this._liveNodes.add(env);
    source.start(time);
    source.stop(time + duration + 0.02);
    source.onended = () => {
      this._liveNodes.delete(source);
      this._liveNodes.delete(filter);
      this._liveNodes.delete(env);
      try {
        source.disconnect();
        filter.disconnect();
        env.disconnect();
      } catch (err) {
        /* 忽略 */
      }
    };
  }

  _getNoiseBuffer(ctx) {
    if (this._noiseBuffer && this._noiseBuffer.sampleRate === ctx.sampleRate) {
      return this._noiseBuffer;
    }
    // 1 秒白噪声足够覆盖所有扫频段，复用同一 buffer 避免反复分配
    const length = Math.floor(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buffer;
    return buffer;
  }
}

/**
 * 音色表：每个函数签名 (ctx, time, {volume, rate})，内部通过 this 使用合成基元。
 *   click   —— 「滴」：高频短促下滑
 *   score   —— 「叮咚」：三连上行琶音
 *   flip    —— 「嗒」：带通噪声扫频 + 木质感短音
 *   explode —— 「咚」：低频冲击 + 噪声轰响
 */
const SYNTHS = {
  click(ctx, time, { volume, rate }) {
    this._tone(ctx, time, {
      type: 'sine',
      freq: 1180 * rate,
      endFreq: 780 * rate,
      duration: 0.09,
      gain: 0.2 * volume,
      attack: 0.002,
    });
    this._tone(ctx, time, {
      type: 'triangle',
      freq: 2360 * rate,
      endFreq: 1560 * rate,
      duration: 0.045,
      gain: 0.06 * volume,
      attack: 0.001,
    });
  },

  score(ctx, time, { volume, rate }) {
    const notes = [784, 988, 1319]; // G5 / B5 / E6
    notes.forEach((freq, index) => {
      this._tone(ctx, time + index * 0.075, {
        type: 'triangle',
        freq: freq * rate,
        endFreq: freq * rate * 1.002,
        duration: 0.22,
        gain: 0.13 * volume,
        attack: 0.004,
      });
    });
  },

  flip(ctx, time, { volume, rate }) {
    this._noise(ctx, time, {
      duration: 0.13,
      gain: 0.16 * volume,
      filterType: 'bandpass',
      startFreq: 2600 * rate,
      endFreq: 700 * rate,
      q: 1.1,
    });
    this._tone(ctx, time + 0.01, {
      type: 'triangle',
      freq: 460 * rate,
      endFreq: 260 * rate,
      duration: 0.1,
      gain: 0.07 * volume,
      attack: 0.003,
    });
  },

  explode(ctx, time, { volume, rate }) {
    this._noise(ctx, time, {
      duration: 0.55,
      gain: 0.3 * volume,
      filterType: 'lowpass',
      startFreq: 1800 * rate,
      endFreq: 90 * rate,
      q: 0.7,
    });
    this._tone(ctx, time, {
      type: 'sine',
      freq: 140 * rate,
      endFreq: 42 * rate,
      duration: 0.5,
      gain: 0.28 * volume,
      attack: 0.004,
    });
  },
};

export const audioManager = AudioManager.getInstance();
export default audioManager;
