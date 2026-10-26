package com.lexin.dshmobile;

import android.webkit.JavascriptInterface;

/**
 * 本地页（设置页 / 连不上页）和原生之间的桥。
 *
 * 只在 shellMode 为 true 时干活：进入真实页面后所有方法直接返回，
 * 页面上的第三方代码就算知道名字也调不动。
 * 工作台侧只有两个例外：pageReady（心跳）与 reportError（异常上报），
 * 它们是"网页 → 原生"的单向上报，作用在 host 侧各自的守卫里。
 *
 * 注意：这些方法由 WebView 在 JavaBridge 线程调用，碰界面的必须 runOnUiThread。
 */
public class ShellBridge {

    private final MainActivity host;

    ShellBridge(MainActivity host) {
        this.host = host;
    }

    /** 同步返回整理后的地址，供输入框实时预览。纯计算，不碰界面。 */
    @JavascriptInterface
    public String resolve(String input) {
        return host.resolveInput(input);
    }

    @JavascriptInterface
    public void connect(final String input) {
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.connectInput(input);
            }
        });
    }

    /** P0：本地页桥方法，工作台不可调（菜单走 host.openInChrome 直调，不受影响）。 */
    @JavascriptInterface
    public void openChrome() {
        if (!host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.openInChrome();
            }
        });
    }

    /** P0：本地页桥方法，工作台不可调（host.readClipboard 里还有第二道守卫）。 */
    @JavascriptInterface
    public String paste() {
        if (!host.inShellMode()) return "";
        return host.readClipboard();
    }

    /**
     * 工作台心跳：mobile.js 在内容真的渲染出来之后打卡，证明网页 JS 还活着。
     * 只在工作台生效，本地页调了直接丢弃。
     */
    @JavascriptInterface
    public void pageReady() {
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.onWebAlive();
            }
        });
    }

    /**
     * 本地页左上角「返回」：回主界面（工作台）。
     * 只在本地页生效 —— 工作台页面不该能凭空把自己导航回去。
     */
    @JavascriptInterface
    public void backToWorkbench() {
        if (!host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.shellBackToWorkbench();
            }
        });
    }

    /**
     * 本地页「刷新 / 清除缓存并刷新」：收起配置层并刷新工作台。
     * 只在本地页生效（工作台页不能靠这个重置自己）。
     */
    @JavascriptInterface
    public void refreshWorkbench(final boolean clearCache) {
        if (!host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.refreshFromShell(clearCache);
            }
        });
    }

    /**
     * 本地页「扫码」：进 App 内实时取景扫码页。
     * 相机权限由主 Activity 在进入前申请；这里只做本地页守卫。
     */
    @JavascriptInterface
    public void scan() {
        if (!host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.requestScan();
            }
        });
    }

    /**
     * 齿轮 = App 自己的配置页入口：进原生设置页（改地址/端口），
     * 断网、红字、白屏都能点（原生页不依赖网页）。
     * 只在工作台生效；本地页调了直接丢弃（本地页自己就有改地址 UI）。
     */
    @JavascriptInterface
    public void openSetup() {
        if (host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.showSetup();
            }
        });
    }

    /**
     * 斜杠指令菜单弹出时收键盘：只 hide，不 blur。
     * blur 会让官方菜单失焦关掉；hideSoftInput 只收键盘，页面焦点和菜单都还在。
     * 只在工作台生效。
     */
    @JavascriptInterface
    public void hideKeyboard() {
        if (host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.hideImeForWeb();
            }
        });
    }

    /** 指令选完后把键盘还回来（配合网页里同步 focus 编辑器）。 */
    @JavascriptInterface
    public void showKeyboard() {
        if (host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.showImeForWeb();
            }
        });
    }

    // ---------------------------------------------------------- 0.9.4 自愈桥
    //
    // 方向是"网页报异常，原生给活路"：网页只描述**真异常**（JS 抛错），
    // 处置权在原生（横幅 + 原生按钮），因为网页坏了的时候它自己也点不动。
    // 都在工作台生效，本地页调了直接丢弃。
    // 0.9.8 删掉了 reportBlank：它靠"主内容区有没有字"判断，而空的新会话本来就是空白，
    // 这条会被正常页面天天命中。

    /** 网页捕获到 JS 异常时上报（只记账，短时间内连发才弹横幅）。 */
    @JavascriptInterface
    public void reportError(final String detail) {
        if (host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.reportErrorFromWeb(detail);
            }
        });
    }

    /**
     * 本地页的「登录」按钮：把密码交给原生换登录态。
     * 只在本地页生效 —— 工作台页面不该能拿到/使用密码。
     */
    @JavascriptInterface
    public void login(final String password, final boolean remember) {
        if (!host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.loginFromShell(password, remember);
            }
        });
    }

    /** 本地页「诊断」：返回纯文本（版本/地址/登录态/探针/最近错误）。 */
    @JavascriptInterface
    public String diag() {
        if (!host.inShellMode()) return "";
        return host.diagFromShell();
    }

    /**
     * 本地页「推送自检」：悬浮球在健康状态下会自动隐藏，
     * 这个入口必须留在设置页，否则自检就再也点不到了。
     */
    @JavascriptInterface
    public void pushCheck() {
        if (!host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.pushCheckFromShell();
            }
        });
    }

    /** 本地页「退出」：唯一的主动退出入口（原来在悬浮球菜单里）。 */
    @JavascriptInterface
    public void quit() {
        if (!host.inShellMode()) return;
        host.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                host.quitFromShell();
            }
        });
    }
}
