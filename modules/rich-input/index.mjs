/**
 * rich-input —— 让她真的「看得见」。
 *
 * 插件 v1.1.x 原生行为里，有两处让她看不见东西：
 *   1. 消息文本里图片只是占位「[图片]」。插件会把图下载成 base64 的 image 块交给模型，
 *      但只在「判得出这个模型能看图」时才做（model.vision=auto 时看模型元数据；
 *      判不出来就只给文字）——于是她常常只看到一行「[图片]」，回一句「我这边看不清楚」。
 *   2. 合并转发只在「触发她回复的那一条」里展开一次，格式是多行「昵称：内容」；
 *      群里上下文里别人的转发、同一批里更早的、引用里的、排队时攒下的，都只剩「[合并转发]」。
 *
 * 这个模块只用公开扩展接口（不改插件核心）：
 *   - message 事件：记下每条消息的图片段 / 转发 id（图片 10 分钟 TTL），
 *     **收到转发的那一刻就先去把内容拉下来存好**（后台进行，不挡她处理消息）。
 *     这一步是 v1.6.0 的关键：插件只在「这一条正好叫到她」时才展开转发，
 *     群里绝大多数转发她根本不回，等下一轮再拉时消息可能早被挤出窗口、转发 id 也过期了。
 *   - prompt 事件：交给她之前把文本里的「[合并转发]」换成 {昵称(QQ):内容;…}；
 *     另外把「她还没看过、这一轮内容里又没出现」的转发补成一段放在末尾
 *     （覆盖群里没被叫到、会话轮换、被挤出窗口这些情况）；图片则按下面三条路处理。
 *
 * 图片的三条路（v1.3.0）：
 *   ① 目标模型自己就能看图 → 直接把 base64 image 块塞进去（和以前一样）。
 *   ② 目标模型看不了图（DSH 元数据里没有 image）→ 用一个「能看图的模型」把图片转成文字
 *      （设置里的「用哪个模型看图」，走 api.core.ask，带图片，不进她的会话）。
 *   ③ ② 失败（报错 / 超时 / 没配主模型）→ 换成「回退模型」再试一次（同样是带图的 ask）。
 *      没填回退模型时自动挑一个和主模型不同的、能看图的模型。
 *   ②③ 都不成 → 退回 ①，至少别比现在更差。
 *
 * 注意：message 钩子是 claim（返回真值＝接管，这条她就不处理了），所以这里永远返回 false。
 * hub 给模块的是 `{...msg, raw: event}` 的浅拷贝，写 msg.text 改不到群聊上下文，
 * 所以发给模型的显示文字由 prompt 钩子负责；msg.raw 里是原始 OneBot 事件，图片段、转发 id 都在那儿。
 */

const SKIP_MIME = new Set(['image/heic', 'image/heif'])

/** 看图模型默认提示词：要「抄」不要「评」，描述才不容易跑偏 */
const DEFAULT_DESCRIBE_PROMPT = [
  '把这张图片里的内容尽量完整地转成文字，供看不到图的人阅读。',
  '有文字就逐字抄下来（保留原来的换行和顺序，看不清的字用□代替）；',
  '没有文字就描述画面：是什么人 / 什么东西、在做什么、什么样子、大致位置关系。',
  '只描述你确实看到的，不要猜、不要评论、不要加开场白。'
].join('')

/**
 * 「假装看到了」的回复：模型其实没拿到图，却回一段「我看不到图 / 视觉引擎失败」。
 * 这种文字当描述用会误导她，必须当失败处理。
 */
const BLIND_REPLY = [
  /无法(看到|查看|读取|识别|转写|描述|访问).{0,8}(图|图片|图像|画面)/,
  /(图片|图像|画面).{0,6}(未能|无法|不能|没法)(读取|加载|显示|查看|识别|接收)/,
  /(视觉|图像)(引擎|能力|服务|通道).{0,6}(失败|不可用|异常|未启用)/,
  // 「我没有看到任何图片 / 没有收到图」这类：必须是「图」本身没到，不能把「没有其他图形」也算进来
  /(我)?(没有|没|未|无法)(看到|收到|拿到|加载到|获取到)(任何|一张)?(的)?(图|图片|图像|照片)/,
  /(没有|没|未)(收到|拿到|附带|上传)(任何|一张)?(的)?(图|图片|图像|照片)/,
  /(这条|这则)?(消息|内容)(里|中)?(没有|不含|未包含)(任何)?(图|图片|图像|照片)/
]
/** 太长的一段话里同时出现「建议你去检查/运行」这类措辞，也基本是模型在报障 */
const BLIND_HINT = /(请|可以)(运行|检查|确认).{0,12}(配置|设置|接口)/

function looksBlind (text) {
  const s = String(text || '')
  if (!s.trim()) return true
  if (BLIND_REPLY.some((re) => re.test(s))) return true
  // 短回复里说「看不到」也算；长回复里出现报障措辞也算
  return s.length <= 200 && BLIND_HINT.test(s)
}

/** 拿不到插件的 mimeOf 时自己认（PNG / GIF / WEBP / BMP / JPEG 魔数） */
function mimeOfBuf (buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return ''
}

/** 段数组：OneBot11 是数组；有些网关会塞成 JSON 字符串 */
function segmentsOf (raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) { return [] }
  }
  return []
}

/** 「provider::model」↔ {provider, model} */
function parseModelRef (text) {
  const s = String(text || '')
  const i = s.indexOf('::')
  if (i <= 0) return null
  const provider = s.slice(0, i).trim()
  const model = s.slice(i + 2).trim()
  return provider && model ? { provider, model } : null
}

const modelRef = (m) => (m ? `${m.provider}/${m.model}` : '')

/** 两个 {provider, model} 是不是同一个模型 */
const sameModel = (a, b) => Boolean(a && b && a.provider === b.provider && a.model === b.model)

const withTimeout = (promise, ms, what) => {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what || '操作'}超时（${Math.round(ms / 1000)} 秒）`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const def = {
  id: 'rich-input',
  name: '看得见的东西',
  version: '1.6.0',
  api: 1,
  panel: 'panel.js',
  description: '把 [图片] 变成真正交给模型的图片（看不了图就用看图模型转汉字、不行再换回退模型）；把 [合并转发] 展开成 {[昵称](QQ):内容;…}',

  defaults: {
    images: true,
    maxImages: 4,
    forwards: true,
    catchUp: true,
    maxForwards: 3,
    maxNodes: 60,
    maxChars: 4000,
    extraForwardText: true,
    logText: true,
    describe: true,
    visionModel: '',
    fallbackModel: '',
    describeTimeout: 30,
    describePrompt: ''
  },
  settings: [
    { key: 'images', label: '图片交给模型', type: 'switch', hint: '把消息里的图片下载成 base64 图片块真正交给她看；关掉就只剩「[图片]」' },
    { key: 'maxImages', label: '最多几张图', type: 'number', min: 1, max: 8, step: 1 },
    { key: 'forwards', label: '展开合并转发', type: 'switch', hint: '把 [合并转发] 换成 {[昵称](QQ):内容;…}' },
    { key: 'catchUp', label: '补上她没看到的转发', type: 'switch', hint: '群里没人叫她的时候，转发的正文原本她一辈子看不到。开着就在她下次真的说话前补上；上面那块面板会列出「攒了几条、是谁的」' },
    { key: 'maxForwards', label: '最多展开几个转发', type: 'number', min: 1, max: 5, step: 1 },
    { key: 'maxNodes', label: '每个转发最多几行', type: 'number', min: 1, max: 200, step: 1 },
    { key: 'maxChars', label: '每个转发最多多少字', type: 'number', min: 200, max: 20000, step: 100 },
    { key: 'extraForwardText', label: '额外提一句「上面那段转发」', type: 'switch', hint: '展开后补一行说明，提示她那是合并转发的聊天记录' },
    { key: 'logText', label: '把细节写进日志', type: 'switch', hint: '排障用：记录补了几张图、展开了多少字' },

    { key: 'describe', label: '看不了图就转成文字', type: 'switch', hint: '目标模型没有图像能力时，先用「能看图的模型」把图片内容写成文字再交给她；关掉就只剩图片块（她大概率还是看不见）' },
    { key: 'visionModel', label: '用哪个模型看图', type: 'select', options: [{ value: '', label: '自动（挑第一个能看图的）' }], hint: '这个模型只负责把图片转成文字，不参与她的对话；不带图能力的模型选了也没用' },
    { key: 'fallbackModel', label: '看图失败时换这个模型', type: 'select', options: [{ value: '', label: '自动（挑一个和上面不同的能看图的）' }], hint: '上面那个模型报错 / 超时 / 没配时，换它再试一次；留空就自动挑一个不同的，没有别的可用就只试一次' },
    { key: 'describeTimeout', label: '每个模型最多等几秒', type: 'number', min: 5, max: 120, step: 5, hint: '超时就换下一个模型。调小一点消息回得快，但慢模型更容易被误判；默认 30 秒' },
    { key: 'describePrompt', label: '看图时给模型的提示词', type: 'textarea', placeholder: '留空用内置的：「把图片里的内容尽量完整地转成文字……」' }
  ],

  setup (api) {
    // 内部实现走 api.lib（插件升级改了也不至于把模块弄崩）
    let net = null
    let inbound = null
    try { net = api.lib('core/net.js') } catch (error) { api.log.warn('rich-input：拿不到 core/net.js —— ' + error.message) }
    try { inbound = api.lib('chat/inbound.js') } catch (error) { api.log.warn('rich-input：拿不到 chat/inbound.js —— ' + error.message) }
    const segmentBytes = typeof net?.segmentBytes === 'function' ? net.segmentBytes : null
    const parseMessageEvent = typeof inbound?.parseMessageEvent === 'function' ? inbound.parseMessageEvent : null
    const mimeOf = typeof inbound?.mimeOf === 'function' ? inbound.mimeOf : mimeOfBuf

    const TTL = 10 * 60_000
    /**
     * 带转发的记录留久一点：群里可能几小时才有人说话，
     * 10 分钟就过期的话，那条转发等于白拉了（用户 19:44 转的那条，当晚一直没人叫她）。
     */
    const FWD_TTL = 6 * 60 * 60_000
    const CAP = 400
    const MARK = '[合并转发]'
    // 只认「裸占位」：后面紧跟 { 的是已经展开过的，别再叠一层
    const BARE = /\[合并转发\](?!\{)/ // 不带 g：test 用它，replace / match 时另取全局版
    const BARE_ALL = () => /\[合并转发\](?!\{)/g
    /** 消息记录：{ at, chatId, images[], forwards[], replyId, userId, nickname } */
    const seen = new Map()
    /** 转发 id → 展开后的文本（只有成功才缓存） */
    const expandCache = new Map()
    /** 转发 id → 正在拉的 Promise，防止同一条被拉两遍 */
    const inflight = new Map()
    /** 一轮最多补几条她没看到的转发（多了一是刷屏，二是把上下文撑爆） */
    const MAX_CATCH = 3
    /** `${messageId}:${序号}` → 图片转出来的文字 */
    const descCache = new Map()
    let generation = 0
    /** 自动挑的看图模型：{ at, value } */
    let autoVision = null
    /** 上次真的把图认出来的模型：{ at, value } —— 自动模式下优先复用它，免得每次都撞到慢模型 */
    let lastGoodVision = null
    /** 最近失败过的看图模型：`provider/model` → 失败时间。自动挑选时先躲开（10 分钟） */
    const badVision = new Map()
    /** 失败原因，给面板显示用：`provider/model` → { at, reason } */
    const badReason = new Map()
    /** 失败累计次数：偶尔抽风一次不可信，连着两次就不再自动挑它 */
    const badHits = new Map()
    const BAD_TTL = 10 * 60_000
    /** 超时这种一等就是几十秒的，记久一点（半小时），别让它反复拖累一条消息 */
    const SLOW_TTL = 30 * 60_000
    /** 超时记录：`provider/model` → { at, hits } */
    const badSlow = new Map()
    /** 最近一次成功耗时的记录：`provider/model` → { at, ms }，面板上显示用 */
    const lastTiming = new Map()

    // ---------- 记录 ----------
    function remember (key, entry) {
      if (!key) return
      seen.delete(key)
      seen.set(key, entry)
      generation += 1
      if (seen.size > CAP) {
        const now = Date.now()
        for (const [k, v] of seen) {
          if (v.forwards?.length ? now - v.at > FWD_TTL : now - v.at > TTL) seen.delete(k)
        }
        while (seen.size > CAP) seen.delete(seen.keys().next().value)
      }
    }

    const fresh = (v) => Boolean(v) && Date.now() - v.at <= TTL
    /** 转发记录活得久一些：图片过期了顶多看不见，转发过期了她就永远不知道人家转了什么 */
    const fwdFresh = (v) => Boolean(v) && Date.now() - v.at <= FWD_TTL

    /**
     * 已经交给她看过的消息：messageId → 时间。
     * 没有这个的话，一张表情包会在后面每一轮里被当成「最近那条带图的」反复塞进去
     * （插件不会重复给图，是我们自己的兜底逻辑在重复找）。
     */
    const shown = new Map()
    const SHOWN_TTL = 10 * 60_000
    function alreadyShown (messageId) {
      if (!messageId) return false
      const at = shown.get(String(messageId))
      if (!at) return false
      if (Date.now() - at > SHOWN_TTL) { shown.delete(String(messageId)); return false }
      return true
    }
    function markShown (messageId) {
      if (!messageId) return
      shown.set(String(messageId), Date.now())
      if (shown.size > CAP) {
        const now = Date.now()
        for (const [k, at] of shown) if (now - at > SHOWN_TTL) shown.delete(k)
        while (shown.size > CAP) shown.delete(shown.keys().next().value)
      }
    }

    /**
     * 按发送人找最近一条带图 / 带表情 / 带转发的消息。
     * ⚠ chatId 一定要传：主人可能同时在群里和私聊发图，不按聊天过滤会把群里的图塞进私聊那一轮
     * （2026-11-02 真机踩到过：私聊那轮描述了群里的图，15 个字的牛头不对马嘴）。
     * want: 'pics'（图片 + 表情包）/ 'images'（只算普通图片）/ 'forwards'
     */
    function lookupBySender (senderId, want, chatId) {
      let best = null
      for (const v of seen.values()) {
        // 转发记录活得久（6 小时），图片/表情还是 10 分钟
        if (!(want === 'forwards' ? fwdFresh(v) : fresh(v))) continue
        if (senderId && v.userId !== senderId) continue
        if (chatId && v.chatId && v.chatId !== chatId) continue
        if (want === 'forwards') {
          if (!v.forwards.length) continue
        } else {
          const segs = want === 'pics' ? (v.pics || []) : (v.images || [])
          if (!segs.length) continue
          // 已经交给她看过的就别再塞一遍：不然一张图/一个表情包会在后面每一轮里重复出现
          if (alreadyShown(v.messageId)) continue
        }
        if (!best || v.at > best.at) best = v
      }
      return best
    }

    function isStickerSeg (seg) {
      const d = seg?.data || {}
      if (seg?.type !== 'image') return true
      if (d.sub_type !== undefined && Number(d.sub_type) !== 0) return true // 0/未设 = 普通图片，1 = 收藏表情
      if (d.emoji_id || d.emoji_package_id) return true
      if (typeof d.summary === 'string' && d.summary.includes('表情')) return true
      return false
    }

    /** 普通图片（不含收藏表情 / 商城表情） */
    function imageSegsOf (segs) {
      const out = []
      for (const seg of segs) if (seg?.type === 'image' && !isStickerSeg(seg)) out.push(seg)
      return out
    }

    /**
     * 所有「她其实想看」的图：普通图片 + 收藏表情（sub_type:1）/ 商城表情。
     * 插件把表情包归到 msg.stickers 里，文字只写一句 summary（「喵」）—— 主人发表情包问「这是啥」时，
     * 用 imageSegsOf 是找不到东西的（2026-11-02 真机踩到：她只看到「喵」，回「图我看不了」）。
     * 表情包同样是图片字节，下载下来照样能转成文字。
     */
    function picSegsOf (segs) {
      const out = []
      for (const seg of segs) if (seg?.type === 'image') out.push(seg)
      return out
    }

    function forwardRefsOf (segs) {
      const out = []
      for (const seg of segs) {
        const d = seg?.data || {}
        if (seg?.type === 'forward') {
          const id = d.id ?? d.res_id ?? d.forward_id
          if (id) out.push({ id: String(id) })
        } else if (seg?.type === 'node') {
          // 网关直接把节点塞进来的情况：内容已经在手上，不用再拉
          const nodes = d.content || d.messages || (seg.data?.message ? [seg.data] : [])
          if (Array.isArray(nodes) && nodes.length) out.push({ nodes })
        }
      }
      return out
    }

    // ---------- 合并转发 → [合并转发]{昵称(QQ):内容;…} ----------
    function nodeOf (node) {
      const sender = node?.sender || {}
      const uid = String(sender.user_id ?? node?.user_id ?? '')
      const fallbackName = String(sender.card || sender.nickname || uid || '某人')
      const raw = node?.message ?? node?.content ?? node?.message_segments ?? []
      if (parseMessageEvent) {
        try {
          const m = parseMessageEvent({ message_type: 'private', user_id: Number(uid) || 0, message: raw }, String(api.core.hub?.selfId || ''), {})
          if (m && typeof m.text === 'string') {
            // 转发里常出现「卡片没名字」的情况：解析不出就退回 sender
            return { name: (m.nickname && m.nickname !== uid && m.nickname !== '0') ? m.nickname : fallbackName, uid, text: m.text, images: m.images || [] }
          }
        } catch (error) {}
      }
      const text = typeof raw === 'string' ? raw : segmentsOf(raw).map((seg) => (seg.type === 'text' ? String(seg.data?.text ?? '') : seg.type === 'image' ? '[图片]' : '')).join('')
      return { name: fallbackName, uid, text, images: [] }
    }

    function formatForward (nodes, o) {
      if (!Array.isArray(nodes) || !nodes.length) return ''
      const parts = []
      let chars = 0
      for (const node of nodes) {
        if (parts.length >= o.maxNodes) { parts.push('…;'); break }
        const it = nodeOf(node)
        const body = String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 200) || '（无文字）'
        const line = `${it.name}(${it.uid}):${body}`
        if (chars + line.length + 1 > o.maxChars) { parts.push('…;'); break }
        parts.push(line + ';')
        chars += line.length + 1
      }
      return parts.length ? `${MARK}{${parts.join('')}}` : ''
    }

    async function expandOne (ref, o) {
      if (ref && Array.isArray(ref.nodes)) return formatForward(ref.nodes, o)
      const id = String(ref?.id || ref || '')
      if (!id) return ''
      if (expandCache.has(id)) return expandCache.get(id)
      // 同一条转发可能同时被「收到时预拉」和「交给她之前补展开」碰到：共用一次请求，
      // 别拉两遍（get_forward_msg 一次可能几百毫秒到几秒）
      if (inflight.has(id)) return inflight.get(id)
      const job = (async () => {
        try {
          const r = await api.core.onebot.call('get_forward_msg', { id }, { timeoutMs: 15000 })
          const nodes = r?.messages || r?.data?.messages || r?.message || []
          const body = formatForward(nodes, o)
          if (body) {
            expandCache.set(id, body)
            if (expandCache.size > 200) expandCache.delete(expandCache.keys().next().value)
          }
          return body
        } finally {
          inflight.delete(id)
        }
      })()
      inflight.set(id, job)
      return job
    }

    /**
     * 这条转发的正文是不是已经出现在这一轮文本里了？
     * 有两种「已经出现」：
     *   ① 我们自己展开的 —— 整段 body 一字不差地在文本里（含 [合并转发]{…} 和补课段里的裸 body）。
     *   ② 插件原生展开的 —— 格式不同（「[合并转发的聊天记录（N 条）」+「昵称：内容」），
     *      只能退一步：拿节点正文的前一小段去文本里找，命中两句以上就算她已经看过。
     * 宁可漏判成「没看过」（顶多重复一遍），也别误判成「看过」把内容吞掉。
     */
    function forwardSeenIn (ref, text, o) {
      if (!text) return false
      if (ref && Array.isArray(ref.nodes)) {
        const body = formatForward(ref.nodes, o)
        return Boolean(body && text.includes(body))
      }
      const id = String(ref?.id || ref || '')
      const cached = id ? expandCache.get(id) : ''
      if (!cached) return false
      if (text.includes(cached)) return true
      const snippets = cached
        .replace(/^\[合并转发\]\{|\}$/g, '')
        .split(';')
        .map((line) => line.slice(line.indexOf(':') + 1).trim())
        .filter((t) => t.length >= 6)
        .map((t) => t.slice(0, 20))
      if (snippets.length < 2) return false
      const hit = snippets.filter((t) => text.includes(t)).length
      return hit >= Math.min(2, snippets.length)
    }

    /** 把文本里的「[合并转发]」按顺序换成展开结果；拉不到就保留占位 */
    async function expandInText (text, refs, o) {
      if (!text || !BARE.test(text) || !refs?.length) return null
      let out = text
      let touched = false
      for (const ref of refs.slice(0, o.maxForwards)) {
        if (!BARE.test(out)) break
        let body = ''
        try {
          body = await expandOne(ref, o)
        } catch (error) {
          api.log.debug('rich-input：拉合并转发失败 —— ' + (error?.message || error))
        }
        if (!body) continue
        // 一次只换掉「第一个」裸占位：refs 里的第 N 条转发要逐一对应文本里的第 N 个占位。
        // 用 BARE_ALL() 会一次替换全部占位——一条消息里有两个 [合并转发] 时，
        // 第一条的内容会被复制到两处、第二条的内容整个丢失（2026-11-18 审查实测复现）。
        // BARE 是不带 g 的正则，String.replace 只换第一个匹配。
        out = out.replace(BARE, body)
        touched = true
      }
      return touched ? out : null
    }

    // ---------- 图片 → 字节 ----------
    async function imageBytes (segs, max) {
      if (!segmentBytes || max <= 0) return []
      const items = []
      for (const seg of segs.slice(0, max)) {
        try {
          const buf = await segmentBytes(seg, api.core.onebot, { maxBytes: 8 * 1024 * 1024 })
          const mime = mimeOf(buf)
          if (!/^image\//.test(String(mime)) || SKIP_MIME.has(mime)) continue
          items.push({ base64: buf.toString('base64'), mediaType: mime, bytes: buf.length })
        } catch (error) {
          api.log.debug('rich-input：图片下载失败 —— ' + (error?.message || error))
        }
      }
      return items
    }

    /** 引用消息里的图：普通图片 + 表情包都算（主人经常引用一个表情包问「这是啥」） */
    async function quotedPicSegs (messageId) {
      if (!messageId) return []
      try {
        const r = await api.core.onebot.call('get_msg', { message_id: messageId }, { timeoutMs: 10000 })
        return picSegsOf(segmentsOf(r?.message ?? r?.data?.message))
      } catch (error) {
        return []
      }
    }

    // ---------- 看图模型：把图片转成文字 ----------
    /** 目标模型自己能不能看图：true / false / null（宿主没说清楚） */
    async function canSee (chat) {
      try {
        const fn = api.core?.hub?.canSeeImages
        if (typeof fn === 'function') return await fn(chat)
      } catch (error) {
        api.log.debug('rich-input：问不到「能不能看图」—— ' + (error?.message || error))
      }
      return null
    }

    /** 所有能看图的模型：[{ provider, model, name }] */
    async function visionModels () {
      try {
        const list = await api.core?.listModels?.()
        if (!Array.isArray(list)) return []
        return list.filter((m) => m && m.vision === true && m.provider && m.model)
      } catch (error) {
        api.log.debug('rich-input：列模型失败 —— ' + (error?.message || error))
        return []
      }
    }

    /** 主人上一次在面板里选的是哪个（换模型时要把旧的失败记录清掉，不然要等 10 分钟才生效） */
    let lastChosen = null

    /** 这次用哪个模型看图：设置里选的 > 上次成功的 > 自动挑（躲开最近失败的） */
    async function pickVisionModel (o) {
      const chosen = parseModelRef(o.visionModel)
      if (chosen) {
        // 面板里刚换成这个模型：主人是主动改的，别拿 10 分钟前的失败记录拦他
        const key = modelRef(chosen)
        if (lastChosen !== key) {
          lastChosen = key
          if (badVision.has(key)) {
            api.log.info(`rich-input：面板里换成了 ${key}，清掉它之前的失败记录`)
            badVision.delete(key)
            badReason.delete(key)
          }
        }
        // 面板里选定的模型也会坏（报错 / 超时 / 没真看到图）。坏掉时如果还有健康的，
        // 先顶上别死磕——死磕一次可能就是干等一个超时，她那边这条消息就废了。
        if (!isBad(chosen)) return chosen
        const list = await visionModels()
        const healthy = pickFrom(list, null)
        if (healthy && !sameModel(healthy, chosen)) {
          api.log.warn(`rich-input：设置里选的看图模型 ${modelRef(chosen)} 刚失败过，先用 ${modelRef(healthy)} 顶上`)
          return healthy
        }
        return chosen
      }
      lastChosen = '' // 切回自动了；下次再手选同一个模型也算「刚改的」
      // 自动模式：一小时内成功过的那个优先，避开已知会超时的模型
      if (lastGoodVision && Date.now() - lastGoodVision.at < 60 * 60_000 && !isBad(lastGoodVision.value)) return lastGoodVision.value
      if (autoVision && Date.now() - autoVision.at < 5 * 60_000 && !isBad(autoVision.value)) return autoVision.value
      const list = await visionModels()
      const pick = pickFrom(list, null)
      autoVision = { at: Date.now(), value: pick }
      return pick
    }

    /** 这个模型现在该不该躲开：普通失败躲 10 分钟；超时过的躲半小时（一次就要干等 60 秒） */
    const isBad = (m) => {
      if (!m) return false
      const key = modelRef(m)
      const slow = badSlow.get(key)
      if (slow && Date.now() - slow.at < SLOW_TTL) return true
      const at = badVision.get(key)
      return Boolean(at) && Date.now() - at < BAD_TTL
    }

    /** 从能看图的模型里挑一个：优先没失败过的，跳过 skip 这个 */
    function pickFrom (list, skip) {
      const usable = list.filter((m) => !sameModel(m, skip))
      const healthy = usable.find((m) => !isBad(m)) || usable[0]
      return healthy ? { provider: healthy.provider, model: healthy.model } : null
    }

    const markBad = (m, reason) => {
      if (!m) return
      const key = modelRef(m)
      const text = String(reason || '失败').slice(0, 200)
      badVision.set(key, Date.now())
      badReason.set(key, { at: Date.now(), reason: text })
      badHits.set(key, (badHits.get(key) || 0) + 1)
      // 超时是最贵的失败（一次干等 60 秒），单独记久一点
      if (/超时/.test(text)) {
        const slow = badSlow.get(key) || { at: 0, hits: 0 }
        badSlow.set(key, { at: Date.now(), hits: slow.hits + 1 })
      }
    }
    const markGood = (m) => {
      if (!m) return
      const key = modelRef(m)
      badVision.delete(key)
      badReason.delete(key)
      badHits.delete(key)
      badSlow.delete(key)
      lastGoodVision = { at: Date.now(), value: m }
    }
    /** 现在有哪些模型「最近失败过」——面板上给主人看，好及时换掉首选 */
    const badList = () => [...badReason.entries()]
      .filter(([key]) => {
        const at = badVision.get(key)
        const slow = badSlow.get(key)
        return (at && Date.now() - at < BAD_TTL) || (slow && Date.now() - slow.at < SLOW_TTL)
      })
      .map(([key, v]) => ({ model: key, reason: v.reason, agoSec: Math.round((Date.now() - v.at) / 1000), hits: badHits.get(key) || 1 }))

    /**
     * 主模型不行时换哪个：
     * 设置里选的（没坏就用它）> 设置里选的那个坏了但列表里有健康的就用健康的 > 自动挑一个和主模型不同的。
     * 面板里选定的模型也会坏（报错 / 超时 / 没真看到图），这时别死磕，先拿一个健康的顶上。
     */
    async function pickFallbackModel (o, primary) {
      const list = await visionModels()
      const chosen = parseModelRef(o.fallbackModel)
      // 面板里把回退填成和主模型一样 → 等于没有回退，直接说清楚（别悄悄换成别的，主人会以为配置生效了）
      if (chosen && sameModel(chosen, primary)) return null
      if (chosen && !isBad(chosen)) return chosen
      const healthy = pickFrom(list, primary)
      if (chosen && healthy) {
        api.log.warn(`rich-input：设置里选的回退模型 ${modelRef(chosen)} 刚失败过，先用 ${modelRef(healthy)} 顶上`)
        return healthy
      }
      return chosen || healthy
    }

    async function describeOne (item, model, prompt, timeoutMs) {
      // 优先用 api.ask（和 core.ask 一样支持 images / cfg，但会带上 module: id，
      // 这样看图花的 token 才会计进「概览」的本模块明细，而不是全算成后台任务）。
      // 老版本宿主没有 api.ask 时退回 api.core.ask，行为不变。
      const ask = typeof api.ask === 'function' ? api.ask : api.core?.ask
      if (typeof ask !== 'function') throw new Error('宿主没有 ask 接口')
      const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30_000
      const started = Date.now()
      const text = await withTimeout(
        Promise.resolve(ask({
          cfg: { model },
          system: '你把图片内容转成文字，只描述确实看到的东西。',
          text: prompt,
          images: [{ data: item.base64, mediaType: item.mediaType }],
          maxTokens: 800,
          temperature: 0.2
        })),
        ms,
        `看图模型（${modelRef(model)}）`
      )
      // 记一笔耗时，面板上能看出谁快谁慢
      lastTiming.set(modelRef(model), { at: Date.now(), ms: Date.now() - started })
      return String(text || '').trim()
    }

    // ---------- 设置 ----------
    function opts () {
      const s = api.settings() || {}
      const num = (v, d, min, max) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d
      }
      const str = (v, d = '') => (typeof v === 'string' ? v.trim() : d)
      return {
        images: s.images !== false,
        maxImages: num(s.maxImages, 4, 1, 8),
        forwards: s.forwards !== false,
        catchUp: s.catchUp !== false,
        maxForwards: num(s.maxForwards, 3, 1, 5),
        maxNodes: num(s.maxNodes, 60, 1, 200),
        maxChars: num(s.maxChars, 4000, 200, 20000),
        extraForwardText: s.extraForwardText !== false,
        logText: s.logText !== false,
        describe: s.describe !== false,
        visionModel: str(s.visionModel),
        fallbackModel: str(s.fallbackModel),
        describeTimeout: num(s.describeTimeout, 30, 5, 120) * 1000,
        describePrompt: str(s.describePrompt) || DEFAULT_DESCRIBE_PROMPT
      }
    }

    /** 这一批文本里还有几个「裸」[合并转发] 占位 */
    const markCount = (blocks) => blocks.reduce((n, b) => {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') return n
      return n + (b.text.match(BARE_ALL())?.length || 0)
    }, 0)

    /** 这个聊天里最近一条带图（含表情包）的消息：插件说「这条里有图我看不了」时，用它兜底找那条 */
    function latestWithImages (chatId) {
      let best = null
      for (const v of seen.values()) {
        if (!fresh(v)) continue
        const segs = v.pics || v.images || []
        if (!segs.length) continue
        if (chatId && v.chatId && v.chatId !== chatId) continue
        if (!best || v.at > best.at) best = v
      }
      return best
    }

    /** 插件那句「你现在的模型看不了图，只能知道有这么回事」在不在 */
    const hasBlindLine = (blocks) => blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.includes('看不了图'))

    /**
     * 那句提示是照着**发图那个人**的昵称写的：「（${msg.nickname} 发了 N 张图片，…）」。
     * 群里一批话可能好几个人各发了一张，提示就是好几行 —— 把昵称抠出来，
     * 才能把「别人的图」也认到（按 senderId 只能认到插件指定的第一个说话人）。
     */
    function blindNames (blocks) {
      const names = []
      for (const b of blocks) {
        if (!b || b.type !== 'text' || typeof b.text !== 'string') continue
        const m = /（(.+?) 发了 \d+ 张图片/.exec(b.text)
        if (m && m[1] && !names.includes(m[1])) names.push(m[1])
      }
      return names
    }

    /** 这个聊天里、这个昵称最近发的那条带图（含表情包）的消息 */
    function latestByNick (chatId, nickname) {
      if (!nickname) return null
      let best = null
      for (const v of seen.values()) {
        if (!fresh(v)) continue
        if ((v.nickname || '') !== nickname) continue
        if (chatId && v.chatId && v.chatId !== chatId) continue
        const segs = v.pics || v.images || []
        if (!segs.length) continue
        if (alreadyShown(v.messageId)) continue
        if (!best || v.at > best.at) best = v
      }
      return best
    }

    /**
     * 插件会写一句「你现在的模型看不了图，只能知道有这么回事」—— 这句话现在不成立了，
     * 换成「图片内容见下面的文字」，免得她照着这句话回「我看不到图」。
     */
    function fixBlindLine (blocks) {
      let hit = false
      for (const block of blocks) {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
        if (!block.text.includes('看不了图')) continue
        block.text = block.text.split('\n').map((line) => (line.includes('看不了图') ? '（这条里的图片已经转成文字放在下面了）' : line)).join('\n')
        hit = true
      }
      return hit
    }

    /**
     * 图片转文字：先用「看图模型」，它不行（报错 / 超时 / 没配）再换「回退模型」。
     * 返回 { text, via } ；一路都没成返回 { text:'', via:[], lastError }（调用方退回图片块）。
     */
    async function imagesAsText (items, o, recordKey) {
      const lines = []
      const via = new Set()
      let lastError = ''
      let primary = null
      let backup = null
      if (o.describe) {
        primary = await pickVisionModel(o)
        if (!primary) lastError = '没有能看图的模型'
        else backup = await pickFallbackModel(o, primary)
      }
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]
        const cacheKey = recordKey ? `${recordKey}:${i}` : ''
        const hit = cacheKey ? descCache.get(cacheKey) : null
        let text = hit?.text || ''
        let who = hit?.via || ''
        for (const model of [primary, backup]) {
          if (text || !model) continue
          try {
            const said = await describeOne(item, model, o.describePrompt, o.describeTimeout)
            if (said && looksBlind(said)) {
              // 模型其实没拿到图，只回了「我看不到 / 视觉引擎失败」——当失败处理，换下一个
              lastError = `${modelRef(model)} 没真看到图：${said.slice(0, 80)}`
              api.log.debug(`rich-input：看图模型没成功（${modelRef(model)}）—— ` + lastError)
              markBad(model, '没真看到图：' + said.slice(0, 80))
            } else if (said) {
              text = said
              who = modelRef(model)
              markGood(model)
            } else markBad(model, '模型没吐出文字') // 一个字都没吐也算不行，下次先避开
          } catch (error) {
            lastError = String(error?.message || error)
            markBad(model, lastError)
            const name = modelRef(model) + (sameModel(model, primary) ? '' : '（回退）')
            api.log.debug(`rich-input：看图模型没成功（${name}）—— ` + lastError)
          }
        }
        if (!text) continue
        text = text.replace(/\s*\n\s*/g, '\n').trim().slice(0, 800)
        if (who) via.add(who)
        if (cacheKey) {
          descCache.set(cacheKey, { text, via: who })
          if (descCache.size > 200) descCache.delete(descCache.keys().next().value)
        }
        lines.push(`[图片${i + 1}] ${text}`)
      }
      if (!lines.length) return lastError ? { text: '', via: [], lastError } : null
      return { text: lines.join('\n'), via: [...via] }
    }

    // ---------- 事件：收消息（只记录，永远不接管） ----------
    api.on('message', async (msg) => {
      try {
        const segs = segmentsOf(msg?.raw?.message)
        const images = imageSegsOf(segs)
        const pics = picSegsOf(segs)
        const forwards = forwardRefsOf(segs)
        if (msg?.messageId) {
          remember(String(msg.messageId), {
            at: Date.now(),
            messageId: String(msg.messageId),
            chatId: msg.chatId || '',
            images,
            pics, // 含表情包：主人发的表情包也是「一张图」
            forwards,
            replyId: msg.replyId || '',
            userId: String(msg.userId || ''),
            nickname: msg.nickname || ''
          })
        }
        // 预拉：转发 id 会过期，而且群里没人叫她的时候根本走不到展开那一步（插件在「不回」时就 return 了）。
        // 现在先把正文拉到手，交给 expandCache；之后不管隔几分钟、哪一轮，都还能补给她看。
        // 不 await：别让拉转发把收消息卡住。
        if (forwards.length && opts().forwards) {
          const o = opts()
          for (const ref of forwards.slice(0, o.maxForwards)) {
            expandOne(ref, o).then((body) => {
              // 拉到手就写一行，方便事后在日志里确认「这条转发到底有没有被她看见」
              if (body && o.logText) api.log.debug(`rich-input：转发已拉到手（${body.length} 字）—— 她要是这轮没被叫到，下次说话时补给她`)
            }).catch((error) => api.log.debug('rich-input：预拉合并转发失败 —— ' + (error?.message || error)))
          }
        }
        if (opts().logText && (pics.length || forwards.length)) {
          const stickers = pics.length - images.length
          api.log.debug(`rich-input：记下 ${msg.chatId || '?'} 的 ${images.length} 张图${stickers > 0 ? ` / ${stickers} 个表情包` : ''} / ${forwards.length} 个转发`)
        }
      } catch (error) {
        api.log.warn('rich-input：记录消息出错 —— ' + (error?.message || error))
      }
      return false // claim 语义：返回真值就接管了，这条她就不回
    })

    // ---------- 事件：交给她之前 ----------
    api.on('prompt', async (content, info) => {
      try {
        if (!Array.isArray(content)) return undefined
        const o = opts()
        const chat = info?.chat || {}
        if (chat.kind === 'system') return undefined // 后台任务（写日记 / 主动搭话草稿）跟她眼前的消息无关
        const senderId = String(info?.senderId || '')
        let out = content.slice()
        let changed = false
        let expandedFwd = false

        // 1) 文本里剩下的 [合并转发]：优先用「这个人最近一条带转发的消息」，其余按时间补
        if (o.forwards && markCount(out)) {
          const chatId = chat?.chatId || ''
          const mine = lookupBySender(senderId, 'forwards', chatId)
          // 兜底的「其余」也只看这条聊天里的：别把别的群 / 私聊的转发展开到这里来
          const rest = [...seen.values()]
            .filter((v) => fwdFresh(v) && v.forwards.length && v !== mine && (!chatId || !v.chatId || v.chatId === chatId))
            .sort((a, b) => b.at - a.at)
            .flatMap((v) => v.forwards)
          const queue = [...(mine ? mine.forwards : []), ...rest]
          let cursor = 0
          let filled = 0
          for (const block of out) {
            if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
            if (!BARE.test(block.text)) continue
            const take = queue.slice(cursor, cursor + o.maxForwards)
            cursor += o.maxForwards
            const next = await expandInText(block.text, take, o)
            if (next) {
              block.text = next
              filled += 1
              changed = true
              expandedFwd = true
            }
          }
          if (filled && o.logText) api.log.info(`rich-input：把 ${filled} 处合并转发展开成 {昵称(QQ):内容;…}（${chat.chatId || '?'}）`)
        }

        // 1b) 补课：她没看到的转发
        //     插件在「群里没在聊 / 插话冷却中」时直接 return，根本不会叫她，prompt 钩子也就不会跑。
        //     那些转发她一辈子看不到（她之后读到的是聊天记录里的裸 [合并转发]）。
        //     所以：只要这条聊天里最近收到过、而她还不知道内容的转发，就在这次真叫她的时候补在末尾说清楚。
        if (o.catchUp && o.forwards) {
          const chatId = chat?.chatId || ''
          const used = out.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n')
          const candidates = [...seen.values()]
            .filter((v) => fwdFresh(v) && v.forwards?.length && (!chatId || !v.chatId || v.chatId === chatId))
            .sort((a, b) => a.at - b.at) // 按时间正序：先转发的先读
          const lines = []
          let caught = 0
          // 别为了补课把她这一轮拖死：整段最多花 8 秒（预拉通常已经在缓存里，正常是毫秒级）
          const budget = Date.now() + 8000
          for (const v of candidates) {
            if (caught >= MAX_CATCH) break
            // 用记录自己的标记，不动 shown —— shown 是「这张图已经给她看过」，
            // 一条消息可能既有图又有转发，混用会让图被误判成「看过了」而漏掉
            if (v.fwdShown) continue
            const parts = []
            let failed = false
            for (const ref of v.forwards.slice(0, o.maxForwards)) {
              if (Date.now() > budget) { failed = true; break } // 超时就留到下一次，别卡住她这一轮
              let body = ''
              try {
                body = await expandOne(ref, o)
              } catch (error) {
                failed = true
                api.log.debug('rich-input：补课拉转发失败 —— ' + (error?.message || error))
              }
              // 这一轮正文里已经展开过的就别重复贴
              if (body && !used.includes(body)) parts.push(body)
            }
            // 拉不到就先别记成「看过了」，下次叫她时再试一次
            if (failed && !parts.length) continue
            // 插件自己展开过的那种（「[合并转发的聊天记录（N 条）」+ 每行「昵称：内容」）格式不一样，
            // 逐字比对 body 认不出来 —— 改用「节点正文有没有已经出现在这一轮的文本里」来判断，
            // 免得同一条转发被她看到两遍。
            if (parts.length && v.forwards.some((ref) => forwardSeenIn(ref, used, o))) {
              v.fwdShown = true
              continue
            }
            v.fwdShown = true
            if (!parts.length) continue // 正文里已经展开过了，算她看过
            const who = v.nickname || v.userId || '某人'
            lines.push(`${who}(${v.userId || '?'}) 转发的聊天记录 —— ${parts.join(' ')}`)
            caught += 1
            expandedFwd = true
          }
          if (lines.length) {
            out = [...out, {
              type: 'text',
              text: `【刚有人转发了下面这些聊天记录，你收到的时候没展开，现在补给你看】\n${lines.join('\n')}`
            }]
            changed = true
            if (o.logText) api.log.info(`rich-input：补了 ${lines.length} 条她没看到的转发（${chatId || '?'}）`)
          }
        }

        // 2) 图片
        //    插件自己会把「触发回复的那条消息」的图塞进来；但它判「这个模型看不了图」时只写一行
        //    「你现在的模型看不了图，只能知道有这么回事」——那行就是要接手的信号：
        //    这时候图上不了，就用看图模型（不行再换回退模型）转成文字。引用里的图插件完全不看，也在这里补。
        //
        //    ⚠ 表情包（sub_type:1 的收藏表情 / mface / emoji_id）是 2026-11-02 真机漏掉的那一类：
        //      插件把表情归到 msg.stickers，正文写的是 summary（「喵」）；它自己下载表情时是算进去的
        //      （hub imagesOf 取了 [...stickers, ...images]），所以「看不了图」那行会写。
        //      但本模块自己的记录只收 images[] —— 于是按人去找时一张都找不到，segs 为空，
        //      整段图片逻辑直接不触发，她只看到「喵」+「看不了图」，于是回「图我看不了」。
        //      修法：记录里多存一份 pics（图片 + 表情），这里按 pics 找。
        if (o.images) {
          const blind = hasBlindLine(out)
          const hasImage = out.some((b) => b && b.type === 'image')
          const cantSee = blind || (await canSee(chat)) === false
          const chatId = chat?.chatId || ''
          // 这一轮该看的图：优先「同一个人在这条聊天里最近发的那张」；
          // 插件那句「看不了图」在、但按人对不上（群里一批话可能是好几个人说的）时，
          // 退一步用这个聊天里最近那张带图的。
          let records = []
          let segs = []
          if (!hasImage) {
            // 一批话里可能好几个人各发了一张图：插件为每个人各写一行「看不了图」，
            // 所以先把「同一个人最近那张」收下，再按那些行里点名的昵称把别人也找出来。
            const add = (v) => {
              if (!v) return
              if (records.some((r) => r.messageId === v.messageId)) return
              records.push(v)
            }
            add(lookupBySender(senderId, 'pics', chatId))
            if (blind) for (const nick of blindNames(out)) add(latestByNick(chatId, nick))
            if (!records.length && blind) add(latestWithImages(chatId))
            for (const r of records) {
              // 成功与否都标掉：同一张图别在下一轮再翻出来一次
              markShown(r.messageId)
              segs.push(...(r.pics || r.images || []))
            }
            // 引用了一条带图的消息：连那张一起看
            const first = records[0]
            if (first?.replyId && segs.length < o.maxImages) {
              const q = await quotedPicSegs(first.replyId)
              segs.push(...q.slice(0, Math.max(0, o.maxImages - segs.length)))
            }
          } else {
            // 插件自己已经把图塞进来了：从 image 块的 name（`qq-<messageId>-<序号>`）认出是哪条消息，
            // 把那条记录标掉，免得后面某一轮又被我们当成「最近的图」补一遍。
            for (const block of out) {
              if (!block || block.type !== 'image') continue
              const m = /^qq-(\d+)-\d+$/.exec(String(block.name || ''))
              if (m && m[1] !== '0') markShown(m[1])
            }
          }
          if (segs.length) {
            const items = await imageBytes(segs, o.maxImages)
            // ②③ 看不了图 → 先转成文字（主模型不行换回退模型）；不然就照原样塞图片块（①）
            const cacheKey = records[0]?.messageId || senderId
            const described = (cantSee && items.length) ? await imagesAsText(items, o, cacheKey) : null
            if (described?.text) {
              const who = described.via.join(' + ') || '能看图的模型'
              fixBlindLine(out)
              out = [...out, { type: 'text', text: `（这条消息里的图片，是用 ${who} 转成的文字，不是原图——按文字理解就行）\n${described.text}` }]
              changed = true
              if (o.logText) {
                api.log.info(`rich-input：${chatId || '?'} 的 ${items.length} 张图转成了文字（${described.via.join('、') || '看图模型'}，${described.text.length} 字）`)
              }
            } else if (items.length && !hasImage) {
              if (described?.lastError) api.log.debug('rich-input：两个看图模型都没成，退回图片块 —— ' + described.lastError)
              const blocks = items.map((it, i) => ({ type: 'image', data: it.base64, mediaType: it.mediaType, name: `qq-${i + 1}` }))
              out = [...out, ...blocks]
              changed = true
              if (o.logText) {
                const kb = Math.round(items.reduce((n, it) => n + it.bytes, 0) / 1024)
                api.log.info(`rich-input：给 ${chatId || '?'} 补了 ${blocks.length} 张图（约 ${kb}KB）`)
              }
            }
          }
        }

        if (!changed) return undefined
        // 提醒她「{…} 是什么」，只在确实展开过的时候加一次
        if (o.extraForwardText && expandedFwd) {
          const tip = '（上面形如「[合并转发]{昵称(QQ号):内容;}」的是别人转发的聊天记录，按顺序读就行。）'
          if (!out.some((b) => b.type === 'text' && b.text.includes('的是别人转发的聊天记录'))) out = [...out, { type: 'text', text: tip }]
        }
        return out
      } catch (error) {
        api.log.warn('rich-input：改提示词出错 —— ' + (error?.message || error))
        return undefined
      }
    })

    // ---------- 两个模型下拉框：把 DSH 里能看图的模型填进去 ----------
    const settingOf = (key) => (def.settings || []).find((s) => s.key === key)
    async function refreshModelOptions () {
      try {
        const list = await visionModels()
        if (!list.length) return
        const options = (first) => [{ value: '', label: first }, ...list.map((m) => ({ value: `${m.provider}::${m.model}`, label: `${m.name || m.model}（${m.provider}）` }))]
        const primary = settingOf('visionModel')
        if (primary) primary.options = options('自动（挑第一个能看图的）')
        const backup = settingOf('fallbackModel')
        if (backup) backup.options = options('自动（挑一个和上面不同的能看图的）')
        api.log.debug(`rich-input：能看图的模型 ${list.length} 个，已填进两个下拉框`)
      } catch (error) {}
    }
    refreshModelOptions()
    // 宿主启动后要过一会儿才把模型目录备好，几秒后再试一次；之后每 5 分钟跟一次
    setTimeout(() => { refreshModelOptions() }, 8000)?.unref?.()
    api.every?.(5 * 60_000, refreshModelOptions, '刷新能看图的模型')

    // ---------- 给面板用的接口 ----------
    const modelList = async () => (await visionModels()).map((m) => ({ value: `${m.provider}::${m.model}`, label: `${m.name || m.model}（${m.provider}）` }))
    api.route?.('/state', async () => {
      const o = opts()
      const primary = o.describe ? await pickVisionModel(o) : null
      const backup = primary ? await pickFallbackModel(o, primary) : null
      // 还没补给她看的转发：面板上能直接看出「补课」是不是在攒东西
      const pending = [...seen.values()]
        .filter((v) => fwdFresh(v) && v.forwards?.length && !v.fwdShown)
        .sort((a, b) => a.at - b.at)
        .map((v) => ({
          who: v.nickname || v.userId || '',
          chatId: v.chatId || '',
          agoSec: Math.round((Date.now() - v.at) / 1000),
          ready: v.forwards.filter((ref) => (ref?.nodes?.length) || (ref?.id && expandCache.has(String(ref.id)))).length,
          total: v.forwards.length
        }))
      return {
        ok: true,
        describe: o.describe,
        visionModel: modelRef(primary),
        fallbackModel: modelRef(backup),
        /** 面板里选的那个（空串＝自动）。和 visionModel 不一样就说明「选的这个坏了，临时换了个好的」 */
        preferred: o.visionModel,
        /** 最近失败过的模型 + 原因：主人可以照着去面板换掉首选 */
        broken: badList(),
        models: await modelList(),
        /** 合并转发：开关状态 + 已经拉到手、等她下次说话时补上的那几条 */
        forwards: {
          on: o.forwards,
          catchUp: o.catchUp,
          expanded: expandCache.size,
          pending
        }
      }
    }, { access: 'panel' })
    api.route?.('/test-vision', async () => {
      const o = opts()
      const model = await pickVisionModel(o)
      if (!model) return { ok: false, message: 'DSH 里没有能看图的模型' }
      try {
        const said = await describeOne(SAMPLE_IMAGE(), model, o.describePrompt, o.describeTimeout)
        if (said && looksBlind(said)) {
          markBad(model, '没真看到图：' + said.slice(0, 80))
          return { ok: false, message: `${modelRef(model)}：它没真看到图 —— ${said}` }
        }
        if (said) markGood(model); else markBad(model, '模型没吐出文字')
        return { ok: Boolean(said), message: said ? `${modelRef(model)}：${said}` : '模型没吐出文字' }
      } catch (error) {
        markBad(model, String(error?.message || error))
        return { ok: false, message: `${modelRef(model)}：${String(error?.message || error)}` }
      }
    }, { access: 'panel' })
    api.route?.('/test-fallback', async () => {
      const o = opts()
      const primary = await pickVisionModel(o)
      const model = await pickFallbackModel(o, primary)
      if (!model) return { ok: false, message: primary ? '没有别的能看图的模型可以当回退' : 'DSH 里没有能看图的模型' }
      try {
        const said = await describeOne(SAMPLE_IMAGE(), model, o.describePrompt, o.describeTimeout)
        if (said && looksBlind(said)) {
          markBad(model, '没真看到图：' + said.slice(0, 80))
          return { ok: false, message: `${modelRef(model)}：它没真看到图 —— ${said}` }
        }
        if (said) markGood(model); else markBad(model, '模型没吐出文字')
        return { ok: Boolean(said), message: said ? `${modelRef(model)}：${said}` : '模型没吐出文字' }
      } catch (error) {
        markBad(model, String(error?.message || error))
        return { ok: false, message: `${modelRef(model)}：${String(error?.message || error)}` }
      }
    }, { access: 'panel' })

    /** 试任意一个模型（?m=provider::model），用来挑能用的那个 */
    api.route?.('/test-model', async (req) => {
      const o = opts()
      const q = api.core?.http?.query?.(req) || {}
      const want = parseModelRef(q.m || q.model || '')
      const model = want || (await pickVisionModel(o))
      if (!model) return { ok: false, message: '没说试哪个模型，DSH 里也没有能看图的模型' }
      const at = Date.now()
      try {
        const said = await describeOne(SAMPLE_IMAGE(), model, o.describePrompt, o.describeTimeout)
        const ms = Date.now() - at
        if (said && looksBlind(said)) {
          markBad(model, '没真看到图：' + said.slice(0, 80))
          return { ok: false, model: modelRef(model), ms, message: `${modelRef(model)}（${ms}ms）没真看到图 —— ${said}` }
        }
        if (!said) { markBad(model, '模型没吐出文字'); return { ok: false, model: modelRef(model), ms, message: `${modelRef(model)}（${ms}ms）没吐出文字` } }
        markGood(model)
        return { ok: true, model: modelRef(model), ms, message: `${modelRef(model)}（${ms}ms）：${said}` }
      } catch (error) {
        const ms = Date.now() - at
        markBad(model, String(error?.message || error))
        return { ok: false, model: modelRef(model), ms, message: `${modelRef(model)}（${ms}ms）：${String(error?.message || error)}` }
      }
    }, { access: 'panel' })

    return {
      /** 手动展开一个转发 id / 节点数组（排障、其他模块复用） */
      expand: (ref) => expandOne(ref, opts()),
      /** 手动把一张图转成文字（排障用）：传 base64 + mediaType */
      describe: async (base64, mediaType) => {
        const o = opts()
        const model = await pickVisionModel(o)
        if (!model) throw new Error('DSH 里没有能看图的模型')
        return describeOne({ base64, mediaType: mediaType || 'image/jpeg' }, model, o.describePrompt)
      },
      stats: () => ({ seen: seen.size, expanded: expandCache.size, described: descCache.size, generation })
    }
  }
}

export default def

/** 面板自测用的示例图（120×60，左红右蓝）—— 只验证链路通不通，不追求识别效果 */
const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAAA8CAIAAAAiz+n/AAAAoklEQVR4nO3QAQmAUABEMUMYx2AmNocx3n0YLMGu73mOc7/fca58TfSufE30LtGiRefyNdG7RIsWncvXRO8SLVp0Ll8TvUu0aNG5fE30LtGiRefyNdG7RIsWncvXRO8SLVp0Ll8TvUu0aNG5fE30LtGiRefyNdG7RIsWncvXRO8SLVp0Ll8TvUu0aNG5fE30LtGiRefyNdG7RIsWncvXRO/6AUEwj0r5X1YjAAAAAElFTkSuQmCC'

function SAMPLE_IMAGE () {
  return { base64: SAMPLE_PNG_BASE64, mediaType: 'image/png' }
}
