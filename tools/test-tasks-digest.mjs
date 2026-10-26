// 单测 lan.js summarizeSessions：裁剪字段、倒序、取前30、容错
import { summarizeSessions } from '../lan.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok', name);
};

eq('non-array', summarizeSessions(null), []);
eq('skips bad rows', summarizeSessions([null, {}, { sessionId: 3 }]), []);

const items = [
  { sessionId: 'a', running: false, updatedAt: 100, projections: { values: { title: 'A', sessionStats: { turns: 2 } } } },
  { sessionId: 'b', running: true, updatedAt: 300, projections: { values: { title: null, sessionStats: { turns: 5 } } } },
  { sessionId: 'c', running: false, updatedAt: 200 },
];
const out = summarizeSessions(items);
eq('order desc', out.map((s) => s.id), ['b', 'c', 'a']);
eq('row b', out[0], { id: 'b', title: null, running: true, updatedAt: 300, turns: 5, finishedAt: 0, finishedKind: '' });
eq('row c defaults', out[2 - 1], { id: 'c', title: null, running: false, updatedAt: 200, turns: 0, finishedAt: 0, finishedKind: '' });

// finishedAt 时刻表：App 靠它比大小判完成（不再看 running 翻转）
const withFin = summarizeSessions(items, (id) => (id === 'b' ? 1750000000000 : 0), (id) => (id === 'b' ? 'error' : ''));
eq('finishedAt 注入', withFin[0].finishedAt, 1750000000000);
eq('finishedKind 注入', withFin[0].finishedKind, 'error');
eq('finishedAt 缺省 0', withFin[1].finishedAt, 0);
eq('finishedKind 缺省空串', withFin[1].finishedKind, '');
eq('非法 finishedAt 归 0', summarizeSessions(items, () => 'x')[0].finishedAt, 0);

const many = Array.from({ length: 40 }, (_, i) => ({ sessionId: 's' + i, updatedAt: i }));
eq('cap 30', summarizeSessions(many).length, 30);
eq('cap newest first', summarizeSessions(many)[0].id, 's39');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
