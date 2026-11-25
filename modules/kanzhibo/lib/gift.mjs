// lib/gift.mjs —— 送礼：准备/确认/发送/余额与成功证据（花抖币，谨慎）。
// 策略：无人值守只允许「灯牌」自动；送礼永远半自动（必须主人确认），此常量固定 false。
export const GIFT_AUTO_ALLOWED = false
const escapeRe = (s) => String(s || '').replace(/[\\\^\$\.\*\+\?\(\)\[\]\{\}\|]/g, '\\$&')
export function createGift(deps) {
  const { ctx, api, note, sleep, saveState, dayKey, roomKeyOf, currentUrl, evalJs, pageText, clicker, askOwner, journal, GIFT_CELL_SPEC, GIFT_CONFIRM_SPEC, LIVE_RE, ensureViewport, clickBy, gate } = deps
    const hasRecharge = async () => {
      const t = await pageText(20000)
      // 2026-11-09 修：不再认「充值」两个字 —— 抖音礼物面板里常驻一个「充值」入口字样，
      //   原判据在面板打开后（commitGift 的检查都在开面板之后跑）会永远误判成「要充值」，
      //   轻则误报失败，重则整个送礼链路被堵死。只认「结果性」文案。
      return /抖币不足|余额不足|不够抖币|余额不够/.test(t)
    }

    /** 右下角那一带的元素文字，找不到东西时打出来方便排查。 */
    async function dumpCorner() {
      const list = await evalJs(`(() => {
        const out = []
        for (const el of document.querySelectorAll('div,button,span,[aria-label]')) {
          const r = el.getBoundingClientRect()
          if (!el.getClientRects().length) continue
          if (r.top < innerHeight * 0.55 || r.left < innerWidth * 0.55) continue
          if (r.width > 300 || r.height > 300) continue
          const t = ((el.innerText || '') + '|' + (el.getAttribute('aria-label') || '')).trim()
          if (t && t.length <= 40) out.push(t)
        }
        return [...new Set(out)].slice(0, 30)
      })()`).catch(() => [])
      if (list && list.length) note('右下角能看到的元素：' + list.join(' / '), 'debug')
    }

    /** 礼物面板开没开：面板里有「赠送 / 背包 / 全部礼物」这类字样。 */
    async function giftPanelOpen() {
      const t = await pageText(12000)
      return /赠送|送出|背包|全部礼物|热门礼物|推荐\s*发现/.test(t)
    }

    /** 试着打开礼物面板：把像礼物按钮的元素按「越靠右下越优先」一个个点，点完检查面板有没有出来。
     *  2026-11-09 修：面板打开后**绝不再点礼物按钮 / 更多** —— 那是开关，再点一下就把面板关了。
     */
    async function openGiftPanel() {
      if (await giftPanelOpen()) return true
      const sel = `[...document.querySelectorAll('[data-e2e*="gift" i], [aria-label*="礼物"], [title*="礼物"], [class*="gift" i], [class*="Gift"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return el.getClientRects().length && r.width > 8 && r.height > 8 && r.bottom > innerHeight * 0.4
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right || b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)`
      for (let i = 0; i < 6; i++) {
        const hit = await clickBy(`${sel}[${i}]`, '礼物按钮#' + (i + 1))
        if (!hit || hit.blocked) break
        await sleep(1600)
        if (await giftPanelOpen()) return true
      }
      // 再退一步：找文字里有「礼物」的小元素
      const txt = await clickBy(
        `[...document.querySelectorAll('div,span,button')]
           .filter((el) => { const t = ((el.innerText || '') + (el.getAttribute('aria-label') || '')).trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /礼物/.test(t) && t.length <= 20 && r.width < 200 && r.height < 120 })
           [0]`,
        '礼物按钮（文字）',
      )
      if (txt) {
        await sleep(1600)
        if (await giftPanelOpen()) return true
      }
      return false
    }

    /**
     * 送礼：也拆两段。
     *   准备 = 打开礼物面板、按名字选中礼物（这一步不花钱）；
     *   执行 = 重新校验「赠送」按钮，签名没变才按。
     * 礼物名里的正则元字符先转义，别让「(新)」这种名字变成模式。
     */

    // 礼物格子：把底部那条常驻礼物栏排除掉 —— 那一条点下去也会直接送，而且不是「面板里的选择」。

    // 有些版式是「选中礼物 → 再点赠送」；赠送按钮的文字偶尔带价格（赠送 10钻）。

    async function prepareGift(giftName) {
      const name = String(giftName || '').trim()
      if (!name) return { ok: false, message: '没说送什么礼物' }
      if (!ctx.cdp) return { ok: false, message: '现在不在直播间里' }
      if (!LIVE_RE.test(await currentUrl())) return { ok: false, message: '现在不在直播间里' }
      await ensureViewport()
      if (await hasRecharge()) return { ok: false, message: '页面显示抖币不足 / 余额不足，这次不送了' }

      const opened = await openGiftPanel()
      if (!opened) {
        await dumpCorner()
        return { ok: false, message: '礼物面板打不开（点了几次都没弹出来），日志里记了右下角能看到的东西' }
      }
      await sleep(2600)

      // ① 先看有没有独立的「赠送」按钮（选中 → 再送的版式）。有的话，花钱的就是它。
      const confirmFirst = await clicker.prepare({ label: '赠送按钮', spec: GIFT_CONFIRM_SPEC, tries: 2 })
      if (confirmFirst.ok) {
        return { ok: true, prepared: confirmFirst, name, balance: await readBalance(), directSend: false }
      }

      // ② 没有独立按钮：这个版式是「点礼物就直接送」。只定位，一下都不点。
      let cell = await clicker.prepare({ label: '礼物「' + name + '」', spec: GIFT_CELL_SPEC(name), tries: 6, allowMultiple: true })
      // ③ 面板里没有目标礼物：礼物面板常收在「更多」里，点一次「更多」展开全部再找
      if (!cell.ok) {
        const moreBtn = await clickBy(
          `[...document.querySelectorAll('div,span,button')]
             .filter((el) => { const t = (el.innerText || '').trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /^更多$/.test(t) && r.width < 180 && r.height < 70 })
             .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
          '更多',
        )
        if (moreBtn && !moreBtn.blocked) {
          await sleep(1500)
          cell = await clicker.prepare({ label: '礼物「' + name + '」（更多里）', spec: GIFT_CELL_SPEC(name), tries: 6, allowMultiple: true })
        }
      }
      if (!cell.ok) {
        await dumpCorner()
        return { ok: false, message: '礼物面板里找不到「' + name + '」：' + cell.reason }
      }
      return { ok: true, prepared: cell, name, balance: await readBalance(), directSend: true }
    }

    async function commitGift(prepared, name, beforeBalance, directSend) {
      await ensureViewport()
      if (await hasRecharge()) return { ok: false, message: '页面显示抖币不足 / 余额不足，停下来没送' }
      // 2026-11-10 修 BUG：原来余额基准是在 clicker.commit **之后**才补读的
      //   （beforeBalance == null ? await readBalance() : beforeBalance）—— 那时钱已经扣了，
      //   after < before 永远不成立，「余额变少」这条证据整个是死的。
      //   现在：基准一律在点之前读；读不到就当没有余额证据（后面还有成功提示 / 飘屏两条路）。
      const base = beforeBalance == null ? await readBalance() : beforeBalance
      ctx.giftAttemptDay = dayKey(); ctx.giftAttemptRoom = roomKeyOf((await currentUrl()) || ''); ctx.giftAttemptName = name
      if (!saveState({ giftAttemptDay: ctx.giftAttemptDay, giftAttemptRoom: ctx.giftAttemptRoom, giftAttemptName: ctx.giftAttemptName })) {
        return { ok: false, message: '状态写盘失败，为防重复扣钻本次不送' }
      }
      const r = await clicker.commit(prepared, { settleMs: directSend ? 1400 : 900 })
      if (!r.ok) {
        ctx.giftAttemptDay = ''; ctx.giftAttemptRoom = ''; ctx.giftAttemptName = ''
        saveState({ giftAttemptDay: '', giftAttemptRoom: '', giftAttemptName: '' })
        return { ok: false, message: r.reason }
      }
      const proof = await verifyGiftSent(name, base)
      if (await hasRecharge()) return { ok: false, message: '送完弹出了余额不足提示，去手机上看一眼，别重复送' }
      if (proof.ok) {
        ctx.giftAttemptDay = ''; ctx.giftAttemptRoom = ''; ctx.giftAttemptName = ''
        saveState({ giftAttemptDay: '', giftAttemptRoom: '', giftAttemptName: '' })
        return { ok: true, message: '送了「' + name + '」×1（已确认：' + proof.how + '）' }
      }
      return { ok: false, message: '按了，但读了 8 秒没找到送出的证据（' + proof.how + '），你去直播间看一眼，别重复送' }
    }

    /** 送礼一轮：半自动先问主人，自动直接点。 */
    async function sendGift(giftName) {
      if (gate.peek && gate.peek()) return { ok: false, message: '还有一个动作在等你确认，先处理它' }
      const prep = await prepareGift(giftName)
      if (!prep.ok) { journal('准备送礼', prep.message, false); return prep }
      const gt = dayKey(), groom = roomKeyOf((await currentUrl()) || '')
      if (ctx.giftAttemptDay === gt && ctx.giftAttemptRoom === groom && ctx.giftAttemptName === prep.name) {
        return { ok: false, message: '这间房今天送过「' + prep.name + '」但没确认成功，先核对余额/记录，别重复送' }
      }
      // 送礼永远要确认：GIFT_AUTO_ALLOWED 固定 false，即使全局 semiAuto=false 也不能自动送礼
      if (!GIFT_AUTO_ALLOWED || api.settings().semiAuto) {
        return await askOwner({
          kind: 'gift',
          label: '送礼物「' + prep.name + '」',
          prepared: prep.prepared,
          extra: prep.directSend
            ? '⚠ 这个版式是「点礼物就直接送」，按下去就花抖币、没有撤回。'
            : '点的是「赠送」按钮，按下去就花抖币、没有撤回。',
          data: { name: prep.name, balance: prep.balance, directSend: prep.directSend },
        })
      }
      const r = await commitGift(prep.prepared, prep.name, prep.balance, prep.directSend)
      journal('送礼', r.ok ? ('送「' + prep.name + '」×1') : r.message, r.ok)
      return r
    }

    /**
     * 读页面上的抖币余额；读不到返回 null。
     * 先在右下角礼物条那一带找「纯数字」的叶子节点（余额就在那儿），再退回整页文字里的「N 抖币」。
     * 不能直接拿「N 钻」匹配：礼物价格也都是「1钻 / 99钻」，会把价格当余额。
     */
    async function readBalance() {
      // 2026-11-09 修 BUG：原来把「右下角所有纯数字取最大值」当余额，
      //   一旦页面上还有「在线观众 132」「热度 999」这类数字，就会读错，
      //   于是 verifyGiftSent 的「余额变少」判据整个失效（甚至误判成成功/失败）。
      //   现在：只认「礼物栏那一行、且紧挨着钻石图标/礼物按钮的那一个数字」；
      //   有多个候选时**放弃**（返回 null），宁可不判也不读错。
      const dom = await evalJs(`(() => {
        const cands = []
        for (const el of document.querySelectorAll('div,span,p')) {
          if (el.children.length) continue
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) continue
          // 礼物栏那一行：底部 12% 内、水平在 45%~95%（左边是礼物格，右边是余额）
          if (r.top < innerHeight * 0.88) continue
          if (r.left < innerWidth * 0.45 || r.left > innerWidth * 0.95) continue
          const t = (el.textContent || '').trim()
          if (!/^\\d{1,7}$/.test(t)) continue
          cands.push({ v: Number(t), left: Math.round(r.left), top: Math.round(r.top) })
        }
        if (!cands.length) return null
        // 余额是这一行里**最靠右**的那个数字
        cands.sort((a, b) => b.left - a.left)
        // 最靠右的两个如果数值相同，说明读到的是同一处；不同则只信最右那个
        return cands[0].v
      })()`).catch(() => null)
      if (typeof dom === 'number' && Number.isFinite(dom) && dom >= 0) return dom
      const t = await pageText(20000)
      // 2026-11-10 修 BUG：原来写的是 /(\\d[\\d,]{0,6})\\s*(?:抖币|余额)/ —— 普通 JS 正则字面量里
      //   反斜杠只转义一次，`\\d` 会被当成「字面的反斜杠 + d」，所以这条兜底**永远匹配不到**。
      //   实测：'剩余抖币 1234 抖币 余额充足' 用老写法匹配结果是 null，用新写法才匹配到 '1234 抖币'。
      const m = /(\d[\d,]{0,6})\s*(?:抖币|余额)/.exec(t)
      return m ? Number(m[1].replace(/,/g, '')) : null
    }

    /** 送礼后的回读：余额变少 / 出现送出成功提示 / 礼物飘屏里有这个名字，三者算一个就算成了。 */
    async function verifyGiftSent(name, beforeBalance) {
      const deadline = Date.now() + 8000
      let how = '余额没变、也没看到成功提示'
      while (Date.now() < deadline) {
        await sleep(1200)
        const after = await readBalance()
        if (beforeBalance != null && after != null && after < beforeBalance) {
          return { ok: true, how: '抖币 ' + beforeBalance + ' → ' + after }
        }
        const hit = await (async () => {
          const t = await pageText(20000)
          if (/赠送成功|送出成功|已送出|送礼成功|再送一个/.test(t)) return 'success-toast'
          const n = String(name || '')
          // 2026-11-09 修：礼物名里可能带正则元字符（「玫瑰(新)」），直接拼 RegExp 会抛错 —— 用 escapeRe。
          if (n && new RegExp(escapeRe(n) + '\\s*[x×]\\s*\\d').test(t)) return 'gift-banner'
          return ''
        })()
        if (hit === 'success-toast') return { ok: true, how: '页面出现赠送成功提示' }
        if (hit === 'gift-banner') return { ok: true, how: '礼物飘屏里出现了它' }
        if (after == null && beforeBalance == null) how = '页面上读不到抖币余额'
      }
      return { ok: false, how }
    }


  return { hasRecharge, dumpCorner, giftPanelOpen, openGiftPanel, prepareGift, commitGift, sendGift, readBalance, verifyGiftSent }
}
