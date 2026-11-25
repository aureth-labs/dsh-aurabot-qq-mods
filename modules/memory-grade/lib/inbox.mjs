/**
 * 统一收件箱。
 *
 * 各平台把「该被总库看见的东西」都投到这里，总库每天整理时只读这一处。
 * 好处：
 *   - 只有一个入口，不用满地找壳
 *   - 每条带 src，整理完记一份各来源条数，哪个平台没投进来一眼就看出来
 *   - 整理完标 done 再清空，腾地方给下一轮
 *
 * 文件：inbox/pending.jsonl（正在攒的）
 *       整理完由调用方转到 done-<日期>.jsonl 存档（或直接删）
 *
 * 一行一条：
 *   { t, src, kind, text, meta, done }
 *   src  = chat / bili / douyin / tieba / tophub / knowledge / diary ...（谁投的）
 *   kind = fact / seen / event / knowledge / chat ...（这条是什么性质）
 */

import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

const FILE = 'pending.jsonl'
// 写入时不缩句（缩句要叫模型，写入会变慢还花钱）。
// 这里只做物理裁剪：去掉连续空白、单条封顶 2000 字，长消息基本能留全。
// 真正的缩句留给整理那一步（一天一两次，那时候花一次模型钱更划算）。
const TEXT_MAX = 2000

/**
 * 打开收件箱。
 * @param {string} dir 模块数据目录（api.dataDir()），收件箱放在它下面的 inbox/
 */
export function openInbox(dir, opts = {}) {
  const now = opts.now || Date.now
  const root = join(dir, 'inbox')
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    /* 建不出来就让后续读写自己失败 */
  }
  const file = join(root, FILE)

  let cache = null
  let cacheMtime = -1

  function loadAll() {
    if (!existsSync(file)) {
      cache = []
      cacheMtime = 0
      return cache
    }
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      mtime = 0
    }
    if (cache && mtime === cacheMtime) return cache
    const out = []
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      raw = ''
    }
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        if (o && Number.isFinite(o.t)) out.push(o)
      } catch {
        /* 坏行跳过 */
      }
    }
    cache = out
    cacheMtime = mtime
    return out
  }

  /** 投一条。只有 text 有内容才收。 */
  function put({ src, kind, text, meta, t } = {}) {
    const s = String(src || '').trim()
    const body = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TEXT_MAX)
    if (!s || !body) return false
    const item = {
      t: Number(t) || now(),
      src: s,
      kind: String(kind || 'fact'),
      text: body,
      meta: meta && typeof meta === 'object' ? meta : undefined,
      done: 0,
    }
    try {
      mkdirSync(root, { recursive: true })
      appendFileSync(file, JSON.stringify(item) + '\n', 'utf8')
      if (cache) cache.push(item)
      cacheMtime = -1
      return true
    } catch {
      return false
    }
  }

  /** 取还没整理过的 */
  function pending({ limit = 2000 } = {}) {
    const all = loadAll()
    const out = []
    for (const r of all) {
      if (r.done === 1) continue
      out.push(r)
      if (out.length >= limit) break
    }
    return out
  }

  /** 按来源统计（未整理的） */
  function stats() {
    const all = loadAll()
    const by = {}
    let undone = 0
    for (const r of all) {
      if (r.done === 1) continue
      undone++
      by[r.src] = (by[r.src] || 0) + 1
    }
    return { total: all.length, undone, bySrc: by, file }
  }

  /**
   * 整理完了：整份清空，返回清掉的条数。
   * 想留档就把 archive 传 true，会先把内容改名成 done-<时间>.jsonl 再清。
   */
  function clear({ archive = true } = {}) {
    if (!existsSync(file)) return 0
    const all = loadAll()
    const n = all.length
    if (!n) return 0
    try {
      if (archive) {
        const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
        const doneFile = join(root, `done-${stamp}.jsonl`)
        try {
          renameSync(file, doneFile)
        } catch {
          /* 改名失败就退回直接清空 */
          writeFileSync(file, '', 'utf8')
        }
      } else {
        writeFileSync(file, '', 'utf8')
      }
      cache = []
      cacheMtime = 0
      return n
    } catch {
      return 0
    }
  }

  /** 把待整理的内容拼成给模型看的文本 */
  function renderForModel(rows, { maxChars = 12000 } = {}) {
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return ''
    const parts = []
    let len = 0
    for (const r of list) {
      const hh = new Date(r.t).toTimeString().slice(0, 5)
      const line = `[${r.src}/${r.kind}] ${hh} ${r.text}`
      if (len + line.length > maxChars) break
      parts.push(line)
      len += line.length + 1
    }
    return parts.join('\n')
  }

  return { put, pending, stats, clear, renderForModel, loadAll, file, root }
}

/**
 * 各平台来源的显示名（写日志、面板用）
 */
export const SRC_LABEL = {
  chat: '聊天',
  bili: 'B站',
  douyin: '抖音',
  tieba: '贴吧',
  tophub: '热榜',
  knowledge: '知识',
  diary: '空间日记',
  heybox: '小黑盒',
  web: '网页',
  mm: '微信',
}
