/**
 * world-link / lib/link.mjs
 * 纯逻辑层：连「大肥鱼开放世界」房间服务端、收感知、发动作。
 * 不依赖 Aurabot 的 api，方便单独测试（见 README 的「离线自测」）。
 */

const RECONNECT_MIN = 3000;
const RECONNECT_MAX = 30000;
const INTENT_TIMEOUT = 5000;

export const ACTION_LIST = [
  'move_to', 'idle', 'say',
  'request_handhold', 'request_dance',
  'accept_social', 'reject_social', 'release_social',
  'mine', 'pickup', 'place', 'craft', 'build', 'buy', 'eat', 'sell', 'plant', 'harvest', 'cook', 'drink', 'door', 'invite', 'sit', 'sleep', 'fish',
];

export class WorldLink {
  constructor(opts) {
    this.url = (opts.url || 'ws://127.0.0.1:26048').trim();
    // 动态档案身份：profileId + token 由服务端签发后存回；nickname 只在新建档时用
    this.profileId = (opts.profileId || opts.botId || '').trim();
    this.token = (opts.token || '').trim();
    this.nickname = (opts.nickname || '').trim();
    this.selfName = this.nickname || '';
    this.onCredentials = opts.onCredentials || (() => {});
    this.log = opts.log || (() => {});

    this.onPerception = opts.onPerception || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onSocial = opts.onSocial || (() => {});
    this.onSuggestion = opts.onSuggestion || (() => {});
    this.onStatus = opts.onStatus || (() => {});

    this.status = 'idle';           // idle | connecting | connected | disconnected | error
    this.lastError = '';
    this.ws = null;
    this.perception = null;         // 最近一次感知
    this.perceptionAt = 0;
    this.hello = null;

    this.socialPending = [];        // 未回应的社交请求
    this.suggestions = [];          // 主人给的建议（未处理）
    this.pendingIntents = new Map();

    this._closedByUser = false;
    this._reconnectTimer = null;
    this._delay = RECONNECT_MIN;
    this._intentSeq = 0;
  }

  setStatus(s, err) {
    this.status = s;
    this.lastError = err || '';
    this.onStatus(s, err || '');
  }

  connect() {
    if (!globalThis.WebSocket) {
      this.setStatus('error', '当前运行环境没有 WebSocket（需要 Node 22 以上）');
      return;
    }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    this._closedByUser = false;
    clearTimeout(this._reconnectTimer);
    this.setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setStatus('error', '连接地址不对：' + e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._delay = RECONNECT_MIN;
      const payload = { type: 'hello', role: 'bot' };
      if (this.profileId) {
        payload.profile_id = this.profileId;
        payload.token = this.token;
      }
      if (this.nickname) payload.nickname = this.nickname;
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
      catch (e) { return; }
      this._handle(m);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this._closedByUser) { this.setStatus('idle'); return; }
      this.setStatus('disconnected');
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // 具体原因由 onclose 统一处理，这里只记一笔
      this.log('warn', '世界连接出错（' + this.url + '）');
    };
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    if (this._closedByUser) return;
    const wait = this._delay;
    this._delay = Math.min(RECONNECT_MAX, Math.round(this._delay * 1.6));
    this.log('info', `${Math.round(wait / 1000)} 秒后重连世界（${this.url}）`);
    this._reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  disconnect() {
    this._closedByUser = true;
    clearTimeout(this._reconnectTimer);
    try { this.ws && this.ws.close(); } catch (e) { /* ignore */ }
    this.ws = null;
    this.perception = null;
    this.setStatus('idle');
  }

  get connected() {
    return this.status === 'connected' && !!this.ws && this.ws.readyState === 1;
  }

  /** 感知是否新鲜（超过 8 秒没更新就不要拿它做决定） */
  get perceptionFresh() {
    return !!this.perception && Date.now() - this.perceptionAt < 8000;
  }

  _handle(m) {
    if (m.type === 'hello_error') {
      this.setStatus('error', m.message || m.code || '接入被拒绝');
      this.log('error', '世界接入被拒绝：' + (m.message || m.code || ''));
      this._closedByUser = true; // 鉴权失败不再自动重连，避免刷爆服务端
      try { this.ws && this.ws.close(); } catch (e) {}
      return;
    }

    if (m.type === 'hello') {
      this.hello = m;
      // 新建档：服务端下发 profile_id + token，存回供下次回访
      if (m.profile_id) {
        this.profileId = m.profile_id;
        if (m.token) this.token = m.token;
        this.onCredentials({ profileId: this.profileId, token: this.token });
      }
      if (m.self && m.self.name) this.selfName = m.self.name;
      this.setStatus('connected');
      this.log('info', `已进入世界 ${m.room || ''}（${this.selfName || this.profileId}）`);
      return;
    }

    if (m.type === 'perception') {
      this.perception = m;
      this.perceptionAt = Date.now();
      this.onPerception(m);
      return;
    }

    if (m.type === 'event' && m.log) {
      this.onEvent(m.log);
      return;
    }

    if (m.type === 'social_request') {
      this.socialPending.push(m);
      while (this.socialPending.length > 20) this.socialPending.shift();
      this.onSocial(m);
      return;
    }

    if (m.type === 'owner_suggestion_from_owner') {
      this.suggestions.push({ text: String(m.text || ''), at: Date.now() });
      while (this.suggestions.length > 10) this.suggestions.shift();
      this.onSuggestion(m);
      return;
    }

    if (m.type === 'intent_result') {
      const p = this.pendingIntents.get(m.intent_id);
      if (p) {
        clearTimeout(p.timer);
        this.pendingIntents.delete(m.intent_id);
        p.resolve(m);
      }
      return;
    }
  }

  /** 发一个动作，等房间服务端的裁决回执 */
  act(action, params, say) {
    if (!this.connected) {
      return Promise.resolve({ accepted: false, code: 'NOT_CONNECTED', message: '还没连上世界' });
    }
    if (!ACTION_LIST.includes(action)) {
      return Promise.resolve({ accepted: false, code: 'UNKNOWN_ACTION', message: '不认识的动作：' + action });
    }

    const intent_id = 'wl' + (++this._intentSeq);
    const payload = {
      type: 'action_intent',
      bot_id: this.profileId,
      intent_id,
      action,
      params: params || {},
    };
    if (say) payload.say = String(say).slice(0, 60);

    const wait = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingIntents.delete(intent_id);
        resolve({ accepted: false, code: 'NO_REPLY', message: '服务端 5 秒没有回执' });
      }, INTENT_TIMEOUT);
      this.pendingIntents.set(intent_id, { resolve, timer });
    });

    try {
      this.ws.send(JSON.stringify(payload));
    } catch (e) {
      return Promise.resolve({ accepted: false, code: 'SEND_FAILED', message: e.message });
    }
    return wait;
  }

  /** 按名字或 id 找附近的一只鱼（她输出的 target 可能是名字） */
  findEntity(target) {
    if (!target) return null;
    const p = this.perception;
    const pool = [];
    if (p && Array.isArray(p.entities)) pool.push(...p.entities);
    if (p && p.self) pool.push(p.self);
    const t = String(target).trim();
    return pool.find((e) => e && (e.id === t || e.name === t)) || null;
  }

  /** 按 id 找一个附近物件（让她「走到那棵树旁边」时用） */
  findObject(target) {
    if (!target) return null;
    const pool = (this.perception && this.perception.objects) || [];
    const t = String(target).trim();
    return pool.find((o) => o && o.id === t) || null;
  }

  /** 按地名找一个地标（湖 / 台地 / 小镇 / 野外区 / 杂货铺），解析成坐标 */
  findPlace(target) {
    if (!target) return null;
    const t = String(target).trim().toLowerCase();
    const places = (this.perception && this.perception.places) || [];
    const hit = places.find((q) => q.id === t || q.name === String(target).trim());
    if (hit) return hit;
    const town = this.perception && this.perception.town;
    const zones = (this.perception && this.perception.zones) || [];
    for (const [id, aliases] of Object.entries(PLACE_ALIASES)) {
      if (!(aliases.includes(t) || aliases.some((a) => t && t.includes(a)))) continue;
      const byId = places.find((q) => q.id === id);
      if (byId) return byId;
      if (id === 'town' && town) return { id: 'town', name: town.name || '肥鱼小镇', x: town.center.x, z: town.center.z };
      if (id === 'plaza' && town) return { id: 'plaza', name: '小镇广场', x: town.plaza.x, z: town.plaza.z };
      const zone = zones.find((z) => z.id === id);
      if (zone) return { id: zone.id, name: zone.name, x: zone.x, z: zone.z };
      if (id === 'lake') return { id, name: '湖边', x: 34, z: -30 };
      if (id === 'shop') { const sp = (this.perception && this.perception.shop) || null; return { id, name: '杂货铺', x: (sp && sp.x) || 12, z: (sp && sp.z) || 56 }; }
      if (id === 'plat') return { id, name: '台地', x: -18, z: 18 };
    }
    return null;
  }

  takeSuggestions() {
    const list = this.suggestions.slice();
    this.suggestions.length = 0;
    return list;
  }

  takeSocial() {
    const list = this.socialPending.slice();
    this.socialPending.length = 0;
    return list;
  }

  dispose() {
    this.disconnect();
  }
}

/* ---------------------------------------------------------------- 文本化 */

export function timeText(env) {
  if (!env) return '';
  const m = ((env.minute % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `第${env.day || 1}天 ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const TERRAIN_NAME = { water: '水边/湖里', platform: '台地上', grass: '草地' };

function entityLine(e) {
  const bits = [`${e.name}（${e.id}）距离 ${Number(e.dist).toFixed(1)}m，${e.state || 'idle'}`];
  if (e.pose && e.pose !== 'idle') bits.push(`姿势 ${e.pose}`);
  if (e.linkedWith) bits.push(`牵着 ${e.linkedWith}`);
  if (e.say) bits.push(`刚才说「${e.say}」`);
  return '- ' + bits.join('，');
}

/** 地名别名：她可能说「湖」「湖边」「台地」「平台」「镇上」「广场」 */
const PLACE_ALIASES = {
  lake: ['lake', '湖', '湖边', '湖水'],
  plat: ['plat', '台地', '平台', '出生台地', '高地'],
  shop: ['shop', '杂货铺', '商店', '小商店', '小卖部', '小鱼杂货铺', '柜台'],
  town: ['town', '小镇', '肥鱼小镇', '镇上', '镇里', '回镇'],
  plaza: ['plaza', '广场', '镇中心', '井边', '水井'],
  forest: ['forest', '森林', '北边森林', '树林', '林子'],
  quarry: ['quarry', '采石场', '矿场', '石场'],
  meadow: ['meadow', '草甸', '草地'],
  field: ['field', '麦田', '田里', '农田'],
};

/**
 * 把感知压成一段给她看的文字（控制在 400 字以内）。
 * @param {object} p perception 消息
 * @param {object} extra { suggestions:[], social:[] }
 */
export function summarize(p, extra = {}) {
  if (!p) return '（还没收到世界感知）';

  const self = p.self || {};
  const lines = [];

  let head = `【大肥鱼开放世界】${timeText(p.env)}${p.env && p.env.weather ? ' ' + p.env.weather : ''}`;
  head += `｜你（${self.name || '?'}）在 (${Number(self.x).toFixed(1)}, ${Number(self.z).toFixed(1)})，${self.state || 'idle'}`;
  if (self.pose && self.pose !== 'idle') {
    const POSE_NAME = { dance: '跳舞', handhold: '牵手', sit: '坐着', sleep: '睡着' };
    head += `，正在${POSE_NAME[self.pose] || self.pose}`;
  }
  if (self.linkedWith) head += `，和 ${self.linkedWith} 牵着手`;
  if (self.terrain && TERRAIN_NAME[self.terrain]) head += `，脚下${TERRAIN_NAME[self.terrain]}`;
  lines.push(head);

  const places = (p.places || []).slice(0, 3);
  if (places.length) {
    lines.push('地标：' + places
      .map((q) => `${q.name} ${Number(q.dist).toFixed(0)}m（${q.dir === '脚下' ? '就在旁边' : q.dir + '方向'}${q.relation ? '，' + q.relation : ''}）`)
      .join('，'));
  }

  // 小镇：在不在镇里、最近的门口、还空着的地块
  const town = p.town;
  if (town) {
    const gates = (town.gates || []).slice().sort((a, b) => a.dist - b.dist).slice(0, 2)
      .map((g) => `${g.name} ${Number(g.dist).toFixed(0)}m（${g.dir}）`).join('、');
    const free = (town.plots || []).filter((q) => q.free).slice(0, 2);
    let line = '小镇：' + (town.inside
      ? '你在肥鱼小镇里（广场、水井、长椅、路灯、公共花圃都在这一圈，杂货铺也在镇里）'
      : `你在镇外（野外），回镇中心广场还得走 ${Number(town.dist).toFixed(0)}m`);
    if (!town.inside && gates) line += `；最近的门口：${gates}`;
    if (free.length) line += `；空地块：${free.map((q) => `${Number(q.x).toFixed(0)},${Number(q.z).toFixed(0)}（${Number(q.dist).toFixed(0)}m）`).join('、')}（想安家就在这儿 build house）`;
    lines.push(line);
  }

  // 野外区：物资在哪、多远、什么方向
  const zones = p.zones;
  if (zones && zones.length) {
    lines.push('野外（物资都在镇外）：' + zones.slice(0, 4)
      .map((z) => `${z.name}（${z.kind}）${Number(z.dist).toFixed(0)}m ${z.dir}，坐标 ${Number(z.x).toFixed(0)},${Number(z.z).toFixed(0)}`)
      .join('；'));
  }

  const ents = (p.entities || []).slice(0, 4);
  if (ents.length) {
    lines.push('附近：');
    for (const e of ents) lines.push(entityLine(e));
  } else {
    lines.push('附近没有别人。');
  }

  const chat = (p.chat || []).slice(-8);
  if (chat.length) {
    lines.push('频道最近对话：');
    for (const c of chat) lines.push('- ' + (c.name || '?') + '：「' + (c.text || '') + '」');
  }

  const evs = (p.events || []).filter((e) => e.kind !== 'say').slice(-6);
  if (evs.length) {
    lines.push('刚才发生：');
    for (const e of evs) {
      const who = e.name || e.bot_id || '';
      lines.push('- ' + who + ' ' + (e.text || ''));
    }
  }

  const objs = (p.objects || []).slice(0, 4);
  if (objs.length) {
    // 带上坐标：不然她只知道「11 米」不知道往哪走，move_to 永远落不到树边 → mine 报 TOO_FAR
    lines.push('附近能采的：' + objs
      .map((o) => {
        const c = Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.z))
          ? `，坐标 ${Number(o.x).toFixed(0)},${Number(o.z).toFixed(0)}`
          : '';
        return `${o.id}（${o.type}→${o.item}）${Number(o.dist).toFixed(1)}m${c}`;
      })
      .join('、'));
  }

  const dr = (p.drops || []).slice(0, 3);
  if (dr.length) {
    lines.push('地上有掉落：' + dr
      .map((d) => `${d.item} ${Number(d.dist).toFixed(1)}m`)
      .join('、'));
  }

  // 花圃：种了什么、熟没熟
  const planters = (p.planters || []).slice(0, 2);
  if (planters.length) {
    lines.push('花圃：' + planters.map((o) => {
      const slots = (o.slots || []).map((s, i) => (s
        ? `${i + 1}号坑 ${s.seed}${s.ripe ? '（熟了，可以 harvest）' : `（还差 ${Math.round(Number(s.waitMin) || 0)} 分钟）`}`
        : `${i + 1}号坑 空`));
      return `${o.id} ${Number(o.dist).toFixed(1)}m（${slots.join('；')}）`;
    }).join('、'));
  }

  const fire = p.fireNear;
  if (fire && Number(fire.dist) <= 40) {
    const kind = fire.type === 'stove' ? '灶台' : '篝火';
    lines.push(`${kind}：${fire.id} 离你 ${Number(fire.dist).toFixed(0)}m`
      + (Number(fire.dist) <= 3 ? '（就在旁边，可以 cook：烤鱼或做沙拉/面/果派/果汁）' : '（走过去 cook 就能烤鱼、做菜）'));
  }

  const shop = p.shop;
  if (shop && Number.isFinite(Number(shop.dist)) && Number(shop.dist) <= 60) {
    const picks = ['egg', 'juice', 'bread', 'tea', 'salad', 'mushroom', 'honey', 'soup', 'noodle', 'pie', 'cake', 'bait', 'plank', 'brick', 'rope', 'seed_wheat', 'seed_flower', 'seed_berry'];
    const items = (shop.items || []).filter((i) => i.item !== 'rod' && picks.includes(i.item))
      .map((i) => `${i.item}=${i.price}`).join('、') + '、rod=12（鱼竿）';
    lines.push(`${shop.name || '小鱼杂货铺'}：离你 ${Number(shop.dist).toFixed(0)}m（走到柜台 ${Number(shop.radius) || 3}m 内才买得成），你有 ${shop.wallet} 金币；卖 ${items} 金币`
      + `；也收货（wood/stone/fiber/reed/weed/clay=1、fish_common=4、fish_rare=9、flower/berry/wheat/mushroom/cotton/plank/brick/rope=2、shell=3、ore=4、honey=5、cooked_fish=7）`);
  }

  const rod = !!(p.tools && p.tools.rod);
  // 房子：自己的几间、门锁没锁；附近别人家的门锁不锁
  const houses = p.houses;
  const hc = Number(p.houseCount);
  const hl = Number(p.houseLimit);
  if (Number.isFinite(hc) && Number.isFinite(hl)) {
    lines.push(`你的房子 ${hc}/${hl} 间`
      + (hc >= hl ? '（到上限了，不能再盖新房；想搬家先 mine 掉旧的那间，材料全退）' : `（还能盖 ${hl - hc} 间）`));
  }
  if (Array.isArray(houses) && houses.length) {
    const mine = houses.filter((h) => h && h.mine);
    const others = houses.filter((h) => h && !h.mine);
    if (mine.length) {
      lines.push('你的房子：' + mine.map((h) => `${Math.round(Number(h.dist) || 0)}m${h.open ? '（门开着，谁都能进）' : '（门锁着，只有你和被邀请的鱼能进）'}`).join('、')
        + '；要改就 door params:{open:true/false}');
    }
    if (others.length) {
      lines.push('别人的房子：' + others.map((h) => `${h.owner || '无主'} 家 ${Math.round(Number(h.dist) || 0)}m（${h.open ? '门开着，可以进' : h.enterable ? '主人家放行过' : '锁着，进不去'}）`).join('、'));
    }
  }
  // 饱食度：让她知道自己饿没饿、背包里还有没有吃的
  const selfInfo = p.self || {};
  const fullness = Number(selfInfo.fullness);
  if (Number.isFinite(fullness)) {
    const note = fullness < 10 ? '（饿扁了，走路都慢了）' : fullness < 35 ? '（饿了，该吃点东西）' : '';
    const foodObj = selfInfo.food || {};
    const foodKeys = Object.keys(foodObj).filter((k) => Number(foodObj[k]) > 0);
    lines.push(`饱食度 ${Math.round(fullness)}%${note}`
      + (foodKeys.length ? `，背里能吃的：${foodKeys.map((k) => k + '×' + foodObj[k]).join('、')}` : '，背包里没有能吃的'));
  }
  lines.push(`你在${p.insideHouse ? '自家屋里（可以 sit 坐会儿、sleep 睡到早上）' : '屋外'}` + `；鱼竿：${rod ? '有（到湖边就能 fish）' : '还没有（杂货铺 buy params:{item:"rod"} 12 金币' + '）'}`);

  const bag = p.inv || {};
  const bagKeys = Object.keys(bag).filter((k) => bag[k] > 0);
  lines.push(bagKeys.length ? '背包：' + bagKeys.map((k) => k + '×' + bag[k]).join('、') : '背包是空的');

  if (extra.social && extra.social.length) {
    lines.push('等你回应：');
    for (const r of extra.social.slice(-3)) {
      lines.push(`- ${r.from_name} 想跟你${r.kind === 'dance' ? '跳舞' : '牵手'}（request_id=${r.request_id}）`);
    }
  }

  if (extra.suggestions && extra.suggestions.length) {
    lines.push('主人刚给你发来建议：');
    for (const s of extra.suggestions.slice(-3)) lines.push(`- 「${s.text}」`);
  }

  return lines.join('\n');
}

/** 走一段路大概要几秒（服务端 1.15 m/s） */
export function travelSeconds(fromX, fromZ, toX, toZ) {
  const d = Math.hypot(toX - fromX, toZ - fromZ);
  return Math.max(0.6, d / 1.15);
}
