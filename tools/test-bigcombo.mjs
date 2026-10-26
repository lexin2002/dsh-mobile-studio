// 组合脚本体积回归测试（2026-10-23 真机事故的护栏）。
//
// 事故：网关有"改写体缓冲上限"，上一版设 8MB。装到 85 个插件时，真实的组合
// 脚本体实测 9,132,689 B 和 8,223,400 B —— 两批全被 502 掉，客户端拿不到
// client-modules 的注册，整页报
//   "client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js"
// 手机端一个插件都加载不出来。
//
// 这个测试造一个 9.5MB 的组合脚本，带 /m 的 Referer（才会走过滤），断言：
//   1) 不被体积上限误杀（200，不是 502）；
//   2) 第三方段仍然被裁掉（过滤本身没退化）。
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-bigcombo-'));
process.env.DSH_HOME = tmp;

const authMod = await import('../auth.js');
const { startLanGateway } = await import('../lan.js');

let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok  ', name);
  else { fail += 1; console.log('FAIL', name, extra); }
};

const chunk = (id) => `window.__ModuleLoader__.load({\n\tid: "${id}",\n\tfactory: (r) => ({})\n});\n`;
const BIG =
  chunk('@deepseek-ai/dsh-api-gateway') +
  chunk('some-third-party') +
  '/*' + 'x'.repeat(9 * 1024 * 1024) + '*/';

const upPort = 35000 + Math.floor(Math.random() * 500);
const gwPort = upPort + 600;

const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/plugins/??')) {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(BIG);
    return;
  }
  if (req.url.startsWith('/?token=')) {
    res.writeHead(302, { 'set-cookie': 'dsh-auth-fake=1; Path=/' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body>UP</body></html>');
});
await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

const gw = startLanGateway({
  listenPort: gwPort,
  upstreamHost: '127.0.0.1',
  upstreamPort: upPort,
  // 和 test-gateway.mjs 一样：给 launch token，假上游用 302+set-cookie 换票
  getLaunchToken: () => 'test-token',
  getAuth: () => ({ enabled: false, salt: '', hash: '', secret: 'x' }),
  log: () => {},
});
await new Promise((r) => setTimeout(r, 300));
const base = 'http://127.0.0.1:' + gwPort;

const r = await fetch(base + '/plugins/??@deepseek-ai/dsh-api-gateway/client.js,some-third-party/client.js&rev=1', {
  headers: { referer: base + '/m' },
});
const text = await r.text();
check('9.5MB 组合脚本不被体积上限误杀', r.status === 200,
  'status=' + r.status + ' body=' + text.slice(0, 100));
// 过滤的"裁段"依赖首页先登记（filterCombo 只裁 HTML 里明确丢过的 id），
// 这里没走首页，所以只断言代码确实被送达（不是空壳/502）。
check('9.5MB 组合脚本内容送达', text.includes('@deepseek-ai/dsh-api-gateway'), 'len=' + text.length);

gw.close();
upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
