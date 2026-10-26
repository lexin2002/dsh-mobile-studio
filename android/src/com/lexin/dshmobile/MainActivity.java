package com.lexin.dshmobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.graphics.Color;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * 手机版外壳。
 *
 * 它不是一个独立应用：页面来自电脑上的网关（默认 3081 端口），
 * 这里只负责「装一个专用浏览器窗口 + 记住地址 + 兜住各种连不上」。
 *
 * 两态（1.2.0 重写导航后）：
 *   shellMode = true   显示本地页（设置页 / 连不上页，见 assets/shell.html）
 *   shellMode = false  显示电脑上的 /m
 * 桥 Shell 只在本地页期间生效，真实页面调不动它。
 *
 * 导航铁律（场景三/四的教训）：
 *   1. 本地页永不进历史记录（进出都 clearHistory），杜绝过期 setup 页复活。
 *   2. 工作台永不 goBack：DSH 单页应用不改地址栏，历史栈里除了脏页什么都没有。
 *      返回键只有两条出路：网页消费（__msBack）→ 弹菜单，永远确定。
 */
public class MainActivity extends Activity {
    /** 前台标记：前台时不发系统通知（用户要求）。 */
    static volatile boolean sForeground = false;

    static final String TAG = "DshMobile";
    private static final String PREFS = "dsh-mobile";
    private static final String KEY_URL = "url";
    private static final String KEY_NOTIF_ASKED = "notif-asked";
    private static final int DEFAULT_PORT = 3081;

    // 通知渠道：完成 / 需要处理，id 由 PushService 按「代」生成
    // （dsh-tasks-<gen> / dsh-attention-<gen>），每次重建换一代才能改声音。
    // 轮询只是 SSE 前台服务的兜底，真正的主路见 PushService。
    // 轮询间隔：前台 4 秒（人正盯着，通知要"按时"）、后台 12 秒（省电）。
    // 「漏不漏」跟间隔无关 —— 判定靠 finishedAt 时刻表比大小（见 pollTasksOnce），
    // 间隔只决定最多晚多久弹出来。
    private static final long POLL_MS_FOREGROUND = 4000;
    private static final long POLL_MS_BACKGROUND = 12000;
    private volatile long pollMs = POLL_MS_BACKGROUND;
    // 完成时刻基线：sessionId → 上次见到的 finishedAt。
    // **跨前后台、跨轮询线程重启都不清**：以前每次 startWatching 都新建一份，
    // 切回前台等于把离开期间完成的全部当成"早就知道"吞掉。
    // 0.9.14 起还落盘（push-watermarks）：进程被杀后重开也能接着补，不再靠运气。
    private final java.util.Map<String, Long> lastFinished = new java.util.HashMap<String, Long>();
    private boolean watermarksLoaded = false;
    private static final String KEY_WATERMARKS = "push-watermarks";
    private static final int REQ_NOTIF = 1001;

    // 加载看门狗：工作台 25 秒还没 onPageFinished，就当启动卡死处理
    private static final long BOOT_WATCHDOG_MS = 25000;
    // 0.9.8：网页打卡只表示"mobile.js 挂上了"，与内容多少无关（空的新会话是正常的）。
    // 所以这里的看门狗必须比它长，否则正常慢首屏会被误判成网页已死。
    private static final long PAGE_READY_MS = 30000;
    private boolean pageReadySeen = false;
    private boolean pageDead = false;
    private boolean repairShowing = false;
    private AlertDialog repairDialog = null;
    private boolean backWaiting = false;
    private static final long BACK_TIMEOUT_MS = 600;
    /**
     * 通知点进来要落的会话 id（三方通知里都塞了 sessionId extra）。
     * 冷启动时网页还没就绪，先挂在这里，等 onWebAlive 再派发；
     * 15 秒还派发不出去就放弃 —— 页面迟迟不活是另一个问题，
     * 别把过期的 id 带进下一次（比如用户十分钟后才打开 App）。
     */
    private String pendingSessionId = "";
    private static final long SESSION_OPEN_MS = 15000;
    private final Runnable sessionOpenTimeout = new Runnable() {
        @Override
        public void run() {
            if (pendingSessionId.isEmpty()) return;
            Log.w(TAG, "session open timeout, drop: " + pendingSessionId);
            pendingSessionId = "";
        }
    };
    private ConnectivityManager.NetworkCallback netCallback = null;

    // 悬浮球位置记忆（相对值，横竖屏都成立）
    private static final String KEY_FAB_X = "fab-x";
    private static final String KEY_FAB_Y = "fab-y";

    private WebView web;
    private ProgressBar bar;
    private FileChooser chooser;
    private SharedPreferences prefs;

    /**
     * 配置层（设置页/连不上页）单独住一个 WebView，盖在工作台上面。
     * 以前和工wharf作台共用一个 WebView，showShell 会把工作台页面整个替换掉，
     * 返回只能重新 load —— 这就是"返回一下就刷新"的根因。
     */
    private WebView shellWeb;
    /** 工作台页面当前是否是一份可用页面（返回时据此决定"直接收起"还是"重建"）。 */
    private boolean workbenchReady = false;
    private static final int REQ_SCAN = 4301;
    private static final int REQ_CAMERA = 4302;
    private static final int REQ_TONE = 4303;

    // ---------------------------------------------------------------- 0.9.4 自愈
    //
    // 教训（用户报「白屏后左栏打不开 → 设置打不开 → 无法刷新/改地址」）：
    // 之前的全部健康判定都寄生在网页自己身上 —— mobile.js 无条件打卡说"我活着"，
    // 齿轮又插在抽屉里，抽屉一坏就没有任何出口。所以恢复入口和连通性判定
    // 必须在原生：网页只负责"报异常"，原生负责"给活路"。
    private static final String KEY_AUTH_COOKIE = "auth-cookie";
    private static final String KEY_LOGIN_PW = "login-password";
    private static final String KEY_REMEMBER_PW = "remember-password";

    /** 探针间隔（前台）。只探"电脑还在不在"，不碰网页 JS。 */
    private static final long PROBE_MS = 5000;
    /** 连续几次探不通才算断：一次抖动不该弹横幅。 */
    private static final int PROBE_FAILS = 2;
    private static final int PROBE_CONNECT_TIMEOUT = 4000;
    private static final int PROBE_READ_TIMEOUT = 4000;

    /** 顶部横幅状态：none / offline / login / blank / error。 */
    private String bannerKind = "none";
    private TextView bannerView;
    private String probeState = "unknown"; // alive | needLogin | offline | unknown
    private int probeFailStreak = 0;
    private boolean probeInFlight = false;
    private String lastErrorText = "";
    private long lastErrorAt = 0;
    private int errorBurst = 0;
    private String lastFinalUrl = "";
    private boolean autoLoginTried = false;


    // 悬浮球：工作台常驻入口（刷新/清缓存/改地址/Chrome/退出），可拖动
    private android.widget.Button fab;
    private FrameLayout rootView;

    // 返回键菜单防叠：快速连按只出一张
    private boolean menuShowing = false;
    private AlertDialog menuDialog = null;
    // 返回键标准三层：菜单开着只关菜单 → 网页 __msBack 能消费就消费 →
    // 主页 Toast 双击退出。菜单只走悬浮球 ⋮ 和设置键，返回键不再弹菜单。
    // 关菜单那下 / 被网页消费那下都不算第一次（清计时）。
    private long lastBackPress = 0;
    private static final long DOUBLE_BACK_EXIT_MS = 2000;

    private final android.os.Handler uiHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean loadingWorkbench = false;
    private final Runnable bootWatchdog = new Runnable() {
        @Override
        public void run() {
            if (!loadingWorkbench || shellMode) return;
            loadingWorkbench = false;
            workbenchReady = false;
            showShell("error", "页面长时间未完成加载。可尝试「刷新」或「清除缓存并刷新」。");
        }
    };

    private final Runnable pageReadyWatchdog = new Runnable() {
        @Override
        public void run() {
            if (shellMode || pageReadySeen) return;
            // 0.9.12：不再"等网页打卡等不到就报警"，改成**原生主动问网页**。
            // 为什么：打卡是网页→原生的单向调用，缓存/桥就绪时序/旧页面都可能让它丢了，
            // 页面明明好好的也会被判死（用户 2026-10-26 截图：正文正常却出「脚本没加载出来」）。
            // evaluateJavascript 是原生发起的，能直接确认 JS 是否还在。
            pageAliveAnswered = false;
            uiHandler.removeCallbacks(pageAliveFallback);
            uiHandler.postDelayed(pageAliveFallback, 3000);
            try {
                web.evaluateJavascript(
                        "(function(){try{return String(window.__msVersion||'')}catch(e){return ''}})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                pageAliveAnswered = true;
                                uiHandler.removeCallbacks(pageAliveFallback);
                                if (shellMode) return;
                                String v = value == null ? "" : value;
                                // 非空版本号 = mobile.js 真的跑起来了，什么都不用报
                                if (v.length() > 2) {
                                    pageReadySeen = true;
                                    pageDead = false;
                                    if ("blank".equals(bannerKind)) hideBanner();
                                } else {
                                    markDead();
                                    showBanner("blank", "页面脚本没加载出来 · 点这里处理");
                                }
                            }
                        });
            } catch (Exception e) {
                Log.w(TAG, "page alive check failed: " + e);
                markDead();
                showBanner("blank", "页面脚本没加载出来 · 点这里处理");
            }
        }
    };

    /** 问了页面 3 秒还没回：大概率渲染进程卡死，这时才报。 */
    private boolean pageAliveAnswered = false;
    private final Runnable pageAliveFallback = new Runnable() {
        @Override
        public void run() {
            if (pageAliveAnswered || shellMode) return;
            markDead();
            showBanner("blank", "页面脚本没加载出来 · 点这里处理");
        }
    };

    // 0.9.5 删掉了两处"猜网页死了"的启发式（用户报「没看到错误但 App 弹窗」）：
    //   1. 每 8 秒把整页文字里搜两个英文错误短语 —— 会话正文里只要出现过同款英文
    //      （我们自己就在聊天里聊过），就会被判死；
    //   2. 控制台消息里出现模块路径等字样就弹修复面板 ——
    //      DSH 正常启动就会打这类模块日志，等于每次加载都误报。
    // 现在的判据只保留"确定的"：网页 JS 20 秒没报到（mobile.js 根本没跑）、
    // 原生探针连不上、网页自己调 reportError。

    private final Runnable backTimeout = new Runnable() {
        @Override
        public void run() {
            if (!backWaiting || shellMode) return;
            backWaiting = false;
            // 网页 600ms 没答理 = 这一次它没消费（可能忙、可能真死了）。按"没消费"处理，
            // 走原生的双击退出 —— **绝不能**在这里判死或弹面板：
            // 0.9.16 之前这里调 markDead()，把 pageDead 置真，于是下一次按返回键
            // 直接弹出「页面没有响应」修复面板（用户 2026-10-26：「返回键逻辑又被你改废了」）。
            // 自动出现的只能是横幅，面板只由人手点（长按悬浮球 / 点横幅）。
            backNotConsumed(SystemClock.uptimeMillis());
        }
    };

    /** 网页没消费返回键时的出口：主页双击退出，其他页面弹一次提示（绝不弹面板）。 */
    private void backNotConsumed(long pressTime) {
        if (pressTime - lastBackPress < DOUBLE_BACK_EXIT_MS) {
            finish();
            return;
        }
        lastBackPress = pressTime;
        try {
            Toast.makeText(MainActivity.this, "再按一次退出应用", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            /* toast 挂了不影响计时 */
        }
    }

    private boolean shellMode = true;
    private String currentUrl = null;
    /**
     * 本进程里最后一次真正加载成功的工作台地址（干净 /m）。
     * 配置页/连不上页的返回键与 UI「返回」都回这里 —— 用户要的是
     * 「回到主界面」，不是「退出 App」。冷启动还没成功过时它是 null，
     * 此时返回按老规矩双击退出。
     */
    private String lastGoodUrl = null;

    private Thread watchThread;
    private volatile boolean watching = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        CrashLog.install(this);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // P0：Release 包关 WebView 远程调试，只在 debuggable 构建里开。
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        paintSystemBars();
        buildUi();
        // 悬浮球可见性由这个 1 秒 tick 唯一决定（见 updateFab）：不靠倒计时，
        // 所以探针/心跳怎么高频调用都不会把它"续命"。
        uiHandler.postDelayed(fabTick, 1000);

        chooser = new FileChooser(this);
        startNetMonitor();

        // 冷启动：通知带来的会话 id 先挂起，网页 Ready 后再派发（见 flushPendingSession）
        capturePendingSession(getIntent());

        String saved = prefs.getString(KEY_URL, null);
        if (saved == null) {
            showShell("setup", null);
        } else {
            load(saved);
        }
    }

    /**
     * 已在栈里的入口：通知的 PendingIntent 走的就是这条路（launchMode=singleTask）。
     * 必须 setIntent —— 否则之后任何 getIntent() 读到的还是冷启动那一次的旧 intent。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        capturePendingSession(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        sForeground = true;
        // 前台：拉近轮询，通知尽量"按时"
        pollMs = POLL_MS_FOREGROUND;
        if (!shellMode && currentUrl != null) {
            startWatching();
            // 回到前台立刻探一次：可能就是在后台这段时间电脑关掉了
            startProbe();
        }
        // 回前台先把悬浮球状态算一遍（后台时不跑 tick），再恢复 tick
        uiHandler.removeCallbacks(fabTick);
        updateFab();
        uiHandler.postDelayed(fabTick, 1000);
        // 回到前台：告诉推送服务"人回来了"，别把息屏期间的静默当成断连
        PushService.noteForeground(this);
    }

    @Override
    protected void onPause() {
        // **不能停轮询**。任务完成通知的意义就是"人已经切走了"：
        // 以前这里 stopWatching()，切后台就再也不轮询、网页又被系统冻住，
        // 结果切出去等通知永远收不到；切回来 startWatching 重建基线，
        // 把离开期间完成的全部吞掉。现在只放慢间隔，基线一直留着。
        pollMs = POLL_MS_BACKGROUND;
        // 探针只在看得见的时候跑（省电）；后台任务靠 PushService
        stopProbe();
        uiHandler.removeCallbacks(fabTick);
        super.onPause();
        sForeground = false;
    }

    // ---------------------------------------------------------------- 界面

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        rootView = root;
        root.setBackgroundColor(Color.WHITE);

        web = buildWorkbenchWeb();
        FrameLayout.LayoutParams wlp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
        root.addView(web, wlp);

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(2));
        blp.gravity = Gravity.TOP;
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        root.addView(bar, blp);

        buildFab(root);
        buildBanner(root);

        // 配置层：最后加 = 盖在工作台和悬浮球上面；只有可见时才接收触摸。
        shellWeb = new WebView(this);
        shellWeb.setBackgroundColor(Color.WHITE);
        shellWeb.setOverScrollMode(View.OVER_SCROLL_NEVER);
        configure(shellWeb);
        shellWeb.addJavascriptInterface(new ShellBridge(this), "Shell");
        shellWeb.setWebViewClient(shellClient);
        shellWeb.setWebChromeClient(shellChrome);
        shellWeb.setVisibility(View.GONE);
        root.addView(shellWeb, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    /** 工作台 WebView：独立成方法，渲染进程被回收时能在原位重建。 */
    private WebView buildWorkbenchWeb() {
        WebView v = new WebView(this);
        v.setBackgroundColor(Color.WHITE);
        v.setOverScrollMode(View.OVER_SCROLL_NEVER);
        configure(v);
        v.addJavascriptInterface(new ShellBridge(this), "Shell");
        v.setWebViewClient(client);
        v.setWebChromeClient(chrome);
        return v;
    }

    /**
     * 悬浮球：工作台常驻 ⋮ 入口，默认吸附右边缘中间，可拖到任何地方。
     * 顶栏左右都有官方按钮（汉堡/右侧栏开关），固定放哪都会盖住东西，
     * 只有可拖动的不制造新问题。位置记相对值，横竖屏、换手机都成立。
     * 它是 root 上的独立 View，只吃自己 48dp 里的触摸，不影响网页手势。
     */
    private void buildFab(FrameLayout root) {
        fab = new android.widget.Button(this);
        fab.setText("⋮");
        fab.setTextSize(20);
        fab.setAlpha(0.55f);
        fab.setVisibility(View.GONE);
        final int size = dp(48);
        final FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(size, size);
        flp.gravity = Gravity.TOP | Gravity.START;
        root.addView(fab, flp);
        // 首帧布局完再摆默认位置（右边缘中间），之前存过就用存的
        root.post(new Runnable() {
            @Override
            public void run() {
                placeFab(
                        prefs.getFloat(KEY_FAB_X, -1f),
                        prefs.getFloat(KEY_FAB_Y, 0.5f));
            }
        });
        fab.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startLeft, startTop;
            boolean moved;

            @Override
            public boolean onTouch(View v, android.view.MotionEvent e) {
                FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) v.getLayoutParams();
                switch (e.getAction()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        downX = e.getRawX();
                        downY = e.getRawY();
                        startLeft = p.leftMargin;
                        startTop = p.topMargin;
                        moved = false;
                        return true;
                    case android.view.MotionEvent.ACTION_MOVE: {
                        int dx = Math.round(e.getRawX() - downX);
                        int dy = Math.round(e.getRawY() - downY);
                        if (!moved && Math.hypot(dx, dy) < dp(8)) return true;
                        moved = true;
                        int w = rootView.getWidth() - v.getWidth();
                        int h = rootView.getHeight() - v.getHeight();
                        p.leftMargin = Math.max(0, Math.min(w, startLeft + dx));
                        p.topMargin = Math.max(dp(24), Math.min(h, startTop + dy));
                        v.setLayoutParams(p);
                        return true;
                    }
                    case android.view.MotionEvent.ACTION_UP:
                        if (!moved) {
                            v.performClick();
                            showMenu();
                        } else if (rootView.getWidth() > 0 && rootView.getHeight() > 0) {
                            prefs.edit()
                                    .putFloat(KEY_FAB_X, (float) p.leftMargin / rootView.getWidth())
                                    .putFloat(KEY_FAB_Y, (float) p.topMargin / rootView.getHeight())
                                    .apply();
                        }
                        return true;
                    default:
                        return false;
                }
            }
        });
        fab.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                if (shellMode) return false;
                showRepairPanel();
                return true;
            }
        });
    }

    // ------------------------------------------------------------ 悬浮球自动隐藏
    //
    // 用户 2026-10-26：「我确实嫌弃他」。所以健康 30 秒后收起，一出问题立刻回来——
    // 它仍然是"不依赖网页的恢复入口"，只是不再常驻挡视线。
    // 收起后的常规入口是抽屉里的齿轮（openSetup → 本地设置页），
    // 所以「推送自检 / 退出」也搬进了设置页，功能一个不少。

    /** 悬浮球亮出后至少停这么久，免得刚看见就没了。 */
    private static final long FAB_MIN_SHOW_MS = 30000;
    /** 最近一次异常/横幅之后保持可见的时长。 */
    private static final long ANOMALY_HOLD_MS = 60000;
    private long lastAnomalyAt = 0;
    /** 悬浮球变成可见的时刻，用于"至少停 30 秒"。 */
    private long fabShownAt = 0;

    // 0.9.15：0.9.13 那版用"30 秒倒计时"收起，但探针每 5 秒成功一次就把收起计时重排一次
    // —— 定时器被无限重置，悬浮球于是常驻。唯一的例外是切到后台、探针停了，
    // 那个定时器才有机会跑完（用户看到的正是「切后台回来就没了，前台三分钟还在」）。
    // 现在不用倒计时：改成一个无条件自续的 1 秒 tick，每次重新算一遍判定。
    // 只要条件满足，最多 1 秒必然收起，任何一次调用都取消不掉它。
    private final Runnable fabTick = new Runnable() {
        @Override
        public void run() {
            updateFab();
            uiHandler.postDelayed(this, 1000);
        }
    };

    /** 唯一的可见性判定点：异常中 / 刚异常过 / 刚亮出 → 可见；其余收起。 */
    private void updateFab() {
        if (fab == null) return;
        if (shellMode) {
            fab.setVisibility(View.GONE);
            return;
        }
        long now = SystemClock.uptimeMillis();
        boolean abnormal = pageDead || !"none".equals(bannerKind);
        boolean hold = now - lastAnomalyAt < ANOMALY_HOLD_MS;
        boolean fresh = now - fabShownAt < FAB_MIN_SHOW_MS;
        if (abnormal || hold || fresh) {
            if (fab.getVisibility() != View.VISIBLE) fabShownAt = now;
            fab.setAlpha(abnormal ? 1.0f : 0.55f);
            fab.setVisibility(View.VISIBLE);
        } else if (fab.getVisibility() != View.GONE) {
            fab.setVisibility(View.GONE);
        }
    }

    /** 亮出悬浮球（加载/异常/用户操作时用）；什么时候收仍由 updateFab 决定。 */
    private void showFab() {
        if (fab == null || shellMode) return;
        fabShownAt = SystemClock.uptimeMillis();
        fab.setAlpha(0.55f);
        fab.setVisibility(View.VISIBLE);
    }

    /** 按相对坐标摆悬浮球；x<0 表示没存过，走默认（右边缘中间）。 */
    private void placeFab(float xFrac, float yFrac) {
        if (fab == null || rootView == null) return;
        int w = rootView.getWidth() - fab.getWidth();
        int h = rootView.getHeight() - fab.getHeight();
        if (w <= 0 || h <= 0) return;
        FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) fab.getLayoutParams();
        if (xFrac < 0) {
            p.leftMargin = w - dp(8);
            p.topMargin = h / 2;
        } else {
            p.leftMargin = Math.max(0, Math.min(w, Math.round(xFrac * rootView.getWidth())));
            p.topMargin = Math.max(dp(24), Math.min(h, Math.round(yFrac * rootView.getHeight())));
        }
        fab.setLayoutParams(p);
    }

    /**
     * 顶部横幅：**原生**的恢复入口，只在出问题时出现（正常态零新增 UI）。
     *
     * 为什么不用 AlertDialog 直接弹：白屏/断连有时是几秒的瞬时状态，
     * 弹窗会打断人；横幅先出现，点它才进操作面板。
     * 为什么它必须盖在网页上而不是网页里画：网页本身坏了才需要它。
     */
    private void buildBanner(FrameLayout root) {
        bannerView = new TextView(this);
        bannerView.setVisibility(View.GONE);
        bannerView.setGravity(Gravity.CENTER_VERTICAL);
        bannerView.setPadding(dp(14), dp(10), dp(14), dp(10));
        bannerView.setTextSize(13f);
        bannerView.setTextColor(Color.WHITE);
        bannerView.setBackgroundColor(0xFFB3261E);
        bannerView.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openRecovery();
            }
        });
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.TOP;
        root.addView(bannerView, lp);
    }

    /** 只由 UI 线程调用。kind 决定颜色与操作面板。 */
    private void showBanner(String kind, String text) {
        if (shellMode || bannerView == null) return;
        bannerKind = kind == null ? "none" : kind;
        int color = 0xFFB3261E; // 红：连不上/登录
        if ("blank".equals(bannerKind) || "error".equals(bannerKind)) color = 0xFF8A5A00; // 琥珀：页面有问题
        bannerView.setBackgroundColor(color);
        bannerView.setText(text == null ? "" : text);
        bannerView.setVisibility(View.VISIBLE);
        // 记一笔"刚出过异常"，悬浮球据此保持可见 60 秒
        lastAnomalyAt = SystemClock.uptimeMillis();
        // 一出问题就把悬浮球亮回来：它是不依赖网页的恢复入口
        showFab();
    }

    private void hideBanner() {
        bannerKind = "none";
        if (bannerView != null) bannerView.setVisibility(View.GONE);
        updateFab();
    }

    // 0.9.8：删掉"空白页自动刷新"。它建立在"页面没字就是坏了"这个错误前提上，
    // 而空的新会话正文本来就是空的 —— 自动刷新只会把用户刚打开的新会话刷掉。

    // ------------------------------------------------------- 恢复入口 / 登录 / 诊断

    /**
     * 点横幅弹出的操作面板。**按当前状态给按钮**：
     * 断网时"输入密码"没有意义，登录页时"清除缓存"也解决不了问题。
     */
    void openRecovery() {
        if (shellMode) return;
        final java.util.ArrayList<String> items = new java.util.ArrayList<String>();
        String kind = bannerKind;
        if ("login".equals(kind)) {
            items.add("输入密码");
            items.add("重新扫码");
            items.add("重新配置网址");
            items.add("诊断");
        } else if ("offline".equals(kind)) {
            items.add("重试");
            items.add("重新配置网址");
            items.add("重新扫码");
            items.add("用 Chrome 打开");
            items.add("诊断");
        } else if ("blank".equals(kind) || "error".equals(kind)) {
            items.add("刷新");
            items.add("清除缓存并刷新");
            items.add("重新扫码");
            items.add("重新配置网址");
            items.add("诊断");
        } else {
            items.add("刷新");
            items.add("重新配置网址");
            items.add("诊断");
        }
        final String[] actions = items.toArray(new String[items.size()]);
        showActions("页面不可用", null, actions, new ActionPick() {
            @Override
            public void onPick(int which) {
                String pick = actions[which];
                if ("输入密码".equals(pick)) promptPassword();
                else if ("重新扫码".equals(pick)) requestScan();
                else if ("重新配置网址".equals(pick)) showShell("setup", null);
                else if ("诊断".equals(pick)) showDiagnostics();
                else if ("用 Chrome 打开".equals(pick)) openInChrome();
                else if ("重试".equals(pick) || "刷新".equals(pick)) refreshWorkbench(false);
                else if ("清除缓存并刷新".equals(pick)) refreshWorkbench(true);
            }
        });
    }

    /** 原生密码框（不依赖网页）。勾了「记住密码」才存本机，默认勾。 */
    void promptPassword() {
        if (shellMode) return;
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        input.setHint("电脑端设置的访问密码");
        input.setSingleLine(true);
        final CheckBox remember = new CheckBox(this);
        remember.setText("记住密码（存本机）");
        remember.setChecked(prefs.getBoolean(KEY_REMEMBER_PW, true));
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, dp(6), pad, 0);
        box.addView(input, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        box.addView(remember);
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("登录电脑端");
        b.setView(box);
        b.setPositiveButton("登录", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int which) {
                doLogin(input.getText().toString().trim(), remember.isChecked(), true);
            }
        });
        b.setNegativeButton("取消", null);
        b.setNeutralButton("重新扫码", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int which) {
                requestScan();
            }
        });
        try {
            b.show();
        } catch (Exception e) {
            Log.w(TAG, "login dialog failed: " + e);
        }
    }

    /** 用密码换登录态：成功会把 ms_auth Cookie 落进 CookieManager + prefs。 */
    void doLogin(final String pw, final boolean remember, final boolean interactive) {
        if (pw == null || pw.isEmpty()) {
            if (interactive) promptPassword();
            return;
        }
        prefs.edit().putBoolean(KEY_REMEMBER_PW, remember).apply();
        if (remember) prefs.edit().putString(KEY_LOGIN_PW, pw).apply();
        else prefs.edit().remove(KEY_LOGIN_PW).apply();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String result = postLogin(pw);
                uiHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (isFinishing()) return;
                        if ("ok".equals(result)) {
                            hideBanner();
                            Toast.makeText(MainActivity.this, "已登录", Toast.LENGTH_SHORT).show();
                            String target = currentUrl;
                            if (target == null || target.isEmpty()) target = prefs.getString(KEY_URL, null);
                            if (target != null) load(target);
                        } else if ("bad".equals(result)) {
                            // 密码错了就别再自动重试（网关有 30 秒退避，重试只会更长）
                            prefs.edit().remove(KEY_LOGIN_PW).apply();
                            if (interactive) {
                                Toast.makeText(MainActivity.this, "密码不正确", Toast.LENGTH_SHORT).show();
                                promptPassword();
                            } else {
                                showBanner("login", "需要登录电脑端 · 点这里");
                            }
                        } else {
                            if (interactive) {
                                Toast.makeText(MainActivity.this, "登录失败：检查网络或地址", Toast.LENGTH_SHORT).show();
                            }
                            showBanner("offline", "连不上电脑 · 点这里");
                        }
                    }
                });
            }
        }).start();
    }

    /** 后台线程：POST /__ms/login，拿 302 里的 Set-Cookie，写进 WebView 的 Cookie 库。 */
    private String postLogin(String pw) {
        String base = currentUrl;
        if (base == null || base.isEmpty()) base = prefs.getString(KEY_URL, null);
        if (base == null || base.isEmpty()) return "error";
        String origin = originOf(base);
        if (origin == null) return "error";
        HttpURLConnection c = null;
        try {
            URL url = new URL(origin + "/__ms/login");
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(8000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            byte[] body = ("password=" + URLEncoder.encode(pw, "UTF-8") + "&next=%2Fm").getBytes("UTF-8");
            c.setFixedLengthStreamingMode(body.length);
            java.io.OutputStream os = c.getOutputStream();
            os.write(body);
            os.flush();
            os.close();
            int code = c.getResponseCode();
            if (code == 302 || code == 303) {
                String pair = cookiePairFrom(c.getHeaderField("Set-Cookie"));
                if (pair.isEmpty()) return "bad";
                try {
                    CookieManager.getInstance().setCookie(origin + "/", pair + "; Path=/; Max-Age=2592000");
                    CookieManager.getInstance().flush();
                } catch (Exception e) {
                    Log.w(TAG, "set cookie failed: " + e);
                }
                prefs.edit().putString(KEY_AUTH_COOKIE, pair).apply();
                return "ok";
            }
            if (code == 401 || code == 429) return "bad";
            return "error";
        } catch (Exception e) {
            Log.w(TAG, "login failed: " + e);
            return "error";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            String authority = u.getEncodedAuthority();
            if (scheme == null || authority == null) return null;
            return scheme + "://" + authority;
        } catch (Exception e) {
            return null;
        }
    }

    /** "ms_auth=v1.xxx; Path=/; HttpOnly" → "ms_auth=v1.xxx"。不是登录 Cookie 就返回空串。 */
    private static String cookiePairFrom(String setCookie) {
        if (setCookie == null) return "";
        int semi = setCookie.indexOf(';');
        String pair = (semi >= 0 ? setCookie.substring(0, semi) : setCookie).trim();
        return pair.startsWith("ms_auth=") ? pair : "";
    }

    /** 把 WebView 当前的登录 Cookie 落盘：换 IP、重启 App 都不用再登录。 */
    private void rememberSessionCookie() {
        String base = currentUrl;
        if (base == null || base.isEmpty()) return;
        try {
            String all = CookieManager.getInstance().getCookie(base);
            if (all == null) return;
            for (String part : all.split(";")) {
                String s = part.trim();
                if (s.startsWith("ms_auth=")) {
                    prefs.edit().putString(KEY_AUTH_COOKIE, s).apply();
                    return;
                }
            }
        } catch (Exception e) {
            /* 拿不到就按未登录走 */
        }
    }

    /**
     * 每次导航前把上次的登录 Cookie 种回去。
     * 为什么按"新地址"种而不是按旧地址：电脑的局域网 IP 会变，
     * Cookie 值本身与主机无关，种到新 origin 上照样有效。
     */
    private void restoreSessionCookie(String url) {
        try {
            String pair = prefs.getString(KEY_AUTH_COOKIE, "");
            if (pair == null || pair.isEmpty()) return;
            String origin = originOf(url);
            if (origin == null) return;
            CookieManager.getInstance().setCookie(origin + "/", pair + "; Path=/; Max-Age=2592000");
            CookieManager.getInstance().flush();
        } catch (Exception e) {
            /* 种不上就按未登录走，登录页会给横幅 */
        }
    }

    boolean hasSessionCookie() {
        String base = currentUrl;
        if (base == null || base.isEmpty()) base = prefs.getString(KEY_URL, "");
        if (base == null || base.isEmpty()) return false;
        try {
            String all = CookieManager.getInstance().getCookie(base);
            return all != null && all.contains("ms_auth=");
        } catch (Exception e) {
            return false;
        }
    }

    /** 落到登录页：给横幅，必要时用记住的密码自动试一次（只试一次）。 */
    private void onLoginPage() {
        workbenchReady = false;
        showBanner("login", "需要登录电脑端 · 点这里");
        // 提示一下：这也是"扫码后仍要密码"的现场
        Toast.makeText(this, "这个页面需要电脑端密码：可点顶部横幅扫码或输入密码", Toast.LENGTH_LONG).show();
        if (autoLoginTried) return;
        autoLoginTried = true;
        String pw = prefs.getString(KEY_LOGIN_PW, "");
        if (!pw.isEmpty()) doLogin(pw, true, false);
    }

    // ------------------------------------------------------------- 连通性探针

    /**
     * 探针：只问"电脑还在不在 + 要不要登录"，完全不碰网页 JS。
     * 用 /m/__ms/hello（网关自己的端点，不需要上游）：返回 302 到 /__ms/login
     * 就说明"电脑在，只是没登录"——这个必须和断网区分开，否则会误导用户去改地址。
     */
    private final Runnable probeTick = new Runnable() {
        @Override
        public void run() {
            if (shellMode || currentUrl == null || currentUrl.isEmpty()) return;
            if (!probeInFlight) {
                probeInFlight = true;
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        final String st = probeOnce();
                        uiHandler.post(new Runnable() {
                            @Override
                            public void run() {
                                probeInFlight = false;
                                if (!isFinishing()) onProbeResult(st);
                            }
                        });
                    }
                }).start();
            }
            uiHandler.postDelayed(this, PROBE_MS);
        }
    };

    private String probeOnce() {
        String base = currentUrl;
        if (base == null || base.isEmpty()) return "dead";
        String origin = originOf(base);
        if (origin == null) return "dead";
        String probeUrl = origin + "/m/__ms/hello";
        HttpURLConnection c = null;
        try {
            URL url = new URL(probeUrl);
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(PROBE_CONNECT_TIMEOUT);
            c.setReadTimeout(PROBE_READ_TIMEOUT);
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod("GET");
            try {
                String cookie = CookieManager.getInstance().getCookie(probeUrl);
                if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            } catch (Exception e) {
                /* 没 Cookie 也能判断连通 */
            }
            int code = c.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307) {
                String loc = c.getHeaderField("Location");
                if (loc != null && loc.contains("/__ms/login")) return "needLogin";
                return "alive";
            }
            // 4xx/5xx 说明电脑在（只是页面/服务有问题），按"活着"处理
            return "alive";
        } catch (Exception e) {
            return "dead";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void onProbeResult(String st) {
        if (shellMode) return;
        probeState = st;
        if ("dead".equals(st)) probeFailStreak += 1;
        else probeFailStreak = 0;
        if (probeFailStreak >= PROBE_FAILS) {
            showBanner("offline", "连不上电脑 · 点这里");
            return;
        }
        if ("needLogin".equals(st)) {
            showBanner("login", "需要登录电脑端 · 点这里");
            return;
        }
        // 探针这条 5 秒一次的路径**不许**碰悬浮球计时：0.9.13 就是它一直重排收起计时，
        // 让悬浮球永远收不起来。收起全交给 updateFab 的 1 秒 tick。
        if ("offline".equals(bannerKind) || "login".equals(bannerKind)) hideBanner();
    }

    private void startProbe() {
        if (shellMode) return;
        uiHandler.removeCallbacks(probeTick);
        uiHandler.postDelayed(probeTick, 900);
    }

    private void stopProbe() {
        uiHandler.removeCallbacks(probeTick);
        probeInFlight = false;
    }

    // ---------------------------------------------------------------- 诊断

    /** 自检/诊断弹窗：没有 adb 也能把现场抄给开发者。 */
    void showDiagnostics() {
        String text = diagText();
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("诊断");
        b.setMessage(text);
        b.setPositiveButton("关闭", null);
        b.setNeutralButton("复制", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int which) {
                copyToClipboard(diagText());
                Toast.makeText(MainActivity.this, "已复制", Toast.LENGTH_SHORT).show();
            }
        });
        try {
            b.show();
        } catch (Exception e) {
            Log.w(TAG, "diag dialog failed: " + e);
        }
    }

    String diagText() {
        StringBuilder sb = new StringBuilder();
        sb.append("版本 v").append(appVersion()).append('\n');
        sb.append("地址 ").append(currentUrl == null ? "(无)" : currentUrl).append('\n');
        sb.append("落地 ").append(lastFinalUrl.isEmpty() ? "(还没成功加载过)" : lastFinalUrl).append('\n');
        sb.append("登录态 ").append(hasSessionCookie() ? "已登录" : "未登录").append('\n');
        sb.append("连通 ").append(probeState)
                .append("（失败连击 ").append(probeFailStreak).append("）\n");
        sb.append("工作台就绪 ").append(workbenchReady ? "是" : "否").append('\n');
        sb.append("最近错误 ").append(lastErrorText.isEmpty() ? "(无)" : lastErrorText).append('\n');
        try {
            sb.append("WebView ").append(web.getSettings().getUserAgentString()).append('\n');
        } catch (Exception e) {
            /* 拿不到就算了 */
        }
        return sb.toString();
    }

    private String appVersion() {
        try {
            String v = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            return v == null ? "" : v;
        } catch (Exception e) {
            return "";
        }
    }

    void copyToClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("DSH", text));
        } catch (Exception e) {
            Log.w(TAG, "copy failed: " + e);
        }
    }

    // 0.9.8：删掉"网页上报内容空白"的整条通道（host 与桥各一个方法）。
    // 它建立在"主内容区没字 = 页面坏了"这个错误前提上；空的新会话正文本来就是空的，
    // 这个上报只会把正常页面报成故障。网页现在只报"真异常"（JS 抛错）。

    /** 网页上报 JS 异常：先记账，短时间内连发三次才弹横幅（单次偶发不打扰）。 */
    void reportErrorFromWeb(String detail) {
        if (shellMode) return;
        String d = detail == null ? "" : detail;
        if (d.length() > 300) d = d.substring(0, 300);
        lastErrorText = d;
        long now = System.currentTimeMillis();
        if (now - lastErrorAt > 60000) errorBurst = 0;
        lastErrorAt = now;
        errorBurst += 1;
        stageLog("error(" + errorBurst + "):" + d);
        if (errorBurst >= 3 && !"blank".equals(bannerKind)) {
            showBanner("error", "页面脚本报错 · 点这里");
        }
    }

    private void stageLog(String line) {
        try {
            Log.i(TAG, "web: " + line);
        } catch (Exception e) {
            /* 日志失败不影响行为 */
        }
    }

    private void paintSystemBars() {
        Window w = getWindow();        w.setStatusBarColor(Color.WHITE);
        w.setNavigationBarColor(Color.WHITE);
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        w.getDecorView().setSystemUiVisibility(flags);
    }

    private void configure(WebView v) {
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 页面自带 viewport meta，必须开 useWideViewPort 才会被采用；
        // 关掉 overviewMode，否则窄屏会被缩成一张缩略图。
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        // 页面 meta 里没有 user-scalable=no，缩放过之后固定定位的抽屉会错位。
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // 系统字体调大会把整页放大，布局直接崩；固定 100%。
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    }

    // ------------------------------------------------------------ WebView 回调

    private final WebViewClient client = new WebViewClient() {

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            String scheme = u.getScheme() == null ? "" : u.getScheme();
            if (scheme.equals("http") || scheme.equals("https")) return false;   // 全部在壳里开
            // mailto: / tel: / intent: 交给系统
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception e) {
                Log.w(TAG, "cannot open " + u + " : " + e);
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            if (shellMode) {
                // 本地页：清掉历史，过期 setup 永不复活（场景三/四的总根因）
                try {
                    v.clearHistory();
                } catch (Exception e) {
                    Log.w(TAG, "clearHistory failed: " + e);
                }
                return;
            }
            // 网关登录页（手动填地址 + 密码开启、或扫到旧的无票据二维码）：
            // 它不会加载 mobile.js，绝不能按「20 秒没 pageReady」判死弹修复面板。
            if (isLoginPage(url) || isLoginPage(v.getUrl())) {
                loadingWorkbench = false;
                lastFinalUrl = v.getUrl();
                uiHandler.removeCallbacks(bootWatchdog);
                uiHandler.removeCallbacks(pageReadyWatchdog);
                uiHandler.removeCallbacks(backTimeout);
                backWaiting = false;
                pageReadySeen = true;   // 登录页是活页面；登录成功跳到 /m 后会重新武装
                pageDead = false;
                workbenchReady = false; // 登录页不算可用工作台
                dismissRepair();
                bar.setVisibility(View.GONE);
                // 0.9.4：这里以前把悬浮球藏了。结果人被留在登录页上——
                // 没有扫码、没有改地址、返回键只会退 App，只能手打密码。
                // 现在悬浮球保留，并且额外给一条原生横幅（输入密码/重新扫码）。
                showFab();
                try {
                    v.clearHistory();
                } catch (Exception e) {
                    Log.w(TAG, "clearHistory failed: " + e);
                }
                try {
                    CookieManager.getInstance().flush();
                } catch (Exception e) {
                    Log.w(TAG, "cookie flush failed: " + e);
                }
                onLoginPage();
                // 登录页没有任务可轮询：不启动推送/轮询，免得往登录页打一堆 302
                return;
            }
            bar.setVisibility(View.GONE);
            // 工作台加载完成：撤看门狗，清历史（工作台自己的历史也没有用，
            // DSH 单页应用不改地址栏），亮悬浮球
            loadingWorkbench = false;
            lastFinalUrl = url;
            // 记下「真正能用」的地址：配置页/连不上页的返回键回这里
            lastGoodUrl = currentUrl;
            workbenchReady = true;
            hideBanner();
            // 登录态落盘：换 IP、重启 App 都还能免登录
            rememberSessionCookie();
            uiHandler.removeCallbacks(bootWatchdog);
            try {
                v.clearHistory();
            } catch (Exception e) {
                Log.w(TAG, "clearHistory failed: " + e);
            }
            // 30 秒后收：真正的"健康"还要等 onWebAlive 把 pageReadySeen 置真
            showFab();
            pageReadySeen = false;
            pageDead = false;
            dismissRepair();
            uiHandler.removeCallbacks(pageReadyWatchdog);
            uiHandler.postDelayed(pageReadyWatchdog, PAGE_READY_MS);
            try {
                CookieManager.getInstance().flush();
            } catch (Exception e) {
                Log.w(TAG, "cookie flush failed: " + e);
            }
            requestNotifPermissionIfNeeded();
            startWatching();
            // 主路：前台服务挂着 SSE 长连接等推送（轮询只作兜底，见 pollTasksOnce）
            startPushService();
            // 原生探针：页面活着不代表电脑还活着（电脑中途关掉时页面不会报错）
            startProbe();
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            workbenchReady = false;
            showShell("error", describe(err));
        }

        @Override
        public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse res) {
            if (!req.isForMainFrame()) return;
            if (res.getStatusCode() >= 500) {
                workbenchReady = false;
                showShell("error", "电脑上的服务返回了 " + res.getStatusCode()
                        + (res.getReasonPhrase() == null ? "" : "（" + res.getReasonPhrase() + "）")
                        + "。多半是 DSH 没在运行。");
            }
        }

        /**
         * 工作台渲染进程被系统回收（配置层停留太久、内存紧张时会发生）。
         * 旧 WebView 必须移除销毁，原位换一个新的，再给"刷新"入口 —— 否则白屏假活。
         */
        @Override
        public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
            workbenchReady = false;
            try {
                rootView.removeView(v);
            } catch (Exception e) {
                /* 已经不在树上 */
            }
            try {
                v.destroy();
            } catch (Exception e) {
                /* 尽量销毁，失败也不阻塞重建 */
            }
            web = buildWorkbenchWeb();
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
            rootView.addView(web, 0, lp);
            showShell("error", "工作台页面被系统回收了，点「刷新」重新加载。");
            return true;
        }
    };

    private final WebChromeClient chrome = new WebChromeClient() {

        @Override
        public void onProgressChanged(WebView v, int p) {
            if (shellMode) return;
            bar.setProgress(p);
            bar.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            String msg = "";
            try {
                msg = String.valueOf(m.message());
            } catch (Exception e) {
                msg = "";
            }
            Log.i(TAG, "console: " + msg + " @" + m.lineNumber());
            // 0.9.5：删掉"按控制台关键字判死"。
            // DSH 正常启动就会打印模块路径（含 client-modules）、预加载日志，
            // 按子串匹配等于每次加载都弹一次「页面崩了」——用户 2026-10-26 报的就是它。
            // 真正的脚本异常由网页侧 reportError 明确上报，不再靠猜。
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                         WebChromeClient.FileChooserParams params) {
            return chooser != null && chooser.show(cb, params);
        }
    };

    /**
     * 配置层自己的 WebViewClient：本地页只做 clearHistory，
     * 绝不走工作台的加载看门狗/错误页逻辑（那会干扰下面的工作台页面）。
     */
    private final WebViewClient shellClient = new WebViewClient() {
        @Override
        public void onPageFinished(WebView v, String url) {
            try {
                v.clearHistory();
            } catch (Exception e) {
                Log.w(TAG, "shell clearHistory failed: " + e);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            // 本地页理论上不导航；万一有外链，交给系统浏览器，别把配置层做没了。
            Uri u = req.getUrl();
            String scheme = u.getScheme() == null ? "" : u.getScheme();
            if (scheme.equals("http") || scheme.equals("https")) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (Exception e) {
                Log.w(TAG, "shell cannot open " + u + " : " + e);
            }
            return true;
        }
    };

    /** 配置层的 chrome：只保留相册选择与日志（扫码走原生 ScanActivity）。 */
    private final WebChromeClient shellChrome = new WebChromeClient() {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            try {
                Log.i(TAG, "shell console: " + m.message() + " @" + m.lineNumber());
            } catch (Exception e) {
                /* 日志失败不影响页面 */
            }
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                         WebChromeClient.FileChooserParams params) {
            return chooser != null && chooser.show(cb, params);
        }
    };

    private String describe(WebResourceError e) {
        if (e == null) return "无法连接电脑。";
        int code = e.getErrorCode();
        String d = e.getDescription() == null ? "" : e.getDescription().toString();
        String detail = d.isEmpty() ? "" : "（" + d + "）";
        switch (code) {
            case WebViewClient.ERROR_HOST_LOOKUP:
                return "找不到这台电脑" + detail + "。确认手机和电脑连的是同一个 Wi-Fi。";
            case WebViewClient.ERROR_CONNECT:
                return "连不上电脑上的服务" + detail + "。确认电脑上的 DSH 正在运行。";
            case WebViewClient.ERROR_TIMEOUT:
                return "连接超时" + detail + "。电脑可能刚休眠，等几秒再重试。";
            default:
                return "加载失败" + detail + "。";
        }
    }

    // ---------------------------------------------------------------- 加载

    void load(String url) {
        loadTarget(url, url);
    }

    /**
     * 扫二维码时「导航地址」和「记住的地址」不是一回事：
     * 导航要带票据（/__ms/qr?t=…）才能换到登录 Cookie，但存进 prefs、
     * 喂给推送/轮询的必须是干净 /m（否则下次启动、SSE、任务轮询都带着票据路径）。
     */
    private void loadTarget(String target, String canonical) {
        // 先收起配置层（不动旧页面），再把新地址加载进工作台 WebView
        if (shellMode) hideShell();
        currentUrl = canonical;
        shellMode = false;
        workbenchReady = false;
        pageReadySeen = false;
        pageDead = false;
        backWaiting = false;
        lastBackPress = 0;
        autoLoginTried = false;
        hideBanner();
        dismissRepair();
        // 登录态先种回去：换 IP/重启后也能免登录，少走一次登录页
        restoreSessionCookie(target);
        // 悬浮球从"开始加载"就亮：白屏时它是唯一不依赖网页的出口。
        // 加载完 30 秒仍健康才由 updateFab 收起。
        showFab();
        bar.setProgress(0);
        bar.setVisibility(View.VISIBLE);
        // 武装看门狗：25 秒还没 onPageFinished 就是启动卡死（图三），切错误页给真入口
        loadingWorkbench = true;
        uiHandler.removeCallbacks(bootWatchdog);
        uiHandler.postDelayed(bootWatchdog, BOOT_WATCHDOG_MS);
        try {
            web.loadUrl(target);
        } catch (Exception e) {
            showShell("error", "地址无效：" + e);
        }
    }

    /**
     * 显示配置层。只加载 shellWeb、盖在工作台上：
     * 工作台 WebView 不动，所以返回时不用重新加载（会话、滚动位置都还在）。
     */
    void showShell(String kind, String message) {
        shellMode = true;
        stopWatching();
        loadingWorkbench = false;
        uiHandler.removeCallbacks(bootWatchdog);
        uiHandler.removeCallbacks(pageReadyWatchdog);
        uiHandler.removeCallbacks(backTimeout);
        backWaiting = false;
        dismissMenu();
        dismissRepair();
        // 配置层自己有全套按钮：横幅/探针都停，别在本地页上瞎报"断网"
        hideBanner();
        stopProbe();
        hideIme();
        if (fab != null) {
            fab.setVisibility(View.GONE);
        }
        bar.setVisibility(View.GONE);
        String html = readAsset("shell.html");
        if (html == null) {
            shellWeb.loadDataWithBaseURL(null, "<h3>assets/shell.html 缺失</h3>", "text/html", "utf-8", null);
            shellWeb.setVisibility(View.VISIBLE);
            return;
        }
        // 扫码解码库内嵌注入：本地页是 loadDataWithBaseURL，外链 <script src> 会当网络请求 404。
        // jsqr.js 是生成物（见 tools/build-scan.mjs），正文里不能出现 </script。
        String scanLib = readAsset("jsqr.js");
        String inject;
        if (scanLib != null) {
            inject = "<script>" + scanLib + "</script>";
        } else {
            // 库没打进包时不能让整页脚本挂掉：留个标记，页面把扫码按钮降级成提示。
            inject = "<script>window.__scanLibMissing=true;</script>";
        }
        html = html.replace("<!--SCANLIB-->", inject);
        String init = "<script>window.__shellInit=" + shellJson(kind, message) + ";</script>";
        html = html.replace("<!--INIT-->", init);
        shellWeb.loadDataWithBaseURL("http://shell.local/", html, "text/html", "utf-8", null);
        shellWeb.setVisibility(View.VISIBLE);
    }

    /**
     * 收起配置层，回到工作台原页面：**不 loadUrl、不刷新**。
     * 只有工作台还没有可用页面时才需要调用方自己重建（见 shellBackToWorkbench）。
     */
    void hideShell() {
        if (!shellMode) return;
        shellMode = false;
        hideIme();
        if (shellWeb != null) shellWeb.setVisibility(View.GONE);
        if (workbenchReady) {
            if (bar != null) bar.setVisibility(View.GONE);
            showFab();
            if (currentUrl != null) {
                startWatching();
                startPushService();
                startProbe();
            }
        }
    }

    private void hideIme() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm == null) return;
            View focus = getCurrentFocus();
            if (focus != null && focus.getWindowToken() != null) {
                imm.hideSoftInputFromWindow(focus.getWindowToken(), 0);
            }
        } catch (Exception e) {
            /* 收键盘失败不影响主流程 */
        }
    }

    /** 网页调：只收键盘、不 blur，官方 ` / ` 指令菜单不会因为失焦被关掉。 */
    void hideImeForWeb() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm == null || web == null) return;
            imm.hideSoftInputFromWindow(web.getWindowToken(), 0);
        } catch (Exception e) {
            /* 收不起来就算了，页面还有 focus 兜底 */
        }
    }

    /** 网页调：选完指令后把键盘还回来（WebView 仍有窗口焦点时 showSoftInput 才会生效）。 */
    void showImeForWeb() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm == null || web == null) return;
            web.requestFocus();
            imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
        } catch (Exception e) {
            /* 系统忽略就由网页再 focus 一次 */
        }
    }

    private String shellJson(String kind, String message) {
        String saved = prefs.getString(KEY_URL, "");
        String ua = "";
        try {
            ua = web.getSettings().getUserAgentString();
        } catch (Exception e) {
            /* 拿不到就空着 */
        }
        String appVer = "";
        try {
            appVer = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            if (appVer == null) appVer = "";
        } catch (Exception e) {
            /* 拿不到就空着 */
        }
        return "{kind:" + q(kind)
                + ",msg:" + q(message == null ? "" : message)
                + ",current:" + q(currentUrl == null ? "" : currentUrl)
                + ",saved:" + q(saved)
                + ",canReturn:" + (workbenchReady || (lastGoodUrl != null && !lastGoodUrl.isEmpty()))
                + ",canRefresh:" + ((currentUrl != null && !currentUrl.isEmpty()) || (saved != null && !saved.isEmpty()))
                // 0.9.4：登录态/探针/最近错误 都要能在本地页看到，否则"没 adb 也能查"是空话
                + ",loggedIn:" + hasSessionCookie()
                + ",probe:" + q(probeState)
                + ",lastError:" + q(lastErrorText)
                + ",appVer:" + q(appVer)
                + ",agent:" + q(ua) + "}";
    }

    /** 极简 JSON 字符串转义（含 < >，避免注入到 script 里断开）。 */
    private static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 16);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                case '<': b.append("\\u003c"); break;
                case '>': b.append("\\u003e"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        b.append('"');
        return b.toString();
    }

    private String readAsset(String name) {
        InputStream in = null;
        try {
            in = getAssets().open(name);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), "UTF-8");
        } catch (IOException e) {
            Log.e(TAG, "asset " + name + " missing", e);
            return null;
        } finally {
            try {
                if (in != null) in.close();
            } catch (IOException e) {
                /* noop */
            }
        }
    }

    // ---------------------------------------------------------------- 地址
    // 规则全部在 UrlRules（纯 Java、无 Android 依赖，电脑上能直接跑单测）。

    /** 整理输入/扫码得到的地址；失败返回 null。 */
    static String normalize(String raw) {
        return UrlRules.normalize(raw);
    }

    /** 存 prefs / 喂推送用的干净地址：扫码登录路径归一成 /m。 */
    static String workbenchUrlFor(String normalized) {
        return UrlRules.workbenchUrlFor(normalized);
    }

    /** 网关登录页不是「网页崩了」：它本来就不会加载 mobile.js。 */
    private static boolean isLoginPage(String url) {
        return UrlRules.isLoginPage(url);
    }

    // ------------------------------------------------- 给 ShellBridge 用的入口
    // JavascriptInterface 的回调跑在 JavaBridge 线程，凡是碰界面的都必须切回主线程。

    /** 供 ShellBridge 判断：本地页（true）还是工作台（false）。 */
    boolean inShellMode() {
        return shellMode;
    }

    String resolveInput(String raw) {
        if (!shellMode) return "";
        String u = normalize(raw);
        return u == null ? "" : u;
    }

    void connectInput(String raw) {
        if (!shellMode) return;
        applyScannedUrl(raw);
    }

    /**
     * 落一个扫码/粘贴来的地址。**两种模式都能用**：
     * 登录页、白屏页上只有原生横幅能扫码，而那时 shellMode 是 false。
     * 票据地址只用于本次导航，存下来的必须是干净 /m（见 UrlRules.workbenchUrlFor）。
     */
    void applyScannedUrl(String raw) {
        String u = normalize(raw);
        if (u == null) {
            Toast.makeText(this, "二维码不是有效的连接地址", Toast.LENGTH_SHORT).show();
            return;
        }
        String store = workbenchUrlFor(u);
        if (store == null) return;
        prefs.edit().putString(KEY_URL, store).apply();
        hideBanner();
        loadTarget(u, store);
    }

    /**
     * 配置页「刷新 / 清除缓存并刷新」：先收起配置层，再按既有规范刷新工作台。
     * 刷新过程必须可见（进度条 + Toast + 25 秒看门狗），不能只关菜单了事。
     */
    void refreshFromShell(boolean clearCache) {
        if (!shellMode) return;
        String target = currentUrl;
        if (target == null || target.isEmpty()) target = prefs.getString(KEY_URL, null);
        if (target == null || target.isEmpty()) {
            Toast.makeText(this, "尚未配置连接地址", Toast.LENGTH_SHORT).show();
            return;
        }
        hideShell();
        if (currentUrl == null || currentUrl.isEmpty()) {
            load(target);
        } else {
            refreshWorkbench(clearCache);
        }
    }

    /**
     * 扫码入口。0.9.4 起**不再要求 shellMode**：
     * 登录页/白屏页的原生横幅也要能扫码，否则"扫码登录"在最需要它的时候用不了。
     */
    void requestScan() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchScanner();
            return;
        }
        try {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        } catch (Exception e) {
            showScanFallbackDialog();
        }
    }

    private void launchScanner() {
        try {
            startActivityForResult(new Intent(this, ScanActivity.class), REQ_SCAN);
        } catch (Exception e) {
            Log.w(TAG, "scan activity failed: " + e);
            showScanFallbackDialog();
        }
    }

    /** 相机权限被拒/相机不可用：给三条不依赖实时取景的出路，不反复弹授权。 */
    private void showScanFallbackDialog() {
        if (!shellMode) {
            // 工作台/登录页里没有本地页的相册入口：先切到配置页，那里有「从相册选择」
            Toast.makeText(this, "相机不可用，已切到配置页：可从相册选二维码", Toast.LENGTH_LONG).show();
            showShell("setup", null);
            return;
        }
        showActions("无法使用实时扫码",
                "可以改用相册中的二维码图片，或调用系统相机拍一张；相机权限可在系统设置中开启。",
                new String[]{"从相册选择", "用系统相机拍摄"},
                new ActionPick() {
                    @Override
                    public void onPick(int which) {
                        if (which == 0) callShellJs("window.__msPickGallery&&window.__msPickGallery()");
                        else if (which == 1) callShellJs("window.__msPickSystemCamera&&window.__msPickSystemCamera()");
                    }
                });
    }

    /** 调本地页里的兜底入口（相册 / 系统相机），只在配置层可见时有效。 */
    private void callShellJs(final String js) {
        if (shellWeb == null) return;
        try {
            shellWeb.evaluateJavascript(js, null);
        } catch (Exception e) {
            Log.w(TAG, "shell js failed: " + e);
        }
    }

    /** 齿轮入口：工作台任何状态下点一下就回原生设置页（改地址/端口）。 */
    void showSetup() {
        if (shellMode) return;
        showShell("setup", null);
    }

    /**
     * 本地页 UI「返回」按钮：回主界面。没有可回的工作台时只提示、不退出
     * （显式点返回却把 App 关掉是反直觉的；系统返回键仍保留双击退出）。
     */
    void shellBackToWorkbench() {
        if (!shellMode) return;
        if (workbenchReady) {
            // 工作台页面还在底下：直接收起配置层，零刷新
            lastBackPress = 0;
            hideShell();
            return;
        }
        String good = lastGoodUrl;
        if (good != null && !good.isEmpty()) {
            lastBackPress = 0;
            hideShell();
            load(good);
            return;
        }
        Toast.makeText(this, "尚未建立工作台连接，请扫码或填写地址", Toast.LENGTH_SHORT).show();
    }

    void openInChrome() {
        // 注意：这里不加 shellMode 守卫 —— 悬浮球菜单的「用 Chrome 打开」
        // 在工作台也要用。桥入口的守卫在 ShellBridge.openChrome 里。
        String u = currentUrl;
        if (u == null || u.isEmpty()) u = prefs.getString(KEY_URL, null);
        if (u == null) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
        } catch (Exception e) {
            Toast.makeText(this, "没找到可用的浏览器", Toast.LENGTH_SHORT).show();
        }
    }

    String readClipboard() {
        // P0：本地页桥方法，工作台不可调（防页面内第三方代码读剪贴板）。
        if (!shellMode) return "";
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return "";
            ClipData d = cm.getPrimaryClip();
            if (d == null || d.getItemCount() == 0) return "";
            CharSequence t = d.getItemAt(0).coerceToText(this);
            return t == null ? "" : t.toString().trim();
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 本地页的「登录」：只在这里允许（工作台页面调不动）。
     * 用户报「无法配置网址密码」——这就是 App 侧配置密码的入口。
     */
    void loginFromShell(String pw, boolean remember) {
        if (!shellMode) return;
        doLogin(pw, remember, true);
    }

    /** 本地页「推送自检」：悬浮球隐藏后，这里是唯一入口。 */
    void pushCheckFromShell() {
        if (!shellMode) return;
        showPushCheck();
    }

    /** 本地页「退出」：悬浮球隐藏后，这里是唯一主动退出入口。 */
    void quitFromShell() {
        if (!shellMode) return;
        finish();
    }

    /** 本地页诊断：纯文本，直接塞进 <pre>。 */
    String diagFromShell() {
        if (!shellMode) return "";
        return diagText();
    }

    /** 起推送前台服务（主路）：服务里挂着 SSE 长连接等宿主推「turn 结束」。 */
    void startPushService() {
        if (currentUrl == null || currentUrl.isEmpty()) return;
        PushService.start(this, currentUrl);
    }

    // ------------------------------------------------------------ 任务推送（兜底轮询）
    //
    // 主路是 PushService 的长连接；这里保留一套低频轮询作兜底：
    // 服务被系统杀掉、或连接一直失败时，还能靠它把完成补弹出来。
    // 两条路用同一个 turnId 去重（PushService.markSeenOnce），不会双弹。

    void startWatching() {
        if (watching) return;
        if (currentUrl == null) return;
        watching = true;
        watchThread = new Thread(new Runnable() {
            @Override
            public void run() {
                while (watching) {
                    try {
                        pollTasksOnce();
                    } catch (Exception e) {
                        Log.w(TAG, "task poll failed: " + e);
                    }
                    try {
                        Thread.sleep(pollMs);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
        });
        watchThread.start();
    }

    void stopWatching() {
        watching = false;
        Thread t = watchThread;
        watchThread = null;
        if (t != null) t.interrupt();
    }

    /** 从 prefs 读回水位线（只读一次；坏了当空表，不阻塞轮询）。 */
    private void ensureWatermarks() {
        if (watermarksLoaded) return;
        watermarksLoaded = true;
        try {
            String raw = prefs.getString(KEY_WATERMARKS, "{}");
            JSONObject o = new JSONObject(raw);
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                lastFinished.put(k, Long.valueOf(o.optLong(k, 0)));
            }
        } catch (Exception e) {
            Log.w(TAG, "watermarks load: " + e);
        }
    }

    /** 落盘水位线：进程被杀后重开还能接着补，不把离开期间完成的吞掉。 */
    private void saveWatermarks() {
        try {
            JSONObject o = new JSONObject();
            for (java.util.Map.Entry<String, Long> e : lastFinished.entrySet()) {
                o.put(e.getKey(), e.getValue().longValue());
            }
            prefs.edit().putString(KEY_WATERMARKS, o.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "watermarks save: " + e);
        }
    }

    void pollTasksOnce() {
        ensureWatermarks();
        String base = currentUrl;
        if (base == null) return;
        String tasksUrl;
        try {
            Uri u = Uri.parse(base);
            String authority = u.getEncodedAuthority();
            if (authority == null) return;
            tasksUrl = u.getScheme() + "://" + authority + "/m/__ms/tasks";
        } catch (Exception e) {
            return;
        }
        java.net.HttpURLConnection c = null;
        try {
            java.net.URL url = new java.net.URL(tasksUrl);
            c = (java.net.HttpURLConnection) url.openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestMethod("GET");
            try {
                String cookie = CookieManager.getInstance().getCookie(tasksUrl);
                if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            } catch (Exception e) {
                /* 拿不到就匿名试，网关没设密码时本来也不需要 */
            }
            if (c.getResponseCode() != 200) return;
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            java.io.InputStream in = c.getInputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            JSONObject root = new JSONObject(out.toString("UTF-8"));
            if (!root.optBoolean("ok", false)) return;
            JSONArray arr = root.optJSONArray("sessions");
            if (arr == null) return;
            java.util.Set<String> seen = new java.util.HashSet<String>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.optJSONObject(i);
                if (s == null) continue;
                String id = s.optString("id", "");
                if (id.isEmpty()) continue;
                seen.add(id);
                long finishedAt = s.optLong("finishedAt", 0);
                Long prev = lastFinished.get(id);
                // 比大小判完成：finishedAt 是宿主在 turn 结束那一刻打的点。
                // 不再看 running 翻转 —— 两次轮询之间开始又结束的短任务，
                // 两次都读到 running=false，翻转判定会整条漏掉。
                //
                // 0.9.14：水位线**落盘**（原来只在内存 + 一个 watchSeeded 布尔）。
                // 进程被杀/服务重启后重新播种会把"离开期间完成的"全部吞掉，
                // 用户看到的就是"通知时有时无"。现在 prev 跨重启都在；
                // 只有超过 15 分钟的陈旧完成才静默补记，避免一开 App 炸一串旧通知。
                long age = System.currentTimeMillis() - finishedAt;
                if (prev != null && finishedAt > prev.longValue() && age <= 15 * 60 * 1000L) {
                    notifyTaskDone(id, s.optString("title", ""), finishedAt,
                            s.optString("finishedKind", "done"));
                }
                lastFinished.put(id, Long.valueOf(finishedAt));
            }
            // 消失的会话移出基线，避免 map 无限长大
            java.util.Iterator<String> it = lastFinished.keySet().iterator();
            while (it.hasNext()) {
                if (!seen.contains(it.next())) it.remove();
            }
            saveWatermarks();
        } catch (Exception e) {
            Log.w(TAG, "task poll failed: " + e);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) return true;
        try {
            return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    /** 首次进工作台时申请一次；拒绝就记住，不再打扰。 */
    void requestNotifPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (prefs.getBoolean(KEY_NOTIF_ASKED, false)) return;
        try {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                prefs.edit().putBoolean(KEY_NOTIF_ASKED, true).apply();
                return;
            }
            prefs.edit().putBoolean(KEY_NOTIF_ASKED, true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        } catch (Exception e) {
            Log.w(TAG, "notif permission failed: " + e);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_CAMERA) {
            boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                launchScanner();
            } else if (shellMode) {
                // 拒绝后不再反复申请：直接给相册/系统相机/取消三条降级出路
                showScanFallbackDialog();
            }
            return;
        }
        if (code == REQ_NOTIF) {
            prefs.edit().putBoolean(KEY_NOTIF_ASKED, true).apply();
        }
    }

    void notifyTaskDone(String sessionId, String title, long finishedAt, String kind) {
        try {
            if (!canPostNotifications()) return;
            String k = (kind == null || kind.isEmpty()) ? "done" : kind;
            String id = sessionId + ":" + finishedAt;
            // 和推送主路共用同一个 id（宿主侧两者用同一个 at 生成），
            // 谁先到谁写；后到的看到已存在就不再弹。
            if (!PushService.markSeenOnce(this, id)) return;
            String chId = PushService.channelId(this, "done".equals(k));
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String text = PushService.textFor(k, title, "");
            String sid = sessionId == null ? "" : sessionId;
            Intent back = new Intent(this, MainActivity.class);
            back.setAction(Intent.ACTION_MAIN);
            back.addCategory(Intent.CATEGORY_LAUNCHER);
            if (!sid.isEmpty()) back.putExtra("sessionId", sid);
            // requestCode 不能一律 0：FLAG_UPDATE_CURRENT 按 (requestCode, intent) 复用，
            // 同一个 0 会让后一条通知的 extras 覆盖前一条，点哪条都跳到同一个会话。
            PendingIntent pi = PendingIntent.getActivity(
                    this, sid.isEmpty() ? 0 : sid.hashCode(), back,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(this, chId)
                    .setContentTitle(PushService.titleFor(k))
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true)
                    .setCategory("done".equals(k)
                            ? Notification.CATEGORY_STATUS : Notification.CATEGORY_REMINDER)
                    .build();
            nm.notify(PushService.notificationId(id), n);
        } catch (Exception e) {
            Log.w(TAG, "notify failed: " + e);
        }
    }

    // 0.9.6：删掉 `notifyTaskFromWeb`（两版重载）。它是 1.x 时代「网页发现任务完成 →
    // 调 Shell.notifyTask 弹通知」的入口；mobile.js 早就把那段整段删了（判定搬到宿主 +
    // 原生），桥方法随即成了死代码，只有它自己在调用自己。
    // 现在通知只有两条真实路径：PushService（主路）与 pollTasksOnce → notifyTaskDone（兜底）。

    // ---------------------------------------------------------------- 返回键
    //
    // 工作台永不 goBack。DSH 单页应用不改地址栏，历史栈里除了
    // 误入的脏页什么都没有，goBack 只会复活过期 setup 页（场景三/四）。
    // 返回键标准三层：菜单开着只关菜单 → 网页消费（__msBack 关抽屉/弹窗/三格/
    // 回子页上一页）→ 主页 Toast 双击退出。菜单只走悬浮球 ⋮ 和设置键。

    // ---------------------------------------------------------------- 通知深链
    //
    // 通知点进来的目标会话：网页侧入口是 window.__msOpenSession('<sessionId>')。
    // 不能在拿到的瞬间就 evaluateJavascript —— 冷启动时 mobile.js 还没挂载，
    // __msOpenSession 根本不存在，调用会静默失败。统一「先挂起 → onWebAlive 派发」。

    /** 从 intent 里取 sessionId 挂起；空/非法 id 直接忽略，保持「只打开 App」的老行为。 */
    private void capturePendingSession(Intent intent) {
        try {
            if (intent == null) return;
            String sid = intent.getStringExtra("sessionId");
            if (sid == null) return;
            sid = sid.trim();
            // 会话 id 的字符集只有 [A-Za-z0-9_-]；别的一律当没拿到，
            // 不给畸形字符任何进 JS 的机会（真正拼串时还会再转义一次）。
            if (sid.isEmpty() || !sid.matches("[A-Za-z0-9_-]{1,128}")) return;
            pendingSessionId = sid;
            uiHandler.removeCallbacks(sessionOpenTimeout);
            uiHandler.postDelayed(sessionOpenTimeout, SESSION_OPEN_MS);
            flushPendingSession();
        } catch (Exception e) {
            Log.w(TAG, "capture session: " + e);
        }
    }

    /** 页面就绪就派发一次并清空；没就绪就留着，等 onWebAlive 再来。 */
    private void flushPendingSession() {
        if (pendingSessionId.isEmpty()) return;
        // 工作台壳（设置页/连不上页）里没有会话可开，绝不往壳里派发；
        // id 先留着，壳收起后 onWebAlive 还有一次机会（15 秒上限兜底）。
        if (shellMode) return;
        if (!pageReadySeen) return;
        // 登录页也满足 pageReadySeen（它登录成功后会跳 /m），可它上面根本没有
        // mobile.js / __msOpenSession，派发等于把 id 直接扔掉 —— 等真工作台就绪再说。
        if (!workbenchReady) return;
        String sid = pendingSessionId;
        pendingSessionId = "";
        uiHandler.removeCallbacks(sessionOpenTimeout);
        try {
            // JSONObject.quote 负责转义：即使以后放宽字符集校验也拼不出坏 JS
            web.evaluateJavascript("window.__msOpenSession(" + JSONObject.quote(sid) + ")", null);
        } catch (Exception e) {
            Log.w(TAG, "open session failed: " + e);
        }
    }

    /** mobile.js 打卡：网页 JS 还活着，撤掉加载后看门狗。 */
    void onWebAlive() {
        if (shellMode) return;
        pageReadySeen = true;
        pageDead = false;
        uiHandler.removeCallbacks(pageReadyWatchdog);
        if (repairShowing) dismissRepair();
        // 内容回来了：把"没加载出来/脚本报错"的横幅撤掉（探针横幅由探针自己管）
        if ("blank".equals(bannerKind) || "error".equals(bannerKind)) hideBanner();
        // 网页真的活了：健康判定的起点（收起由 updateFab 的 tick 决定）
        updateFab();
        // 通知带来的会话 id 到这里才有地方可派发（mobile.js 已挂载）
        flushPendingSession();
    }

    /** 标记网页已死：悬浮球高亮提示，返回键不再问网页。 */
    void markDead() {
        if (shellMode) return;
        pageDead = true;
        // 只记"刚出过异常"，可见性交给 updateFab 算：异常 60 秒后仍会自动收起，
        // 不存在"取消了一次计时就永远收不起来"这种状态。
        lastAnomalyAt = SystemClock.uptimeMillis();
        updateFab();
    }

    private void dismissRepair() {
        repairShowing = false;
        AlertDialog d = repairDialog;
        repairDialog = null;
        if (d != null) {
            try {
                d.dismiss();
            } catch (Exception e) {
                /* 页面切走了，关不掉就算 */
            }
        }
    }

    /**
     * 原生修复面板：网页死活与它无关的可点活路。
     * 沿用菜单的 AlertDialog 形态，不增新依赖：重试 / 清缓存重试 /
     * 改地址 / 用 Chrome 打开。主页零加按钮。
     */
    void startNetMonitor() {
        if (netCallback != null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            netCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onLost(Network n) {
                    uiHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (shellMode) return;
                            // 0.9.16：网络切换（WiFi↔5G）是常态，不碰 pageDead。
                            // pageDead 只表示"网页脚本没回应"，一旦被网络事件污染，
                            // 返回键就会弹出修复面板（用户报的「返回键被改废」）。
                            showBanner("offline", "手机没网了 · 点这里");
                        }
                    });
                }

                @Override
                public void onAvailable(Network n) {
                    uiHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                // 只有页面真在错误态才提示；正常状态下静默（用户反馈这条总弹）
                                if ("offline".equals(bannerKind) || pageDead) {
                                    Toast.makeText(MainActivity.this, "网络恢复了，点重试继续", Toast.LENGTH_SHORT).show();
                                }
                            } catch (Exception e) {
                                /* toast 挂了不影响计时 */
                            }
                        }
                    });
                }
            };
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (Exception e) {
            Log.w(TAG, "netmon failed: " + e);
            netCallback = null;
        }
    }

    void stopNetMonitor() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && netCallback != null) cm.unregisterNetworkCallback(netCallback);
        } catch (Exception e) {
            /* 关不掉就算进程都要没了 */
        }
        netCallback = null;
    }

    /** 动作列表的回调（用下标，调用方自己 switch）。 */
    interface ActionPick {
        void onPick(int index);
    }

    /**
     * 动作列表对话框：标题 + 说明 + 一组**真按钮**。
     *
     * 为什么不用 `AlertDialog.setItems`：本机（澎湃OS）上 `setMessage` + `setItems` 只渲染
     * message，列表一个都不出现 —— 用户 2026-10-26 看到的正是「弹窗说下面四个都是原生按钮，
     * 结果只有一个取消」。这不是老代码"烂"，是那个组合在部分 ROM 上不可靠；
     * 自己拼一个 LinearLayout 就与 ROM 无关了（顺便每个按钮 48dp，手指好点）。
     *
     * @return 已显示的对话框（调用方可以挂 onDismiss / 记引用），失败返回 null。
     */
    AlertDialog showActions(String title, String message, String[] actions, final ActionPick pick) {
        if (actions == null || actions.length == 0) return null;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(18);
        box.setPadding(pad, dp(2), pad, dp(2));
        if (message != null && !message.isEmpty()) {
            TextView msg = new TextView(this);
            msg.setText(message);
            msg.setTextSize(13f);
            msg.setLineSpacing(dp(2), 1f);
            msg.setPadding(0, dp(6), 0, dp(10));
            box.addView(msg, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        }
        final AlertDialog[] holder = new AlertDialog[1];
        for (int i = 0; i < actions.length; i++) {
            final int idx = i;
            android.widget.Button btn = new android.widget.Button(this);
            btn.setText(actions[i]);
            btn.setAllCaps(false);
            btn.setTextSize(15f);
            btn.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            btn.setPadding(dp(8), 0, dp(8), 0);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(48));
            lp.topMargin = dp(2);
            box.addView(btn, lp);
            btn.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    AlertDialog d = holder[0];
                    if (d != null) {
                        try {
                            d.dismiss();
                        } catch (Exception e) {
                            /* 关不掉也照常执行动作 */
                        }
                    }
                    try {
                        pick.onPick(idx);
                    } catch (Exception e) {
                        Log.w(TAG, "action failed: " + idx + " " + e);
                    }
                }
            });
        }
        android.widget.ScrollView sv = new android.widget.ScrollView(this);
        sv.addView(box);
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle(title == null ? "DSH" : title);
        b.setView(sv);
        b.setNegativeButton("取消", null);
        try {
            AlertDialog d = b.show();
            holder[0] = d;
            return d;
        } catch (Exception e) {
            Log.w(TAG, "actions dialog failed: " + e);
            return null;
        }
    }

    void showRepairPanel() {
        showRepairPanel(null);
    }

    void showRepairPanel(String reason) {
        if (shellMode || repairShowing) return;
        if (reason == null) {
            reason = "页面没有响应（或没加载出来）。下面都是原生按钮，不依赖网页。";
        }
        repairShowing = true;
        final String[] items = new String[]{"重试", "清缓存并重试", "改地址", "用 Chrome 打开"};
        final AlertDialog d = showActions("DSH", reason, items, new ActionPick() {
            @Override
            public void onPick(int which) {
                if (which == 0) {
                    refreshWorkbench(false);
                } else if (which == 1) {
                    refreshWorkbench(true);
                } else if (which == 2) {
                    showShell("setup", null);
                } else {
                    openInChrome();
                }
            }
        });
        repairDialog = d;
        if (d == null) {
            repairShowing = false;
            return;
        }
        d.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface dd) {
                repairShowing = false;
                if (repairDialog == dd) repairDialog = null;
                lastBackPress = 0;
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (shellMode) {
            // 配置页/连不上页不再「一按就退出」：工作台页面还在就直接收起（零刷新）；
            // 页面不在了但有历史地址就重建；冷启动没成功过才双击退出。
            if (workbenchReady) {
                lastBackPress = 0;
                hideShell();
                return;
            }
            String good = lastGoodUrl;
            if (good != null && !good.isEmpty()) {
                lastBackPress = 0;
                hideShell();
                load(good);
                return;
            }
            long now = SystemClock.uptimeMillis();
            if (now - lastBackPress < DOUBLE_BACK_EXIT_MS) {
                finish();
                return;
            }
            lastBackPress = now;
            try {
                Toast.makeText(MainActivity.this, "再按一次退出应用", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                /* toast 挂了不影响计时 */
            }
            return;
        }
        // 第一层：菜单开着按返回只关菜单，清计时，不退出；这一下不算第一次
        if (menuShowing || menuDialog != null) {
            dismissMenu();
            lastBackPress = 0;
            return;
        }
        if (repairShowing || repairDialog != null) {
            dismissRepair();
            lastBackPress = 0;
            return;
        }
        // 0.9.16：这里原本有一条「pageDead → 弹修复面板」的分支。
        // pageDead 会被「返回键 600ms 没回应」和「网络切换时 onLost」置真，
        // 于是下一次按返回键不是退出、而是弹「页面没有响应」面板 —— 用户报的正是这个。
        // 返回键只有一个职责：让网页消费，不消费就双击退出；面板只由人手点开。
        // 第二层：先问网页能不能消费（关抽屉/弹窗/三格/回子页上一页）
        // 网页已死时 evaluateJavascript 可能永远不回：600ms 超时按死了处理。
        final long pressTime = SystemClock.uptimeMillis();
        backWaiting = true;
        uiHandler.removeCallbacks(backTimeout);
        uiHandler.postDelayed(backTimeout, BACK_TIMEOUT_MS);
        web.evaluateJavascript(
                "(function(){try{return (window.__msBack&&window.__msBack())?'1':'0'}catch(e){return '0'}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        // 600ms 超时已经先处理过这一次了：别再重复弹提示/重复 exit
                        if (!backWaiting) return;
                        backWaiting = false;
                        uiHandler.removeCallbacks(backTimeout);
                        if ("\"1\"".equals(value)) {
                            // 网页消费了：不清算，不算第一次
                            lastBackPress = 0;
                            return;
                        }
                        // 第三层：网页不消费，双击 2 秒才退
                        backNotConsumed(pressTime);
                    }
                });
    }

    private void dismissMenu() {
        menuShowing = false;
        AlertDialog d = menuDialog;
        menuDialog = null;
        if (d != null) {
            try {
                d.dismiss();
            } catch (Exception e) {
                /* 页面切走了，关不掉就算 */
            }
        }
    }

    private void showMenu() {
        // 快速连按只出一张（场景四）
        if (menuShowing) return;
        menuShowing = true;
        final String[] items = new String[]{"刷新", "清除缓存并刷新", "重新配置网址", "推送自检", "用 Chrome 打开", "退出"};
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("DSH");
        b.setItems(items, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int which) {
                if (which == 0) {
                    refreshWorkbench(false);
                } else if (which == 1) {
                    refreshWorkbench(true);
                } else if (which == 2) {
                    showShell("setup", null);
                } else if (which == 3) {
                    showPushCheck();
                } else if (which == 4) {
                    openInChrome();
                } else {
                    finish();
                }
            }
        });
        b.setNegativeButton("取消", null);
        // 菜单开着按返回：只关菜单，清计时，不退出；这一下不算第一次。
        // showMenu 只给悬浮球 ⋮ 和以后的设置键调用，返回键不再经过这里。
        b.setOnKeyListener(new DialogInterface.OnKeyListener() {
            @Override
            public boolean onKey(DialogInterface d, int keyCode, android.view.KeyEvent event) {
                if (keyCode != KeyEvent.KEYCODE_BACK || event.getAction() != KeyEvent.ACTION_UP) return false;
                dismissMenu();
                lastBackPress = 0;
                return true;
            }
        });
        b.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface d) {
                menuShowing = false;
                if (menuDialog == d) menuDialog = null;
                lastBackPress = 0;
            }
        });
        try {
            menuDialog = b.show();
        } catch (Exception e) {
            Log.w(TAG, "menu failed: " + e);
            menuShowing = false;
            menuDialog = null;
        }
    }

    /**
     * 后台推送自检：把「通知权限 / 前台服务是否真进前台 / SSE 连没连上 /
     * 最近一次通知 / 省电白名单」摊开，没有 adb 也能看出卡在哪一步。
     */
    private void showPushCheck() {
        showActions("后台推送自检", PushService.diagnose(this),
                new String[]{"发一条测试通知", "选择提示音", "重建通知渠道",
                        "打开本渠道设置", "应用信息", "保活设置（自启动/省电）",
                        "加入电池白名单", "重连推送", "清除崩溃记录"},
                new ActionPick() {
                    @Override
                    public void onPick(int which) {
                        if (which == 0) {
                            PushService.postTest(MainActivity.this);
                        } else if (which == 1) {
                            pickTone();
                        } else if (which == 2) {
                            PushService.rebuildChannels(MainActivity.this);
                            Toast.makeText(MainActivity.this, "已重建渠道，再发一条测试通知", Toast.LENGTH_SHORT).show();
                        } else if (which == 3) {
                            openChannelSettings();
                        } else if (which == 4) {
                            openAppSettings();
                        } else if (which == 5) {
                            if (!Vendor.open(MainActivity.this)) {
                                Toast.makeText(MainActivity.this, "这台机器没有专门的自启动页，去应用信息里找", Toast.LENGTH_LONG).show();
                            }
                        } else if (which == 6) {
                            if (!Vendor.requestIgnoreBatteryOptimizations(MainActivity.this)) {
                                Toast.makeText(MainActivity.this, "系统不支持一键忽略电池优化，去省电设置里手动选", Toast.LENGTH_LONG).show();
                            }
                        } else if (which == 7) {
                            PushService.stop(MainActivity.this);
                            startPushService();
                            Toast.makeText(MainActivity.this, "已请求重连", Toast.LENGTH_SHORT).show();
                        } else {
                            CrashLog.clear(MainActivity.this);
                            Toast.makeText(MainActivity.this, "已清除崩溃记录", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
    }

    /** 系统铃声选择器：挑一个 MIUI 一定认识的通知音，存下来并重建渠道。 */
    private void pickTone() {
        try {
            Intent i = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);
            i.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION);
            i.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true);
            i.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false);
            String cur = PushService.pickedSoundUri(this);
            if (cur != null) {
                i.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, Uri.parse(cur));
            }
            startActivityForResult(i, REQ_TONE);
        } catch (Exception e) {
            Log.w(TAG, "tone picker failed: " + e);
            Toast.makeText(this, "打不开铃声选择器，试试「打开本渠道设置」手动选", Toast.LENGTH_LONG).show();
        }
    }

    /** 直接跳到当前「需要你处理」渠道页；MIUI 的声音/悬浮开关就在这一页。 */
    private void openChannelSettings() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent i = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                i.putExtra(Settings.EXTRA_CHANNEL_ID, PushService.channelId(this, false));
                startActivity(i);
                return;
            }
        } catch (Exception e) {
            Log.w(TAG, "channel settings failed: " + e);
        }
        openNotificationSettings();
    }

    /** 系统通知设置页：两个渠道的声音/横幅/锁屏显示都在这一页。 */
    private void openNotificationSettings() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                startActivity(i);
                return;
            }
        } catch (Exception e) {
            Log.w(TAG, "notif settings failed: " + e);
        }
        openAppSettings();
    }

    /** 应用信息页：MIUI 的省电策略、自启动、通知权限都在这里，比自造开关可靠。 */
    private void openAppSettings() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "app settings failed: " + e);
            Toast.makeText(this, "打不开系统设置，请手动到「应用管理 → DSH」", Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 工作台刷新（菜单里的两项都走这里，之前误调 retryLoad 导致在工作台直接 return，
     * 菜单关了页面零变化，连滚动都不动——本次根因）。
     * 行为保证两次可见变化：0~100ms 内进度条+Toast 立刻打断旧画面；
     * 随后整页导航丢滚动、重走加载，看门狗继续兜底。
     * 只清 WebView 资源缓存，不碰 Cookie（网关登录态在 Cookie 里）。
     */
    private void refreshWorkbench(boolean clearCache) {
        if (shellMode) return;
        if (currentUrl == null || currentUrl.isEmpty()) return;
        dismissMenu();
        dismissRepair();
        pageReadySeen = false;
        pageDead = false;
        workbenchReady = false;
        backWaiting = false;
        uiHandler.removeCallbacks(pageReadyWatchdog);
        uiHandler.removeCallbacks(backTimeout);
        try {
            web.stopLoading();
        } catch (Exception e) {
            /* 停不掉就继续往下走 */
        }
        if (clearCache) {
            try {
                web.clearCache(true);
            } catch (Exception e) {
                Log.w(TAG, "clearCache failed: " + e);
            }
        }
        bar.setProgress(0);
        bar.setVisibility(View.VISIBLE);
        try {
            Toast.makeText(this, clearCache ? "已清缓存，正在刷新…" : "正在刷新…", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            /* toast 挂了不影响刷新 */
        }
        // 武装看门狗：刷新后 25 秒还没 onPageFinished 同样切错误页，不会静默卡死
        loadingWorkbench = true;
        uiHandler.removeCallbacks(bootWatchdog);
        uiHandler.postDelayed(bootWatchdog, BOOT_WATCHDOG_MS);
        try {
            web.loadUrl(currentUrl);
        } catch (Exception e) {
            showShell("error", "地址无效：" + e);
        }
    }

    private void reloadWithCacheCleared() {
        refreshWorkbench(true);
    }

    /**
     * 连不上页的「清缓存重试」：错误页本身就是 shellMode，
     * 所以这里不清守卫、直接清缓存并加载保存的地址。
     */
    // ---------------------------------------------------------------- 其它

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_SCAN) {
            if (res == RESULT_OK && data != null) {
                String text = data.getStringExtra(ScanActivity.EXTRA_TEXT);
                String u = UrlRules.normalize(text);
                if (u == null) {
                    Toast.makeText(this, "二维码不是有效的连接地址", Toast.LENGTH_SHORT).show();
                } else {
                    // 两种模式都能落地址：登录页/白屏页的横幅扫码走的就是这里
                    applyScannedUrl(text);
                }
            }
            return;
        }
        if (req == REQ_TONE) {
            if (res == RESULT_OK && data != null) {
                Uri uri = data.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
                if (uri != null) {
                    PushService.setPickedSound(this, uri);
                    PushService.rebuildChannels(this);
                    Toast.makeText(this, "已换提示音并重建渠道，发一条测试通知听听", Toast.LENGTH_LONG).show();
                }
            }
            return;
        }
        if (req == REQ_CAMERA) return; // 权限结果走 onRequestPermissionsResult
        if (chooser != null) chooser.onResult(req, res, data);
    }

    @Override
    protected void onDestroy() {
        stopWatching();
        stopNetMonitor();
        stopProbe();
        uiHandler.removeCallbacks(bootWatchdog);
        uiHandler.removeCallbacks(pageReadyWatchdog);
        uiHandler.removeCallbacks(backTimeout);
        uiHandler.removeCallbacks(sessionOpenTimeout);
        uiHandler.removeCallbacks(fabTick);
        dismissMenu();
        dismissRepair();
        if (chooser != null) chooser.cancel(true);
        // 进程结束前扫一遍 captures，0 字节空文件和一天前的旧截图不留给下次。
        FileChooser.sweep(this);
        if (web != null) web.destroy();
        if (shellWeb != null) shellWeb.destroy();
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
