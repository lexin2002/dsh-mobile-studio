/**
 * 网关崩溃回归测试。
 *
 * 目的：确认任何异常都不再冒泡到进程级。
 * 之前 `{ ...req }` 破坏 IncomingMessage 导致 TypeError，
 * 未捕获 → 整个 DSH 桌面应用退出。
 *
 * 用法：node test-crash.mjs <listenPort> <upstreamPort>
 */
import http from 'node:http';
import { startLanGateway } from './lan.js';

const listenPort = Number(process.argv[2] || 3099);
const upstreamPort = Number(process.argv[3] || 0);

let crashed = false;
process.on('uncaughtException', (e) => {
  crashed = true;
  console.error('!! UNCAUGHT', String(e && e.message));
});
process.on('exit', () => {});

const gw = startLanGateway({
  listenPort,
  upstreamHost: '127.0.0.1',
  upstreamPort,
  getLaunchToken: () => null, // 故意不给 token，最大化异常路径
  log: (m) => console.log('[gw] ' + m),
});

function req(path, method = 'GET') {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: listenPort, path, method, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(chunks).length }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 'error', msg: e.message }));
    r.end();
  });
}

const cases = [
  ['/', 'GET'],
  ['/m', 'GET'],
  ['/m/', 'GET'],
  ['/m/mobile.css', 'GET'],
  ['/m/mobile.js', 'GET'],
  ['/m/nonexistent', 'GET'],
  ['/api/mobile-studio/lan-url', 'GET'],
  ['/plugins/??a,b&rev=c', 'GET'],
  ['/manifest.webmanifest', 'GET'],
  ['/assets/index-CN7NIWNw.js', 'GET'],
];

console.log('\n=== 逐个请求（上游端口 ' + upstreamPort + '）===');
let allOk = true;
for (const [p, m] of cases) {
  const r = await req(p, m);
  // 502 是「上游不可达」，属于预期（这里没给 token / 上游可能空）
  const ok = r.status === 200 || r.status === 502 || r.status === 400 || r.status === 404;
  if (!ok) allOk = false;
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + '  ' + String(r.status).padEnd(8) + m + ' ' + p + (r.len ? ' (' + r.len + 'B)' : ''));
}

// 故意制造畸形请求
console.log('\n=== 畸形请求 ===');
for (const p of ['/%', '/m?bad=%zz', '//', '/m/../../../etc/passwd']) {
  const r = await req(p);
  console.log('  ' + String(r.status).padEnd(8) + p);
}

await new Promise((r) => setTimeout(r, 500));

console.log('\n=== 结果 ===');
console.log('进程存活:', !crashed ? 'YES' : 'NO (crashed)');
console.log('请求全部正常返回:', allOk ? 'YES' : 'NO');
gw.close();
process.exit(crashed || !allOk ? 1 : 0);
