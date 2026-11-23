// 扩展模块「看直播」—— 放在 Aurabot 数据目录 modules/kanzhibo/ 里，插件升级不会动它。
// 保存就生效（几秒内自动重新加载），出错了去面板「已安装」页看原因。
//
// 干的事：
//   1. 用一台独立的 Edge 窗口挂在抖音直播间（给直播间地址，或给主播主页自己找「直播中」）。
//   2. 等页面真正加载出来（有评论框了）再发一条你自己定制的评论，同一个房间只发一次。
//   3. 按设置续粉丝团灯牌 / 送礼（半自动先截图发主人私聊，等一句「确认」才点）。

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createGate } from './lib/gate.mjs'
import { axSig } from './lib/room/ax.mjs'
import { taskProgressFromText, badgeHintsFromText, plus100FromText, badgeTaskRowFromText, BADGE_CHAT_RE } from './lib/room/find.mjs'
import { badgeRowState } from './lib/features/badge.mjs'
import { collapseNested, pickUnique, choosePoint, sameSig, normalizeSpec, describeHit } from './lib/room/find.mjs'

// 版本只写这一处：定义和自检里的字符串都读它，省得又出现「自检写着 v0.4.0」这种事。
// 1.0.0 → 2026-11-10：修 CDP 假端口撞车、弹幕冷却不抗重载、弹幕成功判据只有一级；
//   新增 开播主动提醒、/看直播 换、挂机日报、弹幕记录（state + 自检）、面板弹幕卡
//   （当前直播间 / 冷却显示）、/say 面板接口只认本机主人。
// 1.0.1 → 2026-11-09：修 /selfcheck 里的 ReferenceError: url is not defined
//   （roomId 那行读了一个不存在的变量，整个接口连带自检单都返回错误）。
// 1.0.2 → 2026-11-09：灯牌的「今天已放弃自动」标签原来只按天记，换了直播间/主播还在，
//   整晚静默跳过（看着就是「送灯牌没启动」）。现在标记绑房间号，进到别的房间自动作废。
// 1.0.3 → 2026-11-09：抖音把按钮改叫「送1个基础灯牌」，旧文字表一个都不匹配，于是退到裸「点亮」，
//   而星守护/展馆那排「差N个点亮」贡献了 7 个同名按钮 → 候选不唯一直接拒绝。
//   补上真实文案，并用 excludeAncestor 把那排集星按钮按祖先文字挡掉。
// 1.1.0 → 2026-11-21：新增「工作区操作记录」——每步操作写进 modules-data/kanzhibo/worklog/YYYY-MM-DD.jsonl，
//   同时接一条「看直播 · 工作间」后台会话到 Aurabot 工作区（hub.runSystemTurn，DSH 侧栏能点开看），
//   每 15 秒把这几步汇总记进去，写失败不影响挂直播主流程。新增 /看直播 记录、/ops 接口、面板卡片。
// 1.1.1 → 2026-11-22：加固「聊天区播报」判据。这个号昵称是「蔚」，但 badgeEvidence 拿不到昵称时
//   会取聊天区**最后一条**「送出了 粉丝团灯牌」，直播间里别人（如「97」）送的会被算成自己送的。
//   现在对不上昵称就必须今日任务进度也真涨了才算；tick「今天已送过」分支补一条 journal，别再不声不响。
// 1.2.0 → 2026-11-22：新增工具 kanzhibo_badge（续灯牌专用，走模块的确认/命中/日志链路）。
//   起因：主人说「送个灯牌」时没有专用工具，她自作主张用 ego 浏览器（另一台浏览器、另一个账号）
//   直接点抖音页面，绕过了模块日志/确认，还差点分不清是谁送的。现在给她正规入口，并在规则里
//   明令禁止用浏览器/电脑操作工具直接点抖音页面。
import { VERSION, EVIDENCE_WAIT_MS, LIVE_RE, liveRoomId, roomKeyOf, giveUpRoomsDiffer, isLiveTarget, sleep, findBrowser, getJson, Cdp } from './lib/util.mjs'
import { createWorklog } from './lib/worklog.mjs'
import { TASK_ENTRY_EXPR, BADGE_ENTRY_SPEC, BADGE_CONFIRM_TEXTS, BADGE_CONFIRM_SPEC, GIFT_CELL_SPEC, GIFT_CONFIRM_SPEC } from './lib/room/specs.mjs'
import { registerActionRoutes } from './lib/http/actions.mjs'
import { registerAdminRoutes } from './lib/http/admin.mjs'
import { createStatus } from './lib/status.mjs'
import { createSelfCheck } from './lib/selfcheck.mjs'
import { createContext } from './lib/context.mjs'
import { createBrowser } from './lib/browser.mjs'
import { createPage } from './lib/page.mjs'
import { createNavigator } from './lib/room/navigate.mjs'
import { createGateFlow } from './lib/gateflow.mjs'
import { createBadge } from './lib/badge.mjs'
import { createGift } from './lib/gift.mjs'
import { createSay } from './lib/say.mjs'
import { createTick } from './lib/tick.mjs'
import { registerTools } from './lib/tools.mjs'
import { registerCommands } from './lib/commands.mjs'

export default {
  id: 'kanzhibo',
  // 名字里有「抖音」：面板导航的分组是看模块名来分的（逛/刷/B站/抖音/小红书/闲鱼/淘宝/微博/知乎/贴吧/快手/触站/小黑盒 → 「平台」组，
  // 其余归一「系统」组）。所以这个模块要在「平台」下挂着，名字就得带上「抖音」。改名会连带面板标签一起变。
  name: '抖音看直播',
  version: VERSION,
  api: 1,
  // 面板「已安装」页那一行只显示 名字 / id / 状态 / description，不读 version 字段（客户端 ModuleRow 里没有这一项），
  // 所以版本号写在 description 开头，那一行才看得见；名字里不能加（名字决定导航分组，还要留给「平台」组认「抖音」）。
  description: 'v' + VERSION + ' · 挂抖音直播间 + 进房评论 + 续粉丝团灯牌 + 私信发弹幕（/看直播 说）+ 每步操作记进本地 worklog；送礼另有一道锁（只认主人私聊）',

  defaults: {
    enabled: false,
    target: '',
    checkSec: 120,
    schedule: false,
    startTime: '20:00',
    endTime: '23:30',
    liveCommentOn: false,
    liveComment: '',
    commentDelaySec: 8,
    renewBadge: false,
    badgeDelaySec: 30,
    // 2026-11-22：自己的抖音昵称（这个号叫「蔚」）。判「送出了 粉丝团灯牌」时按它认出自己的那条，
    //   别把直播间里别人的播报（像「97：送出了…」）当成自己送的。
    badgeNickname: '蔚',
    // B5：灯牌判据 v2（结构化）。真机样本可用但仍有未覆盖态，默认关；确认稳定后再开。
    badgeJudgeV2: false,
    // 2026-11-06 加：送礼是花抖币的真动作，单独一道锁，默认关着。
    giftByDm: false,
    // 2026-11-06 加：半自动 —— 真点下去之前先截图发主人私聊，等他一句「确认」。
    semiAuto: true,
    // 等你点头等多少秒（超时就自动撤，不点）
    confirmSec: 90,
    browserPath: '',
    minuteReport: false,
    // 1.3.0：工作区会话已停用（只写本地 jsonl + 面板操作记录）。保留键仅为兼容旧配置。
  },
  // 面板是自定义的（panel.js 按大类分卡片）；字段清单放在 settingsSchema 里，自检脚本也读它。
  settings: [],
  settingsSchema: [
  // 顺序按「要不要挂 → 什么时候挂 → 挂谁 → 进房评论 → 灯牌 → 礼物 → 调试」排（面板里是按大类分的卡片）。
    // —— 挂直播：要不要挂 / 什么时候挂 ——
    { key: 'enabled', label: '总开关', type: 'switch', hint: '关掉后这个模块什么都不做：不进房、不评论、不送灯牌、不送礼，浏览器也关掉' },
    { key: 'schedule', label: '按时间段挂', type: 'switch', hint: '开着 = 只在下面那段时间才启动 / 继续挂着；关掉 = 任何时候都进（时段只是标记）' },
    { key: 'startTime', label: '开始时间', type: 'text', placeholder: '21:07', hint: '24 小时制，写成 21:07' },
    { key: 'endTime', label: '结束时间', type: 'text', placeholder: '23:00', hint: '可以跨午夜，比如 22:30 → 01:00' },
    // —— 挂谁 ——
    {
      key: 'target',
      label: '直播间或主页',
      type: 'text',
      placeholder: 'https://live.douyin.com/123456789',
      hint: '直播间链接最稳；给主播主页（douyin.com/user/…）会自己找「直播中」点进去',
    },
    { key: 'checkSec', label: '多久看一次（秒）', type: 'number', min: 30, max: 1800, step: 30, hint: '不在直播间就重新进；改完立刻生效，不用重载模块' },
    // —— 进房评论（默认关）——
    { key: 'liveCommentOn', label: '进房发评论', type: 'switch', hint: '默认关。打开后每天最多发一次，同一个直播间不重复发' },
    { key: 'liveComment', label: '评论内容', type: 'textarea', hint: '多行只发第一行；留空就不发' },
    { key: 'commentDelaySec', label: '等几秒再发（秒）', type: 'number', min: 0, max: 120, step: 1, hint: '等画面和评论框出来，默认 8 秒' },
    // —— 粉丝团灯牌：真的会去点左上角那一块，有误触风险 ——
    {
      key: 'renewBadge',
      label: '续粉丝团灯牌',
      type: 'switch',
      hint: '⚠ 真会去点左上角：可能点偏到顶栏 / 礼物栏 / 别人的头像，点完会回读「今日任务」确认。细节看下面「风险与现场」',
    },
    { key: 'badgeDelaySec', label: '等几秒再续（秒）', type: 'number', min: 5, max: 600, step: 5, hint: '默认 30 秒。越早越容易点偏，宁晚不早' },
    { key: 'badgeNickname', label: '自己的直播间昵称', type: 'text', placeholder: '蔚', hint: '用来在聊天区认出「自己送出了灯牌」的那条播报；可以填抖音号显示的名字' },
    { key: 'badgeJudgeV2', label: '灯牌判据 v2（实验）', type: 'switch', hint: '按灯牌行结构判断已送/可送；等 4 态 fixture 定稿后再打开' },
    // —— 礼物：花抖币，只认主人私聊 + 这道开关 ——
    {
      key: 'giftByDm',
      label: 'QQ 私信送礼',
      type: 'switch',
      hint: '打开后你在私聊里说「送个小心心」她才会真的送；关着就没这个本事。群里永远不送。花的是你的抖币，送出去没有撤回',
    },
    // —— 怎么动手（半自动 / 自动）——
    {
      key: 'semiAuto',
      label: '动作前先问我',
      type: 'switch',
      hint: '开 = 半自动：续灯牌 / 送礼之前，先把要点的位置截图发你私聊，回「/看直播 确认」才点；关 = 自动，直接点（照样要过命中校验）。90 秒不回就撤',
    },
    { key: 'confirmSec', label: '等你多少秒', type: 'number', min: 10, max: 600, step: 5, hint: '半自动默认 90 秒；到点没收到「确认」就自动撤销，不点' },
    // —— 调试 ——
    { key: 'browserPath', label: '浏览器路径', type: 'text', hint: '留空 = 自动找 Edge（找不到再找 Chrome / Chromium）', placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { key: 'minuteReport', label: '进房时通知我', type: 'switch', hint: '进房后私聊说一声' },
    // —— 工作区操作记录（2026-11-21）——
  ],
  panel: 'panel.js',   // 自动表单下面再加一张「风险与现场」卡（只读状态 + 误触提示）

  setup(api) {
    const ctx = createContext()
    let lastNote = ''
    // 收工 / 关掉后的一段时间里不要自己再开：不然 tick 两分钟一轮又把浏览器打开了

    const profileDir = () => join(api.dataDir(), 'live-profile')
    const stateFile = () => join(api.dataDir(), 'state.json')

    const loadState = () => {
      try { return JSON.parse(readFileSync(stateFile(), 'utf8')) || {} } catch { return {} }
    }
    // 原子写：tmp + rename，Windows 上 EACCES/EBUSY 退避重试；返回是否写成功
    const saveState = (patch) => {
      const file = stateFile()
      let data = ''
      try { data = JSON.stringify({ ...loadState(), ...patch }, null, 2) } catch (e) { return false }
      const tmp = file + '.tmp-' + process.pid
      for (let i = 0; i < 8; i++) {
        try {
          writeFileSync(tmp, data)
          renameSync(tmp, file)
          return true
        } catch (e) {
          try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
          const code = e && e.code
          if (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM') {
            const until = Date.now() + 15 * (i + 1)
            while (Date.now() < until) {}
            continue
          }
          break
        }
      }
      try { console.error('[kanzhibo] saveState 失败（原子写）') } catch {}
      return false
    }

    // 收工后安静期（state.json 持久化）
    const dayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

    // badge/gift 钱相关状态统一放 ctx（供 lib/badge、lib/gift 共享）
    ctx.badgeDay = String(loadState().badgeDay || '')
    { const br = loadState().badgeRooms; ctx.badgeRooms = (br && typeof br === 'object' && br.rooms && typeof br.rooms === 'object') ? br : { day: '', rooms: {} } }
    ctx.badgeUrl = String(loadState().badgeUrl || '')
    ctx.badgeReportDay = String(loadState().badgeReportDay || '')
    ctx.badgeRejectDay = String(loadState().badgeRejectDay || '')
    ctx.badgeRejectStreak = Number(loadState().badgeRejectStreak || 0)
    ctx.badgeAskDay = String(loadState().badgeAskDay || '')
    ctx.badgeAskRoom = String(loadState().badgeAskRoom || '')
    ctx.badgeAttemptDay = String(loadState().badgeAttemptDay || '')
    ctx.badgeAttemptRoom = String(loadState().badgeAttemptRoom || '')
    ctx.giftAttemptDay = String(loadState().giftAttemptDay || '')
    ctx.giftAttemptRoom = String(loadState().giftAttemptRoom || '')
    ctx.giftAttemptName = String(loadState().giftAttemptName || '')
    ctx.badgeGiveUpDay = String(loadState().badgeGiveUpDay || '')
    ctx.badgeGiveUpRoom = String(loadState().badgeGiveUpRoom || '')
    ctx.quietUntil = Number(loadState().quietUntil || 0)

    ctx.lastSayAt = Number(loadState().lastSayAt || 0)
    {
      const st = loadState().sayLog
      ctx.sayLog = (st && st.day === dayKey() && Array.isArray(st.items)) ? st : { day: dayKey(), items: [] }
    }

    // 进房评论每天只发一次：记住发过的那天，跨天自动重来
    let commentedDay = String(loadState().commentedDay || '')
    // 2026-11-22 修：ctx.badgeUrl 原来只声明成 ''、从没从 state 读回来 —— 模块一重载就变空，
    //   「今天已送过」判据里 roomKeyOf('') ≠ 当前房间，于是每轮都当成没送过、反复弹「等你点头」。
    // 灯牌连续失败计数：连挂 3 次就当天降级成「提醒主人自己点」
    // 2026-11-22：半自动「等你点头」防刷屏 —— 这间房今天自动问过一次、没人回就别每轮再问。
    // M6/B3+B4：点前落盘“尝试”，未确认当天同房不再自动重点（防重复扣钻）
    // B1：送礼也落 attempt，未确认当天同房同礼物不自动重送（防双花）
    // 1.0.2：放弃时在哪个房间（房间号）。只有还在同一个房间，当天的放弃标记才继续拦。

    const note = (text, level = 'info') => {
      lastNote = new Date().toLocaleTimeString() + ' ' + text
      api.log[level] ? api.log[level](text) : api.log.info(text)
    }

    // ================= 工作区操作记录（2026-11-21 新增）=================
    // 要求：接一个会话到 Aurabot 的工作区，里面记录每步操作。
    // 做法两层：
    //   ① 每步先写一条到 modules-data/kanzhibo/worklog/YYYY-MM-DD.jsonl（本地留痕，模块重载后还在）；
    //   ② 再接一条「看直播 · 工作间」的后台会话到「Aurabot · QQ」工作区
    //      （chatId 是 system:kanzhibo:workbench，DSH 侧栏能点开），每 15 秒把这几步汇总记进去。
    // 操作记录（本地 jsonl + 最近 300 条），实现见 lib/worklog.mjs
    const worklog = createWorklog({ dataDir: () => api.dataDir(), dayKey })
    const { journal, recentOps, fmtStep } = worklog

    // 2026-11-09：checkSec 的钳制原来写散在 6 个地方，统一收进来（armTick / 自检 / 面板接口都用）。
    const clampCheckSec = () => Math.max(30, Math.min(1800, Number(api.settings().checkSec) || 120))

    // —— 半自动闸门：一次只放一个动作，90 秒不回就撤 ——
    const gate = createGate({ ttlMs: 90_000 })

    const ownerChat = () => {
      const q = api.config().ownerQQ
      return q ? 'private:' + q : ''
    }

    // —— 2026-11-09 新功能：QQ 私信里直接命令发弹幕 ——
    // 「/看直播 说 主播加油」→ 她在当前挂着看的直播间把这句话原样发出去。
    // 弹幕是用主人的抖音号**公开发出去**的，所以权限跟送礼同级收紧：
    //   只认「主人本人的 QQ 私聊」——群里（哪怕主人在）发这条命令会被直接拒绝。
    // 但不另设面板开关：内容就是主人指定的原话，不像送礼那样花抖币，没有误触损失。

    // 连发冷却：弹幕发太快容易被抖音风控（轻则限流重则封弹幕），
    // 命令（/看直播 说）和工具（kanzhibo_say）两条路共用一个冷却。
    // 只在**真发出去了**才计时：没进直播间、没点成发送的失败尝试不占冷却，
    // 主人修好问题（比如先 /看直播 进）立刻就能再发。
    const say = createSay({ ctx, saveState, dayKey, ownerChat })
    const { SAY_GAP_MS, SAY_MAX_CHARS, sayWaitSec, markSaySent, pushSayLog, stripQuotes, fromOwnerDm } = say

    /** 给主人私聊发一句话 + 可选一张图（发不出去也不影响主流程）。 */
    const browser = createBrowser({ ctx, api, note, findBrowser, getJson, Cdp, profileDir, navigate: (u) => navigate(u), loadState, evalJs: (e) => evalJs(e) })
    const { showWindow, openLogin, attach, forceMaximizedInProfile, launch, ensureBrowser, livePort, killBrowserProcess, closeBrowser, ensureMaximized, inWindow, loginState } = browser

    const pageFlow = createPage({ ctx, api, note, sleep, ensureMaximized, LIVE_RE, pushSayLog, clickBy })
    const { shot, cleanShots, clicker, evalJs, ax, axText, endedSignals, chatLines, pageText, panelText, ensureViewport, currentUrl, navigate, waitRoomReady, enterFromProfile, sendComment } = pageFlow
    const gateFlow = createGateFlow({ ctx, api, note, sleep, shot, clicker, gate, ownerChat, saveState, dayKey, journal, roomKeyOf, closeTaskPanel: (...a) => closeTaskPanel(...a), commitBadge: (...a) => commitBadge(...a), commitGift: (...a) => commitGift(...a), getBusy: () => busy, setBusy: (v) => { busy = v } })
    const { tellOwner, notifyOwner, askOwner, armGate, confirmPending, cancelPending, dropPending, badgeReject, disposeGate } = gateFlow

    /**
     * 判定「今天的粉丝团灯牌送了没」。
     * 🔴 2026-11-03（主人指的位置）：看「今日任务」面板里那一行
     *   「粉丝团灯牌 … 已完成」——带「已完成 / 已送出 / 已领取」就算今天送过了。
     *   面板开着就直接读，关着就点开读一下再收起来；读不到一律当「没送」。
     */
    // 左上角「今日任务」入口（点它是开关：面板关着时点开、开着时点关）。提到这层是因为
    // badgeSent / prepareBadge / closeTaskPanel 都要用，别再各存一份。

    const badgeFlow = createBadge({
      ctx, api, note, sleep, saveState, dayKey, roomKeyOf, panelText, chatLines, shot,
      clicker, ax, clickBy, choosePoint, describeHit, axSig, normalizeSpec, collapseNested, pickUnique, sameSig, evalJs, askOwner, gate,
      BADGE_ENTRY_SPEC, BADGE_CONFIRM_SPEC, BADGE_CONFIRM_TEXTS, TASK_ENTRY_EXPR,
      BADGE_CHAT_RE, taskProgressFromText, plus100FromText, badgeHintsFromText,
      badgeTaskRowFromText, badgeRowState, EVIDENCE_WAIT_MS, currentUrl, ensureViewport, journal,
    })
    const { badgeSent, closeTaskPanel, findBadgeConfirm, openBadgePanel, fanPanelOpen, prepareBadge, badgeEvidence, commitAx, commitBadge, doBadge } = badgeFlow

    async function clickBy(finderExpr, label, opts) {
      return await clicker.clickExpr(finderExpr, label, opts)
    }

    const giftFlow = createGift({ ctx, api, note, sleep, saveState, dayKey, roomKeyOf, currentUrl, evalJs, pageText, clicker, askOwner, journal, GIFT_CELL_SPEC, GIFT_CONFIRM_SPEC, LIVE_RE, ensureViewport, clickBy, gate })
    const { hasRecharge, dumpCorner, giftPanelOpen, openGiftPanel, prepareGift, commitGift, sendGift, readBalance, verifyGiftSent } = giftFlow

    const nav = createNavigator({ api, ctx, note, ensureBrowser, currentUrl, navigate, enterFromProfile, saveState, loadState })
    const { ensureInRoom } = nav

    const probeToken = Math.random().toString(36).slice(2) + Date.now().toString(36)
    let busy = false
    const withBusy = async (fn) => {
      if (busy) return { ok: false, message: '上一轮还在跑，等几秒再试' }
      busy = true
      try { return await fn() } finally { busy = false }
    }
    const tickFlow = createTick({
      ctx, api, note, sleep, saveState, loadState, dayKey, roomKeyOf, LIVE_RE, currentUrl,
      ensureBrowser, closeBrowser, livePort, ensureInRoom, waitRoomReady, endedSignals, enterFromProfile,
      sendComment, gate, badgeSent, doBadge, badgeReject, closeTaskPanel, notifyOwner, dropPending,
      journal, cleanShots, getBusy: () => busy, setBusy: (v) => { busy = v }, inWindow, clampCheckSec, giveUpRoomsDiffer, getCommentedDay: () => commentedDay, setCommentedDay: (v) => { commentedDay = v },
    })
    const { tick, enterNow, stopNow, dailyReport } = tickFlow

    const status = createStatus({ api, ctx, currentUrl, inWindow, gate, dayKey, getCommentedDay: () => commentedDay, getLastNote: () => lastNote, currentUrl })
    const { statusLine } = status

    const selfcheckFlow = createSelfCheck({ api, ctx, findBrowser, profileDir, existsSync, livePort, endedSignals, inWindow, clampCheckSec, getTickAnchor: () => tickAnchor, dayKey, SAY_MAX_CHARS, sayWaitSec, gate, worklog, stateFile, getCommentedDay: () => commentedDay, getLastNote: () => lastNote, currentUrl })
    const { selfCheck } = selfcheckFlow

    /**
     * 这一轮说话的人是不是**全是**主人。
     * API 文档明确：别用 turnHasOwner —— 它只表示「本轮有人是主人」，
     * 主人和群友同一轮开口时，别人能借这个身份让她动真格。
     */
    const allOwnerTurn = (sessionId) => {
      const hub = api.core && api.core.hub
      try {
        if (hub && typeof hub.turnSendersAllOwner === 'function') return Boolean(hub.turnSendersAllOwner(sessionId))
        // 缺严格 API 时宁可 false：turnHasOwner 只表示“本轮有人是主人”，群友可借身份
        return false
      } catch {}
      return false
    }

    // —— 给她用的工具：这样她在 QQ 里才认得「去看直播」 ——
    registerTools({ api, allOwnerTurn, enterNow, stopNow, withBusy, sendGift, doBadge, sendComment, sayWaitSec, markSaySent, pushSayLog, journal, statusLine, ctx, dayKey, roomKeyOf, currentUrl, loadState, saveState, gate, SAY_MAX_CHARS })

    registerCommands({ api, statusLine, selfCheck, confirmPending, cancelPending, gate, doBadge, enterNow, sendComment, stripQuotes, fromOwnerDm, SAY_MAX_CHARS, sayWaitSec, markSaySent, pushSayLog, recentOps, fmtStep, withBusy, stopAll: (...a) => stopAll(...a), closeBrowser, ctx, saveState, dropPending, tick, getBusy: () => busy, setBusy: (v) => { busy = v }, dayKey, roomKeyOf, journal, currentUrl, isLiveTarget, badgeSent })

    api.route('/login/state', async () => {
      const r = await loginState()
      // 接口本身一定成功（ok:true），登录与否看 state
      return { ...r, ok: true }
    })
    registerActionRoutes(api, {
      login: () => withBusy(() => openLogin()),
      window: (show) => withBusy(() => showWindow(show)),
    })


    // 面板专用确认/撤销（只认本机 + 面板令牌；不再借 /probe 的付费语义）
    api.route('/confirm', async (req) => {
      const sock = String((req && req.socket && req.socket.remoteAddress) || '')
      if (sock && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(sock)) return { ok: false, code: 403, message: '只允许本机' }
      const q = api.core.http.query(req) || {}
      if (String(q.token || '') !== probeToken) return { ok: false, code: 403, message: '缺少/错误的面板令牌' }
      return { ok: true, message: await confirmPending() }
    })
    api.route('/cancel', async (req) => {
      const sock = String((req && req.socket && req.socket.remoteAddress) || '')
      if (sock && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(sock)) return { ok: false, code: 403, message: '只允许本机' }
      const q = api.core.http.query(req) || {}
      if (String(q.token || '') !== probeToken) return { ok: false, code: 403, message: '缺少/错误的面板令牌' }
      return { ok: true, message: await cancelPending() }
    })


    /** 面板用：现在有没有在等确认。 */

    /**
     * 排查用（只读优先）：把「界面里到底有哪些候选」摊开，不花钱的点击要 ?open=1 才做。
     *   /aurabot/api/ext/kanzhibo/probe?what=badge&open=1&shot=1&target=https://live.douyin.com/xxx
     *   /aurabot/api/ext/kanzhibo/probe?what=gift&name=小心心&open=1&shot=1
     */
    registerAdminRoutes({ api, ctx, livePort, attach, ensureViewport, waitRoomReady, currentUrl, evalJs, chatLines, ax, pageText, clicker, note, sendComment, markSaySent, pushSayLog, journal, SAY_MAX_CHARS, sayWaitSec, LIVE_RE, withBusy })

    api.route('/selfcheck', async (req) => {
      const sock = String((req && req.socket && req.socket.remoteAddress) || '')
      if (sock && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(sock)) return { ok: false, code: 403, message: '只允许本机' }
      const s = api.settings()
      // 2026-11-09 修：下面对象里的 url 只是键名，不是变量；roomId 那行原来直接用了 url，
      // 于是整个 /selfcheck 抛 ReferenceError: url is not defined。先把当前地址取到局部变量。
      const curUrl = ctx.cdp ? await currentUrl() : ''
      return {
        probeToken,
        ok: true,
        browser: findBrowser(api.settings().browserPath),
        browserPath: api.settings().browserPath || '',
        profileDir: profileDir(),
        profileExists: existsSync(profileDir()),
        connected: Boolean(ctx.cdp),
        port: ctx.port,
        url: curUrl,
        enabled: Boolean(s.enabled),
        target: s.target || '',
        inWindow: inWindow(),
        schedule: Boolean(s.schedule),
        checkSec: clampCheckSec(),
        douyinEnabled: Boolean((api.config().douyin || {}).enabled),
        commentedDay,
        badgeDay: ctx.badgeDay,
        giftByDm: Boolean(s.giftByDm),
        semiAuto: Boolean(s.semiAuto),
        badgeGiveUpDay: ctx.badgeGiveUpDay,
        badgeGiveUpRoom: ctx.badgeGiveUpRoom,
        pending: gate.state(),
        viewport: ctx.viewport,
        // P2：残留浏览器端口（面板「运行状态」卡用它提示「模块没连但浏览器还挂着」）
        leftoverPort: ctx.cdp ? 0 : await livePort(),
        // P1：当前直播间（自检文本 + 面板弹幕卡共用）
        roomId: ctx.cdp ? liveRoomId(curUrl) : '',
        // F4：今天的弹幕记录
        sayToday: ctx.sayLog.day === dayKey() ? ctx.sayLog.items.slice(-10) : [],
        // 2026-11-21：工作区操作记录（面板「工作区记录」卡用最近几步）
        ops: { count: worklog.count, items: recentOps(8) },
        today: dayKey(),
        text: await selfCheck(),
      }
    })

    api.onDispose(() => {
      // 模块停下时不能再改配置；定时器一定要清掉，否则它会在模块停止后醒来，
      // 调用已经不能用的 api（浏览器也要带走 —— 它是 detached 启动的，不会自己退）。
      // 2026-11-10 修：这里原来用 clearInterval 清 tickTimer —— 但 tickTimer 是
      //   armTick 里 setTimeout 拿到的句柄（setInterval 和 setTimeout 在 Node 里
      //   返回的是不同类型的对象，混用根本清不掉）。定时器清不掉 = 模块停了它还会醒。
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
      try { disposeGate() } catch {}
      // 2026-11-21：工作区记录没发出去的那批，停模块前尽量补一次（失败就算了，本地 jsonl 已经写了）
      try { gate.dispose() } catch {}
      // 停模块时也要把那台浏览器带走 —— 它是 detached 启动的，不会自己退。
      // 这里不能 await（onDispose 是同步回调），但 closeBrowser 内部先把同步部分做完。
      try { closeBrowser().catch(() => {}) } catch {}
      try { if (ctx.cdp) ctx.cdp.close() } catch {}
      ctx.cdp = null
    })

    // 检查间隔改成能热改：面板里改完 checkSec 不用重载模块，下一轮就按新间隔走。
    let tickTimer = null
    let tickSec = 0
    // 计时锚点：从**打开总开关那一刻**算起，之后每 checkSec 检查一次（不是从进房成功开始）
    let tickAnchor = Number(loadState().tickAnchor || 0)
    const armTick = (anchor) => {
      const sec = clampCheckSec()
      if (anchor) tickAnchor = anchor
      if (!tickAnchor) tickAnchor = Date.now()
      if (tickTimer && sec === tickSec) return
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
      tickSec = sec
      const step = sec * 1000
      const schedule = () => {
        tickTimer = null
        if (!api.settings().enabled) return
        tick(false).catch((e) => note('定时检查出错：' + (e && e.message), 'warn'))
        // 对齐到锚点：anchor + n*step，避免每轮重新计时把间隔越拖越久
        const now = Date.now()
        const next = tickAnchor + Math.ceil((now - tickAnchor + 1) / step) * step
        tickTimer = setTimeout(() => { if (api.settings().enabled) schedule() }, Math.max(1000, next - now))
        try { tickTimer.unref?.() } catch {}
      }
      const now = Date.now()
      const next = tickAnchor + Math.ceil((now - tickAnchor + 1) / step) * step
      tickTimer = setTimeout(() => { if (api.settings().enabled) schedule() }, Math.max(1000, next - now))
      try { tickTimer.unref?.() } catch {}
    }
    const disarmTick = () => {
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
      tickSec = 0
      tickAnchor = 0
      saveState({ tickAnchor: 0 })
    }
    /**
     * 总开关。关掉 = 这个模块什么都不做：
     *   · 停定时器（不再进房）；· 撤掉待确认（截图过期，不能再点）
     *   · 关掉那台专用浏览器
     * 只读的状态 / 自检 / 面板仍然能用，方便你看它为什么停。
     */
    const stopAll = async (why) => {
      disarmTick()
      await dropPending(why || '总开关关闭')
      await closeBrowser()
      // 2026-11-09：把跟「浏览器在不在」绑定的内存状态一起清掉，
      //   否则下次开开关时自检/状态会显示上一次的端口和视口（假的「已连上」）。
      ctx.port = 0
      ctx.viewport = null
      note('总开关关了：定时器、浏览器、待确认都停了' + (why ? '（' + why + '）' : ''), 'info')
      journal('关总开关', why || '定时器、浏览器、待确认都停了')
    }
    /**
     * 按当前开关状态把运行态调成对应的样子。
     * 2026-11-08 修：原来靠「上一个值 vs 现在值」判断，模块一重载 lastEnabled 就重新初始化，
     *   只要那一刻恰好是 false，之后再也触发不了关闭（prev===now 直接 return），
     *   浏览器就留着了。现在改成**幂等**：每次事件都按 now 收敛，
     *   关着就保证「没定时器 + 没浏览器 + 没待确认」。
     */
    let lastEnabled = Boolean(api.settings().enabled)
    const syncEnabled = async () => {
      const now = Boolean(api.settings().enabled)
      if (!now) {
        const hadWork = Boolean(tickTimer) || Boolean(ctx.cdp) || Boolean(gate.peek())
        const leftover = ctx.cdp ? 0 : await livePort()
        if (hadWork || leftover) await stopAll('总开关关闭')
        else if (tickTimer) disarmTick()
      } else {
        const turnedOn = !lastEnabled
        if (turnedOn) {
          // 一开就进：不等一个检查周期，直接开浏览器/进房；锚点也从这一刻开始
          tickAnchor = Date.now()
          saveState({ tickAnchor })
          ctx.quietUntil = 0
          saveState({ quietUntil: 0 })
          armTick(tickAnchor)
          note('总开关开了，立刻进房', 'info')
          tick(true).catch((e) => note('开开关后第一轮出错：' + ((e && e.message) || e), 'warn'))
        } else {
          // 2026-11-09 修 BUG：原来写成 else if (!tickTimer) —— 挂着的时候改 checkSec
          //   根本不会生效（schedule 闭包里的 step 是老值），和设置里写的「改完立刻生效」矛盾。
          //   armTick 本身幂等：间隔没变就原样返回，变了就按新间隔对齐锚点重排。
          armTick(tickAnchor || Date.now())
        }
      }
      lastEnabled = now
    }
    // 只有总开关开着才装定时器
    if (lastEnabled) armTick()
    api.on('config', () => { syncEnabled().catch(() => {}) })

    return {
      tick,
      selfCheck,
      status: () => ({ enabled: api.settings().enabled, target: api.settings().target, connected: Boolean(ctx.cdp) }),
      _debug: { inWindow, dayKey, findBrowser, roomKeyOf, giveUpRoomsDiffer, sayState: () => ({ lastSayAt: ctx.lastSayAt, gapMs: SAY_GAP_MS, maxChars: SAY_MAX_CHARS }), opsState: () => ({ items: recentOps(50) }) },
    }
  },
}
