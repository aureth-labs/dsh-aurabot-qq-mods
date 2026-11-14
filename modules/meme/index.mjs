import { checkEnvironment } from './lib/environment.mjs';
import { BootstrapManager } from './lib/bootstrap.mjs';
import { chooseRuntimeDir, hasBaseRuntime } from './scripts/runtime-state.mjs';
import { ExtensionManager, cachedExtension } from './lib/extension.mjs';
import { UserError, publicErrorMessage } from './lib/errors.mjs';
import { Engine } from './lib/engine.mjs';
import { formatTemplateList } from './lib/list.mjs';
import { buildIndex, matchTemplate, parseInput, describe, words, readRequest } from './lib/catalog.mjs';
import { rawText, collectImages } from './lib/media.mjs';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const HELP = `表情制作
#表情列表 [页码] · #表情搜索 关键词 [页码]
#表情列表图片（完整目录图）
#表情详情 摸摸 · #表情预览 摸摸
#摸摸 @某人（也可附图或引用图片）
#鲁迅说 今天也要开心
#表情 随机 · #表情排行 · #表情状态
多段文字用 / 分隔；参数用 --参数 值
主人：#表情禁用 模板 / #表情启用 模板
#表情别名 新词=模板 · #表情开 / #表情关`;
export default {
  id: 'meme', name: '表情制作', version: '1.3.6', api: 1,
  description: '用头像、图片或文字制作表情，支持预览和自定义触发词',
  panel: 'panel.js',
  defaults: { enabled: true, direct: false, groups: '', private: true, cooldown: 3, indexColumns: 5, avatar: true, disabled: [], favorites: [], aliases: {} },
  settings: [
    { key: 'enabled', label: '启用表情制作', type: 'switch' },
    { key: 'direct', label: '允许省略 #', type: 'switch', hint: '关闭时，制作和查询都要以 # 开头，例如“#摸摸”“#表情列表”' },
    { key: 'avatar', label: '自动补齐头像', type: 'switch', hint: '图片不足时，使用发送者和机器人的头像' },
    { key: 'private', label: '允许私聊使用', type: 'switch' },
    { key: 'groups', label: '允许的群号', type: 'textarea', hint: '留空表示机器人已允许使用的所有群；指定群时，一行一个群号' },
    { key: 'cooldown', label: '每人制作间隔（秒）', type: 'number', min: 0, max: 60 },
  ],
  async setup(api) {
    const runtimeDir = chooseRuntimeDir(api.dir, api.dataDir('runtime'));
    const engine = new Engine(api.dir, { extensionEnabled: false, runtimeDir });
    const statsFile = api.dataDir('statistics.json');
    let stats = {}, items = [], index = new Map(), aliasKey = '', error = '', version = '', disposed = false;
    let saveTimer, inFlight = 0;
    try { stats = JSON.parse(readFileSync(statsFile, 'utf8')); } catch {}
    const avatarCache = new Map(), cooldowns = new Map();
    const settings = () => api.settings();
    function refreshIndex() {
      const aliases = JSON.stringify(settings().aliases || {});
      if (aliases !== aliasKey) { index = buildIndex(items, settings().aliases); aliasKey = aliases; }
    }
    function find(name) { refreshIndex(); return index.get(String(name).trim().toLowerCase()); }
    const enabled = item => !(settings().disabled || []).includes(item.key);
    const available = () => items.filter(enabled);
    function saveStats() { clearTimeout(saveTimer); try { writeFileSync(statsFile + '.tmp', JSON.stringify(stats)); renameSync(statsFile + '.tmp', statsFile); } catch (e) { api.log.warn('统计保存失败', e.message); } }
    const status = () => ({ ready: !!items.length && !error, error: error ? '模板库暂时不可用，请联系主人' : bootstrap.status().error, engineVersion: version, total: items.length, enabled: available().length, active: !!engine.active, queued: engine.queue.length });
    function acceptCatalog(result) {
      items = result.items; version = result.version; aliasKey = ''; refreshIndex(); error = '';
    }
    const extension = new ExtensionManager({dir:api.dir,runtimeDir,engine,onCatalog:acceptCatalog,save:patch=>api.saveSettings(patch),log:api.log});
    async function load() {
      await checkEnvironment();
      const result = await engine.call('catalog'); acceptCatalog(result); api.log.info(`离线引擎就绪：${items.length} 个模板`);
    }
    let wanted = false;
    const bootstrap = new BootstrapManager({dir:api.dir,runtimeDir,log:api.log,onReady:async()=>{await load();if(wanted)await extension.restore();}});
    function ensureReady() {
      if (bootstrap.status().busy) throw new UserError('表情库正在准备，请稍后再试');
      if (error || bootstrap.status().error || !items.length) throw new UserError('模板库暂时不可用，请联系主人');
    }
    function reportFailure(e) {
      if (!(e instanceof UserError)) api.log.warn('表情模块操作失败', e.stack || e.message || String(e));
      return publicErrorMessage(e);
    }
    async function sendImage(msg, result) {
      const segments = [];
      if (msg.kind === 'group' && msg.messageId && msg.messageId !== 'sim') segments.push({ type: 'reply', data: { id: String(msg.messageId) } });
      segments.push({ type: 'image', data: { file: 'base64://' + result.base64 } });
      const sent = await api.sendSegments(msg.chatId, segments, '[表情制作]');
      if (!sent) throw new UserError('QQ 未确认发送成功，请检查 AuraBot 开关和网关日志');
    }
    function allowed(msg) {
      const s = settings();
      return msg.kind === 'private' ? s.private !== false : !words(s.groups).length || words(s.groups).includes(String(msg.groupId));
    }
    async function generate(msg, matched, preview = false) {
      ensureReady();
      if (!enabled(matched.item)) throw new UserError('这个模板已被主人禁用');
      const now = Date.now(), who = `${msg.chatId}:${msg.userId}`;
      if (now < (cooldowns.get(who) || 0)) throw new UserError('制作太快啦，请稍后再试');
      if (cooldowns.size > 1000) for (const [k, v] of cooldowns) if (v < now) cooldowns.delete(k);
      cooldowns.set(who, now + Math.max(0, Math.min(60, Number(settings().cooldown) || 0)) * 1000);
      if (inFlight >= 6) throw new UserError('表情制作排队已满，请稍后再试');
      inFlight++;
      try {
      const input = preview ? {options:matched.shortcut?.options || {}} : parseInput(matched.rest || '', matched.item, matched.shortcut, msg.nickname || '你好');
      const images = preview ? [] : await collectImages(api, msg, matched.item.params, avatarCache, settings().avatar !== false);
      for (const [i, name] of (matched.shortcut?.names || []).entries()) if (images[i] && name) images[i] = {...images[i], name};
      const result = await engine.call(preview ? 'preview' : 'generate', { key: matched.item.key, images, ...input });
      await sendImage(msg, result);
      if (!preview && !msg.raw?.simulated) { stats[matched.item.key] = (Number(stats[matched.item.key]) || 0) + 1; clearTimeout(saveTimer); saveTimer = setTimeout(saveStats, 3000); }
      } finally { inFlight--; }
    }
    function list(query = '') {
      ensureReady();
      return formatTemplateList(available(), query);
    }
    async function handle(msg, explicit) {
      if (!allowed(msg)) return false;
      refreshIndex();
      const request = readRequest(explicit ?? rawText(msg), settings().direct, explicit !== undefined);
      if (!request) return false;
      const { sharp } = request;
      let { text } = request;
      const management = text.match(/^表情(禁用|启用|别名|开|关)(?:\s+(.*))?$/su);
      if (management) {
        if (!api.isOwner(msg.userId)) { await api.reply(msg, '只有主人可以管理模板和开关'); return true; }
        const [, action, arg = ''] = management;
        try {
          if (action === '开' || action === '关') api.saveSettings({ enabled: action === '开' });
          else if (action === '别名') {
            const cut = arg.indexOf('='); const alias = arg.slice(0, cut).trim(), target = find(arg.slice(cut + 1));
            if (cut < 1 || !alias || alias.length > 40 || /\s/.test(alias) || !target) throw new UserError('用法：#表情别名 新词=已有模板名（触发词不能含空格）');
            api.saveSettings({ aliases: { ...settings().aliases, [alias]: target.item.key } });
          } else {
            const target = find(arg); if (!target) throw new UserError('模板不存在');
            const disabled = new Set(settings().disabled || []); action === '禁用' ? disabled.add(target.item.key) : disabled.delete(target.item.key);
            api.saveSettings({ disabled: [...disabled] });
          }
          await api.reply(msg, '已保存');
        } catch (e) { await api.reply(msg, reportFailure(e)); }
        return true;
      }
      const command = text.match(/^表情(列表图片|帮助|列表|搜索|详情|预览|排行|状态)(?:\s*(.*))?$/su);
      if (command || text === '表情帮助') {
        try {
          const action = command?.[1] || '帮助', arg = command?.[2]?.trim() || '';
          if (action === '帮助') await api.reply(msg, HELP);
          else if (action === '列表图片' || (action === '列表' && arg === '图片')) {
            ensureReady();
            await sendImage(msg, await engine.call('index-image', { disabled: settings().disabled || [], columns: settings().indexColumns || 5 }));
          }
          else if (action === '列表' || action === '搜索') await api.reply(msg, list(arg));
          else if (action === '状态') { const s = status(); await api.reply(msg, `表情制作${settings().enabled ? "已开启" : "已关闭"} · ${s.total} 个模板（启用 ${s.enabled}）\n${bootstrap.status().busy ? '表情库正在准备，请稍后再试' : s.error ? "暂时不可用，请联系主人检查模块日志" : `排队 ${s.queued}，${s.active ? '制作中' : '空闲'}`}`); }
          else if (action === '排行') await api.reply(msg, Object.entries(stats).filter(([key]) => items.some(m => m.key === key)).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, n]) => `${items.find(m => m.key === key)?.keywords[0] || key}：${n}`).join('\n') || '还没有制作记录');
          else { const found = find(arg); if (!found) throw new UserError('未找到模板，请使用“#表情搜索 关键词”'); if (action === '详情') await api.reply(msg, describe(found.item, Object.keys(settings().aliases || {}).filter(a => settings().aliases[a] === found.item.key))); else { if (!settings().enabled) throw new UserError('表情制作已关闭'); await generate(msg, found, true); } }
        } catch (e) { await api.reply(msg, reportFailure(e)); }
        return true;
      }
      if (settings().enabled === false) return false;
      const prefix = /^表情\s+/u.test(text);
      if (!prefix && !sharp && !settings().direct) return false;
      if (prefix) text = text.replace(/^表情\s+/u, '');
      let matched;
      if (text === '随机' || text === '随机表情') {
        const choices = available();
        if (choices.length) matched = { item: choices[Math.floor(Math.random() * choices.length)], rest: '' };
      } else matched = matchTemplate(text, index);
      if (!matched) { if (prefix && !items.length) { await api.reply(msg, bootstrap.status().busy ? '表情库正在准备，请稍后再试' : '模板库暂时不可用，请联系主人'); return true; } if (prefix) { await api.reply(msg, '未找到模板，发送“#表情列表”或“#表情搜索 关键词”'); return true; } return false; }
      // Zero-text raw triggers with unrelated trailing prose are ordinary conversation.
      if (!prefix && !sharp && matched.item.params.maxTexts === 0 && matched.rest && !/^(--|#)/.test(matched.rest)) return false;
      try { await generate(msg, matched); } catch (e) { await api.reply(msg, `表情制作失败：${reportFailure(e)}`); }
      return true;
    }
    api.on('message', msg => handle(msg));
    api.command({ name: '表情', aliases: ['meme'], desc: '表情制作：帮助、列表、模板名', run: async (arg, msg) => {
      arg = (rawText(msg).match(/^[\/／](?:表情|meme)(?:\s+|$)([\s\S]*)$/iu)?.[1] ?? arg).trim();
      await handle(msg, /^(帮助|列表图片|列表|搜索|详情|预览|排行|状态|开|关|禁用|启用|别名)(?:\s|$)/.test(arg) ? '表情' + arg : '表情 ' + arg); return '';
    } });
    // Module routes need their own local-only gate (the host exempts /ext from its admin gate).
    function local(req) {
      const address = req.socket?.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) throw new UserError('模板管理只允许本机访问');
    }
    api.route('/library', async req => { local(req); refreshIndex(); return { ...status(), items, stats, extension: extension.status(), installation: bootstrap.status() }; });
    api.route('/installation', async req => {
      local(req);
      if (req.method === 'GET') return {ok:true, ready:status().ready, installation:bootstrap.status()};
      try {
        if (req.method !== 'POST') throw new UserError('请使用 POST');
        return {ok:true, installation:status().ready ? bootstrap.status() : bootstrap.start()};
      } catch(e) { return {ok:false, message:reportFailure(e)}; }
    });
    api.route('/extension', async req => {
      local(req);
      try {
        if (req.method === 'GET') return {ok:true, extension:extension.status()};
        if (req.method !== 'POST') throw new UserError('请使用 POST');
        const body = await api.core.http.body(req);
        if (!['install', 'uninstall'].includes(body.action)) throw new UserError('请选择安装或卸载扩展库');
        ensureReady();
        return {ok:true, extension:extension.start(body.action === 'install')};
      } catch(e) { return {ok:false, message:reportFailure(e)}; }
    });
    api.route('/preview', async req => {
      local(req); if (req.method !== 'POST') throw new UserError('请使用 POST');
      ensureReady(); const b = await api.core.http.body(req); const found = find(b.key);
      if (!found || !enabled(found.item)) throw new UserError('模板不存在或已禁用');
      try { return await engine.call('preview', { key: found.item.key }); }
      catch (e) { throw new UserError(reportFailure(e)); }
    });
    function dispose() { if (disposed) return; disposed = true; bootstrap.dispose(); extension.dispose(); clearTimeout(saveTimer); engine.dispose(); saveStats(); avatarCache.clear(); }
    api.onDispose(dispose);
    // One-time migration: preserve an existing installation; fresh base installs stay light.
    wanted = settings().extensionEnabled;
    if (typeof wanted !== 'boolean') {
      wanted = cachedExtension(runtimeDir);
      api.saveSettings({extensionEnabled:wanted});
    }
    if (hasBaseRuntime(runtimeDir)) {
      try {await load();if(wanted)await extension.restore();bootstrap.markReady();}
      catch(e) {error=e.message;api.log.error(e.stack || String(e));bootstrap.markFailed(e);}
    } else bootstrap.start();
    return { status, catalog: () => items, handle, dispose };
  },
};
