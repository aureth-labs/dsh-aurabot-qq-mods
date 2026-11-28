// 设置归一化、名字校验、路径和环境变量。这里不碰文件，也不启动进程。
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const RUNTIMES = {
  node: { ext: '.mjs', label: 'Node' },
  powershell: { ext: '.ps1', label: 'PowerShell' },
}

export class ScriptError extends Error {
  constructor(message, code = 'E_SCRIPT') {
    super(message)
    this.name = 'ScriptError'
    this.code = code
  }
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 每次用设置都重新算，面板改完不用重载模块。 */
export function normalizeSettings(raw, { dataDir } = {}) {
  const s = raw && typeof raw === 'object' ? raw : {}
  if (!dataDir) throw new ScriptError('模块数据目录不可用')
  const runtime = s.runtime === 'powershell' ? 'powershell' : 'node'
  const dirText = String(s.scriptDir ?? '').trim()
  const scriptDir = dirText
    ? (isAbsolute(dirText) ? resolve(dirText) : resolve(dataDir, dirText))
    : resolve(dataDir, 'scripts')
  const psRaw = String(s.powershellPath ?? '').trim().replace(/^"(.*)"$/, '$1')
  return {
    runtime,
    ext: RUNTIMES[runtime].ext,
    scriptDir,
    powershellPath: psRaw || 'pwsh',
    timeoutMs: clampInt(s.timeoutSeconds, 1, 300, 20) * 1000,
    maxOutputBytes: clampInt(s.maxOutputKb, 1, 64, 16) * 1024,
    maxScriptBytes: clampInt(s.maxScriptKb, 1, 512, 64) * 1024,
    maxRunsPerHour: clampInt(s.maxRunsPerHour, 1, 200, 30),
    nodeSandbox: s.nodeSandbox !== false,
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => 'com' + (i + 1)),
  ...Array.from({ length: 9 }, (_, i) => 'lpt' + (i + 1)),
])

/** 脚本名变成安全的文件名主干；不许路径、点开头、Windows 保留名。 */
export function normalizeName(input) {
  let name = String(input ?? '').trim()
  if (!name) throw new ScriptError('脚本名不能为空')
  name = name.replace(/\.(mjs|js|ps1)$/i, '').toLowerCase()
  if (!NAME_RE.test(name)) {
    throw new ScriptError('脚本名只能用小写字母、数字、_、-，1~40 个字，并且要以字母或数字开头')
  }
  if (RESERVED.has(name)) throw new ScriptError(`「${name}」是 Windows 保留名，换一个`)
  return name
}

/** 只允许脚本目录里的直属文件，名字校验之后再按路径复核一次。 */
export function scriptPath(config, name) {
  const file = resolve(config.scriptDir, `${name}${config.ext}`)
  const rel = relative(config.scriptDir, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new ScriptError('脚本路径越界')
  }
  return file
}

export function normalizeArgs(args) {
  if (args == null) return []
  if (!Array.isArray(args)) throw new ScriptError('args 要是字符串数组')
  if (args.length > 20) throw new ScriptError('参数最多 20 个')
  return args.map((value) => {
    const text = String(value ?? '')
    if (text.length > 200) throw new ScriptError('单个参数最多 200 个字')
    if (text.includes('\u0000')) throw new ScriptError('参数里不能有 NUL 字符')
    return text
  })
}

/** Node 22.13 / 23.5 起叫 --permission，更早的 22.x 叫 --experimental-permission。 */
export function permissionFlagFor(version) {
  const [major, minor] = String(version || '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  if (major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13)) return '--permission'
  return '--experimental-permission'
}

/** 子进程只拿到这些环境变量；`NODE_OPTIONS`、API key 之类不往下传。 */
const ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'COMSPEC',
]

export function buildEnv(source = process.env) {
  const env = {}
  for (const key of ENV_KEYS) {
    const value = source && source[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  if (!env.PATH && !env.Path) {
    env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin'
  }
  return env
}

export function describeConfig(config) {
  return [
    `脚本目录：${config.scriptDir}`,
    `运行时：${RUNTIMES[config.runtime].label}${config.runtime === 'node' ? (config.nodeSandbox ? '（权限模型开）' : '（权限模型关）') : '（没有沙箱）'}`,
    config.runtime === 'powershell' ? `PowerShell：${config.powershellPath}` : '',
    `单次超时：${config.timeoutMs / 1000} 秒`,
    `输出上限：${Math.round(config.maxOutputBytes / 1024)} KB`,
    `脚本大小上限：${Math.round(config.maxScriptBytes / 1024)} KB`,
    `每小时最多跑：${config.maxRunsPerHour} 次`,
  ].filter(Boolean).join('\n')
}

export function clip(text, max = 8000) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + `\n……（后面还有 ${value.length - max} 个字，截掉了）` : value
}

export function fence(code) {
  const body = String(code ?? '').replace(/\r\n/g, '\n')
  const marks = body.includes('```') ? '````' : '```'
  return `${marks}\n${body}\n${marks}`
}
