/**
 * modelLoaderSelfTest.js —— 第四部分 ModelLoader 真机自检（开发/验收用）。
 * 不依赖任何外部 .glb：用 GLTFExporter 在内存生成一个合法 GLB（blob: URL），
 * 走真实 GLTFLoader.load 链路，验证 缓存 / 并发合并 / LOD / 占位回退 / 清理。
 * 通过 browser-use evaluate_script: import('/src/utils/modelLoaderSelfTest.js')
 * 再 runModelLoaderSelfTest() 调用；返回实测指标对象。
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import modelLoader from './ModelLoader.js';

export async function runModelLoaderSelfTest() {
  const src = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xff0000 })
  );
  const buf = await new GLTFExporter().parseAsync(src, { binary: true });
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
  modelLoader.registerAsset(blobUrl);

  // 并发同 URL：应合并为一次真实加载（pendingJoins>=1, loads==1）
  const [g1, g2] = await Promise.all([modelLoader.load(blobUrl), modelLoader.load(blobUrl)]);
  const concurrentSame = g1 === g2;
  // 再次加载：缓存命中（同一对象）
  const g3 = await modelLoader.load(blobUrl);
  const cacheSame = g3 === g1;
  let meshCount = 0;
  g1.scene.traverse((o) => { if (o.isMesh) meshCount += 1; });

  // 未登记资产 → 程序化占位，不发起网络请求
  const fb = await modelLoader.loadOrFallback('models/absent.glb', () =>
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));

  // LOD 三档按相机距离切换
  const lod = modelLoader.createLOD([
    { object: new THREE.Object3D(), distance: 0 },
    { object: new THREE.Object3D(), distance: 20 },
    { object: new THREE.Object3D(), distance: 60 },
  ]);
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 0, 5); cam.updateMatrixWorld(true); lod.update(cam); const nearLevel = lod.getCurrentLevel();
  cam.position.set(0, 0, 40); cam.updateMatrixWorld(true); lod.update(cam); const midLevel = lod.getCurrentLevel();
  cam.position.set(0, 0, 100); cam.updateMatrixWorld(true); lod.update(cam); const farLevel = lod.getCurrentLevel();

  const stats = { ...modelLoader.stats };
  modelLoader.clear();
  const cacheAfterClear = modelLoader.cache.size;
  URL.revokeObjectURL(blobUrl);
  src.geometry.dispose(); src.material.dispose();

  return {
    glbBytes: buf.byteLength,
    concurrentSame, cacheSame, meshCount,
    fallback: fb.fallback, fallbackIsMesh: fb.scene.isMesh === true,
    lodLevels: [nearLevel, midLevel, farLevel],
    stats, cacheAfterClear,
  };
}
export default runModelLoaderSelfTest;