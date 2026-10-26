/**
 * mobile-studio 局域网网关。
 *
 * 为什么需要它：
 *   DSH 桌面版固定 `--host 127.0.0.1`（dsh-desktop-host/lib/index.js:234-239），
 *   手机在物理上连不上；且 dsh-client-connection 的 Host 校验
 *   （lib/index.js:240-250）只放行 loopback / bind 地址 / trustedHosts，
 *   即使改绑局域网 IP，Host 头是局域网 IP 时 /api 依然被拒。
 *
 * 做法：
 *   在 0.0.0.0:<port> 起反向代理，把所有请求的 Host/Origin/Referer
 *   改写成上游自己的 authority，于是 DSH 眼里所有请求都来自本机。
 *   浏览器地址栏始终是 `http://<局域网IP>:<port>/`，不含 token、不含密码。
 *
 * 登录凭据由网关独占（这是关键，也是踩过的坑）：
 *   DSH 的 cookie 名是 `dsh-auth-<hash(authority)>`，authority 含端口，
 *   而桌面版每次启动端口都不同 —— 所以「浏览器里有个旧 dsh-auth-*」
 *   绝不等于「已登录」。之前按 cookie 存在与否判断，导致：
 *     旧 cookie 命中判断 → 转发 → 上游 401 → 网关换票 → 302 回 / → 又命中 → 死循环，
 *   手机上表现为 ERR_TOO_MANY_REDIRECTS。
 *
 *   现在改成：网关自己持有 DSH cookie，浏览器侧的 dsh-auth-* 一律剥掉。
 *   上游 401 时网关就地刷新凭据并重试同一次请求，**不向浏览器发重定向**，
 *   因此结构上不可能再出现循环。
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { filterCombo, filterHtml, rebase } from './mobile-filter.js';
import { isValidQrToken, isValidSession, sessionCookie, verifyPassword } from './auth.js';

/** 登录页（内联样式，不依赖任何外部资源，未登录也能打开）。 */
function loginPage({ next, error, enabled }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DSH 手机端 · 登录</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f6f7f9; color: #1f2328; }
  .card { width: 100%; max-width: 340px; background: #fff; border: 1px solid #e5e7eb; border-radius: 16px;
          padding: 28px 24px; box-shadow: 0 8px 28px rgba(15, 23, 42, .06); }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
  p { margin: 0 0 20px; font-size: 13px; color: #6b7280; }
  label { display: block; font-size: 12.5px; color: #4b5563; margin: 0 0 6px; }
  input { width: 100%; padding: 11px 13px; font: inherit; font-size: 15px; border: 1px solid #d1d5db;
          border-radius: 10px; background: #fff; color: inherit; outline: none; }
  input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }
  button { width: 100%; margin-top: 16px; padding: 12px; font: inherit; font-size: 15px; font-weight: 600;
           color: #fff; background: #2563eb; border: 0; border-radius: 10px; cursor: pointer; }
  button:active { transform: scale(.99); }
  .err { margin: 12px 0 0; padding: 9px 11px; border-radius: 8px; font-size: 12.5px;
         background: #fef2f2; color: #b91c1c; }
  .hint { margin: 16px 0 0; font-size: 11.5px; color: #9ca3af; text-align: center; }
</style></head>
<body><div class="card">
  <h1>输入访问密码</h1>
  <p>这台电脑用密码保护了手机端入口。</p>
  ${enabled ? '' : '<p>（密码未启用）</p>'}
  <form method="post" action="/__ms/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="pw">密码</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">进入</button>
  </form>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <p class="hint">登录状态保留 30 天，可在电脑端「移动端访问」页面修改或关闭密码。</p>
</div></body></html>`;
}

/** 只允许站内相对路径，防开放重定向。 */
function safeNext(raw) {
  const v = typeof raw === 'string' ? raw : '';
  if (v === '' || v[0] !== '/' || v.startsWith('//') || v.startsWith('/__ms/login')) return '/m';
  return v;
}

/** 读很小的请求体（登录表单只有几十字节）。 */
function readSmallBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    const done = (v) => resolve(v);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { done(''); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(''));
  });
}

// ---------------- 登录限流（防爆破） ----------------
// 内存失败计数：同一 IP 连续失败 5 次后指数退避（30s→60s→120s…封顶 10 分钟），
// 退避期内直接 429 + Retry-After，且不再做 scrypt 校验（省 CPU）。
// 成功一次就清零。网关单进程，内存 Map 够用；只防同一 WiFi 下的胡试，
// 不防分布式（家用场景够了）。
const LOGIN_FREE_TRIES = 5;
const LOGIN_BASE_BACKOFF_MS = 30 * 1000;
const LOGIN_MAX_BACKOFF_MS = 10 * 60 * 1000;
const loginFail = new Map(); // ip -> { count, until }

function loginBackoffMs(count) {
  const over = Math.max(0, count - LOGIN_FREE_TRIES);
  if (over <= 0) return 0;
  return Math.min(LOGIN_BASE_BACKOFF_MS * 2 ** (over - 1), LOGIN_MAX_BACKOFF_MS);
}

function loginBlockedMs(ip) {
  const st = loginFail.get(ip);
  if (!st) return 0;
  const left = st.until - Date.now();
  // 注意：过期只返回 0、不删记录 —— 前 LOGIN_FREE_TRIES 次退避是 0，
  // 删了会导致计数永远从 1 开始、攒不到触发阈值。成功会清零，
  // 超上限时 loginRecord 会批量清理，Map 不会无限长大。
  return left > 0 ? left : 0;
}

function loginRecord(ip, ok) {
  if (ok) { loginFail.delete(ip); return; }
  const prev = loginFail.get(ip);
  const count = (prev ? prev.count : 0) + 1;
  const backoff = loginBackoffMs(count);
  // Map 设上限防无限长大：超了就把最早的整批清掉一半。
  if (loginFail.size > 2000) {
    let n = 0;
    for (const k of loginFail.keys()) {
      loginFail.delete(k);
      if (++n >= 1000) break;
    }
  }
  loginFail.set(ip, { count, until: Date.now() + backoff });
}

/** 取本机第一个可用的局域网 IPv4。 */
export function lanAddress() {
  let best = null;
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        const ip = info.address;
        // 虚拟网卡（WSL / Hyper-V / Docker）先记下，但优先真实局域网
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
          if (!best) best = ip;
          continue;
        }
        if (/^(10\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) return ip;
        if (!best) best = ip;
      }
    }
  } catch {
    /* noop */
  }
  return best;
}

/** 去掉 Cookie 头里的 dsh-auth-*，只保留浏览器自己的其它 cookie。 */
function stripDshCookies(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return '';
  return cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !/^dsh-auth-/.test(s))
    .join('; ');
}

/** 从 Set-Cookie 里取出 name=value，作为网关持有的凭据。 */
function extractDshCookie(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of list) {
    const first = String(line).split(';', 1)[0].trim();
    if (/^dsh-auth-[^=]+=/.test(first)) return first;
  }
  return null;
}

/**
 * 把上游 session/list 的 items 裁成任务摘要。
 * 只要 App 判定“完成”够用的字段：id、标题、是否运行中、更新时间、轮数。
 * 按 updatedAt 倒序取前 30 —— 列表再长，手机也只关心最近的。
 * 纯函数，单元测试直接调（见 tools/test-tasks-digest.mjs）。
 */
export function summarizeSessions(items, finishedAtOf, finishedKindOf) {
  const fin = typeof finishedAtOf === 'function' ? finishedAtOf : () => 0;
  const finKind = typeof finishedKindOf === 'function' ? finishedKindOf : () => '';
  if (!Array.isArray(items)) return [];
  return items
    .filter((s) => s && typeof s.sessionId === 'string')
    .map((s) => ({
      id: s.sessionId,
      title: (s.projections && s.projections.values && s.projections.values.title) || null,
      running: s.running === true,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
      turns: (s.projections && s.projections.values && s.projections.values.sessionStats
        && s.projections.values.sessionStats.turns) || 0,
      // 这一轮**结束**的精确时刻（宿主 agent/status → idle 打的点）。
      // App 靠它比大小判完成，不再靠 running 翻转：轮询间隔里开始又结束的
      // 短任务，翻转判定会整条漏掉（这是"通知时有时无"的根因）。
      finishedAt: Number(fin(s.sessionId)) || 0,
      // 结束类型：completed/error/interrupted/...；轮询兜底据此换标题，
      // 不能把一次出错说成“任务完成”。
      finishedKind: String(finKind(s.sessionId) || ''),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
}

/**
 * 启动网关。
 * @param {object} opts
 * @param {number} opts.listenPort
 * @param {number} [opts.portAttempts] 端口被占用时最多顺延几个（默认 1 = 不顺延）
 * @param {string} opts.upstreamHost
 * @param {number} opts.upstreamPort
 * @param {string} [opts.bindHost]
 * @param {() => string|null} [opts.getLaunchToken] 宿主回调：当前进程有效的 token
 * @param {() => object|null} [opts.getAuth] 宿主回调：当前密码配置（enabled/salt/hash/secret）
 * @param {(msg: string) => void} [opts.log]
 */
export function startLanGateway({
  listenPort,
  portAttempts = 1,
  upstreamHost,
  upstreamPort,
  bindHost = '0.0.0.0',
  getLaunchToken = () => null,
  getAuth = () => null,
  getFinishedAt = () => 0,
  getFinishedKind = () => '',
  getRecentEvents = null,
  subscribeEvents = null,
  log = () => {},
}) {
  const upstreamAuthority = `${upstreamHost}:${upstreamPort}`;
  const upstreamOrigin = `http://${upstreamAuthority}`;

  /*
   * 推送通道（SSE）：/m/__ms/push
   *
   * 为什么是 SSE 而不是复用它上层的 WebSocket：
   *   - 那是官方客户端内部协议，路径和一帧里的结构随版本变，不该拿来当我们的通道；
   *   - SSE 就是一条不结束的 text/event-stream 响应，两端都不需要库：
   *     手机侧 HttpURLConnection 逐行读就行，比 WS 握手/分帧少两百行。
   * 鉴权走网关同一套 cookie 门禁（和 /m/__ms/tasks、/m/__ms/hello 一致）。
   * 心跳每 20 秒一行注释，既保活也让手机侧能判"连接还活着"。
   */
  const sseClients = new Set();
  const HEARTBEAT_MS = 20000;
  /**
   * sessionId → {title, at}（推送帧要带标题，省得每帧都问上游）。
   * 用 TTL 而不是永久缓存：新会话第一次出帧时标题可能还没有，留空缓存
   * 会把 null 永久钉死；有 TTL 过几分钟就会自己再查一次。
   */
  const titleCache = new Map();
  const TITLE_TTL_MS = 5 * 60 * 1000;
  function cachedTitle(id) {
    const row = titleCache.get(id);
    if (row === undefined) return undefined;
    if (Date.now() - row.at > TITLE_TTL_MS) {
      titleCache.delete(id);
      return undefined;
    }
    return row.title;
  }
  function frameBody(ev, title) {
    const frame = {
      // turnId 保留给旧 APK：老版本按它去重并弹“任务完成”。
      id: ev.id,
      turnId: ev.id,
      kind: ev.kind || 'done',
      sessionId: ev.sessionId,
      title: title === undefined ? null : title,
      detail: ev.detail || '',
      at: ev.at,
    };
    return 'data: ' + JSON.stringify(frame) + '\n\n';
  }
  function writeFrame(ev, title) {
    const body = frameBody(ev, title);
    for (const res of sseClients) {
      try {
        res.write(body);
      } catch {
        sseClients.delete(res);
      }
    }
  }
  if (typeof subscribeEvents === 'function') {
    try {
      subscribeEvents((ev) => {
        if (!sseClients.size) return;
        if (!ev || !ev.id || !ev.sessionId) return;
        // clear 不查标题，也不带正文；手机侧只拿 id 撤通知。
        if (ev.kind === 'clear') {
          writeFrame(ev, null);
          return;
        }
        const cached = cachedTitle(ev.sessionId);
        if (cached !== undefined) {
          writeFrame(ev, cached);
          return;
        }
        upstreamRpc('session/list', { _request: {} }).then(
          (v) => {
            const rows = summarizeSessions(v && v.items);
            const at = Date.now();
            for (const s of rows) titleCache.set(s.id, { title: s.title, at });
            writeFrame(ev, cachedTitle(ev.sessionId));
          },
          () => writeFrame(ev, null),
        );
      });
    } catch (e) {
      log('subscribeEvents failed: ' + String((e && e.message) || e));
    }
  }

  /** 网关自己持有的 DSH 凭据（`dsh-auth-xxx=...`）。 */
  let dshCookie = null;
  /** 正在刷新时的互斥，避免并发请求重复换票。 */
  let refreshing = null;

  /** 把所有来源标记改写成本机，让上游的 Host/Origin 校验通过。 */
  function rewriteHeaders(raw, { keepDshCookie = false } = {}) {
    const out = { ...raw };
    out.host = upstreamAuthority;
    if (out.origin) out.origin = upstreamOrigin;
    if (out.referer) {
      try {
        const r = new URL(out.referer);
        out.referer = upstreamOrigin + r.pathname + r.search;
      } catch {
        out.referer = upstreamOrigin + '/';
      }
    }
    if (out['sec-fetch-site'] === 'cross-site') out['sec-fetch-site'] = 'same-origin';

    // 浏览器侧的 dsh-auth-* 一律丢弃（那是旧进程/旧端口留下的，必然失效）。
    const others = stripDshCookies(raw.cookie);
    const parts = [];
    if (others) parts.push(others);
    if (keepDshCookie && dshCookie) parts.push(dshCookie);
    if (parts.length) out.cookie = parts.join('; ');
    else delete out.cookie;

    return out;
  }

  /** 用 token 向上游换一份新的 DSH 凭据。并发调用合并成一次。 */
  function refreshCookie() {
    if (refreshing) return refreshing;

    refreshing = new Promise((resolve) => {
      const token = (() => {
        try { return getLaunchToken(); } catch { return null; }
      })();

      if (!token) {
        log('refresh: no launch token available');
        resolve(null);
        return;
      }

      // 换票请求带干净的 Host，且不带任何 cookie。
      const headers = {
        host: upstreamAuthority,
        'sec-fetch-site': 'same-origin',
      };

      const up = http.request(
        { host: upstreamHost, port: upstreamPort, method: 'GET', path: `/?token=${encodeURIComponent(token)}`, headers },
        (upRes) => {
          const cookie = extractDshCookie(upRes.headers['set-cookie']);
          upRes.resume();
          if (cookie) {
            dshCookie = cookie;
            log('refresh: obtained DSH cookie (status ' + String(upRes.statusCode) + ')');
          } else {
            log('refresh: upstream did not issue a cookie (status ' + String(upRes.statusCode) + ')');
          }
          resolve(cookie);
        },
      );

      up.on('error', (e) => {
        log('refresh failed: ' + String((e && e.message) || e));
        resolve(null);
      });
      up.end();
    }).finally(() => { refreshing = null; });

    return refreshing;
  }

  /**
   * 网关自己向上游调一次 unary RPC（给 /m/__ms/tasks 这类只读端点用）。
   * 凭据走网关自持的 dshCookie；401 时刷新一次再试，仍失败就 reject。
   * envelope 格式实测：{type, rpcId, method, payload:{args:{_request:{...}}}}。
   */
  function upstreamRpc(method, args, retried = false) {
    return new Promise((resolve, reject) => {
      let body;
      try {
        body = JSON.stringify({
          type: 'client-request',
          rpcId: `ms-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          method,
          payload: { args },
        });
      } catch (e) { reject(e); return; }
      const req = http.request(
        {
          host: upstreamHost,
          port: upstreamPort,
          method: 'POST',
          path: `/api/${method}`,
          headers: {
            host: upstreamAuthority,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'sec-fetch-site': 'same-origin',
            ...(dshCookie ? { cookie: dshCookie } : {}),
          },
        },
        (upRes) => {
          if (upRes.statusCode === 401 && !retried) {
            upRes.resume();
            refreshCookie().then((cookie) => {
              if (!cookie) { reject(new Error('no credential')); return; }
              upstreamRpc(method, args, true).then(resolve, reject);
            }).catch(reject);
            return;
          }
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            try {
              const d = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (d && d.result && d.result.ok) resolve(d.result.value);
              else reject(new Error((d && d.result && d.result.error && d.result.error.code) || `status ${upRes.statusCode}`));
            } catch (e) { reject(e); }
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /**
   * 转发一次 HTTP 请求；401 时就地刷新凭据并重试一次。
   *
   * @param transform 可选：把上游响应体改写成手机版。
   *   不传时按原样流式转发（桌面端走这条，一个字节都不碰）。
   *   传了才缓冲整个响应 —— 只有手机端会用到，且只在
   *   首页 HTML 和 /plugins/?? 组合脚本这两类请求上启用。
   * @param upstreamPath 可选：改写到上游的路径。默认用 req.url。
   *
   * 注意：**不要**用 `{ ...req, url }` 伪造请求对象。req 是
   * IncomingMessage，headers / pipe / method 都在原型上，
   * 展开成普通对象会全部丢掉，forward 读 req.headers 就崩
   * （实测把整个 DSH 带崩过）。改路径就单独传一个字符串。
   *
   * 手机端改写体的缓冲上限：首页 HTML 和组合脚本正常只有几 MB，
   * 无上限缓冲会被一个异常大包把网关内存打爆。声明超限或边收边超
   * 都直接 502，不直通（直通等于把没过滤的桌面内容喂给手机）。
   *
   * 32MB 这个数不是拍的：装到 85 个插件时，真实的组合脚本体实测
   * 9,132,689 B（api-gateway 那批）和 8,223,400 B（user-questions 那批）。
   * 上一版设 8MB，恰好比这两批小一点点 → 两批全 502 → 客户端拿不到
   * client-modules 注册，整页报 "HTML did not preload ..."，手机端
   * 一个插件都加载不出来（2026-10-23 真机事故）。
   * 所以这道线是"防 OOM 的兜底"，必须明显高于正常体积；插件越多批次越大，
   * 只要还在这条线以下就不该拒。要再收紧，得改成按插件数或流式改写。
   */
  const MAX_MOBILE_TRANSFORM = 32 * 1024 * 1024;

  function forward(req, res, retried = false, transform = null, upstreamPath = null) {
    const headers = rewriteHeaders(req.headers, { keepDshCookie: true });
    // 要按文本切分就不能让上游压缩
    if (transform) headers['accept-encoding'] = 'identity';

    const up = http.request(
      { host: upstreamHost, port: upstreamPort, method: req.method, path: upstreamPath ?? req.url, headers },
      (upRes) => {
        // 凭据失效：刷新后重试同一次请求，绝不重定向浏览器。
        if (upRes.statusCode === 401 && !retried) {
          upRes.resume();
          refreshCookie().then((cookie) => {
            if (!cookie) {
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
              res.end('mobile-studio: 无法向 DSH 换取登录凭据，请确认 DSH 正在运行');
              return;
            }
            forward(req, res, true, transform, upstreamPath);
          });
          return;
        }

        // 不要把上游的 dsh-auth cookie 泄露给浏览器（浏览器不需要它）。
        const outHeaders = { ...upRes.headers };
        if (outHeaders['set-cookie']) {
          const kept = [].concat(outHeaders['set-cookie'])
            .filter((line) => !/^dsh-auth-/.test(String(line).split(';', 1)[0].trim()));
          if (kept.length) outHeaders['set-cookie'] = kept;
          else delete outHeaders['set-cookie'];
        }

        // 手机端：缓冲后改写。桌面端：原样流式转发。
        if (transform) {
          // 预检：上游声明的长度就超 32MB，直接拒，连缓冲都不开。
          const declared = Number(upRes.headers['content-length']);
          if (Number.isFinite(declared) && declared > MAX_MOBILE_TRANSFORM) {
            log('mobile: transform too large (' + declared + 'B), 502 ' + (upstreamPath ?? req.url));
            try { upRes.resume(); } catch { /* noop */ }
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('mobile-studio: 上游响应过大，拒绝改写');
            return;
          }
          const chunks = [];
          let buffered = 0;
          let failed = false;
          const failLarge = () => {
            if (failed) return;
            failed = true;
            log('mobile: transform overflow (>32MB), 502 ' + (upstreamPath ?? req.url));
            try { upRes.destroy(); } catch { /* noop */ }
            try {
              if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
                res.end('mobile-studio: 上游响应过大，拒绝改写');
              } else {
                res.destroy();
              }
            } catch { /* noop */ }
          };
          upRes.on('data', (c) => {
            if (failed) return;
            buffered += c.length;
            if (buffered > MAX_MOBILE_TRANSFORM) { failLarge(); return; }
            chunks.push(c);
          });
          upRes.on('end', () => {
            if (failed) return;
            let body;
            try {
              body = Buffer.concat(chunks).toString('utf8');
            } catch {
              body = '';
            }
            let outBody = body;
            let note = null;
            try {
              note = transform(body);
              if (typeof note === 'string') outBody = note;
            } catch (e) {
              log('mobile transform failed, passing through: ' + String((e && e.message) || e));
              outBody = body;
            }
            const h = { ...outHeaders };
            delete h['content-encoding'];
            delete h.etag;
            delete h['transfer-encoding'];
            h['content-length'] = Buffer.byteLength(outBody);
            h['cache-control'] = 'no-store';
            res.writeHead(upRes.statusCode || 200, h);
            res.end(outBody);
          });
          return;
        }

        // 上游的 303->./ 只对本机有意义；网关这里已无需它。
        res.writeHead(upRes.statusCode || 502, outHeaders);
        upRes.pipe(res);
      },
    );

    up.on('error', (e) => {
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('mobile-studio gateway: 上游不可达 (' + String((e && e.message) || e) + ')');
      } catch { /* noop */ }
    });
    req.pipe(up);
  }

  /**
   * 手机端路由分流。
   *
   * /m 与 /m/ 返回官方首页，但把插件清单按白名单裁过；
   * /plugins/?? 组合脚本剥掉第三方插件的代码段；
   * /m/mobile.css、/m/mobile.js 是从 mobile/ 目录读的本地文件。
   * 其余路径（/api、/assets、WebSocket）一律走原样转发 —— 手机和
   * 桌面共用同一个后端，这正是两端能实时同步、共享写句柄的原因。
   *
   * 注意 `/manifest.webmanifest` 也以 `/m` 开头，所以必须精确匹配。
   */
  function mobileAsset(pathname) {
    const file = pathname === '/m/mobile.css' ? 'mobile.css' : pathname === '/m/mobile.js' ? 'mobile.js' : null;
    if (file === null) return null;
    try {
      const bytes = readFileSync(new URL(`./mobile/${file}`, import.meta.url));
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      return { bytes, type };
    } catch (e) {
      log('mobile asset missing: ' + file + ' (' + String((e && e.message) || e) + ')');
      return null;
    }
  }

  /** 组合脚本的请求是否来自手机页（Referer 以 /m 开头）。 */
  function fromMobilePage(req) {
    const ref = req.headers.referer || req.headers.referrer;
    if (typeof ref !== 'string') return false;
    try {
      const p = new URL(ref).pathname;
      return p === '/m' || p === '/m/' || p === '/m/index.html';
    } catch {
      return false;
    }
  }

  /*
   * mobile/ 下文件的修改时间，当 URL 版本号用。
   *
   * 为什么非要这个：会话页的响应头本来就是 no-store，但手机 WebView / PWA
   * 对**同一个 URL** 的模块脚本会走自己的内存缓存 —— 切回 App 不会重新请求，
   * 于是「改了代码、用户说没变化」反复出现（已经没有 HTTP 层面的缓存可以清）。
   * 把 mtime 拼进 URL，文件一动 URL 就变，WebView 必然重新拉。
   */
  function mobileAssetVer(file) {
    try {
      return String(Math.round(statSync(new URL(`./mobile/${file}`, import.meta.url)).mtimeMs));
    } catch {
      return '0';
    }
  }

  /*
   * 手机端诊断上报：把「跑的是哪一版 mobile.js」和「它认为键盘开没开」落成一行日志。
   *
   * 为什么需要：同一句「改了没变化」已经来回好几轮，猜客户端缓存、猜键盘判据都不算数。
   * 这两个事实只有手机自己能回答。日志只写版本号和视口尺寸，不碰任何会话内容。
   */
  function diagLog(url) {
    try {
      const dir = path.join(os.homedir(), '.dsh', 'mobile-studio');
      mkdirSync(dir, { recursive: true });
      const q = url.searchParams;
      const rec = {
        at: new Date().toISOString(),
        v: q.get('v') || '',
        tap: q.get('tap') || '',
        ih: q.get('ih') || '',
        vv: q.get('vv') || '',
        mx: q.get('mx') || '',
        ime: q.get('ime') || '',
        act: q.get('act') || '',
        ua: (q.get('ua') || '').slice(0, 120),
      };
      appendFileSync(path.join(dir, 'diag.log'), JSON.stringify(rec) + '\n');
    } catch {
      /* 诊断失败绝不能影响主流程 */
    }
  }

  /**
   * 任意诊断记录落盘（手机上报用 diagLog；推送连接这类服务端事实用这个）。
   * 只记连接元数据（时间、since、时钟偏差、是否有 cookie），不碰会话内容。
   */
  function diagRec(rec) {
    try {
      const dir = path.join(os.homedir(), '.dsh', 'mobile-studio');
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, 'diag.log'), JSON.stringify(rec) + '\n');
    } catch {
      /* 诊断失败绝不能影响主流程 */
    }
  }

  function mobilePlan(req, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    const p = url.pathname;

    /*
     * 官方前端是单页应用但**不改地址栏**（实测：点进会话前后 URL
     * 完全一致）。所以这里只要认 `/m` 与 `/m/` 就够，不需要为
     * 子路径做回退。
     *
     * `/manifest.webmanifest` 也以 /m 开头，所以不能简单 startsWith。
     */
    if (p === '/m' || p === '/m/' || p === '/m/index.html') {
      return {
        path: '/',
        transform(body) {
          const filtered = filterHtml(body);
          if (filtered.dropped.length) {
            log('mobile: html dropped ' + filtered.dropped.length + ' plugin(s): ' + filtered.dropped.join(','));
          }
          let out = rebase(filtered.body);
          // 挂上移动端样式与逻辑（只对这份响应生效，桌面端看不到）。
          // 带 mtime 版本号：WebView 按 URL 缓存模块脚本，URL 不变就永远拿旧的。
          out = out.replace('</head>', '<link rel="stylesheet" href="/m/mobile.css?v=' + mobileAssetVer('mobile.css') + '"></head>');
          out = out.replace('</body>', '<script type="module" src="/m/mobile.js?v=' + mobileAssetVer('mobile.js') + '"></script></body>');
          return out;
        },
      };
    }

    // 组合脚本的 URL 形如 /plugins/??a,b,c&rev=xxx
    // 注意 `??` 会被 WHATWG URL 解析成查询串，pathname 只剩 /plugins/，
    // 所以必须按原始 req.url 判断，不能只看 pathname。
    //
    // 关键：这条 URL 桌面端和手机端**完全一样**，只看路径区分不了。
    // 一开始没区分，结果网关把桌面页（/）的组合脚本也剥了一遍：
    // 实测桌面页 8 个第三方插件全部加载失败（页面顶部报
    // "Failed to load plugins"）。现在按 Referer 判定来路，
    // 只有从 /m 发起的组合脚本才过滤，其余原样转发。
    //
    // 没有 Referer 的组合请求（curl / 异常客户端）直接打一行日志，
    // 免得出问题时查无对证；同样原样转发，不拦。
    if (
      p === '/plugins/' &&
      typeof req.url === 'string' &&
      req.url.startsWith('/plugins/??') &&
      !fromMobilePage(req)
    ) {
      const ref = req.headers.referer || req.headers.referrer;
      if (typeof ref !== 'string' || ref === '') {
        log('mobile: combo without referer, passing through: ' + String(req.url).slice(0, 120));
      }
    }
    if (
      p === '/plugins/' &&
      typeof req.url === 'string' &&
      req.url.startsWith('/plugins/??') &&
      fromMobilePage(req)
    ) {
      return {
        path: req.url,
        transform(body) {
          const out = filterCombo(body);
          if (out.dropped.length) {
            log('mobile: combo dropped ' + out.dropped.length + ' segment(s): ' + out.dropped.join(','));
          }
          return out.body;
        },
      };
    }

    return null;
  }

  /**
   * 请求处理的兜底：网关自己的 bug 只能让这一个请求失败，
   * 绝不能冒泡到进程级 —— 实测过一次未捕获异常直接把整个 DSH 带崩，
   * 用户看到「应用无法启动或已意外停止」。
   */
  function guarded(fn) {
    return (req, res, ...rest) => {
      try {
        fn(req, res, ...rest);
      } catch (e) {
        log('request failed: ' + String((e && e.stack) || e));
        try {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('mobile-studio gateway: ' + String((e && e.message) || e));
        } catch { /* 响应已不可写，忽略 */ }
      }
    };
  }

  const server = http.createServer(guarded((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid');
    } catch {
      res.writeHead(400).end();
      return;
    }

    // ---------------- /m 唯一化 ----------------
    // 插件隔离只在**精确的 /m** 上做（注入 mobile.js、按白名单裁组合脚本、
    // fromMobilePage 也只认 /m）。/m/、/m/index.html、/m/m、/m/foo 这些变体
    // 既不注入也不过滤，等于绕过隔离，所以在这里统一 302 回 /m，让旧链接/手滑自愈。
    // 白名单：移动端静态文件与网关自己的 __ms 端点，其余 /m/… 一律收口。
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/m/')) {
      const p = url.pathname;
      const isAsset = p === '/m/mobile.js' || p === '/m/mobile.css';
      const isGatewayApi = p.startsWith('/m/__ms/');
      if (!isAsset && !isGatewayApi) {
        res.writeHead(302, { location: '/m', 'cache-control': 'no-store' });
        res.end();
        return;
      }
    }

    // ---------------- 密码门禁 ----------------
    // 登录页与登出永远放行；其余一律要求 ms_auth cookie。
    // 未设置密码（auth.enabled=false）时保持原来的扫码即开行为。
    let auth = null;
    try { auth = getAuth(); } catch { auth = null; }

    if (url.pathname === '/__ms/login') {
      if (req.method === 'POST') {
        readSmallBody(req).then((raw) => {
          const form = new URLSearchParams(raw);
          const next = safeNext(form.get('next'));
          const pw = form.get('password') || '';
          const enabled = !!(auth && auth.enabled);
          const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
          // 限流先行：退避期内直接 429，不再做 scrypt 校验。
          // 未设密码时不计数（扫码即开本来就没门）。
          if (enabled) {
            const left = loginBlockedMs(ip);
            if (left > 0) {
              const retry = Math.ceil(left / 1000);
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(retry),
              });
              res.end(loginPage({ next, error: '尝试太频繁，请 ' + retry + ' 秒后再试', enabled }));
              return;
            }
          }
          if (auth && auth.enabled && verifyPassword(auth, pw)) {
            loginRecord(ip, true);
            res.writeHead(302, {
              'set-cookie': sessionCookie(auth),
              location: next,
              'cache-control': 'no-store',
            });
            res.end();
            return;
          }
          if (enabled) loginRecord(ip, false);
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(loginPage({ next, error: '密码不正确', enabled }));
        }).catch(() => {
          try { res.writeHead(400).end(); } catch { /* noop */ }
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(loginPage({ next: safeNext(url.searchParams.get('next')), error: '', enabled: !!(auth && auth.enabled) }));
      return;
    }

    if (url.pathname === '/__ms/logout') {
      res.writeHead(302, {
        'set-cookie': 'ms_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        location: '/__ms/login',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    // 根路径只服务手机页：扫码地址以 /m 结尾，但旧码/旧收藏的裸域名（/）
    // 转发到上游会打开桌面页。这里 302 到 /m（只精确匹配 /，
    // /api、/assets、/plugins 一律不动）。放门禁之前：未登录会被门禁
    // 接着带到登录页，登录完 next=/ 再回到这里进 /m。
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
      res.writeHead(302, { location: '/m', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    // 扫码登录：电脑端二维码里带的是票据（见 auth.js qrLoginToken），
    // 手机扫一下打开这个地址，网关校验后直接下发登录 Cookie 再回 /m。
    // 票据无效/没启用密码时什么都不做，掉到下面的门禁按老路走。
    // 票据只在这里消费：不回显、不转发上游、不写日志。
    if (url.pathname === '/__ms/qr' && (req.method === 'GET' || req.method === 'HEAD')) {
      const token = url.searchParams.get('t') || '';
      const ok = !!(auth && auth.enabled && isValidQrToken(auth, token));
      const headers = { location: '/m', 'cache-control': 'no-store' };
      // 票据不对也给一个干净的 302：让下面的门禁把用户带到登录页，
      // 而不是把这个内部路径转发给上游吃 404。
      if (ok) headers['set-cookie'] = sessionCookie(auth);
      res.writeHead(302, headers);
      res.end();
      return;
    }

    if (auth && auth.enabled && !isValidSession(auth, req.headers.cookie)) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const next = url.pathname + (url.search || '');
        res.writeHead(302, {
          location: '/__ms/login?next=' + encodeURIComponent(next),
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('需要登录');
      return;
    }

    // 手机端诊断上报：不走上游，落一行日志就返回。
    // 放在鉴权之后、静态文件之前；没启用密码时不需要登录态。
    if (url.pathname === '/m/__ms/hello') {
      diagLog(url);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }

    // 任务摘要（给 App 推送轮询用）：只读端点，不走上游转发，
    // 而是网关自己调一次上游 session/list 再裁剪。
    // 判定「完成」用 finishedAt 时刻表（宿主 agent/status → idle 打的点），
    // 不再用 running 翻转 —— 翻转会漏掉轮询间隔里开始又结束的短任务。
    if (url.pathname === '/m/__ms/tasks' && (req.method === 'GET' || req.method === 'HEAD')) {
      const send = (payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      };
      const run = () => {
        upstreamRpc('session/list', { _request: {} }).then(
          (v) => send({ ok: true, at: Date.now(), sessions: summarizeSessions(v && v.items, getFinishedAt, getFinishedKind) }),
          () => send({ ok: false, at: Date.now(), sessions: [] }),
        );
      };
      if (!dshCookie) {
        refreshCookie().then((cookie) => {
          if (!cookie) { send({ ok: false, at: Date.now(), sessions: [] }); return; }
          run();
        }).catch(() => send({ ok: false, at: Date.now(), sessions: [] }));
        return;
      }
      run();
      return;
    }

    // 任务完成推送（SSE 长连接）：一次 turn 结束推一帧，App 收到就弹通知。
    // 形状：data: {turnId, sessionId, title, at}\n\n
    // 不用轮询 —— Android 的后台唤醒不可靠，改成"App 挂着一条连接等推送"。
    if (url.pathname === '/m/__ms/push' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // 先回一行注释：手机侧读到它就知道连接确实通了
      try { res.write(': connected\n\n'); } catch { /* noop */ }
      sseClients.add(res);
      // 重连补发：手机带上 since（毫秒），把断线/被杀期间错过的帧补一次。
      // 没有这段的话，连接断开那几秒里结束的 turn 就永久丢了 —— 用户看到的就是"通知时有时无"。
      const nowMs = Date.now();
      let since = Number(url.searchParams.get('since') || 0) || 0;
      // 手机时钟比电脑快时，since 会落在"未来"，之后所有帧（at 是电脑时间）都会被当成旧的丢掉。
      // 这不是瞎猜：手机上确实出现过设备时间被改错的情况，症状正是"推送全都没了"。
      // 检测到就退到最近 2 分钟，靠 sessionId:at 去重保证不会重复弹。
      const skew = since > 0 ? nowMs - since : 0;
      if (since > 0 && skew < -120000) {
        log('push since 在未来（手机时钟快 ' + Math.round(-skew / 1000) + 's），按最近 2 分钟补发');
        since = nowMs - 120000;
      }
      diagRec({
        at: new Date(nowMs).toISOString(),
        tap: 'push-connect',
        since,
        skew: skew < -120000 ? -skew : 0,
        auth: req.headers.cookie ? 1 : 0,
        ua: String(req.headers['user-agent'] || '').slice(0, 60),
      });
      const openedAt = nowMs;
      if (since > 0 && typeof getRecentEvents === 'function') {
        try {
          const missed = getRecentEvents(since) || [];
          for (const ev of missed) {
            try { res.write(frameBody(ev, cachedTitle(ev.sessionId))); } catch { /* noop */ }
          }
          if (missed.length) log('push replay: ' + missed.length + ' frame(s) since ' + since);
          diagRec({ at: new Date().toISOString(), tap: 'push-replay', n: missed.length });
        } catch (e) {
          log('push replay failed: ' + String((e && e.message) || e));
        }
      }
      const hb = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
      }, HEARTBEAT_MS);
      const drop = () => {
        clearInterval(hb);
        sseClients.delete(res);
        diagRec({ at: new Date().toISOString(), tap: 'push-close', ms: Date.now() - openedAt });
      };
      req.on('close', drop);
      req.on('error', drop);
      res.on('error', drop);
      return;
    }

    // 手机端的本地静态文件不走上游
    const asset = mobileAsset(url.pathname);
    if (asset !== null) {
      res.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-store',
        'content-length': asset.bytes.length,
      });
      res.end(req.method === 'HEAD' ? undefined : asset.bytes);
      return;
    }

    const plan = mobilePlan(req, url);
    const transform = plan === null ? null : plan.transform;
    const upstreamPath = plan === null ? null : plan.path;

    // 首次请求或凭据未知：先拿一份再转发。
    if (!dshCookie) {
      refreshCookie().then((cookie) => {
        if (!cookie) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('mobile-studio: 无法向 DSH 换取登录凭据，请确认 DSH 正在运行');
          return;
        }
        forward(req, res, false, transform, upstreamPath);
      }).catch((e) => {
        log('refresh failed: ' + String((e && e.message) || e));
        try { res.writeHead(502).end('mobile-studio: 换取凭据失败'); } catch { /* noop */ }
      });
      return;
    }
    forward(req, res, false, transform, upstreamPath);
  }));

  // WebSocket：DSH 的事件流依赖它，必须带凭据透传。
  // 同样兜底：握手阶段出任何错都只断开这一条连接，不能冒泡。
  server.on('upgrade', (req, socket, head) => {
    // WebSocket 也要过门禁，否则登录只挡了页面、事件流仍然裸奔。
    let wsAuth = null;
    try { wsAuth = getAuth(); } catch { wsAuth = null; }
    if (wsAuth && wsAuth.enabled && !isValidSession(wsAuth, req.headers.cookie)) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      } catch { /* noop */ }
      try { socket.destroy(); } catch { /* noop */ }
      return;
    }

    const connect = (retried) => {
      const headers = rewriteHeaders(req.headers, { keepDshCookie: true });
      const up = net.connect(upstreamPort, upstreamHost, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of Object.entries(headers)) {
          if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
          else if (v !== undefined) lines.push(`${k}: ${v}`);
        }
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => { try { socket.destroy(); } catch { /* noop */ } });
      socket.on('error', () => { try { up.destroy(); } catch { /* noop */ } });

      // 握手若被 401 拒绝，刷新凭据后重连一次。
      if (!retried) {
        const onData = (chunk) => {
          const text = chunk.toString('latin1', 0, Math.min(chunk.length, 64));
          if (/^HTTP\/1\.1 401/.test(text)) {
            up.removeListener('data', onData);
            up.destroy();
            refreshCookie()
              .then((cookie) => { if (cookie) connect(true); else socket.destroy(); })
              .catch(() => { try { socket.destroy(); } catch { /* noop */ } });
          }
        };
        up.once('data', onData);
      }
    };
    try {
      connect(false);
    } catch (e) {
      log('upgrade failed: ' + String((e && e.stack) || e));
      try { socket.destroy(); } catch { /* noop */ }
    }
  });

  // 最后一道防线：进程级未捕获异常只记录，不让宿主退出。
  // （DSH 桌面版把未捕获异常当作致命错误直接关闭应用。）
  const onUncaught = (e) => {
    log('uncaught: ' + String((e && e.stack) || e));
  };
  try {
    process.on('uncaughtException', onUncaught);
  } catch { /* noop */ }

  /*
   * 端口占用：首选端口被别的程序占住时，按 +1、+2… 顺延尝试。
   * 家用/办公局域网里 3081 并不专属我们（开发服务器、旧进程都可能占着），
   * 与其让手机一直 ERR_CONNECTION_REFUSED，不如自己换一个并在面板里说清楚。
   * 只对 EADDRINUSE/EACCES 顺延，其它错误直接认失败。
   */
  const candidatePorts = [];
  for (let i = 0; i < Math.max(1, portAttempts); i++) {
    const p = listenPort + i;
    if (p >= 1 && p <= 65535) candidatePorts.push(p);
  }
  let portIndex = 0;
  let actualPort = candidatePorts[0] || listenPort;
  let listening = false;
  let listenError = null;
  let settled = false;
  const triedPorts = [];
  let resolveReady = () => {};
  const whenReady = new Promise((r) => { resolveReady = r; });
  const settle = (ok) => {
    if (settled) return;
    settled = true;
    resolveReady({
      listening: ok,
      port: actualPort,
      preferredPort: listenPort,
      fallback: ok && actualPort !== listenPort,
      error: ok ? null : String((listenError && (listenError.code || listenError.message)) || 'listen failed'),
      triedPorts: triedPorts.slice(),
    });
  };

  function tryListenNext() {
    if (listening) return;
    if (portIndex >= candidatePorts.length) {
      log('lan gateway failed: no free port in ' + candidatePorts.join(',') + ' (' + (listenError && (listenError.code || listenError.message)) + ')');
      settle(false);
      return;
    }
    actualPort = candidatePorts[portIndex++];
    triedPorts.push(actualPort);
    try {
      server.listen(actualPort, bindHost);
    } catch (e) {
      listenError = e;
      tryListenNext();
    }
  }

  server.on('error', (e) => {
    listenError = e;
    const code = e && e.code;
    // 已经在监听后出的错不是"端口被占用"，不要再去抢下一个端口
    if (listening) {
      log('lan gateway error: ' + String((e && e.message) || e));
      return;
    }
    if ((code === 'EADDRINUSE' || code === 'EACCES') && portIndex < candidatePorts.length) {
      log('lan gateway port ' + actualPort + ' busy (' + code + '), trying ' + candidatePorts[portIndex]);
      setTimeout(tryListenNext, 50);
      return;
    }
    log('lan gateway error: ' + String((e && e.message) || e));
    settle(false);
  });

  server.on('listening', () => {
    listening = true;
    listenError = null;
    log('lan gateway listening on ' + bindHost + ':' + actualPort
      + (actualPort !== listenPort ? ' (preferred ' + listenPort + ' busy, fallback)' : '')
      + ' → ' + upstreamOrigin);
    settle(true);
  });

  tryListenNext();

  const ip = lanAddress();
  return {
    get port() { return actualPort; },
    get preferredPort() { return listenPort; },
    get listening() { return listening; },
    get error() { return listenError ? String(listenError.code || listenError.message || listenError) : null; },
    get triedPorts() { return triedPorts.slice(); },
    get fallback() { return listening && actualPort !== listenPort; },
    get url() { return ip ? `http://${ip}:${actualPort}/` : null; },
    whenReady,
    close: () => { try { server.close(); } catch { /* noop */ } },
  };
}
