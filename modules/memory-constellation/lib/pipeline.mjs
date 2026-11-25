// 每日读写：读取聊天、群聊和经历，分批提炼后写进内置记忆；
// 低清晰度自动归档，归档满 30 天清理。合并进记忆中枢，作为「记忆增强」的第三个页签。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DAY = 86_400_000;
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(n)) ? Number(n) : min));
const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const dayKey = (value = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value));

const EXTRACT_SYSTEM = `你是记忆提炼器。从聊天、群聊和经历片段里挑出值得长期记住的事实：人物称呼、喜好、身份、约定、重要经历、关系变化。
只保留稳定或明确的信息，不要流水账、不要猜测、不要记规则指令，也不要把她自己的回复当成事实。
最多 8 条；每条一句话，主语写清楚；who 填涉及的人（没有就空）；im 给 0~1，越重要越高。
只输出 JSON：{"items":[{"t":"提炼后的事实","who":"涉及的人","im":0.5,"src":["片段编号"]}]}`;

function normalize(source) {
  const s = source && typeof source === 'object' ? source : {};
  const lines = (Array.isArray(s.lines) ? s.lines : [])
    .map((line) => ({
      id: clean(line?.id, 120),
      at: Number(line?.at) || 0,
      source: clean(line?.source, 20) || 'chat',
      role: line?.role === 'bot' ? 'bot' : 'user',
      name: clean(line?.name, 20) || '群友',
      text: clean(line?.text, 300),
    }))
    .filter((line) => line.id && line.text)
    .sort((a, b) => a.at - b.at)
    .slice(-600);
  const extracts = {};
  const legacyDone = [];
  if (s.extracts && typeof s.extracts === 'object') {
    for (const [day, value] of Object.entries(s.extracts)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== 'object') continue;
      const items = (Array.isArray(value.items) ? value.items : [])
        .map((item) => ({
          t: clean(item?.t || item?.text, 80),
          who: clean(item?.who, 20),
          im: clamp(item?.im ?? item?.importance ?? 0.5, 0, 1),
        }))
        .filter((item) => item.t)
        .slice(0, 80);
      const done = Array.isArray(value.done) ? value.done.map((x) => clean(x, 120)).filter(Boolean).slice(-1000) : [];
      if (done.length) legacyDone.push(...done);
      const written = Array.isArray(value.written) ? value.written.map((x) => clean(x, 80)).filter(Boolean).slice(-500) : [];
      extracts[day] = { items, written };
    }
  }
  const kept = {};
  for (const day of Object.keys(extracts).sort().slice(-7)) kept[day] = extracts[day];
  const seen = Array.isArray(s.seen)
    ? s.seen.map((x) => clean(x, 120)).filter(Boolean)
    : legacyDone;
  return {
    day: String(s.day || ''),
    lines,
    extracts: kept,
    seen: [...new Set(seen)].slice(-2000),
    writeDay: String(s.writeDay || ''),
    writeLow: Number(s.writeLow) || 0,
    writeHigh: Number(s.writeHigh) || 0,
    lastExtractAt: Number(s.lastExtractAt) || 0,
    lastScan: Number(s.lastScan) || 0,
    deletedTotal: Number(s.deletedTotal) || 0,
  };
}

export function createPipeline(api, opts = {}) {
  const file = api.dataDir('pipeline.json');
  const memory = opts.memory || (() => api.use('memory'));
  const mode = opts.mode || (() => 'standard');
  const onChanged = opts.onChanged || (() => {});
  let state = normalize((() => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  })());
  let dirty = false;
  let busy = false;
  let disposed = false;

  const save = () => {
    if (disposed) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
      dirty = false;
    } catch (error) {
      api.log.warn?.('每日读写保存失败：' + error.message);
    }
  };
  api.onDispose?.(() => {
    disposed = true;
    if (dirty) save();
  });

  const S = () => api.settings() || {};
  const cfg = () => api.config() || {};
  const off = (value) => value === false || value === 0 || value === 'false';
  const disabled = () => off(S().enabled) || off(S().pipelineOn);
  const ownerQQ = () => String((cfg().ownerQQ || '').trim());
  // 自己机器上已经有每日整理在跑时，这一页只待命，避免重复提炼和重复计费。
  const standby = () => {
    const daily = (cfg().ext || {})['daily-evolve'];
    return Boolean(daily && daily.enabled !== false);
  };
  // 遗忘和提炼分开：提炼关掉后，归档/删除仍由中枢接管；但只有支持接管的内置记忆才生效。
  const forgetOff = () => off(S().enabled) || off(S().pipelineScanOn) || standby();
  const forgetManaged = () => {
    const m = memory();
    return Boolean(m && m.forgetManagedByHub === true);
  };
  const forgetActive = () => !forgetOff() && forgetManaged();
  const allowedChat = (chatId) => {
    const id = String(chatId || '');
    if (!id) return false;
    if (id === `private:${ownerQQ()}`) return true;
    const groups = (cfg().allow && cfg().allow.groups) || [];
    return groups.some((group) => id === `group:${group}`);
  };

  function ensureDay() {
    const today = dayKey();
    if (state.day !== today) state.day = today;
    const keep = clamp(Number(S().pipelineKeepDays) || 3, 1, 7);
    const cutoff = Date.now() - keep * DAY;
    if (state.lines.length && state.lines[0].at < cutoff) {
      state.lines = state.lines.filter((line) => line.at >= cutoff);
      dirty = true;
    }
    const keys = Object.keys(state.extracts || {}).sort();
    if (keys.length > 7) {
      const keepOnly = new Set(keys.slice(-7));
      for (const day of keys) if (!keepOnly.has(day)) delete state.extracts[day];
      dirty = true;
    }
  }

  function threshold(tokenMode) {
    const base = clamp(Number(S().pipelineMinLines) || 20, 5, 100);
    if (tokenMode === 'deep') return Math.min(base, 15);
    if (tokenMode === 'saver') return Math.max(base, 40);
    return base;
  }
  function todayExtract() {
    return state.extracts?.[state.day] || null;
  }
  function pendingLines() {
    // 全局已处理集合：跨天也不会把昨天已经提炼过的聊天再算一遍。
    const seen = new Set(state.seen || []);
    return state.lines.filter((line) => !seen.has(line.id));
  }

  function parseItems(raw) {
    const text = String(raw || '');
    const match = text.match(/\{[\s\S]*\}/);
    let data = {};
    try { data = JSON.parse(match ? match[0] : text); } catch { return []; }
    const list = Array.isArray(data?.items) ? data.items : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const t = clean(item?.t || item?.text, 80);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ t, who: clean(item?.who, 20), im: clamp(item?.im ?? item?.importance ?? 0.5, 0, 1) });
      if (out.length >= 8) break;
    }
    return out;
  }

  // 写入额度：配置值是基础额度；聊天量大时自动提高，最多 30 条。
  // 重要度高（>=0.7）的要点另有 8 条额度，保证大聊天里关键的事不会被挤掉。
  function writeBudget(day) {
    const configured = clamp(Number(S().pipelineMaxWrites) || 8, 0, 30);
    if (!configured) return { base: 0, high: 0 };
    const todayLines = state.lines.filter((line) => dayKey(line.at) === day).length;
    const adaptive = Math.min(30, Math.ceil(todayLines / 20));
    return { base: Math.max(configured, adaptive), high: 8 };
  }

  // 把 7 天内还没写入的提炼按重要度排队；当天额度用完后，剩下的留到后面继续写。
  function writeMemories(day) {
    const mem = memory();
    if (!mem || typeof mem.add !== 'function') return 0;
    const budget = writeBudget(day);
    if (!budget.base && !budget.high) return 0;
    if (state.writeDay !== day) {
      state.writeDay = day;
      state.writeLow = 0;
      state.writeHigh = 0;
    }
    const lowLeft = Math.max(0, budget.base - state.writeLow);
    const highLeft = Math.max(0, budget.high - state.writeHigh);
    if (!lowLeft && !highLeft) return 0;
    const writtenSets = new Map();
    const pool = [];
    for (const [key, extract] of Object.entries(state.extracts || {})) {
      if (!extract || !Array.isArray(extract.items) || !extract.items.length) continue;
      const written = new Set(extract.written || []);
      writtenSets.set(key, written);
      for (const item of extract.items) if (!written.has(item.t)) pool.push({ day: key, item });
    }
    if (!pool.length) return 0;
    const seenText = new Set();
    const unique = [];
    for (const entry of pool) {
      if (seenText.has(entry.item.t)) continue;
      seenText.add(entry.item.t);
      unique.push(entry);
    }
    unique.sort((a, b) => (Number(b.item.im) || 0) - (Number(a.item.im) || 0) || (b.day > a.day ? 1 : -1));
    let low = 0;
    let high = 0;
    let count = 0;
    for (const { day: from, item } of unique) {
      const imp = clamp(item.im, 0, 1);
      const important = imp >= 0.7;
      if (important ? high >= highLeft : low >= lowLeft) continue;
      try {
        const r = mem.add({
          text: item.t,
          aboutName: item.who || '',
          importance: imp,
          tags: ['每日读写', from.slice(5)],
          source: 'pipeline',
          tier: imp < 0.65 ? 'short' : 'long',
        });
        if (r?.ok) {
          // 内置记忆遇到相似内容会返回 updated：算一次巩固，不占用当天的新写入额度。
          if (!r.updated) {
            count += 1;
            if (important) {
              high += 1;
              state.writeHigh += 1;
            } else {
              low += 1;
              state.writeLow += 1;
            }
          }
          // 同一句话可能出现在几天的提炼里，一次写入后全部标记，避免重复排队。
          for (const [key, written] of writtenSets) {
            if ((state.extracts[key]?.items || []).some((x) => x.t === item.t)) written.add(item.t);
          }
        }
      } catch (error) {}
    }
    if (count) {
      for (const [key, written] of writtenSets) {
        if (state.extracts[key]) state.extracts[key].written = [...written].slice(-500);
      }
      dirty = true;
    }
    return count;
  }

  function fallbackRetention(item, now) {
    const tier = item?.tier === 'core' ? 'core' : item?.tier === 'short' ? 'short' : 'long';
    if (tier === 'core') return 1;
    const hitDays = Math.min(10, Math.max(0, Number(item?.hitDays) || 0));
    const importance = clamp(Number(item?.importance) ?? 0.5, 0, 1);
    const tau = tier === 'short' ? 1 : 20 * (1 + hitDays) * (0.5 + importance);
    const last = Math.max(Number(item?.at) || 0, Number(item?.lastHit) || 0);
    return Math.exp(-Math.max(0, (now - last) / DAY) / tau);
  }
  function fallbackTier(item) {
    if (item?.tier === 'short' || item?.tier === 'long' || item?.tier === 'core') return item.tier;
    const importance = Number(item?.importance) || 0.5;
    if (importance >= 0.85 && (Number(item?.hitDays) || 0) >= 5) return 'core';
    return 'long';
  }

  function scanArchive(now = Date.now(), notify = true) {
    if (!forgetActive()) {
      return {
        ok: false,
        archived: 0,
        deleted: 0,
        message: forgetOff() ? '中枢遗忘扫描没开' : '内置记忆还没启用中枢接管遗忘',
      };
    }
    ensureDay();
    let archived = 0;
    let deleted = 0;
    try {
      let store = null;
      try { store = api.lib('core/store.js'); } catch { store = null; }
      if (!store) return { ok: true, archived, deleted };
      const filePath = store.dataDir('memories.json');
      const data = store.readJson(filePath, () => ({ items: [] }));
      const features = (() => {
        try { return api.lib('features/memory.js'); } catch { return null; }
      })();
      const tierOf = (item) => (features?.tierOf ? features.tierOf(item) : fallbackTier(item));
      const retentionOf = (item) => {
        try { return features?.retention ? features.retention(item, now) : fallbackRetention(item, now); } catch { return fallbackRetention(item, now); }
      };
      const strengthOf = (item) => {
        if (Number.isFinite(Number(item?.strength))) return Number(item.strength);
        return features?.initialStrength ? features.initialStrength(item) : 1 + Math.min(4, Number(item?.hitDays) || 0);
      };
      const kept = [];
      for (const item of data.items || []) {
        if (!item) continue;
        const tier = tierOf(item);
        // 永久记忆永远不删；即使旧数据里带了 archivedAt/invalidAt，也保留下来。
        if (tier !== 'core') {
          if (item.archivedAt && now - Number(item.archivedAt) > 30 * DAY) {
            deleted += 1;
            continue;
          }
          if (item.invalidAt && now - Number(item.invalidAt) > 180 * DAY) {
            deleted += 1;
            continue;
          }
        }
        if (!item.archivedAt && !item.invalidAt) {
          let shouldArchive = false;
          if (tier === 'short') {
            shouldArchive = Boolean((item.expiresAt && now >= Number(item.expiresAt)) || retentionOf(item) < 0.1);
          } else if (tier !== 'core') {
            shouldArchive = (Number(item.importance) || 0.5) < 0.6 && retentionOf(item) < 0.05 && strengthOf(item) < 1.5;
          }
          if (shouldArchive) {
            item.archivedAt = now;
            item.archiveReason = tier === 'short' ? 'short-expired' : 'faded';
            archived += 1;
          }
        }
        kept.push(item);
      }
      if (archived || deleted) {
        if (deleted) data.items = kept;
        data.rev = (data.rev || 0) + 1;
        store.writeJson(filePath, data);
      }
    } catch (error) {
      return { ok: false, archived, deleted, message: error.message };
    }
    state.lastScan = now;
    state.deletedTotal += deleted;
    dirty = true;
    if (archived || deleted) {
      save();
      if (notify) onChanged();
    }
    return { ok: true, archived, deleted };
  }

  async function runExtract({ force = false } = {}) {
    if (busy) return { ok: false, message: '正在提炼，稍等' };
    if (disabled()) return { ok: false, message: '每日读写关着' };
    if (standby()) return { ok: false, message: '检测到每日整理已在运行，这一页待命' };
    const tokenMode = mode();
    if (tokenMode === 'panel' && !force) return { ok: false, message: '记忆中枢是只看星图模式，不调用模型提炼' };
    ensureDay();
    const pending = pendingLines();
    const need = threshold(tokenMode);
    if (!force && !pending.length) return { ok: false, message: '今天还没有新的活动' };
    if (!force && pending.length < need) return { ok: false, message: `再攒 ${need - pending.length} 条活动就能提炼` };
    busy = true;
    try {
      const size = clamp(Number(S().pipelineBatchSize) || 30, 10, 60);
      const maxCalls = 6;
      let calls = 0;
      let handled = 0;
      const extract = todayExtract() || { items: [], written: [] };
      state.extracts[state.day] = extract;
      const seenSet = new Set(state.seen || []);
      const items = Array.isArray(extract.items) ? extract.items.slice() : [];
      for (let i = 0; i < pending.length && calls < maxCalls; i += size) {
        const chunk = pending.slice(i, i + size);
        const text = chunk.map((line) => `[${line.id}] [${line.name}]：${line.text}`).join('\n');
        const raw = await api.ask({ system: EXTRACT_SYSTEM, text: `日期：${state.day}\n\n${text}`, maxTokens: 600 });
        calls += 1;
        for (const item of parseItems(raw)) {
          if (!items.some((x) => x.t === item.t)) items.push(item);
        }
        for (const line of chunk) seenSet.add(line.id);
        state.seen = [...seenSet].slice(-2000);
        handled += chunk.length;
        extract.items = items.slice(0, 80);
        state.lastExtractAt = Date.now();
        dirty = true;
        save();
        if (items.length >= 80) break;
      }
      const added = writeMemories(state.day);
      const scan = scanArchive(Date.now(), false);
      save();
      if (added || scan.archived || scan.deleted) onChanged();
      return {
        ok: true,
        message: `处理 ${handled} 行，已提炼 ${items.length} 条，写入记忆 ${added} 条${scan.archived ? `，归档 ${scan.archived} 条` : ''}`,
        handled,
        added,
        archived: scan.archived,
      };
    } catch (error) {
      return { ok: false, message: '提炼失败：' + error.message };
    } finally {
      busy = false;
      if (dirty) save();
    }
  }

  api.on('activity', (activity) => {
    try {
      if (!activity || disabled() || standby()) return;
      const text = clean(activity.text ?? activity.reply, 300);
      if (!text || text.length < 2) return;
      const chatId = String(activity.chatId || '');
      const source = clean(activity.source || 'chat', 20);
      const experience = /^(event|diary|experience|life|qzone)$/.test(source);
      if (!experience && !allowedChat(chatId)) return;
      if (activity.kind && activity.kind !== 'in' && activity.kind !== 'out') return;
      const at = Number(activity.at || activity.time) || Date.now();
      const id = clean(activity.messageId || activity.msgId || activity.id || `${chatId}|${activity.kind || 'in'}|${activity.userId || ''}|${at}|${text}`, 120);
      if (!id || state.lines.some((line) => line.id === id)) return;
      state.lines.push({
        id,
        at,
        source,
        role: activity.kind === 'out' ? 'bot' : 'user',
        name: clean(activity.nickname || activity.name || (activity.kind === 'out' ? '她' : '群友'), 20),
        text,
      });
      if (state.lines.length > 600) state.lines = state.lines.slice(-600);
      dirty = true;
    } catch (error) {}
  });

  api.every(5 * 60_000, async () => {
    try {
      if (disabled() || standby()) return;
      ensureDay();
      if (dirty) save();
      if (mode() !== 'panel' && pendingLines().length >= threshold(mode())) await runExtract();
    } catch (error) {
      api.log.warn?.('每日读写自动提炼失败：' + error.message);
    }
  }, '每日读写提炼');

  api.every(30 * 60_000, () => {
    try { scanArchive(); } catch (error) { api.log.warn?.('每日读写归档失败：' + error.message); }
  }, '每日读写归档');

  api.later(5000, () => {
    try { scanArchive(); } catch {}
  });

  api.route('/pipeline/state', async () => {
    ensureDay();
    const mem = memory();
    let archived = 0;
    try { archived = typeof mem?.archived === 'function' ? (mem.archived() || []).length : 0; } catch {}
    const extract = todayExtract();
    const budget = writeBudget(state.day);
    return {
      ok: true,
      standby: standby(),
      enabled: !disabled(),
      forgetActive: forgetActive(),
      forgetManaged: forgetManaged(),
      mode: mode(),
      threshold: threshold(mode()),
      budget: budget.base,
      highBudget: budget.high,
      writtenToday: state.writeDay === state.day ? state.writeLow + state.writeHigh : 0,
      lines: state.lines.length,
      pending: pendingLines().length,
      items: Array.isArray(extract?.items) ? extract.items.length : 0,
      archived,
      lastScan: state.lastScan,
      lastExtractAt: state.lastExtractAt,
      deletedTotal: state.deletedTotal,
    };
  });

  api.route('/pipeline/extract', async () => runExtract({ force: true }));
  api.route('/pipeline/scan', async () => {
    const r = scanArchive();
    return { ...r, message: r.ok ? `归档 ${r.archived || 0} 条，清理 ${r.deleted || 0} 条` : (r.message || '整理失败') };
  });

  return { scanActive: forgetActive };
}
