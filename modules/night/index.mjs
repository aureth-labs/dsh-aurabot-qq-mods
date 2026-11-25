// 长夜如梦 · Aurabot 模块
//
// 她有一副会累的身体：
// - 精力 / 疲劳期 / 最晚睡觉时间
// - 四段睡眠（刚入睡、浅层、深度、REM），90 分钟一个周期
// - 睡着时按概率被叫醒，深睡最难叫
// - 只在 REM 做梦，梦按 1~5 级衰减，醒来只记得最强的那个
// - 睡前道别、收线识别、起床点浮动
//
// 醒后的「爬楼」只记会话清单，不生成爬楼语；梦的正文只留在本模块的私人记录里，
// 不进共享记忆，避免私人内容进到群聊上下文。

import { isClosing, closeMinutes, isAskingMe } from './close.mjs'
import { configureClock, wall } from './clock.mjs'
import { createLullaby, isFarewell } from './lullaby.mjs'
import { Dreamer } from './dream.mjs'
import { AWAKE, ASLEEP, WAKING, NightService } from './state.mjs'
import * as energy from './energy.mjs'
import * as stages from './stages.mjs'

const DEFAULTS = {
  enabled: true,
  wakeTime: '08:00',
  wakeJitterMinutes: 40,
  nightFatigue: '23:30-07:00',
  noonFatigue: '13:00-14:30',
  latestSleepTime: '02:30',
  allowSleep: true,
  energyMax: 100,
  energyPerMinute: 0.8,
  energyPerMessage: 4,
  energyRecoverPerMinute: 1.5,
  energyAfterWake: 35,
  minTurnsBeforeSleep: 8,
  energyOwnerOnly: true,
  noonNapMinutes: 60,
  noonNapJitterMinutes: 15,
  wakingTimeoutMinutes: 5,
  crawlEnabled: true,

  stageEnabled: true,
  stageCycleMinutes: 90,
  stageN1Minutes: 8,
  stageDeepMaxMinutes: 36,
  stageDeepDecay: 0.28,
  stageRemBaseMinutes: 10,
  stageRemGrowMinutes: 6,
  stageRemMaxMinutes: 28,
  stageNoonLightOnly: true,

  dreamEnabled: true,
  dreamInRemOnly: true,
  dreamStartAfterMinutes: 60,
  dreamIntervalMinutes: 60,
  dreamMaxPerSleep: 8,
  dreamMaxTokens: 900,
  dreamTags: '旧房子,走不完的路,熟人,水,飞,找东西,错过,小时候,雨,光',
  noonDreamChance: 0.5,

  wakeMode: 'private_only',
  wakeWindowMinutes: 10,
  wakeStartCount: 2,
  wakeStepCount: 4,

  farewellEnabled: true,
  farewellUseLlm: false,
  deferWhileAsleep: true,

  closeEnabled: true,
  closeScope: 'owner',
  closeSleepStrength: 'strong',
  closeConfirmByLlm: true,      // 关键字判定命中后，再让模型复核一次（防误睡）
  byeMuteMinutes: 30,
  noonMuteMinutes: 75,

  morningGreeting: false,

  // 主动说困 / 晚安（2026-11-24 加）
  sleepTalkEnabled: true,       // 困到一定程度主动跟主人说一声
  sleepTalkEnergy: 25,          // 精力低于这个值就算「困到想睡」
  sleepTalkNoonEnabled: true,   // 午间也提醒（她说中午收到过，这个要留）
  sleepTalkCooldownMin: 240,    // 同一个时段最多提一次，隔多久才允许再提
  sleepTalkUseLlm: true,        // 用模型生成，更自然
  snoozeKeepMinutes: 180,       // 「待会睡」的约定保留多久（超时当没约过）
  dayMuteMinutes: 30,           // 白天收到收线但不睡时，安静多久（分钟）

  timeZone: 'Asia/Shanghai',
}

const SETTINGS = [
  { key: 'enabled', label: '启用长夜如梦', type: 'switch' },
  { key: 'allowSleep', label: '允许真睡（关掉只算精力，不进入睡眠）', type: 'switch' },

  { key: 'wakeTime', label: '起床点（HH:MM）', type: 'text' },
  { key: 'wakeJitterMinutes', label: '起床浮动（±分钟，最多 90）', type: 'number' },
  { key: 'latestSleepTime', label: '最晚睡觉时间（HH:MM）', type: 'text' },
  { key: 'nightFatigue', label: '夜间疲劳时段（如 23:30-07:00）', type: 'text' },
  { key: 'noonFatigue', label: '午间疲劳时段（如 13:00-14:30）', type: 'text' },
  { key: 'noonNapMinutes', label: '午睡时长（分钟）', type: 'number' },
  { key: 'noonNapJitterMinutes', label: '午睡浮动（±分钟）', type: 'number' },

  { key: 'energyMax', label: '精力上限', type: 'number' },
  { key: 'energyPerMinute', label: '疲劳期每分钟消耗', type: 'number' },
  { key: 'energyPerMessage', label: '疲劳期每条消息消耗', type: 'number' },
  { key: 'energyRecoverPerMinute', label: '非疲劳期每分钟恢复', type: 'number' },
  { key: 'energyAfterWake', label: '爬起来后的精力', type: 'number' },
  { key: 'minTurnsBeforeSleep', label: '疲劳期至少聊几轮才睡', type: 'number' },
  { key: 'energyOwnerOnly', label: '只有主人说话才扣精力', type: 'switch' },

  { key: 'stageEnabled', label: '启用睡眠阶段', type: 'switch' },
  { key: 'stageCycleMinutes', label: '睡眠周期（分钟）', type: 'number' },
  { key: 'stageN1Minutes', label: '刚入睡时长（分钟）', type: 'number' },
  { key: 'stageDeepMaxMinutes', label: '首个周期深睡上限（分钟）', type: 'number' },
  { key: 'stageRemMaxMinutes', label: 'REM 上限（分钟）', type: 'number' },

  { key: 'dreamEnabled', label: '做梦', type: 'switch' },
  { key: 'dreamInRemOnly', label: '只在 REM 阶段做梦', type: 'switch' },
  { key: 'dreamStartAfterMinutes', label: '入睡多久后开始做梦', type: 'number' },
  { key: 'dreamIntervalMinutes', label: '两段梦最短间隔', type: 'number' },
  { key: 'dreamMaxPerSleep', label: '一次睡眠最多几段梦', type: 'number' },
  { key: 'dreamMaxTokens', label: '梦的最大输出 token', type: 'number' },
  { key: 'dreamTags', label: '梦的意象池（逗号分隔）', type: 'textarea' },
  { key: 'noonDreamChance', label: '午睡做梦概率（0~1）', type: 'number' },

  { key: 'wakeMode', label: '谁能叫醒她', type: 'select', options: [
    { label: '谁都不叫', value: 'never' },
    { label: '只有私聊', value: 'private_only' },
    { label: '私聊和群聊（群里要 @）', value: 'both' },
  ] },
  { key: 'wakeWindowMinutes', label: '唤醒计数窗口（分钟）', type: 'number' },
  { key: 'wakeStartCount', label: '第几条开始掷骰', type: 'number' },
  { key: 'wakeStepCount', label: '再几条必醒', type: 'number' },

  { key: 'farewellEnabled', label: '睡前道别', type: 'switch' },
  { key: 'deferWhileAsleep', label: '睡着时压住媒体消息，醒来补发', type: 'switch' },
  { key: 'farewellUseLlm', label: '道别用模型生成（更自然，费 token）', type: 'switch' },

  { key: 'closeEnabled', label: '识别对方收线', type: 'switch' },
  { key: 'closeScope', label: '谁说的收线才算数', type: 'select', options: [
    { label: '只认主人（群里别人说晚安不睡也不闭嘴）', value: 'owner' },
    { label: '谁都认（群里有人道别就睡 / 闭嘴）', value: 'all' },
  ] },
  { key: 'closeSleepStrength', label: '什么强度才真睡', type: 'select', options: [
    { label: '只有「晚安 / 我睡了」这种强收线', value: 'strong' },
    { label: '强收线和中收线（拜拜 / 先这样）都睡', value: 'medium' },
  ] },
  { key: 'closeConfirmByLlm', label: '收线判定再让模型复核一次', type: 'switch',
    hint: '命中收线词之后才问模型，能区分「现在去睡」和「看完这集再睡」，避免误睡。'
      + '正常的聊天不会触发，只在偶尔有人道晚安时多一次很小的模型调用（约 10 token 输出，4 秒超时）。'
      + '介意 token 消耗可以关掉，关了就用纯规则判断。' },
  { key: 'byeMuteMinutes', label: '中/弱收线后闭嘴多久（分钟）', type: 'number' },
  { key: 'noonMuteMinutes', label: '午睡收线后闭嘴多久（分钟）', type: 'number' },

  { key: 'morningGreeting', label: '自然醒后给主人发早安', type: 'switch' },

  { key: 'sleepTalkEnabled', label: '困到想睡时主动说一声', type: 'switch' },
  { key: 'sleepTalkEnergy', label: '精力低于多少算困（0~100）', type: 'number' },
  { key: 'sleepTalkNoonEnabled', label: '午间也提醒（关掉只提醒夜里）', type: 'switch' },
  { key: 'sleepTalkCooldownMin', label: '同一个时段隔多久才再提（分钟）', type: 'number' },
  { key: 'sleepTalkUseLlm', label: '用模型生成这句话（更自然，费 token）', type: 'switch' },
  { key: 'snoozeKeepMinutes', label: '「待会再睡」记多久（分钟）', type: 'number' },
  { key: 'dayMuteMinutes', label: '白天收到晚安时安静多久（分钟）', type: 'number' },
  { key: 'timeZone', label: '作息按哪个时区（容器跑 UTC 时要填）', type: 'text' },
]

function cfgOf(api) {
  const s = api.settings() || {}
  const n = (key, fallback) => {
    const value = Number(s[key])
    return Number.isFinite(value) ? value : fallback
  }
  const b = (key, fallback) => (typeof s[key] === 'boolean' ? s[key] : fallback)
  const str = (key, fallback) => String(s[key] ?? fallback ?? '').trim()
  const tags = Array.isArray(s.dreamTags) ? s.dreamTags : String(s.dreamTags || '').split(/[,，\n]/)
  return {
    enabled: b('enabled', DEFAULTS.enabled),
    allowSleep: b('allowSleep', DEFAULTS.allowSleep),
    wakeTime: str('wakeTime', DEFAULTS.wakeTime),
    wakeJitterMinutes: n('wakeJitterMinutes', DEFAULTS.wakeJitterMinutes),
    latestSleepTime: str('latestSleepTime', DEFAULTS.latestSleepTime),
    nightFatigue: str('nightFatigue', DEFAULTS.nightFatigue),
    noonFatigue: str('noonFatigue', DEFAULTS.noonFatigue),
    noonNapMinutes: n('noonNapMinutes', DEFAULTS.noonNapMinutes),
    noonNapJitterMinutes: n('noonNapJitterMinutes', DEFAULTS.noonNapJitterMinutes),
    wakingTimeoutMinutes: n('wakingTimeoutMinutes', DEFAULTS.wakingTimeoutMinutes),
    crawlEnabled: b('crawlEnabled', DEFAULTS.crawlEnabled),

    energyMax: n('energyMax', DEFAULTS.energyMax),
    energyPerMinute: n('energyPerMinute', DEFAULTS.energyPerMinute),
    energyPerMessage: n('energyPerMessage', DEFAULTS.energyPerMessage),
    energyRecoverPerMinute: n('energyRecoverPerMinute', DEFAULTS.energyRecoverPerMinute),
    energyAfterWake: n('energyAfterWake', DEFAULTS.energyAfterWake),
    minTurnsBeforeSleep: n('minTurnsBeforeSleep', DEFAULTS.minTurnsBeforeSleep),
    energyOwnerOnly: b('energyOwnerOnly', DEFAULTS.energyOwnerOnly),

    stageEnabled: b('stageEnabled', DEFAULTS.stageEnabled),
    stageCycleMinutes: n('stageCycleMinutes', DEFAULTS.stageCycleMinutes),
    stageN1Minutes: n('stageN1Minutes', DEFAULTS.stageN1Minutes),
    stageDeepMaxMinutes: n('stageDeepMaxMinutes', DEFAULTS.stageDeepMaxMinutes),
    stageDeepDecay: n('stageDeepDecay', DEFAULTS.stageDeepDecay),
    stageRemBaseMinutes: n('stageRemBaseMinutes', DEFAULTS.stageRemBaseMinutes),
    stageRemGrowMinutes: n('stageRemGrowMinutes', DEFAULTS.stageRemGrowMinutes),
    stageRemMaxMinutes: n('stageRemMaxMinutes', DEFAULTS.stageRemMaxMinutes),
    stageNoonLightOnly: b('stageNoonLightOnly', DEFAULTS.stageNoonLightOnly),

    dreamEnabled: b('dreamEnabled', DEFAULTS.dreamEnabled),
    dreamInRemOnly: b('dreamInRemOnly', DEFAULTS.dreamInRemOnly),
    dreamStartAfterMinutes: n('dreamStartAfterMinutes', DEFAULTS.dreamStartAfterMinutes),
    dreamIntervalMinutes: n('dreamIntervalMinutes', DEFAULTS.dreamIntervalMinutes),
    dreamMaxPerSleep: n('dreamMaxPerSleep', DEFAULTS.dreamMaxPerSleep),
    dreamMaxTokens: n('dreamMaxTokens', DEFAULTS.dreamMaxTokens),
    dreamTags: tags.map((x) => String(x).trim()).filter(Boolean),
    noonDreamChance: n('noonDreamChance', DEFAULTS.noonDreamChance),

    wakeMode: str('wakeMode', DEFAULTS.wakeMode),
    wakeWindowMinutes: n('wakeWindowMinutes', DEFAULTS.wakeWindowMinutes),
    wakeStartCount: n('wakeStartCount', DEFAULTS.wakeStartCount),
    wakeStepCount: n('wakeStepCount', DEFAULTS.wakeStepCount),

    farewellEnabled: b('farewellEnabled', DEFAULTS.farewellEnabled),
    farewellUseLlm: b('farewellUseLlm', DEFAULTS.farewellUseLlm),
    deferWhileAsleep: b('deferWhileAsleep', DEFAULTS.deferWhileAsleep),

    closeEnabled: b('closeEnabled', DEFAULTS.closeEnabled),
    closeScope: str('closeScope', DEFAULTS.closeScope) || 'owner',
    closeSleepStrength: str('closeSleepStrength', DEFAULTS.closeSleepStrength),
    closeConfirmByLlm: b('closeConfirmByLlm', DEFAULTS.closeConfirmByLlm),
    byeMuteMinutes: n('byeMuteMinutes', DEFAULTS.byeMuteMinutes),
    noonMuteMinutes: n('noonMuteMinutes', DEFAULTS.noonMuteMinutes),

    morningGreeting: b('morningGreeting', DEFAULTS.morningGreeting),

    sleepTalkEnabled: b('sleepTalkEnabled', DEFAULTS.sleepTalkEnabled),
    sleepTalkEnergy: n('sleepTalkEnergy', DEFAULTS.sleepTalkEnergy),
    sleepTalkNoonEnabled: b('sleepTalkNoonEnabled', DEFAULTS.sleepTalkNoonEnabled),
    sleepTalkCooldownMin: n('sleepTalkCooldownMin', DEFAULTS.sleepTalkCooldownMin),
    sleepTalkUseLlm: b('sleepTalkUseLlm', DEFAULTS.sleepTalkUseLlm),
    snoozeKeepMinutes: n('snoozeKeepMinutes', DEFAULTS.snoozeKeepMinutes),
    dayMuteMinutes: n('dayMuteMinutes', DEFAULTS.dayMuteMinutes),

    timeZone: str('timeZone', DEFAULTS.timeZone),
  }
}

const dayText = (ts) => {
  if (!ts) return ''
  const w = wall(ts)
  return `${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
}

const levelStars = (level) => '★'.repeat(Math.max(1, Math.min(5, Number(level) || 1)))

export default {
  id: 'night',
  name: '长夜如梦',
  version: '1.1.0',
  api: 1,
  description: '她会在夜里犯困、睡着、做梦，睡着时叫不一定醒；醒来记得多少，看梦有多重。',
  defaults: DEFAULTS,
  settings: SETTINGS,
  panel: 'panel.js',

  async setup(api) {
    const cfgOfFn = () => {
      const c = cfgOf(api)
      // 每次读配置都同步一次时区：容器可能跑在 UTC，面板上填 Asia/Shanghai 就按它算作息
      configureClock({ timeZone: c.timeZone })
      return c
    }
    cfgOfFn()
    const lullaby = createLullaby()
    const dreamer = new Dreamer({ api, cfgOf: cfgOfFn, log: api.log })
    const service = new NightService({ api, cfgOf: cfgOfFn, dreamer, lullaby, log: api.log })
    await service.load()

    // ---------------------------------------------------------------- 同源校验
    // 面板路由默认不做来源检查，而 /dreams 会把梦境正文整段吐出去 ——
    // 相当于「发一个链接就能读到她的梦」。DSH 的 csrfBlocked 只拦写方法
    // （POST/PUT…），GET 是放行的，所以这道闸得自己加。
    // 所有接口都只做同源校验，不按方法区分 —— 因为面板运行时的 call()
    // 在没传 body 时用的是 GET（`body === undefined ? get(...) : post(...)`），
    // 比如「叫醒」按钮就是 `call('/wake')` 一个纯 GET。按方法拒绝会把面板自己挡死。
    // 跨站请求（带外站 Origin 或 Sec-Fetch-Site: cross-site）一律拒绝，
    // 那才是真正要防的东西。
    const hostAllowed = (h) => {
      const host = String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '')
      if (!host) return false
      if (host === 'localhost' || host.endsWith('.localhost')) return true
      if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
      if (host.startsWith('127.')) return true
      if (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return true
      try {
        const pub = String(api.config?.()?.security?.publicHostname || '').trim().toLowerCase()
        if (pub && host === pub) return true
      } catch {}
      return false
    }

    /** allowGet=true 表示这是读接口。非浏览器客户端（不带这两个头）放行，它们不是 CSRF 载体。 */
    const sameOriginOk = (req, allowGet) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (!allowGet && (method === 'GET' || method === 'HEAD')) return false
      const site = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
      if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false
      const origin = String(req?.headers?.origin || '').trim()
      if (origin) {
        let oh = ''
        try { oh = new URL(origin).hostname } catch { return false }
        if (!hostAllowed(oh)) return false
      }
      return true
    }

    const DENY_READ = { ok: false, denied: true, message: '只接受同源请求（防跨站读取作息和梦境）' }
    const DENY_WRITE = { ok: false, denied: true, message: '只接受同源请求（防跨站改她的作息）' }

    let lastDreamAttempt = 0
    let farewellBusy = false
    let lastOwnerAt = 0   // 主人最后一次说话的时间（说困之前要避开他正在说话）

    const morningGreeting = async () => {
      const cfg = cfgOfFn()
      if (!cfg.morningGreeting) return
      const owner = api.config()?.ownerQQ
      if (!owner) return
      const dream = service.state.morningDreamId ? dreamer.byId(service.state.morningDreamId) : null
      let text = ''
      try {
        text = await api.ask({
          system: '你刚睡醒。用一句很短的话告诉对方你醒了，可以提一下梦，但别解释设定。不要用括号动作。',
          text: `现在是${energy.clockText(Date.now())}。${dream ? `你记得的梦：${String(dream.text).slice(0, 200)}` : '你不记得做过梦。'}`,
          maxTokens: 120,
        })
      } catch {
        text = ''
      }
      text = String(text || '').trim() || '早，我醒了。'
      try {
        await api.send(`private:${owner}`, text)
      } catch (error) {
        api.log.warn('长夜：早安消息发送失败 ' + (error?.message || error))
      }
    }

    /**
     * 困到想睡时主动跟主人说一声（2026-11-24 加）
     *
     * 和「早安」不同：早安是醒来的动作，这个是**精力掉到一定程度**的自然反应。
     * 所以它不需要等睡着，只要精力低 + 处在疲劳时段就说。
     *
     * 时段区分（这是关键）：
     *   夜里（默认 23:30-07:00）→ 「要睡了」这种话
     *   中午（默认 13:00-14:30）→ 「去眯一会」，不能一口咬定睡到明早
     *   其他时段             → 只说困，不提睡觉（下午三点说「我要睡了」很怪）
     *
     * 用户实测中午收到过这类消息，所以午间默认开着。
     */
    const sleepTalkSent = new Map()   // kind → 上次发送时间，按会话内存记，重启会重置

    const sleepTalk = async () => {
      const cfg = cfgOfFn()
      if (!cfg.enabled || !cfg.sleepTalkEnabled) return
      const owner = api.config()?.ownerQQ
      if (!owner) return
      const s = service.state
      if (s.mode !== AWAKE) return                    // 已经睡了就不用说
      if (service.pendingSleep) return                 // 正挂着待睡，收线流程会自己说
      const threshold = Math.max(0, Math.min(100, Number(cfg.sleepTalkEnergy) || 25))
      if (Number(s.energy) > threshold) return         // 还没困到那个份上
      // 现在是不是疲劳时段，以及是哪个
      const kind = energy.fatigueKind(cfg) || ''
      if (kind === 'noon' && !cfg.sleepTalkNoonEnabled) return
      // 同一个时段（night / noon / 其他）有冷却，避免精力一直低就反复说
      const slot = kind || 'day'
      const gap = Math.max(30, Number(cfg.sleepTalkCooldownMin) || 240) * 60_000
      const last = sleepTalkSent.get(slot) || 0
      if (Date.now() - last < gap) return
      // 主人刚说过话就别插嘴，等他说完那轮再说
      const now = Date.now()
      if (lastOwnerAt && now - lastOwnerAt < 3 * 60_000) return

      let text = ''
      if (cfg.sleepTalkUseLlm) {
        const when = kind === 'noon' ? '中午，你困了想眯一会' : kind === 'night' ? '夜里，你困了该睡了' : '你有点困'
        try {
          text = await api.ask({
            system: '你很自然地跟对方说一句你困了。一句话，很短，像随手打的。'
              + '不要解释设定、不要问问题、不要括号动作、不要提「精力」「数值」这些词。',
            text: `现在是${energy.clockText(now)}，${when}。对方是你亲近的人。`,
            maxTokens: 60,
          })
        } catch {
          text = ''
        }
      }
      // 模型失败或关掉时的兜底：按时段给三种说法
      if (!String(text || '').trim()) {
        text = kind === 'noon' ? '有点困了 我去眯一会儿' : kind === 'night' ? '困了 我先去躺了' : '有点困 脑子不太转了'
      }
      text = String(text || '').trim().slice(0, 120)
      if (!text) return
      sleepTalkSent.set(slot, now)
      try {
        await api.send(`private:${owner}`, text)
        api.log.info(`长夜：困了，主动说了（${slot}，精力 ${Math.round(s.energy)}）`)
      } catch (error) {
        api.log.warn('长夜：说困的消息发送失败 ' + (error?.message || error))
      }
    }

    /**
     * 兑现「待会睡」的约定（2026-11-24 加）
     *
     * 她答应过「看完这集就睡」。程序判断不了「看完」没有，所以用一个朴素的近似：
     * 约定挂了一段时间（默认超过一半有效期）+ 精力已经很低 → 就当她该去睡了。
     * 这时候走正常入睡流程，不带道别（她刚聊完，不用再郑重其事）。
     */
    async function honorSnooze() {
      const cfg = cfgOfFn()
      if (!cfg.enabled || !cfg.allowSleep) return
      const s = service.state
      if (s.mode !== AWAKE) return
      if (service.pendingSleep) return
      const snooze = service.activeSnooze()
      if (!snooze) return
      const keep = Math.max(10, Number(cfg.snoozeKeepMinutes) || 180) * 60_000
      const elapsed = Date.now() - snooze.at
      // 没到一半就先不提；精力还够也不逼她睡
      if (elapsed < keep / 2) return
      if (Number(s.energy) > Math.max(15, Number(cfg.sleepTalkEnergy) || 25)) return
      service.clearSnooze()
      await service.save()
      const ok = await service.sleepNow({ reason: 'talk', kind: snooze.kind || 'night', byUser: false })
      if (ok) {
        lastDreamAttempt = 0
        api.log.info(`长夜：约定的时间到了，去睡（起因「${String(snooze.text || '').slice(0, 30)}」）`)
      }
    }

    const maybeDream = async () => {
      const cfg = cfgOfFn()
      const s = service.state
      if (!cfg.enabled || !cfg.dreamEnabled || s.mode !== ASLEEP) return
      const now = Date.now()
      const stage = service.stage(now)
      if (!dreamer.due({ sleepAt: s.sleepAt, already: s.dreamCount, stage, dreamSkip: s.dreamSkip, now })) return
      const interval = Math.max(5, Number(cfg.dreamIntervalMinutes) || 60) * 60_000
      if (lastDreamAttempt && now - lastDreamAttempt < interval) return
      lastDreamAttempt = now
      s.dreamCount += 1
      await service.save()
      await dreamer.make({ kind: s.sleepKind })
    }

    /**
     * 模型复核：「这句话到底是不是让 BOT 自己去睡？」（2026-11-24 加）
     *
     * 为什么需要：关键字规则只能看字面，遇到主语被省略、被反转的句子会误判。
     * 实测踩过的坑：
     *   「嗯，到我怀里来，在看两集，各回各房睡觉去」→ 规则判要去睡，其实是在安排各睡各的
     *   「我们家狗睡觉去了」                      → 主语是狗
     *   「你也早点睡 我困了」                     → 是关心对方，自己不一定马上睡
     *
     * 成本控制：**只在这条消息已经被关键字规则判成收线之后**才调用，正常聊天一次都不调。
     * 失败或超时就当「不是」——宁可少睡一次，也不能因为模型抽风把她按到明早。
     */
    /** 「深夜 / 上午 / 下午 / 傍晚」这种，给模型判断时段用。 */
    function dayPartText(ts = Date.now()) {
      const h = new Date(ts).getHours()
      if (h >= 23 || h < 5) return '深夜'
      if (h < 8) return '清晨'
      if (h < 12) return '上午'
      if (h < 14) return '中午'
      if (h < 18) return '下午'
      return '傍晚'
    }

    /**
     * 带超时的 ask（2026-11-25 加）。
     *
     * `api.ask` 本身没有超时参数（`timeoutMs` 传了也不会生效，那是 `api.think` 的选项）。
     * 而我们是在 `api.on('message')` 里同步 await 模型结果——模型一慢，这条消息的处理
     * 就整个挂住，主人的消息也发不出去。所以用 Promise.race 自己兜一层。
     *
     * 超时不代表失败：调用方拿到 null 就按"不确定"处理（比如判收线时当"不睡"）。
     */
    function askWithTimeout(opts, timeoutMs) {
      return Promise.race([
        api.ask(opts),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), Math.max(500, Number(timeoutMs) || 4000))
          // 别因为这一个定时器把进程吊着
          if (typeof t?.unref === 'function') t.unref()
        }),
      ]).catch((error) => {
        api.log.warn('长夜：ask 调用失败 ' + (error?.message || error))
        return null
      })
    }

    /**
     * 模型复核：这句话是让 BOT **马上**睡、**待会**睡，还是**不是在说这个**？
     *
     * 三分类而不是二分类，因为「看完这集就去睡」这种句子用「是/不是」表达不了：
     *   说「是」→ 她会立刻躺下（错，你还要她看完）
     *   说「不是」→ 她完全没反应（也不对，你的意思她该应一声）
     *   说「待会」→ 不睡，但记着，之后自己提
     *
     * 成本：只在这条消息已经被关键字规则判成收线之后才调用，正常聊天一次都不调。
     * 失败/超时/答得含糊一律当「不是」——少睡一次比误睡一整晚代价小。
     */
    async function judgeClosing(msg, word) {
      try {
        const out = await askWithTimeout({
          system: '判断对方这句话对「你」的意图。只回答一个词：现在 / 待会 / 不是。'
            + '现在＝让我马上就去睡；待会＝让我过一会儿或做完某事再去睡；'
            + '不是＝根本没在说我该睡（说的是别人、宠物、或者在关心我但没让我睡）。',
          text: `现在是${energy.clockText(Date.now())}（${dayPartText()}）。\n`
            + `对方说：${String(msg.text || '').slice(0, 200)}\n（触发的词：${word}）\n`
            + '注意区分：「你去睡觉吧」「快去睡」＝现在；「看完这集再睡」「等下就睡」＝待会；'
            + '「我家猫去睡了」「你也早点睡吧我自己再待会儿」＝不是。\n'
            + '另外注意时段：如果现在是白天（不是深夜），对方说「我睡了」多半是在说他自己要睡，'
            + '不是在安排你睡觉——这种情况答「不是」。',
          maxTokens: 10,
        }, 4000)   // 4 秒：再慢就当没判出来，按"不睡"走
        const t = String(out || '').trim()
          // 去掉开头/结尾的口头词和标点（模型偶尔会答「嗯，待会。」）
          .replace(/^[\s，,。.!！、]+/, '')
          .replace(/^[嗯啊哦唉诶]+[，,、\s]*/, '')
          .replace(/[。.!！，,\s、]+$/, '')
        let verdict = 'no'
        if (/^(现在|马上|立刻|立即|right now|now)$/i.test(t)) verdict = 'now'
        else if (/^(待会|等会|等下|稍后|一?会儿|later)$/i.test(t)) verdict = 'later'
        api.log.info(`长夜：模型复核收线「${word}」→ ${t.slice(0, 10) || '(空)'}（${verdict === 'now' ? '马上睡' : verdict === 'later' ? '待会睡' : '不睡'}）`)
        return verdict
      } catch (error) {
        api.log.warn('长夜：模型复核失败，按不睡处理 ' + (error?.message || error))
        return 'no'
      }
    }

    // ---------------------------------------------------------------- 消息
    api.on('message', async (msg) => {
      const cfg = cfgOfFn()
      if (!cfg.enabled) return false

      // 主人自己在私聊里说话，就别再吊着「闭嘴」——不然一句「好」能让她沉默半小时
      const ownerPrivate = msg.kind === 'private' && Boolean(api.isOwner?.(msg.userId))
      if (ownerPrivate) {
        try {
          if (api.core?.mutes?.muted?.(msg.chatId)) api.core.mutes.clear(msg.chatId)
        } catch {
          // 没有这个接口就算了
        }
      }

      const result = await service.onMessage(msg)
      // state.mjs 里已经写了明细；block 时这里不再重复记，避免一条消息两行日志
      if (result.block) return true
      if (result.woke) return false

      // 精力耗尽：先让她把道别说完，等这条回复发出去再躺下
      if (result.sleepTriggered && cfg.allowSleep) {
        service.requestSleep('energy', result.kind || 'night', msg.chatId)
      }

      // 收线只在「主人说的」上生效：群里一屋子机器人互相道晚安，
      // 不能因此把她按到明早七点，也不能因此闭嘴半小时。
      const fromOwner = Boolean(api.isOwner?.(msg.userId))
      if (fromOwner) lastOwnerAt = Date.now()
      const closeAllowed = cfg.closeScope === 'all' || fromOwner
      if (!closeAllowed && service.state.mode === AWAKE && cfg.closeEnabled && isClosing(msg.text, {})[0]) {
        api.log.debug(`长夜：${msg.chatId} 里${msg.nickname || msg.userId} 的收线不算（只认主人）`)
      }
      if (closeAllowed && service.state.mode === AWAKE && !service.pendingSleep && cfg.closeEnabled && !isAskingMe(msg.text)) {
        const [closing, strength, word] = isClosing(msg.text, {})
        // 关键字规则先筛一遍，命中再让模型复核（见 confirmClosing 的注释）
        // 规则判定之后让模型复核一次：现在睡 / 待会睡 / 不睡
        const verdict = closing
          ? (cfg.closeConfirmByLlm ? await judgeClosing(msg, word) : 'now')
          : 'no'
        if (verdict === 'later') {
          // 「看完这集再睡」这类：不睡，但记下这个约定，之后她自己会提
          const kind = ['午', '眯', '盹', '躺'].some((m) => word.includes(m)) ? 'noon' : 'night'
          service.requestSnooze(msg.text, kind, msg.chatId)
          await service.save()
          api.log.info(`长夜：记下「待会睡」的约定（${kind}）：${String(msg.text || '').slice(0, 40)}`)
        }
        if (closing && verdict !== 'no') {
          const wantSleep = strength === 'strong' || (cfg.closeSleepStrength === 'medium' && strength === 'medium')
          if (verdict === 'later') {
            // 待会睡：这一轮什么都不做，只应一声，不静默、不睡
          } else if (wantSleep && cfg.allowSleep) {
            // 按时段决定真睡还是只闭嘴（#250：白天一律入睡会消失一整天）
            const act = energy.closeAction(cfg, word)
            if (act.sleep) {
              service.requestSleep('talk', act.kind, msg.chatId)
            } else {
              api.log.info(`长夜：现在是白天，收到收线「${word}」不睡，只安静 ${act.muteMinutes} 分钟`)
              try {
                api.core?.mutes?.set?.(msg.chatId, act.muteMinutes)
              } catch {
                // 没有闭嘴接口就只当没听见——至少别睡
              }
            }
          } else if (!ownerPrivate && strength !== 'weak') {
            // 「嗯 / 好 / 收到」这种短答不是收线，别拿它当理由闭嘴；
            // 主人私聊更不该被静默——她不理人是最难解释的状态。
            const minutes = closeMinutes(cfg, strength, word)
            try {
              api.core?.mutes?.set?.(msg.chatId, minutes)
            } catch {
              // 没有闭嘴接口就只当没听见
            }
          }
        }
      }
      return false
    })

    // ---------------------------------------------------------------- 提示词
    api.on('prompt', async (content, info) => {
      const chat = info?.chat
      if (!chat || chat.kind === 'system') return content

      // ---- 睡着时不主动搭话 ----
      // 主动搭话走 pushToSession（不经过 onMessage），但会经过这个 prompt 钩子，
      // 所以在这里拦。以前她一边说「我去睡啦」一边按定时器主动找人，观感很怪。
      // 用系统提醒的开头认这几条：speakup 的定时 / 催问、白名单朋友、purpose 引擎。
      // 只在睡着时拦，醒着时原样放行，不影响正常搭话节奏。
      const looksProactive = content.some(
        (c) => c?.type === 'text' && /^【系统提醒，不是[^】]*说的话】/.test(String(c.text || '').trim()),
      )
      if (looksProactive && service.state.mode !== AWAKE) {
        api.log.info(`长夜：睡着中（${service.state.mode}），跳过这一次主动搭话`)
        return null // hub 收到 null 就不交给她，这一轮不产生任何消息
      }

      const hint = service.promptHint(chat)
      if (!hint) return content
      return [{ type: 'text', text: hint }, ...content]
    })

    // ---------------------------------------------------------------- 睡着时不往外发
    // 媒体类模块（B 站 / 小黑盒 / 热榜 / 过日子）走的是 api.send / api.sendText，
    // 直接落到 hub.sendSegments，不经过 prompt 钩子——所以以前她睡着了照样会收到
    // 「刷到一个有意思的」。这里在所有出站消息的必经之路上拦一道：
    // 睡着就先存着（日志只记一行，醒了补发），醒着一律放行。
    // 2026-11-24：原来是内存数组 const deferred = []，进程一重启就丢。
    // 现在存在 service.state.deferred 里（见 state.mjs pushDeferred / takeDeferred）。

    api.on('send', async (message, info) => {
      const cfg = cfgOfFn()
      if (!cfg.enabled || !cfg.deferWhileAsleep) return
      // 只有真睡着才压。waking 是「被叫醒了、正在补昨晚的话」，
      // 那时候必须放行，否则被 @ 叫起来也发不出声。
      if (service.state.mode !== ASLEEP) return
      // 道别本身要放出去（否则「我去睡啦」永远发不出来）
      if (service.pendingSleep) return
      const chatId = String(info?.chatId || '')
      if (!chatId || chatId.startsWith('system:')) return
      // 她自己主动的、或模块代发的，一律压着；对方主动找上门的那条已经由 reply 链处理
      const text = (Array.isArray(message) ? message : [])
        .filter((seg) => seg?.type === 'text')
        .map((seg) => String(seg.data?.text ?? ''))
        .join(' ')
        .trim()
      await service.pushDeferred({ chatId, message, note: String(info?.note || '') })
      api.log.info(`长夜：睡着中，${chatId} 这条先存着（${text.slice(0, 30) || info?.note || '无正文'}），醒来再发`)
      return null
    })

    /** 醒来以后把睡着期间压着的发出去。只发一次，按时间顺序。 */
    const flushDeferred = async () => {
      if (!service.deferredCount()) return
      const cfg = cfgOfFn()
      if (!cfg.deferWhileAsleep) {
        await service.takeDeferred()   // 关掉这个功能就清空，别越攒越多
        return
      }
      const queue = await service.takeDeferred()
      // 太老的（超过 12 小时）就别发了，隔夜消息发出去只会莫名其妙
      const fresh = queue.filter((it) => Date.now() - it.at < 12 * 3600_000)
      if (!fresh.length) return
      api.log.info(`长夜：醒了，补发睡着期间压下的 ${fresh.length} 条`)
      // 同一个会话只补发最后一条：一觉醒来把十几条「刷到一个」全推过去像上了发条
      const latest = new Map()
      for (const it of fresh) latest.set(it.chatId, it)
      for (const [chatId, it] of latest) {
        try {
          await api.sendSegments(chatId, it.message, it.note || '[补发]')
        } catch (error) {
          api.log.warn(`长夜：补发失败（${chatId}）：${error?.message || error}`)
        }
      }
    }

    // ---------------------------------------------------------------- 道别改写
    api.on('reply', async (text, info) => {
      // 正在醒的时候，回了哪个会话就算那个会话爬完了
      if (service.state.mode === 'waking' && info?.chatId) {
        await service.crawlDone(String(info.chatId))
      }
      const pending = service.pendingSleep
      if (!pending || pending.farewellDone || farewellBusy) return
      // 只给她要睡的那个会话加道别，别的地方照常说话
      if (pending.chatId && info?.chatId && pending.chatId !== info.chatId) return
      const cfg = cfgOfFn()
      const kind = pending.kind || 'night'
      let line = ''
      if (cfg.farewellEnabled) {
        if (cfg.farewellUseLlm) {
          farewellBusy = true
          try {
            line = await api.ask({
              system: '你要去睡了。写一句很短、自然、像随口说的道别，不要解释，不要问问题，不要括号动作。',
              text: `现在是${energy.clockText(Date.now())}，${kind === 'noon' ? '你要去午睡' : '你要去睡了'}。对方最后说：${info?.userText || ''}`,
              maxTokens: 80,
            })
          } catch {
            line = ''
          } finally {
            farewellBusy = false
          }
        }
        line = String(line || '').trim() || lullaby.compose({ kind, sessionId: info?.chatId })
      }
      pending.farewellDone = true
      // 兜底：activity 事件在某些路径（模拟测试、直接 deliver）不一定来，
      // 所以到点强制躺下，别让她一直挂着「马上要睡」的状态。
      // 2 秒太紧——多气泡回复（「晚安」常带两三条）后面几条会被拦下来存到明早。
      // 拉到 8 秒，给正常的多条回复留出时间；activity 事件正常时会更快触发，不受影响。
      api.later(8000, async () => {
        if (!service.pendingSleep) return
        const p = service.pendingSleep
        service.pendingSleep = null
        const ok = await service.sleepNow({ reason: p.reason, kind: p.kind, byUser: false })
        if (ok) lastDreamAttempt = 0
      })
      if (!line) return
      // 原来这里有个 `if (isFarewell(text)) return`，想避免重复说晚安，
      // 但实际把她要去睡的场景全废了——她本来就是在道晚安，text 里必然含「晚安/睡了/困」，
      // 于是这一段从来没执行过（日志里 0 次道别）。
      // 改成：原回复已经很长就不再追加；短的才补一句。
      const already = String(text || '')
      if (already.length > 60) return
      return already ? `${already}\n${line}` : line
    })

    // ---------------------------------------------------------------- 发出去之后才真正躺下
    api.on('activity', async (a) => {
      if (a?.kind !== 'out') return
      // 刚醒过来：把睡着期间压着的媒体消息补发掉
      if (service.state.mode === AWAKE) api.later(3000, () => { flushDeferred() })
      // 正在醒的时候，回了哪个会话就算爬完哪个；全爬完就正式醒
      if (service.state.mode === 'waking' && a.chatId) {
        await service.crawlDone(String(a.chatId))
        return
      }
      const pending = service.pendingSleep
      if (!pending) return
      if (pending.chatId && a.chatId && pending.chatId !== a.chatId) return
      service.pendingSleep = null
      const ok = await service.sleepNow({ reason: pending.reason, kind: pending.kind, byUser: false })
      if (ok) lastDreamAttempt = 0
    })

    // ---------------------------------------------------------------- 心跳
    api.every(60_000, async () => {
      if (!cfgOfFn().enabled) return
      const events = await service.tick()
      if (events.includes('wake_natural')) {
        lastDreamAttempt = 0
        await morningGreeting()
        await flushDeferred()
      }
      await maybeDream()
      await sleepTalk()
      await honorSnooze()
    }, '长夜心跳')

    // ---------------------------------------------------------------- 命令
    api.command({
      name: '长夜',
      desc: '看长夜如梦状态',
      run: async () => service.statusText(),
    })

    api.command({
      name: '睡',
      desc: '让她立刻去睡（可带「午」睡午觉）',
      run: async (arg) => {
        const kind = /午/.test(String(arg || '')) ? 'noon' : 'night'
        const ok = await service.sleepNow({ reason: 'manual', kind, byUser: true })
        if (!ok) return '现在睡不了（允许真睡关着）'
        return `好，去睡了。${lullaby.compose({ kind })}`
      },
    })

    api.command({
      name: '醒',
      desc: '把她叫醒',
      run: async () => {
        await service.wakeNow({ reason: 'manual' })
        service.pendingSleep = null
        return `醒了。${service.statusText()}`
      },
    })

    api.command({
      name: '梦',
      desc: '看她还记得的梦',
      run: async (arg, msg) => {
        if (msg?.kind === 'group') return '梦是私人的，私聊我再看。'
        const list = dreamer.living().slice(0, 6)
        if (!list.length) return '最近没做过记得住的梦。'
        return list
          .map((d) => `${levelStars(d.level)} ${dayText(d.createdAt)} ${(d.tags || []).join('、')}\n${String(d.text).slice(0, 160)}`)
          .join('\n\n')
      },
    })

    api.command({
      name: '做梦',
      desc: '现在做一段梦（调试用，得先睡着）',
      run: async (arg, msg) => {
        if (msg?.kind === 'group') return '梦是私人的，私聊我。'
        if (service.state.mode !== ASLEEP) return '得先睡着才能做梦。'
        const entry = await dreamer.make({ kind: service.state.sleepKind })
        if (!entry) return '这次没做出梦来。'
        return `${levelStars(entry.level)} ${(entry.tags || []).join('、')}\n${entry.text}`
      },
    })

    // ---------------------------------------------------------------- 工具
    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      const tools = [
        api.defineTool({
          name: 'night_status',
          description: '看她现在的作息状态：醒着还是睡着、精力、睡眠阶段、起床点。聊到困不困、睡没睡、几点醒时用。',
          properties: {},
          required: [],
          execute: async () => ({ ok: true, message: service.statusText() }),
        }),
      ]
      if (chat.kind === 'private') {
        tools.push(api.defineTool({
          name: 'recall_dream',
          description: '回想最近做过的梦。只有私下能看；聊到做梦、梦到什么时用。',
          properties: { query: { type: 'string', description: '想找的关键词，可不填' } },
          required: [],
          execute: async ({ query }) => {
            const list = dreamer.recall(query || '', 3)
            if (!list.length) return { ok: true, message: '最近没有记得住的梦。' }
            return {
              ok: true,
              message: list
                .map((d) => `${levelStars(d.level)} ${(d.tags || []).join('、')}：${String(d.text).slice(0, 220)}`)
                .join('\n'),
            }
          },
        }))
      }
      return tools
    })

    // ---------------------------------------------------------------- 规则
    api.rule((kind) => [
      '你有作息：会困、会睡着、会做梦。睡着时别人叫你，你不一定醒；被叫醒时可能还带着梦里的感觉。',
      '不要主动解释「长夜如梦」「精力值」「睡眠阶段」这些设定。用身体感觉说：困、睁不开眼、脑子发沉、刚醒。',
      kind === 'social'
        ? '群里不要展开梦的内容，也不要提私下做的梦。'
        : '梦的内容只私下说，别当成真实发生的事。',
    ])

    // ---------------------------------------------------------------- 面板接口
    api.route('/state', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_READ
      const ownerChat = `private:${api.config()?.ownerQQ || ''}`
      let muted = false
      try {
        muted = Boolean(api.core?.mutes?.muted?.(ownerChat))
      } catch {
        muted = false
      }
      return { ok: true, ...service.snapshot(), muted }
    })

    api.route('/dreams', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_READ
      const query = api.core?.http?.query?.(req) || {}
      const all = String(query.all || '') === '1'
      const items = all ? dreamer.items : dreamer.living()
      return {
        ok: true,
        items: items
          .slice()
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .map((d) => ({
            id: d.id,
            createdAt: d.createdAt,
            level: d.level,
            stars: levelStars(d.level),
            tags: d.tags || [],
            text: d.text,
            pinned: Boolean(d.pinned),
            strength: Math.round(dreamer.strengthOf(d) * 100),
            kind: d.kind || 'night',
          })),
      }
    })

    api.route('/sleep', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      const kind = String(body?.kind || '') === 'noon' ? 'noon' : 'night'
      const ok = await service.sleepNow({ reason: 'panel', kind, byUser: true })
      return { ok, message: ok ? '去睡了' : '允许真睡关着' }
    })

    api.route('/wake', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      await service.wakeNow({ reason: 'panel' })
      service.pendingSleep = null
      return { ok: true, message: '叫醒了' }
    })

    // 收线识别偶尔会误判成「她在生气不理人」，给个手动的出口
    api.route('/unmute', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      const chatId = String(body?.chatId || `private:${api.config()?.ownerQQ || ''}`)
      const was = Boolean(api.core?.mutes?.muted?.(chatId))
      try {
        api.core?.mutes?.clear?.(chatId)
      } catch {
        return { ok: false, message: '这个版本没有闭嘴接口' }
      }
      return { ok: true, wasMuted: was, message: was ? '解除了，她能说话了' : '本来就没闭嘴' }
    })

    api.route('/dream', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      if (service.state.mode !== ASLEEP && !body?.force) return { ok: false, message: '得先睡着' }
      const entry = await dreamer.make({ kind: service.state.sleepKind })
      return entry
        ? { ok: true, message: '做了一段梦', dream: entry }
        : { ok: false, message: '这次没做出梦来' }
    })

    api.route('/dreams/delete', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      return { ok: dreamer.remove(String(body?.id || '')) }
    })

    api.route('/dreams/pin', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      return { ok: dreamer.setPinned(String(body?.id || ''), Boolean(body?.pinned)) }
    })

    api.route('/health', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_READ
      return {
      ok: true,
      id: 'night',
      version: '1.1.0',
      mode: service.state.mode,
      energy: Math.round(service.state.energy),
      dreams: dreamer.items.length,
      stages: stages.STAGE_KEYS,
      }
    })

    api.onDispose(async () => {
      await service.save()
    })

    api.log.info(`长夜如梦已启动：${service.statusText()}`)
    return {
      service,
      dreamer,
      status: () => service.statusText(),
      snapshot: () => service.snapshot(),
      sleep: (kind = 'night') => service.sleepNow({ reason: 'api', kind, byUser: true }),
      wake: () => service.wakeNow({ reason: 'api' }),
      dream: () => dreamer.make({ kind: service.state.sleepKind }),

      // ---- 给别的模块 / 宿主问「她现在睡着吗」 ----
      // 主动搭话（speakup）以前完全不知道她的睡眠状态：她一边说「我去睡啦」，
      // 一边还会按定时器主动找人。这两个函数就是那条线。
      // 都用 `?.` 兜住，模块被关掉 / 被替换时调用方也不会炸。
      // 语义要分清三种状态：asleep（真睡着）/ waking（被叫醒了、正在补昨晚的话）/ awake。
      // waking 时她已经能说话了，只是还没爬完楼——对外一律算「醒着」，
      // 否则过日子的睡前闸会把醒着的她也关掉。
      isAsleep: () => service.state.mode === ASLEEP,
      sleepState: () => ({
        mode: service.state.mode,
        asleep: service.state.mode === ASLEEP,
        waking: service.state.mode === WAKING,
        reason: service.state.reason || '',
        kind: service.state.sleepKind || 'night',
        energy: Math.round(service.state.energy * 10) / 10,
        sleepAt: service.state.sleepAt || 0,
        wakeAt: service.state.wakeAt || 0,
      }),
    }
  },
}
