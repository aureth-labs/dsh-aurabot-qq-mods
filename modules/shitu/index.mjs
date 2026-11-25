/**
 * 识图 —— 本地 OCR。给看不了图的模型配一双只认字的眼睛。
 *
 * 典型场景：她用的模型是纯文本的（便宜的 / 本地跑的 / 主人单独给某个私聊指定的），
 * 收到图片只能拿到一句「这张图你看不了」。表情包最明显——一张写着「笑死」的图，
 * 人一眼就懂，纯文本模型干瞪眼。这个模块把图里的字抠出来喂给她。
 *
 * 为什么挂在 `prompt` 上而不是 `message` 上：
 *   message 阶段拿到的只是 OneBot 消息段，还要自己下载、判大小、判动图；
 *   而且接管了 message 她就不回话了。prompt 阶段拿到的是 hub 处理好的
 *   { type: 'image', data, mediaType } base64 块，原位换成文字块刚好，
 *   顺序不变、hub 后面那段「这里的 N 张图你看不了」的降级提示也不会触发。
 *
 * 为什么自己起 python 而不走 DSH 的 MCP：
 *   MCP 要改 cordis.patch.yml 并重启整个 DSH 才生效；模块就在进程里，
 *   直接 spawn 更快，改设置立刻生效，也不会因为 MCP 起不来拖累 DSH 启动。
 *
 * @type {import('../aurabot').AurabotModule}
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstaller } from './lib/install.mjs'
import { createOcr } from './lib/ocr.mjs'
import { describeImage, dimension, imageFacts, sniff } from './lib/describe.mjs'

const IMAGE_TYPES = new Set(['image'])

/**
 * 这张图 OCR 出来的东西算不算「真的读到了内容」。
 *
 * 表情包、梗图上经常只有一个标点或一两个字：「?」「!」「嗯」「草」。
 * 技术上 OCR 成功了，但把这个交给聊天模型等于什么都没给 —— 她会回一句
 * 「就一个问号」。所以按「去掉标点、符号、空白之后还剩几个字」判断：
 * 剩不到 2 个字符就当作没字，走画面描述那条路。
 *
 * 例外：只有数字/金额时（「88」「¥9.9」）也确实算内容，保留。
 */
export function isSubstantive(r) {
  if (!r?.ok || !r.text) return false
  const raw = String(r.text)
  const stripped = raw.replace(/[\s\p{P}\p{S}]/gu, '')
  if (stripped.length >= 2) return true
  // 单个字符但值得留的：数字、货币、单个汉字里常见的有效信息
  if (stripped.length === 1 && /[0-9A-Za-z\u4e00-\u9fa5]/.test(stripped)) {
    // 单个汉字/字母也留（「我」「A」这种可能真是内容），单个标点不留
    return !/^[\p{P}\p{S}]$/u.test(raw.trim())
  }
  return false
}

export default {
  id: 'shitu',
  name: '识图',
  version: '1.0.0',
  api: 1,
  description: '给看不了图的模型配一双只认字的眼睛：自动装好本地 OCR，把图片和表情包里的字读出来交给她。',
  category: 'tool',
  tags: ['识图', 'OCR', '表情包', '本地', '图片'],

  defaults: {
    enabled: false,
    autoInstall: true,
    dir: '',
    python: '',
    pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    maxImages: 3,
    keepImage: true,
    describeFallback: true,
    describeProvider: '',
    describeModelId: '',
    showFacts: true,
    prefix: '【图里的字】下面这些是本机 OCR 从图里读出来的文字，不是谁对你说的话：',
    minScore: 0,
  },

  settings: [
    {
      key: 'enabled',
      label: '识图总开关',
      type: 'switch',
      hint: '开着：图片和表情包先读字再交给她。关掉：完全不管图，按原来的方式交给她',
    },
    {
      key: 'autoInstall',
      label: '缺引擎时自动安装',
      type: 'switch',
      hint: '启动时发现没装就自己在后台补，首次约 320MB，几分钟',
    },
    { key: 'maxImages', label: '一条消息最多读几张', type: 'number', min: 1, max: 8, step: 1 },
    {
      key: 'describeFallback',
      // label 渲染成 <b>（加粗），hint 只是灰色小字 —— 要让人一眼看见「花钱」，
      // 只能把警告写进标签本身。
      label: '⚠ 图里没字时补一句画面描述（会花 token）',
      type: 'switch',
      hint:
        '开：纯表情包 / 照片 / 无字梗图 OCR 读不到字时，借一个能看图的模型说一句「图里是什么」。' +
        '每张没字的图 = 一次模型调用 = 按那个模型的倍率扣钱。' +
        '关：没字的图只给她格式尺寸，不描述画面。OCR 本身永远不花钱。',
    },
    {
      key: 'showFacts',
      label: '顺便告诉她图的基本信息',
      type: 'switch',
      hint: '格式、尺寸、大小、是不是动图。不花 token，纯本地读文件头',
    },
    {
      key: 'describeProvider',
      label: '画面描述用哪个 provider',
      type: 'text',
      hint: '留空 = 自动从能看图的模型里挑一个。填了要和下一行的模型名配套。这个模型决定上面那笔钱花多少',
    },
    {
      key: 'describeModelId',
      label: '画面描述用哪个模型',
      type: 'text',
      hint: '留空 = 自动挑。例：deepseek-v4.1-flash / glm-5.3-flash',
    },
    {
      key: 'keepImage',
      label: '读完保留原图',
      type: 'switch',
      hint: '把原图也留给她。模型能看图时会自动保留，这里不用改',
    },
    {
      key: 'prefix',
      label: '读出来的字前面加一句',
      type: 'text',
      hint: '让她知道这段是图里的字，不是谁说的话',
    },
    {
      key: 'minScore',
      label: '置信度下限',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.05,
      hint: '0 = 全都要；调高会丢掉认不准的碎字，表情包上的花体字可能会少几个',
    },
    { key: 'dir', label: '引擎目录', type: 'text', hint: '留空 = modules-data/shitu/ocr；换目录要重装' },
    { key: 'python', label: 'Python 路径', type: 'text', hint: '留空 = 自动找（优先用 DSH 自带的运行时 python）' },
    { key: 'pipIndex', label: 'pip 镜像', type: 'text', hint: '国内留清华源；留空 = 官方源' },
  ],

  panel: 'panel.js',
  tab: 'local',

  setup(api) {
    const log = api.log
    /** 引擎就绪状态的短期缓存，避免每张图都起一次 python 探版本。 */
    let readyCache = null
    /** 能看图的模型清单，5 分钟一刷。 */
    let visionList = null
    /**
     * installer.status() 会起 python 量版本，一次几十到几百毫秒。
     * 面板每 2.5 秒拉一次 /status，不能每次都真探：缓存 30 秒，
     * 面板点「刷新」或安装结束时传 fresh=1 强制重探。
     */
    let statusCache = null
    const STATUS_TTL = 30_000
    async function cachedStatus({ fresh = false } = {}) {
      const now = Date.now()
      if (!fresh && statusCache && now - statusCache.at < STATUS_TTL) return statusCache.value
      const value = await installer.status()
      statusCache = { at: now, value }
      return value
    }
    /** 最近 N 次识别记录，面板「最近识别」用。只在内存里，重启就清空。 */
    const recent = []
    const RECENT_MAX = 30
    function remember(rec) {
      try {
        recent.unshift(rec)
        if (recent.length > RECENT_MAX) recent.length = RECENT_MAX
      } catch {}
    }
    const ocr = createOcr({ dir: () => installer.dir(), log })
    const installer = createInstaller({
      log,
      settings: () => api.settings(),
      dataDir: (...p) => api.dataDir(...p),
      onState: (s) => {
        if (s.phase === 'ready') log.info(`引擎就绪：${s.detail || s.engine || ''}`)
        else if (s.phase === 'error') log.warn(`安装失败（${s.step}）：${String(s.error).slice(0, 300)}`)
      },
    })

    /**
     * 这个聊天现在用的模型能不能看图。三态：true / false / null（判不出来）。
     *
     * 必须按「这个聊天」算，不能只看全局默认：主人常给私聊单独指定便宜模型，
     * 全局默认是多模态、私聊那个是纯文本，只看全局就会误判成「能看图」而跳过 OCR。
     * 判定顺序和 hub 的 canSeeFor 一致：手动 overrides → 按聊天选的模型 → 元数据。
     */
    async function modelCanSee(chat) {
      try {
        const cfg = api.config()
        const llm = api.lib('core/llm.js')
        const manual = cfg?.model?.vision
        if (manual === 'on') return true
        if (manual === 'off') return false
        let provider = ''
        let model = ''
        try {
          const cm = api.lib('chat/chat-model.js')
          // 和 hub 的 canSeeFor 一样：传入可用模型清单，配置里指的模型已经不存在时
          // resolveChatModel 会返回 null，跟着就会退回默认模型，判定才和实际发出去的请求一致。
          let available = null
          try {
            const list = await api.core.listModels?.()
            if (Array.isArray(list)) available = list.map((m) => ({ provider: m.provider, model: m.id || m.model }))
          } catch {}
          const sel = cm.resolveChatModel?.(cfg, chat, available)
          if (sel?.provider && sel?.model) {
            provider = sel.provider
            model = sel.model
          }
        } catch (error) {
          log.debug('按聊天取模型失败，退回默认：', error.message)
        }
        if (!provider) {
          const fallback = cfg?.model || {}
          provider = fallback.provider || ''
          model = fallback.model || ''
        }
        if (!provider || !model) return null
        const r = await llm.modelVision?.(api.dsh, provider, model)
        log.debug(`看图能力：${provider}/${model} → ${r}`)
        return r === undefined ? null : r
      } catch (error) {
        log.debug('判定视觉能力失败：', error.message)
        return null
      }
    }

    /**
     * 挑一个真能看图的模型来补画面描述。
     *
     * 优先用设置里指定的；没指定就从当前可用模型里挑一个元数据写着 vision=true 的。
     * 当前聊天模型本身能看图时不用挑——那种情况 hub 会把原图直接给她，描述是多余的。
     */
    async function pickDescribeModel(chat, canSee) {
      if (canSee === true) return null
      const s = api.settings()
      if (s.describeProvider && s.describeModelId) {
        return { provider: String(s.describeProvider), model: String(s.describeModelId) }
      }
      const now = Date.now()
      if (!visionList || now - visionList.at > 5 * 60_000) {
        let list = []
        try {
          const raw = await api.core.listModels?.()
          if (Array.isArray(raw)) list = raw.filter((m) => m && m.vision === true && m.provider && m.model)
        } catch (error) {
          log.debug('取模型清单失败：', error.message)
        }
        visionList = { at: now, list }
      }
      const first = visionList.list[0]
      return first ? { provider: first.provider, model: first.model } : null
    }

    function renderText(results) {      const s = api.settings()
      const blocks = []
      results.forEach((r, i) => {
        if (!r?.ok || !r.text) return
        const head = results.length > 1 ? `—— 第 ${i + 1} 张 ——\n` : ''
        blocks.push(head + r.text)
      })
      if (!blocks.length) return ''
      return `${s.prefix || ''}\n${blocks.join('\n\n')}`
    }

    async function ensureReady() {
      // 探针会起 python 量版本，每张图都探一遍太浪费：命中就缓存 60 秒。
      const now = Date.now()
      if (readyCache && now - readyCache.at < 60_000) return readyCache.value
      const st = await cachedStatus()
      // ready = 自有环境就绪；borrowed = 系统里本来就有 rapidocr，够用
      let value = Boolean(st.ready)
      // 只有 missing（有 python、没引擎、目录是我们的）才自动装。
      // blocked（目录被占 / venv 不是我们的 / 没 python）绝不自动动手。
      if (!value && st.state === 'missing' && api.settings().autoInstall) {
        const s = await installer.ensure()
        value = s.phase === 'ready'
        if (value) statusCache = null
      }
      readyCache = { at: now, value }
      return value
    }

    // ── 核心：把图片块换成文字块 ─────────────────────────────
    //
    // 注意这里**不用** modelCanSee 当门禁。元数据写着 vision=true 不代表这一轮
    // 真的把图送到了模型手上：附件中间层丢图、历史图被 offload、provider 自己
    // 吞掉 image 块，都会让模型看到一片空白，而元数据依然是 true。
    // 拿它决定「跳过处理」等于把唯一的保底手段关掉，所以她照旧说「一张空图」。
    // OCR 是本地跑的、有缓存，几乎零成本，所以：永远做。
    async function transform(content, chat) {
      const s = api.settings()
      if (!s.enabled) return
      const imgs = (content || []).filter((c) => c && IMAGE_TYPES.has(c.type) && c.data)
      if (!imgs.length) return

      const canSee = await modelCanSee(chat)

      const ready = await ensureReady()
      if (!ready) {
        log.debug('引擎没就绪，图片原样放行')
        return
      }

      const picked = imgs.slice(0, Math.max(1, Number(s.maxImages) || 3))
      const bufs = picked.map((c) => Buffer.from(c.data, 'base64'))
      const t0 = Date.now()
      const map = await ocr.recognize(
        picked.map((c, i) => ({ id: `i${i}`, buf: bufs[i], mediaType: c.mediaType })),
        { minScore: Number(s.minScore) || 0 },
      )
      const results = picked.map((_, i) => map.get(`i${i}`))
      const hit = results.filter((r) => r?.cached).length

      // 字 + 画面两部分拼起来。纯表情包、照片、无字梗图 OCR 一律读 0 行，
      // 这时候光放行原图没用——聊天模型本身可能就是瞎的，她还是会说「一张空图」。
      // 所以没字的时候借一个真能看图的模型补一句画面描述，至少让她知道图里是什么。
      const parts = []
      picked.forEach((c, i) => {
        const r = results[i]
        const head = picked.length > 1 ? `—— 第 ${i + 1} 张 ——` : ''
        const facts = imageFacts(bufs[i], c.mediaType)
        const lines = []
        if (head) lines.push(head)
        if (facts.length && s.showFacts !== false) lines.push(`（${facts.join(' · ')}）`)
        if (r?.ok && r.text) lines.push(isSubstantive(r) ? r.text : `（只有一个「${r.text.trim()}」，等于没有字）`)
        parts.push(lines.join('\n'))
      })

      // 有图没字 → 试画面描述
      //
      // 注意不能只看 `!r.text`：表情包上常有个孤零零的标点（「?」「!」「…」），
      // OCR 会老老实实读出来一个字符，于是判定成「有字」、跳过画面描述，
      // 她那边就只拿到一个问号。所以判「实质有内容」：去掉标点/空白/符号后
      // 至少还得剩几个字。
      const blank = picked.map((_, i) => !isSubstantive(results[i]))
      let described = []
      if (blank.some(Boolean) && s.describeFallback !== false) {
        const target = await pickDescribeModel(chat, null)
        if (target) {
          for (let i = 0; i < picked.length; i++) {
            if (!blank[i]) continue
            const d = await describeImage(
              { ask: api.ask, log },
              { buf: bufs[i], mediaType: picked[i].mediaType, model: target },
            )
            if (d) {
              described.push(i)
              parts[i] = [parts[i], `（画面：${d}）`].filter(Boolean).join('\n')
            }
          }
          if (described.length) log.debug(`画面描述：${target.provider}/${target.model} 补了 ${described.length} 张`)
        } else {
          log.debug('没有可用的看图模型，画面描述跳过')
        }
      }

      const text = parts.filter(Boolean).length
        ? `${s.prefix || ''}\n${parts.filter(Boolean).join('\n\n')}`
        : ''
      const keepImage = Boolean(s.keepImage) || canSee === true
      const chars = results.filter((r) => r?.ok && r.text).length
      const describedSel = described.length
      log.debug(
        `识图：${picked.length} 张，${chars} 张有字，` +
          `${describedSel} 张只描述了画面，命中缓存 ${hit}，保留原图 ${keepImage}，${Date.now() - t0}ms` +
          `${text ? '' : '（什么都没读出来，原样放行）'}`,
      )
      remember({
        at: Date.now(),
        chatId: chat?.chatId || '',
        images: picked.length,
        chars,
        described: describedSel,
        cached: hit,
        ms: Date.now() - t0,
        ok: Boolean(text),
        note: text ? '' : '什么都没读出来',
      })
      if (!text) return

      const block = { type: 'text', text }
      const used = new Set(picked)
      let replaced = false
      const next = []
      for (const c of content) {
        if (used.has(c)) {
          if (!replaced) {
            next.push(block)
            replaced = true
          }
          if (keepImage) next.push(c)
        } else {
          next.push(c)
        }
      }
      return next
    }

    api.on('prompt', async (content, ctx) => {
      try {
        return await transform(content, ctx?.chat)
      } catch (error) {
        // 钩子里抛错会让整轮内容没了，宁可原样放行
        log.warn('识图处理出错，图片原样放行：', error.message)
        return
      }
    })

    /**
     * 端到端自检：像「主人刚发来一张图」那样，把一轮内容真的推进她的会话。
     *
     * 和 /probe 的区别：/probe 只测「模型能不能看见图」；这个走完整的 prompt 钩子，
     * 能验证「图片块有没有被换成文字块」「她最后有没有拿到内容」——也就是她会不会
     * 再说「一张空图」。会真的让她回一句话，所以只在主人私聊上用。
     */
    api.route('/e2e', async (req) => {
      const body = await api.core.http.body(req)
      const imgPath = String(body.path || '').trim()
      if (!imgPath || !existsSync(imgPath)) return { ok: false, message: '传一个存在的 path' }
      const buf = readFileSync(imgPath)
      const userId = String(body.userId || api.config()?.ownerQQ || '')
      if (!userId) return { ok: false, message: '没有主人 QQ' }
      const chat = { chatId: `private:${userId}`, kind: 'private', userId }
      const content = [
        { type: 'text', text: String(body.text || '这张图里是什么？') },
        { type: 'image', data: buf.toString('base64'), mediaType: sniff(buf) || 'image/jpeg', name: `e2e-${Date.now()}` },
      ]
      try {
        await api.core.hub.pushToSession(chat, content, userId, {
          queryText: String(body.text || ''),
          speakers: [userId],
        })
        return { ok: true, message: `已推给她（${chat.chatId}），看 QQ 里她怎么回` }
      } catch (error) {
        return { ok: false, message: String(error?.message || error) }
      }
    })

    // ── 工具：她自己决定什么时候用 ───────────────────────────
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      if (!api.settings().enabled) return []
      return api.defineTool({
        name: 'shitu_read',
        description:
          '读图片里的文字（本地 OCR，不联网）。可以用聊天里最近发来的图、引用的那张图，或本机的图片绝对路径。画面内容（长相、场景、表情）读不出来，只有文字。',
        properties: {
          source: {
            type: 'string',
            description: 'last = 这个聊天最近收到的图；quote = 被引用的那条消息里的图；或者填本机图片的绝对路径',
          },
        },
        execute: async ({ source }) => {
          const s = api.settings()
          if (!s.enabled) return { ok: false, message: '识图总开关关着' }
          if (!(await ensureReady())) return { ok: false, message: '识别引擎还没装好，让主人在面板里点一下安装' }
          let buf
          try {
            if (source && /^[a-zA-Z]:[\\/]|^\//.test(source)) {
              if (!existsSync(source)) return { ok: false, message: `找不到这个文件：${source}` }
              buf = readFileSync(source)
            } else {
              buf = await api.core.hub.referenceImage(chat, source === 'quote' ? 'quote' : 'last')
            }
          } catch (error) {
            return { ok: false, message: error.message }
          }
          if (!buf?.length) return { ok: false, message: '没拿到图片' }
          const facts = imageFacts(buf, '')
          const head = facts.length ? `（${facts.join(' · ')}）\n` : ''
          const r = await ocr.one(buf, { minScore: Number(s.minScore) || 0 })
          if (r.ok && r.text) return { ok: true, message: `${head}图里的字：\n${r.text}` }
          // 没字：能被看图的模型看到就直接给她看，否则借一个模型描述一句
          if ((await modelCanSee(chat)) === true) {
            return { ok: true, message: `${head}这张图里没有字，画面你自己看。` }
          }
          if (s.describeFallback === false) return { ok: true, message: `${head}这张图里没有字` }
          const target = await pickDescribeModel(chat, null)
          if (!target) return { ok: true, message: `${head}这张图里没有字，也没有能看图的模型可以描述画面` }
          const d = await describeImage({ ask: api.ask, log }, { buf, mediaType: sniff(buf), model: target })
          return d
            ? { ok: true, message: `${head}这张图里没有字。画面：${d}` }
            : { ok: true, message: `${head}这张图里没有字，画面也没描述出来` }
        },
      })
    })

    api.rule(() => {
      if (!api.settings().enabled) return ''
      return [
        '别人发图片、发表情包时，你看到的是【图里的字】那一块——那是本地 OCR 从图里读出来的文字，不是谁对你说的话。',
        '如果那张图里没有字，那一块会换成「画面：…」——那是一句客观的画面描述，同样不是谁对你说的话。',
        '你能借着这些知道表情包/截图在讲什么梗、在说什么事，可以正常接话。',
        '但你看不到原图本身：不要凭空补充描述里没有的细节（长相、穿着、氛围、情绪），也不要编。',
        '描述里没提到的就直说不知道，别硬猜。',
      ].join('')
    })

    // ── 命令（只认主人）──────────────────────────────────────
    api.command({
      name: '识图',
      desc: '识图开关 / 状态 / 测一张 / 清缓存',
      run: async (arg, msg) => {
        const a = String(arg || '').trim()
        if (!a) {
          const on = !api.settings().enabled
          api.saveSettings({ enabled: on })
          return on ? '识图开了' : '识图关了'
        }
        if (a === '状态' || a === 'status') {
          const st = await installer.status()
          const ls = ocr.cacheSize()
          return [
            `总开关：${api.settings().enabled ? '开' : '关'}`,
            `引擎：${st.ready ? `就绪（${st.rapidocr || '?'}）` : st.engineReady ? '有引擎，缺脚本' : '没装'}`,
            `目录：${installer.dir()}`,
            `缓存：${ls.count} / ${ls.max}`,
            st.reason ? `说明：${st.reason}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        }
        if (a.startsWith('装') || a === 'install') {
          installer.ensure()
          return '开始安装，进度看面板「本地接口」页最下面的识图卡片'
        }
        if (a.startsWith('测')) {
          const path = a.replace(/^测\s*/, '').trim()
          if (!path) return '用法：/识图 测 <本机图片绝对路径>'
          if (!existsSync(path)) return `找不到文件：${path}`
          const st = await installer.status()
          if (!st.python) return '引擎还没装好，先 /识图 装'
          const t0 = Date.now()
          const r = await installer.selfTestFile(installer.dir(), st.python, path)
          if (!r.ok) return `失败：${r.message}`
          return `读到 ${r.lines} 行，${Date.now() - t0}ms\n${r.text.slice(0, 800)}`
        }
        if (a === '清缓存') {
          ocr.clearCache()
          return '识别缓存清了'
        }
        if (a.startsWith('看')) {
          const path = a.replace(/^看\s*/, '').trim()
          if (!path) return '用法：/识图 看 <本机图片绝对路径>'
          if (!existsSync(path)) return `找不到文件：${path}`
          const buf = readFileSync(path)
          const facts = imageFacts(buf, '')
          const r = await ocr.one(buf)
          const parts = [`（${facts.join(' · ')}）`]
          if (r.ok && r.text) parts.push(r.text)
          else {
            const target = await pickDescribeModel(null, null)
            const d = target
              ? await describeImage({ ask: api.ask, log }, { buf, mediaType: sniff(buf), model: target })
              : ''
            parts.push(d ? `（画面：${d}）` : '（没字，也没有能看图的模型可用）')
          }
          return parts.join('\n').slice(0, 900)
        }
        return '用法：/识图 [状态|装|测 路径|看 路径|清缓存]，不带参数 = 切换开关'
      },
    })

    // ── 面板接口 ─────────────────────────────────────────────
    api.route('/status', async (req) => {
      const q = api.core.http.query?.(req) || {}
      // 面板每 2.5 秒拉一次；探针会起 python 量版本，太贵。
      // 只有带 fresh=1（点刷新 / 刚点完安装）时才重新探。
      const fresh = String(q.fresh || '') === '1'
      if (fresh) readyCache = null
      const st = await cachedStatus({ fresh })
      const s = api.settings()
      let describeTarget = null
      try {
        describeTarget = await pickDescribeModel(null, null)
      } catch {}
      // 面板要知道「她这个聊天到底能不能看见图」，用来解释为什么还要 OCR
      let chatCanSee = null
      try {
        const id = String(q.chatId || '')
        if (id) {
          chatCanSee = await modelCanSee({ chatId: id, kind: id.startsWith('group:') ? 'group' : 'private', userId: id.split(':')[1] })
        }
      } catch {}
      return {
        ok: true,
        status: st,
        progress: installer.state,
        settings: s,
        cache: ocr.cacheSize(),
        recent: recent.slice(0, 12),
        describeTarget,
        chatCanSee,
      }
    })

    api.route('/install', async () => {
      installer.ensure()
      return { ok: true, message: '已开始安装，轮询 /status 看进度' }
    })

    /**
     * 测一张：和真实聊天走完全同一条处理链（OCR → 判有没有字 → 需要就补画面描述），
     * 但结果是「如果她收到这张图，她会看到什么」，不发消息、不碰会话。
     * 这样面板上试出来的东西，就是线上真的会发生的东西。
     */
    api.route('/test', async (req) => {
      const body = await api.core.http.body(req)
      const st = await cachedStatus()
      if (!st.python || !st.engineReady) return { ok: false, message: '引擎还没装好' }
      const dir = installer.dir()

      let buf = null
      let label = ''
      if (body.base64) {
        buf = Buffer.from(String(body.base64).replace(/^data:[^,]*,/, ''), 'base64')
        label = '上传的图'
      } else if (body.path) {
        if (!existsSync(body.path)) return { ok: false, message: `找不到文件：${body.path}` }
        buf = readFileSync(body.path)
        label = String(body.path)
      } else {
        // 留空 = 跑自带测试图
        return installer.selfTest(dir, st.python)
      }

      const s = api.settings()
      const t0 = Date.now()
      const mediaType = sniff(buf) || 'image/jpeg'
      const r = await ocr.one(buf, { minScore: Number(s.minScore) || 0 })
      const facts = imageFacts(buf, mediaType)
      const lines = (r.lines || []).length
      const substantive = isSubstantive(r)

      // 真走一遍「没字就描述」的分支，好让面板预览和线上一致
      let described = ''
      let describeBy = ''
      if (!substantive && s.describeFallback !== false) {
        const target = await pickDescribeModel(null, null)
        if (target) {
          described = await describeImage({ ask: api.ask, log }, { buf, mediaType, model: target })
          if (described) describeBy = `${target.provider}/${target.model}`
        }
      }

      // 拼出「她实际会看到的那块字」
      const previewParts = []
      if (facts.length && s.showFacts !== false) previewParts.push(`（${facts.join(' · ')}）`)
      if (r.ok && r.text) {
        previewParts.push(substantive ? r.text : `（只有一个「${r.text.trim()}」，等于没有字）`)
      }
      if (described) previewParts.push(`（画面：${described}）`)
      const preview = previewParts.length ? `${s.prefix || ''}\n${previewParts.join('\n')}` : ''

      return {
        ok: true,
        label,
        text: r.text || '',
        lines,
        substantive,
        facts,
        described,
        describeBy,
        preview,
        cached: Boolean(r.cached),
        elapsedMs: Date.now() - t0,
        ocrMs: r.elapsedMs || 0,
        error: r.ok ? '' : r.error || '',
      }
    })

    api.route('/cache/clear', async () => {
      ocr.clearCache()
      return { ok: true }
    })

    /**
     * 自检：把一张已知内容的图直接塞给「当前聊天模型」，看它到底能不能看见。
     *
     * 有些 provider 的模型元数据写着能看图，实际请求里的图片被中间层丢了，
     * 表现就是她说「一张空图」。这个接口用来区分是「我们没把图送到」还是
     * 「送到了但模型看不见」，省得靠猜。
     */
    api.route('/probe', async (req) => {
      const body = await api.core.http.body(req)
      const chat = body.chat || { chatId: 'private:probe', kind: 'private', userId: 'probe' }
      const canSee = await modelCanSee(chat)
      const target = await pickDescribeModel(chat, canSee)
      const imgPath = String(body.path || '').trim()
      const buf = imgPath && existsSync(imgPath) ? readFileSync(imgPath) : null
      const out = { canSee, target, seen: null, error: '' }
      if (!buf) {
        out.error = '没有可用的探针图片（传 path）'
        return out
      }
      try {
        const answer = await api.ask({
          system: '你在看一张图片。用一句话说你看到了什么，包括画面里任何文字。看不清就说「看不到图」。',
          text: '这张图里是什么？',
          images: [{ data: buf.toString('base64'), mediaType: sniff(buf) || 'image/jpeg' }],
          maxTokens: 200,
          temperature: 0,
        })
        out.seen = String(answer || '').trim()
      } catch (error) {
        out.error = String(error?.message || error)
      }
      return out
    })

    // 启动时静默探一次状态。注意这里**不先铺脚本**：
    // 先探才知道目录是不是我们的，铺在探之前等于往别人的目录里写文件。
    // 真需要装的话 installer.ensure() 内部会先校验再铺。
    api.later(2000, async () => {
      try {
        const s = api.settings()
        const st = await installer.status()
        log.info(
          `识图：${st.state}${st.state === 'ready' || st.state === 'borrowed' ? '（可用）' : ''}` +
            ` · ${installer.dir()}` +
            `${st.reason ? ' · ' + st.reason.split('\n')[0] : ''}`,
        )
        // 只有 missing 才自动装；ready / borrowed / blocked 一律不动
        if (st.state === 'missing' && s.autoInstall) await installer.ensure()
      } catch (error) {
        log.warn('启动自检失败：', error.message)
      }
    })

    return {
      status: () => installer.status(),
      install: () => installer.ensure(),
      ocr: (buf, opts) => ocr.one(buf, opts),
      dir: () => installer.dir(),
      dispose() {},
    }
  },
}
