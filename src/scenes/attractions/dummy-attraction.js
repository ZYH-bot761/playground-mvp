/**
 * ============================================================================
 * DummyAttraction —— 「笨蛋项目」（M2 资源清理测试桩）
 * ============================================================================
 * 定位：静态展示用的最小项目，不实现任何真实玩法（对应 PRD v1.0 里程碑 M2）。
 *       它故意制造一份「可清零的负载」，用来验证 IAttraction.dispose() 契约：
 *
 *   GPU 侧：2 个几何体 + 3 张程序化纹理
 *     - map         → 标准纹理槽位
 *     - normalMap   → 标准纹理槽位
 *     - uTex        → ★ 只存在于 ShaderMaterial.uniforms 中，
 *                      专门用来验证「固定槽位列表扫不到」的高风险漏网纹理
 *   物理侧：1 个 Fixed 刚体（无挂载 collider，不受重力、不参与碰撞响应）
 *           + 1 个独立 Collider（不挂在刚体上）
 *
 * 验收目标：卸载后 renderer.info.memory.geometries / textures 回落至基线，
 *           且 world 中不再残留刚体与碰撞体；反复激活/卸载 5 次不漂移。
 * ============================================================================
 */

import * as THREE from 'three';
import { IAttraction } from './i-attraction.js';

/* -------------------------------------------------------------------------- */
/* 模块级工具函数                                                              */
/* -------------------------------------------------------------------------- */

/** 生成一张程序化棋盘格纹理（PRD 附录 A：优先程序化生成，零成本） */
function makeCheckerTexture(name, colorA, colorB, size = 8) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const c = (x + y) % 2 === 0 ? colorA : colorB;
      const i = (y * size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = name;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true; // DataTexture 必须显式标记才会上传到 GPU
  return texture;
}

/** 1×1 的平面法线贴图（128,128,255 表示「朝 +Z」），作为 normalMap 使用 */
function makeFlatNormalTexture(name) {
  const texture = new THREE.DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.name = name;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 递归扫描一个值，把其中所有 THREE.Texture 记录成「可断开的引用路径」。
 *
 * ★ 与「纹理去重 Set」的区别（本次修复重点）：
 *   一张纹理可能被多个槽位共享（例如同一张图同时挂在 material.map 与
 *   uniforms.uTex.value 上）。dispose() 每张纹理只需调用一次，用 Set 去重正确；
 *   但「断开引用」必须逐条路径执行，绝不能被 Set 去重掉，否则会残留
 *   一条指向已释放纹理的引用，下一次渲染就可能把它重新上传。
 *   因此这里输出的是「不去重的路径数组」，每条都带自己的 clear() 回调。
 *
 * 支持 Texture / Texture[] / 结构体对象 / 结构体数组 / 嵌套组合。
 * @param {*} value
 * @param {string} path 便于日志定位的引用路径
 * @param {Array<{texture: THREE.Texture, path: string, clear: Function}>} out
 * @param {WeakSet<object>} seen 防止循环引用
 * @param {number} depth 深度上限
 * @param {Function} replacer 把该位置替换成新值的回调
 */
function scanTextureValue(value, path, out, seen, depth, replacer) {
  if (value == null || depth > 4) return;
  if (typeof value === 'object' && value.isTexture === true) {
    out.push({ texture: value, path, clear: () => replacer(null) });
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanTextureValue(value[i], `${path}[${i}]`, out, seen, depth + 1, (nv) => { value[i] = nv; });
    }
    return;
  }
  // 普通对象 / 结构体 uniform：继续下钻
  for (const key of Object.keys(value)) {
    scanTextureValue(value[key], `${path}.${key}`, out, seen, depth + 1, (nv) => { value[key] = nv; });
  }
}

/**
 * 【dispose 最高风险点】收集一个材质里「所有」纹理引用路径（不去重）。
 *  (a) 遍历 material 自身全部属性 —— 自动覆盖 map / normalMap / roughnessMap /
 *      aoMap / emissiveMap / envMap / lightMap / alphaMap / displacementMap …
 *      以及未来新增的槽位；
 *  (b) 额外遍历 ShaderMaterial.uniforms 的每个 uniform.value 并递归下钻
 *      —— 这类纹理（本项目的 uniforms.uTex）不在任何标准槽位里，
 *         是最常见的泄漏来源。
 * @returns {Array<{texture: THREE.Texture, path: string, clear: Function}>}
 */
function collectMaterialTextureReferences(material, index) {
  const out = [];
  if (!material) return out;

  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture === true) {
      out.push({
        texture: value,
        path: `materials[${index}].${key}`,
        clear: () => { material[key] = null; },
      });
    }
  }

  const uniforms = material.uniforms;
  if (!uniforms || typeof uniforms !== 'object') return out;
  const seen = new WeakSet();
  for (const name of Object.keys(uniforms)) {
    const uniform = uniforms[name];
    if (!uniform || typeof uniform !== 'object') continue;
    const value = 'value' in uniform ? uniform.value : uniform;
    scanTextureValue(
      value,
      `materials[${index}].uniforms.${name}.value`,
      out,
      seen,
      0,
      (nv) => { uniform.value = nv; }
    );
  }
  return out;
}

/** 逐个释放，单个失败不阻断其余资源释放 */
function safeDisposeAll(items, label) {
  for (const item of items) {
    try {
      if (item && typeof item.dispose === 'function') item.dispose();
    } catch (err) {
      console.error(`[DummyAttraction] ${label}.dispose() 失败：`, err);
    }
  }
}

/** 读取物理世界对象数量，仅供控制台验收观察（不同 Rapier 版本可能无 len()） */
function physicsCounts(world) {
  try {
    return {
      bodies: typeof world.bodies?.len === 'function' ? world.bodies.len() : 'n/a',
      colliders: typeof world.colliders?.len === 'function' ? world.colliders.len() : 'n/a',
    };
  } catch {
    return { bodies: 'n/a', colliders: 'n/a' };
  }
}

/* -------------------------------------------------------------------------- */
/* 最小 ShaderMaterial：用于验证 uniforms 中的纹理扫描                          */
/* 使用 three 默认的 GLSL1 写法（WebGL2 下由 three 自动注入兼容宏）              */
/* -------------------------------------------------------------------------- */

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec3 uTint;
  varying vec2 vUv;
  void main() {
    vec4 texel = texture2D(uTex, vUv);
    gl_FragColor = vec4(texel.rgb * uTint, 1.0);
  }
`;

/* -------------------------------------------------------------------------- */
/* 项目实现                                                                    */
/* -------------------------------------------------------------------------- */

export class DummyAttraction extends IAttraction {
  constructor() {
    super();

    /** 项目根节点：由 init() 挂到 scene，由 AttractionManager 卸载时移除 */
    this.root = new THREE.Group();
    this.root.name = 'DummyAttraction';
    this.root.userData.attractionRoot = true;

    this._ctx = null;
    this._disposed = false; // dispose 幂等锁
    this._flash = 0;
    this._stdMaterial = null;

    // 显式台账：与「root.traverse 兜底」并用，Set 去重
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    this._meshes = [];
    this._rigidBodies = [];
    this._standaloneColliders = [];
  }

  /**
   * 创建物体、材质、纹理与物理刚体，并登记到 ctx.registerDisposable。
   * @param {Object} ctx 见 IAttraction.js 契约
   */
  init(ctx) {
    this._ctx = ctx;
    this._disposed = false;
    const { scene, RAPIER, world, registerDisposable } = ctx;
    if (!RAPIER || !world) {
      throw new Error('[DummyAttraction] 缺少已初始化的 Rapier 世界（请先 await physicsManager.init()）');
    }

    /* ---------- 纹理：3 张（其中 1 张仅存在于 ShaderMaterial.uniforms） ---------- */
    const colorMap = makeCheckerTexture('dummy/color-map', [255, 196, 84, 255], [64, 92, 168, 255]);
    colorMap.colorSpace = THREE.SRGBColorSpace;
    const normalMap = makeFlatNormalTexture('dummy/normal-map');
    const uniformOnlyMap = makeCheckerTexture('dummy/uniform-only', [120, 224, 255, 255], [24, 48, 96, 255]);
    uniformOnlyMap.colorSpace = THREE.SRGBColorSpace;

    for (const texture of [colorMap, normalMap, uniformOnlyMap]) {
      this._textures.add(texture);
      registerDisposable(texture);
    }

    /* ---------- 几何体：2 个 ---------- */
    const sphereGeometry = new THREE.SphereGeometry(0.9, 32, 24);
    const plateGeometry = new THREE.PlaneGeometry(1.4, 1.4);

    /* ---------- 材质：2 个（标准材质 + 含纹理 uniform 的 ShaderMaterial） ---------- */
    const standardMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: colorMap,
      normalMap,
      roughness: 0.45,
      metalness: 0.08,
      emissive: new THREE.Color(0x000000),
    });
    this._stdMaterial = standardMaterial;

    const shaderMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: uniformOnlyMap }, // ★ 不在任何标准槽位中，只能靠 uniforms 扫描发现
        uTint: { value: new THREE.Color(0x9fd8ff) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    for (const geo of [sphereGeometry, plateGeometry]) {
      this._geometries.add(geo);
      registerDisposable(geo);
    }
    for (const mat of [standardMaterial, shaderMaterial]) {
      this._materials.add(mat);
      registerDisposable(mat);
    }

    /* ---------- 网格：静态展示，不做动画 ---------- */
    const sphere = new THREE.Mesh(sphereGeometry, standardMaterial);
    sphere.name = 'DummyAttraction/sphere';
    sphere.position.set(-0.95, 0.85, 0);

    const plate = new THREE.Mesh(plateGeometry, shaderMaterial);
    plate.name = 'DummyAttraction/shader-plate';
    plate.position.set(1.0, 0.85, 0);
    plate.rotation.y = -0.25;

    this.root.add(sphere, plate);
    this._meshes.push(sphere, plate);
    scene.add(this.root);

    /* ---------- 物理：Fixed 刚体 + 独立 Collider ---------- */
    // Fixed 类型本身不受重力也不参与动力学；setGravityScale(0) 只是再明确一次。
    // 刻意「不给刚体挂任何 collider」：既符合「不参与碰撞响应」，也避免
    // removeRigidBody 级联删除带来的 double free 风险。
    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0, -30, 0)
      .setGravityScale(0);
    const fixedBody = world.createRigidBody(bodyDesc);
    this._rigidBodies.push(fixedBody);

    // 独立 Collider：createCollider 不传 parent，放在远处并设为 sensor，
    // 专用于验证 dispose 时 removeCollider() 被正确调用。
    const standaloneDesc = RAPIER.ColliderDesc.ball(0.25)
      .setTranslation(0, -50, 0)
      .setSensor(true);
    const standaloneCollider = world.createCollider(standaloneDesc);
    this._standaloneColliders.push(standaloneCollider);

    // ★ 重要：Rapier 句柄的移除不是幂等的，重复 remove 会抛错甚至破坏 WASM 状态。
    //   因此物理资源只由 dispose() 负责，绝不登记进 registry（deactivate 的
    //   第二步 registry.disposeAll() 只兜底 THREE 资源，THREE 的 dispose 是幂等的）。
    console.info('[DummyAttraction] init 完成 | 物理世界：', physicsCounts(world));
  }

  /**
   * 每帧更新：仅维护点击反馈的衰减。静态项目不移动任何物体。
   * ★ 不调用 world.step()：物理推进由 PhysicsManager.step() 独占。
   */
  update(deltaTime) {
    if (this._disposed || this._flash <= 0) return;
    this._flash = Math.max(0, this._flash - deltaTime * 2.5);
    if (this._stdMaterial) {
      this._stdMaterial.emissive.setRGB(this._flash * 0.55, this._flash * 0.22, 0);
    }
  }

  /** 响应 InteractionManager 分发的射线拾取结果 */
  onInteract(hitInfo) {
    if (this._disposed) return;
    console.log('[DummyAttraction] onInteract →', {
      hasHit: hitInfo.hasHit,
      object: hitInfo.object?.name ?? null,
      distance: Number.isFinite(hitInfo.distance) ? hitInfo.distance.toFixed(3) : null,
      point: hitInfo.point,
    });
    if (hitInfo.hasHit) this._flash = 1;
  }

  /**
   * 【最高风险】严格按 IAttraction 契约释放全部资源，且必须幂等：
   * AttractionManager 会先调本方法，再调 registry.disposeAll() 兜底。
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    const world = this._ctx?.world;

    /* ---------- ① 物理资源：顺序敏感 ----------
     * world.removeRigidBody() 会级联删除「挂载在该刚体上」的所有 collider。
     * 所以：先单独 removeCollider 移除独立 collider，再 removeRigidBody 移除刚体；
     * 已被级联删除的 collider 绝不能再次 removeCollider（double free）。
     */
    if (world) {
      for (const collider of this._standaloneColliders) {
        try {
          world.removeCollider(collider, true);
        } catch (err) {
          console.error('[DummyAttraction] removeCollider 失败：', err);
        }
      }
      for (const body of this._rigidBodies) {
        try {
          world.removeRigidBody(body);
        } catch (err) {
          console.error('[DummyAttraction] removeRigidBody 失败：', err);
        }
      }
      console.info('[DummyAttraction] 物理资源已移除 | 物理世界：', physicsCounts(world));
    }
    this._standaloneColliders.length = 0;
    this._rigidBodies.length = 0;

    /* ---------- ② 收集几何体 / 材质：台账 + 遍历兜底，Set 去重 ---------- */
    const geometries = new Set(this._geometries);
    const materials = new Set(this._materials);
    this.root.traverse((obj) => {
      if (!obj.isMesh && !obj.isLine && !obj.isPoints) return;
      if (obj.geometry) geometries.add(obj.geometry);
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m && materials.add(m));
      else if (mat) materials.add(mat);
    });

    /* ---------- ③ 纹理：分离「释放计划」与「引用路径」两套数据 ----------
     * refs 故意【不去重】：一条引用路径对应一次断开动作，共享纹理也要逐路径清理，
     * 这正是原先只用一个 Set 做去重时最容易漏掉的清理路径。
     * texturePlan 才用 Map 去重，保证每张纹理只 dispose() 一次。
     */
    const refs = [];
    let materialIndex = 0;
    for (const material of materials) {
      refs.push(...collectMaterialTextureReferences(material, materialIndex));
      materialIndex += 1;
    }

    const texturePlan = new Map();
    const addToPlan = (texture, source) => {
      if (!texture || !texture.isTexture) return;
      if (!texturePlan.has(texture)) {
        texturePlan.set(texture, { sources: [], disposeCalled: false });
      }
      const meta = texturePlan.get(texture);
      if (!meta.sources.includes(source)) meta.sources.push(source);
    };
    for (const texture of this._textures) addToPlan(texture, '台账');
    for (const ref of refs) addToPlan(ref.texture, ref.path);

    // ③-a 调试：逐张打印 uuid、来源路径与 dispose 调用标记
    console.groupCollapsed(`[DummyAttraction:纹理] 释放计划，共 ${texturePlan.size} 张`);
    for (const [texture, meta] of texturePlan) {
      console.log(
        `uuid=${texture.uuid} | name=${texture.name || '-'} | 来源=[${meta.sources.join(', ')}] | dispose()=待调用`
      );
    }
    console.groupEnd();

    // ③-b 逐张调用 dispose()，写入「已调用」标记；单张失败不阻断其余
    for (const [texture, meta] of texturePlan) {
      try {
        texture.dispose();
        meta.disposeCalled = true;
      } catch (err) {
        console.error(`[DummyAttraction:纹理] uuid=${texture.uuid} dispose() 失败：`, err);
      }
    }

    // ③-c 【关键】dispose 之后立刻断开引用：material.map / normalMap → null，
    //      ShaderMaterial.uniforms.uTex.value → null；每条路径都执行，不因去重跳过。
    const clearedPaths = [];
    for (const ref of refs) {
      try {
        ref.clear();
        clearedPaths.push(ref.path);
      } catch (err) {
        console.error(`[DummyAttraction:纹理] 断开引用 ${ref.path} 失败：`, err);
      }
    }

    // ③-d 汇总表：明确确认 uniforms.uTex 那张是否真的调用了 dispose()
    const clearedSet = new Set(clearedPaths);
    const summary = [];
    for (const [texture, meta] of texturePlan) {
      const uniformPaths = meta.sources.filter((s) => s.includes('uniforms.'));
      const ownPaths = refs.filter((r) => r.texture === texture).map((r) => r.path);
      summary.push({
        uuid: texture.uuid,
        name: texture.name || '-',
        '来源路径': meta.sources.join(' | '),
        'dispose() 已调用': meta.disposeCalled ? '是' : '否',
        '引用已断开': ownPaths.every((p) => clearedSet.has(p)) ? '是' : '否',
      });
      if (uniformPaths.length > 0) {
        console.info(
          `[DummyAttraction:纹理] uniforms 纹理确认 → uuid=${texture.uuid} path=${uniformPaths.join(', ')} dispose()=${meta.disposeCalled ? '已调用' : '未调用'} 引用=${ownPaths.every((p) => clearedSet.has(p)) ? '已断开' : '未断开'}`
        );
      }
    }
    console.table(summary);
    console.info(`[DummyAttraction:纹理] 已断开 ${clearedPaths.length} 条引用路径：`, clearedPaths);

    /* ---------- ④ 释放材质 / 几何体 ----------
     * - material.dispose()  → 释放 shader program（不入 info.memory 计数）
     * - geometry.dispose()  → info.memory.geometries 回落
     * 注意：材质属性已在 ③-c 清空，因此不需要也不会触发 material.needsUpdate。
     */
    safeDisposeAll(materials, 'Material');
    safeDisposeAll(geometries, 'BufferGeometry');

    /* ---------- ⑤ 断开引用，帮助 GC ----------
     * 注意：这里不清 this.root 在 scene 中的父级关系，
     * 「从场景移除」由 AttractionManager 的第 ③ 步统一完成。
     */
    this.root.clear();
    this._meshes.length = 0;
    this._geometries.clear();
    this._materials.clear();
    this._textures.clear();
    this._stdMaterial = null;
    this._flash = 0;

    console.info(
      `[DummyAttraction] dispose 完成 | geometry=${geometries.size} material=${materials.size} texture=${texturePlan.size} 引用路径=${clearedPaths.length}`
    );
  }
}

export default DummyAttraction;
