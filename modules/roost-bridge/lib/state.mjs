/**
 * 向导状态与敏感信息处理
 * ======================
 * 分两类：
 *   - 非敏感项（目录/模式/selfUin/appId/完成标记）→ 持久化到 api.dataDir()，
 *     DSH 重启后能恢复进度，用户不用从头点。
 *   - 敏感项（AppSecret / accessKey / token / botToken）→ 只存内存，重启必须重填。
 *     面板只显示「已设置」，不回显明文。
 *
 * 持久化读写函数由入口注入（state.init({dataDir})），这里不碰 node:fs 路径细节。
 */

import { CAPABILITIES, CAVEATS, MANUAL_STEPS, summary } from './compat.mjs';
import * as roost from './roost.mjs';

const KEEP = ['appId', 'selfUin', 'prevBotQQ', 'prevDiaryEnabled', 'prevQzoneSocialEnabled', 'mode', 'dir', 'installed', 'configured', 'started', 'botWritten', 'linked', 'lastError', 'autoStartResult', 'lastBridgePort'];
const SECRETS = ['appSecret', 'token', 'accessKey', 'botToken'];

const mem = {
  appId: '', appSecret: '', token: '', botToken: '', accessKey: '', selfUin: '', prevBotQQ: '',
  prevDiaryEnabled: null, prevQzoneSocialEnabled: null,
  mode: 'exclusive', dir: roost.DEFAULT_DIR(), port: 0, webuiPort: 0, lastBridgePort: 0,
  installed: false, configured: false, started: false,
  botWritten: false, linked: false, lastError: '', autoStartResult: '', childPid: 0, qrTaskId: '',
};

let persist = null; // { load(), save(obj) }，由 entry 注入
let installedCheck = () => false; // 由 entry 注入：检查模块自带 roost 源码是否完整

export function init({ dataDir, read, write, installedCheck: check } = {}) {
  if (typeof check === 'function') installedCheck = check;
  try {
    if (read) {
      const saved = read();
      if (saved && typeof saved === 'object') {
        for (const k of KEEP) if (Object.hasOwn(saved, k)) mem[k] = saved[k];
      }
    }
  } catch {}
  persist = (patch) => {
    try {
      if (!write || !dataDir) return;
      const snap = {};
      for (const k of KEEP) snap[k] = mem[k];
      write(dataDir, snap);
    } catch {}
  };
  return get();
}

export function get() {
  return {
    ...mem,
    appIdSet: Boolean(mem.appId),
    appSecretSet: Boolean(mem.appSecret),
    tokenSet: Boolean(mem.token),
    accessKeySet: Boolean(mem.accessKey),
    botTokenSet: Boolean(mem.botToken),
    looksInstalled: installedCheck(),
    compat: summary(),
  };
}

export function set(patch = {}) {
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (!Object.hasOwn(mem, k)) continue;
    // 空串的敏感项 = 不改（跟 roost PUT /api/onebot 的规矩一致）
    if (SECRETS.includes(k) && patch[k] === '') continue;
    if (mem[k] !== patch[k]) changed = true;
    mem[k] = patch[k];
  }
  if (changed) persist?.();
  return get();
}

export function mark(name, value = true) {
  if (Object.hasOwn(mem, name) && mem[name] !== value) { mem[name] = value; persist?.(); }
  return get();
}

/** 六步向导。完成判定尽量看真实状态（装没装/配没配），不只看内存标记。 */
export function steps() {
  const s = get();
  return [
    { id: 'install', label: 'roost 就绪', done: s.looksInstalled, hint: '把模块自带的 roost 整份复制到数据目录运行（不联网、不改框架源码）' },
    { id: 'start', label: '启动 roost', done: s.started === true, hint: '先启动 roost，扫码接口由它提供；端口被占会自动顺延' },
    { id: 'credentials', label: '扫码建机器人', done: Boolean(s.appId && s.appSecret) || s.botWritten === true, hint: '点「生成二维码」，手机 QQ 扫码即可拿到凭证，不用手填 AppID/AppSecret' },
    { id: 'create-bot', label: '写入机器人配置', done: s.botWritten === true, hint: '扫码成功后自动把凭证写进 roost；改了配置要重启 roost 才生效' },
    { id: 'bridge', label: '开兼容层', done: s.configured, hint: '设为独占模式，ws 已随 roost 内置' },
    { id: 'link', label: '接入大肥鱼', done: s.linked === true, hint: '把大肥鱼的网关改到兼容层端口，改完重启一次 DSH' },
  ];
}

/** 重启后哪些要重填：敏感项丢了，但非敏感进度还在 */
export function needRefill() {
  const s = get();
  const missing = [];
  if (!s.appSecretSet) missing.push('AppSecret（写进 roost 用；如果已经写过了、roost 在跑，可不重填）');
  if (!s.accessKeySet) missing.push('roost 面板 accessKey（没设过就不用填）');
  if (!s.tokenSet) missing.push('兼容层 token（如果兼容层已经开着，可不重填）');
  return missing;
}

export { CAPABILITIES, CAVEATS, MANUAL_STEPS, summary, KEEP, SECRETS };
