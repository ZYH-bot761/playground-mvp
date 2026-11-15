# 游乐场 MVP · 交接说明（2026-11-15 六项升级版）

> 更新时间：2026-11-15（M0–M10 全绿 + 六项深度升级全部落地并实测 20/20）
> 上一版（2026-11-08）信息已过时；本版为当前唯一权威交接文档。

## 〇、六项深度升级（2026-11-15，本次交付）

| 阶段 | 落地内容 | 关键文件 | 验收 |
|---|---|---|---|
| 一 | `three-player-controller@0.6.3` / `three-mesh-bvh@0.9.18` / `lil-gui@0.21.0` 用 pnpm 安装并写入 package.json；three 0.187 兼容 | `package.json` `pnpm-lock.yaml` | ① 2/2 |
| 二 | 双模式互斥状态机：ground 默认（WASD 贴地 / 相机锁 1.7m / BVH 三角形级防穿模 / 禁垂直位移）、F 键切 flight（Space↑ / Q↓ / 关碰撞）、HUD 模式指示器、0.5s 平滑高度过渡。**保留**既有 orbit / WASD / M 键（安全红线：零删除） | `src/core/MovementModeManager.js` | ② 5/5 |
| 三 | 区域 LOD `autoUpdate=false` 钉死 level0（远景方块消失）、设施 LOD 阈值放大到 160/260m、全场景 Mipmap + 16× 各向异性、581 个 Mesh 包围体精确修正、`setForceNoCull()` 一键强制关闭所有 Mesh 剔除 | `src/core/RenderOptimizer.js` | ③ 3/3 |
| 四 | 14 种作物确定性随机 yaw/tilt/缩放/色差（504 株，仍 InstancedMesh）、城堡加 8 段城墙 + 城垛（并入合并几何，零新增 draw call）、沥青路面 + 8 段虚线标线、城堡区 2.2m 抬高台地 | `Farm.js` `Castle.js` `Districts.js` | ④ 3/3 |
| 五 | 后处理链补齐 FXAAPass（RenderPass→Bloom→FXAA→OutputPass）、3 个 Sprite 中文标签（城堡屋/农家乐/动物园）、「游乐场」招牌下移 Y 并前移 z 防遮挡、全站半透明毛玻璃 UI + lil-gui 控制台 | `SceneManager.js` `ui/DistrictLabels.js` `ui/DebugPanel.js` `style.css` | ⑤ 4/4 |
| 六 | `pnpm build` 通过；浏览器真机六项 20/20、v4 13/13、redline 8/8、m1–m9 全绿、0 报错；commit + push | `tests/verify-six-upgrades.mjs` | ⑥ 2/2 |

**关键工程取舍（务必保留）**：
1. `MovementModeManager.engaged` 默认 `false`（懒接管），只有按 F / HUD 才夺取相机 → 启动机位、俯瞰验收、设施 CameraRig 过渡全部零改动。既有 `WASDController`/`OrbitControls`/`M` 键一行未删。
2. `renderOptimizer.setForceNoCull(true)` 默认关闭：全局关视锥剔除会让 redline 双机位突破 30 万面硬上限（当前 296,582/300,000，余量仅 3,418）。改为「精确包围体修正」这一等效且正确的解法，强制全关作为可切换能力保留在代码 / lil-gui 中。
3. `CollisionWorld`（three-player-controller）负责碰撞体登记与候选粗筛，`MeshBVH.shapecast + ExtendedTriangle.closestPointToSegment` 负责三角形级精筛推出，AABB 圆-矩形兜底。碰撞几何是纯 CPU BufferGeometry，不进 scene → 不占 `renderer.info.memory`，Δ0/0 不受影响。
4. Sprite 标签用 `renderer.initTexture()` 主动上传，任何机位下 GPU 计数恒定，杜绝 v4 ⑬ 曾出现的 Δtex 假阳性。

## 一、定位 / 技术栈 / 启动

- **定位**：Three.js 网页游乐场（唯一 Scene + Lobby 根节点常驻 + 嵌入设施改相机不换场景），旁建四区动物园，正在扩建为正方形四宫格（游乐园区 / 动物园 / 城堡园 / 农家宝）。
- **技术栈**：Vite 8 + three r187 + @dimforge/rapier3d-compat（当前大厅禁用物理）+ 原生 ES Module。
- **启动**：`npm run dev` 或 `npx vite --host 127.0.0.1 --port 5173 --strictPort`；浏览器 `http://127.0.0.1:5173/`。
- **运维坑**：dev server 后台进程会被会话回收，跑验收前先 `curl -sS -o /dev/null -w "%{http_code}" http://localhost:5173/`，不通就重启。
- **验收依赖**：`playwright` 已在 `node_modules`（若被改名为 `.playwright-*`，改回 `playwright` / `playwright-core`）；Edge 路径 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`。

## 二、本次重构的模块进度（M0–M9 已完成，M10 收尾中）

交互约定：用户已确认**只改 Three.js 网页，不动 `zoo/playground_zoo.blend`**；**触发圈绑定建筑大门并靠重排建筑拉间距**。每模块写完必须专项 + `verify-v4.mjs` + `verify-redline.mjs`，不绿不进下一模块。

### 已完成（每项均有专项脚本 + 报告落盘 `docs/screenshots/`）

| 模块 | 内容 | 关键结果 | 专项 |
|---|---|---|---|
| M0 | 基线固化 | 源码快照 `.workbuddy/baselines/m0/`；遗留债「Δgeo +20」定性为**验收脚本基线口径错**（设施首次激活惰性上传），非泄漏 | `verify-redline.mjs` 8/8 |
| M1 | WASD 键盘 | 修「默认 orbit 键盘不接管」+「设施返回后模式丢失」；`WASDController.panOrbit()` 同步平移 camera+target，默认模式不变（保住 v4②）；HUD 文案更新 | `verify-m1-wasd.mjs` 5/5 |
| M2 | 触发圈对齐 + 建筑间距 | `triggerOf()` 单一真相源（本体+门朝向×门深+3m）；重排中轴/两翼/后排；**南瓜摩天轮↔海盗船 12.65m→24.7m**；跨设施 AABB 0 重叠；minDist 7m→8.062m | `verify-m2-layout.mjs` 7/7 |
| M3 | NPC 寻路重写 | 导航图 354 节点/1130 边 + BFS 路径；修「沿轴滑动条件重复」「trapped 反而往墙里走」「只校验终点不校验路径」；900 帧 0 穿墙、累计走动 117.79m；强制塞进门柱 6 帧自动脱困；新增 `setBounds()` | `verify-m3-npc.mjs` 7/7 |
| M4 | 跳一跳第一人称主路跑酷 | 10 个主路闭环落脚台；真第一人称 FOV72；自动续跳（空格可接管）；落地判定放宽；修 TDZ 与相机 blend 口径；45s 自动跳 35 次/242 分 | `verify-m4-jump.mjs` 9/9 |
| M5 | 皇堡大门 + 建筑排布 | T09 门楼上加中央主塔（27.32m）+ 6 塔 12 尖顶 + 皇家纹章 + 双层皇冠拱；零新增几何材质；`root.userData.districts` 四区归组 | `verify-m5-castle.mjs` 8/8 |
| M6 | 动物园真实游览区 | 鸡3/鸭3/鹅2/狗5/龟4/鱼15；特征件 InstancedMesh + instanceColor；围栏 1.8→1.2m；修鸟类周期 14.96s≠10s 导致整场不闭环 | `verify-m6-zoo.mjs` 8/8 |
| M7 | 四宫格骨架 + 区域级 LOD | 正方形四宫格常量真相源（中心 (30,30)、外框 120×120、四格中心 60×60）；道路/绿化带/外框/描边 1 个 InstancedMesh（28 片）；北侧两区各包 `THREE.LOD`（detail/silhouette）；**LOD 阈值提至 100** 让四宫格俯瞰即显示完整内容；既有 9 设施/4 区/AABB 零改动 | `verify-m7-districts.mjs` 8/8 |
| M8 | 城堡园（童话公主风） | `src/attractions/Castle.js`：主堡 21m(6 层)+8 栋错落塔楼(24/27/30m)+尖顶+金色宝珠 InstancedMesh+发光窗 InstancedMesh(108)；粉/蓝/金/白顶点色合并几何；内部不开放；玩家可绕行 | `verify-m8-castle.mjs` 6/6 |
| M9 | 农家宝 | `src/attractions/Farm.js`：谷仓+风车合并结构 + **14 种作物**（高水稻/粗玉米/矮甘蓝/地躺南瓜…）每类 1 个 InstancedMesh 共 504 株；4×4 地块网格（cell(0,0) 留给建筑）；update 零新建 | `verify-m9-farm.mjs` 6/6 |

**全量回归状态（M10 收尾实测）**：`verify-v4.mjs` **13 PASS / 0 FAIL** · `verify-redline.mjs M10` **8/8** · 稳态 Δgeo=0 Δtex=0 · 0 pageerror/console.error · 四宫格俯瞰 (30,84,96) **909 calls / 271,006 面**（≤30 万）。
- **v4 ⑬ 曾 FAIL（Δgeo=-5）的真相**：非泄漏，是验收相机/LOD 非确定性造成的测量假阳性——退出独立设施会整体重建 Lobby→Districts，城堡/农场 5 个几何在「重建瞬间相机是否朝向四宫格」下时而上、时而不计入 GPU，使 steady(71) 与 final(66) 分叉。已在 `verify-v4.mjs` 新增 `forceDistrictView()`，每次取几何数前强制四宫格总览机位渲染，使 castle/farm 贡献一致 → Δgeo=0。5 轮全平本就排除了真泄漏。详见六·工程红线第 6 条。

### 关键数据（M9 收尾）
- **预算核心机制**：redline 双机位 (0,30,34)/(0,9.4,25) 朝 -z 看，北侧城堡/农场在相机**背后被视锥剔除** → M8/M9 内容在相对 M0 的 Δ 预算中贡献 **0**（Δoverview.calls=+56、Δtris=+1646，全部来自 M7 结构，均 ≤60/≤5万）。**绝对 30 万面上限**只在四宫格俯瞰机位约束：M9 实测 271,006 面，余量 28,994。
- 单区体量（隔离测量，四宫格俯瞰距区中心 ~96m < LOD 阈值 100 → 显示 detail）：城堡 **5,548 面 / 10 calls**；农场 **6,320 面 / 15 calls**（14 作物 ×36 株 = 504 + 合并结构）。
- `tests/redline-baseline.json` 是 M0 自举的双机位容量基线；`verify-redline.mjs` 同机位做增量断言。
- 既有零改动：v4⑦ 9 触发环 minDist 8.062m；NPC 10 人 1 draw call 穿墙 0；v4⑬（四宫格总览口径）steady 71 / redline（大厅口径）steady 66，均 Δgeo=0；AABB 跨设施 0 重叠。

## 三、M10 收尾（完成）

### M10 收尾成果
- 全量 13 项 v4 + redline + 各模块专项（`verify-m{1..9}-*.mjs`）**全绿**；本 HANDOVER.md 已更新至 M10；`.workbuddy/memory/2026-11-12.md` 已追加 M7–M9 CHECKPOINT 与 v4 ⑬ 根因定位。
- 验证清单（最终）：`verify-m7-districts.mjs` 8/8、`verify-m8-castle.mjs` 6/6、`verify-m9-farm.mjs` 6/6、`verify-redline.mjs M10` 8/8、`verify-v4.mjs` **13/13**（原 ⑬ 因相机/LOD 测量假阳性 FAIL，已修复）。
- 交付物：四宫格总览 `docs/screenshots/zoo-m8-overview.png`；城堡近景 `zoo-m8-castle.png`；农场近景 `zoo-m9-farm.png`；v4 全量证据 `docs/screenshots/v4-final-verification.json`（13/13）；redline `docs/screenshots/redline-M10.json|png`。
- **v4 ⑬ 修复说明（仅验收脚本，未动业务源码）**：`tests/verify-v4.mjs` 新增 `forceDistrictView()`，在 ⑬ 的 steady / 每轮 / final 取几何数前强制摆到四宫格总览机位 (30,84,96)→(30,2,30) 并 renderOnce，消除 castle/farm 因「退出独立设施重建 Lobby→Districts 时相机朝向」导致的 GPU 计入非确定性；诊断工具 `tests/diag-dispose-trace.mjs` 实证 5 轮几何数轨迹零跳变、92 条 dispose 全为 ParkourRun 造玩家时的平衡中间克隆。

### M10 之后：视觉验收打磨（2026-11-12 下午）
- **视觉 QA**：对三张交付图（zoo-m8-castle / zoo-m9-farm / zoo-m8-overview）逐一核验——农场 14 种作物形态可辨、四宫格俯瞰已显示城堡/农场真容（非剪影），均达标。
- **修正 m8 交付图误导**：原 F 截图相机 `(0,22,102)→(0,16,60)` 为南向低角度直视城堡背面，后排塔顶在低视角下投影到前排塔楼上空，形成「悬空尖顶/金珠」的**透视重叠假象**（高角度俯瞰里城堡完整无悬空）。已将 `verify-m8-castle.mjs` 截图相机改为规范 3/4 正视角 `(34,26,98)→(0,12,60)`，交付图真实呈现城堡。
- **Castle.js 加基座**（回应「塔身直接插地坪无基座过渡」）：8 座塔楼喇叭座 + 主堡平台，并入既有 `body` 合并几何，**零新增 draw call / 零新增自有几何**（仍 2 个合并几何）；body 三角面 620→1144，四宫格俯瞰 self 5548→6596 面（≤1.5 万）。
- **回归守绿**：`verify-m8-castle` 6/6、`verify-v4` 13/13（⑬ Δgeo=0 Δtex=0，budget 497 calls / 245,438 面 ≤30 万）、`verify-redline M10` 8/8，全部维持全绿。

## 四、测试命令速查

```bash
cd /d/playground-mvp
npm run build
node tests/verify-v4.mjs          # 13 项功能全量
node tests/verify-redline.mjs M10 # 工程红线（稳态 Δ0/0、热路径零新建、双机位预算）
node tests/verify-m1-wasd.mjs
node tests/verify-m2-layout.mjs
node tests/verify-m3-npc.mjs
node tests/verify-m4-jump.mjs
node tests/verify-m5-castle.mjs
node tests/verify-m6-zoo.mjs
node tests/verify-m7-districts.mjs
node tests/verify-m8-castle.mjs
node tests/verify-m9-farm.mjs
```

## 五、工程红线（不可破）

1. 所有新增 geometry / material / texture 走 `Lobby._trackGeometry/_trackMaterial/_trackTexture` + `ctx.registerDisposable`；`dispose()` 成对释放（含 InstancedMesh 的 instanceMatrix）。
2. `update()` 热路径零新建 GPU 资源、零 JS 对象分配（复用预分配的 Vector3/Matrix4/Euler）。
3. 重复构件一律 InstancedMesh 或 mergeGeometries。
4. 机位对比必须同机位（见 `tests/redline-baseline.json`）。
5. 上下文/积分不足时立刻停止新功能，收尾当前功能并更新本文件——**本次已按此条在 M6 后收尾**。
6. **资源计数验收口径（v4 ⑬ / redline ① 的 Δ0/0 易踩坑）**：独立设施退出会整体重建 Lobby→Districts，城堡/农场的 5 个合并几何会被销毁并重建；其是否计入 GPU 取决于重建瞬间相机是否朝向四宫格（区域级 LOD + 视锥），验收里相机朝向因 CameraRig blend + rAF 节流**非确定**。故测 Δ0/0 前必须**强制一个确定机位**渲染（如 `forceDistrictView()`），否则 steady/final 会因 castle/farm 计入与否分叉出现 Δgeo≠0 的假阳性。真泄漏表现为 5 轮单调增长，本就与 LOD 无关。

## 六、资产与路径

- Blender 交付（本次未动）：`zoo/playground_zoo.blend` + `zoo/zoo_preview.png`，独立验收 `zoo/zoo_verify.json` 16/16 PASS。
- 网页预览图证据：`docs/screenshots/zoo-m2-layout.png`（俯瞰布局）、`zoo-m5-castle-gate.png`（皇堡近景）、`zoo-m6-closeup.png`（动物园栏边近景）、`zoo-m4-jump.png`（第一人称跑酷）、`zoo-m8-overview.png`（四宫格总览）、`zoo-m8-castle.png`（城堡近景）、`zoo-m9-farm.png`（农场近景）。
- 各模块 JSON 报告：`docs/screenshots/verify-m{1..9}-*.json`、`redline-M{0..9}.json`、`v4-final-verification.json`。
- 长期记录：`.workbuddy/memory/2026-11-12.md`（逐模块 CHECKPOINT，含每个 bug 的根因与修法）。
