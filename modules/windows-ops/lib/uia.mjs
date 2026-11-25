// uia.mjs —— windows-ops 的 UIA（无障碍树）元素定位层
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）。
//       手法照搬本模块 test/real-machine.mjs L188-205 已跑通的 UIAutomationClient 读记事本文本。
// 作用：把「按坐标点」升级成「读无障碍树 + 按元素操作」，坐标法降为兜底：
//       uia.tree（读树）/ uia.click（Invoke → 坐标兜底）/ uia.setValue（ValuePattern 直写，
//       天然绕开输入法）/ uia.getText（TextPattern.DocumentRange → ValuePattern → Name）/ uia.invoke
//       （TogglePattern → SelectionItemPattern → ExpandCollapsePattern）。
//       选择器在 JS 侧解析成「键=值」片段链，每片单独 base64 塞进脚本的 $a 数组；
//       脚本本体只有静态 UIA 查找函数，用户值一律 (D $a[n]) 解码——注入只是普通字符。
// 契约：
//   UIA_SELECTOR_KEYS —— 选择器支持的键（AutomationId / Name / ControlType / ClassName）
//   UIA_OPS —— 5 个操作的元数据（label / danger），由 lib/ops.mjs 合并进 OPS
//   uiaScripts({ PREFIX, ARGS }) → { <op>: 静态 PowerShell 脚本模板 }（含 {{ARGS}} 占位）
//   parseSelector(sel) → [{ key, value, raw }]（空串 → []，非法选择器抛错，由 prepare 层当参数校验错）
//   prepareUia(op, args) → { argv, summary }
//   interpretUia(op, out) → { ok, message, data? }
// 参数约定（argv 全是字符串，每个都经 ps.b64arg，脚本里顺序固定）：
//   uia.tree     —— [pid, ...选择器片段]（片段可为空 = 整棵树）
//   uia.click    —— [pid, ...选择器片段]
//   uia.getText  —— [pid, ...选择器片段]
//   uia.invoke   —— [pid, ...选择器片段]
//   uia.setValue —— [pid, 要写入的值, ...选择器片段]（值固定占第 1 位，免得值里带 '=' 被当成条件）
// 真机铁律（Windows UIA 的硬约束）：
//   · AutomationElement 跨进程会失效：每次操作都是「pid → FromHandle → 现查当场用」，绝不缓存元素；
//   · 找不到窗口 / 找不到元素 / 控件不支持某模式，一律返回 { ok:false, message }，不 throw
//     （AI 能读懂失败原因，换 pid 或换选择器重试）；
//   · 选择器值按「前缀」匹配、大小写不敏感，不支持通配：UIA 原生 PropertyCondition 只有全等，
//     所以脚本里先 FindAll(Descendants) 取候选，再自己 StartsWith 过滤；
//   · 输出统一 ConvertTo-Json -Compress 后再套一层 UTF-8 base64：PS 5.1 的输出走控制台代码页，
//     中文原样打印会变乱码，base64 包一层最稳；JS 侧 decodeUiaOut 负责拆（先看 '{'，否则按 base64 解）。

/** 选择器支持的四类键：UIA 里只有它们能做「稳定的元素指纹」。 */
export const UIA_SELECTOR_KEYS = ['AutomationId', 'Name', 'ControlType', 'ClassName']

/** 5 个操作的元数据：danger 交给 lib/safety.mjs 的安全闸门判定。
 *  tree/getText 只读 → safe；click/setValue/invoke 会动界面 → input（须开「允许键鼠模拟」）。 */
export const UIA_OPS = {
  'uia.tree': { label: '读无障碍树', danger: 'safe' },
  'uia.click': { label: '按元素点击', danger: 'input' },
  'uia.setValue': { label: '按元素写值（绕过输入法）', danger: 'input' },
  'uia.getText': { label: '读控件文本', danger: 'safe' },
  'uia.invoke': { label: '按元素触发表单动作', danger: 'input' },
}

/**
 * 选择器解析：「键=值&&键=值」→ [{ key, value, raw }]。
 * 键大小写不敏感（写成 name=xx 也认，统一成 Name）；值保留原样（含 '='、空格），只在前缀匹配时用。
 * 非法选择器抛 Error：由 lib/ops.mjs 的 prepare 抛出，index.mjs 的 exec 会转成 { ok:false, message }。
 * @param {string} sel
 * @returns {{key: string, value: string, raw: string}[]}
 */
export function parseSelector(sel) {
  const text = String(sel ?? '').trim()
  if (!text) return []
  const out = []
  for (const chunk of text.split('&&')) {
    const part = chunk.trim()
    if (!part) continue
    const at = part.indexOf('=')
    if (at < 1) {
      throw new Error(`选择器片段「${part.slice(0, 40)}」要写成 键=值（可用键：${UIA_SELECTOR_KEYS.join('/')}）`)
    }
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    const canonical = UIA_SELECTOR_KEYS.find((k) => k.toLowerCase() === key.toLowerCase())
    if (!canonical) throw new Error(`选择器键「${key.slice(0, 30)}」不支持（只认 ${UIA_SELECTOR_KEYS.join('/')}）`)
    if (!value) throw new Error(`选择器「${canonical}」的值不能为空`)
    if (value.includes('*')) throw new Error('选择器不支持通配符（只做前缀匹配）；不确定元素叫什么先用 uia.tree 看一眼')
    out.push({ key: canonical, value, raw: `${canonical}=${value}` })
  }
  if (!out.length) {
    throw new Error('选择器要写成 键=值&&键=值（例：AutomationId=submitBtn 或 Name=提交&&ControlType=Button）')
  }
  return out
}

/** 选择器给主人看的摘要：AutomationId=submitBtn && ControlType=Button */
function selText(parts) {
  return parts.map((p) => p.raw).join(' && ')
}

/** pid 校验：整数且大于 0（传 '1234' 也认）。 */
function pidOf(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) throw new Error('参数 pid 要是正整数（目标窗口的进程号，可用 window.list 查）')
  return String(n)
}

/**
 * UIA 操作的参数整理：按操作核对 pid / sel / text，拼出 argv（base64 由 ops.buildScript 统一转）。
 * @param {string} op
 * @param {object} args
 * @returns {{argv: string[], summary: string}}
 */
export function prepareUia(op, args = {}) {
  if (!UIA_OPS[op]) throw new Error(`未知操作：${op}`)
  const pid = pidOf(args.pid)
  const parts = parseSelector(args.sel)
  const raws = parts.map((p) => p.raw)
  if (op === 'uia.tree') {
    // 树可以不给选择器（整棵树）；给了就只列匹配的
    return { argv: [pid, ...raws], summary: `pid ${pid}${parts.length ? '，' + selText(parts) : '（整棵树）'}` }
  }
  if (!parts.length) {
    throw new Error(`${op} 需要选择器 sel（例：AutomationId=submitBtn 或 Name=提交&&ControlType=Button；不知道有哪些元素先用 uia.tree）`)
  }
  if (op === 'uia.setValue') {
    const text = String(args.text ?? args.value ?? '')
    return { argv: [pid, text, ...raws], summary: `pid ${pid}，${selText(parts)} ← ${text.length} 个字符` }
  }
  return { argv: [pid, ...raws], summary: `pid ${pid}，${selText(parts)}` }
}

/** 坐标兜底点击要用的 user32 声明（静态，只含固定文本）。 */
const CLICK_PINVOKE =
  "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,int x,int y,uint d,int e);'"

/** 5 个操作的静态 PowerShell 脚本模板。PREFIX/ARGS 由 lib/ops.mjs 注入，避免两处各写一份。 */
export function uiaScripts({ PREFIX, ARGS }) {
  // 共用底座：加载 UIA 程序集 + 通用工具函数。全是静态文本，不含任何用户输入。
  // · D(...) 来自 ARGS：base64 → 原文。
  // · Num：UIA 的 Rect 是 double，可能是 Infinity/NaN，统一收紧成整数。
  // · RootEl：pid → 进程 → MainWindowHandle → AutomationElement；进程不在/没有主窗口返回 $null。
  //   跨进程元素不能留存，每次操作都现取（绝不缓存）。
  // · AllEl：根 + 全部后代收集成 ArrayList（根自己也放进去，选择器可以命中窗口本身）。
  // · FilterEl：按选择器片段链逐条过滤（前缀匹配、大小写不敏感）。
  // · FindEl：过滤后取第一个，没有就 $null。
  // · CTName：ControlType 的 ProgrammaticName 去掉 'ControlType.' 前缀（中文系统上 ToString()
  //   可能给本地化名「按钮」，只用 ProgrammaticName 才稳定）；顺便兼容用户写 'ControlType.Button'。
  // · Emit：hashtable → 压缩 JSON → UTF-8 base64 打印（避开 PS 5.1 控制台代码页把中文变乱码）。
  const BASE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Num($v){ try{ $d=[double]$v; if([double]::IsInfinity($d) -or [double]::IsNaN($d)){ return 0 }; return [int]$d } catch { return 0 } }
function Emit($o){ Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress -Depth 5)))) }
function CTName($ct){
  $s=''
  try { $s=[string]$ct.ProgrammaticName } catch { $s='' }
  if($s.StartsWith('ControlType.')){ $s=$s.Substring(12) }
  return $s
}
function RootEl($a){
  $p=$null
  try { $p=Get-Process -Id ([int](D $a[0])) -ErrorAction Stop } catch { return $null }
  if($null -eq $p){ return $null }
  $h=$p.MainWindowHandle
  if($h -eq [IntPtr]::Zero){ return $null }
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}
function AllEl($root){
  $l=New-Object System.Collections.ArrayList
  [void]$l.Add($root)
  foreach($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){ [void]$l.Add($e) }
  return ,$l
}
function FilterEl($list,$a,[int]$from){
  $total=$a.Length
  for($i=$from;$i -lt $total;$i++){
    $p=(D $a[$i])
    $at=$p.IndexOf('=')
    if($at -lt 1){ continue }
    $k=$p.Substring(0,$at)
    $v=$p.Substring($at+1)
    $next=New-Object System.Collections.ArrayList
    foreach($e in $list){
      try{
        $c=$e.Current
        $hit=$false
        if($k -ceq 'AutomationId'){ $hit=([string]$c.AutomationId).StartsWith($v,[System.StringComparison]::OrdinalIgnoreCase) }
        elseif($k -ceq 'Name'){ $hit=([string]$c.Name).StartsWith($v,[System.StringComparison]::OrdinalIgnoreCase) }
        elseif($k -ceq 'ClassName'){ $hit=([string]$c.ClassName).StartsWith($v,[System.StringComparison]::OrdinalIgnoreCase) }
        elseif($k -ceq 'ControlType'){
          $hit=(CTName $c.ControlType).StartsWith($v,[System.StringComparison]::OrdinalIgnoreCase)
          if(-not $hit){ $hit=([string]$c.ControlType.ProgrammaticName).StartsWith($v,[System.StringComparison]::OrdinalIgnoreCase) }
        }
        if($hit){ [void]$next.Add($e) }
      } catch { }
    }
    $list=$next
    if($list.Count -eq 0){ break }
  }
  return ,$list
}
function FindEl($root,$a,[int]$from){
  $l=FilterEl (AllEl $root) $a $from
  if($l.Count -gt 0){ return $l[0] }
  return $null
}
`
  // 两类失败措辞都是静态文本：AI 读到就知道该换 pid 还是换选择器，而不是以为工具坏了
  const NO_WIN =
    "Emit @{ ok=$false; message='找不到目标窗口：这个 pid 的进程不存在、已退出，或没有主窗口（先用 window.list 认准 pid）' }; exit 0"
  const MISS =
    "Emit @{ ok=$false; message='没找到匹配的元素：窗口里没有满足选择器的控件（先用 uia.tree 看有哪些元素；选择器值只做前缀匹配）' }; exit 0"

  /** 三个「先找元素」的脚本共用的开头：取根 → 找元素 → 失败就结构化输出并退出。 */
  const locate = (from) => `$root=RootEl $a
if($null -eq $root){ ${NO_WIN} }
$el=FindEl $root $a ${from}
if($null -eq $el){ ${MISS} }`

  return {
    // 读树：每行 index｜ControlType｜Name｜AutomationId｜ClassName｜bounds；最多列 300 个防刷屏
    'uia.tree':
      `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
$root=RootEl $a
if($null -eq $root){ ${NO_WIN} }
$sel=FilterEl (AllEl $root) $a 1
$items=New-Object System.Collections.ArrayList
$idx=0
foreach($e in $sel){
  if($idx -ge 300){ break }
  try{
    $c=$e.Current
    $r=$c.BoundingRectangle
    [void]$items.Add(@{ i=$idx; ct=(CTName $c.ControlType); n=[string]$c.Name; aid=[string]$c.AutomationId; cls=[string]$c.ClassName; x=(Num $r.X); y=(Num $r.Y); w=(Num $r.Width); h=(Num $r.Height) })
  } catch { }
  $idx++
}
Emit @{ ok=$true; total=$sel.Count; items=$items }`,

    // 点击：优先 InvokePattern.Invoke()（不抢焦点、不怕遮挡）；不支持就取元素中心坐标真人点击兜底
    'uia.click':
      `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
${locate(1)}
$via=''
try{ $ip=$el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke(); $via='invoke' } catch { $via='' }
if($via -eq 'invoke'){ Emit @{ ok=$true; via='invoke'; name=[string]$el.Current.Name }; exit 0 }
try{
  $r=$el.Current.BoundingRectangle
  $w=(Num $r.Width); $h=(Num $r.Height)
  if($r.IsEmpty -or $w -le 0 -or $h -le 0){ Emit @{ ok=$false; message='元素不支持 InvokePattern，也没有可点的可见区域（可能隐藏、被遮挡或已失效）' }; exit 0 }
  $x=(Num $r.X)+[int]($w/2)
  $y=(Num $r.Y)+[int]($h/2)
  ${CLICK_PINVOKE}
  [W.U]::SetCursorPos($x,$y) | Out-Null
  Start-Sleep -Milliseconds 60
  [W.U]::mouse_event(0x0002,0,0,0,0)
  Start-Sleep -Milliseconds 40
  [W.U]::mouse_event(0x0004,0,0,0,0)
  Emit @{ ok=$true; via='mouse'; x=$x; y=$y; name=[string]$el.Current.Name }
} catch { Emit @{ ok=$false; message=('点击失败：'+$_.Exception.Message) } }`,

    // 写值：ValuePattern.SetValue 直接写控件值，绕开输入法（治 key.text 被吞成拼音的坑）；只读控件明确报错
    'uia.setValue':
      `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
${locate(2)}
$val=(D $a[1])
try{
  $vp=$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if($vp.Current.IsReadOnly){ Emit @{ ok=$false; message='控件是只读的（ValuePattern.IsReadOnly），写不进去' }; exit 0 }
  $vp.SetValue($val)
  Emit @{ ok=$true; name=[string]$el.Current.Name; len=$val.Length }
} catch { Emit @{ ok=$false; message=('该控件不支持 ValuePattern.SetValue（多半不是输入框）：'+$_.Exception.Message) } }`,

    // 读文本：TextPattern.DocumentRange（记事本这类）优先 → ValuePattern（输入框）→ Name（只读文本元素）。
    // 真机踩坑（2026-11-06）：TextBlock / Label 这类只读文本元素的文字就在 Name 里，
    // 它们既没有 TextPattern 也没有 ValuePattern；少了第三级会读回空串，让人误判「控件没内容」。
    'uia.getText':
      `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
${locate(1)}
$text=''
$via=''
try{ $tp=$el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern); $text=[string]$tp.DocumentRange.GetText(20000); if($text){ $via='text' } } catch { $text='' }
if(-not $text){
  try{ $vp=$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $text=[string]$vp.Current.Value; if($text){ $via='value' } } catch { $text='' }
}
if(-not $text){
  try{ $n=[string]$el.Current.Name; if($n){ $text=$n; $via='name' } } catch { }
}
Emit @{ ok=$true; text=$text; via=$via }`,

    // 触发表单动作：Toggle → SelectionItem → ExpandCollapse（按当前状态反转），都不支持就明说
    'uia.invoke':
      `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${BASE}
${locate(1)}
$via=''
try{ $tp=$el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $tp.Toggle(); $via='toggle' } catch { $via='' }
if(-not $via){
  try{ $sp=$el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $sp.Select(); $via='select' } catch { $via='' }
}
if(-not $via){
  try{
    $ep=$el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $st=[string]$ep.Current.ExpandCollapseState
    if($st -eq 'Expanded'){ $ep.Collapse() } else { $ep.Expand() }
    $via='expandcollapse'
  } catch { $via='' }
}
if(-not $via){ Emit @{ ok=$false; message='该控件不支持 Toggle/SelectionItem/ExpandCollapse 任一模式（要普通点击请用 uia.click）' }; exit 0 }
Emit @{ ok=$true; via=$via; name=[string]$el.Current.Name }`,
  }
}

/** 拆脚本输出：正常是 UTF-8 base64（Emit 打的），也兼容直接给 JSON（测试/回放注入时方便）。 */
function decodeUiaOut(out) {
  const s = String(out ?? '').trim()
  if (!s) return null
  if (s.startsWith('{') || s.startsWith('[')) {
    try { return JSON.parse(s) } catch { return null }
  }
  try {
    const j = Buffer.from(s, 'base64').toString('utf8').trim()
    return JSON.parse(j)
  } catch { return null }
}

/** PowerShell 里 @() 单元素经 ConvertTo-Json 会退化成标量，这里统一包成数组。 */
function asList(v) {
  if (Array.isArray(v)) return v
  return v === undefined || v === null || v === '' ? [] : [v]
}

/** 元素记录 → JS 侧统一形状（脚本用短键省输出体积）。 */
function toElement(e) {
  const num = (v) => Number(v) || 0
  return {
    index: num(e?.i),
    controlType: String(e?.ct ?? ''),
    name: String(e?.n ?? ''),
    automationId: String(e?.aid ?? ''),
    className: String(e?.cls ?? ''),
    bounds: { x: num(e?.x), y: num(e?.y), w: num(e?.w), h: num(e?.h) },
  }
}

/**
 * 把脚本输出翻译成工具面结果。
 * @param {string} op
 * @param {string} out ps.run 的原始 stdout
 * @returns {{ok: boolean, message: string, data?: any}}
 */
export function interpretUia(op, out) {
  const r = decodeUiaOut(out)
  if (!r) return { ok: false, message: `UIA 输出解析失败（${op}）：${String(out ?? '').trim().slice(0, 200)}` }

  if (op === 'uia.tree') {
    if (r.ok === false) return { ok: false, message: String(r.message || '读无障碍树失败'), data: [] }
    const items = asList(r.items).map(toElement)
    if (!items.length) {
      return { ok: false, message: '这个窗口的无障碍树里没有元素（程序可能没开无障碍支持，或窗口已关闭）', data: [] }
    }
    const total = Number(r.total) || items.length
    const more = total > items.length ? `（共 ${total} 个，只列前 ${items.length} 个）` : ''
    // 每行：index｜ControlType｜Name｜AutomationId｜ClassName｜bounds，AI 照着挑选择器
    const lines = items.map(
      (e) => `${e.index}｜${e.controlType}｜${e.name}｜${e.automationId}｜${e.className}｜(${e.bounds.x},${e.bounds.y},${e.bounds.w}×${e.bounds.h})`,
    )
    return { ok: true, message: `无障碍树 ${items.length} 个元素${more}：\n${lines.join('\n')}`, data: items }
  }

  if (r.ok === false) return { ok: false, message: String(r.message || 'UIA 操作失败') }

  if (op === 'uia.click') {
    const name = String(r.name ?? '')
    const who = name ? `「${name}」` : '目标元素'
    if (r.via === 'invoke') {
      return { ok: true, message: `已通过 InvokePattern 点击${who}（不抢焦点）`, data: { via: 'invoke', name } }
    }
    return {
      ok: true,
      message: `元素不支持 InvokePattern，已按${who}中心坐标 (${r.x}, ${r.y}) 模拟点击`,
      data: { via: 'mouse', x: Number(r.x) || 0, y: Number(r.y) || 0, name },
    }
  }

  if (op === 'uia.setValue') {
    const name = String(r.name ?? '')
    const len = Number(r.len) || 0
    return { ok: true, message: `已写入${name ? `「${name}」` : '控件'} ${len} 个字符（ValuePattern，绕开输入法）`, data: { name, length: len } }
  }

  if (op === 'uia.getText') {
    const text = String(r.text ?? '')
    const via = String(r.via ?? '')
    if (!text) return { ok: true, message: '该控件没有可读文本（TextPattern / ValuePattern / Name 都取不到）', data: { text: '', via: '' } }
    const viaLabel = { text: 'TextPattern', value: 'ValuePattern', name: 'Name（只读文本控件的文字就在 Name 里）' }[via] || via
    return { ok: true, message: `读到 ${text.length} 个字符（${viaLabel}）`, data: { text, via } }
  }

  if (op === 'uia.invoke') {
    const via = String(r.via ?? '')
    const name = String(r.name ?? '')
    const label = { toggle: 'TogglePattern 切换', select: 'SelectionItemPattern 选中', expandcollapse: 'ExpandCollapsePattern 展开/收起' }[via] || via
    return { ok: true, message: `已用${label}触发${name ? `「${name}」` : '目标元素'}`, data: { via, name } }
  }

  return { ok: false, message: `未知操作：${op}` }
}
