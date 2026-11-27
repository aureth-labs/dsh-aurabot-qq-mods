// 记忆中枢：读取内置记忆，给每条记忆算亮度、连关系边、做一层可视化索引，并合并联想增强。
// 不建第二套记忆库；单条修改/删除都走内置 memory，关掉插件记忆仍然照常工作。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { brightness, initialStability, buildEdges, layoutGraph3d, regionOf, similarity, brightnessLabel, FADING_THRESHOLD, FADING_ID, LAYOUT_VERSION } from './lib/graph.mjs';
import { createAssoc } from './lib/assoc.mjs';
import { createPipeline } from './lib/pipeline.mjs';

const DAY = 86_400_000;
// 新安装默认走「省 Token」；旧「记忆增强」用户迁移时用 LEGACY 默认值，保持原来的手感。
const LEGACY_ASSOC_DEFAULTS = {
  assocOn: true, maxHops: 1, maxItems: 5, threshold: 0.35, reinforce: true, strength: 0.6,
  autoAssoc: true, nameChance: 100, autoChance: 60, autoFloor: 0.5, autoMax: 2,
  ownerAliases: '', botNames: '', extraEntities: '',
};
const ASSOC_DEFAULTS = {
  assocOn: true, maxHops: 1, maxItems: 3, threshold: 0.35, reinforce: true, strength: 0.6,
  autoAssoc: false, nameChance: 40, autoChance: 0, autoFloor: 0.5, autoMax: 2,
  ownerAliases: '', botNames: '', extraEntities: '',
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(n)) ? Number(n) : min));
const timeOf = (value, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : fallback;
};
const dayKey = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value));

export default {
  id: 'memory-constellation',
  name: '记忆中枢',
  version: '0.9.1',
  api: 1,
  description: '一页管记忆：星图看清晰度和层级，点星复习、改删或新增；内置向量检索、名字联想和可选每日读写（默认关闭），打开后才读取活动、提炼写入；归档和删除由中枢判断并执行。',
  panel: 'panel.js',
  defaults: {
    enabled: true, keepDays: 30, spin: true, glow: true,
    edgeOn: true, edgeMode: 'focus', edgeStrength: 0.3, edgeMax: 30,
    edgeKinds: ['person', 'tag', 'similar', 'conflict', 'assoc'],
    llmOn: true,
    pipelineOn: false, pipelineMinLines: 20, pipelineMaxWrites: 8,
    pipelineBatchSize: 30, pipelineScanOn: true, pipelineKeepDays: 3,
    takeoverRecall: true, directCount: 4, injectMaxChars: 420,
    ...ASSOC_DEFAULTS,
  },
  settings: [],

  setup(api) {
    const file = api.dataDir('state.json');
    let state = { version: 1, lastSync: 0, stars: {}, snapshots: {}, edges: [], layout: { version: 0, radius: 470, groups: [], positions: {}, clusters: {} } };
    try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch {}
    let disposed = false;
    api.onDispose?.(() => {
      disposed = true;
      // 中枢退出时把内置的自动回忆还回去，避免用户落到“谁都不召回”的状态。
      try { api.use('memory')?.setAutoRecall?.(true); } catch {}
    });

    const save = () => {
      if (disposed) return;
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
    };

    const memory = () => api.use('memory');
    // 自动回忆接管：内置记忆支持 setAutoRecall 时，由中枢统一做直接召回 + 联想。
    let recallTakenOver = false;
    const applyRecallTakeover = () => {
      let m = null;
      try { m = api.use('memory'); } catch {}
      if (!m || typeof m.setAutoRecall !== 'function') { recallTakenOver = false; return false; }
      const active = api.settings().enabled !== false && api.settings().takeoverRecall !== false;
      try {
        // setAutoRecall(false) = 关闭内置自动回忆；中枢接管时才关。
        m.setAutoRecall(!active);
        recallTakenOver = active;
        return active;
      } catch {
        recallTakenOver = false;
        return false;
      }
    };
    const inferTokenMode = (cfg = {}, raw = {}) => {
      if (raw.llmOn === false || cfg.llmOn === false) return 'panel';
      if (raw.assocOn === false || cfg.assocOn === false) return 'saver';
      const nameChance = Number(cfg.nameChance ?? raw.nameChance ?? 100);
      const autoChance = Number(cfg.autoChance ?? raw.autoChance ?? 60);
      const maxItems = Number(cfg.maxItems ?? raw.maxItems ?? 5);
      if (nameChance > 45 || autoChance > 35 || maxItems > 4) return 'deep';
      if (cfg.autoAssoc === false || autoChance <= 0) return 'saver';
      return 'standard';
    };
    const currentTokenMode = () => {
      const s = api.settings() || {};
      const explicit = String(s.tokenMode || '');
      if (['panel', 'saver', 'standard', 'deep'].includes(explicit)) return explicit;
      return inferTokenMode(s);
    };
    // 合并后把旧「记忆增强」的值一次性搬进本模块设置，用户不必重填。
    try {
      const ext = api.config?.()?.ext || {};
      const old = ext['memory-assoc'] || {};
      const raw = ext['memory-constellation'] || {};
      const hasLegacy = Object.keys(old).length > 0;
      if (raw.assocMigrated !== true) {
        const patch = { assocMigrated: true };
        if (old.enabled !== undefined) patch.assocOn = old.enabled !== false;
        for (const key of Object.keys(ASSOC_DEFAULTS)) {
          if (key === 'assocOn') continue;
          if (old[key] !== undefined) patch[key] = old[key];
          else if (hasLegacy && raw[key] === undefined) patch[key] = LEGACY_ASSOC_DEFAULTS[key];
        }
        api.saveSettings?.(patch);
      }
      // 联想边接管原有同标签边时，把「联想」类型也默认打开，避免线突然消失。
      if (raw.assocEdgesMigrated !== true) {
        const patch = { assocEdgesMigrated: true };
        if (Array.isArray(raw.edgeKinds) && raw.edgeKinds.length && !raw.edgeKinds.includes('assoc')) {
          patch.edgeKinds = [...raw.edgeKinds, 'assoc'];
        }
        api.saveSettings?.(patch);
      }
      // 老用户只推断一个模式用于展示，不改任何现有参数；新安装没有 tokenMode，面板回退到 saver。
      if (!raw.tokenMode && (Object.keys(raw).length || hasLegacy)) {
        const current = api.settings() || {};
        const basis = { ...current, ...raw };
        if (hasLegacy) {
          for (const key of ['assocOn', 'nameChance', 'autoChance', 'maxItems', 'autoAssoc']) {
            if (raw[key] === undefined) basis[key] = old[key] !== undefined ? old[key] : LEGACY_ASSOC_DEFAULTS[key];
          }
        }
        api.saveSettings?.({
          tokenMode: inferTokenMode(basis, raw),
          settingsVersion: 2,
        });
      }
    } catch {}
    // 主人的 QQ 在星图里统一显示成「主人」，不跟人物小档案里的昵称走。
    const ownerQQ = String(api.config?.()?.ownerQQ || '').trim();
    const displayNameOf = (about, fallback = '') => (ownerQQ && String(about || '') === ownerQQ ? '主人' : fallback);
    let enhanceSyncToken = 0;
    const scheduleEnhanceSync = () => {
      const token = enhanceSyncToken + 1;
      enhanceSyncToken = token;
      api.later(1200, () => {
        if (!disposed && token === enhanceSyncToken) {
          try { sync(); } catch (error) { api.log.warn('联想图更新后同步失败：' + error.message); }
        }
      });
    };
    // 联想引擎和星图共用内置记忆；联想图建好后把新边并进星图。
    const enhance = createAssoc(api, {
      onBuilt: scheduleEnhanceSync,
      onReinforce: scheduleEnhanceSync,
      defaults: ASSOC_DEFAULTS,
      takeoverActive: () => recallTakenOver,
      directCount: () => {
        const n = Number(api.settings().directCount);
        return Number.isFinite(n) ? clamp(n, 0, 8) : 4;
      },
    });
    const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
    const mergeEnhanceEdges = (base, extra) => {
      if (!Array.isArray(extra) || !extra.length) return base;
      const byPair = new Map(base.map((edge, index) => [pairKey(edge.a, edge.b), index]));
      const out = base.slice();
      for (const edge of extra) {
        if (!edge || !edge.a || !edge.b || edge.a === edge.b) continue;
        if (edge.kind !== 'tag' && edge.kind !== 'semantic') continue;
        const key = pairKey(edge.a, edge.b);
        const index = byPair.get(key);
        const weight = clamp(Number(edge.w) || 0.5, 0, 1);
        if (index !== undefined) {
          // 同一条标签边被联想图认领后显示成「联想」，但不覆盖更具体的人物/冲突/相似边。
          if (out[index].kind === 'tag') {
            out[index] = { ...out[index], kind: 'assoc', weight: Math.max(out[index].weight, weight) };
          }
          continue;
        }
        // 星图建边时没抽到的联想标签边、以及向量语义边，都补成「联想」关系线。
        out.push({ a: edge.a, b: edge.b, kind: 'assoc', weight });
        byPair.set(key, out.length - 1);
      }
      return out;
    };
    // 归档条目不参与召回，但仍要画进「归档星云」，所以星图这边要把两份合起来读。
    const itemsNow = () => {
      const m = memory();
      if (!m || typeof m.list !== 'function') return null;
      const live = m.list() || [];
      const archived = typeof m.archived === 'function' ? (m.archived() || []) : [];
      if (!archived.length) return live;
      const seen = new Set(live.map((it) => it.id).filter(Boolean));
      return live.concat(archived.filter((it) => it?.id && !seen.has(it.id)));
    };
    // 有些记忆只存了 QQ 号，星团标签用人物小档案里的名字更好认。
    const profileNames = () => {
      try {
        const m = memory();
        if (!m || typeof m.profiles !== 'function') return new Map();
        return new Map((m.profiles() || []).filter((p) => p?.qq && p?.name).map((p) => [String(p.qq), String(p.name)]));
      } catch { return new Map(); }
    };
    const withName = (item, names) => {
      if (ownerQQ && String(item.about || '') === ownerQQ) return { ...item, aboutName: '主人' };
      return item.about && !item.aboutName && names.has(item.about) ? { ...item, aboutName: names.get(item.about) } : item;
    };

    const starOf = (item, now) => {
      let star = state.stars[item.id];
      if (!star) {
        star = {
          id: item.id,
          S: initialStability(item),
          lastHit: timeOf(item.lastHit, 0),
          hits: Number(item.hits) || 0,
          builtinHits: Number(item.hits) || 0,
        };
        state.stars[item.id] = star;
      }
      // 内置 memory 自己召回过的记忆，也算一次真实复习，但不重复叠加强化。
      const hits = Number(item.hits) || 0;
      if (hits > (star.builtinHits || 0) && !item.invalidAt && !item.archivedAt) {
        const delta = Math.min(3, hits - (star.builtinHits || 0));
        star.S = Math.min(180, (Number(star.S) || initialStability(item)) * (1.3 ** delta));
        star.lastHit = Math.max(timeOf(star.lastHit, 0), timeOf(item.lastHit, now));
        star.hits = (Number(star.hits) || 0) + delta;
      }
      star.builtinHits = Math.max(star.builtinHits || 0, hits);
      return star;
    };

    const brightnessOf = (item, now = Date.now()) => brightness(state.stars[item.id], item, now);
    // 层级和清晰度以记忆模块为准：星图不再自己算一套 S，只保留旧的 S 字段给老面板/测试兼容。
    const TIER_LABEL = { short: '临时', long: '长期', core: '永久' };
    const retentionFn = (() => {
      try {
        const features = api.lib('features/memory.js');
        return typeof features?.retention === 'function' ? features.retention : null;
      } catch { return null; }
    })();
    const memoryMeta = (items) => {
      const m = memory();
      const map = new Map();
      if (m && typeof m.metaAll === 'function') {
        try {
          for (const x of m.metaAll() || []) if (x?.id) map.set(x.id, x);
        } catch {}
      }
      // metaAll 默认不含归档条目；归档星的层级和清晰度从条目本身补算，恢复后自然回到记忆模块口径。
      for (const it of items || []) {
        if (!it?.id || map.has(it.id)) continue;
        let retentionValue = brightnessOf(it);
        try { if (retentionFn) retentionValue = clamp(Number(retentionFn(it)), 0, 1); } catch {}
        map.set(it.id, {
          id: it.id,
          tier: it.tier || 'long',
          retention: retentionValue,
          strength: Number(it.strength) || 0,
        });
      }
      return map.size ? map : null;
    };
    const tierOfItem = (item, meta) => (meta && meta.get(item.id)?.tier) || item?.tier || 'long';
    const retentionOf = (item, meta, now = Date.now()) => {
      const hit = meta && meta.get(item.id);
      return hit && Number.isFinite(Number(hit.retention)) ? clamp(Number(hit.retention), 0, 1) : brightnessOf(item, now);
    };

    const snapshot = (items, now, meta) => {
      const keep = clamp(api.settings().keepDays, 7, 60);
      const key = dayKey(now);
      const values = {};
      for (const it of items) values[it.id] = Math.round(retentionOf(it, meta, now) * 1000) / 1000;
      state.snapshots[key] = values;
      const cutoff = dayKey(now - keep * DAY);
      for (const date of Object.keys(state.snapshots)) if (date < cutoff) delete state.snapshots[date];
    };

    // settle：后台同步只挪一小步，手动优化传 1 直接收敛到理想位置。
    function sync(options = {}) {
      const settle = options.settle === undefined ? 0.18 : clamp(options.settle, 0, 1);
      if (disposed) return { ok: false, message: '星图模块已停用' };
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      const items = itemsNow();
      if (!items) return { ok: false, message: '记忆模块未启用，星图读不到条目' };
      const now = Date.now();
      const meta = memoryMeta(items);
      let added = 0;
      for (const item of items) {
        if (!item?.id) continue;
        const before = Boolean(state.stars[item.id]);
        starOf(item, now);
        if (!before) added += 1;
      }
      const ids = new Set(items.map((it) => it.id));
      for (const id of Object.keys(state.stars)) {
        if (!ids.has(id)) { delete state.stars[id]; continue; }
        // 旧版本留了个从没被读过的 firstSeenAt，顺手清掉。
        if (state.stars[id].firstSeenAt !== undefined) delete state.stars[id].firstSeenAt;
      }
      const names = profileNames();
      const liveIds = new Set(items.filter((it) => !it.invalidAt && !it.archivedAt).map((it) => it.id));
      state.edges = mergeEnhanceEdges(buildEdges(items), enhance.edges())
        .filter((edge) => liveIds.has(edge.a) && liveIds.has(edge.b));
      // 用记忆模块的层级曲线判断快忘，和面板里「快忘了」的口径保持一致；归档和过时另放在归档星云。
      const fadingIds = new Set();
      for (const item of items) {
        if (item?.id && !item.invalidAt && !item.archivedAt && retentionOf(item, meta, now) < FADING_THRESHOLD) fadingIds.add(item.id);
      }
      state.layout = layoutGraph3d(items.map((it) => withName(it, names)), { edges: state.edges, prev: state.layout, now, fadingIds, settle });
      snapshot(items, now, meta);
      state.lastSync = now;
      save();
      const moved = Math.round(Number(state.layout?.settle?.maxMove) || 0);
      if (settle > 0 && moved > 2) api.log.debug?.(`星图位置优化：${state.layout.groups.length} 个星团，最大移动 ${moved}`);
      return { ok: true, added, total: items.length, edges: state.edges.length, moved };
    }

    const emptyGraph = (ok, message) => ({
      ok, message, stars: [], edges: [],
      layout: { version: LAYOUT_VERSION, radius: 470, groups: [] },
      stats: { total: 0, live: 0, archived: 0, outdated: 0, bright: 0, dim: 0, clusters: 0, lastSync: state.lastSync, tiers: { short: 0, long: 0, core: 0 } },
    });

    function graph(dayOffset = 0) {
      const m = memory();
      if (!m || typeof m.list !== 'function') return emptyGraph(false, '记忆模块未启用，星图读不到条目');
      const items = itemsNow() || [];
      // 记忆模块正常但库是空的，和「模块没开」要分开提示，否则面板会误导。
      if (!items.length) return emptyGraph(true, '还没有可画的记忆，等内置记忆写入后再来。');
      if (state.layout?.version !== LAYOUT_VERSION || !Object.keys(state.layout?.positions || {}).length) {
        // 面板可能在首次同步前就打开了，或者旧版平面布局还没升级：这里补一次。
        try { sync(); } catch {}
      }
      const now = Date.now();
      const meta = memoryMeta(items);
      const offset = clamp(dayOffset, 0, 60);
      const date = offset ? dayKey(now - offset * DAY) : '';
      const snap = offset ? state.snapshots[date] : null;
      const positions = state.layout?.positions || {};
      const groups = state.layout?.groups || [];
      const names = profileNames();
      const stars = [];
      for (const item of items) {
        if (!positions[item.id]) continue;
        const b = snap?.[item.id] ?? retentionOf(item, meta, now);
        const star = state.stars[item.id] || {};
        const S = Math.max(1, Number(star.S) || initialStability(item));
        const last = timeOf(star.lastHit, 0) || timeOf(item.lastHit, 0) || timeOf(item.at, now);
        const mt = meta?.get(item.id);
        const nextReview = mt
          ? (mt.tier === 'core' ? 0 : Math.round(now + (Number(mt.tau) || 1) * Math.LN2 * DAY))
          : Math.round(last + S * 0.7 * DAY);
        stars.push({
          id: item.id,
          text: String(item.text || '').slice(0, 220),
          aboutName: displayNameOf(item.about, item.aboutName || (item.about ? names.get(item.about) || '' : '')),
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 3) : [],
          importance: clamp(item.importance ?? 0.5, 0, 1),
          at: timeOf(item.at, now),
          invalidAt: item.invalidAt ? timeOf(item.invalidAt, 0) : 0,
          archivedAt: item.archivedAt ? timeOf(item.archivedAt, 0) : 0,
          archiveReason: String(item.archiveReason || ''),
          region: regionOf(item),
          tier: tierOfItem(item, meta),
          strength: Number(meta?.get(item.id)?.strength) || 0,
          cluster: state.layout?.clusters?.[item.id] || '',
          child: state.layout?.childOf?.[item.id] || '',
          brightness: Math.round(b * 1000) / 1000,
          S: Math.round(S * 10) / 10,
          hits: Number(star.hits) || 0,
          lastHit: last,
          nextReview,
          x: positions[item.id].x,
          y: positions[item.id].y,
          z: positions[item.id].z || 0,
        });
      }
      const live = items.filter((it) => !it.invalidAt && !it.archivedAt);
      const archivedItems = items.filter((it) => it.archivedAt);
      const outdated = items.filter((it) => it.invalidAt);
      // 回看时用快照亮度统计，和画布上看到的保持一致；没有快照的条目才回落到当前亮度。
      let bright = 0;
      let dim = 0;
      const tiers = { short: 0, long: 0, core: 0 };
      for (const item of live) {
        const b = snap?.[item.id] ?? retentionOf(item, meta, now);
        if (b >= 0.7) bright += 1;
        else if (b < FADING_THRESHOLD) dim += 1;
        tiers[tierOfItem(item, meta)] += 1;
      }
      return {
        ok: true,
        day: date || dayKey(now),
        snapshotted: Boolean(snap),
        layout: {
          version: state.layout?.version || 0,
          radius: state.layout?.radius || 470,
          groups,
        },
        edges: state.edges,
        stars,
        stats: {
          total: items.length,
          live: live.length,
          archived: archivedItems.length,
          outdated: outdated.length,
          bright,
          dim,
          clusters: groups.length,
          tiers,
          lastSync: state.lastSync,
        },
      };
    }

    function review(id) {
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      const items = itemsNow() || [];
      const item = items.find((it) => it.id === id);
      if (!item) return { ok: false, message: '这条记忆已经不在库里了' };
      if (item.invalidAt) return { ok: false, message: '这是已过时的记忆，不能靠复习把它变回有效' };
      if (item.archivedAt) return { ok: false, message: '这条已经归档，先恢复再复习' };
      const m = memory();
      const touched = typeof m?.touch === 'function' ? m.touch(id) : null;
      // 记忆模块支持三级曲线时，复习写回它；星图不再自己维护稳定性。
      if (touched?.ok) {
        const now = Date.now();
        const fresh = itemsNow() || [];
        const meta = memoryMeta(fresh);
        const target = fresh.find((it) => it.id === id) || item;
        const b = retentionOf(target, meta, now);
        snapshot(fresh, now, meta);
        save();
        try { sync(); } catch (error) { api.log.warn('复习后同步失败：' + error.message); }
        return {
          ok: true,
          message: `已确认还记得（${TIER_LABEL[touched.item?.tier] || '长期'}，清晰度 ${Math.round(b * 100)}%）`,
          brightness: Math.round(b * 1000) / 1000,
        };
      }
      if (touched && touched.ok === false) return touched;
      const star = state.stars[id] || starOf(item, Date.now());
      star.S = Math.min(180, (Number(star.S) || initialStability(item)) * 1.3);
      star.lastHit = Date.now();
      star.hits = (Number(star.hits) || 0) + 1;
      snapshot(items, star.lastHit, memoryMeta(items));
      save();
      // 复习后亮度会越过快忘阈值，立刻重排，让它从「快忘了」星团回到原星团。
      try { sync(); } catch (error) { api.log.warn('复习后同步失败：' + error.message); }
      return {
        ok: true,
        message: `已确认还记得，稳定性提高到 ${Math.round(star.S)} 天`,
        brightness: Math.round(brightnessOf(item, star.lastHit) * 1000) / 1000,
      };
    }

    function editStar(id, patch = {}) {
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      const m = memory();
      if (!m || typeof m.update !== 'function') return { ok: false, message: '记忆模块未启用' };
      const item = (itemsNow() || []).find((it) => it.id === id);
      if (!item) return { ok: false, message: '这条记忆已经不在库里了' };
      const next = {};
      if (patch.text !== undefined) {
        const text = String(patch.text || '').trim().slice(0, 200);
        if (!text) return { ok: false, message: '内容不能为空' };
        next.text = text;
      }
      if (patch.importance !== undefined) next.importance = clamp(patch.importance, 0, 1);
      if (!Object.keys(next).length) return { ok: false, message: '没有要改的内容' };
      let r;
      try { r = m.update(id, next); } catch (error) { return { ok: false, message: '修改失败：' + error.message }; }
      if (!r?.ok) return { ok: false, message: r?.message || '修改失败' };
      try { sync(); } catch (error) { api.log.warn('星图修改后同步失败：' + error.message); }
      return { ok: true, message: '已修改这条记忆' };
    }

    function removeStar(id) {
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      const m = memory();
      if (!m || typeof m.remove !== 'function') return { ok: false, message: '记忆模块未启用' };
      const item = (itemsNow() || []).find((it) => it.id === id);
      if (!item) return { ok: false, message: '这条记忆已经不在库里了' };
      let r;
      try { r = m.remove(id); } catch (error) { return { ok: false, message: '删除失败：' + error.message }; }
      if (!r?.ok) return { ok: false, message: r?.message || '删除失败' };
      try { sync(); } catch (error) { api.log.warn('星图删除后同步失败：' + error.message); }
      const text = String(item.text || '');
      const cut = text.length > 24 ? `${text.slice(0, 24)}…` : text;
      return { ok: true, message: cut ? `已删除「${cut}」` : '已删除这条记忆' };
    }

    function localSeeds(query, items) {
      const q = String(query || '').trim();
      if (!q) return [];
      return items
        .filter((it) => !it.invalidAt && !it.archivedAt)
        .map((it) => ({ it, score: similarity(q, it.text) }))
        .filter((hit) => hit.score >= 0.12)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    }

    function recallGraph(query, chat = {}) {
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      const m = memory();
      if (!m || typeof m.recall !== 'function') return { ok: false, message: '记忆模块未启用' };
      const q = String(query || '').trim().slice(0, 200);
      if (!q) return { ok: false, message: '要翻什么？给个关键词' };
      const now = Date.now();
      const items = itemsNow() || [];
      const meta = memoryMeta(items);
      const byId = new Map(items.map((it) => [it.id, it]));
      const names = profileNames();

      let usedBuiltin = false;
      let seeds = [];
      try {
        seeds = m.recall(q, { about: chat.userId, limit: 6, where: `${chat.chatId || ''}（星图）` })
          .filter((hit) => hit?.it && !hit.it.invalidAt && !hit.it.archivedAt)
          .map((hit) => ({ id: hit.it.id, score: Number(hit.score) || 0 }));
        usedBuiltin = seeds.length > 0;
      } catch {}
      if (!seeds.length) seeds = localSeeds(q, items).map((hit) => ({ id: hit.it.id, score: hit.score }));
      const seedIds = new Set(seeds.map((seed) => seed.id));

      const maxScore = Math.max(1e-6, ...seeds.map((s) => s.score));
      const adjacency = new Map();
      for (const edge of state.edges) {
        const listA = adjacency.get(edge.a) || [];
        const listB = adjacency.get(edge.b) || [];
        listA.push({ other: edge.b, weight: edge.weight, kind: edge.kind });
        listB.push({ other: edge.a, weight: edge.weight, kind: edge.kind });
        adjacency.set(edge.a, listA);
        adjacency.set(edge.b, listB);
      }

      const candidates = new Map();
      for (const seed of seeds) {
        const item = byId.get(seed.id);
        if (!item) continue;
        const base = seed.score / maxScore;
        candidates.set(seed.id, { item, base, seed: true });
        for (const link of adjacency.get(seed.id) || []) {
          if (!byId.has(link.other)) continue;
          const prev = candidates.get(link.other);
          const act = base * link.weight * 0.85;
          if (!prev || prev.base < act) candidates.set(link.other, { item: byId.get(link.other), base: act, seed: false });
        }
      }

      const ranked = [...candidates.values()]
        .filter((c) => !c.item.invalidAt && !c.item.archivedAt)
        .map((c) => ({ ...c, b: retentionOf(c.item, meta, now) }))
        .map((c) => ({ ...c, rank: c.base * (0.35 + 0.65 * c.b) * (0.8 + 0.4 * clamp(c.item.importance ?? 0.5, 0, 1)) }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, 4);

      if (!ranked.length) return { ok: true, message: '这次没在星图里找到相关的记忆。' };
      let relayout = false;
      for (const hit of ranked) {
        const star = state.stars[hit.item.id] || starOf(hit.item, now);
        star.S = Math.min(180, (Number(star.S) || initialStability(hit.item)) * 1.3);
        star.lastHit = now;
        star.hits = (Number(star.hits) || 0) + 1;
        // 只有内置 recall 真正命中的种子才会加 hits；顺藤摸瓜找到的邻居不要抬高水位，
        // 否则会把这条记忆之后一次真实的召回吞掉。
        if (usedBuiltin && seedIds.has(hit.item.id)) star.builtinHits = (Number(star.builtinHits) || 0) + 1;
        hit.b = retentionOf(hit.item, meta, now);
        // 回忆把快忘的星拉亮后，它不该继续留在「快忘了」星团里。
        if (!relayout && hit.b >= FADING_THRESHOLD && state.layout?.clusters?.[hit.item.id] === FADING_ID) relayout = true;
      }
      snapshot(items, now, meta);
      save();
      if (relayout) {
        try { sync(); } catch (error) { api.log.warn('回忆起记忆后同步失败：' + error.message); }
      }
      const lines = ranked.map((hit) => {
        const label = displayNameOf(hit.item.about, hit.item.aboutName || (hit.item.about ? names.get(hit.item.about) || '' : ''));
        const who = label ? `（关于 ${label}）` : '';
        const why = hit.seed ? '' : '，顺着关联想起';
        return `· [${brightnessLabel(hit.b)} ${(hit.b * 100).toFixed(0)}%]${who}${String(hit.item.text).slice(0, 180)}${why}`;
      });
      return { ok: true, message: `【记忆中枢】\n${lines.join('\n')}` };
    }

    api.tool(({ chat }) => {
      if (api.settings().enabled === false || api.settings().llmOn === false || !chat || chat.kind === 'system') return [];
      return [
        api.defineTool({
          name: 'constellation_recall',
          description: '在记忆中枢里翻记忆：想顺着某件事想起相关的人、约定或经历，或想知道某条记忆现在有多清晰时用。普通单条回忆用 recall_memory。',
          properties: { query: { type: 'string', description: '想翻的关键词或一句话' } },
          required: ['query'],
          execute: async ({ query }) => recallGraph(query, chat),
        }),
      ];
    });
    api.rule(() => {
      const s = api.settings();
      if (s.llmOn === false) return '';
      const base = '你可以用 constellation_recall 顺着一条记忆想起同一个人、同一件事的相关记忆，结果会带清晰度；两者都不是第二套记忆库，事实仍以内置记忆为准。';
      if (s.assocOn === false) return base;
      return `${base} 想不起某个称呼或某个人以前发生过什么时，用 recall_associated。结果里说「快忘了」的内容，回答时不要说得像刚发生过。`;
    });

    api.route('/graph', async (req) => {
      let body = {};
      try { body = (await api.core.http.body(req)) || {}; } catch {}
      return graph(body.day);
    });
    api.route('/review', async (req) => {
      let body = {};
      try { body = (await api.core.http.body(req)) || {}; } catch {}
      return review(String(body.id || ''));
    });
    api.route('/restore', async (req) => {
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      const m = memory();
      if (!m || typeof m.restore !== 'function') return { ok: false, message: '记忆模块未启用' };
      let body = {};
      try { body = (await api.core.http.body(req)) || {}; } catch {}
      const id = String(body.id || '');
      if (!id) return { ok: false, message: '缺少记忆 id' };
      let r;
      try { r = m.restore(id); } catch (error) { return { ok: false, message: '恢复失败：' + error.message }; }
      if (!r?.ok) return { ok: false, message: r?.message || '恢复失败' };
      try { sync(); } catch (error) { api.log.warn('恢复后同步失败：' + error.message); }
      return { ok: true, message: '已恢复这条记忆' };
    });
    api.route('/update', async (req) => {
      let body = {};
      try { body = (await api.core.http.body(req)) || {}; } catch {}
      return editStar(String(body.id || ''), body.patch && typeof body.patch === 'object' ? body.patch : {});
    });
    api.route('/remove', async (req) => {
      let body = {};
      try { body = (await api.core.http.body(req)) || {}; } catch {}
      return removeStar(String(body.id || ''));
    });
    api.route('/add', async (req) => {
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      let body = {};
      try { body = (await api.core.http.body(req)) || {}; } catch {}
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text) return { ok: false, message: '内容不能为空' };
      const tier = ['short', 'long', 'core'].includes(String(body.tier)) ? String(body.tier) : 'long';
      const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
      const m = memory();
      if (!m || typeof m.add !== 'function') return { ok: false, message: '记忆模块不支持新增' };
      // 不带 about → regionOf 归到知识区，符合「关于谁默认不填」。
      const r = m.add({
        text,
        importance: clamp(body.importance ?? 0.5, 0, 1),
        tags,
        source: 'panel',
        tier,
      });
      if (!r?.ok) return r || { ok: false, message: '新增失败' };
      try { sync(); } catch (error) { api.log.warn('新增后同步失败：' + error.message); }
      return {
        ok: true,
        message: r.updated ? '已更新一条相似的记忆' : `已新增到${TIER_LABEL[tier] || '长期'}记忆`,
        id: r.id || r.updated || '',
      };
    });
    api.route('/tier', async (req) => {
      if (api.settings().enabled === false) return { ok: false, message: '记忆中枢已关闭' };
      let body = {};
      try { body = (await api.core.http.body(req)) || {}; } catch {}
      const m = memory();
      if (!m || typeof m.setTier !== 'function') return { ok: false, message: '记忆模块不支持手动分层' };
      const r = m.setTier(String(body.id || ''), String(body.tier || ''));
      if (!r?.ok) return r || { ok: false, message: '改不了这条的层级' };
      try { sync(); } catch (error) { api.log.warn('分层后同步失败：' + error.message); }
      return { ok: true, message: `已改为${TIER_LABEL[String(body.tier)] || '长期'}记忆` };
    });
    api.route('/sync', async () => sync());
    api.route('/optimize', async () => {
      const r = sync({ settle: 1 });
      if (!r.ok) return r;
      return { ...r, message: r.moved > 2 ? `已优化星团位置，最大移动 ${r.moved}` : '星团位置已经是最优的' };
    });
    api.route('/state', async () => ({
      ok: true,
      lastSync: state.lastSync,
      total: Object.keys(state.stars).length,
      edges: state.edges.length,
      enabled: api.settings().enabled !== false,
    }));

    // 每日读写合并进记忆中枢：读取 → 提炼 → 写入 → 巩固 → 归档 → 清理。
    const pipeline = createPipeline(api, {
      memory,
      mode: currentTokenMode,
      onChanged: () => {
        try { sync(); } catch (error) { api.log.warn('读写后同步失败：' + error.message); }
      },
    });

    applyRecallTakeover();
    api.later(2000, applyRecallTakeover);
    api.every(60_000, applyRecallTakeover, '同步自动回忆接管');
    api.later(3000, () => { try { sync(); } catch (error) { api.log.warn('星图首次同步失败：' + error.message); } });
    api.every(10 * 60_000, () => sync(), '星图同步');

    return { version: '0.9.1', sync, graph, review, recall: recallGraph, scanActive: () => pipeline.scanActive() };
  },
};
