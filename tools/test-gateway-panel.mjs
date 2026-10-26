// 桌面扫码面板的端口状态是"静态接线"检查：真正的 HTTP 行为在 test-gateway-port.mjs。
import fs from 'node:fs';

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log('ok  ', name);
  else { fail += 1; console.log('FAIL', name, extra); }
};

check('lan-url 用实际端口拼 URL（不是常量）',
  /const port = gw \? gw\.port : GATEWAY_PORT/.test(index)
  && /`http:\/\/\$\{ip\}:\$\{port\}\/m`/.test(index));
check('lan-url 返回 gateway 状态对象',
  /gatewayInfo = \{[\s\S]{0,260}?triedPorts/.test(index)
  && /fallback: !!\(gw && gw\.fallback\)/.test(index));
check('启动网关开启自动顺延', /portAttempts: 5/.test(index));
check('未监听时不出 url/qr', /if \(!ip \|\| !listening\)[\s\S]{0,160}?url: null, qr: null/.test(index));

check('面板显示网关端口', /网关运行中 · 端口/.test(client));
check('面板提示端口被占用并顺延', /被其他程序占用，网关已自动改用/.test(client));
check('面板在全部被占时不展示二维码', /status: 'gateway-error'/.test(client) && /均被占用，无法启动网关/.test(client));
check('二维码仍取宿主给的实际 qr', /qrSvg\(d\.qr \|\| d\.url\)/.test(client));
check('面板刷新可重试（status !== loading 的刷新按钮）', /status !== 'loading'/.test(client));

// 0.9.4：二维码是"会随密码失效的数据"，必须在密码变化后重取。
// 之前它只在打开面板/点刷新时取一次，设完密码屏幕上还留着开密码前的干净 /m，
// 扫了必然落登录页 —— 用户报的「扫码不包含密码，还要自己输密码」。
check('AuthPanel 成功后通知外层', /props\.onChanged\(!!d\.enabled\)/.test(client));
check('AuthPanel 打开时也同步开关状态（坏码提示才出得来）', /props\.onState\(!!d\.enabled\)/.test(client));
check('ScanPage 收到 onChanged 就重取二维码',
  /onChanged:\s*function \(enabled\) \{[\s\S]{0,240}?setTick\(function \(t\) \{ return t \+ 1; \}\)/.test(client));
check('面板可见性变化时重取（别处改过密码也能自愈）',
  /addEventListener\('visibilitychange', onVisible\)/.test(client));
check('开着密码却没有票据时给出坏状态提示',
  /authOn === true && !state\.ticket/.test(client) && /当前二维码不含登录票据/.test(client));
check('坏状态样式存在', /\.ms-warn-bad\{/.test(client));

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exitCode = fail === 0 ? 0 : 1;

// 0.9.17：放行的插件自动置顶（点开就跳到最上面，关掉就落回下面）
check('放行的排在前面', /const byAllow = function \(a, b\) \{[\s\S]{0,260}?allow\.indexOf\(a\) >= 0 \? 0 : 1/.test(client));
check('列表真的按放行排序', /\.filter\(function \(id, i, a\) \{ return a\.indexOf\(id\) === i; \}\)\s*\.sort\(byAllow\)/.test(client));
check('面板文案说明会置顶', client.includes('已经放行的排在列表最前面'));
