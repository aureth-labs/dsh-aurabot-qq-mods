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

// 每行都是「###...] 48mm」的形式，整行宽度恰好等于该毫米数对应的列数。
// 末尾的 ] 和毫米标签在同一行，说明那一行没超宽；掉行或被切就说明超了。
export function calibrationCandidates(paperWidthMm) {
  const paper = clamp(Math.round(Number(paperWidthMm) || 58), 20, 120)
  const rows = []
  for (let mm = paper - 2; mm >= 30; mm -= 2) {
    const columns = mmColumns(mm)
    const label = `${mm}mm`
    const barLength = columns - label.length - 2
    if (barLength < 4) continue
    rows.push({ mm, text: `${'#'.repeat(barLength)}] ${label}` })
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

  for (const line of wrapText('用法：找末尾 ] 和毫米标签在同一行、且没有换行的最长一条，那个毫米数就是实际有效宽度。', cols)) {
    lines.push({ text: line })
  }
  lines.push({ text: '' })

  const candidates = calibrationCandidates(paper)
  for (const row of candidates) lines.push({ text: row.text })

  lines.push({ text: '' })
  for (const line of wrapText('标签掉到下一行、或 ] 不见了，都说明那一行超宽。数字行全部按 12 点字符估算。', cols)) {
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
