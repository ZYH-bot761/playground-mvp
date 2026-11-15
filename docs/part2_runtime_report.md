# 运行时自检报告（第二部分）

> 执行日期：2026-11-09
> 环境：Windows 10 / Chromium（Qoder 内置 browser-use 受控浏览器）/ Vite 8.3.6 dev server（http://127.0.0.1:5173/）/ three r187 / rapier3d-compat 0.21.0
> 方法：真实浏览器加载页面，经 `window.__playground` 驱动真实运行时（物理步进 + 设施 update + renderOnce），Console / Network 全量采集，Canvas 离屏截图。
> 诚实性声明：所有数字均为实测；受环境限制无法测量的项目明确标注「未实测」，不编造。

---

## 0. 环境限制与测量口径（必读）

1. **受控浏览器页面处于 hidden 状态**：rAF 被浏览器暂停，SceneManager 渲染循环不自动走帧。本次自检采用**手动确定性步进**：`physicsManager.step(1/60)` + `attractionManager.update(1/60)`，与基座循环内的调用完全一致，属于真实运行时验证，但**真实 rAF 帧率 / GPU 耗时未实测**。
2. **截图方式**：`renderOnce()` 后将 WebGL canvas drawImage 到 2D canvas 导出 JPEG（绕过隐藏页面无法直接截屏的限制）。截图仅含 WebGL 画面，不含 DOM HUD。
3. **资源计数口径**：`renderer.info.memory.geometries / textures` = 已上传 GPU 且未释放的对象数。验收标准 = 退出设施后回落至**本次会话基线**（Lobby 激活态）。`renderer.info.render.calls/triangles` 为帧内计数，不用于归零验收。
4. 会话初期出现的 257 条 `GL_INVALID_FRAMEBUFFER_OPERATION` 警告已根因定位：**受控浏览器视口初始为 0×0**（canvas 宽高为 0），属环境 artifact；视口激活后警告消失，**非应用 Bug**，不计入报错清单。

---

## 1. Console 报错清单

| # | 报错 | 堆栈 | 根因 | 结论 |
|---|------|------|------|------|
| — | **无红色报错** | — | — | 修复后两次完整加载（295 条 / 249 条消息）全部为 info/log/debug/table，**0 error / 0 warning** |

- 手册所述 P0「warmUp() 抛错冻结画面」**未复现**：bootstrap 全链路预热完成，9 个设施预热峰值全部记录（parkour 9/18、jump 12/20、carousel 16/20、pirate 18/21、lobby 17/24，修复后口径），正式激活 Lobby 成功。main.js:297-426 的逐设施隔离 try-catch 工作正常。历史症状最可能为 HMR 冻帧（V3_HANDOFF 假设 H1），本次每次修改后均整页重载验证。
- Network：**35/35 请求 HTTP 200**，无 404/500（历史 OutputPass 404 已不存在）。

## 2. 修复记录表（6 项，全部实测验证）

| # | 文件:行号 | 问题描述 | 修复方法 | 验证结果（实测） |
|---|-----------|----------|----------|------------------|
| 1 | [ParkourRun.js:273](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L273)（原 :267） | 侧景建筑滚动 **9 倍速**：`_buildings` 在逐实例循环内 push，18 条记录共享 2 个 InstancedMesh，`_scrollBuildings` 每条记录遍历全部实例 → 每实例每帧被移动 9 次 | push 移出实例循环，每个 IM 仅一条 `{mesh, span}` | 修复前实测位移/里程比 **9.0008**；修复后 **0.9999994**（float32 精度），30 帧 dz=7.065933 vs 里程 7.065938 |
| 2 | [ParkourRun.js:903-904](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L903)、[:955](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L955)（原 :898） | 倒计时 `setTimeout` 未跟踪，dispose 后仍可能回调 | `_countTimer` 记录句柄，重复调用先 clear，dispose 中 clearTimeout | 修复后多次进入/退出无残留回调报错（Console 0 error） |
| 3 | [ParkourRun.js:116](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L116)、[:254](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L254)、[:280](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L280)、[:342](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L342)、[:988](file:///D:/playground-mvp/src/attractions/ParkourRun.js#L988) | dispose 未调用 `InstancedMesh.dispose()`，instanceMatrix/instanceColor GPU 缓冲泄漏（不计入 info.memory，属隐性泄漏） | 新增 `_instancedMeshes` 台账，4 个 IM（建筑×2/路灯/金币）全登记，dispose 逐个释放 | 退出后计数回落基线 17/24，Console 无 dispose 报错 |
| 4 | [JumpJump.js:467](file:///D:/playground-mvp/src/attractions/JumpJump.js#L467) | **P0 玩法 Bug**：`_land()` 成功路径未将状态复位为 `ready`，下一帧 `_jumpT ≥ _jumpDur` 仍成立 → 用旧落点对新块再判一次必落空 → **每次成功跳跃后立即幻影坠落结算，游戏永远只能跳 1 次** | 成功路径末尾 `this._state = 'ready'` | 修复前实测：1 次成功落地后 state=result、score=1；修复后实测 **5 连完美跳**，combo 1→5，得分 2→6→12→20→30，每跳后 state=ready |
| 5 | [JumpJump.js:645](file:///D:/playground-mvp/src/attractions/JumpJump.js#L645) | dispose 未释放 `_sun`（DirectionalLight castShadow），阴影贴图颜色+深度 **每次访问泄漏 2 个 GPU 纹理** | dispose 中 `this._sun?.dispose()`（→ LightShadow.dispose → map.dispose 连带 depthTexture） | 修复前实测逐次 +2：26→28→30→32；修复后 3 次进出全部回落 **17/24**。注：修复前基线 26 中含预热泄漏的 2 张，修复后基线回到 24（与 V3_HANDOFF 历史口径 17/24 一致） |
| 6 | [Lobby.js:2884-2897](file:///D:/playground-mvp/src/attractions/Lobby.js#L2884) | **旋转木马入口被跑酷劫持**：木马触发环 (9,2) 落在跑酷围栏 AABB `parkour-run-post--1`（x∈[6.7,10.1], z∈[-0.7,2.7]）内，两者有效距离同为 0，FACILITIES 数组序跑酷在前 → 站在木马环上提示/按 E 进入的是跑酷 | 距离打平时以**触发环距离**近者为准（ε=1e-9） | 修复前 7 触发环实测 6/7 正确（carousel→parkour-run）；修复后 **7/7 正确**，木马环上按 E 实测进入 carousel |

## 3. 设施功能验证表（进入 / 功能 / 退出）

| 设施 | 进入 | 功能（实测数据） | 退出 |
|------|------|------------------|------|
| 大厅 Lobby | ✅ 开始页点击后激活 | 第一人称 WASD/拖拽环顾；7 设施触发环 + 发光标识齐全；E 键/点击近距离进入；`_lobbyMemory` 位置视角存档恢复 | ✅（作为返回基准） |
| 极限跑酷 parkour-run | ✅ | 开始→倒计时→running；变轨（lane 0）、跳跃（y=0.86, grounded=false）；10s 里程 169、金币 15、障碍 6、速度升至 14.88；侧景 1× 滚动（修复后） | ✅ Δ0/0 |
| 跳一跳 jump-jump | ✅ | 蓄力 0.8s→起跳→落地；修复后 5 连完美（combo×2 计分 2/6/12/20/30）；落空→falling→result→重开链路正常 | ✅ Δ0/0（修复后） |
| 旋转木马 carousel | ✅ | 转盘 0.55 rad/s；点击坐骑加速实测 **×2.0000**（1.10 rad/s，1.5s）；8 坐骑、48 灯泡呼吸 | ✅ Δ0/0 |
| 海盗船 pirate-ship | ✅ 选座（前/中/后 3 座） | ready 2s→riding 30s→over；摆角实测 -0.63→+0.86 rad 渐强；相机绑座位随摆升降（y 3.26→8.84）；「再玩一次」回选座 | ✅ Δ0/0 |
| 南瓜投手 pumpkin-thrower | ✅ | 开始→playing；画布点击投掷（1 南瓜刚体）→物理飞行→命中靶子 +1 分→南瓜移除；30s 倒计时 | ✅ Δ0/0 |
| 记忆翻牌 memory-match | ✅ | 同 pairId 两张配对 +5/对（实测 2 对 +10）；不同牌 0.8s 后自动翻回（实测 mid=open→end=closed、解锁） | ✅ Δ0/0 |
| 高空环游 train-ride | ✅ | 第一人称沿 449m 闭合轨道行驶，相机爬升/俯冲（y 18.5→42.0→24.2），单圈校准 50s | ✅ Δ0/0 |
| Dummy 桩 dummy | ✅ | 预热桩，init/dispose 全链路日志完整 | ✅ Δ0/0 |

截图证据（docs/screenshots/）：part2-01-start.png、part2-02-lobby.jpg、part2-04-parkour.jpg、part2-05-jumpjump.jpg（修复前 result 态）、part2-06-carousel.jpg、part2-07-pirateship.jpg、part2-08-pumpkin.jpg、part2-09-memory.jpg、part2-10-train.jpg、**part2-11-jumpjump-fixed.jpg**（修复后玩家立于方块、完美光环、score=12）。

## 4. 资源泄漏检查结果

- **会话基线（修复后，Lobby 激活态）：geometries=17 / textures=24**；空场景基线 2/17；冷基线仅参考。
- **5 轮切换实测**（parkour→jump→carousel→pirate→train，每轮退出后 renderOnce 读数）：

| 轮次 | 设施 | 退出后 geometries | 退出后 textures | 回落基线 |
|------|------|------------------|-----------------|----------|
| 1 | parkour-run | 17 | 24 | ✅ |
| 2 | jump-jump | 17 | 24 | ✅ |
| 3 | carousel | 17 | 24 | ✅ |
| 4 | pirate-ship | 17 | 24 | ✅ |
| 5 | train-ride | 17 | 24 | ✅ |

- 另加 E 键进入木马 1 轮 + 跳一跳重复进出 3 轮，累计 **9 轮来回全部 Δ0/0**（基座 logMemory 逐轮打印「是否回落至基线: 是」）。
- **曾发现的泄漏**：JumpJump 阴影贴图 +2 纹理/次（修复 #5），已消除；ParkourRun IM 实例缓冲隐性泄漏（修复 #3，info.memory 不可见，按 three 文档必须 IM.dispose），已消除。
- Heap Snapshot 对比：**未实测**（受控浏览器无 Memory 面板操作通道）；以 renderer.info.memory 口径完成等效验收，符合 V3_HANDOFF 约定。

## 5. 性能测量（CPU 帧成本，真实 fps 未实测）

| 场景 | 平均 CPU 帧成本 | 折算上限 | 口径 |
|------|----------------|----------|------|
| 大厅 | **13.87 ms/帧**（120 帧平均） | ≈72 fps | step+update+renderOnce 同步耗时；大厅 51 材质 + 2048 阴影每帧重绘是主要成本 |
| 跑酷 running | **0.84 ms/帧**（120 帧平均） | ≈1196 fps | 同上；无阴影光源、IM 合批 |

- Performance 面板 5s 录制：**未实测**（页面 hidden，rAF 暂停，无真实长任务样本）。手动步进数千帧未见异常阻塞。
- 真实 fps / GPU 耗时 / 移动端降级：留待第六部分接入 stats.js 后实测，第九部分终验。

## 6. 剩余问题清单（本次未修复，含原因与去向）

| # | 问题 | 原因/去向 |
|---|------|-----------|
| 1 | 跑酷/跳一跳大厅门面只有围栏，无宏伟建筑 | 视觉资产问题，属第五部分（去 AI 感/建筑细节）范围 |
| 2 | 海盗船第一人称视角朝甲板、无自由环顾/惯性延迟/V 键第三人称 | 属第三部分视角优化范围 |
| 3 | 旋转木马为旁观公转视角，无选马界面/第一人称骑乘 | 属第三部分视角优化范围 |
| 4 | TrainRide 17 处 MeshLambertMaterial、JumpJump/Lobby 5 处 MeshBasicMaterial | 属第五部分 PBR 材质替换范围 |
| 5 | 大厅画面中心过曝光晕 | 属第五部分光照/色调映射范围 |
| 6 | 手册要求 PCFSoftShadowMap，但 three r187 已移除（常量仍在，运行时警告并回退 PCFShadowMap） | 保持 PCFShadowMap，第五部分报告中记录偏差依据（WebGLShadowMap.js:99-101） |
| 7 | 真实 fps / Heap Snapshot / 移动端实测 | 环境限制，第六/九部分以 stats.js 与真机口径补测 |

## 7. 验收标准自查

| 标准 | 结果 |
|------|------|
| Console 无红色报错 | ✅ 0 error / 0 warning（两次完整加载） |
| 大厅正常显示，所有设施入口可见 | ✅ 7/7 触发环归属正确 + 大厅截图 |
| 所有设施可正常进入、运行、退出 | ✅ 9/9（含 dummy 桩） |
| 切换设施 5 次后几何体/纹理/材质无明显增长 | ✅ 5 轮 Δ0/0（材质随几何体/纹理台账同步释放，各设施 dispose 日志计数一致） |
| warmUp() 不再抛错 | ✅ 全设施预热峰值记录完整，bootstrap 无异常 |

**结论：第二部分验收通过。** 6 项 Bug 全部修复并实测回归，可进入第三部分（各设施视角与交互深度优化）。