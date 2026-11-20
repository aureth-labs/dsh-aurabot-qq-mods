// ESC/POS 指令拼装。只做小票需要的最小子集：
// 初始化、中文模式、对齐、加粗、倍宽倍高、换行、二维码、切纸。
import iconv from 'iconv-lite'

const ESC = 0x1b
const GS = 0x1d
const FS = 0x1c

function encoder(encoding) {
  const name = String(encoding || 'gbk').toLowerCase()
  if (name === 'utf8' || name === 'utf-8') return (text) => Buffer.from(String(text), 'utf8')
  const target = name === 'gb18030' ? 'gb18030' : 'gbk'
  return (text) => iconv.encode(String(text), target)
}

function qrCommands(data) {
  const payload = Buffer.from(String(data), 'utf8')
  const len = payload.length + 3
  return [
    Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // model 2
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06]), // module size 6
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]), // error correction M
    Buffer.from([GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30]), // store
    payload,
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]), // print
  ]
}

/**
 * 把排版好的行渲染成 ESC/POS 字节流。
 * lines: [{ text, style?: 'title' | 'normal' | 'muted' }]
 */
export function buildReceiptBytes(lines, options = {}) {
  const {
    encoding = 'gbk',
    cut = 'partial',
    feed = 3,
    qr = '',
    width = 32,
  } = options
  const encode = encoder(encoding)
  const chunks = []

  chunks.push(Buffer.from([ESC, 0x40])) // ESC @ 初始化
  if (String(encoding).toLowerCase() !== 'utf8' && String(encoding).toLowerCase() !== 'utf-8') {
    chunks.push(Buffer.from([FS, 0x26])) // FS & 进入汉字模式（多数国产机需要）
  }

  for (const line of lines || []) {
    const text = String(line?.text ?? '')
    if (line?.style === 'title') {
      chunks.push(Buffer.from([ESC, 0x61, 0x01])) // 居中
      chunks.push(Buffer.from([GS, 0x21, 0x11])) // 倍宽倍高
      chunks.push(encode(text))
      chunks.push(Buffer.from([GS, 0x21, 0x00]))
      chunks.push(Buffer.from([ESC, 0x61, 0x00]))
      chunks.push(Buffer.from('\n', 'utf8'))
    } else if (line?.style === 'sep') {
      chunks.push(encode(text || '-'.repeat(Math.max(8, Math.floor(width)))))
      chunks.push(Buffer.from('\n', 'utf8'))
    } else {
      chunks.push(encode(text))
      chunks.push(Buffer.from('\n', 'utf8'))
    }
  }

  if (qr) {
    chunks.push(Buffer.from([ESC, 0x61, 0x01]))
    for (const chunk of qrCommands(qr)) chunks.push(chunk)
    chunks.push(Buffer.from('\n', 'utf8'))
    chunks.push(Buffer.from([ESC, 0x61, 0x00]))
  }

  chunks.push(Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, Number(feed) || 0))])) // ESC d n 走纸
  if (cut === 'partial') chunks.push(Buffer.from([GS, 0x56, 0x42, 0x00])) // 半切
  else if (cut === 'full') chunks.push(Buffer.from([GS, 0x56, 0x00])) // 全切

  return Buffer.concat(chunks)
}

export { encoder as createEncoder }
