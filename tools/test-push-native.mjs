// 原生接线静态检查：JS 侧已在 test-push-events/test-push-sse 覆盖，
// 这里只断言 Java/网关里“该接的线”真的接上了，防止只改一半。
import fs from 'node:fs';

let fail = 0;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const has = (name, text, needle) => {
  const ok = text.includes(needle);
  if (!ok) { fail++; console.log('FAIL', name, '缺少:', needle); }
  else console.log('ok', name);
};
const notHas = (name, text, needle) => {
  if (text.includes(needle)) { fail++; console.log('FAIL', name, '不应出现:', needle); }
  else console.log('ok', name);
};

const index = read('../index.js');
const lan = read('../lan.js');
const push = read('../android/src/com/lexin/dshmobile/PushService.java');
const main = read('../android/src/com/lexin/dshmobile/MainActivity.java');
const manifest = read('../android/AndroidManifest.xml');

has('index 用 push hub', index, 'createPushHub');
has('index 监听 session/event', index, "ctx.on('session/event'");
has('index 传 subscribeEvents', index, 'subscribeEvents,');
has('index 传 getFinishedKind', index, 'getFinishedKind: pushHub.getFinishedKind');

has('lan 帧带 kind', lan, "kind: ev.kind");
has('lan 帧带 detail', lan, 'detail: ev.detail');
has('lan tasks 带 finishedKind', lan, 'finishedKind: String(finKind');
has('lan clear 不查标题', lan, "ev.kind === 'clear'");

has('push 动态渠道 id', push, 'static String channelId(Context ctx, boolean tasks)');
has('push 长文本', push, 'new Notification.BigTextStyle()');
has('push clear', push, '"clear".equals(kind)');
has('push 去重', push, 'markSeenOnce(this, id)');
has('push 类型标题', push, 'static String titleFor');
has('push 类型正文', push, 'static String textFor');
has('push 断连兜底', push, 'CONN_ALERT_MS');
has('push 断连通知', push, 'notifyConnectionLost');
// 0.1.0 修：只看"多久没字节"会在"连着但暂时没事件"时误报（用户 2026-10-27「非常快显示断联」）
has('push 断连判据同时看"连上过"', push, 'long quiet = now - Math.max(Math.max(lastByteAt, lastConnectOkAt), sTouchAt);');
has('push 回前台刷新断连计时', push, 'static void noteForeground(Context ctx)');
has('push 回前台撤掉断连提醒', push, 'nm.cancel(CONN_NOTIFY_ID);');
has('main 回前台通知推送服务', main, 'PushService.noteForeground(this);');
has('push 渠道用系统音频属性', push, 'setSound(sound, Notification.AUDIO_ATTRIBUTES_DEFAULT)');
has('push 自带通知音兜底', push, 'return dropSoundUri(ctx);');
has('push 震动', push, 'enableVibration(true)');

has('push 选音源只扫标题不解码', push, 'static Uri pickSound(Context ctx)');
has('push 默认提示音用自带水滴', push, 'static Uri dropSoundUri(Context ctx)');
// 0.1.0(vc56)：用户从三段里选了第 2 段，只留一段音、一条渠道（随机播会多出三条渠道，小米上容易哑）
has('push 自带音只有一段', push, 'private static final int SOUND_RES = R.raw.notify_drop;');
notHas('push 不再有三分段数组', push, 'SOUND_RAW');
notHas('push 不再随机挑渠道', push, 'SOUND_ROLL');
has('push 任务完成走单条渠道', push, 'return channelId(ctx, "done".equals(kind));');
has('push 换代删掉旧的三条随机音渠道', push, 'old.add("dsh-tasks-" + gen + "-2");');
notHas('push 不再引用旧 water-drop 资源', push, 'R.raw.notify_waterdrop');
// 0.9.3：只用系统标准接口（渠道 + setSound），不做任何兜底。
has('push 媒体库写一个 mp3', push, 'dsh_waterdrop.mp3');
has('push 媒体库 MIME 用 audio/mpeg', push, 'audio/mpeg');
has('push 媒体库音源参与挑选（只读缓存）', push, 'Uri media = cachedMediaSound(ctx);');
// 启动路径上不许有 IO 写（LESSONS 6.67）：媒体库写入只能在换代那一次做
has('push 媒体库写入只在换代时发生', push, 'if (cachedMediaSound(this) == null) ensureMediaSound(this);');
notHas('push 挑音源时不做媒体库查询', push, 'ensureMediaSound(ctx);\n        if (media != null) return media;');
has('push 建渠道前先选音源', push, 'ensureChannel(ctx, id, name, desc, pickSound(ctx))');
notHas('push 不再建完删渠道换系统铃', push, 'fallback to system tone');
// 0.9.3 硬规矩：不兜底。pickSound 里不许再出现"退系统铃声"这条链。
notHas('push 不再退系统铃声', push, 'firstSystemNotificationSound');
has('push 换代用 soundV054', push, 'soundV054');
has('push 换代成功才算生效', push, 'channelSoundOk(this, true) && channelSoundOk(this, false)');
has('push 系统默认音名字照样读得到', push, 'Settings.System.NOTIFICATION_SOUND');
notHas('push 不再按标题打分换音源', push, 'toneScore');
notHas('push 不再有音源版本换代开关', push, 'SOUND_VER');
// 0.9.3 起不再读系统默认铃声/枚举系统铃声列表 —— 那两级都是"兜底"，用户明确不要。
// 音源只有两档：用户选的 > 自带 water-drop。
notHas('push 不再读系统默认铃声', push, 'RingtoneManager.getActualDefaultRingtoneUri');
has('push 息屏不误报失联', push, 'pm.isInteractive()');
has('push 没网不误报失联', push, 'hasInternet(PushService.this)');
notHas('push 不再枚举系统铃声列表', push, 'settings/system');
has('push 重建渠道', push, 'static void rebuildChannels(Context ctx)');
has('push 存用户选的提示音', push, 'setPickedSound');
has('push 渠道按代生成', push, 'dsh-tasks-" : "dsh-attention-"');

// 0.9.2 通知深链：三处通知都要带 sessionId + 按会话分 requestCode，
// MainActivity 冷启动/热启动都能接住，并等网页就绪再派发给 __msOpenSession。
has('push 推送通知带会话 id', push, 'back.putExtra("sessionId", sid)');
has('push 推送通知按会话分 requestCode', push, 'sid.isEmpty() ? 0 : sid.hashCode()');
has('main 轮询通知带会话 id', main, 'back.putExtra("sessionId", sid)');
// 0.9.6：notifyTaskFromWeb（网页直弹通知）已删——mobile.js 早就不调了，是死代码。
// 通知只剩两条真路径：PushService 主路 + 轮询兜底（notifyTaskDone）。
notHas('网页直弹通知的死代码已删', main, 'void notifyTaskFromWeb(');
has('main 网页通知按会话分 requestCode', main, 'sid.isEmpty() ? 0 : sid.hashCode()');
has('main 热启动接新 intent', main, 'protected void onNewIntent(Intent intent)');
has('main 热启动要 setIntent', main, 'setIntent(intent);');
has('main 挂起待派发的会话 id', main, 'String pendingSessionId = "";');
has('main 网页就绪后派发会话', main, 'window.__msOpenSession(');
has('main 派发前 JSON 转义', main, 'JSONObject.quote(sid)');
has('main 会话 id 有超时上限', main, 'SESSION_OPEN_MS = 15000');
has('main 壳模式不派发', main, 'if (shellMode) return;\n        if (!pageReadySeen) return;');
has('main 菜单选提示音', main, 'RingtoneManager.ACTION_RINGTONE_PICKER');
has('main 跳渠道设置', main, 'Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS');
has('main 重建渠道入口', main, '"重建通知渠道"');
has('main 读 finishedKind', main, 's.optString("finishedKind"');
has('main 通知带 kind', main, 'void notifyTaskDone(String sessionId, String title, long finishedAt, String kind)');
has('main 分派渠道', main, 'PushService.channelId(this, "done".equals(k))');
has('main 复用标题', main, 'PushService.titleFor(k)');

// 1.3.1：后台收不到推送 = 前台服务没真正进前台。
// connectedDevice 在 Android 14+ 需要前置权限之一，缺了 startForeground 抛
// SecurityException；以前被 catch 吞掉，服务静默退化成普通后台服务。
has('manifest connectedDevice 前置权限', manifest, 'android.permission.CHANGE_NETWORK_STATE');
has('manifest wifi 前置权限', manifest, 'android.permission.CHANGE_WIFI_STATE');
has('manifest 组播前置权限', manifest, 'android.permission.CHANGE_WIFI_MULTICAST_STATE');
has('push 前台结果可返回', push, 'private boolean goForeground()');
has('push 前台失败要记原因', push, 'sFgError = e.getClass().getSimpleName()');
has('push 前台失败要弹通知', push, 'notifyForegroundFailed');
has('push 常驻渠道新 id', push, 'CHANNEL_LINK = "dsh-link-v2"');
has('push 常驻通知可见', push, 'IMPORTANCE_LOW');
has('push 前台通知立刻显示', push, 'setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)');
has('push 自检文本', push, 'static String diagnose(Context ctx)');
has('push 测试通知', push, 'static void postTest(Context ctx)');
has('main 推送自检入口', main, '"推送自检"');
has('main 测试通知入口', main, '"发一条测试通知"');
has('main 跳通知设置', main, 'Settings.ACTION_APP_NOTIFICATION_SETTINGS');
has('main 跳系统设置', main, 'Settings.ACTION_APPLICATION_DETAILS_SETTINGS');
has('自检看省电白名单', push, 'isIgnoringBatteryOptimizations');
has('自检看渠道声音', push, 'ch.getSound() == null');
has('自检看铃声模式', push, 'getRingerMode()');
has('自检看勿扰', push, 'getCurrentInterruptionFilter()');

// 兼容性三件套：崩溃留证、厂商保活向导、一键忽略电池优化
const vendor = read('../android/src/com/lexin/dshmobile/Vendor.java');
const crash = read('../android/src/com/lexin/dshmobile/CrashLog.java');
has('main 装崩溃处理器', main, 'CrashLog.install(this)');
has('崩溃写进文件', crash, 'last-crash.txt');
has('自检显示上次崩溃', push, 'CrashLog.read(ctx)');
has('自检显示厂商机型', push, 'Vendor.brandName()');
has('按品牌识别厂商', vendor, 'com.miui.securitycenter');
has('厂商页先解析再跳', vendor, 'resolveActivity');
has('跳不过去退回应用信息', vendor, 'ACTION_APPLICATION_DETAILS_SETTINGS');
has('一键忽略电池优化', vendor, 'ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
has('manifest 允许请求忽略电池优化', manifest, 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
has('main 保活设置入口', main, '"保活设置（自启动/省电）"');
has('main 电池白名单入口', main, '"加入电池白名单"');

// ---- 0.9.14：把"概率事件"变成确定 ----
// 1) SSE 重连补发：手机记录 since，网关按 since 补断线期间的帧
has('push 记录已收到的最后时刻', push, 'KEY_LAST_AT = "lastAt"');
has('push 连接带 since', push, '"/m/__ms/push"');
has('push 拼 since 参数', push, '"?since=" + since');
has('push 收到帧就推进 since', push, 'noteEventAt(o.optLong("at", 0))');
has('index 把补发缓冲交给网关', index, 'getRecentEvents: pushHub.getRecent');
has('lan 支持 since 补发', lan, 'getRecentEvents(since)');
// 2) 轮询水位线落盘：进程被杀后重开也不吞掉离开期间完成的
has('main 水位线存 prefs', main, 'KEY_WATERMARKS = "push-watermarks"');
has('main 启动读回水位线', main, 'ensureWatermarks();');
has('main 每次轮询落盘', main, 'saveWatermarks();');
has('main 陈旧完成不补弹（15 分钟）', main, 'age <= 15 * 60 * 1000L');

// 0.1.0 修：手机时钟比电脑快时 since 落在未来，之后所有帧都被当旧帧丢掉（症状=推送全没了）
has('网关：时钟偏差按最近 2 分钟补发', lan, 'skew < -120000');
has('网关：推送连接落诊断', lan, "'push-connect'");
has('网关：推送断开落诊断', lan, "'push-close'");
has('网关：诊断只记元数据不记内容', lan, 'diagRec({');
// 0.1.0：标题是 JSON null 时，org.json 的 optString 读成字符串 "null" → 通知写「null 完成了」
has('网关：标题不发 null', lan, "title: title == null ? '' : String(title),");
has('push：标题 null 归一为空串', push, '"null".equals(title)');

// 0.1.0(vc57)：用户「去看通知栏才弹消息」——两半原因一起修。
// 一半是熄屏断连醒来才补（45s 读超时 + 最长 60s 退避）：亮屏/网络恢复踢一脚立刻重连。
has('push 亮屏踢醒重连', push, 'Intent.ACTION_SCREEN_ON');
has('push 网络恢复踢醒重连', push, 'registerDefaultNetworkCallback');
has('push 踢醒掐断当前连接', push, 'curConn');
has('push 踢醒跳过退避', push, 'wakeKick');
has('push 打断退避后继续循环', push, 'kickReconnect 的打断');
has('push 退出时注销踢醒器', push, 'unregisterWakeTriggers();');
// 另一半是通知只躺栏里不探头：done 曾用 CATEGORY_STATUS + 缺优先级/锁屏可见/Ticker。
notHas('push 不再用 STATUS 压住完成通知', push, '? Notification.CATEGORY_STATUS');
has('push 通知高优先级', push, 'setPriority(Notification.PRIORITY_HIGH)');
has('push 通知锁屏可见', push, 'setVisibility(Notification.VISIBILITY_PUBLIC)');
has('push 通知带 Ticker', push, '.setTicker(');
has('main 轮询通知高优先级', main, 'setPriority(Notification.PRIORITY_HIGH)');
has('main 轮询通知锁屏可见', main, 'setVisibility(Notification.VISIBILITY_PUBLIC)');
notHas('main 不再用 STATUS 压住完成通知', main, '? Notification.CATEGORY_STATUS');
has('push 自检提示悬浮开关', push, '只躺栏里不探头');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
