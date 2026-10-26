// 扫码入口位置静态检查：侧栏不再有，设置页有。
import fs from 'node:fs';

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log('ok  ', name);
  else { fail += 1; console.log('FAIL', name, extra); }
};

check('侧栏 panellist 入口已移除', !client.includes("name: 'sidebar.panellist'"));
check('旧 main 页面已移除', !client.includes("key: 'mobile-studio-scan'"));
check('注册到设置页 settings.section', client.includes("name: 'settings.section'"));
check('设置页 section id', client.includes("id: 'mobile-studio-scan'"));
check('设置页排序 12', client.includes('order: 12'));
check('设置页标签为移动端访问', /label:\s*function\s*\(\)\s*\{\s*return\s*'移动端访问'/.test(client));
// 页内标题用户明确要求保持原样，别再跟着改
check('页内标题仍是手机扫码访问', client.includes("'手机扫码访问'"));
check('内容复用 ScanPage', client.includes('h(ScanPage, { embedded: true })'));
check('ScanPage 支持 embedded', /function ScanPage\(props\)/.test(client) && client.includes("props && props.embedded"));
check('内嵌样式类存在', client.includes('ms-scan--settings'));
check('Boundary 支持自定义错误标签', client.includes("this.props.label || '新建任务按钮'"));

const sectionAt = client.indexOf("name: 'settings.section'");
const guardAt = client.lastIndexOf('if (!isMobileNow()) return;');
check('设置区在移动端守卫之前注册（桌面可见）', sectionAt > 0 && guardAt > 0 && sectionAt < guardAt);

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exitCode = fail === 0 ? 0 : 1;
