package com.lexin.dshmobile;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 崩溃留证。真机闪退时用户手上没有 adb，「卡了一下就没了」这种反馈
 * 靠猜永远猜不准，所以把崩溃现场写进 files/last-crash.txt，
 * 下次打开 App 的「后台推送自检」里直接能看见。
 *
 * 只保留最近一次：先写、再交给系统默认处理（系统的崩溃报告不受影响）。
 */
public class CrashLog {
    private static final String TAG = "dsh-crash";
    private static final String FILE = "last-crash.txt";
    private static volatile boolean installed = false;

    public static void install(final Context context) {
        if (installed) return;
        installed = true;
        final Context app = context.getApplicationContext();
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    save(app, t, e);
                } catch (Throwable ignored) {
                    /* 崩溃处理器自己不能崩 */
                }
                if (prev != null) prev.uncaughtException(t, e);
            }
        });
    }

    private static void save(Context ctx, Thread t, Throwable e) {
        StringWriter sw = new StringWriter();
        e.printStackTrace(new PrintWriter(sw));
        String head = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date())
                + "  线程 " + t.getName() + "\n";
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(new File(ctx.getFilesDir(), FILE), false);
            out.write((head + sw).getBytes("UTF-8"));
        } catch (Throwable ignored) {
            /* 写不下去也不能让崩溃处理器再崩一次 */
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (Throwable ignored) {
                    /* 关不上就算了 */
                }
            }
        }
        Log.w(TAG, head + sw);
    }

    /** 上次崩溃现场；没崩过返回空串。 */
    public static String read(Context ctx) {
        FileInputStream in = null;
        try {
            File f = new File(ctx.getFilesDir(), FILE);
            if (!f.exists() || f.length() <= 0) return "";
            byte[] buf = new byte[(int) Math.min(f.length(), 20000)];
            in = new FileInputStream(f);
            int n = in.read(buf);
            if (n <= 0) return "";
            String s = new String(buf, 0, n, "UTF-8").trim();
            return s;
        } catch (Exception e) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    /* 关不上也没关系 */
                }
            }
        }
    }

    public static void clear(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), FILE);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {
            /* 删不掉就算了 */
        }
    }
}
