/**
 * 加权抽取与冷却：纯函数，方便单测。
 *
 * 参考项目用「权重 / 所有权重之和」决定触发概率，这里保持同样的语义：
 * 权重为 0 的动作永远不被抽中（相当于关闭），所有动作权重都为 0 时返回 null。
 */

/**
 * 按权重随机选一个。
 * @template T
 * @param {{ id: string, weight: number }[]} items 候选项（weight 已归一化为非负数）
 * @param {() => number} [random] 注入随机源，单测用；默认 Math.random
 * @returns {string | null} 被选中项的 id；没有可选项时返回 null
 */
export function pickWeighted(items, random = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return null
  const usable = items.filter((it) => typeof it.weight === 'number' && it.weight > 0)
  if (usable.length === 0) return null
  const total = usable.reduce((s, it) => s + it.weight, 0)
  let r = random() * total
  for (const it of usable) {
    r -= it.weight
    if (r < 0) return it.id
  }
  // 浮点误差兜底：落到最后一个
  return usable[usable.length - 1].id
}

/**
 * 每个动作在总权重里的占比，用于面板展示和「概率」提示。
 * @param {{ id: string, weight: number }[]} items
 * @returns {Record<string, number>} id → 0~1 的概率
 */
export function weightsToProbabilities(items) {
  if (!Array.isArray(items) || items.length === 0) return {}
  const total = items.reduce((s, it) => s + (it.weight > 0 ? it.weight : 0), 0)
  /** @type {Record<string, number>} */
  const out = {}
  for (const it of items) {
    out[it.id] = total > 0 && it.weight > 0 ? it.weight / total : 0
  }
  return out
}

/**
 * 带 TTL 的冷却表：同一个 key 在窗口内只允许通过一次。
 *
 * 与参考项目 poke_cd 的语义一致：冷却期内忽略该用户的戳。
 * 用 `now` 注入时钟，避免测试依赖真实时间。
 *
 * @param {number} ttlMs 冷却窗口
 * @param {() => number} [now]
 */
export function createCooldown(ttlMs, now = Date.now) {
  /** @type {Map<string, number>} */
  const hits = new Map()
  return {
    /** 这个冷却窗口的长度（毫秒）。改设置时用来判断要不要换新的表。 */
    ttlMs,
    /** 这个 key 现在是否还在冷却。 */
    cooling(key) {
      const last = hits.get(key)
      return last !== undefined && now() - last < ttlMs
    },
    /** 记录一次命中并返回 true；若仍在冷却返回 false 且不刷新时间。 */
    hit(key) {
      if (this.cooling(key)) return false
      hits.set(key, now())
      return true
    },
    /** 剩余冷却毫秒数（已过冷却返回 0）。 */
    remaining(key) {
      const last = hits.get(key)
      if (last === undefined) return 0
      return Math.max(0, ttlMs - (now() - last))
    },
    /** 清空（改配置后重置用）。 */
    clear() { hits.clear() },
    /** 清掉某个 key。 */
    forget(key) { hits.delete(key) },
    size() { return hits.size },
  }
}

/**
 * 从 `群号:QQ号` 形式的字符串解析定时戳目标。
 * 格式不对的条目被丢弃，而不是让整个定时任务报错。
 * @param {string[]} list
 * @returns {{ groupId: number, userId: number }[]}
 */
export function parsePokeTargets(list) {
  if (!Array.isArray(list)) return []
  /** @type {{ groupId: number, userId: number }[]} */
  const out = []
  for (const raw of list) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    const m = text.match(/^(\d+)\s*[:：,]\s*(\d+)$/)
    if (!m) continue
    const groupId = Number(m[1])
    const userId = Number(m[2])
    if (!Number.isFinite(groupId) || !Number.isFinite(userId) || groupId <= 0 || userId <= 0) continue
    out.push({ groupId, userId })
  }
  return out
}
