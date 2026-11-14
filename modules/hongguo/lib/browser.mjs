// 专用浏览器模块：独立用户资料目录的 Edge / Chrome，经 CDP（Node 自带 WebSocket）控制。
// 只管「开 / 连 / 点 / 打字 / 截图 / 等接口返回」这些通用动作，站点相关的都在 site.mjs。
// 不用无头模式：多数站点会拦无头浏览器（页面一直「加载中」）。Linux 没桌面就配 Xvfb。

import { createServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createEgoBackend, acquireEgoTarget } from './ego.mjs'

const CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/** 找浏览器：面板填了就用填的，否则 Edge 优先，再找 Chrome / Chromium。 */
export function findBrowser (explicit = '', exists = existsSync) {
  if (explicit) return exists(explicit) ? explicit : ''
  return CANDIDATES.find((p) => exists(p)) || ''
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

/** 资料目录里记下的调试端口（我们启动时自己写的；DSH 重启后靠它接回已经开着的窗口）。 */
export function readPortFile (profileDir, read = readFileSync) {
  try {
    const n = Number(String(read(join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0].trim())
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  } catch (error) {
    return 0
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

async function getJson (url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

/** 一条 CDP 连接：send 发命令，on 收事件。 */
export function connectCdp (wsUrl, { WS = globalThis.WebSocket } = {}) {
  if (!WS) throw new Error('当前 Node 没有 WebSocket（要 Node 22 以上）')
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
  killTree = windowsKillTree, stopWaitMs = 3000, stderrWaitMs = 250, useEgo = () => false
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

  const connected = () => (egoTarget ? Boolean(cdp && !cdp.closed) : Boolean(owned && !owned.exited && !owned.needsStop && cdp && !cdp.closed))

  // —— DSH 侧边浏览器（ego）模式：连 DSH 共享实例、认领自己的标签页；
  // 绝不 spawn、绝不杀进程（共享实例归 DSH 管）。
  let egoTarget = null
  let egoPort = 0
  let egoBackend = null
  const useEgoNow = () => { try { return useEgo() === true } catch (error) { return false } }
  async function egoConnect (check, extra) {
    if (egoTarget && cdp && !cdp.closed) return
    if (egoTarget) { // 上一条连接断了：把自己那个标签页关掉再认领新的，别在共享实例里堆僵尸页
      const stale = egoTarget; const stalePort = egoPort
      egoTarget = null; egoPort = 0
      fetch(`http://127.0.0.1:${stalePort}/json/close/${stale.id}`).catch(() => {})
    }
    if (!egoBackend) egoBackend = createEgoBackend({ getJson, log })
    const { port } = await egoBackend.ensure(check)
    const target = await acquireEgoTarget(port, getBrowserJson)
    check()
    const c = connect(target.webSocketDebuggerUrl)
    try {
      await c.ready
      check()
      await c.send('Page.enable')
      await c.send('Runtime.enable')
      if (extra) await extra(c)
      cdp = c
      egoTarget = target
      egoPort = port
    } catch (error) {
      c.close()
      fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {})
      throw error
    }
  }
  async function egoDisconnect () {
    const t = egoTarget; const port = egoPort
    egoTarget = null; egoPort = 0
    cdp?.close(); cdp = null
    if (t && port) fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {})
  }

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
      // 对已确认连上的自己进程先走浏览器的正常退出，避免留下旧锁。
      if (!p.exited && p.terminate) {
        try { await p.terminate.send('Browser.close', {}, 3000) } catch (error) {}
        await waitExit(p, stopWaitMs)
        p.terminate.close()
        p.terminate = null
      }
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
      if (!p.exited && p.child.pid) throw new Error('无法确认自己启动的浏览器已退出，请检查该进程')
      // 自己的窗口确实关了，端口记录也作废，下次别去接它
      try { rmSync(join(profileDir, 'DevToolsActivePort'), { force: true }) } catch (error) {}
      if (owned === p) owned = null
    })
    try { await p.stopping } finally { p.stopping = null }
  }

  async function attach (port, check) {
    const { page, extra } = pickPage(await getBrowserJson(`http://127.0.0.1:${port}/json/list`))
    check()
    for (const t of extra) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {})
    let target = page
    if (!target) target = await getBrowserJson(`http://127.0.0.1:${port}/json/new?about:blank`).catch(() => null)
    check()
    if (!target?.webSocketDebuggerUrl) throw new Error('浏览器里没有能控制的标签页')
    const c = connect(target.webSocketDebuggerUrl)
    attaching = c
    try {
      await c.ready
      check()
      await c.send('Page.enable')
      await c.send('Runtime.enable')
      await c.send('Network.enable', { maxResourceBufferSize: 20e6, maxTotalBufferSize: 100e6 })
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

  function launchError (error, p) {
    const detail = [error?.message, p?.error?.message, p?.stderr?.trim()].filter(Boolean).join('；')
    if (/SingletonLock|profile appears to be in use/i.test(detail)) return lockError()
    return new Error(detail || '浏览器没起来，请检查浏览器路径和专用资料目录')
  }

  async function launch (source, check) {
    if (useEgoNow()) {
      await egoConnect(check, async (c) => {
        await c.send('Network.enable', { maxResourceBufferSize: 20e6, maxTotalBufferSize: 100e6 })
        await c.send('Page.setMuted', { muted: true }).catch(() => {})
      })
      return
    }
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
      // DSH 被强制重启时上一个窗口还开着：接回去，不然它一直占着资料目录
      const left = readPortFile(profileDir)
      if (left && await getBrowserJson(`http://127.0.0.1:${left}/json/version`, 1500).catch(() => null)) {
        check()
        p = owned = { child: { pid: 0, kill () {} }, port: left, exited: false, error: null, stderr: '', done: new Promise(() => {}), outputClosed: true, outputDone: Promise.resolve() }
        await attach(left, check)
        return
      }
      if (hasLock()) throw lockError()
      const path = browserPath()
      const bin = findBrowser(path)
      if (!bin) throw new Error(path ? `浏览器路径不对：${path}` : '找不到 Edge / Chrome，先装一个，或在面板里填浏览器路径')
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
      for (let i = 0; i < 60; i++) {
        await wait(250)
        check()
        if (p.exited || p.error) throw launchError(null, p)
        const version = await getBrowserJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)
        check()
        if (p.exited || p.error) throw launchError(null, p)
        if (version) {
          // Edge 经常不写这个文件，自己写一份，DSH 重启后才能接回这个窗口
          try { writeFileSync(join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/aurabot\n`) } catch (error) {}
          await attach(port, () => { check(); if (p.exited || p.error) throw launchError(null, p) })
          return
        }
      }
      throw launchError(null, p)
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

  /** 在页面里跑一段表达式，返回值（可以是 Promise）。 */
  async function evaluate (expression, ms = 30000) {
    const r = await need().send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text || '页面脚本出错')
    return r.result?.value
  }

  /** 打开网址，等页面加载完（最多 ms；load 事件常常很晚，后面再按需 waitFor 具体元素）。 */
  async function goto (url, ms = 8000) {
    const c = need()
    const loaded = new Promise((resolve) => {
      const off = c.on('Page.loadEventFired', () => { off(); resolve() })
      setTimeout(() => { off(); resolve() }, ms)
    })
    await c.send('Page.navigate', { url })
    await loaded
  }

  /** 等某个选择器出现，返回它的中心点和属性；超时返回 null。 */
  async function waitFor (selector, ms = 10000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const box = await evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)})
        if (!n) return null
        n.scrollIntoView({ block: 'center', inline: 'center' })
        const r = n.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return null
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, top: r.y, state: n.getAttribute('data-e2e-state') || '', text: (n.innerText || '').slice(0, 200) }
      })()`).catch(() => null)
      if (box) return box
      await sleep(300)
    }
    return null
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

  /** 往当前焦点打字（和输入法上屏一样，富文本编辑器也认）。 */
  async function type (text) {
    await need().send('Input.insertText', { text })
  }

  /** 清空当前焦点输入框：真按 Ctrl+A、退格（富文本编辑器的私信框不认 execCommand）。 */
  async function clearFocused () {
    const c = need()
    const key = async (k, code, vk, modifiers = 0) => {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    }
    await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2)
    await key('Backspace', 'Backspace', 8)
  }

  async function pressEnter () {
    const c = need()
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  /**
   * 开始等一个接口的返回（先调它、再做动作、再 await），拿到 { status, headers, json }；超时 null。
   * 用来确认点赞 / 评论到底成功没有，而不是点完就当成功。
   */
  function waitResponse (urlRe, ms = 10000) {
    const c = need()
    return new Promise((resolve) => {
      const ids = new Map()
      const done = (v) => { offA(); offB(); clearTimeout(t); resolve(v) }
      const offA = c.on('Network.responseReceived', (p) => { if (urlRe.test(p.response?.url || '')) ids.set(p.requestId, { status: p.response.status, headers: p.response.headers || {} }) })
      const offB = c.on('Network.loadingFinished', async (p) => {
        if (!ids.has(p.requestId)) return
        const b = await c.send('Network.getResponseBody', { requestId: p.requestId }).catch(() => null)
        let json = null
        try { json = JSON.parse(b?.base64Encoded ? Buffer.from(b.body, 'base64').toString() : b?.body) } catch (error) {}
        done({ ...ids.get(p.requestId), json })
      })
      const t = setTimeout(() => done(null), ms)
    })
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
    if (egoTarget) { try { await cdp.send('Page.bringToFront', {}) } catch (error) {} ; return } // 窗口归 DSH，挪不动

    // 🔴 窗口操作必须走「浏览器级」连接：页面级 session 上 Browser.getWindowForTarget
    // 会报 -32000 "Browser window not found"（页面会话没有窗口上下文），窗口一步都挪不动。
    const port = owned?.port || egoPort
    if (!port) throw new Error('拿不到浏览器的调试端口，点「开始登录」重开一次')
    let bc = null
    let placed = false
    try {
      // 刚启动/刚重启时窗口可能还没建好，重试几秒
      for (let i = 0; i < 24 && !placed; i++) {
        const ver = await getBrowserJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)
        if (ver?.webSocketDebuggerUrl) {
          if (!bc) { bc = connectCdp(ver.webSocketDebuggerUrl); await bc.ready }
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
      if (egoTarget) { await egoDisconnect(); return } // 共享实例：只断连接，不关浏览器
      attaching?.close()
      if (owned && !owned.exited && cdp && !cdp.closed) owned.terminate ||= cdp
      else cdp?.close()
      cdp = null
      let failed = null
      try { await stopOwned(owned) } catch (error) { failed = error }
      if (pending) await pending
      if (owned) try { await stopOwned(owned); failed = null } catch (error) { failed = error }
      else failed = null
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

  return { open, connected, evaluate, goto, waitFor, click, press, type, clearFocused, pressEnter, waitResponse, screenshot, show, close, cookies }
}
