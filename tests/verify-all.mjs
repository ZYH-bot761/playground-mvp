/**
 * ============================================================================
 * tests/verify-all.mjs —— 联合回归门禁（阶段 5 工程底座）
 * ============================================================================
 * 一次跑全核心验收套件，任一失败整体非零退出，适合 CI / 交接门禁。
 * 各子脚本独立启动浏览器、串行执行，避免 headless SwiftShader 抢资源假阴性。
 *
 * 用法：
 *   node tests/verify-all.mjs                       # 全套
 *   node tests/verify-all.mjs --only camera,redline # 只跑指定套件（逗号分隔）
 *   PORT=5173 node tests/verify-all.mjs             # 指定 dev server 端口
 *
 * 前置：dev server 已在 PORT 运行（npm run dev）。
 * ============================================================================
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = process.env.PORT || 5173;
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx >= 0 && process.argv[onlyIdx + 1]
  ? new Set(process.argv[onlyIdx + 1].split(',').map((s) => s.trim()))
  : null;

/** 核心套件：name → { file, args, marker 判据 } */
const SUITES = [
  { name: 'build',        label: '生产构建',        file: null, cmd: 'npm', args: ['run', 'build'], marker: /built in/ },
  { name: 'camera',       label: '相机写者契约',    file: 'verify-camera-contract.mjs', marker: /allPass=true/ },
  { name: 'redline',      label: '工程红线 8 项',   file: 'verify-redline.mjs', args: ['BASE'], marker: /allPass=true/ },
  { name: 'v4',           label: 'v4 全量 13 项',   file: 'verify-v4.mjs', marker: /"FAIL": 0/ },
  { name: 'season',       label: '四季天气 16 项',  file: 'verify-season.mjs', marker: /allPass=true/ },
  { name: 'driving',      label: 'GTA 驾驶 21 项',  file: 'verify-driving.mjs', marker: /allPass=true/ },
  { name: 'drive-roam',   label: '漫游↔驾驶集成 7 项', file: 'verify-drive-roam.mjs', marker: /allPass=true/ },
  { name: 'villa',        label: '可进入别墅 10 项', file: 'verify-villa.mjs', marker: /allPass=true/ },
  { name: 'phase2',       label: '生态扩张 20 项',  file: 'verify-phase2.mjs', marker: /allPass=true/ },
  { name: 'm6zoo',        label: '动物园回归 8 项', file: 'verify-m6-zoo.mjs', marker: /allPass=true/ },
];

function runSuite(suite) {
  return new Promise((resolve) => {
    const args = suite.file
      ? [`tests/${suite.file}`, ...(suite.args || [])]
      : suite.args;
    const proc = spawn(suite.cmd || 'node', args, {
      cwd: process.cwd(),
      env: { ...process.env, PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (b) => { out += b.toString(); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', (code) => {
      const hasMarker = suite.marker.test(out);
      const hasFailLine = /(^|\n)FAIL\s/.test(out) || /\b[1-9]\d*\s+FAIL\b/.test(out);
      const pass = code === 0 && hasMarker && !hasFailLine;
      resolve({ suite, pass, code, hasMarker, hasFailLine, tail: out.trim().split('\n').slice(-4).join(' | ') });
    });
    proc.on('error', (err) => resolve({ suite, pass: false, code: -1, hasMarker: false, hasFailLine: false, tail: String(err) }));
  });
}

const selected = only ? SUITES.filter((s) => only.has(s.name)) : SUITES;
if (selected.length === 0) {
  console.error(`--only 未匹配任何套件：${[...only].join(',')}`);
  console.error('可选：' + SUITES.map((s) => s.name).join(', '));
  process.exit(2);
}

console.log(`=== 联合回归：${selected.length} 套件（PORT=${PORT}）===\n`);
const results = [];
for (const suite of selected) {
  process.stdout.write(`[${suite.label}] 运行中… `);
  const r = await runSuite(suite);
  results.push(r);
  console.log(r.pass ? 'PASS' : 'FAIL');
  if (!r.pass) console.log(`   ↳ exit=${r.code} marker=${r.hasMarker} failLine=${r.hasFailLine}\n   ↳ ${r.tail}`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== 联合回归汇总：${passed}/${results.length} 套件通过 ===`);
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.suite.label} (${r.suite.name})`);
process.exit(passed === results.length ? 0 : 1);
