# v4 真实一体化重构 —— 收官状态与交接（2026-11-11 19:45 更新）

## TL;DR（最终，结论以本节为准）
**13 项需求全部实现并真机验收通过：`13 PASS / 0 FAIL / 0 SKIP`**。`npm run build` 通过（1.16s），`PORT=5177 node tests/verify-v4.mjs` 全量验收 15 张截图全唯一 hash，`0 pageerror / 0 console.error / 0 consoleWarning / 0 404 / 0 failedRequest`。5 轮往返稳态 Δgeo=0 / Δtex=0（62 geo / 30 tex），全场景 253,676 三角面（≤30 万预算）。

本轮收官补齐 T08（过山车挂轨 + 跳一跳嵌入接线）、T09（城堡门楼 + 建筑放大），并修正验收脚本 3 处口径错误。下方 429 与分期状态为**历史记录**，勿据此判断当前进度。

## 收官修订（本轮新增，勿回退）
1. **产品接线**：`Lobby.js` import `CoasterCarRuntime`；`_buildCoasterTrack()` 用 `this._coasterCurve` 实例化（`carCount=3, period=42`）并 `init(this.root)`；`_updateAnimations()` 用 `lodOn('coaster')` 门控 `update(dt)`；`dispose()` 配对释放。`main.js` 把 `JUMP_JUMP_KEY` 加入 `EMBEDDED_KEYS`、注册 `JumpJumpEmbedView` 与 `dayNightCycle.registerEmbeddedContext`。`CoasterCarRuntime` 新增 `getCarT(index)` 与 `root.userData.runtime` 供探针读取（原脚本引用的 `getCarT` 此前并不存在）。
2. **T09 城堡门 + 放大**：`_buildGate()` 增哥特尖拱（`gate-arch-*`）、双塔（`gate-tower-*` + 锥顶）、城垛（`Lobby/gate-crenels` InstancedMesh）、纹章；全部复用 S 共享资源、**门洞 AABB 不动**。海盗船/木马 `group.scale=(1.25,1.35,1.25)`、站台 `(1.2,1.3,1.2)`，AABB 同步（3.4→4.25；5.3→6.36、3.0→3.6）。**摩天轮轮组禁止整体 scale**（`FerrisWheelEmbedView` 硬编码 5.4/8.2 锚点，放大会让玩家坐到座舱外），只放大基座。触发环是独立对象、坐标不动 → 第 7 项 7.0m 间距与自检 0 告警保持。
3. **验收脚本 3 处口径修正（都是脚本没跟上新架构，不是产品缺陷，勿据此改业务代码）**：
   - **③ 玩家模型**：`jump-jump` 改走嵌入视图后，玩家在 `facilityRuntime.activeView._player`（`buildCharacter` 返回的 `group.userData.rig`），不在旧的 `attractionManager.active._playerMesh`。脚本按 `EMBEDDED_KEYS` 分流读取，`rig/head/四肢/关节` 校验强度不变。
   - **⑬ 基线**：app 的 `baseline` 是「大厅稳态」，不含设施首次激活时惰性上传的 GPU 资源；嵌入视图按设计常驻（`_views` 缓存、deactivate 不 dispose），首次进入一次性 +20 geo 后 5 轮完全持平 —— 是一次性初始化，**不是泄漏**。脚本改为「先预热遍历一轮 → 取 steady 基线 → 再跑 5 轮 Δ0/0」，并把惰性增量留作 optional 信息项。
   - **① 软渲染耗时**：`bootMs` 在 headless SwiftShader 下不可信；原标 WARN 会把整项拖成 WARN，且与「不判产品 FAIL」的注释自相矛盾。改标 optional SKIP，产品指标看「点击→可玩」与冷启动 renderOnce 计数。
4. **⑧ 截图证据**：⑦ 俯瞰截图后只恢复 `camera.up`、没恢复 `position`，导致 ⑧ 沿用 (0,72,0.01) 俯瞰机位、与 07 逐字节相同。⑧ 现显式摆正对大门的近景机位 `(0,8.5,34) → lookAt(0,8.5,15)`，拍完还原大厅常规机位。修后 15 张截图全唯一、0 consoleWarning。

## 【历史记录，已恢复收官】⚠️ 两位工程师因 429 限流失败（2026-11-11）
- `software-engineer-2`（T01 冷启动 / T03 一体化基座 / T04b 摩天轮接入）运行 89 分钟后 `429 too many requests` 失败。**但这些任务此前均已单独回报验收全绿**。
- `software-engineer-4`（T06 触发环 / T02 WASD / T04b-c 真摩天轮 / T07 常驻动效）运行 47 分钟后同样 429 失败。**前三项已单独验收全绿；T07 代码已完整落盘但工程师未能回报验收数据**。
- 429 是可恢复的限流错误，非代码错误。失败前写入的代码均已在磁盘、`npm run build` 通过。
- **不得把失败工程师的工作当作"已验收完成"**。T07 当前状态 = 代码落盘 + build 通过，但真机验收（逐帧动效数据 / 截图 / 5轮Δ0/0）缺失。

## 13 项需求状态（最终验收报告 `docs/screenshots/v4-final-verification.json`：13 PASS / 0 FAIL / 0 SKIP）
| 需求 | 状态 | 证据 |
|---|---|---|
| 1 启动慢 | ✅ PASS | 冷启动主链路 renderOnce 35→3；点击→可玩 509ms（软渲染 boot 耗时不可信，见收官修订 3） |
| 2 WASD/鼠标 | ✅ PASS | M 键切换、位移 7.2m、切回位置跳变 0m、不穿 AABB |
| 3 人物真实 | ✅ PASS | NPC 1 draw call、10 NPC/4态/2迎宾、minDist 2.875m、穿墙 0、2,478面/人；跳一跳嵌入玩家 rig/head/四肢/关节全 true；3D 生成技能实测 33MB/0骨骼/Q版群像 → 不接入，走程序化 7.3 头身 |
| 4 钟面反了 | ✅ PASS | 真因是 CylinderGeometry 端盖 UV 随 rotation.x=π/2 整体转 90°（非镜像）；UV 校正 π/2；三针误差 0；夜间 pureWhiteRatio=0 |
| 5 真摩天轮 | ✅ PASS | `ferris-wheel` 嵌入，Lobby 根节点常驻、复用同一 `Lobby/wheel-spin`；10 个真座舱吊篮恒水平；锚点误差 0；无投篮/金币 UI |
| 6 建筑放大 | ✅ PASS（本轮 T09） | 海盗船/木马 scale=(1.25,1.35,1.25)、站台 (1.2,1.3,1.2)，AABB 同步；过山车小车全程贴轨 maxGap=0、Δt=0.0238 |
| 7 触发环分散 | ✅ PASS | 9 环最小间距 7.00m ≥6.5、自检 0 告警、俯瞰无交叠（放大后仍保持） |
| 8 城堡大门 | ✅ PASS（本轮 T09） | hasArch=true、towers=8、crenels=1；尖拱/双锥塔/城垛/纹章齐全；截图 `v4-final-08-castle-gate.png` 为正面近景 |
| 9 文字清晰 | ✅ PASS | 2048² atlas、orange=0、edgeDensity=0.086、纹理只 +1 |
| 10 场景一体化 | ✅ PASS | 嵌入态 `activeKey==='lobby'` + Lobby 根节点仍在 scene + 复用共享轮盘 |
| 11 设施动起来 | ✅ PASS（本轮 T08） | carousel/pirate/train/coaster 四项全 true；过山车小车已挂同一曲线、贴轨误差 0 |
| 12 跳一跳嵌入 | ✅ PASS（本轮 T08） | 已注册 embedded key；`lobbyInScene=true`、`activeKey=lobby`、`independentSky=false`、`independentGround=false`、方块池挂大厅 |
| 13 全量验证脚本 | ✅ PASS | 5 轮 Δgeo=0/Δtex=0（steady 62/30）、253,676 三角面、15 张截图全唯一 hash、0 报错 |

## 已落盘的关键代码（19 新文件 + 若干修改）
- core：`SceneContext.js`(170) / `CameraRig.js`(356) / `FacilityRuntime.js`(284) / `WASDController.js`(277)
- embedded 契约/视图：`IEmbeddedView.js`(148) / `DemoEmbedView.js`(87) / `FerrisWheelEmbedView.js`(290) / `JumpJumpEmbedView.js`(592)
- utils：`DayNightCycle.js`(716) / `ParticleSystem.js`(599) / `NPCManager.js`(389) / `FacilityTextures.js`(242) / `ProceduralCharacter.js`(812) / `CoasterCarRuntime.js`(483)
- 设施：`FireworksDeck.js`(547) / `CenturyClock.js`(642)
- 测试/文档：`tests/verify-v4.mjs`(1087) / `docs/v4-refactor-plan.md`(632) / `docs/v4-lobby-final-spec.md`(148) / 本文件
- 修改：`main.js`(862) / `Lobby.js`(~4300) / `DayNightCycle.js` / `StartScreen.js` / `JumpJump.js` / `ParkourRun.js`

## 剩余工作：无（已收官）
原 T07 补验 / T08 接线 / T09 城堡门+放大 / 全量重跑 已在本轮全部完成，最终 `13 PASS / 0 FAIL / 0 SKIP`，详见文首「收官修订」。

后续若再改动，**仍须严守**：同一时刻只允许一个任务写 `Lobby.js`；放大摩天轮轮组前必须先同步 `FerrisWheelEmbedView.js` 的 `5.4 / 8.2` 锚点常量并重验 ⑤⑩；改嵌入设施生命周期后要复核 ⑬ 的「预热遍历 → steady 基线」口径。

## 已踩过的坑（新工程师必读，详见 .workbuddy/memory/2026-11-11.md）
1. **dev server 端口隔离**：多人并行各用独立端口（5175/5176/5177/5178/5179/5182），禁止 kill 别人的进程。改/删被 import 的模块后必须重启自己的 dev server。
2. **HMR 竞态**：多人改文件触发 Vite 整页 reload 打断 Playwright 长跑 → 用 `vite build --outDir .tmp-xxx/dist` + `vite preview --outDir ...` 静态快照验收。
3. **HMR 双单例**：`import('/src/core/camera-rig.js')` 裸路径会建第二个单例（应用实际加载 `?t=<timestamp>`），读到 owner=null 假象 → 所有状态探测走 `window.__playground` 真实单例。
4. **截图会撒谎**：`page.screenshot()` 在 SwiftShader 下可能拍到开始页/旧帧 → 同一 evaluate 内 `renderOnce()` + `canvas.toDataURL()`；每张图算 md5，重复即标 `screenshotDuplicate`。T17 修后 15 张全唯一。
5. **软渲染 rAF 节流**：1.5s 墙钟仅推进 0.012s 模拟时间 → 用受控 dt（脚本的 `drive(frames,dt)` / `active.update(0.1)`）驱动状态机，不用墙钟采样；软渲染的启动耗时/帧率不可当真机结论。
6. **draw call 口径**：`renderer.info.render.calls` 经 EffectComposer 后恒为 1（只读到最后全屏 pass）→ 用结构盘点（Mesh/InstancedMesh 数）证明开销。
7. **cameraRig 唯一驱动点**：`main.js frameDriver → facilityRuntime.update → cameraRig.update(dt)`；Lobby 不得再每帧调（T02 已修，只留 dispose 时一次性 `update(1e6)`）。
8. **后台预热不能卸大厅**：嵌入态（坐摩天轮）时 `startBackgroundPrewarm` / `prewarmFacility` / `onReactivate` / `onDeactivate` 四条路径都要守卫（T04b 已修）。
9. **双 key 兼容**：大厅 `FACILITIES[0].key='pumpkin-thrower'` 不变，main.js `TRIGGER_KEY_ALIASES={'pumpkin-thrower':'ferris-wheel'}` 归一化；旧 PumpkinThrower.js 保留（用户"不要删除不该删的"）。

## 工程判断记录（避免重复踩）
- **一体化方案 A**（双层契约 IEmbeddedView + 相机即视图）胜出：Lobby 常驻、唯一 scene、设施禁改 background/fog、相机仅 blend 姿态；跑酷/记忆保留独立场景（用户"跑酷除外"）。否决方案 B（Lobby 吞并玩法单场景，推翻契约且 3778 行 Lobby 不可维护）。
- **T07 不抽模型**：不把 Carousel.js/PirateShip.js 的 600 行 init 抽成 buildXxxMesh 共享函数——用户要"场景连续、还在大厅里"，不是"两个地方同一个模型"；大厅是远景装饰、设施内是近景可骑乘，本就该不同。
- **3D 生成技能**（buddy-multimodal-generation）实测可用（产出 GLB）但不适合接入：33MB/0骨骼/Q版群像，击穿 NPC≤2 draw call 与首屏体积；走程序化 7.3 头身主线。GLB 存档在 assets/models/ 但未被任何源码 import，dist 仍 6.6MB。
- **验收报告必须逐条判断"产品 bug vs 脚本 bug"**：T17 首跑 5 FAIL 中 4 个是脚本自身问题（截图雷同/取错对象/minDist=Infinity/测试顺序污染），已修；不可直接采信 FAIL 派修业务代码。

## 启动与验证
- dev server：`cd /d/playground-mvp && npm run dev`（默认 5173）；多人时 `-- --port 517x --strictPort`
- 构建：`npm run build`
- 全量验收：`PORT=5176 node tests/verify-v4.mjs`（约 6~9 分钟；退出码 FAIL>0 或 fatal 返回 1）
- 验收产物：`docs/screenshots/v4-final-*.{png,jpg}` + `docs/screenshots/v4-final-verification.json`
