# `src/assets/models/` 资产约定

## 1. 运行时资产（当前为空）

`ModelLoader.loadOrFallback()` 只加载 `modelLoader.available` 里登记过的 URL。
未登记的 URL 会**直接返回程序化占位体、不发网络请求**（保证无 404 / CORS 噪声）。
本项目当前**没有任何被运行时加载的 GLB**；大厅 10 个 NPC 与两个玩家角色全部由
`src/utils/ProceduralCharacter.js` 程序化生成（1 张共享几何体 + 1 draw call）。

新增美术资产时：

```js
import modelLoader from '../utils/ModelLoader.js';
modelLoader.registerAsset(new URL('./<key>.glb', import.meta.url).href);
// 之后设施内用 modelLoader.loadOrFallback(url, () => fallbackGroup)
```

命名约定：`<key>.glb`，key 与 `MODEL_PRIORITIES`（`src/utils/ModelLoader.js`）一致。
压缩资产需同步 vendored `public/draco/`，否则 `DRACOLoader` 会按需取解码器产生请求。

## 2. AI 生成实测样本（**参考资产，未被运行时加载**）

2026-11-11 用 `buddy-multimodal-generation` 技能（文生 3D）实测生成，产物保留供对照：

| 文件 | 大小 | 说明 |
|---|---|---|
| `visitor-ai.glb` | 32.07 MB | glTF 2.0 / Blender glTF I/O 4.0.43 |
| `visitor-ai-preview.png` | 161 KB | 云端预览图 |
| `visitor-ai-obj.zip` | 27.42 MB | 附带的 OBJ + MTL 源码 |
| `generated_model_20261111_1232_viewer.html` | — | model-viewer 本地预览页 |

生成参数：`3d "低模童话风格的游乐园游客人物，7头身，圆润可爱但不幼稚，穿彩色休闲外套，微笑，站姿" --model 3.0 --generate-type LowPoly --face-count 20000 --enable-pbr`
（**注意**：`LowPoly` 必须配 `--model 3.0`，默认 3.1 不支持，否则脚本直接报参数错误。）

### GLB 二进制实测规格

- 三角面 **18,305**、顶点 15,268、1 mesh / 1 primitive / 1 材质
- 3 张内嵌贴图（`KHR_materials_specular`），是 32 MB 的主要来源
- **骨骼 0、蒙皮 0、动画 0** → 静态网格，文生 3D 不会自带骨骼动画
- 无 `JOINTS_0/WEIGHTS_0`，无 Draco 压缩

### 诚实质量评估

- ✅ 技能**可用**：云端任务 `1511945610516774912` 状态 `DONE`（提交后脚本轮询 300s 超时，
  用同一 job_id 单独查状态才拿到结果，**未重复提交**）。
- ✅ 画质本身不差：卡通/手办质感，头发、五官、外套、运动鞋、帽子、背包、配色都齐全。
- ❌ **需求不匹配**：产出是 **7 个 Q 版儿童抱团的群像**（约 3~4 头身），不是提示词要求的
  「单个 7 头身、不幼稚的游客」；群像各人互相穿模，无法拆成可实例化的单角色。
- ❌ **风格/工程不适配**：32 MB 会让首屏变胖；0 骨骼 0 动画，摆臂摆腿仍需程序化驱动；
  若替换 10 个 NPC 为 10 个 GLB 则 draw call 从 1 暴涨到 10，击穿 v3_spec.txt:248 硬约束。

### 结论

**不接入运行时**。大厅实际使用 `ProceduralCharacter.js` 的 7.3 头身程序化关节人物
（1 个 InstancedMesh / 1 draw call / 10 人共 24,780 面 / 逐实例 4 组调色板，
头发、五官、两段式四肢、皮带鞋袜齐全，走路摆臂摆腿、迎宾挥手、张望均由 GPU 顶点动画驱动）。

若未来要做**静态展台 / 对照预览**，可显式调用
`ProceduralCharacter.registerGeneratedVisitorAsset()`（只登记、不加载），再
`modelLoader.loadOrFallback(url, fallbackFactory)`。线上环境请先把 GLB 移到 `public/models/`
并改用 `/models/visitor-ai.glb`，避免 32MB 资源被 Vite 静态分析复制进 `dist`。
