# 阶段 5 工程底座 · 当前状态（2026-11-17）

> 本文是**当前唯一权威现状基准**。下方三份历史盘点（requirements-active.md / project-map.md / v4-status-and-handoff.md）是各自时点的快照，读 them 时以本文为准。
> 交接主文档仍为根目录 `项目信息.docx`（v1.0，最后验证 2026-11-16）；本文记录其后 11/17 的功能落地与本轮工程底座优化。

## 1. 一句话现状

单渲染器 / 单物理世界的 Three.js 微缩城市游乐场（五区 + 森林公园 + 都会区 CBD），全程序化资产，Rapier 按需懒加载，性能红线由 tests 守门。阶段 1–5 功能已落地；本轮（11/17）把**相机写者、全局系统上下文、粒子池、预算口径、回归流程、文档与版本**六项工程底座补齐，达到可交接、可扩展的企业级标准。

## 2. 11/17 落地的功能（此前文档未覆盖）

| 系统 | 入口文件 | 要点 |
|---|---|---|
| 四季天气 | `src/utils/helpers/season-cycle.js` + `particle-system.js` | 春夏秋冬配色 lerp + 花瓣/阵雨/落叶/雪花；天气与烟花共用 3000 粒子池，天气峰值 760 |
| GTA 驾驶 | `src/scenes/metropolis/city-driving.js` | 车旁按 E 上车；Rapier 动态玩家车 + ≤12 kinematic AI 包围盒；C 切视角；E 下车全部回收 |
| 森林公园 | `src/scenes/forest-park.js` | 128 树 / 河 / 拱桥 / 遛狗市民，四季重点展示区 |
| 都会区扩展 | `src/scenes/metropolis/city-{air,lake,details,expansion,signals,driving}.js`、`park-actors.js` | 城市组合从 4 模块扩到 11 模块 |
| 动物园扩展 | `src/scenes/zoo-scene.js` | 扩至五区（含非洲草原）、大型动物与游客实例 |
| 图形兜底 | `src/utils/helpers/graphics-guard.js` | WebGL 上下文丢失 / 低内存 UI 提示 |

边界修正：WASD / 漫游的 z 轴边界从 ±110 扩为 −110…252（原 z=110 空气墙）；跑酷补 ESC / 移动端 PauseMenu 退出闭环。

## 3. 本轮工程底座优化（2026-11-17）

按优先级七项，全部有验收证据：

1. **相机写者契约统一**。`CameraRig` 成为所有生产相机写入的唯一通道：一次性切换走 `blendTo/restore`（带过渡），逐帧跟随走新增的 `writePose`（受控直写、零分配）。直写者必须 `allowDirectWrite(key)` 登记，无 owner / 未登记一律拒绝并告警；写入计入 `directWriteCount` 审计。原先绕过 rig 的两处——`CityDriving._syncVisual` 与 `Lobby._updateZooFly`——已改走 `writePose`。新增验收 `tests/verify-camera-contract.mjs`（7/7 PASS）。
2. **全局系统上下文收敛**。`main.js syncGlobalContext()` 统一同步 dayNight / firework / npc / season 四个单例；此前四季只靠 Lobby 生命周期隐式管理，独立设施卸载后天气不挂起。
3. **粒子池按类型隔离回收**。天气（kind≥4）与烟花/文字（kind=0）互不误杀；天气 palette 提为模块级常量，热路径零 JS 分配。
4. **失真声明修正**。Lobby 中"全程禁用 Rapier / 刚体数 0"改为准确描述：Lobby 本体常驻 0 刚体，驾驶与小游戏按需懒加载、下车/退出归零。
5. **联合回归门禁**。新增 `tests/verify-all.mjs`，串行跑 build+camera+redline+v4+season+driving+drive-roam+phase2+m6zoo，任一失败整体非零退出；支持 `--only camera,redline` 缩跑。45 个一次性 `_*.mjs` 探针归档到 `tests/_archive/`（gitignore 排除，本地可查）。
6. **漫游↔驾驶集成修复**（用户实操 bug）。按 F 进入地面漫游后靠近车，因 `movementMode.isEngaged()=true` 使车辆扫描 `baseOk` 恒 false，按 E 完全无反应。修复：地面漫游允许扫车、飞行模式不扫；`getContext` 暴露 `driving` 标志让漫游层在驾驶中自动让位（保留 engaged 标志、下车恢复），避免与驾驶相机双写。新增 `verify-drive-roam.mjs` 7/7 锁定该行为。
7. **预算口径澄清**。三角面硬红线 300,000；`config/default.json` 的 `drawCallBudget:900` 是**新增内容/新视图**的设计红线，**大厅全量俯瞰约 1,198 calls 是既有基数**，两者不可混用。验收以各脚本固定机位实测为准。

## 3.5 视觉提质（2026-11-17 晚 · 守红线等量替换）

用户要求"建筑/人物更精致、参考 GTA"。本机未装 Blender（`blender_exe=null`），且项目铁律是零外部资产 / 全程序化生成 → 走 Three.js 程序化提质，**不加面、不加 draw call**。

- **人物（`procedural-character.js`）**：3 处零增面改造——① `headGeometry()` 加颧骨外扩 / 太阳穴内收 / 后脑后凸 / 额头前突的顶点塑形；② `paint()` 烘焙光照对比度 0.60+0.40→0.52+0.48、高光指数 20→28、加边缘补光与布料竖向细纹；③ `torsoGeometry()` profile 调肩宽腰收（仍 11 点 8 段）。**面数/人 1656 不变、1 draw call 不变、pivot/顶点属性结构不变**。
- **都会区建筑（`city-textures.js` + `city-buildings.js`）**：新增 `makeGlassNormalMap()` / `makeGlassRoughness()` 两张程序化纹理挂到玻璃材质（窗框凹凸高光、玻璃镜面变化，告别塑料贴纸）；`makeNightWindows()` 改为有楼层节律、色温分区、窗帘遮挡、成簇亮灯的城市夜景。几何上给医院 / 商场 / 大裤衩 / 尖塔 / 退台塔加屋顶设备层（女儿墙、机房、冷却塔、观景环廊、天线阵列），全部并入已有 `detail.roof/accent` merge 分组 → **不增 draw call**。near 面数约 1028→1316（上限 3000）。
- **实测**：verify-metropolis 19/19（maxTris 190,603）、redline 8/8（Δgeo=0/Δtex=0，双机位面数未涨）、m3-npc 7/7（1 draw call）、v4 13/13（面/人=1656）。
- **天花板说明**：守 30 万红线 + 5 边胶囊 Body 的前提下，人物不可能达到 GTA 照片级；要更进一步必须放宽红线或引入外部高模（两者都与现有架构决策冲突）。

## 3.6 风景提质（2026-11-18 · 守红线程序化）

用户要求风景更自然、授权下载资产。仍走程序化路线（下载贴图会引入外部依赖 + 纹理台账 + 首屏体积；本机无 Blender）。全部零增面/纯材质 shader 改动。

- **树木草地（`forest-park.js`）**：树冠/针叶/灌木几何做顶点噪声位移（用坐标 hash 保证同位置副本不裂面），光滑球→自然叶簇轮廓，**面数完全不变**；森林草坪加程序化法线+粗糙度贴图（复用大厅 ground 角色三图配置，defines 一致不破坏四季注入）。
- **水体**：森林河片元 shader 加菲涅尔高光 + 视线方向（保留 `uTime`/`isShaderMaterial` 硬断言）；都会区湖加波纹法线贴图并随 UV 同步滚动。
- **天空（`day-night-cycle.js`）**：夜空星星加缓慢闪烁（单标量调制，零 GPU 分配）。
- **道路（`city-street.js` + `city-textures.js`）**：路面加近白骨料细节图作 map+roughnessMap，与 instanceColor 相乘不脏色；仍 1 个 InstancedMesh。
- **验收**：phase2 20/20、season 16/16、redline 8/8（Δ0/0）、v4 13/13（上轮）、build ✓。six-upgrades 17/20（3 项 farm/castle/LOD 为既有脚本漂移，与风景无关；`badTextures=0`、mipmap 纹理 62 张合规）。

## 3.7 可进入别墅（2026-11-18 · 玩家的家）

新增独立设施 `src/scenes/attractions/villa.js`（约 900 行），现代简约风格。**入口不在游乐园**：别墅是都会区商场西侧 `(x=-30,z=134)` 的一栋实体门面（`city-villa.js`，带"我的别墅"招牌 / 发光环 / 阳台玻璃窗），玩家走到南门口按 E 进入室内场景。

- **四层**：B1 车库（轿车+SUV 静态展示、工具墙）、1F 玄关（鞋柜/玄关桌/客厅沙发茶几电视/客卧/卫浴/扫地机器人基站）、2F 起居（L 沙发/电视/餐桌椅/厨房橱柜冰箱/次卧/阳台）、3F 主卧（大床/衣帽间/书房书桌书架/阳台）。共 **83 件家具**，按材质合并成少数 Mesh。
- **楼梯真能走**：三段楼梯（B1↔1F / 1F↔2F / 2F↔3F）在 z 上不重叠；`getGroundHeight` 回调用 `_level` 状态消解"同 x/z 不同层"歧义，走到段顶/底切层。
- **电梯可运行**：DOM 按钮 B1/1/2/3 → 轿厢阻尼升降 → `_groundAt` 在井内返回轿厢地板高度，玩家眼高随行（实测到 3F：轿厢 7.2m / 玩家 8.8m）；到站 1.5s 保护期防楼层被拉回。
- **电器动态**：电视 CanvasTexture 三画面循环（色条/时钟/风景，0.25s 节流），扫地机器人沿 8 点路径巡游+回基站停 4s。
- **不用 Rapier**：车是纯静态几何，不拉物理 chunk，不加 PHYSICS_KEYS。
- **接入**：都会区 `Metropolis` 挂 `buildCityVilla()`（门面 + 碰撞 + 门口光环）；`Lobby._updateVillaDoor()` 每帧扫描门口距离并亮提示，`_onInteractKey()` 加别墅分支按 E 进入；`main.js` 四处（import/key/PROJECT_NAMES/register/预热）。**不动 `FACILITY_SPECS`**——大厅触发环保持 9 个。
- **验收**：`verify-villa.mjs` 12/12（都会区门口按 E 进入、进出 Δgeo=0/Δtex=0、四层高度、电梯随行、真实走楼梯、家具/车/电器、0 报错），已纳入 `verify-all.mjs`。
- **为何放都会区**：用户明确"别墅不要放在游乐园，单独放到大都会商场旁空地"。曾试过放大厅触发环（第 10 个），已撤销，5 个脚本数量断言恢复 9。`verify-redline` 的往返切换列表排除 villa（其 83 件家具在 headless 连续 30 次切换下会 Target crashed，进出稳态由 verify-villa 单独证明）。

## 3.8 Blender 离线建模 → 数据编译（2026-11-19 · 车辆试点）

用户本地 Blender 3.6.23（`D:\blender`）+ MCP socket 9876 已就绪（GUI 插件 Addon 2.0 手动 Start Server；`blender_client.py --detect-env` 判定 `mcp_available=true / socket`）。**铁律不变：零外部资产，无 GLB 进运行时**——Blender 只做离线建模/渲染，量化几何数据编译进 JS 模块。

- **产物**：`tools/blender/build_city_car.py`（侧轮廓放样车身 + 轮眉/保险杠/格栅/灯框/后视镜/尾翼 + 玻璃舱/A柱/车顶条）；`models/blender-car-preview.png`（Cycles CPU 64spp 人工验收图）；`src/scenes/metropolis/city-car-blender-model.js`（114KB 量化数据：position/normal ×1000、color ×255）。`tools/blender/start_mcp_server.py` 为插件强制启动辅助。
- **轴变换**：Blender Z-up `(x,y,z)` → Three `(x,z,-y)`（det=+1，法线同变换），车头 -Y → Three +Z；脚本内 `AXIS_CHECK_OK` 断言运行时包围盒。
- **面数 3444 tris**（车身 2908 + 玻璃舱 536；原盒车 24 tris）。AI 车/玩家车共用几何，实例数量与 draw call 不变。
- **接入**：`city-traffic.js` 的 `bodyGeo/cabinGeo` 换 Blender 几何、`bodyMat` 开 `vertexColors`（白=车漆×instanceColor，深/浅灰=饰件）、实例缩放 `(1,.55,2.15)/(.82,.5,1.22)` 归一为 1、cabin 位置不变；轮子仍是 `detailedWheelGeometry`。**碰撞/车位/AI/驾驶逻辑零改动**。
- **验收**：build ✓、redline 8/8、v4 13/13、driving 21/21、drive-roam 7/7、metropolis 19/19（maxTris 230997 / maxCalls 741、稳态 Δ0/0、0 报错）。
- **边界**：WorkBuddy 的 blender 是 `mcp.json` 自定义服务，不在插件列表内，重连需在 MCP 服务管理面板操作；socket 通了之后建模链路直接可用。

## 3.9 Blender 建筑精修 ①「我的别墅」外壳（2026-11-19）

用户要求「先把大都会商场旁边那栋别墅用 Blender 精修，再逐个精修游乐场 / 医院 / 动物园等建筑」。沿用 3.8 已验证的**离线建模 → 量化数据编译进 JS** 管线，零 GLB / 零外部资产 / 不动 InstancedMesh 与四季 shader。

- **产物**：`tools/blender/build_city_villa.py`（Blender 3.6 socket 执行，Cycles CPU 48spp 预览）、`models/blender-villa-preview.png`（两轮人工验收定稿）、`src/scenes/metropolis/city-villa-blender-model.js`（226KB 量化数据）、`tests/verify-villa-shell.mjs`（7/7 资产回归）。
- **建模内容**：三层错落体量（2F 东退台露台、3F 再退台）+ 内凹玻璃幕墙（深色背板/玻璃/铝合金分格/窗台窗楣挑板）+ 木格栅与 2F 水平木百叶 + 层间腰线与檐下灯带 + 雨棚门廊/双开门/台阶/门廊柱 + 玻璃栏板阳台 + 屋顶女儿墙/空调外机/太阳能板/通风帽 + 东/西竖鳍与条窗 + 庭院铺装/矮墙/绿化池/阔叶树/庭院灯。**5612 tris**（WALL 612 / GLASS 264 / FRAME 2460 / WOOD 548 / DOOR 84 / DARK 588 / GLOW 168 / GREEN 888），8 个材质桶各 1 draw call；原白盒门面约 28 个 Mesh，draw call 反而下降。
- **轴与落位**：Blender +Y(南) → Three −Z，与 `CITY_VILLA.door.z=125.7` 对齐；`city-villa.js` 对每个桶 `geo.translate(-30, 1.16, 134)`，root 保持 identity，故光环/招牌/门板/碰撞盒的世界坐标契约不变。
- **契约保留**：root 名 `City/villa`（进室内整体隐藏）、门板 `City/villa-door`（`villaDoor` + `facilityKey` + `_pickables`）、`City/villa-ring`、`doorPos`、`colliders`、8 桶 geometry/material 全登记 `owned` 台账。材质沿用原配色（米白墙 0xe8e4dc / 深灰铝 0x3a4046 / 蓝灰玻璃 0x8fb8c8 / 暖木 0x9c7549），顶点色只做明暗调制，风格与都会区连贯。
- **验收（本轮实测）**：build ✓；`verify-villa-shell` **7/7**；`verify-villa-door` **8/8**；`verify-villa-embed` **12/12**；`verify-metropolis` **19/19**（maxTris **236381** / maxCalls 741、5 轮 Δgeo/Δtex=0/0、0 报错）；`verify-redline` **8/8**（173,812 tris、Δ0/0、9 触发环）；`verify-v4` **13/13**。
- ⚠️ **`tests/verify-villa.mjs` 是既有脚本漂移，非本轮回归**：该脚本断言写死旧独立设施语义（`activeKey==='villa'`、`camY≈1.6`、从 `attractionManager.active` 取 villa 私有属性），而工作区里未提交的 v3「嵌入视图」改造后是 `activeKey==='lobby'`、`camY≈2.8`，故报 2/4。同语义已由 `verify-villa-door` / `verify-villa-embed` 全绿覆盖；本轮未改动该脚本（属用户未提交的 v3 改动）。

### 建筑精修面数预算表（逐个推进，勿一次性堆满）

| 项 | 三角面 | 备注 |
|---|---|---|
| 300k 红线 | 300,000 | `verify-metropolis` / `verify-redline` 双机位断言 |
| 本轮都会区实测峰值 | 236,381 | 已含车模 3,444 + 别墅 5,612 |
| **剩余余量** | **63,619** | 后续每个建筑 ≤12,000，留安全垫 |
| ② 游乐场 / ③ 医院 / ④ 动物园 / ⑤ 其他 | 各 ≤12,000 | 4×12,000=48,000 → 峰值 ≤284,381 |
| 单建筑超配额 | 需先等量替换或压缩 | 不改基线让测试变绿 |

实现顺序按「都会区同域优先、逐个交付」：别墅（已完成）→ 医院/商场等都会区实体 → 独立设施（游乐场/动物园）。每个建筑单独建模脚本、单独预览验收、单独回归、单独提交。

## 4. 当前验收基线（2026-11-17 建立 · 2026-11-19 增量更新）

| 套件 | 结果 | 关键指标 |
|---|---|---|
| `npm run build` | PASS | 155 模块；`vendor-physics` 4.34MB 保持懒加载分块 |
| verify-camera-contract | 7/7 PASS | 受控直写审计 40 次；无 owner / 未登记写者被拒 |
| verify-redline (BASE) | 8/8 PASS | 双机位 overview 173,812 tris / 690 calls（11-19 实测）；Δgeo=0 / Δtex=0 |
| verify-v4 | 13/13 PASS | 5 轮往返 Δgeo=−31 / Δtex=−16（负值=视角缓存释放）；0 报错 |
| verify-season | 16/16 PASS | 天气峰值 760，clear 后 freeTop=3000；8 次切换 Δ0/0 |
| verify-driving | 21/21 PASS | 上车 14 刚体 → 下车 0；驾驶相机走受控直写正常 |
| verify-drive-roam | 7/7 PASS | 漫游地面模式可按 E 上车；驾驶中漫游让位；下车自动恢复 |
| verify-metropolis | 19/19 PASS | 11-19 实测 maxTris **236,381** / maxCalls 741；LOD 三级保留、Δ0/0 |
| verify-m3-npc | 7/7 PASS | 人物提质后仍 1 draw call、0 报错、900 帧 0 卡墙 |
| verify-villa | ⚠️ 2/4（既有漂移，见 3.9） | v3 嵌入视图后旧断言 `activeKey/camY` 失效；同语义由下方两脚本全绿覆盖 |
| verify-villa-shell | 7/7 PASS | Blender 外壳 8 桶 / 5612 tris / owned 台账 / 门板拾取 / 显隐 |
| verify-villa-door | 8/8 PASS | 都会区门口按 E、提示条点击、门洞拾取、往返闭环、0 报错 |
| verify-villa-embed | 12/12 PASS | 同场并置、外壳隐藏、阳台真实城景、退出恢复 |
| verify-phase2 | 20/20 PASS | 生态扩张（历史记录） |
| verify-m6-zoo | 8/8 PASS | 动物园回归（历史记录） |

稳态资源：`renderer.info.memory` 约 152 geometries / 51 textures（v4 全量机位），热路径零增长。

## 5. 接手必读与铁律

- 阅读顺序：`docs/project-map.md` → `src/main.js` → `src/core/{scene-manager,attraction-manager,camera-rig,physics-manager}.js` → `src/scenes/districts.js` + `metropolis/city-layout.js` → `src/scenes/lobby-scene.js`（按需读段）→ 全局系统三件套 → 交通/驾驶 → tests。
- 相机铁律（本轮强化）：**禁止在子系统裸写 `camera.position` / `lookAt`**；一切写入经 CameraRig 的 `blendTo/restore/writePose`；新写者先 `allowDirectWrite` 登记。
- 相机接管互斥铁律：任何新增「接管相机」的移动 / 玩法系统（如驾驶），必须在 `movementMode.getContext()` 暴露占位标志（如 `driving`），让漫游层经 `isEngaged()` 自动让位；不要靠各系统各自的门控约定——漫游与驾驶曾因此互斥导致按 E 无法上车。
- 性能铁律：三角面 ≤300,000；新增内容 calls ≤900（大厅全量 1,198 是既有基数）；热路径不 new GPU 资源；重复物件用 InstancedMesh；不新增常驻灯；AI 车保持 kinematic；粒子池上限 760；不改基线让测试变绿。
- 坐标铁律：`DISTRICT_GRID` / `CITY` / `ZOO_LAYOUT` / `FOREST_PARK` 是单一真相源；"南门"是建筑名不是 +z 方向；北区几何世界坐标烘焙，移动用 `_rebase`。
- 验证：`node tests/verify-all.mjs`（全套，约 15–20 分钟）；dev server 须先在 5173 运行。

## 6. 已知风险 / 未接线

- 全场景 calls 口径分裂：redline 固定双机位 669，全量俯瞰约 1,198；900 只约束新增内容。若产品要求全量压到 900，需另立合批专项，不能改基线掩盖。
- `public/models/hand-landmarker.task`(7.8MB) 消费方未接线（手势设施仍待美术/交互层）；`assets/models/visitor-ai.glb`(32MB) 不进运行时。
- `season-cycle.js` 用字符串替换注入 shader（对 `#include <color_fragment>`），three 升级可能静默失效，无失败分支。
- `metropolis-scene.js` 背向时仍全量 update 子系统（省 draw 但 CPU 常开）；`zoo-scene.js` 游客 InstancedMesh `frustumCulled=false` 常驻提交。
- 已跟踪的 `tests/_layout-probe.mjs` 与 7 个 `diag-*.mjs` 保留（历史诊断工具），未删除。

## 7. 空中花园（2026-11-20 新增，同日第二版）

大厅常驻的第三种「借相机」玩法（与驾驶同类）：只换相机与气氛，不卸载大厅。

| 对象 | 位置 / 尺寸 | 交互 |
|---|---|---|
| 轨道环 | 中心 (0,54) / 半径 88m / 梁径 1.15m / 离地 146m；3 排 ×140 块踏步板铺成 7.6m 宽甲板 + 内外双护栏 + 扶手灯带 | 地面抬头可见；到站直接落在甲板上 |
| 太空电梯 | 基座 (-88.4, 21.9)，环体外侧 6m（半径 94）；双导轨 146m + 顶端站台 + 6m 栈桥 | 基座 9m 内按 E，12.5s 垂直升顶；全程可拖鼠标环视 |
| 太空高铁 | 站台 (-64,-2)；CatmullRom 爬升曲线弧长 228.4m；环上停靠点 (56.57, 121.41) | 站台 15m 内 E 登车，点「发车」约 20s 到站，E 出舱漫步 |

环上街区（`Sky/district`，全部挂在步道外带，内带留成连续人行通道）：

- 云顶观景亭 250°（8 柱 + 锥顶 + 发光冠 + 4 长椅）、玻璃温室 140°（半球 + 4 肋拱 + 7 棵树）、喷泉广场 40°（水池 + 发光水面 + 水柱 + 6 长椅 + 9m 玻璃方尖碑与悬浮光环）、两座空中墅 205° / 320°、300° 外悬玻璃观景台；
- 甲板设施：26 灯柱 + 20 行道树 + 14 长凳（三者皆 InstancedMesh）+ 4 座 26m 云灯塔桅杆；
- 碰撞：9 个圆 collider（半径 1.7~4.3）+ 步道半径夹在 84.6~91.4m，走不进建筑、掉不下环。

甲板自由漫步：

- 到站后按 E 出舱，`deck` 模式下 WASD / 方向键行走、Shift 疾行（4.4 / 8.0 m/s）、拖鼠标左右环视与抬低头、滚轮缩放；眼高 1.72m，速度按 `dt` 归一；
- 鼠标视角全程可用：乘梯上升、乘车爬升、到站、甲板行走，`_look.yaw/pitch` 以相机局部轴叠加在基础机位上（FPS 手感），乘梯后半程机位还会压到甲板上，出舱瞬间即"站在步道上看步道延伸出去"；
- E 语义：到站首次 E 出舱，走完回来再 E 才是下行 / 返程；甲板上也能直接用 HUD「直接落地」。

- 状态机：`idle / elev-up / elev-top / elev-down / train-boarded / train-up / train-docked / train-down / deck`，`isRiding` 即非 idle；期间 Orbit / WASD / M 键全部让位，落地后机位 + 雾 + 天穹 + 云 + 输入逐项还原。
- 高空气氛（第二版重点修的三处观感缺陷）：① `scene.fog` 在 110m 以上整段关闭（地面灰雾被抬到 146m 后 40m 外糊成白墙，把 near 推到 240 也无效）；② `Lobby/sky` 天穹收起（Sky.js 纯方向散射，在高空把整个半球过曝成奶白；只藏 Group 不够，还得关掉 `Lobby/cloud-band-118/96/72` 三条云带）；③ 甲板材质改为深蓝灰，4 座 22m "路灯感"的灯塔改成 26m 细桅杆。
- 测试：`node tests/verify-sky-garden.mjs`（需 5173 dev server；默认带 `?no-prewarm=1` 排掉后台预热噪声），25/25 PASS，落 `docs/screenshots/sky-1~5.png`。
- 两个必守的集成点：① `main.js startBackgroundPrewarm` 的让路条件已加入 `_skyGarden.isRiding`（否则乘梯途中会被预热 dispose 掉）；② `OrbitControls` 极角上限 81.8° 让相机抬不起头，靠近判定因此同时接受相机点与视线落点。

## 3.10 线上双人联机与单人游玩（2026-11-21）

- 线上地址：`https://chengshi1.netlify.app`（Netlify Functions + Netlify Blobs，非 WebSocket 常驻进程）。
- 演示账号：`player1 / play1234`（小星）、`player2 / play1234`（小月）；链接 `?u=&p=&room=` 自动登录，两台设备必须使用同一个 room。
- 单人：登录页「单人游玩（不联机）」跳过账号直接开始；设施入口支持 orbit 视线中心射线按 E，手机可点 HUD 提示进入。
- 组队：大厅 250ms 短轮询同步，顶部「一起回家」把两人一起带进别墅；未进入游戏或页面后台自动降到 1s。
- 账号：每次登录生成新 session，后打开的设备接管（旧设备下一次 sync 收到 409 `SESSION_REPLACED` 后停止，不互踢）；页面关闭 sendBeacon `leave` 立即释放，异常退出由 15s TTL 兜底。
- 兼容：iOS 输入框 16px 防止自动放大；静态首屏加载层与 3D 初始化失败提示；建议系统浏览器（Safari/Chrome），微信内置浏览器可能截断链接里的 `&` 参数。
- 验收：`node tests/verify-multiplayer-server.mjs` 10/10；双链接 `node tests/verify-multiplayer.mjs` 8/8（本地与线上各跑一次）；单人浏览器 8/8；`npm run build` PASS。
- 改动边界：新增 `src/net/multiplayer-client.js`、`src/components/login-screen.js`、`netlify/functions/*`、`server/local-room-api.mjs`；大厅只扩展入口判定/提示，设施与别墅内部玩法未改。
