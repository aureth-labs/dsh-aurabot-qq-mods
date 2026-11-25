/**
 * 采样托管：起一个 PowerShell 子进程，读它每 N 毫秒吐的一行 JSON。
 *
 * 为什么不是纯 JS：前台窗口标题、空闲秒数都要 Win32 调用，
 * Node 里没有原生能力，PowerShell + 内嵌 C# 是这台机器上最省事的路。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'

const PS_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'powershell.exe',
]

export const DEFAULTS = {
  scriptPath: 'scripts/activity-sampler.ps1',
  intervalMs: 5000,
  dataDir: 'activity-data',
  cpu: false,
  maxLogBytes: 24 * 1024 * 1024,
  restartBackoffMs: 5000,
}

export function resolveOptions(config = {}) {
  const opts = { ...DEFAULTS, ...config }
  opts.intervalMs = Math.max(1000, Math.min(120000, Number(opts.intervalMs) || DEFAULTS.intervalMs))
  return opts
}

function findPowerShell() {
  for (const candidate of PS_CANDIDATES) {
    try {
      if (candidate === 'powershell.exe' || existsSync(candidate)) return candidate
    } catch {}
  }
  return 'powershell.exe'
}

/** 轮转：超过上限就把当前日志压成 .1 */
function rotateIfNeeded(file, maxBytes) {
  try {
    if (!existsSync(file)) return
    const { size } = statSync(file)
    if (size < maxBytes) return
    try { renameSync(file, `${file}.1`) } catch {}
  } catch {}
}

export class ActivitySampler {
  constructor(options = {}, handlers = {}) {
    this.opts = resolveOptions(options)
    this.onSample = handlers.onSample ?? (() => {})
    this.onError = handlers.onError ?? (() => {})
    this.onExit = handlers.onExit ?? (() => {})

    this.child = null
    this.stopped = false
    this.restartTimer = null
    this.buffer = ''
    this.stats = { samples: 0, parseErrors: 0, restarts: 0, lastSampleAt: null }
    this.logFile = join(this.opts.dataDir, 'samples.jsonl')
    this.currentFile = join(this.opts.dataDir, 'current.json')
  }

  ensureDir() {
    try { mkdirSync(this.opts.dataDir, { recursive: true }) } catch {}
  }

  start() {
    if (this.child || this.stopped) return
    this.ensureDir()

    const ps = findPowerShell()
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.opts.scriptPath, '-IntervalMs', String(this.opts.intervalMs)]
    if (!this.opts.cpu) args.push('-NoCpu')

    let child
    try {
      child = spawn(ps, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.onError(error)
      this.scheduleRestart()
      return
    }

    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this.onError(new Error(text.slice(0, 800)))
    })
    child.on('error', (error) => this.onError(error))
    child.on('exit', (code, signal) => {
      this.child = null
      const reason = signal ? `signal ${signal}` : `code ${code}`
      this.onExit({ code, signal, reason })
      if (!this.stopped) this.scheduleRestart()
    })
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return
    this.stats.restarts += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, this.opts.restartBackoffMs)
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref()
  }

  /** 按行切；一行一个 JSON。半截行留在 buffer 里等下一块。 */
  consume(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line || !line.startsWith('{')) continue
      let obs
      try {
        obs = JSON.parse(line)
      } catch {
        this.stats.parseErrors += 1
        continue
      }
      if (!obs || typeof obs !== 'object') continue
      this.stats.samples += 1
      this.stats.lastSampleAt = Date.now()
      this.record(obs)
      try { this.onSample(obs) } catch (error) { this.onError(error) }
    }
    // 防御：万一对方不吐换行，别让 buffer 无限长
    if (this.buffer.length > 65536) this.buffer = ''
  }

  record(obs) {
    try {
      rotateIfNeeded(this.logFile, this.opts.maxLogBytes)
      appendFileSync(this.logFile, `${JSON.stringify({ machine: hostname(), ...obs })}\n`, 'utf8')
    } catch {}
  }

  /** 给别的脚本读的「当前状态」快照，原子替换。 */
  publish(payload) {
    try {
      const tmp = `${this.currentFile}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.currentFile)
    } catch {}
  }

  stop() {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    if (child) {
      try { child.kill() } catch {}
    }
  }
}

export function describeSamplerError(error) {
  if (!error) return 'unknown'
  if (error.code === 'ENOENT') return '找不到 powershell.exe'
  if (error.code === 'EPERM') return '权限被拒（沙箱不让起子进程？）'
  return error.message ? String(error.message).slice(0, 400) : String(error)
}

/** 给日志用：一条采样压成一行，别把 JSON 全打出去。 */
export function formatSample(obs) {
  if (!obs) return ''
  const title = typeof obs.title === 'string' ? obs.title.slice(0, 40) : ''
  // idle 缺失时写 ?，别写 `idle=undefineds` —— 日志里那种字符串会误导排查
  const idle = typeof obs.idle === 'number' && Number.isFinite(obs.idle) ? `${Math.round(obs.idle)}s` : '?'
  return `${obs.proc || '?'}｜${title || '(无标题)'}｜idle=${idle}`
}

export { dirname }
