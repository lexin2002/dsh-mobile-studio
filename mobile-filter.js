/**
 * 手机端插件过滤（白名单：勾选即放行）。
 *
 * 只看两件事：
 *   1. 首页 HTML 里注入的插件清单（__DSH_BOOT__）
 *   2. /plugins/?? 组合脚本里的每个插件代码段
 *
 * 规则：@deepseek-ai/ 开头的官方插件和本插件自己永远放行；
 * 专门做了兼容或不会影响移动端 UI 的插件（compat）进可勾列表、默认勾选、可手动关闭；
 * 其他第三方必须在放行名单里点名。名单存 ~/.dsh/mobile-studio/config.json，
 * 可在插件页面勾选，保存后立刻生效，不用重启。
 *
 * 为什么没有黑名单模式：手机端要回答的只有一个问题——谁能上。
 * 勾选=放行，不勾=不上；同一个开关不该有相反含义。
 *
 * 为什么必须在组合脚本上下刀：
 *   插件不是靠 HTML 里的 <link> 单独加载的，而是被服务端拼成一个
 *   `plugins/??a,b,c` 的大脚本。只删清单不删脚本，插件照样执行、
 *   照样往 document.head 里塞 CSS。实测过：只在 load() 里拦注册，
 *   最终 CSS 字节数与不过滤时一模一样（1,001,311）。
 *
 * 为什么 id 解析要认反引号：
 *   压缩过的第三方插件产物写成 load({id:`dsh-context`,...})，早期正则
 *   只认单双引号，解析失败就按「宁可多留」原样放行 —— dsh-context 的
 *   3MB 客户端代码就是这样漏进手机端的。三种引号都要认。
 */

/** 官方插件包名前缀。 */
const OFFICIAL = /^@deepseek-ai\/[a-z0-9][a-z0-9-]*$/;

/** 首次运行时的默认放行名单（之后以配置文件为准）。
 *
 * 这里只放「从 registry 装、但属于自己人」的插件。做了兼容的插件不写在这里 ——
 * 它们由 profile 里的 `link:` / `file:` 依赖自动识别（见 setLocal），
 * 除本体外进可勾列表并默认勾选（见 seedDefaults）。
 */
export const EXTRA = ['dsh-opencode-go', 'dsh-context'];

/** 本插件自己的 id：关掉它等于拆掉手机入口，所以永远放行、永不进可勾列表。 */
export const SELF = 'dsh-mobile-studio';

/** 做了兼容或不影响移动端 UI 的插件（profile 里用 link:/file: 装的）。 */
let localList = [];

/** 当前放行名单（第三方 + 做了兼容的插件）。 */
let allowList = EXTRA.slice();

/** 清洗名单：去空值、去重复、挡超长。 */
export function normalizeAllow(input) {
  const raw = Array.isArray(input) ? input : (input && Array.isArray(input.allow) ? input.allow : []);
  return raw
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x !== '' && x.length <= 200)
    .filter((x, i, a) => a.indexOf(x) === i);
}

/** 应用新名单（宿主启动读配置、页面保存都走这里）。 */
export function setAllow(input) {
  allowList = normalizeAllow(input);
  return allowList.slice();
}

/** 读当前名单。 */
export function getAllow() {
  return allowList.slice();
}

/** 登记做了兼容的插件（宿主启动时扫 profile 依赖得出）。 */
export function setLocal(input) {
  localList = normalizeAllow(input);
  return localList.slice();
}

/** 读兼容插件清单（link:/file: 扫到的）。 */
export function getLocal() {
  return localList.slice();
}

/** 一个插件 id 是否做了兼容（link:/file: 装的）。 */
export function isLocal(id) {
  return typeof id === 'string' && localList.includes(id);
}

/**
 * 做了兼容的插件：link:/file: 装的、但不是本体。进可勾列表，默认勾选，可手动关闭。
 * （本体 SELF 永远放行且永不进列表；官方走 isOfficial。）
 */
export function isCompat(id) {
  return isLocal(id) && id !== SELF;
}

/** 是否「不用点名就放行」：官方，或本插件自己。 */
export function isAlwaysAllowed(id) {
  return isOfficial(id) || id === SELF;
}

/** 判定一个插件是否允许出现在手机端。 */
export function allow(id) {
  if (typeof id !== 'string' || id === '') return false;
  return isAlwaysAllowed(id) || allowList.includes(id);
}

/**
 * 做了兼容的插件的默认勾选（一次性种子）。
 *
 * 背景：兼容插件以前走“本机永远放行”，没有开关；现在进列表可手动关闭，
 * 但升级前已有的放行状态不能断（以实际在用的为准，不抄任何写死的例子）。
 * 白名单仍是单一数组语义，不引入黑名单模式：
 *   - 配置里已有 seeded 标记 → 直接用存的数组，一个字不动；
 *   - 否则 → 存的数组 ∪ 当前兼容插件（全新安装时再并上 EXTRA 默认），
 *     调用方负责写回并打标记。之后增删全由用户勾选决定，种子只跑这一次；
 *     往后新出现的兼容插件默认不勾，需手动打开。
 */
export function seedDefaults(savedFilter, compat) {
  const marked = savedFilter && typeof savedFilter === 'object'
    && !Array.isArray(savedFilter) && savedFilter.seeded === true;
  if (marked) return { allow: normalizeAllow(savedFilter), writeBack: false };
  const cur = normalizeAllow(savedFilter == null ? [] : savedFilter);
  const seen = new Set(cur);
  const next = cur.slice();
  const push = (id) => {
    if (typeof id === 'string' && id !== '' && !seen.has(id)) { seen.add(id); next.push(id); }
  };
  // 全新安装（连 filter 段都没有）才补 EXTRA 默认；已有配置不动 EXTRA 的取舍
  if (savedFilter == null) EXTRA.forEach(push);
  (Array.isArray(compat) ? compat : []).forEach(push);
  return { allow: next, writeBack: true };
}

/** 一个插件 id 是否官方（页面展示用：官方项固定放行）。 */
export function isOfficial(id) {
  return typeof id === 'string' && OFFICIAL.test(id);
}

/** 组合脚本里每个插件段的固定开头。 */
const LOAD_MARKER = 'window.__ModuleLoader__.load({';

/**
 * 三种引号：官方产物用双引号，手写插件用单引号，压缩产物用反引号。
 * 不带 ^ 锚点：在段内全文搜（id 可能不在 load({ 紧后面，240 字窗口会漏）。
 */
const ID_RE = /id:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/;

/**
 * 判定一个 marker 是否确信在注释里（误杀才删，存疑一律保留）。
 *
 * 背景有两笔账：
 * 1. bootstrap 包（dsh-client-modules，单段 46KB）注释文档里写着 load({id, factory})
 *    当例子，naive 切段把它当第二段开头，真文件拦腰截断，手机端只剩 880 字节 →
 *    整页报 "HTML did not preload ..."（2026-10-23 真机）。
 * 2. 全文件扫注释/字符串区间更危险：正则里的引号（如 /'/g）会带偏扫描吞掉真分段，
 *    两段合并前段是官方 id 就整段放行，第三方皮肤漏进手机端点击返回互斥全错
 *    （2026-10-23 回归事故，已回滚该做法）。
 * 所以只做局部判定，且只删"无 id 的段"：真段 id 紧挨 load({，有 id 的段一律不动。
 */
function isInComment(src, pos) {
  const open = src.lastIndexOf('/*', pos - 1);
  if (open >= 0) {
    const close = src.indexOf('*/', open + 2);
    if (close < 0 || close > pos) {
      const ols = src.lastIndexOf('\n', open) + 1;
      const ofrag = src.slice(ols, open);
      if (ofrag.indexOf('"') < 0 && ofrag.indexOf("'") < 0 && ofrag.indexOf('\x60') < 0 && ofrag.indexOf('//') < 0) return true;
    }
  }
  const ls = src.lastIndexOf('\n', pos - 1) + 1;
  const frag = src.slice(ls, pos);
  if (frag.indexOf('\x60') >= 0) return false;
  const stripped = frag.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '');
  if (stripped.indexOf('//') >= 0) return true;
  return false;
}

/**
 * 切出组合脚本里的每个插件段。
 * 在段内全文搜 id（不再只看头 240 字）；搜不到的段 id 为 null，
 * 由 filterCombo 按「可疑即过滤」处理。
 * 无 id 且确信在注释里的 mark 视为文档例子直接丢掉（bootstrap 那一例）；
 * 其余一律保留以前的切法，有 id 的段一个不动。
 * @param src 组合脚本全文
 * @returns 每段的起止下标与插件 id（id 解析失败时为 null）
 */
export function segments(src) {
  const marks = [];
  let at = src.indexOf(LOAD_MARKER);
  while (at >= 0) {
    marks.push(at);
    at = src.indexOf(LOAD_MARKER, at + LOAD_MARKER.length);
  }
  const kept = marks.filter((pos, i) => {
    const end = i + 1 < marks.length ? marks[i + 1] : src.length;
    if (ID_RE.exec(src.slice(pos, end))) return true;
    return !isInComment(src, pos);
  });
  const finalMarks = kept.length > 0 ? kept : marks;
  return finalMarks.map((start, i) => {
    const end = i + 1 < finalMarks.length ? finalMarks[i + 1] : src.length;
    const m = ID_RE.exec(src.slice(start, end));
    return { start, end, id: m ? (m[1] || m[2] || m[3]) : null };
  });
}

/**
 * 被滤掉的插件段输出什么。
 *
 * 必须是空模块桩，不能是纯注释 —— 真机实测的教训（设置→内置插件页满屏红字）：
 *   设置页按已装清单逐个拉 `plugins/??<id>/client.js&rev=...` 单文件组合脚本，
 *   加载器（client-modules）以“脚本执行后有没有调 __ModuleLoader__.load 注册该 id”
 *   判定成功。纯注释执行后无注册，整条链报错：
 *     先 `loaded without registering`（真机图一），再由兜底空对象触发
 *     `invalid plugin, expect function or object with an "apply" method,
 *     received object`（无头复现，shots-panels/3-builtin.png）。
 *   空桩调一次 load 注册“带空 apply 的模块”：两道校验都闭嘴，不执行任何插件代码、
 *   不注入任何 CSS，体积指纹不变，桌面端不受影响（Referer 非 /m 的请求根本不进这里）。
 */
function stubFor(id) {
  const safe = String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `window.__ModuleLoader__.load({id:"${safe}",factory:function(){return {apply:function(){}};}});\n`;
}

/**
 * 剥掉组合脚本里所有不允许的插件段。
 *
 * 可疑即过滤：id 解析不出来的段也剥掉（输出空模块桩），不再原样保留。
 * 以前 fail-open 按「宁可多留」放行，结果压缩产物的段一漏就是整个插件
 * （dsh-context 的 3MB 客户端代码就是这么漏进手机端的）。桩的 id 用
 * 占位名，保证加载器「调过 load 注册」校验通过，且不与真插件重名。
 * @param src 组合脚本全文
 * @returns 过滤后的脚本，与统计信息（dropped 里 id 解析失败的记
 *   `(unparsed@偏移)`，调用方打日志时能看到）
 */
/**
 * 从 open（指向 `{`）起找配对的 `}`，跳过单双引号、模板串与注释。
 * 找不到返回 -1。
 */
function matchBrace(src, open) {
  let depth = 0;
  let i = open;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      if (nl < 0) return -1;
      i = nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * 插件产物外面那层包装（`;(()=>{ …load(…)… })();`）。
 *
 * 为什么非要知道它：真机产物（dsh-pet 实测 208,035 字节）是
 *   `;(()=>{ <200KB 代码> … window.__ModuleLoader__.load({...}); })();`
 * 旧实现把「load 调用」当成段的**开头**、到 EOF 当结尾，于是连带删掉了
 * 收尾的 `}` 和 `})();` —— 文件在函数中间断掉，整页报
 * `SyntaxError: Unexpected end of input`（用户 2026-10-27「刷新后报错」）。
 * 正确做法：整块 IIFE 一起换掉。
 */
/** IIFE 收尾：`}` 之后吞掉 `)()` 和 `;`（`})();` 完整形态）。 */
function afterWrapperClose(src, close) {
  let i = close + 1;
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i += 1; };
  skip();
  if (src[i] === ')') {
    i += 1;
    skip();
    if (src[i] === '(') {
      i += 1;
      skip();
      if (src[i] === ')') { i += 1; skip(); }
    }
  }
  if (src[i] === ';') i += 1;
  return i;
}

/**
 * 单个 load 调用的结尾（裸调用形态：`window.__ModuleLoader__.load({…});`）。
 * 形状对不上就返回 -1 —— 调用方据此**放弃切割**，宁可少删一个插件，
 * 也绝不切出一个语法坏掉的文件。插件代码里的正则/模板串里的花括号
 * 会让 matchBrace 判断失误，这时唯一安全的动作是不切。
 */
function callEnd(src, marker) {
  const open = src.indexOf('{', marker);
  if (open < 0) return -1;
  const close = matchBrace(src, open);
  if (close < 0 || close <= open) return -1;
  let i = close + 1;
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i += 1; };
  skip();
  if (src[i] !== ')') return -1; // `load({…}` 后面必须是 ')'，否则说明配对错了
  i += 1;
  skip();
  if (src[i] === ';') i += 1;
  return i;
}

/**
 * 语法自检：改过就必须仍是合法脚本，否则宁可原样放行。
 *
 * 为什么要有它：这一段已经两次因为"猜段边界"把手机页整体搞崩
 * （2026-10-23 的 880 字节截断、2026-10-27 的 Unexpected end of input）。
 * 只要产物解析不过，就不许发出去 —— 兜底方向是"放行"（页面能用、
 * 可能多上几个插件），不是"崩页"。
 */
function parses(body) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * marker 最近的外层 IIFE（`;(()=>{ … })();`），没有就返回 null。
 * 只在有限回看窗口内找最近的几种写法：整包扫描 + 逐个配对在 7MB 上的代价不可接受，
 * 而包装层一定紧贴在本插件代码之前（同一插件 < 250KB）。
 */
const WRAP_NEEDLES = ['(()=>{', '(function(){', '(function (){', '(function('];

function enclosingWrapper(src, marker) {
  const from = Math.max(0, marker - 400000);
  let best = -1;
  for (const needle of WRAP_NEEDLES) {
    const i = src.lastIndexOf(needle, marker);
    if (i >= from && i > best) best = i;
  }
  if (best < 0) return null;
  let open = src.indexOf('{', best);
  if (open < 0 || open > marker) return null;
  const close = matchBrace(src, open);
  if (close <= marker) return null;
  return { start: best, open, close };
}

/**
 * 按给定策略切段并重组。
 *
 * mode='struct'：裸调用以**下一个 marker** 为界（纯结构，最稳）；
 * mode='call'  ：只切这次 load 调用本身（花括号配对）。
 * 被 IIFE 包着的插件两种模式都整块换（`})();` 绝不能被吃掉）。
 */
function build(src, marks, mode) {
  const wraps = marks.map((m) => enclosingWrapper(src, m));
  // 段的起点先算齐，再让相邻段互不重叠：包装层的起点可能落在上一段里，
  // 上一段必须在它之前收住，否则同一块代码会被切两次（语法过得去、但会重复执行）。
  const starts = marks.map((m, k) => {
    const w = wraps[k];
    const s = w ? w.start : m;
    return k > 0 ? Math.max(s, marks[k - 1] + 1) : s;
  });
  for (let k = 1; k < starts.length; k += 1) {
    if (starts[k] < starts[k - 1]) starts[k] = starts[k - 1];
  }

  const spans = [];
  const unsafe = [];
  for (let k = 0; k < marks.length; k += 1) {
    const marker = marks[k];
    const w = wraps[k];
    const start = starts[k];
    const ce = callEnd(src, marker);
    // id 只从**这次 load 调用**里取：包装层的代码里可能有 `id: "FALLBACK"`，
    // 无锚点的 ID_RE 会先命中它，导致桩注册错 id（dsh-pet 真机实测）。
    const callText = src.slice(marker, ce > marker ? ce : Math.min(src.length, marker + 400));
    const im = ID_RE.exec(callText);
    const id = im ? (im[1] || im[2] || im[3]) : null;

    let end;
    if (w) {
      end = afterWrapperClose(src, w.close);
    } else if (mode === 'struct') {
      end = k + 1 < marks.length ? starts[k + 1] : src.length;
    } else if (ce > marker) {
      end = ce;
    } else {
      unsafe.push('no-call-end@' + marker + ' ' + src.slice(marker, marker + 90).replace(/\s+/g, ' '));
      continue;
    }
    // 同一包装层里的第二个 marker：并进上一段（不能再切一次）
    if (spans.length && start <= spans[spans.length - 1].start) {
      spans[spans.length - 1].ids.push(id);
      continue;
    }
    if (end <= start) {
      unsafe.push('end<=start@' + start + ':' + end + ' wrap=' + (w ? 'y' : 'n') + ' ' + src.slice(marker, marker + 90).replace(/\s+/g, ' '));
      continue;
    }
    spans.push({ start, end, ids: [id] });
  }

  const parts = [];
  const dropped = [];
  let c = 0;
  for (const s of spans) {
    if (s.start > c) parts.push(src.slice(c, s.start));
    const bad = s.ids.find((id) => id === null || !allow(id));
    if (bad === undefined) {
      parts.push(src.slice(s.start, s.end));
    } else {
      dropped.push(bad === null ? `(unparsed@${s.start})` : bad);
      parts.push(stubFor(bad ?? `__ms_filtered_${dropped.length}`));
    }
    c = s.end;
  }
  if (c < src.length) parts.push(src.slice(c));
  return { body: parts.join(''), dropped, unsafe };
}

/**
 * 剥掉组合脚本里所有不允许的插件。
 *
 * 真机产物有两种形态，都得支持：
 *   A) 裸平铺：`load({...});\nload({...});`（29 个插件的大包）
 *   B) IIFE 包装：`;(()=>{ …200KB 代码… load({...}); })();`（dsh-pet）
 * 旧实现把 load 当"段开头"、到 EOF 当结尾，B 形态会连带删掉 `})();` 的收尾，
 * 整个文件在函数中断掉 → `SyntaxError: Unexpected end of input`（用户 2026-10-27）。
 *
 * 组装后必须通过语法检查；不通过就换一种切法，仍不行则**原样放行**（fail-open）：
 * 宁可多上几个插件，也绝不能把手机页搞崩。
 */
export function filterCombo(src, only) {
  const marks = [];
  let at = src.indexOf(LOAD_MARKER);
  while (at >= 0) {
    // 注释里的 marker 是文档例子，不是插件（bootstrap 包实测：注释写着
    // `window.__ModuleLoader__.load({id, factory})`，当成真段会把 46KB 拦腰切断）。
    if (!isInComment(src, at)) marks.push(at);
    at = src.indexOf(LOAD_MARKER, at + LOAD_MARKER.length);
  }
  if (marks.length === 0) return { body: src, dropped: [] };

  const modes = only ? [only] : ['struct', 'call'];
  let last = null;
  for (const mode of modes) {
    const r = build(src, marks, mode);
    last = r;
    if (r.dropped.length === 0) return r; // 没删东西，原样返回
    if (parses(r.body)) return r;
  }
  if (only) return last;
  return { body: src, dropped: [], fallback: true, unsafe: last ? last.unsafe : [] };
}

/** 在 HTML 里定位 `globalThis["__DSH_BOOT__"] = {...}` 的对象边界（导出给校验脚本用）。 */
export function bootBounds(html) {
  const at = html.indexOf('globalThis["__DSH_BOOT__"] = ');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

/** 最近一次在 HTML 里见到的插件清单（页面展示「已安装」用）。 */
let seenIds = [];

/** 读最近一次见到的插件清单。 */
export function lastSeen() {
  return seenIds.slice();
}

/** 记住一份完整清单（先于过滤，所以包含被拦的插件）。 */
function remember(ids) {
  const merged = new Set(seenIds);
  for (const id of ids) if (typeof id === 'string' && id !== '') merged.add(id);
  seenIds = [...merged].slice(0, 500);
}

/**
 * 裁掉首页注入清单里不允许的插件。
 * @param html 服务端渲染出的完整 HTML
 * @returns 过滤后的 HTML，与移除的插件 id
 */
export function filterHtml(html) {
  const bounds = bootBounds(html);
  if (bounds === null) return { body: html, dropped: [] };

  let boot;
  try {
    boot = JSON.parse(html.slice(bounds.start, bounds.end));
  } catch {
    return { body: html, dropped: [] };
  }

  const all = (boot.entries || []).map((e) => e && e.id).filter((id) => typeof id === 'string');
  for (const batch of boot.batches ?? []) {
    if (Array.isArray(batch.entries)) all.push(...batch.entries.filter((id) => typeof id === 'string'));
  }
  remember(all);

  // entries 和 batches 都要按同一条规则过，不能只清其中一个：
  // 前端按 batches 分组加载时，batch 里残留的 id 会让它继续被 import。
  // dropped 只收字符串：entries 里可能混着 null/数字/对象，直 push 会让
  // 调用方的 join 打出 [object Object]，日志就没法看了。
  const dropped = new Set();
  boot.entries = (boot.entries || []).filter((e) => {
    if (allow(e && e.id)) return true;
    const id = e && e.id;
    if (typeof id === 'string' && id !== '') dropped.add(id);
    return false;
  });
  for (const batch of boot.batches ?? []) {
    if (!Array.isArray(batch.entries)) continue;
    batch.entries = batch.entries.filter((id) => {
      if (allow(id)) return true;
      if (typeof id === 'string' && id !== '') dropped.add(id);
      return false;
    });
  }
  if (dropped.size === 0) return { body: html, dropped: [] };

  const rebuilt = html.slice(0, bounds.start) + JSON.stringify(boot) + html.slice(bounds.end);
  return { body: rebuilt, dropped: [...dropped] };
}

/*
 * 关于 preload / batch.url：**不要改组合脚本的 URL**。
 *
 * 官方 URL 形如 `plugins/??a/client.js,b/client.js&rev=xxxx`，服务端按
 * 自己的批次清单核对 rev；把列表裁短（或去掉 rev）后请求直接 404，
 * 实测 cut -> 404、cut-no-rev -> 404、原样 -> 200 (3.1MB)。
 * 所以这里只在响应体上下刀（filterCombo），URL 一个字都不动。
 */

/** 把相对 base 改成根 base，让 /m 和 /m/ 下的资源都落到 /assets、/plugins。 */
export function rebase(html) {
  if (!/<base\s[^>]*href="\.\/"/i.test(html)) return html;
  return html.replace(/<base(\s[^>]*?)href="\.\/"/i, '<base$1href="/"');
}
