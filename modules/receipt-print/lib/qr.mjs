// 二维码内容：自动优先用这条内容自己的链接（说说/网页），否则用固定文字。

/** mode: 'auto' 有链接就指向链接；'custom' 永远用自定义文字；'off' 不打二维码。 */
export function resolveQr({ mode = 'auto', custom = '', url = '' } = {}) {
  if (mode === 'off') return ''
  const link = String(url || '').trim()
  if (mode === 'auto' && link) return link
  return String(custom || '').trim()
}

// 版本 1..40 的字节模式容量（纠错等级 M）。打印机按内容自动选版本，
// 这里只用来估算需要的版本、模块数和能塞下多少字。
const BYTE_CAPACITY_M = [
  0, 14, 26, 42, 62, 84, 106, 122, 152, 180,
  213, 251, 287, 331, 362, 412, 450, 504, 560, 624,
  666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264,
  1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213,
  2331,
]

const MIN_MODULE = 2
const MAX_MODULE = 6

/** 装下 bytes 个字节最少要哪个版本（1..40），超了就按 40 算。 */
export function qrVersionForBytes(bytes) {
  const size = Math.max(0, Math.ceil(Number(bytes) || 0))
  for (let version = 1; version <= 40; version += 1) {
    if (BYTE_CAPACITY_M[version] >= size) return version
  }
  return 40
}

/** 版本对应的模块边长（含定位图案）。 */
export function qrModulesForVersion(version) {
  return 17 + 4 * Math.max(1, Math.min(40, Math.floor(Number(version) || 1)))
}

/** 给定纸宽点数，最多能塞多少字节而不让二维码超出纸宽。 */
export function qrCapacityForDots(dots, moduleSize = MIN_MODULE) {
  const limit = Math.max(21 * moduleSize, Math.floor(Number(dots) || 384))
  let capacity = BYTE_CAPACITY_M[1]
  for (let version = 1; version <= 40; version += 1) {
    if ((17 + 4 * version) * moduleSize > limit) break
    capacity = BYTE_CAPACITY_M[version]
  }
  return capacity
}

/**
 * 按内容和纸宽选模块大小：短内容仍用 6（和老版本一致），
 * 长内容自动缩小，保证二维码不出纸边。
 */
export function qrModuleSize({ bytes = 0, dots = 384 } = {}) {
  const modules = qrModulesForVersion(qrVersionForBytes(bytes))
  const fit = Math.floor((Math.floor(Number(dots) || 384)) / modules)
  return Math.max(MIN_MODULE, Math.min(MAX_MODULE, fit || MIN_MODULE))
}

/** 按字节截断，不切坏多字节字符，末尾加省略号。 */
export function clipQrText(text, maxBytes) {
  const source = String(text ?? '')
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0))
  const buffer = Buffer.from(source, 'utf8')
  if (!limit || buffer.length <= limit) return source
  const ellipsis = '…'
  const room = Math.max(0, limit - Buffer.byteLength(ellipsis, 'utf8'))
  let end = room
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8') + ellipsis
}
