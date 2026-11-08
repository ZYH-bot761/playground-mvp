# 游乐场 MVP · 交接说明

> 更新时间：2026-11-08（用户关机前收尾）

## 一、项目定位 / 技术栈 / 启动方式

- **一句话定位**：霓虹夜间游乐场的第一人称大厅 + 三个可进入小游戏，单入口、可来回切换的 3D MVP。
- **技术栈**：Vite 8 + three r187（WebGLRenderer / EffectComposer / UnrealBloom / OutputPass）+ @dimforge/rapier3d 物理，原生 ES Module JS，无框架。
- **启动方式**：`npm run dev`（历史实际端口 **5175**，不是 5173）。
- **当前可访问地址**：`http://127.0.0.1:5173/`
  - 今天收尾时 5173 上跑的是 `npx vite preview --host 127.0.0.1 --port 5173 --strictPort`（**服务 dist 产物**，不是 hot-reload 的 dev server），进程随关机结束。
  - 明天要用 dev server，请看「已知问题 1」的处理进展。

## 二、已完成的功能清单

1. **大厅（Lobby）**：第一人称 WASD/方向键移动 + 拖拽环顾，边界钳制 ±30，三个发光触发环（走近按 E 或点击进入）。
2. **三个玩法**：
   - 南瓜投手（抛物投掷，冷却 0.5s，上限 10 个，结算后返回大厅）
   - 金币小径（收集 30 枚金币，倒计时结束/收满结算）
   - 记忆翻牌（12 张卡，配对 +5，不匹配 1.8s 翻回）
3. **开始页 + 音效**：StartScreen 纯 DOM 覆盖（循环之外），AudioManager 接入点击/投掷/收集等音效；`pagehide` 已修 bfcache 场景（`event.persisted` 时跳过销毁）。
4. **画面升级**：ACES Filmic 色调映射、PMREM + RoomEnvironment 环境反射、UnrealBloom 泛光、天穹 ShaderMaterial 渐变、PCF 软阴影（1024）。
5. **企业级 QA 修复**（上一轮已完成，35/35 通过）：资源回流 Δ0/0（15 轮进出）、DOM 67→67、AudioManager `_liveNodes` 0→0、相机 9/9 轮恢复一致、结算幂等、resize 宽高比正确、构建通过。

## 三、正在进行但未完成：画面过曝调优

**现状结论（必须如实说明）**：代码改动已完成、`npm run build` 通过（33 modules，306ms），但**还没有成功截到一张可用于确认效果的截图**——第一次用真实视口截图时，dev server 因 OutputPass 依赖 404 导致页面全黑；之后改用「构建 + preview」把 404 绕开，还没来得及重截。

### 根因诊断（多因素叠乘，不是单一旋钮）

1. **主因：后期链缺少 OutputPass**。three 在「渲染到 RenderTarget」时会强制 `NoToneMapping`（`WebGLPrograms`：`currentRenderTarget !== null → NoToneMapping`），而 `RenderPass` / `UnrealBloomPass` 都写 RT，且 Bloom 的合成 shader 不含 tone mapping / sRGB 转换 → **线性 HDR 原始值直接写进 8bit 画布**，高光全部截白。
2. Bloom 原先 `threshold 0.85 / strength 1.2 / radius 0.4`，配合大量高自发光材质 → 整片过阈、白斑连成一片。
3. 大厅材质本身过亮：`0xdcebd6` 地面、`0xdfe8f2` 立柱（`metalness=1`）+ RoomEnvironment（未设 `environmentIntensity`）→ 金属件整片反射成白墙。
4. 天穹 ShaderMaterial 的 `uHorizon 0xdff0ff` 本身就很亮，且 ShaderMaterial 未接入色调映射链路 → 地平线整条泛白。
5. 设计残留：大厅 `fog 0x060a18`（夜）但 `background 0x87ceeb`（白天），说明早期夜景被改成日光但没重新平衡。

### 已改参数（改前 → 改后 → 依据）

| 位置 | 参数 | 改前 | 改后 | 依据 |
|---|---|---|---|---|
| SceneManager | 后期链 | RenderPass + Bloom | RenderPass + Bloom + **OutputPass** | 唯一能恢复 ACES + sRGB 的位置；复用 Pass.js 共享全屏三角形，不新增 geometries/textures |
| SceneManager | `toneMappingExposure` | 1.0 | 0.9 | 夜景基准；ACES 下保留暗部层次 |
| SceneManager | `scene.environmentIntensity` | 未设置（默认 1.0） | 0.3 | RoomEnvironment 按室内白天烘焙，直给会把金属件照白 |
| SceneManager | AmbientLight | `0xffffff` 0.12 | `0xbfd4ff` 0.16 | 冷调、只抬死黑 |
| SceneManager | HemisphereLight | `0xbfe3ff/0x24401c` 0.4 | `0x9fc4ff/0x1b2a1c` 0.5 | 上冷下暖的反差 |
| SceneManager | DirectionalLight | `0xfff2df` 0.7 | `0xdce8ff` 0.6 | 月光/顶灯冷白，降低叠乘 |
| SceneManager | FogExp2 密度 | 0.012 | 0.010 | 夜景不需要那么快吞没 |
| SceneManager | SKY_COLOR / FOG_COLOR | `0x87ceeb` / `0xbfe0f5` | `0x0a1226` | 深蓝夜空 |
| SceneManager | Bloom strength / radius / threshold | 1.2 / 0.4 / 0.85 | 0.6 / 0.3 / 0.6 | 只让灯带/高光泛光，不再整屏过阈 |
| Lobby | 背景 / 雾 | `0x87ceeb` / `0x060a18` 0.016 | `0x0a1226` / `0x0a1226` 0.010 | 修掉「白天背景 + 夜雾」的设计残留 |
| Lobby | 天穹 uTop / uHorizon / uBottom | `0x4a90d9` / `0xdff0ff` / `0xbfe0d2` | `0x101c38` / `0x2a4676` / `0x0a1226` | 背景亮度必须压在地平线以下 |
| Lobby | matGround | `0xdcebd6` | `0x6b7d99` | 夜景 albedo 必须压暗 |
| Lobby | matPillar | `0xdfe8f2` / rough 0.28 | `0xb9c8dd` / rough 0.35 | 浅色 + metalness=1 = 白墙 |
| Lobby | matWheelFrame | `0xc9d6e8` / rough 0.35 | `0xa8b8cf` / rough 0.4 | 同上 |
| Lobby | matTrack | `0xf2e6c9` | `0x9c9482` | 同上 |
| Lobby | makeNeon `emissiveIntensity` | 2.4（底色 `0x24242c`） | 2.0（底色 `0x1a1a22`） | 原值在无色调映射下直接纯白 |
| Lobby | matCoinGold 自发光 | 1.2 | 1.0 | 与 Bloom threshold 匹配 |
| Lobby | matTriggerRing / Disc 自发光 | 2.2 / 1.4 | 1.6 / 1.0 | 触发环只做提示，不抢亮度 |
| Lobby | matFog 透明度 | 0.06 | 0.04 | 远景薄雾变淡 |

> 未改：玩法逻辑、资源生命周期契约、`src/core` 的既有逻辑结构（仅渲染参数与后期链增补）。

### 当前截图与下一步

- 截图工具：`dist/shot.html`（临时页，2×2 联络表：大厅 / 南瓜投手 / 金币小径 / 记忆翻牌，视口钉成 1280×720，手动 `renderOnce()` 抓帧拼到一张 1280×720 画布，**不做任何网络导出**）。
- 访问方式：`http://127.0.0.1:5173/shot.html`，等 `window.__shotReady === true` 后截图即可。
- 下一步（明天第一件事）：打开上面对联表页截图，看图确认「能看清轮廓 + 暗部有层次」；若仍偏亮，优先只动三处：`toneMappingExposure`、Bloom `strength`、大厅 `matPillar/matWheelFrame` 的 albedo，不要再多因素同时改。

## 四、已知问题

1. **dev server 5173 与 dep 预构建 404（未彻底解决）**
   - 现象：访问 `/node_modules/.vite/deps/three_examples_jsm_postprocessing_OutputPass__js.js` 返回 404 → 页面 `ERR_ABORTED` → 全黑。
   - 原因：新增了 `OutputPass` 依赖，需要重新预构建；但本机 `node_modules/.vite/deps` 里的既有缓存文件**不允许删除**（`EPERM: unlink ...@dimforge_rapier3d-compat.js`），`--force` 与清缓存都会失败；在 `node_modules` 下 `mkdir` 也被 node 拒绝。
   - 已做的绕行：`npm run build` + `npx vite preview --port 5173`（生产产物里 OutputPass 已打包，无 dep 请求）。这是今天 5173 能打开的原因。
   - 明天可试：在管理员权限/PowerShell 下 `Remove-Item node_modules\.vite -Recurse -Force`，再 `npm run dev -- --force`；或加 `vite.config.js` 里 `optimizeDeps.exclude: ['three/examples/jsm/postprocessing/OutputPass.js']`（本次尝试时因配置打包需要 `.vite-temp` 目录同样 EPERM 而失败，权限修好后可用）。
2. **单包 5MB**（`dist/assets/index-*.js` 5,053 kB，gzip 1,850 kB）：three + rapier 全量打进一个 chunk，仅构建警告，未做 code-split。
3. **大厅 draw call 179（含后期 193）**：可接受但偏高，主要来自摩天轮/长廊的逐件 Mesh；未做 InstancedMesh 合并。
4. **移动端未实测**：只有 900×600 视口 resize 实测（宽高比 1.5 / 画布 1350×900 / RT 1350），真机与触控手感未验证。
5. **截图核验未完成**（见第三节），过曝是否真的修好还没有视觉证据。
6. `dist/shot.html` 是临时自检页，确认完效果后可删。

## 五、关键约束（动代码前必读）

- **热基线 `geometries = 11 / textures = 17` 不许破坏**：任何新增几何/纹理会直接打破验收口径（OutputPass 复用共享全屏几何，理论上不增计数，但**必须实测确认**）。
- **不要改 `src/core` 已有逻辑**：本次只允许调渲染观感参数；后期链增补 OutputPass 是唯一结构性改动。
- **不下载外部资源**：环境光用内置 RoomEnvironment 离屏烘焙，不引 HDR 文件。
- **用户对积分/验收口径敏感**：报告里的数字必须实测，测不到就写「未实测/静态推断」，不要编造。

## 六、明天接续的第一件事（可直接执行）

```powershell
cd D:\playground-mvp
npm run build
npx vite preview --host 127.0.0.1 --port 5173 --strictPort
# 浏览器打开 http://127.0.0.1:5173/shot.html
# 等 window.__shotReady === true 后截图（1280×720），确认四格画面：能看清轮廓、暗部有细节
```

若截图仍偏亮，只按顺序改三处并重新 `npm run build`：
`toneMappingExposure 0.9 → 0.8` → `Bloom strength 0.6 → 0.45` → `Lobby matPillar 0xb9c8dd → 0x93a4bd`。

---

## 七、本轮最终参数（v2 · 2026-11-08 观感验收通过）

**结论**：过曝已消除，四场景截图验收通过；南瓜投手亮度提一档、记忆翻牌外环光晕收敛。

| 位置 | 参数 | v1 | v2（最终） |
|---|---|---|---|
| SceneManager | 后期链 | RenderPass + Bloom + OutputPass | 不变 |
| SceneManager | toneMappingExposure | 0.9 | **0.9** |
| SceneManager | environmentIntensity | 0.3 | **0.3** |
| SceneManager | Bloom strength / radius / threshold | 0.6 / 0.3 / 0.6 | **0.6 / 0.3 / 0.6** |
| SceneManager | Ambient / Hemi / Directional | 0.16 / 0.5 / 0.6（冷色） | 不变 |
| Lobby | 背景 / 雾 | 0x0a1226 / 0.010 | 不变 |
| Lobby | 天穹 uTop / uHorizon / uBottom | 0x101c38 / 0x2a4676 / 0x0a1226 | 不变 |
| Lobby | 霓虹 emissiveIntensity | 2.0 | 不变 |
| PumpkinThrower | 地面纹理 | [58,78,62]/[44,62,52] | **[96,124,98]/[74,100,84]**（提一档亮度） |
| PumpkinThrower | 南瓜自发光 | 无 | **0x2a1500 @ 0.3**（远处轮廓可辨） |
| PumpkinThrower | 幽灵自发光 | 0x101830 @ 1.0 | **0x26365c @ 0.6**（靶子清晰） |
| MemoryMatch | matRuneGold 自发光 | 0xffb651 @ 2.3 | **0xffb651 @ 1.5**（外环不再糊成白斑） |

**实测（v2 截图，1280×720 四格联络表）**：平均亮度 0.232、过曝像素占比 0.2%、直方图 10 档均有分布。

**热基线实测（生产构建，大厅为基准）**：
`11/18` → 依次进 南瓜投手 / 金币小径 / 记忆翻牌 再退出，每轮均精确回落 `11/18`，**每次退出差值 Δ0/0**（3 轮，`roundTripCount=3`）。
> 与旧文档的 `11/17` 差 1 张纹理：本机实测稳定值为 18，且与 OutputPass 无关（运行时移除 OutputPass 后计数不变）；渲染器固有分配静态计数为 17（2 个 composer RT + 11 个 bloom RT + 1 阴影深度 + 1 PMREM + 大厅 2 张程序化纹理），多出的 1 张来源未定位，**标记为「未实测归因」**，不影响零泄漏结论。下一步若要追平 17，需在临时构建里逐项禁用后期 pass 定位（会短暂恢复过曝，需用户同意）。

**预览服务（局域网可访问）**：`npx vite preview --host 0.0.0.0 --port 5173 --strictPort`
- 本机：`http://127.0.0.1:5173/`
- 手机（同一 Wi‑Fi）：`http://10.58.221.17:5173/`（WLAN 网卡；Tailscale 为 100.71.53.14，不用于局域网直连）
- 若手机打不开，放行 Windows 防火墙的 Node.js 入站规则。

---

## 八、移动端虚拟摇杆（2026-11-08）

真机反馈「能转视角、不能移动」，根因是移动只有键盘 `WASD` 监听。已在 `src/attractions/Lobby.js` 内补齐纯 DOM 摇杆，不引任何外部库。

### 实现要点
- **DOM / CSS**：`.lb-stick`（132px 底盘 + 52px 摇杆头，半透明、`touch-action:none`）固定左下角 `left/bottom:20px`，默认 `display:none`，`data-active='true'` 才显示。
- **触屏判定**：`matchMedia('(hover: none) and (pointer: coarse)')`，不用 UA，iPad「桌面模式」伪装成 Mac 时仍成立。
- **事件**：`touchstart / touchmove / touchend / touchcancel` 绑在摇杆节点上，全部 `stopPropagation()`；start/move `{ passive:false }` + `preventDefault()`。摇杆节点不是 canvas 子节点，与画布拖拽转视角天然隔离，实测触摸摇杆时 `yaw` 不变。
- **向量换算**：中心取 `getBoundingClientRect()`，`max = 半径 - 26`，越界按比例收圆；12% 死区；输出归一化 `x/y`（右/下为正）。
- **驱动**：`_applyMovement` 中 `f = 键盘前后 - stick.y`、`s = 键盘左右 + stick.x`；仅当合成模长 > 1 时归一化（保留轻推慢走，又保证 W+D 斜向不加速）。
- **清理契约**：4 个 touch 监听以 `tag='input'` 登记，`dispose()` 步骤 1 统一 `_removeListenersByTag('input')` 解绑，并 `_releaseStick()` 归零；步骤 3 移除 `_uiRoot`（含摇杆 DOM）与注入的 `<style id="lb-ui-style">`。

### 实测（生产构建 dist，headless Edge 1280×1000，页面内写结果后截图读取）
| 项 | 桌面模式 | 触屏模式（matchMedia 桩成 coarse） |
|---|---|---|
| `_stickEnabled` / 显示 | false / `display:none` | true / `display:block` |
| 键盘 W 移动 | 3.750，前向 dot **1.000** | 3.750，前向 dot 1.000 |
| 键盘不转视角 | yaw 未变 | — |
| 摇杆推上 | — | 3.750，前向 dot **1.000** |
| 摇杆推左 | — | 3.750，右向 dot **−1.000**（即向左） |
| 摇杆触摸期间 yaw | — | **未变**（不触发相机旋转） |
| 松手 / 静止漂移 | — | `active=false, x=y=0, knob=translate(0px,0px)`；漂移 0.0000 |
| dispose 后 | 摇杆 DOM 与 `<style>` 均为 null | 同左；返回大厅后重建为 block，监听数 8→12（含 4 个 touch） |
| 热基线 | `11/18`，进出小游戏 `ΔG=0 ΔT=0` | `11/18`，`ΔG=0 ΔT=0` |

> 说明：触屏模式是在桌面 Chromium 里把 `(hover:none) and (pointer:coarse)` 桩为 `matches:true` 并用 `TouchEvent` 派发验证的，**真机手感（摇杆贴合度、死区观感）仍需用户手机复测**，本表只证明逻辑与方向正确。

### 预览（已重启，服务最新 dist）
- 本机：`http://127.0.0.1:5173/`
- 手机（同一 Wi‑Fi）：`http://10.58.221.17:5173/`（WLAN 网卡）

