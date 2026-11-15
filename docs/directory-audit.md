# 目录盘点报告（阶段 1）

> 生成时间：2026-11-15T10:22:20.051Z · 扫描文件数：282（已排除 node_modules / .git / dist / 临时缓存目录）

## 判定依据

- **引用中**：在任一 .js/.mjs/.html/.css/.json/.bat/.py 中出现静态 `from`/`import()` 相对路径、`/src/...` 绝对路径或资源文件名字符串。
- **未被引用**：全仓无任何 import 或字符串引用（孤立资源 / 死代码）。
- **构建产物**：dist/ 下由 vite build 生成，.gitignore 已排除。
- **临时垃圾**：隐藏缓存目录、`.tmp*` 前缀脚本、`.log`、npm pack 解包残留、IDE 索引库。
- **文档/证据**：docs/ 下设计说明与截图证据、zoo/ 下 Blender 源与验收、根目录 md/docx/txt 规格。
- **配置**：package.json、锁文件、index.html、vite.config.js、.gitignore。

## 分类汇总

- referenced: 54
- orphan: 7
- build: 0
- temp: 8
- docs: 206
- config: 5
- other: 2

## 引用中（含引用来源）
```
public/favicon.svg  <- index.html
public/models/hand_landmarker.task  <- src/features/hand/HandTracker.js
src/assets/models/visitor-ai-preview.png  <- src/assets/models/generated_model_20261111_1232_viewer.html, src/assets/models/generated_model_20261111_1232_viewer.html
src/assets/models/visitor-ai.glb  <- src/assets/models/generated_model_20261111_1232_viewer.html, src/utils/ProceduralCharacter.js, src/utils/ProceduralCharacter.js
src/attractions/AttractionManager.js  <- src/core/FacilityRuntime.js, src/main.js
src/attractions/Carousel.js  <- src/main.js
src/attractions/Castle.js  <- src/attractions/Districts.js
src/attractions/CenturyClock.js  <- src/attractions/Lobby.js, src/main.js
src/attractions/Districts.js  <- src/attractions/Lobby.js, src/ui/DistrictLabels.js, tests/verify-m7-districts.mjs
src/attractions/DummyAttraction.js  <- src/main.js
src/attractions/embedded/DemoEmbedView.js  <- src/main.js
src/attractions/embedded/FerrisWheelEmbedView.js  <- src/main.js
src/attractions/embedded/IEmbeddedView.js  <- src/attractions/embedded/DemoEmbedView.js, src/attractions/embedded/FerrisWheelEmbedView.js, src/attractions/embedded/JumpJumpEmbedView.js
src/attractions/embedded/JumpJumpEmbedView.js  <- src/main.js
src/attractions/Farm.js  <- src/attractions/Districts.js
src/attractions/FireworksDeck.js  <- src/main.js
src/attractions/IAttraction.js  <- src/attractions/Carousel.js, src/attractions/CenturyClock.js, src/attractions/DummyAttraction.js
src/attractions/JumpJump.js  <- src/main.js
src/attractions/Lobby.js  <- src/main.js
src/attractions/MemoryMatch.js  <- src/main.js
src/attractions/ParkourRun.js  <- src/main.js
src/attractions/PirateShip.js  <- src/main.js
src/attractions/PumpkinThrower.js  <- src/main.js
src/attractions/TrainRide.js  <- src/main.js
src/attractions/Zoo.js  <- src/attractions/Lobby.js, tests/verify-m6-zoo.mjs, tests/verify-m6-zoo.mjs
src/core/AudioManager.js  <- src/attractions/MemoryMatch.js, src/attractions/TrainRide.js, src/core/AudioManager.js
src/core/CameraRig.js  <- src/attractions/embedded/FerrisWheelEmbedView.js, src/attractions/embedded/JumpJumpEmbedView.js, src/attractions/Lobby.js
src/core/DisposableRegistry.js  <- src/attractions/AttractionManager.js
src/core/FacilityRuntime.js  <- src/main.js
src/core/InteractionManager.js  <- src/main.js
src/core/MovementModeManager.js  <- src/attractions/Lobby.js, src/main.js, src/ui/DebugPanel.js
src/core/PhysicsManager.js  <- src/main.js
src/core/RenderOptimizer.js  <- src/main.js, src/ui/DebugPanel.js
src/core/SceneContext.js  <- src/core/FacilityRuntime.js, src/main.js
src/core/SceneManager.js  <- src/main.js, src/ui/PauseMenu.js
src/core/UIManager.js  <- src/main.js
src/core/WASDController.js  <- src/attractions/Lobby.js
src/main.js  <- index.html
src/ui/DebugPanel.js  <- src/main.js
src/ui/DistrictLabels.js  <- src/main.js, src/ui/DebugPanel.js
src/ui/PauseMenu.js  <- src/attractions/MemoryMatch.js, src/attractions/PumpkinThrower.js, src/attractions/TrainRide.js
src/ui/StartScreen.js  <- src/main.js
src/utils/CoasterCarRuntime.js  <- src/attractions/Lobby.js
src/utils/DayNightCycle.js  <- src/attractions/CenturyClock.js, src/attractions/FireworksDeck.js, src/attractions/Lobby.js
src/utils/DetailLOD.js  <- src/attractions/Lobby.js
src/utils/FacilityTextures.js  <- src/attractions/Lobby.js
src/utils/ModelLoader.js  <- src/main.js, src/utils/modelLoaderSelfTest.js, src/utils/ProceduralCharacter.js
src/utils/modelLoaderSelfTest.js  <- src/utils/modelLoaderSelfTest.js
src/utils/NPCManager.js  <- src/attractions/Lobby.js, src/main.js
src/utils/ParticleSystem.js  <- src/attractions/FireworksDeck.js, src/attractions/Lobby.js, src/main.js
src/utils/PerfMonitor.js  <- src/core/SceneManager.js
src/utils/ProceduralCharacter.js  <- src/attractions/embedded/JumpJumpEmbedView.js, src/attractions/JumpJump.js, src/attractions/ParkourRun.js
src/utils/QualityTier.js  <- src/core/SceneManager.js
tests/redline-baseline.json  <- tests/verify-m5-castle.mjs, tests/verify-redline.mjs
```

## 未被引用（孤立）
```
public/icons.svg (5031B)
src/assets/hero.png (13057B)
src/assets/javascript.svg (863B)
src/assets/models/generated_model_20261111_1232_viewer.html (4369B)
src/assets/models/visitor-ai-obj.zip (28761405B)
src/assets/vite.svg (8709B)
src/features/hand/HandTracker.js (29860B)
```

## 临时垃圾
```
.gitignore (709B)
.merkle-snapshot.json (12064B)
.tmp-preview-5176.log (164B)
.tmp_t04b_arb.mjs (4544B)
.tmp_t04b_diag.mjs (2491B)
.tmp_t04b_final.mjs (9956B)
.tmp_t04b_reassign.mjs (10472B)
.tmp_t04b_restore.mjs (2149B)
```

## 构建产物
```

```

## 文档/证据
```
docs/class-diagram.mermaid (4980B)
docs/manual-extract.txt (33346B)
docs/part1_architecture_report.md (18089B)
docs/part2_runtime_report.md (11694B)
docs/part3_camera_report.md (10751B)
docs/part4_modelloader_report.md (6256B)
docs/part5_visual_report.md (9616B)
docs/screenshots/diag-m7-budget.json (1120B)
docs/screenshots/diag-m7-quick.json (1589B)
docs/screenshots/part2-01-start.png (373065B)
docs/screenshots/part2-02-lobby.jpg (70394B)
docs/screenshots/part2-04-parkour.jpg (36957B)
docs/screenshots/part2-05-jumpjump.jpg (8382B)
docs/screenshots/part2-06-carousel.jpg (36740B)
docs/screenshots/part2-07-pirateship.jpg (37526B)
docs/screenshots/part2-08-pumpkin.jpg (16267B)
docs/screenshots/part2-09-memory.jpg (57378B)
docs/screenshots/part2-10-train.jpg (25045B)
docs/screenshots/part2-11-jumpjump-fixed.jpg (18492B)
docs/screenshots/part3-01-carousel-select.jpg (44776B)
docs/screenshots/part3-02-carousel-riding.jpg (52637B)
docs/screenshots/part3-03-carousel-riding-fixed.jpg (83305B)
docs/screenshots/part3-04-carousel-riding-tangent.jpg (33201B)
docs/screenshots/part3-05-pirate-riding.jpg (35303B)
docs/screenshots/part3-06-pirate-third.jpg (59969B)
docs/screenshots/part3-07-parkour.jpg (53045B)
docs/screenshots/part3-08-jumpjump.jpg (15434B)
docs/screenshots/part3-08-jumpjump.json (20659B)
docs/screenshots/part3-09-train.jpg (31611B)
docs/screenshots/part3-09-train.json (42200B)
docs/screenshots/part3-10-lobby-orbit.jpg (137466B)
docs/screenshots/part3-10-lobby-orbit.json (183327B)
docs/screenshots/part3-11-lobby-entrance-hover.jpg (118750B)
docs/screenshots/part3-11-lobby-entrance-hover.json (158434B)
docs/screenshots/part3-carousel-riding.json (70367B)
docs/screenshots/part3-carousel-riding2.json (111171B)
docs/screenshots/part3-carousel-riding3.json (44345B)
docs/screenshots/part3-carousel-select.json (59764B)
docs/screenshots/part3-parkour.json (70898B)
docs/screenshots/part3-pirate-riding.json (47257B)
docs/screenshots/part3-pirate-third.json (80173B)
docs/screenshots/part5-01-lobby-after.jpg (143893B)
docs/screenshots/part5-01-lobby-after.json (191978B)
docs/screenshots/part5-02-jumpjump-tiles.jpg (42183B)
docs/screenshots/part5-02-jumpjump-tiles.json (56283B)
docs/screenshots/part5-03-train-pbr.jpg (40908B)
docs/screenshots/part5-03-train-pbr.json (54583B)
docs/screenshots/part5-04-lobby-fountain.jpg (146911B)
docs/screenshots/part5-04-lobby-fountain.json (195967B)
docs/screenshots/redline-FINAL.json (3528B)
docs/screenshots/redline-FINAL.png (1252820B)
docs/screenshots/redline-M0.json (3512B)
docs/screenshots/redline-M0.png (1188711B)
docs/screenshots/redline-M1.json (3512B)
docs/screenshots/redline-M1.png (1190392B)
docs/screenshots/redline-M10.json (3524B)
docs/screenshots/redline-M10.png (1145585B)
docs/screenshots/redline-M2.json (3515B)
docs/screenshots/redline-M2.png (1189084B)
docs/screenshots/redline-M3.json (3515B)
docs/screenshots/redline-M3.png (1189293B)
docs/screenshots/redline-M4.json (3515B)
docs/screenshots/redline-M4.png (1188744B)
docs/screenshots/redline-M5.json (3518B)
docs/screenshots/redline-M5.png (1157269B)
docs/screenshots/redline-M6.json (3520B)
docs/screenshots/redline-M6.png (1156280B)
docs/screenshots/redline-M7.json (3520B)
docs/screenshots/redline-M7.png (1145757B)
docs/screenshots/redline-M8.json (3520B)
docs/screenshots/redline-M8.png (1146388B)
docs/screenshots/redline-M9.json (3520B)
docs/screenshots/redline-M9.png (1145661B)
docs/screenshots/redline-SIX.json (3524B)
docs/screenshots/redline-SIX.png (1252629B)
docs/screenshots/six-overview.png (608745B)
docs/screenshots/six-upgrades-final.png (600227B)
docs/screenshots/t10-01-npc-closeup.png (136815B)
docs/screenshots/t10-02-lobby-npc.jpg (126315B)
docs/screenshots/t10-03-jumpjump-player.jpg (79062B)
docs/screenshots/t10-04-parkour-player.jpg (76936B)
docs/screenshots/v4-final-01-lobby-boot.png (1743175B)
docs/screenshots/v4-final-02-wasd.png (1676119B)
docs/screenshots/v4-final-03-jumpjump-player.jpg (59295B)
docs/screenshots/v4-final-03-jumpjump-player.png (1887101B)
docs/screenshots/v4-final-03-npc-closeup.png (137669B)
docs/screenshots/v4-final-03-parkour-player.jpg (43043B)
docs/screenshots/v4-final-03-parkour-player.png (359793B)
docs/screenshots/v4-final-04-clock-back.png (452871B)
docs/screenshots/v4-final-04-clock-front.png (401348B)
docs/screenshots/v4-final-04-clock-night.png (141616B)
docs/screenshots/v4-final-05-ferris-embedded.png (1140225B)
docs/screenshots/v4-final-06-coaster-track.png (1149205B)
docs/screenshots/v4-final-07-triggers-topdown.png (1350112B)
docs/screenshots/v4-final-08-castle-gate.png (1367506B)
docs/screenshots/v4-final-09-text-atlas.png (2013413B)
docs/screenshots/v4-final-10-embedded-unified.png (1129824B)
docs/screenshots/v4-final-11-ambient-animation.png (1214647B)
docs/screenshots/v4-final-12-jumpjump-embedded.png (1463356B)
docs/screenshots/v4-final-13-final-lobby.png (2154798B)
docs/screenshots/v4-final-verification.json (51852B)
docs/screenshots/v4-t02-wasd-hud.png (1859067B)
docs/screenshots/v4-t02-wasd.png (2689472B)
docs/screenshots/v4-t03-embedded-lobby.png (814209B)
docs/screenshots/v4-t04-ferris-embedded.png (986236B)
docs/screenshots/v4-t04b-ferris-wheel.png (931919B)
docs/screenshots/v4-t04c-ferris-cabins.png (2048620B)
docs/screenshots/v4-t05-app-delta-data.json (1611B)
docs/screenshots/v4-t05-isolated-data.json (3576B)
docs/screenshots/v4-t05-ps-01-front-day.png (164546B)
docs/screenshots/v4-t05-ps-02-back-day.png (159879B)
docs/screenshots/v4-t05-ps-03-front-night.png (147420B)
docs/screenshots/v4-t05-ps-04-back-night.png (129639B)
docs/screenshots/v4-t05-ps-05-lobby-facade-front.png (142299B)
docs/screenshots/v4-t05-ps-06-lobby-facade-back.png (137384B)
docs/screenshots/v4-t05-summary.json (3039B)
docs/screenshots/v4-t05-td-01-before-defect-front.png (245717B)
docs/screenshots/v4-t05-td-02-before-defect-back.png (239355B)
docs/screenshots/v4-t05-td-03-after-fix-front.png (247109B)
docs/screenshots/v4-t05-td-04-after-fix-back.png (240889B)
docs/screenshots/v4-t05-td-05-facility-front-day.png (247109B)
docs/screenshots/v4-t05-td-06-facility-back-day.png (240889B)
docs/screenshots/v4-t05-td-07-facility-front-night.png (232661B)
docs/screenshots/v4-t05-td-08-facility-back-night.png (195792B)
docs/screenshots/v4-t05-td-09-lobby-facade-front.png (214580B)
docs/screenshots/v4-t05-td-10-lobby-facade-back.png (207467B)
docs/screenshots/v4-t05-td-verification.json (8054B)
docs/screenshots/v4-t07-animations-frame2.png (3658284B)
docs/screenshots/v4-t07-animations.png (3657318B)
docs/screenshots/v4_t06_text.png (2932317B)
docs/screenshots/v4_t06_text_center.png (2345538B)
docs/screenshots/v4_t06_text_fireworks.png (2868617B)
docs/screenshots/v4_t06_triggers.png (3688120B)
docs/screenshots/verify-m1-wasd.json (1459B)
docs/screenshots/verify-m2-layout.json (3382B)
docs/screenshots/verify-m3-npc.json (2038B)
docs/screenshots/verify-m4-jump.json (3809B)
docs/screenshots/verify-m5-castle.json (2954B)
docs/screenshots/verify-m6-zoo.json (3567B)
docs/screenshots/verify-m7-districts.json (3743B)
docs/screenshots/verify-m8-castle.json (2911B)
docs/screenshots/verify-m9-farm.json (1904B)
docs/screenshots/verify-six-upgrades.json (7085B)
docs/screenshots/zoo-01-default-view.png (1188306B)
docs/screenshots/zoo-02-zoo-overview.png (774281B)
docs/screenshots/zoo-m2-layout.png (1257249B)
docs/screenshots/zoo-m3-npc.png (1253595B)
docs/screenshots/zoo-m4-jump.png (1132609B)
docs/screenshots/zoo-m5-castle-gate.png (1258777B)
docs/screenshots/zoo-m6-closeup.png (1034135B)
docs/screenshots/zoo-m7-four-quadrants.png (604016B)
docs/screenshots/zoo-m8-castle.png (620637B)
docs/screenshots/zoo-m8-overview.png (456235B)
docs/screenshots/zoo-m9-farm.png (677618B)
docs/screenshots/zoo-verification.json (4132B)
docs/sequence-diagram.mermaid (5197B)
docs/V3_HANDOFF.md (11281B)
docs/v3_module0_report.md (7201B)
docs/v4_lobby_final_spec.md (14318B)
docs/v4_refactor_plan.md (85492B)
docs/v4_status_and_handoff.md (11221B)
docs/_audit-scan.mjs (5703B)
HANDOVER.md (13795B)
src/assets/models/README.md (3570B)
tests/diag-budget-calls.mjs (2620B)
tests/diag-dispose-trace.mjs (6307B)
tests/diag-m7-budget.mjs (3996B)
tests/diag-m7-quick.mjs (4495B)
tests/diag-m8-overview.mjs (2492B)
tests/diag-six-modes.mjs (4256B)
tests/diag-six-smoke.mjs (3968B)
tests/verify-m1-wasd.mjs (4708B)
tests/verify-m2-layout.mjs (6877B)
tests/verify-m3-npc.mjs (6144B)
tests/verify-m4-jump.mjs (7149B)
tests/verify-m5-castle.mjs (7426B)
tests/verify-m6-zoo.mjs (8357B)
tests/verify-m7-districts.mjs (12546B)
tests/verify-m8-castle.mjs (8965B)
tests/verify-m9-farm.mjs (8062B)
tests/verify-redline.mjs (9283B)
tests/verify-six-upgrades.mjs (18491B)
tests/verify-v4.mjs (69632B)
tests/verify-zoo.mjs (10154B)
v3_spec.txt (30997B)
zoo/blender_mcp_bridge.py (4745B)
zoo/playground_zoo.blend (624001B)
zoo/s0_inspect.py (1290B)
zoo/s0_scene.json (1215B)
zoo/s1_layout.json (1572B)
zoo/s1_layout.py (9307B)
zoo/s2_animals.json (10658B)
zoo/s2_animals.py (11792B)
zoo/s3_motion.json (2030B)
zoo/s3_motion.py (10733B)
zoo/s4_finalize.py (5342B)
zoo/s4_inventory.json (15154B)
zoo/s4_report.json (1861B)
zoo/verify.py (7102B)
zoo/zoo_lib.py (9630B)
zoo/zoo_preview.png (1220921B)
zoo/zoo_verify.json (5006B)
本机私密信息.txt (645B)
游乐场MVP功能详细设计_v0.1.docx (24450B)
网站游乐场产品需求文档_PRD_v1.0.docx (43479B)
部署与更新说明.docx (55530B)
```

## 配置
```
index.html (480B)
package-lock.json (26247B)
package.json (470B)
pnpm-lock.yaml (18137B)
vite.config.js (968B)
```

## 其它
```
src/style.css (8852B)
启动游乐场.bat (2662B)
```
