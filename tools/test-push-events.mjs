// push-events.js 单测：事件分类、工具识别、延迟/撤回、去重。
import { classifyTurn, describeToolCall, createPushHub } from '../push-events.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok', name);
};

// ---- classifyTurn ----
eq('completed → done', classifyTurn({ kind: 'completed' }), { kind: 'done', detail: '' });
eq('error 带消息', classifyTurn({ kind: 'error', error: { message: '连接失败' } }), { kind: 'error', detail: '连接失败' });
eq('用户停止不打扰', classifyTurn({ kind: 'aborted', reason: { kind: 'user' } }), null);
eq('DSH 退出不打扰', classifyTurn({ kind: 'aborted', reason: { kind: 'disposed' } }), null);
eq('hook 中止要提醒', classifyTurn({ kind: 'aborted', reason: { kind: 'hook' } }), { kind: 'interrupted', detail: '任务被中断' });
eq('interrupted', classifyTurn({ kind: 'interrupted' }), { kind: 'interrupted', detail: '任务被中断' });
eq('blocked', classifyTurn({ kind: 'blocked' }), { kind: 'blocked', detail: '前置步骤未通过' });
eq('max-tokens', classifyTurn({ kind: 'max-tokens' }), { kind: 'max-tokens', detail: '输出达到上限' });
eq('forked 不推', classifyTurn({ kind: 'forked' }), null);
eq('reason 缺失按完成', classifyTurn(undefined), { kind: 'done', detail: '' });

// ---- describeToolCall ----
eq('计划取标题', describeToolCall('exit_plan_mode', JSON.stringify({ plan: '# 修复推送\n\n正文' })), { kind: 'plan', detail: '修复推送' });
eq('计划无标题也能认', describeToolCall('exit_plan_mode', JSON.stringify({ plan: '正文' })), { kind: 'plan', detail: '' });
eq('提问取首问', describeToolCall('ask_user_question', JSON.stringify({ questions: [{ id: 'a', question: '选 A 还是 B？' }] })), { kind: 'question', detail: '选 A 还是 B？' });
eq('多问附数量', describeToolCall('ask_user_question', JSON.stringify({ questions: [{ id: 'a', question: 'Q1' }, { id: 'b', question: 'Q2' }] })), { kind: 'question', detail: 'Q1（共 2 个问题）' });
eq('坏 JSON 不推', describeToolCall('ask_user_question', '{oops'), null);
eq('空计划不推', describeToolCall('exit_plan_mode', JSON.stringify({ plan: '  ' })), null);
eq('别的工具不推', describeToolCall('bash', '{}'), null);

// ---- hub：完成/失败 ----
const makeHub = (opts = {}) => {
  const out = [];
  let timers = [];
  let seq = 0;
  const hub = createPushHub({
    publish: (ev) => out.push(ev),
    now: () => 1000 + (seq += 1),
    setTimeoutFn: (fn) => { timers.push({ id: seq + 100, fn }); return seq + 100; },
    clearTimeoutFn: (id) => { timers = timers.filter((t) => t.id !== id); },
    ...opts,
  });
  return { hub, out, fire: () => { const q = timers; timers = []; q.forEach((t) => t.fn()); }, timers: () => timers };
};

{
  const { hub, out } = makeHub();
  hub.onSessionEvent({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  eq('turn/end 不立刻发', out.length, 0);
  hub.onAgentStatus({ status: 'idle', agent: { id: 's1' } });
  eq('idle 发一条 done', out.map((e) => [e.kind, e.sessionId]), [['done', 's1']]);
  eq('帧 id 是 session:at', /^s1:\d+$/.test(out[0].id), true);
  eq('finishedAt 打点', hub.getFinishedAt('s1'), out[0].at);
  eq('finishedKind=done', hub.getFinishedKind('s1'), 'done');
  hub.onAgentStatus({ status: 'idle', agent: { id: 's1' } });
  eq('第二次 idle 不重发', out.length, 1);
}

{
  const { hub, out } = makeHub();
  hub.onSessionEvent({ id: 's2' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '模型 502' } } } });
  hub.onAgentStatus({ status: 'idle', agent: { id: 's2' } });
  eq('error 类型与正文', [out[0].kind, out[0].detail], ['error', '模型 502']);
  eq('finishedKind=error', hub.getFinishedKind('s2'), 'error');
}

{
  const { hub, out } = makeHub();
  hub.onSessionEvent({ id: 's3' }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  hub.onAgentStatus({ status: 'idle', agent: { id: 's3' } });
  eq('用户停止不发', out.length, 0);
}

{
  let root = false;
  const { hub, out } = makeHub({ isRoot: () => root });
  hub.onSessionEvent({ id: 'sub' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'x' } } } });
  hub.onAgentStatus({ status: 'idle', agent: { id: 'sub' } });
  eq('子会话不推', out.length, 0);
  root = true;
}

// ---- hub：工具调用等待 ----
{
  const { hub, out, fire } = makeHub();
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '选哪个？' }] }) } });
  eq('工具调用先延迟', out.length, 0);
  fire();
  eq('延迟后发 question', [out[0].kind, out[0].id, out[0].detail], ['question', 'tool:c1', '选哪个？']);
  // 回答：tool/result 不是 pending → 撤
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"answers":[]}' }] } } });
  eq('回答后撤通知', [out[1].kind, out[1].id], ['clear', 'tool:c1']);
}

{
  const { hub, out, fire } = makeHub();
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/call', data: { callId: 'c2', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 部署计划\n...' }) } });
  fire();
  eq('计划通知', [out[0].kind, out[0].detail], ['plan', '部署计划']);
}

{
  const { hub, out, fire } = makeHub();
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/call', data: { callId: 'c3', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '多久？' }] }) } });
  fire();
  // pending：问题仍可回答，不能撤
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/result', data: { message: { toolCallId: 'c3', content: [{ type: 'text', text: '{"pending":true}' }] } } });
  eq('pending 不撤', out.length, 1);
  // 之后用户回答 → user-question-reply 撤
  hub.onSessionEvent({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'c3' } } });
  eq('回答后撤', [out[1].kind, out[1].id], ['clear', 'tool:c3']);
}

{
  const { hub, out, fire, timers } = makeHub();
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/call', data: { callId: 'c4', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# X' }) } });
  // 工具立刻失败：result 先到，取消延迟
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/result', data: { message: { toolCallId: 'c4', content: [{ type: 'text', text: '{"error":"no"}' }] } } });
  eq('失败取消定时器', timers().length, 0);
  fire();
  eq('失败不弹', out.length, 0);
}

{
  const { hub, out, timers } = makeHub();
  hub.onSessionEvent({ id: 's1' }, { type: 'tool/call', data: { callId: 'c5', name: 'ask_user_question', arguments: '{}' } });
  eq('无问句不弹', [timers().length, out.length], [0, 0]);
  hub.dispose();
}

// ---- 断线补发缓冲（0.9.14） ----
// 手机断线/进程被杀期间结束的 turn 不能永久丢：网关重连时按 since 补发。
{
  const out = [];
  let clock = 1000;
  const hub = createPushHub({
    publish: (e) => out.push(e),
    now: () => clock,
    // 工具延迟定时器立即执行，测试不用等 800ms
    setTimeoutFn: (fn) => { fn(); return { unref() {} }; },
    clearTimeoutFn: () => {},
  });
  hub.onSessionEvent({ id: 's9' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  hub.onAgentStatus({ status: 'idle', agent: { id: 's9' } });
  eq('补发缓冲：完成帧进了缓冲', out.length, 1);
  eq('补发 since=0 拿得到', hub.getRecent(0).length, 1);
  eq('补发：since 等于 at 不重复给', hub.getRecent(1000).length, 0);
  eq('补发：since 早于 at 才给', hub.getRecent(999).length, 1);
  eq('补发帧带 id/kind', !!(hub.getRecent(999)[0].id === 's9:1000' && hub.getRecent(999)[0].kind === 'done'), true);

  // 撤通知（clear）不补发：补一条"撤销"对用户没有意义
  clock = 2000;
  hub.onSessionEvent({ id: 's9' }, { type: 'tool/call', data: { callId: 'c9', name: 'exit_plan_mode', arguments: '{"plan":"# 标题"}' } });
  hub.onSessionEvent({ id: 's9' }, { type: 'tool/result', data: { message: { toolCallId: 'c9', content: [{ type: 'text', text: 'ok' }] } } });
  const kinds = hub.getRecent(0).map((e) => e.kind);
  eq('补发里不含 clear', kinds.includes('clear'), false);
  eq('补发里有 plan 帧', kinds.includes('plan'), true);
  hub.dispose();
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
