// lib/http/admin.mjs —— 只读排查 /probe 与面板发弹幕 /say。
export function registerAdminRoutes(deps) {
  const { api, ctx, livePort, attach, ensureViewport, waitRoomReady, currentUrl, evalJs, chatLines, ax, pageText, clicker, note, sendComment, markSaySent, pushSayLog, journal, SAY_MAX_CHARS, sayWaitSec, LIVE_RE, withBusy } = deps
    api.route('/probe', async (req) => {
      const q = api.core.http.query(req) || {}
      const sock = String((req && req.socket && req.socket.remoteAddress) || '')
      if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(sock)) return { ok: false, code: 403, message: '只允许本机' }
      const what = String(q.what || 'info')
      const ALLOWED = ['info', 'text', 'chat', 'ax', 'pagetext', 'room', 'hit']
      if (!ALLOWED.includes(what)) return { ok: false, disabled: true, what, message: '只读排查：' + ALLOWED.join('|') + '（付费/动作请用 /看直播 或工具）' }
      try {
        if (!ctx.cdp) { const p = await livePort(); if (p) { try { await attach(p) } catch {} } }
        if (!ctx.cdp) return { ok: false, message: '浏览器没开' }
        await waitRoomReady(15000)
        const out = { ok: true, what, url: await currentUrl(), title: await evalJs('document.title'), viewport: ctx.viewport }
        if (what === 'info') out.info = await evalJs(`(() => ({ href: location.href, title: document.title, bodyLen: (document.body && document.body.innerText || '').length, frames: window.frames.length, nodes: document.querySelectorAll('*').length, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight }))()`)
        if (what === 'text') out.matches = await evalJs(`(() => { const w = ${JSON.stringify(String(q.q || '点亮'))}; const out = []; for (const el of document.querySelectorAll('*')) { const t = (el.textContent || '').replace(/\s+/g, ' ').trim(); if (!t || t.length > 40 || !t.includes(w)) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; out.push({ tag: el.tagName.toLowerCase(), text: t, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }) } return out.slice(0, 40) })()`)
        if (what === 'chat') { const c = await chatLines(60); out.chat = { found: c.found, total: c.total, lines: c.lines } }
        if (what === 'ax') { const names = await ax.names({ limit: 2000 }); out.axTotal = names.length; out.axHit = names.slice(0, Number(q.limit || 40)).map((n) => n.name); out.axCandidates = await ax.find(new RegExp(String(q.re || '送灯牌|点亮|赠送|粉丝团')), { limit: 20 }) }
        if (what === 'pagetext') { const t = await pageText(20000); out.length = t.length; out.head = t.replace(/\s+/g, ' ').slice(0, 300); out.hasBadge = /灯牌/.test(t) }
        if (what === 'room') out.commentBoxes = await clicker.find({ text: '.', raw: true, maxTextLen: 999, region: { top: 0, left: 0, right: 1, bottom: 1 } })
        if (what === 'hit') { const x = Number(q.x), y = Number(q.y); out.at = await evalJs(`(() => { const el = document.elementFromPoint(${Number.isFinite(x) ? x : 0}, ${Number.isFinite(y) ? y : 0}); if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), text: ((el.textContent||'')+'').replace(/\s+/g,' ').trim().slice(0,40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] } })()`) }
        return out
      } catch (e) { return { ok: false, message: String((e && e.message) || e) } }
    })

    api.route('/say', async (req) => {
      const sock = String((req && req.socket && req.socket.remoteAddress) || (req && req.connection && req.connection.remoteAddress) || '')
      const loopback = sock === '::1' || sock === '127.0.0.1' || sock === '::ffff:127.0.0.1' || /^127\./.test(sock)
      if (!loopback || !api.config().ownerQQ) return { ok: false, message: '这个接口只认主人在本机面板上的操作' }
      let text = ''
      try { text = String((await api.core.http.body(req)).text || '').trim() } catch {}
      if (!text) return { ok: false, message: '没说要发什么' }
      const chars = Array.from(text)
      if (chars.length > SAY_MAX_CHARS) return { ok: false, message: '太长了：弹幕最多 ' + SAY_MAX_CHARS + ' 个字（这句 ' + chars.length + ' 个）' }
      const wait = sayWaitSec()
      if (wait) return { ok: false, message: '刚发过一条弹幕，' + wait + ' 秒后再发（连发容易触发抖音风控）' }
      if (!ctx.cdp) return { ok: false, message: '现在不在直播间里：先「开」或进一次房' }
      if (!LIVE_RE.test(await currentUrl())) return { ok: false, message: '现在不在直播间里' }
      const r = await withBusy(() => sendComment(text))
      if (r.ok) { markSaySent(); pushSayLog(text); note('面板发弹幕：' + text.slice(0, 20)) }
      journal('面板发弹幕', r.ok ? text : r.message, r.ok)
      return r
    })

}
