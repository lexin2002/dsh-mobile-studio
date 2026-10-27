// 斜杠指令菜单 ↔ 输入法互斥：网页侧只负责“什么时候收/还键盘”，
// 真正收键盘必须走原生 hideSoftInput（blur 会让官方菜单失焦关掉）。
//
// 2026-10-25 修了一版真 bug：旧实现靠 400ms setInterval + commandMenuBox() 复位状态，
// 而那个判据的文案（压缩/模型）在斜杠菜单里根本不存在 —— 结果每敲一个字都重收一次键盘。
// 这里的断言因此改成「锁只由数据复位、合成中不收、定时器不许出现」，并新增反例断言。
import fs from 'node:fs';

let fail = 0;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const has = (name, text, needle) => {
  const ok = text.includes(needle);
  if (!ok) { fail++; console.log('FAIL', name, '缺少:', needle); }
  else console.log('ok', name);
};
const hasNot = (name, text, needle) => {
  const ok = !text.includes(needle);
  if (!ok) { fail++; console.log('FAIL', name, '不该出现:', needle); }
  else console.log('ok', name);
};

const mobile = read('../mobile/mobile.js');
const css = read('../mobile/mobile.css');
const bridge = read('../android/src/com/lexin/dshmobile/ShellBridge.java');
const main = read('../android/src/com/lexin/dshmobile/MainActivity.java');

// ---- 状态锁：只由数据复位 ----
has('有斜杠锁', mobile, 'let slashLatch = false');
has('锁可被闸门计数', mobile, 'window.__msImeHides');
has('合成中绝不收键盘', mobile, "if (e.isComposing || e.inputType === 'insertCompositionText') return;");
has('内容不再以斜杠开头才解锁', mobile, "if (!text.startsWith('/')) {");
has('已锁过就不重复收', mobile, 'if (slashLatch) return;');
has('焦点真离开才解锁', mobile, "document.addEventListener('focusout', (e) => {");
// 旧实现的定时器复位必须删干净：它是“每字收一次键盘”的根因
hasNot('斜杠状态不许用定时器复位', mobile, "if (commandMenuBox()) return;\n    slashIme = false;");
hasNot('旧布尔状态已删除', mobile, 'let slashIme = false');

// ---- 还键盘 / 弹窗项让路 ----
has('只在输入框里判断', mobile, 'if (!isComposerEditor(el)) return');
has('网页调原生收键盘', mobile, 'window.Shell.hideKeyboard');
has('网页调原生还键盘', mobile, 'window.Shell.showKeyboard');
has('点击菜单才恢复', mobile, "onClickCapture('slash-ime-restore'");
has('弹窗项不抢键盘', mobile, 'menuItemOpensDialog');

// ---- 菜单几何夹取（被键盘压掉的另一半） ----
has('菜单几何由 JS 量', mobile, 'function syncSlashGeom()');
has('夹取标记', mobile, "root.setAttribute(SLASH_ATTR, '1')");
has('CSS 有夹取规则', css, "[data-ms-slash='1']");
has('CSS 不写死坐标', css, 'bottom: var(--ms-slash-bottom');

// ---- 通知深链入口 ----
has('网页有深链入口', mobile, 'window.__msOpenSession');
has('深链认官方行属性', mobile, "[data-row-key]");
has('找不到会话只开抽屉', mobile, "reportDiag('deeplink-miss'");

// ---- 版本 ----
has('版本号已更新', mobile, "window.__msVersion = '2026-10-27/r16'");

// ---- 原生桥 ----
has('桥有 hideKeyboard', bridge, 'public void hideKeyboard()');
has('桥有 showKeyboard', bridge, 'public void showKeyboard()');
has('桥只在工作台生效', bridge, 'if (host.inShellMode()) return;');
has('原生收键盘', main, 'void hideImeForWeb()');
has('原生还键盘', main, 'void showImeForWeb()');
has('收键盘不 blur', main, 'imm.hideSoftInputFromWindow(web.getWindowToken(), 0)');
has('还键盘用 showSoftInput', main, 'imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT)');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
