// 齿轮新逻辑回归：从 shipped 的 mobile.js 里抽出 openAppSetup 真跑三遍。
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../mobile/mobile.js', import.meta.url), 'utf8');
const m = src.match(/function openAppSetup\(\) \{[\s\S]*?\n  \}/);
if (!m) { console.log('FAIL openAppSetup not found'); process.exitCode = 1; }
else {
  let fail = 0;
  const run = (name, shell, wantRet, wantCalled) => {
    let called = false;
    const window = { Shell: shell ? { openSetup: () => { called = true; } } : undefined };
    if (shell === 'no-method') window.Shell = {};
    const fn = new Function('window', m[0] + '\nreturn openAppSetup();');
    let ret = null;
    try { ret = fn(window); } catch (e) { console.log('FAIL', name, 'threw', e.message); fail += 1; return; }
    const ok = ret === wantRet && called === wantCalled;
    console.log(ok ? 'ok  ' : 'FAIL', name, 'ret=' + ret, 'called=' + called);
    if (!ok) fail += 1;
  };
  run('bridge present -> calls openSetup', true, true, true);
  run('no bridge (desktop browser) -> silent false', false, false, false);
  run('bridge without method -> silent false', 'no-method', false, false);
  // 接线：齿轮点击确实调的是 openAppSetup，且旧的网页设置逻辑已删干净
  const gearCall = /g\.addEventListener\('click', \(e\) => \{\s+e\.preventDefault\(\);\s+e\.stopPropagation\(\);\s+openAppSetup\(\);/;
  console.log(gearCall.test(src) ? 'ok   gear wired to openAppSetup' : 'FAIL gear wiring');
  if (!gearCall.test(src)) fail += 1;
  for (const dead of ['function openSettings(', 'function settingsItem(', 'function accountTrigger(']) {
    const gone = !src.includes(dead);
    console.log(gone ? 'ok   removed ' + dead : 'FAIL still present ' + dead);
    if (!gone) fail += 1;
  }
  console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
  process.exitCode = fail === 0 ? 0 : 1;
}
