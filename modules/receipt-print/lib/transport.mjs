// 传输层：把 ESC/POS 字节送到打印机。
//   windows  Windows 打印队列（winspool.drv RAW 直通，USB 打印机走这里）
//   tcp      网口/WiFi 打印机，9100 RAW
//   cups     macOS / Linux 的 CUPS 队列（lp -o raw）
//   preview  不打印，只把版面回给聊天
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizePaperMm, normalizeEffectiveMm, DEFAULT_PAPER_MM } from './paper.mjs'
import { queryWindowsStatus } from './win-status.mjs'

export const TRANSPORTS = ['windows', 'tcp', 'cups', 'preview']

export const TRANSPORT_LABELS = {
  windows: 'Windows 打印队列（USB）',
  tcp: '网口 / WiFi（9100）',
  cups: 'macOS / Linux CUPS',
  preview: '只预览',
}

// 旧配置 width 是字符数，只有 32/48 才当作旧字段，避免把 32mm 这种自定义纸宽误读。
function legacyPaperMm(width) {
  const n = Number(width)
  if (n === 48) return 80
  if (n === 32) return 58
  return undefined
}

export function normalizePrinter(raw = {}, defaults = {}) {
  const transport = TRANSPORTS.includes(raw.transport) ? raw.transport : (defaults.transport || 'windows')
  const rawPaper = raw.paperWidthMm !== undefined
    ? raw.paperWidthMm
    : (raw.width !== undefined ? legacyPaperMm(raw.width) : undefined)
  const defaultPaper = defaults.paperWidthMm !== undefined
    ? defaults.paperWidthMm
    : (defaults.width !== undefined ? legacyPaperMm(defaults.width) : undefined)
  const paperMm = normalizePaperMm(rawPaper, normalizePaperMm(defaultPaper, DEFAULT_PAPER_MM))
  const rawEffective = Number(raw.effectiveWidthMm ?? defaults.effectiveWidthMm)
  return {
    name: String(raw.name || defaults.name || '打印机').trim(),
    transport,
    target: String(raw.target || defaults.target || '').trim(),
    port: Number(raw.port || defaults.port || 9100),
    paperWidthMm: paperMm,
    effectiveWidthMm: rawEffective > 0 ? normalizeEffectiveMm(rawEffective, paperMm) : 0,
    encoding: String(raw.encoding || defaults.encoding || 'gbk'),
    cut: String(raw.cut || defaults.cut || 'partial'),
    selfTestHex: String(raw.selfTestHex || defaults.selfTestHex || '').trim(),
  }
}

export function parseTcpTarget(printer) {
  const target = String(printer.target || '').trim()
  const match = target.match(/^(.*?):(\d{1,5})$/)
  const host = (match ? match[1] : target).replace(/^https?:\/\//, '')
  const port = Number(match ? match[2] : printer.port || 9100)
  return { host, port }
}

function tcpSend(printer, bytes, timeoutMs, connectImpl) {
  return new Promise((resolve) => {
    const { host, port } = parseTcpTarget(printer)
    if (!host) return resolve({ ok: false, error: '没有填打印机 IP' })
    let socket
    try {
      socket = connectImpl({ host, port })
    } catch (error) {
      return resolve({ ok: false, error: `连接失败：${error.message}` })
    }
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* 已经关了 */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `连接超时（${host}:${port}）` }), timeoutMs)
    socket.on('connect', () => {
      socket.write(bytes, () => socket.end())
    })
    socket.on('close', () => finish({ ok: true }))
    socket.on('error', (error) => finish({ ok: false, error: `连接失败：${error.message}` }))
  })
}

// DLE EOT 1..4：打印机状态 / 脱机状态 / 错误状态 / 纸张传感器
export function statusQueryBytes(types = [1, 2, 3, 4]) {
  return Buffer.concat(types.map((type) => Buffer.from([0x10, 0x04, type])))
}

/**
 * 查询打印机状态。
 *   windows  读驱动通过 Bidi 上报的状态（离线/缺纸/卡纸/开盖），属驱动视角
 *   tcp      9100 双向回读，能拿到实时传感器状态
 *   cups     只能单向发送
 * 返回 { ok, supported, driver?, bytes?, error? }，字节解码交给调用方。
 */
export function queryStatus(printer, options = {}) {
  const timeoutMs = options.timeoutMs || 3000
  const waitMs = options.waitMs || 600
  const connectImpl = options.connectImpl || connect
  if (!printer) return Promise.resolve({ ok: false, supported: false, error: '还没配置打印机' })
  if (printer.transport === 'preview') {
    return Promise.resolve({ ok: false, supported: false, error: '预览模式没有真实设备，读不到状态' })
  }
  if (printer.transport === 'windows') {
    return queryWindowsStatus(printer, {
      timeoutMs: Math.max(timeoutMs, 6000),
      spawnImpl: options.spawnImpl,
    })
  }
  return new Promise((resolve) => {
    if (printer.transport !== 'tcp') {
      return resolve({
        ok: false,
        supported: false,
        error: `${TRANSPORT_LABELS[printer.transport] || printer.transport}只能发送、不能读取，状态查询需要网口 9100 直连或串口`,
      })
    }
    const { host, port } = parseTcpTarget(printer)
    if (!host) return resolve({ ok: false, supported: false, error: '没有填打印机 IP' })

    let socket
    try {
      socket = connectImpl({ host, port })
    } catch (error) {
      return resolve({ ok: false, supported: true, error: `连接失败：${error.message}` })
    }

    const chunks = []
    let done = false
    let readTimer = null
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(connectTimer)
      if (readTimer) clearTimeout(readTimer)
      try { socket.destroy() } catch { /* 已经关了 */ }
      resolve(result)
    }
    const connectTimer = setTimeout(
      () => finish({ ok: false, supported: true, error: `连接超时（${host}:${port}）` }),
      timeoutMs,
    )

    socket.on('connect', () => {
      socket.write(statusQueryBytes())
      readTimer = setTimeout(
        () => finish({ ok: true, supported: true, bytes: Buffer.concat(chunks) }),
        Math.max(200, waitMs),
      )
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', (error) => finish({ ok: false, supported: true, error: `连接失败：${error.message}` }))
    socket.on('close', () => finish({ ok: true, supported: true, bytes: Buffer.concat(chunks) }))
  })
}

function cupsSend(printer, bytes, timeoutMs, spawnImpl) {
  return new Promise((resolve) => {
    if (!printer.target) return resolve({ ok: false, error: '没有填 CUPS 队列名' })
    let child
    try {
      child = spawnImpl('lp', ['-d', printer.target, '-o', 'raw', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (error) {
      return resolve({ ok: false, error: `启动 lp 失败：${error.message}` })
    }
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
      finish({ ok: false, error: 'lp 超时' })
    }, timeoutMs)
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ ok: false, error: `启动 lp 失败：${error.message}` }))
    child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `lp 退出码 ${code}` }))
    try { child.stdin.end(bytes) } catch { /* 子进程可能已经退出 */ }
  })
}

export const WINDOWS_SCRIPT = `param([Parameter(Mandatory=$true)][string]$PrinterName, [Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class AuraRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

  [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static bool Send(string printerName, string fileName) {
    byte[] bytes = File.ReadAllBytes(fileName);
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "Aurabot Receipt";
    di.pDataType = "RAW";
    bool ok = false;
    if (StartDocPrinter(hPrinter, 1, di)) {
      if (StartPagePrinter(hPrinter)) {
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, p, bytes.Length);
        int written = 0;
        ok = WritePrinter(hPrinter, p, bytes.Length, out written);
        Marshal.FreeCoTaskMem(p);
        EndPagePrinter(hPrinter);
      }
      EndDocPrinter(hPrinter);
    }
    ClosePrinter(hPrinter);
    return ok;
  }
}
'@
if (-not [AuraRawPrinter]::Send($PrinterName, $FilePath)) {
  throw ("WritePrinter failed: " + $PrinterName)
}
`

export function windowsArgs(scriptPath, printerName, filePath) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PrinterName', printerName, '-FilePath', filePath]
}

// Windows 首次打印要用 Add-Type 现编译 C# 辅助类，冷启动 8 秒经常不够，给足 30 秒
export const WINDOWS_TIMEOUT_MS = 30000

function formatTimeout(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms}ms`
}

// 文件被杀毒软件或上一次调用占用时，PowerShell 读不到脚本，报的就是这一类
const LOCKED_RE = /being used by another process|another process|cannot access the file|无法访问(此|该)文件|正在被另一(个)?进程使用/i

async function spawnPowershell(command, args, timeoutMs, spawnImpl) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      return resolve({ ok: false, error: error.message })
    }
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
      finish({ ok: false, error: `调用 PowerShell 超时（${formatTimeout(timeoutMs)}）` })
    }, timeoutMs)
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `PowerShell 退出码 ${code}` }))
  })
}

async function windowsSend(printer, bytes, timeoutMs, { dataDir, spawnImpl, platform }) {
  if (platform !== 'win32') return { ok: false, error: '当前系统不是 Windows，USB 打印队列不可用' }
  if (!printer.target) return { ok: false, error: '没有填打印机队列名（在「设备和打印机」里看）' }
  if (!dataDir) return { ok: false, error: '缺少模块数据目录' }
  // 每次用独立文件名：固定 raw-print.ps1 会被杀毒软件/上一次调用锁住，PowerShell 读不到就报「被另一进程使用」
  const tag = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const filePath = join(dataDir, `job-${tag}.bin`)
  let scriptPath = join(dataDir, `raw-print-${tag}.ps1`)
  await writeFile(filePath, bytes)
  const run = async () => {
    await writeFile(scriptPath, '\uFEFF' + WINDOWS_SCRIPT, 'utf8')
    const args = windowsArgs(scriptPath, printer.target, filePath)
    let result = await spawnPowershell('powershell.exe', args, timeoutMs, spawnImpl)
    // 有些机器只装了 PowerShell 7
    if (!result.ok && /ENOENT|not found|找不到/i.test(result.error || '')) {
      result = await spawnPowershell('pwsh', args, timeoutMs, spawnImpl)
    }
    return result
  }
  try {
    let result = await run()
    // 文件刚落地就被扫描锁住时，换一个文件名再试一次
    if (!result.ok && LOCKED_RE.test(result.error || '')) {
      await unlink(scriptPath).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 150))
      scriptPath = join(dataDir, `raw-print-${tag}-retry.ps1`)
      result = await run()
    }
    // 脚本里只留 ASCII，报错信息在这里翻回中文，避免中文 Windows 的代码页把脚本解析坏
    if (!result.ok && /WritePrinter failed/i.test(result.error || '')) {
      result = { ok: false, error: `写打印机失败：${printer.target}` }
    }
    return result
  } finally {
    unlink(filePath).catch(() => {})
    unlink(scriptPath).catch(() => {})
  }
}

/**
 * 发送字节。返回 { ok, error?, preview? }。
 * 测试时可以注入 connectImpl / spawnImpl / platform。
 */
export async function sendBytes(printer, bytes, options = {}) {
  const timeoutMs = Number(options.timeoutMs || (printer.transport === 'windows' ? WINDOWS_TIMEOUT_MS : 8000))
  const connectImpl = options.connectImpl || connect
  const spawnImpl = options.spawnImpl || spawn
  const platform = options.platform || process.platform
  if (printer.transport === 'preview') return { ok: true, preview: true }
  if (printer.transport === 'tcp') return tcpSend(printer, bytes, timeoutMs, connectImpl)
  if (printer.transport === 'cups') return cupsSend(printer, bytes, timeoutMs, spawnImpl)
  if (printer.transport === 'windows') {
    return windowsSend(printer, bytes, timeoutMs, { dataDir: options.dataDir, spawnImpl, platform })
  }
  return { ok: false, error: `不认识的传输方式：${printer.transport}` }
}
