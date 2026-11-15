/**
 * ============================================================================
 * DemoEmbedView —— T03 最小闭环验证用的嵌入视图（零 GPU 资源）
 * ============================================================================
 * 【它不做什么】
 * 不建任何 geometry / material / texture，不接木马 / 海盗船 / 摩天轮的真实玩法
 * （那是 T04 / T07 / T08 的事），不改 background / fog，不碰 Lobby 根节点。
 *
 * 【它只做什么】
 * 提供一个大厅内的固定相机机位（广场中轴、略高于人眼，望向广场深处）。
 * 进入后 CameraRig 把唯一那台相机 blend 过去 —— 天空、草坪、城堡门、木马、
 * 海盗船、世纪钟、NPC 全都还在视野里，从而用最小代价证明「不割裂」。
 *
 * 【为什么放在 (0, 4, 10) → (0, 3, -4)】
 * 起点在广场中轴靠入口侧，终点望向魔法牌屋方向；两侧木马(9,6)/海盗船(-9,6)、
 * 右前方世纪钟(6,-3) 都在画面内，能直观看到「仍在同一个 3D 大厅」。
 * 这是验证锚点，T04+ 接入真实设施时会用各设施自己的 IEmbeddedView.getCameraAnchor。
 * ============================================================================
 */

import * as THREE from 'three';
import { IEmbeddedView } from './IEmbeddedView.js';

/** 验证用 key；DayNightCycle 白名单与 main.js EMBEDDED_KEYS 需保持一致 */
export const DEMO_EMBED_KEY = 'demo-embed';

const DEMO_POSITION = new THREE.Vector3(0, 4, 10);
const DEMO_TARGET = new THREE.Vector3(0, 3, -4);
const DEMO_FOV = 55;

export class DemoEmbedView extends IEmbeddedView {
  constructor() {
    super();
    this.key = DEMO_EMBED_KEY;

    // Matrix4.lookAt 采用相机约定（-Z 指向 target），避免 Object3D.lookAt 的 +Z 反向
    const matrix = new THREE.Matrix4().lookAt(
      DEMO_POSITION, DEMO_TARGET, new THREE.Vector3(0, 1, 0)
    );
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);

    /** @type {{position: THREE.Vector3, quaternion: THREE.Quaternion,
     *          lookAt: THREE.Vector3, fov: number}} */
    this._anchor = {
      position: DEMO_POSITION.clone(),
      quaternion,
      lookAt: DEMO_TARGET.clone(),
      fov: DEMO_FOV,
    };
  }

  /**
   * 只登记一个空 Object3D 锚点到 SceneContext（零 GPU 资源、不绘制）。
   * 后续 T04+ 可直接从 sceneContext.getAnchor('demo-embed') 复用这个坐标。
   * @param {Object} ctx
   * @returns {this}
   */
  init(ctx) {
    super.init(ctx);
    ctx?.sceneContext?.setAnchor(this.key, this._anchor.position);
    return this;
  }

  /**
   * @returns {{position: THREE.Vector3, quaternion: THREE.Quaternion,
   *            lookAt: THREE.Vector3, fov: number}}
   */
  getCameraAnchor() {
    return {
      position: this._anchor.position.clone(),
      quaternion: this._anchor.quaternion.clone(),
      lookAt: this._anchor.lookAt.clone(),
      fov: this._anchor.fov,
    };
  }

  /**
   * 验证用途：无玩法矩阵、无对象更新。
   * 保留钩子供 T04/T07/T08 参考「每帧只改矩阵、不 new 资源」的写法。
   * @param {number} _dt
   */
  update(_dt) {
    // 刻意留空
  }
}

export default DemoEmbedView;
