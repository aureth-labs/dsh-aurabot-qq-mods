// 把几张公式图竖着拼成一张（「拼成一张」那种排版），背景统一垫成同一个颜色。
export function stackImages(images, { gap = 16, fill = [255, 255, 255, 255] } = {}) {
  const list = (images || []).filter((img) => img && img.width > 0 && img.height > 0)
  if (!list.length) return null
  if (list.length === 1) return list[0]

  const width = Math.max(...list.map((img) => img.width))
  const height = list.reduce((sum, img) => sum + img.height, 0) + gap * (list.length - 1)
  const rgba = new Uint8Array(width * height * 4)
  // 先整张铺底色，再按行把每张图居中贴上去
  const pixel = [fill[0] ?? 255, fill[1] ?? 255, fill[2] ?? 255, fill[3] ?? 255]
  for (let p = 0; p < width * height; p++) rgba.set(pixel, p * 4)

  let y = 0
  for (const img of list) {
    const x = Math.floor((width - img.width) / 2)
    for (let row = 0; row < img.height; row++) {
      const from = row * img.width * 4
      const to = ((y + row) * width + x) * 4
      rgba.set(img.rgba.subarray(from, from + img.width * 4), to)
    }
    y += img.height + gap
  }
  return { width, height, rgba }
}
