/**
 * 手机推送的“要不要提醒、提醒什么”纯逻辑。
 *
 * 这里只做三件事：把 turn 结束原因分成可通知的类型、从工具调用参数里
 * 认出计划评审/提问、把事件收敛成一条 SSE 帧要用的字段。真正的网络和
 * 通知都在 lan.js / 安卓壳里，所以这个文件可以脱开 DSH 单测。
 *
 * 为什么不能只看 agent/status：计划评审和 ask_user_question 是工具调用
 * 内部的等待，turn 还在 running，根本不会 idle；等到 idle 时用户已经
 * 卡在会话里了。
 */

/** 工具调用先压 800ms：若调用立刻失败（缺少交互通道、不在计划模式），
 *  tool/result 会先到并取消，不会误弹一条“计划待批”。 */
export const TOOL_DELAY_MS = 800;

/** 通知正文有长度上限：锁屏上堆几十行没有意义，完整内容在 App 里。 */
const DETAIL_MAX = 160;

/** 重放缓冲：手机断线/被杀时错过的推送，重连时按 since 补发。 */
const RECENT_MAX = 200;

const trimText = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX);

const isObject = (value) => typeof value === 'object' && value !== null;

/**
 * 把 `turn/end.data.reason` 翻成推送类型。
 * @param {object|undefined} reason
 * @returns {{kind: string, detail: string}|null} null 表示这次结束不该打扰用户
 */
export function classifyTurn(reason) {
  if (!isObject(reason)) return { kind: 'done', detail: '' };
  switch (reason.kind) {
    case 'completed':
      return { kind: 'done', detail: '' };
    case 'error':
      return {
        kind: 'error',
        detail: trimText(reason.error?.message || reason.error?.code || ''),
      };
    case 'aborted': {
      const cause = reason.reason?.kind;
      // 用户自己按停止 / DSH 正常退出：他本来就知道，不再弹。
      if (cause === 'user' || cause === 'disposed') return null;
      return {
        kind: 'interrupted',
        detail: cause === 'parent' ? '上级任务中止' : '任务被中断',
      };
    }
    case 'interrupted':
      return { kind: 'interrupted', detail: '任务被中断' };
    case 'blocked':
      return { kind: 'blocked', detail: '前置步骤未通过' };
    case 'max-tokens':
      return { kind: 'max-tokens', detail: '输出达到上限' };
    case 'forked':
      // 只存在于 fork 种子的历史里，不是一次真实的结束。
      return null;
    default:
      return { kind: 'interrupted', detail: '' };
  }
}

/**
 * 判断某个工具调用是不是“在等人”。
 * @param {string} name 工具名
 * @param {string|object} argumentsText 记录下来的参数
 * @returns {{kind: 'plan'|'question', detail: string}|null}
 */
export function describeToolCall(name, argumentsText) {
  if (name !== 'exit_plan_mode' && name !== 'ask_user_question') return null;
  let args = argumentsText;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!isObject(args)) return null;

  if (name === 'exit_plan_mode') {
    const plan = typeof args.plan === 'string' ? args.plan : '';
    if (plan.trim() === '') return null;
    // 计划很长，通知里只放第一个标题；完整计划在 App 的评审页里。
    const heading = plan.match(/^#\s+(.+)$/m)?.[1] || '';
    return { kind: 'plan', detail: trimText(heading.replace(/\s+#+\s*$/, '')) };
  }

  const questions = Array.isArray(args.questions) ? args.questions : [];
  const first = questions.find((item) => isObject(item) && typeof item.question === 'string');
  if (!first) return null;
  const extra = questions.length > 1 ? `（共 ${questions.length} 个问题）` : '';
  return { kind: 'question', detail: trimText(first.question + extra) };
}

/** `tool/result` 里的 `{pending:true}` 表示限时提问超时，但问题仍然可回答。 */
function isPendingResult(content) {
  let text = '';
  if (Array.isArray(content)) {
    const block = content.find((item) => isObject(item) && item.type === 'text');
    text = block?.text ?? '';
  } else if (typeof content === 'string') {
    text = content;
  }
  if (text === '') return false;
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) && parsed.pending === true;
  } catch {
    return false;
  }
}

function firstKey(map) {
  return map.keys().next().value;
}

/**
 * 把宿主事件收敛成推送帧。
 *
 * 所有通知都只在 `agent/status → idle` 时发（完成/失败都一样），
 * 但类型取最近一次 `turn/end` 的 reason；这样同一 agent 连续跑多轮时
 * 不会在第一轮结束就提前庆祝。
 */
export function createPushHub({
  publish = () => {},
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  isRoot = () => true,
} = {}) {
  /** sessionId → {at, kind, detail}：最近一次 turn 的结束，等 idle 再发。 */
  const lastEnd = new Map();
  /** sessionId → 已发出的完成/失败 at，防 maintenance 重复。 */
  const lastPublished = new Map();
  /** sessionId → {at, kind}：给 /m/__ms/tasks 轮询兜底。 */
  const finished = new Map();
  /** callId → timer：还没轮到发通知的工具调用。 */
  const toolTimers = new Map();
  /** callId → 已发通知的帧字段：tool/result 或回答后要撤。 */
  const openTools = new Map();
  /**
   * 最近发过的帧（重放用）。
   *
   * 为什么要有：SSE 是"只有现场"的长连接，手机断线/进程被杀的那几秒里
   * 结束的 turn 会永久丢掉 —— 用户看到的就是"通知时有时无"。
   * 重连时带上 since，把这段空窗补发一次，成功率就不再靠运气。
   */
  const recent = [];

  const emit = (event) => {
    try {
      recent.push(event);
      while (recent.length > RECENT_MAX) recent.shift();
    } catch {
      /* 缓冲失败绝不能影响推送 */
    }
    publish(event);
  };

  /** 按时间补发：`at > sinceMs` 的帧，跳过 clear（撤通知补发没有意义）。 */
  const getRecent = (sinceMs) => {
    const since = Number(sinceMs) || 0;
    const out = [];
    for (const ev of recent) {
      if (!ev || ev.kind === 'clear') continue;
      if ((Number(ev.at) || 0) <= since) continue;
      out.push(ev);
    }
    return out.slice(-50);
  };

  const trim = (map) => {
    while (map.size > 200) {
      const key = firstKey(map);
      if (key === undefined) break;
      map.delete(key);
    }
  };

  const noteFinished = (id, at, kind) => {
    finished.set(String(id), { at: Number(at) || 0, kind: String(kind || '') });
    trim(finished);
  };

  const publishClear = (callId, entry) => {
    emit({
      id: entry.id,
      kind: 'clear',
      sessionId: entry.sessionId,
      at: now(),
      detail: '',
    });
    openTools.delete(callId);
  };

  const cancelToolTimer = (callId) => {
    const timer = toolTimers.get(callId);
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      toolTimers.delete(callId);
    }
  };

  const onToolCall = (sid, callId, info) => {
    if (!callId || toolTimers.has(callId) || openTools.has(callId)) return;
    const timer = setTimeoutFn(() => {
      toolTimers.delete(callId);
      const entry = {
        id: 'tool:' + callId,
        kind: info.kind,
        sessionId: sid,
        at: now(),
        detail: info.detail,
      };
      openTools.set(callId, entry);
      emit(entry);
    }, TOOL_DELAY_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    toolTimers.set(callId, timer);
  };

  const onToolResult = (callId, content) => {
    if (!callId) return;
    cancelToolTimer(callId);
    if (!openTools.has(callId)) return;
    // pending = 超时但问题还挂在会话里，不能撤通知；真正回答后走
    // user-question-reply 那条路再撤。
    if (isPendingResult(content)) return;
    publishClear(callId, openTools.get(callId));
  };

  const onSessionEvent = (session, event) => {
    if (!event || typeof event.type !== 'string') return;
    const sid = session?.id === undefined ? '' : String(session.id);
    if (sid === '') return;
    try {
      if (!isRoot(session)) return;

      if (event.type === 'turn/end') {
        const info = classifyTurn(event.data?.reason);
        if (!info) return;
        lastEnd.set(sid, { at: now(), kind: info.kind, detail: info.detail });
        trim(lastEnd);
        return;
      }

      if (event.type === 'tool/call') {
        const info = describeToolCall(event.data?.name, event.data?.arguments);
        if (!info) return;
        onToolCall(sid, String(event.data?.callId || ''), info);
        return;
      }

      if (event.type === 'tool/result') {
        onToolResult(String(event.data?.message?.toolCallId || ''), event.data?.message?.content);
        return;
      }

      if (event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply') {
        const callId = String(event.data.source.callId || '');
        if (!callId) return;
        cancelToolTimer(callId);
        if (openTools.has(callId)) publishClear(callId, openTools.get(callId));
      }
    } catch {
      // 推送判定永远不能影响宿主；单条事件坏了就跳过。
    }
  };

  const onAgentStatus = (payload) => {
    try {
      if (!payload || payload.status !== 'idle') return;
      const id = payload.agent?.id === undefined ? '' : String(payload.agent.id);
      if (id === '') return;
      const end = lastEnd.get(id);
      if (!end) return;
      if (end.at <= (lastPublished.get(id) || 0)) return;
      lastEnd.delete(id);
      lastPublished.set(id, end.at);
      trim(lastPublished);
      noteFinished(id, end.at, end.kind);
      emit({
        id: id + ':' + end.at,
        kind: end.kind,
        sessionId: id,
        at: end.at,
        detail: end.detail,
      });
    } catch {
      // 同上：通知失败不能影响宿主。
    }
  };

  const getFinishedAt = (id) => finished.get(String(id))?.at || 0;
  const getFinishedKind = (id) => finished.get(String(id))?.kind || '';

  const dispose = () => {
    for (const timer of toolTimers.values()) clearTimeoutFn(timer);
    toolTimers.clear();
    openTools.clear();
  };

  return {
    onSessionEvent,
    onAgentStatus,
    getFinishedAt,
    getFinishedKind,
    getRecent,
    dispose,
  };
}
