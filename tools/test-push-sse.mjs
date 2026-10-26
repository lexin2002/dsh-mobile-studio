// 推送通道（SSE）单测：假上游 + 真网关，连上 /m/__ms/push，
// 触发 done / question / clear 三种帧，断言字段与标题解析。
import http from 'node:http';
import { startLanGateway } from '../lan.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok', name);
};

// 假上游：网关会在打推送帧时问一次 session/list 拿标题。
// 必须按网关的 RPC 信封回：{ result: { ok: true, value } }。
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    result: {
      ok: true,
      value: {
        items: [
          {
            sessionId: 's1', running: false, updatedAt: 3,
            projections: { values: { title: '测试会话', sessionStats: { turns: 7 } } },
          },
        ],
      },
    },
  }));
});

await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

let fire = null;
// 重连补发用：网关通过 getRecentEvents 拿到断线期间的帧
const recent = [];
const PORT = 38000 + Math.floor(Math.random() * 1000);
const gw = startLanGateway({
  listenPort: PORT,
  upstreamHost: '127.0.0.1',
  upstreamPort: upPort,
  getAuth: () => null,
  getRecentEvents: (since) => recent.filter((e) => Number(e.at) > Number(since || 0)),
  subscribeEvents: (cb) => {
    fire = cb;
    return () => { fire = null; };
  },
  log: () => {},
});
await new Promise((r) => setTimeout(r, 300));

const ctrl = new AbortController();
const res = await fetch(`http://127.0.0.1:${PORT}/m/__ms/push`, { signal: ctrl.signal });
eq('SSE 200', res.status, 200);
eq('content-type', (res.headers.get('content-type') || '').startsWith('text/event-stream'), true);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';

const readLine = async (prefix, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const lines = buf.split('\n');
    const i = lines.findIndex((l) => l.startsWith(prefix));
    if (i >= 0) {
      const line = lines[i];
      buf = lines.slice(i + 1).join('\n');
      return line;
    }
    const { value, done } = await reader.read();
    if (done) return null;
    buf += dec.decode(value, { stream: true });
  }
  return null;
};

const readFrame = async (ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const lines = buf.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('data: ')) continue;
      try {
        const parsed = JSON.parse(lines[i].slice(6));
        buf = lines.slice(i + 1).join('\n');
        return parsed;
      } catch {
        // JSON 还没收全，继续读
      }
    }
    const { value, done } = await reader.read();
    if (done) return null;
    buf += dec.decode(value, { stream: true });
  }
  return null;
};

eq('握手行 : connected', !!(await readLine(': connected')), true);

// 1) 正常完成
fire({ id: 's1:1750000000123', kind: 'done', sessionId: 's1', at: 1750000000123, detail: '' });
let frame = await readFrame();
eq('done.id', frame && frame.id, 's1:1750000000123');
eq('done.turnId 兼容旧 APK', frame && frame.turnId, 's1:1750000000123');
eq('done.kind', frame && frame.kind, 'done');
eq('done.title 来自上游', frame && frame.title, '测试会话');
eq('done.at', frame && frame.at, 1750000000123);

// 2) 需要回答
fire({ id: 'tool:c1', kind: 'question', sessionId: 's1', at: 1750000000124, detail: '选 A 还是 B？' });
frame = await readFrame();
eq('question.kind', frame && frame.kind, 'question');
eq('question.detail', frame && frame.detail, '选 A 还是 B？');
eq('question.title', frame && frame.title, '测试会话');

// 3) 撤通知：不查标题
fire({ id: 'tool:c1', kind: 'clear', sessionId: 's1', at: 1750000000125 });
frame = await readFrame();
eq('clear.kind', frame && frame.kind, 'clear');
eq('clear.id', frame && frame.id, 'tool:c1');
eq('clear.title 为空', frame && frame.title, null);

// 4) 断线补发（0.9.14）：带上 since，把错过的帧补回来；更早的帧不补
recent.push({ id: 's1:1750000000200', kind: 'done', sessionId: 's1', at: 1750000000200, detail: '' });
recent.push({ id: 's1:1750000000300', kind: 'done', sessionId: 's1', at: 1750000000300, detail: '' });
const ctrl2 = new AbortController();
const res2 = await fetch(`http://127.0.0.1:${PORT}/m/__ms/push?since=1750000000250`, { signal: ctrl2.signal });
eq('replay SSE 200', res2.status, 200);
const reader2 = res2.body.getReader();
let buf2 = '';
let frame2 = null;
{
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && !frame2) {
    const idx = buf2.indexOf('data: ');
    if (idx >= 0) {
      const end = buf2.indexOf('\n\n', idx);
      if (end > idx) {
        try { frame2 = JSON.parse(buf2.slice(idx + 6, end)); } catch { frame2 = null; }
        if (frame2) break;
      }
    }
    const { value, done } = await reader2.read();
    if (done) break;
    buf2 += dec.decode(value, { stream: true });
  }
}
eq('补发帧存在', !!frame2, true);
eq('只补 since 之后的帧', frame2 && frame2.id, 's1:1750000000300');
eq('补发帧字段完整', !!(frame2 && frame2.kind === 'done' && frame2.at === 1750000000300), true);
ctrl2.abort();

ctrl.abort();
gw.close();
upstream.close();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
