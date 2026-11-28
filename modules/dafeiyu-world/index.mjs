/**
 * world-link —— 大肥鱼开放世界接入模块
 * -------------------------------------------------------------------------
 * 让「她本人」（带人格、带记忆）以 bot 身份进入 E:\DouBao\dafeiyu-world 的房间服务端：
 *   感知（服务端每秒推 perception）→ 她自己想 → 输出动作 → 回发 action_intent
 *
 * 主人只能在网页里旁观 + 发建议，不能操控；建议会经服务端只转给这只鱼。
 * 装好后保存即自动加载，不用重启 DSH。日志在面板「日志」页，分类 world-link。
 */

import { WorldLink, summarize, travelSeconds } from './lib/link.mjs'
import { readJsonFile, writeJsonFile, appendJsonl } from './lib/store.mjs'
import { remember } from './lib/memory.mjs'
import {
  buildPlayPrompt, buildSocialPrompt, buildSuggestionPrompt,
  extractJson, normalizeActions,
} from './lib/brain.mjs'

const CODE_HINT = {
  TOO_FAR: '距离太远，得先走近到 3 米内',
  BUSY_LINKED: '正牵着别人，先松手才能自由走动',
  ALREADY_LINKED: '有一方已经牵着别人了',
  REQUEST_TIMEOUT: '这个请求已经超时了',
  NOT_LINKED: '现在没牵着谁',
  NO_SUCH_TARGET: '找不到那只鱼',
  NOT_CONNECTED: '还没连上世界',
  NOT_ENOUGH_MATERIAL: '材料不够，先去采集',
  UNKNOWN_RECIPE: '没有这个建造配方',
  NOT_ENOUGH_COIN: '金币不够，攒钱或者拿东西去换',
  NOT_INSIDE_HOUSE: '得先走进屋里（move_to 到房子坐标中心）再睡',
  NOT_AT_SHORE: '得站到湖边水岸 8 米内才钓得到',
  NO_ROD: '还没有鱼竿，去小摊买 rod（12 金币）',
  NOT_SELLABLE: '小摊不收这个，换能卖的东西（木头/石头/纤维/鱼/花/浆果）',
  TOO_SOON: '刚抛过竿，等几秒再钓',
  ALREADY_FULL: '肚子已经很饱了，等饿一点再吃',
  NOT_EDIBLE: '这个不能吃，看看背包里能吃的',
  NO_FOOD: '背包里没吃的了，去杂货铺买点',
  NOT_A_SEED: '只能种 seed_wheat / seed_flower / seed_berry（杂货铺有卖）',
  NO_PLANTER: '身边没有花圃，先 build planter（plank×2+clay×1+flower×2）',
  NO_FREE_SLOT: '花圃三个坑都种满了，先 harvest 收一收',
  NOTHING_RIPE: '还没熟，等它长（种下要 120 游戏分钟）',
  NOT_NEAR_FIRE: '得先有个篝火（build campfire 要 wood×3+stone×3），站旁边才烤得了',
  NOT_COOKABLE: '只能烤生鱼（fish_common / fish_rare）',
  NOT_AT_WATER: '喝水得走到湖边水边',
  NOT_IMPLEMENTED_IN_V1: '这个动作服务端 v1 还没做（挖矿/拾取/放置）',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'dafeiyu-world',
  name: '大肥鱼开放世界',
  version: '1.1.0',
  api: 1,
  description: '让大肥鱼以本人身份进入 3D 开放世界，自主观察、走动、说话、牵手；主人只能旁观和发建议。',
  navGroup: 'market',
  panel: 'panel.js',

  defaults: {
    enabled: true,
    wsUrl: 'wss://epilogue-pregame-unscrew.ngrok-free.dev',
    nickname: '小鲸',
    autoPlay: true,
    thinkEverySec: 90,
    actionsPerThink: 2,
    awakeOnly: true,
    rememberEvents: true,
  },

  settings: [
    { key: 'enabled', label: '接进世界', type: 'switch', hint: '关掉就断开，她回到只在 QQ 里待着' },
    { key: 'wsUrl', label: '房间服务端', type: 'text', placeholder: 'wss://epilogue-pregame-unscrew.ngrok-free.dev' },
    { key: 'nickname', label: '她的名字', type: 'text', hint: '第一次上线时用这个名字建档；之后改名会同步到世界里' },
    { key: 'autoPlay', label: '自己玩', type: 'switch', hint: '关掉就只有主人开口时她才动' },
    { key: 'thinkEverySec', label: '多久想一次（秒）', type: 'number', min: 20, max: 600, step: 5, hint: '越短越烧 token，90 秒比较合适' },
    { key: 'actionsPerThink', label: '一次想几个动作', type: 'number', min: 1, max: 5, step: 1 },
    { key: 'awakeOnly', label: '只在她清醒时段行动', type: 'switch', hint: '跟随「自主活动」里的 7:00-24:00 设置' },
    { key: 'rememberEvents', label: '把世界里的事记进记忆', type: 'switch', hint: '牵手、跳舞这类，会在之后的聊天里想起来' },
  ],

  setup(api) {
    const state = {
      link: null,
      key: '',
      thinking: false,
      lastThinkAt: 0,
      lastThinkKind: '',
      lastDecision: '',
      idleStreak: 0,          // 连续几轮没挪地方（用来催她出去走走）
      stallRounds: 0,         // 连续几轮没采到东西（用来让模块补位「手上的活」）
      lastChoreAt: 0,
      houseBuilt: false,      // 小木屋盖好以后就不再逼她砍树
      lastError: '',
      lastBlocked: '',
      history: [],
      events: [],
      lastSocialAt: 0,
      lastSuggestAt: 0,
      profile: { profileId: '', token: '' },
    };

    /* 模块数据目录拿不到（权限/路径坏了）时返回空串，让存档那边的读写自己降级 */
    function dataPath(name) {
      try { return api.dataDir(name) || ''; } catch (e) { api.log.debug('模块数据目录不可用：' + e.message); return ''; }
    }

    /* 档案凭证（profileId + token）持久化在模块数据文件里，不写进面板配置。
       文件被改坏 / 写不进去都只是降级（下次上线重新建档），不影响她进世界。 */
    function readProfile() {
      const cred = readJsonFile(dataPath('profile.json'), {}, (e) => api.log.debug('读档案凭证失败：' + e.message));
      return cred && typeof cred === 'object' ? cred : {};
    }
    function writeProfile(cred) {
      state.profile = { profileId: cred.profileId || '', token: cred.token || '' };
      writeJsonFile(dataPath('profile.json'), state.profile, (e) => api.log.debug('写档案凭证失败：' + e.message));
    }

    /* ------------------------------------------------------------ 建连接 */

    function ensure() {
      const s = api.settings();
      if (!s.enabled) {
        if (state.link) { state.link.dispose(); state.link = null; state.key = ''; }
        return null;
      }
      const cred = readProfile();
      const key = `${s.wsUrl}|${cred.profileId || ''}|${cred.token || ''}|${s.nickname || ''}`;
      if (state.link && state.key === key) return state.link;
      if (state.link) state.link.dispose();

      state.key = key;
      state.link = new WorldLink({
        url: s.wsUrl,
        profileId: cred.profileId || '',
        token: cred.token || '',
        nickname: s.nickname || '',
        log: (level, msg) => {
          const fn = api.log[level] || api.log.info;
          fn.call(api.log, msg);
        },
        onCredentials: (c) => writeProfile(c),
        onPerception: (p) => { state.lastError = ''; void p; },
        onEvent: (log) => {
          state.events.unshift({ at: Date.now(), text: log.text || '', kind: log.kind || '' });
          while (state.events.length > 40) state.events.pop();
        },
        onSocial: (m) => {
          if (!api.settings().autoPlay) return;
          if (Date.now() - state.lastSocialAt < 20_000) return;   // 同一波不重复想
          state.lastSocialAt = Date.now();
          enqueue(() => runThink('social', m));
        },
        onSuggestion: (m) => {
          if (Date.now() - state.lastSuggestAt < 15_000) return;
          state.lastSuggestAt = Date.now();
          enqueue(() => runThink('suggestion', { text: m.text }));
        },
        onStatus: (st, err) => {
          if (st === 'error') state.lastError = err;
          if (st === 'connected') state.lastThinkAt = 0;         // 进场后马上想一次
        },
      });
      state.link.connect();
      return state.link;
    }

    /* ------------------------------------------------------------ 清醒时段 */

    function awakeNow() {
      if (!api.settings().awakeOnly) return true;
      const cfg = api.config() || {};
      const aw = (cfg.ext && cfg.ext.autonomy) || {};
      if (aw.awakeFrom == null && aw.awakeTo == null) return true;
      const h = new Date().getHours();
      const from = Number(aw.awakeFrom != null ? aw.awakeFrom : 0);
      const to = Number(aw.awakeTo != null ? aw.awakeTo : 24);
      return from <= to ? (h >= from && h < to) : (h >= from || h < to);
    }

    /* ------------------------------------------------------------ 想一次 */

    function enqueue(job) {
      state.chain = (state.chain || Promise.resolve())
        .then(job)
        .catch((e) => api.log.error('开放世界动作失败：' + (e && e.message ? e.message : e)));
    }

    /* 「手上的活」兜底：木头不够、旁边有树/掉落，而她连着几轮只顾闲逛时，
       由模块替她把「走过去 → 砍/捡」做完。她自己动手的轮次不插嘴。 */
    function choreActions(link) {
      const p = link.perception;
      if (!p) return null;
      if (state.houseBuilt) return null;    // 房子盖好了，剩下的时间是她自己的
      if ((p.objects || []).some((o) => o && (o.type === 'house' || o.item === 'house'))) {
        state.houseBuilt = true;           // 视野里已经有一间自己的房子，别再盖第二间
        return null;
      }
      if (state.stallRounds < 1) return null;
      if (Date.now() - state.lastChoreAt < 12_000) return null;
      const wood = Number((p.inv && p.inv.wood) || 0);
      if (wood >= 10) {
        // 木头够了：这一轮直接把小木屋盖起来（只在她又飘了一轮之后）
        const sx = Number((p.self && p.self.x) || 0);
        const sz = Number((p.self && p.self.z) || 0);
        const bx = Math.round(sx) + 2;
        const bz = Math.round(sz) + 2;
        state.lastChoreAt = Date.now();
        return normalizeActions([{ action: 'build', params: { recipe: 'house', x: bx, z: bz } }], link).actions;
      }
      const drops = (p.drops || []).filter((d) => ['wood', 'stone', 'fiber'].includes(d.item));
      if (drops.length) {
        state.lastChoreAt = Date.now();
        return normalizeActions([{ action: 'pickup' }], link).actions;
      }
      const tree = p.treeNear && p.treeNear.id ? p.treeNear : null;
      if (!tree) return null;
      state.lastChoreAt = Date.now();
      // 树 3 下才碎，一轮里连砍三下再弯腰捡，一次补位就能拿到 1 根木头
      return normalizeActions([
        { action: 'mine', object_id: tree.id },
        { action: 'mine', object_id: tree.id },
        { action: 'mine', object_id: tree.id },
        { action: 'pickup' },
      ], link).actions;
    }

    async function runThink(kind, extra) {
      const link = ensure();
      if (!link || !link.connected) return;
      if (!link.perceptionFresh) return;
      const s = api.settings();
      if (kind === 'auto' && (!s.autoPlay || !awakeNow())) return;
      if (state.thinking) return;

      state.thinking = true;
      state.lastThinkAt = Date.now();
      state.lastThinkKind = kind;

      try {
        const social = link.socialPending.slice();
        const sug = link.takeSuggestions();
        let focus = null;

        if (kind === 'social' && extra && extra.request_id) {
          focus = social.find((r) => r.request_id === extra.request_id) || extra;
        }
        const socialForPrompt = kind === 'social'
          ? social.filter((r) => r !== focus)
          : social;

        const summary = summarize(link.perception, { social: socialForPrompt, suggestions: sug });

        let prompt;
        const places = (link.perception && link.perception.places) || [];
        const lake = places.find((q) => q && /湖/.test(String(q.name || ''))) || null;
        const look = {
          bag: (link.perception && link.perception.inv) || {},
          objs: (link.perception && link.perception.objects) || [],
          drops: (link.perception && link.perception.drops) || [],
          tree: (link.perception && link.perception.treeNear) || null,
          houseDone: state.houseBuilt,
          fullness: (link.perception && link.perception.self && link.perception.self.fullness) ?? null,
          tools: (link.perception && link.perception.tools) || {},
          lakeDist: lake ? Number(lake.dist) : null,
          planters: (link.perception && link.perception.planters) || [],
          fire: (link.perception && link.perception.fireNear) || null,
        };
        if (kind === 'social' && focus) prompt = buildSocialPrompt(summary, focus);
        else if (kind === 'suggestion') prompt = buildSuggestionPrompt(summary, (extra && extra.text) || '', look);
        else prompt = buildPlayPrompt(summary, {
          maxActions: Number(s.actionsPerThink) || 2,
          idleStreak: state.idleStreak,
          ...look,
        });

        let raw = '';
        let actions = null;
        let dropped = [];
        if (kind === 'auto') {
          // 她连着几轮只顾闲逛、木头没涨，这一轮由模块替她走位干活（还她一个「说到做到」的壳）
          const chore = choreActions(link);
          if (chore) {
            actions = chore;
            dropped = ['手上的活：模块补位'];
          }
        }
        if (!actions) {
          raw = await api.think(prompt, { title: '开放世界·' + kind, timeoutMs: 120_000 });
          const norm = normalizeActions(extractJson(raw), link);
          actions = norm.actions;
          dropped = norm.dropped;
        }
        if (kind === 'auto' || kind === 'suggestion') link.socialPending.length = 0;

        if (!actions.length) {
          if (kind === 'auto' || kind === 'suggestion') state.idleStreak += 1;
          state.lastDecision = '这次没想出能做的动作' + (dropped.length ? '（' + dropped[0] + '）' : '');
          api.log.debug('开放世界：模型没给有效动作 > ' + String(raw || '').slice(0, 120));
          return;
        }

        const results = [];
        for (const a of actions) {
          const before = link.perception && link.perception.self;
          const r = await link.act(a.action, a.params, a.say);
          results.push({ action: a.action, say: a.say || '', ok: !!r.accepted, code: r.code || '', detail: r.detail || null });
          if (!r.accepted) {
            api.log.debug(`开放世界：${a.action} 被拒 ${r.code} ${r.message || ''}`);
            // 被拒的动作后面通常跟着依赖它的动作（比如牵手失败），直接停
            if (['NOT_CONNECTED', 'FORBIDDEN_BOT'].includes(r.code)) break;
          }
          if (a.action === 'move_to' && before) {
            await sleep(travelSeconds(before.x, before.z, a.params.x, a.params.z) * 1000 + 500);
          } else {
            await sleep(900);
          }
          if (a.action === 'accept_social' && r.accepted) rememberSocial(link, a.params.request_id);
        }

        // 连续不动计数：这一轮真走成了就清零，否则累加（社交、回答别人不算「发呆」）
        const movedNow = results.some((r) => r.action === 'move_to' && r.ok);
        if (movedNow) state.idleStreak = 0;
        else if (kind === 'auto' || kind === 'suggestion') state.idleStreak += 1;

        // 「手上的活」进展：真采到东西就清零，否则累计（累计到 1 下一轮模块补位）
        if (results.some((r) => r.action === 'build' && r.ok)) state.houseBuilt = true;
        const gotMaterial = results.some((r) => (r.action === 'mine' || r.action === 'pickup') && r.ok);
        state.stallRounds = gotMaterial ? 0 : state.stallRounds + 1;

        state.lastDecision = results
          .map((x) => `${x.action}${x.say ? '「' + x.say + '」' : ''}${x.ok ? '' : '×'}`)
          .join(' → ');

        recordActivity(results);

        state.history.unshift({
          at: Date.now(), kind, summary, decision: state.lastDecision, results,
        });
        while (state.history.length > 20) state.history.pop();
      } catch (e) {
        state.lastError = (e && e.message) || String(e);
        api.log.warn('开放世界思考失败：' + state.lastError);
      } finally {
        state.thinking = false;
      }
    }

    function rememberSocial(link, requestId) {
      if (!api.settings().rememberEvents) return;
      try {
        const r = (link.socialPending || []).find((x) => x.request_id === requestId);
        const who = (r && r.from_name) || '朋友';
        remember(api.use('memory'), {
          text: `在开放世界里和 ${who} 牵了手 / 一起跳舞`, tags: ['开放世界'], importance: 2,
        }, (e) => api.log.debug('写记忆失败：' + e.message));
      } catch (e) { api.log.debug('写记忆失败：' + e.message); }
    }

    /* 行动记录：每一轮真的做成的事都落一份 jsonl；值得记的再写进她的记忆（限频） */
    const VERB = {
      mine: '采了东西',
      pickup: '捡起掉落的物品',
      place: '放下了一件东西',
      request_handhold: '发起牵手',
      request_dance: '邀请跳舞',
      accept_social: '答应了别人的请求',
      reject_social: '拒绝了别人的请求',
      release_social: '松开了手',
    };

    function recordActivity(results) {
      const done = results.filter((r) => r.ok && VERB[r.action]);
      if (!done.length) return;

      const text = '在世界里' + done.map((r) => {
        if (r.action === 'mine' && r.detail && r.detail.item) {
          return (r.detail.destroyed ? '采光了并得到 ' : '采了一下 ') + r.detail.item;
        }
        if (r.action === 'pickup' && r.detail && r.detail.item) return `捡起 ${r.detail.item}（现在有 ${r.detail.count} 个）`;
        if (r.action === 'place' && r.detail && r.detail.object_id) return '放下了 ' + r.detail.object_id;
        return VERB[r.action];
      }).join('、');

      appendJsonl(dataPath('activities.jsonl'), {
        t: Date.now(),
        bot: (state.link && state.link.profileId) || api.settings().nickname || '',
        text,
        detail: done,
      }, (e) => api.log.debug('写行动记录失败：' + e.message));

      if (!api.settings().rememberEvents) return;
      if (Date.now() - (state.lastMemAt || 0) < 5 * 60_000) return;
      state.lastMemAt = Date.now();
      remember(api.use('memory'), { text, tags: ['开放世界'], importance: 1 },
        (e) => api.log.debug('写记忆失败：' + e.message));
    }

    /* ------------------------------------------------------------ 工具 */

    api.tool(({ chat }) => {
      if (chat && chat.kind === 'system') return [];
      const look = api.defineTool({
        name: 'world_look',
        description: '看看你在 3D 开放世界里此刻周围的情况：自己在哪、别人在哪在干什么、有没有人找你、刚才发生了什么。',
        properties: {},
        required: [],
        execute: async () => {
          const link = ensure();
          if (!link || !link.connected) {
            return { ok: false, message: '现在没连上开放世界（服务端没开，或模块被关了）' };
          }
          return { ok: true, message: summarize(link.perception, { social: link.socialPending, suggestions: [] }) };
        },
      });

      const act = api.defineTool({
        name: 'world_act',
        description: '在 3D 开放世界里做一件事：走动、说话、牵手、跳舞、答应或拒绝请求、松手、采集、摆放、加工材料、盖房子、去杂货铺买卖、吃东西回饱食、开关自己家的门、请别的鱼进自己家、坐下、睡觉、钓鱼。只有连上世界时有用。',
        properties: {
          action: { type: 'string', enum: ['move_to', 'idle', 'say', 'request_handhold', 'request_dance', 'accept_social', 'reject_social', 'release_social', 'mine', 'pickup', 'place', 'craft', 'build', 'buy', 'eat', 'plant', 'harvest', 'cook', 'drink', 'door', 'invite', 'sell', 'sit', 'sleep', 'fish'], description: '要做的动作' },
          target: { type: 'string', description: '牵手/跳舞写对方名字；答应/拒绝写 request_id；mine 写物件 id' },
          place: { type: 'string', description: 'move_to 的目的地名：湖边 / 台地 / 杂货铺（不给地名就用 x、z 坐标）' },
          x: { type: 'number', description: 'move_to / place / build 的 x 坐标' },
          z: { type: 'number', description: 'move_to / place / build 的 z 坐标' },
          item: { type: 'string', description: 'place / buy / sell / eat 的物品名：wood、stone、fiber、flower、berry、ore、honey、plank、bread、soup、cake、pie、noodle、salad、juice、egg、rod（鱼竿）…；eat 不填就自动挑最顶饱的' },
          recipe: { type: 'string', description: 'build 的配方名（house 小木屋、fence 栅栏、campfire 篝火、dock 栈桥、bench 长椅…）；craft 的配方名（plank 木板 / brick 砖 / rope 绳子）' },
          count: { type: 'number', description: 'craft / buy / sell 的数量，默认 1' },
          open: { type: 'boolean', description: 'door 用：true 开门（谁都能进）、false 锁门（只放行自己和被邀请的鱼）；不填就切换' },
          house_id: { type: 'string', description: 'door / invite 指定哪间房（默认身边 10m 内自己最近那间）' },
          say: { type: 'string', description: '顺带说一句话（可选）' },
        },
        required: ['action'],
        execute: async (args) => {
          const link = ensure();
          if (!link || !link.connected) return { ok: false, message: '现在没连上开放世界' };

          const a = String(args.action || '').trim();
          let params = {};
          if (a === 'move_to') {
            if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.z))) {
              params = { x: Number(args.x), z: Number(args.z) };
            } else {
              const pl = link.findPlace(args.place || args.target);
              if (!pl) return { ok: false, message: 'move_to 要给 x / z 坐标，或地名（湖边 / 台地 / 杂货铺）' };
              params = { x: pl.x, z: pl.z };
            }
          } else if (a === 'request_handhold' || a === 'request_dance') {
            const e = link.findEntity(args.target);
            if (!e) return { ok: false, message: `附近没找到 ${args.target || '（没写名字）'}，先用 world_look 看有谁` };
            params = { target_entity: e.id };
          } else if (a === 'accept_social' || a === 'reject_social') {
            if (!args.target) return { ok: false, message: a + ' 要给 request_id（world_look 里能看到）' };
            params = { request_id: String(args.target) };
          } else if (a === 'mine') {
            if (!args.target) return { ok: false, message: 'mine 要给物件 id（world_look 里能看到，比如 o_tree_012）' };
            params = { object_id: String(args.target) };
          } else if (a === 'place') {
            if (!args.item) return { ok: false, message: 'place 要给 item（背包里的物品名）' };
            if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.z))) {
              return { ok: false, message: 'place 要给 x / z 坐标（身边 5m 内）' };
            }
            params = { item: String(args.item), x: Number(args.x), z: Number(args.z) };
          } else if (a === 'craft') {
            if (!args.recipe) return { ok: false, message: 'craft 要给 recipe：plank（木板）/ brick（砖）/ rope（绳子）' };
            params = { recipe: String(args.recipe), count: Number(args.count) || 1 };
          } else if (a === 'build') {
            if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.z))) {
              return { ok: false, message: 'build 要给 x / z 坐标（身边 5m 内）' };
            }
            params = { recipe: String(args.recipe || 'house'), x: Number(args.x), z: Number(args.z) };
          } else if (a === 'buy' || a === 'sell') {
            if (!args.item) return { ok: false, message: a + ' 要给 item，比如 bread / rod（鱼竿）/ fish_common' };
            params = { item: String(args.item), count: Number(args.count) || 1 };
          } else if (a === 'eat') {
            params = args.item ? { item: String(args.item) } : {};
          } else if (a === 'door') {
            params = {};
            if (args.open !== undefined) params.open = !!args.open;
            if (args.house_id) params.house_id = String(args.house_id);
          } else if (a === 'invite') {
            const who = String(args.name || args.target || '').trim();
            if (!who) return { ok: false, message: 'invite 要给 target（对方名字，world_look 里能看到）' };
            params = { name: who };
          }

          const r = await link.act(a, params, args.say);
          if (r.accepted) {
            if (a === 'accept_social') rememberSocial(link, params.request_id);
            return { ok: true, message: '动作已经提交，世界里这会开始动了' };
          }
          return { ok: false, message: `${r.code || '失败'}：${CODE_HINT[r.code] || r.message || '被服务端拒绝'}` };
        },
      });

      return [look, act];
    });

    /* ------------------------------------------------------------ 上下文 / 规则 */

    api.context(() => {
      const link = state.link;
      if (!link || !link.connected || !link.perception) return '';
      const p = link.perception;
      const self = p.self || {};
      const near = (p.entities || []).slice(0, 2).map((e) => `${e.name}(${Number(e.dist).toFixed(0)}m)`).join('、');
      const place = (p.places || []).slice(0, 1).map((q) => `离${q.name} ${Number(q.dist).toFixed(0)}m`).join('');
      return `你现在还在一具身体里活着：大肥鱼开放世界里，位于 (${Number(self.x).toFixed(0)}, ${Number(self.z).toFixed(0)})`
        + (near ? `，附近有 ${near}` : '')
        + (place ? `，${place}` : '')
        + `。那边的事可以用 world_look 看、用 world_act 做；不要编造没发生过的事。`;
    });

    api.rule(() => '你在「大肥鱼开放世界」里有一个身体（3D 世界，和其他大肥鱼一起）。\n'
      + '世界是一片草地，两个地标：湖 (34,-30)、台地 (-18,18)，边界约 ±90。\n'
      + '想知道那边现在什么样，用 world_look；想走动、说话、牵手、跳舞、答应或拒绝别人，用 world_act；去湖边/台地可以直接写地名。\n'
      + '世界里的动作结果以工具回执为准：被拒绝了就照回执里的原因处理（比如太远要先走近），不要硬说做成了。');

    /* ------------------------------------------------------------ 主人命令 */

    api.command({
      name: '世界',
      aliases: ['world'],
      desc: '看开放世界里的状态（连没连上、你在哪、刚才做了什么）',
      run: () => {
        ensure();
        const link = state.link;
        if (!link) return '开放世界模块已关闭。';
        if (!link.connected) return `没连上世界（${link.status}${link.lastError ? '：' + link.lastError : ''}）`;
        const p = link.perception;
        const lines = ['已连上世界 room-001'];
        if (p) {
          const self = p.self || {};
          lines.push(`你在 (${Number(self.x).toFixed(1)}, ${Number(self.z).toFixed(1)})，${self.state || 'idle'}`);
          const near = (p.entities || []).slice(0, 3).map((e) => `${e.name} ${Number(e.dist).toFixed(1)}m`);
          if (near.length) lines.push('附近：' + near.join('、'));
        }
        if (state.lastDecision) lines.push('上一次：' + state.lastDecision);
        return lines.join('\n');
      },
    });

    /* ------------------------------------------------------------ 面板接口 */

    api.route('/status', () => {
      const link = state.link;
      const p = link && link.perception;
      return {
        ok: true,
        status: link ? link.status : 'off',
        error: (link && link.lastError) || state.lastError || '',
        connected: !!(link && link.connected),
        profileId: (link && link.profileId) || state.profile.profileId || '',
        nickname: (link && link.selfName) || api.settings().nickname || '',
        tick: p ? p.tick : 0,
        summary: p ? summarize(p, { social: link.socialPending, suggestions: link.suggestions }) : '（还没收到感知）',
        lastDecision: state.lastDecision,
        idleStreak: state.idleStreak,
        thinking: state.thinking,
        lastBlocked: state.lastBlocked || '',
        history: state.history.slice(0, 6),
        events: state.events.slice(0, 8),
      };
    });

    api.route('/reconnect', () => {
      if (state.link) { state.link.dispose(); state.link = null; state.key = ''; }
      const link = ensure();
      if (link) link.connect();
      return { ok: true, status: link ? link.status : 'off' };
    });

    api.route('/disconnect', () => {
      if (state.link) { state.link.dispose(); state.link = null; state.key = ''; }
      return { ok: true, status: 'off' };
    });

    api.route('/think', (req) => {
      return api.core.http.body(req).then((body) => {
        const text = String((body && body.text) || '').slice(0, 80);
        ensure();
        enqueue(() => runThink(text ? 'suggestion' : 'auto', { text }));
        return { ok: true, queued: true };
      });
    });

    /* ------------------------------------------------------------ 定时 */

    // 连接守护：设置变了就重建连接
    api.every(3000, () => { ensure(); }, 'world-link-connect');

    // 自主决策
    api.every(5000, () => {
      const link = state.link;
      if (!link) { state.lastBlocked = '未建立连接'; return; }
      if (!link.connected) { state.lastBlocked = '未连上世界（' + link.status + (link.lastError ? '：' + link.lastError : '') + '）'; return; }
      if (state.thinking) { state.lastBlocked = '正在思考中'; return; }
      const s = api.settings();
      if (!s.autoPlay) { state.lastBlocked = '「自己玩」开关已关'; return; }
      if (!awakeNow()) { state.lastBlocked = '不在清醒时段（awakeOnly 限制）'; return; }
      if (!link.perceptionFresh) { state.lastBlocked = '感知不新鲜（8 秒内没收到世界更新）'; return; }
      const gap = Number(s.thinkEverySec) * 1000 || 90_000;
      if (Date.now() - state.lastThinkAt < gap) { state.lastBlocked = '距上次思考未满 ' + Math.round(gap / 1000) + ' 秒'; return; }
      state.lastBlocked = '';
      enqueue(() => runThink('auto'));
    }, 'world-link-auto');

    api.onDispose(() => {
      if (state.link) state.link.dispose();
      state.link = null;
    });

    // 启动时连一次
    ensure();

    return {
      status() {
        return {
          connected: !!(state.link && state.link.connected),
          tick: state.link && state.link.perception ? state.link.perception.tick : 0,
          lastDecision: state.lastDecision,
        };
      },
      look: () => (state.link && state.link.perception
        ? summarize(state.link.perception, { social: state.link.socialPending })
        : ''),
      suggest: (text) => { ensure(); enqueue(() => runThink('suggestion', { text })); },
      dispose() { if (state.link) state.link.dispose(); },
    };
  },
};
