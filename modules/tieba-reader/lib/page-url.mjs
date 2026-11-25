// 页面范围与 Cookie 白名单：无头浏览器后端单独实现时也复用同一份，避免规则漂移。
export const cookieNames = new Set(['BDUSS', 'BDUSS_BFESS', 'STOKEN', 'BAIDUID', 'BAIDUID_BFESS', 'TIEBAUID', 'USER_JUMP', 'PSTM']);

export function validUrl(raw, kind) {
  const u = new URL(raw);
  if (u.origin !== 'https://tieba.baidu.com' || u.username || u.password) throw new Error('只允许读取百度贴吧。');
  if (!(/^\/p\/\d+$/.test(u.pathname) || ['/f', '/', '/f/search/res'].includes(u.pathname))) throw new Error('不支持这个贴吧页面。');
  if (kind === 'login' && u.pathname !== '/') throw new Error('登录入口无效。');
  return u.href;
}

export function allowNavigation(raw, kind) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (u.hostname === 'tieba.baidu.com' || kind === 'login' && ['passport.baidu.com', 'wappass.baidu.com'].includes(u.hostname));
  } catch { return false; }
}

// RFC 6265 cookie-octet：可见 ASCII，不含空格、引号、逗号、分号、反斜杠。
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const COOKIE_NAME = /^[A-Za-z0-9_-]+$/;

// 只保留白名单项；换行或非法字符视为无效，绝不把整串 Cookie 交给子进程或日志。
export function cookiePairs(raw) {
  if (/[\r\n]/.test(String(raw || ''))) throw new Error('Cookie 不能含换行。');
  const pairs = [];
  for (const part of String(raw || '').split(';')) {
    const item = part.trim();
    if (!item) continue;
    const i = item.indexOf('=');
    if (i <= 0) continue;
    const name = item.slice(0, i).trim();
    const value = item.slice(i + 1).trim();
    if (!cookieNames.has(name)) continue;
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) throw new Error('Cookie 含非法字符，请重新复制完整 Cookie。');
    pairs.push({ name, value });
  }
  return pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
