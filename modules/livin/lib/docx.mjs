// 最小 .docx 读写器：不依赖任何第三方包。
// .docx = 一个 zip，里面是 OOXML。我们只写"存储模式"（不压缩）的 zip——Word/WPS 都认。
// 读回时也只解自己写的存储模式条目；遇到压缩条目返回空串（调用方兜底）。

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const documentXml = (paragraphs) => {
  const ps = (paragraphs.length ? paragraphs : ['']).map((p) =>
    `<w:p><w:r><w:t xml:space="preserve">${esc(String(p))}</w:t></w:r></w:p>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${ps}<w:sectPr/></w:body></w:document>`
}

// zip 存储模式打包：本地头 + 数据 + 中央目录 + EOCD
const zipStore = (entries) => {
  const enc = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nb = enc.encode(name)
    const crc = crc32(data)
    const lh = new Uint8Array(30 + nb.length)
    const dv = new DataView(lh.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true) // version needed
    dv.setUint16(6, 0x0800, true) // UTF-8 文件名标志
    dv.setUint16(8, 0, true) // method: store
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true) // time/date
    dv.setUint32(14, crc, true)
    dv.setUint32(18, data.length, true)
    dv.setUint32(22, data.length, true)
    dv.setUint16(26, nb.length, true)
    dv.setUint16(28, 0, true)
    lh.set(nb, 30)
    locals.push(lh, data)
    const ch = new Uint8Array(46 + nb.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true) // UTF-8 文件名
    cv.setUint16(10, 0, true) // method: store
    // 12-15 time/date 保持 0
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nb.length, true)
    // extraLen/commentLen/diskStart/internal-attrs/external-attrs 保持 0
    cv.setUint32(42, offset, true)
    ch.set(nb, 46)
    centrals.push(ch)
    offset += lh.length + data.length
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  return Buffer.concat([...locals, ...centrals, eocd].map((u) => Buffer.from(u)))
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`

// paragraphs: string[]，每项一个段落
export function makeDocx(paragraphs) {
  const enc = new TextEncoder()
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(documentXml(paragraphs)) },
  ])
}

// 读回正文文本（只认存储模式条目；压缩条目跳过）
export function readDocxText(buf) {
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    let text = ''
    let pos = 0
    while (pos + 30 < b.length) {
      if (b.readUInt32LE(pos) !== 0x04034b50) break
      const method = b.readUInt16LE(pos + 8)
      const size = b.readUInt32LE(pos + 18)
      const nameLen = b.readUInt16LE(pos + 26)
      const extraLen = b.readUInt16LE(pos + 28)
      const name = b.slice(pos + 30, pos + 30 + nameLen).toString('utf8')
      const dataStart = pos + 30 + nameLen + extraLen
      if (name === 'word/document.xml' && method === 0) text = b.slice(dataStart, dataStart + size).toString('utf8')
      pos = dataStart + size
    }
    if (!text) return ''
    return text
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .trim()
  } catch {
    return ''
  }
}
