import { access, mkdir, writeFile, unlink, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { getVoiceOptions } from './settings.mjs';

const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export async function hasModuleData(root) {
  return await exists(join(root, 'song DB')) || await exists(join(root, 'AuraBot-Family'));
}
async function containsSavedFiles(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || await containsSavedFiles(join(root, entry.name))) return true;
  }
  return false;
}
export async function prepareStorage(value) {
  if (typeof value !== 'string' || !isAbsolute(value.trim())) throw new Error('请输入完整的保存目录路径。');
  const root = resolve(value.trim());
  if (root === parse(root).root) throw new Error('请选择磁盘下的文件夹，不要直接使用磁盘根目录。');
  if (await hasModuleData(root)) throw new Error('此位置已有模块数据，请保留原配置；首次设置不会覆盖或合并已有资料。');
  await mkdir(root, { recursive: true });
  const probe = join(root, '.xiaoai-write-check-' + randomUUID());
  try { await writeFile(probe, '', { flag: 'wx' }); }
  catch { throw new Error('所选位置无法写入，请选择有写入权限的文件夹。'); }
  finally { await unlink(probe).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return root;
}

export function configuredFeatures(api) {
  let voices;
  try { voices = getVoiceOptions(api); }
  catch { voices = { options: [], dialogue: { configured: false }, singing: { configured: false } }; }
  let model = false, songs = false;
  try { const selected = api.lib('core/llm.js').defaultModel(api.dsh, api.config()); model = Boolean(selected?.provider && selected?.model); } catch {}
  try { songs = typeof api.use('song')?.search === 'function'; } catch {}
  const explicit = api.settings().motherVoice;
  return { original: songs, model, dialogue: model && voices.dialogue.configured,
    singing: songs && (explicit ? voices.options.some(item => item.id === explicit) : voices.singing.configured) };
}

// Only the host's empty data directory may exist before a user chooses storage.
// No library, cursor, reminder, or conversation service starts before that choice.
export async function setupOnboarding(api, setupRuntime, { localPost, localRequest }) {
  let root = api.settings().resourceRoot || '';
  if (!root) {
    const legacy = api.dataDir();
    if (await containsSavedFiles(join(legacy, 'song DB')) || await containsSavedFiles(join(legacy, 'AuraBot-Family'))) root = legacy;
  }
  let complete = Boolean(root) && api.settings().setupComplete !== false;
  let runtime, starting, closed = false, wakeSaved = false, verifiedConnection = '';
  let connectionCheck = 0;
  const signature = () => JSON.stringify([api.settings().networkInterface || '', api.settings().speakerDevice || '']);
  const blocked = () => ({ ok: false, code: 'XIAOAI_SETUP_REQUIRED', message: '请先完成首次配置，再使用此功能。' });
  const view = () => ({ resourceRoot: root, storageReady: Boolean(runtime), complete,
    speakerVerified: Boolean(verifiedConnection) && verifiedConnection === signature(), wakeSaved,
    features: configuredFeatures(api) });
  const status = () => ({ ...(runtime?.status() || { ok: true, connected: false, songs: { entries: [], jobs: [] }, playlists: [],
    playback: { phase: 'idle' }, listener: { enabled: false }, login: { phase: 'idle' }, storage: { root } }), onboarding: view() });
  const setupRoutes = new Set(['/status', '/settings/options', '/settings/save', '/speaker/check', '/speaker/login/start',
    '/speaker/login/select', '/speaker/login/qr', '/speaker/login', '/speaker/wake', '/speaker/wake/audio', '/speaker/wake/save', '/speaker/wake/suggest', '/capabilities']);
  api.onDispose(() => { closed = true; });
  const start = async () => {
    if (runtime) return runtime;
    if (starting) return starting;
    starting = (async () => {
      if (closed) throw new Error('模块已关闭。');
      wakeSaved = await exists(join(root, 'AuraBot-Family', 'Speaker', '家庭称呼.json'));
      const wrapped = { ...api, settings: () => ({ ...api.settings(), resourceRoot: root }),
        route: (path, handler) => api.route(path, async (...args) => {
          if (!complete && !setupRoutes.has(path)) return blocked();
          if (path === '/speaker/check' && !complete) {
            const check = ++connectionCheck;
            const checkedSettings = signature();
            verifiedConnection = '';
            const result = await handler(...args);
            if (check !== connectionCheck || checkedSettings !== signature()) {
              return { ok: false, message: '连接检查期间设置已变更或开始了新一轮检查，请查看最新结果。' };
            }
            if (result?.ok && result.historyReadable) verifiedConnection = checkedSettings;
            return result;
          }
          const result = await handler(...args);
          if (path === '/speaker/wake/save' && result?.ok && result.wake) wakeSaved = true;
          return result?.storage || path === '/status' ? { ...result, onboarding: view() } : result;
        }),
        every: (ms, fn, label) => api.every(ms, () => complete && !closed ? fn() : undefined, label),
        tool: builder => api.tool(context => complete ? builder(context) : []),
        rule: builder => api.rule(() => complete ? builder() : ''),
      };
      runtime = await setupRuntime(wrapped);
      return runtime;
    })();
    try { return await starting; } finally { starting = null; }
  };
  api.route('/status', async () => status());
  api.route('/speaker/listener/start', async () => blocked());
  api.route('/speaker/arm', async () => blocked());
  api.route('/onboarding/networks', async req => {
    if (!localRequest(req) || req.method !== 'GET') return { ok: false, message: '需要本机访问。' };
    return { ok: true, networks: Object.entries(networkInterfaces()).flatMap(([name, addresses]) => {
      const ipv4 = addresses.filter(item => (item.family === 'IPv4' || item.family === 4) && !item.internal).map(item => item.address);
      return ipv4.length ? [{ name, addresses: ipv4 }] : [];
    }) };
  });
  let choosing = false;
  api.route('/onboarding/storage', async req => {
    if (!localPost(req)) return { ok: false, message: '需要本机同源 JSON POST。' };
    if (closed || choosing || complete || runtime) return { ok: false, message: '保存位置已确定或正在设置，不能在首次向导中切换已有数据。' };
    choosing = true;
    try {
      const body = await api.core.http.body(req);
      if (!root) {
        const selected = await prepareStorage(body.root);
        if (closed) throw new Error('模块已关闭。');
        await api.saveSettings({ resourceRoot: selected, setupComplete: false });
        root = selected;
      }
      await start();
      return status();
    } catch (error) { return { ok: false, message: ['请输入完整', '请选择磁盘', '此位置已有', '所选位置无法'].some(prefix => error.message?.startsWith(prefix))
      ? error.message : '保存位置设置未完成，请检查目录权限后重试；已有数据未搬迁。' }; }
    finally { choosing = false; }
  });
  api.route('/onboarding/complete', async req => {
    if (!localPost(req)) return { ok: false, message: '需要本机同源 JSON POST。' };
    if (closed || !runtime || !view().speakerVerified || !wakeSaved) return { ok: false, message: '请先检查音箱连接并保存主要称呼。' };
    await api.saveSettings({ setupComplete: true });
    complete = true;
    return status();
  });
  if (root) await start();
  return { status, execute: (...args) => complete && runtime ? runtime.execute(...args) : Promise.resolve(blocked()),
    remind: (...args) => complete && runtime ? runtime.remind(...args) : Promise.resolve(blocked()) };
}
