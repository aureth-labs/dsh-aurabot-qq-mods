// 本地轻量语义打分器：中文 2-gram + 英文/数字词的词频余弦相似度。
// 来源：本模块原创；作用：给记忆条目和当前话题算相关度，替代远程 embedding 接口（零成本）。
// 契约：纯函数、无副作用、不打网络；导出见文件尾。

// 归一化：小写、去标点/空白。中文、日文假名、韩文都保留。
function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9]+/gu, ' ')
}

// 切词：连续的 CJK 段切成 2-gram（单字段保留单字），拉丁/数字段按连续串切。
export function tokenize(text) {
  const out = []
  for (const seg of normalize(text).split(' ')) {
    if (!seg) continue
    if (/^[a-z0-9]+$/.test(seg)) { out.push(seg); continue }
    // 单字 + 2-gram 都要：只留 2-gram 时短句经常一个重茬都碰不上，召回太差
    for (const ch of seg) out.push(ch)
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
  }
  return out
}

// 词频向量（Map：token -> 次数）
function counts(tokens) {
  const m = new Map()
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1)
  return m
}

// 余弦相似度：两个 Map 词频向量；任一为空返回 0。
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (const [, n] of a) na += n * n
  for (const [t, n] of b) { nb += n * n; const x = a.get(t); if (x) dot += x * n }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// 估算一段文字的 token 数：CJK 字 ≈ 0.6 token/字，其余非空白字符 ≈ 0.3 token/字符。
// 只用于预算裁剪与记账（误差 ±20% 量级），不标榜精确。
export function estTokens(text) {
  const s = String(text || '')
  let cjk = 0
  for (const ch of s) if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++
  const other = s.replace(/\s/g, '').length - cjk
  return Math.max(1, Math.round(cjk * 0.6 + Math.max(0, other) * 0.3))
}

// 一条记忆的查询文本：正文 + 标签 + 关于谁（拼在一起算相似度）
const itemText = (it) => [it?.text, ...(Array.isArray(it?.tags) ? it.tags : []), it?.aboutName || ''].join(' ')

// 记忆条目是否在有效期内（validFrom / validUntil，缺省视为一直有效）
export function inValidity(it, now = Date.now()) {
  const from = Number(it?.validFrom) || 0
  const until = Number(it?.validUntil) || Infinity
  return (!from || from <= now) && until > now
}

// 给一条记忆打分：语义相似度为主，重要度加权，同聊天命中小幅加成。
// 返回 [0, ∞) 的分值；不在有效期的条目直接 0。
export function scoreItem(it, queryText, opts = {}) {
  if (!it || !inValidity(it, opts.now)) return 0
  const q = counts(tokenize(queryText))
  const sim = q.size ? cosine(q, counts(tokenize(itemText(it)))) : 0
  if (sim <= 0) return 0
  const importance = 0.7 + 0.6 * (Number(it?.importance) || 0.5) // 0.85 ~ 1.0
  const chatBonus = opts.chatId && String(it?.chatId || '') === String(opts.chatId) ? 1.15 : 1
  return sim * importance * chatBonus
}

// 从记忆条目里挑最相关的 top-K；分数为 0（不相关/过期）的不进榜。稳定排序：同分按原文顺序。
export function topK(items, queryText, k = 16, opts = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map((it, i) => ({ it, i, score: scoreItem(it, queryText, opts) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
  return list.slice(0, Math.max(0, k)).map((x) => x.it)
}
