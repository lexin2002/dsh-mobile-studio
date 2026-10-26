package com.lexin.dshmobile;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

/**
 * 各家 ROM 的「自启动 / 后台省电」入口。
 *
 * 国产 ROM 普遍有自己一套后台管控：前台服务、通知渠道都对，App 还是会被
 * 悄悄杀掉或冻结。系统没有统一 API 能关掉它，唯一现实的做法是把用户
 * 直接送到对应品牌的开关页面，并且页面上说清楚该点哪几项。
 *
 * 所有 Component 都是各家系统的私有页面，换个版本就可能改名/消失，
 * 所以这里一律「先看能不能解析再跳」，全都不行就退回应用信息页。
 */
public final class Vendor {
    private Vendor() {
    }

    public static String brand() {
        String b = (Build.MANUFACTURER + " " + Build.BRAND).toLowerCase();
        if (b.contains("xiaomi") || b.contains("redmi") || b.contains("poco")) return "xiaomi";
        if (b.contains("huawei") || b.contains("honor")) return "huawei";
        if (b.contains("oppo") || b.contains("realme") || b.contains("oneplus")) return "oppo";
        if (b.contains("vivo") || b.contains("iqoo")) return "vivo";
        if (b.contains("samsung")) return "samsung";
        if (b.contains("meizu")) return "meizu";
        return "other";
    }

    public static String brandName() {
        switch (brand()) {
            case "xiaomi": return "小米 / 红米（HyperOS、MIUI）";
            case "huawei": return "华为 / 荣耀（HarmonyOS、MagicOS）";
            case "oppo": return "OPPO / 一加 / realme（ColorOS）";
            case "vivo": return "vivo / iQOO（OriginOS）";
            case "samsung": return "三星（One UI）";
            case "meizu": return "魅族（Flyme）";
            default: return Build.MANUFACTURER + "（原生风格系统）";
        }
    }

    /** 这个品牌要手动点哪几项；自检里直接显示，用户照着做就行。 */
    public static String tip() {
        switch (brand()) {
            case "xiaomi":
                return "设置 → 应用设置 → 应用管理 → DSH：\n"
                        + "· 省电策略改成「无限制」\n"
                        + "· 其他权限里打开「自启动」「后台弹出界面」\n"
                        + "· 通知管理 → 需要你处理：声音、悬浮通知都打开\n"
                        + "（HyperOS 还会在后台 10 分钟清理一次，锁屏前把 DSH 从最近任务里上滑锁定）";
            case "huawei":
                return "设置 → 应用 → 应用启动管理 → DSH：关掉「自动管理」，"
                        + "手动打开「自启动」「关联启动」「后台活动」。\n"
                        + "设置 → 电池 → 更多电池设置：关掉「休眠时始终保持网络连接」以外的限制，"
                        + "并把 DSH 加入「不允许后台限制」名单。";
            case "oppo":
                return "设置 → 电池 → 应用耗电管理 → DSH：允许「后台运行」「自启动」「关联启动」。\n"
                        + "设置 → 应用管理 → DSH → 通知：允许横幅与声音。";
            case "vivo":
                return "设置 → 电池 → 后台耗电管理 → DSH：选「允许后台高耗电」。\n"
                        + "i管家 → 应用管理 → 自启动：允许 DSH。";
            case "samsung":
                return "设置 → 电池 → 后台使用限制：把 DSH 从「已休眠的应用」里移除，"
                        + "并关掉「自动优化」。\n设置 → 应用 → DSH → 通知：允许横幅与声音。";
            case "meizu":
                return "手机管家 → 权限管理 → 后台管理：允许 DSH 后台运行。\n"
                        + "设置 → 应用管理 → DSH → 通知：允许横幅与声音。";
            default:
                return "设置 → 应用 → DSH → 电池：选「不受限制」；通知：允许横幅与声音。";
        }
    }

    /**
     * 跳到这个品牌的「自启动 / 后台管理」页面。
     * 返回 true 表示真的切到了某个系统页面。
     */
    public static boolean open(Context ctx) {
        String[][] targets = targets(brand());
        for (String[] t : targets) {
            if (start(ctx, t[0], t[1])) return true;
        }
        if (startAction(ctx, new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:" + ctx.getPackageName())))) {
            return true;
        }
        return startAction(ctx, new Intent(Settings.ACTION_SETTINGS));
    }

    /** 一键「忽略电池优化」：原生页面，比让用户自己在设置里翻强。 */
    public static boolean requestIgnoreBatteryOptimizations(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < 23) return false;
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            return startAction(ctx, i);
        } catch (Exception e) {
            return false;
        }
    }

    private static String[][] targets(String brand) {
        switch (brand) {
            case "xiaomi":
                return new String[][]{
                        {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                        {"com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"},
                };
            case "huawei":
                return new String[][]{
                        {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                        {"com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"},
                };
            case "oppo":
                return new String[][]{
                        {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                        {"com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"},
                        {"com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"},
                        {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
                };
            case "vivo":
                return new String[][]{
                        {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
                        {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"},
                        {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"},
                };
            case "samsung":
                return new String[][]{
                        {"com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"},
                        {"com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"},
                };
            case "meizu":
                return new String[][]{
                        {"com.meizu.safe", "com.meizu.safe.permission.SmartBGActivity"},
                        {"com.meizu.safe", "com.meizu.safe.security.SHOW_APPSEC"},
                };
            default:
                return new String[0][];
        }
    }

    private static boolean start(Context ctx, String pkg, String cls) {
        try {
            ComponentName cn = new ComponentName(pkg, cls);
            Intent i = new Intent().setComponent(cn);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (ctx.getPackageManager().resolveActivity(i, 0) == null) return false;
            ctx.startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean startAction(Context ctx, Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (ctx.getPackageManager().resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY) == null) {
                return false;
            }
            ctx.startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
