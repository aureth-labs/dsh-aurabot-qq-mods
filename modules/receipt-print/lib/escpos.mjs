// ESC/POS 指令拼装。只做小票需要的最小子集：
// 初始化、中文模式、对齐、加粗、倍宽倍高、换行、图片位图、二维码、切纸。
import iconv from 'iconv-lite'
import { qrModuleSize } from './qr.mjs'

const ESC = 0x1b
const GS = 0x1d
const FS = 0x1c

function encoder(encoding) {
  const name = String(encoding || 'gbk').toLowerCase()
  if (name === 'utf8' || name === 'utf-8') return (text) => Buffer.from(String(text), 'utf8')
  const target = name === 'gb18030' ? 'gb18030' : 'gbk'
  return (text) => iconv.encode(String(text), target)
}

function qrCommands(data, dots = 384) {
  const payload = Buffer.from(String(data), 'utf8')
  const len = payload.length + 3
  // 内容多时自动缩小模块，避免二维码宽过纸面被切；内容少时仍是 6。
  const moduleSize = qrModuleSize({ bytes: payload.length, dots })
  return [
    Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // model 2
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]), // module size
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]), // error correction M
    Buffer.from([GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30]), // store
    payload,
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]), // print
  ]
}

/**
 * 打印一张光栅位图（GS v 0），居中。data 是 1bpp、每行高位在左。
 */
export function rasterCommand({ width, height, data } = {}) {
  const w = Math.max(1, Math.min(4096, Math.round(Number(width) || 0)))
  const h = Math.max(1, Math.min(4096, Math.round(Number(height) || 0)))
  const bytesPerRow = Math.ceil(w / 8)
  const source = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
  const payload = Buffer.alloc(bytesPerRow * h)
  source.copy(payload, 0, 0, Math.min(source.length, payload.length))
  return Buffer.concat([
    Buffer.from([ESC, 0x61, 0x01]), // 居中
    Buffer.from([
      GS, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      h & 0xff, (h >> 8) & 0xff,
    ]),
    payload,
    Buffer.from('\n', 'utf8'),
    Buffer.from([ESC, 0x61, 0x00]),
  ])
}

/**
 * 把排版好的行渲染成 ESC/POS 字节流。
 * lines: [{ text, style?: 'title' | 'center' | 'right' | 'bold' | 'big' | 'large' | 'sep' | 'image' | 'normal', image? }]
 * images: [{ width, height, data }] 光栅位图，按顺序放在文字之后、二维码之前。
 * 行内图片（style: 'image'）会直接插在对应文字位置，适合自检页的打印头测试图。
 */
export function buildReceiptBytes(lines, options = {}) {
  const {
    encoding = 'gbk',
    cut = 'partial',
    feed = 3,
    qr = '',
    columns,
    width = 32,
    images = [],
    endSeparator = true,
  } = options
  const cols = Math.max(8, Math.min(96, Math.floor(Number(columns ?? width)) || 32))
  const encode = encoder(encoding)
  const chunks = []

  chunks.push(Buffer.from([ESC, 0x40])) // ESC @ 初始化
  if (String(encoding).toLowerCase() !== 'utf8' && String(encoding).toLowerCase() !== 'utf-8') {
    chunks.push(Buffer.from([FS, 0x26])) // FS & 进入汉字模式（多数国产机需要）
  }

  for (const line of lines || []) {
    const text = String(line?.text ?? '')
    const style = line?.style || 'normal'
    if (style === 'sep') {
      chunks.push(encode(text || '-'.repeat(Math.max(8, cols))))
      chunks.push(Buffer.from('\n', 'utf8'))
      continue
    }
    // 行内位图：让图片按排版顺序出现在文字中间，而不是统一堆到末尾。
    if (style === 'image') {
      const image = line?.image || line?.raster
      if (image?.data && image.width && image.height) chunks.push(rasterCommand(image))
      continue
    }
    if (style === 'barcode') {
      // CODE128：GS k 73 n {B 数据，条码内容只放半角字符
      const payload = Buffer.from(`{B${text}`, 'ascii')
      chunks.push(Buffer.from([ESC, 0x61, 0x01]))
      chunks.push(Buffer.from([GS, 0x6b, 0x49, payload.length & 0xff]))
      chunks.push(payload)
      chunks.push(Buffer.from('\n', 'utf8'))
      chunks.push(Buffer.from([ESC, 0x61, 0x00]))
      continue
    }
    if (style === 'center' || style === 'title') chunks.push(Buffer.from([ESC, 0x61, 0x01])) // 居中
    else if (style === 'right') chunks.push(Buffer.from([ESC, 0x61, 0x02])) // 右对齐
    if (style === 'title' || style === 'large') chunks.push(Buffer.from([GS, 0x21, 0x11])) // 倍宽倍高
    else if (style === 'big') chunks.push(Buffer.from([GS, 0x21, 0x01])) // 倍高
    else if (style === 'wide') chunks.push(Buffer.from([GS, 0x21, 0x10])) // 倍宽
    if (style === 'bold' || style === 'title') chunks.push(Buffer.from([ESC, 0x45, 0x01])) // 加粗
    if (style === 'underline') chunks.push(Buffer.from([ESC, 0x2d, 0x01])) // 下划线
    if (style === 'invert') chunks.push(Buffer.from([GS, 0x42, 0x01])) // 反白
    chunks.push(encode(text))
    if (style === 'title' || style === 'large' || style === 'big' || style === 'wide') chunks.push(Buffer.from([GS, 0x21, 0x00]))
    if (style === 'bold' || style === 'title') chunks.push(Buffer.from([ESC, 0x45, 0x00]))
    if (style === 'underline') chunks.push(Buffer.from([ESC, 0x2d, 0x00]))
    if (style === 'invert') chunks.push(Buffer.from([GS, 0x42, 0x00]))
    if (style === 'center' || style === 'right' || style === 'title') chunks.push(Buffer.from([ESC, 0x61, 0x00]))
    chunks.push(Buffer.from('\n', 'utf8'))
  }

  for (const image of images || []) {
    if (!image || !image.data || !image.width || !image.height) continue
    chunks.push(rasterCommand(image))
  }

  if (qr) {
    chunks.push(Buffer.from([ESC, 0x61, 0x01]))
    for (const chunk of qrCommands(qr, cols * 12)) chunks.push(chunk)
    chunks.push(Buffer.from('\n', 'utf8'))
    chunks.push(Buffer.from([ESC, 0x61, 0x00]))
  }

  // 每张小票末尾留一行空行，再打一行按有效打印宽度铺满的等号，方便撕纸对齐。
  if (endSeparator !== false) {
    chunks.push(Buffer.from('\n', 'utf8'))
    chunks.push(encode('='.repeat(cols)))
    chunks.push(Buffer.from('\n', 'utf8'))
  }

  chunks.push(Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, Number(feed) || 0))])) // ESC d n 走纸
  if (cut === 'partial') chunks.push(Buffer.from([GS, 0x56, 0x42, 0x00])) // 半切
  else if (cut === 'full') chunks.push(Buffer.from([GS, 0x56, 0x00])) // 全切

  return Buffer.concat(chunks)
}

export { encoder as createEncoder }
