// 小票打印：模板 + 提示词 → 模型生成 → ESC/POS → 热敏打印机。
// 本文件只做接线，排版/传输/存储都在 lib/。
import { openStore } from './lib/store.mjs'
import { normalizePrinter, sendBytes, TRANSPORT_LABELS } from './lib/transport.mjs'
import { buildReceiptBytes } from './lib/escpos.mjs'
import { buildLines, buildPrompt, cleanModelText, previewText, formatDate } from './lib/templates.mjs'
import { resolvePaper, parseHexPayload } from './lib/paper.mjs'
import { tick } from './lib/scheduler.mjs'

const DEFAULTS = {
  enabled: true,
  defaultPrinter: '',
  printers: [],
  paperWidthMm: 58,
  effectiveWidthMm: 0,
  encoding: 'gbk',
  cut: 'partial',
  selfTestHex: '',
  maxChars: 1200,
  showHeader: true,
  footer: '',
  qrText: '',
  timeoutMs: 8000,
}

const SEED_TEMPLATE = {
  name: '每日简报',
  prompt: '今天是 {date} {weekday}。请写一份适合打印在小票上的今日简报：一句问候，三条值得关注的事，一句提醒。只输出正文，不要标题，不要 Markdown，每行不超过 {width} 个字符。',
  system: '你是简洁的中文助理。只输出要打印在小票上的纯文本正文，不要解释、不要代码块、不要 Markdown。',
  engine: 'ask',
  schedule: { enabled: false, time: '08:30', days: [] },
  footer: '{date}',
}

function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const settings = { ...DEFAULTS, ...source }
  // 兼容旧配置里的 width（32/48 个字符）；显式 paperWidthMm 优先
  const legacyPaper = source.paperWidthMm !== undefined
    ? source.paperWidthMm
    : (Number(source.width) === 48 ? 80 : 58)
  const paper = resolvePaper({
    paperWidthMm: legacyPaper,
    effectiveWidthMm: settings.effectiveWidthMm,
  })
  const effectiveRaw = Number(settings.effectiveWidthMm)
  return {
    ...settings,
    paperWidthMm: paper.paperMm,
    // 0 表示自动，跟着纸宽走；填了就固定，并限制在纸宽以内
    effectiveWidthMm: effectiveRaw > 0 ? Math.min(paper.paperMm, Math.round(effectiveRaw * 10) / 10) : 0,
    encoding: String(settings.encoding) === 'utf8' ? 'utf8' : 'gbk',
    cut: ['partial', 'full', 'none'].includes(settings.cut) ? settings.cut : 'partial',
    selfTestHex: String(settings.selfTestHex || '').trim().slice(0, 20000),
    maxChars: Math.max(100, Math.min(4000, Number(settings.maxChars) || DEFAULTS.maxChars)),
    timeoutMs: Math.max(1000, Math.min(30000, Number(settings.timeoutMs) || DEFAULTS.timeoutMs)),
    showHeader: settings.showHeader !== false,
    printers: Array.isArray(settings.printers) ? settings.printers.filter((p) => p && typeof p === 'object') : [],
  }
}

function normalizePrinters(settings) {
  return settings.printers.map((raw) => normalizePrinter(raw, {
    paperWidthMm: settings.paperWidthMm,
    effectiveWidthMm: settings.effectiveWidthMm,
    encoding: settings.encoding,
    cut: settings.cut,
    selfTestHex: settings.selfTestHex,
  }))
}

function resolvePrinter(settings, name) {
  const printers = normalizePrinters(settings)
  if (name) return printers.find((p) => p.name === name) || null
  if (settings.defaultPrinter) {
    const found = printers.find((p) => p.name === settings.defaultPrinter)
    if (found) return found
  }
  return printers[0] || null
}

// 纸宽优先级：模板指定 > 打印机指定 > 全局设置。
// 有效宽度 0 时按纸宽自动算（58→48mm，80→72mm），再换算成每行字符数。
function paperFor(settings, printer, template) {
  const paperMm = template?.widthMm || printer?.paperWidthMm || settings.paperWidthMm
  const effectiveMm = Number(printer?.effectiveWidthMm) > 0
    ? printer.effectiveWidthMm
    : (Number(settings.effectiveWidthMm) > 0 ? settings.effectiveWidthMm : 0)
  return resolvePaper({ paperWidthMm: paperMm, effectiveWidthMm: effectiveMm })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 512 * 1024) throw new Error('请求体太大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

export default {
  id: 'receipt-print',
  name: '小票打印',
  version: '0.2.0',
  api: 1,
  description: '把模板和提示词变成热敏小票：可定时生成或随时触发；纸宽按毫米设置并自适应排版，支持一键 ESC/POS 自检（指令可替换）、Windows USB 打印队列、网口 9100 和 CUPS；没接打印机时可先预览版面。',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch', hint: '关掉后定时任务不再触发，命令仍会提示已关闭' },
    { key: 'paperWidthMm', label: '纸宽（mm）', type: 'number', min: 20, max: 120, step: 1, hint: '常见 58 / 80；以打印机规格为准' },
    { key: 'effectiveWidthMm', label: '有效打印宽度（mm）', type: 'number', min: 0, max: 120, step: 1, hint: '0 = 自动（58mm→48mm，80mm→72mm）；每行字符数由它换算，填纸的可用宽度' },
    { key: 'selfTestHex', label: '自检指令（十六进制，可空）', type: 'text', placeholder: '留空 = 内置 ESC/POS 自检页', hint: '例如 1B 40 1B 61 01 ...；填了就原样发给打印机，不再发内置自检页' },
    { key: 'encoding', label: '中文编码', type: 'select', options: [{ value: 'gbk', label: 'GBK（多数国产机）' }, { value: 'utf8', label: 'UTF-8' }] },
    { key: 'cut', label: '切纸', type: 'select', options: [{ value: 'partial', label: '半切' }, { value: 'full', label: '全切' }, { value: 'none', label: '不切' }] },
    { key: 'defaultPrinter', label: '默认打印机', type: 'text', hint: '填打印机名字，需和下面「打印机」里的一致；空则用第一台' },
    { key: 'maxChars', label: '正文最大字数', type: 'number', min: 100, max: 4000, step: 100, hint: '模型输出超长会被截断' },
    { key: 'showHeader', label: '打印页眉', type: 'switch', hint: '显示模板名、日期时间和分隔线' },
    { key: 'footer', label: '全局页脚', type: 'text', placeholder: '可留空；支持 {date} 等占位符' },
    { key: 'qrText', label: '二维码内容', type: 'text', placeholder: '留空不打印；支持 {date} 等占位符' },
    { key: 'timeoutMs', label: '打印超时（毫秒）', type: 'number', min: 1000, max: 30000, step: 500 },
  ],
  panel: 'panel.js',

  setup(api) {
    const store = openStore(api.dataDir())
    const log = api.log
    const running = new Set()

    if (store.templates().length === 0) store.seed(SEED_TEMPLATE)

    const settingsNow = () => normalizeSettings(api.settings())

    async function generate(template, prompt) {
      const text = template.engine === 'think' && typeof api.think === 'function'
        ? await api.think(prompt.text, { title: `小票：${template.name}`, timeoutMs: 180000 })
        : await api.ask({ system: prompt.system, text: prompt.text, maxTokens: 900 })
      return cleanModelText(text, { maxChars: settingsNow().maxChars })
    }

    /**
     * 生成并打印一个模板。preview=true 时只返回版面文字，不碰打印机。
     * 返回 { ok, message, preview?, lines? }
     */
    async function runTemplate(template, options = {}) {
      const settings = settingsNow()
      if (!template) return { ok: false, message: '没有这个模板' }
      if (settings.enabled === false) return { ok: false, message: '小票打印已关闭，先去面板打开' }
      if (running.has(template.id)) return { ok: false, message: `「${template.name}」正在生成，别急` }

      const printer = options.printerName
        ? normalizePrinters(settings).find((p) => p.name === options.printerName) || null
        : (template.printer ? normalizePrinters(settings).find((p) => p.name === template.printer) : null) || resolvePrinter(settings, '')
      const paper = paperFor(settings, printer, template)
      const now = options.now instanceof Date ? options.now : new Date()
      const prompt = buildPrompt(template, { ...paper, width: paper.columns, now })
      if (!prompt.text) return { ok: false, message: '模板提示词是空的' }

      running.add(template.id)
      try {
        let body = ''
        try {
          body = await generate(template, prompt)
        } catch (error) {
          log.warn?.(`小票模板「${template.name}」生成失败：${error.message}`)
          return { ok: false, message: `生成失败：${error.message}` }
        }
        if (!body) return { ok: false, message: '模型没有返回内容' }

        const { lines, qr } = buildLines({
          template,
          body,
          width: paper.columns,
          paperMm: paper.paperMm,
          effectiveMm: paper.effectiveMm,
          showHeader: settings.showHeader,
          footer: template.footer || settings.footer,
          qr: template.qr || settings.qrText,
          now,
        })
        const text = previewText(lines)

        if (options.preview) return { ok: true, preview: text, lines, message: '预览' }

        if (!printer) {
          return {
            ok: false,
            preview: text,
            lines,
            message: '还没有配置打印机。下面是这次生成的版面，可以先去面板「打印机」里加一台。',
          }
        }

        const bytes = buildReceiptBytes(lines, {
          encoding: printer.encoding || settings.encoding,
          cut: printer.cut || settings.cut,
          columns: paper.columns,
          qr,
          feed: 3,
        })
        const result = await sendBytes(printer, bytes, {
          timeoutMs: settings.timeoutMs,
          dataDir: api.dataDir(),
        })

        store.addHistory({
          template: template.name,
          printer: printer.name,
          transport: printer.transport,
          ok: result.ok === true,
          error: result.error || '',
          chars: text.length,
          preview: false,
        })

        if (!result.ok) return { ok: false, message: `打印失败：${result.error || '未知错误'}`, preview: text }
        return { ok: true, message: `已发送到「${printer.name}」（${TRANSPORT_LABELS[printer.transport] || printer.transport}）` }
      } finally {
        running.delete(template.id)
      }
    }

    async function printRaw(text, { printerName } = {}) {
      const settings = settingsNow()
      if (settings.enabled === false) return { ok: false, message: '小票打印已关闭，先去面板打开' }
      const body = String(text || '').trim()
      if (!body) return { ok: false, message: '要打印什么？用法：/打印 内容' }
      const printer = resolvePrinter(settings, printerName)
      const paper = paperFor(settings, printer, null)
      const { lines, qr } = buildLines({
        template: { name: '打印' },
        body,
        width: paper.columns,
        paperMm: paper.paperMm,
        effectiveMm: paper.effectiveMm,
        showHeader: false,
        footer: settings.footer,
        qr: settings.qrText,
        now: new Date(),
      })
      const preview = previewText(lines)
      if (!printer) return { ok: false, message: '还没有配置打印机。\n\n' + preview, preview }
      const bytes = buildReceiptBytes(lines, {
        encoding: printer.encoding || settings.encoding,
        cut: printer.cut || settings.cut,
        columns: paper.columns,
        qr,
        feed: 3,
      })
      const result = await sendBytes(printer, bytes, { timeoutMs: settings.timeoutMs, dataDir: api.dataDir() })
      store.addHistory({
        template: '直接打印', printer: printer.name, transport: printer.transport,
        ok: result.ok === true, error: result.error || '', chars: preview.length, preview: false,
      })
      return result.ok
        ? { ok: true, message: `已发送到「${printer.name}」` }
        : { ok: false, message: `打印失败：${result.error || '未知错误'}`, preview }
    }

    function templateLine(template) {
      const schedule = template.schedule?.enabled
        ? ` · ${template.schedule.time}${template.schedule.days?.length ? `（周${template.schedule.days.map((d) => '日一二三四五六'[d]).join('')}）` : ' · 每天'}`
        : ''
      const printer = template.printer ? ` · ${template.printer}` : ''
      const engine = template.engine === 'think' ? ' · 人格' : ''
      return `${template.enabled === false ? '（停用）' : ''}${template.name}${schedule}${printer}${engine}`
    }

    function templateList() {
      const templates = store.templates()
      if (!templates.length) return '还没有模板。用 /小票 加 名称 | 提示词 建一个，或去面板里加。'
      return ['模板：', ...templates.map((t, i) => `${i + 1}. ${templateLine(t)}`)].join('\n')
    }

    function printerList() {
      const settings = settingsNow()
      const printers = normalizePrinters(settings)
      if (!printers.length) return '还没有打印机。去面板「打印机」里加一台，或先用「只预览」模式。'
      const list = printers.map((p, i) => {
        const mark = p.name === settings.defaultPrinter ? '（默认）' : ''
        const target = p.transport === 'preview' ? '' : ` → ${p.target || '未填目标'}`
        const paper = resolvePaper({ paperWidthMm: p.paperWidthMm, effectiveWidthMm: p.effectiveWidthMm })
        return `${i + 1}. ${p.name}${mark} · ${TRANSPORT_LABELS[p.transport] || p.transport}${target} · ${paper.paperMm}mm / ${paper.columns} 列`
      })
      return ['打印机：', ...list].join('\n')
    }

    function rulerLine(columns) {
      return '1234567890'.repeat(Math.ceil(columns / 10) + 1).slice(0, columns)
    }

    /**
     * 一键自检：默认发内置 ESC/POS 自检页（纸宽、列数、编码、中文、刻度尺、二维码、切纸）。
     * 打印机或全局设置了 selfTestHex 时，原样发送那段十六进制指令。
     */
    async function selfTest(name) {
      const settings = settingsNow()
      const printer = resolvePrinter(settings, name || settings.defaultPrinter)
      if (!printer) return { ok: false, message: printerList() }

      const paper = paperFor(settings, printer, null)
      const customHex = String(printer.selfTestHex || settings.selfTestHex || '').trim()
      let bytes
      if (customHex) {
        const parsed = parseHexPayload(customHex)
        if (!parsed.ok) return { ok: false, message: `自检指令有问题：${parsed.error}` }
        if (!parsed.bytes.length) return { ok: false, message: '自检指令是空的' }
        bytes = parsed.bytes
      } else {
        const body = [
          `打印机：${printer.name}`,
          `通道：${TRANSPORT_LABELS[printer.transport] || printer.transport}`,
          `目标：${printer.transport === 'preview' ? '不实际出纸' : (printer.target || '未填')}`,
          `纸宽：${paper.paperMm}mm / 有效 ${paper.effectiveMm}mm / 每行 ${paper.columns} 列`,
          `编码：${printer.encoding} · 切纸：${printer.cut}`,
          '',
          '中文测试：小票打印中文正常',
          'ASCII: ABC abc 0123456789',
          rulerLine(paper.columns),
          '上面这行数字如果正好铺满纸宽，说明有效宽度设置正确。',
        ].join('\n')
        const { lines, qr } = buildLines({
          template: { name: '打印机自检' },
          body,
          width: paper.columns,
          paperMm: paper.paperMm,
          effectiveMm: paper.effectiveMm,
          showHeader: true,
          footer: '{date} {time}',
          qr: 'AURABOT receipt-print',
          now: new Date(),
        })
        bytes = buildReceiptBytes(lines, {
          encoding: printer.encoding || settings.encoding,
          cut: printer.cut || settings.cut,
          columns: paper.columns,
          qr,
          feed: 4,
        })
      }

      const result = await sendBytes(printer, bytes, { timeoutMs: settings.timeoutMs, dataDir: api.dataDir() })
      store.addHistory({
        template: customHex ? '自检（自定义指令）' : '自检',
        printer: printer.name,
        transport: printer.transport,
        ok: result.ok === true,
        error: result.error || '',
        chars: customHex ? customHex.length : paper.columns,
        preview: false,
      })
      if (!result.ok) return { ok: false, message: `自检失败：${result.error || '未知错误'}` }
      return {
        ok: true,
        message: customHex
          ? `已把自定义自检指令（${bytes.length} 字节）发到「${printer.name}」`
          : `自检页已发到「${printer.name}」（${paper.paperMm}mm / ${paper.columns} 列）`,
      }
    }

    // ---------- 定时 ----------
    api.every(60 * 1000, async () => {
      const settings = settingsNow()
      if (settings.enabled === false) return
      const due = tick({
        templates: store.templates(),
        now: new Date(),
        lastRun: (id) => store.lastRun(id),
        run: async (template) => {
          store.markRun(template.id, formatDate(new Date()).date)
          const result = await runTemplate(template)
          if (!result.ok) log.warn?.(`定时小票「${template.name}」失败：${result.message}`)
        },
      })
      if (due.length) log.info?.(`定时小票触发 ${due.length} 个`)
    }, '小票打印定时')

    // ---------- 命令（主人） ----------
    api.command({
      name: '小票',
      aliases: ['打印小票', 'receipt'],
      desc: '模板小票：/小票 看列表，/小票 名称 生成打印，/小票 预览 名称 只看版面，/小票 加 名称 | 提示词',
      async run(arg) {
        const text = String(arg || '').trim()
        const settings = settingsNow()
        if (!text || text === '列表') {
          const defaultName = settings.defaultPrinter || normalizePrinters(settings)[0]?.name || '未配置'
          return [templateList(), '', `默认打印机：${defaultName}`, '用法：/小票 名称 · /小票 预览 名称 · /小票 自检'].join('\n')
        }
        if (text === '测试' || text === '自检') {
          return (await selfTest('')).message
        }
        if (text.startsWith('预览')) {
          const name = text.replace(/^预览\s*/, '').trim()
          const template = store.get(name)
          if (!template) return `没有「${name || '这个'}」模板。\n${templateList()}`
          const result = await runTemplate(template, { preview: true })
          return result.ok ? `【${template.name} 预览】\n${result.preview}` : result.message
        }
        if (/^(加|新建)\s/.test(text)) {
          const raw = text.replace(/^(加|新建)\s*/, '')
          const [name, ...rest] = raw.split('|')
          const prompt = rest.join('|').trim()
          if (!name.trim() || !prompt) return '用法：/小票 加 名称 | 提示词'
          const template = store.saveTemplate({ name: name.trim(), prompt })
          return `已建模板「${template.name}」。定时和打印机可以在面板里配，或用 /小票 名称 立即生成。`
        }
        if (/^(删|删除)\s/.test(text)) {
          const name = text.replace(/^(删|删除)\s*/, '').trim()
          const gone = store.deleteTemplate(name)
          return gone ? `已删除「${gone.name}」` : `没有「${name}」这个模板`
        }
        const template = store.get(text)
        if (!template) {
          return `没有「${text}」这个模板。\n${templateList()}\n\n如果只是想打印一段文字，用 /打印 内容`
        }
        const result = await runTemplate(template)
        return result.ok ? result.message : `${result.message}${result.preview ? `\n\n${result.preview}` : ''}`
      },
    })

    api.command({
      name: '打印',
      aliases: ['print'],
      desc: '直接打印一段文字到默认打印机：/打印 内容',
      async run(arg) {
        const result = await printRaw(arg)
        return result.message
      },
    })

    api.command({
      name: '打印机',
      desc: '看小票打印机和默认机器；/打印机 自检 [名字] 打自检页',
      async run(arg) {
        const text = String(arg || '').trim()
        const name = text.replace(/^(测试|自检)\s*/, '').trim()
        if (/^(测试|自检)/.test(text)) return (await selfTest(name)).message
        const settings = settingsNow()
        const paper = resolvePaper({ paperWidthMm: settings.paperWidthMm, effectiveWidthMm: settings.effectiveWidthMm })
        const selfTestLabel = settings.selfTestHex ? '自定义指令' : '内置 ESC/POS 自检页'
        return [
          printerList(),
          '',
          `纸宽：${paper.paperMm}mm · 有效：${paper.effectiveMm}mm · 每行 ${paper.columns} 列`,
          `编码：${settings.encoding} · 切纸：${settings.cut} · 自检：${selfTestLabel}`,
          '去面板「小票打印」里改纸宽、增删打印机。',
        ].join('\n')
      },
    })

    api.command({
      name: '自检',
      aliases: ['selfcheck'],
      desc: '一键自检打印机：/自检 [打印机名字]',
      async run(arg) {
        return (await selfTest(String(arg || '').trim())).message
      },
    })

    // ---------- 面板接口 ----------
    api.route('/templates', () => ({
      ok: true,
      templates: store.templates(),
      printers: normalizePrinters(settingsNow()).map((p) => ({
        ...p,
        ...resolvePaper({ paperWidthMm: p.paperWidthMm, effectiveWidthMm: p.effectiveWidthMm }),
      })),
      settings: settingsNow(),
    }))

    api.route('/settings', async (req) => {
      const body = await readBody(req)
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
      api.saveSettings(patch)
      return { ok: true, settings: settingsNow() }
    })

    api.route('/save', async (req) => {
      const body = await readBody(req)
      try {
        const template = store.saveTemplate(body.template || {})
        return { ok: true, template }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    })

    api.route('/delete', async (req) => {
      const body = await readBody(req)
      const gone = store.deleteTemplate(body.id || body.name)
      return gone ? { ok: true, template: gone } : { ok: false, message: '没找到这个模板' }
    })

    api.route('/run', async (req) => {
      const body = await readBody(req)
      const template = store.get(body.id || body.name)
      if (!template) return { ok: false, message: '没找到这个模板' }
      const result = await runTemplate(template, { preview: body.preview === true, printerName: body.printer })
      return result
    })

    api.route('/test', async (req) => {
      const body = await readBody(req)
      return selfTest(String(body.name || '').trim())
    })

    api.route('/history', () => ({
      ok: true,
      history: store.history(20).map((entry) => ({
        ...entry,
        time: new Date(entry.at).toLocaleString('zh-CN', { hour12: false }),
      })),
    }))

    api.route('/preview', async (req) => {
      const body = await readBody(req)
      const settings = settingsNow()
      const printer = resolvePrinter(settings, body.printer)
      const paper = paperFor(settings, printer, null)
      const { lines, qr } = buildLines({
        template: { name: '' },
        body: String(body.text || ''),
        width: paper.columns,
        paperMm: paper.paperMm,
        effectiveMm: paper.effectiveMm,
        showHeader: false,
        footer: settings.footer,
        qr: settings.qrText,
        now: new Date(),
      })
      return {
        ok: true,
        preview: previewText(lines),
        columns: paper.columns,
        paperWidthMm: paper.paperMm,
        effectiveWidthMm: paper.effectiveMm,
        qr: qr ? '会打印二维码' : '',
      }
    })

    log.info?.(`小票打印已启动，${store.templates().length} 个模板，${normalizePrinters(settingsNow()).length} 台打印机`)

    return {
      runTemplate,
      printRaw,
      templates: () => store.templates(),
    }
  },
}
