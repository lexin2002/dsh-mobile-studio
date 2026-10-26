package com.lexin.dshmobile;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.hardware.Camera;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * App 内实时取景扫码（Camera1 + ZXing core，无 Gradle/AndroidX）。
 *
 * 为什么不用系统相机拍照：用户要的是"对着二维码就扫"，不是先拍一张再回来看。
 * Camera1 虽已废弃，但 minSdk 26 上可用、零新依赖；ZXing core 是纯 Java，
 * 解码跑在单线程池里，不阻塞预览。
 *
 * 返回值：RESULT_OK + {@link #EXTRA_TEXT}（二维码原文，交给 MainActivity 用 UrlRules 校验）。
 * 关闭 / 相机打不开 / 没权限：RESULT_CANCELED，由调用方决定降级路径。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback {

    static final String EXTRA_TEXT = "text";
    private static final String TAG = "DshMobile";
    /** 相册选图：随便挑一个只在本页用、不会跟 MainActivity 撞车的请求码。 */
    private static final int REQ_PICK = 0x51;
    /**
     * 相册大图解码的最长边上限。手机相册里 4000×3000 的原图直接 decode 成 ARGB_8888
     * 就是 48MB，低频机型必然 OOM；二维码在这个尺寸下缩小 2~3 倍仍能解。
     */
    private static final int MAX_IMAGE_EDGE = 1600;

    private SurfaceView previewView;
    /** 按预览比例测量、居中留黑边的容器；SurfaceView 和取景框都放在里面。 */
    private AspectRatioLayout aspectBox;
    private TextView hintView;
    private Camera camera;
    private Camera.Size previewSize;
    /** 当前屏幕旋转角度（0/90/180/270），用于换算预览画面的实际宽高比。 */
    private int displayDegrees = 0;
    private boolean surfaceReady = false;
    private boolean finishing = false;

    private final AtomicBoolean decoding = new AtomicBoolean(false);
    private volatile boolean previewing = false;
    /**
     * 连续对焦是否真的生效。生效时**绝不能**再周期性调 autoFocus：
     * Camera1 在 CONTINUOUS_PICTURE 下调 autoFocus 会打断连续对焦、把镜头拉到
     * 无穷远锁住，预览就一直糊（小米这类机型上尤其明显）。
     */
    private volatile boolean continuousFocus = false;
    /** autoFocus 的世代号：回调/定时器只认最新一次，避免越堆越多。 */
    private int focusSeq = 0;
    private ExecutorService worker;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private byte[] frame = null;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_scan);

        previewView = findViewById(R.id.scanPreview);
        hintView = findViewById(R.id.scanHint);
        findViewById(R.id.scanClose).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        installAspectBox();
        installGalleryEntry();
        previewView.getHolder().addCallback(this);
        worker = Executors.newSingleThreadExecutor();

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "未获得相机权限", Toast.LENGTH_SHORT).show();
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    // ---------------------------------------------------------------- 视图搭建

    /**
     * 把取景 SurfaceView 和扫描框一起挪进按比例测量的容器，再挂到根布局。
     *
     * 为什么必须换容器而不是给 SurfaceView 设宽高：只要 Surface 尺寸变一次，
     * Camera1 就会回调 surfaceDestroyed/surfaceCreated，用 setLayoutParams 反复
     * 调尺寸等于每帧重启一遍相机，画面会抖。容器自己决定测量尺寸，SurfaceView
     * 始终 match_parent，比例对了就再也不用改。
     */
    private void installAspectBox() {
        if (previewView == null) return;
        ViewGroup root = (ViewGroup) previewView.getParent();
        if (root == null) return;
        aspectBox = new AspectRatioLayout(this);
        FrameLayout.LayoutParams fill = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER);
        root.addView(aspectBox, 0, fill);

        View scanFrame = findViewById(R.id.scanFrame);
        // XML 里 224dp 的尺寸已经解析成像素，搬过去时原样带着
        ViewGroup.LayoutParams frameLp = scanFrame == null ? null : scanFrame.getLayoutParams();
        root.removeView(previewView);
        if (scanFrame != null) root.removeView(scanFrame);
        aspectBox.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (scanFrame != null) {
            // 扫描框跟着画面走：画面被 letterbox 后它仍在画面中心，不会框住黑边
            aspectBox.addView(scanFrame, frameLp != null ? frameLp : new FrameLayout.LayoutParams(
                    dp(224), dp(224), Gravity.CENTER));
        }
    }

    /**
     * 底部「从相册选择」入口。布局 XML 不归本次改动（有别的代理在改），
     * 所以按钮在代码里建，样式沿用扫码页的透明底 + 白字 + 44dp 点击区。
     */
    private void installGalleryEntry() {
        ViewGroup root = aspectBox != null ? (ViewGroup) aspectBox.getParent() : null;
        if (root == null) return;
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        bar.setPadding(0, 0, 0, dp(18));

        Button pick = new Button(this);
        pick.setText("从相册选择");
        pick.setTextSize(15);
        pick.setTextColor(0xFFFFFFFF);
        pick.setBackgroundColor(0x00000000);
        pick.setMinWidth(dp(44));
        pick.setMinHeight(dp(44));
        pick.setPadding(dp(16), 0, dp(16), 0);
        pick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pickFromGallery();
            }
        });
        bar.addView(pick, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        root.addView(bar, lp);
        // 提示文字上移，别和按钮叠在一起（XML 里的 bottom padding 是 42dp，不够让一整个按钮）
        if (hintView != null) {
            hintView.setPadding(hintView.getPaddingLeft(), hintView.getPaddingTop(),
                    hintView.getPaddingRight(), dp(86));
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    protected void onResume() {
        super.onResume();
        if (camera == null && surfaceReady) openCamera();
    }

    @Override
    protected void onPause() {
        releaseCamera();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        releaseCamera();
        if (worker != null) worker.shutdownNow();
        super.onDestroy();
    }

    private void releaseCamera() {
        previewing = false;
        focusSeq++;
        Camera c = camera;
        camera = null;
        if (c != null) {
            try {
                c.setPreviewCallback(null);
                c.stopPreview();
            } catch (Exception e) {
                /* 已经停了就算了 */
            }
            try {
                c.release();
            } catch (Exception e) {
                /* release 失败也只能继续退出 */
            }
        }
    }

    // ---------------------------------------------------------------- 相机

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        if (camera == null) openCamera();
        else startPreview(); // 改比例后 Surface 重建：相机还在，重新挂上就行
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        if (camera != null) {
            try {
                camera.stopPreview();
            } catch (Exception e) {
                /* 没在预览 */
            }
            startPreview();
        }
    }

    /**
     * 让显示宽高比等于相机预览尺寸的宽高比（竖屏时宽高互换）。
     *
     * 为什么在这里算：previewSize 可能被机型悄悄改过，displayDegrees 又是「画面转了
     * 多少度」而不是屏幕角度；只有这两个都拿到之后，宽高比才是最终画在屏幕上的那个。
     */
    private void applyPreviewRatio() {
        if (aspectBox == null || previewSize == null) return;
        int vw = previewSize.width, vh = previewSize.height;
        if (displayDegrees % 180 != 0) { int t = vw; vw = vh; vh = t; }
        if (vw <= 0 || vh <= 0) return;
        aspectBox.setAspectRatio((float) vw / (float) vh);
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceReady = false;
        // 只停预览、不释放相机：改预览比例会让 Surface 重建，这里 release 的话
        // surfaceCreated 又得重开相机，形成「开→关→开」的抖动，还会把对焦状态丢掉。
        stopPreview();
    }

    private void stopPreview() {
        previewing = false;
        focusSeq++;
        Camera c = camera;
        if (c != null) {
            try {
                c.stopPreview();
            } catch (Exception e) {
                /* 已经停了 */
            }
        }
    }

    private void openCamera() {
        if (camera != null || finishing) return;
        Camera c;
        try {
            c = Camera.open();
        } catch (Exception e) {
            Log.w(TAG, "camera open failed: " + e);
            Toast.makeText(this, "相机不可用", Toast.LENGTH_SHORT).show();
            setResult(RESULT_CANCELED);
            finish();
            return;
        }
        if (c == null) {
            Toast.makeText(this, "相机不可用", Toast.LENGTH_SHORT).show();
            setResult(RESULT_CANCELED);
            finish();
            return;
        }
        camera = c;
        try {
            Camera.Parameters p = c.getParameters();
            previewSize = choosePreviewSize(p);
            if (previewSize != null) p.setPreviewSize(previewSize.width, previewSize.height);
            p.setPreviewFormat(ImageFormat.NV21);
            setFocusMode(p);
            c.setParameters(p);
            // 有些机型会悄悄把预览尺寸改成它自己支持的大小：以读回来的为准，
            // 否则按「请求的尺寸」算宽高比，画面照样被拉。
            try {
                Camera.Size applied = c.getParameters().getPreviewSize();
                if (applied != null && applied.width > 0 && applied.height > 0) previewSize = applied;
            } catch (Exception ignored) {
                /* 读不回来就用请求的 */
            }
            continuousFocus = isContinuousMode(c.getParameters().getFocusMode());
            setDisplayOrientation(c);
            applyPreviewRatio();
            c.setPreviewCallback(new Camera.PreviewCallback() {
                @Override
                public void onPreviewFrame(byte[] data, Camera cam) {
                    decodeFrame(data, cam);
                }
            });
            startPreview();
        } catch (Exception e) {
            Log.w(TAG, "camera config failed: " + e);
            releaseCamera();
            Toast.makeText(this, "相机初始化失败", Toast.LENGTH_SHORT).show();
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    private Camera.Size choosePreviewSize(Camera.Parameters p) {
        List<Camera.Size> sizes = p.getSupportedPreviewSizes();
        if (sizes == null || sizes.isEmpty()) return null;
        // 目标 1280×720：足够解二维码，又不至于每帧解码太慢
        int wantW = 1280;
        int wantH = 720;
        Camera.Size best = sizes.get(0);
        long bestScore = Long.MAX_VALUE;
        for (Camera.Size s : sizes) {
            long score = Math.abs((long) s.width * wantH - (long) s.height * wantW)
                    + Math.abs(s.width - wantW) * 8L;
            if (score < bestScore) {
                bestScore = score;
                best = s;
            }
        }
        return best;
    }

    private void setFocusMode(Camera.Parameters p) {
        try {
            List<String> modes = p.getSupportedFocusModes();
            if (modes == null) return;
            // 优先连续对焦；有些机型只报 CONTINUOUS_VIDEO，也接受。
            if (modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            } else if (modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO);
            } else if (modes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
            } else if (modes.contains(Camera.Parameters.FOCUS_MODE_MACRO)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_MACRO);
            }
        } catch (Exception e) {
            /* 对焦模式不支持就用默认 */
        }
    }

    private static boolean isContinuousMode(String mode) {
        return Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE.equals(mode)
                || Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO.equals(mode);
    }

    private void setDisplayOrientation(Camera c) {
        try {
            Camera.CameraInfo info = new Camera.CameraInfo();
            Camera.getCameraInfo(0, info);
            int rotation = getWindowManager().getDefaultDisplay().getRotation();
            int degrees = 0;
            switch (rotation) {
                case Surface.ROTATION_90: degrees = 90; break;
                case Surface.ROTATION_180: degrees = 180; break;
                case Surface.ROTATION_270: degrees = 270; break;
                default: degrees = 0; break;
            }
            int result;
            if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
                result = (info.orientation + degrees) % 360;
                result = (360 - result) % 360;
            } else {
                result = (info.orientation - degrees + 360) % 360;
            }
            c.setDisplayOrientation(result);
            // 这里存的必须是「画面被转了多少度」，不是屏幕旋转角。
            // 竖屏时屏幕旋转角是 0，但后置摄像头一般要把画面转 90° 才正 ——
            // 用错这个值，fitPreview 就不会交换宽高，竖的画面被塞进横的框，拉得更狠。
            displayDegrees = result;
        } catch (Exception e) {
            /* 调不了就用默认方向 */
        }
    }

    private void startPreview() {
        Camera c = camera;
        if (c == null || !surfaceReady) return;
        try {
            c.setPreviewDisplay(previewView.getHolder());
            c.startPreview();
            previewing = true;
            // 连续对焦交给驱动；只有 AUTO/MACRO 才需要我们自己定时触发
            if (!continuousFocus) scheduleAutoFocus();
        } catch (Exception e) {
            Log.w(TAG, "preview failed: " + e);
        }
    }

    /**
     * 只在非连续对焦模式下用。每次只保留一个待触发的任务：
     * 回调回来再排下一次；2.5 秒没回调也兜底重排，避免相机把回调吞了之后彻底不对焦。
     */
    private void scheduleAutoFocus() {
        if (continuousFocus) return;
        final int seq = ++focusSeq;
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (seq != focusSeq) return;
                Camera c = camera;
                if (c == null || !previewing || finishing || continuousFocus) return;
                try {
                    c.autoFocus(new Camera.AutoFocusCallback() {
                        @Override
                        public void onAutoFocus(boolean ok, Camera cam) {
                            if (seq == focusSeq) scheduleAutoFocus();
                        }
                    });
                } catch (Exception e) {
                    if (seq == focusSeq) scheduleAutoFocus();
                }
                // 兜底：某些机型 autoFocus 不回回调，2.5 秒后再来一次
                ui.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (seq == focusSeq) scheduleAutoFocus();
                    }
                }, 2500);
            }
        }, 1200);
    }

    // ---------------------------------------------------------------- 解码

    private void decodeFrame(final byte[] data, final Camera cam) {
        if (data == null || previewSize == null || finishing) return;
        if (!decoding.compareAndSet(false, true)) return; // 上一帧还没解完，跳帧

        int w = previewSize.width;
        int h = previewSize.height;
        // 预览回调的 byte[] 会被复用，异步解码必须先拷一份
        if (frame == null || frame.length != data.length) frame = new byte[data.length];
        System.arraycopy(data, 0, frame, 0, data.length);
        final byte[] copy = frame;

        worker.execute(new Runnable() {
            @Override
            public void run() {
                String text = null;
                try {
                    PlanarYUVLuminanceSource src =
                            new PlanarYUVLuminanceSource(copy, w, h, 0, 0, w, h, false);
                    BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(src));
                    Result r = new MultiFormatReader().decode(bitmap, decodeHints());
                    text = r == null ? null : r.getText();
                } catch (Exception e) {
                    // NotFoundException 是常态（大多数帧里没有码），不记日志刷屏
                } finally {
                    decoding.set(false);
                }
                if (text != null) onDecoded(text);
            }
        });
    }

    /** 相机帧和相册图片共用同一套解码提示，避免两条路慢慢跑偏。 */
    private static Map<DecodeHintType, Object> decodeHints() {
        Map<DecodeHintType, Object> hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        return hints;
    }

    // ---------------------------------------------------------------- 相册选图

    private void pickFromGallery() {
        // ACTION_GET_CONTENT + CATEGORY_OPENABLE：由系统相册/文件选择器给出可读 Uri，
        // 不需要任何存储权限；用 ACTION_PICK 的话在部分机型上拿不到可打开的 Uri。
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.setType("image/*");
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(pick, REQ_PICK);
        } catch (Exception e) {
            Log.w(TAG, "gallery picker unavailable: " + e);
            Toast.makeText(this, "没有可用的相册", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK) return;
        if (resultCode != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri == null) {
            Toast.makeText(this, "无法读取该图片", Toast.LENGTH_SHORT).show();
            return;
        }
        decodePickedImage(uri);
    }

    /**
     * 相册图片解码。为什么单开一个线程：采样 + 二值化 + 解码在 1600px 上也要几十到
     * 几百毫秒，放主线程会卡住预览；解码完再回主线程走 {@link #onDecoded(String)}，
     * 和相机帧完全同一条返回路径。
     */
    private void decodePickedImage(final Uri uri) {
        final String name = String.valueOf(uri);
        new Thread(new Runnable() {
            @Override
            public void run() {
                String text = null;
                String error = null;
                int width = 0, height = 0;
                try {
                    Bitmap bmp = loadSampledBitmap(uri);
                    width = bmp.getWidth();
                    height = bmp.getHeight();
                    try {
                        int[] pixels = new int[width * height];
                        bmp.getPixels(pixels, 0, width, 0, 0, width, height);
                        // 文件/位图解码必须走 RGBLuminanceSource；相机帧的 YUV 源在这里用不了
                        RGBLuminanceSource src = new RGBLuminanceSource(width, height, pixels);
                        BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(src));
                        Result r = new MultiFormatReader().decode(bitmap, decodeHints());
                        text = r == null ? null : r.getText();
                    } finally {
                        bmp.recycle();
                    }
                } catch (Throwable e) {
                    // 连 OOM 也一起收：相册里可能有超大图，宁可提示「无法读取该图片」也别闪退
                    error = String.valueOf(e);
                }
                final String value = text;
                final String err = error;
                final int fw = width, fh = height;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        // 解码期间用户可能已经关了页面/扫到了码，别往死掉的 Activity 上弹东西
                        if (isFinishing() || finishing) return;
                        if (value != null && value.trim().length() > 0) {
                            onDecoded(value);
                        } else {
                            Toast.makeText(ScanActivity.this, "无法读取该图片", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
                if (value == null || value.trim().length() == 0) {
                    // 失败留日志：带 Uri/解码后尺寸/异常，下次用户再报「无法读取」能直接判断
                    // 是 HEIC 解不开、图太大还是图里确实没码，不用再靠猜
                    Log.w(TAG, "gallery decode failed: " + name + " " + fw + "x" + fh + " " + err);
                }
            }
        }, "scan-gallery").start();
    }

    /**
     * 先量尺寸再按最长边采样解码。相册里 4000×3000 的图直接 decode 成 ARGB_8888
     * 约 48MB，低内存机型必崩；采到 ≤1600px 后二维码仍远大于 ZXing 的识别下限。
     */
    private Bitmap loadSampledBitmap(Uri uri) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("openInputStream 返回 null");
        try {
            BitmapFactory.decodeStream(in, null, bounds);
        } finally {
            closeQuietly(in);
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("读不到图片尺寸，可能不是位图（HEIC 等）");
        }
        int sample = 1;
        int longEdge = Math.max(bounds.outWidth, bounds.outHeight);
        while (longEdge / sample > MAX_IMAGE_EDGE) sample *= 2;

        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        in = getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("openInputStream 返回 null（第二次）");
        Bitmap raw;
        try {
            raw = BitmapFactory.decodeStream(in, null, opts);
        } finally {
            closeQuietly(in);
        }
        if (raw == null) throw new IOException("BitmapFactory 解码失败");
        return applyExifOrientation(uri, raw);
    }

    /**
     * 相册照片的像素方向不等于显示方向：手机竖着拍的照片经常是「横向像素 + EXIF 旋转 90°」，
     * 自拍镜头存下来的还可能是镜像。
     *
     * ZXing 的二维码定位对 90° 旋转本身不敏感（实测能解），所以这里不是为了「能解码」，
     * 而是把镜像（翻拍/自拍保存）这种真解不出来的情况拉回来，同时让位图方向和用户看到的一致。
     */
    private Bitmap applyExifOrientation(Uri uri, Bitmap src) {
        int orientation = ExifInterface.ORIENTATION_NORMAL;
        InputStream in = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in != null) {
                orientation = new ExifInterface(in)
                        .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            }
        } catch (Exception e) {
            // PNG/截图没有 EXIF，或部分 provider 的流不可 seek：按正常方向处理即可
            Log.w(TAG, "exif read failed: " + e);
        } finally {
            closeQuietly(in);
        }
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90: m.setRotate(90); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.setRotate(180); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.setRotate(270); break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.setScale(-1, 1); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.setScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: m.setRotate(90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: m.setRotate(270); m.postScale(-1, 1); break;
            default: return src;
        }
        try {
            Bitmap out = Bitmap.createBitmap(src, 0, 0, src.getWidth(), src.getHeight(), m, true);
            if (out != src) src.recycle();
            return out;
        } catch (Throwable t) {
            // 超大图转正时可能 OOM：退回未转正的位图，宁可多试一次但也别直接崩
            Log.w(TAG, "rotate failed: " + t);
            return src;
        }
    }

    private static void closeQuietly(Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Exception ignored) {
            /* 关不掉无影响 */
        }
    }

    private void onDecoded(final String text) {
        final String value = text == null ? "" : text.trim();
        if (value.isEmpty()) return;
        // 只接受 http/https 地址；识别到别的二维码就继续扫，不误退出。
        if (!UrlRules.isHttpUrl(value)) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    if (hintView != null) hintView.setText("该二维码不是 DSH 连接地址，请继续扫描");
                }
            });
            return;
        }
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (finishing) return;
                finishing = true;
                Intent out = new Intent();
                out.putExtra(EXTRA_TEXT, value);
                setResult(RESULT_OK, out);
                finish();
            }
        });
    }

    /**
     * 按固定宽高比测量自身、在父容器里居中的 FrameLayout。
     *
     * 为什么不用 Matrix 缩 SurfaceView：SurfaceView 的 Surface 是独立的显示层，
     * 父容器给多大它就多大，Camera1 再把预览拉伸填满 Surface；只要显示框比例和
     * 预览比例不一致，画面就是变形的。这里直接把「框」量成预览比例，相机无需补偿。
     */
    private static final class AspectRatioLayout extends FrameLayout {
        private float ratio = 0f; // 宽/高；0 = 还不知道，先按父容器铺满

        AspectRatioLayout(Context context) {
            super(context);
        }

        void setAspectRatio(float value) {
            if (value <= 0f || Math.abs(value - ratio) < 0.0001f) return;
            ratio = value;
            requestLayout();
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int w = MeasureSpec.getSize(widthSpec);
            int h = MeasureSpec.getSize(heightSpec);
            if (ratio > 0f && w > 0 && h > 0) {
                // 取较小者：完整装入画面，多出来的方向留黑边（letterbox），不裁切也不拉伸
                if ((float) w / (float) h > ratio) w = Math.round(h * ratio);
                else h = Math.round(w / ratio);
            }
            super.onMeasure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
        }
    }
}
