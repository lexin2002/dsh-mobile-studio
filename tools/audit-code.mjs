// 代码健康度体检：死代码 / 重复 / 监听器 / 补丁密度
import fs from 'node:fs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const jsPath = args[0] || 'mobile/mobile.js';
const cssPath = args[1] || 'mobile/mobile.css';
const js = fs.readFileSync(jsPath, 'utf8');
const cssRaw = fs.readFileSync(cssPath, 'utf8');
// 统计前先去掉注释：注释里写「!important」不该算进指标（踩过：解释性注释把计数抬高了 3）
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

const out = {};

// ---------- 1. 函数定义与引用 ----------
const defs = new Map();
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
  defs.set(m[1], (defs.get(m[1]) || 0) + 1);
}
for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) {
  defs.set(m[1], (defs.get(m[1]) || 0) + 1);
}
const dead = [];
const fewUse = [];
for (const [name, defCount] of defs) {
  const refs = (js.match(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g')) || []).length;
  if (refs <= defCount) dead.push(name);
  else if (refs === defCount + 1) fewUse.push(`${name}(${refs})`);
}
out['函数总数'] = defs.size;
out['疑似死代码'] = dead;
out['只被引用一次'] = fewUse;

// ---------- 2. 同名重复定义 ----------
out['重复定义'] = [...defs.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);

// ---------- 3. 监听器按类型 ----------
const ev = {};
for (const m of js.matchAll(/addEventListener\(\s*'([^']+)'/g)) ev[m[1]] = (ev[m[1]] || 0) + 1;
out['监听器按事件'] = ev;
out['监听器总数'] = Object.values(ev).reduce((a, b) => a + b, 0);
// 门禁只卡 document 级 click（元素级点自己造的节点是既定做法，三格/收纳都这么干）。
// 计数前先去注释：注释里的示例代码（"以前散落着 7 个 document.addEventListener('click')"）
// 也会被正则命中，白白占一个名额（2026-10-21 实测总数虚高 1 就是这么来的）。
const jsNoComments = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\S:])\/\/[^\n]*/g, '$1');
const docClick = (jsNoComments.match(/document\.addEventListener\(\s*'click'/g) || []).length;
out['document 级 click 监听'] = docClick;

// ---------- 4. 定时器 ----------
const intervals = [...js.matchAll(/setInterval\([^,]*,\s*(\d+)\)/g)].map((m) => m[1]);
out['setInterval 周期'] = intervals;

// ---------- 5. 补丁气味 ----------
out['console 残留'] = (js.match(/console\.(log|warn|debug)/g) || []).length;
out['临时/补丁类注释'] = (js.match(/(临时|补丁|hack|兜底|workaround)/gi) || []).length;
out['!important'] = (css.match(/!important/g) || []).length;

// ---------- 6. 重复代码块（连续 6 行完全相同，出现 2 次以上） ----------
const norm = js.split('\n').map((l) => l.trim());
const seen = new Map();
for (let i = 0; i + 6 <= norm.length; i++) {
  const block = norm.slice(i, i + 6).join('\n');
  if (block.replace(/\s/g, '').length < 80) continue;
  if (!seen.has(block)) seen.set(block, []);
  seen.get(block).push(i + 1);
}
const dupBlocks = [...seen.entries()]
  .filter(([, lines]) => lines.length > 1)
  .map(([block, lines]) => ({ lines, head: block.split('\n')[0].slice(0, 60) }));
out['重复代码块数'] = dupBlocks.length;
out['重复代码块样本'] = dupBlocks.slice(0, 5);

// ---------- 7. CSS 里引用但 JS 里已不存在的类 ----------
const cssClasses = new Set();
for (const m of css.matchAll(/\.(ms-[a-z0-9-]+)/g)) cssClasses.add(m[1]);
const orphanClasses = [...cssClasses].filter((c) => !js.includes(c));
out['CSS 中我们自己的类数'] = cssClasses.size;
out['JS 里已不用的类'] = orphanClasses;

// ---------- 8. 每条规则的 !important 密度 ----------
const rules = css.split('}').filter((r) => r.includes('{'));
const hotRules = rules
  .map((r) => ({
    sel: r.split('{')[0].trim().slice(0, 70),
    imp: (r.match(/!important/g) || []).length,
  }))
  .filter((r) => r.imp >= 2)
  .sort((a, b) => b.imp - a.imp)
  .slice(0, 8);
out['高 !important 规则'] = hotRules;

console.log(JSON.stringify(out, null, 2));

// ---------- 9. 门禁模式 ----------
// 阈值原则：只卡「会随官方升级断掉」和「会自己越长越大」的东西，
// 不卡行数（行数不是罪，重复和耦合才是）。
if (process.argv.includes('--check')) {
  const limits = {
    // 13 = 12 + 「+ 菜单里三格的高度上限」：官方给 Z9Jnlq_menu 写了**内联**
    // max-height（随视口 307.5/400px 变化），内联优先级高过任何选择器，
    // 不用 !important 就压不下来，键盘开着时菜单会顶出屏幕、三格被挤到顶端。
    // 作用域只有手机端 + data-ms-rack=1，官方菜单关掉即失效。
    important: { max: 13, value: out['!important'], hint: '只允许保命型覆盖（布局骨架 / 键盘链 / iOS 字号）；新增前先证明非它不可' },
    dupBlocks: { max: 5, value: out['重复代码块数'], hint: '复制粘贴前先抽公共函数' },
    deadFns: { max: 0, value: out['疑似死代码'].length, hint: '删掉零引用的函数' },
    dupDefs: { max: 0, value: out['重复定义'].length, hint: '同名定义会被后一个覆盖，必删' },
    consoleLeft: { max: 0, value: out['console 残留'], hint: '调试输出不许进主干' },
    clickListeners: { max: 2, value: out['document 级 click 监听'], hint: 'document 级点击必须走 onClickCapture/onClickBubble 分发器（元素级点自己节点不计）' },
  };
  let failed = false;
  console.log('\n== 门禁 ==');
  for (const [name, l] of Object.entries(limits)) {
    const ok = l.value <= l.max;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${l.value} (上限 ${l.max})${ok ? '' : '  → ' + l.hint}`);
  }
  if (failed) process.exitCode = 1;
}
