// 读写 bridge/bridge.config.json：只改指定键，保留 _说明 和其他字段；写前自动备份。
// 名字要通过重启桥才生效（桥启动时 loadConfig 读一次）。

import fs from 'node:fs'
import path from 'node:path'

import { ensureHost, startHost, hostPidFile, killBridge, waitBridge, PATCHES, bridgeAlive } from './host.mjs'
import { exePath, assertInside, readJsonFile, configPath, exeMissingText } from './exe.mjs'

export function readBridgeConfig(gameDir) {
  const file = configPath(gameDir)
  return { file, ...readJsonFile(file) }
}

export function bridgeConfigInfo(gameDir) {
  const got = readBridgeConfig(gameDir)
  const http = got.json.http || {}
  const weather = got.json.weather || {}
  assertInside(gameDir, path.resolve(path.join(String(gameDir || '').trim(), 'bridge'), String(got.json.gameExe || '../CabinWorld.exe')))
  return {
    file: got.file,
    displayName: String(got.json.displayName || ''),
    hostName: String(got.json.hostName || ''),
    resident: String(got.json.resident || ''),
    port: Number(http.port == null ? 18790 : http.port),
    launchGame: got.json.launchGame !== false,
    weatherMode: String(weather.mode || 'virtual'),
    waitMs: Number(got.json.waitMs == null ? 45000 : got.json.waitMs),
    dataDir: String(got.json.dataDir || '../data'),
    gameExe: String(got.json.gameExe || '../CabinWorld.exe'),
  }
}

// exePath 在 lib/exe.mjs：host.mjs、install.mjs 也要用，放在本文件会成环。

export function writeBridgeConfig(gameDir, patch, forget) {
  const got = readBridgeConfig(gameDir)
  const next = JSON.parse(JSON.stringify(got.json))
  const applied = []
  if (patch.displayName !== undefined) { next.displayName = String(patch.displayName); applied.push('displayName') }
  if (patch.hostName !== undefined) { next.hostName = String(patch.hostName); applied.push('hostName') }
  if (patch.launchGame !== undefined) { next.launchGame = patch.launchGame === true; applied.push('launchGame') }
  if (patch.weatherMode !== undefined) {
    next.weather = Object.assign({}, next.weather || {})
    next.weather.mode = patch.weatherMode === 'push' ? 'push' : 'virtual'
    applied.push('weather.mode')
  }
  if (patch.port !== undefined) {
    const p = Number(patch.port)
    if (!Number.isFinite(p) || p < 0 || p > 65535) throw new Error('端口不对：' + patch.port)
    next.http = Object.assign({}, next.http || {})
    next.http.port = Math.round(p)
    applied.push('http.port')
  }
  if (!applied.length) return { file: got.file, backup: '', applied }
  const backup = got.file + '.bak-' + Date.now()
  fs.copyFileSync(got.file, backup)
  // 后缀带随机数：两个写请求落同一毫秒时，.tmp-<ts> 会撞名。
  const tmp = got.file + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, got.file)
  if (typeof forget === 'function') { try { forget() } catch { /* 缓存清不掉不影响写入 */ } }
  return { file: got.file, backup, applied }
}

/** 桥的 data 目录（相对 bridge 文件夹）。 */
export function bridgeDataDir(gameDir) {
  const info = bridgeConfigInfo(gameDir)
  return assertInside(gameDir, path.resolve(path.join(String(gameDir).trim(), 'bridge'), info.dataDir || '../data'))
}

/** 重启桥：按 bridge.json 里的 pid 关掉旧的，同步宿主副本（bridge-host），再用副本启动。 */
export async function restartBridge({ gameDir, dataDir, log, forget }) {
  const dir = String(gameDir || '').trim()
  const bridgeJson = path.join(String(dataDir || '').trim(), 'bridge.json')
  let pid = 0
  try { pid = Number(readJsonFile(bridgeJson).json.pid) || 0 } catch { /* 没有 bridge.json 就是没有旧桥 */ }
  // 先停自己的副本桥（host.pid）、再停 bridge.json 里那座（可能是官方 start.cmd 起的）。
  // 只按命令行确认身份后才动手：副本桥是插件宿主 spawn 出来的，按父进程杀会把机器人本体一起杀掉。
  let hostPid = 0
  try { hostPid = Number(fs.readFileSync(hostPidFile(dir), 'utf8')) || 0 } catch { /* 没有 host.pid */ }
  const tried = []
  for (const p of [hostPid, pid]) {
    if (!p || tried.indexOf(p) >= 0) continue
    tried.push(p)
    const stopped = killBridge(p, dir)
    if (log) log.info(stopped.killed ? '小屋世界：已停掉' + stopped.why + '（pid ' + p + '）' : '小屋世界：' + stopped.why)
  }
  // 先确认「官方桥和 exe 都在」再动手杀：校验放在杀之后的话，一旦失败就会留下
  // 「游戏被关、桥被杀」却没有桥能用的状态（bridge/bridge.mjs 被删或被杀毒隔离时）。
  let exe = ''
  try { exe = exePath(dir) } catch (e) { return { ok: false, message: '读不到桥配置里的游戏 exe：' + String((e && e.message) || e) } }
  if (!fs.existsSync(path.join(dir, 'bridge', 'bridge.mjs'))) return { ok: false, message: '找不到官方桥：' + path.join(dir, 'bridge', 'bridge.mjs') + '（先用 /小屋 安装）' }
  if (!fs.existsSync(exe)) return { ok: false, message: exeMissingText(exe) }
  if (tried.length) {
    await new Promise(function (r) { setTimeout(r, 2500) })
    // 要检查所有试过的 pid：host.pid 里那座副本桥可能还活着，而 bridge.json 里的 pid 是 0 或过期。
    // 只盯 pid 会放行到 ensureHost，随后 rename bridge-host 必然 EPERM。
    // 必须验身份：pid 被系统复用给无关进程时，killBridge 说「不是小屋世界的桥」，
    // 而纯存活检查说「还活着」，于是每次点重启都得到同一句「关不掉」。
    const alive = tried.filter(function (p) { return bridgeAlive(p, dir) })
    if (alive.length) return { ok: false, message: '旧的桥进程 ' + alive.join('、') + ' 关不掉，所以没有起新的桥：去任务管理器结束它再试一次。' }
  }
  // 这几条都是"能预期到的失败"，统一用 {ok,message} 返回：三个调用方都按返回值处理，
  // throw 出来会变成未捕获异常（/小屋 启动 只回一句空话，面板 500）。
  const synced = await ensureHost({ gameDir: dir, patchesScript: PATCHES, log: log || console })
  if (!synced.ok) return { ok: false, message: synced.message }
  // 补丁没打上：桥能跑，但 sleep / toolpose 这两个工具不存在。
  if ((synced.degraded || synced.patched === false) && log && log.warn) log.warn('小屋世界：' + String(synced.message || '补丁没打上'))
  const started = startHost({ gameDir: dir, configPath: configPath(dir), log: log || console })
  if (!started.ok) return { ok: false, message: started.message }
  let seen = ''
  const waited = await waitBridge(async function () {
    const info = readJsonFile(bridgeJson).json
    if (!String(info.url || '')) return null
    seen = String(info.url)
    const res = await fetch(seen + '/v1/health', { signal: AbortSignal.timeout(3000) })
    const body = await res.json()
    return { row: body, done: !!(body && body.ok === true) }
  }, 25000)
  if (waited.hit) {
    if (typeof forget === 'function') { try { forget() } catch { /* 缓存清不掉不影响重启 */ } }
    return { ok: true, url: seen, game: waited.row.game === true }
  }
  return { ok: false, message: '桥重启后 25 秒内没连上' + (waited.row ? '（最后一次：' + JSON.stringify(waited.row) + '）' : '') + '：看 bridge-host/host.log 末尾有没有报错，或端口被占。' }
}
