// 专用浏览器模块：独立用户资料目录的 Edge / Chrome，经 CDP（Node 自带 WebSocket）控制。
// 只管「开 / 连 / 点 / 打字 / 截图 / 等接口返回」这些通用动作，站点相关的都在 site.mjs。
// 不用无头模式：多数站点会拦无头浏览器（页面一直「加载中」）。Linux 没桌面就配 Xvfb。

import { createServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// 顺序：显式环境变量 → Chrome → Edge（找不到 Chrome 才用 Edge）
const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean)

// 启动等待预算：冷启动 + 杀毒逐个扫 chrome 的子进程时，15 秒经常不够，
// 短了会把「启动慢」误报成「浏览器没起来，请检查路径」。（同 douyin 2.3.9 的修法）
const LAUNCH_POLL_MS = 250
const LAUNCH_POLLS = 120
const LAUNCH_TIMEOUT_SEC = (LAUNCH_POLL_MS * LAUNCH_POLLS) / 1000

/** 是不是一个能直接执行的浏览器文件（目录、非可执行文件都不算）。 */
function isBrowserExe (p, exists = existsSync) {
  try {
    if (!exists(p)) return false
    if (!lstatSync(p).isFile()) return false
    return process.platform !== 'win32' || /\.exe$/i.test(p)
  } catch (error) {
    return false
  }
}

/** 找浏览器：面板填了且真实可用就用填的；填的路径不存在（磁盘清理/搬移后很常见）就回退去常见安装位置探测，Chrome 优先，再找 Edge / Chromium。 */
export function findBrowser (explicit = '', exists = existsSync) {
  if (explicit && isBrowserExe(explicit, exists)) return explicit
  return CANDIDATES.find((p) => isBrowserExe(p, exists)) || ''
}

/** 本机空闲端口。 */
export function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** 老版本写进第二行的固定标记（那时还没记录真实 ws 路径）。 */
const LEGACY_OWNER = '/devtools/browser/aurabot'

/** 从 ws 地址里取路径部分（/devtools/browser/<uuid>），用来确认端口是不是我们自己的。 */
function wsPath (ws) {
  try { return new URL(String(ws)).pathname } catch (error) { return '' }
}

/** 资料目录里记下的调试端口与归属路径（我们启动时自己写的；DSH 重启后靠它接回已经开着的窗口）。 */
export function readPortInfo (profileDir, read = readFileSync) {
  try {
    const lines = String(read(join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)
    const n = Number(String(lines[0] || '').trim())
    const port = Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
    return { port, owner: String(lines[1] || '').trim() }
  } catch (error) {
    return { port: 0, owner: '' }
  }
}

/** 从标签页列表里挑要用的那个：优先目标站点页，没有就第一个普通页。
 *  其余同站页一并返回，好关掉（多点几次面板不会越攒越多）。 */
export function pickPage (targets, siteRe = /^https:\/\/[^/]*hongguoduanju\.com/) {
  const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const ours = pages.filter((t) => siteRe.test(t.url || ''))
  const page = ours[0] || pages[0] || null
  return { page, extra: ours.slice(1) }
}

/** 关掉一个标签页：带超时，别让共享实例忙的时候把关闭流程挂住。 */
function closeTab (port, id) {
  if (!port || !id) return Promise.resolve()
  return fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {})
}

async function getJson (url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

/** 调试地址必须指向本机（端口也要对得上）：本机伪造的 /json/* 不能把输入、截图引到别处去。 */
export function assertLocalWs (wsUrl, expectPort = 0) {
  let u
  try { u = new URL(String(wsUrl)) } catch (error) { throw new Error(`浏览器给的调试地址不是合法 URL：${wsUrl}`) }
  if (u.protocol !== 'ws:') throw new Error(`调试地址协议不对：${wsUrl}`)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`调试地址不在本机（${host}），拒绝连接`)
  if (expectPort && String(u.port) !== String(expectPort)) throw new Error(`调试地址端口不对（${u.port} ≠ ${expectPort}），拒绝连接`)
}

/** 一条 CDP 连接：send 发命令，on 收事件。 */
export function connectCdp (wsUrl, { WS = globalThis.WebSocket, expectPort = 0 } = {}) {
  if (!WS) throw new Error('当前 Node 没有 WebSocket（要 Node 22 以上）')
  assertLocalWs(wsUrl, expectPort)
  const sock = new WS(wsUrl)
  let nextId = 1
  let closed = false
  const pending = new Map()
  const listeners = new Map()
  sock.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch (error) { return }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 出错'))
      else p.resolve(msg.result || {})
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) try { fn(msg.params || {}) } catch (error) {}
    }
  })
  let finishReady = () => {}
  sock.addEventListener('close', () => {
    closed = true
    finishReady(new Error('浏览器连接断了'))
    for (const p of pending.values()) p.reject(new Error('浏览器连接断了'))
    pending.clear()
  })
  const ready = new Promise((resolve, reject) => {
    let done = false
    const t = setTimeout(() => finishReady(new Error('连不上浏览器调试端口')), 10000)
    finishReady = (error) => {
      if (done) return
      done = true
      clearTimeout(t)
      if (error) reject(error)
      else resolve()
    }
    sock.addEventListener('open', () => finishReady())
    sock.addEventListener('error', () => finishReady(new Error('连不上浏览器调试端口')))
  })
  return {
    ready,
    get closed () { return closed },
    send (method, params = {}, ms = 30000) {
      if (closed) return Promise.reject(new Error('浏览器连接断了'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器没响应（${method}）`)) }, ms)
        pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
        try { sock.send(JSON.stringify({ id, method, params })) } catch (error) { pending.delete(id); clearTimeout(t); reject(error) }
      })
    },
    on (method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => listeners.get(method)?.delete(fn)
    },
    close () { try { sock.close() } catch (error) {} }
  }
}

/** Windows 按进程树关闭；只传入本次 spawn 返回的进程号。 */
function windowsKillTree (pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error))
  })
}

/**
 * 专用浏览器。open() 才会真的启动 / 连接；只读状态的地方不要调它（打开面板不该弹窗口）。
 * 只接回本实例启动的进程：旧端口文件和 SingletonLock 都不能证明其他进程是我们的。
 */
export function createBrowser ({
  profileDir, browserPath = () => '', log, now = Date.now,
  spawnProcess = spawn, getPort = freePort, getBrowserJson = getJson, connect = connectCdp,
  wait = sleep, platform = process.platform,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  killTree = windowsKillTree, stopWaitMs = 3000, stderrWaitMs = 250
} = {}) {
  let cdp = null
  let attaching = null
  let opening = null
  let openingSource = ''
  let closing = null
  let owned = null
  let generation = 0
  let failures = 0
  let retryAt = 0
  let lastError = ''

  const connected = () => Boolean(owned && !owned.exited && !owned.needsStop && cdp && !cdp.closed)

  const cancelled = () => Object.assign(new Error('红果没打开，请先打开红果开关'), { code: 'cancelled' })
  const lockError = () => new Error('红果浏览器资料目录被占用（SingletonLock / profile appears to be in use），请先关闭占用该目录的浏览器')

  // Linux 的 SingletonLock 往往是指向不存在路径的符号链接，existsSync 会漏掉。
  function hasLock () {
    try { lstatSync(join(profileDir, 'SingletonLock')); return true } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  function observe (child, port) {
    let done
    let outputDone
    const p = { child, port, exited: false, error: null, stderr: '', done: new Promise((resolve) => { done = resolve }), outputClosed: false, outputDone: new Promise((resolve) => { outputDone = resolve }), stopping: null, needsStop: false, terminate: null }
    child.on('error', (error) => {
      p.error = error
      if (!child.pid) { p.exited = true; done() }
    })
    child.once('exit', () => {
      p.exited = true
      done()
      if (owned === p) { attaching?.close(); cdp?.close(); cdp = null }
    })
    child.once('close', () => { p.outputClosed = true; outputDone() })
    child.stderr?.on('data', (data) => { p.stderr = (p.stderr + String(data)).slice(-4000) })
    child.stderr?.on('error', () => {})
    child.stderr?.unref?.()
    return p
  }

  function waitExit (p, ms) {
    if (p.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      p.done.then(() => { clearTimeout(timer); resolve() })
    })
  }

  // exit 可能先于 stderr 数据到达，稍等输出关闭才能认出资料目录锁错误。
  function waitOutput (p) {
    if (!p?.exited || p.outputClosed || !p.child.stderr) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, stderrWaitMs)
      p.outputDone.then(() => { clearTimeout(timer); resolve() })
    })
  }

  /** 结束自己启动的浏览器及其子进程；没确认退出前不允许启动下一个。 */
  async function stopOwned (p) {
    if (!p) return
    if (p.stopping) return p.stopping
    p.needsStop = true
    p.stopping = Promise.resolve().then(async () => {
      // 先走浏览器的正常退出，避免留下旧锁。必须用「浏览器级」连接：
      // 页面级 session 上发 Browser.close 会 -32601；接管来的窗口（pid 为 0）也只能靠它关。
      if (!p.exited && p.port) {
        let bc = null
        let closed = false
        try {
          bc = await browserConn(p.port)
          await bc.send('Browser.close', {}, 3000)
          closed = true
        } catch (error) {
        } finally {
          try { bc?.close() } catch (error) {}
        }
        // 接管来的窗口没有自己的进程可观察（pid 为 0）：确认关掉就别再干等 3 秒；
        // 连 close 都没发出去时不能假装它已退出，否则端口记录被删、下次启动撞锁
        if (closed && !p.child.pid) p.exited = true
        await waitExit(p, stopWaitMs)
      }
      if (!p.exited && p.terminate) { p.terminate.close(); p.terminate = null }
      if (!p.exited && p.child.pid) {
        if (platform === 'win32') {
          let killed = false
          try { killed = await killTree(p.child.pid) } catch (error) {}
          if (!killed && !p.exited) try { p.child.kill('SIGKILL') } catch (error) {}
        } else {
          // 正常退出不可用时结束整个自有进程组，避免主进程退出后子进程残留。
          try { killGroup(p.child.pid, 'SIGKILL') } catch (error) { try { p.child.kill('SIGKILL') } catch (e) {} }
        }
        await waitExit(p, stopWaitMs)
        if (!p.exited) {
          try { p.child.kill('SIGKILL') } catch (error) {}
          await waitExit(p, stopWaitMs)
        }
      }
      if (p.terminate) { p.terminate.close(); p.terminate = null }
      if (!p.exited && p.child.pid) {
        // 先解绑再抛：否则本进程之后每次启动都会撞上 needsStop 反复抛，浏览器再也打不开
        if (owned === p) owned = null
        throw new Error('无法确认自己启动的浏览器已退出，请检查该进程')
      }
      // 接管来的窗口（没有自己的进程可观察）：连 Browser.close 都没发出去就是没关掉。
      // 这时不能删端口记录 —— 留着它，下次启动才能接回那个还开着的窗口
      if (!p.exited && !p.child.pid && p.port) {
        if (owned === p) owned = null
        throw new Error('接管来的窗口没能关掉（Browser.close 没发出去），请手动关闭它')
      }
      // 自己的窗口确实关了，端口记录也作废，下次别去接它
      try { rmSync(join(profileDir, 'DevToolsActivePort'), { force: true }) } catch (error) {}
      if (owned === p) owned = null
    })
    try { await p.stopping } finally { p.stopping = null }
  }

  /** 新开 about:blank：新内核要求 PUT，老内核只认 GET。 */
  async function newBlankTab (port) {
    const url = `http://127.0.0.1:${port}/json/new?about:blank`
    try {
      const r = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(3000) })
      if (r.ok) return await r.json()
    } catch (error) {}
    return getBrowserJson(url)
  }

  /** 走「浏览器级」连接：页面级 session 上发 Browser.* 会 -32601。 */
  async function browserConn (port) {
    const ver = await getBrowserJson(`http://127.0.0.1:${port}/json/version`, 1500)
    if (!ver?.webSocketDebuggerUrl) throw new Error('拿不到浏览器的调试地址')
    const c = connect(ver.webSocketDebuggerUrl, { expectPort: port })
    // 关闭流程不该被一个没响应的浏览器拖到 10 秒：这里单独给 3 秒
    let timer = null
    try {
      await Promise.race([c.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('浏览器没响应')), 3000) })])
    } catch (error) {
      try { c.close() } catch (closeError) {}
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    return c
  }

  async function attach (port, check) {
    const { page, extra } = pickPage(await getBrowserJson(`http://127.0.0.1:${port}/json/list`))
    check()
    for (const t of extra) await closeTab(port, t.id)
    let target = page
    if (!target) target = await newBlankTab(port).catch(() => null)
    check()
    if (!target?.webSocketDebuggerUrl) throw new Error('浏览器里没有能控制的标签页')
    const c = connect(target.webSocketDebuggerUrl, { expectPort: port })
    attaching = c
    try {
      await c.ready
      check()
      await c.send('Page.enable')
      await c.send('Runtime.enable')
      await c.send('Page.setMuted', { muted: true }).catch(() => {}) // 老版本没有这个命令，静音再靠 --mute-audio
      check()
      cdp = c
    } catch (error) {
      c.close()
      throw error
    } finally {
      if (attaching === c) attaching = null
    }
  }

  function launchError (error, p, why = '') {
    const detail = [error?.message, p?.error?.message, p?.stderr?.trim()].filter(Boolean).join('；')
    if (/SingletonLock|profile appears to be in use/i.test(detail)) return lockError()
    // 有具体报错就原样报，别再合并成一句怪路径的话——历史上把「进程静默退出」「启动太慢」
    // 全报成「浏览器没起来，请检查浏览器路径和专用资料目录」，路径明明是对的，用户查路径查不出问题。
    if (detail) return new Error(detail)
    if (p?.exited) return new Error('浏览器进程启动后自己退出了，没有任何报错输出。最常见原因：已经有一个用同一资料目录的浏览器在跑（浏览器自动更新重启 / 上次的窗口没关干净；专用窗口平时放在屏幕外看不见）；另外磁盘清理或「把软件搬到别的盘」会弄坏浏览器安装（路径还在但起不来）。先在任务管理器结束全部 chrome.exe / msedge.exe 再重试；还不行就修复 / 重装浏览器，或在面板换一个浏览器路径')
    if (why === 'timeout') return new Error(`浏览器进程 ${LAUNCH_TIMEOUT_SEC} 秒内没开出调试端口（进程还活着，路径多半没问题，是启动太慢或被杀毒软件拦了）。稍等再试一次；反复出现就检查杀毒软件对浏览器的拦截`)
    return new Error('浏览器没起来，请检查浏览器路径和专用资料目录')
  }

  async function launch (source, check) {
    let p = owned
    try {
      check()
      if (p?.exited || p?.needsStop) { await stopOwned(p); p = null }
      if (p) {
        cdp?.close()
        cdp = null
        await attach(p.port, () => { check(); if (p.exited || p.error) throw launchError(null, p) })
        return
      }
      // DSH 被强制重启时上一个窗口还开着：接回去，不然它一直占着资料目录。
      // 端口文件可能是别的浏览器 / 别的程序写的：要求 /json/version 的 ws 路径与记录一致才接管
      //（老版本写的是固定标记，认它，不然升级后就接不回自己的窗口）。
      const left = readPortInfo(profileDir)
      if (left.port) {
        const ver = await getBrowserJson(`http://127.0.0.1:${left.port}/json/version`, 1500).catch(() => null)
        const mine = ver?.webSocketDebuggerUrl && (!left.owner || left.owner === LEGACY_OWNER || wsPath(ver.webSocketDebuggerUrl) === left.owner)
        if (mine) {
          check()
          p = owned = { child: { pid: 0, kill () {} }, port: left.port, exited: false, error: null, stderr: '', done: new Promise(() => {}), outputClosed: true, outputDone: Promise.resolve() }
          await attach(left.port, check)
          return
        }
      }
      if (hasLock()) throw lockError()
      const path = browserPath()
      const bin = findBrowser(path)
      if (!bin) throw new Error(path ? `浏览器路径不对：${path}（这个文件不存在或不可执行，常见安装位置也没找到 Chrome / Edge；先装一个，或把路径改成 chrome.exe / msedge.exe 的完整路径）` : '找不到 Chrome / Edge，先装一个，或在面板里填浏览器路径')
      if (path && bin !== path) log?.warn?.(`面板填的浏览器路径不存在：${path}，已自动改用 ${bin}`)
      mkdirSync(profileDir, { recursive: true })
      const port = await getPort()
      check()
      // 在分配端口期间也可能有别的浏览器占用资料目录。
      if (hasLock()) throw lockError()
      check()
      log?.info?.(`启动红果专用浏览器，触发来源：${source}`)
      const child = spawnProcess(bin, [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        // 窗口在屏幕外也照常播放视频、跑页面脚本（不然会被当成后台窗口限速）
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
        '--window-size=1280,860',
        '--window-position=-2400,-2400', // 放到屏幕外，不抢前台；要看的时候 show()
        'about:blank'
      ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
      p = owned = observe(child, port)
      child.unref()
      for (let i = 0; i < LAUNCH_POLLS; i++) {
        await wait(LAUNCH_POLL_MS)
        check()
        if (p.exited || p.error) throw launchError(null, p)
        const version = await getBrowserJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)
        check()
        if (p.exited || p.error) throw launchError(null, p)
        if (version) {
          // Edge 经常不写这个文件，自己写一份（含真实的 ws 路径，下次靠它确认端口是不是我们自己的）
          const owner = wsPath(version.webSocketDebuggerUrl) || LEGACY_OWNER
          try { writeFileSync(join(profileDir, 'DevToolsActivePort'), `${port}\n${owner}\n`) } catch (error) {}
          await attach(port, () => { check(); if (p.exited || p.error) throw launchError(null, p) })
          return
        }
      }
      throw launchError(null, p, 'timeout')
    } catch (error) {
      try { await stopOwned(p) } catch (stopError) { throw new Error(`${launchError(error, p).message}；${stopError.message}`) }
      if (error.code === 'cancelled') throw error
      await waitOutput(p)
      throw launchError(error, p)
    }
  }

  /** 连上自己启动的浏览器；失败统一退避，手动和定时入口共用。 */
  async function open (source = '主人要求', canStart = () => true) {
    if (closing) await closing
    if (!canStart()) return { ok: false, message: '红果没打开，请先打开红果开关' }
    if (connected()) return { ok: true }
    if (opening) {
      const pendingSource = openingSource
      const started = generation
      const result = await opening
      // 定时启动被关闭开关取消时，登录不能跟着失败，改由登录来源重新启动。
      if (source === '登录' && pendingSource !== '登录' && !result.ok && canStart() && generation === started && now() >= retryAt) return open(source, canStart)
      return result
    }
    if (now() < retryAt) return { ok: false, message: `${lastError}；浏览器将在 ${Math.ceil((retryAt - now()) / 60_000)} 分钟后重试` }
    const started = generation
    const check = () => { if (generation !== started || !canStart()) throw cancelled() }
    // 延后执行，确保同步抛错也能清除 opening，不会把失败结果一直缓存。
    openingSource = source
    opening = Promise.resolve().then(async () => {
      try {
        await launch(source, check)
        check()
        failures = 0
        retryAt = 0
        lastError = ''
        return { ok: true }
      } catch (error) {
        if (error.code === 'cancelled' || generation !== started || !canStart()) {
          if (owned && !owned.exited && cdp && !cdp.closed) owned.terminate ||= cdp
          else cdp?.close()
          cdp = null
          try { await stopOwned(owned) } catch (stopError) { log?.warn?.('关闭红果浏览器失败：', stopError.message) }
          return { ok: false, message: error.message }
        }
        failures++
        const delay = Math.min(60, 5 * 2 ** Math.min(failures - 1, 4))
        retryAt = now() + delay * 60_000
        lastError = error.message
        log?.warn?.(`红果浏览器启动失败：${lastError}；${delay} 分钟后重试`)
        return { ok: false, message: `${lastError}；浏览器将在 ${delay} 分钟后重试` }
      }
    }).finally(() => { opening = null; openingSource = '' })
    return opening
  }

  function need () {
    if (!connected()) throw new Error('浏览器没连上')
    return cdp
  }

  /** 页面操作的默认超时集中在这里，改一处就够。 */
  const TIMEOUT = { eval: 30000, load: 8000 }

  /** 在页面里跑一段表达式，返回值（可以是 Promise）。 */
  async function evaluate (expression, ms = TIMEOUT.eval) {
    const r = await need().send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text || '页面脚本出错')
    return r.result?.value
  }

  /** 打开网址，等页面加载完（最多 ms；load 事件常常很晚，后面再按需等具体元素）。 */
  async function goto (url, ms = TIMEOUT.load) {
    const c = need()
    let timedOut = false
    const loaded = new Promise((resolve) => {
      const off = c.on('Page.loadEventFired', () => { off(); resolve() })
      setTimeout(() => { off(); timedOut = true; resolve() }, ms)
    })
    await c.send('Page.navigate', { url })
    await loaded
    if (timedOut) {
      // load 事件晚到不代表导航失败，但拿不准时调用方会读到上一页：确认真到了目标地址
      const here = String(await evaluate('location.href').catch(() => ''))
      // 只去掉 hash：query 也算地址的一部分，否则同路径不同 series_id 会被当成「到了」
      const base = String(url).split('#')[0]
      if (!here || !here.startsWith(base)) throw new Error(`页面没打开：${url}`)
    }
  }

  /** 真鼠标点一下（页面看到的是正常的点击事件，不是脚本 .click()）。 */
  async function click (x, y) {
    const c = need()
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      await sleep(40 + Math.random() * 60)
    }
  }

  /**
   * 点一个元素。页面看得见时用真鼠标点在它中间；看不见时（锁屏、关屏、窗口被系统判成被遮挡）
   * 浏览器会吞掉模拟的鼠标输入，只能在页面里派发鼠标事件。找不到元素返回 false。
   */
  async function press (selector) {
    const r = await evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)})
      if (!n) return null
      n.scrollIntoView({ block: 'center', inline: 'center' })
      if (document.visibilityState !== 'visible') {
        for (const t of ['mouseover', 'mousedown', 'mouseup', 'click']) n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }))
        return { dom: true }
      }
      const b = n.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })()`)
    if (!r) return false
    if (!r.dom) await click(r.x, r.y)
    return true
  }

  /** 截图（可截一块），返回 data:image/png。 */
  async function screenshot (clip) {
    const r = await need().send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    return r.data ? 'data:image/png;base64,' + r.data : ''
  }

  /** 窗口挪到屏幕里给人看 / 挪回屏幕外。默认是「给人看」：
   *  面板调 show() 不传参，之前 visible=undefined 会走「挪到屏幕外」那条分支，
   *  于是点「显示浏览器窗口」= 把窗口推到 -2400 —— 表现为「提示成功但窗口永远出不来」。 */
  async function show (visible = true) {
    // 没连上（模块热重载、DSH 重启后 CDP 连接会丢，窗口还在但连接断了）就先接回去/拉起来，
    // 否则 need() 直接抛「浏览器没连上」，而面板照旧提示成功 —— 看起来就是「点了没反应」。
    if (!connected()) {
      retryAt = 0 // 手动点的操作不排队等自动重试的退避
      failures = 0
      const r = await open('显示窗口', () => true)
      if (!r.ok) throw new Error(r.message || '浏览器打不开')
    }

    // 🔴 窗口操作必须走「浏览器级」连接：页面级 session 上 Browser.getWindowForTarget
    // 会报 -32000 "Browser window not found"（页面会话没有窗口上下文），窗口一步都挪不动。
    const port = owned?.port
    if (!port) throw new Error('拿不到浏览器的调试端口，点「开始登录」重开一次')
    let bc = null
    let placed = false
    try {
      // 刚启动/刚重启时窗口可能还没建好，重试几秒
      for (let i = 0; i < 24 && !placed; i++) {
        const ver = await getBrowserJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)
        if (ver?.webSocketDebuggerUrl) {
          if (!bc) { bc = connectCdp(ver.webSocketDebuggerUrl, { expectPort: port }); await bc.ready }
          const list = await getBrowserJson(`http://127.0.0.1:${port}/json/list`, 2000).catch(() => null)
          const page = (list || []).find((t) => t.type === 'page')
          if (page?.id) {
            try {
              const { windowId } = await bc.send('Browser.getWindowForTarget', { targetId: page.id })
              await bc.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
              await bc.send('Browser.setWindowBounds', {
                windowId,
                bounds: visible ? { left: 80, top: 60, width: 1280, height: 860 } : { left: -2400, top: -2400, width: 1280, height: 860 }
              })
              placed = true
            } catch (error) { placed = false }
          }
        }
        if (!placed) await wait(250)
      }
    } finally {
      try { bc?.close() } catch (error) {}
    }
    if (!placed) throw new Error('窗口挪不动：浏览器可能刚重启，点「开始登录」重开一次')
    if (visible) await cdp.send('Page.bringToFront').catch(() => {})
    log?.info?.(`显示窗口：${visible ? '挪到屏幕内 (80,60)' : '收回到屏幕外'}`)
  }

  async function close () {
    if (closing) return closing
    // 先让关闭标记生效，再异步清理，避免同步完成时覆盖 closing。
    generation++
    const pending = opening
    closing = Promise.resolve().then(async () => {
      if (pending) await pending
      attaching?.close()
      if (owned && !owned.exited && cdp && !cdp.closed) owned.terminate ||= cdp
      else cdp?.close()
      cdp = null
      // stopOwned 自己会去重（p.stopping），且关不掉时先把 owned 置空再抛，所以只调一次就够
      let failed = null
      try { await stopOwned(owned) } catch (error) { failed = error }
      if (failed) throw failed
    }).finally(() => { closing = null })
    return closing
  }

  /** 读浏览器里的全部 cookie。含 HttpOnly —— 登录态（sessionid / uid_tt / sid_guard）
   *  全是 HttpOnly，document.cookie 读不到，只能走 CDP 拿。
   *  domains 传 ['hongguoduanju.com'] 之类做过滤，返回 { name, value, domain, httpOnly }[]。 */
  async function cookies (domains = []) {
    const c = need()
    const r = await c.send('Storage.getCookies', {}, 15000)
    const list = (r?.cookies || []).map((x) => ({ name: x.name, value: x.value, domain: x.domain, httpOnly: !!x.httpOnly, expires: x.expires }))
    if (!domains.length) return list
    return list.filter((x) => domains.some((d) => x.domain === d || x.domain === '.' + d || String(x.domain).endsWith(d)))
  }

  return { open, connected, evaluate, goto, click, press, screenshot, show, close, cookies }
}
