/**
 * 遗忘：让记忆自己淡下去，而不是一直堆着。
 *
 * 仿人记忆的路子——不是到点就删，而是**强度慢慢衰减**，
 * 越久没被想起、越不重要，强度掉得越快；掉到一定程度先转"休眠"，
 * 再掉到一个更低的值才"归档"（压缩成一行的摘要留在库里，正文丢掉）。
 *
 * 几个原则：
 *   1. 置顶的永不动
 *   2. 机密的不自动归档（怕误删要紧事，交给人自己决定）
 *   3. 只降级，不删库。想彻底清掉得自己调 purge()
 *   4. 每次调用都是纯计算，不改数据；要改就传 apply: true
 */

/** 一天多少毫秒 */
const DAY = 86400000

/**
 * 算一条记忆的当前强度，0~1 之间。
 *
 * 走的是「遗忘曲线」的变形：
 *   strength = importance × e^(-经过天数 / 半衰期) + 命中加成
 *
 * 半衰期看重要度：重要的忘得慢。
 *   importance 0    -> 7 天掉一半
 *   importance 0.5  -> 30 天掉一半
 *   importance 1    -> 90 天掉一半
 *
 * 每被用到一次，就在当下的强度上加点分（封顶 0.4），
 * 相当于"想起来一次就更牢一点"。
 */
export function strengthOf(item, now = Date.now()) {
  if (!item) return 0
  if (item.pin) return 1

  const imp = typeof item.importance === 'number' ? Math.min(1, Math.max(0, item.importance)) : 0.5
  const halfLifeDays = 7 + imp * 83          // 7 ~ 90 天
  const lastSeen = item.lastHit || item.at || now
  const days = Math.max(0, (now - lastSeen) / DAY)

  const base = imp * Math.exp((-days * Math.LN2) / halfLifeDays)

  // 命中加成：被用过几次就更牢，但不会超过 0.4
  const hitBoost = Math.min(0.4, (item.hits || 0) * 0.03 + (item.hitDays || 0) * 0.05)

  return Math.min(1, base + hitBoost)
}

/** 强度对应的状态 */
export function stateOf(strength, thresholds = {}) {
  const sleep = thresholds.sleep ?? 0.12
  const archive = thresholds.archive ?? 0.04
  if (strength <= archive) return 'archived'
  if (strength <= sleep) return 'sleeping'
  return 'active'
}

/**
 * 扫一遍库，算出该降级的。
 * 默认只算不改（apply=false），返回清单给人看。
 */
export function decay(store, { apply = false, thresholds = {}, now = Date.now(), byDays = false, days = 90 } = {}) {
  const report = { active: 0, sleeping: 0, archived: 0, changed: [], kept: 0 }

  // 按天数模式：不看重要度，只看多久没被想起
  // 淡出期 = days，归档期 = days * 2
  const fadeMs = Math.max(1, days) * DAY
  const archiveMs = fadeMs * 2

  for (const item of store.all()) {
    // 置顶的、机密的一律不动
    if (item.pin) { report.kept++; continue }
    if (item.cls === 'secret') { report.kept++; continue }

    let want
    let s
    if (byDays) {
      const lastSeen = item.lastHit || item.at || now
      const age = now - lastSeen
      s = Math.max(0, 1 - age / archiveMs)
      want = age >= archiveMs ? 'archived' : age >= fadeMs ? 'sleeping' : 'active'
    } else {
      s = strengthOf(item, now)
      want = stateOf(s, thresholds)
    }
    const cur = item.state || 'active'

    if (want === 'archived') report.archived++
    else if (want === 'sleeping') report.sleeping++
    else report.active++

    // 只降不升：已经休眠的不会被"升"回正常，除非被命中过（touch 会自己改）
    if (rank(want) > rank(cur)) {
      report.changed.push({ id: item.id, text: (item.text || '').slice(0, 40), from: cur, to: want, strength: Math.round(s * 1000) / 1000 })
      if (apply) {
        const patch = { state: want, stateAt: now }
        // 归档的留一行摘要，正文压缩掉，别把整段话一直存着
        if (want === 'archived') {
          const brief = (item.text || '').slice(0, 60)
          patch.brief = brief
          patch.text = brief
          patch.archivedFrom = (item.text || '').length
        }
        store.update(item.id, patch)
      }
    }
  }

  report.total = store.stats().total
  return report
}

function rank(state) {
  return state === 'archived' ? 2 : state === 'sleeping' ? 1 : 0
}

/**
 * 真正删掉长期归档的。这一步不可逆，自己确认了再调。
 */
export function purgeArchived(store, { olderThanDays = 180, now = Date.now() } = {}) {
  const cut = now - olderThanDays * DAY
  const gone = []
  for (const item of store.all()) {
    if (item.state !== 'archived') continue
    if (item.pin) continue
    if (item.cls === 'secret') continue
    if ((item.stateAt || item.at || now) > cut) continue
    gone.push(item.id)
  }
  for (const id of gone) store.remove(id)
  return { removed: gone.length, ids: gone }
}
