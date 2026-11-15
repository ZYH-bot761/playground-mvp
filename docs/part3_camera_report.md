# 第三部分《视角优化报告》

> 对应手册第三部分（docs/manual-extract.txt 87–139 行）。
> 验收口径：所有数字均为**真实浏览器实测**（browser-use MCP + `window.__playground` 调试句柄，
> 页面隐藏 rAF 暂停时以 `attraction.update(1/60)` 手动步进）。测不到的项明确标注「未实测/静态推断」。
> 资源基线：大厅热基线 **17 geometries / 24 textures**（`renderer.info.memory`，GPU 已上传计数）。

---

## 1. 逐设施优化前后对比

### 1.1 旋转木马 Carousel.js
- **优化前**：进入即俯瞰鸟瞰固定视角，与大厅第一人称漫游不一致；无选马阶段、无骑乘代入感。
- **优化后**：三阶段状态机 `select → riding → exiting`。
  - select：OrbitControls 环绕查看 8 匹胶囊木马（minDistance=7 防穿模 / maxDistance=30 / 阻尼 0.08 / 禁 pan）；射线悬停命中实例号 → 该马阻尼放大 1.14 高亮。
  - riding：相机绑定所选马座位世界坐标（略高于座位模拟眼高），随转盘圆周运动 + 上下起伏同步；拖拽 360° 自由环顾（yaw 无限）、滚轮/拖拽俯仰钳制 ±30°。
  - exiting：ESC/退出按钮 → 0.8s smoothstep 位置 lerp + 朝向 slerp 回大厅存档机位，再回调 onExitAttraction。

### 1.2 海盗船 PirateShip.js
- **优化前**：视角固定，不随船摆，缺乏"坐在船上"的真实感。
- **优化后**：甲板第一人称。朝向 = 船体世界四元数 × 座位基准 × 自由环顾（含晃动），相机始终垂直甲板随船倾斜；位置用帧率归一 lerp(0.2) 惯性延迟跟随，摆峰产生滞后感；环顾相对船体 yaw±90°/pitch±45°；V 键切第三人称侧后方 (-10.5,7.5,14.5) 看全船。

### 1.3 跑酷 ParkourRun.js
- **优化前**：视角不够自然（P0 直接进跑酷 bug 已在第二部分修复）。
- **优化后**：第三人称追尾，角色后 4.4 / 上 2.55；帧率归一 lerp(0.08) 平滑跟随；鼠标横拖 ±30° 微调、松手自动回正；跑步上下晃动 sin(runPhase*2)*0.07 叠加在相机 Y（与步频同步）。

### 1.4 跳一跳 JumpJump.js
- **优化前**：视角固定或不跟随。
- **优化后**：相机锚定玩家球固定距离、始终朝向球；垂直跟随带延迟缓冲 lerp(0.1)；蓄力距离 8→5 缓慢拉近、松手恢复；落地瞬间相机下冲 0.2 后以 λ8 衰减恢复。

### 1.5 过山车 TrainRide.js
- **优化前**：第一人称但朝向完全锁死车厢，转弯无惯性。
- **优化后**：保留车厢前排第一人称；新增拖拽自由转头 yaw±120°/pitch±60°（相对车厢）；朝向用 Quaternion.slerp(0.08) 平滑 → 轨道转弯时朝向惯性延迟、不完全同步车厢。

### 1.6 大厅 Lobby.js
- **优化前**：第一人称 WASD/摇杆行走 + 走近按 E 进入；入口仅触发环，引导弱。
- **优化后**：整体改 OrbitControls 自由探索（手册 P3§6 与 P9 验收强制参数）；每个设施入口新增**下指悬浮箭头 + 点阵名称牌 + 光柱/触发环**整套标识；hover 时整套标识切换共享热材质高亮 + 指针 cursor；点击标识直接进入（俯瞰视角取消距离门槛）。名称牌复用大门招牌模式（makeTextPixels → InstancedMesh 共享 geoBox），箭头复用 geoCone → **零新增 GPU 资源**，保住 17/24 基线。

---

## 2. 相机控制方案表

| 设施 | 相机类型 | 控制方式 | 关键参数 |
|---|---|---|---|
| 旋转木马 select | OrbitControls | 拖拽旋转/滚轮缩放 | minDist 7 / maxDist 30 / damping 0.08 / pan off |
| 旋转木马 riding | 座位绑定第一人称 | 拖拽 yaw 360° / 滚轮 pitch | pitch ±30°(π/6)；位置=座位世界坐标 |
| 旋转木马 exiting | 平滑过渡 | smoothstep lerp+slerp | 0.8s 回大厅存档机位 |
| 海盗船 | 甲板第一人称 | 拖拽环顾(船体系) / V 切换 | yaw±90° pitch±45°；pos lerp 0.2 / ori slerp 0.3 |
| 海盗船第三人称 | 侧后方固定 | V 键 | pos (-10.5,7.5,14.5) lookAt 船 |
| 跑酷 | 第三人称追尾 | 鼠标横拖微调+松手回正 | back 4.4 / height 2.55 / lerp 0.08 / yaw±30° / bob 0.07 |
| 跳一跳 | 球体跟随 | 自动 | dist 8→蓄力 5 / lerp 0.1 / 落地 dip 0.2 |
| 过山车 | 车厢第一人称 | 拖拽转头(车厢系) | yaw±120° pitch±60° / ori slerp 0.08 |
| 大厅 | OrbitControls | 拖拽旋转/滚轮缩放/点击入口 | minDist 5 / maxDist 50 / minPolar 0 / maxPolar π/2.2 / damping 0.08 / pan off |

---

## 3. 旋转木马交互流程图

```
进入设施
   │
   ▼
[select] OrbitControls 环绕 ──悬停──► 射线命中实例号 → 该马阻尼放大 1.14
   │ 点击马身/马鞍 (instanceId)
   ▼
[riding] 0.9s lerp/slerp 上马 → 相机=座位世界坐标
   │   每帧同步转盘圆周 + 上下起伏
   │   拖拽 yaw 360° / 滚轮 pitch ±30°
   │ ESC 或 退出按钮
   ▼
[exiting] 0.8s smoothstep: position.lerpVectors + quaternion.slerpQuaternions
   │   回大厅存档机位 (_cameraSaved)
   ▼
onExitAttraction() → 大厅重建 (OrbitControls 从 _lobbyMemory 恢复)
```

---

## 4. 代码变更清单（文件:行号）

| 文件 | 行号 | 变更 |
|---|---|---|
| Carousel.js | 339–351 | 三阶段状态机 select/riding/exiting + _exitBlend |
| Carousel.js | 648–650 | select OrbitControls（minDist 防穿模） |
| Carousel.js | 758–759 | 悬停阻尼放大 HOVER_SCALE=1.14 (λ10) |
| Carousel.js | 773–780 | exiting smoothstep lerp/slerp 回大厅 |
| Carousel.js | 785–808 | 骑乘位姿 _computeRidePose / 上马 blend |
| Carousel.js | 813–824 | _startRide |
| Carousel.js | 864–896 | 骑乘拖拽 yaw / 滚轮 pitch ±30° |
| Carousel.js | 901 | ESC → _requestExit |
| PirateShip.js | 58–61 | LOOK_YAW/PITCH_LIMIT、FOLLOW/ORI_FACTOR |
| PirateShip.js | 970–971 | 环顾钳制 ±90°/±45° |
| PirateShip.js | 981–984 | V 键第三人称切换 |
| PirateShip.js | 1075–1111 | 甲板朝向=船quat×base×look；pos lerp 惯性 |
| ParkourRun.js | 50–54 | CAM_BACK/HEIGHT/FOLLOW/YAW_LIMIT/BOB_AMP |
| ParkourRun.js | 910–936 | 追尾 lerp + 松手回正 + bob 叠加 Y |
| ParkourRun.js | 512–524 | 鼠标横拖 ±30° / 松手回正 |
| JumpJump.js | 27–30 | CAM_DIST_NORMAL/CHARGE/FOLLOW/DIP |
| JumpJump.js | 559–610 | _snapCamera/_jumpDir/_computeCamDesired/_updateCamera |
| JumpJump.js | 477 | 落地 _camDip=CAM_DIP |
| TrainRide.js | 98–101 | LOOK_YAW/PITCH_LIMIT/SENS/ORI_FACTOR |
| TrainRide.js | 730–769 | 车厢系转头 + slerp 惯性 |
| TrainRide.js | 816–841 | 拖拽转头指针监听 |
| Lobby.js | 55–59 | ORBIT_MIN/MAX_DIST、MIN/MAX_POLAR、DAMPING |
| Lobby.js | 681–691 | init 建 OrbitControls + 从 _lobbyMemory 恢复 |
| Lobby.js | 2435–2470 | 入口箭头 + 点阵名称牌（InstancedMesh 零新增资源） |
| Lobby.js | 2656–2690 | _updateHover/_pickKey/_setHover 高亮 |
| Lobby.js | 2784 | update 每帧 controls.update()（阻尼） |
| Lobby.js | 2822–2828 | dispose 存档 orbit cam/target |
| Lobby.js | 2871 | dispose controls.dispose() 成对解绑 |

---

## 5. 实测验收（本会话浏览器实测）

| 设施 | 验收点 | 实测值 | 判定 |
|---|---|---|---|
| 木马 | select OrbitControls | min7/max30/damping0.08/pan off | ✅ |
| 木马 | 悬停放大 | hovered=0, scale=1.140 | ✅ |
| 木马 | 点击进骑乘 | state=riding | ✅ |
| 木马 | 相机=座位 | posErr=0 | ✅ |
| 木马 | 跟随旋转+起伏 | 30 帧位移 1.157 | ✅ |
| 木马 | 360° 环顾 | 拖拽 100px → yaw=-0.35 | ✅ |
| 木马 | 滚轮俯仰钳制 | pitch=0.5236 (=π/6) | ✅ |
| 木马 | ESC 平滑退出 | exiting→48 帧(0.8s)→lobby；单帧峰值 1.4124（smoothstep 有界、端点零速） | ✅ |
| 海盗船 | 环顾钳制 | yaw=-1.5708(±π/2), pitch=-0.7854(±π/4) | ✅ |
| 海盗船 | V 第三人称 | pos(-10.49,7.5,14.48)；再 V 回第一人称 | ✅ |
| 海盗船 | 惯性延迟 | 摆幅 0.035 时位置滞后 0.013（lerp 非 snap） | ✅ |
| 跑酷 | 追尾距离/高度 | backZ=4.4, baseY=2.55 | ✅ |
| 跑酷 | 跑步晃动 | bobMax=0.07 (=CAM_BOB_AMP) | ✅ |
| 跑酷 | 微调+回正 | yawHeld=0.5236(π/6)；松手回正 0.0001 | ✅ |
| 跑酷 | 平滑跟随滞后 | 换道水平滞后 0.903；跳跃垂直滞后 0.5744（峰值 Y 1.119） | ✅ |
| 跳一跳 | 常态距离 | camToBall=8.000 | ✅ |
| 跳一跳 | 蓄力拉近 | camDist 8→5.109 | ✅ |
| 跳一跳 | 落地缓冲 | maxDip=0.2000 后衰减 | ✅ |
| 跳一跳 | 垂直延迟 | 球 Y 峰帧 24 vs 相机基准 Y 峰帧 36 | ✅ |
| 过山车 | 转头钳制 | yaw±2.0944(±120°), pitch±1.0472(±60°) | ✅ |
| 过山车 | 朝向惯性 | 最大滞后 9.731°（不完全同步） | ✅ |
| 大厅 | OrbitControls 参数 | min5/max50/minPolar0/maxPolar1.4279966/damping0.08/pan off | ✅ |
| 大厅 | 拖拽旋转 | 水平位移 43.40，半径恒 42.05 | ✅ |
| 大厅 | 缩放钳制 | 精确 5 与 50 | ✅ |
| 大厅 | 垂直角钳制 | 精确 π/2.2 | ✅ |
| 大厅 | 入口 hover 高亮 | 6/6 标识换金色 + cursor pointer；移开清除 | ✅ |
| 大厅 | 代理盒劫持修复 | 南瓜摩天轮牌 hover 正确解析 pumpkin-thrower（优先入口标识命中） | ✅ |
| 大厅 | 点击进/退出还原 | 进 carousel；退出 poseErr≈3.6e-15 | ✅ |
| 全部 | 控制台 | 0 error / 0 warn | ✅ |

### 5.1 切换泄漏回归（≥5 次，实测 7 设施来回）
`carousel / pirate-ship / parkour-run / jump-jump / train-ride / pumpkin-thrower / memory-match`
逐个 enter→exit：每轮 **Δgeometries=0 / Δtextures=0**，退出机位 poseErr=0，回大厅 activeKey=lobby。
大厅新增入口标识复用共享 geoBox/geoCone + 共享霓虹材质 → 热基线保持 **17/24** 不变。

---

## 6. 截图索引（docs/screenshots/）
- part3-01-carousel-select.jpg / 03-riding-fixed / 04-riding-tangent：木马选择与骑乘
- part3-05-pirate-riding.jpg / 06-pirate-third：海盗船第一/第三人称
- part3-07-parkour.jpg：跑酷追尾
- part3-08-jumpjump.jpg：跳一跳跟随
- part3-09-train.jpg：过山车第一人称
- part3-10-lobby-orbit.jpg：大厅 OrbitControls 俯瞰（默认机位 0,30,34）
- part3-11-lobby-entrance-hover.jpg：入口箭头+点阵名称牌+hover 金色高亮

## 7. 已知限制 / 未实测项
- 海盗船惯性滞后 0.013 取自起摆早期（摆幅 0.035）；满摆幅滞后更大，未单独满摆实测（静态推断：lerp 0.2 滞后随速度增大）。
- 真机触屏手势（双指缩放/滑屏）未在物理手机实测；合成 PointerEvent 覆盖鼠标路径，触摸路径代码存在（pointerType 判别）但标注「未实测」。
- 帧率性能（≥50fps）属第六部分验收，本部分不重复测量。