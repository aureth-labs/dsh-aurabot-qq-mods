// lib/status.mjs —— Bambu 状态归一化与中文格式化（纯函数，无 IO）
// 输入是 MQTT report 的 JSON（P1 系列多为增量），输出统一结构；格式化选项支持群聊脱敏。
// 约定：任何字段缺失都是 null（不要用 0 假装有值），空 report 返回 null。

const STATE_TEXT = {
  IDLE: '空闲',
  PREPARE: '准备中',
  RUNNING: '打印中',
  PAUSE: '已暂停',
  FINISH: '已完成',
  FAILED: '失败',
  SLICING: '切片中',
}

const ACTIVE_STATES = new Set(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'])

/** 字符串数字 -> number；空串/缺省/非有限值 -> null。布尔单独处理。 */
function num(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

function bool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'on' || text === 'true' || text === '1') return true
    if (text === 'off' || text === 'false' || text === '0') return false
  }
  return null
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 深度合并两个 report（只用于纯对象；数组默认替换，AMS 单位按 id 合并）。 */
function mergeRaw(prev, incoming) {
  if (!isPlainObject(incoming)) return isPlainObject(prev) ? prev : {}
  if (!isPlainObject(prev)) return clonePlain(incoming)
  const out = clonePlain(prev)
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'ams' && isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...out[key], ...value, ams: mergeAmsUnits(out[key].ams, value.ams) }
      continue
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeRaw(out[key], value)
      continue
    }
    out[key] = Array.isArray(value) ? clonePlain(value) : value
  }
  return out
}

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = clonePlain(v)
    return out
  }
  return value
}

function mergeAmsUnits(prevUnits, incomingUnits) {
  if (!Array.isArray(incomingUnits)) return Array.isArray(prevUnits) ? clonePlain(prevUnits) : []
  if (!Array.isArray(prevUnits)) return clonePlain(incomingUnits)
  const out = clonePlain(prevUnits)
  for (const unit of incomingUnits) {
    if (!isPlainObject(unit)) continue
    const idx = out.findIndex((item) => isPlainObject(item) && num(item.id) === num(unit.id) && num(unit.id) !== null)
    if (idx === -1) {
      out.push(clonePlain(unit))
      continue
    }
    const merged = mergeRaw(out[idx], unit)
    const prevTray = Array.isArray(out[idx].tray) ? out[idx].tray : []
    const nextTray = Array.isArray(unit.tray) ? unit.tray : []
    merged.tray = mergeAmsUnits(prevTray, nextTray)
    out[idx] = merged
  }
  return out
}

function normalizeColor(value) {
  const text = str(value)
  if (!text) return null
  const hex = text.replace(/^#/, '').toUpperCase()
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(hex)) return null
  return '#' + hex
}

function formatHms(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!isPlainObject(item)) continue
    const attr = num(item.attr)
    const code = num(item.code)
    if (attr === null || code === null) continue
    const hex = (n) => (n >>> 0).toString(16).toUpperCase().padStart(4, '0')
    out.push(hex(attr) + '-' + hex(code))
  }
  return out
}

function parseAms(print) {
  const amsObj = print.ams
  if (!isPlainObject(amsObj) || !Array.isArray(amsObj.ams)) return []
  const out = []
  for (const unit of amsObj.ams) {
    if (!isPlainObject(unit)) continue
    if (Array.isArray(unit.tray) && unit.tray.length) {
      for (const tray of unit.tray) {
        if (!isPlainObject(tray)) continue
        const type = str(tray.tray_type)
        const color = normalizeColor(tray.tray_color)
        const remain = num(tray.remain)
        if (type === null && color === null && remain === null) continue
        out.push({ id: num(tray.id) ?? num(unit.id), type, color, remain })
      }
      continue
    }
    const type = str(unit.tray_type)
    const color = normalizeColor(unit.tray_color)
    const remain = num(unit.remain)
    if (type === null && color === null && remain === null) continue
    out.push({ id: num(unit.id), type, color, remain })
  }
  return out
}

function baseName(path) {
  const text = str(path)
  if (!text) return null
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || null
}

function stateTextOf(state) {
  if (!state) return '未知'
  return STATE_TEXT[state] || state
}

/**
 * 归一化 report。
 * @param {object|string|null} report MQTT report JSON（可只有 print 部分）
 * @param {object} [opts]
 * @param {object} [opts.prev] 上一次的 raw report（含 print）或已归一化的 status，用于增量合并
 * @param {number} [opts.observedStart] 模块观察到的开始时间（ms）
 * @param {number} [opts.now] 当前时间（ms），默认 Date.now()
 * @returns {object|null}
 */
export function normalizeStatus(report, opts = {}) {
  let raw = report
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const prev = opts.prev ?? null
  if (isPlainObject(prev) && isPlainObject(prev.print)) {
    raw = mergeRaw(prev, raw)
  } else if (isPlainObject(prev) && !isPlainObject(raw)) {
    raw = prev
  }
  if (!isPlainObject(raw) || !isPlainObject(raw.print)) return null

  const prevStatus = isPlainObject(prev) && !isPlainObject(prev.print) ? prev : null
  const pick = (value, prevValue) => (value === null || value === undefined ? (prevValue ?? null) : value)
  const print = raw.print
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()

  let state = str(print.gcode_state) || str(print.state)
  if (!state) state = pick(null, prevStatus?.state)

  let percent = num(print.mc_percent)
  if (percent === null) percent = num(print.progress)
  if (percent === null) percent = pick(null, prevStatus?.percent)
  if (percent !== null) percent = Math.max(0, Math.min(100, percent))

  let remainingMin = num(print.mc_remaining_time)
  if (remainingMin !== null && remainingMin <= 0) remainingMin = null
  if (remainingMin === null) remainingMin = pick(null, prevStatus?.remainingMin)

  const gcodeStart = num(print.gcode_start_time)
  const startMs = gcodeStart !== null && gcodeStart > 0 ? gcodeStart * 1000 : null
  // 只认「正数毫秒时间戳」：0 / 负数 / NaN 一律当作「没观测到」。
  // 否则 0 会被当成 Unix epoch，暂停中的打印机会显示约 20770 天的已打印时长。
  const observedStart = typeof opts.observedStart === 'number' && Number.isFinite(opts.observedStart) && opts.observedStart > 0
    ? opts.observedStart
    : null

  let elapsedSec = null
  if (startMs !== null) {
    elapsedSec = Math.max(0, Math.floor((now - startMs) / 1000))
  } else if (observedStart !== null) {
    elapsedSec = Math.max(0, Math.floor((now - observedStart) / 1000))
  } else if (percent !== null && percent > 0 && percent < 100 && remainingMin !== null) {
    elapsedSec = Math.round((remainingMin * percent) / (100 - percent) * 60)
  }
  if (elapsedSec === null) elapsedSec = pick(null, prevStatus?.elapsedSec)

  let startedAt = pick(null, prevStatus?.startedAt)
  if (startMs !== null) startedAt = startMs
  else if (observedStart !== null) startedAt = observedStart
  else if (elapsedSec !== null) startedAt = now - elapsedSec * 1000

  const layer = pick(num(print.layer_num), prevStatus?.layer)
  const totalLayers = pick(num(print.total_layer_num), prevStatus?.totalLayers)

  const subtask = pick(str(print.subtask_name), prevStatus?.subtask)
  const gcodeFile = pick(str(print.gcode_file), prevStatus?.gcodeFile)
  // 文件名优先级：本次报文 -> 上一次 -> subtask -> gcode 路径基名（避免用项目名冒充文件名）
  const explicitName = pick(str(print.file_name), prevStatus?.fileName)
  const fileName = explicitName || subtask || baseName(gcodeFile) || null
  const projectName = pick(
    str(print.project_name) || (fileName ? fileName.replace(/\.(3mf|gcode|stl|obj)$/i, '') : null),
    prevStatus?.projectName,
  )

  let errors = {}
  for (const item of Array.isArray(prevStatus?.errors) ? prevStatus.errors : []) errors[item] = true
  const printError = num(print.print_error)
  if (printError !== null && printError !== 0) {
    errors['0x' + (printError >>> 0).toString(16).toUpperCase().padStart(8, '0')] = true
  }
  for (const item of formatHms(print.hms)) errors[item] = true
  const errorList = Object.keys(errors)

  let ams = parseAms(print)
  if (!ams.length && Array.isArray(prevStatus?.ams)) ams = prevStatus.ams

  const status = {
    state: state || null,
    stateText: stateTextOf(state),
    percent,
    remainingMin,
    elapsedSec,
    startedAt,
    layer,
    totalLayers,
    nozzle: pick(num(print.nozzle_temper), prevStatus?.nozzle),
    nozzleTarget: pick(num(print.nozzle_target_temper), prevStatus?.nozzleTarget),
    bed: pick(num(print.bed_temper), prevStatus?.bed),
    bedTarget: pick(num(print.bed_target_temper), prevStatus?.bedTarget),
    chamber: pick(num(print.chamber_temper), prevStatus?.chamber),
    fileName,
    projectName,
    gcodeFile,
    subtask,
    weight: pick(num(print.total_weight) ?? num(print.weight), prevStatus?.weight),
    ams,
    errors: errorList,
    wifi: pick(num(print.wifi_signal), prevStatus?.wifi),
    speedLevel: pick(num(print.spd_lvl), prevStatus?.speedLevel),
    light: pick(bool(print.chamber_light) ?? bool(print.light), prevStatus?.light),
  }
  return status
}

/** 秒数 -> 中文时长：0 分钟 / 23 分钟 / 2 小时 5 分钟 / 1 天 3 小时 */
export function formatDuration(seconds) {
  const n = num(seconds)
  if (n === null || n <= 0) return '0 分钟'
  const totalMin = Math.floor(n / 60)
  if (totalMin <= 0) return '0 分钟'
  if (totalMin < 60) return totalMin + ' 分钟'
  if (totalMin < 1440) {
    const hours = Math.floor(totalMin / 60)
    const mins = totalMin % 60
    return mins === 0 ? hours + ' 小时' : hours + ' 小时 ' + mins + ' 分钟'
  }
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  return hours === 0 ? days + ' 天' : days + ' 天 ' + hours + ' 小时'
}

/** 紧凑时长，用于单行：1小时38分钟 / 23分钟 */
function compactDuration(seconds) {
  const n = num(seconds)
  if (n === null || n <= 0) return '0分钟'
  const totalMin = Math.floor(n / 60)
  if (totalMin < 60) return totalMin + '分钟'
  if (totalMin < 1440) {
    const hours = Math.floor(totalMin / 60)
    const mins = totalMin % 60
    return mins === 0 ? hours + '小时' : hours + '小时' + mins + '分钟'
  }
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  return hours === 0 ? days + '天' : days + '天' + hours + '小时'
}

function tempText(value, target, unit = '℃') {
  const v = num(value)
  if (v === null) return null
  const t = num(target)
  const shown = Math.round(v)
  if (t === null) return shown + unit
  return shown + '/' + Math.round(t) + unit
}

function clockTime(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

/**
 * 多行中文状态文本。
 * @param {object} status normalizeStatus 的输出
 * @param {{printerName?:string, redactName?:boolean, redactProject?:boolean, stale?:boolean, now?:number}} opts
 */
export function formatStatus(status, opts = {}) {
  if (!status || typeof status !== 'object') return '暂无打印机状态'
  const name = str(opts.printerName) || '打印机'
  const redacted = opts.redactName === true || opts.redactProject === true
  const stale = opts.stale === true
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  const state = status.state || null
  const idle = state === 'IDLE' || !state
  const lines = []

  let title = '🖨️ ' + name + ' · ' + (status.stateText || '未知')
  if (!idle && num(status.percent) !== null) title += '（' + Math.round(status.percent) + '%）'
  if (stale) title += '（数据可能过期）'
  lines.push(title)

  if (!idle) {
    if (num(status.layer) !== null) {
      if (num(status.totalLayers) !== null) lines.push('第 ' + Math.round(status.layer) + '/' + Math.round(status.totalLayers) + ' 层')
      else lines.push('第 ' + Math.round(status.layer) + ' 层')
    }

    const elapsed = num(status.elapsedSec)
    const remaining = num(status.remainingMin)
    if (elapsed !== null && remaining !== null) {
      lines.push('已打印 ' + formatDuration(elapsed) + ' · 剩余 ' + formatDuration(remaining * 60))
    } else if (elapsed !== null) {
      lines.push('已打印 ' + formatDuration(elapsed) + ' · 剩余时间未知')
    } else if (remaining !== null) {
      lines.push('已打印时间未知 · 剩余 ' + formatDuration(remaining * 60))
    } else if (ACTIVE_STATES.has(state)) {
      lines.push('进度未知 · 剩余时间未知')
    }

    if (remaining !== null && ACTIVE_STATES.has(state)) {
      const eta = clockTime(now + remaining * 60000)
      if (eta) lines.push('预计 ' + eta + ' 完成')
    }
  }
  // IDLE 不展示进度与预计完成，避免误导

  const temps = []
  const nozzle = tempText(status.nozzle, status.nozzleTarget)
  if (nozzle) temps.push('喷嘴 ' + nozzle)
  const bed = tempText(status.bed, status.bedTarget)
  if (bed) temps.push('热床 ' + bed)
  const chamber = num(status.chamber)
  if (chamber !== null) temps.push('仓温 ' + Math.round(chamber) + '℃')
  if (temps.length) lines.push(temps.join(' · '))

  // 只有确实有文件名时才出行（脱敏时替换为占位），没有就不编造
  if (status.fileName) lines.push(redacted ? '文件：已脱敏' : '文件：' + status.fileName)

  const errors = Array.isArray(status.errors) ? status.errors.filter((e) => typeof e === 'string' && e) : []
  if (errors.length) lines.push('⚠️ 错误：' + errors.join('、'))

  return lines.join('\n')
}

/** 单行摘要：🖨️ A1 · 打印中 42% · 剩余 1小时38分钟 */
export function formatBrief(status, opts = {}) {
  if (!status || typeof status !== 'object') return '暂无打印机状态'
  const name = str(opts.printerName) || '打印机'
  const state = status.stateText || '未知'
  const parts = ['🖨️ ' + name, state]
  if (status.state !== 'IDLE' && num(status.percent) !== null) parts.push(Math.round(status.percent) + '%')
  const remaining = num(status.remainingMin)
  if (remaining !== null && status.state !== 'IDLE') parts.push('剩余 ' + compactDuration(remaining * 60))
  if (Array.isArray(status.errors) && status.errors.length) parts.push('有错误')
  if (opts.stale === true) parts.push('数据可能过期')
  return parts.join(' · ')
}

function maskSerial(serial) {
  const text = str(serial)
  if (!text) return '未知'
  if (text.length <= 8) return text.slice(0, 2) + '****'
  return text.slice(0, 4) + '****' + text.slice(-4)
}

/** 编号列表：打印机名 / 型号 / 序列号打码 */
export function formatChoiceList(printers) {
  const list = Array.isArray(printers) ? printers : []
  if (!list.length) return '没有可用的打印机。'
  return list
    .map((item, index) => {
      const p = item && typeof item === 'object' ? item : {}
      const name = str(p.name) || str(p.label) || '未命名打印机'
      const model = str(p.model)
      const serial = maskSerial(p.serial)
      const label = str(p.label)
      const head = index + 1 + '. ' + name
      const parts = []
      if (label && label !== name) parts.push('绑定：' + label)
      if (model) parts.push(model)
      parts.push('序列号 ' + serial)
      return head + (parts.length ? ' · ' + parts.join(' · ') : '')
    })
    .join('\n')
}
