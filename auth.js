/**
 * 手机端网关的密码门禁（纯 Node，无宿主依赖）。
 *
 * 存储：~/.dsh/mobile-studio/config.json 的 auth 字段
 *   { enabled, salt, hash, secret, updatedAt }
 *
 * - 密码用 scrypt(salt) 存哈希，不存明文。
 * - 登录态是一个 HMAC 签名的 cookie：ms_auth=v1.<hmac>，改密码时
 *   secret 轮换，旧 cookie 自动失效。
 * - 未设置密码时 enabled=false，网关保持原来的「扫码即开」行为。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const COOKIE = 'ms_auth';
const SESSION_LABEL = 'mobile-studio-session-v1';
const QR_LOGIN_LABEL = 'mobile-studio-qr-login-v1';
const SCRYPT_N = 16384;

/** 配置目录：~/.dsh/mobile-studio */
export function configDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'mobile-studio');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

const emptyAuth = () => ({ enabled: false, salt: '', hash: '', secret: '', updatedAt: 0 });

/** 读整份配置；坏文件按空配置处理，绝不抛给宿主。 */
export function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const data = JSON.parse(raw);
    const auth = data && typeof data.auth === 'object' && data.auth ? data.auth : {};
    return {
      filter: data && data.filter ? data.filter : null,
      auth: {
        ...emptyAuth(),
        ...auth,
        enabled: auth.enabled === true && typeof auth.hash === 'string' && auth.hash !== '',
      },
    };
  } catch {
    return { filter: null, auth: emptyAuth() };
  }
}

/** 写整份配置；先写临时文件再改名，避免写一半留下坏文件。 */
export function saveConfig(next) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** 只更新 filter 段，保留 auth。 */
export function saveFilter(filter) {
  const cur = loadConfig();
  return saveConfig({ filter, auth: cur.auth });
}

function hash(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32, { N: SCRYPT_N, r: 8, p: 1 }).toString('hex');
}

/**
 * 设置/修改密码。空字符串 = 关闭密码，恢复扫码即开。
 * @returns 新的 auth 段（不含明文）
 */
export function setPassword(pw) {
  const cur = loadConfig();
  const text = typeof pw === 'string' ? pw : '';
  if (text === '') {
    const next = { ...emptyAuth(), updatedAt: Date.now() };
    saveConfig({ filter: cur.filter, auth: next });
    return next;
  }
  if (text.length < 6) throw new Error('密码至少 6 位');
  if (text.length > 200) throw new Error('密码太长');
  const salt = crypto.randomBytes(16).toString('hex');
  const next = {
    enabled: true,
    salt,
    hash: hash(text, salt),
    secret: crypto.randomBytes(32).toString('hex'),
    updatedAt: Date.now(),
  };
  saveConfig({ filter: cur.filter, auth: next });
  return next;
}

/** 校验明文密码。未启用时永远 false（不走这条路径）。 */
export function verifyPassword(auth, pw) {
  if (!auth || !auth.enabled || typeof auth.hash !== 'string' || auth.hash === '') return false;
  if (typeof pw !== 'string' || pw === '') return false;
  try {
    const got = Buffer.from(hash(pw, auth.salt), 'hex');
    const want = Buffer.from(auth.hash, 'hex');
    if (got.length !== want.length) return false;
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** 为当前 secret 生成登录 cookie 值。 */
export function sessionValue(auth) {
  if (!auth || !auth.secret) return '';
  const mac = crypto.createHmac('sha256', auth.secret).update(SESSION_LABEL).digest('hex');
  return 'v1.' + mac.slice(0, 32);
}

/** 从 Cookie 头里取 ms_auth 并校验签名。 */
export function isValidSession(auth, cookieHeader) {
  if (!auth || !auth.enabled) return true;
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return false;
  const want = sessionValue(auth);
  if (!want) return false;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    const got = part.slice(eq + 1).trim();
    if (got.length !== want.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    } catch {
      return false;
    }
  }
  return false;
}

/** Set-Cookie 值。 */
export function sessionCookie(auth, maxAgeSec = 30 * 86400) {
  return `${COOKIE}=${sessionValue(auth)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/**
 * 二维码里带的登录票据。
 *
 * 为什么不是明文密码：二维码会出现在屏幕上、会被截图转发，密码一旦进了 URL，
 * 等于把密码本身送出去（还会进浏览器历史/日志）。票据是 secret 的 HMAC，
 * 只能换手机端登录态，反推不出密码；改密码时 secret 轮换，旧码立即作废。
 * DSH 重启 secret 不变，所以码仍然长期有效（沿用原来的承诺）。
 */
export function qrLoginToken(auth) {
  if (!auth || !auth.enabled || !auth.secret) return '';
  return crypto.createHmac('sha256', auth.secret).update(QR_LOGIN_LABEL).digest('hex').slice(0, 32);
}

/** 校验票据（恒定时间比较；未启用密码一律不认票据）。 */
export function isValidQrToken(auth, token) {
  const want = qrLoginToken(auth);
  if (!want || typeof token !== 'string' || token.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(want));
  } catch {
    return false;
  }
}
