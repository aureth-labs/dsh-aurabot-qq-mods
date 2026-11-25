// ego.mjs —— 接入 DSH 侧边浏览器（dsh-ego-browser）作为可选的共享 CDP 后端。
// 全局开关：插件配置 browser.useDshSidebar（主面板「浏览器」页）；关着时本文件完全走不到。
// 契约：createEgoBackend({ getJson, log }) → { ensure(check) → Promise<{ port, shared: true }> }。
// 安全边界：ego 是 DSH 全局共享实例 —— close 只断自己的连接、关自己认领的标签页，
// 绝不杀进程、绝不发 Browser.close；新标签页用 /json/new 认领自己的，绝不碰别人的。
// 状态文件与 dsh-ego-browser 的 paths.mjs 同一套解析：Windows 在 %LOCALAPPDATA%/ego-lite-linux。
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** ego 的运行状态目录（browser.json 所在目录）。 */
export function egoStateFile(env = process.env, plat = process.platform) {
  if (env.EGO_LINUX_STATE_DIR) return join(env.EGO_LINUX_STATE_DIR, 'browser.json')
  const home = env.HOME || env.USERPROFILE || ''
  const base = plat === 'win32'
    ? (env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
    : (env.XDG_STATE_HOME || join(home, '.local', 'state'))
  return join(base, 'ego-lite-linux', 'browser.json')
}

/** 读状态文件里的调试端口；没有 / 坏了 / 没启动返回 0。 */
export function readEgoPort(stateFile = egoStateFile(), read = readFileSync) {
  try {
    const s = JSON.parse(read(stateFile, 'utf8'))
    const p = Number(s?.port)
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0
  } catch { return 0 }
}

/** 定位 dsh-ego-browser 的 CLI（ego-browser.mjs）。DSH_PROFILE_DIR 优先，再找常见 profile 目录。 */
export function findEgoCli(env = process.env, exists = existsSync) {
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
export function findEgoNode(env = process.env, exists = existsSync, execPath = process.execPath) {
  const home = env.HOME || env.USERPROFILE || ''
  const dshHome = env.DSH_HOME || join(home, '.dsh')
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const cands = [
    env.DSH_NODE_BIN || '',
    join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', exe),
    join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', exe),
  ].filter(Boolean)
  for (const c of cands) if (exists(c)) return c
  return execPath
}

/** 端口活着（/json/version 有响应就算）。 */
export async function egoAlive(port, getJson) {
  if (!port) return false
  try { return Boolean(await getJson(`http://127.0.0.1:${port}/json/version`, 1500)) } catch { return false }
}

/**
 * 认领一个属于本模块的标签页：新开自己的 about:blank（PUT，旧内核回退 GET），
 * 新不开不出来才捡一个现成的 about:blank；绝不关闭列表里的其他标签页（那是别人在用的）。
 */
/**
 * 认领一个属于本模块的标签页：优先走 CDP Target.createTarget({ background: true })
 * 在后台建页 —— /json/new 会激活新标签页并把整个窗口顶到前台，定时任务每轮连接
 * 都弹一次窗口、抢一次焦点；后台建页完全不碰焦点。浏览器级 CDP 不可用时退回
 * /json/new（PUT，旧内核回退 GET），并把焦点还给建页前激活的那个标签页。
 * 新不开不出来才捡一个现成的 about:blank；绝不关闭列表里的其他标签页（那是别人在用的）。
 */
export async function acquireEgoTarget(port, getJson, connect) {
  const list = () => getJson(`http://127.0.0.1:${port}/json/list`, 3000).catch(() => [])
  // 先记住当前激活的标签页，/json/new 回退路径要把焦点还给它
  const before = (await list()).find((x) => x.type === 'page')
  // —— 首选：浏览器级 CDP 后台建页，不打扰前台 ——
  if (connect) {
    try {
      const v = await getJson(`http://127.0.0.1:${port}/json/version`, 1500)
      const ws = v?.webSocketDebuggerUrl
      if (ws) {
        const browser = connect(ws)
        try {
          await browser.ready
          const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', background: true }, 3000)
          if (targetId) {
            const fresh = (await list()).find((x) => x.id === targetId && x.type === 'page' && x.webSocketDebuggerUrl)
            if (fresh) return fresh
          }
        } finally { browser.close() }
      }
    } catch { /* 浏览器级连不上就走 /json/new 回退 */ }
  }
  // —— 回退：HTTP 接口建页（会激活新页），把焦点还给之前的标签页 ——
  const url = `http://127.0.0.1:${port}/json/new?about:blank`
  let t = null
  try {
    const r = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(3000) })
    if (r.ok) t = await r.json()
  } catch { /* 旧内核或忙，走下面的回退 */ }
  if (!t?.webSocketDebuggerUrl) { try { t = await getJson(url) } catch { /* 再回退 */ } }
  if (t?.webSocketDebuggerUrl && before?.id && before.id !== t.id) {
    await fetch(`http://127.0.0.1:${port}/json/activate/${before.id}`).catch(() => {})
  }
  if (!t?.webSocketDebuggerUrl) {
    t = (await list()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl && /^about:blank/.test(x.url || '')) || null
  }
  if (!t?.webSocketDebuggerUrl) throw new Error('DSH 侧边浏览器里拿不到可用标签页')
  return t
}

/** ego 后端：ensure() 返回可用的 { port }；没跑就用 DSH 自带的 node 拉起（一行 heredoc，实测可冷启动）。 */
// 拉起 ego-browser 时给子进程的环境。
//
// EGO_LINUX_HEADLESS 会从三个地方漏进来：系统环境变量、宿主进程（DSH 在某些装法下
// 自己就带着 =1）、以及面板里的「headless override」。后两者用户并没有亲手选过，
// 却会跟着 process.env 一路继承下去 —— 结果每次冷启动都起成无头实例：
//   · 没有窗口，人没法扫码登录，登录态一过期就只能干等；
//   · 页面按后台节流渲染，`section.note-item` 拿不到布局，量出来是 0×0，卡片解析
//     全部返回空，调用方退到滚动兜底（xhs 的 b.scroll 就踩在这里）。
// 桌面平台默认带窗口才合理；真要无头（服务器 / CI）显式设 AURABOT_EGO_HEADLESS=1
// 说明意图。Linux 无显示环境仍原样尊重该变量。
export function egoChildEnv(base = process.env, plat = process.platform) {
  const env = { ...base, ELECTRON_RUN_AS_NODE: '1' }
  if (plat !== 'win32' && plat !== 'darwin') return env
  if (/^(1|true|yes|on)$/i.test(String(env.AURABOT_EGO_HEADLESS || ''))) env.EGO_LINUX_HEADLESS = '1'
  else delete env.EGO_LINUX_HEADLESS
  // 窗口落在屏幕外 (-2400,-2400)：共享实例冷启动带窗口（能扫码、布局正常），
  // 但平时不该占据屏幕 / 抢焦点。模块要展示窗口时用 show(true) 经 CDP 把它挪回
  // 屏幕内（Browser.setWindowBounds），看完 show(false) 挪回去；后台标签页照常
  // 渲染（LAUNCH_FLAGS 已带 --disable-backgrounding-occluded-windows 等三个
  // 反节流开关）。仅桌面平台注入；不影响 Linux/CI。
  const extra = String(env.EGO_LINUX_EXTRA_ARGS || '')
  const pos = '--window-position=-2400,-2400'
  if (!extra.includes('--window-position')) {
    env.EGO_LINUX_EXTRA_ARGS = extra ? extra + ' ' + pos : pos
  }
  return env
}

export function createEgoBackend({
  stateFile = egoStateFile(),
  cliPath = () => findEgoCli(),
  nodePath = () => findEgoNode(),
  getJson,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
} = {}) {
  if (!getJson) throw new Error('createEgoBackend 需要 getJson（模块自己的 CDP 拉取函数）')
  let starting = null

  async function coldStart(check) {
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
          env: egoChildEnv(),
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

  async function ensure(check) {
    check?.()
    const port = readEgoPort(stateFile)
    if (await egoAlive(port, getJson)) return { port, shared: true }
    if (starting) return starting.then((p) => ({ port: p, shared: true }))
    starting = (async () => {
      log?.info?.('[ego] 侧边浏览器没在跑，拉起 DSH 共享实例')
      const p = await coldStart(check)
      // --window-position 有启动竞态：Edge 先在默认位置画一帧才应用参数。
      // 冷启动就绪的瞬间用 CDP 把窗口挪到屏幕外，压掉那一闪。
      try {
        const v = await getJson(`http://127.0.0.1:${p}/json/version`, 1500)
        const ws = v?.webSocketDebuggerUrl
        if (ws) {
          const { connectCdp } = await import('./browser.mjs')
          const c = connectCdp(ws)
          try {
            await c.ready
            await c.send('Browser.setWindowBounds', { windowId: 1, bounds: { left: -2400, top: -2400 } }).catch(() => {})
          } finally { c.close() }
        }
      } catch { /* 挪窗失败不影响可用性；--window-position 兜底 */ }
      return p
    })()
    try {
      const p = await starting
      return { port: p, shared: true }
    } finally { starting = null }
  }

  return { ensure, stateFile }
}