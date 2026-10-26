// 实时扫码回归：用 vendored ZXing 解一张真实二维码的 Y 平面 + 静态接线检查。
//
// 真机相机预览无法在这里复现，但"二维码矩阵 → NV21 Y 平面 → ZXing 解回原文"
// 与 ScanActivity 的解码路径是同一段（PlanarYUVLuminanceSource + HybridBinarizer），
// 解码层出问题这里会先红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const here = (p) => path.join(root, p);
const jdk = process.env.JAVA_HOME || '';
if (!jdk) { console.log('SKIP 需要 JAVA_HOME 指向 JDK 17'); process.exit(0); }
const javac = path.join(jdk, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
const java = path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log('ok  ', name);
  else { fail += 1; console.log('FAIL', name, extra); }
};

// ---------------------------------------------------------------- 1. 真解码
const qrSrc = fs.readFileSync(here('qr-inline.js'), 'utf8');
const qrCtx = vm.createContext({ console, TextEncoder, TextDecoder, module: { exports: {} }, exports: {} });
vm.runInContext(qrSrc + '\nthis.qrCreate = qrCreate;', qrCtx);

const payload = 'http://192.168.1.10:3081/__ms/qr?t=' + 'a'.repeat(32);
const qr = qrCtx.qrCreate(payload);
const N = qr.size;
const scale = 6;
const quiet = 4;
const W = (N + quiet * 2) * scale;
const H = W;
const y = Buffer.alloc(W * H, 255);
for (let row = 0; row < N; row++) {
  for (let col = 0; col < N; col++) {
    if (!qr.data[row * N + col]) continue;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        y[((quiet + row) * scale + dy) * W + (quiet + col) * scale + dx] = 0;
      }
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zxing-'));
fs.writeFileSync(path.join(tmp, 'frame.y'), y);
const jar = here('android/libs/core-3.5.3.jar');
const compile = spawnSync(javac, [
  '-encoding', 'UTF-8', '-cp', jar, '-d', tmp, here('tools/ZXingProbe.java'),
], { encoding: 'utf8' });
check('ZXingProbe 编译通过', compile.status === 0, compile.stderr || '');
if (compile.status === 0) {
  const run = spawnSync(java, ['-cp', tmp + path.delimiter + jar, 'ZXingProbe', path.join(tmp, 'frame.y'), String(W), String(H)], { encoding: 'utf8' });
  check('Y 平面解回带票据的登录地址', (run.stdout || '').trim() === payload, (run.stdout || '') + (run.stderr || ''));
}

// ------------------------------------------------------------ 2. 静态接线
const manifest = fs.readFileSync(here('android/AndroidManifest.xml'), 'utf8');
check('Manifest 声明 CAMERA 权限', /uses-permission android:name="android\.permission\.CAMERA"/.test(manifest));
check('Manifest 相机非必需硬件', /uses-feature[^>]*android\.hardware\.camera[^>]*required="false"/.test(manifest));
check('Manifest 注册 ScanActivity（不导出）', /android:name="\.ScanActivity"[\s\S]{0,120}?android:exported="false"/.test(manifest));

const scan = fs.readFileSync(here('android/src/com/lexin/dshmobile/ScanActivity.java'), 'utf8');
check('ScanActivity 用 Camera1 打开/释放', /Camera\.open\(\)/.test(scan) && /camera\.release\(\)|c\.release\(\)/.test(scan));
check('ScanActivity 在 onPause 释放相机', /protected void onPause\(\) \{\s*releaseCamera\(\);/.test(scan));
check('ScanActivity 解码用 ZXing', /PlanarYUVLuminanceSource/.test(scan) && /HybridBinarizer/.test(scan));
check('非法二维码继续扫描不退出', /继续扫描/.test(scan) && /isHttpUrl/.test(scan));
// 相册选图：ACTION_GET_CONTENT 不需要存储权限；位图解码只能走 RGBLuminanceSource；
// 大图必须先量尺寸再采样，直接 decode 会 OOM。
check('相册入口用 ACTION_GET_CONTENT + OPENABLE',
  /Intent\.ACTION_GET_CONTENT/.test(scan) && /CATEGORY_OPENABLE/.test(scan) && /setType\("image\/\*"\)/.test(scan));
check('相册图片走 RGBLuminanceSource 且先采样',
  /new RGBLuminanceSource\(/.test(scan) && /inJustDecodeBounds/.test(scan) && /inSampleSize/.test(scan));
check('相册解码在后台线程、回主线程前判存活',
  /new Thread\(new Runnable\(\)/.test(scan) && /isFinishing\(\) \|\| finishing/.test(scan));
check('相册失败提示无法读取该图片并留日志',
  /无法读取该图片/.test(scan) && /gallery decode failed/.test(scan));
// 取景比例：容器按预览宽高比测量，不再靠 SurfaceView 铺满父容器
check('取景按预览宽高比测量并居中',
  /AspectRatioLayout/.test(scan) && /applyPreviewRatio/.test(scan)
  && /setAspectRatio\(\(float\) vw \/ \(float\) vh\)/.test(scan));
check('Surface 重建不重开相机（只停预览）',
  /public void surfaceDestroyed[\s\S]{0,300}?stopPreview\(\);/.test(scan)
  && !/surfaceCreated[\s\S]{0,120}?releaseCamera\(\)/.test(scan));

const bridge = fs.readFileSync(here('android/src/com/lexin/dshmobile/ShellBridge.java'), 'utf8');
check('ShellBridge.scan 有 shellMode 守卫',
  /public void scan\(\) \{\s*\n\s*if \(!host\.inShellMode\(\)\) return;/.test(bridge));
check('ShellBridge.refreshWorkbench 有 shellMode 守卫',
  /public void refreshWorkbench\(final boolean clearCache\) \{\s*\n\s*if \(!host\.inShellMode\(\)\) return;/.test(bridge));

const main = fs.readFileSync(here('android/src/com/lexin/dshmobile/MainActivity.java'), 'utf8');
check('MainActivity 权限申请走 REQ_CAMERA', /requestPermissions\(new String\[\]\{Manifest\.permission\.CAMERA\}, REQ_CAMERA\)/.test(main));
check('扫码结果用 UrlRules 校验', /REQ_SCAN[\s\S]{0,400}?UrlRules\.normalize/.test(main));

const build = fs.readFileSync(here('tools/build-apk.ps1'), 'utf8');
check('出包脚本把 libs/*.jar 编进 dex', /libJars/.test(build) && /dexInputs/.test(build));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exitCode = fail === 0 ? 0 : 1;
