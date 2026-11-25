// ESC/POS 字节流解码：把发出去的指令和打印机返回的状态都翻译成人话。
import iconv from 'iconv-lite'
import {
  COMMANDS,
  STATUS_BITS,
  STATUS_LABELS,
  PRINTER_STATUS_BITS,
  ASB_BITS,
} from './escpos-table.mjs'

const PREFIXES = new Map()
for (const cmd of COMMANDS) {
  const bytes = cmd.hex.split(' ').map((h) => parseInt(h, 16))
  PREFIXES.set(bytes.join(','), { cmd, bytes })
}

const BARCODE_NAMES = {
  0: 'UPC-A',
  1: 'UPC-E',
  2: 'EAN13',
  3: 'EAN8',
  4: 'CODE39',
  5: 'ITF',
  6: 'CODABAR',
  65: 'UPC-A',
  66: 'UPC-E',
  67: 'EAN13',
  68: 'EAN8',
  69: 'CODE39',
  70: 'ITF',
  71: 'CODABAR',
  72: 'CODE93',
  73: 'CODE128',
}

const BIT_IMAGE_BYTES = { 0: 1, 1: 1, 2: 1, 3: 1, 32: 3, 33: 3 }

function hexOf(buffer, from, length) {
  return [...buffer.subarray(from, from + length)]
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ')
}

function findCommand(buffer, offset) {
  for (let len = 5; len >= 1; len--) {
    if (offset + len > buffer.length) continue
    const key = [...buffer.subarray(offset, offset + len)].join(',')
    const hit = PREFIXES.get(key)
    if (hit) return hit
  }
  return null
}

function fixedParamCount(cmd) {
  let count = 0
  for (const name of cmd.params) {
    if (name === '...') break
    count++
  }
  return count
}

function readUInt16(buffer, offset) {
  return (buffer[offset] || 0) + ((buffer[offset + 1] || 0) << 8)
}

function readUInt32(buffer, offset) {
  return (
    (buffer[offset] || 0) +
    ((buffer[offset + 1] || 0) << 8) +
    ((buffer[offset + 2] || 0) << 16) +
    ((buffer[offset + 3] || 0) << 24)
  )
}

function nz(value) {
  return Number.isFinite(value) ? value : 0
}

function asciiOrNumber(value) {
  const n = nz(value)
  return n >= 0x30 && n <= 0x39 ? String.fromCharCode(n) : String(n)
}

// 计算一条指令占多少字节；返回 { length, values, extra }
function measure(buffer, offset, hit) {
  const { cmd, bytes } = hit
  const start = offset + bytes.length
  const fixedCount = fixedParamCount(cmd)
  const values = []
  for (let i = 0; i < fixedCount; i++) values.push(nz(buffer[start + i]))
  let length = bytes.length + fixedCount
  let extra = null

  if (!cmd.variable) return { length, values, extra }

  if (cmd.variable === 'raster') {
    const x = readUInt16(buffer, offset + 4)
    const y = readUInt16(buffer, offset + 6)
    length = 8 + x * y
    extra = `位图 ${x * 8} dot 宽 × ${y} 行，数据 ${x * y} 字节`
  } else if (cmd.variable === 'bitImage') {
    const mode = buffer[offset + 2] || 0
    const width = readUInt16(buffer, offset + 3)
    const per = BIT_IMAGE_BYTES[mode] || 1
    length = 5 + width * per
    extra = `点阵宽 ${width} dot，模式 ${mode}`
  } else if (cmd.variable === 'bitImage8') {
    const width = readUInt16(buffer, offset + 2)
    length = 4 + width
    extra = `点阵宽 ${width} dot`
  } else if (cmd.variable === 'bitImage24') {
    const width = readUInt16(buffer, offset + 2)
    length = 4 + width * 3
    extra = `24 点阵宽 ${width} dot`
  } else if (cmd.variable === 'fnBlock') {
    const declared = readUInt16(buffer, offset + 3)
    length = 5 + declared
    extra = `参数块 ${declared} 字节`
  } else if (cmd.variable === 'gs8l') {
    const declared = readUInt32(buffer, offset + 3)
    length = 8 + declared
    extra = `大块图形 ${declared} 字节`
  } else if (cmd.variable === 'qr') {
    const declared = readUInt16(buffer, offset + 3)
    length = 5 + declared
    const cn = buffer[offset + 5] || 0
    const fn = buffer[offset + 6] || 0
    extra = describeQr(cn, fn, buffer, offset, declared)
  } else if (cmd.variable === 'barcode') {
    const mode = buffer[offset + 2] || 0
    const label = BARCODE_NAMES[mode] || `模式 ${mode}`
    if (mode <= 6) {
      let end = offset + 3
      while (end < buffer.length && buffer[end] !== 0) end++
      length = end + 1 - offset
      extra = `${label}，数据 ${Math.max(0, end - offset - 3)} 字节`
    } else {
      const dataLength = buffer[offset + 3] || 0
      length = 4 + dataLength
      extra = `${label}，数据 ${dataLength} 字节`
    }
  } else if (cmd.variable === 'tabs') {
    let end = offset + 1
    while (end < buffer.length && buffer[end] !== 0) end++
    length = end + 1 - offset
    extra = '制表位列表'
  } else if (cmd.variable === 'userChars') {
    const y = buffer[offset + 1] || 0
    const c1 = buffer[offset + 2] || 0
    const c2 = buffer[offset + 3] || 0
    const count = Math.max(0, c2 - c1 + 1) * y
    length = 4 + count
    extra = `字符 ${c1}..${c2}，每字 ${y} 字节`
  }

  return { length: Math.max(bytes.length, length), values: values.slice(0, fixedCount), extra }
}

function describeQr(cn, fn, buffer, offset, declared) {
  if (cn !== 0x31 && cn !== 0x32) return `二维条码 cn=0x${cn.toString(16)} fn=0x${fn.toString(16)}`
  if (cn === 0x32) return '二维条码（PDF417 等）'
  switch (fn) {
    case 0x41:
      return `QR：设置模型 ${asciiOrNumber(buffer[offset + 7])}`
    case 0x43:
      return `QR：模块大小 ${buffer[offset + 7] ?? '?'}`
    case 0x45:
      return `QR：纠错级别 ${asciiOrNumber(buffer[offset + 7])}`
    case 0x50: {
      const size = Math.max(0, nz(declared) - 3)
      return `QR：存储数据 ${size} 字节`
    }
    case 0x51:
      return 'QR：打印'
    default:
      return `QR：cn=0x31 fn=0x${fn.toString(16)}（${declared} 字节）`
  }
}

function describePrintMode(value) {
  const flags = []
  if (value & 0x08) flags.push('加粗')
  if (value & 0x10) flags.push('倍高')
  if (value & 0x20) flags.push('倍宽')
  if (value & 0x80) flags.push('下划线')
  return flags.length ? flags.join(' + ') : '普通'
}

function describeValues(cmd, values) {
  if (!values.length) return ''
  if (cmd.mnemonic === 'ESC !' && values.length === 1) {
    return `0x${values[0].toString(16).toUpperCase().padStart(2, '0')}（${describePrintMode(values[0])}）`
  }
  if (cmd.mnemonic === 'GS !' && values.length === 1) {
    const width = (values[0] & 0x0f) + 1
    const height = ((values[0] >> 4) & 0x0f) + 1
    return `${width}×${height}`
  }
  return values
    .map((value, index) => {
      const name = cmd.params[index] || `p${index + 1}`
      const label = cmd.enums?.[value]
      return label ? `${name}=${value}（${label}）` : `${name}=${value}`
    })
    .join(' ')
}

function formatEntry(entry) {
  const offset = String(entry.offset).padStart(4, '0')
  const hex = entry.hex.length > 23 ? `${entry.hex.slice(0, 20)}…` : entry.hex
  const label = [entry.mnemonic, entry.cmd ? describeValues(entry.cmd, entry.values) : ''].filter(Boolean).join(' ')
  const tail = [entry.name, entry.extra].filter(Boolean).join('｜')
  return `[${offset}] ${hex.padEnd(24)} ${label.padEnd(20)} ${tail}`
}

/**
 * 解码任意 ESC/POS 字节流（发出去的指令或打印机返回的内容）。
 * @returns {{ entries: object[], lines: string[], total: number }}
 */
export function decodeEscpos(input, { encoding = 'gbk', maxEntries = 800 } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  const entries = []
  let offset = 0

  while (offset < buffer.length && entries.length < maxEntries) {
    const byte = buffer[offset]

    // 可打印文本（GBK/UTF-8 多字节都不会落在控制区）
    if (byte >= 0x20 && byte !== 0x7f) {
      let end = offset
      while (end < buffer.length && buffer[end] >= 0x20 && buffer[end] !== 0x7f) end++
      const raw = buffer.subarray(offset, end)
      const name = String(encoding).toLowerCase().includes('utf') ? 'utf8' : 'gbk'
      entries.push({
        offset,
        hex: hexOf(buffer, offset, Math.min(raw.length, 24)),
        mnemonic: 'TEXT',
        name: '文本',
        text: iconv.decode(raw, name === 'utf8' ? 'utf8' : 'gbk'),
        extra: `${raw.length} 字节`,
        length: raw.length,
      })
      offset = end
      continue
    }

    const hit = findCommand(buffer, offset)
    if (!hit) {
      entries.push({
        offset,
        hex: hexOf(buffer, offset, 1),
        mnemonic: '?',
        name: byte < 0x20 ? '未知控制指令' : '未知字节',
        length: 1,
      })
      offset += 1
      continue
    }

    const { length, values, extra } = measure(buffer, offset, hit)
    entries.push({
      offset,
      hex: hexOf(buffer, offset, Math.min(length, 16)),
      mnemonic: hit.cmd.mnemonic,
      name: hit.cmd.name,
      cmd: hit.cmd,
      values,
      extra,
      length,
    })
    offset += length
  }

  if (offset < buffer.length) {
    entries.push({
      offset,
      hex: '',
      mnemonic: '…',
      name: `还有 ${buffer.length - offset} 字节未解码（超过上限）`,
      length: buffer.length - offset,
    })
  }

  return { entries, lines: entries.map(formatEntry), total: buffer.length }
}

export function formatDecoded(input, options) {
  return decodeEscpos(input, options).lines.join('\n')
}

function bitsOf(value, table, prefix = '- ') {
  const lines = []
  const hits = []
  for (let bit = 0; bit < 8; bit++) {
    if (!(value & (1 << bit))) continue
    const label = table[bit]
    if (!label) continue
    if (label.startsWith('固定位')) continue
    lines.push(`${prefix}${label}`)
    if (/错误|缺纸|打开|将尽|卡纸|脱机|不可恢复/.test(label)) hits.push(label)
  }
  return { lines, errors: hits }
}

export function decodeStatusByte(byte, kind = 1) {
  const label = STATUS_LABELS[kind] || `状态 ${kind}`
  const { lines, errors } = bitsOf(byte, STATUS_BITS[kind] || {})
  return {
    kind,
    label,
    byte,
    hex: `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    lines,
    errors,
    text: [`${label}：0x${byte.toString(16).toUpperCase().padStart(2, '0')}`, ...(lines.length ? lines : ['- 正常'])].join('\n'),
  }
}

export function decodePrinterStatus(byte) {
  const { lines, errors } = bitsOf(byte, PRINTER_STATUS_BITS)
  return {
    byte,
    lines,
    errors,
    text: [`打印机状态：0x${byte.toString(16).toUpperCase().padStart(2, '0')}`, ...(lines.length ? lines : ['- 正常'])].join('\n'),
  }
}

export function decodeAsb(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  const lines = []
  const errors = []
  for (let i = 0; i < Math.min(4, buffer.length); i++) {
    const table = ASB_BITS[i]
    const result = bitsOf(buffer[i], table.bits)
    lines.push(`${table.label}：0x${buffer[i].toString(16).toUpperCase().padStart(2, '0')}`)
    lines.push(...result.lines)
    errors.push(...result.errors)
  }
  return {
    bytes: [...buffer],
    lines,
    errors,
    text: lines.length ? lines.join('\n') : '没有返回状态字节',
  }
}

/** 依次解读 DLE EOT 1..4 的 4 个返回字节。 */
export function decodeStatusBytes(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  const results = []
  for (let i = 0; i < buffer.length; i++) {
    results.push(decodeStatusByte(buffer[i], (i % 4) + 1))
  }
  return {
    bytes: [...buffer],
    results,
    errors: results.flatMap((item) => item.errors),
    text: results.map((item) => item.text).join('\n'),
  }
}

export function searchCommands(keyword = '') {
  const text = String(keyword || '').trim().toLowerCase()
  const rows = COMMANDS.filter((cmd) => {
    if (!text) return true
    return (
      cmd.name.toLowerCase().includes(text) ||
      cmd.mnemonic.toLowerCase().includes(text) ||
      cmd.hex.toLowerCase().includes(text) ||
      cmd.category.includes(text)
    )
  })
  return rows.map((cmd) => `${cmd.hex.padEnd(18)} ${cmd.mnemonic.padEnd(10)} ${cmd.name}`)
}
