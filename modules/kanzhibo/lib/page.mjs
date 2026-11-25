// lib/page.mjs —— 页面管道：截图、evalJs、AX、页面/面板文字、聊天行、视口、进房、发评论。
import { readdirSync, statSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { endedFromText, CHAT_LINES_SRC, PAGE_TEXT_SRC } from './room/find.mjs'
import { createAxReader } from './room/ax.mjs'
import { createClicker } from './room/click.mjs'

export function createPage({ ctx, api, note, sleep, ensureMaximized, LIVE_RE, pushSayLog, clickBy }) {
    const shotsDir = () => {
      const dir = join(api.dataDir(), 'shots')
      try { mkdirSync(dir, { recursive: true }) } catch {}
      return dir
    }

    /**
     * 删掉 N 天前的截图（2026-11-09 加）。每次 aim / result / probe 都存一张 PNG，
     *   模块长年挂着跑，shots/ 会无限堆积到几个 GB —— 没人回看一周前的截图。
     * 模块加载时和每次进房时各清一次，单张删除失败不影响别的。
     */
    function cleanShots(keepDays = 7) {
      try {
        const dir = shotsDir()
        const cutoff = Date.now() - keepDays * 86_400_000
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.png')) continue
          const p = join(dir, f)
          try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p) } catch {}
        }
      } catch {}
    }

    /** 截当前页面（整屏，或只截某块）。给「等确认」和失败复盘用。 */
    async function shot(name, rect) {
      if (!ctx.cdp) return ''
      try {
        let params = { format: 'png' }
        if (rect) {
          const sc = await clicker.scroll()
          const pad = 28
          params = {
            format: 'png',
            clip: {
              x: Math.max(0, rect.left + sc.x - pad),
              y: Math.max(0, rect.top + sc.y - pad),
              width: Math.max(16, rect.width + pad * 2),
              height: Math.max(16, rect.height + pad * 2),
              scale: 1,
            },
            captureBeyondViewport: true,
          }
        }
        const r = await ctx.cdp.send('Page.captureScreenshot', params)
        const file = join(shotsDir(), name + '-' + Date.now() + '.png')
        writeFileSync(file, Buffer.from(r.data, 'base64'))
        return file
      } catch (e) {
        note('截图失败：' + (e && e.message), 'debug')
        return ''
      }
    }

    const evalJs = async (expr) => {
      const r = await ctx.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      return r.result ? r.result.value : undefined
    }

    const clicker = createClicker({
      evalJs: (expr) => evalJs(expr),
      send: (method, params) => ctx.cdp.send(method, params),
      sleep,
      note: (t, l) => note(t, l),
    })

    /**
     * 无障碍树（AX）通道。
     * 2026-11-10 真机实测：抖音的粉丝团面板是 Lynx canvas 渲染的 —— DOM 里、innerText 里
     * 一个字都读不到，只有 Chrome 的无障碍树里有（而且坐标就是页面坐标）。
     * 详细实测记录见 lib/room/ax.mjs 开头。
     */
    const ax = createAxReader({
      send: (method, params) => ctx.cdp.send(method, params),
      evalJs: (expr) => evalJs(expr),
      note: (t, l) => note(t, l),
    })

    /** 面板文字：DOM 读不到的那部分（canvas 画的）只能走这里。 */
    const axText = async () => {
      try { return await ax.text({ limit: 2000 }) } catch (e) { return '' }
    }

    /**
     * 主播下播了没有。
     * 抖音下播后 URL 仍然是 /live/<房间号>，光看地址会一直以为在直播间，
     * 于是 tick 每轮都「在房间里」，评论/灯牌的逻辑继续跑。页面出现这几句就是下播了。
     */
    const endedSignals = async () => endedFromText(await pageText(8000))

    /** 直接读聊天列表容器里的消息行（结构化，不依赖整页快照 / 滚动位置）。 */
    const chatLines = async (max = 60) => {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await evalJs('(' + CHAT_LINES_SRC + ')(' + max + ')')
          if (r) return r
        } catch (e) { if (i === 1) note('读聊天区失败：' + ((e && e.message) || e), 'debug') }
        if (i === 0) await sleep(400)
      }
      return { found: false, lines: [], total: 0 }
    }

    /**
     * 整页文字（跨同源 iframe / 影子树）：充值提示、今日任务、余额都从这儿找。
     * 2026-11-09 加：微缓存。一轮 tick 里整页文字要读 4~6 次，每次都遍历主文档 + iframe +
     *   影子树的全部节点，太贵。400ms 内的读共享一次扫描（每次动手之间都有 >400ms 的间隔，
     *   不会读到点了东西之前的旧状态）。内部统一按 20000 扫，按 max 切尾返回。
     */
    let _pageText = { at: 0, text: '' }
    const pageText = async (max = 20000) => {
      if (Date.now() - _pageText.at > 400) {
        try {
          const r = await evalJs('(' + PAGE_TEXT_SRC + ')(20000)')
          _pageText = { at: Date.now(), text: String((r && r.text) || '') }
        } catch {
          _pageText = { at: Date.now(), text: '' }
        }
      }
      const t = _pageText.text
      return t.length > max ? t.slice(t.length - max) : t
    }

    /**
     * 读整页 + 面板的文字（DOM 那一份 + 无障碍树那一份）。
     *
     * 2026-11-10 真机实测：抖音的粉丝团面板是 **Lynx canvas** 渲染的，
     * 面板里的「送1个基础灯牌 / +100 / 今日任务 1/3 / 点亮粉丝团」这些字
     * 在 document.body.innerText 里**一个字都读不到**，只有 Chrome 的无障碍树里有。
     * 所以两个都得读，缺一个就等于瞎。
     *
     * 窗口统一成 TEXT_WINDOW：算「点之前有几个 +100」和「点之后有几个 +100」必须同一个窗口，
     * 否则会把面板里本来就有的 +100 算成这次的（2026-11-10 修的口径不一致）。
     */
    const TEXT_WINDOW = 20000
    let _panelText = { at: 0, text: '' }
    const panelText = async () => {
      if (Date.now() - _panelText.at > 400) {
        const dom = await pageText(TEXT_WINDOW)
        let ax = ''
        try { ax = await axText() } catch {}
        _panelText = { at: Date.now(), text: dom + (ax ? '\n' + ax : '') }
      }
      return _panelText.text
    }

    /**
     * 坐标系契约（第③条）：固定窗口 / 视口 / 缩放，别让同一套判断今天对明天错。
     * 每次动手前调一次；拉不回来只记日志，不硬点。
     */
    async function ensureViewport() {
      // 2026-11-09：窗口一律确保最大化（不再是「先试最大化、失败退 1600x1000」——
      //   那个固定尺寸换分辨率就不对了）。ensureMaximized 内部会回读校验。
      await ensureMaximized()
      try { await ctx.cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }) } catch {}
      try { await ctx.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }) } catch {}
      const vp = await evalJs('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scale: (visualViewport && visualViewport.scale) || 1 })').catch(() => null)
      if (vp) ctx.viewport = vp
      return ctx.viewport
    }

    async function currentUrl() {
      try { return String((await evalJs('location.href')) || '') } catch { return '' }
    }

    async function navigate(url) {
      await ctx.cdp.send('Page.enable').catch(() => {})
      await ctx.cdp.send('Page.navigate', { url })
      await sleep(3500)
    }

    /** 页面真的加载出来了没有：直播间有评论框才算渲染完。 */
    async function waitRoomReady(ms = 30000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const ok = await evalJs(`(() => {
          const boxes = [...document.querySelectorAll('textarea, div[contenteditable="true"]')]
            .filter((el) => el.getClientRects().length)
          if (boxes.length) return true
          return /直播|直播间/.test(document.title || '')
        })()`).catch(() => false)
        if (ok) return true
        await sleep(1500)
      }
      return false
    }

    async function enterFromProfile(url) {
      await navigate(url)
      for (let i = 0; i < 6; i++) {
        const r = await evalJs(`(() => {
          const alive = [...document.querySelectorAll('a[href*="live.douyin.com"]')]
            .find((el) => /直播中|正在直播|LIVE/i.test(el.innerText || ''))
          if (alive) return { kind: 'link', url: alive.href }
          const btn = [...document.querySelectorAll('div,button,span')]
            .find((el) => /^直播中$/.test((el.innerText || '').trim()) && el.getClientRects().length)
          if (btn) { btn.click(); return { kind: 'click' } }
          return { kind: '' }
        })()`).catch(() => null)
        if (r && r.kind === 'link' && r.url) { await navigate(r.url); return 'link' }
        if (r && r.kind === 'click') { await sleep(3000); return 'click' }
        await sleep(2500)
      }
      return ''
    }

    /** 在直播间发一条评论。真实鼠标点框 → 输入 → 点发送/回车。 */
    async function sendComment(text) {
      const content = String(text || '').trim()
      if (!content) return { ok: false, message: '没说要发什么' }
      if (!ctx.cdp) return { ok: false, message: '现在不在直播间里' }
      if (!LIVE_RE.test(await currentUrl())) return { ok: false, message: '现在不在直播间里' }

      const box = await clickBy(
        `[...document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]')]
           .filter((el) => el.getClientRects().length && !el.disabled)
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '评论框',
      )
      if (!box) return { ok: false, message: '没找到评论输入框（页面可能还没加载完）' }
      if (box.blocked) return { ok: false, message: '评论框被挡住 / 命中校验没过（' + ((box.hit && box.hit.good) || 0) + '/9 点命中），这次不发' }
      await sleep(400)

      await ctx.cdp.send('Input.insertText', { text: content })
      await sleep(700)
      const typed = await evalJs(`(() => {
        const el = document.activeElement
        return el ? String(el.value || el.innerText || '').trim() : ''
      })()`).catch(() => '')
      if (!typed) return { ok: false, message: '字没进到评论框里' }

      const clickedBtn = await clickBy(
        `[...document.querySelectorAll('button,div,span')]
           .filter((el) => el.getClientRects().length && /^(发送|送出)$/.test((el.innerText || '').trim()))
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '发送按钮',
      )
      if (!clickedBtn || clickedBtn.blocked) {
        await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      }
      await sleep(1600)

      const left = await evalJs(`(() => {
        const el = document.activeElement
        return el ? String(el.value || el.innerText || '').trim() : ''
      })()`).catch(() => '')
      if (left && left.includes(content.slice(0, 3))) return { ok: false, message: '点了发送但框里还有字，可能没成功' }

      // 2026-11-10 加（H3）：二级验证 —— 框清空了不等于真发出去了（风控会静默吞弹幕）。
      // 等几秒回读聊天区，看到自己这条才算铁证；读不到聊天区就退回一级结论（不阻塞）。
      let verified = false
      for (let i = 0; i < 4; i++) {
        await sleep(1800)
        const lines = await chatLines(30)
        if (!lines.found) break
        const head = content.slice(0, 12)
        if (lines.lines.some((x) => String(x || '').includes(head))) { verified = true; break }
      }
      if (verified) pushSayLog(content)
      return {
        ok: true,
        verified,
        message: verified ? '在直播间说了：' + content : '在直播间说了（聊天区还没刷到这条，可能延迟）：' + content,
      }
    }


  cleanShots()
  return { shot, cleanShots, clicker, evalJs, ax, axText, endedSignals, chatLines, pageText, panelText, ensureViewport, currentUrl, navigate, waitRoomReady, enterFromProfile, sendComment }
}
