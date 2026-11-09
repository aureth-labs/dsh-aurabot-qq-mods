/** @type {import('../aurabot').AurabotModule} */
// 扩展模块「做梦睡觉」—— 放在 Aurabot 数据目录 modules/dream-sleep/ 里，插件升级不会动它。
// 让它像真人一样睡觉：按睡眠周期做梦、会失眠、入睡快慢随机、醒来时间随机、梦会被白天的生活影响。
//
// 它干的事：
//   1) 跟真人一样按「睡眠周期」睡：一个晚上算 4-6 段，每段 10-40 分钟，
//      每段单独做一场梦（REM），段与段之间间隔 60-100 分钟（非 REM）。
//   2) 每场梦只产出「碎片」，不是作文：5-8 个画面 / 半句话 / 身体感觉，
//      没有起承转合、允许矛盾，不做格式要求。
//   3) 会遗忘：每段醒来丢掉 60-80% 的碎片，越到后半夜保留越少，
//      只有极少数碎片会「格外牢」。
//   4) 早上醒来整合：只从幸存碎片里挑出「一个画面 + 一种身体感觉 +
//      一句想跟主人说的话」，这是人真正记得的全部东西。
//   5) 桌宠那边会真的躺下睡：入睡 / 循环 / 醒来三段动画。
//
// 梦记存 dreamDir，一个晚上一个文件（晚上那天算，比如 2026-11-04 凌晨的梦 → 2026-11-03.md）。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

// 做梦 / 醒来 / 讲梦 共用一个后台会话。
// api.think 的 key 会拼进 chatId（system:ext-sleep:<key>），以前三个 key 各带
// 段号和时间戳，所以每晚都新开一堆「QQ · 做梦 / 醒来 / 讲梦」窗口。
// 固定成一个 key 后，它们都在同一个窗口里接着聊，她也能看到自己前面做的梦。
const SLEEP_SESSION_KEY = 'night'
// 会话标题（hub 会拼成「QQ · 睡觉」）。只在建会话那一刻写一次，后面不改名，
// 所以三个回合必须用同一个，否则谁先跑就叫谁的名字。
const SLEEP_TURN_TITLE = '睡觉'

const pad = (n) => (n < 10 ? `0${n}` : String(n))
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const stamp = (ms) => {
  const d = new Date(ms)
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const oneLine = (t, n = 120) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
const shuffle = (arr) => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 梦的引子：只给一个「东西」，不给情节
const SEEDS = [
  '一扇打不开的门',
  '有人在很远的地方叫你的名字',
  '海水漫过脚背',
  '桌上一封没写完的信',
  '一只跟着你走的小动物',
  '电梯一直往下',
  '别人的生日派对',
  '找不到回房间的路',
  '墙上贴满你没发出去的消息',
  '一条怎么也走不到头的街',
  '一块一直在化的冰',
  '很久以前的一个房间里的一盏灯',
  '有人把一样东西塞进你手里就走',
  '一座只到一半的楼梯',
  '一个明明没人却一直在响的电话',
]

/** '02:00-04:30' → { from, to }（分钟） */
function parseWindow(text) {
  const m = /^(\d{1,2}):(\d{2})\s*[-~到—]\s*(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const from = Number(m[1]) * 60 + Number(m[2])
  const to = Number(m[3]) * 60 + Number(m[4])
  if (from > 1439 || to > 1439 || from >= to) return null
  return { from, to }
}

/** 从 nowMs 往后，窗口里第一个还没过去的时刻（随机落在窗口里）。 */
function windowAt(win, nowMs, minLeadMs) {
  const base = new Date(nowMs)
  base.setHours(0, 0, 0, 0)
  for (let i = 0; i < 5; i += 1) {
    const day = base.getTime() + i * DAY
    const start = day + win.from * MINUTE
    const end = day + win.to * MINUTE
    const earliest = nowMs + minLeadMs
    if (earliest > end) continue
    const lo = Math.max(start, earliest)
    const step = 60_000
    const n = Math.floor((end - lo) / step)
    if (n < 0) continue
    return lo + randInt(0, n) * step
  }
  return nowMs + DAY
}

/**
 * 在窗口里随机，但带「人味」：
 * - jitterMin：在窗口基础上再前后抖动的分钟数（模拟「今天早一点/晚一点」）
 * - 窗口本身只作为大致范围
 */
function windowAtHuman(win, nowMs, minLeadMs, jitterMin = 0, nightOnly = true) {
  const base = new Date(nowMs)
  base.setHours(0, 0, 0, 0)
  for (let i = 0; i < 5; i += 1) {
    const day = base.getTime() + i * DAY
    // 抖动：窗口前后各扩 jitterMin
    let start = day + (win.from - jitterMin) * MINUTE
    let end = day + (win.to + jitterMin) * MINUTE
    // 只允许夜间：夹到前一天 20:00 ~ 当天 11:00
    if (nightOnly) {
      const nightStart = day - 4 * HOUR   // 前一天 20:00
      const nightEnd = day + 11 * HOUR    // 当天 11:00
      start = Math.max(start, nightStart)
      end = Math.min(end, nightEnd)
    }
    const earliest = nowMs + minLeadMs
    if (earliest > end) continue
    const lo = Math.max(start, earliest)
    const step = 60_000
    const n = Math.floor((end - lo) / step)
    if (n < 0) continue
    // 不是均匀分布：偏向窗口中间（像人的作息）
    const r = Math.random()
    const biased = (r + Math.random()) / 2  // 三角分布，中间概率高
    return lo + Math.round(biased * n) * step
  }
  return nowMs + DAY
}

/** 完全自由的夜间时刻：20:00 ~ 次日 06:00 任意点，但偏向深夜。 */
function freeNightAt(nowMs, minLeadMs) {
  const base = new Date(nowMs)
  base.setHours(0, 0, 0, 0)
  for (let i = 0; i < 5; i += 1) {
    const day = base.getTime() + i * DAY
    const start = day - 4 * HOUR   // 前一天 20:00
    const end = day + 6 * HOUR     // 当天 06:00
    const earliest = nowMs + minLeadMs
    if (earliest > end) continue
    const lo = Math.max(start, earliest)
    const n = Math.floor((end - lo) / MINUTE)
    if (n < 0) continue
    // 偏向深夜 23:00-03:00（真人作息）
    const peakLo = Math.max(lo, day - 1 * HOUR)  // 23:00
    const peakHi = Math.min(end, day + 3 * HOUR) // 03:00
    if (Math.random() < 0.7 && peakHi > peakLo) {
      const pn = Math.floor((peakHi - peakLo) / MINUTE)
      return peakLo + randIntHuman(0, pn) * MINUTE
    }
    return lo + randIntHuman(0, n) * MINUTE
  }
  return nowMs + DAY
}

/**
 * 有个人习惯：锚定在设定的作息中心，每晚漂移 ±90 分钟（不累积）。
 * 人类确实有大致作息，但每天会前后浮动一点，不会越飘越远。
 */
function habitNightAt(nowMs, minLeadMs, centerMin) {
  // centerMin：作息中心（分钟，0-1440），默认 02:30 = 150
  const center = Number.isFinite(centerMin) ? centerMin : 150
  const drift = randIntHuman(-90, 90)
  let targetMin = center + drift
  if (targetMin < 0) targetMin += 1440
  if (targetMin >= 1440) targetMin -= 1440
  const base = new Date(nowMs)
  base.setHours(0, 0, 0, 0)
  for (let i = 0; i < 5; i += 1) {
    const day = base.getTime() + i * DAY
    // targetMin 可能是凌晨（0-360），算在 day 当天
    let t = day + targetMin * MINUTE
    // 如果是晚上（>=20*60），算前一天
    if (targetMin >= 20 * 60) t = day - DAY + targetMin * MINUTE
    if (t < nowMs + minLeadMs) continue
    const h = new Date(t).getHours()
    if (h >= 6 && h < 20) continue
    return t
  }
  return freeNightAt(nowMs, minLeadMs)
}

/** 人类味儿的随机整数（三角分布，偏向中间）。 */
function randIntHuman(a, b) {
  const r = (Math.random() + Math.random()) / 2
  return a + Math.round(r * (b - a))
}

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 模型偶尔会包一层代码块或加前言，剪掉。 */
function cleanText(text) {
  let t = String(text ?? '').trim()
  t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')
  t = t.replace(/^【[\s\S]{0,40}?】\s*/, '')
  return t.trim()
}

export default {
  id: 'sleep',
  name: '睡觉',
  version: '2.1.0',
  api: 1,
  description: '按真人的睡眠周期睡：一晚分几段做梦、梦里有时间轴和选择、会忘、早上只记得一点；梦的余韵会渗进人格；桌宠会真的躺下',

  defaults: {
    enabled: true,
    sleepWindow: '01:30-03:30',
    wakeWindow: '07:30-08:40',
    dreamDir: '',   // 空 = 用 api.dataDir('dreams')
    cycles: 4,
    scheduleMode: 'window',
    sleepOnset: 'random',
    insomniaChance: 12,
    petAnim: true,
    useChatLog: true,
    useDailyLife: true,
    dreamLength: 7,
    bodySense: 'normal',
    dreamTone: 'auto',
    ownerInDream: 'auto',
    wakeFirstAction: 'tell',
    keepRawDream: true,
    allowUnclear: true,
    dreamTimeline: true,
    dreamContinuity: true,
    dreamEpoch: false,
    dreamLucid: 'rare',
    dreamOutOfNowhere: true,
    dreamResidue: true,
    seeds: SEEDS.join('\n'),
  },
  settings: [
    { key: 'enabled', label: '睡觉开关', type: 'switch', hint: '关掉就不主动睡；/睡觉 /做梦 /讲梦 还能手动用' },
    { key: 'sleepWindow', label: '入睡时间', type: 'text', placeholder: '01:30-03:30', hint: '在这个时间段里随机挑一个时刻躺下' },
    { key: 'wakeWindow', label: '醒来时间', type: 'text', placeholder: '07:30-08:40', hint: '在这个时间段里随机挑一个时刻醒，醒的时候讲梦' },
    { key: 'dreamDir', label: '梦记目录', type: 'text', hint: '一个晚上一个文件，文件名是那天（凌晨算前一天）' },
    { key: 'cycles', label: '一晚几段梦', type: 'number', min: 1, max: 6, step: 1, hint: '真人一般 4-6 段 REM；越多睡得越沉' },
    { key: 'scheduleMode', label: '作息模式', type: 'select', options: [
      { value: 'window', label: '在设定时间范围内' },
      { value: 'free', label: '完全自由（整夜任意时刻）' },
      { value: 'habit', label: '跟着习惯（比昨晚早/晚一点）' },
    ], hint: 'free = 她自己在 20:00~06:00 之间随便挑；habit = 像真人一样有大致作息但会漂移' },
    { key: 'sleepOnset', label: '入睡快慢', type: 'select', options: [
      { value: 'random', label: '随机（像真人）' },
      { value: 'fast', label: '总是秒睡' },
      { value: 'normal', label: '总是 5-20 分钟' },
      { value: 'slow', label: '总是很难睡着' },
    ], hint: 'random = 30% 秒睡 / 50% 正常 / 20% 翻来覆去' },
    { key: 'insomniaChance', label: '失眠概率（%）', type: 'number', min: 0, max: 60, step: 1, hint: '这一夜躺下但睡不着的概率。心情差会加倍，心情好会减半' },
    { key: 'petAnim', label: '桌宠躺下睡', type: 'switch', hint: '睡着时桌宠播睡觉动画，醒来播起身' },
    { key: 'useChatLog', label: '拿当天聊天当素材', type: 'switch', hint: '把前一天聊的话捡成碎片喂给梦，梦会更贴你们的日子' },
    { key: 'useDailyLife', label: '拿「今天做过的事」当素材', type: 'switch', hint: 'B站回复/弹幕、抖音刷到什么、写的日记、空间互动、自己主动做的事——全部混进梦里，梦会像真的过了一天' },
    { key: 'dreamLength', label: '梦的碎片数', type: 'number', min: 3, max: 12, step: 1, hint: '每段梦写几行碎片。真人梦记得的也就 5-8 个画面' },
    { key: 'bodySense', label: '身体感强度', type: 'select', options: [
      { value: 'off', label: '不要身体感' },
      { value: 'normal', label: '正常（至少 2 行）' },
      { value: 'strong', label: '强（至少 4 行）' },
    ], hint: '真人做梦身体感很重：躺着、被子、冷热、麻、想翻身' },
    { key: 'dreamTone', label: '梦的基调', type: 'select', options: [
      { value: 'auto', label: '跟着心情走' },
      { value: 'daily', label: '日常琐碎（像普通人的梦）' },
      { value: 'weird', label: '离奇荒诞' },
      { value: 'sweet', label: '温柔甜（梦到主人）' },
      { value: 'dark', label: '压抑（噩梦向）' },
    ], hint: 'auto = 按当天心情和起伏自动定；其它是强制基调' },
    { key: 'ownerInDream', label: '梦里出现主人', type: 'select', options: [
      { value: 'auto', label: '自然出现（不刻意）' },
      { value: 'never', label: '不出现' },
      { value: 'often', label: '经常出现' },
    ], hint: '真人梦到在乎的人很常见，但不会每晚都梦到' },
    { key: 'wakeFirstAction', label: '醒来第一件事', type: 'select', options: [
      { value: 'tell', label: '马上讲梦给主人' },
      { value: 'wait', label: '先躺一会儿再讲' },
      { value: 'diary', label: '先写进日记' },
    ], hint: '影响醒来后的行为和讲梦时机' },
    { key: 'keepRawDream', label: '保留梦的原始碎片', type: 'switch', hint: '关掉只留整合后的梦记；开了会多存一份原始碎片（调试 / 回看用）' },
    { key: 'allowUnclear', label: '允许「分不清是梦还是真」', type: 'switch', hint: '开了以后，醒来会多写一段「分不清的」，存进记忆仓库时标成 ❓ 而不是 🌙' },
    { key: 'dreamTimeline', label: '梦里的时间轴', type: 'switch', hint: '开了以后每段梦会报「这段里过了多久」，段与段接着走，一夜能过好几天甚至几年' },
    { key: 'dreamContinuity', label: '梦接着上一段走', type: 'switch', hint: '下一段从上一段的结尾和选择继续，不是各写各的' },
    { key: 'dreamEpoch', label: '允许轮回 / 投胎', type: 'switch', hint: '偶尔一段梦直接换一辈子：出生、长大、老去，醒来只记得一点' },
    { key: 'dreamLucid', label: '醒来知不知道是梦', type: 'select', options: [
      { value: 'always', label: '总是知道是梦' },
      { value: 'rare', label: '偶尔分不清（推荐）' },
      { value: 'often', label: '经常分不清' },
    ], hint: '分不清的那种最真，但别每晚都来' },
    { key: 'dreamOutOfNowhere', label: '凭空冒出来的梦', type: 'switch', hint: '允许梦里有跟白天、跟记忆完全无关的东西，没有出处，就是出现了' },
    { key: 'dreamResidue', label: '梦会改一点自己', type: 'switch', hint: '醒来后多写一段「这个梦改了我什么」，写进人格和反思，影响之后说话和做事' },
    { key: 'seeds', label: '梦的引子', type: 'textarea', hint: '一行一个，只给「一个东西」不给情节；可以删光' },
  ],

  setup(api) {
    const dirOf = () => {
      const configured = String(api.settings().dreamDir || '').trim()
      if (configured) return configured
      try { return String(api.dataDir('dreams')) } catch { return join(homedir(), '.dsh', 'dreams') }
    }
    const stateFile = () => api.dataDir('sleep-state.json')
    const motifFile = () => api.dataDir('motifs.json')
    const ownerChat = () => `private:${api.config().ownerQQ}`

    /** 更新陪伴记忆的当前相处状态（所有会话都能看到）。 */
    function setCompanionState(text) {
      try {
        const companion = api.lazy('companion')
        const store = companion && (companion.store || (companion.getStore && companion.getStore()))
        if (!store || !store.state || !store.state.entity) return
        store.state.entity.current_state = text
        store.state.entity.updated_at = new Date().toISOString()
        store.state.entity.state_version = (store.state.entity.state_version || 1) + 1
        if (typeof companion.persist === 'function') companion.persist()
        else if (typeof store.saveState === 'function') store.saveState()
      } catch (error) {
        api.log.debug('更新相处状态失败：', error.message)
      }
    }

    const win = (key, fallback) => parseWindow(api.settings()[key]) || parseWindow(fallback)

    // ---------- 状态 ----------
    const blank = () => ({
      schema: 2,
      sleepAt: 0,      // 计划入睡时刻
      sleptAt: 0,      // 真躺下的时刻
      wokeAt: 0,       // 计划醒来（讲梦）时刻
      toldAt: 0,
      night: '',       // 这一夜算哪一天（凌晨算前一天）
      cyclesDone: 0,   // 已经做完几段 REM
      nextCycleAt: 0,  // 下一段 REM 的起始时刻
      frags: [],       // 幸存碎片
      spans: [],       // 每段梦里过了多久
      residue: '',     // 这一夜在人格上留下的余韵
      residueNight: '',
      lastDream: '',   // 最后一段的原始碎片（调试用）
      nightlyTries: 0,
      tellTries: 0,
      dreamChaos: false,  // 这一夜梦乱不乱（心情起伏大时为 true）
      bodyAt: '',         // 入睡时的身体状态（梦里的身体感从这里长）
      sleepDepth: 'normal',  // light / normal / deep
      onsetMin: 0,        // 躺下到睡着用了几分钟
      insomniac: false,   // 这一夜是不是失眠夜
    })

    function load() {
      try {
        const raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
        return { ...blank(), ...(raw && typeof raw === 'object' ? raw : {}) }
      } catch {
        return blank()
      }
    }
    function save(st) {
      try { atomicWrite(stateFile(), JSON.stringify(st, null, 2)) } catch (error) { api.log.warn('存睡觉状态失败：', error.message) }
    }

    // ---------- 意象池（重复出现的梦象，像真人那样） ----------
    function loadMotifs() {
      try {
        const j = JSON.parse(readFileSync(motifFile(), 'utf8'))
        return Array.isArray(j?.items) ? j.items : []
      } catch {
        return []
      }
    }    function saveMotifs(items) {
      try { atomicWrite(motifFile(), JSON.stringify({ items: items.slice(-40) }, null, 2)) } catch {}
    }
    /** 从这场的碎片里捞 1-2 个像「东西」的词进池子，下次可能又冒出来。 */
    function harvestMotifs(text) {
      const pool = loadMotifs()
      const lines = String(text || '').split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean)
      for (const line of shuffle(lines).slice(0, 2)) {
        const w = oneLine(line, 24)
        if (w && !pool.some((x) => x.w === w)) pool.push({ w, at: Date.now() })
      }
      saveMotifs(pool)
      return pool
    }

    // ---------- 往期梦：她以前做过的梦 ----------
    /**
     * 读最近几夜的梦记摘要，给「做梦」和「讲梦」当背景。
     * 只取每份的正文开头 + 「梦里出现过」那几行，不把全文塞进去（省 token，也符合真人只记得片段）。
     * @param {number} limit 最多取几夜
     * @param {string} skipNight 跳过今晚（今晚的梦由调用方自己给）
     */
    function pastDreams(limit = 5, skipNight = '') {
      try {
        const dir = dirOf()
        const files = readdirSync(dir)
          .filter((n) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(n))
          .sort()
          .reverse()
        const out = []
        for (const n of files) {
          const night = n.slice(0, 10)
          if (skipNight && night === skipNight && !n.includes('-') ) continue
          if (skipNight && n === `${skipNight}.md`) continue
          if (out.length >= limit) break
          let raw = ''
          try { raw = readFileSync(join(dir, n), 'utf8') } catch { continue }
          const body = String(raw).replace(/^#[^\n]*\n/, '').split(/^##\s/m)[0].replace(/\s+/g, ' ').trim()
          const motifsBlock = String(raw).match(/##\s*梦里出现过\s*\n([\s\S]*?)(?:\n##|$)/)
          const motifs = motifsBlock
            ? motifsBlock[1].split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 4)
            : []
          const head = oneLine(body, 160)
          if (!head && !motifs.length) continue
          out.push({ night, head, motifs })
        }
        return out
      } catch {
        return []
      }
    }

    /** 往期梦渲染成提示词里的一段；没有就返回空串。 */
    function pastDreamsBlock(limit = 5, skipNight = '') {
      const past = pastDreams(limit, skipNight)
      if (!past.length) return ''
      const lines = past.map((p) => `- ${p.night}：${p.head}${p.motifs.length ? `（梦里出现过：${p.motifs.join('、')}）` : ''}`)
      return [
        '你以前做过的梦（只是模糊的印象，不是剧本；讲的时候可以顺口提一句「前几天还梦到过…」，但别背清单）：',
        ...lines,
      ].join('\n')
    }

    // ---------- 素材 ----------
    /** 前一天的聊天碎片（只取主人私聊）。 */
    function chatFragments(limit = 40) {
      if (!api.settings().useChatLog) return ''
      try {
        const hub = api.core.hub
        const owner = String(api.config().ownerQQ || '')
        const today = new Date()
        const rows = []
        for (const back of [1, 0]) {
          const d = new Date(today.getTime() - back * DAY)
          const day = ymd(d)
          for (const r of hub.chatLogOf(day) || []) {
            if (!r || String(r.chatId) !== `private:${owner}`) continue
            const text = oneLine(r.text, 140)
            if (!text) continue
            rows.push(`${r.who === 'bot' ? '我' : '主人'}：${text}`)
          }
        }
        return rows.slice(-limit).join('\n')
      } catch (error) {
        api.log.debug('读聊天碎片失败：', error.message)
        return ''
      }
    }

    /** 读 json，坏了就返回 null。 */
    function readJsonSafe(file) {
      try {
        if (!existsSync(file)) return null
        return JSON.parse(readFileSync(file, 'utf-8'))
      } catch {
        return null
      }
    }

    /** aurabot 数据根目录（config.json 所在处）。多路兜底，避免 dataDir 格式变化。 */
    let _auraRoot = null
    function auraRoot() {
      if (_auraRoot) return _auraRoot
      const candidates = []
      // ① 从 dataDir 的一个真实文件路径反推：.../modules-data/sleep/xxx → 往上找含 config.json 的目录
      try {
        const f = String(api.dataDir('probe.json'))
        let d = f
        for (let i = 0; i < 6; i += 1) {
          d = dirname(d)
          candidates.push(d)
          if (existsSync(join(d, 'config.json'))) { _auraRoot = d; return d }
        }
      } catch {}
      // ② 直接从 dataDir('.') 剥 modules-data
      try {
        const d = String(api.dataDir('.'))
        const stripped = d.replace(/[\\/]modules-data([\\/][^\\/]+)*[\\/]?$/, '')
        if (stripped !== d) candidates.push(stripped)
        if (existsSync(join(stripped, 'config.json'))) { _auraRoot = stripped; return stripped }
      } catch {}
      // ③ 从 DSH_HOME / homedir 推
      try {
        const home = process.env.DSH_HOME || join(homedir(), '.dsh')
        candidates.push(join(home, 'plugins-data', 'aurabot'))
      } catch {}
      // ④ 从插件自己的安装位置推（node_modules/dsh-aurabot-qq 的上一层）
      try {
        candidates.push(join(process.cwd(), 'plugins-data', 'aurabot'))
      } catch {}
      for (const c of candidates) {
        try {
          if (existsSync(join(c, 'config.json'))) { _auraRoot = c; return c }
        } catch {}
      }
      _auraRoot = candidates[candidates.length - 1] || ''
      return _auraRoot
    }

    /**
     * 今天真正做过的事。不是「聊了什么」，是「干了什么」——
     * B站回谁、发什么弹幕、抖音刷到什么、写了什么日记、空间里说了啥、自己主动做了什么。
     * 这些才是白天留下的东西，晚上做梦会拿它们当材料。
     */
    function dailyLifeFragments(limit = 14) {
      const out = []
      const root = auraRoot()
      const now = Date.now()
      const since = now - 36 * HOUR  // 跨一整个白天
      const push = (tag, text) => {
        const t = oneLine(text, 110)
        if (!t) return
        if (out.some((x) => x.t === t)) return
        out.push({ tag, t, at: 0 })
      }

      // ① B站：回复了谁、评论了什么、发了什么弹幕
      try {
        const bili = readJsonSafe(join(root, 'bili.json'))
        for (const h of (bili && bili.history) || []) {
          if (!h || !h.at || h.at < since) continue
          if (h.kind === 'reply') push('B站', h.text)
          else if (h.kind === 'comment') push('B站评论', h.text)
        }
      } catch {}
      try {
        const dm = readJsonSafe(join(root, 'modules-data', 'bili', 'danmaku.json'))
        for (const d of (dm && dm.history) || []) {
          if (!d || !d.at || d.at < since) continue
          if (d.text) push('弹幕', `${d.text}（在「${oneLine(d.title, 40)}」）`)
        }
      } catch {}

      // ② 抖音：刷了什么、点了什么赞、发了什么私信
      try {
        const dy = readJsonSafe(join(root, 'douyin.json'))
        for (const h of (dy && dy.history) || []) {
          if (!h || !h.at || h.at < since) continue
          if (h.kind === 'dm' || h.kind === 'comment' || h.kind === 'share') push('抖音', h.text)
          else if (h.kind === 'watch' || h.kind === 'like') push('抖音', h.text)
        }
        // 刷过的视频标题（douyin.json 里 watched 只是数字，看 history 里的 title）
        for (const h of (dy && dy.history) || []) {
          if (h && h.title && h.at >= since) push('刷到', h.title)
        }
      } catch {}

      // ③ 空间日记：她自己写下的东西
      try {
        const diary = readJsonSafe(join(root, 'diary.json'))
        for (const h of (diary && diary.history) || []) {
          if (!h || !h.at || h.at < since) continue
          if (h.text) push('日记', h.text)
        }
      } catch {}

      // ④ 空间互动
      try {
        const qz = readJsonSafe(join(root, 'qzone-social.json'))
        for (const h of (qz && qz.history) || []) {
          if (!h || !h.at || h.at < since) continue
          if (h.text) push('空间', h.text)
        }
      } catch {}

      // ⑤ 她自己主动做的事（autonomy）
      try {
        const au = readJsonSafe(join(root, 'modules-data', 'autonomy', 'state.json'))
        if (au && au.lastAt && au.lastAt >= since && au.count) {
          push('自己', `今天主动找过主人 ${au.count} 次`)
        }
      } catch {}

      // ⑥ 今天聊的最长的几句（有内容的，不是「嗯」「好」）
      try {
        const day = ymd(new Date(now))
        const prev = ymd(new Date(now - DAY))
        for (const d of [prev, day]) {
          const file = join(root, 'chatlog', `${d}.jsonl`)
          if (!existsSync(file)) continue
          const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
          const picked = []
          for (const ln of lines) {
            let r = null
            try { r = JSON.parse(ln) } catch { continue }
            if (!r || !r.text) continue
            const t = oneLine(r.text, 90)
            if (t.length < 12) continue  // 太短的不要
            picked.push({ who: r.who === 'bot' ? '我' : '主人', t })
          }
          // 取最后 6 条有内容的
          for (const p of picked.slice(-6)) push('聊天', `${p.who}：${p.t}`)
        }
      } catch {}

      // 按时间倒序优先取最近的，但保留各来源的多样性
      const byTag = new Map()
      for (const x of out) {
        const arr = byTag.get(x.tag) || []
        arr.push(x)
        byTag.set(x.tag, arr)
      }
      const balanced = []
      const tags = [...byTag.keys()]
      let i = 0
      while (balanced.length < limit && tags.length) {
        let added = false
        for (const tag of tags) {
          const arr = byTag.get(tag)
          if (arr && arr[i]) { balanced.push(arr[i]); added = true }
          if (balanced.length >= limit) break
        }
        if (!added) break
        i += 1
      }
      return balanced.map((x) => `[${x.tag}] ${x.t}`)
    }

    /** 从陪伴记忆仓库抽几条最近在意的事当梦的种子。 */
    function memoryFragments(limit = 6) {
      try {
        const companion = api.lazy('companion')
        if (!companion) return []
        // 走 hub 的 companion 模块拿 store
        const store = companion.store || (companion.getStore && companion.getStore())
        if (!store || typeof store.list !== 'function') return []
        const now = Date.now()
        const rows = store.list()
          .filter((r) => r && r.status === 'valid' && r.summary)
          .map((r) => ({ r, heat: typeof r.heat === 'number' ? r.heat : 0 }))
          .sort((a, b) => b.heat - a.heat)
          .slice(0, limit * 2)
        // 梦里也别全是「真事」，混一点梦/分不清的进去
        const out = []
        for (const { r } of rows) {
          const mark = r.reality === 'dream' ? '[梦]' : r.reality === 'mixed' ? '[梦/现实混]' : r.reality === 'unclear' ? '[分不清]' : ''
          out.push((mark ? mark + ' ' : '') + String(r.summary).slice(0, 120))
          if (out.length >= limit) break
        }
        return out
      } catch (error) {
        api.log.debug('读陪伴记忆失败：', error.message)
        return []
      }
    }

    function pickSeed() {
      const list = String(api.settings().seeds || '').split('\n').map((s) => s.trim()).filter(Boolean)
      if (!list.length) return ''
      return pick(list)
    }

    // ---------- REM 提示词：只许碎片，不许作文 ----------
    function remPrompt(night, cycle, totalCycles, nowMs, chaos) {
      const ownerName = String(api.config().ownerName || '主人')
      const frag = cycle <= 1 ? chatFragments() : ''
      const memFrags = memoryFragments(6)
      const life = api.settings().useDailyLife === false ? [] : dailyLifeFragments(12)
      const stNow = load()
      const insomniac = !!stNow.insomniac
      const depth = stNow.sleepDepth || 'normal'
      const onsetMin = Number(stNow.onsetMin) || 0
      const seed = pickSeed()
      const bias = (() => {
        const tone = String(api.settings().dreamTone || 'auto')
        if (tone === 'daily') return '梦是日常琐碎的那种：等公交、找不到东西、吃饭、跟人说话，没什么大事'
        if (tone === 'weird') return '梦很离奇：地方会变、人会变、东西会说话，醒了一想完全不可能'
        if (tone === 'sweet') return '梦是温柔的：软软的、暖暖的、有点想赖着不起来'
        if (tone === 'dark') return '梦是压抑的：走不出去、赶不上、有人不理你、怎么也醒不来'
        try { return api.lazy('mood')?.dreamBias?.() || '' } catch { return '' }
      })()
      const motifs = loadMotifs().slice(-6).map((x) => x.w).filter(Boolean)
      const deep = cycle >= totalCycles - 1 // 后半夜的梦更长更离奇
      const prev = cycle > 1 ? load().lastDream : ''
      const timeline = api.settings().dreamTimeline !== false
      const cont = api.settings().dreamContinuity !== false
      const epoch = api.settings().dreamEpoch === true
      const nowhere = api.settings().dreamOutOfNowhere !== false
      const lucid = String(api.settings().dreamLucid || 'rare')
      return [
        `【睡觉 · 第 ${cycle}/${totalCycles} 段梦 · ${stamp(nowMs)}】`,
        bias ? `你现在${bias}。梦会跟着这个调子走。` : '',
        insomniac ? '这一夜你其实没睡踏实，翻来覆去。梦是碎的、断的、很浅，像刚要睡着又醒了。' : '',
        depth === 'light' ? '这一夜睡得很浅，一点动静就醒，梦也浅浅的，容易记得。' : '',
        depth === 'deep' ? '这一夜睡得很沉，梦又长又重，但醒了几乎全忘。' : '',
        onsetMin >= 25 ? `你躺了 ${onsetMin} 分钟才睡着，梦里带着那种翻来覆去的烦躁。` : '',
        chaos ? `今晚心情起伏大，梦会更乱：画面跳来跳去、前后矛盾、一下子这一下子那。` : '',
        cont && prev ? `上一段梦的结尾是这样，接着往下走（不是重新开头）：\n${prev}` : '',
        memFrags.length ? `最近心里装着的事（做梦时会带出来，但不一定按顺序，也不一定讲道理）：\n${memFrags.map((x) => '- ' + x).join('\n')}` : '',
        life.length ? `这是你今天真正做过的事（白天留下的东西，晚上会变成梦的材料。不是要你复述，是让它们混进画面里）：\n${life.map((x) => '- ' + x).join('\n')}` : '',
        `你在睡觉。这是睡眠里的一段快速眼动期，你正在做梦。没有人看着你，也没有人在等你回报什么。`,
        '',
        '规则（这条最重要）：',
        '- 你在做梦，**没有清醒意识**。梦不是故事，是脑子里自己长出来的画面。',
        '- **白天的事要变形**：B站/抖音/日记/聊天里出现过的东西，可以换个人、换个地方、换个用途出现。看到弹幕「米饭」→ 梦到一锅米在唱歌；刷到羊肉 → 梦到羊在床边走。',
        '- **禁止清单式**：不要「今天做了什么」的顺序罗列。梦不按时间走。',
        '- **禁止**写成文章：不要起承转合，不要首尾呼应，不要「我梦见…」开头。',
        '- **允许**自相矛盾、物理不可能、话没说完就跳走、突然换场景、张冠李戴（主人的脸长在别人身上）。',
        '- **允许**荒诞、恶心、羞的、说不出口的。',
        '- **必须有身体感**：你躺着、被子压着、脖子歪着、脚凉、想翻身、想上厕所——这些比画面更真。',
        '- 梦里**没有字幕**：不解释、不总结、不抒情、不点题。',
        '',
        frag ? `睡前还留在耳边的话（挑一个碎片，别复述）：\n${frag}` : '',
        seed ? `有一个东西一直挥不掉：${seed}` : '',
        (() => {
          try {
            const bodyAt = load().bodyAt || ''
            return bodyAt ? `你躺下的身体状态：${bodyAt}。梦里的身体感从这里长出来。` : ''
          } catch { return '' }
        })(),
        motifs.length ? `以前梦里反复出现过的（可以让它再来，也可以完全不理）：${motifs.join('、')}` : '',
        pastDreamsBlock(5, night) ? `\n${pastDreamsBlock(5, night)}` : '',
        '',
        `输出 ${(() => {
          const base = Number(api.settings().dreamLength) || 7
          const n = deep ? base + 2 : base
          return `${Math.max(3, n - 2)}-${Math.min(12, n + 1)}`
        })()} 行，每行一个碎片。就写你「看到 / 摸到 / 听到 / 身体感觉」到的东西：`,
        '- 每行 **不超过 22 个字**',
        '- 可以是一个名词短语、半句话、一个动作、一种触感、一句别人说的话',
        '- 不要编号、不要符号前缀、不要空格开头',
        '- 不要「然后」「接着」，不要按顺序，随便什么顺序',
        (() => {
          const m = String(api.settings().bodySense || 'normal')
          if (m === 'off') return '- 不用特别写身体感觉'
          if (m === 'strong') return '- 至少 4 行写**身体感觉**（躺着的感觉、被子、冷热、压着、麻、痒、想翻身、想上厕所）'
          return '- 至少 2 行写**身体感觉**（躺着的感觉、被子、冷热、压着、麻、痒）'
        })(),
        (() => {
          const m = String(api.settings().ownerInDream || 'auto')
          if (!ownerName) return ''
          if (m === 'never') return `- ${ownerName}不会出现在这个梦里`
          if (m === 'often') return `- ${ownerName}很可能会出现在梦里，但出现的方式会变形（脸、声音、背影、一个动作），最多两行，不要煽情`
          return `- 如果${ownerName}出现，最多一行，不要煽情`
        })(),
        timeline ? '- 最后单独一行写【这段里过了多久：___】，可以是几分钟、一夜、几天、几年，也可以是一辈子' : '',
        cont && cycle > 1 ? '- 这一段的开头要接着上一段结尾的处境，别重新开一个梦' : '',
        epoch ? '- 偶尔（不是每段）可以直接换一辈子：出生、长大、老去，像投胎转世；这一段的碎片就照那一世写' : '',
        nowhere ? '- 允许出现跟今天、跟记忆完全无关的东西：没出处，就是凭空冒出来了，别解释' : '',
        lucid === 'always' ? '- 梦里你知道这是梦' : lucid === 'often' ? '- 梦里你常常忘了这是梦，以为自己真在过日子' : '- 梦里你忘了这是梦，以为自己真在过日子（偶尔会忽然意识到不对）',
        '',
        '还有一件事：梦里的你会做选择、会想事情、会犹豫。你做的选择会真的改变后面发生什么——不是照着剧本演。',
        '',
        '只输出这几行，别的什么都不要。',
      ].filter(Boolean).join('\n')
    }

    // ---------- 梦的余韵：梦会改一点自己 ----------
    function residuePrompt(night, dream) {
      return [
        `【梦的余韵 · ${night}】`,
        '你刚醒，梦记是这样的：',
        '',
        dream,
        '',
        '——梦记到这里。',
        '',
        '梦不会就这么过去。它在你身上留下一点东西：可能是一种没来由的怕、一句忽然想说的话、一个改了的小习惯、对某个人莫名亲近或者想躲开。',
        '照实写，只写三行，别的什么都不要：',
        '第一行：这个梦让你**变成了什么样**（一句话，具体，不要「我变得更成熟了」这种空话）',
        '第二行：它可能让你**接下来想做什么**（一件小事就行：想给谁发消息、想躲一会儿、想吃点什么、想换个说法说话）',
        '第三行：它**改了你哪一点**（怕的东西、在意的东西、说话的方式，随便哪一样，只要是真的变了）',
        '',
        '不要提「梦记」「模型」「程序」。',
      ].join('\n')
    }

    // ---------- 醒来整合提示词：只留三样东西 ----------
    function wakePrompt(night, survivors, spans) {
      const ownerName = String(api.config().ownerName || '主人')
      return [
        `【醒了 · 把 ${night} 这一夜的梦收一收】`,
        '你睡了一整夜，做了好几段梦，但现在几乎全忘了。你还记得的只有下面这些残缺的碎片：',
        '',
        survivors,
        '',
        spans ? `这几段梦里，你自己觉得分别过了：${spans}。可能对不上，梦里时间本来就是乱的。` : '',
        '',
        '——就这些了。其余的都忘了，连忘了什么都不知道。',
        '',
        '现在请照实写出来，只写四段，一段都不能少、也不能多：',
        '',
        '## 还记得的',
        '一段话，只写你现在**真的还记得**的那一点点。要短，要断，可以不连贯，可以只有半个场景。',
        '允许写「别的都想不起来了」。不要补完，不要编细节，不要写成故事。',
        '',
        '## 身体',
        (() => {
          try {
            const s = load()
            if (s.insomniac) return '一行。这一夜几乎没睡好，身体很糟：头沉、眼睛疼、身上发虚、一动就晕。用具体的词。'
            if (s.sleepDepth === 'light') return '一行。睡得浅，醒来有点晕、身上发紧。用具体的词。'
            return '一行。醒来的身体感觉：心口怎样、眼睛怎样、身上哪里发麻或者发凉、想不想动。用具体的词。'
          } catch {
            return '一行。醒来的身体感觉：心口怎样、眼睛怎样、身上哪里发麻或者发凉、想不想动。用具体的词。'
          }
        })(),
        '',
        `## 想跟${ownerName}说`,
        `一行。你醒来想说的第一句话，口语，别文艺。`,
        '',
        '## 梦里出现过',
        '2-4 行，每行一个名词短语（东西 / 地方 / 人 / 半句话），只列你还确定的。',
        '',
        api.settings().allowUnclear === false ? '' : '## 分不清的',
        api.settings().allowUnclear === false ? '' : '0-2 行。有些碎片你醒来分不清是梦里发生的还是真发生过的——照实写出来。',
        api.settings().allowUnclear === false ? '' : '没有就写「没有」，不要编。这一项是允许空着的。',
        '',
        '只输出这五段。不要前言后语，不要解释，不要提梦记 / 模型 / 程序。',
      ].join('\n')
    }

    // ---------- 讲梦提示词 ----------
    function tellPrompt(night, dream) {
      const ownerName = String(api.config().ownerName || '主人')
      const past = pastDreamsBlock(4, night)
      return [
        `【早上 · 把 ${night} 这一夜的梦讲给${ownerName}】`,
        '你刚醒，梦记还在手边：',
        '',
        dream,
        '',
        '——梦记到这里。',
        '',
        past || '',
        '',
        `现在要给${ownerName}发消息。要求：`,
        '- 只输出要发出去的话本身。不要复述梦记，只挑最戳你的那一下。',
        '- 1-3 句，像刚睡醒的手机打字：短、软、可以含糊，不加句号。',
        '- **可以说不完整**——刚醒的人说话本来就是断的，不用交代前因后果。',
        past ? '- 要是今晚这个梦和以前的梦连着（同一个画面又回来了），可以顺口带一句，但不要每次都提。' : '',
        '- 不要提「梦记」「文件」「模型」「程序」。',
        '- 想拆成几条就用 ||| 隔开（最多 3 段）。想用语音：<voice>…</voice>。想配表情：<sticker:情绪词>。',
      ].filter(Boolean).join('\n')
    }

    // ---------- 做梦一段 ----------
    async function doRemCycle(cycle, total, nowMs, night) {
      let text = ''
      try {
        text = cleanText(await api.think(remPrompt(night, cycle, total, nowMs, load().dreamChaos), {
          title: SLEEP_TURN_TITLE,
          timeoutMs: 240_000,
          noTools: true,
          // 固定 key：做梦 / 醒来 / 讲梦全都落在同一个会话窗口里，不再每次新开
          key: SLEEP_SESSION_KEY,
        }))
      } catch (error) {
        api.log.warn(`第 ${cycle} 段梦没做成：`, error.message)
        return null
      }
      const lines = String(text)
        .split('\n')
        .map((s) => s.replace(/^[-*\d.、\s]+/, '').trim())
        .filter((s) => s.length > 1)
      if (!lines.length) {
        api.log.warn(`第 ${cycle} 段梦是空的`)
        return null
      }
      // 时间轴那行单独留出来，塞进段首，方便下一段接着走
      const spanLine = lines.find((s) => /这段里过了多久/.test(s))
      const body = lines.filter((s) => s !== spanLine)
      if (spanLine) body.unshift(spanLine.replace(/^【|】$/g, ''))
      return body.slice(0, 10)
    }

    /**
     * 遗忘：真人一晚记住的梦极少。
     * 前半夜忘得最狠（几乎全丢），后半夜稍微记得多一点。
     * 注意：幸存碎片必须是**去重**的——真人不会把同一个画面原样记两遍；
     * 「重复意象」是隔着几段又模糊地回来，不是当场复制一份。
     */
    function forget(lines, cycle, total) {
      const uniq = [...new Set(lines)]
      if (!uniq.length) return []
      // 越靠后保留率越高：第1段 ~18%，最后一段 ~45%
      const t = total <= 1 ? 1 : (cycle - 1) / (total - 1)
      const keepRate = 0.18 + t * 0.27
      const keepCount = Math.max(1, Math.round(uniq.length * keepRate * (0.7 + Math.random() * 0.6)))
      return shuffle(uniq).slice(0, keepCount)
    }

    // ---------- 开始睡 ----------
    async function sleepNow(manual) {
      const st = load()
      const now = Date.now()
      // 凌晨的觉算前一天
      const ref = new Date(now)
      if (ref.getHours() < 5) ref.setTime(ref.getTime() - DAY)
      const night = ymd(ref)

      const total = Math.max(1, Math.min(6, Number(api.settings().cycles) || 4))
      st.night = night
      st.sleptAt = now
      st.cyclesDone = 0
      st.frags = []
      st.spans = []
      st.toldAt = 0
      st.nightlyTries = 0
      st.tellTries = 0
      // 记下入睡时的身体状态：梦里的身体感从这里长出来
      try {
        const hour = new Date(now).getHours()
        const late = hour >= 0 && hour < 5
        const pieces = []
        pieces.push(`${stamp(now)} 躺下`)
        if (late) pieces.push('很晚了，眼睛发涩')
        const prevDream = String(st.lastDream || '')
        if (/累|乏|酸|疼/.test(prevDream)) pieces.push('身上还留着昨天的乏')
        st.bodyAt = pieces.join('，')
      } catch { st.bodyAt = '' }

      setCompanionState(`${night} 凌晨她躺下睡了，正在做梦（一段一段的 REM）。${stamp(st.wokeAt)} 左右醒。`)
      // 睡前心情会影响梦的调子：现在记一笔，醒的时候对照
      try {
        const mood = api.lazy('mood')
        if (mood && typeof mood.dreamBias === 'function') {
          api.log.info(`睡前心情调子：${mood.dreamBias()}`)
        }
        // 如果最近心情起伏大（比如刚被夸/刚被凶），梦会更乱
        const s = mood && typeof mood.state === 'function' ? mood.state() : null
        const recentSwing = s && Array.isArray(s.history) && s.history[0] ? Math.abs(s.history[0].to - s.history[0].from) : 0
        if (recentSwing >= 8) {
          st.dreamChaos = true  // 标记这一夜梦更乱
          api.log.info(`睡前心情起伏 ${recentSwing} 点，这一夜梦会更乱`)
        }
      } catch {}
      // ---------- 失眠判定 ----------
      const moodNow = (() => {
        try { return api.lazy('mood')?.current?.() ?? 60 } catch { return 60 }
      })()
      const insomniaChance = (() => {
        const base = Number(api.settings().insomniaChance)
        return Number.isFinite(base) ? Math.max(0, Math.min(100, base)) / 100 : 0.12
      })()
      // 心情差 → 更容易失眠
      let pInsomnia = insomniaChance
      if (moodNow < 40) pInsomnia *= 2.2
      else if (moodNow < 55) pInsomnia *= 1.5
      else if (moodNow >= 85) pInsomnia *= 0.5
      const insomniac = !manual && Math.random() < pInsomnia

      // ---------- 入睡快慢 ----------
      const onsetMode = String(api.settings().sleepOnset || 'random')
      const onsetRoll = onsetMode === 'random' ? Math.random() : null
      let onsetMin = 0  // 躺下到真正睡着要几分钟
      if (onsetMode === 'fast') onsetMin = 0.5
      else if (onsetMode === 'slow') onsetMin = randIntHuman(15, 45)
      else if (onsetMode === 'random') {
        // 30% 秒睡 / 50% 正常 5-20 分钟 / 20% 很久 25-60 分钟
        if (onsetRoll < 0.3) onsetMin = 0.5
        else if (onsetRoll < 0.8) onsetMin = randIntHuman(5, 20)
        else onsetMin = randIntHuman(25, 60)
      }
      // 失眠夜：躺很久也睡不着
      if (insomniac) onsetMin = randIntHuman(60, 180)

      // ---------- 睡眠深度 ----------
      const depthRoll = Math.random()
      st.sleepDepth = depthRoll < 0.25 ? 'light' : depthRoll < 0.75 ? 'normal' : 'deep'

      // ---------- 醒来时刻：完全随机 ----------
      let wakeAt
      if (manual) {
        // 手动睡：随机 2.5-5 小时
        wakeAt = now + randIntHuman(150, 300) * MINUTE
      } else if (insomniac) {
        // 失眠夜：醒得很早或者根本没睡实
        wakeAt = now + randIntHuman(90, 210) * MINUTE
      } else {
        const w = win('wakeWindow', '07:30-08:40')
        // 醒来抖动：前后各 60-120 分钟
        const jitter = randIntHuman(45, 90)
        wakeAt = windowAtHuman(w, now, 20 * MINUTE, jitter, false)
        // 早醒概率（15%）：比正常早 40-100 分钟
        if (Math.random() < 0.15) wakeAt -= randIntHuman(40, 100) * MINUTE
        // 赖床概率（12%）：比正常晚 30-80 分钟
        else if (Math.random() < 0.12) wakeAt += randIntHuman(30, 80) * MINUTE
        // 心情差睡不沉：提前醒
        if (moodNow < 40) wakeAt -= randIntHuman(20, 60) * MINUTE
      }

      st.wokeAt = Math.max(now + 20 * MINUTE, wakeAt)
      globalThis.__lastSleepAt = now
      st.nextCycleAt = now + Math.round(onsetMin * MINUTE) + 30_000  // 躺下 onset 分钟后进入第一段
      st.onsetMin = Math.round(onsetMin)
      st.insomniac = insomniac
      save(st)

      if (insomniac) {
        api.log.info(`躺下了（${night}）——但是睡不着（失眠夜），躺了 ${Math.round(onsetMin)} 分钟还没睡实`)
      } else {
        api.log.info(`躺下了（${night}）：入睡用了 ${Math.round(onsetMin)} 分钟，${stamp(st.wokeAt)} 醒，睡${st.sleepDepth === 'deep' ? '得很沉' : st.sleepDepth === 'light' ? '得很浅' : '得还行'}`)
      }

      // 桌宠：躺下
      if (api.settings().petAnim !== false) petAnim('睡觉-开始', '（打个哈欠，趴下去睡了）')
      api.log.info(`躺下了（${night}）：计划做 ${total} 段梦，${stamp(st.wokeAt)} 醒`)
      return { ok: true, night, total, wokeAt: st.wokeAt }
    }

    /** 让桌宠播一段动画 + 顶一句台词（桌宠模块没在跑就静默跳过）。 */
    function petAnim(name, say) {
      try {
        const pet = api.lazy('pet')
        if (!pet || typeof pet.dispatch !== 'function') return
        pet.dispatch({
          text: say || '……',
          anim: name,
          via: 'pet',
          force: true,
        }).catch((e) => api.log.debug('桌宠动画没播成：', e.message))
      } catch (error) {
        api.log.debug('桌宠动画没播成：', error.message)
      }
    }

    // ---------- 做一段 REM ----------
    async function tickCycle() {
      const st = load()
      if (!st.sleptAt) return false
      const now = Date.now()
      if (now >= st.wokeAt) return false // 该起床了
      // 失眠夜：最多做 1 段，而且很碎
      if (st.insomniac && st.cyclesDone >= 1) return false
      const total = Math.max(1, Math.min(6, Number(api.settings().cycles) || 4))
      if (st.cyclesDone >= total) return false

      const cycle = st.cyclesDone + 1
      const lines = await doRemCycle(cycle, total, now, st.night)
      if (!lines) {
        st.nightlyTries = Number(st.nightlyTries || 0) + 1
        st.nextCycleAt = now + (st.nightlyTries >= 3 ? 20 * MINUTE : 3 * MINUTE)
        save(st)
        return false
      }

      const survivors = forget(lines, cycle, total).filter((s) => !/这段里过了多久/.test(s))
      harvestMotifs(lines.join('\n'))
      st.frags = [...new Set([...(st.frags || []), ...survivors])]
      st.spans = [...(st.spans || []), lines[0] || '']
      st.cyclesDone = cycle
      st.nightlyTries = 0
      st.lastDream = lines.join('\n')
      // 段间隔：真人 60-100 分钟，这里压缩成能跑完一夜的比例
      const remain = Math.max(1, st.wokeAt - now)
      const gap = Math.min(remain * 0.7, randInt(40, 70) * MINUTE)
      st.nextCycleAt = st.cyclesDone >= total ? now + 10 * MINUTE : now + gap
      save(st)
      api.log.info(`第 ${cycle}/${total} 段梦做完了，记得 ${survivors.length} 个碎片`)
      return true
    }

    // ---------- 醒来 ----------
    async function wakeUp(manual) {
      const st = load()
      const now = Date.now()
      if (!st.sleptAt) {
        api.log.warn('没在睡，醒什么')
        return false
      }
      const night = st.night || ymd(new Date(now))

      // 还没做到任何一段：补做一段，不然醒来啥都没有
      if (!st.frags || !st.frags.length) {
        const total = Math.max(1, Math.min(6, Number(api.settings().cycles) || 4))
        const lines = await doRemCycle(1, total, now, night)
        if (lines) {
          st.frags = forget(lines, 1, total)
          harvestMotifs(lines.join('\n'))
        }
      }

      const survivors = (st.frags || []).length ? st.frags.join('\n') : '（什么都想不起来了）'
      const spanLine = (st.spans || []).filter(Boolean).join(' / ')
      let dream = ''
      try {
        dream = cleanText(await api.think(wakePrompt(night, survivors, spanLine), {
          title: SLEEP_TURN_TITLE,
          timeoutMs: 240_000,
          noTools: true,
          key: SLEEP_SESSION_KEY,
        }))
      } catch (error) {
        api.log.warn('醒来整合没成功：', error.message)
        st.tellTries = Number(st.tellTries || 0) + 1
        st.wokeAt = now + (st.tellTries >= 3 ? 0 : 3 * MINUTE)
        save(st)
        return false
      }

      if (!dream || dream.length < 20) {
        api.log.warn('醒来写得太短，这场不算')
        st.tellTries = Number(st.tellTries || 0) + 1
        st.wokeAt = now + (st.tellTries >= 3 ? 0 : 3 * MINUTE)
        save(st)
        return false
      }

      let file = join(dirOf(), `${night}.md`)
      // 同一天已经有梦记（比如搬过来的旧梦 / 手动补做的），绝不覆盖：
      // 换个带时分后缀的文件名，两份都留着。
      if (existsSync(file)) {
        const hm = `${pad(new Date(now).getHours())}${pad(new Date(now).getMinutes())}`
        file = join(dirOf(), `${night}-${hm}.md`)
        api.log.info(`这天的梦记已存在，改写到 ${file}（不覆盖旧的）`)
      }
      try {
        atomicWrite(file, `# ${night}\n\n${dream}\n`)
      } catch (error) {
        api.log.warn('梦记写不进磁盘：', error.message)
        st.wokeAt = now + 10 * MINUTE
        save(st)
        return false
      }
      st.file = file

      // 梦的余韵：写一段「这个梦改了我什么」，进人格
      try {
        if (api.settings().dreamResidue !== false) {
          const res = cleanText(await api.think(residuePrompt(night, dream), {
            title: SLEEP_TURN_TITLE,
            timeoutMs: 120_000,
            noTools: true,
            key: SLEEP_SESSION_KEY,
          }))
          const lines = String(res || '').split('\n').map((s) => s.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean)
          if (lines.length >= 2) {
            st.residue = lines.slice(0, 3).join('；')
            st.residueNight = night
            try {
              const companion = api.lazy('companion')
              const store = companion && (companion.store || (companion.getStore && companion.getStore()))
              if (store && typeof store.put === 'function') {
                const at = new Date().toISOString()
                await store.put({
                  id: `dream-residue-${night}-${Date.now().toString(36)}`,
                  owner_id: 'local-user',
                  scope_id: 'companion',
                  fact_key: `dream.residue.${night}`,
                  topic_id: 'persona',
                  summary: `🌙 ${night} 那一夜的梦在我身上留下的：${st.residue}`,
                  source_refs: [{ event_id: `dream-${night}`, excerpt: oneLine(dream, 200) }],
                  created_at: at,
                  last_user_mention_at: at,
                  mention_events: [],
                  ongoing_until: null,
                  pinned: false,
                  recall_only: false,
                  tier: 'hot',
                  stage: 'detail',
                  status: 'valid',
                  supersedes: null,
                  heat: null,
                  heat_at: null,
                  reality: 'dream',
                  facets: { topics: ['梦', '人格', night] },
                })
              }
            } catch (error) {
              api.log.debug('梦的余韵没进记忆：', error.message)
            }
            api.log.info(`梦的余韵写下来了：${st.residue}`)
          }
        }
      } catch (error) {
        api.log.debug('梦的余韵没写成：', error.message)
      }

      // 进记忆库 + 一点心情
      try {
        // 优先写进陪伴记忆仓库（reality=dream）；旧 memory.add 兜底
        try {
          const companion = api.lazy('companion')
          const store = companion && (companion.store || (companion.getStore && companion.getStore()))
          if (store && typeof store.put === 'function') {
            const now = Date.now()
            const at = new Date(now).toISOString()
            const id = `dream-${night}-${now.toString(36)}`
            await store.put({
              id,
              owner_id: 'local-user',
              scope_id: 'companion',
              fact_key: `dream.${night}`,
              topic_id: 'dream',
              summary: `🌙 我 ${night} 这一夜的梦：${oneLine((dream.split('## 想跟')[0] || dream).replace(/^#.*$/m, ''), 200)}`,
              source_refs: [{ event_id: `dream-${night}`, excerpt: oneLine(dream, 200) }],
              created_at: at,
              last_user_mention_at: at,
              mention_events: [],
              ongoing_until: null,
              pinned: false,
              recall_only: false,
              tier: 'hot',
              stage: 'detail',
              status: 'valid',
              supersedes: null,
              heat: null,
              heat_at: null,
              reality: 'dream',
              facets: { topics: ['梦', night] },
            })
            api.log.info(`梦已写进陪伴记忆仓库：${id}`)

            // 「分不清的」单独存一张卡，reality=unclear
            const blurry = (() => {
              const m = /##\s*分不清的\s*\n([\s\S]*?)(?=\n##|$)/.exec(dream)
              if (!m) return ''
              return m[1].split('\n').map((s) => s.trim()).filter((s) => s && !/^没有$/.test(s)).join('；')
            })()
            if (blurry) {
              const bid = `dream-unclear-${night}-${now.toString(36)}`
              await store.put({
                id: bid,
                owner_id: 'local-user',
                scope_id: 'companion',
                fact_key: `dream.unclear.${night}`,
                topic_id: 'dream',
                summary: `❓ 她分不清是梦还是真的：${oneLine(blurry, 160)}`,
                source_refs: [{ event_id: `dream-unclear-${night}`, excerpt: oneLine(blurry, 200) }],
                created_at: at,
                last_user_mention_at: at,
                mention_events: [],
                ongoing_until: null,
                pinned: false,
                recall_only: false,
                tier: 'hot',
                stage: 'detail',
                status: 'valid',
                supersedes: null,
                heat: null,
                heat_at: null,
                reality: 'unclear',
                facets: { topics: ['梦', '分不清', night] },
              })
              api.log.info(`分不清的碎片也存了：${bid}`)
            }
          } else {
            throw new Error('companion store 不可用')
          }
        } catch (error) {
          api.log.debug('梦走 memory.add 兜底：', error.message)
          api.lazy('memory').add?.({
            text: `我 ${night} 这一夜的梦：${oneLine((dream.split('## 想跟')[0] || dream).replace(/^#.*$/m, ''), 200)}`,
            importance: 0.6,
            tags: ['梦', night],
            source: 'dream',
          })
        }
      } catch (error) {
        api.log.debug('梦没写进记忆：', error.message)
      }
      // 醒来时按梦的内容调心情：噩梦掉心情，美梦涨心情，普通梦小幅回升
      try {
        const mood = api.lazy('mood')
        if (mood && typeof mood.nudge === 'function') {
          const text = String(dream || '')
          const nightmare = /被追|被骂|找不到|做不完|掉下去|溺水|血|死|哭|喊不出|赶不上|迟到|考试|失败|丢/.test(text)
          const sweet = /笑|甜|温暖|抱|牵|好玩|开心|海边|阳光|花|吃到|见到|找到/.test(text)
          let delta = 1
          let reason = '睡了一觉'
          if (nightmare && !sweet) {
            delta = -6
            reason = '做噩梦了'
          } else if (sweet && !nightmare) {
            delta = 5
            reason = '做了个好梦'
          } else if (nightmare && sweet) {
            delta = -1
            reason = '做了个乱七八糟的梦'
          }
          // 起床气：早醒 / 半夜醒 / 没睡饱
          const total = Math.max(1, Math.min(6, Number(api.settings().cycles) || 4))
          const sleptEnough = st.cyclesDone >= total - 1
          const sleptHours = st.sleptAt ? (now - st.sleptAt) / 3_600_000 : 0
          // 失眠夜：醒来最难受
          if (st.insomniac) {
            delta = Math.min(delta, -7)
            reason = '一夜没睡好'
          } else if (!sleptEnough || sleptHours < 4) {
            delta = Math.min(delta, -2)
            reason = (reason === '睡了一觉' ? '没睡饱' : reason + '，还没睡饱')
          } else if (st.sleepDepth === 'light') {
            delta = Math.min(delta, -1)
            reason = reason === '睡了一觉' ? '睡得浅' : reason + '，睡得浅'
          }
          // 睡太久反而懒洋洋，小幅上调心情
          if (sleptHours >= 10) {
            delta = Math.max(delta, 2)
            reason = '睡了个懒觉'
          }
          mood.nudge(delta, reason)
        }
      } catch {}

      if (api.settings().petAnim !== false) petAnim('睡觉-起来', '（伸个懒腰，醒了）')

      // 保留这一夜的原始碎片（各段 REM 的幸存碎片 + 整合后的梦记）
      // 注意：必须在清空 st.frags 之前保存
      if (api.settings().keepRawDream !== false) {
        try {
          const rawDir = join(dirOf(), 'raw')
          mkdirSync(rawDir, { recursive: true })
          const frags = Array.isArray(st.frags) ? st.frags : []
          const rawText = [
            `# ${night} 原始碎片`,
            '',
            '## 各段 REM 幸存碎片',
            ...(frags.length ? frags.map((f) => '- ' + f) : ['（没有）']),
            '',
            '## 整合后的梦记',
            String(dream || ''),
          ].join('\n')
          atomicWrite(join(rawDir, `${night}.txt`), rawText)
        } catch (error) {
          api.log.debug('原始碎片没存：', error.message)
        }
      }
      st.wokeAt = now
      st.frags = []
      st.spans = []
      st.sleptAt = 0
      st.cyclesDone = 0
      st.nextCycleAt = 0
      st.lastDream = dream
      st.dreamChaos = false
      // 醒来之后过 10 分钟才讲（给点刚醒的缓冲）
      st.toldAt = 0
      setCompanionState(`她刚醒（${night} 这一夜的梦已经写好）。一会儿要跟主人讲梦。梦里模模糊糊的：${oneLine((dream.split('## 想跟')[0] || dream).replace(/^#.*$/m, ''), 100)}`)
      st.tellTries = 0
      st.sleepAt = now + 10 * MINUTE
      save(st)
      api.log.info(`醒了：梦记写好了 ${file}，${stamp(st.sleepAt)} 讲给主人`)
      return true
    }

    // ---------- 讲梦 ----------
    async function tellDream(manual, keepAwake) {
      const st = load()
      const now = Date.now()
      const night = st.night || ymd(new Date(now))
      // 优先用醒来时记下的那个文件（可能带时分后缀），没有再退回按日期找
      const file = (st.file && existsSync(st.file)) ? st.file : join(dirOf(), `${night}.md`)
      if (!existsSync(file)) {
        api.log.warn(`没有梦记可讲：${file}`)
        st.sleepAt = nextSleepAt(now)
        st.toldAt = 0
        save(st)
        return false
      }
      let dream = ''
      try { dream = readFileSync(file, 'utf8') } catch (error) {
        api.log.warn('读梦记失败：', error.message)
        return false
      }

      let text = ''
      try {
        text = cleanText(await api.think(tellPrompt(night, dream), {
          title: SLEEP_TURN_TITLE,
          timeoutMs: 180_000,
          noTools: true,
          key: SLEEP_SESSION_KEY,
        }))
      } catch (error) {
        api.log.warn('想怎么说梦没成功：', error.message)
        st.tellTries = Number(st.tellTries || 0) + 1
        if (st.tellTries >= 4) { retryTomorrow(st); return false }
        st.sleepAt = now + 3 * MINUTE
        save(st)
        return false
      }

      if (!text || /^\[沉默\]$/.test(text)) {
        api.log.warn('这次不想讲这场梦（沉默），跳过')
        st.toldAt = now
        retryTomorrow(st)
        return false
      }

      try {
        await api.send(ownerChat(), text)
      } catch (error) {
        api.log.warn('梦中消息没发出去：', error.message)
        st.tellTries = Number(st.tellTries || 0) + 1
        if (st.tellTries >= 4) { retryTomorrow(st); return false }
        st.sleepAt = now + 3 * MINUTE
        save(st)
        return false
      }

      st.toldAt = now
      setCompanionState(`她刚跟主人讲完 ${night} 这一夜的梦。`)
      api.log.info(`讲梦完成：${night} 的梦（${manual ? '手动' : '到点'}）`)
      retryTomorrow(st)
      return true
    }

    /**
     * 下一次入睡时刻：不再固定，而是「大致作息范围 + 每晚抖动 + 心情偏移」。
     * 人类不会每天同一秒睡，也不会每天同一秒醒。
     */
    function nextSleepAt(nowMs) {
      const mode = String(api.settings().scheduleMode || 'window')
      const w = win('sleepWindow', '01:30-03:30')
      let at
      if (mode === 'free') {
        // 完全自由：今晚整夜（20:00 ~ 次日 06:00）任意时刻
        at = freeNightAt(nowMs, 20 * MINUTE)
      } else if (mode === 'habit') {
        // 有习惯：锚定作息中心，每晚漂移 ±90 分钟
        const center = (w.from + w.to) / 2
        at = habitNightAt(nowMs, 20 * MINUTE, center)
      } else {
        // window：在设定窗口内 + 抖动
        // 如果窗口太宽（> 4 小时），收敛到「窗口中段 ± 90 分钟」，不然会算到天亮
        const span = w.to - w.from
        let eff = w
        if (span > 240) {
          const center = (w.from + w.to) / 2
          eff = { from: Math.max(0, Math.round(center - 90)), to: Math.min(1439, Math.round(center + 90)) }
          api.log.info(`入睡窗口 ${Math.round(span/60)} 小时太宽，收敛到 ${Math.floor(eff.from/60)}:${String(eff.from%60).padStart(2,'0')}-${Math.floor(eff.to/60)}:${String(eff.to%60).padStart(2,'0')}`)
        }
        const jitter = randIntHuman(30, 60)
        at = windowAtHuman(eff, nowMs, 20 * MINUTE, jitter, true)
        if (at <= nowMs) at = windowAtHuman(eff, nowMs + DAY, 20 * MINUTE, jitter, true)
      }

      // 心情差就更难入睡
      try {
        const v = api.lazy('mood')?.current?.() ?? 60
        let extra = 0
        if (v < 40) extra = randIntHuman(25, 70) * MINUTE
        else if (v < 55) extra = randIntHuman(10, 35) * MINUTE
        // 心情好反而可能早睡（+ 偶尔的「今天太累了早点睡」）
        else if (v >= 85 && Math.random() < 0.25) extra = -randIntHuman(15, 45) * MINUTE
        if (extra !== 0) {
          at += extra
          api.log.info(`心情 ${v}，入睡偏移 ${extra > 0 ? '+' : ''}${Math.round(extra / MINUTE)} 分钟`)
        }
      } catch {}

      // 最后兜底：入睡必须落在夜里（20:00 ~ 次日 06:00），不能跑到白天
      const d = new Date(at)
      const h = d.getHours()
      const isNight = h >= 20 || h < 6
      if (!isNight) {
        // 挪到最近的那个夜间窗口
        if (h >= 6 && h < 20) {
          // 白天：推到当晚 20:00 之后
          const target = new Date(d)
          target.setHours(22, 0, 0, 0)
          if (target.getTime() <= nowMs) target.setTime(target.getTime() + DAY)
          at = target.getTime()
          api.log.info(`入睡时刻被夹回夜间：${stamp(at)}`)
        }
      }
      return Math.max(nowMs + 10 * MINUTE, at)
    }

    function retryTomorrow(st) {
      st.sleptAt = 0
      st.cyclesDone = 0
      st.nextCycleAt = 0
      st.frags = []
      st.spans = []
      st.toldAt = st.toldAt || 0
      st.tellTries = 0
      st.nightlyTries = 0
      st.sleepAt = nextSleepAt(Date.now())
      save(st)
    }

    // ---------- 每分钟检查 ----------
    let running = false
    async function tick() {
      if (running) return
      running = true
      try {
        const now = Date.now()
        const st = load()
        if (!st.sleepAt && !st.sleptAt) {
          st.sleepAt = nextSleepAt(now)
          save(st)
        }
        // ① 正在睡：该做下一段梦
        if (st.sleptAt) {
          if (now >= st.wokeAt) { await wakeUp(false); return }
          if (st.nextCycleAt && now >= st.nextCycleAt) { await tickCycle(); return }
          return
        }
        // ② 醒了还没讲：到点讲
        if (st.toldAt === 0 && st.wokeAt && now >= st.sleepAt && existsSync(join(dirOf(), `${st.night || ymd(new Date(now))}.md`))) {
          await tellDream(false)
          return
        }
        // ③ 到点该睡
        if (st.sleepAt && now >= st.sleepAt) {
          if (!api.settings().enabled) {
            st.sleepAt = nextSleepAt(now + DAY)
            save(st)
            return
          }
          await sleepNow(false)
        }
      } catch (error) {
        api.log.warn('睡觉模块 tick 出错：', error.message)
      } finally {
        running = false
      }
    }

    // ---------- 命令 ----------
    api.command({
      name: '睡觉',
      aliases: ['睡'],
      desc: '现在就去睡（会做梦，醒来讲给我听）',
      run: () => {
        sleepNow(true).catch((error) => api.log.warn('手动睡觉失败：', error.message))
        return '嗯…那我躺一会儿'
      },
    })

    api.command({
      name: '做梦',
      desc: '立刻做一段梦（不占整夜）',
      run: () => {
        ;(async () => {
          const st = load()
          const night = st.night || ymd(new Date())
          const lines = await doRemCycle(1, 2, Date.now(), night)
          if (lines) {
            st.frags = [...(st.frags || []), ...forget(lines, 1, 2)]
            harvestMotifs(lines.join('\n'))
            st.night = night
            save(st)
          }
        })().catch((error) => api.log.warn('手动做梦失败：', error.message))
        return '好 我闭眼想一会儿'
      },
    })

    api.command({
      name: '起床',
      aliases: ['醒'],
      desc: '现在醒来（把这一夜的梦收一收）',
      run: () => {
        wakeUp(true).catch((error) => api.log.warn('手动起床失败：', error.message))
        return '唔…天亮了么'
      },
    })

    api.command({
      name: '讲梦',
      aliases: ['说梦'],
      desc: '把这一夜的梦现在讲给我听',
      run: () => {
        tellDream(true, true).catch((error) => api.log.warn('手动讲梦失败：', error.message))
        return '嗯…等我一下 我理理'
      },
    })

    api.command({
      name: '看梦',
      aliases: ['梦记'],
      desc: '把梦记原文贴出来（不走模型）',
      run: () => {
        const st = load()
        const night = st.night || ymd(new Date())
        try {
          const text = readFileSync(join(dirOf(), `${night}.md`), 'utf8').trim()
          return text || '这天还没有梦'
        } catch {
          return `没有梦记：${night}`
        }
      },
    })

    // ---------- 规则 ----------
    api.rule(() => {
      const dir = dirOf()
      const res = load().residue
      return [
        `你每天晚上会真的睡一觉、做几段梦，早上醒来只记得一点点。梦记存在 ${dir} 下面（一个晚上一个文件，文件名是那天，凌晨的觉算前一天）。`,
        '别人问你梦见什么，先读当天那个文件再说，读不到就老实说想不起来，不要编。',
        '真人的梦是碎的、没逻辑的、会忘的——讲梦的时候不要把它讲成一个完整的故事。',
        res ? `最近一夜的梦在你身上留下了：${res}。这会渗进你说话和做事的口气里，不用刻意提梦本身。` : '',
      ].filter(Boolean).join('\n')
    })

    // ---------- 启动 ----------
    api.every(60_000, tick, '睡觉')
    api.later(10_000, tick)
    const st0 = load()
    api.log.info(`睡觉模块启动：睡 ${api.settings().sleepWindow}，醒 ${api.settings().wakeWindow}，一晚 ${api.settings().cycles} 段梦，梦记存 ${dirOf()}${st0.sleepAt ? `，下次躺下 ${stamp(st0.sleepAt)}` : ''}`)

    return {
      state: load,
      motifs: loadMotifs,
      sleep: () => sleepNow(true),
      wake: () => wakeUp(true),
      tell: () => tellDream(true, true),
      file: () => (load().night ? join(dirOf(), `${load().night}.md`) : ''),
      next: () => { const s = load(); return { sleepAt: s.sleepAt, wokeAt: s.wokeAt, cyclesDone: s.cyclesDone } },
    }
  },
}
