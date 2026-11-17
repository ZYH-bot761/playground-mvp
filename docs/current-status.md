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

按优先级六项，全部有验收证据：

1. **相机写者契约统一**。`CameraRig` 成为所有生产相机写入的唯一通道：一次性切换走 `blendTo/restore`（带过渡），逐帧跟随走新增的 `writePose`（受控直写、零分配）。直写者必须 `allowDirectWrite(key)` 登记，无 owner / 未登记一律拒绝并告警；写入计入 `directWriteCount` 审计。原先绕过 rig 的两处——`CityDriving._syncVisual` 与 `Lobby._updateZooFly`——已改走 `writePose`。新增验收 `tests/verify-camera-contract.mjs`（7/7 PASS）。
2. **全局系统上下文收敛**。`main.js syncGlobalContext()` 统一同步 dayNight / firework / npc / season 四个单例；此前四季只靠 Lobby 生命周期隐式管理，独立设施卸载后天气不挂起。
3. **粒子池按类型隔离回收**。天气（kind≥4）与烟花/文字（kind=0）互不误杀；天气 palette 提为模块级常量，热路径零 JS 分配。
4. **失真声明修正**。Lobby 中"全程禁用 Rapier / 刚体数 0"改为准确描述：Lobby 本体常驻 0 刚体，驾驶与小游戏按需懒加载、下车/退出归零。
5. **联合回归门禁**。新增 `tests/verify-all.mjs`，串行跑 build+camera+redline+v4+season+driving+phase2+m6zoo，任一失败整体非零退出；支持 `--only camera,redline` 缩跑。45 个一次性 `_*.mjs` 探针归档到 `tests/_archive/`（gitignore 排除，本地可查）。
6. **预算口径澄清**。三角面硬红线 300,000；`config/default.json` 的 `drawCallBudget:900` 是**新增内容/新视图**的设计红线，**大厅全量俯瞰约 1,198 calls 是既有基数**，两者不可混用。验收以各脚本固定机位实测为准。

## 4. 当前验收基线（2026-11-17 实测）

| 套件 | 结果 | 关键指标 |
|---|---|---|
| `npm run build` | PASS | 155 模块；`vendor-physics` 4.34MB 保持懒加载分块 |
| verify-camera-contract | 7/7 PASS | 受控直写审计 40 次；无 owner / 未登记写者被拒 |
| verify-redline (BASE) | 8/8 PASS | 双机位 overview 173,956 tris / 669 calls；Δgeo=0 / Δtex=0 |
| verify-v4 | 13/13 PASS | 5 轮往返 Δgeo=−31 / Δtex=−16（负值=视角缓存释放）；0 报错 |
| verify-season | 16/16 PASS | 天气峰值 760，clear 后 freeTop=3000；8 次切换 Δ0/0 |
| verify-driving | 21/21 PASS | 上车 14 刚体 → 下车 0；驾驶相机走受控直写正常 |
| verify-phase2 | 20/20 PASS | 生态扩张（历史记录） |
| verify-m6-zoo | 8/8 PASS | 动物园回归（历史记录） |

稳态资源：`renderer.info.memory` 约 152 geometries / 51 textures（v4 全量机位），热路径零增长。

## 5. 接手必读与铁律

- 阅读顺序：`docs/project-map.md` → `src/main.js` → `src/core/{scene-manager,attraction-manager,camera-rig,physics-manager}.js` → `src/scenes/districts.js` + `metropolis/city-layout.js` → `src/scenes/lobby-scene.js`（按需读段）→ 全局系统三件套 → 交通/驾驶 → tests。
- 相机铁律（本轮强化）：**禁止在子系统裸写 `camera.position` / `lookAt`**；一切写入经 CameraRig 的 `blendTo/restore/writePose`；新写者先 `allowDirectWrite` 登记。
- 性能铁律：三角面 ≤300,000；新增内容 calls ≤900（大厅全量 1,198 是既有基数）；热路径不 new GPU 资源；重复物件用 InstancedMesh；不新增常驻灯；AI 车保持 kinematic；粒子池上限 760；不改基线让测试变绿。
- 坐标铁律：`DISTRICT_GRID` / `CITY` / `ZOO_LAYOUT` / `FOREST_PARK` 是单一真相源；"南门"是建筑名不是 +z 方向；北区几何世界坐标烘焙，移动用 `_rebase`。
- 验证：`node tests/verify-all.mjs`（全套，约 15–20 分钟）；dev server 须先在 5173 运行。

## 6. 已知风险 / 未接线

- 全场景 calls 口径分裂：redline 固定双机位 669，全量俯瞰约 1,198；900 只约束新增内容。若产品要求全量压到 900，需另立合批专项，不能改基线掩盖。
- `public/models/hand-landmarker.task`(7.8MB) 消费方未接线（手势设施仍待美术/交互层）；`assets/models/visitor-ai.glb`(32MB) 不进运行时。
- `season-cycle.js` 用字符串替换注入 shader（对 `#include <color_fragment>`），three 升级可能静默失效，无失败分支。
- `metropolis-scene.js` 背向时仍全量 update 子系统（省 draw 但 CPU 常开）；`zoo-scene.js` 游客 InstancedMesh `frustumCulled=false` 常驻提交。
- 已跟踪的 `tests/_layout-probe.mjs` 与 7 个 `diag-*.mjs` 保留（历史诊断工具），未删除。
