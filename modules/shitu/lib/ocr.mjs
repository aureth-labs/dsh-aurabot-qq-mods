// 识别调用层：起 python → 喂 base64 → 收 JSON。
//
// 三件事：md5 缓存（表情包、转发图反复出现）、并发闸（一次最多 N 个进程）、
// 批量合并（一条消息里 3 张图只起 1 个进程，模型只加载一次）。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './env.mjs'

const CACHE_MAX = 500
const CACHE_FILE = 'ocr-cache.json'

export function createOcr({ dir, log, concurrency = 2, timeoutMs = 90_000 } = {}) {
  const cache = loadCache()
  let active = 0
  const waiters = []

  function cachePath() {
    return join(dir(), CACHE_FILE)
  }

  function loadCache() {
    try {
      const raw = JSON.parse(readFileSync(cachePath(), 'utf8'))
      if (raw && typeof raw === 'object' && raw.items) return raw
    } catch {}
    return { items: {}, order: [] }
  }

  function saveCache() {
    try {
      // 只留最近 CACHE_MAX 条
      while (cache.order.length > CACHE_MAX) {
        const dead = cache.order.shift()
        delete cache.items[dead]
      }
      writeFileSync(cachePath(), JSON.stringify(cache), 'utf8')
    } catch (error) {
      log?.debug?.('缓存写入失败：', error.message)
    }
  }

  function keyOf(buf, opts) {
    return createHash('sha1')
      .update(buf)
      .update('|v1|')
      .update(String(opts?.minScore ?? 0))
      .digest('hex')
  }

  function cacheGet(key) {
    const hit = cache.items[key]
    if (!hit) return null
    // 挪到队尾（最近使用）
    const i = cache.order.indexOf(key)
    if (i >= 0) cache.order.splice(i, 1)
    cache.order.push(key)
    return hit
  }

  function cacheSet(key, value) {
    cache.items[key] = value
    cache.order.push(key)
    saveCache()
  }

  async function acquire() {
    if (active < concurrency) {
      active++
      return
    }
    await new Promise((r) => waiters.push(r))
    active++
  }

  function release() {
    active--
    const next = waiters.shift()
    if (next) next()
  }

  /**
   * 批量识别。输入 [{ id, buf, mediaType }]，返回 Map(id → { ok, text, lines, elapsedMs, error, cached })。
   * 命中缓存的不进 python；没命中的合成一次调用。
   */
  async function recognize(items, { minScore = 0, withBoxes = false } = {}) {
    const out = new Map()
    const todo = []
    for (const it of items || []) {
      if (!it?.buf?.length) continue
      const key = keyOf(it.buf, { minScore })
      const hit = cacheGet(key)
      if (hit) {
        out.set(String(it.id), { ...hit, cached: true })
        continue
      }
      todo.push({ ...it, key })
    }
    if (!todo.length) return out

    const target = dir()
    const script = join(target, 'ocr_run.py')
    const python = pickPython(target)
    if (!existsSync(script) || !python) {
      for (const it of todo) out.set(String(it.id), { ok: false, error: '识别引擎还没装好' })
      return out
    }

    const payload = JSON.stringify({
      minScore,
      withBoxes,
      images: todo.map((it) => ({
        id: String(it.id),
        data: it.buf.toString('base64'),
        mediaType: it.mediaType || 'image/png',
      })),
    })

    await acquire()
    let res
    try {
      res = await run(python, [script], {
        cwd: target,
        timeoutMs,
        env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        input: payload,
      })
    } finally {
      release()
    }

    if (res.code !== 0) {
      const why = (res.err || res.out || `退出码 ${res.code}`).trim().slice(-500)
      for (const it of todo) out.set(String(it.id), { ok: false, error: why })
      return out
    }

    let data
    try {
      const last = String(res.out).trim().split('\n').filter(Boolean).pop()
      data = JSON.parse(last)
    } catch {
      for (const it of todo) out.set(String(it.id), { ok: false, error: '识别返回的不是 JSON：' + String(res.out).slice(-300) })
      return out
    }

    const byId = new Map((data.results || []).map((r) => [String(r.id), r]))
    for (const it of todo) {
      const r = byId.get(String(it.id))
      if (!r) {
        out.set(String(it.id), { ok: false, error: '没有这张图的识别结果' })
        continue
      }
      const value = {
        ok: Boolean(r.ok),
        text: r.text || '',
        lines: r.lines || [],
        items: r.items,
        elapsedMs: r.elapsedMs || 0,
        error: r.error || '',
      }
      out.set(String(it.id), { ...value, cached: false })
      if (value.ok && value.text) cacheSet(it.key, { ...value, cached: true })
    }
    return out
  }

  /** 单张（命令 / 工具用）。 */
  async function one(buf, opts = {}) {
    const m = await recognize([{ id: 'one', buf, mediaType: opts.mediaType }], opts)
    return m.get('one') || { ok: false, error: '没有结果' }
  }

  function pickPython(target) {
    // 优先 venv（install 建的那个），其次系统 python
    const venv = process.platform === 'win32'
      ? join(target, '.venv', 'Scripts', 'python.exe')
      : join(target, '.venv', 'bin', 'python')
    if (existsSync(venv)) return venv
    return process.env.SHITU_PYTHON || 'python'
  }

  return {
    recognize,
    one,
    clearCache() {
      cache.items = {}
      cache.order = []
      saveCache()
    },
    cacheSize() {
      return { count: cache.order.length, max: CACHE_MAX }
    },
  }
}
