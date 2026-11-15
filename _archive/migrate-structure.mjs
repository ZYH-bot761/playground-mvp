/**
 * 一次性目录重构工具（阶段 3）。
 * 1) 按 MAP 重写所有源码 / 测试里的相对 import 与 /src/ 绝对路径
 * 2) 再执行文件移动（git 可识别为 rename；不做任何删除）
 * 3) 把待删除候选「移动」到 _archive/（可逆，非删除）
 * 4) 输出「修改过的 import 路径数量」
 * 用完由外部移入 _archive/。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const P = (p) => path.join(ROOT, p);
const posix = (p) => p.replace(/\\/g, '/');

/** old -> new，工程根相对路径（posix），全部小写 + 短横线 */
const MAP = {
  // ---- src/core：场景 / 相机 / 渲染器 / 运行时封装 ----
  'src/core/SceneManager.js': 'src/core/scene-manager.js',
  'src/core/SceneContext.js': 'src/core/scene-context.js',
  'src/core/CameraRig.js': 'src/core/camera-rig.js',
  'src/core/AudioManager.js': 'src/core/audio-manager.js',
  'src/core/InteractionManager.js': 'src/core/interaction-manager.js',
  'src/core/PhysicsManager.js': 'src/core/physics-manager.js',
  'src/core/DisposableRegistry.js': 'src/core/disposable-registry.js',
  'src/core/FacilityRuntime.js': 'src/core/facility-runtime.js',
  'src/core/RenderOptimizer.js': 'src/core/render-optimizer.js',
  'src/core/UIManager.js': 'src/core/ui-manager.js',
  'src/attractions/AttractionManager.js': 'src/core/attraction-manager.js',
  // ---- src/components：控制器 / 标签 / 嵌入视图 / UI 组件 ----
  'src/core/MovementModeManager.js': 'src/components/controllers/movement-mode-manager.js',
  'src/core/WASDController.js': 'src/utils/controls/wasd-controller.js',
  'src/ui/DebugPanel.js': 'src/components/debug-panel.js',
  'src/ui/DistrictLabels.js': 'src/components/labels/district-labels.js',
  'src/ui/PauseMenu.js': 'src/components/pause-menu.js',
  'src/ui/StartScreen.js': 'src/components/start-screen.js',
  'src/features/hand/HandTracker.js': 'src/components/hand-tracker.js',
  'src/attractions/embedded/DemoEmbedView.js': 'src/components/embedded-views/demo-embed-view.js',
  'src/attractions/embedded/FerrisWheelEmbedView.js': 'src/components/embedded-views/ferris-wheel-embed-view.js',
  'src/attractions/embedded/IEmbeddedView.js': 'src/components/embedded-views/i-embedded-view.js',
  'src/attractions/embedded/JumpJumpEmbedView.js': 'src/components/embedded-views/jump-jump-embed-view.js',
  // ---- src/scenes：场景模块 ----
  'src/attractions/Lobby.js': 'src/scenes/lobby-scene.js',
  'src/attractions/Zoo.js': 'src/scenes/zoo-scene.js',
  'src/attractions/Districts.js': 'src/scenes/districts.js',
  'src/attractions/Castle.js': 'src/scenes/castle.js',
  'src/attractions/Farm.js': 'src/scenes/farm.js',
  'src/attractions/IAttraction.js': 'src/scenes/attractions/i-attraction.js',
  'src/attractions/DummyAttraction.js': 'src/scenes/attractions/dummy-attraction.js',
  'src/attractions/Carousel.js': 'src/scenes/attractions/carousel.js',
  'src/attractions/CenturyClock.js': 'src/scenes/attractions/century-clock.js',
  'src/attractions/FireworksDeck.js': 'src/scenes/attractions/fireworks-deck.js',
  'src/attractions/JumpJump.js': 'src/scenes/attractions/jump-jump.js',
  'src/attractions/MemoryMatch.js': 'src/scenes/attractions/memory-match.js',
  'src/attractions/ParkourRun.js': 'src/scenes/attractions/parkour-run.js',
  'src/attractions/PirateShip.js': 'src/scenes/attractions/pirate-ship.js',
  'src/attractions/PumpkinThrower.js': 'src/scenes/attractions/pumpkin-thrower.js',
  'src/attractions/TrainRide.js': 'src/scenes/attractions/train-ride.js',
  // ---- src/utils：loaders / helpers ----
  'src/utils/ModelLoader.js': 'src/utils/loaders/model-loader.js',
  'src/utils/modelLoaderSelfTest.js': 'src/utils/loaders/model-loader-self-test.js',
  'src/utils/CoasterCarRuntime.js': 'src/utils/helpers/coaster-car-runtime.js',
  'src/utils/DayNightCycle.js': 'src/utils/helpers/day-night-cycle.js',
  'src/utils/DetailLOD.js': 'src/utils/helpers/detail-lod.js',
  'src/utils/FacilityTextures.js': 'src/utils/helpers/facility-textures.js',
  'src/utils/NPCManager.js': 'src/utils/helpers/npc-manager.js',
  'src/utils/ParticleSystem.js': 'src/utils/helpers/particle-system.js',
  'src/utils/PerfMonitor.js': 'src/utils/helpers/perf-monitor.js',
  'src/utils/ProceduralCharacter.js': 'src/utils/helpers/procedural-character.js',
  'src/utils/QualityTier.js': 'src/utils/helpers/quality-tier.js',
  // ---- assets：models / textures ----
  'src/assets/models/visitor-ai.glb': 'assets/models/visitor-ai.glb',
  'src/assets/models/visitor-ai-preview.png': 'assets/textures/visitor-ai-preview.png',
  'src/assets/models/README.md': 'assets/models/readme.md',
  'src/assets/models/generated_model_20261111_1232_viewer.html': 'assets/models/model-viewer.html',
  // ---- public（Vite 静态托管，保持约定）----
  'public/models/hand_landmarker.task': 'public/models/hand-landmarker.task',
  // ---- docs / 根目录：去中文名、去下划线、去大写 ----
  'HANDOVER.md': 'docs/handover.md',
  'v3_spec.txt': 'docs/v3-spec.txt',
  '网站游乐场产品需求文档_PRD_v1.0.docx': 'docs/prd-v1.0.docx',
  '游乐场MVP功能详细设计_v0.1.docx': 'docs/design-spec-v0.1.docx',
  '部署与更新说明.docx': 'docs/deployment-guide.docx',
  '启动游乐场.bat': 'start-playground.bat',
  'docs/V3_HANDOFF.md': 'docs/v3-handoff.md',
  'docs/part1_architecture_report.md': 'docs/part1-architecture-report.md',
  'docs/part2_runtime_report.md': 'docs/part2-runtime-report.md',
  'docs/part3_camera_report.md': 'docs/part3-camera-report.md',
  'docs/part4_modelloader_report.md': 'docs/part4-model-loader-report.md',
  'docs/part5_visual_report.md': 'docs/part5-visual-report.md',
  'docs/v3_module0_report.md': 'docs/v3-module0-report.md',
  'docs/v4_lobby_final_spec.md': 'docs/v4-lobby-final-spec.md',
  'docs/v4_refactor_plan.md': 'docs/v4-refactor-plan.md',
  'docs/v4_status_and_handoff.md': 'docs/v4-status-and-handoff.md',
};

/** 待删除候选：一律「移动」进 _archive/，不执行删除（等待用户确认） */
const ARCHIVE = {
  '.tmp_t04b_arb.mjs': '_archive/tmp-t04b-arb.mjs',
  '.tmp_t04b_diag.mjs': '_archive/tmp-t04b-diag.mjs',
  '.tmp_t04b_final.mjs': '_archive/tmp-t04b-final.mjs',
  '.tmp_t04b_reassign.mjs': '_archive/tmp-t04b-reassign.mjs',
  '.tmp_t04b_restore.mjs': '_archive/tmp-t04b-restore.mjs',
  '.tmp-preview-5176.log': '_archive/tmp-preview-5176.log',
  '.merkle-snapshot.json': '_archive/merkle-snapshot.json',
  '.tmp-pkg-inspect': '_archive/tmp-pkg-inspect',
  '.tmp-t07': '_archive/tmp-t07',
  '.tmp-blender': '_archive/tmp-blender',
  '.arts': '_archive/arts',
  '.codeartsdoer': '_archive/codeartsdoer',
  'src/assets/hero.png': '_archive/hero.png',
  'src/assets/javascript.svg': '_archive/javascript.svg',
  'src/assets/vite.svg': '_archive/vite.svg',
  'public/icons.svg': '_archive/icons.svg',
  'src/assets/models/visitor-ai-obj.zip': '_archive/visitor-ai-obj.zip',
  'docs/screenshots/v4-t05-td-06-facility-back-day.png': '_archive/dup-v4-t05-td-06-facility-back-day.png',
  'docs/screenshots/v4-t05-td-05-facility-front-day.png': '_archive/dup-v4-t05-td-05-facility-front-day.png',
  'docs/_audit-scan.mjs': '_archive/audit-scan.mjs',
};

const reverseKeys = Object.keys(MAP).sort((a, b) => b.length - a.length);
const targetOf = (oldRel) => MAP[oldRel] || oldRel;

/** 需要重写路径的代码文件（.bat 为 GBK，读成 utf8 写回会损坏，必须排除） */
function collectTextFiles() {
  const out = [];
  const skipDir = new Set(['node_modules', '.git', 'dist', '.workbuddy', '_archive',
    '.tmp-blender', '.tmp-t07', '.tmp-pkg-inspect', '.arts', '.codeartsdoer']);
  const walk = (d) => {
    for (const e of fs.readdirSync(P(d), { withFileTypes: true })) {
      if (skipDir.has(e.name)) continue;
      const rel = posix(path.join(d, e.name));
      if (e.isDirectory()) { walk(rel); continue; }
      // 迁移工具自身与盘点快照不参与重写
      if (rel.startsWith('docs/_') || rel === 'docs/directory-audit.md') continue;
      if (isCodeFile(rel) || (rel.startsWith('docs/') && /\.md$/.test(rel))) out.push(rel);
    }
  };
  walk('.');
  return out;
}
function isCodeFile(f) {
  return (f.startsWith('src/') && /\.(js|css|html)$/.test(f))
    || (f.startsWith('tests/') && /\.(mjs|js)$/.test(f))
    || f === 'index.html' || f === 'vite.config.js'
    || (f.startsWith('assets/') && /\.html$/.test(f));
}

let rewritten = 0;
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g;

// ---------- 1) 重写所有 import / 绝对路径 ----------
for (const file of collectTextFiles()) {
  let text;
  try { text = fs.readFileSync(P(file), 'utf8'); } catch { continue; }
  const oldDir = path.posix.dirname(file);
  const newDir = path.posix.dirname(targetOf(file));
  let n = 0;
  let out = text.replace(IMPORT_RE, (whole, prefix, q, spec) => {
    if (!spec.startsWith('.')) return whole;
    const clean = spec.split(/[?#]/)[0];
    const oldTarget = path.posix.normalize(path.posix.join(oldDir, clean));
    const newTarget = targetOf(oldTarget);
    let rel = path.posix.relative(newDir, newTarget);
    if (!rel.startsWith('.')) rel = './' + rel;
    const next = rel + spec.slice(clean.length);
    if (next !== spec) n += 1;
    return prefix + q + next + q;
  });
  for (const oldRel of reverseKeys) {
    if (!oldRel.startsWith('src/')) continue;
    const needle = '/' + oldRel;
    if (out.includes(needle)) {
      n += out.split(needle).length - 1;
      out = out.split(needle).join('/' + targetOf(oldRel));
    }
  }
  // 文档/注释里的资产旧路径
  const b1 = out;
  out = out.split('src/assets/models/').join('assets/models/');
  if (b1 !== out) n += 1;
  if (out !== text) { fs.writeFileSync(P(file), out, 'utf8'); rewritten += n; }
}

// ---------- 2) 文档里的旧路径字符串同步（历史快照 directory-audit.md 不动）----------
for (const f of fs.readdirSync(P('docs'))) {
  if (!f.endsWith('.md') || f === 'directory-audit.md') continue;
  const rel = 'docs/' + f;
  let t = fs.readFileSync(P(rel), 'utf8');
  const before = t;
  for (const k of reverseKeys) t = t.split(k).join(MAP[k]);
  t = t.split('src/assets/models/').join('assets/models/');
  if (t !== before) fs.writeFileSync(P(rel), t, 'utf8');
}

// ---------- 3) 执行移动 ----------
let moved = 0;
for (const [from, to] of [...Object.entries(MAP), ...Object.entries(ARCHIVE)]) {
  if (!fs.existsSync(P(from))) { console.log('SKIP(missing): ' + from); continue; }
  fs.mkdirSync(P(path.posix.dirname(to)), { recursive: true });
  fs.renameSync(P(from), P(to));
  moved += 1;
}

// ---------- 4) 定点修正无法用通用规则覆盖的运行时 URL / 字符串（移动后）----------
const FIXES = [
  // ProceduralCharacter 从 src/utils/ 下移到 src/utils/helpers/，资产移到根 assets/models/
  ['src/utils/helpers/procedural-character.js',
    "['..', 'assets', 'models', 'visitor-ai.glb']",
    "['..', '..', '..', 'assets', 'models', 'visitor-ai.glb']"],
  // HandTracker 的 .task 改名
  ['src/components/hand-tracker.js',
    '/models/hand_landmarker.task',
    '/models/hand-landmarker.task'],
  // model-viewer.html 的贴图移到 assets/textures/
  ['assets/models/model-viewer.html',
    './visitor-ai-preview.png',
    '../textures/visitor-ai-preview.png'],
];
for (const [f, from, to] of FIXES) {
  if (!fs.existsSync(P(f))) continue;
  const t = fs.readFileSync(P(f), 'utf8');
  if (t.includes(from)) { fs.writeFileSync(P(f), t.split(from).join(to), 'utf8'); rewritten += 1; }
}

// ---------- 5) 迁移后清空目录 ----------
for (const d of ['src/attractions/embedded', 'src/attractions', 'src/ui', 'src/features/hand',
  'src/features', 'src/assets/models', 'src/assets', 'public/models']) {
  try { if (fs.existsSync(P(d)) && fs.readdirSync(P(d)).length === 0) fs.rmdirSync(P(d)); } catch { /* noop */ }
}

console.log('REWRITTEN_IMPORT_PATHS=' + rewritten);
console.log('MOVED_FILES=' + moved);
