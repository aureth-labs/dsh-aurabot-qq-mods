// lib/browser.mjs —— 专用浏览器的生命周期（启动/接管/窗口/登录/关闭/视口最大化）。
// 依赖由入口注入：ctx（cdp/port/viewport 共享状态）、api、note、findBrowser、getJson、Cdp、profileDir、navigate。
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from './util.mjs'

export function createBrowser({ ctx, api, note, findBrowser, getJson, Cdp, profileDir, navigate, loadState, evalJs }) {
    async function showWindow(visible) {
      if (!ctx.cdp) {
        if (!visible) return { ok: true, message: '浏览器没开' }
        await ensureBrowser()
      }
      const { windowId } = await ctx.cdp.send('Browser.getWindowForTarget')
      // 2026-11-09：默认就是最大化可见（准确性优先）。别先设 normal 再设 maximized ——
      //   那样窗口会「弹一下」，中间那一帧尺寸不对。
      if (visible) {
        await ensureMaximized()
      } else {
        await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400, width: 1280, height: 900 } })
      }
      if (visible) await ctx.cdp.send('Page.bringToFront').catch(() => {})
      note(visible ? '把直播浏览器挪到屏幕上了' : '把直播浏览器挪回屏幕外', 'info')
      return { ok: true, message: visible ? '窗口已经在屏幕上了（扫码 / 验证都在里面做）' : '窗口收起来了' }
    }

    /**
     * 看这个专用 profile 登录了没有。
     * 判据：直播间页面右上角有没有头像 / 昵称，或者页面上有没有「登录」按钮。
     * 不调用接口、不改任何东西，纯读页面。
     */
    async function loginState() {
      if (!ctx.cdp) {
        const p = await livePort()
        if (p) { try { await attach(p) } catch {} }
      }
      if (!ctx.cdp) return { ok: false, state: 'closed', message: '浏览器没开，先发 /看直播 进 或点「扫码登录」' }
      const r = await evalJs(`(() => {
        const t = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ')
        const hasLoginBtn = /立即登录|登录后|登录抖音|扫码登录/.test(t)
        const avatar = document.querySelector('img[src*="aweme-avatar"], [class*="avatar"] img, [data-e2e*="avatar"]')
        const nick = /([^ ]{1,24})\s*(已关注|关注)/.exec(t)
        return {
          url: location.href,
          hasLoginBtn: hasLoginBtn,
          hasAvatar: Boolean(avatar),
          nickname: nick ? nick[1].slice(0, 24) : '',
        }
      })()`).catch(() => null)
      if (!r) return { ok: false, state: 'unknown', message: '读不到页面状态' }
      const logged = Boolean(r.hasAvatar) && !r.hasLoginBtn
      return {
        ok: true,
        state: logged ? 'in' : (r.hasLoginBtn ? 'out' : 'unknown'),
        nickname: r.nickname || '',
        url: r.url || '',
        message: logged
          ? '已登录' + (r.nickname ? '：' + r.nickname : '')
          : (r.hasLoginBtn ? '没登录（页面上有登录按钮）' : '看不出来，点「显示浏览器窗口」自己看一眼'),
      }
    }

    /** 扫码登录：把窗口挪出来，打开抖音登录页，二维码就在窗口里扫。 */
    async function openLogin() {
      await ensureBrowser()
      await showWindow(true)
      await navigate('https://www.douyin.com/')
      await sleep(2500)
      const st = await loginState()
      return {
        ok: true,
        message: '窗口已经挪到屏幕上了，在里头扫码登录（已登录的话就不用再扫）。' + (st.message ? '现在：' + st.message : ''),
        state: st.state,
      }
    }

    /** 现在在不在设定时间段里。没开定时 = 永远在。支持跨午夜（22:30 → 01:00）。 */
    const inWindow = (date = new Date()) => {
      const s = api.settings()
      if (!s.schedule) return true
      const toMin = (text, fallback) => {
        const m = /^(\d{1,2})\s*[:：]\s*(\d{2})$/.exec(String(text || '').trim())
        if (!m) return fallback
        return Math.max(0, Math.min(23, Number(m[1]))) * 60 + Math.max(0, Math.min(59, Number(m[2])))
      }
      const a = toMin(s.startTime, 20 * 60)
      const b = toMin(s.endTime, 23 * 60 + 30)
      const now = date.getHours() * 60 + date.getMinutes()
      if (a === b) return true
      return a < b ? now >= a && now < b : now >= a || now < b
    }

    async function attach(p) {
      const list = await getJson('http://127.0.0.1:' + p + '/json/list', 5000)
      // 2026-11-09：优先挑抖音相关的页 —— 浏览器里多开过标签时，第一个 page
      //   可能是 about:blank 或别的站，挂错页后面的全白做。
      const page = list.find((t) => t.type === 'page' && /douyin\.com/.test(String(t.url || '')))
        || list.find((t) => t.type === 'page')
      if (!page) throw new Error('浏览器里没有可用页面')
      ctx.cdp = await Cdp.connect(page.webSocketDebuggerUrl)
      ctx.port = p
      // 2026-11-09：凡是连上（新建 or 复用已有的）都确保一次最大化。
      //   之前只在 launch() 的 spawn 分支里做，所以「第二次开总开关」复用旧窗口时不会最大化。
      await ensureMaximized()
    }

    /**
     * 把 profile 里「上次窗口位置」改成最大化。
     * Chrome 和 Edge 都在 <profile>/Default/Preferences 的 browser.window_placement 里记窗口状态，
     * 启动时会优先恢复它 —— 这也是为什么光给 --start-maximized 没用。
     *
     * 2026-11-09 修：**不要写死 work_area / right / bottom**。
     *   之前写了 2560x1400，换一台机器或换分辨率就按错误尺寸铺，等于没最大化。
     *   现在只置 maximized: true，并删掉旧的具体边界 —— 让浏览器自己按**当前**工作区算。
     */
    function forceMaximizedInProfile(dir) {
      try {
        const prefFile = join(dir, 'Default', 'Preferences')
        if (!existsSync(prefFile)) return false
        const j = JSON.parse(readFileSync(prefFile, 'utf8'))
        if (!j.browser) j.browser = {}
        const cur = j.browser.window_placement || {}
        // 只保留工作区四个值（浏览器自己会更新），去掉写死的窗口边界
        j.browser.window_placement = {
          work_area_left: cur.work_area_left ?? 0,
          work_area_top: cur.work_area_top ?? 0,
          work_area_right: cur.work_area_right ?? 0,
          work_area_bottom: cur.work_area_bottom ?? 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          maximized: true,
        }
        delete j.browser.last_window_state
        writeFileSync(prefFile, JSON.stringify(j), 'utf8')
        note('已把 profile 的窗口状态标成最大化', 'debug')
        return true
      } catch (e) {
        note('改 profile 窗口状态失败（不影响启动）：' + ((e && e.message) || e), 'debug')
        return false
      }
    }

    /**
     * 确保窗口是最大化的（可重复调用，随便多少次）。
     * 2026-11-09：这是「换分辨率 / 第二次开」也生效的关键 ——
     *   不再只依赖启动参数和 profile，而是每次连上浏览器之后主动请求一次 maximized，
     *   并用 CDP 回读校验；不是最大化就再请求一次。
     */
    async function ensureMaximized() {
      if (!ctx.cdp) return false
      try {
        const w = await ctx.cdp.send('Browser.getWindowForTarget')
        const windowId = w && w.windowId
        if (!windowId) return false
        const b = await ctx.cdp.send('Browser.getWindowBounds', { windowId })
        if (b && b.bounds && b.bounds.windowState === 'maximized') return true
        await ctx.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }).catch(() => {})
        await sleep(600)
        const b2 = await ctx.cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null)
        const ok = Boolean(b2 && b2.bounds && b2.bounds.windowState === 'maximized')
        if (ok) note('窗口已最大化', 'debug')
        else note('窗口没能最大化（浏览器拒绝了这个请求）', 'warn')
        return ok
      } catch (e) {
        note('确认最大化失败：' + ((e && e.message) || e), 'debug')
        return false
      }
    }

    async function launch() {
      const custom = api.settings().browserPath
      const bin = findBrowser(custom)
      if (!bin) {
        throw new Error(String(custom || '').trim()
          ? '面板里填的浏览器路径不对：' + custom
          : '找不到 Edge / Chrome，先装一个，或在面板里填浏览器路径')
      }
      const dir = profileDir()
      mkdirSync(dir, { recursive: true })

      try {
        const saved = Number(String(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
        if (saved && (await getJson('http://127.0.0.1:' + saved + '/json/version', 1200).catch(() => null))) {
          await attach(saved)
          return saved
        }
      } catch {}

      // 2026-11-09 关键修复：Chrome / Edge 会用 profile 里保存的窗口位置覆盖 --start-maximized。
      //   实测 Preferences 里 browser.window_placement.maximized = false、bottom/right = 1280x860，
      //   于是不管命令行怎么给，窗口一出来永远是那个小窗。
      //   所以启动前先把这段改成「最大化 + 铺满工作区」，两种浏览器都吃这一套。
      forceMaximizedInProfile(dir)

      // 2026-11-10 修 BUG：原来自己随机挑一个 9300~9699 的端口、还把它写进 DevToolsActivePort。
      //   但那个端口只是「预选」—— 真正生效的端口由 Chrome 自己决定（被占时会自动换），
      //   Chrome 起来后会把**真实**端口写进 profile 的 DevToolsActivePort 文件。
      //   旧写法按假端口轮询，端口一被占就「60 次全失败 → 浏览器没起来」，
      //   实际浏览器已经开着（孤儿进程）。现在：不猜端口，起来后读真实文件。
      note('启动看直播专用浏览器')
      const child = spawn(bin, [
        '--user-data-dir=' + dir,
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
        // 2026-11-09：启动就最大化。
        // 关键：**不能同时给 --window-size** —— Chromium 里 window-size 会覆盖
        // --start-maximized，结果就是「先开一个小窗，再被 ensureViewport 改成大窗」。
        // 所以这里只给 --start-maximized（+ 起始位置），窗口一出来就是最大化。
        '--window-position=0,0',
        '--start-maximized',
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true })
      child.unref()

      // 读 Chrome 自己写的真实端口文件（ctx.port=0 时由系统分配并写回 profile）
      const readRealPort = () => {
        try {
          const saved = Number(String(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
          return saved || 0
        } catch { return 0 }
      }
      for (let i = 0; i < 120; i++) {
        await sleep(250)
        const real = readRealPort()
        if (real && await getJson('http://127.0.0.1:' + real + '/json/version', 900).catch(() => null)) {
          await attach(real)
          return real
        }
      }
      // 30 秒没读到真实端口：杀掉本次 spawn 的浏览器，避免孤儿进程占着 profile 反复重拉
      try { child.kill() } catch {}
      throw new Error('浏览器起来了但没等到调试端口（profile: ' + dir + '），已结束本次启动的进程')
    }

    let ensurePromise = null
    async function ensureBrowser() {
      if (ctx.cdp) return
      if (!ensurePromise) ensurePromise = launch().finally(() => { ensurePromise = null })
      await ensurePromise
    }

    /** 从 DevToolsActivePort 拿端口，并确认它还活着；拿不到返回 0。 */
    async function livePort() {
      try {
        const saved = Number(String(readFileSync(join(profileDir(), 'DevToolsActivePort'), 'utf8')).split('\n')[0])
        if (!saved) return 0
        const ok = await getJson('http://127.0.0.1:' + saved + '/json/version', 1200).catch(() => null)
        return ok ? saved : 0
      } catch { return 0 }
    }

    /**
     * 按 profile 路径把残留的浏览器进程杀掉。
     * 只杀命令行里带我们 live-profile 目录的那些 —— 不碰你平时用的 Edge / Chrome。
     */
    function killBrowserProcess() {
      const dir = profileDir()
      try {
        if (process.platform === 'win32') {
          // 2026-11-09：不再按进程名过滤成 msedge/chrome 两种 —— 面板里 browserPath 可以填
          //   任意 Chromium 系浏览器（Brave / Vivaldi / 改名的便携版），写死会杀不掉残留进程。
          //   双保险：进程名得像 Chromium 系 + 命令行里带着 live-profile 目录。
          const script = [
            '-NoProfile', '-Command',
            "Get-CimInstance Win32_Process | " +
            "Where-Object { $_.Name -match '^(msedge|chrome|chromium|brave|vivaldi|opera)\\.exe$' -and $_.CommandLine -like '*" + dir.replace(/'/g, "''") + "*' } | " +
            'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
          ]
          execFileSync('powershell', script, { timeout: 20000, windowsHide: true })
        } else {
          execFileSync('pkill', ['-f', dir], { timeout: 10000 })
        }
        return true
      } catch (e) {
        note('按进程关浏览器失败：' + ((e && e.message) || e), 'warn')
        return false
      }
    }

    /**
     * 真的把浏览器关掉。三条路依次试，因为「ctx.cdp 连接」和「浏览器进程」不是一回事：
     *   ① 还有 ctx.cdp 连接 → Browser.close
     *   ② 连接断了但端口还活着（模块重载过、ctx.cdp 丢了）→ 自己连上去发 Browser.close
     *   ③ 还不退 → 按 live-profile 路径杀进程
     * 2026-11-08 修：原来第一行就是 if (!ctx.cdp) return —— 模块一重载 ctx.cdp 变 null，
     *   关总开关时这里直接空转，浏览器一直挂着（主人实测踩到）。
     */
    async function closeBrowser() {
      let asked = false
      if (ctx.cdp) {
        try { await ctx.cdp.send('Browser.close'); asked = true } catch {}
        try { ctx.cdp.close() } catch {}
        ctx.cdp = null
      }
      if (!asked) {
        const p = await livePort()
        if (p) {
          try {
            const v = await getJson('http://127.0.0.1:' + p + '/json/version', 1500)
            const ws = new WebSocket(v.webSocketDebuggerUrl)
            await new Promise((resolve) => {
              const done = () => { try { clearTimeout(timer) } catch {} resolve() }
              const timer = setTimeout(done, 2500)
              ws.addEventListener('open', () => {
                try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} })) } catch {}
                setTimeout(done, 300)
              })
              ws.addEventListener('error', done)
            })
            try { ws.close() } catch {}
          } catch {}
        }
      }
      await sleep(1200)
      const still = await livePort()
      if (still) {
        note('浏览器没自己退（端口 ' + still + ' 还在），改成按进程关掉', 'warn')
        killBrowserProcess()
        await sleep(1200)
      }
      const after = await livePort()
      if (after) {
        note('浏览器还活着（端口 ' + after + '），这次没关掉', 'warn')
        return false
      }
      // 关干净了就同步清掉内存里的端口 / 视口，别让状态显示成还连着
      ctx.port = 0
      ctx.viewport = null
      return true
    }


  return { showWindow, openLogin, attach, forceMaximizedInProfile, launch, ensureBrowser, livePort, killBrowserProcess, closeBrowser, ensureMaximized, inWindow, loginState }
}
