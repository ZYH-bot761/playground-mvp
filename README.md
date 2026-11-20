# playground-mvp · Three.js 网页游乐场

单场景（唯一 `THREE.Scene` + 常驻 Lobby 根节点）的浏览器 3D 游乐场：四宫格园区（游乐场 / 动物园 / 城堡园 / 农家宝）、9 个可进入设施、NPC 寻路、双模式漫游（地面 WASD / 飞行）、程序化昼夜与后处理链。相机由 `CameraRig` 统一调度，进入设施只做机位切换、不换场景。

## 目录结构

```
playground-mvp/
├── index.html                  # Vite 唯一 HTML 入口，挂载 /src/main.js
├── vite.config.js              # 构建 / dev 配置（读取 config/default.json）
├── package.json                # 依赖与 scripts
├── pnpm-lock.yaml              # pnpm 锁文件（禁止修改）
├── package-lock.json           # npm 锁文件（禁止修改）
├── start-playground.bat        # Windows 一键启动（GBK 编码）
│
├── config/
│   └── default.json            # 运行配置：dev 端口、缓存策略、渲染预算
│
├── src/
│   ├── main.js                 # 唯一 JS 入口：装配世界骨架 / 管理器 / 设施 / UI
│   ├── style.css               # 全站样式（毛玻璃 UI / HUD / lil-gui 皮肤）
│   ├── core/                   # Scene·Camera·Renderer·运行时封装
│   │   ├── scene-manager.js        # 渲染器、相机、EffectComposer 后处理链
│   │   ├── scene-context.js        # worldRoot / propsRoot / 设施锚点
│   │   ├── camera-rig.js           # 相机过渡与归属仲裁
│   │   ├── render-optimizer.js     # LOD / mipmap / 包围体修正
│   │   ├── attraction-manager.js   # 设施注册表与激活切换
│   │   ├── facility-runtime.js     # 嵌入视图运行时
│   │   ├── physics-manager.js      # Rapier 物理（大厅禁用）
│   │   ├── interaction-manager.js  # 拾取与交互
│   │   ├── audio-manager.js        # WebAudio 程序化音频
│   │   ├── ui-manager.js           # 悬浮调试面板
│   │   └── disposable-registry.js  # GPU 资源台账
│   ├── scenes/                 # 场景模块
│   │   ├── lobby-scene.js          # 主大厅（PlaygroundScene）
│   │   ├── zoo-scene.js            # 动物园（ZooScene）
│   │   ├── districts.js            # 四宫格骨架与区域级 LOD
│   │   ├── castle.js / farm.js     # 城堡园 / 农家宝程序化几何
│   │   └── attractions/            # 9 个设施 + 接口 / 占位实现
│   ├── components/             # 可复用组件
│   │   ├── controllers/            # movement-mode-manager（地面/飞行状态机）
│   │   ├── labels/                 # district-labels（Sprite 区域标签）
│   │   ├── embedded-views/         # 嵌入设施视图
│   │   ├── debug-panel.js          # lil-gui 调试控制台
│   │   ├── start-screen.js / pause-menu.js
│   │   └── hand-tracker.js         # MediaPipe 手势识别（预留，未接入）
│   ├── objects/                # 预留：geometries/ materials/ lights/
│   ├── shaders/                # 预留：自定义 GLSL（当前着色器均来自 three 内置）
│   └── utils/
│       ├── controls/               # wasd-controller.js
│       ├── loaders/                # model-loader.js + 自检
│       └── helpers/                # 昼夜 / 粒子 / NPC / 角色 / 画质 / LOD / 图集
│
├── assets/
│   ├── models/                 # .glb / .gltf + 模型预览页
│   ├── textures/               # 贴图
│   └── sounds/                 # 预留：音频（当前由 AudioManager 程序化合成）
├── public/                     # Vite 静态托管（/favicon.svg、/models/*.task）
├── docs/                       # 设计说明、规格、提示词、验收截图与报告
│   ├── directory-audit.md      # 整理前逐文件用途判定快照
│   └── screenshots/            # 各模块验收证据
├── tests/                      # Playwright 真机验收脚本（verify-* / diag-*）
└── _archive/                   # 待确认删除的归档区（本地暂存，不参与构建）
```

> 命名规范：工程内所有文件一律小写 + 短横线；禁止中文文件名、空格、"最终版/copy/旧"类后缀。
> `docs/screenshots/` 内的历史证据文件名已统一小写短横线；`docs/directory-audit.md` 是整理前的历史快照，其中路径为旧结构，仅作审计留痕。
> `_archive/` 中的文件为待删除候选，**尚未删除**，等待确认；其中大体积中间产物已在 `.gitignore` 排除，不会推送到远端。

## 启动

```bash
npm install           # 安装依赖
npm run dev           # 启动 dev server：http://127.0.0.1:5173/
npm run build         # 生产构建，输出到 dist/
npm run preview       # 预览构建产物
```

Windows 也可双击 `start-playground.bat` 一键启动（自动探测 5173–5178 空闲端口并打开浏览器）。

验收脚本（需 dev server 先启动）：

```bash
node tests/verify-six-upgrades.mjs   # 六项升级 20 项
node tests/verify-v4.mjs             # 全量功能 13 项
node tests/verify-redline.mjs final  # 工程红线 8 项
node tests/verify-m7-districts.mjs   # 四宫格专项
node tests/verify-multiplayer-server.mjs  # 联机房间核心 8 项
node tests/verify-multiplayer.mjs         # 双浏览器联机 8 项
```

## 线上双人联机（Netlify）

线上不使用 WebSocket：前端每 250ms 调一次 `POST /api/room`（上报自己 + 取回队友与回家信号），
服务端由 `netlify/functions/room.mjs` + Netlify Blobs 保存房间状态；本地 dev 由
`server/local-room-api.mjs` 提供同协议的内存实现，本地与线上行为一致。

- 账号：`netlify/functions/_lib/accounts.mjs`（`player1` / `player2`，密码也在该文件）
- 房间：URL 的 `room` 参数，缺省 `home`；两人必须同房间
- 部署：Netlify 连接本仓库，构建 `npm run build`、发布 `dist`；
  `netlify/functions/room.mjs` 会自动提供 `POST /api/room`（Blobs 无需额外配置）
- 分享链接（把 `<site>` 换成 Netlify 域名，`<密码>` 换成账号密码）：
  - `https://<site>/?u=player1&p=<密码>&room=home`
  - `https://<site>/?u=player2&p=<密码>&room=home`
- 打开链接会自动登录并停在开始页；两台手机各开一个链接，点「进入游乐场」后
  就能在大厅看到对方；顶部「一起回家」会把两人一起带进别墅

说明：线上是 250ms 短轮询（未进入游戏或页面在后台时降到 1s），队友动作延迟低于半秒；
Netlify Functions 免费额度有限，两人长时间挂机会消耗调用次数，演示与短时游玩足够。

## 依赖清单

| 包 | 版本 | 用途 |
|---|---|---|
| `three` | ^0.187.0 | WebGL 渲染核心、addons（OrbitControls / GLTFLoader / 后处理 / Sky） |
| `three-mesh-bvh` | ^0.9.9 | 地面漫游的三角形级 BVH 碰撞 |
| `three-player-controller` | ^0.6.3 | 碰撞体注册表 `CollisionWorld` |
| `lil-gui` | ^0.21.0 | 毛玻璃调试控制台 |
| `@dimforge/rapier3d-compat` | ^0.21.0 | 独立玩法设施的物理（大厅禁用） |
| `@mediapipe/tasks-vision` | 0.10.3 | 手势识别（预留能力） |
| `@netlify/blobs` | ^11.1.9 | 线上联机房间状态（Netlify Functions 内使用） |
| `vite` | ^8.3.6 | dev / build 构建工具 |

运行时无外部 CDN 依赖（MediaPipe WASM 仅在启用手势识别时按需加载）；几何、材质、贴图、音频均程序化生成。
