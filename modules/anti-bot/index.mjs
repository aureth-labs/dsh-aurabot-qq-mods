// 人机反面教材 —— 看到别的 AI 机器人评论，一眼认出来，就把它当反面例子记住，自己别那么说
//
// 主人 2026-11-10 的要求：「看到评论区有其他的 AI 机器人的时候，看他评论，你一眼看出就是人机，
// 你就把它当成反例」
//
// 思路：
//   1) 从 B 站评论里认出「一眼人机」的（启发式打分，不靠模型也能认出大多数）
//   2) 存进「反面教材库」，记下它为什么像机器人（哪几条特征命中）
//   3) 每轮聊天时，把最能代表「AI 味」的几条当反面例子塞进她的上下文：
//      「下面这些话别这么说」——比讲抽象规则有效得多
//
// 私聊 / 群聊都能带上；也可以手动把某句话喂进来当教材。

import fs from 'node:fs'
import path from 'node:path'

// 一眼人机的特征：命中越多越像
const TELLS = [
  { id: 'assistant_voice', w: 5, re: /(作为(一个|一名)?\s*(AI|人工智能|AI\s*助手|语言模型|大模型)|我是(一个|一名)?\s*(AI|人工智能|语言模型)|我(无法|不能)提供|我无法(回答|评价|判断)|希望(这|以上)?(能|对)(对)?你(有(所)?帮助)?|很高兴(为您|为你)|为您服务|请问还有什么)/i, why: '客服腔/AI 自述' },
  { id: 'listy', w: 5, re: /(首先[，,].{0,40}其次|第一[，,、].{0,40}第二|1[.、].{0,30}\n?.{0,10}2[.、]|以下几点|(总结|归纳)一下|综上|值得一提|需要注意的(几点|是))/s, why: '列点/总结体' },
  { id: 'heading', w: 3, re: /(^|\n)\s*(#+\s|\*\*[^*\n]{2,24}\*\*|【[^】\n]{2,20}】\s*($|\n))/m, why: '标题/加粗排版' },
  { id: 'balanced', w: 3, re: /(总的来说|总体而言|总之|需要指出的是|值得注意的是|不可否认|综上所述|客观(地)?(来)?看|从某种(意义|角度))/, why: '公文体转折' },
  { id: 'emoji_wall', w: 2, re: /((?:[\u{1F300}-\u{1FAFF}]|\[[^\]]{1,10}\])\s*){3,}/u, why: '表情堆砌' },
  { id: 'overpolite', w: 2, re: /(感谢(您的)?(分享|观看|支持|阅读)|祝您|希望(这|以上)?(能|对)(对)?你(有(所)?帮助)?|如有(任何)?(疑问|问题).{0,10}欢迎|欢迎(随时)?(留言|评论|讨论))/, why: '过度客套' },
  { id: 'hedge', w: 1, re: /(可能(会|有)一定|在一定程度上|可以说是|从某种(意义|角度)上说|相对而言)/, why: '模糊限定词堆砌' },
  { id: 'too_complete', w: 2, re: /^[\s\S]{150,}$/, why: '一条评论写成长文' },
  { id: 'parallel', w: 1, re: /(既.{2,12}又.{2,12}还|不仅.{2,12}而且.{2,12}更)/, why: '排比套话' },
]

// 真人说话的样子（有这些就减分，别误杀）
const HUMAN_MARKS = [
  /(草|卧槽|我靠|啊这|笑死|哈哈哈哈|hhh|233|绷不住|离谱|绝了|好耶|牛|6+|真的服|救命|awsl|乐|麻了|破防|上头|逆天)/i,
  /(我也|我上次|我之前|我昨天|刚刚|刚才|我室友|我妈|我爸|我朋友|我们班)/,
  /^[^。！？\n]{1,10}$/,               // 很短
  /(\.{3,}|…{2,})/,                  // 省略号留白
  /[？?]{2,}/,                       // 连问
]

function scoreText(text) {
  const t = String(text || '').trim()
  if (!t) return { score: 0, hits: [] }
  let score = 0
  const hits = []
  for (const x of TELLS) {
    if (x.re.test(t)) { score += x.w; hits.push(x.why) }
  }
  for (const re of HUMAN_MARKS) {
    if (re.test(t)) score -= 1
  }
  // 太短的别判（「好」「哈哈」这种没法说人机）
  if (t.length < 6) score -= 3
  return { score, hits }
}

const isBotlike = (text) => scoreText(text).score >= 4

// ---------- 反面教材之外：真人金句 ----------
// 主人 2026-11-10 追加：「顺便也可以截取真人的评论，加以学习，看有什么有意思的金句，也学一下」
//
// 怎么判「这句是真人说的、还挺有意思」：
//   1) 先排除人机（score < 门槛）
//   2) 有真人味（口癖、自述、短、留白、连问）
//   3) 有点「东西」：比喻、反转、自嘲、具体细节、画面感 —— 用几个弱信号加起来
const WIT_MARKS = [
  { id: 'reversal', w: 2, re: /(结果|没想到|居然是|反而|笑不活了|白给|翻车|打脸|反转|也就图一乐|还真得看|还得看|不过是)/, why: '有反转/对比' },
  // ⚠ 这里的 `跟.{1,8}一样` 之前误写成字面量「跟…一样」，永远匹配不上，已修正
  { id: 'metaphor', w: 2, re: /(像极了?|跟.{1,10}一样|活像|简直是|堪比|犹如|仿佛|像.{1,20}的(我|手|命))/, why: '有比喻' },
  { id: 'selfmock', w: 2, re: /(我是废物|我不配|就我|只有我|我人麻了|我寄了|菜就多练|我哭死|我没了|我也是孩子|月份大了点|没清醒的认知)/, why: '自嘲' },
  { id: 'concrete', w: 2, re: /(\d+[块元岁次天年个遍集小时分钟秒]|[一二两三四五六七八九十][次集天年个遍小时分钟秒]|第[一二三四五六七八九十\d]+[次集天]|我妈|我爸|我室友|我们班|楼下|隔壁|昨天|前天|上次)/, why: '具体细节' },
  { id: 'punchy', w: 1, re: /^[^。\n]{4,20}[！!？?]?$/, why: '短促有力' },
  { id: 'dialect', w: 1, re: /(咱|俺|弄啥|整|搁|得嘞|属实|贼|贼拉|老铁|巴适|安逸|俺们)/, why: '口语/方言' },
  { id: 'emojiOne', w: 1, re: /[😂🤣😭😅🤡💀🔥👏🙏]$/, why: '结尾一个表情刚好' },
  // B 站评论爱用的 [doge][笑哭][大哭] 这类站内表情：一个=有情绪，堆三个以上=表情堆砌（判人机用）
  { id: 'biliEmoji', w: 1, re: /\[[^\]]{1,10}\]/, why: '站内表情当语气' },
  // 下面几条是拿真评论跑出来的：B 站真人爱用的几种「有意思」，之前全漏
  { id: 'hyperbole', w: 2, re: /(可观测宇宙|全宇宙|全世界最|人类史上|史上最|宇宙级|天花板|封神|永远的神)/, why: '夸张到好笑' },
  { id: 'parody', w: 2, re: /(今犹在|不见当年|此情可待|人生若只如|雕栏玉砌|犹抱琵琶|安得广厦|何以解忧|问君能有)/, why: '化用古诗' },
  { id: 'summary', w: 1, re: /^(省流|一句话|总结)[:：]/, why: '简洁断言' },
  { id: 'absurd', w: 2, re: /(也就图一乐|真.{1,6}还得看|图一乐|专业人士|一看就是|这波啊|这操作|属于是)/, why: '嘴上吐槽' },
]

function scoreWit(text) {
  const t = String(text || '').trim()
  if (!t) return { score: 0, hits: [] }
  const { score: bot } = scoreText(t)
  if (bot >= 4) return { score: -9, hits: ['先被人机判定挡掉'] }

  // 占位符 / 纯表情 / 纯标点：这些是聊天里的「非文字」，没有语感可学
  // 例：[图片]、[动画表情]、[合并转发]、[戳了戳你：戳了戳]、[沉默]
  const stripped = t
    .replace(/\[[^\]]{0,30}\]/g, '')      // 方括号占位符
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '') // emoji
    .replace(/[\s\p{P}]/gu, '')            // 空白和标点
  if (stripped.length < 3) return { score: -9, hits: ['没实质文字（占位符/表情）'] }
  // 剩下的基本就是占位符拼起来的
  if (/^([^\u4e00-\u9fa5A-Za-z]*)$/.test(stripped)) return { score: -9, hits: ['没实质文字'] }

  // 太短不算金句（「刚刚响了四次」「好」「哈哈」这种没结构可学）
  if (t.length < 6) return { score: 0, hits: ['太短'] }
  if (t.length > 80) return { score: 0, hits: ['太长了，不像评论'] }

  let score = 0
  const hits = []
  // 真人底子：命中几条人味
  let human = 0
  for (const re of HUMAN_MARKS) if (re.test(t)) human++
  // 有第一人称、口语助词、句末语气，也算人味（放宽，别把好句子漏掉）
  if (/我/.test(t)) human++
  if (/(啊|吧|呢|嘛|呗|咯|哈|诶|欸|唉|哦|噢)/.test(t)) human++
  score += Math.min(human, 3)

  for (const x of WIT_MARKS) {
    if (x.re.test(t)) { score += x.w; hits.push(x.why) }
  }

  // 命中「强结构」（反转/比喻/自嘲/夸张/化用/吐槽）本身就说明是真人写的，
  // 再加 1 分基础人味 —— 否则像「faker v bin今犹在 不见当年斧王酱」这种
  // 既没口癖也没第一人称的好句子会卡在门槛下面
  const STRONG = ['有反转/对比', '有比喻', '自嘲', '夸张到好笑', '化用古诗', '嘴上吐槽']
  const strongHits = hits.filter((h) => STRONG.includes(h))
  if (strongHits.length) score += 1

  // 没有强结构、只有「具体细节」的（「刚刚响了四次」这种）不算金句：
  // 它是句真人话，但没有值得学的「架子」，收进去只会稀释库
  const notPunchy = hits.filter((h) => h !== '短促有力').length
  if (!strongHits.length) return { score: Math.min(score, 2), hits }
  return { score: notPunchy >= 1 ? score : Math.min(score, 1), hits }
}

const isGoodLine = (text, threshold = 3) => scoreWit(text).score >= threshold

export default {
  id: 'anti-bot',
  name: '人机反面教材',
  version: '1.1.0',
  api: 1,
  description: '从评论区认出「一眼人机」的 AI 发言，当反面教材记下来，自己别那么说',
  defaults: {
    enabled: true,
    threshold: 4,          // 打分到多少算「一眼人机」
    injectCount: 3,        // 每轮塞几条反面例子
    injectWhere: 'both',   // private / group / both
    learnFromBili: true,   // 看 B 站视频时顺手从评论里学
    maxStore: 60,          // 最多存多少条反面例子
    ownerSayTells: true,   // 把「一眼人机的特征」也讲给她听
    learnGoodLines: true,  // 同时收真人金句
    goodThreshold: 3,      // 金句门槛（越高越挑）
    maxGood: 60,           // 最多存多少条金句
    injectGood: 2,         // 每轮塞几条金句（学语感）
    ownerSayWit: true,     // 讲给她「什么样的句子有意思」
    injectMaxChars: 700,   // 塞进上下文的字数上限
    expireDays: 60,        // 多久没再命中就清掉（避免库里越堆越旧）
    muteBots: true,        // 认出来的人机评论不学它的说话方式（只当反例）
  },
  settings: [
    { key: 'enabled', label: '打开', type: 'switch' },
    { key: 'threshold', label: '认人机的门槛（越高越严）', type: 'number', min: 2, max: 10, step: 1, hint: '默认 4；调到 6 只认特别明显的' },
    { key: 'injectCount', label: '每轮塞几条反面例子', type: 'number', min: 0, max: 6, step: 1 },
    { key: 'injectWhere', label: '在哪儿提醒', type: 'select', options: [
      { value: 'both', label: '私聊 + 群聊' },
      { value: 'private', label: '只在私聊' },
      { value: 'group', label: '只在群聊' },
      { value: 'off', label: '不提醒（只收集）' },
    ] },
    { key: 'learnFromBili', label: '看 B 站时顺手从评论里学', type: 'switch' },
    { key: 'maxStore', label: '最多存多少条反面例子', type: 'number', min: 10, max: 200, step: 10 },
    { key: 'ownerSayTells', label: '把「人机的特征」也讲给她', type: 'switch' },
    { key: 'learnGoodLines', label: '同时收真人金句', type: 'switch', hint: '从评论里挑那种「有反转/有比喻/自嘲/具体细节」的真人话' },
    { key: 'goodThreshold', label: '金句门槛（越高越挑）', type: 'number', min: 1, max: 10, step: 1, hint: '默认 3' },
    { key: 'maxGood', label: '最多存多少条金句', type: 'number', min: 10, max: 200, step: 10 },
    { key: 'injectGood', label: '每轮塞几条金句', type: 'number', min: 0, max: 6, step: 1, hint: '让她感受真人怎么把话说得有意思' },
    { key: 'ownerSayWit', label: '讲给她「什么样的句子有意思」', type: 'switch' },
    { key: 'injectMaxChars', label: '塞进上下文的字数上限', type: 'number', min: 200, max: 2000, step: 100, hint: '别让这几条把上下文吃满' },
    { key: 'expireDays', label: '多少天后自动清掉旧条目', type: 'number', min: 0, max: 365, step: 5, hint: '0 = 不自动清' },
  ],
  panel: 'panel.js',

  setup(api) {
    const S = () => ({ ...api.defaults, ...api.settings() })
    const log = (m) => { try { api.log.info(m) } catch {} }
    const warn = (m) => { try { api.log.warn(m) } catch {} }

    const dataDir = api.dataDir()
    const storeFile = path.join(dataDir, 'reverses.json')   // 反面教材（人机）
    const linesFile = path.join(dataDir, 'goods.json')      // 正面（真人金句）

    function loadAny(file) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'))
        return Array.isArray(j?.items) ? j : { items: [] }
      } catch { return { items: [] } }
    }
    const load = () => loadAny(storeFile)
    function save(s) {
      try { fs.writeFileSync(storeFile, JSON.stringify(s, null, 2), 'utf8') } catch (e) { warn('存反面教材失败：' + String(e?.message || e)) }
    }
    const loadGood = () => loadAny(linesFile)
    function saveGood(s) {
      try { fs.writeFileSync(linesFile, JSON.stringify(s, null, 2), 'utf8') } catch (e) { warn('存金句失败：' + String(e?.message || e)) }
    }

    function keyOf(t) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase() }

    // 收一条反面教材（去重、限量）
    function remember(text, { source = '', why = '' } = {}) {
      const t = String(text || '').trim()
      if (!t) return false
      const { score, hits } = scoreText(t)
      const th = Number(S().threshold) || 4
      if (!why && score < th) return false
      const s = load()
      const k = keyOf(t)
      if (s.items.some((x) => keyOf(x.text) === k)) return false
      s.items.unshift({
        at: Date.now(),
        text: t.slice(0, 300),
        why: why || (hits.join('、') || '类似人机'),
        score,
        source: String(source || '').slice(0, 80),
      })
      const cap = Math.max(10, Number(S().maxStore) || 60)
      s.items = s.items.slice(0, cap)
      save(s)
      log(`记下一条反面教材（${score} 分，${s.items[0].why}）：${t.slice(0, 40)}`)
      return true
    }

    // 收一条真人金句（去重、限量）
    function rememberGood(text, { source = '', why = '' } = {}) {
      const t = String(text || '').trim()
      if (!t) return false
      const { score, hits } = scoreWit(t)
      const th = Number(S().goodThreshold) || 3
      if (!why && score < th) return false
      const s = loadGood()
      const k = keyOf(t)
      if (s.items.some((x) => keyOf(x.text) === k)) return false
      s.items.unshift({
        at: Date.now(),
        text: t.slice(0, 300),
        why: why || (hits.join('、') || '挺有意思'),
        score,
        source: String(source || '').slice(0, 80),
      })
      const cap = Math.max(10, Number(s.maxGood) || 60)
      s.items = s.items.slice(0, cap)
      saveGood(s)
      log(`记下一条金句（${score} 分）：${t.slice(0, 40)}`)
      return true
    }

    // 从一批评论里两头收：人机进反面，真人妙语进正面
    function harvest(list, title = '') {
      if (!S().enabled || !S().learnFromBili) return { bots: 0, goods: 0 }
      let bots = 0, goods = 0
      for (const c of list) {
        const text = typeof c === 'string' ? c : (c?.text || '')
        const src = title ? `B站《${title}》评论` : 'B站评论'
        if (remember(text, { source: src })) { bots++; continue }
        if (rememberGood(text, { source: src })) goods++
      }
      if (bots || goods) log(`从评论里学到：人机反例 ${bots} 条，真人金句 ${goods} 条`)
      return { bots, goods }
    }

    // ---------- 从 B 站评论里学 ----------
    api.on('bili/comments', (payload) => {
      const list = Array.isArray(payload) ? payload : (payload?.comments || [])
      harvest(list, payload?.title || '')
    })

    // ---------- 规则：知道有这回事 ----------
    api.rule(() => {
      if (!S().enabled) return ''
      const lines = [
        '【别像人机】评论区里那种一眼就是 AI 的发言（客服腔、列点总结、标题加粗、表情堆砌、过度客套、一条评论写成长文），别学它们。',
        '自己说话正常点：想到什么说什么，短句，允许有语气、停顿、半句话。',
      ]
      if (S().ownerSayTells) {
        lines.push(`这些是典型人机特征：${TELLS.slice(0, 5).map((x) => x.why).join('、')}。命中两三条就很像了。`)
      }
      if (S().learnGoodLines && S().ownerSayWit) {
        lines.push(`反过来，真人说得有意思的句子通常有：${WIT_MARKS.slice(0, 5).map((x) => x.why).join('、')}。`)
        lines.push('学他们的语感，不是抄句子：抄结构、抄那个转折和细节的劲儿。')
      }
      return lines.join('\n')
    })

    // ---------- 上下文：反面例子 + 正面金句 ----------
    // 轮换：不能每轮都塞同样几条，否则她只会死记那两句，学不到「这一类」
    let rotBad = 0
    let rotGood = 0
    const pickRotating = (items, n, rotKey) => {
      if (!items.length || n <= 0) return []
      const start = rotKey % items.length
      const out = []
      for (let i = 0; i < Math.min(n, items.length); i++) out.push(items[(start + i) % items.length])
      return out
    }

    api.on('prompt', (content, { chat } = {}) => {
      const s = S()
      if (!s.enabled || s.injectWhere === 'off') return
      const isGroup = chat?.kind === 'group'
      if (s.injectWhere === 'private' && isGroup) return
      if (s.injectWhere === 'group' && !isGroup) return

      const blocks = []

      const n = Math.max(0, Number(s.injectCount) || 0)
      const allBad = load().items
      const bad = pickRotating(allBad, n, rotBad++)
      if (bad.length) {
        blocks.push([
          '【这些别学】（别人发的 AI 味发言，反面教材）',
          ...bad.map((x, i) => `${i + 1}. 「${x.text.slice(0, 90)}」 ← ${x.why}`),
          '自己别用这种调子说话。',
        ].join('\n'))
      }

      const g = s.learnGoodLines ? Math.max(0, Number(s.injectGood) || 0) : 0
      const allGood = loadGood().items
      const good = pickRotating(allGood, g, rotGood++)
      if (good.length) {
        blocks.push([
          '【真人怎么说的】下面这些是评论区里真人说得有意思的话，感受一下那个劲儿（学语感，别照抄）：',
          ...good.map((x, i) => `${i + 1}. 「${x.text.slice(0, 90)}」`),
        ].join('\n'))
      }

      if (!blocks.length) return
      let block = blocks.join('\n\n')
      // 总长度兜底：别让这几条把上下文吃满
      const cap = Math.max(200, Number(s.injectMaxChars) || 700)
      if (block.length > cap) block = block.slice(0, cap) + '…'
      if (Array.isArray(content)) return [...content, { type: 'text', text: block }]
      return String(content || '') + '\n\n' + block
    })

    // ---------- 工具：她可以自己判断并记下来 ----------
    api.tool(({ chat }) => {
      if (chat?.kind === 'system') return []
      return [
        api.defineTool({
          name: 'mark_bot_comment',
          description: '把一句「一眼就是 AI 机器人」的话记成反面教材，自己以后别那么说。可以给原句和它为什么像人机。',
          properties: {
            text: { type: 'string', description: '那句像人机的话' },
            why: { type: 'string', description: '为什么像人机（可选）' },
          },
          required: ['text'],
          execute: async ({ text, why } = {}) => {
            const ok = remember(text, { why: why || '', source: '她自己在评论区认出来的' })
            return ok
              ? { ok: true, message: '记下了，以后我不这么说' }
              : { ok: false, message: '这句不够像人机，或者已经记过了' }
          },
        }),
        api.defineTool({
          name: 'save_good_line',
          description: '把评论区里真人说得有意思的一句话收起来当学习材料（有反转、比喻、自嘲、具体细节那种）。',
          properties: {
            text: { type: 'string', description: '那句有意思的真人话' },
            why: { type: 'string', description: '好在哪儿（可选）' },
          },
          required: ['text'],
          execute: async ({ text, why } = {}) => {
            const ok = rememberGood(text, { why: why || '', source: '她自己在评论区挑的' })
            return ok
              ? { ok: true, message: '收下了，这个劲儿我学学' }
              : { ok: false, message: '这句不太够格，或者已经收过了' }
          },
        }),
      ]
    })

    // ---------- 命令 ----------
    api.command({
      name: '人机',
      aliases: ['反例', 'antibots'],
      desc: '/人机 —— 看反例；/人机 加 这句话 —— 手动收一条反例',
      run: (arg, msg) => {
        const a = String(arg || '').trim()
        if (!a || a === '列表' || a === 'list') {
          const items = load().items.slice(0, 10)
          if (!items.length) return '反面教材库还是空的'
          return '反面教材（最近 10 条）：\n' + items.map((x, i) => `${i + 1}. 「${x.text.slice(0, 50)}」← ${x.why}`).join('\n')
        }
        const text = a.replace(/^(加|添加|记)\s*/, '')
        const ok = remember(text, { source: `主人手动喂的（${msg?.nickname || '主人'}）`, why: '主人指定' })
        return ok ? `记下了：「${text.slice(0, 40)}」` : '这句要么已经记过了，要么看着不太像人机'
      },
    })

    api.command({
      name: '金句',
      aliases: ['好句', 'goodlines'],
      desc: '/金句 —— 看收的真人性句；/金句 加 那句话 —— 手动收一条',
      run: (arg, msg) => {
        const a = String(arg || '').trim()
        if (!a || a === '列表' || a === 'list') {
          const items = loadGood().items.slice(0, 10)
          if (!items.length) return '金句库还是空的'
          return '真人金句（最近 10 条）：\n' + items.map((x, i) => `${i + 1}. 「${x.text.slice(0, 50)}」`).join('\n')
        }
        const text = a.replace(/^(加|添加|记|收)\s*/, '')
        const ok = rememberGood(text, { source: `主人手动喂的（${msg?.nickname || '主人'}）`, why: '主人指定' })
        return ok ? `收下了：「${text.slice(0, 40)}」` : '这句要么已经收过了，要么不太够格'
      },
    })

    // ---------- 面板 ----------
    api.route('/state', async () => {
      const s = S()
      const st = load()
      const gd = loadGood()
      const today = st.items.filter((x) => Date.now() - x.at < 86400000).length
      const todayG = gd.items.filter((x) => Date.now() - x.at < 86400000).length
      return {
        ok: true,
        enabled: !!s.enabled,
        threshold: Number(s.threshold),
        injectCount: Number(s.injectCount),
        injectWhere: s.injectWhere,
        learnFromBili: !!s.learnFromBili,
        total: st.items.length,
        today,
        items: st.items.slice(0, 20).map((x) => ({ at: x.at, text: x.text, why: x.why, score: x.score, source: x.source })),
        learnGoodLines: !!s.learnGoodLines,
        goodThreshold: Number(s.goodThreshold),
        injectGood: Number(s.injectGood),
        goodTotal: gd.items.length,
        goodToday: todayG,
        goods: gd.items.slice(0, 20).map((x) => ({ at: x.at, text: x.text, why: x.why, score: x.score, source: x.source })),
      }
    })

    // 手动测一句像不像人机 / 够不够金句
    api.route('/test', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const text = String(b?.text || '')
      const r = scoreText(text)
      const w = scoreWit(text)
      return {
        ok: true,
        score: r.score, hits: r.hits, botlike: r.score >= (Number(S().threshold) || 4),
        wit: w.score, witHits: w.hits, good: w.score >= (Number(S().goodThreshold) || 3),
      }
    })

    api.route('/add', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const ok = remember(String(b?.text || ''), { why: String(b?.why || ''), source: '面板手动加的' })
      return { ok, message: ok ? '记下了' : '没记（重复或不够像人机）' }
    })

    api.route('/add-good', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const ok = rememberGood(String(b?.text || ''), { why: String(b?.why || ''), source: '面板手动加的' })
      return { ok, message: ok ? '收下了' : '没收（重复或不太够格）' }
    })

    api.route('/remove', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const k = keyOf(String(b?.text || ''))
      const st = load()
      const before = st.items.length
      st.items = st.items.filter((x) => keyOf(x.text) !== k)
      save(st)
      return { ok: before !== st.items.length }
    })

    api.route('/remove-good', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const k = keyOf(String(b?.text || ''))
      const st = loadGood()
      const before = st.items.length
      st.items = st.items.filter((x) => keyOf(x.text) !== k)
      saveGood(st)
      return { ok: before !== st.items.length }
    })

    // 把一批评论整批喂进来（现在用来学 B 站评论；以后别的平台也能用）
    api.route('/harvest', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      const list = Array.isArray(b?.comments) ? b.comments : String(b?.text || '').split('\n')
      const r = harvest(list, String(b?.title || ''))
      return { ok: true, ...r }
    })

    // 定期清理过期条目（默认 60 天没动过的）
    function pruneOld() {
      const s = S()
      const days = Number(s.expireDays) || 0
      if (days <= 0) return
      const cutoff = Date.now() - days * 86400000
      const a = load()
      const beforeA = a.items.length
      a.items = a.items.filter((x) => (x.at || 0) >= cutoff)
      if (a.items.length !== beforeA) { save(a); log(`清掉 ${beforeA - a.items.length} 条过期反例`) }
      const b = loadGood()
      const beforeB = b.items.length
      b.items = b.items.filter((x) => (x.at || 0) >= cutoff)
      if (b.items.length !== beforeB) { saveGood(b); log(`清掉 ${beforeB - b.items.length} 条过期金句`) }
    }
    api.every(6 * 3600_000, pruneOld, '清理过期教材')

    log(`人机反面教材就位（门槛 ${S().threshold} 分，每轮塞 ${S().injectCount} 条反例 + ${S().injectGood} 条金句）`)
    return { remember, rememberGood, load, loadGood, scoreText, scoreWit, harvest }
  },
}
