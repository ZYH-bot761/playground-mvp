/**
 * ============================================================================
 * scripts/generate-doc.js —— 项目信息.docx 生成器（v2.0 全量重写）
 * ============================================================================
 * 运行：npm run docs:handover   （或 node scripts/generate-doc.js）
 * 产出：项目根目录/项目信息.docx
 *
 * 数据口径（2026-11-19 当前工作区代码）：
 *   - docs/current-status.md 为唯一权威现状基准；本文件内容与其对齐
 *   - build PASS；verify-metropolis 19/19（maxTris 236,381 / maxCalls 741）
 *   - verify-redline 8/8（173,812 tris）；v4 13/13；season 16/16；driving 21/21
 *   - 别墅：villa-shell 7/7、villa-door 8/8、villa-embed 12/12
 *   - Blender 数据编译：轿车 3,444 tris、别墅外壳 5,612 tris（8 材质桶）
 *   - 9 个设施触发环 + 1 个都会区别墅门口；IEmbeddedView 同场并置
 *   - 300k 三角面红线，剩余余量 63,619；后续建筑精修各 ≤12,000
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
// 默认覆盖主文档；若 Word/WPS 正占用该文件，可用 DOC_OUT 环境变量输出到旁路文件。
const OUT = path.join(ROOT, process.env.DOC_OUT || '项目信息.docx');

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

/* kv 是「一行单元格」的简写，列数不固定：三 / 四列表也用它书写数据行。
 * 旧版写成 (k, v) => [k, v]，第 3、4 个实参被静默丢弃，docx 里就出现
 * 表头 4 列、数据行只剩 2 格的空列（6.1 / 6.2 / 7.3 / 8.2 等全部中招）。
 * 改为可变参数后，二列 kv 表格的写法与结果完全不变。 */
const kv = (...cells) => cells;

/* -------------------------------------------------------------------------- */
/* 文档内容（2026-11-19 全量重写：以当前代码为唯一事实源）                      */
/* -------------------------------------------------------------------------- */

/* ---------------------------------------------------------------- 封面 */
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
          new Paragraph({ spacing: { before: 0, after: 120 }, children: [run('PLAYGROUND-MVP  ·  PROJECT HANDOVER', { size: 17, bold: true, color: '9FD6DE' })] }),
          new Paragraph({ spacing: { before: 0, after: 70 }, children: [run('项目信息', { size: 58, bold: true, color: C.white })] }),
          new Paragraph({ spacing: { before: 0, after: 180 }, children: [run('GTA 级微缩城市 · 工程交接与代码事实手册', { size: 24, color: 'D8EEF1' })] }),
          new Paragraph({
            spacing: { before: 0, after: 0 },
            border: { top: { style: BorderStyle.SINGLE, size: 10, color: C.amber, space: 2 } },
            children: [run('THREE.JS  +  RAPIER  +  VITE  +  BLENDER(离线)', { size: 16, bold: true, color: 'F3C68E' })],
          }),
        ],
      })],
    })],
  }),
  new Paragraph({ spacing: { before: 260, after: 100 }, children: [] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 60 }, children: [run('v2.2 · 新模型完整手册 · 2026-11-21', { size: 22, bold: true, color: C.amber })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 220 }, children: [run('从架构、坐标、设施、系统到验收与 Blender 管线：一份自包含的真相源', { size: 18, color: C.muted })] }),
  table(
    ['文档项', '内容'],
    [
      kv('文档版本', 'v2.2 / 完整交接手册（新增 10 章任务手册与附录 B–E）'),
      kv('数据口径', '2026-11-21 当前工作区代码（含线上联机、单人入口与未提交的 v3 同场并置改造）'),
      kv('代码状态', 'npm run build PASS；核心回归全绿；Blender 车模与别墅外壳已入库'),
      kv('技术栈', 'Three.js 0.187 / Rapier 0.21 / Vite 8.3 / Playwright 1.65 / Blender 3.6.23'),
      kv('权威源', 'docs/current-status.md（现状）> 本文件 > docs/project-map.md（11-15 历史快照）'),
      kv('文档定位', '任何模型或维护者只读这一份，即可准确定位代码、复现验收、安全改动'),
      kv('生成方式', 'scripts/generate-doc.js + docx 9.15.4；npm run docs:handover 可再生成'),
    ],
    [20, 80],
    { firstColBold: true, zebra: true, size: 18 },
  ),
  new Paragraph({ spacing: { before: 220, after: 0 }, children: [] }),
  callout('一句话定位', [
    '一个可步行、可驾车、可昼夜与四季切换的 Three.js 微缩城市：单 Scene / 单渲染器 / 常驻 Lobby，全部外观程序化生成，物理按需懒加载，性能红线由脚本守门；自有别墅与城市同场并置，Blender 只做离线建模、量化几何数据编译进 JS，零 GLB 进运行时。',
  ], 'info'),
];

/* ---------------------------------------------------------------- 00 摘要 */
const summary = [
  h1('00', '交付摘要与阅读指南', true),
  p('这不是需求文档，也不是功能宣传页，而是按当前代码逐文件核对后的工程事实手册。它回答五个问题：项目由什么组成、坐标在哪里、设施与全局系统怎么运转、性能与资源红线是什么、下一位模型绝对不能碰什么。'),

  h2('0.0', '三分钟速懂（第一次接手先看）'),
  p('一句话：这是一个 Three.js 单页 3D 微缩城市游乐场；大厅常驻，9 个游乐园设施 + 别墅嵌入视图 + 都会区驾驶/空中花园；联机是旁路层，线上用 Netlify Functions + Blobs 做双人房间，单人点「单人游玩（不联机）」。'),
  table(
    ['问题', '最短答案'],
    [
      kv('怎么跑', 'npm install → npm run dev → http://127.0.0.1:5173/；npm run build 出 dist'),
      kv('线上在哪', 'https://chengshi1.netlify.app；账号 player1/play1234、player2/play1234'),
      kv('玩家动线', '登录页 → 开始页 → 大厅（orbit/WASD）→ 靠近入口按 E / 点提示 → 设施；别墅门口按 E'),
      kv('架构核心', '单渲染器 + 常驻 Lobby + 单物理世界；CameraRig 唯一写相机；Rapier 仅驾驶/投掷按需加载'),
      kv('两套设施', '嵌入视图 6 项（含 villa）由 FacilityRuntime 接管相机；独立设施由 AttractionManager 替换 activeKey'),
      kv('绝对不能碰', '子模块直写 camera.position；新增常驻灯；热路径 new GPU 资源；改 9 个触发环数量断言；把 AI 车改动态刚体'),
      kv('出问题先看', 'docs/current-status.md → 09 章 → 08 章 → 浏览器控制台 / Netlify Functions 日志'),
    ],
    [20, 80],
    { firstColBold: true, zebra: true },
  ),
  table(
    ['阅读路线', '读什么', '能做什么'],
    [
      ['3 分钟', '0.0 + 0.2 + 08.1', '知道项目是什么、怎么跑、不能碰什么'],
      ['30 分钟', '01 + 02.2 + 03 + 09.0–9.6', '能改常见代码、跑验收、推送到 Netlify'],
      ['2 小时', '04 + 05 + 06 + 07 + 08 + 09.7–10', '能独立新增设施/联机字段并守住性能与部署红线'],
    ],
    [18, 42, 40],
    { firstColBold: true, zebra: true },
  ),
  callout('新模型的第一条纪律', [
    '先读 00.0 与 08.1；改任何东西前先 git status，不要把 秘密.txt、截图、临时脚本一起提交；任何相机/资源/性能改动先对照 06 的十条红线。',
  ], 'info'),

  h2('0.1', '怎么读这份文档'),
  table(
    ['读者目标', '直接跳到'],
    [
      kv('第一次接手，建立整体认知', '01 架构 → 02 坐标与入口 → 08 接手指南'),
      kv('要改某个设施或新增玩法', '01.5 生命周期两套体系 → 02.3 入口清单 → 08.5 新增姿势'),
      kv('要改别墅', '04 全章 → 05.5 Blender 外壳 → 07.4 已知漂移'),
      kv('要新增 / 修改 Blender 资产', '05 全章（尤其是 5.3 数据格式与 5.7 复现步骤）'),
      kv('要判断能否加内容 / 会不会破红线', '06 全章 → 07.3 验收基线'),
      kv('要跑验收 / 排查脚本失败', '07 全章'),
      kv('查一个术语或缩写', '附录 A.1 术语表'),
    ],
    [38, 62],
    { firstColBold: true, zebra: true },
  ),
  callout('权威源优先级（重要）', [
    '1) docs/current-status.md —— 当前唯一权威现状基准，含铁律、验收基线、Blender 管线与建筑精修预算表。',
    '2) 本文件《项目信息.docx》—— 自包含的结构化手册，由 scripts/generate-doc.js 生成，可随代码再生成。',
    '3) docs/project-map.md、docs/handover.md、docs/v3-*.md、docs/v4-*.md —— 各自时点的历史快照与规格，数字已过时，只作审计留痕，切勿据此回改现行代码。',
    '4) 代码本身 —— 任何文档与代码冲突时，以 src/ 与 tests/ 的实际内容为准。',
  ], 'warn'),

  h2('0.2', '交付结论（2026-11-21 实测）'),
  table(
    ['维度', '结论'],
    [
      kv('产品状态', '可运行、可演示、可交接；阶段 1–6 主体完成，建筑精修按队列逐个推进'),
      kv('运行形态', '单页 Web 3D 世界；无外部模型 / 贴图 / 音频依赖，全部程序化生成'),
      kv('生产构建', 'npm run build PASS；155 模块；vendor-physics 4.34MB 保持懒加载分块'),
      kv('性能状态', '都会区峰值 236,381 tris / 741 calls（< 300,000 硬红线）；redline 双机位 173,812 tris'),
      kv('资源纪律', '稳态 152 geometries / 51 textures；进出、热路径、四季切换均 Δgeo=0 / Δtex=0'),
      kv('别墅', '同场并置嵌入视图（大厅常驻）+ 都会区商场西侧 Blender 精修外壳（5,612 tris）'),
      kv('Blender 管线', '车模 3,444 tris + 别墅外壳 5,612 tris，均以量化顶点数据编译进 JS'),
      kv('GTA 互动（11-20）', '驾车撞人→倒地 18s→起身走开 + 通缉 ★；农田贴田按 E 收割→田里收空→农民重播慢长生；贴车 4.2m 按 E 认领正在跑的 AI 车（仅玩家车吃物理刚体，其余 AI 车仍是运动学盒）'),
      kv('帧率调速器（11-20）', 'scene-manager 每秒采样：<40fps 降像素倍率（*0.8，下限 0.62），>56fps 每窗口 +0.1 回升；composer / FXAA / 画布同步重设'),
      kv('线上联机（11-21）', 'Netlify Functions + Blobs 双人房间；两个链接自动登录；单人入口；同账号后开接管、退出 sendBeacon 释放；核心 10/10、双端 8/8、线上 8/8'),
      kv('交接风险', '坐标命名、draw call 口径分裂、v3 未提交改动、旧验收脚本漂移，共四项首要注意'),
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),

  h2('0.3', '文档导航'),
  table(
    ['章节', '回答的问题'],
    [
      kv('01 项目架构', '用了什么、怎么跑、代码如何分层、两套设施生命周期与相机仲裁'),
      kv('02 世界与坐标', '六个区域在哪、9+1 个入口怎么进、坐标有哪些坑'),
      kv('03 全局系统', '昼夜、四季、交通、驾驶、NPC、渲染 LOD，以及 11-20 的互动玩法与帧率调速器'),
      kv('04 别墅「我的家」', '四层结构、三段楼梯、电梯、电器、同场并置与外壳契约'),
      kv('05 Blender 离线建模', '为什么不用 GLB、数据格式、车模与别墅精修、后续预算与队列'),
      kv('06 性能与工程红线', '硬指标、当前实测、LOD、十条铁律、构建分包'),
      kv('07 验收体系', '有哪些脚本、当前基线数字、已知漂移与遗留'),
      kv('08 接手指南', '先读什么、绝对不能碰什么、如何安全改动与新增'),
      kv('09 联机与单人', '线上链接、账号、单人/组队、设备适配、同账号接管与退出释放'),
      kv('10 任务手册', '本地跑起来、改设施、改大厅、改联机、部署回滚、验收、文档维护'),
      kv('附录', 'A 术语/状态/生成/时间线；B 文件索引；C 接口与环境变量；D 已知风险；E 文档维护'),
    ],
    [26, 74],
    { firstColBold: true, zebra: true },
  ),
  callout('先记住这一条', [
    '这个项目的性能不是「优化出来的」，而是「设计出来的」：InstancedMesh、对象池、LOD、懒加载与资源台账共同构成底座。任何新增内容，先问「它是否新增 geometry / texture / draw call / 常驻灯」，再问「好不好看」。',
  ], 'info'),
];

/* ---------------------------------------------------------------- 01 架构 */
const architecture = [
  h1('01', '项目架构概述'),
  p('项目采用「单渲染器 + 多内容模块 + 单物理世界 + 常驻 Lobby」的微缩城市架构。Three.js 负责渲染与相机，Rapier 只负责需要真实碰撞的玩法（驾驶、投掷），Vite 负责开发与生产构建。大厅本身不是一个可卸载设施，而是常驻世界根节点；进入小游戏只激活一个设施或切换一个嵌入视图，世界不被销毁。'),

  h2('1.1', '技术栈与版本'),
  table(
    ['层', '技术 / 版本', '在本项目中的职责'],
    [
      ['渲染', 'three ^0.187.0', 'Scene / Camera / Renderer / EffectComposer / LOD / InstancedMesh / OrbitControls'],
      ['物理', '@dimforge/rapier3d-compat ^0.21.0', '唯一 world.step；玩家车、投掷物、临时 collider；动态 import 懒加载'],
      ['碰撞辅助', 'three-mesh-bvh ^0.9.9', '地面漫游的三角形级 BVH 推出'],
      ['碰撞辅助', 'three-player-controller ^0.6.3', 'CollisionWorld 候选粗筛'],
      ['调试 UI', 'lil-gui ^0.21.0', '毛玻璃调试控制台'],
      ['预留能力', '@mediapipe/tasks-vision 0.10.3', '手势识别纯逻辑模块，当前无任何模块 import（未接线）'],
      ['构建', 'vite ^8.3.6', 'dev server / 生产构建 / manualChunks 分包 / 缓存头'],
      ['语言', 'JavaScript ES Modules', '无 TypeScript；靠契约、测试与注释约束'],
      ['验收', 'playwright ^1.65.1 + Edge Headless', '验收脚本直接读 window.__playground 运行时状态'],
      ['文档生成', 'docx ^9.15.4', '仅 scripts/generate-doc.js 使用，不进运行时'],
      ['离线建模', 'Blender 3.6.23（D:/blender）', '离线建模 + Cycles 预览；产物是量化顶点数据 JS，不进运行时'],
    ],
    [16, 30, 54],
    { firstColBold: true, zebra: true, size: 17 },
  ),

  h2('1.2', '启动与渲染链路'),
  codeBlock([
    'index.html',
    '  └─ src/main.js                 唯一 JS 入口：装配世界骨架 / 管理器 / 设施 / UI',
    '     ├─ SceneManager             唯一 renderer / camera / composer / 渲染循环',
    '     ├─ AttractionManager        独立设施注册、激活、卸载、dispose 调度',
    '     ├─ FacilityRuntime          嵌入视图协调（懒创建 / 相机 blend / 挂起 OrbitControls）',
    '     ├─ PhysicsManager           Rapier 懒加载；全工程唯一 world.step',
    '     ├─ CameraRig               相机 owner 仲裁；设施 / 步行 / 驾驶互斥',
    '     ├─ SceneContext             worldRoot / propsRoot / facilityAnchors',
    '     └─ Lobby                   常驻世界根节点（PlaygroundScene）',
    '        ├─ Zoo / Castle / Farm / ForestPark',
    '        ├─ Districts            四宫格骨架 + 区域级 LOD',
    '        └─ Metropolis          北侧 CBD / 交通 / 人群 / 驾驶 / 别墅门面',
    '',
    '每帧顺序（简化）：',
    'physicsManager.step(dt) → attractionManager.update(dt) / facilityRuntime.update(dt)',
    '→ 全局单例 update(dt) → cameraRig.update(dt) → composer.render()',
  ]),
  p('关键点：Lobby 常驻不卸载；9 个设施触发环、6 个区域、都会区别墅门面都挂在它的根节点下。独立设施走 AttractionManager（会替换 activeKey），嵌入视图走 FacilityRuntime（activeKey 保持 lobby，只切相机与显隐）。'),

  h2('1.3', '目录与代码分层'),
  table(
    ['目录', '职责', '典型文件 / 数量'],
    [
      ['src/core', '场景、渲染、物理、注册、相机仲裁、资源清理', '11 个单例：scene-manager / attraction-manager / facility-runtime / camera-rig / physics-manager / scene-context / interaction-manager / ui-manager / audio-manager / render-optimizer / disposable-registry'],
      ['src/scenes', '大厅与五个区域的内容工厂', 'lobby-scene.js（5,941 行）/ zoo-scene / castle / farm / forest-park / districts'],
      ['src/scenes/attractions', '独立设施实现 + 别墅', 'i-attraction / dummy / pumpkin-thrower / parkour-run / memory-match / dance-hall / train-ride / carousel / pirate-ship / fireworks-deck / century-clock / villa（1,650 行）'],
      ['src/scenes/metropolis', 'CBD 街区、交通、信号灯、人群、驾驶、别墅门面', '17 个文件，含 2 个 Blender 生成数据模块'],
      ['src/components', '输入、UI、嵌入视图、开始页、暂停菜单', 'controllers / labels / embedded-views（6 文件）/ start-screen / pause-menu / debug-panel / hand-tracker'],
      ['src/utils', '昼夜、四季、粒子、NPC、程序化纹理与人物、加载器', 'helpers（day-night-cycle / season-cycle / particle-system / npc-manager / procedural-character / facility-textures 等）、controls/wasd-controller、loaders/model-loader'],
      ['src/objects · src/shaders', '规划中的空目录', '仅 readme.md 占位，当前无代码'],
      ['src/scenes/metropolis/city-*-blender-model.js', 'Blender 量化几何数据（生成物，勿手改）', 'city-car-blender-model.js（114KB）/ city-villa-blender-model.js（226KB）'],
      ['config', '运行配置单一真相源', 'default.json：端口 5173 / triangleBudget 300000 / drawCallBudget 900'],
      ['tools/blender', '离线建模脚本', 'build_city_car.py / build_city_villa.py / start_mcp_server.py'],
      ['models', 'Blender 预览图与早期 GLB 试点产物', 'blender-car-preview.png / blender-villa-preview.png / vehicle.glb（未接入）'],
      ['tests', 'Playwright 验收与诊断', '45 个顶层文件（28 个 verify-*）+ _archive/（53 个一次性探针，已 gitignore）'],
      ['docs', '现状、规格、报告、截图证据', 'current-status.md 为唯一权威；其余多为历史快照'],
      ['assets · public · _archive', '资产与归档', 'assets/models/visitor-ai.glb 为对照样本不进运行时；_archive 为待确认删除归档'],
    ],
    [24, 26, 50],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  p('命名规范：工程内文件一律小写 + 短横线；禁止中文文件名、空格、「最终版 / copy / 旧」类后缀。docs/screenshots/ 内历史证据文件名已统一。'),

  h2('1.4', '五个必须保留的架构决策'),
  bullet('零外部资产：所有外观由程序化几何 + Canvas/DataTexture 生成；不依赖 glb、贴图或音频文件。Blender 只做离线建模，产物是 JS 数据，不是运行时资源。'),
  bullet('单渲染器 / 单物理世界：不要新建 WebGLRenderer，不要另起 Rapier world。'),
  bullet('按需物理：Rapier 只在真正需要物理的设施或驾驶时动态 import；启动不预取。'),
  bullet('资源台账：几何、材质、纹理、InstancedMesh 必须成对 dispose；大厅有七步清理流程，都会区有 owned 台账。'),
  bullet('脚本守门：性能与功能验收都落成 tests/*.mjs，不靠肉眼判断「应该没问题」。'),
  callout('架构层面的「不要创新」', [
    '新增模块应复用 SceneManager / AttractionManager / FacilityRuntime / PhysicsManager / CameraRig 与资源台账；另起一套生命周期，通常会以相机双写、资源泄漏或物理世界冲突收场。',
  ], 'warn'),

  h2('1.5', '两套设施生命周期（最关键的架构分水岭）'),
  table(
    ['维度', '独立设施 IAttraction', '嵌入视图 IEmbeddedView'],
    [
      ['契约', 'init / update / onInteract / dispose 四方法', 'init / getCameraAnchor / update / activate / deactivate / dispose 六方法'],
      ['管理器', 'AttractionManager（register / activate / deactivate）', 'FacilityRuntime（register / activate / deactivate）'],
      ['世界', 'activate 时替换 activeKey；场景切换', 'Lobby 全程常驻，activeKey 保持 lobby'],
      ['相机', '设施自行管理或经 CameraRig 切换', '只由 CameraRig.blendTo 到 getCameraAnchor() 锚点，视图不写相机'],
      ['窗外视野', '各自独立的假场景 / 假远景', '真实大厅网格（城市、摩天轮、马路、车辆）'],
      ['当前注册数', 'attractionManager.register 11 项（不含 villa）', 'facilityRuntime.register 5 项'],
      ['典型成员', '跑酷 / 记忆翻牌 / 跳舞厅 / 小火车 / 烟花台 / 世纪钟', '摩天轮 / 旋转木马 / 海盗船（零 GPU 资源）/ 别墅（自建几何）/ demo-embed（验证桩）'],
    ],
    [18, 41, 41],
    { firstColBold: true, zebra: true, size: 17 },
  ),
  p('EMBEDDED_KEYS（6 项）：demo-embed、ferris-wheel、carousel、pirate-ship、pumpkin-thrower、villa。其中 pumpkin-thrower 是触发环别名（TRIGGER_KEY_ALIASES 把它归一化为 ferris-wheel）。PROJECT_NAMES 共 13 项。'),
  codeBlock([
    'onEnterAttraction(key) 分流（src/main.js）',
    '  resolved = TRIGGER_KEY_ALIASES[key] ?? key',
    '  if (EMBEDDED_KEYS.has(resolved))  → facilityRuntime.activate(resolved)',
    '      不 renderOnce、不卸 Lobby、syncGlobalContext 统一映射为 lobby',
    '  else                              → PHYSICS_KEYS 先 await physicsManager.init()',
    '                                    → attractionManager.activate(resolved) → renderOnce()',
  ]),
  callout('IEmbeddedView 六条硬禁令', [
    '禁 new Scene；禁改 background / fog；禁 dispose Lobby 共享资源；禁隐藏 Lobby 根节点；只 track() 独占资源；热路径禁 new GPU 资源。视图实例被 FacilityRuntime 缓存复用，重复进出不重新上传，这是 Δ0/0 的前提。',
  ], 'danger'),

  h2('1.6', '相机 owner 仲裁与互斥'),
  bullet('CameraRig 是唯一相机写者：一次性机位切换走 blendTo / restore（0.8s smoothstep），逐帧跟随走 writePose（受控直写、零分配）；直写者必须先 allowDirectWrite(key) 登记。'),
  bullet('FacilityRuntime.activate 顺序：挂起 Lobby OrbitControls（把 update 临时替换为空操作，只置 enabled=false 挡不住它逐帧写相机）→ setOwner(key) → save(lobby) → view.getCameraAnchor() → blendTo(0.8s) → view.activate()。'),
  bullet('deactivate 必须先 restore 再 release，否则 owner=null 会被 _canWrite() 拒绝；update 里仅在过渡结束后恢复 OrbitControls。'),
  bullet('任何新增「接管相机」的系统必须在 movementMode.getContext() 暴露占位标志（如 driving），让漫游层经 isEngaged() 自动让位；历史上驾驶与漫游互斥、按 E 无法上车就是这个缺口。'),
];

/* ---------------------------------------------------------------- 02 坐标 */
const regions = [
  h1('02', '世界、区域与入口'),
  p('所有区域共享同一套世界坐标：x / z 为水平面，y 向上。四宫格外框 x∈[-30,90]、z∈[-30,90]，都会区继续向 +z 延伸到 245。改坐标前先读 src/scenes/districts.js 与 src/scenes/metropolis/city-layout.js，不要凭记忆手写。'),

  h2('2.1', '区域总表'),
  table(
    ['区域', '世界坐标 / 范围', '规模与内容', '进入方式'],
    [
      ['中央游乐场', '原点 (0,0)；南门 z=15', '9 个触发环 + 世纪钟、摩天轮、旋转木马、海盗船、跑酷、小火车、魔法牌屋、跳舞厅、烟花台', '开始页 → 大厅；点击入口光圈 / 箭头，或 WASD 走近后按 E；M 切第一人称'],
      ['动物园', '四区 x∈[32,88]、z∈[-26,26]；非洲草原 z∈[-55,-29]', '家禽 / 爬行 / 海洋 / 哺乳 / 非洲草原五区；动物与部件全部 InstancedMesh', '右上角「去动物园」相机飞越；或沿 +x 步行；返回按钮回中央广场'],
      ['城堡园', '四宫格左上格，中心 (-7,60)；导视牌 (0,31.6)', '46×46 台地、8 座塔楼 22–35m、148 扇拱窗；6,272 tris / 16 calls', '从 z=27 北侧横路向 +z 步行或 Orbit 俯瞰；不是独立副本'],
      ['农家宝', '四宫格右上格，中心 (60,60)；导视牌 (60,31.6)', '水稻 / 玉米 / 小麦 / 菜圃，7 类作物 968 个实例；25,052 tris / 14 calls', '沿北侧横路到 x=60 再向 +z；无独立副本'],
      ['都会区 / CBD', '中心 (0,170)；x∈[-95,95]、z∈[94,245]；主干道 x=24', '6 座建筑（医院 / 学校 / 商场 + 大裤衩 / 尖塔 / 退台塔 3 地标）、9 个信号路口、三级 LOD、17 个 city-* 模块', '沿 x=24 主干道从 z=90 向 +z 步行或开车；无传送门'],
      ['森林公园', 'x∈[-104,-38]、z∈[44,92]；中心 (-71,68)', '林地、步道、水塘、拱桥、市民与狗；四季植被重点展示区', '从广场向西步行；入口牌 x≈-38、z≈59'],
      ['都会区别墅', '(-30,134)，商场 (0,134) 西侧空地；南门 (-30,125.7)', '现代简约三层别墅 + 地下车库；Blender 精修外壳 5,612 tris；同址室内四层', '走到南门发光圈按 E，或点击提示条 / 门板'],
      ['停车场 / 上车点', '(-30,98) 两辆停放车；公交站 (32.4,38)', '驾驶系统起始车辆；公交下客点', '靠近 4.2m 内出现「按 E 上车」；E 上 / 下车，驾驶中 C 切视角'],
    ],
    [15, 24, 36, 25],
    { firstColBold: true, zebra: true, size: 15 },
  ),

  h2('2.2', '设施入口清单（9 个触发环 + 1 个门口）'),
  p('lobby-scene.js 的 FACILITY_SPECS / FACILITIES / _triggerRings 均为 9 项。别墅刻意不占第 10 个触发环（曾试过并撤销，5 个脚本的数量断言已恢复 9），它是都会区实体门面 + 独立判定逻辑。'),
  table(
    ['#', 'key', '名称 / 门牌', '本体 (x,z)', '触发圈 (x,z)', '进入方式'],
    [
      ['0', 'pumpkin-thrower', '南瓜摩天轮', '(-20,-16)', '(-20,-8.4)', '触发环 → 别名 ferris-wheel → 嵌入视图'],
      ['1', 'parkour-run', '极限跑酷 / 跑酷跑道', '(13,-16)', '(13,-8)', '触发环 → 独立设施'],
      ['2', 'memory-match', '记忆翻牌 / 魔法牌屋', '(0,-20)', '(0,-13)', '触发环 → 独立设施'],
      ['3', 'dance-hall', '跳舞厅', '(-23,8.5)', '(-23,15.75)', '触发环 → 独立设施'],
      ['4', 'train-ride', '高空环游 / 小火车站台', '(-26,-2)', '(-26,6)', '触发环 → 独立设施'],
      ['5', 'carousel', '旋转木马', '(9,7.5)', '(9,-0.2)', '触发环 → 嵌入视图'],
      ['6', 'pirate-ship', '海盗船', '(-7,5)', '(-7,-0.8)', '触发环 → 嵌入视图'],
      ['7', 'fireworks-deck', '烟花观礼台', '(13.8,15.5)', '(13.8,10.28)', '触发环 → 独立设施'],
      ['8', 'century-clock', '世纪钟', '(0,-4)', '(0,2)', '触发环 → 独立设施'],
      ['+', 'villa', '我的别墅（都会区商场西侧）', '(-30,134)', '门 (-30,125.7)', '门口按 E / 提示条点击 / 门板拾取 → 嵌入视图'],
    ],
    [5, 17, 24, 14, 15, 25],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  p('触发圈坐标由 triggerOf(f) 派生：d = (f.facadeFront ?? f.doorDepth) + TRIGGER_FRONT_GAP(3.0)，沿 doorDir 偏移。_assertTriggerSpacing() 自检 9 点两两间距 ≥6.5m 且圈-门面 gap 落在 3.0±0.5m。'),
  p('三条进入路径：① 点击触发环 / 箭头（_pickables → _tryEnter）；② WASD 第一人称走近按 E（INTERACT_RADIUS=4.6）；③ 别墅门口 _tryEnterVilla()，判据统一由 _villaDoorState() 给出（建筑 AABB 距离 ≤6.0m，16m 内超距给 toast，飞行模式拒绝）。'),

  h2('2.3', '坐标命名的坑'),
  bullet('「南门」是建筑名，不是 +z 方向。代码口径中 +z 指向四宫格北侧与都会区；不要据「南门」推断坐标正负，也不要据「北侧都会区」反推相机朝向。'),
  bullet('单一真相源：DISTRICT_GRID / CITY / CITY_INTERSECTIONS / ZOO_LAYOUT / FOREST_PARK / BUS_STOP。手写坐标前先 grep 这些常量。'),
  bullet('道路红线：主干道 x=24、净宽 16m（13m 车行道 + 两侧 1.5m 人行道）；建筑体量离道路红线至少 2m；城市扩展先跑 isOnRoad() 扫描。'),
  bullet('四宫格 outer x∈[-30,90]、z∈[-30,90]；北侧两区通过 z=27 横路连接。城堡 / 农场几何是世界坐标烘焙进顶点的，移动区域要同步 _rebase，不能只改 group.position。'),
  bullet('别墅 root 绕 Y 转 180°：世界 x = -30 - 本地 x、世界 z = 134 - 本地 z。写测试、摆机位、算碰撞都要先过一次换算，凭直觉会整体反向。'),

  h2('2.4', '推荐路线与常用键位'),
  table(
    ['操作', '键位 / 路径'],
    [
      kv('开车', 'CBD 停车场 (-30,98) → 靠近车辆 → E 上车 → W/S/A/D（C 切视角，E 下车）'),
      kv('漫游模式', 'F 进入 / 退出地面漫游；飞行模式高空不触发上车；R 卡住时回大厅出生点'),
      kv('第一人称', 'M 切换；WASD 移动、Shift 加速；靠近设施按 E'),
      kv('进别墅', '都会区商场西侧走到发光圈 → E；或点提示条 / 门板；别墅内右侧电梯按钮切层'),
      kv('时间 / 季节', 'Lobby 右下时间台切昼夜；四季 UI 按钮切春 / 夏 / 秋 / 冬'),
      kv('退出 / 暂停', 'ESC 或返回按钮；暂停菜单联动 sceneManager.setPaused'),
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),
];

/* ---------------------------------------------------------------- 03 系统 */
const systems = [
  h1('03', '全局系统实现'),
  p('全局系统共享一条原则：热路径只改标量、矩阵、uniform 或 DOM 文本，不在 update 里创建 GPU 资源。状态机全部是手写字段 + dt 累计，没有通用 FSM 框架。'),

  h2('3.1', '昼夜循环'),
  p('入口 src/utils/helpers/day-night-cycle.js；由 Lobby 右下时间台和自动循环驱动。太阳 / 月亮 / 星空 / 天空球 / 雾 / 环境光 / 霓虹 emissive / Bloom 强度都在同一状态机里过渡。'),
  table(
    ['模式', '视觉基调', '关键参数（标定后）'],
    [
      ['day', '日光、清晰远景、轻 Bloom', '主光 0.58；环境 0.07；曝光 1.0；Bloom 0.06 / 阈值 1.4'],
      ['sunset', '橙色天空、长阴影、霓虹初亮', '主光 ≈0.31；曝光 0.94；Bloom 0.22 / 阈值 0.95；霓虹 ×1.7'],
      ['night', '深蓝夜空、月亮 / 星空、霓虹与窗光', '主光 ≈0.04；曝光 0.86；Bloom 0.55 / 阈值 0.55；霓虹 ×3.6'],
    ],
    [14, 32, 54],
    { firstColBold: true, zebra: true },
  ),
  bullet('自动循环默认关闭；开启后 480s 一轮（可设 300–600s），在 day → sunset → night 之间插值。'),
  bullet('四季联动：season-cycle 通过 setSeasonLightScale() 调整主光，不另起一套灯光。'),
  bullet('设施上下文：嵌入设施通过 registerEmbeddedContext() 注册（当前 5 个 key），不复制昼夜逻辑。'),

  h2('3.2', '四季天气与粒子池'),
  p('入口 src/utils/helpers/season-cycle.js + particle-system.js。植被按 ground / broad / conifer / shrub / grass 五个角色分别持有 uniform，切换时只 lerp 颜色；不要把 broad 与 conifer 合并。'),
  table(
    ['季节', '植被基调', '天气', '发射量 / 节奏'],
    [
      ['spring', '嫩绿地面、亮绿阔叶、深绿针叶', '花瓣 petal', '每次 16 枚，间隔 0.26s'],
      ['summer', '深绿、浓密、太阳最强', '阵雨 rain + 地面波纹', '每次 36 滴，间隔 0.13s；间歇阵雨'],
      ['autumn', '黄褐地面、橙红阔叶、针叶保持深绿', '落叶 leaf', '每次 16 片，间隔 0.24s'],
      ['winter', '雪白地面、冷色树冠', '雪花 snow', '每次 24 片，间隔 0.18s'],
    ],
    [12, 38, 22, 28],
    { firstColBold: true, zebra: true },
  ),
  bullet('天气复用烟花系统的 3000 粒子池与同一套 Points 几何；weather 只是第二个绘制批次，不新建几何 / 纹理。'),
  bullet('峰值上限 760 个粒子；clearWeather() 后槽位全部归还（freeTop=3000）；粒子按类型隔离回收，天气（kind≥4）与烟花（kind=0）互不误杀。'),
  bullet('8 次四季切换实测 Δgeo=0 / Δtex=0。'),

  h2('3.3', '交通、信号灯与街景'),
  p('入口：city-layout.js（坐标单一真相源）+ city-traffic.js + city-signals.js + city-street.js + city-details.js + city-crowd.js。'),
  table(
    ['对象', '数量 / 实现', '性能策略'],
    [
      ['行驶车', '10 辆；车身用 Blender 车模几何、车顶 / 车轮各一个 InstancedMesh', '路线预采样 256 点 + 标量里程，运行时零曲线求值'],
      ['停放车', '2 辆，(-30,98) 一带', '同一 InstancedMesh 的实例；可被玩家认领'],
      ['公交', '1 辆，沿公交路线循环', '到站触发 CityCrowd.activateAlighters()，3 名行人下车'],
      ['信号灯', '9 个十字路口 × 4 方向 = 36 个 3D 灯头 + 真实倒计时', '灯杆 / 灯头 / 三色灯珠各 1 个 InstancedMesh；36 块倒计时牌共享一张 1024² 图集，只改 canvas 像素不新增 texture'],
      ['路灯 / 光斑', '街景设施，全部 InstancedMesh', '夜间切换透明度，不新增 PointLight'],
      ['街区行人', '18 名沿 5 条人行道环线 + 2 名医院访客 + 每趟公交 3 名下客', '只走人行道、等绿灯、禁止斜穿、最小间距防穿透'],
    ],
    [16, 44, 40],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  bullet('信号：车辆按前方最近路口和轴向读灯色；红 / 黄灯在停车线前停，绿灯恢复目标速度。'),
  bullet('夜间：头灯 / 尾灯 / 地面光斑由 setNight() 统一调透明度；不新增 PointLight。'),
  bullet('城市背向剔除：camera.position.z < 92 且 dir.z < -0.15 时整组隐藏（公园朝南视角零城市 draw），但红绿灯 / 公交 / 行人模拟与「是否背向」解耦。'),

  h2('3.4', 'GTA 驾驶'),
  p('入口 src/scenes/metropolis/city-driving.js；Lobby 负责 E / F 键仲裁与 HUD。'),
  table(
    ['项目', '实现值 / 行为'],
    [
      kv('上车条件', 'WASD 或地面漫游模式、距最近 AI 车 ≤4.2m；HUD 显示「按 E 上车」；飞行高空不触发'),
      kv('玩家车', 'Rapier dynamic body；6 个视觉部件复用 CityTraffic 的 body / cabin / wheel 几何'),
      kv('质量 / 碰撞', '≈321.5 kg；一个 cuboid collider；X/Z 旋转锁死，只保留 Y 轴转向'),
      kv('动力', 'W/S 前进 9.5 m/s²；制动 -13.5；倒车 -5.2；前进上限 17.5 m/s（≈63 km/h）'),
      kv('转向', 'A/D 目标角速度 1.45 rad/s；低速转向弱，倒车自动反向'),
      kv('横向抓地', 'exp(-8.5·dt) 衰减；地面摩擦 0.05'),
      kv('AI 车辆', '最多 12 个 kinematic 包围盒（10 行驶 + 2 停放 + 1 公交，扣除当前认领车）；不升级为动态刚体'),
      kv('物理体数量', '驾驶中 14 个（1 静态 + 1 玩家 + 12 AI）；下车后 0 个'),
      kv('下车', 'E 退出；车身左侧 2.1m 找落点；相机交还 WASD / 地面漫游，漫游层自动恢复'),
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),
  callout('驾驶系统的性能边界', [
    '玩家车保留完整物理；AI 车只做简化运动学包围盒。不要为了「更真实」把 12 辆 AI 车全部改成动态刚体——那会同时击穿物理 CPU 预算与稳定性。玩家车视觉不新建几何，材质只在首次上车创建一次。',
  ], 'warn'),

  h2('3.5', 'NPC 与人群'),
  table(
    ['维度', '大厅 NPC（npc-manager.js）', '都会区行人（city-crowd.js）'],
    [
      ['数量', '10 个（4 入口迎宾 + 6 巡游）', '18 街区 + 2 访客 + 每趟 3 下客'],
      ['渲染', '1 个 InstancedMesh = 1 draw call', '身体 / 头 / 腿各一个 InstancedMesh'],
      ['状态', 'WALK / IDLE / LOOK / WAVE 四态', '沿路径行走 / 到站下客 / 访客路径'],
      ['寻路', 'BFS 导航图，2.4m 网格八邻域；AABB 避障 + 整段线段采样防斜穿墙', '预采样路径 + 碰撞回退'],
      ['动画', '顶点着色器驱动走路 / 摆臂 / 挥手 / 张望；CPU 只写 aAnim', '实例矩阵 + 简单摆动'],
      ['边界', 'NAV_RADIUS=31，可 setBounds 扩展', '固定人行道环线'],
    ],
    [14, 43, 43],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  bullet('NPC 边界与玩家边界不同：大厅 NPC 默认 31，玩家 WASD / 漫游边界 110；不要误用。'),
  bullet('程序化人物：procedural-character.js 的 buildNPCCharacter 合并几何 + 实例调色板，单 draw call；玩家角色用关节 pivot。'),

  h2('3.6', '渲染、LOD 与后处理'),
  table(
    ['层次', '策略', '关键参数 / 文件'],
    [
      ['后处理', 'RenderPass → UnrealBloomPass → FXAA → OutputPass', 'scene-manager.js；ACES Filmic；移动端关 Bloom、降阴影 / 折射'],
      ['灯光', '常驻基座 3 盏（Ambient 0.07 + Hemisphere 0.3 + Directional 0.58）', '单一方向光投影，2048² 按画质降档；不新增投影灯'],
      ['都会区建筑', '三级 LOD near / mid / far', 'city-buildings.js；近景合并 ≈1,474 tris，中 / 远各 252 tris'],
      ['四宫格北区', '区域级 THREE.LOD：detail / silhouette', 'districts.js；lodDistance=100m'],
      ['设施', 'DetailLOD 包装', '90m / 115m 阈值'],
      ['重复物件', 'InstancedMesh', '树、作物、车辆、动物、行人、路灯、金币、灯泡、窗'],
    ],
    [16, 38, 46],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  bullet('LOD 必须保持 autoUpdate，让 renderer 在投影阶段自动切换；不要重新「钉死高模」。'),
  bullet('新区内容保持 frustumCulled=true；不要为了「永不消失」强制常驻。'),
  callout('构建分包（vite.config.js）', [
    'manualChunks 顺序不可调换：vendor-physics（rapier，wasm base64 内联）→ vendor-move（three-mesh-bvh + three-player-controller，路径含 three 必须在 vendor-three 之前匹配）→ vendor-gui（lil-gui）→ vendor-three。业务改动不打爆三方库强缓存；/assets/* 一年 immutable，入口 html no-cache。',
  ], 'info'),

  h2('3.7', '程序化资产与纹理'),
  bullet('city-textures.js：玻璃幕墙 / 夜间亮窗 / 玻璃 normalMap 与 roughnessMap / 学校跑道球场 / 停车位铺装 / 近白沥青骨料，全部 CanvasTexture 并登记释放。'),
  bullet('procedural-textures.js：噪声粗糙度图、拱窗窗光图、作物叶片图集（512² 三格 + 纯白格）。'),
  bullet('facility-textures.js：设施名牌 2048² 单图集 + UV 子矩形，WeakSet 幂等防 BufferGeometry.copy 浅引用坑。'),
  bullet('forest-park.js：草地法线 / 粗糙度、树冠顶点扰动、河流菲涅尔；city-lake.js 水面法线滚动。'),
  bullet('所有纹理统一 SRGBColorSpace、进台账、共享只登记不重复创建。'),

  h2('3.8', '互动玩法与帧率自调节（2026-11-20 新增）'),
  p('这一节的四项能力都只做「已有系统的状态扩展」，没有新增常驻灯、没有新增每帧几何，因此不吃 6 章的三条预算。改动前先看清它们各自挂在哪个既有 update 上。'),
  table(
    ['系统', '玩家可见行为', '实现位置与关键数值'],
    [
      kv('撞人通缉', '开车撞到行人 → 对方倒地不动 18 秒 → 自己起身走开；HUD 弹「撞倒行人 ×N · 通缉 ★」', 'city-crowd.js checkVehicleHit：要求 pose.speed > 2.5m/s、车身 1.3m 内命中；p.down.t > 18 后恢复原路线。lobby-scene.js _onPedHit：hitCount 累计，每 2 起 +1★，封顶 5★，toast 限频 1.5s'),
      kv('农田收割', '走到四宫格田边按 E → 这一垄作物收空；农民重新播种，苗慢慢长回来', 'lobby-scene.js _tryFarmHarvest → districts.harvestFarm(x, z)：只认 WASD 贴地模式；水稻 / 玉米 / 小麦 / 蔬菜四类；未成熟时返回 regrowing 并提示「再等一会儿」'),
      kv('认领 AI 车', '站在任意一辆正在开的 AI 车旁边按 E → 直接接管驾驶，不必等它停', 'city-traffic.js findNearestCar(point, 4.2)：步行 / 地面漫游用相机点、轨道模式用视线落点（半径放宽到 6.0m）；认领后 _claimed=true，车流不再提供第二辆'),
      kv('帧率调速器', '低端机 / 大分辨率屏幕上不再整段掉帧，画面轻微变软换流畅', 'scene-manager.js _tickGovernor：1 秒窗口算 fps；<40 时倍率 *0.8，下限 0.62；>56 时每窗口 +0.1 回到 1；变化超过 0.005 才 _applyPixelScale 重设 renderer / composer / FXAA / 画布'),
    ],
    [16, 34, 50],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  callout('四条不要踩的线', [
    '1) 撞人判定只在 traffic.playerPose 存在（也就是正在驾驶）时跑，别挪进无条件每帧循环里全量遍历行人。',
    '2) 已倒地的行人不参与 checkVehicleHit，18 秒内重复命中会连击 hitCount，通缉星直接爆表。',
    '3) 调速器只动像素倍率，不动画质档位 / Bloom / 阴影贴图——重建 RenderTarget 比降分辨率更贵，反而更卡。',
    '4) 收割是「按一次收一垄」，不要改成持续按住批量收；作物的重生依赖农民路径计时，批量收会让农民瞬间排队。',
  ], 'warn'),

  h2('3.9', '空中花园：太空电梯 + 太空高铁 + 146m 轨道环（2026-11-20 新增，同日第二版）'),
  p('新增模块 src/scenes/sky/sky-garden.js（一个类 + 一份状态机，不新建场景、不换机位），由 lobby-scene.js 常驻持有。它和「驾驶」同类：大厅一直活着，只在乘梯 / 乘车 / 甲板漫步期间逐帧 cameraRig.writePose 借用相机，退出时把机位、雾、天穹、云与输入全部还原。第二版的全部改动都来自用户对第一版的验收反馈：视角要能自由转、上去要能走、环上要有东西逛、建模要像样。'),
  table(
    ['对象', '位置 / 尺寸', '玩家可见行为'],
    [
      kv('轨道环', '中心 (0,54)、半径 88m、梁径 1.15m、离地 146m；梁上铺 3 排 ×140 块踏步板成 7.6m 宽甲板，内外双护栏 + 扶手灯带', '从地面抬头就能看到一圈悬空的梁；到站直接落在甲板上，可以沿着环走一圈'),
      kv('太空电梯', '基座 (-88.4, 21.9)，刻意落在环体【外侧 6m】（半径 94）；双导轨 146m、每 12m 一圈横肋、顶端站台 + 6m 栈桥接上环', '走到基座 9m 内按 E 进舱；12.5s 垂直升顶，全程可拖鼠标左右环视、抬低头看公园与全城；后半程机位压到甲板上'),
      kv('太空高铁', '地面站台 (-64,-2)：30×12 站台板 + 6 根立柱 + 顶棚；CatmullRom 爬升曲线弧长 228.4m，190 段管体 + 120 根枕木；环上停靠点方位角 40° → (56.57, 121.41)', '站台 15m 内 E 登车；发车后 4 节车厢穿云爬升，约 20s 到站，到站镜头抬到 14m 外俯看列车与延伸的轨道，E 出舱漫步'),
      kv('环上街区', 'Sky/district：云顶观景亭 250°、玻璃温室 140°、喷泉广场 40°（含 9m 方尖碑与悬浮光环）、空中墅 205°/320°、外悬观景台 300°、26 灯柱 + 20 行道树 + 14 长凳 + 4 座 26m 云灯塔桅杆', '沿着甲板走过去就是一排可看可绕的装置；9 个圆形碰撞圈 + 步道半径夹紧，走不进建筑也掉不下环'),
    ],
    [14, 46, 40],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  p('甲板自由漫步（第二版新增的 deck 模式）：到站后按 E 出舱，WASD / 方向键沿步道走（4.4 m/s，Shift 疾行 8.0 m/s）、拖鼠标左右环视与抬低头、滚轮缩放（FOV 68° 起）；眼高 1.72m、速度按 dt 归一，低帧率下也不会走飞。鼠标视角在乘梯、乘车、到站、行走四种状态里都生效 —— 实现上是把 _look.yaw/pitch 以相机局部轴右乘到基础机位上（FPS 手感），不用每帧改 target，也不会因为目标点变远而放大转角。E 的语义是：到站首次 E 出舱漫步，走完回来再 E 才是下行 / 返程，甲板上也可以直接用 HUD「直接落地」。'),
  callout('这套东西的四个集成坑（改之前先读）', [
    '1) 电梯不能压在环上：舱厢到 146m 时环梁会顶在镜头前，整屏只剩一根灰管子；必须外挂 6m 并配栈桥。',
    '2) OrbitControls 的 maxDistance=50、极角 ≤81.8°：永远凑不到基座 9m 内、也抬不起头看天上；所以 sky-garden 的靠近判定同时接受「相机点」和「视线落点」（轨道模式取 controls.target）。',
    '3) 后台分帧预热会 activate/deactivate 设施、把 Lobby 整个 dispose：main.js startBackgroundPrewarm 的让路条件必须包含 _skyGarden.isRiding，否则乘梯途中会被强行踢回地面。验收脚本统一加 ?no-prewarm=1 排掉这段噪声。',
    '4) 高空观感是三个独立问题，别只改雾：① 地面灰雾被抬到 146m 后 40m 外糊成白墙（near 推到 240 也无效），只能在 110m 以上整段关掉 scene.fog；② three/addons Sky.js 是纯方向散射，在高空把整个半球过曝成奶白，要收起天穹盒；③ 大厅的云是三条独立网格 Lobby/cloud-band-72/96/118，只藏 Lobby/clouds 那个 Group 没用，必须按名字把它们全关掉。材质仍保持 fog:false。',
  ], 'warn'),
];

/* ---------------------------------------------------------------- 04 别墅 */
const villa = [
  h1('04', '别墅「我的家」：同场并置'),
  p('这是项目里最复杂的单个内容模块，也是唯一「自建完整室内 + 城市同址外壳」双份几何并存的地方。理解它需要先理解 01.5 的嵌入视图体系。'),

  h2('4.1', '为什么改成嵌入视图'),
  table(
    ['维度', '旧独立设施（v2 及以前）', '当前 v3 同场并置'],
    [
      ['注册', 'attractionManager.register(villa, () => new Villa())', 'facilityRuntime.register(villa, () => new VillaEmbedView(baseCtx))；AttractionManager 侧已删除'],
      ['场景', 'activate 会 deactivate / dispose 整个 Lobby', 'Lobby 全程常驻，activeKey 保持 lobby，只由 CameraRig.blendTo 换机位'],
      ['世界', '别墅自建假草地、假摩天轮、假园区剪影', 'root 落在 CITY_VILLA(-30,134) 真实地皮，绕 Y 180°、基座 1.2m；窗外即真实都会区'],
      ['相机', 'Villa 自己抢相机、自己存档', 'VillaEmbedView.getCameraAnchor() 交给 FacilityRuntime；视图不写相机'],
      ['外壳', '无城市外壳', '进场隐藏同址 City/villa 实心壳，退场恢复；否则等于站在盒子内壁里'],
      ['HUD', '别墅 HUD 与大厅 HUD 叠字', 'activate 收起 .lb-ui / .pg-ui，deactivate 原样恢复'],
    ],
    [14, 40, 46],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  p('src/components/embedded-views/villa-embed-view.js（78 行，v3 未跟踪新增文件）是一个纯适配层：把仍继承 IAttraction 的 Villa 包装成 IEmbeddedView，六个方法全部委托给 villa，并在 init 时把 baseCtx 的 onExitAttraction 合并进 ctx（FacilityRuntime 注入的 ctx 只有 scene / camera / renderer / sceneContext）。它本身不建任何几何。'),

  h2('4.2', '坐标与常量（src/scenes/attractions/villa.js）'),
  table(
    ['常量', '值', '说明与坑'],
    [
      kv('CITY_VILLA', 'x=-30, z=134, w=20, d=16, h=9；门 (-30,125.7)', '城市侧地址权威（city-villa.js）；别墅与外壳同尺寸、同门位'),
      kv('VILLA_ORIGIN', 'x=-30, y=1.2, z=134, yaw=π', '外壳基座 1.16，抬 0.04 避免与地面共面；root 转 180°'),
      kv('HOUSE', 'W=20, D=16, H=3.6, WALL=0.3, SLAB=0.18', '单层 3.6m'),
      kv('LEVELS', '[-3.6, 0, 3.6, 7.2]', 'B1 / 1F / 2F / 3F 四层楼板标高'),
      kv('STAIR_X', 'x∈[-9.55,-6.85]', '三段楼梯共用西侧竖井'),
      kv('STAIRS', 'z∈[-7,-3] / [-2,2] / [3,7]', '三段跑道，各留 1.0m 平台；出发层全段栏板，到达层留 1.1m 平台口'),
      kv('SHAFT', 'x∈[6.4,9], z∈[-6.8,-4.2]', '东侧电梯井，四层贯通'),
      kv('BALCONY', 'x∈[-3.6,3.6], z∈[8,10.8]', '2F / 3F 南向阳台'),
      kv('SPAWN', '本地 (0,0,6.2), yaw=0', '1F 玄关；世界锚点 ≈(-30, 2.8, 127.8)'),
      kv('STEP_TOLERANCE', '1.7', '上一帧脚高与当前面高差超过 1.7m 视为翻层，不接力'),
    ],
    [18, 34, 48],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  callout('本地 → 世界坐标的符号翻转', [
    'root 转了 180°：世界 x = -30 - 本地 x，世界 z = 134 - 本地 z。localToWorld() / worldToLocalXZ() / _worldGroundAt() / _worldBoxes() 负责换算。写测试、摆机位、算碰撞都要先过一次换算；历史上「2F / 3F 出口全堵」的误判就来自凭直觉读坐标。',
  ], 'warn'),

  h2('4.3', '四层功能分区与家具'),
  table(
    ['楼层', '定位', '主要内容'],
    [
      ['B1 (-3.6)', '车库 + 家政', '轿车 + SUV 静态车、工具墙、储物架、车位线、洗衣房；扫地机器人基站'],
      ['1F (0)', '玄关 + 客厅 + 餐厨', '鞋柜 / 穿衣镜 / 挂衣杆、沙发 + 电视墙 + 地毯茶几、开放厨房（一字台 + 中岛 + 冰箱）、餐桌四椅、客卫、吸顶灯'],
      ['2F (3.6)', '起居 + 健身 + 娱乐 + 浴室 + 阳台', '起居沙发与电视、跑步机 / 哑铃架 / 瑜伽垫、台球桌 / 街机 / 飞镖靶、干湿分离浴室、南向阳台'],
      ['3F (7.2)', '主卧 + 主卫 + 衣帽间 + 书房 + 阳台', '双人床与床头柜、浴缸 / 淋浴 / 台盆、三扇衣柜 + 抽屉柜 + 试衣镜、书房角、南向露台'],
    ],
    [13, 24, 63],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  bullet('零件口径：_buildFurniture() 有 44 个 _f() 调用点，按 for 循环展开当前运行时 _furnitureCount ≈ 79 件；docs/current-status.md 与旧脚本仍写「83 件家具」（v2 遗留口径），verify-villa.mjs 的实际断言是 ≥60，两者都通过。'),
  bullet('静态几何按材质桶用 mergeGeometries 合并成少数 Mesh（合并前统一补白色 color attribute，否则 mergeGeometries 返回 null）；动态物体（电梯轿厢 / 机器人 / 电视屏 / 灯光）单独建。'),
  bullet('每层一盏 PointLight(0xffd9a8, 2.4, 19)，castShadow=false，共 4 盏；玻璃 depthWrite=false 避免透明排序与共面 z-fighting。'),

  h2('4.4', '垂直交通：楼梯、电梯与支撑面求解'),
  bullet('三段楼梯在 z 上互不重叠，按 _level 过滤栏板碰撞；楼板在楼梯到达处真实开洞（旧版整块楼板导致穿模 + 上下层互相挡）。'),
  bullet('脚高由 _groundAt(x,z) 支撑面求解，不是由 _level 决定：电梯井 → _elevatorY；阳台 → 取离脚最近的层（差 ≤0.75）；楼梯跑道 → 按 z 线性插值（|h - _footY| ≤1.7 才采用）；屋内 → LEVELS[_level]；屋外 → 0。'),
  bullet('_syncLevel() 由 camera.position.y - 1.6 - _baseY 反推楼层，仅差值 <1.0 才更新；电梯到站后 1.2s 保护期、井内跳过，避免把楼层拉回。'),
  bullet('电梯：_callElevator(target 0..3) 由 DOM 按钮触发，_updateElevator(dt) 用 damp(λ=2.2) 升降；井内玩家 _groundAt 返回轿厢地板高度，实测到 3F 轿厢 7.2m / 玩家眼高 8.8m；升降期间 WASD isEnabled=false。'),
  bullet('平台口净宽 ≥1.1m（玩家碰撞直径 1.0m）；出口沿走廊至少留 3m 才允许落家具。改家具、隔断前先量这个数。'),
  bullet('视觉与碰撞必须同源：栏板、门洞、隔断的长度用同一常量推导；「看得见的挡」与「撞得到的挡」不一致，就是下一个「被柜子挡住」。'),

  h2('4.5', '动态电器与 HUD'),
  table(
    ['对象', '实现', '节流 / 参数'],
    [
      kv('扫地机器人', 'Villa/robot；CylinderGeometry(0.2,0.2,0.09,16) + LED 球；沿 8 点路径巡游 1F 客厅', '一圈后回基站停 4s'),
      kv('电视', '256×144 CanvasTexture → MeshBasicMaterial；屏幕 PlaneGeometry(2.2,1.24) + 外框', '每 8s 轮换彩条 / 时钟 / 渐变风景；update 每 0.25s 节流重绘，避免逐帧上传贴图'),
      kv('电梯 HUD', '#villa-ui：B1 / 1F / 2F / 3F 按钮、返回大厅、Esc、toast', '_updateUILevel() 每帧刷新楼层文本'),
      kv('入口提示', '.lb-villa-hint：按 E 进入我的别墅（点这里也可以）', '200ms 防抖；提示条可点，手机无键盘也能进门'),
    ],
    [16, 52, 32],
    { firstColBold: true, zebra: true, size: 16 },
  ),

  h2('4.6', '入口与外壳契约（硬依赖，改动前必读）'),
  table(
    ['契约', '位置', '作用'],
    [
      kv('City/villa（root 名）', 'city-villa.js', 'Villa.activate() 用 scene.getObjectByName 找到并设 visible=false；退出恢复。verify-villa-embed / verify-villa-shell 断言'),
      kv('City/villa-door', 'city-villa.js 的 DOOR 桶 Mesh', 'userData.villaDoor=true；lobby-scene.js 写入 facilityKey=villa 并 push 进 _pickables；verify-villa-door 断言'),
      kv('City/villa-ring', 'city-villa.js', '门口发光环，玩家一眼看到「这里能进」'),
      kv('doorPos / colliders', 'buildCityVilla() 返回值', '_villaDoorState() 用 colliders[0] AABB 与 doorPos 判定 near，与几何无关'),
      kv('owned 台账', 'metropolis-scene.js', '8 桶 geometry / material + 光环 / 光斑 / 招牌全部登记，dispose 时统一释放'),
    ],
    [24, 30, 46],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  p('这意味着：替换外壳几何是安全的（判定只看 AABB / doorPos），但 root 名、门板名、ring 名、doorPos、colliders、owned 登记这六项一个都不能少。'),

  h2('4.7', 'WASD 多层状态机'),
  bullet('_mkWASD() 每次 activate 现建 WASDController（其 dispose 是终态，不能复用），isEnabled 受 _active 与电梯运行态门控；getObstacles 走 _worldBoxes()，getGroundHeight 走 _worldGroundAt()。'),
  bullet('_walkBoxesByLevel() 按 _level 拼接 _furnitureBoxes[lv]；电梯不在本层时追加 _shaftDoor；用 key=lv*2+(carHome?1:0) 的 _boxCache 缓存。'),
  bullet('update(dt) 先记 _footY；cameraRig.isTransitioning / runtime.isTransitioning 为真时跳过相机写入（只保留电梯更新）；随后 _syncLevel / _updateRobot / _updateUILevel / 电视节流。'),
  bullet('getCameraAnchor() = localToWorld(SPAWN + 1.6) + Euler(0, SPAWN.yaw + VILLA_ORIGIN.yaw, 0, "YXZ") → Quaternion；activate 把 cam.near 从 0.1 改 0.06（室内贴墙不裁面），deactivate 还原。'),

  h2('4.8', '已修复的根因清单（避免重复踩坑）'),
  table(
    ['症状', '根因', '修法'],
    [
      ['门口按 E 毫无反应', '漫游层 isEngaged() 吞掉 E；预热重建时监听被移除；触发半径太小且超距零反馈', '收敛为 _villaDoorState / _tryEnterVilla / _updateVillaDoor 单一判定；半径 6.0m；16m 内给提示；提示条可点；门板进拾取表'],
      ['上楼扭一下就没了 / 突然到地下', '_level 可写 + 相机 y 反推楼层，一帧跳 3.6m；楼板整块无洞', '支撑面求解 + 固定三段跑道 + 逐帧高差 1.7m 才接力'],
      ['3F 楼梯口被柜子挡死', '衣柜横在出口只留 0.35m；楼梯井碰撞全局 2D 对三层同时生效；隔断直抵南墙', '分段级栏板 + 1.1m 平台口；衣柜沿北墙拆成三扇；隔断缩到 z=6.2'],
      ['画面一直闪 / 像卡住', '每层多建 0.1m 天花板与上层楼板共面 z-fighting；玻璃未关 depthWrite', '删多余天花板；玻璃 depthWrite=false；楼板双层错层；墙体嵌进楼板 0.04m'],
      ['别墅 HUD 与大厅 HUD 叠字', '两层 UI 同时挂在 document.body', 'activate 收起 .lb-ui / .pg-ui，deactivate 原样恢复'],
      ['mergeGeometries 返回 null', '不同 geometry 缺 color 属性', '合并前统一补白色 color attribute'],
    ],
    [26, 38, 36],
    { firstColBold: true, zebra: true, size: 15 },
  ),
];

/* ---------------------------------------------------------------- 05 Blender */
const blender = [
  h1('05', 'Blender 离线建模管线'),
  p('2026-11-19 起，项目引入 Blender 做「离线建模 → 量化几何数据编译进 JS」的资产提质路线。它不破坏零外部资产铁律，也不需要运行时 GLTFLoader。'),

  h2('5.1', '为什么不用 GLB 运行时加载'),
  table(
    ['冲突点', '具体后果'],
    [
      kv('零外部资产铁律', 'GLB 是外部资产；当前全部外观为程序化几何 + Canvas/DataTexture'),
      kv('300k 三角面红线', '外部模型面数不可控，直接冲击 verify-redline 的 ≤300,000 断言'),
      kv('资源稳态 Δ0/0', 'GLB 一进来 geometry + texture 双涨，进出设施稳态断言直接挂'),
      kv('InstancedMesh / LOD / 四季', 'AI 车、树、建筑、人物全绑在程序化 BufferGeometry 上；四季 shader 以字符串注入 #include，外部 GLB 进不了这套体系'),
      kv('NPC 单 draw call', '程序化人物是 1656 面/人、全体合并 1 draw call；换 GLB 每人一个 Mesh，几百 NPC 直接爆 900 calls 上限'),
      kv('生命周期契约', 'IAttraction.init() 是同步契约，GLTFLoader 是异步，设施初始化顺序要动'),
    ],
    [26, 74],
    { firstColBold: true, zebra: true },
  ),
  p('结论：Blender 只做离线建模 / Cycles 预览 / 人工验收，导出的是 position / normal / color / index 的量化整数数组，编译成 JS 模块；运行时沿用现有 MeshStandardMaterial、mergeGeometries、InstancedMesh、顶点色与 owned 台账。'),

  h2('5.2', '环境与执行方式'),
  table(
    ['项', '值'],
    [
      kv('Blender', '3.6.23，安装在 D:/blender/blender.exe'),
      kv('MCP 连接', 'GUI 插件 Addon 2.0；需在 Blender 里 N 面板 → BlenderMCP → Start Server，监听 9876'),
      kv('配置', '~/.workbuddy/mcp.json 的 blender 服务为 uvx mcp-for-blender → 9876；它是自定义 MCP 服务，不在插件列表内，无 pluginId 可重连'),
      kv('执行', 'blender_client.py --file <脚本> 走 socket（GUI 实时可见）；或 blender.exe --background --python <脚本> 无头模式'),
      kv('自检', 'blender_client.py --self-test / --detect-env（判定 mcp_available / recommended_mode=socket）'),
      kv('辅助脚本', 'tools/blender/start_mcp_server.py 可强制启用插件并启动 9876 服务'),
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),

  h2('5.3', '数据格式与轴变换（新增资产必读）'),
  codeBlock([
    'Blender Z-up (x, y, z)  →  Three.js (x, z, -y)     det = +1，手性不变，法线同变换',
    '  含义：Blender +Y(南/正面) → Three -Z；Blender Z(高度) → Three Y',
    '  脚本内 AXIS_CHECK_OK 断言运行时包围盒，防止整车/整栋「站起来」或方向反了',
    '',
    '导出 JS 模块结构（勿手改）：',
    '  const <BUCKET> = { position:[...], normal:[...], color:[...], index:[...] };',
    '  position / normal 为毫米整数（÷1000）；color 为 0–255 整数（÷255）',
    '  build(d) → BufferGeometry（setAttribute + setIndex）',
    '  export function createXxxParts() → { WALL, GLASS, ... }',
    '  export const XXX_TRIS = <总三角面数>   // 供预算台账与验收断言',
    '',
    '关键约束：所有变换必须烘焙进顶点（collect 只读 v.co，不读 obj 变换）。',
    '按材质分桶，每桶 1 个 Mesh / 1 draw call；顶点色做明暗调制，material.color 给基色。',
  ]),

  h2('5.4', '资产 ①：都会区轿车（提交 03a4e00）'),
  table(
    ['项', '内容'],
    [
      kv('脚本', 'tools/blender/build_city_car.py'),
      kv('产物', 'models/blender-car-preview.png（Cycles CPU 64spp）；src/scenes/metropolis/city-car-blender-model.js（114KB）'),
      kv('几何', '侧轮廓放样车身 + 轮眉 / 保险杠 / 格栅 / 灯框 / 后视镜 / 尾翼 + 玻璃舱 / A 柱 / 车顶条'),
      kv('面数', '3,444 tris（车身 2,908 + 玻璃舱 536；原盒车 24 tris）'),
      kv('接入', 'city-traffic.js 的 bodyGeo / cabinGeo 换 Blender 几何；bodyMat 开 vertexColors（白=车漆 × instanceColor，深/浅灰=饰件）；实例缩放归一为 1；轮子保留 detailedWheelGeometry'),
      kv('零改动', '碰撞 / 车位 / AI / 驾驶逻辑；实例数量与 draw call 不变'),
    ],
    [16, 84],
    { firstColBold: true, zebra: true },
  ),

  h2('5.5', '资产 ②：别墅外壳精修（提交 9ff71b1）'),
  p('目标文件是 src/scenes/metropolis/city-villa.js（街道常驻外壳，进室内时整体隐藏）；室内 villa.js 是 v3 未提交改动，全程绕开未碰。'),
  table(
    ['项', '内容'],
    [
      kv('脚本', 'tools/blender/build_city_villa.py（TRI_BUDGET=12000，脚本内断言）'),
      kv('产物', 'models/blender-villa-preview.png（Cycles CPU 48spp，两轮人工验收定稿）；src/scenes/metropolis/city-villa-blender-model.js（226KB）'),
      kv('构件', '三层错落体量（2F 东退台 / 3F 再退台）、内凹玻璃幕墙（背板 + 玻璃 + 铝合金分格 + 窗台窗楣挑板）、1F 木格栅与 2F 水平木百叶、层间腰线与檐下灯带、雨棚门廊 / 双开门 / 三级台阶 / 门廊柱、玻璃栏板阳台 + 铺装 + 户外家具、屋顶女儿墙 / 空调外机 / 太阳能板 / 通风帽、东西竖鳍与条窗、庭院铺装 / 矮墙 / 绿化池 / 阔叶树 / 庭院灯'),
      kv('面数', '5,612 tris：WALL 612 / GLASS 264 / FRAME 2460 / WOOD 548 / DOOR 84 / DARK 588 / GLOW 168 / GREEN 888'),
      kv('8 个桶', 'WALL / GLASS / FRAME / WOOD / DOOR / DARK / GLOW / GREEN；GLOW 用 MeshBasicMaterial(toneMapped=false) 做夜间灯带，其余 MeshStandardMaterial + vertexColors'),
      kv('落位', '每个桶 geo.translate(-30, 1.16, 134)；root 保持 identity，光环 / 招牌 / 门板 / 碰撞盒世界坐标不变'),
      kv('契约', 'root 名 City/villa、门板 City/villa-door、City/villa-ring、doorPos、colliders、owned 台账全部保留'),
      kv('验收', 'tests/verify-villa-shell.mjs 7/7（8 桶就位、5612 tris 与台账一致、资源登记、门板拾取、显隐、0 报错）'),
    ],
    [14, 86],
    { firstColBold: true, zebra: true, size: 16 },
  ),
  callout('风格边界（如实说明）', [
    '这是「建筑构件级写实」：真实比例、凹窗进深、幕墙分格、挑檐阴影、栏板、设备层与庭院。受 300k 红线与零外部资产约束，不是照片级 PBR 扫描件；材质沿用原都会区配色（米白墙 / 深灰铝 / 蓝灰玻璃 / 暖木），与项目 Q 版城市保持连贯。',
  ], 'info'),

  h2('5.6', '建筑精修面数预算表与后续队列'),
  table(
    ['项', '三角面', '备注'],
    [
      kv('300k 红线', '300,000', 'verify-metropolis / verify-redline 双机位断言'),
      kv('本轮都会区实测峰值', '236,381', '已含车模 3,444 + 别墅 5,612'),
      kv('剩余余量', '63,619', '后续每个建筑 ≤12,000，留安全垫'),
      kv('② 游乐场 / ③ 医院 / ④ 动物园 / ⑤ 其他', '各 ≤12,000', '4×12,000=48,000 → 峰值 ≤284,381'),
      kv('单建筑超配额', '需等量替换或压缩', '不改基线让测试变绿'),
    ],
    [34, 16, 50],
    { firstColBold: true, zebra: true },
  ),
  p('实现顺序按「都会区同域优先、逐个交付」：别墅（已完成）→ 医院 / 商场等都会区实体 → 独立设施（游乐场 / 动物园）。每个建筑单独建模脚本、单独预览验收、单独回归、单独提交。'),

  h2('5.7', '如何新增一个 Blender 资产（可复现步骤）'),
  bullet('1) 在 tools/blender/ 复制 build_city_villa.py 作为骨架；保留 make_mat / add_box / add_polybox / add_revolve / collect / js_bucket 等工具函数。'),
  bullet('2) 按 Blender Z-up 语义建模（+Y 为正面 / 南），所有变换烘焙进顶点；按材质分桶，给每个 obj 设 obj["vc"] 顶点色。'),
  bullet('3) 加 AXIS_CHECK_OK 包围盒断言 + TRI_BUDGET 面数断言；Cycles CPU 渲染预览图，人工 ViewImage 验收通过后才算定稿。'),
  bullet('4) 导出 JS 数据模块（勿手改），在对应场景文件里 createXxxParts() → 每桶建 Mesh → geo.translate(世界坐标) → 材质用现有 MeshStandardMaterial + vertexColors → 全量登记 owned 台账。'),
  bullet('5) 保留所有既有命名 / 拾取 / 碰撞契约；新增一个 verify-*-shell.mjs 固化 8 桶、面数、台账、显隐断言。'),
  bullet('6) 跑 npm run build + verify-redline + verify-metropolis + 相关专项；更新 docs/current-status.md 的预算表；单独提交。'),
];

/* ---------------------------------------------------------------- 06 红线 */
const performance = [
  h1('06', '性能预算与工程红线'),
  callout('口径纠偏：30 万是三角面，不是 Draw Call', [
    'config/default.json 的 triangleBudget=300000 是硬红线；drawCallBudget=900 只约束新增内容 / 新视图。大厅全量俯瞰 1,198 calls 是既有内容基数，不要用它冒充新增内容，也不要为了「压 calls」去合并不该合并的网格。',
  ], 'warn'),

  h2('6.1', '硬指标与当前实测（2026-11-19）'),
  table(
    ['指标', '红线', '当前实测', '判定'],
    [
      kv('三角面（都会区峰值）', '≤300,000', '236,381（verify-metropolis 7 机位最大值）', 'PASS；余量 63,619'),
      kv('三角面（redline 双机位）', '≤300,000', 'overview 173,812 / standard 170,438', 'PASS'),
      kv('新增内容 draw calls', '≤900', 'maxCalls 741（都会区机位）', 'PASS'),
      kv('稳态 GPU 资源', '热路径零增长', '152 geometries / 51 textures（v4 全量机位）', 'Δgeo=0 / Δtex=0'),
      kv('四季粒子', '≤760 同时存在', '峰值 760；clear 后 freeTop=3000', 'PASS'),
      kv('驾驶物理体', '下车清零', '14 → 0', 'PASS'),
      kv('生产构建', '必须通过', 'npm run build ✓（155 模块）', 'PASS'),
    ],
    [24, 16, 38, 22],
    { firstColBold: true, zebra: true, size: 16 },
  ),

  h2('6.2', 'LOD 策略'),
  table(
    ['对象', '近景', '中景', '远景'],
    [
      kv('都会区建筑', '≈1,474 tris（入口 / 招牌 / 红十字 / 跑道 / 窗光）', '252 tris（体块合并）', '252 tris（单色块 + 窗光贴图）；0 / 95 / 185m 或 0 / 160 / 260m 口径见代码'),
      kv('城堡 / 农场', '完整细节（8 塔 / 968 作物）', '区域 LOD detail', 'silhouette（北区远离大厅时自动降载）'),
      kv('设施', 'DetailLOD level 0', '90m 起简化', '115m 起剪影'),
      kv('树 / 作物 / 车辆 / 动物 / 行人', 'InstancedMesh', '同上', '视锥剔除 + 距离 LOD'),
    ],
    [18, 32, 20, 30],
    { firstColBold: true, zebra: true, size: 16 },
  ),

  h2('6.3', '十条工程红线（绝对不能碰）'),
  table(
    ['#', '红线', '违反后的典型症状'],
    [
      ['01', '三角面 >300,000', '低端机掉帧；verify-redline / verify-metropolis 直接失败'],
      ['02', '新增内容 calls >900', '城市 / 设施视角卡顿；draw call 审计失败'],
      ['03', 'update 里 new 几何 / 材质 / 纹理 / 数组 / Date', 'Δgeo / Δtex 持续上涨；显存泄漏'],
      ['04', '重复物件不用 InstancedMesh', 'draw call 线性爆炸'],
      ['05', '新增常驻灯 / 投影灯', '阴影 pass 翻倍；移动端崩帧；夜景应优先 emissive + 光斑贴图 + Bloom'],
      ['06', 'AI 车全部改动态刚体', '物理 CPU 爆炸；车辆互相顶飞'],
      ['07', '绕过粒子池 / 超过 760', '天气切换后资源不归还；峰值穿红线'],
      ['08', '破坏 CameraRig owner 仲裁 / 裸写 camera.position', '相机双写、视角拉扯、设施退出后回不来'],
      ['09', '破坏 Rapier 懒加载（启动即 init）', '首屏加载 4.34MB vendor-physics，启动变慢'],
      ['10', '改基线 / 红线让测试变绿', '真实回归被掩盖；下一位模型接手即踩雷'],
    ],
    [6, 48, 46],
    { firstColBold: true, zebra: true },
  ),
  bullet('资源台账铁律：geometry / material / texture / InstancedMesh 全登记，dispose 幂等；InstancedMesh 要单独 dispose instanceMatrix / instanceColor。'),
  bullet('坐标铁律：以 DISTRICT_GRID / CITY / ZOO_LAYOUT / FOREST_PARK 为单一真相源；北区几何世界坐标烘焙，移动用 _rebase。'),
  bullet('嵌入视图铁律：不得 dispose 常驻世界；视图不写相机；update 遇 cameraRig.isTransitioning 必须跳过写入。'),
  bullet('验证铁律：node tests/verify-all.mjs（约 15–20 分钟）；dev server 须先在 5173 运行；不改基线让测试变绿，基线更新必须单独评审并归档旧值。'),

  h2('6.4', '构建配置与分包'),
  table(
    ['配置', '值 / 行为'],
    [
      kv('config/default.json', 'dev host 127.0.0.1 / port 5173 / strictPort true；pixelRatioCap 2；triangleBudget 300000；drawCallBudget 900'),
      kv('缓存头', '/assets/* → public, max-age=31536000, immutable；入口 html → no-cache（dev 与 preview 规则一致）'),
      kv('vite.config.js manualChunks', '顺序固定：vendor-physics → vendor-move → vendor-gui → vendor-three；vendor-move 必须排在 vendor-three 之前（路径都含 three）'),
      kv('懒加载', 'physics-manager.js 用动态 import() 幂等 + 并发安全 + 失败可重试；PHYSICS_KEYS={dummy, pumpkin-thrower} 在 onEnterAttraction / prewarmFacility 门控处才拉取；baseCtx.world / RAPIER 由 syncPhysicsContext() 就绪后回填'),
      kv('构建产物', 'vendor-physics 4.34MB 保持懒加载分块，不在首屏 modulepreload'),
    ],
    [24, 76],
    { firstColBold: true, zebra: true },
  ),
];

/* ---------------------------------------------------------------- 07 验收 */
const verification = [
  h1('07', '验收体系与当前基线'),
  p('验收脚本用 Playwright + Edge Headless（--use-gl=angle --use-angle=swiftshader），直接读 window.__playground 的运行时状态；不靠截图肉眼判断。所有脚本依赖 5173 dev server（build 套件除外）。'),

  h2('7.1', '联合门禁 verify-all.mjs'),
  p('node tests/verify-all.mjs 串行跑 10 个套件（避免 headless SwiftShader 抢资源假阴性），任一失败整体非零退出；支持 --only camera,redline 逗号分隔。判据：exit code 0 且命中 marker 正则且输出中无 FAIL 行。'),
  table(
    ['#', 'key', '子脚本 / 命令', '通过 marker'],
    [
      ['1', 'build', 'npm run build', '/built in/'],
      ['2', 'camera', 'verify-camera-contract.mjs', '/allPass=true/'],
      ['3', 'redline', 'verify-redline.mjs BASE', '/allPass=true/'],
      ['4', 'v4', 'verify-v4.mjs', '/"FAIL": 0/'],
      ['5', 'season', 'verify-season.mjs', '/allPass=true/'],
      ['6', 'driving', 'verify-driving.mjs', '/allPass=true/'],
      ['7', 'drive-roam', 'verify-drive-roam.mjs', '/allPass=true/'],
      ['8', 'villa', 'verify-villa.mjs', '/allPass=true/'],
      ['9', 'phase2', 'verify-phase2.mjs', '/allPass=true/'],
      ['10', 'm6zoo', 'verify-m6-zoo.mjs', '/allPass=true/'],
    ],
    [6, 16, 48, 30],
    { firstColBold: true, zebra: true },
  ),
  callout('门禁现状提醒', [
    'villa 套件仍指向 verify-villa.mjs，而该脚本在 v3 嵌入视图改造后已漂移为 2/4（见 7.4）；当前全绿的 verify-villa-shell / -door / -embed / -stairs 与 verify-metropolis / verify-m3-npc 均未纳入 SUITES。跑全套前先知道这一点。',
  ], 'warn'),

  h2('7.2', '验收脚本清单（tests/ 顶层 45 个文件）'),
  table(
    ['类别', '脚本', '测什么'],
    [
      ['核心门禁', 'verify-redline / verify-v4 / verify-camera-contract / verify-all', '红线 8 项、v4 全量 13 项、相机写者契约 7 项、套件编排'],
      ['别墅专项', 'verify-villa-shell 7/7 · verify-villa-door 8/8 · verify-villa-embed 12/12 · verify-villa-stairs · verify-villa（旧语义，漂移）', '外壳资产 / 门口交互 / 同场并置 / 楼梯 / 四层家具与电器'],
      ['都会区', 'verify-metropolis 19/19 · verify-m2-layout · verify-m7-districts · verify-zoo · verify-m6-zoo', '7 机位预算、LOD、交通、夜景、布局与触发环、动物园五区'],
      ['系统', 'verify-season 16/16 · verify-driving 21/21 · verify-drive-roam 7/7 · verify-phase2 20/20 · verify-m3-npc 7/7', '四季天气、驾驶物理、漫游集成、生态扩张、NPC 寻路'],
      ['阶段专项', 'verify-m1-wasd · verify-m4-jump（跳舞厅）· verify-m5-castle · verify-m8-castle · verify-m9-farm · verify-phase3 · verify-phase4 · verify-six-upgrades（17/20 既有漂移）', '各历史阶段的专项断言'],
      ['上线 QA', 'verify-launch-qa', '5 维端到端 QA（全设施闭环 / 核心交互 / UX / 边界 / 5 分钟长跑），报告落 docs/screenshots/launch-qa-report.json'],
      ['诊断与截图', 'diag-* 12 个 · villa-capture / villa-embed-capture · _layout-probe', '预算构成、dispose 追踪、别墅机位迭代；明确「不是验收项」'],
      ['基线数据', 'redline-baseline.json（现行，overview 1198/285242）· redline-baseline-m0.json（归档）', '相对容量基线增量断言；M0 已不再用于断言'],
    ],
    [16, 46, 38],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  p('tests/_archive/ 内有 53 个一次性 _* 探针，已被 .gitignore 排除、不入库，本地可查。'),

  h2('7.3', '当前验收基线（2026-11-19 实测）'),
  table(
    ['套件', '结果', '关键指标'],
    [
      kv('npm run build', 'PASS', '155 模块；vendor-physics 4.34MB 懒加载'),
      kv('verify-redline (BASE)', '8/8', 'overview 173,812 tris / 690 calls；Δgeo=0 / Δtex=0；9 触发环 + 动物园五区'),
      kv('verify-v4', '13/13', '5 轮往返 Δgeo=−31 / Δtex=−16（负值=视角缓存释放）；0 报错'),
      kv('verify-season', '16/16', '天气峰值 760，clear 后 freeTop=3000；8 次切换 Δ0/0'),
      kv('verify-driving', '21/21', '上车 14 刚体 → 下车 0'),
      kv('verify-drive-roam', '7/7', '地面漫游可按 E 上车；驾驶中漫游让位；下车自动恢复'),
      kv('verify-metropolis', '19/19', 'maxTris 236,381 / maxCalls 741；LOD 三级；5 轮 Δ0/0'),
      kv('verify-m3-npc', '7/7', '人物提质后仍 1 draw call；900 帧 0 卡墙'),
      kv('verify-villa-shell', '7/7', 'Blender 外壳 8 桶 / 5,612 tris / owned 台账 / 门板拾取 / 显隐'),
      kv('verify-villa-door', '8/8', '门口按 E、提示条点击、门洞拾取、往返闭环、0 报错'),
      kv('verify-villa-embed', '12/12', '同场并置、外壳隐藏、阳台真实城景（city=97 / villa=9）、退出恢复'),
      kv('verify-villa', '⚠️ 2/4', '既有脚本漂移，见 7.4；同语义由上方三脚本全绿覆盖'),
      kv('verify-phase2 / verify-m6-zoo', '20/20 · 8/8', '历史记录'),
    ],
    [26, 12, 62],
    { firstColBold: true, zebra: true, size: 16 },
  ),

  h2('7.4', '已知漂移与遗留（如实记录，未修改）'),
  table(
    ['项', '现状', '影响 / 处理'],
    [
      kv('verify-villa.mjs 2/4', '旧断言写死独立设施语义（activeKey==="villa"、camY≈1.6、从 attractionManager.active 取 villa 私有属性）；v3 后是 lobby / 2.8', '与本轮改动无关；同语义由 villa-shell / -door / -embed 全绿覆盖。若要修，需整体改成嵌入视图口径，属用户未提交的 v3 改动范围'),
      kv('v3 未提交改动', 'src/main.js、src/scenes/attractions/villa.js、src/scenes/lobby-scene.js、tests/verify-villa.mjs 为 M；villa-embed-view.js、villa 相关测试与 v3 截图为 ??', '当前工作区不是 clean 状态；任何提交都要精确 add，避免误带'),
      kv('GLB 试点遗留', 'build_vehicle.py（根目录）、models/vehicle.glb、models/vehicle-preview.png 均为未跟踪，全仓无运行时引用', '早期「离线建模→直接导出 GLB」路线试点，已被 05 章的数据编译管线取代；不进打包'),
      kv('draw call 口径分裂', 'redline 固定双机位 669–690，全量俯瞰约 1,198；900 只约束新增内容', '若产品要求全量也压到 900，须另立合批专项，不得改基线掩盖'),
      kv('hand-landmarker.task', 'public/models/hand-landmarker.task 已在工作区被删除（git status 显示 D）；消费方 hand-tracker.js 从未接线', '无运行时影响；不要为它新增依赖'),
      kv('shader 字符串注入', 'season-cycle.js 用字符串精确匹配注入 #include；three 升级可能静默失效（uniform 照加、效果消失、无失败分支）', '升级 three 后必须跑 verify-season 复核'),
      kv('都会区背向更新', 'metropolis-scene.js 背向时整组隐藏（省 draw），但子系统仍全量 update（CPU 常开）', '已知优化点，未处理'),
      kv('verify-six-upgrades', '17/20（3 项 farm / castle / LOD 既有脚本漂移）', '非本轮引入；badTextures=0'),
    ],
    [20, 44, 36],
    { firstColBold: true, zebra: true, size: 15 },
  ),

  h2('7.5', '常用验收命令'),
  codeBlock([
    'npm run dev                              # 先起 5173 dev server',
    'npm run build                            # 生产构建',
    'node tests/verify-all.mjs --only redline,v4,driving,drive-roam',
    'node tests/verify-metropolis.mjs         # 都会区 19/19（含 7 机位 ≤300k）',
    'node tests/verify-villa-shell.mjs        # Blender 外壳 7/7',
    'node tests/verify-villa-door.mjs         # 门口交互 8/8',
    'node tests/verify-villa-embed.mjs        # 同场并置 12/12',
    'node tests/verify-redline.mjs            # 红线 8/8（Δ0/0）',
    'node tests/verify-v4.mjs                 # 全量 13/13',
    'npm run docs:handover                    # 重新生成本文档',
  ]),
];

/* ---------------------------------------------------------------- 08 接手 */
const handover = [
  h1('08', '换模型接手指南'),
  p('下一位模型不需要从 5,941 行 lobby-scene.js 的第一行读起。按下面的顺序建立「坐标 — 生命周期 — 性能」三张地图，再动代码。'),

  h2('8.1', '十分钟阅读顺序'),
  table(
    ['顺序', '读什么', '要建立什么认知'],
    [
      ['1', 'docs/current-status.md', '当前唯一权威现状、铁律、验收基线、Blender 管线与预算表'],
      ['2', 'src/main.js', 'bootstrap、注册表、EMBEDDED_KEYS 分流、frameDriver、懒加载与预热门控'],
      ['3', 'src/core/attraction-manager.js + facility-runtime.js + camera-rig.js', '两套设施生命周期、相机 owner 仲裁、0.8s blend'],
      ['4', 'src/scenes/districts.js + metropolis/city-layout.js', '四宫格、道路、都会区坐标单一真相源'],
      ['5', 'src/scenes/lobby-scene.js 的 FACILITY_SPECS / _buildTriggers / _villaDoorState / update / dispose', '常驻大厅、9 触发环 + 别墅门口、相机 / 输入互斥、七步清理'],
      ['6', 'season-cycle.js + particle-system.js + day-night-cycle.js', '全局氛围系统与粒子池纪律'],
      ['7', 'city-traffic.js + city-driving.js', '交通样条、AI 包围盒、玩家车物理与 E / F 仲裁'],
      ['8', 'src/scenes/attractions/villa.js + components/embedded-views/villa-embed-view.js', '最复杂的嵌入视图：四层、楼梯、电梯、坐标换算'],
      ['9', 'tests/verify-redline.mjs + verify-all.mjs', '什么叫「通过」，以及如何复现'],
    ],
    [7, 46, 47],
    { firstColBold: true, zebra: true },
  ),

  h2('8.2', '核心文件地图'),
  table(
    ['文件', '职责', '接手时的注意点'],
    [
      kv('src/main.js（1,087 行）', '唯一入口；注册、预热门控、frameDriver', '不要绕过 registry 直接 new 场景；EMBEDDED_KEYS 决定分流'),
      kv('src/scenes/lobby-scene.js（5,941 行）', '常驻大厅；FACILITIES、相机五态、UI、dispose', '只读需要的段；不要整体重排 FACILITY_SPECS；触发环数量脚本断言为 9'),
      kv('src/scenes/metropolis/city-layout.js', 'CBD 坐标、道路、街块、公交站', '所有城市坐标以此为准'),
      kv('src/scenes/metropolis/metropolis-scene.js', '城市组合、更新、夜景、背向剔除', '夜景只调材质，不加灯；背向仍全量 update'),
      kv('src/scenes/metropolis/city-traffic.js', '车流、公交、认领 / 归还、停车位', 'AI 车是视觉 + 运动学，不是动态刚体；车几何来自 Blender 数据模块'),
      kv('src/scenes/metropolis/city-driving.js', '玩家车完整物理、E 上下车、相机', '只在需要时懒加载 Rapier；下车清零'),
      kv('src/scenes/metropolis/city-villa.js', '别墅外壳 8 桶 + 光环 + 招牌 + 碰撞', '六项契约一个都不能少（见 4.6）'),
      kv('src/scenes/attractions/villa.js（1,650 行）', '四层室内、家具、电梯、楼梯、电器', '本地↔世界坐标要换算；改家具前先量 1.1m 平台口'),
      kv('src/components/embedded-views/*', '6 个嵌入视图 + 基类契约', '视图不写相机；只 track 独占资源'),
      kv('src/scenes/districts.js', '四宫格骨架、区域 LOD、城堡 / 农场挂载', '世界坐标烘焙；移动要 _rebase'),
      kv('src/utils/helpers/*', '昼夜 / 四季 / 粒子 / NPC / 程序化纹理与人物', '热路径零 new；不要合并 broad / conifer 角色'),
      kv('tests/verify-redline.mjs', '预算与结构守门', '不能通过改基线来「修复」回归'),
    ],
    [30, 30, 40],
    { firstColBold: true, zebra: true, size: 15 },
  ),

  h2('8.3', '安全改动流程'),
  table(
    ['步骤', '动作', '通过标准'],
    [
      ['1', '先跑基线：build + redline + 相关专项', '记录 geo / tex、calls、tris 与测试结果'],
      ['2', '改前先定位单一真相源', '坐标改动只改 layout / GRID；不手写重复坐标'],
      ['3', '新增内容先做预算估算', '面数、calls、材质 / 纹理数量写进改动说明；对照 5.6 预算表'],
      ['4', '优先复用共享几何与材质', '能用 InstancedMesh 就不建 Mesh；能注入材质就不建新材质'],
      ['5', '跑完整验收，不只看截图', 'Δ0/0、预算、功能、0 console error 全过'],
      ['6', '基线有变化时单独说明', '归档旧基线；不把回归混进「优化」'],
      ['7', '精确提交', '工作区存在未提交的 v3 改动，用 git add <具体文件> 而非 git add -A'],
    ],
    [7, 48, 45],
    { firstColBold: true, zebra: true },
  ),

  h2('8.4', '常见坑'),
  table(
    ['坑', '表现', '正确做法'],
    [
      kv('把「南门」当 +z 方向', '新内容坐标整体反向', '以 DISTRICT_GRID / CITY 常量为准'),
      kv('只改 group.position 移动北区', '碰撞、LOD、烘焙几何错位', '使用 _rebase 或重烘顶点'),
      kv('把 LOD 钉死高模', '远景 draw calls 暴涨', '保持 autoUpdate，让 renderer 切换'),
      kv('设施退出只 remove 不 dispose', 'Δgeo / Δtex 缓慢上涨', '走 DisposableRegistry + 七步清理 + owned 台账'),
      kv('城市夜景加 PointLight', '阴影 / 光照 pass 翻倍', '用 emissive、光斑贴图、Bloom'),
      kv('NPC 用玩家 110m 边界', 'NPC 走出导航图 / 穿墙', '使用 NAV_RADIUS 或 setBounds'),
      kv('把 30 万当 draw call 红线', '错误优化方向', '三角面 30 万；新增内容 draw call 900'),
      kv('嵌入视图里写 camera.position', '与 blendTo 打架，视角拉扯', '只返回 getCameraAnchor() 锚点'),
      kv('Blender 模型把变换留在 obj 上', '导出数据缺旋转 / 位移，整车整栋变形', '所有变换烘焙进顶点（collect 只读 v.co）'),
      kv('为了测试通过改 baseline', '回归被隐藏', '先修实现，再评审是否更新基线'),
    ],
    [30, 32, 38],
    { firstColBold: true, zebra: true, size: 15 },
  ),

  h2('8.5', '新增内容的正确姿势'),
  bullet('新增独立设施：实现 IAttraction 四方法 → main.js 注册 PROJECT_NAMES / attractionManager.register → 大厅加触发环（注意数量断言）→ 资源全登记 DisposableRegistry → 新增 verify 脚本。'),
  bullet('新增「进入某个空间」的玩法：优先走 IEmbeddedView 六方法（同场并置、大厅常驻），只有真正独占整套场景才允许走 attractionManager。'),
  bullet('新增重复物件：一律 InstancedMesh；路线 / 轨迹预采样成标量，热路径不重算曲线。'),
  bullet('新增建筑 / 载具外观：走 05 章 Blender 数据编译管线，先过面数预算表与 Cycles 预览验收，再接入 owned 台账与 verify-*-shell.mjs。'),
  bullet('新增纹理：CanvasTexture / DataTexture，统一 SRGBColorSpace，登记台账，共享只登记不重复创建。'),

  h2('8.6', '交付确认（接手自检）'),
  checkItem('已读 02 章坐标表，能说出六个区域的世界坐标与进入方式。'),
  checkItem('能区分 9 个设施触发环与第 10 个「都会区别墅门口」入口。'),
  checkItem('能说清 IAttraction 与 IEmbeddedView 的分流条件、注册位置与相机归属。'),
  checkItem('已读 04 章，知道别墅同场并置、外壳隐藏、三段楼梯与 1.1m 平台口。'),
  checkItem('已读 05 章，知道为什么不用 GLB、轴变换公式与建筑精修预算表。'),
  checkItem('已确认 300,000 是三角面红线、900 是新增内容 draw call 红线。'),
  checkItem('能运行 build + redline + metropolis + villa 三专项四类验收。'),
  checkItem('理解「不改基线、不新增常驻灯、不把 AI 车全改动态刚体、嵌入视图不写相机」四条铁律。'),
];

/* ---------------------------------------------------------------- 附录 */
/* ---------------------------------------------------------------- 10 任务手册 */
const tasks = [
  h1('10', '任务导向手册（按任务查，不按章节读）'),
  p('这一章给「接到任务后从哪下手」。原理在 01–09；这里只给入口文件、必读章节和验收方式。任何改动都先遵守 06 的十条红线。'),
  h2('10.1', '本地跑起来 / 最小验证'),
  table(
    ['步骤', '命令', '判据'],
    [
      ['安装', 'npm install', 'node_modules 就绪'],
      ['开发', 'npm run dev', '5173 打开登录页 / 开始页'],
      ['构建', 'npm run build', 'dist 生成且无报错'],
      ['预览', 'npm run preview', '生产包可打开'],
      ['文档', 'npm run docs:handover', '项目信息.docx 重新生成'],
    ],
    [16, 28, 56],
    { firstColBold: true, zebra: true },
  ),
  h2('10.2', '新增一个游乐园设施'),
  bullet('实现 IAttraction 四方法 → main.js 注册 PROJECT_NAMES / attractionManager.register → lobby-scene 加触发环 → 资源登记 DisposableRegistry → 新增 verify 脚本。'),
  bullet('设施数量断言是 9；新增独立设施会改变 02.2 与 tests 里的数量，先全局搜索 9 相关断言。'),
  bullet('嵌入视图要注册 EMBEDDED_KEYS 并走 FacilityRuntime；不要自己写 camera.position，必须经 CameraRig。'),
  h2('10.3', '改大厅 / 别墅 / 入口'),
  table(
    ['要改', '入口文件', '注意'],
    [
      ['设施入口/提示', 'lobby-scene.js 的 FACILITIES / _findNearFacility / _onInteractKey', '三条路径：点击 / WASD E / orbit 中心射线 E；手机点 HUD 提示'],
      ['相机与输入模式', 'movement-mode-manager.js / camera-rig.js / lobby-scene.js', 'CameraRig owner 仲裁；新增接管相机必须暴露 movementMode.getContext() 标志'],
      ['别墅内部', 'villa.js / villa-embed-view.js', '四层、三段楼梯、电梯；进出 restore 机位；不要改外壳契约'],
    ],
    [22, 44, 34],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  h2('10.4', '改联机 / 房间协议'),
  table(
    ['层', '文件', '改动要点'],
    [
      ['客户端', 'src/net/multiplayer-client.js', '250ms sync；session/leave；远端插值；HUD'],
      ['登录页', 'src/components/login-screen.js', '?u=&p=&room= 自动登录；单人入口；iOS 16px'],
      ['线上函数', 'netlify/functions/room.mjs', 'Functions v2 POST /api/room；Blobs 适配'],
      ['房间核心', 'netlify/functions/_lib/room-core.mjs', 'login/sync/home/leave；session 409；TTL；数据收敛'],
      ['本地 API', 'server/local-room-api.mjs', '同协议内存实现，npm run dev 用'],
      ['账号', 'netlify/functions/_lib/accounts.mjs', '演示账号；前端不打包密码'],
    ],
    [16, 38, 46],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  bullet('新增房间字段必须同时改 room-core、客户端、tests/verify-multiplayer-server.mjs；线上函数与本地 API 共用一个核心，不要分叉逻辑。'),
  h2('10.5', '部署 / 回滚'),
  bullet('git status → 只 add 相关文件 → commit → push origin main；Netlify 自动构建。'),
  bullet('不要 git add .；会把 秘密.txt、截图、临时脚本、未完成改动带上。'),
  bullet('push 443 / 连接重置：等待 20~60 秒重试，或 git -c http.version=HTTP/1.1 push origin main；不是代码错。'),
  bullet('回滚：git revert <commit> 再 push；或在 Netlify 面板回滚到上一个成功部署（需要后台权限）。'),
  h2('10.6', '验收与性能红线'),
  bullet('build PASS；verify-multiplayer-server 10/10；verify-multiplayer 8/8（需 dev server）；单人浏览器 8/8。'),
  bullet('性能：都会区峰值 236,381 tris / 741 calls；全场景红线 300,000 tris / 新增 calls ≤900；热路径 Δgeo=0 / Δtex=0。'),
  bullet('新增内容先问：是否新增 geometry / texture / draw call / 常驻灯？再问好不好看。'),
  h2('10.7', '文档 / 秘密 / 交接'),
  bullet('改代码 → 更新 docs/current-status.md → 更新 scripts/generate-doc.js 对应表格 → npm run docs:handover → 复核 docx。'),
  bullet('真实 PAT / Token / Site ID 只放本机 秘密.txt（已 gitignore）；项目信息.docx 只放演示账号。'),
  bullet('交接最短路径：00.0 → 08.1 → 09.0 → 10 章任务表 → 对应源码。'),
];

const appendix = [
  h1('附录', '术语、仓库状态与生成方式', false),

  h2('A.1', '术语表'),
  table(
    ['术语', '含义'],
    [
      kv('Δgeo / Δtex', '同一稳态前后 renderer.info.memory 的几何 / 纹理数量差；红线为 0'),
      kv('热路径', '每帧都会执行的 update / render 代码；禁止 new GPU 资源'),
      kv('activeKey', '当前激活的设施 key；大厅常驻时仍是 lobby（嵌入视图不改变它）'),
      kv('IAttraction', '独立设施契约：init / update / onInteract / dispose 四方法'),
      kv('IEmbeddedView', '嵌入视图契约：init / getCameraAnchor / update / activate / deactivate / dispose 六方法'),
      kv('同场并置', '别墅与城市共用同一 scene 与同一世界坐标，实地落位，两边视野互相可见'),
      kv('外壳隐藏', '进入室内时把城市侧实心壳 City/villa 设为不可见，避免玩家站在盒内壁里'),
      kv('owner 仲裁', 'CameraRig 规定同一时刻只有一个相机写者；直写者须 allowDirectWrite 登记'),
      kv('InstancedMesh', '一次 draw call 绘制多个实例；本项目重复物件的默认方案，需单独 dispose'),
      kv('LOD', '按相机距离切换近 / 中 / 远模型；必须保持 autoUpdate'),
      kv('数据编译', 'Blender 建模 → 量化顶点数据内联进 JS 模块 → 运行时用现有材质体系重建；零 GLB'),
      kv('材质桶', '按材质分组的几何集合，每桶 1 个 Mesh / 1 draw call；别墅外壳 8 桶'),
      kv('支撑面求解', '_groundAt(x,z) 按井 / 阳台 / 楼梯 / 楼板 / 屋外分别返回脚高，而非由 _level 决定'),
      kv('weather pool', '烟花 / 天气共用的 3000 粒子对象池；天气峰值 760，clear 后 freeTop=3000'),
      kv('单一真相源', 'DISTRICT_GRID / CITY / CITY_INTERSECTIONS / ZOO_LAYOUT / FOREST_PARK / BUS_STOP'),
      kv('PHYSICS_KEYS', '{dummy, pumpkin-thrower}；只有这些设施激活时才动态 import Rapier'),
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),

  h2('A.2', '仓库当前状态（2026-11-19）'),
  table(
    ['类别', '内容'],
    [
      kv('已提交', '03a4e00（Blender 车模提质）、9ff71b1（Blender 别墅外壳精修）、3107fe5 及更早的阶段成果；提交均未 push'),
      kv('未提交（M）', 'src/main.js、src/scenes/attractions/villa.js、src/scenes/lobby-scene.js、tests/verify-villa.mjs、docs/current-status.md 之外的截图 / 报告改动；public/models/hand-landmarker.task 为 D（删除）'),
      kv('未跟踪（??）', 'src/components/embedded-views/villa-embed-view.js、villa 相关 verify / diag / capture 脚本、v2 / v3 内景截图、project-info_work/、build_vehicle.py、models/vehicle.glb、models/vehicle-preview.png'),
      kv('ignore', '.workbuddy/（项目记忆与日志）、tests/_archive/、_archive/、dist/、node_modules/'),
      kv('规模', 'src/ 77 个 .js；tests/ 顶层 45 个文件（28 个 verify-*）+ _archive/ 53 个探针；docs/screenshots/ 约 256 个证据文件'),
    ],
    [18, 82],
    { firstColBold: true, zebra: true },
  ),

  h2('A.3', '文档生成方式'),
  codeBlock([
    'npm run docs:handover      # 等价于 node scripts/generate-doc.js',
    '依赖：docx ^9.15.4（仅生成期使用，不进运行时）',
    '输出：D:/playground-mvp/项目信息.docx',
    '数据口径：2026-11-21 当前工作区代码 + docs/current-status.md 验收基线',
  ]),
  bullet('本次 v2.2 在 v2.1 基础上增补 00.0 三分钟速懂、10 章任务手册与附录 B–E：生成脚本的内容段与文档同步，不再有「手工追加章节、重新生成会丢失」的问题。'),
  bullet('项目里只保留这一份 项目信息.docx 作为唯一权威；旁路输出（DOC_OUT）只是临时文件，生成完必须立刻并回主文件名并删掉旁路副本，否则下次打开就是两份同构文档、看不出谁新谁旧。'),
  bullet('若 Word/WPS 正占用主文档：先关闭阅读器再跑生成；确实关不掉时用 DOC_OUT 输出到临时名，改完立即覆盖回 项目信息.docx 并删除临时文件。'),
  bullet('更新流程：改代码 → 更新 docs/current-status.md → 更新 scripts/generate-doc.js 中对应表格 → 重新运行生成 → 复核 docx。'),
  bullet('不要把历史阶段流水账堆进正文；演进结论压成 A.4 一张表，细节留在 docs/ 的历史文档里。'),

  h2('A.4', '演进时间线（精简，替代旧 06 / 07 增量章）'),
  table(
    ['时间', '阶段', '留下的结论'],
    [
      kv('2026-11-15', '阶段 1–2：底层抢救 + 核心玩法重写', '相机互斥、边界统一 110m、资源泄漏清零、LOD 降级恢复、拆包 + 物理懒加载；跳舞厅取代跳一跳；NPC 防穿模'),
      kv('2026-11-16', '阶段 3–5：城堡 / 农场 / 门面 / 都会区', '三级 LOD 城市、InstancedMesh 交通与人群、7 机位 ≤300k、5 轮 Δ0/0；v4 全量 13/13'),
      kv('2026-11-17', '阶段 5 工程底座加固', 'CameraRig.writePose 受控直写、syncGlobalContext 收敛四单例、粒子池按类型回收、verify-all 联合门禁'),
      kv('2026-11-18', '阶段 6：别墅同场并置 + 入口迁移', '别墅从独立设施改嵌入视图、四层重排、三段楼梯、门口按 E 进；入口从游乐园触发环迁到都会区商场西侧'),
      kv('2026-11-19 上午', 'Blender 车模', '数据编译管线跑通；3,444 tris 替换盒车；守红线零外部资产'),
      kv('2026-11-19 中午', 'Blender 别墅外壳精修', '5,612 tris / 8 材质桶；建筑精修预算表与逐个交付队列建立'),
      kv('2026-11-20', 'GTA 互动 + 帧率调速器', '撞人倒地 / 通缉星、农田收割重播、认领 AI 车、像素倍率自适应（见 3.8）；同步修掉表格第 3–4 列被 kv 丢弃的生成缺陷'),
      kv('2026-11-20', '空中花园（太空电梯 / 太空高铁）', '146m 轨道环 + 外挂式太空电梯 + 228m 爬升轨道与 4 节列车；同日第二版加自由视角、甲板漫步与环上街区（见 3.9），验收 verify-sky-garden 25/25'),
      kv('2026-11-21', '线上双人联机 + 单人入口', 'Netlify Functions + Blobs 房间、两个分享链接、同账号接管/退出释放、单人「不联机」入口与 orbit 按 E 进设施（见 09 章）'),
    ],
    [16, 30, 54],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  h2('B', '文件索引（按目录）'),
  table(
    ['目录 / 文件', '职责', '何时改'],
    [
      ['src/main.js', '基座装配：渲染器 / 场景 / 相机 / 设施注册 / 联机层 / onSkip / pagehide', '新增全局系统或联机装配'],
      ['src/core/scene-manager.js', '单渲染器、主循环、帧率采样', '渲染链 / 帧率'],
      ['src/core/attraction-manager.js', '独立设施 activeKey 切换', '新增独立设施'],
      ['src/core/facility-runtime.js', '嵌入视图激活 / 退出、相机接管', '新增嵌入视图'],
      ['src/core/camera-rig.js', '唯一相机写者：blendTo / restore / writePose', '相机过渡'],
      ['src/scenes/lobby-scene.js', '常驻大厅、入口、别墅门、驾驶、空中花园', '大厅交互 / 入口'],
      ['src/scenes/attractions/*', '9 个独立设施与别墅', '具体玩法'],
      ['src/net/multiplayer-client.js', '联机客户端：轮询 / 远端 / HUD / session', '房间与同步'],
      ['netlify/functions/*', '线上房间函数与房间核心', '线上联机'],
      ['tests/*.mjs', '验收脚本', '新增功能必须带验收'],
    ],
    [30, 46, 24],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  h2('C', '接口、环境变量与错误码'),
  table(
    ['项', '值 / 说明'],
    [
      kv('POST /api/room', 'login / sync / home / leave；JSON；线上 Netlify Functions，本地同协议内存'),
      kv('旧 WebSocket 协议', '已废弃；线上只保留 HTTP 短轮询，不要再新增 ws 服务端'),
      kv('409 SESSION_REPLACED', '同账号后开设备接管，旧端停止联机'),
      kv('401', '账号密码错误或 token 失效（客户端自动重新登录）'),
      kv('429', '房间已满（最多 8 人）'),
      kv('MULTIPLAYER_SECRET', 'token 签名密钥；默认 playground-online-demo-secret，生产在 Netlify 环境变量改'),
      kv('NETLIFY_AUTH_TOKEN / SITE_ID', '仅部署与后台管理用；只放本机 秘密.txt'),
    ],
    [26, 74],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  h2('D', '已知风险与未完成（如实记录）'),
  bullet('Netlify 国内网络不稳定；微信 / QQ 内置浏览器可能截断链接 &；建议系统浏览器与短链。'),
  bullet('Netlify Functions 免费额度按调用次数计；250ms 轮询短时够用，长时间挂机会消耗额度。'),
  bullet('当前没有 Netlify 后台 Token / CLI 登录：只能 push 触发自动构建并验证线上 URL/API，不能改环境变量、看构建日志或手动 deploy。'),
  bullet('演示账号 player1/player2 是公开的；真实 PAT / Token 不写进公开仓库；秘密.txt 已 gitignore。'),
  bullet('v3 别墅同场并置等历史未提交改动可能仍在工作区；提交前用 git status 甄别，不要 git add .。'),
  bullet('旧 WebSocket 服务端已移除；线上联机是短轮询，不是长连接，排障时不要按 WebSocket 思路查。'),
  h2('E', '文档维护清单'),
  bullet('唯一权威：项目信息.docx（由 scripts/generate-doc.js 生成）；docs/current-status.md 是现状基准。'),
  bullet('每次改代码：更新 status → 更新 generate-doc 对应表格 → npm run docs:handover → 复核 docx。'),
  bullet('不要手工改 docx；不要提交 秘密.txt；不要删除 .gitignore 里的忽略规则。'),
  bullet('提交前：git status；只 add 相关文件；push 后等 Netlify 构建并验证线上。'),
  bullet('文档版本 v2.2；封面 / 页眉 / 生成日志同步更新。'),

  divider(),
  p('文档结束。任何模型接手时：先读 00 的权威源优先级与 08 的十分钟阅读顺序，再动第一行代码。', { run: { color: C.muted, italics: true } }),
];

/* ---------------------------------------------------------------- 文档装配 */
const header = new Header({
  children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { after: 0 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 3 } },
    children: [run('PLAYGROUND-MVP  ·  项目信息  ·  v2.2  ·  2026-11-21', { size: 15, color: C.muted })],
  })],
});

const footer = new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: ['\t第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'],
    font: FONT, size: 15, color: C.muted,
  })],
});

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

/* ---------------------------------------------------------------- 09 联机 */
const multiplayer = [
  h1('09', '线上双人联机与单人游玩（2026-11-21）'),
  p('联机层是旁路能力：不改大厅、别墅与设施内部玩法，只新增登录页、联机客户端、Netlify Functions 房间接口与 Netlify Blobs 房间状态。交付目标从「本机两个窗口」改为「两台真实设备打开链接即可互相看见」，并保留完全离线的单人入口。'),
  h2('9.0', '一页速查（下一个模型先看这里）'),
  table(
    ['项', '值'],
    [
      kv('线上站点', 'https://chengshi1.netlify.app'),
      kv('GitHub 仓库', 'https://github.com/ZYH-bot761/playground-mvp（main 分支）'),
      kv('Netlify 站点名', 'chengshi1（已连接 GitHub，push main 自动构建）'),
      kv('构建 / 发布', 'npm run build → dist；Node 22；配置在 netlify.toml'),
      kv('房间接口', 'POST /api/room（netlify/functions/room.mjs）'),
      kv('房间存储', 'Netlify Blobs（自动配置，无需数据库）'),
      kv('演示账号', 'player1 / play1234（小星）；player2 / play1234（小月）'),
      kv('单人入口', 'https://chengshi1.netlify.app/ →「单人游玩（不联机）」'),
      kv('双人链接', '?u=player1&p=play1234&room=home / ?u=player2&p=play1234&room=home'),
      kv('项目文档', '项目信息.docx（v2.1，本 09 章）+ docs/current-status.md 3.10'),
      kv('真实密钥', '只放本机 秘密.txt（已 gitignore）；本文档只放演示账号'),
    ],
    [22, 78],
    { firstColBold: true, zebra: true },
  ),
  bullet('快速开始：两台设备各开一条双人链接 → 自动登录 → 点「进入游乐场」→ 大厅互相可见。'),
  bullet('单人：打开普通入口，点「单人游玩（不联机）」，不用账号也能进所有设施。'),
  bullet('换一局：两条链接的 room 改成同一个新值；不要一个人 home、一个人别的 room。'),
  bullet('改代码后：git push origin main → Netlify 自动构建 → 访问线上地址验证；后台管理需要 Netlify Token（见 9.7）。'),
  h2('9.1', '线上入口与演示账号'),
  table(
    ['账号', '密码', '昵称', '用途'],
    [
      ['player1', 'play1234', '小星', '第一台设备 / 第一个链接'],
      ['player2', 'play1234', '小月', '第二台设备 / 第二个链接'],
    ],
    [16, 18, 16, 50],
    { firstColBold: true, zebra: true },
  ),
  p('线上站点：https://chengshi1.netlify.app。链接打开后自动登录并停在开始页；两台设备必须使用同一个 room（缺省 home）。'),
  codeBlock([
    'https://chengshi1.netlify.app/?u=player1&p=play1234&room=home',
    'https://chengshi1.netlify.app/?u=player2&p=play1234&room=home',
    '',
    '# 只带账号的短链（密码手输，避免 & 被聊天软件截断）',
    'https://chengshi1.netlify.app/?u=player1',
    'https://chengshi1.netlify.app/?u=player2',
  ]),
  h2('9.2', '单人 / 组队两种入口'),
  bullet('单人游玩：登录页「单人游玩（不联机）」跳过账号与房间，直接进入开始页；所有游乐园设施照常可进，不需要队友。'),
  bullet('组队游玩：两个账号登录同一 room；大厅互相可见、位置 250ms 同步、顶部「一起回家」一起进别墅。'),
  bullet('设施入口：WASD 第一人称靠近按 E；orbit 俯瞰下把视线对准入口按 E（屏幕中心射线），或直接点 HUD 提示；手机点提示即可进入。'),
  h2('9.3', '设备与浏览器适配'),
  bullet('电脑 / 平板 / 苹果 / 鸿蒙统一响应式布局；触屏走虚拟摇杆与提示点击，不依赖物理键盘。'),
  bullet('登录输入框字号 16px，避免 iOS Safari 聚焦时自动放大；登录页支持分享链接自动登录与手动输入两种路径。'),
  bullet('首屏静态加载层：JS 未下载完就显示「正在加载游乐场…」；3D 初始化失败显示明确错误，不再白屏。'),
  bullet('手机首次加载慢来自资源体积与网络；建议用系统浏览器（Safari / Chrome）打开，微信/QQ 内置浏览器可能截断链接里的 & 参数。'),
  h2('9.4', '账号占用、接管与释放'),
  bullet('每次登录生成新 session；同账号后打开的设备接管，旧设备下一次 sync 收到 409 SESSION_REPLACED 后停止联机，不会两台设备互相踢。'),
  bullet('页面关闭 / 刷新时客户端 sendBeacon leave，服务端立即释放账号；异常退出由 15s TTL 兜底。'),
  bullet('因此 player1 / player2 可以在不同手机上反复使用；两人同时组队请各用一个账号。'),
  h2('9.5', '架构与免费额度'),
  bullet('前端静态托管在 Netlify；房间接口 netlify/functions/room.mjs（POST /api/room），状态存 Netlify Blobs；本地 dev 由 server/local-room-api.mjs 提供同协议内存实现。'),
  bullet('对局中 250ms 短轮询，未进入游戏或页面后台降到 1s；Netlify Functions 免费额度按调用次数计，短时游玩足够，长时间挂机会消耗额度。'),
  bullet('「一起回家」使用 sendBeacon 发信号，不等待响应；进入别墅的主线程卡顿不会导致信号丢失。'),
  h2('9.6', '部署链路：Git → Netlify'),
  bullet('本机 Git 已通过 Windows 凭据管理器登录（credential.helper=manager），可直接 commit/push；换电脑需重新登录 GitHub 或填 PAT。'),
  bullet('提交流程：git status → 只 git add 本次相关文件 → git commit -m "..." → git push origin main。不要 git add .，避免把截图、临时文件和 秘密.txt 带上。'),
  bullet('push 到 main 后，Netlify 自动执行 npm run build，发布 dist；netlify/functions/room.mjs 自动部署为 POST /api/room，Netlify Blobs 自动启用。'),
  bullet('Netlify 初次连接：app.netlify.com → Add new site → Import an existing project → GitHub → 选择 ZYH-bot761/playground-mvp → 分支 main → 构建 npm run build，发布 dist。'),
  bullet('如果 push 报 443 / 连接重置：等待 20~60 秒重试，或 git -c http.version=HTTP/1.1 push origin main；这不是代码错误。'),
  bullet('当前没有 Netlify 后台登录凭证 / CLI 登录：能靠 push 触发自动部署并验证线上 URL、API；改环境变量、看构建日志、手动 deploy 需要 Netlify Token。'),
  h2('9.7', '密钥、密码与本地秘密文件'),
  bullet('真实 GitHub PAT、Netlify Token、Netlify Site ID、MULTIPLAYER_SECRET 只放本机 D:/playground-mvp/秘密.txt；该文件已加入 .gitignore，不会上传 GitHub / Netlify。'),
  bullet('本文档（项目信息.docx）会提交到公开仓库，只写演示账号 player1 / player2 与密码 play1234，不写真实密钥。'),
  bullet('MULTIPLAYER_SECRET 默认 playground-online-demo-secret；生产建议在 Netlify 环境变量里改成随机值；改后旧 token 自动失效，重新登录即可。'),
  bullet('PAT 获取：GitHub → Settings → Developer settings → Personal access tokens；Netlify Token：User settings → Applications → Personal access tokens；Site ID：Site configuration → General。'),
  bullet('如果 token 泄露：立即在 GitHub / Netlify 撤销并重新生成；不要把 秘密.txt 发微信、截图，或改名后再提交。'),
  h2('9.8', '线上故障排查（按顺序）'),
  table(
    ['现象', '先检查', '处理'],
    [
      ['页面打不开 / 白屏', '普通入口是否 200；是否用系统浏览器', 'Safari / Chrome 打开、无痕、换网络；首屏应显示「正在加载游乐场…」'],
      ['看不到队友', 'room 是否完全一致；是否两个账号；对方是否已进入', '统一 room；player1 + player2；都点「进入游乐场」'],
      ['同账号提示被接管', '是否两台设备登录同一账号', '正常行为，后开优先；组队请各用一个账号'],
      ['登录接口 500', 'Netlify → Functions → room 日志', '检查 Blobs、accounts.mjs、MULTIPLAYER_SECRET；本地 npm run dev 复现'],
      ['按 E 不进项目', '当前是 WASD 还是 orbit', 'WASD 靠近按 E；orbit 把屏幕中心对准入口按 E；手机点 HUD 提示'],
      ['国内访问 Netlify 很慢', '网络 / 运营商', '换网络或系统浏览器；长期使用考虑国内可访问托管'],
    ],
    [22, 34, 44],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  h2('9.9', '交接代码地图与改动边界'),
  table(
    ['文件', '职责'],
    [
      ['src/components/login-screen.js', '登录页；单人入口；链接自动登录；iOS 输入字号'],
      ['src/net/multiplayer-client.js', '250ms 轮询；远端角色；HUD；session / leave；一起回家'],
      ['netlify/functions/room.mjs', '线上 POST /api/room（Functions v2 + Blobs）'],
      ['netlify/functions/_lib/room-core.mjs', '房间协议、token / session、leave、TTL、数据收敛'],
      ['netlify/functions/_lib/accounts.mjs', '演示账号（服务端校验，前端不打包密码）'],
      ['server/local-room-api.mjs', '本地 dev 同协议内存实现'],
      ['src/scenes/lobby-scene.js', 'orbit / WASD 设施入口 E、HUD 提示（只扩展入口判定）'],
      ['index.html', '静态首屏加载层；3D 初始化失败提示'],
      ['src/main.js', '登录页 / 联机层装配、onSkip、pagehide dispose / leave'],
    ],
    [38, 62],
    { firstColBold: true, zebra: true, size: 15 },
  ),
  bullet('修改边界：联机层不要抢相机 owner；不要改设施 / 别墅内部玩法；新增房间字段时同时改 room-core、客户端、测试。'),
  bullet('验收：npm run build；node tests/verify-multiplayer-server.mjs（10/10）；node tests/verify-multiplayer.mjs（需 dev server，8/8）；手机用系统浏览器。'),
  h2('9.10', '验收基线（2026-11-21）'),
  table(
    ['套件', '结果', '覆盖'],
    [
      ['npm run build', 'PASS', '164 模块；联机客户端与加载层进入生产构建'],
      ['verify-multiplayer-server', '10/10 PASS', '登录、双人同步、回家、同账号接管、leave 释放、过期清理、房间隔离'],
      ['verify-multiplayer', '8/8 PASS', '两个分享链接自动登录、互相可见、移动同步、一起回家、别墅内可见（本地与线上各跑一次）'],
      ['单人浏览器验收', '8/8 PASS', '单人入口、跳过联机、进入大厅、进入设施、退出、焦点、orbit 按 E 进入'],
    ],
    [30, 18, 52],
    { firstColBold: true, zebra: true, size: 15 },
  ),
];

const doc = new Document({
  creator: 'playground-mvp',
  title: '项目信息',
  subject: 'GTA 级微缩城市 · 工程交接与代码事实手册',
  description: 'v2.2：完整交接手册。新增 00.0 三分钟速懂、10 章任务手册与附录 B–E（文件索引/接口错误码/风险/文档维护），保留 09 联机与单人章节。',
  keywords: 'Three.js, Rapier, Vite, 微缩城市, 交接文档, 性能预算, Blender, IEmbeddedView',
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
      children: [
        ...summary, ...architecture, ...regions, ...systems, ...villa,
        ...blender, ...performance, ...verification, ...handover, ...multiplayer, ...tasks, ...appendix,
      ],
    },
  ],
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(OUT, buffer);

const stat = fs.statSync(OUT);
console.log('[项目信息.docx] 生成成功（v2.2 完整交接手册）');
console.log('  路径: ' + OUT);
console.log('  大小: ' + (stat.size / 1024).toFixed(1) + ' KB');
console.log('  章节: 00 摘要 / 01 架构 / 02 坐标与入口 / 03 系统 / 04 别墅 / 05 Blender / 06 红线 / 07 验收 / 08 接手 / 09 联机与单人 / 10 任务手册 / 附录 A–E');
console.log('  数据口径: 2026-11-21 · metropolis 236,381 tris · villa-shell 5,612 tris · car 3,444 tris');
