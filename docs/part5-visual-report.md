# 第五部分：视觉优化与去AI感 —— 实施与验收报告

日期：2026-11-10
范围：手册 P5（材质 / 光照阴影 / 环境反射 / 后处理 / 场景细节 / 去AI感清单）
方法：全部数值为浏览器实测（headless Chromium + 本机 GPU 路径），未实测项明确标注。

---

## 1. 材质全面升级（弃用 Basic / Lambert）

改造前残留 6 处 `MeshBasicMaterial` / `MeshLambertMaterial`，全部替换；
改造后 `grep -rn "new THREE.Mesh(Basic|Lambert)Material" src/` = **0 命中**（仅注释提及）。

| 位置 | 原材质 | 新材质 | 等效手段 |
|---|---|---|---|
| JumpJump 天空穹顶 | Basic(map, BackSide) | Standard | color=黑 + emissiveMap，emissiveIntensity 0.38 |
| JumpJump 落地光圈 | Basic(白, transparent) | Standard | emissive 白 ×0.38 |
| Lobby 云带圆柱 | Basic(map, BackSide) | Standard | color=黑 + map(提供 alpha) + emissiveMap |
| Lobby 接触阴影 | Basic(黑, map) | Standard | color=黑 + map（alpha 不变） |
| Lobby 假光柱 | Basic(additive) | Standard | color=黑 + map + emissiveMap，additive 保留 |
| TrainRide 全调色板(17 键) | Lambert+flatShading | Standard+flatShading | 按类别 PBR（见下表） |

**踩坑记录**：Standard 的 alpha 只取自 `map`/`opacity`，`emissiveMap` 不带 alpha。
首版云带/光柱只挂 emissiveMap，丢失羽化边缘露出整块矩形（截图实测可见光柱矩形带）；
补挂同张贴图到 `map` 槽后恢复（part5-01 二版截图确认矩形带消失）。

### PBR 参数规范落实（手册表格）

| 类别 | metalness | roughness | 落实点 |
|---|---|---|---|
| 金属件 | 1.0 | 0.1~0.4 | Lobby matPillar 0.28 / matWheelFrame 0.32 / matCoinGold 0.12；TrainRide rail/pillar/wheel 0.3；Parkour 金币 0.05 |
| 木材 | 0.0 | 0.7~0.9 | TrainRide tie 0.85；Lobby matBark 0.78；PirateShip 木纹甲板 |
| 塑料/涂料 | 0.1~0.3 | 0.4~0.7 | TrainRide 涂料键 0.15/0.55；Lobby 霓虹烤漆 0.05/0.42+clearcoat |
| 玻璃/水 | 0.0 | 0.0~0.1 | 新增喷泉水面 transmission 0.9 / roughness 0.05 |
| 地面 | 0.0 | 0.8~0.95 | JumpJump 地砖 0.9；Lobby 草地 1.0×roughnessMap(0.55~0.95)；Parkour 侧台 0.95 |

TrainRide 分类函数 `pbr(key)`：金属{1.0,0.3} / 木材{0,0.85} / 植被{0,0.9} / 涂料{0.15,0.55}。

### 色彩空间
- 所有 albedo CanvasTexture 均 `colorSpace = SRGBColorSpace`（逐文件 grep 核对：Carousel 3 张、
  PirateShip 4 张、MemoryMatch 7 张、Lobby 草/云/云带、JumpJump、Parkour、PumpkinThrower）。
- 数据纹理（roughnessMap / normalMap / 接触阴影 alpha）**保持线性 NoColorSpace**——
  法线/粗糙度设 sRGB 会被伽马扭曲，这是正确做法而非遗漏。

### 程序化法线贴图（新增 3 张）
- `lb/grass-normal` 512²：低频起伏+草丝颗粒高度场 → 中心差分编码，normalScale 0.5，铺 Lobby 草地。
- `lb/panel-normal` 256²：横向板缝+细噪点，normalScale 0.22，铺门楼横梁/立柱烤漆金属（建筑墙面细节）。
- JumpJump 地砖法线 256²：砖缝凹陷高度场 → 中心差分，normalScale 0.6。
- 通用流程 `heightFieldToNormalCanvas()`：环绕取邻（无缝）→ n=normalize(-dx,-dy,1) → RGB 编码。

---

## 2. 光照与阴影升级

| 手册要求 | 实测值（浏览器读取） | 结论 |
|---|---|---|
| HemisphereLight 0.3~0.5 | 0.3（天空蓝 0xbfe3ff + 地面深绿棕 0x24331c） | ✅ |
| DirectionalLight castShadow | true | ✅ |
| shadow.mapSize 2048 | 2048×2048 | ✅ |
| shadow.camera.near 0.5 | 0.5 | ✅ |
| shadow.camera.far 100 | 100 | ✅ |
| left/right/top/bottom ±30 | -30/30/30/-30 | ✅ |
| shadow.bias -0.001 | -0.001（另保留 normalBias 0.02 防痤疮） | ✅ |
| PCFSoftShadowMap | **PCFShadowMap（type=1）** | ⚠️ 见下 |
| ACESFilmic + exposure 1.0 | toneMapping=ACESFilmic，exposure=1 | ✅ |
| PMREM + RoomEnvironment | 已 baked，scene.environmentIntensity=0.418 | ✅ |
| 禁止无阴影平行光作唯一光源 | 主光投影 + 半球 + 环境 + IBL 四路 | ✅ |

**PCFSoftShadowMap 偏差说明（真实约束）**：three r187 已**移除** PCFSoftShadowMap。
node_modules/three/src/renderers/webgl/WebGLShadowMap.js:99-101 实测：遇到该枚举即
`warn('PCFSoftShadowMap has been removed. Using PCFShadowMap instead.')` 并回退。
强行设置只会每帧刷警告（违反「Console 无材质警告」）。故直接 PCFShadowMap，行为等价、零告警。

**exposure 1.0 的光度等价重标定**：旧方案 exposure=0.38 已调好成像。手册要求 1.0，
故把「光强 / 自发光 / 无lit 颜色 / 背景雾色」统一在线性空间 ×0.38（`EXPOSURE_COMP`），
ACES 输入不变 → 画面等价。涉及：
- SceneManager：dir 1.8→0.58、hemi 0.5→0.3（手册下限；等效 0.19 低于下限故取 0.3 并由 dir 补差）、
  amb 0.18→0.07、environmentIntensity 1.1→0.418、背景/雾 Color.multiplyScalar(0.38)。
- 7 设施共 27 处 emissiveIntensity（含 update 内动态呼吸赋值）×0.38；
  Carousel/PirateShip 4 盏 PointLight ×0.38；JumpJump/Parkour 本地半球/太阳 ×0.38；
  Lobby Sprite/Points 无lit 颜色 ×0.38；3 处背景/雾接管 ×0.38。
- 截图对比（part3-10 优化前 vs part5-01 优化后）：亮度/色调目视等价，无过曝。

---

## 3. 后处理（手册标注「可选但推荐」）

- Bloom：UnrealBloomPass 已在链上（RenderPass→Bloom→OutputPass）。
  **参数偏差**：手册推荐 threshold 0.2 / strength 0.5 / radius 0.5；实测白天天空是大面积
  高亮源，threshold 0.2 会让整屏糊成白雾（前期调参结论）。现值 strength 0.06 / radius 0.35 /
  threshold 1.4，只拾太阳高光/金属反光。手册注意事项 7 明确允许「视觉效果与性能间权衡」。
- 抗锯齿：`antialias: true` ✅；像素比 `Math.min(devicePixelRatio, 2)` ✅（resize 同步）。
- 色调映射在 OutputPass 完成（RenderTarget 内材质强制 NoToneMapping 的 r187 行为已注释说明）。

---

## 4. 场景细节增强

- **地面禁止纯色**：JumpJump 原 400×400 纯色平面 → 程序化地砖（512² 4×4 方格+砖缝+逐块色差+噪点，
  repeat 25）+ 砖缝法线（part5-02 截图：缝线/凹凸/块影清晰）。Lobby 草地 albedo+roughness+normal；
  PirateShip 港湾贴图；PumpkinThrower 棋盘格；Parkour 跑道贴图。
- **建筑**：门楼有立柱/横梁/霓虹滚边/点阵字牌/板缝法线，非纯长方体；TrainRide 方块大厅为
  刻意像素风（保留），材质已 PBR 化（part5-03 截图：钢轨金属反光、枕木哑光）。
- **植被**：树 = Cylinder 干 + Icosahedron 冠（InstancedMesh 45 棵）；冠 roughness 0.92 深绿；
  **新增 400 株小草簇 InstancedMesh（1 draw call，复用 geoCone/matLeaf，零新增几何/材质）**。
- **水体（新增中心喷泉）**：盆环 Torus + 水面 RingGeometry(343 顶点) + 柱/碗/水柱复用共享几何。
  水 = MeshPhysicalMaterial transmission 0.9 / roughness 0.05 / ior 1.33 / thickness 0.4；
  update 内逐顶点径向正弦波纹（边缘衰减）+ computeVertexNormals。
  位置 (0,6)：默认机位视线从大门横梁下方穿过，喷泉落在门洞景框内（part5-04 截图）。
  **性能实测**：transmission 折射 pass 全分辨率会把大厅从 82fps 打到 **21.3fps**；
  r187 `renderer.transmissionResolutionScale = 0.5`（1/4 像素）后回升 **70.2fps**，水面半分辨率肉眼无差。

---

## 5. 去AI感清单核对

| 清单项 | 状态 |
|---|---|
| 合理粗糙度/金属度，非纯平颜色 | ✅ 全 Standard/Physical + 分类 PBR |
| 有阴影且柔和 | ✅ 2048 PCF + normalBias；截图块影/树影柔和 |
| 环境反射非完全哑光 | ✅ PMREM RoomEnvironment IBL |
| 地面有纹理细节 | ✅ 草/地砖/港湾/棋盘 + 法线 |
| 建筑装饰细节 | ✅ 门楼组件+板缝法线 |
| 色调统一无突兀纯色块 | ✅ 截图对比无新增色块 |
| 深度感（雾/距离 fade） | ✅ 线性雾 45→130（各设施自接管） |

---

## 6. 验收实测

| 指标 | 实测 | 标准 | 结论 |
|---|---|---|---|
| 大厅单帧耗时（update+composer，60 帧均值） | 14.24ms ≈ **70.2fps** | ≥50fps | ✅（本机 headless；中端手机未实测） |
| transmission 全分辨率对照 | 47.02ms ≈ 21.3fps | — | 已用 resolutionScale 0.5 修复 |
| Console error/warn | **0** | 无材质警告 | ✅ |
| 热基线 geometries/textures | 19 / 27（旧 17/24；+2 几何=喷泉盆/水，+2 纹理=法线×2，+1=折射 RT） | 记录 | ✅ |
| 空基线 | 2 / 18 | 记录 | ✅ |
| 7 设施 enter→exit 资源 Δ | 全部 **Δ0/0**，均回 lobby | Δ0/0 | ✅ |
| 截图对比 | part3-10(前) vs part5-01/02/03/04(后) | 玩具感→真实感 | ✅ 亮度等价、细节增量可见 |

截图索引：
- docs/screenshots/part5-01-lobby-after.jpg（大厅，曝光重标定后与优化前等价）
- docs/screenshots/part5-02-jumpjump-tiles.jpg（地砖+缝+法线+块影）
- docs/screenshots/part5-03-train-pbr.jpg（方块世界 PBR：金属轨/木枕木）
- docs/screenshots/part5-04-lobby-fountain.jpg（门洞景框内喷泉，transmission 水面）

## 7. 已知限制 / 偏差（真实声明）

1. PCFSoftShadowMap 在 r187 不存在，用 PCFShadowMap 等价替代（源码实证）。
2. Bloom 参数偏离手册推荐值（白天场景权衡，手册允许）。
3. 帧率为本机 headless 实测；「中端设备 50fps」属 P6 移动端降级范畴，未在手机实测。
4. 喷泉折射半分辨率（transmissionResolutionScale 0.5）为性能权衡。