// 接入 DSH 侧边浏览器（dsh-ego-browser）作为可选的共享 CDP 后端。
// 全局开关：插件配置 browser.useDshSidebar（主面板「浏览器」页）；关着时本文件完全走不到。
// 契约：createEgoBackend({ getJson, log }) → { ensure(check) → Promise<{ port, shared: true }> }。
// 安全边界：ego 是 DSH 全局共享实例 —— close 只断自己的连接、关自己认领的标签页，
// 绝不杀进程、绝不发 Browser.close；新标签页用 /json/new 认领自己的，绝不碰别人的。
// 状态文件与 dsh-ego-browser 的 paths.mjs 同一套解析：Windows 在 %LOCALAPPDATA%/ego-lite-linux。
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** ego 的运行状态目录（browser.json 所在目录）。 */
export function egoStateFile (env = process.env, plat = process.platform) {
  if (env.EGO_LINUX_STATE_DIR) return join(env.EGO_LINUX_STATE_DIR, 'browser.json')
  const home = env.HOME || env.USERPROFILE || ''
  const base = plat === 'win32'
    ? (env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
    : (env.XDG_STATE_HOME || join(home, '.local', 'state'))
  return join(base, 'ego-lite-linux', 'browser.json')
}

/** 读状态文件里的调试端口；没有 / 坏了 / 没启动返回 0。 */
export function readEgoPort (stateFile = egoStateFile(), read = readFileSync) {
  try {
    const s = JSON.parse(read(stateFile, 'utf8'))
    const p = Number(s?.port)
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0
  } catch { return 0 }
}

/** 定位 dsh-ego-browser 的 CLI（ego-browser.mjs）。DSH_PROFILE_DIR 优先，再找常见 profile 目录。 */
export function findEgoCli (env = process.env, exists = existsSync) {
  const home = env.HOME || env.USERPROFILE || ''
  const dshHome = env.DSH_HOME || join(home, '.dsh')
  const roots = []
  if (env.DSH_PROFILE_DIR) roots.push(env.DSH_PROFILE_DIR)
  roots.push(join(dshHome, 'profiles', 'desktop'), join(dshHome, 'profiles', 'web'))
  for (const r of roots) {
    const p = join(r, 'node_modules', 'dsh-ego-browser', 'runtime', 'ego-linux', 'bin', 'ego-browser.mjs')
    if (exists(p)) return p
  }
  return ''
}

/** 能跑 CLI 的 node：DSH 自带运行时优先，退回宿主进程本身（电子壳里靠 ELECTRON_RUN_AS_NODE）。 */
export function findEgoNode (env = process.env, exists = existsSync, execPath = process.execPath) {
  const home = env.HOME || env.USERPROFILE || ''
  const dshHome = env.DSH_HOME || join(home, '.dsh')
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const cands = [
    env.DSH_NODE_BIN || '',
    join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', exe),
    join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', exe)
  ].filter(Boolean)
  for (const c of cands) if (exists(c)) return c
  return execPath
}

/** 端口活着（/json/version 有响应就算）。 */
export async function egoAlive (port, getJson) {
  if (!port) return false
  try { return Boolean(await getJson(`http://127.0.0.1:${port}/json/version`, 1500)) } catch { return false }
}

/**
 * 认领一个属于本模块的标签页：新开自己的 about:blank（PUT，旧内核回退 GET），
 * 新不开不出来才捡一个现成的 about:blank；绝不关闭列表里的其他标签页（那是别人在用的）。
 */
export async function acquireEgoTarget (port, getJson) {
  const url = `http://127.0.0.1:${port}/json/new?about:blank`
  let t = null
  try {
    const r = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(3000) })
    if (r.ok) t = await r.json()
  } catch { /* 旧内核或忙，走下面的回退 */ }
  if (!t?.webSocketDebuggerUrl) { try { t = await getJson(url) } catch { /* 再回退 */ } }
  if (!t?.webSocketDebuggerUrl) {
    const list = (await getJson(`http://127.0.0.1:${port}/json/list`, 3000).catch(() => null)) || []
    t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl && /^about:blank/.test(x.url || '')) || null
  }
  if (!t?.webSocketDebuggerUrl) throw new Error('DSH 侧边浏览器里拿不到可用标签页')
  return t
}

/** ego 后端：ensure() 返回可用的 { port }；没跑就用 DSH 自带的 node 拉起（一行 heredoc，实测可冷启动）。 */
export function createEgoBackend ({
  stateFile = egoStateFile(),
  cliPath = () => findEgoCli(),
  nodePath = () => findEgoNode(),
  getJson,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  log
} = {}) {
  if (!getJson) throw new Error('createEgoBackend 需要 getJson（模块自己的 CDP 拉取函数）')
  let starting = null

  async function coldStart (check) {
    const cli = cliPath()
    if (!cli) throw new Error('找不到 dsh-ego-browser（DSH 侧边浏览器未安装）：关掉「使用 DSH 侧边浏览器」即可回退专用浏览器')
    const node = nodePath()
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, v) => { if (settled) return; settled = true; fn(v) }
      let child
      try {
        child = execFile(node, [cli], {
          windowsHide: true,
          timeout: 45000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        }, () => {
          // 脚本执行完但端口没就绪也按失败处理（下一轮错误提示会带上端口没开）
          if (readEgoPort(stateFile)) return
          done(reject, new Error('DSH 侧边浏览器拉起后没有写出调试端口'))
        })
      } catch (error) { done(reject, error); return }
      try { child.stdin?.end("console.log('aurabot-ego-ready')\n") } catch { /* 进程可能已退 */ }
      ;(async () => {
        for (let i = 0; i < 70; i++) {
          await wait(500)
          try { check?.() } catch (error) { try { child.kill() } catch { /* 已退 */ } done(reject, error); return }
          const p = readEgoPort(stateFile)
          if (p && await egoAlive(p, getJson)) { done(resolve, p); return }
        }
        try { child.kill() } catch { /* 已退 */ }
        done(reject, new Error('DSH 侧边浏览器 35 秒内没就绪（调试端口没开）'))
      })()
    })
  }

  async function ensure (check) {
    check?.()
    const port = readEgoPort(stateFile)
    if (await egoAlive(port, getJson)) return { port, shared: true }
    if (starting) return starting.then((p) => ({ port: p, shared: true }))
    starting = (async () => {
      log?.info?.('[ego] 侧边浏览器没在跑，拉起 DSH 共享实例')
      return coldStart(check)
    })()
    try {
      const p = await starting
      return { port: p, shared: true }
    } finally { starting = null }
  }

  return { ensure, stateFile }
}
