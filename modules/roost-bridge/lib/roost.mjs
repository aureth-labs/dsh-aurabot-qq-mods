/**
 * roost 内置安装器 + 兼容层配置客户端
 * ==================================
 * roost 连同必需依赖（ws / silk-wasm）已打包在模块的 lib/vendor/roost/ 里（只读母本）。
 * 启动前把整份复制到 modules-data/<id>/roost-code/，从那里运行：
 *   - 模块目录不会被 roost 的运行时写入（ports.json / plugins/）碰脏，宿主不会热重载；
 *   - 不用改 roost 框架源码，升级就是重新复制一份；
 *   - 凭证、配置、日志仍在 ROOST_HOME（roost-home），跟代码彻底分开。
 * 模块胶水不下载、不执行远端代码；随包 roost 自带的可选更新路径见 README：
 * autoApply 会在每次启动前硬锁为 false，所有下载只在用户主动确认后由 roost 发起。
 *
 * 安全边界：
 *   - 没有任何 fetch 到外部下载代码的行为；唯一的 fetch 是调本机 roost 面板 API
 *   - 所有写操作都必须用户在面板显式点按，setup() 阶段什么都不做
 *   - AppSecret / accessKey / token 这类凭据不写进模块数据目录
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';

/** 兼容旧调用：默认目录就是模块自带那份（真实绝对路径由入口传 vendorDir） */
export const DEFAULT_DIR = () => join(homedir(), '.roost', 'aurabot-bridge');
/** 模块自带的 roost 母本（只读，不直接运行）；按市场约定集中在 lib/ 下，模块根只留入口与说明 */
export const inplaceDir = (moduleDir) => join(String(moduleDir || ''), 'lib', 'vendor', 'roost');
/** 实际运行用的 roost 副本：整体复制到模块数据目录，避免写脏被监控的模块目录 */
export const runtimeDir = (dataDir) => join(String(dataDir || ''), 'roost-code');
/** roost 运行数据（config/logs/data）落点 */
export const inplaceHome = (dataDir) => join(String(dataDir || ''), 'roost-home');

export function looksLikeRoost(dir) {
  return Boolean(dir) && existsSync(join(dir, 'src', 'main.js'));
}

/** 给母本目录算一个内容指纹（相对路径 + 大小 + mtime），用来判断运行副本是否过期 */
function hashTree(dir) {
  const h = createHash('sha256');
  const walk = (d, rel = '') => {
    const entries = readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        const st = statSync(p);
        h.update(`${r}\0${st.size}\0${Math.round(st.mtimeMs)}\0`);
      }
    }
  };
  walk(String(dir));
  return h.digest('hex');
}

/**
 * 把母本同步到运行目录。roost 正在跑时不要调用（调用方先查 roostAlive）。
 * 指纹没变就跳过；变了就整份替换，保证运行副本永远是模块自带那版。
 */
export function syncRuntime({ vendorDir, codeDir, log = () => {} } = {}) {
  const src = String(vendorDir || '');
  const dst = String(codeDir || '');
  if (!looksLikeRoost(src)) {
    throw new Error('模块自带的 roost 副本不完整（缺 src/main.js），请重装本模块');
  }
  const hash = hashTree(src);
  const stampFile = join(dst, '.roost-bridge-source.json');
  let old = {};
  try { old = JSON.parse(readFileSync(stampFile, 'utf8')); } catch {}
  if (old.hash === hash && looksLikeRoost(dst)) {
    return { ok: true, copied: false, codeDir: dst, hash, version: old.version || bundledVersion(src) };
  }
  if (dst) rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, force: true });
  writeFileSync(stampFile, JSON.stringify({
    hash, version: bundledVersion(src), syncedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  log(`已把 roost ${bundledVersion(src)} 从模块自带母本同步到 ${dst}`);
  return { ok: true, copied: true, codeDir: dst, hash, version: bundledVersion(src) };
}

/** 安装/就绪：同步运行副本 + 建好数据目录。returns codeDir 供调用方启动用。 */
export function install({ vendorDir, codeDir, homeDir, log = () => {} } = {}) {
  const synced = syncRuntime({ vendorDir, codeDir, log });
  if (homeDir) mkdirSync(String(homeDir), { recursive: true });
  return {
    ok: true,
    codeDir: synced.codeDir,
    dir: String(homeDir || synced.codeDir),
    home: String(homeDir || ''),
    version: synced.version,
    message: synced.copied
      ? `已把模块自带的 roost ${synced.version} 放到数据目录运行（不联网）`
      : `运行副本已是模块自带的 roost ${synced.version}`,
    skipped: !synced.copied,
    inplace: false,
  };
}

/**
 * 准备外接依赖：roost 的依赖目录跟着 ROOST_HOME 走（data/deps/ext）。
 * 模块把 ws/silk 放在 vendor 的 bundled/ 下（市场打包器会跳过任何 node_modules/ 目录），
 * 这里复制成 home 下的 node_modules。老版本若还是 node_modules/ 布局，也兼容读取。
 * 幂等：ws 已就位就跳过；只从模块自带文件复制，不联网、不执行远端代码。
 */
export function prepareDeps({ vendorDir, homeDir, log = () => {} } = {}) {
  const ext = join(String(vendorDir || ''), 'data', 'deps', 'ext');
  const bundled = join(ext, 'bundled');
  const legacy = join(ext, 'node_modules');
  const from = existsSync(join(bundled, 'ws', 'package.json')) ? bundled : legacy;
  const to = join(String(homeDir || ''), 'data', 'deps', 'ext');
  if (!existsSync(join(from, 'ws', 'package.json'))) {
    throw new Error('模块自带的 roost 缺 ws 依赖（lib/vendor/roost/data/deps/ext/bundled/ws），请重装本模块');
  }
  if (existsSync(join(to, 'node_modules', 'ws', 'package.json'))
    && existsSync(join(to, 'node_modules', 'silk-wasm', 'package.json'))) {
    return { ok: true, skipped: true, dir: to, message: '外接依赖已就位' };
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, join(to, 'node_modules'), { recursive: true, force: true });
  log(`已把内置 ws / silk-wasm 放到 ${to}`);
  return { ok: true, skipped: false, dir: to, message: '已把内置 ws / silk-wasm 放到 roost 数据目录（不联网）' };
}

/**
 * 把 roost 自更新锁成「只检查、不自动应用」。
 * 只改 ROOST_HOME 的运行配置，不改随包源码；每次启动前调用，防止用户配置把 autoApply 打开。
 */
export function lockAutoApply(homeDir, log = () => {}) {
  const file = join(String(homeDir || ''), 'config', 'bot.json');
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { return { ok: false, skipped: true }; }
  if (!cfg || typeof cfg !== 'object') return { ok: false, skipped: true };
  const before = cfg.update?.autoApply;
  cfg.update = { ...(cfg.update && typeof cfg.update === 'object' ? cfg.update : {}), autoApply: false };
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  if (before !== false) log('已把 roost 自动更新锁为关闭（只检查、不自动安装）');
  return { ok: true, changed: before !== false };
}

/** 机器人配置是否已落盘。dir = ROOST_HOME（数据目录），与模块内存密钥无关。 */
export function botConfigExists(dir, name = 'main') {
  const file = join(dir, 'config', 'bots', `${name}.json`);
  if (!existsSync(file)) return false;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return Boolean(c.appId && c.appSecret);
  } catch { return false; }
}

/** 读内置 roost 的版本号（只用于展示，不影响安装） */
export function bundledVersion(vendorDir) {
  try { return String(JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8')).version || ''); }
  catch { return ''; }
}

/**
 * 写机器人凭证。dir = ROOST_HOME（数据目录）。
 *
 * 两个真机坑都在这里收口：
 *   1. 以前拿 dir 去 looksLikeRoost() 查 src/main.js——源码在 vendor，数据目录里没有，
 *      所以每次扫码写盘都报「roost 还没装好」，凭证根本没落盘。
 *   2. 以前直接写一份最小 JSON，会冲掉 onebot / owners / intents 等已有字段；
 *      而且 roost 只在启动时读配置，运行中写盘后任何一次面板保存都会用旧内存空凭证覆盖。
 *      所以调用方必须在 roost 停稳后调用，这里只负责「读旧 → 合并 → 写回 → 回读校验」。
 */
export function writeBotConfig({ dir, name = 'main', appId, appSecret } = {}) {
  if (!dir || !existsSync(String(dir))) {
    throw new Error('roost 数据目录不存在，先点一次「roost 就绪 / 启动 roost」');
  }
  const appIdValue = String(appId || '').trim();
  const appSecretValue = String(appSecret || '').trim();
  if (!appIdValue || !appSecretValue) throw new Error('AppID 和 AppSecret 都要填');
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(name))) throw new Error('机器人配置名不合法');

  const botsDir = join(String(dir), 'config', 'bots');
  mkdirSync(botsDir, { recursive: true });
  const file = join(botsDir, `${name}.json`);
  let bot = {};
  try { bot = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  bot = {
    ...bot,
    id: name,
    name: bot.name || name,
    enabled: bot.enabled !== false,
    appId: appIdValue,
    appSecret: appSecretValue,
  };
  writeFileSync(file, JSON.stringify(bot, null, 2), 'utf8');

  // 回读校验：写进去了才算成功，杜绝「扫码成功但凭证没落盘」的假阳性
  let back = {};
  try { back = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (String(back.appId || '').trim() !== appIdValue || String(back.appSecret || '').trim() !== appSecretValue) {
    throw new Error('凭证写入后校验失败，请重新扫码');
  }

  const globalFile = join(String(dir), 'config', 'bot.json');
  let global = {};
  try { global = JSON.parse(readFileSync(globalFile, 'utf8')); } catch {}
  global.webui = { openBrowser: false, ...(global.webui || {}) };
  writeFileSync(globalFile, JSON.stringify(global, null, 2), 'utf8');
  return { ok: true, file, message: '机器人凭证已写入 roost（已回读校验，重启后生效）' };
}

/** 读 roost 面板端口：从 config/bot.json（dir = ROOST_HOME） */
export function panelUrl(dir, portOverride = '') {
  let port = Number(portOverride) || 0;
  if (!port) {
    try { port = Number(JSON.parse(readFileSync(join(dir, 'config', 'bot.json'), 'utf8')).webui?.port) || 0; }
    catch {}
  }
  return `http://127.0.0.1:${port || 8080}`;
}

/**
 * 调 roost 面板 API。accessKey 只从本次调用的参数来，绝不落盘。
 * 唯一的网络目标是 127.0.0.1（本机 roost），不外发。
 */
export async function api({ base, accessKey = '', path, method = 'GET', body, timeoutMs = 15_000 } = {}) {
  const url = `${String(base).replace(/\/$/, '')}${path}` + (accessKey ? `?key=${encodeURIComponent(accessKey)}` : '');
  const init = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json' },
  };
  if (accessKey) init.headers['X-Access-Key'] = accessKey;
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) throw new Error(data.error || `roost API ${res.status}`);
  return data;
}

/** 生成兼容层 token（≥16 字符，roost 的硬要求） */
export function genToken() {
  return randomBytes(18).toString('base64url');
}

/**
 * 一键配置兼容层：ws 已随模块内置，直接 PUT /api/onebot。
 * 端口 0 = 让 roost 自动分配，实际端口从 GET /api/onebot 的 state 里读。
 */
export async function configureBridge({ base, accessKey, selfUin, token, mode = 'exclusive', log = () => {} } = {}) {
  if (!/^[1-9]\d{4,11}$/.test(String(selfUin))) throw new Error('机器人 QQ 号要 5–12 位数字，且不能以 0 开头');
  if (!token || String(token).length < 16) throw new Error('兼容层 token 至少 16 个字符');
  const body = {
    enabled: true,
    selfUin: String(selfUin),
    token: String(token),
    mode: ['exclusive', 'parallel', 'mirror'].includes(mode) ? mode : 'exclusive',
    host: '127.0.0.1',
    port: 0,
    voice: 'auto',
  };
  log('写入兼容层配置（ws 依赖已随模块内置）…');
  const r = await api({ base, accessKey, path: '/api/onebot', method: 'PUT', body });
  return { ok: true, state: r.state ?? r, message: '兼容层已开启' };
}

/** 读兼容层状态：实际端口、能力矩阵、依赖情况 */
export async function bridgeStatus({ base, accessKey } = {}) {
  return api({ base, accessKey, path: '/api/onebot', method: 'GET' });
}

/**
 * 把 aurabot 网关指向兼容层（局部深合并，不整份替换）。
 *
 * 必须同时改顶层 botQQ：aurabot 连上 OneBot 后会 get_login_info，
 * 用返回的 user_id 跟 config.botQQ 核对（host.js:258 → snowluma/manager.js:487），
 * 不一致就 onebot.stop()。只改网关/token 而留着旧机器人号，面板看着连上了其实立刻断开。
 * ownerQQ 是主人自己的号，不在这里动。
 */
export function aurabotPatch({ port, token, selfUin } = {}) {
  const qq = String(selfUin || '').trim();
  if (!/^[1-9]\d{4,11}$/.test(qq)) throw new Error('同步到 aurabot 需要有效的机器人 QQ 号（selfUin）');
  return {
    gateway: 'onebot',
    botQQ: qq,
    snowluma: {
      httpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      httpToken: String(token),
      wsToken: String(token),
    },
    // 空间日记 / 空间互动依赖 QQ 空间私有协议，官方 OneBot 这条路用不了。
    // 接入时关掉，避免她定时发空间却静默失败；退回原网关时由 /unlink 恢复。
    diary: { enabled: false },
    qzoneSocial: { enabled: false },
  };
}

/**
 * 找 roost 面板的真实地址。
 *
 * 为什么不能只读 config/bot.json：面板端口被占会自动顺延（最多 20 次），
 * 配置里记的是「意愿」，跑起来的是「现实」。roost 把现实写进 data/ports.json
 * 的 {roost:{want,actual,pid}}。三保险：ports.json（最准）→ 配置端口 → 默认 15207。
 * 最后用 /healthz 验一下（免密钥），确认那端口上真是 roost 而不是别的服务。
 */
export async function resolvePanel(dir, portOverride = '') {
  const candidates = [];
  const put = (p) => { const n = Number(p); if (n > 0 && n < 65536 && !candidates.includes(n)) candidates.push(n); };
  put(portOverride);
  try {
    // roost 原版把端口租约写在自己的代码根（现在是 roost-code），
    // 老版本曾落在 ROOST_HOME；两处都读，避免陈旧租约误导探活。
    const leases = [
      join(String(dir || ''), 'data', 'ports.json'),
      join(dirname(String(dir || '')), 'roost-code', 'data', 'ports.json'),
    ];
    for (const file of leases) {
      try {
        const lease = JSON.parse(readFileSync(file, 'utf8'));
        put(lease?.roost?.actual);
        put(lease?.roost?.want);
      } catch {}
    }
  } catch {}
  try { put(JSON.parse(readFileSync(join(dir, 'config', 'bot.json'), 'utf8')).webui?.port); } catch {}
  put(15207);
  for (const port of candidates) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.status === 200 || r.status === 503) {
        const body = await r.json();
        // 必须是 roost 的 healthz（有 bots 字段），别把别的服务当自己人
        if (Array.isArray(body?.bots)) return { base: `http://127.0.0.1:${port}`, port, health: body };
      }
    } catch {}
  }
  return { base: '', port: 0, health: null };
}

/** roost 在跑吗？拿到 healthz 合法 body 就算在（503 = 面板活着但机器人掉线，仍算在跑） */
export async function roostAlive(dir) {
  return Boolean((await resolvePanel(dir)).health);
}

/** 从 ROOST_HOME 的 config/bot.json 读面板密钥（模块内存密钥丢了仍能优雅关闭） */
export function readPanelKey(dir) {
  try {
    const g = JSON.parse(readFileSync(join(String(dir || ''), 'config', 'bot.json'), 'utf8'));
    return String(g?.webui?.accessKey || g?.webui?.token || '').trim();
  } catch { return ''; }
}

/** 从 roost 落盘配置读兼容层参数，供 DSH 重启后 /link 回填 */
export function readBridgeSettings(dir, name = 'main') {
  try {
    const c = JSON.parse(readFileSync(join(String(dir || ''), 'config', 'bots', `${name}.json`), 'utf8'));
    const o = c?.onebot || {};
    return {
      enabled: o.enabled === true,
      port: Number(o.port) || 0,
      token: String(o.token || '').trim(),
      selfUin: String(o.selfUin || '').trim(),
      mode: String(o.mode || 'exclusive'),
    };
  } catch { return { enabled: false, port: 0, token: '', selfUin: '', mode: 'exclusive' }; }
}

/**
 * 启动 roost 用哪个可执行文件。
 *
 * 不依赖用户 PATH 里的全局 node：一律用宿主自己的 process.execPath。
 * 桌面版 DSH 是 Electron 打包的，process.execPath 是 xxx.exe 而不是 node.exe；
 * 这种运行时必须显式给 ELECTRON_RUN_AS_NODE=1，否则会被当成启动 GUI，
 * src/main.js 根本不会执行——表现就是「没装全局 node 的机器上 roost 打不开」。
 */
export function runtimeInfo() {
  const exe = String(process.execPath || '');
  const base = basename(exe).toLowerCase();
  const isNode = /(^|[/\\])node(js)?(\.exe)?$/i.test(exe) || base.startsWith('node');
  return { exe, base, isNode, electronFlag: Boolean(exe) && !isNode };
}

/**
 * 起 roost 进程。返回守护进程 child；调用方自己 unref、管生命周期。
 *
 * 不直接 spawn roost，而是先起 lib/launch.mjs：它盯着启动它的宿主进程，
 * 宿主真退出才收掉 roost。模块热重载不会换宿主 pid，因此不会再把刚起的 roost 误关。
 */
export function startRoost(codeDir, homeDir = '') {
  const env = { ...process.env };
  const rt = runtimeInfo();
  if (rt.electronFlag) env.ELECTRON_RUN_AS_NODE = '1';
  if (homeDir) {
    mkdirSync(String(homeDir), { recursive: true });
    env.ROOST_HOME = String(homeDir); // 运行数据去模块数据目录，源码留在 vendor
  }
  const watcher = join(dirname(fileURLToPath(import.meta.url)), 'launch.mjs');
  return spawn(process.execPath, [
    watcher, String(codeDir), String(homeDir || ''),
    String(process.pid), rt.electronFlag ? '1' : '0',
  ], {
    cwd: String(codeDir), env, stdio: 'ignore',
    detached: false, windowsHide: true,
  });
}

/**
 * 一键恢复：把 aurabot 网关改回原来的 SnowLuma 配置。
 * prevBotQQ 是接入前记下的旧机器人号，恢复时一并写回，否则退回 SnowLuma 后
 * 登录号核对还是会对不上。返回补丁给调用方用 api.setConfig 深合并——不整份替换。
 */
export function restoreGatewayPatch({ botQQ = '', diary = null, qzoneSocial = null } = {}) {
  const qq = String(botQQ || '').trim();
  return {
    gateway: 'snowluma',
    ...(qq ? { botQQ: qq } : {}),
    snowluma: { httpUrl: '', wsUrl: '', httpToken: '', wsToken: '' },
    ...(typeof diary === 'boolean' ? { diary: { enabled: diary } } : {}),
    ...(typeof qzoneSocial === 'boolean' ? { qzoneSocial: { enabled: qzoneSocial } } : {}),
  };
}
