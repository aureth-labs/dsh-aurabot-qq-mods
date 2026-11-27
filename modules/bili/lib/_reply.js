// B站模块内联的回复清洗：从 Aurabot 插件 src/chat/reply.js 搬来。
// 独立模块拿不到插件的提示词状态（promptSources / toolTextRanges），
// 所以只保留「去 Markdown / 去工具文字 / 判沉默」这部分，去掉提示词复读检测。
// 对 B站 的用途（清洗评论、弹幕、签名、鱼日记）够用。

export const SILENCE = '[沉默]'

/** 去掉 Markdown 痕迹，保留文字本身。 */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 是不是「这次不说话」。 */
export function isSilence(text) {
  const t = String(text || '').trim()
  return !t || t === SILENCE || t === '（沉默）' || t === '(沉默)'
}

/**
 * 工具调用的文字痕迹：模型有时会把 `<tool>…</tool>` 之类写进正文。
 * 只处理成对标签，避免误删正文里的尖括号。
 */
const TOOL_TAG_RE = /<(?:tool|tool_call|function_calls?|invoke|antml:invoke)\b[^>]*>[\s\S]*?<\/(?:tool|tool_call|function_calls?|invoke|antml:invoke)>/gi

export function stripToolText(text) {
  return String(text || '').replace(TOOL_TAG_RE, '')
}

/** 去掉不可见内容后判断是不是空。 */
function visibleContent(text) {
  const content = stripMarkdown(text)
    .replace(/<\/?(?:voice|reply|at|poke|sticker|face)\b[^>]*>/gi, '')
    .replace(/[@＠][^\s@＠<>|｜]+/g, '')
    .replace(/\|\|\|/g, '')
    .trim()
  return isSilence(content) ? '' : content.replace(/^[\s\p{P}]*|[\s\p{P}]*$/gu, '').trim()
}

/**
 * 出口清洗：去工具文字 + 去 Markdown 残留，整条只剩符号就当沉默。
 * 签名与插件版不同：不检测「提示词复读」（那需要插件的提示词快照，独立模块拿不到）。
 */
export function cleanOutboundText(text, { warn } = {}) {
  const raw = String(text || '')
  let clean = stripToolText(raw)
  if (clean !== raw && isSilence(visibleContent(clean))) {
    warn?.('模型输出整段都是工具调用文字，已拦下并按沉默处理')
    clean = ''
  }
  return clean
}

/** 按行拆，去掉空行。 */
export function splitLines(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)
}
