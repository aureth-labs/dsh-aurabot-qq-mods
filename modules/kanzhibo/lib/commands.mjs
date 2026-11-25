// lib/commands.mjs —— /看直播 命令。
export function registerCommands(deps) {
  const { api, statusLine, selfCheck, confirmPending, cancelPending, gate, doBadge, enterNow, sendComment, stripQuotes, fromOwnerDm, SAY_MAX_CHARS, sayWaitSec, markSaySent, pushSayLog, recentOps, fmtStep, withBusy, stopAll, closeBrowser, ctx, saveState, dropPending, tick, getBusy, setBusy, dayKey, roomKeyOf, journal, currentUrl, isLiveTarget, badgeSent } = deps
    api.command({
      name: '看直播',
      aliases: ['kanzhibo'],
      desc: '挂直播间：/看直播 开、关、状态、进、收工、灯牌、换 <房间号|链接>、说 <内容>（私聊发弹幕）、记录、确认、取消、自检',
      run: async (arg, msg) => {
        const cmd = String(arg || '').trim()
        const OWNER_ONLY_CMDS = new Set(['开', '关', '进', '收工', '灯牌', '换'])
        if (OWNER_ONLY_CMDS.has(cmd.split(/\s+/)[0]) && msg && !fromOwnerDm(msg)) return '这条只认主人在私聊里发'
        if (!cmd || cmd === '状态') {
          return await statusLine()
        }
        if (cmd === '自检' || cmd === 'check') {
          return await selfCheck()
        }
        if (cmd === '确认' || cmd === 'ok' || cmd === '好') return await confirmPending()
        if (cmd === '取消' || cmd === '算了' || cmd === '不用了') return await cancelPending()
        if (cmd === '待确认' || cmd === 'pending') {
          const w = gate.peek()
          return w ? '等你确认：' + w.label + '（' + Math.round((w.deadline - Date.now()) / 1000) + ' 秒后作废）' : '现在没有等你确认的事'
        }
        if (/^灯牌/.test(cmd)) {
          if (!ctx.cdp) return '直播间浏览器没开，先发 /看直播 进'
          if (getBusy()) return '上一轮还在跑，等几秒再试'
          const force = /强制/.test(cmd)
          if (force) { const s0 = await badgeSent(); if (s0) return '判定今天已经送出，不允许强制重点' }
          {
            const tt = dayKey(), rr = roomKeyOf((await currentUrl()) || '')
            if (ctx.badgeAttemptDay === tt && ctx.badgeAttemptRoom === rr && ctx.badgeDay !== tt && !force) {
              return '这间房今天点过但没确认，可能已送出；先核对聊天/面板，确认没送再发 /看直播 灯牌 强制'
            }
          }
          setBusy(true)
          try {
            ctx.badgeGiveUpDay = ''
            ctx.badgeGiveUpRoom = ''
            ctx.badgeRejectStreak = 0
            if (force) { ctx.badgeAttemptDay = ''; ctx.badgeAttemptRoom = '' }
            saveState({ badgeGiveUpDay: '', badgeGiveUpRoom: '', badgeRejectStreak: 0, ...(force ? { badgeAttemptDay: '', badgeAttemptRoom: '' } : {}) })
            const r = await doBadge()
            return r.pending ? r.message : (r.ok ? r.message : '没点成：' + r.message)
          } finally { setBusy(false) }
        }
        // —— 2026-11-10 加（F2）：/看直播 换 <房间号或直播间链接> —— 快捷换目标主播
        {
          const m = /^换\s*([\s\S]+)$/.exec(cmd)
          if (m) {
            const want = stripQuotes(m[1]).trim()
            if (!want) return '用法：/看直播 换 <直播间链接或房间号>'
            if (!isLiveTarget(want)) return '这个我看不懂：要直播间链接（live.douyin.com/…）或纯房间号'
            api.saveSettings({ target: want })
            saveState({ lastTarget: '' })
            const r = await enterNow(want)
            return r.ok ? ('换了，现在在 ' + (r.url || want)) : ('设置存好了，但没进去：' + r.message)
          }
        }
        // —— 私信发弹幕（0.9.9）：/看直播 说 <内容>（评论 / 弹幕 / 发 是同义词） ——
        //   空格可以省（/看直播 说主播加油），成对引号会剥掉一层。
        {
          const m = /^(说|评论|弹幕|发)([\s\S]*)$/.exec(cmd)
          if (m) {
            if (!fromOwnerDm(msg)) {
              return '在直播间发弹幕只认主人本人的 QQ 私聊（这条是从' +
                (String((msg && msg.chatId) || '').startsWith('group:') ? '群' : '别的聊天') +
                '里来的），群里不发；到我私聊里发 /看直播 说 要说的话'
            }
            const content = stripQuotes(m[2])
            if (!content) return '用法：/看直播 说 要发的话 —— 我就在正在看的直播间把这句原样发出去（只认你的私聊；最多 ' + SAY_MAX_CHARS + ' 个字）'
            const chars = Array.from(content)
            if (chars.length > SAY_MAX_CHARS) return '太长了：弹幕最多 ' + SAY_MAX_CHARS + ' 个字（这句 ' + chars.length + ' 个），缩短一点再发'
            const wait = sayWaitSec()
            if (wait) return '刚发过一条弹幕，' + wait + ' 秒后再发（连发容易触发抖音风控）'
            const r = await withBusy(() => sendComment(content))
            if (r.ok) { markSaySent(); pushSayLog(content) }
            journal('发弹幕', r.ok ? content : r.message, r.ok)
            return r.ok ? r.message : '没发出去：' + r.message
          }
        }
        if (cmd === '开') {
          ctx.quietUntil = 0
          saveState({ quietUntil: 0 })
          api.saveSettings({ enabled: true })
          const r = await tick(true)
          return r.ok ? '开了，在 ' + r.url : '开了，但没进去：' + r.message
        }
        if (cmd === '关') {
          // 总开关关闭：停定时器、撤待确认、关浏览器
          api.saveSettings({ enabled: false })
          await stopAll('命令 /看直播 关')
          ctx.quietUntil = Date.now() + 30 * 60_000
          saveState({ quietUntil: ctx.quietUntil})
          return '总开关关了：不再进房，浏览器关了（要用再说 /看直播 开）'
        }
        if (cmd === '进') {
          ctx.quietUntil = 0
          saveState({ quietUntil: 0 })
          const r = await tick(true)
          return r.ok ? '进了：' + r.url : '没进去：' + r.message
        }
        if (cmd === '收工') {
          if (getBusy()) return '正在弄，等这一轮结束再收工'
          setBusy(true)
          try {
            await dropPending('收工')
            await closeBrowser()
            ctx.quietUntil = Date.now() + 30 * 60_000
            saveState({ quietUntil: ctx.quietUntil})
            return '浏览器关了；半小时内不会自己再进（要立刻回来说 /看直播 进）'
          } finally { setBusy(false) }
        }
        if (cmd === '记录' || cmd === '日志') {
          const rows = recentOps(20)
          return (rows.length ? rows.map(fmtStep).join('\n') : '还没有操作记录') +
            '\n（记录只存本地 jsonl；面板「操作记录」可看最近几步）'
        }
        return '能用的有：开 / 关 / 状态 / 进 / 收工 / 灯牌 / 说 <内容>（私聊发弹幕） / 记录 / 确认 / 取消 / 自检'
      },
    })

    // —— 面板用的三个接口：登录、窗口、体检 ——
}
