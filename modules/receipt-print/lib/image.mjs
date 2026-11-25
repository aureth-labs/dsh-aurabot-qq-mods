// 图片 → ESC/POS 光栅位图。
// 纯 JS 解码 JPEG/PNG，按纸宽缩放，再做自动色阶、亮度/对比度、伽马和锐化，
// 最后抖动成黑白点。热敏纸只有黑点，调色比缩放更影响观感。
import jpeg from 'jpeg-js'
import pngjs from 'pngjs'

const { PNG } = pngjs

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024
export const MAX_SOURCE_PIXELS = 16_000_000

export function decodeImage(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (!bytes.length) throw new Error('图片是空的')
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('图片太大（最多 8MB）')
  let png
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    png = PNG.sync.read(bytes)
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    png = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true })
  } else {
    throw new Error('只支持 JPEG / PNG 图片')
  }
  if (!png || !png.width || !png.height || !png.data) throw new Error('图片解码失败')
  if (png.width * png.height > MAX_SOURCE_PIXELS) throw new Error('图片分辨率太高')
  return { width: png.width, height: png.height, data: png.data }
}

// RGBA → 灰度；透明部分按白纸处理。
export function toGray(image) {
  const { width, height, data } = image
  const gray = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const alpha = data[p + 3] / 255
    const value = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
    gray[i] = Math.round(value * alpha + 255 * (1 - alpha))
  }
  return { width, height, gray }
}

// 缩小用面积平均，放大用双线性，避免热敏纸上出现明显锯齿。
function resample({ width, height, gray }, dw, dh) {
  const out = new Uint8Array(dw * dh)
  if (dw <= width && dh <= height) {
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor((y * height) / dh)
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / dh))
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor((x * width) / dw)
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / dw))
        let sum = 0
        let count = 0
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            sum += gray[sy * width + sx]
            count++
          }
        }
        out[y * dw + x] = Math.round(sum / Math.max(1, count))
      }
    }
    return out
  }
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / dh - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / dw - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = fx - x0
      const top = gray[y0 * width + x0] * (1 - wx) + gray[y0 * width + x1] * wx
      const bottom = gray[y1 * width + x0] * (1 - wx) + gray[y1 * width + x1] * wx
      out[y * dw + x] = Math.round(top * (1 - wy) + bottom * wy)
    }
  }
  return out
}

export function autoLevels(gray, { clip = 0.01 } = {}) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const allowance = Math.floor(gray.length * Math.max(0, Math.min(0.2, clip)))
  let low = 0
  let acc = 0
  while (low < 255 && acc + hist[low] <= allowance) {
    acc += hist[low]
    low++
  }
  let high = 255
  acc = 0
  while (high > 0 && acc + hist[high] <= allowance) {
    acc += hist[high]
    high--
  }
  // 几乎纯色或本来就满幅的图不动，避免把噪点拉爆。
  if (high - low < 16) return gray
  const scale = 255 / (high - low)
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) {
    const value = (gray[i] - low) * scale
    out[i] = value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value)
  }
  return out
}

// 亮度 ±100 → ±64 灰阶；对比度 ±100；gamma > 1 提亮暗部（热敏机墨点会胀，默认略提亮）。
export function adjustTone(gray, { brightness = 0, contrast = 0, gamma = 1 } = {}) {
  const b = Math.max(-100, Math.min(100, Number(brightness) || 0)) * 0.64
  const c = Math.max(-100, Math.min(100, Number(contrast) || 0))
  const g = Math.max(0.2, Math.min(4, Number(gamma) || 1))
  if (b === 0 && c === 0 && g === 1) return gray
  const factor = (259 * (c + 255)) / (255 * (259 - c))
  const inverse = 1 / g
  const lut = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    let value = factor * (v + b - 128) + 128
    value = Math.max(0, Math.min(255, value)) / 255
    lut[v] = Math.round(Math.pow(value, inverse) * 255)
  }
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = lut[gray[i]]
  return out
}

// 3x3 均值模糊后的反锐化，让文字截图和小图细节更清楚。
export function unsharp(gray, width, height, { amount = 0.6 } = {}) {
  const strength = Math.max(0, Math.min(2, Number(amount) || 0))
  if (!strength || width < 3 || height < 3) return gray
  const blur = new Float32Array(gray.length)
  const temp = new Float32Array(gray.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const left = gray[row + Math.max(0, x - 1)]
      const right = gray[row + Math.min(width - 1, x + 1)]
      temp[row + x] = (left + gray[row + x] + right) / 3
    }
  }
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width
    const down = Math.min(height - 1, y + 1) * width
    const row = y * width
    for (let x = 0; x < width; x++) {
      blur[row + x] = (temp[up + x] + temp[row + x] + temp[down + x]) / 3
    }
  }
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) {
    const value = gray[i] + (gray[i] - blur[i]) * strength
    out[i] = value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value)
  }
  return out
}

function packBits(gray, width, height, { dither, threshold }) {
  const bytesPerRow = Math.ceil(width / 8)
  const bits = Buffer.alloc(bytesPerRow * height)
  const work = dither ? Float32Array.from(gray) : null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const value = work ? work[index] : gray[index]
      if (value < threshold) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7)
      if (!work) continue
      const error = value - (value < threshold ? 0 : 255)
      const spread = (dx, dy, weight) => {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= width || ny >= height) return
        work[ny * width + nx] += error * weight
      }
      spread(1, 0, 7 / 16)
      spread(-1, 1, 3 / 16)
      spread(0, 1, 5 / 16)
      spread(1, 1, 1 / 16)
    }
  }
  return { width, height, data: bits }
}

/**
 * 把图片做成适合热敏纸的光栅位图。
 * maxWidthDots 一般是有效纸宽 × 8；图片会铺满纸宽，并按比例缩放高度。
 * 太高时整体缩小，保证一屏能打完。
 */
export function imageRaster(buffer, {
  maxWidthDots = 384,
  maxHeightDots = 800,
  dither = true,
  threshold = 128,
  autoLevel = true,
  brightness = 0,
  contrast = 0,
  gamma = 1,
  sharpen = true,
} = {}) {
  const decoded = decodeImage(buffer)
  const gray = toGray(decoded)
  let dw = Math.max(1, Math.round(Number(maxWidthDots) || 384))
  let dh = Math.max(1, Math.round((decoded.height * dw) / decoded.width))
  const cap = Math.round(Number(maxHeightDots) || 0)
  if (cap > 0 && dh > cap) {
    const ratio = cap / dh
    dw = Math.max(1, Math.round(dw * ratio))
    dh = cap
  }
  let pixels = resample(gray, dw, dh)
  if (autoLevel !== false) pixels = autoLevels(pixels, { clip: 0.01 })
  pixels = adjustTone(pixels, { brightness, contrast, gamma })
  if (sharpen !== false) pixels = unsharp(pixels, dw, dh, { amount: 0.6 })
  return packBits(pixels, dw, dh, { dither: dither !== false, threshold: Number(threshold) || 128 })
}
