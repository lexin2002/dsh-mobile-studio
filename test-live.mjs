/**
 * 用**当前磁盘上的 lan.js** 起一个独立网关，连真实 DSH，
 * 完整跑一遍 /m 与 / 的请求，确认不崩、结果正确。
 *
 * 上游端口由参数传入（当前 DSH 的 webServer 端口）。
 */
import http from 'node:http';
import { startLanGateway } from './lan.js';

const listen = Number(process.argv[2] || 3099);
const upstream = Number(process.argv[3]);

let uncaught = null;
process.on('uncaughtException', (e) => {
  uncaught = e;
  console.error('\n!! UNCAUGHT: ' + e.message);
  console.error(e.stack);
});

const gw = startLanGateway({
  listenPort: listen,
  upstreamHost: '127.0.0.1',
  upstreamPort: upstream,
  getLaunchToken: () => null,
  log: (m) => console.log('[gw] ' + m),
});

function request(path, method = 'GET', headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: listen, path, method, headers, timeout: 25000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(chunks).length }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 'timeout', len: 0 }); });
    r.on('error', (e) => resolve({ status: 'error', msg: e.message, len: 0 }));
    r.end();
  });
}

console.log('\n=== 等网关就绪 ===');
await new Promise((r) => setTimeout(r, 1500));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

console.log('\n=== 1. 桌面端 / 必须原样 ===');
const root = await request('/');
check('/ 返回 200', root.status === 200, 'status=' + root.status + ' len=' + root.len);
check('/ 长度约 41903', root.len > 38000 && root.len < 46000, root.len + 'B');

console.log('\n=== 2. 手机端 /m ===');
const m = await request('/m');
check('/m 返回 200', m.status === 200, 'status=' + m.status + ' len=' + m.len);
check('/m 长度约 40000', m.len > 36000 && m.len < 46000, m.len + 'B');

console.log('\n=== 3. 手机端静态资源 ===');
const css = await request('/m/mobile.css');
check('/m/mobile.css 200', css.status === 200, 'len=' + css.len);
const js = await request('/m/mobile.js');
check('/m/mobile.js 200', js.status === 200, 'len=' + js.len);

console.log('\n=== 4. 组合脚本（手机端过滤）===');
const combo = await request('/plugins/??@deepseek-ai/dsh-client-locale/client.js&rev=127ec3ab216e');
check('combo 200', combo.status === 200, 'status=' + combo.status + ' len=' + combo.len);

console.log('\n=== 5. 不该被 /m 误伤的路径 ===');
const manifest = await request('/manifest.webmanifest');
check('/manifest.webmanifest 不是 404', manifest.status !== 404, 'status=' + manifest.status);

console.log('\n=== 6. 反复请求（压测崩溃）===');
let bad = 0;
for (let i = 0; i < 12; i += 1) {
  const r = await request(i % 3 === 0 ? '/m' : i % 3 === 1 ? '/' : '/m/mobile.css');
  if (r.status !== 200) bad += 1;
}
check('12 次混合请求全部 200', bad === 0, 'failed=' + bad);

console.log('\n=== 结果 ===');
const failed = checks.filter((c) => !c.ok);
console.log('通过 ' + (checks.length - failed.length) + '/' + checks.length);
console.log('进程未崩溃:', uncaught === null ? 'YES' : 'NO — ' + uncaught.message);

gw.close();
await new Promise((r) => setTimeout(r, 300));
process.exit(failed.length || uncaught ? 1 : 0);
