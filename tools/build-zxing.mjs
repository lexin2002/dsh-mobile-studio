// 生成 android/libs/core-3.5.3.jar：把 ZXing core 固定版本 vendor 进仓库。
//
// 为什么不用 Gradle 依赖：这个壳是 aapt2 → javac → d8 手写流水线，
// 没有 Gradle/AndroidX；一个纯 Java 的 jar 直接进 classpath + d8 输入最省事。
//
// 用法：
//   node tools/build-zxing.mjs            生成（需要网络）
//   node tools/build-zxing.mjs --check    只校验仓库里的 jar 与钉死的摘要一致
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '3.5.3';
const SHA256 = '8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82';
const URL_ = `https://repo1.maven.org/maven2/com/google/zxing/core/${VERSION}/core-${VERSION}.jar`;
const OUT = new URL('../android/libs/core-' + VERSION + '.jar', import.meta.url);

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function download() {
  // Node 原生 fetch 在本机会 TLS 断连（npm 走自己的代理才通），退 curl.exe。
  try {
    const res = await fetch(URL_, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } catch {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zxing-')), 'core.jar');
    execFileSync('curl.exe', ['-sSL', '--max-time', '180', '-o', tmp, URL_], { stdio: 'ignore' });
    return fs.readFileSync(tmp);
  }
}

async function main() {
  fs.mkdirSync(path.dirname(fileURLToPath(OUT)), { recursive: true });
  const check = process.argv.includes('--check');
  if (check) {
    if (!fs.existsSync(OUT)) throw new Error('缺少 android/libs/core-' + VERSION + '.jar');
    const got = sha(fs.readFileSync(OUT));
    if (got !== SHA256) throw new Error('zxing jar 摘要不匹配：' + got);
    console.log('ok   zxing core ' + VERSION + ' 与钉死摘要一致');
    return;
  }
  if (fs.existsSync(OUT) && sha(fs.readFileSync(OUT)) === SHA256) {
    console.log('ok   已存在且摘要一致，跳过下载');
    return;
  }
  const buf = await download();
  const got = sha(buf);
  if (got !== SHA256) throw new Error('下载的 jar 摘要不匹配：' + got + '（期望 ' + SHA256 + '）');
  fs.writeFileSync(OUT, buf);
  console.log('ok   写入 android/libs/core-' + VERSION + '.jar（' + buf.length + ' B）');
}

main().catch((e) => {
  console.error('FAIL ' + String((e && e.message) || e));
  process.exitCode = 1;
});
