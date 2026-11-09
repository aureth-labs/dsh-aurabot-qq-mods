/**
 * 去套话滤镜 —— 移植自 N.E.K.O `utils/slop_filter.py`
 *
 * 只在「发给模型的历史」上改写，不动落盘的会话、也不改主人看到的原文。
 * 逻辑：
 *   1. 每条助手消息按规则统计命中次数（在原文上数，各规则互不影响）
 *   2. 第 2 次及以后才改写（repeat_threshold=2）—— 第一次出现是自然的，重复才是套话
 *   3. 候选替换词由 blake2b(坐标) 决定，前缀稳定：往后追加历史不会打乱旧消息的改写
 *   4. 改写区重叠时按规则表顺序优先；最后从右往左应用
 *   5. 围栏代码 / 行内代码 / URL 一律不动
 *
 * 这里对 N.E.K.O 的两处适配：
 *   - 规则里的 find 是 Python re 语法，`\1` 在 replace 里是反向引用；JS 用 `$1`
 *   - 每次请求都从空计数开始（N.E.K.O 是按完整对话历史累计），因为我们看到的历史
 *     本来就是完整的，累计会让同一条消息在不同轮次被改成不同的样子
 */

import { createHash } from 'node:crypto'

export const DEFAULTS = {
  enable: true,
  repeatThreshold: 2,
  rulesetVersion: 1,
  lang: 'zh',
  maxRules: 200,
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi

/** 规则缓存：pattern 字符串 → 编译后的正则（编译失败的记 null，不再重试） */
const RULE_CACHE = new Map()

function compileRule(find) {
  if (RULE_CACHE.has(find)) return RULE_CACHE.get(find)
  let compiled = null
  try {
    compiled = new RegExp(find, 'gu')
  } catch {
    try {
      compiled = new RegExp(find, 'g')
    } catch {
      compiled = null
    }
  }
  if (RULE_CACHE.size > 2000) RULE_CACHE.delete(RULE_CACHE.keys().next().value)
  RULE_CACHE.set(find, compiled)
  return compiled
}

/** Python `re` 的替换模板 → JS 的：`\1` / `\g<name>` → `$1` / `$<name>`，`\\` → `\` */
export function convertTemplate(template) {
  if (!template) return ''
  return template
    .replace(/\\g<([A-Za-z_][A-Za-z0-9_]*)>/g, '$$<$1>')
    .replace(/\\(\d{1,2})/g, '$$$1')
    .replace(/\\\\/g, '\\')
}

function prepareRules(rules) {
  const prepared = []
  for (let order = 0; order < rules.length; order += 1) {
    const rule = rules[order]
    if (!rule || typeof rule !== 'object') continue
    const pattern = rule.find
    if (typeof pattern !== 'string' || !pattern) continue
    const rawPool = rule.replace
    if (!Array.isArray(rawPool)) continue
    const pool = rawPool.filter((item) => typeof item === 'string' && item).map(convertTemplate)
    if (pool.length === 0) continue
    const compiled = compileRule(pattern)
    if (!compiled) continue
    prepared.push({ order, id: String(rule.id || pattern), name: rule.name || '', pool, compiled })
  }
  return prepared
}

/** 围栏代码块（含未闭合的最后一处） */
export function fencedCodeSpans(text) {
  const spans = []
  let fenceStart = null
  let fenceChar = ''
  let fenceLen = 0
  let offset = 0
  for (const line of text.split(/(?<=\n)/)) {
    const stripped = line.replace(/^[ \t]+/, '')
    const indent = line.length - stripped.length
    if (indent <= 3) {
      if (fenceStart === null) {
        const opening = /^(`{3,}|~{3,})/.exec(stripped)
        if (opening) {
          fenceStart = offset
          fenceChar = opening[1][0]
          fenceLen = opening[1].length
        }
      } else {
        const closing = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*(?:\\r?\\n)?$`).test(stripped)
        if (closing) {
          spans.push([fenceStart, offset + line.length])
          fenceStart = null
          fenceChar = ''
          fenceLen = 0
        }
      }
    }
    offset += line.length
  }
  if (fenceStart !== null) spans.push([fenceStart, text.length])
  return spans
}

/** 行内代码（未闭合的反引号延伸到行尾，保守保护） */
export function inlineCodeSpans(text, fencedSpans) {
  const spans = []
  let index = 0
  let fenceIndex = 0
  while (index < text.length) {
    while (fenceIndex < fencedSpans.length && fencedSpans[fenceIndex][1] <= index) fenceIndex += 1
    if (fenceIndex < fencedSpans.length && fencedSpans[fenceIndex][0] <= index && index < fencedSpans[fenceIndex][1]) {
      index = fencedSpans[fenceIndex][1]
      continue
    }
    if (text[index] !== '`') {
      index += 1
      continue
    }
    let runEnd = index + 1
    while (runEnd < text.length && text[runEnd] === '`') runEnd += 1
    const delimiter = text.slice(index, runEnd)
    const newline = text.indexOf('\n', runEnd)
    const lineEnd = newline < 0 ? text.length : newline
    const closing = text.indexOf(delimiter, runEnd)
    const end = closing < 0 || closing > lineEnd ? lineEnd : closing + delimiter.length
    spans.push([index, end])
    index = Math.max(end, runEnd)
  }
  return spans
}

/** 受保护区间：围栏代码 + 行内代码 + URL，合并重叠 */
export function protectedSpans(text) {
  const fenced = fencedCodeSpans(text)
  const spans = fenced.concat(inlineCodeSpans(text, fenced))
  URL_RE.lastIndex = 0
  let m
  while ((m = URL_RE.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length])
    if (m[0].length === 0) URL_RE.lastIndex += 1
  }
  if (spans.length === 0) return []
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const [start, end] of spans) {
    if (merged.length === 0 || start > merged[merged.length - 1][1]) merged.push([start, end])
    else if (end > merged[merged.length - 1][1]) merged[merged.length - 1][1] = end
  }
  return merged
}

function overlaps(start, end, spans) {
  for (const [s, e] of spans) if (start < e && s < end) return true
  return false
}

/**
 * 稳定选词：同样的坐标永远选到同一个候选，追加历史也不会改变旧消息的改写。
 * 对应 N.E.K.O 的 blake2b(person=b"NEKO-slop-v1")。
 *
 * ⚠ 这里必须用 sha256，不能用 blake2b512：DSH 宿主跑在 Electron 里，
 * 它裁剪过的 OpenSSL 只有 md4/md5/ripemd160/sha1/sha224/sha256/sha384/sha512/sha512-256 九种，
 * createHash('blake2b512') 会抛 `Digest method not supported`。
 * 换成 sha256 后只是选词表和 N.E.K.O 不同，确定性（前缀稳定）完全一样。
 */
export function stablePoolChoice(pool, ctx) {
  const h = createHash('sha256')
  if (ctx.person) h.update(Buffer.from(ctx.person, 'utf8'))
  const components = [
    ctx.rulesetVersion,
    ctx.lang,
    ctx.ruleId,
    ctx.ruleOrder,
    ctx.messageIndex,
    ctx.partIndex,
    ctx.occurrence,
    ctx.start,
    ctx.end,
    ctx.group0,
    ctx.textFingerprint,
  ]
  for (const component of components) {
    const encoded = Buffer.from(String(component), 'utf8')
    const len = Buffer.alloc(8)
    len.writeBigUInt64BE(BigInt(encoded.length))
    h.update(len)
    h.update(encoded)
  }
  const digest = h.digest().subarray(0, 16)
  const index = digest.readBigUInt64BE(0) % BigInt(pool.length)
  return pool[Number(index)]
}

function fingerprint(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 32)
}

/**
 * 改写一段文本。
 * @param {string} text 原文
 * @param {Array} prepared prepareRules 的产物
 * @param {object} opts { lang, rulesetVersion, repeatThreshold, messageIndex, partIndex }
 * @param {object} counters 命中规则的计数（输出）
 * @param {object} occurrences 跨 part 的累计次数（同一条消息的多个 text block 共享）
 */
export function rewriteText(text, prepared, opts, counters = {}, occurrences = {}) {
  if (!text || typeof text !== 'string') return text
  if (prepared.length === 0) return text
  const protectedList = protectedSpans(text)
  const textFingerprint = fingerprint(text)

  const candidates = []
  for (const rule of prepared) {
    rule.compiled.lastIndex = 0
    let m
    while ((m = rule.compiled.exec(text)) !== null) {
      const start = m.index
      const end = m.index + m[0].length
      if (start === end) {
        rule.compiled.lastIndex += 1
        continue
      }
      if (overlaps(start, end, protectedList)) continue
      const occurrence = (occurrences[rule.order] ?? 0) + 1
      occurrences[rule.order] = occurrence
      if (occurrence < opts.repeatThreshold) continue
      const template = stablePoolChoice(rule.pool, {
        person: 'slop-filter-v1',
        rulesetVersion: opts.rulesetVersion,
        lang: opts.lang,
        ruleId: rule.id,
        ruleOrder: rule.order,
        messageIndex: opts.messageIndex,
        partIndex: opts.partIndex,
        occurrence,
        start,
        end,
        group0: m[0],
        textFingerprint,
      })
      // 把 JS 的 $1 语义交给 String.replace 处理：这里手工展开
      let group0 = m[0]
      let replacement = expandJs(template, m)
      if (replacement === '') replacement = template
      candidates.push({ order: rule.order, start, end, replacement, id: rule.id, group0 })
    }
  }

  if (candidates.length === 0) return text

  candidates.sort((a, b) => a.order - b.order || a.start - b.start || a.end - b.end)
  const accepted = []
  for (const c of candidates) {
    if (accepted.some((k) => c.start < k.end && k.start < c.end)) continue
    accepted.push(c)
  }
  if (accepted.length === 0) return text

  accepted.sort((a, b) => b.start - a.start)
  let out = text
  for (const c of accepted) {
    out = out.slice(0, c.start) + c.replacement + out.slice(c.end)
    counters[c.id] = (counters[c.id] ?? 0) + 1
  }
  return out
}

/** 展开 `$1` / `$<name>` / `$$` —— 只支持数字和命名分组，够用 */
function expandJs(template, match) {
  return template.replace(/\$(\$|\d{1,2}|<[A-Za-z_][A-Za-z0-9_]*>)/g, (whole, token) => {
    if (token === '$') return '$'
    if (token.startsWith('<')) {
      const name = token.slice(1, -1)
      const groups = match.groups
      return groups && groups[name] !== undefined ? groups[name] : whole
    }
    const index = Number(token)
    return match[index] !== undefined ? match[index] : whole
  })
}

/** 加载规则文件，返回编译好的规则表 + 元信息 */
export function loadRules(raw) {
  const rules = Array.isArray(raw?.rules) ? raw.rules : []
  return {
    prepared: prepareRules(rules),
    rulesetVersion: raw?.ruleset_version ?? 1,
    repeatThreshold: raw?.repeat_threshold ?? 2,
    total: rules.length,
  }
}

export function countRules(prepared) {
  return prepared.length
}
