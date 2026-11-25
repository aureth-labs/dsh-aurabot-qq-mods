// real-uia.mjs —— windows-ops 的 UIA（无障碍树）真机实测脚本（手跑，不进单测通配）
// 来源：aurabot 模块库 modules/windows-ops（MIT）
// 用法：node modules/windows-ops/test/real-uia.mjs   （在仓库根目录下跑；Windows only）
//
// 安全边界（铁律，与 real-machine.mjs 一致）：
//   · 只对脚本自己 spawn 的窗口做 UIA 操作——先 window.list 认准 pid 再动；
//   · 绝不碰少爷的其他窗口；收尾 taskkill 只杀本脚本 spawn 的 pid；
//   · 所有动作走模块真路径 exec() 闸门（input 类真实入队 → 用导出的 confirm.approve 真批一次）。
//
// 为什么用「自开 WPF 宿主」当主验证对象（真机踩坑记录，2026-11-06）：
//   本机经典记事本（Win11 新版同理）的编辑区在 UIA 里是 ControlType=Pane / ClassName=Edit，
//   且 Value/Text/Invoke pattern 一个都不支持（Win32 Edit 经 MSAA 代理的固有表现）；
//   WinForms 控件在本机也呈现为 Pane、无 pattern。拿它们验证 setValue/getText 只会得到
//   「该控件不支持 ValuePattern」——那是宿主限制，不是模块 bug。
//   所以主验证对象改成 WPF 窗体：它自带完整 UIA provider（Edit=Value/Text、Button=Invoke、
//   CheckBox=Toggle、AutomationId 可当选择器），正好逐条覆盖 5 个操作的每个分支。
//   记事本仍作为「真实第三方程序」的补充项：验证 uia.tree 能读真实程序，并如实记录
//   Win32 经典控件的 pattern 缺失（这本身也是给 AI 的使用提示）。
//
// 验证项（逐项打印 ✓/✗，任一失败退出码非 0）：
//   1 uia.tree 读树非空、含 Edit/Document 类元素，能拿到 AutomationId/Name/ClassName/bounds
//   2 uia.setValue 用 ValuePattern 写中文（绕开输入法）
//   3 uia.getText 读回与写入逐字一致   ← 本轮改造的核心价值
//   4 uia.click 点 Button 走 InvokePattern 分支，点 Text 走坐标兜底分支（两条都验）
//   5 选择器 Name 前缀匹配命中（前缀≠全名，证明不是全等）
//   6 找不到元素返回 { ok:false, message 含「没找到」} 且不 throw
//   7 窗口挪动后同一选择器仍能定位   ← 本轮立意：按元素找，不依赖坐标
//   8 uia.invoke 依次尝试 Toggle/SelectionItem/ExpandCollapse（CheckBox 走 Toggle 分支，ToggleState 作独立证据）
//   9 补充：真实程序（记事本）也能读树；Win32 经典控件无 pattern 时如实报错不崩

import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dataDir = mkdtempSync(join(tmpdir(), 'wops-real-uia-'))
const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

// ---- 最小 fake api：settings 存内存（可动态改），其他注册面收下不执行 ----
const settings = {
  enabled: true, allowInput: true, confirmDanger: true,
  dryRun: false, rateLimit: 0, opsWhitelist: '', powershellPath: '', preferUia: true,
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
/** 记一项结果并打印（detail 是实测输出原文摘要）。 */
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}：${detail}`)
  return pass
}

/** 走 exec 闸门执一个操作；input 类首跑入队 → 真批准 → 复跑放行（同 real-machine 手法）。 */
async function execGated(op, args) {
  let r = await wops.exec(op, args)
  let confirmPath = ''
  if (r.confirmId) {
    const okApprove = wops.confirm.approve(r.confirmId)
    confirmPath = `入队(${String(r.confirmId).slice(-6)})→批准=${okApprove}→复跑`
    r = await wops.exec(op, args)
  }
  return { r, confirmPath }
}

/** 跑一段定位用 PowerShell（只碰自开窗口）。用 -Command 传脚本，免去 .ps1 的 BOM 编码坑。 */
function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(psExe, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`定位脚本失败：${err.message} ${String(stderr).slice(0, 300)}`))
        else resolve(String(stdout))
      })
  })
}

/** 把自开窗口挪到指定位置（MoveWindow 只作用于本脚本握着的 pid 的 MainWindowHandle）。 */
function moveWindow(pid, x, y, w = 640, h = 460) {
  return ps(`Add-Type -Namespace T -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hh,bool r);'
$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop
[T.W]::MoveWindow($p.MainWindowHandle,${Number(x)},${Number(y)},${Number(w)},${Number(h)},$true)`)
}

/** 从 window.list 里认准自开进程的窗口（找不到就中止，绝不退而求其次去点别的窗口）。 */
async function pickOwnWindow(pid) {
  const list = await wops.exec('window.list')
  return (list.data || []).find((w) => String(w.pid) === String(pid)) || null
}

/** 直接读某元素的 ToggleState（Off/On/Indeterminate）——给 uia.invoke 提供不依赖宿主回写的独立证据。 */
function toggleStateOf(pid, automationId) {
  return ps(`$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop
$root=[System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$el=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'${String(automationId).replace(/'/g, '')}')))
if($null -eq $el){ Write-Output 'NOT_FOUND'; exit 0 }
$tp=$el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
Write-Output ([string]$tp.Current.ToggleState)`).then((s) => s.trim())
}

// ============ 自开 WPF 验证宿主 ============
// 用 WPF 而不是 WinForms：WPF 自带完整 UIA provider（本机实测 Edit=Value/Text、Button=Invoke、
// CheckBox=Toggle），WinForms 控件在本机只暴露成 Pane 且无 pattern，验不了这些分支。
const HOST_XAML = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="wops-uia-host" Height="460" Width="640" Left="150" Top="150"
        WindowStartupLocation="Manual">
  <Grid Margin="20">
    <Grid.RowDefinitions>
      <RowDefinition Height="80"/><RowDefinition Height="60"/><RowDefinition Height="40"/>
      <RowDefinition Height="40"/><RowDefinition Height="*"/>
    </Grid.RowDefinitions>
    <TextBox x:Name="probeInput" AutomationProperties.AutomationId="probeInput"
             AutomationProperties.Name="备注输入框" Grid.Row="0" AcceptsReturn="True"
             VerticalContentAlignment="Top" TextWrapping="Wrap"/>
    <Button x:Name="probeButton" AutomationProperties.AutomationId="probeButton"
            Content="提交" Height="40" Width="140" HorizontalAlignment="Left" Grid.Row="1"/>
    <CheckBox x:Name="probeCheck" AutomationProperties.AutomationId="probeCheck"
              Content="同意条款" Height="30" Grid.Row="2"/>
    <TextBlock x:Name="probeStatus" AutomationProperties.AutomationId="probeStatus"
               Text="就绪" Grid.Row="3" VerticalAlignment="Top"/>
    <TextBlock x:Name="probeResult" AutomationProperties.AutomationId="probeResult"
               Text="" Grid.Row="4" VerticalAlignment="Top"/>
  </Grid>
</Window>`

/** 宿主脚本：点按钮把结果回写到 probeResult，供脚本核对「点击真的生效了」。 */
const HOST_PS = `Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$xaml = @"
${HOST_XAML}
"@
$w = [System.Windows.Markup.XamlReader]::Parse($xaml)
$btn = $w.FindName('probeButton')
$chk = $w.FindName('probeCheck')
$res = $w.FindName('probeResult')
$btn.Add_Click({ $res.Text = 'clicked' })
$chk.Add_Checked({ $res.Text = 'checked' })
$null = $w.ShowDialog()`

let hostPid = 0
let notepadPid = 0
try {
  console.log('== UIA 真机实测（数据目录：' + dataDir + '）==')
  console.log('   主验证宿主：自开 WPF 窗体（完整 UIA provider）\n')

  // ---- 起 WPF 宿主 ----
  // 注意：PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解析，中文字符串会把语法读坏 → 写 BOM
  const hostFile = join(dataDir, 'host.ps1')
  writeFileSync(hostFile, '\uFEFF' + HOST_PS, 'utf8')
  const hostChild = spawn(psExe, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', hostFile], { detached: false })
  hostPid = hostChild.pid
  await sleep(4000)
  if (hostChild.exitCode !== null) throw new Error(`WPF 宿主秒退（exitCode=${hostChild.exitCode}），无法验证`)
  const hostWin = await pickOwnWindow(hostPid)
  if (!hostWin) throw new Error(`没在窗口列表里找到自开 WPF 宿主 pid=${hostPid}，中止（不碰任何其他窗口）`)
  console.log(`  宿主窗口：pid ${hostWin.pid}「${hostWin.title}」`)
  const pid = Number(hostWin.pid)
  await moveWindow(pid, 120, 120)
  await sleep(700)

  // ================= 1. uia.tree =================
  const tree1 = await wops.exec('uia.tree', { pid })
  const items = Array.isArray(tree1.data) ? tree1.data : []
  console.log('\n  ---- uia.tree 实测输出原文 ----')
  for (const line of String(tree1.message || '').split('\n')) console.log('  ' + line)
  const editable = items.filter((e) => /^(Edit|Document)$/i.test(e.controlType))
  const inputEl = items.find((e) => e.automationId === 'probeInput') || editable[0] || null
  const buttonEl = items.find((e) => e.automationId === 'probeButton') || items.find((e) => /^Button$/i.test(e.controlType)) || null
  const checkEl = items.find((e) => e.automationId === 'probeCheck') || items.find((e) => /^CheckBox$/i.test(e.controlType)) || null
  record('1 uia.tree 读树非空', tree1.ok === true && items.length > 0, `${items.length} 个元素（ok=${tree1.ok}）`)
  record(
    '1 uia.tree 含 Edit/Document 元素 + 四要素齐全',
    editable.length > 0 && !!inputEl && !!inputEl.automationId && !!inputEl.className && inputEl.bounds.w > 0,
    inputEl
      ? `Edit 元素：index=${inputEl.index} controlType=${inputEl.controlType} name=${inputEl.name} automationId=${inputEl.automationId} className=${inputEl.className} bounds=(${inputEl.bounds.x},${inputEl.bounds.y},${inputEl.bounds.w}×${inputEl.bounds.h})`
      : '没读到 Edit/Document 元素：' + items.map((e) => e.controlType).join(','),
  )
  if (!inputEl) throw new Error('宿主没有可编辑元素，无法验证 setValue/getText（不碰其他窗口）')

  // ================= 2/3. uia.setValue 写中文 → getText 读回（核心价值）=================
  const MARK = '阿芷测试-中文不被输入法吞-2026'
  const setIn = await execGated('uia.setValue', { pid, sel: `AutomationId=${inputEl.automationId}`, text: MARK })
  record(
    '2 uia.setValue 写中文（ValuePattern，绕开输入法）',
    setIn.r.ok === true,
    `${setIn.r.message}${setIn.confirmPath ? '｜' + setIn.confirmPath : ''}`,
  )
  await sleep(300)
  const got = await wops.exec('uia.getText', { pid, sel: `AutomationId=${inputEl.automationId}` })
  const rawText = String(got.data?.text ?? '')
  console.log(`    写入原文（JSON）：${JSON.stringify(MARK)}`)
  console.log(`    读回原文（JSON）：${JSON.stringify(rawText)}`)
  record('3 uia.getText 读回', got.ok === true, `ok=${got.ok}｜via=${got.data?.via ?? '-'}｜${got.message}`)
  record('3 读回与写入逐字一致（核心价值）', rawText === MARK, rawText === MARK ? '逐字一致（含中文，未被输入法改写）' : `不一致：读回 ${JSON.stringify(rawText)}`)

  // ================= 4. uia.click 两条分支 =================
  // 4a：Button → 应该走 InvokePattern 分支
  const clickBtn = await execGated('uia.click', { pid, sel: `AutomationId=${buttonEl?.automationId || 'probeButton'}` })
  record(
    '4a uia.click 走 InvokePattern 分支',
    clickBtn.r.ok === true && clickBtn.r.data?.via === 'invoke',
    `ok=${clickBtn.r.ok}｜via=${clickBtn.r.data?.via ?? '-'}｜${clickBtn.r.message}`,
  )
  // 点按钮后宿主会把 probeResult 写成 'clicked' —— 这是「点击真的生效」的独立证据
  await sleep(400)
  const afterClick = await wops.exec('uia.getText', { pid, sel: 'AutomationId=probeResult' })
  record(
    '4a 点击真的生效（宿主回写 clicked）',
    String(afterClick.data?.text ?? '').includes('clicked'),
    `probeResult 读回 = ${JSON.stringify(afterClick.data?.text ?? '')}`,
  )
  // 4b：TextBlock（不支持 Invoke）→ 应该走中心坐标兜底分支
  const clickText = await execGated('uia.click', { pid, sel: 'AutomationId=probeStatus' })
  record(
    '4b uia.click 走坐标兜底分支（元素不支持 Invoke）',
    clickText.r.ok === true && clickText.r.data?.via === 'mouse',
    `ok=${clickText.r.ok}｜via=${clickText.r.data?.via ?? '-'}｜x=${clickText.r.data?.x} y=${clickText.r.data?.y}｜${clickText.r.message}`,
  )

  // ================= 5. 选择器 Name 前缀匹配 =================
  // 用「备注输入框」的前 2 字「备注」去匹配：前缀≠全名，命中即证明是前缀匹配而非全等
  const prefixSel = 'Name=备注'
  const prefixHit = await wops.exec('uia.getText', { pid, sel: prefixSel })
  record(
    '5 选择器 Name 前缀匹配命中',
    prefixHit.ok === true,
    `${prefixSel} → ok=${prefixHit.ok}｜${prefixHit.message}（全名是「${inputEl.name}」，前缀≠全名）`,
  )
  // 反向证据：全名匹配也命中，说明前缀与全等都不冲突
  const fullHit = await wops.exec('uia.getText', { pid, sel: `Name=${inputEl.name}` })
  record('5 全名匹配同样命中', fullHit.ok === true, `Name=${inputEl.name} → ok=${fullHit.ok}`)

  // ================= 6. 找不到元素 → ok:false 不 throw =================
  // 注意：uia.click 是 input 类，没过确认闸门时 exec 会先返回 NEED_CONFIRM（那还没走到找元素）。
  // 所以这里必须先批准一次把闸门放行，才真正验到「找不到元素」这条脚本内路径。
  let missing = null
  let threw = ''
  try {
    const { r } = await execGated('uia.click', { pid, sel: 'AutomationId=__wops_no_such_element__' })
    missing = r
  } catch (e) {
    threw = e.message
  }
  record(
    '6 找不到元素返回 ok:false 且不 throw',
    !!missing && missing.ok === false && /没找到/.test(String(missing.message)) && !threw,
    threw ? `抛异常了：${threw}` : `ok=${missing?.ok}｜message=${missing?.message}`,
  )
  // 只读操作（uia.getText）不走确认闸门，顺带验同一路径不 throw
  let missRead = null
  let threw2 = ''
  try {
    missRead = await wops.exec('uia.getText', { pid, sel: 'AutomationId=__wops_no_such_element__' })
  } catch (e) {
    threw2 = e.message
  }
  record(
    '6 只读操作找不到元素同样 ok:false 不 throw',
    !!missRead && missRead.ok === false && /没找到/.test(String(missRead.message)) && !threw2,
    threw2 ? `抛异常了：${threw2}` : `ok=${missRead?.ok}｜message=${missRead?.message}`,
  )

  // ================= 7. 窗口挪动后同一选择器仍能定位（本轮立意）=================
  const boundsBefore = (await wops.exec('uia.tree', { pid })).data?.find((e) => e.automationId === 'probeInput')?.bounds || null
  await moveWindow(pid, 820, 480)
  await sleep(800)
  const treeAfter = await wops.exec('uia.tree', { pid })
  const boundsAfter = (treeAfter.data || []).find((e) => e.automationId === 'probeInput')?.bounds || null
  const moved = !!(boundsBefore && boundsAfter && (boundsBefore.x !== boundsAfter.x || boundsBefore.y !== boundsAfter.y))
  const readAfterMove = await wops.exec('uia.getText', { pid, sel: 'AutomationId=probeInput' })
  const textAfterMove = String(readAfterMove.data?.text ?? '')
  console.log(`\n  挪窗前 bounds：${boundsBefore ? `(${boundsBefore.x},${boundsBefore.y},${boundsBefore.w}×${boundsBefore.h})` : '未取到'}`)
  console.log(`  挪窗后 bounds：${boundsAfter ? `(${boundsAfter.x},${boundsAfter.y},${boundsAfter.w}×${boundsAfter.h})` : '未取到'}`)
  record(
    '7 窗口挪动后同一选择器仍能定位',
    moved && readAfterMove.ok === true && textAfterMove === MARK,
    `坐标确实变了=${moved}；挪窗后按 AutomationId=probeInput 仍读到同样文本=${textAfterMove === MARK}`,
  )
  // 强化：挪窗后同一选择器点按钮仍生效（元素法不依赖坐标）
  const clickAfterMove = await execGated('uia.click', { pid, sel: 'AutomationId=probeButton' })
  record(
    '7 挪窗后按选择器点击仍生效',
    clickAfterMove.r.ok === true,
    `via=${clickAfterMove.r.data?.via ?? '-'}｜${clickAfterMove.r.message}`,
  )

  // ================= 8. uia.invoke（Toggle 分支）=================
  // 独立证据：直接用 TogglePattern 读 CheckBox 的 ToggleState，Off→On 才算真触发
  const checkAid = checkEl?.automationId || 'probeCheck'
  const toggleBefore = await toggleStateOf(pid, checkAid)
  const inv = await execGated('uia.invoke', { pid, sel: `AutomationId=${checkAid}` })
  await sleep(500)
  const toggleAfter = await toggleStateOf(pid, checkAid)
  record(
    '8 uia.invoke 走 TogglePattern 分支',
    inv.r.ok === true && inv.r.data?.via === 'toggle',
    `ok=${inv.r.ok}｜via=${inv.r.data?.via ?? '-'}｜${inv.r.message}${inv.confirmPath ? '｜' + inv.confirmPath : ''}`,
  )
  record(
    '8 触发真的生效（ToggleState 从 Off 变 On）',
    toggleBefore !== toggleAfter && /Off|Indeterminate/.test(toggleBefore) && toggleAfter === 'On',
    `ToggleState：${toggleBefore} → ${toggleAfter}`,
  )
  const afterInvoke = await wops.exec('uia.getText', { pid, sel: 'AutomationId=probeResult' })
  record(
    '8 宿主回写 checked（第二重证据）',
    String(afterInvoke.data?.text ?? '').includes('checked'),
    `probeResult 读回 = ${JSON.stringify(afterInvoke.data?.text ?? '')}（via=${afterInvoke.data?.via ?? '-'}）`,
  )

  // ================= 9. 补充：真实第三方程序（记事本）读树 =================
  const np = spawn('notepad.exe', [], { detached: false })
  notepadPid = np.pid
  await sleep(2500)
  const npWin = await pickOwnWindow(notepadPid)
  if (!npWin) {
    record('9 记事本读树（真实第三方程序）', false, `没找到自开记事本 pid=${notepadPid}`)
  } else {
    const npTree = await wops.exec('uia.tree', { pid: Number(npWin.pid) })
    const npItems = Array.isArray(npTree.data) ? npTree.data : []
    console.log(`\n  ---- 记事本 uia.tree 实测输出原文 ----`)
    for (const line of String(npTree.message || '').split('\n')) console.log('  ' + line)
    record(
      '9 记事本读树（真实第三方程序）',
      npTree.ok === true && npItems.length > 0,
      `${npItems.length} 个元素：${npItems.map((e) => `${e.controlType}/${e.className}`).join('，')}`,
    )
    // Win32 经典编辑控件（ClassName=Edit 但 ControlType=Pane）没有 Value/Text pattern：
    // 这里验证「如实报错、不崩」，这正是 setValue/getText 在旧式控件上的正确行为
    const npEdit = npItems.find((e) => /^Edit$/i.test(e.className))
    if (npEdit) {
      const npSel = `ClassName=${npEdit.className}`
      const npSet = await execGated('uia.setValue', { pid: Number(npWin.pid), sel: npSel, text: 'wops-uia' })
      record(
        '9 Win32 经典控件无 ValuePattern 时如实报错（不崩）',
        npSet.r.ok === false && /ValuePattern/.test(String(npSet.r.message)),
        `ok=${npSet.r.ok}｜${npSet.r.message}`,
      )
    }
  }
} catch (e) {
  console.error('\n✗ 真机脚本中止：' + e.message)
} finally {
  // ---- 收尾：只杀本脚本自开的 pid ----
  for (const [label, p] of [['WPF 宿主', hostPid], ['测试记事本', notepadPid]]) {
    if (!p) continue
    await new Promise((r) => execFile('taskkill', ['/PID', String(p), '/T', '/F'], () => r()))
  }
  await sleep(700)
  const leftover = []
  for (const [label, p] of [['WPF 宿主', hostPid], ['测试记事本', notepadPid]]) {
    if (!p) continue
    let alive = true
    try { process.kill(p, 0) } catch { alive = false }
    if (alive) leftover.push(`${label} pid ${p}`)
  }
  record('收尾·自开窗口已清理（只杀自开 pid）', leftover.length === 0, leftover.length ? '还在：' + leftover.join('，') : `已清理（宿主 ${hostPid}、记事本 ${notepadPid || '未起'}）`)
}

// ---- 汇总 ----
const bad = results.filter((r) => !r.pass)
console.log(`\n== 汇总：${results.length - bad.length}/${results.length} 项通过 ==`)
if (bad.length) {
  console.log('\n失败项：')
  for (const b of bad) console.log('✗ ' + b.name + '：' + b.detail)
  process.exit(1)
}
console.log('全部通过 ✓')
