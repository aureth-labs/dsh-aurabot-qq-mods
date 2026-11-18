/**
 * 密级判断：一句话该不该往外说。
 *
 * 规则顺序（命中就停）：
 *   1. 出现设置里的 QQ 号  -> secret
 *   2. 命中「安全词」      -> public
 *   3. 出现机密词          -> secret
 *   4. 知识标签            -> public
 *   5. 群聊标签            -> public
 *   6. 其余                -> internal
 *
 * 这个文件里不写任何人的真名。名字都从设置里来。
 */

/** 通用机密词：谁都用得上，不涉及具体是谁 */
export const COMMON_SECRET = [
  '家里人', '咱家', '家事', '保密', '机密', '秘密',
  '别告诉', '不能说', '不许说', '不能提', '喊不出口',
  '我爸爸', '我爸', '我妈', '我姐姐', '我妹妹', '我爷爷', '我奶奶',
  '亲妈', '后妈', '真名', '本名',
]

/** 通用安全词：优先级高于机密词。比如「保密协议」是在聊工作 */
export const PUBLIC_HINTS = [
  '公开', '对外', '随便说', '可以说',
  // 机密词后面跟这些，是在聊工作/制度，不是家庭秘密
  '保密协议', '保密合同', '保密条款', '保密制度', '保密规定', '保密要求',
  '机密文件', '机密级', '秘密等级', '秘密级',
]

/** 把设置里那一串（用 | 逗号 分号 换行 隔开）拆成数组 */
export function splitWords(raw) {
  return String(raw || '')
    .split(/[|,，;；\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 把词列表拼成正则。
 * 先转义再拼，防止用户填了正则符号把整条打崩；
 * 长的放前面，避免短词把长词截断。
 */
export function buildPattern(words) {
  const safe = words
    .filter(Boolean)
    .map((w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!safe.length) return null
  safe.sort((a, b) => b.length - a.length)
  try {
    return new RegExp(safe.join('|'))
  } catch {
    return null
  }
}

/** 造一个判断器；设置变了就重新造一个 */
export function makeGrader(settings) {
  const s = settings || {}
  const persona = splitWords(s.personaName)
  const family = splitWords(s.familyNames)
  const qqs = splitWords(s.ownerQQ)
  const extra = splitWords(s.extraSecretWords)
  const extraPublic = splitWords(s.extraPublicWords)

  const secretRe = buildPattern([...persona, ...family, ...extra, ...COMMON_SECRET])
  const publicRe = buildPattern([...extraPublic, ...PUBLIC_HINTS])

  /** 这句话算机密吗？ */
  function judge(text) {
    const t = String(text || '')
    if (!t.trim()) return { secret: false, reason: '' }

    // QQ 号单独判：只认独立数字边界，防止 1234567890 里误中 123456789
    for (const q of qqs) {
      const esc = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      try {
        if (new RegExp('(^|\\D)' + esc + '(\\D|$)').test(t)) {
          return { secret: true, reason: '出现了 QQ 号' }
        }
      } catch {
        /* 用户填了怪东西，跳过这一条 */
      }
    }

    if (publicRe && publicRe.test(t)) return { secret: false, reason: '命中安全词' }

    if (secretRe) {
      const hit = t.match(secretRe)
      if (hit) return { secret: true, reason: '出现了机密词：' + hit[0] }
    }

    return { secret: false, reason: '' }
  }

  /** 给一条记忆盖密级章 */
  function classify(item) {
    const text = String(item?.text || '')
    const tags = Array.isArray(item?.tags) ? item.tags : []
    if (item?.pin === true) return 'secret'          // 置顶的一律机密
    if (tags.includes(FAMILY_TAG)) return 'secret'   // 人工确认过的家里事
    if (judge(text).secret) return 'secret'
    if (tags.includes(KNOWLEDGE_TAG)) return 'public'
    if (tags.includes(GROUP_TAG)) return 'public'
    return 'internal'
  }

  return {
    judge,
    classify,
    /** 设置填全了没有，没填启动时要提醒 */
    ready: () => family.length > 0 || persona.length > 0,
    counts: () => ({ family: family.length, persona: persona.length, qq: qqs.length }),
  }
}

export const FAMILY_TAG = '家人'
export const KNOWLEDGE_TAG = '知识'
export const GROUP_TAG = '群聊'
