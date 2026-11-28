/**
 * world-link / lib/brain.mjs
 * 决策那一步的提示词与 JSON 解析。也不依赖 api，方便离线测。
 */
import { ACTION_LIST } from './link.mjs';

/** 给她看的动作清单（写短一点，省 token） */
export const ACTION_HELP = `可选动作（只能从这里选，action 字段写英文）：
- move_to 走到目的地，params:{x,z} 或 params:{place:"湖边|台地|杂货铺|小镇|广场|森林|采石场|草甸|麦田"}（世界边界约 ±90）；想走到某个物件旁边就直接 params:{object_id:"o_tree_021"}，比算坐标稳
- idle 停下发呆
- say 说一句，say:"…"（不超过 40 字）
- request_handhold 向别人发起牵手，params:{target_entity:"对方名字或档案 id"}（必须 3m 内，先 move_to 靠近）
- request_dance 向别人发起跳舞，params 同上
- accept_social 答应请求，params:{request_id:"req_1"}
- reject_social 拒绝请求，params:{request_id:"req_1"}
- release_social 松开牵着的手
- mine 采一个物件，params:{object_id:"o_tree_012"}（要 3m 内；敲碎会掉在地上，记得 pickup 捡）。世界里能采的：树/倒木→wood、石头→stone、灌木→fiber、花→flower、浆果丛→berry、蘑菇丛→mushroom、麦田→wheat、矿脉→ore、贝壳滩→shell、芦苇→reed、棉桃丛→cotton、黏土坑→clay、蜂巢→honey。若敲的是房子/摆放方块，则是拆除，材料全额退回背包
- pickup 捡起身边 3m 内的掉落物，无参数
- place 摆放东西，params:{item:"wood",x,z}（背包里要有这个物品，只能放在身边 5m 内）
- craft 把原料加工成建材，params:{recipe:"plank",count:1}。能加工的只有：plank 木板=wood×2、brick 砖=stone×2+clay×1、rope 绳子=fiber×3；加工件能盖更讲究的东西，也能拿去卖
- build 按配方盖建筑，params:{recipe:"house",x,z}（只能在身边 5m 内，坐标写你附近的地面）。配方：
  house 小木屋 wood×10｜workbench 工作台 plank×4+stone×2｜stove 石炉 brick×4+stone×2
  fence 栅栏 plank×2｜gate 院门 plank×3+stone×1｜campfire 篝火 wood×3+stone×3｜bench 长椅 plank×3
  sign 木牌 plank×1｜bridge 小桥 plank×6+stone×2｜dock 栈桥 plank×8+rope×2
  scarecrow 稻草人 plank×2+fiber×3+wheat×2｜planter 花圃 plank×2+clay×1+flower×2
  chest 储物箱 plank×4+rope×1｜swing 秋千 plank×3+rope×4｜lamp_post 路灯 plank×2+stone×2+fiber×2
  birdhouse 鸟屋 plank×2+reed×2
- buy 在杂货铺（镇里东街，走到柜台 3m 内）用金币买，params:{item:"bread",count:1}；价目看感知里「杂货铺」那行，item 写 "rod" 就是买鱼竿 12 金币，买完 tools.rod=true
- eat 吃东西回饱食度，params:{item:"bread"}（不给 item 或写 "auto" 就自动挑背包里最顶饱的一样）。能吃的与饱食度：cake 蛋糕 100、pie 果派 88、soup 汤 85、cooked_fish 烤鱼 80、noodle 面条 78、bread 面包 72、fish_rare 62、salad 沙拉 60、fish_common 46、honey 40、tea 34、juice 果汁 30、mushroom 26、egg 鸡蛋 20、wheat 20、berry 16、weed 12。饱食度掉得慢（一天约 23 点，四天多才饿空），掉到 18% 会自己吃，0% 走路变慢，别硬扛
- sell 把背包里的东西卖回杂货铺换金币，params:{item:"wood",count:1}（同样要站到柜台 3m 内）
- sit 坐下歇会儿，无参数（进屋坐更有意思）
- sleep 只在自家小木屋里有效，无参数：睡一觉直接到第二天早上 7 点（进屋子就是走到房子坐标中心，房子门口开在 +z 那边）
- door 开关自己家的门，params:{open:true} 或 {open:false}（不给 open 就切换）。要站在自己房子 10 米内。门锁着时，别的鱼走不进来、也拆不了你的房子；门开着谁都能进
- invite 请一条鱼进自己家，params:{name:"对方名字"}：被请过的鱼以后门锁着也能进。同样要站在自己房子 10 米内
- 别人家的房子门是锁着的：走到房子中心会被 HOUSE_LOCKED 拦住，只能在门口站着 say 一句等主人开；别硬闯，也别去拆人家的房子
- fish 在湖边钓鱼，无参数（要站在水岸 8 米内，并且 tools.rod=true；约 4 秒一竿，会钓到 fish_common / fish_rare，可以拿去杂货铺卖）
- plant 往花圃里种一把种子，params:{seed:"seed_wheat"}（要站在花圃 3 米内；花圃 build planter 才 3 个种坑，种子在杂货铺 3 金币一份，种下约 120 游戏分钟成熟）
- harvest 收花圃里熟了的作物，无参数（站花圃 3 米内；熟一棵收 2 个，收完坑就空了能再种）
- cook 在火边做饭，params:{item:"…"}（要站篝火或灶台 3 米内，会自动走过去）。烤鱼：fish_common / fish_rare → cooked_fish；做菜：salad 沙拉（berry×2+weed×2）、juice 果汁（berry×3）、noodle 面（wheat×2+egg×1）、pie 果派（wheat×2+berry×2）。篝火 build campfire 要 wood×3+stone×3，灶台 build stove 要 brick×4+stone×2
- drink 在湖边喝口水，无参数：回 6 点饱食度（要站在水岸 8 米内，8 秒一次），没吃的时先喝水顶一下`;

/** 静态地图常识：每轮都给她，不然她不知道世界长什么样、往哪走合理 */
export const MAP_INFO = `世界分两块：中间偏北是「肥鱼小镇」（镇心广场在 0,56，四道门：北门 (0,36)、南门 (0,76)、西门 (-22,56)、东门 (22,56)；镇里十字石板街、水井、长椅、路灯、两块公共花圃，小鱼杂货铺在东街 (12,56)，走到柜台 3m 内才能买/卖；镇里 8 块空地（x=±13，z=41/49/63/71）可以盖房子安家）。镇外是野外：北边森林 (-54,54) 木头/倒木/蘑菇/蜂巢，东北采石场 (54,42) 石头/矿/黏土，西边草甸 (-52,16) 花/浆果/棉花/灌木，南边麦田 (-52,-44) 麦子/棉花，湖边水岸 (34,-30) 芦苇/贝壳/黏土、能钓鱼。物资只在镇外长，镇里不长野东西。`;

/** 找感知里最近的一棵树（够她直接点名去砍） */
function nearestTree(objs) {
  const trees = (objs || []).filter((o) => o && o.type === 'tree' && Number.isFinite(Number(o.dist)));
  trees.sort((a, b) => Number(a.dist) - Number(b.dist));
  return trees[0] || null;
}

/** 「手上的活」：地上有掉落先捡，木头不够催砍树，够了催盖房。play / suggestion 两条提示词共用 */
function goalBody(bag, objs, drops, treeNear, houseDone) {
  const wood = Math.max(0, Number(bag && bag.wood) || 0);
  const hasHouse = (objs || []).some((o) => o && (o.type === 'house' || o.item === 'house'));
  if (houseDone || hasHouse) {
    return `\n【手上的活：已经干完了】小木屋盖好了，而且门能进人。每人最多 2 间房子，你没到上限就别再盖新房（多出来的木头拿去做 plank、围栅栏、搭栈桥）；想换个地方安家，得先把旧的那间 mine 掉（材料全退）。这一轮自由点，挑一件真事做：
- 走进屋里：move_to 到房子坐标中心（就是感知里 house 那个 x,z），进去以后 sit 坐一会儿，或者 sleep 睡到第二天早上
- 去湖边钓鱼：move_to params:{place:"湖边"}，然后 fish（要先有鱼竿，没竿就去杂货铺 buy params:{item:"rod"}）
- 钓到的鱼、砍多的木头拿去卖：到杂货铺 sell params:{item:"fish_common",count:1} 换金币
- 去杂货铺买点吃的，或者接着攒材料添东西（workbench 要 plank×4+stone×2，stove 要 brick×4+stone×2；plank 得先 craft params:{recipe:"plank"} 用两块木头换）
- 换点新料：berry/mushroom/honey 是吃的，clay 加石头能 craft 成 brick，fiber 搓成 rope；有了 rope + plank 就能盖 dock 栈桥、swing 秋千，wheat + fiber 能扎 scarecrow
- 想让台地更像个家：用 plank 围几段 fence 栅栏、立个 sign 木牌、点个 campfire 篝火、摆张 bench 长椅，还能挂 lamp_post 路灯
- 家是私人的：别人家的房子门锁着，走到门口就进不去（别硬闯，也别拆人家的房）。你自己有房子，门默认锁着；想让别的鱼进来就 door params:{open:true}，或者 invite params:{name:"对方名字"} 点名放行
- 自己种点吃的：先 build params:{recipe:"planter"}（plank×2+clay×1+flower×2）弄个花圃，再 plant params:{seed:"seed_wheat"}（种子杂货铺 3 金币），长熟后 harvest 收 2 个，比满世界找浆果稳
- 把鱼做成饭：有了 campfire 就站旁边 cook 把生鱼烤成烤鱼，然后再 eat，比啃生鱼顶饱
- 走一趟就顺手补饱食：站在湖边 drink 一口水回 6 点，饿到没东西吃的时候先这么扛着
要去杂货铺就 move_to params:{place:"杂货铺"}（在镇里东街 12,56），走到柜台 3 米内再 buy / sell。想安家就回镇上，挑感知「小镇」那行里空着的地块盖房子。`;
  }
  const t = nearestTree(objs) || (treeNear && treeNear.id ? treeNear : null);
  const dr = (drops || []).filter((d) => d && d.item).slice(0, 3);
  if (dr.length) {
    const list = dr.map((d) => `${d.item}（${Number(d.dist).toFixed(1)}m）`).join('、');
    return `\n【手上的活：先捡东西】你脚边有 ${list}，这一轮就把这一个动作发出来：{"action":"pickup"}，先捡进背包。
捡完再接着砍树${t ? `（下一棵还是 ${t.id}，离你 ${Number(t.dist).toFixed(0)} 米）` : ''}，一直这样「砍 → 捡」攒到 10 根木头。`;
  }
  if (wood >= 10) {
    return `\n【手上的活：盖房子】木头够了（${wood} 根，够盖一间 house）。挑你身边 5 米内一块没东西的空地，
build params:{recipe:"house", x,z}，x/z 用你附近整数的坐标（比如你站在 30,-10，就写 32,-12 这种），盖完 say 一句。`;
  }
  if (!t) {
    return `\n【手上的活：攒木头盖房子】你现在只有 ${wood} 根木头，要 10 根。附近这一圈没树，
move_to 往最近的野外区走（感知「野外」那行有坐标，比如北边森林 -54,54），路上看见树就砍。`;
  }
  const d = Number(t.dist).toFixed(0);
  return `\n【手上的活：攒木头盖房子】你现在只有 ${wood} 根木头，盖一间小木屋要 10 根，还差 ${10 - wood} 根。
最近那棵树是 ${t.id}，离你 ${d} 米。这一轮就把这一个动作发出来：{"action":"mine","object_id":"${t.id}"}
（不用自己算坐标，模块会自动把你带到树边再砍；砍一下没掉木头就再砍一次；砍碎后地上会掉木头，下一轮发 pickup 捡起来）。`;
}

/** 饿了先吃饭：饱食度低的时候这条压在别的活上面 */
function hungerBlock(bag, fullness) {
  const f = Number.isFinite(Number(fullness)) ? Number(fullness) : 100;
  if (f >= 35) return '';
  const have = ['bread', 'soup', 'tea', 'honey', 'mushroom', 'berry', 'wheat', 'fish_common', 'fish_rare', 'weed']
    .filter((k) => (Number(bag && bag[k]) || 0) > 0);
  const head = `\n【肚子饿了】饱食度只剩 ${Math.round(f)}%（掉到 0% 会饿扁、走路变慢）。`;
  if (have.length) {
    return head + `你背里有 ${have.join('/')}，这一轮先发 {"action":"eat"}（不给 item 就自动挑最顶饱的那样吃），吃完饱食度会回上来。`;
  }
  return head + `背包里没吃的了：move_to params:{place:"杂货铺"}，走到柜台 3 米内 buy params:{item:"bread"}（5 金币）；没钱就先把背包里的东西卖几样换钱，实在不行走到湖边 drink 一口水顶一下（回 6 点）。`;
}

function goalBlock(bag, objs, drops, treeNear, houseDone, fullness) {
  return hungerBlock(bag, fullness) + goalBody(bag, objs, drops, treeNear, houseDone);
}

/**
 * 自主游玩的提示词。summary 来自 link.summarize()。
 */
export function buildPlayPrompt(summary, opts = {}) {
  const n = Math.max(1, Math.min(5, opts.maxActions || 2));
  const idle = Math.max(0, Number(opts.idleStreak) || 0);
  const goal = goalBlock(opts.bag, opts.objs, opts.drops, opts.tree, opts.houseDone, opts.fullness);
  const shore = (opts.tools && opts.tools.rod && Number.isFinite(Number(opts.lakeDist)) && Number(opts.lakeDist) <= 32)
    ? `\n【就在岸边，把竿甩出去】你手上有鱼竿，离水岸只剩 ${Number(opts.lakeDist).toFixed(0)} 米。这一轮第一个动作就发 {"action":"fish"}，别再砍树了；钓上来的鱼可以直接卖掉换金币。`
    : '';

  const roam = idle >= 2
    ? `\n【必须动】你已经连续 ${idle} 轮停在原地没动了。这一轮第一个动作必须是 move_to：用 place 写「湖边」或「台地」，或者随便挑一对坐标（世界边界约 ±90），别只输出 idle。`
    : idle === 1
      ? '\n【提醒】上一轮你停在原地没动。这一轮走一段路吧：move_to 去湖边 / 台地，或者随便挑个坐标走远点，可以边走边 say。'
      : '';
  return `你正以自己的身体在一个 3D 世界里活着，不是聊天。下面是你的感知：

${summary}

${MAP_INFO}

${ACTION_HELP}
${goal}${shore}

现在按你自己的想法决定接下来做什么：可以观察、闲逛、走远一点看看、接附近鱼的话茬、靠近谁再牵手/跳舞、答应或拒绝别人的请求。也可以安静待一会儿，但别一直站着不动：除非你正在跟人聊天，否则最多连着两轮不动，第三轮就换个地方——没目标就回镇上逛逛（广场、水井、长椅都在 0,0 一带），或者往最近的野外区走一段（森林/采石场/草甸/湖边，见感知里的「野外」那行）。上面【手上的活】优先于闲逛：没盖完房子之前，优先砍树攒木头，攒够就盖。「频道最近对话」里每条都标了说话者名字，回复时认准是谁说的。${roam}
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
export function buildSuggestionPrompt(summary, text, opts = {}) {
  const goal = goalBlock(opts.bag, opts.objs, opts.drops, opts.tree, opts.houseDone, opts.fullness);
  const shore = (opts.tools && opts.tools.rod && Number.isFinite(Number(opts.lakeDist)) && Number(opts.lakeDist) <= 32)
    ? `\n【就在岸边】你手上有鱼竿，离水岸只剩 ${Number(opts.lakeDist).toFixed(0)} 米，直接 {"action":"fish"} 就能钓。`
    : '';
  return `主人刚在开放世界里给你发了建议：「${text}」。

${summary}

${ACTION_HELP}
${goal}${shore}

这条建议不是命令，是主人的想法；你可以照做，也可以只做一部分或者不去做（比如现在做不到）。【手上的活】比建议更优先，除非主人明确叫你做别的。
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
  买: 'buy', 购买: 'buy', 买东西: 'buy',
  吃: 'eat', 吃东西: 'eat', 吃饭: 'eat', 啃: 'eat',
  卖: 'sell', 出售: 'sell', 卖掉: 'sell', 卖东西: 'sell',
  坐: 'sit', 坐下: 'sit', 坐着: 'sit',
  睡: 'sleep', 睡觉: 'sleep', 躺下: 'sleep',
  钓鱼: 'fish', 钓: 'fish',
  种: 'plant', 种地: 'plant', 播种: 'plant', 栽: 'plant',
  收: 'harvest', 收割: 'harvest', 收获: 'harvest', 摘: 'harvest',
  烤: 'cook', 烤鱼: 'cook', 做饭: 'cook', 煮: 'cook',
  喝: 'drink', 喝水: 'drink', 喝口水: 'drink',
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
        // 允许她写「走到那棵树旁边」：object_id / target_object，这里换算成坐标
        const oid = p.object_id || p.objectId || p.target_object || (typeof p.target === 'string' && /^o_/.test(p.target) ? p.target : null);
        const ob = oid ? link.findObject(oid) : null;
        if (ob && Number.isFinite(Number(ob.x)) && Number.isFinite(Number(ob.z))) {
          x = NUM(ob.x); z = NUM(ob.z);
        }
      }
      if (x == null || z == null) {
        const pl = link.findPlace(p.place || p.place_name || p.target || item.target || item.place);
        if (!pl) { dropped.push('move_to 缺坐标或地名'); continue; }
        x = NUM(pl.x); z = NUM(pl.z);
        // 说「去湖边」时地名是湖心，走进水里就钓不到鱼了（会一直 NOT_AT_SHORE）。
        // 换成她这一侧的水岸点（离湖心 26 米那一圈）。
        if (/湖/.test(String(pl.name || '')) && Number.isFinite(x) && Number.isFinite(z)) {
          const self = (link.perception && link.perception.self) || {};
          const dx = Number(self.x) - x;
          const dz = Number(self.z) - z;
          const d = Math.hypot(dx, dz);
          const R = 26;
          const ux = Number.isFinite(d) && d > 1 ? dx / d : 0;
          const uz = Number.isFinite(d) && d > 1 ? dz / d : 1;
          x = NUM(x + ux * R);
          z = NUM(z + uz * R);
        }
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
      const id = String(oid);
      // 她经常离着十几米就「砍」，服务端只认 3 米内（TOO_FAR）。这里替她先走这一趟，
      // 执行器会在 move_to 之后按移动时间等够，再发 mine。
      const ob = link.findObject(id);
      if (ob && Number.isFinite(Number(ob.x)) && Number.isFinite(Number(ob.z))) {
        const self = (link.perception && link.perception.self) || {};
        const dx = Number(ob.x) - Number(self.x);
        const dz = Number(ob.z) - Number(self.z);
        const d = Number.isFinite(dx) && Number.isFinite(dz) ? Math.hypot(dx, dz) : Number(ob.dist);
        if (Number.isFinite(d) && d > 2.5) {
          out.push({ action: 'move_to', params: { x: NUM(ob.x), z: NUM(ob.z) }, say: '' });
        }
      }
      out.push({ action: 'mine', params: { object_id: id }, say: item.say });
      continue;
    }

    if (name === 'pickup') {
      // 同上：太远就先走到最近那堆掉落物旁边，执行器会等够路费再捡
      const drops = (link.perception && link.perception.drops) || [];
      const near = drops.slice().sort((a, b) => Number(a.dist) - Number(b.dist))[0];
      if (near && Number.isFinite(Number(near.dist)) && Number(near.dist) > 2.5
        && Number.isFinite(Number(near.x)) && Number.isFinite(Number(near.z))) {
        out.push({ action: 'move_to', params: { x: NUM(near.x), z: NUM(near.z) }, say: '' });
      }
      out.push({ action: 'pickup', params: {}, say: item.say });
      continue;
    }

    if (name === 'eat') {
      // 她能写中文名（面包/鱼），服务端只认英文 id，这里先翻一下；翻不出来就不带 item，让服务端自己挑最顶饱的
      const rawItem = String(p.item || p.what || p.food || '').trim();
      const cn = {
        面包: 'bread', 汤: 'soup', 茶: 'tea', 蜂蜜: 'honey', 蘑菇: 'mushroom',
        浆果: 'berry', 麦穗: 'wheat', 小麦: 'wheat', 鱼: 'fish_common', 烤鱼: 'cooked_fish', 水草: 'weed',
        蛋糕: 'cake', 果派: 'pie', 面条: 'noodle', 面: 'noodle', 沙拉: 'salad', 果汁: 'juice', 鸡蛋: 'egg', 蛋: 'egg'
      };
      const it = cn[rawItem] || rawItem;
      const ok = ['cake', 'pie', 'soup', 'cooked_fish', 'noodle', 'bread', 'salad', 'juice', 'egg', 'tea', 'honey', 'mushroom', 'berry', 'wheat', 'fish_common', 'fish_rare', 'weed'].includes(it);
      out.push({ action: 'eat', params: ok ? { item: it } : {}, say: item.say });
      continue;
    }

    if (name === 'plant') {
      // 种子可能是中文也可能是 id；认不出来就交给服务端报错（会带可用的种子名）
      const rawSeed = String(p.seed || p.item || p.what || '').trim();
      const seedMap = {
        麦子: 'seed_wheat', 麦种: 'seed_wheat', 小麦种子: 'seed_wheat',
        花: 'seed_flower', 花种: 'seed_flower', 花种子: 'seed_flower',
        浆果: 'seed_berry', 浆果种: 'seed_berry', 浆果种子: 'seed_berry',
      };
      const seed = seedMap[rawSeed] || (/^seed_/.test(rawSeed) ? rawSeed : '');
      // 花圃离得远就先走过去
      const planters = (link.perception && link.perception.planters) || [];
      const np = planters.slice().sort((a, b) => Number(a.dist) - Number(b.dist))[0];
      if (np && Number(np.dist) > 2.5 && Number.isFinite(Number(np.x)) && Number.isFinite(Number(np.z))) {
        out.push({ action: 'move_to', params: { x: NUM(np.x), z: NUM(np.z) }, say: '' });
      }
      out.push({ action: 'plant', params: seed ? { seed } : {}, say: item.say });
      continue;
    }

    if (name === 'harvest') {
      const planters = (link.perception && link.perception.planters) || [];
      const np = planters.slice().sort((a, b) => Number(a.dist) - Number(b.dist))[0];
      if (np && Number(np.dist) > 2.5 && Number.isFinite(Number(np.x)) && Number.isFinite(Number(np.z))) {
        out.push({ action: 'move_to', params: { x: NUM(np.x), z: NUM(np.z) }, say: '' });
      }
      out.push({ action: 'harvest', params: {}, say: item.say });
      continue;
    }

    if (name === 'cook') {
      const rawFish = String(p.item || p.what || p.food || p.dish || '').trim();
      const dishMap = {
        鱼: 'fish_common', 生鱼: 'fish_common', 稀有的鱼: 'fish_rare',
        沙拉: 'salad', 果汁: 'juice', 面: 'noodle', 面条: 'noodle', 煮面: 'noodle', 果派: 'pie', 派: 'pie',
      };
      const it = dishMap[rawFish] || (/^(fish_|salad|juice|noodle|pie)/.test(rawFish) ? rawFish : '');
      const fire = link.perception && link.perception.fireNear;
      if (fire && Number(fire.dist) > 2.5 && Number.isFinite(Number(fire.x)) && Number.isFinite(Number(fire.z))) {
        out.push({ action: 'move_to', params: { x: NUM(fire.x), z: NUM(fire.z) }, say: '' });
      }
      out.push({ action: 'cook', params: it ? { item: it } : {}, say: item.say });
      continue;
    }

    if (name === 'drink') {
      out.push({ action: 'drink', params: {}, say: item.say });
      continue;
    }

    if (name === 'buy') {
      const it = String(p.item || p.what || p.goods || '').trim();
      if (!it) { dropped.push('buy 缺 item'); continue; }
      const c = Math.max(1, Math.min(5, Number(p.count || p.num || 1) || 1));
      // 柜台在 3 米内才买得成，离得远就先走过去，别原地硬买
      const shop = link.perception && link.perception.shop;
      const me = link.perception && link.perception.self;
      if (shop && me && Number.isFinite(Number(shop.x)) && Number.isFinite(Number(shop.z))) {
        const d = Math.hypot(NUM(me.x) - NUM(shop.x), NUM(me.z) - NUM(shop.z));
        if (d > 2.5) out.push({ action: 'move_to', params: { x: NUM(shop.x), z: NUM(shop.z) }, say: '' });
      }
      out.push({ action: 'buy', params: { item: it, count: c }, say: item.say });
      continue;
    }

    if (name === 'sell') {
      const it = String(p.item || p.what || p.goods || '').trim();
      if (!it) { dropped.push('sell 缺 item'); continue; }
      const c = Math.max(1, Math.min(5, Number(p.count || p.num || 1) || 1));
      const shop2 = link.perception && link.perception.shop;
      const me2 = link.perception && link.perception.self;
      if (shop2 && me2 && Number.isFinite(Number(shop2.x)) && Number.isFinite(Number(shop2.z))) {
        const d2 = Math.hypot(NUM(me2.x) - NUM(shop2.x), NUM(me2.z) - NUM(shop2.z));
        if (d2 > 2.5) out.push({ action: 'move_to', params: { x: NUM(shop2.x), z: NUM(shop2.z) }, say: '' });
      }
      out.push({ action: 'sell', params: { item: it, count: c }, say: item.say });
      continue;
    }

    if (name === 'sit' || name === 'sleep' || name === 'fish') {
      out.push({ action: name, params: {}, say: item.say });
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
