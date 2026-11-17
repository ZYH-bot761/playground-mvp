# 仍有效的需求约定汇总（requirements-active）

> **⚠️ 时效提示（2026-11-17）**：本文是基于 HEAD `628238b` 的历史盘点。11/17 已落地四季天气、GTA 驾驶、森林公园、都会区扩展，并完成相机写者契约 / 全局上下文 / 粒子池 / 联合回归等工程底座优化。**当前唯一权威现状见 `docs/current-status.md`**；交接主文档见根目录 `项目信息.docx`。下文 §3.7「大厅禁用 Rapier（world.bodies 恒 0）」已被驾驶功能覆盖（上车后 14 刚体、下车归零），§7 验收脚本索引需补 `verify-camera-contract.mjs` 与 `verify-all.mjs`。

> 生成：2026-11-15 · 本阶段只读盘点产物
> 口径：以「当前 HEAD（628238b，工程化目录整理后）的代码」为唯一现状基准，逐份判断 docs/ 下历史文档哪些约定仍然有效、哪些已被代码演进覆盖。不复制大段原文，只留结论与出处。

## 0. 文档效力总览

| 文档 | 日期 | 性质 | 效力判定 |
|---|---|---|---|
| docs/prd-v1.0.docx | 锁定版 | 产品需求（PRD v1.0） | **有效**：产品目标/验收硬指标仍为最高层依据 |
| docs/design-spec-v0.1.docx | 草案 | 5 项目功能级设计 | **部分失效**：金币小径/弹跳碰碰球已被 v3 的 parkour-run/jump-jump 取代（v3-handoff.md §二-4 已确认删除 CoinPath/BouncingBall） |
| docs/deployment-guide.docx | 2026-11-08 | 部署与运维 | **有效**（EdgeOne/main 自动部署、Node 22.17.1、预览凭证 3h） |
| docs/v3-spec.txt | v3 期 | 九大模块提示词（7.6 处截断） | **模块0 约束仍有效**；模块1/2 已落地并被 v4 再改造 |
| docs/v3-handoff.md | 2026-11-09 | 历史问题交接 | 已被后续修复覆盖，仅作背景（warmUp 抛错问题随 T01 懒激活方案消亡） |
| docs/v3-module0-report.md | 2026-11-09 | 模块0 代码阅读报告 | 历史，行号已漂移 |
| docs/part1~part5-*-report.md | 2026-11-09~10 | 手册阶段性审计 | 历史快照，目录/行号基于重构前代码，不可当现行索引 |
| docs/v4-refactor-plan.md / v4-lobby-final-spec.md | 2026-11-11 | v4 方案 A 设计 | **方案已落地**；其中的架构决策（双层契约）仍有效，任务分解已过时 |
| docs/v4-status-and-handoff.md | 2026-11-11 19:45 | v4 收官交接 | **有效**（13 项验收结论 + 9 条工程红线） |
| docs/handover.md | 2026-11-15 | 当前唯一权威交接 | **有效**（M0–M10 + 六项升级），但其中文件路径是重构前命名 |
| docs/directory-audit.md | 2026-11-15 10:22 | 目录盘点（重构前扫描） | **判定结果失效**：扫描的是 628238b 重构前的旧目录树，引用关系表不能当现行索引用 |
| 《IAttraction 契约文档 v1.0》 | — | PRD 引用的锁定技术契约 | **docs/ 下不存在该文件**，契约实际以代码注释为准（src/scenes/attractions/i-attraction.js、src/components/embedded-views/i-embedded-view.js 文件头） |

## 1. 产品级约定（PRD v1.0 锁定版，仍有效）

1. **产品形态**：浏览器 3D 游乐场，个人与好友小范围娱乐；不做账号 / 联机 / 在线排行 / 支付 / 后台（本地最高分仅 localStorage）。
2. **体验约束**：开始页 → 任一项目 ≤ 3 次点击；返回大厅后再次进入不报错；单局 30–60 秒。
3. **稳定性验收硬指标**（PRD §9.2，当前代码以 main.js `logMemory` + `window.__playground.baseline` 承接）：
   - 连续切换 5 个项目不崩溃、控制台无持续报错；
   - `renderer.info.memory.geometries/textures` 切换 5 次回落基线不漂移；
   - GPU Memory 曲线走平。
4. **性能分级**：桌面流畅、移动端基础可玩允许降画质（落地为 quality-tier 三档）。
5. **兼容下限**：Chrome/Edge 80+、Firefox 90+、Safari 15+；首版 Rapier 标准版（非 SIMD）。
6. **素材策略**：Kenney CC0 / 程序化生成兜底；禁止下载外部资源（v3-spec 模块0 + model-loader 文件头同口径）。
7. **部署**：静态托管 EdgeOne Pages，push main 自动重建；输出目录 dist。

## 2. 技术级硬约束（v3-spec 模块 0，代码已普遍遵循，仍有效）

1. **帧率无关**：一切动画/计时用 delta 累加，dt 上限 0.1s（scene-manager.js:259、各 attraction update 同口径）。
2. **资源生命周期**：init 创建、dispose 释放；渲染循环内禁止 new Three.js 对象（v4 后在 lobby/attractions 内大量落地「预分配复用」，个别破例见《项目现状地图》BUG 清单）。
3. **DOM 管理**：浮层离场必须移除并解绑监听（PauseMenu/StartScreen/JumpJump UI 均按此实现）。
4. **相机归属**：游玩期由设施接管、退出归还大厅；禁止 camera.add() 进设施 Group（CameraRig 单例仲裁）。
5. **纹理色彩空间**：CanvasTexture 必须 `colorSpace = SRGBColorSpace`。
6. **性能预算**（v3-spec 0.6 本项目验收线）：大厅静态 calls ≤ 120；单设施游玩中 ≤ 200；全场景三角面 ≤ 300,000；中端笔记本 ≥ 55fps。（注：0.6 引用的「行业基准 Draw Call<50」是外部检索口径，不是本项目验收线；effect composer 下 `renderer.info.render.calls` 恒为 1，须按 v4-status §坑 6 用结构盘点口径评估。）
7. **泄漏验收**：init→play→dispose 后 geo/tex 回落基线（v4-status 修订：先用「预热遍历 → steady 基线」再测 5 轮 Δ0/0，惰性上传一次性增量不算泄漏）。

## 3. v4 架构契约（v4-status-and-handoff / 代码文件头，仍有效）

1. **双层契约并存**：独立玩法走 `IAttraction`（init/update/onInteract/dispose，经 AttractionManager：activate=「dispose→registry.disposeAll→scene.remove」逆序卸载）；观赏/载具类走 `IEmbeddedView`（ FacilityRuntime 换相机、大厅常驻）。
2. **唯一世界不变量**：全程只有一个 THREE.Scene；嵌入视图禁止 new Scene / 改 background/fog / dispose Lobby 共享资源 / 隐藏 Lobby 根节点（i-embedded-view.js 六条硬禁令）。
3. **EMBEDDED_KEYS = { demo-embed, ferris-wheel, jump-jump, pumpkin-thrower }**；`TRIGGER_KEY_ALIASES = { 'pumpkin-thrower': 'ferris-wheel' }`；旧 PumpkinThrower 保留注册但不再是大厅入口（用户明确「不要投篮/金币」）。
4. **相机仲裁**：CameraRig 是唯一相机写者；嵌入期间挂起 Lobby OrbitControls.update；过渡中禁环顾/禁 WASD。
5. **冷启动**：只预热 Lobby + 全局单例，其余 10 设施懒激活 + 后台分帧预热（嵌入态暂停预热，绝不误卸大厅）。
6. **资源红线**：NPC ≤ 2 draw call（现实现 1 个 InstancedMesh）；全场景 ≤ 30 万面；`setForceNoCull` 默认关（否则破预算）。
7. ** Lobby 契约**：大厅禁用 Rapier（world.bodies 恒 0，physics-manager.js:104 空转守卫）；移动碰撞用 `Lobby._buildingBoxes` AABB + BVH，不用物理引擎。
8. **v4-status §启动纪律**（仍有效）：同一时刻只允许一个任务改 Lobby.js；放大摩天轮轮组前必须同步 FerrisWheelEmbedView 的 5.4/8.2 锚点常量；改嵌入设施生命周期需复核 ⑬ 基线口径。

## 4. 工程与运维约定（handover.md + deployment-guide.docx，仍有效）

1. **六项升级取舍不得回退**：movementMode 懒接管（engaged 默认 false）；renderOptimizer「钉死高模 + 精确包围体」替代强制关剔除；CollisionWorld 粗筛 + MeshBVH 精筛 + AABB 兜底三层碰撞；Sprite 标签 `initTexture` 主动上传防 Δtex 假阳性。
2. **验收纪律**：每模块专项脚本 + verify-v4.mjs + verify-redline.mjs 不绿不进下一模块；Δ0/0 测试前强制确定机位（handover §五-4）。
3. **dev server**：Vite 8 需 Node 20.19+（EdgeOne 选 22.17.1）；dev/preview 缓存头由 vite.config.js 统一注入（/assets/* immutable 一年、html no-cache）。
4. **部署链**：EdgeOne 跟踪 main 分支；禁止 force push；token 不落盘（本机私密信息.txt 已 gitignore）。
5. **模型接入优先级**（part4/model-loader 约定，仍待美术资产）：P0 carousel/pirate-ship、P1 lobby-gate/century-clock、P2 parkour-obstacle/jump-platform、P3 coaster-car；接入前 `modelLoader.registerAsset(url)`，未登记 URL 一律程序化占位不发请求。

## 5. 悬置/进行中的需求（有文档、代码已就位或未接线）

1. **手幻仙牛（手势设施）**：阶段 1 `src/components/hand-tracker.js` 已完成（纯逻辑 + 去抖 + rAF 零分配），但**无任何模块 import 它**；阶段 3 设施层未开工。MediaPipe 版本锁 0.10.3（WASM 走 jsdelivr CDN、模型走 /models/hand-landmarker.task）。
2. **visitor-ai.glb AI 游客资产**：实测结论「不接入运行时」（33MB / 0 骨骼 / Q 版群像），保留作对照资产；`registerGeneratedVisitorAsset()` 仅登记不加载。
3. **v3 模块 5（大厅椅子坐下休息）/ 模块 9（渲染反 AI 感增强）**：v3-spec 后半段截断，交接表中「未开始」，当前代码未见对应实现。

## 6. 与代码现状冲突 / 已过时（必须知道，勿按旧文回改）

| # | 冲突点 | 旧文档口径 | 代码现状 |
|---|---|---|---|
| 1 | 目录结构 | directory-audit.md / part1~5 / handover 引用 `src/attractions/*`、`src/ui/*`、`src/core/MovementModeManager.js`、`src/assets/models/*`、`src/features/hand/HandTracker.js` | 628238b 已重排为 `src/{core,scenes,components,objects,utils,shaders}`；对应关系：attractions→scenes/attractions，ui→components（+labels/embedded-views/controllers），HandTracker→components/hand-tracker.js，assets→assets/。旧路径全部失效，仅内容可参考 |
| 2 | 首版 5 项目 | PRD/design-spec：南瓜投手/金币小径/记忆翻牌/弹跳碰碰球/小火车 | 现注册 11 设施 + 3 嵌入视图；金币小径→parkour-run、弹跳碰碰球→jump-jump、小火车→train-ride/高空环游、南瓜投手改由嵌入摩天轮替代入口 |
| 3 | pixelRatio 上限 | v3-spec 0.6：`Math.min(devicePixelRatio, 1.5)` | quality-tier：high/medium 上限 2、low 1.25（handover 手册 P6 口径，视为后令） |
| 4 | 灯光强度 | v3-spec 提示词 sunIntensity 1.5 / ambient 0.4 | day-night-cycle 标定 ×0.387/×0.175（toneMappingExposure=1.0 + 线性预乘 0.38 的本项目成像口径） |
| 5 | 后处理链 | 部分旧注释/文档写「ColorGradePass」 | 实际链路只有 RenderPass→Bloom→FXAA→OutputPass（scene-manager.js:151-170；scene-manager.js:144-149 注释与代码不符） |
| 6 |「加载页 F01」 | PRD F01 要求加载页 | 现实是 StartScreen（纯 DOM 开始页）+ 渐进式预热，无独立加载进度页（首屏由开始页承担，属于演进偏离，PRD 未回写） |
| 7 | 空闲暂停 | deployment-guide「按 E 进入设施」 | 现行交互为「走近发光环点击 / E 进入」，WASD 为地面+飞行双模式（M 键仅保留兼容路径），文档未更新 |
| 8 | dist 体积 | deployment-guide §七：5.1MB（gzip 1.87MB） | 现为 index chunk 5,636,688B ≈ 5.6MB（本阶段静态盘点口径），拆包建议见《项目现状地图》§⑥ |
| 9 | DRACO 解码器 | model-loader 头注释「decoderPath='draco/'，无压缩资产不触发下载」 | three r187 DRACOLoader 通过 `new URL('../libs/draco/…', import.meta.url)` 静态引用 → 5 个 draco 文件（约 1.3MB）无条件进 dist/assets；而 `public/draco/` 并不存在，一旦真接 Draco glb 会 404（休眠风险） |
| 10 | PRD 引用的《IAttraction 契约文档 v1.0》 | 锁定技术契约文档 | docs/ 下缺失，契约散落在 i-attraction.js / i-embedded-view.js 文件头注释，属文档债 |

## 7. 现行验收脚本索引（tests/，有效）

- 全量：verify-v4.mjs（v4 13 项）、verify-redline.mjs（8 项红线）
- 专项：verify-m1-wasd / m2-layout / m3-npc / m4-jump / m5-castle / m6-zoo / m7-districts / m8-castle / m9-farm / verify-zoo / verify-six-upgrades
- 诊断：diag-m7-budget / diag-m7-quick / diag-m8-overview / diag-dispose-trace / diag-six-modes / diag-six-smoke / diag-budget-calls + tests/redline-baseline.json 机位基线
- 注意：脚本内大量 `window.__playground` 句柄与稳定 key 依赖，改 main.js 注册表/基线口径时需同步脚本。
