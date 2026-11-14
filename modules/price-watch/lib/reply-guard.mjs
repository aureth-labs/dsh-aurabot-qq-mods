// 她偶尔把工具调用当成普通文字发出来（<price_query><query>拓竹 A1</query>），
// 这种标记会原样进 QQ。这里在发出去之前拦下来：
//   1. 把调用标记从正文里剥掉；
//   2. 只读查询（查价 / 看列表 / 立即检查）顺手替她执行，把结果补进正文——
//      模型本来就想查，只是写法错了，不该让她干等或者现编一个价。
//   3. 写操作（加监控）不代执行，只剥标记并留一句说明，免得群友借文字触发写入。
//
// 只认本模块自己的工具名，别的模块 / 别的标记一律不碰。

export const READ_TOOLS = new Set(['price_query', 'price_watch_list', 'price_watch_check'])

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 从一段文字里找出本模块的工具调用（含参数），返回剥离后的正文和调用列表。
 * 支持 <price_query><query>X</query></price_query> 和 <price_query>X</price_query> 两种写法。
 */
export function extractToolCalls (text, names = READ_TOOLS, allNames = null) {
  const raw = String(text || '')
  const known = [...new Set([...(names || []), ...(allNames || [])])].filter(Boolean)
  if (!raw || !known.length) return { clean: raw, calls: [] }
  const calls = []
  let clean = raw
  for (const name of known) {
    const n = escapeRe(name)
    // 成对写法：<name> ... </name>，中间可以是 <param>值</param> 或裸值
    const paired = new RegExp('<' + n + '\\b[^>]*>([\\s\\S]*?)<\\/\\s*' + n + '\\s*>', 'gi')
    clean = clean.replace(paired, (whole, inner) => {
      calls.push({ name, args: parseArgs(inner), raw: whole })
      return ''
    })
    // 开始标签没闭合（模型写到一半就断了）：<price_query> <query>拓竹 A1</query>
    const unclosed = new RegExp('<' + n + '\\b[^>]*>', 'gi')
    clean = clean.replace(unclosed, (whole) => {
      calls.push({ name, args: {}, raw: whole, unclosed: true })
      return ''
    })
    // 自闭合 / 只有开始标签：<name:值> 或 <name/>
    const single = new RegExp('<' + n + '\\s*[:：]\\s*([^<>]*)>', 'gi')
    clean = clean.replace(single, (whole, value) => {
      calls.push({ name, args: { query: String(value).trim() }, raw: whole })
      return ''
    })
    const selfClose = new RegExp('<' + n + '\\s*/?>', 'gi')
    clean = clean.replace(selfClose, () => '')
  }
  // 剩下没配对的 <query>…</query>：只在已经认出调用时清掉，避免误删正常文字
  if (calls.length) {
    clean = clean.replace(/<\s*query\s*>([\s\S]*?)<\/\s*query\s*>/gi, (whole, value) => {
      if (!calls.some((call) => call.args && call.args.query)) {
        const owner = calls.find((call) => !call.args || !Object.keys(call.args).length)
        if (owner) owner.args = { ...(owner.args || {}), query: String(value).trim() }
      }
      return ''
    })
  }
  return { clean: clean.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？])/g, '$1').trim(), calls }
}

/** 参数区：<query>值</query> 取键值；没有标签就把整段当 query。 */
export function parseArgs (inner) {
  const out = {}
  const text = String(inner || '')
  let matched = false
  for (const m of text.matchAll(/<\s*([a-zA-Z_][\w-]*)\s*>([\s\S]*?)<\/\s*\1\s*>/g)) {
    out[m[1].toLowerCase()] = String(m[2]).trim()
    matched = true
  }
  if (!matched) {
    const bare = text.replace(/<[^>]+>/g, '').trim()
    if (bare) out.query = bare
  }
  return out
}

/** 剥完之后是不是「什么都没说」的残句（只剩标点 / 空格 / 一句等结果）。 */
export function looksLikeEmpty (text) {
  const t = String(text || '')
    .replace(/<face:[^>]*>|<sticker:[^>]*>|<at:[^>]*>/gi, '')
    .replace(/\s+/g, '')
    .replace(/[，,。.、；;：:！!？?~～…\-—]/g, '')
  if (!t) return true
  // 「等结果」「马上查」「稍等」这类占位句：模型以为自己在调用，其实什么都没发
  return /^(等|稍等|等等|马上|这就|我查|查一下|我来查|马上查|等结果|等结果出来再说|正在查)/.test(t) && t.length <= 16
}

export default { READ_TOOLS, extractToolCalls, parseArgs, looksLikeEmpty }
