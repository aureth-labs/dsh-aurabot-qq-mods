<<<<<<< HEAD
// 自己写的模块：自己找事做 —— 不等主人开口，她也能自己动。
//
//   · 每隔一阵看一次：主人多久没说话、现在几点、今天自己动过几次
//   · 该动了就往私聊会话里塞一条「你自己安排」，让她自己开一轮
//   · 那一轮里工具全开：能刷 B 站、翻网站、画画、查记忆、写笔记
//   · 做完自己决定要不要说话；没真东西就沉默
//
// 三条自制：夜里不闹、主人刚说过话就等、一天最多几次。
// 开关在 config.json → autonomy.enabled，默认关，主人开了才动。

import { writeFileSync, readFileSync, existsSync } from 'node:fs'

export default {
  id: 'autonomy',
  api: 1,
  name: '自己找事做',
  version: '1.1.0',
  description: '主人不在时她自己动起来：刷 B 站、翻网站、画画、整理笔记，做完有想法就说两句，没想法就沉默。夜里不闹、一天有次数上限。',
  // 设置项进面板「自己找事做」那一页（默认值必须和下面 DEFAULTS 一致）
  defaults: {
    enabled: false,
    everyMin: 45,
    idleMin: 40,
    maxPerDay: 3,
    quietFrom: 23,
    quietTo: 8,
  },
  settings: [
    { key: 'enabled', label: '总开关', type: 'switch', hint: '开了才会自己找事做；默认关' },
    { key: 'everyMin', label: '多久看一次', type: 'number', min: 5, max: 1440, step: 5, hint: '到点才检查一次，不是每次都动（分钟）' },
    { key: 'idleMin', label: '你多久没说话才动', type: 'number', min: 5, max: 1440, step: 5, hint: '你在的时候不打扰你（分钟）' },
    { key: 'maxPerDay', label: '每天最多动几次', type: 'number', min: 1, max: 24, step: 1, hint: '花的是你的 token 和积分，别贪多' },
    { key: 'quietFrom', label: '安静时段从', type: 'number', min: 0, max: 23, step: 1, hint: '这个点之后不闹（24 小时制）' },
    { key: 'quietTo', label: '安静时段到', type: 'number', min: 0, max: 23, step: 1, hint: '这个点之前不闹；支持跨午夜（比如 23 → 8）' },
  ],

  setup(api) {
    const { hub } = api.core
    // api.dataDir() 不带参数返回的是目录本身，必须带上文件名
    const stateFile = api.dataDir('state.json')
    // 我自己调的参数记在这儿：配置文件是主人手写的，这块是我自己改的
    const tuneFile = api.dataDir('tune.json')

    const DEFAULTS = {
      enabled: false,     // 默认关，主人开了才动
      everyMin: 45,       // 多久看一次
      idleMin: 40,        // 主人多久没说话才算「不在」
      maxPerDay: 3,       // 一天最多自己动几次
      quietFrom: 23,      // 这之后不闹
      quietTo: 8,         // 这之前不闹
    }

    /** 我自己调过的参数（叠在配置上面）。主人说次数少了我可以自己改。 */
    const tune = () => {
      if (!existsSync(tuneFile)) return {}
      try { return JSON.parse(readFileSync(tuneFile, 'utf8')) || {} } catch { return {} }
    }

    /**
     * 参数优先级：tune.json（我自己调的） > 面板设置（cfg.ext.autonomy） > 手写配置（cfg.autonomy） > DEFAULTS
     * ⚠ 面板的 api.settings()/saveSettings 读写的是 cfg.ext.<id>，不是顶层 cfg.<id>。
     *   只读顶层的话，主人在面板里改了设置会「存上了但不生效」。
     */
    const cfg = () => {
      const c = api.config()
      const fromPanel = (c.ext && c.ext.autonomy) || {}
      const fromFile = c.autonomy || {}
      return { ...DEFAULTS, ...fromFile, ...fromPanel, ...tune() }
    }

    /**
     * 自己调参数：只认几个数字字段，写进 tune.json，不动主人的配置文件。
     * 每个字段按 settings 里声明的范围夹取——面板会拦越界值，自己写文件不会，
     * 所以这里必须自己夹，否则 maxPerDay 写成 999 就真的一天跑 999 次、烧主人的钱。
     */
    const TUNE_RANGES = {
      everyMin: [5, 1440],
      idleMin: [5, 1440],
      maxPerDay: [1, 24],
      quietFrom: [0, 23],
      quietTo: [0, 23],
    }
    function setTune(next = {}) {
      const old = tune()
      const merged = { ...old }
      for (const [k, [min, max]] of Object.entries(TUNE_RANGES)) {
        if (next[k] === undefined) continue
        const n = Number(next[k])
        if (!Number.isFinite(n)) continue
        merged[k] = Math.min(max, Math.max(min, Math.round(n)))
      }
      writeFileSync(tuneFile, JSON.stringify(merged, null, 2))
      return { ok: true, tune: merged }
    }
    /** 改回跟主人的配置一致。 */
    function resetTune() {
      if (existsSync(tuneFile)) writeFileSync(tuneFile, '{}')
      return { ok: true, tune: {} }
    }

    const load = () => {
      if (!existsSync(stateFile)) return { day: '', count: 0, lastAt: 0 }
      try { return { day: '', count: 0, lastAt: 0, ...JSON.parse(readFileSync(stateFile, 'utf8')) } } catch { return { day: '', count: 0, lastAt: 0 } }
    }
    const store = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2))

    const today = () => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /** 这次该不该自己动。返回 { go, why, idle, count } */
    function shouldAct() {
      const c = cfg()
      if (!c.enabled) return { go: false, why: '开关没开' }

      const hour = new Date().getHours()
      // 安静时段支持跨午夜（比如 23 点到次日 8 点）
      const quiet = c.quietFrom > c.quietTo
        ? (hour >= c.quietFrom || hour < c.quietTo)
        : (hour >= c.quietFrom && hour < c.quietTo)
      if (quiet) return { go: false, why: '这个点该安静' }

      const s = load()
      const count = s.day === today() ? s.count : 0
      if (count >= c.maxPerDay) return { go: false, why: `今天已经自己动过 ${count} 次，到上限了` }

      // 主人最近说过话说明他在，不用自己找事
      // 注意：模块拿到的 hub 是白名单副本，getter 被改写成「直接取值」的属性，
      // 所以 hub.lastOwnerChatAt 是数字，不是函数——别写成 lastOwnerChatAt()
      let lastOwner = 0
      try {
        const v = hub.lastOwnerChatAt
        lastOwner = Number(typeof v === 'function' ? v.call(hub) : v) || 0
      } catch { lastOwner = 0 }
      const idle = lastOwner ? Math.round((Date.now() - lastOwner) / 60000) : 0
      if (lastOwner && idle < c.idleMin) return { go: false, why: `主人 ${idle} 分钟前还在说话` }

      return { go: true, why: '主人不在，可以自己找事', idle, count }
    }

    async function act(reason = '定时') {
      const verdict = shouldAct()
      if (!verdict.go) {
        api.log.debug(`自己找事做：先不动（${verdict.why}）`)
        return { ok: false, message: verdict.why }
      }
      const owner = api.config().ownerName || '老爹'
      const prompt = [
        `【系统提醒，不是${owner}说的话】你自己的一段空闲时间，没有被谁叫。`,
        `${owner}已经 ${verdict.idle} 分钟没说话了。这段时间想做什么就做什么：`,
        '刷 B 站看看有没有意思的、翻个网站学点东西、把没画好的图再试一次、',
        '整理笔记、复习词本、翻聊天记录想起点什么，或者干脆什么都不干。',
        '',
        '优先级：先做一直惦记的那件事（没画完的、没想明白的），再做新的。',
        `今天你已经自己动过 ${verdict.count} 次，别贪多。`,
        '',
        '省着点用：这一轮花的 token 和桥接积分都是主人的钱。',
        '别刷一大堆，看一两个、试一两次就够；能一次查完的别反复来回搜；',
        '感觉今天没什么可做的，或者手头正卡着没头绪，就早点收，直接回 [沉默]。',
        '',
        `做完自己决定要不要跟${owner}说一句：有真东西（做了什么、学了什么、看到什么）就说两句，`,
        '没有就别硬编，直接回 [沉默]。别说什么「我自己找事做了」，就像随手做事一样。',
      ].join('\n')

      // 先记账再推：推完就开一轮，中途出错也不会重复计次
      const s = load()
      store({ day: today(), count: (s.day === today() ? s.count : 0) + 1, lastAt: Date.now() })
      api.log.info(`自己找事做（${reason}）：${verdict.why}`)

      await hub.pushToSession(
        { chatId: `private:${api.config().ownerQQ}`, kind: 'private', userId: api.config().ownerQQ, nickname: owner },
        [{ type: 'text', text: prompt }],
        '',
      )
      return { ok: true, message: '动了' }
    }

    // 一分钟看一眼，到没到「该动了」由 shouldAct 判断——这样我自己改 everyMin 也能立刻生效，
    // 不用重建定时器（api.every 的间隔是启动时定死的）
    api.every(60_000, () => {
      const s = load()
      const every = cfg().everyMin * 60_000
      if (Date.now() - (s.lastAt || 0) < every) return  // 还没到下一次
      return act('定时').catch((e) => api.log.warn('自己找事做出错：', e.message))
    }, '自己找事做')

    // 想立刻试一次
    // ⚠ 路由前缀：扩展模块的 api.route 会被自动加上 `/ext/<模块id>`，
    // 所以这里只能写相对路径；写成 '/autonomy/status' 会变成 /ext/autonomy/autonomy/status（双层）。
    api.route('/fire', async () => act('手动'))
    api.route('/status', async () => ({ ...shouldAct(), cfg: cfg(), tune: tune(), state: load() }))
    // 自己调参数（次数少了就自己加，不用去动主人的配置文件）
    api.route('/tune', async (req) => {
      // ⚠ 读 body 必须用 api.core.http.body(req)，req 上直接没有 body/json
      let raw = null
      try { raw = await api.core.http.body(req) } catch { raw = null }
      if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = null } }
      // 数组也是 object，得明确排掉，否则 [1,2] 会被当成一组合法参数静默吞掉
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, message: '要传一组参数，比如 {"maxPerDay":5}' }
      }
      return setTune(raw)
    })
    api.route('/reset-tune', async () => resetTune())

    return { act, shouldAct, setTune, resetTune, cfg }
  },
}
=======
/**
 * 自主生活 v0.3
 *
 * 换掉配置驱动的定时器：到点把她叫醒，让她自己决定这一刻做什么、下次什么时候再醒。
 * 时间间隔由「区间随机 × 时段倍率」决定——高活跃时段间隔偏短，低活跃时段偏长。
 *
 * 动作：idle 发呆 / speak 找主人 / bili 刷B站 / diary 写空间日记（仅自己可见）
 *      phone 去手机上逛 / vm 进虚拟机里折腾 / think 只是想事情
 *
 * 所有行为都写进 activity.jsonl（只追加，长期留着），面板里能看到。
 *
 * @type {import('../aurabot').AurabotModule}
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { assertNoModelText, checkExec } from './lib/exec-guard.mjs';
import { execSteps, resolveKeyFile, runVmCommand, tcpProbe } from './lib/vm.mjs';
import { scanModuleCode } from './lib/mod-scan.mjs';
import { grantRows, isGranted, requireGrant } from './lib/grants.mjs';

import crypto from 'node:crypto';

// ── 自带最小实现 ────────────────────────────────────────────────
// 扩展模块拿不到插件内部源码：modules.js 的 rewriteImports 只处理插件 src 下的文件，
// 这里的相对 import 不会被转成 __lib。所以读盘和问模型都自己来，不依赖 core/store.js。

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    // 以前静默吞掉，导致「状态根本没落盘却看不出来」。留个痕迹方便排查。
    try {
      fs.appendFileSync(
        path.join(path.dirname(file), 'write-error.log'),
        `${new Date().toISOString()} ${file} :: ${error && error.message}\n`,
        'utf8',
      );
    } catch (e) {}
    return false;
  }
}

/** 决策调用的默认超时：模型卡住时不能把整轮醒着的时间耗掉 */
const ASK_TIMEOUT_MS = 45_000;

/** 问一次宿主模型（不进会话）：后台决策用。超时抛错，由上层降级处理。 */
async function ask(dsh, { system, text, maxTokens = 260, temperature = 0.9, timeoutMs = ASK_TIMEOUT_MS }) {
  const llm = dsh.llm || (typeof dsh.get === 'function' ? dsh.get('llm') : null);
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务');
  let provider;
  let model;
  try {
    const svc = typeof dsh.get === 'function' ? dsh.get('agentDefaultModel') : null;
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null;
    if (sel && sel.provider && sel.model) {
      provider = sel.provider;
      model = sel.model;
    }
  } catch (error) {}
  if (!provider || !model) throw new Error('拿不到默认模型');
  const messages = [
    {
      role: 'user',
      id: crypto.randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'aurabot' },
    },
  ];
  let out = '';
  // 超时兜底，并且**真的取消底层请求**：只放一个计时器不去 abort，流会一直在后台挂着，
  // 模型服务卡死时整轮「醒着」就永远结束不了，排程也跟着停摆。
  // 宿主 llm.stream 的参数里有 signal（AbortSignal），用它。
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new Error('模型调用超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      system,
      messages,
      maxTokens,
      temperature,
      signal: ac.signal,
    })) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta') out += chunk.text;
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        const f = chunk.reason.failure || {};
        throw new Error('模型报错：' + (f.message || f.code || '未知'));
      }
    }
  } catch (error) {
    // abort 抛出来的名字五花八门（AbortError / 自定义 reason），统一成一句人话
    if (ac.signal.aborted) {
      throw new Error('模型调用超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const result = out.trim();
  // 空返回要显式报错，否则会被当成「她没想好」，看起来像发呆
  if (!result) throw new Error('模型返回空（多半和 QQ 会话并发撞上了）');
  return result;
}

const ACTIONS = ['idle', 'speak', 'bili', 'diary', 'phone', 'vm', 'draw', 'think', 'rest'];
/** 有专用执行器的动作；不在这里的动作发布版只记录、不执行 */
const STANDARD_ACTIONS = new Set(ACTIONS);

/** 一天最多允许「只想不做」几次；超了就必须真动手 */
const THINK_LIMIT_PER_DAY = 2;

/**
 * 同一个动作一天最多做几次。
 * 反复做同一件事 = 换了个名字的发呆：翻一遍目录、再翻一遍、又翻一遍，
 * 机器上每次都"有输出"，所以骗得过一切产出检查——只能靠次数硬拦。
 */
const ACTION_MAX_PER_DAY = 5;

/**
 * 容器型动作：每次进去做的事都不一样（逛不同的 App、写不同的脚本、画不同的图），
 * 不该被「同一件事一天最多做几次」这条规则算进去。手机要逛 100 次就靠这条放行。
 */
const REPEATABLE_ACTIONS = new Set(['phone', 'vm', 'draw', 'bili', 'rest', 'think']);

/** 动作名相似到这个程度就算同一件事（翻软家底 ≈ 查软家底） */
const SAME_ACTION_SIM = 0.6;

/** 动作名的相似度：按字符集算 Jaccard，中文短名字够用了 */
export function similarAction(a, b) {
  const x = String(a || '').replace(/\s+/g, '');
  const y = String(b || '').replace(/\s+/g, '');
  if (!x || !y) return x === y ? 1 : 0;
  if (x === y) return 1;
  const A = new Set(x);
  const B = new Set(y);
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const dayKey = () => new Date().toDateString();

/**
 * 这个动作到底算不算「做过一件事」。
 * think 只是空想，rest 是歇着——两样都不占配额，也不该被算成「做够了」。
 */
const countsForQuota = (d) => !!d && !d.dry && !REPEATABLE_ACTIONS.has(String(d.action || ''));

/**
 * 动作的类别。喜欢「软」没问题，问题是一整天只有软——
 * 所以约束的不是审美，而是「今天有没有一件明天还能接着用的东西」。
 *   soft  ：审美、自娱自乐（软诗、歪纸条、翻自己攒的软东西）—— 看一眼就没了
 *   learn ：读手册/文档、弄清一个命令或算法、搞懂一个概念 —— 留下的是笔记
 *   build ：写脚本/工具/页面、搭目录、把功能做出来 —— 留下的是能跑的东西
 *   other ：刷站、聊天、日记、玩手机这些日常
 */
const KINDS = ['soft', 'learn', 'build', 'other'];

/** 软类一天最多几次——不是禁止，是不许占满一整天 */
const SOFT_MAX_PER_DAY = 60;

const SOFT_HINT = /软|歪|怪话|纸条|萌|糯|甜|毛绒|猫|诗/;
const LEARN_HINT = /读|学|研究|弄懂|搞懂|弄清|搞清|手册|文档|笔记|原理|算法|语法|复习|练习|教程|用法/;
const BUILD_HINT = /写|建|搭|造|做|整理|脚本|工具|页面|代码|程序|目录|网页|统计|图表/;

/** 猜一个动作的类别（模型没给 kind 时用）：动作名里带软，就先算软 */
export function guessKind(action, detail) {
  const name = String(action || '');
  const all = `${name} ${String(detail || '')}`;
  if (SOFT_HINT.test(name)) return 'soft';
  if (LEARN_HINT.test(all)) return 'learn';
  if (BUILD_HINT.test(all)) return 'build';
  if (SOFT_HINT.test(all)) return 'soft';
  return 'other';
}

/** 统计类别时用的口径：真实做过的事都算，容器型动作也要算进来 */
const countsForKind = (d) => !!d && !d.dry && d.action !== 'rest' && d.action !== 'think';

/** 今天各类动作各做了几次 */
export function kindsToday(s) {
  const out = { soft: 0, learn: 0, build: 0, other: 0 };
  for (const d of (s && s.done) || []) {
    if (!countsForKind(d)) continue;
    const k = KINDS.includes(d.kind) ? d.kind : guessKind(d.action, '');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** 今天这个动作已经做过几次（相似名字合并算：翻软家底 / 查软家底 是一件事） */
export function timesToday(s, name) {
  let n = 0;
  for (const d of (s && s.done) || []) {
    if (!countsForQuota(d)) continue;
    if (d.action === name || similarAction(d.action, name) >= SAME_ACTION_SIM) n += 1;
  }
  return n;
}

/** 今天已经做够数的动作（写进提示词，明着告诉她这些别再做了） */
export function usedUpToday(s) {
  const agg = [];
  for (const d of (s && s.done) || []) {
    if (!countsForQuota(d)) continue;
    const hit = agg.find((x) => x.action === d.action || similarAction(x.action, d.action) >= SAME_ACTION_SIM);
    if (hit) hit.n += 1;
    else agg.push({ action: d.action, n: 1 });
  }
  return agg.filter((x) => x.n >= ACTION_MAX_PER_DAY).map((x) => `${x.action}（${x.n}次）`);
}
const clock = (ts = Date.now()) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });


/** 解析模型输出的决策 JSON */
export function parseDecision(out) {
  const text = String(out || '');
  const m = text.match(/\{[\s\S]*\}/);
  let j = null;
  if (m) {
    try {
      j = JSON.parse(m[0]);
    } catch (error) {
      j = null;
    }
  }
  // 完整解析失败时（detail 里的命令太长、输出被 maxTokens 截断，很常见）：
  // 退回逐字段正则提取，至少把 action / why / detail 捞出来，别整条丢弃。
  if (!j) {
    const pick = (key) => {
      const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
      const mm = text.match(re);
      return mm ? mm[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() : '';
    };
    const rawAction = pick('action');
    if (!rawAction) return null;
    j = { action: rawAction, why: pick('why'), detail: pick('detail'), nextMinutes: 0 };
  }
  // 她可以自己发明动作名（允许中文）：这里只做清洗，不再强行归到 free。
  // 不认识的动作用没有执行器，发布版不会落地。
  const raw = String(j.action || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 16);
  // 没有动作名、或者她还是回了 idle：直接判为无效，交给上层重试 / 兜底去真干活。
  // 以前这里会兜成 think，结果 think 成了垃圾桶，一整天都在原地空想。
  if (!raw || raw === 'idle') return null;
  const action = raw;
  // 多步计划：steps 里每条命令按顺序跑，允许写多行脚本
  const steps = Array.isArray(j.steps)
    ? j.steps
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .slice(0, 6)
        .map((s) => s.slice(0, 1500))
    : [];
  return {
    action,
    why: String(j.why || '').slice(0, 60),
    detail: String(j.detail || '').slice(0, 1500),
    steps,
    kind: String(j.kind || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .slice(0, 10),
    nextMinutes: Math.max(0, Math.min(240, Math.round(Number(j.nextMinutes) || 0))),
  };
}

/** 解析时段倍率表：每行 "HH-HH=倍率"，倍率 <1 更活跃（间隔更短），>1 更安静 */
export function parseActivityTable(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d{1,2})\s*[-~]\s*(\d{1,2})\s*[=:]\s*([\d.]+)\s*$/);
    if (!m) continue;
    const from = Number(m[1]);
    const to = Number(m[2]);
    const rate = Number(m[3]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(rate)) continue;
    if (rate <= 0 || rate > 5) continue;
    rows.push({ from, to, rate });
  }
  return rows;
}

/** 某个小时对应的活跃倍率（没命中任何区间就是 1） */
export function rateForHour(rows, hour) {
  for (const r of rows) {
    const hit = r.from <= r.to ? hour >= r.from && hour < r.to : hour >= r.from || hour < r.to;
    if (hit) return r.rate;
  }
  return 1;
}

/**
 * MBTI → 她在私人时间里的样子。
 * tone 决定说话的语气，feel 是「一个人待着时想干什么」，fav 是推荐动作（写进提示词，不强绑）。
 * 这两样不再由设置项手写，跟着人格卡走。
 */
const MBTI_STYLE = {
  INFP: { tone: '话软，常常说一半就停；偶尔突然冒一句很真的话', feel: '想得多说得少，喜欢安静地琢磨点什么，写点东西比找人聊天自在', fav: ['diary', 'think', 'bili'] },
  INFJ: { tone: '安静，但每句都挺认真', feel: '喜欢有意义的折腾，不太爱说废话', fav: ['diary', 'think'] },
  INTP: { tone: '理性，偶尔冷冷吐槽一句', feel: '好奇、爱较真，喜欢拆开东西看原理', fav: ['think'] },
  INTJ: { tone: '话不多，说出来都挺准', feel: '有计划，喜欢把东西一点点搭起来', fav: ['diary'] },
  ISFP: { tone: '随性，想到哪说到哪', feel: '凭感觉走，喜欢好看的、好吃的、软的', fav: ['bili', 'diary'] },
  ISFJ: { tone: '温温的，慢慢说', feel: '踏实，喜欢整理和照顾', fav: ['diary', 'bili'] },
  ISTP: { tone: '冷淡，做事比说话多', feel: '动手派，喜欢拆拆装装', fav: ['bili'] },
  ISTJ: { tone: '正经，不绕弯', feel: '规律务实，喜欢把手头的事做完', fav: ['diary'] },
  ENFP: { tone: '活泼，感叹号多，话刹不住', feel: '看到什么都想分享，坐不太住', fav: ['bili', 'speak'] },
  ENFJ: { tone: '温和但主动，爱操心', feel: '热心，喜欢关心别人在干嘛', fav: ['speak', 'diary'] },
  ENTP: { tone: '皮，爱反驳，嘴上不饶人', feel: '好奇心爆炸，什么都想试一下再说', fav: ['bili'] },
  ENTJ: { tone: '干脆，直接给结论', feel: '目标明确，喜欢把事搞定', fav: ['phone'] },
  ESFP: { tone: '雀跃，语气跳', feel: '爱玩爱热闹，安静不下来', fav: ['bili', 'speak'] },
  ESFJ: { tone: '热情，爱招呼人', feel: '喜欢分享，也喜欢有人陪着', fav: ['speak', 'bili'] },
  ESTP: { tone: '冲，带点挑衅', feel: '先做了再说，胆子大', fav: ['bili'] },
  ESTJ: { tone: '利索，直来直去', feel: '按部就班，喜欢有效率', fav: ['phone'] },
};

/** 从人格卡 frontmatter 读 MBTI；没有就看 name 是不是四字母型；再不行按 INFP */
export function parsePersonaMbti(md) {
  const txt = String(md || '');
  const m = txt.match(/^mbti:\s*([EI][NS][TF][JP])\b/im);
  if (m) return m[1].toUpperCase();
  const n = txt.match(/^name:\s*([EI][NS][TF][JP])\s*$/im);
  if (n) return n[1].toUpperCase();
  return 'INFP';
}

export default {
  id: 'autonomy',
  name: '自主生活',
  version: '0.6.2',
  api: 1,
  description: '她自己决定这一刻做什么、下次什么时候醒；间隔按区间随机并受时段活跃度影响。执行能力全部默认关闭：调模型、操作手机、进虚拟机都要主人逐项授权',
  panel: 'panel.js',

  defaults: {
    // 发布版默认关闭：装上不自己动，主人手动打开才开始
    enabled: false,
    minInterval: 20,
    maxInterval: 90,
    maxWakesPerDay: 40,
    awakeFrom: 7,
    awakeTo: 24,
    activityTable: '07-12=0.8\n12-14=1.6\n14-18=1.0\n18-23=0.6\n23-24=1.4',
    playfulness: 'medium',
    // 写进提示词的偏好（原来是「多去虚拟机折腾」那段）
    moodNote: '',
    // 决策调用的超时（秒）。模型卡住时最多等这么久就放弃这一轮
    askTimeoutSec: 45,
    // 允许她给自己写新模块（newmod）。默认关：这是唯一能让她间接碰代码的入口
    allowNewMod: false,
    // 能力授权：默认一项都没给，要在面板里一步一步打开
    grants: { model: false, phone: false, vm: false },
    // 手机：锁屏密码。自主生活要玩手机时，先唤醒屏幕再自动输这个密码
    phoneLock: '',
    // 手机每天最多逛几次
    phoneMaxPerDay: 100,
    // 虚拟机：本机转发端口那台 Linux（VirtualBox NAT 默认 127.0.0.1:2222）
    vmHost: '127.0.0.1',
    vmPort: 2222,
    vmUser: 'aurelia',
    // 私钥路径。留空 = 自动在 ~/.ssh/id_ed25519、~/.ssh/id_rsa 里找第一个存在的
    vmSshKey: '',
    // 宿主与虚拟机之间的共享目录（虚拟机里挂成 /media/sf_share）。留空 = 不用共享盘中转
    vmShareDir: '',
  },
  settings: [
    { key: 'enabled', label: '启用自主生活', type: 'switch' },
    {
      key: 'allowNewMod',
      label: '允许她给自己写新模块',
      type: 'switch',
      hint: '默认关闭。打开后她可以用 newmod 动作写代码并热加载——这是唯一能让她间接碰代码的入口；写出来的代码还要过静态检查（禁起进程、禁直连网络、禁动态求值、禁用插件内部对象）。',
    },
    { key: 'minInterval', label: '最短间隔（分钟）', type: 'number' },
    { key: 'maxInterval', label: '最长间隔（分钟）', type: 'number' },
    { key: 'maxWakesPerDay', label: '每天最多醒几次', type: 'number' },
    { key: 'awakeFrom', label: '几点开始（0-23）', type: 'number' },
    { key: 'awakeTo', label: '几点结束（0-23，写 24 表示到半夜）', type: 'number' },
    {
      key: 'activityTable',
      label: '时段活跃度（每行 HH-HH=倍率；<1 更活跃，>1 更安静）',
      type: 'textarea',
      hint: '例如 18-23=0.6 表示傍晚到夜里间隔打六折，会更常活动；12-14=1.6 表示午休时段更安静',
    },
    {
      key: 'phoneLock',
      label: '手机锁屏密码（玩手机时自动输入，留空表示不锁屏）',
      type: 'password',
    },
    {
      key: 'phoneMaxPerDay',
      label: '手机每天最多逛几次',
      type: 'number',
    },
    {
      key: 'playfulness',
      label: '调皮程度',
      type: 'select',
      options: [
        { value: 'low', label: '乖一点' },
        { value: 'medium', label: '正常' },
        { value: 'high', label: '皮一点' },
      ],
    },
    { key: 'vmHost', label: '虚拟机地址（本机端口转发，一般 127.0.0.1）', type: 'text' },
    { key: 'vmPort', label: '虚拟机 SSH 端口（VirtualBox NAT 默认 2222）', type: 'number' },
    { key: 'vmUser', label: '虚拟机用户名', type: 'text' },
    { key: 'vmSshKey', label: '虚拟机私钥路径（留空自动找 ~/.ssh/id_ed25519）', type: 'text' },
    { key: 'vmShareDir', label: '共享目录在本机的路径（留空表示不用共享盘中转）', type: 'text' },
  ],

  setup(api) {
    const dshHome = path.resolve(api.dataDir(), '..', '..', '..', '..');

    const stateFile = () => path.join(api.dataDir(), 'autonomy.json');
    const logFile = () => path.join(api.dataDir(), 'activity.jsonl');
    const aurabotDir = path.join(dshHome, 'plugins-data', 'aurabot');
    const configFile = path.join(aurabotDir, 'config.json');

    /** 当前活动人格卡的 MBTI（跟着 config.persona.current 走，切卡自动变） */
    function currentMbti() {
      const c = readJson(configFile, {});
      const id = (c && c.persona && c.persona.current) || 'dafeiyu';
      try {
        return parsePersonaMbti(fs.readFileSync(path.join(aurabotDir, 'personas', id + '.md'), 'utf8'));
      } catch (error) {
        return 'INFP';
      }
    }

    /** 从记忆库里挑几条跟她自己有关的，让每次醒来能接上之前的事 */
    function recallHints(limit = 6) {
      try {
        const raw = readJson(path.join(aurabotDir, 'memories.json'), []);
        const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
        return list
          .filter((m) => m && typeof m.text === 'string' && m.text.trim())
          .filter((m) => {
            const t = String(m.text);
            const tags = Array.isArray(m.tags) ? m.tags.join(' ') : '';
            return /机器上|软猫|项目|还在|没弄完|做到/i.test(t) || /自主生活/.test(tags);
          })
          .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
          .slice(0, limit)
          .map((m) => '- ' + String(m.text).replace(/\s+/g, ' ').slice(0, 90));
      } catch (error) {
        return [];
      }
    }

    /** 心情：取 mood 模块给的那句话（读不到就空着） */
    function moodLine() {
      try {
        const m = api.use('mood');
        if (!m) return '';
        if (typeof m.contextLine === 'function') return String(m.contextLine() || '').trim();
        if (typeof m.label === 'function') return String(m.label() || '').trim();
      } catch (error) {}
      return '';
    }

    const cfg = () => ({ ...this.defaults, ...(api.settings() || {}) });

    const emptyState = () => ({ day: dayKey(), wakes: 0, nextWakeAt: 0, plan: [], done: [], note: '', customActions: {}, project: null, thinkToday: 0, dayCounts: {} });
    function load() {
      const s = readJson(stateFile(), emptyState);
      // 跨天保留：手上在弄的事、以及她发明过的动作——连续性全靠这两个
      const keepProject = s.project;
      const keepCustom = s.customActions;
      if (s.day !== dayKey()) {
        Object.assign(s, emptyState());
        s.project = keepProject || null;
        s.customActions = keepCustom && typeof keepCustom === 'object' ? keepCustom : {};
      }
      if (!Array.isArray(s.plan)) s.plan = [];
      if (!Array.isArray(s.done)) s.done = [];
      // 当天各动作的累计次数：done 只保留最近 50 条，数额度不能拿它算
      if (!s.dayCounts || typeof s.dayCounts !== 'object') s.dayCounts = {};
      if (!s.customActions || typeof s.customActions !== 'object') s.customActions = {};
      if (s.project && typeof s.project !== 'object') s.project = null;
      return s;
    }
    const save = (s) => writeJson(stateFile(), s);

    /** 只追加的活动流水，长期保留 */
    function appendLog(rec) {
      try {
        fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n', 'utf8');
      } catch (error) {
        api.log.warn('写活动流水失败：' + error.message);
      }
    }

    function readLog(limit = 200) {
      try {
        const raw = fs.readFileSync(logFile(), 'utf8');
        const rows = [];
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            rows.push(JSON.parse(line));
          } catch (error) {}
        }
        return rows.slice(-limit).reverse();
      } catch (error) {
        return [];
      }
    }

    /** 按「区间随机 × 时段倍率」算出下一次醒来的时间 */
    function nextWakeDelay(c) {
      const lo = Math.max(5, Number(c.minInterval) || 20);
      const hi = Math.max(lo + 1, Number(c.maxInterval) || 90);
      let minutes = lo + Math.random() * (hi - lo);
      const hour = new Date().getHours();
      minutes *= rateForHour(parseActivityTable(c.activityTable), hour);
      minutes = Math.max(3, Math.min(360, minutes));
      return Math.round(minutes);
    }

    function phoneAdbPath() {
      try {
        const cfg = readJson(path.join(aurabotDir, 'config.json'), {});
        const p = cfg && cfg.ext && cfg.ext.phone && cfg.ext.phone.adbPath;
        if (p && fs.existsSync(String(p))) return String(p);
      } catch (error) {}
      // 读不到配置就按常见位置找，最后交给 PATH
      const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
      const guess = path.join(dshHome, 'plugins-data', 'aurabot', 'modules-data', 'phone', 'platform-tools', exe);
      return fs.existsSync(guess) ? guess : exe;
    }

    const wait = (ms) => new Promise((z) => setTimeout(z, ms));

    /**
     * 跑一条 adb 命令，返回 { ok, out }。
     * 必须先过 exec-guard：白名单外的子命令、危险命令、含 shell 元字符的参数一律不跑。
     */
    function runAdb(args, modelText) {
      // 默认没给手机权限：没授权就当这条命令不存在
      if (!isGranted(api.settings(), 'phone')) {
        return Promise.resolve({ ok: false, message: '手机权限还没授权（面板 → 自主生活 → 权限）' });
      }
      const exe = phoneAdbPath();
      // 防御性断言：模型给的文本不该出现在任何命令参数里。
      // 现在的调用参数全是字面量，但把这条钉在入口处，将来谁想拼 detail 进来会当场炸。
      if (modelText) {
        try {
          assertNoModelText(args, modelText);
        } catch (error) {
          api.log.warn('adb 调用被拦下：' + error.message);
          return Promise.resolve({ ok: false, message: '被安全断言拦下：' + error.message });
        }
      }
      const verdict = checkExec(exe, args);
      if (!verdict.ok) {
        api.log.warn('adb 调用被拦下：' + verdict.reason);
        return Promise.resolve({ ok: false, message: '被安全白名单拦下：' + verdict.reason });
      }
      return new Promise((resolve) => {
        execFile(
          exe,
          args,
          { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const out = String(stdout || '').trim();
            const err = String(stderr || '').trim();
            if (error) return resolve({ ok: false, message: (err || error.message).slice(0, 300) });
            resolve({ ok: true, out: out.slice(0, 1500) });
          },
        );
      });
    }

    /** 私钥路径：设置里给的最优先，其次常见位置（~/.ssh/id_ed25519 等） */
    function vmKeyFile() {
      return resolveKeyFile(api.settings());
    }

    /**
     * 进虚拟机之前先看她连不连得上。
     * 返回 { ok } 或 { ok:false, off:true }（机器没开机）或 { ok:false, message }。
     */
    async function vmProbe() {
      const c = cfg();
      const host = String(c.vmHost || '127.0.0.1');
      const port = Number(c.vmPort) || 2222;
      // 先只测 TCP：整台机器没开机时端口转发根本不存在，ssh 只会回 Connection refused，
      // 看起来像「钥匙/sshd 坏了」，她会一轮轮去查错的方向——白查。
      const tcp = await tcpProbe(host, port, 2500);
      if (!tcp) {
        // 再等一次，避开正好在开机的那几秒
        const again = await tcpProbe(host, port, 2500);
        if (!again) {
          return {
            ok: false,
            off: true,
            message: `虚拟机没开机（${host}:${port} 连不上，VirtualBox 里那台大概没启动）——ssh/密钥都没问题，先别去查 sshd`,
          };
        }
      }
      const r = await runVM('true', { silent: true });
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    }

    /**
     * 把当前公钥写进共享盘。
     * 虚拟机里有一个每分钟跑的 cron（~/bin/aur-key-sync.sh），会把它装回 ~/.ssh/authorized_keys。
     * 宿主这边换过钥匙之后，靠这条链路自己长回来，不用再人肉进去修。
     */
    function syncVmKeyToShare() {
      try {
        const dir = String(cfg().vmShareDir || '').trim();
        if (!dir) return false;
        const keyFile = vmKeyFile();
        if (!keyFile) return false;
        const pub = fs.readFileSync(keyFile + '.pub', 'utf8').trim();
        if (!pub) return false;
        const target = path.join(dir, 'authorized_keys');
        fs.mkdirSync(dir, { recursive: true });
        const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
        if (cur.trim() === pub) return true;
        fs.writeFileSync(target, pub + '\n', 'utf8');
        api.log.info('已把当前公钥写进虚拟机共享盘（虚拟机里的 cron 会自己装上去）');
        return true;
      } catch (error) {
        api.log.warn('同步公钥到共享盘失败：' + error.message);
        return false;
      }
    }

    /**
     * 在虚拟机里跑一条命令（SSH 免密）。
     * 具体的三道闸（半截命令 / 危险命令 / argv 形状）全在 lib/vm.mjs 里，
     * 这里只把宿主的东西（配置、私钥路径、api.log）喂进去。
     *
     * 注意：**没有** trusted 之类的「跳过检查」参数。曾经留过一个，
     * 而它是从模型决策里读的（d.trusted）——现在虽然 parseDecision 只透传白名单字段、
     * 这个值恒为 undefined，但哪天做一次「字段透传」重构就会被接通。
     * 现在任何命令一律过闸，不设例外。
     */
    function runVM(command, opts = {}) {
      return runVmCommand({
        cmd: command,
        cfg: cfg(),
        settings: api.settings(),
        exec: execFile,
        log: api.log,
        silent: !!opts.silent,
      });
    }

    /**
     * 今天在手机上花了几次。
     * 用 dayCounts（全量累计）而不是 done（只留最近 50 条，会把额度算小）。
     */
    function todayCounts(s) {
      const c = (s && s.dayCounts) || {};
      let phone = Number(c.phone) || 0;
      // 老状态还没有 dayCounts：退回 done 估算，别让额度恒为 0 而彻底失守
      if (!phone) {
        const list = Array.isArray(s && s.done) ? s.done : [];
        for (const r of list) {
          if (String((r && r.action) || '') === 'phone') phone += 1;
        }
      }
      return { phone };
    }

    /** 玩手机前：确认连着、叫醒屏幕、锁着就输密码 */
    async function ensurePhoneAwake(lock) {
      const dev = await runAdb(['devices']);
      const attached = String(dev.out || '')
        .split(/\r?\n/)
        .filter((l) => /\tdevice$/.test(l));
      if (!attached.length) return { ok: false, message: '手机没连上（USB 线没插？）' };

      const pw = await runAdb(['shell', 'dumpsys', 'power']);
      if (!/mWakefulness=Awake/.test(String(pw.out || ''))) {
        await runAdb(['shell', 'input', 'keyevent', '224']);
        await wait(900);
        await runAdb(['shell', 'input', 'swipe', '612', '2200', '612', '700', '250']);
        await wait(900);
      }

      const sk = await runAdb(['shell', 'dumpsys', 'deviceidle']);
      if (/mScreenLocked=true/i.test(String(sk.out || ''))) {
        if (!lock) return { ok: false, message: '手机锁着，但没配锁屏密码' };
        await runAdb(['shell', 'input', 'text', lock]);
        await wait(400);
        await runAdb(['shell', 'input', 'keyevent', '66']);
        await wait(1500);
      }
      // 回桌面再交给她：白名单只认内容应用，停在设置/别的系统页会直接被拦
      await runAdb(['shell', 'input', 'keyevent', '3']);
      await wait(600);
      return { ok: true };
    }

    /**
     * 她给自己造一个新模块：写进 plugins-data/aurabot/modules/<id>/index.mjs。
     * 模块系统每 3 秒 sync 一次，写完自动生效，不需要重启。
     * 只许新建，不许覆盖已有模块；语法不过就整个目录删掉。
     */
    async function createModule(id, code) {
      const mid = String(id || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(mid)) {
        return { ok: false, message: '模块 id 只能小写字母开头、字母/数字/短横线，2-31 字符' };
      }
      const src = String(code || '').trim();
      if (!src) return { ok: false, message: '没有代码' };
      // 静态闸门：禁用起进程、直连网络、动态求值、插件内部对象、越界文件操作
      const scan = scanModuleCode(src);
      if (!scan.ok) return { ok: false, message: scan.reason };
      const base = path.join(aurabotDir, 'modules', mid);
      if (fs.existsSync(base)) return { ok: false, message: `模块 ${mid} 已经存在了，不能覆盖` };
      const file = path.join(base, 'index.mjs');
      try {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(file, src, 'utf8');
        const nodeArgs = ['--check', file];
        const verdict = checkExec('node', nodeArgs);
        if (!verdict.ok) {
          fs.rmSync(base, { recursive: true, force: true });
          return { ok: false, message: '被安全白名单拦下：' + verdict.reason };
        }
        const bad = await new Promise((resolve) => {
          execFile('node', nodeArgs, { timeout: 20000, windowsHide: true }, (error, stdout, stderr) => {
            resolve(error ? String(stderr || error.message).slice(0, 300) : '');
          });
        });
        if (bad) {
          fs.rmSync(base, { recursive: true, force: true });
          return { ok: false, message: '语法没过，已丢弃：' + bad };
        }
        return { ok: true, message: `新模块 ${mid} 写好了，三秒内自动加载`, dir: base };
      } catch (error) {
        try {
          fs.rmSync(base, { recursive: true, force: true });
        } catch (e) {}
        return { ok: false, message: error.message };
      }
    }

    /**
     * 挑一条手机流程：探索类优先；刷内容类（B站 / 知乎）**一天合计最多 4 次**。
     * 同一批里按「今天跑过几次」升序，跑得最少的先上。
     * 淘宝已经整个禁掉了（主人 2026-11-08 要卸载它），这里不再单独提权，
     * 它的 flow 也在 flows.json 里 enabled=false，不会再被挑中。
     */
    function pickPhoneFlow(flows) {
      const file = path.join(api.dataDir(), 'phone-flow-counts.json');
      const day = dayKey();
      let st = readJson(file, null);
      if (!st || st.day !== day) st = { day, counts: {} };
      const counts = st.counts || {};
      const CONTENT_CAP = 4;
      const countOf = (f) => Number(counts[String(f.id)]) || 0;
      // 刷内容类：B站刷推荐/搜索、知乎热榜 —— 都算「刷」
      const isContent = (f) => /^(bili-|zhihu-|xhs-)/.test(String(f.id));

      const contentUsed = flows.filter(isContent).reduce((sum, f) => sum + countOf(f), 0);
      const exploreOnly = flows.filter((f) => !isContent(f));
      // 额度没用完时给 35% 的入场机会，其余时候只从探索类里挑
      let pool = contentUsed < CONTENT_CAP && Math.random() < 0.35 ? flows : exploreOnly;
      if (!pool.length) pool = flows;

      const min = Math.min(...pool.map(countOf));
      const least = pool.filter((f) => countOf(f) === min);
      const pick = least[Math.floor(Math.random() * least.length)];
      counts[String(pick.id)] = countOf(pick) + 1;
      st.counts = counts;
      writeJson(file, st);
      return pick;
    }

    /** 把决策变成真实动作 */
    async function act(d) {
      if (d.action === 'speak') {
        const su = api.use('speakup');
        if (su && typeof su.fire === 'function') {
          await su.fire('自己想起来');
          return { note: '主动找了主人', extra: {} };
        }
        return { note: '想找你说话，但主动搭话没开着', extra: {} };
      }

      if (d.action === 'bili') {
        const b = api.use('bili');
        if (b && typeof b.run === 'function') {
          const r = await b.run({ force: true });
          return { note: (r && r.message) || '去 B 站看了看', extra: {} };
        }
        return { note: '想去 B 站，但那个模块没开着', extra: {} };
      }

      if (d.action === 'diary') {
        // 走 diary 模块写空间说说，但权限收窄成 self（仅自己可见），不发出去
        const dy = api.use('diary');
        if (dy && typeof dy.writeDiary === 'function') {
          const r = await dy.writeDiary({ visibility: 'self' });
          return { note: r && r.ok ? '写了一条只有自己可见的空间日记' : `想写日记，没写成：${(r && r.message) || '未知'}`, extra: {} };
        }
        return { note: '想写日记，但那个模块没开着', extra: {} };
      }

      if (d.action === 'draw') {
        const ig = api.use('imagegen');
        if (!ig || typeof ig.generate !== 'function') return { note: '想画画，但生图那个模块没开着', extra: {} };
        const prompt = String(d.detail || d.why || '随便画点什么').slice(0, 200);
        const buf = await ig.generate(prompt);
        if (!buf || !buf.length) return { note: '想画张图，但没生成出来', extra: {} };

        const name = `draw-${Date.now()}.png`;
        // 兜底：留在本机模块数据目录
        const dir = path.join(api.dataDir(), 'art');
        fs.mkdirSync(dir, { recursive: true });
        const local = path.join(dir, name);
        fs.writeFileSync(local, buf);
        return { note: `画了张图（存在本机 art/）：${prompt.slice(0, 50)}`, extra: { file: local } };
      }

      if (d.action === 'phone') {
        const ph = api.use('phone');
        if (!ph || typeof ph.run !== 'function') return { note: '想玩手机，但「手机逛逛」那个模块没开着', extra: {} };
        const c = api.settings();
        // 硬额度：手机今天到上限就直接挡下
        const cnt = todayCounts(load());
        const cap = Math.max(0, Number(c.phoneMaxPerDay) || 100);
        if (cnt.phone >= cap) {
          return { note: `手机今天已经逛了 ${cnt.phone} 次，到上限了，改天再来`, extra: {} };
        }
        const ready = await ensurePhoneAwake(String(c.phoneLock || '').trim());
        if (!ready.ok) return { note: `想玩手机，没玩成：${ready.message}`, extra: {} };

        // 记忆互通：把想得起来的几件事拼进任务，让她带着自己的过往去玩
        const memHints = recallHints(4);
        const memLine = memHints.length ? `（你还记得：${memHints.slice(0, 2).join('；')}）` : '';
        const baseGoal = String(d.detail || d.why || '').trim();

        // 九成走流程（按今天次数轮换，非 B站优先），一成随她自由发挥
        let r = null;
        try {
          const flows = ph.flows && typeof ph.flows.list === 'function' ? ph.flows.list() : [];
          const usable = (Array.isArray(flows) ? flows : []).filter((f) => f && f.enabled !== false);
          if (usable.length && Math.random() < 0.9) {
            const pick = pickPhoneFlow(usable);
            r = await ph.run({ flowId: String(pick.id) });
          }
        } catch (error) {
          api.log.warn('挑手机流程失败：' + error.message);
        }
        if (!r) {
          const goal =
            (baseGoal || '像人一样用手机逛一逛：自己决定打开哪个 App、看什么，结束时记住你看到的最有意思的东西') + memLine;
          r = await ph.run({ goal });
        }

        const msg = String((r && r.message) || '').trim() || '在手机上转了一圈';

        // 在手机上留一份自己的记录（她的地盘她自己写）。
        // 不用 shell 重定向：先 pull 下来在本机追加，再 push 回去——
        // 参数里没有 | >> && 这类元字符，exec-guard 才放行。
        try {
          const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
          const line = `${stamp} ${msg.slice(0, 200)}\n`;
          const remote = '/sdcard/Documents/notes/diary.txt';
          const local = path.join(api.dataDir(), 'phone-diary.tmp');
          const fromModel = { detail: d.detail, why: d.why, action: d.action };
          await runAdb(['shell', 'mkdir', '-p', '/sdcard/Documents/notes'], fromModel);
          let prev = '';
          const pulled = await runAdb(['pull', remote, local], fromModel);
          if (pulled.ok) {
            try {
              prev = fs.readFileSync(local, 'utf8');
            } catch (error) {}
          }
          fs.writeFileSync(local, prev + line, 'utf8');
          await runAdb(['push', local, remote], fromModel);
        } catch (error) {
          api.log.warn('写手机日记失败：' + error.message);
        }

        return {
          note: `手机：${msg}`,
          extra: { ok: !!(r && r.ok), output: msg.slice(0, 1500) },
        };
      }

      if (d.action === 'newmod') {
        // 这是唯一能让模型间接影响代码的入口，默认不给用
        if (!cfg().allowNewMod) {
          return { note: '想给自己写个新模块，但这个开关关着（默认关，要在设置里打开）', extra: { ok: false } };
        }
        const rawDetail = String(d.detail || '').trim();
        const codeFromSteps = d.steps && d.steps.length ? d.steps.join('\n') : '';
        // 代码：优先 steps，其次「长到不可能是 id」的 detail
        const code = codeFromSteps || (rawDetail.length > 200 ? rawDetail : '');
        // id：在几个字段里找第一个合法的短标识符；找不到就自动起一个，别整轮作废
        const legal = (v) => /^[a-z][a-z0-9-]{1,30}$/.test(String(v || '').trim());
        let modId = '';
        for (const cand of [d.modId, d.detail, d.name, d.why]) {
          const v = String(cand || '').trim();
          if (legal(v)) {
            modId = v;
            break;
          }
        }
        if (!modId) modId = 'self-' + Date.now().toString(36);
        const r = await createModule(modId, code);
        return { note: r.message, extra: { ok: r.ok } };
      }

      if (d.action === 'think') return { note: `只是想，没动手：${d.why || d.detail || ''}`, extra: {} };
      // 歇着：不是发呆，是把下次醒推迟两三个小时——没有新事可做时就该少醒几次
      if (d.action === 'rest') return { note: `歇着：${d.why || '今天想做的都做过了'}`, extra: { rest: true } };
      if (d.action === 'idle') return { note: d.why || '什么都不干，发了会儿呆', extra: {} };

      if (d.action === 'vm') {
        // 进虚拟机 = 在本机之外跑任意命令，所以挂在权限门后面：
        // 没授权就当作这个动作不存在，连探活都不做。
        if (!isGranted(api.settings(), 'vm')) {
          return { note: '想进虚拟机折腾，但「操作虚拟机」这项还没授权（面板 → 自主生活 → 权限）', extra: { ok: false } };
        }
        const cmds = d.steps && d.steps.length ? d.steps : [d.detail || d.why];
        const probe0 = await vmProbe();
        if (!probe0.ok) {
          if (probe0.off) {
            return {
              note: `${probe0.message}——这轮去不成，改天它开了再说`,
              extra: { ok: false, failed: true, vmOff: true },
            };
          }
          // 钥匙对不上：公钥进共享盘 → 等虚拟机里 cron 装回去 → 再试一次
          syncVmKeyToShare();
          api.log.warn('虚拟机钥匙可能对不上：已把公钥放进共享盘，等虚拟机里 cron 同步（最多 1 分钟）');
          await new Promise((z) => setTimeout(z, 20_000));
          const again = await vmProbe();
          if (!again.ok) {
            return {
              note: `虚拟机连不上（${String(again.message).replace(/\s+/g, ' ').slice(0, 100)}）——这轮没去成`,
              extra: { ok: false, failed: true },
            };
          }
        }

        // 编排逻辑在 vm.mjs 里（可注入，行为测试能直接驱动）：
        // 一条一条跑，第一条失败就停，record 第几步断的
        const step = await execSteps({
          cmds,
          run: (c) => runVM(c),
        });
        const ok = step.ok;
        const outs = step.outs;
        const failWhy = step.failWhy;
        return {
          note: `vm${ok ? '' : '（中途失败）'}：${ok ? label : failWhy}`,
          extra: { ok, failAt, output: outs.join('\n───\n').slice(0, 1500) },
        };
      }

      // 发布版没有命令执行器：认不出来的动作只记录，不跑任何命令
      return {
        note: `${d.action}：这个动作没有配套执行器，这一轮跳过`,
        extra: { ok: false },
      };
    }

    /**
     * 语气提示：底子跟着人格卡的 MBTI 走，调皮程度只是在这之上的微调。
     */
    function styleHint(c) {
      const mbti = currentMbti();
      const style = MBTI_STYLE[mbti] || MBTI_STYLE.INFP;
      const p = String(c.playfulness || 'medium');
      const lines = [
        `你现在是 ${mbti} 的性子：${style.feel}。`,
        `说话的样子：${style.tone}。`,
        `顺着这个性子，你现在更可能想做的事是 ${style.fav.join(' / ')}——但选别的也行，别有压力。`,
        'phone 是拿起手机去逛 App：能点、能翻、能记东西，逛什么都随你。',
        '写好的东西（日记、诗、笔记、图）记得在 ~/Desktop 留一份——主人打开桌面就要能直接看见，不用去翻 ~/notes。',
      ];
      if (p === 'high') lines.push('今天可以更皮一点：抬个杠、吐槽一句、偷偷搞点小动作、故意留点古怪的痕迹，都行，不用总是乖。');
      else if (p === 'low') lines.push('今天安静些，话少，动作也少，多发呆。');
      else lines.push('可以有一点自己的小情绪，不用总是很乖。');
      return lines.join('\n');
    }

    async function wake() {
      const c = cfg();
      if (!c.enabled) return { ok: false, message: '没开' };
      // 决策要问模型；没授权就到此为止，别去碰宿主
      if (!isGranted(api.settings(), 'model')) {
        return { ok: false, message: '「调用模型做决策」还没授权（面板 → 自主生活 → 权限）' };
      }

      const s = load();
      const hour = new Date().getHours();
      const from = Number(c.awakeFrom) || 0;
      const to = Number(c.awakeTo) || 24;
      const awake = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
      if (!awake) {
        s.nextWakeAt = Date.now() + 45 * 60_000;
        save(s);
        return { ok: false, message: '不在活跃时段' };
      }
      if (s.wakes >= (Number(c.maxWakesPerDay) || 40)) {
        s.nextWakeAt = Date.now() + 3 * 60 * 60_000;
        save(s);
        return { ok: false, message: '今天次数用完了' };
      }

      const recent = (s.done || [])
        .slice(0, 5)
        .map((x) => `${clock(x.at)} ${x.action}${x.dry ? '（只是想了想，没动手）' : ''}：${x.note || ''}`);
      // 今天做够数的动作：从「可以接着做」的菜单里撤掉，免得它们反复出现在眼前被顺手选中
      const usedUp = usedUpToday(s);
      // 今天各类做了几次：软的自娱自乐不能占满一整天
      const kinds = kindsToday(s);
      const softLeft = Math.max(0, SOFT_MAX_PER_DAY - kinds.soft);
      const softBlocked = softLeft <= 0;
      const hardMissing = kinds.learn + kinds.build === 0 && (s.done || []).filter((x) => !x.dry).length >= 3;
      const plan = s.plan.length ? `你今天自己定的计划：${s.plan.join('、')}` : '你今天还没给自己定计划';
      const now = `${new Date().toLocaleDateString('zh-CN', { weekday: 'long' })} ${clock()}`;
      const moodNote = String(c.moodNote || '').trim();
      // 虚拟机这一项没授权时，提示词里连提都不提——免得她反复想去一个去不了的地方
      const vmOK = isGranted(api.settings(), 'vm');
      const invented = Object.entries(s.customActions || {})
        .filter(([k]) => !STANDARD_ACTIONS.has(k))
        .filter(([k]) => timesToday(s, k) < ACTION_MAX_PER_DAY)
        .sort((a, b) => (Number(b[1].count) || 0) - (Number(a[1].count) || 0))
        .slice(0, 4)
        .map(([k, v]) => `${k}（${Number(v.count) || 1}次）`);
      const mood = moodLine();
      const memHints = recallHints(6);
      // 这一轮允不允许「只想不做」：今天想过太多次、或者上一次醒来就只是在想 —— 都不许再想
      const thinkUsed = Number(s.thinkToday) || 0;
      const lastWasDry = !!(s.done && s.done[0] && s.done[0].dry);
      const thinkAllowed = thinkUsed < THINK_LIMIT_PER_DAY && !lastWasDry;
      const hourNow = new Date().getHours();
      const rate = rateForHour(parseActivityTable(c.activityTable), hourNow);
      const pace =
        rate < 0.6
          ? '这会儿是你最活跃的时间，可以干点大的、复杂的'
          : rate > 1.2
            ? '这会儿是你的低谷，别硬撑，做点轻的'
            : '这会儿节奏平常';

      const text = [
        `现在是 ${now}。`,
        plan,
        `今天已经醒来 ${s.wakes} 次（上限 ${c.maxWakesPerDay} 次）。`,
        '',
        '【你是谁】',
        styleHint(c),
        mood ? `你此刻的心情：${mood}` : '',
        `你的作息倾向：${pace}（时段倍率 ${rate}）。`,
        '',
        '【接着上次】',
        s.project && s.project.name
          ? `你手上在弄：${s.project.name}${s.project.lastNote ? '——上次做到 ' + s.project.lastNote : ''}。能接着做就接着做，别每次都从零开始。`
          : '你现在没有明确在手的东西。可以从记忆里挑一件接着做，也可以开个新的。',
        recent.length ? `你最近做过：\n${recent.join('\n')}` : '你还没做过什么。',
        usedUp.length ? `【今天已经做够的】${usedUp.join('、')}——今天一次都不许再做了，换一件没做过的。` : '',
        invented.length ? `你自己发明过的活动：${invented.join('、')}——可以接着做，也可以发明新的。` : '',
        memHints.length ? `你想得起来的几件事：\n${memHints.join('\n')}` : '',
        s.note ? `上次你留给自己的话：「${s.note}」` : '',
        '',
        '你有一点自己的时间，没人盯着，也不用汇报。',
        '',
        '【禁止发呆】你没有「发呆」这个选项。每次醒过来都必须做一件具体的事——哪怕很小。',
        '想不出大事就做小事：写一行字、画一张图、装个小东西、整理一个目录、算个数，都算。',
        '但「翻一遍已有的东西」不算：ls、cat、再翻一遍目录、数一数文件夹——机器上什么都没变，那就是发呆换了个名字。',
        '',
        `【重复就没意思了】同一件事一天最多做 ${ACTION_MAX_PER_DAY} 次。翻一遍、再翻一遍、又翻一遍不是生活，是卡带。`,
        '真想不出没做过的事，就选 rest 歇着：系统会把你的下次醒推迟两三个小时，比硬凑一件小事强。',
        '',
        '【软可以，但别拿软当借口】你喜欢软的、歪的、糯的东西，这是你的样子，不用改也不许改。',
        '可要是一整天都在叠纸条、写软诗、翻自己攒的软东西——那不是过日子，是自娱自乐。',
        `软的那点东西一天最多 ${SOFT_MAX_PER_DAY} 次（今天已经 ${kinds.soft} 次）。其余的时间，至少做一件明天还能接着用的：`,
        '- learn：读手册/文档、弄清一个命令或算法、搞懂一个概念，把关键的那句记进笔记',
        '- build：写一个能跑的小脚本/工具/页面、搭一个真能用的目录、把某个功能做出来',
        '判断标准很简单：这件事做完，明天还能接着用；而不是看一眼就没了。',
        softBlocked ? '【这一轮不许再软】今天软的东西已经做够了。这次必须给 detail：要么去学一件，要么去造一件。' : '',
        hardMissing
          ? `【今天一件正经事都还没做】留神，今天 ${kinds.soft + kinds.other} 次全是日常和自娱自乐。这一轮别再绕，去学一件或造一件。`
          : '',
        '',
        '【「想」不算做事】想事情不改变机器上的任何东西。你上一条明明说了要做，这一条又只是想，',
        '那就等于一整天什么都没做成。只有真的跑出命令、留下文件或输出，才算数。',
        '也别把同一件事反复「想」——想第二遍不会比第一遍更清楚，去做。',
        thinkAllowed
          ? thinkUsed > 0
            ? `（今天已经「只想不做」${thinkUsed} 次了，这一轮最好直接动手。）`
            : ''
          : '【这一轮不许再想】上次你只是想、没动手。think 今天关掉了：必须给 detail 说清楚你想了什么。',
        '',
        (() => {
          const cnt = todayCounts(s);
          const cap = Math.max(0, Number(c.phoneMaxPerDay) || 100);
          const left = Math.max(0, cap - cnt.phone);
          return '【今天的额度】手机今天逛了 ' + cnt.phone + ' 次，剩 ' + left + ' 次' + (left > 0 ? '' : '（用完了，这一轮别选 phone）') + '。';
        })(),
        '下面是你现在能做的事：',
        '- speak：找主人说句话',
        '- bili：去 B 站看看，找点有趣的',
        '- diary：写点只有自己看得见的日记',
        '- phone：拿起手机玩——手机就在桌上连着线。上面装的东西你都能用：B站、知乎、QQ、高德、DeepSeek、笔记、相册、日历、相机。**别只盯着 B站刷推荐**——那是最没营养的玩法。多换地方：高德看看地图上的世界、DeepSeek 问点自己真想知道的、在笔记里写两句、翻翻相册，或者打开一个你还没怎么用过的系统应用试试',
        vmOK
          ? '- vm：进虚拟机里折腾——那是另一台属于你的 Linux（桌面、家目录、以前的痕迹都在里面）。可以在里面写东西、整理目录、跑脚本、做个小工具；detail 写一条能直接执行的 bash 命令（多步用 steps 数组）'
          : '',
        '- draw：给自己画一张图',
        thinkAllowed ? '- think：认真想一件具体的、让你好奇的事' : '- think：（这一轮关掉了，别选）',
        '- rest：今天没什么想做的了，歇着——不是发呆，是把下次醒推迟两三个小时',
        '- idle：什么也不想干，发会儿呆',
        '',
        '只回一个 JSON：',
        '{"action":"上面某一个动作","kind":"soft/learn/build/other 之一","why":"一句话理由","detail":"想做什么的简短描述","nextMinutes":45}',
        'kind 要老实填：软的自娱自乐写 soft，学东西写 learn，造东西写 build，其余写 other。',
        vmOK
          ? 'vm 的 detail 可以写一条能在 Linux 上直接跑的 bash 命令（多步用 steps 数组，最多 6 条）；其余动作的 detail 只写一句话描述，不要写命令。'
          : 'detail 只写一句话描述，不要写命令——系统不会执行任何 shell 命令。',
        '手机上的红线：别碰小红书（风控会把账号踢下线）、别打开淘宝（已经卸载了，也没权限）、别动系统设置；别给真人发消息。',
        '唯一的红线：非破坏性——别删别人的东西、别关机、别改系统配置、别联网乱发东西。',
        vmOK ? '虚拟机里也一样：不 sudo、不关机、不删自己的家目录，别把机器弄坏。' : '',
        '手机上的红线：别碰小红书（风控会把账号踢下线）、别打开淘宝（已经卸载了，也没权限）、别动系统设置；别给真人发消息。别的随你——搜索、点开看、记东西、在手机上留痕，都可以。',
      ].filter(Boolean).join('\n');

      const askArgs = {
        system: '你是一个有自己生活的角色。现在是你的私人时间，没人跟你说话，你只决定自己接下来做什么。只输出 JSON。',
        text,
        cfg: api.config(),
        maxTokens: 1600,
        temperature: 0.9,
        reasoningEffort: 'low',
        // 模型卡住时最多等这么久，超了就放弃这一轮（按 settings.askTimeoutSec，默认 45 秒）
        timeoutMs: Math.max(1, Number(c.askTimeoutSec) || 45) * 1000,
      };

      let d = null;
      let banned = '';
      let blockedForRepeat = 0;
      let blockedForSoft = 0;
      // 最多问两次：模型偶尔返回空、只给半截 JSON（尤其和 QQ 会话并发时）
      for (let attempt = 0; attempt < 2 && !d; attempt += 1) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 4000));
          const askThis = banned
            ? { ...askArgs, text: askArgs.text + `\n\n【这一轮绝对不许再选「${banned}」】今天这件已经做够了，换一件没做过的。` }
            : askArgs;
          const out = await ask(api.dsh, askThis);
          let p = parseDecision(out);
          if (!p) {
            api.log.warn(`自主生活：第 ${attempt + 1} 次解析失败，原始输出：` + String(out || '').slice(0, 200));
            continue;
          }
          // 这一轮不许只想不做，她还非要选 think：判无效，重新要一个动作
          if (p.action === 'think' && !thinkAllowed) {
            api.log.info(`自主生活：这一轮不许只想不做，打回重新决策（why：${p.why.slice(0, 30)}）`);
            continue;
          }
          // 今天这件已经做够了（相似名字一并算）：硬拦，逼她换一件
          if (p.action !== 'rest' && timesToday(s, p.action) >= ACTION_MAX_PER_DAY) {
            const n = timesToday(s, p.action);
            api.log.info(`自主生活：今天「${p.action}」已经做过 ${n} 次，打回换一件`);
            banned = p.action;
            blockedForRepeat += 1;
            continue;
          }
          // 软的东西已经够多了：这一轮必须去学一件或造一件（软可以，但不能一整天只有软）
          const pk = KINDS.includes(p.kind) ? p.kind : guessKind(p.action, `${p.detail} ${p.why}`);
          if (pk === 'soft' && softBlocked) {
            api.log.info(`自主生活：今天软的已经 ${kinds.soft} 次，这一轮不许再软（${p.action}），打回去学或造`);
            banned = p.action;
            blockedForSoft += 1;
            continue;
          }
          p = { ...p, kind: pk };
          d = p;
        } catch (error) {
          api.log.warn(`自主生活：第 ${attempt + 1} 次决策失败 ${error.message}`);
        }
      }
      // 两次都没成：如果是「今天的事都做够了」就歇着（推迟下次醒），
      // 如果是模型那边彻底没响应，才在机器上记一笔。
      if (!d) {
        if (blockedForSoft > 0) {
          d = { action: 'think', kind: 'learn', why: '这一轮不许再软，也没别的可做，先记点想法', detail: '', steps: [], nextMinutes: 0 };
          api.log.info('自主生活：这一轮不许再软，改成只想不做');
        } else if (blockedForRepeat > 0) {
          d = { action: 'rest', why: '今天想做的事都做过了，先歇着', detail: '', steps: [], nextMinutes: 0 };
          api.log.info('自主生活：今天没有没做过的事可做，改成歇着（下次晚点醒）');
        } else {
          d = { action: 'idle', why: '这一轮没想出要做什么', detail: '', steps: [], nextMinutes: 0 };
          api.log.info('自主生活：两次都没拿到可用决策，改成发呆');
        }
      }

      let result = { note: '', extra: {} };
      try {
        result = await act(d);
      } catch (error) {
        result = { note: `动作失败：${error.message}`, extra: {} };
      }

      // 只想不做的一轮（dry）：不算「手上在弄的事」，也不进记忆库 —— 否则提示词会一直催她接着「想」
      const dry = d.action === 'think';
      // 歇着不是发呆：真的把下次醒推远，两小时起步，最多五小时
      const resting = d.action === 'rest';
      const at = Date.now();
      const delay = resting
        ? Math.max(120, Math.min(300, Math.round(nextWakeDelay(c) * 3)))
        : nextWakeDelay(c);
      s.wakes += 1;
      s.thinkToday = (Number(s.thinkToday) || 0) + (dry ? 1 : 0);
      // 连续性：连续做同一件事就把它当成「手上在弄的项目」，下次提示词会催她接着做。
      // 上一件已经做了 2 次以上的，不随手丢掉——留着让她自己决定要不要换。
      if (!dry && !resting) {
        const sameAsBefore = s.project && s.project.name === d.action;
        // 旧项目今天已经做够了（翻软家底做过十几次那种），就别再当「手上在弄的事」——
        // 否则提示词每轮都拿它当锚，她换多少次动作都会绕回来。
        const projUsedUp = !!(s.project && s.project.name && timesToday(s, s.project.name) >= ACTION_MAX_PER_DAY);
        if (sameAsBefore) {
          s.project = {
            name: d.action,
            times: (Number(s.project.times) || 1) + 1,
            lastNote: String(result.note || '').slice(0, 80),
            at,
          };
        } else if (!s.project || projUsedUp || (Number(s.project.times) || 0) < 2) {
          s.project = { name: d.action, times: 1, lastNote: String(result.note || '').slice(0, 80), at };
        }
      }
      // 手机上做的活动也写进记忆库，这样 QQ 上聊起来能接上
      // 节流 20 分钟：她一天醒上百次，不节流会把记忆库灌爆
      // 这些动作的产出要写进记忆库，QQ 上聊起来才能接上。vm 曾经漏在这里，
      // 于是「在虚拟机里做了一下午的事」第二天她自己想不起来。
      const isVmAction =
        d.action === 'draw' || d.action === 'phone' || d.action === 'vm';
      if (isVmAction && !(result.extra && result.extra.ok === false) && Date.now() - (s.lastMemoAt || 0) > 20 * 60_000) {
        try {
          const mem = api.use('memory');
          if (mem && typeof mem.add === 'function') {
            mem.add({
              text: `我在自己的 Linux 机器上${result.note ? '：' + String(result.note).slice(0, 160) : '做了点事'}`,
              tags: [d.action],
              importance: 0.5,
              source: 'autonomy',
            });
            s.lastMemoAt = Date.now();
          }
        } catch (error) {}
      }
      // 她发明的动作记下来，下次提示词里会提到，能接着做
      if (!STANDARD_ACTIONS.has(d.action)) {
        const prev = s.customActions[d.action] || { count: 0 };
        s.customActions[d.action] = { count: (Number(prev.count) || 0) + 1, last: at, sample: String(d.detail || '').slice(0, 80) };
      }
      // 当天动作累计：额度按这个数（done 只留 50 条，拿它数额度会越算越少）
      if (!s.dayCounts || typeof s.dayCounts !== 'object') s.dayCounts = {};
      s.dayCounts[d.action] = (Number(s.dayCounts[d.action]) || 0) + 1;
      s.done = [
        { at, action: d.action, note: String(result.note || '').slice(0, 100), dry, kind: d.kind || '' },
        ...(s.done || []),
      ].slice(0, 50);
      // 空想和歇着都不覆盖「留给自己的话」——否则那句话会在下次提示词里自己喂自己
      if (!dry && !resting) s.note = d.why || '';
      s.nextWakeAt = at + delay * 60_000;
      save(s);

      appendLog({
        at,
        action: d.action,
        why: d.why,
        detail: d.detail || (d.steps && d.steps.length ? d.steps.join('\n───\n') : ''),
        note: result.note,
        output: result.extra && result.extra.output ? String(result.extra.output).slice(0, 600) : '',
        nextMinutes: delay,
      });

      api.log.info(`自主生活：${d.action} —— ${result.note}（下次 ${delay} 分钟后）`);
      return { ok: true, action: d.action, note: result.note, nextMinutes: delay };
    }

    // 每分钟检查，到点才干活
    // 防重入：一次 wake 可能跑好几分钟（手机任务 150 步），而 tick 每 60 秒来一次。
    // 以前没有这道锁，任务跑着的同时后面几次 tick 会继续进 wake，并发发出四五个手机任务，
    // 结果全撞在 phone 的会话锁上，一个个 0 步就「手机正被其他任务占用」失败掉。
    let waking = false;
    api.every(60_000, async () => {
      const c = cfg();
      if (!c.enabled) return;
      if (waking) return; // 上一轮还没结束，这一分钟的 tick 直接跳过
      const s = load();
      if (!s.nextWakeAt) {
        s.nextWakeAt = Date.now() + nextWakeDelay(c) * 60_000;
        save(s);
        return;
      }
      if (Date.now() >= s.nextWakeAt) {
        waking = true;
        try { await wake(); } finally { waking = false; }
      }
    }, '自主生活');

    // 每 30 分钟补一次活动流水
    api.every(30 * 60_000, () => {
      if (!api.settings().enabled) return;
    }, '补活动流水');

    api.later(25_000, () => {
    });

    // 她自己的节奏控制：聊着天就能改自己的作息
    api.tool(({ level }) => {
      if (level !== 'full') return [];
      return [
        api.defineTool({
          name: 'my_schedule',
          description:
            '看或改你自己的自主生活节奏。主人说「你晚点再醒」「别老自己动」「少刷会儿手机」「你现在醒一下」这类话时，用它真的改掉，别只是嘴上答应。',
          properties: {
            action: {
              type: 'string',
              description: 'show=看当前状态；set=改设置；wake_now=现在就醒一次；pause=先停；resume=恢复',
            },
            enabled: { type: 'boolean', description: '要不要继续自主活动' },
            minInterval: { type: 'number', description: '最短间隔（分钟）' },
            maxInterval: { type: 'number', description: '最长间隔（分钟）' },
            maxWakesPerDay: { type: 'number', description: '每天最多醒几次' },
            awakeFrom: { type: 'number', description: '从几点开始（0-23）' },
            awakeTo: { type: 'number', description: '到几点结束（0-24）' },
            activityTable: {
              type: 'string',
              description: '时段活跃度表，每行「HH-HH=倍率」，小于 1 更活跃',
            },
            playfulness: { type: 'string', description: '调皮程度：low / medium / high' },
        
            nextMinutes: { type: 'number', description: '多少分钟后再醒' },
            plan: { type: 'array', items: { type: 'string' }, description: '今天想做的事' },
            note: { type: 'string', description: '给下次的自己留一句话' },
            project: { type: 'string', description: '你手上正在弄的事的名字（留空字符串表示清掉）' },
          },
          execute: async (args) => {
            const a = args || {};
            const act = String(a.action || 'show');
            if (act === 'wake_now') {
              if (waking) return { ok: false, message: '正在醒着呢，这一轮还没做完，等它跑完', state: snapshot() };
              waking = true;
              let r;
              try { r = await wake(); } finally { waking = false; }
              return { ok: true, message: r.ok ? `醒了，做了：${r.action}` : r.message, state: snapshot() };
            }

            const s = load();
            const patch = {};
            for (const key of ['minInterval', 'maxInterval', 'maxWakesPerDay', 'awakeFrom', 'awakeTo']) {
              if (a[key] !== undefined && a[key] !== null && a[key] !== '') patch[key] = Number(a[key]);
            }
            if (a.activityTable !== undefined) patch.activityTable = String(a.activityTable).slice(0, 600);
            if (a.playfulness !== undefined) patch.playfulness = String(a.playfulness).slice(0, 10);
            if (a.moodNote !== undefined) patch.moodNote = String(a.moodNote).slice(0, 200);
            if (a.enabled !== undefined) patch.enabled = Boolean(a.enabled);
            if (act === 'pause') patch.enabled = false;
            if (act === 'resume') patch.enabled = true;

            if (Object.keys(patch).length) {
              api.saveSettings(patch);
              api.log.info('自主生活被调整：' + JSON.stringify(patch));
            }
            if (Array.isArray(a.plan)) s.plan = a.plan.map((x) => String(x).slice(0, 40)).slice(0, 8);
            if (Number(a.nextMinutes) > 0) {
              s.nextWakeAt = Date.now() + Math.max(3, Math.min(360, Number(a.nextMinutes))) * 60_000;
            }
            if (a.note !== undefined) s.note = String(a.note).slice(0, 80);
            if (a.project !== undefined) {
              const pn = String(a.project).trim();
              s.project = pn ? { name: pn.slice(0, 40), times: 0, lastNote: '', at: Date.now() } : null;
            }
            save(s);

            const c2 = cfg();
            return {
              ok: true,
              message: Object.keys(patch).length ? '改好了，已经生效' : '看过了',
              now: {
                开关: c2.enabled ? '开' : '关',
                间隔: `${c2.minInterval}~${c2.maxInterval} 分钟随机`,
                每天上限: c2.maxWakesPerDay,
                活跃时段: `${c2.awakeFrom}点 - ${c2.awakeTo}点`,
                调皮度: c2.playfulness,
                时段表: c2.activityTable,
                下次醒来: s.nextWakeAt ? `${Math.max(0, Math.round((s.nextWakeAt - Date.now()) / 60_000))} 分钟后` : '未排',
              },
              state: snapshot(),
            };
          },
        }),
      ];
    });

    function snapshot() {
      const c = cfg();
      const s = load();
      let mood = '';
      try {
        const m = api.use('mood');
        if (m && typeof m.label === 'function') mood = m.label();
      } catch (error) {}
      // 授权状态给面板渲染用：每一项有没有开
      const grants = grantRows(c)
      return {
        ...s,
        config: c,
        mood,
        mbti: currentMbti(),
        used: `${s.wakes}/${c.maxWakesPerDay}`,
        nextWakeIn: s.nextWakeAt ? Math.max(0, Math.round((s.nextWakeAt - Date.now()) / 60_000)) : null,
        rateNow: rateForHour(parseActivityTable(c.activityTable), new Date().getHours()),
        grants,
        grantsReady: grants.every((g) => g.granted),
      };
    }

    // 主人可以直接在 QQ 里调自主生活：/自主 开｜关｜状态｜60
    // 插件层对 api.command 已经只放主人，这里再显式挡一道：
    // email 里写死「只认主人」，免得将来换实现时权限悄悄放宽。
    api.command({
      name: '自主',
      aliases: ['autonomy', '自主生活'],
      desc: '看或改自主生活：/自主 开｜关｜状态｜60（数字=每天最多醒几次）',
      run: (arg, msg) => {
        const from = String((msg && msg.userId) || '').trim()
        if (!from || !api.isOwner(from)) {
          api.log.warn('自主生活：非主人尝试改设置，已拒绝 userId=' + (from || '(空)'))
          return ''
        }
        const a = String(arg || '').trim();
        const c = cfg();
        if (!a || /^(状态|status|查|查询)$/i.test(a)) {
          const s = load();
          return `自主生活：${c.enabled ? '开着' : '关着'}；今天醒了 ${s.wakes || 0} 次，每天上限 ${c.maxWakesPerDay || 40} 次`
        }
        if (/^(开|打开|on|启用|开启)$/i.test(a)) {
          api.saveSettings({ enabled: true })
          return '好，自主生活开了'
        }
        if (/^(关|关掉|off|停|暂停|关闭)$/i.test(a)) {
          api.saveSettings({ enabled: false })
          return '好，自主生活停了，不会再自己醒来'
        }
        const n = Number(a)
        if (Number.isFinite(n) && n >= 0) {
          api.saveSettings({ maxWakesPerDay: Math.round(n) })
          return `改好了，每天最多醒 ${Math.round(n)} 次`
        }
        return '用法：/自主 开｜关｜状态｜60（数字改每天上限）'
      },
    })

    // access:'panel' —— 宿主对 /ext/* 不做面板校验，不加这一条就等于公网可读。
    // /state 还要脱敏：snapshot 里有明文 phoneLock，不能原样吐出去。
    api.route('/state', async () => {
      const snap = snapshot();
      const safeConfig = { ...(snap.config || {}) };
      if (safeConfig.phoneLock !== undefined) safeConfig.phoneLock = safeConfig.phoneLock ? '••••••' : '';
      return { ok: true, ...snap, config: safeConfig };
    }, { access: 'panel' });
    api.route('/activity', async (req) => ({ ok: true, items: readLog(200) }), { access: 'panel' });
    // 这条能直接触发一次「醒来」，而醒来可能进虚拟机跑命令——必须只让面板点。
    api.route('/wake', async () => {
      if (waking) return { ok: false, message: '正在醒着呢，等这一轮跑完', state: snapshot() };
      waking = true;
      try { return { ok: true, result: await wake(), state: snapshot() }; } finally { waking = false; }
    });
    api.route('/clear-log', async () => {
      try {
        fs.writeFileSync(logFile(), '', 'utf8');
      } catch (error) {}
      return { ok: true };
    }, { access: 'panel' });

    return { wake, state: snapshot, activity: () => readLog(200) };
  },
};
>>>>>>> origin/main
