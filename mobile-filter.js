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
export function filterCombo(src) {
  const list = segments(src);
  if (list.length === 0) return { body: src, dropped: [] };

  const parts = [];
  const dropped = [];
  if (list[0].start > 0) parts.push(src.slice(0, list[0].start));

  for (const seg of list) {
    const body = src.slice(seg.start, seg.end);
    if (seg.id !== null && allow(seg.id)) {
      parts.push(body);
      continue;
    }
    dropped.push(seg.id === null ? `(unparsed@${seg.start})` : seg.id);
    parts.push(stubFor(seg.id ?? `__ms_filtered_${dropped.length}`));
  }
  return { body: parts.join(''), dropped };
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
