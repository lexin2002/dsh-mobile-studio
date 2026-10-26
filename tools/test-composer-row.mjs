// 输入框工具条换行回归（静态）。
//
// 现场：计划模式 + 技能按钮同时出现时，「计划」药丸盖在「技能」按钮上。
// 根因是 mobile.css 里 `RlGAzG_row { flex-wrap: nowrap }` + 默认 shrink：
// 左组 218px、右组 156px，一行装不下，中间 .modes 被压到 54px，计划药丸溢出。
//
// 2026-10-25 更新：选择器已从构建哈希类名迁到 data-ms-c 本地名
// （`[data-ms-c~='row']` / `:is([data-ms-c~='tools'], …)`）。断言同时认两种写法，
// 避免以后再迁锚点时这份测试变成"假红"。
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../mobile/mobile.css', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../mobile/mobile.js', import.meta.url), 'utf8');

let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, extra);
  }
};

// 极简 CSS 规则切分：本项目没有嵌套 at-rule，够用。
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  sel: m[1].replace(/\s+/g, ' ').trim(),
  body: m[2].replace(/\s+/g, ' ').trim(),
}));

// 锚点两种写法都认：旧的 [class*='_row'] 和新的 [data-ms-c~='row']
const names = (local) => [`[class*='_${local}']`, `[data-ms-c~='${local}']`];
const selHas = (sel, local) => names(local).some((n) => sel.includes(n));
const someRule = (local, prop) => rules.some((r) => selHas(r.sel, local) && new RegExp(prop).test(r.body));

check('找到工具条 row 规则', rules.some((r) => selHas(r.sel, 'row')));
check('工具条允许整行换行', someRule('row', 'flex-wrap:\\s*wrap'));
check('工具条不再有 nowrap', !someRule('row', 'flex-wrap:\\s*nowrap'));
check(
  '左右两组都不压缩（flex: 0 0 auto）',
  rules.some(
    (r) =>
      selHas(r.sel, 'tools') &&
      selHas(r.sel, 'trailing') &&
      selHas(r.sel, 'modes') &&
      /flex:\s*0 0 auto/.test(r.body),
  ),
);
check('工具组内部可换行', someRule('tools', 'flex-wrap:\\s*wrap'));
check('工具组有卡片宽度上限（不会顶出屏幕）', someRule('tools', 'max-width:\\s*100%'));
check('模式组内部可换行', someRule('modes', 'flex-wrap:\\s*wrap'));
check('换行间距 6px', someRule('row', 'row-gap:\\s*6px'));
check(
  '规则都在 mobile 作用域内',
  rules.filter((r) => selHas(r.sel, 'row') || selHas(r.sel, 'tools')).every((r) => r.sel.includes('html[data-ms-mobile]')),
);
check('版本号已更新', /__msVersion = '2026-10-\d{2}\/[A-Za-z0-9.-]+'/.test(js));

if (fail) {
  console.log(`\n${fail} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
