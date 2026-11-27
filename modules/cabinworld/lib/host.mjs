// 宿主副本：把官方 bridge 复制一份、打上「睡觉」「工具姿势」两类高级协议补丁，跑这份副本。
// 官方 bridge/ 永远保持原样（一键安装/升级随便覆盖），副本在 <游戏目录>/bridge-host/。
// 副本与 bridge/ 是兄弟目录，配置里的 ../data、../CabinWorld.exe 相对路径照样成立。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
import { exeName, assertKillable } from './exe.mjs'

const HOST_DIR = 'bridge-host'
/** 补丁脚本（lib/patches/apply.mjs）：index / bridgecfg / install 都用这一份，别再各算一遍。 */
export const PATCHES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'patches', 'apply.mjs')
const STAMP_FILE = '.source-stamp'
const PATCHED_FILE = '.patched'   // 1 = 已打高级协议补丁，0 = 官方桥原样兜底
const PID_FILE = 'host.pid'

export function sourceDir(gameDir) { return path.join(String(gameDir || '').trim(), 'bridge') }
export function hostDir(gameDir) { return path.join(String(gameDir || '').trim(), HOST_DIR) }
export function hostPidFile(gameDir) { return path.join(hostDir(gameDir), PID_FILE) }

function statOf(file) {
  try { const s = fs.statSync(file); return String(Math.round(s.mtimeMs)) + ':' + String(s.size) } catch { return '-' }
}

/** 整个目录的指纹（相对路径 + 大小 + mtime），给补丁目录用。 */
function treeStamp(dir) {
  const rows = []
  function walk(base, rel) {
    let list = []
    try { list = fs.readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const full = path.join(base, e.name), relPath = rel ? rel + '/' + e.name : e.name
      // data/ 是桥的运行时数据（每次启动都写），日志和备份也不该参与指纹。
      if (e.isDirectory()) {
        if (e.name === 'data' || e.name === 'node_modules' || e.name === '.git') continue
        walk(full, relPath)
      } else if (e.isFile()) {
        // bridge.config.json 是模块自己会写的（改名、端口、天气），不能算上游变更，
        // 否则每次改名都会触发一次没必要的副本重建。
        if (e.name === 'bridge.config.json') continue
        // .tmp- 是配置写入的中间态（bridge.config.json.tmp-<ts>-<rand>）和日志的临时文件：
        // 它们不属于上游变更，算进指纹只会让每次写失败都多触发一次副本重建。
        if (e.name.indexOf('.bak-') >= 0 || e.name.indexOf('.tmp-') >= 0 || /\.log$/.test(e.name)) continue
        rows.push(relPath + '=' + statOf(full))
      }
    }
  }
  walk(dir, '')
  return rows.sort().join(',')
}

/**
 * 官方桥 + 补丁自己的指纹：任一边改了都要重建副本。
 * 只认桥的话，改了 lib/patches/files 里的实现副本不会更新。
 */
function sourceStamp(gameDir, patchesScript) {
  // 整树指纹：官方桥 lib/ 下任何一个模块变了都要重建，否则用户以为更新了其实还在跑旧代码。
  const parts = ['bridge=' + treeStamp(sourceDir(gameDir))]
  if (patchesScript) parts.push('patches=' + treeStamp(path.dirname(patchesScript)))
  return parts.join('|')
}

function hostStamp(gameDir) {
  try { return fs.readFileSync(path.join(hostDir(gameDir), STAMP_FILE), 'utf8').trim() } catch { return '' }
}

function isInstalled(gameDir) {
  return fs.existsSync(path.join(sourceDir(gameDir), 'bridge.mjs'))
}

/** 副本是不是打好补丁的（官方桥原样兜底时为 false）。 */
function hostPatched(gameDir) {
  try { return fs.readFileSync(path.join(hostDir(gameDir), PATCHED_FILE), 'utf8').trim() === '1' } catch { return false }
}

export function needsSync(gameDir, patchesScript) {
  if (!fs.existsSync(path.join(hostDir(gameDir), 'bridge.mjs'))) return true
  return hostStamp(gameDir) !== sourceStamp(gameDir, patchesScript)
}

// ---- 进程身份：只按命令行认桥，绝不按“父进程”猜（副本桥是插件宿主 spawn 出来的，
//      按父进程杀会杀掉机器人自己）。 ----------------------------------------------------
// 一次 PowerShell 调用同时拿到映像名和命令行（原来只取命令行，判「是不是 node 起的桥」还得再来一次）。
// 取不到就返回空的 name/cmd：调用方一律按「不是我们的进程」处理，宁可不动手。
//
// 必须显式把输出编码钉成 UTF-8：Windows PowerShell 5.1 的 stdout 走系统代码页（本机 936/GBK），
// Node 按 utf8 解码会把命令行里的中文段读成乱码，于是「按绝对路径核对桥」在中文目录下一律失配
// （实测：ASCII 目录 bridgeAlive 正确，中文目录变 0、killBridge 拒绝动手）。
function processOf(pid) {
  const n = Number(pid) || 0
  if (!n) return { name: '', cmd: '', visible: false }
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + n + "'; if ($p) { [string]$p.Name + '|' + [string]$p.CommandLine }"],
      { encoding: 'utf8', timeout: 10000, windowsHide: true })
    const text = String(out || '').replace(/\r/g, '').trim()
    if (!text) return { name: '', cmd: '', visible: false }
    // PowerShell 返回「映像名|命令行」；分隔符没出现时整段当命令行，宁可不知道进程名也不误判。
    const at = text.indexOf('|')
    const name = (at < 0 ? '' : text.slice(0, at)).trim().toLowerCase()
    const cmd = (at < 0 ? text : text.slice(at + 1)).trim()
    // visible = 拿到了命令行。进程在但拿不到命令行（受保护进程、权限不足）与「进程不在」要能分开，
    // 否则 killBridge 会对着一个活着的进程说「已经不在了」。
    return { name: name, cmd: cmd, visible: cmd !== '' }
  } catch { return { name: '', cmd: '', visible: false } }
}

/** 路径归一化成「正斜杠 + 小写」再比：Windows 不区分大小写，命令行里也不一定用同一种分隔符。 */
function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase() }

/**
 * 这个进程是小屋世界的桥吗？'host'（副本桥）/ 'official'（官方 start.cmd 起的桥）/ ''。
 * 只要「动手杀」就必须过这一关：老的 /bridge-host/ + /bridge.mjs/ 是两个分散子串，
 * 命令行里恰好含这两段字样的无关进程（编辑器、grep、某些脚本）会被 taskkill。
 *   - 运行器必须是 node（或宿主自己的 exe），见 isOurRunner。
 *   - 副本桥：命令行里带着我们算出来的 <游戏目录>/bridge-host/bridge.mjs 绝对路径，这是最强的证据。
 *   - 官方桥：路径要成段出现（bridge/bridge.mjs），不接受两段分散的词。
 */
/**
 * 起桥的可执行文件是不是 node（或宿主自己的 exe）？
 * 副本桥一定是这两者之一；cmd.exe / 编辑器只是命令行里带了这个路径时不该被 taskkill。
 * 拿不到映像名时不靠这一条否决，交给下面的路径判据。
 */
function isOurRunner(info) {
  const name = String((info && info.name) || '').toLowerCase()
  if (!name) return true
  if (name.indexOf('node') === 0) return true
  return name === path.basename(process.execPath).toLowerCase()
}

function bridgeKind(info, gameDir) {
  const cmd = normPath(info && info.cmd)
  if (!cmd) return ''
  if (!isOurRunner(info)) return ''
  const host = normPath(path.join(hostDir(gameDir), 'bridge.mjs'))
  if (host && cmd.indexOf(host) >= 0) return 'host'
  const official = normPath(path.join(sourceDir(gameDir), 'bridge.mjs'))
  if (official && cmd.indexOf(official) >= 0) return 'official'
  return ''
}

/** 只杀确认是小屋世界桥的进程（副本桥或官方桥），别的一律不动。gameDir 用来核对绝对路径。 */
export function killBridge(pid, gameDir) {
  const n = Number(pid) || 0
  if (!n) return { killed: false, why: '没有 pid' }
  const info = processOf(n)
  if (!info.visible) {
    const why = info.name ? '进程 ' + n + ' 拿不到命令行，没动它' : '进程 ' + n + ' 已经不在了'
    return { killed: false, why: why }
  }
  const kind = bridgeKind(info, gameDir)
  if (!kind) return { killed: false, why: '进程 ' + n + ' 不是小屋世界的桥，没动它' }
  try {
    execFileSync('taskkill', ['/PID', String(n), '/F'], { stdio: 'ignore', timeout: 8000, windowsHide: true })
    return { killed: true, why: kind === 'host' ? '副本桥' : '官方桥' }
  } catch { return { killed: false, why: '关不掉进程 ' + n } }
}

/**
 * 副本桥还活着吗？返回 pid，没在跑返回 0。
 * 只认 host.pid 里那个，并且按命令行核对身份——pid 可能已被系统复用给别的进程。
 * 重建副本前必须用它确认：桥开着的时候 rename(bridge-host → .old) 在 Windows 上必然 EPERM。
 *
 * 判据和 killBridge 共用 bridgeKind：两边宽严不同会出现「一个说还活着、一个说不该杀」，
 * restartBridge 于是报「关不掉」却什么也停不掉（或反过来带着活进程去重建副本）。
 * 同一个进程只能有一个结论。
 */
export function bridgeAlive(pid, gameDir) {
  const n = Number(pid) || 0
  if (!n) return 0
  return bridgeKind(processOf(n), gameDir) ? n : 0
}

export function hostBridgeAlive(gameDir) {
  let pid = 0
  try { pid = Number(fs.readFileSync(hostPidFile(gameDir), 'utf8')) || 0 } catch { return 0 }
  if (!pid) return 0
  return bridgeAlive(pid, gameDir)
}

/** 游戏窗口还在跑吗？（桥挂了游戏能自己活着，别让新桥再开一个） */
export function isGameRunning(gameDir) {
  try {
    const name = exeName(gameDir)
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    return out.toLowerCase().indexOf(name.toLowerCase()) >= 0
  } catch { return false }
}

/** 按映像名结束游戏进程：名字不安全会 throw（调用方决定吞不吞）；本来就没开返回 false。 */
export function killGame(gameDir) {
  const name = assertKillable(exeName(gameDir))
  // 不先 tasklist 探活：tasklist 超时或权限不足时会误报「没在跑」，于是该杀的没杀。
  // 直接 taskkill，失败（本来就没开）当 false，和原来调用方的语义一致。
  try { execFileSync('taskkill', ['/IM', name, '/F'], { stdio: 'ignore', timeout: 8000 }); return true } catch { return false }
}

/** 等桥连上：每 1.5 秒问一次 probe（返回 { done, row }，null 表示这轮不算数），超时返回 { hit: false, row }。 */
export async function waitBridge(probe, maxMs = 20000) {
  // maxMs 必须有默认值：漏传时 deadline 会变成 NaN，比较恒为 false，一次探活都不做就报超时。
  const deadline = Date.now() + maxMs
  let row = null
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 1500) })
    try { const got = await probe(); if (got) { if (got.row) row = got.row; if (got.done) return { hit: true, row: row } } } catch { /* 还在起 */ }
  }
  return { hit: false, row: row }
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (/[.]bak-/.test(e.name) || e.name === STAMP_FILE || e.name === PID_FILE) continue
    const src = path.join(from, e.name), dst = path.join(to, e.name)
    if (e.isDirectory()) copyTree(src, dst)
    else if (e.isFile()) fs.copyFileSync(src, dst)
  }
}

function noteSync(gameDir, text) {
  try { fs.appendFileSync(path.join(hostDir(gameDir), 'sync.log'), '[' + new Date().toISOString() + '] ' + text + '\n') } catch { /* 日志写不进不影响结论 */ }
}

/** 重建并打补丁。先建在 .new，成功才换上去；失败时旧副本原样保留。 */
async function doSync({ gameDir, patchesScript, log }) {
  const src = sourceDir(gameDir), dst = hostDir(gameDir)
  // 名字带 pid + 时间戳：热重载时旧实例的 doSync 可能还在 await 里，
  // 固定名会让两个实例互相 rm/rename 对方的中间态，把半成品换成正式副本。
  const uniq = '.' + process.pid + '-' + Date.now()
  const tmp = dst + '.new' + uniq, old = dst + '.old' + uniq
  if (!fs.existsSync(path.join(src, 'bridge.mjs'))) return { ok: false, rebuilt: false, message: '找不到官方桥：' + src + '（先用 /小屋 安装）' }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(old, { recursive: true, force: true })
    copyTree(src, tmp)
    // 异步跑：这一脚本要 1-2 秒，同步执行会把整个 aurabot 进程卡住（QQ 消息、其它模块定时器全停）。
    await execFileAsync(process.execPath, [patchesScript, '--game', String(gameDir).trim(), '--bridge', tmp, '--no-backup'], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
    fs.writeFileSync(path.join(tmp, STAMP_FILE), sourceStamp(gameDir, patchesScript) + '\n')
    fs.writeFileSync(path.join(tmp, PATCHED_FILE), '1\n')
    let movedOld = false
    // 旧副本的 host.log 是排查「重建后桥起不来」唯一的现场，别跟着 .old 一起删掉。
    try { fs.copyFileSync(path.join(dst, 'host.log'), path.join(tmp, 'host.log')) } catch (e) { /* 没有旧日志就算了 */ }
    if (fs.existsSync(dst)) { fs.renameSync(dst, old); movedOld = true }
    try { fs.renameSync(tmp, dst) } catch (e) {
      if (movedOld && !fs.existsSync(dst)) { try { fs.renameSync(old, dst) } catch { /* 回滚失败下面会报 */ } }
      throw e
    }
    if (movedOld) { try { fs.rmSync(old, { recursive: true, force: true }) } catch { /* 残留 .old 不影响运行 */ } }
    log.info && log.info('小屋世界宿主副本已更新：' + dst)
    return { ok: true, rebuilt: true, message: '宿主副本已更新' }
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    // 换目录时出事就把旧副本放回原位；dst 还在就只清残留。
    if (!fs.existsSync(dst) && fs.existsSync(old)) { try { fs.renameSync(old, dst) } catch { /* 见下面的 ok 判断 */ } }
    if (fs.existsSync(dst)) { try { fs.rmSync(old, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    const raw = String((error && (error.stdout || error.stderr || error.message)) || '').trim()
    const tail = raw.slice(-600)
    const status = error && (typeof error.status === 'number' ? error.status : (typeof error.code === 'number' ? error.code : undefined))
    const why = status === 2 ? '官方桥代码变了，补丁锚点对不上' : status === 3 ? '补丁后的代码语法没过' : '重建副本失败'
    noteSync(gameDir, why + '（退出码 ' + String(status == null ? '?' : status) + '）：' + tail)
    const alive = fs.existsSync(path.join(dst, 'bridge.mjs'))
    const msg = why + '：' + (tail || '（没有更多输出，详见 bridge-host/sync.log）') + (alive ? '。已继续用旧副本' : '。')
    if (log.error) log.error('小屋世界：' + msg)
    if (alive) return { ok: true, rebuilt: false, degraded: true, patched: hostPatched(gameDir), message: msg }
    // 补丁打不上又没有旧副本：用官方桥原样顶住，至少让小屋世界能用。
    try {
      copyTree(src, tmp)
      // 不写指纹：写了 needsSync 就永远 false，这一版补丁失败会被固化成永久降级。
      // 不写的话每次启动都会重试一遍（1-2 秒），上游一旦修好就自动恢复。
      fs.writeFileSync(path.join(tmp, PATCHED_FILE), '0\n')
      fs.renameSync(tmp, dst)
      noteSync(gameDir, '补丁打不上，已改用未打补丁的官方桥副本')
      return { ok: true, rebuilt: true, patched: false, message: msg + '（已先用官方桥原样跑起来，高级协议补丁暂时没有；下次启动会再试）' }
    } catch (e2) {
      fs.rmSync(tmp, { recursive: true, force: true })
      return { ok: false, rebuilt: false, message: msg }
    }
  }
}

let syncing = false

/** 需要时重建副本（指纹没变就跳过）。同步执行，靠 syncing 标志互斥。 */
export async function ensureHost({ gameDir, patchesScript, log = console }) {
  if (!isInstalled(gameDir)) return { ok: false, rebuilt: false, message: '小屋世界还没装：' + String(gameDir || '') }
  if (!needsSync(gameDir, patchesScript)) return { ok: true, rebuilt: false, message: '宿主副本是最新的' }
  if (syncing) return { ok: false, rebuilt: false, busy: true, message: '宿主副本正在更新，稍后再试' }
  syncing = true
  try { return await doSync({ gameDir, patchesScript, log }) } finally { syncing = false }
}

/** 启动副本桥（独立进程，日志写 bridge-host/host.log）。游戏已经在跑就不再让它开第二个。 */
export function startHost({ gameDir, configPath, log = console, launchGame = true }) {
  const dir = hostDir(gameDir)
  const entry = path.join(dir, 'bridge.mjs')
  // 已经有一座活桥就不要再起一座：两个桥抢同一个端口，后起的那个连不上游戏，
  // host.pid 被覆盖成死 pid，状态报告从此一直说「不是副本桥」。
  const running = hostBridgeAlive(gameDir)
  if (running) return { ok: true, pid: running, already: true, launchedGame: false, message: '副本桥已经在跑（pid ' + running + '）' }
  if (!fs.existsSync(entry)) return { ok: false, message: '宿主副本还没准备好：' + entry }
  if (!fs.existsSync(configPath)) return { ok: false, message: '桥配置不存在：' + configPath }
  // 必须传 gameDir：exeName 要按配置里的 gameExe 查，漏传会退回默认的 CabinWorld.exe，
  // 用户自定义过 exe 名时就会以为游戏没开、再拉起第二个实例。
  const wantGame = launchGame !== false && !isGameRunning(gameDir)
  const args = [entry, '--config', configPath]
  if (!wantGame) args.push('--no-launch')
  const logFile = path.join(dir, 'host.log')
  const out = fs.openSync(logFile, 'a')
  let child
  try {
    child = spawn(process.execPath, args, { cwd: String(gameDir).trim(), detached: true, stdio: ['ignore', out, out], windowsHide: true })
  } finally {
    try { fs.closeSync(out) } catch { /* 子进程已经继承句柄 */ }
  }
  // spawn 失败是异步 emit('error')：不挂监听会变成未捕获异常，把整个插件宿主带走
  // （install.mjs 起 tar、index.mjs 起游戏都挂了监听，只有这里漏了）。
  child.once('error', function (e) {
    try { fs.rmSync(hostPidFile(gameDir), { force: true }) } catch { /* 删不掉也不影响 */ }
    try { log.error('副本桥启动失败：' + ((e && e.message) || e)) } catch { /* log 也可能是坏的 */ }
  })
  if (child.pid == null) return { ok: false, message: '副本桥没能启动（可能被杀毒软件拦了，看 bridge-host/host.log）' }
  child.unref()
  try { fs.writeFileSync(hostPidFile(gameDir), String(child.pid)) } catch { /* pid 文件只是方便排查 */ }
  return { ok: true, pid: child.pid, launchedGame: wantGame, message: '副本桥已启动（pid ' + child.pid + '）', logFile: logFile }
}
