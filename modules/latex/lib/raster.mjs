// 把 MathJax 输出的 SVG 光栅化成 RGBA 像素。
//
// 只认 MathJax 真会用到的那一小撮东西：<g> / <use> / <path> / <rect>，
// transform 只有 translate / scale / matrix，path 命令 M L H V C Q S T Z。
// 字形轮廓和分数线都是实心填充（stroke-width 是 0），所以这里不描边 —— 描边交给 PNG 之外的场景。
//
// 没有第三方依赖：填充自己算（扫描线 + 每像素 4 行超采样），PNG 自己编。

const SUB = 4 // 每个像素行取 4 个采样行，纵向抗锯齿

// ---------------- 极简 XML ----------------

/** 把 SVG 文本变成 { tag, attrs, children } 树。够用就行：MathJax 的输出很规整。 */
export function parseXml(src) {
  const root = { tag: '#root', attrs: {}, children: [] }
  const stack = [root]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    i = lt
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<?', i) || src.startsWith('<!', i)) {
      const end = src.indexOf('>', i)
      i = end < 0 ? src.length : end + 1
      continue
    }
    const gt = tagEnd(src, i)
    const raw = src.slice(i + 1, gt)
    i = gt + 1
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const sp = body.search(/\s/)
    const tag = (sp < 0 ? body : body.slice(0, sp)).toLowerCase()
    const node = { tag, attrs: parseAttrs(sp < 0 ? '' : body.slice(sp)), children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

function tagEnd(src, from) {
  let quote = ''
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return src.length
}

function parseAttrs(text) {
  const attrs = {}
  for (const m of text.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? ''
  return attrs
}

function findTag(node, tag) {
  if (node.tag === tag) return node
  for (const child of node.children) {
    const hit = findTag(child, tag)
    if (hit) return hit
  }
  return null
}

// ---------------- 变换矩阵 ----------------

const IDENTITY = [1, 0, 0, 1, 0, 0]

/** m∘n：先 n 再 m。 */
function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function parseTransform(text) {
  let m = IDENTITY
  for (const part of String(text ?? '').matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)) {
    const args = part[2].split(/[\s,]+/).filter(Boolean).map(Number)
    const name = part[1].toLowerCase()
    if (name === 'translate') m = multiply(m, [1, 0, 0, 1, args[0] || 0, args[1] || 0])
    else if (name === 'scale') {
      const sx = Number.isFinite(args[0]) ? args[0] : 1
      const sy = Number.isFinite(args[1]) ? args[1] : sx
      m = multiply(m, [sx, 0, 0, sy, 0, 0])
    } else if (name === 'matrix' && args.length >= 6) m = multiply(m, args.slice(0, 6))
  }
  return m
}

// ---------------- path → 折线 ----------------

/**
 * 把 path 的 d 拆成若干封闭多边形（世界坐标，已经过 matrix）。
 * 返回 [[x0,y0,x1,y1,...], ...]，每个数组是一条子路径。
 */
export function pathRings(d, matrix = IDENTITY) {
  const tokens = String(d ?? '').match(/[MmLlHhVvCcQqSsTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []
  const rings = []
  let ring = null
  let i = 0
  let cmd = ''
  let cx = 0
  let cy = 0
  let startX = 0
  let startY = 0
  let ctrlX = 0 // 上一个二次/三次控制点，S/T 要用
  let ctrlY = 0
  let prev = ''

  const push = (x, y) => {
    if (!ring) {
      ring = []
      rings.push(ring)
    }
    ring.push(x, y)
  }
  const num = () => Number(tokens[i++])
  const world = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]

  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i]
      i += 1
      if (cmd === 'Z' || cmd === 'z') {
        if (ring) push(...world(startX, startY))
        ring = null
        cx = startX
        cy = startY
        prev = 'Z'
        continue
      }
    }
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    const up = cmd.toUpperCase()
    if (up === 'M') {
      cx = num() + ox
      cy = num() + oy
      startX = cx
      startY = cy
      ring = null
      push(...world(cx, cy))
      cmd = rel ? 'l' : 'L' // M 后面跟的坐标按 L 处理
      prev = 'M'
    } else if (up === 'L') {
      cx = num() + ox
      cy = num() + oy
      push(...world(cx, cy))
      prev = 'L'
    } else if (up === 'H') {
      cx = num() + (rel ? cx : 0)
      push(...world(cx, cy))
      prev = 'L'
    } else if (up === 'V') {
      cy = num() + (rel ? cy : 0)
      push(...world(cx, cy))
      prev = 'L'
    } else if (up === 'C' || up === 'S') {
      let x1
      let y1
      if (up === 'C') {
        x1 = num() + ox
        y1 = num() + oy
      } else {
        // S：第一个控制点由上一个控制点镜像得到
        const smooth = prev === 'C' || prev === 'S'
        x1 = smooth ? 2 * cx - ctrlX : cx
        y1 = smooth ? 2 * cy - ctrlY : cy
      }
      const x2 = num() + ox
      const y2 = num() + oy
      const x3 = num() + ox
      const y3 = num() + oy
      cubic(world(cx, cy), world(x1, y1), world(x2, y2), world(x3, y3), push)
      ctrlX = x2
      ctrlY = y2
      cx = x3
      cy = y3
      prev = up
    } else if (up === 'Q') {
      const x1 = num() + ox
      const y1 = num() + oy
      const x2 = num() + ox
      const y2 = num() + oy
      quad(world(cx, cy), world(x1, y1), world(x2, y2), push)
      ctrlX = x1
      ctrlY = y1
      cx = x2
      cy = y2
      prev = 'Q'
    } else if (up === 'T') {
      const smooth = prev === 'Q' || prev === 'T'
      const x1 = smooth ? 2 * cx - ctrlX : cx
      const y1 = smooth ? 2 * cy - ctrlY : cy
      const x2 = num() + ox
      const y2 = num() + oy
      quad(world(cx, cy), world(x1, y1), world(x2, y2), push)
      ctrlX = x1
      ctrlY = y1
      cx = x2
      cy = y2
      prev = 'T'
    } else {
      i += 1 // 认不出来的命令：跳一个参数，别把死循环留给自己
    }
  }
  return rings.filter((r) => r.length >= 6)
}

function quad(p0, c, p1, push) {
  const steps = stepsOf(p0, c, p1)
  for (let s = 1; s <= steps; s++) {
    const t = s / steps
    const mt = 1 - t
    push(mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0], mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1])
  }
}

function cubic(p0, c1, c2, p1, push) {
  const steps = Math.max(stepsOf(p0, c1, p1), stepsOf(p0, c2, p1))
  for (let s = 1; s <= steps; s++) {
    const t = s / steps
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const d = t * t * t
    push(a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1])
  }
}

/** 曲线拆几段：按控制多边形长度估，短的一两段就够。 */
function stepsOf(p0, c, p1) {
  const len = Math.hypot(c[0] - p0[0], c[1] - p0[1]) + Math.hypot(p1[0] - c[0], p1[1] - c[1])
  return Math.max(2, Math.min(24, Math.ceil(len / 1.6)))
}

// ---------------- 填充 ----------------

/** 把若干多边形按非零规则填进覆盖率缓冲（每像素 0~1）。 */
function fillRings(rings, width, height, acc) {
  let minY = Infinity
  let maxY = -Infinity
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i += 2) {
      if (ring[i] < minY) minY = ring[i]
      if (ring[i] > maxY) maxY = ring[i]
    }
  }
  if (!Number.isFinite(minY)) return
  const yFrom = Math.max(0, Math.floor(minY))
  const yTo = Math.min(height, Math.ceil(maxY) + 1)
  const xs = []
  const dirs = []

  for (let py = yFrom; py < yTo; py++) {
    const rowBase = py * width
    for (let s = 0; s < SUB; s++) {
      const y = py + (s + 0.5) / SUB
      xs.length = 0
      dirs.length = 0
      for (const ring of rings) {
        const n = ring.length
        for (let i = 0; i < n; i += 2) {
          const x0 = ring[i]
          const y0 = ring[i + 1]
          const j = (i + 2) % n
          const x1 = ring[j]
          const y1 = ring[j + 1]
          if (y0 === y1) continue
          if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
            xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0))
            dirs.push(y1 > y0 ? 1 : -1)
          }
        }
      }
      const count = xs.length
      if (count < 2) continue
      // 交点一般不到几十个，插入排序比排序函数省事也够快
      for (let a = 1; a < count; a++) {
        const x = xs[a]
        const d = dirs[a]
        let b = a - 1
        while (b >= 0 && xs[b] > x) {
          xs[b + 1] = xs[b]
          dirs[b + 1] = dirs[b]
          b -= 1
        }
        xs[b + 1] = x
        dirs[b + 1] = d
      }
      let winding = 0
      let spanStart = 0
      for (let k = 0; k < count; k++) {
        const before = winding
        winding += dirs[k]
        if (before === 0 && winding !== 0) spanStart = xs[k]
        else if (before !== 0 && winding === 0) addSpan(acc, rowBase, spanStart, xs[k], width)
      }
    }
  }
}

function addSpan(acc, rowBase, xa, xb, width) {
  const weight = 1 / SUB
  let x0 = xa
  let x1 = xb
  if (x1 <= 0 || x0 >= width) return
  if (x0 < 0) x0 = 0
  if (x1 > width) x1 = width
  if (x1 <= x0) return
  const i0 = Math.floor(x0)
  const i1 = Math.floor(x1)
  if (i0 === i1) {
    acc[rowBase + i0] += (x1 - x0) * weight
    return
  }
  acc[rowBase + i0] += (i0 + 1 - x0) * weight
  for (let i = i0 + 1; i < i1; i++) acc[rowBase + i] += weight
  if (i1 < width) acc[rowBase + i1] += (x1 - i1) * weight
}

// ---------------- 颜色 ----------------

const NAMED = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
}

export function parseColor(value, fallback = [0, 0, 0]) {
  const s = String(value ?? '').trim().toLowerCase()
  if (NAMED[s]) return NAMED[s]
  const hex = s.replace(/^#/, '')
  if (/^[0-9a-f]{3}$/.test(hex)) return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16))
  if (/^[0-9a-f]{6}$/.test(hex)) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return fallback
}

// ---------------- 主流程 ----------------

/**
 * 把一段 SVG 画成 RGBA 像素。
 * pxPerEm：1em 多少像素（MathJax 的 SVG 单位是 1000/em）。
 * 返回 { width, height, rgba }，调用方再拿去编码 PNG。
 */
export function rasterizeSvg(svgText, { pxPerEm = 40, maxSide = 4000, maxWidth = 0, color = '#000000', background = 'white', padding = 0 } = {}) {
  const root = parseXml(svgText)
  const svg = findTag(root, 'svg')
  if (!svg) throw new Error('这段 SVG 里没有 <svg>')

  const box = String(svg.attrs.viewbox ?? svg.attrs.viewBox ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (box.length < 4 || !box.every(Number.isFinite)) throw new Error('SVG 没有可用的 viewBox')

  // MathJax 的 viewBox 是贴着墨迹量的，四边一点都不剩；留白得自己加
  const pad = Math.max(0, Math.min(80, Math.round(Number(padding) || 0)))
  let scale = pxPerEm / 1000
  let width = Math.max(1, Math.round(box[2] * scale)) + pad * 2
  let height = Math.max(1, Math.round(box[3] * scale)) + pad * 2
  if (width > maxSide || height > maxSide) {
    // 太宽了，等比缩到上限，免得一条长公式把内存吃光
    const shrink = maxSide / Math.max(width, height)
    scale *= shrink
    width = Math.max(1, Math.min(maxSide, Math.round(box[2] * scale) + pad * 2))
    height = Math.max(1, Math.min(maxSide, Math.round(box[3] * scale) + pad * 2))
  }
  // 还有个「最宽多少」：太长的一行在手机上得左右滑，缩到看得全
  const limit = Math.max(0, Math.round(Number(maxWidth) || 0))
  if (limit > 0 && width > limit) {
    scale *= limit / width
    width = limit
    height = Math.max(1, Math.round(box[3] * scale) + pad * 2)
  }

  const shapes = []
  const defs = new Map()
  collectDefs(svg, defs)
  walk(svg, [scale, 0, 0, scale, -box[0] * scale + pad, -box[1] * scale + pad], defs, shapes)

  const acc = new Float32Array(width * height)
  for (const shape of shapes) fillRings(shape, width, height, acc)

  const rgba = new Uint8Array(width * height * 4)
  const fg = parseColor(color, [0, 0, 0])
  // 白底就把字直接混到白上（QQ 里透明 PNG 有时会糊在深色气泡上）；选透明就只写 alpha
  const bg = background === 'transparent' ? null : parseColor(background, [255, 255, 255])
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i] >= 1 ? 1 : acc[i]
    const p = i * 4
    if (bg) {
      rgba[p] = Math.round(fg[0] * a + bg[0] * (1 - a))
      rgba[p + 1] = Math.round(fg[1] * a + bg[1] * (1 - a))
      rgba[p + 2] = Math.round(fg[2] * a + bg[2] * (1 - a))
      rgba[p + 3] = 255
    } else {
      rgba[p] = fg[0]
      rgba[p + 1] = fg[1]
      rgba[p + 2] = fg[2]
      rgba[p + 3] = Math.round(a * 255)
    }
  }
  return { width, height, rgba }
}

function collectDefs(node, into) {
  if (node.tag === 'defs' || node.tag === 'svg') {
    for (const child of node.children) collectDefs(child, into)
    return
  }
  if (node.tag === 'path' && node.attrs.id && node.attrs.d) into.set(node.attrs.id, node.attrs.d)
}

function walk(node, matrix, defs, shapes) {
  if (node.attrs && node.attrs.fill === 'none') return
  const tag = node.tag
  if (tag === 'defs') return
  const local = node.attrs.transform ? multiply(matrix, parseTransform(node.attrs.transform)) : matrix

  if (tag === 'path' && node.attrs.d) {
    const rings = pathRings(node.attrs.d, local)
    if (rings.length) shapes.push(rings)
    return
  }
  if (tag === 'use') {
    const ref = node.attrs['xlink:href'] || node.attrs.href || ''
    const id = ref.startsWith('#') ? ref.slice(1) : ''
    const d = defs.get(id)
    if (d) {
      const dx = Number(node.attrs.x) || 0
      const dy = Number(node.attrs.y) || 0
      const rings = pathRings(d, multiply(local, [1, 0, 0, 1, dx, dy]))
      if (rings.length) shapes.push(rings)
    }
    return
  }
  if (tag === 'line' || tag === 'polyline') {
    // \cancel 这类手绘线：只认自己带 stroke-width 的，换算成一条有宽度的四边形填掉
    const w = Number(node.attrs['stroke-width']) || 0
    if (w > 0) {
      const pts =
        tag === 'line'
          ? [Number(node.attrs.x1) || 0, Number(node.attrs.y1) || 0, Number(node.attrs.x2) || 0, Number(node.attrs.y2) || 0]
          : String(node.attrs.points ?? '')
              .trim()
              .split(/[\s,]+/)
              .map(Number)
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const quad = thickSegment(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], w, local)
        if (quad) shapes.push([quad])
      }
    }
    return
  }
  if (tag === 'rect') {
    if (node.attrs['data-background'] === 'true') return // 错误块的背景，不画
    const x = Number(node.attrs.x) || 0
    const y = Number(node.attrs.y) || 0
    const w = Number(node.attrs.width) || 0
    const h = Number(node.attrs.height) || 0
    if (w > 0 && h > 0) {
      const pts = [
        ...applyPoint(local, x, y),
        ...applyPoint(local, x + w, y),
        ...applyPoint(local, x + w, y + h),
        ...applyPoint(local, x, y + h),
      ]
      shapes.push([pts])
    }
    return
  }
  for (const child of node.children || []) walk(child, local, defs, shapes)
}

function applyPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** 一条有宽度的线段（正方形端头），返回四个角的世界坐标。 */
function thickSegment(x1, y1, x2, y2, width, matrix) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (!len || !(width > 0)) return null
  const nx = (-dy / len) * (width / 2)
  const ny = (dx / len) * (width / 2)
  return [
    ...applyPoint(matrix, x1 + nx, y1 + ny),
    ...applyPoint(matrix, x2 + nx, y2 + ny),
    ...applyPoint(matrix, x2 - nx, y2 - ny),
    ...applyPoint(matrix, x1 - nx, y1 - ny),
  ]
}
