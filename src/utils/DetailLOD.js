/**
 * ============================================================================
 * DetailLOD —— 手册 P6 三级细节层次（近/中/远）
 * ============================================================================
 * 继承 THREE.LOD：渲染器投影阶段自动按相机距离切换 level（autoUpdate 默认 true），
 * 无需手动 update。wrap() 把已建好的精细 Group 包成 level0，并按其包围盒生成
 * 中景简化体（Icosahedron 轮廓）与远景极简体（Box 剪影），复用调用方传入的
 * 共享几何/材质 → 零新增 GPU 资源。
 * 距离阈值默认 [0, 70, 90]：大厅 orbit 上限 50 + 设施半径 26 → 绕到对面远端
 * 才会触发中/远景，默认机位（最远设施约 66m）仍看全模。
 * ============================================================================
 */

import * as THREE from 'three';

export class DetailLOD extends THREE.LOD {
  constructor(high, medium, low, distances = [0, 70, 90]) {
    super();
    this.addLevel(high, distances[0]);
    this.addLevel(medium, distances[1]);
    this.addLevel(low, distances[2]);
  }

  /**
   * @param {THREE.Group} group 已加入场景的精细外观（会被重新挂到 LOD 下）
   * @param {THREE.BufferGeometry} geoMed 中景共享几何
   * @param {THREE.BufferGeometry} geoLow 远景共享几何
   * @param {THREE.Material} mat 共享材质（取设施主色）
   */
  static wrap(group, geoMed, geoLow, mat, distances = [0, 70, 90]) {
    const parent = group.parent;
    group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3()).sub(group.getWorldPosition(new THREE.Vector3()));

    const medium = new THREE.Mesh(geoMed, mat);
    medium.name = `${group.name}/lod-medium`;
    medium.position.copy(center);
    medium.scale.copy(size).multiplyScalar(0.5);
    const low = new THREE.Mesh(geoLow, mat);
    low.name = `${group.name}/lod-low`;
    low.position.copy(center);
    low.scale.copy(size).multiplyScalar(0.45);

    const lod = new DetailLOD(group, medium, low, distances);
    lod.name = `${group.name}/lod`;
    lod.position.copy(group.position);
    group.position.set(0, 0, 0);
    parent.add(lod);
    return lod;
  }
}

export default DetailLOD;