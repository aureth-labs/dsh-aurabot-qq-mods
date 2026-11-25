// QR Code Model 2, version 6-L, byte mode (134 UTF-8 bytes). Pure JS, no network/dependencies.
// ISO/IEC 18004: two (68 data + 18 Reed–Solomon) blocks, mask 0.
export function qrSvg(text) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > 134) throw new Error('二维码地址过长（最多 134 字节），请缩短对外地址')
  const bits = []
  const put = (n, width) => { for (let i = width - 1; i >= 0; i--) bits.push((n >>> i) & 1) }
  put(4, 4); put(bytes.length, 8)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, 1088 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0))
  for (let i = 0; data.length < 136; i++) data.push(i % 2 ? 0x11 : 0xec)
  const mul = (a, b) => {
    let r = 0
    for (; b; b >>>= 1) { if (b & 1) r ^= a; a <<= 1; if (a & 0x100) a ^= 0x11d }
    return r
  }
  let gen = [1], root = 1
  for (let i = 0; i < 18; i++) {
    const next = Array(gen.length + 1).fill(0)
    gen.forEach((v, j) => { next[j] ^= v; next[j + 1] ^= mul(v, root) })
    gen = next; root = mul(root, 2)
  }
  const blocks = [data.slice(0, 68), data.slice(68)]
  const ecc = blocks.map((block) => {
    const rem = Array(18).fill(0)
    for (const b of block) {
      const factor = b ^ rem.shift(); rem.push(0)
      for (let j = 0; j < 18; j++) rem[j] ^= mul(gen[j + 1], factor)
    }
    return rem
  })
  const stream = []
  for (let i = 0; i < 68; i++) for (const b of blocks) stream.push(b[i])
  for (let i = 0; i < 18; i++) for (const b of ecc) stream.push(b[i])
  const size = 41, grid = Array.from({ length: size }, () => Array(size).fill(false))
  const fixed = grid.map((r) => r.slice())
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < size && y < size) { grid[y][x] = Boolean(v); fixed[y][x] = true } }
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4)
    }
  }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(34 + dx, 34 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  const format = 0x77c4 // error correction L, mask 0, BCH + XOR 0x5412
  const f = (i) => (format >>> i) & 1
  for (let i = 0; i <= 5; i++) set(8, i, f(i))
  set(8, 7, f(6)); set(8, 8, f(7)); set(7, 8, f(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, f(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, f(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, f(i))
  set(8, size - 8, true)
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (fixed[y][x]) continue
        const value = bit < stream.length * 8 ? (stream[bit >>> 3] >>> (7 - (bit & 7))) & 1 : 0
        grid[y][x] = Boolean(value ^ ((x + y) % 2 === 0 ? 1 : 0)); bit++
      }
    }
  }
  const path = grid.flatMap((row, y) => row.flatMap((v, x) => v ? [`M${x + 4},${y + 4}h1v1h-1z`] : [])).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 49 49" shape-rendering="crispEdges"><path fill="white" d="M0 0h49v49H0z"/><path fill="black" d="${path}"/></svg>`
}
