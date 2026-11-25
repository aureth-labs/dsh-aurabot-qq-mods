// 无头 Chromium 后端：用系统已有的 Chrome / Chromium / chrome-headless-shell 通过 CDP 读取贴吧。
// 只读页面，不开窗口，不需要 Xvfb；登录仍走"系统浏览器 + 手动 Cookie"。
import { spawn as spawnChild } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cookiePairs, validUrl } from './page-url.mjs';

export const CHROMIUM_ENV = 'AURABOT_TIEBA_BROWSER';

// 用户配置 > 环境变量 > 各平台常见安装位置。刻意不写死自用机器路径。
export function chromiumCandidates(platform = process.platform, env = process.env) {
  const list = [];
  const configured = String(env[CHROMIUM_ENV] || '').trim();
  if (configured) list.push(configured);
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome-headless-shell', 'microsoft-edge', 'chrome'];
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean);
    for (const root of roots) for (const rel of ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']) list.push(join(root, rel));
  } else if (platform === 'darwin') {
    for (const rel of ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) list.push(join('/Applications', rel));
  } else {
    for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome']) for (const name of names) list.push(join(dir, name));
  }
  return list;
}

export function isHeadlessShell(exe) {
  return /headless/i.test(basename(String(exe || '')));
}

// 返回 {exe, headless} 或 null；headless 表示需要显式传 --headless（chrome-headless-shell 自带）。
export function resolveChromium({ configured = '', platform = process.platform, existsImpl = existsSync, env = process.env } = {}) {
  const tried = [];
  const explicit = String(configured || '').trim() || String(env[CHROMIUM_ENV] || '').trim();
  if (explicit) {
    if (!existsImpl(explicit)) throw new Error('浏览器组件未找到：配置的程序路径不存在。');
    return { exe: explicit, headless: !isHeadlessShell(explicit) };
  }
  for (const candidate of chromiumCandidates(platform, env)) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (existsImpl(candidate)) return { exe: candidate, headless: !isHeadlessShell(candidate) };
  }
  return null;
}

export function browserArgs({ exe, profile, headless = !isHeadlessShell(exe), root = typeof process.getuid === 'function' && process.getuid() === 0 } = {}) {
  const args = [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--hide-scrollbars',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  if (root) args.push('--no-sandbox');
  return args;
}

export function parseDevToolsPort(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0].trim();
  if (!/^\d{2,5}$/.test(first)) return 0;
  const port = Number(first);
  return port > 0 && port < 65536 ? port : 0;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const READY_SELECTOR = {
  read: '.pb-content-wrap,.d_post_content,.pb-content-item',
  search: '.s_post',
  home: 'a[href*="/p/"]',
  browse: '.thread-card,.j_thread_list,.threadlist_li',
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (typeof message.id !== 'number') return;
      const slot = this.pending.get(message.id);
      if (!slot) return;
      this.pending.delete(message.id);
      if (message.error) slot.reject(new Error(message.error.message || '浏览器命令失败。'));
      else slot.resolve(message.result || {});
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const slot of this.pending.values()) slot.reject(new Error('浏览器通信中断。'));
      this.pending.clear();
    });
    ws.addEventListener('error', () => {});
  }
  static async open(url, Impl, timeoutMs = 10000) {
    const ws = new Impl(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('浏览器调试通道连接超时。')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('浏览器调试通道连接失败。')); }, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error('浏览器通信中断。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器命令超时。')); }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('浏览器通信中断。')); }
    });
  }
  async evaluate(expression, timeoutMs = 15000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error('读取贴吧页面失败：' + String(result.exceptionDetails.text || result.exceptionDetails.exception?.description || '').slice(0, 200));
    return result.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// 复用同一个 profile 时清掉上次残留的锁与调试端口文件，否则会连到已经退出的旧实例。
// 权限收紧到 0700：profile 里有 Cookie 数据库，同机其他用户不该读得到。
function clearProfileLocks(profile) {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  try { chmodSync(profile, 0o700); } catch {}
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    try { rmSync(join(profile, name), { force: true }); } catch {}
  }
}

// 「退出登录」要真的把落盘的 Cookie 删掉，不能只改面板文案。
// 返回是否删干净：删不掉要如实报错，别让面板显示「已清除」。
export function clearProfileCredentials(profile) {
  for (const name of ['Default', 'Cookies', 'Cookies-journal', 'Network']) {
    try { rmSync(join(profile, name), { recursive: true, force: true }); } catch {}
  }
  return !['Default', 'Cookies'].some(name => existsSync(join(profile, name)));
}

// 子进程只继承跑浏览器必需的环境变量，别把宿主的密钥一起带进去。
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR',
  'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
export function childEnv(source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) { const value = source[key]; if (value) env[key] = value; }
  return env;
}

async function waitForDevToolsPort(profile, deadline, hasExited) {
  const file = join(profile, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    if (hasExited()) return 0;
    try {
      const port = parseDevToolsPort(readFileSync(file, 'utf8'));
      if (port) return port;
    } catch {}
    await delay(120);
  }
  return 0;
}

const ACCOUNT_SCRIPT = `(async () => {
  try {
    const response = await fetch('/f/user/json_userinfo', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { ok: false, loggedIn: null, message: '登录检查被拦截，请重新导入 Cookie 后再试。' };
    const j = await response.json();
    const user = j?.data?.user || j?.data || j?.user || j;
    const name = user?.user_name || user?.name_show || user?.user_name_show;
    return name ? { ok: true, loggedIn: true, name: String(name).slice(0, 100), message: '已登录：' + String(name).slice(0, 100) }
      : { ok: true, loggedIn: false, message: '未确认登录，请在面板填入 Cookie 后重试。' };
  } catch { return { ok: false, loggedIn: null, message: '未能检查登录，请检查网络或 Cookie 后重试。' }; }
})()`;

// 读取一页：read/browse/home/search 返回 {html,url}；account 返回登录状态；logout 只清本地会话。
export async function readWithChromium({ exe, profile, url, kind, cookie = '', signal, timeoutMs = 48000,
  startupTimeoutMs = 15000, spawnImpl = spawnChild, fetchImpl = (...args) => fetch(...args), WebSocketImpl } = {}) {
  const Impl = WebSocketImpl || globalThis.WebSocket;
  if (typeof Impl !== 'function') throw new Error('浏览器组件不可用：运行环境不支持 WebSocket。');
  if (kind === 'login') throw new Error('无头浏览器不能打开登录窗口，请用系统浏览器登录后把 Cookie 填进面板。');
  const target = validUrl(url, kind === 'logout' ? 'account' : kind);
  if (kind === 'logout') {
    clearProfileLocks(profile);
    if (!clearProfileCredentials(profile)) throw new Error('扩展浏览器目录里的 Cookie 没能删掉，请停用模块后重试。');
    return { loggedIn: false, message: '已删除扩展浏览器落盘的 Cookie 数据库；系统浏览器账号需要自行退出。' };
  }
  // 整个读取共享一份超时预算：启动、连接、轮询都从这份预算里扣，不会被各段超时叠成几分钟。
  const startedAt = Date.now();
  const budget = Math.max(15000, Number(timeoutMs) || 48000);
  const deadline = startedAt + budget;
  const remain = () => Math.max(1000, deadline - Date.now());
  clearProfileLocks(profile);
  let child;
  let cdp;
  let stderr = '';
  let exited = false;
  let spawnError = null;
  let exitPromise = Promise.resolve();
  // 浏览器会 fork 出渲染/网络等子进程，只杀主进程会留孤儿；非 Windows 起独立进程组后整组杀。
  const killTree = sig => {
    if (!child) return;
    if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, sig); } catch {} }
    try { child.kill(sig); } catch {}
  };
  let forceKill = null;
  const cleanup = () => {
    try { cdp?.close(); } catch {}
    killTree('SIGTERM');
    // 进程已经退出的情况下不要再补 SIGKILL，避免误杀刚被系统复用的 pid。
    if (child && !forceKill) forceKill = setTimeout(() => { killTree('SIGKILL'); forceKill = null; }, 1500);
  };
  const onAbort = () => { cleanup(); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    child = spawnImpl(exe, browserArgs({ exe, profile }), {
      stdio: ['ignore', 'ignore', 'pipe'], env: childEnv(), windowsHide: true, detached: process.platform !== 'win32',
    });
    exitPromise = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
    child.once('error', error => { spawnError = error; exited = true; });
    if (child.stderr?.setEncoding) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    }
    const port = await waitForDevToolsPort(profile, Math.min(deadline, startedAt + startupTimeoutMs), () => exited);
    if (spawnError) throw new Error('浏览器组件启动失败，请检查配置的程序路径和运行权限。');
    if (!port) throw new Error('浏览器组件未就绪，请检查程序路径或运行权限。' + (stderr ? '（' + stderr.trim().split(/\r?\n/).at(-1).slice(0, 160) + '）' : ''));
    // PUT 也可能被卡住（浏览器假死），同样从总预算里扣，别让这条请求把 48 秒预算绕过去。
    const response = await fetchImpl('http://127.0.0.1:' + port + '/json/new?about:blank',
      { method: 'PUT', signal: AbortSignal.timeout(Math.min(10000, remain())) });
    if (!response.ok) throw new Error('浏览器组件拒绝创建页面。');
    const created = await response.json();
    if (!created?.webSocketDebuggerUrl) throw new Error('浏览器组件未返回调试通道。');
    cdp = await Cdp.open(created.webSocketDebuggerUrl, Impl, Math.min(10000, remain()));
    await cdp.send('Network.enable', {}, remain());
    const cookies = cookiePairs(cookie).map(({ name, value }) => ({ name, value, url: 'https://tieba.baidu.com/' }));
    if (cookies.length) await cdp.send('Network.setCookies', { cookies }, remain());
    await cdp.send('Page.enable', {}, remain());
    await cdp.send('Page.navigate', { url: target }, Math.min(20000, remain()));
    if (kind === 'account') {
      const result = await cdp.evaluate(ACCOUNT_SCRIPT, Math.min(20000, remain()));
      return result || { ok: false, loggedIn: null, message: '未能检查登录，请重试。' };
    }
    const selector = READY_SELECTOR[kind] || READY_SELECTOR.browse;
    let page = null;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('贴吧模块已停用，任务已取消。');
      if (exited) throw new Error('浏览器进程提前退出。');
      page = await cdp.evaluate(`(() => ({
        title: document.title,
        href: location.href,
        blocked: /安全验证|访问验证|验证码/.test(document.title) || /(^|\\.)wappass\\.baidu\\.com$/.test(location.hostname) || Boolean(document.querySelector('#captcha,#vcode,#wappassverify')),
        ready: Boolean(document.querySelector(${JSON.stringify(selector)})),
      }))()`, Math.min(15000, remain()));
      if (page?.blocked) throw new Error('贴吧要求安全验证，请重新导入登录 Cookie 后再试。');
      if (page?.ready) break;
      await delay(500);
    }
    if (!page?.ready) throw new Error('浏览器读取超时，请检查网络或登录验证。');
    // 先量长度再取整页：超大页面不该先回传 2.5MB 再判断。
    const size = Number(await cdp.evaluate('document.documentElement.outerHTML.length', Math.min(15000, remain())));
    if (size > 2500000) throw new Error('贴吧页面过大，已停止读取。');
    const data = await cdp.evaluate('({html: document.documentElement.outerHTML, url: location.href})', Math.min(20000, remain()));
    if (!data?.html) throw new Error('浏览器没有返回页面内容。');
    if (Buffer.byteLength(data.html, 'utf8') > 2500000) throw new Error('贴吧页面过大，已停止读取。');
    return data;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    cleanup();
    // 等浏览器真的退出再返回：否则紧随其后的凭据清理会被还没死透的进程回写。
    await Promise.race([exitPromise, delay(2000)]);
    if (forceKill) { clearTimeout(forceKill); forceKill = null; }
  }
}
