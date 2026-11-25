// 游戏窗口的显隐：启动时藏起来，需要的时候从面板点出来。
// 只调 user32 的两个函数（ShowWindow / SetForegroundWindow），不注入、不 hook 游戏。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exeName } from './exe.mjs'

// SW_HIDE = 0, SW_RESTORE = 9
// SW_SHOW(5) 和 SW_SHOWNORMAL(1) 都试过：从 node 的 execFileSync 调起时对隐藏的 Godot
// 窗口无效（同一份脚本手敲 powershell 跑却能成功），只有 SW_RESTORE 能把窗口叫回来。
const SW = { hide: 0, show: 9 }

// 按 pid 找顶层窗口：隐藏的窗口枚举得到（EnumWindows 不看可见性），所以藏起来之后还能找回来。
const TYPE = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class CabinWin {',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  public static IntPtr Find(uint pid) {',
  '    IntPtr found = IntPtr.Zero;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      uint p; GetWindowThreadProcessId(h, out p);',
  '      if (p == pid) { found = h; return false; }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return found;',
  '  }',
  '}',
  "'@",
].join('\n')

// 走临时 .ps1 + -File：-Command 传多行 here-string 会被 PowerShell 解析错
// （表现是 ShowWindow 调了、IsWindowVisible 却还是旧值，实测踩过）；
// -EncodedCommand 又会把 progress 流按 CLIXML 吐进 stdout，同样污染结果。
function ps(body) {
  // 私有临时目录：mkdtempSync 保证目录名随机且只归当前进程，
  // 不再是可预测的 tmpdir/cabin-win-<pid>-<ts>.ps1。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabinwin-'))
  const file = path.join(dir, 'win.ps1')
  fs.writeFileSync(file, TYPE + '\r\n' + body, 'utf8')
  try {
    // 不能加 -NonInteractive：带上它，ShowWindow/SetForegroundWindow 会静默失败
    // （脚本一模一样，手动跑 ok:True，从 node 调用就 ok:False，实测）。
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录已经不在了 */ }
  }
}

function processName(gameDir) {
  return String(exeName(gameDir) || 'CabinWorld.exe').replace(/[.]exe$/i, '').replace(/[^\w.-]/g, '')
}

/** mode: 'hide' 藏起来（连任务栏一起），'show' 显示并置前。 */
export function setGameWindow(gameDir, mode) {
  const want = SW[mode]
  if (want === undefined) return { ok: false, message: '未知的窗口操作：' + String(mode) }
  try {
    const out = ps([
      "$p = Get-Process -Name '" + processName(gameDir) + "' -ErrorAction SilentlyContinue | Select-Object -First 1",
      "if (-not $p) { Write-Output 'no-game'; return }",
      '$h = [CabinWin]::Find([uint32]$p.Id)',
      "if ($h -eq [IntPtr]::Zero) { Write-Output 'no-window'; return }",
      '[CabinWin]::ShowWindow($h, ' + want + ') | Out-Null',
      // 不调 SetForegroundWindow：从被 windowsHide 的进程里调它会把 ShowWindow 的效果吞掉。
      // ShowWindow 是异步落定的，立刻查 IsWindowVisible 会拿到旧值。
      'Start-Sleep -Milliseconds 500',
      "$visible = [CabinWin]::IsWindowVisible($h)",
      "Write-Output ('ok:' + $visible)",
    ].filter(Boolean).join('\n'))
    const text = String(out).trim().split(/\s+/).pop()
    if (text === 'no-game') return { ok: false, message: '游戏没在运行' }
    if (text === 'no-window') return { ok: false, message: '找不到游戏窗口（可能刚启动还在加载）' }
    if (text.startsWith('ok:')) {
      const visible = text.slice(3) === 'True'
      return { ok: true, visible, message: visible ? '游戏窗口已经显示出来' : '游戏窗口已隐藏' }
    }
    return { ok: false, message: '没拿到窗口句柄：' + text.slice(0, 120) }
  } catch (error) {
    return { ok: false, message: '调用窗口接口失败：' + (error && error.message ? error.message : String(error)) }
  }
}

/** 启动游戏后它要过一会儿才有窗口，轮询到出现再藏。 */
export async function hideGameWindow(gameDir, tries = 40, gapMs = 500) {
  const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); })
  for (let i = 0; i < tries; i++) {
    await sleep(gapMs)
    const r = setGameWindow(gameDir, 'hide')
    if (r.ok) return r
  }
  return { ok: false, message: '等了 ' + Math.round(tries * gapMs / 1000) + ' 秒也没等到游戏窗口' }
}
