/**
 * 时效判定（试验版 2026-11-20）
 *
 * 判一件事有没有保质期、多久之后就不算「现在」了。
 * 和密级、重要度分开算：
 *   - 密级管嘴：能不能往外说
 *   - 重要度管记：值不值得留
 *   - 时效管鲜：多久以后说的是「当时」而不是「现在」
 *
 * 这三样互不影响。机密的东西也会过时，过时了也不代表能往外说。
 */

// ---------- 词表 ----------

/**
 * 身体状态分三档（2026-11-21 爸爸定）。
 * 爸爸原话：「爸爸跑厂区脚疼只是累的，休息几天就好了，所以家人状态也是会过期的呀」
 * 所以不是「家里人的身体就永不过期」，而是按严重程度定不同的保质期。
 */

/** 一档：累着了、小毛病——几天就过去 */
const BODY_LIGHT = /脚疼|脚痛|腿疼|腿酸|累了|疲劳|熬夜|没睡好|困|嗓子疼|头痛|头疼|腰疼|腰酸|背疼|晕车|有点不舒服|小感冒|着凉|上火/

/** 二档：会好但要好一阵——按恢复期算 */
const BODY_MID = /发烧|感冒|咳嗽|拉肚子|过敏|牙疼|失眠|血压|血糖|消化|胃炎|熬夜太多|复查|打针|吃药/

/** 三档：伤筋动骨、要住院的——按月算 */
const BODY_HEAVY = /住院|手术|开刀|化疗|放疗|骨折|摔了|受了伤|受伤|抢救|ICU|重症|恢复期|康复|痊愈|出院/

/**
 * 需要长期盯着的病（2026-11-21 爸爸定）。
 * 神经鞘瘤这种术后恢复期特别长，定 5 年。
 * 这类不是「生病」也不是「伤筋动骨」，是「要一直惦记着的」。
 */
const BODY_LONG = /神经鞘瘤|鞘瘤|肿瘤|癌症|癌|白血病|尿毒症|透析|肝硬化|心梗|脑梗|中风|偏瘫|癫痫|红斑狼疮|类风湿|糖尿病|阿尔茨海默|帕金森|术后恢复|术后复查/

/** 身体状态的泛用词（不知道轻重时兜底） */
const BODY = /疼|不舒服|难受|病了|生病|身体/

/** 位置/在场：会过时 */
const PLACE = /在医院|在上班|在公司|在家|在路|在出|到公司|到学校|回去了|回来了|出去了|到家了|在路上|出差|旅游|放假/

/** 日程：有明确起止 */
const SCHEDULE = /明天|后天|大后天|今天|今晚|下午|上午|这周|下周|下周[一二三四五六日天]|周[一二三四五六日天]|号那天|\d+月\d+[日号]|月底|月初/

/** 行情：时时在变 */
const MARKET = /多少钱|价格|涨了|跌了|报价|余额|汇率|金价|油价|股价/

/** 心情/临时感受 */
const MOOD = /心情|有点累|好困|难受|开心死了|烦躁/

/** 长期有效的：永不过时 */
const TIMELESS = /昵称|称呼|别名|外号|名字|生日|喜欢|爱吃|讨厌|习惯|性格|关系|是爸爸|是妈妈|是爷爷|是奶奶|是姐姐|是妈妈|叫什么|小名|大名|真名|本名/

/** 知识：不主动过期 */
const KNOWLEDGE = /^(在B站看了|在抖音看了|在知乎看了|在微博看了|在贴吧看了|在小黑盒看了|热榜|看了别人发来)/

/**
 * 内容本身就是知识的（2026-11-21 补）。
 * 标签没打全的先例太多了，正文有这些特征就按知识算：
 *   - 科普/实测/原理/机制 这类讲道理的
 *   - 带「要点/小技巧/注意事项/风控/参数/配置」
 *   - 带具体测量数字 + 单位（克、元、厘米、秒……）
 */
const KNOWLEDGE_BODY = /要点|小技巧|注意事项|风控|参数|配置|实测|原理|机制|指数|升糖|卡路里|热量|营养成分|升糖|GI值|阈值|下限|上限|维|菌|酶|蛋白|碳水|脂|浓度|剂量|配比/

/**
 * 历史事件：已经发生完了，是记录不是状态（2026-11-21 补）。
 * 「黄仁勋辞职」「马斯克请愿」这种，过多久都还是「这件事发生过」。
 */
const HISTORIC = /公告|宣布|辞职|辞去|请愿|发起了|股价一度|跌超|涨停|发布会|上映|定档|开售|上市|上线了|通过了|判决|开庭|选举|当选/

/**
 * 我做过的事的记录（2026-11-21 补）。
 * 「把抖音上X分享给爸爸」「在抖音X下评论」「逛贴吧首页看到」「我在小黑盒逛了一圈」——
 * 这些是经历流水，不是「现在的状态」。过多久都还是「那天我干了这件事」。
 */
const DID_RECORD = /^(把抖音上|在抖音|逛贴吧首页看到|我在小黑盒逛了一圈|我在 QQ 空间写过|分享给了爸爸)/

/**
 * 已经完成的事（2026-11-21 补）。
 * 「弄好了」「已经」「完成了」——发生完了，是记录。
 */
const DONE = /弄好了|已经.*了|完成了|建好了|装好了|补全了|恢复了|通过了|开始了|确认.*无误后|无问题后/

/**
 * 爸爸的决定/设定（2026-11-21 补）。
 * 「决定采用」「已经买好」——这是定下来的事，长期有效。
 */
const DECISION = /决定采用|决定把|已经买好|已经装好|已经配好|定下来了|说好都是后话/

/**
 * 在说某个群友的事（2026-11-21 补）。
 * 「XX（QQ xxx）」或「XX（123456789）」——这是对人的了解，不是临时状态。
 * 一个人腰疼、工作头疼、猫拉肚子，过多久都还是「他当时说过」。
 * 注意：括号全角半角都要认；「QQ」两个字可有可无；括号里必须是 5 位以上纯数字。
 */
const ABOUT_PERSON = /[（(]\s*(?:QQ\s*[:：]?\s*)?\d{5,}\s*[）)]/

/**
 * 环境/条件（2026-11-21 补）。
 * 「放在公司电脑上跑」「24 小时不断电」——这是现状条件，不是会过期的日程。
 */
const CONDITION = /放在.*运行|不断电|不用担心|长期|一直/

/**
 * 看过的内容（2026-11-21 补）。
 * 评论区说的话、UP 主文案、段子、实测评测——这是「我看到了什么」，
 * 属于看过就记着的知识性内容，不该按「现在/当时」算。
 */
const CONTENT_SEEN = /评论区|文案|这文案|UP主|分享给主人|又刷到|刷到一遍|实测|预告就改了/

/** 时间跨度提取 */
const SPAN = [
  [/(\d+)\s*个?\s*月/, (m) => Number(m[1]) * 30],
  [/(\d+)\s*个?\s*周|(\d+)\s*个?\s*星期/, (m) => Number(m[1] || m[2]) * 7],
  [/(\d+)\s*天/, (m) => Number(m[1])],
  [/(\d+)\s*年/, (m) => Number(m[1]) * 365],
  [/半个?月/, () => 15],
  [/一个?周|一星期/, () => 7],
  [/一个?月/, () => 30],
  [/三个月/, () => 90],
  [/半年/, () => 180],
  [/明天/, () => 1],
  [/后天/, () => 2],
  [/下周/, () => 7],
]

// ---------- 判定 ----------

/**
 * 判一条记忆的时效。
 * @param {string} text 正文
 * @param {object} [opts]
 * @returns {{ kind, fresh, spanDays, suggestImportance, why }}
 *   kind: state（状态）/ schedule（日程）/ event（事件）/ fact（事实）/ knowledge（知识）
 *   fresh: 会不会过时
 *   spanDays: 多久后变成「当时」；0 = 不过时
 *   suggestImportance: 建议重要度
 */
export function judgeFreshness(text, opts = {}) {
  const t = String(text || '').trim()
  if (!t) return { kind: 'event', fresh: false, spanDays: 0, suggestImportance: 0.5, why: '空的' }

  const tags = Array.isArray(opts.tags) ? opts.tags : []

  // 2026-11-21 爸爸定：置顶的一律免判——永久记忆，不参与时效，重要度固定 1
  if (opts.pin === true) {
    return { kind: 'pinned', fresh: false, spanDays: 0, suggestImportance: 1, why: '置顶记忆，永久有效' }
  }

  // 带「规矩」「事实」「长期印象」「约定」标签的一律不判时效（2026-11-20 爸爸定）
  // 这些是长期有效的，不该被「余额」「多少钱」这种词误伤成行情。
  if (tags.includes('规矩') || tags.includes('事实') || tags.includes('长期印象') || tags.includes('约定')) {
    return { kind: 'fact', fresh: false, spanDays: 0, suggestImportance: 0.7, why: '规矩/事实类，长期有效' }
  }

  // 知识：永不过期。
  // 2026-11-21 修：原来只认正文开头的「在B站看了」，带「知识」标签但开头不是的会漏判。
  // 现在标签和开头任一命中都算。
  if (tags.includes('知识') || KNOWLEDGE.test(t)) {
    return { kind: 'knowledge', fresh: false, spanDays: 0, suggestImportance: 0.6, why: '学来的知识，不主动过期' }
  }

  // 空间日记：那是当天记下的整段经历，不是临时状态。
  // 2026-11-21 修：开头有「今天」不代表有时效，这里先挡掉。
  if (/^我在 QQ 空间写过/.test(t)) {
    return { kind: 'diary', fresh: false, spanDays: 0, suggestImportance: 0.6, why: '空间日记，当天的完整记录，不按时间淘汰' }
  }

  // 正文本身是知识（2026-11-21 补）：标签没打全的，看内容兜住
  if (KNOWLEDGE_BODY.test(t)) {
    return { kind: 'knowledge', fresh: false, spanDays: 0, suggestImportance: 0.6, why: '内容是科普/实测/要点，按知识算，不过期' }
  }

  // 历史事件（2026-11-21 补）：已经发生完了，是记录不是状态
  if (HISTORIC.test(t)) {
    return { kind: 'event', fresh: false, spanDays: 0, suggestImportance: 0.6, why: '已经发生的历史事件，是记录，不按现在/当时算' }
  }

  // 我做过的事（2026-11-21 补）：经历流水，不是状态
  if (DID_RECORD.test(t)) {
    return { kind: 'event', fresh: false, spanDays: 0, suggestImportance: 0.5, why: '那天做过的事，是记录，不按现在/当时算' }
  }

  // 已经完成的事（2026-11-21 补）
  if (DONE.test(t)) {
    return { kind: 'event', fresh: false, spanDays: 0, suggestImportance: 0.6, why: '已经完成，是记录' }
  }

  // 定下来的决定（2026-11-21 补）
  if (DECISION.test(t)) {
    return { kind: 'fact', fresh: false, spanDays: 0, suggestImportance: 0.7, why: '定下来的事，长期有效' }
  }

  // 在说某个群友（2026-11-21 补）：对人的了解，不是临时状态
  if (ABOUT_PERSON.test(t)) {
    return { kind: 'fact', fresh: false, spanDays: 0, suggestImportance: 0.5, why: '关于某个人的事，属于对人的了解' }
  }

  // 环境/条件（2026-11-21 补）
  if (CONDITION.test(t)) {
    return { kind: 'fact', fresh: false, spanDays: 0, suggestImportance: 0.6, why: '现状条件，不是会过期的日程' }
  }

  // 看过的内容（2026-11-21 补）：评论区、文案、UP主、实测
  if (CONTENT_SEEN.test(t)) {
    return { kind: 'knowledge', fresh: false, spanDays: 0, suggestImportance: 0.55, why: '看到的内容，属于看过就记着的，不按现在/当时算' }
  }

  // 先看有没有明说的时间跨度
  let spanFromText = 0
  for (const [re, calc] of SPAN) {
    const m = t.match(re)
    if (m) {
      spanFromText = calc(m)
      break
    }
  }

  // 身体状态 + 日程：这是爸爸举的例子
  // 身体状态分四档（2026-11-21 爸爸定）
  // 一档累着了：3 天；二档生病：7 天；三档伤筋动骨：30 天；四档长期病：5 年。
  // 明确说了时间的（「住院一个周」）优先按文字里的算。
  if (BODY_LONG.test(t)) {
    const span = spanFromText || 1825
    return {
      kind: 'state',
      fresh: true,
      spanDays: span,
      suggestImportance: 0.9,
      why: `需要长期盯着的病，定 ${Math.round(span/365)} 年。这类不是「过去了」，是「一直得记着」`,
    }
  }
  if (BODY_HEAVY.test(t)) {
    const span = spanFromText || 30
    return {
      kind: 'state',
      fresh: true,
      spanDays: span,
      suggestImportance: 0.8,
      why: `伤筋动骨/住院这类，按 ${span} 天恢复期算，之后变「当时」`,
    }
  }
  if (BODY_MID.test(t)) {
    const span = spanFromText || 7
    return {
      kind: 'state',
      fresh: true,
      spanDays: span,
      suggestImportance: 0.7,
      why: `生病这类，${span} 天后变「当时」`,
    }
  }
  if (BODY_LIGHT.test(t)) {
    const span = spanFromText || 3
    return {
      kind: 'state',
      fresh: true,
      spanDays: span,
      suggestImportance: 0.5,
      why: `累着了这类，歇 ${span} 天就过去了`,
    }
  }
  if (BODY.test(t)) {
    const span = spanFromText || 7
    const both = SCHEDULE.test(t)
    return {
      kind: both ? 'schedule' : 'state',
      fresh: true,
      spanDays: span,
      suggestImportance: 0.7,
      why: `身体状态${both ? ' + 日程' : ''}，${span} 天后变「当时」`,
    }
  }

  // 临时感受要排在日程前面——「今天心情有点闷」里有个「今天」，会被日程规则截走
  if (MOOD.test(t)) {
    return { kind: 'mood', fresh: true, spanDays: spanFromText || 1, suggestImportance: 0.3, why: '临时感受，很快过去' }
  }

  if (SCHEDULE.test(t)) {
    const span = spanFromText || 7
    return { kind: 'schedule', fresh: true, spanDays: span, suggestImportance: 0.6, why: `日程，${span} 天后失效` }
  }

  if (MARKET.test(t)) {
    return { kind: 'state', fresh: true, spanDays: spanFromText || 3, suggestImportance: 0.4, why: '行情时时在变，几天就旧了' }
  }

  if (PLACE.test(t)) {
    return { kind: 'state', fresh: true, spanDays: spanFromText || 1, suggestImportance: 0.4, why: '位置/在场，一天就旧' }
  }

  // 名字、喜好这类：永不过时（放在日程之前，免得「爸爸爱吃白米饭」被「下午」带偏）
  if (TIMELESS.test(t)) {
    return { kind: 'fact', fresh: false, spanDays: 0, suggestImportance: 0.7, why: '长期有效的事，不过期' }
  }

  // 默认：当事件，不主动过期
  return { kind: 'event', fresh: false, spanDays: spanFromText || 0, suggestImportance: 0.5, why: '事件，留着当记录' }
}

/**
 * 一条记忆现在还算不算「现在」。
 * @param {{at:number, spanDays:number, fresh:boolean}} m
 * @param {number} now
 * @returns {'now'|'then'|'ever'}
 */
export function freshnessState(m, now = Date.now()) {
  if (!m?.fresh) return 'ever'
  const span = Number(m.spanDays) || 0
  if (!span) return 'ever'
  const start = Number(m.at) || 0
  if (!start) return 'now'
  const days = (now - start) / 86400000
  return days > span ? 'then' : 'now'
}
