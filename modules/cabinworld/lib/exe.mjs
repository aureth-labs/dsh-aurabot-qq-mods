// 游戏 exe 的路径与文件名：以 bridge.config.json 的 gameExe 为准（默认 ../CabinWorld.exe，相对 bridge/ 解析）。
// 单独成模块是为了让 bridgecfg / host / install / index 都能用同一份派生逻辑，
// 而 host.mjs 又被 bridgecfg.mjs 依赖，放任何一边都会成环。只依赖 fs 和 path。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_EXE = '../CabinWorld.exe'

/** 读一个 JSON 文件：去掉 BOM 再 parse。bridge.config.json / bridge.json 都走这里，别各写一份。 */
export function readJsonFile(file) {
  const text = String(fs.readFileSync(file, 'utf8'))
  return { raw: text, json: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) }
}

function readGameExe(gameDir) {
  try {
    const json = readJsonFile(path.join(String(gameDir || '').trim(), 'bridge', 'bridge.config.json')).json
    return String(json.gameExe || DEFAULT_EXE)
  } catch { return DEFAULT_EXE }
}

/** 游戏 exe 的绝对路径。配置里的相对路径按 bridge/ 解析；越出游戏目录就退回默认名。 */
export function exePath(gameDir) {
  const root = path.resolve(String(gameDir || '').trim())
  const full = path.resolve(path.join(root, 'bridge'), readGameExe(gameDir))
  if (full !== root && full.indexOf(root + path.sep) !== 0) return path.join(root, 'CabinWorld.exe')
  return full
}

/** exe 的文件名，给 tasklist / taskkill 的 IMAGENAME 用。 */
export function exeName(gameDir) {
  return path.basename(exePath(gameDir))
}

/** 「找不到游戏 exe」的统一说法：tail 是各调用方自己补的下半句。 */
export function exeMissingText(exe, tail) { return '找不到 ' + exe + '：' + (tail || '先一键安装') }

/**
 * 路径必须落在 root 里面：拒绝 ..、UNC、跨盘。
 *
 * 放这里而不是 install.mjs：bridgecfg（配置层）要用它，而 bridgecfg 依赖 install
 * 是颠倒的层次（install 依赖 host，host 依赖本文件）。这条 import 曾让 install
 * 无法反过来复用 bridgecfg 的 bridgeDataDir，只能自己复制一份。
 */
export function assertInside(root, p) {
  const base = path.resolve(String(root || ''))
  const target = path.resolve(String(p || ''))
  // Windows 路径不区分大小写：C:\\Game 与 c:\\game 是同一个目录，用原串比会误判成越界。
  const lowerBase = base.toLowerCase()
  const lower = target.toLowerCase()
  if (lower !== lowerBase && !lower.startsWith(lowerBase + path.sep)) throw new Error('路径越界：' + target)
  return target
}

/** bridge/bridge.config.json 的路径。gameDir 是本模块自己的数据目录，不需要越界校验。 */
export function configPath(gameDir) {
  return path.join(String(gameDir || '').trim(), 'bridge', 'bridge.config.json')
}

/**
 * taskkill /IM <名字> 按映像名杀进程。名字配错（比如把 gameExe 改成 node.exe）会把宿主自己的
 * 进程和系统进程一起带走，所以按名字杀之前先拦一下明显不该这么杀的。
 */
const UNSAFE_IMAGENAME = new Set([
  'node.exe', 'python.exe', 'python3.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe',
  'explorer.exe', 'svchost.exe', 'conhost.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe',
])
export function assertKillable(name) {
  if (UNSAFE_IMAGENAME.has(String(name || '').toLowerCase())) {
    throw new Error('游戏 exe 的名字是「' + name + '」，按这个名字结束进程会误杀宿主或系统进程，已拒绝。检查 bridge.config.json 里的 gameExe。')
  }
  return name
}
