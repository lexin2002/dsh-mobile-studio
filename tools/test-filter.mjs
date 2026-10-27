// 单测 mobile-filter.js：反引号解析、勾选即放行、URL 不被改。
import { segments, filterCombo, setAllow, getAllow, allow, filterHtml, setLocal, isLocal, isCompat, isAlwaysAllowed, seedDefaults, SELF } from '../mobile-filter.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok', name);
};

// 1. 三种引号都能解析
const combo = [
  'window.__ModuleLoader__.load({ id: "dsh-a", factory: (r) => {} });',
  'window.__ModuleLoader__.load({id:`dsh-context`,factory:e=>{}});',
  "window.__ModuleLoader__.load({id:'dsh-b',factory:()=>{}});",
].join('\n');
eq('segments ids', segments(combo).map((s) => s.id), ['dsh-a', 'dsh-context', 'dsh-b']);

// 2. 官方永远放行，第三方只在名单里才放行
setAllow(['dsh-opencode-go', 'dsh-context']);
eq('allow official', allow('@deepseek-ai/dsh-client-ui-chat'), true);
eq('allow dsh-context', allow('dsh-context'), true);
eq('block curator', allow('dsh-curator'), false);

// 3. filterCombo：不在名单的段被剥，反引号段按名单保留
const out = filterCombo(combo);
eq('kept dsh-context body', out.body.includes('id:`dsh-context`'), true);
eq('dropped dsh-a/dsh-b', out.dropped.sort(), ['dsh-a', 'dsh-b']);

// 3b. 被剥的段输出空模块桩（不是纯注释）：加载器以“是否调 load 注册”判定成功，
//     纯注释会导致设置页报 loaded without registering（真机实测）。
eq('stub registers dsh-a', out.body.includes('window.__ModuleLoader__.load({id:"dsh-a"'), true);
eq('stub registers dsh-b', out.body.includes('window.__ModuleLoader__.load({id:"dsh-b"'), true);
eq('stub factory empty', out.body.includes('factory:function(){return {apply:function(){}};}'), true);
eq('no bare comment stub', /\/\* mobile-filtered/.test(out.body), false);

// 4. 勾掉 = 立即不放行（同一个开关只有一种含义）
setAllow(['dsh-context']);
eq('unchecked no longer allowed', allow('dsh-opencode-go'), false);
eq('still allowed when checked', allow('dsh-context'), true);

// 5. 空名单：只放官方
setAllow([]);
eq('empty list blocks third', allow('dsh-context'), false);
eq('empty list still official', allow('@deepseek-ai/x'), true);
eq('getAllow empty', getAllow(), []);

// 6. 清洗：去空、去重、挡非字符串与超长
setAllow({ allow: [' a ', 'a', '', 3, 'b', 'x'.repeat(300)] });
eq('normalize allow', getAllow(), ['a', 'b']);

// 7. 组合脚本 URL 一个字都不能改：官方按批次清单核对 rev，
//    裁短或去掉 rev 都是 404（实测）。这里断言 filterHtml 不碰 preload。
setAllow(['dsh-opencode-go', 'dsh-context']);
const html = '<link rel="preload" as="script" href="plugins/??@deepseek-ai/a/client.js,dsh-curator/client.js&rev=abc">'
  + '<link rel="stylesheet" href="x.css">';
const fhKeep = filterHtml(html);
eq('filterHtml leaves preload href alone', fhKeep.body.includes('dsh-curator/client.js&rev=abc'), true);

// 8. filterHtml：entries 与 batches 都按名单过
const boot = {
  entries: [{ id: '@deepseek-ai/a' }, { id: 'dsh-curator' }, { id: 'dsh-context' }],
  batches: [{ entries: ['@deepseek-ai/a', 'dsh-curator'] }],
};
const page = '<script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify(boot) + ';</script>';
const fh = filterHtml(page);
eq('filterHtml dropped', fh.dropped, ['dsh-curator']);
eq('filterHtml kept context', fh.body.includes('dsh-context'), true);
eq('filterHtml batch cleaned', /"batches":\[\{"entries":\["@deepseek-ai\/a"\]\}\]/.test(fh.body), true);

// 9. 本体与兼容插件：本体永远放行（不进列表也能过），兼容进列表、默认靠种子
setLocal(['dsh-curator', 'dsh-mobile-studio', 'dsh-opencode-go-server-error-retry']);
eq('SELF constant', SELF, 'dsh-mobile-studio');
eq('self always allowed', allow('dsh-mobile-studio'), true);
eq('isCompat curator', isCompat('dsh-curator'), true);
eq('isCompat retry', isCompat('dsh-opencode-go-server-error-retry'), true);
eq('isCompat self false', isCompat('dsh-mobile-studio'), false);
eq('isCompat third false', isCompat('dsh-context'), false);
eq('alwaysAllowed self', isAlwaysAllowed('dsh-mobile-studio'), true);
eq('alwaysAllowed official', isAlwaysAllowed('@deepseek-ai/x'), true);
eq('alwaysAllowed compat false', isAlwaysAllowed('dsh-curator'), false);
setAllow(['dsh-opencode-go']);
eq('compat off blocks', allow('dsh-curator'), false);
eq('self still passes', allow('dsh-mobile-studio'), true);
setAllow(['dsh-opencode-go', 'dsh-curator']);
eq('compat on passes', allow('dsh-curator'), true);

// 10. seedDefaults：一次性种子，之后全由用户勾选决定
const s1 = seedDefaults(null, ['dsh-curator', 'dsh-retry']);
eq('fresh seeds EXTRA+compat', s1.allow.sort(), ['dsh-context', 'dsh-curator', 'dsh-opencode-go', 'dsh-retry'].sort());
eq('fresh wants writeBack', s1.writeBack, true);
const s2 = seedDefaults({ allow: ['dsh-opencode-go', 'dsh-curator'], seeded: true }, ['dsh-curator', 'dsh-new']);
eq('marked untouched', s2.allow.sort(), ['dsh-curator', 'dsh-opencode-go'].sort());
eq('marked no writeBack', s2.writeBack, false);
const s3 = seedDefaults({ allow: ['dsh-opencode-go'] }, ['dsh-curator']);
eq('unseeded unions compat only', s3.allow.sort(), ['dsh-curator', 'dsh-opencode-go'].sort());
eq('unseeded wants writeBack', s3.writeBack, true);

// 11. 可疑即过滤：id 解析不出的段不再原样保留，输出空桩并记 (unparsed@偏移)
setAllow(['dsh-keep']);
const susCombo = [
  'window.__ModuleLoader__.load({ id: "dsh-keep", factory: (r) => {} });',
  'window.__ModuleLoader__.load({ nam3: "dsh-evil", factory: (r) => { evil(); } });',
].join('\n');
const susIds = segments(susCombo).map((s) => s.id);
eq('unparsed segment id null', susIds, ['dsh-keep', null]);
const susOut = filterCombo(susCombo);
eq('kept allowed body', susOut.body.includes('id: "dsh-keep"'), true);
eq('suspicious body gone', susOut.body.includes('evil()'), false);
eq('suspicious stub registers', susOut.body.includes('window.__ModuleLoader__.load({id:"__ms_filtered_'), true);
eq('suspicious dropped logged', susOut.dropped.length === 1 && susOut.dropped[0].startsWith('(unparsed@'), true);

// 12. 段内全文搜 id：id 不在 load({ 紧后面（>240 字）也能认出来
setAllow(['dsh-far']);
const farCombo = 'window.__ModuleLoader__.load({\n' + ' '.repeat(300) + 'id:`dsh-far`, factory:e=>{}});';
eq('far id found', segments(farCombo).map((s) => s.id), ['dsh-far']);
eq('far id kept', filterCombo(farCombo).body.includes('id:`dsh-far`'), true);

// 13. filterHtml dropped 只收字符串：entries 里混 null/数字/对象不进日志
setAllow([]);
const dirtyBoot = {
  entries: [{ id: 'dsh-x' }, { id: null }, { id: 42 }, { id: { o: 1 } }, null],
  batches: [{ entries: ['dsh-y', 7, null] }],
};
const dirtyPage = '<script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify(dirtyBoot) + ';</script>';
const dirty = filterHtml(dirtyPage);
eq('dirty dropped strings only', dirty.dropped.sort(), ['dsh-x', 'dsh-y']);

// 14. 注释里的 marker 不是段：bootstrap 包注释文档里写着 load({ 当例子，
//     以前 naive 切段会把它当第二段开头把 46KB 真文件拦腰截成 880 字节，
//     整页报 "HTML did not preload @deepseek-ai/dsh-client-modules/client.js"。
setAllow([]);
const bootLike = 'window.__ModuleLoader__.load({\n\tid: "@deepseek-ai/dsh-client-modules",\n\tfactory: (require) => {\n'
  + '\t\t/**\n\t\t * Lazy CJS model: executing a plugin bundle only REGISTERS its\n'
  + '\t\t * factory (`window.__ModuleLoader__.load({id, factory})`); every module body\n'
  + '\t\t */\n\t\treturn {};\n\t}\n});';
eq('comment marker ignored', segments(bootLike).map((s) => s.id), ['@deepseek-ai/dsh-client-modules']);
eq('bootstrap passthrough', filterCombo(bootLike).body, bootLike);

// 15. 正则/字符串里的引号不能吞掉真分段：上一版全文件扫注释把 /'/g 当字符串起点，
//     后面真 marker 全被吞进注释区间合并，前段官方 id 整段放行第三方皮肤漏进手机端。
setAllow(['keep-a']);
const tricky = 'window.__ModuleLoader__.load({ id: "keep-a", factory: (r) => { var re = /\'/g; } });\n'
  + 'window.__ModuleLoader__.load({ id: "evil-b", factory: (r) => { hack(); } });';
eq('regex quote does not merge', segments(tricky).map((s) => s.id), ['keep-a', 'evil-b']);
const tout = filterCombo(tricky);
eq('evil-b dropped', tout.dropped, ['evil-b']);
eq('hack gone', tout.body.includes('hack()'), false);
eq('keep-a kept', tout.body.includes('var re'), true);

// 16. 真实产物是「IIFE 包着代码、load 调用在最后」：
//     `;(()=>{ …200KB… window.__ModuleLoader__.load({...}); })();`
//     旧实现把 load 当段开头、到 EOF 当结尾，连带删掉收尾的 `}` 与 `})();`，
//     整个文件在函数中间断掉 → 手机页 `SyntaxError: Unexpected end of input`
//     （用户 2026-10-27「刷新后报错」）。现在必须整块 IIFE 一起换掉，且语法可通过。
const wrapKeep = ';(()=>{\nconst a = 1;\nwindow.__ModuleLoader__.load({\n\tid: "keep-w",\n\tfactory: () => ({ apply() {} })\n});\n})();\n';
const wrapEvil = ';(()=>{\nconst b = () => hack();\nwindow.__ModuleLoader__.load({\n\tid: "evil-w",\n\tfactory: makeFactory()\n});\n})();\n';
const parses = (s) => { try { new Function(s); return true; } catch { return false; } };

setAllow(['keep-w']);
const wOnly = filterCombo(wrapKeep);
eq('wrapped allowed untouched', wOnly.body, wrapKeep);
eq('wrapped allowed no drops', wOnly.dropped, []);

const wMix = filterCombo(wrapKeep + wrapEvil);
eq('wrapped evil dropped', wMix.dropped, ['evil-w']);
eq('wrapped evil code gone', wMix.body.includes('hack()'), false);
eq('wrapped keep code intact', wMix.body.includes('const a = 1;'), true);
eq('wrapped stub registers', wMix.body.includes('window.__ModuleLoader__.load({id:"evil-w"'), true);
eq('wrapped closing braces not eaten', wMix.body.includes('})();'), true);
eq('wrapped result parses', parses(wMix.body), true);
eq('wrapped not fail-open', wMix.fallback === undefined, true);

// 只含被剥插件时：整块换桩，结果同样是合法脚本
setAllow([]);
const wEvil = filterCombo(wrapEvil);
eq('only-evil dropped', wEvil.dropped, ['evil-w']);
eq('only-evil parses', parses(wEvil.body), true);
eq('only-evil no leftover', wEvil.body.includes('hack()'), false);
eq('only-evil only stub load', wEvil.body.split('__ModuleLoader__.load({').length - 1, 1);

// 17. id 只认这次 load 调用：插件代码里可能有 `id: "FALLBACK"` 之类的字段，
//     无锚点的 ID_RE 会先命中它，导致桩注册错 id（真机 dsh-pet 实测）。
const wrapDecoy = ';(()=>{\nconst cfg = { id: "FALLBACK", n: 1 };\nwindow.__ModuleLoader__.load({\n\tid: "evil-x",\n\tfactory: makeFactory()\n});\n})();\n';
setAllow([]);
const decoy = filterCombo(wrapDecoy);
eq('decoy id not used', decoy.dropped, ['evil-x']);
eq('stub uses real id', decoy.body.includes('window.__ModuleLoader__.load({id:"evil-x"'), true);
eq('decoy result parses', parses(decoy.body), true);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
