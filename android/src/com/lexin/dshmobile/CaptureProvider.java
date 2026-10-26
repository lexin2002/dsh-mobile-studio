package com.lexin.dshmobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 给相机 App 一个能写的 content://。
 *
 * 为什么要自己写：目标 API 24+ 之后 file:// 不能跨应用传（FileUriExposedException），
 * 而 AndroidX 的 FileProvider 我们拿不到 —— 这一版不走 Gradle，没有任何第三方依赖。
 *
 * 实现要点（容易漏）：
 *   openFile  按 mode 决定读写，拍照要 MODE_READ_WRITE|CREATE|TRUNCATE
 *   query     必须给 _display_name / _size —— Google 相机保存前会查这两个
 *   getType   钉成 image/jpeg，相机据此选编码
 */
public class CaptureProvider extends ContentProvider {

    static final String AUTHORITY = "com.lexin.dshmobile.capture";

    private File dir() {
        File d = new File(getContext().getCacheDir(), "captures");
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty() || name.indexOf('/') >= 0 || name.startsWith(".")) {
            throw new FileNotFoundException("bad name: " + uri);
        }
        return new File(dir(), name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(uri);
        boolean write = mode != null && (mode.contains("w") || mode.contains("t"));
        int flags = write
                ? ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE
                  | ParcelFileDescriptor.MODE_TRUNCATE
                : ParcelFileDescriptor.MODE_READ_ONLY;
        return ParcelFileDescriptor.open(f, flags);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sort) {
        File f;
        try {
            f = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) {
                row[i] = f.getName();
            } else if (OpenableColumns.SIZE.equals(cols[i])) {
                row[i] = Long.valueOf(f.length());
            } else {
                row[i] = null;
            }
        }
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
