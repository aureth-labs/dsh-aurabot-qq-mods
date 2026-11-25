/**
 * 证据库的落盘层：一个 JSON 文件，原子写。
 * 数据放  companion-memory 分开放，互不干扰。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const EMPTY_STORE = {
  version: 1,
  updated_at: null,
  facts: {},
  reflections: [],
  persona: [],
}

function sleep(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 同步地干等，避免短暂的文件占用把整轮写坏
  }
}

/** 原子写：先写唯一临时文件，再 rename。Windows 上偶尔 EPERM/EBUSY，退避重试。 */
export function writeAtomic(file, text) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  let attempt = 0
  for (;;) {
    try {
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, text, null, 'utf8')
      } finally {
        closeSync(fd)
      }
      // rename 在 Windows 上是原子的覆盖
      renameSync(tmp, file)
      return
    } catch (error) {
      attempt += 1
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {}
      if (attempt >= 6) throw error
      sleep(20 * attempt)
    }
  }
}

export function readStore(file) {
  try {
    if (!existsSync(file)) return structuredClone(EMPTY_STORE)
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return structuredClone(EMPTY_STORE)
    const parsed = JSON.parse(raw)
    return {
      ...structuredClone(EMPTY_STORE),
      ...parsed,
      facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
      reflections: Array.isArray(parsed.reflections) ? parsed.reflections : [],
      persona: Array.isArray(parsed.persona) ? parsed.persona : [],
    }
  } catch {
    return structuredClone(EMPTY_STORE)
  }
}

export function saveStore(file, store) {
  writeAtomic(file, `${JSON.stringify(store, null, 2)}\n`)
}

/** 读 companion-memory 的 records.json（只读，不改人家） */
export function readRecords(file) {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : []
    return list.filter((r) => r && typeof r.id === 'string')
  } catch {
    return []
  }
}
