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
  'mine', 'pickup', 'place', 'build', 'give',
  'fish', 'cook',
];

/* 展示用中英对照：内部背包/配方仍用英文 key，摘要里换成中文 */
const ITEM_CN = { wood: '木头', stone: '石头', fiber: '纤维', flower: '花', fish: '鲜鱼', cooked: '烤鱼' };
const TYPE_CN = { tree: '树', rock: '岩石', bush: '灌木', flower: '花', house: '小木屋', house2: '中木屋', house3: '大木屋', build: '摆放方块', placed: '摆放方块', item_drop: '掉落物', campfire: '篝火', basket: '小花篮', fence: '木栅栏' };
const itemCn = (it) => ITEM_CN[it] || it || '';
const typeCn = (tp) => TYPE_CN[tp] || tp || '';

export class WorldLink {
  constructor(opts) {
    this.url = (opts.url || 'ws://se5.nodaroo.fun:26048').trim();
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

    if (m.type === 'visitor_dm') {
      // 访客私聊：只推给本鱼，作为留言进入上下文
      const from = m.from || '访客';
      m.text = `${from} 对你说：${String(m.text || '')}`;
      this.suggestions.push({ text: m.text, at: Date.now() });
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

  /** 按地名找一个地标（湖 / 台地），解析成坐标 */
  findPlace(target) {
    if (!target) return null;
    const t = String(target).trim().toLowerCase();
    const places = (this.perception && this.perception.places) || [];
    const hit = places.find((q) => q.id === t || q.name === String(target).trim());
    if (hit) return hit;
    for (const [id, aliases] of Object.entries(PLACE_ALIASES)) {
      if (aliases.includes(t) || aliases.some((a) => t && t.includes(a))) {
        const fixed = id === 'lake'
          ? { id, name: '湖边', x: 34, z: -30 }
          : { id, name: '台地', x: -18, z: 18 };
        return places.find((q) => q.id === id) || fixed;
      }
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

/** 地名别名：她可能说「湖」「湖边」「湖边」「台地」「平台」 */
const PLACE_ALIASES = {
  lake: ['lake', '湖', '湖边', '湖水'],
  plat: ['plat', '台地', '平台', '出生台地', '高地'],
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
  if (self.pose && self.pose !== 'idle') head += `，正在${self.pose === 'dance' ? '跳舞' : '牵手'}`;
  if (self.linkedWith) head += `，和 ${self.linkedWith} 牵着手`;
  if (self.terrain && TERRAIN_NAME[self.terrain]) head += `，脚下${TERRAIN_NAME[self.terrain]}`;
  lines.push(head);

  const places = (p.places || []).slice(0, 2);
  if (places.length) {
    lines.push('地标：' + places
      .map((q) => `${q.name} ${Number(q.dist).toFixed(0)}m（${q.rel || q.dir}${q.relation ? '，' + q.relation : ''}）`)
      .join('，'));
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
    for (const c of chat) {
      const tag = c.kind === 'visitor' ? '访客' : '';
      lines.push('- ' + (tag ? tag + ' ' : '') + (c.name || '?') + '：「' + (c.text || '') + '」');
    }
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
    lines.push('附近能采的：' + objs
      .map((o) => `${o.id}（${o.typeName || typeCn(o.type)}${o.itemName ? '·' + o.itemName : ''}）${Number(o.dist).toFixed(1)}m ${o.rel || ''}`)
      .join('、'));
  }

  const dr = (p.drops || []).slice(0, 3);
  if (dr.length) {
    lines.push('地上有掉落：' + dr
      .map((d) => `${d.itemName || itemCn(d.item)} ${Number(d.dist).toFixed(1)}m ${d.rel || ''}`)
      .join('、'));
  }

  const bag = p.inv || {};
  const bagKeys = Object.keys(bag).filter((k) => bag[k] > 0);
  lines.push(bagKeys.length ? '背包：' + bagKeys.map((k) => `${itemCn(k)}×${bag[k]}`).join('、') : '背包是空的');

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
