import { runBrowserJob } from './transport.mjs';
import { openDefaultBrowser } from './external-browser.mjs';
import { cookieGuide } from './cookie-guide.mjs';
import { resolveChromium, readWithChromium, clearProfileCredentials } from './chromium.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveBrowser(api, platform = process.platform, existsImpl = existsSync) {
  const executable = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  const candidates = [
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'electron', executable),
    join(api.dir, '.runtime', 'node_modules', 'electron', 'dist', executable),
    join(api.dir, 'node_modules', 'electron', 'dist', executable),
  ];
  const found = candidates.find(existsImpl);
  if (!found) throw new Error('未检测到可用的内置浏览器组件。');
  return found;
}

// 内置组件优先（能弹登录窗口）；没有就退回系统里已有的 Chromium 系浏览器，用 CDP 无头读取。
export function resolveEngine(api, { platform = process.platform, existsImpl = existsSync, env = process.env } = {}) {
  try { return { kind: 'builtin', exe: resolveBrowser(api, platform, existsImpl) }; } catch {}
  const configured = String(api.settings?.().browserPath || '').trim();
  // 填 off / none 表示只认内置组件：桌面用户想保留「打开系统默认浏览器扫码」的旧路径时用。
  if (/^(off|none|builtin)$/i.test(configured)) throw new Error('未检测到可用的内置浏览器组件。');
  const chromium = resolveChromium({ configured, platform, existsImpl, env });
  if (chromium) return { kind: 'chromium', exe: chromium.exe };
  throw new Error('未检测到可用的内置浏览器组件。');
}

export function createBrowserReader(api, getCookie, { spawnImpl = spawn, resolveImpl = resolveEngine, openExternalImpl = openDefaultBrowser, readImpl = readWithChromium, timeoutMs } = {}) {
  let queue = Promise.resolve();
  let disposed = false;
  let pending = 0;
  let loginPending = false;
  let lastLogin = '';
  let loginResult = null;
  let account = { loggedIn: null, message: '尚未检查登录', checkedAt: 0 };
  const active = new Set();
  const engine = () => resolveImpl(api);
  const available = () => { try { return Boolean(engine()); } catch { return false; } };
  const engineName = () => { try { return engine()?.kind === 'chromium' ? 'headless' : engine() ? 'builtin' : 'none'; } catch { return 'none'; } };
  api.onDispose(() => {
    disposed = true;
    for (const cancel of active) cancel();
  });
  function run(url, kind) {
    if (disposed) return Promise.reject(new Error('贴吧模块已停用。'));
    let resolved;
    try { resolved = engine(); } catch (error) { return Promise.reject(error); }
    if (resolved?.kind === 'chromium') {
      // 停用或重载时 abort，避免无头浏览器在后台跑满超时。
      const controller = new AbortController();
      const cancel = () => controller.abort();
      active.add(cancel);
      return readImpl({ exe: resolved.exe, profile: api.dataDir('browser-profile-chromium'), url, kind, cookie: getCookie(),
        signal: controller.signal, timeoutMs: timeoutMs ?? (kind === 'login' ? 600000 : 48000) })
        .finally(() => active.delete(cancel));
    }
    const exe = typeof resolved === 'string' ? resolved : resolved.exe;
    const env = { ...process.env, AURABOT_TIEBA_PROFILE: api.dataDir('browser-profile') };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    return runBrowserJob({ exe, script: join(api.dir, 'lib', 'browser.cjs'), env,
      request: { url, kind, cookie: getCookie() }, timeoutMs: timeoutMs ?? (kind === 'login' ? 600000 : 48000), spawnImpl, active,
      onProgress: event => { if (event === 'login-opened') lastLogin = '登录窗口已打开；确认登录成功后会自动保存并关闭。'; } });
  }
  const reader = (url, kind) => {
    if (disposed) return Promise.reject(new Error('贴吧模块已停用。'));
    if (loginPending && kind !== 'login') return Promise.reject(new Error('登录窗口仍然打开，确认登录后会自动关闭；也可先用右上角 × 手动关闭，再检查登录或读帖。'));
    if (kind === 'logout' && !available()) {
      const profile = api.dataDir('browser-profile');
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, 'logout-requested'), '', { mode: 0o600 });
      // 两个 profile 都要清：只标记 Electron 那份、却报「已清空」，等于对着还留着的 Cookie 说谎。
      const cleared = clearProfileCredentials(api.dataDir('browser-profile-chromium'));
      account = {
        loggedIn: false, checkedAt: Date.now(),
        message: cleared
          ? '已清空手动 Cookie 和扩展浏览器配置目录；系统浏览器账号需要自行退出。'
          : '扩展浏览器目录里的 Cookie 没能删掉，请停用模块后重试；系统浏览器账号需要自行退出。',
      };
      return Promise.resolve(account);
    }
    if (pending >= 8) return Promise.reject(new Error('贴吧读取任务较多，请稍后再试。'));
    pending++;
    const task = queue.then(() => run(url, kind)).then(data => {
      if (kind === 'account' || kind === 'logout') account = { ...data, checkedAt: Date.now() };
      return data;
    }).finally(() => { pending--; });
    queue = task.catch(() => {});
    return task;
  };
  reader.available = available;
  reader.recordAccount = result => { account = { ...result, checkedAt: Date.now() }; };
  reader.status = () => { const internal = available(); return { loginPending, lastLogin, pending, loginResult, account, available: internal, engine: engineName(), cookieGuide: internal ? null : cookieGuide }; };
  reader.openLogin = () => {
    if (disposed) return { ok: false, message: '贴吧模块已停用。' };
    if (loginPending) return { ok: true, message: '登录窗口正在打开或已打开；确认登录成功后会自动保存并关闭。' };
    if (available() && engineName() === 'headless') {
      const message = '当前用无头浏览器读取，没有可扫码的窗口。请在电脑浏览器登录贴吧，按面板提示把 Cookie 填进「手动 Cookie」并保存，再点检查登录。';
      lastLogin = message;
      account = { loggedIn: null, checkedAt: 0, message };
      return { ok: false, mode: 'external', loggedIn: null, message, cookieGuide };
    }
    if (!available()) {
      return Promise.resolve().then(() => openExternalImpl('https://tieba.baidu.com/')).then(() => {
        lastLogin = '已打开默认浏览器，请按面板中的 F12 指引复制 Cookie，填入后保存设置，再检查登录。扩展不会自动同步浏览器登录。';
        account = { loggedIn: null, checkedAt: 0, message: lastLogin };
        return { ok: true, mode: 'external', loggedIn: null, message: lastLogin, cookieGuide };
      });
    }
    loginPending = true;
    loginResult = null;
    lastLogin = '登录窗口准备中';
    reader('https://tieba.baidu.com/', 'login').then(result => {
      loginResult = result;
      account = { ...result, checkedAt: Date.now() };
      lastLogin = result?.loggedIn === true ? `已登录：${result.name}；窗口${result.autoClosed ? '已自动' : '已'}关闭，会话已保存。` : result?.message || '窗口已关闭，尚未确认登录。';
    }, error => { lastLogin = error.message; account = { loggedIn: null, message: error.message, checkedAt: Date.now() }; })
      .finally(() => { loginPending = false; });
    return { ok: true, message: '正在打开扩展专用浏览器；确认登录成功后会自动保存会话并关闭窗口。' };
  };
  return reader;
}
