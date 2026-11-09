// 宠物数值体系（饱腹 / 精力 / 亲密度）——纯函数，不碰 fs、不碰时间，全部可注入。
//
// 设计出处：Astra Pet 的 design/pet-life/02-needs-and-bond.md + LifeRules.cs。
// 学的是它的**基调**，不是照抄数字：
//   · 纯陪伴，不惩罚。数值只影响表现（做动作、冒小气泡、写进她的人格情境），
//     不生病、不死亡、不离家出走、亲密度等级**只涨不掉**。
//   · 关掉程序的时间按真实时间补算，但**有下限**：饱腹最低降到 35，不会「周末回来饿扁了」。
//   · 只有**穿过阈值**才发事件（不是低于阈值期间一直发），且带回差，避免在 29.9 / 30.1 抖动刷屏。
//   · 饿了困了只做动作 + 冒小气泡，**不弹系统通知、不朗读**（那是打扰，不是陪伴）。
//
// 和我们已有模块的关系（刻意不造第二套真相）：
//   · 心情（mood）**不在这里**。Aurabot 的 mood 模块已经有 0~100 的心情和 nudge()，
//     这里只输出「心情基线建议」，由 index.mjs 去 nudge 它，绝不另存一份。
//   · 亲密度经验由本文件维护，按 petId 分文件落盘（每只宠物各一份）。

/** 平衡常量：调数值只改这里；不开放给素材包改（第三方包不该能把它调成饿死）。 */
export const TUNING = {
  // 每小时自然下降 / 回升
  satietyDecay: 6, satietyDecayResting: 2,
  energyDecay: 5, energyNightExtra: 5, energyRecover: 25,
  // 阈值
  hungryBelow: 30, hungryRecoverAt: 40, starvingBelow: 10,
  sleepyBelow: 20, restedAt: 60,
  fullAt: 95,
  // 冷落：多久不互动开始扣、每小时扣多少、封顶多少
  neglectAfterMs: 2 * 60 * 60 * 1000,
  neglectPerHour: 5, neglectMax: 30,
  // 亲密度
  dailyXpCap: 60,
  dailyChatXpTurns: 20,
  levelXp: [0, 60, 180, 400, 700, 1100, 1600, 2200, 3000, 4000],
  levelNames: ['初次见面', '认识了', '熟悉', '朋友', '好朋友', '亲近', '很亲近', '挚友', '家人', '最重要的人'],
  // 离线补算
  offlineSatietyFloor: 35,
  longAwayMs: 24 * 60 * 60 * 1000,
  offlineCapMs: 365 * 24 * 60 * 60 * 1000,
  maxSnacks: 10,
  // 回差：跨越阈值后要回到这么多才算「稳定」，防止在临界点反复触发
  hysteresis: 2,
}

/** 一次互动对数值的影响（正负都按「一次」算）。 */
export const INTERACTIONS = {
  click: { mood: 2, xp: 1 },                    // 每小时最多算几次由 index.mjs 节流
  pat: { mood: 6, xp: 3 },
  chat: { mood: 3, xp: 4 },                     // 每天前 dailyChatXpTurns 轮才算经验
  play: { satiety: -3, energy: -8, mood: 12, xp: 6 },
  focus: { mood: 5, xp: 8 },                    // 陪主人专注完一轮
  spammed: { mood: -8 },                        // 1 秒内狂点
  woken: { mood: -6 },                          // 睡着被戳醒
  thrownSoft: { mood: 0 },
  thrownHard: { mood: 0 },
}

/** 内置食物（emoji 图标，三平台都有，不额外分发图片）。snack 的只能用专注奖励攒。 */
export const FOODS = [
  { id: 'rice-ball', name: '饭团', icon: '🍙', satiety: 25, energy: 0, mood: 0, snack: false, cooldownMin: 30 },
  { id: 'milk', name: '牛奶', icon: '🥛', satiety: 10, energy: 5, mood: 0, snack: false, cooldownMin: 15 },
  { id: 'vegetable', name: '青菜', icon: '🥬', satiety: 20, energy: 0, mood: 0, snack: false, cooldownMin: 30 },
  { id: 'fish', name: '小鱼干', icon: '🐟', satiety: 15, energy: 0, mood: 0, snack: true, cooldownMin: 0 },
  { id: 'cake', name: '小蛋糕', icon: '🍰', satiety: 15, energy: 0, mood: 5, snack: true, cooldownMin: 0 },
  { id: 'ice-cream', name: '冰淇淋', icon: '🍦', satiety: 10, energy: 0, mood: 8, snack: true, cooldownMin: 0 },
  { id: 'cookie', name: '饼干', icon: '🍪', satiety: 10, energy: 0, mood: 0, snack: true, cooldownMin: 0 },
]

export const findFood = (id) => FOODS.find((f) => f.id === String(id || '')) || null

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))
const dayKey = (now) => new Date(now).toDateString()
/** 时间戳取有效值。不能用 `||`：0 是合法的「纪元起点」，`||` 会把它当成缺失。
 *  踩过：测试注入 savedAt: 0 验证离线补算，结果被当成"没存过"直接改成当前时间，补算永远算出 0 小时。 */
const ts = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 一小时里是不是深夜（22:00–06:00）：夜里精力掉得更快。 */
export function isNight(now) {
  const h = new Date(now).getHours()
  return h >= 22 || h < 6
}

/** 亲密度等级（1~10）。 */
export function level(xp) {
  const x = Math.max(0, Number(xp) || 0)
  let n = 1
  for (let i = 0; i < TUNING.levelXp.length; i++) if (x >= TUNING.levelXp[i]) n = i + 1
  return n
}

export function levelName(lv) {
  const i = clamp(lv, 1, TUNING.levelNames.length) - 1
  return TUNING.levelNames[i] || TUNING.levelNames[0]
}

/** 到下一级还差多少经验；满级返回 null。 */
export function toNextLevel(xp) {
  const x = Math.max(0, Number(xp) || 0)
  const lv = level(x)
  if (lv >= TUNING.levelNames.length) return null
  return { level: lv + 1, need: TUNING.levelXp[lv] - x, total: TUNING.levelXp[lv] }
}

/** 空档案：第一次跑、或者存档坏了都从这里开始。 */
export function freshState(now = Date.now()) {
  return {
    version: 1,
    adoptedAt: now,
    savedAt: now,
    satiety: 80,
    energy: 100,
    xp: 0,
    todayXp: 0,
    today: dayKey(now),
    chatTurnsToday: 0,
    lastInteractionAt: now,
    snacks: {},
    cooldowns: {},
    flags: {},
    stats: { petted: 0, fed: 0, chats: 0, focusMinutes: 0, thrown: 0, climbs: 0 },
  }
}

/** 读回来之后先洗一遍：坏字段给默认值，别让一个 NaN 传染整个档案。 */
export function normalizeState(raw, now = Date.now()) {
  const base = freshState(now)
  if (!raw || typeof raw !== 'object') return base
  const out = { ...base }
  out.version = 1
  out.adoptedAt = ts(raw.adoptedAt, base.adoptedAt)
  out.savedAt = ts(raw.savedAt, now)
  out.satiety = clamp(raw.satiety ?? base.satiety, 0, 100)
  out.energy = clamp(raw.energy ?? base.energy, 0, 100)
  out.xp = Math.max(0, Number(raw.xp) || 0)
  out.today = typeof raw.today === 'string' ? raw.today : dayKey(now)
  out.todayXp = Math.max(0, Number(raw.todayXp) || 0)
  if (out.today !== dayKey(now)) { out.today = dayKey(now); out.todayXp = 0; out.chatTurnsToday = 0 }
  out.chatTurnsToday = Math.max(0, Number(raw.chatTurnsToday) || 0)
  out.lastInteractionAt = ts(raw.lastInteractionAt, now)
  out.snacks = raw.snacks && typeof raw.snacks === 'object' ? { ...raw.snacks } : {}
  out.cooldowns = raw.cooldowns && typeof raw.cooldowns === 'object' ? { ...raw.cooldowns } : {}
  // 阈值闩锁：记着「已经喊过饿了 / 困了」，回到上阈值才清。存档要带着，否则重启后会再喊一次。
  out.flags = raw.flags && typeof raw.flags === 'object' ? { ...raw.flags } : {}
  out.stats = { ...base.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) }
  return out
}

/** 心情基线：由饱腹 / 精力 / 冷落三项修正组成。只是「建议值」，真正改心情走 mood 模块。 */
export function moodBaseline(state, now = Date.now(), { onComputer = false } = {}) {
  let base = 10
  const s = clamp(state.satiety, 0, 100)
  const e = clamp(state.energy, 0, 100)
  if (s < 10) base -= 40
  else if (s < 30) base -= 20
  if (e < 20) base -= 15
  // 冷落只在「用户在电脑前却一直不理她」时才算；人不在，不算冷落
  if (onComputer) {
    const away = now - ts(state.lastInteractionAt, now)
    if (away > TUNING.neglectAfterMs) {
      const hours = (away - TUNING.neglectAfterMs) / 3600_000
      base -= Math.min(TUNING.neglectMax, hours * TUNING.neglectPerHour)
    }
  }
  return clamp(base, -40, 40)
}

/**
 * 前进 n 分钟。返回新状态 + 穿过阈值的事件（没穿过就是空数组）。
 * 纯函数：不改入参，时间由 now 注入。
 */
export function advance(state, minutes, { now = Date.now(), awake = true, onComputer = false } = {}) {
  const s = normalizeState(state, now)
  const next = { ...s, snacks: { ...s.snacks }, cooldowns: { ...s.cooldowns }, stats: { ...s.stats }, flags: { ...s.flags } }
  const dt = Math.max(0, Number(minutes) || 0)
  const hours = dt / 60
  const before = { satiety: s.satiety, energy: s.energy, flags: s.flags }

  // 饱腹：醒着 −6/h，睡着 −2/h
  next.satiety = clamp(s.satiety - (awake ? TUNING.satietyDecay : TUNING.satietyDecayResting) * hours, 0, 100)
  // 精力：醒着 −5/h，22–6 点再额外 −5/h；睡着 +25/h
  const night = awake && isNight(now)
  next.energy = awake
    ? clamp(s.energy - (TUNING.energyDecay + (night ? TUNING.energyNightExtra : 0)) * hours, 0, 100)
    : clamp(s.energy + TUNING.energyRecover * hours, 0, 100)

  // 心情基线：给 index.mjs 用来 nudge 现有 mood 模块（这里不存）
  next.moodBaselineHint = moodBaseline(next, now, { onComputer })
  next.savedAt = now
  return { state: next, crossings: crossingsOf(before, next, { now }), changed: before.satiety !== next.satiety || before.energy !== next.energy }
}

/**
 * 穿过阈值的事件。只在**跨过**的那一刻发一次。
 *
 * 回差靠**闩锁标志**（state.flags）而不是只靠阈值区间：
 * 只在「30 掉到 29.9」时发饿，然后一直记着「已经饿了」，直到饱腹回到 40 才清掉。
 * 为什么不能只靠区间：饱腹在 29.9 / 30.1 之间抖的时候，「30.1 ≥ 30 且 29.9 < 30」每一轮都成立，
 * 于是每抖一下就喊一次饿 —— 实测 20 次抖动喊了 20 次。这是 Astra Pet 文档里
 * 「带回差，避免在阈值附近抖动反复触发」那句的**真正含义**，只写区间是不够的。
 */
export function crossingsOf(before, after, { now = Date.now() } = {}) {
  const out = []
  const b = before || {}
  const a = after || {}
  const bSat = Number(b.satiety)
  const aSat = Number(a.satiety)
  const bEne = Number(b.energy)
  const aEne = Number(a.energy)
  const flags = { ...(b.flags && typeof b.flags === 'object' ? b.flags : {}) }

  if (Number.isFinite(bSat) && Number.isFinite(aSat)) {
    // 饿：掉到 30 以下时喊一次；回到 40 才算解除
    if (aSat < TUNING.hungryBelow) {
      if (!flags.hungry) { flags.hungry = true; out.push({ event: 'needs.hungry', data: { satiety: Math.round(aSat) } }) }
    } else if (aSat >= TUNING.hungryRecoverAt && flags.hungry) {
      flags.hungry = false
      out.push({ event: 'needs.fed', data: { satiety: Math.round(aSat) } })
    }
    // 饿坏了：同样是闩锁，回到 40 一起解除
    if (aSat < TUNING.starvingBelow) {
      if (!flags.starving) { flags.starving = true; out.push({ event: 'needs.starving', data: { satiety: Math.round(aSat) } }) }
    } else if (aSat >= TUNING.hungryRecoverAt && flags.starving) {
      flags.starving = false
    }
  }
  if (Number.isFinite(bEne) && Number.isFinite(aEne)) {
    // 困：掉到 20 以下喊一次；回到 60 才算睡饱
    if (aEne < TUNING.sleepyBelow) {
      if (!flags.sleepy) { flags.sleepy = true; out.push({ event: 'needs.sleepy', data: { energy: Math.round(aEne) } }) }
    } else if (aEne >= TUNING.restedAt && flags.sleepy) {
      flags.sleepy = false
      out.push({ event: 'needs.rested', data: { energy: Math.round(aEne) } })
    }
  }
  // 闩锁落在**结果状态**上（调用方传进来的就是下一份状态）：不能只存在局部变量里，
  // 否则下一次 tick 又忘了「已经喊过」，等于没有回差。赋新对象，别改调用方共享的那份。
  a.flags = flags
  return out
}

/**
 * 一次互动。kind 见 INTERACTIONS。
 * 返回新状态、穿过的事件、以及这次加了多少经验。
 * 亲密度按每日上限截断：挂个连点器也刷不满，但「每天来看看她」比「一天猛刷」更值。
 */
export function interact(state, kind, { now = Date.now(), onComputer = false } = {}) {
  const s = normalizeState(state, now)
  const rule = INTERACTIONS[kind] || null
  if (!rule) return { state: s, crossings: [], xp: 0, ignored: true }
  const next = { ...s, snacks: { ...s.snacks }, cooldowns: { ...s.cooldowns }, stats: { ...s.stats }, flags: { ...s.flags } }
  const before = { satiety: s.satiety, energy: s.energy, flags: s.flags }

  if (Number.isFinite(rule.satiety)) next.satiety = clamp(s.satiety + rule.satiety, 0, 100)
  if (Number.isFinite(rule.energy)) next.energy = clamp(s.energy + rule.energy, 0, 100)

  // 经验：先按每日上限截断，再累加
  let xp = Math.max(0, Number(rule.xp) || 0)
  if (rule.xp && kind === 'chat') {
    // 每天前 dailyChatXpTurns 轮才算
    if (s.chatTurnsToday >= TUNING.dailyChatXpTurns) xp = 0
    next.chatTurnsToday = s.chatTurnsToday + 1
  }
  const room = Math.max(0, TUNING.dailyXpCap - s.todayXp)
  const gained = Math.min(xp, room)
  next.xp = s.xp + gained
  next.todayXp = s.todayXp + gained
  next.lastInteractionAt = now
  next.savedAt = now

  if (kind === 'pat') next.stats.petted = (s.stats.petted || 0) + 1
  if (kind === 'chat') next.stats.chats = (s.stats.chats || 0) + 1
  if (kind === 'focus') next.stats.focusMinutes = (s.stats.focusMinutes || 0) + 25

  const crossings = crossingsOf(before, next, { now })
  const levelBefore = level(s.xp)
  const levelAfter = level(next.xp)
  if (levelAfter > levelBefore) {
    crossings.push({ event: 'bond.levelUp', data: { level: levelAfter, name: levelName(levelAfter) } })
  }
  next.moodBaselineHint = moodBaseline(next, now, { onComputer })
  return { state: next, crossings, xp: gained, mood: rule.mood || 0, levelUp: levelAfter > levelBefore }
}

/**
 * 喂食。返回 { ok, state, crossings, food, reason }。
 * 吃不下（饱腹 ≥ 95）时**不消耗冷却**，也不扣零食。
 */
export function feed(state, foodId, { now = Date.now(), onComputer = false } = {}) {
  const s = normalizeState(state, now)
  const food = findFood(foodId)
  if (!food) return { ok: false, reason: 'unknown-food', state: s, crossings: [] }
  if (s.satiety >= TUNING.fullAt) return { ok: false, reason: 'full', state: s, crossings: [], food }
  if (food.snack) {
    const have = Math.max(0, Number(s.snacks[food.id]) || 0)
    if (have <= 0) return { ok: false, reason: 'no-snack', state: s, crossings: [], food }
  } else {
    const cd = Number(s.cooldowns[food.id]) || 0
    if (cd > now) return { ok: false, reason: 'cooldown', state: s, crossings: [], food, waitMs: cd - now }
  }

  const next = { ...s, snacks: { ...s.snacks }, cooldowns: { ...s.cooldowns }, stats: { ...s.stats }, flags: { ...s.flags } }
  const before = { satiety: s.satiety, energy: s.energy, flags: s.flags }
  next.satiety = clamp(s.satiety + food.satiety, 0, 100)
  next.energy = clamp(s.energy + (food.energy || 0), 0, 100)
  if (food.snack) {
    const left = Math.max(0, (Number(s.snacks[food.id]) || 0) - 1)
    if (left) next.snacks[food.id] = left
    else delete next.snacks[food.id]
  } else if (food.cooldownMin > 0) {
    next.cooldowns[food.id] = now + food.cooldownMin * 60_000
  }
  next.stats.fed = (s.stats.fed || 0) + 1
  next.lastInteractionAt = now
  next.savedAt = now
  next.moodBaselineHint = moodBaseline(next, now, { onComputer })

  // 喂食也算一次互动，给经验（走和 interact 一样的每日上限）
  const room = Math.max(0, TUNING.dailyXpCap - s.todayXp)
  const gained = Math.min(5, room)
  next.xp = s.xp + gained
  next.todayXp = s.todayXp + gained

  const crossings = crossingsOf(before, next, { now })
  return { ok: true, state: next, crossings, food, xp: gained, mood: food.mood || 0, levelUp: level(next.xp) > level(s.xp) }
}

/** 完成一轮专注：随机给一份零食（攒着以后喂），满量就不再给。 */
export function rewardSnack(state, { now = Date.now(), rng = Math.random } = {}) {
  const s = normalizeState(state, now)
  const pool = FOODS.filter((f) => f.snack)
  const total = Object.values(s.snacks).reduce((a, b) => a + (Number(b) || 0), 0)
  if (total >= TUNING.maxSnacks) return { ok: false, reason: 'full-bag', state: s }
  const food = pool[Math.floor(rng() * pool.length) % pool.length]
  const next = { ...s, snacks: { ...s.snacks } }
  next.snacks[food.id] = (Number(s.snacks[food.id]) || 0) + 1
  next.savedAt = now
  return { ok: true, state: next, food }
}

/**
 * 关掉程序一段时间后回来：按真实时间补算，但**有下限**。
 *
 * 离线按睡眠速率算（−2/h），但最低只降到 35。真正用的公式是 `min(s, max(35, s − 2h))`：
 * 只写 `max(35, s − 2h)` 会把本来饿着（比如 12）的「补」到 35，等于离线期间偷偷加餐。
 * 精力离线回满，心情回基线（心情不在这份档案里，只输出建议值）。
 * 系统时间被往回调（负时长）按 0 处理；超过 365 天按 365 天封顶。
 */
export function catchUp(state, { now = Date.now(), onComputer = false } = {}) {
  const s = normalizeState(state, now)
  const last = ts(s.savedAt, now)
  let away = now - last
  if (!Number.isFinite(away) || away < 0) away = 0
  away = Math.min(away, TUNING.offlineCapMs)
  const hours = away / 3600_000
  const next = { ...s, snacks: { ...s.snacks }, cooldowns: { ...s.cooldowns }, stats: { ...s.stats }, flags: { ...s.flags } }
  const decayed = clamp(s.satiety - TUNING.satietyDecayResting * hours, 0, 100)
  next.satiety = Math.min(s.satiety, Math.max(TUNING.offlineSatietyFloor, decayed))
  next.energy = 100
  next.savedAt = now
  next.today = dayKey(now)
  // 跨天了：今天的经验和聊天轮数重算
  if (s.today !== dayKey(now)) { next.todayXp = 0; next.chatTurnsToday = 0 }
  next.moodBaselineHint = moodBaseline(next, now, { onComputer })
  return {
    state: next,
    awayMs: away,
    longAway: away >= TUNING.longAwayMs,
    days: Math.floor(away / 86_400_000),
  }
}

/**
 * 给 LLM 看的一段话（写进她的情境层）。
 * 刻意写成**档位 + 括号里的数字**：只写数字模型会老念数字，只写档位又不够具体。
 * 并且明说「一次对话最多提一次」—— 不然她会每轮都要吃的。
 */
export function contextLine(state, { now = Date.now() } = {}) {
  const s = normalizeState(state, now)
  const sat = s.satiety
  const ene = s.energy
  const satWord = sat < TUNING.starvingBelow ? '饿坏了' : sat < TUNING.hungryBelow ? '有点饿' : sat > 85 ? '吃得很饱' : '不饿'
  const eneWord = ene < TUNING.sleepyBelow ? '很困' : ene > 70 ? '精神很好' : '有点累'
  const lv = level(s.xp)
  const days = Math.max(0, Math.floor((now - s.adoptedAt) / 86_400_000))
  const sn = Object.entries(s.snacks).map(([k, v]) => `${(findFood(k) || {}).name || k}×${v}`).join('、')
  return [
    `你现在：${satWord}（饱腹 ${Math.round(sat)}/100），${eneWord}（精力 ${Math.round(ene)}/100）。`,
    `你和主人：认识 ${days} 天，${levelName(lv)}（亲密度 ${lv}，${Math.round(s.xp)} 经验）。`,
    sn ? `你攒着的零食：${sn}（主人完成专注会给你，你可以撒娇要）。` : '',
    `饿了、困了可以顺口提一句，但一次对话最多提一次，不要反复要吃的。`,
  ].filter(Boolean).join('\n')
}

/** 面板/浮层用的一份快照（不含内部字段）。 */
export function snapshot(state, { now = Date.now() } = {}) {
  const s = normalizeState(state, now)
  const lv = level(s.xp)
  const nl = toNextLevel(s.xp)
  return {
    satiety: Math.round(s.satiety),
    energy: Math.round(s.energy),
    xp: Math.round(s.xp),
    level: lv,
    levelName: levelName(lv),
    toNext: nl,
    todayXp: Math.round(s.todayXp),
    dailyCap: TUNING.dailyXpCap,
    moodBaseline: Math.round(moodBaseline(s, now)),
    hunger: s.satiety < TUNING.starvingBelow ? 'starving' : s.satiety < TUNING.hungryBelow ? 'hungry' : s.satiety > 85 ? 'full' : 'ok',
    sleepiness: s.energy < TUNING.sleepyBelow ? 'sleepy' : s.energy > 70 ? 'fresh' : 'tired',
    snacks: Object.entries(s.snacks).map(([id, n]) => ({ id, name: (findFood(id) || {}).name || id, icon: (findFood(id) || {}).icon || '🍬', n: Number(n) || 0 })),
    foods: FOODS.map((f) => ({
      id: f.id, name: f.name, icon: f.icon, snack: f.snack,
      cooldownMin: f.cooldownMin,
      readyAt: Number(s.cooldowns[f.id]) || 0,
      have: f.snack ? Number(s.snacks[f.id]) || 0 : null,
    })),
    stats: { ...s.stats },
    days: Math.max(0, Math.floor((now - s.adoptedAt) / 86_400_000)),
  }
}
