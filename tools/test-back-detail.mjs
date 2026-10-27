// 工具二级/三级详情页返回回归（静态）。
//
// 真机 bug：技能中枢详情（dsh-curator）的返回是纯文本 .ss-back（无 aria），
// 自动化任务详情是关闭 X（aria=关闭）—— 老的第 5 层只认 aria/title 且必须
// 以「返回」开头，两个都漏 → 掉进第 6 层直接回会话。
//
// 这里不跑 DOM（仓库没有 jsdom/playwright 依赖），只把 mobile.js 里这段
// 判据的**形状**钉死；真实页面行为由 browser-harness 的无头 Chrome 探针验。
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../mobile/mobile.js', import.meta.url), 'utf8');

let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, extra);
  }
};

// 只截 __msBack 到「回到最近一次会话」之间，避免命中文件别处的同名变量。
const start = src.indexOf('window.__msBack = () =>');
const end = src.indexOf('function returnToLastSession');
const back = start >= 0 && end > start ? src.slice(start, end) : '';

check('找到 __msBack 实现', back.length > 2000, `len=${back.length}`);
check('版本号是 2026-10-24 之后的构建（返回逻辑已随版本发布）', /__msVersion = '2026-10-(2[4-9]|3\d)\/[^']+'/.test(src));

// ---- 名称来源：aria / title / 文本 ----
check(
  '控制名同时读 aria-label、title、innerText',
  /getAttribute\('aria-label'\)[\s\S]{0,80}getAttribute\('title'\)[\s\S]{0,80}innerText/.test(back),
);
check('控制名压缩空白', /\.replace\(\/\\s\+\/g, ' '\)[\s\S]{0,40}\.trim\(\)/.test(back));

// ---- 返回判据 ----
check(
  '返回判据允许 ‹ / ← / < 前缀',
  /isBackName = \(s\) => \/\^\[‹<←\\s\]\*\(返回\|后退\|back\\b\|go back\)\/i\.test\(s\)/.test(back),
);
check('返回判据以「返回」开头而不是包含', /isBackName[\s\S]{0,120}\^/.test(back) && /返回\|后退/.test(back));
check('返回候选只取 button / role=button（不碰正文 a）', /querySelectorAll\('button, \[role="button"\]'\)/.test(back));
check('返回/关闭候选限制在页头 top < 220', /getBoundingClientRect\(\)\.top < 220/.test(back));

// ---- 详情关闭判据 ----
check('有关闭分支', /isCloseName = \(s\) => \/\^\(关闭\|close\|关闭详情\|关闭面板\)\$\/i\.test\(s\)/.test(back));
check('关闭只认 detail 容器内', /closest\('\[class\*="detail"\], \[class\*="Detail"\]'\)/.test(back));
check('关闭分支在返回分支之后、第 6 层之前', back.indexOf('const closeBtn') > back.indexOf('const backBtn'));
check('关闭分支只认精确「关闭/Close」', !/isCloseName[\s\S]{0,80}收起右侧边栏/.test(back));

// ---- 打点与层级顺序 ----
check('命中记录 __msBackHit（back/close）', /__msBackHit =\s*'back:/.test(back) && /__msBackHit =\s*'close:/.test(back));
check('每次按键先清 __msBackHit', /window\.__msBackHit = ''/.test(back));
check(
  '第 6 层仍在页内返回之后',
  back.indexOf('returnToLastSession()') > back.indexOf('const closeBtn'),
);
check('右栏收起仍只认「收起右侧边栏」', /button\[aria-label="收起右侧边栏"\]/.test(back));
check('面板首页仍走第 6 层回会话', /if \(!document\.querySelector\('\[class\*="_card"\]'\) \|\| foreignOverlay\(\)\)/.test(back));

// ---- 点不了的不认（2026-10-27 右栏网页：disabled 的"后退"被连点 10 次，毫无反应） ----
check('有 clickable 守卫', /const clickable = \(el\) =>/.test(back));
check('disabled 按钮跳过', /el\.disabled\s*\?\s*'dis:'/.test(back));
check('aria-disabled=true 按钮跳过', /aria-disabled/.test(back));
check('跳过的记进 __msBackSkip', /window\.__msBackSkip \+=/.test(back));
check('返回/关闭只在可点的里找', /clickables\.find/.test(back) && /const clickables = topControls\.filter\(clickable\)/.test(back));
check('收起键也要过 clickable', /inView\(el\) && clickable\(el\)/.test(back));
check('back 诊断带 skip 字段', /sk: String\(window\.__msBackSkip/.test(back));
check('点击记录带按钮路径', /pathOf\(backBtn\)/.test(back) && /pathOf\(rbClose\)/.test(back));

if (fail) {
  console.log(`\n${fail} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
