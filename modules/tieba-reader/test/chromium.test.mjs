import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { browserArgs, childEnv, chromiumCandidates, isHeadlessShell, parseDevToolsPort, readWithChromium, resolveChromium } from '../lib/chromium.mjs';
import { allowNavigation, cookiePairs, validUrl } from '../lib/page-url.mjs';

const require = createRequire(import.meta.url);
const legacy = require('../lib/session.cjs');

class FakeSocket {
  constructor(url) {
    this.url = url; this.sent = []; this.listeners = {}; FakeSocket.sockets.push(this);
    setTimeout(() => this.emit('open', {}), 0);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    const result = FakeSocket.reply?.(message);
    if (result === undefined) return;
    setTimeout(() => this.emit('message', { data: JSON.stringify({ id: message.id, result }) }), 0);
  }
  close() { this.emit('close', {}); }
}
FakeSocket.sockets = [];
FakeSocket.reply = null;

function workspace() {
  FakeSocket.sockets = [];
  const profile = mkdtempSync(join(tmpdir(), 'tieba-cdp-'));
  writeFileSync(join(profile, 'DevToolsActivePort'), '1\n/devtools/browser/stale\n');
  writeFileSync(join(profile, 'SingletonLock'), '');
  const child = { spawned: [], killed: 0 };
  const spawnImpl = (exe, args) => {
    child.spawned.push({ exe, args });
    const proc = new EventEmitter();
    proc.stderr = new PassThrough();
    proc.kill = () => { child.killed++; return true; };
    const dir = args.find(arg => String(arg).startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    assert.equal(existsSync(join(dir, 'DevToolsActivePort')), false, 'a stale DevToolsActivePort must be removed before launch');
    writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/fake\n');
    return proc;
  };
  const fetchImpl = async url => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1' }) });
  return { profile, child, spawnImpl, fetchImpl, cleanup: () => rmSync(profile, { recursive: true, force: true }) };
}

test('system chromium is discovered from config, env, then per-platform defaults', () => {
  const exists = path => path === '/usr/bin/chromium' || path === '/opt/chrome/chrome';
  assert.deepEqual(resolveChromium({ configured: '/opt/chrome/chrome', platform: 'linux', existsImpl: exists }), { exe: '/opt/chrome/chrome', headless: true });
  assert.deepEqual(resolveChromium({ platform: 'linux', existsImpl: exists, env: {} }), { exe: '/usr/bin/chromium', headless: true });
  assert.equal(resolveChromium({ platform: 'linux', existsImpl: () => false, env: {} }), null);
  assert.throws(() => resolveChromium({ configured: '/nope/chrome', platform: 'linux', existsImpl: () => false }), /程序路径不存在/);
  const list = chromiumCandidates('linux', { AURABOT_TIEBA_BROWSER: '/opt/chrome/chrome' });
  assert.equal(list[0], '/opt/chrome/chrome');
  assert.ok(list.some(item => item.endsWith('/google-chrome')));
  assert.ok(chromiumCandidates('win32', { PROGRAMFILES: 'C:/Program Files' }).some(item => /chrome\.exe$/.test(item)));
});

test('headless shell is not asked for --headless and root adds --no-sandbox', () => {
  assert.equal(isHeadlessShell('/opt/chrome-linux64/chrome-headless-shell'), true);
  assert.equal(isHeadlessShell('/usr/bin/google-chrome'), false);
  const shell = browserArgs({ exe: '/opt/chrome-linux64/chrome-headless-shell', profile: '/tmp/p', root: true });
  assert.equal(shell.some(arg => arg === '--headless=new'), false);
  assert.ok(shell.includes('--no-sandbox'));
  assert.ok(shell.includes('--user-data-dir=/tmp/p'));
  assert.ok(shell.includes('--remote-debugging-port=0'));
  assert.ok(shell.includes('about:blank'));
  const chrome = browserArgs({ exe: '/usr/bin/google-chrome', profile: '/tmp/p', root: false });
  assert.equal(chrome[0], '--headless=new');
  assert.equal(chrome.includes('--no-sandbox'), false);
  assert.equal(parseDevToolsPort('9222\n/devtools/browser/x'), 9222);
  assert.equal(parseDevToolsPort(''), 0);
  assert.equal(parseDevToolsPort('0'), 0);
  assert.equal(parseDevToolsPort('nope'), 0);
});

test('page rules stay identical to the electron session module and filter cookies', () => {
  for (const raw of ['https://tieba.baidu.com/p/123456', 'https://tieba.baidu.com/f?kw=x', 'https://tieba.baidu.com/']) {
    assert.equal(validUrl(raw, 'read'), legacy.validUrl(raw, 'read'));
  }
  for (const raw of ['https://evil.example/p/1', 'http://tieba.baidu.com/p/1', 'https://tieba.baidu.com/p/abc']) {
    assert.throws(() => validUrl(raw, 'read'), /只允许读取百度贴吧|不支持这个贴吧页面/);
    assert.throws(() => legacy.validUrl(raw, 'read'), /只允许读取百度贴吧|不支持这个贴吧页面/);
  }
  for (const raw of ['https://passport.baidu.com/x', 'https://tieba.baidu.com/x', 'file:///etc/passwd', 'https://tieba.baidu.com:8443/']) {
    assert.equal(allowNavigation(raw, 'login'), legacy.allowNavigation(raw, 'login'));
  }
  assert.deepEqual(cookiePairs('BDUSS=a; evil=1; STOKEN=b'), [{ name: 'BDUSS', value: 'a' }, { name: 'STOKEN', value: 'b' }]);
  assert.deepEqual(cookiePairs('STOKEN=b; BDUSS=a'), [{ name: 'BDUSS', value: 'a' }, { name: 'STOKEN', value: 'b' }]);
  assert.throws(() => cookiePairs('BDUSS=a\r\nB=2'), /不能含换行/);
  assert.deepEqual(cookiePairs('BDUSS; STOKEN=b'), [{ name: 'STOKEN', value: 'b' }]);
  assert.deepEqual(cookiePairs('BDUSS=; STOKEN=b'), [{ name: 'BDUSS', value: '' }, { name: 'STOKEN', value: 'b' }]);
  assert.throws(() => cookiePairs('BDUSS=a\u0000b'), /非法字符/);
  assert.throws(() => cookiePairs('BDUSS="a"'), /非法字符/);
});

test('the browser child only inherits allowlisted environment variables', () => {
  const env = childEnv({ PATH: '/bin', HOME: '/root', SECRET_TOKEN: 'x', DEEPSEEK_API_KEY: 'y', SYSTEMROOT: 'C:\\Windows' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/root', SYSTEMROOT: 'C:\\Windows' });
});

test('logout deletes the credentials it claims to delete and starts no browser', async () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws.profile, 'Default'), { recursive: true });
    writeFileSync(join(ws.profile, 'Cookies'), 'sqlite');
    writeFileSync(join(ws.profile, 'Default', 'Cookies'), 'sqlite');
    const result = await readWithChromium({
      exe: '/opt/chrome/chrome', profile: ws.profile, kind: 'logout', url: 'https://tieba.baidu.com/',
      spawnImpl: ws.spawnImpl, fetchImpl: ws.fetchImpl, WebSocketImpl: FakeSocket });
    assert.equal(result.loggedIn, false);
    assert.match(result.message, /Cookie/);
    assert.equal(existsSync(join(ws.profile, 'Cookies')), false);
    assert.equal(existsSync(join(ws.profile, 'Default', 'Cookies')), false);
    assert.equal(ws.child.spawned.length, 0);
  } finally { ws.cleanup(); }
});

test('headless read injects filtered cookies, polls the ready selector, and returns page html', async () => {
  const ws = workspace();
  let polls = 0;
  FakeSocket.reply = message => {
    if (message.method !== 'Runtime.evaluate') return {};
    const expression = message.params.expression;
    if (expression.includes('outerHTML')) return { result: { value: { html: '<html>正文</html>', url: 'https://tieba.baidu.com/f?kw=x' } } };
    polls++;
    return { result: { value: { title: '原神吧-百度贴吧', blocked: false, ready: polls > 1 } } };
  };
  const result = await readWithChromium({ exe: '/opt/chrome/chrome', profile: ws.profile, url: 'https://tieba.baidu.com/f?kw=x', kind: 'browse',
    cookie: 'BDUSS=secret; EVIL=1', spawnImpl: ws.spawnImpl, fetchImpl: ws.fetchImpl, WebSocketImpl: FakeSocket });
  assert.equal(result.html, '<html>正文</html>');
  const socket = FakeSocket.sockets[0];
  const cookies = socket.sent.find(message => message.method === 'Network.setCookies');
  assert.deepEqual(cookies.params.cookies, [{ name: 'BDUSS', value: 'secret', url: 'https://tieba.baidu.com/' }]);
  const navigate = socket.sent.find(message => message.method === 'Page.navigate');
  assert.equal(navigate.params.url, 'https://tieba.baidu.com/f?kw=x');
  assert.doesNotMatch(JSON.stringify(ws.child.spawned), /secret/);
  assert.ok(ws.child.killed >= 1);
  ws.cleanup();
});

test('account check reuses the same page fetch and reports login state', async () => {
  const ws = workspace();
  FakeSocket.reply = message => message.method === 'Runtime.evaluate' && message.params.expression.includes('json_userinfo')
    ? { result: { value: { ok: true, loggedIn: true, name: '测试账号', message: '已登录：测试账号' } } } : {};
  const result = await readWithChromium({ exe: '/opt/chrome/chrome', profile: ws.profile, url: 'https://tieba.baidu.com/', kind: 'account',
    spawnImpl: ws.spawnImpl, fetchImpl: ws.fetchImpl, WebSocketImpl: FakeSocket });
  assert.equal(result.loggedIn, true);
  assert.equal(result.name, '测试账号');
  ws.cleanup();
});

test('verification pages, oversize pages and unwanted login are reported as readable errors', async () => {
  const blocked = workspace();
  FakeSocket.reply = message => message.method === 'Runtime.evaluate'
    ? { result: { value: { title: '安全验证', blocked: true, ready: false } } } : {};
  await assert.rejects(readWithChromium({ exe: '/opt/chrome/chrome', profile: blocked.profile, url: 'https://tieba.baidu.com/f', kind: 'browse',
    spawnImpl: blocked.spawnImpl, fetchImpl: blocked.fetchImpl, WebSocketImpl: FakeSocket }), /安全验证/);
  assert.ok(blocked.child.killed >= 1);
  blocked.cleanup();

  const huge = workspace();
  FakeSocket.reply = message => {
    if (message.method !== 'Runtime.evaluate') return {};
    if (message.params.expression.includes('outerHTML')) return { result: { value: { html: 'x'.repeat(2600000), url: 'https://tieba.baidu.com/f' } } };
    return { result: { value: { title: '贴吧', blocked: false, ready: true } } };
  };
  await assert.rejects(readWithChromium({ exe: '/opt/chrome/chrome', profile: huge.profile, url: 'https://tieba.baidu.com/f', kind: 'browse',
    spawnImpl: huge.spawnImpl, fetchImpl: huge.fetchImpl, WebSocketImpl: FakeSocket }), /页面过大/);
  huge.cleanup();

  await assert.rejects(readWithChromium({ exe: '/opt/chrome/chrome', profile: tmpdir(), url: 'https://tieba.baidu.com/', kind: 'login',
    spawnImpl: () => { throw new Error('never'); }, WebSocketImpl: FakeSocket }), /不能打开登录窗口/);
});

test('a browser that dies before opening the devtools port fails fast instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tieba-dead-'));
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stderr = new PassThrough();
    proc.kill = () => true;
    proc.stderr.write('Running as root without --no-sandbox is not supported\n');
    setTimeout(() => proc.emit('exit', 1), 10);
    return proc;
  };
  await assert.rejects(readWithChromium({ exe: '/opt/chrome/chrome', profile: dir, url: 'https://tieba.baidu.com/f', kind: 'browse',
    spawnImpl, fetchImpl: async () => ({ ok: true, json: async () => ({}) }), WebSocketImpl: FakeSocket }), /浏览器组件未就绪|启动失败/);
  rmSync(dir, { recursive: true, force: true });
});

test('a browser that fails to spawn reports a readable error instead of hanging on the port file', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'tieba-spawn-'));
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stderr = new PassThrough();
    proc.kill = () => true;
    queueMicrotask(() => proc.emit('error', new Error('spawn ENOENT')));
    return proc;
  };
  try {
    await assert.rejects(readWithChromium({ exe: '/opt/chrome/missing', profile, url: 'https://tieba.baidu.com/', kind: 'browse',
      spawnImpl, fetchImpl: async () => { throw new Error('fetch must not be reached'); }, timeoutMs: 5000, startupTimeoutMs: 1000,
      WebSocketImpl: FakeSocket }), /浏览器组件启动失败/);
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('a browser that never publishes DevToolsActivePort gives up at the startup budget, not the whole read budget', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'tieba-slow-'));
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stderr = new PassThrough();
    proc.kill = () => true;
    return proc;
  };
  const started = Date.now();
  try {
    await assert.rejects(readWithChromium({ exe: '/opt/chrome/chrome', profile, url: 'https://tieba.baidu.com/', kind: 'browse',
      spawnImpl, fetchImpl: async () => ({ ok: true, json: async () => ({}) }), timeoutMs: 30000, startupTimeoutMs: 200,
      WebSocketImpl: FakeSocket }), /浏览器组件未就绪/);
    assert.ok(Date.now() - started < 6000, 'must not wait out the whole read budget');
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
