// ps.mjs —— windows-ops 模块的 PowerShell 执行底座
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）
// 作用：统一封装「起一个 powershell.exe 跑一段脚本」：
//       - 用 -EncodedCommand（UTF-16LE base64）传脚本，彻底绕开引号/换行的命令行转义坑；
//       - 用户字符串一律不直接拼进脚本，经 b64arg() 转成 UTF-8 base64，
//         再由脚本里的 $a 数组解码——注入的任何引号/分号都只是解码后的普通字符；
//       - 固定 -NoProfile -NonInteractive -STA（STA 是剪贴板 / SendKeys 的硬要求）。
// 契约：export function createPs({ exe?, timeoutMs?, run? })
//   → { run(script, { timeoutMs? }) → Promise<string stdout>,
//       b64arg(str) → string, isWin() → boolean, exe: string }
//   run 可注入（测试不打真 PowerShell）。

import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** 用户字符串 → UTF-8 base64（脚本里再解码，防注入）。 */
export function b64arg(str) {
  return Buffer.from(String(str ?? ''), 'utf8').toString('base64')
}

/** 脚本 → 命令行安全形态（-EncodedCommand 要求 UTF-16LE base64）。 */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/** System32 绝对路径优先：宿主环境的 PATH 常被裁剪，相对名可能找不到。 */
export function defaultPowershellPath() {
  if (process.platform !== 'win32') return 'powershell.exe'
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 创建 PowerShell 执行器。
 * @param {{exe?: string, timeoutMs?: number, run?: Function}} o
 *   exe：powershell.exe 路径（默认 System32 绝对路径）；
 *   timeoutMs：单次脚本超时（默认 15000）；
 *   run：注入自定义执行函数（签名同真实 run，测试用）。
 */
export function createPs({ exe = '', timeoutMs = 15000, run } = {}) {
  const psExe = exe || defaultPowershellPath()
  /** 非 Windows 直接报可读错误，不悄悄失败。 */
  const isWin = () => process.platform === 'win32'
  /** 真实执行：-EncodedCommand 一次传整段脚本。 */
  const realRun = (script, opts = {}) =>
    new Promise((resolve, reject) => {
      const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)]
      execFile(psExe, args, { timeout: opts.timeoutMs || timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || '').trim().slice(0, 300)
          reject(new Error(`PowerShell 执行失败（${err.message.slice(0, 120)}）${detail ? '：' + detail : ''}`))
        } else resolve(String(stdout ?? ''))
      })
    })
  return {
    exe: psExe,
    isWin,
    b64arg,
    run: run || realRun,
  }
}
