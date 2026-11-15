# 第四部分《Blender 模型接入报告》

> 对应手册第四部分（docs/manual-extract.txt 140–176 行，LOD/缓存/Draco 细则见 245–252 行）。
> 交付：`src/utils/ModelLoader.js`（单例）+ `src/utils/modelLoaderSelfTest.js`（真机自检）
> + `src/main.js` bootstrap 初始化 + 调试句柄暴露。
> **资源硬约束**：禁止下载外部资源；仓库未 vendored 任何 .glb。故运行时保持程序化几何作为
> 占位/回退，ModelLoader 为「集成就绪」状态；自检用内存生成的合法 GLB 走真实加载链路（零外部请求）。

---

## 1. 评估与替换优先级（手册 P4§1）

| 优先级 | 设施/元素 | 理由 | 约定资产 URL |
|---|---|---|---|
| P0 | 旋转木马主体 | 结构复杂，程序化建模难达真实效果 | src/assets/models/carousel.glb |
| P0 | 海盗船主体 | 船体曲面与装饰细节适合建模 | src/assets/models/pirate-ship.glb |
| P1 | 大厅建筑（大门） | 地标建筑，视觉占比大 | src/assets/models/lobby-gate.glb |
| P1 | 世纪钟（第八部分实现） | 地标建筑，需精细建模 | src/assets/models/century-clock.glb |
| P2 | 跑酷障碍物 | 可部分替换，程序化生成仍有优势 | src/assets/models/parkour-obstacle.glb |
| P2 | 跳一跳平台 | 简单几何体，建模收益较低 | src/assets/models/jump-platform.glb |
| P3 | 过山车轨道/车厢 | 适合建模 | src/assets/models/coaster-car.glb |

优先级常量固化于 `ModelLoader.js` 的 `MODEL_PRIORITIES`。

## 2. GLTFLoader 集成
- 导入路径（Three r187 确认）：`import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';`
  DRACO：`import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';`
- 单例：模块级 `export const modelLoader = new ModelLoader()`，全局共享一个 GLTFLoader。
- `load(url, onProgress)` 返回 Promise；`cache: Map<url,GLTF>`、`pending: Map<url,Promise>`。
- bootstrap 初始化：`src/main.js` `bootstrap()` 开头 `modelLoader.init()`；并挂到 `window.__playground.modelLoader`。
- 设施 init() 异步加载 + 占位符范式（集成就绪示例，资产就位后启用）：
  ```js
  // 设施 init() 内：加载完成前显示程序化占位，完成后替换
  const placeholder = this._buildProceduralPlaceholder();
  this.root.add(placeholder);
  const { scene, fallback } = await modelLoader.loadOrFallback(MODEL_URL, () => placeholder);
  if (!fallback) { this.root.remove(placeholder); this.root.add(scene); }
  ```
  `loadOrFallback` 对**未登记** URL 直接返回占位（不发起网络请求，避免 404 噪声）；
  登记后（`registerAsset(url)`）或 blob:/data: 内存资产才走真实 GLTFLoader.load。

## 3. 缓存与并发合并（实测）
- 同 URL 并发两次 `load` → 合并为一次真实加载：`pendingJoins=1, loads=1`，两 Promise  resolve 同一 GLTF 对象（concurrentSame=true）。
- 第三次 `load` → 缓存命中：`cacheHits=1`，返回同一对象（cacheSame=true）。
- `clear()` → 释放缓存模型 geometry/material/texture，`cache.size=0`。

## 4. DRACO 压缩
- `DRACOLoader.setDecoderPath('draco/')`（本地路径）并 `loader.setDRACOLoader(draco)`。
- 仅当 glTF 含 `KHR_draco_mesh_compression` 时才按需取解码器；当前无压缩资产、wasm 未 vendored → **不触发任何下载**，符合资源约束。美术产出压缩模型时把 wasm 放入 public/draco/ 即可启用（手册称可减 70~90% 体积）。

## 5. LOD 多细节层次（实测）
- `createLOD([{object,distance:0},{object,distance:20},{object,distance:60}])` → THREE.LOD。
- 相机距离 5 / 40 / 100 米 → `getCurrentLevel()` = **0 / 1 / 2**（高/中/低自动切换）。
- 设施侧每帧 `lod.update(camera)` 即可；远处自动降档减少 draw call / 三角面。

## 6. 模型制作规范（Blender → glTF）
1. 格式：glTF Binary（.glb），单文件内嵌纹理；Y-up、右手系；单位米（1 unit = 1 m）。
2. 变换：导出前 Apply All Transforms（Ctrl+A）；原点置于设施旋转/摆动枢轴（如木马转盘中心、海盗船吊轴）。
3. 材质：Principled BSDF → glTF Metallic-Roughness；参数遵循第五部分 PBR 规范（金属 metalness 1.0/rough 0.1~0.4；木 0.0/0.7~0.9；涂料 0.1~0.3/0.4~0.7）。
4. 纹理：≤2048×2048；sRGB 色彩空间；尽量 atlas 合并减少材质数；法线贴图用 OpenGL 约定。
5. 面数预算：High ≤ 50k tris（近景）、Medium ≤ 15k、Low ≤ 3k（供 LOD 三档）；命名 `<key>_high/medium/low`。
6. 压缩：可选 Draco（position 14 bit / normal 10 bit / texcoord 12 bit）；启用后 wasm 放 public/draco/。
7. 节点命名语义化（seat_0…、hull、pivot），便于设施代码按名绑定座位/枢轴。
8. 不含动画剪辑的静态设施导出时关闭 animation；含摆动的由设施代码驱动枢轴节点。

## 7. 真机自检实测（browser-use，内存 GLB 1960 bytes）
| 检查 | 实测 | 判定 |
|---|---|---|
| GLB 生成+解析 | glbBytes=1960, meshCount=1 | ✅ |
| 并发合并 | concurrentSame=true, pendingJoins=1, loads=1 | ✅ |
| 缓存命中 | cacheSame=true, cacheHits=1 | ✅ |
| 未登记回退 | fallback=true, fallbackIsMesh=true, fallbacks=1（无网络请求） | ✅ |
| LOD 三档 | lodLevels=[0,1,2] @ 5/40/100m | ✅ |
| 清理 | cacheAfterClear=0 | ✅ |
| 控制台 | 0 error / 0 warn | ✅ |

## 8. 代码变更清单
| 文件 | 变更 |
|---|---|
| src/utils/ModelLoader.js（新增） | 单例 GLTFLoader+DRACO、cache/pending、load/loadOrFallback、createLOD、clear/dispose、MODEL_PRIORITIES |
| src/utils/modelLoaderSelfTest.js（新增） | 内存 GLB 真机自检（GLTFExporter → blob → 真实 load） |
| src/main.js | import modelLoader；bootstrap() `modelLoader.init()`；`__playground.modelLoader` 暴露 |

## 9. 已知限制 / 未实测
- 无真实美术 .glb 资产（资源约束），故 P0/P1 设施运行时仍为程序化几何；ModelLoader 链路已用内存 GLB 实测验证，资产就位后 `registerAsset` 即生效。
- Draco 解码未实测（无压缩资产、wasm 未 vendored）；标注「集成就绪/未实测」。
- 外部模型 CDN / Cache-Control 头属部署侧，不在本工程范围。