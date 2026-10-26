package com.lexin.dshmobile;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;

import java.util.ArrayList;
import java.util.List;

/**
 * 接管网页里的 <input type="file">（我们的附件面板三个 tile 都用它）。
 *
 * 不实现这个，WebView 里点「拍照/相册/文件」会一点反应都没有 —— 不报错，也不弹框。
 *
 * 三条路：
 *   拍照   ACTION_IMAGE_CAPTURE + 自己写的 CaptureProvider（要一个可写的 content://）
 *   相册   ACTION_GET_CONTENT image/*
 *   文件   ACTION_GET_CONTENT 任意类型（按页面给的 accept 过滤，可多选）
 *
 * 全程不申请任何权限：相机和文件都由系统 App 代办。
 */
public class FileChooser {

    static final int REQ_PICK = 4201;
    static final int REQ_CAPTURE = 4202;

    private final Activity host;
    private ValueCallback<Uri[]> callback;
    private Uri captureUri;
    private java.io.File captureFile;
    private long captureStartedAt = 0L;

    FileChooser(Activity host) {
        this.host = host;
    }

    boolean show(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams params) {
        cancel(true);
        // 先扫一遍 captures：相机取消/崩溃会留下 0 字节空文件，别堆着。
        sweep(host);
        callback = cb;

        String[] accept = params == null ? null : params.getAcceptTypes();
        boolean imageAsked = acceptsImage(accept);

        if (params != null && params.isCaptureEnabled() && imageAsked && hasCamera()) {
            if (startCamera()) return true;
        }
        return startPicker(params, accept);
    }

    // ------------------------------------------------------------------ 拍照

    private boolean hasCamera() {
        try {
            Intent probe = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            return host.getPackageManager().resolveActivity(probe, 0) != null;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean startCamera() {
        java.io.File dir = new java.io.File(host.getCacheDir(), "captures");
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(MainActivity.TAG, "cannot create captures dir");
            return false;
        }
        captureFile = new java.io.File(dir, "shot_" + System.currentTimeMillis() + ".jpg");
        captureUri = Uri.parse("content://" + CaptureProvider.AUTHORITY + "/" + captureFile.getName());

        Intent i = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
        i.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, captureUri);
        i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            captureStartedAt = System.currentTimeMillis();
            host.startActivityForResult(i, REQ_CAPTURE);
            return true;
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "camera intent failed: " + e);
            captureUri = null;
            captureFile = null;
            return false;
        }
    }

    // ------------------------------------------------------------------ 选择

    private boolean startPicker(WebChromeClient.FileChooserParams params, String[] accept) {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);

        List<String> mimes = cleanMimes(accept);
        if (mimes.isEmpty()) {
            i.setType("*/*");
        } else if (mimes.size() == 1) {
            i.setType(mimes.get(0));
        } else {
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
        }

        boolean multi = params != null
                && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        if (multi) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

        try {
            host.startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_PICK);
            return true;
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "picker failed: " + e);
            callback = null;
            return false;
        }
    }

    private static boolean acceptsImage(String[] accept) {
        if (accept == null) return false;
        for (String a : accept) {
            if (a == null) continue;
            String t = a.trim().toLowerCase();
            if (t.isEmpty() || "*/*".equals(t)) return true;      // 不限类型也给相机
            if (t.startsWith("image/")) return true;
        }
        return false;
    }

    /** 页面的 accept 里常有空串、逗号尾巴；顺手把「不限类型」收敛掉（有些系统选择器认死理）。 */
    private static List<String> cleanMimes(String[] accept) {
        List<String> out = new ArrayList<String>();
        if (accept == null) return out;
        boolean wildcard = false;
        for (String a : accept) {
            if (a == null) continue;
            String[] parts = a.split(",");
            for (String p : parts) {
                String t = p.trim().toLowerCase();
                if (t.isEmpty()) continue;
                if ("*/*".equals(t)) {
                    wildcard = true;
                    continue;
                }
                if (!out.contains(t)) out.add(t);
            }
        }
        if (wildcard) out.clear();          // 不限类型时不要额外限制
        return out;
    }

    // ------------------------------------------------------------------ 回传

    void onResult(int req, int res, Intent data) {
        ValueCallback<Uri[]> cb = callback;
        if (cb == null) return;
        callback = null;

        if (res != Activity.RESULT_OK) {
            cb.onReceiveValue(null);
            cleanupCapture(res == Activity.RESULT_CANCELED && captureFile != null
                    && captureFile.length() == 0 ? captureFile : null);
            return;
        }

        // 按请求码分流：未知请求码也必须回 null，不能吞掉回调，
        // 否则 WebView 侧的 file chooser 永远挂起（转圈没结果）。
        if (req == REQ_CAPTURE) {
            Uri u = null;
            if (captureFile != null && captureFile.length() > 0) {
                u = captureUri;                                   // 正常路径：相机写进了我们的文件
            } else if (data != null && data.getData() != null) {
                u = data.getData();                               // 少数相机 App 只回 data
            }
            cb.onReceiveValue(u == null ? null : new Uri[]{u});
        } else if (req == REQ_PICK) {
            cb.onReceiveValue(pickFrom(data));
        } else {
            Log.w(MainActivity.TAG, "filechooser unknown req: " + req);
            cb.onReceiveValue(null);
        }
    }

    private Uri[] pickFrom(Intent data) {
        if (data == null) return null;
        android.content.ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri[] uris = new Uri[clip.getItemCount()];
            for (int i = 0; i < clip.getItemCount(); i++) {
                uris[i] = clip.getItemAt(i).getUri();
            }
            return uris;
        }
        Uri one = data.getData();
        return one == null ? null : new Uri[]{one};
    }

    void cancel(boolean notify) {
        ValueCallback<Uri[]> cb = callback;
        callback = null;
        if (notify && cb != null) cb.onReceiveValue(null);
        cleanupCapture(null);
    }

    private void cleanupCapture(java.io.File extra) {
        if (captureFile != null && captureFile.length() == 0) {
            // 空文件删掉，别在缓存里堆
            //noinspection ResultOfMethodCallIgnored
            captureFile.delete();
        }
        if (extra != null && extra != captureFile && extra.length() == 0) {
            //noinspection ResultOfMethodCallIgnored
            extra.delete();
        }
        captureFile = null;
        captureUri = null;
        captureStartedAt = 0L;
    }

    /**
     * 相机回来时把结果文件的元信息读一下，只用于日志；
     * 顺手清理超过一天的旧截图（缓存目录本来也会被系统清，这里只是别堆太快）。
     */
    static void sweep(Activity host) {
        java.io.File dir = new java.io.File(host.getCacheDir(), "captures");
        java.io.File[] files = dir.listFiles();
        if (files == null) return;
        long edge = System.currentTimeMillis() - 24L * 3600L * 1000L;
        for (java.io.File f : files) {
            if (f.isFile() && f.lastModified() < edge) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    @SuppressWarnings("unused")
    private static String nameOf(Cursor c) {
        if (c == null) return null;
        try {
            int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
            if (idx >= 0 && c.moveToFirst()) return c.getString(idx);
        } finally {
            c.close();
        }
        return null;
    }
}
