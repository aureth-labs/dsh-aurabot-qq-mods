// 视觉看图：下载笔记图片 → 交给视觉模型换一段画面描述。
//
// 结构参考 repo/src/bili/{vision,shots}.js，代码按小红书场景重写：
// 小红书是图文笔记，不用抽帧，直接下载图片（CDN 不带 Referer 可能 403），
// 交给 askModel 看图。dsh 句柄由调用方（index）传参进来，本文件不 import api，
// askModel/canSeeImages 默认经 __lib('core/llm.js') 取，但全部可注入（测试传假的，不打真模型）。

// 默认依赖：从插件内部源码取 llm 能力（测试可不依赖，注入 deps 即可）
const defaultDeps = () => {
  try {
    const { askModel, canSeeImages } = globalThis.aurabot.lib('core/llm.js')
    return { askModel, canSeeImages }
  } catch {
    return {}
  }
}

// 小红书图片下载的请求头：CDN 校验 Referer，UA 也带上常见的桌面 Chrome 口径
const REFERER = 'https://www.xiaohongshu.com/'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

/**
 * 下载一张笔记图片（JPEG/PNG/WebP 都可能，统一按 Buffer 交给上层）。
 * 失败（网络错 / 非图片响应 / 空体积）返回 null，不抛——单张图挂了不该阻断刷轮。
 * 真机实测：小红书 CDN 默认回 WebP（RIFF....WEBP），只认 JPEG/PNG 会全部失败。
 */
export async function downloadImage(url, fetchImpl = fetch, { timeoutMs = 15000, maxBytes = 8 * 1024 * 1024 } = {}) {
  try {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return null
    const res = await fetchImpl(u, {
      headers: { Referer: REFERER, 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)
    // 空图 / 超大图都不要；只认 JPEG / PNG / WebP 的魔数，防拿到的是错误页 HTML
    if (buf.length < 500 || buf.length > maxBytes) return null
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8
    const isPng = buf[0] === 0x89 && buf[1] === 0x50
    const isWebp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
    return isJpeg || isPng || isWebp ? buf : null
  } catch {
    return null
  }
}

/** 按魔数猜图片媒体类型（喂视觉模型用）。 */
export function mediaTypeOf(buf) {
  if (!buf || !buf.length) return 'image/jpeg'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'image/webp'
  return 'image/jpeg'
}

// 系统提示词口径照 bili/vision.js：只写确实可见的东西，不猜不编
const SYSTEM =
  '你在看一组小红书笔记的配图。只写画面上确实能看到的东西：场景、人物、物体、食物、' +
  '画面里的文字 / 标签 / 贴纸。不要猜笔记的主题立意，不要编造没出现的内容，不要发表感想。' +
  '用 3~6 句中文写。'

/**
 * 看图主流程：把笔记图片交给视觉模型，换一段画面描述。
 * - 模型不支持图片（canSeeImages 为 false）→ 返回 ''，跳过不抛；
 * - images 是 Buffer 数组，转 base64 喂 askModel（mediaType 统一按 image/jpeg 口径传，
 *   与 bili 的 frames 一致；PNG 传 image/jpeg 各家网关基本都兜底识别）；
 * - 出错也返回 ''，调用方把空串当「没看图」处理即可。
 */
export async function describeNote({ dsh, cfg, note, images = [], deps = {} } = {}) {
  const { askModel, canSeeImages } = { ...defaultDeps(), ...deps }
  try {
    if (typeof canSeeImages !== 'function' || typeof askModel !== 'function') return ''
    const see = await canSeeImages(dsh, cfg)
    if (!see) return '' // 当前模型看不了图，安静跳过
    const bufs = (Array.isArray(images) ? images : []).filter((b) => Buffer.isBuffer(b) && b.length)
    if (!bufs.length) return ''
    const title = String(note?.title || '').slice(0, 60)
    const text = await askModel(dsh, {
      cfg,
      system: SYSTEM,
      text: `这是小红书笔记《${title || '（无标题）'}》的配图，按笔记里的先后顺序排列。\n把它们当成「我看到了什么」如实记下来。`,
      images: bufs.map((b) => ({ data: b.toString('base64'), mediaType: mediaTypeOf(b) })),
      maxTokens: 800,
      temperature: 0.3,
    })
    return String(text || '').trim()
  } catch {
    return '' // 看图失败不阻断刷轮
  }
}

/**
 * 从笔记的图片列表里挑一张下载：优先 note.images 里的第一张，没有就用 note.cover。
 * 返回 { buf, url }，全都拿不到返回 null。
 */
export async function pickAndDownload({ note = {}, fetchImpl, deps = {} } = {}) {
  const dl = deps.downloadImage || downloadImage
  const urls = [...(Array.isArray(note.images) ? note.images : [])].filter(Boolean)
  if (note.cover && !urls.includes(note.cover)) urls.push(note.cover)
  for (const url of urls.slice(0, 3)) { // 最多试 3 张，别在一篇笔记上耗太久
    const buf = await dl(url, fetchImpl)
    if (buf) return { buf, url }
  }
  return null
}
