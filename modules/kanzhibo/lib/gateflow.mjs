// lib/gateflow.mjs —— 半自动确认闸门与通知：askOwner/confirm/cancel/drop、tell/notify、badgeReject。
export function createGateFlow({ ctx, api, note, sleep, shot, clicker, gate, ownerChat, saveState, dayKey, journal, roomKeyOf, closeTaskPanel, commitBadge, commitGift, getBusy, setBusy }) {
  let gateLater = null
    async function tellOwner(text, imagePath) {
      const chat = ownerChat()
      if (!chat) return false
      if (text) { try { await api.sendText(chat, text) } catch (e) { note('私聊没发出去：' + (e && e.message), 'debug') } }
      if (imagePath) {
        try { await api.sendImage(chat, imagePath) } catch (e) { note('截图没发出去：' + (e && e.message), 'warn') }
      }
      return true
    }

    /**
     * 不 await 的通知（tick 里用，不能阻塞挂机流程）。
     *
     * 2026-11-11 修 BUG：原来直接写 `api.sendText(...).catch(() => {})`，
     * 可 api.sendText 被出站策略拦下时返回的是 **null**，对 null 取 .catch 就抛
     * 「Cannot read properties of null (reading 'catch')」—— 这个 TypeError 会被 tick 的
     * 外层 catch 抓住，记成「挂直播出错」，让人以为是浏览器挂了，其实是消息被拦。
     * 现在统一走这里：返回值可能是 Promise、也可能是 null，只管吞掉，绝不抛。
     */
    function notifyOwner(text) {
      const chat = ownerChat()
      if (!chat || !text) return
      try {
        const r = api.sendText(chat, String(text))
        if (r && typeof r.catch === 'function') r.catch(() => {})
      } catch (e) {
        note('私聊没发出去：' + (e && e.message), 'debug')
      }
    }

    /**
     * 半自动第一段：把「要点的位置」截图发给主人，开一个待确认。
     * 这里不点任何花钱的按钮；截图里红框就是它打算按下去的地方。
     */
    async function askOwner({ kind, label, prepared, extra, data }) {
      const live = gate.peek()
      if (live) return { ok: false, message: '还有一个在等你确认：' + live.label + '（先回 /看直播 确认 或 /看直播 取消）' }
      let full = ''
      try {
        // 2026-11-09：红框直接按候选的 rect 画 —— 以前 mark(0) 依赖「上一次 find 的 0 号标记」，
        //   灯牌按钮改成合并扫描后 0 号不一定是它，红框可能框到别的东西上。
        await clicker.markRect(prepared.cand ? prepared.cand.rect : null)
        full = await shot(kind + '-aim', prepared.cand.rect)
      } finally {
        await clicker.unmark()
      }
      const sec0 = Math.max(10, Math.min(600, Number(api.settings().confirmSec) || 90))
      gate.setTtl(sec0 * 1000)
      const opened = gate.open({ kind, label, prepared, data: data || {}, shot: full })
      if (!opened.ok) return { ok: false, message: opened.reason }
      armGate()
      journal('动作等确认', label, true)
      const sec = Math.round(gate.ttlMs / 1000)
      const lines = [
        '【等你点头】' + label,
        '要按的是：' + (prepared.cand ? prepared.cand.text : '') + '（' + prepared.desc + '）',
        '坐标：' + prepared.point.x + ',' + prepared.point.y + (ctx.viewport ? '　视口 ' + ctx.viewport.w + '×' + ctx.viewport.h : ''),
        extra || '',
        '红框那张图就是要点的位置。回 /看直播 确认 我就点；/看直播 取消 就撤；' + sec + ' 秒不回我自己撤。',
      ].filter(Boolean)
      await tellOwner(lines.join('\n'), full)
      note('等你确认：' + label + '（' + (prepared.cand ? prepared.cand.text : '') + '）', 'info')
      return { ok: false, pending: true, message: '要点的位置已经截图发你私聊了，等你回 /看直播 确认（' + sec + ' 秒）' }
    }

    /** 闸门过期扫描：到点了就撤，并告诉主人一声。 */
    const armGate = () => {
      if (gateLater) { try { gateLater() } catch {} }
      gateLater = api.later(gate.ttlMs + 5_000, async () => {
        gateLater = null
        const gone = gate.sweep()
        if (!gone) return
        note('待确认超时作废：' + gone.label, 'warn')
        await tellOwner('【已撤销】' + gone.label + '：等了 ' + Math.round(gate.ttlMs / 1000) + ' 秒没收到你的确认，这次不点了。')
        // 2026-11-09：等确认期间面板特意留着没关，超时作废了就顺手收掉。
        try { await closeTaskPanel() } catch {}
      })
    }

    /** 主人回「确认」：取走闸门 → 重新校验 → 真点 → 回报。只能用一次。 */
    async function confirmPending() {
      const live = gate.peek()
      if (!live) return '现在没有等你确认的动作（可能已经过期了）'
      // 2026-11-09 加：和 tick 互斥 —— 定时那轮还在跑（比如灯牌 delay 的 sleep 里）时回「确认」，
      //   commitBadge 会和 tick 并发操作同一个页面。这里不消费闸门，稍后再回一次就行。
      if (getBusy()) return '上一轮还没结束，过几秒再回一次「确认」（这次还给你留着）'
      setBusy(true)
      try {
        const action = gate.take()
        if (!action) return '这个确认已经过期了，这次不点。'
        if (action.kind === 'badge') {
          const pb = action.progressBefore === undefined ? (action.data && action.data.progressBefore) : action.progressBefore
          const pl = action.plusBefore === undefined ? (action.data && action.data.plusBefore) : action.plusBefore
          const r = await commitBadge(action.prepared, pb, pl)
          // 文字结论由命令/工具的返回值带走（会回到对应聊天），这里只补一张结果截图，不重复打字。
          if (r.shot) { try { await tellOwner('', r.shot) } catch {} }
          journal('确认续灯牌', r.message, r.ok)
          return (r.ok ? '✅ 灯牌：' : '⚠️ 灯牌：') + r.message
        }
        if (action.kind === 'gift') {
          const r = await commitGift(action.prepared, action.data.name, action.data.balance, action.data.directSend)
          journal('确认送礼', r.message, r.ok)
          return (r.ok ? '✅ 礼物：' : '⚠️ 礼物：') + r.message
        }
        return '这个确认没认出来，先不点。'
      } catch (e) {
        return '执行出错：' + ((e && e.message) || e)
      } finally {
        setBusy(false)
      }
    }

    /** 主人回「取消」：把待确认撤掉；面板顺手按 Esc 收起来。 */
    async function cancelPending() {
      const live = gate.peek()
      if (!live) return '现在没有等你确认的事'
      gate.take()
      try {
        await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      } catch {}
      note('主人取消了：' + live.label, 'info')
      journal('取消待确认', live.label, true)
      return '撤了，这次不点。'
    }

    /** 收工 / 关掉时把待确认一起撤掉：截图已经过期，别让它在 90 秒后还能点一下。 */
    async function dropPending(reason) {
      const live = gate.peek()
      if (!live) return false
      gate.take()
      note('撤销待确认（' + reason + '）：' + live.label, 'info')
      return true
    }

    /** 灯牌连续失败 3 次：当天、这个直播间降级成提醒（一天只提一次）。 */
    async function badgeReject(why, room = '') {
      const today = dayKey()
      if (ctx.badgeRejectDay !== today) { ctx.badgeRejectDay = today; ctx.badgeRejectStreak = 0 }
      ctx.badgeRejectStreak++
      saveState({ badgeRejectDay: today, badgeRejectStreak: ctx.badgeRejectStreak})
      note('灯牌这轮没成：' + why, 'warn')
      journal('灯牌没成', why, false)
      if (ctx.badgeRejectStreak >= 3 && ctx.badgeGiveUpDay !== today) {
        ctx.badgeGiveUpDay = today
        // 1.0.2：记下是在哪个房间放弃的 —— 换房间后标记自动作废，不用手动重开。
        ctx.badgeGiveUpRoom = String(room || ctx.badgeGiveUpRoom || roomKeyOf(ctx.badgeUrl))
        saveState({ badgeGiveUpDay: today, badgeGiveUpRoom: ctx.badgeGiveUpRoom})
        await tellOwner('灯牌连着 3 次没点上（' + why + '）。今天先不自动试了，你顺手点一下？想让我再试就发 /看直播 灯牌')
      }
    }

    /**
     * 把直播间浏览器挪进屏幕 / 挪回屏幕外（参照「刷抖音」的显示窗口 / 收起窗口）。
     * 扫码登录、过短信验证、处理验证码都要看到窗口，所以得能把它拽到面前。
     */
  return { tellOwner, notifyOwner, askOwner, armGate, confirmPending, cancelPending, dropPending, badgeReject, disposeGate: () => { if (gateLater) { try { gateLater() } catch {} gateLater = null } } }
}
