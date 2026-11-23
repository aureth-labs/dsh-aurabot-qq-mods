// lib/badge.mjs —— 粉丝团灯牌：判定/准备/点击/证据/doBadge。
// 依赖全部由入口注入（ctx 持有 badge*/gift* 钱状态）。
export function createBadge(deps) {
  const {
    ctx, api, note, sleep, saveState, dayKey, roomKeyOf, panelText, chatLines, shot,
    clicker, ax, clickBy, choosePoint, describeHit, axSig, normalizeSpec, collapseNested, pickUnique, sameSig, evalJs, askOwner, gate,
    BADGE_ENTRY_SPEC, BADGE_CONFIRM_SPEC, BADGE_CONFIRM_TEXTS, TASK_ENTRY_EXPR,
    BADGE_CHAT_RE, taskProgressFromText, plus100FromText, badgeHintsFromText,
    badgeTaskRowFromText, badgeRowState, EVIDENCE_WAIT_MS, currentUrl, ensureViewport, journal,
  } = deps
    async function badgeSent() {
      if (api.settings().badgeJudgeV2) {
        const t0 = await panelText()
        // 真机经验：已送态面板是「今日任务 X/3 + 今日第N位送灯牌，连续N天」，需带进度一起判
        const bs = badgeRowState(t0, { progressBefore: taskProgressFromText(t0) })
        if (bs.state === 'sent') return true
        if (bs.state === 'open') return false
      }
      const readDomTask = () => evalJs(`(() => {
        // 只认「任务行」：灯牌 + （亲密度 / 已完成 / 送1个）这类字样；
        // 聊天区的「送出了 粉丝团灯牌 × 1」不算，别把它当任务面板。
        const rows = [...document.querySelectorAll('div,span,p,li')].filter((el) => {
          const t = (el.innerText || '').trim()
          if (!t || t.length > 160) return false
          if (!/灯牌/.test(t)) return false
          return /亲密度|已完成|送1个|粉丝团任务/.test(t)
        })
        if (!rows.length) return 'none'
        const texts = rows.map((el) => (el.innerText || '').trim())
        if (texts.some((t) => /已完成|已送出|已领取|已点亮/.test(t))) return 'sent'
        return 'todo'
      })()`).catch(() => 'none')

      // 面板可能整个在 iframe / 影子树里，上面那段查不到 —— 用整页文字兜底。
      const readTask = async () => {
        const dom = await readDomTask()
        if (dom === 'sent') return 'sent'
        // 2026-11-10：改用 panelText（DOM + 无障碍树）—— 面板是 Lynx canvas，
        //   「今日任务 X/3」在 innerText 里读不到，只有无障碍树里有。
        const t = await panelText()
        // 2026-11-08：新版左上角直接写「今日任务 X/3」，X>=1 就说明今天动过了，
        //   不用再靠「已完成 / 已点亮」那套文案（新版界面上已经看不到了）。
        if (taskProgressFromText(t) >= 1) return 'sent'
        if (!/灯牌|点亮粉丝团/.test(t)) return dom
        if (/灯牌[^\n]{0,30}(已完成|已领取|已点亮)/.test(t)) return 'sent'
        return dom
      }

      const taskEntry = TASK_ENTRY_EXPR

      const first = await readTask()
      if (first === 'sent') return true
      // 2026-11-09 优化：面板开着且显示「没送」就别点开关了 —— 原来这里点一下收起、
      //   紧接着 prepareBadge 又点一下打开，一轮对同一个入口最多点 3 次（慢，还多两次点偏的机会）。
      //   面板留给 prepareBadge 直接用；收不收由 closeTaskPanel 在流程收尾时统一管。
      if (first === 'todo') return false
      const opened = await clickBy(taskEntry, '今日任务')
      if (!opened || opened.blocked) return false
      await sleep(1800)
      const st = await readTask()
      return st === 'sent'
    }

    /**
     * 把「今日任务 / 粉丝团」面板收起来（如果还开着）。
     * 先读页面文字确认面板真的开着才点 —— 入口是开关，面板本来关着时点一下反而把它打开。
     * 判据只用「面板独有」的文案（送1个基础灯牌 / 100亲密度 / 恢复勋章 / 已暂存），
     * 「1钻」不算：礼物栏里也可能有带钻的价格。
     */
    async function closeTaskPanel() {
      try {
        const t = await panelText()
        const h = badgeHintsFromText(t)
        const open = badgeTaskRowFromText(t) || h.hasIntimacy || h.hasRestoreMedal || h.hasStash
        if (!open) return false
        const c = await clickBy(TASK_ENTRY_EXPR, '今日任务')
        if (c && !c.blocked) {
          await sleep(400)
          return true
        }
        // 2026-11-10 加：新版面板是 Lynx canvas，左上角根本没有「今日任务」这个入口，
        //   面板右上角倒是有个叉（#__living_right_panel_id 里那个 svg）。没有入口就点叉收掉。
        const x = await evalJs(`(() => {
          const panel = document.querySelector('#__living_right_panel_id')
          if (!panel) return null
          const svgs = [...panel.querySelectorAll('svg')].filter((s) => {
            const r = s.getBoundingClientRect()
            return r.width >= 12 && r.width <= 60 && r.height >= 12 && r.height <= 60 && r.top < 120
          })
          if (!svgs.length) return null
          const r = svgs[0].getBoundingClientRect()
          return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
        })()`).catch(() => null)
        if (!x) return false
        await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x[0], y: x[1], button: 'none', buttons: 0 }).catch(() => {})
        await sleep(120)
        await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x[0], y: x[1], button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
        await sleep(60)
        await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x[0], y: x[1], button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
        await sleep(400)
        return true
      } catch { return false }
    }

    /**
     * 灯牌：拆成「准备」和「确认后执行」两段。
     *   准备 = 点开左上角粉丝团入口（不花钱）+ 找出面板里的「赠送/点亮」按钮（只找不点）；
     *   执行 = 重新校验一次，签名没变、命中校验过了，才真按下去。
     * 2026-11-06：这套替换了原来的 el.click() —— 那版只要选错元素就直接点到别处去了。
     */

    // 抖音的按钮常把价格写在文字里：「点亮（1钻）」「赠送 10 钻」。所以价格括号要允许，
    // 但别的字一律不许跟 —— 「点亮粉丝团恢复勋章」这种标题就不会被当成按钮。
    //
    // 2026-11-09：同一块面板里可能同时出现「赠送」和「送灯牌」两个按钮（一个是恢复勋章、
    //   一个是续灯牌），文字不同 → 合并不到一起 → 候选唯一性直接拒绝，主人收到
    //   「⚠️ 灯牌：候选不唯一（2 个）」。改成**按优先级逐个试**，不是要求全局面板只有一个按钮。
    // 1.0.3（2026-11-09 真机）：抖音把按钮改叫「送1个基础灯牌」了 —— 原来的文字表一个都不匹配，
    //   于是整轮落到下面的裸「点亮」，而页面上那排「加油鸭 差10个点亮 [点亮]」（星守护/展馆）
    //   正好贡献了 7 个同名按钮 → pickUnique 直接拒绝，报「面板里同时找到 7 个可能的按钮」。
    //   补上真实文案，并且用 excludeAncestor 把那排集星按钮挡掉。

    // 2026-11-09 优化：一次全页扫描用这个合并模式（原来 9 个文字逐个 prepare，
    //   每个最多 10 次 find，最坏 90 次全 DOM 扫描找一个按钮）。
    //   扫完再按优先级文字分组、逐组判唯一 —— 行为等价（同一文字内仍然要求唯一）。
    const BADGE_CONFIRM_SCAN = '^(?:' + BADGE_CONFIRM_TEXTS.map((t) => t.replace(/^\^/, '').replace(/\$$/, '')).join('|') + ')(?:\\s*[（(][^）)]{0,8}[）)])?$'

    /**
     * 无障碍树里的按钮名（Lynx canvas 面板专用）。
     * 实测抖音的文案是「点亮粉丝团」「送灯牌」「加入粉丝团」这些。
     * 注意「点亮粉丝团」在聊天区的播报里也会出现 —— 但聊天区在根 frame 里，
     * 而 AX 的命中校验要求目标**落在某个 iframe（面板）上**，所以聊天区那条会被自动挡掉。
     */
    const BADGE_AX_NAMES = /^(送灯牌|点亮粉丝团|点亮粉丝团灯牌|点亮灯牌|送1个基础灯牌|一键点亮|点亮|赠送|续费|送出|立即续费)$/

    /**
     * AX 通道找「要按的那个按钮」（Lynx canvas 面板）。
     *   名字 → 页面坐标 → 命中校验（这块位置得真的露在面板上）→ 连续两帧签名一样才收。
     * 找不到 / 校验不过就返回 ok:false，让上层继续走别的路。
     */
    async function findBadgeConfirmAx() {
      const cands = await ax.find(BADGE_AX_NAMES, { limit: 20 })
      if (!cands.length) return { ok: false, reason: '无障碍树里没有「送灯牌 / 点亮」这类按钮' }
      // 同一个名字、位置几乎重合的算一个
      const groups = new Map()
      for (const c of cands) {
        const key = c.name + '|' + Math.round(c.x / 8) + '|' + Math.round(c.y / 8)
        if (!groups.has(key)) groups.set(key, c)
      }
      const list = Array.from(groups.values())
      if (list.length > 1) {
        const names = list.slice(0, 3).map((x) => x.name).join(' / ')
        return { ok: false, reason: '面板里同时找到 ' + list.length + ' 个可能的按钮（' + names + '），分不清该点哪个' }
      }
      const cand = list[0]
      const h = await ax.hit(cand)
      if (!h.ok) return { ok: false, reason: describeHit(h) }
      const pt = choosePoint(h.points)
      if (!pt) return { ok: false, reason: '没有可点位置' }
      return {
        ok: true,
        label: '灯牌按钮（无障碍树）/ ' + cand.name + ' /',
        spec: normalizeSpec({ ...BADGE_CONFIRM_SPEC, text: BADGE_CONFIRM_SCAN }),
        allowMultiple: false,
        cand: { text: cand.name, sig: axSig(cand), rect: { left: cand.x, top: cand.y, width: cand.w, height: cand.h }, area: cand.w * cand.h, tag: 'ax', clickable: true, where: 'ax' },
        hit: h,
        point: pt,
        desc: describeHit(h),
        channel: 'ax',
        axSig: axSig(cand),
      }
    }

    /** 按优先级找「要按的那个按钮」：一次扫描 → 按文字分组判唯一 → 连续两帧同一签名才收。 */
    async function findBadgeConfirm(tries) {
      const rounds = Math.max(2, Math.min(16, Number(tries) || 2))
      let prev = null // 上一帧选中的（文字 + 签名 + 位置），用于「两帧一致才动手」
      const reasons = []
      for (let round = 0; round < rounds; round++) {
        const found = await clicker.find({ ...BADGE_CONFIRM_SPEC, text: BADGE_CONFIRM_SCAN })
        if (found.error) { reasons.push(found.error); if (round + 1 < rounds) await sleep(60); continue }
        const list = found.list || []
        for (const text of BADGE_CONFIRM_TEXTS) {
          let re
          try { re = new RegExp(text, 'u') } catch { continue }
          const group = collapseNested(list.filter((c) => re.test(String(c.text || '').trim())))
          if (!group.length) continue
          const u = pickUnique(group)
          if (!u.ok) { reasons.push(u.reason); continue }
          const stable = prev && prev.text === text && sameSig(prev.cand.sig, u.cand.sig) &&
            prev.cand.rect.left === u.cand.rect.left && prev.cand.rect.top === u.cand.rect.top
          prev = { text, cand: u.cand }
          if (!stable) break // 和 stableFind 一个规矩：等连续两帧一致
          const idx = Math.max(0, list.indexOf(u.cand)) // find 给候选编的 data-ab-pick 序号
          const h = await clicker.hit(idx)
          if (!h.ok) { reasons.push(describeHit(h)); prev = null; continue }
          const pt = choosePoint(h.points)
          if (!pt) { reasons.push('没有可点位置'); prev = null; continue }
          return { ok: true, label: '灯牌按钮 /' + text + '/', spec: normalizeSpec({ ...BADGE_CONFIRM_SPEC, text }), allowMultiple: false, cand: u.cand, hit: h, point: pt, desc: describeHit(h), channel: 'dom' }
        }
        // 2026-11-10 加：DOM 里找不到就问无障碍树 —— 现在的粉丝团面板是 Lynx canvas，
        //   按钮的文字压根不在 DOM 里，只在无障碍树里。
        const axr = await findBadgeConfirmAx()
        if (axr.ok) {
          // 连续两帧签名一样才收（和 DOM 通道一个规矩：别按一个正在动的按钮）
          if (prev && prev.channel === 'ax' && prev.axSig === axr.axSig) return axr
          prev = { channel: 'ax', axSig: axr.axSig }
          if (round + 1 < rounds) { await sleep(60); continue }
          return axr
        }
        reasons.push(axr.reason)
        if (round + 1 < rounds) await sleep(60)
      }
      return { ok: false, reason: '几个可能的按钮都没找到或不稳定（' + reasons.filter(Boolean).slice(0, 3).join('；') + '）' }
    }

    /**
     * 打开粉丝团面板。
     *
     * 2026-11-10 真机实测（现在的抖音 PC 版）：
     *   · 左上角的入口**没有文字** —— 是主播头像上的一个图片徽章，
     *     DOM 里 class 是哈希（.PvcS0FNI 这种），每版都变，不能写死；
     *   · **悬停**头像会弹出一张「主播资料卡」（这张卡是普通 DOM，能读到「粉丝团 / 团成员：11.0万」）；
     *   · 点卡里的「粉丝团」才会打开**粉丝团面板**（面板是 Lynx canvas，只有无障碍树读得到）。
     * 所以顺序是：头像 → 资料卡 → 粉丝团 → 面板。
     *
     * 老的「入口上带文字（今日任务 / 粉丝团）」那种版式也还留着 —— 先试它，找不到再走上面的路。
     */
    async function openBadgePanel() {
      // ① 老版式：入口本身带文字，直接按文字找（region 还是左上角那块）
      const entry = await clicker.clickOnce({
        label: '粉丝团/灯牌入口',
        spec: BADGE_ENTRY_SPEC,
        allowMultiple: true,
        settleMs: 2600,
      })
      if (entry.ok) {
        return { ok: true, entry: (entry.cand && entry.cand.text) || '', justOpened: true }
      }

      // ② 新版式：头像 → 资料卡 → 粉丝团
      const badge = await evalJs(`(() => {
        const nick = document.querySelector('[data-e2e="live-room-nickname"]')
        if (!nick) return []
        const nr = nick.getBoundingClientRect()
        const out = []
        for (const el of document.querySelectorAll('div,span,img,a,button')) {
          const r = el.getBoundingClientRect()
          if (!(r.width >= 18 && r.width <= 100 && r.height >= 18 && r.height <= 100)) continue
          if (r.top > nr.top + 40 || r.bottom < nr.top - 10) continue
          const gap = nr.left - r.right
          if (gap < -6 || gap > 160) continue
          let cs = null
          try { cs = getComputedStyle(el) } catch (e) {}
          // 越靠昵称、越像按钮的排前面
          const score = Math.max(0, gap) + (cs && cs.cursor === 'pointer' ? 0 : 60) + r.width * r.height / 1500
          out.push({ score, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) })
        }
        out.sort((a, b) => a.score - b.score)
        return out.slice(0, 5)
      })()`).catch(() => [])
      if (!badge || !badge.length) {
        return { ok: false, message: '入口没点成（粉丝团 / 今日任务都没找到），左上角也认不出头像：' + entry.reason }
      }
      for (const b of badge) {
        // 悬停 → 资料卡会冒出来
        await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 }).catch(() => {})
        await sleep(1400)
        const fan = await evalJs(`(() => {
          const nodes = [...document.querySelectorAll('div,span,a,button')].filter((el) => {
            const r = el.getBoundingClientRect()
            if (!(r.width > 20 && r.height > 10 && r.width < 320 && r.height < 140)) return false
            if (r.left > innerWidth * 0.35 || r.top > innerHeight * 0.55) return false
            const t = (el.innerText || '').trim()
            return /^粉丝团/.test(t)
          })
          if (!nodes.length) return null
          nodes.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
          const el = nodes[0]
          const sp = el.querySelector('span') || el
          const r = sp.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: String(el.innerText || '').trim().slice(0, 24) }
        })()`).catch(() => null)
        if (!fan) continue
        // 点资料卡里的「粉丝团」→ 粉丝团面板
        await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fan.x, y: fan.y, button: 'none', buttons: 0 }).catch(() => {})
        await sleep(200)
        await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fan.x, y: fan.y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
        await sleep(60)
        await ctx.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fan.x, y: fan.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
        await sleep(3200)
        const opened = await fanPanelOpen()
        if (opened) return { ok: true, entry: '头像 → 资料卡 → ' + (fan.text || '粉丝团'), justOpened: true }
      }
      return { ok: false, message: '点了左上角头像也没打开粉丝团面板（资料卡里的「粉丝团」没找到）' }
    }

    /**
     * 粉丝团面板开没开。
     * 2026-11-10：不能只看文字 —— 聊天区的播报里也有「点亮粉丝团」，
     *   光看文字会把「聊天里有人送了灯牌」当成「面板开着」。
     *   所以先看 DOM 里那个面板容器（#__living_right_panel_id，里面有 iframe）在不在，
     *   再看无障碍树里的文字对不对得上。
     */
    async function fanPanelOpen() {
      const dom = await evalJs(`(() => {
        const p = document.querySelector('#__living_right_panel_id')
        if (!p) return false
        return !!p.querySelector('iframe')
      })()`).catch(() => false)
      if (!dom) return false
      const t = await panelText()
      return /粉丝团|送灯牌|点亮粉丝团|加入粉丝团|粉丝团专属|级团|点亮成员/.test(t)
    }

    /**
     * 点之前的三道确认（2026-11-10 按真机实测改）：
     *   ① 入口：左上角头像 / 资料卡里的「粉丝团」，或已经是「今日任务 0/3」；
     *   ② 等面板出来后：要看到「1钻」和「可得 100 亲密度」这类字，才算真的开对了面板；
     *   ③ 然后才去找「送灯牌 / 点亮」那个按钮（只找不点）。
     * 任何一条对不上就返回失败，绝不默认「大概是吧」。
     *
     * 2026-11-10 关键改动：面板文字要**同时**读 DOM 和无障碍树 ——
     *   现在的粉丝团面板是 Lynx canvas 渲染的，DOM 里一个字都没有，只有无障碍树里有。
     */
    async function prepareBadge() {
      await ensureViewport()

      // ① 先读进度：DOM 和无障碍树都要读。
      //    实测当前抖音版「今日任务 X/3」不在 innerText 里（它画在 canvas 上），
      //    读不到就当 null（不当成 0），后面靠「面板状态」和聊天播报去判断。
      const beforeText = await panelText()
      const progressBefore = taskProgressFromText(beforeText)
      const hasFanclub = /粉丝团/.test(beforeText)
      if (api.settings().badgeJudgeV2) {
        const bs = badgeRowState(beforeText, { progressBefore })
        if (bs.state === 'sent') return { ok: false, message: '灯牌已是已送态（judgeV2），不再送' }
        if (bs.state === 'unknown') return { ok: false, message: '灯牌面板状态读不准（judgeV2），不自动点' }
      }
      if (progressBefore !== null && progressBefore >= 1) {
        return { ok: false, message: '今日任务已经是 ' + progressBefore + '/3，今天动过了，不再送' }
      }
      if (progressBefore === null && !hasFanclub) {
        return { ok: false, message: '左上角既没有「今日任务 X/3」也没有「粉丝团」，现在不像能送灯牌的直播间' }
      }

      // 面板可能已经开着：先看按钮在不在，在就直接用（再点入口会把它关掉）
      let prep = await findBadgeConfirm(10)
      let entryText = ''
      let panelJustOpened = false
      if (!prep.ok) {
        // 2026-11-09 优化：面板开着（badgeSent 读完后特意留着 / 主人手动开过）就别点入口了 ——
        //   入口是开关，点一下反而把面板关掉，然后「找不到按钮」白忙一轮。
        //   用面板独有的文案判断开没开，和 closeTaskPanel 同一套判据。
        const t2 = await panelText()
        const h2 = badgeHintsFromText(t2)
        const panelOpen = badgeTaskRowFromText(t2) || h2.hasIntimacy || h2.hasRestoreMedal || h2.hasStash
        if (panelOpen) {
          prep = await findBadgeConfirm(12)
        } else {
          const opened = await openBadgePanel()
          if (!opened.ok) return { ok: false, message: opened.message }
          entryText = opened.entry
          panelJustOpened = opened.justOpened
          prep = await findBadgeConfirm(16)
        }
      }
      if (!prep.ok) {
        // 2026-11-10：面板上只有「加入粉丝团（1钻石）」时，先把话说清楚 ——
        //   那是**开通**按钮，不是「续灯牌」，点错就白花 1 钻。
        const ptext2 = await panelText()
        if (/加入粉丝团/.test(ptext2)) {
          return { ok: false, message: '这个直播间还没加入粉丝团（面板上是「加入粉丝团（1钻石）」），要先加入才能点亮，这次不点' }
        }
        return { ok: false, message: '面板里没找到可点的「送灯牌 / 点亮」：' + prep.reason }
      }

      // ② 面板内容确认。两种面板都认（2026-11-08 主人要求把恢复勋章也纳入）：
      //    A 续灯牌：「送1个基础灯牌 … +100」，按钮「送灯牌」
      //    B 恢复勋章：「点亮粉丝团恢复勋章 / 今日已暂存50亲密度」，按钮「点亮 (1钻)」
      const ptext = await panelText()
      const hints = badgeHintsFromText(ptext)
      const isRestore = hints.hasRestoreMedal || hints.hasStash
      const isRenew = hints.hasIntimacy || hints.hasOneCoin || badgeTaskRowFromText(ptext)
      // 2026-11-10 加：没加入粉丝团的面板长这样 —— 底下是「加入粉丝团（1钻石）」。
      //   那是**开通**按钮，不是「续灯牌」，点错就白花 1 钻 → 直接停手并说清楚。
      if (/加入粉丝团/.test(ptext) && !isRenew) {
        return { ok: false, message: '这个直播间还没加入粉丝团（面板上是「加入粉丝团（1钻石）」），要先加入才能点亮，这次不点' }
      }
      if (!isRestore && !isRenew) {
        return {
          ok: false,
          message: '面板里既没有「送1个基础灯牌 / +100」，也没有「点亮粉丝团恢复勋章」，不像粉丝团面板，这次不点（入口：' + (entryText || '面板本来就开着') + '）',
        }
      }

      return {
        ok: true,
        prepared: prep,
        entry: entryText || (hasFanclub ? '粉丝团' : '今日任务'),
        panelJustOpened,
        progressBefore,
        plusBefore: plus100FromText(ptext).count,
        hints,
        // B 类面板：勋章熄了，点「点亮 (1钻)」恢复；A 类：正常续灯牌
        kind: isRestore ? 'restore' : 'renew',
        buttonText: (prep.prepared && prep.prepared.cand && prep.prepared.cand.text) || '',
      }
    }

    /**
     * 点之后的验证（2026-11-08 主人明确了判据）：
     *   **只有在面板里出现「+100」才算送出成功。**
     * 进度从 0/3 变成 1/3 只是旁证，不能单独算成功 —— 页面可能还没刷新完、
     * 也可能读到的是别的任务行的数字。所以：
     *   · 出现 +100 → 成功，how 里带上当时看到的进度
     *   · 12 秒内没出现 +100 → 失败（哪怕进度涨了，也只写进备注，不算成）
     * 计数方式是「点之前页面上有几个 +100」→「点之后有没有多出来」，
     * 避免把面板里本来就有的 +100 当成这次的。
     */
    async function badgeEvidence(beforeProgress, plusBefore, nick) {
      const from = beforeProgress
      const base = Number.isFinite(plusBefore) ? plusBefore : 0
      // 点之前聊天区已有的「送出了 XX」条数（别人的也算，靠差值区分）
      const preChat = await chatLines(80)
      const chatBefore = (preChat.lines || []).filter((l) => BADGE_CHAT_RE.test(l)).length
      const seenLines = new Set(preChat.lines || [])
      const deadline = Date.now() + EVIDENCE_WAIT_MS
      let lastProgress = null
      let lastCount = 0
      let lastChat = chatBefore
      let round = 0
      while (Date.now() < deadline) {
        // 聊天区每轮都读（轻量：只查 ~15 个 item 节点）
        const c = await chatLines(80)
        for (const l of c.lines || []) seenLines.add(l)
        const hits = Array.from(seenLines).filter((l) => BADGE_CHAT_RE.test(l))
        lastChat = hits.length
        if (hits.length > chatBefore) {
          // 1.1.1 加固：nick 现在恒为空（读不到自己的昵称），原来直接取**最后一条**播报，
          //   直播间里别人送的「送出了 粉丝团灯牌」会被当成自己送的（这个号叫「蔚」，别人发的也会命中）。
          //   现在：只有能对上昵称的播报才算；对不上时，必须进度也真的涨了（p0 > from 且 p0≥1）才认。
          //   都不满足就只当旁证，继续等 +100 / 进度，绝不拿别人的播报冒充自己。
          const ownLine = nick ? hits.find((l) => l.includes(nick)) : null
          const p0 = lastProgress
          const progUp = p0 !== null && (from === null ? false : p0 > from) && p0 >= 1
          if (ownLine || progUp) {
            const howLine = ownLine || hits[hits.length - 1]
            const prog0 = p0 === null ? '' : '，今日任务 ' + (from === null ? '?' : from) + '/3 → ' + p0 + '/3'
            return { ok: true, how: '聊天区播报了「' + String(howLine).slice(0, 40) + '」' + prog0, chat: hits.length, progress: p0 }
          }
        }
        // 整页文字比较重（要扫 50+ 个 root），每两轮读一次就够判断进度/余额
        if (round % 2 === 0) {
          // 2026-11-10 修：面板里的字（+100 / 今日任务 / 亲密度）是 Lynx 画在 canvas 上的，
          //   DOM 文字里读不到 → 必须把无障碍树的文字也算进来。
          //   窗口统一用 TEXT_WINDOW（prepareBadge 算 plusBefore 时用的是同一个窗口），
          //   否则「点之前」和「点之后」口径不一致，会把面板里本来就有的 +100 算成这次的。
          const t = await panelText()
          const p = taskProgressFromText(t)
          if (p !== null) lastProgress = p
          const plus = plus100FromText(t)
          lastCount = plus.count
          const prog = p === null ? '' : '，今日任务 ' + (from === null ? '?' : from) + '/3 → ' + p + '/3'
          if (plus.count > base) {
            return { ok: true, how: '面板里出现了 +100' + prog, plus: plus.count, progress: p }
          }
          // B4：进度上涨只能当旁证，不能单独判成功（否则 Lynx 读不到 +100 时会假报已送）
        }
        round++
        await sleep(700)
      }
      const tail = lastProgress === null ? '读不到今日任务进度' : '今日任务 ' + lastProgress + '/3'
      return {
        ok: false,
        how: Math.round(EVIDENCE_WAIT_MS / 1000) + ' 秒内没看到 +100 / 聊天播报 / 进度变化（' + tail + '，+100 ' + base + ' → ' + lastCount + '，聊天播报 ' + chatBefore + ' → ' + lastChat + '）',
        plus: lastCount,
        progress: lastProgress,
      }
    }

    /**
     * AX 通道的执行段（Lynx canvas 面板专用）。
     * 和 DOM 通道一个规矩：重新找一遍 → 签名必须一样 → 再验一次命中 → 才真点。
     */
    async function commitAx(prepared) {
      const cands = await ax.find(BADGE_AX_NAMES, { limit: 20 })
      const same = cands.find((c) => axSig(c) === prepared.axSig)
      if (!same) {
        return { ok: false, reason: '等你确认这会，目标不见了（' + ((prepared.cand && prepared.cand.text) || '那个按钮') + '），这次不点' }
      }
      const h = await ax.hit(same)
      if (!h.ok) return { ok: false, reason: describeHit(h), hit: h }
      const pt = choosePoint(h.points)
      if (!pt) return { ok: false, reason: '找不到可点位置' }
      await clicker.clickAt(pt.x, pt.y)
      note('确认后点了' + (prepared.label || '灯牌按钮') + ' @' + pt.x + ',' + pt.y, 'info')
      await sleep(1600)
      return { ok: true, point: pt, cand: prepared.cand, hit: h }
    }

    /** 执行：重新找 → 比对签名 → 再验命中 → 真点 → 查证据（只认 +100）。 */
    async function commitBadge(prepared, progressBefore, plusBefore) {
      await ensureViewport()
      // 点之前要记住「今日任务 X/3」和页面上已有的 +100 个数。
      // 2026-11-09：实参基本都会传（prepareBadge 已经算过），只有没传时才现读一次全页
      //   —— 全页扫描要遍历 50+ 个 root，能省就省。
      let beforeProgress = progressBefore
      let basePlus = plusBefore
      if (beforeProgress === undefined || basePlus === undefined) {
        const textBefore = await panelText()
        if (beforeProgress === undefined) beforeProgress = taskProgressFromText(textBefore)
        if (basePlus === undefined) basePlus = plus100FromText(textBefore).count
      }
      // B3：点击前先原子落盘“尝试”；写盘失败就中止，绝不带着“没记住”去点
      ctx.badgeAttemptDay = dayKey()
      ctx.badgeAttemptRoom = roomKeyOf((await currentUrl()) || '')
      if (!saveState({ badgeAttemptDay: ctx.badgeAttemptDay, badgeAttemptRoom: ctx.badgeAttemptRoom })) {
        return { ok: false, message: '状态写盘失败，为防重复扣钻本次不点' }
      }
      // 2026-11-10：面板是 Lynx canvas 时按钮只存在于无障碍树里，DOM 通道的 commit 找不到它，
      //   所以要按通道分开走。
      const r = prepared && prepared.channel === 'ax'
        ? await commitAx(prepared)
        : await clicker.commit(prepared, { settleMs: 1600 })
      if (!r.ok) {
        // 走到这里说明还没真正点（找不到目标/命中失败），清掉 attempt，别把当天锁死
        ctx.badgeAttemptDay = ''
        ctx.badgeAttemptRoom = ''
        saveState({ badgeAttemptDay: '', badgeAttemptRoom: '' })
        return { ok: false, message: r.reason }
      }
      await sleep(1500)
      const file = await shot('badge-result')
      // 2026-11-09 修 BUG：这里原来调 myNickname()，但那个函数在 0.9.1 清死代码时被删了 ——
      //   ReferenceError 炸在「真点已经按下去之后、ctx.badgeDay 写盘之前」，下一轮 tick 会再点一次，
      //   重复花钻。昵称本来就认不出哪条是自己发的（botQQ 对不上昵称），干脆不读：
      //   badgeEvidence 的判据不靠昵称 —— 「点之前没有、点之后多出来的那条播报」就是自己的。
      const nick = String(api.settings().badgeNickname || '').trim()
      const ev = await badgeEvidence(beforeProgress, basePlus, nick)
      const today = dayKey()
      ctx.badgeUrl = (await currentUrl()) || ctx.badgeUrl
      // M6/B4：只有确认到“已送”才记 ctx.badgeDay；未确认只记 attempt（不动 ctx.badgeDay）
      if (ev.ok) {
        ctx.badgeDay = today
        ctx.badgeAttemptDay = ''
        ctx.badgeAttemptRoom = ''
        const rk = roomKeyOf(ctx.badgeUrl)
        if (!ctx.badgeRooms || ctx.badgeRooms.day !== today) ctx.badgeRooms = { day: today, rooms: {} }
        ctx.badgeRooms.rooms[rk] = Date.now()
        saveState({ badgeDay: ctx.badgeDay, badgeUrl: ctx.badgeUrl, badgeEvidence: ev.how, badgeAttemptDay: '', badgeAttemptRoom: '', badgeRooms: ctx.badgeRooms })
      } else {
        const rk = roomKeyOf(ctx.badgeUrl)
        const proven = ctx.badgeRooms && ctx.badgeRooms.day === today && ctx.badgeRooms.rooms && ctx.badgeRooms.rooms[rk]
        const patch = { badgeUrl: ctx.badgeUrl, badgeEvidence: '未确认：' + ev.how, badgeAttemptDay: ctx.badgeAttemptDay, badgeAttemptRoom: ctx.badgeAttemptRoom }
        // 没确认到 +100，且这个房间没有“已确认送出”的记录 → 不能把 badgeDay 留成今天（否则面板误报已送）
        if (!proven && ctx.badgeDay === today) { ctx.badgeDay = ''; ctx.badgeUrl = ''; patch.badgeDay = ''; patch.badgeUrl = '' }
        saveState(patch)
      }
      // 2026-11-09：送灯牌这轮的面板用完了，顺手收掉（best-effort，不影响结论）。
      //   半自动等确认期间面板特意开着（页面别动，签名才对得上），收的动作放在点了之后。
      try { await closeTaskPanel() } catch {}
      // 2026-11-09 修「一条结果被发三遍」：
      //   原来 commitBadge 自己 tellOwner 一次、命令/工具返回值又被主流程发一次、tick 再发一次。
      //   现在 commitBadge **只返回结论，不发私聊**；要发的地方只有两个：
      //   ① confirmPending（半自动确认后，本来就在私聊里对话）② tick（自动模式下需要通知）
      if (ev.ok) {
        // 2026-11-09 修：连续失败计数原来只在跨天时清零 —— 同一天「失败×2、成功、再失败」
        //   也会凑满 3 次触发「今天放弃」。送成一轮就归零，失败必须是连续的才算 streak。
        if (ctx.badgeRejectStreak !== 0) {
          ctx.badgeRejectStreak = 0
          saveState({ badgeRejectStreak: 0 })
        }
        if (ctx.badgeReportDay !== today) {
          ctx.badgeReportDay = today
          saveState({ badgeReportDay: ctx.badgeReportDay })
        }
        return { ok: true, message: '灯牌送出去了（' + ev.how + '）', shot: file, progress: beforeProgress, evidence: ev.how }
      }
      return { ok: false, message: '点了，但没确认到送出（' + ev.how + '）', shot: file, evidence: ev.how }
    }

    /** 灯牌一轮：半自动就先问主人，自动就直接点。 */
    async function doBadge() {
      if (gate.peek && gate.peek()) return { ok: false, message: '还有一个动作在等你确认，先处理它' }
      const prep = await prepareBadge()
      if (!prep.ok) return prep
      if (api.settings().semiAuto) {
        return await askOwner({
          kind: 'badge',
          label: '续粉丝团灯牌',
          prepared: prep.prepared,
          // 把「点之前几/3」和面板里看到的两条特征一起带过去，确认之后照这个基准判成败
          progressBefore: prep.progressBefore,
          plusBefore: prep.plusBefore,
          data: { entry: prep.entry, hints: prep.hints, progressBefore: prep.progressBefore, plusBefore: prep.plusBefore, kind: prep.kind, buttonText: prep.buttonText },
          extra: (prep.kind === 'restore'
            ? '面板显示「点亮粉丝团恢复勋章 / 今日已暂存亲密度」，要按的是「' + (prep.buttonText || '点亮') + '」——勋章熄灭，点亮后恢复。'
            : '点了就是给「' + (prep.entry || '这个主播') + '」续一次灯牌（今日任务 ' +
              (prep.progressBefore === null ? '?' : prep.progressBefore) + '/3，面板里能看到 1钻 + 可得100亲密度）。') +
            '点完我会盯着面板等 +100，出现才算成功。',
        })
      }
      return await commitBadge(prep.prepared, prep.progressBefore, prep.plusBefore)
    }

    /**
     * 点一个「返回元素的表达式」（老的 finder 全部走这里）。
     * 现在补了三件事：先标出来 → 命中校验（9 点采样，被挡住就不点）→ 真坐标按下。
     * 返回 null = 没找到；{ blocked: true } = 找到了但不让点。
     */

  return { badgeSent, closeTaskPanel, findBadgeConfirm, openBadgePanel, fanPanelOpen, prepareBadge, badgeEvidence, commitAx, commitBadge, doBadge }
}
