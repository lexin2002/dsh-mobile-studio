package com.lexin.dshmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 任务完成推送：前台服务持有一条 SSE 长连接（GET /m/__ms/push），
 * 宿主在 turn 真正结束时推一帧，这里收到就弹通知。
 *
 * 为什么不是轮询：Android 的 Doze / OEM 省电会推迟甚至吞掉后台定时任务，
 * 「App 主动去问」注定时有时无。换成「保持一条活着的连接等推送」，
 * 问题就从"怎么让轮询可靠"变成"怎么让连接可靠"——后者是能控的。
 *
 * 前台服务类型用 connectedDevice（维持与已配对电脑的连接），
 * 不用 dataSync：Android 15 对 dataSync 有 24 小时累计 6 小时的限额。
 */
public class PushService extends Service {
    private static final String TAG = "dsh-push";
    /**
     * 常驻通知渠道。IMPORTANCE_LOW 而不是 MIN：MIN 在 MIUI 上会被折叠/隐藏，
     * 用户和系统都看不见这条「正在等提醒」，也就没法判断前台服务到底起没起。
     * 渠道重要性创建后改不了，所以直接换新 id。
     */
    private static final String CHANNEL_LINK = "dsh-link-v2";
    private static final String CHANNEL_LINK_LEGACY = "dsh-link";
    private static final int FGS_ID = 4001;
    /** 前台服务启动失败时弹的那条通知；下次成功就撤掉。 */
    private static final int FG_FAIL_ID = 9998;
    /** 「推送自检 → 发测试通知」用的 id，固定一条，重复点只替换。 */
    private static final int TEST_ID = 9997;
    /** 连续 45 秒没读到任何字节（宿主每 20 秒一个心跳）就重连。 */
    private static final int READ_TIMEOUT_MS = 45000;
    /** 首次连上后，超过这么久没有任何字节就认为和电脑断了。 */
    private static final long CONN_ALERT_MS = 3 * 60 * 1000L;
    private static final int CONN_NOTIFY_ID = 9999;
    private static final String PREFS = "dsh-push-seen";
    private static final String KEY_SEEN = "turnIds";
    /** 已收到的最后一条推送时间；重连时作为 since 交给网关补发。 */
    private static final String KEY_LAST_AT = "lastAt";
    /** 通知渠道的「代」：每次重建 +1，用新 id 才能改声音（渠道属性创建后不可改）。 */
    private static final String KEY_GEN = "channelGen";
    /** 用户在系统铃声选择器里挑的提示音，优先于自动挑选。 */
    private static final String KEY_SOUND = "channelSound";
    /**
     * 「音源换代」进度：0/1 = 还没生效（还要再试一次），2 = 已生效。
     * 用计数而不是布尔，是为了失败时最多再试一次就停手 —— 每次换代都要删渠道，
     * 用户手选过的铃声会跟着丢一次，不能因为某台机器怎么都建不出声音就每次启动都删。
     * 0.9.18 起自带音换成「同一段水滴里截出来的三个片段、随机播其中一个」，
     * key 升到 soundV018：老设备必须再换代一次才能拿到这三个渠道。
     */
    private static final String KEY_SOUND_STEP = "soundV018";
    /**
     * 自带提示音的三段（同一段水滴录音里截出的三次滴水）。
     * 三条渠道各绑一段，发通知时随机挑一条 —— 渠道声音建好就锁死，
     * 「每次不一样」只能靠多条渠道实现。
     */
    private static final int[] SOUND_RAW = {R.raw.notify_drop1, R.raw.notify_drop2, R.raw.notify_drop3};
    /**
     * 写进媒体库的那份提示音的 content:// URI 缓存（三段各一条）。
     * pickSound() 只读它、不做媒体库查询 —— 启动路径上不许有 IO（LESSONS 6.67）。
     */
    private static final String KEY_MEDIA_SOUND = "mediaSoundUri";
    private static final String KEY_MEDIA_SOUND_2 = "mediaSoundUri2";
    private static final String KEY_MEDIA_SOUND_3 = "mediaSoundUri3";
    private static final int SEEN_MAX = 200;

    private volatile boolean running = false;
    private Thread worker;
    private Thread watchdog;
    private String base;
    /** 最近一次读到字节的时刻；断连兜底看它。 */
    private volatile long lastByteAt = 0;
    /**
     * 最近一次连上（HTTP 200）的时刻。
     * 断连告警必须同时看它：连接一直在重连成功、只是这段时间没有事件，
     * 不代表"电脑没了"。只盯着 lastByteAt 会在息屏/长思考的空档里误报。
     */
    private volatile long lastConnectOkAt = 0;
    private volatile boolean everConnected = false;
    private volatile boolean connAlerted = false;

    // ---- 自检快照（静态：App 进程里就一个服务，菜单直接读） ----
    static volatile boolean sRunning = false;
    static volatile boolean sFgOk = false;
    static volatile String sFgType = "";
    static volatile String sFgError = "";
    static volatile boolean sConnected = false;
    static volatile long sLastByteAt = 0;
    static volatile long sLastNotifyAt = 0;
    /** 最近一次"人回到 App"的时刻：打开 App 就说明刚才的安静不算断联。 */
    static volatile long sTouchAt = 0;
    static volatile String sLastSseError = "";
    static volatile long sLastSseErrorAt = 0;

    public static void start(Context ctx, String base) {
        try {
            Intent i = new Intent(ctx, PushService.class);
            i.putExtra("base", base);
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            Log.w(TAG, "start failed: " + e);
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, PushService.class));
        } catch (Exception e) {
            Log.w(TAG, "stop failed: " + e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureLinkChannel();
        // 本次启动有没有把提醒渠道整批删过（下面两个一次性迁移都会删）：
        // 删过的话待会儿新建的渠道本来就用新音源，0.9.2 不必再换代白删一次。
        boolean channelsJustReset = false;
        // 一次性回到「1.3.4 全新安装」的状态：代次归零、删净本 App 所有提醒渠道。
        // 1.3.4 在新装设备上能出声，升级上来的设备不行，差别就在这些残留上；
        // 这一步只做一次（resetTo134），之后与本版本行为无关。
        if (!prefs(this).getBoolean("resetTo134", false)) {
            prefs(this).edit().putBoolean("resetTo134", true)
                    .putInt(KEY_GEN, 0)
                    .remove(KEY_SOUND)
                    .commit();
            dropOurChannels(this);
            channelsJustReset = true;
        }
        // 2) 统一提示音：所有机型都改用 App 自带的水滴音。
        //    渠道声音建完就锁死，所以老渠道必须整批删掉重建，只做一次。
        if (prefs(this).getInt("soundMode", 0) < 2) {
            prefs(this).edit().putInt("soundMode", 2)
                    .putInt(KEY_GEN, 0)
                    .remove(KEY_SOUND)
                    .commit();
            dropOurChannels(this);
            channelsJustReset = true;
        }
        // 服务一起来就把两个提醒渠道建好（顺带删掉旧固定 id），
        // 不用等第一条通知才在系统设置里出现。
        dropChannels(this, "dsh-tasks", "dsh-tasks-v2", "dsh-tasks-v3",
                "dsh-attention", "dsh-attention-v3");
        ensureTaskChannel(this);
        ensureAttentionChannel(this);
        // 3) 0.9.3：音源换成用户给的 water-drop.mp3。
        //    渠道属性建好就锁死（AOSP 规则），老设备只有换代重建才能拿到新音源；
        //    换代要删渠道，所以只做一次，并且**保留 KEY_SOUND**（用户手选的音源仍排第一）。
        //    只认一个成功标准：新渠道 getSound() != null。拿不到就如实写日志，
        //    **再也不偷偷换成别的音**（用户 2026-10-26 明确要求：只用标准系统接口，不兜底）。
        int soundVer = prefs(this).getInt(KEY_SOUND_STEP, 0);
        if (soundVer < 2) {
            // 全 App 生命周期里**只在这里**写一次媒体库（三段 mp3，加起来 27KB）。
            // pickSound() 只读 prefs 缓存：启动路径上做 IO 写入会重演 LESSONS 6.67
            // 的 ANR（ForegroundServiceDidNotStartInTime → 闪退）。
            if (cachedMediaSound(this, SOUND_RAW.length - 1) == null) ensureMediaSound(this);
            if (!channelsJustReset) rebuildChannels(this);
            boolean ok = channelSoundOk(this, true) && channelSoundOk(this, false);
            prefs(this).edit().putInt(KEY_SOUND_STEP, ok ? 2 : soundVer + 1).commit();
            if (!ok) {
                Log.w(TAG, "0.9.3 water-drop not accepted by channels, next start retries"
                        + " (attempt " + (soundVer + 1) + "/2, source=" + currentSoundSource(this) + ")");
            }
        }
    }

    /** 删掉本 App 所有形如 dsh-tasks-* / dsh-attention-* 的提醒渠道。 */
    private static void dropOurChannels(Context ctx) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            for (NotificationChannel ch : nm.getNotificationChannels()) {
                String id = ch.getId();
                if (id == null) continue;
                if (id.startsWith("dsh-tasks") || id.startsWith("dsh-attention")) {
                    nm.deleteNotificationChannel(id);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "drop our channels: " + e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String b = intent.getStringExtra("base");
            if (b != null) base = b;
        }
        if (base == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        sRunning = true;
        // 关键：失败不能静默。Android 14+ 的 connectedDevice 前置权限缺失时
        // startForeground 会抛 SecurityException，服务退化成普通后台服务，
        // 一退后台几秒就被冻结 —— 必须让用户看见原因。
        if (!goForeground()) notifyForegroundFailed();
        if (!running) {
            running = true;
            worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    loop();
                }
            }, "dsh-push-sse");
            worker.start();
            startWatchdog();
        }
        // 被系统杀掉后尽量自动回来（强行停止除外，那谁也救不了）
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        sRunning = false;
        sFgOk = false;
        sConnected = false;
        Thread t = worker;
        worker = null;
        if (t != null) t.interrupt();
        Thread w = watchdog;
        watchdog = null;
        if (w != null) w.interrupt();
        cancelConnectionNotice();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------ 连接

    private void loop() {
        long backoff = 1000;
        while (running) {
            HttpURLConnection c = null;
            try {
                String pushUrl = pushUrl();
                if (pushUrl == null) return;
                URL url = new URL(pushUrl);
                c = (HttpURLConnection) url.openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(READ_TIMEOUT_MS);
                c.setRequestMethod("GET");
                c.setRequestProperty("Accept", "text/event-stream");
                String cookie = cookieFor(pushUrl);
                if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                int code = c.getResponseCode();
                if (code != 200) throw new IllegalStateException("http " + code);
                // 连上就复位退避：下一次断线从 1 秒开始重试
                backoff = 1000;
                everConnected = true;
                sConnected = true;
                lastByteAt = System.currentTimeMillis();
                lastConnectOkAt = lastByteAt;
                sLastByteAt = lastByteAt;
                if (connAlerted) {
                    connAlerted = false;
                    cancelConnectionNotice();
                }
                readStream(c.getInputStream());
                sConnected = false;
            } catch (Exception e) {
                if (!running) return;
                sConnected = false;
                sLastSseError = e.toString();
                sLastSseErrorAt = System.currentTimeMillis();
                Log.w(TAG, "sse: " + e);
            } finally {
                if (c != null) c.disconnect();
            }
            if (!running) return;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                return;
            }
            backoff = Math.min(backoff * 2, 60000);
        }
    }

    private String pushUrl() {
        try {
            String b = base;
            if (b == null) return null;
            java.net.URI u = java.net.URI.create(b);
            String authority = u.getAuthority();
            if (authority == null) return null;
            // 带上 since：网关会把断线期间错过的帧补发一次（0.9.14）
            long since = lastEventAt();
            String base2 = u.getScheme() + "://" + authority + "/m/__ms/push";
            return since > 0 ? base2 + "?since=" + since : base2;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 本机收到的最后一条推送时间（毫秒）。
     *
     * 首次启动取"现在"并落盘：否则 since=0 会让网关把缓冲里的历史帧全补发一遍，
     * 一开 App 就炸出一串陈旧通知。落盘之后跨重启都能接着补。
     */
    private long lastEventAt() {
        try {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            long v = p.getLong(KEY_LAST_AT, 0);
            if (v <= 0) {
                v = System.currentTimeMillis();
                p.edit().putLong(KEY_LAST_AT, v).apply();
            }
            return v;
        } catch (Exception e) {
            return 0;
        }
    }

    private void noteEventAt(long at) {
        if (at <= 0) return;
        try {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (at > p.getLong(KEY_LAST_AT, 0)) p.edit().putLong(KEY_LAST_AT, at).apply();
        } catch (Exception e) {
            /* 记不住就下次多补一次，去重兜底 */
        }
    }

    /**
     * 断连兜底：宿主进程死了/电脑睡了自己没法发推送，只能由手机发现
     * “连接上一秒还活着，现在几分钟没心跳了”。首次就连不上不报警，
     * 免得每次开 App 都弹一条。
     */
    private void startWatchdog() {
        if (watchdog != null) return;
        watchdog = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running) {
                    try {
                        Thread.sleep(30000);
                    } catch (InterruptedException e) {
                        return;
                    }
                    try {
                        if (!everConnected || connAlerted) continue;
                        long now = System.currentTimeMillis();
                        // 息屏/没网时不判「宿主失联」：这两种情况手机本来收不到心跳，一醒就弹是误报。
                        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                        if (pm != null && !pm.isInteractive()) {
                            lastByteAt = now;
                            sLastByteAt = now;
                            continue;
                        }
                        if (!hasInternet(PushService.this)) {
                            lastByteAt = now;
                            sLastByteAt = now;
                            continue;
                        }
                        // 判据：**连续**这么久既没有字节、也没有一次成功的连接。
                        // 只看字节会在"连上了但暂时没事件"的安静期误报（用户 2026-10-27：
                        // 「非常快就显示断联，但其实没问题」）。
                        long quiet = now - Math.max(Math.max(lastByteAt, lastConnectOkAt), sTouchAt);
                        if (now - sTouchAt < 60000) {
                            // 刚回到 App：重新开始计时，顺手撤掉可能已经弹出来的断连提醒
                            connAlerted = false;
                            lastByteAt = now;
                            sLastByteAt = now;
                            cancelConnectionNotice();
                            continue;
                        }
                        if (quiet <= CONN_ALERT_MS) continue;
                        connAlerted = true;
                        notifyConnectionLost();
                    } catch (Exception e) {
                        Log.w(TAG, "watchdog: " + e);
                    }
                }
            }
        }, "dsh-push-watchdog");
        watchdog.start();
    }

    /**
     * 人回到 App 了：刷新"有动静"的时刻，并撤掉可能已经弹出来的断连提醒。
     * 为什么要它：息屏/后台时系统冻结网络，连接是被迫断的；一睁眼就弹"和电脑断了"纯属吓人。
     */
    static void noteForeground(Context ctx) {
        sTouchAt = System.currentTimeMillis();
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(CONN_NOTIFY_ID);
        } catch (Exception e) {
            Log.w(TAG, "touch: " + e);
        }
    }

    /** 没网时不算「连接中断」，等网络回来再看心跳。 */
    private static boolean hasInternet(Context ctx) {        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities cap = cm.getNetworkCapabilities(n);
            return cap != null && cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) {
            return true;
        }
    }

    /** 网页登录用的 cookie 就是网关的准入凭据，和 /m/__ms/tasks 一样。 */
    private String cookieFor(String url) {
        try {
            return CookieManager.getInstance().getCookie(url);
        } catch (Exception e) {
            return null;
        }
    }

    private void readStream(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int n;
        while (running && (n = in.read(chunk)) > 0) {
            lastByteAt = System.currentTimeMillis();
            sLastByteAt = lastByteAt;
            buf.write(chunk, 0, n);
            // 按空行切事件（SSE 帧分隔符）
            String all = buf.toString("UTF-8");
            int cut = all.lastIndexOf("\n\n");
            if (cut < 0) {
                // 防止半行缓冲无限长大
                if (buf.size() > 256 * 1024) buf.reset();
                continue;
            }
            String ready = all.substring(0, cut + 2);
            String rest = all.substring(cut + 2);
            buf.reset();
            buf.write(rest.getBytes("UTF-8"));
            for (String block : ready.split("\n\n")) handleBlock(block);
        }
    }

    private void handleBlock(String block) {
        StringBuilder data = null;
        for (String line : block.split("\n")) {
            if (line.startsWith("data:")) {
                if (data == null) data = new StringBuilder();
                data.append(line.substring(5).trim());
            }
            // ':' 开头是注释/心跳，忽略
        }
        if (data == null) return;
        try {
            JSONObject o = new JSONObject(data.toString());
            String kind = o.optString("kind", "done");
            String sessionId = o.optString("sessionId", "");
            String title = o.optString("title", "");
            String detail = o.optString("detail", "");
            // org.json 的坑：字段是 JSON null 时 optString 返回字符串 "null"，
            // 于是通知文案变成「null 完成了」（用户 2026-10-27 截到的那条）。
            if (title == null || "null".equals(title) || "undefined".equals(title)) title = "";
            if (detail == null || "null".equals(detail) || "undefined".equals(detail)) detail = "";
            String id = o.optString("id", "");
            if (id.isEmpty()) id = o.optString("turnId", "");
            if (id.isEmpty()) id = sessionId + ":" + o.optLong("at", 0);
            if (id.isEmpty()) return;
            // 先记下"收到哪一刻"，断线重连时才能让网关从这一点补发
            noteEventAt(o.optLong("at", 0));
            deliver(id, kind, sessionId, title, detail);
        } catch (Exception e) {
            Log.w(TAG, "bad frame: " + e);
        }
    }

    // ------------------------------------------------------------ 去重 + 通知

    /**
     * 去重的关键顺序：**先把 id 落盘，再弹**。
     * 反过来（先弹再存）的话，进程在两步之间被杀，重开就会重弹。
     * 宁可极小概率漏一次，也不要结构上"必然重弹"。
     *
     * 静态版也给轮询兜底用：两条路（推送 / 轮询）拿同一个 turnId
     * （sessionId + ':' + finishedAt，宿主侧同一个 at 生成），谁先到谁写，
     * 后到的那条看到已存在就不再弹。
     */
    public static boolean markSeenOnce(Context ctx, String turnId) {
        if (turnId == null || turnId.isEmpty()) return false;
        try {
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray a = new JSONArray(p.getString(KEY_SEEN, "[]"));
            for (int i = 0; i < a.length(); i++) {
                if (turnId.equals(a.optString(i))) return false;
            }
            JSONArray out = new JSONArray();
            out.put(turnId);
            for (int i = 0; i < a.length() && out.length() < SEEN_MAX; i++) {
                String v = a.optString(i);
                if (v != null && !v.equals(turnId)) out.put(v);
            }
            p.edit().putString(KEY_SEEN, out.toString()).commit();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "markSeen: " + e);
            return true; // 记不上也照弹，宁可多一条也别整条丢掉
        }
    }

    static int notificationId(String id) {
        // 1000..8999；9999 留给连接中断，避免撞车。
        return 1000 + ((id == null ? 0 : id.hashCode()) & 0x7fffffff) % 8000;
    }

    static String titleFor(String kind) {
        if (kind == null) return "DSH 任务完成";
        switch (kind) {
            case "error": return "DSH 任务出错";
            case "interrupted": return "DSH 任务中断";
            case "blocked": return "DSH 任务被阻止";
            case "max-tokens": return "DSH 任务输出达上限";
            case "plan": return "DSH 计划待批准";
            case "question": return "DSH 需要你的回答";
            default: return "DSH 任务完成";
        }
    }

    static String textFor(String kind, String title, String detail) {
        String who = (title == null || title.isEmpty()) ? "" : "「" + title + "」";
        String d = detail == null ? "" : detail.trim();
        if (d.length() > 300) d = d.substring(0, 300) + "…";
        if (kind == null) kind = "done";
        switch (kind) {
            case "error":
                return who + "执行出错" + (d.isEmpty() ? "" : "：" + d) + "，任务没有完成";
            case "interrupted":
                return who + "任务被中断" + (d.isEmpty() ? "" : "：" + d) + "，打开 App 查看";
            case "blocked":
                return who + "任务被阻止" + (d.isEmpty() ? "" : "：" + d);
            case "max-tokens":
                return who + "输出达到上限，任务可能未完成";
            case "plan":
                return who + "计划已就绪" + (d.isEmpty() ? "" : "：" + d) + "，打开 App 批准或继续规划";
            case "question":
                return d.isEmpty() ? who + "需要你的回答，打开 App 回复" : who + "：" + d;
            default:
                return who.isEmpty() ? "电脑上的一个任务完成了" : who + "完成了";
        }
    }

    private static final java.util.Random SOUND_ROLL = new java.util.Random();

    /**
     * 任务完成类通知在三条同代渠道里随机挑一条 —— 渠道声音建好就锁死，
     * "每次听起来不一样"只能靠多条渠道实现。其它类型（需要你处理）仍走单条渠道。
     */
    private static String channelFor(Context ctx, String kind) {
        if (!"done".equals(kind)) return channelId(ctx, false);
        return channelId(ctx, true, SOUND_ROLL.nextInt(SOUND_RAW.length));
    }

    private void deliver(String id, String kind, String sessionId, String title, String detail) {
        // clear 不进去重表：它只是撤一条通知，重复撤没有副作用。
        if ("clear".equals(kind)) {
            cancel(id);
            return;
        }
        if (!markSeenOnce(this, id)) return;
        notifyEvent(id, kind, sessionId, title, detail);
    }

    private void cancel(String id) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(notificationId(id));
        } catch (Exception e) {
            Log.w(TAG, "cancel: " + e);
        }
    }

    private boolean canPostNotifications() {
        if (Build.VERSION.SDK_INT < 33) return true;
        try {
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    private void notifyEvent(String id, String kind, String sessionId, String title, String detail) {
        try {
            // App 在前台就不打扰：用户正看着，不需要系统通知
            if (MainActivity.sForeground) return;
            if (!canPostNotifications()) return;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            String text = textFor(kind, title, detail);
            String sid = sessionId == null ? "" : sessionId;
            Intent back = new Intent(this, MainActivity.class);
            back.setAction(Intent.ACTION_MAIN);
            back.addCategory(Intent.CATEGORY_LAUNCHER);
            if (!sid.isEmpty()) back.putExtra("sessionId", sid);
            // requestCode 不能一律 0：FLAG_UPDATE_CURRENT 按 (requestCode, intent) 复用，
            // 同一个 0 会让后一条通知的 extras 覆盖前一条，点哪条都落到同一个会话。
            PendingIntent pi = PendingIntent.getActivity(
                    this, sid.isEmpty() ? 0 : sid.hashCode(), back,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(this, channelFor(this, kind))
                    .setContentTitle(titleFor(kind))
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true)
                    .setCategory("done".equals(kind)
                            ? Notification.CATEGORY_STATUS : Notification.CATEGORY_REMINDER)
                    .build();
            nm.notify(notificationId(id), n);
            sLastNotifyAt = System.currentTimeMillis();
        } catch (Exception e) {
            Log.w(TAG, "notify: " + e);
        }
    }

    private void notifyConnectionLost() {
        try {
            if (!canPostNotifications()) return;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String chId = channelId(this, false);
            String text = "与电脑的连接已断开 3 分钟，正在跑的任务可能已中断。打开 App 检查。";
            Intent back = new Intent(this, MainActivity.class);
            back.setAction(Intent.ACTION_MAIN);
            back.addCategory(Intent.CATEGORY_LAUNCHER);
            PendingIntent pi = PendingIntent.getActivity(
                    this, 0, back, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(this, chId)
                    .setContentTitle("DSH 连接中断")
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .build();
            nm.notify(CONN_NOTIFY_ID, n);
        } catch (Exception e) {
            Log.w(TAG, "conn notify: " + e);
        }
    }

    private void cancelConnectionNotice() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(CONN_NOTIFY_ID);
        } catch (Exception e) {
            Log.w(TAG, "conn cancel: " + e);
        }
    }

    // ------------------------------------------------------------ 渠道（按「代」生成）

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * 当前"代"的渠道 id；不存在就按当前音源创建。
     * 用代而不是写死 id：渠道的声音创建后不可改，改声音只能换新 id。
     */
    static String channelId(Context ctx, boolean tasks) {
        // 任务完成：三条同代渠道一起建（声音各绑一段水滴），发通知时随机挑
        if (tasks) {
            for (int i = 0; i < SOUND_RAW.length; i++) channelId(ctx, true, i);
            return channelIdFor(ctx, true, 0);
        }
        return channelId(ctx, false, 0);
    }

    /** 建（或取）某一条具体渠道；variant 只对任务完成类有效。 */
    static String channelId(Context ctx, boolean tasks, int variant) {
        int v = tasks ? soundVariant(variant) : 0;
        String fallback = tasks ? "dsh-tasks" : "dsh-attention";
        try {
            if (Build.VERSION.SDK_INT < 26) return fallback;
            String id = channelIdFor(ctx, tasks, v);
            String name = tasks ? (v == 0 ? "任务完成" : "任务完成（音效 " + (v + 1) + "）")
                    : "需要你处理";
            String desc = tasks ? "电脑上的任务完成、出错或中断时提醒"
                    : "计划待批准、需要回答或连接中断时提醒";
            // 音源必须在建渠道**之前**选定：渠道属性创建后系统就锁死了。
            // 旧代码是建完再查 getSound()==null，不认就删掉换系统铃重建 ——
            // 但那正是 MIUI 的死循环：它把 android.resource:// 存成 null，
            // 删一次重建还是同一个坏 URI，白删一遍（顺带把用户选的声音也删了）。
            // pickSound 现在按「一定能被系统认」的顺序挑，轮不到建完才发现。
            ensureChannel(ctx, id, name, desc, pickSound(ctx, v));
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel ch = nm == null ? null : nm.getNotificationChannel(id);
            if (ch != null && ch.getSound() == null) {
                // 渠道已锁死，这里删了也救不回来，只留证据给「推送自检」看
                Log.w(TAG, "channel created without sound: " + id + " source=" + currentSoundSource(ctx));
            }
            return id;
        } catch (Exception e) {
            Log.w(TAG, "channel id: " + e);
            return fallback;
        }
    }

    /** 渠道 id 只由「代」和「第几段音」决定；单独抽出来，好让自检在不重建渠道时查它。 */
    private static String channelIdFor(Context ctx, boolean tasks) {
        return channelIdFor(ctx, tasks, 0);
    }

    private static String channelIdFor(Context ctx, boolean tasks, int variant) {
        int gen = prefs(ctx).getInt(KEY_GEN, 0);
        String base = (tasks ? "dsh-tasks-" : "dsh-attention-") + gen;
        int v = soundVariant(variant);
        return v == 0 ? base : base + "-" + (v + 1);
    }

    /** 当前代的渠道到底有没有声音：升级换代只能靠它判断成没成。 */
    static boolean channelSoundOk(Context ctx, boolean tasks) {
        try {
            if (Build.VERSION.SDK_INT < 26) return true;
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            int count = tasks ? SOUND_RAW.length : 1;
            for (int i = 0; i < count; i++) {
                NotificationChannel ch = nm.getNotificationChannel(channelIdFor(ctx, tasks, i));
                if (ch == null || ch.getSound() == null) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 换一代渠道：删上一代/旧固定 id，用当前音源重建。
     * 这是「换提示音」唯一可行的办法（渠道属性创建后系统锁死）。
     * 建完顺手验一次：新一代渠道没声音就别假装成功，留日志（调用方 decide 是否记账）。
     */
    static void rebuildChannels(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < 26) return;
            int gen = prefs(ctx).getInt(KEY_GEN, 0);
            prefs(ctx).edit().putInt(KEY_GEN, gen + 1).commit();
            java.util.ArrayList<String> old = new java.util.ArrayList<String>();
            java.util.Collections.addAll(old,
                    "dsh-tasks", "dsh-tasks-v2", "dsh-tasks-v3",
                    "dsh-attention", "dsh-attention-v3");
            // 上一代的三条任务渠道（含 -2/-3 两条随机音）统统删掉
            old.add("dsh-attention-" + gen);
            old.add("dsh-tasks-" + gen);
            for (int i = 1; i < SOUND_RAW.length; i++) old.add("dsh-tasks-" + gen + "-" + (i + 1));
            dropChannels(ctx, old.toArray(new String[0]));
            channelId(ctx, true);
            channelId(ctx, false);
            if (!channelSoundOk(ctx, true) || !channelSoundOk(ctx, false)) {
                Log.w(TAG, "rebuild channels done but sound is null, source=" + currentSoundSource(ctx));
            }
        } catch (Exception e) {
            Log.w(TAG, "rebuild: " + e);
        }
    }

    static void setPickedSound(Context ctx, Uri uri) {
        prefs(ctx).edit().putString(KEY_SOUND, uri == null ? null : uri.toString()).commit();
    }

    static String pickedSoundUri(Context ctx) {
        return prefs(ctx).getString(KEY_SOUND, null);
    }

    /**
     * 自检里显示的「渠道音源」：必须和 pickSound 走同一套判定，
     * 否则用户看到「自带资源」但渠道其实没声音，诊断字符串就骗人了。
     */
    static String currentSoundSource(Context ctx) {
        Uri u = pickSound(ctx);
        if (u == null) return "无（渠道会没声音）";
        String s = u.toString();
        String picked = prefs(ctx).getString(KEY_SOUND, null);
        if (picked != null && picked.equals(s)) return "用户选择（" + s + "）";
        if (s.startsWith("content://media")) return "媒体库（" + s + "）";
        if (s.startsWith("android.resource")) return "自带 water-drop（raw 资源）";
        return "其他（" + s + "）";
    }

    /**
     * 音源只有两档：用户在系统铃声选择器里选的 > 我们自带的 water-drop.mp3。
     *
     * **不做兜底**（2026-10-26 用户明确要求）：不再"媒体库拿不到就退系统铃声、
     * 系统铃声也没有就退别的"。理由写在 docs/PUSH-AND-SOUND.md：
     *   1. AOSP 自己就说"系统无法保证提醒行为"，会调整重要性/响铃，厂商皮肤把渠道设成
     *      「无」并不违规；
     *   2. 官方文档给的标准动作是"检测到渠道设置阻止预期行为时，引导用户去改设置"，
     *      不是偷偷换音；
     *   3. 静默降级会让"没声音"永远查不出来 —— 之前就被它骗过一轮。
     * 所以：绑不上就绑不上，自检里如实写清楚并给「打开本渠道设置」的入口。
     *
     * 这里**只读缓存，不做任何 IO 写**。MediaStore 那条记录由 `ensureMediaSound()`
     * 在一次性换代时写一次（见 onCreate 的 soundV093 分支）——
     * LESSONS 6.67 记过：启动路径上做媒体库写入/铃声解码会把主线程卡到
     * ForegroundServiceDidNotStartInTime，直接闪退。
     */
    static Uri pickSound(Context ctx) {
        return pickSound(ctx, 0);
    }

    /**
     * 第 variant 条渠道该用哪个音源。
     * 用户自己挑过铃声时三条渠道都用它（尊重用户选择，不再随机换音）；
     * 否则三段自带音各用各的，发通知时随机挑渠道就得到随机音色。
     */
    static Uri pickSound(Context ctx, int variant) {
        String picked = prefs(ctx).getString(KEY_SOUND, null);
        if (isUsableSound(picked)) {
            try {
                return Uri.parse(picked);
            } catch (Exception e) {
                /* 坏值就当没选过，用自带音 */
            }
        }
        // 媒体库里那份（content://，各家 ROM 都认）优先；还没写好就用 raw 资源：
        // 都是同一段水滴，只是换一种"系统能读到"的形态，**不是**换成别的音。
        Uri media = cachedMediaSound(ctx, variant);
        if (media != null) return media;
        return dropSoundUri(ctx, variant);
    }

    /** 上次写进媒体库的 content:// URI（没有就 null）。只读 prefs，零 IO。 */
    static Uri cachedMediaSound(Context ctx) {
        return cachedMediaSound(ctx, 0);
    }

    static Uri cachedMediaSound(Context ctx, int variant) {
        String s = prefs(ctx).getString(mediaKeyFor(variant), null);
        if (!isUsableSound(s)) return null;
        try {
            return Uri.parse(s);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 用户选的音源还能不能用。
     * android.resource:// 是历史坏值：旧版本把「自带音」存进 KEY_SOUND 过，
     * MIUI 对它一律不认，当没选过才能让新逻辑接管。
     */
    private static boolean isUsableSound(String s) {
        if (s == null || s.isEmpty()) return false;
        if (s.startsWith("android.resource://")) return false;
        try {
            Uri u = Uri.parse(s);
            return u != null && u.getScheme() != null;
        } catch (Exception e) {
            return false;
        }
    }

    /** App 自带的提示音：水滴录音里截出的三段之一（res/raw/notify_drop1..3.mp3）。 */
    static Uri dropSoundUri(Context ctx) {
        return dropSoundUri(ctx, 0);
    }

    /** 第 variant 段自带音（0..2）；越界自动夹回，调用方不用自己判。 */
    static Uri dropSoundUri(Context ctx, int variant) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/"
                + SOUND_RAW[soundVariant(variant)]);
    }

    private static int soundVariant(int variant) {
        int v = variant % SOUND_RAW.length;
        return v < 0 ? v + SOUND_RAW.length : v;
    }

    /** 三段 media 缓存各自的 prefs key。 */
    private static String mediaKeyFor(int variant) {
        int v = soundVariant(variant);
        if (v == 1) return KEY_MEDIA_SOUND_2;
        if (v == 2) return KEY_MEDIA_SOUND_3;
        return KEY_MEDIA_SOUND;
    }

    /** 媒体库里的文件名：第一段沿用老名字，升级上来的设备不会多出一条重复记录。 */
    private static String mediaNameFor(int variant) {
        int v = soundVariant(variant);
        return v == 0 ? "dsh_waterdrop.mp3" : ("dsh_waterdrop_" + (v + 1) + ".mp3");
    }

    /**
     * 把自带的提示音写进媒体库，拿一个各家 ROM 都认的 content:// URI（API 29+）。
     * 三段各写一条，随机播的目标靠这三条 content:// 各绑一条渠道实现。
     *
     * 为什么必须写进媒体库：AOSP 的 setSound 文档自己就说渠道会被备份恢复，
     * 而 resource id 会随升级变化 —— 之前绑 android.resource://<pkg>/<数字 id>，
     * MIUI 直接存成 null（渠道页显示「无」）。
     * 幂等：媒体库里已经有同名条目就直接复用，不再插一条。
     * 只允许在"一次性换代"里调用一次（启动路径上做 IO 会 ANR，见 LESSONS 6.67）。
     */
    static void ensureMediaSound(Context ctx) {
        for (int i = 0; i < SOUND_RAW.length; i++) ensureOneMediaSound(ctx, i);
    }

    private static Uri ensureOneMediaSound(Context ctx, int variant) {
        if (Build.VERSION.SDK_INT < 29) return null;
        Cursor c = null;
        String key = mediaKeyFor(variant);
        try {
            ContentResolver cr = ctx.getContentResolver();
            Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            String name = mediaNameFor(variant);
            c = cr.query(collection, new String[]{MediaStore.Audio.Media._ID},
                    MediaStore.Audio.Media.DISPLAY_NAME + "=?", new String[]{name}, null);
            if (c != null && c.moveToFirst()) {
                Uri hit = Uri.withAppendedPath(collection, String.valueOf(c.getLong(0)));
                // 记住它：pickSound() 只读这个缓存，不再为"挑音源"做媒体库查询
                prefs(ctx).edit().putString(key, hit.toString()).commit();
                return hit;
            }
            ContentValues v = new ContentValues();
            v.put(MediaStore.Audio.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Audio.Media.MIME_TYPE, "audio/mpeg");
            v.put(MediaStore.Audio.Media.IS_NOTIFICATION, 1);
            v.put(MediaStore.Audio.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_NOTIFICATIONS + "/DSH");
            v.put(MediaStore.Audio.Media.IS_PENDING, 1);
            Uri uri = cr.insert(collection, v);
            if (uri == null) return null;
            InputStream in = ctx.getResources().openRawResource(SOUND_RAW[soundVariant(variant)]);
            OutputStream out = cr.openOutputStream(uri);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            out.close();
            v.clear();
            v.put(MediaStore.Audio.Media.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            prefs(ctx).edit().putString(key, uri.toString()).commit();
            return uri;
        } catch (Exception e) {
            Log.w(TAG, "media sound: " + e);
            return null;
        } finally {
            if (c != null) c.close();
        }
    }

    static void ensureChannel(Context ctx, String id, String name, String description, Uri sound) {
        try {
            if (Build.VERSION.SDK_INT < 26) return;
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || nm.getNotificationChannel(id) != null) return;
            NotificationChannel ch = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(description);
            ch.setSound(sound, Notification.AUDIO_ATTRIBUTES_DEFAULT);
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 250, 200, 250});
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.w(TAG, "channel: " + e);
        }
    }

    static void ensureTaskChannel(Context ctx) {
        channelId(ctx, true);
    }

    static void ensureAttentionChannel(Context ctx) {
        channelId(ctx, false);
    }

    private static void dropChannels(Context ctx, String... ids) {
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            for (String id : ids) {
                if (id != null && nm.getNotificationChannel(id) != null) {
                    nm.deleteNotificationChannel(id);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "drop channel: " + e);
        }
    }

    /** 自检里的「发一条测试通知」：立刻验证声音、横幅和渠道设置。 */
    static void postTest(Context ctx) {
        try {
            if (!canPost(ctx)) return;
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String chId = channelId(ctx, false);
            Intent back = new Intent(ctx, MainActivity.class);
            back.setAction(Intent.ACTION_MAIN);
            back.addCategory(Intent.CATEGORY_LAUNCHER);
            PendingIntent pi = PendingIntent.getActivity(
                    ctx, 0, back, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(ctx, chId)
                    .setContentTitle("DSH 测试通知")
                    .setContentText("听到声音、看到横幅就说明渠道正常；没声音就看系统通知设置里的渠道")
                    .setStyle(new Notification.BigTextStyle().bigText(
                            "听到声音、看到横幅就说明渠道正常。没声音请到「通知设置 → 需要你处理」把声音打开。"))
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setWhen(System.currentTimeMillis())
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .build();
            nm.notify(TEST_ID, n);
            sLastNotifyAt = System.currentTimeMillis();
        } catch (Exception e) {
            Log.w(TAG, "test notify: " + e);
        }
    }

    /** 常驻通知的渠道：低优先级、不响不弹，但必须可见——它是前台服务活着的凭证。 */
    private void ensureLinkChannel() {
        try {
            if (Build.VERSION.SDK_INT < 26) return;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_LINK) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_LINK, "后台保活", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("维持与电脑的连接，计划、问答、完成时才能及时提醒");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            // 旧渠道是 IMPORTANCE_MIN，MIUI 会折叠成看不见；删掉免得设置里留两份。
            if (nm.getNotificationChannel(CHANNEL_LINK_LEGACY) != null) {
                nm.deleteNotificationChannel(CHANNEL_LINK_LEGACY);
            }
        } catch (Exception e) {
            Log.w(TAG, "link channel: " + e);
        }
    }

    // ------------------------------------------------------------ 自检

    static boolean canPost(Context ctx) {
        if (Build.VERSION.SDK_INT < 33) return true;
        try {
            return ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Exception e) {
            return false;
        }
    }

    private static String ago(long at) {
        if (at <= 0) return "从未";
        long d = Math.max(0, System.currentTimeMillis() - at) / 1000;
        if (d < 60) return d + " 秒前";
        if (d < 3600) return (d / 60) + " 分钟前";
        return (d / 3600) + " 小时前";
    }

    /**
     * 给「推送自检」用的一段纯文本。没有 adb 也能一眼看出卡在哪一步：
     * 通知权限 / 前台服务是否真的进了前台 / SSE 连没连上 / 最近一次通知。
     */
    static String diagnose(Context ctx) {
        StringBuilder sb = new StringBuilder();
        sb.append("通知权限：")
                .append(canPost(ctx) ? "已允许" : "未允许（系统会拦掉所有通知）")
                .append('\n');
        if (!sRunning) {
            sb.append("前台服务：未运行\n");
        } else if (sFgOk) {
            sb.append("前台服务：运行中（前台，").append(sFgType).append("）\n");
        } else {
            sb.append("前台服务：未进前台 —— ").append(sFgError).append('\n');
        }
        if (sConnected) {
            sb.append("连接：已连上，").append(ago(sLastByteAt)).append("收到心跳\n");
        } else {
            sb.append("连接：未连接");
            if (!sLastSseError.isEmpty()) {
                sb.append("（").append(sLastSseError).append("，").append(ago(sLastSseErrorAt)).append("）");
            }
            sb.append('\n');
        }
        sb.append("最近一次通知：").append(ago(sLastNotifyAt)).append('\n');
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            int rm = am == null ? AudioManager.RINGER_MODE_NORMAL : am.getRingerMode();
            sb.append("铃声模式：").append(rm == AudioManager.RINGER_MODE_SILENT ? "静音"
                    : rm == AudioManager.RINGER_MODE_VIBRATE ? "震动（没有声音）" : "正常");
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && Build.VERSION.SDK_INT >= 23
                    && nm.getCurrentInterruptionFilter() != NotificationManager.INTERRUPTION_FILTER_ALL) {
                sb.append("；勿扰已开");
            }
            sb.append('\n');
        } catch (Exception e) {
            sb.append("铃声模式：无法读取\n");
        }
        sb.append("系统默认通知音：").append(defaultSoundName(ctx)).append('\n');
        sb.append("可用通知铃声：").append(ringtoneCount(ctx)).append(" 条\n");
        sb.append("铃声前三条：").append(ringtonePreview(ctx, 3)).append('\n');
        String taskCh = channelId(ctx, true);
        String attCh = channelId(ctx, false);
        sb.append("当前渠道：").append(taskCh).append(" / ").append(attCh).append('\n');
        sb.append("渠道音源：").append(currentSoundSource(ctx)).append('\n');
        sb.append("渠道 任务完成：").append(channelState(ctx, taskCh)).append('\n');
        sb.append("渠道 需要你处理：").append(channelState(ctx, attCh)).append('\n');
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            boolean ok = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
            sb.append("省电：").append(ok ? "已加入白名单" : "未加入白名单（点「加入电池白名单」）");
        } catch (Exception e) {
            sb.append("省电：无法读取");
        }
        sb.append('\n').append("厂商：").append(Vendor.brandName()).append('\n');
        String crash = CrashLog.read(ctx);
        if (!crash.isEmpty()) {
            sb.append("上次崩溃：").append(crash.length() > 900 ? crash.substring(0, 900) + "…" : crash).append('\n');
        }
        return sb.toString();
    }

    /** 渠道真实状态：重要性 + 声音在不在（用户或系统把它静音了都能看出来）。 */
    private static String channelState(Context ctx, String id) {
        try {
            if (Build.VERSION.SDK_INT < 26) return "系统版本过低，用通知默认声";
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return "无法读取";
            NotificationChannel ch = nm.getNotificationChannel(id);
            if (ch == null) return "未创建（点「发测试通知」会创建）";
            String imp;
            switch (ch.getImportance()) {
                case NotificationManager.IMPORTANCE_HIGH: imp = "高"; break;
                case NotificationManager.IMPORTANCE_DEFAULT: imp = "默认"; break;
                case NotificationManager.IMPORTANCE_LOW: imp = "低"; break;
                case NotificationManager.IMPORTANCE_MIN: imp = "最低"; break;
                default: imp = "无（已关闭）"; break;
            }
            return imp + " / " + (ch.getSound() == null ? "没声音" : "有声音（" + shortUri(ch.getSound()) + "）");
        } catch (Exception e) {
            return "无法读取";
        }
    }

    private static String shortUri(Uri u) {
        if (u == null) return "无";
        String s = u.toString();
        if (s.startsWith("android.resource")) return "自带资源";
        if (s.startsWith("content://media")) return "媒体库";
        if (s.startsWith("content://settings")) return "系统默认";
        return u.getScheme() + "://" + u.getHost();
    }

    /** 铃声列表前几条：渠道显示「无」时用它看出我们取的到底是哪一条。 */
    private static String ringtonePreview(Context ctx, int count) {
        Cursor c = null;
        StringBuilder sb = new StringBuilder();
        try {
            RingtoneManager rm = new RingtoneManager(ctx);
            rm.setType(RingtoneManager.TYPE_NOTIFICATION);
            c = rm.getCursor();
            if (c == null) return "读不到";
            int titleCol = c.getColumnIndex(MediaStore.Audio.Media.TITLE);
            for (int i = 0; i < c.getCount() && i < count; i++) {
                Uri u = rm.getRingtoneUri(i);
                String title = titleCol >= 0 ? c.getString(titleCol) : "";
                if (i > 0) sb.append("；");
                sb.append(i).append('.').append(title == null || title.isEmpty() ? "无标题" : title);
                if (u != null) sb.append("（").append(shortUri(u)).append("）");
            }
            return sb.length() == 0 ? "空" : sb.toString();
        } catch (Exception e) {
            return "无法读取";
        } finally {
            if (c != null) c.close();
        }
    }

    /** 系统默认通知音的名字；设成"无"时直接说清楚，这是最常见的坑。 */
    private static String defaultSoundName(Context ctx) {
        try {
            String s = Settings.System.getString(ctx.getContentResolver(), Settings.System.NOTIFICATION_SOUND);
            if (s == null || s.isEmpty()) return "无（系统默认就是静音）";
            Ringtone r = RingtoneManager.getRingtone(ctx, Uri.parse(s));
            String title = r == null ? null : r.getTitle(ctx);
            return title == null || title.isEmpty() ? shortUri(Uri.parse(s)) : title;
        } catch (Exception e) {
            return "无法读取";
        }
    }

    private static int ringtoneCount(Context ctx) {
        Cursor c = null;
        try {
            RingtoneManager rm = new RingtoneManager(ctx);
            rm.setType(RingtoneManager.TYPE_NOTIFICATION);
            c = rm.getCursor();
            return c == null ? 0 : c.getCount();
        } catch (Exception e) {
            return 0;
        } finally {
            if (c != null) c.close();
        }
    }

    /**
     * 真正进前台。**返回值必须用**：Android 14+ 对 connectedDevice 有前置权限要求，
     * 缺了会抛 SecurityException；以前整个方法包在 catch 里，异常被吞掉，
     * 服务就静默变成普通后台服务（然后被系统冻结，后台再也收不到推送）。
     */
    private boolean goForeground() {
        try {
            Intent back = new Intent(this, MainActivity.class);
            PendingIntent pi = PendingIntent.getActivity(
                    this, 0, back, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = new Notification.Builder(this, CHANNEL_LINK)
                    .setContentTitle("DSH")
                    .setContentText("正在等待任务提醒")
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(pi)
                    .setOngoing(true)
                    .setShowWhen(false)
                    .setCategory(Notification.CATEGORY_SERVICE);
            if (Build.VERSION.SDK_INT >= 31) {
                // 不设的话 Android 12+ 会把前台通知压后最多 10 秒才显示
                b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
            }
            Notification n = b.build();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(FGS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(FGS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(FGS_ID, n);
            }
            sFgOk = true;
            sFgType = "connectedDevice";
            sFgError = "";
            cancelForegroundFailed();
            return true;
        } catch (Throwable e) {
            sFgOk = false;
            sFgType = "";
            sFgError = e.getClass().getSimpleName() + ": " + e.getMessage();
            Log.w(TAG, "foreground: " + sFgError);
            return false;
        }
    }

    /** 前台服务没起来 = 后台推送必然丢，必须让用户看见，不能只写日志。 */
    private void notifyForegroundFailed() {
        try {
            if (!canPost(this)) return;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String chId = channelId(this, false);
            String text = "后台提醒可能收不到：服务没能常驻（" + sFgError + "）。"
                    + "打开 App 右上角 ⋮ → 推送自检 查看原因。";
            Intent back = new Intent(this, MainActivity.class);
            back.setAction(Intent.ACTION_MAIN);
            back.addCategory(Intent.CATEGORY_LAUNCHER);
            PendingIntent pi = PendingIntent.getActivity(
                    this, 0, back, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(this, chId)
                    .setContentTitle("DSH 后台推送未生效")
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_ERROR)
                    .build();
            nm.notify(FG_FAIL_ID, n);
        } catch (Exception e) {
            Log.w(TAG, "fg fail notify: " + e);
        }
    }

    private void cancelForegroundFailed() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(FG_FAIL_ID);
        } catch (Exception e) {
            Log.w(TAG, "fg fail cancel: " + e);
        }
    }
}
