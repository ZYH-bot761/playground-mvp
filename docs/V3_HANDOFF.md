# 游乐园项目 v3 进度与问题交接（2026-11-09）

> 本文档供「切换模型继续修改」使用。前一个模型因无法在浏览器内运行验证，且用户反馈"打开就是跑酷/点不开/乐园没了"，
> 用户决定换模型。本文件尽量用**可验证的事实 + 具体代码位置 + 复现步骤**描述现状，避免下一个模型凭空猜测。

---

## 一、项目基本信息（必读）

- **技术栈**：Three.js r187 + Rapier3D compat 0.21.0 + Vite 8.3.6，原生 ESM，无框架。
- **入口**：`src/main.js`（单入口，async `bootstrap()`）。
- **设施契约**：`src/attractions/IAttraction.js`（`init/update/onInteract/dispose`，无 enter/exit；进出由 `main.js` 的 `onEnterAttraction/onExitAttraction` 回调处理）。
- **设施管理**：`src/attractions/AttractionManager.js`（`register/activate/deactivate`，`deactivate` = `dispose → registry.disposeAll → scene.remove`）。
- **本会话已恢复的 v3 完整提示词**：`D:/playground-mvp/v3_spec.txt`（从 transcript 提取，原文在「7.6 验收」处截断，模块 8/9 与执行纪律仅高层描述）。
- **原始会话 transcript**（如需逐字核对）：`C:/Users/36180/.workbuddy/projects/d-playground-mvp/17be354c-123b-4a48-84b8-abcee9a9e9e9.jsonl`（约 17.7MB，行 1880 附近是 v3 提示词）。
- **当前 dev server**：前一个模型重启过，运行在 **http://localhost:5173/**（后台进程仍在）。用户务必 **硬刷新**（Ctrl+F5 / Cmd+Shift+R）。

---

## 二、已确认的事实（代码层面，非猜测）

1. **落地页 = 大厅（乐园），不是跑酷。**
   - `src/main.js`：`const ACTIVE_KEY = LOBBY_KEY;`（line 65），`bootstrap()` 末尾 `attractionManager.activate(ACTIVE_KEY)`（line 417）。
   - 预热顺序：DUMMY→PUMPKIN→**PARKOUR**(317)→MEMORY→JUMP→TRAIN→CAROUSEL→PIRATE→**LOBBY**(403/417)。最后一个激活项一定是 LOBBY。
   - 证据：`shot-lobby-default.png`（大厅实拍：中央广场、摩天轮、过山车轨道、亭子、树、喷泉都在）。

2. **跑酷「开始跑酷」按钮的 CSS 默认可见、可点。**
   - `src/attractions/ParkourRun.js`：`_buildUI()` 用 JS 注入 `<style id="parkour-style">`（line 409-436）。
   - `.pk-panel{...display:flex;pointer-events:auto;background:rgba(8,14,24,.55)}`（line 423）→ 进入跑酷后遮罩面板**默认显示**。
   - `#pk-start` 按钮 `pointer-events:auto`（line 427），点击绑定 `this._el.start.addEventListener('click', () => this._startCountdown())`（line 468）。
   - `_startCountdown()` 仅在 `this._state === 'ready'` 时生效（line 518）。正常进入跑酷后 state='ready'，按钮可用。
   - **结论**：在正常「进入跑酷」流程里，按钮不是 CSS 隐藏问题。

3. **跑酷 / 跳一跳 只是大厅里的设施，触发靠大厅的发光圆环。**
   - `src/main.js` 注册：`PARKOUR_KEY='parkour-run'`（51）、`JUMP_KEY='jump-jump'`（55），均已 `register`（285/287）。
   - `src/attractions/Lobby.js`：`FACILITIES` 数组 line 76 `key:'parkour-run' name:'极限跑酷' label:'跑酷跑道'`、line 84 `key:'jump-jump' name:'跳一跳' label:'跳跳乐'`。
   - 大厅进入逻辑：射线命中带 `userData.facilityKey` 的触发环 → `ctx.onEnterAttraction(key)` → 激活对应设施。该机制对 key 字符串无关，改 key 不会"进不去"。

4. **旧文件已删除、构建通过。**
   - 已删除 `src/attractions/CoinPath.js`、`src/attractions/BouncingBall.js`（被 v3 的 ParkourRun / JumpJump 取代）。
   - `npm run build` 退出 0（40 modules，仅 1 条 chunk 体积告警，无错误）。

---

## 三、用户报告的现象（需下一个模型在浏览器里复现/确认）

用户在本地 `npm run dev` 打开后报告：
- (A) **"一打开浏览器就是跑酷"**（期望是大厅）
- (B) **"乐园没了"**（看不到大厅）
- (C) **"跑酷还点不开"**（按钮/交互无反应）
- (D) **"这么多 BUG"**（总体观感）

> 重要前提：前一个模型**没有无头浏览器**，无法真正在浏览器运行验证"运行时表现"，只能从代码静态推断。
> 因此以上 4 条里，哪些为真、哪些是"服务器卡死造成的假象"，**必须由下一个模型实际 `npm run dev` + 看控制台** 来验证。

---

## 四、最可能的根因（按可能性排序，附代码位置）

### 假设 1（环境类，高可能）：开发服务器 HMR 崩坏遗留的"冻结坏状态"
- 前一个模型在本轮**删除了被 `main.js` import 的两个文件**（`CoinPath.js`/`BouncingBall.js`）。
- 当时用户机器上**同时跑着两个 Vite dev server**（5173、5174，均 `--strictPort`）。删除被 import 的文件会使**运行中的 HMR 直接失效**，浏览器标签页卡在"冻结帧 + 输入失灵"。
- 表现恰好 = (A)(B)(C) 同时出现：画面停在某帧（比如用户之前进去过的跑酷）、点什么都没反应、像乐园没了。
- 处理：前一个模型已 kill 旧的 4 个 vite 进程并重起 5173。但用户若**没硬刷新**、或浏览器缓存了旧 bundle，仍会看到坏状态。
- **下一步验证**：用 **http://localhost:5173/** 硬刷新；若仍坏，打开 F12 Console 看是否有红色报错 / "初始化失败" 面板。

### 假设 2（代码结构类，需验证）：`bootstrap()` 预热抛错 → catch 把应用停在一个冻结帧
- `src/main.js` `bootstrap().catch(...)`（line 486-491）：**任何初始化/预热抛错 → 隐藏开始页 + 停止渲染循环 + 显示"初始化失败"调试面板**。
- 预热在 line 317 `activate(PARKOUR_KEY)` 后、line 318 `renderOnce()` **已经把跑酷场景画了出来**；随后 line 319 `warmParkour.warmUp()` 是一个很重的路径（240+ 次迭代调用 `_advanceWorld/_updatePlayer/_checkCollisions/_updateCamera` 等，再到 `_activatePower`）。
- **若 `warmUp()` 运行时抛错**：line 318 已渲染的"跑酷帧"成为最后画面 → catch 隐藏开始页、循环不启动 → 用户看到**冻结的跑酷 + 点不动 + 大厅从未被 line 417 激活(乐园没了)**。这与 (A)(B)(C) **完全吻合**。
- 注意：纯静态 `build` 通过不代表运行时不抛错。`warmUp()` 里 `this._beginRunning()` 及后续方法依赖 `init` 已正确设置所有字段；若存在未初始化引用/Three 调用次序问题，就会抛。
- **下一步验证**：在 `warmParkour.warmUp()`（line 319）前后加 `console.log` 断点，或在 `catch`（486）里 `console.error(err.stack)`，看是否真有异常；或直接注释掉 line 317-324 的跑酷预热块，确认去掉后落地是否恢复大厅（缩小范围）。

### 假设 3（视觉完整性，非致命）：跑酷/跳跳在大厅**没有主题建筑外观**
- 大厅外观分三处 builder：`_buildFacilityFacades`(2212，只建[0]南瓜/[2]魔法屋)、`_buildArenaFences`(2276，给[1]/[3]建围栏但**不设 facilityKey**)、`_buildM9Facades`(2335，只建[5]carousel/[6]pirate)。
- 即 `parkour-run`(FACILITIES[1])、`jump-jump`(FACILITIES[3]) 在大厅里**只是围栏圈地，没有像旋转木马/海盗船那样的实体建筑**。
- 这不会造成"点不开"，但用户可能因此觉得"乐园看起来不完整/空了一块"。属于 v3「模块3+4 设施对齐」的范畴，尚未实现。

---

## 五、下一个模型应该**第一步**做什么（强烈建议）

1. `cd D:/playground-mvp && npm run dev`，浏览器开 **http://localhost:5173/**，**硬刷新**。
2. 打开 F12 → Console，记录**任何红色报错**；特别留意是否出现调试面板文字 **"基座状态: 初始化失败，请查看控制台"**。
3. 如果出现"初始化失败"：把 `main.js` line 486-491 的 catch 改为打印完整 `err.stack`，重新加载，定位是哪个设施的 `init/warmUp` 抛错（重点排查 **ParkourRun.warmUp** line 319 与 **JumpJump.warmUp** line 348，因为这是本轮新增、且是最重的新代码路径）。
4. 如果**没有**"初始化失败"、控制台干净、落地确实是**大厅**：则用户之前看到的是假设 1（旧服务器冻结帧），无需改代码，只需让用户硬刷新即可；此时再单独验证"进入跑酷 → 点开始跑酷"是否流畅。
5. **务必**在浏览器里真正进入一次跑酷和跳一跳，确认 (C)"点不开"是否依然存在，并截图。

---

## 六、v3 九大模块落地进度（截至本交接）

| 模块 | 内容 | 状态 | 关键文件 |
|---|---|---|---|
| 模块0 | 代码阅读 + 四项报告 | ✅ 已完成 | `docs/v3_module0_report.md` |
| 模块1 | ParkourRun.js 替换 coin-path | ✅ 已完成（需运行时验收） | `src/attractions/ParkourRun.js`；main.js 285/317-324/474；Lobby FACILITIES[1] |
| 模块2 | JumpJump.js 替换 bouncing-ball | ✅ 已完成（需运行时验收） | `src/attractions/JumpJump.js`；main.js 287/346-353/476；Lobby FACILITIES[3] |
| 模块3+4 | Carousel 大厅对齐 + 第一人称坐姿 | ❌ 未开始 | — |
| 模块5 | 大厅椅子坐下休息 | ❌ 未开始 | — |
| 模块6 | 迎宾 NPC 与动态人群 | ❌ 未开始 | — |
| 模块7 | 昼夜循环 + 烟花系统 + FireworksDeck.js | ❌ 未开始 | — |
| 模块8 | CenturyClock.js 世纪钟设施 | ❌ 未开始 | — |
| 模块9 | 渲染管线反 AI 感增强 | ❌ 未开始（v3 原文在 7.6 截断，缺逐条细节） | — |

> 纪律要求：严格串行 7.5→7.6→8→9；昼夜/烟花系统必须是**单例全局**；每模块做完 init→play→dispose 验证 GPU 几何/纹理回落基线（Δ0/0，热基线 = Lobby 激活态 17/24）。

---

## 七、已知待修/待验证清单（交给下一个模型）

- [ ] **P0**：复现并定位"打开就是跑酷/点不开/乐园没了"（见第五节步骤，优先假设 2 的 warmUp 抛错）。
- [ ] **P0**：`ParkourRun.warmUp()` / `JumpJump.warmUp()` 在浏览器真实运行是否抛错（这是本轮唯一的新重代码路径）。
- [ ] **P1**：给 `parkour-run` / `jump-jump` 在大厅补**主题建筑外观**（当前只是围栏，见假设 3）。
- [ ] **P1**：验证反复进出跑酷/跳一跳后，DOM UI 是否被正确移除、`window` 的 keydown/touch 监听是否在 `dispose` 中解绑（防泄漏/防干扰大厅）。`ParkourRun.dispose` 已做，但未在浏览器验证。
- [ ] **P2**：预热阶段 `attractionManager.activate` 是否会在不 deactivate 前一个的情况下叠加场景（每个 warmup 块都有显式 `deactivate()`，但 activate 内部是否先退场需确认，避免几何数虚高）。
- [ ] **P2**：继续未实现的模块 3+4 / 5 / 6 / 7 / 8 / 9。

---

## 八、重要提醒（避免重蹈覆辙）

- **改动/删除被 `main.js` import 的模块后，必须重启 dev server**，不要让 Vite HMR 在文件缺失时硬撑——它会制造"假 BUG"（冻结帧/输入失灵），极难从代码层面排查。
- 本项目**没有无头浏览器**可用。任何"运行时表现"类问题，都必须真正 `npm run dev` + 看浏览器控制台来确认，静态 `build` 通过 ≠ 运行无误。
- 资源泄漏验收靠控制台 `[资源计数]` 日志（几何/纹理增量应为 0）。热点基线：Lobby 激活态 = 17 几何体 / 24 纹理。
