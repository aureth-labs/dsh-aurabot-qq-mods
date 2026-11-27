/**
 * world-link / lib/brain.mjs
 * 决策那一步的提示词与 JSON 解析。也不依赖 api，方便离线测。
 */
import { ACTION_LIST } from './link.mjs';

/** 给她看的动作清单（写短一点，省 token） */
export const ACTION_HELP = `可选动作（只能从这里选，action 字段写英文）：
- move_to 走到目的地，params:{x,z} 或 params:{place:"湖边|台地"}（世界边界约 ±90）
- idle 停下发呆
- say 说一句，say:"…"（不超过 40 字）
- request_handhold 向别人发起牵手，params:{target_entity:"对方名字或档案 id"}（必须 3m 内，先 move_to 靠近）
- request_dance 向别人发起跳舞，params 同上
- accept_social 答应请求，params:{request_id:"req_1"}
- reject_social 拒绝请求，params:{request_id:"req_1"}
- release_social 松开牵着的手
- mine 采一个物件，params:{object_id:"o_tree_012"}（要 3m 内；采一下不一定采完，采完会在地上掉落，记得 pickup 捡）。若敲的是房子/摆放方块，则是拆除，材料全额退回背包
- pickup 捡起身边 3m 内的掉落物，无参数
- place 摆放东西，params:{item:"wood",x,z}（背包里要有这个物品，只能放在身边 5m 内）
- build 按配方盖建筑，params:{recipe:"house",x,z}（house 小木屋要 10 个 wood；只能在身边 5m 内）`;

/** 静态地图常识：每轮都给她，不然她不知道世界长什么样、往哪走合理 */
export const MAP_INFO = `世界是一片草地，边界约 ±90；两个地标：湖在 (34,-30) 半径 26，出生台地在 (-18,18) 半径 15。`;

/**
 * 自主游玩的提示词。summary 来自 link.summarize()。
 */
export function buildPlayPrompt(summary, opts = {}) {
  const n = Math.max(1, Math.min(5, opts.maxActions || 2));
  return `你正以自己的身体在一个 3D 世界里活着，不是聊天。下面是你的感知：

${summary}

${MAP_INFO}

${ACTION_HELP}

现在按你自己的想法决定接下来做什么：可以观察、闲逛、走远一点看看、接附近鱼的话茬、靠近谁再牵手/跳舞、答应或拒绝别人的请求，也可以干脆 idle 待在原地不动。「频道最近对话」里每条都标了说话者名字，回复时认准是谁说的。
只输出一个 JSON 数组，1~${n} 个动作，按顺序执行。不要解释，不要代码块，不要多余文字。
例如：[{"action":"say","say":"今天的水好暖"},{"action":"move_to","params":{"x":-12,"z":2}}]`;
}

/** 有人向你发起牵手/跳舞时的小提示 */
export function buildSocialPrompt(summary, request) {
  return `有人在世界里向你发起了请求。

${summary}

${ACTION_HELP}

${request.from_name} 想跟你${request.kind === 'dance' ? '跳舞' : '牵手'}（request_id=${request.request_id}）。
你想答应吗？可以先用 say 回一句再决定，也可以直接拒绝。只输出 JSON 数组，1~2 个动作，不要解释。`;
}

/** 主人从 QQ / 网页发来一句建议时 */
export function buildSuggestionPrompt(summary, text) {
  return `主人刚在开放世界里给你发了建议：「${text}」。

${summary}

${ACTION_HELP}

这条建议不是命令，是主人的想法；你可以照做，也可以只做一部分或者不去做（比如现在做不到）。
只输出 JSON 数组，1~3 个动作，不要解释。`;
}

/* ---------------------------------------------------------------- 解析 */

function stripFence(text) {
  return String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function tryJson(s) {
  try { return JSON.parse(s); } catch (e) { return undefined; }
}

/** 从一段自由文字里抠出 JSON 数组 */
export function extractJson(text) {
  const t = stripFence(text);
  const first = t.indexOf('[');
  const last = t.lastIndexOf(']');
  if (first >= 0 && last > first) {
    const arr = tryJson(t.slice(first, last + 1));
    if (Array.isArray(arr)) return arr;
  }
  const fo = t.indexOf('{');
  const lo = t.lastIndexOf('}');
  if (fo >= 0 && lo > fo) {
    const obj = tryJson(t.slice(fo, lo + 1));
    if (obj) return Array.isArray(obj.actions) ? obj.actions : [obj];
  }
  return null;
}

const ALIAS = {
  走: 'move_to', 移动: 'move_to', 过去: 'move_to', 靠近: 'move_to',
  停: 'idle', 发呆: 'idle', 休息: 'idle', 站着: 'idle',
  说话: 'say', 聊天: 'say', 喊: 'say',
  牵手: 'request_handhold', 牵: 'request_handhold', 握手: 'request_handhold',
  跳舞: 'request_dance', 舞蹈: 'request_dance',
  答应: 'accept_social', 接受: 'accept_social', 同意: 'accept_social',
  拒绝: 'reject_social', 不答应: 'reject_social',
  松手: 'release_social', 放开: 'release_social',
};

const NUM = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-90, Math.min(90, n)) : null;
};

/**
 * 把她的输出整理成可执行的动作列表。无效的会被丢掉并记在 dropped 里。
 */
export function normalizeActions(raw, link) {
  const out = [];
  const dropped = [];
  if (!Array.isArray(raw)) return { actions: out, dropped: ['没有解析出 JSON 数组'] };

  for (const item of raw) {
    if (!item || typeof item !== 'object') { dropped.push('不是对象'); continue; }

    let name = String(item.action || item.type || item.do || '').trim();
    if (ALIAS[name]) name = ALIAS[name];
    if (!ACTION_LIST.includes(name)) { dropped.push('不认识的动作 ' + name); continue; }

    const p = Object.assign({}, item.params || item);

    if (name === 'move_to') {
      let x = NUM(p.x != null ? p.x : p.target_x);
      let z = NUM(p.z != null ? p.z : p.target_z);
      if (x == null || z == null) {
        const pl = link.findPlace(p.place || p.place_name || p.target || item.target || item.place);
        if (!pl) { dropped.push('move_to 缺坐标或地名'); continue; }
        x = NUM(pl.x); z = NUM(pl.z);
      }
      out.push({ action: name, params: { x, z }, say: item.say });
      continue;
    }

    if (name === 'say') {
      const text = String(item.say || p.say || p.text || '').slice(0, 40);
      if (!text) { dropped.push('say 没内容'); continue; }
      out.push({ action: 'say', params: {}, say: text });
      continue;
    }

    if (name === 'request_handhold' || name === 'request_dance') {
      const target = p.target_entity || p.target || p.target_name || p.name || item.target;
      const e = link.findEntity(target);
      if (!e) { dropped.push('找不到目标 ' + target); continue; }
      out.push({ action: name, params: { target_entity: e.id }, say: item.say });
      continue;
    }

    if (name === 'accept_social' || name === 'reject_social') {
      const rid = p.request_id || p.id || p.requestId;
      if (!rid) { dropped.push(name + ' 缺 request_id'); continue; }
      out.push({ action: name, params: { request_id: String(rid) }, say: item.say });
      continue;
    }

    if (name === 'mine') {
      const oid = p.object_id || p.objectId || p.target || p.target_entity || item.target;
      if (!oid) { dropped.push('mine 缺 object_id'); continue; }
      out.push({ action: 'mine', params: { object_id: String(oid) }, say: item.say });
      continue;
    }

    if (name === 'pickup') {
      out.push({ action: 'pickup', params: {}, say: item.say });
      continue;
    }

    if (name === 'place') {
      const it = String(p.item || p.what || '').trim();
      const x = NUM(p.x != null ? p.x : p.target_x);
      const z = NUM(p.z != null ? p.z : p.target_z);
      if (!it) { dropped.push('place 缺 item'); continue; }
      if (x == null || z == null) { dropped.push('place 缺坐标'); continue; }
      out.push({ action: 'place', params: { item: it, x, z }, say: item.say });
      continue;
    }

    if (name === 'build') {
      const recipe = String(p.recipe || p.kind || 'house').trim() || 'house';
      const x = NUM(p.x != null ? p.x : p.target_x);
      const z = NUM(p.z != null ? p.z : p.target_z);
      if (x == null || z == null) { dropped.push('build 缺坐标'); continue; }
      out.push({ action: 'build', params: { recipe, x, z }, say: item.say });
      continue;
    }

    out.push({ action: name, params: {}, say: item.say });
  }

  return { actions: out, dropped };
}
