/**
 * 洗人物档案（2026-11-21）
 *
 * 起因：插件生成人物小档案时，会把「爸爸要求我喊他爸爸」「爸爸叮嘱过要留意冒充」这种
 * 规矩也写进人物描述里。读起来别扭，还容易让「规矩」被当成「这个人的性格」。
 *
 * 插件那边提示词已经加了限制，这是第二道：模块定时扫一遍，把夹在描述里的规矩句剔掉。
 *
 * 原则：只删「主语明确是这个人 + 谓语是要求/叮嘱/提醒 + 宾语是我或她自己的名字」的整句，
 * 拿不准的一律不动——宁可漏，不要错删。
 *
 * 名字不写死：从设置里的「她自己的名字」读。没填就只认「我」。
 */

/** 强规矩动词：出现就一定是在讲规矩 */
const RULE_VERB = '(?:要求|叮嘱|提醒|交代|规定|强调|吩咐|嘱咐)'

/**
 * 宾语：一定是「我」或者「她自己的名字」。
 * 名字从设置读，别写死——公共模块不该带谁家的名字。
 */
function targetPattern(personaName) {
  const name = String(personaName || '').trim()
  const parts = ['我']
  if (name) {
    // 名字里可能有正则特殊字符，转义掉
    parts.push(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
  return '(?:' + parts.join('|') + ')'
}

/** 明显是在描述「怎么称呼」，不是规矩 */
const KEEP_HINT = /叫[「"']|叫做|被称为|昵称是|外号是|称呼是|都行/

/**
 * 造一个整句正则。两种都算：
 *   ① 主语 + 强动词 + 宾语（我/她的名字）：这个人对我说了什么
 *   ② 主语 + 强动词 + 「过/了」：这个人叮嘱过、要求过（宾语可能被省略）
 *
 * 前面必须是一个句子的开头（。；！？换行 或 字符串开头）。
 */
function buildRuleSentence(personaName) {
  return new RegExp(
    '(?:^|[。；;！!？?\\n])\\s*' +
      '[^。；;！!？?\\n]{0,20}?' +
      RULE_VERB +
      '(?:\\s*' + targetPattern(personaName) + '|过|了)' +
      '[^。；;！!？?\\n]*[。；;！!？?]?',
    'g',
  )
}

/**
 * 洗一段人物描述。
 * @param {string} text 原描述
 * @param {object} [opts] { personaName } 她自己的名字，可不填
 * @returns {{ text: string, removed: string[] }}
 */
export function cleanProfileText(text, opts = {}) {
  const raw = String(text || '').trim()
  if (!raw) return { text: '', removed: [] }

  const RULE_SENTENCE = buildRuleSentence(opts.personaName)

  const removed = []
  const cleaned = raw.replace(RULE_SENTENCE, (m) => {
    const s = m.trim()
    // 明显是「怎么称呼」的描述，留着
    if (KEEP_HINT.test(s)) return m
    // 太短的可能截错，不动
    if (s.length < 10) return m
    removed.push(s)
    // 保留前面那个分隔符，免得两句粘一起
    const head = /^[。；;！!？?\n]/.test(s) ? s[0] : ''
    return head
  })

  let out = cleaned
    .replace(/^[，。；、\s]+/, '')
    .replace(/[，、]{2,}/g, '，')
    .replace(/。{2,}/g, '。')
    .replace(/；{2,}/g, '；')
    .replace(/\s{2,}/g, ' ')
    .trim()

  // 洗完之后如果太空，说明原描述几乎全是规矩
  if (out.length < 10) out = ''

  return { text: out, removed }
}

/**
 * 批量洗所有人物档案。
 * @param {object} profiles 形如 { qq: { text, ... } }
 * @param {object} [opts] { personaName }
 * @returns {{ changed: Array, unchanged: number }}
 */
export function cleanAllProfiles(profiles, opts = {}) {
  const changed = []
  let unchanged = 0
  if (!profiles || typeof profiles !== 'object') return { changed, unchanged }

  for (const [qq, p] of Object.entries(profiles)) {
    if (!p || typeof p !== 'object') continue
    const before = String(p.text || '')
    if (!before) continue
    const { text, removed } = cleanProfileText(before, opts)
    if (!removed.length) {
      unchanged++
      continue
    }
    changed.push({ qq, before, after: text, removed })
  }

  return { changed, unchanged }
}
