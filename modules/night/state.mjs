// 作息状态机：只把「醒着 / 睡着 / 正在醒」三种状态管对。
//
// 精力是全局一份（一个 bot 只有一副身体，三个群同时聊不可能有三倍精力）。
// 时间推进用「惰性 tick」：没人说话时也每分钟跑一次，但下一次调用会按时间差一次性补算，
// 所以重启、容器休眠、时钟跳变都不会漏。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import * as energy from './energy.mjs'
import * as stages from './stages.mjs'
import { createWaker } from './wake.mjs'

export const AWAKE = 'awake'
export const ASLEEP = 'asleep'
export const WAKING = 'waking'

const MIN = 60_000

const defaultState = () => ({
  mode: AWAKE,
  energy: 100,
  sleepAt: 0,
  wakeAt: 0,
  reason: '',
  sleepKind: 'night',
  enterWakingAt: 0,
  lastTick: 0,
  fatigueTurns: 0,
  fatigueEntered: 0,
  dreamCount: 0,
  dreamSkip: false,
  pendingChats: [],
  wokeFrom: null,
  morningDreamId: '',
  hintWakeAt: 0,
  hintChats: [],
  dreamHintUses: 0,
  lastSleepWindow: [],
})

function safeJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export class NightService {
  constructor({ api, cfgOf, dreamer, lullaby, log }) {
    this.api = api
    this.cfgOf = cfgOf
    this.dreamer = dreamer
    this.lullaby = lullaby
    this.log = log
    this.file = api.dataDir('state.json')
    mkdirSync(dirname(this.file), { recursive: true })
    this.state = defaultState()
    this.pendingSleep = null
    this.waker = createWaker(cfgOf, () => this.stageFactor())
    this._queue = Promise.resolve()
    this._loaded = false
  }

  get cfg() {
    return this.cfgOf()
  }

  // ------------------------------------------------------------ 存取
  async load() {
    const raw = safeJson(this.file, null)
    if (raw && typeof raw === 'object') {
      this.state = { ...defaultState(), ...raw }
      this.state.pendingChats = Array.isArray(raw.pendingChats) ? raw.pendingChats.map(String) : []
      this.state.lastSleepWindow = Array.isArray(raw.lastSleepWindow) ? raw.lastSleepWindow.slice(-3) : []
      this.state.hintChats = Array.isArray(raw.hintChats) ? raw.hintChats.map(String) : []
    }
    this.state.lastTick = this.state.lastTick || Date.now()
    this._loaded = true
    await this.tick()
  }

  async save() {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log.warn('保存作息状态失败：' + (error?.message || error))
    }
  }

  // ------------------------------------------------------------ 计划 / 阶段
  plan(now = Date.now()) {
    const s = this.state
    if (s.mode !== ASLEEP || !s.sleepAt || !s.wakeAt) return []
    return stages.buildPlan(this.cfg, { sleepAt: s.sleepAt, wakeAt: s.wakeAt, kind: s.sleepKind })
  }

  stage(now = Date.now()) {
    return stages.at(this.plan(now), now)
  }

  stageFactor() {
    const stage = this.stage()
    if (!stage) return { factor: 1, label: '' }
    return { factor: stages.wakeFactor(stage), label: stage.label }
  }

  isAsleep() {
    return this.state.mode === ASLEEP
  }

  // ------------------------------------------------------------ tick
  tick() {
    // 串行化，避免 60 秒心跳和消息同时进来时重复扣精力 / 重复醒来
    this._queue = this._queue.then(() => this._tick()).catch((error) => {
      this.log.warn('长夜 tick 失败：' + (error?.message || error))
    })
    return this._queue
  }

  async _tick() {
    if (!this._loaded) return
    const cfg = this.cfg
    const now = Date.now()
    const s = this.state
    const last = Math.max(0, Number(s.lastTick) || 0) || now
    const events = []

    if (!cfg.enabled) {
      if (s.mode !== AWAKE) {
        s.mode = AWAKE
        s.sleepAt = 0
        s.wakeAt = 0
        s.pendingChats = []
      }
      s.lastTick = now
      return events
    }

    // 正在醒：超时就正式醒。enterWakingAt 丢了也别让它永远挂在那儿
    if (s.mode === WAKING) {
      if (!s.enterWakingAt) {
        await this.finishWaking()
        events.push('wake_orphan')
      } else {
        const limit = Math.max(1, Number(cfg.wakingTimeoutMinutes) || 5) * MIN
        if (now - s.enterWakingAt >= limit) {
          await this.finishWaking()
          events.push('wake_timeout')
        }
      }
    }

    if (s.mode === ASLEEP) {
      // 中途把 allowSleep 关掉，这一觉不该再睡下去，立刻醒；
      // reason === 'manual' 是人明确点的「睡」，那种睡满不打扰
      if (!cfg.allowSleep && s.reason !== 'manual') {
        await this._doWake('allow_sleep_off')
        events.push('wake_by_switch')
        return events
      }
      // 睡着：按睡眠阶段补精力，到点自然醒。
      // from 不能早于入睡时刻，否则会把睡前那段按睡眠系数重复补一遍。
      const until = Math.min(now, s.wakeAt || now)
      this._recoverSleep(Math.max(last, Number(s.sleepAt) || last), until)
      if (s.wakeAt && now >= s.wakeAt) {
        await this._doWake('natural')
        events.push('wake_natural')
      } else {
        s.energy = Math.min(Number(cfg.energyMax) || 100, s.energy)
      }
    } else {
      // 醒着：按疲劳窗口扣/回精力
      const slots = energy.sliceByFatigue(cfg, last, now)
      let lastKind = ''
      for (const slot of slots) {
        if (slot.kind) {
          lastKind = slot.kind
          if (!s.fatigueEntered) {
            s.fatigueEntered = Math.floor(now / 1000)
            s.fatigueTurns = 0
          }
          s.energy = energy.drain(s.energy, { minutes: slot.minutes, perMinute: cfg.energyPerMinute })
        } else {
          s.energy = energy.recover(s.energy, { minutes: slot.minutes, perMinute: cfg.energyRecoverPerMinute })
        }
      }
      if (!lastKind) {
        s.fatigueEntered = 0
        s.fatigueTurns = 0
      }
      if (lastKind && s.energy <= 0.5 && s.fatigueTurns >= Math.max(0, Number(cfg.minTurnsBeforeSleep) || 8)) {
        await this._doSleep('energy', lastKind, false)
        events.push('sleep_energy')
      }
      // 最晚睡觉时间兜底（只看 4 小时窗口，避免白天误判）
      if (s.mode === AWAKE && this._pastLatestSleep(now)) {
        await this._doSleep('latest', 'night', false)
        events.push('sleep_latest')
      }
    }

    // 挂着的道别不能一直挂着（比如她那句回复根本没发出去）
    const pendingLimit = Math.max(1, Number(cfg.wakingTimeoutMinutes) || 5) * MIN * 0.6
    if (this.pendingSleep && now - this.pendingSleep.at > pendingLimit) {
      const p = this.pendingSleep
      this.pendingSleep = null
      await this._doSleep(p.reason, p.kind, false)
      events.push('sleep_pending_timeout')
    }

    s.lastTick = now
    await this.save()
    return events
  }

  _recoverSleep(from, to) {
    if (to <= from) return
    const s = this.state
    const plan = this.plan(to)
    const per = Number(this.cfg.energyRecoverPerMinute) || 1.5
    const cap = Number(this.cfg.energyMax) || 100
    if (!plan.length) {
      s.energy = energy.clamp(s.energy + ((to - from) / MIN) * per * 1.2, 0, cap)
      return
    }
    let cursor = from
    for (const seg of plan) {
      const start = Math.max(from, seg.start)
      const end = Math.min(to, seg.end)
      if (end <= start) continue
      const mid = start + (end - start) / 2
      const stage = stages.at(plan, mid)
      const factor = stages.energyFactor(stage)
      s.energy = energy.clamp(s.energy + ((end - start) / MIN) * per * factor, 0, cap)
      cursor = end
    }
    if (cursor < to) s.energy = energy.clamp(s.energy + ((to - cursor) / MIN) * per * 1.2, 0, cap)
  }

  _pastLatestSleep(now) {
    const target = energy.parseHHMM(this.cfg.latestSleepTime || '02:30')
    if (target == null) return false
    const minute = energy.nowMinute(now)
    if (minute < target) return false
    return minute - target <= 240
  }

  // ------------------------------------------------------------ 消息
  /**
   * 一条消息进来。返回：
   *   block  true = 这条别回（连模型都别叫）
   *   woke   是否被这条叫醒
   *   sleepTriggered 精力耗尽，需要上层挂一次道别
   */
  async onMessage(msg) {
    const cfg = this.cfg
    if (!cfg.enabled) return { block: false }
    await this.tick()
    const s = this.state
    const chatId = String(msg?.chatId || '')
    const isGroup = msg?.kind === 'group'

    if (s.mode === ASLEEP) {
      if (chatId && !s.pendingChats.includes(chatId)) s.pendingChats.push(chatId)
      if (this.pendingSleep) return { block: false, pending: true }
      const attempt = this.waker.check({
        sessionId: chatId,
        isGroup,
        atMe: Boolean(msg?.mentioned || msg?.atMe),
      })
      if (!attempt.woke) {
        await this.save()
        return { block: true, wake: attempt }
      }
      await this._doWake('message')
      return { block: false, woke: true, wake: attempt, waking: s.mode === WAKING }
    }

    // 醒着：疲劳期扣精力、累计轮次
    if (energy.inFatigue(cfg)) {
      if (!s.fatigueEntered) {
        s.fatigueEntered = Math.floor(Date.now() / 1000)
        s.fatigueTurns = 0
      }
      s.fatigueTurns += 1
      s.energy = energy.drain(s.energy, { messages: 1, perMessage: cfg.energyPerMessage })
      if (s.energy <= 0.5 && s.fatigueTurns >= Math.max(0, Number(cfg.minTurnsBeforeSleep) || 8)) {
        if (!cfg.allowSleep) {
          s.energy = Math.max(s.energy, Number(cfg.energyAfterWake) || 35)
          await this.save()
          return { block: false, tired: true }
        }
        const kind = energy.fatigueKind(cfg) || 'night'
        this.requestSleep('energy', kind, chatId)
        await this.save()
        return { block: false, sleepTriggered: true, kind }
      }
    }

    await this.save()
    return { block: false }
  }

  // ------------------------------------------------------------ 睡 / 醒
  requestSleep(reason, kind, chatId = '') {
    if (!this.pendingSleep) this.pendingSleep = { reason, kind, chatId: String(chatId || ''), at: Date.now() }
  }

  async _doSleep(reason, kind = 'night', force = false) {
    const cfg = this.cfg
    const s = this.state
    if (!force && !cfg.allowSleep) {
      s.energy = Math.max(s.energy, Number(cfg.energyAfterWake) || 35)
      this.log.info(`长夜：allowSleep 关闭，跳过入睡（原因=${reason}）`)
      return false
    }
    const now = Date.now()
    s.mode = ASLEEP
    s.sleepAt = now
    s.wakeAt = energy.nextWakeTime(cfg, now, { kind })
    s.reason = reason
    s.sleepKind = kind || 'night'
    s.enterWakingAt = 0
    s.pendingChats = []
    s.dreamCount = 0
    s.dreamSkip = false
    s.wokeFrom = null
    s.morningDreamId = ''
    s.hintWakeAt = now
    s.hintChats = []
    s.dreamHintUses = 0
    if ((kind || 'night') === 'noon') {
      const chance = Math.max(0, Math.min(1, Number(cfg.noonDreamChance) || 0.5))
      s.dreamSkip = Math.random() >= chance
    }
    this.waker.resetAll()
    this.pendingSleep = null
    await this.save()
    this.log.info(`长夜：入睡（原因=${reason}），预计 ${energy.clockText(s.wakeAt)} 醒来`)
    return true
  }

  async _doWake(reason = 'natural') {
    const cfg = this.cfg
    const s = this.state
    const sleepAt = Number(s.sleepAt) || 0
    const wakeAt = Number(s.wakeAt) || 0
    const sleepKind = s.sleepKind || 'night'
    const now = Date.now()
    const wokeAt = reason === 'natural' && wakeAt > 0 ? Math.min(now, wakeAt) : now

    // 记下从哪个阶段醒的（深睡被拽起来和 REM 醒来说话状态不一样）
    if (sleepAt > 0) {
      try {
        s.wokeFrom = stages.at(
          stages.buildPlan(cfg, { sleepAt, wakeAt, kind: sleepKind }),
          wokeAt,
        )
      } catch {
        s.wokeFrom = null
      }
      s.lastSleepWindow = [...(s.lastSleepWindow || []), { sleepAt, wakeAt: wakeAt || now, kind: sleepKind }].slice(-3)
    }

    let morning = null
    if (sleepAt > 0) morning = this.dreamer.pickMorning({ since: sleepAt, until: wakeAt || now })

    s.sleepAt = 0
    s.wakeAt = 0
    s.reason = ''
    s.energy = Number(cfg.energyMax) || 100
    s.fatigueTurns = 0
    s.fatigueEntered = 0
    s.morningDreamId = morning?.id || ''
    s.hintWakeAt = wokeAt
    s.hintChats = []
    s.dreamHintUses = 0
    this.waker.resetAll()
    this.pendingSleep = null

    const pending = (s.pendingChats || []).slice(0, 20)
    // 人明确叫醒（面板 / 指令）就是起来了，不用再「爬楼」补昨晚的消息
    const manual = reason === 'manual' || reason === 'panel'
    if (pending.length && cfg.crawlEnabled && !manual) {
      s.mode = WAKING
      s.enterWakingAt = now
      s.pendingChats = pending
    } else {
      s.mode = AWAKE
      s.enterWakingAt = 0
      s.pendingChats = []
      s.sleepKind = ''
    }
    await this.save()
    this.log.info(`长夜：醒来（原因=${reason}）${pending.length ? `，待爬 ${pending.length} 个会话` : ''}`)
    return { morning, pending }
  }

  async finishWaking() {
    const s = this.state
    if (s.mode === WAKING) {
      s.mode = AWAKE
      s.energy = Math.min(Number(this.cfg.energyMax) || 100, Number(this.cfg.energyAfterWake) || 35)
    }
    s.enterWakingAt = 0
    s.pendingChats = []
    s.sleepKind = ''
    await this.save()
  }

  async sleepNow({ reason = 'manual', kind = '', byUser = false } = {}) {
    const k = kind || energy.fatigueKind(this.cfg) || 'night'
    return this._doSleep(reason, k, byUser)
  }

  async wakeNow({ reason = 'manual' } = {}) {
    return this._doWake(reason)
  }

  /** 这个会话爬完了：从待爬清单里划掉；全爬完就正式醒。 */
  async crawlDone(chatId) {
    const s = this.state
    if (s.mode !== WAKING) return
    s.pendingChats = (s.pendingChats || []).filter((id) => id !== chatId)
    if (!s.pendingChats.length) await this.finishWaking()
    else await this.save()
  }

  // ------------------------------------------------------------ 提示词
  promptHint(chat) {
    const cfg = this.cfg
    const s = this.state
    const chatId = String(chat?.chatId || '')
    const isGroup = chat?.kind === 'group'
    const lines = []

    if (s.mode === ASLEEP && !this.pendingSleep) return ''

    if (s.mode === WAKING) {
      const used = s.hintChats || []
      if (!used.includes(chatId)) {
        s.hintChats = [...used, chatId]
        const left = (s.pendingChats || []).length
        lines.push(`你刚被叫醒，还没完全爬起来${left ? `，昨晚有 ${left} 个会话的消息没翻` : ''}。先别编具体内容，真不记得就说刚醒。`)
      }
    }

    if (s.wokeFrom && !(s.hintChats || []).includes('__stage__')) {
      s.hintChats = [...(s.hintChats || []), '__stage__']
      const label = s.wokeFrom.label || ''
      if (label) lines.push(`你是从「${label}」里被叫醒的，${label.includes('深') ? '脑子发沉、反应慢' : '还带着梦里的感觉'}。`)
    }

    if (this.pendingSleep) {
      lines.push(`这句话说完你就要去睡了（${this.pendingSleep.kind === 'noon' ? '午睡' : '夜里'}）。道别要自然，别解释原因，也别问问题。`)
    }

    if (s.morningDreamId && s.dreamHintUses < (isGroup ? 0 : 1)) {
      const dream = this.dreamer.byId(s.morningDreamId)
      if (dream && dream.strength > 0.2) {
        s.dreamHintUses += 1
        const brief = String(dream.text || '').replace(/\s+/g, ' ').slice(0, 120)
        lines.push(isGroup
          ? '你昨晚做过梦，但梦的内容是私人的，群里不要展开。'
          : `你昨晚梦到过一段，还记着这些：${brief}。可以说「我昨晚梦到…」，但别把它当成真实发生的事。`)
      }
    }

    if (cfg.enabled && energy.inFatigue(cfg) && s.energy <= 60) {
      const percent = Math.max(0, Math.round(s.energy))
      const tone = percent <= 25 ? '已经很困了，脑子转不太动，说话会短、会卡' : percent <= 55 ? '有点犯困，反应慢半拍' : '开始犯困了，但还能撑'
      lines.push(`现在是疲劳时段，你的精力还剩 ${percent}%，${tone}。`)
    }

    if (!lines.length) return ''
    return ['【作息状态】', ...lines.map((line) => `- ${line}`)].join('\n')
  }

  // ------------------------------------------------------------ 展示
  snapshot() {
    const cfg = this.cfg
    const s = this.state
    const now = Date.now()
    const stage = this.stage(now)
    const plan = this.plan(now)
    const data = {
      enabled: Boolean(cfg.enabled),
      mode: s.mode,
      energy: Math.round(s.energy * 10) / 10,
      energyMax: Number(cfg.energyMax) || 100,
      fatigue: energy.fatigueKind(cfg, now),
      wakeMode: this.waker.mode(),
      wakeTime: cfg.wakeTime,
      wakeJitter: Math.max(0, Math.min(90, Number(cfg.wakeJitterMinutes) || 0)),
      wakeWindow: energy.wakeWindowText(cfg),
      nightFatigue: cfg.nightFatigue,
      noonFatigue: cfg.noonFatigue,
      latestSleepTime: cfg.latestSleepTime,
      dreamOn: Boolean(cfg.dreamEnabled),
      dreamInRemOnly: Boolean(cfg.dreamInRemOnly),
      allowSleep: Boolean(cfg.allowSleep),
      sleepKind: s.sleepKind || 'night',
      pendingCrawl: (s.pendingChats || []).length,
      crawlSessions: (s.pendingChats || []).slice(0, 10),
      lastTick: s.lastTick,
      timeZone: cfg.timeZone,
      nowClock: energy.clockText(now),
      dreams: this.dreamer.stats(),
    }

    if (s.mode === ASLEEP) {
      data.sleepAt = s.sleepAt
      data.wakeAt = s.wakeAt
      data.sleepReason = s.reason
      data.remaining = Math.max(0, s.wakeAt - now)
      data.remainingText = energy.humanDuration(Math.max(0, s.wakeAt - now))
      data.wakeAtClock = energy.clockText(s.wakeAt)
      data.wakeDayLabel = energy.dayLabel(s.wakeAt)
      data.wakeLabel = s.sleepKind === 'noon' ? energy.clockText(s.wakeAt) : energy.wakeWindowText(cfg)
      data.stage = stage
      data.stageText = stages.describe(stage)
      data.stageSeq = plan.map((seg) => ({ ...seg, active: stage ? seg.start === stage.since : false }))
      data.stageStats = stages.stats(plan)
      if (stage) {
        data.stageRemainingText = energy.humanDuration(stage.remaining)
        data.stageEnergyFactor = stages.energyFactor(stage)
      }
    }
    if (s.mode === WAKING) {
      const limit = Math.max(1, Number(cfg.wakingTimeoutMinutes) || 5) * MIN
      data.wakingSince = s.enterWakingAt
      data.wakingLeft = s.enterWakingAt ? Math.max(0, s.enterWakingAt + limit - now) : 0
    }
    return data
  }

  statusText() {
    const data = this.snapshot()
    if (!data.enabled) return '长夜如梦没开'
    if (data.mode === AWAKE) {
      const fatigue = data.fatigue ? '（疲劳期）' : ''
      return `醒着${fatigue} 精力 ${data.energy}/${data.energyMax} 起床点 ${data.wakeTime} 浮动 ±${data.wakeJitter} 分钟`
    }
    if (data.mode === WAKING) {
      return `正醒着，还没爬起来${data.pendingCrawl ? `（待爬 ${data.pendingCrawl} 个会话）` : ''}`
    }
    return `睡着中 剩余 ${data.remainingText} 预计 ${data.wakeDayLabel || ''}${data.wakeAtClock || ''} 醒 精力 ${Math.round(data.energy)}`
  }
}
