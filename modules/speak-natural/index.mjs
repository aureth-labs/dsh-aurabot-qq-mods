// 说话自然度 —— 让她像正常人一样说话，不要 AI 腔
//
// 主人 2026-11-10 的要求：「写个插件学习正常人是怎么说话的」
//
// 现实问题（从群里她的发言能看到）：
//   · 每句都以颜文字结尾，一段话里好几个 ♡ / (´･ω･`)
//   · 冒出「[沉默][沉默]」这种重复标记
//   · 句子太长、爱解释、爱总结、爱列点
//   · 括号里写动作，像在念剧本
//
// 两层做法：
//   1) 规则层（根本）：把「正常人打字的样子」写进她的规则，让她自己想的时候就正常
//   2) 清理层（兜底）：发出去之前把明显累赘的东西剪掉（重复沉默、超量颜文字、动作括号）
//
// 私聊 / 群聊分别有档位，默认：群里正常一点，私聊保留她的味道。

// 颜文字：把「( … ) + 后面的零散装饰」整块吃掉，避免留残渣（如 و✧）
const KAOMOJI = /(?:\([^（）()\n]{0,12}\)(?:و\s*✧|و✧)?|＞﹏＜|QAQ|TAT|qwq|QwQ|orz|233+)/g
const SYMBOLS = /[♡♥❤💕💗✨🌸★☆♪]/g

export default {
  id: 'speak-natural',
  name: '说话自然度',
  version: '1.0.0',
  api: 1,
  description: '让她像正常人打字一样说话：短、不解释、不总结、不堆颜文字',
  defaults: {
    enabled: true,
    modeGroup: 'normal',   // off / light / normal / strict —— 群聊
    modePrivate: 'light',  // off / light / normal / strict —— 私聊
    maxKaomoji: 1,         // 一条消息里最多几个颜文字
    maxSymbols: 2,         // 一条消息里最多几个 ♡ 这类符号
    stripActions: true,    // 去掉括号里的动作描写
    stripFiller: true,     // 去掉「总之/总的来说/首先/其次」这类开头
    maxLines: 3,           // 一条回复最多几行（超了就提示，不硬砍）
    addHint: true,         // 每轮塞一句「怎么说话」的提醒
  },
  settings: [
    { key: 'enabled', label: '打开', type: 'switch' },
    { key: 'modeGroup', label: '群里的正常度', type: 'select', options: [
      { value: 'off', label: '不改（保留原样）' },
      { value: 'light', label: '轻：只剪明显累赘' },
      { value: 'normal', label: '正常：短句为主，少表情' },
      { value: 'strict', label: '严格：几乎不用颜文字和动作' },
    ], hint: '群里人多，建议 normal' },
    { key: 'modePrivate', label: '私聊的正常度', type: 'select', options: [
      { value: 'off', label: '不改（保留原样）' },
      { value: 'light', label: '轻：只剪明显累赘' },
      { value: 'normal', label: '正常' },
      { value: 'strict', label: '严格' },
    ], hint: '私聊可以留着她撒娇的味道，建议 light' },
    { key: 'maxKaomoji', label: '一条消息最多几个颜文字', type: 'number', min: 0, max: 5, step: 1 },
    { key: 'maxSymbols', label: '一条消息最多几个 ♡ 之类', type: 'number', min: 0, max: 6, step: 1 },
    { key: 'stripActions', label: '去掉括号里的动作', type: 'switch', hint: '像「（啪嗒啪嗒拍水花）」，群里显得像念剧本' },
    { key: 'stripFiller', label: '去掉书面语开头', type: 'switch', hint: '「总之」「总的来说」「首先」这类' },
    { key: 'addHint', label: '每轮提醒她怎么说话', type: 'switch' },
  ],
  panel: 'panel.js',

  setup(api) {
    const S = () => ({ ...api.defaults, ...api.settings() })
    const log = (m) => { try { api.log.info(m) } catch {} }

    const levelOf = (chatId) => {
      const s = S()
      if (!s.enabled) return 'off'
      const isGroup = String(chatId || '').startsWith('group:')
      const lv = isGroup ? s.modeGroup : s.modePrivate
      return ['off', 'light', 'normal', 'strict'].includes(lv) ? lv : 'light'
    }

    // ---------- 清理 ----------
    // 去掉括号里的动作描写：只处理中文全角括号 / 半角括号里像动作的短句
    // 保守规则：括号内 2~24 字、不含标点、不是常见说明性内容（比如「重要」「备注」）
    function stripParenActions(text) {
      return String(text || '').replace(/([（(])([^（）()\n]{2,24})([）)])/g, (all, a, inner, b) => {
        // 里面有句号问号、或者明显是解释性文字，就留着
        if (/[。，,、！？!?；;：:]/.test(inner)) return all
        // 像动作：动词开头 / 含「地」/含身体的词
        const looksAction = /^(啪嗒|轻轻|小声|低声|歪|晃|摇|甩|抖|缩|凑|蹭|贴|抱|埋|扒|抓|攥|拎|捧|盯|看|望|笑|哭|叹|哼|鼓|翘|垂|摆|转|退|顿|沉默|一|不|慢|快|悄悄|默默|用力|使劲|啪|噗|呜|嗯|啊)/.test(inner)
          || /(耳鳍|尾巴|呆毛|脸|头|手|脚|眼|嘴|身体|身子|声音|肩|腰|颈)/.test(inner)
        return looksAction ? '' : all
      })
    }

    // 常见 AI 腔开头（行首、或句号问号之后也算「开头」）
    const FILLER = [
      /(^|[\n。！？!?])[ \t]*(总之|总的来说|总而言之|简单来说|换句话说|说白了|不得不说|值得一提的是|需要注意的是|顺便说一下)[，,：:、]?[ \t]*/g,
      /(^|[\n。！？!?])[ \t]*(首先|其次|再者|然后再说|最后一点)[，,：:、]?[ \t]*/g,
      /(^|[\n。！？!?])[ \t]*(好的|好嘞|没问题|当然可以|很高兴为你|希望这能帮到你|希望能帮到你)[，,！!。.：:]?[ \t]*/g,
      /(^|[\n。！？!?])[ \t]*(所以你的意思是|也就是说|让我来|我来解释一下)[，,：:、]?[ \t]*/g,
    ]

    // ---------- 八股垫话：说的时候没意识到、但一听就「端着」 ----------
    // 主人 2026-11-10 的反馈：「感觉还是有点八股文的感觉，就像是你说话的时候经常说，这个我认、毕竟之类的」
    // 从当天的聊天流水里数出来的高频词：所以×7、不过×6、其实×3、先说×3、毕竟、确实、总的来说×2
    //
    // 分两类处理：
    //  ① 纯垫话 —— 删掉不影响语义，直接去掉
    //  ② 句首连接词 —— 只删「词 + 逗号」这种挂在句首的，不碰句中真正起连接作用的
    const PURE_FILLER = [
      // 认同/判断类的套话
      /(^|[\n。！？!?，,])[ \t]*这个我(认|懂|服|同意)[，,。！!]?[ \t]*/g,
      /(^|[\n。！？!?，,])[ \t]*这点我(认|懂|同意|服)[，,。！!]?[ \t]*/g,
      // 「毕竟」「其实」「确实」「说白了」在句首当垫话时
      /(^|[\n。！？!?])[ \t]*(毕竟|其实|说实话|老实说|讲道理|平心而论|客观(地)?说|严格来说|某种意义上)[，,]?[ \t]*/g,
      /(^|[\n。！？!?])[ \t]*(确实|的确|诚然)[，,](?=[^\n])/g,
      /(^|[\n。！？!?])[ \t]*(首先呢|然后呢|再然后|接下来|下面)[，,]?[ \t]*/g,
      /(^|[\n。！？!?，,])[ \t]*(先说|再说|去看|讲真)[，,]?[ \t]*/g,
      // 自我解释/缓冲
      /(^|[\n。！？!?])[ \t]*(怎么说呢|你懂我意思吧|这么讲吧|这么着吧)[，,]?[ \t]*/g,
    ]

    // 句首的「所以 / 不过 / 但是」+ 逗号：正常人聊天很少这么起句
    const LEADING_CONNECTIVE = [
      /(^|[\n。！？!?])[ \t]*(所以|因此|因而|于是)[，,][ \t]*/g,
      /(^|[\n。！？!?])[ \t]*(不过|但是|然而|可是)[，,][ \t]*/g,
      /(^|[\n。！？!?])[ \t]*(另外|此外|同时|以及)[，,][ \t]*/g,
    ]

    function cutFiller(text) {
      let t = String(text || '')
      for (const re of FILLER) t = t.replace(re, '$1')
      for (const re of PURE_FILLER) t = t.replace(re, '$1')
      for (const re of LEADING_CONNECTIVE) t = t.replace(re, '$1')
      // 行首残留的标点
      t = t.replace(/(^|\n)[，,、：:；; \t]+/g, '$1')
      // 删完之后可能出现「。。」或「， ，」
      t = t.replace(/。{2,}/g, '。').replace(/，{2,}/g, '，').replace(/[，,]\s*。/g, '。')
      return t
    }

    // 颜文字 / 符号限量：留前 N 个，后面的删掉
    function limitBy(re, text, max) {
      let i = 0
      return String(text || '').replace(re, (m) => (++i <= max ? m : ''))
    }

    // 连续空行、重复的 [沉默]
    function tidy(text) {
      let t = String(text || '')
      // [沉默][沉默]… 只留一个；但如果整条只有沉默，留着（等于不说话）
      if (/^(\s*\[沉默\]\s*)+$/.test(t)) return '[沉默]'
      t = t.replace(/(\s*\[沉默\]\s*){2,}/g, '')
      t = t.replace(/\n{3,}/g, '\n\n')
      t = t.replace(/[ \t]{2,}/g, ' ')
      // 连续感叹号/问号归一
      t = t.replace(/！{2,}/g, '！').replace(/!{2,}/g, '!').replace(/？{2,}/g, '？').replace(/\?{3,}/g, '?')
      return t.trim()
    }

    function normalize(text, chatId) {
      const s = S()
      const lv = levelOf(chatId)
      if (lv === 'off') return text
      let t = String(text ?? '')
      if (!t.trim()) return t

      // 1) 重复标记、感叹号、空白 —— 所有档位都做
      t = tidy(t)

      // 2) 书面语开头
      if (s.stripFiller) t = cutFiller(t)

      // 3) 动作括号
      if (s.stripActions && (lv === 'normal' || lv === 'strict')) t = stripParenActions(t)

      // 4) 颜文字 / 符号限量
      // 群里的「正常」档只留 1 个符号（正常人不会一句话里挂两个 ♡）
      const maxK = lv === 'light' ? Math.max(Number(s.maxKaomoji) || 1, 1) : (lv === 'strict' ? 0 : 1)
      const maxS = lv === 'light' ? Math.max(Number(s.maxSymbols) || 2, 2) : (lv === 'strict' ? 0 : 1)
      t = limitBy(KAOMOJI, t, maxK)
      t = limitBy(SYMBOLS, t, maxS)

      // 5) 清理后可能只剩空白/标点 → 交回原文，别把话弄没了
      const bare = t.replace(/[\s\p{P}]/gu, '')
      if (!bare && String(text).replace(/[\s\p{P}]/gu, '')) return tint(text)

      return tint(t)
    }

    // 清完的空格收一下（不改语义）
    function tint(t) {
      return String(t)
        .replace(/[ \t]+(?=[，。！？；：、）])/g, '')
        .replace(/^[\s，。！？；：、]+/g, '')
        .replace(/\s+$/g, '')
        .trim() || ''
    }

    // ---------- 规则：正常人的说话方式 ----------
    const RULES = {
      light: [
        '【说话方式】像跟熟人聊天那样打字。',
        '- 一条一两句就停。',
        '- 别用「毕竟」「其实」「所以」「不过」这种词起句 —— 那是写文章，不是聊天。',
        '- 不总结、不复述对方刚说的话。',
        '- 颜文字偶尔一个。',
      ].join('\n'),
      normal: [
        '【说话方式】像跟熟人聊天那样打字，不是写文章。',
        '',
        '短：一条一两句，最多三行。说完就停。',
        '',
        '别用垫话开头。这些一律不要：毕竟、其实、说实话、客观来说、首先、其次、总的来说、',
        '所以、不过、另外、也就是说、这个我认、这点我同意、怎么说呢、讲道理。',
        '正常人聊天不用这些词起句 —— 想说什么直接说。',
        '',
        '别总结、别复述对方的话、别解释自己为什么这么说、别列点。',
        '被问一句答一句，不要主动往外延伸三个话题。',
        '颜文字偶尔一个就够。不写括号动作（那是剧本）。',
        '语气词可以用（嗯、啊、欸、草），但别每句都同一个。',
      ].join('\n'),
      strict: [
        '【说话方式】像发微信一样，尽量朴素。',
        '- 一句话能说完就一句话。最多两行。',
        '- 不用毕竟、其实、所以、不过、总的来说这类垫话开头。',
        '- 不要颜文字、不要装饰符号、不要括号动作。',
        '- 不总结、不解释、不列点。',
        '- 不确定说什么就少说，或者直接不说。',
      ].join('\n'),
    }

    api.rule((kind) => {
      const s = S()
      if (!s.enabled) return ''
      const lv = kind === 'social' ? s.modeGroup : s.modePrivate
      return RULES[lv] || ''
    })

    // ---------- 兜底：发出去之前剪一刀 ----------
    api.on('reply', (text, { chatId } = {}) => {
      if (!S().enabled) return
      const out = normalize(text, chatId)
      if (out !== text) {
        const before = String(text || '').length
        const after = String(out || '').length
        if (after < before) log(`说话收紧：${before} → ${after} 字（${levelOf(chatId)}）`)
      }
      return out || undefined
    })

    // ---------- 每轮提醒一次（轻量，不抢戏） ----------
    api.on('prompt', (content, { chat } = {}) => {
      const s = S()
      if (!s.enabled || !s.addHint) return
      const lv = levelOf(chat?.chatId || (chat?.kind === 'group' ? 'group:' : 'private:'))
      if (lv === 'off') return
      const line = lv === 'strict'
        ? '（提醒：正常打字，短，别用颜文字和括号动作）'
        : lv === 'normal'
          ? '（提醒：短句，别总结别解释，颜文字偶尔一个就够）'
          : '（提醒：别堆太多颜文字）'
      if (Array.isArray(content)) return [...content, { type: 'text', text: line }]
      return String(content || '') + '\n\n' + line
    })

    // ---------- 面板 ----------
    api.route('/state', async () => {
      const s = S()
      return {
        ok: true,
        enabled: !!s.enabled,
        modeGroup: s.modeGroup,
        modePrivate: s.modePrivate,
        maxKaomoji: Number(s.maxKaomoji),
        maxSymbols: Number(s.maxSymbols),
        stripActions: !!s.stripActions,
        stripFiller: !!s.stripFiller,
      }
    })

    // 试剪一段，看效果
    api.route('/try', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const text = String(b?.text || '')
      const where = String(b?.where || 'group:0')
      return { ok: true, before: text, after: normalize(text, where) }
    })

    log(`说话自然度就位：群=${S().modeGroup} 私聊=${S().modePrivate}`)
    return { normalize, levelOf }
  },
}
