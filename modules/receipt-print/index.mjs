// 热敏打印：模板 + 提示词 → 模型生成 → ESC/POS → 热敏打印机。
// 本文件只做接线，排版/传输/存储都在 lib/。
import { openStore } from './lib/store.mjs'
import { normalizePrinter, sendBytes, queryStatus, TRANSPORT_LABELS } from './lib/transport.mjs'
import { renderDriverStatus } from './lib/win-status.mjs'
import { buildReceiptBytes } from './lib/escpos.mjs'
import { decodeEscpos, decodeStatusBytes, searchCommands } from './lib/escpos-decode.mjs'
import { buildLines, buildPrompt, cleanModelText, previewText, formatDate } from './lib/templates.mjs'
import { resolvePaper, parseHexPayload } from './lib/paper.mjs'
import { tick } from './lib/scheduler.mjs'
import { imageRaster } from './lib/image.mjs'
import { pickNewMoments, extractImageSources, timeOf } from './lib/moments.mjs'
import { readFile } from 'node:fs/promises'
import { buildCalibration } from './lib/calibrate.mjs'
import { TERMS_TITLE, TERMS_VERSION, termsAccepted, termsGate, termsPublic, termsText } from './lib/terms.mjs'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const VERSION = '0.10.0'
const STAGE = '测试'

const TRIGGER_LABELS = {
  command: '命令',
  panel: '面板',
  schedule: '定时',
  moment: '说说',
  selftest: '自检',
  calibrate: '校准',
  unknown: '未知',
}

function triggerText(trigger = {}) {
  const label = TRIGGER_LABELS[trigger.type] || '未知'
  return trigger.reason ? `${label}（${trigger.reason}）` : label
}

const DEFAULTS = {
  enabled: true,
  termsVersion: '',
  termsAcceptedAt: '',
  printer: null,
  paperWidthMm: 58,
  effectiveWidthMm: 0,
  encoding: 'gbk',
  cut: 'partial',
  selfTestHex: '',
  maxChars: 1200,
  showHeader: true,
  fun: true,
  reportErrors: true,
  backupDir: '',
  footer: '',
  qrText: '',
  timeoutMs: 8000,
  momentAuto: true,
  momentIncludeSelf: false,
  momentImages: true,
  momentMaxImages: 3,
  imageMaxHeightMm: 100,
  imageDither: true,
  imageAutoLevel: true,
  imageBrightness: 0,
  imageContrast: 0,
  imageGamma: 1.3,
  imageSharpen: true,
}

const SEED_TEMPLATE = {
  name: '每日简报',
  prompt: '今天是 {date} {weekday}。请写一份适合打印在小票上的今日简报：一句问候，三条值得关注的事，一句提醒。只输出正文，不要标题，不要 Markdown，每行不超过 {width} 个字符。',
  system: '你是简洁的中文助理。只输出要打印在小票上的纯文本正文，不要解释、不要代码块、不要 Markdown。',
  engine: 'ask',
  schedule: { enabled: false, time: '08:30', days: [] },
  footer: '{date}',
}

const SEED_SUMMARY = {
  name: '今日总结',
  prompt: '今天是 {date} {weekday}。请写一份适合打印在小票上的今日总结：今天发生了什么、做完了什么、还有什么没做完、明天最要紧的一件事。只输出正文，不要标题，不要 Markdown，每行不超过 {width} 个字符。',
  system: '你是简洁的中文助理。只输出要打印在小票上的纯文本正文，不要解释、不要代码块、不要 Markdown。',
  engine: 'ask',
  schedule: { enabled: true, time: '18:00', days: [] },
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
  // 单个打印机。旧配置里的 printers 数组取第一台，忽略 defaultPrinter。
  const rawPrinter = settings.printer && typeof settings.printer === 'object'
    ? settings.printer
    : (Array.isArray(settings.printers) ? settings.printers.find((p) => p && typeof p === 'object') : null)
  const printer = rawPrinter
    ? normalizePrinter(rawPrinter, {
      paperWidthMm: paper.paperMm,
      effectiveWidthMm: effectiveRaw > 0 ? effectiveRaw : 0,
      encoding: settings.encoding,
      cut: settings.cut,
      selfTestHex: settings.selfTestHex,
    })
    : null
  const cleaned = { ...settings }
  delete cleaned.printers
  delete cleaned.defaultPrinter
  delete cleaned.width
  return {
    ...cleaned,
    printer,
    termsVersion: String(settings.termsVersion || '').trim(),
    termsAcceptedAt: String(settings.termsAcceptedAt || '').trim(),
    paperWidthMm: paper.paperMm,
    // 0 表示自动，跟着纸宽走；填了就固定，并限制在纸宽以内
    effectiveWidthMm: effectiveRaw > 0 ? Math.min(paper.paperMm, Math.round(effectiveRaw * 10) / 10) : 0,
    encoding: String(settings.encoding) === 'utf8' ? 'utf8' : 'gbk',
    cut: ['partial', 'full', 'none'].includes(settings.cut) ? settings.cut : 'partial',
    selfTestHex: String(settings.selfTestHex || '').trim().slice(0, 20000),
    maxChars: Math.max(100, Math.min(4000, Number(settings.maxChars) || DEFAULTS.maxChars)),
    timeoutMs: Math.max(1000, Math.min(30000, Number(settings.timeoutMs) || DEFAULTS.timeoutMs)),
    showHeader: settings.showHeader !== false,
    fun: settings.fun !== false,
    reportErrors: settings.reportErrors !== false,
    backupDir: String(settings.backupDir || '').trim().slice(0, 500),
    momentAuto: settings.momentAuto !== false,
    momentIncludeSelf: settings.momentIncludeSelf === true,
    momentImages: settings.momentImages !== false,
    momentMaxImages: (() => {
      const n = Number(settings.momentMaxImages)
      return Number.isFinite(n) ? Math.max(0, Math.min(9, Math.round(n))) : DEFAULTS.momentMaxImages
    })(),
    imageMaxHeightMm: Math.max(20, Math.min(200, Number(settings.imageMaxHeightMm) || DEFAULTS.imageMaxHeightMm)),
    imageDither: settings.imageDither !== false,
    imageAutoLevel: settings.imageAutoLevel !== false,
    imageBrightness: Math.max(-100, Math.min(100, Math.round(Number(settings.imageBrightness) || 0))),
    imageContrast: Math.max(-100, Math.min(100, Math.round(Number(settings.imageContrast) || 0))),
    imageGamma: Math.max(0.5, Math.min(2.5, Number(settings.imageGamma) || DEFAULTS.imageGamma)),
    imageSharpen: settings.imageSharpen !== false,
  }
}

function currentPrinter(settings) {
  return settings.printer || null
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
  name: '热敏打印',
  version: VERSION,
  api: 1,
  description: '把模板和提示词变成热敏小票：首次使用需在面板或聊天确认使用协议；定时或随时触发，纸宽按毫米自适应排版，配图缩放调色后打印并自动切纸；支持真机校准页，量出实际有效宽度并检查图片切边；每次打印在本机保存正文与触发来源备份，备份目录可自定义；内置 ESC/POS 指令表和字节解码，可查打印机状态并把返回字节翻译成中文；打印失败或打印机报错会主动私聊主人。支持 Windows USB 队列、网口 9100、CUPS 和预览。',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch', hint: '关掉后定时任务不再触发，命令仍会提示已关闭' },
    { key: 'paperWidthMm', label: '纸宽（mm）', type: 'number', min: 20, max: 120, step: 1, hint: '常见 58 / 80；以打印机规格为准' },
    { key: 'effectiveWidthMm', label: '有效打印宽度（mm）', type: 'number', min: 0, max: 120, step: 1, hint: '0 = 自动（58mm→48mm，80mm→72mm）；每行字符数由它换算，填纸的可用宽度' },
    { key: 'selfTestHex', label: '自检指令（十六进制，可空）', type: 'text', placeholder: '留空 = 内置 ESC/POS 自检页', hint: '例如 1B 40 1B 61 01 ...；填了就原样发给打印机，不再发内置自检页' },
    { key: 'encoding', label: '中文编码', type: 'select', options: [{ value: 'gbk', label: 'GBK（多数国产机）' }, { value: 'utf8', label: 'UTF-8' }] },
    { key: 'cut', label: '切纸', type: 'select', options: [{ value: 'partial', label: '半切' }, { value: 'full', label: '全切' }, { value: 'none', label: '不切' }] },
    { key: 'maxChars', label: '正文最大字数', type: 'number', min: 100, max: 4000, step: 100, hint: '模型输出超长会被截断' },
    { key: 'showHeader', label: '打印页眉', type: 'switch', hint: '显示模板名、日期时间和分隔线' },
    { key: 'fun', label: '每日彩蛋', type: 'switch', hint: '模板底部加幸运数字、幸运色、关键词和小图案，同一天重打内容不变' },
    { key: 'reportErrors', label: '出错私聊主人', type: 'switch', hint: '打印失败或打印机返回错误状态时，主动私聊主人账号' },
    { key: 'backupDir', label: '备份目录', type: 'text', placeholder: '留空 = modules-data/receipt-print/backups；可粘贴绝对路径', hint: '每次打印写一个 receipt-*.txt；目录不可写时自动退回默认目录' },
    { key: 'footer', label: '全局页脚', type: 'text', placeholder: '可留空；支持 {date} 等占位符' },
    { key: 'qrText', label: '二维码内容', type: 'text', placeholder: '留空不打印；支持 {date} 等占位符' },
    { key: 'timeoutMs', label: '打印超时（毫秒）', type: 'number', min: 1000, max: 30000, step: 500 },
    { key: 'momentAuto', label: '说说自动打印', type: 'switch', hint: '她每次发空间说说后，自动排版打印成小票' },
    { key: 'momentIncludeSelf', label: '连仅自己可见的也说打印', type: 'switch', hint: '默认只打印公开发布的说说' },
    { key: 'momentImages', label: '打印说说配图', type: 'switch', hint: '图片会按有效纸宽缩放，再转成黑白位图' },
    { key: 'momentMaxImages', label: '每条说说最多打印几张图', type: 'number', min: 0, max: 9, step: 1 },
    { key: 'imageMaxHeightMm', label: '图片最大高度（mm）', type: 'number', min: 20, max: 200, step: 10, hint: '太高的图会整体缩小，避免一张图打太久' },
    { key: 'imageDither', label: '图片抖动', type: 'switch', hint: '开=照片层次更自然；关=纯黑白阈值，适合文字截图' },
    { key: 'imageAutoLevel', label: '自动调色（色阶）', type: 'switch', hint: '自动拉开明暗，避免整张灰蒙蒙或糊成黑块' },
    { key: 'imageBrightness', label: '图片亮度', type: 'number', min: -100, max: 100, step: 5, hint: '负数变暗，正数变亮' },
    { key: 'imageContrast', label: '图片对比度', type: 'number', min: -100, max: 100, step: 5, hint: '正数让黑白更分明' },
    { key: 'imageGamma', label: '图片伽马', type: 'number', min: 0.5, max: 2.5, step: 0.1, hint: '大于 1 提亮暗部，热敏打印默认 1.3' },
    { key: 'imageSharpen', label: '图片锐化', type: 'switch', hint: '让文字截图和小图边缘更清楚' },
  ],
  panel: 'panel.js',

  setup(api) {
    const store = openStore(api.dataDir())
    const log = api.log
    const running = new Set()

    if (store.templates().length === 0) store.seed(SEED_TEMPLATE)
    store.seedSummary(SEED_SUMMARY)

    const settingsNow = () => normalizeSettings(api.settings())

    // 每次打印都记一条，并按设置把正文写到备份目录（一次一个文件）。
    function recordPrint(entry) {
      try {
        const item = store.addHistory(entry, { backupDir: settingsNow().backupDir })
        if (item?.backupError) log.warn?.(`小票备份：${item.backupError}`)
        return item
      } catch (error) {
        log.warn?.(`写打印记录失败：${error.message}`)
        return null
      }
    }

    // ---------- 错误主动汇报 ----------
    const reported = new Map()
    function ownerChat() {
      const config = typeof api.config === 'function' ? (api.config() || {}) : {}
      const owner = config.ownerQQ || config.owner || ''
      return owner ? `private:${owner}` : ''
    }

    async function reportError(title, detail = '') {
      if (settingsNow().reportErrors === false) return
      const target = ownerChat()
      if (!target) {
        log.warn?.(`没有配置主人 QQ，错误未汇报：${title}`)
        return
      }
      const text = `【热敏打印】${title}${detail ? `\n${detail}` : ''}`.slice(0, 900)
      const key = text.slice(0, 200)
      const now = Date.now()
      if (now - (reported.get(key) || 0) < 10 * 60 * 1000) return
      reported.set(key, now)
      try {
        if (typeof api.sendText === 'function') await api.sendText(target, text)
        else if (typeof api.send === 'function') await api.send(target, text)
        else log.warn?.('宿主 API 不支持主动发消息，错误只写日志')
      } catch (error) {
        log.warn?.(`错误汇报发送失败：${error.message}`)
      }
    }

    async function generate(template, prompt) {
      const text = template.engine === 'think' && typeof api.think === 'function'
        ? await api.think(prompt.text, { title: `小票：${template.name}`, timeoutMs: 180000 })
        : await api.ask({ system: prompt.system, text: prompt.text, maxTokens: 900 })
      return cleanModelText(text, { maxChars: settingsNow().maxChars })
    }

    /** 失败时补一条 Windows 驱动状态，方便判断是卡纸还是根本没联机。 */
    async function failureDetail(printer, reason) {
      let detail = `打印机：${printer.name}\n原因：${reason || '未知错误'}`
      if (printer.transport === 'windows') {
        try {
          const status = await queryStatus(printer, { timeoutMs: 6000 })
          if (status?.driver) detail += `\n${renderDriverStatus(status.driver, printer.name)}`
        } catch { /* 状态读不到就只报原始错误 */ }
      }
      return detail
    }

    /**
     * 生成并打印一个模板。preview=true 时只返回版面文字，不碰打印机。
     * 返回 { ok, message, preview?, lines? }
     */
    async function runTemplate(template, options = {}) {
      const settings = settingsNow()
      const gate = termsGate(settings)
      if (gate) return { ok: false, message: gate }
      if (!template) return { ok: false, message: '没有这个模板' }
      if (settings.enabled === false) return { ok: false, message: '热敏打印已关闭，先去面板打开' }
      if (running.has(template.id)) return { ok: false, message: `「${template.name}」正在生成，别急` }

      const printer = currentPrinter(settings)
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
          fun: settings.fun,
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

        recordPrint({
          template: template.name,
          printer: printer.name,
          transport: printer.transport,
          ok: result.ok === true,
          error: result.error || '',
          chars: text.length,
          text,
          trigger: options.trigger || { type: 'unknown', reason: '' },
          preview: false,
        })

        if (!result.ok) {
          await reportError('打印失败', await failureDetail(printer, result.error))
          return { ok: false, message: `打印失败：${result.error || '未知错误'}`, preview: text }
        }
        return { ok: true, message: `已发送到「${printer.name}」（${TRANSPORT_LABELS[printer.transport] || printer.transport}）` }
      } finally {
        running.delete(template.id)
      }
    }

    async function printRaw(text) {
      const settings = settingsNow()
      const gate = termsGate(settings)
      if (gate) return { ok: false, message: gate }
      if (settings.enabled === false) return { ok: false, message: '热敏打印已关闭，先去面板打开' }
      const body = String(text || '').trim()
      if (!body) return { ok: false, message: '要打印什么？用法：/打印 内容' }
      const printer = currentPrinter(settings)
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
      recordPrint({
        template: '直接打印', printer: printer.name, transport: printer.transport,
        ok: result.ok === true, error: result.error || '', chars: preview.length, preview: false,
        text: preview,
        trigger: { type: 'command', reason: '命令 /打印' },
      })
      if (!result.ok) {
        await reportError('直接打印失败', await failureDetail(printer, result.error))
      }
      return result.ok
        ? { ok: true, message: `已发送到「${printer.name}」` }
        : { ok: false, message: `打印失败：${result.error || '未知错误'}`, preview }
    }

    // ---------- 说说自动打印 ----------
    async function loadImageBuffer(source) {
      const text = String(source || '').trim()
      if (!text) throw new Error('图片地址是空的')
      if (/^data:image\//i.test(text)) {
        const comma = text.indexOf(',')
        if (comma < 0) throw new Error('图片 data URL 不完整')
        return Buffer.from(text.slice(comma + 1), 'base64')
      }
      let buffer
      if (/^https?:\/\//i.test(text)) {
        const response = await fetch(text, {
          signal: AbortSignal.timeout(10000),
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; AurabotReceipt/1.0)' },
        })
        if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`)
        buffer = Buffer.from(await response.arrayBuffer())
      } else {
        buffer = await readFile(text.replace(/^file:\/\//i, ''))
      }
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片太大（最多 8MB）')
      return buffer
    }

    // 把说说配图按有效纸宽缩放，转成 ESC/POS 光栅位图；单张失败不影响其他图。
    async function buildMomentImages(row, paper, settings) {
      if (!settings.momentImages || !settings.momentMaxImages) return []
      const sources = extractImageSources(row).slice(0, settings.momentMaxImages)
      const images = []
      for (const source of sources) {
        try {
          const buffer = await loadImageBuffer(source)
          images.push(imageRaster(buffer, {
            maxWidthDots: paper.dots,
            maxHeightDots: Math.round(settings.imageMaxHeightMm * 8),
            dither: settings.imageDither,
            autoLevel: settings.imageAutoLevel,
            brightness: settings.imageBrightness,
            contrast: settings.imageContrast,
            gamma: settings.imageGamma,
            sharpen: settings.imageSharpen,
          }))
        } catch (error) {
          log.warn?.(`说说配图跳过：${error.message}`)
        }
      }
      return images
    }

    async function printMoment(row) {
      const settings = settingsNow()
      const printer = currentPrinter(settings)
      const paper = paperFor(settings, printer, null)
      const body = String(row?.text || '').trim()
      const images = await buildMomentImages(row, paper, settings)
      if (!body && !images.length) return
      if (!printer) {
        log.warn?.('收到新说说，但还没配置打印机，先不打印')
        return
      }
      const now = new Date(timeOf(row.at) || Date.now())
      const { lines, qr } = buildLines({
        template: { name: '说说' },
        body,
        width: paper.columns,
        paperMm: paper.paperMm,
        effectiveMm: paper.effectiveMm,
        showHeader: settings.showHeader,
        footer: settings.footer,
        qr: settings.qrText,
        now,
      })
      const bytes = buildReceiptBytes(lines, {
        encoding: printer.encoding || settings.encoding,
        cut: printer.cut || settings.cut,
        columns: paper.columns,
        qr,
        images,
        feed: 3,
      })
      const result = await sendBytes(printer, bytes, { timeoutMs: settings.timeoutMs, dataDir: api.dataDir() })
      const momentId = String(row?.id ?? row?.tid ?? '')
      recordPrint({
        template: '说说',
        printer: printer.name,
        transport: printer.transport,
        ok: result.ok === true,
        error: result.error || '',
        chars: body.length,
        images: images.length,
        text: previewText(lines),
        trigger: {
          type: 'moment',
          reason: `说说${momentId ? ` #${momentId}` : ''} 发布`,
          momentId,
        },
        preview: false,
      })
      if (!result.ok) {
        log.warn?.(`说说热敏打印失败：${result.error || '未知错误'}`)
        reportError('说说热敏打印失败', `打印机：${printer.name}\n原因：${result.error || '未知错误'}`)
      }
    }

    // diary 是内置模块；没有就说说明宿主不支持，静默跳过。
    let momentsBusy = false
    async function checkMoments() {
      if (momentsBusy) return
      momentsBusy = true
      try {
        await scanMoments()
      } finally {
        momentsBusy = false
      }
    }

    async function scanMoments() {
      const settings = settingsNow()
      if (!termsAccepted(settings)) return
      if (settings.enabled === false || !settings.momentAuto) return
      const diary = typeof api.use === 'function' ? api.use('diary') : null
      if (!diary || typeof diary.history !== 'function') return
      let list
      try {
        list = await diary.history()
      } catch (error) {
        log.warn?.(`读说说失败：${error.message}`)
        return
      }
      const { rows, watermark } = pickNewMoments(list, store.momentLast(), {
        includeSelf: settings.momentIncludeSelf,
      })
      // 第一次启动只记下当前位置，避免把以前的说说全打一遍。
      if (!store.momentSeeded()) {
        store.markMoment(watermark, { seeded: true })
        return
      }
      for (const row of rows) {
        store.markMoment(timeOf(row.at ?? row.time ?? row.createdAt))
        await printMoment(row)
      }
      store.markMoment(watermark)
    }

    function templateLine(template) {
      const schedule = template.schedule?.enabled
        ? ` · ${template.schedule.time}${template.schedule.days?.length ? `（周${template.schedule.days.map((d) => '日一二三四五六'[d]).join('')}）` : ' · 每天'}`
        : ''
      const engine = template.engine === 'think' ? ' · 人格' : ''
      return `${template.enabled === false ? '（停用）' : ''}${template.name}${schedule}${engine}`
    }

    function templateList() {
      const templates = store.templates()
      if (!templates.length) return '还没有模板。用 /小票 加 名称 | 提示词 建一个，或去面板里加。'
      return ['模板：', ...templates.map((t, i) => `${i + 1}. ${templateLine(t)}`)].join('\n')
    }

    function printerList() {
      const settings = settingsNow()
      const printer = currentPrinter(settings)
      if (!printer) return '还没有配置打印机。去面板「打印机」里填一台，或先用传输方式「只预览」。'
      const target = printer.transport === 'preview' ? '' : ` → ${printer.target || '未填目标'}`
      const paper = resolvePaper({ paperWidthMm: printer.paperWidthMm, effectiveWidthMm: printer.effectiveWidthMm })
      return `打印机：${printer.name} · ${TRANSPORT_LABELS[printer.transport] || printer.transport}${target} · ${paper.paperMm}mm / ${paper.columns} 列`
    }

    function rulerLine(columns) {
      return '1234567890'.repeat(Math.ceil(columns / 10) + 1).slice(0, columns)
    }

    /**
     * 一键自检：默认发内置 ESC/POS 自检页（纸宽、列数、编码、中文、刻度尺、二维码、切纸）。
     * 打印机或全局设置了 selfTestHex 时，原样发送那段十六进制指令。
     */
    async function selfTest(options = {}) {
      const settings = settingsNow()
      const gate = termsGate(settings)
      if (gate) return { ok: false, message: gate }
      const printer = currentPrinter(settings)
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
          '中文测试：热敏打印中文正常',
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
      recordPrint({
        template: customHex ? '自检（自定义指令）' : '自检',
        printer: printer.name,
        transport: printer.transport,
        ok: result.ok === true,
        error: result.error || '',
        chars: customHex ? customHex.length : paper.columns,
        text: customHex
          ? `自定义自检指令：\n${customHex}`
          : `内置自检页\n纸宽：${paper.paperMm}mm · 有效：${paper.effectiveMm}mm · 每行 ${paper.columns} 列\n编码：${settings.encoding} · 切纸：${settings.cut}`,
        trigger: options.trigger || { type: 'command', reason: '自检' },
        preview: false,
      })
      if (!result.ok) {
        await reportError('自检失败', await failureDetail(printer, result.error))
        return { ok: false, message: `自检失败：${result.error || '未知错误'}` }
      }
      return {
        ok: true,
        message: customHex
          ? `已把自定义自检指令（${bytes.length} 字节）发到「${printer.name}」`
          : `自检页已发到「${printer.name}」（${paper.paperMm}mm / ${paper.columns} 列）`,
      }
    }

    /**
     * 真机校准页：按毫米打印候选行量出实际有效宽度，末尾再打一个等于当前
     * 有效宽度的方框，用来看图片会不会被切边。
     */
    async function printCalibration(options = {}) {
      const settings = settingsNow()
      const gate = termsGate(settings)
      if (gate) return { ok: false, message: gate }
      if (settings.enabled === false) return { ok: false, message: '热敏打印已关闭，先去面板打开' }
      const printer = currentPrinter(settings)
      if (!printer) return { ok: false, message: printerList() }

      const paper = paperFor(settings, printer, null)
      const { lines, images } = buildCalibration({
        paperWidthMm: paper.paperMm,
        effectiveWidthMm: paper.effectiveMm,
        columns: paper.columns,
      })
      const text = previewText(lines)
      const bytes = buildReceiptBytes(lines, {
        encoding: printer.encoding || settings.encoding,
        cut: printer.cut || settings.cut,
        columns: paper.columns,
        images,
        feed: 4,
      })
      const result = await sendBytes(printer, bytes, { timeoutMs: settings.timeoutMs, dataDir: api.dataDir() })
      recordPrint({
        template: '校准页',
        printer: printer.name,
        transport: printer.transport,
        ok: result.ok === true,
        error: result.error || '',
        chars: text.length,
        text,
        trigger: options.trigger || { type: 'command', reason: '校准页' },
        preview: false,
      })
      if (!result.ok) {
        await reportError('校准页打印失败', await failureDetail(printer, result.error))
        return { ok: false, message: `校准页打印失败：${result.error || '未知错误'}` }
      }
      return {
        ok: true,
        message: `校准页已发到「${printer.name}」（${paper.paperMm}mm / 有效 ${paper.effectiveMm}mm / ${paper.columns} 列）。找出末尾 ] 和 mm 在同一行的最长一条，把那个数字填到「有效宽度」。`,
      }
    }

    // ---------- 状态查询与指令解码 ----------
    async function printerStatus() {
      const settings = settingsNow()
      const printer = currentPrinter(settings)
      if (!printer) return { ok: false, message: printerList() }
      const result = await queryStatus(printer, { timeoutMs: settings.timeoutMs })
      if (!result.supported) return { ok: false, message: result.error }
      if (!result.ok) {
        reportError('状态查询失败', `打印机：${printer.name}\n原因：${result.error || '未知错误'}`)
        return { ok: false, message: `状态查询失败：${result.error || '未知错误'}` }
      }
      if (result.driver) {
        const text = renderDriverStatus(result.driver, printer.name)
        if (result.driver.problems.length) {
          reportError('打印机状态异常', `打印机：${printer.name}\n${text}`)
        }
        return { ok: true, driver: result.driver, message: text }
      }
      const bytes = Buffer.isBuffer(result.bytes) ? result.bytes : Buffer.from(result.bytes || [])
      if (!bytes.length) {
        return {
          ok: true,
          message: `打印机「${printer.name}」没有返回状态。可能不支持 DLE EOT，或固件把回传关了。`,
        }
      }
      const decoded = decodeStatusBytes(bytes)
      if (decoded.errors.length) {
        reportError('打印机返回错误', `打印机：${printer.name}\n${decoded.text}`)
      }
      return { ok: true, status: decoded, message: decoded.text }
    }

    function replyDecode(text) {
      const parsed = parseHexPayload(text)
      if (!parsed.ok) return { ok: false, message: `十六进制有问题：${parsed.error}` }
      if (!parsed.bytes.length) return { ok: false, message: '用法：/小票 解码 1B 40 1B 61 01' }
      const decoded = decodeEscpos(parsed.bytes, { encoding: settingsNow().encoding })
      return {
        ok: true,
        decoded,
        message: `共 ${decoded.total} 字节，拆成 ${decoded.entries.length} 段：\n${decoded.lines.join('\n')}`,
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
          const schedule = template.schedule || {}
          const days = Array.isArray(schedule.days) && schedule.days.length ? `周${schedule.days.join('、')}` : '每天'
          const result = await runTemplate(template, {
            trigger: { type: 'schedule', reason: `${days} ${schedule.time || ''}`.trim() },
          })
          if (!result.ok) log.warn?.(`定时小票「${template.name}」失败：${result.message}`)
        },
      })
      if (due.length) log.info?.(`定时小票触发 ${due.length} 个`)
    }, '热敏打印定时')

    // 轮询内置 diary 模块的动态，有新说说就自动打一张（打印完照常切纸）。
    api.every(30 * 1000, async () => {
      try {
        await checkMoments()
      } catch (error) {
        log.warn?.(`说说自动打印出错：${error.message}`)
      }
    }, '说说自动打印')

    // ---------- 打印记录与备份 ----------
    function recordTime(at) {
      return new Date(at).toLocaleString('zh-CN', { hour12: false })
    }

    function showHistory(arg) {
      const key = String(arg || '').trim()
      const rows = store.history(30)
      if (!rows.length) return '还没有打印记录。'
      const index = Number(key)
      if (Number.isInteger(index) && index >= 1) {
        const entry = rows[index - 1]
        if (!entry) return `只有 ${rows.length} 条记录。用 /小票 记录 看列表。`
        return [
          `${index}. ${recordTime(entry.at)} · ${entry.template}`,
          `触发：${triggerText(entry.trigger)}`,
          entry.trigger.momentId ? `说说 ID：${entry.trigger.momentId}` : '',
          `打印机：${entry.printer || '未配置'}（${TRANSPORT_LABELS[entry.transport] || entry.transport || '预览'}）`,
          `结果：${entry.ok ? '成功' : `失败：${entry.error || '未知错误'}`}`,
          `字数：${entry.chars}${entry.images ? ` · 图片：${entry.images} 张` : ''}`,
          entry.backup ? `备份：${entry.backup}` : '备份：未写入',
          '',
          entry.text || '（这次没有记录正文）',
        ].filter(Boolean).join('\n')
      }
      const filtered = key
        ? rows.filter((e) => e.template.includes(key) || (e.trigger?.reason || '').includes(key))
        : rows.slice(0, 10)
      if (!filtered.length) return `没有匹配「${key}」的记录。`
      return [
        `最近 ${Math.min(filtered.length, 10)} 条打印记录：`,
        ...filtered.slice(0, 10).map((e, i) => `${i + 1}. ${recordTime(e.at)} · ${e.template} · ${triggerText(e.trigger)} · ${e.ok ? '成功' : '失败'}`),
        '',
        '用 /小票 记录 序号 看正文和备份文件。',
      ].join('\n')
    }

    // ---------- 命令（主人） ----------
    api.command({
      name: '小票',
      aliases: ['打印小票', 'receipt', '热敏', '热敏打印'],
      desc: '模板小票：/小票 看列表，/小票 名称 生成打印，/小票 预览 名称 只看版面，/小票 加 名称 | 提示词，/小票 状态 查打印机，/小票 解码 1B 40 解读指令',
      async run(arg) {
        const text = String(arg || '').trim()
        const settings = settingsNow()
        if (/^(协议|条款|terms)$/i.test(text)) return termsText()
        if (/^(同意|接受|agree)$/i.test(text)) {
          api.saveSettings({ termsVersion: TERMS_VERSION, termsAcceptedAt: new Date().toISOString() })
          return `已确认《${TERMS_TITLE}》v${TERMS_VERSION}，现在可以开始打印了。`
        }
        const gate = termsGate(settings)
        if (gate) return gate
        if (!text || text === '列表') {
          const printerName = settings.printer?.name || '未配置'
          return [
            templateList(),
            '',
            `打印机：${printerName}`,
            '用法：/小票 名称 · /小票 预览 名称 · /小票 自检 · /小票 校准',
            '/小票 记录 [序号] 看打印备份 · /小票 状态 查打印机返回 · /小票 解码 1B 40 解读指令 · /小票 指令 [关键词] 查指令表',
          ].join('\n')
        }
        if (text === '记录' || text.startsWith('记录 ')) {
          return showHistory(text.replace(/^记录\s*/, ''))
        }
        if (text === '测试' || text === '自检') {
          return (await selfTest()).message
        }
        if (text === '校准' || text === '校准页') {
          return (await printCalibration()).message
        }
        if (text === '状态') return (await printerStatus()).message
        if (text.startsWith('解码')) return replyDecode(text.replace(/^解码\s*/, '')).message
        if (text.startsWith('指令')) {
          const keyword = text.replace(/^指令\s*/, '').trim()
          const rows = searchCommands(keyword)
          return [`共 ${rows.length} 条 ESC/POS 指令：`, ...rows.slice(0, 60)].join('\n')
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
        const result = await runTemplate(template, {
          trigger: { type: 'command', reason: `命令 /小票 ${template.name}` },
        })
        return result.ok ? result.message : `${result.message}${result.preview ? `\n\n${result.preview}` : ''}`
      },
    })

    api.command({
      name: '打印',
      aliases: ['print'],
      desc: '直接打印一段文字：/打印 内容',
      async run(arg) {
        const gate = termsGate(settingsNow())
        if (gate) return gate
        const result = await printRaw(arg)
        return result.message
      },
    })

    api.command({
      name: '打印机',
      desc: '看热敏打印机；/打印机 自检 打自检页，/打印机 校准 打校准页，/打印机 状态 查返回',
      async run(arg) {
        const text = String(arg || '').trim()
        const gate = termsGate(settingsNow())
        if (gate) return gate
        if (/^(测试|自检)/.test(text)) return (await selfTest()).message
        if (/^校准/.test(text)) return (await printCalibration()).message
        if (/^状态/.test(text)) return (await printerStatus()).message
        const settings = settingsNow()
        const paper = resolvePaper({ paperWidthMm: settings.paperWidthMm, effectiveWidthMm: settings.effectiveWidthMm })
        const selfTestLabel = settings.selfTestHex ? '自定义指令' : '内置 ESC/POS 自检页'
        return [
          printerList(),
          '',
          `纸宽：${paper.paperMm}mm · 有效：${paper.effectiveMm}mm · 每行 ${paper.columns} 列`,
          `编码：${settings.encoding} · 切纸：${settings.cut} · 自检：${selfTestLabel}`,
          '状态回读需要网口 9100 直连；Windows 队列和 CUPS 只能发不能读。',
          '去面板「热敏打印」里改打印机和纸宽。',
        ].join('\n')
      },
    })

    api.command({
      name: '自检',
      aliases: ['selfcheck'],
      desc: '一键自检打印机',
      async run() {
        const gate = termsGate(settingsNow())
        if (gate) return gate
        return (await selfTest()).message
      },
    })

    // ---------- 面板接口 ----------
    api.route('/templates', () => {
      const settings = settingsNow()
      const printer = settings.printer
        ? {
          ...settings.printer,
          ...resolvePaper({ paperWidthMm: settings.printer.paperWidthMm, effectiveWidthMm: settings.printer.effectiveWidthMm }),
        }
        : null
      return { ok: true, templates: store.templates(), printer, settings, terms: termsPublic(settings), version: VERSION, stage: STAGE }
    })

    api.route('/accept', async () => {
      api.saveSettings({ termsVersion: TERMS_VERSION, termsAcceptedAt: new Date().toISOString() })
      return { ok: true, terms: termsPublic(settingsNow()) }
    })

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
      const result = await runTemplate(template, {
        preview: body.preview === true,
        trigger: { type: 'panel', reason: body.preview === true ? '面板预览' : '面板手动打印' },
      })
      return result
    })

    api.route('/test', async () => selfTest({ trigger: { type: 'panel', reason: '面板自检' } }))

    api.route('/calibrate', async () => printCalibration({ trigger: { type: 'panel', reason: '面板校准页' } }))

    api.route('/status', async () => {
      const result = await printerStatus()
      return {
        ...result,
        status: result.status
          ? {
            ...result.status,
            results: result.status.results.map((item) => ({ ...item })),
          }
          : null,
      }
    })

    api.route('/decode', async (req) => {
      const body = await readBody(req)
      const result = replyDecode(body.hex || body.text || '')
      return {
        ...result,
        decoded: result.decoded
          ? { ...result.decoded, entries: result.decoded.entries.map((entry) => ({ ...entry, cmd: undefined })) }
          : null,
      }
    })

    api.route('/commands', (req) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const rows = searchCommands(url.searchParams.get('q') || '')
      return { ok: true, total: rows.length, rows: rows.slice(0, 200) }
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
      const printer = currentPrinter(settings)
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

    log.info?.(`热敏打印已启动，${store.templates().length} 个模板，${settingsNow().printer ? `打印机：${settingsNow().printer.name}` : '未配置打印机'}`)

    return {
      runTemplate,
      printRaw,
      templates: () => store.templates(),
      checkMoments,
    }
  },
}
