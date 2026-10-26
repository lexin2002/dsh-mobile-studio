// 生成 android/assets/jsqr.js：把固定版本的 jsQR 解码器内嵌成 App 资源。
//
// 为什么必须内嵌：shell.html 用 loadDataWithBaseURL("http://shell.local/") 打开，
// 外链 <script src="jsqr.js"> 会被 WebView 当成网络请求，必然 404。
//
// 为什么锁定版本和摘要：解码库是本地页里唯一处理用户照片的第三方代码，
// 升级必须是一次显式的改版本号 + 改摘要，不能跟着 npm 漂。
//
// 用法：
//   node tools/build-scan.mjs            生成（需要网络，第一次/升级时用）
//   node tools/build-scan.mjs --check    只校验仓库里的文件与钉死的摘要一致
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const VERSION = '1.4.0';
// npm tarball 与其中 dist/jsQR.js 的 sha256（写死：内容变了就必须改这里并重跑）
const TGZ_SHA = 'b5299b37917a1fe7a8cab9dd5cc6b8accf82663add80abe5bf7761a921cc6602';
const FILE_SHA = 'bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859';
const TGZ_URL = `https://registry.npmjs.org/jsqr/-/jsqr-${VERSION}.tgz`;
const OUT = new URL('../android/assets/jsqr.js', import.meta.url);
// 许可证必须随代码走：jsQR 是 MIT，删了就是无授权分发。
const HEADER =
  `/*! jsQR v${VERSION} | MIT License | Copyright (c) 2016 Cosmo Wolfe and contributors\n` +
  ` *  内嵌二维码解码库：由 tools/build-scan.mjs 生成，请勿手改。\n` +
  ` *  来源：https://www.npmjs.com/package/jsqr  (dist/jsQR.js, sha256 ${FILE_SHA}) */\n`;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 极简 tar 读取：够拿 npm 包里单个普通文件，不引入打包依赖。 */
function untar(tgz, wantPath) {
  const tar = zlib.gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break; // 全零块 = 结束
    const prefix = tar.toString('utf8', off + 345, off + 500).replace(/\0.*$/, '');
    const size = parseInt(tar.toString('ascii', off + 124, off + 136).trim(), 8) || 0;
    const type = tar.toString('ascii', off + 156, off + 157);
    const full = prefix ? prefix + '/' + name : name;
    const start = off + 512;
    if (type !== '5' && full === wantPath) return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * 下载 tarball。优先 Node fetch；失败时退 npm pack —— 本机的 npm 走的是
 * 自己的 registry/代理配置，Node 原生 fetch 在这台机器上会 TLS 断连（实测）。
 * 两条路都校验同一个钉死摘要，来源不同不影响可信度。
 */
async function downloadTgz() {
  try {
    const res = await fetch(TGZ_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } catch {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsqr-'));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['pack', 'jsqr@' + VERSION, '--silent', '--pack-destination', tmp], {
      stdio: 'ignore',
      shell: process.platform === 'win32', // .cmd 需要 shell 才找得到
    });
    const name = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!name) throw new Error('npm pack 没产出 tgz');
    return fs.readFileSync(path.join(tmp, name));
  }
}

async function fetchPinned() {
  const tgz = await downloadTgz();
  const got = sha256(tgz);
  if (got !== TGZ_SHA) throw new Error('jsQR 包摘要不匹配：' + got + '（期望 ' + TGZ_SHA + '）');
  const file = untar(tgz, 'package/dist/jsQR.js');
  if (!file) throw new Error('包内没找到 package/dist/jsQR.js');
  const fsha = sha256(file);
  if (fsha !== FILE_SHA) throw new Error('jsQR.js 摘要不匹配：' + fsha + '（期望 ' + FILE_SHA + '）');
  return file;
}

async function main() {
  const check = process.argv.includes('--check');
  const HEADER_BUF = Buffer.from(HEADER);
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;

  if (check) {
    if (!existing) throw new Error('缺少 android/assets/jsqr.js，先跑 node tools/build-scan.mjs');
    if (!existing.subarray(0, HEADER_BUF.length).equals(HEADER_BUF)) {
      throw new Error('android/assets/jsqr.js 头注释不对（被手改过？用 build-scan.mjs 重新生成）');
    }
    const body = existing.subarray(HEADER_BUF.length);
    const got = sha256(body);
    if (got !== FILE_SHA) throw new Error('jsqr.js 内容摘要不匹配：' + got);
    console.log('ok   jsqr ' + VERSION + ' 内嵌文件与钉死摘要一致（' + body.length + ' B）');
    return;
  }

  const body = existing && sha256(existing.subarray(HEADER_BUF.length)) === FILE_SHA
    ? existing.subarray(HEADER_BUF.length) // 已经一致就不重复下载
    : await fetchPinned();
  const text = body.toString('utf8');
  // 注入方式是 <script> 包正文：正文里出现结束标签会提前截断。
  if (text.includes('</script')) throw new Error('jsQR 源码含 </script，内嵌注入不安全');
  fs.writeFileSync(OUT, Buffer.concat([Buffer.from(HEADER), body]));
  console.log('ok   写入 ' + OUT.pathname.replace(/^\//, '') + '（' + body.length + ' B, ' + VERSION + '）');
}

main().catch((e) => {
  console.error('FAIL ' + String((e && e.message) || e));
  process.exitCode = 1;
});
