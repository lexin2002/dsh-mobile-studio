// 新建任务命名（0.9.3）：用户可给工作区起名，留空仍用日期自动名，重名自动 -2 / -3。
// 直接测导出的纯函数 + 真文件系统（临时目录），不碰真实 Hermes 根目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskDir, sanitizeTaskName, todayStamp, pickDirName } from '../index.js';

let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('ok  ', name);
  else {
    fail += 1;
    console.log('FAIL', name, extra);
  }
};

// ---- 纯函数：名字清洗 ----
check('去掉路径分隔符', sanitizeTaskName('a/b\\c') === 'abc', sanitizeTaskName('a/b\\c'));
check('去掉 Windows 非法字符', sanitizeTaskName('a:*?"<>|b') === 'ab', sanitizeTaskName('a:*?"<>|b'));
check('折叠空白并去首尾', sanitizeTaskName('  我的  任务  ') === '我的 任务', JSON.stringify(sanitizeTaskName('  我的  任务  ')));
check('超长截到 40', sanitizeTaskName('x'.repeat(60)).length === 40);
check('空名字返回空串', sanitizeTaskName('   ') === '');
check('null 不炸', sanitizeTaskName(null) === '');

// ---- 真建目录：临时父目录 ----
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-task-'));
try {
  const auto = createTaskDir(parent, null, undefined);
  check('没给名字 → 用今天日期', auto.name === todayStamp(), `${auto.name} vs ${todayStamp()}`);
  check('没给名字时 auto=true', auto.auto === true);
  check('目录真的建出来了', fs.existsSync(auto.path) && fs.statSync(auto.path).isDirectory());

  const named = createTaskDir(parent, null, '冒烟-测试');
  check('给了名字 → 目录名就是它', named.name === '冒烟-测试', named.name);
  check('给了名字时 auto=false', named.auto === false);
  check('给了名字的目录存在', fs.existsSync(named.path));

  const dup = createTaskDir(parent, null, '冒烟-测试');
  check('同名自动 -2', dup.name === '冒烟-测试-2', dup.name);

  const dup3 = createTaskDir(parent, null, '冒烟-测试');
  check('再同名自动 -3', dup3.name === '冒烟-测试-3', dup3.name);

  const dirty = createTaskDir(parent, null, 'a/b:c*?');
  check('脏名字落盘前被清洗', dirty.name === 'abc', dirty.name);

  const blank = createTaskDir(parent, null, '   ');
  check('空白名字落回日期自动名', blank.name.startsWith(todayStamp()), blank.name);

  // pickDirName 本身仍然是"给个前缀、重名加序号"的老语义（别被新参数改坏）
  check('pickDirName 语义没变', pickDirName(parent, 'zzz') === 'zzz');
  fs.mkdirSync(path.join(parent, 'zzz'));
  check('pickDirName 重名加 -2', pickDirName(parent, 'zzz') === 'zzz-2');
} finally {
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
