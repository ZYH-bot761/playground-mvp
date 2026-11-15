# v4 Lobby 终局改造规格（T04b-c / T07 / T08 / T09）

> 主理人 2026-11-11 勘察编写。这 4 项**都改 `Lobby.js`，必须串行、同一时刻只允许一个任务写**。
> 行号会因并行改动漂移，**以 name / 函数名定位，不要盲从行号**。
> 已落盘的地基在本文末尾「前置地基」一节，先读它再动手。

---

## 全局约束（4 项都要守）

1. **只允许一个任务写 `Lobby.js`**。T02（WASD）正在写，它收工并回报后才派下一项。
2. **不能破坏已验收的基线**：大厅稳态 baseline 约 `40 geo / 30 tex`（会随新增资源涨），每次改造后 5 轮 `onEnterAttraction → onExitAttraction` 必须 Δgeo=0 / Δtex=0。
3. **新增 GPU 资源必须登记进 Lobby 台账**（`_trackGeometry/_trackMaterial/_trackTexture`），`dispose()` 幂等释放。
4. **update 热路径禁止 new** geometry/material/texture；只改已有对象属性（Lobby.js:3700 `_updateAnimations` 纪律）。
5. **远景动画用 `lodOn(key)` 门控**（Lobby.js:3700-3705），LOD 切到中/远景时跳过装饰动画省性能。
6. **不能碰别人的文件**：main.js（T03/T04b-b 在用）、CenturyClock.js、NPCManager.js、JumpJump.js、ParkourRun.js、FacilityRuntime.js、CameraRig.js、CoasterCarRuntime.js、FerrisWheelEmbedView.js、FacilityTextures.js。
7. **不能删任何文件**（用户明确"不要删除不该删的"）。PumpkinThrower.js 保留，即使运行时不再用它。

---

## T04b-c · 真摩天轮外观（用户第 5 项视觉部分）

**目标**：把大厅轮盘上的 10 个南瓜球换成**真实的摩天轮座舱**（吊篮/座舱造型），保留轮盘旋转与可点击。

**当前代码**（以 name 定位，行号仅参考）：
- `_buildPumpkinWheel()`（约 1966 行）：group `Lobby/pumpkin-wheel` 在 `FACILITIES[0]`（x:-13, z:-6）；`Lobby/wheel-spin` 是旋转轮组，local `(0, 8.2, 0)`，每帧 `rotation.z += dt*0.13`（约 3710 行）
- **要替换的循环**：`for (let i=0;i<10;i++)` 里的 `this._ball(wheel, 'wheel-pumpkin-${i}', ..., 0.78, cos(a)*5.4, sin(a)*5.4, 0, {...})` —— 这就是 10 个南瓜球
- 轮圈：`wheel-ring-outer` 半径 5.4、`wheel-ring-inner` 半径 3.9；8 根辐条；`wheel-hub` 球半径 1.1

**必须严格对齐的参数**（来自 `FerrisWheelEmbedView.js:48-54`，改错会导致相机锚点错位、玩家"坐在座舱外"）：
```
CABIN_COUNT = 10          // 座舱数必须是 10
WHEEL_RADIUS = 5.4        // 座舱中心必须在半径 5.4 的圆周上
WHEEL_HUB_Y = 8.2         // 轮心 local y 不变
轮盘 name 必须是 'Lobby/wheel-spin'（EmbedView 用 getObjectByName 找它）
```

**座舱运动学（关键，防眩晕）**：座舱挂在旋转的 `wheel` 下，会跟着轮盘一起倒转。必须让每个座舱**自反转保持水平**：每帧对座舱 `cabin.rotation.z = -wheel.rotation.z`（或在 init 时把座舱挂到独立 group 并每帧同步位置 + 不继承旋转）。这样座舱吊篮始终口朝上，玩家坐着不会天旋地转。

**造型建议**（真实感、低多边形、复用 `S` 共享几何与材质）：每个座舱 = 吊架（细杆）+ 座舱主体（圆角盒/Cylinder）+ 顶棚（半球/锥）+ 窗户（发光条）。颜色用 `S.matNeonWarm/Violet/Cyan/Gold` 交替，避免全同色。"巨型南瓜"标志（`_buildFacilityFacades` 里的 `facade-giant-pumpkin`）可保留作为"南瓜摩天轮"的主题装饰，但轮盘上的座舱必须是真座舱。

**验收**：
- `npm run build` 通过
- 完整 app 截图：轮盘上是 10 个水平座舱（不是南瓜球），且轮盘转动时座舱始终水平（连续 2 秒截图对比）
- 进入摩天轮（`onEnterAttraction('pumpkin-thrower')`，走 T04b-b 接入的嵌入视图）：相机在座舱内，`getCameraAnchor()` 返回的位置与实际座舱视觉位置误差 <0.1（实测读两组数据比对）
- 5 轮往返 Δ0/0、0 pageerror

---

## T07 · 大厅设施常驻动效（用户第 11 项）

**目标**：大厅里的旋转木马、海盗船、小火车**持续动起来**（现在完全静止），不要空轨道/死设施。

**当前代码**（静态外观）：
- `_buildM9Facades()`（约 2728 行）：`Lobby/facade-carousel`（旋转木马顶棚/木马/灯泡）、`Lobby/facade-pirate-ship`（海盗船 4 立柱 + 船体，约 7m 高，相对 40m 过山车显小）
- `_buildTrainStation()`（约 2369 行）：`station-train-body` 是**静态 Mesh**，小火车不动
- `_buildCoasterTrack()`（约 2433 行）：只建 rails/ties/pillars 三个 InstancedMesh，**无小车**
- `_updateAnimations(dt)`（约 3700 行）：目前只有 `_wheelGroup.rotation.z += dt*0.13`（摩天轮）、金币、牌阵、弹跳球、粒子、触发环、喷泉、箭头、云在动

**要做的**：
1. `_buildM9Facades` 里给木马/海盗船外观的**可动部件**存实例字段（如 `this._carouselFacadeSpin`、`this._pirateFacadePivot`）。
2. `_updateAnimations` 里用 `lodOn('carousel')` / `lodOn('pirate-ship')` 门控，每帧改属性：
   - 木马：`this._carouselFacadeSpin.rotation.y += dt * 0.35`（参考 `Carousel.js:754` 的 ROTATE_SPEED=0.55，大厅外观可慢一点）
   - 海盗船：`angle = MAX_AMP * Math.sin(t * omega)`，绕 pivot 摆动（参考 `PirateShip.js` 的 `MAX_AMP=1.0 rad`、`omega=2π/3.0`），只改 rotation.z，无随机抖动
   - 小火车：沿站台短轨循环（可在 `_buildTrainStation` 里建一小段椭圆轨 + 用 `getPointAt` 移动 `station-train-body`，或用简单 `position.z` 往返 + 到头转身）；**若工作量太大，至少要让它沿站台前后缓慢往返**，不要完全静止
3. **过山车小车**（见 T08）：把 `_buildCoasterTrack` 的局部 `const curve` 存成 `this._coasterCurve = curve`（一行，天然与实际轨道一致），T08 用它接 `CoasterCarRuntime`。

**不抽模型**：不要改 Carousel.js/PirateShip.js 的 600 行 init 去抽 `buildXxxMesh` 共享函数——用户要的是"场景连续、还在大厅里"，不是"大厅和设施内同一个模型"；大厅是远景装饰、设施内是近景可骑乘，本就该不同。

**验收**：
- 完整 app，进入大厅后静置 3 秒，逐帧读 `this._carouselFacadeSpin.rotation.y`（有变化）、`this._pirateFacadePivot.rotation.z`（在 -MAX_AMP~MAX_AMP 间摆动）、`station-train-body.position`（在动）
- 截图/录屏证明三设施都在动（存 `docs/screenshots/v4-t07-animations.png` 或多帧对比）
- `render.calls` 增量 ≤ 各设施 1~4 个 InstancedMesh、三角面 ≤300k、5轮Δ0/0、0 pageerror

---

## T08 · 跳一跳嵌入 + 过山车小车挂轨（用户第 11+12 项）

**目标**：① 跳一跳不再切到独立天幕场景，**就在大厅环境里跳**；② 过山车小车全程贴轨运行（T04a 已做好运行时，这里只接线）。

### 8a 过山车小车接线
- 前置：T07 已把 `this._coasterCurve = curve` 存好（见上）。
- 在 Lobby.js 顶部 `import { CoasterCarRuntime } from '../utils/CoasterCarRuntime.js'`（471 行，已落盘，接口见下）。
- 在 `_buildCoasterTrack()` 末尾：`this._coasterCars = new CoasterCarRuntime({ curve: this._coasterCurve, carCount: 3, period: 42, trackGauge: 1.8 }); this._coasterCars.init(this.root);`（**period 用 36~48，T04a 实测默认 24 在 192m 急弯曲线上偏快**）。
- 在 `dispose()` 里 `this._coasterCars?.dispose(); this._coasterCars = null;`。
- 在 `_updateAnimations(dt)` 里用 `lodOn('coaster')` 门控 `this._coasterCars?.update(dt)`。
- **不要用 `createLobbyCoasterCurve(COASTER)` 工厂接法**：它是独立测试/备用，依赖"与 Lobby 曲线构建同步修改"，而 Lobby.js 行号在并行开发中会漂移；用 `this._coasterCurve` 字段接法天然 100% 一致。

**CoasterCarRuntime 接口**（已落盘 38/38 探针）：`new CoasterCarRuntime({curve, carCount, period, trackGauge, carSpacing, carLength})` → `init(parent)` / `update(dt)` / `setCurve(curve)` / `get t` / `get cars` / `getCarBasis(i)` / `dispose()`。t=0 全周期贴轨误差 0、basis 正交、车长收敛到最小弦距×0.78 不穿模、slew rate limit 0.9rad/s 无 roll 突变。

### 8b 跳一跳嵌入大厅
- 现状：`JumpJump.js` 的 `init()` 自建天空 `_buildSky()`、地面 `_buildGround()`、改 `scene.background/fog`，是完全独立场景。
- 目标：新增一个 `src/attractions/embedded/JumpJumpEmbedView.js`（**新文件**，实现 `IEmbeddedView` 契约，参考已落盘的 `FerrisWheelEmbedView.js` / `DemoEmbedView.js`）：
  - **不建天空/地面、不改 background/fog**，复用大厅的 SceneManager.scene + Lobby 常驻天空/地面/光照
  - 只在大厅一块空地（重排后的 jump 区，trigger (26,6)）铺方块池（**几何/材质由 EmbedView 自己 track 并在 dispose 幂等释放**，不碰 Lobby._shared）
  - `getCameraAnchor()` 返回该区第一人称机位（能同时看到方块池和大厅背景）
  - `update(dt)` 驱动方块池玩法矩阵（参考 `JumpJump.js` 的蓄力/抛物线逻辑，可简化为嵌入版的轻量玩法）
  - 相机：坐在大厅跳跳区第一人称，360° 环顾时能看到大厅其它设施/天空（这才是"真实、不突兀"）
- 接线：main.js 加 key + `facilityRuntime.register` + `dayNightCycle.registerEmbeddedContext`（**这一步由 T04b-b 工程师或后续工程师做，不要和 T04b-b 同时改 main.js**）。
- Lobby.js 侧：FACILITIES[3] jump-jump 的 trigger 已是 (26,6)，无需改坐标；但要确认该空地不被其它 AABB 吃掉。

**验收**：
- 过山车：进入大厅后读 `this._coasterCars.t` 在 2 秒内变化；`getCarBasis(0)` 的 position 到 `this._coasterCurve.getPointAt(carT)` 误差 <1e-6（全程贴轨）；截图证明小车在轨道上、无悬空起始段（存 `docs/screenshots/v4-t08-coaster.png`）。
- 跳一跳：进入后 `scene.getObjectByName('Lobby')` 的 parent 仍是 scene、`attractionManager.activeKey==='lobby'`、`dayNightCycle.isActive===true`；截图证明背景是大厅天空/地面/其它设施，不是独立天幕（存 `docs/screenshots/v4-t08-jumpjump.png`）。
- 5轮Δ0/0、0 pageerror、build 通过。

---

## T09 · 城堡大门 + 建筑放大（用户第 8+6 项）

**目标**：① 大门从"两根圆柱+横梁"改成**豪华城堡门楼**；② 海盗船/木马/摩天轮/站台外观按真实比例放大（海盗船 7m 显小）。

**当前代码**：
- `_buildGate()`（约 1913 行）：两根 `geoCylinder` 立柱 + `gate-beam` 横梁 + 两球 + 紫竖条 + 点阵招牌（已改 atlas 文字）；AABB `:1855-1859` 留门洞
- 设施外观：`_buildM9Facades()`（木马/海盗船）、`_buildPumpkinWheel()`（摩天轮）、`_buildTrainStation()`（站台）

**城堡门楼做法**：中央尖拱门洞 + 两侧锥顶塔楼（`geoCone`/`geoCylinder` + `matPillar`/`matCoinGold`）+ 城垛（`geoBox` 阵列 `InstancedMesh`）+ 吊桥/铁链意象 + 纹章。**全部复用 `S` 共享资源**（零新增 geometry/material/texture，只增若干 InstancedMesh draw call）。保留门洞 AABB 与 atlas 招牌。参考 `docs/screenshots/part5-01-lobby-after.jpg` 的旧门对比。

**建筑放大**：给 `_buildM9Facades` / `_buildPumpkinWheel` / `_buildTrainStation` 的外观整体 `group.scale.setScalar(s)`（s≈1.3~1.6），**但必须同步放大其 `_buildingBoxes` AABB 与 `_pickProxy`**，否则"看得见撞不到/点击不到"。
**关键冲突**：用户第 7 项要求设施分散（触发点最小 7.0m），第 6 项又要求放大 → **放大系数上限由"放大后触发点仍 ≥6.5m、建筑 AABB 不重叠"反推**。先按 1.3 试，若重叠就降；**不要为了放大牺牲第 7 项的分散成果**。

**验收**：
- 截图对比旧门（城堡风格：拱门/双塔/城垛可辨），存 `docs/screenshots/v4-t09-gate.png`
- 海盗船明显更大（截图对比），放大后 9 触发点仍 ≥6.5m（跑 `_assertTriggerSpacing()` 0 告警）、建筑 AABB 两两不重叠、点击/碰撞与新尺寸一致
- `render.calls ≤120`（大厅）、三角面 ≤300k、5轮Δ0/0、0 pageerror

---

## 前置地基（已落盘，直接用，不要重复实现）

| 文件 | 关键接口 |
|---|---|
| `src/utils/CoasterCarRuntime.js` (471行) | `new CoasterCarRuntime({curve,carCount,period,trackGauge})` → `init(parent)/update(dt)/dispose()`；`createLobbyCoasterCurve(COASTER)` 备用工厂 |
| `src/attractions/embedded/FerrisWheelEmbedView.js` (290行) | `FERRIS_WHEEL_KEY='ferris-wheel'`，CABIN_COUNT=10/RADIUS=5.4/HUB_Y=8.2 |
| `src/core/FacilityRuntime.js` (274行) | `register(key, factory)/activate(key)/deactivate()/update(dt)`，`update` 每帧无条件 `cameraRig.update(dt)`（**唯一驱动点**） |
| `src/core/CameraRig.js` (347行) | `setOwner/save/blendTo/restore/releaseOwner/update/isTransitioning`，owner 闸门（非 owner 写操作被拒） |
| `src/attractions/embedded/IEmbeddedView.js` (148行) | 契约：`init(ctx)/getCameraAnchor()/update(dt)/activate()/deactivate()/dispose()` + `track(resource)`；6 条硬禁令 |
| `src/utils/FacilityTextures.js` (242行) | 2048² atlas 文字（T06 已接入 Lobby），**不要动** |

## 接线到一体化基座的 3 步（T08b / 任何新嵌入设施）
1. 实现 IEmbeddedView 子类（含 `getCameraAnchor()`）
2. main.js 的 `EMBEDDED_KEYS` 加 key
3. `facilityRuntime.register(key, ()=>new XxxEmbedView())` + `dayNightCycle.registerEmbeddedContext(key)`

## 集成期已知冲突（必须避开）
- **cameraRig 双重驱动**：`main.js frameDriver → facilityRuntime.update → cameraRig.update(dt)` 是唯一驱动点。Lobby 自己不能再每帧调 `cameraRig.update(dt)`（T02 正在修 Lobby.js:3817 的重复调用）。`Lobby.js dispose` 里一次性的 `cameraRig.update(1e6)` 保留（收尾用，非每帧）。
- **后台预热误卸大厅**：`prewarmFacility(key)` 对 EMBEDDED_KEYS 必须跳过（T03 已做，T04b-b 加摩天轮 key 时要复核）。
- **HMR 打断验收**：多人并行改文件时 Vite HMR 会整页 reload 打断 Playwright 长跑。用 `vite build --outDir <独立目录>` + `vite preview --outDir <独立目录>` 做静态快照验收（T10 工程师验证有效），或 Playwright `routeWebSocket` 静默拦截 HMR。
