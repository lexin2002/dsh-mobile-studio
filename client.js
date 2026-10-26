window.__ModuleLoader__.load({
  id: 'dsh-mobile-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'mobile-studio';
    const zh = {
      btn: '新建任务',
      busy: '创建中…',
      ok: '已新建',
      fail: '失败',
    };

    const CSS = `
/* 容器：不撑开侧栏，宽度跟随父级 */
.qt-wrap{
  display:flex;align-items:center;justify-content:center;
  width:100%;min-width:0;box-sizing:border-box;
  padding:2px 6px;
}
.qt-btn{
  display:flex;align-items:center;justify-content:center;gap:6px;
  width:100%;max-width:100%;box-sizing:border-box;
  height:30px;padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;font-weight:520;
  cursor:pointer;letter-spacing:-.002em;
  white-space:nowrap;overflow:hidden;
  transition:background .13s ease,color .13s ease,border-color .13s ease;
}
.qt-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.qt-btn:active{transform:scale(.97)}
.qt-btn:disabled{opacity:.55;cursor:default;transform:none}
.qt-icon{
  flex:0 0 auto;width:14px;height:14px;
  display:grid;place-items:center;color:currentColor;
}
.qt-label{
  flex:0 1 auto;min-width:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
/* 窄容器（侧栏收轨 56px）：只留图标 */
.qt-wrap[data-narrow="1"]{padding:0}
.qt-wrap[data-narrow="1"] .qt-btn{
  width:32px;height:32px;padding:0;border-radius:8px;border-color:transparent;
}
.qt-wrap[data-narrow="1"] .qt-label{display:none}
.qt-wrap[data-narrow="1"] .qt-busy-dot{
  position:absolute;width:5px;height:5px;border-radius:50%;
  background:var(--dsw-alias-brand-primary);margin:0;
}
.qt-dot{
  flex:0 0 auto;width:5px;height:5px;border-radius:50%;
  background:var(--dsw-alias-state-success-primary,#2F7A57);
}
.qt-dot.err{background:var(--dsw-alias-state-error-primary,#B4362F)}
.qt-err{
  font-size:10px;line-height:1.4;color:var(--dsw-alias-state-error-primary,#B4362F);
  padding:2px 8px 4px;word-break:break-word;
  max-width:100%;box-sizing:border-box;
}
/* ---- 新建任务：命名弹层（0.9.3） ----
 * 原来点一下就直接建"日期目录"；现在先问名字，默认值就是那个日期（自动命名变成默认值，不是被删）。
 * 用固定层而不是 system prompt：手机上 prompt 会被键盘顶飞、还带浏览器域名提示。 */
.qt-mask{
  position:fixed;inset:0;z-index:2147483000;
  background:rgb(0 0 0 / 38%);
  display:flex;align-items:center;justify-content:center;
  padding:24px;box-sizing:border-box;
}
.qt-dialog{
  width:min(340px,100%);box-sizing:border-box;
  background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-primary);
  border-radius:14px;padding:16px 16px 12px;
  box-shadow:0 12px 40px rgb(0 0 0 / 24%);
}
.qt-dt{font-size:15px;font-weight:600;margin-bottom:6px}
.qt-dh{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-bottom:10px}
.qt-di{
  width:100%;box-sizing:border-box;height:40px;padding:0 10px;
  font-size:16px; /* 16px：安卓/iOS 都不会因为字号小自动缩放 */
  border:1px solid var(--dsw-alias-border-l2);border-radius:9px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  outline:none;
}
.qt-di:focus{border-color:var(--dsw-alias-brand-primary)}
.qt-db{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.qt-db button{
  height:36px;padding:0 14px;border-radius:9px;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer;
}
.qt-dok{
  border-color:transparent !important;
  background:var(--dsw-alias-brand-primary) !important;
  color:#fff !important;font-weight:560;
}
.qt-dok:disabled{opacity:.5}
`;

    function todayStamp(d) {
      d = d || new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    }

    /**
     * 一键新建：日期目录 → 注册工作区 → 开新会话。
     *
     * 建目录走宿主 RPC（宿主有 node:fs，不受 Desktop 原生选择器限制）；
     * 注册工作区与开会话走客户端 Context Service。
     */
    async function createQuickTask(ctx, name) {
      const ui = ctx.uiWorkspace;
      const ws = ctx.workspaces;

      // ---- 1. 父目录由宿主决定（固定 Hermes），客户端不猜 ----
      // 之前从工作区快照推算会覆盖掉宿主的固定根目录，已改为此处不传 parent。

      // ---- 2. 宿主建日期目录（HTTP 端点，自动去重 + 固定根目录） ----
      // name 为空 → 宿主沿用 YYYY-MM-DD 自动名；给了名字就用它（同样去重 -2 / -3）。
      const resp = await fetch('/api/mobile-studio/create-dir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(name ? { name: String(name) } : {}),
      });
      const data = await resp.json();
      if (!resp.ok || !data || data.ok !== true) {
        throw new Error('建目录失败: ' + (data && data.error ? data.error : 'HTTP ' + resp.status));
      }
      const dirPath = data.path;
      const dirName = data.name;

      // ---- 3. 注册工作区 ----
      const created = await ws.create({ path: dirPath });
      const workspaceId =
        (created && created.workspaceId) ||
        (created && created.workspace && created.workspace.workspaceId) ||
        (created && created.id) ||
        null;

      // ---- 4. 开新会话并切过去 ----
      if (workspaceId) {
        await ui.connectWorkspace(workspaceId);
      }

      return { path: dirPath, name: dirName, workspaceId: workspaceId };
    }

    // ---------------- 移动端判断 ----------------
    // 三级判定，优先级从高到低：
    //   1. URL 参数 ?mobile=1 / ?mobile=0 —— 显式强制开/关。
    //      桌面端想预览移动界面、或手机浏览器横屏（宽度可能 >1023px）时用这个。
    //      有了它，桌面宽屏下不必缩窗口，手机上也不会因为横屏而失效。
    //   2. 宽度兜底：视口 ≤1023px 视为移动端。
    // 为什么不再叠加触摸检测（pointer:coarse）：触摸屏笔记本会误判，且用户无法手动关闭。
    // 为什么不用 localStorage：多标签页会串状态，且手机浏览器每次都是新会话。
    const MOBILE_QUERY = '(max-width: 1023px)';

    /** 读一次 URL 上的 mobile 参数（不缓存，方便改地址栏立即生效）。 */
    function readMobileParam() {
      try {
        const v = new URLSearchParams(window.location.search).get('mobile');
        if (v === '1') return true;
        if (v === '0') return false;
      } catch { /* noop */ }
      return null;
    }

    /** 当前是否移动端模式。URL 参数优先，否则看宽度。 */
    function isMobileNow() {
      const forced = readMobileParam();
      if (forced !== null) return forced;
      try {
        return window.matchMedia(MOBILE_QUERY).matches;
      } catch {
        return false;
      }
    }

    // ---------------- 真正的 0 宽收起 ----------------
    // DSH 布局源码（dsh-client-ui-layout/lib/client.js:242）：
    //   const collapsedWidth = darwin || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : 56;
    // 有 data-windows-titlebar 属性时收起是 0px，否则留 56px 图标轨。
    //
    // ⚠️ 血泪教训（把桌面端 UI 搞坏了）：
    // 官方代码里**只有读取、没有任何一处设置**这个属性 —— 它是 Electron 桌面端
    // 在加载页面前注入的。我之前的实现是「移动端加、非移动端删」，于是在
    // Electron 桌面端（isMobileNow() 为 false）把官方注入的属性删掉了，
    // 导致原生标题栏、窗口按钮、顶部菜单全乱。
    //
    // 现在的规则：**只加不删**，而且只在明确的移动端模式下加。
    // 非移动端一律什么都不做，绝不去碰这个属性。
    function syncZeroWidthRail() {
      try {
        if (!isMobileNow()) return; // 非移动端：不碰，交给官方
        const root = document.documentElement;
        if (!root.hasAttribute('data-windows-titlebar')) {
          root.setAttribute('data-windows-titlebar', '');
        }
      } catch { /* noop */ }
    }

    function useIsMobile() {
      const [isMobile, setIsMobile] = React.useState(isMobileNow);

      React.useEffect(function () {
        const onChange = function () { setIsMobile(isMobileNow()); };
        // URL 参数是同步判定（读一次即可），但宽度兜底要监听视口变化。
        // 这里两条都听：matchMedia 变化、以及地址栏参数可能被用户改写。
        let mq;
        try {
          mq = window.matchMedia(MOBILE_QUERY);
        } catch { /* noop */ }
        if (mq) {
          if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
          else mq.addListener(onChange);
        }
        window.addEventListener('popstate', onChange);
        window.addEventListener('hashchange', onChange);
        return function () {
          if (mq) {
            if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onChange);
            else mq.removeListener(onChange);
          }
          window.removeEventListener('popstate', onChange);
          window.removeEventListener('hashchange', onChange);
        };
      }, []);

      return isMobile;
    }

    // ---------------- 侧栏底部按钮 ----------------
    /**
     * 新建任务的命名弹层用一个极简的状态总线驱动。
     *
     * 为什么不做在按钮自己的 React 树里：按钮挂在侧栏 slot 里，而侧栏容器带
     * `transform`（抽屉滑出动画）。**fixed 定位在被 transform 的祖先里会以祖先为包含块**，
     * 实测弹层被限在侧栏宽度内、x=-280（整块跑到屏幕外）。
     * 所以弹层单独注册到 `shell.overlay`（App 级浮层，没有 transform），
     * 侧栏按钮只负责把总线打开。
     */
    const taskDialogBus = {
      state: { open: false, name: '', busy: false, err: null },
      subs: new Set(),
      set(patch) {
        this.state = Object.assign({}, this.state, patch);
        this.subs.forEach((f) => { try { f(this.state); } catch { /* noop */ } });
      },
      subscribe(f) {
        this.subs.add(f);
        return function () { taskDialogBus.subs.delete(f); };
      },
      open(name) {
        this.set({ open: true, name: name || todayStamp(), busy: false, err: null });
      },
      close() {
        this.set({ open: false, busy: false, err: null });
      },
    };
    // 闸门/探针用（无头验收弹层开没开、默认值对不对）
    try { window.__msTaskDialog = taskDialogBus; } catch { /* noop */ }

    function TaskDialog() {
      const [s, setS] = React.useState(taskDialogBus.state);
      React.useEffect(function () {
        const off = taskDialogBus.subscribe(setS);
        return off;
      }, []);
      if (!s.open) return null;

      const confirm = async function () {
        if (s.busy) return;
        const clean = String(s.name || '')
          .replace(/[\\/:*?"<>|]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);
        taskDialogBus.set({ busy: true, err: null });
        try {
          const r = await createQuickTask(QuickTaskButton._ctx, clean || todayStamp());
          QuickTaskButton._last = r;
          taskDialogBus.set({ open: false, busy: false, name: '', err: null });
        } catch (e) {
          taskDialogBus.set({ busy: false, err: String((e && e.message) || e) });
        }
      };

      return h('div', {
        className: 'qt-mask',
        onClick: function (e) { if (e.target === e.currentTarget) taskDialogBus.close(); },
      },
        h('div', { className: 'qt-dialog', role: 'dialog', 'aria-label': '新建任务' },
          h('div', { className: 'qt-dt' }, '新建任务'),
          h('div', { className: 'qt-dh' }, '给这个工作区起个名字（会成为文件夹名）。留空或保持默认就用今天的日期。'),
          h('input', {
            className: 'qt-di',
            value: s.name,
            autoFocus: true,
            inputMode: 'text',
            enterKeyHint: 'done',
            'aria-label': '工作区名称',
            onChange: function (e) { taskDialogBus.set({ name: e.target.value }); },
            onKeyDown: function (e) {
              if (e.key === 'Enter') confirm();
              if (e.key === 'Escape') taskDialogBus.close();
            },
          }),
          s.err ? h('div', { className: 'qt-err' }, s.err) : null,
          h('div', { className: 'qt-db' },
            h('button', { type: 'button', onClick: function () { taskDialogBus.close(); } }, '取消'),
            h('button', { type: 'button', className: 'qt-dok', disabled: s.busy, onClick: confirm }, s.busy ? '创建中…' : '创建'),
          ),
        ),
      );
    }

    function QuickTaskButton(props) {
      const [state, setState] = React.useState('idle'); // idle | busy | ok | err
      const [err, setErr] = React.useState(null);
      const [narrow, setNarrow] = React.useState(false);
      const isMobile = useIsMobile();
      const ctxRef = React.useRef(null);
      ctxRef.current = QuickTaskButton._ctx;
      const wrapRef = React.useRef(null);

      // 探测实际可用宽度：侧栏收轨只有 56px，此时只显示图标
      React.useEffect(function () {
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const check = function () {
          const w = el.clientWidth || el.getBoundingClientRect().width || 0;
          setNarrow(w > 0 && w < 120);
        };
        check();
        const ro = new ResizeObserver(check);
        ro.observe(el);
        return function () { ro.disconnect(); };
      }, []);

      // 读取工作区快照（hook 在顶层调用一次，且必须无条件调用）
      let wsSnap = null;
      try {
        const hook = props && props.useWorkspaces;
        if (typeof hook === 'function') wsSnap = hook(function (s) { return s; });
      } catch (e) {
        wsSnap = null;
      }
      QuickTaskButton._wsSnapshot = wsSnap;

      const onClick = React.useCallback(async function () {
        // 先弹命名层（默认值 = 今天的日期，也就是原来那个自动名）。
        // 真正建目录/工作区/会话在 TaskDialog 里做 —— 它挂在 shell.overlay，
        // 不受侧栏 transform 影响（否则 fixed 层会被限在侧栏宽度里）。
        setErr(null);
        taskDialogBus.open(todayStamp());
        setState('idle');
      }, [state]);

      const label =
        state === 'busy' ? zh.busy :
        state === 'ok' ? zh.ok :
        state === 'err' ? zh.fail :
        zh.btn;

      // 只在移动端（窄屏）渲染；桌面端完全不出现
      if (!isMobile) return null;

      return h('div', {
        className: 'qt-wrap',
        'data-narrow': narrow ? '1' : '0',
        ref: wrapRef,
      },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('button', {
          className: 'qt-btn',
          onClick: onClick,
          disabled: state === 'busy',
          title: '新建任务：日期目录 + 新工作区 + 新会话',
          'aria-label': '新建任务',
        },
          h('span', { className: 'qt-icon' },
            h('svg', {
              width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
              stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round',
            },
              h('path', { d: 'M12 5v14M5 12h14' }),
            ),
          ),
          h('span', { className: 'qt-label' }, label),
          !narrow && state === 'ok' ? h('span', { className: 'qt-dot' }) : null,
          !narrow && state === 'err' ? h('span', { className: 'qt-dot err' }) : null,
        ),
        narrow && (state === 'ok' || state === 'err')
          ? h('span', { className: 'qt-dot' + (state === 'err' ? ' err' : '') })
          : null,
        !narrow && err ? h('div', { className: 'qt-err' }, err) : null,
      );
    }

    // ---------------- 顶部标题栏（0 宽收起态） ----------------
    // 加上 data-windows-titlebar 后，DSH 会切成「Windows 桌面」外壳模式：
    //   1) 收起宽度从 56px 变成 0px（真正的完全隐藏）
    //   2) toggle / newSession 变成 position:fixed 的浮动按钮，left 12 / 48
    //   3) 内容区整体下移 `--dsh-windows-titlebar-height`，形成一条独立标题栏
    //
    // 但浏览器里这个变量是空的，第 3 步不成立 —— 内容不上移、也不下移，
    // 于是浮动按钮直接压在页面标题上（插件页、上下文洞察、自动化任务全都中招）。
    // 逐个页面加 padding 治不完，正确做法是把这个变量补上，让 DSH 自己排好版。
    //
    // 48px = 28px 按钮 + 上下各 10px 间距。
    const TOPFIX_CSS = `
html[data-windows-titlebar]{
  --dsh-windows-titlebar-height: 48px;
}
/* 会话页：这条带子只放 ☰ 和 ⊕，下面紧接着又是会话自己的 header，
   两条叠起来白占 48px。会话 header 本身就能当工具栏，所以把带子高度让给它，
   再给标题留出左侧 84px 避开那两个浮动按钮。
   判定「是不是会话页」用 _crumbCurrent：实测会话页有、插件/面板/首页都没有。
   不能用 :has(header) —— 面板页也有 header 元素，会误伤。 */
html[data-windows-titlebar] .BynINW_frame[data-sidebar-collapsed="true"]:has([class*="_crumbCurrent"]){
  padding-top: 0 !important;
}
html[data-windows-titlebar] .BynINW_frame[data-sidebar-collapsed="true"]:has([class*="_crumbCurrent"]) [class*="_titleRow"]{
  padding-left: 84px !important;
}
/* 藏掉 header 里的「展开/折叠底部面板」按钮。
   这是个低频开关：面板里自己还留着一个 nArs4W_bottomClose（折叠底部面板），
   所以藏掉入口不会导致「打开后关不掉」。
   移动端顶部空间本来就紧，省这 28px 给标题和工具按钮。 */
[class*="toggleButton"][aria-label*="底部面板"]{
  display: none !important;
}

/* ===== 移动端视口高度：修输入法弹起后界面被挤压且无法复原 =====
   根因：DSH 官方 CSS 给 html/body/#root 设了 height:100%，
   这个 100% 跟随的是**布局视口**，键盘弹起时布局视口不变（iOS 尤其如此），
   但可见区域变了 → 内容被顶出去；键盘收起后又没有事件把它拉回来，
   于是界面卡在被挤压的状态。官方代码里没有任何 vh/dvh/visualViewport 处理。

   修法：用 CSS 动态视口单位 dvh，它跟随**可见视口**变化，
   键盘弹起/收起都会自动重算，不需要监听事件。
   不支持的浏览器退回 100vh。另外 TopFixStyles 里用 visualViewport
   实测高度写进 --ms-vvh，兜住「浏览器不重算」的那种情况。 */
html[data-windows-titlebar],
html[data-windows-titlebar] body,
html[data-windows-titlebar] #root{
  height: 100vh;
  height: 100dvh;
  /* 优先用 JS 实测的可视高度（存在时覆盖上面两条） */
  height: var(--ms-vvh, 100dvh);
}

/* 兜底默认值：JS 还没跑时先按 dvh 撑满 */
html[data-windows-titlebar]{
  --ms-vvh: 100vh;
}
@supports (height: 100dvh){
  html[data-windows-titlebar]{ --ms-vvh: 100dvh; }
}
`;

    function TopFixStyles() {
      const isMobile = useIsMobile();
      if (!isMobile) return null;

      // 键盘/视口兜底：某些浏览器（尤其 Android 内置 WebView、部分国产浏览器）
      // 键盘收起后既不触发 resize，也不重算 dvh，界面会一直卡在被挤压的状态。
      // 这里直接读 visualViewport，在它变化时把真实高度写成 CSS 变量，
      // 比依赖浏览器的重算可靠。
      React.useEffect(function () {
        const vv = window.visualViewport;
        if (!vv) return undefined;

        let raf = 0;
        const apply = function () {
          if (raf) return;
          raf = window.requestAnimationFrame(function () {
            raf = 0;
            try {
              // visualViewport.height 是「真正能看到」的高度：
              // 键盘弹起时变小，收起后复原 —— 这正是我们要的值。
              const h = Math.round(vv.height);
              if (h > 0) {
                document.documentElement.style.setProperty('--ms-vvh', h + 'px');
              }
            } catch { /* noop */ }
          });
        };

        apply();
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
        return function () {
          if (raf) window.cancelAnimationFrame(raf);
          vv.removeEventListener('resize', apply);
          vv.removeEventListener('scroll', apply);
          try { document.documentElement.style.removeProperty('--ms-vvh'); } catch { /* noop */ }
        };
      }, []);

      return h('style', { dangerouslySetInnerHTML: { __html: TOPFIX_CSS } });
    }

    // ---------------- 点会话后自动收起 ----------------
    // 侧栏完全隐藏后，官方 toggle（已扶正到左上角）负责唤出；
    // 点侧栏里的任意会话/面板后自动收起。

    // ---------------- FAB 已废弃 ----------------
    // 官方在 data-windows-titlebar 收起态下自带「打开侧边栏」按钮（fixed left:12px），
    // 自绘 FAB 只会和它重叠（实测两个按钮落在同一坐标）。这里只留一个空组件，
    // 挂在 shell.overlay 上以便注入顶部位置修正样式 + 点击收起逻辑。
    function SidebarFab() {
      const isMobile = useIsMobile();
      useAutoCollapseOnSessionClick(isMobile);
      return h(TopFixStyles);
    }

    // 点会话后自动收起侧栏
    function useAutoCollapseOnSessionClick(isMobile) {
      React.useEffect(function () {
        if (!isMobile) return undefined;
        const onClick = function (e) {
          const el = e.target;
          if (!el || typeof el.closest !== 'function') return;
          // 侧栏内的会话行 / 面板图标
          const inSidebar = el.closest('[class*="sidebarCol"]');
          if (!inSidebar) return;
          // 排除我自己的按钮和账号菜单
          if (el.closest('.qt-wrap')) return;
          // 排除官方的「展开/收起侧栏」和「新建会话」按钮——
          // toggle 的 class 同时带 _iconButton，不排除会命中下面的规则，
          // 造成「刚点开又被自己收起」（实测踩过）。
          if (el.closest('[class*="_toggle"]') || el.closest('[class*="_newSession"]')) return;
          const isSessionRow = el.closest('[class*="sessionRow"],[class*="session"],[class*="panelRow"],[class*="iconButton"],[class*="searchButton"]');
          if (!isSessionRow) return;
          // 收轨前先等一帧，让点击生效
          setTimeout(function () {
            try {
              const sb = document.querySelector('[class*="sidebarCol"]');
              const w = sb ? sb.getBoundingClientRect().width : 0;
              if (w > 60) SidebarFab._ctx.layout.toggleSidebar();
            } catch { /* noop */ }
          }, 120);
        };
        document.addEventListener('click', onClick, true);
        return function () { document.removeEventListener('click', onClick, true); };
      }, [isMobile]);
    }

    // ---------------- 扫码打开页面 ----------------
    // 桌面端显示二维码，手机扫码后用移动端界面打开 DSH。
    //
    // 地址从宿主取（GET /api/mobile-studio/lan-url），不由页面自己拼：
    //   桌面 Electron 的页面地址是 dsh-app://，算不出手机可达的 http 地址；
    //   而 DSH 桌面版只绑 127.0.0.1，手机连不上。
    // 宿主侧的局域网网关（lan.js）监听 0.0.0.0，并用 connection.authenticatedUrl
    // 签出带 token 的地址，手机扫码即可直接登录。
    //
    // 为什么这个页面不判断 isMobile：扫码这件事只发生在桌面端，
    // 手机扫完就已经跳到移动端界面了，不需要在手机上看这个页。

/* ===== qrcode 库内联开始（tools/build-qr.mjs 生成） ===== */
// 自动生成 —— 请勿手改。重新生成：node tools/build-qr.mjs
// 来源：qrcode@1.5.4（MIT License, Copyright (c) 2017 soldair
// 每个原文件被包成一个工厂函数，依赖通过 registry 解析，代码保持原样。
// 产物是「片段」而非独立模块：粘贴进 client.js 的工厂作用域内使用。
const registry = new Map();
// 原库里有两种模块形态：
//   ① exports.foo = ...  （多个命名导出，如 utils / version）
//   ② module.exports = Class （单一导出，如 BitBuffer）
// 构建时把 ② 转成 exports.default = Class。消费方写的是
//   const BitBuffer = require("./bit-buffer"); new BitBuffer()
// 所以 get() 遇到只有 default 的模块就直接返回它，保持原代码不变。
const nativeGet = Map.prototype.get.bind(registry);
registry.get = (k) => {
  const m = nativeGet(k);
  if (m && m.default !== undefined && Object.keys(m).length === 1) return m.default;
  return m;
};

    registry.set('dijkstrajs', (function () {
      const module = { exports: {} };
      const exports = module.exports;
'use strict';

/******************************************************************************
 * Created 2008-08-19.
 *
 * Dijkstra path-finding functions. Adapted from the Dijkstar Python project.
 *
 * Copyright (C) 2008
 *   Wyatt Baldwin <self@wyattbaldwin.com>
 *   All rights reserved
 *
 * Licensed under the MIT license.
 *
 *   http://www.opensource.org/licenses/mit-license.php
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *****************************************************************************/
var dijkstra = {
  single_source_shortest_paths: function(graph, s, d) {
    // Predecessor map for each node that has been encountered.
    // node ID => predecessor node ID
    var predecessors = {};

    // Costs of shortest paths from s to all nodes encountered.
    // node ID => cost
    var costs = {};
    costs[s] = 0;

    // Costs of shortest paths from s to all nodes encountered; differs from
    // `costs` in that it provides easy access to the node that currently has
    // the known shortest path from s.
    // XXX: Do we actually need both `costs` and `open`?
    var open = dijkstra.PriorityQueue.make();
    open.push(s, 0);

    var closest,
        u, v,
        cost_of_s_to_u,
        adjacent_nodes,
        cost_of_e,
        cost_of_s_to_u_plus_cost_of_e,
        cost_of_s_to_v,
        first_visit;
    while (!open.empty()) {
      // In the nodes remaining in graph that have a known cost from s,
      // find the node, u, that currently has the shortest path from s.
      closest = open.pop();
      u = closest.value;
      cost_of_s_to_u = closest.cost;

      // Get nodes adjacent to u...
      adjacent_nodes = graph[u] || {};

      // ...and explore the edges that connect u to those nodes, updating
      // the cost of the shortest paths to any or all of those nodes as
      // necessary. v is the node across the current edge from u.
      for (v in adjacent_nodes) {
        if (adjacent_nodes.hasOwnProperty(v)) {
          // Get the cost of the edge running from u to v.
          cost_of_e = adjacent_nodes[v];

          // Cost of s to u plus the cost of u to v across e--this is *a*
          // cost from s to v that may or may not be less than the current
          // known cost to v.
          cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;

          // If we haven't visited v yet OR if the current known cost from s to
          // v is greater than the new cost we just found (cost of s to u plus
          // cost of u to v across e), update v's cost in the cost list and
          // update v's predecessor in the predecessor list (it's now u).
          cost_of_s_to_v = costs[v];
          first_visit = (typeof costs[v] === 'undefined');
          if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
            costs[v] = cost_of_s_to_u_plus_cost_of_e;
            open.push(v, cost_of_s_to_u_plus_cost_of_e);
            predecessors[v] = u;
          }
        }
      }
    }

    if (typeof d !== 'undefined' && typeof costs[d] === 'undefined') {
      var msg = ['Could not find a path from ', s, ' to ', d, '.'].join('');
      throw new Error(msg);
    }

    return predecessors;
  },

  extract_shortest_path_from_predecessor_list: function(predecessors, d) {
    var nodes = [];
    var u = d;
    var predecessor;
    while (u) {
      nodes.push(u);
      predecessor = predecessors[u];
      u = predecessors[u];
    }
    nodes.reverse();
    return nodes;
  },

  find_path: function(graph, s, d) {
    var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
    return dijkstra.extract_shortest_path_from_predecessor_list(
      predecessors, d);
  },

  /**
   * A very naive priority queue implementation.
   */
  PriorityQueue: {
    make: function (opts) {
      var T = dijkstra.PriorityQueue,
          t = {},
          key;
      opts = opts || {};
      for (key in T) {
        if (T.hasOwnProperty(key)) {
          t[key] = T[key];
        }
      }
      t.queue = [];
      t.sorter = opts.sorter || T.default_sorter;
      return t;
    },

    default_sorter: function (a, b) {
      return a.cost - b.cost;
    },

    /**
     * Add a new item to the queue and ensure the highest priority element
     * is at the front of the queue.
     */
    push: function (value, cost) {
      var item = {value: value, cost: cost};
      this.queue.push(item);
      this.queue.sort(this.sorter);
    },

    /**
     * Return the highest priority element in the queue.
     */
    pop: function () {
      return this.queue.shift();
    },

    empty: function () {
      return this.queue.length === 0;
    }
  }
};


// node.js module exports
if (typeof module !== 'undefined') {
  module.exports = dijkstra;
}

      return module.exports;
    })());

    registry.set('version-check', (function () {
      const exports = {};
/**
 * Check if QR Code version is valid
 *
 * @param  {Number}  version QR Code version
 * @return {Boolean}         true if valid version, false otherwise
 */
exports.isValid = function isValid (version) {
  return !isNaN(version) && version >= 1 && version <= 40
}

      return exports;
    })());

    registry.set('regex', (function () {
      const exports = {};
const numeric = '[0-9]+'
const alphanumeric = '[A-Z $%*+\\-./:]+'
let kanji = '(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|' +
  '[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|' +
  '[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|' +
  '[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+'
kanji = kanji.replace(/u/g, '\\u')

const byte = '(?:(?![A-Z0-9 $%*+\\-./:]|' + kanji + ')(?:.|[\r\n]))+'

exports.KANJI = new RegExp(kanji, 'g')
exports.BYTE_KANJI = new RegExp('[^A-Z0-9 $%*+\\-./:]+', 'g')
exports.BYTE = new RegExp(byte, 'g')
exports.NUMERIC = new RegExp(numeric, 'g')
exports.ALPHANUMERIC = new RegExp(alphanumeric, 'g')

const TEST_KANJI = new RegExp('^' + kanji + '$')
const TEST_NUMERIC = new RegExp('^' + numeric + '$')
const TEST_ALPHANUMERIC = new RegExp('^[A-Z0-9 $%*+\\-./:]+$')

exports.testKanji = function testKanji (str) {
  return TEST_KANJI.test(str)
}

exports.testNumeric = function testNumeric (str) {
  return TEST_NUMERIC.test(str)
}

exports.testAlphanumeric = function testAlphanumeric (str) {
  return TEST_ALPHANUMERIC.test(str)
}

      return exports;
    })());

    registry.set('utils', (function () {
      const exports = {};
let toSJISFunction
const CODEWORDS_COUNT = [
  0, // Not used
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706
]

/**
 * Returns the QR Code size for the specified version
 *
 * @param  {Number} version QR Code version
 * @return {Number}         size of QR code
 */
exports.getSymbolSize = function getSymbolSize (version) {
  if (!version) throw new Error('"version" cannot be null or undefined')
  if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40')
  return version * 4 + 17
}

/**
 * Returns the total number of codewords used to store data and EC information.
 *
 * @param  {Number} version QR Code version
 * @return {Number}         Data length in bits
 */
exports.getSymbolTotalCodewords = function getSymbolTotalCodewords (version) {
  return CODEWORDS_COUNT[version]
}

/**
 * Encode data with Bose-Chaudhuri-Hocquenghem
 *
 * @param  {Number} data Value to encode
 * @return {Number}      Encoded value
 */
exports.getBCHDigit = function (data) {
  let digit = 0

  while (data !== 0) {
    digit++
    data >>>= 1
  }

  return digit
}

exports.setToSJISFunction = function setToSJISFunction (f) {
  if (typeof f !== 'function') {
    throw new Error('"toSJISFunc" is not a valid function.')
  }

  toSJISFunction = f
}

exports.isKanjiModeEnabled = function () {
  return typeof toSJISFunction !== 'undefined'
}

exports.toSJIS = function toSJIS (kanji) {
  return toSJISFunction(kanji)
}

      return exports;
    })());

    registry.set('error-correction-level', (function () {
      const exports = {};
exports.L = { bit: 1 }
exports.M = { bit: 0 }
exports.Q = { bit: 3 }
exports.H = { bit: 2 }

function fromString (string) {
  if (typeof string !== 'string') {
    throw new Error('Param is not a string')
  }

  const lcStr = string.toLowerCase()

  switch (lcStr) {
    case 'l':
    case 'low':
      return exports.L

    case 'm':
    case 'medium':
      return exports.M

    case 'q':
    case 'quartile':
      return exports.Q

    case 'h':
    case 'high':
      return exports.H

    default:
      throw new Error('Unknown EC Level: ' + string)
  }
}

exports.isValid = function isValid (level) {
  return level && typeof level.bit !== 'undefined' &&
    level.bit >= 0 && level.bit < 4
}

exports.from = function from (value, defaultValue) {
  if (exports.isValid(value)) {
    return value
  }

  try {
    return fromString(value)
  } catch (e) {
    return defaultValue
  }
}

      return exports;
    })());

    registry.set('mode', (function () {
      const exports = {};
const VersionCheck = registry.get('version-check')
const Regex = registry.get('regex')

/**
 * Numeric mode encodes data from the decimal digit set (0 - 9)
 * (byte values 30HEX to 39HEX).
 * Normally, 3 data characters are represented by 10 bits.
 *
 * @type {Object}
 */
exports.NUMERIC = {
  id: 'Numeric',
  bit: 1 << 0,
  ccBits: [10, 12, 14]
}

/**
 * Alphanumeric mode encodes data from a set of 45 characters,
 * i.e. 10 numeric digits (0 - 9),
 *      26 alphabetic characters (A - Z),
 *   and 9 symbols (SP, $, %, *, +, -, ., /, :).
 * Normally, two input characters are represented by 11 bits.
 *
 * @type {Object}
 */
exports.ALPHANUMERIC = {
  id: 'Alphanumeric',
  bit: 1 << 1,
  ccBits: [9, 11, 13]
}

/**
 * In byte mode, data is encoded at 8 bits per character.
 *
 * @type {Object}
 */
exports.BYTE = {
  id: 'Byte',
  bit: 1 << 2,
  ccBits: [8, 16, 16]
}

/**
 * The Kanji mode efficiently encodes Kanji characters in accordance with
 * the Shift JIS system based on JIS X 0208.
 * The Shift JIS values are shifted from the JIS X 0208 values.
 * JIS X 0208 gives details of the shift coded representation.
 * Each two-byte character value is compacted to a 13-bit binary codeword.
 *
 * @type {Object}
 */
exports.KANJI = {
  id: 'Kanji',
  bit: 1 << 3,
  ccBits: [8, 10, 12]
}

/**
 * Mixed mode will contain a sequences of data in a combination of any of
 * the modes described above
 *
 * @type {Object}
 */
exports.MIXED = {
  bit: -1
}

/**
 * Returns the number of bits needed to store the data length
 * according to QR Code specifications.
 *
 * @param  {Mode}   mode    Data mode
 * @param  {Number} version QR Code version
 * @return {Number}         Number of bits
 */
exports.getCharCountIndicator = function getCharCountIndicator (mode, version) {
  if (!mode.ccBits) throw new Error('Invalid mode: ' + mode)

  if (!VersionCheck.isValid(version)) {
    throw new Error('Invalid version: ' + version)
  }

  if (version >= 1 && version < 10) return mode.ccBits[0]
  else if (version < 27) return mode.ccBits[1]
  return mode.ccBits[2]
}

/**
 * Returns the most efficient mode to store the specified data
 *
 * @param  {String} dataStr Input data string
 * @return {Mode}           Best mode
 */
exports.getBestModeForData = function getBestModeForData (dataStr) {
  if (Regex.testNumeric(dataStr)) return exports.NUMERIC
  else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC
  else if (Regex.testKanji(dataStr)) return exports.KANJI
  else return exports.BYTE
}

/**
 * Return mode name as string
 *
 * @param {Mode} mode Mode object
 * @returns {String}  Mode name
 */
exports.toString = function toString (mode) {
  if (mode && mode.id) return mode.id
  throw new Error('Invalid mode')
}

/**
 * Check if input param is a valid mode object
 *
 * @param   {Mode}    mode Mode object
 * @returns {Boolean} True if valid mode, false otherwise
 */
exports.isValid = function isValid (mode) {
  return mode && mode.bit && mode.ccBits
}

/**
 * Get mode object from its name
 *
 * @param   {String} string Mode name
 * @returns {Mode}          Mode object
 */
function fromString (string) {
  if (typeof string !== 'string') {
    throw new Error('Param is not a string')
  }

  const lcStr = string.toLowerCase()

  switch (lcStr) {
    case 'numeric':
      return exports.NUMERIC
    case 'alphanumeric':
      return exports.ALPHANUMERIC
    case 'kanji':
      return exports.KANJI
    case 'byte':
      return exports.BYTE
    default:
      throw new Error('Unknown mode: ' + string)
  }
}

/**
 * Returns mode from a value.
 * If value is not a valid mode, returns defaultValue
 *
 * @param  {Mode|String} value        Encoding mode
 * @param  {Mode}        defaultValue Fallback value
 * @return {Mode}                     Encoding mode
 */
exports.from = function from (value, defaultValue) {
  if (exports.isValid(value)) {
    return value
  }

  try {
    return fromString(value)
  } catch (e) {
    return defaultValue
  }
}

      return exports;
    })());

    registry.set('galois-field', (function () {
      const exports = {};
const EXP_TABLE = new Uint8Array(512)
const LOG_TABLE = new Uint8Array(256)
/**
 * Precompute the log and anti-log tables for faster computation later
 *
 * For each possible value in the galois field 2^8, we will pre-compute
 * the logarithm and anti-logarithm (exponential) of this value
 *
 * ref {@link https://en.wikiversity.org/wiki/Reed%E2%80%93Solomon_codes_for_coders#Introduction_to_mathematical_fields}
 */
;(function initTables () {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x
    LOG_TABLE[x] = i

    x <<= 1 // multiply by 2

    // The QR code specification says to use byte-wise modulo 100011101 arithmetic.
    // This means that when a number is 256 or larger, it should be XORed with 0x11D.
    if (x & 0x100) { // similar to x >= 256, but a lot faster (because 0x100 == 256)
      x ^= 0x11D
    }
  }

  // Optimization: double the size of the anti-log table so that we don't need to mod 255 to
  // stay inside the bounds (because we will mainly use this table for the multiplication of
  // two GF numbers, no more).
  // @see {@link mul}
  for (let i = 255; i < 512; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 255]
  }
}())

/**
 * Returns log value of n inside Galois Field
 *
 * @param  {Number} n
 * @return {Number}
 */
exports.log = function log (n) {
  if (n < 1) throw new Error('log(' + n + ')')
  return LOG_TABLE[n]
}

/**
 * Returns anti-log value of n inside Galois Field
 *
 * @param  {Number} n
 * @return {Number}
 */
exports.exp = function exp (n) {
  return EXP_TABLE[n]
}

/**
 * Multiplies two number inside Galois Field
 *
 * @param  {Number} x
 * @param  {Number} y
 * @return {Number}
 */
exports.mul = function mul (x, y) {
  if (x === 0 || y === 0) return 0

  // should be EXP_TABLE[(LOG_TABLE[x] + LOG_TABLE[y]) % 255] if EXP_TABLE wasn't oversized
  // @see {@link initTables}
  return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]]
}

      return exports;
    })());

    registry.set('polynomial', (function () {
      const exports = {};
const GF = registry.get('galois-field')

/**
 * Multiplies two polynomials inside Galois Field
 *
 * @param  {Uint8Array} p1 Polynomial
 * @param  {Uint8Array} p2 Polynomial
 * @return {Uint8Array}    Product of p1 and p2
 */
exports.mul = function mul (p1, p2) {
  const coeff = new Uint8Array(p1.length + p2.length - 1)

  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      coeff[i + j] ^= GF.mul(p1[i], p2[j])
    }
  }

  return coeff
}

/**
 * Calculate the remainder of polynomials division
 *
 * @param  {Uint8Array} divident Polynomial
 * @param  {Uint8Array} divisor  Polynomial
 * @return {Uint8Array}          Remainder
 */
exports.mod = function mod (divident, divisor) {
  let result = new Uint8Array(divident)

  while ((result.length - divisor.length) >= 0) {
    const coeff = result[0]

    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= GF.mul(divisor[i], coeff)
    }

    // remove all zeros from buffer head
    let offset = 0
    while (offset < result.length && result[offset] === 0) offset++
    result = result.slice(offset)
  }

  return result
}

/**
 * Generate an irreducible generator polynomial of specified degree
 * (used by Reed-Solomon encoder)
 *
 * @param  {Number} degree Degree of the generator polynomial
 * @return {Uint8Array}    Buffer containing polynomial coefficients
 */
exports.generateECPolynomial = function generateECPolynomial (degree) {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]))
  }

  return poly
}

      return exports;
    })());

    registry.set('reed-solomon-encoder', (function () {
      const exports = {};
const Polynomial = registry.get('polynomial')

function ReedSolomonEncoder (degree) {
  this.genPoly = undefined
  this.degree = degree

  if (this.degree) this.initialize(this.degree)
}

/**
 * Initialize the encoder.
 * The input param should correspond to the number of error correction codewords.
 *
 * @param  {Number} degree
 */
ReedSolomonEncoder.prototype.initialize = function initialize (degree) {
  // create an irreducible generator polynomial
  this.degree = degree
  this.genPoly = Polynomial.generateECPolynomial(this.degree)
}

/**
 * Encodes a chunk of data
 *
 * @param  {Uint8Array} data Buffer containing input data
 * @return {Uint8Array}      Buffer containing encoded data
 */
ReedSolomonEncoder.prototype.encode = function encode (data) {
  if (!this.genPoly) {
    throw new Error('Encoder not initialized')
  }

  // Calculate EC for this data block
  // extends data size to data+genPoly size
  const paddedData = new Uint8Array(data.length + this.degree)
  paddedData.set(data)

  // The error correction codewords are the remainder after dividing the data codewords
  // by a generator polynomial
  const remainder = Polynomial.mod(paddedData, this.genPoly)

  // return EC data blocks (last n byte, where n is the degree of genPoly)
  // If coefficients number in remainder are less than genPoly degree,
  // pad with 0s to the left to reach the needed number of coefficients
  const start = this.degree - remainder.length
  if (start > 0) {
    const buff = new Uint8Array(this.degree)
    buff.set(remainder, start)

    return buff
  }

  return remainder
}



exports.default = ReedSolomonEncoder;

      return exports;
    })());

    registry.set('error-correction-code', (function () {
      const exports = {};
const ECLevel = registry.get('error-correction-level')

const EC_BLOCKS_TABLE = [
// L  M  Q  H
  1, 1, 1, 1,
  1, 1, 1, 1,
  1, 1, 2, 2,
  1, 2, 2, 4,
  1, 2, 4, 4,
  2, 4, 4, 4,
  2, 4, 6, 5,
  2, 4, 6, 6,
  2, 5, 8, 8,
  4, 5, 8, 8,
  4, 5, 8, 11,
  4, 8, 10, 11,
  4, 9, 12, 16,
  4, 9, 16, 16,
  6, 10, 12, 18,
  6, 10, 17, 16,
  6, 11, 16, 19,
  6, 13, 18, 21,
  7, 14, 21, 25,
  8, 16, 20, 25,
  8, 17, 23, 25,
  9, 17, 23, 34,
  9, 18, 25, 30,
  10, 20, 27, 32,
  12, 21, 29, 35,
  12, 23, 34, 37,
  12, 25, 34, 40,
  13, 26, 35, 42,
  14, 28, 38, 45,
  15, 29, 40, 48,
  16, 31, 43, 51,
  17, 33, 45, 54,
  18, 35, 48, 57,
  19, 37, 51, 60,
  19, 38, 53, 63,
  20, 40, 56, 66,
  21, 43, 59, 70,
  22, 45, 62, 74,
  24, 47, 65, 77,
  25, 49, 68, 81
]

const EC_CODEWORDS_TABLE = [
// L  M  Q  H
  7, 10, 13, 17,
  10, 16, 22, 28,
  15, 26, 36, 44,
  20, 36, 52, 64,
  26, 48, 72, 88,
  36, 64, 96, 112,
  40, 72, 108, 130,
  48, 88, 132, 156,
  60, 110, 160, 192,
  72, 130, 192, 224,
  80, 150, 224, 264,
  96, 176, 260, 308,
  104, 198, 288, 352,
  120, 216, 320, 384,
  132, 240, 360, 432,
  144, 280, 408, 480,
  168, 308, 448, 532,
  180, 338, 504, 588,
  196, 364, 546, 650,
  224, 416, 600, 700,
  224, 442, 644, 750,
  252, 476, 690, 816,
  270, 504, 750, 900,
  300, 560, 810, 960,
  312, 588, 870, 1050,
  336, 644, 952, 1110,
  360, 700, 1020, 1200,
  390, 728, 1050, 1260,
  420, 784, 1140, 1350,
  450, 812, 1200, 1440,
  480, 868, 1290, 1530,
  510, 924, 1350, 1620,
  540, 980, 1440, 1710,
  570, 1036, 1530, 1800,
  570, 1064, 1590, 1890,
  600, 1120, 1680, 1980,
  630, 1204, 1770, 2100,
  660, 1260, 1860, 2220,
  720, 1316, 1950, 2310,
  750, 1372, 2040, 2430
]

/**
 * Returns the number of error correction block that the QR Code should contain
 * for the specified version and error correction level.
 *
 * @param  {Number} version              QR Code version
 * @param  {Number} errorCorrectionLevel Error correction level
 * @return {Number}                      Number of error correction blocks
 */
exports.getBlocksCount = function getBlocksCount (version, errorCorrectionLevel) {
  switch (errorCorrectionLevel) {
    case ECLevel.L:
      return EC_BLOCKS_TABLE[(version - 1) * 4 + 0]
    case ECLevel.M:
      return EC_BLOCKS_TABLE[(version - 1) * 4 + 1]
    case ECLevel.Q:
      return EC_BLOCKS_TABLE[(version - 1) * 4 + 2]
    case ECLevel.H:
      return EC_BLOCKS_TABLE[(version - 1) * 4 + 3]
    default:
      return undefined
  }
}

/**
 * Returns the number of error correction codewords to use for the specified
 * version and error correction level.
 *
 * @param  {Number} version              QR Code version
 * @param  {Number} errorCorrectionLevel Error correction level
 * @return {Number}                      Number of error correction codewords
 */
exports.getTotalCodewordsCount = function getTotalCodewordsCount (version, errorCorrectionLevel) {
  switch (errorCorrectionLevel) {
    case ECLevel.L:
      return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0]
    case ECLevel.M:
      return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1]
    case ECLevel.Q:
      return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2]
    case ECLevel.H:
      return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3]
    default:
      return undefined
  }
}

      return exports;
    })());

    registry.set('bit-buffer', (function () {
      const exports = {};
function BitBuffer () {
  this.buffer = []
  this.length = 0
}

BitBuffer.prototype = {

  get: function (index) {
    const bufIndex = Math.floor(index / 8)
    return ((this.buffer[bufIndex] >>> (7 - index % 8)) & 1) === 1
  },

  put: function (num, length) {
    for (let i = 0; i < length; i++) {
      this.putBit(((num >>> (length - i - 1)) & 1) === 1)
    }
  },

  getLengthInBits: function () {
    return this.length
  },

  putBit: function (bit) {
    const bufIndex = Math.floor(this.length / 8)
    if (this.buffer.length <= bufIndex) {
      this.buffer.push(0)
    }

    if (bit) {
      this.buffer[bufIndex] |= (0x80 >>> (this.length % 8))
    }

    this.length++
  }
}



exports.default = BitBuffer;

      return exports;
    })());

    registry.set('numeric-data', (function () {
      const exports = {};
const Mode = registry.get('mode')

function NumericData (data) {
  this.mode = Mode.NUMERIC
  this.data = data.toString()
}

NumericData.getBitsLength = function getBitsLength (length) {
  return 10 * Math.floor(length / 3) + ((length % 3) ? ((length % 3) * 3 + 1) : 0)
}

NumericData.prototype.getLength = function getLength () {
  return this.data.length
}

NumericData.prototype.getBitsLength = function getBitsLength () {
  return NumericData.getBitsLength(this.data.length)
}

NumericData.prototype.write = function write (bitBuffer) {
  let i, group, value

  // The input data string is divided into groups of three digits,
  // and each group is converted to its 10-bit binary equivalent.
  for (i = 0; i + 3 <= this.data.length; i += 3) {
    group = this.data.substr(i, 3)
    value = parseInt(group, 10)

    bitBuffer.put(value, 10)
  }

  // If the number of input digits is not an exact multiple of three,
  // the final one or two digits are converted to 4 or 7 bits respectively.
  const remainingNum = this.data.length - i
  if (remainingNum > 0) {
    group = this.data.substr(i)
    value = parseInt(group, 10)

    bitBuffer.put(value, remainingNum * 3 + 1)
  }
}



exports.default = NumericData;

      return exports;
    })());

    registry.set('alphanumeric-data', (function () {
      const exports = {};
const Mode = registry.get('mode')

/**
 * Array of characters available in alphanumeric mode
 *
 * As per QR Code specification, to each character
 * is assigned a value from 0 to 44 which in this case coincides
 * with the array index
 *
 * @type {Array}
 */
const ALPHA_NUM_CHARS = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  ' ', '$', '%', '*', '+', '-', '.', '/', ':'
]

function AlphanumericData (data) {
  this.mode = Mode.ALPHANUMERIC
  this.data = data
}

AlphanumericData.getBitsLength = function getBitsLength (length) {
  return 11 * Math.floor(length / 2) + 6 * (length % 2)
}

AlphanumericData.prototype.getLength = function getLength () {
  return this.data.length
}

AlphanumericData.prototype.getBitsLength = function getBitsLength () {
  return AlphanumericData.getBitsLength(this.data.length)
}

AlphanumericData.prototype.write = function write (bitBuffer) {
  let i

  // Input data characters are divided into groups of two characters
  // and encoded as 11-bit binary codes.
  for (i = 0; i + 2 <= this.data.length; i += 2) {
    // The character value of the first character is multiplied by 45
    let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45

    // The character value of the second digit is added to the product
    value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1])

    // The sum is then stored as 11-bit binary number
    bitBuffer.put(value, 11)
  }

  // If the number of input data characters is not a multiple of two,
  // the character value of the final character is encoded as a 6-bit binary number.
  if (this.data.length % 2) {
    bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6)
  }
}



exports.default = AlphanumericData;

      return exports;
    })());

    registry.set('byte-data', (function () {
      const exports = {};
const Mode = registry.get('mode')

function ByteData (data) {
  this.mode = Mode.BYTE
  if (typeof (data) === 'string') {
    this.data = new TextEncoder().encode(data)
  } else {
    this.data = new Uint8Array(data)
  }
}

ByteData.getBitsLength = function getBitsLength (length) {
  return length * 8
}

ByteData.prototype.getLength = function getLength () {
  return this.data.length
}

ByteData.prototype.getBitsLength = function getBitsLength () {
  return ByteData.getBitsLength(this.data.length)
}

ByteData.prototype.write = function (bitBuffer) {
  for (let i = 0, l = this.data.length; i < l; i++) {
    bitBuffer.put(this.data[i], 8)
  }
}



exports.default = ByteData;

      return exports;
    })());

    registry.set('kanji-data', (function () {
      const exports = {};
const Mode = registry.get('mode')
const Utils = registry.get('utils')

function KanjiData (data) {
  this.mode = Mode.KANJI
  this.data = data
}

KanjiData.getBitsLength = function getBitsLength (length) {
  return length * 13
}

KanjiData.prototype.getLength = function getLength () {
  return this.data.length
}

KanjiData.prototype.getBitsLength = function getBitsLength () {
  return KanjiData.getBitsLength(this.data.length)
}

KanjiData.prototype.write = function (bitBuffer) {
  let i

  // In the Shift JIS system, Kanji characters are represented by a two byte combination.
  // These byte values are shifted from the JIS X 0208 values.
  // JIS X 0208 gives details of the shift coded representation.
  for (i = 0; i < this.data.length; i++) {
    let value = Utils.toSJIS(this.data[i])

    // For characters with Shift JIS values from 0x8140 to 0x9FFC:
    if (value >= 0x8140 && value <= 0x9FFC) {
      // Subtract 0x8140 from Shift JIS value
      value -= 0x8140

    // For characters with Shift JIS values from 0xE040 to 0xEBBF
    } else if (value >= 0xE040 && value <= 0xEBBF) {
      // Subtract 0xC140 from Shift JIS value
      value -= 0xC140
    } else {
      throw new Error(
        'Invalid SJIS character: ' + this.data[i] + '\n' +
        'Make sure your charset is UTF-8')
    }

    // Multiply most significant byte of result by 0xC0
    // and add least significant byte to product
    value = (((value >>> 8) & 0xff) * 0xC0) + (value & 0xff)

    // Convert result to a 13-bit binary string
    bitBuffer.put(value, 13)
  }
}



exports.default = KanjiData;

      return exports;
    })());

    registry.set('version', (function () {
      const exports = {};
const Utils = registry.get('utils')
const ECCode = registry.get('error-correction-code')
const ECLevel = registry.get('error-correction-level')
const Mode = registry.get('mode')
const VersionCheck = registry.get('version-check')

// Generator polynomial used to encode version information
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0)
const G18_BCH = Utils.getBCHDigit(G18)

function getBestVersionForDataLength (mode, length, errorCorrectionLevel) {
  for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
    if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
      return currentVersion
    }
  }

  return undefined
}

function getReservedBitsCount (mode, version) {
  // Character count indicator + mode indicator bits
  return Mode.getCharCountIndicator(mode, version) + 4
}

function getTotalBitsFromDataArray (segments, version) {
  let totalBits = 0

  segments.forEach(function (data) {
    const reservedBits = getReservedBitsCount(data.mode, version)
    totalBits += reservedBits + data.getBitsLength()
  })

  return totalBits
}

function getBestVersionForMixedData (segments, errorCorrectionLevel) {
  for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
    const length = getTotalBitsFromDataArray(segments, currentVersion)
    if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
      return currentVersion
    }
  }

  return undefined
}

/**
 * Returns version number from a value.
 * If value is not a valid version, returns defaultValue
 *
 * @param  {Number|String} value        QR Code version
 * @param  {Number}        defaultValue Fallback value
 * @return {Number}                     QR Code version number
 */
exports.from = function from (value, defaultValue) {
  if (VersionCheck.isValid(value)) {
    return parseInt(value, 10)
  }

  return defaultValue
}

/**
 * Returns how much data can be stored with the specified QR code version
 * and error correction level
 *
 * @param  {Number} version              QR Code version (1-40)
 * @param  {Number} errorCorrectionLevel Error correction level
 * @param  {Mode}   mode                 Data mode
 * @return {Number}                      Quantity of storable data
 */
exports.getCapacity = function getCapacity (version, errorCorrectionLevel, mode) {
  if (!VersionCheck.isValid(version)) {
    throw new Error('Invalid QR Code version')
  }

  // Use Byte mode as default
  if (typeof mode === 'undefined') mode = Mode.BYTE

  // Total codewords for this QR code version (Data + Error correction)
  const totalCodewords = Utils.getSymbolTotalCodewords(version)

  // Total number of error correction codewords
  const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel)

  // Total number of data codewords
  const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8

  if (mode === Mode.MIXED) return dataTotalCodewordsBits

  const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version)

  // Return max number of storable codewords
  switch (mode) {
    case Mode.NUMERIC:
      return Math.floor((usableBits / 10) * 3)

    case Mode.ALPHANUMERIC:
      return Math.floor((usableBits / 11) * 2)

    case Mode.KANJI:
      return Math.floor(usableBits / 13)

    case Mode.BYTE:
    default:
      return Math.floor(usableBits / 8)
  }
}

/**
 * Returns the minimum version needed to contain the amount of data
 *
 * @param  {Segment} data                    Segment of data
 * @param  {Number} [errorCorrectionLevel=H] Error correction level
 * @param  {Mode} mode                       Data mode
 * @return {Number}                          QR Code version
 */
exports.getBestVersionForData = function getBestVersionForData (data, errorCorrectionLevel) {
  let seg

  const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M)

  if (Array.isArray(data)) {
    if (data.length > 1) {
      return getBestVersionForMixedData(data, ecl)
    }

    if (data.length === 0) {
      return 1
    }

    seg = data[0]
  } else {
    seg = data
  }

  return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl)
}

/**
 * Returns version information with relative error correction bits
 *
 * The version information is included in QR Code symbols of version 7 or larger.
 * It consists of an 18-bit sequence containing 6 data bits,
 * with 12 error correction bits calculated using the (18, 6) Golay code.
 *
 * @param  {Number} version QR Code version
 * @return {Number}         Encoded version info bits
 */
exports.getEncodedBits = function getEncodedBits (version) {
  if (!VersionCheck.isValid(version) || version < 7) {
    throw new Error('Invalid QR Code version')
  }

  let d = version << 12

  while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
    d ^= (G18 << (Utils.getBCHDigit(d) - G18_BCH))
  }

  return (version << 12) | d
}

      return exports;
    })());

    registry.set('finder-pattern', (function () {
      const exports = {};
const getSymbolSize = registry.get('utils').getSymbolSize
const FINDER_PATTERN_SIZE = 7

/**
 * Returns an array containing the positions of each finder pattern.
 * Each array's element represent the top-left point of the pattern as (x, y) coordinates
 *
 * @param  {Number} version QR Code version
 * @return {Array}          Array of coordinates
 */
exports.getPositions = function getPositions (version) {
  const size = getSymbolSize(version)

  return [
    // top-left
    [0, 0],
    // top-right
    [size - FINDER_PATTERN_SIZE, 0],
    // bottom-left
    [0, size - FINDER_PATTERN_SIZE]
  ]
}

      return exports;
    })());

    registry.set('alignment-pattern', (function () {
      const exports = {};
/**
 * Alignment pattern are fixed reference pattern in defined positions
 * in a matrix symbology, which enables the decode software to re-synchronise
 * the coordinate mapping of the image modules in the event of moderate amounts
 * of distortion of the image.
 *
 * Alignment patterns are present only in QR Code symbols of version 2 or larger
 * and their number depends on the symbol version.
 */

const getSymbolSize = registry.get('utils').getSymbolSize

/**
 * Calculate the row/column coordinates of the center module of each alignment pattern
 * for the specified QR Code version.
 *
 * The alignment patterns are positioned symmetrically on either side of the diagonal
 * running from the top left corner of the symbol to the bottom right corner.
 *
 * Since positions are simmetrical only half of the coordinates are returned.
 * Each item of the array will represent in turn the x and y coordinate.
 * @see {@link getPositions}
 *
 * @param  {Number} version QR Code version
 * @return {Array}          Array of coordinate
 */
exports.getRowColCoords = function getRowColCoords (version) {
  if (version === 1) return []

  const posCount = Math.floor(version / 7) + 2
  const size = getSymbolSize(version)
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2
  const positions = [size - 7] // Last coord is always (size - 7)

  for (let i = 1; i < posCount - 1; i++) {
    positions[i] = positions[i - 1] - intervals
  }

  positions.push(6) // First coord is always 6

  return positions.reverse()
}

/**
 * Returns an array containing the positions of each alignment pattern.
 * Each array's element represent the center point of the pattern as (x, y) coordinates
 *
 * Coordinates are calculated expanding the row/column coordinates returned by {@link getRowColCoords}
 * and filtering out the items that overlaps with finder pattern
 *
 * @example
 * For a Version 7 symbol {@link getRowColCoords} returns values 6, 22 and 38.
 * The alignment patterns, therefore, are to be centered on (row, column)
 * positions (6,22), (22,6), (22,22), (22,38), (38,22), (38,38).
 * Note that the coordinates (6,6), (6,38), (38,6) are occupied by finder patterns
 * and are not therefore used for alignment patterns.
 *
 * let pos = getPositions(7)
 * // [[6,22], [22,6], [22,22], [22,38], [38,22], [38,38]]
 *
 * @param  {Number} version QR Code version
 * @return {Array}          Array of coordinates
 */
exports.getPositions = function getPositions (version) {
  const coords = []
  const pos = exports.getRowColCoords(version)
  const posLength = pos.length

  for (let i = 0; i < posLength; i++) {
    for (let j = 0; j < posLength; j++) {
      // Skip if position is occupied by finder patterns
      if ((i === 0 && j === 0) || // top-left
          (i === 0 && j === posLength - 1) || // bottom-left
          (i === posLength - 1 && j === 0)) { // top-right
        continue
      }

      coords.push([pos[i], pos[j]])
    }
  }

  return coords
}

      return exports;
    })());

    registry.set('mask-pattern', (function () {
      const exports = {};
/**
 * Data mask pattern reference
 * @type {Object}
 */
exports.Patterns = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7
}

/**
 * Weighted penalty scores for the undesirable features
 * @type {Object}
 */
const PenaltyScores = {
  N1: 3,
  N2: 3,
  N3: 40,
  N4: 10
}

/**
 * Check if mask pattern value is valid
 *
 * @param  {Number}  mask    Mask pattern
 * @return {Boolean}         true if valid, false otherwise
 */
exports.isValid = function isValid (mask) {
  return mask != null && mask !== '' && !isNaN(mask) && mask >= 0 && mask <= 7
}

/**
 * Returns mask pattern from a value.
 * If value is not valid, returns undefined
 *
 * @param  {Number|String} value        Mask pattern value
 * @return {Number}                     Valid mask pattern or undefined
 */
exports.from = function from (value) {
  return exports.isValid(value) ? parseInt(value, 10) : undefined
}

/**
* Find adjacent modules in row/column with the same color
* and assign a penalty value.
*
* Points: N1 + i
* i is the amount by which the number of adjacent modules of the same color exceeds 5
*/
exports.getPenaltyN1 = function getPenaltyN1 (data) {
  const size = data.size
  let points = 0
  let sameCountCol = 0
  let sameCountRow = 0
  let lastCol = null
  let lastRow = null

  for (let row = 0; row < size; row++) {
    sameCountCol = sameCountRow = 0
    lastCol = lastRow = null

    for (let col = 0; col < size; col++) {
      let module = data.get(row, col)
      if (module === lastCol) {
        sameCountCol++
      } else {
        if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5)
        lastCol = module
        sameCountCol = 1
      }

      module = data.get(col, row)
      if (module === lastRow) {
        sameCountRow++
      } else {
        if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5)
        lastRow = module
        sameCountRow = 1
      }
    }

    if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5)
    if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5)
  }

  return points
}

/**
 * Find 2x2 blocks with the same color and assign a penalty value
 *
 * Points: N2 * (m - 1) * (n - 1)
 */
exports.getPenaltyN2 = function getPenaltyN2 (data) {
  const size = data.size
  let points = 0

  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const last = data.get(row, col) +
        data.get(row, col + 1) +
        data.get(row + 1, col) +
        data.get(row + 1, col + 1)

      if (last === 4 || last === 0) points++
    }
  }

  return points * PenaltyScores.N2
}

/**
 * Find 1:1:3:1:1 ratio (dark:light:dark:light:dark) pattern in row/column,
 * preceded or followed by light area 4 modules wide
 *
 * Points: N3 * number of pattern found
 */
exports.getPenaltyN3 = function getPenaltyN3 (data) {
  const size = data.size
  let points = 0
  let bitsCol = 0
  let bitsRow = 0

  for (let row = 0; row < size; row++) {
    bitsCol = bitsRow = 0
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7FF) | data.get(row, col)
      if (col >= 10 && (bitsCol === 0x5D0 || bitsCol === 0x05D)) points++

      bitsRow = ((bitsRow << 1) & 0x7FF) | data.get(col, row)
      if (col >= 10 && (bitsRow === 0x5D0 || bitsRow === 0x05D)) points++
    }
  }

  return points * PenaltyScores.N3
}

/**
 * Calculate proportion of dark modules in entire symbol
 *
 * Points: N4 * k
 *
 * k is the rating of the deviation of the proportion of dark modules
 * in the symbol from 50% in steps of 5%
 */
exports.getPenaltyN4 = function getPenaltyN4 (data) {
  let darkCount = 0
  const modulesCount = data.data.length

  for (let i = 0; i < modulesCount; i++) darkCount += data.data[i]

  const k = Math.abs(Math.ceil((darkCount * 100 / modulesCount) / 5) - 10)

  return k * PenaltyScores.N4
}

/**
 * Return mask value at given position
 *
 * @param  {Number} maskPattern Pattern reference value
 * @param  {Number} i           Row
 * @param  {Number} j           Column
 * @return {Boolean}            Mask value
 */
function getMaskAt (maskPattern, i, j) {
  switch (maskPattern) {
    case exports.Patterns.PATTERN000: return (i + j) % 2 === 0
    case exports.Patterns.PATTERN001: return i % 2 === 0
    case exports.Patterns.PATTERN010: return j % 3 === 0
    case exports.Patterns.PATTERN011: return (i + j) % 3 === 0
    case exports.Patterns.PATTERN100: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0
    case exports.Patterns.PATTERN101: return (i * j) % 2 + (i * j) % 3 === 0
    case exports.Patterns.PATTERN110: return ((i * j) % 2 + (i * j) % 3) % 2 === 0
    case exports.Patterns.PATTERN111: return ((i * j) % 3 + (i + j) % 2) % 2 === 0

    default: throw new Error('bad maskPattern:' + maskPattern)
  }
}

/**
 * Apply a mask pattern to a BitMatrix
 *
 * @param  {Number}    pattern Pattern reference number
 * @param  {BitMatrix} data    BitMatrix data
 */
exports.applyMask = function applyMask (pattern, data) {
  const size = data.size

  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size; row++) {
      if (data.isReserved(row, col)) continue
      data.xor(row, col, getMaskAt(pattern, row, col))
    }
  }
}

/**
 * Returns the best mask pattern for data
 *
 * @param  {BitMatrix} data
 * @return {Number} Mask pattern reference number
 */
exports.getBestMask = function getBestMask (data, setupFormatFunc) {
  const numPatterns = Object.keys(exports.Patterns).length
  let bestPattern = 0
  let lowerPenalty = Infinity

  for (let p = 0; p < numPatterns; p++) {
    setupFormatFunc(p)
    exports.applyMask(p, data)

    // Calculate penalty
    const penalty =
      exports.getPenaltyN1(data) +
      exports.getPenaltyN2(data) +
      exports.getPenaltyN3(data) +
      exports.getPenaltyN4(data)

    // Undo previously applied mask
    exports.applyMask(p, data)

    if (penalty < lowerPenalty) {
      lowerPenalty = penalty
      bestPattern = p
    }
  }

  return bestPattern
}

      return exports;
    })());

    registry.set('format-info', (function () {
      const exports = {};
const Utils = registry.get('utils')

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0)
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)
const G15_BCH = Utils.getBCHDigit(G15)

/**
 * Returns format information with relative error correction bits
 *
 * The format information is a 15-bit sequence containing 5 data bits,
 * with 10 error correction bits calculated using the (15, 5) BCH code.
 *
 * @param  {Number} errorCorrectionLevel Error correction level
 * @param  {Number} mask                 Mask pattern
 * @return {Number}                      Encoded format information bits
 */
exports.getEncodedBits = function getEncodedBits (errorCorrectionLevel, mask) {
  const data = ((errorCorrectionLevel.bit << 3) | mask)
  let d = data << 10

  while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
    d ^= (G15 << (Utils.getBCHDigit(d) - G15_BCH))
  }

  // xor final data with mask pattern in order to ensure that
  // no combination of Error Correction Level and data mask pattern
  // will result in an all-zero data string
  return ((data << 10) | d) ^ G15_MASK
}

      return exports;
    })());

    registry.set('bit-matrix', (function () {
      const exports = {};
/**
 * Helper class to handle QR Code symbol modules
 *
 * @param {Number} size Symbol size
 */
function BitMatrix (size) {
  if (!size || size < 1) {
    throw new Error('BitMatrix size must be defined and greater than 0')
  }

  this.size = size
  this.data = new Uint8Array(size * size)
  this.reservedBit = new Uint8Array(size * size)
}

/**
 * Set bit value at specified location
 * If reserved flag is set, this bit will be ignored during masking process
 *
 * @param {Number}  row
 * @param {Number}  col
 * @param {Boolean} value
 * @param {Boolean} reserved
 */
BitMatrix.prototype.set = function (row, col, value, reserved) {
  const index = row * this.size + col
  this.data[index] = value
  if (reserved) this.reservedBit[index] = true
}

/**
 * Returns bit value at specified location
 *
 * @param  {Number}  row
 * @param  {Number}  col
 * @return {Boolean}
 */
BitMatrix.prototype.get = function (row, col) {
  return this.data[row * this.size + col]
}

/**
 * Applies xor operator at specified location
 * (used during masking process)
 *
 * @param {Number}  row
 * @param {Number}  col
 * @param {Boolean} value
 */
BitMatrix.prototype.xor = function (row, col, value) {
  this.data[row * this.size + col] ^= value
}

/**
 * Check if bit at specified location is reserved
 *
 * @param {Number}   row
 * @param {Number}   col
 * @return {Boolean}
 */
BitMatrix.prototype.isReserved = function (row, col) {
  return this.reservedBit[row * this.size + col]
}



exports.default = BitMatrix;

      return exports;
    })());

    registry.set('segments', (function () {
      const exports = {};
const Mode = registry.get('mode')
const NumericData = registry.get('numeric-data')
const AlphanumericData = registry.get('alphanumeric-data')
const ByteData = registry.get('byte-data')
const KanjiData = registry.get('kanji-data')
const Regex = registry.get('regex')
const Utils = registry.get('utils')
const dijkstra = registry.get('dijkstrajs')

/**
 * Returns UTF8 byte length
 *
 * @param  {String} str Input string
 * @return {Number}     Number of byte
 */
function getStringByteLength (str) {
  return unescape(encodeURIComponent(str)).length
}

/**
 * Get a list of segments of the specified mode
 * from a string
 *
 * @param  {Mode}   mode Segment mode
 * @param  {String} str  String to process
 * @return {Array}       Array of object with segments data
 */
function getSegments (regex, mode, str) {
  const segments = []
  let result

  while ((result = regex.exec(str)) !== null) {
    segments.push({
      data: result[0],
      index: result.index,
      mode: mode,
      length: result[0].length
    })
  }

  return segments
}

/**
 * Extracts a series of segments with the appropriate
 * modes from a string
 *
 * @param  {String} dataStr Input string
 * @return {Array}          Array of object with segments data
 */
function getSegmentsFromString (dataStr) {
  const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr)
  const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr)
  let byteSegs
  let kanjiSegs

  if (Utils.isKanjiModeEnabled()) {
    byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr)
    kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr)
  } else {
    byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr)
    kanjiSegs = []
  }

  const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs)

  return segs
    .sort(function (s1, s2) {
      return s1.index - s2.index
    })
    .map(function (obj) {
      return {
        data: obj.data,
        mode: obj.mode,
        length: obj.length
      }
    })
}

/**
 * Returns how many bits are needed to encode a string of
 * specified length with the specified mode
 *
 * @param  {Number} length String length
 * @param  {Mode} mode     Segment mode
 * @return {Number}        Bit length
 */
function getSegmentBitsLength (length, mode) {
  switch (mode) {
    case Mode.NUMERIC:
      return NumericData.getBitsLength(length)
    case Mode.ALPHANUMERIC:
      return AlphanumericData.getBitsLength(length)
    case Mode.KANJI:
      return KanjiData.getBitsLength(length)
    case Mode.BYTE:
      return ByteData.getBitsLength(length)
  }
}

/**
 * Merges adjacent segments which have the same mode
 *
 * @param  {Array} segs Array of object with segments data
 * @return {Array}      Array of object with segments data
 */
function mergeSegments (segs) {
  return segs.reduce(function (acc, curr) {
    const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null
    if (prevSeg && prevSeg.mode === curr.mode) {
      acc[acc.length - 1].data += curr.data
      return acc
    }

    acc.push(curr)
    return acc
  }, [])
}

/**
 * Generates a list of all possible nodes combination which
 * will be used to build a segments graph.
 *
 * Nodes are divided by groups. Each group will contain a list of all the modes
 * in which is possible to encode the given text.
 *
 * For example the text '12345' can be encoded as Numeric, Alphanumeric or Byte.
 * The group for '12345' will contain then 3 objects, one for each
 * possible encoding mode.
 *
 * Each node represents a possible segment.
 *
 * @param  {Array} segs Array of object with segments data
 * @return {Array}      Array of object with segments data
 */
function buildNodes (segs) {
  const nodes = []
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]

    switch (seg.mode) {
      case Mode.NUMERIC:
        nodes.push([seg,
          { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
          { data: seg.data, mode: Mode.BYTE, length: seg.length }
        ])
        break
      case Mode.ALPHANUMERIC:
        nodes.push([seg,
          { data: seg.data, mode: Mode.BYTE, length: seg.length }
        ])
        break
      case Mode.KANJI:
        nodes.push([seg,
          { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
        ])
        break
      case Mode.BYTE:
        nodes.push([
          { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
        ])
    }
  }

  return nodes
}

/**
 * Builds a graph from a list of nodes.
 * All segments in each node group will be connected with all the segments of
 * the next group and so on.
 *
 * At each connection will be assigned a weight depending on the
 * segment's byte length.
 *
 * @param  {Array} nodes    Array of object with segments data
 * @param  {Number} version QR Code version
 * @return {Object}         Graph of all possible segments
 */
function buildGraph (nodes, version) {
  const table = {}
  const graph = { start: {} }
  let prevNodeIds = ['start']

  for (let i = 0; i < nodes.length; i++) {
    const nodeGroup = nodes[i]
    const currentNodeIds = []

    for (let j = 0; j < nodeGroup.length; j++) {
      const node = nodeGroup[j]
      const key = '' + i + j

      currentNodeIds.push(key)
      table[key] = { node: node, lastCount: 0 }
      graph[key] = {}

      for (let n = 0; n < prevNodeIds.length; n++) {
        const prevNodeId = prevNodeIds[n]

        if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
          graph[prevNodeId][key] =
            getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) -
            getSegmentBitsLength(table[prevNodeId].lastCount, node.mode)

          table[prevNodeId].lastCount += node.length
        } else {
          if (table[prevNodeId]) table[prevNodeId].lastCount = node.length

          graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) +
            4 + Mode.getCharCountIndicator(node.mode, version) // switch cost
        }
      }
    }

    prevNodeIds = currentNodeIds
  }

  for (let n = 0; n < prevNodeIds.length; n++) {
    graph[prevNodeIds[n]].end = 0
  }

  return { map: graph, table: table }
}

/**
 * Builds a segment from a specified data and mode.
 * If a mode is not specified, the more suitable will be used.
 *
 * @param  {String} data             Input data
 * @param  {Mode | String} modesHint Data mode
 * @return {Segment}                 Segment
 */
function buildSingleSegment (data, modesHint) {
  let mode
  const bestMode = Mode.getBestModeForData(data)

  mode = Mode.from(modesHint, bestMode)

  // Make sure data can be encoded
  if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
    throw new Error('"' + data + '"' +
      ' cannot be encoded with mode ' + Mode.toString(mode) +
      '.\n Suggested mode is: ' + Mode.toString(bestMode))
  }

  // Use Mode.BYTE if Kanji support is disabled
  if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
    mode = Mode.BYTE
  }

  switch (mode) {
    case Mode.NUMERIC:
      return new NumericData(data)

    case Mode.ALPHANUMERIC:
      return new AlphanumericData(data)

    case Mode.KANJI:
      return new KanjiData(data)

    case Mode.BYTE:
      return new ByteData(data)
  }
}

/**
 * Builds a list of segments from an array.
 * Array can contain Strings or Objects with segment's info.
 *
 * For each item which is a string, will be generated a segment with the given
 * string and the more appropriate encoding mode.
 *
 * For each item which is an object, will be generated a segment with the given
 * data and mode.
 * Objects must contain at least the property "data".
 * If property "mode" is not present, the more suitable mode will be used.
 *
 * @param  {Array} array Array of objects with segments data
 * @return {Array}       Array of Segments
 */
exports.fromArray = function fromArray (array) {
  return array.reduce(function (acc, seg) {
    if (typeof seg === 'string') {
      acc.push(buildSingleSegment(seg, null))
    } else if (seg.data) {
      acc.push(buildSingleSegment(seg.data, seg.mode))
    }

    return acc
  }, [])
}

/**
 * Builds an optimized sequence of segments from a string,
 * which will produce the shortest possible bitstream.
 *
 * @param  {String} data    Input string
 * @param  {Number} version QR Code version
 * @return {Array}          Array of segments
 */
exports.fromString = function fromString (data, version) {
  const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled())

  const nodes = buildNodes(segs)
  const graph = buildGraph(nodes, version)
  const path = dijkstra.find_path(graph.map, 'start', 'end')

  const optimizedSegs = []
  for (let i = 1; i < path.length - 1; i++) {
    optimizedSegs.push(graph.table[path[i]].node)
  }

  return exports.fromArray(mergeSegments(optimizedSegs))
}

/**
 * Splits a string in various segments with the modes which
 * best represent their content.
 * The produced segments are far from being optimized.
 * The output of this function is only used to estimate a QR Code version
 * which may contain the data.
 *
 * @param  {string} data Input string
 * @return {Array}       Array of segments
 */
exports.rawSplit = function rawSplit (data) {
  return exports.fromArray(
    getSegmentsFromString(data, Utils.isKanjiModeEnabled())
  )
}

      return exports;
    })());

    registry.set('qrcode', (function () {
      const exports = {};
const Utils = registry.get('utils')
const ECLevel = registry.get('error-correction-level')
const BitBuffer = registry.get('bit-buffer')
const BitMatrix = registry.get('bit-matrix')
const AlignmentPattern = registry.get('alignment-pattern')
const FinderPattern = registry.get('finder-pattern')
const MaskPattern = registry.get('mask-pattern')
const ECCode = registry.get('error-correction-code')
const ReedSolomonEncoder = registry.get('reed-solomon-encoder')
const Version = registry.get('version')
const FormatInfo = registry.get('format-info')
const Mode = registry.get('mode')
const Segments = registry.get('segments')

/**
 * QRCode for JavaScript
 *
 * modified by Ryan Day for nodejs support
 * Copyright (c) 2011 Ryan Day
 *
 * Licensed under the MIT license:
 *   http://www.opensource.org/licenses/mit-license.php
 *
//---------------------------------------------------------------------
// QRCode for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//   http://www.opensource.org/licenses/mit-license.php
//
// The word "QR Code" is registered trademark of
// DENSO WAVE INCORPORATED
//   http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------
*/

/**
 * Add finder patterns bits to matrix
 *
 * @param  {BitMatrix} matrix  Modules matrix
 * @param  {Number}    version QR Code version
 */
function setupFinderPattern (matrix, version) {
  const size = matrix.size
  const pos = FinderPattern.getPositions(version)

  for (let i = 0; i < pos.length; i++) {
    const row = pos[i][0]
    const col = pos[i][1]

    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue

      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue

        if ((r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
          matrix.set(row + r, col + c, true, true)
        } else {
          matrix.set(row + r, col + c, false, true)
        }
      }
    }
  }
}

/**
 * Add timing pattern bits to matrix
 *
 * Note: this function must be called before {@link setupAlignmentPattern}
 *
 * @param  {BitMatrix} matrix Modules matrix
 */
function setupTimingPattern (matrix) {
  const size = matrix.size

  for (let r = 8; r < size - 8; r++) {
    const value = r % 2 === 0
    matrix.set(r, 6, value, true)
    matrix.set(6, r, value, true)
  }
}

/**
 * Add alignment patterns bits to matrix
 *
 * Note: this function must be called after {@link setupTimingPattern}
 *
 * @param  {BitMatrix} matrix  Modules matrix
 * @param  {Number}    version QR Code version
 */
function setupAlignmentPattern (matrix, version) {
  const pos = AlignmentPattern.getPositions(version)

  for (let i = 0; i < pos.length; i++) {
    const row = pos[i][0]
    const col = pos[i][1]

    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        if (r === -2 || r === 2 || c === -2 || c === 2 ||
          (r === 0 && c === 0)) {
          matrix.set(row + r, col + c, true, true)
        } else {
          matrix.set(row + r, col + c, false, true)
        }
      }
    }
  }
}

/**
 * Add version info bits to matrix
 *
 * @param  {BitMatrix} matrix  Modules matrix
 * @param  {Number}    version QR Code version
 */
function setupVersionInfo (matrix, version) {
  const size = matrix.size
  const bits = Version.getEncodedBits(version)
  let row, col, mod

  for (let i = 0; i < 18; i++) {
    row = Math.floor(i / 3)
    col = i % 3 + size - 8 - 3
    mod = ((bits >> i) & 1) === 1

    matrix.set(row, col, mod, true)
    matrix.set(col, row, mod, true)
  }
}

/**
 * Add format info bits to matrix
 *
 * @param  {BitMatrix} matrix               Modules matrix
 * @param  {ErrorCorrectionLevel}    errorCorrectionLevel Error correction level
 * @param  {Number}    maskPattern          Mask pattern reference value
 */
function setupFormatInfo (matrix, errorCorrectionLevel, maskPattern) {
  const size = matrix.size
  const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern)
  let i, mod

  for (i = 0; i < 15; i++) {
    mod = ((bits >> i) & 1) === 1

    // vertical
    if (i < 6) {
      matrix.set(i, 8, mod, true)
    } else if (i < 8) {
      matrix.set(i + 1, 8, mod, true)
    } else {
      matrix.set(size - 15 + i, 8, mod, true)
    }

    // horizontal
    if (i < 8) {
      matrix.set(8, size - i - 1, mod, true)
    } else if (i < 9) {
      matrix.set(8, 15 - i - 1 + 1, mod, true)
    } else {
      matrix.set(8, 15 - i - 1, mod, true)
    }
  }

  // fixed module
  matrix.set(size - 8, 8, 1, true)
}

/**
 * Add encoded data bits to matrix
 *
 * @param  {BitMatrix}  matrix Modules matrix
 * @param  {Uint8Array} data   Data codewords
 */
function setupData (matrix, data) {
  const size = matrix.size
  let inc = -1
  let row = size - 1
  let bitIndex = 7
  let byteIndex = 0

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--

    while (true) {
      for (let c = 0; c < 2; c++) {
        if (!matrix.isReserved(row, col - c)) {
          let dark = false

          if (byteIndex < data.length) {
            dark = (((data[byteIndex] >>> bitIndex) & 1) === 1)
          }

          matrix.set(row, col - c, dark)
          bitIndex--

          if (bitIndex === -1) {
            byteIndex++
            bitIndex = 7
          }
        }
      }

      row += inc

      if (row < 0 || size <= row) {
        row -= inc
        inc = -inc
        break
      }
    }
  }
}

/**
 * Create encoded codewords from data input
 *
 * @param  {Number}   version              QR Code version
 * @param  {ErrorCorrectionLevel}   errorCorrectionLevel Error correction level
 * @param  {ByteData} data                 Data input
 * @return {Uint8Array}                    Buffer containing encoded codewords
 */
function createData (version, errorCorrectionLevel, segments) {
  // Prepare data buffer
  const buffer = new BitBuffer()

  segments.forEach(function (data) {
    // prefix data with mode indicator (4 bits)
    buffer.put(data.mode.bit, 4)

    // Prefix data with character count indicator.
    // The character count indicator is a string of bits that represents the
    // number of characters that are being encoded.
    // The character count indicator must be placed after the mode indicator
    // and must be a certain number of bits long, depending on the QR version
    // and data mode
    // @see {@link Mode.getCharCountIndicator}.
    buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version))

    // add binary data sequence to buffer
    data.write(buffer)
  })

  // Calculate required number of bits
  const totalCodewords = Utils.getSymbolTotalCodewords(version)
  const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel)
  const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8

  // Add a terminator.
  // If the bit string is shorter than the total number of required bits,
  // a terminator of up to four 0s must be added to the right side of the string.
  // If the bit string is more than four bits shorter than the required number of bits,
  // add four 0s to the end.
  if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
    buffer.put(0, 4)
  }

  // If the bit string is fewer than four bits shorter, add only the number of 0s that
  // are needed to reach the required number of bits.

  // After adding the terminator, if the number of bits in the string is not a multiple of 8,
  // pad the string on the right with 0s to make the string's length a multiple of 8.
  while (buffer.getLengthInBits() % 8 !== 0) {
    buffer.putBit(0)
  }

  // Add pad bytes if the string is still shorter than the total number of required bits.
  // Extend the buffer to fill the data capacity of the symbol corresponding to
  // the Version and Error Correction Level by adding the Pad Codewords 11101100 (0xEC)
  // and 00010001 (0x11) alternately.
  const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8
  for (let i = 0; i < remainingByte; i++) {
    buffer.put(i % 2 ? 0x11 : 0xEC, 8)
  }

  return createCodewords(buffer, version, errorCorrectionLevel)
}

/**
 * Encode input data with Reed-Solomon and return codewords with
 * relative error correction bits
 *
 * @param  {BitBuffer} bitBuffer            Data to encode
 * @param  {Number}    version              QR Code version
 * @param  {ErrorCorrectionLevel} errorCorrectionLevel Error correction level
 * @return {Uint8Array}                     Buffer containing encoded codewords
 */
function createCodewords (bitBuffer, version, errorCorrectionLevel) {
  // Total codewords for this QR code version (Data + Error correction)
  const totalCodewords = Utils.getSymbolTotalCodewords(version)

  // Total number of error correction codewords
  const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel)

  // Total number of data codewords
  const dataTotalCodewords = totalCodewords - ecTotalCodewords

  // Total number of blocks
  const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel)

  // Calculate how many blocks each group should contain
  const blocksInGroup2 = totalCodewords % ecTotalBlocks
  const blocksInGroup1 = ecTotalBlocks - blocksInGroup2

  const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks)

  const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks)
  const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1

  // Number of EC codewords is the same for both groups
  const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1

  // Initialize a Reed-Solomon encoder with a generator polynomial of degree ecCount
  const rs = new ReedSolomonEncoder(ecCount)

  let offset = 0
  const dcData = new Array(ecTotalBlocks)
  const ecData = new Array(ecTotalBlocks)
  let maxDataSize = 0
  const buffer = new Uint8Array(bitBuffer.buffer)

  // Divide the buffer into the required number of blocks
  for (let b = 0; b < ecTotalBlocks; b++) {
    const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2

    // extract a block of data from buffer
    dcData[b] = buffer.slice(offset, offset + dataSize)

    // Calculate EC codewords for this data block
    ecData[b] = rs.encode(dcData[b])

    offset += dataSize
    maxDataSize = Math.max(maxDataSize, dataSize)
  }

  // Create final data
  // Interleave the data and error correction codewords from each block
  const data = new Uint8Array(totalCodewords)
  let index = 0
  let i, r

  // Add data codewords
  for (i = 0; i < maxDataSize; i++) {
    for (r = 0; r < ecTotalBlocks; r++) {
      if (i < dcData[r].length) {
        data[index++] = dcData[r][i]
      }
    }
  }

  // Apped EC codewords
  for (i = 0; i < ecCount; i++) {
    for (r = 0; r < ecTotalBlocks; r++) {
      data[index++] = ecData[r][i]
    }
  }

  return data
}

/**
 * Build QR Code symbol
 *
 * @param  {String} data                 Input string
 * @param  {Number} version              QR Code version
 * @param  {ErrorCorretionLevel} errorCorrectionLevel Error level
 * @param  {MaskPattern} maskPattern     Mask pattern
 * @return {Object}                      Object containing symbol data
 */
function createSymbol (data, version, errorCorrectionLevel, maskPattern) {
  let segments

  if (Array.isArray(data)) {
    segments = Segments.fromArray(data)
  } else if (typeof data === 'string') {
    let estimatedVersion = version

    if (!estimatedVersion) {
      const rawSegments = Segments.rawSplit(data)

      // Estimate best version that can contain raw splitted segments
      estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel)
    }

    // Build optimized segments
    // If estimated version is undefined, try with the highest version
    segments = Segments.fromString(data, estimatedVersion || 40)
  } else {
    throw new Error('Invalid data')
  }

  // Get the min version that can contain data
  const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel)

  // If no version is found, data cannot be stored
  if (!bestVersion) {
    throw new Error('The amount of data is too big to be stored in a QR Code')
  }

  // If not specified, use min version as default
  if (!version) {
    version = bestVersion

  // Check if the specified version can contain the data
  } else if (version < bestVersion) {
    throw new Error('\n' +
      'The chosen QR Code version cannot contain this amount of data.\n' +
      'Minimum version required to store current data is: ' + bestVersion + '.\n'
    )
  }

  const dataBits = createData(version, errorCorrectionLevel, segments)

  // Allocate matrix buffer
  const moduleCount = Utils.getSymbolSize(version)
  const modules = new BitMatrix(moduleCount)

  // Add function modules
  setupFinderPattern(modules, version)
  setupTimingPattern(modules)
  setupAlignmentPattern(modules, version)

  // Add temporary dummy bits for format info just to set them as reserved.
  // This is needed to prevent these bits from being masked by {@link MaskPattern.applyMask}
  // since the masking operation must be performed only on the encoding region.
  // These blocks will be replaced with correct values later in code.
  setupFormatInfo(modules, errorCorrectionLevel, 0)

  if (version >= 7) {
    setupVersionInfo(modules, version)
  }

  // Add data codewords
  setupData(modules, dataBits)

  if (isNaN(maskPattern)) {
    // Find best mask pattern
    maskPattern = MaskPattern.getBestMask(modules,
      setupFormatInfo.bind(null, modules, errorCorrectionLevel))
  }

  // Apply mask pattern
  MaskPattern.applyMask(maskPattern, modules)

  // Replace format info bits with correct values
  setupFormatInfo(modules, errorCorrectionLevel, maskPattern)

  return {
    modules: modules,
    version: version,
    errorCorrectionLevel: errorCorrectionLevel,
    maskPattern: maskPattern,
    segments: segments
  }
}

/**
 * QR Code
 *
 * @param {String | Array} data                 Input data
 * @param {Object} options                      Optional configurations
 * @param {Number} options.version              QR Code version
 * @param {String} options.errorCorrectionLevel Error correction level
 * @param {Function} options.toSJISFunc         Helper func to convert utf8 to sjis
 */
exports.create = function create (data, options) {
  if (typeof data === 'undefined' || data === '') {
    throw new Error('No input text')
  }

  let errorCorrectionLevel = ECLevel.M
  let version
  let mask

  if (typeof options !== 'undefined') {
    // Use higher error correction level as default
    errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M)
    version = Version.from(options.version)
    mask = MaskPattern.from(options.maskPattern)

    if (options.toSJISFunc) {
      Utils.setToSJISFunction(options.toSJISFunc)
    }
  }

  return createSymbol(data, version, errorCorrectionLevel, mask)
}

      return exports;
    })());

const QRCode = registry.get("qrcode");
/** 生成二维码矩阵。返回 { size, data, version }。data[y*N+x] = 0/1 */
function qrCreate(text, opts) {
  const qr = QRCode.create(text, { errorCorrectionLevel: (opts && opts.ec) || "L" });
  return {
    size: qr.modules.size,
    data: qr.modules.data,
    version: qr.version,
  };
}

/* ===== qrcode 库内联结束 ===== */

    /**
     * 二维码生成：调用 qrCreate（qrcode@1.5.4 内联，见上方内联区块）。
     *
     * 曾经在这里手写了一套 Reed-Solomon + 掩码，三个 bug 叠加导致二维码扫不出来：
     *   ① EC 长度表写错（v1-L 才是 7，我写成了 "v<=9 ? 7 : 10"）
     *   ② 拿字符容量(32)当数据码字数(34)做 pad，总码字数对不上
     *   ③ 完全跳过 mask 与格式信息的 BCH 编码 —— 这是 QR 标准的必选项
     * 表现是数据区填充率只有 24.5%（正常约 50%），jsQR 解码直接失败。
     * 与其继续打补丁，改成把验证过的库整个搬进来：tools/build-qr.mjs
     * 按依赖顺序内联 22 个模块 + dijkstrajs，拼接在 client.js 工厂作用域里。
     * 已验证与 qrcode 库逐模块零差异（与官方 qrcode 库逐模块对齐）。
     */
    function qrSvg(text) {
      let qr;
      try {
        qr = qrCreate(text);
      } catch (e) {
        return null;
      }
      if (!qr || !qr.data) return null;
      const N = qr.size;
      let d = '';
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (qr.data[y * N + x]) d += 'M' + x + ' ' + y + 'h1v1h-1z';
        }
      }
      return { path: d, modules: N };
    }
    const QR_CSS = `
.ms-scan{padding:28px 24px 40px;max-width:560px;margin:0 auto;font-family:var(--dsw-font-family);height:100%;min-height:0;box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain}
.ms-scan-h{margin:0 0 6px;font-size:20px;font-weight:650;color:var(--dsw-alias-label-primary)}
.ms-scan-sub{margin:0 0 22px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ms-scan--settings{padding:4px 0 24px;max-width:none;height:auto;min-height:0;overflow:visible}
.ms-scan--settings .ms-scan-h{font-size:17px}
.ms-qr{display:block;width:212px;height:212px;margin:0 auto 6px;background:#fff;border-radius:14px;padding:10px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1)}
.ms-qr-fail{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;padding:0 12px}
.ms-url{margin:0 0 20px;padding:6px 6px 6px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;gap:8px}
.ms-url-text{flex:1;min-width:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:var(--dsw-font-mono,monospace)}
.ms-copy{flex:0 0 auto;padding:6px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:background .13s ease,color .13s ease}
.ms-copy:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ms-copy:active{transform:scale(.97)}
.ms-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}
.ms-steps li{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ms-steps b{flex:0 0 auto;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650;display:grid;place-items:center}
.ms-warn{margin:18px 0 0;padding:11px 13px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#8a5a00) 12%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#8a5a00));font-size:12px;line-height:1.6}
/* 坏状态（二维码没有票据）：比普通提示更显眼，因为它是"扫了也进不去" */
.ms-warn-bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b3261e) 12%,transparent);color:var(--dsw-alias-state-error-primary,#b3261e)}
.ms-refresh{margin:18px 0 0;text-align:center}
.ms-refresh-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:background .13s ease,color .13s ease,border-color .13s ease}
.ms-refresh-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ms-refresh-btn:active{transform:scale(.97)}
.ms-cfg{margin:26px 0 0;padding:18px 0 0;border-top:1px solid var(--dsw-alias-border-l1)}
.ms-cfg-h{margin:0 0 4px;font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary)}
.ms-cfg-sub{margin:0 0 14px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ms-search{margin:0 0 10px;display:flex}
.ms-search .ms-input{flex:1}
.ms-plug{display:flex;flex-direction:column;gap:2px;max-height:230px;overflow:auto;margin:0 0 4px}
.ms-plug-row{display:flex;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ms-plug-row:last-child{border-bottom:0}
.ms-plug-name{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:var(--dsw-font-mono,monospace)}
.ms-switch{flex:0 0 auto;width:38px;height:22px;border-radius:20px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.ms-switch::before{content:'';position:absolute;top:-7px;right:-12px;bottom:-7px;left:-12px;border-radius:20px}
.ms-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s ease}
.ms-switch[data-on='1']{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.ms-switch[data-on='1']::after{transform:translateX(16px)}
.ms-switch[aria-disabled='true']{opacity:.42;cursor:default}
.ms-cfg-note{margin:10px 0 0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.ms-auth-row{display:flex;gap:8px;margin:0 0 10px}
.ms-input{flex:1;min-width:0;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.ms-input:focus{border-color:var(--dsw-alias-label-primary)}
.ms-btn{padding:9px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:all .13s ease}
.ms-btn:hover{border-color:var(--dsw-alias-border-l2)}
.ms-btn:active{transform:scale(.98)}
.ms-btn[disabled]{opacity:.5;cursor:default}
.ms-msg{margin:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ms-msg[data-kind='err']{color:#B4362F}
`;

    // ---------------- 插件放行名单 / 密码面板 ----------------
    //
    // 数据都在宿主侧（~/.dsh/mobile-studio/config.json），这里只做勾选。
    // 勾上=手机端放行，不勾=不下发；官方插件和本插件固定放行，不给开关；
    // 专门做了兼容或不会影响移动端 UI 的插件（compat，随安装情况变化）默认勾选，可手动关闭。
    function PolicyPanel() {
      const [data, setData] = React.useState(null);
      const [allow, setAllow] = React.useState([]);
      const [q, setQ] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [bad, setBad] = React.useState(false);
      const [busy, setBusy] = React.useState(false);

      function loadList() {
        fetch('/api/mobile-studio/filter', { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok) { setMsg('读取名单失败'); setBad(true); return; }
            setData(d);
            setAllow(d.allow || []);
          })
          .catch(function () { setMsg('无法连接宿主'); setBad(true); });
      }

      React.useEffect(function () { loadList(); }, []);

      function save(next) {
        setBusy(true);
        setMsg('');
        setBad(false);
        fetch('/api/mobile-studio/filter', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allow: next }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) setMsg('已保存，手机刷新页面后生效');
            else { setMsg('保存失败：' + ((d && d.error) || '未知错误')); setBad(true); }
          })
          .catch(function () { setMsg('保存失败：网络错误'); setBad(true); })
          .then(function () { setBusy(false); });
      }

      function toggle(id) {
        const next = allow.indexOf(id) >= 0
          ? allow.filter(function (x) { return x !== id; })
          : allow.concat([id]);
        setAllow(next);
        save(next);
      }

      if (!data) {
        return h('div', { className: 'ms-cfg' },
          h('h3', { className: 'ms-cfg-h' }, '放行白名单'),
          h('p', { className: 'ms-msg', 'data-kind': bad ? 'err' : 'ok' }, msg || '正在读取…'),
        );
      }

      const official = data.official || [];
      const compat = data.compat || [];
      const third = data.thirdParty || [];
      const selfName = data.self || '本插件';
      const kw = q.trim().toLowerCase();
      // 放行的自动置顶：先按"是否已放行"，再按名字排。
      // 这样点开开关它就跳到最上面，关掉就落回下面，不用在一长串里找它现在是什么状态。
      const byAllow = function (a, b) {
        const ao = allow.indexOf(a) >= 0 ? 0 : 1;
        const bo = allow.indexOf(b) >= 0 ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return a.localeCompare(b);
      };
      // 做了兼容的插件天然排在前面，其余第三方跟在后面；都按实际数据来
      const list = compat.concat(third)
        .filter(function (id, i, a) { return a.indexOf(id) === i; })
        .sort(byAllow);
      const shown = kw ? list.filter(function (id) { return id.toLowerCase().indexOf(kw) >= 0; }) : list;

      return h('div', { className: 'ms-cfg' },
        h('h3', { className: 'ms-cfg-h' }, '放行白名单'),
        h('p', { className: 'ms-cfg-sub' }, '勾选的插件会在手机端放行，不勾选则不下发。已经放行的排在列表最前面；专门做了兼容或不会影响移动端 UI 的插件默认勾选，可手动关闭；官方插件始终放行。'),
        h('div', { className: 'ms-search' },
          h('input', {
            className: 'ms-input',
            type: 'search',
            placeholder: '搜索插件名',
            value: q,
            onChange: function (e) { setQ(e.target.value); },
          }),
        ),
        h('div', { className: 'ms-plug' },
          list.length === 0
            ? h('p', { className: 'ms-msg' }, '没有发现第三方插件')
            : shown.length === 0
              ? h('p', { className: 'ms-msg' }, '没有匹配的插件')
              : shown.map(function (id) {
                  const on = allow.indexOf(id) >= 0;
                  return h('div', { className: 'ms-plug-row', key: id },
                    h('span', { className: 'ms-plug-name' }, id),
                    h('button', {
                      type: 'button',
                      className: 'ms-switch',
                      'data-on': on ? '1' : '0',
                      'aria-label': (on ? '取消放行 ' : '放行 ') + id,
                      onClick: busy ? null : function () { toggle(id); },
                    }),
                  );
                }),
        ),
        msg ? h('p', { className: 'ms-msg', 'data-kind': bad ? 'err' : 'ok' }, msg) : null,
      );
    }

    function AuthPanel(props) {
      const [enabled, setEnabled] = React.useState(false);
      const [pw, setPw] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [bad, setBad] = React.useState(false);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(function () {
        fetch('/api/mobile-studio/auth', { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) {
              setEnabled(!!d.enabled);
              // 只同步状态、不触发重取：让外层能在"密码开着但码里没票据"时报警
              if (props && typeof props.onState === 'function') props.onState(!!d.enabled);
            }
          })
          .catch(function () { /* 读不到就按未启用显示 */ });
      }, []);

      function submit(value) {
        setBusy(true);
        setMsg('');
        setBad(false);
        fetch('/api/mobile-studio/auth', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: value }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) {
              setEnabled(!!d.enabled);
              setPw('');
              setMsg(d.enabled ? '密码已设置：二维码已自动换成新码，请重新扫一次（旧码立即作废）' : '密码已关闭：二维码已恢复为扫码即开');
              // 告诉外层：auth 变了 → 二维码必须重取。
              // 0.9.4 前这里只改自己的文案，面板上那张码还是「没密码时代」的干净 /m，
              // 扫了必然落登录页 —— 用户报的「扫码不包含密码」就是这个。
              if (props && typeof props.onChanged === 'function') props.onChanged(!!d.enabled);
            } else {
              setMsg('设置失败：' + ((d && d.error) || '未知错误'));
              setBad(true);
            }
          })
          .catch(function () { setMsg('设置失败：网络错误'); setBad(true); })
          .then(function () { setBusy(false); });
      }

      return h('div', { className: 'ms-cfg' },
        h('h3', { className: 'ms-cfg-h' }, '手机端访问密码'),
        h('p', { className: 'ms-cfg-sub' },
          enabled
            ? '已启用：手机 App 扫二维码可直接登录（票据登录）；手动输入地址或换设备时才需要密码，登录状态保留 30 天。'
            : '未启用：同一 WiFi 下拿到地址就能打开。设置密码后，扫码仍是一步登录，手填地址才需密码。'),
        h('div', { className: 'ms-auth-row' },
          h('input', {
            className: 'ms-input', type: 'password', autoComplete: 'new-password',
            placeholder: enabled ? '输入新密码（至少 6 位）' : '设置密码（至少 6 位）',
            value: pw,
            onChange: function (e) { setPw(e.target.value); },
          }),
          h('button', {
            type: 'button', className: 'ms-btn', disabled: busy || pw.length < 6,
            onClick: function () { submit(pw); },
          }, enabled ? '修改密码' : '启用密码'),
        ),
        enabled
          ? h('button', {
              type: 'button', className: 'ms-btn', disabled: busy,
              onClick: function () { if (window.confirm('确定关闭密码？之后扫码即可打开。')) submit(''); },
            }, '关闭密码')
          : null,
        msg ? h('p', { className: 'ms-msg', 'data-kind': bad ? 'err' : 'ok' }, msg) : null,
      );
    }

    // 复制地址：局域网 http 不是安全上下文，navigator.clipboard 不可用，
    // 用传统 execCommand 兜底；都失败就保持原样，用户手动长按选择。
    function copyText(text, done) {
      function legacy() {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          done(!!ok);
        } catch (e) { done(false); }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { legacy(); });
        } else { legacy(); }
      } catch (e) { legacy(); }
    }

    function ScanPage(props) {
      const embedded = !!(props && props.embedded);
      const [state, setState] = React.useState({ status: 'loading', url: null, qr: null, ip: null, ticket: false, gateway: null });
      const [tick, setTick] = React.useState(0);
      const [copied, setCopied] = React.useState(false);
      // 密码开关的镜像：只用来判断「开了密码但二维码里没票据」这种坏状态。
      // 由 AuthPanel 上报，不自己再发一遍请求。
      const [authOn, setAuthOn] = React.useState(null);

      // 面板重新可见时重取一次地址：可能在别处（另一个窗口/直接改配置）动过密码，
      // 屏幕上那张码就成了旧码。重取比"猜"便宜。
      React.useEffect(function () {
        function onVisible() {
          if (document.visibilityState === 'visible') setTick(function (t) { return t + 1; });
        }
        document.addEventListener('visibilitychange', onVisible);
        return function () { document.removeEventListener('visibilitychange', onVisible); };
      }, []);

      React.useEffect(function () {
        let alive = true;
        setState(function (s) { return { ...s, status: 'loading' }; });

        fetch('/api/mobile-studio/lan-url', { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!alive) return;
            const gw = d && d.gateway ? d.gateway : null;
            if (d && d.ok && d.url) {
              // 二维码用宿主给的 qr（带登录票据）；旧宿主没有 qr 字段时退回干净地址。
              setState({ status: 'ok', url: d.url, qr: qrSvg(d.qr || d.url), ip: d.ip, ticket: !!d.qr && d.qr !== d.url, gateway: gw });
            } else if (d && d.ok && gw && !gw.listening) {
              // 端口全被占用：不能展示一个连不上的假二维码
              setState({ status: 'gateway-error', url: null, qr: null, ip: d.ip, ticket: false, gateway: gw });
            } else {
              setState({ status: 'no-lan', url: null, qr: null, ip: null, ticket: false, gateway: gw });
            }
          })
          .catch(function () {
            if (!alive) return;
            setState({ status: 'error', url: null, qr: null, ip: null, ticket: false, gateway: null });
          });

        return function () { alive = false; };
      }, [tick]);

      // 桌面 Electron（dsh-app://）也能用：地址由宿主侧的网关给出，
      // 与当前页面的协议无关。
      const qr = state.qr;
      const url = state.url;

      function copyUrl() {
        if (!url) return;
        copyText(url, function (ok) {
          if (!ok) return;
          setCopied(true);
          // 只是按钮文案翻转，2 秒后复原，不碰任何前置状态
          setTimeout(function () { setCopied(false); }, 2000);
        });
      }

      return h('div', { className: 'ms-scan' + (embedded ? ' ms-scan--settings' : '') },
        h('style', { dangerouslySetInnerHTML: { __html: QR_CSS } }),
        h('h2', { className: 'ms-scan-h' }, '手机扫码访问'),
        h('p', { className: 'ms-scan-sub' }, '使用手机 App 扫描下方二维码进入移动端界面，亦可手动输入地址。桌面端界面不受影响。'),

        state.status === 'ok' && state.gateway
          ? h('p', { className: 'ms-cfg-sub' },
              '网关运行中 · 端口 ' + state.gateway.port)
          : null,

        state.status === 'ok' && state.gateway && state.gateway.fallback
          ? h('p', { className: 'ms-warn' },
              '端口 ' + state.gateway.preferredPort + ' 被其他程序占用，网关已自动改用 '
              + state.gateway.port + '。手机请扫描下方二维码重新连接。')
          : null,

        state.status === 'gateway-error'
          ? h('div', { className: 'ms-qr ms-qr-fail' },
              '端口 ' + (state.gateway.triedPorts && state.gateway.triedPorts.length
                ? state.gateway.triedPorts.join('、') : state.gateway.preferredPort)
              + ' 均被占用，无法启动网关。请关闭占用这些端口的程序后重启 DSH。')
          : null,

        state.status === 'gateway-error'
          ? h('p', { className: 'ms-warn' },
              '手机端此时无法连接；这是电脑侧端口冲突，不需要在手机上改配置。')
          : null,

        state.status === 'loading'
          ? h('div', { className: 'ms-qr ms-qr-fail' }, '正在获取局域网地址…')
          : null,

        state.status === 'no-lan'
          ? h('div', { className: 'ms-qr ms-qr-fail' }, '未找到局域网地址，请确认电脑已连接 WiFi 或网线')
          : null,

        state.status === 'error'
          ? h('div', { className: 'ms-qr ms-qr-fail' }, '无法连接宿主，网关可能未启动')
          : null,

        state.status === 'ok' && qr && url
          ? h('svg', {
              className: 'ms-qr', viewBox: '0 0 ' + qr.modules + ' ' + qr.modules,
              shapeRendering: 'crispEdges', 'aria-label': '二维码',
            }, h('path', { d: qr.path, fill: '#000' }))
          : null,

        // 坏状态自检：密码开着，但宿主给的 qr 和干净地址完全一样 → 这张码里没有票据。
        // 原因只可能是「码是开密码之前取的」（旧宿主/面板没刷新）。必须说出来，
        // 否则用户扫完落到登录页，会以为扫码功能坏了。
        state.status === 'ok' && authOn === true && !state.ticket
          ? h('p', { className: 'ms-warn ms-warn-bad' },
              '当前二维码不含登录票据（通常由设置密码前生成）。请点击下方「刷新」重新获取，否则手机端扫码后将要求输入密码。')
          : null,

        url
          ? h('div', { className: 'ms-url' },
              h('span', { className: 'ms-url-text' }, url),
              h('button', {
                type: 'button',
                className: 'ms-copy',
                'aria-label': '复制地址',
                onClick: copyUrl,
              }, copied ? '已复制' : '复制'))
          : null,

        state.status === 'ok'
          ? h('ol', { className: 'ms-steps' },
              h('li', null, h('b', null, '1'), h('span', null, '手机与电脑处于同一局域网')),
              h('li', null, h('b', null, '2'), h('span', null, '在手机 App 中扫描上方二维码（支持相机与相册）')),
              h('li', null, h('b', null, '3'), h('span', null, '扫码后直接进入，无需输入访问密码')),
            )
          : null,

        // 二维码里是一张登录票据（不是明文密码）：扫到即登录，改密码后旧码作废，
        // DSH 重启 secret 不变，所以码长期有效。
        state.status === 'ok'
          ? h('p', { className: 'ms-warn' },
              state.ticket
                ? '二维码含登录票据，持有即可登录，请勿外传；修改密码后原码失效，重启 DSH 无需重新扫码。'
                : '此地址长期有效，重启 DSH 后无需重新扫码。同一局域网内的设备均可访问。')
          : null,

        state.status !== 'loading'
          ? h('p', { className: 'ms-refresh' },
              h('button', { className: 'ms-refresh-btn', onClick: function () { setTick(function (t) { return t + 1; }); } }, '刷新'))
          : null,

        h(AuthPanel, {
          // 只同步开关状态（打开面板时就知道密码开着，坏码提示才出得来）
          onState: function (enabled) { setAuthOn(!!enabled); },
          onChanged: function (enabled) {
            setAuthOn(!!enabled);
            // 密码一改，旧码立即作废：必须重取 qr，否则屏幕上留着一张扫了没用的码
            setTick(function (t) { return t + 1; });
          },
        }),
        h(PolicyPanel, null),
      );
    }

    // ---------------- ErrorBoundary ----------------
    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        if (this.state.error) {
          return h('div', {
            style: {
              fontSize: '10.5px', color: '#B4362F', padding: '6px 9px',
              lineHeight: 1.45, wordBreak: 'break-word',
            },
          }, (this.props.label || '新建任务按钮') + '异常: ' + String(this.state.error && this.state.error.message || this.state.error));
        }
        return this.props.children;
      }
    }

    function SafeButton(props) {
      return h(Boundary, null, h(QuickTaskButton, props));
    }

    function SafeFab() {
      return h(Boundary, null, h(SidebarFab));
    }

    // 模块加载时就尝试一次（早于 apply，尽量赶在布局首次渲染前）
    syncZeroWidthRail();

    return {
      inject: ['slots', 'uiWorkspace', 'workspaces', 'connection', 'layout'],
      apply(ctx) {
        // ============================================================
        // 入口守卫：非移动端直接整体退出，一行都不注册。
        //
        // 为什么要放在这里，而不是每个组件里各自判断：
        //   之前是组件内部写 `if (!isMobile) return null`，看起来安全，
        //   但只要有任意一处漏了守卫（syncZeroWidthRail 就是），
        //   就会在桌面端产生副作用——那次把 Electron 的
        //   data-windows-titlebar 删掉，直接弄坏了桌面标题栏。
        //   放在入口处判断，桌面端连 slot 都不会注册，
        //   从结构上不可能污染桌面端。
        //
        // ============================================================
        // 扫码打开：**放进官方设置页**（Ctrl+Alt+,）
        //
        // 原来注册在 sidebar.panellist，会占侧栏一格；用户要求挪进设置里。
        // settings.section 是官方设置对话框暴露的 list 槽，general/models/plugins
        // 都挂在这里；内容直接渲染在设置面板，不再需要 main 页面。
        // 放在移动端守卫之前：桌面端才是扫码的主场。
        // ============================================================
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'mobile-studio-scan',
            order: 12,
            label: function () { return '移动端访问'; },
          }, function MobileStudioScanSection() {
            return h(Boundary, { label: '扫码设置' }, h(ScanPage, { embedded: true }));
          });
        });

        // ============================================================
        // ② 移动端专属 UI：**只有移动端注册**
        //
        // 为什么在这里判断，而不是每个组件里各自判断：
        //   之前是组件内部写 `if (!isMobile) return null`，看起来安全，
        //   但只要有任意一处漏了守卫（syncZeroWidthRail 就是），
        //   就会在桌面端产生副作用——那次把 Electron 的
        //   data-windows-titlebar 删掉，直接弄坏了桌面标题栏。
        //   放在这里判断，桌面端连这些 slot 都不会注册，
        //   从结构上不可能污染桌面端。
        //
        // 注意：这是**运行期**隔离（同一进程），不是进程级隔离。
        //   选它是因为产品定位是「手机远程控制电脑上正在跑的 DSH」，
        //   实时同屏要求两端连同一个进程，拆进程做不到。
        // ============================================================
        if (!isMobileNow()) return;

        QuickTaskButton._ctx = ctx;
        SidebarFab._ctx = ctx;

        // ---- 给网页层（mobile.js）用的导航桥 ----
        //
        // 为什么要这层：通知深链和「从工具页返回」都要"切到指定会话"。
        // 0.9.2 的做法是开抽屉、按 data-row-key 找到行、点标题 —— 深链时左栏会闪一下，
        // 用户直接说"太丑陋了"。而插件层拿得到 ctx，官方本来就提供了编程式导航：
        //   dsh-better-sidebar 源码里就是 ctx.get('uiWorkspace').openSession(target)
        // 所以这里把那条正经 API 暴露给页面，页面只负责读 id 和回读结果。
        // 仍然保留"返回 false 就走 DOM 兜底"的契约：桥失效时页面自己退回点击路径。
        try {
          window.__msHostOpenSession = function (id) {
            const target = String(id || '').trim();
            if (!target) return false;
            const faces = [];
            // 新命名（ctx.get(服务名)）与旧命名（属性直取）两种都试：DSH 换代时名字变过。
            try {
              if (ctx && typeof ctx.get === 'function') faces.push(ctx.get('uiWorkspace'));
            } catch { /* noop */ }
            faces.push(ctx && ctx.uiWorkspace);
            for (const face of faces) {
              if (!face) continue;
              const call = (arg) => {
                try {
                  face.openSession(arg);
                  return true;
                } catch {
                  return false;
                }
              };
              if (typeof face.openSession === 'function') {
                // 裸 id 与 address 对象两种入参形态都试一遍
                if (call(target)) return true;
                if (call({ sessionId: target })) return true;
              }
            }
            // 最后试 sessions 服务的旧名字（open / select / switch）
            let sess = null;
            try {
              if (ctx && typeof ctx.get === 'function') sess = ctx.get('sessions');
            } catch { /* noop */ }
            sess = sess || (ctx && ctx.sessions);
            if (sess) {
              for (const k of ['open', 'select', 'switch']) {
                try {
                  if (typeof sess[k] === 'function') {
                    sess[k](target);
                    return true;
                  }
                } catch { /* 继续试 */ }
              }
            }
            return false;
          };
        } catch { /* 桥挂了也不影响插件本体，页面会自己退回 DOM 路径 */ }

        // 移动端：把收起宽度从 56px 改成真正的 0px
        syncZeroWidthRail();

        // 视口变化时同步（横竖屏、窗口缩放）。
        // URL 参数是同步判定，但用户可能中途改窗口大小，仍需要监听。
        try {
          const mq = window.matchMedia(MOBILE_QUERY);
          const onChange = function () {
            // 从移动端宽度变宽（但用户可能仍带 ?mobile=1）时也要跟随
            syncZeroWidthRail();
          };
          if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
          else mq.addListener(onChange);
        } catch { /* noop */ }

        // 移动端：默认隐藏侧栏
        // 稍等应用挂载完成再收起
        setTimeout(function () {
          try {
            const sb = document.querySelector('[class*="sidebarCol"]');
            const w = sb ? sb.getBoundingClientRect().width : 0;
            if (w > 60) ctx.layout.toggleSidebar();
          } catch { /* noop */ }
        }, 600);

        // 悬浮按钮
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'mobile-studio-fab',
            order: 0,
          }, SafeFab);
        });

        // 新建任务的命名弹层：必须挂 App 级浮层。
        // 挂在侧栏按钮自己的树里会被侧栏的 transform 关成包含块 —— 实测 fixed 层被限到
        // x=-280（屏幕上根本看不见）。这里 order 比悬浮球大，保证盖在它上面。
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'mobile-studio-task-dialog',
            order: 20,
          }, TaskDialog);
        });

        // 侧栏底部的新建任务按钮
        ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'quick-task',
            order: 10,
            label: zh.btn,
          }, SafeButton);
        });
      },
    };
  },
});
