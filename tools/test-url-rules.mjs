// UrlRules 回归：用 JDK 直接编译纯 Java 规则类 + 探针（不碰 Android），跑边界用例。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const jdk = process.env.JAVA_HOME || '';
if (!jdk) { console.log('SKIP 需要 JAVA_HOME 指向 JDK 17'); process.exit(0); }
const javac = path.join(jdk, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
const java = path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlrules-'));
const src = path.join(root, 'android', 'src', 'com', 'lexin', 'dshmobile', 'UrlRules.java');
const probe = path.join(root, 'tools', 'UrlRulesProbe.java');

const compile = spawnSync(javac, ['-encoding', 'UTF-8', '-d', tmp, src, probe], { encoding: 'utf8' });
if (compile.status !== 0) {
  console.error('FAIL javac:\n' + (compile.stderr || compile.stdout));
  process.exit(1);
}
const run = spawnSync(java, ['-cp', tmp, 'com.lexin.dshmobile.UrlRulesProbe'], { encoding: 'utf8' });
process.stdout.write(run.stdout || '');
if (run.stderr) process.stderr.write(run.stderr);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(run.status === 0 ? 0 : 1);
