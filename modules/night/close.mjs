// 收线识别：只靠关键词会误判（「他昨天跟我说晚安了」不是要睡），所以先过句式，句式过了才认。
// 同时负责「对方是不是在收线」，和 wake 是相反方向的同一件事。

export const STRONG = [
  '晚安', '我睡了', '睡了', '去睡了', '先睡一步', '我下了', '下线了',
  '关灯了', '撑不住了', '困死了', '睡觉去', '睡啦', 'good night', 'night night',
  // 祈使型：叫对方（BOT）去睡。2026-11-24 补——原来只有「睡觉去」，
  // 「你去睡觉吧」「去睡吧」「早点睡」这些最常说的反而一个都没命中。
  '睡觉吧', '去睡吧', '该睡了', '早点睡', '快去睡', '睡觉啦',
]

export const MEDIUM = [
  '先这样', '回头聊', '有空再聊', '去忙了', '忙去了', '拜拜', 'bye',
  '886', '午安', '午休了', '眯一会儿', '打个盹', '躺会儿', '先撤',
]

export const WEAK = ['嗯', '好', '行', '收到', 'ok', '知道了', '就这样', '没别的事了']

const FIRST_PERSON = ['我', '咱', '俺', '在下']
const THIRD_PERSON = ['他说', '她说', '他说过', '她说过', '跟我说', '跟你说了', '他昨天', '她昨天']
const QUESTION_TAIL = ['吗', '？', '?', '呢', '什么时候', '几点了', '在哪']
const NOUN_AFTER = ['曲', '歌', '片', '剧', '书', '会', '餐', '班', '店', '场', '服', '舞']

const words = (list, fallback) => {
  const arr = Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : []
  return arr.length ? arr : fallback
}

export function matchStrength(text, cfg = {}) {
  const body = String(text || '').trim()
  if (!body) return ['', '']
  const lowered = body.toLowerCase()
  const strong = words(cfg.closeStrong, STRONG)
  const medium = words(cfg.closeMedium, MEDIUM)
  const weak = words(cfg.closeWeak, WEAK)
  for (const word of strong) if (lowered.includes(word.toLowerCase())) return ['strong', word]
  for (const word of medium) if (lowered.includes(word.toLowerCase())) return ['medium', word]
  for (const word of weak) if (lowered.includes(word.toLowerCase())) return ['weak', word]
  return ['', '']
}

const looksLikeNarration = (text) => THIRD_PERSON.some((m) => text.includes(m))

const looksLikeQuestion = (text) => {
  const body = String(text || '').trim()
  if (!body) return false
  if (['?', '？', '吗', '呢'].some((tail) => body.endsWith(tail))) return true
  return QUESTION_TAIL.some((tail) => body.endsWith(tail))
}

function isShortAndBare(text, word) {
  const body = String(text || '').trim()
  const core = body.replace(word, '')
  return core.replace(/[\s，,。.!！~～、]+/g, '').length <= 6
}

function isNounUsage(text, word) {
  const index = text.indexOf(word)
  if (index < 0) return false
  const after = text.slice(index + word.length, index + word.length + 1)
  return Boolean(after) && NOUN_AFTER.includes(after)
}

// 「我们家狗」「我家猫」这类是领属词，不是主语
const POSSESSIVE = ['我们家', '我家', '咱家', '俺家']
// 明确在说别人（第三人称 / 宠物）去睡，跟 BOT 无关
const OTHER_SUBJECT = ['他', '她', '它', '狗', '猫', '爸', '妈', '哥', '姐', '弟', '妹', '朋友', '室友', '同事', '老板']

/**
 * 这句话是不是在说「别人」要睡？
 *
 * 只排第三人称/宠物，**不排第二人称**：
 *   「你去睡觉吧」「各回各房睡觉去」都是在安排 BOT 去睡，属于该睡的收线。
 *   （2026-11-24 曾误写成「主语不是说话人就不算」，把「你去睡觉吧」判成拒绝，是错的。）
 */
function isOtherPersonSleep(body, word) {
  const idxWord = body.indexOf(word)
  if (idxWord < 0) return false
  let before = body.slice(0, idxWord)
  for (const p of POSSESSIVE) before = before.split(p).join('　')
  let lastPos = -1
  let isOther = false
  const consider = (list, other) => {
    for (const m of list) {
      const i = before.lastIndexOf(m)
      if (i > lastPos) { lastPos = i; isOther = other }
    }
  }
  consider(['我', '咱', '俺', '在下'], false)
  consider(['你', '您', '各', '大家', '你们'], false)   // 第二人称也放行
  consider(OTHER_SUBJECT, true)
  if (lastPos < 0) return false   // 无主语的祈使句，按该睡处理
  return isOther
}

/** 返回 [是否收线, 强度, 命中的词]。 */
export function isClosing(text, cfg = {}) {
  const body = String(text || '').trim()
  if (!body) return [false, '', '']
  const [strength, word] = matchStrength(body, cfg)
  if (!strength) return [false, '', '']
  if (looksLikeNarration(body)) return [false, '', '']
  if (looksLikeQuestion(body)) return [false, '', '']
  if (isNounUsage(body, word)) return [false, '', '']
  // 在说别人去睡（「我们家狗睡觉去了」）——跟 BOT 没关系
  if (isOtherPersonSleep(body, word)) return [false, '', '']

  if (strength === 'weak') {
    return isShortAndBare(body, word) ? [true, strength, word] : [false, '', '']
  }
  if (isShortAndBare(body, word)) return [true, strength, word]
  if (FIRST_PERSON.some((m) => body.includes(m))) return [true, strength, word]
  if (body.replace(/[\s，,。.!！~～]+$/, '').endsWith(word)) return [true, strength, word]
  if (body.length <= 12) return [true, strength, word]
  return [false, '', '']
}

/** 这次收线该静默多久（分钟）。0 表示要睡到起床时间。 */
export function closeMinutes(cfg = {}, strength = '', word = '') {
  if (strength === 'strong') return 0
  if (['午', '眯', '盹', '躺'].some((m) => word.includes(m))) return Math.max(1, Number(cfg.noonMuteMinutes) || 75)
  return Math.max(1, Number(cfg.byeMuteMinutes) || 30)
}

/** 这句话是不是在问「你睡了吗」——反向判断，避免把问句当收线。 */
export function isAskingMe(text) {
  const body = String(text || '')
  return /你(还)?(睡|醒|在吗|睡了没|睡着)/.test(body)
}
