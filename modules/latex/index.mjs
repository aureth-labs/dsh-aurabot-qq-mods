// LaTeX 渲染：@ 她并给一段公式（或引用一条公式再 @ 她），她在本机把公式画成图片发回来。
// 排版用 MathJax，光栅化和 PNG 编码都是自己写的，不联网、不读写文件、不装 TeX。
// 关键点：这个模块在「回不回」的决定之前就接管消息（message 返回 true），
// 所以她不会为了一条公式去思考、去调模型——出图就是几十毫秒的事。
// 触发方式（前缀指令 / @ / 引用）、设置项见 README.md；纯函数在 lib/ 里。
import { encodePng } from './lib/png.mjs'
import { cutAroundTrigger, extractFormulas, hasTrigger, looksLikeLatex, stripTrigger, validateLatex } from './lib/parse.mjs'
import { backgroundColor, renderLatex, warmUp } from './lib/render.mjs'
import { stackImages } from './lib/stack.mjs'
import { unicodeToLatex } from './lib/unicode.mjs'

const IMAGE_NOTE = '[公式图片]'
const STACK_GAP = 16

const int = (v, min, max, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// 「\公式渲染 …」「#公式 …」「/公式 …」这种前缀指令。
// `/` 本来归宿主的命令系统管（下面也注册了 api.command），但主人之外、或者宿主没接住的，
// 这里也自己认一遍，省得两边都不管。
const CMD_PREFIX = /^\s*[\\#＃/]\s*/
// 名字后面允许直接接这些（`\公式\frac{1}{2}` 这种不加空格的写法）
const CMD_LEAD_OK = /^[\s:：,，。.、\\$]/
// 剥掉名字和公式之间的空白、标点；`\` 和 `$` 要留着，那是公式本身的开头
const CMD_STRIP = /^[\s:：,，。.、]+/

const CMD_ALIASES = {
  公式渲染: 'draw', 公式: 'draw', 渲染: 'draw', latex: 'draw', tex: 'draw', math: 'draw',
  公式帮助: 'help', 公式用法: 'help', help: 'help', '?': 'help', 帮助: 'help',
  公式设置: 'status', 公式状态: 'status', 状态: 'status',
  公式字号: 'set:fontSize', 字号: 'set:fontSize',
  公式留白: 'set:padding', 留白: 'set:padding',
  公式配色: 'set:theme', 配色: 'set:theme', 公式主题: 'set:theme',
  公式字色: 'set:foreground', 字色: 'set:foreground',
  公式布局: 'set:layout', 布局: 'set:layout',
  公式排版: 'set:displayMode', 排版方式: 'set:displayMode',
  公式冷却: 'set:cooldown', 冷却: 'set:cooldown',
  公式缓存: 'set:cacheSize', 缓存: 'set:cacheSize',
}

// 长名字先试，免得「公式帮助」被「公式」抢走
const CMD_NAMES = Object.keys(CMD_ALIASES).sort((a, b) => b.length - a.length)

const HELP_TEXT = [
  'LaTeX 渲染：',
  '\\公式渲染 <latex>　画一张图（/公式 也行，后面直接跟公式）',
  '\\公式帮助　看这段',
  '也认 @我 加 $…$、或者引用一条公式再 @我',
  '（主人：\\公式设置 看当前设置，\\公式字号 60、\\公式配色 dark 这样改）',
].join('\n')

/** 认出前缀指令，返回 { action, arg } 或 null。 */
function matchCommand(text) {
  const src = String(text || '')
  const prefix = CMD_PREFIX.exec(src)
  if (!prefix) return null
  const rest = src.slice(prefix[0].length)
  const low = rest.toLowerCase()
  for (const name of CMD_NAMES) {
    if (!low.startsWith(name.toLowerCase())) continue
    const after = rest.slice(name.length)
    // 名字后面得断开（空白、标点、或者直接接公式），「公式化」这种不算指令
    if (after && !CMD_LEAD_OK.test(after)) continue
    return { action: CMD_ALIASES[name], arg: after.replace(CMD_STRIP, '').trim() }
  }
  return null
}

/** 把面板里存的设置洗成能直接用的形状（面板可能留着旧版本的值）。 */
function normalize(settings) {
  const raw = settings || {}
  const theme = String(raw.theme || raw.background || 'white').toLowerCase()
  return {
    triggerWords: String(raw.triggerWords ?? ''),
    fontSize: int(raw.fontSize, 12, 200, 40),
    padding: int(raw.padding, 0, 80, 8),
    theme: theme === 'dark' || theme === 'transparent' ? theme : 'white',
    foreground: String(raw.foreground || '').trim(),
    maxWidth: int(raw.maxWidth, 0, 4000, 600),
    onlyOwner: raw.onlyOwner === true,
    displayMode: raw.displayMode === 'inline' ? 'inline' : 'display',
    layout: raw.layout === 'stack' ? 'stack' : 'separate',
    maxFormulas: int(raw.maxFormulas, 1, 5, 3),
    maxChars: int(raw.maxChars, 20, 2000, 300),
    cooldown: int(raw.cooldown, 0, 600, 0),
    quoteReply: raw.quoteReply !== false,
    readQuote: raw.readQuote !== false,
    caption: String(raw.caption ?? '').trim(),
    showError: raw.showError !== false,
    cacheSize: int(raw.cacheSize, 0, 300, 60),
    tool: raw.tool !== false,
  }
}

/**
 * 从一段文字里挑公式：先找 $…$ 那几种写法，找不到就把触发词后面那截当公式。
 * requireTrigger=false 用于「引用的那条消息」——既然是为了画公式才去读它的，
 * 里面直接就是裸公式（\int_0^1 x dx）也该认。
 */
function collectFrom(text, settings, { requireTrigger = true } = {}) {
  const src = String(text || '')
  if (!src.trim()) return []
  const { formulas } = extractFormulas(src)
  // 手打出来的 x²、√2、α+β 先在 lib/unicode.mjs 里转成 LaTeX，再往下走
  if (formulas.length) return formulas.map((f) => ({ latex: unicodeToLatex(f.latex), display: f.display }))
  if (requireTrigger && !hasTrigger(src, settings.triggerWords)) return []
  const bare = cutAroundTrigger(src, settings.triggerWords)
  if (!bare || bare.length > settings.maxChars) return []
  const converted = unicodeToLatex(bare)
  if (!looksLikeLatex(converted)) return []
  return [{ latex: converted, display: true }]
}

/** OneBot 的 message 字段可能是字符串也可能是一串消息段，统一取文字部分。 */
function textOfSegments(message) {
  if (typeof message === 'string') return message.replace(/\[CQ:[^\]]*\]/g, ' ')
  if (!Array.isArray(message)) return ''
  return message
    .map((seg) => (typeof seg === 'string' ? seg : seg?.type === 'text' ? String(seg?.data?.text ?? '') : ' '))
    .join(' ')
}

const THEME_WORDS = { white: 'white', 白: 'white', 白底: 'white', dark: 'dark', 深色: 'dark', 黑: 'dark', 深色底: 'dark', transparent: 'transparent', 透明: 'transparent', 透明底: 'transparent' }
const LAYOUT_WORDS = { separate: 'separate', 分开: 'separate', 一张一张: 'separate', stack: 'stack', 拼: 'stack', 拼一张: 'stack', 竖着拼: 'stack' }
const MODE_WORDS = { display: 'display', 独占: 'display', 独占一行: 'display', inline: 'inline', 行内: 'inline', 紧凑: 'inline' }

export default {
  id: 'latex',
  name: 'LaTeX 渲染',
  version: '2.3.0',
  api: 1,
  description: '@ 她并给一段 LaTeX（或发「\\公式渲染」，本机把公式渲染成图片发回来）。不联网、不走模型，几十毫秒出图。',
  defaults: {
    triggerWords: 'latex,tex,math,公式,渲染,排版',
    fontSize: 40,
    padding: 8,
    maxWidth: 600,
    onlyOwner: false,
    theme: 'white',
    foreground: '',
    displayMode: 'display',
    layout: 'separate',
    maxFormulas: 3,
    maxChars: 300,
    cooldown: 0,
    quoteReply: true,
    readQuote: true,
    caption: '',
    showError: true,
    cacheSize: 60,
    tool: true,
  },
  settings: [
    { key: 'triggerWords', label: '触发词', type: 'text', placeholder: 'latex,tex,math,公式,渲染,排版', hint: '用逗号隔开。消息里有这些词（或者有 $…$）并且 @ 了她，就当成要画公式' },
    { key: 'fontSize', label: '字号（像素 / em）', type: 'number', min: 12, max: 120, step: 2, hint: '越大越清楚，图也越大。40 大约和聊天里一行字差不多高' },
    { key: 'padding', label: '四周留白（像素）', type: 'number', min: 0, max: 60, step: 2, hint: 'MathJax 排出来是贴边的，加一点才不会顶到图片边' },
    { key: 'theme', label: '配色', type: 'select', options: [{ value: 'white', label: '白底黑字' }, { value: 'dark', label: '深色底浅字' }, { value: 'transparent', label: '透明底' }] },
    { key: 'maxWidth', label: '最宽（像素）', type: 'number', min: 0, max: 2000, step: 50, hint: '超过这个宽度就等比缩小，免得手机上要左右滑。0 = 不限' },
    { key: 'onlyOwner', label: '只有主人能用', type: 'switch', hint: '默认关：白名单聊天里谁都能画。打开后只有主人能触发' },
    { key: 'foreground', label: '字色覆盖', type: 'text', placeholder: '留空就是按配色来', hint: '英文色名或者 #FF6600。填了就以它为准，比如只把字换成蓝色' },
    { key: 'displayMode', label: '排版方式', type: 'select', options: [{ value: 'display', label: '独占一行（公式舒展）' }, { value: 'inline', label: '行内样式（紧凑）' }] },
    { key: 'layout', label: '多条公式', type: 'select', options: [{ value: 'separate', label: '一张一张发' }, { value: 'stack', label: '竖着拼成一张' }] },
    { key: 'maxFormulas', label: '一条消息最多画几个', type: 'number', min: 1, max: 5, step: 1 },
    { key: 'maxChars', label: '单个公式最多多少字', type: 'number', min: 20, max: 2000, step: 10 },
    { key: 'cooldown', label: '冷却（秒）', type: 'number', min: 0, max: 600, step: 1, hint: '同一个人连着发时，这么多秒内只画第一张。0 = 不限，来一条画一条' },
    { key: 'quoteReply', label: '群里引用她那条消息再发图', type: 'switch', hint: '关掉就是直接甩一张图，不引用你的消息' },
    { key: 'readQuote', label: '读引用的消息里的公式', type: 'switch', hint: '开着才能「引用一条公式 + @她 渲染一下」这种用法' },
    { key: 'caption', label: '发图时带一句话', type: 'text', placeholder: '留空就不带', hint: '比如「画好了」，会在图片前面发一条文字' },
    { key: 'showError', label: '画不出来时说一声', type: 'switch', hint: '关掉的话，公式有问题就安静跳过，交给正常聊天' },
    { key: 'cacheSize', label: '缓存多少张', type: 'number', min: 0, max: 300, step: 10, hint: '同样的公式再来一次直接复用，0 = 不缓存' },
    { key: 'tool', label: '也给她一个渲染工具', type: 'switch', hint: '开着的话，她可以自己把别人给的公式画成图片（latex_render）' },
  ],
  setup(api) {
    // 同一个人连点太快时，冷却期内只画第一张
    const lastAt = new Map()
    // 相同公式 + 相同样式就不重画（省时间也省内存）
    const cache = new Map()

    // MathJax 第一次排版要加载字体（几百毫秒，同步的），趁启动后没人用的时候先热起来
    api.later(5000, () => {
      try {
        warmUp()
        api.log.info('MathJax 预热好了，接下来每条公式都不用再等字体')
      } catch (error) {
        api.log.warn('MathJax 预热失败，第一条公式会慢一点：', error?.message || error)
      }
    })

    const settingsNow = () => normalize(api.settings())

    function styleOptions(settings, display) {
      return {
        display,
        fontSize: settings.fontSize,
        padding: settings.padding,
        maxWidth: settings.maxWidth,
        theme: settings.theme,
        foreground: settings.foreground || undefined,
      }
    }

    function renderCached(latex, options, cacheSize) {
      const key = [latex, options.display ? 1 : 0, options.fontSize, options.padding, options.theme, options.foreground || ''].join('\u0001')
      if (cacheSize > 0) {
        const hit = cache.get(key)
        if (hit) {
          cache.delete(key) // 重新插到队尾，当作刚用过
          cache.set(key, hit)
          return hit
        }
      }
      const drawn = renderLatex(latex, options)
      if (drawn.ok && cacheSize > 0) {
        cache.set(key, drawn)
        while (cache.size > cacheSize) cache.delete(cache.keys().next().value)
      }
      return drawn
    }

    /** 画好一组公式，返回 { ok, images, background } 或 { ok: false, error }。 */
    function draw(items, settings) {
      const images = []
      let background = 'white'
      for (const item of items) {
        const drawn = renderCached(item.latex, styleOptions(settings, item.display), settings.cacheSize)
        if (!drawn.ok) return { ok: false, error: drawn.error }
        images.push(drawn.image)
        background = drawn.background
      }
      return { ok: true, images, background }
    }

    /** 渲染 + 拼图 + 编码 + 发出去。返回 { ok, count, error }。 */
    async function paint(items, settings, chatId, { quoteId, withCaption = true } = {}) {
      const startedAt = Date.now()
      const drawn = draw(items, settings)
      if (!drawn.ok) return { ok: false, error: drawn.error }
      const drawnAt = Date.now()

      // 拼成一张时背景要自己垫，透明主题就垫成全透明
      const pngs = []
      if (settings.layout === 'stack' && drawn.images.length > 1) {
        const merged = stackImages(drawn.images, { gap: STACK_GAP, fill: backgroundColor(drawn.background) })
        pngs.push(encodePng(merged.width, merged.height, merged.rgba))
      } else {
        for (const image of drawn.images) pngs.push(encodePng(image.width, image.height, image.rgba))
      }

      const segs = []
      if (quoteId) segs.push({ type: 'reply', data: { id: String(quoteId) } })
      if (withCaption && settings.caption) segs.push({ type: 'text', data: { text: settings.caption } })
      for (const png of pngs) segs.push({ type: 'image', data: { file: 'base64://' + png.toString('base64') } })

      const sent = await api.sendSegments(chatId, segs, IMAGE_NOTE)
      // 一行日志看清慢在哪：画要多久、交给 QQ 网关要多久
      api.log.info(`画了 ${pngs.length} 张（${items.length} 条公式）：渲染 ${drawnAt - startedAt}ms，发出去 ${Date.now() - drawnAt}ms`)
      if (!sent) api.log.warn('公式图片没发出去（总开关关着、或者正在试运行）')
      return { ok: true, count: pngs.length, sent: Boolean(sent) }
    }

    /** 校验并整理候选公式；有毛病时把原因写在 error 里。 */
    function validateAll(candidates, settings) {
      const items = []
      let error = ''
      for (const c of candidates.slice(0, settings.maxFormulas)) {
        const latex = String(c.latex || '').trim()
        if (!latex) continue
        if (latex.length > settings.maxChars) {
          error = `公式超过 ${settings.maxChars} 个字了`
          continue
        }
        const bad = validateLatex(latex)
        if (bad) {
          error = bad
          continue
        }
        items.push({ latex, display: settings.displayMode === 'inline' ? false : c.display !== false })
      }
      return { items, error }
    }

    function statusText(settings) {
      const themeName = { white: '白底黑字', dark: '深色底浅字', transparent: '透明底' }[settings.theme]
      return [
        '当前设置：',
        `字号 ${settings.fontSize}　留白 ${settings.padding}　配色 ${themeName}`,
        `字色 ${settings.foreground || '跟随配色'}　排版 ${settings.displayMode}　多条 ${settings.layout === 'stack' ? '拼一张' : '分开'}`,
        `冷却 ${settings.cooldown} 秒　缓存 ${settings.cacheSize} 张　一条最多 ${settings.maxFormulas} 个公式`,
        `触发词 ${settings.triggerWords || '（默认）'}`,
      ].join('\n')
    }

    /** 改一项设置，返回给用户看的一句话。 */
    function applySetting(key, rawArg, settings) {
      const arg = String(rawArg || '').trim()
      if (!arg) return `要一个值，比如 \\公式${key === 'foreground' ? '字色' : ''} ${key === 'theme' ? 'dark' : key === 'layout' ? 'stack' : '60'}`
      if (key === 'foreground') {
        if (/^(重置|默认|清除|reset)$/i.test(arg)) {
          api.saveSettings({ foreground: '' })
          return '字色改回跟随配色了'
        }
        api.saveSettings({ foreground: arg })
        return `字色换成 ${arg} 了`
      }
      if (key === 'theme') {
        const v = THEME_WORDS[arg.toLowerCase()] || THEME_WORDS[arg]
        if (!v) return '配色只有 white / dark / transparent（白底 / 深色 / 透明）'
        api.saveSettings({ theme: v })
        return `配色换成 ${v} 了`
      }
      if (key === 'layout') {
        const v = LAYOUT_WORDS[arg.toLowerCase()] || LAYOUT_WORDS[arg]
        if (!v) return '布局只有 separate（分开）或 stack（拼一张）'
        api.saveSettings({ layout: v })
        return v === 'stack' ? '多条公式改成竖着拼一张了' : '多条公式改成一张一张发了'
      }
      if (key === 'displayMode') {
        const v = MODE_WORDS[arg.toLowerCase()] || MODE_WORDS[arg]
        if (!v) return '排版只有 display（独占一行）或 inline（行内）'
        api.saveSettings({ displayMode: v })
        return `排版改成 ${v} 了`
      }
      const ranges = { fontSize: [12, 200], padding: [0, 80], cooldown: [0, 600], cacheSize: [0, 300] }
      const [min, max] = ranges[key] || [0, 999]
      const n = Number(arg)
      if (!Number.isFinite(n)) return '要一个数字'
      const value = Math.min(max, Math.max(min, Math.round(n)))
      api.saveSettings({ [key]: value })
      const names = { fontSize: '字号', padding: '留白', cooldown: '冷却', cacheSize: '缓存' }
      return `${names[key] || key}改成 ${value} 了${value === n ? '' : `（范围 ${min}~${max}）`}`
    }

    /** 前缀指令。返回 true = 接管了这条消息。 */
    async function handleCommand(msg, settings) {
      const hit = matchCommand(msg.text)
      if (!hit) return false
      const { action } = hit
      const arg = hit.arg

      if (action === 'help') {
        await api.reply(msg, HELP_TEXT)
        return true
      }
      if (action === 'status') {
        if (!api.isOwner(msg.userId)) {
          await api.reply(msg, '这个得主人来看')
          return true
        }
        await api.reply(msg, statusText(settings))
        return true
      }
      if (action.startsWith('set:')) {
        if (!api.isOwner(msg.userId)) {
          await api.reply(msg, '这个得主人来改')
          return true
        }
        const said = applySetting(action.slice(4), arg, settings)
        api.log.info(`指令改设置：${action.slice(4)} = ${arg || '（空）'}`)
        await api.reply(msg, said)
        return true
      }

      // action === 'draw'：后面跟的就是公式（有人会把「帮助」写在公式位）
      if (/^(帮助|用法|help|\?)$/i.test(arg)) {
        await api.reply(msg, HELP_TEXT)
        return true
      }
      const source = arg || ''
      if (!source) {
        await api.reply(msg, '公式呢？发「\\公式渲染 \\frac{1}{2}」这样')
        return true
      }
      let candidates = collectFrom(source, settings, { requireTrigger: false })
      if (!candidates.length && settings.readQuote) {
        const quoted = await quotedText(msg)
        if (quoted) candidates = collectFrom(quoted, settings, { requireTrigger: false })
      }
      if (!candidates.length) {
        await api.reply(msg, '这段没认出公式，用 LaTeX 写法发我试试')
        return true
      }
      const { items, error } = validateAll(candidates, settings)
      if (!items.length) {
        await api.reply(msg, `这条公式画不出来：${error || '没认出公式'}`)
        return true
      }
      const painted = await paint(items, settings, msg.chatId, { quoteId: msg.kind === 'group' ? msg.messageId : undefined })
      if (!painted.ok) await api.reply(msg, `公式没画出来：${painted.error}`)
      return true
    }

    async function quotedText(msg) {
      if (!msg.replyId) return ''
      try {
        const data = await api.onebot('get_msg', { message_id: msg.replyId })
        return textOfSegments(data?.message ?? data?.raw_message ?? '')
      } catch (error) {
        api.log.debug('取引用的消息失败：', error?.message || error)
        return ''
      }
    }

    api.on('message', async (msg) => {
      if (!msg || msg.kind === 'system') return false

      const settings = settingsNow()
      // 开了「只有主人能用」就把别人的都放过去，交给她正常聊天
      if (settings.onlyOwner && !api.isOwner(msg.userId)) return false

      // 前缀指令（\公式渲染 / #公式 …）：不用 @，谁都能用
      if (await handleCommand(msg, settings)) return true

      if (msg.kind === 'group' && !msg.mentioned) return false

      // 1) 先看这条消息自己；2) 没写公式就看看它引用的那条
      let candidates = collectFrom(msg.text, settings)
      if (!candidates.length && settings.readQuote) {
        const quoted = await quotedText(msg)
        if (quoted) candidates = collectFrom(quoted, settings, { requireTrigger: false })
      }
      if (!candidates.length) return false // 不是公式，交给她正常聊天

      const { items, error } = validateAll(candidates, settings)

      if (!items.length) {
        if (!error) return false
        if (!settings.showError) return true // 安静跳过，别让她去解释
        await api.reply(msg, `这条公式画不出来：${error}`)
        return true
      }

      const who = `${msg.chatId}:${msg.userId}`
      const now = Date.now()
      if (settings.cooldown > 0) {
        const last = lastAt.get(who) || 0
        if (now - last < settings.cooldown * 1000) {
          api.log.debug(`${who} 还在冷却里（${settings.cooldown}s），这条先不画`)
          return true
        }
        lastAt.set(who, now)
        if (lastAt.size > 500) lastAt.clear()
      }

      const painted = await paint(items, settings, msg.chatId, {
        quoteId: settings.quoteReply && msg.kind === 'group' ? msg.messageId : undefined,
      })
      if (!painted.ok) {
        api.log.warn('公式没画出来：', painted.error)
        if (settings.showError) await api.reply(msg, `公式没画出来：${painted.error}`)
      }
      return true
    })

    // 宿主的命令系统：主人发 /公式 x^2 也行（/ 开头归宿主，这里只管画）
    api.command({
      name: '公式',
      aliases: ['公式渲染', '渲染'],
      desc: '把 LaTeX 公式渲染成图片',
      run: async (arg, msg) => {
        const settings = settingsNow()
        const latex = String(arg || '').trim().replace(/^\$+|\$+$/g, '')
        if (!latex) return '用法：/公式 \\frac{1}{2}'
        const { items, error } = validateAll([{ latex, display: true }], settings)
        if (!items.length) return `画不出来：${error || '没认出公式'}`
        const chatId = msg?.chatId || msg?.chat?.chatId
        if (!chatId) return '找不到聊天，画不了'
        const painted = await paint(items, settings, chatId, { quoteId: msg?.kind === 'group' ? msg.messageId : undefined })
        return painted.ok ? '' : `没画出来：${painted.error}`
      },
    })

    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      if (!settingsNow().tool) return []
      return api.defineTool({
        name: 'latex_render',
        description: '把一段 LaTeX 公式渲染成图片发到当前聊天。别人贴了公式、想看清排版的时候用。',
        properties: { latex: { type: 'string', description: 'LaTeX 源码，不用带 $ 或 $$ 符号' } },
        required: ['latex'],
        execute: async ({ latex }) => {
          const settings = settingsNow()
          const text = unicodeToLatex(stripTrigger(String(latex ?? ''), settings.triggerWords)).replace(/^\$+|\$+$/g, '').trim()
          if (!text) return { ok: false, message: '公式是空的' }
          if (text.length > settings.maxChars) return { ok: false, message: `公式超过 ${settings.maxChars} 个字了` }
          const bad = validateLatex(text)
          if (bad) return { ok: false, message: bad }
          const painted = await paint([{ latex: text, display: true }], settings, chat.chatId)
          if (!painted.ok) return { ok: false, message: painted.error }
          if (!painted.sent) return { ok: false, message: '图片没发出去（可能总开关关着、或者在试运行）' }
          return { ok: true, message: '公式已经画成图片发到聊天里了' }
        },
      })
    })

    api.rule(() => '别人贴了 LaTeX 公式、想看清排版的时候，可以用 latex_render 把公式渲染成图片再发出去；也可以让他们发「\\公式渲染 <公式>」，这个不用经过你。')
  },
}
