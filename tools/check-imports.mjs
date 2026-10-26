// 语法/导入检查：逐个 import，报告首个错误。
const files = ['../auth.js', '../mobile-filter.js', '../lan.js', '../index.js'];
let bad = 0;
for (const f of files) {
  try {
    await import(f);
    console.log('OK  ', f);
  } catch (e) {
    bad += 1;
    console.log('ERR ', f, e && e.message);
  }
}
console.log(bad === 0 ? 'ALL IMPORT OK' : bad + ' FAILED');
process.exitCode = bad === 0 ? 0 : 1;
