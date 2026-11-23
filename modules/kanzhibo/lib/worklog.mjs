// lib/worklog.mjs —— 操作记录：本地 jsonl + 内存最近 300 条。
// （1.3.0 起不再写「工作间」会话，纯本地记录。）
import { mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function createWorklog({ dataDir, dayKey }) {
  const dir = () => join(dataDir(), 'worklog')
  const file = (d = new Date()) => join(dir(), dayKey(d) + '.jsonl')
  let recent = []
  try {
    const text = readFileSync(file(), 'utf8')
    recent = text.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean).slice(-300)
  } catch { recent = [] }
  const fmtStep = (e) => {
    const at = String((e && e.at) || '')
    const t = at.length >= 19 ? at.slice(11, 19) : new Date().toLocaleTimeString('zh-CN', { hour12: false })
    return t + ' ' + (e && e.ok === false ? '✗ ' : '· ') + String((e && e.step) || '') +
      (e && e.detail ? '：' + e.detail : '')
  }
  function journal(step, detail = '', ok = true) {
    try {
      const e = { at: new Date().toISOString(), step: String(step || '操作'), detail: String(detail || '').slice(0, 200), ok: ok !== false }
      try {
        mkdirSync(dir(), { recursive: true })
        appendFileSync(file(), JSON.stringify(e) + '\n', 'utf8')
      } catch {}
      recent.push(e)
      if (recent.length > 300) recent = recent.slice(-300)
    } catch {}
  }
  const recentOps = (n = 20) => recent.slice(-Math.max(1, Math.min(300, Number(n) || 20)))
  return { journal, recentOps, fmtStep, get count() { return recent.length } }
}
