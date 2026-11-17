/**
 * ============================================================================
 * scripts/generate-doc.js —— 阶段 5：企业级交接文档生成
 * ============================================================================
 * 运行：npm run docs:handover   （或 node scripts/generate-doc.js）
 * 产出：项目根目录/项目信息.docx
 *
 * 数据口径（2026-11-16 最终验收）：
 *   - Redline：8/8，俯瞰 1,198 calls / 285,242 tris；常规 1,154 / 278,498
 *   - 阶段峰值：287,234 tris；最终稳态：108 geometries / 47 textures
 *   - 四季：16/16；驾驶：21/21；动物园：8/8；阶段二：20/20
 *   - npm run build：通过
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  SectionType,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '项目信息.docx');

const FONT = 'Microsoft YaHei';
const MONO = 'Consolas';
const C = {
  ink: '17343D',
  body: '294850',
  muted: '60757D',
  teal: '0F5C6B',
  tealDeep: '0A3E49',
  tealSoft: 'EAF4F6',
  amber: 'B96E26',
  amberSoft: 'FFF4E8',
  red: 'B03A2E',
  redSoft: 'FDEDEA',
  green: '2E7D5B',
  greenSoft: 'EAF6F0',
  line: 'CBDDE2',
  fill: 'F4F8F9',
  white: 'FFFFFF',
};

const PAGE_W = 11906; // A4 twips
const PAGE_H = 16838;
const MARGIN = 1020;

/* -------------------------------------------------------------------------- */
/* 基础排版工具                                                                */
/* -------------------------------------------------------------------------- */

const run = (text, opts = {}) => new TextRun({
  text,
  font: opts.mono ? MONO : FONT,
  size: opts.size ?? 20,
  bold: opts.bold ?? false,
  italics: opts.italics ?? false,
  color: opts.color ?? C.body,
  underline: opts.underline ? {} : undefined,
  break: opts.break ?? 0,
});

const p = (text, opts = {}) => new Paragraph({
  alignment: opts.align,
  spacing: {
    before: opts.before ?? 0,
    after: opts.after ?? 110,
    line: opts.line ?? 300,
  },
  indent: opts.indent,
  border: opts.border,
  keepNext: opts.keepNext ?? false,
  children: opts.runs ?? [run(text, opts.run)],
});

const h1 = (no, title, first = false) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  pageBreakBefore: !first,
  keepNext: true,
  spacing: { before: first ? 0 : 300, after: 180 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: C.teal, space: 5 } },
  children: [
    run(`${no}  `, { size: 32, bold: true, color: C.amber }),
    run(title, { size: 32, bold: true, color: C.tealDeep }),
  ],
});

const h2 = (no, title) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  keepNext: true,
  spacing: { before: 260, after: 100 },
  children: [
    run(`${no}  `, { size: 24, bold: true, color: C.amber }),
    run(title, { size: 24, bold: true, color: C.teal }),
  ],
});

const h3 = (title) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  keepNext: true,
  spacing: { before: 180, after: 70 },
  children: [run(title, { size: 21, bold: true, color: C.ink })],
});

const bullet = (text, level = 0) => new Paragraph({
  bullet: { level },
  spacing: { before: 0, after: 70, line: 285 },
  indent: { left: 360 + level * 300, hanging: 210 },
  children: [run(text, { size: 20, color: C.body })],
});

const checkItem = (text) => new Paragraph({
  spacing: { before: 0, after: 70, line: 285 },
  indent: { left: 330, hanging: 240 },
  children: [
    run('□  ', { size: 22, bold: true, color: C.teal }),
    run(text, { size: 20, color: C.body }),
  ],
});

const paragraphWithLead = (lead, text) => new Paragraph({
  alignment: AlignmentType.JUSTIFIED,
  spacing: { before: 0, after: 100, line: 300 },
  children: [
    run(lead, { size: 20, bold: true, color: C.teal }),
    run(text, { size: 20, color: C.body }),
  ],
});

const cellParagraphs = (value, opts = {}) => String(value).split('\n').map((line, i) => new Paragraph({
  alignment: opts.align,
  spacing: { before: 0, after: i === String(value).split('\n').length - 1 ? 0 : 40, line: 245 },
  children: [run(line, {
    size: opts.size ?? 18,
    bold: opts.bold ?? false,
    color: opts.color ?? C.body,
    mono: opts.mono ?? false,
  })],
}));

const cell = (value, opts = {}) => new TableCell({
  width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
  shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill, color: 'auto' } : undefined,
  margins: { top: 90, bottom: 90, left: 110, right: 110 },
  verticalAlign: VerticalAlign.CENTER,
  children: cellParagraphs(value, opts),
});

const table = (headers, rows, widths, opts = {}) => {
  const border = { style: BorderStyle.SINGLE, size: 4, color: C.line };
  const borders = {
    top: border, bottom: border, left: border, right: border,
    insideHorizontal: border, insideVertical: border,
  };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders,
    rows: [
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: headers.map((h, i) => cell(h, {
          width: widths[i],
          fill: opts.headerFill ?? C.teal,
          color: C.white,
          bold: true,
          size: 18,
          align: AlignmentType.CENTER,
        })),
      }),
      ...rows.map((r) => new TableRow({
        cantSplit: true,
        children: r.map((v, i) => cell(v, {
          width: widths[i],
          fill: opts.zebra && rows.indexOf(r) % 2 === 1 ? C.fill : undefined,
          bold: i === 0 && opts.firstColBold,
          color: i === 0 && opts.firstColBold ? C.ink : C.body,
          size: opts.size ?? 18,
        })),
      })),
    ],
  });
};

const callout = (title, lines, kind = 'info') => {
  const palette = {
    info: { fill: C.tealSoft, accent: C.teal },
    warn: { fill: C.amberSoft, accent: C.amber },
    danger: { fill: C.redSoft, accent: C.red },
    success: { fill: C.greenSoft, accent: C.green },
  }[kind];
  const content = Array.isArray(lines) ? lines : [lines];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      left: { style: BorderStyle.SINGLE, size: 24, color: palette.accent },
    },
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: palette.fill, color: 'auto' },
        margins: { top: 150, bottom: 150, left: 210, right: 210 },
        children: [
          new Paragraph({
            spacing: { before: 0, after: 70, line: 270 },
            children: [run(title, { size: 20, bold: true, color: palette.accent })],
          }),
          ...content.map((line, i) => new Paragraph({
            spacing: { before: 0, after: i === content.length - 1 ? 0 : 50, line: 285 },
            children: [run(line, { size: 19, color: C.body })],
          })),
        ],
      })],
    })],
  });
};

const codeBlock = (lines) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  layout: TableLayoutType.FIXED,
  borders: {
    top: { style: BorderStyle.SINGLE, size: 4, color: C.line },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: C.line },
    left: { style: BorderStyle.SINGLE, size: 18, color: C.teal },
    right: { style: BorderStyle.SINGLE, size: 4, color: C.line },
    insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  },
  rows: [new TableRow({
    cantSplit: false,
    children: [new TableCell({
      shading: { type: ShadingType.CLEAR, fill: 'F2F6F7', color: 'auto' },
      margins: { top: 140, bottom: 140, left: 200, right: 180 },
      children: lines.map((line, i) => new Paragraph({
        spacing: { before: 0, after: i === lines.length - 1 ? 0 : 30, line: 240 },
        children: [run(line || ' ', { size: 16, color: '24434C', mono: true })],
      })),
    })],
  })],
});

const divider = () => new Paragraph({
  spacing: { before: 100, after: 100 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 1 } },
  children: [],
});

const kv = (k, v) => [k, v];

/* -------------------------------------------------------------------------- */
/* 文档内容                                                                    */
/* -------------------------------------------------------------------------- */

const cover = [
  new Paragraph({ spacing: { before: 300, after: 0 }, children: [] }),
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    },
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: C.tealDeep, color: 'auto' },
        margins: { top: 430, bottom: 430, left: 430, right: 430 },
        children: [
          new Paragraph({
            spacing: { before: 0, after: 120 },
            children: [run('SCNET  ·  PROJECT HANDOVER', { size: 17, bold: true, color: '9FD6DE' })],
          }),
          new Paragraph({
            spacing: { before: 0, after: 70 },
            children: [run('项目信息', { size: 58, bold: true, color: C.white })],
          }),
          new Paragraph({
            spacing: { before: 0, after: 180 },
            children: [run('GTA 级微缩城市 · 企业级交接文档', { size: 24, color: 'D8EEF1' })],
          }),
          new Paragraph({
            spacing: { before: 0, after: 0 },
            border: { top: { style: BorderStyle.SINGLE, size: 10, color: C.amber, space: 2 } },
            children: [run('THREE.JS  +  RAPIER  +  VITE', { size: 16, bold: true, color: 'F3C68E' })],
          }),
        ],
      })],
    })],
  }),
  new Paragraph({ spacing: { before: 260, after: 100 }, children: [] }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 60 },
    children: [run('阶段 5 · 最终交付', { size: 22, bold: true, color: C.amber })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 220 },
    children: [run('从“能跑”到“能交接”：架构、坐标、系统、预算与接手红线', { size: 18, color: C.muted })],
  }),
  table(
    ['文档项', '内容'],
    [
      kv('文档版本', 'v1.0 / 最终交接版'),
      kv('适用阶段', '阶段 1–5 已完成；项目毕业'),
      kv('最后验证', '2026-11-16'),
      kv('代码状态', 'npm run build 通过；核心验收 73/73 项通过'),
      kv('技术栈', 'Three.js 0.187 / Rapier 0.21 / Vite 8.3'),
      kv('文档定位', '给下一位模型与人类维护者的“第一份真相源”'),
    ],
    [22, 78],
    { firstColBold: true, zebra: true, size: 18 },
  ),
  new Paragraph({ spacing: { before: 220, after: 0 }, children: [] }),
  callout('一句话定位', [
    '一个可步行、可驾车、可昼夜与四季切换的 Three.js 微缩城市；所有资产程序化生成，物理按需懒加载，性能红线由脚本守门。',
  ], 'info'),
];

const summary = [
  h1('00', '交付摘要', true),
  p('这不是需求文档，也不是功能宣传页，而是项目毕业时的工程交接单。它回答四个问题：项目由什么组成、坐标在哪里、全局系统怎么运转、下一位维护者绝对不能碰什么。', {
    align: AlignmentType.JUSTIFIED,
    after: 140,
  }),
  p('阶段 1–5 已完成：基础抢救、生态扩展、四季天气、GTA 驾驶、交接文档。当前代码通过生产构建，核心验收共 73/73 项通过；大厅全量视角 1,198 draw calls，三角面 285,242，仍低于 300,000 硬红线。', {
    align: AlignmentType.JUSTIFIED,
    after: 150,
  }),
  h2('0.1', '交付结论'),
  table(
    ['维度', '结论'],
    [
      ['产品状态', '可运行、可演示、可交接；项目按计划毕业'],
      ['运行形态', '单页 Web 3D 世界，无外部模型/贴图/音频依赖'],
      ['最终构建', 'npm run build 通过；vendor-physics 保持懒加载分块'],
      ['性能状态', '三角面 285,242 / 300,000；新增内容视角 calls 825 / 900'],
      ['资源纪律', '热路径 Δgeo=0 / Δtex=0；四季 8 次切换零泄漏'],
      ['交接风险', '坐标命名、全量 draw calls 口径、AI 车辆物理简化是三个首要注意点'],
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),
  h2('0.2', '文档导航'),
  table(
    ['章节', '回答的问题', '建议读者'],
    [
      ['01 项目架构概述', '用了什么、怎么跑、代码如何分层', '所有接手者'],
      ['02 核心区域与坐标', '五个区域在哪里、怎么进入、边界是什么', '场景/关卡/测试'],
      ['03 全局系统实现', '昼夜、四季、交通、驾驶、NPC 如何工作', '系统开发者'],
      ['04 性能预算红线', '硬指标是多少、当前实测多少、LOD 怎么做', '所有改代码的人'],
      ['05 换模型接手指南', '先读哪些文件、哪些绝对不能碰、如何安全改动', '下一位模型 / 主程'],
      ['附录', '术语、验收记录、生成方式', '验收与归档'],
    ],
    [26, 52, 22],
    { firstColBold: true, zebra: true },
  ),
  new Paragraph({ spacing: { before: 180, after: 0 }, children: [] }),
  callout('先记住这一条', [
    '这个项目的性能不是“优化出来的”，而是“设计出来的”：InstancedMesh、对象池、LOD、懒加载与资源台账共同构成底座。任何新增内容，先问“它是否新增 geometry / texture / draw call”，再问“好不好看”。',
  ], 'warn'),
];

const architecture = [
  h1('01', '项目架构概述'),
  p('项目采用“单渲染器 + 多内容模块 + 单物理世界”的微缩城市架构。Three.js 负责渲染与相机，Rapier 只负责需要真实碰撞的玩法（驾驶、投掷等），Vite 负责开发与生产构建。', {
    align: AlignmentType.JUSTIFIED,
  }),
  h2('1.1', '技术栈与版本'),
  table(
    ['层', '技术 / 版本', '在本项目中的职责'],
    [
      ['渲染', 'Three.js 0.187', 'Scene / Camera / Renderer / EffectComposer / LOD / InstancedMesh'],
      ['物理', 'Rapier 0.21（@dimforge/rapier3d-compat）', '唯一 world.step；玩家车、投掷物、临时 collider'],
      ['构建', 'Vite 8.3', '开发服务器、生产构建、vendor 分包'],
      ['语言', 'JavaScript（ES Modules）', '无 TypeScript；靠契约、测试与注释约束'],
      ['测试', 'Node + Playwright + Edge Headless', '验收脚本直接读 window.__playground 运行时状态'],
      ['文档', 'docx 9.15.4', '本交接文档生成（只用于脚本，不进运行时）'],
    ],
    [14, 34, 52],
    { firstColBold: true, zebra: true },
  ),
  h2('1.2', '启动与渲染链路'),
  codeBlock([
    'index.html',
    '  └─ src/main.js',
    '      ├─ SceneManager        唯一 renderer / camera / composer / 渲染循环',
    '      ├─ AttractionManager   注册、激活、卸载、dispose 调度',
    '      ├─ PhysicsManager      Rapier 懒加载；全工程唯一 world.step',
    '      ├─ CameraRig           相机 owner 仲裁；设施/步行/驾驶互斥',
    '      └─ Lobby               常驻世界根节点',
    '          ├─ Zoo / Castle / Farm / ForestPark',
    '          ├─ Districts       四宫格骨架 + 区域级 LOD',
    '          └─ Metropolis      北侧 CBD / 交通 / 人群 / 驾驶',
    '',
    '每帧逻辑顺序（简化）：',
    '  physicsManager.step(dt)  →  attractionManager.update(dt)',
    '  →  cameraRig.update(dt)  →  composer.render()',
  ]),
  new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }),
  p('关键点：大厅本身不是“一个设施”，而是常驻世界；动物园、城堡、农家乐、森林公园、都会区都挂在大厅根节点下。进入小游戏只是激活一个设施副本，世界不被销毁。', {
    align: AlignmentType.JUSTIFIED,
  }),
  h2('1.3', '代码分层'),
  table(
    ['目录', '职责', '典型文件'],
    [
      ['src/core', '场景、渲染、物理、注册、相机仲裁、资源清理', 'scene-manager.js / attraction-manager.js / physics-manager.js / camera-rig.js'],
      ['src/scenes', '大厅与五个区域的内容工厂', 'lobby-scene.js / zoo-scene.js / castle.js / farm.js / forest-park.js / districts.js'],
      ['src/scenes/metropolis', 'CBD 街区、交通、信号灯、人群、驾驶', 'city-layout.js / city-buildings.js / city-traffic.js / city-driving.js'],
      ['src/components', '输入、UI、嵌入视图、开始页、暂停菜单', 'movement-mode-manager.js / start-screen.js / pause-menu.js'],
      ['src/utils', '昼夜、四季、粒子、NPC、程序化纹理、模型加载', 'day-night-cycle.js / season-cycle.js / particle-system.js / npc-manager.js'],
      ['tests', '验收与预算守门', 'verify-redline.mjs / verify-season.mjs / verify-driving.mjs / verify-phase2.mjs'],
    ],
    [18, 44, 38],
    { firstColBold: true, zebra: true },
  ),
  h2('1.4', '五个必须保留的架构决策'),
  bullet('零外部资产：所有外观由程序化几何 + Canvas/DataTexture 生成；不依赖 glb、贴图或音频文件。'),
  bullet('单渲染器 / 单物理世界：不要新建 WebGLRenderer，不要另起 Rapier world。'),
  bullet('按需物理：Rapier 只在真正需要物理的设施或驾驶时动态 import；启动不预取。'),
  bullet('资源台账：几何、材质、纹理、InstancedMesh 必须成对 dispose；大厅有七步清理流程。'),
  bullet('脚本守门：性能与功能验收都落成 tests/*.mjs，不靠肉眼判断“应该没问题”。'),
  new Paragraph({ spacing: { before: 140, after: 0 }, children: [] }),
  callout('架构层面的“不要创新”', [
    '这里不是从零搭框架的舞台。新增模块应复用 SceneManager、AttractionManager、PhysicsManager、CameraRig 与资源台账；另起一套生命周期，通常会以相机双写、资源泄漏或物理世界冲突收场。',
  ], 'warn'),
];

const regions = [
  h1('02', '核心区域与坐标'),
  p('所有区域共享同一套世界坐标：x / z 为水平面，y 向上；四宫格外框为 x∈[-30,90]、z∈[-30,90]，都会区继续向 z 正方向延伸到 245。改坐标前先读 src/scenes/districts.js 与 src/scenes/metropolis/city-layout.js，不要凭记忆手写。', {
    align: AlignmentType.JUSTIFIED,
  }),
  h2('2.1', '区域总表'),
  table(
    ['区域', '世界坐标 / 范围', '规模与内容', '进入方式'],
    [
      ['中央游乐场', '原点 (0,0)\n南门 z=15\nFACILITIES 9 个入口', '世纪钟、摩天轮、旋转木马、海盗船、跑酷、小火车、魔法牌屋、跳舞厅、烟花台', '开始页 → 大厅；点击入口光圈 / 箭头，或 WASD 走近后交互；M 切换第一人称'],
      ['动物园', '四区 x∈[32,88]、z∈[-26,26]\n非洲草原 z∈[-55,-29]', '家禽 / 爬行 / 海洋 / 哺乳 / 非洲草原五区；43 个动物实例（含草原 7 只）', '右上角「🦁 去动物园」相机飞越；或沿 +x 方向步行；返回按钮回中央广场'],
      ['城堡园', '四宫格左上格，中心 (-7,60)\n导视牌 (0,31.6)', '46×46 台地；8 座塔楼 22–35m；148 扇拱窗；6,272 tris / 16 calls', '从 z=27 北侧横路向 +z 步行或 Orbit 俯瞰；不是独立副本，无加载页面'],
      ['农家宝', '四宫格右上格，中心 (60,60)\n导视牌 (60,31.6)', '水稻 / 玉米 / 小麦 / 菜圃；968 个作物实例；25,052 tris / 14 calls', '沿北侧横路到 x=60，再向 +z；无独立副本，直接在世界中游览'],
      ['都会区 / CBD', '中心 (0,170)\n范围 x∈[-95,95]、z∈[94,245]\n主干道 x=24', '9 个原始街块 → 6 座建筑（医院/学校/商场 + 3 座地标塔）；9 个信号路口；10 行驶车 + 2 停放车 + 1 公交', '沿 x=24 主干道从 z=90 向 +z 步行；或开车沿同一主干道进入；无传送门'],
      ['森林公园', 'x∈[-104,-38]、z∈[44,92]\n中心 (-71,68)', '林地、步道、水塘、市民与狗；四季植被重点展示区', '从广场向西步行；入口牌位于 x≈-38、z≈59'],
      ['停车场 / 上车点', '(-30,98) 两辆停放车\n公交站 (32.4,38)', '驾驶系统的起始车辆；公交下客点', '步行靠近 4.2m 内出现「按 F 上车」；F 上车 / 下车'],
    ],
    [14, 27, 34, 25],
    { firstColBold: true, zebra: true, size: 17 },
  ),
  h2('2.2', '推荐路线'),
  codeBlock([
    '入园：开始页 → Lobby(0,0) → 南门 (0,15) 进入广场',
    '动物园：右上「去动物园」→ 相机飞越 → 再点「返回中央广场」',
    '城堡：Lobby → z=27 北侧横路 → 向 +z 到 (-7,60)',
    '农家宝：Lobby → z=27 北侧横路 → 向 +x 到 (60,60)',
    'CBD：Lobby → x=24 主干道 → z=90 公园北缘 → z=170 都会区',
    '开车：CBD 停车场 (-30,98) → 靠近车辆 → F 上车 → W/S/A/D',
  ]),
  new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }),
  h2('2.3', '坐标命名的坑'),
  callout('“南门”是建筑名，不是 +z 方向', [
    '代码口径中 +z 指向四宫格北侧与都会区，南门只是入口建筑的命名。不要根据“南门”推断坐标正负，也不要据“北侧都会区”反推相机朝向。',
    '新增内容时，以 DISTRICT_GRID、CITY、ZOO_LAYOUT、FOREST_PARK 为单一真相源；手写坐标前先 grep 这些常量。',
  ], 'warn'),
  paragraphWithLead('道路红线：', '主干道 x=24、净宽 16m（13m 车行道 + 两侧 1.5m 人行道）；所有建筑体量离道路红线至少 2m。城市扩展先跑 isOnRoad() 扫描，不要靠目测。'),
  paragraphWithLead('四宫格边界：', 'outer 为 x∈[-30,90]、z∈[-30,90]；北侧两区通过 z=27 的横路连接。城堡与农场的几何是世界坐标烘焙进顶点的，移动区域时要同步 _rebase，不能只改 group.position。'),
];

const systems = [
  h1('03', '全局系统实现'),
  p('全局系统共享一条原则：热路径只改标量、矩阵、uniform 或 DOM 文本，不在 update 里创建 GPU 资源。下面的实现细节，是接手时最值得先读的部分。', {
    align: AlignmentType.JUSTIFIED,
  }),
  h2('3.1', '昼夜循环'),
  paragraphWithLead('入口：', 'src/utils/helpers/day-night-cycle.js；由 Lobby 右下时间台和自动循环驱动。'),
  table(
    ['模式', '视觉基调', '关键参数（标定后）'],
    [
      ['白天 day', '日光、清晰远景、轻 Bloom', '主光 0.58；环境 0.07；曝光 1.0；Bloom 0.06 / 阈值 1.4'],
      ['黄昏 sunset', '橙色天空、长阴影、霓虹初亮', '主光约 0.31；曝光 0.94；Bloom 0.22 / 阈值 0.95；霓虹 ×1.7'],
      ['黑夜 night', '深蓝夜空、月亮/星空、霓虹与窗光', '主光约 0.04；曝光 0.86；Bloom 0.55 / 阈值 0.55；霓虹 ×3.6'],
    ],
    [18, 34, 48],
    { firstColBold: true, zebra: true },
  ),
  bullet('自动循环：默认关闭；开启后 480s 一轮（可设 300–600s），在 day → sunset → night 之间插值。'),
  bullet('统一驱动：太阳/月亮、星空、天空球、雾、环境光、霓虹 emissive、Bloom 强度都在同一状态机里过渡。'),
  bullet('四季联动：season-cycle 通过 setSeasonLightScale() 调整主光，不另起一套灯光。'),
  bullet('设施上下文：嵌入设施通过 registerEmbeddedContext() 注册，不复制昼夜逻辑。'),
  h2('3.2', '四季天气与粒子池'),
  paragraphWithLead('入口：', 'src/utils/helpers/season-cycle.js + src/utils/helpers/particle-system.js。'),
  table(
    ['季节', '植被基调', '天气', '发射量 / 节奏'],
    [
      ['春 spring', '嫩绿地面、亮绿阔叶、深绿针叶', '花瓣 petal', '每次 16 枚，间隔 0.26s'],
      ['夏 summer', '深绿、浓密、太阳最强', '阵雨 rain + 地面波纹', '每次 36 滴，间隔 0.13s；间歇阵雨'],
      ['秋 autumn', '黄褐地面、橙红阔叶、针叶保持深绿', '落叶 leaf', '每次 16 片，间隔 0.24s'],
      ['冬 winter', '雪白地面、冷色树冠', '雪花 snow', '每次 24 片，间隔 0.18s'],
    ],
    [17, 42, 20, 21],
    { firstColBold: true, zebra: true },
  ),
  bullet('材质分角色注入：ground / broad / conifer / shrub / grass 五个角色分别持有 uniform，切换时只 lerp 颜色。'),
  bullet('天气复用烟花系统的 3000 粒子池与同一套 Points 几何；weather 只是第二个绘制批次，不新建几何/纹理。'),
  bullet('峰值上限：weather 同时最多 760 个粒子；clearWeather() 后槽位全部归还（freeTop=3000）。'),
  bullet('update 中绝不 new 粒子：只从池中取、写属性、归还；8 次四季切换实测 Δgeo=0 / Δtex=0。'),
  h2('3.3', '红绿灯交通流'),
  paragraphWithLead('入口：', 'src/scenes/metropolis/city-signals.js + city-traffic.js + city-street.js。'),
  table(
    ['对象', '数量 / 实现', '性能策略'],
    [
      ['行驶车', '10 辆，3 条闭合路线', '车身/车顶/车轮各一个 InstancedMesh；路线 256 点预采样'],
      ['停放车', '2 辆，位于 (-30,98) 一带', '同一 InstancedMesh 的实例；可被玩家认领'],
      ['公交', '1 辆，沿公交路线循环', '独立低模 Mesh；到站触发下客'],
      ['信号灯', '9 个十字路口，灯头实例化', '按轴相位；车辆在停车线前减速'],
      ['路灯 / 地面光斑', '街道设施，InstancedMesh', '夜间切换透明度，不新增灯源'],
    ],
    [18, 46, 36],
    { firstColBold: true, zebra: true },
  ),
  bullet('路线：CatmullRom 预采样 256 点；运行时只推进标量 t/s，再按车道法线偏移 ±3.25m，不在每帧重算样条。'),
  bullet('信号：车辆按前方最近路口和轴向读灯色；红灯/黄灯在停车线前停，绿灯恢复目标速度。'),
  bullet('公交：BUS_STOP (32.4,38)；到站触发 CityCrowd.activateAlighters()，下客后继续行驶。'),
  bullet('夜间：头灯/尾灯/地面光斑由 setNight() 统一调透明度；不新增 PointLight。'),
  h2('3.4', 'GTA 驾驶'),
  paragraphWithLead('入口：', 'src/scenes/metropolis/city-driving.js；Lobby 负责 F 键仲裁与 HUD。'),
  table(
    ['项目', '实现值 / 行为'],
    [
      ['上车条件', '玩家在 WASD 模式、距最近 AI 车 ≤4.2m；HUD 显示「按 F 上车」'],
      ['玩家车', 'Rapier dynamic body；6 个视觉部件复用 CityTraffic 的 body/cabin/wheel 几何'],
      ['质量 / 碰撞', '约 321.5 kg；一个 cuboid collider；X/Z 旋转锁死，只保留 Y 轴转向'],
      ['动力', 'W/S：前进 9.5 m/s²；制动 -13.5；倒车 -5.2；前进上限 17.5 m/s（约 63 km/h）'],
      ['转向', 'A/D：目标角速度 1.45 rad/s；低速转向弱，倒车自动反向'],
      ['横向抓地', 'exp(-8.5·dt) 衰减；地面摩擦 0.05，避免蹭地拖慢'],
      ['AI 车辆', '最多 12 个 kinematic 包围盒（10 行驶 + 2 停放 + 1 公交，扣除当前认领车）；不升级为动态物理'],
      ['物理体数量', '驾驶中 14 个（1 静态 + 1 玩家 + 12 AI）；下车后 0 个'],
      ['下车', 'F 退出；车身左侧 2.1m 找落点；AI 车留在停车位置；相机交还 WASD'],
    ],
    [20, 80],
    { firstColBold: true, zebra: true, size: 17 },
  ),
  new Paragraph({ spacing: { before: 120, after: 0 }, children: [] }),
  callout('驾驶系统的性能边界', [
    '玩家车保留完整物理；AI 车只做简化运动学包围盒。不要为了“更真实”把 12 辆 AI 车全部改成动态刚体——那会同时击穿物理 CPU 预算与稳定性。',
    '玩家车视觉不新建几何：6 个部件全部复用交通系统的 body/cabin/wheel；材质只在首次上车创建一次。',
  ], 'warn'),
  h2('3.5', 'NPC 状态机'),
  paragraphWithLead('入口：', 'src/utils/helpers/npc-manager.js（大厅 10 个 NPC）；src/scenes/metropolis/city-crowd.js（都会区 11 个低模行人）。'),
  table(
    ['维度', '大厅 NPC', '都会区行人'],
    [
      ['数量', '10 个（4 个入口迎宾 + 6 个巡游）', '11 个（6 walker + 2 医院访客 + 3 公交下客）'],
      ['渲染', '1 个 InstancedMesh = 1 draw call', '身体/头/腿各一个 InstancedMesh'],
      ['状态', 'WALK / IDLE / LOOK / WAVE 四态', '沿路径行走 / 到站下客 / 访客路径'],
      ['寻路', 'BFS 导航图，2.4m 网格、八邻域；AABB 避障', '预采样路径 + 碰撞回退'],
      ['动画', '顶点着色器驱动走路/摆臂/挥手/张望；CPU 只写 aAnim', '实例矩阵 + 简单摆动'],
    ],
    [16, 44, 40],
    { firstColBold: true, zebra: true },
  ),
  bullet('状态迁移是手写字段 + dt 累计，不是通用 FSM 框架；新增状态时沿用现有状态表，不要另建第二套计时器。'),
  bullet('BFS 路径的相邻点必须通过 AABB 线段检测；斜穿墙角是历史 bug，已通过整段采样修复。'),
  bullet('NPC 边界与玩家边界不同：大厅 NPC 默认 NAV_RADIUS=31，M7 后可通过 setBounds 扩展；不要误用玩家 110m 边界。'),
  h2('3.6', '渲染、LOD 与后处理'),
  table(
    ['层次', '策略', '关键参数 / 文件'],
    [
      ['都会区建筑', '三级 LOD：near / mid / far', '0m / 160m / 260m；近景 1,474 tris，中/远各 252 tris'],
      ['四宫格北区', '区域级 THREE.LOD：detail / silhouette', 'lodDistance=100m；远离时只渲染剪影'],
      ['设施', 'DetailLOD 包装', '90m / 115m 阈值；设施内部再按需简化'],
      ['重复物件', 'InstancedMesh', '树、作物、车辆、动物、行人、路灯、金币、灯泡'],
      ['后处理', 'RenderPass → Bloom → FXAA → OutputPass', 'ACES Filmic；移动端关 Bloom、降阴影/折射'],
      ['阴影', '单一方向光投影 + 2048²（按画质降档）', '不新增投影灯；设施级仅跳舞厅等少数例外'],
    ],
    [18, 42, 40],
    { firstColBold: true, zebra: true },
  ),
  bullet('LOD 必须保持 autoUpdate，让 renderer 在投影阶段自动切换；不要重新“钉死高模”。'),
  bullet('新区内容保持 frustumCulled=true；不要为了“永不消失”强制常驻。'),
  bullet('北侧城堡/农场几何是世界坐标烘焙的；移动区域时用 _rebase，而不是只改 group.position。'),
];

const performance = [
  h1('04', '性能预算红线'),
  callout('口径纠偏：30 万是三角面，不是 Draw Call', [
    '本项目的硬红线是：三角面 ≤300,000；Draw Call 设计红线 900（针对新增内容/新视图）。',
    '把 30 万写成 Draw Call 会让下一位模型误判，甚至为了“压 calls”去合并不该合并的网格。两个指标必须分开看。',
  ], 'danger'),
  h2('4.1', '预算与最终实测'),
  table(
    ['指标', '红线', '最终实测', '判定'],
    [
      ['三角面（全场景）', '≤300,000', '285,242（Redline 俯瞰）\n287,234（阶段峰值）', 'PASS；距上限 12,766'],
      ['Draw Call（新增内容视角）', '≤900', '825（阶段二新内容峰值）', 'PASS'],
      ['Draw Call（大厅全量）', '非 900 口径', '1,198 俯瞰 / 1,154 常规', '既有内容基数；不要用它冒充新增内容'],
      ['稳态 GPU 资源', '热路径零增长', '108 geometries / 47 textures', 'Δgeo=0 / Δtex=0'],
      ['四季粒子', '≤760 同时存在', '峰值 760；clear 后 freeTop=3000', 'PASS'],
      ['驾驶物理体', '下车清零', '14 → 0', 'PASS'],
      ['生产构建', '必须通过', 'vite build ✓', 'PASS'],
    ],
    [24, 20, 34, 22],
    { firstColBold: true, zebra: true, size: 17 },
  ),
  new Paragraph({ spacing: { before: 140, after: 0 }, children: [] }),
  paragraphWithLead('为什么大厅全量 calls 会超过 900？', '900 是新增内容/新视图的设计红线；大厅全量包含 9 个设施、旧版广场装饰、四区与都会区，属于既有内容基数。当前 1,198 是“现状”，不是“达标”。若产品要求全量也压到 900，应另立合并网格与材质专项，不能用修改基线的方式掩盖。'),
  h2('4.2', 'LOD 策略'),
  table(
    ['对象', '近景', '中景', '远景', '目的'],
    [
      ['都会区建筑', '1,474 tris\n入口/招牌/红十字/跑道/窗光', '252 tris\n体块合并', '252 tris\n单色块 + 窗光贴图', '远景只保留天际线剪影'],
      ['城堡 / 农场', '完整细节（8 塔 / 968 作物）', '区域 LOD detail', 'silhouette', '北区远离大厅时自动降载'],
      ['设施', 'DetailLOD level 0', '90m 起简化', '115m 起剪影', '设施内部不拖垮大厅'],
      ['树 / 作物 / 车辆 / 动物 / 行人', 'InstancedMesh', '同上', '视锥剔除 + 距离 LOD', '把 draw call 压到常数级'],
    ],
    [18, 27, 18, 22, 15],
    { firstColBold: true, zebra: true, size: 17 },
  ),
  h2('4.3', '性能红线清单'),
  bullet('三角面总量不得超过 300,000；新增内容先估算面数，再动手。'),
  bullet('新增内容/新视图 draw calls 不得超过 900；大厅全量 1,198 是既有基数，不要混为一谈。'),
  bullet('热路径（update / render）不得 new BufferGeometry、Material、Texture、数组或 Date。'),
  bullet('所有重复物件必须 InstancedMesh；不要为 1000 棵树创建 1000 个 Mesh。'),
  bullet('所有资源必须进台账并成对 dispose；InstancedMesh 要单独 dispose instanceMatrix / instanceColor。'),
  bullet('不得新增常驻灯源或投影灯；夜景优先用 emissive、光斑贴图、Bloom。'),
  bullet('不得把 AI 车全部升级为动态刚体；玩家车完整物理，AI 车 kinematic。'),
  bullet('不得绕过粒子池上限；四季天气峰值 760，clear 必须归还全部槽位。'),
  bullet('不得改 CameraRig 的 owner 仲裁；相机只能有一个写者。'),
  bullet('不得为了让测试通过而改红线或基线；基线更新必须单独评审并归档旧值。'),
  h2('4.4', '交接验收命令'),
  codeBlock([
    'npm run build',
    'node tests/verify-redline.mjs M5',
    'node tests/verify-phase2.mjs',
    'node tests/verify-season.mjs',
    'node tests/verify-driving.mjs',
    'node tests/verify-m6-zoo.mjs',
    '',
    '最终记录：',
    '  Redline        8/8   PASS',
    '  Season        16/16  PASS',
    '  Driving       21/21  PASS',
    '  Zoo            8/8   PASS',
    '  Phase 2       20/20  PASS',
    '  Build          ✓     PASS',
  ]),
];

const handover = [
  h1('05', '换模型接手指南'),
  p('下一位模型不需要从 5,000 行 lobby-scene.js 的第一行读起。按下面的顺序建立“坐标—生命周期—性能”三张地图，再动代码。', {
    align: AlignmentType.JUSTIFIED,
  }),
  h2('5.1', '十分钟阅读顺序'),
  table(
    ['顺序', '读什么', '要建立什么认知'],
    [
      ['1', 'docs/project-map.md', '项目现状、历史阶段、已知坑与验收口径'],
      ['2', 'src/main.js', 'bootstrap、注册表、frameDriver、懒加载与预热门控'],
      ['3', 'src/core/attraction-manager.js + scene-manager.js', '设施生命周期、唯一渲染循环、资源清理'],
      ['4', 'src/scenes/districts.js + metropolis/city-layout.js', '四宫格、道路、都会区坐标单一真相源'],
      ['5', 'src/scenes/lobby-scene.js 的 FACILITIES / init / update / dispose', '大厅根节点、9 个入口、相机/输入互斥、七步清理'],
      ['6', 'season-cycle.js + particle-system.js + day-night-cycle.js', '全局氛围系统与粒子池纪律'],
      ['7', 'city-traffic.js + city-driving.js', '交通样条、AI 包围盒、玩家车物理与 F 键仲裁'],
      ['8', 'tests/verify-redline.mjs + verify-season.mjs + verify-driving.mjs', '什么叫“通过”，以及如何复现'],
    ],
    [8, 42, 50],
    { firstColBold: true, zebra: true },
  ),
  h2('5.2', '核心文件地图'),
  table(
    ['文件', '职责', '接手时的注意点'],
    [
      ['src/main.js', '唯一入口；注册、预热门控、frameDriver', '不要绕过 registry 直接 new 场景'],
      ['src/scenes/lobby-scene.js', '常驻大厅；FACILITIES、相机五态、UI、dispose', '只读需要的段；不要整体重排 FACILITIES'],
      ['src/scenes/metropolis/city-layout.js', 'CBD 坐标、道路、街块、公交站', '所有城市坐标以此为准'],
      ['src/scenes/metropolis/metropolis-scene.js', '城市组合、更新、夜景', '夜景只调材质，不加灯'],
      ['src/scenes/metropolis/city-traffic.js', '车流、公交、认领/归还、停车位', 'AI 车是视觉 + 运动学，不是动态刚体'],
      ['src/scenes/metropolis/city-driving.js', '玩家车完整物理、F 上下车、相机', '只在 F 时懒加载 Rapier；下车清零'],
      ['src/scenes/districts.js', '四宫格骨架、区域 LOD、城堡/农场挂载', '世界坐标烘焙；移动要 _rebase'],
      ['src/scenes/zoo-scene.js', '五区、43 个动物实例、围栏/水体', '动物全部实例化；不要逐个 Mesh'],
      ['src/scenes/castle.js', '8 塔、148 窗、6,272 tris', '合批几何；不要拆成独立小件'],
      ['src/scenes/farm.js', '7 类作物、968 实例', '作物不参与碰撞；叶图集共享'],
      ['src/scenes/forest-park.js', '林地、步道、水塘、市民', '四角色材质拆分；四季依赖它'],
      ['src/utils/helpers/season-cycle.js', '四季颜色、天气发射、材质注入', '不要合并 broad/conifer 角色'],
      ['src/utils/helpers/particle-system.js', '3000 粒子池、烟花、天气', 'update 中绝不 new 粒子'],
      ['src/utils/helpers/day-night-cycle.js', '三模式、自动循环、灯光/天空', '不要新增第二套灯光状态'],
      ['src/utils/helpers/npc-manager.js', '10 NPC、BFS、四态、1 IM', '状态机是手写字段，不是框架'],
      ['tests/verify-redline.mjs', '预算与结构守门', '不能通过改基线来“修复”回归'],
    ],
    [29, 36, 35],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  h2('5.3', '绝对不能碰的性能红线'),
  table(
    ['#', '红线', '违反后的典型症状'],
    [
      ['01', '三角面 >300,000', '低端机掉帧；Redline 直接失败'],
      ['02', '新增内容 calls >900', '城市/设施视角卡顿；draw call 审计失败'],
      ['03', 'update 里 new 几何/材质/纹理', 'Δgeo/Δtex 持续上涨；显存泄漏'],
      ['04', '重复物件不用 InstancedMesh', 'draw call 线性爆炸'],
      ['05', '新增常驻灯/投影灯', '阴影 pass 翻倍；移动端直接崩帧'],
      ['06', 'AI 车全部改动态刚体', '物理 CPU 爆炸；车辆互相顶飞'],
      ['07', '绕过粒子池 / 超过 760', '天气切换后资源不归还；峰值穿红线'],
      ['08', '破坏相机 owner 仲裁', '相机双写、视角拉扯、设施退出后回不来'],
      ['09', '破坏 Rapier 懒加载', '首屏加载 4.3MB vendor-physics，启动变慢'],
      ['10', '改基线/红线来让测试变绿', '真实回归被掩盖；下一位模型接手即踩雷'],
    ],
    [7, 38, 55],
    { firstColBold: true, zebra: true },
  ),
  h2('5.4', '安全改动流程'),
  table(
    ['步骤', '动作', '通过标准'],
    [
      ['1', '先跑基线：build + redline + 相关专项', '记录 geo/tex、calls、tris 与测试结果'],
      ['2', '改前先定位单一真相源', '坐标改动只改 layout/GRID；不手写重复坐标'],
      ['3', '新增内容先做预算估算', '面数、calls、材质/纹理数量写进改动说明'],
      ['4', '优先复用共享几何与材质', '能用 InstancedMesh 就不建 Mesh；能注入材质就不建新材质'],
      ['5', '跑完整验收，不只看截图', 'Δ0/0、预算、功能、0 console error 全过'],
      ['6', '基线有变化时单独说明', '归档旧基线；不把回归混进“优化”'],
    ],
    [10, 48, 42],
    { firstColBold: true, zebra: true },
  ),
  h2('5.5', '常见坑'),
  table(
    ['坑', '表现', '正确做法'],
    [
      ['把“南门”当 +z 方向', '新内容坐标整体反向', '以 DISTRICT_GRID / CITY 常量为准'],
      ['只改 group.position 移动北区', '碰撞、LOD、烘焙几何错位', '使用 _rebase 或重烘顶点'],
      ['把 LOD 钉死高模', '远景 draw calls 暴涨', '保持 autoUpdate，让 renderer 切换'],
      ['设施退出只 remove 不 dispose', 'Δgeo/Δtex 缓慢上涨', '走 DisposableRegistry + 七步清理'],
      ['城市夜景加 PointLight', '阴影/光照 pass 翻倍', '用 emissive、光斑贴图、Bloom'],
      ['NPC 用玩家 110m 边界', 'NPC 走出导航图/穿墙', '使用 NAV_RADIUS 或 setBounds'],
      ['把 30 万当 draw call 红线', '错误优化方向', '三角面 30 万；draw call 900'],
      ['为了测试通过改 baseline', '回归被隐藏', '先修实现，再评审是否更新基线'],
    ],
    [26, 32, 42],
    { firstColBold: true, zebra: true, size: 17 },
  ),
  h2('5.6', '交付确认'),
  checkItem('已阅读第 02 章坐标表，能说出五个区域的世界坐标与进入方式。'),
  checkItem('已阅读第 03 章，知道四季、交通、驾驶、NPC 的入口文件与性能边界。'),
  checkItem('已确认 300,000 是三角面红线，900 是新增内容 draw call 红线。'),
  checkItem('已能运行 build + redline + season + driving 四类验收。'),
  checkItem('已理解“不改基线、不新增常驻灯、不把 AI 车全改动态刚体”三条铁律。'),
];

const appendix = [
  h1('附录', '术语与验收记录'),
  h2('A.1', '术语表'),
  table(
    ['术语', '含义'],
    [
      ['Δgeo / Δtex', '同一稳态前后 renderer.info.memory 的几何/纹理数量差；红线为 0'],
      ['热路径', '每帧都会执行的 update / render 代码'],
      ['activeKey', '当前激活的设施 key；大厅常驻时仍是 lobby'],
      ['InstancedMesh', '一次 draw call 绘制多个实例；本项目重复物件的默认方案'],
      ['LOD', '按相机距离切换近/中/远模型；THREE.LOD 自动 update'],
      ['owner 仲裁', 'CameraRig 规定同一时刻只有一个相机写者'],
      ['3 万 / 5 万面', '本项目内部预算单位；最终硬上限是 300,000 三角面'],
      ['weather pool', '烟花/天气共用的 3000 粒子对象池；天气峰值 760'],
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),
  h2('A.2', '最终验收记录'),
  table(
    ['验收项', '结果', '证据 / 备注'],
    [
      ['生产构建', 'PASS', 'npm run build；vite build 完成'],
      ['Redline 工程约束', '8/8 PASS', 'docs/screenshots/redline-m3b.json'],
      ['阶段二生态扩展', '20/20 PASS', 'tests/verify-phase2.mjs'],
      ['四季天气', '16/16 PASS', 'tests/verify-season.mjs；8 次切换 Δ0/0'],
      ['GTA 驾驶', '21/21 PASS', 'tests/verify-driving.mjs；14 → 0 物理体'],
      ['动物园回归', '8/8 PASS', 'tests/verify-m6-zoo.mjs'],
      ['最终三角面', '285,242', 'Redline 俯瞰；峰值 287,234'],
      ['最终新增内容 calls', '825', '阶段二新内容峰值；红线 900'],
      ['console / pageerror', '0', 'Redline 运行期检查'],
    ],
    [26, 20, 54],
    { firstColBold: true, zebra: true },
  ),
  h2('A.3', '文档生成方式'),
  codeBlock([
    'npm install docx --save',
    'node scripts/generate-doc.js',
    '',
    '输出：',
    '  D:\\playground-mvp\\项目信息.docx',
    '',
    '脚本数据口径：',
    '  2026-11-16 最终验收 / Redline M3b / 阶段 5',
  ]),
  divider(),
  p('文档结束。项目已毕业；后续维护请先读第 05 章，再动第一行代码。', {
    align: AlignmentType.CENTER,
    run: { size: 18, color: C.muted },
    after: 0,
  }),
];

/* -------------------------------------------------------------------------- */
/* 组装文档                                                                    */
/* -------------------------------------------------------------------------- */

const styles = {
  default: {
    document: {
      run: { font: FONT, size: 20, color: C.body },
      paragraph: { spacing: { line: 300, after: 100 } },
    },
  },
  paragraphStyles: [
    {
      id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { font: FONT, size: 32, bold: true, color: C.tealDeep },
      paragraph: { spacing: { before: 300, after: 180 }, outlineLevel: 0 },
    },
    {
      id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { font: FONT, size: 24, bold: true, color: C.teal },
      paragraph: { spacing: { before: 260, after: 100 }, outlineLevel: 1 },
    },
    {
      id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { font: FONT, size: 21, bold: true, color: C.ink },
      paragraph: { spacing: { before: 180, after: 70 }, outlineLevel: 2 },
    },
  ],
};

const header = new Header({
  children: [
    new Paragraph({
      spacing: { before: 0, after: 40 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 2 } },
      tabStops: [{ type: 'right', position: 9800 }],
      children: [
        run('日光游乐场  /  项目信息', { size: 16, bold: true, color: C.teal }),
        run('\t阶段 5 · 企业级交接', { size: 15, color: C.muted }),
      ],
    }),
  ],
});

const footer = new Footer({
  children: [
    new Paragraph({
      spacing: { before: 40, after: 0 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 2 } },
      tabStops: [{ type: 'right', position: 9800 }],
      children: [
        run('内部资料 · v1.0 · 2026-11-16', { size: 15, color: C.muted }),
        new TextRun({
          children: ['\t第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'],
          font: FONT, size: 15, color: C.muted,
        }),
      ],
    }),
  ],
});

const doc = new Document({
  creator: 'SCNet',
  title: '项目信息',
  subject: 'GTA 级微缩城市企业级交接文档',
  description: '阶段 5 最终交接：架构、坐标、系统、性能红线与接手说明。',
  keywords: 'Three.js, Rapier, Vite, 微缩城市, 交接文档, 性能预算',
  styles,
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      children: cover,
    },
    {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: { top: MARGIN, right: MARGIN, bottom: 900, left: MARGIN },
        },
      },
      headers: { default: header },
      footers: { default: footer },
      children: [...summary, ...architecture, ...regions, ...systems, ...performance, ...handover, ...appendix],
    },
  ],
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buffer);

const stat = fs.statSync(OUT);
console.log('[项目信息.docx] 生成成功');
console.log(`  路径: ${OUT}`);
console.log(`  大小: ${(stat.size / 1024).toFixed(1)} KB`);
console.log('  章节: 00 摘要 / 01 架构 / 02 坐标 / 03 系统 / 04 预算 / 05 接手 / 附录');
console.log('  数据: Redline 8/8, Season 16/16, Driving 21/21, Build PASS');
