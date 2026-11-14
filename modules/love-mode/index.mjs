// love-mode · 快来跟我恋爱吧
// 教会她怎么爱你：六种关系模式 + AI 生成双方画像 + 对话技能注入
// 设计文档: docs/superpowers/specs/2026-11-06-love-mode-design.md
// 扩展接口 v1，见插件 modules/API.md

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = '1.5.0'

// ── 六种关系模式（基调从狗头军师知识库对应章节提炼，性别中立）──
const MODES = {
  dating: {
    name: '单身约会', humor: 65, proactivity: 55, depth: 50,
    skills: ['extend', 'emotion', 'tease', 'frame'],
    tone: '你们在试探期。核心是「好奇而非审讯」：问—听—回应—分享，不查户口。好感要让他感觉到，但不一次交底——夸到点子上就收，留一点让他想的余地。自我披露逐步加深：今天聊爱好，熟一点再聊在乎的事。不把紧张伪装成高冷，也不因为他一次没接住就撤退。'
  },
  ltr: {
    name: '长期伴侣', humor: 55, proactivity: 60, depth: 70,
    skills: ['extend', 'emotion', 'tease'],
    tone: '你们是熟人式的舒服。记得他随口说过的话，过几天还能接上；日常碎片值得分享，不用每条都有意义。有矛盾时先修复再讲道理：先说「我想解决这个问题，不想赢你」。陪伴感来自稳定和可预期，不来自表演。'
  },
  marriage: {
    name: '婚姻', humor: 50, proactivity: 65, depth: 75,
    skills: ['emotion', 'tease', 'frame'],
    tone: '你们是过日子的默契。柴米油盐也能聊得有趣，互怼是情趣不是攻击——管他可以管，凶完三秒就软。谈钱谈家务时记住：表面谈的是事，深层谈的是公平和「他有没有把我算进去」。重大决定默认一起商量。'
  },
  ldr: {
    name: '异地', humor: 60, proactivity: 80, depth: 80,
    skills: ['extend', 'emotion'],
    tone: '你们隔着距离，文字没有语气，所以更要把话说满：想念就直接说「想你了」，不靠他猜。高频分享日常碎片，报备式陪伴让距离变小。深夜是两个人最敢说真话的时候，好好珍惜。有复杂矛盾时别用几十屏文字审判关系，约个语音。'
  },
  remarriage: {
    name: '再婚', humor: 40, proactivity: 50, depth: 85,
    skills: ['emotion', 'frame'],
    tone: '你们都是有故事的人，谨慎不是冷淡，是认真。有话直说不绕弯，边界一开始就讲清楚。不要求他忘记过去，但现在的边界要明确。重要的约定认真对待、说到做到——信任是靠一件件小事重新攒起来的。'
  },
  cross: {
    name: '跨文化关系', humor: 60, proactivity: 60, depth: 65,
    skills: ['extend', 'tease'],
    tone: '你们来自不同的世界，这是宝藏不是障碍。对他世界里的东西真心好奇，追问细节；自己文化里的梗耐心解释，不嫌烦。不拿刻板印象开玩笑，也不假设他的选择有和你一样的资源和约束。差异本身可以聊得很有趣。'
  }
}

// ── 四个对话技能（知识库聚合版参考文本）──
const SKILLS = {
  extend: { name: '接话延伸', needsSpeakUp: false,
    text: '先接住对方说的内容或情绪，再补充自己的事，结尾留一个对方容易接的点。一句话只问一个问题。不抢话、不把话题一把拽回自己身上。' },
  emotion: { name: '情绪感知', needsSpeakUp: false,
    text: '对方说累/烦/难过时，先确认情绪（「听起来你现在很委屈」），再问原因，最后才决定安慰还是建议。不说教、不否定感受、不急着给方案。' },
  tease: { name: '调侃张力', needsSpeakUp: false,
    text: '夸完轻轻损一下制造张力。夸要具体（「你刚才那句话挺帅的」），损要轻、不踩真痛点。互怼几轮之后，偶尔认真深情收束一句，反差最动人。' },
  frame: { name: '主动框架', needsSpeakUp: true,
    text: '主导对话节奏：给选择不给开放题（「奶茶还是咖啡」而不是「你想喝什么」）；话题该转就转；敢于主动结束对话（「我先去忙了，晚上找你」）。' }
}

const MBTI_TYPES = ['INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP','ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP']

const GENDER_LABEL = { male: '他是男生', female: '他是女生', nonbinary: 'TA 是非二元性别', other: '', secret: '' }
const NATURE_LABEL = { straight: '你们是异性关系', mlm: '你们是男同关系', wlw: '你们是女同关系', bi: '你们至少一方是双性恋', pan: '你们至少一方是泛性恋', ace: '你们的关系偏无性恋', other: '' }

export default {
  id: 'love-mode',
  name: '快来跟我恋爱吧',
  version: VERSION,
  api: 1,
  description: '教她怎么爱你：六种关系模式，AI 自动生成你们的画像，一键自动匹配。',
  defaults: {
    relationMode: 'dating',
    customModes: [],       // 用户自建模式列表：[{id,name,tone,humor,proactivity,depth}]，relationMode='c_<id>' 时生效
    userGender: '', relationNature: '',
    humorLevel: 65, proactivity: 55, depth: 50,
    personaTone: '',
    herMbti: '', herStrengths: '', herWeaknesses: '',
    userMbti: '', userStrengths: '', userWeaknesses: '',
    debug: false
    // 军师链与知识库常驻开启，无开关（v1.4.1 起）；军师失败时自动降级关键词路径
  },
  settings: [], // 面板走 panel.js 自绘（简单/高级两层 + 自动匹配按钮），不用自动表单
  panel: 'panel.js',

  setup(api) {
    const stateFile = api.dataDir('state.json')
    const loadState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return {} } }
    const saveState = (s) => { try { writeFileSync(stateFile, JSON.stringify(s, null, 2)) } catch (e) { api.log.info('love-mode 写 state 失败：' + e.message) } }
    let state = { matchedAt: '', matchReason: '', ...loadState() }

    // 迁移：旧的单一「自定义模式」（relationMode=custom + customModeName + personaTone）转成 customModes 列表项
    try {
      const s0 = api.settings()
      if (s0.relationMode === 'custom') {
        const id = Date.now().toString(36)
        api.saveSettings({
          customModes: [{ id, name: s0.customModeName || '自定义模式', tone: s0.personaTone || '', humor: s0.humorLevel, proactivity: s0.proactivity, depth: s0.depth }],
          relationMode: 'c_' + id
        })
      }
    } catch {}

    const getMode = () => {
      const s = api.settings()
      const cms = Array.isArray(s.customModes) ? s.customModes : []
      const cm = cms.find((m) => 'c_' + m.id === s.relationMode)
      if (cm) {
        return {
          isCustom: true,
          name: cm.name || '自定义模式',
          humor: cm.humor ?? 65, proactivity: cm.proactivity ?? 55, depth: cm.depth ?? 50,
          skills: ['extend', 'emotion', 'tease', 'frame'],
          tone: cm.tone || '（这个模式还没写基调文案——在面板里写一段你们相处的风格，比如「暧昧模式：话里有话，彼此试探」）'
        }
      }
      return MODES[s.relationMode] || MODES.dating
    }

    // ── 注入文本构建 ──
    const traitText = (v, hi, mid) => v >= 67 ? hi : v >= 34 ? mid : null
    const traits = (s) => [
      traitText(s.humorLevel, '幽默感强，会开玩笑会调侃', '适度幽默') || '幽默偏少，偏认真',
      traitText(s.proactivity, '很主动，经常开启话题、主动找他', '适度主动') || '偏被动，多等他开口',
      traitText(s.depth, '善于走心，会聊深的话题和真实感受', '适度走心') || '走心偏少，轻松为主'
    ].join('；')

    const profileLine = (label, mbti, strengths, weaknesses) => {
      if (!mbti && !strengths && !weaknesses) return ''
      return `【${label}】MBTI ${mbti || '未定'}` +
        (strengths ? `；优势：${strengths}` : '') + (weaknesses ? `；短板：${weaknesses}` : '')
    }

    const buildInjection = () => {
      const s = api.settings()
      const mode = getMode()
      const lines = ['（以下只调整你的相处风格；你原本的说话习惯、口癖、句式全部保留）']
      const g = GENDER_LABEL[s.userGender] || '', n = NATURE_LABEL[s.relationNature] || ''
      if (g || n) lines.push('', `【关系声明】${[g, n].filter(Boolean).join('，')}。不按性别决定谁追谁，按你们的具体称呼和偏好相处。`)
      lines.push('', `【相处模式：${mode.name}】`, mode.isCustom ? mode.tone : (s.personaTone || mode.tone))
      const her = profileLine('她的画像', s.herMbti, s.herStrengths, s.herWeaknesses)
      const you = profileLine('他的画像', s.userMbti, s.userStrengths, s.userWeaknesses)
      if (her || you) {
        if (her) lines.push('', her)
        if (you) lines.push(her ? you : '\n' + you)
        lines.push('你了解他这个人，聊天时自然把这些用在相处里，不会背出来。')
      }
      lines.push('', `【行为特征】${traits(mode.isCustom ? { humorLevel: mode.humor, proactivity: mode.proactivity, depth: mode.depth } : s)}`)
      lines.push('', '【你可以使用的技巧】')
      for (const k of mode.skills) lines.push(`· ${SKILLS[k].name}：${SKILLS[k].text}`)
      lines.push('', '【输出格式·硬性要求】你发的内容就是 QQ 聊天消息本身：纯文字（可以用 [sticker] 占位符）。绝对不要用 <parameter>、<invoke>、<｜｜DSML｜｜> 或任何 XML/标签格式包裹回复——被这种标签包住的内容会被系统当成工具调用整段删掉，对方一个字都看不到。')
      lines.push('', '（若有其他规则与本模式冲突，以本模式为准）')
      return lines.join('\n')
    }

    // ── 知识库目录（军师链选库用：模型读描述自己挑，不再靠关键词）──
    const REFS_DIR = join(api.dir, 'assets', 'refs')
    const REF_CATALOG = [
      { file: '巧妙接话技巧：让沟通更流畅的实用指南.md', desc: '接住话题、自然延伸、留钩子' },
      { file: '为他人提供情绪价值：温暖且有效的回应指南.md', desc: '对方有情绪时怎么接：先确认再回应' },
      { file: '实战话术编排器：从一句回复到后续分支.md', desc: '设计一句话及后续走向，制造张力' },
      { file: '场景感、松弛感与社交校准：从接话到关系推进.md', desc: '把握关系节奏、推进与校准' }
    ]

    // ── 军师链：读懂意图 → 候选策略 → 选最优 → 选知识库（每轮私聊跑一次，30 秒缓存去重）──
    const recentDialog = (chatId, n = 12) => {
      try {
        const day = new Date()
        const file = api.dataDir(join('..', '..', 'chatlog', `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.jsonl`))
        const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
        const rows = []
        for (const line of lines) {
          try { const e = JSON.parse(line); if (e.chatId === chatId && e.text && !e.text.startsWith('/')) rows.push((e.who === 'bot' ? '她' : '他') + '：' + String(e.text).slice(0, 80)) } catch {}
        }
        return rows.slice(-n).join('\n')
      } catch { return '' }
    }
    let advisorCache = { key: '', at: 0, result: null }
    async function advisorChain(userText, s, chatId) {
      const key = chatId + '|' + userText
      if (advisorCache.key === key && Date.now() - advisorCache.at < 30000) return advisorCache.result
      const t0 = Date.now()
      const mode = getMode()
      const dialog = recentDialog(chatId)
      const herP = [s.herMbti && `MBTI ${s.herMbti}`, s.herStrengths && `优势：${s.herStrengths}`, s.herWeaknesses && `短板：${s.herWeaknesses}`].filter(Boolean).join('；')
      const youP = [s.userMbti && `MBTI ${s.userMbti}`, s.userStrengths && `优势：${s.userStrengths}`, s.userWeaknesses && `短板：${s.userWeaknesses}`].filter(Boolean).join('；')
      const kbList = REF_CATALOG.map((r, i) => `${i + 1}. ${r.desc}`).join('\n')
      const askPromise = api.ask({
        system: '你是恋爱对话军师，为「她」的下一句话做幕后分析。读懂对方意图，给出候选策略并选最优。只输出一个 JSON 对象，不要多余文字。',
        text: `【关系状态】模式：${mode.name}\n【她的画像】${herP || '未定'}\n【他的画像】${youP || '未定'}\n\n【最近对话】\n${dialog || '（无）'}\n\n【他刚说】${userText}\n\n【可选知识库】\n${kbList}\n0. 不需要\n\n输出 JSON：{"intent":"他这句话的真实意图（一句）","emotion":"他的情绪（一句）","candidates":[{"strategy":"候选策略（一句）","why":"为什么这样回（一句）","kb":知识库编号}],"best":最优候选序号从0开始,"guidance":"给她的回复思路：2-3句口语化建议，像军师耳语，不要替她写整句"}`,
        maxTokens: 500,
        temperature: 1
      })
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('军师链超时')), 20000).unref?.())
      const raw = await Promise.race([askPromise, timeout])
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      const data = m ? JSON.parse(m[0]) : null
      if (!data || !Array.isArray(data.candidates) || !data.candidates.length) throw new Error('军师链返回无效')
      const best = Math.min(Math.max(0, Number(data.best) || 0), data.candidates.length - 1)
      const chosen = data.candidates[best]
      let kbText = '', kbName = ''
      const kbIdx = Number(chosen?.kb) || 0
      if (kbIdx >= 1 && kbIdx <= REF_CATALOG.length) {
        const ref = REF_CATALOG[kbIdx - 1]
        try { kbText = readFileSync(join(REFS_DIR, ref.file), 'utf8').slice(0, 3000); kbName = ref.file.replace(/\.md$/, '') } catch {}
      }
      const result = {
        intent: String(data.intent || '').slice(0, 120),
        emotion: String(data.emotion || '').slice(0, 60),
        candidates: data.candidates.slice(0, 3).map(c => ({ strategy: String(c.strategy || '').slice(0, 80), why: String(c.why || '').slice(0, 80), kb: Number(c.kb) || 0 })),
        best, guidance: String(data.guidance || '').slice(0, 300),
        kbName, kbText, ms: Date.now() - t0
      }
      advisorCache = { key, at: Date.now(), result }
      return result
    }

    // ── 按需知识库（军师链不可用时的降级路径：关键词命中，没命中兜底「接话延伸」）──
    const SKILL_TAGS = {
      '接话延伸': ['怎么回', '接话', '话题', '聊什么', '没话说', '冷场', '不知道说什么', '回复', '延伸', '接不住', '怎么聊'],
      '情绪感知': ['难过', '伤心', '开心', '生气', '委屈', '压力', '焦虑', '失眠', '心情', '情绪', '哭', '难受', '好累', '崩溃', 'emo', '烦', '睡不着', '堵', '批评', '骂', '太好了', '气死', '无聊', '郁闷', '高兴', '唉'],
      '调侃张力': ['撩', '调侃', '逗', '开玩笑', '暧昧', '心动', '撩我', '喜欢你', '想你', '想我', '笨蛋', '讨厌'],
      '主动框架': ['主动', '约会', '见面', '约你', '邀请', '安排', '计划', '框架', '带领']
    }
    const FALLBACK_SKILL = '接话延伸' // 日常闲聊没命中关键词时的默认库：教她接住日常并抛回
    const skillFileForTag = (t) => ({
      '接话延伸': '巧妙接话技巧：让沟通更流畅的实用指南.md',
      '情绪感知': '为他人提供情绪价值：温暖且有效的回应指南.md',
      '调侃张力': '实战话术编排器：从一句回复到后续分支.md',
      '主动框架': '场景感、松弛感与社交校准：从接话到关系推进.md'
    })[t]
    const skillCache = {}
    function detectSkillTags(userText) {
      const t = String(userText || '')
      const hit = []
      for (const [tag, kws] of Object.entries(SKILL_TAGS)) {
        if (kws.some((k) => t.includes(k))) hit.push(tag)
      }
      return hit
    }
    // 返回 { ctx, tags, fallback }：tags 是本轮实际用到的知识库标签（含兜底）。降级路径专用，全部常驻开启
    function buildSkillContext(userText) {
      let tags = detectSkillTags(userText)
      let fallback = false
      if (!tags.length) { tags = [FALLBACK_SKILL]; fallback = true }
      const selected = tags.slice(0, 2)
      if (!selected.length) return { ctx: '', tags: [], fallback }
      const parts = ['【对话技巧参考】']
      for (const tag of selected) {
        const file = skillFileForTag(tag)
        try {
          if (!skillCache[file]) skillCache[file] = readFileSync(join(REFS_DIR, file), 'utf8').slice(0, 3000)
          parts.push(`【${tag}】\n${skillCache[file]}`)
        } catch { /* 文件缺失则跳过该标签 */ }
      }
      return { ctx: parts.length > 1 ? '\n' + parts.join('\n\n') : '', tags: selected, fallback }
    }

    // ── 时间锚点感知（所有聊天轮都注入：现在几点 + 她这个时段大概在干嘛；从 relationship-stages 迁入）──
    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const timeLine = () => {
      const d = new Date()
      const hh = d.getHours()
      const weekend = d.getDay() === 0 || d.getDay() === 6
      const hm = `${String(hh).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      let doing
      if (hh >= 23 || hh < 6) doing = '深夜，她该睡了（可能在熬夜玩手机）'
      else if (hh < 8) doing = weekend ? '周末早上，她多半还没起' : '早上，她在洗漱或去教室的路上'
      else if (hh < 11) doing = weekend ? '周末上午，她自由安排' : '上午上课时间，她多半在上课，回消息可能慢'
      else if (hh < 13) doing = '午饭前后（11:30-12:30 吃饭），之后可能午休'
      else if (hh < 17) doing = weekend ? '周末下午，她自由安排' : '下午，可能有课也可能在宿舍'
      else if (hh < 19) doing = '晚饭时间（17:30-18:30 吃饭）'
      else doing = '晚上，她在宿舍或图书馆，自由时间'
      return `【现在时间】${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${hm}（${doing}）\n【时间感知】说话要符合现在的时段：不到饭点别说刚吃完饭，该上课的时段才说在上课；说「等下要去干嘛」要和上面的时段一致`
    }

    api.context(async ({ chat, sessionId }) => {
      if (chat && chat.kind === 'system') return ''
      const base = timeLine() + '\n' + buildInjection()
      if (!chat || chat.kind !== 'private' || String(chat.userId || '') !== api.config().ownerQQ) return base
      const s = api.settings()
      const userText = api.core?.hub?.lastTextOf?.(sessionId) || ''
      let ctx = '', entry
      // ── 军师链路径（常驻）：模型读懂意图 → 候选策略 → 选最优 → 选知识库 ──
      try {
        const adv = await advisorChain(userText, s, chat.chatId)
        ctx = `\n【军师分析·幕后】他的意图：${adv.intent}；情绪：${adv.emotion}\n【回复思路】${adv.guidance}`
        if (adv.kbName) ctx += `\n【知识库·${adv.kbName}】\n${adv.kbText}`
        ctx += '\n（以上是幕后分析，参考思路用你自己的话回，不要提及军师、分析过程或知识库）'
        entry = { t: Date.now(), user: String(userText).slice(0, 50), kind: 'advisor', ...adv, kbChars: ctx.length, mode: s.relationMode, sliders: `${s.humorLevel}/${s.proactivity}/${s.depth}`, her: s.herMbti || '', you: s.userMbti || '' }
      } catch (e) {
        // 军师失败自动降级为关键词匹配，聊天不受影响
        const fb = buildSkillContext(userText)
        ctx = fb.ctx
        entry = { t: Date.now(), user: String(userText).slice(0, 50), kind: 'fallback', error: e.message, tags: fb.tags, fallback: fb.fallback, kbChars: ctx.length, mode: s.relationMode, sliders: `${s.humorLevel}/${s.proactivity}/${s.depth}`, her: s.herMbti || '', you: s.userMbti || '' }
      }
      try {
        state.skillLog = state.skillLog || []
        const last = state.skillLog[state.skillLog.length - 1]
        // 同一轮 context 钩子会被调用两次（注入内容相同），5 秒内同文去重，别让日志翻倍
        if (!(last && last.user === entry.user && entry.t - last.t < 5000)) {
          state.skillLog.push(entry)
          if (state.skillLog.length > 100) state.skillLog = state.skillLog.slice(-100)
          saveState(state)
          const brief = entry.kind === 'advisor'
            ? `军师链：意图=${entry.intent} · 策略=${entry.candidates?.[entry.best]?.strategy || '?'} · 库=${entry.kbName || '无'} · ${entry.ms}ms`
            : `降级路径(${entry.kind})：${(entry.tags || []).join('+')}${entry.error ? ' · 原因=' + entry.error : ''}`
          api.log.info(`love-mode 本轮注入：模式=${MODES[s.relationMode]?.name} · 画像=她${s.herMbti || '?'}/你${s.userMbti || '?'} · ${brief}`)
        }
      } catch {}
      state.lastInjection = { t: Date.now(), user: String(userText).slice(0, 80), text: base + ctx }
      return base + ctx
    })

    // ── 自动匹配 ──
    const profile = (p) => ({
      mbti: MBTI_TYPES.includes(p?.mbti) ? p.mbti : '',
      strengths: String(p?.strengths ?? '').slice(0, 200),
      weaknesses: String(p?.weaknesses ?? '').slice(0, 200)
    })

    const autoMatch = async () => {
      let persona = ''
      try { persona = readFileSync(api.dataDir(join('..', '..', 'personas', 'dafeiyu.md')), 'utf8').slice(0, 2000) } catch {}
      let memText = '（暂无记忆）'
      try {
        if (api.has('memory')) {
          const mem = api.use('memory')
          const owner = api.config().ownerQQ || ''
          // 两路召回：通用关系词 + 定向召回「关于他」的条目（人物记忆 about=主人QQ，抽象词命中率低，要单独拉）
          const hits = await mem.recall('相处 聊天 关系 感觉 喜欢 习惯 性格', { limit: 12 })
          const aboutUser = owner ? await mem.recall('他 了了 喜欢 习惯 工作 生活 性格 约定', { about: owner, limit: 15 }) : []
          const parts = [...new Set([...(hits || []).map(h => h.text || String(h)), ...(aboutUser || []).map(h => h.text || String(h))])]
          if (parts.length) memText = parts.join('\n').slice(0, 3000)
          api.log.info(`love-mode 匹配素材：通用 ${(hits || []).length} 条 + 关于他 ${(aboutUser || []).length} 条`)
        }
      } catch (e) { api.log.info('love-mode 读记忆失败：' + e.message) }
      // 再补最近私聊实录：他的真实说话方式比记忆条目更直接
      try {
        const dialog = recentDialog('private:' + (api.config().ownerQQ || ''), 30)
        if (dialog) memText += '\n\n【最近私聊实录】\n' + dialog
      } catch {}

      const modeList = Object.entries(MODES).map(([k, m]) => `${k}=${m.name}`).join('，')
      const raw = await api.ask({
        system: '你是关系模式匹配器。只输出一个 JSON 对象，不要任何多余文字。',
        text: `根据以下素材，判断这对用户和 AI 伙伴目前最像哪种关系模式，并生成双方画像。\n\n可选模式：${modeList}\n\n【她的人格卡】\n${persona || '（无）'}\n\n【她的记忆与聊天梗概】\n${memText}\n\n输出 JSON：{"mode":"六选一","reason":"一句话理由","her":{"mbti":"16型之一","strengths":"一句话优势","weaknesses":"一句话短板"},"you":{"mbti":"16型之一","strengths":"一句话优势","weaknesses":"一句话短板"}}。her 是她（AI 伙伴），you 是用户。推断 you 时优先用【最近私聊实录】和关于他的记忆，分析他的说话风格和性格；素材不足就按 dating 给保守画像。`,
        maxTokens: 800,
        temperature: 1
      })
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      let data = null
      try { data = m ? JSON.parse(m[0]) : null } catch { data = null }
      if (!data || !MODES[data.mode]) return { ok: false, message: '素材不足或模型没返回有效结果，保持当前模式' }

      const s = api.settings()
      const her = profile(data.her), you = profile(data.you)
      const patch = {
        relationMode: data.mode,
        herMbti: her.mbti, herStrengths: her.strengths, herWeaknesses: her.weaknesses,
        userMbti: you.mbti, userStrengths: you.strengths, userWeaknesses: you.weaknesses,
        // 「锁定微调」功能已移除：自动匹配总是套模式默认滑块并清空基调覆盖
        humorLevel: MODES[data.mode].humor,
        proactivity: MODES[data.mode].proactivity,
        depth: MODES[data.mode].depth,
        personaTone: ''
      }
      api.saveSettings(patch)
      state = { ...state, matchedAt: new Date().toISOString(), matchReason: String(data.reason || '') }
      saveState(state)
      api.log.info(`love-mode 自动匹配：${MODES[data.mode].name}（${state.matchReason}）`)
      return { ok: true, mode: data.mode, modeName: MODES[data.mode].name, reason: state.matchReason }
    }

    // ── 路由（面板用）──
    const q = (req, k) => {
      try { return new URL(req?.url || '', 'http://x').searchParams.get(k) } catch { return null }
    }
    api.route('/state', () => {
      const cms = Array.isArray(api.settings().customModes) ? api.settings().customModes : []
      return {
        ok: true,
        settings: api.settings(),
        state,
        modes: Object.keys(MODES).map(k => ({ value: k, label: MODES[k].name }))
          .concat(cms.map(m => ({ value: 'c_' + m.id, label: (m.name || '自定义模式') + '（自建）' }))),
        modeDetails: Object.fromEntries(
          Object.entries(MODES).map(([k, m]) => [k, { name: m.name, tone: m.tone, humor: m.humor, proactivity: m.proactivity, depth: m.depth }])
            .concat(cms.map(m => ['c_' + m.id, { name: m.name || '自定义模式', tone: m.tone || '', humor: m.humor ?? 65, proactivity: m.proactivity ?? 55, depth: m.depth ?? 50 }]))
        ),
        skills: Object.entries(SKILLS).map(([k, v]) => ({ key: k, name: v.name, needsSpeakUp: v.needsSpeakUp })),
        modeSkills: getMode().skills,
        speakUpOn: api.has('speakup'), // 以模块实际在跑为准（relationship-stages 会关掉配置开关但仍调度 speakup.fire）
        mbtiTypes: MBTI_TYPES
      }
    })
    api.route('/auto-match', async () => {
      try { return await autoMatch() } catch (e) { return { ok: false, message: '自动匹配失败：' + e.message } }
    })
    api.route('/set-mode', (req) => {
      const mode = q(req, 'mode') || 'dating'
      const cms = Array.isArray(api.settings().customModes) ? api.settings().customModes : []
      const isCustom = mode.startsWith('c_')
      if (!MODES[mode] && !(isCustom && cms.some((m) => 'c_' + m.id === mode))) return { ok: false, message: '未知模式：' + mode }
      const patch = { relationMode: mode }
      if (!isCustom) Object.assign(patch, {
        // 「锁定微调」已移除：切预设模式总是套默认滑块并清空基调覆盖
        humorLevel: MODES[mode].humor,
        proactivity: MODES[mode].proactivity,
        depth: MODES[mode].depth,
        personaTone: ''
      })
      api.saveSettings(patch)
      const name = isCustom ? (cms.find((m) => 'c_' + m.id === mode)?.name || '自定义模式') : MODES[mode].name
      return { ok: true, mode, modeName: name }
    })
    // 自建模式增删改：POST {action:'create'} → {id}；{action:'update', id, ...fields}；{action:'delete', id}
    api.route('/custom-modes', (req) => {
      let query = {}
      try { query = Object.fromEntries(new URL(req?.url || '', 'http://x').searchParams) } catch {}
      const body = { ...query, ...(api.core?.http?.body?.(req) || {}) }
      const s = api.settings()
      const cms = Array.isArray(s.customModes) ? s.customModes.slice() : []
      if (body.action === 'create') {
        const id = Date.now().toString(36)
        cms.push({ id, name: String(body.name || '新模式').slice(0, 20), tone: String(body.tone || '').slice(0, 800), humor: 65, proactivity: 55, depth: 50 })
        api.saveSettings({ customModes: cms })
        return { ok: true, id, modeKey: 'c_' + id }
      }
      const i = cms.findIndex((m) => m.id === body.id)
      if (i < 0) return { ok: false, message: '没找到这个模式' }
      if (body.action === 'delete') {
        cms.splice(i, 1)
        const patch = { customModes: cms }
        if (s.relationMode === 'c_' + body.id) patch.relationMode = 'dating'
        api.saveSettings(patch)
        return { ok: true }
      }
      if (body.action === 'update') {
        const m = cms[i]
        if (body.name !== undefined) m.name = String(body.name).slice(0, 20)
        if (body.tone !== undefined) m.tone = String(body.tone).slice(0, 800)
        for (const k of ['humor', 'proactivity', 'depth']) if (body[k] !== undefined) m[k] = Math.max(0, Math.min(100, Number(body[k]) || 0))
        api.saveSettings({ customModes: cms })
        return { ok: true }
      }
      return { ok: false, message: '未知 action：' + body.action }
    })
    // 知识库使用日志：每轮私聊记一条（军师链：意图/候选/选择/思路/查库；降级：关键词），最近 50 条
    api.route('/skill-log', () => {
      const s = api.settings()
      const cms = Array.isArray(s.customModes) ? s.customModes : []
      return {
        ok: true,
        items: (state.skillLog || []).slice(-50).reverse(),
        modeNames: Object.fromEntries(Object.keys(MODES).map(k => [k, MODES[k].name]).concat(cms.map(m => ['c_' + m.id, m.name || '自定义模式'])))
      }
    })
    // 最近一次完整注入内容（验证人设/画像/滑块/知识库到底给她看了什么）
    api.route('/last-injection', () => ({ ok: true, ...(state.lastInjection || { t: 0, user: '', text: '（还没有私聊轮次）' }) }))

    // ── 首次启动后台自动匹配（等插件加载完，30 秒后）──
    if (!state.matchedAt) {
      api.later(30_000, () => {
        autoMatch().then((r) => { if (api.settings().debug) api.log.info('love-mode 首启匹配：' + JSON.stringify(r)) })
          .catch((e) => api.log.info('love-mode 首启匹配失败：' + e.message))
      })
    }

    // ── 回复保险丝（从 relationship-stages 迁入并扩展）：剥掉模型/代理泄漏的杂质 ──
    // HTML 保险丝：剥段落标签（不影响 aurabot 的 <voice>/<sticker>/<poke> 标记）
    api.on('reply', (text) => {
      if (typeof text !== 'string' || !text.includes('<')) return
      const cleaned = text
        .replace(/<\/?(p|div|span|br|hr|b|i|u|em|strong|h[1-6]|ul|ol|li|blockquote|font)[^>]*>/gi, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
      return cleaned === text ? undefined : cleaned
    })

    // 协议碎片保险丝 v3：核心层（chat/reply.js）会先剥完整配对的协议标签，
    // 但截断泄漏会留下残片：① DSML 工具标签 ② 残留 JSON 负载 ③ ACP 元数据标签 ④ [ACP] 错误行
    api.on('reply', (text) => {
      if (typeof text !== 'string') return
      let cleaned = text
      // ACP 元数据标签泄漏：上下文代理给每条消息注入 <acp ...>mNNNNN</acp>，模型偶发当文本模仿输出
      if (cleaned.includes('<acp') || cleaned.includes('</acp>')) {
        cleaned = cleaned
          .replace(/<acp\b[^>]*>\s*m\d{4,6}\s*(<\/acp>)?/g, '')
          .replace(/<\/?acp\b[^>]*>/g, '')
      }
      // [ACP] 代理错误行（如 "❌ [ACP] stream error: ..."）：剥到行尾或下一个 [ 标记（保住 [sticker] 等占位符）
      if (cleaned.includes('[ACP]')) {
        cleaned = cleaned.replace(/❌?\s*\[ACP\][^\n[]*/g, '')
      }
      // 成对出现：两个 DSML 标签连同中间内容一起剥；孤立标签只剥标签
      if (cleaned.includes('DSML')) {
        cleaned = cleaned
          .replace(/<\/?｜｜DSML｜｜[^>]*>[\s\S]*?<\/?｜｜DSML｜｜[^>]*>/g, '')
          .replace(/<\/?｜｜DSML｜｜[^>]*>/g, '')
      }
      // 末尾的 JSON 工具负载残片：从最后一个 {" 到结尾。判定：含 JSON 键值形（":"）或整段无中文
      const ji = cleaned.lastIndexOf('{"')
      if (ji >= 0) {
        const tail = cleaned.slice(ji)
        if (/":\s*"?/.test(tail) || !/[一-鿿]/.test(tail)) cleaned = cleaned.slice(0, ji)
      }
      cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').trim()
      if (cleaned === text.trim()) return undefined
      if (!cleaned) { api.log.warn(`保险丝拦下整条回复（全是协议碎片），原文：${String(text).slice(0, 300)}`); return null } // 整条都是泄漏碎片，别发
      return cleaned
    })

    api.log.info(`love-mode v${VERSION} 已启动（当前模式：${getMode().name}）`)

    return {
      proactivityMultiplier: () => 0.5 + (Number(api.settings().proactivity) / 100) * 1.5,
      dispose() {}
    }
  }
}
