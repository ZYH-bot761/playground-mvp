# 模块 0 报告 · v3 九大模块落地前强制阅读结论

> 本文件是 v3 提示词「落地前第一步（强制）」的产出：先读全源码，再列四项，然后才动手。
> 已读文件：Lobby.js（M5a 白天广场）、IAttraction.js、Carousel.js（M10 童话版）、PirateShip.js（M10 幻想版 + 点击修复）、CoinPath.js（旧·金币小径）、BouncingBall.js（旧·跳跳球）、main.js、AttractionManager.js、DisposableRegistry.js、SceneManager.js。

---

## ① 设施基类接口签名（IAttraction 契约）

文件：`src/attractions/IAttraction.js`（抽象基类，86 行，本会话未改动）。**注意：契约方法名是 `init / update / onInteract / dispose`，没有 `enter / exit`**（提示词模板里写的 enter/exit 是误记；进入/退出由 main.js 的 `onEnterAttraction(key)` / `onExitAttraction()` 回调处理）。

```js
init(ctx)            // 注入共享上下文；建 root、存相机/场景状态、创建资源。禁止调用 world.step()
update(deltaTime)    // 每帧运动/动画/计时；dt 由 SceneManager 统一 clamp 到 0.1；禁止循环内 new Three 对象；禁止 world.step()
onInteract(hitInfo)  // 点击分发；hitInfo = { event, hasHit, object, point, distance, face, uv, intersections }
dispose()            // 幂等（_disposed 锁）；释放 geometry/material/texture(含 ShaderMaterial.uniforms 纹理)/rigidbody
```

`ctx` 提供：`scene / camera / renderer / RAPIER / world / physics / ui / interaction / isPaused() / onEnterAttraction(key) / onExitAttraction()`，以及注入的 `registry`（DisposableRegistry 实例）与 `registerDisposable(obj)`。

**卸载顺序（AttractionManager.deactivate，不可调）**：① `active.dispose()` → ② `registry.disposeAll()` → ③ `scene.remove(active.root)`。所以每个设施必须把根节点挂到 `this.root`（Group），且 dispose 必须幂等。

---

## ② 相机接管与归还方式

本项目**没有 OrbitControls**（大厅是第一人称漫游，相机由 Lobby 直接控；小游戏各自接管）。接管/归还采用 `_cameraSaved` 模式（Carousel.js、PirateShip.js 同款，全工程统一）：

```js
// 接管（init 内）
this._cameraSaved = {
  position: camera.position.clone(),
  quaternion: camera.quaternion.clone(),
  up: camera.up.clone(),
  rotationOrder: camera.rotation.order,
  fov: camera.fov,
};
// 归还（dispose 内）
camera.position.copy(saved.position);
camera.quaternion.copy(saved.quaternion);
camera.up.copy(saved.up);
camera.rotation.order = saved.rotationOrder;
camera.fov = saved.fov;
camera.updateProjectionMatrix();
```

**铁律**：跟随一律「读取世界坐标 → copy」，禁止 `camera.add()` 进任何设施 Group。ParkourRun 的第三人称跟随相机也遵守此律（每帧 `camera.position.lerp` 到目标，不挂节点）。

---

## ③ 大厅现有场景结构

第一人称漫游，眼高 1.6，出生 `(0,1.6,20)`，±30 夹取 + 2D AABB 阻挡（+1m）。天穹为 Sky.js 片元着色器改写（地平线压暗 `mix(0.40,1.0,smoothstep(0.0,0.16,dir.y))`），背景/雾/光在 init 保存、dispose 还原。

| 类别 | 内容 | 代码位置 |
|---|---|---|
| 地面 | 反光广场（暗色） | Lobby.js |
| 长椅/椅子 | `_buildBenches()`：8 张沿半径 22 环均布、朝向中心（InstancedMesh，座面高 ~0.45，视点 ~1.1~1.2，待模块 5 校准）；街道长椅 `_buildStreetProps()`（line 2459，InstancedMesh 8 draw call） | Lobby.js 1429 / 2453 |
| 装饰物 | 复古路灯 / 垃圾桶 / 指示路牌（InstancedMesh，1 draw call/类）；树下·长椅·路灯·花坛接触阴影贴片（1 draw call）；摩天轮（南瓜）、魔法牌屋（记忆） | Lobby.js |
| 过山车桥 | TrainRide 24 点 lemniscate 曲线，轨道/枕木/桥墩 3 个 InstancedMesh | Lobby.js `_buildCoasterTrack()` |
| 发光拱门 | 方块招牌（进入触发） | Lobby.js |
| **旋转木马** | `FACILITIES` 中 `key:'carousel'`（line 92/2378）。M9 注释「放在大门两侧靠前的位置，一进门即可看到实体外观」（line 68）。大厅内 `_buildCarouselFacade()`：双层帐篷顶 + 金檐 + 灯泡 + 胶囊木马（line 2379）。**注意：大厅是「外观模型」，与游戏内 Carousel.js 模型并非同一函数 —— 模块 3 要求抽 `buildCarouselMesh(scale)` 统一。** | Lobby.js 2378 |
| 海盗船 | 大厅另一侧实体外观（同 M9 原则） | Lobby.js |
| **跑酷入口（旧 coin-path）** | `FACILITIES[0]` `key:'coin-path'`（line 76），视觉 `_buildCoinGallery()` 无尽发光长廊 + 悬空金币（line 1757）。**模块 1 将把 `key` 改为 `parkour-run` 并新建 ParkourRun.js 替换游戏逻辑。** | Lobby.js 76 / 1757 |

---

## ④ 现有昼夜 / 光照代码位置

- **全局唯一光照/雾/渲染管线**：`src/core/SceneManager.js`
  - `Fog(0xa8b0b4, 45, 130)`
  - `HemisphereLight(0xbfe3ff, 0x24331c, 0.5)`
  - `DirectionalLight(0xfff4e0, 1.8)` + 2048² 阴影（`shadow.bias=-0.0005`、`normalBias=0.02`、ortho ±45）
  - `ACESFilmicToneMapping`、`toneMappingExposure=0.38`、`PCFShadowMap`（r187 已移除 PCFSoftShadowMap）
  - 渲染链路：`EffectComposer → RenderPass → UnrealBloomPass → OutputPass`（色调映射在 OutputPass 内做，符合 r187 约束）
- **大厅天穹/地平线/光还原**：`src/attractions/Lobby.js`
  - Sky.js 片元着色器 patch（line ~241）压暗地平线
  - init 保存 bg/fog/light intensity，dispose 还原；**`light.shadow.dispose()` 是最大泄漏风险点，已显式处理**
- **结论**：当前**没有任何动态昼夜系统**（`grep -ri "dayNight|nightFactor|sunElevation"` 全 `src/` 零命中）。光照是静态白天。模块 7 将新建「昼夜系统 + 烟花系统」（单例），接管此处静态参数并做随时间插值；模块 9 的展开（反 AI 感渲染/色彩分级）在现有 EffectComposer 链路基础上增强。

---

## 落地纪律确认

- 顺序：模块 0（本报告）→ 模块 9（渲染管线，现有链路已满足基线，待增强）→ 模块 1（ParkourRun 替换 coin-path）→ 模块 2（JumpJump 替换 bouncing-ball）→ 模块 3+4（Carousel 对齐 + 第一人称坐姿）→ 模块 5（椅子坐下）→ 模块 6（NPC/人群）→ 模块 7（昼夜+烟花+站台）→ 模块 8（CenturyClock）。
- 每个模块交付附 `renderer.info.render.calls / triangles / memory.geometries / memory.textures` 实测值，并保证 `init → play → dispose` 后几何/纹理回落基线（大厅激活态 17/24，Δ=0/0）。
- 全程遵守 0.1~0.8 反 AI 感总原则 + 性能预算（大厅静态 ≤120 draw call，单设施 ≤200，全场景 ≤300k 三角面）。
- **已知缺口**：本次从 transcript 恢复的 v3 提示词在「7.6 验收」处被截断，模块 8（CenturyClock）、模块 9（渲染管线展开）、执行纪律细则的**详细逐条要求未包含在恢复文本中**，仅保留高层描述（模块 9=渲染管线；模块 8=CenturyClock.js；执行纪律=串行 7.5→7.6→8→9、昼夜/烟花为单例、逐模块自检）。实现时按高层描述 + 既有代码库合理推断，并显式标注假设。
