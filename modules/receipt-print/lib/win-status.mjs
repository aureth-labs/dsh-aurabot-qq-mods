// Windows 打印驱动状态读取。
//
// Windows 打印队列本身是单向的（WritePrinter 只能写），但驱动会把设备状态
// 通过 Bidi 上报给系统。这里用 WMI（Win32_Printer）和 Get-Printer 把驱动
// 已知的状态读出来，属于「驱动视角」：离线、缺纸、卡纸、开盖这类粗粒度状态
// 通常可靠，纸张将尽、切刀错误这类传感器细节多半拿不到。
//
// 真正的实时回读仍然只有网口 9100 / 串口这类双向通道能做。
import { spawn } from 'node:child_process'

const PRINTER_STATUS = {
  1: '其他',
  2: '未知',
  3: '空闲',
  4: '打印中',
  5: '预热中',
  6: '已停止打印',
  7: '离线',
}

const ERROR_STATE = {
  0: '未知',
  1: '其他',
  2: '正常',
  3: '纸张将尽',
  4: '缺纸',
  5: '墨粉将尽',
  6: '无墨粉',
  7: '机盖打开',
  8: '卡纸',
  9: '离线',
  10: '需要维修',
  11: '出纸口已满',
}

const STATE_FLAGS = [
  [0x00000001, '已暂停'],
  [0x00000002, '错误'],
  [0x00000008, '卡纸'],
  [0x00000010, '缺纸'],
  [0x00000020, '需要手动送纸'],
  [0x00000040, '纸张问题'],
  [0x00000080, '离线'],
  [0x00000200, '忙'],
  [0x00000400, '打印中'],
  [0x00000800, '出纸口已满'],
  [0x00010000, '预热中'],
  [0x00020000, '墨粉将尽'],
  [0x00040000, '无墨粉'],
  [0x00080000, '需要人工干预'],
  [0x00100000, '内存不足'],
  [0x00200000, '机盖打开'],
  [0x00400000, '服务未知'],
]

const GET_PRINTER_STATUS = {
  Normal: '正常',
  Unknown: '未知',
  Offline: '离线',
  PaperJam: '卡纸',
  PaperOut: '缺纸',
  DoorOpen: '机盖打开',
  Error: '错误',
  Paused: '已暂停',
  Printing: '打印中',
  WarmingUp: '预热中',
  NotAvailable: '不可用',
  NoToner: '无墨粉',
  TonerLow: '墨粉将尽',
  UserIntervention: '需要人工干预',
}

// PowerShell 只输出 ASCII 的 JSON，中文在 Node 这边映射，避免控制台代码页把中文弄乱。
const POWERSHELL_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$name = '__NAME__'
$cim = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $name } | Select-Object -First 1
$gp = Get-Printer -Name $name
$out = [ordered]@{ name = $name; found = $false }
if ($cim) {
  $out.found = $true
  $out.printerStatus = [int]$cim.PrinterStatus
  $out.detectedErrorState = [int]$cim.DetectedErrorState
  $out.workOffline = [bool]$cim.WorkOffline
  $out.printerState = [int]$cim.PrinterState
  $out.jobCount = [int]$cim.JobCount
  $out.portName = [string]$cim.PortName
  $out.driverName = [string]$cim.DriverName
}
if ($gp) {
  $out.getPrinterStatus = [string]$gp.PrinterStatus
  $out.jobCount = [int]$gp.JobCount
  $out.portName = [string]$gp.PortName
  $out.driverName = [string]$gp.DriverName
}
$out | ConvertTo-Json -Compress`

export function buildStatusScript(name) {
  const safe = String(name || '').replace(/'/g, "''")
  return POWERSHELL_SCRIPT.replace('__NAME__', safe)
}

export function parseWindowsStatus(json) {
  const data = json && typeof json === 'object' ? json : {}
  const printerStatus = Number(data.printerStatus)
  const detected = Number(data.detectedErrorState)
  const state = Number(data.printerState) || 0
  const workOffline = data.workOffline === true || data.workOffline === 'True'
  const getStatus = String(data.getPrinterStatus || '')

  const flags = STATE_FLAGS.filter(([bit]) => (state & bit) !== 0).map(([, label]) => label)
  const problems = []
  const add = (label) => { if (label && !problems.includes(label)) problems.push(label) }

  if (workOffline || printerStatus === 7 || getStatus === 'Offline') add('离线')
  if (detected === 3) add('纸张将尽')
  if (detected === 4 || getStatus === 'PaperOut') add('缺纸')
  if (detected === 5 || getStatus === 'TonerLow') add('墨粉将尽')
  if (detected === 6 || getStatus === 'NoToner') add('无墨粉')
  if (detected === 7 || getStatus === 'DoorOpen') add('机盖打开')
  if (detected === 8 || getStatus === 'PaperJam') add('卡纸')
  if (detected === 10) add('需要维修')
  if (detected === 11) add('出纸口已满')
  if (getStatus === 'Error') add('错误')
  if (getStatus === 'Paused') add('已暂停')
  if (getStatus === 'NotAvailable') add('不可用')
  if (getStatus === 'UserIntervention') add('需要人工干预')
  for (const label of flags) {
    if (['已暂停', '错误', '卡纸', '缺纸', '纸张问题', '离线', '出纸口已满', '墨粉将尽', '无墨粉', '机盖打开', '需要人工干预', '内存不足'].includes(label)) add(label)
  }

  return {
    found: data.found === true,
    name: String(data.name || ''),
    printerStatus: Number.isFinite(printerStatus) ? printerStatus : null,
    printerStatusText: PRINTER_STATUS[printerStatus] || (getStatus ? (GET_PRINTER_STATUS[getStatus] || getStatus) : '未知'),
    detectedErrorState: Number.isFinite(detected) ? detected : null,
    detectedErrorText: ERROR_STATE[detected] || '未知',
    workOffline,
    printerState: state,
    stateFlags: flags,
    jobCount: Number(data.jobCount) || 0,
    portName: String(data.portName || ''),
    driverName: String(data.driverName || ''),
    problems: [...new Set(problems)],
  }
}

/** 把驱动状态渲染成给主人看的一行行文字。 */
export function renderDriverStatus(info, printerName = '') {
  if (!info) return '没有读到驱动状态'
  const head = printerName ? `打印机「${printerName}」` : '打印机'
  if (!info.found) return `${head}：系统里找不到这个打印队列`
  const lines = [`${head}：${info.printerStatusText}`]
  lines.push(`错误状态：${info.detectedErrorText}`)
  if (info.problems.length) lines.push(`驱动上报：${info.problems.join('、')}`)
  if (info.jobCount > 0) lines.push(`队列中还有 ${info.jobCount} 个任务`)
  if (info.portName) lines.push(`端口：${info.portName}`)
  lines.push('（驱动视角，可能滞后；实时纸张传感器需网口 9100 或串口回读）')
  return lines.join('\n')
}

function extractJson(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('PowerShell 没有返回 JSON')
  return JSON.parse(text.slice(start, end + 1))
}

/**
 * 读取 Windows 驱动状态。
 * 返回 { ok, supported, driver?, error? }。
 */
export function queryWindowsStatus(printer, options = {}) {
  const timeoutMs = options.timeoutMs || 6000
  const spawnImpl = options.spawnImpl || spawn
  const name = String(printer?.target || printer?.name || '').trim()
  if (!name) return Promise.resolve({ ok: false, supported: true, error: '没有填打印机名称' })

  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildStatusScript(name)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      return resolve({ ok: false, supported: true, error: `启动 PowerShell 失败：${error.message}` })
    }

    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
      finish({ ok: false, supported: true, error: `读取驱动状态超时（${timeoutMs}ms）` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ ok: false, supported: true, error: `启动 PowerShell 失败：${error.message}` }))
    child.on('close', (code) => {
      if (code !== 0) {
        return finish({ ok: false, supported: true, error: stderr.trim() || `PowerShell 退出码 ${code}` })
      }
      try {
        const driver = parseWindowsStatus(extractJson(stdout))
        finish({ ok: true, supported: true, driver })
      } catch (error) {
        finish({ ok: false, supported: true, error: error.message })
      }
    })
  })
}
