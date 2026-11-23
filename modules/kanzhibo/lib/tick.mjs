// lib/tick.mjs —— 挂直播主流程：tick / enterNow / stopNow / dailyReport。
export function createTick(deps) {
  const {
    ctx, api, note, sleep, saveState, loadState, dayKey, roomKeyOf, LIVE_RE, currentUrl,
    ensureBrowser, closeBrowser, livePort, ensureInRoom, waitRoomReady, endedSignals, enterFromProfile,
    sendComment, gate, badgeSent, doBadge, badgeReject, closeTaskPanel, notifyOwner, dropPending,
    journal, cleanShots, getBusy, setBusy, inWindow, clampCheckSec, giveUpRoomsDiffer, getCommentedDay, setCommentedDay,
  } = deps
    async function tick(force = false) {
      if (!api.settings().enabled) return { ok: false, message: '总开关关着' }
      if (!force && ctx.quietUntil && Date.now() < ctx.quietUntil) {
        return { ok: false, message: '刚收工，先歇到 ' + new Date(ctx.quietUntil).toLocaleTimeString() + '；想立刻回来发 /看直播 进' }
      }
      if (getBusy()) return { ok: false, message: '上一轮还没结束' }
      // 2026-11-09：「按时间段挂」开着时才管时段；关着就任何时候都进。
      if (!inWindow()) {
        if (api.settings().schedule) {
          if (ctx.cdp) {
            await closeBrowser()
            note('不在时段内，把直播间浏览器关了（要一直挂就把「按时间段挂」关掉）')
          }
          return { ok: false, message: '不在设定时段（' + (api.settings().startTime || '?') + '-' + (api.settings().endTime || '?') + '），已关浏览器' }
        }
        note('不在设定的时段（' + (api.settings().startTime || '?') + '-' + (api.settings().endTime || '?') + '），但「按时间段挂」关着，照常进房', 'debug')
      }
      setBusy(true)
      try {
        const r = await ensureInRoom()
        const url = await currentUrl()
        const inLive = LIVE_RE.test(url)

        // —— F1 开播提醒：目标是主播主页、还没进房时，每轮都看一眼 ——
        // 突然在播了 → 进房 + 私聊说一声（每个主页 × 开播日只报一次）。
        // 1.0.0 修：原来判据是 r.message === '现在没在播'，但 ensureInRoom 从主播主页
        //   找到「直播中」点进去成功时返回的 message 是 '主播在播，已经进去了'，inLive 也是真 ——
        //   这条路径本来就没问题；真正的坑是主页目标「没在播」时 ensureInRoom 只在前 6 次尝试里找，
        //   而 r.message 是那次尝试的快照。现在不靠 message 文案，直接看当前 URL 是不是直播间，
        //   顺带把 wasNotified 的 key 判断放在真正开播之后（没开播就不写状态，避免每天白写一次）。
        if (!inLive) {
          const now2 = await currentUrl()
          if (LIVE_RE.test(now2)) {
            const key = String(api.settings().target || '') + '|' + dayKey()
            const wasNotified = liveNotifyKey === key
            bumpRoom()
            if (!wasNotified) {
              markLiveNotify(key)
              const owner = api.config().ownerQQ
              if (owner) notifyOwner('📣 主播开播了，我已经进去挂着了：' + now2)
              note('开播提醒：' + now2)
            }
            return { ok: true, url: now2, joined: true, notified: true }
          }
          return { ...r, ok: r.ok, url }
        }
        if (r.joined) { bumpRoom(); journal('进房', url, true) }

        // 地址还在 /live/ 里不代表主播还在播：下播后 URL 不变，页面会写「直播已结束」。
        if (!force) {
          const why = await endedSignals()
          if (why) {
            await dropPending('主播下播')
            if (ctx.cdp) {
              await closeBrowser()
              note('主播下播了（' + why + '），把直播间浏览器关了', 'info')
            }
            journal('主播下播', why, false)
            return { ok: false, message: '主播下播了：' + why + '（浏览器已关，等下一轮再看）', url, ended: true }
          }
        }

        // 进房后发评论：等页面真的渲染完，同一个房间只发一次
        const text = String(api.settings().liveComment || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
        const today = dayKey()
        if (api.settings().liveCommentOn && text && getCommentedDay() !== today) {
          const ready = await waitRoomReady(30000)
          if (ready) {
            const wait = Math.max(0, Math.min(120, Number(api.settings().commentDelaySec) || 0)) * 1000
            if (wait) await sleep(wait)
            const sent = await sendComment(text)
            if (sent.ok) {
              setCommentedDay(today)
              saveState({ commentedDay: today })
              note('进房评论：' + text + '（今天不再发了）')
              journal('进房评论', text, true)
            } else {
              note('评论没发成：' + sent.message, 'warn')
              journal('进房评论', sent.message, false)
            }
          } else {
            note('页面 30 秒还没加载出评论框，这次没发评论', 'warn')
          }
        }

        /**
         * 送灯牌（2026-11-03 改）：**先判定，没送才送，送完再判定**。
         *   判定看「今日任务」面板里那一行「粉丝团灯牌 … 已完成」——已完成就说明今天已经送出过。
         *   判定成功就走人（并且给主人回一句「今天的灯牌已经送出了」，每天只说一次）。
         */
        if (api.settings().renewBadge) {
          const today = dayKey()
          // 2026-11-04：今天这个直播间已经确认送出过就别再判一遍了。
          // （之前每 2 分钟都打一条「今天已经送出了」，日志被刷满。）
          // 2026-11-06：连着挂 3 次 → 当天降级成提醒；有动作在等确认就别抢。
          // 1.0.2 修：放弃标记原来只按天记 —— 晚上换个直播间/换个主播，标记还在，整晚静默跳过，
          //   看起来就是「送灯牌没启动」（2026-11-09 实测：凌晨在旧房间挂了 5 次，21 点换房后一直没动）。
          //   现在标记绑房间：进到别的房间就作废，连续失败计数一起清零，让新房间重新试一次。
          const curRoom = roomKeyOf(url)
          const giveUpRoom = String(ctx.badgeGiveUpRoom || roomKeyOf(ctx.badgeUrl))
          if (giveUpRoomsDiffer(ctx.badgeGiveUpDay, giveUpRoom, today, curRoom)) {
            ctx.badgeGiveUpDay = ''
            ctx.badgeGiveUpRoom = ''
            ctx.badgeRejectStreak = 0
            saveState({ badgeGiveUpDay: '', badgeGiveUpRoom: '', badgeRejectStreak: 0 })
            note('灯牌：换到别的直播间了（' + curRoom + '，上次放弃是在 ' + giveUpRoom + '），清掉今天的放弃标记，重新试一次', 'info')
          }
          let badgeSkipped = false
          const sentRoomsToday = (ctx.badgeRooms && ctx.badgeRooms.day === today) ? (ctx.badgeRooms.rooms || {}) : {}
          if (sentRoomsToday[curRoom] || (ctx.badgeDay === today && (roomKeyOf(ctx.badgeUrl) === roomKeyOf(url) || !ctx.badgeUrl))) {
            // 已经办完，静默跳过（2026-11-22：改成按房间号比，别因为 live.douyin.com / www.douyin.com/follow/live
            //   两种地址写成不同字符串就当成「没送过」，每轮都重新弹「等你点头」刷屏。）
          } else if (ctx.badgeGiveUpDay === today) {
            // 今天已经放弃自动，不再点（放弃时已经提醒过一次）
          } else if (ctx.badgeAttemptDay === today && roomKeyOf(ctx.badgeAttemptRoom) === curRoom && ctx.badgeDay !== today) {
            // M6/B4：这间房今天点过但没确认，不自动再点（防重复扣钻）；要重试发 /看直播 灯牌
            badgeSkipped = true
            note('灯牌：这间房今天点过但没确认，先不自动再点（要重试发 /看直播 灯牌）', 'debug')
          } else if (gate.peek()) {
            note('灯牌：还有个动作在等你确认，这轮先不送', 'debug')
          } else if (api.settings().semiAuto && ctx.badgeAskDay === today && roomKeyOf(ctx.badgeAskRoom) === curRoom && ctx.badgeDay !== today) {
            // 2026-11-22：这间房今天自动问过「等你点头」、没人回（超时撤销），别每轮再问——会刷屏；要送让主人发 /看直播 灯牌。
            badgeSkipped = true
            note('灯牌：这间房今天自动问过确认了（没人回），先不自动再问；要送就发 /看直播 灯牌', 'debug')
          } else {
            let sent = await badgeSent()
            // 2026-11-09 修 BUG：r2 原来用 const 声明在下面 else 块里，而外层这两段（if (sent) / else if (!r2…)）
            //   还要用它 —— 块级作用域出不去，半自动等确认的每一轮都会在这里炸 ReferenceError，
            //   把 tick 带进 catch（顺手 ctx.cdp.close() 断开连接，主人回「确认」时目标已经找不到了）。
            let r2 = null
            if (sent) {
              note('灯牌：今天已经送出了（判定命中）')
            } else {
              const waitMs = Math.max(5, Math.min(600, Number(api.settings().badgeDelaySec) || 30)) * 1000
              await sleep(waitMs)
              r2 = await doBadge()
              if (r2.pending) { note('灯牌：' + r2.message, 'info'); journal('灯牌等确认', r2.message, true); ctx.badgeAskDay = today; ctx.badgeAskRoom = curRoom; saveState({ badgeAskDay: today, badgeAskRoom: curRoom }) }
              else if (r2.ok) { note('灯牌：' + r2.message, 'info'); journal('续灯牌', r2.message, true) }
              else if (/已送态|已经送过|今天动过了/.test(String(r2.message || ''))) {
                note('灯牌：判定今天已送，不计失败', 'debug')
                if (ctx.badgeDay !== today) { ctx.badgeDay = today; ctx.badgeUrl = url; saveState({ badgeDay: today, badgeUrl: url }) }
              } else await badgeReject(r2.message || '没点成', curRoom)
              await sleep(1500)
              // 2026-11-08 修：原来这里又用 badgeSent() 覆盖结论，而它只认「今日任务」那一行；
              //   commitBadge 认的是「今日任务 / 飘屏 / 余额」三者之一，于是会出现
              //   「commitBadge 说送出去了，tick 转头打一条『送完还是没判到』」的自相矛盾日志
              //   （2026-11-07 21:18 实测）。commitBadge 已经写好 ctx.badgeDay，这里直接采信它的结论。
              // 2026-11-10 再修一刀：失败分支原来还会再跑一遍 badgeSent() ——
              //   它真的会去点「今日任务」开合面板（等主人确认之前不该再动页面），
              //   而且只认「今日任务」那一行，会把 commitBadge 的结论覆盖掉。
              //   现在：完全采信 doBadge/commitBadge 的结论，不重复动页面。
              sent = r2.pending ? false : Boolean(r2.ok)
            }
            if (sent) {
              // 1.1.1：这里原来是**静默**跳过 —— worklog 只留下前两次「灯牌没成」，后面判定「已送过」
              //   却没有一条记录，事后看日志像是「明明失败了却当成成功」。现在补一条真实来源的留痕。
              const whySent = r2 && r2.ok ? (r2.evidence || r2.message) : '今日任务显示已送过（判定命中，不一定是本机刚送的）'
              journal('灯牌已送过', whySent, true)
              if (ctx.badgeDay !== today || ctx.badgeUrl !== url) {
                ctx.badgeDay = today
                ctx.badgeUrl = url
                saveState({ badgeDay: today, badgeUrl: url })
              }
              if (ctx.badgeReportDay !== today) {
                ctx.badgeReportDay = today
                saveState({ badgeReportDay: today })
                // 只有自动模式才在这里通知；半自动是主人在私聊里点的，confirmPending 的回复就够了。
                const owner = api.config().ownerQQ
                if (owner && !api.settings().semiAuto) {
                  notifyOwner('今天的灯牌已经送出了（' + ((r2 && r2.evidence) || '已确认') + '）')
                }
              }
            } else if (!badgeSkipped && (!r2 || !r2.pending)) {
              note('灯牌：这轮没成 —— ' + ((r2 && r2.message) || '没读到证据'), 'warn')
              // 自动模式下失败也要告诉主人一次（半自动时他本来就在私聊里等结果）
              if (!api.settings().semiAuto) {
                const owner = api.config().ownerQQ
                if (owner) notifyOwner('⚠️ 灯牌这轮没成：' + ((r2 && r2.message) || '没读到证据'))
              }
            }
          }
          // 2026-11-09：灯牌流程走完且没有动作在等确认，把任务面板收掉（best-effort）；
          //   面板本来关着时只读页面文字、不点任何东西。等确认期间特意不收。
          if (!gate.peek()) { try { await closeTaskPanel() } catch {} }
        }

        if (r.joined) {
          cleanShots() // 顺手把过期截图清了（进房一天顶多几次，开销可忽略）
          if (api.settings().minuteReport) {
            const owner = api.config().ownerQQ
            if (owner) notifyOwner('我去看直播了：' + url)
          }
        }
        // F3 日报：每天第一次成功进房后发一条（当天已发过就静默跳过）
        if (r.joined || LIVE_RE.test(url)) await dailyReport('日报').catch(() => {})
        return { ...r, url }
      } catch (error) {
        // 2026-11-10 修 BUG：原来这里无条件 ctx.cdp.close() + ctx.cdp = null —— 任何一点小异常
        //   （一次 eval 超时、一个空指针）都把 CDP 连接掐断。后果很严重：
        //   · 半自动模式下「等你确认」的闸门里存着已经准备好的动作，连接一断，
        //     主人回「确认」时目标已经找不到了（这也是 0.9.7 那个 r2 作用域 bug 的帮凶）；
        //   · 下一轮 tick 要重新连浏览器，又慢又可能连错标签页。
        //   现在：只有「连接本身坏了」才断开；普通异常记日志就行，连接留着。
        const msg = (error && error.message) ? error.message : String(error)
        note('挂直播出错：' + msg, 'warn')
        journal('挂直播出错', msg, false)
        if (ctx.cdp && /websocket|not connected|socket|ECONN|连接断开|已关闭/i.test(msg)) {
          try { ctx.cdp.close() } catch {}
          ctx.cdp = null
          ctx.port = 0
          ctx.viewport = null
        }
        return { ok: false, message: msg }
      } finally {
        setBusy(false)
      }
    }

    /** 立刻进房一次（给她用工具时走这条，不要求面板里的「挂直播」开着）。 */
    async function enterNow(targetText) {
      const target = String(targetText || api.settings().target || '').trim()
      if (!target) return { ok: false, message: '没说看谁的直播，面板里也没设默认主播' }
      if (getBusy()) return { ok: false, message: '正在弄，等一下下' }
      setBusy(true)
      try {
        const r = await ensureInRoom(target)
        const url = await currentUrl()
        if (LIVE_RE.test(url)) {
          note('进了直播间：' + url)
          journal('进直播间', url, true)
          return { ok: true, url, message: '进直播间了：' + url }
        }
        journal('打开直播间页面', r.message || (url || target), false)
        return { ok: true, url, message: r.message || '打开了页面：' + (url || target) }
      } catch (error) {
        note('手动进直播间失败：' + error.message, 'warn')
        return { ok: false, message: error.message }
      } finally {
        setBusy(false)
      }
    }

    /** 停下来：真的关掉浏览器、撤掉待确认、再把总开关关掉。 */
    async function stopNow() {
      await dropPending('收工')
      await closeBrowser()
      ctx.quietUntil = Date.now() + 30 * 60_000
      saveState({ quietUntil: ctx.quietUntil})
      api.saveSettings({ enabled: false })
      await dailyReport('收工')
      journal('收工', '关浏览器，半小时内不再自己进')
      return { ok: true, message: '直播看完了，浏览器关了（半小时内不会自己再进）' }
    }

    // —— 2026-11-10 加（F1）：主播开播主动提醒 ——
    // 目标是主播主页时，没在播 tick 会空转等；突然开播的瞬间主动私聊说一声。
    // 每个「主页目标 × 开播日」只报一次；总开关没开时不打扰。
    // —— 2026-11-10 加（F3）：挂机日报 ——
    // 收工时 + 每天第一次进房成功时，给主人私聊一条小结：今天看了几个房、发过几条弹幕、灯牌/评论成没成。
    // （1.0.0 修：这组声明原来写在 stopNow 之后 —— stopNow 里调 dailyReport 是函数声明提升
    //   没问题，但 liveNotifyKey / reportDay 是 let，tick 里先于声明执行会撞 TDZ。
    //   现在全部提到 stopNow 之前，加载顺序一目了然。）
    let liveNotifyKey = String(loadState().liveNotifyKey || '')
    const markLiveNotify = (key) => { liveNotifyKey = key; saveState({ liveNotifyKey: key }) }
    let reportDay = String(loadState().reportDay || '')
    let roomsToday = Number(loadState().roomsToday || 0)
    const bumpRoom = () => { roomsToday++; saveState({ roomsToday }) }
    const dailyReport = async (why) => {
      const today = dayKey()
      if (reportDay === today && why !== '收工') return
      const s = api.settings()
      const owner = api.config().ownerQQ
      if (!owner) return
      const parts = []
      parts.push('【看直播' + (why || '日报') + ' ' + today + '】')
      parts.push('进房 ' + roomsToday + ' 次')
      parts.push('弹幕 ' + ((ctx.sayLog.day === today ? ctx.sayLog.items.length : 0)) + ' 条')
      if (ctx.sayLog.day === today && ctx.sayLog.items.length) {
        parts.push('最近一条：「' + (ctx.sayLog.items[ctx.sayLog.items.length - 1].text || '') + '」')
      }
      parts.push('灯牌：' + (s.renewBadge ? (ctx.badgeDay === today ? '已送' : '还没送' + (ctx.badgeGiveUpDay === today ? '（今天已放弃自动）' : '')) : '关'))
      parts.push('评论：' + (s.liveCommentOn ? (getCommentedDay() === today ? '已发' : '还没发') : '关'))
      reportDay = today
      saveState({ reportDay })
      try { await api.sendText('private:' + owner, parts.join('\n')) } catch {}
    }
    // 重载后恢复当天计数：reportDay 不是今天 = 昨天的数据，清零重计
    {
      const st = loadState()
      if (String(st.reportDay || '') !== dayKey()) { reportDay = ''; roomsToday = 0 }
    }

    /** 状态一句话，工具和命令共用。showDetail=false 时只说「开没开、在不在时段」，不暴露目标主播和当前地址。 */

  return { tick, enterNow, stopNow, dailyReport }
}
