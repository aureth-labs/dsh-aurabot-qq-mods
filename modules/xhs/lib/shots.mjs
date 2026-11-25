// 截图库：看图/巡游时顺手把笔记配图存下来，之后她自己发、或主人让她挑一张发出来。
//
// 结构参考 repo/src/bili/{vision,shots}.js，代码按小红书场景重写：
// 库目录由调用方传入（index 传 api.dataDir('shots') 的绝对路径，本文件不写死）；
// index.json 记 { items: [{ file, noteId, title, note, at }] }；
// 文件名 12 位 hex + .jpg（md5 前 12 位，天然去重）；只留最近 maxKeep 张，超了删最旧的。
// 依赖可注入：fsImpl / hashImpl，纯函数（pickShot / validFile）不碰 fs，node:test 直测。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 默认 fs / hash 实现（测试可注入假的）
const defaultFs = () => ({ mkdirSync, readFileSync, writeFileSync, unlinkSync })
const defaultHash = () => (buf) => createHash('md5').update(buf).digest('hex').slice(0, 12)

/** 文件名规则：12 位 hex + .jpg（校验纯字符串，直测友好）。 */
export const validFile = (file) => typeof file === 'string' && /^[a-f0-9]{12}\.jpg$/.test(file)

/** index.json 的路径。 */
const indexFile = (dir) => join(dir, 'index.json')

/** 截图文件在本机的绝对路径（文件名不合法返回 ''，防目录穿越）。 */
export function shotPath(dir, file) {
  return validFile(file) ? join(dir, file) : ''
}

/**
 * 读库存：index.json 缺失 / 损坏都当空库，条目里文件名不合法的过滤掉。
 * fsImpl 可注入；读失败不抛。
 */
export function loadShots(dir, fsImpl = defaultFs()) {
  try {
    const s = JSON.parse(fsImpl.readFileSync(indexFile(dir), 'utf8'))
    return { items: s && Array.isArray(s.items) ? s.items.filter((i) => i && validFile(i.file)) : [] }
  } catch {
    return { items: [] }
  }
}

function saveShots(dir, s, fsImpl) {
  fsImpl.mkdirSync(dir, { recursive: true })
  fsImpl.writeFileSync(indexFile(dir), JSON.stringify(s, null, 2))
}

/**
 * 挑一张（纯函数）：给了条件就按标题 / 备注按字命中打分，匹配不到返回 null
 * （让她知道没有这张，可以不带条件再挑一张最近的）；不给条件就返回最近的一张。
 */
export function pickShot(items, query = '') {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return null
  const q = String(query || '').trim()
  if (!q) return list[0]
  let best = null
  let bestScore = 0
  for (const it of list) {
    const hay = [it.title || '', it.note || '']
    let s = 0
    for (const h of hay) {
      if (!h) continue
      if (h.includes(q)) s = Math.max(s, 10)
      else {
        // 按字的命中比例给个分：至少命中两个字才算
        const hit = [...q].filter((ch) => h.includes(ch)).length
        if (hit >= 2) s = Math.max(s, (hit / q.length) * 5)
      }
    }
    if (s > bestScore) { best = it; bestScore = s }
  }
  return bestScore >= 2 ? best : null
}

/**
 * 存一张图：md5 前 12 位做文件名去重（同一张图重复看不会重复存）；
 * 超过 maxKeep 删最旧的文件 + 条目。返回入库的 item，失败返回 null 不抛。
 */
export function saveShot({ dir, buf, noteId = '', title = '', note = '', maxKeep = 30, fsImpl = defaultFs(), hashImpl = defaultHash() } = {}) {
  try {
    if (!Buffer.isBuffer(buf) || !buf.length) return null
    const md5 = hashImpl(buf)
    if (!/^[a-f0-9]{12}$/.test(md5)) return null
    const s = loadShots(dir, fsImpl)
    const exist = s.items.find((i) => i.file === md5 + '.jpg')
    if (exist) {
      // 同一张图又看到了：补一下标题 / 备注就好，不重复存
      if (title && !exist.title) exist.title = String(title)
      if (note && !exist.note) exist.note = String(note)
      saveShots(dir, s, fsImpl)
      return exist
    }
    const file = md5 + '.jpg'
    fsImpl.mkdirSync(dir, { recursive: true })
    fsImpl.writeFileSync(join(dir, file), buf)
    const item = {
      file,
      noteId: String(noteId || ''),
      title: String(title || '').slice(0, 100),
      note: String(note || '').slice(0, 200),
      at: Date.now(),
      bytes: buf.length,
    }
    s.items.unshift(item) // 列表头 = 最新
    while (s.items.length > Math.max(1, Math.round(Number(maxKeep) || 30))) {
      const out = s.items.pop()
      try { fsImpl.unlinkSync(join(dir, out.file)) } catch {}
    }
    saveShots(dir, s, fsImpl)
    return item
  } catch {
    return null
  }
}

/** 删掉库里指定的一张（面板手动删）：删文件 + 删条目，返回 { ok, message }。 */
export function deleteShot(dir, file, fsImpl = defaultFs()) {
  const name = String(file || '').trim()
  if (!validFile(name)) return { ok: false, message: '文件名不对，没删' }
  const s = loadShots(dir, fsImpl)
  const it = s.items.find((i) => i.file === name)
  if (!it) return { ok: false, message: '库里没有这张' }
  try {
    fsImpl.unlinkSync(shotPath(dir, name))
  } catch (error) {
    if (error && error.code !== 'ENOENT') return { ok: false, message: '截图没删掉：' + error.message }
  }
  s.items = s.items.filter((i) => i.file !== name)
  try { saveShots(dir, s, fsImpl) } catch {}
  return { ok: true, message: `删掉了《${it.title || '截图'}》那张` }
}

/**
 * 按当前上限裁一遍：超了删最旧的文件 + 条目（不新建文件，只在 load 后裁剪）。
 * 返回删了几张。fsImpl 可注入。
 */
export function trimShots(dir, maxKeep = 30, fsImpl = defaultFs()) {
  try {
    const s = loadShots(dir, fsImpl)
    const cap = Math.max(1, Math.round(Number(maxKeep) || 30))
    let n = 0
    while (s.items.length > cap) {
      const out = s.items.pop()
      try { fsImpl.unlinkSync(join(dir, out.file)) } catch {}
      n++
    }
    if (n) { try { saveShots(dir, s, fsImpl) } catch {} }
    return n
  } catch {
    return 0
  }
}
