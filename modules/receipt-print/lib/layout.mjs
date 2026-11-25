// 小票排版：按「显示宽度」折行。热敏打印机一行按等宽字符算，
// 中文/全角/emoji 占 2 列，英文数字占 1 列。

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]

export function charWidth(ch) {
  const cp = ch.codePointAt(0)
  if (cp < 0x20 || cp === 0x7f) return 0
  for (const [start, end] of WIDE_RANGES) {
    if (cp >= start && cp <= end) return 2
  }
  return 1
}

export function displayWidth(text) {
  let width = 0
  for (const ch of String(text ?? '')) width += charWidth(ch)
  return width
}

function cleanLine(text) {
  return String(text ?? '')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

// 避头标点：不能让标点单独起一行，宁可把前一个字一起挪下去。
const NO_LINE_START = new Set('。，、；：！？）》」』】〕〉…—·,.!?;:%)]}')

// 折行：保留空行；超宽的长单词也会硬切，不会溢出纸宽。
export function wrapText(text, width) {
  const limit = Math.max(1, Math.floor(width) || 1)
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = cleanLine(raw).replace(/\s+$/, '')
    if (!line) {
      out.push('')
      continue
    }
    let current = ''
    let used = 0
    for (const ch of line) {
      const cw = charWidth(ch)
      if (cw > limit) continue
      if (used + cw > limit) {
        if (NO_LINE_START.has(ch) && current) {
          const chars = [...current]
          const last = chars.pop()
          out.push(chars.join(''))
          current = last + ch
          used = charWidth(last) + cw
          continue
        }
        out.push(current)
        current = ''
        used = 0
      }
      current += ch
      used += cw
    }
    out.push(current)
  }
  return out
}
