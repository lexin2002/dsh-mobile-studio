package com.lexin.dshmobile;

/**
 * UrlRules 的电脑端单测探针（不依赖 Android，JDK 直接跑）。
 * 由 tools/test-url-rules.mjs 编译执行；任何一个 FAIL 都以非 0 退出。
 *
 * 为什么值得单列：网址补全是"好心办坏事"的重灾区——端口补错、扫码票据被吞、
 * IPv6 拼坏、带 userinfo 的地址被当成正常主机，这些都不该靠真机肉眼发现。
 */
public class UrlRulesProbe {

    private static int fail = 0;

    public static void main(String[] args) {
        // ---------------- normalize ----------------
        eq("bare ipv4", "192.168.1.10", "http://192.168.1.10:3081/m");
        eq("ipv4:port", "192.168.1.10:3081", "http://192.168.1.10:3081/m");
        eq("ipv4 trailing slash", "192.168.1.10/", "http://192.168.1.10:3081/m");
        eq("http slash", "http://192.168.1.10:3081/", "http://192.168.1.10:3081/m");
        eq("already /m", "http://192.168.1.10:3081/m", "http://192.168.1.10:3081/m");
        eq("uppercase scheme+host", "HTTP://Example.LOCAL:3081/m", "http://example.local:3081/m");
        eq("/m/", "http://x:3081/m/", "http://x:3081/m");
        eq("https default port", "https://host", "https://host:443/m");
        eq("https custom port/path", "https://host:8443/foo", "https://host:8443/m");
        eq("keep __ms query", "http://x:3081/__ms/qr?t=abc", "http://x:3081/__ms/qr?t=abc");
        eq("keep login path", "http://x:3081/__ms/login?next=%2Fm", "http://x:3081/__ms/login?next=%2Fm");
        eq("drop fragment", "http://x:3081/m#frag", "http://x:3081/m");
        eq("ipv6 bracketed", "http://[::1]:3081/m", "http://[::1]:3081/m");
        eq("ipv6 bare with port", "[::1]:3081", "http://[::1]:3081/m");
        eq("trim spaces", "  http://x:3081/m  ", "http://x:3081/m");
        eq("host only http", "http://x:3081", "http://x:3081/m");
        eq("localhost:port", "localhost:3081", "http://localhost:3081/m");
        eq("trailing dot host", "x.com.", "http://x.com:3081/m");
        eq("arbitrary path -> /m", "http://x:3081/admin?q=1", "http://x:3081/m");
        eq("empty query dropped", "http://x:3081/m?", "http://x:3081/m");
        // ---- 唯一一个 /m：重复/变体路径全部收口（插件隔离只认精确 /m） ----
        eq("double /m", "http://x:3081/m/m", "http://x:3081/m");
        eq("/m/index.html", "http://x:3081/m/index.html", "http://x:3081/m");
        eq("/m/child", "http://x:3081/m/child", "http://x:3081/m");
        eq("/m//", "http://x:3081/m//", "http://x:3081/m");
        eq("bare /foo", "http://x:3081/foo", "http://x:3081/m");
        eq("/m with query", "http://x:3081/m?t=abc", "http://x:3081/m");

        // ---------------- normalize 拒绝 ----------------
        reject("empty", "");
        reject("blank", "   ");
        reject("javascript", "javascript:alert(1)");
        reject("intent", "intent://scan/#Intent;end");
        reject("no host", "http://");
        reject("port 0", "http://x:0/m");
        reject("port too big", "http://x:70000/m");
        reject("userinfo", "http://user:pass@x/m");
        reject("space in path", "http://x/a b");
        reject("newline inside", "http://x/m\nq");
        reject("too long", "http://x/" + repeat("a", 2100));
        reject("broken ipv6", "http://[::1/m");
        reject("bare ipv6 no bracket", "http://::1:3081/m");
        reject("scheme only", "ftp://x/m");

        // ---------------- workbenchUrlFor ----------------
        eqW("qr -> clean /m", "http://x:3081/__ms/qr?t=abc", "http://x:3081/m");
        eqW("login -> clean /m", "http://x:3081/__ms/login?next=%2Fm", "http://x:3081/m");
        eqW("normal kept", "http://x:3081/m?t=1", "http://x:3081/m");
        eqW("messy path canonical", "http://x:3081/m/m", "http://x:3081/m");
        eqW("https qr", "https://x:443/__ms/qr?t=abc", "https://x:443/m");

        // ---------------- 页面判定 ----------------
        yes("login page true", UrlRules.isLoginPage("http://x:3081/__ms/login?next=%2Fm"));
        no("login page false for /m", UrlRules.isLoginPage("http://x:3081/m"));
        // 0.9.6：isQrLoginTarget 没有任何调用方，已从 UrlRules 删除（连带删掉这两条断言）。
        yes("isHttpUrl yes", UrlRules.isHttpUrl("http://x/m"));
        no("isHttpUrl no", UrlRules.isHttpUrl("这不是地址"));

        System.out.println(fail == 0 ? "\nALL PASS" : "\n" + fail + " FAILED");
        if (fail != 0) System.exit(1);
    }

    private static void eq(String name, String in, String want) {
        String got = UrlRules.normalize(in);
        check(name, want.equals(got), "want=" + want + " got=" + got);
    }

    private static void eqW(String name, String in, String want) {
        String got = UrlRules.workbenchUrlFor(in);
        check(name, want.equals(got), "want=" + want + " got=" + got);
    }

    private static void reject(String name, String in) {
        check(name, UrlRules.normalize(in) == null, "got=" + UrlRules.normalize(in));
    }

    private static void yes(String name, boolean v) {
        check(name, v, "expected true");
    }

    private static void no(String name, boolean v) {
        check(name, !v, "expected false");
    }

    private static void check(String name, boolean ok, String extra) {
        if (ok) {
            System.out.println("ok   " + name);
        } else {
            fail += 1;
            System.out.println("FAIL " + name + "  " + extra);
        }
    }

    private static String repeat(String s, int n) {
        StringBuilder b = new StringBuilder(s.length() * n);
        for (int i = 0; i < n; i++) b.append(s);
        return b.toString();
    }
}
