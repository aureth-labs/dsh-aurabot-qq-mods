// ops.mjs —— windows-ops 模块操作目录与实现
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）
// 作用：把「窗口枚举/激活/关闭、截屏、剪贴板读写、键鼠模拟」各写成一段静态 PowerShell
//       脚本 + 参数白名单。用户给的值（文本、进程号、坐标）一律经 ps.b64arg 转成 UTF-8
//       base64 塞进脚本的 $a 数组，脚本本体不拼接任何用户输入——注入只是普通字符。
//       SendKeys 的按键 token 由本文件白名单映射（KEY_TOKENS），不接受任意字符串。
//       v1.2.0 起再加一层 UIA（无障碍树）元素定位：uia.tree / uia.click / uia.setValue /
//       uia.getText / uia.invoke，脚本模板与选择器解析都在 lib/uia.mjs（这里只做接线）。
// 契约：OPS（操作元数据，danger: 'safe'|'input'|'close'）与
//   export function createOps({ ps, dataDir }) → { run(op, args) → Promise<{ok, message, data?}> }
//   ps：lib/ps.mjs 的 createPs 产物；dataDir：api.dataDir()（截图等数据落这里）。

import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { UIA_OPS, uiaScripts, prepareUia, interpretUia } from './uia.mjs'

/** SendKeys 白名单：常用键名 → token。不接受任意字符串（SendKeys 的 +^%~(){}[] 是语法字符）。 */
const KEY_TOKENS = {
  enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
}

/** SendKeys 文本转义：把特殊语法字符包成 {} 字面量，其余原样。 */
function escapeSendKeys(text) {
  return String(text ?? '').replace(/[+^%~(){}]/g, (c) => `{${c}}`)
}

/** 操作元数据：label 给主人看；danger 决定安全闸门怎么拦。
 *  safe = 只读/无副作用；input = 键鼠动作（须开「允许键鼠模拟」）；close = 关窗口（最危险，必确认）。
 *  uia.* 的 5 条来自 lib/uia.mjs 的 UIA_OPS（UIA 层自己维护元数据，这里合并成一张表）。 */
export const OPS = {
  'clipboard.read': { label: '读剪贴板', danger: 'safe' },
  'clipboard.write': { label: '写剪贴板', danger: 'safe' },
  'screenshot': { label: '全屏截图', danger: 'safe' },
  'window.list': { label: '枚举窗口', danger: 'safe' },
  'window.activate': { label: '激活窗口', danger: 'input' },
  'window.close': { label: '关闭窗口', danger: 'close' },
  'mouse.move': { label: '移动鼠标', danger: 'input' },
  'mouse.click': { label: '点击鼠标', danger: 'input' },
  'key.text': { label: '键入文字', danger: 'input' },
  'key.press': { label: '按一个键', danger: 'input' },
  'paste': { label: '粘贴剪贴板内容（Ctrl+V）', danger: 'input' },
  ...UIA_OPS,
}

// ---- PowerShell 片段（静态，只在编译期写死）----

/** 每段脚本的开头：压掉进度流。真机踩坑（2026-11-06）：Windows PowerShell 5.1 首次 Add-Type
 *  会往 stderr 写 CLIXML 进度记录，且偶发连带退出码 1（stdout 全空）——压掉进度流后稳定。 */
const PREFIX = `$ProgressPreference='SilentlyContinue'\n`

/** user32 P/Invoke 声明：激活/恢复/鼠标/关窗消息共用一段。 */
const USER32 =
  "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int n); [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,int x,int y,uint d,int e); [DllImport(\"user32.dll\")] public static extern IntPtr PostMessage(IntPtr h,uint m,int w,int l);'"

/** 解码函数 + base64 参数数组。
 *  真机踩坑（2026-11-06）：Windows PowerShell 5.1 里
 *  「$a=@('b64') | ForEach-Object { GetString(FromBase64String($_)) }」会产出 Char（只剩首个字节，
 *  写剪贴板只写出 1 个字符），函数/直接表达式形式才正常——故解码统一走 D()，脚本里用 (D $a[n])。 */
const ARGS =
  "function D([string]$b){ return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }\n$a=@({{ARGS}})"

/** 每个操作的脚本模板；{{ARGS}} 会换成本调用的 base64 参数列表。 */
const SCRIPTS = {
  'clipboard.read':
    `${PREFIX}$ErrorActionPreference='Stop'
Get-Clipboard -Raw`,
  'clipboard.write':
    `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
Set-Clipboard -Value (D $a[0])`,
  'screenshot':
    `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)
$g.Dispose()
$bmp.Save((D $a[0]),[System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ok`,
  'window.list':
    `${PREFIX}$ErrorActionPreference='Stop'
@{ w=@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object @{n='pid';e={$_.Id}},@{n='name';e={$_.ProcessName}},@{n='title';e={$_.MainWindowTitle}}) } | ConvertTo-Json -Compress -Depth 3`,
  'window.activate':
    `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${USER32}
$p=Get-Process -Id ([int](D $a[0])) -ErrorAction Stop
$h=$p.MainWindowHandle
if($h -eq [IntPtr]::Zero){ throw '该进程没有主窗口' }
[W.U]::ShowWindow($h,9) | Out-Null
[W.U]::SetForegroundWindow($h) | Out-Null
Write-Output ok`,
  'window.close':
    `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${USER32}
$p=Get-Process -Id ([int](D $a[0])) -ErrorAction Stop
$h=$p.MainWindowHandle
if($h -eq [IntPtr]::Zero){ throw '该进程没有主窗口' }
$r=[W.U]::PostMessage($h,0x0010,0,0)
if($r -eq [IntPtr]::Zero){ throw '系统拒绝了关闭消息' }
Write-Output ok`,
  'mouse.move':
    `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${USER32}
if(-not [W.U]::SetCursorPos([int](D $a[0]),[int](D $a[1]))){ throw '移动鼠标失败' }
Write-Output ok`,
  'mouse.click':
    `${PREFIX}$ErrorActionPreference='Stop'
${ARGS}
${USER32}
if(-not [W.U]::SetCursorPos([int](D $a[0]),[int](D $a[1]))){ throw '移动鼠标失败' }
Start-Sleep -Milliseconds 60
$down=0x0002; $up=0x0004
if((D $a[2]) -eq 'right'){ $down=0x0008; $up=0x0010 }
[W.U]::mouse_event($down,0,0,0,0)
Start-Sleep -Milliseconds 40
[W.U]::mouse_event($up,0,0,0,0)
Write-Output ok`,
  'key.text':
    `${PREFIX}$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
${ARGS}
[System.Windows.Forms.SendKeys]::SendWait((D $a[0]))
Write-Output ok`,
  'key.press':
    `${PREFIX}$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
${ARGS}
[System.Windows.Forms.SendKeys]::SendWait((D $a[0]))
Write-Output ok`,
  // 真机踩坑（2026-11-06）：key.text 走 SendKeys 会被中文输入法吞掉转拼音（'wops'→'我平时'）；
  // 可靠的文本注入是「先 clipboard.write，再 paste」——所以把 Ctrl+V 单独做成原子操作。
  'paste':
    `${PREFIX}$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
Write-Output ok`,
  // UIA 的 5 段脚本在 lib/uia.mjs（与选择器解析、输出解释放在一起，方便对照契约看）；
  // PREFIX/ARGS 从本文件注入，保证「压进度流 + base64 参数」两处只有一份实现。
  ...uiaScripts({ PREFIX, ARGS }),
}

/**
 * 创建操作执行器。
 * @param {{ps: object, dataDir: string}} o ps = createPs 产物；dataDir = api.dataDir()。
 */
export function createOps({ ps, dataDir }) {
  /** 拼 base64 参数列表 → 替换脚本模板里的 {{ARGS}}。 */
  function buildScript(op, argv) {
    const tpl = SCRIPTS[op]
    if (!tpl) throw new Error(`未知操作：${op}`)
    const list = argv.map((v) => `'${ps.b64arg(v)}'`).join(',')
    return tpl.replace('{{ARGS}}', list || "''")
  }

  /** 参数整理：按操作核对个数/类型，返回（字符串化后的）argv 与给主人看的摘要。 */
  function prepare(op, args = {}) {
    const num = (v, name) => {
      const n = Math.round(Number(v))
      if (!Number.isFinite(n)) throw new Error(`参数 ${name} 要是数字`)
      return String(n)
    }
    switch (op) {
      case 'clipboard.read':
      case 'window.list':
        return { argv: [], summary: '' }
      // UIA 五件的参数整理全在 lib/uia.mjs（选择器解析 + pid 校验），这里只转发；
      // 参数不合法（选择器写错、pid 不是正整数）在这里抛错，index.mjs 的 exec 会转成 { ok:false, message }。
      case 'uia.tree':
      case 'uia.click':
      case 'uia.setValue':
      case 'uia.getText':
      case 'uia.invoke':
        return prepareUia(op, args)
      case 'clipboard.write': {
        const text = String(args.text ?? '')
        return { argv: [text], summary: `${text.length} 个字符` }
      }
      case 'screenshot':
        return { argv: [], summary: '' } // 文件名由 run 自己生成（落 dataDir/shots，调用方传什么都不认）
      case 'window.activate':
      case 'window.close': {
        const pid = num(args.pid, 'pid')
        return { argv: [pid], summary: `pid ${pid}` }
      }
      case 'mouse.move':
      case 'mouse.click': {
        const x = num(args.x, 'x'); const y = num(args.y, 'y')
        const btn = op === 'mouse.click' && String(args.button || 'left') === 'right' ? 'right' : 'left'
        return { argv: btn ? [x, y, btn] : [x, y], summary: `(${x}, ${y})${btn === 'right' ? ' 右键' : ''}` }
      }
      case 'key.text': {
        const text = String(args.text ?? '').slice(0, 500)
        if (!text) throw new Error('参数 text 不能为空')
        return { argv: [escapeSendKeys(text)], summary: `${text.length} 个字符` }
      }
      case 'key.press': {
        const key = String(args.key || '').trim().toLowerCase()
        const token = KEY_TOKENS[key]
        if (!token) throw new Error(`不支持的按键：${key}（支持 ${Object.keys(KEY_TOKENS).join('/')}）`)
        return { argv: [token], summary: key }
      }
      case 'paste':
        return { argv: [], summary: '剪贴板当前内容' }
      default:
        throw new Error(`未知操作：${op}`)
    }
  }

  /** 执行一个操作。返回 { ok, message, data? }（工具面直接可用）。 */
  async function run(op, args = {}) {
    if (!ps.isWin()) return { ok: false, message: 'windows-ops 只能在 Windows 上用（当前平台：' + process.platform + '）' }
    const { argv, summary } = prepare(op, args)
    let target = op
    // 截图：文件名在这里生成，落 api.dataDir('shots')，绝不写进模块源码目录，也不认外部传的路径
    // （PowerShell 的 $bmp.Save 不会自建目录：shots/ 不存在时保存直接失败，这里先建）
    if (op === 'screenshot') {
      target = op
      mkdirSync(join(dataDir, 'shots'), { recursive: true })
      argv.push(join(dataDir, 'shots', `shot-${Date.now()}.png`))
    }
    // UIA 五件：脚本内部已经把「找不到窗口/元素/不支持该模式」都翻成结构化失败输出，正常退出；
    // 只有真出错（PowerShell 起不来、脚本崩）才会抛。抛的时候错误上若挂着已产出的 stdout
    // （注入的 fake ps 可以挂），照样按结构化结果解释——真实 ps.run 不挂，就把错往上交。
    const isUia = op.startsWith('uia.')
    // 只读类操作偶发失败（PS 5.1 首次加载模块的退出码毛刺）安全重试一次；动作类绝不重试（防重复点击）
    const retryable = ['screenshot', 'window.list', 'clipboard.read', 'uia.tree', 'uia.getText']
    let out = ''
    try {
      out = (await ps.run(buildScript(target, argv))).trim()
    } catch (e) {
      const partial = typeof e?.stdout === 'string' ? e.stdout.trim() : ''
      if (isUia && partial) out = partial
      else if (!retryable.includes(op)) throw e
      else out = (await ps.run(buildScript(target, argv))).trim()
    }
    // UIA 五件的后续处理统一交给 lib/uia.mjs 的 interpretUia（按操作挑字段、拼给主人看的话）
    if (isUia) return interpretUia(op, out)
    switch (op) {
      case 'clipboard.read':
        return { ok: true, message: out ? `剪贴板内容（${out.length} 字符）` : '剪贴板是空的', data: out }
      case 'clipboard.write':
        return { ok: true, message: '已写入剪贴板' }
      case 'screenshot':
        return { ok: true, message: `截图已保存：${argv[0]}`, data: argv[0] }
      case 'window.list': {
        // ConvertTo-Json 单元素时给的不是数组：统一包一层
        let list = []
        try {
          const parsed = JSON.parse(out || '{"w":[]}').w
          list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
        } catch (e) {
          return { ok: false, message: `窗口列表解析失败：${e.message}` }
        }
        return { ok: true, message: `共 ${list.length} 个有主窗口的进程`, data: list }
      }
      case 'window.activate':
        return { ok: true, message: `已把进程 ${argv[0]} 的窗口切到前台` }
      case 'window.close':
        return { ok: true, message: `已向进程 ${argv[0]} 的窗口发送关闭消息（多数程序会自己收尾退出）` }
      case 'mouse.move':
        return { ok: true, message: `鼠标已移到 (${argv[0]}, ${argv[1]})` }
      case 'mouse.click':
        return { ok: true, message: `已在 (${argv[0]}, ${argv[1]}) ${argv[2] === 'right' ? '右键' : '左键'}点击` }
      case 'key.text':
        return { ok: true, message: '文字已键入当前焦点窗口' }
      case 'key.press':
        return { ok: true, message: `已按键 ${summary}` }
      case 'paste':
        return { ok: true, message: '已在当前焦点窗口粘贴剪贴板内容（Ctrl+V）' }
      default:
        return { ok: false, message: `未知操作：${op}` }
    }
  }

  return { run, prepare, OPS }
}
