// 从一条 QQ 消息里认出 LaTeX：$$…$$ / \[…\] / \(…\) / $…$，
// 或者「latex x^2」「渲染 x^2」这种整句写法。
// 这里只有纯函数，方便 test/ 里直接测。

const DELIMS = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
]

// 打头那几个词是「我要你渲染」的口令，剥掉再判断剩下的是不是公式
export const DEFAULT_TRIGGERS = ['latex', 'tex', 'math', '公式', '渲染', '排版']

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 面板里填的触发词（"latex,公式,渲染"）洗成数组；空的就用默认那几个。 */
export function parseTriggers(words) {
  const raw = Array.isArray(words) ? words : String(words ?? '').split(/[,，、;；\s]+/)
  const list = raw.map((w) => String(w).trim().toLowerCase()).filter(Boolean)
  return list.length ? list : DEFAULT_TRIGGERS.slice()
}

/** 这条消息里有没有触发词（不区分大小写）。 */
export function hasTrigger(text, words) {
  const s = String(text ?? '').toLowerCase()
  return parseTriggers(words).some((w) => s.includes(w))
}

export function stripTrigger(text, words) {
  const re = new RegExp('^\\s*(?:' + parseTriggers(words).map(escapeRe).join('|') + ')\\s*[:：]?\\s*', 'i')
  return String(text ?? '').replace(re, '').trim()
}

/**
 * 「把公式渲染一下 x^2+1」这种：触发词不在开头，就切到最后一个触发词之后，
 * 再把「一下 / 这个 / 下面」这类虚词削掉，剩下的当公式。
 */
export function cutAroundTrigger(text, words) {
  const s = String(text ?? '')
  const low = s.toLowerCase()
  let cut = -1
  for (const w of parseTriggers(words)) {
    const at = low.lastIndexOf(w)
    if (at >= 0 && at + w.length > cut) cut = at + w.length
  }
  if (cut < 0) return s.trim()
  return s
    .slice(cut)
    .replace(/^[\s:：,，。.、]*(?:一下|这个|这些|这段|这句|下面|上面|公式|表达式|式子|以下|的|吧|呗|呗)*[\s:：,，。.、]*/, '')
    .trim()
}

/** 找出一段文字里所有公式。返回 { formulas: [{ latex, display }], rest }，rest 是去掉公式后剩下的字。 */
export function extractFormulas(text) {
  const src = String(text ?? '')
  const formulas = []
  let rest = ''
  let i = 0
  while (i < src.length) {
    const hit = openAt(src, i)
    const from = hit ? i + hit.open.length : -1
    const to = hit ? closeAt(src, from, hit.close) : -1
    if (!hit || to < 0) {
      rest += src[i]
      i += 1
      continue
    }
    const latex = src.slice(from, to).trim()
    if (latex) formulas.push({ latex, display: hit.display })
    rest += ' '
    i = to + hit.close.length
  }
  return { formulas, rest: rest.replace(/[ \t]+/g, ' ').trim() }
}

function openAt(src, i) {
  const c = src[i]
  if (c === '\\') {
    if (src[i - 1] === '\\') return null // \\[ 是换行之后的 [
    if (src.startsWith('\\[', i)) return DELIMS[1]
    if (src.startsWith('\\(', i)) return DELIMS[2]
    return null
  }
  if (c !== '$') return null
  if (src[i - 1] === '\\') return null // \$ 是转义，不是公式开头
  if (src.startsWith('$$', i)) return DELIMS[0]
  return DELIMS[3]
}

function closeAt(src, from, close) {
  if (close !== '$') return src.indexOf(close, from)
  for (let k = from; k < src.length; k++) {
    if (src[k] !== '$' || src[k - 1] === '\\') continue
    if (src[k + 1] === '$') return -1 // 撞上 $$ 了，这个 $ 不算收尾
    return k
  }
  return -1
}

/**
 * 整句当公式时先过这一关：有命令（\frac）或上下标（^ _）才算，
 * 免得把「3+5=8 对吗」这种口算也画成图片；带中文的一律不当公式。
 */
export function looksLikeLatex(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (!/\\[A-Za-z]+/.test(s) && !/[\^_]/.test(s)) return false
  const withoutText = s.replace(/\\text\{[^{}]*\}/g, '')
  return !/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(withoutText)
}

/** 发出去之前先自己查一遍括号，省得让渲染服务画一张红叉图回来。返回空串表示没问题。 */
export function validateLatex(text) {
  const s = String(text ?? '').trim()
  if (!s) return '公式是空的'
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i += 1 // 跳过一个被转义的字符（\{ \} 之类）
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth < 0) return '括号不配对：多了一个 }'
    }
  }
  if (depth > 0) return '括号不配对：少了一个 }'
  if (/\\$/.test(s)) return '结尾有个没写完的命令'
  return ''
}
