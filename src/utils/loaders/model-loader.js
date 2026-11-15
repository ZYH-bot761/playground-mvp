/**
 * ============================================================================
 * ModelLoader.js —— Blender / glTF 模型接入单例（手册第四部分）
 * ============================================================================
 * 职责：
 *   · 全局共享一个 GLTFLoader（+ DRACOLoader 解码压缩模型），单例导出。
 *   · load(url, onProgress) → Promise<GLTF>；cache(Map) 命中直接返回，
 *     pending(Map) 合并并发请求（同一 URL 只真正加载一次）。
 *   · loadOrFallback(url, fallbackFactory)：资产缺失 / 加载失败时返回程序化
 *     占位体，保证「加载完成前显示占位符」且永不因缺资产而黑屏。
 *   · createLOD(levels)：THREE.LOD 高/中/低三档，按相机距离自动切换。
 *   · clear()/dispose()：释放缓存模型的 geometry/material/texture 与 DRACO worker。
 *
 * 【资源约束】本工程禁止下载外部资源，仓库未vendored任何 .glb。因此：
 *   · available 清单默认为空 → loadOrFallback 对未登记 URL 直接走程序化占位，
 *     不发起网络请求（避免 404 噪声），运行时保持现有程序化几何。
 *   · blob:/data: URL 视为本地内存资产，允许真实加载（供自检 / 未来内嵌资产）。
 *   · 一旦美术产出 .glb 放入 assets/models/ 并 registerAsset(url)，同一套
 *     缓存 / LOD / 占位逻辑即刻生效，无需改设施代码。
 *
 * 【DRACO】decoderPath 指向本地 'draco/'（未vendored wasm）。仅当模型含
 * KHR_draco_mesh_compression 时才按需取解码器；当前无压缩资产 → 不触发下载。
 * ============================================================================
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/** 模型替换优先级（手册 P4§1）：URL 约定 assets/models/<key>.glb */
export const MODEL_PRIORITIES = Object.freeze([
  { priority: 'P0', key: 'carousel', reason: '结构复杂，程序化建模难达真实效果' },
  { priority: 'P0', key: 'pirate-ship', reason: '船体曲面与装饰细节适合建模' },
  { priority: 'P1', key: 'lobby-gate', reason: '地标建筑，视觉占比大' },
  { priority: 'P1', key: 'century-clock', reason: '地标建筑，需精细建模（第八部分实现）' },
  { priority: 'P2', key: 'parkour-obstacle', reason: '可部分替换，程序化生成仍有优势' },
  { priority: 'P2', key: 'jump-platform', reason: '简单几何体，建模收益较低' },
  { priority: 'P3', key: 'coaster-car', reason: '轨道/车厢适合建模' },
]);

export class ModelLoader {
  constructor() {
    this.loader = new GLTFLoader();
    this.draco = new DRACOLoader();
    this.draco.setDecoderPath('draco/'); // 本地路径；无压缩资产时不触发下载
    this.loader.setDRACOLoader(this.draco);

    this.cache = new Map();   // url -> GLTF
    this.pending = new Map(); // url -> Promise<GLTF>
    this.available = new Set(); // 已 vendored / 登记可加载的 URL
    this.stats = { loads: 0, cacheHits: 0, pendingJoins: 0, fallbacks: 0 };
  }

  /** bootstrap() 初始化钩子（单例已在模块求值时构造，此处供未来配置扩展） */
  init() { return this; }

  /** 登记一个已就位资产 URL（美术产出后调用） */
  registerAsset(url) { this.available.add(url); return this; }
  hasAsset(url) { return this.available.has(url); }

  /**
   * 加载模型：缓存命中 → 立即返回；并发同 URL → 复用同一 Promise；
   * 否则真正发起一次 GLTFLoader.load。
   * @param {string} url
   * @param {(ev:ProgressEvent)=>void} [onProgress]
   * @returns {Promise<object>} GLTF
   */
  load(url, onProgress) {
    if (this.cache.has(url)) {
      this.stats.cacheHits += 1;
      return Promise.resolve(this.cache.get(url));
    }
    if (this.pending.has(url)) {
      this.stats.pendingJoins += 1;
      return this.pending.get(url);
    }
    const promise = new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          this.cache.set(url, gltf);
          this.pending.delete(url);
          this.stats.loads += 1;
          resolve(gltf);
        },
        (ev) => { if (onProgress) onProgress(ev); },
        (err) => {
          this.pending.delete(url);
          reject(err);
        }
      );
    });
    this.pending.set(url, promise);
    return promise;
  }

  /**
   * 设施 init() 推荐入口：资产未登记 / 加载失败 → 程序化占位体（fallbackFactory）。
   * 返回 { scene, gltf, fallback, fromCache }；scene 为缓存场景的 clone，可安全挂场景。
   */
  async loadOrFallback(url, fallbackFactory, onProgress) {
    const isLocalMemory = /^(blob|data):/.test(url);
    if (!this.hasAsset(url) && !isLocalMemory) {
      this.stats.fallbacks += 1;
      return { scene: fallbackFactory(), gltf: null, fallback: true, fromCache: false };
    }
    const fromCache = this.cache.has(url);
    try {
      const gltf = await this.load(url, onProgress);
      return { scene: gltf.scene.clone(true), gltf, fallback: false, fromCache };
    } catch (err) {
      this.stats.fallbacks += 1;
      console.warn(`[ModelLoader] ${url} 加载失败，使用程序化占位：`, err);
      return { scene: fallbackFactory(), gltf: null, fallback: true, fromCache: false };
    }
  }

  /**
   * 多细节层次：levels = [{ object, distance }]，distance 为切换阈值（米）。
   * THREE.LOD.update(camera) 每帧按距离自动选档。
   */
  createLOD(levels) {
    const lod = new THREE.LOD();
    for (const { object, distance } of levels) lod.addLevel(object, distance);
    return lod;
  }

  /** 释放缓存模型持有的全部 GPU 资源（geometry/material/texture） */
  clear() {
    for (const gltf of this.cache.values()) {
      gltf.scene?.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m) continue;
          for (const value of Object.values(m)) {
            if (value && value.isTexture) value.dispose();
          }
          m.dispose();
        }
      });
    }
    this.cache.clear();
    this.pending.clear();
  }

  dispose() {
    this.clear();
    this.draco.dispose();
  }
}

/** 全局单例 */
export const modelLoader = new ModelLoader();
export default modelLoader;