// 纸张尺寸：所有宽度都以毫米为单位，字符列数由「有效宽度」推算。
// 203dpi 热敏机 = 8 dots/mm，Font A 一个半角字符 12 dots 宽。
export const DOTS_PER_MM = 8
export const FONT_DOT_WIDTH = 12
export const DEFAULT_PAPER_MM = 58
export const MIN_PAPER_MM = 20
export const MAX_PAPER_MM = 120
export const MIN_COLUMNS = 8
export const MAX_COLUMNS = 96

// 常见纸宽的可用打印宽度（左右各留 5mm 边距）。
const PRINTABLE_MM = { 58: 48, 80: 72 }

export function normalizePaperMm(value, fallback = DEFAULT_PAPER_MM) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < MIN_PAPER_MM || n > MAX_PAPER_MM) return fallback
  return Math.round(n * 10) / 10
}

export function defaultEffectiveMm(paperMm) {
  const paper = normalizePaperMm(paperMm)
  const preset = PRINTABLE_MM[paper]
  if (preset) return preset
  return Math.max(10, Math.round((paper - 10) * 10) / 10)
}

// 0 或留空表示按纸宽自动算；超过纸宽按纸宽截断。
export function normalizeEffectiveMm(value, paperMm) {
  const paper = normalizePaperMm(paperMm)
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return defaultEffectiveMm(paper)
  return Math.min(paper, Math.round(n * 10) / 10)
}

export function columnsFromMm(effectiveMm) {
  const mm = Number(effectiveMm)
  if (!Number.isFinite(mm) || mm <= 0) return 32
  const columns = Math.floor((mm * DOTS_PER_MM) / FONT_DOT_WIDTH)
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, columns))
}

export function resolvePaper({ paperWidthMm, effectiveWidthMm } = {}) {
  const paperMm = normalizePaperMm(paperWidthMm)
  const effectiveMm = normalizeEffectiveMm(effectiveWidthMm, paperMm)
  return {
    paperMm,
    effectiveMm,
    dots: Math.round(effectiveMm * DOTS_PER_MM),
    columns: columnsFromMm(effectiveMm),
  }
}

// 旧配置里 width 是 32/48 个字符，换算成纸宽。
export function paperMmFromLegacyWidth(width) {
  return Number(width) === 48 ? 80 : 58
}

// 把 "1B 40 1B 61 01" / "1B40..." / "0x1B 0x40" 解析成字节。
export function parseHexPayload(text, { maxBytes = 8192 } = {}) {
  const cleaned = String(text ?? '')
    .replace(/0x/gi, '')
    .replace(/\\x/gi, '')
    .replace(/[\s,;:]/g, '')
  if (!cleaned) return { ok: true, bytes: Buffer.alloc(0) }
  if (!/^[0-9a-f]+$/i.test(cleaned)) return { ok: false, error: '只能填十六进制数字，例如 1B 40' }
  if (cleaned.length % 2 !== 0) return { ok: false, error: '十六进制位数必须是偶数' }
  if (cleaned.length / 2 > maxBytes) return { ok: false, error: `自检指令太长（最多 ${maxBytes} 字节）` }
  return { ok: true, bytes: Buffer.from(cleaned, 'hex') }
}
