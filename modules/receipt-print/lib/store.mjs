// 本机状态：模板、打印记录、定时去重标记。都放在 modules-data/receipt-print/。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

const MAX_TEMPLATES = 30
const MAX_HISTORY = 30
const MAX_BACKUPS = 200
const MAX_TEXT = 8000
const TRIGGER_TYPES = ['command', 'panel', 'schedule', 'moment', 'selftest', 'unknown']

export function newId() {
  return `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// 旧模板用 width=32/48（字符数），换算成纸宽；0 表示跟随打印机。
function templatePaperMm(raw) {
  if (raw.widthMm !== undefined) {
    const n = Number(raw.widthMm)
    return Number.isFinite(n) && n >= 20 && n <= 120 ? Math.round(n * 10) / 10 : 0
  }
  if (Number(raw.width) === 48) return 80
  if (Number(raw.width) === 32) return 58
  return 0
}

export function normalizeTemplate(raw = {}) {
  const schedule = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {}
  const days = Array.isArray(schedule.days)
    ? [...new Set(schedule.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : []
  return {
    id: String(raw.id || newId()),
    name: String(raw.name || '未命名模板').trim().slice(0, 40),
    enabled: raw.enabled !== false,
    prompt: String(raw.prompt || ''),
    system: String(raw.system || ''),
    engine: raw.engine === 'think' ? 'think' : 'ask',
    schedule: {
      enabled: schedule.enabled === true,
      time: /^\d{2}:\d{2}$/.test(String(schedule.time || '')) ? String(schedule.time) : '08:30',
      days,
    },
    widthMm: templatePaperMm(raw),
    footer: String(raw.footer || ''),
    qr: String(raw.qr || ''),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}

export function normalizeHistoryEntry(raw = {}) {
  const trigger = raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : {}
  return {
    at: Number(raw.at) || Date.now(),
    template: String(raw.template || '').slice(0, 40),
    printer: String(raw.printer || '').slice(0, 80),
    transport: String(raw.transport || '').slice(0, 20),
    ok: raw.ok === true,
    error: String(raw.error || '').slice(0, 500),
    chars: Number(raw.chars) || 0,
    images: Number(raw.images) || 0,
    preview: raw.preview === true,
    text: String(raw.text || '').slice(0, MAX_TEXT),
    trigger: {
      type: TRIGGER_TYPES.includes(trigger.type) ? trigger.type : 'unknown',
      reason: String(trigger.reason || '').slice(0, 200),
      momentId: String(trigger.momentId || '').slice(0, 80),
    },
    backup: String(raw.backup || ''),
    backupError: String(raw.backupError || ''),
  }
}

function safeName(name) {
  return String(name || 'receipt').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) || 'receipt'
}

function stamp(at) {
  const d = new Date(at)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  // 带毫秒，减少同一秒内连打两张时的重名；仍重名时由 uniqueName 补序号
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
}

function resolveBackupTarget(dir, customDir) {
  const target = String(customDir || '').trim()
  if (!target) return join(dir, 'backups')
  // 相对路径按模块数据目录解析，绝对路径（如 D:\小票备份）原样使用
  return isAbsolute(target) ? target : join(dir, target)
}

// 同一毫秒连打两张时时间戳会相同，这里补序号，避免后一张覆盖前一张。
function uniqueName(target, base) {
  if (!existsSync(join(target, base))) return base
  const stem = base.replace(/\.txt$/, '')
  for (let i = 2; ; i += 1) {
    const next = `${stem}-${i}.txt`
    if (!existsSync(join(target, next))) return next
  }
}

function writeBackup(dir, entry, customDir = '') {
  const target = resolveBackupTarget(dir, customDir)
  const base = `receipt-${stamp(entry.at)}-${safeName(entry.template)}.txt`
  const lines = [
    `时间：${new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}`,
    `来源：${entry.template || '未知'}`,
    `触发类型：${entry.trigger.type}`,
    `触发原因：${entry.trigger.reason || '未记录'}`,
    ...(entry.trigger.momentId ? [`说说 ID：${entry.trigger.momentId}`] : []),
    `打印机：${entry.printer || '未配置'}（${entry.transport || '预览'}）`,
    `结果：${entry.ok ? '成功' : '失败'}${entry.error ? ` / ${entry.error}` : ''}`,
    `字数：${entry.chars}${entry.images ? ` · 图片：${entry.images} 张` : ''}`,
    '',
    '-'.repeat(24),
    entry.text || '（这次没有记录正文）',
    '',
  ]
  const body = lines.join('\n')

  try {
    mkdirSync(target, { recursive: true })
    const file = uniqueName(target, base)
    writeFileSync(join(target, file), body, 'utf8')
    pruneBackups(target)
    return { path: String(customDir || '').trim() ? join(target, file) : join('backups', file) }
  } catch (error) {
    // 自定义目录不可写时退回模块数据目录，别让打印记录丢失
    const fallback = join(dir, 'backups')
    mkdirSync(fallback, { recursive: true })
    const file = uniqueName(fallback, base)
    writeFileSync(join(fallback, file), body, 'utf8')
    pruneBackups(fallback)
    return {
      path: join('backups', file),
      error: `备份目录不可写（${target}）：${error.message}`,
    }
  }
}

// 只清理本模块生成的 receipt-*.txt，用户自己放在同一目录的文件不动。
function pruneBackups(target) {
  try {
    if (!existsSync(target)) return
    const files = readdirSync(target).filter((f) => /^receipt-\d{8}-\d{9}-.*\.txt$/.test(f)).sort()
    for (const old of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
      try { unlinkSync(join(target, old)) } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 备份清理失败不影响打印 */ }
}

export function openStore(dir) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  let state = { version: 1, seeded: false, seededSummary: false, templates: [], history: [], lastRun: {}, moment: { lastAt: 0 } }
  if (existsSync(file)) {
    try {
      const loaded = JSON.parse(readFileSync(file, 'utf8'))
      state = {
        ...state,
        ...loaded,
        templates: Array.isArray(loaded.templates) ? loaded.templates.map(normalizeTemplate) : [],
        history: Array.isArray(loaded.history) ? loaded.history.slice(0, MAX_HISTORY).map(normalizeHistoryEntry) : [],
        lastRun: loaded.lastRun && typeof loaded.lastRun === 'object' ? loaded.lastRun : {},
        moment: loaded.moment && typeof loaded.moment === 'object'
          ? { lastAt: Number(loaded.moment.lastAt) || 0, seeded: loaded.moment.seeded === true }
          : { lastAt: 0, seeded: false },
      }
    } catch {
      // 状态文件坏了就重新开始，不让模块起不来
    }
  }

  const save = () => {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  return {
    dir,
    get state() { return state },
    templates() { return state.templates.slice() },
    get(idOrName) {
      const key = String(idOrName || '').trim()
      if (!key) return null
      return state.templates.find((t) => t.id === key)
        || state.templates.find((t) => t.name === key)
        || state.templates.find((t) => t.name.toLowerCase() === key.toLowerCase())
        || null
    },
    saveTemplate(raw) {
      const template = normalizeTemplate({ ...raw, updatedAt: Date.now() })
      const index = state.templates.findIndex((t) => t.id === template.id)
      if (index >= 0) state.templates[index] = template
      else {
        if (state.templates.length >= MAX_TEMPLATES) throw new Error(`模板最多 ${MAX_TEMPLATES} 个`)
        state.templates.push(template)
      }
      save()
      return template
    },
    deleteTemplate(idOrName) {
      const template = this.get(idOrName)
      if (!template) return null
      state.templates = state.templates.filter((t) => t.id !== template.id)
      delete state.lastRun[template.id]
      save()
      return template
    },
    addHistory(entry, options = {}) {
      const item = normalizeHistoryEntry({ at: Date.now(), ...entry })
      if (item.text) {
        try {
          const saved = writeBackup(dir, item, options.backupDir)
          item.backup = saved.path
          if (saved.error) item.backupError = saved.error
        } catch { /* 备份失败不影响打印记录 */ }
      }
      state.history.unshift(item)
      state.history = state.history.slice(0, MAX_HISTORY)
      save()
      return item
    },
    history(limit = 10) {
      return state.history.slice(0, Math.max(1, Number(limit) || 10))
    },
    lastRun(id) { return state.lastRun[id] || '' },
    markRun(id, date) {
      state.lastRun[id] = date
      save()
    },
    momentLast() { return Number(state.moment?.lastAt) || 0 },
    momentSeeded() { return state.moment?.seeded === true },
    markMoment(at, { seeded = false } = {}) {
      const stamps = state.moment || { lastAt: 0, seeded: false }
      const nextAt = Math.max(stamps.lastAt || 0, Number(at) || 0)
      const nextSeeded = seeded || stamps.seeded === true
      if (nextAt === (stamps.lastAt || 0) && nextSeeded === (stamps.seeded === true)) return
      state.moment = { lastAt: nextAt, seeded: nextSeeded }
      save()
    },
    seed(template) {
      if (state.seeded || state.templates.length) return null
      state.seeded = true
      const created = this.saveTemplate(template)
      return created
    },
    // 老用户已经有「每日简报」时，也要补一个「今日总结」，但只补一次。
    seedSummary(template) {
      if (state.seededSummary) return null
      state.seededSummary = true
      if (state.templates.some((t) => t.name === template.name)) {
        save()
        return null
      }
      if (state.templates.length >= MAX_TEMPLATES) {
        save()
        return null
      }
      return this.saveTemplate(template)
    },
  }
}

export { MAX_TEMPLATES, MAX_HISTORY }
