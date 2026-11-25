// 画面描述：本地 OCR 只认字，遇到没有字的图（照片、纯表情、梗图无字）
// 就借一个真能看图的模型说一句画面里有什么。
//
// 走 api.ask（= 宿主 llm 的 stream，带 attachments.admitPromptContent），
// 和聊天本身无关，不会污染会话，也不会占她的人设。

const SYSTEM = [
  '你在看一张从 QQ 聊天里收到的图片。',
  '只写画面上确实能看到的东西：场景、人物、物体、动作、颜色、构图、可见的文字。',
  '不要猜剧情，不要编造没出现的内容，不要发表感想，不要说教。',
  '用 2~5 句中文写。',
  '如果图几乎是空的（纯色、全黑、加载失败），就直说「画面基本是空的」。',
].join('')

/**
 * @param {object} deps { ask, log }
 * @param {{ buf: Buffer, mediaType: string, model?: {provider:string, model:string} }} o
 * @returns {Promise<string>} 描述文字；不可用时返回空串（不抛）
 */
export async function describeImage({ ask, log }, { buf, mediaType, model, maxTokens = 400 } = {}) {
  if (!buf?.length) return ''
  try {
    const text = await ask({
      ...(model && model.provider && model.model ? { model } : {}),
      system: SYSTEM,
      text: '这张图里是什么？',
      images: [{ data: buf.toString('base64'), mediaType: mediaType || 'image/jpeg' }],
      maxTokens,
      temperature: 0.2,
    })
    return String(text || '').trim()
  } catch (error) {
    log?.debug?.('画面描述失败：', error.message)
    return ''
  }
}

/** 图片的基本事实：尺寸 / 格式 / 是否动图。这些不需要模型，永远拿得到。 */
export function imageFacts(buf, mediaType = '') {
  const facts = []
  const mime = String(mediaType || sniff(buf))
  const fmt = mime.replace(/^image\//, '').toUpperCase()
  if (fmt) facts.push(fmt)
  try {
    const size = `${Math.round(buf.length / 1024)}KB`
    const dims = dimension(buf)
    facts.push(dims ? `${dims} · ${size}` : size)
  } catch {}
  if (/gif/i.test(mime) || isAnimatedGif(buf)) facts.push('动图')
  return facts
}

export function sniff(buf) {
  // GIF 的头只要 6 字节（GIF89a + 宽高共 10 字节），门槛设 12 会把小图漏掉。
  if (!buf || buf.length < 6) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 12 && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/webp'
  return ''
}

/** 读一下 JPEG / PNG / GIF / WEBP 的宽高，纯粹为了给她一句「这图多大」。 */
export function dimension(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      // PNG: IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
      return `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`
    }
    if (buf[0] === 0x47 && buf[1] === 0x49) {
      return `${buf.readUInt16LE(6)}×${buf.readUInt16LE(8)}`
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        // SOF0..SOF15（排除 DHT C4 / JPG C8 / DAC CC）
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return `${buf.readUInt16BE(i + 7)}×${buf.readUInt16BE(i + 5)}`
        }
        i += 2 + len
      }
    }
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
      const kind = buf.slice(12, 16).toString('ascii')
      if (kind === 'VP8X') return `${(buf.readUIntLE(24, 3) & 0xffffff) + 1}×${(buf.readUIntLE(27, 3) & 0xffffff) + 1}`
      if (kind === 'VP8 ') return `${buf.readUInt16LE(26) & 0x3fff}×${buf.readUInt16LE(28) & 0x3fff}`
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return `${(b & 0x3fff) + 1}×${((b >> 14) & 0x3fff) + 1}`
      }
    }
  } catch {}
  return ''
}

function isAnimatedGif(buf) {
  try {
    if (!(buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)) return false
    // 数一数 Graphic Control Extension 出现了几次，>1 就是动图
    let n = 0
    for (let i = 0; i < buf.length - 3; i++) {
      if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) {
        n++
        if (n > 1) return true
      }
    }
  } catch {}
  return false
}
