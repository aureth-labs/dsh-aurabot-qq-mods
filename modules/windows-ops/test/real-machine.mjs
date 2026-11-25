// real-machine.mjs —— windows-ops 真机三层测试的第二层：真机实测脚本（手跑，不进单测）
// 来源：aurabot 模块库 modules/windows-ops（MIT）
// 用法：node modules/windows-ops/test/real-machine.mjs   （在 mods-fork 目录下跑）
//
// 安全边界（铁律，写脚本前先读）：
//   · 只对脚本自己 spawn 的记事本窗口做键鼠/激活/关窗操作——先 window.list 认准 pid 再动；
//   · 绝不碰/不关少爷的其他窗口；结束兜底 taskkill 只杀本脚本 spawn 的 pid；
//   · 所有动作走模块真路径 exec() 闸门：危险项真实进入确认队列，用导出的 confirm.approve 真批一次；
//   · 数据落临时目录（mkdtemp），截图在 <dataDir>/shots/ 下，跑完保留供人工核对。
//
// 脚本搭一个最小 fake api（settings 存内存、rule/tool/command/route 收集不执行），
// 跑真 createPs → 真 PowerShell → 真键鼠。逐项打印结果表，任何一步失败退出码非 0。

import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dataDir = mkdtempSync(join(tmpdir(), 'wops-real-'))

// ---- 最小 fake api：settings 存内存（可动态改），其他注册面收集即可 ----
const settings = {
  enabled: true, allowInput: true, confirmDanger: true,
  dryRun: false, rateLimit: 0, opsWhitelist: '', powershellPath: '',
}
const api = {
  settings: () => ({ ...settings }),
  dataDir: (sub) => (sub ? join(dataDir, sub) : dataDir),
  rule: () => {},
  tool: () => {},
  command: () => {},
  route: () => {},
  onDispose: () => {},
  log: { info: (t) => console.log('  [log]', t), warn: (t) => console.log('  [warn]', t), error: (t) => console.log('  [error]', t) },
}
const wops = mod.setup(api)

const results = []
/** 跑一项并记表；危险操作自动走「首跑入队 → 真批准 → 复跑放行」的真实路径。 */
async function step(name, op, args, { expect = 'ok', gate = true } = {}) {
  let r = await wops.exec(op, args)
  let confirmPath = ''
  if (gate && r.confirmId) {
    // 真实批准一次（一次性放行），再复跑
    const okApprove = wops.confirm.approve(r.confirmId)
    confirmPath = `入队(${r.confirmId.slice(-6)})→批准=${okApprove}→复跑`
    r = await wops.exec(op, args)
  }
  const pass = expect === 'ok' ? r.ok === true : expect === 'reject' ? r.ok === false : true
  results.push({ name, pass, detail: `${confirmPath}${confirmPath ? ' ' : ''}${r.message}${r.data != null ? ` | data=${String(r.data).slice(0, 60)}` : ''}` })
  console.log(`${pass ? '✓' : '✗'} ${name}：${results.at(-1).detail}`)
  return r
}

let notepadPid = 0
try {
  console.log('== 真机实测（数据目录：' + dataDir + '）==\n')

  // ---- 闸门安全路径先验：试运行 / 白名单拒绝（不真动）----
  settings.dryRun = true
  await step('闸门·试运行拦下键鼠动作', 'mouse.click', { x: 10, y: 10 }, { expect: 'ok', gate: false })
  settings.dryRun = false
  settings.opsWhitelist = 'window.list'
  const rej = await step('闸门·白名单拒绝', 'clipboard.write', { text: 'x' }, { expect: 'reject', gate: false })
  settings.opsWhitelist = ''
  if (!rej.ok && !/白名单/.test(rej.message)) throw new Error('白名单拒绝原因不对：' + rej.message)

  // ---- 剪贴板：写 → 读回核对 ----
  const clip = 'wops-real-' + Date.now()
  await step('剪贴板·写入', 'clipboard.write', { text: clip })
  const read = await step('剪贴板·读回核对', 'clipboard.read', {})
  if (read.data !== clip) throw new Error(`剪贴板回读不一致：写了 ${clip}，读到 ${JSON.stringify(read.data)}`)
  await step('剪贴板·回读一致', 'clipboard.read', {})

  // ---- 截屏：落 dataDir/shots，尺寸 > 0 ----
  const shot = await step('截屏·全屏落盘', 'screenshot', {})
  const file = String(shot.data || '')
  const size = statSync(file).size
  if (size <= 0) throw new Error('截图文件 0 字节：' + file)
  console.log(`  截图文件：${file}（${size} 字节）`)

  // ---- 窗口枚举：真实桌面 ----
  const list = await step('窗口·枚举真实窗口', 'window.list', {})
  const count = (list.data || []).length
  if (count <= 0) throw new Error('一个有主窗口的进程都没枚举到')
  console.log(`  枚举到 ${count} 个有主窗口的进程`)

  // ---- 起测试专用记事本（唯一被键鼠/激活/关窗触碰的窗口）----
  const np = spawn('notepad.exe', [], { detached: false })
  notepadPid = np.pid
  await sleep(2500)
  const list2 = await wops.exec('window.list')
  const target = (list2.data || []).find((w) => /notepad/i.test(w.name) && String(w.pid) === String(notepadPid))
  if (!target) throw new Error(`没在窗口列表里找到测试记事本 pid=${notepadPid}，中止（不碰任何其他窗口）`)
  console.log(`  测试记事本：pid ${target.pid}「${target.title}」`)

  // 把记事本挪到已知位置，之后键鼠只打这个矩形里的点
  await ps(`Add-Type -Namespace T -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hh,bool r);'
$p=Get-Process -Id ${notepadPid}
[T.W]::MoveWindow($p.MainWindowHandle,100,100,600,400,$true)`)

  // ---- 激活（危险类：真实入队 → 批准 → 放行）----
  await step('窗口·激活测试记事本', 'window.activate', { pid: Number(target.pid) })

  // ---- 前台核对防线：键入前必须验证前台窗口=测试记事本，不一致就再激活+重试，仍不一致就中止。
  //      真机教训（2026-11-06）：SetForegroundWindow 可能被系统拒绝，SendKeys 会打进「当时的真前台」——
  //      盲打等于把测试文字泼到少爷的窗口里，绝不允许。 ----
  async function foregroundPid() {
    const out = await ps(`Add-Type -Namespace T -Name F -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
$p=Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq [T.F]::GetForegroundWindow() }
if($p){ $p.Id } else { 0 }`)
    return Number(out.trim())
  }
  let fg = await foregroundPid()
  for (let i = 0; fg !== notepadPid && i < 3; i++) {
    console.log(`  前台不是测试记事本（当前 pid ${fg}），再激活一次…`)
    await ps(`Add-Type -Namespace T -Name S -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);'
$p=Get-Process -Id ${notepadPid}
[T.S]::ShowWindow($p.MainWindowHandle,6) | Out-Null
Start-Sleep -Milliseconds 150
[T.S]::ShowWindow($p.MainWindowHandle,9) | Out-Null
[T.S]::SetForegroundWindow($p.MainWindowHandle) | Out-Null`)
    await sleep(400)
    fg = await foregroundPid()
  }
  if (fg !== notepadPid) throw new Error(`前台窗口始终不是测试记事本（pid ${fg}≠${notepadPid}），为不误伤其他窗口，跳过键鼠键入项`)
  console.log(`  前台核对通过：前台 pid ${fg} = 测试记事本`)

  // ---- 鼠标：移动 + 点击都落在 (400, 300)（已挪好的记事本编辑区内）----
  await step('鼠标·移动到记事本内', 'mouse.move', { x: 400, y: 300 })
  await step('鼠标·点击记事本内', 'mouse.click', { x: 400, y: 300 })
  if ((await foregroundPid()) !== notepadPid) {
    const ev = await wops.exec('screenshot', {})
    throw new Error('点击后前台变了，中止键入（证据截图：' + (ev.data || '无') + '）')
  }

  // ---- 键盘：键入文字 + 按键（前台已核实是测试记事本）----
  const typed = 'hello wops real test'
  await step('键盘·键入文字', 'key.text', { text: typed })
  await step('键盘·按回车', 'key.press', { key: 'enter' })

  // ---- 键入/粘贴的内容核对（两条独立证据，不依赖 UIA：Win11 新记事本 UIA/WM_GETTEXT 都读不到内容）----
  // 证据①：dirty 信号——有关闭后不退 = 有未保存内容（空文档 WM_CLOSE 会直接退）；
  // 证据②：键入后截图（含逐字粘贴 token），由执行 agent 用 read_image 人工核对并在回报里贴结论。
  if ((await foregroundPid()) !== notepadPid) {
    const ev2 = await wops.exec('screenshot', {})
    throw new Error('粘贴前前台变了，中止（证据截图：' + (ev2.data || '无') + '）')
  }
  const pasteText = 'wops-paste-' + Date.now()
  await step('剪贴板·写入待粘贴文本', 'clipboard.write', { text: pasteText })
  await step('键盘·粘贴到记事本', 'paste', {})

  // ---- 再截一张：取证截图（粘贴 token 逐字可见，供 read_image 核对）----
  const shot2 = await step('截屏·键入后取证', 'screenshot', {})
  const size2 = statSync(String(shot2.data)).size
  if (size2 <= 0) throw new Error('第二张截图 0 字节')
  console.log(`  键入后截图：${shot2.data}（${size2} 字节）——read_image 核对「${typed}」（可能被输入法改写）与「${pasteText}」（须逐字一致）`)

  // ---- 关窗口（最危险类：真实入队 → 批准 → 放行）；dirty 信号 = 关不掉（弹保存询问） ----
  await step('窗口·关闭测试记事本', 'window.close', { pid: Number(target.pid) })
  let exited = false
  for (let i = 0; i < 6; i++) { await sleep(500); exited = np.exitCode !== null || (() => { try { process.kill(notepadPid, 0); return false } catch { return true } })(); if (exited) break }
  const dirty = !exited // 没直接退 = 有未保存内容 = 键入/粘贴确实落进了记事本
  results.push({ name: '核对·键入与粘贴落进记事本（dirty 信号）', pass: dirty, detail: dirty ? `窗口关闭后仍在（保存询问）= 内容非空；精确 token 见截图 ${shot2.data}` : '关闭后直接退出了 = 文档是空的，键入/粘贴都没落进去' })
  console.log(`${dirty ? '✓' : '✗'} 核对·键入与粘贴落进记事本（dirty 信号）`)
  if (!exited) {
    console.log('  兜底 taskkill 只杀本脚本自开的 pid')
    await new Promise((r) => execFile('taskkill', ['/PID', String(notepadPid), '/T', '/F'], () => r()))
    await sleep(500)
  }
  const still = await wops.exec('window.list')
  const leftover = (still.data || []).find((w) => String(w.pid) === String(notepadPid))
  results.push({ name: '收尾·测试记事本已清理', pass: !leftover, detail: leftover ? '还在！' : '已退出窗口列表' })
  console.log(`${!leftover ? '✓' : '✗'} 收尾·测试记事本已清理`)

  // ---- 汇总 ----
  const bad = results.filter((r) => !r.pass)
  console.log(`\n== 汇总：${results.length - bad.length}/${results.length} 项通过 ==`)
  if (bad.length) { for (const b of bad) console.log('✗ ' + b.name + '：' + b.detail); process.exit(1) }
} catch (e) {
  console.error('\n✗ 真机脚本中止：' + e.message)
  if (notepadPid) { try { execFile('taskkill', ['/PID', String(notepadPid), '/T', '/F'], () => {}) } catch { /* 兜底清理 */ } }
  process.exit(1)
}

/** 读测试记事本文本：Win11 新记事本没有子 Edit 控件（WM_GETTEXT 读不到），改走 UIA 全树找 TextPattern。 */
function readNotepadText(pid) {
  return ps(`$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$p=Get-Process -Id ${pid} -ErrorAction Stop
$root=[System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$best=''
foreach($el in $all){
  try{
    $tp=$el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $t=$tp.DocumentRange.GetText(1000)
    if($t -and $t.Length -gt $best.Length){ $best=$t }
  } catch { continue }
}
$best`)
}

/** 跑一段定位用的 PowerShell（只碰测试记事本的窗口）。 */
function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`定位脚本失败：${err.message} ${String(stderr).slice(0, 200)}`))
        else resolve(String(stdout))
      })
  })
}
