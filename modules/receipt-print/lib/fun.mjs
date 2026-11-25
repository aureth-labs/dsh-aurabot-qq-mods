// 每日彩蛋：按「日期 + 模板名」做种，同一天重打结果一致，不会每次都不一样。
import { displayWidth } from './layout.mjs'

const COLORS = ['奶油白', '薄荷绿', '焦糖橙', '雾霾蓝', '樱花粉', '柠檬黄', '奶咖棕', '月光银']
const KEYWORDS = ['松弛', '专注', '早睡', '见朋友', '慢慢来', '断舍离', '喝够水', '晒太阳']
const NOTES = ['今天也辛苦啦', '记得抬头看看天', '晚饭吃点好的', '别急，慢慢来', '你已经很棒了', '早点睡，明天见']

// 纯 ASCII，GBK 一定能打；宽度都控制在 12 列以内。
const DOODLES = [
  [
    '  /\\_/\\  ',
    ' ( o.o ) ',
    '  > ^ <  ',
  ],
  [
    '    ( (    ',
    '     ) )   ',
    '  .........',
    '  |      |]',
    '   \\____/  ',
  ],
  [
    '    \\   /    ',
    '     \\ /     ',
    '  --- * ---   ',
    '     / \\     ',
    '    /   \\    ',
  ],
  [
    '  .-"""-.  ',
    ' /       \\ ',
    '|         |',
    ' \\       / ',
    '  `-...-\'  ',
  ],
  [
    '   .---.   ',
    '  /     \\  ',
    ' |       | ',
    '  \\     /  ',
    '   `---\'   ',
  ],
]

function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function funLines({ now = new Date(), name = '', width = 32 } = {}) {
  const limit = Math.max(1, Math.floor(Number(width)) || 32)
  if (limit < 16) return []
  const d = now instanceof Date ? now : new Date(now)
  const seed = hash(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}|${name}`)

  const lines = ['-'.repeat(limit)]
  lines.push(`幸运数字   ${seed % 10}`)
  lines.push(`幸运色     ${COLORS[seed % COLORS.length]}`)
  lines.push(`今日关键词 ${KEYWORDS[(seed >>> 3) % KEYWORDS.length]}`)

  const doodle = (() => {
    const raw = DOODLES[(seed >>> 7) % DOODLES.length]
    const indent = Math.min(...raw.filter((row) => row.trim()).map((row) => row.length - row.trimStart().length))
    return raw.map((row) => row.slice(indent).replace(/\s+$/, ''))
  })()
  const artWidth = Math.max(...doodle.map(displayWidth))
  if (artWidth <= limit) {
    lines.push('')
    const padding = ' '.repeat(Math.max(0, Math.floor((limit - artWidth) / 2)))
    for (const row of doodle) lines.push(padding + row)
    const note = NOTES[(seed >>> 11) % NOTES.length]
    const notePadding = ' '.repeat(Math.max(0, Math.floor((limit - displayWidth(note)) / 2)))
    lines.push(notePadding + note)
  }
  return lines
}
