# 阶段二进度存档（生态扩张）

> 保存时间：2026-11-16  
> 状态：**阶段二功能已实现，正式验收 20/20 通过**。可以关机；代码、截图、报告均已写入磁盘。

## 一、已完成内容

### 1. 森林公园
- 文件：`src/scenes/forest-park.js`
- 已接入：`src/scenes/lobby-scene.js`（构建、每帧 update、dispose）
- 位置：城市西侧 / 城堡西侧，`x[-104,-38] / z[44,92]`
- 内容：
  - 草坪、带动态顶点波纹 + 片元水纹的河流
  - 22 段弧形拱桥、河岸/步道、长椅、入口标牌
  - **128 棵树 + 29 丛灌木，全部 InstancedMesh**
  - 4 名市民 NPC（2 名遛狗）+ 2 只狗；均有行走/摇尾/四腿动画
- 修复：河流原先与草坪发生 z-fighting，已抬高水面并降低波幅。

### 2. 动物园升级
- 文件：`src/scenes/zoo-scene.js`
- 由 4 区扩为 **5 区**：家禽、爬行、海洋、哺乳、南侧草原展区（`safari_zone`）。
- 新增几何动物：
  - 大象：连续弯曲长鼻（整体摆动）、大耳、象牙、四肢、尾巴
  - 长颈鹿：长颈摆动、可辨识斑纹、高腿
  - 狮子：鬃毛、摆尾、漫步
  - 老虎：橙底黑纹、长尾、四肢
- 所有大体型动物使用分关节 InstancedMesh；修正了原实例槽位写错/越界问题。
- 四足腿部向下延展并修正落地，脚底实测 y≈1.10~1.15。
- **占道修复**：
  - 北侧家禽/爬行区高度 24→16，北缘从 z≈26 退到 **18.45**，避开 z≥19 的 16m 东西向道路走廊。
  - 入口拱门 x=30→**34.2**，整体移至东侧人行道外，包围盒最小 x=**33.7**。
  - 草原展区新增在南侧 `z[-55,-29]`，不压道路。
  - 自动扫描道路走廊 x[16,32] / z[19,35]：`roadIssues=[]`。

### 3. 农家乐劳作
- 新文件：`src/scenes/farm-workers.js`
- 已接入：`src/scenes/farm.js`、`src/scenes/districts.js`
- 3 名插秧农民：弯腰角度 0.78~1.26rad（约 45°~72°），左右手交替下探，带秧苗。
- 2 名锄地农民：右臂举锄过肩 → 落锄，左臂扶柄，身体随动作前压，锄头同步。
- 共 **9 个 InstancedMesh**（腿/躯干/双臂/锄头/秧苗），每帧只写 instanceMatrix。
- 仅当农家乐 LOD 近景可见时推进动画。

## 二、验收结果

命令：

```powershell
cd D:\playground-mvp
node tests\verify-phase2.mjs
```

结果：**PHASE2 20/20 allPass=true**

关键数据：
- 森林：树 128、灌木 29、市民 4、狗 2、狗腿实例 8
- 动物园：5 区、10 种动物；大象/长颈鹿/狮子/老虎动画矩阵均随时间变化
- 落地：大象 1.105 / 长颈鹿 1.127 / 狮子 1.154 / 老虎 1.147
- 道路净空：`roadIssues=[]`，北区 `maxZ=18.45`，入口 `minX=33.7`
- 农民：3 插秧 + 2 锄地；弯腰范围 `0.7817~1.2583`；臂/锄矩阵差 >0.98
- **新增内容机位 draw calls 最高 825（≤900）**
  - 动物园 628 / 草原 825 / 森林 535 / 农场 555
- **六个机位最大三角面 287,234（≤300,000）**
- **240 帧热路径：Δgeo=0 / Δtex=0**
- 0 pageerror / console.error

产物：
- `docs/phase2-eco-report.json`
- `docs/screenshots/phase2-forest.png`
- `docs/screenshots/phase2-zoo.png`
- `docs/screenshots/phase2-safari.png`
- `docs/screenshots/phase2-farm.png`
- `docs/screenshots/phase2-overview.png`

## 三、遗留事项（下次继续）

1. **旧测试期望值需要跟随阶段二更新**：
   - `tests/verify-m6-zoo.mjs` 当前仍按“四区 / ≤18 个 InstancedMesh / 12 个动物部件”断言，阶段二实测为 5 区、67 个 InstancedMesh；因此旧 M6 脚本当前 2/5，不是功能失败，是断言过期。
   - `tests/verify-redline.mjs` 仍断言动物园只有 4 区（`zones.length === 4`），需改为 5。
2. 旧 M6 脚本后半段读取已变化的部件索引时抛 `undefined.instanceMatrix`，同样应随新动物部件结构更新。
3. 阶段二没有执行 Git commit / push；工作区改动都在 `D:\playground-mvp` 本地磁盘。
4. 开发服务器为临时进程，关机后需重新启动：
   ```powershell
   npm run dev -- --host 127.0.0.1 --port 5173
   ```

## 四、下次续接建议

- 不重复实现阶段二功能。
- 先更新上述两条旧测试断言，再跑：
  ```powershell
  npm run build
  node tests\verify-phase2.mjs
  node tests\verify-m6-zoo.mjs
  node tests\verify-redline.mjs M2
  ```
- 确认旧测试恢复后，再向用户汇报阶段二最终结果并停止。
