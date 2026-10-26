/**
 * dsh-mobile-studio — 一键新建干净工作区 + 手机访问
 *
 * 宿主侧职责：
 *   1. 用 node:fs 真正建日期目录，通过 `connection.fetch.register` 暴露
 *      `POST /api/mobile-studio/create-dir` 给客户端调用。
 *   2. 在 0.0.0.0:<gatewayPort> 起局域网网关（见 lan.js），让手机能连上
 *      只绑了 127.0.0.1 的桌面版 DSH；同时暴露
 *      `GET /api/mobile-studio/lan-url` 供客户端取二维码地址。
 *
 * 为什么走 fetch 而不是 rpc：
 *   connection.rpc.handle 的 channel 会被客户端 `.slice(1)` 成相对路径，
 *   而 `/api` 已占用最长前缀，导致 405。fetch.register 直接挂绝对路由，无此问题。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startLanGateway, lanAddress } from './lan.js';
import { createPushHub } from './push-events.js';
import { setAllow, getAllow, normalizeAllow, lastSeen, isOfficial, isLocal, isAlwaysAllowed, isCompat, setLocal, seedDefaults, SELF } from './mobile-filter.js';
import { loadConfig, saveFilter, setPassword, qrLoginToken, configDir } from './auth.js';

export const name = 'dsh-mobile-studio';

export function todayStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function pickDirName(parent, stamp) {
  let taken = [];
  try {
    taken = fs.readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    taken = [];
  }
  if (!taken.includes(stamp)) return stamp;
  let n = 2;
  while (taken.includes(`${stamp}-${n}`)) n += 1;
  return `${stamp}-${n}`;
}

/**
 * 新建任务落地的根目录。
 * 优先级：插件配置 rootDir → 环境变量 DSH_MOBILE_ROOT → 用户主目录下的 DSH。
 * 不写死任何人的绝对路径（发布版这么做，别人装上也能直接用）。
 */
const DEFAULT_ROOT =
  (process.env.DSH_MOBILE_ROOT || '').trim() || path.join(os.homedir(), 'DSH');

/** 用户输入的名字要能安全地当目录名：去掉路径分隔符与 Windows 非法字符，限长 40。 */
export function sanitizeTaskName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 40);
}

export function createTaskDir(parentHint, rootDir, wantedName) {
  const parent = rootDir || parentHint || DEFAULT_ROOT;

  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw new Error('不是目录: ' + String(parent));
  }

  // 0.9.3：允许用户自己命名（客户端弹层里改）。没给名字就沿用日期自动名，
  // 给了名字也照样走去重（同名目录依次 -2、-3），不会覆盖已有任务。
  const stamp = todayStamp();
  const wanted = sanitizeTaskName(wantedName) || stamp;
  const name = pickDirName(parent, wanted);
  const full = path.join(parent, name);
  fs.mkdirSync(full, { recursive: true });
  return { path: full, name, parent, auto: !sanitizeTaskName(wantedName) };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function apply(ctx, config = {}) {
  const log = (m) => {
    try { ctx.logger?.info?.('mobile-studio: ' + m); } catch { /* noop */ }
    try { console.error('[mobile-studio] ' + m); } catch { /* noop */ }
  };

  log('apply() entered');

  // 启动时读一次配置：插件过滤规则 + 密码门禁。页面保存时再刷新。
  let authCache = { enabled: false, salt: '', hash: '', secret: '', updatedAt: 0 };
  function refreshAuth() {
    try {
      const cfg = loadConfig();
      authCache = cfg.auth;
      // 兼容旧配置（曾经存过 {mode,allow,block}）：只取 allow。
      if (cfg.filter) setAllow(cfg.filter.allow ?? cfg.filter);
      return authCache;
    } catch (e) {
      log('config load failed: ' + String((e && e.message) || e));
      return authCache;
    }
  }
  refreshAuth();

  // 做了兼容或不影响移动端 UI 的插件（link:/file:）：启动时登记一次。除本体外进可勾列表、
  // 默认勾选、可手动关闭；升级前已有的放行状态由一次性种子保证不断。
  try {
    const local = setLocal(listLocal());
    if (local.length) log('local plugins: ' + local.join(','));
    const seed = seedDefaults(loadConfig().filter, local.filter((id) => id !== SELF));
    if (seed.writeBack) {
      saveFilter({ allow: seed.allow, seeded: true });
      log('filter seeded with local compat: ' + seed.allow.join(','));
    }
    setAllow(seed.allow);
  } catch (e) {
    log('local plugin scan failed: ' + String((e && e.message) || e));
  }

  /** 当前已安装的插件 id：profile 依赖 + 手机页最近一次见到的清单。 */
  function listInstalled() {
    const ids = new Set();
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const profiles = path.join(home, 'profiles');
      for (const dir of fs.readdirSync(profiles)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(profiles, dir, 'package.json'), 'utf8'));
          for (const id of Object.keys(pkg.dependencies || {})) ids.add(id);
        } catch { /* 单个 profile 坏了跳过 */ }
      }
    } catch { /* 没有 profiles 目录就用空列表 */ }
    for (const id of lastSeen()) ids.add(id);
    return [...ids].sort();
  }

  let routeDispose = null;
  let installed = false;
  let gateway = null;

  /**
   * 做了兼容或不影响移动端 UI 的插件：profile 依赖里写成 `link:` / `file:` 的那些。
   *
   * 为什么按依赖写法认，而不是维护一张名字表：名字表每加一个自己的插件就要改一次，
   * 忘了改就被当成第三方挡在手机端外面（「技能中枢」就是这么被挡过一次）。
   * 这类插件进可勾列表、默认勾选、可手动关闭（见 seedDefaults）。
   */
  function listLocal() {
    const ids = new Set();
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const profiles = path.join(home, 'profiles');
      for (const dir of fs.readdirSync(profiles)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(profiles, dir, 'package.json'), 'utf8'));
          for (const [id, spec] of Object.entries(pkg.dependencies || {})) {
            if (typeof spec === 'string' && /^(link|file):/.test(spec)) ids.add(id);
          }
        } catch { /* 单个 profile 坏了跳过 */ }
      }
    } catch { /* 没有 profiles 目录就用空列表 */ }
    return [...ids].sort();
  }

  /** 网关端口：默认 3081，可用 config.gatewayPort 覆盖。 */
  const GATEWAY_PORT = Number(config.gatewayPort) || 3081;

  /**
   * 取当前进程有效的 DSH 登录 token，**只给网关内部用**。
   *
   * 为什么不放进二维码：token 每次进程启动都会变，印进二维码会导致
   * DSH 一重启二维码就作废。现在二维码里只有地址，token 由网关
   * 在转发时自己注入，浏览器地址栏永远看不到它。
   */
  function launchToken() {
    try {
      const conn = ctx.get ? ctx.get('connection') : ctx.connection;
      if (!conn || typeof conn.authenticatedUrl !== 'function') return null;
      const signed = conn.authenticatedUrl('http://127.0.0.1/');
      return new URL(signed).searchParams.get('token');
    } catch (e) {
      log('launchToken failed: ' + String((e && e.message) || e));
      return null;
    }
  }

  /*
   * 推送事件总线：网关的 SSE 端点（GET /m/__ms/push）挂在这里。
   *
   * 为什么监听 session/event 而不是只看 agent/status：
   *   - 完成/出错能用 turn/end 的 reason 区分；
   *   - 计划评审（exit_plan_mode）和提问（ask_user_question）是工具调用
   *     内部的等待，turn 一直 running，agent/status 永远不会 idle。
   * 具体判定放在 push-events.js，可以脱开 DSH 单测。
   */
  const eventSubs = new Set();
  function subscribeEvents(cb) {
    eventSubs.add(cb);
    return () => eventSubs.delete(cb);
  }
  function publishEvent(ev) {
    for (const cb of eventSubs) {
      try {
        cb(ev);
      } catch {
        /* 单个订阅者出错不能影响其他 */
      }
    }
  }

  /** 只推主会话：子 agent 的提问会被 DSH 拒绝，错误事件也不该骚扰用户。 */
  function isRootSession(session) {
    try {
      const agents = ctx.get ? ctx.get('agents') : ctx.agents;
      if (!agents || typeof agents.roots !== 'function') return true;
      const roots = agents.roots();
      if (!roots.length) return true;
      return roots.some((agent) => agent && agent.session === session);
    } catch {
      return true;
    }
  }

  const pushHub = createPushHub({ publish: publishEvent, isRoot: isRootSession });
  try {
    // payload: { agent: { id: SessionId }, status: 'idle' | 'running' }
    ctx.on('agent/status', pushHub.onAgentStatus);
    // global: 子会话/其他 scope 的 session/event 也要收到，再由 isRoot 过滤。
    ctx.on('session/event', pushHub.onSessionEvent, { global: true });
    log('push hooks: agent/status + session/event 已挂上');
  } catch (e) {
    log('push subscribe failed: ' + String((e && e.message) || e));
  }
  try {
    ctx.effect(() => () => pushHub.dispose(), 'mobile-studio: push timers');
  } catch {
    /* 没有 effect 能力的旧内核也不影响推送 */
  }

  /**
   * 启动局域网网关。
   * 上游端口从 webServer 服务取——必须等它 listen 之后才有值。
   * 端口被占用时交给 lan.js 自动顺延（最多 5 个）；面板打开时若上次全被占，
   * 会关掉死句柄再试一次，这样"关掉占用程序 → 刷新面板"就能恢复。
   */
  function tryStartGateway() {
    if (gateway && gateway.listening) return true;
    if (gateway && !gateway.listening) {
      // 上次没监听成功：清掉死句柄重试
      try { gateway.close?.(); } catch { /* noop */ }
      gateway = null;
    }
    const ws = ctx.get ? ctx.get('webServer') : ctx.webServer;
    if (!ws) return false;
    const port = ws.port;
    const host = ws.host || '127.0.0.1';
    if (!port) return false;

    try {
      gateway = startLanGateway({
        listenPort: GATEWAY_PORT,
        portAttempts: 5,
        upstreamHost: host,
        upstreamPort: port,
        getLaunchToken: launchToken,
        getAuth: () => authCache,
        getFinishedAt: pushHub.getFinishedAt,
        getFinishedKind: pushHub.getFinishedKind,
        // 重连补发：手机断线期间错过的推送按 since 补一次
        getRecentEvents: pushHub.getRecent,
        subscribeEvents,
        log,
      });
      log('gateway starting on 0.0.0.0:' + GATEWAY_PORT + '+ (upstream ' + host + ':' + port + ')');
      return true;
    } catch (e) {
      log('gateway start failed: ' + String(e && e.message || e));
      return false;
    }
  }

  function tryInstall() {
    if (installed) return true;
    const conn = ctx.get ? ctx.get('connection') : ctx.connection;
    if (!conn) return false;
    const reg = conn.fetch && conn.fetch.register;
    if (typeof reg !== 'function') {
      log('connection present but fetch.register is ' + typeof reg);
      return false;
    }

    try {
      const dispose = reg({
        path: '/api/mobile-studio/create-dir',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            let body = {};
            try {
              const raw = typeof request.json === 'function' ? await request.json() : null;
              if (raw) body = raw;
            } catch {
              body = {};
            }
            const parent = body && body.parent ? String(body.parent) : undefined;
            const wantedName = body && body.name ? String(body.name) : undefined;
            const result = createTaskDir(parent, config.rootDir, wantedName);
            log('created ' + result.path);
            return json({ ok: true, ...result });
          } catch (e) {
            return json({ ok: false, error: String(e && e.message || e) }, 500);
          }
        },
      });

      const disposeLan = reg({
        path: '/api/mobile-studio/lan-url',
        methods: ['GET'],
        // 必须显式声明 buffered：router 的 requestBodyMode 对未声明的路由
        // 返回 undefined，请求不会进 buffered 分支，最终得到 400。
        requestBody: 'buffered',
        fetch: async () => {
          tryStartGateway();
          refreshAuth(); // 二维码是否带票据取决于最新的密码开关
          // listen/错误回调最多几十毫秒，面板打开时等一下，别把"正在启动"当成失败
          for (let i = 0; i < 20 && gateway && !gateway.listening && !gateway.error; i++) {
            await new Promise((r) => setTimeout(r, 25));
          }
          const ip = lanAddress();
          const gw = gateway;
          const listening = !!(gw && gw.listening);
          // 实际端口：发生顺延时和 3081 不同，URL/二维码必须用实际的
          const port = gw ? gw.port : GATEWAY_PORT;
          const gatewayInfo = {
            listening,
            port,
            preferredPort: GATEWAY_PORT,
            fallback: !!(gw && gw.fallback),
            error: (gw && gw.error) || null,
            triedPorts: gw ? gw.triedPorts : [],
          };
          if (!ip || !listening) {
            return json({
              ok: true, lan: !!ip, ip, port,
              url: null, qr: null, gateway: gatewayInfo,
            });
          }

          // 面板展示的仍是干净地址 /m（手动输入/收藏都需要密码）。
          // 二维码额外带一张登录票据：手机扫一下就直接拿到登录态，
          // 开了访问密码也不用在手机上敲密码。票据由密码带出的 secret 派生，
          // 改/关密码即轮换，DSH 重启不变（所以码依然长期有效）。
          const token = qrLoginToken(authCache);
          const qr = token
            ? `http://${ip}:${port}/__ms/qr?t=${token}`
            : `http://${ip}:${port}/m`;
          return json({
            ok: true,
            lan: true,
            ip,
            port,
            url: `http://${ip}:${port}/m`,
            qr,
            gateway: gatewayInfo,
          });
        },
      });

      // 放行名单：GET 读当前名单与已装插件，POST 保存（立即生效，不用重启）。
      const disposeFilter = reg({
        path: '/api/mobile-studio/filter',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            if (request.method === 'POST') {
              let body = {};
              try { body = await request.json() || {}; } catch { body = {}; }
              const next = normalizeAllow(body.allow ?? body);
              // 种子标记一直保留 true：用户亲手存的名单，重启后不再掺种子
              saveFilter({ allow: next, seeded: true });
              setAllow(next);
              log('filter saved: allow=' + next.length + ' (' + next.join(',') + ')');
              return json({ ok: true, allow: next, installed: listInstalled() });
            }
            const ids = listInstalled();
            return json({
              ok: true,
              allow: getAllow(),
              installed: ids,
              official: ids.filter(isOfficial),
              local: ids.filter(isLocal),
              // 本体永不进列表；其余做了兼容的插件（compat）进列表、默认勾选、可手动关闭
              self: SELF,
              compat: ids.filter(isCompat),
              thirdParty: ids.filter((id) => !isAlwaysAllowed(id) && !isCompat(id)),
            });
          } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, 500);
          }
        },
      });

      // 密码门禁：GET 只看开关状态，POST 设置新密码（空字符串=关闭）。
      const disposeAuth = reg({
        path: '/api/mobile-studio/auth',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            if (request.method === 'POST') {
              let body = {};
              try { body = await request.json() || {}; } catch { body = {}; }
              const pw = typeof body.password === 'string' ? body.password : '';
              authCache = setPassword(pw);
              log('auth updated: enabled=' + authCache.enabled);
              return json({ ok: true, enabled: !!authCache.enabled });
            }
            return json({ ok: true, enabled: !!authCache.enabled });
          } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, 400);
          }
        },
      });

      routeDispose = () => {
        try { dispose?.(); } catch { /* noop */ }
        try { disposeLan?.(); } catch { /* noop */ }
        try { disposeFilter?.(); } catch { /* noop */ }
        try { disposeAuth?.(); } catch { /* noop */ }
      };
      installed = true;
      log('fetch routes INSTALLED: create-dir, lan-url, filter, auth');
      return true;
    } catch (e) {
      log('route register threw: ' + String(e && e.message || e));
      return false;
    }
  }

  // 立即尝试一次
  if (!tryInstall()) {
    log('connection not ready; will retry on interval');
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tryInstall() || tries >= 60) {
        clearInterval(timer);
        if (!installed) log('gave up after ' + tries + ' tries');
      }
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // 网关随宿主启动。
  //
  // 早期是懒启动（等扫码页调 lan-url 才起），理由是「桌面端不该平白占一个
  // 端口」。但手机端现在走 /m 作为常驻入口，懒启动意味着**每次 DSH 重启
  // 后手机都连不上，直到有人点开扫码页**——实测就卡在这里（ERR_CONNECTION_REFUSED）。
  //
  // 改成随 webServer 就绪后自动启动：webServer 的端口要等 listen 完成才有值，
  // 所以这里轮询到有端口为止，然后一次性拉起网关。
  {
    let tries = 0;
    const boot = setInterval(() => {
      tries += 1;
      if (tryStartGateway()) {
        clearInterval(boot);
        // 真正 listen 成功由 lan.js 打日志（可能顺延到别的端口）
        log('gateway start requested after ' + tries + ' attempt(s)');
      } else if (tries >= 120) {
        clearInterval(boot);
        log('gateway auto-start gave up after ' + tries + ' tries');
      }
    }, 500);
    if (typeof boot.unref === 'function') boot.unref();
  }

  ctx.effect(() => () => {
    try { routeDispose?.(); } catch { /* noop */ }
    try { gateway?.close?.(); } catch { /* noop */ }
  }, 'mobile-studio: cleanup');
}
