/**
 * 素材库的落盘层。
 *
 * 正本是一个 JSONL（一行一条，追加写、坏了也只坏一行），
 * 旁边放一份给人看的 md 镜像和一份待审队列。
 * 目录默认是插件数据目录；主人在设置里填绝对路径就写到那儿 —— 这是需求里
 * 「主人指定素材存放目录」那一条。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const CORPUS_FILE = 'corpus.jsonl'
export const PENDING_FILE = 'pending.json'
export const MIRROR_FILE = 'corpus.md'

/**
 * 决定素材往哪写。
 * 主人填了绝对路径就用它（目录不存在也没关系，写的时候会建）；
 * 填相对路径、或者指到一个文件上，就回落到插件数据目录，并把原因带出去，
 * 好在 `/素材 目录` 里告诉主人「你填的那个没生效，为什么」。
 */
export function resolveDir(configured, fallback) {
  const raw = String(configured ?? '').trim()
  if (!raw) return { dir: fallback, note: '用插件数据目录（设置里没填素材目录）' }
  if (!isAbsolute(raw)) return { dir: fallback, note: `「${raw}」不是绝对路径，改用插件数据目录` }
  try {
    if (!statSync(raw).isDirectory()) return { dir: fallback, note: `「${raw}」不是目录，改用插件数据目录` }
  } catch {
    // 不存在就是还没建，允许 —— 下面写文件时会 mkdir
  }
  return { dir: resolve(raw), note: '用主人指定的目录' }
}

/** 一个目录下三个文件的完整路径 */
export function filesIn(dir) {
  return { dir, corpus: join(dir, CORPUS_FILE), pending: join(dir, PENDING_FILE), mirror: join(dir, MIRROR_FILE) }
}

/** 同步地干等一会儿：Windows 上 rename 偶尔被占用，退避重试时用 */
function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 故意的空转，宁可慢一点也不要写坏文件
  }
}

/**
 * 原子写：先写唯一临时文件，再 rename 覆盖。
 * 中途断电最多丢这一次写，不会留下写了一半的正本。
 */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  for (let attempt = 1; ; attempt += 1) {
    try {
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, text, null, 'utf8')
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
      return
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {}
      if (attempt >= 6) throw error
      sleep(20 * attempt)
    }
  }
}

export function writeText(file, text) {
  writeAtomic(file, String(text ?? ''))
}

/** 读正本：一行一条，坏行跳过 —— 手改错一行不该让整个库读不出来 */
export function readCorpus(file) {
  try {
    if (!existsSync(file)) return []
    const out = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim()
      if (!text) continue
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && typeof parsed.text === 'string' && parsed.text) {
          out.push(parsed)
        }
      } catch {
        // 跳过坏行
      }
    }
    return out
  } catch {
    return []
  }
}

/** 追加一条。正常收录走这条路，不用整份重写 */
export function appendCorpus(file, entry) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

/** 删除 / 裁剪 / 过审之后整份重写 */
export function writeCorpus(file, entries) {
  const body = (Array.isArray(entries) ? entries : []).map((e) => JSON.stringify(e)).join('\n')
  writeAtomic(file, body ? `${body}\n` : '')
}

/** 待审队列：小数组，每次整份写 */
export function readPending(file) {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
    return list.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.text === 'string' && e.text)
  } catch {
    return []
  }
}

export function writePending(file, list) {
  const items = Array.isArray(list) ? list : []
  writeAtomic(file, `${JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2)}\n`)
}

/** 某个文件多大、什么时候动过 —— `/素材 目录` 用来说明镜像是不是最新的 */
export function statOf(file) {
  try {
    const st = statSync(file)
    return { bytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}
