// lib/tools.mjs —— 她自己的工具（kanzhibo_*）与规则注册。
export function registerTools(deps) {
  const { api, allOwnerTurn, enterNow, stopNow, withBusy, sendGift, doBadge, sendComment, sayWaitSec, markSaySent, pushSayLog, journal, statusLine, ctx, dayKey, roomKeyOf, currentUrl, loadState, saveState, gate, SAY_MAX_CHARS } = deps
    api.tool(({ chat, sessionId }) => {
      if (!chat || chat.kind === 'system') return []
      // 2026-11-05 修：进房 / 停止不是「只是看一眼」，它们会真的开浏览器。
      //   原来这些工具在群聊里也挂着、不看主人身份，群里任何人喊一句「去看直播」她都会真开。
      //   现在只在「这一轮有主人说话」时给操作类工具；别人只能问状态，而且状态里不露在看谁。
      const owner = allOwnerTurn(sessionId)
      // 总开关关着：连状态查询都不给（这个模块整个停摆），只留一句「关着」
      if (!api.settings().enabled) {
        return [api.defineTool({
          name: 'kanzhibo_status',
          description: '看直播模块现在关着。主人问「你在看什么直播」时用。',
          properties: {},
          execute: async () => ({ ok: true, message: '看直播模块关着（面板「抖音看直播」里的总开关关着），什么都没在做' }),
        })]
      }
      // 2026-11-06：送礼是花抖币的真动作，单独一道开关，而且只认「主人的 QQ 私聊」。
      //   开关关着、或者在群里，连工具都不挂给她（省得她嘴上答应、手上没本事）；
      //   工具清单是会话级缓存的，所以 execute 里再按当前设置判一次 —— 面板改完不用重载模块。
      const giftOn = () => Boolean(api.settings().giftByDm) && chat.kind === 'private' && allOwnerTurn(sessionId)
      const statusTool = api.defineTool({
        name: 'kanzhibo_status',
        description: '看现在挂没挂直播。主人问「你在看什么直播」时用。',
        properties: {},
        execute: async () => ({ ok: true, message: await statusLine(owner) }),
      })
      if (!owner) return [statusTool]

      const enterTool = api.defineTool({
        name: 'kanzhibo_enter',
        description:
          '进一个人的抖音直播间挂着看。主人说「去看直播」「去XX的直播间」「帮我挂着」「看着她播」这类话时用。' +
          '不填 target 就用面板里设好的那个主播。',
        properties: {
          target: { type: 'string', description: '直播间地址或主播主页链接；不填就用默认那个' },
        },
        execute: async ({ target }) => { if (chat.kind !== 'private' || !allOwnerTurn(sessionId)) return { ok: false, message: '进房只认主人在私聊里说' }; return enterNow(target) },
      })
      const stopTool = api.defineTool({
        name: 'kanzhibo_stop',
        description: '不看了：退出直播间、关掉浏览器窗口。主人说「别看了」「关掉」「回来吧」时用。',
        properties: {},
        execute: async () => { if (chat.kind !== 'private' || !allOwnerTurn(sessionId)) return { ok: false, message: '停直播只认主人在私聊里说' }; return withBusy(() => stopNow()) },
      })
      const giftTool = api.defineTool({
        name: 'kanzhibo_gift',
        description:
          '在正在看的直播间送一个礼物给主播（灯牌不算礼物，别走这个）。花的是主人的抖币，送出去没有撤回。' +
          '只有主人在这条私聊里明说要送、还说了送什么的时候才用；主人没提就绝对不要送。一次一个。' +
          '如果页面出现充值/抖币不足的提示，立刻停止并如实告诉主人。' +
          '开了「动作前先问我」时，她会把要点的位置截图发给主人等他回确认；这时候你只要说一句「等主人确认」就行，别自己改口说已经送好了。',
        properties: {
          gift: { type: 'string', description: '礼物名字，比如 小心心、玫瑰、粉丝团' },
        },
        required: ['gift'],
        execute: async ({ gift }) => {
          if (chat.kind !== 'private') return { ok: false, message: '送礼只认主人的私聊，群里我不送' }
          if (!api.settings().giftByDm) return { ok: false, message: '「QQ 私信送礼」的开关关着（面板 → 平台 → 抖音看直播），先让主人打开我才能送' }
          if (!allOwnerTurn(sessionId)) return { ok: false, message: '只有主人能让我送礼' }
          return withBusy(() => sendGift(gift))
        },
      })
      // 2026-11-22 新增：续灯牌专用工具。原来只有 auto tick 会点灯牌、没给她工具，
      //   主人说「送个灯牌」时她只能干看着，结果自己偷用 ego 浏览器（另一台浏览器、另一个账号）
      //   去点抖音页面，绕过了模块日志/确认/命中校验（这就是 11-22 那次的真凶）。
      //   给她一条正规、会记账的路，她就不必也不该去偷点页面了。
      const badgeTool = api.defineTool({
        name: 'kanzhibo_badge',
        description:
          '在当前挂着的直播间续一次粉丝团灯牌（1 钻，送出去不能撤回）。主人在这条私聊里说「送个灯牌」「续灯牌」「点亮一下」时才用。' +
          '灯牌只能走这个工具：不要用 kanzhibo_gift（送礼工具不送灯牌），更不要用任何浏览器/电脑操作工具（ego_*、browser_*、pwsh、远程桌面之类）去直接点抖音页面——那样会绕过日志、绕过确认、还可能点错花钻。' +
          '开了「动作前先问我」时它会先截图发主人等确认，这时你只要说「等主人确认」就行，别自己改口说送好了。',
        properties: {},
        required: [],
        execute: async () => {
          if (chat.kind !== 'private') return { ok: false, message: '续灯牌只认主人的私聊，群里我不动' }
          if (!allOwnerTurn(sessionId)) return { ok: false, message: '只有主人能让我续灯牌' }
          if (!ctx.cdp) return { ok: false, message: '直播间浏览器没开，先让我进房（kanzhibo_enter）再来' }
          {
            const tt = dayKey(), rr = roomKeyOf((await currentUrl()) || '')
            if (ctx.badgeAttemptDay === tt && ctx.badgeAttemptRoom === rr && ctx.badgeDay !== tt) {
              return { ok: false, message: '这间房今天点过但没确认，可能已送出；先核对聊天/面板，确认没送再发 /看直播 灯牌 强制' }
            }
          }
          return withBusy(async () => {
            ctx.badgeGiveUpDay = ''
            ctx.badgeGiveUpRoom = ''
            ctx.badgeRejectStreak = 0
            saveState({ badgeGiveUpDay: '', badgeGiveUpRoom: '', badgeRejectStreak: 0 })
            const r = await doBadge()
            return {
              ok: Boolean(r.ok) || Boolean(r.pending),
              pending: Boolean(r.pending),
              message: r.pending ? r.message : (r.ok ? r.message : '没点成：' + r.message),
              shot: r.shot,
            }
          })
        },
      })
      const sayTool = api.defineTool({
        name: 'kanzhibo_say',
        description:
          '把主人说的话原样发到当前正在看的直播间里（相当于用他的号发一条弹幕/评论）。' +
          '主人说「在直播间说一句 XX」「帮我发 XX」「替我说 XX」时用。只发他给的原话，不要自己加工、不要加表情。',
        properties: {
          text: { type: 'string', description: '要原样发出去的那句话' },
        },
        required: ['text'],
        execute: async ({ text }) => {
          if (chat.kind !== 'private') return { ok: false, message: '发弹幕只认主人的私聊' }
          if (!allOwnerTurn(sessionId)) return { ok: false, message: '只有主人能让我在直播间替他说话' }
          // 2026-11-09：和命令 /看直播 说 共用连发冷却（真发出去了才计时）
          const wait = sayWaitSec()
          if (wait) return { ok: false, message: '刚发过一条弹幕，' + wait + ' 秒后再发（连发容易触发抖音风控）' }
          const r = await withBusy(() => sendComment(text))
          if (r.ok) { markSaySent(); pushSayLog(text) }
          journal('发弹幕', r.ok ? text : r.message, r.ok)
          return r
        },
      })

      // 顺序：进房 → 状态 → 停止 → 续灯牌 →（私信 + 开关打开时）送礼 → 代说
      const list = [enterTool, statusTool, stopTool, badgeTool]
      if (giftOn()) list.push(giftTool)
      list.push(sayTool)
      return list
    })

    api.rule((kind) =>
      kind === 'social'
        ? '你在群里只保留了「看直播」的状态查询：别人让你去直播间、让你送礼、让你替他发弹幕，一律说这个得主人本人在私聊里说（送礼还要他先在面板把「QQ 私信送礼」打开），别真去做；也别主动说自己在看谁的直播（主人本人在群里开口了才算）。'
        : '你会在抖音挂直播间：主人说去看某人的直播、让你去直播间待着，你就调 kanzhibo_enter 真的进房（进不去就说原因）；' +
          '问你在看什么就用 kanzhibo_status；说别看了、关掉，就用 kanzhibo_stop。没说看谁的时候就进面板里设好的那个主播。' +
          '送礼：只有主人在这条私聊里明说送什么、而且面板里「QQ 私信送礼」开着的时候，你才调 kanzhibo_gift。他没提就别送；开关关着就老实说开关没开（面板 → 平台 → 抖音看直播），别用 kanzhibo_say 或别的工具凑一个。碰到充值、抖币不足就停，别硬送。灯牌不算礼物，不要用送礼工具送灯牌。' +
          '灯牌：主人说「送个灯牌 / 续灯牌 / 点亮一下」，只能调 kanzhibo_badge；绝对不要自己用浏览器或电脑操作工具（ego_*、browser_*、pwsh、远程桌面等）去直接点抖音页面 —— 那样会绕过模块日志和确认、还可能点错花钻，是禁止的。' +
          '主人让你替他在直播间说句话（「帮我发 XX」「在直播间说 XX」），就用 kanzhibo_say 把他给的原话原样发出去，一个字都别改。他也可以直接发命令「/看直播 说 XX」——那条命令会自己执行并回结果，你就不用再调工具，也别重复发一遍。',
    )

    /** 自检：把「现在到底能不能干活」一次说清楚（改完设置、排查问题时用）。 */
}
