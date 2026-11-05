// 表情检索：跟 Aurabot 自带的 matchSticker（只看名字 / 标签、逐条包含）不一样，
// 这里把表情包知识库里的 desc（画面）、meme（梗出处）、use（用在什么场合）、emotion（情绪）也算进来，
// 中文还带二元组兜底 —— 所以「想躺平又不敢」这种绕着说的话也能落到某一张上。
//
// 打分口径照原作者那套（weight 一致，标点切词一致），出处见本目录 NOTICE。

const WEIGHTS = [
  ['name', 6],
  ['tagsJoined', 5],
  ['emotion', 4],
  ['meme', 3],
  ['use', 3],
  ['text', 3],   // 图上本身写的字（「V我50」「快跑！」）：搜索命中率很高
  ['dir', 2],
  ['desc', 1],
  ['en', 1],     // 英文描述：中英混搜时兜底
]

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u

export function terms (query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，。.!！?？、;；:：/|]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
}

function bigrams (s) {
  const out = []
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2))
  return out
}

/** 把一条表情库记录摊成待匹配的字段，全部小写。 */
export function fields (item) {
  return {
    name: String(item.name || '').toLowerCase(),
    tagsJoined: (item.tags || []).join(' ').toLowerCase(),
    emotion: String(item.emotion || '').toLowerCase(),
    meme: String(item.meme || '').toLowerCase(),
    use: String(item.use || item.summary || '').toLowerCase(),
    text: String(item.text || '').toLowerCase(),
    dir: String(item.dir || '').toLowerCase(),
    desc: String(item.desc || '').toLowerCase(),
    en: String(item.en || '').toLowerCase(),
  }
}

export function scoreFields (f, qs) {
  let total = 0
  let matched = 0
  for (const q of qs) {
    let best = 0
    for (const [key, w] of WEIGHTS) {
      const v = f[key]
      if (!v) continue
      if (v.includes(q)) best = Math.max(best, w * (v === q ? 1.5 : 1))
      else if (CJK.test(q) && q.length > 2) {
        const bg = bigrams(q)
        const hit = bg.filter((b) => v.includes(b)).length
        if (hit) best = Math.max(best, ((w * hit) / bg.length) * 0.8)
      }
    }
    total += best
    if (best > 0) matched++
  }
  // 多个词都命中的优先，只命中一个词的就算单条分很高也压下去
  return qs.length > 1 ? total * (matched / qs.length) ** 2 : total
}

/**
 * 在整库上检索。
 * @param {Array} items 表情库记录
 * @param {string} query 情绪词 / 场景描述
 * @param {{limit?:number, emotion?:string, minScore?:number}} opts
 */
export function search (items, query, opts = {}) {
  const qs = terms(query)
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 5))
  const pool = opts.emotion
    ? items.filter((i) => String(i.emotion || '').includes(String(opts.emotion)))
    : items
  if (!qs.length) {
    const shuffled = pool.slice()
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled.slice(0, limit).map((item) => ({ item, score: 0 }))
  }
  const minScore = opts.minScore ?? 1.5
  const hits = []
  for (const item of pool) {
    const s = scoreFields(fields(item), qs)
    if (s >= minScore) hits.push({ item, score: s })
  }
  hits.sort((a, b) => b.score - a.score)
  if (hits.length || opts.loose === false) return hits.slice(0, limit)

  // 整句对不上时放宽一次：「想躺平又不敢」这种口语描述很少整串出现在标注里，
  // 拆成所有二字窗口分别去碰，按命中的比例排。只是兜底，宁缺毋滥。
  const loose = []
  for (const q of qs) {
    if (CJK.test(q) && q.length > 2) loose.push(...bigrams(q))
    else if (q) loose.push(q)
  }
  if (!loose.length) return []
  const scored = []
  for (const item of pool) {
    const f = fields(item)
    let hit = 0
    for (const t of loose) {
      for (const [key, w] of WEIGHTS) {
        const v = f[key]
        if (v && v.includes(t)) {
          hit += w / 10
          break
        }
      }
    }
    const ratio = hit / loose.length
    if (hit > 0) scored.push({ item, score: ratio * 10 + hit })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** 情绪分类计数：给「最近是不是老发难过」这类判断用。 */
export function emotionCounts (items) {
  const out = new Map()
  for (const it of items) {
    const e = String(it.emotion || '').trim()
    if (!e) continue
    out.set(e, (out.get(e) || 0) + 1)
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1])
}

/** 给模型看的一行：名字｜情绪｜用途。 */
export function line (item, detail) {
  const bits = [item.name || '未命名']
  if (item.emotion) bits.push(item.emotion)
  if (detail === 'full') {
    if (item.use || item.summary) bits.push(item.use || item.summary)
    if (item.dir) bits.push(item.dir)
    if (item.meme) bits.push('梗：' + String(item.meme).slice(0, 80))
    return bits.join('｜')
  }
  const tags = (item.tags || []).slice(0, 4).join('/')
  return bits.join('｜') + (tags ? '｜' + tags : '')
}
