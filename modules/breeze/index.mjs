// Breeze Blue 在线语音：设置放在面板「语音」页最下面。
// 不改插件核心：自己在 127.0.0.1 起一个小的 HTTP 语音服务，再把面板「语音」页的引擎
// 设成插件本来就支持的「通用 HTTP」，地址指过来 —— 这样任何人都能直接用。
// 另外带一个每日自动签到（领 400 免费积分）：到点试一次，DSH 那时候没开就在启动时补一次。
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { checkinAction, describeClaim, formatDate, looksLoggedIn, msUntil, nowMinutes, parseActivePort, pickCookies, wsMatches } from './lib/pure.mjs'

export default {
  id: 'breeze',
  name: 'Breeze 语音',
  version: '1.3.3',
  api: 1,
  description: 'Breeze Blue 在线文字转语音 + 每日自动签到领积分',
  tab: 'voice',
  panel: 'panel.js',
  defaults: {
    on: true,
    apiKey: '',
    voiceId: '',
    model: 'breeze-tts-2',
    language: 'zh',
    instructions: '',
    checkinOn: true,
    checkinTime: '08:10',
    notifyCheckin: true,
    browserPath: '',
  },
  setup(api) {
    // ---------- 语音：本地小服务 + 让插件走「通用 HTTP」引擎 ----------
    const BREEZE_URL = 'https://api.breeze.blue'
    const OUTPUT_FORMAT = 'mp3_24000_128'
    const BRIDGE_PORT = 47653
    const BRIDGE_PORT_TRIES = 4
    let bridgeServer = null
    let bridgePort = 0
    let restoreVoice = null
    // listen 是异步的：回调可能在模块被停掉之后才到。用「代际」判断这次回调还算不算数，
    // 不算就只是关掉 server —— 绝不能再调用 api（stopped 的模块调用 api 会同步抛错，
    // 而在 net 的回调里抛出去就是 uncaught exception，会直接把 host 进程带走）。
    let bridgeGen = 0

    /** 这份设置够不够开服务：要开、有 key、有音色 */
    const bridgeWanted = (s) => Boolean(s && s.on && String(s.apiKey || '').trim() && String(s.voiceId || '').trim())

    /** 调 Breeze 合成一段，返回 mp3 字节 */
    async function synthMp3(text) {
      const s = api.settings() || {}
      const apiKey = String(s.apiKey || '').trim()
      const voiceId = String(s.voiceId || '').trim()
      if (!apiKey || !voiceId) throw new Error('还没填 API Key 或音色 ID')
      const url = `${BREEZE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: String(s.model || 'breeze-tts-2').trim() || 'breeze-tts-2',
          language_code: String(s.language || 'zh').trim() || 'zh',
          instructions: String(s.instructions || ''),
        }),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`Breeze HTTP ${res.status}：${t.slice(0, 160)}`)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 400) throw new Error('Breeze 返回的音频太短')
      return buf
    }

    /** 起本地语音服务（端口尽量固定），并把「语音」页的引擎指过来 */
    function startBridge(settings) {
      const s = settings || api.settings() || {}
      if (bridgeServer || !bridgeWanted(s)) return
      const gen = ++bridgeGen
      const srv = http.createServer(async (req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        const text = u.searchParams.get('text') || ''
        if (!text.trim()) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('text 是空的')
          return
        }
        try {
          const buf = await synthMp3(text)
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length })
          res.end(buf)
        } catch (error) {
          api.log.warn('[breeze] 合成失败：', error.message)
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error.message || '合成失败'))
        }
      })
      // 端口尽量固定：配置里要写这个地址，重启后还能用；真被占了就往后挪一个
      let want = BRIDGE_PORT
      srv.on('error', (error) => {
        if (gen !== bridgeGen) {
          try {
            srv.close()
          } catch {}
          return
        }
        if (error.code === 'EADDRINUSE' && want < BRIDGE_PORT + BRIDGE_PORT_TRIES) {
          want += 1
          srv.listen(want, '127.0.0.1')
          return
        }
        api.log.warn('[breeze] 本地语音服务出错：', error.message)
      })
      srv.listen(want, '127.0.0.1', () => {
        // 回调晚到 / 模块已停：只收尾，不碰 api
        if (gen !== bridgeGen) {
          try {
            srv.close()
          } catch {}
          return
        }
        let port = 0
        try {
          port = srv.address().port
        } catch {
          return
        }
        bridgePort = port
        bridgeServer = srv
        const v = api.config().voice || {}
        if (!restoreVoice) {
          restoreVoice = { engine: v.engine, http: { ...(v.http || {}) }, enabled: v.enabled !== false }
          writeVoiceBackup(restoreVoice)
        }
        try {
          api.setConfig({
            voice: {
              enabled: true,
              engine: 'http',
              http: { ...(v.http || {}), urlTemplate: `http://127.0.0.1:${port}/?text={text}`, method: 'GET', sampleRate: 24000 },
            },
          })
        } catch (error) {
          api.log.warn('[breeze] 写回语音设置失败：', error.message)
        }
        api.log.info(`[breeze] 本地语音服务已开：127.0.0.1:${port}`)
      })
    }

    /** 关掉本地服务，并把引擎还原成开之前的（只还原成我们自己写的那种，别覆盖别人后改的设置） */
    function stopBridge() {
      bridgeGen++
      if (bridgeServer) {
        try {
          bridgeServer.close()
        } catch {}
        bridgeServer = null
      }
      if (restoreVoice) {
        const v = api.config().voice || {}
        const myPort = bridgePort || BRIDGE_PORT
        const template = String((v.http || {}).urlTemplate || '')
        // 只认自己刚写的那个端口：用户把地址改成别的本地服务时，不能当成自己的备份盖回去
        const mine = v.engine === 'http' && template.includes(`127.0.0.1:${myPort}/`)
        let done = false
        if (mine) {
          try {
            // 模块停用后 api.setConfig 会同步抛错，必须走未包装的 core.setConfig
            const core = api.core
            // core.setConfig 不做合并：必须传整份配置，否则只有 voice 的补丁会把其余设置洗成默认（已踩坑）
            const patch = { voice: { ...v, enabled: restoreVoice.enabled, engine: restoreVoice.engine, http: restoreVoice.http } }
            if (core && typeof core.setConfig === 'function') core.setConfig({ ...api.config(), voice: patch.voice })
            else api.setConfig(patch)
            done = true
          } catch (error) {
            api.log.warn('[breeze] 还原语音引擎失败，备份留着下次再试：', error.message)
          }
        }
        if (mine || done) restoreVoice = null
        if (mine && done) clearVoiceBackup()
      }
      bridgePort = 0
    }

    const voiceBackupFile = () => join(api.dataDir(), 'voice-backup.json')
    const writeVoiceBackup = (o) => {
      try {
        mkdirSync(api.dataDir(), { recursive: true })
        writeFileSync(voiceBackupFile(), JSON.stringify(o, null, 2))
      } catch (error) {
        api.log.warn('语音原值备份写不进去：', error.message)
      }
    }
    const clearVoiceBackup = () => {
      try {
        if (existsSync(voiceBackupFile())) unlinkSync(voiceBackupFile())
      } catch {}
    }
    try {
      const saved = JSON.parse(readFileSync(voiceBackupFile(), 'utf8'))
      if (saved && saved.engine) restoreVoice = saved
    } catch {}

    startBridge()
    api.onDispose(stopBridge)

    // ---- 每日签到 ----
    const stateFile = join(api.dataDir(), 'checkin.json')
    const readState = () => {
      try {
        return JSON.parse(readFileSync(stateFile, 'utf8'))
      } catch {
        return {}
      }
    }
    const writeState = (o) => {
      try {
        mkdirSync(api.dataDir(), { recursive: true })
        writeFileSync(stateFile, JSON.stringify(o, null, 2))
      } catch (error) {
        api.log.warn('签到状态写不进去：', error.message)
      }
    }
    const today = () => formatDate(new Date())
    /** 设置里的签到时间，形如 '08:10' */
    const checkinTime = () => String((api.settings() || {}).checkinTime || '08:10').trim() || '08:10'

    // 登录态只在内存里放一份，不往磁盘写明文；DSH 重启后要用的话，
    // 去那个专用浏览器配置里现读一次（见 sessionCookie）。
    let memCookie = ''
    /** Chrome 把登录态存在这个文件里；有它就说明「可能登过」，值得去读一次 */
    const cookiesFile = () => {
      // 新版 Chrome 把 cookie 库放在 Default/Network 下，老版在 Default 下，两个都认
      const dir = chromeDir()
      for (const p of [join(dir, 'Default', 'Network', 'Cookies'), join(dir, 'Default', 'Cookies')]) {
        if (existsSync(p)) return p
      }
      return ''
    }
    const hasLogin = () => Boolean(memCookie || readState().loginAt)

    /** 现取的登录态：内存里有就用，没有就从专用浏览器配置里读一次 */
    async function sessionCookie() {
      if (memCookie) return memCookie
      if (!cookiesFile() && !readState().loginAt) return ''
      let opened = null
      try {
        opened = await startBrowser({ headless: true })
        const parts = await grabCookies()
        // 复用别人（用户正开着的登录窗口）时别去关它，只关我们自己起的
        if (opened && !opened.reused) await closeBrowser()
        if (looksLoggedIn(parts)) memCookie = parts.join('; ')
      } catch (error) {
        api.log.debug('[breeze] 从浏览器配置里读登录态失败：', error.message)
      }
      return memCookie
    }

    /** 真去领一次。返回 { ok, message, balance? } */
    async function claim() {
      const cookie = await sessionCookie()
      if (!cookie) return { ok: false, message: '还没登录，先在面板点一下「登录」' }
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0',
        origin: 'https://breezeblue.ai',
        referer: 'https://breezeblue.ai/zh/app',
        cookie,
      }
      try {
        const res = await fetch('https://breezeblue.ai/api/credits/daily-claim', {
          method: 'POST',
          headers,
          body: '{}',
          signal: AbortSignal.timeout(20000),
        })
        const text = await res.text()
        if (!res.ok) {
          api.log.warn(`签到失败 HTTP ${res.status}：${text.slice(0, 300)}`)
          // 401/403 多半是登录态过期了：把内存里那份丢掉，下次重新从浏览器配置读
          if (res.status === 401 || res.status === 403) memCookie = ''
          return { ok: false, message: `HTTP ${res.status} ${text.slice(0, 200)}` }
        }
        let data = null
        try {
          data = JSON.parse(text)
        } catch {}
        // cookie 过期时站点常见是 200 + 登录页 HTML，别把它当成签到成功
        const html = /^\s*</.test(text) || /<html[\s>]/i.test(text)
        const good = data && (data.claimed === true || data.already_claimed === true || data.daily_claim_available === false)
        if (html || !good || data.error) {
          api.log.warn('签到回包不像成功：' + text.slice(0, 200))
          return { ok: false, message: html ? '登录态可能过期了（回的是登录页）' : '回包说没领到' + (data && data.error ? '：' + data.error : '') }
        }
        const r = describeClaim(data)
        api.log.info('签到：' + r.message)
        return { ok: true, message: r.message, balance: r.balance, claimed: r.claimed }
      } catch (error) {
        api.log.warn('签到出错：', error.message)
        return { ok: false, message: error.message }
      }
    }

    function notifyOwner(text) {
      try {
        const qq = api.config().ownerQQ
        if (qq) api.sendText(`private:${qq}`, text)
      } catch (error) {
        api.log.warn('签到结果发不出去：', error.message)
      }
    }

    const wantNotify = () => (api.settings() || {}).notifyCheckin !== false

    /** 领到分就报一句（成功、且真的是这次领到的） */
    function notifyClaimed(balance) {
      if (!wantNotify()) return
      notifyOwner('Breeze 今日已签到成功' + (balance == null ? '' : `，余额 ${balance}`))
    }

    const RETRY_MS = 5 * 60 * 1000
    const MAX_TRIES = 3

    /** 到点没领过就领；启动时也补一次；没成功 5 分钟后再试，一天最多三次 */
    async function tick(reason) {
      const s = api.settings() || {}
      const st = readState()
      const d = today()
      const tried = st.day === d ? st.tries || 0 : 0
      const action = checkinAction({
        on: s.checkinOn !== false,
        hasCookie: hasLogin(),
        done: st.done,
        day: d,
        tries: tried,
        at: checkinTime(),
        now: nowMinutes(),
        maxTries: MAX_TRIES,
      })
      if (action === 'skip') return
      const r = await claim()
      markDone(r.ok, r.message, reason, d)
      if (r.ok) {
        if (r.claimed) notifyClaimed(r.balance)
        return
      }
      if (tried + 1 < MAX_TRIES) {
        api.log.warn(`签到没成功（今天第 ${tried + 1} 次），5 分钟后再试：` + r.message)
        api.later(RETRY_MS, () => tick('retry').catch((e) => api.log.warn('[breeze] 签到入口出错：', e.message)))
      } else {
        api.log.warn(`签到今天试了 ${tried + 1} 次都没成，明天再说：` + r.message)
        if (wantNotify()) notifyOwner(`Breeze 今天签到没成功：${r.message}。可能登录过期了，去面板点「登录」重新登一次`)
      }
    }

    /** 记一笔这次的结果（顺便数今天试了几次）；d 是调用方算好的「今天」，省得再算一遍 */
    function markDone(ok, message, reason, d = today()) {
      const cur = readState()
      const next = {
        ...cur,
        lastTry: new Date().toISOString(),
        lastResult: message,
        day: d,
        tries: cur.day === d ? (cur.tries || 0) + 1 : 1,
      }
      if (reason) next.lastReason = reason
      if (ok) next.done = d
      writeState(next)
    }

    /** 每天到点只醒一次，不轮询；改过签到时间就重排（旧的那个认 token 自己退场，不会越堆越多） */
    let scheduleToken = 0
    function scheduleNext() {
      const token = ++scheduleToken
      api.later(msUntil(checkinTime()), async () => {
        if (token !== scheduleToken) return
        try {
          await tick('timer')
        } catch (error) {
          api.log.warn('[breeze] 定时签到出错：', error.message)
        } finally {
          // 出错也要排下一天，不然一次异常就把定时签到彻底停了
          if (token === scheduleToken) scheduleNext()
        }
      })
    }
    scheduleNext()

    api.on('config', (next, before) => {
      const a = (before && before.ext && before.ext.breeze) || {}
      const b = (next && next.ext && next.ext.breeze) || {}
      if (a.checkinTime !== b.checkinTime || a.checkinOn !== b.checkinOn) scheduleNext()
      // 开关 / key / 音色变了：重新判断该不该开服务（用事件里那份设置，别读 api.settings，两处数据源会打架）
      if (a.on !== b.on || a.apiKey !== b.apiKey || a.voiceId !== b.voiceId) {
        if (bridgeWanted(b)) startBridge(b)
        else stopBridge()
      }
    })
    // 启动时补一次（昨天没开 DSH 的情况）
    api.later(8000, () => tick('startup').catch((e) => api.log.warn('[breeze] 签到入口出错：', e.message)))

    // ---------- 登录并抓 cookie：按需开一次 Chrome，抽完就关 ----------
    // 调试端口不让用户填、也不扫端口段：让 Chrome 自己挑（--remote-debugging-port=0），
    // 它会把自己的端口写进配置目录的 DevToolsActivePort，我们只认这个文件。
    let debugPort = 0

    /** 找浏览器：面板里填的优先，其次常见安装位置（Chrome → Edge → 其他 Chromium） */
    function findBrowser() {
      const fromPanel = String((api.settings() || {}).browserPath || '').trim()
      if (fromPanel && existsSync(fromPanel)) return fromPanel
      const env = process.env
      const bases = [
        ['Google\\Chrome\\Application\\chrome.exe', env.PROGRAMFILES],
        ['Google\\Chrome\\Application\\chrome.exe', env['PROGRAMFILES(X86)']],
        ['Google\\Chrome\\Application\\chrome.exe', env.LOCALAPPDATA],
        ['Microsoft\\Edge\\Application\\msedge.exe', env.PROGRAMFILES],
        ['Microsoft\\Edge\\Application\\msedge.exe', env['PROGRAMFILES(X86)']],
      ]
      const list = bases.filter(([, base]) => base).map(([rel, base]) => join(base, rel))
      list.push(
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      )
      for (const p of list) {
        try {
          if (existsSync(p)) return p
        } catch {}
      }
      return ''
    }

    function chromeDir() {
      const dir = join(api.dataDir(), 'browser')
      mkdirSync(dir, { recursive: true })
      return dir
    }

    /** Chrome 自己把调试端口写在这个文件里（第一行端口、第二行 ws 地址） */
    function activePortFile() {
      return join(chromeDir(), 'DevToolsActivePort')
    }

    async function debugJson(path) {
      if (!debugPort) throw new Error('还没找到调试端口')
      const res = await fetch(`http://127.0.0.1:${debugPort}${path}`, { signal: AbortSignal.timeout(3000) })
      return res.json()
    }

    /** 上次开的那个窗口还活着吗？只看自己配置目录里的 DevToolsActivePort，
     *  不去扫端口 —— 免得连到别人开着的 Chrome 上读别人的 cookie。 */
    function readActivePort() {
      try {
        return parseActivePort(readFileSync(activePortFile(), 'utf8'))
      } catch {
        return { port: 0, wsPath: '' }
      }
    }

    async function findExistingPort() {
      const { port, wsPath } = readActivePort()
      if (!port) return 0
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
        if (!res.ok) return 0
        const v = await res.json()
        return wsMatches(v, wsPath) ? port : 0
      } catch {
        return 0
      }
    }

    function cdpCall(ws, id, method, params) {
      return new Promise((resolve, reject) => {
        const drop = () => {
          try {
            ws.removeEventListener('message', onMsg)
          } catch {}
        }
        const timer = setTimeout(() => {
          drop()
          reject(new Error(`${method} 超时`))
        }, 20000)
        const onMsg = (event) => {
          let m
          try {
            m = JSON.parse(event.data)
          } catch {
            return
          }
          if (m.id !== id) return
          clearTimeout(timer)
          drop()
          resolve(m)
        }
        ws.addEventListener('message', onMsg)
        ws.send(JSON.stringify({ id, method, params }))
      })
    }

    /** 起 Chrome（专用配置目录 + 让 Chrome 自己挑调试端口）；上一次开的还活着就直接用 */
    async function startBrowser({ headless = false } = {}) {
      const alive = await findExistingPort()
      if (alive) {
        debugPort = alive
        return { reused: true }
      }
      const browser = findBrowser()
      if (!browser) throw new Error('没找到 Chrome 或 Edge，可以在设置里手填浏览器路径')
      try {
        unlinkSync(activePortFile())
      } catch {}
      const child = spawn(
        browser,
        [
          '--remote-debugging-port=0',
          `--user-data-dir=${chromeDir()}`,
          '--no-first-run',
          '--no-default-browser-check',
          ...(headless ? ['--headless=new', 'about:blank'] : ['https://breezeblue.ai/zh/auth/login']),
        ],
        { detached: true, stdio: 'ignore' },
      )
      child.on('error', (error) => api.log.warn('[breeze] 浏览器起不来：', error.message))
      child.unref()
      for (let i = 0; i < 60; i++) {
        const { port, wsPath } = readActivePort()
        if (port) {
          debugPort = port
          try {
            const v = await debugJson('/json/version')
            if (wsMatches(v, wsPath)) return { reused: false }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new Error('Chrome 15 秒内没开出调试端口')
    }

    /** 把那个登录窗口关掉（连不上就算了） */
    async function closeBrowser() {
      try {
        const v = await debugJson('/json/version')
        if (!v?.webSocketDebuggerUrl) return
        const ws = new WebSocket(v.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          ws.onopen = resolve
          ws.onerror = () => reject(new Error('连不上'))
        })
        ws.send(JSON.stringify({ id: 98, method: 'Browser.close', params: {} }))
        setTimeout(() => {
          try {
            ws.close()
          } catch {}
        }, 500)
      } catch {}
    }

    /** 读出 breezeblue.ai 的 cookie（能读到 HttpOnly）；关不关窗口由调用方决定 */
    async function grabCookies() {
      const v = await debugJson('/json/version')
      if (!v?.webSocketDebuggerUrl) throw new Error('没有调试地址')
      const ws = new WebSocket(v.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = () => reject(new Error('连不上调试端口'))
      })
      let list = []
      try {
        const r = await cdpCall(ws, 1, 'Storage.getCookies', {})
        list = r?.result?.cookies || []
      } catch (error) {
        api.log.debug('[breeze] Storage.getCookies 失败：', error.message)
      }
      if (!list.length) {
        try {
          const r = await cdpCall(ws, 2, 'Network.getAllCookies', {})
          list = r?.result?.cookies || []
        } catch (error) {
          api.log.debug('[breeze] Network.getAllCookies 失败：', error.message)
        }
      }
      try {
        ws.close()
      } catch {}
      return pickCookies(list)
    }

    let watching = false
    // 退出登录 / 重新登录会换一代，正在盯着的那轮就自己退场，免得退出后又冒出「还没登录」的提示
    let loginGen = 0

    /** 开完窗口后盯着 cookie：一出现登录态就存下来、领一次、关窗口 */
    async function watchLogin(maxMs) {
      if (watching) return
      watching = true
      const gen = loginGen
      const started = Date.now()
      try {
        while (Date.now() - started < maxMs) {
          if (gen !== loginGen) return
          await new Promise((r) => setTimeout(r, 2000))
          let parts = []
          try {
            parts = await grabCookies()
          } catch (error) {
            api.log.debug('[breeze] 等待登录时读不到 cookie：', error.message)
            continue
          }
          if (!looksLoggedIn(parts)) continue
          const msg = await saveAndClaim(parts)
          api.log.info('[breeze] 自动抓取完成：' + msg)
          return
        }
        if (wantNotify()) {
          notifyOwner('Breeze 登录窗口开了 5 分钟还没看到登录，先不等了；要是已经登好了，再点一次「登录」就会直接抓')
        }
      } catch (error) {
        api.log.warn('[breeze] 自动抓取出错：', error.message)
      } finally {
        watching = false
      }
    }

    /** 记下这次登录（只在内存里）、关掉窗口、顺手领一次；通知只在这里发一次 */
    async function saveAndClaim(parts) {
      memCookie = parts.join('; ')
      await closeBrowser()
      writeState({ ...readState(), loginAt: new Date().toISOString() })
      const r = await claim()
      markDone(r.ok, r.message, 'login')
      if (!r.ok) {
        if (wantNotify()) notifyOwner('Breeze 登录好了，但今天没签到成功：' + r.message)
        return '登录好了，但今天没签到成功：' + r.message
      }
      if (r.claimed) notifyClaimed(r.balance)
      return r.balance == null ? '今日已签到成功' : `今日已签到成功，余额 ${r.balance}`
    }

    async function doLogin() {
      const r = await startBrowser()
      // 已经登录过就直接抓；否则盯着等他登
      let parts = []
      try {
        parts = await grabCookies()
      } catch (error) {
        api.log.debug('[breeze] 打开后读 cookie 失败：', error.message)
      }
      if (looksLoggedIn(parts)) {
        const msg = await saveAndClaim(parts)
        return '本来就已经登录着。' + msg
      }
      watchLogin(5 * 60 * 1000)
      return r.reused ? '登录窗口开着呢，登进去以后我自动抓' : '登录窗口开好了，登录完我会自己抓，不用再点'
    }

    api.route('/login', async () => {
      try {
        return { ok: true, message: await doLogin() }
      } catch (error) {
        return { ok: false, message: '开不了浏览器：' + error.message }
      }
    })

    /** 退出登录：清掉 cookie，顺手把那个登录用的浏览器配置目录也清空（换个号才连得上新账号） */
    async function logout() {
      loginGen++
      watching = false
      memCookie = ''
      await closeBrowser()
      // Windows 上 Chrome 放 profile 锁常超过一秒：等到能删为止，删不掉就如实报错，不谎称清干净了
      let removed = false
      for (let i = 0; i < 12 && !removed; i++) {
        await new Promise((r) => setTimeout(r, 250))
        try {
          rmSync(chromeDir(), { recursive: true, force: true })
          removed = true
        } catch {}
      }
      if (!removed) return { ok: false, message: '浏览器配置目录还占着，登录态没清掉；把那个 Chrome 窗口关掉，再点一次「退出登录」' }
      const { loginAt, ...rest } = readState()
      writeState({ ...rest, lastResult: '已退出登录', lastReason: 'logout' })
      api.log.info('[breeze] 已退出登录，浏览器里的登录态清掉了')
    }

    api.route('/logout', async () => {
      try {
        return (await logout()) || { ok: true, message: '已经退出登录，浏览器里的登录态清掉了；要换号就再点「登录」' }
      } catch (error) {
        return { ok: false, message: '退出没干净：' + error.message }
      }
    })

    api.route('/checkin', async () => {
      const r = await claim()
      markDone(r.ok, r.message, 'manual')
      return { ok: r.ok, message: r.ok ? r.message : '没成功：' + r.message }
    })

    api.route('/status', async () => ({ ok: true, hasLogin: hasLogin(), checkin: readState() }))

  },
}
