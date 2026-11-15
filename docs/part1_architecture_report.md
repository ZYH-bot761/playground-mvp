# 项目架构理解总结（手册第一部分交付）

> 日期：2026-11-09 · 依据：《Three.js游乐园项目AI协作提示词手册_完整版》第一部分
> 阅读范围：src/ 下全部 20 个 .js 文件（main / core×6 / attractions×11 / ui×2），按手册指定顺序逐文件通读；另核对 node_modules/three r187 源码两处 API 事实。
> 口径：本报告所有行号均经 Read/Grep 实测；运行时表现一律标注「待第二部分实测」，不做无证据断言。

---

## 一、入口流程图（bootstrap() 执行链）

文件：`src/main.js`（503 行）。模块级先行代码 → `bootstrap()`（L204）→ 末尾 catch（L498-503）。

```
[模块级，import 后立即执行]
  L47-63   设施 key 常量（9 个）
  L65      ACTIVE_KEY = LOBBY_KEY          ← 落地页恒为大厅
  L116-132 readMemory()/logMemory()        ← 泄漏验收计数口径
  L164-182 new StartScreen + init + show   ← 开始页（纯 DOM，渲染循环外）
  L185-202 pagehide 收尾（bfcache 跳过）

[bootstrap()，async]
  L205     audioManager.init({volume:0.7})
  ① L207-220  冷基线：renderOnce() → readMemory()（仅参考）
               + 打印计数口径说明（dfgLUT 内部纹理计入基线，非泄漏）
  ② L223      await physicsManager.init()  ← 全工程唯一 RAPIER.init()；
               内部 new World({x:0,y:-9.81,z:0})，固定步长 1/60 累加器
  ③ L226-273  装配 baseCtx：
               {scene, camera, renderer, RAPIER, world, physics, ui,
                interaction, isPaused(), onEnterAttraction, onExitAttraction}
               · onEnterAttraction(key)  L243-256
               · onExitAttraction()      L263-272
  L275-282   sceneManager.configure / interactionManager.init /
             attractionManager.configure(baseCtx)
  L283-291   register × 9：dummy / pumpkin-thrower / parkour-run /
             memory-match / jump-jump / train-ride / carousel /
             pirate-ship / lobby（全部为工厂函数，惰性实例化）
  ④ L297-426  预热链（整体包在 try-catch 隔离内）：
               DUMMY→PUMPKIN→PARKOUR→MEMORY→JUMP→TRAIN→CAROUSEL→PIRATE→LOBBY
               每步：activate → renderOnce → warmUp() → renderOnce
                     →（记录峰值）→ deactivate → renderOnce
               Lobby 预热段（L407-417）：
                 L412 baseline = readMemory()   ← 本次会话基线（Lobby 激活态）
                 L416 emptyBaseline             ← 空场景基线（仅卸载对照）
               catch（L420-426）：任一步抛错仅 console.error 并兜底
               deactivate，绝不中断大厅加载
  ⑤ L429-431  正式 activate(LOBBY) → renderOnce → logMemory('初始')
  ⑥ L434-458  uiManager.init（卸载测试/重新激活按钮回调）
  ⑦ L461-468  bootReady=true；仅当 startRequested（用户已点「进入」）
               才 startGameplayLoop() → sceneManager.start()
               （loopStarted + SceneManager._running 双幂等闸门，L152-157）
  ⑧ L471-495  window.__playground 调试句柄（managers / 基线 / 峰值 /
               计数器 / onEnter / onExit / logMemory）

[bootstrap().catch，L498-503]
  初始化失败 → console.error + 收起开始页 + 调试面板显示「初始化失败」
  （渲染循环不启动）
```

要点：
- **场景/相机/光照/渲染器**全部由 `SceneManager` 单例在模块 import 时构建（`src/core/SceneManager.js`）：PerspectiveCamera(55°, 0.1-200) 初始 (0,2,7)；ACESFilmic 曝光 0.38；PCFShadowMap（2048）；PMREM + RoomEnvironment；EffectComposer = RenderPass + UnrealBloom(0.06/0.35/1.4) + OutputPass。
- **动画循环**在 `SceneManager`（THREE.Timer，非自建 rAF/Clock）：每帧 dt 截断 0.1 → 暂停闸门（暂停时跳过 physics.step 与 attractions.update，仍渲染）→ `physics.step(dt)` → `attractions.update(dt)` → `composer.render()`。大厅与设施互斥，任一时刻只有一个 active，故循环里只调度 `activeAttraction.update()`——Lobby 也是注册设施之一，无特殊分支。
- **开始页闸门**：渲染循环启动需同时满足「用户点击进入」+「预热完成」，任一先满足都等待另一个（L166-179、L461-468）。

## 二、设施生命周期图

文件：`src/attractions/AttractionManager.js`（175 行）。

```
register(key, factory)          L45   仅存工厂，不实例化
        │
activate(key)                   L69
        │  ① 若已有 active → 先走 deactivate()（见下）   L73
        │  ② 新建 DisposableRegistry（每次激活独立台账）  L76
        │  ③ factory() 创建全新实例 → 校验四方法存在      L80-84
        │  ④ instance.init(ctx)；抛错则回滚（dispose +
        │     registry.disposeAll + 移除 root）           L95-103
        │  ⑤ 设为 active，返回实例
        ▼
[运行期] SceneManager 每帧 → update(dt)      L150（try/catch 转发）
         InteractionManager 点击 → onInteract(hitInfo)  L159
        │
deactivate()                    L108-147  严格三步，每步独立 try/catch：
        │  ① active.dispose()              —— 设施自清（七步清理）
        │  ② registry.disposeAll()         —— 台账兜底，逆序释放遗漏资源
        │  ③ scene.remove(root) + 遍历清除孤儿
        │     userData.attractionRoot 节点  L130-136
        ▼
[销毁完成] active=null；场景不应残留该设施任何 Mesh/Group
```

- 实例**一次性**：每次 activate 都 new，dispose 后不复用（`_disposed` 幂等锁防二次释放）。
- 卸载顺序不可颠倒：先 dispose（设施内部可能还要读 ctx/相机做恢复），再 registry 兜底，最后摘根节点。

## 三、大厅-设施切换时序

### 进入（大厅 → 设施）

```
用户走近设施 / 点击触发环
  → Lobby._handleClick(event)                 Lobby.js:2735
      Raycaster.intersectObjects(this._pickables, true)（硬约束：白名单+递归）
      命中对象 userData.facilityKey → 距离守卫（AABB 边缘距 ≤10，否则 toast）
  → Lobby._tryEnter(key)                      Lobby.js:2763
      200ms 防抖（E 键与点击不重复触发）→ ctx.onEnterAttraction(key)
  → main.js onEnterAttraction                 main.js:243-256
      校验 key 已注册 → playClick → 调试面板显示「卸载测试」
      → attractionManager.activate(key)
          内部先 deactivate Lobby：
            Lobby.dispose() 把 {px,pz,yaw,pitch} 写入模块级 _lobbyMemory
            （Lobby.js:45 定义、3007-3014 存档）→ registry → scene.remove
          再 new 设施.init(ctx)（接管相机：_cameraSaved 保存全部字段）
      → sceneManager.setPaused(false)（防暂停态残留）
      → sceneManager.renderOnce()（立即上传新资源，避免首帧惰性编译卡顿）
```

### 返回（设施 → 大厅）

```
设施内「返回大厅」按钮（各设施自有 DOM UI）
  → ctx.onExitAttraction()                    main.js:263-272
      → playClick → 调试面板隐藏「卸载测试」
      → attractionManager.activate('lobby')
          先 deactivate 设施：dispose()（恢复相机 _cameraSaved、解绑监听、
          移除 DOM、释放 GPU/物理资源）→ registry.disposeAll → scene.remove
          再 new Lobby().init(ctx)：
            从 _lobbyMemory 读回坐标/视角（Lobby.js:769-771）
            → 玩家仍站在刚才的设施门口，朝向不变
      → setPaused(false) → renderOnce()
      → roundTripCount++ → logMemory（打印与本次会话基线的 Δgeometries/Δtextures）
```

- 暂停机制：PauseMenu（ESC）调 `sceneManager.setPaused`；暂停期物理与 update 冻结、渲染继续；切换完成后 main.js 统一复位暂停闸门（L253/L267 注释明确这是兜底）。
- 键盘 E 进入：`Lobby` L622（`_nearFacility` 存在时 `_tryEnter`）。

## 四、IAttraction 契约表（以代码实测为准）

文件：`src/attractions/IAttraction.js`（85 行）。**注意：手册假想签名与真实代码不同，以下为真实契约。**

| 方法 | 真实签名 | 职责 | 注意事项 |
|---|---|---|---|
| init | `init(ctx)` | 建 root（`userData.attractionRoot=true`）、`scene.add(root)`、保存相机、建资源/绑定事件/建 DOM | ctx = {scene, camera, renderer, RAPIER, world, physics, ui, interaction, isPaused(), onEnterAttraction(key), onExitAttraction(), registry, registerDisposable}；**不是**手册假想的 `init(scene,camera,controls,options)`；抛错由 Manager 回滚 |
| update | `update(deltaTime)` | 全部每帧运动/动画/计时 | dt 已由 SceneManager 截断 0.1，多数设施再防御性截断一次；必须帧率无关（`elapsed += dt`）；**不是** `update(dt,time)`；禁止自建 rAF/Clock、禁止 `world.step()` |
| onInteract | `onInteract(hitInfo)` | 基座 InteractionManager 射线命中后转发 | hitInfo = {event, hasHit, object, point, distance, face, uv, intersections}；InstancedMesh 命中取 `intersections[0].instanceId`；**不是** `onInteract(action,payload)`；UI 全 DOM 的设施（跑酷/跳一跳/大厅）可为空实现 |
| dispose | `dispose()` | 幂等销毁：相机恢复、监听解绑、定时器清除、DOM/style 移除、物理体移除、GPU 资源显式释放 | `_disposed` 锁防重入；推荐七步各自 try/catch；纹理要断开材质引用（含 ShaderMaterial.uniforms 递归扫描）；InstancedMesh 需额外 `dispose()` 释放实例缓冲；**不自行 scene.remove**（Manager 第③步负责） |

- **没有 enter/exit 方法**：进出完全由 main.js 的两个回调驱动（手册此点与代码一致）。
- 可选方法：`warmUp()`（非契约强制，预热链调用；走一遍核心路径让 shader/贴图在基线采集前上传，结束必须复位状态与相机机位）。

## 五、全局约束清单（10 条，含违反后果）

1. **帧率无关**：所有运动基于 dt 累加（`elapsed += dt`），禁止固定步长/帧计数。违反 → 高低刷屏速度不一致、预热与实玩行为分叉。依据：各设施 update 入口钳制（如 PirateShip.js:898）。
2. **物理步唯一入口**：`world.step()` 只允许出现在 `PhysicsManager.step()`（固定 1/60 累加器，maxSubSteps 5）；设施不得自调。违反 → 步长紊乱、穿模、确定性破坏。依据：PhysicsManager.js；IAttraction 注释。
3. **资源显式释放**：geometry/material/texture 必须 dispose；`registerDisposable` 台账兜底；InstancedMesh 实例缓冲需 `IM.dispose()`；纹理释放后断开材质引用（含 uniforms 递归）。违反 → renderer.info.memory 计数不回落，10 次切换后累积泄漏。依据：DisposableRegistry.js、Carousel/PirateShip 的 `_disposeThreeResources`。
4. **DOM/监听/定时器全清理**：设施创建的 UI 根节点与 `<style>` 必须 remove；所有 addEventListener 登记后按登记解绑（含 capture/options 匹配）；setTimeout/rAF/interval 入账清除。违反 → 幽灵按钮吃点击、退出后键盘仍触发旧设施、回调持有已销毁对象。依据：Lobby `_addListener`/`_clearAllTimers`；PirateShip dispose L1039-1049。
5. **相机归属基座**：相机由 main/SceneManager 唯一持有；设施只保存/恢复 `_cameraSaved`{position,quaternion,up,rotationOrder,fov}，禁止新建相机、禁止 `camera.add()` 进 Group（每帧读世界坐标写相机）。违反 → 切换后视角错乱、相机被随设施根节点一起移除。依据：各设施 init/dispose；PirateShip.js:948-977 注释。
6. **纹理色彩空间**：r187 用 `tex.colorSpace = THREE.SRGBColorSpace`（非旧 sRGBEncoding）；所有程序化 CanvasTexture 已遵守。违反 → 颜色发灰/过艳。依据：全部 make*Texture 函数。
7. **泄漏验收口径**：`renderer.info.memory.geometries/textures` 只计已上传 GPU 的对象；读数前必须 `renderOnce()`；回落目标 = 本次会话基线（Lobby 激活态，main.js:412 采集），不是绝对 0；dfgLUT 为渲染器常驻内部纹理，计入基线非泄漏。违反口径 → 误报/漏报泄漏。依据：main.js:116-132、207-220。
8. **统一驱动**：不自建 rAF/Clock，由 SceneManager 的 THREE.Timer 驱动 update；暂停闸门（isPaused）期间不得改物理/游戏状态。违反 → 双循环、暂停期计时器偷跑。依据：SceneManager 循环；PumpkinThrower timeout 的 isPaused 守卫。
9. **射线拾取硬约束**：`intersectObjects(pickables, true)`（白名单数组 + 递归）；点击与拖拽需位移/防抖区分。违反 → 拾取到装饰物误触发、拖拽环顾被当成点击。依据：Lobby.js:2735 注释（M5a 硬约束）、InteractionManager.js。
10. **卸载顺序固定**：`dispose() → registry.disposeAll() → scene.remove(root)`，由 AttractionManager 强制；设施 dispose 内不抢做 scene.remove。违反 → 兜底失效或重复移除。依据：AttractionManager.js:108-147。

## 六、已知问题映射（7 项 → 代码位置 + 根因假设）

来源：V3_HANDOFF.md §三（用户症状 A-D）与 §七（待修清单 P0-P2）。运行时真伪待第二部分浏览器实测。

| # | 已知问题 | 可能代码位置 | 根因假设（≥1） |
|---|---|---|---|
| 1 | (A) 打开浏览器直接进跑酷 | main.js:65/429（落地恒为 Lobby）；预热链 L297-426 | 假设 a：上一会话删除被 import 的 CoinPath/BouncingBall 时 dev server 仍在跑 → HMR 冻结帧停在跑酷画面（环境假象，硬刷新+重启可解）；假设 b：历史版本 warmUp 抛错使 bootstrap catch 冻结在已 renderOnce 的跑酷帧——**当前代码已用 L297-426 整体隔离，此路径理论上已封堵，需实测确认** |
| 2 | (B) 乐园没了（大厅不显示） | main.js:429 正式激活；Lobby.init L762-833 | 与 #1 同源：冻结帧/初始化中断导致 Lobby 从未激活；或 Lobby init 抛错被 Manager 回滚后场景为空（需看 Console 是否有「初始化失败」面板） |
| 3 | (C) 跑酷点不开（按钮无响应） | ParkourRun.js:468（#pk-start 绑定）、_startCountdown 仅 state==='ready' 生效；warmUp L988-1018 复位 ready | 假设 a：冻结帧下全部输入失灵（同 #1）；假设 b：warmUp 未复位 state 导致按钮守卫拒绝——已读代码确认 warmUp 复位，待实测；CSS pointer-events 经上一会话核查无问题（V3_HANDOFF §二.2） |
| 4 | (D) 「这么多 BUG」总体观感 | 全局 | 复合症状：#1-#3 的环境假象 + #5 的大厅外观缺口叠加；需逐项实测拆解，不作为独立技术问题的证据 |
| 5 | 跑酷/跳一跳在大厅只有围栏、无主题建筑（P1） | Lobby.js:2276 `_buildArenaFences`（不设 facilityKey）；L2335 `_buildM9Facades` 只建 carousel/pirate | 确认属实（静态）：FACILITIES[1]/[3] 无实体门面，视觉「空了一块」；属手册第三/五部分范畴 |
| 6 | 反复进出后 DOM/监听疑似泄漏（P1 待验证） | ParkourRun dispose L946-985；**新发现**：L898 `setTimeout` 未入账；dispose 未调 `InstancedMesh.dispose()`（金币/建筑/路灯 IM） | 假设 a：未入账的 600ms 计时器在 dispose 后触发（有 `this._el` 守卫，仅 DOM 操作，危害低但违规模型）；假设 b：IM 实例缓冲未释放——是否计入 info.memory 待实测对照 |
| 7 | 预热 activate 是否叠加场景（P2 待验证） | AttractionManager.js:69-73 | 静态已排除：activate 入口先 deactivate 前一个（L73），每个 warmup 块另有显式 deactivate；几何数虚高假设不成立，待实测计数确认 |

### 附：本次通读新发现（补充清单，非用户已知问题）

| 位置 | 事实 | 影响/归属 |
|---|---|---|
| ParkourRun.js:267 + 623-635 | `_buildings` 每实例 push 一条（18 条共享 2 个 IM），`_scrollBuildings` 对每条遍历全部 9 实例 → **每个实例每帧被移动 9 次**（侧景 9 倍速滚动） | 确认逻辑 bug，第二部分修复 |
| Carousel.js:41-43、708-719 | 当前仅旁观环绕相机（半径 15.5），无选马/骑乘 | 手册第三部分核心缺口 |
| MemoryMatch.js warmUpFlip（约 L1181） | 只预热翻开路径，翻回计时在 update 推进，未真正覆盖 | 预热完整性瑕疵，低危 |
| TrainRide.js:400 | 唯一实际构造的 MeshLambertMaterial（17 个材质引用它） | 手册第五部分禁用清单 |
| JumpJump.js:128/527、Lobby.js:953/957/962 | MeshBasicMaterial 共 5 处（云/阴影/光轴等特效用途） | 第五部分需逐一改造或豁免论证 |
| node_modules/three/src/renderers/webgl/WebGLShadowMap.js:99-101 | r187 中 PCFSoftShadowMap 已 deprecated：设置即警告并回退 PCFShadowMap | 手册第五部分要求 PCFSoftShadowMap 与 r187 冲突；应保持 PCFShadowMap 并在报告中说明（SceneManager 现注释属实） |
| Lobby 相机 | 第一人称 WASD+拖拽（非 OrbitControls）；手册第三部分要求大厅 OrbitControls | 设计冲突点：既往会话刻意做成第一人称+摇杆；第三部分需决策（手册 vs 现状），届时明确记录 |

## 七、验收自查（对照手册第一部分验收标准）

- [x] bootstrap() 每一步执行内容：见 §一（含行号）
- [x] 设施注册→销毁完整生命周期：见 §二
- [x] onEnterAttraction / onExitAttraction 行号范围：**main.js:243-256 / 263-272**（Read 实测）
- [x] 全局约束 ≥5 条：§五 共 10 条，各附违反后果
- [x] 每个已知问题 ≥1 根因假设：§六 7 项全覆盖
- [x] 手册假想 API 与真实契约差异已显式标注（§四）：无 enter/exit；init(ctx)/update(dt)/onInteract(hitInfo)

> 下一步（第二部分）：npm run dev + 真实浏览器硬刷新，Console/Network/Performance 实测，
> 修复 warmUp 冻结 P0 与新发现的侧景 9 倍速 bug，5 次切换泄漏对照，输出《运行时自检报告》。