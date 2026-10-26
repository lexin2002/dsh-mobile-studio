/*
 * 手机端逻辑。
 *
 * 原则：能借官方状态的，就不自己造。
 *
 * 官方布局（dsh-client-ui-layout）在窄屏（viewport < 1024）下：
 *   点 toggleSidebar → narrowExpanded = true → 侧栏以浮层展开盖住内容
 * 这正是手机抽屉要的行为。
 *
 * 顶部开关直接用**官方的**（折叠侧栏顶部那个图标按钮），
 * 不再造第二个 —— 造过一版自造按钮，和官方按钮叠在同一个位置，
 * 用户看到的就是"左上角错位"。
 *
 * 本文件只负责：
 *   1. data-ms-mobile / data-ms-drawer 两个标记
 *   2. 遮罩（点空白关抽屉）
 *   3. 状态判定读官方 SidebarRoot 的 collapsed 类，不读宽度
 *      （宽度会被我们自己的 CSS 压成 0，读宽度会形成死循环）
 *   4. 键盘高度写入 --ms-vvh、边缘滑动手势
 */

(() => {
  const root = document.documentElement;
  root.setAttribute('data-ms-mobile', '');

  /*
   * 拆掉官方的「Windows 无边框标题栏」模式。
   *
   * 宿主是 Windows 时官方客户端会往 <html> 写 data-windows-titlebar（实测
   * t≈2.1s，比这一层晚 0.8s），它带两条只对桌面窗口成立的规则
   * （browser-harness probe-container-rules / probe-titlebar-attr 实测）：
   *
   *   1) [data-windows-titlebar] .BynINW_frame { padding-top: var(--dsh-windows-titlebar-height) }
   *      实测 48px —— 整页连同首栏一起被推下去 48px，顶上留一条空白。
   *      属性是**晚到**的，所以现象是「先正常，过一会首栏突然挪到下方」，
   *      刷新或属性被摘掉又恢复（用户报的"挪到下方、位置空了、过一会恢复"）。
   *
   *   2) [data-windows-titlebar] .BynINW_frame[data-sidebar-collapsed="true"]:has(_crumbCurrent)
   *        [class*="_titleRow"] { padding-left: 84px !important }
   *      侧栏状态一定下来就命中，会话标题往右跳 84px；侧栏一动又跳回来
   *      （用户报的"标题莫名其妙的居中"）。它是 !important，CSS 压不住。
   *
   * 手机上既没有 Windows 标题栏，左上角也是我们自己的 36px 汉堡键，
   * 这两条都不成立 —— 整个模式摘掉，左边距由 CSS 统一给 32px。
   * 官方可能再写回来，所以盯着 <html> 的属性，出现就摘。
   */
  const dropTitlebar = () => {
    if (root.hasAttribute('data-windows-titlebar')) root.removeAttribute('data-windows-titlebar');
  };
  dropTitlebar();
  try {
    new MutationObserver(dropTitlebar).observe(root, {
      attributes: true,
      attributeFilter: ['data-windows-titlebar'],
    });
  } catch {
    /* 观察器挂不上也不能影响页面 */
  }

  // 版本标记：每次改完这里同步更新。真机出问题先对这个号，
  // 免得拿着旧包的现象查新代码（之前已经吃过这个亏）。
  window.__msVersion = '2026-10-27/r14';

  // ---- document 级点击分发 ----
  //
  // 以前散落着 7 个 document.addEventListener('click', …)，从第 180 行到第 1260 行，
  // 谁的捕获阶段先跑、谁被 stopPropagation 短路，只能靠读代码还原。
  // 现在统一注册到两个数组：捕获一个、冒泡一个，顺序 = 注册顺序（和以前完全一致）。
  // 语义等价：某个处理器调了 stopPropagation（内容区吞点击），后面的不再执行；
  // 某个处理器抛错，也只影响它自己（以前是独立监听，天然隔离）。
  const clickCapture = [];
  const clickBubble = [];
  const onClickCapture = (name, fn) => clickCapture.push({ name, fn });
  const onClickBubble = (name, fn) => clickBubble.push({ name, fn });
  // 处理器出错不吞掉也不刷屏：收进一个可查的数组，排查时读 window.__msErrors
  window.__msErrors = [];
  const runClick = (list) => (e) => {
    for (const h of list) {
      if (e.cancelBubble) return;
      try {
        h.fn(e);
      } catch (err) {
        window.__msErrors.push(`${h.name}: ${String((err && err.message) || err)}`);
      }
    }
  };
  document.addEventListener('click', runClick(clickCapture), true);
  document.addEventListener('click', runClick(clickBubble), false);

  // 让浏览器在键盘弹起时**把布局视口一起缩小**（Chrome 108+ 支持）。
  // 这样官方那条 height:100% 的链自己就变矮，输入框天然贴在键盘上方，
  // 根本不需要我们算补偿 —— 之前那块空白就是「浏览器已经处理了 + 我们又补了一次」。
  // 不支持的浏览器会忽略这个字段，下面按差额补偿的逻辑照常兜底。
  try {
    const meta = document.querySelector('meta[name="viewport"]');
    const content = meta?.getAttribute('content') || '';
    if (meta && content !== '' && !/interactive-widget/.test(content)) {
      meta.setAttribute('content', content.replace(/\s*,\s*$/, '') + ', interactive-widget=resizes-content');
    }
  } catch {
    /* 拿不到 meta 就跳过，不影响其它逻辑 */
  }

  /** 官方侧栏根节点（带 collapsed 类）。 */
  function sidebarRoot() {
    return document.querySelector('[class*="sidebarCol"] [class*="root"]');
  }

  /**
   * 侧栏是否展开。
   * 直接读官方 SidebarRoot 的类名 —— 这是唯一可靠的状态源，
   * 宽度会被移动端 CSS 人为改掉。
   */
  function sidebarExpanded() {
    const el = sidebarRoot();
    if (!el) return false;
    return !String(el.className).includes('collapsed');
  }

  /*
   * 抽屉「该不该开着」由用户的动作决定，不再跟随官方状态。
   *
   * 之前的毛病：官方在切页面时会自己把侧栏翻回展开（建会话、从插件/自动化/上下文
   * 这类面板页回会话都会），sync() 忠实地跟着写 open —— 用户没点开关，抽屉自己弹出来。
   * 加个 1.4 秒的时间窗只是把这事往后推，切页慢一点就又漏了。
   *
   * 现在只有点开关 / 右滑 / 点遮罩会改 desiredOpen；官方自己展开一律不跟，
   * 官方一收起就把意图清掉（防上一次的残留）。
   */
  let desiredOpen = false;
  let openIntentAt = 0;

  /*
   * 关抽屉只有一种写法：意图置否 + 属性写死关闭，不碰官方开关。
   * 别用裸 toggle() 翻转来“收”——官方侧栏经常处在“展开但被 CSS 藏起”的状态，
   * 翻转会先把它翻出来再收回去，用户看到的就是左栏闪一下（真机实测）。
   */
  function closeDrawerState(from) {
    try { reportDiag('drawer-close', { from: from || 'unknown', act: (document.activeElement && document.activeElement.tagName) || '' }); } catch { /* noop */ }
    desiredOpen = false;
    if (root.getAttribute('data-ms-drawer') !== 'closed') root.setAttribute('data-ms-drawer', 'closed');
  }

  const ui = {
    scrim: null,

    sync() {
      const expanded = sidebarExpanded();
      // 抽屉开合**只认用户意图**（开关 / 遮罩 / 右滑 / 导航 / 返回键）。
      //
      // 这里以前是「官方收起了 → 意图作废」，等于把官方那次塌陷当成用户要关：
      // 归档会话、置顶、点行内的「更多」、打开浮层，官方侧栏都会短暂收一下，
      // 于是用户点的是行内图标，抽屉却跟着关了。0.9.0 的点击判定改了三版都没用，
      // 就是因为真凶在这（walker 实测栈：行内按钮 → sync:153）。
      const flag = desiredOpen ? 'open' : 'closed';
      // 只写这一个属性。以前这里还会锁 body.overflow —— 那会让整个文档
      // 重新布局一次，长会话里就是明显的卡顿和白闪，已去掉。
      if (root.getAttribute('data-ms-drawer') !== flag) root.setAttribute('data-ms-drawer', flag);
      // 抽屉开着但官方塌了：把官方补展开（晚 260ms 再看一次，躲开重排的瞬间），
      // 否则抽屉里会空一片。补展开不闪屏：CSS 只认 data-ms-drawer。
      if (desiredOpen && !expanded) this.keepOfficialOpen();
      // 抽屉状态一变就顺手确认一次收纳（新面板行是官方/插件随时加的）
      syncTools();
    },

    keepOfficialOpen() {
      clearTimeout(this._reopenTimer);
      this._reopenTimer = setTimeout(() => {
        if (!desiredOpen || sidebarExpanded()) return;
        const btn = document.querySelector('[class*="_sidebarCol"] button[class*="_toggle"]');
        if (!btn) return;
        try {
          btn.click();
        } catch {
          /* noop */
        }
        setTimeout(() => this.sync(), 320);
      }, 260);
    },

    /** next 省略时按当前视觉状态翻转；传 true/false 表示明确的意图。
     * 官方开关是翻转语义（点一下换一面），所以点之前先看官方是不是已经在目标状态：
     * 已经是了就只写意图、不同步点它，多点一下反而会翻到反面去。 */
    toggle(next) {
      const want = typeof next === 'boolean' ? next : root.getAttribute('data-ms-drawer') !== 'open';
      desiredOpen = want;
      if (want) openIntentAt = Date.now();
      if (want === sidebarExpanded()) {
        this.sync();
        return;
      }

      // 官方按钮在 1px 容器里被 CSS 定位到左上角。
      // .click() 是合成事件，React 19 有时不认；补发真实 pointer 序列
      // （pointerdown→pointerup→click）确保命中。
      const btn = document.querySelector('[class*="sidebarCol"] button[class*="toggle"]');
      if (!btn) return;

      const fire = (type) =>
        btn.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, view: window, pointerId: 1, isPrimary: true }),
        );
      try {
        fire('pointerdown');
        fire('pointerup');
      } catch {
        /* PointerEvent 不可用时退回 click */
      }
      btn.click();
      // 官方状态在下一帧更新，稍等再同步
      setTimeout(() => this.sync(), 280);
      setTimeout(() => this.sync(), 700);
    },

    mount() {
      if (document.querySelector('.ms-scrim')) return;

      const scrim = document.createElement('div');
      scrim.className = 'ms-scrim';
      scrim.setAttribute('aria-hidden', 'true');
      scrim.addEventListener('click', () => {
        if (sidebarExpanded()) this.toggle(false);
      });
      document.body.append(scrim);
      this.scrim = scrim;

      // 面板收起时整体滑到屏幕外，官方那个开关也跟着走了，
      // 所以在原位放一个自己的开关（样式与官方一致，展开后淡出）。
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'ms-toggle';
      openBtn.setAttribute('aria-label', '打开侧边栏');
      openBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
      openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 意图就是打开：toggle(true) 在官方已展开时会跳过点击只写状态，
        // 所以即使官方处在“展开但被藏起”的残留态，汉堡键也不会变砖。
        ui.toggle(true);
      });
      document.body.append(openBtn);

      // 官方因窗口变化自己改状态时，跟着同步。
      // sidebarRoot 可能在 mobile.js 执行时还没渲染出来（React 异步挂载），
      // 所以不能只在 mount 时找一次：先轮询等它出现，出现后再挂 class 观察；
      // 同时用 document 级委托兜底——任何时刻点到官方开关都强制同步一次。
      const attachObserver = () => {
        const el = sidebarRoot();
        if (!el) return false;
        if (el.__msObserved) return true;
        el.__msObserved = true;
        if (typeof MutationObserver === 'function') {
          const mo = new MutationObserver(() => ui.sync());
          mo.observe(el, { attributes: true, attributeFilter: ['class'] });
        }
        ui.sync();
        return true;
      };
      if (!attachObserver()) {
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          if (attachObserver() || tries > 40) clearInterval(timer);
        }, 500);
      }

      // 兜底：任何对官方开关的点击（真实触摸/鼠标），都强制同步一次。
      // 不依赖上面的 observer 是否挂上。
      onClickBubble('drawer-toggle-sync', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('[class*="sidebarCol"] button[class*="toggle"]')) {
          setTimeout(() => ui.sync(), 280);
          setTimeout(() => ui.sync(), 700);
          setTimeout(() => seatGear(), 750);
          return;
        }
        // 点右栏开关时先收起左抽屉，避免两层叠加（显式关，不翻转）
        const rb = t.closest('button[aria-label*="右侧边栏"], button[title*="右侧边栏"]');
        if (rb && sidebarExpanded()) {
          ui.toggle(false);
        }
      });

      /*
       * 点侧栏里的东西，什么时候收起抽屉？
       *
       * 只有「导航」才收：选会话、新建会话、开插件/自动化/上下文面板、新建任务。
       *
       * 以前写的是「点侧栏里任何按钮都收」，后果是账号菜单按下去，抽屉立刻收，
       * 而它的二级菜单是挂在触发器上的浮层，触发器跟着抽屉一起走了 —— 菜单打不开。
       * 实测时间线：点 → 浮层 97ms 出现 → 150ms 我们把它收了 → 405ms 抽屉滑走。
       *
       * 所以：带 aria-haspopup 的（菜单、弹层触发器）一律不收。
       */
      const NAV_ITEM =
        '[class*="sessionRow"], [class*="panelRow"], [class*="newSession"], ' +
        'button[aria-label="新建会话"], button[aria-label="新建任务"], [data-ms-newtask]';

      onClickCapture('nav-close-drawer', (e) => {
        if (!sidebarExpanded()) return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('[class*="toggle"]')) return;
        // 会弹浮层的控件（账号菜单等）不能收抽屉，否则浮层跟着触发器一起消失
        if (t.closest('[aria-haspopup]')) return;
        const col = document.querySelector('[class*="sidebarCol"]');
        if (!col || !col.contains(t)) return;
        const row = t.closest(NAV_ITEM);
        if (!row) return;
        // 行内小按钮（更多/归档/置顶、搜索/筛选、添加工作区…）只是干活，不是导航。
        //
        // 判据两条，都不认哈希前缀、不认中文文案：
        //   1) 落在「行尾操作区」（官方 DOM 里是 *_[rowActions] 容器）→ 不关；
        //   2) 更窄的可点控件（< 行宽 55%）→ 不关。行本体几乎与行同宽。
        // 实测坑：这些图标按钮在抽屉里量到 0×0（悬停才显形），
        // 所以行宽量不到时要给个兜底宽度，否则 0 < 0 恒假，判定直接失效。
        if (t.closest('[class*="_rowActions"]')) { ui.keepOfficialOpen(); return; }
        const btn = t.closest('button, [role="button"]');
        if (btn && btn !== row) {
          const bb = btn.getBoundingClientRect();
          const rb = row.getBoundingClientRect();
          const rowW = rb.width > 0 ? rb.width : 260;
          if (bb.width < rowW * 0.55) { ui.keepOfficialOpen(); return; }
        }
        // 新建会话是唯一希望自动弹输入法的地方（见下面 allowAutoFocusUntil）
        if (t.closest('button[aria-label="新建会话"], button[aria-label="新建任务"], [class*="newSession"]')) {
          allowAutoFocusUntil = Date.now() + 4000;
        }
        closeDrawer();
      });

      /*
       * 浮层触发器「再点一次收起」——对所有官方浮层通用。
       *
       * 官方只认「点浮层外面」关（pointerdown；mousedown / click 都无效），点触发器
       * 自己不算外面 —— 第二次点它：先被关掉，紧接着那一次 click 又被当成「打开」，
       * 净效果是「点了没反应」。实测两个浮层都是这个毛病：
       *   「3 个子智能体」oXE0lW_trigger（haspopup=tree）连点 4 次都不收；
       *   「智能体团队」 EBLgjq_trigger（haspopup=dialog）同样。
       * 上一版只认了 EBLgjq 那一个，所以用户点的是另一个时一条日志都没有 ——
       * 教训：认「行为」不认「具体组件」。
       *
       * 判据全是官方自己的显式状态，同步可读，不猜时间也不猜坐标：
       *   1) 触发器带 aria-expanded="true"  → 它声明「我展开着」；
       *   2) 带 aria-haspopup               → 它管着一张浮层；
       *   3) 同前缀（oXE0lW_trigger ↔ oXE0lW_menu / EBLgjq_trigger ↔ EBLgjq_panel）
       *      的可见元素存在                 → 那张浮层确实画出来了。
       * 三个都成立，就说明「这一下是收」。
       *
       * 时机：window 捕获的 pointerdown（比 document、也比 React 的根容器都早），
       * 把这一下拿走并补一发「点外面」；同时把这次手势剩下的 pointerup / touchend /
       * click 一并吃掉 —— 一次手势只允许有一个归属，不给官方「关了又开」的机会。
       * 归属跟着手势走：新手势一开始就作废，不设时间窗（设过，会连坐下一次点击）。
       */
      const popoverFor = (trig) => {
        try {
          const first = String(trig.className || '').split(/\s+/)[0];
          const prefix = first.split('_')[0];
          if (!prefix) return null;
          for (const el of document.querySelectorAll('[class*="' + prefix + '_"]')) {
            if (el === trig || trig.contains(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 40 && r.height > 20) {
              return { prefix, cls: String(el.className || '').slice(0, 40) };
            }
          }
        } catch {
          /* noop */
        }
        return null;
      };

      let popSwallowTrigger = null;
      const popSwallow = (e) => {
        if (e.isTrusted === false) return;
        if (!popSwallowTrigger) return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (t === popSwallowTrigger || popSwallowTrigger.contains(t)) {
          e.stopPropagation();
          e.preventDefault();
          // 一次手势只有一次归属：这一下的 click 已经吃掉了，归属立刻作废，
          // 否则用户手快再点一下，会被上一次的「吃」连坐（实测过：连点第三下打不开）。
          if (e.type === 'click') popSwallowTrigger = null;
        }
      };
      for (const type of ['pointerup', 'touchend', 'click', 'mouseup']) {
        window.addEventListener(type, popSwallow, true);
      }

      window.addEventListener('pointerdown', (e) => {
        // 只认真正的用户输入：我们自己合成的「点外面」也会到这里（target=body），
        // 不挡住就会自己调自己，直接把栈打爆。
        if (e.isTrusted === false) return;
        // 新手势开始，上一次的归属一律作废 —— 归属跟着手势走，不跟着时间走。
        popSwallowTrigger = null;
        const t = e.target;
        if (!t || !t.closest) return;
        const trig = t.closest('[aria-expanded="true"][aria-haspopup]');
        if (!trig) return;
        const pop = popoverFor(trig);
        if (!pop) return;

        popSwallowTrigger = trig;
        e.stopPropagation();
        e.preventDefault();
        reportDiag('pop-close', { tg: pathOf(t), tr: pathOf(trig), bx: pop.cls });
        // 官方认「点外面」关，但**不同组件听的事件不一样**（实测 probe-pop-mech）：
        //   子智能体 oXE0lW / 智能体团队 EBLgjq 听 pointerdown；
        //   用量药丸 mAjYhq、模型菜单 wq12jW 听 mousedown。
        // 只补 pointerdown 时后两者纹丝不动 —— 用户看到的就是「第二次点不收回」。
        // 一发里两种都补（各自 try 包裹），谁听都接得住，多补一种对前者是无害的。
        const synth = (Ctor, type, extra) => {
          try {
            document.body.dispatchEvent(
              new Ctor(type, Object.assign({
                bubbles: true, cancelable: true, view: window, clientX: 4, clientY: 4,
              }, extra || {})),
            );
          } catch {
            /* 单个事件合成失败不影响另一种 */
          }
        };
        const Ptr = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        synth(Ptr, 'pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true });
        synth(MouseEvent, 'mousedown', { button: 0, buttons: 1 });
        // 取证：浮层到底关掉没有、有没有又开回来
        const seen = [];
        for (const d of [120, 400, 800]) {
          setTimeout(() => {
            seen.push(trig.getAttribute('aria-expanded') === 'true' ? '1' : '0');
            if (seen.length === 3) reportDiag('pop-state', { s: seen.join('') });
          }, d);
        }
      }, true);

      /*
       * 收起抽屉：只管一次，不做「反复纠正」。
       *
       * 上一版写成了重试循环（官方还是展开的就再点，最多三轮），结果一次点击
       * 变成「关 → 开 → 关」三连，用户看到抽屉来回抽。
       *
       * 现在：立刻写关闭 + 表明「我想关」，650ms 后如果官方还开着就点一次让它也收。
       * 之后官方再怎么自己展开都不跟 —— sync() 只认 desiredOpen。
       */
      function closeDrawer() {
        desiredOpen = false;
        root.setAttribute('data-ms-drawer', 'closed');
        setTimeout(() => {
          // 期间用户又打开了：什么都别碰（之前这里无条件点官方开关，
          // 会把用户刚打开的抽屉再关回去）
          if (desiredOpen) return;
          if (sidebarExpanded()) ui.toggle(false);
          if (!desiredOpen) root.setAttribute('data-ms-drawer', 'closed');
        }, 650);
      }

      this.sync();
    },
  };

  ui.mount();

  /* ---- 抽屉里的「工具」收纳 ----
   *
   * 官方在抽屉里把「插件 / 自动化任务 / 上下文洞察 / 技能中枢 / …」一个页面一行
   * 平铺出来（实测 4 行 36px + 间距 = 156px，工作区被压到 y=284）。官方或插件每
   * 加一个面板，它自己就长高一行 —— 我们完全被动，而"以后说不定还要增加"。
   *
   * 做法：把这些行收进一个折叠组。
   *   收起：一行「工具 ⑤ ›」 36px（比现在省 120px，且高度与数量无关）
   *   展开：就地两列网格，超出组内滚动
   *
   * 泛用性来自两处：
   *   1) 认容器不认名字 —— 侧栏里那个「一行一个页面入口」的导航（子元素全是带
   *      aria-label 的按钮）就是收纳对象。以后新增什么面板都自动进来，零改动。
   *   2) 点击是**替点官方那一行**，功能、路由、抽屉收起全走官方原路，我们只是
   *      换了个壳。所以不需要知道每一行是干什么的。
   */
  const tools = { el: null, row: null, grid: null, btns: null, sig: '', open: false };

  function toolsNav() {
    const col = document.querySelector('[class*="sidebarCol"]');
    if (!col) return null;
    for (const nav of col.querySelectorAll('nav')) {
      const rows = [...nav.children].filter((c) => c.tagName === 'BUTTON');
      // 一行一个页面入口：全是按钮，且每个都带 aria-label（官方面板行就是这样）
      if (rows.length > 0 && rows.every((b) => (b.getAttribute('aria-label') || '') !== '')) return nav;
    }
    return null;
  }

  function setToolsOpen(on) {
    tools.open = !!on;
    if (!tools.el) return;
    root.setAttribute('data-ms-tools', tools.open ? '1' : '0');
    if (tools.row) tools.row.setAttribute('aria-expanded', tools.open ? 'true' : 'false');
  }

  function buildTools(nav, rows) {
    if (!tools.el) {
      const el = document.createElement('div');
      el.className = 'ms-tools';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ms-tools-row';
      row.setAttribute('aria-label', '工具');
      row.innerHTML =
        '<span class="ms-tools-label">工具</span><span class="ms-tools-count"></span>' +
        '<svg class="ms-tools-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 6.5L8 9l2.5-2.5"/></svg>';
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setToolsOpen(!tools.open);
      });
      const grid = document.createElement('div');
      grid.className = 'ms-tools-grid';
      el.append(row, grid);
      tools.el = el;
      tools.row = row;
      tools.grid = grid;
    }

    tools.btns = rows;
    tools.grid.textContent = '';
    for (const b of rows) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'ms-tools-tile';
      const label = b.getAttribute('aria-label') || (b.innerText || '').trim();
      tile.setAttribute('aria-label', label);
      const ico = document.createElement('span');
      ico.className = 'ms-tools-ico';
      // 连官方那层图标壳一起克隆，不要只克隆 svg：图标可能是靠壳上的 CSS
      // （mask/背景）画的，单克隆 svg 会变成一个实心黑块（实测过）。
      const glyph = b.querySelector('[class*="panelGlyph"]') || b.querySelector('svg');
      if (glyph) ico.append(glyph.cloneNode(true));
      const name = document.createElement('span');
      name.className = 'ms-tools-name';
      name.textContent = label;
      tile.append(ico, name);
      tile.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 替点官方那一行：抽屉收起、路由、页面挂载全按官方原路走。
        // display:none 的按钮照样能被 .click()（这个项目里已经用过同一条路）。
        try {
          b.click();
        } catch {
          /* noop */
        }
        setToolsOpen(false);
      });
      tools.grid.append(tile);
    }
    tools.row.querySelector('.ms-tools-count').textContent = String(rows.length);

    // 放在官方导航原来的位置：导航被 CSS 藏掉（不占位），我们的行就落在同一处
    try {
      nav.after(tools.el);
      nav.setAttribute('data-ms-tools-src', '1');
    } catch {
      /* noop */
    }
    setToolsOpen(tools.open);
  }

  function syncTools() {
    try {
      const nav = toolsNav();
      if (!nav) return;
      const rows = [...nav.children].filter((c) => c.tagName === 'BUTTON');
      const sig = rows.map((b) => b.getAttribute('aria-label') || '').join('|');
      const alive = tools.el && tools.el.isConnected && tools.btns && tools.btns.every((b) => b.isConnected);
      if (alive && sig === tools.sig && tools.el.previousElementSibling === nav) return;
      tools.sig = sig;
      buildTools(nav, rows);
    } catch {
      /* 收纳失败不能影响抽屉本身 */
    }
  }

  let toolsAt = 0;
  function syncToolsThrottled() {
    const now = Date.now();
    if (now - toolsAt < 400) return;
    toolsAt = now;
    syncTools();
  }

  syncTools();

  /* ---- 泛用层：认形状，不认页面 ----
   *
   * 以前每来一个页面就写一批针对它构建哈希的规则（Dc7zOa_ / EBLgjq_ / Z9Jnlq_ …），
   * 所以「增加一个页面 = 做一次 UI」。这里换一条路：运行时给 DOM 打**角色**，
   * 样式只认角色：
   *
   *   page      页面根         —— 从面包屑「返回」按钮往上找，最大的那个容器
   *   pageHead  页头           —— 返回按钮所在的那一行
   *   listRow   列表行         —— 一组 ≥3 个同形兄弟
   *   segmented 分段控件       —— 2~5 个等宽按钮排成一行（已安装/发现、全部/已开启…）
   *   switch    开关           —— role=switch / aria-checked
   *
   * 新页面只要用标准形状（按钮、列表、卡片、输入框），**一行 CSS 都不用加**就继承
   * 同一套手机端规格。角色判断全是结构判断，不看页面名、不看插件名。
   * 只在「真正的新形状」出现时才写例外，例外集中放一处。
   */
  function markRole(el, role) {
    if (!el || el.nodeType !== 1) return;
    if (el.getAttribute('data-ms-role') === role) return;
    el.setAttribute('data-ms-role', role);
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    // 必须**在屏内**：右侧栏收起时那个 pane 仍然躺在 x=390（探针 probe-shell
    // 实测 page=section._pane_6nhg2_209@390），面积和内容列一样大，会把
    // 「页面」整个抢走 —— 页面标题、列表行全标到一块看不见的面板上。
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.left < window.innerWidth &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.bottom > 0
    );
  }

  function pageRoot() {
    // 页面根不能靠「返回按钮」认：抽屉里那几页根本没有返回键（左上角是汉堡）。
    // 用结构认，而且这条对**所有**页面都成立：
    //   内容列 = 不在侧栏里、也不包含侧栏、占大半屏的那个容器；
    //   聊天页有输入卡（composer）→ 排除；面板页 / 插件页没有 → 选中。
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let best = null;
    let bestArea = 0;
    const cands = document.querySelectorAll(
      'main, [role="main"], article, section, body > div, body > div > div, body > div > div > div, body > div > div > div > div',
    );
    for (const el of cands) {
      // 我们自己插的浮层（遮罩/汉堡/抽屉/收纳组）不是页面 ——
      // 上一版就是被 ms-scrim 抢走了「page」，结果整层角色判断变成空转。
      if (el.closest('.ms-scrim, .ms-toggle, .ms-rack, .ms-tools, .ms-stash, .ms-stash-btn')) continue;
      if (el.closest('[class*="sidebarCol"]')) continue;
      if (el.querySelector('[class*="sidebarCol"]')) continue;
      if (el.querySelector('[class*="_card"], [class*="_composerSeat"], input[type="file"]')) continue;
      // 聊天页永远不是"页面"。输入卡在的时候上一条就挡住了，但会话切换 / 首屏
      // 加载时输入卡会短暂不在 —— 那时聊天页就是面积最大的候选。实测一旦命中，
      // 整棵消息树被标成 listRow（110 个）、pageTitle 标到滚出屏幕的标题上，
      // 等输入卡回来又全清掉：用户看到的就是"首栏抽一下"。所以再认一层聊天页
      // 自己的命名空间（Dc7zOa_ 在本文件里本来就是稳定后缀用法）。
      if (el.querySelector('button[aria-label="更多操作"]')) continue;
      if (el.children.length === 0) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.6 || r.height < vh * 0.5) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  let lastPage = null;

  function classify() {
    try {
      const page = pageRoot();
      if (!page) {
        // 回到聊天页了：把上一页的标记清掉（聊天页有输入卡，永远不会被当成 page）
        if (lastPage) {
          for (const el of lastPage.querySelectorAll('[data-ms-role]')) el.removeAttribute('data-ms-role');
          lastPage.removeAttribute('data-ms-role');
          lastPage = null;
        }
        return;
      }
      // 换页了：把上一页的角色标记清掉，免得越标越多
      if (lastPage && lastPage !== page) {
        for (const el of lastPage.querySelectorAll('[data-ms-role]')) el.removeAttribute('data-ms-role');
        lastPage.removeAttribute('data-ms-role');
      }
      lastPage = page;
      markRole(page, 'page');

      // 页头：先找「页面标题」，再往上取一行高的容器。
      // 标题 = 顶部 130px 内字号最大的可见文本（允许有子节点 —— 上下文洞察的
      // 标题是 <h1><span>…</span></h1>，按「叶子文本」找就会漏掉，标题就贴在汉堡键上）。
      const title = (() => {
        let best = null;
        let bestSize = 0;
        const top = page.getBoundingClientRect().top;
        for (const el of page.querySelectorAll('h1, h2, h3, h4, span, div, button, a, p')) {
          const t = (el.textContent || '').trim();
          if (!t || t.length > 24) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 24 || r.height < 14 || r.height > 90) continue;
          if (r.top - top > 130) continue;
          // 只认页面顶部那一带：滚上去的内容（bottom 在页面顶之上）不算标题。
          // 实测聊天页里字号最大的是 y=-4821 的 h2，会被误标成 pageTitle。
          if (r.bottom < top) continue;
          const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
          if (fs > bestSize) {
            bestSize = fs;
            best = el;
          }
        }
        return bestSize >= 13 ? best : null;
      })();
      if (title) {
        markRole(title, 'pageTitle');
        for (let n = title.parentElement; n && n !== page; n = n.parentElement) {
          if (n.getBoundingClientRect().height <= 90) markRole(n, 'pageHead');
          else break;
        }
      }

      // 分段控件：一排 2~5 个等宽按钮
      for (const box of page.querySelectorAll('div, nav, ul')) {
        const kids = [...box.children].filter((c) => c.tagName === 'BUTTON' || c.getAttribute('role') === 'tab');
        if (kids.length < 2 || kids.length > 5) continue;
        const w = kids.map((k) => Math.round(k.getBoundingClientRect().width));
        const h = kids.map((k) => Math.round(k.getBoundingClientRect().height));
        if (w.some((x) => x === 0)) continue;
        if (Math.max(...w) - Math.min(...w) > 2) continue;
        if (Math.max(...h) > 44) continue;
        markRole(box, 'segmented');
      }

      // 列表行：一组 ≥3 个同形兄弟（同标签、高度接近、够宽）
      let budget = 240;
      for (const box of page.querySelectorAll('div, ul, nav, section')) {
        if (budget <= 0) break;
        const kids = [...box.children];
        if (kids.length < 3) continue;
        const tag = kids[0].tagName;
        if (!kids.every((k) => k.tagName === tag)) continue;
        const hs = kids.map((k) => Math.round(k.getBoundingClientRect().height));
        const ws = kids.map((k) => Math.round(k.getBoundingClientRect().width));
        if (hs.some((h) => h < 20 || h > 200)) continue;
        if (Math.max(...hs) - Math.min(...hs) > 6) continue;
        if (Math.min(...ws) < page.getBoundingClientRect().width * 0.5) continue;
        for (const k of kids) {
          markRole(k, 'listRow');
          budget -= 1;
        }
      }

      for (const sw of page.querySelectorAll('[role="switch"], button[aria-checked], input[type="checkbox"]')) {
        markRole(sw, 'switch');
      }
    } catch {
      /* 角色判断失败不能影响页面本身 */
    }
  }

  let classifyAt = 0;
  function classifyThrottled() {
    const now = Date.now();
    if (now - classifyAt < 400) return;
    classifyAt = now;
    classify();
  }

  classify();

  // ---- 打开抽屉的三个途径 ----
  // 1. 官方按钮（折叠侧栏顶部，CSS 已放大触摸区）
  // 2. 左缘右滑
  // 3. （打开后）任意处左滑关闭 / 点遮罩
  let sx = 0;
  let sy = 0;
  let edge = false;

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      edge = sx <= 26 && !sidebarExpanded();
    },
    { passive: true },
  );

  document.addEventListener(
    'touchend',
    (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - sx;
      const dy = Math.abs(t.clientY - sy);
      if (edge && dx > 56 && dy < 60) ui.toggle(true);
      else if (!edge && sidebarExpanded() && dx < -56 && dy < 60) ui.toggle(false);
      edge = false;
    },
    { passive: true },
  );

  // ---- 附件（拍照 / 相册 / 文件）----
  //
  // 底层不用自己写：官方 composer 里有一个隐藏的
  //   <input type="file" multiple hidden>
  // 选完文件由官方的 onChange 接管（上传、缩略图、进度、删除、重试全在官方那条链上）。
  // 我们只做两件事：
  //   1. 三格（相册/拍照/文件）由 attachRack 画在命令菜单下方
  //   2. 点哪个格，就给官方那个 input 临时设上对应属性再 click()
  //      —— 拍照加 capture，相册设 accept=image/*，文件什么都不设
  // 属性用完还原，否则以后点官方的"文件"命令也会被带进相机。
  //
  // 历史：这里曾经有一套自己画的底部面板（build/open/close + 下滑关闭），
  // 三格并进 + 菜单后就再没显示过。但 pick() 仍在调 build()，
  // 等于每点一次附件就重建一套隐藏 DOM、并重复注册一个 window focus 监听器（泄漏）。
  // 2026-10-21 一并删除：面板代码 + 重复的 ICONS + 那次重复注册。
  const attach = {
    saved: null,

    input() {
      return document.querySelector('input[type="file"]');
    },

    /** 清理旧版可能残留的回形针按钮（并进 + 菜单后不再建）。 */
    ensure() {
      const stale = document.querySelectorAll('.ms-attach');
      for (const el of stale) el.remove();
    },

    save(input) {
      if (this.saved) return;
      this.saved = {
        accept: input.getAttribute('accept'),
        capture: input.getAttribute('capture'),
        multiple: input.multiple,
      };
    },

    restore() {
      const input = this.input();
      if (!this.saved || !input) return;
      const s = this.saved;
      if (s.accept === null) input.removeAttribute('accept');
      else input.setAttribute('accept', s.accept);
      if (s.capture === null) input.removeAttribute('capture');
      else input.setAttribute('capture', s.capture);
      input.multiple = s.multiple;
      this.saved = null;
    },

    pick(kind) {
      const input = this.input();
      if (!input || input.disabled) return;
      // 每次点都从原始状态重新设，避免上一次残留
      this.restore();
      this.save(input);

      if (kind === 'camera') {
        input.setAttribute('accept', 'image/*');
        input.setAttribute('capture', 'environment');
        input.multiple = false;
      } else if (kind === 'album') {
        input.setAttribute('accept', 'image/*');
        input.removeAttribute('capture');
        input.multiple = true;
      } else {
        input.removeAttribute('accept');
        input.removeAttribute('capture');
        input.multiple = true;
      }

      // click 必须在本次点击的同步流程里，晚一点 iOS 会当成被拦截的弹窗
      try {
        input.click();
      } catch {
        this.restore();
        return;
      }
      input.addEventListener('change', () => this.restore(), { once: true });
      setTimeout(() => this.restore(), 20000);
    },
  };

  attach.ensure();

  // ---- 把「拍照 / 相册 / 文件」并进官方 + 菜单的顶部 ----
  //
  // 原来回形针和 + 是两个按钮，语义还重叠（+ 菜单第一项就是「文件」）。
  // 现在只留 +：点开后面板最上面是三格，下面是官方原来的命令列表（一行没动）。
  //
  // 往 React 管的列表里插节点，所以是「每次菜单打开都插一次」，
  // 靠 __msTiles 防止同一次打开重复插。
  const TILE_ICONS = {
    camera:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="6.8" width="18" height="13.2" rx="3"/>' +
      '<path d="M8.6 6.8l1.1-2.1h4.6l1.1 2.1"/>' +
      '<circle cx="12" cy="13.2" r="3.5"/></svg>',
    album:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="4.5" width="18" height="15" rx="3"/>' +
      '<circle cx="8.7" cy="9.7" r="1.5"/>' +
      '<path d="M4 17.4l4.4-4.2a1.5 1.5 0 0 1 2 0l3 2.9 2.1-2a1.5 1.5 0 0 1 2 0l2.5 2.4"/></svg>',
    file:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9.8 13.1l5.1-5.1a3 3 0 0 1 4.2 4.2l-6.5 6.5a4.2 4.2 0 0 1-5.9-5.9l6.1-6.1"/></svg>',
  };

  const TILE_ACTS = [
    ['album', '相册'],
    ['camera', '拍照'],
    ['file', '文件'],
  ];

  /*
   * 三格放在菜单**下方**（菜单和输入框之间）的独立浮层里，不插进菜单的 DOM。
   *
   * 为什么是浮层：命令菜单不是 portal，是塞在输入卡片 overlayAnchor 里的（高 0、
   * absolute，往上画）。往里插普通流节点，它不会把菜单撑高，直接压到输入框上
   * （实测：三格和输入框叠在一起）。
   *
   * 为什么菜单要上抬：菜单底边到输入框卡片顶边只有 8.5px（实测 rect
   * 菜单 [20,373,343,335]、输入卡 [16,716,351,98]），三格高 84px 塞不进去。
   * 所以先用 CSS `translate` 把菜单整体上抬 (84+8)px，腾出的位置放三格。
   * 上抬用 `translate` 而不是 `transform`：官方菜单自己可能会用 transform 做入场，
   * 换个属性写就不会互相覆盖。
   *
   * 位置不能每轮都重新量：菜单被 translate 抬过之后，getBoundingClientRect 量到的
   * 是抬过的值，250ms 轮询一次就会越抬越高。所以只认布局量
   * ——anchor 的 top（没被 translate 影响）和菜单的 offsetHeight。
   */
  const attachRack = {
    el: null,

    ensure() {
      // 宿主容器：官方那个贴着输入卡上沿的定位容器。官方菜单也挂在它里面，
      // 所以「跟着输入卡走」这件事不用我们操心。拿不到才退回 body。
      const anchor = document.querySelector('[class*="_overlayAnchor"]');
      const host = anchor || document.body;
      if (this.el && this.el.isConnected && this.el.parentElement === host) return this.el;

      if (!this.el) {
        const el = document.createElement('div');
        el.className = 'ms-rack';
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', '添加图片或文件');
        this.el = el;
        this.build(el);
      }
      // React 重渲染会把不是它画的节点摘掉，所以每次显示都确认一下还挂在宿主里
      host.append(this.el);
      return this.el;
    },

    build(el) {
      for (const [kind, label] of TILE_ACTS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ms-rack-tile';
        b.setAttribute('aria-label', label);
        b.innerHTML = TILE_ICONS[kind] + '<span>' + label + '</span>';
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // 取证：真机上这一下到底有没有到格子
          reportDiag('tile-ck', { k: kind, tg: pathOf(e.target), inp: !!attach.input() });
          // input.click() 必须在同一个手势里同步调用，晚一点系统就当弹窗拦了
          attach.pick(kind);
          attachRack.hide();
          // 再把官方菜单收掉：它认「点外面」，这里补一发 body 上的按下事件
          setTimeout(() => {
            try {
              document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
              document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            } catch {
              /* noop */
            }
          }, 0);
        });
        el.append(b);
      }
      return el;
    },

    /*
     * 挂在官方那个「高 0、贴着输入卡上沿」的定位容器（overlayAnchor）里，
     * 位置就交给官方布局：键盘弹起 / 收起时输入卡整体移动，抽屉跟着一起移动。
     *
     * 为什么不再自己算 top（这条是真机日志逼出来的）：
     * 键盘还压着的时候布局视口只有 502px，而 top 是按「没有键盘时的 845px」算的，
     * 算出 607px —— 这个位置在视口外面。真机日志里三格中心的坐标反查全是 `none`：
     * 面板画在视口外，**根本不可点**，手指那一下落到下面的消息上，面板随即被当成
     * 「点外面」关掉。用户看到的就是「面板出来了但点不到、还打开了底下的东西」。
     * 只要位置由官方布局决定，这个窗口期就不存在了。
     */
    show() {
      if (!document.querySelector('[class*="_overlayAnchor"]')) return;
      const el = this.ensure();
      root.setAttribute('data-ms-rack', '1');
      // 取证：面板稳定后把「几何 + 三格中心按坐标反查到的元素」报一次。
      // 反查命中三格 → 命中没问题，问题在事件；命中别的 → 画的位置和判的位置不一致。
      if (Date.now() - (attachRack._diagAt || 0) > 2000) {
        attachRack._diagAt = Date.now();
        const rr = el.getBoundingClientRect();
        const tiles = el.querySelectorAll('.ms-rack-tile');
        const hits = [];
        for (const t of tiles) {
          const r = t.getBoundingClientRect();
          hits.push(Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2) + '=' + hitAt(r.x + r.width / 2, r.y + r.height / 2));
        }
        reportDiag('rack', {
          t: Math.round(rr.y),
          h: Math.round(rr.height),
          par: el.parentElement ? pathOf(el.parentElement) : 'none',
          z: getComputedStyle(el).zIndex,
          hit: hits.join('|'),
        });
      }
      // 抽屉开着，说明用户还在挑：续上布防，慢手机上 effect 来得晚也不怕。
      // 只续不新设 —— 用户真点了输入框会清掉布防，这里不会把它复活。
      if (imeGuardActive()) armImeGuard(imeGuardReason || 'menu', 4000);
    },

    hide() {
      root.removeAttribute('data-ms-rack');
    },
  };

  /** 找到真正画出菜单的那个盒子（外层 wrapper 高度是 0，不能用）。 */
  function commandMenuBox() {
    const anchor = document.querySelector('[class*="_overlayAnchor"]');
    if (!anchor) return null;
    let best = null;
    for (const el of anchor.querySelectorAll('div')) {
      const r = el.getBoundingClientRect();
      if (r.height < 80 || r.width < 120) continue;
      if (!/压缩|模型|Compact|Model/i.test(el.textContent || '')) continue;
      // 嵌套时取最内层（面积最小）的那个，那就是菜单卡片本身
      const area = r.width * r.height;
      if (!best || area < best.area) best = { el, area, rect: r };
    }
    return best;
  }

  /** 附件抽屉只在「点 + 打开」时出现；`/` 唤出的指令菜单不显示抽屉。 */
  function syncRack() {
    try {
      if (root.getAttribute('data-ms-attach') !== '1') {
        attachRack.hide();
        return;
      }
      // 官方菜单被藏起来了（display:none），但节点还在；节点真没了才是关掉了。
      //
      // 刚打开时不能立刻判死：React 挂菜单要一拍，第一次 syncRack 在 30ms
      // 就跑了，那时节点还没出现。旧代码在这里直接清 attach —— 于是「点 +
      // 什么都不发生」，而且每拍轮询都在自我取消。给 800ms 宽限。
      if (!document.querySelector('[class*="_menu"]')) {
        if (Date.now() - attachOpenedAt < 800) return;
        root.removeAttribute('data-ms-attach');
        attachRack.hide();
        return;
      }
      attachRack.show();
      if (!rackTimer) rackTimer = setTimeout(pollRack, 250);
    } catch {
      /* 出错就当作面板没开 */
    }
  }

  // 菜单是点开的，挂上去要等一拍；之后还要盯着它关掉
  let rackTimer = 0;
  function pollRack() {
    syncRack();
    if (root.getAttribute('data-ms-rack') === '1') {
      rackTimer = setTimeout(pollRack, 250);
    } else {
      rackTimer = 0;
    }
  }
  onClickCapture('rack-sync', () => {
    [30, 90, 200, 400].forEach((d) => setTimeout(syncRack, d));
  });
  // 取证：面板开着时，每一次 click 到货没有、落在谁身上
  onClickCapture('rack-diag', (e) => {
    if (root.getAttribute('data-ms-rack') !== '1') return;
    reportDiag('ck', { tg: pathOf(e.target) });
  });
  document.addEventListener('scroll', () => {
    if (root.getAttribute('data-ms-rack') === '1') syncRack();
  }, { capture: true, passive: true });

  // ---- 打开会话时不要自动弹输入法 ----
  //
  // 官方在会话挂载时会 focus 输入框，手机上键盘直接弹出来。
  // 判据不是「最近有没有触摸」（导航那一下本身就是触摸），而是
  // 「这一下触摸的落点是不是输入框自己」——只有用户真的点输入框才放行。
  let lastPointerAt = 0;
  let lastPointerTarget = null;
  let allowAutoFocusUntil = 0;

  // ---- 点工具栏 / 菜单不弹输入法 ----
  //
  // 实测到的两条自动聚焦路径：
  //   1) 点 + 后约 248ms，官方在 effect 里对编辑器调一次 editor.focus()；
  //   2) 在 + 菜单里点「模型 model」，模型列表打开的同时程序化聚焦搜索框
  //     （INPUT[text]，aria="筛选选项"，placeholder="搜索模型…"）。
  // 所以规则是：只有「直接点到可输入目标」才允许弹键盘；点工具栏、菜单、
  // 弹窗里其它位置时，只布防、不聚焦。直接点到输入框 / 搜索框会立即解除布防。
  const NATIVE_FOCUS = window.__msNativeFocus || HTMLElement.prototype.focus;
  window.__msNativeFocus = NATIVE_FOCUS;
  let imeGuardUntil = 0;
  let imeGuardReason = '';

  function isTextField(el) {
    if (!el) return false;
    if (el.isContentEditable === true || el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    return type === '' || ['text', 'search', 'url', 'tel', 'password', 'email', 'number'].includes(type);
  }

  function armImeGuard(reason, ms = 5000) {
    imeGuardUntil = Date.now() + ms;
    imeGuardReason = reason;
  }

  function clearImeGuard() {
    imeGuardUntil = 0;
    imeGuardReason = '';
  }

  function imeGuardActive() {
    return Date.now() < imeGuardUntil;
  }

  let imeDismissTimer = 0;

  /*
   * 键盘到底开没开。
   *
   * 不能只看 activeElement —— 编辑器有焦点但键盘没收起来/已经收起来是很常见的，
   * 而 blur 一个"有焦点但键盘没开"的编辑器，官方的富文本会立刻把焦点抢回去，
   * 键盘就弹一下又被我们 300ms 补刀收掉：真机上就是「点 + 之后输入法闪一下」。
   *
   * 所以判据换成视口：
   *   1) iOS 走 visualViewport：可视视口比布局视口矮一截，就是键盘占了地方；
   *   2) 安卓 adjustResize：窗口本身被压矮，跟历史最大高度比。
   * maxViewportH 取历史最大值，地址栏伸缩（~60px）落在 120px 阈值之内，不会误判。
   */
  let maxViewportH = window.innerHeight;
  window.addEventListener(
    'resize',
    () => {
      if (window.innerHeight > maxViewportH) maxViewportH = window.innerHeight;
    },
    { passive: true },
  );

  function imeVisible() {
    try {
      const vv = window.visualViewport;
      if (vv && Math.abs(window.innerHeight - vv.height) > 80) return true;
    } catch {
      /* noop */
    }
    return window.innerHeight < maxViewportH - 120;
  }

  /*
   * 诊断上报：把「当前跑的是哪一版」和「它认为键盘开没开」送回网关。
   *
   * 用处只有一句：以后再说「改了没变化」时，先看日志里是哪一版、视口到底多少，
   * 不用再猜是客户端缓存还是键盘判据错了。
   * 只报版本号和视口尺寸，不碰任何会话内容；失败静默。
   */
  function reportDiag(tap, extra) {
    try {
      const vv = window.visualViewport;
      // 网关那边只记白名单字段（tap / act 都是自由字符串），
      // 所以附加信息拼进 tap 里带过去，不用改宿主机代码、不用重启。
      let name = String(tap);
      if (extra) {
        const parts = [];
        for (const k of Object.keys(extra)) {
          parts.push(k + '=' + String(extra[k]).replace(/[|&\s]+/g, '_').slice(0, 90));
        }
        if (parts.length) name += '|' + parts.join('|');
      }
      const q = new URLSearchParams({
        v: String(window.__msVersion || ''),
        tap: name,
        ih: String(window.innerHeight),
        vv: String(vv ? Math.round(vv.height) : -1),
        mx: String(maxViewportH),
        ime: imeVisible() ? '1' : '0',
        act: String((document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || '').slice(0, 40),
        ua: String(navigator.userAgent || '').slice(0, 100),
      });
      fetch('/m/__ms/hello?' + q.toString(), { cache: 'no-store' }).catch(() => {});
    } catch {
      /* noop */
    }
  }
  // 给后面的独立 IIFE（锚点自检）用：它们在主闭包外面，拿不到这个函数。
  window.__msDiag = reportDiag;

  /*
   * 临时取证：把「点在不该点的地方」这件事的原貌送回来。
   *
   * 只在真机上才有的现象，无头浏览器复现不出来，唯一可靠的办法是让页面自己
   * 把「按下命中了谁 / 抬起后 click 命中了谁 / 按坐标反查命中了谁」三份答案
   * 同时报上来。够用就删，不要留成常态日志。
   */
  function pathOf(el) {
    try {
      const s = [];
      for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
        const c = typeof n.className === 'string' ? n.className.split(/\s+/)[0] : '';
        s.push(n.tagName.toLowerCase() + (c ? '.' + c : ''));
      }
      return s.join('<');
    } catch {
      return '?';
    }
  }
  function hitAt(x, y) {
    try {
      const el = document.elementFromPoint(x, y);
      return el ? pathOf(el) : 'none';
    } catch {
      return 'err';
    }
  }
  let lastRackDiagAt = 0;

  // 点 + / 模型触发器 / 发送键时，如果键盘本来就开着（输入框已有焦点），光靠“拦新 focus”
  // 是不够的：焦点本来就在输入框里，菜单打开了键盘也不走。
  // 所以菜单打开后再补一刀 blur。但不能点下去立刻 blur ——
  // 点按处理函数还没跑完时 blur，会把还没开完的菜单一起关掉（6.14 量过）。
  // 300ms 后菜单已经在了，这时 blur 只关键盘、不关菜单（probe-plus 实验 2 验证过）。
  // 用户在这 300ms 里真点了输入框 / 搜索框，markPointer 会清掉布防，这里直接跳过。
  // 注意没有 'stop'：点停止时用户可能正在改字，只拦官方送回来的新聚焦，不抢已有键盘。
  function scheduleImeDismiss() {
    if (imeDismissTimer) return;
    imeDismissTimer = setTimeout(() => {
      imeDismissTimer = 0;
      try {
        if (!imeGuardActive()) return;
        if (imeGuardReason !== 'plus' && imeGuardReason !== 'menu' && imeGuardReason !== 'model' && imeGuardReason !== 'send') return;
        const a = document.activeElement;
        try { reportDiag('ime-dismiss', { reason: imeGuardReason, isField: !!(a && isTextField(a)) }); } catch { /* noop */ }
        if (a && isTextField(a)) a.blur();
      } catch {
        /* noop */
      }
    }, 300);
  }

  /** 把焦点从输入框上切断（用于点 + / 模型 / 发送）。
   *
   * **无条件切断，不看键盘开没开**：
   * 键盘开没开的判据（视口高度）在安卓上不可靠 —— 真机日志里出现过
   * act=RlGAzG_input 但 ime=0 的组合。只要判成"没开"就跳过 blur，输入框的
   * 焦点就留在原地：系统认为还在输入状态，键盘会自己回来，和附件面板打架
   * （真机表现：光标还在闪、键盘莫名抽搐）。
   * 至于"blur 后官方又把焦点抢回去"，由 armImeGuard 的焦点守卫挡住。 */
  function blurImeNow() {
    try {
      const a = document.activeElement;
      if (a && isTextField(a)) a.blur();
    } catch {
      /* noop */
    }
  }

  /*
   * 这里原来有一段「收键盘后先把菜单和三格 visibility:hidden，等视口高度稳定
   * 5 帧或 600ms 超时再放出来」。删掉的原因：
   *
   * 它本质是拿「隐藏」掩盖「布局在动」。看门狗只要没跑完，用户看到的就是
   * 「键盘收起来了，面板什么都没有」—— 比面板跟着移动难看得多，也更难查。
   * 现在改为面板立刻显示，靠 syncRack 的 30/90/200/400ms 采样 + 250ms 轮询
   * 持续跟随输入卡重新定位：键盘收起期间它是「往上滑」，不是「先消失再出现」。
   */

  HTMLElement.prototype.focus = function (...args) {
    if (
      imeGuardActive() &&
      isTextField(this) &&
      this !== lastPointerTarget &&
      !(lastPointerTarget && lastPointerTarget.contains && lastPointerTarget.contains(this))
    ) {
      return;
    }
    return NATIVE_FOCUS.apply(this, args);
  };

  /** 点的是不是那个 +：它和隐藏的 file input 是同一个父节点（比 aria 文案稳）。 */
  function isPlusTap(target) {
    if (!target || !target.closest) return false;
    const btn = target.closest('button');
    if (!btn) return false;
    const box = btn.parentElement;
    return !!box && !!box.querySelector('input[type="file"]');
  }

  /** 点的是不是模型触发器：认 aria 前缀，同时兼容官方根节点类名。 */
  function isModelTrigger(target) {
    if (!target || !target.closest) return false;
    const btn = target.closest('button, [role="button"]');
    if (!btn) return false;
    const aria = (btn.getAttribute && btn.getAttribute('aria-label')) || '';
    if (/^选择模型/.test(aria)) return true;
    return !!btn.closest && !!btn.closest('[class*="_root"]');
  }

  /** 点的是不是停止/中断按钮：停掉生成后官方会把焦点送回输入框，手机上等于弹键盘。 */
  function isStopTap(target) {
    if (!target || !target.closest) return false;
    const btn = target.closest('button, [role="button"]');
    if (!btn) return false;
    const s = ((btn.getAttribute && btn.getAttribute('aria-label')) || '') + ' ' + ((btn.getAttribute && btn.getAttribute('title')) || '');
    return /停止|中断|\bstop\b/i.test(s);
  }

  /** 点的是不是发送键：认 aria，兜底认输入卡片里那颗主按钮（生成时它是停止键，用 aria 排除）。 */
  function isSendTap(target) {
    if (!target || !target.closest) return false;
    const btn = target.closest('button, [role="button"]');
    if (!btn) return false;
    const s = ((btn.getAttribute && btn.getAttribute('aria-label')) || '') + ' ' + ((btn.getAttribute && btn.getAttribute('title')) || '');
    if (/发送|\bsend\b/i.test(s)) return true;
    return (
      !!btn.closest &&
      !!btn.closest('[class*="_card"]') &&
      /primary/i.test(String(btn.className || '')) &&
      !/停止|中断|\bstop\b/i.test(s)
    );
  }

  /** 点的是不是浮层菜单 / 弹窗里的非输入位置：是就刷新布防，不是就什么都不做。 */
  function isTransientTap(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(
      '[class*="_overlayAnchor"], .ms-rack, .ms-stash, .ms-stash-btn, [role="menu"], [role="dialog"], [role="listbox"], [role="combobox"], [class*="popover"], [class*="sheet"], [class*="menu"], [class*="dialog"]',
    );
  }

  /** 点的是不是新建会话 / 新建任务：这是唯一允许自动弹键盘的地方，布防要让路。 */
  function isNewSessionTap(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('button[aria-label="新建会话"], button[aria-label="新建任务"], [class*="newSession"], [data-ms-newtask]');
  }

  /** 是不是输入框本体（composer 里的可编辑区），不是菜单里的搜索框。 */
  function isComposerEditor(el) {
    if (!el || !el.closest) return false;
    if (el.isContentEditable !== true && el.tagName !== 'TEXTAREA') return false;
    return !!el.closest('[class*="_card"], [class*="_composerSeat"]');
  }

  // ---- 斜杠指令菜单 ↔ 输入法互斥 ----
  //
  // 输入框首字符是 `/` 时官方菜单会弹在输入卡上方；键盘不收，菜单就被压掉一半。
  // 这里只 hide 键盘、不 blur：blur 会让官方菜单失焦关掉（见 plus-ime 的教训），
  // hideSoftInput 则保留页面焦点和菜单，视口长回来菜单完整可见。
  // 选完再同步 focus 回编辑器 + 把键盘还回来；「计划/文件/反馈」这类会开弹窗的项不抢键盘。
  //
  // 2026-10-25 修「/ 之后每敲一个字输入法就关一次」：
  // 旧实现末尾有个 400ms 的 setInterval，用「能不能找到官方菜单盒子（commandMenuBox）」
  // 决定要不要把状态复位。而 commandMenuBox 的文案判据是 /压缩|模型|Compact|Model/，
  // 斜杠菜单里根本没有这些词（实测菜单项是 添加文件 / 目标 / 设置或查看长期任务目标 / 计划），
  // 所以那个判据恒为假 —— 锁每 400ms 被清一次，用户输入 `/` 之后**每敲一个字**都会再收
  // 一次键盘。真机表现就是「/ 之后输入法反复自己收起来」。
  // 现在锁只由数据复位：输入框内容不再以 `/` 开头、焦点真的离开编辑器、或者消息发出去了。
  // 定时器一律不用 —— 状态机不许靠轮询推断。
  let slashLatch = false;
  /** 闸门用：这次斜杠会话里一共收了几次键盘（正常只能是 1）。 */
  window.__msImeHides = 0;

  function composerText(el) {
    try {
      return String((el && (el.innerText || el.value || el.textContent)) || '');
    } catch {
      return '';
    }
  }

  function inCommandMenu(target) {
    return !!(target && target.closest && target.closest('[class*="_overlayAnchor"]'));
  }

  /** 选中项会不会开弹窗/选择器：这类不把键盘抢回来。 */
  function menuItemOpensDialog(target) {
    try {
      const item = target.closest('button, [role="option"], [role="menuitem"], li, div');
      const text = String((item && item.textContent) || '').trim();
      return /^(文件|目标|计划|反馈)/.test(text);
    } catch {
      return false;
    }
  }

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!isComposerEditor(el)) return;
    // 中文输入法合成期间（拼音还没上屏）绝不能收键盘：这一下会把合成打断、候选词全丢。
    // e.isComposing 在合成中为真；inputType 那条是给个别不置 isComposing 的 ROM 兜底。
    if (e.isComposing || e.inputType === 'insertCompositionText') return;
    const text = composerText(el).trim();
    if (!text.startsWith('/')) {
      // 内容已经不是斜杠开头了（删掉 /、选中命令后清空、发出去了）：解锁
      slashLatch = false;
      return;
    }
    if (slashLatch) return;
    slashLatch = true;
    // 必须在输入手势里同步发；setTimeout 里系统会忽略“收键盘”的请求
    try {
      if (window.Shell && typeof window.Shell.hideKeyboard === 'function') window.Shell.hideKeyboard();
    } catch {
      /* noop */
    }
    window.__msImeHides += 1;
    reportDiag('slash-ime-hide');
    armSlashGeom();
  }, true);

  // 焦点真的离开编辑器（点到别处、切页）时才解锁，下次再输入 `/` 才重新收键盘。
  // 注意三种"看起来离开、其实还在输入"的情况都不能解锁：
  //   1) 官方先把焦点收走、几十毫秒后又抢回来；
  //   2) 焦点落到指令菜单/浮层里（菜单自己是 focusable 的时候）；
  //   3) 焦点跑到 body（安卓 WebView 点非可聚焦区域常见）。
  // 只要输入框里还是 `/` 开头，就说明用户还在这个斜杠会话里。
  document.addEventListener('focusout', (e) => {
    if (!isComposerEditor(e.target)) return;
    setTimeout(() => {
      const a = document.activeElement;
      if (isComposerEditor(a)) return;
      if (
        a &&
        a.closest &&
        a.closest("[class*='_overlayAnchor'], [data-ms-c~='menu'], [data-ms-c~='surface'], [role='menu'], [role='dialog'], [role='listbox']")
      ) {
        return;
      }
      const ed = document.querySelector('[class*="_card"] [contenteditable="true"]');
      if (ed && String(ed.innerText || '').trim().startsWith('/')) return; // 内容还在斜杠里，锁着
      slashLatch = false;
    }, 150);
  }, true);

  // ---- 斜杠指令菜单的几何夹取（menu ↔ 键盘互斥的第二半） ----
  //
  // 实测（390×844、r9）：菜单盒 rect = (16, -11, 351×422) —— 顶边本身就在视口外面 11px，
  // 键盘再一起来，可用高度只剩输入卡上沿以上那一点点，菜单被压掉大半甚至完全不可见。
  // 收键盘只能救一半，另一半必须把它钉在输入卡上方 + 装不下就内部滚动。
  //
  // 只动菜单盒自己，**绝不动官方的 overlayAnchor 容器**：动容器会让整组点击坐标漂移
  // （历史教训见 plus-ime 那段注释）。位置和高度都写成 CSS 变量，由测量结果决定。
  const SLASH_ATTR = 'data-ms-slash';

  /** 现在算不算「还在斜杠会话里」：锁还在，或者输入框内容仍然以 `/` 开头。
   * 用数据兜一层，是因为官方随时可能把焦点从编辑器拿走（菜单 focusable、WebView 落 body 等），
   * 单靠布尔锁会被一次 focusout 清掉，菜单就又跑回屏幕外。 */
  function composerEditor() {
    // 官方给输入框盖了 data-composer-input（A 级锚点）。必须用它定位，
    // 不能 `[class*="_card"]` 取第一个 —— 长会话里第一个 _card 是消息卡，
    // 实测拿到 cardTop=-2925（滚到上面的历史消息），夹取直接判成"布局没稳"跳过。
    return (
      document.querySelector('[data-composer-input="true"]') ||
      document.querySelector('[class*="_composerSeat"] [contenteditable="true"]') ||
      document.querySelector('[class*="_card"] [contenteditable="true"]')
    );
  }

  function slashSessionAlive() {
    if (slashLatch) return true;
    const ed = composerEditor();
    return !!(ed && String(ed.innerText || '').trim().startsWith('/'));
  }

  function slashMenuBox() {
    // 锚点用盖章后的本地名 overlayAnchor（A/B 级），不用 [class*='_overlayAnchor'] 这种过宽子串
    const anchor = document.querySelector("[data-ms-c~='overlayAnchor']");
    if (!anchor) return null;
    // 盖章器给菜单卡盖的本地名是 menu；万一没盖到，按「anchor 里高度最大的一层」兜底
    const named = anchor.querySelector("[data-ms-c~='menu']");
    if (named && named.getBoundingClientRect().height > 60) return named;
    let best = null;
    for (const el of anchor.querySelectorAll('div')) {
      const r = el.getBoundingClientRect();
      if (r.height < 60 || r.width < 120) continue;
      if (!best || r.height > best.h) best = { el, h: r.height };
    }
    return best ? best.el : null;
  }

  let slashGeomDiagAt = 0;
  function slashGeomSkip(why, extra) {
    // 只在真出问题时留痕（2 秒一条），平常一次也不发，免得 diag.log 被刷爆
    if (Date.now() - slashGeomDiagAt < 2000) return;
    slashGeomDiagAt = Date.now();
    try {
      reportDiag('slash-geom-skip', Object.assign({ why }, extra || {}));
    } catch {
      /* noop */
    }
  }

  function syncSlashGeom() {
    try {
      const menu = slashMenuBox();
      if (!menu) {
        if (root.getAttribute(SLASH_ATTR) === '1') root.removeAttribute(SLASH_ATTR);
        // 只有"人在斜杠会话里、菜单却不见了"才值得留痕；平时（不开菜单）一次都不报，
        // 否则这个观察器每 2 秒就往 diag.log 写一条没人看的东西。
        if (slashLatch) slashGeomSkip('no-menu');
        return;
      }
      if (!slashSessionAlive()) {
        if (root.getAttribute(SLASH_ATTR) === '1') root.removeAttribute(SLASH_ATTR);
        slashGeomSkip('not-slash-session', { latch: slashLatch ? 1 : 0 });
        return;
      }
      const ed = composerEditor();
      const card = (ed && ed.closest('[class*="_card"]')) || (ed && ed.closest('[class*="_composerSeat"]')) || ed;
      const cardTop = card ? card.getBoundingClientRect().top : 0;
      const vh = window.innerHeight;
      // 布局还没稳的时候 cardTop 可能是 0 或者贴顶，这时夹取只会把它推到屏幕外，先不夹
      if (!(cardTop > 120 && cardTop < vh)) {
        root.removeAttribute(SLASH_ATTR);
        slashGeomSkip('card-top', { cardTop: Math.round(cardTop), vh: Math.round(vh) });
        return;
      }
      // 上边界让开首栏：否则菜单卡片会顶到状态栏底下，汉堡键浮在白色卡片上看着像画错了。
      // 首栏和标签行是两个元素（会话页标签行不在 header 里面），两个都要让。
      const header = document.querySelector("header[data-ms-c~='header']") || document.querySelector('header');
      const tabsEl = document.querySelector("[data-ms-c~='tabs']");
      const headerBottom = Math.max(
        header ? header.getBoundingClientRect().bottom : 0,
        tabsEl ? tabsEl.getBoundingClientRect().bottom : 0,
      );
      const topLimit = Math.round(Math.max(0, headerBottom) + 6);
      root.style.setProperty('--ms-slash-top', Math.round(cardTop) + 'px');
      // 菜单底边 = 输入卡顶边：用「视口高 - 卡顶」换算成 bottom，避免 vh 单位在键盘态下的歧义
      root.style.setProperty('--ms-slash-bottom', Math.round(vh - cardTop) + 'px');
      const room = cardTop - topLimit;
      // 太矮的时候（小屏 + 键盘）不再让首栏，宁可盖住也要让菜单本身能用
      root.style.setProperty('--ms-slash-max', Math.round(room >= 200 ? room : Math.max(160, cardTop - 12)) + 'px');
      root.setAttribute(SLASH_ATTR, '1');
    } catch {
      /* noop */
    }
  }

  /** 菜单是异步渲染的：键盘收起后视口变化 + 官方布局，分几拍量才准。 */
  function armSlashGeom() {
    [0, 60, 200, 500].forEach((d) => setTimeout(syncSlashGeom, d));
  }

  // 菜单是官方自己渲染的，什么时候挂上、什么时候被过滤没了都不通知我们，
  // 所以再挂一个观察器兜底（只在斜杠锁生效期间工作，平时零开销）：
  // 面板行、命令项、流式输出都会引起 DOM 变动，这里节流到 80ms 一次，够快也不浪费。
  let slashGeomQueue = 0;
  try {
    new MutationObserver(() => {
      // 不加 latch 前置判据：官方随时可能把焦点拿走导致 latch 被清，
      // 但菜单还开着、输入框里还是 `/`。这里只做节流，具体判据交给 syncSlashGeom
      //（它第一件事就是查菜单在不在，查不到立刻返回，流式输出期间开销也就一次 querySelector / 80ms）。
      if (slashGeomQueue) return;
      slashGeomQueue = setTimeout(() => {
        slashGeomQueue = 0;
        syncSlashGeom();
      }, 80);
    }).observe(document.body, { childList: true, subtree: true });
  } catch {
    /* noop */
  }

  let slashGeomResizeAt = 0;
  const onSlashViewportChange = () => {
    if (Date.now() - slashGeomResizeAt < 120) return;
    slashGeomResizeAt = Date.now();
    setTimeout(syncSlashGeom, 120);
  };
  window.addEventListener('resize', onSlashViewportChange, { passive: true });
  try {
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onSlashViewportChange, { passive: true });
  } catch {
    /* noop */
  }

  onClickCapture('slash-ime-restore', (e) => {
    if (!slashLatch || !inCommandMenu(e.target)) return;
    slashLatch = false;
    if (menuItemOpensDialog(e.target)) {
      reportDiag('slash-ime-skip-dialog');
      return;
    }
    // 同步 focus + 还键盘：安卓只在用户手势内接受“要键盘”
    try {
      clearImeGuard();
      const ed = document.querySelector('[class*="_card"] [contenteditable="true"]');
      if (ed) (window.__msNativeFocus || HTMLElement.prototype.focus).call(ed);
      if (window.Shell && typeof window.Shell.showKeyboard === 'function') window.Shell.showKeyboard();
      reportDiag('slash-ime-restore');
    } catch {
      /* noop */
    }
  });

  /** 关掉 + 命令菜单：官方认「点外面」，补一发 body 上的按下事件；再把三格收掉。
   * 不用 Esc：Esc 在某些输入框里会顺手把焦点也弄丢，点外面不会动焦点。 */
  function closeCommandMenu() {
    attachRack.hide();
    // 附件抽屉的开关标记也要清，否则下一轮 syncRack 还当它开着
    root.removeAttribute('data-ms-attach');
    setTimeout(() => {
      try {
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      } catch {
        /* noop */
      }
    }, 0);
  }

  /** 点 + 那一下菜单是不是已经开着：是的话，这次点按就是来关它的。 */
  let plusMenuWasOpen = false;
  /** 这个面板是不是「键盘开着」时打开的：关面板时要把键盘还回去。 */
  let plusOpenedWithIme = false;
  /** 附件面板打开的时刻：syncRack 用它给「菜单还没挂上」留宽限。 */
  let attachOpenedAt = 0;
  /** 手指按下那一刻命中的元素（click 落点漂移校验用）。 */
  let downHitEl = null;

  const markPointer = (e) => {
    // 只认真正的用户输入。我们自己在关面板 / 点格子时会派发合成的
    // pointerdown，它没有坐标（clientX/Y 默认 0），会把 downHitEl 记成
    // 左上角那个元素，之后 tap-shift-guard 的比对全部失真 ——
    // 表现为「点输入框关面板后，光标没落进去，得再点一次」。
    if (e.isTrusted === false) return;
    lastPointerAt = Date.now();
    lastPointerTarget = e.target;
    // 记下手指按下那一刻真正命中的元素。click 落点漂移校验要用它（见 link-shift-guard）。
    if (e.type === 'pointerdown' && typeof e.clientX === 'number') {
      try {
        downHitEl = document.elementFromPoint(e.clientX, e.clientY) || e.target;
      } catch {
        downHitEl = e.target;
      }
    } else if (e.target) {
      downHitEl = e.target;
    }
    // 取证：面板开着时，把「按下这一点」和「按下时按坐标反查到谁」都报回来
    if (e.type === 'pointerdown' && typeof e.clientX === 'number' && root.getAttribute('data-ms-rack') === '1') {
      reportDiag('pd', {
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        tg: pathOf(e.target),
        dh: downHitEl ? pathOf(downHitEl) : 'null',
      });
    }
    if (isTextField(e.target)) {
      clearImeGuard();
      // 点输入框就是要打字：如果 + 菜单还开着，顺手收掉（用户要地方打字了）
      if (isComposerEditor(e.target) && root.getAttribute('data-ms-rack') === '1') {
        closeCommandMenu();
      }
      return;
    }
    if (isNewSessionTap(e.target)) {
      // 新建会话是唯一允许自动弹键盘的地方（allowAutoFocusUntil 那套还在），布防让路
      clearImeGuard();
      return;
    }
    if (isPlusTap(e.target)) {
      // 「这次是开还是关」不能只问官方菜单：官方在我们收到 pointerdown 之前
      // 就已经把菜单收掉了，commandMenuBox() 返回 null，第二次点 + 会被误判成
      // 「打开」，把记住的键盘状态覆盖掉。所以连我们自己的三格标记一起看。
      plusMenuWasOpen = root.getAttribute('data-ms-rack') === '1' || !!commandMenuBox();
      // 只在「这次是打开面板」时记录键盘状态；关闭那一次不能再记，那时键盘
      // 早被我们收掉了，一记就把 true 覆盖成 false，关面板时就不还键盘。
      if (!plusMenuWasOpen) plusOpenedWithIme = imeVisible();
      armImeGuard('plus');
      reportDiag('plus');
      // 这里只记录状态 + 布防，不动焦点。
      // 收键盘放到 click 之后（见 plus-ime）：在手指按下这一刻收，布局会在
      // click 之前先变一次，面板的点击坐标就落空了，真机就是「只收键盘、
      // 面板没反应」。
    } else if (isModelTrigger(e.target)) {
      // 只布防，**绝不在这里 blur**。
      // 手指按下就收键盘 → 视口变高 → 输入卡从键盘上方掉回底部（实测位移 300+px），
      // 这一下的 click 就落到 300px 之外 —— 真机表现「只关了键盘、模型菜单没弹，
      // 还有几率穿透点到下层内容」。和当年 + 号是同一个坑（见下面 plus-ime 注释）：
      // 收键盘只能放到 click 之后，或者干脆不收。
      // 这里选「不收」：人正在打字，切个模型接着打是最自然的，官方桌面上也不收。
      armImeGuard('model');
    } else if (isStopTap(e.target)) {
      // 只拦官方送回来的新聚焦，不抢已有焦点：用户可能正在改字，键盘留着是对的
      armImeGuard('stop');
    } else if (isSendTap(e.target)) {
      // 发送只布防、不抢 blur：之前这里同步 blur，键盘收起引发的重渲染
      // 会把发送按钮换掉，随后的 click 落空（真机：键盘开着点发送只关键盘
      // 不发送，得再点一次）。改成官方发完、300ms 补刀再收键盘。
      armImeGuard('send');
      scheduleImeDismiss();
      try { reportDiag('send-tap', { act: (document.activeElement && document.activeElement.tagName) || '' }); } catch { /* noop */ }
    } else if (isTransientTap(e.target)) {
      armImeGuard('menu', 4000);
    } else {
      // 其他任何非输入落点：默认布防。以后只有直接点到输入框 / 搜索框才许弹键盘，
      // 官方在别处自作主张 focus() 一律吞掉（真机上“干什么都弹键盘”就是这么来的）。
      armImeGuard('tap', 5000);
    }
  };

  /*
   * 键盘与 + 面板互斥（用户定义的规格）：
   *   键盘没开 + 点 +      → 只出面板，键盘不动；
   *   键盘开着 + 点 +      → 收键盘、出面板，并记住"这次是带键盘打开的"；
   *   再点一次（关面板）   → 面板收起，键盘恢复，焦点回输入框。
   *
   * 为什么收键盘放在 click 冒泡、而不是 pointerdown：
   * 手指按下那一刻收，布局会在 click 之前先变一次 —— 面板的点击坐标落空、
   * 事件被吞，真机就是「只收了键盘、面板没反应」。click 处理完再收，布局
   * 怎么变都不影响这一次点击；面板位置由 syncRack 的采样跟着输入卡走。
   */
  onClickBubble('plus-ime', (e) => {
    if (!isPlusTap(e.target)) return;
    // 这次是收起面板：把键盘还给用户（只有带键盘打开的那次才还）
    if (plusMenuWasOpen) {
      reportDiag('ime-close-' + (plusOpenedWithIme ? 'y' : 'n'));
      root.removeAttribute('data-ms-attach');
      if (!plusOpenedWithIme) return;
      plusOpenedWithIme = false;
      // 恢复键盘必须**在这个手势里同步做**。
      // 系统只在用户手势内接受"要键盘"的请求；推迟到 setTimeout 再 focus，
      // 要么被忽略（键盘不回来），要么在某个无关时刻突然弹出来。
      try {
        // 布防可能还挂着，先放开；再用**原生** focus 直接落焦。
        // 用原型上的 focus 会被我们自己的守卫拦（守卫是给「官方程序化抢焦点」
        // 用的），这里是我们自己要还键盘，必须绕过。
        clearImeGuard();
        const ed = document.querySelector('[class*="_card"] [contenteditable="true"]');
        if (ed) (window.__msNativeFocus || HTMLElement.prototype.focus).call(ed);
      } catch {
        /* noop */
      }
      return;
    }
    // 这次是打开面板：只在 + 打开时显示附件抽屉，官方指令菜单藏起来
    reportDiag('ime-open-' + (plusOpenedWithIme ? 'y' : 'n'));
    root.setAttribute('data-ms-attach', '1');
    attachOpenedAt = Date.now();
    // 无条件切断焦点：面板要独占底部，输入框不许留着焦点（留着光标还闪，
    // 系统会认为仍在输入，键盘随时可能自己弹回来跟面板打架）。
    blurImeNow();
    setTimeout(syncRack, 30);
  });

  // + 菜单开着时再点 +：官方第二次点不关（实测点击到货但菜单还在），这里补一刀。
  // 用冒泡阶段，等官方自己的处理先跑完；如果官方关了，这里就是空操作。
  onClickBubble('plus-close-menu', (e) => {
    if (!isPlusTap(e.target)) return;
    if (!plusMenuWasOpen) return;
    plusMenuWasOpen = false;
    setTimeout(() => {
      try {
        if (commandMenuBox()) closeCommandMenu();
        else attachRack.hide();
      } catch {
        /* noop */
      }
    }, 0);
  });

  /*
   * 页头收纳钮 + 二级小菜单。
   *
   * 工具栏只留标题 / 成员 / 后台任务 / 收纳 / 右栏开关（文件组 WgQWqa_* 和
   * 更多操作被 CSS display:none 藏了，只动手机端）。
   * 收纳菜单点行 = 替点官方按钮（display:none 的按钮照样吃程序化 click，
   * 和三格调文件 input 一个路数，React 那边无感）：
   *   文件 → button[aria-label="用 文件资源管理器 打开"]（找不到退 WgQWqa_main）
   *   反馈 / 下载 Session 日志 → 藏在"更多操作"官方菜单里，
   *     先替点"更多操作"开菜单，再点对应项（轮询 10x100ms，找不到就收工）
   * 按钮是 JS 插的（header 重渲染会清掉，靠 MutationObserver 补回来）；
   * 菜单是独立 fixed 白卡，不进 React 树。
   * 真名来源：browser-harness probe-selfdiag7/8（390x844 实测）。
   */
  const STASH_ROWS = [
    ['文件', 'file'],
    ['反馈', 'feedback'],
    ['下载 Session 日志', 'sessionlog'],
  ];
  const STASH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3.5" y="7" width="17" height="13" rx="2.5"/>' +
    '<path d="M3.5 7l1.6-3h13.8l1.6 3"/>' +
    '<path d="M10 11.5h4"/></svg>';
  const stash = {
    btn: null,
    el: null,

    ensureBtn() {
      // 锚点改成「行尾那一格」：标题行右端永远是 headerCorner（右栏开关）。
      // 以前锚在成员 / 后台任务那两个状态标签后面 —— 它们随任务数变化，
      // 整行装不下时还会被挤出视口（探针 probe-header-variants 实测：状态标签
      // 一多，收纳钮落在 x=392..420，完全在屏外点不到）。
      // 插在 headerCorner 前面，就永远落在行尾、永远在屏内。
      // 认的是具体元素而不是容器尾巴 —— 容器长相每页不同，那是上一版
      // 收纳钮飘到左边压住汉堡键的原因。
      const corner = document.querySelector(
        "header[class*='_header'] [class*='_headerCorner']",
      );
      if (!corner || !corner.parentElement) {
        return this.btn && this.btn.isConnected ? this.btn : null;
      }
      if (this.btn && this.btn.isConnected && this.btn.nextElementSibling === corner) return this.btn;
      try {
        if (this.btn && this.btn.isConnected) this.btn.remove();
      } catch {
        /* noop */
      }
      this.btn = null;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ms-stash-btn';
      b.setAttribute('aria-label', '更多页头功能');
      b.innerHTML = STASH_SVG;
      // 元素级监听，不占 document click 名额（门禁只数 document 级）
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        stash.toggle();
      });
      // 紧跟行尾开关前面：同一行、永远在屏内
      corner.parentElement.insertBefore(b, corner);
      this.btn = b;
      return b;
    },
    ensureMenu() {
      if (this.el && this.el.isConnected) return this.el;
      const el = document.createElement('div');
      el.className = 'ms-stash';
      el.setAttribute('role', 'menu');
      el.setAttribute('aria-label', '更多页头功能');
      for (const [label, kind] of STASH_ROWS) {
        const r = document.createElement('button');
        r.type = 'button';
        r.className = 'ms-stash-row';
        r.textContent = label;
        r.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          stash.pick(kind);
        });
        el.append(r);
      }
      document.body.append(el);
      this.el = el;
      return el;
    },

    open() {
      const b = this.ensureBtn();
      if (!b) return;
      const el = this.ensureMenu();
      const r = b.getBoundingClientRect();
      el.style.top = Math.round(r.bottom + 8) + 'px';
      el.style.left = Math.max(8, Math.round(r.right - 200)) + 'px';
      root.setAttribute('data-ms-stash', '1');
      armImeGuard('menu', 4000);
    },

    close() {
      root.setAttribute('data-ms-stash', '0');
    },

    toggle() {
      if (root.getAttribute('data-ms-stash') === '1') this.close();
      else this.open();
    },

    pick(kind) {
      this.close();
      if (kind === 'file') {
        // 文件 = 右栏的工作区文件。直点官方文件按钮无头下连真点击都没反应
        // （probe-fileBC：可见 + 可信事件也打不开，原因不明，可能是要真机手势）。
        // 改走探针证实走得通的路（probe-selfdiag6）：先点"打开右侧边栏"，
        // 再自动点里面的"工作区文件"行，两步都是普通按钮点击。
        const openRb =
          [...document.querySelectorAll('button')].find(
            (b) => (b.getAttribute('aria-label') || '') === '打开右侧边栏',
          ) || document.querySelector('button[aria-label="用 文件资源管理器 打开"]');
        if (!openRb) return;
        try {
          openRb.click();
        } catch {
          return;
        }
        let n = 0;
        const t = setInterval(() => {
          n += 1;
          try {
            const row = [...document.querySelectorAll('button, [role="menuitem"]')].find(
              // 行里还带快捷键字样（"工作区文件 Ctrl + Alt + P"），只能包含匹配
              (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().indexOf('工作区文件') === 0,
            );
            if (row) {
              clearInterval(t);
              row.click();
            } else if (n > 10) {
              clearInterval(t);
            }
          } catch {
            clearInterval(t);
          }
        }, 150);
        return;
      }
      // 反馈 / 下载 Session 日志：藏在"更多操作"官方菜单里
      const more = document.querySelector('button[aria-label="更多操作"]');
      if (!more) return;
      const want = kind === 'feedback' ? '反馈' : '下载 Session 日志';
      try {
        more.click();
      } catch {
        return;
      }
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        try {
          // 菜单项也可能带快捷键/描述，全等匹配会落空（文件行就这么错过一次）
          const item = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')].find((el) =>
            (el.innerText || '').replace(/\s+/g, ' ').trim().includes(want),
          );
          if (item) {
            clearInterval(t);
            item.click();
          } else if (n > 10) {
            clearInterval(t);
          }
        } catch {
          clearInterval(t);
        }
      }, 100);
    },
  };

  // header 重渲染会清掉我们插的按钮，缺了就补回来；
  // 锚点后出现的官方按钮（比如后台任务栏）会让已建的按钮位置过时，
  // ensureBtn 内部会比对 previousElementSibling，不对就挪过去（只挪一次就收敛）。
  // 放心每次都调：位置对了就是两次 querySelector 的事，不碰 DOM。
  const stashObs = new MutationObserver(() => {
    try {
      stash.ensureBtn();
    } catch {
      /* noop */
    }
    // 回会话的过渡：输入卡一出现就撤淡出标记（CSS 160ms 淡回）
    try {
      if (document.querySelector('[class*="_card"]')) endLeaving();
    } catch {
      /* noop */
    }
    // 顺手同步右栏开关旗标（节流过，流式输出不怕）
    try {
      syncRbFlagThrottled();
    } catch {
      /* noop */
    }
    // 泛用层：收纳组（新面板行随时可能出现）+ 页面角色（换页就重打）
    try {
      syncToolsThrottled();
      classifyThrottled();
    } catch {
      /* noop */
    }
  });
  try {
    stashObs.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* noop */
  }
  // 启动时直接建一次：Observer 只管"之后"的变化，不管已经在的 DOM
  try {
    stash.ensureBtn();
  } catch {
    /* noop */
  }

  // 点外面关收纳菜单（pointerdown 监听不占 click 门禁名额）
  document.addEventListener(
    'pointerdown',
    (e) => {
      try {
        if (root.getAttribute('data-ms-stash') !== '1') return;
        if (e.target && e.target.closest && e.target.closest('.ms-stash, .ms-stash-btn')) return;
        stash.close();
      } catch {
        /* noop */
      }
    },
    true,
  );

  // 右栏开关跟进：点"打开/收起右侧边栏"（手动点和第 5b 层程序点都会经过
  // 分发器）后，面板是滑进滑出的动画，立刻量还在半路上；
  // 350ms + 1000ms 后各确认一次，保证旗标最终和动画结束状态一致。
  // 注册走分发器数组，不新增 document 监听（门禁只数 document 级）。
  onClickCapture('rb-flag-followup', (e) => {
    try {
      const t =
        e.target &&
        e.target.closest &&
        e.target.closest('button[aria-label="收起右侧边栏"], button[aria-label="打开右侧边栏"]');
      if (!t) return;
      setTimeout(() => {
        try {
          syncRbFlag();
        } catch {
          /* noop */
        }
      }, 350);
      setTimeout(() => {
        try {
          syncRbFlag();
        } catch {
          /* noop */
        }
      }, 1000);
    } catch {
      /* noop */
    }
  });

  /*
   * 右栏开着时藏起汉堡键（.ms-toggle）。
   *
   * 右栏全屏盖住会话时左上角那个 fixed 汉堡还浮在上面正好压住右栏首栏
   * 第一个标签（真机截图：≡ 盖住"上下文 / 开始"）。抽屉不受影响：
   * 左缘右滑照样开返回键照常先关右栏（第 5b 层）。
   * 只在尺寸变化时写一次标记（ResizeObserver）不轮询；
   * 节点还没出来时靠已有的 stashObs 顺手看一眼（它本来就全量观察）。
   * 2026-10-21 修正：容器宽度恒为 0，RO 永远不触发，已删；
   * 改判收起按钮在不在屏内（开 @x=356 / 关 @x=746），由 stashObs 带过来，
   * 500ms 节流，流式输出不怕。
   */
  let rbFlagAt = 0;
  const syncRbFlag = () => {
    try {
      // 开关信号不用容器宽度（右栏容器永远是 0 宽，内容在透传层里）：
      // 用收起按钮在不在屏内判断。开：收起 @x=356；关：收起 @x=746（屏外）。
      // 探针实锤（probe-rbdirect）：容器 0 宽时面板照样开着，按钮位置才是真凭据。
      const btn = document.querySelector('button[aria-label="收起右侧边栏"]');
      let open = false;
      if (btn) {
        const r = btn.getBoundingClientRect();
        const vw = window.innerWidth || 390;
        open = r.width >= 4 && r.left >= 0 && r.left < vw;
      }
      const want = open ? '1' : '0';
      if (root.getAttribute('data-ms-rb') !== want) root.setAttribute('data-ms-rb', want);
    } catch {
      /* noop */
    }
  };
  // 节流调用：observer 每批 DOM 变动都会跑，里面有 getBoundingClientRect，
  // 不节流的话流式输出时每来一个字就强制同步布局一次。
  const syncRbFlagThrottled = () => {
    const now = Date.now();
    if (now - rbFlagAt < 500) return;
    rbFlagAt = now;
    syncRbFlag();
  };
  try {
    syncRbFlag();
  } catch {
    /* noop */
  }

  /*
   * 菜单开着时，消息列表里的点按只负责关菜单，不许顺手打开链接。
   *
   * 背景：键盘开合会让布局来回伸缩，+ 和消息里的文件链接会在点按瞬间重合
   * （真机：第二次点 + 有很大机率打开 `button.pFy1Ka_fileLink` 这类链接）。
   * 官方菜单在 pointerdown 时就收了，但随后的 click 还是落到链接上 → 直接跳转。
   * 这里在捕获阶段把这一类 click 吃掉：菜单照关，链接不跳。
   * 菜单体系内（菜单 / 三格 / 输入卡 / 侧栏 / 开关遮罩）的点按一律放行，
   * 菜单没开时这段逻辑一行都不跑。
   */
  onClickCapture('content-swallow-when-menu-open', (e) => {
    if (root.getAttribute('data-ms-rack') !== '1') return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (
      t.closest(
        '[class*="_overlayAnchor"], [class*="_menu"], .ms-rack, [class*="_card"], [class*="_composerSeat"], [class*="sidebarCol"], .ms-toggle, .ms-scrim',
      )
    )
      return;
    if (!t.closest('[class*="scrollBody"], main, [role="main"]')) return;
    e.stopPropagation();
    e.preventDefault();
    // 关了抽屉必须一起清 attach：只 hide 的话 + 还是 ×，下一次 syncRack
    // 看到菜单节点还在就会把抽屉又弹回来（就是「点正文关了、过一下自己又开了」）。
    root.removeAttribute('data-ms-attach');
    attachRack.hide();
  });
  document.addEventListener('pointerdown', markPointer, true);
  document.addEventListener('touchstart', markPointer, true);

  /*
   * 点按落点漂移的兜底。
   *
   * 机制：手指按下（pointerdown）到抬起（click）之间，只要布局变过一次——
   * 收/弹键盘、图片撑开、流式输出把内容顶上去——浏览器会在 touchend 重新做一次
   * hit-test，click 就落到**新位置**的元素上。用户按的还是原来那块屏幕区域，
   * 但那里已经换成别的元素了。真机上的三种表现全从这里来：
   *   - 点按钮却打开文件（文件链接是消息里最宽的可点元素，九成误跳进它）；
   *   - 点 + 却把焦点落进输入框 → 键盘被拉起 → 又被收掉（闪一下）；
   *   - 点 + 却因为落点跑到别处，面板的 click 干脆丢事件（只收键盘、面板没反应）。
   *
   * 判据只看一件事：按下的那一刻命中的是不是这个目标（或它的祖先/后代）。
   * 是 → 用户真要它，放行；不是 → 漂移，吃掉。
   * 只拦两类「漂移后最容易被误触」的目标：文件链接、可编辑输入区。
   * 其它元素一律不动，免得吞掉正常点击（点 svg 命中 button 这类）。
   */
  onClickCapture('tap-shift-guard', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (!downHitEl || !downHitEl.closest) return; // 拿不到按下点就保守放行
    const link = t.closest('[class*="fileLink"]');
    // 注意：`isContentEditable === true` 时 el 是 **布尔**，不能直接当元素用
    // （老写法 risky 会是 true，risky.contains 直接抛错，整个守卫静默失效）。
    const editorEl = t.isContentEditable === true ? t : t.closest('[contenteditable="true"]');
    const risky = link || editorEl;
    if (!risky) return;
    if (downHitEl === risky || risky.contains(downHitEl) || downHitEl.contains(risky)) return;
    // 按下的位置在它自己的行里，也算真想点，别误伤
    try {
      const row = risky.closest('[class*="row"]') || risky;
      if (row && row.contains(downHitEl)) return;
    } catch {
      /* noop */
    }
    e.stopPropagation();
    e.preventDefault();
  });

  function isEditor(el) {
    return !!el && (el.isContentEditable === true || el.tagName === 'TEXTAREA');
  }

  // ---- 键盘开着时，滚动会话内容就把键盘收掉 ----
  //
  // 上一版为什么完全没反应（真机实测，滚几百像素都不收）：
  // 判据用的是 data-ms-kb === '1'，而那个标记只有在 visualViewport 比窗口矮时才置。
  // **App 里是 adjustResize，窗口跟着键盘一起变矮**，innerHeight 和 vv.height 同时缩，
  // 差值≈0 → k=0 → 标记永远是 '0' → 这段逻辑一次都没跑过。
  // 浏览器里能看到标记，App 里看不到，所以只有真机暴露出来。
  //
  // 现在不再看那个标记：**输入框有焦点就当作键盘开着**（手机上没有硬件键盘时这个等价）。
  // 同时听两路事件，哪一路先到都算：
  //   touchmove —— 手指一拖就触发，不依赖「内容真的滚动了」（列表到底了还在拖也算）
  //   scroll    —— 鼠标滚轮 / 程序化滚动 / 惯性滚动收尾
  // 排除输入框自己那块：在草稿里上下拖不该收键盘。
  //
  // 还有一条更重要的：**scroll 不能见着就收**。流式输出时内容一直在长，
  // 页面自己往下滚，scroll 一秒钟几十次 —— 用户只是看着回答，键盘却被它收掉
  // （真机实测：输出阶段输入法反复自动关闭）。所以 scroll 只认「刚有手指或滚轮
  // 动过」的那几百毫秒，程序自己滚的一律不算。
  let touchStartY = 0;
  let touchOnComposer = false;
  let lastDismissAt = 0;
  let editorFocusAt = 0;
  let userScrollAt = 0;

  function dismissKeyboardByScroll() {
    const active = document.activeElement;
    if (!isEditor(active)) return;
    // 刚聚焦的前 700ms 不动：浏览器聚焦时自己会滚一次把输入框露出来，
    // 那一下不能当成「用户在翻历史」（这条是上一版唯一做对的地方，保留）
    if (Date.now() - editorFocusAt < 700) return;
    if (Date.now() - lastDismissAt < 300) return;
    lastDismissAt = Date.now();
    try {
      active.blur();
    } catch {
      /* noop */
    }
  }

  const inComposer = (el) =>
    !!el && !!el.closest && !!el.closest('[class*="_card"], [class*="_composerSeat"], input[type="file"]');

  document.addEventListener(
    'focusin',
    (e) => {
      if (isEditor(e.target)) editorFocusAt = Date.now();
    },
    true,
  );

  document.addEventListener(
    'touchstart',
    (e) => {
      if (!isEditor(document.activeElement)) return;
      const t = e.touches[0];
      if (!t) return;
      touchStartY = t.clientY;
      touchOnComposer = inComposer(e.target);
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (touchOnComposer) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientY - touchStartY) < 12) return;
      userScrollAt = Date.now();
      dismissKeyboardByScroll();
    },
    { capture: true, passive: true },
  );

  // 滚轮 / 触控板：只有人手真的在动才算用户滚动
  document.addEventListener(
    'wheel',
    () => {
      userScrollAt = Date.now();
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'scroll',
    (e) => {
      if (!isEditor(document.activeElement)) return;
      if (inComposer(e.target)) return;
      // 流式输出、滚动到底吸附、动画滚动 —— 都没有手指/滚轮参与，不算
      if (Date.now() - userScrollAt > 400) return;
      dismissKeyboardByScroll();
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (!isEditor(t)) return;
      if (Date.now() < allowAutoFocusUntil) return;
      const tapped = lastPointerTarget;
      const recent = Date.now() - lastPointerAt < 900;
      const fromTap =
        !!tapped && recent && (tapped === t || t.contains(tapped) || (tapped.contains && tapped.contains(t)));
      if (fromTap) return;

      // 只有「在侧栏里点了一下、然后输入框自己抢焦点」才算导航引起的自动聚焦。
      // 点 + / 点菜单 / 点工具条之类的，焦点变化是用户操作的一部分，别去动它
      // —— 动了会把刚打开的命令菜单一起关掉（实测）。
      const navTap = !!tapped && !!tapped.closest && !!tapped.closest('[class*="sidebarCol"], [class*="sidebarRow"], [class*="sessionRow"], [class*="panelRow"]');
      if (!navTap && recent) return;

      // 剩下的就是导航后的自动聚焦：撤掉焦点，键盘就不会弹
      try {
        t.blur();
      } catch {
        /* noop */
      }
    },
    true,
  );

  // ---- 额度面板定位 ----
  // 插件（dsh-opencode-go）的药丸点开后面板是绝对定位，手机宽度下会跑到屏幕外。
  // 这里在点药丸的瞬间按它的位置算出面板该停在哪：底部贴着药丸上沿 8px。
  // 只写一个 CSS 变量，面板怎么画还是插件自己的事。
  onClickCapture('quota-pill-position', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const pill = t.closest('[class*="_root"]');
    if (!pill) return;
    const trigger = pill.querySelector('[class*="_trigger"]') || pill;
    const r = trigger.getBoundingClientRect();
    if (r.height === 0) return;
    root.style.setProperty('--ms-panel-bottom', Math.round(window.innerHeight - r.top + 8) + 'px');
  });

  // ---- 键盘高度 ----
  //
  // 只计算键盘 inset 并写 --ms-kb-inset，**不锁 html/body 高度**——
  // 之前把 visualViewport 高度写进 --ms-vvh 并强制到整条高度链上，
  // 手机浏览器工具栏一抖，输入框整条被压没（实测事故）。
  //
  // 补偿量不能直接等于键盘高度：浏览器聚焦时自己也会滚一次，
  // 两边一起补就把输入框顶到键盘上方很远，中间留一大片空白（实测）。
  // 现在只补差额：先看输入区实际露出来多少，缺多少补多少。
  //   pad = (当前底边 + 已补的量) - 可视区底边      // 去掉补偿后它会掉到哪
  // 浏览器已经露出来的情况，这个值就是 0，一点空白都不会多出来。
  //
  // 另外两条是给卡顿的：事件回调里只记一个标记，真正的读写放到
  // requestAnimationFrame 里，并且键盘高度没变化时直接跳过 ——
  // 键盘弹起动画会连着触发几十次 resize/scroll，每次都写 CSS 变量
  // 等于每次都让整页重算样式。
  const vv = window.visualViewport;
  let kbPad = 0;
  let kbTimer = 0;
  let kbOpenedAt = 0;

  /** 输入区（输入框 + 底部状态条）。 */
  function composerBox() {
    return (
      document.querySelector('[class*="_root"]') ||
      document.querySelector('input[type="file"]')?.closest('div[class]') ||
      null
    );
  }

  function applyKeyboard() {
    const zoomed = vv ? Math.abs(vv.scale - 1) > 0.01 : false;
    const raw = vv && !zoomed ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    const k = raw > 80 ? Math.round(raw) : 0;

    if (k === 0) {
      if (kbPad === 0 && root.getAttribute('data-ms-kb') === '0') return;
      kbPad = 0;
      root.style.setProperty('--ms-kb-inset', '0px');
      root.setAttribute('data-ms-kb', '0');
      return;
    }

    const el = composerBox();
    const viewBottom = vv.height + vv.offsetTop;
    // 只补差额，且不超过键盘高度（超过说明量错了，宁可不补）
    const deficit = el === null ? k : el.getBoundingClientRect().bottom + kbPad - viewBottom;
    const pad = Math.max(0, Math.min(k, Math.round(deficit)));

    const wasKb = root.getAttribute('data-ms-kb') === '1';
    root.setAttribute('data-ms-kb', '1');
    if (!wasKb) kbOpenedAt = Date.now();
    if (pad === kbPad) return;
    kbPad = pad;
    root.style.setProperty('--ms-kb-inset', pad + 'px');
  }

  // 键盘弹起/收起的动画会连发几十次 resize，这里统一防抖：
  // 停 120ms 才算一次，等动画结束再校一次（那时布局才稳定）。
  function queueKeyboard() {
    if (kbTimer) clearTimeout(kbTimer);
    kbTimer = setTimeout(() => {
      kbTimer = 0;
      applyKeyboard();
      setTimeout(applyKeyboard, 260);
    }, 120);
  }

  if (vv) {
    vv.addEventListener('resize', queueKeyboard, { passive: true });
    vv.addEventListener('scroll', queueKeyboard, { passive: true });
  }
  window.addEventListener('resize', queueKeyboard, { passive: true });
  window.addEventListener('orientationchange', () => {
    setTimeout(queueKeyboard, 200);
  });
  queueKeyboard();

  // ---- 底部状态条：只留最关心的两个数 ----
  //
  // 官方的状态条是三颗药丸，文字很长，390 宽下第一颗被截成
  // 「34 轮 760 步 ·…」，正好把 tok/s 截掉，第二颗的缓存命中率也一样。
  // 这里不碰它的文字节点（那是 React 管的），只把整理后的短文本写进
  // 自己的 data-ms-stat 属性，由 CSS 用 ::after 显示、把原标签藏起来。
  // 原文仍保留在 aria-label 里，读屏和点开的详情面板不受影响。
  const STAT_RULES = {
    // "34 轮 760 步 · 212 tok/s" -> "212 tok/s"
    activity: (label) => {
      const m = /([\d.]+)\s*tok\/s/i.exec(label);
      return m ? `${m[1]} tok/s` : null;
    },
    // "212M tok · 缓存命中 99%" -> "缓存 99%"
    usage: (label) => {
      const m = /缓存命中\s*([\d.]+%)/.exec(label);
      return m ? `缓存 ${m[1]}` : null;
    },
  };

  function syncStats() {
    for (const holder of document.querySelectorAll('[data-composer-stat]')) {
      const kind = holder.getAttribute('data-composer-stat');
      const pill = holder.querySelector('button');
      if (!pill) continue;
      const rule = STAT_RULES[kind];
      const short = rule ? rule(pill.getAttribute('aria-label') || '') : null;
      if (short === null) pill.removeAttribute('data-ms-stat');
      else if (pill.getAttribute('data-ms-stat') !== short) pill.setAttribute('data-ms-stat', short);
    }
  }

  // 状态条在自己更新（aria-label 变化），盯住它比轮询及时
  let statsObserver = null;
  let statsHost = null;
  function watchStats() {
    const host = document.querySelector('[data-composer-stat]')?.parentElement ?? null;
    if (host === statsHost) return;
    statsHost = host;
    if (statsObserver) statsObserver.disconnect();
    statsObserver = null;
    if (host === null || typeof MutationObserver !== 'function') return;
    statsObserver = new MutationObserver(() => {
      if (pendingStats) return;
      pendingStats = true;
      requestAnimationFrame(() => {
        pendingStats = false;
        syncStats();
      });
    });
    statsObserver.observe(host, { subtree: true, attributes: true, attributeFilter: ['aria-label'] });
  }
  let pendingStats = false;

  // 状态条与清理：改成「启动 + 导航时」触发，不再 1 秒轮询。
  //
  // 原来这里是一个永久 setInterval(1000)，做三件其实不需要轮询的事：
  //   1. 删旧版残留的 .ms-attach —— 只可能出现在启动那一刻；
  //   2. watchStats() 重新挂观察器 —— 只在输入卡被重建（导航）时需要；
  //   3. syncStats() —— 已经被 aria-label 的 MutationObserver 覆盖。
  // 现在：启动跑一次，导航（任何点击）后补一次，再留两个迟到的一次性补漏。
  attach.ensure();
  syncStats();
  watchStats();
  const refreshStats = () => {
    attach.ensure();
    watchStats();
    syncStats();
  };
  onClickBubble('stats-refresh', () => setTimeout(refreshStats, 60));
  [1500, 4500, 9000].forEach((d) => setTimeout(refreshStats, d));

  // ---- 方案 B：外壳直接绑 visualViewport（`?msvp=1` 试用）----
  //
  // 通用做法，而不是拿键盘高度去补：把应用外壳的高度设成「真正可见的高度」
  // （visualViewport.height），键盘怎么变、换什么输入法、有没有工具栏行，
  // 都只是改这个数。iOS 那种不缩布局视口的也盖住。
  // 默认不开，先用参数试；确认没问题再切成默认。
  if (new URLSearchParams(location.search).get('msvp') === '1') {
    root.setAttribute('data-ms-vp', '1');
    const syncVp = () => {
      if (!vv) return;
      root.style.setProperty('--ms-vv-h', Math.round(vv.height) + 'px');
      root.style.setProperty('--ms-vv-top', Math.round(vv.offsetTop) + 'px');
    };
    if (vv) {
      let raf = 0;
      const queue = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          syncVp();
        });
      };
      vv.addEventListener('resize', queue, { passive: true });
      vv.addEventListener('scroll', queue, { passive: true });
      window.addEventListener('resize', queue, { passive: true });
    }
    syncVp();
  }

  // ---- 排障用的读数（只有带 ?msdebug=1 才出现）----
  // 键盘/视口这类问题在无头浏览器里复现不了，出问题时让用户截个图就能定位。
  if (new URLSearchParams(location.search).has('msdebug')) {
    const badge = document.createElement('div');
    badge.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:2000;padding:6px 8px;border-radius:8px;' +
      'background:rgba(0,0,0,.8);color:#fff;font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre;pointer-events:none';
    document.body.append(badge);
    const draw = () => {
      const el = composerBox();
      const b = el ? el.getBoundingClientRect() : null;
      const vh = vv ? vv.height : 0;
      const vt = vv ? vv.offsetTop : 0;
      badge.textContent = [
        `innerH ${innerHeight}  vv ${Math.round(vh)}+${Math.round(vt)}`,
        `kbPad ${kbPad}  kbFlag ${root.getAttribute('data-ms-kb')}`,
        `composer ${b ? Math.round(b.bottom) : '?'}  viewBottom ${Math.round(vh + vt)}`,
        `deficit ${b ? Math.round(b.bottom + kbPad - (vh + vt)) : '?'}`,
      ].join('\n');
    };
    setInterval(draw, 300);
    draw();
  }

  // 输入框获得焦点时收起抽屉：只写我们自己的状态，别碰官方开关。
  //
  // 这里以前是裸 ui.toggle() 翻转，是“闪一下”的根因：
  // 导航回来时官方侧栏经常处在“展开但被 CSS 藏起”的状态，
  // 翻转会先把它翻出来（抽屉滑出）再收回去（抽屉滑走），用户看到的就是左栏闪一下。
  // 现在只做两件事：意图置否 + 属性写死关闭，官方开着就开着，反正看不见。
  //
  // 2026-10-25 补：左栏自己的输入控件（搜索会话、筛选）不能算「你要去聊天」。
  // 之前没排除，点搜索框就收抽屉 → 官方左栏塌陷 → 会话列表和搜索框整块卸载再重建，
  // 用户看到的就是「白屏一下、元素解构重组」，而且搜索根本没法用。
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    // 左栏范围：槽位锚点，或者那个装着 sidebar 槽位的列
    const inSidebar = !!t.closest("[data-slot='sidebar'], div:has(> [data-slot='sidebar'])");
    if (inSidebar) return;
    if (t.closest('input, textarea, [contenteditable]')) {
      // 埋点：确认到底是谁把抽屉关了。手机上若搜索框是 portal 到左栏之外，
      // 这条会记成 inSidebar=0，一眼就能看出来。
      try {
        reportDiag('focus-close', {
          tag: t.tagName,
          c: t.getAttribute('data-ms-c') || '',
          inSidebar: inSidebar ? 1 : 0,
        });
      } catch {
        /* noop */
      }
      closeDrawerState('focusin');
    }
  });

  // ---- 回车只换行，不发送 ----
  //
  // 发送只认右边那颗发送键。做法是在捕获阶段把 Enter 的传播拦掉（**不** preventDefault），
  // 官方那条「Enter 发送」的处理器收不到事件，而浏览器自己照样插入换行。
  // 输入法组合中的回车（中文选字）必须放行，否则打不出字。
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      const t = e.target;
      if (!t) return;
      const isEditor =
        t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text');
      if (!isEditor) return;
      e.stopPropagation();
    },
    true,
  );

  // ---- 计划徽章的排版 ----
  //
  // 官方那颗「计划」药丸没有 white-space:nowrap（见 dsh-client-ui-plan 的
  // `._xxx_chip`），窄屏工具条一挤，两个字就被压成竖排、还被裁掉一半。
  // 这里按文字找到它、打上自己的标记，样式在 mobile.css 里给（不改官方类名，
  // 因为类名带构建哈希，升级就变）。
  function scanPlanChip() {
    try {
      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return;
      // 从输入框往上找几层，圈住整个输入卡片；+ 菜单的浮层在 portal 里，不会被误伤
      let box = ed;
      for (let i = 0; i < 8 && box.parentElement; i += 1) box = box.parentElement;
      const btns = box.querySelectorAll('button[aria-label]');
      for (const b of btns) {
        if (b.hasAttribute('data-ms-plan')) continue;
        const text = (b.textContent || '').trim();
        const aria = b.getAttribute('aria-label') || '';
        if (text !== '计划' && text !== 'Plan' && !/计划模式|plan mode/i.test(aria)) continue;
        b.setAttribute('data-ms-plan', '');
        const seat = b.parentElement;
        if (seat && seat.children.length <= 2) seat.setAttribute('data-ms-plan-seat', '');
      }
    } catch {
      /* noop */
    }
  }

  let planScanTimer = 0;
  const queuePlanScan = () => {
    if (planScanTimer) return;
    planScanTimer = setTimeout(() => {
      planScanTimer = 0;
      scanPlanChip();
    }, 180);
  };
  onClickCapture('plan-scan', queuePlanScan);
  document.addEventListener('keyup', queuePlanScan, true);
  setTimeout(scanPlanChip, 1500);
  setTimeout(scanPlanChip, 4500);

  // ---- 安卓壳的返回键 ----
  //
  // 壳里按返回键时，原生先问这里：能处理就返回 true，处理不了交给原生（后退/出菜单）。
  // 浏览器里没有任何地方调用它，行为完全不变。
  //
  // 顺序就是「由浅入深」，和用户心里的层数一致：
  //   附件面板 → 弹窗 → 浮层菜单 → 抽屉 → 页面里的返回按钮 → 回最近会话 → 交给原生
  //
  // 第六层：面板页（插件 / 自动化 / 上下文）不属于任何会话，
  // 在那里按返回原来是直接落到原生（App 直接退出）。现在改成先回最近一次会话。
  // 同一层还管文件查看器这类全屏浮层：输入框还在 DOM 里（判据 A 拦不住它），
  // 它自己又没有返回按钮，不接住的话返回键直接退出 App，用户就被关在里面了。
  //
  // 外来浮层的判定（foreignOverlay）：fixed 定位、盖住 70% 以上视口、
  // 不是我们自己的东西（抽屉、三格、遮罩、命令菜单、弹窗都不算，那些前面几层管）。
  function foreignOverlay() {
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const ours = (el) =>
      !!el.closest &&
      !!el.closest(
        '.ms-rack, .ms-scrim, .ms-toggle, [class*="sidebarCol"], [class*="_overlayAnchor"], [class*="_menu"], [role="dialog"], [role="menu"]',
      );
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      let cs = null;
      try {
        cs = getComputedStyle(el);
      } catch {
        continue;
      }
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (Number(cs.opacity) <= 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.7 || r.height < vh * 0.7) continue;
      if (ours(el)) continue;
      return el;
    }
    return null;
  }
  window.__msBack = () => {
    // 每次按键先清上一发的命中记录，排查时只看这一次。
    try {
      window.__msBackHit = '';
    } catch {
      /* noop */
    }
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    // 在屏内：visible 只看尺寸样式，不管位置。右栏关着时它的收起键停在
    // x=746（屏外）照样算"可见"，返回键会被它吞掉还什么都不发生。
    // 点之前必须确认真在屏内（和屏有交集就算，半露出的也认）。
    const inView = (el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 390;
      const vh = window.innerHeight || 844;
      return r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
    };
    // 调试用：这次返回键被哪一层吃掉（0=没吃，交给原生）
    const hit = (n) => {
      try {
        window.__msBackLayer = n;
      } catch {
        /* noop */
      }
      // 落一条诊断：右栏里开网页时返回键"没反应"，需要知道它到底被哪层吃掉、
      // 页面上有没有 iframe（网页面板几乎都是 iframe 渲染的）。
      try {
        reportDiag('back', {
          layer: n,
          hit: String(window.__msBackHit || '').slice(0, 50),
          ifr: [...document.querySelectorAll('iframe')].filter((el) => inView(el)).length,
          act: (document.activeElement && document.activeElement.tagName) || '',
        });
      } catch {
        /* noop */
      }
      return true;
    };
    const esc = () => {
      const ev = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      try {
        if (document.activeElement) document.activeElement.dispatchEvent(ev());
      } catch {
        /* noop */
      }
      document.dispatchEvent(ev());
    };

    try {
      // 1. 三格浮层（原第 1 层的旧底部面板已删除，三格现在是独立浮层，由菜单驱动）
      if (root.getAttribute('data-ms-rack') === '1') {
        closeCommandMenu();
        return hit(1);
      }
      if (root.getAttribute('data-ms-stash') === '1') {
        stash.close();
        return hit(1);
      }

      // 2. 弹窗（设置、确认框之类）—— 先按 Esc，官方弹窗都认
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible);
      if (dialogs.length) {
        esc();
        return hit(2);
      }

      // 3. 浮层菜单
      if ([...document.querySelectorAll('[role="menu"]')].some(visible)) {
        esc();
        return hit(3);
      }

      // 4. 抽屉：只认我们自己的 data-ms-drawer，不认官方展开态。
      //    官方侧栏经常处在“展开但被 CSS 藏起”的状态（导航后残留），
      //    如果按官方态收 User 按返回键会吞掉一次按键还什么都不发生 ——
      //    用户看到的就是“插件页按返回没反应”。只有可视状态下开着的抽屉才需要关。
      if (root.getAttribute('data-ms-drawer') === 'open') {
        ui.toggle(false);
        return hit(4);
      }

      // 5. 页面自己带返回按钮的（面板的二级页、详情页）
      //
      //    以前只认 aria-label/title，且必须以「返回/后退/back」开头。
      //    实测两个反例（2026-10-24 真机反馈"工具二级/三级页返回直接掉回会话"）：
      //      - 技能中枢详情（dsh-curator）：.ss-back 只有文本「‹ 返回技能列表」，
      //        没有 aria-label/title → 漏；
      //      - 自动化任务详情：右上角是关闭 X，aria-label 是「关闭」，不是「返回」→ 漏。
      //    两者于是掉进第 6 层，被当成"工具首页"直接送回会话页。
      //
      //    所以名字统一取 aria-label || title || innerText，并允许前面带 ‹ / ← / <。
      //
      //    判据仍然要严，否则会误点会话正文里的链接：
      //      a) 只认 button / [role=button]，**不认 <a>**（正文链接全是 a）；
      //      b) 必须真在屏内，且在页头区（top < 220）—— 返回/关闭入口都在顶部。
      const controlName = (el) =>
        ((el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '') + '')
          .replace(/\s+/g, ' ')
          .trim();
      const isBackName = (s) => /^[‹<←\s]*(返回|后退|back\b|go back)/i.test(s);
      const isCloseName = (s) => /^(关闭|close|关闭详情|关闭面板)$/i.test(s);
      const topControls = [...document.querySelectorAll('button, [role="button"]')].filter((el) => {
        if (!inView(el)) return false;
        return el.getBoundingClientRect().top < 220;
      });
      const backBtn = topControls.find((el) => isBackName(controlName(el)));
      if (backBtn) {
        backBtn.click();
        try {
          window.__msBackHit = 'back:' + controlName(backBtn).slice(0, 40);
        } catch {
          /* noop */
        }
        return hit(5);
      }

      // 5a. 详情页的关闭 X（自动化任务详情）：名字是「关闭」，不是「返回」。
      //     只在 detail 容器里认，避免把别处的「关闭」当成"返回上一级"。
      const closeBtn = topControls.find((el) => {
        if (!isCloseName(controlName(el))) return false;
        return !!el.closest('[class*="detail"], [class*="Detail"]');
      });
      if (closeBtn) {
        closeBtn.click();
        try {
          window.__msBackHit = 'close:' + controlName(closeBtn).slice(0, 40);
        } catch {
          /* noop */
        }
        return hit(5);
      }

      // 5b. 右栏面板（工作区文件 / 文件查看 / 上下文…）：点它自己的收起键。
      //    探针实锤（browser-harness probe-selfdiag6，无头 Chrome 390x844）：
      //    右栏开着时 rightbarCol 容器仍是 0 宽（内容在 display:contents 透传层里，
      //    行内容直接画在屏上：工作区文件 @25,269…），输入卡片也还在 DOM 里，
      //    所以第 6 层的两个条件全被骗过 → 返回键掉进原生。
      //    收起键真名是「收起右侧边栏」（右上角 @356,10），只认这个精确名字，
      //    不放宽（第 5 层吃过正则太松的亏），而且必须真在屏内（关着时它停在
      //    x=746 屏外，visible() 会误判）。会话本来就在底下，关掉即回。
      const rbClose = [...document.querySelectorAll('button[aria-label="收起右侧边栏"]')].find((el) =>
        inView(el),
      );
      if (rbClose) {
        rbClose.click();
        return hit(5);
      }

      // 5c. 右栏/浮层里打开的是**网页**（iframe）：让网页自己回退一步。
      //     用户 2026-10-27：「右栏中打开的是网页的话 返回键失效」。
      //     这种网页面板没有「收起右侧边栏」那种按钮，第 5/5b 层都找不到东西点，
      //     第 6 层又因为会话输入卡还在 DOM 里而拦不住 → 什么都不发生。
      //     跨域 iframe 读不到 history，读不到就跳过，交给后面/原生。
      const webFrame = [...document.querySelectorAll('iframe')]
        .filter((el) => inView(el))
        .find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 200 && r.height > 200;
        });
      if (webFrame) {
        let moved = false;
        try {
          const w = webFrame.contentWindow;
          if (w && w.history && w.history.length > 1) {
            w.history.back();
            moved = true;
          }
        } catch {
          /* 跨域：读不到就跳过 */
        }
        if (moved) {
          try {
            window.__msBackHit = 'webframe-back';
          } catch {
            /* noop */
          }
          return hit(7);
        }
      }

      // 6. 面板页 / 全屏外来浮层 → 回最近一次会话。
      //    判据 A：页面上没有输入卡片（会话页一定有，面板页没有）。
      //    判据 B：有个外来的全屏浮层盖着（文件查看器这类：输入框还在 DOM 里，
      //    所以判据 A 拦不住它；它自己又没有返回按钮）。
      if (!document.querySelector('[class*="_card"]') || foreignOverlay()) {
        // 面板页 → 会话页：按下就先给一条"正在回去"的反馈（内容区淡下去），
        // 输入卡一出现立刻撤掉（CSS 160ms 淡回）。那 ~1 秒是 host 重新载入
        // 会话，遮不住；但能把它从"卡死→硬切"变成"滑走→淡入"。
        leaveToSession();
        if (returnToLastSession()) return hit(6);
        endLeaving(); // 回不去就立刻撤销，别把人留在半透明页面上
      }
    } catch {
      /* 出错就当没处理，交给壳自己的逻辑 */
    }
    hit(0);
    return false;
  };

  /*
   * 回到最近一次会话。
   *
   * 难点：侧栏收起时官方**根本不渲染会话行**（实测面板页 DOM 里 0 条 sessionRow），
   * 所以不能直接点。但官方侧栏展不展开，和抽屉开不开是两回事：
   * 我们的抽屉只认 data-ms-drawer，CSS 里 closed 一律把侧栏推出屏外
   * （`[data-drawer='closed'] [class*='sidebarCol']`）。所以可以偷偷把官方侧栏
   * 展开一次拿到会话行，点完再收回去 —— 用户屏幕上什么都不会闪。
   *
   * 「最近一次会话」用官方自己的选中标记（sessionRow + selected），
   * 那是 App 眼里的当前会话；没有选中标记时退回列表第一条。
   */
  /*
   * 面板页 → 会话页的过渡标记。
   * 那 ~1 秒是 host 重新载入会话，遮不住；能做的是「按下立刻有反应」：
   * 内容区 120ms 淡到 35%，输入卡一出现就撤标记（CSS 160ms 淡回）。
   * 只用 opacity —— transform/filter 会给 fixed 后代换包含块，
   * 把输入卡和三格浮层一起带偏。
   */
  let leavingTimer = 0;
  function leaveToSession() {
    try {
      root.setAttribute('data-ms-leaving', '1');
      clearTimeout(leavingTimer);
      // 兜底：8 秒还没回来 = 跳转失败，把标记撤掉，不能把人锁在灰屏里
      leavingTimer = setTimeout(() => root.removeAttribute('data-ms-leaving'), 8000);
    } catch {
      /* noop */
    }
  }
  function endLeaving() {
    try {
      if (root.getAttribute('data-ms-leaving') !== '1') return;
      clearTimeout(leavingTimer);
      root.removeAttribute('data-ms-leaving');
    } catch {
      /* noop */
    }
  }

  /**
   * 从插件页（工具页等）回到"刚才那条会话"。
   *
   * 2026-10-26 前的实现有两个错：
   *   1) 只按 `[class*="sessionRow"]` 找「selected 或第一行」——抽屉收着时官方**根本不渲染行**，
   *      于是它去开抽屉、拿到第一行点下去：用户从「主任务」进工具页再返回，落到了「你好」。
   *   2) 全程靠点 DOM，抽屉会闪。
   *
   * 现在：目标会话从官方数据里读（localStorage `dsh.sessions.current` / `[data-conversation-session]`，
   * 实测在工具页期间都还在），切会话走宿主桥 `__msHostOpenSession`（官方 openSession），
   * 只有桥不可用才退回点 DOM —— 且必须点**记住的那一行**，绝不点"第一行"。
   */
  function returnToLastSession() {
    const target = currentSessionId();
    const rows = () => [...document.querySelectorAll('[data-ms-c~="sessionRow"], [class*="sessionRow"]')];

    // 1) 先走官方导航（不碰抽屉）
    if (target) {
      // hostOpenSession 是 async，但这里要同步返回"这次返回键被消费了"
      hostOpenSession(target)
        .then((ok) => {
          if (ok) {
            reportDiag('back-session', { how: 'host' });
            return;
          }
          // 桥切不过去：退回点行（仍然只点记住的那一行）
          if (!clickRememberedRow(target)) reportDiag('back-session', { how: 'host-fail' });
        })
        .catch(() => {
          if (!clickRememberedRow(target)) reportDiag('back-session', { how: 'host-throw' });
        });
      return true;
    }

    // 2) 没有目标 id：退到老逻辑（选中行优先，其次第一行）
    const pick = () => {
      const all = rows();
      if (!all.length) return null;
      return all.find((r) => /selected|active|current/i.test(String(r.className || ''))) || all[0];
    };
    const hit = pick();
    if (hit) {
      armImeGuard('back', 3000);
      hit.click();
      return true;
    }

    const toggle = document.querySelector('[class*="sidebarCol"] button[class*="toggle"]');
    if (!toggle) return false;
    const wasExpanded = sidebarExpanded();
    if (!wasExpanded) {
      try {
        toggle.click();
      } catch {
        return false;
      }
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const row = pick();
      if (row) {
        clearInterval(timer);
        armImeGuard('back', 3000);
        row.click();
        setTimeout(() => {
          try {
            if (!wasExpanded && sidebarExpanded()) toggle.click();
          } catch {
            /* noop */
          }
        }, 500);
        return;
      }
      if (tries > 20) clearInterval(timer);
    }, 100);
    return true;
  }

  /** 点"记住的那一行"。抽屉收起时官方不渲染行，所以要临时展开再点，点完还原。 */
  function clickRememberedRow(target) {
    const key = sessionKeyOf(target);
    if (!key) return false;
    const find = () => [...document.querySelectorAll('[data-row-key]')].find((el) => el.getAttribute('data-row-key') === key) || null;
    const row = find();
    if (row) {
      armImeGuard('back', 3000);
      (row.querySelector('[class*="title"]') || row).click();
      return true;
    }
    const toggle = document.querySelector('[class*="sidebarCol"] button[class*="toggle"]');
    if (!toggle) return false;
    const wasExpanded = sidebarExpanded();
    if (!wasExpanded) {
      try {
        toggle.click();
      } catch {
        return false;
      }
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const hit = find() || (tries > 8 ? findSessionRow(target) : null);
      if (hit) {
        clearInterval(timer);
        armImeGuard('back', 3000);
        (hit.querySelector('[class*="title"]') || hit).click();
        setTimeout(() => {
          try {
            if (!wasExpanded && sidebarExpanded()) toggle.click();
          } catch {
            /* noop */
          }
        }, 500);
        return;
      }
      if (tries > 20) clearInterval(timer);
    }, 100);
    return true;
  }
  // ---- 任务完成通知：**不再由网页负责** ----
  //
  // 历史：这一段曾经是"网页发现忙→闲就调 Shell.notifyTask"，Java 轮询只兜底。
  // 真机反馈"通知是机率事件"，查下来有三个致命点，全在网页侧无法根治：
  //   1. 网页只在**当前这个会话页**看得见忙态；人在面板页/别的会话就判不出；
  //   2. App 切到后台，WebView 被系统冻住，JS 根本不跑；
  //   3. 它和 Java 轮询各报一次，同一个完成可能弹两遍。
  // 现在判定搬到了宿主 + 原生：宿主在 turn 结束（agent/status → idle）给
  // /m/__ms/tasks 打上 finishedAt 时刻表，原生按它比大小判完成（4 秒/12 秒轮询），
  // 不漏短任务、切后台照跑、一次完成只弹一次。
  // 这里整段删掉，避免双弹。

  // ---- task-3 v3：只改UI，不改布局 ----
  // ---- task-3 v3：只改UI，不改布局 ----
  //
  // 用户纠正：结构上不搬任何官方节点。v2 那套（包 .ms-userrow、
  // 挪用户条、观察器补包）whole 删掉，官方 DOM 原样不动。
  // 只留 UI 层：齿轮保持 absolute 浮在抽屉左下，但换成透明底、
  // 无边框、无阴影、跟用户条同高同圆角，看起来像一家人。
  // 齿轮 = App 自己的配置页入口：点一下进原生设置页（改地址/端口），
  // 断网、红字、白屏都能点（原生页不依赖网页）。
  // 注意：绝不能替点网页里的"设置"（那是 DSH 自己的设置页，和改地址没关系，
  // 2026-10-23 做反过一次，教训记在这里防再犯）。
  function openAppSetup() {
    try {
      if (window.Shell && typeof window.Shell.openSetup === 'function') {
        window.Shell.openSetup();
        return true;
      }
    } catch {
      /* 没有桥（桌面浏览器直接开 /m）就什么都不做 */
    }
    return false;
  }
  function makeGear() {
    const g = document.createElement('button');
    g.type = 'button';
    g.className = 'ms-gear';
    g.setAttribute('aria-label', '设置');
    g.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.89a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10.11 3V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56.6.25 1.3.11 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08c.25.6.87 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51 1.03z"/></svg>';
    g.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAppSetup();
    });
    return g;
  }
  function ensureGear() {
    try {
      const col = document.querySelector('[class*="sidebarCol"]');
      if (!col) return;
      if (!col.querySelector(':scope > .ms-gear')) col.append(makeGear());
      seatGear();
    } catch {
      /* 插不进也不影响页面 */
    }
  }
  // 齿轮和官方底栏按钮（账号行/重连按钮）抢同一个槽位时的两道保险，
  // 全是"只改样子"：官方 DOM 一个不动，窄轨模式（行很窄）也不碰。
  // 1) 账号行很宽（>100px）时收窄 52px，齿轮坐进空出来的槽位，
  //    高亮/选中态画在行自己身上，行窄了阴影自然不再包住齿轮；
  // 2) 万一重连是独立元素还盖着槽位，齿轮自己上浮一格让开。
  function seatGear() {
    try {
      const col = document.querySelector('[class*="sidebarCol"]');
      let trig = null;
      if (col) {
        const list = col.querySelectorAll('button[aria-label], button[title]');
        for (const b of list) {
          if (b.classList && b.classList.contains('ms-gear')) continue;
          const s = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
          if (/账号|账户|account|profile/i.test(s)) { trig = b; break; }
        }
      }
      if (trig) {
        try {
          const r = trig.getBoundingClientRect();
          trig.style.maxWidth = r.width > 100 ? 'calc(100% - 52px)' : '';
        } catch {
          /* 量不到就不碰 */
        }
      }
      const g = document.querySelector('[class*="sidebarCol"] > .ms-gear');
      if (!g) return;
      const gr = g.getBoundingClientRect();
      if (!gr.width) return;
      const cx = gr.left + gr.width / 2;
      const cy = gr.top + gr.height / 2;
      g.style.visibility = 'hidden';
      let under = null;
      try {
        under = document.elementFromPoint(cx, cy);
      } catch {
        under = null;
      }
      g.style.visibility = '';
      if (under && under !== g && !g.contains(under) && under.closest && under.closest('button')) {
        g.style.bottom = 'calc(var(--ms-safe-bottom, 0px) + 60px)';
      } else {
        g.style.bottom = '';
      }
    } catch {
      /* 让不开就保持原位 */
    }
  }
  setTimeout(ensureGear, 1200);
  setTimeout(ensureGear, 4000);
  onClickBubble('gear-refresh', () => setTimeout(ensureGear, 300));
  // ---- 会话导航：先走官方 openSession，失败才退回"开抽屉点行" ----
  //
  // 0.9.2 的做法（开抽屉 → 按 data-row-key 找行 → 点标题）能用，但用户评价是
  // 「太丑陋了」：深链时左栏会闪一下，看起来像有人在替你点手机。
  // 官方插件层本来就有编程式导航（dsh-better-sidebar 用的就是
  // `ctx.get('uiWorkspace').openSession(target)`），client.js 把那条 API
  // 暴露成 window.__msHostOpenSession。这里的顺序是：
  //   1) 桥在 → 直接切，抽屉一个像素都不动；
  //   2) 桥不在/返回 false → 退回下面的 DOM 路径（保底，仍然可用）；
  //   3) 都失败 → 只开抽屉 + 记 deeplink-miss，不白屏不报错。
  function currentSessionId() {
    // 官方把"当前会话"存在 localStorage：{"sessionId":"session-<uuid>"}（实测工具页期间不变）
    try {
      const raw = localStorage.getItem('dsh.sessions.current');
      if (raw) {
        try {
          const o = JSON.parse(raw);
          const id = o && (o.sessionId || o.id);
          if (id) return String(id);
        } catch {
          if (/^session-/.test(raw)) return raw;
        }
      }
    } catch {
      /* noop */
    }
    // 兜底：会话容器上的官方属性（只有会话页挂载时才有）
    const el = document.querySelector('[data-conversation-session]');
    return el ? String(el.getAttribute('data-conversation-session') || '') || null : null;
  }

  function sessionKeyOf(id) {
    const tail = String(id || '').replace(/^session:/, '');
    return tail ? 'session:' + tail : '';
  }

  /** 等页面真的切到目标会话（读官方属性/存储，不猜） */
  async function waitSession(id, timeoutMs) {
    const want = String(id || '').replace(/^session:/, '');
    if (!want) return false;
    const deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
      const cur = currentSessionId();
      if (cur && String(cur).replace(/^session:/, '') === want) return true;
      const el = document.querySelector('[data-conversation-session]');
      if (el && String(el.getAttribute('data-conversation-session') || '').replace(/^session:/, '') === want) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  /** 走宿主桥切会话。返回 true 表示"已经切过去了"。 */
  async function hostOpenSession(id) {
    const sid = String(id || '').replace(/^session:/, '');
    if (!sid) return false;
    const bridge = window.__msHostOpenSession;
    if (typeof bridge !== 'function') return false;
    let ok = false;
    try {
      ok = bridge(sid) !== false;
    } catch {
      return false;
    }
    if (!ok) return false;
    armImeGuard('deeplink', 3000);
    return await waitSession(sid, 3500);
  }

  function findSessionRow(sid) {
    const raw = String(sid || '').trim();
    if (!raw) return null;
    const tail = raw.replace(/^session:/, '');
    if (!tail) return null;
    for (const el of document.querySelectorAll('[data-row-key]')) {
      const k = String(el.getAttribute('data-row-key') || '');
      if (k.indexOf('session:') !== 0) continue;
      if (k === 'session:' + tail || k === raw || k.slice(8) === tail) return el;
    }
    return null;
  }

  function expandCollapsedWorkspaces() {
    let opened = 0;
    for (const el of document.querySelectorAll('[data-row-key^="workspace:"]')) {
      if (el.getAttribute('aria-expanded') !== 'false') continue;
      try {
        el.click();
        opened += 1;
      } catch {
        /* noop */
      }
    }
    return opened;
  }

  /** DOM 兜底路径：只有宿主桥不可用时才走这里。 */
  async function openSessionByRow(sid) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (root.getAttribute('data-ms-drawer') !== 'open') ui.toggle(true);
    await wait(260);
    for (let round = 0; round < 5; round++) {
      const row = findSessionRow(sid);
      if (row) {
        const title = row.querySelector('[class*="title"]') || row;
        try {
          title.click();
        } catch {
          try {
            row.click();
          } catch {
            /* noop */
          }
        }
        await wait(600);
        const ok = row.getAttribute('aria-selected') === 'true';
        reportDiag('deeplink-' + (ok ? 'hit' : 'clicked'), { sid: String(sid).slice(0, 40), n: round });
        return ok;
      }
      if (expandCollapsedWorkspaces()) {
        await wait(500);
        continue;
      }
      await wait(400);
    }
    reportDiag('deeplink-miss', { sid: String(sid).slice(0, 40) });
    return false;
  }

  async function openSessionById(sid) {
    if (await hostOpenSession(sid)) {
      reportDiag('deeplink-host', { sid: String(sid).slice(0, 40) });
      return true;
    }
    return openSessionByRow(sid);
  }

  window.__msOpenSession = (sid) => {
    openSessionById(sid).catch(() => { /* noop */ });
    return true;
  };

  // ---- 白屏兜底 + 时间线（2026-10-25） ----
  //
  // 用户报：从工具页返回后白屏 7~8 秒。无头复现不出来（本地没有那条插件路由的渲染量），
  // 所以这轮先做两件事，都不猜原因：
  //   1) 观感兜底：主内容区连续一段时间没有文字/卡片（路由切换的空窗期）就盖一层自己的
  //      "加载中"，内容一回来立刻撤。这样不管官方哪一步慢，用户看到的都不是白屏。
  //   2) 时间线：把「页面各阶段 + 断线/重连次数」按毫秒报回网关 diag.log，
  //      下次真机再遇到，直接看日志就能定位卡在哪一步，不用再让用户反复复现。
  const STAGE_TAG = 'ms-stage';

  function stageReport(name, extra) {
    try {
      reportDiag(STAGE_TAG + '-level', Object.assign({ n: name, ms: Math.round(performance.now()) }, extra || {}));
    } catch {
      /* noop */
    }
  }

  function mainContentEl() {
    return document.querySelector("div:has(> [data-slot='main'])") || document.querySelector("[data-slot='main']");
  }

  function contentThin() {
    const el = mainContentEl();
    if (!el) return true;
    const txt = String(el.textContent || '').replace(/\s+/g, '');
    // 只有"几乎没有文字"才算空窗：会话卡片、骨架屏都带文字，误判会把正常页面盖住
    return txt.length < 16;
  }

  let posterEl = null;
  let posterShownAt = 0;
  let posterCooldownUntil = 0;

  function ensurePoster() {
    if (posterEl && posterEl.isConnected) return posterEl;
    const el = document.createElement('div');
    el.className = 'ms-poster';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="ms-poster-box"><span class="ms-poster-dot"></span><span>加载中…</span></div>';
    root.appendChild(el);
    posterEl = el;
    return el;
  }

  function showPoster() {
    if (Date.now() < posterCooldownUntil) return;
    if (posterShownAt) return;
    const el = ensurePoster();
    posterShownAt = Date.now();
    root.setAttribute('data-ms-poster', '1');
    // 双 rAF 后再加显示类：保证有过渡，而不是硬闪一层白
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('ms-on')));
    stageReport('blank-detected');
  }

  function hidePoster(reason) {
    if (!posterShownAt) return;
    const held = Date.now() - posterShownAt;
    posterShownAt = 0;
    root.removeAttribute('data-ms-poster');
    if (posterEl) posterEl.classList.remove('ms-on');
    // 撤得太快说明是正常路由切换，给 1.2s 冷却，避免来回闪
    if (held < 150) posterCooldownUntil = Date.now() + 1200;
    if (held > 150) stageReport('content-back', { held });
    try {
      reportDiag('poster-' + reason, { held });
    } catch {
      /* noop */
    }
  }

  let posterTimer = 0;
  function checkPoster() {
    clearTimeout(posterTimer);
    posterTimer = setTimeout(() => {
      if (contentThin()) {
        // 先等 120ms 再盖：路由切换的瞬时空白不值得闪一下
        if (!posterShownAt) showPoster();
      } else {
        hidePoster('content');
      }
    }, 120);
  }

  // 首屏也归它管：脚本一跑就先检查一次（此时内容通常还没渲染出来）
  checkPoster();
  try {
    new MutationObserver(() => checkPoster()).observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch {
    /* noop */
  }

  // ---- 断联/重连取证（只数数，不改行为） ----
  // 用户报「后台频繁断联、反复刷新重连」。真因没定位前先把它变成数字：
  // 在线/离线次数、WebSocket 开关次数、每次断开的间隔和关闭码。
  // 只包一层计数，不改任何连接参数 —— 出问题的永远是"改了却不知道改了什么"。
  const netStats = { on: 0, off: 0, wsOpen: 0, wsClose: 0, lastCloseAt: 0, firstCloseAt: 0 };
  window.__msNetStats = netStats;
  window.addEventListener('online', () => {
    netStats.on += 1;
    stageReport('online', { n: netStats.on });
  });
  window.addEventListener('offline', () => {
    netStats.off += 1;
    stageReport('offline', { n: netStats.off });
  });
  try {
    const NativeWS = window.WebSocket;
    if (NativeWS) {
      const wrap = function (...args) {
        const ws = new NativeWS(...args);
        try {
          ws.addEventListener('open', () => {
            netStats.wsOpen += 1;
          });
          ws.addEventListener('close', (ev) => {
            netStats.wsClose += 1;
            const now = Date.now();
            if (!netStats.firstCloseAt) netStats.firstCloseAt = now;
            const gap = netStats.lastCloseAt ? now - netStats.lastCloseAt : 0;
            netStats.lastCloseAt = now;
            stageReport('ws-close', { code: ev && ev.code, gap, n: netStats.wsClose });
          });
        } catch {
          /* noop */
        }
        return ws;
      };
      wrap.prototype = NativeWS.prototype;
      wrap.CONNECTING = NativeWS.CONNECTING;
      wrap.OPEN = NativeWS.OPEN;
      wrap.CLOSING = NativeWS.CLOSING;
      wrap.CLOSED = NativeWS.CLOSED;
      window.WebSocket = wrap;
    }
  } catch {
    /* noop */
  }

  window.addEventListener('pageshow', () => stageReport('pageshow'));
  window.addEventListener('pagehide', () => stageReport('pagehide'));
  document.addEventListener('visibilitychange', () => stageReport('visibility-' + document.visibilityState));
  if (document.readyState === 'complete') stageReport('dom-complete');
  else window.addEventListener('load', () => stageReport('load'), { once: true });

  // 加载完成后上报一次：确认这台手机跑的到底是哪一版、它看到多大的视口
  setTimeout(() => reportDiag('boot'), 1500);

  // ---- 就绪打卡 + 空白/报错上报（0.9.4 重写） ----
  //
  // 旧实现是"定时无条件打卡"：mobile.js 只要跑起来就告诉原生"页面活着"，
  // 哪怕 React 一个字都没渲染。结果白屏时原生把修复面板撤了，用户没有任何出口
  // （原生 10 秒看门狗就是被这两条 setTimeout 撤掉的）。
  // 现在打卡的条件是**真的渲染出内容**（跟海报同一套 contentThin 判定）；
  // JS 异常改成明确的 reportError，原生据此弹横幅；"页面空白"不再是上报项（0.9.8）。
  function shellCall(fn, arg) {
    try {
      const S = window.Shell;
      if (S && typeof S[fn] === 'function') S[fn](arg);
    } catch {
      /* 桥没就绪就交给原生看门狗 */
    }
  }

  // ---- 就绪打卡（0.9.8 重写）----
  //
  // 教训（用户 2026-10-26 报「那是没有会话内容的新会话，你在搞笑呢吗」）：
  // **不要拿"页面有没有字"当健康判据**。空的新会话本来就是空白正文，
  // 拿它判"页面崩了"必然误伤。pageReady 从此只表示一件事：
  // 「mobile.js 挂上了、页面 JS 活着」，内容多少与它无关。
  function pageReadyPing() {
    shellCall('pageReady');
  }
  // 立刻打一次 + 两个补救点（慢机器桥可能还没就绪），之后每 10 秒续心跳
  pageReadyPing();
  setTimeout(pageReadyPing, 1200);
  setTimeout(pageReadyPing, 3000);
  setInterval(pageReadyPing, 10000);

  // JS 错误：白屏最常见的成因。以前只会在控制台里消失，原生零感知、用户零信息。
  let lastErrAt = 0;
  function reportError(where, err) {
    const now = Date.now();
    if (now - lastErrAt < 1000) return; // 同一秒里的连环错只报第一条
    lastErrAt = now;
    let text = '';
    try {
      text = String((err && (err.stack || err.message)) || err || '');
    } catch {
      text = 'unprintable';
    }
    shellCall('reportError', (where + ': ' + text).slice(0, 300));
  }
  window.addEventListener('error', (e) => reportError('error', e.error || e.message), true);
  window.addEventListener('unhandledrejection', (e) => reportError('rejection', e.reason));
})();

// 手机上点了只会在电脑上弹资源管理器 / 复制路径 / 添加工作区的官方按钮：直接隐藏（不删 DOM）。
//
// 为什么不用 CSS 认 aria-label 一条条写：官方文案和 class 哈希每版都会变，
// 上两版就是这么挂掉的（写在 CSS 里，一条都没匹配上）。这里改成：
//   1. 只写一条 CSS（认我们自己打的 data-ms-hide）；
//   2. 用文字/aria-label 扫描打标记，MutationObserver 持续跟（弹出式菜单后渲染的也盖住）。
// 只认「自己这几个字」的元素，不认组件、不认类名。
(function hideDesktopOnlyActions() {
  if (window.__msHideDesktop) return;
  window.__msHideDesktop = true;
  // 注意：「用 文件资源管理器 打开」和「更多打开方式」是页头文件组，由"收纳钮"代替，
  // 必须一起藏掉（旧版靠一条构建哈希前缀 CSS 藏，官方换哈希后失效，按钮就露出来了）。
  // 「更多操作」同理：它展开的「下载 Session 日志 / 反馈」已经收进收纳钮，
  // ⋯ 本体留着就是重复入口。display:none 不影响下面 stash 的程序化 click。
  // aria 文案里带空格，所以用 \s* 放宽匹配。
  const RX =
    /(添加工作区|打开所在文件夹|在文件夹中打开|在文件夹中显示|复制路径|在资源管理器中打开|在资源管理器中显示|用\s*文件资源管理器\s*打开|更多打开方式|更多操作)/;
  const style = document.createElement('style');
  style.id = 'ms-hide-desktop-actions';
  style.textContent = '[data-ms-hide]{display:none !important}';
  document.head.appendChild(style);

  const mark = (el) => {
    if (el.hasAttribute('data-ms-hide')) return;
    const al = el.getAttribute('aria-label') || '';
    const ti = el.getAttribute('title') || '';
    let hit = RX.test(al) || RX.test(ti);
    if (!hit) {
      // 没 aria/title 的按文字认，但只认「整块文字就是这几个字」的控件，
      // 免得把包着它的行/容器一起隐藏掉。
      const txt = (el.textContent || '').trim();
      hit = txt.length > 0 && txt.length <= 12 && RX.test(txt);
    }
    if (hit) el.setAttribute('data-ms-hide', '1');
  };

  const scan = (root) => {
    if (!root || !root.querySelectorAll) return;
    if (root.nodeType === 1) mark(root);
    root
      .querySelectorAll('button, [role="button"], a, [title], [aria-label]')
      .forEach(mark);
  };

  scan(document.body);
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') mark(m.target);
      else m.addedNodes && m.addedNodes.forEach(scan);
    }
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title'],
  });
})();

// 把官方 class 里的「本地名」盖到我们自己的 data-ms-c 上。
// 为什么这么做：官方类名是「构建哈希_本地名」，哈希每版都变；本地名相对稳定。
// 直接 [class*="_row"] 会误伤 _rowActions 之类；改成精确 token（data-ms-c~="row"）就不会。
(function __msClassTokens() {
  // 官方有两套类名约定，两种都得认（2026-10-25 实测本版已同时存在）：
  //   ① 构建哈希在前：`GAkraW_searchSlot`      → searchSlot
  //   ② 构建哈希在中：`_root_4ub78_1`          → root
  //      （插件 bundle 的 CSS Modules 用这种，形如 `_本地名_哈希_序号`）
  // 只认 ① 的时候，② 那批元素的 data-ms-c 是 null —— 覆盖不到就等于没有锚点。
  const RX = /^[A-Za-z0-9-]+?_(.+)$/;
  const RX_ALT = /^_([A-Za-z][A-Za-z0-9-]*)_[a-z0-9-]{3,8}(?:_\d+)?$/;
  let queued = 0;
  const stamp = (el) => {
    if (!el || el.nodeType !== 1 || !el.classList) return;
    let out = '';
    for (const c of el.classList) {
      const m = RX.exec(c) || RX_ALT.exec(c);
      if (!m) continue;
      const tok = m[1];
      if (out.split(' ').includes(tok)) continue;
      out += (out ? ' ' : '') + tok;
    }
    if (out) {
      if (el.getAttribute('data-ms-c') !== out) el.setAttribute('data-ms-c', out);
    } else if (el.hasAttribute('data-ms-c')) {
      el.removeAttribute('data-ms-c');
    }
  };
  const scan = (root) => {
    if (!root || !root.querySelectorAll) return;
    stamp(root);
    root.querySelectorAll('[class]').forEach(stamp);
  };
  const flush = () => {
    queued = 0;
    scan(document.documentElement);
  };
  scan(document.documentElement);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') stamp(m.target);
      else if (m.addedNodes) m.addedNodes.forEach(scan);
    }
    if (!queued) queued = requestAnimationFrame(flush);
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
})();

/*
 * 页头/标签行的自适应几何。
 *
 * 为什么要这一段：用量药丸和状态标签（成员/后台任务/子智能体）是从别的容器里
 * 提到标签行右侧的，CSS 只能靠 position:fixed 定位；一旦把 top/right/宽度写死成像素，
 * 换小屏、横屏、字体缩放就会错位。这里只做一件事：把**量到的真实几何**写成 CSS 变量，
 * CSS 里不再出现任何写死的坐标，全部 var(--ms-*)。
 *
 * 量的东西：
 *   --ms-tabrow-top  标签行顶边（药丸和状态组都跟它对齐）
 *   --ms-tabrow-h    标签行高度（决定垂直居中）
 *   --ms-edge        视口右边缘到标签行右边的距离（官方自己的右 padding）
 *   --ms-pill-w      用量药丸当前宽度（会随文案变长）
 *   --ms-acts-w      状态标签组当前宽度（会随任务数变长）
 *
 * 重算时机：resize / 转屏 / DOM 变化（MutationObserver）/ 定时兜底（会话切换、键盘开合）。
 */
(function msAdaptiveHeader() {
  if (window.__msAdaptiveHeader) return;
  window.__msAdaptiveHeader = true;
  const root = document.documentElement;
  let raf = 0;
  let last = '';
  /** 状态芯片的自然宽度（降级前）。只在未降级时刷新，用来打破"降级→量到更小→取消降级"的自激振荡。 */
  const chipNatural = new WeakMap();
  let pillNatural = 0;

  const setVar = (k, v) => {
    if (root.style.getPropertyValue(k) !== v) root.style.setProperty(k, v);
  };

  const measure = () => {
    raf = 0;
    const tabs = document.querySelector("[data-ms-c~='tabs']");
    if (!tabs) return;
    const slot = document.querySelector("[data-slot='conversation.input.right']");
    const pill = slot ? slot.firstElementChild : null;
    const acts = document.querySelector("header [data-ms-c~='headerActions']");
    const tr = tabs.getBoundingClientRect();
    if (!tr.width) return;

    const edge = Math.max(0, Math.round(window.innerWidth - tr.right));
    const pillW = pill ? Math.round(pill.getBoundingClientRect().width) : 0;
    const gap = 8;

    // 只把「后台任务 / 子智能体」这类状态按钮提到 tab 行右侧；
    // 「智能体团队」留在首栏，跟会话标题同一行（用户明确要求）。
    const isTeam = (b) => (b.getAttribute('aria-label') || '') === '智能体团队';
    const visible = (b) => !b.hasAttribute('data-ms-hide') && getComputedStyle(b).display !== 'none';
    const btns = acts ? [...acts.querySelectorAll('button')] : [];
    const status = btns.filter((b) => !isTeam(b) && visible(b));

    // ---- 装不下就降级（2026-10-26） ----
    //
    // 现场（用户截图）：390 宽下「两个后台任务/子智能体芯片 + 用量药丸 + 对话/轨迹」
    // 一共超出十来像素，于是 tabs 被 padding 压到 66px（「轨迹」只剩半个字），
    // 第二个芯片的首个数字被前一个盖住。
    // 处理原则：**标签文字永远优先** —— 装不下先让芯片只留数字，再不行给药丸只留图形。
    // 各级宽度用「设计值」算，不反复量：量-改-量的循环会被 MutationObserver 放大成抖动。
    const CHIP_COMPACT_W = 32; // 图标 + 个位数字 + 内边距（= CSS 里的 2rem，实测对齐）
    const PILL_COMPACT_W = 32;
    const vtEl = document.querySelector("[data-ms-c~='viewTabs']");
    const needTabs = vtEl ? Math.round(vtEl.scrollWidth) : 0;
    const tabsW = Math.round(tr.width);
    const gapN = Math.max(1, status.length + 1);

    // 关键：判定"装不装得下"必须用**降级前的自然宽度**。
    // 否则会自激振荡：降级后量到的宽度变小 → 判定"放得下" → 取消降级 → 又放不下 → 无限抖。
    // 所以缓存每个芯片/药丸的自然宽度，只在 level=0 时刷新缓存。
    const compacted = compactLevel >= 1;
    let chipsRaw = 0;
    for (const b of status) {
      let nat = chipNatural.get(b);
      if (!compacted) {
        nat = Math.round(b.getBoundingClientRect().width);
        chipNatural.set(b, nat);
      }
      chipsRaw += nat || CHIP_COMPACT_W;
    }
    if (!compacted && pill) pillNatural = Math.round(pill.getBoundingClientRect().width);
    const pillRaw = pill ? pillNatural || PILL_COMPACT_W : 0;

    const total0 = needTabs + chipsRaw + pillRaw + 8 * gapN;
    let level = 0;
    if (total0 > tabsW) {
      const total1 = needTabs + status.length * CHIP_COMPACT_W + pillRaw + 8 * gapN;
      level = total1 <= tabsW ? 1 : 2;
    }
    const chipWEff = level >= 1 ? CHIP_COMPACT_W : null;
    const pillWEff = level >= 2 ? PILL_COMPACT_W : pillW;

    // 从右往左排：药丸在 edge 处，状态按钮依次往左叠
    let acc = edge + pillWEff + gap;
    status.forEach((b, i) => {
      b.setAttribute('data-ms-sidx', String(i + 1));
      setVar(`--ms-s${i + 1}-right`, `${acc}px`);
      acc += (chipWEff === null ? Math.round(b.getBoundingClientRect().width) : chipWEff) + gap;
    });
    btns.forEach((b) => {
      if (!status.includes(b)) b.removeAttribute('data-ms-sidx');
    });
    // sidx 齐了才能按它找芯片做降级（隐藏文字 span / chevron）
    applyHeaderCompact(level);

    // 预留宽度：从"最左边那颗芯片的左边"算到标签行右边缘。
    // acc 循环结束时含一个多余的尾部 gap，扣掉它才是真正占用的宽度。
    const reserve = Math.max(0, Math.round(acc - gap - edge));
    // 硬保护：无论怎么算，tab 内容区都不许小于它自己的宽度（宁可让最左芯片贴住空白，也不切 tab 字）
    const reserveClamped = Math.max(0, Math.min(reserve, tabsW - needTabs - 4));

    // 空间不够时收紧状态文字，而不是让 tab 被切半个字
    const avail = tabsW - reserve;
    const tight = level > 0 || (needTabs > 0 && avail < needTabs);

    setVar('--ms-tabrow-top', `${Math.round(tr.top)}px`);
    setVar('--ms-tabrow-h', `${Math.round(tr.height)}px`);
    setVar('--ms-edge', `${edge}px`);
    setVar('--ms-pill-w', `${pillW}px`);
    setVar('--ms-tabs-reserve', `${reserveClamped}px`);
    if (root.getAttribute('data-ms-tight') !== (tight ? '1' : '0')) {
      root.setAttribute('data-ms-tight', tight ? '1' : '0');
    }
  };

  /**
   * 状态芯片降级：
   *   0 = 原样；1 = 芯片只留数字（隐藏文字 span + chevron，宽度锁死）；
   *   2 = 再把用量药丸的文字收掉，只留图形。
   * 只标 `data-ms-hide`，不删节点 —— 官方重渲染后由下一次 measure 幂等重贴。
   */
  let compactLevel = -1;
  function applyHeaderCompact(level) {
    if (compactLevel === level) return;
    compactLevel = level;
    root.setAttribute('data-ms-compact', String(level));
    const acts = document.querySelector("header [data-ms-c~='headerActions']");
    const chips = acts ? [...acts.querySelectorAll('button[data-ms-sidx]')] : [];
    for (const b of chips) {
      for (const s of b.querySelectorAll('span')) {
        const t = String(s.textContent || '').trim();
        if (level >= 1 && t && !/^\d+$/.test(t)) s.setAttribute('data-ms-hide', '1');
        else s.removeAttribute('data-ms-hide');
      }
    }
    const slot = document.querySelector("[data-slot='conversation.input.right']");
    const pill = slot ? slot.firstElementChild : null;
    if (pill) {
      for (const s of pill.querySelectorAll('span')) {
        const t = String(s.textContent || '').trim();
        if (level >= 2 && t) s.setAttribute('data-ms-hide', '1');
        else s.removeAttribute('data-ms-hide');
      }
    }
  }

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(measure);
  };
  // 给闸门/探针用的显式重算入口（真实状态变化时也走它，保证口径一致）
  window.__msAdaptiveHeaderMeasure = schedule;

  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  // 视觉视口变化 = 键盘弹出/收起，也要重算
  if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule, { passive: true });

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-ms-c', 'data-slot', 'data-ms-drawer'],
  });

  setTimeout(schedule, 600);
  setTimeout(schedule, 2500);
  // 兜底：会话切换后官方会重排，单靠 MutationObserver 有时抓不到
  setInterval(schedule, 3000);
})();

/*
 * 抽屉开着时，官方在「打开浮层 / 打开搜索」的瞬间会把侧栏塌陷一下（响应式行为）。
 * 塌陷期间官方不渲染会话行，于是整块列表卸载再重建 —— 用户看到的就是
 * 「白屏一下、元素解构重组」。原来的 sync() 要等 260ms 才补展开，这段空窗太长。
 *
 * 这里只做一件事：盯着 frame 的 data-sidebar-collapsed，抽屉意图是 open 时立刻补展开。
 * 加 busy 锁和 200ms 冷却，避免和官方 toggle 打架变成来回翻。
 */
(function msFastReopen() {
  if (window.__msFastReopen) return;
  window.__msFastReopen = true;
  const root = document.documentElement;
  let busy = false;
  const frame = () => document.querySelector("div:has(> div > [data-slot='sidebar'])");

  const reopen = () => {
    if (busy) return;
    if (root.getAttribute('data-ms-drawer') !== 'open') return;
    const el = frame();
    if (!el) return;
    const collapsed = el.getAttribute('data-sidebar-collapsed');
    if (!collapsed || collapsed === 'false') return;
    const btn = document.querySelector('[class*="sidebarCol"] button[class*="toggle"]');
    if (!btn) return;
    busy = true;
    try { btn.click(); } catch { /* noop */ }
    setTimeout(() => { busy = false; }, 200);
  };

  const attach = () => {
    const el = frame();
    if (!el || el.__msWatch) return;
    el.__msWatch = true;
    new MutationObserver(reopen).observe(el, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
  };

  attach();
  setTimeout(attach, 3000);
  new MutationObserver(attach).observe(root, { childList: true, subtree: true });
})();

/*
 * 左栏搜索：官方在窄屏上把「点搜索」当成了「收侧栏」。
 *
 * 实测（390×844，官方代码、把本插件的 css/js 全摘掉）点放大镜后：
 *   侧栏塌成 rail、弹出一个空面板（acoR2W_panel 0,48 390×796），
 *   而那个隐藏的搜索输入框始终 width:4 / opacity:0 —— 点了没有任何搜索入口。
 * 桌面宽度（1280×900）同一个按钮正常展开（aria-expanded=true、输入框 196px）。
 * 所以这是官方窄宽分支的行为，不是我们的样式压坏的。
 *
 * 输入框本身是受控组件：强行展开 + 聚焦 + 真实键入，官方列表确实按名字过滤
 * （实测 3 行 → 0 行）。所以这里只做两件事：
 *   1. 捕获阶段拿走官方那一下（pointerdown + click），别让它把侧栏收了；
 *   2. 把输入框展开并聚焦，尺寸交给 mobile.css 的 data-ms-search。
 */
(function msSidebarSearch() {
  if (window.__msSidebarSearch) return;
  window.__msSidebarSearch = true;
  const root = document.documentElement;
  const BTN = "[data-ms-c~='searchButton']";
  const SLOT = "[data-ms-c~='searchSlot']";
  const INPUT = "[data-ms-c~='searchInput']";
  const input = () => document.querySelector(INPUT);
  const isOpen = () => root.getAttribute('data-ms-search') === '1';
  let clearTimer = 0;

  // 受控输入：直接改 value React 不认，得走原生 setter + input 事件（否则收回搜索后
  // 列表还停在过滤状态，用户看到一栏空会话）。
  const clearValue = (el) => {
    if (!el || !el.value) return;
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!desc || !desc.set) return;
    desc.set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const focusInput = () => {
    const el = input();
    if (!el || !isOpen()) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  };

  /*
   * 为什么聚焦要重试到 700ms：
   * Chrome 在触摸手势进行中会压制程序化 focus（防止滚动/点击时抢焦点）。
   * 实测 tap 后的时间线（真机同源环境）：43ms 按钮拿到焦点 → 44ms 我们的
   * click 处理器展开搜索框并 focus()（被压制，没有 focusin）→ 之后浏览器
   * 把焦点留在按钮上。于是键盘不弹，随便按一个键焦点落到正文输入框，
   * 我们自己的 focusin 判定顺手把抽屉关了 —— 真机「点搜索没反应 / 一点就缩回」
   * 就是这条链。所以按手势结束的节奏补几次，并且一旦焦点已经是输入框就停。
   */
  const ensureFocus = () => {
    if (!isOpen()) return;
    const el = input();
    if (!el) return;
    const a = document.activeElement;
    if (a === el) return;
    // 用户已经点到别处（正文输入框 / 会话行）就不再抢焦点
    if (a && a !== document.body && !(a.closest && a.closest(BTN))) return;
    focusInput();
  };

  const open = () => {
    const el = input();
    if (!el) return;
    clearTimeout(clearTimer);
    root.setAttribute('data-ms-search', '1');
    el.removeAttribute('tabindex');
    focusInput();
    for (const ms of [80, 200, 400, 700]) setTimeout(ensureFocus, ms);
  };

  const close = () => {
    if (!isOpen()) return;
    root.removeAttribute('data-ms-search');
    const el = input();
    if (!el) return;
    el.setAttribute('tabindex', '-1');
    try {
      el.blur();
    } catch {
      /* noop */
    }
    // 延后清空：收起的那一下可能正要点会话行，立刻清会让列表在手指底下重排，
    // 结果点到的不是原来那一行（真机老问题）。260ms 足够 click 落地。
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => clearValue(el), 260);
  };

  window.__msSearch = { open, close, isOpen };

  // 手指抬起后，浏览器会把焦点落到被点的按钮上，而且比 open() 里的补聚焦还晚
  // （实测：tap 后 300ms activeElement 仍是 BUTTON，于是键盘不弹；接着随便按一个键，
  // 焦点跑到正文输入框，我们自己的 focusin 判定顺手把抽屉关了 —— 真机「点搜索
  // 没反应 / 一点就缩回」就是这个链条）。所以只要搜索开着、焦点落在放大镜上，
  // 就把它还给输入框。
  document.addEventListener(
    'focusin',
    (e) => {
      if (!isOpen()) return;
      const t = e.target;
      if (t && t.closest && t.closest(BTN)) focusInput();
    },
    true,
  );

  // 官方那一下在按下阶段就把侧栏收了，所以 pointerdown 也得拦。
  // 只 stopPropagation、不 preventDefault：按钮的按下态/焦点照常有。
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target;
      if (t && t.closest && t.closest(BTN)) e.stopPropagation();
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t || !t.closest || !t.closest(BTN)) return;
      e.stopPropagation();
      // 这里**不能** preventDefault：取消 click 的默认动作会让 Chrome 把文档
      // 挂进「焦点锁」状态，之后程序化 focus() 全部无效（实测 tap 后哪怕新建一个
      // input 也拿不到焦点，页面看起来就是「点了没反应、键盘不弹」）。
      if (isOpen()) close();
      else open();
    },
    true,
  );

  // 点搜索框以外的地方就收起（不 preventDefault：会话行/日期夹照常点）
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!isOpen()) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(SLOT)) return;
      close();
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !isOpen()) return;
      e.stopPropagation();
      close();
    },
    true,
  );

  // 抽屉一关就复位：否则下次拉开，列表还停在上一轮的过滤结果上
  new MutationObserver(() => {
    if (root.getAttribute('data-ms-drawer') === 'closed') close();
  }).observe(root, { attributes: true, attributeFilter: ['data-ms-drawer'] });
})();

/*
 * 智能体预设（「标准模式 / 创造模式」）的常驻标识。
 *
 * 问题：官方的预设标识只在**落地页**渲染（`conversation.hero.agentPreset`）。
 * 一进会话，hero 区整体不渲染 —— 实测会话页连这个槽位都不存在（`no hero slot`），
 * 于是用户进了会话就再也看不到"我现在用的是哪个模式"。
 *
 * 做法：把落地页读到的预设名持久化，在会话页把它放回**输入卡底部那一行**
 * （就是「技能 / 用量药丸 / 发送」那一行），作为只读标识，不做成按钮：
 * 它只是状态，点它没有合理动作（官方菜单锚在 hero 上，会话页没有 hero）。
 *
 * 布局：作为 row 的第三个子件插在 tools 与 trailing 之间，flex + 省略号自适应，
 * 不写死坐标；拿不到预设名时整件隐藏，不占位。
 */
(function msModeChip() {
  if (window.__msModeChip) return;
  window.__msModeChip = true;
  // 落点：输入卡**下面**那一行统计（"144 tok/s · 缓存 99% · 38%"），
  // 实测结构是 composer root 里与 card 平级的 [data-ms-c~='dock']（390 宽下 256×26 居中）。
  // 落地页没有这一行（还没有消息），那时官方 hero 自己有预设标识，不需要我们补。
  const DOCK = "[data-ms-c~='dock']";

  const chip = () => document.querySelector('.ms-mode-chip');

  // data-ms-c~='dock' 也可能出现在别处，所以缓存住"第一个有可见尺寸的 dock"，
  // 只在被 React 换掉以后重新找 —— 流式输出时 DOM 变动极频繁。
  let dockEl = null;
  const findDock = () => {
    for (const el of document.querySelectorAll(DOCK)) {
      const r = el.getBoundingClientRect();
      if (r.width > 80 && r.height > 8) return el;
    }
    return null;
  };

  // 官方那个标识前面是「图标 + 文字」，图标是 14×14 的行内 svg。
  // 直接克隆官方的节点（而不是抄死 path）：预设各有各的图标，抄死就等着哪天对不上。
  const presetLabelEl = () => {
    for (const host of document.querySelectorAll(PRESET_HOST)) {
      for (const el of host.querySelectorAll('span')) {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 8 || !/模式$/.test(t)) continue;
        if (el.querySelector('span')) continue; // 只要最内层
        return el;
      }
    }
    return null;
  };
  // 注意：不能直接拿 label.parentElement.querySelector('svg') —— 窄屏下整个标识是
  // display:none，rect 全是 0，而旁边「智能体团队」的图标反而是一颗可见的 14×14，
  // 按 rect 挑必然挑错（r9 第一版就把团队图标搬过来了）。这里按 **DOM 归属** 挑：
  // 往上爬到"文字内容恰好等于预设名"的那层壳，图标一定在里面。
  const presetChipHost = () => {
    const label = presetLabelEl();
    if (!label) return null;
    const text = (label.textContent || '').trim();
    let host = label;
    while (host.parentElement && (host.parentElement.textContent || '').trim() === text) host = host.parentElement;
    return host;
  };
  const sessionPresetIcon = () => {
    const host = presetChipHost();
    const svg = host ? host.querySelector('svg') : null;
    return svg ? svg.cloneNode(true) : null;
  };

  let lastText = '';

  const paint = (text) => {
    const el = chip();
    if (!el) return;
    const t = el.querySelector('.ms-mode-chip-t');
    if (!text) {
      el.hidden = true;
      lastText = '';
      return;
    }
    el.hidden = false;
    if (t && t.textContent !== text) t.textContent = text;
    el.setAttribute('title', '当前智能体预设：' + text);
    // 预设变了，图标也可能跟着变 → 按官方的换一次
    if (text !== lastText) {
      lastText = text;
      const official = sessionPresetIcon();
      const cur = el.querySelector('svg');
      if (official && (!cur || cur.outerHTML !== official.outerHTML)) {
        if (cur) cur.remove();
        const tx = el.querySelector('.ms-mode-chip-t');
        el.insertBefore(official, tx);
      }
    }
  };

  // 统计行会随发送/停止整块重渲染，所以每次变动都确认一下 chip 还在不在
  const ensure = () => {
    const old = chip();
    if (!dockEl || !dockEl.isConnected) dockEl = findDock();
    if (!dockEl) {
      // 落地页没有统计行：那里官方 hero 自己有标识，我们不出场
      if (old) old.hidden = true;
      return;
    }
    if (!old || old.parentElement !== dockEl) {
      const el = old || document.createElement('span');
      el.className = 'ms-mode-chip';
      el.hidden = true;
      // 结构固定成「图标 + 文字」两层，文字单独一个 span：
      // 这样更新文字不会把图标冲掉，也才能对文字做省略号。
      if (!el.querySelector('.ms-mode-chip-t')) {
        const tx = document.createElement('span');
        tx.className = 'ms-mode-chip-t';
        el.appendChild(tx);
      }
      dockEl.insertBefore(el, dockEl.firstChild);
    }
    paint(sessionPreset());
  };

  /*
   * 会话级预设名的来源：**首栏里本来就有，只是窄屏被 display:none 藏了**。
   *
   * 事实更正（2026-10-25，用户截图 + 实测）：
   *   1280px：`span[label] < div{conversation.session.header.actions} < div[headerActions]`
   *           显示「创造模式」，rect 1090,14 68×22，display:flex。
   *   390px ：**同一个节点还在**，但 display:none（0×0）。
   * 也就是说官方会话页一直有这个值，窄屏只是视觉上收起。
   *
   * 之前我判断"会话页不渲染"是错的，错因很具体：用了 innerText。
   * display:none 的子树 innerText 恒为空字符串，必须用 textContent —— 这个坑记进
   * docs/MOBILE-DESIGN.md §17.5（同源坑还坑过页头标题探测）。
   *
   * 现在：直接读这个节点的 textContent 搬到统计行。不猜、不缓存、不依赖落地页。
   */
  const PRESET_HOST = "[data-slot='conversation.session.header.actions'], [data-ms-c~='headerActions']";
  const sessionPreset = () => {
    for (const host of document.querySelectorAll(PRESET_HOST)) {
      for (const el of host.querySelectorAll('span, div')) {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 12 || !/模式$/.test(t)) continue;
        // 只要最内层，避免把「智能体团队创造模式」这种拼接文本当成预设名
        if ([...el.children].some((c) => /模式$/.test((c.textContent || '').trim()))) continue;
        return t;
      }
    }
    return '';
  };

  const sync = () => {
    ensure();
    paint(sessionPreset());
  };

  // 流式输出时 mutation 一秒几十次，用 rAF 合并
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync();
    });
  };

  sync();
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-ms-c', 'data-slot'],
    // characterData：预设名是文本节点，切会话时只换文字不换节点，不盯这个就更新不到
    characterData: true,
  });
  setTimeout(sync, 3000);
  setTimeout(sync, 8000);
})();

/*
 * 锚点自检（L2）：每次页面加载都问一遍「我依赖的东西还在不在」。
 *
 * 为什么要有这一层：官方每次构建都可能让某条选择器静默失效——CSS 不报错、只是不匹配。
 * 以前这种情况只能等用户看见「怎么又没变」才发现，然后一轮一轮陪跑。现在把它变成
 * 一行日志：`tap=anchor-health|missing=...|fp=前缀数/槽位数/前缀指纹/槽位指纹`。
 * 我在服务器侧读 ~/.dsh/mobile-studio/diag.log 就能判断「是锚点没了，还是官方结构变了」，
 * 不需要用户做任何操作。
 *
 * 这里只**检测+上报**，不改任何样式：自动修改属于官方更新后的一次人工决策（见
 * docs/ANCHOR-CONTRACT.md 的 Runbook）。期望区间按实测留了余量（新会话页没有 tabs，
 * 所以 tabs/viewTabs 的下限是 0）。
 */
(function msAnchorHealth() {
  if (window.__msAnchorHealthRun) return;

  // [id, 选择器, 最少, 最多(0 = 不限)]
  const PROBES = [
    ['sidebar', "[data-slot='sidebar']", 1, 2],
    ['main', "[data-slot='main']", 1, 2],
    ['rightbar', "[data-slot='rightbar']", 1, 2],
    ['inputRight', "[data-slot='conversation.input.right']", 1, 2],
    ['toggle', '.ms-toggle', 1, 1],
    ['stash', '.ms-stash-btn', 1, 1],
    ['tabs', "[data-ms-c~='tabs']", 0, 3],
    ['viewTabs', "[data-ms-c~='viewTabs']", 0, 3],
    ['headerActions', "[data-ms-c~='headerActions']", 1, 5],
    ['bottomRow', "[data-ms-c~='bottomRow']", 1, 4],
    ['searchSlot', "[data-ms-c~='searchSlot']", 1, 3],
    ['searchButton', "[data-ms-c~='searchButton']", 1, 3],
    ['searchInput', "[data-ms-c~='searchInput']", 1, 3],
    ['sectionHeader', "[data-ms-c~='sectionHeader']", 1, 4],
    ['sessionRow', "[data-ms-c~='sessionRow']", 0, 80],
    ['panel', "[data-ms-c~='panel']", 0, 10],
    ['titleRow', "[data-ms-c~='titleRow']", 1, 2],
    ['composerInput', "[data-ms-c~='input']", 1, 4],
  ];

  // djb2 取 8 位十六进制：够区分"变了/没变"，又短到能塞进一行日志
  const hash = (str) => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  const collect = () => {
    const missing = [];
    const ambiguous = [];
    const counts = {};
    for (const [id, sel, min, max] of PROBES) {
      let n = 0;
      try {
        n = document.querySelectorAll(sel).length;
      } catch {
        n = -1;
      }
      counts[id] = n;
      if (n < min) missing.push(id);
      else if (max > 0 && n > max) ambiguous.push(id);
    }

    // ① 盖章器的产出量：这是所有 token 锚点的总根。
    //    实测基线（会话页）195 个元素 / 112 种 token；这里只守"归零"这条最硬的线——
    //    归零意味着类名约定又变了（例如只认 hash_local 时碰上 _local_hash_N），
    //    30 多个 CSS token 会一起失效，页面直接退回官方原貌。
    let classTokens = 0;
    try {
      classTokens = document.querySelectorAll('[data-ms-c]').length;
    } catch {
      /* noop */
    }
    counts.classTokens = classTokens;
    if (classTokens === 0) missing.push('classTokens');

    // ② 文案存量：mobile.js 里有十几处靠中文 aria 判语义（桌面按钮隐藏、返回键、团队按钮）。
    //    官方文案改一个词，那些判据就静默失效，而 CSS 闸完全看不见。这里只统计"还能找到几条"。
    const COPY = ['搜索会话', '归档会话', '置顶会话', '添加工作区', '新建会话', '返回'];
    let copyFound = 0;
    try {
      const labels = [...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') || '');
      for (const c of COPY) if (labels.some((l) => l.includes(c))) copyFound++;
    } catch {
      /* noop */
    }
    counts.copyFound = copyFound;
    if (copyFound === 0) missing.push('copyTable');

    // 官方构建指纹：CSS Modules 前缀集合 + 槽位名单。官方一换构建，这两样必变。
    const prefixes = new Set();
    const slots = new Set();
    let scanned = 0;
    try {
      for (const el of document.querySelectorAll('[class], [data-slot]')) {
        if (++scanned > 6000) break;
        const s = el.getAttribute('data-slot');
        if (s) slots.add(s);
        const c = el.className;
        if (typeof c === 'string' && c) {
          for (const one of c.split(/\s+/)) {
            const m = /^([A-Za-z0-9][A-Za-z0-9-]{3,9})_/.exec(one);
            if (m) prefixes.add(m[1]);
          }
        }
      }
    } catch {
      /* noop */
    }
    const prefixList = [...prefixes].sort();
    const slotList = [...slots].sort();
    return {
      missing,
      ambiguous,
      counts,
      prefixCount: prefixList.length,
      slotCount: slotList.length,
      prefixHash: hash(prefixList.join(',')),
      slotHash: hash(slotList.join(',')),
      slotList,
    };
  };

  const run = (why) => {
    let r;
    try {
      r = collect();
    } catch {
      return null;
    }
    // 变量存在性单独查：computedStyle 拿不到值时返回空串
    let leadVar = 0;
    try {
      leadVar = getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-leading-clearance').trim() ? 1 : 0;
    } catch {
      /* noop */
    }
    if (!leadVar) r.missing.push('leadVar');

    const health = {
      at: new Date().toISOString(),
      why,
      ok: r.missing.length === 0 && r.ambiguous.length === 0,
      missing: r.missing,
      ambiguous: r.ambiguous,
      counts: r.counts,
      fp: {
        prefixes: r.prefixCount,
        slots: r.slotCount,
        prefixHash: r.prefixHash,
        slotHash: r.slotHash,
      },
    };
    window.__msAnchorHealth = health;
    // 只报一行：缺了哪些 + 指纹。有 ambiguous 也带上（说明 token 串到别的组件了）
    try {
      window.__msDiag?.('anchor-health', {
        why,
        miss: health.missing.join(',') || '-',
        amb: health.ambiguous.join(',') || '-',
        anch: `${r.counts.classTokens}/${r.counts.copyFound}`,
        fp: `${r.prefixCount}/${r.slotCount}/${r.prefixHash}/${r.slotHash}`,
      });
    } catch {
      /* noop */
    }
    return health;
  };

  window.__msAnchorHealthRun = run;

  // 8s 起步（官方启动完、首次渲染稳定），再补一次 30s：有的锚点要进会话页才出现
  setTimeout(() => run('boot'), 8000);
  setTimeout(() => run('late'), 30000);
})();
