// 闸 1：CSS 锚点纪律。禁止构建哈希前缀、禁止过宽子串选择器；
// 另外把「契约里不推荐但历史遗留还在用」的三类单独列出来（默认只告警，--strict 才失败）。
//
// 用法：node tools/check-css-anchors.mjs [文件...] [--strict]
// 无参数时检查 mobile/*.css（mobile.premigrate.css 除外）。
// 为什么分「拦」和「警告」：
//   构建哈希前缀 / 过宽子串是**必然**失效且会炸全页，必须拦；
//   类名子串（[class*='_x']）和中文文案属于「能跑但脆」，历史遗留还有，
//   一刀切会让闸变红从而没人再看，所以默认只统计，写新规则时看这个数字。
import fs from 'node:fs';
import path from 'node:path';

const STARTS = ['--strict'];
const argv = process.argv.slice(2);
const strict = argv.some((a) => STARTS.includes(a));
const files = argv.filter((a) => !STARTS.includes(a));

const ROOT = path.resolve(process.cwd(), 'mobile');
const SKIP = new Set(['mobile.premigrate.css']);

const targets = files.length
  ? files
  : fs
      .readdirSync(ROOT)
      .filter((f) => f.endsWith('.css') && !SKIP.has(f))
      .map((f) => path.join(ROOT, f));

// 构建哈希前缀：4-10 位大小写数字 + 下划线，出现在 [class*= / [class~= 里
const HASH = /\[class[~*]?=["']?[A-Za-z0-9][A-Za-z0-9-]{3,9}_/;
// 过宽子串：匹配空本地名，会命中全页
const TOO_WIDE = /\[class[*~]=["']_/;
// C 级：官方类名子串（依赖 CSS Modules 本地名，重构就没）
const CLASS_SUBSTR = /\[class[*~]?=["']?[A-Za-z0-9-]*_[A-Za-z]/;
// D 级：选择器里直接写中文（aria 文案 / 可见文案）
const CJK_VALUE = /\[(?:aria-label|title|placeholder)[*^$~|]?=["'][^"']*[\u4e00-\u9fa5][^"']*["']\]/;

const problems = [];
const warnings = [];
const stats = [];

for (const file of targets) {
  const raw = fs.readFileSync(file, 'utf8');
  // 去掉注释再判断，注释里提到旧前缀不算问题
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...code.matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let hash = 0;
  let wide = 0;
  let slotAnchored = 0;
  let tokenAnchored = 0;
  let classSubstr = 0;
  let cjk = 0;
  let tokenUnscoped = 0;

  for (const sel of selectors) {
    if (HASH.test(sel)) {
      hash++;
      problems.push([file, 'build-hash', sel]);
    }
    if (TOO_WIDE.test(sel)) {
      wide++;
      problems.push([file, 'too-wide', sel]);
    }
    if (/data-slot/.test(sel)) slotAnchored++;
    if (/data-ms-c/.test(sel)) {
      tokenAnchored++;
      // 契约要求 data-ms-c 必须配槽位限定作用域，否则同名 token 会跨组件串。
      // header/等结构限定也算"限定了"，只挑那种整个选择器里没有任何父级限定的。
      const scoped = /data-slot|data-ms-c~=['"][^'"]+['"]\s|header|\bhtml\[|\[data-ms-(?:drawer|rb|search|tight|kb|attach)/.test(sel);
      if (!scoped) {
        tokenUnscoped++;
        warnings.push([file, 'token-unscoped', sel]);
      }
    }
    if (CLASS_SUBSTR.test(sel) && !/data-ms-|\.ms-/.test(sel)) {
      classSubstr++;
      warnings.push([file, 'class-substr', sel]);
    }
    if (CJK_VALUE.test(sel)) {
      cjk++;
      warnings.push([file, 'cjk-aria', sel]);
    }
  }
  stats.push({
    file: path.basename(file),
    rules: selectors.length,
    hash,
    wide,
    slotAnchored,
    tokenAnchored,
    classSubstr,
    cjk,
    tokenUnscoped,
  });
}

console.log('文件                 规则  哈希  过宽  槽位  token  类名子串  中文文案  token未限定');
for (const s of stats) {
  console.log(
    `${s.file.padEnd(20)} ${String(s.rules).padStart(4)} ${String(s.hash).padStart(5)} ${String(s.wide).padStart(5)} ${String(s.slotAnchored).padStart(5)} ${String(s.tokenAnchored).padStart(6)} ${String(s.classSubstr).padStart(10)} ${String(s.cjk).padStart(9)} ${String(s.tokenUnscoped).padStart(12)}`,
  );
}

if (problems.length) {
  console.log('\n❌ 违规选择器（必然失效 / 会炸全页）：');
  for (const [f, kind, sel] of problems) console.log(`  [${kind}] ${path.basename(f)}: ${sel.slice(0, 120)}`);
  console.log(`\n共 ${problems.length} 处。构建哈希前缀会在 DSH 每次重新构建后静默失效；过宽子串会命中全页。`);
  process.exit(1);
}

if (warnings.length) {
  const tag = strict ? '❌' : '⚠️';
  console.log(`\n${tag} 契约告警 ${warnings.length} 处（${strict ? '--strict 下视为失败' : '不失败，但写新规则时别再加'}）：`);
  const byKind = warnings.reduce((m, [, k]) => ((m[k] = (m[k] || 0) + 1), m), {});
  console.log('  分类：' + Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join('  '));
  for (const [f, kind, sel] of warnings.slice(0, 12)) console.log(`  [${kind}] ${path.basename(f)}: ${sel.slice(0, 110)}`);
  if (warnings.length > 12) console.log(`  …另有 ${warnings.length - 12} 处，见 docs/ANCHOR-AUDIT.md 的清单`);
  console.log('\n  说明：class-substr 命中官方类名本地名（官方重构就失效）；cjk-aria 靠中文文案定位；');
  console.log('        token-unscoped 是 data-ms-c 没带父级限定，同名 token 可能串到别的组件。');
  if (strict) process.exit(1);
}

console.log('\n✅ 没有构建哈希前缀，也没有过宽子串选择器。');
