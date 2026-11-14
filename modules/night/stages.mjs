// 睡眠阶段：刚入睡 / 浅层 / 深度 / 快速眼动。
//
// 三条硬约束：
// 1. 不落库：阶段是派生量，f(sleepAt, wakeAt, now) 现算，重启/休眠/时钟跳变都不会对不上。
// 2. 不靠 tick 精度：用绝对时间求值，心跳一分钟还是十分钟都一样。
// 3. 跟 dream / energy / wake 咬合：它们都从这里取系数。
//
// 模型抄真实睡眠结构：一个周期 90 分钟、一晚重复 4~6 次；前半夜深睡多、后半夜 REM 多。

export const STAGE_KEYS = ['n1', 'n2', 'n3', 'rem']

export const STAGE_CN = {
  n1: '刚入睡',
  n2: '浅层睡眠',
  n3: '深度睡眠',
  rem: '快速眼动',
}

// 精力恢复系数：深睡补得最多，跟「前半夜睡扎实、后半夜容易醒」对得上
export const ENERGY_BOOST = { n1: 1.0, n2: 1.2, n3: 2.2, rem: 1.3 }

// 叫醒难度系数：深睡喊不动，刚躺下和 REM 一叫就应
export const WAKE_FACTOR = { n1: 1.3, n2: 0.8, n3: 0.45, rem: 1.1 }

const MAX_CYCLES = 24
const MIN = 60_000

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

function cycleParts(c, { cycle, n1, deepMax, deepDecay, remBase, remGrow, remMax }) {
  const headN1 = c === 0 ? n1 : 0
  let deep = deepMax ? clamp(Math.round(deepMax * (1 - deepDecay * c)), 0, deepMax) : 0
  let rem = remMax ? clamp(Math.round(remBase + remGrow * c), remBase, remMax) : 0
  let rest = cycle - headN1 - deep - rem
  if (rest < 6) {
    // 配置被调得很怪（周期太短、深睡/REM 太长）时先压 REM 再压深睡，别让浅睡消失
    let over = 6 - rest
    const takeRem = Math.min(over, rem)
    rem -= takeRem
    over -= takeRem
    const takeDeep = Math.min(over, deep)
    deep -= takeDeep
    rest = Math.max(2, cycle - headN1 - deep - rem)
  }
  const before = Math.round(rest * 0.6)
  const after = rest - before
  const out = []
  if (headN1) out.push(['n1', headN1, c])
  out.push(['n2', before, c])
  if (deep) out.push(['n3', deep, c])
  if (after) out.push(['n2', after, c])
  if (rem) out.push(['rem', rem, c])
  return out
}

function noonParts(total, n1) {
  if (total <= 0) return []
  const n1m = n1 ? Math.min(n1, Math.max(0, total * 0.2)) : 0
  let rem = total >= 90 ? 8 : 0
  rem = Math.min(rem, Math.max(0, total - n1m))
  const n2 = Math.max(0, total - n1m - rem)
  const out = []
  if (n1m > 0) out.push(['n1', n1m, 0])
  if (n2 > 0) out.push(['n2', n2, 0])
  if (rem > 0) out.push(['rem', rem, 0])
  return out
}

/**
 * 整段睡眠计划 → [{ key, label, start, end, cycle }]，覆盖 sleepAt → wakeAt。
 * 时间都是毫秒时间戳。
 */
export function buildPlan(cfg, { sleepAt = 0, wakeAt = 0, kind = 'night' } = {}) {
  if (!cfg.stageEnabled) return []
  sleepAt = Number(sleepAt) || 0
  wakeAt = Number(wakeAt) || 0
  if (sleepAt <= 0 || wakeAt <= sleepAt) return []

  const total = (wakeAt - sleepAt) / MIN
  const cycle = Math.max(20, num(cfg.stageCycleMinutes, 90))
  const n1 = Math.max(0, num(cfg.stageN1Minutes, 8))
  const deepMax = Math.max(0, num(cfg.stageDeepMaxMinutes, 36))
  const deepDecay = Math.max(0, num(cfg.stageDeepDecay, 0.28))
  const remBase = Math.max(0, num(cfg.stageRemBaseMinutes, 10))
  const remGrow = Math.max(0, num(cfg.stageRemGrowMinutes, 6))
  const remMax = Math.max(remBase, num(cfg.stageRemMaxMinutes, 28))
  const noonLight = cfg.stageNoonLightOnly !== false && kind === 'noon'

  let minutes = []
  if (noonLight) {
    minutes = noonParts(total, n1)
  } else {
    let c = 0
    let covered = 0
    while (covered < total - 0.01 && c < MAX_CYCLES) {
      const chunk = cycleParts(c, { cycle, n1, deepMax, deepDecay, remBase, remGrow, remMax })
      minutes.push(...chunk)
      covered += chunk.reduce((sum, item) => sum + item[1], 0)
      c += 1
    }
  }

  const plan = []
  let cursor = sleepAt
  for (const [key, length, c] of minutes) {
    if (cursor >= wakeAt) break
    const end = Math.min(wakeAt, cursor + Math.round(length * MIN))
    if (end <= cursor) continue
    plan.push({
      key,
      label: STAGE_CN[key] || key,
      start: cursor,
      end,
      cycle: Number(c) || 0,
    })
    cursor = end
  }
  // 配置有零头或者总长没盖满时，把最后一段拉到 wakeAt，保证首尾严丝合缝
  if (plan.length && plan[plan.length - 1].end < wakeAt) plan[plan.length - 1].end = wakeAt
  return plan
}

/** 某一刻处在哪个阶段。没睡 / 计划为空时返回 null。 */
export function at(plan, now = Date.now()) {
  if (!plan || !plan.length) return null
  const ts = Number(now) || Date.now()
  let index = plan.length - 1
  if (ts < plan[0].start) {
    // 时钟回拨：还没到入睡点，按刚躺下算，别报「已经睡到最后一段」
    index = 0
  } else {
    for (let i = 0; i < plan.length; i += 1) {
      if (plan[i].start <= ts && ts < plan[i].end) {
        index = i
        break
      }
    }
  }
  const seg = plan[index]
  const span = Math.max(1, seg.end - seg.start)
  const progress = clamp((ts - seg.start) / span, 0, 1)
  return {
    key: seg.key,
    label: seg.label,
    since: seg.start,
    until: seg.end,
    progress: Math.round(progress * 1000) / 1000,
    cycle: seg.cycle,
    index,
    count: plan.length,
    remaining: Math.max(0, seg.end - ts),
  }
}

/** 各阶段总分钟数。 */
export function stats(plan) {
  const out = { n1: 0, n2: 0, n3: 0, rem: 0 }
  for (const seg of plan || []) {
    const key = seg.key
    if (key in out) out[key] += Math.round((seg.end - seg.start) / MIN)
  }
  return out
}

/** 给面板甘特条用：当前段往后的一段序列。horizon=0 表示到计划末尾。 */
export function seq(plan, now = Date.now(), horizon = 0) {
  if (!plan || !plan.length) return []
  const ts = Number(now) || Date.now()
  const limit = horizon ? ts + horizon : plan[plan.length - 1].end
  const picked = plan.filter((seg) => seg.end > ts && seg.start < limit)
  return picked.length ? picked : [plan[plan.length - 1]]
}

/** 「深度睡眠 · 第 2 个周期」这种给人看的短句。 */
export function describe(stage) {
  if (!stage) return ''
  return `${stage.label || ''} · 第 ${(Number(stage.cycle) || 0) + 1} 个周期`
}

export function energyFactor(stage) {
  if (!stage) return 1.0
  return ENERGY_BOOST[stage.key] || 1.0
}

export function wakeFactor(stage) {
  if (!stage) return 1.0
  return WAKE_FACTOR[stage.key] || 1.0
}
