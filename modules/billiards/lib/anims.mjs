// 球面动画：把「桌宠素材包」的 idle 动画换成台球上的小球皮肤。
//
// 这里全是纯函数（目录名/文件名数组进，结果出），落盘与扫描在 index.mjs，方便单测。
// 素材一律用 file:/// 本地地址交给渲染页：台球窗不发任何请求，也不需要插件的令牌。

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_BALL_SKINS = 16 // 16 颗球（含白球），一素材一颗；再多对画面没意义
const PACK_DIR_RE = /^(.{1,40})-animation$/
const WEBM_RE = /^[\w \u4e00-\u9fa5.()（）-]{1,120}\.webm$/i
const stem = (file) => String(file).replace(/\.webm$/i, '')

/** 从 packs/ 的目录名里挑出素材包名（约定：<包名>-animation/）。 */
export function packNames(entries = []) {
  const out = []
  for (const name of entries) {
    const m = PACK_DIR_RE.exec(String(name))
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out.sort()
}

/** 选包：桌宠当前用的优先，其次 default，再其次扫到的第一个。 */
export function pickPack(names = [], preferred = '') {
  if (names.includes(preferred)) return preferred
  if (names.includes('default')) return 'default'
  return names[0] || ''
}

/** 目录里的 webm 文件名（过滤掉别的素材和怪名字）。 */
export function webmFiles(files = []) {
  return files.filter((f) => WEBM_RE.test(String(f)))
}

/**
 * 组一个包视图里该用哪些动画：桌宠配置的 idle 池优先（只认目录里真存在的），
 * 池子为空就用整个目录，保证「装了素材包就有画面」。
 */
export function pickAnims(files = [], prefer = []) {
  const byStem = new Map(files.map((f) => [stem(f), f]))
  const fromPool = (prefer || []).map((n) => byStem.get(String(n))).filter(Boolean)
  return fromPool.length ? fromPool : files.slice()
}

/** anims.json 的内容：{ pack, urls }；没素材就是空 urls（客户端回落普通球面）。 */
export function buildAnims({ pack = '', dir = '', files = [], prefer = [], limit = MAX_BALL_SKINS } = {}) {
  const picked = pickAnims(webmFiles(files), prefer).slice(0, Math.max(1, Number(limit) || MAX_BALL_SKINS))
  if (!picked.length || !dir) return { pack: '', urls: [] }
  return { pack, urls: picked.map((f) => pathToFileURL(join(dir, f)).href) }
}
