// 公式 → PNG：MathJax 排成 SVG，再自己光栅化、自己编码 PNG。全程在本机，不联网、不落盘。
import { encodePng } from './png.mjs'
import { rasterizeSvg } from './raster.mjs'
import { texToSvg, warmUp } from './tex-svg.mjs'

export { warmUp }

export const DEFAULT_FONT_SIZE = 40
export const DEFAULT_PADDING = 8
export const DEFAULT_MAX_WIDTH = 600
export const THEMES = ['white', 'dark', 'transparent']

const int = (v, min, max, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 主题 → 底色和字色。foreground 填了就以它为准（可以只换字色、不换底色）。
 * 老版本存的是 background（white/transparent），所以 background 也认。
 */
export function styleOf(options = {}) {
  let theme = String(options.theme ?? '').toLowerCase()
  if (!theme) theme = String(options.background ?? '').toLowerCase()
  if (theme === 'transparent') return { theme, background: 'transparent', foreground: options.foreground || '#000000' }
  if (theme === 'dark') return { theme, background: '#1e1e1e', foreground: options.foreground || '#f2f2f2' }
  return { theme: 'white', background: 'white', foreground: options.foreground || '#000000' }
}

/** 背景色洗成 [r,g,b,a]，给拼图垫底用。 */
export function backgroundColor(background) {
  if (background === 'transparent') return [0, 0, 0, 0]
  const hex = String(background || '').trim()
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
  }
  if (/^#?[0-9a-f]{3}$/i.test(hex)) {
    const h = hex.replace('#', '')
    return [h[0] + h[0], h[1] + h[1], h[2] + h[2]].map((x) => parseInt(x, 16)).concat(255)
  }
  return [255, 255, 255, 255]
}

/**
 * 画一张公式图，拿到像素（还没编码）。返回 { ok: true, image } 或 { ok: false, error }。
 * options：display（是否独占一行）、fontSize（1em 多少像素）、theme、foreground、padding。
 */
export function renderLatex(latex, options = {}) {
  const style = styleOf(options)
  const drawn = texToSvg(latex, { display: options.display !== false })
  if (drawn.error) return { ok: false, error: drawn.error }
  try {
    const image = rasterizeSvg(drawn.svg, {
      pxPerEm: int(options.fontSize, 12, 200, DEFAULT_FONT_SIZE),
      color: style.foreground,
      background: style.background,
      padding: int(options.padding, 0, 80, DEFAULT_PADDING),
      maxWidth: int(options.maxWidth, 0, 4000, DEFAULT_MAX_WIDTH),
    })
    return { ok: true, image, background: style.background }
  } catch (error) {
    return { ok: false, error: `画图失败：${error?.message || '未知原因'}` }
  }
}

/** 画一张公式图，直接给 PNG。返回 { ok: true, png, width, height } 或 { ok: false, error }。 */
export function renderLatexPng(latex, options = {}) {
  const r = renderLatex(latex, options)
  if (!r.ok) return r
  const { image } = r
  return { ok: true, png: encodePng(image.width, image.height, image.rgba), width: image.width, height: image.height }
}
