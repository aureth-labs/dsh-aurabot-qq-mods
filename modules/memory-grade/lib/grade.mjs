/**
 * 盖章：给一条记忆定密级、定类型、定来源、定重要度、定卦签。
 *
 * 原来这套写在 Aurabot 插件源码里（features/memory.js L330-359），
 * 现在搬到这里——插件被升级冲掉也不影响判定，记忆库能自己重算。
 *
 * 规则来源：2026-11-07 / 11-12 爸爸定的场合规矩。
 * 代码里不写任何人的真名，名字全从设置来。
 */

// ---------- 词表 ----------

/**
 * 通用机密线索：不涉及具体是谁，谁都用得上。
 *
 * 2026-11-07 定过一条规矩（插件源码 L331 有记）：只认「指得着具体人」的信号，
 * 不收「爸爸/妈妈/姐姐/爷爷/奶奶」这类泛词——视频、台词、别人嘴里一提就误判成机密。
 * 所以这里刻意没有「我爸爸」「我妈」这些。
 */
export const COMMON_SECRET = [
  '家里人', '咱家',
  '保密', '机密', '别告诉', '不能说', '不许说', '喊不出口',
  '亲妈', '后妈',
  '女主人', '大大大藤',
]

/** 通用安全词：优先级高于机密词。比如「保密协议」是在聊工作 */
export const PUBLIC_HINTS = [
  '公开', '对外', '随便说', '可以说',
  '保密协议', '保密合同', '保密条款', '保密制度', '保密规定', '保密要求',
  '机密文件', '机密级', '秘密等级', '秘密级',
]

/**
 * 否定的说法：看着像安全词，其实是在说「别说」。
 * 比如「属机密，不对外说」里有个「对外」，不能当成公开。2026-11-20 抓出来的坑。
 */
const NEGATED_PUBLIC = /不对外|别对外|不能对外|不许对外|不外传|别外传|不能外传/

/** 知识类开头：看来的东西算公开，谁都能听 */
export const KNOWLEDGE_PREFIX = [
  '在B站看了', '在抖音看了', '在知乎看了', '在微博看了',
  '在贴吧看了', '在小黑盒看了', '热榜', '看了别人发来', '按提示词画了',
]

/** 判断「这是在说某个具体的人」的上下文词 */
export const PERSONAL_CONTEXT = [
  'QQ', '我在 QQ 空间写过', '私聊',
  '老大让', '老大说', '老大要求', '老大问',
  '爸爸让', '爸爸说', '爸爸要求', '爸爸问', '爸爸答应',
  '我答应', '约定', '吩咐我', '让我记',
]

/**
 * 名字归一：旧记忆里写成这些的，统一认成一个人。
 * 默认空——各家叫法不一样，不该把谁家的名字写进公共模块。
 * 想用就在设置里填「她自己的名字」，模块会自动把常见变体归一到主名。
 */
export const NAME_CANON = []

export const FAMILY_TAG = '家人'

// 2026-11-23 爸爸定：称呼算不算家里人，要看「是谁说的」。
// 爸爸说的「我爸爸」= 爷爷；妈妈说的「我爸爸」= 姥爷；外人说的「我爸爸」= 跟我没关系的人。
// 所以：只有在家人 QQ 的私聊里出现称呼，才判机密。别人私聊里说的不算。
// 群聊一律不算——群里谁都可能喊「爸爸」。
// 例外：抖音这类外部私信频率低、误判影响小，靠凌晨检查兜底。
const KINSHIP_WORDS = ['爸爸', '爹爹', '老爸', '妈妈', '老妈', '姐姐', '妹妹', '爷爷', '奶奶']
const KINSHIP_RE = new RegExp(KINSHIP_WORDS.join('|'))

// 从 chatId 里取出 QQ 号：private:123456789 → 123456789
function qqOfChat(chatId) {
  const id = String(chatId || '')
  const m = id.match(/^private:(\d+)$/)
  return m ? m[1] : ''
}
export const KNOWLEDGE_TAG = '知识'
export const GROUP_TAG = '群聊'

// ---------- 工具 ----------

/** 把设置里那一串（用 | 逗号 分号 换行 隔开）拆成数组 */
export function splitWords(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean)
  return String(raw || '')
    .split(/[|,，;；\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/** 把词列表拼成正则。先转义再拼，长的放前面，避免短词把长词截断。 */
export function buildPattern(words) {
  const safe = (Array.isArray(words) ? words : [])
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

/** 名字归一：把旧称呼换成现在的 */
export function canonName(text) {
  let t = String(text || '')
  for (const [from, to] of NAME_CANON) {
    if (from === to) continue
    t = t.split(from).join(to)
  }
  return t
}

// ---------- 判定 ----------

/**
 * 造一个盖章器。设置变了就重新造一个。
 * @param {object} settings 模块设置（familyNames / personaName / ownerQQ / extraSecretWords / extraPublicWords）
 */
export function makeGrader(settings) {
  const s = settings || {}
  const persona = splitWords(s.personaName)
  const family = splitWords(s.familyNames)
  const ownerQqs = splitWords(s.ownerQQ)
  const familyQqs = splitWords(s.familyQQ)
  // 2026-11-24 补：家人的 QQ 也算机密号，不该只靠 ownerQQ。
  // 之前是把家人号手填进「补充机密词」顶上的，那一栏一清空就漏了。
  const qqs = [...new Set([...ownerQqs, ...familyQqs])]
  const extra = splitWords(s.extraSecretWords)
  const extraPublic = splitWords(s.extraPublicWords)

  const secretRe = buildPattern([...persona, ...family, ...extra, ...COMMON_SECRET])
  const publicRe = buildPattern([...extraPublic, ...PUBLIC_HINTS])
  const knowledgeRe = new RegExp('^(' + KNOWLEDGE_PREFIX.join('|') + ')')

  /** 这句话算机密吗？ -> { secret, reason } */
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

    // 安全词优先，但「不对外说」这种否定句要先排掉——它看着像安全词，其实是在强调别外传
    if (publicRe && publicRe.test(t) && !NEGATED_PUBLIC.test(t)) {
      return { secret: false, reason: '命中安全词' }
    }

    if (secretRe) {
      const hit = t.match(secretRe)
      if (hit) return { secret: true, reason: '出现了机密词：' + hit[0] }
    }

    return { secret: false, reason: '' }
  }

  /**
   * 给一条记忆盖密级章。顺序和插件原来的一致，改之前先比对。
   * @returns {'secret'|'internal'|'public'}
   */
  function classify(item) {
    const text = String(item?.text || '')
    const tags = Array.isArray(item?.tags) ? item.tags : []
    const chatId = String(item?.chatId || '')
    if (item?.pin === true) return 'secret' // 置顶的一律机密
    if (tags.includes(FAMILY_TAG)) return 'secret' // 人工确认过的家里事
    if (judge(text).secret) return 'secret'
  // 2026-11-23 爸爸定：称呼算不算家里事，看是谁说的。
  // 只有家人 QQ 发来的私聊里出现「爸爸」「妈妈」这些，才是自己家的事。
  // 别人私聊里说的「我爸爸」指的是他自己家里人，跟我们无关。
  //
  // 但有个例外（2026-11-23 补）：带「知识」标签的不走这条。
  // 知识条记的是从外面学来的东西（端口号、教程要点这类），提到「爸爸」只是记「谁教的」，
  // 内容本身不是家里私事，不该压成机密。真要提到家人的真名或 QQ 号，上面 judge() 已经拦住。
  const speakerQq = qqOfChat(chatId)
  if (
    speakerQq &&
    familyQqs.includes(speakerQq) &&
    !tags.includes(KNOWLEDGE_TAG) &&
    KINSHIP_RE.test(text)
  )
    return 'secret'
    if (tags.includes(KNOWLEDGE_TAG)) return 'public'
    // 2026-11-20 补回：看来的东西算公开（这段原来跟着「群聊」那行一起被我误删了）
    if (knowledgeRe.test(text.trim())) return 'public'
    // 群来源也算公开——插件只看 chatId，不看标签
    // 插件本来只看 chatId 是不是群，不看标签，下面那行就够了。
    if (chatId.startsWith('group:')) return 'public'
    return 'internal'
  }

  /** 这条算不算「学来的知识」（长期有效，不主动过期） */
  function isKnowledge(item) {
    const text = String(item?.text || '')
    const tags = Array.isArray(item?.tags) ? item.tags : []
    if (tags.includes(KNOWLEDGE_TAG)) return true
    if (item?.source === 'knowledge') return true
    return knowledgeRe.test(text.trim())
  }

  /** 是不是在说某个具体的人 -> 用来定 about 归属 */
  function isPersonal(text) {
    const t = String(text || '')
    if (qqs.some((q) => t.includes(String(q)))) return true
    return PERSONAL_CONTEXT.some((w) => t.includes(w))
  }

  return {
    judge,
    classify,
    isKnowledge,
    isPersonal,
    /** 设置填全了没有，没填启动时要提醒 */
    ready: () => family.length > 0 || persona.length > 0,
    counts: () => ({ family: family.length, persona: persona.length, qq: qqs.length }),
  }
}

/**
 * 一次盖全套章（新格式用）。
 * @returns {{ cls, type, source, importance, tags }}
 */
export function stampAll(item, settings) {
  const g = makeGrader(settings)
  const tags = Array.isArray(item?.tags) ? item.tags.slice() : []
  const cls = g.classify(item)
  const type = tags.includes(FAMILY_TAG) ? '家人' : g.isKnowledge(item) ? '知识' : '日常'
  return { cls, type, source: String(item?.source || ''), importance: Number(item?.importance) || 0.5, tags }
}
