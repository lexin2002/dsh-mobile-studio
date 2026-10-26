/**
 * 网关密码门禁的真实请求测试：起一个假上游 + 真网关，走 HTTP。
 * 不碰用户正式配置（DSH_HOME 指向临时目录）。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-auth-test-'));
process.env.DSH_HOME = tmp;

const authMod = await import('../auth.js');
const { startLanGateway } = await import('../lan.js');

let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok  ', name);
  else { fail += 1; console.log('FAIL', name, extra); }
};

const upPort = 34000 + Math.floor(Math.random() * 800);
const gwPort = upPort + 900;

const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/?token=')) {
    res.writeHead(302, { 'set-cookie': 'dsh-auth-fake=1; Path=/' });
    res.end();
    return;
  }
  if (req.url.startsWith('/api/session/list')) {
    req.resume();
    req.on('end', () => {
      const items = [
        { sessionId: 's-run', running: true, updatedAt: 200,
          projections: { values: { title: '跑着的任务', sessionStats: { turns: 3 } } } },
        { sessionId: 's-idle', running: false, updatedAt: 100,
          projections: { values: { title: null, sessionStats: { turns: 1 } } } },
      ];
      // 故意塞一个超大字段：网关必须裁掉，不能原样透传
      items[0].projections.values.turnOutline = [{ turn: 1, prompt: 'x'.repeat(5000) }];
      const body = JSON.stringify({ type: 'server-response', rpcId: 't', result: { ok: true, value: { items } } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body>UPSTREAM:' + req.url + '</body></html>');
});
await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

let auth = authMod.loadConfig().auth;
const gw = startLanGateway({
  listenPort: gwPort,
  upstreamHost: '127.0.0.1',
  upstreamPort: upPort,
  getLaunchToken: () => 'test-token',
  getAuth: () => auth,
  log: () => {},
});
await new Promise((r) => setTimeout(r, 300));

const base = 'http://127.0.0.1:' + gwPort;

// 1. 未设密码：直接放行
let r = await fetch(base + '/m', { redirect: 'manual' });
check('no password -> 200', r.status === 200, 'status=' + r.status);

// 2. 设置密码
auth = authMod.setPassword('abcd1234');
check('password stored enabled', auth.enabled === true);

// 3. 未登录访问 /m：302 到登录页
r = await fetch(base + '/m', { redirect: 'manual' });
const loc = r.headers.get('location') || '';
check('locked -> 302 login', r.status === 302 && loc.startsWith('/__ms/login?next='), 'status=' + r.status + ' loc=' + loc);

// 4. 登录页可打开
r = await fetch(base + '/__ms/login', { redirect: 'manual' });
const page = await r.text();
check('login page 200', r.status === 200 && page.includes('输入访问密码'), 'status=' + r.status);

// 5. 错密码 401
r = await fetch(base + '/__ms/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'password=wrong&next=%2Fm',
});
check('wrong password -> 401', r.status === 401, 'status=' + r.status);

// 6. 对密码 302 + Set-Cookie
r = await fetch(base + '/__ms/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'password=abcd1234&next=%2Fm',
});
const setCookie = r.headers.get('set-cookie') || '';
const cookie = setCookie.split(';')[0];
check('right password -> 302', r.status === 302 && (r.headers.get('location') || '') === '/m', 'status=' + r.status);
check('cookie issued', /^ms_auth=v1\.[0-9a-f]{32}$/.test(cookie), cookie);

// 7. 带 cookie 访问 /m：放行
r = await fetch(base + '/m', { redirect: 'manual', headers: { cookie } });
check('with cookie -> 200', r.status === 200, 'status=' + r.status);

// 8. 非 GET 未登录：401
r = await fetch(base + '/api/mobile-studio/filter', { method: 'POST', redirect: 'manual', body: '{}' });
check('POST without cookie -> 401', r.status === 401, 'status=' + r.status);

// 9. 登出后失效（旧 cookie 仍有效，但改密码会轮换 secret）
const oldCookie = cookie;
r = await fetch(base + '/__ms/logout', { redirect: 'manual' });
check('logout -> 302', r.status === 302, 'status=' + r.status);

// 10. 关闭密码：恢复扫码即开
auth = authMod.setPassword('');
r = await fetch(base + '/m', { redirect: 'manual' });
check('disable password -> 200', r.status === 200, 'status=' + r.status);

// 11. 改密码后旧 cookie 失效（secret 轮换）
auth = authMod.setPassword('newpass99');
r = await fetch(base + '/m', { redirect: 'manual', headers: { cookie: oldCookie } });
check('rotated secret invalidates old cookie', r.status === 302, 'status=' + r.status);

// 12. 登录后可以取到 /m/mobile.css
r = await fetch(base + '/__ms/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'password=newpass99&next=%2Fm',
});
const cookie2 = (r.headers.get('set-cookie') || '').split(';')[0];
r = await fetch(base + '/m/mobile.css', { headers: { cookie: cookie2 } });
check('authorized mobile.css 200', r.status === 200, 'status=' + r.status);

// 13. 注入的脚本/样式 URL 必须带 mtime 版本号。
//     手机 WebView 按 URL 缓存模块脚本，URL 不变就永远拿旧的 ——
//     「改了代码用户说没变化」有一半是这个原因（HTTP 层已经没有缓存可以清了）。
r = await fetch(base + '/m', { headers: { cookie: cookie2 } });
const pageHtml = await r.text();
check('injected mobile.js has ?v=', /\/m\/mobile\.js\?v=\d+/.test(pageHtml), pageHtml.slice(0, 160));

// 14. 带版本号的资源本身要能取到（pathname 匹配不受查询串影响）
r = await fetch(base + '/m/mobile.js?v=123456', { headers: { cookie: cookie2 } });
check('mobile.js with ?v= 200', r.status === 200, 'status=' + r.status);

// 15. 任务摘要端点：裁剪过的 JSON，只能看到摘要字段
r = await fetch(base + '/m/__ms/tasks', { headers: { cookie: cookie2 } });
const tasks = await r.json().catch(() => null);
check('tasks 200 json', r.status === 200 && tasks && tasks.ok === true, 'status=' + r.status);
check('tasks trimmed+ordered',
  tasks && tasks.sessions.length === 2
  && tasks.sessions[0].id === 's-run' && tasks.sessions[0].running === true
  && tasks.sessions[0].title === '跑着的任务' && tasks.sessions[0].turns === 3
  && tasks.sessions[1].id === 's-idle' && tasks.sessions[1].running === false
  && !('turnOutline' in tasks.sessions[0]) && !('projections' in tasks.sessions[0]),
  JSON.stringify(tasks && tasks.sessions));

// 16. 未登录时任务端点不泄露：跳登录页
r = await fetch(base + '/m/__ms/tasks', { redirect: 'manual' });
check('tasks locked -> 302', r.status === 302, 'status=' + r.status);

// 17. 扫码登录票据：/__ms/qr?t= 一次换到登录 Cookie（密码开启也不用输密码）
const token = authMod.qrLoginToken(auth);
check('qr token 32 hex', /^[0-9a-f]{32}$/.test(token), token);
r = await fetch(base + '/__ms/qr?t=' + token, { redirect: 'manual' });
const qrCookie = (r.headers.get('set-cookie') || '').split(';')[0];
check('qr login -> 302 /m', r.status === 302 && (r.headers.get('location') || '') === '/m', 'status=' + r.status);
check('qr login issues session cookie', /^ms_auth=v1\.[0-9a-f]{32}$/.test(qrCookie), qrCookie);
check('qr login cookie == login cookie', qrCookie === cookie2, qrCookie + ' vs ' + cookie2);
r = await fetch(base + '/m', { redirect: 'manual', headers: { cookie: qrCookie } });
check('qr cookie opens /m', r.status === 200, 'status=' + r.status);

// 18. 票据被篡改：不发 Cookie，回 /m 后照旧被门禁带去登录页
r = await fetch(base + '/__ms/qr?t=' + token.split('').reverse().join(''), { redirect: 'manual' });
check('tampered token -> 302 /m without cookie',
  r.status === 302 && !r.headers.get('set-cookie'), 'status=' + r.status + ' cookie=' + r.headers.get('set-cookie'));

// 19. 改密码后旧票据立即作废，新票据有效（secret 轮换）
auth = authMod.setPassword('thirdpass77');
check('rotated secret invalidates old token', authMod.isValidQrToken(auth, token) === false);
const token2 = authMod.qrLoginToken(auth);
check('new token differs', token2 !== token && authMod.isValidQrToken(auth, token2) === true);
r = await fetch(base + '/__ms/qr?t=' + token, { redirect: 'manual' });
check('old token -> no cookie', !r.headers.get('set-cookie'), String(r.headers.get('set-cookie')));
r = await fetch(base + '/__ms/qr?t=' + token2, { redirect: 'manual' });
check('new token -> cookie', /^ms_auth=/.test(r.headers.get('set-cookie') || ''), String(r.headers.get('set-cookie')));

// 20. 未启用密码：票据没有意义，二维码就是干净地址；/__ms/qr 直接回 /m
auth = authMod.setPassword('');
check('disabled password -> no token', authMod.qrLoginToken(auth) === '');
r = await fetch(base + '/__ms/qr?t=whatever', { redirect: 'manual' });
check('disabled password /__ms/qr -> 302 /m', r.status === 302 && (r.headers.get('location') || '') === '/m', 'status=' + r.status);
r = await fetch(base + '/m', { redirect: 'manual' });
check('disabled password /m 200 again', r.status === 200, 'status=' + r.status);

gw.close();
upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
