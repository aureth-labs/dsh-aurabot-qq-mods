import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvironmentError } from '../lib/environment.mjs';
const exec = promisify(execFile);
const SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:']);
const PROXY_ERROR = '下载代理地址无效，请使用 http:// 或 socks5:// 开头的地址。';
// 单次 curl --max-time。未配置、0 和超出 1–360 分钟都回到 60。
export function normalizeDownloadOptions({ timeoutMinutes, proxyEnabled = false, proxy = '' } = {}) {
  const raw = Number(timeoutMinutes);
  const minutes = Number.isFinite(raw) && raw >= 1 && raw <= 360 ? Math.floor(raw) : 60;
  const address = String(proxy ?? '').trim();
  let selected = '';
  if (proxyEnabled === true) {
    let parsed = null;
    try { parsed = new URL(address); } catch { parsed = null; }
    if (!parsed || !SCHEMES.has(parsed.protocol) || !parsed.hostname) throw new EnvironmentError(PROXY_ERROR, '', '');
    selected = address;
  }
  return { timeoutSec: minutes * 60, proxy: selected };
}
export function downloadOptionsFromEnv(env = process.env) {
  const minutes = env.MEME_DOWNLOAD_TIMEOUT_MINUTES;
  return normalizeDownloadOptions({
    timeoutMinutes: minutes === undefined || minutes === '' ? undefined : Number(minutes),
    proxyEnabled: env.MEME_DOWNLOAD_PROXY_ENABLED === '1',
    proxy: env.MEME_DOWNLOAD_PROXY || '',
  });
}
export function downloadEnv(settings = {}) {
  const options = normalizeDownloadOptions({
    timeoutMinutes: settings.downloadTimeoutMinutes,
    proxyEnabled: settings.downloadProxyEnabled === true,
    proxy: settings.downloadProxy,
  });
  return {
    MEME_DOWNLOAD_TIMEOUT_MINUTES: String(options.timeoutSec / 60),
    MEME_DOWNLOAD_PROXY_ENABLED: options.proxy ? '1' : '0',
    MEME_DOWNLOAD_PROXY: options.proxy,
  };
}
export function curlDownloadArgs({ url, output, timeoutSec = 3600, proxy = '', connectTimeout = 20, retry = 0, retryDelay = 0, headers = [], resume = false, speedTime = 0, speedLimit = 0 }) {
  const args = ['-fLsS', '--connect-timeout', String(connectTimeout), '--max-time', String(timeoutSec)];
  if (retry > 0) args.push('--retry', String(retry));
  if (retryDelay > 0) args.push('--retry-delay', String(retryDelay));
  if (speedTime > 0) args.push('--speed-time', String(speedTime));
  if (speedLimit > 0) args.push('--speed-limit', String(speedLimit));
  if (proxy) args.push('--proxy', proxy);
  else args.push('--noproxy', '*');
  for (const header of headers) args.push('-H', header);
  if (output) args.push('-o', output);
  // 只在已有临时文件时续传。--max-time 仍是这一次请求的上限，不是整包总时长。
  if (resume) args.push('-C', '-');
  args.push(url);
  return args;
}
export function redactProxy(text, proxy) {
  const raw = String(text ?? '');
  if (!proxy) return raw;
  let out = raw.split(proxy).join('代理');
  try {
    const parsed = new URL(proxy);
    for (const secret of [parsed.username, parsed.password]) {
      if (!secret) continue;
      out = out.split(secret).join('***');
      try { out = out.split(decodeURIComponent(secret)).join('***'); } catch { /* 非法转义保持已替换的原文 */ }
    }
  } catch { /* 地址无效时只替换整段 */ }
  return out;
}
export async function runCurl(args, { proxy = '', ...options } = {}) {
  try { return await exec(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { windowsHide: true, ...options }); }
  catch (error) {
    error.message = redactProxy(error.message, proxy);
    if (error.stderr) error.stderr = redactProxy(error.stderr.toString(), proxy);
    throw error;
  }
}
