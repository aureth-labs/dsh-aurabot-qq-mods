// 动作包裹解析：把 *动作* / ((动作)) / 〖动作〗 / //动作// 从消息里拆出来。
// 纯函数，不碰状态，方便单测。

export const FORMATS = {
  star: {
    key: 'star',
    label: '*动作*',
    pure: /^\*([^*\n]{1,300})\*$/,
    inline: /\*([^*\n]{1,300})\*/g,
  },
  'double-paren': {
    key: 'double-paren',
    label: '((动作))',
    pure: /^\(\(([\s\S]{1,300}?)\)\)$/,
    inline: /\(\(([\s\S]{1,300}?)\)\)/g,
  },
  'corner-paren': {
    key: 'corner-paren',
    label: '〖动作〗',
    pure: /^〖([^〗\n]{1,300})〗$/,
    inline: /〖([^〗\n]{1,300})〗/g,
  },
  slash: {
    key: 'slash',
    label: '//动作//',
    pure: /^\/\/([^/\n]{1,300})\/\/$/,
    inline: /\/\/([^/\n]{1,300})\/\//g,
  },
}

export const DEFAULT_FORMATS = Object.keys(FORMATS)

/** 'star,slash' → ['star','slash']；空 = 全部。未知 key 忽略。 */
export function normalizeFormats(input, fallback = DEFAULT_FORMATS) {
  const list = String(input || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  const picked = list.filter((k) => FORMATS[k])
  return picked.length ? picked : [...fallback]
}

const URL_RE = /^https?:\/\/\S+$/i

/**
 * 解析一条消息。
 * 返回 { actions: [{ text, kind: 'pure'|'inline', wrapper }], speech, segments }
 * - 先按 ||| 切段（她/主人的多段消息习惯）
 * - 整段被包裹 = 纯动作；段内夹杂 = 抽出行内动作，剩下的是台词
 * - 纯链接段不解析
 */
export function parseMessage(input, { formats = DEFAULT_FORMATS, maxAction = 300 } = {}) {
  const text = String(input || '')
  const keys = normalizeFormats(formats.join ? formats.join(',') : formats)
  const wrappers = keys.map((k) => FORMATS[k]).filter(Boolean)
  const segments = text
    .split('|||')
    .map((x) => x.trim())
    .filter(Boolean)

  const actions = []
  const speechParts = []

  for (const seg of segments) {
    if (!seg) continue
    if (URL_RE.test(seg)) {
      speechParts.push(seg)
      continue
    }

    let pure = null
    for (const w of wrappers) {
      const m = seg.match(w.pure)
      if (m && m[1] && m[1].trim()) {
        pure = { text: m[1].trim().slice(0, maxAction), wrapper: w.key }
        break
      }
    }
    if (pure) {
      actions.push({ ...pure, kind: 'pure' })
      continue
    }

    // 先保护 URL：把链接换成占位符，解析完再换回来（否则 https://x/a*b*c 里的 * 会被当动作）
    const urls = []
    let rest = seg.replace(/https?:\/\/\S+/gi, (u) => {
      urls.push(u)
      return `\u0000URL${urls.length - 1}\u0000`
    })
    for (const w of wrappers) {
      rest = rest.replace(w.inline, (_full, inner) => {
        const t = String(inner || '').trim()
        if (t) actions.push({ text: t.slice(0, maxAction), wrapper: w.key, kind: 'inline' })
        return ''
      })
    }
    rest = rest.replace(/\s{2,}/g, ' ').trim()
    rest = rest.replace(/\u0000URL(\d+)\u0000/g, (_m, i) => urls[Number(i)] || '')
    if (rest) speechParts.push(rest)
  }

  return { actions, speech: speechParts.join(' '), segments }
}

/** 动作强度（用于睡眠期间的模糊体感残留）：长度 + 关键词加权，10~30。 */
const WORDY = /抱|搂|亲|摸|按|拉|扯|掀|褪|压|骑|坐|跪|塞|插|撞|舔|咬|揉|捏|拍|打|蹭|抱紧|搂住|抱住/
export function actionWeight(action) {
  const t = String(action?.text || '')
  let w = 10
  if (t.length >= 6) w += 4
  if (t.length >= 14) w += 4
  if (WORDY.test(t)) w += 8
  return Math.max(5, Math.min(30, w))
}
