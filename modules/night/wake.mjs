// 唤醒判定：三档策略 + 概率递增。
// 1. 计数是「窗口内累计」，不是连击——只要还在窗口里就一直攒
// 2. 概率按条数平分，攒到 y+n 必醒，所以再难叫也有上限
// 3. 群聊在 private_only 档下完全不累计，等于静默
// 4. 掷不中不清零，下次继续攒

export const MODE_NEVER = 'never'
export const MODE_PRIVATE = 'private_only'
export const MODE_BOTH = 'both'

const MIN = 60_000

export function createWaker(cfgOf, stageOf, rngOf) {
  const counters = new Map()
  // 掷骰的随机源可注入，测试要确定性
  const rng = () => (typeof rngOf === 'function' ? rngOf() : Math.random())

  const mode = () => {
    const raw = String(cfgOf().wakeMode || MODE_PRIVATE).trim()
    return [MODE_NEVER, MODE_PRIVATE, MODE_BOTH].includes(raw) ? raw : MODE_PRIVATE
  }
  const windowMs = () => Math.max(1, Number(cfgOf().wakeWindowMinutes) || 10) * MIN
  const startCount = () => Math.max(1, Number(cfgOf().wakeStartCount) || 2)
  const stepCount = () => Math.max(0, Number(cfgOf().wakeStepCount) || 4)

  function bump(sessionId) {
    const now = Date.now()
    const window = windowMs()
    let counter = counters.get(sessionId)
    if (!counter || now - counter.windowStart > window) {
      counter = { count: 0, windowStart: now }
      counters.set(sessionId, counter)
    }
    counter.count += 1
    return counter
  }

  const reset = (sessionId) => counters.delete(sessionId)
  const resetAll = () => counters.clear()

  function peek(sessionId) {
    const counter = counters.get(sessionId)
    if (!counter) return [0, 0]
    return [counter.count, Math.max(0, windowMs() - (Date.now() - counter.windowStart))]
  }

  /** 返回 { allowed, woke, count, needed, chance, roll, reason }。 */
  function check({ sessionId, isGroup = false, atMe = false } = {}) {
    const m = mode()
    if (m === MODE_NEVER) return { allowed: false, woke: false, reason: '档位为不可唤醒' }
    if (isGroup && m === MODE_PRIVATE) return { allowed: false, woke: false, reason: '群聊已被静默' }
    if (isGroup && !atMe) return { allowed: false, woke: false, reason: '群聊没被点名，不计数' }

    const counter = bump(sessionId)
    const start = startCount()
    const step = stepCount()
    const need = start + step

    if (counter.count < start) {
      return {
        allowed: false,
        woke: false,
        count: counter.count,
        needed: start,
        chance: 0,
        reason: `还差 ${start - counter.count} 次才开始掷骰`,
      }
    }

    const reached = counter.count - start + 1
    const { factor, label } = stageOf()
    const chance = Math.min(1, reached / (step + 1)) * factor
    const roll = rng()
    const woke = roll < chance
    if (woke) reset(sessionId)

    return {
      allowed: true,
      woke,
      count: counter.count,
      needed: need,
      chance: Math.round(chance * 1000) / 1000,
      roll: Math.round(roll * 1000) / 1000,
      reason:
        `第 ${counter.count} 次，概率 ${Math.round(chance * 100)}%` +
        (label && factor !== 1 ? `（${label}，系数 ${factor}）` : '') +
        (woke ? '，醒了' : '，没醒'),
    }
  }

  function statusLine(sessionId) {
    const [count, left] = peek(sessionId)
    if (count <= 0) return '没有攒唤醒次数'
    const start = startCount()
    const step = stepCount()
    if (count < start) return `攒了 ${count} 次，还差 ${start - count} 次开始掷骰（窗口剩 ${Math.round(left / 1000)} 秒）`
    const chance = Math.min(1, (count - start + 1) / (step + 1))
    return `攒了 ${count} 次，下次唤醒概率 ${Math.round(chance * 100)}%（窗口剩 ${Math.round(left / 1000)} 秒）`
  }

  return { check, reset, resetAll, peek, statusLine, mode }
}
