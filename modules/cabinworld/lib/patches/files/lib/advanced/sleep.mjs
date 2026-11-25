// 睡觉与起床：body.sleep（问作息）→ body.sleepPlan；body.do（床上动作）；body.get → body.state。
// 决策属于住户资料，桥只提供事实：现在是不是夜里、在床上没有、忙不忙。
// 一个字的原则：游戏说没躺下就是没躺下，桥不替她演。

const BED_ACTIONS = ['sit', 'rest', 'cover', 'sleep', 'wake', 'leave'];
const PHASE_TEXT = {
  empty: '站在床边', approaching: '走向床边', edge: '坐在床沿', climbing: '收腿上床', reclining: '靠向枕头',
  lying: '躺着休息', covering: '拉好被子', covered: '盖着被子休息', sleeping: '盖着被子睡觉',
  waking: '刚刚醒来', uncovering: '掀开被子', sitting_up: '在床上坐起', leaving: '双脚落地，下床',
};

const sleepMs = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

export function createSleep({ host, resident, log = () => {} }) {
  const key = resident.key;
  let lastNight = null;
  let lastState = null;

  const nightNow = () => {
    let weather = {};
    try { weather = resident.weatherNow?.() || {}; } catch { weather = {}; }
    return weather.phase === 'night';
  };

  async function state() {
    const { result } = await resident.scope.request('body.get', { at: Date.now() }, { replyType: 'body.state', timeoutMs: 6000 });
    lastState = result;
    return result;
  }

  /** 只问不做的作息决策：sleep / defer / idle / rest / wake。 */
  async function plan(extra = {}) {
    let got = null;
    try { got = await state(); } catch { got = null; }
    const bed = (got && got.bed) || {};
    const facts = {
      night: nightNow(),
      wasNight: lastNight === true,
      inBed: bed.engaged === true,
      busy: Boolean(resident.task),
      scheduled: false,
      holding: bed.engaged === true,
      ...extra,
    };
    const { result } = await resident.scope.request('body.sleep', { facts }, { replyType: 'body.sleepPlan', timeoutMs: 6000 });
    lastNight = facts.night;
    return { decision: String(result.decision || ''), facts, bed };
  }

  /** 发一个床上动作（游戏没有回执，随后用 body.get 看结果）。 */
  function command(action, source = 'resident') {
    const what = String(action || '');
    if (!BED_ACTIONS.includes(what)) throw Object.assign(Error('床上的动作只有：' + BED_ACTIONS.join('、')), { status: 400 });
    const at = Date.now();
    host.send({ type: 'body.do', actor: key, part: 'bed', method: 'command', args: [what, source], at });
    return at;
  }

  /** 动作是渐进的：等到 phase 落到终点（或超时）再回答。 */
  async function settle(action, timeoutMs = 9000) {
    const want = { sleep: 'sleeping', rest: 'lying', cover: 'covered', sit: 'edge', leave: 'empty', wake: null }[action];
    const deadline = Date.now() + timeoutMs;
    let snap = null;
    for (;;) {
      try { snap = await state(); } catch { snap = null; }
      const bed = (snap && snap.bed) || {};
      if (want === null) { if (bed.asleep !== true && bed.phase !== 'sleeping') break; }
      else if (want === 'empty') { if (bed.phase === 'empty' && bed.engaged !== true) break; }
      else if (bed.phase === want) break;
      if (Date.now() > deadline) break;
      await sleepMs(450);
    }
    return snap;
  }

  function describe(snap) {
    const bed = (snap && snap.bed) || {};
    const items = (snap && snap.items) || {};
    const computer = (snap && snap.computer) || {};
    return {
      bed: { phase: bed.phase || '', text: PHASE_TEXT[bed.phase] || bed.phase || '', asleep: bed.asleep === true, engaged: bed.engaged === true, covered: bed.covered === true, revision: bed.revision ?? null, source: bed.source || '', final: (bed.plan && bed.plan.final) || '' },
      items: { phone: items.phone || '', headphones: items.headphones || '', audio: items.audio || '' },
      computer: { phase: computer.phase || '', screen: computer.screen || '' },
    };
  }

  async function doAction(action) {
    const before = await state().catch(() => null);
    const beforeRev = (before && before.bed && before.bed.revision) ?? -1;
    const at = command(action);
    const after = await settle(action);
    const bed = (after && after.bed) || {};
    const accepted = (bed.revision ?? -1) !== beforeRev;
    const summary = describe(after);
    if (!accepted) {
      const why = action === 'wake' ? '不在床上，不用叫醒' : action === 'sleep' ? '已经在床上了' : '游戏没有接受这个床上动作';
      return { ok: false, status: 'done', label: '想' + (action === 'sleep' ? '睡觉' : action === 'wake' ? '起床' : '上床'), result: { ok: false, outcome: why, happened: [], bed: summary.bed, at } };
    }
    const happened = [summary.bed.text ? '现在是' + summary.bed.text : '', summary.bed.asleep ? '睡着了' : ''].filter(Boolean);
    return { ok: true, status: 'done', label: action === 'sleep' ? '睡觉' : action === 'wake' ? '起床' : '上床', result: { ok: true, happened, bed: summary.bed, items: summary.items, at } };
  }

  /** 连接后把宿主记得的身体状态交回游戏（只在有可信快照时）。 */
  function sync(snapshot) {
    if (!host.connected || !snapshot || typeof snapshot !== 'object') return false;
    try { host.send({ type: 'body.sync', actor: key, at: Date.now(), ...snapshot }); return true; }
    catch (error) { log('body.sync 失败：' + error.message); return false; }
  }

  return { plan, state, command, doAction, describe, sync, nightNow, get lastState() { return lastState; } };
}
