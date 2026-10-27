// App 侧"自愈"结构的静态检查（0.9.4）。
//
// 背景：用户报「电脑端没起来 → 手机白屏 → 左栏打不开 → 设置打不开 → 无法刷新/改地址」，
// 以及「扫码不包含密码还要自己输密码」。查下来不是某一行写错，而是**恢复入口全部
// 寄生在网页上**：网页一坏，出口就一起没了；登录页还把悬浮球藏了。
//
// 这个测试锁住改造后的结构约束：
//   1. 恢复入口/健康判定必须在原生（探针、横幅、常驻悬浮球）；
//   2. 登录页不能是死路（横幅 + 扫码 + 输入密码 + 记住登录态）；
//   3. 网页只负责上报（reportBlank / reportError），不许再无脑打卡。
//
// 它检查的是"结构在不在"，行为由 test-web-report.mjs（真跑）与真机确认。
import fs from 'node:fs';

const here = (p) => new URL('../' + p, import.meta.url);
const main = fs.readFileSync(here('android/src/com/lexin/dshmobile/MainActivity.java'), 'utf8');
const bridge = fs.readFileSync(here('android/src/com/lexin/dshmobile/ShellBridge.java'), 'utf8');
const shell = fs.readFileSync(here('android/assets/shell.html'), 'utf8');
const mobile = fs.readFileSync(here('mobile/mobile.js'), 'utf8');

let fail = 0;
const has = (name, text, needle) => {
  if (text.includes(needle)) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, '缺少: ' + needle);
  }
};
const notHas = (name, text, needle) => {
  if (!text.includes(needle)) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, '不该出现: ' + needle);
  }
};
const match = (name, text, re) => {
  if (re.test(text)) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, '不匹配: ' + re);
  }
};
const notMatch = (name, text, re) => {
  if (!re.test(text)) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, '不该匹配: ' + re);
  }
};

// ---------------- 1. 原生探针（不依赖网页 JS） ----------------
has('探针间隔 5s', main, 'PROBE_MS = 5000');
has('连续两次才判断', main, 'PROBE_FAILS = 2');
has('探针端点走网关自己的 hello', main, '"/m/__ms/hello"');
has('探针不跟随重定向（才能分清 302 登录页）', main, 'c.setInstanceFollowRedirects(false)');
has('302 到登录页判成 needLogin', main, 'return "needLogin"');
has('探针结果驱动横幅', main, 'showBanner("offline"');
has('登录态缺失也驱动横幅', main, 'showBanner("login"');
has('前台立即探一次', main, 'startProbe();');
match('后台停探针（省电）', main, /protected void onPause\(\)[\s\S]{0,600}?stopProbe\(\)/);
match('销毁时停探针', main, /protected void onDestroy\(\)[\s\S]{0,300}?stopProbe\(\)/);
match('配置层不跑探针', main, /void showShell\(String kind[\s\S]{0,900}?stopProbe\(\)/);

// ---------------- 2. 横幅 = 原生恢复入口 ----------------
has('原生横幅 View 存在', main, 'private void buildBanner(FrameLayout root)');
has('横幅点开恢复面板', main, 'openRecovery()');
has('恢复面板按状态给按钮', main, 'items.add("输入密码")');
has('恢复面板有诊断', main, 'items.add("诊断")');
has('诊断可复制', main, 'void copyToClipboard(String text)');
has('诊断含登录态/探针/最近错误', main, '"登录态 "');
has('本地页能看到登录态与探针', main, '",loggedIn:" + hasSessionCookie()');

// ---------------- 3. 登录页不再是死路 ----------------
match('登录页保留悬浮球', main, /isLoginPage\(url\)[\s\S]{0,1400}?showFab\(\)/);
has('登录页走 onLoginPage', main, 'onLoginPage();');
has('登录页给横幅', main, 'showBanner("login", "需要登录电脑端 · 点这里")');
has('可从横幅输入密码', main, 'void promptPassword()');
has('密码换 Cookie 走 POST /__ms/login', main, 'origin + "/__ms/login"');
has('密码做了 URL 编码', main, 'URLEncoder.encode(pw, "UTF-8")');
has('从 Set-Cookie 取 ms_auth', main, 'cookiePairFrom(c.getHeaderField("Set-Cookie"))');
has('记住密码是可选勾选', main, 'remember.setText("记住密码（存本机）")');
match('密码错了清掉落盘的密码', main, /"bad"\.equals\(result\)[\s\S]{0,400}?remove\(KEY_LOGIN_PW\)/);

// ---------------- 4. 登录态持久化（跨重启/跨 IP） ----------------
has('Cookie 存 prefs', main, 'KEY_AUTH_COOKIE = "auth-cookie"');
has('页面加载后落盘登录态', main, 'rememberSessionCookie();');
has('导航前把登录态种回去', main, 'restoreSessionCookie(target);');
has('种 Cookie 用新 origin（换 IP 也有效）', main, 'CookieManager.getInstance().setCookie(origin + "/"');
match('登录成功即把 Cookie 落盘', main, /prefs\.edit\(\)\.putString\(KEY_AUTH_COOKIE, pair\)\.apply\(\)/);

// ---------------- 5. 入口不寄生网页 ----------------
match('加载开始就亮悬浮球', main, /private void loadTarget[\s\S]{0,1400}?showFab\(\);/);
match('扫码不再要求 shellMode', main, /void requestScan\(\) \{[^}]{0,120}?checkSelfPermission/);
has('扫码结果两种模式都能落地址', main, 'applyScannedUrl(text);');
match('落地址不需要 shellMode', main, /void applyScannedUrl\(String raw\) \{[^}]{0,80}?String u = normalize/);
has('相机不可用时切到配置页', main, '已切到配置页：可从相册选二维码');

// ---------------- 6. 网页只上报真异常，不判"内容够不够" ----------------
has('桥有 reportError', bridge, 'public void reportError(final String detail)');
has('桥有 login', bridge, 'public void login(final String password, final boolean remember)');
has('桥有 diag', bridge, 'public String diag()');
match('异常上报只认工作台（本地页丢弃）', bridge, /public void reportError\(final String detail\) \{\n\s*if \(host.inShellMode\(\)\) return;/);
match('登录只认本地页', bridge, /public void login\(final String password, final boolean remember\) \{\n\s*if \(!host.inShellMode\(\)\) return;/);
// 0.9.8：删掉 reportBlank —— "主内容区没字"在空的新会话上天天成立，是错误判据。
notHas('桥不再有 reportBlank', bridge, 'public void reportBlank(');
notHas('原生不再收空白上报', main, 'void reportBlankFromWeb(');
has('原生收错误上报', main, 'void reportErrorFromWeb(String detail)');
has('单次错误不打扰，连发三次才弹', main, 'errorBurst >= 3');

// ---------------- 6b. 不许再"猜网页死了" ----------------
// 用户 2026-10-26 报：没看到任何错误，App 却弹「页面好像崩了」，而且一个按钮都没有。
// 根因是 1.2.8 就有的两条启发式：整页 innerText 搜关键词、控制台消息搜关键词。
// 会话正文里出现过这些英文词、DSH 启动时打印模块路径，都会命中。
notHas('不再按整页文字判死', main, 'Failed to load plugins');
notHas('控制台不再按关键词判死', main, 'msg.contains("client-modules")');
has('修复面板改为自绘动作列表（ROM 不渲染 setItems 的坑）', main, 'AlertDialog showActions(');
match('修复面板走自绘列表', main, /void showRepairPanel\(String reason\)[\s\S]{0,900}?showActions\("DSH"/);
has('动作按钮是真按钮', main, 'android.widget.Button btn = new android.widget.Button(this)');
// 0.9.16：返回键 600ms 没回应曾经被 markDead() 记成"页面死了"，
// 于是下一次按返回键弹出「页面没有响应」修复面板（用户：「返回键逻辑又被你改废了」）。
// 现在的规矩：返回键只做"网页消费 → 否则双击退出"，永不弹面板。
{
  const body = /public void onBackPressed\(\) \{([\s\S]*?)\n    \}/.exec(main);
  const clean = body === null ? '' : body[1].replace(/\/\/[^\n]*/g, '');
  if (body && !/showRepairPanel/.test(clean)) console.log('ok  ', '返回键不再弹修复面板');
  else { fail += 1; console.log('FAIL', '返回键不再弹修复面板'); }
}
{
  const i = main.indexOf('private final Runnable backTimeout');
  const j = main.indexOf('private void backNotConsumed');
  const seg = (i >= 0 && j > i) ? main.slice(i, j) : '';
  if (seg && !/markDead/.test(seg.replace(/\/\/[^\n]*/g, ''))) console.log('ok  ', '返回键超时不判死');
  else { fail += 1; console.log('FAIL', '返回键超时不判死'); }
}
has('返回键超时走双击退出', main, 'backNotConsumed(SystemClock.uptimeMillis());');
match('网页晚回也不重复处理', main, /onReceiveValue\(String value\) \{[\s\S]{0,200}?if \(!backWaiting\) return;/);
notMatch('网络切换不判死', main, /onLost\(Network n\)[\s\S]{0,600}?markDead\(\)/);
has('断网仍给横幅', main, 'showBanner("offline", "手机没网了 · 点这里")');

// ---------------- 7. 网页侧：打卡只说明"我挂上了"，与内容无关 ----------------
// 0.9.8 教训：空的新会话正文本来就是空的，拿"有没有字"判活会天天误报。
has('打卡不再看内容', mobile, 'function pageReadyPing()');
notHas('删掉内容健康判定', mobile, 'contentHealthy');
notHas('删掉"首屏没内容"上报', mobile, "reportBlank', 'ready-timeout'");
notHas('删掉"心跳空白"上报', mobile, "reportBlank', 'thin-heartbeat'");
has('挂载即打卡', mobile, 'pageReadyPing();');
has('10 秒续一次心跳', mobile, 'setInterval(pageReadyPing, 10000)');
has('捕获全局异常', mobile, "window.addEventListener('error'");
has('捕获未处理的 Promise', mobile, "window.addEventListener('unhandledrejection'");
has('上报节流 1s', mobile, 'now - lastErrAt < 1000');
has('页面版本 r16', mobile, "window.__msVersion = '2026-10-27/r16'");

// ---------------- 8. 本地页：一个表单走完连接（地址 + 可选密码） ----------------
has('本地页有密码框', shell, 'id="pw"');
has('本地页只有一个连接按钮', shell, 'id="go"');
notHas('本地页不再有独立的登录按钮', shell, 'id="login"');
has('本地页可记住密码', shell, 'id="remember"');
has('本地页一次连接带密码', shell, 'bridge.connectWithPassword(raw, pw, remember)');
has('本地页显示登录态', shell, 'S.loggedIn ? \' · 已登录\'');
has('本地页有复制诊断', shell, 'id="copyDiag"');
has('诊断把原生信息拼进来', shell, "typeof bridge.diag === 'function'");

// ---------------- 8b. 自动弹出的只剩"横幅"，弹窗必须是人点的（0.9.7） ----------------
// 用户截图问「一切正常还是弹窗」：判定成立（页面确实空），但处置错了 —— 不该自动弹窗。
has('看门狗改成横幅', main, 'showBanner("blank", "页面脚本没加载出来 · 点这里处理")');
// 0.9.12：不再"等网页打卡等不到就报警"，改成原生主动 evaluateJavascript 问页面
match('看门狗主动问网页', main, /private final Runnable pageReadyWatchdog[\s\S]{0,1400}?web\.evaluateJavascript/);
has('问页面 3 秒没回才报', main, 'uiHandler.postDelayed(pageAliveFallback, 3000)');
has('页面活着不报警', main, 'if (v.length() > 2) {');
has('断网改成横幅', main, 'showBanner("offline", "手机没网了 · 点这里")');
notHas('断网不再自动弹窗', main, 'showRepairPanel("手机没网了');
notHas('不再用"有没有内容"判活', main, '页面没加载出来 · 点这里处理');
notHas('删除空白自动刷新', main, 'blankAutoReload');
notHas('删除空白上报通道', main, 'void reportBlank');
{
  const auto = (main.match(/showRepairPanel\(\);/g) || []).length;
  // 只剩一处人点出来的（长按悬浮球）；另一处是同名无参 wrapper 自己
  if (auto <= 2) console.log('ok  ', '没有自动弹窗的调用点（剩余 ' + auto + ' 处，都是人点的）');
  else { fail += 1; console.log('FAIL', '还有自动弹窗的调用点', String(auto)); }
}

// ------------- 9. 悬浮球：健康必收起、异常必回来（0.9.13 → 0.9.15） -------------
// 0.9.13 用"30 秒倒计时 + 不够安静就重排"来收，结果探针每 5 秒成功一次就重排一次，
// 定时器被无限续命 —— 悬浮球常驻（用户："启动后三分钟都还在"）；反而切后台探针停了
// 才收得起来（用户："后回来就没有了"）。两个症状同源。
// 0.9.15：可见性只有一个判定函数 updateFab()，由一个无条件自续的 1 秒 tick 驱动，
// 不存在"某次调用把收起取消掉"这种状态。
has('亮出后至少停 30 秒', main, 'FAB_MIN_SHOW_MS = 30000');
has('异常后保持 60 秒', main, 'ANOMALY_HOLD_MS = 60000');
has('唯一判定函数 updateFab', main, 'private void updateFab()');
match('tick 无条件自续（谁都取消不掉）',
  main, /private final Runnable fabTick[\s\S]{0,300}?updateFab\(\);[\s\S]{0,120}?uiHandler\.postDelayed\(this, 1000\);/);
match('判定同时看异常/保持/刚亮出',
  main, /private void updateFab\(\)[\s\S]{0,900}?boolean abnormal[\s\S]{0,400}?boolean hold[\s\S]{0,200}?boolean fresh/);
match('不满足条件就收起', main, /private void updateFab\(\)[\s\S]{0,1500}?fab\.setVisibility\(View\.GONE\)/);
// 回归锁：不许再出现"可以被重置的收起定时器"
notHas('旧的倒计时函数已删除', main, 'scheduleFabHide');
notHas('旧的收起 Runnable 已删除', main, 'fabFadeOut');
notHas('旧常量已删除', main, 'FAB_HIDE_MS');
match('探针不参与悬浮球判定',
  main, /private void onProbeResult[\s\S]{0,700}?if \("offline"\.equals\(bannerKind\)[\s\S]{0,200}?\n    \}/);
{
  const b = /private void onProbeResult\(String st\) \{([\s\S]*?)\n    \}/.exec(main);
  // 只认"调用"（带括号），注释里提到 updateFab 不算
  const pass = b !== null && !/\b(updateFab|showFab|fabTick)\(/.test(b[1].replace(/\/\/[^\n]*/g, ''));
  if (pass) console.log('ok  ', '探针函数里没有悬浮球调用');
  else {
    fail += 1;
    console.log('FAIL', '探针函数里没有悬浮球调用', b === null ? '函数没找到' : '仍调用悬浮球');
  }
}
has('markDead 只记异常时刻', main, 'lastAnomalyAt = SystemClock.uptimeMillis();');
match('markDead 不直接改可见性',
  main, /void markDead\(\)[\s\S]{0,500}?updateFab\(\);/);
match('横幅出现会亮球', main, /private void showBanner[\s\S]{0,900}?showFab\(\);/);
match('横幅撤掉立刻重算', main, /private void hideBanner[\s\S]{0,300}?updateFab\(\);/);
match('前台恢复 tick', main, /protected void onResume\(\)[\s\S]{0,900}?postDelayed\(fabTick, 1000\)/);
match('后台停 tick（省电）', main, /protected void onPause\(\)[\s\S]{0,600}?removeCallbacks\(fabTick\)/);
match('销毁停 tick', main, /protected void onDestroy\(\)[\s\S]{0,600}?removeCallbacks\(fabTick\)/);
has('本地页有推送自检入口', shell, 'id="pushCheck"');
has('本地页有退出入口', shell, 'id="quitApp"');
has('本地页调桥推送自检', shell, "bridge.pushCheck()");
has('本地页调桥退出', shell, "bridge.quit()");
has('桥有 pushCheck', bridge, 'public void pushCheck()');
has('桥有 quit', bridge, 'public void quit()');

// ---------------- 10. 废代码清理（0.9.6） ----------------
// 都是"改完没删干净"的残骸：调用方早没了，只剩定义。
notHas('死代码 retryLoad 已删', main, 'void retryLoad()');
notHas('死代码 retryCleanLoad 已删', main, 'void retryCleanLoad()');
notHas('死代码 forgetAddress 已删', main, 'void forgetAddress()');
notHas('死代码 ensureTaskChannel 已删', main, 'void ensureTaskChannel()');
notHas('死代码 notifyTaskFromWeb 已删', main, 'void notifyTaskFromWeb(');
notHas('桥 retry 残骸已删', bridge, 'public void retry()');
notHas('桥 retryClean 残骸已删', bridge, 'public void retryClean()');
notHas('桥 forget 残骸已删', bridge, 'public void forget()');
notHas('桥 notifyTask 残骸已删', bridge, 'public void notifyTask(');
notHas('页面不再调 bridge.retry 兜底', shell, 'bridge.retry(');
notHas('UrlRules.isQrLoginTarget 已删', fs.readFileSync(here('android/src/com/lexin/dshmobile/UrlRules.java'), 'utf8'), 'isQrLoginTarget');


// 探针/横幅的时序常量：看门狗必须比网页的"等 20 秒"长
const readyMs = Number((main.match(/PAGE_READY_MS = (\d+)/) || [])[1]);
const bootMs = Number((main.match(/BOOT_WATCHDOG_MS = (\d+)/) || [])[1]);
// 两个看门狗不在同一时刻生效：boot 管"文档都没加载完"，pageReady 管"文档加载完了但 JS 没挂上"。
if (readyMs >= 30000) console.log('ok  ', '网页就绪看门狗 ≥ 30s（只判 JS 有没有挂上）');
else {
  fail += 1;
  console.log('FAIL', '网页就绪看门狗太短', String(readyMs));
}
if (bootMs >= 25000) console.log('ok  ', '启动看门狗 ≥ 25s');
else {
  fail += 1;
  console.log('FAIL', '启动看门狗太短', String(bootMs));
}

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exitCode = fail === 0 ? 0 : 1;
