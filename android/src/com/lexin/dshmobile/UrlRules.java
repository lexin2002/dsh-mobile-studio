package com.lexin.dshmobile;

/**
 * 地址规则：把用户输入/扫码结果整理成能用的工作台地址。
 *
 * 单独一个类、**不依赖任何 Android API**，是为了能在电脑上用 JDK 直接跑单测
 * （tools/test-url-rules.mjs）。网址拼接是最容易"好心办坏事"的地方：
 * 补错端口、吞掉扫码票据的 query、把 IPv6 拼坏，都会让人连到莫名其妙的地方。
 *
 * 规则（与测试一一对应）：
 *   - 只接受 http/https；其它 scheme、带 userinfo、带空白/控制字符一律拒绝；
 *   - 端口缺省：http→3081，https→443；端口必须 1..65535；
 *   - 路径空或 "/" → "/m"；**只有 /__ms/qr、/__ms/login 保留原路径**，
 *     其它一切路径（/m/、/m/m、/m/foo、/admin…）统一归一到 "/m"——
 *     插件隔离只认精确的 /m，多一层或少一层都会绕过移动端过滤；
 *   - **保留 query（扫码票据）、丢弃 fragment**；其它路径的 query 一并丢弃；
 *   - IPv6 输出必须带方括号。
 */
final class UrlRules {

    private static final int DEFAULT_PORT = 3081;
    private static final int HTTPS_PORT = 443;
    private static final int MAX_LEN = 2048;

    private UrlRules() {
    }

    /** 整理失败返回 null（调用方统一按"地址无效"处理，不发请求）。 */
    static String normalize(String raw) {
        Parsed p = parse(raw);
        return p == null ? null : canonical(p).toString();
    }

    /**
     * 把地址收口成"唯一一个 /m"。
     * 唯一例外是扫码换票/登录端点：它们只用于一次导航，导航后仍会被网关 302 到 /m。
     */
    private static Parsed canonical(Parsed p) {
        if ("/__ms/qr".equals(p.path) || "/__ms/login".equals(p.path)) return p;
        p.path = "/m";
        p.query = null;
        return p;
    }

    /**
     * 「能存/能喂给推送」的工作台地址：
     * 扫码登录地址（/__ms/qr、/__ms/login）只用于一次导航，存下来必须是干净 /m。
     */
    static String workbenchUrlFor(String normalized) {
        Parsed p = parse(normalized);
        if (p == null) return null;
        if (p.path.startsWith("/__ms/")) {
            p.path = "/m";
            p.query = null;
            return p.toString();
        }
        return canonical(p).toString();
    }

    static boolean isLoginPage(String url) {
        Parsed p = parse(url);
        return p != null && "/__ms/login".equals(p.path);
    }

    static boolean isHttpUrl(String text) {
        return parse(text) != null;
    }

    // ------------------------------------------------------------------ 解析

    private static final class Parsed {
        String scheme = "http";
        String host = "";
        int port = DEFAULT_PORT;
        String path = "/m";
        String query = null;

        @Override
        public String toString() {
            StringBuilder b = new StringBuilder(64);
            b.append(scheme).append("://");
            // IPv6 字面量必须带方括号，否则冒号会被当成端口分隔符
            if (host.indexOf(':') >= 0) b.append('[').append(host).append(']');
            else b.append(host);
            b.append(':').append(port).append(path);
            if (query != null && !query.isEmpty()) b.append('?').append(query);
            return b.toString();
        }
    }

    private static Parsed parse(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || s.length() > MAX_LEN) return null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c) || Character.isISOControl(c)) return null;
        }

        Parsed p = new Parsed();

        // scheme：有 "://" 才按显式 scheme 处理；否则按"主机[:端口][/路径]"看待。
        int schemeEnd = s.indexOf("://");
        String rest;
        if (schemeEnd >= 0) {
            String scheme = s.substring(0, schemeEnd).toLowerCase(java.util.Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            if (scheme.indexOf('/') >= 0) return null;
            p.scheme = scheme;
            rest = s.substring(schemeEnd + 3);
        } else {
            // 形如 javascript:alert(1) / intent:xxx 的裸 scheme：明确拒绝，
            // 但 "localhost:3081" 这种"主机:端口"要放行（端口是纯数字）。
            if (looksLikeOpaqueScheme(s)) return null;
            rest = s;
        }

        // fragment 丢弃；query 保留（扫码票据就在 query 里）
        int hash = rest.indexOf('#');
        if (hash >= 0) rest = rest.substring(0, hash);
        int q = rest.indexOf('?');
        if (q >= 0) {
            p.query = rest.substring(q + 1);
            rest = rest.substring(0, q);
        }

        // authority / path
        int slash = rest.indexOf('/');
        String authority = slash >= 0 ? rest.substring(0, slash) : rest;
        String path = slash >= 0 ? rest.substring(slash) : "";
        if (authority.isEmpty()) return null;
        if (authority.indexOf('@') >= 0) return null; // 拒绝 user:pass@host

        // host / port（IPv6 必须带方括号）
        String hostPart;
        String portPart = "";
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            if (close < 0) return null;
            hostPart = authority.substring(1, close);
            String tail = authority.substring(close + 1);
            if (!tail.isEmpty()) {
                if (tail.charAt(0) != ':') return null;
                portPart = tail.substring(1);
            }
            if (hostPart.indexOf(':') < 0) return null;
            if (!hostPart.matches("[0-9a-fA-F:.]+")) return null;
        } else {
            if (authority.indexOf(':') >= 0) {
                if (authority.indexOf(':') != authority.lastIndexOf(':')) {
                    // 未加方括号的裸 IPv6：无法判断端口，直接拒绝
                    return null;
                }
                hostPart = authority.substring(0, authority.indexOf(':'));
                portPart = authority.substring(authority.indexOf(':') + 1);
            } else {
                hostPart = authority;
            }
            if (!isValidHost(hostPart)) return null;
        }
        if (hostPart.isEmpty()) return null;
        p.host = hostPart.toLowerCase(java.util.Locale.ROOT);
        // 域名结尾的点是合法写法，但会让人误判"不同主机"
        if (p.host.endsWith(".") && !p.host.contains(":")) {
            p.host = p.host.substring(0, p.host.length() - 1);
        }
        if (p.host.isEmpty()) return null;

        if (!portPart.isEmpty()) {
            if (!portPart.matches("\\d{1,5}")) return null;
            int port;
            try {
                port = Integer.parseInt(portPart);
            } catch (NumberFormatException e) {
                return null;
            }
            if (port < 1 || port > 65535) return null;
            p.port = port;
        } else {
            p.port = "https".equals(p.scheme) ? HTTPS_PORT : DEFAULT_PORT;
        }

        // path
        if (path.isEmpty() || "/".equals(path)) {
            p.path = "/m";
        } else if ("/m/".equals(path)) {
            p.path = "/m";
        } else {
            if (path.charAt(0) != '/') return null;
            p.path = path;
        }
        return p;
    }

    /** 裸 scheme（没有 ://）且冒号后不是纯数字端口 → 视为不可接受协议。 */
    private static boolean looksLikeOpaqueScheme(String s) {
        int colon = s.indexOf(':');
        if (colon <= 0) return false;
        // 主机:端口 形式放行
        String after = s.substring(colon + 1);
        int slash = after.indexOf('/');
        String portCandidate = slash >= 0 ? after.substring(0, slash) : after;
        if (portCandidate.length() > 0 && portCandidate.matches("\\d{1,5}")) return false;
        // 形如 scheme:... 的其它情况：开头必须是字母才像 scheme
        char c0 = s.charAt(0);
        if (!(Character.isLetter(c0))) return false;
        for (int i = 1; i < colon; i++) {
            char c = s.charAt(i);
            if (!(Character.isLetterOrDigit(c) || c == '+' || c == '-' || c == '.')) return false;
        }
        return portCandidate.isEmpty() || !portCandidate.matches("\\d{1,5}");
    }

    private static boolean isValidHost(String host) {
        return host != null
                && host.matches("[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\\.?");
    }
}
