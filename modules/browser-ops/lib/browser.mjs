// browser.mjs —— browser-ops 模块的 CDP 浏览器底座
// 来源：本项目自写。启动 / 生命周期 / 锁与退避的「思路」参考了
//       mods-fork/modules/douyin/lib/browser.mjs（MIT，Aurabot），代码全部重写。
// 作用：启动一个带独立登录资料的 Edge/Chrome（--user-data-dir 指向模块数据目录），
//       经 CDP（Node 自带 WebSocket）提供原子操作：launch/close、navigate、点击、
//       输入、滚动、截屏、页面快照（DOM 摘要 / 无障碍树）。登录态只落在
//       api.dataDir() 传进来的 profileDir，本文件绝不写模块源码目录。
// 契约：createBrowser(opts) → { launch, connected, navigate, evaluate, clickXY,
//       clickSelector, input, clearFocused, pressEnter, scroll, screenshot,
//       snapshot, show, status, close }；所有依赖（spawn/端口/JSON/CDP 连接）
//       都可经 opts 注入，测试不打真进程、不真开浏览器。

import { createServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createEgoBackend, acquireEgoTarget } from './ego.mjs'

// 常见浏览器安装位置：面板填了就用填的，否则 Edge 优先（Windows 自带），再找 Chrome / Chromium。
const BROWSER_CANDIDATES = [
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

/** 找一个可用的浏览器可执行文件：explicit 有值且存在就用它；否则按候选表找第一个存在的。 */
export function findBrowser(explicit = '', exists = existsSync) {
  if (explicit) return exists(explicit) ? explicit : ''
  return BROWSER_CANDIDATES.find((p) => exists(p)) || ''
}

/** 要一个本机空闲的调试端口（listen 0 再关掉，竞态概率极低）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** 读资料目录里记下的调试端口（我们自己写的；进程重启后靠它接回还开着的窗口）。 */
export function readPortFile(profileDir, read = readFileSync) {
  try {
    const n = Number(String(read(join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0].trim())
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  } catch {
    return 0
  }
}

/** 从标签页列表里挑要接管的那个：第一个普通页面（type=page 且有 ws 地址）。 */
export function pickPage(targets) {
  return (targets || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null
}

/** 拉一个 CDP HTTP 接口的 JSON（127.0.0.1 本机）。 */
async function getJson(url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

/** 一条 CDP WebSocket 连接：send 发命令收结果，on 订阅事件。 */
export function connectCdp(wsUrl, { WS = globalThis.WebSocket } = {}) {
  if (!WS) throw new Error('当前 Node 没有 WebSocket（需要 Node 22 以上）')
  const sock = new WS(wsUrl)
  let nextId = 1
  let closed = false
  const pending = new Map()
  const listeners = new Map()
  sock.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 命令出错'))
      else p.resolve(msg.result || {})
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) { try { fn(msg.params || {}) } catch { /* 事件回调自担 */ } }
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
    get closed() { return closed },
    /** 发一条 CDP 命令；ms 超时。 */
    send(method, params = {}, ms = 30000) {
      if (closed) return Promise.reject(new Error('浏览器连接断了'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器没响应（${method}）`)) }, ms)
        pending.set(id, {
          resolve: (v) => { clearTimeout(t); resolve(v) },
          reject: (e) => { clearTimeout(t); reject(e) },
        })
        try { sock.send(JSON.stringify({ id, method, params })) } catch (error) { pending.delete(id); clearTimeout(t); reject(error) }
      })
    },
    /** 订阅一个 CDP 事件，返回取消订阅函数。 */
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => listeners.get(method)?.delete(fn)
    },
    close() { try { sock.close() } catch { /* 已断开 */ } },
  }
}

/** Windows 按进程树强杀（浏览器主进程退出不等于渲染子进程全退）。 */
function windowsKillTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error))
  })
}

/**
 * 页内 DOM 摘要（在页面里跑的表达式的后半段）：把 document 压成纯文本行数组。
 * 单独导出是为了让测试不打浏览器也能验证摘要逻辑（传假数据进来）。
 */
export function formatDomSummary(data, maxChars = 3000) {
  data = data || {}
  const lines = [`页面：${String(data.title || '（无标题）').slice(0, 120)}`, `地址：${String(data.url || '').slice(0, 200)}`]
  for (const el of data.elements || []) {
    const desc = [el.tag, el.text || el.value || el.placeholder || el.label || '', el.href ? `→ ${el.href}` : ''].filter(Boolean).join(' ')
    if (desc.trim()) lines.push(`· ${desc.slice(0, 160)}`)
  }
  const body = String(data.bodyText || '').replace(/\s+/g, ' ').trim()
  if (body) lines.push(`正文：${body}`)
  // 逐行拼、超长截断：快照是给模型读的，别把上下文塞爆
  let out = ''
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) { out += '\n…（已截断）'; break }
    out += (out ? '\n' : '') + line
  }
  return out
}

/** 无障碍树节点压成一行（role + 名字），给 snapshot({ mode:'a11y' }) 用。 */
export function formatA11yNodes(nodes, maxChars = 3000) {
  const lines = []
  for (const n of nodes || []) {
    const name = String(n.name?.value ?? n.name ?? '').trim()
    const role = String(n.role?.value ?? n.role ?? '').trim()
    if (!role) continue
    lines.push(`· ${role}${name ? `：${name.slice(0, 120)}` : ''}`)
  }
  let out = ''
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) { out += '\n…（已截断）'; break }
    out += (out ? '\n' : '') + line
  }
  return out || '（无障碍树为空）'
}

/**
 * 专用浏览器句柄。launch() 才真的启动/连接；只读状态的地方（面板）不要调它。
 * 只接回「本实例启动过的」进程：端口文件只能证明端口活着，配合 /json/version
 * 确认 + 只接有我们记号的实例，避免误接用户自己开着的浏览器。
 */
export function createBrowser({
  profileDir,
  browserPath = () => '',
  windowSize = '1280,860',
  log,
  now = Date.now,
  spawnProcess = spawn,
  getPort = freePort,
  getBrowserJson = getJson,
  connect = connectCdp,
  wait = sleep,
  platform = process.platform,
  killTree = windowsKillTree,
  stopWaitMs = 3000,
  stderrWaitMs = 250,
  useEgo = () => false, // true = 连 DSH 侧边浏览器（共享 ego 实例），不 spawn 不杀进程
} = {}) {
  let cdp = null        // 当前 CDP 连接
  let owned = null      // 我们自己 spawn 出来的浏览器进程记录
  let opening = null    // 进行中的启动 Promise（并发 launch 合并）
  let closing = null    // 进行中的关闭 Promise
  let failures = 0      // 连续失败次数（退避用）
  let retryAt = 0       // 下次允许重试的时刻
  let lastError = ''

  const connected = () => (egoTarget ? Boolean(cdp && !cdp.closed) : Boolean(owned && !owned.exited && !owned.needsStop && cdp && !cdp.closed))

    // —— DSH 侧边浏览器（ego）模式：连 DSH 共享实例、认领自己的标签页；
    // 绝不 spawn、绝不杀进程（共享实例归 DSH 管）。
    let egoTarget = null, egoPort = 0
    let egoBackend = null
    const useEgoNow = () => { try { return useEgo() === true } catch (error) { return false } }
    async function egoConnect(check, extra) {
      if (egoTarget && cdp && !cdp.closed) return
      if (egoTarget) { // 上一条连接断了：把自己那个标签页关掉再认领新的，别在共享实例里堆僵尸页
        const stale = egoTarget, stalePort = egoPort
        egoTarget = null; egoPort = 0
        fetch(`http://127.0.0.1:${stalePort}/json/close/${stale.id}`).catch(() => {})
      }
      if (!egoBackend) egoBackend = createEgoBackend({ getJson, log })
      const { port } = await egoBackend.ensure(check)
      const target = await acquireEgoTarget(port, getBrowserJson, connect)
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
    async function egoDisconnect() {
      const t = egoTarget, port = egoPort
      egoTarget = null; egoPort = 0
      cdp?.close(); cdp = null
      if (t && port) fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {})
    }

  const lockError = () => new Error('专用浏览器的资料目录被占用（SingletonLock / profile appears to be in use），请先关闭占用它的浏览器窗口')

  // Linux 的 SingletonLock 常是指向不存在路径的符号链接，existsSync 会漏掉，得用 lstat。
  function hasLock() {
    try { lstatSync(join(profileDir, 'SingletonLock')); return true } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  /** 包一层子进程观察：退出/出错/stderr 都记下来，生命周期判断全靠它。 */
  function observe(child, port) {
    let done
    const p = {
      child, port, exited: false, error: null, stderr: '',
      done: new Promise((resolve) => { done = resolve }),
      needsStop: false, terminate: null, stopping: null,
    }
    child.on?.('error', (error) => {
      p.error = error
      if (!child.pid) { p.exited = true; done() }
    })
    child.once?.('exit', () => {
      p.exited = true
      done()
      if (owned === p) { cdp?.close(); cdp = null } // 进程没了，连接自然作废
    })
    child.stderr?.on?.('data', (d) => { p.stderr = (p.stderr + String(d)).slice(-4000) })
    child.stderr?.on?.('error', () => {})
    return p
  }

  function waitExit(p, ms) {
    if (!p || p.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      p.done.then(() => { clearTimeout(timer); resolve() })
    })
  }

  // exit 事件可能先于 stderr 数据到达，稍等输出关闭才能认出「资料目录被占」类错误。
  async function waitOutput(p) {
    if (!p?.exited || !p.child?.stderr) return
    await wait(stderrWaitMs)
  }

  /** 结束自己启动的浏览器及子进程；没确认退出前不许启动下一个，免得目录锁叠加。 */
  async function stopOwned(p) {
    if (!p || p === owned) { /* owned 可能在等它自己清 */ }
    if (!p) return
    if (p.stopping) return p.stopping
    p.needsStop = true
    p.stopping = (async () => {
      // 先走浏览器的正常退出（Browser.close），避免留下脏锁
      if (!p.exited && p.terminate) {
        try { await p.terminate.send('Browser.close', {}, 3000) } catch { /* 接下来强杀 */ }
        await waitExit(p, stopWaitMs)
        p.terminate.close()
        p.terminate = null
      }
      if (!p.exited && p.child?.pid) {
        if (platform === 'win32') {
          let killed = false
          try { killed = await killTree(p.child.pid) } catch { /* 下面兜底 */ }
          if (!killed && !p.exited) { try { p.child.kill('SIGKILL') } catch { /* 已退出 */ } }
        } else {
          try { p.child.kill('SIGKILL') } catch { /* 已退出 */ }
        }
        await waitExit(p, stopWaitMs)
        if (!p.exited && p.child?.kill) {
          try { p.child.kill('SIGKILL') } catch { /* 已退出 */ }
          await waitExit(p, stopWaitMs)
        }
      }
      if (p.terminate) { p.terminate.close(); p.terminate = null }
      if (!p.exited && p.child?.pid) throw new Error('无法确认专用浏览器已退出，请手动检查该进程')
      // 窗口确实关了：端口记录作废，下次别去接它
      try { rmSync(join(profileDir, 'DevToolsActivePort'), { force: true }) } catch { /* 不影响 */ }
      if (owned === p) owned = null
    })()
    try { await p.stopping } finally { p.stopping = null }
  }

  /** 在指定端口接上标签页并初始化 CDP 域。 */
  async function attach(port, check) {
    const page = pickPage(await getBrowserJson(`http://127.0.0.1:${port}/json/list`))
    check()
    let target = page
    if (!target) target = await getBrowserJson(`http://127.0.0.1:${port}/json/new?about:blank`).catch(() => null)
    check()
    if (!target?.webSocketDebuggerUrl) throw new Error('浏览器里没有能控制的标签页')
    const c = connect(target.webSocketDebuggerUrl)
    try {
      await c.ready
      check()
      await c.send('Page.enable')
      await c.send('Runtime.enable')
      await c.send('Accessibility.enable').catch(() => { /* 老内核没有就算了，快照退化走 DOM */ })
      cdp = c
      if (owned && !owned.exited && !owned.terminate) owned.terminate = c // 关闭时先尝试优雅退出
    } catch (error) {
      c.close()
      throw error
    }
  }

  function launchError(error, p) {
    const detail = [error?.message, p?.error?.message, p?.stderr?.trim()].filter(Boolean).join('；')
    if (/SingletonLock|profile appears to be in use/i.test(detail)) return lockError()
    return new Error(detail || '浏览器没起来，请检查浏览器路径和专用资料目录')
  }

  async function launch(source, check) {
    if (useEgoNow()) {
      await egoConnect(check, (c) => c.send('Accessibility.enable').catch(() => {}))
      return
    }
    let p = owned
    try {
      check()
      if (p?.exited || p?.needsStop) { await stopOwned(p); p = owned = null }
      if (p) {
        // 进程还活着：重开一条 CDP 连接即可
        cdp?.close()
        cdp = null
        await attach(p.port, () => { check(); if (p.exited || p.error) throw launchError(null, p) })
        return
      }
      // 上次没关干净的窗口还开着（DSH 重启等）：接回去，别让它一直占资料目录
      const left = readPortFile(profileDir)
      if (left && await getBrowserJson(`http://127.0.0.1:${left}/json/version`, 1500).catch(() => null)) {
        check()
        p = owned = { child: { pid: 0, kill() {} }, port: left, exited: false, error: null, stderr: '', done: new Promise(() => {}), needsStop: false, terminate: null }
        await attach(left, check)
        return
      }
      if (hasLock()) throw lockError()
      const bin = findBrowser(browserPath())
      if (!bin) throw new Error(browserPath() ? `浏览器路径不对：${browserPath()}` : '找不到 Edge / Chrome，先装一个，或在面板里填浏览器路径')
      mkdirSync(profileDir, { recursive: true })
      const port = await getPort()
      check()
      if (hasLock()) throw lockError() // 等端口期间也可能被人占了目录
      check()
      log?.info?.(`[browser-ops] 启动专用浏览器（来源：${source}），资料目录：${profileDir}`)
      const child = spawnProcess(bin, [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1', // 调试口只听本机，绝不暴露给局域网
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
        `--window-size=${windowSize}`,
        '--window-position=-2400,-2400', // 默认放屏幕外：不抢主人前台，要人看时 show(true)
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
      p = owned = observe(child, port)
      child.unref?.()
      // 最多等 15 秒：调试口有响应才算真起来了
      for (let i = 0; i < 60; i++) {
        await wait(250)
        check()
        if (p.exited || p.error) throw launchError(null, p)
        const version = await getBrowserJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)
        check()
        if (p.exited || p.error) throw launchError(null, p)
        if (version) {
          // Edge 常常不写这个文件，自己补一份，重启后才能接回窗口
          try { writeFileSync(join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/browser-ops\n`) } catch { /* 大不了下次重开 */ }
          await attach(port, () => { check(); if (p.exited || p.error) throw launchError(null, p) })
          return
        }
      }
      throw launchError(null, p)
    } catch (error) {
      // 起失败了：把自己拉起的进程收干净再报错，不留半死进程
      try { await stopOwned(p) } catch (stopError) {
        throw new Error(`${launchError(error, p).message}；清理失败：${stopError.message}`)
      }
      await waitOutput(p)
      throw launchError(error, p)
    }
  }

  /**
   * 确保浏览器已连接。失败统一退避（5/10/20/40/60 分钟），避免每分钟定时器都去撞坏环境。
   * 返回 { ok, message }，不抛错——调用方（面板/定时器）只看结果。
   */
  async function launchGuarded(source = '主人要求', canStart = () => true) {
    if (closing) await closing
    if (!canStart()) return { ok: false, message: '浏览器自动化开关没开' }
    if (connected()) return { ok: true, message: '已连接' }
    if (opening) return opening
    if (now() < retryAt) return { ok: false, message: `${lastError}；约 ${Math.max(1, Math.ceil((retryAt - now()) / 60000))} 分钟后重试` }
    opening = (async () => {
      try {
        await launch(source, canStart)
        failures = 0
        retryAt = 0
        lastError = ''
        return { ok: true, message: '已连接' }
      } catch (error) {
        failures++
        const delay = Math.min(60, 5 * 2 ** Math.min(failures - 1, 4))
        retryAt = now() + delay * 60000
        lastError = error.message
        log?.warn?.(`[browser-ops] 浏览器启动失败：${lastError}；${delay} 分钟后重试`)
        return { ok: false, message: `${lastError}；${delay} 分钟后重试` }
      } finally {
        opening = null
      }
    })()
    return opening
  }

  /** 拿当前 CDP 连接；没连上就抛可读错误。 */
  function need() {
    if (!connected()) throw new Error('专用浏览器没连接，先 launch()')
    return cdp
  }

  /** 在页面里跑一段表达式（可 async），拿返回值。 */
  async function evaluate(expression, ms = 30000) {
    const r = await need().send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms)
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text || '页面脚本出错')
    }
    return r.result?.value
  }

  /** 打开网址，等 load 事件（最多 ms，慢站不等死）。 */
  async function navigate(url, ms = 15000) {
    const c = need()
    const loaded = new Promise((resolve) => {
      const off = c.on('Page.loadEventFired', () => { off(); resolve() })
      setTimeout(() => { off(); resolve() }, ms)
    })
    await c.send('Page.navigate', { url })
    await loaded
    const meta = await evaluate('({ title: document.title, url: location.href })').catch(() => ({}))
    return { ok: true, url: meta.url || url, title: meta.title || '' }
  }

  /** 真鼠标点屏幕坐标（页面看到的是正常点击事件）。 */
  async function clickXY(x, y) {
    const c = need()
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      await sleep(40 + Math.random() * 60)
    }
    return { ok: true }
  }

  /**
   * 点一个选择器命中的元素：页面可见时用真鼠标点中心；不可见（窗口在屏幕外等）时
   * 浏览器会吞掉模拟鼠标输入，改在页面里派发事件。找不到返回 false。
   */
  async function clickSelector(selector) {
    const r = await evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(String(selector))})
      if (!n) return null
      n.scrollIntoView({ block: 'center', inline: 'center' })
      if (document.visibilityState !== 'visible') {
        for (const t of ['mouseover', 'mousedown', 'mouseup', 'click']) {
          n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }))
        }
        return { dom: true }
      }
      const b = n.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })()`)
    if (!r) return { ok: false, found: false }
    if (!r.dom) await clickXY(r.x, r.y)
    return { ok: true, found: true }
  }

  /** 往当前焦点输入文字（走输入事件，富文本编辑器也认）。 */
  async function input(text) {
    await need().send('Input.insertText', { text: String(text) })
    return { ok: true }
  }

  /** 清空当前焦点输入框：真按 Ctrl+A、退格（很多编辑器不认 execCommand）。 */
  async function clearFocused() {
    const c = need()
    const key = (k, code, vk, modifiers = 0) => Promise.all([
      c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers }),
      c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }),
    ])
    await key('a', 'KeyA', 65, platform === 'darwin' ? 4 : 2)
    await key('Backspace', 'Backspace', 8)
    return { ok: true }
  }

  /** 按一下回车。 */
  async function pressEnter() {
    const c = need()
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: '\r' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
    return { ok: true }
  }

  /** 滚动页面（真滚轮事件，delta 像素）。 */
  async function scroll({ dx = 0, dy = 300, x = 640, y = 400 } = {}) {
    await need().send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy })
    return { ok: true }
  }

  /** 截屏（可截一块 clip={x,y,width,height}），返回 data:image/png;base64。 */
  async function screenshot(clip) {
    const r = await need().send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    return r.data ? 'data:image/png;base64,' + r.data : ''
  }

  /**
   * 页面快照（给模型读的文本摘要）。
   * mode='dom'：标题/地址/可交互元素/正文摘要；mode='a11y'：无障碍树（拿不到退化走 dom）。
   */
  async function snapshot({ mode = 'dom', maxChars = 3000 } = {}) {
    if (mode === 'a11y') {
      try {
        const r = await need().send('Accessibility.getFullAXTree', {}, 15000)
        const text = formatA11yNodes(r.nodes, maxChars)
        if (text && text !== '（无障碍树为空）') return { ok: true, mode, text }
      } catch { /* Accessibility 域不可用：退化走 DOM */ }
    }
    const data = await evaluate(`(() => {
      const pick = (n) => ({
        tag: n.tagName.toLowerCase(),
        text: (n.innerText || '').trim().split('\\n')[0].slice(0, 120),
        value: n.value || '', placeholder: n.placeholder || '',
        label: n.getAttribute('aria-label') || '',
        href: n.tagName === 'A' ? (n.href || '').slice(0, 160) : '',
      })
      const sel = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"]'
      const seen = new Set()
      const elements = [...document.querySelectorAll(sel)].slice(0, 120)
        .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
        .filter((n) => { const t = (n.innerText || n.value || n.placeholder || '').trim(); if (seen.has(t)) return false; seen.add(t); return true })
        .map(pick)
      return { title: document.title, url: location.href, elements, bodyText: (document.body?.innerText || '').slice(0, 1200) }
    })()`)
    return { ok: true, mode: 'dom', text: formatDomSummary(data, maxChars) }
  }

  /** 窗口挪到屏幕里给人看 / 挪回屏幕外（登录扫码时用 visible=true）。 */
  async function show(visible) {
    if (egoTarget) {
      // 同 douyin/xhs/heybox：ego 模式下「显示」= 把共享窗口从屏幕外 (-2400,-2400)
      // 挪回屏幕内、带到前台、切到本标签页；收起挪回屏幕外。
      try {
        const { windowId } = await cdp.send('Browser.getWindowForTarget')
        if (visible) {
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 60, width: 1280, height: 860 } }).catch(() => {})
        } else {
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } }).catch(() => {})
        }
      } catch { /* 挪窗失败不拦着 bringToFront */ }
      if (visible) await cdp?.send('Page.bringToFront').catch(() => {})
      return { ok: true, visible: !!visible }
    }
    const c = need()
    const { windowId } = await c.send('Browser.getWindowForTarget')
    await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
    await c.send('Browser.setWindowBounds', {
      windowId,
      bounds: visible
        ? { left: 80, top: 60, width: 1280, height: 860 }
        : { left: -2400, top: -2400, width: 1280, height: 860 },
    })
    if (visible) await c.send('Page.bringToFront').catch(() => {})
    return { ok: true, visible: !!visible }
  }

  /** 关闭浏览器（优雅退出优先，杀不死再强杀进程树）。 */
  async function close() {
    if (closing) return closing
    const pending = opening
    closing = (async () => {
      if (pending) { try { await pending } catch { /* 启动本来就没成功 */ } }
      if (egoTarget) { await egoDisconnect(); return } // 共享实例：只断连接，不关浏览器
      if (owned && !owned.exited && cdp && !cdp.closed) owned.terminate ||= cdp
      else cdp?.close()
      cdp = null
      const p = owned
      let failed = null
      try { await stopOwned(p) } catch (error) { failed = error }
      if (failed) throw failed
    })().finally(() => { closing = null })
    return closing
  }

  return {
    launch: launchGuarded,
    connected,
    evaluate,
    navigate,
    clickXY,
    clickSelector,
    input,
    clearFocused,
    pressEnter,
    scroll,
    screenshot,
    snapshot,
    show,
    status: () => ({
      connected: connected(),
      profileDir,
      port: egoPort || owned?.port || 0,
      backend: egoTarget ? 'dsh-sidebar' : (owned ? 'dedicated' : 'none'),
      pid: owned?.child?.pid || 0,
      lastError,
      retryAt,
    }),
    close,
  }
}
