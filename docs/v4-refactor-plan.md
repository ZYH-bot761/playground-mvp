# 游乐园 v4「真实一体化」重构 —— 代码勘察 + 增量架构设计 + 有序任务分解

> 作者：架构师 高见远（Gao） · 日期：2026-11-11 · 性质：**只读勘察 + 设计**；除临时 Playwright 探针脚本（已删除）外未改任何业务代码
> 代码基线：`D:/playground-mvp`，Three.js r187 + Rapier3D 0.21 + Vite 8.3.6，原生 ESM
> 校验环境：`http://localhost:5173/` HTTP 200（dev server 已由 team-lead 重启）；`git status` 有未提交改动（docs/ 与多张 shot-*.png 未跟踪）
> **实测**：我用 Playwright + SwiftShader 对当前版本做了运行时探针（启动耗时 / 资源基线 / 往返 Δ），数据锚点见 §5.12；因软渲染 shader 校验限制，draw call 数值不可信、须真机复测。
> 配套图：`docs/class-diagram.mermaid`、`docs/sequence-diagram.mermaid`

---

## 0. 勘察方法、证据等级与重要澄清

### 0.1 证据等级
本方案所有"根因"均来自**逐行代码事实 + 文件行号**，可复核；关键性能结论另有 **Playwright 运行时实测锚点**（§5.12）。凡属推断/建议均显式标注「推断」或「建议」。

### 0.2 关于三张用户截图（已由 team-lead 代码级核实，无需用户补图）
团队交接里提到 3 张截图（世纪钟钟面 `102d3fa0-…`、触发圈重叠 `be89654d-…`、文字模糊 `55771e8c-…`）。文件层面我实盘核对过：目录 `D:/电脑管家迁移文件/.../InputTemp/` 不存在、全盘无这三个 GUID 文件、我本人也未收到图片附件。

**但 team-lead 已在对话上下文中看到这三张图，并亲自做了代码级根因核实**，与我从代码静态定位的结论**完全一致**（见 §5.4/§5.7/§5.9）：

- 截图1 世纪钟数字/指针左右镜像 → `CenturyClock.js:286-292` 双面盘共用 `faceMat`/同一贴图，背面未翻 UV；`:327-329` 背面指针组 `rotation.y=Math.PI` 与正面不一致 → 背侧看数字与指针都反。
- 截图2 触发圈+橙色点阵名称牌重叠 → `FACILITIES` 坐标 + 名称牌 `worldW=label.length*0.85` 且点阵 cell 被拉伸，相邻标签/触发圈视觉重叠。
- 截图3 橙色点阵字「高空环游」糊成一团 → `Lobby.js:461 makeTextPixels`：canvas 260×88、`fontSize=min(66,240/len)`、5 字标签被压到 48px，采样步长与 InstancedMesh 世界尺寸放大叠加。

**结论：不需要 OCR 图片，也不要用户重传**（team-lead 已定）；三条根因均已落到文件:行号，方案照常推进，最终视觉验收由工程师在浏览器截图确认。

补充交叉验证：仓库历史截图 `docs/screenshots/part5-01-lobby-after.jpg`（2026-11-10 16:15）已人工查看，**印证了**：大门为「两根灰色圆柱 + 横梁 + 橙色点阵「游乐园」」的简陋形态；carousel/pirate 的橙色点阵名称牌与触发环在画面上挤在一起；过山车轨道可见但**无任何小车**。

### 0.3 一句话结论
> 当前架构的**根本矛盾**是：`IAttraction` 契约被实现成「一次激活 = 换一整个世界」（每个设施自建天空/地面/灯光/DOM UI、`dispose` 掉 Lobby、改 `scene.background/fog`），而 v4 要的是「大厅即游戏、一个连续 3D 世界」。解决之道**不是推翻契约**，而是新增一层 `IEmbeddedView`（嵌入式视图）+ `FacilityRuntime`（常驻动效协调器）+ `SceneContext`（共享世界上下文），让设施从「场景拥有者」降级为「同一场景里的相机视角 + 局部装配件」。同时把冷启动从「预热 12 个设施 / 40 次 renderOnce」改为「只预热 Lobby + 全局单例 / 首次进入懒构建」。

### 0.4 ⚠️ 实时落地状态（勘察期间工程师已并行开工，务必先读，避免重复劳动）

我在写本方案期间，工程师已依据**第一版设计**动手，**部分任务正在落地**。我 11:56 复核工作区（文件 mtime）事实：

| 项 | 已落地状态（实测文件） | 与本方案的关系 / 剩余差距 |
|---|---|---|
| `src/core/scene-context.js` | ✅ **已创建**（170 行，11:54），注释明确"v4 T01 建骨架，T03 起使用"；`worldRoot/propsRoot` 空 Group、`facilityAnchors`、幂等 `configure`、不打 `attractionRoot` 标记 | 与方案 A 设计**完全一致、实现质量高**；T01/T03 直接复用，**不要重复创建** |
| `src/main.js` 注入 SceneContext | ✅ 已做：`:46` import、`:230-239` `sceneContext.configure()`、`:472` 暴露调试句柄 | 已就位 |
| **T01 冷启动预热压缩** | ✅ **已做**：`grep -c renderOnce` 从 46 → **26**；10 个设施预热块全删（`:382-389` 注释确认"主链路 renderOnce 35→5 次"）；新增 `bootStartedAt` 耗时打印（`:228`）与 `prewarm(key)` 调试方法（`:499`，启动流程不调用） | **主体已完成**；⚠️ **`baseline` 仍在预热帧 `:400` 记录**（`readMemory()`），**尚未做本版 §5.1.1⑤ 的"稳态基线校准"**；⚠️ **后台 `requestIdleCallback` 预热队列未接**（`prewarm()` 只是手动调试用）→ 这是 T01 剩余两项，需补 |
| `src/main.js` 各设施 `warmupPeak` getter | ✅ 已改为恒 `null`（`:490-495`，兼容旧脚本） | 已就位 |
| `FacilityRuntime.js` / `CameraRig.js` / `WASDController.js` / `FerrisWheel.js` / `embedded/*` / `FacilityTextures.js` / `ProceduralCharacter.js` | ❌ **尚未创建**（文件不存在） | 仍是 T02~T10 的待建文件，按 §8 实施 |

**重要提醒（给 team-lead 与工程师）**：
1. 我的**运行时实测数据（§5.12：boot 3.2s / enter 4.5s、baseline 31/18）是"T01 改动进行中"的快照**——准确说是删完预热块前的文件状态（探针跑于 11:5x，工程师 main.js 改动也在并行）。当前代码 renderOnce 已降到 26 处，**优化后耗时应显著低于 3.2s**；请在 T01 收尾时用 `bootStartedAt`（`:228`）打点重测，以新数值为准。
2. **T01 不要整段重做**，只需补两件事：① 稳态基线校准（§5.1.1⑤ / T01 改动点 3）；② 后台预热队列接 `prewarm()`（§5.1.1 / T01 改动点 4）。
3. `git status` 显示大量 `?? src/**/*.js`（Carousel/CenturyClock/JumpJump/... 与 SceneContext）——这是工作区 index 状态变化，**不等于我改了业务代码**；我全程只读 + 仅写 docs/ 三份文档 + 临时探针脚本（已删）。

---

# Part A：系统设计与代码勘察

## 1. Implementation Approach（实现路径）

### 1.1 核心难点
1. **场景一体化 vs 既有契约**：`IAttraction` 的 4 方法（`init/update/onInteract/dispose`）与 `AttractionManager.activate/deactivate`（严格 dispose→registry.disposeAll→scene.remove）是 17/24 资源基线的地基。v3 全部设施都按「独立场景」设计，改造必须**不破坏资源归零纪律**。
2. **启动慢**：`main.js bootstrap()` 串行预热 12 个设施、调用 `renderOnce()` **35 次**（每次走完整 EffectComposer），且开始页 `autoHide:false` + `bootReady` 闸门把这段全暴露给用户。
3. **资源基线纪律（17/24）**：`docs/v3-handoff.md:124` 记录热基线 = Lobby 激活态 17 几何 / 24 纹理；`main.js:20-24, 508, 528` 用 `renderer.info.memory` 做 Δ0/0 验收。任何"常驻共享资源"的引入都要重新定义基线口径。
4. **无美术资产**：`ModelLoader.js` 已就绪但 `available` 清单为空，仓库无 vendored `.glb`；人物是 `CapsuleGeometry + SphereGeometry` 的胶囊小人。
5. **无头验证纪律**：`docs/v3-handoff.md:122-123`、记忆 `2026-11-10.md` 明确——改/删被 import 的模块必须**重启 dev server**（Vite HMR 残留会造假 BUG）；运行时结论必须真跑浏览器；软渲染 dt 被 clamp 0.1，过渡类验证要等 4~5 秒墙钟。

### 1.2 框架/库选择（不引入新依赖）
| 技术点 | 选择 | 理由（代码事实） |
|---|---|---|
| 3D 渲染 | 沿用 Three.js r187 + EffectComposer + UnrealBloom + OutputPass | `SceneManager.js:35-40,149-161` 已建立，且色调映射必须在 OutputPass（`:12-20`） |
| 场景一体化 | **新增 `IEmbeddedView` 接口 + `FacilityRuntime` 协调器**（纯手写，无框架） | 与 `IAttraction` 并行存在的**第二契约**；设施可同时实现两者，`AttractionManager` 完全不动 |
| 第一人称漫游 | **新增 `WASDController`**，复用 `OrbitControls` 的 `enabled` 闸门做互斥 | `Lobby.js:850-860` 已用 OrbitControls；`:3491` 已有 `controls.enabled` 开关先例（坐姿） |
| 相机接管/归还 | **抽取 `CameraRig`**，统一各设施散落的 `_cameraSaved` 逻辑 | 9 个设施各自实现 `camera.position/quaternion/up/fov` 存还原（如 `TrainRide.js:334-339,1091-1098`），重复且易漏 |
| 3D 资产 | 沿用 `ModelLoader.js`（GLTFLoader+DRACO+LOD+cache）；**AI 生成走独立轨道 G0**（§5.3） | `:27-28,43-46,101-126` 已完整；`MODEL_PRIORITIES:31-39` 已列 P0~P3；`loadOrFallback:101-116` 天然兜底 → GLB 可热替换、不阻塞批次 1/2 |
| 冷启动基线 | **稳态基线采样**（循环启动后第 3 帧）+ 设施 shader 预热后移 | 实测预热帧 tex=18 vs 稳态 27（§5.12）；删设施预热不影响基线（它们本就不计入），只需保住全局单例+Lobby 的基线帧（§5.1.1） |
| 物理 | 继续**大厅禁用 Rapier**（`NPCManager` 用 AABB 避障） | `Lobby.js:680` 注释 + `NPCManager.js:14-24` 工程取舍已论证，勿翻案 |

### 1.3 架构模式
- **组合优于继承**：不修改 `IAttraction`，用"能力接口" `IEmbeddedView` 做增量扩展。
- **世界上下文单例** `SceneContext`：持有唯一 `scene` / `worldRoot` / `propsRoot` / `facilityAnchors`，替代各设施"自建 root + 改背景"的分散做法。
- **常驻 + 懒激活**：外观与动效常驻大厅（需求 11），玩法逻辑首次进入才 build（配合启动优化）。
- **相机即视图切换**：进入设施 = `CameraRig.blendTo(anchor)`；离开 = `CameraRig.restore()`。**场景对象不增删**（除懒加载的玩法专用件）。

### 1.4 场景一体化：两种方案对比与推荐（任务 C 核心决策）

`docs/v3-spec.txt:172-174` 早就留下两条路线（方案 A「抽 `buildCarouselMesh(scale)` 共享建模」/ 方案 B「大厅直接实例化设施模型 + 引用计数」）。结合 v4 现状，我把"一体化"收敛为**两种架构级方案**：

| 维度 | 方案 A（推荐）：**双层契约 + 相机即视图** | 方案 B：**单场景内联（Lobby 吞并玩法）** |
|---|---|---|
| 核心思想 | `IAttraction` 契约**原样保留**；新增 `IEmbeddedView` 能力接口 + `FacilityRuntime`。进入设施 = 保留 Lobby 常驻 + `CameraRig.blendTo(anchor)` + 懒挂 `propsRoot`；设施仍是独立 Attraction，可随时降级回独立场景（跑酷/记忆）。 | 废弃 `AttractionManager` 的 `activate/deactivate` 切换；Lobby 成为**唯一常驻 Attraction**，所有设施玩法内联为 Lobby 内部的 `mode` 状态机，删除各 `*EmbedView.js`。 |
| 对 `IAttraction` 契约 | **零推翻**（`main.js:256-289` 回调内分流：嵌入走 Runtime、非嵌入走原路径） | **推翻**：9 个设施不再由 Manager 调度，`dispose` 归属全压给 Lobby |
| 对 17/24 基线纪律 | 天然兼容：Lobby 常驻成为新基线 B；设施 `detach` 只释放自有资源 → Δ0/0 | 需重写基线：所有设施资源常驻，**永不释放**，基线膨胀且"泄漏"判据失效 |
| 与启动优化（需求 1）协同 | **极佳**：设施玩法懒加载，正好配合 T01 删预热 | 差：全部玩法模型要一次性建好 → 又回到"冷启动慢" |
| 改动量 / 风险 | 中：新增 4 个 core 类 + 4 个 EmbedView，但每个都小、可单测 | **高**：Lobby.js 已 3778 行，再塞 9 套玩法状态机 → 不可维护；牵一发动全身 |
| 可回滚性 / 渐进交付 | **强**：可先只接入摩天轮一个设施验证闭环，逐个迁移；失败可回退到独立场景 | 弱：一次性大爆炸式重构，无法分批验证 |
| 场景连续性 | 完全连续（同一 `scene`，昼夜/天空/NPC 全在视野） | 完全连续，但代价是上述所有问题 |
| 性能（draw call/三角面） | 共享 `_shared` 资源池（`Lobby.js:934-1109`），外观只建一份 | 外观同样共享，但玩法对象常驻占用内存/更新 |
| 需求 10/11/12 满足度 | ✅ 全部 | ✅ 全部 |

**✅ 明确推荐：方案 A「双层契约 + 相机即视图」——不推翻 `IAttraction`，让设施共享同一个 Lobby 场景根节点。**

理由：① 唯一满足"不推翻 `IAttraction` 契约 + 守住 Δ0/0 基线纪律"的硬前提；② 与需求 1 的启动优化天然互补（懒加载）；③ 可先打通"摩天轮进入=换相机"最小闭环再逐个迁移，风险可控、可回滚；④ 跑酷/记忆等玩法类可保留独立场景（用户本就要求跑酷除外），方案 A 允许**混合**，方案 B 做不到。

> 方案 A 内部，设施建模的"复用方式"仍推荐 `docs/v3-spec.txt:173` 的**方案 A 思路**：抽 `buildXxxMesh(scale)` 纯函数，大厅外观与设施内共用同一套模型（视觉一致）；**避免** `:174` 方案 B 的"直接实例化 + 引用计数"（双重 dispose 风险）。T07 据此实施。

#### 1.4.1 回答核心问题：设施 update 时，相机与大厅 Sky / 地面 / 装饰如何保持同一场景？

这是本轮最大架构决策，我把机制讲透（工程师照此实现即可保证"不割裂"）：

**唯一场景不变量**：全程只有 `SceneManager.scene` 一个 THREE.Scene（`SceneManager.js:65`），**任何设施都不得 `new THREE.Scene()`，也不得改 `scene.background/fog`**。这是当前割裂的根源（§5.10 表格里 6 个设施都在 init 存/改 bg/fog），v4 立为**禁令**。

| 要素 | 一体化后归属（谁持有、谁 update） | 设施 update 时如何"仍在同一场景" |
|---|---|---|
| **Sky / 云** | `Lobby._buildSky()`（`:1147-1198`）常驻；`dayNightCycle` 注册其 material（`:870`）；每帧 `Lobby._updateAnimations` 让 sky 跟随相机水平位移（`:3466`） | Sky 是 `scene` 里的对象，`CameraRig` 只移动**同一台相机**（`SceneManager.camera`）。相机进摩天轮吊舱后，Sky 自动跟随相机位置 → 抬头仍是同一片天 |
| **地面 / 草坪 / 树 / 长椅 / 喷泉 / 过山车轨道 / 城堡门** | `Lobby.worldRoot` 常驻，由 `FacilityRuntime` 不接管（Lobby 不再被 dispose） | 这些是同一 `scene` 的静态/动画对象；相机在同一坐标系内移动（吊舱/座位坐标就是大厅世界坐标），所以设施视角天然能看到它们 |
| **设施外观（木马/海盗船/摩天轮）** | 外观归 `Lobby`（`_buildM9Facades:2628` / `_buildPumpkinWheel:1866`），**常驻**；玩法逻辑归 `IEmbeddedView`（懒加载） | 进入设施不新建模型，只是把 `CameraRig` blend 到该外观的座位锚点。玩家看到的就是大厅里那座真实的木马/船/轮，非另一套 |
| **昼夜 / 灯光 / NPC** | 全局单例常驻（`dayNightCycle/fireworkSystem/npcManager`）；`setContext(key)` 白名单纳入嵌入 key（`DayNightCycle.js:370-392`） | 设施 update 时 `dayNightCycle` 继续 lerp 同一批灯（`SceneManager` 三盏常驻灯 `:117-140`），天空/星月/NPC 都在视野里，无"切场景闪黑" |
| **相机** | 唯一 `SceneManager.camera`；`CameraRig` 统一管理姿态 | 进入 = `save()` 大厅机位 → `blendTo(座位锚点, 0.8s)`；退出 = `blendTo(saved, 0.8s)`。**从不换相机、不换 scene** |

**一句话**：`IAttraction` 从"场景拥有者"降级为"相机视角 + 局部玩法逻辑"；场景本身（Sky/地面/装饰/昼夜/NPC）永远由常驻的 `Lobby` + 全局单例提供。设施 `update(dt)` 只做两件事：更新自己的玩法对象矩阵 + 通过 `CameraRig` 微调同一台相机。

#### 1.4.2 对 dispose / 资源基线 / 相机接管的影响分析

| 维度 | 方案 A 的处理 | 风险与对策 |
|---|---|---|
| **dispose** | `AttractionManager.deactivate()`（`:107-147`）的 `dispose → registry.disposeAll → scene.remove(root)` **完全不动**。嵌入式设施退出时只 `detach()` 释放**自有**资源（玩法专用 geometry/material/texture），Lobby 常驻 root 和 `_shared` 资源池（`:934-1109`）**不 dispose** | **最大风险：共享资源被误 dispose**（double-free / 大厅花屏）。对策：`buildXxxMesh(scale)` 明确"外观资源归 Lobby 所有"，`IEmbeddedView` 只登记自己 `ctx.registerDisposable` 的对象；用 `DisposableRegistry` 按 key 归属隔离（它本就是每轮新建的 `:75-77`） |
| **资源基线（Δ0/0）** | Lobby 常驻 → 会话基线 = Lobby 稳态 + 全局单例（实测见 §5.12）。设施进入时 `attach` 新增少量资源，退出 `detach` 后必须**精确回落到基线** → 用 `logMemory()`（`main.js:129-144`）验证 Δgeo=0/Δtex=0 | **基线口径变化**：历史基线在"Lobby 预热激活态"取（`main.js:508`），实测稳态 tex 比预热帧多（§5.12），需统一为"稳态基线"并在 T01 一次性校准；atlas/GLB 新增纹理要计入基线而非增量 |
| **相机接管** | 抽取 `CameraRig`（save/blendTo/restore），替代当前 9 个设施各自散落的 `_cameraSaved`（如 `TrainRide.js:334-339,1091-1098`、`PirateShip.js:468-476,1167-1175`）。与 `OrbitControls`（`Lobby.js:850`）、新增 `WASDController` 通过 `controls.enabled` 闸门互斥（已有先例：`:3491` 坐姿禁用） | **相机争夺**：三者不能同时写 `camera`。对策：T02 先立 `CameraRig` 单一仲裁，T03+ 所有设施遵守；`frameDriver.update`（`main.js:323-330`）里按 fixed order 调用，避免 update 顺序导致抖动 |

#### 1.4.3 非嵌入式设施（跑酷 / 记忆翻牌）如何保留

方案 A 允许**混合**：`main.js` 的 `onEnterAttraction(key)`（`:256-272`）按 key 分流——嵌入式 key 走 `FacilityRuntime.activateRide()`（Lobby 常驻、只换相机）；跑酷/记忆保留原 `attractionManager.activate(key)`（独立场景 + 完整 dispose）。`isEmbedded` 标记（`IEmbeddedView`）作为分流依据。这样既满足用户"跑酷除外"，又让观赏类设施一体化。**渐进迁移**：先只把摩天轮改为嵌入式验证闭环，成功后再逐个迁移木马/海盗船/跳一跳/火车。

---

## 2. File List（涉及的完整文件清单，相对路径）

### 2.1 新增文件（v4）
| 文件 | 职责 |
|---|---|
| `src/core/scene-context.js` | 单例：共享世界根节点、设施锚点表、相机/输入句柄 |
| `src/core/facility-runtime.js` | 单例：常驻设施动效协调 + 嵌入式视图注册/激活/释放 |
| `src/core/camera-rig.js` | 相机姿态 save/blendTo/restore **单一仲裁**（替代 9 处散落的 `_cameraSaved`；与 OrbitControls/WASD 闸门互斥） |
| `src/utils/controls/wasd-controller.js` | 第一人称 WASD + 鼠标环顾控制器 |
| `src/attractions/FerrisWheel.js` | **重写**南瓜投手 → 真实摩天轮（`PumpkinThrower.js` 的替代） |
| `src/attractions/embedded/CarouselEmbedView.js` | 旋转木马嵌入式视图（模型归 Lobby，玩法归此类） |
| `src/attractions/embedded/PirateShipEmbedView.js` | 海盗船嵌入式视图 |
| `src/components/embedded-views/jump-jump-embed-view.js` | 跳一跳嵌入式视图（复用大厅天空/地面） |
| `src/utils/helpers/facility-textures.js` | 高质量文字贴图工具（替代点阵 Canvas 方案） |
| `src/utils/helpers/procedural-character.js` | 程序化人物升级（**3D 生成失败/不可用时的保底主线**，7~7.5 头身+四肢+服装） |
| `src/components/embedded-views/i-embedded-view.js` | 嵌入式视图契约（能力接口，与 `IAttraction` 并存） |
| `public/models/*.glb` | **独立轨道 G0** 的 AI 生成资产（carousel/pirate-ship/lobby-gate/century-clock/coaster-car/角色），`ModelLoader` 经 `registerAsset` 热替换 |
| `public/models/README.md` | G0 资产命名 / 面数 / 材质槽 / 风格约定（§5.3.2） |

### 2.2 修改文件（按批次）
| 文件 | 改动摘要 | 批次 |
|---|---|---|
| `src/main.js` | 冷启动重构（去掉 12 设施预热、renderOnce 35→2~3）；接线 SceneContext/FacilityRuntime；注册新键 | 1,2 |
| `src/scenes/lobby-scene.js` | WASD/鼠标切换；设施坐标重排；点阵字修复；城堡大门；常驻动效；挂轨小车；人物外观 | 1,2,3 |
| `src/scenes/attractions/century-clock.js` | 钟面双面朝向/指针镜像修复 | 1 |
| `src/scenes/attractions/pumpkin-thrower.js` | 下线（保留文件但 main.js 改注册 FerrisWheel），或改造为 FerrisWheel 的壳 | 2 |
| `src/scenes/attractions/carousel.js` | 抽出模型构建为可复用函数，接入 EmbedView | 2 |
| `src/scenes/attractions/pirate-ship.js` | 同上 | 2 |
| `src/scenes/attractions/jump-jump.js` | 复用大厅天空/地面/光照，接入 EmbedView | 2 |
| `src/scenes/attractions/train-ride.js` | 轨道曲线导出为共享常量（大厅/设施同曲线） | 2,3 |
| `src/utils/helpers/npc-manager.js` | 人物建模升级（可选 glTF / 程序化） | 3 |
| `src/utils/helpers/day-night-cycle.js` | `setContext` 白名单纳入嵌入式设施 key | 2 |
| `src/components/start-screen.js` | 文案/提示更新（WASD + 鼠标说明） | 1 |
| `docs/screenshots/*` | 新增 v4 验证截图（工程师产出） | 全批次 |

---

## 3. Data Structures and Interfaces（类图）

见 `docs/class-diagram.mermaid`。核心新增契约如下（工程师据此实现）：

```js
// IEmbeddedView —— v4 新增的第二契约（与 IAttraction 并存）
// 设施类可「同时」实现 IAttraction（保留资源归零纪律）与 IEmbeddedView（获得一体化能力）
class IEmbeddedView {
  get isEmbedded() { return true; }      // 标记：本设施为嵌入式
  attach(host)      {}                    // host = SceneContext.propsRoot；挂局部装配件，复用 host.scene
  detach()          {}                    // 释放「本视图独占」资源；共享 geometry/material 由 Lobby 统一持有不 dispose
  onRideStart()     {}                    // 相机接管开始（CameraRig.blendTo）
  onRideEnd()       {}                    // 相机归还 + 释放
}

// SceneContext —— 单例共享世界
// scene / camera / renderer 仍来自 SceneManager，唯一的"世界"只有一份
// worldRoot：Lobby 常驻外观（草坪/城堡门/世纪钟/树/站台/过山车轨道）
// propsRoot：进入设施时懒挂载的玩法专用件（吊舱/跳一跳方块）
// facilityAnchors: Map<key, THREE.Object3D>  —— 每个设施的世界坐标锚点（相机目标）

// FacilityRuntime —— 每帧由 SceneManager.attractions.update(dt) 调用
// update(dt): 驱动所有常驻动效（小车挂轨、摩天轮、木马、海盗船摆动）
// activateRide(key): 懒构建 IEmbeddedView + CameraRig.blendTo
// deactivateRide(key): CameraRig.restore + view.detach
```

**关键纪律**：`IEmbeddedView.detach()` **绝不 dispose** Lobby 的 `_shared` 资源（`Lobby.js:934-1109` 的统一资源池）；只释放本视图 `ctx.registerDisposable` 登记的自有资源。这样"进入→离开"的 Δ0/0 天然成立。

---

## 4. Program Call Flow（时序图）

见 `docs/sequence-diagram.mermaid`，覆盖：极速冷启动 → 点击进入 → 鼠标/WASD 切换 → 进入摩天轮（同一场景换相机）→ 世纪钟背面修复 → 跳一跳复用大厅 → Δ0/0 验收 7 个流程。

---

## 5. 逐条代码勘察事实（问题 → 根因 → 证据行号）

### 5.1 需求 1：打开网站点「进入游乐场」到大厅特别慢（第1项核心方案）

**根因（五重叠加，全部有行号）**：

1. **冷启动串行预热 12 个设施**：`main.js:361-522` 的 try 块内，依次 `activate` DUMMY/PUMPKIN/PARKOUR/MEMORY/JUMP/TRAIN/CAROUSEL/PIRATE/FIREWORKS/CLOCK+npc/LOBBY，每个都「activate → renderOnce → warmUp → renderOnce → deactivate → renderOnce」。
2. **`renderOnce()` 精确 46 处文本提及（team-lead `grep -c` 口径已复核），其中 40 处是实际调用**（另 6 处 `:11/:15/:151/:294/:500/:501` 为注释）。40 处调用行号：`221,270,285,316,365,367,374,376,378,380,387,389,392,402,404,407,416,418,421,433,435,438,449,451,454,457,459,462,474,476,479,489,492,495,507,511,519,527,542,552`（主预热链 35 + 回调/异常 5）。**每次走完整 `composer.render()`**（`SceneManager.js:226-229`）→ RenderPass + UnrealBloomPass + OutputPass 的 shader 编译/纹理上传，是最重耗时点。单个设施预热最多 4 次（PUMPKIN `:374-380`）。
3. **开始页把等待全暴露给用户**：`StartScreen` 以 `autoHide:false` 构造（`main.js:177`）；`onStart` 中若 `bootReady===false` 只打日志不 hide（`:184-190`）；真正 `hide()` 要等 `bootstrap()` 走到 `:560-567`。**用户点「进入」后必须干等全部预热**。
4. **单个 warmUp 很重**：`V3_HANDOFF.md:69-70` 记录 `ParkourRun.warmUp()` 内 240+ 次迭代（`main.js:388`）。
5. **同步重活**：PMREM 烘焙（`SceneManager.js:102-110`）+ `Lobby` 一次性建 ~30 几何/~30 材质/10+ CanvasTexture（`:934-1109`，草地 96×96 顶点位移 `:944`）。

**实测耗时（Playwright + SwiftShader，§5.12）**：`boot`（到 `window.__playground` 就绪）约 **3.2s**，`点击进入→循环启动` 约 **4.5s**（软渲染偏慢，真机需复测，但 40 次 composer 渲染是结构性开销，方向明确）。

#### 5.1.1 与"GPU 惰性上传 / Δ0/0 基线"硬约束的平衡（关键设计）

**矛盾**：`main.js:15-18` 与记忆第 39 行明确——资源只有经 `renderOnce()`（composer 链）真正渲染才上传 GPU、才计入 `renderer.info.memory`；全局单例（昼夜/烟花/NPC）必须在预热帧前 init 并 renderOnce 计入基线，否则往返切换 Δ≠0。若粗暴删掉 40 次 renderOnce，会破坏 Δ0/0 验收。**如何既减少渲染次数、又守住基线？**

**核心洞察**：基线（baseline）只需覆盖"**往返切换时始终常驻的资源**"——即全局单例 + Lobby 常驻世界；**设施资源是"用时上传、退出 dispose"的瞬时资源，根本不需要在冷启动计入基线**。现有 40 次渲染里，绝大多数花在"为 11 个设施各自预热 shader/纹理"（`:361-497`），这部分对基线的贡献为 0（deactivate 后已回落，`emptyBaseline` 才是它们的归宿）。因此可**分离"基线预热"与"设施 shader 预热"**：

| 手段 | 具体做法（对应 T01） | 对 Δ0/0 的影响 |
|---|---|---|
| **① 保留必要的基线帧（不可删）** | 只保留 4 类 renderOnce：冷基线 `221`、全局单例 warmUp 后 `316`、Lobby 激活后 `507`（**记录 baseline**）、Lobby deactivate 后 `511`（记录 emptyBaseline）+ 正式激活 `527`。合起来 **5~6 次**（含回调则更少） | **零影响**：全局单例（`:298-318`）与 Lobby（`:503-512`）仍在同一时序上传并计入基线，遵守记忆第 39 行纪律 |
| **② 删除设施预热块** | 整段删 `:361-497`（DUMMY/PUMPKIN/PARKOUR/MEMORY/JUMP/TRAIN/CAROUSEL/PIRATE/FIREWORKS/CLOCK 的 activate+warmUp+deactivate+renderOnce），约 **30 次** renderOnce + 全部 `warmUp()` 重逻辑（含 Parkour 240 次迭代） | **零影响**：这些设施资源本就在 `deactivate()` 后 dispose、不计入 Lobby 基线；删预热只是把它们首帧上传推迟到"首次进入时"。验收口径是"回到大厅后 Δ=0"，只要 `dispose` 彻底即成立（实测 `§5.12` 已证现有契约往返 Δ0/0） |
| **③ 合并 warmup 路径** | 每设施预热从 3~4 次 renderOnce 合并为「activate + warmUp 同一帧 → 1 次 renderOnce → deactivate → 1 次 renderOnce」；冷启动期**根本不做**（见 ④） | 减少 2~3 次/设施；Δ 不变 |
| **④ 设施 shader 预热后移到"首帧之后"** | 冷启动不预热任何设施；把 `activate→renderOnce→deactivate` 放到 `startGameplayLoop()` **之后**，用 `requestIdleCallback` / 分帧队列在后台空闲时逐个预热（进入大厅先看得到、玩得动，设施 shader 在后台陆续编译）。或更彻底：**首次进入设施时才 warmUp**（懒加载），配一个 0.3s loading 态 | Δ 不变（预热后 `deactivate` 仍回落基线）；首帧可见时间从 3.2s 降到 ~1s 级 |
| **⑤ 稳态基线校准（针对实测发现的隐患）** | 实测发现：预热帧 tex=18、稳定后 tex=27（§5.12）——基线记录时机过早，部分纹理（emissive 遮罩/bloom/惰性材质）在后续帧才上传。T01 把 `baseline = readMemory()` 从"预热帧 `:508`"改为"**循环启动后第 3 帧**再采一次稳态值"；所有 `logMemory` 以稳态基线比对 | **更严格**：避免"基线偏低导致后续 Δ>0 假泄漏"；与记忆第 14 行"星空惰性上传致 baseline 21→22"是同类问题的根治 |

**净效果**：冷启动 renderOnce 从 **40 → 5~6 次**（主链 35 → 5），设施 shader 预热不消失只是**后移/懒化**；Δ0/0 基线纪律由 ①⑤ 守住、由 ② 证明"删的本来就不进基线"。配合 `FacilityRuntime` 的懒加载（方案 A），首次进入设施才 build，与需求 1 天然互补。

> 交付 T01 时必须附三组实测：`boot ms / enter ms`（对比本轮 3.2s/4.5s 基线）、`baseline` 稳态值、`5 轮往返 Δgeo/Δtex`。软渲染数据仅作相对对比（优化前后同环境），真机数值由 team-lead 复测。

### 5.2 需求 2：大厅只有鼠标 OrbitControls，要「鼠标 / WASD」切换
**根因**：
- `Lobby.js:850-860` 创建 `OrbitControls`，`enablePan=false`，无任何键盘平移。
- `_bindInput()`（`:2976-2986`）只绑定 pointer + `keydown` 的坐椅 E 键（`:2988-3000`），**无 WASD 监听**。
- UI 提示 `:3017` 写死「拖拽旋转 · 滚轮缩放」；`:3486-3492` 的 `update()` 每帧 `this._controls?.update()`，无分支。
- 讽刺的是 `StartScreen.js:31` 与 `main.js:110` 的提示文案已写「WASD / 方向键漫游」，但**大厅代码根本没实现**（文案与实现不符，工程师可据此确认用户困惑来源）。
- 可复用先例：`Lobby.js:3491` 已有 `controls.enabled` 开关（坐姿时禁用），`:3160-3173` 有相机插值归还逻辑。

**方案**：新增 `WASDController`，`M` 键或 HUD 按钮切换；两者对 `camera` 互斥占有，`CameraRig` 统一存档/归还。细节见 §7 任务 T02 与 §9 冲突分析。

### 5.3 需求 3：人物（NPC + 玩家/角色）建模太差；评估 3D 生成技能
**根因（代码事实）**：
- **NPC**：`NPCManager.js:85-90` 仅 `CapsuleGeometry(0.30,0.88,4,10)` 身体 + `SphereGeometry(0.225,12,10)` 头，`MeshBasicMaterial` 不受光照（`:89-90`），10 个 NPC 靠 `instanceColor` 分色（`:131-134`）。无四肢、无表情、无骨骼。
- **玩家（跳一跳）**：`JumpJump.js:253-264` 同样 capsule + sphere 2 个 Mesh。
- **玩家（跑酷）**：`ParkourRun.js:321-343+` 略好（ capsule 身 + 球头 + BoxGeometry 四肢 pivot），但仍是低模拼搭。
- 历史取舍：`NPCManager.js:14-24` 明确为 10 个装饰 NPC 不引入 Rapier 刚体，用 AABB 避障 —— **该取舍继续保留**。

**buddy-multimodal-generation 技能评估（已读 SKILL.md 全文 + team-lead 复核）**：

**能力 / 流程**：`3d "prompt"` 文生 3D / `3d --image-url` 图生 3D / `--multi-view` 多视角 / `--enable-pbr` PBR 材质 / `--generate-type LowPoly|Normal|Geometry|Sketch` / `--face-count 10000~1500000` / `--result-format STL|USDZ|FBX`（额外格式）。SKILL.md:59 原文 `Add a format in addition to the default OBJ and GLB outputs` → **默认输出 GLB + OBJ**（GLB = glTF 2.0 二进制）。流程：`connect_cloud_service` 取 `clientTempToken` → 跑脚本 `3d ... --token` → 轮询 5s（1~5 分钟/个）→ 下载 `result_files`（优先 GLB）→ 建 `generated_model_<ts>_viewer.html`（model-viewer）→ `present_files`。

**✅ 结论：可行，推荐"AI 生成 GLB 资产"作为一条独立并行轨道，与批次 1/2 解耦。** 关键依据：
- **`ModelLoader.js` 已完整就绪**：`GLTFLoader + DRACOLoader`（`:27-28,43-46`）、`load(url)` 缓存/并发合并（`:68-95`）、`loadOrFallback(url, factory)` 自动占位兜底（`:101-116`）、`createLOD(levels)` 三档（`:122-126`）、`clear()/dispose()` 全资源释放（`:128-150`）。
- **`MODEL_PRIORITIES`（`:31-39`）已排好优先级**：P0 `carousel` / `pirate-ship`（曲面/装饰细节适合建模）；P1 `lobby-gate` / `century-clock`（地标，视觉占比大）；P2 `parkour-obstacle` / `jump-platform`（收益低）；P3 `coaster-car`（轨道/车厢）。

#### 5.3.1 生成什么资产（按优先级分批，先地标后人物）

| 批次 | 资产 | 类型 | 为什么值得生成 | 归因 |
|---|---|---|---|---|
| **G0-1（P0，先做）** | `carousel.glb`、`pirate-ship.glb` | 设施外观 | 曲面船体/木马装饰程序化难达真实感；且是一体化后大厅常驻的核心观赏物，视觉占比大 | MODEL_PRIORITIES P0 + 需求 10/11 |
| **G0-2（P1）** | `lobby-gate.glb`（**豪华城堡大门**）、`century-clock.glb` | 地标 | 直接服务于需求 8「城堡大门」——**AI 生成是比程序化拼搭更优的解法**；世纪钟精细建模 | MODEL_PRIORITIES P1 + 需求 8 |
| **G0-3（P3）** | `coaster-car.glb` | 小车 | 需求 6/11「小车挂轨跑」，车厢模型单独生成，挂到 `CoasterCarRuntime` | MODEL_PRIORITIES P3 |
| **G0-4（人物，谨慎）** | `visitor_A.glb` / `visitor_B.glb`（2~3 个变体） | NPC / 玩家 | 满足需求 3「人物更真实」。**但**：文生 3D 多为静态网格、无骨骼动画；NPC 走路/挥手仍需程序化驱动。**建议先生成 1 个玩家主角 + 2 个 NPC 变体做验证，不铺开 10 个**（10 个各自 GLB 会击穿 draw call 与基线） | 需求 3 + 限制见下 |

> **NPC 的 draw call 红线**：现有 10 NPC 靠 2 个 `InstancedMesh`（`NPCManager.js:8-10`）压到 2 draw call。若 10 个 NPC 各挂独立 GLB，会变成 10+ draw call 且 geometry/texture 各占基线 → **违背 `docs/v3-spec.txt:248`「10 NPC ≤ 2 draw call」**。方案：要么 GLB 角色也走 InstancedMesh（需单一共享 geometry + instanceColor 换色），要么只把"迎宾 2 人"用 GLB、其余 8 人保留程序化升级版。

#### 5.3.2 面数 / 材质约束（保 60fps + 守住预算）

- **面数**：`docs/v3-spec.txt:21` 全场景三角面 **≤ 300,000**；`--face-count` **推荐 10,000~30,000/个**（切勿用上限 150 万）。估算：6 个设施/地标 × 2 万 ≈ 12 万 + 大厅程序化几何（实测稳态约 8~12 万面，待真机确认）+ 3 个角色 × 1 万 ≈ 3 万 → 总量可控在 30 万内。**生成后用 `modelLoader.createLOD([{object:高模,distance:0},{object:低模,distance:40},{object:程序化占位,distance:90}])` 做远中近三档**（LOD 由 `DetailLOD.js` 既有纪律延伸）。
- **材质**：`--enable-pbr`，但**每个 GLB 材质槽 ≤ 3~4**（贴图 ≤ 2K，优先共用/打包），否则 shader program 数量与纹理基线膨胀；现有大厅材质纪律「MeshPhysicalMaterial 控制在 5 个以内」（`Lobby.js:1034-1035`）要延续到资产侧。
- **风格**：统一 `--generate-type LowPoly` 或 `Normal` + 统一 prompt 关键词（"pastel童话游乐园、低多边形、clearcoat 漆面、暖色调"），与现有程序化"童话低多边形 + 漆面"融合，避免更重的"AI 感"。
- **基线归属**：GLB 的 geometry/texture 计入 `renderer.info.memory` → **在 T01 校准"稳态基线"时把已加载资产计入基线常量**；`loadOrFallback` 走异步，要在 `renderOnce()` 之后、`logMemory()` 之前确保资产已 resolve（或用 `await` 预热帧），否则首帧加载会造成 Δ 假阳性。

#### 5.3.3 生成期间 / 失败时的程序化兜底路径（零黑屏、零 404）

`ModelLoader.loadOrFallback(url, fallbackFactory)`（`ModelLoader.js:101-116`）**已实现**兜底语义：资产未 `registerAsset` 或加载失败 → 返回 `fallbackFactory()` 的程序化占位。落地约定：
1. **默认程序化先行**：批次 1/2 的所有设施先按程序化几何实现并验收通过（`buildXxxMesh(scale)` 同时是 fallbackFactory）。
2. **GLB 就绪后热替换**：生成的 `.glb` 放入 `public/models/<key>.glb`（Vite 静态目录，无需 import URL；或 `assets/models/` + `new URL(...,import.meta.url)`）→ `modelLoader.registerAsset(url)` → 设施 `init` 里 `const {scene, fallback} = await loadOrFallback(url, () => buildXxxMesh(scale))`。生成期间 `hasAsset=false` 自动走程序化，**不阻塞任何批次**。
3. **失败兜底**：`load` 抛错 → `loadOrFallback` catch 内 `stats.fallbacks += 1` 并返回程序化占位（`:111-115`），同时 `console.warn`，**绝不黑屏**。
4. **dispose 正确性**：GLB 的 `scene.clone(true)`（`ModelLoader.js:110`）共享原始 geometry/material，`clear()`（`:128-145`）统一释放缓存；设施 `dispose` 不要再单独 dispose clone 的共享几何（否则 double-free）——由 T07 的"外观资源归 Lobby/ModelLoader 单例"约定保证。

#### 5.3.4 独立并行轨道 G0（不阻塞批次 1/2）+ 云端不可用替代

- **轨道隔离**：3D 生成需 `connect_cloud_service` 凭据 + 联网轮询 1~5 分钟/个，**属外部依赖，列为独立轨道 G0**，与代码关键路径 T01~T09 **完全并行**。代码侧（T10）先把程序化升级 + `loadOrFallback` 接线做完，G0 产出 GLB 后只需 `registerAsset` 即插即用，**生成慢/失败都不阻塞批次 1/2 的验收**。建议顺序：G0-1（木马/船）→ G0-2（城堡门/世纪钟）→ G0-3（车厢）→ G0-4（人物验证）。
- **云端 3D 服务不可用时（替代方案）**：程序化人物升级为"更真实的人体比例 + 四肢 + 服装细节"——`src/utils/helpers/procedural-character.js` 的 `buildCharacter({style, rig})`：
  - **人体比例**：按真实 7~7.5 头身（当前胶囊约 3 头身，过于卡通），`CapsuleGeometry` 躯干 + `SphereGeometry` 头 + 两段式四肢（上臂/前臂、大腿/小腿），关节用 pivot Group；
  - **服装细节**：`LatheGeometry` 裙摆/斗篷、`BoxGeometry` 衣领/腰带、`MeshPhysicalMaterial` 区分布料(roughness 高)/皮革/金属(metalness 高)，`instanceColor` 保持 NPC 换色；
  - **表情 / 头发**：`SphereGeometry` 头 + 小几何体五官 + `IcosahedronGeometry`/`LatheGeometry` 发型；
  - **动画**：程序化骨骼摆动（走路摆臂/迈腿、迎宾挥手、IDLE 呼吸），复用 `NPCManager` 的 WALK/IDLE/LOOK/WAVE 状态机（`:37`）；
  - **性能**：仍用 `InstancedMesh` + `instanceColor` 保持 NPC ≤2 draw call（`NPCManager.js:7-10`），复杂角色只在近景 LOD 启用。
  - 该路线**零外部资产、零 CORS/404、与稳态基线和懒加载天然兼容**，是 3D 生成失败或质量不达标时的**默认保底**。
- **本轮边界**：技能需联网凭据，架构阶段我只读勘察**不实际生成**；生成质量/面数/风格须由 team-lead 或工程师在 G0 轨道实测，按 SKILL.md 纪律（token 不缓存不外泄、失败返回真实错误、最多重试一次）执行。

### 5.4 需求 4：世纪钟钟面数字/指针左右镜像（从背面看反了）
**根因（确凿几何错误，不依赖截图）**，`CenturyClock.js:285-342`：

1. **双面表盘用同一个 `faceMat` 贴同一张 `faceTex`**（`:277-293`）：
   ```js
   for (const [z, rotX] of [[0.17, Math.PI/2], [-0.17, Math.PI/2]]) {
     const disc = new THREE.Mesh(discGeo, faceMat);  // discGeo = CylinderGeometry
     disc.rotation.x = rotX; disc.position.z = z;    // 两面都是 rotX = +π/2
   }
   ```
   `CylinderGeometry` 两端面（+Y / -Y 顶盖）的 UV 是各自朝外的；两面**用同一材质且不额外翻转**，导致从 -Z 背面看时，Canvas 上的数字（如 `3`、`CENTURY CLOCK`）呈**水平镜像**。
2. **背面三针是 `backHandGroup.rotation.y = Math.PI` 的独立一套**（`:326-342`），而 `tick()` 对正反用**同一个角度**（`:376-378` `for (const p of [hourHand, hourBack]) p.rotation.z = hourA;`）。`rotation.y=π` 的镜像会让背面指针的**旋转方向视觉反转**（顺时针↔逆时针），与正面读时方向相反 —— 这是"指针反了"的根因。
3. 注意：`createClockFaceTexture()` 本身（`:41-125`）画的是**正常顺时针** 12→3→6→9 与指针方向，贴图没错；错在**背面装配**。

**修法（T05，最小改动）**：
- 背面 disc 用**独立材质**（clone `faceMat`，`map` 用 `faceTex.clone()` 并设 `texture.wrapS=RepeatWrapping; texture.repeat.x=-1; texture.offset.x=1`），或直接给背面 disc `scale.x=-1` 同时 `material.side=DoubleSide` —— 使背面看到的数字成正像。
- 背面 `backHandGroup` 的角度取反：`p.rotation.z = -angle`（或保持 `rotation.y=π` 但把三针的 `mkBackHand` 局部 `x` 取反），使背面也呈顺时针读时。
- 发光遮罩 `createClockGlowMaskTexture()`（`:133-176`）同样要出一份 `flipX` 版本给背面，否则背面夜间刻度与数字错位。
- **验收**：从大厅 (6,-3) 设施机位 `camera.position.set(0,9.4,25)`（`:472`）看正面、绕到钟楼背后看背面，两面的 12/3/6/9 顺序与三针指向必须一致且可读（可用真实时间对齐，记忆第 33 行有"三针误差 [0,0,0]"的验法）。

### 5.5 需求 5：南瓜摩天轮（PumpkinThrower）重写成真实摩天轮
**根因**：
- `PumpkinThrower.js` 全文是**投篮/投掷玩法**：`STATE.PLAYING`、`warmUpThrowHit/warmUpExpire`（`main.js:375,377`）、`_state` 机（`:274`）、金币计分、`camera.position.set(0,0,22)`（`:348`）独立场景机位、`onExitAttraction`（`:624`）。
- 大厅里 `Lobby._buildPumpkinWheel()`（`:1866-1930`）已是**一个旋转的摩天轮外观**（`_wheelGroup.rotation.z += dt*0.13`，`:3405`），但它只是"观赏装饰"，点击进去变成投篮游戏 —— **名实不符**。
- 标签 `FACILITIES[0].label='南瓜摩天轮'`（`Lobby.js:77`）与实际玩法"南瓜投手"矛盾。

**方案**：`FerrisWheelView`（`src/attractions/FerrisWheel.js`）实现 `IEmbeddedView`：
- 复用大厅 `_wheelGroup` 的轮盘几何；新增 N 个**座舱（cabin）**挂在轮缘，随轮公转但**座舱自身反向旋转保持水平**（经典摩天轮运动学）。
- 进入 = `CameraRig.blendTo` 到某个座舱内机位（第一人称，可自由环顾四周看大厅高空景观）；`onRideStart` 让轮盘加速/匀速转，玩家可"四处转"（转头 360° 看大厅）。
- 彻底删除投篮/金币/计分/命中预热逻辑；`main.js:340` 注册改为 `FerrisWheel`；预热块 `:371-382` 删除。
- **验收**：进入后视野里是大厅（城堡大门、世纪钟、过山车、NPC、昼夜天空），不是独立暗场；座舱始终水平；离开回大厅 Δ0/0。

### 5.6 需求 6：建筑按真实大小放大；过山车小车必须挂在轨道上运行
**根因**：
- **过山车无小车**：`Lobby._buildCoasterTrack()`（`:2333-2421`）只建 `rails/ties/pillars` 三个 `InstancedMesh`（`:2352-2354`），日志 `:2419-2420` 自述"实例 …/3 draw call"——**根本没有 car mesh，也没有任何小车位姿更新**。这就是"空轨道 / 起始段悬空"的直接原因（连车都没有，或用户看到的是别处游离的车体）。
- 独立设施 `TrainRide.js` 里**有正确的小车挂轨实现**：`_placeTrain(t)`（`:692-705`）用 `curve.getPointAt/getTangentAt` + `makeBasis` 把 `_train` 放到轨道点；轨道曲线 `LOBE_A=80,LOBE_B=52`（`:62-63`）、24 点高度表（`:76-79`）。大厅轨道 `COASTER`（`Lobby.js:124-134`）复用同一高度表但缩到 17/14，两条曲线**各算各的**。
- **建筑偏小**：海盗船大厅外观 `_buildM9Facades()` 中"奇幻海盗船"用 4 根 `scale [0.34,7.0,0.34]` 立柱 + 船体 `scale [2.9,0.62,1.06]`（`Lobby.js:2708-2721`），约 7m 高，相对 40m 过山车（`:124-134`）确实显小；旋转木马顶棚 `scale [3.75,1.55,3.75]`、7m 高（`:2684-2686`）。

**方案**：
- 新增 `CoasterCarRuntime`：复用大厅 `COASTER` 的 `CatmullRomCurve3`（在 `_buildCoasterTrack` 里把 `curve` 存为实例字段 `this._coasterCurve`），每帧 `car.position.copy(curve.getPointAt(t)); car.quaternion.setFromRotationMatrix(basis)`（抄 `TrainRide.js:693-705` 的成熟做法），`t += dt/period`。**车一开始就在轨道点 t=0 上，不存在"起始段悬空"**。
- 把小车外观建成 2~3 节 `InstancedMesh`/Group，挂到 `worldRoot`，随大厅常驻更新（需求 11）。
- 建筑放大：命令式地给 `_buildM9Facades`、`_buildPumpkinWheel`、`_buildGate` 的外观整体 `group.scale.setScalar(s)`（s≈1.3~1.6），**并同步放大其 `_buildingBoxes` AABB**（`Lobby.js:2741-2745,1925-1929`）与 `_pickProxy`，避免"模型变大但碰撞/拾取还是原尺寸"。
- 与需求 7 强耦合（放大后更易重叠）→ 见 §9 冲突分析，**必须先重排坐标再放大**。

### 5.7 需求 7：大厅设施触发环重叠
**根因（可用坐标精确算出）**，`Lobby.js` `FACILITIES`（`:75-116`）+ `_buildTriggers`（`:2826-2907`）：
- 触发圆盘 `disc.scale=4.6`（`:2835`）→ 直径 **4.6m**；触发环 `ring.scale=2.4`（`:2842`）；两侧光柱偏移 `±2.6m`（`:2853`）；名称牌宽 `label.length*0.85`（`:2883`）。
- 触发点坐标：parkour `(13,2)`、carousel `(9,2)` → **仅相距 4m**；pumpkin `(-13,2)`、pirate `(-9,2)` → **仅相距 4m**；两组都 **< 4.6m 盘径**，必然交叠。century-clock `(3,3)` 与 carousel `(9,2)` 相距 ≈6.08m，名称牌宽 3~5m 也会**边缘擦碰**。
- 这与 `docs/screenshots/part5-01-lobby-after.jpg` 中右侧两个橙色点阵牌挤在一起的现象吻合。
- 注意 `_exclusionZones`（`:1331-1343`）与 `_buildingBoxes` 也依赖这些坐标，重排时要联动。

**方案（T06）**：
- 重排 `FACILITIES` 的 `x,z` 与 `trigger`，保证**任意两触发盘中心距 ≥ 6.5m**（>4.6m 盘径 + 余量）。建议把 carousel/pirate 从 `±9,6` 拉到 `±11,8`、触发点 `±11,2.5` 拉开；parkour/jump 沿 X 外扩；century-clock 触发点独立到 `(3,5)` 之类。
- **统一收敛**：新增 `TRIGGER_RADIUS=2.3` 常量，让 `disc/ring/光柱/nameplate` 都从它派生，避免再次漂移。
- 加一个 `console.assert` 的"最小间距"自检（开发期），遍历 `FACILITIES.trigger` 两两测距并打印告警。
- 同步更新 `_exclusionZones`（`:1336`）、`_buildingBoxes`、`_benchZones`、`npcManager.setObstacles` 的数据源（都从 `FACILITIES` 派生，改坐标即联动，但**需人工复核长椅/NPC 出生点不被新 AABB 吃掉**，参考记忆第 27-28 行的踩坑）。

### 5.8 需求 8：游乐场大门太丑 → 豪华城堡大门
**根因**：`Lobby._buildGate()`（`:1806-1860`）确实是"两根 `geoCylinder` 立柱（`:1815-1818`）+ 一根 `gate-beam` 横梁（`:1826`）+ 两颗球 + 紫色竖条 + 橙色点阵招牌"。历史截图证实为灰柱 + 横梁。**无城垛、无拱门、无塔楼、无砖石纹理**。

**方案（T09）**：把 `_buildGate()` 重写为**城堡门楼**：中央尖拱门洞 + 两侧锥顶塔楼（`geoCone`/`geoCylinder` + `matPillar`/`matCoinGold`）+ 城垛（`geoBox` 阵列，`InstancedMesh`）+ 吊桥/铁链意象 + 纹章；保留门洞 AABB（`:1855-1859`）与点阵招牌或升级为金属浮雕字（见 5.9）。**全部复用 `_shared` 资源**（`Lobby.js:1097-1108`），不新增 geometry/material/texture → 不破 17/24 基线；只增若干 `InstancedMesh` draw call（受 §6 预算约束）。可与 `ModelLoader` 的 `lobby-gate` P1 资产二选一（见 §5.3）。

### 5.9 需求 9：很多文字渲染模糊/看不清（橙色点阵字）
**根因（确凿）**：`makeTextPixels()`（`Lobby.js:461-485`）：
```js
canvas.width = 260; canvas.height = 88;   // 低分辨率
const fontSize = Math.min(66, Math.floor(240 / text.length)); // 5 字时仅 48px
const step = 5;                            // 每 5px 采一个点
// → 一个 5 字标签横向只有 260/5=52 个采样列，且字号被压到 48px
```
再用 `InstancedMesh` 把每个采样点画成 `geoBox` 小方块（大门 `:1831-1852`、触发牌 `:2878-2903`）。模糊来自三重叠加：
1. **采样网格粗**（step=5）+ 字号随字数压缩（`:471`）→ 字形细节大量丢失，成一团"马赛克点阵"。
2. **橙红漆面材质 `matNeonWarm`（`Lobby.js:974`）+ Bloom（threshold 1.4，`SceneManager.js:151-156`）**：高饱和暖色相邻点阵在 Bloom 下糊成一团，边缘不清。
3. **方块间无抗锯齿**：点阵小方块之间缝隙/锯齿在斜视角下明显；`worldW = label.length*0.85`（`:2883`）让长标签被进一步拉伸。

**方案（T06）**：新增 `src/utils/helpers/facility-textures.js`，用**高分辨率 CanvasTexture**（如 1024×256、`devicePixelRatio` 感知）+ SDF/描边字 + `anisotropy=maxAniso` 替代点阵 InstancedMesh；一张贴图贴在 `geoPlane` 上（复用共享几何），**关掉该材质的 Bloom 贡献**（或把颜色压到 threshold 以下）保证清晰。收益：**更清晰 + draw call 从"每字 1 InstancedMesh"降到"每牌 1 Plane"**。代价：每个标签 1 张纹理（9 个设施 + 大门 ≈10 张）→ **冲击 24 纹理基线**，需按 §6 重新定义基线口径（把文字纹理计入 Lobby 常驻基线，或合并成一张 atlas 图集只 +1 纹理）。**推荐图集（atlas）方案**：所有标签画到一张 2048×2048 CanvasTexture，用 UV 偏移取字，既清晰又只 +1 纹理。

### 5.10 需求 10/11/12：场景一体化 + 设施动起来 + 跳一跳不割裂
**根因（架构级，最关键）**：

现有每个 `IAttraction.init()` 都是"夺取整个全局场景"，证据链：
| 设施 | 存相机 | 改背景/雾 | 自建天空/地面 | 独立 DOM UI + 返回大厅 | 相机机位 |
|---|---|---|---|---|---|
| JumpJump | `JumpJump.js:96-102` | `:112-113` 改 bg/fog | `_buildSky() :115,135-146` + `_buildGround() :116,156` | `_buildUI() :120` + `:727` | `:132 _snapCamera()` |
| Carousel | `Carousel.js:643-657` OrbitControls | （未改 bg） | 自建顶棚/灯泡 | `_buildUI() :644` | `:646,957` |
| PirateShip | `PirateShip.js:468-476` | 依赖昼夜还原 | — | `:893-908 onExitAttraction` | `:842-847` |
| TrainRide | `TrainRide.js:334-339` | — | 方块游乐场全景 | `:867,897` | `:757,791` |
| FireworksDeck | `FireworksDeck.js:86-100` | `:100` 改 bg | 天幕球 | `:373` | `:268-272` |
| CenturyClock | `CenturyClock.js:434-442` | `:441-442` 存 bg/fog | 观景地面 `:459-467` | `:514` 返回大厅 | `:472-476` |
| PumpkinThrower | `PumpkinThrower.js:343-349` | — | — | `:624` | `:348` |

并且 `AttractionManager.activate()` 会先 `deactivate()` 当前 Lobby（`AttractionManager.js:73`），`deactivate()` 严格 `dispose→disposeAll→scene.remove`（`:107-147`），`main.js:264` 进入时把 Lobby 整个摘掉。昼夜系统 `DayNightCycle.setContext()` 对非白名单设施 `_restoreBaseline(false)` 隐藏天空（`:370-392`）。**结论：大厅与设施在数据结构上就是"互斥的两个世界"**，这正是用户说的"割裂/突兀界面"。

**需求 11 的直接证据**：Lobby 的 `_updateAnimations()`（`:3395-3480`）只让**摩天轮**（`:3405`）、金币（`:3407-3412`）、牌阵、弹跳球、粒子、触发环、喷泉、箭头、云在动；**旋转木马/海盗船/过山车小车/小火车在大厅里完全静止**（它们的大厅外观在 `_buildM9Facades`/`_buildCoasterTrack`/`_buildTrainStation`，均无对应 update）。小火车 `station-train-body`（`:2269`）是静态 Mesh。

### 5.11 现有 draw call / 资源基线（baseline）与性能预算
**预算（`docs/v3-spec.txt:19-24`，硬约束）**：
- Draw Call：行业基准 <50；**本项目验收线 = 大厅静态场景 `renderer.info.render.calls ≤ 120`，单个设施游玩中 ≤ 200**；
- 全场景三角面 **≤ 300,000**；中端笔记本稳定 **≥ 55fps**；
- 每个模块交付必须附 `render.calls / render.triangles / memory.geometries / memory.textures` 实测值；
- 泄漏验收：`init→play→dispose` 后 `geometries/textures` 回落 init 前（Δ0/0，`:24`）。

**基线数值的历史与现实**：
- 文档/记忆里出现过 17/24（`V3_HANDOFF.md:124`）、22/27（记忆第七部分）、31/30（记忆第八部分）——**随模块增加一直在涨**，说明"17/24"只是某一历史快照；团队口中的"17/24 纪律"应理解为 **"Δ0/0 纪律"** 而非固定数字。
- **本轮实测（Playwright + SwiftShader，2026-11-11，§5.12）**：预热帧 `baseline = 31 几何 / 18 纹理`；`emptyBaseline = 7 / 18`；但循环跑 2.5s 后的**稳态**读到 `30 几何 / 27 纹理`。**纹理差 9 张**——证实基线记录时机过早（部分纹理惰性上传），这是必须修的隐患（T01 的"稳态基线校准"，见 §5.1.1 ⑤）。
- 结构基线（代码可确认）：NPC = 2 draw call（`NPCManager.js:7-10`）；过山车轨道 = 3 draw call（`Lobby.js:2419-2420`）；旋转木马大厅外观 = 多个 InstancedMesh（`:2655-2736`）；烟花 = 单 Points（`docs/v3-spec.txt:303`）。
- 性能降级：`QualityTier.js` + `SceneManager.js:84-89,163-167`（移动端关 Bloom、降阴影/transmission）；`DetailLOD.js` + `Lobby._applyExteriorLOD()`（`:1786`）；`_updateAnimations` 用 `lodOn()` 跳过远景动画（`:3399-3403`）。

**一体化后的基线口径（重要，需 team-lead 确认）**：大厅常驻（`worldRoot` + 全局单例）成为**新的会话基线 B**，且必须在**稳态帧**（循环启动后第 3 帧）采样；进入设施仅懒加载"玩法专用件"，`deactivateRide` 后回落到 B（Δ0/0）。文字 atlas +1 纹理、城堡大门/角色若走 GLB 则 +N，都应**计入 B**，而非每次切换的增量。

### 5.12 运行时实测锚点（Playwright + SwiftShader，2026-11-11）

我用项目内 `playwright`（`node_modules/.bin/playwright` 存在）以 `--use-gl=swiftshader` 对当前版本做了只读探针（临时脚本已删除，未改业务代码）。**这些数据是本方案的性能锚点**：

| 指标 | 实测值 | 解读 / 用途 |
|---|---|---|
| `bootMs`（到 `window.__playground` 就绪） | **3220 ms** | 对应"预热全部完成后 bootReady"，是需求 1 的直接证据（软渲染偏慢，真机需复测） |
| `enterMs`（点击「进入」→循环启动） | **4517 ms** | 用户可交互延迟；`autoHide:false` 使点击后仍干等预热 |
| 预热帧 `baseline` | **31 geo / 18 tex** | `main.js:508` 在 Lobby 预热帧记录的值 |
| `emptyBaseline` | **7 geo / 18 tex** | 卸载后空场景（晚于 Lobby 预热记录） |
| 稳态（循环 2.5s 后） | **30 geo / 27 tex** | **tex 比预热基线多 9 张** → 基线记录时机过早的隐患（T01 ⑤ 根治） |
| 往返 Δ0/0（lobby→carousel→lobby） | `30/28 → 21/20 → 30/28`，**回到起点完全一致** | 证明现有 `IAttraction` 契约的 dispose 纪律有效；方案 A 必须保住这一点 |
| 进入 carousel 时 geo 30→21 | **几何体减少** | 反向印证"割裂"：进入设施时整个大厅被 dispose 卸载，只剩设施自身几何 → 需求 10 的架构级证据 |
| `qualityTier` / `activeKey` / `pickables` / AABB | `high` / `lobby` / 207 / 14 | 大厅拾取体 207、建筑 AABB 14，重排坐标（T06）时需全量回归 |
| `render.calls=1, triangles=1` | **不可信，勿采信** | SwiftShader 下大量 `THREE.WebGLProgram: Shader Error … VALIDATE_STATUS false`（软渲染 shader 校验限制），绝大多数材质未成功编译/绘制 → **draw call 必须在真机/真 GPU 复测**，本轮不将其作为 §6 预算的验收数值 |

**给工程师的纪律**：① 优化前后对比须在**同一软渲染环境**做相对比较（本轮 3.2s/4.5s 为对照基线），绝对 FPS/draw call 由 team-lead 在真机复测；② 稳态 tex 比预热帧多 9 是真实隐患，T01 必须做"稳态基线校准"；③ 那些 Shader Error 是 SwiftShader 噪声，**不是业务 BUG**，不要据此排查材质代码（真机无此问题）。

---

## 6. Anything UNCLEAR（不清楚之处与假设）

1. **【图片】~~需用户补图~~ → 已关闭**：team-lead 已在对话上下文看到三张图并代码级核实根因（§0.2），与我的代码静态定位一致；**不需要 OCR、不需要用户重传**。最终视觉验收由工程师改完后在浏览器截图确认。
2. **【3D 生成技能】**（已定性为**可行**、独立轨道 G0，§5.3）：本轮我只读勘察未实际调用（需 `connect_cloud_service` 凭据 + 联网 1~5 分钟/个）。**能否生成带骨骼动画的角色、风格/面数是否达标，须由 team-lead/工程师在 G0 轨道实测**；方案已按"可能不带骨骼"做保守设计（程序化兜底 + GLB 热替换）。云端不可用时走 §5.3.4 程序化人体升级保底。
3. **【基线数字 / 稳态】** "17/24"是历史快照；实测稳态 tex 比预热帧多 9（§5.12）。**建议**：v4 统一用"稳态基线 B（循环启动后第 3 帧采样）+ 动态 Δ0/0"，不用固定数字；T01 负责校准稳态基线。需 team-lead 确认此口径。
4. **【一体化范围】** 用户 13 项点名了"跑酷除外"要一体化，但未明确**记忆翻牌（MemoryMatch）、烟花观礼台（FireworksDeck）、世纪钟（CenturyClock）**是否也要嵌入。方案按「观赏类（摩天轮/木马/海盗船/过山车/小火车/跳一跳）优先嵌入；玩法类（记忆/跑酷）可保留独立场景，但跳一跳按需求 12 强制嵌入」推进，待 team-lead 向用户确认。
5. **【摩天轮"四处转"】** 需求 5 的"可四处转、欣赏高空大厅美景"理解为"座舱内第一人称 360° 环顾"，非"玩家手动驾驶摩天轮"。若用户想要手动控制旋转，需追加输入设计。
6. **【资产路径】** 若走 glTF 路线，需确认 Vite 静态资源放置（`public/models/` vs `assets/models/` + import URL），会影响 `ModelLoader` 的 url 写法。
7. **假设**：dev server 5173 在跑，工程师可直接硬刷新验证；但按记忆纪律，**改/删被 import 的模块（如删 PumpkinThrower）必须重启 dev server**，否则 HMR 造假 BUG。

---

# Part B：任务分解（Task Decomposition）

## 7. Required Packages（依赖）
**不新增第三方包**（本项目硬约束：不下载外部资源）；全部用现有：
```
- three@^0.187.0：3D 渲染（含 addons: OrbitControls / GLTFLoader / DRACOLoader / Sky / EffectComposer）
- @dimforge/rapier3d-compat@^0.21.0：物理（大厅仍禁用）
- vite@^8.3.6：构建（devDependencies）
- buddy-multimodal-generation（外部技能，非 npm 包）：仅 T10 可选生成 GLB 资产
```

## 8. 任务列表（按依赖与风险排序，分 3 批 · 11 项 T01~T11 + 1 条独立并行轨道 G0）

> 依赖图见 §10。批次内尽量并行，批次间串行。**硬纪律：任何改动先重启 dev server（记忆第 36 行 / V3_HANDOFF:122），每完成一项跑 `npm run build` + 浏览器 Δ0/0 验收。**
> **独立轨道 G0（3D 生成 GLB，§5.3.4）与 T01~T09 全程并行、不占关键路径**：G0 只产出 `public/models/*.glb` + `registerAsset`，代码侧由 T10 的 `loadOrFallback` 默认程序化兜底；G0 慢/失败/质量差 → T10 走保底程序化，批次 1/2 照常验收。详见 §8 批次 3 的 T10 条目。

### 批次 1：快速修复（需求 1 / 2 / 4 / 7 / 9）—— 低耦合，先做，立即见效

**T01 · 冷启动重构：renderOnce 40→5~6 次 + 稳态基线校准 + 懒激活**（需求1 核心方案）`P0`
> **⚠️ 部分已落地（见 §0.4）**：工程师已删 10 设施预热块（`renderOnce` 46→26、`main.js:382-389` 注释确认主链 35→5）、已建 `SceneContext.js` 并 `configure`（`:230-239`）、已加 `prewarm(key)`（`:499`）与 `bootStartedAt`（`:228`）。**本任务只剩 2 件事需补**：① 稳态基线校准；② 后台预热接 `prewarm()`。**不要重做已落地部分。**

- 涉及文件：`src/main.js`、`src/core/scene-context.js`(已建，复核即可)、`src/components/start-screen.js`、`src/utils/helpers/perf-monitor.js`（如需启动打点）
- 改动要点（按 §5.1.1 五手段；已落地项勾选，剩余项标 ⚠️）：
  1. ✅ **删设施预热块**（已落地）：原 `main.js:361-497` 的 10 设施 activate/warmUp/renderOnce/deactivate 已删，`warmupPeak` getter 恒 `null`（`:490-495`）。
  2. ✅ **保留基线帧**（已落地）：冷基线、全局单例 warmUp、Lobby 激活/卸载、正式激活共 5 次 renderOnce（`:382-405`）；`DayNightCycle.warmUp()` 保留防星空首帧缺失（记忆第 14 行坑）。
  3. ✅ **SceneContext**（已落地）：`src/core/scene-context.js`（170 行）已实现并在 `:230-239` configure，语义与方案 A 一致。
  4. ⚠️ **稳态基线校准（待补，本版新增关键项）**：`baseline = readMemory()` 现仍在**预热帧** `main.js:400`。实测预热帧 tex=18 vs 稳态 27（§5.12），固定基线偏低会把后续惰性上传误判为 Δ>0。改为**循环启动后第 3 帧**采样（在 `frameDriver.update` 放一次性 hook），`logMemory` 统一以稳态基线比对；与记忆第 14 行"星空惰性上传致 21→22"同类问题的根治。
  5. ⚠️ **后台设施预热队列（待补）**：新增 `prewarm(key)` 已就位（`:499`）但无人调用。用 `requestIdleCallback`/分帧队列在 `startGameplayLoop()` 后逐个调 `prewarm(key)`（它已实现"结束恢复原激活设施"，不会留空场景），消除首次进入卡顿；预热期间打标记让 `logMemory` 跳过读数，避免与稳态校准竞争。
  6. **StartScreen 文案**：保持 `autoHide:false`，`:110` 提示与实际控制对齐（与 T02 协同）。
- 验收标准：① 用 `bootStartedAt`（`:228`）重测，`boot ms / enter ms` 相对本轮**改动前快照 3.2s / 4.5s 明显下降**（软渲染同环境对比）；② **`baseline` 取稳态帧值**、`5 轮往返 Δgeo=0/Δtex=0`（`logMemory` 打印，且证明预热帧 18→稳态 27 不再误报）；③ 后台预热不阻塞交互、每次 `prewarm()` 后计数回落基线；④ `bootReady` 前点「进入」不黑屏；⑤ `npm run build` 通过。**必须附优化前后三组实测数值**（§5.1.1 末）。
- 依赖：无（起点；已部分实施）。
- 风险：**中低**（主体已完成）。剩余风险集中在稳态采样时机与后台预热的读数竞争 → 用"预热期打标记 + logMemory 跳过"解决。

**T02 · 大厅鼠标 / WASD 控制模式切换** `P1`
- 涉及文件：`src/utils/controls/wasd-controller.js`(新)、`src/core/camera-rig.js`(新)、`src/scenes/lobby-scene.js`、`src/components/start-screen.js`
- 改动要点：新增 `WASDController`（WASD/方向键平移 + 按住拖拽环顾，眼高 1.6m，AABB 碰撞复用 `Lobby._buildingBoxes`）；`Lobby` 增 `_inputMode='orbit'|'wasd'`，`M` 键 + HUD 按钮切换；两者互斥占用相机，切换走 `CameraRig.save/restore`；`:3491` 的 `update` 增加 `if(_inputMode==='wasd') _wasd.update(dt) else _controls.update()`；UI 提示 `:3017/:3019` 与 `StartScreen:31` 同步。
- 验收标准：`M` 键与按钮都能切换；WASD 走动不穿墙（复用 `_buildingBoxes`，且新坐标已由 T06 更新）；切回鼠标后 orbit 机位/目标点不跳变；`dispose` 时监听器成对解绑（防泄漏，参考 `V3_HANDOFF:114`）。
- 依赖：T01（相机/上下文就位）。**与 T06 强耦合**：WASD 碰撞用 `_buildingBoxes`，T06 改坐标后必须回归测试。**与 T05 冲突**：都改 `Lobby.update/dispose`，须串行（见 §9）。
- 风险：**中**。相机双主控易出" dances"（两个控制器互相覆盖），务必用单一 `CameraRig` 仲裁 + `controls.enabled` 闸门。

**T05 · 世纪钟钟面/指针背面镜像修复** `P1`
- 涉及文件：`src/scenes/attractions/century-clock.js`、`docs/screenshots/`(新增验证图)
- 改动要点：背面 disc 独立材质 + `map/glowMap` 水平镜像（§5.4）；背面三针角度取反；`warmUp()`（`:558-563`）覆盖新材质上传路径；保持 `buildClockTower` 被 `Lobby._buildCenturyClockFacade()`（`:2553`）与设施共用同一造型。
- 验收标准：浏览器从钟楼正/背两面看，12/3/6/9 顺序与三针方向一致可读；夜间发光刻度不错位（记忆第 29 行的"白球"坑不复现）；三针与真实时间误差 0（`:368-379` tick）。
- 依赖：**无代码依赖**（仅改 `CenturyClock.js`，可全程与 T01/T02/T06 并行开发；最终验收需 T01 启动链就位）。**与 T02/T06 不冲突**（文件不重叠）。
- 风险：**低**。局部几何修正，改动小；注意 CanvasTexture 的 `flipX` 细节与 `emissiveMap` 同步。

**T06 · 触发环分散 + 点阵字清晰度修复** `P1`
- 涉及文件：`src/scenes/lobby-scene.js`、`src/utils/helpers/facility-textures.js`(新)
- 改动要点：① 重排 `FACILITIES`（`:75-116`）的 `trigger` 坐标使两两 ≥6.5m，新增 `TRIGGER_RADIUS` 常量统一 `disc/ring/光柱/nameplate` 尺寸，加开发期最小间距自检；② 用 `FacilityTextures.js` 的 **CanvasTexture atlas** 替换 `makeTextPixels`（`:461-485`）在 `_buildGate`(`:1831-1852`) 与 `_buildTriggers`(`:2878-2903`) 的调用，texture anisotropy 拉满、关 Bloom 贡献；③ 联动复核 `_exclusionZones`(`:1331`)、`_buildingBoxes`、`_benchZones`、`npcManager.setObstacles` 的新坐标（记忆第 27-28 行长椅/NPC 坑）。
- 验收标准：俯瞰大厅任意两触发盘**无交叠**（浏览器截图 + 代码自检 0 告警）；文字在 1080p 清晰可读、无橙色糊团；`memory.textures` 因 atlas 只 +1（更新基线口径）；长椅 ≥7 张、NPC 不在 AABB 内卡住（记忆第 27/28 行回归项）。
- 依赖：T01。**与 T02/T05 冲突**（都改 `Lobby.js`），**必须串行**：建议 T05（独立文件）→ T06（集中改 Lobby）→ T02（再改 Lobby）。
- 风险：**高**（批次 1 最高）。坐标牵一发动全身（建筑/围栏/树/长椅/NPC/拾取/AABB），且 atlas 改基线口径。**建议把 6a 坐标、6b 文字拆成两个 commit 分别验收**。

### 批次 2：真实一体化（需求 5 / 10 / 11 / 12）—— 架构核心，风险最高

**T03 · 一体化基座：SceneContext + FacilityRuntime + IEmbeddedView + CameraRig** `P0`
- 涉及文件：`src/core/scene-context.js`(T01 已建，本任务完善)、`src/core/facility-runtime.js`(新)、`src/core/camera-rig.js`(T02 已建，本任务增强 blend/restore)、`src/main.js`、`src/utils/helpers/day-night-cycle.js`
- 改动要点：
  1. `FacilityRuntime` 持有常驻动效列表 + 嵌入式视图注册表；由 `frameDriver.update`（`main.js:323-330`）每帧驱动（**零 core 改动**，沿用 v3 包装对象手法）。
  2. 定义 `IEmbeddedView` 契约（§3）；`Lobby` 常驻不 dispose，`enter` 只切 `CameraRig` + 懒挂 `propsRoot`。
  3. `main.js` 的 `onEnterAttraction/onExitAttraction`（`:256-289`）改为：嵌入式设施走 `FacilityRuntime.activateRide/deactivateRide`，**不再 `attractionManager.activate/deactivate` Lobby**；非嵌入设施（跑酷/记忆）保留原路径。
  4. `DayNightCycle.setContext()`（`:370-392`）白名单加入所有嵌入 key，保证同一天空/光照连续。
- 验收标准：进入/退出嵌入式设施时 `scene.children` 的 Lobby 根节点不消失；昼夜/时间/天气连续不闪；相机过渡 0.8s 平滑（复用 `Lobby._sitDown` 的 smoothstep 手法 `:3127-3173`）；Δ0/0；`npm run build` 通过。
- 依赖：T01、T02（相机仲裁）、T06（坐标稳定后再定锚点）。
- 风险：**高**。这是全局接线改动，必须先在`Lobby` 一个设施上打通"进入=换相机"的最小闭环，再批量接入其它设施。

**T04 · 摩天轮重写：FerrisWheel（替代 PumpkinThrower）** `P0`
- 涉及文件：`src/attractions/FerrisWheel.js`(新)、`src/scenes/attractions/pumpkin-thrower.js`(下线/改造)、`src/main.js`、`src/scenes/lobby-scene.js`(`_buildPumpkinWheel` 复用轮盘)
- 改动要点：实现 `IEmbeddedView`；座舱公转 + 自反转保持水平；第一人称座舱内 360° 环顾看大厅；删除投篮/金币/计分/命中预热（`main.js:371-382` 预热块、`:340` 注册）；`FACILITIES[0].label` 与 UI 改为"南瓜摩天轮"名实相符；`dispose` 幂等且只释放自有资源（共享轮盘不 dispose）。
- 验收标准：进入后看到的是同一个大厅（城堡门/世纪钟/过山车/NPC/天空），不是独立场景；座舱水平；轮盘持续转；离开回大厅 Δ0/0；无投篮/金币 UI 残留。
- 依赖：T03。风险：**中**（运动学与相机跟随需实测防眩晕；座舱自反转角度 = -公转角）。

**T07 · 旋转木马 / 海盗船 / 小火车 嵌入 + 常驻动效（需求 10/11）** `P0`
- 涉及文件：`src/attractions/embedded/CarouselEmbedView.js`(新)、`src/attractions/embedded/PirateShipEmbedView.js`(新)、`src/scenes/attractions/carousel.js`、`src/scenes/attractions/pirate-ship.js`、`src/scenes/attractions/train-ride.js`、`src/scenes/lobby-scene.js`、`src/core/facility-runtime.js`
- 改动要点：
  1. 把 `Carousel/PirateShip` 的**模型构建**抽成共享 `buildXxxMesh(scale)`（呼应 `docs/v3-spec.txt:173` 方案 A），大厅外观（`Lobby._buildM9Facades:2628-2748`）与设施内用**同一套模型**（视觉一致）。
  2. 常驻动效：木马 `this._carousel.rotation.y += ROTATE_SPEED*dt`（复用 `Carousel.js:754`）、海盗船钟摆 `angle = A*sin(ωt)`、小火车沿站台短轨循环 —— 全部在 `FacilityRuntime.update` 里改属性，**不新建资源**（`Lobby.js:805-807` 纪律）。
  3. 进入 = `CameraRig.blendTo` 到座位/船体机位，看到大厅；退出归还。
  4. `TrainRide` 的轨道曲线抽成导出常量，供大厅 `COASTER`(`:124-134`) 与设施共用（为 T08 挂轨小车铺路）。
- 验收标准：大厅里三设施**持续动**（非静止）；进入看到同一大厅；draw call 增量 ≤ 各 1~4 个 InstancedMesh；Δ0/0；无资源重复持有（共享 geometry 只一份）。
- 依赖：T03、T06（坐标）。**T08 依赖本任务**（本任务先把 `TrainRide` 轨道曲线抽成导出常量，T08 才能复用）。风险：**高**（模型抽取涉及 `dispose` 归属，避免双重 dispose —— `docs/v3-spec.txt:174` 方案 B 警告）。

**T08 · 跳一跳嵌入 + 过山车小车挂轨（需求 11/12）** `P0`
- 涉及文件：`src/components/embedded-views/jump-jump-embed-view.js`(新)、`src/scenes/attractions/jump-jump.js`、`src/scenes/attractions/train-ride.js`、`src/scenes/lobby-scene.js`、`src/core/facility-runtime.js`
- 改动要点：
  1. `JumpJumpEmbedView`：**去掉独立的 `_buildSky`(`:115,135-146`)/`_buildGround`(`:116,156`)/背景雾改写(`:112-113`)**，改为复用大厅 `scene.background/fog/Sky/方向光`，只在大厅一块空地（重排后的 jump 区）铺方块池；相机机位在大厅跳跳区。
  2. `CoasterCarRuntime`：复用 `COASTER` 曲线，`_placeTrain` 同款 `getPointAt/getTangentAt/makeBasis`（`TrainRide.js:693-705`），`t=0` 即贴轨；2~3 节车厢；常驻更新。
  3. 挂轨小车加入 `FacilityRuntime` 常驻列表。
- 验收标准：跳一跳背景是大厅（不是独立天幕/地砖）；过山车小车**全程贴轨、无悬空起始段**（截图/录屏验证 t=0 与整圈）；24 点曲线与大厅轨道一致；Δ0/0。
- 依赖：T03、T07（曲线共享）。风险：**中高**（跳跃玩法依赖地面高度/碰撞，接入大厅地形后要重调 `_resetGame` 与相机 `snapCamera`）。

### 批次 3：资产与比例（需求 3 / 6 / 8）—— 视觉提升，后做

**T09 · 豪华城堡大门 + 建筑整体放大（需求 6/8）** `P1`
- 涉及文件：`src/scenes/lobby-scene.js` (`_buildGate:1806-1860`、`_buildM9Facades:2628-2748`、`_buildPumpkinWheel:1866-1930`、`_buildTrainStation:2208-2296`、`_buildingBoxes`)、可选 `assets/models/lobby-gate.glb`
- 改动要点：城堡门楼（尖拱+双塔+城垛+纹章，全用 `_shared`）；海盗船/木马/摩天轮/站台外观 `group.scale.setScalar(1.3~1.6)`；**同步放大 AABB / `_pickProxy` / 触发环间距**（回到 T06 的 ≥6.5m 约束复核）；可选 `ModelLoader` 接入 `lobby-gate` glTF（P1）。
- 验收标准：大门为城堡风格（截图对比）；海盗船明显更大；放大后设施仍不重叠、碰撞/拾取与新尺寸一致；`render.calls ≤120`、三角面 ≤300,000；Δ0/0。
- 依赖：T06（坐标）、T07（共用模型）。风险：**中**（放大后易再次重叠/穿模；AABB 忘改会导致"看得见撞不到"）。

**T10 · 人物建模升级（需求 3）—— 程序化保底主线 + 独立轨道 G0（AI 生成 GLB）** `P2`
- 涉及文件：`src/utils/helpers/procedural-character.js`(新)、`src/utils/helpers/npc-manager.js`、`src/scenes/attractions/jump-jump.js`(`_buildPlayer:253-264`)、`src/scenes/attractions/parkour-run.js`(`_buildPlayer:321+`)、`src/utils/loaders/model-loader.js`（接线，通常无需改）、`public/models/*.glb`（G0 产出）
- 改动要点：
  1. **保底主线（无资产，必做）**：`buildCharacter({style,rig})` 按 7~7.5 头身真实比例拼躯干/两段式四肢/五官/头发/服装（`LatheGeometry` 裙摆、`MeshPhysicalMaterial` 区分布料/皮革/金属），NPC 用 `InstancedMesh` + `instanceColor` 保 **≤2 draw call**（`NPCManager.js:7-10`、`docs/v3-spec.txt:248`），程序化走路/挥手/呼吸驱动复用 4 态状态机（`:37`）；玩家模型跳一跳/跑酷复用同款。这是**云端不可用/质量不达标时的默认交付**（§5.3.4）。
  2. **接线（为 G0 预留，零阻塞）**：所有可能替换的建模点统一走 `modelLoader.loadOrFallback(url, () => buildXxxMesh(scale))`（`ModelLoader.js:101-116`）——**默认程序化**，`registerAsset` 后才走 GLB；资产放 `public/models/<key>.glb`（Vite 静态目录），`createLOD` 做高/中/低三档，面数 ≤3 万/个、材质槽 ≤3~4、`--enable-pbr`（§5.3.2）。
  3. 保持 `NPCManager` AABB 避障（`:14-24`）与 >45m 暂停（`:33`）不退化；GLB 角色若破坏 2 draw call（10 个独立 GLB）则**只让迎宾 2 人用 GLB、其余 8 人保程序化**（§5.3.1 红线）。
- **独立轨道 G0（团队级并行，不占批次1/2 关键路径）**：由 team-lead/工程师按 §5.3 生成 ①P0 `carousel/pirate-ship` → ②P1 `lobby-gate`(城堡门,服务需求8)/`century-clock` → ③P3 `coaster-car` → ④人物验证 1 主角+2 NPC 变体。每步：`connect_cloud_service` 取 token → 脚本 `3d ... --enable-pbr --face-count 20000` → 轮询 1~5 分钟 → 下载 GLB → model-viewer 预览 → 放入 `public/models/` + `registerAsset` → 浏览器验收面数/风格/基线。**G0 失败或质量差 → 直接走 T10 保底程序化，不影响批次1/2 验收**。
- 验收标准：人物明显更真实（头发/四肢/表情可辨）；NPC 仍 ≤2 draw call、10 NPC 60fps（真机）；无 GLB 时零 404/CORS；GLB 就绪后热替换无 Δ 泄漏（计入稳态基线 B）；Δ0/0。
- 依赖：T06（坐标/NPC 障碍稳定）、T09（比例协调）；**G0 可与 T01~T09 全程并行**，其产出是 T10 的"可选增强"而非前置。风险：**中**（程序化复杂度 vs 性能；GLB 技能不确定性须实测，不得口头承诺"生成即可动"）。

**T11 · 全量验证与交付（需求 13）** `P0` ·（跨批次收尾任务）
- 涉及文件：`docs/screenshots/`(新增)、`docs/v4-refactor-plan.md`(回填实测数值)、`npm run build`
- 改动要点：硬刷新 / 重启 dev server → 逐条跑 13 项验收 → 5 轮进入/返回 Δ0/0 → 记录 `render.calls/triangles/memory` → 截图归档 → 更新文档实测值。
- 验收标准：13 项全部通过；无 pageerror；基线 Δ0/0；`render.calls ≤120`（大厅）/≤200（设施）、三角面 ≤300,000、中端笔记本 ≥55fps（或注明软渲染环境限制）。**全部通过后才向用户汇报**（需求 13）。
- 依赖：T01~T10 全部。风险：**低**（但软渲染环境 FPS 不可直接当真机结论，需注明）。

## 9. 任务冲突矩阵与串行要求（工程师必读）

| 冲突点 | 涉及任务 | 性质 | 处理 |
|---|---|---|---|
| **Lobby.js 写入冲突** | T02 / T05(仅外文件) / T06 / T07 / T08 / T09 | **同文件多处改** | **严格串行**：T05(独立 CenturyClock) → **T06（集中改 Lobby：坐标+文字）** → T02（WASD） → T03 基座 → T07/T08（Lobby 常驻动效/外观） → T09（大门+放大）。任何时候只允许一个任务在写 `Lobby.js`。 |
| **坐标依赖链** | T06 → T02 / T07 / T09 / T10 | 数据依赖 | T06 必须最先完成并冻结 `FACILITIES` 坐标；其后所有碰撞/锚点/放大/长椅/NPC 才能定。 |
| **启动优化 vs 懒加载** | T01 ↔ T03/T04/T07/T08 | 语义耦合 | T01 删预热后，设施资源转由 `FacilityRuntime` 懒加载；T03 基座必须与 T01 同批落地，否则首次进入卡顿。 |
| **模型归属/dispose** | T07 ↔ T09 | 重复建模 | `buildXxxMesh` 抽取（T07）先于放大（T09）；共享 geometry **只能 Lobby 持有并 dispose**，EmbedView 只 dispose 自有（呼应 `docs/v3-spec.txt:174` 方案 B 警告）。 |
| **相机双主控** | T02 ↔ T03/T04/T07/T08 | 逻辑冲突 | `CameraRig` 是唯一仲裁；`OrbitControls`/`WASDController`/`CameraRig.blendTo` 三者同一时刻只有一个 `enabled`。T02 先立规矩，T03+ 遵守。 |
| **基线口径变更** | T01 / T06(atlas) / T09(glTF) / T10 | 验收口径 | 需 team-lead 确认"动态 Δ0/0"新口径；atlas/glTF 新增资源**计入大厅基线 B**，不在切换增量里。 |
| **dev server HMR** | 全部（尤其 T04 下线 PumpkinThrower） | 环境 | 删/改被 import 的模块后**必须重启 dev server**（记忆第 36 行、V3_HANDOFF:122）；否则假 BUG。 |
| **需求 6 放大 vs 需求 7 分散** | T06 ↔ T09 | 目标冲突 | 先 T06 重排留出 ≥6.5m 余量，再 T09 放大并复查；放大系数上限由"放大后仍 ≥6.5m"反推。 |

**推荐串行主干**（风险从低到高、依赖从少到多）：
`T05`（独立，可并行） ⟶ **`T01` → `T06` → `T02` → `T03` → `T04` → `T07` → `T08` → `T09` → `T10` → `T11`**
其中 T05 可与 T01/T06 并行；T04 与 T07 在 T03 完成后**可并行**（不同设施文件）；T09 与 T10 在 T06/T07 后**可并行**（大门 vs 人物）。

## 10. Task Dependency Graph（Mermaid）

```mermaid
graph TD
    T01[T01 冷启动重构 40→5~6次renderOnce+稳态基线 批次1 P0] --> T06[T06 触发环分散+点阵字 批次1 P1]
    T01 --> T02[T02 鼠标/WASD切换 批次1 P1]
    T05[T05 世纪钟镜像修复 批次1 P1]:::indep
    T06 --> T02
    T06 --> T03[T03 一体化基座 批次2 P0]
    T02 --> T03
    T03 --> T04[T04 摩天轮重写 批次2 P0]
    T03 --> T07[T07 木马/海盗船/小火车嵌入 批次2 P0]
    T07 --> T08[T08 跳一跳嵌入+过山车挂轨 批次2 P0]
    T06 --> T09[T09 城堡大门+建筑放大 批次3 P1]
    T07 --> T09
    T06 --> T10[T10 人物建模升级(保底主线) 批次3 P2]
    T09 --> T10
    T04 --> T11[T11 全量验证交付 P0]
    T08 --> T11
    T10 --> T11
    G0["G0 独立轨道(全程并行,失败则T10保底): AI生成GLB carousel/ship/gate/clock/car/角色"]:::track -.registerAsset热替换.-> T10
    G0 -.可选增强.-> T09
    classDef indep fill:#e8f5e9,stroke:#2e7d32;
    classDef track fill:#f3e5f5,stroke:#6a1b9a,stroke-dasharray: 4 3;
    style T01 fill:#fff3e0,stroke:#ef6c00
    style T03 fill:#ffebee,stroke:#c62828
    style T11 fill:#e3f2fd,stroke:#1565c0
```

## 11. Shared Knowledge（横切约定，工程师必守）

1. **契约不推翻**：`IAttraction` 四方法 + `AttractionManager` 的 `dispose→disposeAll→scene.remove` 顺序（`AttractionManager.js:11-16,107-147`）**保持不变**；v4 用"实现 `IAttraction` 的同时实现 `IEmbeddedView`"做增量。
2. **唯一世界**：全程**一个 `scene`**；大厅 `worldRoot` 常驻；进入设施只切 `CameraRig` + 懒挂 `propsRoot`，**禁止**再 `new THREE.Scene()` / 改 `scene.background/fog` / 自建天幕地面（这是割裂的根源，§5.10）。
3. **资源归零 Δ0/0**：`renderer.info.memory.geometries/textures` 在"进入→离开"后回落大厅基线（`main.js:20-24,508,528`）；**基线须取"稳态帧"**（循环启动后第 3 帧，实测预热帧 tex 比稳态少 9 张，§5.12/§5.1.1⑤）；`dispose` 幂等（`_disposed` 锁，`IAttraction.js:54-55`）；ShaderMaterial.uniform 里的 Texture 也要递归释放（`IAttraction.js:43-48`）。**实测锚点**：现有契约 lobby→carousel→lobby 往返 `30/28 → 21/20 → 30/28` 完全回落（§5.12），方案 A 必须保住。
4. **update 零新建**：任何 `update(dt)` 里**绝不**新建 geometry/material/texture（`Lobby.js:805-807`），否则首次上传发生在预热后 → "游戏中途假泄漏"。
5. **物理独占**：`world.step()` 只由 `PhysicsManager.step()` 在 `SceneManager.js:250` 调用；设施/大厅禁止自行 step；大厅继续禁用 Rapier，NPC/AABB 避障沿用。
6. **dt 钳制**：所有 `update` 用 `Math.min(Math.max(dt,0),0.1)`（如 `Lobby.js:3488`）；暂停由 `SceneManager._paused`（`:178-196`）统一闸门，设施内用 `ctx.isPaused()` 防御（如 `CenturyClock.js:532`）。
7. **色彩管线**：`EXPOSURE_COMP=0.38`（`SceneManager.js:49-51`）线性预乘 + OutputPass ACES；任何无 lit 颜色要 ×0.38（`Lobby.js:1000`）；Sky.js 用 `uSkyTint/uSkyBrightness` uniform（`Lobby.js:1169-1178`）交给昼夜系统 lerp。
8. **灯光单一来源**：只有 `SceneManager` 的三盏常驻灯（`:117-140`）；设施不自建第二盏投影光（`Lobby._buildLights:2913-2919` 已弃用自建）；昼夜 `setContext` 白名单决定天空是否显示（`DayNightCycle.js:370-392`）。
9. **性能预算**：大厅 `render.calls ≤120` / 设施 ≤200 / 三角面 ≤300,000 / ≥55fps（`docs/v3-spec.txt:21`）；重复对象用 `InstancedMesh`；远景用 `DetailLOD` 暂停动画（`Lobby.js:3399-3403`）；`QualityTier` 移动端降级（`SceneManager.js:84-89,163-167`）。
10. **验证纪律**：改/删被 import 模块**重启 dev server**；运行时结论必须真跑浏览器；软渲染 dt clamp 0.1 → 过渡类验证等 4~5 秒墙钟；指针/时间类用同一 Date 同步 tick（记忆第 36-39 行）。
11. **3D 生成技能（独立轨道 G0）纪律**：G0 与 T01~T09 全程并行、不占关键路径（§5.3.4）；`connect_cloud_service` 取 `clientTempToken` 不缓存不外泄；脚本默认输出 GLB+OBJ，下载全部 `result_files` 到本地后 `present_files` 展示（优先 GLB）；**不得承诺"生成即可带骨骼动画"**；每个 GLB 面数 ≤3 万、材质槽 ≤3~4、`--enable-pbr`、统一低模童话风格；资产经 `modelLoader.registerAsset` 热替换，`loadOrFallback` 保证失败/未就绪时走程序化；面数/风格/基线任一不达标 → 回退 `ProceduralCharacter.js` 保底。

---

## 12. 需 team-lead 向用户澄清的问题（不阻塞，先按本方案开工）

1. ~~**补三张截图**~~ **已关闭**：team-lead 已在对话上下文看到三张图并代码级核实根因（§0.2），与代码静态定位一致；不需 OCR、不需用户重传。最终视觉验收由工程师改完在浏览器截图确认。
2. **一体化范围**：除点名的摩天轮/木马/海盗船/过山车/小火车/跳一跳外，**记忆翻牌、烟花观礼台、世纪钟**是否也要"大厅内一体化"？（本方案默认：观赏类全嵌入，玩法类记忆/跑酷保留独立场景，跑酷按用户要求除外。）
3. **摩天轮"四处转"**：是"座舱内 360° 环顾看风景"（本方案假设）还是"玩家手动控制摩天轮旋转"？
4. **人物 3D 生成（已定性可行，需定范围）**：G0 独立轨道已定为"地标/设施 GLB 优先（P0 木马/船、P1 城堡门/世纪钟、P3 车厢），人物先验证 1 主角+2 NPC 变体"，程序化为保底。需 team-lead 定：① 是否批准 G0 轨道调用 `connect_cloud_service`（联网 1~5 分钟/个）；② 人物风格（低模/卡通/写实）；③ 接受"生成模型可能无骨骼动画、走路/挥手仍需程序化驱动"。若云端不可用 → 自动走 `ProceduralCharacter.js` 保底，无需用户决策。
5. **基线口径**：v4 验收用"固定 17/24"还是"稳态大厅基线 B + 动态 Δ0/0"？（本方案强烈建议后者：实测预热帧 tex=18 vs 稳态 27，固定数字会误判泄漏，§5.12/§5.1.1⑤。）
6. **建筑放大倍数**：海盗船/木马"按真实大小"的目标尺度是多少？本方案先按 `1.3~1.6×`，需用户/主理人确认观感。
7. **draw call / 真机性能**：本轮 SwiftShader 软渲染 shader 校验失败，`render.calls=1` 不可信（§5.12）。请 team-lead 在真机复测大厅/设施 draw call、三角面与 FPS，对照 `docs/v3-spec.txt:21` 预算（≤120/≤200/≤30 万面/≥55fps）。

---

> 文档结束。工程师可直接按 §8 的 T01~T11 + 独立轨道 G0 与 §9 串行主干开工；每完成一项回写实测数值到 §5.11/§5.12 与 §12。所有"根因"均附文件行号，可直接 `code` 定位。
