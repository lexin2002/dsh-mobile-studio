// 网关：端口占用自动顺延 + /m 唯一化（变体 302 回 /m）。
//
// 这两件事都是"看起来没事、真机上表现为连不上/绕过滤"的问题：
//   1. 3081 被别的程序占住时，不能假装启动成功还发二维码；
//   2. /m/、/m/m、/m/foo 这些变体不注入 mobile.js 也不做插件过滤，
//      必须统一回到精确的 /m，隔离才成立。
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-port-test-'));
process.env.DSH_HOME = tmp;

const { startLanGateway } = await import('../lan.js');

let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok  ', name);
  else { fail += 1; console.log('FAIL', name, extra); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 35000 + Math.floor(Math.random() * 400);
const upPort = base + 900;
const gwPort = base;

const upstream = http.createServer((req, res) => {
  // 网关首次转发前会用 launch token 换一张 dsh-auth cookie（和真实 DSH 一致）
  if (req.url.startsWith('/?token=')) {
    res.writeHead(302, { 'set-cookie': 'dsh-auth-fake=1; Path=/' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body>UPSTREAM ' + req.url + '</body></html>');
});
await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

/** 占住一个端口，模拟"被别的程序占用"。 */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer(() => {});
    s.once('error', reject);
    s.listen(port, '0.0.0.0', () => resolve(s));
  });
}

async function waitListening(gw, timeout = 4000) {
  await Promise.race([gw.whenReady, sleep(timeout)]);
}

// ---------------------------------------------------------------- 1. 自动顺延
const blocker = await occupy(gwPort);
const gw = startLanGateway({
  listenPort: gwPort,
  portAttempts: 3,
  upstreamHost: '127.0.0.1',
  upstreamPort: upPort,
  getLaunchToken: () => 'test-token',
  getAuth: () => ({ enabled: false }),
  log: () => {},
});
await waitListening(gw);
check('首端口被占 -> 自动顺延', gw.listening === true && gw.port === gwPort + 1, 'listening=' + gw.listening + ' port=' + gw.port);
check('记录了尝试过的端口', JSON.stringify(gw.triedPorts) === JSON.stringify([gwPort, gwPort + 1]), JSON.stringify(gw.triedPorts));
check('fallback 标记为真', gw.fallback === true);

const gwBase = 'http://127.0.0.1:' + gw.port;
let r = await fetch(gwBase + '/m', { redirect: 'manual' });
check('顺延后的端口 /m 可用', r.status === 200, 'status=' + r.status);

// ---------------------------------------------------------------- 2. /m 唯一化
for (const p of ['/m/', '/m/index.html', '/m/m', '/m/foo', '/m//']) {
  r = await fetch(gwBase + p, { redirect: 'manual' });
  check(p + ' -> 302 /m', r.status === 302 && (r.headers.get('location') || '') === '/m', 'status=' + r.status + ' loc=' + r.headers.get('location'));
}
r = await fetch(gwBase + '/m/mobile.css', { redirect: 'manual' });
check('/m/mobile.css 不被重定向', r.status === 200, 'status=' + r.status);
r = await fetch(gwBase + '/m/__ms/hello', { redirect: 'manual' });
check('/m/__ms/hello 不被重定向', r.status === 204, 'status=' + r.status);
r = await fetch(gwBase + '/m?x=1', { redirect: 'manual' });
check('/m 带 query 仍 200', r.status === 200, 'status=' + r.status);

gw.close();
await new Promise((r2) => blocker.close(r2));

// ---------------------------------------------------------------- 3. 全部被占
const b2 = await occupy(gwPort + 2);
const b3 = await occupy(gwPort + 3);
const b4 = await occupy(gwPort + 4);
const gw2 = startLanGateway({
  listenPort: gwPort + 2,
  portAttempts: 3,
  upstreamHost: '127.0.0.1',
  upstreamPort: upPort,
  getLaunchToken: () => null,
  getAuth: () => ({ enabled: false }),
  log: () => {},
});
await waitListening(gw2);
check('候选全被占 -> 不监听', gw2.listening === false, 'listening=' + gw2.listening);
check('错误码 EADDRINUSE', gw2.error === 'EADDRINUSE', String(gw2.error));
check('triedPorts 覆盖全部候选', JSON.stringify(gw2.triedPorts) === JSON.stringify([gwPort + 2, gwPort + 3, gwPort + 4]), JSON.stringify(gw2.triedPorts));
gw2.close();
await Promise.all([new Promise((r2) => b2.close(r2)), new Promise((r2) => b3.close(r2)), new Promise((r2) => b4.close(r2))]);

upstream.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exitCode = fail === 0 ? 0 : 1;
