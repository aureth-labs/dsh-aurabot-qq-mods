// 真机校准页：用可数的字符行量出「实际能打多宽」，再打一个正好等于有效宽度的方框，
// 用来确认图片不会被切边。
//
// 字符按 Font A 估算：12 点宽，203dpi 下 8 点/mm，所以 n mm ≈ floor(n*8/12) 列。
import { wrapText } from './layout.mjs'

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const dotsPerMm = 8

export function mmColumns(mm) {
  return Math.floor((Number(mm) * dotsPerMm) / 12)
}

// 每行都是「48mm###...]」的形式：毫米数贴着最前面，末尾的 ] 在同一行说明没超宽。
// 数字放前面便于直接读数，末尾的方括号用来判断这一行有没有被截断或换行。
export function calibrationCandidates(paperWidthMm) {
  const paper = clamp(Math.round(Number(paperWidthMm) || 58), 20, 120)
  const rows = []
  for (let mm = paper - 2; mm >= 30; mm -= 2) {
    const columns = mmColumns(mm)
    const label = `${mm}mm`
    const barLength = columns - label.length - 1
    if (barLength < 4) continue
    rows.push({ mm, text: `${label}${'#'.repeat(barLength)}]` })
  }
  return rows
}

// 一个空心方框，宽 = 有效宽度对应的点数，带 5mm/10mm 刻度。
export function calibrationBitmap(widthDots, mm) {
  const dots = clamp(Math.round(Number(widthDots) || 384), 32, 576)
  const height = 32
  const bytesPerRow = Math.ceil(dots / 8)
  const data = Buffer.alloc(bytesPerRow * height)
  const set = (x, y) => {
    if (x < 0 || x >= dots || y < 0 || y >= height) return
    data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7)
  }
  for (let x = 0; x < dots; x++) {
    for (let t = 0; t < 2; t++) {
      set(x, t)
      set(x, height - 1 - t)
    }
  }
  for (let y = 0; y < height; y++) {
    for (let t = 0; t < 2; t++) {
      set(t, y)
      set(dots - 1 - t, y)
    }
  }
  for (let m = 0; m <= mm; m += 5) {
    const x = Math.round(m * dotsPerMm)
    const length = m % 10 === 0 ? 8 : 4
    for (let y = 2; y < 2 + length; y++) set(x, y)
  }
  return { width: dots, height, data }
}

/**
 * 全黑测试条：整条按纸宽铺满黑点，用来看打印头真正的出墨边界，也能顺手查断针。
 * 默认 100mm，最长 120mm，避免连续加热让打印头过热。
 */
export function blackBandBitmap({ widthDots = 464, lengthMm = 100 } = {}) {
  const width = clamp(Math.round(Number(widthDots) || 464), 32, 576)
  const height = clamp(Math.round((Number(lengthMm) || 100) * dotsPerMm), 8, 120 * dotsPerMm)
  const bytesPerRow = Math.ceil(width / 8)
  const data = Buffer.alloc(bytesPerRow * height, 0xff)
  // 宽度不是 8 的倍数时，把最后一列多出的位清零，避免黑边超出纸面
  const remainder = width % 8
  if (remainder) {
    const mask = (0xff << (8 - remainder)) & 0xff
    for (let y = 0; y < height; y++) data[y * bytesPerRow + bytesPerRow - 1] &= mask
  }
  return { width, height, data }
}

/** 生成全黑测试条的说明行和位图。 */
export function buildBlackBand({ paperWidthMm = 58, lengthMm = 100, columns = 32 } = {}) {
  const paper = clamp(Math.round(Number(paperWidthMm) || 58), 20, 120)
  const length = clamp(Math.round(Number(lengthMm) || 100), 20, 120)
  const widthDots = clamp(paper * dotsPerMm, 64, 576)
  const cols = clamp(Math.floor(Number(columns) || mmColumns(paper)), 8, 96)
  const lines = [
    { text: '打印范围测试', style: 'title' },
    { text: `纸宽 ${paper}mm · 黑条 ${length}mm · ${widthDots} 点` },
    ...wrapText(`下面是一整条全黑，长度约 ${length}mm。黑色边缘就是实际打印范围；如果边缘有白缝或断线，说明打印头或纸宽设置有问题。`, cols)
      .map((line) => ({ text: line })),
    { text: '' },
  ]
  return {
    lines,
    images: [blackBandBitmap({ widthDots, lengthMm: length })],
    paper,
    lengthMm: length,
    widthDots,
    columns: cols,
  }
}

/**
 * 生成校准页的文本行和位图。
 * columns 只用于折行说明文字，量宽度靠的是候选行本身。
 */
export function buildCalibration({ paperWidthMm = 58, effectiveWidthMm = 0, columns = 32 } = {}) {
  const paper = clamp(Math.round(Number(paperWidthMm) || 58), 20, 120)
  const effective = Number(effectiveWidthMm) > 0
    ? clamp(Math.round(Number(effectiveWidthMm)), 20, paper)
    : Math.max(20, paper - 10)
  const cols = clamp(Math.floor(Number(columns) || mmColumns(effective)), 8, 96)
  const lines = []

  lines.push({ text: '打印校准页', style: 'title' })
  lines.push({ text: `纸宽 ${paper}mm · 有效 ${effective}mm · ${cols} 列` })

  for (const line of wrapText('用法：看每行开头的毫米数，末尾的 ] 还在同一行、没有换行，这一行就没超宽。找满足条件的最长一行，那个数字就是实际有效宽度。', cols)) {
    lines.push({ text: line })
  }
  lines.push({ text: '' })

  const candidates = calibrationCandidates(paper)
  for (const row of candidates) lines.push({ text: row.text })

  lines.push({ text: '' })
  for (const line of wrapText('末尾的 ] 掉到下一行、或者 ] 不见了，都说明那一行超宽。数字按 12 点字符估算。', cols)) {
    lines.push({ text: line })
  }
  lines.push({ text: '-'.repeat(cols), style: 'sep' })
  for (const line of wrapText(`下方方框宽 ${effective}mm（${effective * dotsPerMm} 点）。右边框完整没被切，说明图片宽度合适。`, cols)) {
    lines.push({ text: line })
  }

  return {
    lines,
    images: [calibrationBitmap(effective * dotsPerMm, effective)],
    paper,
    effective,
    columns: cols,
    candidates,
  }
}
