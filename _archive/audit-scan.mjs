/**
 * 一次性盘点工具：扫描工程目录，解析所有 import / 动态 import / 资源字符串，
 * 生成「文件 → 判定（引用中 / 未被引用 / 构建产物 / 临时垃圾）」报告。
 * 仅读取，不修改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp-blender', '.tmp-t07', '.tmp-pkg-inspect', '.arts', '.workbuddy', '.codeartsdoer']);
const CODE_EXT = new Set(['.js', '.mjs', '.ts', '.html', '.css', '.json', '.bat', '.py']);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

const files = walk(ROOT).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
const srcFiles = files.filter((f) => f.startsWith('src/') && f.endsWith('.js'));

// 收集所有文本文件中出现的路径线索
const codeFiles = files.filter((f) => CODE_EXT.has(path.extname(f)));
const allText = new Map();
for (const f of codeFiles) {
  try { allText.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { /* noop */ }
}

// 解析静态/动态 import 与字符串资源路径
const referenced = new Map(); // file -> [{by, raw}]
const note = (target, by, raw) => {
  if (!referenced.has(target)) referenced.set(target, []);
  referenced.get(target).push({ by, raw });
};

for (const [file, text] of allText) {
  const re = /(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    if (!raw.startsWith('.')) continue;
    const abs = path.resolve(path.dirname(file), raw);
    let rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    // 无扩展名时补 .js
    if (!path.extname(rel)) rel += '.js';
    note(rel, file, raw);
  }
  // /src/... 形式的浏览器绝对路径（测试脚本 route / import）
  const re2 = /['"`](\/src\/[^'"`]+)['"`]/g;
  while ((m = re2.exec(text))) note(m[1].replace(/^\//, ''), file, m[1]);
  // 资源文件名
  const re3 = /['"]([^'"]*\.(?:glb|gltf|png|jpe?g|svg|task|wasm|mp3|ogg|wav|hdr|json|html))['"]/g;
  while ((m = re3.exec(text))) {
    const raw = m[1];
    const base = path.basename(raw);
    for (const f of files) if (path.basename(f) === base) note(f, file, raw);
  }
}

// 分类
const categories = { referenced: [], orphan: [], build: [], temp: [], docs: [], config: [], other: [] };
const classify = (f) => {
  if (f === 'dist' || f.startsWith('dist/')) return 'build';
  if (/^\./.test(f) || /\.log$/.test(f) || /^\.tmp/.test(f) || f.startsWith('_archive/')) return 'temp';
  if (/^docs\//.test(f) || /^zoo\//.test(f) || f === 'HANDOVER.md' || f === 'v3_spec.txt' || /\.(docx|txt|md|mermaid)$/i.test(f)) return 'docs';
  if (/^(package\.json|package-lock\.json|pnpm-lock\.yaml|index\.html|vite\.config\.js|\.gitignore|README\.md|LICENSE)$/.test(f)) return 'config';
  if (f.startsWith('src/') && f.endsWith('.js')) return referenced.has(f) ? 'referenced' : 'orphan';
  if (f.startsWith('src/assets/') || f.startsWith('public/') || f.startsWith('assets/')) return referenced.has(f) ? 'referenced' : 'orphan';
  if (f.startsWith('tests/')) return referenced.has(f) ? 'referenced' : 'docs';
  return 'other';
};
for (const f of files) categories[classify(f)].push(f);

const stat = (f) => { try { return fs.statSync(path.join(ROOT, f)).size; } catch { return 0; } };
const tree = (list) => list.map((f) => `${f} (${stat(f)}B)`).join('\n');

const md = [
  '# 目录盘点报告（阶段 1）',
  '',
  `> 生成时间：${new Date().toISOString()} · 扫描文件数：${files.length}（已排除 node_modules / .git / dist / 临时缓存目录）`,
  '',
  '## 判定依据',
  '',
  '- **引用中**：在任一 .js/.mjs/.html/.css/.json/.bat/.py 中出现静态 `from`/`import()` 相对路径、`/src/...` 绝对路径或资源文件名字符串。',
  '- **未被引用**：全仓无任何 import 或字符串引用（孤立资源 / 死代码）。',
  '- **构建产物**：dist/ 下由 vite build 生成，.gitignore 已排除。',
  '- **临时垃圾**：隐藏缓存目录、`.tmp*` 前缀脚本、`.log`、npm pack 解包残留、IDE 索引库。',
  '- **文档/证据**：docs/ 下设计说明与截图证据、zoo/ 下 Blender 源与验收、根目录 md/docx/txt 规格。',
  '- **配置**：package.json、锁文件、index.html、vite.config.js、.gitignore。',
  '',
  '## 分类汇总',
  '',
  ...Object.entries(categories).map(([k, v]) => `- ${k}: ${v.length}`),
  '',
  '## 引用中（含引用来源）',
  '```',
  ...categories.referenced.map((f) => `${f}  <- ${(referenced.get(f) || []).map((r) => r.by).slice(0, 3).join(', ')}`),
  '```',
  '',
  '## 未被引用（孤立）',
  '```',
  tree(categories.orphan),
  '```',
  '',
  '## 临时垃圾',
  '```',
  tree(categories.temp),
  '```',
  '',
  '## 构建产物',
  '```',
  tree(categories.build),
  '```',
  '',
  '## 文档/证据',
  '```',
  tree(categories.docs),
  '```',
  '',
  '## 配置',
  '```',
  tree(categories.config),
  '```',
  '',
  '## 其它',
  '```',
  tree(categories.other),
  '```',
  '',
].join('\n');

fs.writeFileSync(path.join(ROOT, 'docs/directory-audit.md'), md);
console.log('scanned', files.length, 'files');
for (const [k, v] of Object.entries(categories)) console.log(k, v.length);
console.log('\n=== ORPHAN ===\n' + categories.orphan.join('\n'));
console.log('\n=== TEMP ===\n' + categories.temp.join('\n'));
console.log('\n=== OTHER ===\n' + categories.other.join('\n'));
