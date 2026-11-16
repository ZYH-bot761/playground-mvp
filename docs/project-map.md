# 项目现状地图（只读盘点 · 2026-11-15）

> 基准：HEAD = 628238b（工程化目录整理），main 分支。本报告全部结论来自**静态通读代码 + 交叉 grep**，未运行页面；凡估算均已注明。行号为当日工作区实测。
> 配套文档：docs/requirements-active.md（需求约定有效性判定）。
> 委托说明：scenes 大文件由两个并行审计代理全文通读（attractions 11 文件 / lobby+zoo+castle+districts+farm 5 文件），行号均经 read 实测。

> **阶段五最终状态（2026-11-16 · 3D 微缩大都会）**
> - **验收 12/12 PASS，0 pageerror / 0 console.error**：18 座塔楼三级 LOD、医院/学校、四车道、道路零侵入、全量 InstancedMesh、公交下客、夜景暖光、7 机位预算、5 轮热路径全部通过。
> - **城市预算**：近景 LOD `1,474 tris`，中/远各 `252 tris`；7 机位峰值仍是入园 `1,170 calls / 239,204 tris`，低于 300k 硬红线。
> - **交通/人群**：28 辆行驶车 + 4 辆停放车、1 辆公交、24 个低模行人、50 盏路灯、4 组信号灯，全部 InstancedMesh；路线 256 点预采样，运行时只推进标量 `t`。
> - **公园改造**：四车道走廊中心 `(24,27)`、16m 净宽；跳舞厅移至 `(-23, 8.5)`、烟花台移至 `(13.8, 15.5)`，均退出道路走廊；城堡台地中心西移 `cx=-7`。
> - **热路径**：城市近景稳态 `82 geometries / 46 textures`；城市⇄大门 5 轮全部 `Δgeo=0 / Δtex=0`。
> - **构建**：`index-FwvaSwT3.js` 546.99kB / gzip 170.09kB，CSS 5.50kB / gzip 1.62kB；仅保留懒加载 vendor 分块体积提示。
>
> **阶段四历史状态（2026-11-16）**
> - **验收 15/15 PASS，0 pageerror / 0 console.error**：皇堡南门、UI 毛玻璃、WASD、手机摇杆、触屏防误触、五区巡游、5 轮热路径、首包体积全部通过。
> - **南门**：`Lobby/gate` 17 个子对象，四塔 / 三尖顶 / 纹章 / 垛口 / 金拱齐全；“游乐场”招牌 world `(0, 14.05, 16.8)`，正面遮挡检测 0。
> - **预算**：入园 `1,182 calls / 281,346 tris`；五区巡游峰值 `1,209 / 288,436`，低于 300k 硬红线。
> - **热路径**：稳态 `56 geometries / 41 textures`，5 轮大厅↔跳舞厅全部 `Δgeo=0 / Δtex=0`。
> - **双端**：大厅 WASD 位移 1.5m、跳舞厅 1.25m；摇杆在大厅 / 跳舞厅 / 玉米地分别驱动 1.565 / 1.25 / 1.043m；触屏拖拽进入设施 0 次、轻点 1 次。
> - **构建**：`npm run build` ✓，入口 `index-Dlm7yVR0.js` 521.27kB / gzip 161.56kB，CSS 5.50kB / gzip 1.62kB；首屏 JS+CSS 约 1.34MB / gzip 374kB，`vendor-physics` 4.34MB 仍为懒加载分块。
> - **无阻断项**。构建器仅提示懒加载 vendor 分块 >500kB，不影响首屏；M5 皇堡专项同步 8/8。

---

## 0. 目录总览

```
D:\playground-mvp
├─ index.html                  入口（唯一 module script → /src/main.js）
├─ vite.config.js              缓存头插件 + dev server 配置（无 manualChunks / 无动态 import）
├─ package.json                three 0.187 / rapier3d-compat 0.21 / mediapipe tasks-vision 0.10.3
│                              lil-gui / three-mesh-bvh 0.9.9 / three-player-controller 0.6.3 / vite 8
├─ config/default.json         dev 端口、缓存策略、render 预算（triangle 300k / drawCall 900）
├─ src/
│  ├─ main.js                  唯一入口（965 行）：bootstrap / frameDriver / 注册表 / 基线口径
│  ├─ style.css
│  ├─ core/            11 文件（场景/物理/相机/调度/清理/渲染优化单例）
│  ├─ scenes/          lobby-scene(4709行) + zoo/castle/districts/farm + attractions/ 11 设施
│  ├─ components/      controllers / embedded-views / labels / start / pause / debug / hand-tracker
│  ├─ objects/  shaders/       仅 readme.md（规划中的空目录）
│  └─ utils/           loaders / controls / helpers（9 个全局单例与工厂）
├─ assets/
│  ├─ models/          visitor-ai.glb 32.07MB（AI 参考样本，未被运行时引用）+ readme + 预览页
│  ├─ textures/        visitor-ai-preview.png
│  └─ sounds/          空（音效全部 Web Audio 合成）
├─ public/             favicon.svg + models/hand-landmarker.task（7.8MB，消费方 hand-tracker 未接线）
├─ docs/               PRD/设计/部署 docx + v3/v4 规格·交接 + part1~5 审计 + 本报告
├─ tests/              verify-m1~m9 / verify-v4 / verify-redline / verify-six-upgrades / diag-*
├─ dist/               index-*.js 5,636,688B 单包 + draco 解码器×5（~1.31MB）+ hand-landmarker.task
└─ _archive/           旧资产（工作区已删、未提交）
```

---

## ① 模块清单（职责一句话 + 对外导出 API）

### src/core（11 个单例/契约）

| 文件（行数） | 职责（一句话） | 对外导出 API |
|---|---|---|
| scene-manager.js (329) | 唯一 Scene/相机/渲染器/后处理链/渲染循环的单例，夜转昼基调 + 画质三档落地 | `class SceneManager`；configure/setPaused/renderOnce/start/stop/resize/dispose；常驻灯 ambient/hemisphere/directional；composer/renderPass/bloomPass/fxaaPass/outputPass；单例 `sceneManager` |
| attraction-manager.js (175) | 项目注册/激活/卸载调度（activate=新登记器+duck-check；卸载恒为 dispose→disposeAll→scene.remove） | `register/unregister/activate/deactivate/update/onInteract/dispose/configure`；`active/activeKey/registry/keys`；单例 `attractionManager` |
| physics-manager.js (136) | Rapier WASM 唯一初始化点 + 全工程唯一 world.step（固定步长累加器、空场跳过、切后台防补帧爆炸） | `init/step/dispose`；`isReady/RAPIER/world`；单例 `physicsManager` |
| disposable-registry.js (81) | 每设施实例一份资源清理台账（函数或带 dispose 对象，逆序释放、单项容错） | `DisposableRegistry.register/disposeAll/clear/size` |
| facility-runtime.js (306) | 嵌入视图协调器：懒创建 IEmbeddedView、CameraRig blend 到锚点、挂起 Lobby OrbitControls.update | `configure/register/activate/deactivate/update/dispose`；`activeView/activeKey/isEmbeddedActive/isTransitioning/isConfigured` |
| camera-rig.js (356) | 全局相机唯一写者仲裁（owner 制 + save/restore 槽位 + 0.8s smoothstep 姿态过渡） | `configure/save/restore/blendTo/setOwner/releaseOwner/update/dispose`；`owner/isTransitioning/isConfigured` |
| scene-context.js (170) | 唯一世界共享上下文：worldRoot（大厅常驻）/ propsRoot（玩法件）/ facilityAnchors | `configure/setAnchor/getAnchor/dispose`；`worldRoot/propsRoot/facilityAnchors` |
| interaction-manager.js (128) | canvas click 射线拾取，白名单优先、否则只射 active.root，结果分发给当前激活项目 | `init/setPickables/clearPickables/dispose` |
| ui-manager.js (94) | 左上角基座调试 DOM（卸载测试/重新激活），事件委托 | `init/setStatus/dispose` |
| audio-manager.js (522) | Web Audio 实时合成四类音效（振荡器+噪声+包络），自动播放策略解锁 | `init/play/playClick/setVolume/setMuted/unlock/dispose`；`SOUND_NAMES` |
| render-optimizer.js (195) | LOD 钉死高模 + 精确包围体重算 + 全场景 mipmap/各向异性 + setForceNoCull（默认关） | `configure/pinHighDetail/fixBounds/applyMipmaps/setForceNoCull/update/applyNow`；`stats` |

### src/scenes

| 文件（行数） | 职责 | 对外导出 |
|---|---|---|
| lobby-scene.js (4709) | 大厅本体 IAttraction：广场/大门门楼/南瓜摩天轮(10 真座舱)/金币长廊(跑酷跑道)/魔法牌屋/弹跳竞技场/小火车站/40m 过山车(挂轨小车)/世纪钟地标/烟花台/9 触发环/植被长椅；Orbit→WASD→MovementMode→坐姿→动物园飞行五态相机互斥 | `class Lobby extends IAttraction`（init/update/onInteract/dispose）；`FACILITIES`/`DISTRICT_GRID` 引用；`buildClockTower` 来自 century-clock |
| zoo-scene.js (744) | 动物园区工厂：4 区 32 只动物 = 每类 3+1 个 InstancedMesh（16 draw call），轨迹 240 帧烘焙闭环 | `buildZoo(opts) → { update(t), dispose }` |
| districts.js (318) | 四宫格骨架：44 实例单 InstancedMesh + 北侧两区各一层区域级 THREE.LOD | `buildDistricts({root,shared}) → { build,getDetailAnchor,getActiveQuadrant,update,dispose }`；`DISTRICT_GRID` |
| castle.js (243) | 城堡（合并几何×3 + InstancedMesh×2，零灯零碰撞） | `buildCastle(detail,S,center) → { dispose }` |
| farm.js (203) | 农家乐：14 种作物 504 株 InstancedMesh | `buildFarm(detail,S,center) → { dispose, instCount }` |
| attractions/i-attraction.js (85) | 设施契约注释文档 + 抽象基类 | `class IAttraction`（init/update/onInteract/dispose） |
| attractions/dummy-attraction.js (489) | M2 资源清理验证桩（球+面+DataTexture+1 刚体，契约参考实现） | `class DummyAttraction` |
| attractions/pumpkin-thrower.js (1325) | 南瓜投手：Rapier 全套（南瓜 Dynamic+CCD、靶 sensor、命中扫掠）；入口被 EMBEDDED_KEYS 占用后仅手动可达 | `class PumpkinThrower` |
| attractions/parkour-run.js (1113) | 三轨跑酷：纯逻辑 AABB 碰撞 + 对象池 + 速度曲线；未继承 IAttraction | `class ParkourRun` |
| attractions/memory-match.js (1378) | 记忆翻牌：12 卡 3 材质组、翻牌补间、mismatch 用 dt 计时 | `class MemoryMatch` |
| attractions/jump-jump.js (872) | 独立跳一跳：预计算抛物线插值 + 方块对象池；未继承契约；被嵌入视图取代后半死代码 | `class JumpJump` |
| attractions/train-ride.js (1219) | 高空环游：能量模型轨道骑乘（双轨/枕木/桥墩 3 个 IM），单共享 BoxGeometry | `class TrainRide` |
| attractions/carousel.js (1111) | 旋转木马：4 马 IM + 48 灯泡 IM + 骑乘第一人称三态相机 | `class Carousel`；`warmUp()`（死代码） |
| attractions/pirate-ship.js (1289) | 海盗船：解析式单摆 + 船体系四元数相机合成 | `class PirateShip` |
| attractions/fireworks-deck.js (547) | 烟花观礼台：fireworkSystem 发射控制台（4 形状/4 品类/8 色/文字烟花） | `class FireworksDeck` |
| attractions/century-clock.js (642) | 世纪钟设施；`buildClockTower` 供大厅地标共用 | `class CenturyClock`；模块级 `createClockFaceTexture/createClockGlowMaskTexture/buildClockTower` |

### src/components

| 文件（行数） | 职责 | 对外导出 |
|---|---|---|
| controllers/movement-mode-manager.js (528) | ground/flight 双模式互斥状态机：CollisionWorld 粗筛 + MeshBVH 三角形级胶囊推出；engaged 默认 false 懒接管 | `movementMode`：configure/attach/buildHUD/engage/disengage/setMode/toggle/update/consumeRelease/isEngaged/dispose；`stats`；`GROUND_EYE_HEIGHT/PLAYER_RADIUS` |
| embedded-views/i-embedded-view.js (148) | 嵌入视图契约基类（六条硬禁令 + track() 台账） | `class IEmbeddedView`（init/getCameraAnchor/update/activate/deactivate/dispose） |
| embedded-views/demo-embed-view.js (87) | 最小闭环验证锚点（零 GPU 资源） | `DemoEmbedView`；`DEMO_EMBED_KEY` |
| embedded-views/ferris-wheel-embed-view.js (290) | 摩天轮座舱视图：复用 `Lobby/wheel-spin`、恒水平无 roll、座舱内 360° 环顾 | `FerrisWheelEmbedView`；`FERRIS_WHEEL_KEY` |
| embedded-views/jump-jump-embed-view.js (613) | 跳一跳嵌入视图：第一人称主路跑酷（10 固定落脚台闭环、自动续跳） | `JumpJumpEmbedView`；`JUMP_JUMP_KEY` |
| labels/district-labels.js (126) | 三区中文 Sprite 标签（initTexture 主动上传防 Δtex 假阳性） | `districtLabels`：build/setVisible/visible/dispose |
| start-screen.js (527) | 全屏 DOM 开始页（纯 CSS 渐变霓虹，渲染循环外） | `StartScreen`：init/show/hide/dispose |
| pause-menu.js (234) | 小游戏暂停菜单（ESC/触屏、capture 按键隔离、联动 sceneManager.setPaused） | `PauseMenu`：attach/open/close/toggle/dispose |
| debug-panel.js (111) | lil-gui 控制台（移动模式/Bloom/FXAA/剔除/标签/实时统计） | `debugPanel`：build/dispose |
| hand-tracker.js (721) | MediaPipe 手势识别纯逻辑模块（阶段 1）——**当前无任何模块引用（未接线）** | `handTracker`：start/stop/getLandmarks/getPinchPoint/onGestureChange；`GESTURES/MEDIAPIPE_VERSION/assertMediapipeVersion` |

### src/utils

| 文件（行数） | 职责 | 对外导出 |
|---|---|---|
| loaders/model-loader.js (155) | GLTF+DRACO 单例：缓存/并发合并/loadOrFallback 程序化兜底/createLOD；available 默认空 → 运行时零 glb 请求 | `modelLoader`：init/load/loadOrFallback/createLOD/registerAsset/hasAsset/clear/dispose；`MODEL_PRIORITIES` |
| loaders/model-loader-self-test.js (59) | 内存生成 GLB 走真实加载链路的自检脚本——**无引用（死代码）** | `runModelLoaderSelfTest` |
| controls/wasd-controller.js (344) | 第一人称 WASD（YXZ 无 roll、AABB 圆-矩形推出、±30 钳制）+ orbit 模式 panOrbit 平移 | `WASDController`：attach/update/panOrbit/resolveCollision/resetFromCamera/clearInput/dispose；`WASD_EYE_HEIGHT/WASD_WALK_SPEED/WASD_PLAYER_RADIUS/WASD_WORLD_BOUND/ORBIT_PAN_BOUND/MOVE_CODES/horizontalForward` |
| helpers/npc-manager.js (561) | 10 NPC 单 InstancedMesh（1 draw call）+ 顶点着色器动画 + BFS 导航图 + AABB 避障 | `npcManager`：init/setObstacles/setBounds/setContext/update/dispose；`NPC_COUNT` |
| helpers/procedural-character.js (812) | 程序化人物工厂：buildCharacter（关节 pivot 玩家）+ buildNPCCharacter（合并几何+实例调色板） | `buildCharacter/buildNPCCharacter/createNPCMaterial/disposeCharacter/registerGeneratedVisitorAsset`；`STYLE_PRESETS/JOINTS/NPC_SCALE` |
| helpers/day-night-cycle.js (716) | 昼夜循环单例：day/sunset/night 插值 + 太阳/月亮/星空 + 霓虹 emissive + Lobby 天空球 uniform 接管 + 基座灯完整快照还原 | `dayNightCycle`：init/setMode/setAuto/toggleAuto/setContext/registerEmbeddedContext/registerSky/registerLobbyMaterials/update/applyImmediate/onChange/dispose；`DAY_NIGHT_MODES/DAY_NIGHT_SPEC` |
| helpers/particle-system.js (599) | GPU 烟花单例：1 Points×3000 粒子（物理在顶点着色器）、对象池、文字烟花 canvas 栅格化 | `fireworkSystem`：init/launch/launchText/setContext/resize/update/clear/dispose；`FIREWORK_COLORS/FIREWORK_TYPES` |
| helpers/facility-textures.js (242) | 设施名牌 2048² 单图集 + UV 子矩形（WeakSet 幂等防 BufferGeometry.copy 浅引用坑） | `createFacilityLabelAtlas/applyAtlasUV/disposeFacilityLabelAtlas`；`LABEL_ATLAS_*` |
| helpers/coaster-car-runtime.js (493) | 过山车挂轨运行时：弧长参数取点 + 曲率压弯限速，与 Lobby 共享同一 curve 引用 | `CoasterCarRuntime`：init/update/getCarT/dispose |
| helpers/detail-lod.js (55) | THREE.LOD 三级包装（wrap 按包围盒生成中/远景体） | `DetailLOD`（extends THREE.LOD）+ `.wrap()` |
| helpers/quality-tier.js (27) | 三档画质预设 + 硬件探测（cores≤4→low，触屏→medium，URL 可强制） | `QUALITY_PRESETS/detectQualityTier` |
| helpers/perf-monitor.js (50) | `?perf=1` 开发环境 FPS/geo/tex 面板（生产零开销） | `PerfMonitor.maybeCreate/sample/dispose` |

> src/objects/、src/shaders/ 仅含 readme.md 占位（104B），当前无代码。

---

## ② 场景资产盘点（assets/models）

| 文件 | 体积 | 被谁加载 | LOD / 压缩 |
|---|---|---|---|
| assets/models/visitor-ai.glb | 33,629,756 B（32.07 MiB） | **无任何模块加载**（全 src grep `\.glb` 仅命中注释与自检脚本；`registerGeneratedVisitorAsset()` 只登记不加载、且无人调用） | 无 LOD；**无 Draco/KTX2 压缩**；内嵌 3 张贴图（32MB 主因）；18,305 三角面 / 15,268 顶点 / **0 骨骼 0 动画**（readme.md 实测记录：Q 版群像，判定不接入运行时） |
| assets/models/model-viewer.html | 4,389 B | 浏览器本地预览页（非运行时） | — |
| assets/models/readme.md | 3,570 B | 资产约定文档 | — |
| assets/textures/visitor-ai-preview.png | 164,820 B | 预览图（非运行时） | — |
| assets/sounds/ | 空 | 音效全部由 audio-manager.js 实时合成，零音频文件 | — |

**结论**：本项目运行时是「零外部资产」架构——全部外观为程序化几何 + ~25 张 Canvas/DataTexture（lobby 13 张 + 各设施若干，全部 SRGBColorSpace 且进台账）。仓库内唯一大文件 visitor-ai.glb 是 AI 生成对照样本，不进 dist、不进运行时内存。真正进 dist 的静态资产只有 public/favicon.svg 与 public/models/hand-landmarker.task（7.8MB，消费方 hand-tracker 未接线，见 §⑤）。

---

## ③ 渲染管线现状

**渲染器**（scene-manager.js:77-98）
- antialias: true（MSAA）+ 后处理 FXAA 双保险；pixelRatio = min(devicePixelRatio, cap)，cap 按画质档 2 / 2 / 1.25（:174、:224；quality-tier.js:15-17）
- shadowMap.enabled = true，类型 **PCFShadowMap**（:95；注释说明 three r187 已移除 PCFSoft，写了也回退）
- toneMapping ACESFilmic + exposure 1.0（:81-84），线性空间预乘 0.38 的成像口径；outputColorSpace sRGB
- autoClear = false（后期链各 pass 自清屏）；transmissionResolutionScale 按档 0.5/0.35/0.25（:91）

**后处理链**（唯一一条，scene-manager.js:151-171）
```
RenderPass → UnrealBloomPass(strength 0.06 / radius 0.35 / threshold 1.4; medium|low 档禁用)
           → ShaderPass(FXAAShader, 分辨率随 pixelRatio/resize 更新) → OutputPass(ACES+sRGB)
```
⚠ scene-manager.js:144-149 注释声称还有 ColorGradePass，**实际链路没有该 Pass**（注释失真）。

**灯光**（常驻基座 3 盏，scene-manager.js:119-142）
- AmbientLight 0.07 + HemisphereLight 0.3 + DirectionalLight 0.58（castShadow，mapSize 2048/1024/512 按档，shadow camera ±30 / near 0.5 / far 100 / bias -0.001 / normalBias 0.02）
- Lobby、四区（zoo/castle/farm/districts）自建 **0 盏**（lobby 的 `_buildLights` :3412 是从未被 init 调用的死代码）；设施自建灯同时最多 1 个设施在场：carousel 2 Point、pirate 2 Point、century-clock 1 Point+1 Spot（不投影）、fireworks 1 Hemi+1 Point、jump-jump 1 Hemi+1 Dir（**1024² castShadow，全项目唯一设施级阴影贴图**）、parkour 1 Hemi+1 Dir（不投影）→ **同屏峰值 ≈ 基座 3 + 设施 4~7 盏**
- **阴影投射者**：基座方向光投影 Lobby 数十个 Mesh/InstancedMesh；NPC castShadow=false（不进 shadow pass）；Zoo/Castle/Farm/Districts 网格默认不投影

**draw call 与三角面（估算 + 历史实测，本阶段未复测）**
- 静态估算（按几何分段逐文件推算）：lobby ≈7-9 万面；zoo ≈6-7 千；castle ≈4 千；farm ≈6 千；districts 骨架 ≈0.1 千；单个设施 ≈3 千（clock/fireworks/jump）~4 万（carousel，灯泡 1.15 万 + 裙边 5 千 + 马 IM）
- 历史实测（tests/diag-m7-budget.json，结构盘点口径；handover 自述 296,502/300,000）：四宫格俯瞰 full = **1,195 calls / 298,382 tri**，standard 机位 = 1,057 calls / 284,922 tri
- **预算对照**：config/default.json `triangleBudget: 300000`（实测贴线，余量 <1.2%）、`drawCallBudget: 900`（实测 1057~1195，**超 ~18-33%**；且 grep 确认 src 无任何代码消费这两个预算值——纯声明）。v3-spec 的「大厅 ≤120 calls / 设施 ≤200」是老口径：composer 下 `renderer.info.render.calls` 恒为 1，须按 v4-status 坑 6 的结构盘点口径评估。

---

## ④ 角色与 NPC 系统

**玩家移动（三层并存，Lobby.update 互斥仲裁，lobby-scene.js:4332-4366）**
1. **orbit 观察态**：OrbitControls + `panOrbit`（WASD/方向键直接平移 camera+target，边界 ±120m，wasd-controller.js:331-332）
2. **WASD 第一人称**：WASDController——眼高 1.6m、6m/s、Shift×1.8、YXZ 无 roll；碰撞 = **Lobby._buildingBoxes 的 2D AABB 圆-矩形推出**（两遍，wasd-controller.js:206-238）+ ±30m 世界钳制；**无物理引擎**
3. **MovementMode ground/flight（六项升级主控层，默认不接管）**：three-player-controller `CollisionWorld` 候选粗筛 + three-mesh-bvh `shapecast + closestPointToSegment` 三角形级胶囊推出（movement-mode-manager.js:12-15）；碰撞体是把 `_buildingBoxes` 烘焙成每盒 12 三角、y∈[0,30] 的**纯 CPU BufferGeometry**（:73-92，不进 scene）；ground 锁 1.7m 眼高禁垂直位移，flight 自由飞关碰撞约束；水平边界 ±118（:49）
- **结论**：玩家移动全程不用 Rapier（Rapier 仅 pumpkin-thrower 与 dummy 设施内部使用）；无 Capsule 物理刚体——「胶囊」只是 BVH 推出的几何概念；碰撞检测主形态是 **AABB（粗）+ BVH 三角形精筛**，Raycaster 仅用于拾取（点击/悬停），不用于移动碰撞

**NPC（10 只，npc-manager.js）**
- 模型：procedural-character.js `buildNPCCharacter` 合并几何 + 4 组实例调色板（aCoat/aPants/aSkin/aHair）→ **1 个 InstancedMesh = 1 draw call**；走路/摆臂/挥手/张望全在顶点着色器（aMeta 关节编号 + aPivot 旋转中心），CPU 每帧只写 10×4 个 aAnim 浮点 + 10 个 instanceMatrix
- 状态机：4 态 `WALK/IDLE/LOOK/WAVE`（:46），确定性伪随机布局
- 移动：**BFS 导航图**（2.4m 网格八邻域、候选边 5 点采样防斜穿墙）+ 建筑 AABB 避障（PAD 0.7，过滤 noBlock）+ 半径 31 圆形边界 + 轴滑动脱困 + 卡死 relocate（:232-238/:364/:446-457）；>45m 暂停更新（:36）。**不用物理引擎**
- 边界注入：Lobby.init:1053-1054 注入 obstacles，M7 后 `setBounds` 可扩展

**动画状态机结构**：无通用 FSM 框架，全部是手写状态字段 + dt 累计——NPC 4 态（npc-manager.js:46）；Lobby 坐姿 `none/entering/seated/leaving`（:820）；carousel/pirate/train 相机三态机；jump-jump `ready/charging/air`；跳跳嵌入视图 `ready/…`。状态切换均为 if/else 显式迁移。

---

## ⑤ BUG 清单（代码层面可确证项，均带文件:行号与依据）

> 分级：🔴 必修（资源泄漏/违契约）· 🟡 应修（热点/逻辑）· 🟢 记录（轻微/潜伏）。「静态推断」= 未运行验证，但代码路径明确。

### A. 资源泄漏与生命周期
1. 🔴 **fireworks-deck.js:538-541**（对照 :194/:219/:234）——dispose 只遍历 geometry/material 数组，**3 个 InstancedMesh 从未调用 `.dispose()`**：instanceMatrix/instanceColor 的 GL 缓冲随每次进出设施累积泄漏；three 需 IM.dispose 才触发 onInstancedMeshDispose，`renderer.info.memory.geometries` 计数不出 → 隐形漂移源。对照组：carousel:1057-1060、pirate-ship:1234-1238、train-ride:1173-1177 均正确。
2. 🔴 **jump-jump.js:680-704**——每次完美落地 `new RingGeometry`+`new MeshStandardMaterial` 并 root.add（:682-693），自建 rAF 动画（:694-703）只查 `_disposed`：运行期新建 GPU 资源（违反「init 一次建完」纪律），且**不受 isPaused 暂停闸门约束**（暂停时环仍持续放大）。
3. 🟡 **model-loader.js:45**——`draco.setDecoderPath('draco/')` 指向**不存在的 public/draco/**；且 three r187 DRACOLoader 以 `new URL('../libs/draco/…', import.meta.url)` 静态引用解码器（node_modules DRACOLoader.js:17-23）→ 5 个解码文件（~1.31MB）无条件进 dist/assets。现状无 glb 加载故休眠，一旦接入 Draco 压缩模型必然 404。
4. 🟡 **public/models/hand-landmarker.task（7.8MB）**——随 dist 发布，但其唯一消费方 src/components/hand-tracker.js **无任何模块 import（死代码）**，模型文件当前零消费者。
5. 🟢 jump-jump.js:678——`_popText` 每次落点 `setTimeout(950ms)` 未登记未清理（回调有 parentNode 守卫，低危；与 memory-match:772-779 / pumpkin-thrower:862-865 的登记纪律不一致）。
6. 🟢 main.js:712——`window.addEventListener('resize', () => fireworkSystem.resize())` 匿名监听无法解绑（页面级，轻微）。

### B. 每帧分配 / CPU 热点（动画循环内）
7. 🟡 **parkour-run.js:629 + :963-974**——running 态每帧调 `_setHUD()`，score/power 两处 `innerHTML` 每帧重拼+重解析（60 次/秒 DOM 解析），长时间游玩的最大主线程/GC 单点。
8. 🟡 **lobby-scene.js:4381**——update 每帧 `this._clockTower.tick(new Date())`；同款 century-clock.js:580 设施内每帧 `new Date()`（各 60 次/秒分配）。
9. 🟡 **pumpkin-thrower.js:929/:946/:1043**——update 每帧 `[...this._pumpkins]`/`[...this._particles]` 三处数组展开（空场也分配）；**:1067** `_animateTargets` 每帧给 5 靶各 `setTranslation({新对象字面量})` → 稳定 GC 压力。
10. 🟢 parkour-run.js:819-848——160 个金币实例每帧全量 setMatrixAt（含未激活也写零缩放矩阵），可优化浪费。
11. 🟡 **lobby-scene.js:4262-4269**——喷泉水面 343 顶点每帧位移 + `computeVertexNormals`（全大厅唯一无 `lodOn` 门控的常驻动效），CPU 热点。
12. 🟢 zoo-scene.js:679——zoo update 每帧分配 ~128 个小数组（rotZ 等）， GC churn。
13. 🟢 lobby-scene.js:4048-4067——pointermove 高频触发全量 raycast（悬停判定，含 7 个 InstancedMesh×实例），鼠标移动时 CPU 尖峰（对照 InteractionManager 已收窄白名单的设计意图）。
14. 🟢 pirate-ship.js:1031/:1057——READY/RIDING 每帧 textContent 拼串写 HUD（字符串分配/帧）。
15. 🟢 century-clock.js:432——`setNight` 每帧执行，昼夜阈值附近反复更换 finial.material → shader 编译/切换抖动。

### C. 逻辑 / 一致性 / 结构
16. 🟡 **lobby-scene.js:4368 vs :4377 + :4119-4152 + :3553**——相机仲裁互斥缺口：`_updateZooFly` 在 update() 无条件调用、`_visitZoo` 不检查 `_sitState`、`_toggleInputMode` 不检查 `_zooFly` → **坐下时点「去动物园」或动物园飞行中按 M 会双写相机/controls.target**（与 v4 已修复的「双主控 dances」同族问题复发点）。静态推断：需组合操作触发。
17. 🟡 **lobby-scene.js:1756 + :1845-1862**——路灯 InstancedMesh 的 `addIM` 未像 `_instanced`(:2746) 预置零缩放矩阵：3 盏灯位（角度 0.9/1.95/2.99 rad）与 carousel/gate/pirate 禁区相交被 `continue` 剔除后，**3 组 1×1×1 杆+发光球残留在广场原点 (0,0,0)**。
18. 🟡 **zoo-scene.js:337 vs districts.js:44/:132**——动物园入口拱门两立柱 (x=30, z=8±4.2) 插在四宫格南北沥青路（axisX=30、宽 4m）正中，**跨文件坐标冲突穿模**。
19. 🟡 **边界三套不一致**——movement-mode-manager.js:49 `WORLD_BOUND=118` vs wasd-controller.js:31 `±30` vs npc-manager.js:40 `NAV_RADIUS=31`；且 118 > 草坪半径 110（scene-manager.js:47 注释口径）→ 静态推断：BVH 地面模式可走出草坪可视边缘，且与 WASD/NPC 活动域不一致。
20. 🟢 **century-clock.js:229-231**——`cylAt` 首行 `scale.set(1,h,1)` 死代码，且锥柱半径取 `max(rTop,rBot)` → :381 的 0.55/0.8 收分柱被画成直柱（视觉/逻辑错误）。
21. 🟢 **jump-jump.js:36 / parkour-run.js:70**——`export class JumpJump {` / `export class ParkourRun {` **未 extends IAttraction**（AttractionManager 仅四方法 duck-check，attraction-manager.js:80-84）；且 `'jump-jump'`/`'pumpkin-thrower'` key 被 EMBEDDED_KEYS 占用（main.js:131-141/:152）→ 两个完整独立实现在正常流程不可达、后台预热跳过（main.js:298），沦为半死代码（用户曾明确「不要删除不该删的」，属已知取舍，但契约保障缺失）。
22. 🟢 **scene-manager.js:144-149**——注释声称链尾有 ColorGradePass，实际未实例化（注释与代码失真，误导后人）。
23. 🟢 **fireworks-deck.js:476**——`FIREWORK_TYPES[(Math.random()*3)|0]` 硬编码 3 而非 `.length`，花型配置缩到 <3 时 `undefined.key` 崩溃（当前 4 项，潜伏）。
24. 🟢 **jump-jump.js:566/:625**——`Math.max(h,0)` 削平抛物线下落段 + 落空时直接把玩家摆到下一块顶面（表现层突兀）。
25. 🟢 注释漂移群：lobby-scene.js:2400（注释 FogExp2 实为 Fog）、:2534/:3207（触发环 z 坐标注释 vs 代码）、:3412（死代码 `_buildLights` 仍在）、castle.js:19（"2 个几何" vs 实际 3 个）；zoo-scene.js:676 `(isFish ? ly : ly)` 复制粘贴残渣（行为正确但属坏味道）。
26. 🟢 **结构脆弱性群**：lobby-scene.js:1391-1396——Sky fragmentShader 用字符串精确匹配做增益替换，**three 升级即静默失效**（uniform 照加、效果消失、无失败分支）；districts.js:267-272——`_rebase` 只减直接子对象坐标，正确性依赖"castle/farm 世界坐标烘焙进顶点"的隐式契约；zoo-scene.js:159——四区全部 `frustumCulled=false` 常驻提交（相机在大厅另一侧时 60+ 网格照绘）；districts.js:216-217 / farm.js:202——`instCount` 返回值无消费者；wasd-controller.js:237-238——±30 钳制使 WASD 步行永远到不了 z≥31 的城堡/农场区（四区只能俯瞰，属现状事实）。

### D. 预算与构建（详见 §⑥）
28. 🟡 **config/default.json:16-17**——`drawCallBudget: 900` / `triangleBudget: 300000` 无任何代码消费（src grep 零命中），纯声明性配置；且实测 draw call 1057~1195 已超 900 预算 18-33%，triangle 296,502~298,382 距 30 万上限余量 <1.2%。
29. 🟡 **dist/assets/index-*.js = 5,636,688B 单包**——vite.config.js 无 manualChunks、全部静态 import；@dimforge/rapier3d-compat 将 wasm 以 base64 内联进 JS，而 main.js:598 无条件 `await physicsManager.init()`（Lobby 禁物理仍启动即加载），首屏代价详见 §⑥。

**总体卫生面（对照项，非 bug）**：11 个 attraction 的 addEventListener 全部成对解绑；setInterval 2 处均登记+清理；物理刚体移除顺序严格（先 removeCollider/removeRigidBody）；carousel/pirate/memory/pumpkin/train 五文件含 traverse 兜底 + uniforms 深度纹理扫描；Lobby dispose 七步法（4397-4639）含 `_lobbyMemory` 机位存档。dispose 纪律整体是本项目质量最高的部分，唯一漏网是 §A-1。

---

## ⑥ 构建产物问题与拆分方案（仅建议，本阶段不执行）

**现状**（dist 静态盘点）
- `dist/assets/index-C0x8AONA.js` = **5,636,688B（≈5.37MiB / 5.6MB）单 chunk**；CSS 仅 5.5KB；dist/index.html 只引用这一对产物（无任何动态 chunk）。
- 伴随产物：draco 解码器 5 文件 ≈1.31MB（DRACOLoader 静态 URL 连带，运行时不用）+ public/models/hand-landmarker.task 7.8MB（死资产）。
- 构成静态推断：three r187 core+examples addons（Sky/OrbitControls/GLTFLoader+DRACOLoader/postprocessing 链/RoomEnvironment/BufferGeometryUtils）+ **rapier3d-compat（wasm base64 内联）** + three-mesh-bvh + three-player-controller + lil-gui + 业务码（lobby 219KB + attractions ≈430KB + core/components/utils ≈360KB，未压缩源码口径）。
- 对照：deployment-guide §七 旧值 5.1MB / gzip 1.87MB；vite build 仅有 chunk 体积告警，无错误。

**拆分方案建议（按收益/风险排序）**
1. **manualChunks 分包（一行配置，零行为变化）**：`vendor-three`（three + examples）、`vendor-physics`（rapier3d-compat）、`vendor-move`（three-mesh-bvh + three-player-controller）、`vendor-gui`（lil-gui）。缓存命中率收益立竿见影：改业务码不再使 three 的 ~2MB 缓存失效。
2. **物理懒加载（最大首屏收益）**：把 `physicsManager.init()`（main.js:598）延迟到首个真正用物理的设施（pumpkin-thrower/dummy）激活时；`import RAPIER from '@dimforge/rapier3d-compat'` 改 `import()` 动态加载 → 大厅/观赏设施用户完全不下载 ~1.3MB wasm 文本。注意 physics-manager 的 `get world()` 已有未就绪抛错守卫，改造面小。
3. **设施级动态 import**：11 个 attraction + 5 个场景工厂改 `() => import('…')`（`attractionManager.register` 的工厂签名天然兼容 Promise 包装，activate 处加 await）；首包只留 core+lobby+全局单例，预估首包可降至 ~1.5-2MB。需同步验收脚本的 prewarm 口径（后台预热会按需拉 chunk，失败重试需兜底）。
4. **死资产下线**：hand-tracker 接线前把 `public/models/hand-landmarker.task` 移出 public（或加 .gitignore 按需获取），dist 直减 7.8MB；draco 解码器随 vendor-three 分包归入缓存桶，或等待真正接入 glb 时再决定 vendored `public/draco/`（并修复 model-loader.js:45 的 decoderPath）。
5. **visitor-ai.glb（32MB）保持仓库级隔离**：现状已不进 dist（构造路径 Vite 不可静态分析），继续保持；未来若真接入，先过 Draco+KTX2+骨骼动画评估，并移到 public/ 走 `/models/` 路径。
6. **长期项**：assets 大文件迁移 Git LFS / 独立资产仓（当前 git 仓库含 32MB 二进制，clone 成本高）。

---

## 附：三大技术风险（结论）

1. **性能预算双破且优化手筋已自废**——实测 1,057~1,195 draw calls（预算 900）+ 296k~298k 三角面（硬上限 300k，余量 <1.2%），而 render-optimizer.js:75-79 把区域级 LOD 钉死 level0（远景剪影失效，与 districts.js:30-32 设计注释矛盾），预算弹性只剩视锥剔除。任何新增内容都会破线，低端/移动端帧率首当其冲。
2. **5.6MB 单包 + 启动即加载 Rapier**——单 chunk 无拆分、wasm base64 内联、Lobby 禁物理仍无条件 `await physicsManager.init()`（main.js:598）：冷启动解析/编译时间直接转嫁到「开始页→可玩」链路，弱网/移动端首屏与 PRD「3 次点击」体验目标冲突。
3. **多写者相机的互斥缺口 + 边界口径分裂**——lobby-scene.js:4368/4377/4119-4152/3553 存在坐姿×动物园飞行×模式切换的组合竞态（双写相机/controls.target），MovementMode/WASD/NPC 三套边界（118/30/31）不一致且 118 超草坪半径 110：组合操作下会出现相机拉扯与走出世界的体验级回归（v4 曾专修过同族「双主控 dances」，此处是遗留分支）。

---
*生成：2026-11-15 · 本阶段只读，未修改任何源码/配置；两个场景审计子代理与主审三方行号交叉一致后落盘。*

---

## 附2：阶段二交付记录（2026-11-15 深夜 · 核心玩法重写与沉浸式交互）

四个模块按序全部落地，`npm run build` ✓、verify-m4-dance 13/13 ✓：

**模块 1 · 跳一跳退役 → 跳舞厅（室内第一人称）**
- 删除 `src/scenes/attractions/jump-jump.js` 与 `src/components/embedded-views/jump-jump-embed-view.js`；main.js 全部接线换 `DANCE_KEY='dance-hall'`（PROJECT_NAMES / BACKGROUND_PREWARM_KEYS / register）。
- lobby-scene.js：FACILITIES[3] 改跳舞厅（同槽位 26,-2）；`_buildDanceHall()` 重写门面（霓虹门柱/门楣/门玻璃/侧墙霓虹条/跑马灯牌座/5 颗音符灯珠 `_danceOrbs`/屋顶金球）；AABB 与 LOD spec 同步。
- 新建 `src/scenes/attractions/dance-hall.js`（~900 行）：26×18×8.5 室内（棋盘发光地板 emissiveMap 回填 / 四墙 / 舞台+裙边 / 6 霓虹勾边 / 三块背景幕）；钢琴（黑白键，黑键 InstancedMesh×7）/立麦/镜球/音箱×2/观众席 3 IM；**3 个表演者**（buildCharacter：琴师坐姿 y=0.61=凳面1.53-骨盆0.925、歌手持麦弹跳、舞者转身踢腿）`_animatePerformers` 每帧关节驱动；**WebAudio 合成节拍**（自建 AudioContext，118BPM 16 分格 lookahead，kick/clap/hat/bass/stab 全合成，Am→F 贝斯 32 步）；灯光 3 盏 PointLight 按 `pow(1-(t/SPB)%1,3)` 包络呼吸；dh-ui（标题/🔊音乐/⏻返回/Escape）；dispose 幂等（_stopBeat→WASD→UI→相机恢复→disposeCharacter×3→IM.dispose 台账→引用清空）。

**模块 2 · 小游戏背景无缝衔接（嵌入视图化）**
- carousel-embed-view.js / pirate-ship-embed-view.js：IEmbeddedView，**零 GPU 资源**（只挂空 root）。木马锚点=共享 `Lobby/facade-carousel-spin`（R=2.65×1.25，eyeY=2.49，φ=θ-α 映射）；海盗船锚点=`Lobby/facade-pirate-ship-pivot` matrixWorld × pivot-local(-0.85,-4.18,0.42)，防眩晕恒水平（up=世界Y）、基础朝向大厅中心；两者均支持指针环顾（过渡期拒绝）、找不到共享立面时降级自算动画。
- main.js：`EMBEDDED_KEYS` +CAROUSEL/PIRATE（-JUMP_JUMP）；facilityRuntime.register×2；dayNightCycle.registerEmbeddedContext 同步。实测：进入后 `attractionManager.activeKey` 保持 `lobby`、相机贴骑乘位（木马 (12.19,2.49,6.76)≈anchor、海盗船贴甲板 anchor 软跟随）、Lobby 常驻 → 背景草坪/城堡/木马全可见。

**模块 3 · NPC 防穿模 + 动物园重做**
- npc-manager.js：步进前三重防线——①整段位移线采样（复用建图 `_segmentBlocked` 口径，斜穿墙角也拦）②轴滑动同样整段采样 ③滑动不通立即换向（BFS 重算/重选目标 + 0.6s 防抖冷却）；另加 1.2m 前瞻探测贴墙提前换向；`navStats.blockedRetargets` 计数。
- lobby-scene.js：新增 `_npcBoxes`（NPC 专属实体障碍，与玩家 `_buildingBoxes` 分离）：长椅 8（按 yaw 求轴对齐盒）/ 路灯 6 / 花坛 4 / 喷泉 (0,6) r2.75 / 街道道具（长椅/路灯/垃圾桶/路牌）合计 25 盒注入 `npcManager.setObstacles`。**顺手修幽灵路灯**：被排除路灯索引缩零隐藏（原单位矩阵留在原点）。
- zoo-scene.js：四类主角五部件拼搭（球 ico/圆柱 cyl/圆锥 cone/方盒 box，全部共享几何，新增仅 1 个共享圆柱 ≈32 面）：**鸡 5**（红冠/黄羽/短喙/双翅/双腿）、**鸭 4**（扁喙/长颈/白羽/上翘尾）、**鹅 3**（长颈/橙喙/大体型/周期扇翅）、**狗 5**（竖耳/摇尾/间歇停顿），+保留龟 4 / 鱼 15。共 30 个 InstancedMesh；烘焙轨迹 poultry 12 只混群（互相分离）+ dog + reptile；部件级动画：啄食点头（慢摆+^6 峰值脉冲）/双翅扇合/交替迈步/摇尾/鱼尾摆；instanceColor 改以白为基的亮度变化（修正与材质色相乘过暗）。入口立柱 ±4.2→±3.2 退出 4m 沥青路 + 门内沙砾小径。

**模块 4 · 对齐、文字与标识**
- FACILITY_SPECS 露天设施加 `facadeFront`（南瓜轮 4.6=基座 r4.3+沿 / 木马 4.7=帐篷檐 3.75×1.25 / 海盗船 2.8=塔柱面 2.1×1.25+柱径），`triggerOf` 用 facadeFront ?? doorDepth 派生——海盗船触发环从嵌进塔架 4.4m 修正到门面外 3m；`_assertTriggerSpacing()` 扩展「圈-门面失配 ≤0.5m」自检（9 点最小间距 7.54m ≥6.5 仍过）。
- 「游乐园」大门招牌 worldW 10.5→12.5（半宽 6.25 仍在双塔内缘 ±6.6 内；底边保持 y=11.6 贴梁正面）。
- districts.js：三区入口双柱 + 双面 CanvasTexture 牌（动物园/城堡屋/农家宝，512×256 深底圆角+彩条+中英双语；正/背两片各朝一侧不镜像；纹理/材质登记台账 dispose 成对释放）。位置：动物园 (32.4,0) 朝西、城堡屋 (0,31.6)、农家宝 (60,31.6) 朝南。

**测试同步**：verify-v4.mjs RIG_KEYS（jump-jump→dance-hall）、玩家模型段（跳舞厅查 WASD+表演者 rig×3）、⑫ 项改嵌入视图双查（木马/海盗船 Lobby 常驻+activeKey=lobby+立面在场）；verify-m4-jump.mjs 整体重写为跳舞厅专项 13 项（进入/眼高/WASD/表演者/坐姿 0.61/灯光 3 盏/镜球音箱/无独立天幕/UI/静音切换/退出清零/0 报错）——**13/13 PASS**。

**资源台账变化**：动物园 16→30 IM（+14 draw call，几何全共享）；大厅基线纹理 36→39（三块区牌 CanvasTexture，属基线内成本，redline Δ0/0 口径不变）；dance-hall prewarm 前后 geo/tex 恒定（零泄漏，进出两轮实测无残留）。

**修复记录（回归暴露）**：prewarmFacility / onEnterAttraction 的物理门控只判 `physicsManager.isReady`，与 `syncPhysicsContext()` 回填 `baseCtx.world` 之间存在微任务窗口——verify ⑬ 连发预热时 dummy 在 world 回填前进 activate 抛「缺少 Rapier 世界」。两处补 `|| !baseCtx.world` 判据封死（main.js）。

**最终验证（2026-11-15 实测）**
- `npm run build` ✓（index 485kB，较阶段一 491kB 再 -6kB：删跳一跳净减）。
- **verify-v4 13/13 全 PASS**：⑦ 触发环 9 点最小 7.539m 告警 0（含圈-门面失配自检）；③ NPC 穿墙=0/25 障碍；⑫ 木马+海盗船嵌入（Lobby 常驻、activeKey=lobby、立面在场）；⑬ 五轮 Δgeo=0/Δtex=0（稳态 54geo/39tex）、734 calls / 267,404 tris（<30 万）、0 pageerror / 0 console.error / 0 404。
- verify-m4-jump.mjs（跳舞厅专项重写）13/13：坐姿 0.61 / 表演者 rig×3 / 灯光 3 盏 / 退出清零。

---

## 附：阶段一修复记录（2026-11-15 晚 · 底层抢救与性能释放）

按「先底层致命漏洞、后业务重写」排期执行完毕，四项全落地：

**① 相机互斥 + 边界统一**
- lobby-scene.js：`_visitZoo` 增加坐姿/漫游接管/过渡中拒绝（toast 提示，飞行回程不受限）；`_toggleInputMode` / `_sitDown` 增加 `_zooFly` 与 `movementMode.isEngaged()` 拒绝；update() 对 `_updateZooFly` 加 `_sitState==='none'` 门控。
- movement-mode-manager.js：`engage()` / `isEngaged()` 增加 `ctx.busy` 让位；main.js 的 getContext 注入 `busy: !!active._zooFly`。
- 边界统一 110m：`WASD_WORLD_BOUND` 30→110、MovementMode `WORLD_BOUND` 118→110（对齐草坪半径；玩家可步行到城堡/农场区）。

**② 资源泄漏与运行期新建清零**
- fireworks-deck.js：3 个 InstancedMesh 登记台账并在 dispose 调用 `.dispose()`（修 instanceMatrix/instanceColor 泄漏）；花型随机改 `AUTO_TYPES` 显式过滤 text（修硬编码 3 且保持原行为）。
- jump-jump.js：删除私有 rAF 与运行期 `new RingGeometry/Material` → init 预建单位扩散环按方块半宽缩放复用、主 update 驱动（暂停自动冻结）；`_popText` 的 setTimeout 全部登记清理。
- century-clock.js + lobby：每帧 `new Date()` 改模块级共享 Date（setTime 原地刷新）；setNight 加阈值状态机（仅 0.5 穿越换 finial 材质）。
- lobby：喷泉 343 顶点重算加 70m 相机距离门控。
- parkour-run.js：HUD 改写变化检测 + 道具条 10Hz 节流（innerHTML 60/s→按需）；160 金币零矩阵只写一次。
- pumpkin-thrower.js：3 处 `[...arr]` 展开改倒序遍历；`setTranslation` 复用共享对象。
- zoo-scene.js：rotZ 闭包+数组分配（~256 次/帧）改模块级 `rotZInto`；修 `(isFish?ly:ly)` 残渣。
- main.js：resize 匿名监听改具名 + pagehide 解绑。

**③ LOD 降级恢复**
- render-optimizer.js `pinHighDetail`：区域级 LOD 分支从「autoUpdate=false + 钉死 level0」反转为「autoUpdate=true + 清除钉死标记」；设施 DetailLOD 保留 90/115m 阈值。

**④ 拆包 + 物理懒加载**
- vite.config.js：manualChunks 分 vendor-physics / vendor-three / vendor-move / vendor-gui。
- physics-manager.js：Rapier 改动态 `import()`（幂等 + 并发安全 + 失败可重试）；启动**不预取**——`PHYSICS_KEYS`（dummy/pumpkin-thrower）在 onEnterAttraction / prewarmFacility 门控处才拉取；baseCtx 的 world/RAPIER 由 `syncPhysicsContext()` 就绪后回填。

**验证结果（2026-11-15 实测）**
- `npm run build` ✓：首包 index **491kB**（原单包 5,637kB，-91%）；首包实际加载（index+three+move+gui）1,308kB / gzip ≈362kB（原 1.87MB，-80%）；vendor-physics 4,335kB **不在 modulepreload**，仅进物理设施时下载。draco 5 文件 1.31MB 仍为休眠产物（见 §⑥）。
- 懒加载时序实测：boot 后 `physReady=false`（零物理加载）；`prewarm('dummy')` 现场触发 → 3s 内 world 就绪、lobby 未受扰、0 错误。
- 俯瞰机位 (30,84,96)：**916 calls / 273,076 tris**（LOD 钉死解除后远景收益 ~279 calls / ~25.3k 面）；近景 overview (0,30,34)：1,197 calls（与历史 1,195 持平——本阶段不合并网格，近景 call 数属阶段二议题）。
- **verify-redline M0：8/8 全 PASS**——3 轮切换 Δgeo=0/Δtex=0（67/36 稳定）、120 帧热路径零新建、双机位面数 ≤30 万（296,534/285,066）、dispose 幂等、0 pageerror。LOD 低模层首次合法上传带来的 +4 geo/+3 tex 为稳定成本，非泄漏。
- 运维备注：修复期间原 5173 dev 服务器的依赖缓存被一次并发的 `npm run dev` 弄脏（504 Outdated Optimize Dep），已重启干净实例；`tests/_diag-boot-probe.mjs` 探针已删除。

---

## 附3：阶段三交付记录（2026-11-16 · 童话城堡群 / 三主田 + 菜圃 / 程序化材质）

阶段三在不合并大厅旧物件、不新增常驻纹理台账的前提下完成。硬红线实测：**总三角面 ≤300,000**、**5 轮进出 Δgeo=0 / Δtex=0** 全部通过。

### A · 城堡群（`src/scenes/castle.js`）
- **体量**：中央主堡 + 4 座贴角塔 + 4 座外围塔（南塔兼门楼）+ 2 段侧翼 + 闭合城墙/城垛；8 塔高度 22~35m，`detail` 8 个子对象。
- **童话配色**：象牙白 / 奶油 / 低饱和粉 / 雾蓝 / 玫瑰 / 淡金；金腰线、尖顶、宝珠、旗帜。
- **几何合批**：墙体/塔身/基座/腰线/城垛合并为 `body`；城墙 `walls`、尖顶 `roof`、城门 `gate` 各自合并；窗 148 个、宝珠 9 个、灯珠 21 个、旗帜全部用 `InstancedMesh` 或合并几何。
- **夜间窗光**：148 扇拱窗共用 `texWindowGlow`，`dayNightCycle.onChange` 驱动 `emissiveIntensity`；夜间 2.0 / 黄昏 0.9 / 白天 0.22。灯珠夜间 0.95，宝珠 1.0。
- **台地**：46×46 石台（`MeshStandardMaterial`，色 `#b7a6cf`，粗糙度 0.95），承托全部 R=18 外围塔；随昼夜受光变暗，夜间不再出现纯色 MeshBasic 被 Bloom 抬成白盘的问题。
- **自身成本**：16 calls / 6,272 tris（近景隔离测量）。

### B · 农场（`src/scenes/farm.js`）
- **布局**：西侧水稻田 18×20、东侧玉米地 14×12、南侧小麦田 15×24、东南菜圃 4×10；土垄/田块/十字田埂合并为 `soil`，谷仓+风车+筒仓+围栏合并为 `structure`。
- **7 类作物**：水稻 360 株（1.0~1.2m，亮绿）、玉米 168 株（1.85~2.0m，深绿粗茎 + 金黄小穗）、小麦 360 株（0.78~0.82m，金黄）、菜圃南瓜/甘蓝/番茄/马铃薯叶 40 + 果 40。合计 **968 个实例**。
- **叶片**：十字/三向 `PlaneGeometry` 双面叶片 + `texCropLeaf` 3 格图集（水稻/小麦/玉米）+ `alphaTest 0.45`；顶点色保持白色，颜色由图集直接上色；玉米叶图集加密加宽，避免只看到稀疏叶脉。
- **行走**：行距 0.83m（水稻）/1.14m（玉米）/0.8m（小麦），玉米行间可穿行；作物不参与碰撞。
- **自身成本**：14 calls / 25,052 tris（近景隔离测量）。

### C · 材质与程序化纹理（`src/utils/helpers/procedural-textures.js`）
- `createNoiseRoughnessTexture`：草地/柏油/石墙/漆面 4 张噪声粗糙度图，由 Lobby `_trackTexture` 统一登记；城堡 `matStone`/`matRoof`、农场 `matSoil`/`matStruct`、道路 `MeshStandardMaterial` 分别挂载。
- `createWindowGlowTexture`：拱窗 + 窗棂 + 暖光渐变，作为窗 `map + emissiveMap`。
- `createCropLeafAtlas`：512² 三格叶片图集 + 右下纯白格；水稻/小麦/玉米叶片几何按 UV 子矩形采样，茎/穗/果用白格 + 顶点色。
- 共享纹理只登记、不重复创建；Castle/Farm 的 `dispose` 只释放自有合并几何/材质与 InstancedMesh，零跨模块误释放。

### D · 验收数据（2026-11-16 实测，`tests/verify-phase3.mjs` 7/7）

| 机位 | calls | triangles |
|---|---:|---:|
| 四宫格俯瞰 (30,84,96) | 958 | **286,636** |
| 城堡近景 (34,26,98) | 942 | **275,100** |
| 农场近景 (48,14,88) | 455 | **248,326** |
| Redline (0,30,34) | 1,245 | **296,834** |
| 常规 (0,9.4,25) | 1,089 | **284,746** |

- **5 轮进出**：稳态 60 geometries / 45 textures；5 轮全部相同，Δgeo=0、Δtex=0。
- **夜间**：`windowIntensity=2.0`，exposure 0.86；0 pageerror / 0 console.error。
- **专项**：`verify-m8-castle.mjs` 6/6（8 子对象、body 1,096 面、窗 148、Δ0/0、预算）；`verify-m9-farm.mjs` 6/6（7 子对象、5 crop IM、968 实例、Δ0/0、预算）。
- **构建**：`npm run build` ✓（index 502.76kB / gzip 155.42kB；vendor-physics 4,335.38kB 仍为懒加载分块）。
- **截图**：`docs/screenshots/phase3-overview.png`、`phase3-castle-day.png`、`phase3-castle-night.png`、`phase3-farm-day.png`、`phase3-farm-corn.png`；报告 `docs/screenshots/verify-phase3.json`。

### E · 已知偏差
- `verify-redline.mjs final` 8 项中 7 项通过：双机位绝对面数（294,842 / 284,746 ≤300k）、3 轮 Δ0/0、120 帧零新建、触发环/动物园、幂等、0 报错、截图均 PASS。
- 未通过项为「相对 M0 基线 calls 增量 ≤60」：俯瞰 +104、常规 +78。该增量来自工作区**阶段二既有未提交改动**（动物园 16→30 IM、跳舞厅、区牌等），阶段三自身新增仅城堡 16 + 农场 14 + 台地 1 calls；三角面相对 M0 为 -14 / +1,394，仍在硬红线内。按约定未合并大厅旧物件，也未改动阶段二文件。

*阶段三只改 `src/scenes/castle.js`、`src/scenes/farm.js`、`src/scenes/districts.js`、`src/scenes/lobby-scene.js`（共享纹理接线）、新增 `src/utils/helpers/procedural-textures.js` 与 `tests/verify-phase3.mjs`；未触碰 `package-lock.json` / `pnpm-lock.yaml`。*

---

## 附4：阶段四交付记录（2026-11-16 · 门面包装、UI 美化与终极验收）

### A · 皇堡 / 凯旋门式南门（`src/scenes/lobby-scene.js`）
- 拆除旧简易门楼，重建双厚重石柱 + 金边拱券 + 中央堡身 + 四角塔楼 + 塔顶锥尖 + 双层城垛 + 徽记；保留 `gate-arch-*` / `gate-tower-*` / `gate-crenels` 等既有判据名。
- “游乐场”招牌三件套（深色底板 + 正反发光字）挂在门头正中央，world `(0, 14.05, 16.8)`，字面朝南；遮挡检测遍历门体网格，招牌矩形内 0 个前向遮挡物。
- **合批**：新增 `_mergeGateDecor()`，把同材质石柱 / 金饰 / 旗帜 / 窗光等 50+ 小件烘焙为 5 个 Mesh，门体从 73 个子对象降到 17 个；保留塔楼、拱券、城垛、尖顶与招牌独立可识别。门体 draw call 增量由 +114 降到 +31（M5 F）。
- AABB 只挡两侧石柱（内缘 ±4.9m），中央 9.8m 门洞完全可通行；`gate-emblem` 盾徽置于招牌上方，不侵入文字区。
- 城堡区路牌从门轴 `x=0` 移到 `x=-18`，不再立在“游乐场”大门正前方遮住门洞；入园中轴视线完全打开。
- 草坪网格 96×96 → 72×72，省 8,064 个三角形（3.05m/格，程序化草地纹理不变），为门体与后续装饰留出红线条量。

### B · UI 主题统一（`src/utils/helpers/ui-theme.js` + StartScreen / PauseMenu / 跳舞厅 / Lobby）
- 全局字体栈 `"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`；黄铜 / 暖金 CSS 变量、毛玻璃面板、统一文字阴影。
- 开始页：26px 圆角毛玻璃卡、黄铜渐变主按钮、`transform/box-shadow/filter` 悬停过渡（0.18s）。
- 暂停菜单：20px 毛玻璃 + 黄铜描边 + 角落装饰线；继续 / 重玩 / 退出三键统一 hover / focus。
- 跳舞厅 HUD、Lobby 模式键 / 动物园键 / 时间控制台同步毛玻璃与黄铜主题；设施面板复用全局字体与 hover 规则。
- **手机窄屏**：≤600px 隐藏重复标题，模式键缩为“◧ 漫游 · WASD”，操作提示改为“左侧摇杆移动 · 拖拽转视角 · 点击入口进入”；≤700px 隐藏 F/飞行 HUD 与 lil-gui，避免压住摇杆。

### C · 键盘与移动端双端
- 虚拟摇杆 `VirtualJoystick` 修复 `_release` 未定义：pointerup / lostpointercapture 统一走 `reset()`，拖动结束归零，不再残留轴向或抛 pageerror。
- 摇杆在 orbit 与 WASD 两种大厅模式均启用；嵌入设施 / 相机过渡 / 坐姿自动收起；跳舞厅内独立 WASDController 复用同一组件。
- 触屏点击判定保留 14px 最大位移、550ms 长按取消、多指作废、200ms 防抖；触屏拖拽转视角不再误进设施，轻点仍可进入。
- 实测：大厅 WASD 1.5m、跳舞厅 WASD 1.25m；摇杆大厅 1.565m、跳舞厅 1.250m、玉米地 1.043m；拖拽 0 次进入 / 轻点 1 次进入。

### D · 最终验收（`tests/verify-phase4.mjs`，15/15）

| 项 | 实测 |
|---|---|
| 大门结构 / 招牌 | 17 子对象、4 塔、3 尖顶、纹章、垛口；招牌 0 遮挡 |
| 入园门景 | 1,182 calls / 281,346 tris |
| 五区巡游峰值 | 1,209 calls / 288,436 tris |
| 热路径 5 轮 | 56 geo / 41 tex，Δgeo=0 / Δtex=0 |
| 首包 | 入口 521.28kB / gzip 161.57kB；CSS 5.50kB / gzip 1.62kB |
| 报错 | 0 pageerror / 0 console.error |
| M5 皇堡专项 | 8/8；1,042 calls / 269,586 tris，dCalls +31 / dTris −13,766 |

- 截图：`phase4-gate-day.png`、`phase4-start-screen.png`、`phase4-pause-menu.png`、`phase4-dance-hud.png`、`phase4-mobile-dance.png`、`phase4-mobile-corn.png`；机读报告 `docs/phase4-report.json`。
- 构建：`index-Dlm7yVR0.js` 521.27kB / gzip 161.56kB；`index-BMmxRrmC.css` 5.50kB / gzip 1.62kB；`vendor-physics` 4.34MB 不在首屏 modulepreload。
- 测试说明：headless 移动标签页 rAF 会被 Chrome 降到约 1fps，因此输入断言在真实键盘 / 摇杆事件后手动推进同一 `update()` 补帧；这不是产品侧降级，真机连续帧路径不变。
- 已清理 `tests/_phase4-*`、`tests/_apply-gate.mjs`、`tests/_gate-new.txt` 与 `docs/screenshots/_phase4-*` 临时探针；`package-lock.json` / `pnpm-lock.yaml` 未改动。

---

## 附5：阶段五交付记录（2026-11-16 · 3D 微缩大都会）

### A · P0/P1 公园让位与四车道
- `geoGround` 72×72 → **56×56**；8 个触发环改用专用 `TorusGeometry(1,0.055,6,32)`；草簇 400 → **300**；程序化人物头/肢/发几何降段。新增 `_applyShadowBudget()`，关闭树/草/触发环/路灯/围栏的投影，静态阴影约省 27.5k 面。
- 四宫格道路中心改为 `(24,27)`：13m 车行道 + 两侧 1.5m 人行道 = **16m 走廊**；双黄中线、±3.25m 四车道虚线、四向斑马线、绿化带重绘。
- 跳舞厅移至 **(-23, 8.5)**，整体 0.85 缩放；烟花台移至 **(13.8, 15.5)**，0.6 缩放；城堡台地中心西移 **cx=-7**（x∈[-30,16]）清出南北走廊；三区路牌同步移位。AABB 按缩放后的实体重算，触发环仍在门前 3m。

### B · 福田式都会区（`src/scenes/metropolis/`）
- `city-layout.js`：城市基座 x∈[-95,95] / z∈[94,245]，主干道 x=24 宽 16m 接公园北缘；3 条东西向路 + 2 条侧路；18 个塔楼街区全部与道路留 ≥1m 绿化带。
- `city-buildings.js`：18 座 **45~132m** 蓝绿玻璃塔，三段收分 + 屋顶 + 部分天线；玻璃幕墙使用程序化 `makeGlassFacade` + `makeNightWindows`（亮窗 emissiveMap，不建窗几何）。医院含白体量、玻璃带、屋顶红十字/停机坪与“市人民医院”牌；学校含教学楼、体育馆、标准跑道/球场与“实验学校”牌。
- **三级 LOD**：近景全部合并（3 玻璃材质 + 屋顶/医院/学校，**1,474 tris**）；95m 外单盒合并（**252 tris**）；185m 外纯色单盒（**252 tris**，仍采样幕墙纹理）。城市自身约 39 个 authored draw。
- `city-textures.js`：256×512 玻璃幕墙/夜间亮窗、512×320 跑道球场、停车位铺装，全部 CanvasTexture 并登记释放。

### C · 交通 / 人群 / 街景（全 InstancedMesh）
- `city-traffic.js`：5 条 CatmullRomCurve3 路线（城市环、西环、公园接驳环、公交专用、停车支路），每条 **256 个预采样点 + 法线**；28 辆行驶车（车身/车顶/4 轮 3 个 IM）+ 4 辆停放车，1 辆公交（车身/窗带 2 个 IM），运行时只写标量 `t` 与矩阵；红绿灯 9s 固定相位。
- 公交沿公园接驳环行驶，在 `(32.4,38)` 公交站停靠 3.2s，触发 3 名低模行人下车，经斑马线穿过大门进入公园后折返。
- `city-crowd.js`：24 个低模通勤者（身体/头/腿 3 个 IM），21 人绕主街人行道环线，3 人为公交下客；身体/腿走路摆动在 CPU 标量完成，无物理。
- `city-street.js`：50 盏路灯（杆/横臂/灯头/地面光斑 4 个 IM）、4 组信号灯（杆/灯头 2 个 IM）、道路/人行道/车道线/斑马线全部实例化；公交站顶棚、长椅、站牌为普通低模组。
- NPC：迎宾 2 → **4**（-4.4/-2.2/2.2/4.4 一排），余下 **6** 人为原有巡游通勤者，保持 10 人总量与单 draw call。

### D · 相机 / 雾 / 昼夜
- `PerspectiveCamera.far` 200 → **700**；大厅线性雾 45–130 → **55–420**，新增 620m 绿色地平线垫层与城市基座，避免 130m 硬切边。
- 夜间：玻璃 emissiveIntensity **3.515**、路灯光斑 opacity **0.55**、信号灯转亮绿；白天玻璃亮窗降到 0.015，保持蓝绿反射。城市背向相机时整组隐藏，公园朝南视角零城市 draw。

### E · 验收（`tests/verify-metropolis.mjs`，12/12）
| 项 | 实测 |
|---|---|
| 塔楼 / 地标 | 18 塔、医院、学校、公交站 |
| LOD | 1,474 / 252 / 252 tris（0/95/185m） |
| 7 机位峰值 | 1,170 calls / **239,204 tris**（入园） |
| 城市近景 | 427 calls / 198,460 tris |
| 交通 | 28+4 车、1 公交、24 行人、50 路灯、4 信号灯，全 IM |
| 路线 | 5×256 预采样，25s 推进 Δgeo/Δtex = 0/0 |
| 公交 | 停靠触发，3 名下客全部 active 且 t>0 |
| 热路径 | 82 geo / 46 tex，城市⇄大门 5 轮 Δ0/0 |
| 报错 | 0 pageerror / 0 console.error |

- 回归：`verify-phase4.mjs` **15/15**、`verify-m5-castle.mjs` **8/8**、`verify-m8-castle.mjs` **6/6**、`verify-m9-farm.mjs` **6/6**。
- 截图：`metropolis-day.png`、`metropolis-night.png`、`metropolis-close.png`、`metropolis-gate.png`；机读报告 `docs/metropolis-report.json`。
- 构建：`index-FwvaSwT3.js` 546.99kB / gzip 170.09kB；CSS 5.50kB / gzip 1.62kB；`vendor-physics` 4.34MB 仍为懒加载。
- 未改动 `package-lock.json` / `pnpm-lock.yaml`；除上述道路/设施坐标、迎宾人数与相机雾界外，未改动阶段二设施内部业务。
