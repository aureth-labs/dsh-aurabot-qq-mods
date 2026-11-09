/**
 * 活动状态机 —— 纯规则，不调模型。
 *
 * 移植自 N.E.K.O `main_logic/activity/state_machine.py` + `snapshot.py`，
 * 裁掉了 GPU 兜底、语音通道、LLM enrichment 这些这台机器上没有的东西。
 *
 * 输入：每 5 秒一次的系统采样（前台标题 / 进程名 / 空闲秒数 / CPU）+ 对话时间戳。
 * 输出：状态、倾向（propensity）、语气（tone）、跳过概率，以及给提示词用的一句话。
 */

export const AWAY_IDLE_SECONDS = 15 * 60
export const STALE_RECOVERY_SECONDS = 60
export const FOCUSED_WORK_MIN_DWELL_SECONDS = 90
export const CASUAL_BROWSING_MIN_DWELL_SECONDS = 30
export const FOCUSED_VIDEO_MIN_DWELL_SECONDS = 120
export const FOCUSED_WORK_RECENT_INPUT_SECONDS = 120
export const WINDOW_BUFFER_MAXLEN = 32
export const WINDOW_SWITCH_LOOKBACK_SECONDS = 120
export const WINDOW_SWITCH_TRANSITION_THRESHOLD = 4
export const TRANSITION_RECENT_WINDOW_SECONDS = 90
export const UNFINISHED_THREAD_WINDOW_SECONDS = 5 * 60
export const UNFINISHED_THREAD_MAX_FOLLOWUPS = 1
export const UNFINISHED_THREAD_PARSE_TAIL = 60

const QUESTION_MARKS = ['?', '？']
const CN_QUESTION_PARTICLES = ['吗', '嗎', '呢', '么', '吧']

/** 状态 → 倾向。private 硬锁 closed；工作/游戏/沉浸看片只留「屏幕」这一个渠道。 */
const STATE_TO_PROPENSITY = {
  away: 'open',
  stale_returning: 'greeting_window',
  gaming: 'restricted_screen_only',
  focused_work: 'restricted_screen_only',
  casual_browsing: 'open',
  focused_video: 'restricted_screen_only',
  chatting: 'open',
  idle: 'open',
  transitioning: 'open',
  private: 'closed',
}

/** 默认跳过概率：只有恐怖游戏该主动闭嘴。 */
const DEFAULT_GAMING_SKIP_PROB = {
  'immersive|horror': 0.3,
}

export function stripEmotionTags(text) {
  if (!text || !text.includes('<')) return text || ''
  let out = ''
  let inTag = false
  for (const ch of text) {
    if (ch === '<') { inTag = true; continue }
    if (ch === '>' && inTag) { inTag = false; continue }
    if (!inTag) out += ch
  }
  return out
}

/** 她上一句是不是在问问题、主人还没回。误判最多多一次追问，能接受。 */
export function textHasOpenQuestion(text) {
  if (!text) return false
  const cleaned = stripEmotionTags(text).trim()
  if (!cleaned) return false
  const tail = cleaned.slice(-UNFINISHED_THREAD_PARSE_TAIL)
  if (QUESTION_MARKS.some((m) => tail.includes(m))) return true
  const trail = cleaned.replace(/[ 。、，,.!！~～…]+$/, '')
  if (!trail) return false
  return CN_QUESTION_PARTICLES.includes(trail[trail.length - 1])
}

export function hourToPeriod(hour) {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

export function derivePropensity(state, { intensity } = {}) {
  if (state === 'gaming' && intensity === 'casual') return 'open'
  return STATE_TO_PROPENSITY[state] ?? 'open'
}

export function deriveTone(state, { intensity, genre } = {}) {
  if (state === 'private') return 'concise'
  if (state === 'gaming') {
    if (intensity === 'competitive') return 'terse'
    if (intensity === 'immersive') return genre === 'horror' ? 'hushed' : 'mellow'
    if (intensity === 'casual') return 'playful'
    return 'concise'
  }
  if (state === 'casual_browsing' || state === 'focused_video') return 'witty'
  if (state === 'chatting' || state === 'stale_returning') return 'warm'
  if (state === 'idle') return 'playful'
  return 'concise'
}

export function deriveSkipProbability(state, { intensity, genre } = {}) {
  if (state !== 'gaming' || !intensity) return 0
  if (genre && intensity !== 'varied') {
    const key = `${intensity}|${genre}`
    if (key in DEFAULT_GAMING_SKIP_PROB) return DEFAULT_GAMING_SKIP_PROB[key]
  }
  return 0
}

/** 每种语气配一句写给模型看的短指令 —— 桌宠版，不是 N.E.K.O 的英文原文。 */
export const TONE_LINES = {
  terse: '主人在打竞技局，一句都别多，别问问题，别说「加油」这种废话。真要开口就一两个短句。',
  hushed: '主人在玩恐怖游戏，说话轻一点、慢一点，别起哄，别突然热闹。',
  mellow: '主人沉迷剧情里，语气松软一点，跟着剧情走，不要抢戏。',
  playful: '主人不忙，可以放开闹、可以贱兮兮地吐槽两句。',
  witty: '主人在看视频/直播，可以接梗、可以吐槽，但必须真的好笑，不好笑就别出声。',
  warm: '正在跟主人正经说话，语气暖一点，像平时聊天那样。',
  concise: '主人在忙手上的事，说短句、说有用的，别闲扯。',
}

const PROPENSITY_LINES = {
  closed: '现在完全不要主动开口。',
  restricted_screen_only: '这块屏幕现在归主人，没事别插嘴；只有他自己找你、或者他明显卡住了才说话。',
  open: '可以主动找主人说话。',
  greeting_window: '主人刚回来，适合先打个招呼。',
}

const STATE_LABELS = {
  away: '人不在电脑前',
  stale_returning: '刚回到电脑前',
  gaming: '在玩游戏',
  focused_work: '在专心干活',
  casual_browsing: '在随便逛',
  focused_video: '在沉浸看视频',
  chatting: '在聊天',
  idle: '人在，没在忙什么',
  transitioning: '在几个窗口之间来回切',
  private: '在打开私人应用',
}

export class ActivityStateMachine {
  constructor(options = {}) {
    this.awayIdleSeconds = options.awayIdleSeconds ?? AWAY_IDLE_SECONDS
    this.staleRecoverySeconds = options.staleRecoverySeconds ?? STALE_RECOVERY_SECONDS
    this.focusedWorkMinDwellSeconds = options.focusedWorkMinDwellSeconds ?? FOCUSED_WORK_MIN_DWELL_SECONDS
    this.casualBrowsingMinDwellSeconds = options.casualBrowsingMinDwellSeconds ?? CASUAL_BROWSING_MIN_DWELL_SECONDS
    this.focusedVideoMinDwellSeconds = options.focusedVideoMinDwellSeconds ?? FOCUSED_VIDEO_MIN_DWELL_SECONDS

    this.currentState = 'idle'
    this.previousState = null
    this.stateStartedAt = Date.now()

    this.windowHistory = []
    this.currentWindow = null
    this.currentWindowStartedAt = 0

    this.latestSystem = null
    this.lastUserMsgAt = null
    this.lastAiMsgAt = null
    this.staleReturningUntil = 0
    this.unfinishedThread = null
  }

  /** 收到一次采样。own_app（DSH 自己）只冻结 dwell，不覆盖上一个真实窗口。 */
  updateWindow(obs, now = Date.now()) {
    if (!obs) return
    const category = obs.category || 'unknown'
    if (category === 'own_app') {
      // 自己的窗口不算「主人在忙」，但它占着前台的时间也不该让上一个窗口攒 dwell。
      if (this.currentWindow) this.currentWindowStartedAt = now
      return
    }
    const key = `${category}|${obs.subcategory ?? ''}|${obs.canonical ?? ''}`
    const prev = this.currentWindow
    const prevKey = prev ? `${prev.category}|${prev.subcategory ?? ''}|${prev.canonical ?? ''}` : ''
    if (key === prevKey) return

    this.currentWindow = {
      category,
      subcategory: obs.subcategory ?? null,
      canonical: obs.canonical ?? null,
      intensity: obs.intensity ?? null,
      genre: obs.genre ?? null,
      title: obs.title ?? null,
      proc: obs.proc ?? null,
    }
    this.currentWindowStartedAt = now
    this.windowHistory.push({ timestamp: now, key })
    if (this.windowHistory.length > WINDOW_BUFFER_MAXLEN) this.windowHistory.shift()
  }

  updateSystem(snap) {
    this.latestSystem = snap
  }

  updateUserMessage(now = Date.now()) {
    this.lastUserMsgAt = now
    this.unfinishedThread = null
  }

  /** 她说了话：如果结尾是个问题，开一个 5 分钟的可追问窗口（最多追一次）。 */
  updateAiMessage(text, now = Date.now()) {
    this.lastAiMsgAt = now
    if (textHasOpenQuestion(text)) {
      this.unfinishedThread = { tail: String(text).trim().slice(-UNFINISHED_THREAD_PARSE_TAIL), startedAt: now, followUpCount: 0 }
    } else {
      this.unfinishedThread = null
    }
  }

  markUnfinishedThreadUsed() {
    if (this.unfinishedThread) this.unfinishedThread.followUpCount += 1
  }

  classifyState(now) {
    const sys = this.latestSystem
    const win = this.currentWindow

    // 1. 人不在 —— 唯一的信号是系统级空闲，压倒一切。
    if (sys && typeof sys.idle === 'number' && sys.idle >= this.awayIdleSeconds) return 'away'

    // 2. 私人应用 —— 优先级最高，人在也别出声。
    if (win && win.category === 'private') return 'private'

    // 3. 游戏 —— 只算真在玩，Steam 商店不算。
    if (win && win.category === 'gaming' && win.subcategory === 'game') return 'gaming'

    // 4. 专心干活 —— 工作窗口 + 攒够 dwell + 最近有输入。
    if (win && win.category === 'work') {
      const dwell = (now - this.currentWindowStartedAt) / 1000
      const recentInput =
        (this.lastUserMsgAt !== null && (now - this.lastUserMsgAt) / 1000 <= FOCUSED_WORK_RECENT_INPUT_SECONDS) ||
        (sys && typeof sys.idle === 'number' && sys.idle < FOCUSED_WORK_RECENT_INPUT_SECONDS)
      if (dwell >= this.focusedWorkMinDwellSeconds && recentInput) return 'focused_work'
    }

    // 5. 娱乐 —— 视频类攒够更长的 dwell 算沉浸，其余过了小门槛算随便逛。
    if (win && win.category === 'entertainment') {
      const dwell = (now - this.currentWindowStartedAt) / 1000
      if ((win.subcategory === 'video' || win.subcategory === 'live') && dwell >= this.focusedVideoMinDwellSeconds) {
        return 'focused_video'
      }
      if (dwell >= this.casualBrowsingMinDwellSeconds) return 'casual_browsing'
    }

    // 6. 聊天窗口挂着就是聊天。
    if (win && win.category === 'communication') return 'chatting'

    // 7. 最近切得很频繁 —— 说明在找东西。
    const switches = this.windowHistory.filter((e) => (now - e.timestamp) / 1000 <= WINDOW_SWITCH_LOOKBACK_SECONDS).length
    if (switches >= WINDOW_SWITCH_TRANSITION_THRESHOLD) return 'transitioning'

    // 8. 人在电脑前，但看不出在干嘛。
    return 'idle'
  }

  getSnapshot(now = Date.now()) {
    const newState = this.classifyState(now)
    if (newState !== this.currentState) {
      this.previousState = this.currentState
      if (this.currentState === 'away' && newState !== 'away') {
        this.staleReturningUntil = now + this.staleRecoverySeconds * 1000
      }
      this.currentState = newState
      this.stateStartedAt = now
    }

    // 刚回来那一下单独提出来当「打招呼窗口」；away 和 private 不掉级。
    let effectiveState = this.currentState
    if (
      now < this.staleReturningUntil &&
      this.currentState !== 'away' &&
      this.currentState !== 'private'
    ) {
      effectiveState = 'stale_returning'
    }

    const win = effectiveState === 'private' ? null : this.currentWindow
    const intensity = effectiveState === 'gaming' && win ? win.intensity : null
    const genre = effectiveState === 'gaming' && win ? win.genre : null

    const propensity = derivePropensity(effectiveState, { intensity })
    const tone = deriveTone(effectiveState, { intensity, genre })
    const skipProbability = deriveSkipProbability(effectiveState, { intensity, genre })

    // 挂着的追问：过期就作废，追问次数用满也作废。
    let thread = null
    if (this.unfinishedThread) {
      const age = (now - this.unfinishedThread.startedAt) / 1000
      if (age > UNFINISHED_THREAD_WINDOW_SECONDS || this.unfinishedThread.followUpCount >= UNFINISHED_THREAD_MAX_FOLLOWUPS) {
        this.unfinishedThread = null
      } else {
        thread = { tail: this.unfinishedThread.tail, ageSeconds: Math.round(age), followUps: this.unfinishedThread.followUpCount }
      }
    }

    const idleSeconds = this.latestSystem && typeof this.latestSystem.idle === 'number' ? this.latestSystem.idle : null
    const hour = new Date(now).getHours()

    return {
      at: now,
      state: effectiveState,
      rawState: this.currentState,
      label: STATE_LABELS[effectiveState] ?? effectiveState,
      propensity,
      tone,
      skipProbability,
      period: hourToPeriod(hour),
      idleSeconds,
      dwellSeconds: Math.round((now - this.currentWindowStartedAt) / 1000),
      window: win
        ? { category: win.category, subcategory: win.subcategory, canonical: win.canonical, title: win.title, proc: win.proc, intensity, genre }
        : null,
      secondsSinceUserMessage: this.lastUserMsgAt === null ? null : Math.round((now - this.lastUserMsgAt) / 1000),
      secondsSinceAiMessage: this.lastAiMsgAt === null ? null : Math.round((now - this.lastAiMsgAt) / 1000),
      switchedRecently: (now - this.stateStartedAt) / 1000 <= TRANSITION_RECENT_WINDOW_SECONDS,
      unfinishedThread: thread,
    }
  }
}

/** 把快照压成一句给模型看的话。信息密度优先，不要变成日志。 */
export function renderSnapshotLine(snap) {
  if (!snap) return ''
  const parts = []
  const who = snap.window && snap.window.canonical ? snap.window.canonical : snap.window && snap.window.title
  parts.push(who ? `主人${snap.label}：${String(who).slice(0, 40)}` : `主人${snap.label}`)

  const extra = []
  if (snap.state === 'away' && typeof snap.idleSeconds === 'number') {
    extra.push(`已经 ${Math.round(snap.idleSeconds / 60)} 分钟没动鼠标`)
  }
  if (snap.window && snap.window.intensity) extra.push(`${snap.window.intensity}/${snap.window.genre ?? 'misc'}`)
  if (typeof snap.secondsSinceUserMessage === 'number') extra.push(`距主人上次说话 ${Math.round(snap.secondsSinceUserMessage / 60)} 分钟`)
  if (snap.unfinishedThread) extra.push(`你上一句问了他还没回（${snap.unfinishedThread.tail}）`)
  if (extra.length) parts.push(`（${extra.join('；')}）`)

  const lines = [parts.join(''), PROPENSITY_LINES[snap.propensity] ?? '', TONE_LINES[snap.tone] ?? '']
  return lines.filter(Boolean).join(' ')
}
