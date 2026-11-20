// 本机状态：模板、打印记录、定时去重标记。都放在 modules-data/receipt-print/。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_TEMPLATES = 30
const MAX_HISTORY = 30

export function newId() {
  return `tpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
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
    printer: String(raw.printer || ''),
    width: Number(raw.width) === 48 ? 48 : 0,
    footer: String(raw.footer || ''),
    qr: String(raw.qr || ''),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}

export function openStore(dir) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  let state = { version: 1, seeded: false, templates: [], history: [], lastRun: {} }
  if (existsSync(file)) {
    try {
      const loaded = JSON.parse(readFileSync(file, 'utf8'))
      state = {
        ...state,
        ...loaded,
        templates: Array.isArray(loaded.templates) ? loaded.templates.map(normalizeTemplate) : [],
        history: Array.isArray(loaded.history) ? loaded.history.slice(0, MAX_HISTORY) : [],
        lastRun: loaded.lastRun && typeof loaded.lastRun === 'object' ? loaded.lastRun : {},
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
    addHistory(entry) {
      state.history.unshift({ at: Date.now(), ...entry })
      state.history = state.history.slice(0, MAX_HISTORY)
      save()
    },
    history(limit = 10) {
      return state.history.slice(0, Math.max(1, Number(limit) || 10))
    },
    lastRun(id) { return state.lastRun[id] || '' },
    markRun(id, date) {
      state.lastRun[id] = date
      save()
    },
    seed(template) {
      if (state.seeded || state.templates.length) return null
      state.seeded = true
      const created = this.saveTemplate(template)
      return created
    },
  }
}

export { MAX_TEMPLATES, MAX_HISTORY }
