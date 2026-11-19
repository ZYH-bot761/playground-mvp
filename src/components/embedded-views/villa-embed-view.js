/**
 * ============================================================================
 * VillaEmbedView —— 「我的家 · 现代别墅」嵌入视图（v3 同场并置）
 * ============================================================================
 * 【为什么改】用户原话：「别墅应该是真实放在大厅的，从窗户或阳台看出去，
 *   是真实大厅对应的界面，整个大项目互相影响，不是各自独立」。
 *   旧路径把 Villa 当独立 IAttraction → AttractionManager 卸载整个 Lobby，
 *   别墅自己画了一片假草地、假摩天轮、假园区剪影 —— 两套世界各说各话。
 *
 * 【现在】别墅的 root 直接落在大厅都会区那栋别墅的地址上
 *   （CITY_VILLA x=-30 z=134，绕 Y 转 180°，基座抬高 1.2m），
 *   大厅常驻不卸载，只把相机 blend 进 1F 玄关；
 *   进入时把同址的都会区外壳 `City/villa` 藏掉（它是实心盒，会包住室内），
 *   退出时恢复。于是 2F/3F 阳台、各层窗户看到的就是真实的街道、大都会、
 *   草坪与远处设施 —— 这才是「整项目互相影响」。
 *
 * 【契约】实现 IEmbeddedView 六方法；GPU 资源全在 Villa 内部，dispose 时统一释放。
 * ============================================================================
 */
import { IEmbeddedView } from './i-embedded-view.js';
import { Villa } from '../../scenes/attractions/villa.js';

export const VILLA_EMBED_KEY = 'villa';

export class VillaEmbedView extends IEmbeddedView {
  /**
   * @param {Object} baseCtx main.js 的 baseCtx（含 onExitAttraction / ui 等业务回调；
   *   FacilityRuntime 注入的 ctx 只有 scene/camera/renderer，需要二者合并）
   */
  constructor(baseCtx) {
    super();
    this.key = VILLA_EMBED_KEY;
    this.baseCtx = baseCtx || {};
    /** @type {Villa|null} 别墅本体（自带场景结构 / 家具 / 电梯 / HUD） */
    this.villa = null;
  }

  init(ctx) {
    super.init(ctx);
    this.villa = new Villa();
    this.villa.init({
      ...this.baseCtx,
      ...ctx,
      onExitAttraction: this.baseCtx.onExitAttraction,
    });
    this.root = this.villa.root;
    return this;
  }

  getCameraAnchor() {
    if (!this.villa) throw new Error('[VillaEmbedView] 未 init');
    return this.villa.getCameraAnchor();
  }

  update(dt) {
    this.villa?.update(dt);
  }

  activate() {
    super.activate();
    this.villa?.activate();
    return this;
  }

  deactivate() {
    this.villa?.deactivate();
    super.deactivate();
    return this;
  }

  dispose() {
    this.villa?.dispose();
    this.villa = null;
    super.dispose();
  }
}

export default VillaEmbedView;
