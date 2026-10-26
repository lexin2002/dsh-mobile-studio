// 扫码回归：解码链路 + shell 页接线 + 返回按钮可见性规则。
//
// 三块：
//   1. 用仓库自带 qr-inline.js（qrcode@1.5.4）生成真二维码矩阵，
//      再用打进 APK 的 jsQR 解回来 —— 证明「二维码内容 → 手机解码」这条路是通的；
//   2. 从 shell.html 抽出纯函数 pickQrPayload / shouldShowBack / isLikelyImage 真跑；
//   3. 静态接线断言：相机 input、扫码按钮、返回按钮、原生注入与桥守卫。
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const here = (p) => new URL('../' + p, import.meta.url);
const html = fs.readFileSync(here('android/assets/shell.html'), 'utf8');
const jsqrPath = here('android/assets/jsqr.js');
// 跟 WebView 里一样：UMD 走 self 分支，挂成全局 jsQR。
const libCtx = { console, TextEncoder, TextDecoder };
libCtx.self = libCtx;
vm.createContext(libCtx);
vm.runInContext(fs.readFileSync(jsqrPath, 'utf8'), libCtx);
const jsQR = libCtx.jsQR;

let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok  ', name);
  else { fail += 1; console.log('FAIL', name, extra); }
};

// ---------------------------------------------------------------- 1. 真解码
const qrSrc = fs.readFileSync(here('qr-inline.js'), 'utf8');
const qrCtx = vm.createContext({ console, TextEncoder, TextDecoder, module: { exports: {} }, exports: {} });
vm.runInContext(qrSrc + '\nthis.qrCreate = qrCreate;', qrCtx);

/** 用二维码矩阵画一张 RGBA 图（模拟手机拍到的一帧），再交给 jsQR。 */
function decodePayload(payload, { scale = 6, quiet = 4 } = {}) {
  const qr = qrCtx.qrCreate(payload);
  const N = qr.size;
  const W = (N + quiet * 2) * scale;
  const data = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!qr.data[y * N + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((quiet + y) * scale + dy) * W + (quiet + x) * scale + dx) * 4;
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
        }
      }
    }
  }
  const hit = jsQR(data, W, W, { inversionAttempts: 'attemptBoth' });
  return hit && hit.data ? hit.data : '';
}

const tokenUrl = 'http://192.168.1.10:3081/__ms/qr?t=' + crypto.randomBytes(16).toString('hex');
check('jsQR 解出带票据的登录地址', decodePayload(tokenUrl) === tokenUrl);
const plainUrl = 'http://10.0.0.7:3081/m';
check('jsQR 解出普通地址', decodePayload(plainUrl) === plainUrl);
check('jsQR 能解反色/低对比画面（attemptBoth）',
  decodePayload(plainUrl) !== '' && (() => {
    const qr = qrCtx.qrCreate(plainUrl);
    const scale = 5, quiet = 4, N = qr.size, W = (N + quiet * 2) * scale;
    const data = new Uint8ClampedArray(W * W * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!qr.data[y * N + x]) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = (((quiet + y) * scale + dy) * W + (quiet + x) * scale + dx) * 4;
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; // 先填黑
      }
    }
    // 整图取反（白底黑码 → 黑底白码）
    for (let i = 0; i < data.length; i += 4) {
      for (let k = 0; k < 3; k++) data[i + k] = 255 - data[i + k];
    }
    const hit = jsQR(data, W, W, { inversionAttempts: 'attemptBoth' });
    return !!(hit && hit.data === plainUrl);
  })());

check('内嵌解码库带 MIT 头', /jsQR v1\.4\.0 \| MIT License/.test(fs.readFileSync(jsqrPath, 'utf8')));

// ------------------------------------------------------- 2. 抽 shell 页纯函数
function grab(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}');
  const m = html.match(re);
  if (!m) throw new Error('shell.html 里找不到 ' + name);
  return m[0];
}

const pickQrPayload = new Function('URL', grab('pickQrPayload') + '\nreturn pickQrPayload;')(URL);
const shouldShowBack = new Function(grab('shouldShowBack') + '\nreturn shouldShowBack;')();
const isLikelyImage = new Function(grab('isLikelyImage') + '\nreturn isLikelyImage;')();

check('pickQrPayload 收 http 地址', pickQrPayload(plainUrl) === plainUrl);
check('pickQrPayload 收带票据地址', pickQrPayload('  ' + tokenUrl + '\n') === tokenUrl);
check('pickQrPayload 拒垃圾文本', pickQrPayload('这不是二维码') === '');
check('pickQrPayload 拒非 http 协议', pickQrPayload('javascript:alert(1)') === '');
check('pickQrPayload 拒换行', pickQrPayload(plainUrl + '\n' + 'x') === '');
check('pickQrPayload 拒超长', pickQrPayload('http://x/' + 'a'.repeat(2100)) === '');
check('shouldShowBack 只认 canReturn===true',
  shouldShowBack({ canReturn: true }) === true
  && shouldShowBack({ canReturn: false }) === false
  && shouldShowBack({}) === false
  && shouldShowBack(null) === false);
const shouldShowRefresh = new Function(grab('shouldShowRefresh') + '\nreturn shouldShowRefresh;')();
check('shouldShowRefresh 只认 canRefresh===true',
  shouldShowRefresh({ canRefresh: true }) === true && shouldShowRefresh({}) === false);
check('isLikelyImage 认 image/*', isLikelyImage({ type: 'image/jpeg' }) === true);
check('isLikelyImage 拒其它类型', isLikelyImage({ type: 'text/html' }) === false && isLikelyImage(null) === false);

// ------------------------------------------------------------ 3. 静态接线
check('相机输入带 capture（系统相机兜底）', /id="scanCam"[^>]*accept="image\/\*"[^>]*capture="environment"/.test(html));
check('相册输入存在', /id="scanGallery"[^>]*accept="image\/\*"/.test(html));
check('扫码主按钮走原生实时取景', /\$\('scan'\)\.addEventListener\('click', startLiveScan\)/.test(html) && /typeof bridge\.scan === 'function'/.test(html));
check('错误页有重新扫码', /id="scanErr"/.test(html) && /重新扫码/.test(html));
check('配置页有刷新与清缓存刷新', /id="refresh"/.test(html) && /id="refreshClean"/.test(html) && /bridge\.refreshWorkbench\(true\)/.test(html));
check('刷新行按 canRefresh 显示', /id="refreshRow" class="row hidden"/.test(html) && /shouldShowRefresh\(S\)/.test(html));
check('返回按钮有 aria-label 且默认隐藏', /id="back"[^>]*aria-label="返回主界面"/.test(html) && /id="topbar" class="topbar hidden"/.test(html));
check('返回按钮调 Shell.backToWorkbench',
  /\$\('back'\)\.addEventListener\('click', function \(\) \{[\s\S]*?backToWorkbench/.test(html));
check('相册解码后自动 bridge.connect（一键登录）', /bridge\.connect\(url\)/.test(html));
check('解码库注入占位符存在', html.includes('<!--SCANLIB-->'));
check('文案已去口语', !/地址在哪|那行|也行|没开/.test(html));

const bridge = fs.readFileSync(here('android/src/com/lexin/dshmobile/ShellBridge.java'), 'utf8');
check('ShellBridge 有 backToWorkbench 且守 shellMode',
  /public void backToWorkbench\(\) \{\s*\n\s*if \(!host\.inShellMode\(\)\) return;/.test(bridge));
check('ShellBridge 有 scan 且守 shellMode',
  /public void scan\(\) \{\s*\n\s*if \(!host\.inShellMode\(\)\) return;/.test(bridge));
check('ShellBridge 有 refreshWorkbench 且守 shellMode',
  /public void refreshWorkbench\(final boolean clearCache\) \{\s*\n\s*if \(!host\.inShellMode\(\)\) return;/.test(bridge));

const main = fs.readFileSync(here('android/src/com/lexin/dshmobile/MainActivity.java'), 'utf8');
check('双 WebView：配置层独立 shellWeb', /private WebView shellWeb;/.test(main) && /shellWeb\.loadDataWithBaseURL/.test(main));
check('showShell 不触碰工作台 WebView', (() => {
  const m = main.match(/void showShell\(String kind, String message\) \{[\s\S]*?\n    \}/);
  if (!m) return false;
  return !/web\.loadUrl\(/.test(m[0]) && !/web\.loadData/.test(m[0]);
})());
check('hideShell 收起配置层不刷新', (() => {
  const m = main.match(/void hideShell\(\) \{[\s\S]*?\n    \}/);
  return !!m && !/load\(/.test(m[0]) && !/loadUrl\(/.test(m[0]) && /shellWeb\.setVisibility\(View\.GONE\)/.test(m[0]);
})());
check('返回优先收起而不是重载', /if \(workbenchReady\) \{[\s\S]{0,160}?hideShell\(\)/.test(main));
check('刷新走 refreshFromShell 并先收起配置层', /void refreshFromShell\(boolean clearCache\)[\s\S]{0,600}?hideShell\(\);[\s\S]{0,200}?refreshWorkbench\(clearCache\)/.test(main));
check('showShell 注入 jsqr.js', /readAsset\("jsqr\.js"\)/.test(main) && /<!--SCANLIB-->/.test(main));
check('normalize 委托 UrlRules', /return UrlRules\.normalize\(raw\)/.test(main));
check('扫码地址存干净 /m', /workbenchUrlFor\(u\)/.test(main) && /lastGoodUrl = currentUrl;/.test(main));
check('登录页不再触发假死看门狗', /isLoginPage\(url\)/.test(main) && /pageReadySeen = true;\s*\/\/ 登录页是活页面/.test(main));

// 1.3.4 扫码对焦：连续对焦模式下再调 autoFocus 会把镜头拉死，必须只在非连续模式定时触发
const scan = fs.readFileSync(here('android/src/com/lexin/dshmobile/ScanActivity.java'), 'utf8');
check('连续对焦时不再周期性 autoFocus',
  /if \(!continuousFocus\) scheduleAutoFocus\(\);/.test(scan) && /if \(continuousFocus\) return;/.test(scan));
check('支持 CONTINUOUS_VIDEO 兜底', /FOCUS_MODE_CONTINUOUS_VIDEO/.test(scan));
check('autoFocus 有世代号防叠加', /focusSeq/.test(scan));

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exitCode = fail === 0 ? 0 : 1;
