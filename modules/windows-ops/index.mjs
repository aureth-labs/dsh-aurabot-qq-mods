// index.mjs —— windows-ops 模块入口（装配层）
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）
// 作用：把 lib/ps.mjs（PowerShell 执行底座）、lib/ops.mjs（操作目录）、lib/uia.mjs（UIA 无障碍树元素定位）、
//       lib/qq.mjs（QQ 客户端原生屏幕共享 / 远程协助）、lib/safety.mjs（白名单/确认/限速闸门）、
//       lib/guides.mjs（指引库）装配成完整模块。
// v1.3.1 关键变化（按主人要求，彻底放弃 v1.3.0 的截图发帧 + 自建网页）：
//   · 屏幕共享 = 机器人自己的 QQ 客户端里点「屏幕共享」→ 选「桌面」→「确定」；
//   · 远程协助 = 机器人客户端里点「远程协助 → 邀请对方远程协助」，主人在 QQ 里接受后直接操作；
//   · 窗口优先按机器人 QQ 号识别：RestartManager 反查账号分区锁文件 → PID → 顶层窗口；昵称只用于确认会话对象。
// v1.3.2：真正点按钮前先把当前屏幕截图发主人私聊，主人回复「确认」后才发起；截图只用于确认，不是共享内容。
// 契约：export default { id, name, version, api, settings: [], setup(api) → 导出对象 }
//   导出（api.use('windows-ops') 拿到）：
//     run(op, args) → { ok, message, data? }  —— 直接执行一个操作（不过安全闸门）
//     exec(op, args) → 同上，但过安全闸门（工具/命令都走它）
//     status() → { enabled, allowInput, dryRun, confirms, ops, whitelist, guides, qq, share, assist }
//     guides —— lib/guides.mjs 的指引库（main 总纲 + 按操作类型的手册）
//     OPS —— 操作元数据表
//     qq —— QQ 原生共享/协助句柄（windows / share / shareStop / assist / assistStop）
//   测试钩子：api.__windowsOpsTestHooks = { ps }（注入 fake ps，不打真 PowerShell）
//
// 安全模型（默认仅主人可用）：
//   · AI 工具只在主人会话放行（turnSendersAllOwner，群友同轮也不借权）；
//   · /wops 命令框架天然只认主人；共享/协助还要求当前是主人私聊；
//   · 操作白名单（面板改，空 = 内置规则）+ 键鼠模拟单独开关 + 危险操作确认门槛；
//   · qq.share 只读屏幕（safe），qq.assist 会把控制权交出去（input，须开「允许键鼠模拟」）。

import { existsSync, readFileSync } from 'node:fs'
import { createPs } from './lib/ps.mjs'
import { createOps, OPS } from './lib/ops.mjs'
import { createSafety } from './lib/safety.mjs'
import { createGuides } from './lib/guides.mjs'
import { pickQqTarget } from './lib/qq.mjs'
import { QQ_CONFIRM_TTL_MS, makeQqConfirmId, parseQqConfirmReply } from './lib/qq-confirm.mjs'

export default {
  id: 'windows-ops',
  name: '逛电脑（Windows 自动化）',
  version: '1.3.2',
  api: 1,
  description: '经 PowerShell 操作这台电脑：读无障碍树（UIA）按元素点击/写值/读文本/触发表单，窗口枚举/激活/关闭、截屏、剪贴板读写、键鼠模拟；并通过机器人自己的 QQ 客户端原生「屏幕共享」向主人或主人指定的好友共享屏幕、用「邀请对方远程协助」让对方直接接管；发起前先把当前屏幕截图发主人私聊确认。默认仅主人可用，带操作白名单、危险操作确认门槛与指引体系。',
  panel: 'panel.js', // 自定义面板：settings 数组留空，全部字段由 panel.js 接管（仿 phone）
  settings: [],
  defaults: {
    enabled: false,
    opsWhitelist: '',
    allowInput: false,
    confirmDanger: true,
    dryRun: false,
    rateLimit: 60,
    powershellPath: '',
    preferUia: true,
    // v1.3.1：QQ 原生共享 / 远程协助
    qqBotQQ: '', // 机器人 QQ 号；留空用插件配置里的 botQQ
    qqOwnerQQ: '', // 主人 QQ 号；留空用插件配置里的 ownerQQ
    qqBotName: '', // 可选：机器人昵称兜底（OneBot 连不上时用）
    qqOwnerName: '', // 可选：主人昵称兜底
    qqWindowHwnd: 0, // 高级：直接指定机器人 QQ 窗口句柄（0=自动）
    qqConfirmBeforeStart: true, // 发起前先截图发主人确认（默认开；关掉就直接点 QQ 按钮）
    shareAutoStopMinutes: 30, // 屏幕共享自动停止（0=不自动；原生 QQ 共享不会自己停）
  },

  setup(api) {
    const dataDir = () => api.dataDir()
    const config = () => (typeof api.config === 'function' ? api.config() : {}) || {}
    /** 设置每次现读（面板改完即时生效，不缓存）。 */
    const getSettings = () => {
      const s = api.settings()
      const num = (v, d, min, max) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d
      }
      return {
        enabled: s.enabled === true,
        opsWhitelist: String(s.opsWhitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        allowInput: s.allowInput === true,
        confirmDanger: s.confirmDanger !== false,
        dryRun: s.dryRun === true,
        rateLimit: Number(s.rateLimit) > 0 ? Number(s.rateLimit) : 0,
        powershellPath: String(s.powershellPath || ''),
        preferUia: s.preferUia !== false,
        qqBotQQ: String(s.qqBotQQ || '').trim(),
        qqOwnerQQ: String(s.qqOwnerQQ || '').trim(),
        qqBotName: String(s.qqBotName || '').trim(),
        qqOwnerName: String(s.qqOwnerName || '').trim(),
        qqWindowHwnd: num(s.qqWindowHwnd, 0, 0, 2147483647),
        qqConfirmBeforeStart: s.qqConfirmBeforeStart !== false,
        shareAutoStopMinutes: num(s.shareAutoStopMinutes, 30, 0, 240),
      }
    }
    const offMsg = () => ({ ok: false, message: '逛电脑总开关没开：请先到面板打开「总开关」' })

    // 测试钩子（照 pet/phone 模块 api.__xxxTestHooks 模式）：测试注入 fake ps，不打真 PowerShell
    const hooks = api.__windowsOpsTestHooks || {}
    const ps = (hooks.ps || createPs({ exe: getSettings().powershellPath }))
    const ops = createOps({ ps, dataDir: dataDir() })
    const safety = createSafety({ dataDir: dataDir(), getSettings, opsMeta: OPS })
    const guides = createGuides(dataDir())

    // ================= v1.3.1：QQ 原生屏幕共享 / 远程协助 =================
    /** 主人私聊 chatId（面板显式填的 qqOwnerQQ 优先，否则用插件配置 ownerQQ）。 */
    const ownerChatId = () => {
      const q = String(ownerQQ() || '').trim()
      return /^\d{5,12}$/.test(q) ? `private:${q}` : ''
    }
    /** 机器人/主人 QQ 号：面板显式填的优先，否则用插件配置（botQQ / ownerQQ）。 */
    const botQQ = () => getSettings().qqBotQQ || String(config().botQQ || '').trim()
    const ownerQQ = () => getSettings().qqOwnerQQ || String(config().ownerQQ || '').trim()

    /** OneBot 响应可能带 data 包装，统一取里面那层。 */
    const unwrap = (r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' ? r.data : (r || {}))
    /** 昵称解析缓存：QQ 号不变、昵称没改时，10 分钟内不重复问 OneBot。 */
    let nameCache = { key: '', botName: '', ownerName: '', botQQ: '', ownerQQ: '', at: 0, error: '' }
    /** 机器人好友列表缓存：目标好友必须在这张表里，避免把屏幕发给陌生人/群友。 */
    let friendCache = { botQQ: '', list: [], at: 0, error: '' }
    async function friendList() {
      const bq = botQQ()
      if (friendCache.botQQ === bq && Date.now() - friendCache.at < 10 * 60 * 1000) {
        return friendCache.error ? { ok: false, error: friendCache.error } : { ok: true, list: friendCache.list }
      }
      const onebot = typeof api.onebot === 'function' ? api.onebot : null
      if (!onebot) {
        friendCache = { botQQ: bq, list: [], at: Date.now(), error: 'OneBot 没连接，读不到机器人好友列表' }
        return { ok: false, error: friendCache.error }
      }
      try {
        const raw = unwrap(await onebot('get_friend_list', {}))
        const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : []
        friendCache = { botQQ: bq, list, at: Date.now(), error: '' }
        return { ok: true, list }
      } catch (e) {
        friendCache = { botQQ: bq, list: [], at: Date.now(), error: `读取机器人好友列表失败：${String(e?.message || e)}` }
        return { ok: false, error: friendCache.error }
      }
    }
    /** 解析共享/协助目标：空 = 主人；QQ 号或备注/昵称 = 机器人好友列表里的某个人。 */
    async function resolveTarget(target, n) {
      const t = String(target ?? '').trim()
      if (!t && n.ownerName) return { ok: true, qq: n.ownerQQ, name: n.ownerName }
      if (!t && !n.ownerQQ) return { ok: false, error: '没有指定目标，也没有配置主人 QQ 号' }
      if (t && n.ownerQQ && (t === String(n.ownerQQ) || t === n.ownerName)) {
        return { ok: true, qq: String(n.ownerQQ), name: n.ownerName }
      }
      const fl = await friendList()
      if (!fl.ok) return { ok: false, error: fl.error }
      return pickQqTarget(fl.list, t, { botQQ: n.botQQ, ownerQQ: n.ownerQQ, ownerName: n.ownerName })
    }
    /**
     * 按 QQ 号解析当前昵称。
     * 身份的真身是 QQ 号；昵称只是 QQ 窗口上显示的文字。所以：
     *   1) 机器人号 → get_login_info（校验返回的 user_id 是否就是它），失败再 get_stranger_info；
     *   2) 主人号 → get_stranger_info；
     *   3) 命令里带了 msg.nickname 时可直接当主人昵称（发命令的人已被框架验证为主人）。
     * OneBot 没连上时，退回面板里手填的 qqBotName / qqOwnerName。
     */
    async function resolveNames({ ownerHint = '' } = {}) {
      const s = getSettings()
      const bq = botQQ()
      const oq = ownerQQ()
      const key = [bq, oq, s.qqBotName, s.qqOwnerName, ownerHint].join('|')
      if (nameCache.key === key && Date.now() - nameCache.at < 10 * 60 * 1000) return nameCache
      let botName = s.qqBotName
      let ownerName = s.qqOwnerName || String(ownerHint || '').trim()
      let error = ''
      const onebot = typeof api.onebot === 'function' ? api.onebot : null
      if (onebot) {
        try {
          if (!botName && bq) {
            const login = unwrap(await onebot('get_login_info', {}))
            if (!login?.user_id || String(login.user_id) === bq) botName = String(login?.nickname || '').trim()
            if (!botName) {
              const info = unwrap(await onebot('get_stranger_info', { user_id: Number(bq), no_cache: true }))
              botName = String(info?.nickname || '').trim()
            }
          }
          if (!ownerName && oq) {
            const info = unwrap(await onebot('get_stranger_info', { user_id: Number(oq), no_cache: true }))
            ownerName = String(info?.nickname || '').trim()
          }
        } catch (e) {
          error = String(e?.message || e)
        }
      }
      const missing = []
      // 机器人窗口已能按 QQ 号锁定，机器人昵称只是兜底，缺了不阻塞；主人昵称用来确认会话对象，必须有。
      if (!ownerName) missing.push(`主人 QQ ${oq || '(未配置)'} 的昵称`)
      const ok = missing.length === 0
      nameCache = {
        key, botName, ownerName, botQQ: bq, ownerQQ: oq, at: Date.now(),
        error: ok ? '' : `无法识别${missing.join('、')}：请确认 OneBot 已连接，或在面板「QQ 共享」里手填主人昵称` + (error ? `（${error}）` : ''),
      }
      return nameCache
    }

    let qqLastMessage = ''
    let qqLastTarget = { qq: '', name: '' }
    let shareStartedAt = 0
    let assistStartedAt = 0
    /** 发起前截图确认：同一时间只允许一条，避免主人回「确认」时不知道该放行哪一个。 */
    let qqPending = null

    function pendingView() {
      return qqPending
        ? { id: qqPending.id, op: qqPending.op, target: qqPending.t, at: qqPending.at, expiresAt: qqPending.at + QQ_CONFIRM_TTL_MS, file: qqPending.file }
        : null
    }

    /** 清掉待确认（超时/取消/停止时调用）。 */
    function dropPending() {
      const p = qqPending
      qqPending = null
      if (p?.timer) clearTimeout(p.timer)
      return p
    }

    /** 给主人发一条状态文字；失败不阻塞动作本身。 */
    async function notifyOwner(chat, text) {
      try { if (typeof api.sendText === 'function') await api.sendText(chat, text) } catch { /* 消息失败不影响状态机 */ }
    }

    /** 发截图确认的目标私聊：优先用解析出来的主人 QQ，再退回设置/插件配置。 */
    function ownerQqFor(n) {
      const q = String(n?.ownerQQ || ownerQQ() || '').trim()
      return /^\d{5,12}$/.test(q) ? q : ''
    }

    /**
     * 已经拿到主人「发起前截图确认」后执行。这里跳过通用 confirmDanger 队列，
     * 因为截图确认本身就是更具体的一道确认；但白名单、键鼠开关、试运行、限速、日志都照旧。
     */
    async function execConfirmed(op, args = {}) {
      if (!getSettings().enabled) return offMsg()
      const cp = safety.checkOp(String(op))
      if (!cp.ok) return { ok: false, message: cp.reason }
      if (getSettings().dryRun) return { ok: true, message: `试运行：本该执行 ${OPS[op]?.label || op}，没有真动` }
      if (!safety.checkRate()) return { ok: false, message: `操作太频繁：每分钟上限 ${getSettings().rateLimit} 次` }
      try {
        const r = await ops.run(op, args)
        safety.log(String(op), r.message).catch(() => {})
        return r
      } catch (e) {
        safety.log(String(op), `失败：${e.message}`).catch(() => {})
        return { ok: false, message: e.message }
      }
    }

    /** 真正点 QQ 按钮。发起前截图确认通过后只会走到这里。 */
    async function executeQqOp(op, n, t, { confirmed = false } = {}) {
      const s = getSettings()
      const args = {
        hwnd: s.qqWindowHwnd,
        botName: n.botName,
        ownerName: t.name,
        targetName: t.name,
        targetQQ: t.qq,
        botQQ: n.botQQ,
        ownerQQ: n.ownerQQ,
      }
      const r = confirmed ? await execConfirmed(op, args) : await exec(op, args)
      if (r?.ok && !String(r.message || '').startsWith('试运行')) {
        qqLastMessage = String(r.message || '')
        if (op === 'qq.share' || op === 'qq.assist') qqLastTarget = { qq: String(t.qq || ''), name: t.name }
        if (op === 'qq.share') shareStartedAt = Date.now()
        if (op === 'qq.shareStop') shareStartedAt = 0
        if (op === 'qq.assist') assistStartedAt = Date.now()
        if (op === 'qq.assistStop') assistStartedAt = 0
      }
      return r
    }

    /**
     * 发起前截图确认：先截当前屏幕（JPEG，落 dataDir/shots），通过 OneBot 发给主人，
     * 挂起 pending；主人回「确认」才真正执行。截图只发给主人，不发给目标好友。
     * 返回 { ok:true, pending:true, id, message }，不是真的已发起。
     */
    async function requestQqConfirm(op, n, t) {
      if (qqPending) {
        return { ok: false, message: `已有一条待确认的 QQ 操作（${qqPending.t.name}，确认码 ${qqPending.id}）：先在主人私聊回复「确认」或「取消」` }
      }
      const s = getSettings()
      if (!s.enabled) return offMsg()
      const args = {
        hwnd: s.qqWindowHwnd,
        botName: n.botName,
        ownerName: t.name,
        targetName: t.name,
        targetQQ: t.qq,
        botQQ: n.botQQ,
        ownerQQ: n.ownerQQ,
      }
      const cp = safety.checkOp(op)
      if (!cp.ok) return { ok: false, message: cp.reason }
      const cfg = config()
      if (cfg.enabled === false) return { ok: false, message: 'Aurabot 总开关没开：发不出确认截图，未发起' }
      if (cfg.dryRun === true) return { ok: true, message: `试运行：本该发起 ${OPS[op]?.label || op}，没有真动` }
      if (getSettings().dryRun) return { ok: true, message: `试运行：本该发起 ${OPS[op]?.label || op}，没有真动` }

      const owner = ownerQqFor(n)
      if (!owner) return { ok: false, message: '主人 QQ 没解析出来：无法把发起前截图发给主人确认' }
      if (typeof api.sendImage !== 'function' || typeof api.sendText !== 'function') {
        return { ok: false, message: '当前插件没有发图/发文字接口，无法做发起前截图确认' }
      }
      if (typeof api.on !== 'function') {
        return { ok: false, message: '当前插件没有消息监听接口，无法接收主人的「确认/取消」' }
      }

      let shot
      try {
        shot = await ops.run('screen.capture', { maxWidth: 1600, quality: 72 })
      } catch (e) {
        return { ok: false, message: `发起前截图失败，未发起：${String(e?.message || e)}` }
      }
      const file = String(shot?.data?.file || '')
      if (!shot?.ok || !file) {
        return { ok: false, message: `发起前截图失败，未发起：${shot?.message || '截图没有落盘'}` }
      }

      const id = makeQqConfirmId()
      const label = op === 'qq.assist' ? '邀请对方远程协助（对方接受后可操作这台电脑）' : '屏幕共享（对方能看到这台电脑的屏幕）'
      const chat = `private:${owner}`
      const caption = [
        `【发起前确认】准备通过机器人 QQ 向 ${t.name}（${t.qq}）发起：${label}。`,
        '下面是当前屏幕截图，只发给主人核对，不会发给目标好友；请确认画面里没有不想让对方看到的内容。',
        `回复「确认」继续发起，回复「取消」放弃（${Math.round(QQ_CONFIRM_TTL_MS / 60000)} 分钟内有效）。`,
        `确认码：${id}`,
      ].join('\n')
      try {
        const imgSent = await api.sendImage(chat, file)
        const textSent = await api.sendText(chat, caption)
        // hub.sendImage/sendText 在总开关关着、试运行或被扩展模块拦下时返回 null：
        // 这时截图/说明并没有真的到主人手机上，不能挂 pending 等一个永远等不到的确认。
        if (imgSent === null || textSent === null) {
          return { ok: false, message: '确认截图或说明没有真正发出去（发送被总开关/试运行/扩展模块拦下），未发起' }
        }
      } catch (e) {
        return { ok: false, message: '发起前截图/确认消息发给主人失败，未发起：' + (e?.message || e) }
      }

      qqPending = {
        id, op, n, t, chat, file,
        at: Date.now(),
        timer: null,
      }
      qqPending.timer = setTimeout(async () => {
        const p = qqPending
        if (!p || p.id !== id) return
        dropPending()
        await notifyOwner(p.chat, `发起前确认已超时（${Math.round(QQ_CONFIRM_TTL_MS / 60000)} 分钟），没有发起 ${p.op === 'qq.assist' ? '远程协助' : '屏幕共享'}。要重试请重新发起。`)
      }, QQ_CONFIRM_TTL_MS)
      if (qqPending.timer.unref) qqPending.timer.unref()

      return {
        ok: true,
        pending: true,
        id,
        message: `已把发起前截图发到主人私聊，等待确认（确认码 ${id}，${Math.round(QQ_CONFIRM_TTL_MS / 60000)} 分钟内有效）。回复「确认」后才会真正发起；回复「取消」放弃。`,
      }
    }

    /** 调 QQ 原生操作：机器人窗口优先按 QQ 号锁定（账号分区→进程），昵称只用于确认会话对象。 */
    async function runQq(op, { ownerHint = '', target = '' } = {}) {
      // 停止类操作先把同类型的待确认撤掉，避免「已停止」之后又被一条旧确认放行。
      if (op === 'qq.shareStop' || op === 'qq.assistStop') {
        const startOp = op.replace(/Stop$/, '')
        if (qqPending?.op === startOp) dropPending()
      }
      const n = await resolveNames({ ownerHint })
      if (!n.ownerName && !String(target || '').trim()) return { ok: false, message: n.error || '主人昵称没解析出来' }
      const t = await resolveTarget(target, n)
      if (!t.ok) return { ok: false, message: t.error || '目标好友解析失败' }
      if (!t.name) return { ok: false, message: `目标 QQ ${t.qq || ''} 没有可用的会话昵称` }
      if ((op === 'qq.share' || op === 'qq.assist') && getSettings().qqConfirmBeforeStart) {
        return requestQqConfirm(op, n, t)
      }
      return executeQqOp(op, n, t)
    }
    const qq = {
      windows: () => ops.run('qq.windows', {}),
      share: (o) => runQq('qq.share', o),
      shareStop: (o) => runQq('qq.shareStop', o),
      assist: (o) => runQq('qq.assist', o),
      assistStop: (o) => runQq('qq.assistStop', o),
      status: () => ({ botQQ: botQQ(), ownerQQ: ownerQQ(), botName: nameCache.botName, ownerName: nameCache.ownerName, lastTarget: qqLastTarget, lastMessage: qqLastMessage, pending: pendingView() }),
    }

    /** 主人在 QQ 私聊里回复「确认/取消」后，才真正执行截图确认过的动作。 */
    async function handleOwnerConfirmMessage(msg) {
      if (!qqPending) return false
      if (msg?.kind !== 'private') return false
      let isOwner = false
      try { isOwner = api.isOwner(msg.userId) === true } catch { isOwner = String(msg.userId || '') === String(ownerQQ() || '') }
      if (!isOwner) return false
      const parsed = parseQqConfirmReply(msg.text)
      if (!parsed) return false
      const p = qqPending
      if (Date.now() - p.at > QQ_CONFIRM_TTL_MS) {
        dropPending()
        await notifyOwner(p.chat, '发起前确认已超时，没有发起。要重试请重新发起。')
        return true
      }
      if (parsed.id && parsed.id !== p.id) {
        await notifyOwner(p.chat, `确认码不对（当前待确认是 ${p.id}）；回复「确认 ${p.id}」或「取消」。`)
        return true
      }
      if (parsed.action === 'cancel') {
        dropPending()
        await notifyOwner(p.chat, `已取消：${p.op === 'qq.assist' ? '远程协助邀请' : '屏幕共享'}没有发起。`)
        return true
      }
      // 先撤 pending，再执行；避免执行期间又来一条「确认」重复点按钮。
      dropPending()
      await notifyOwner(p.chat, `收到确认，开始发起${p.op === 'qq.assist' ? '远程协助邀请' : '屏幕共享'}…`)
      let r
      try {
        r = await executeQqOp(p.op, p.n, p.t, { confirmed: true })
      } catch (e) {
        r = { ok: false, message: String(e?.message || e) }
      }
      await notifyOwner(p.chat, r.ok ? `已发起：${r.message}` : `发起失败：${r.message}`)
      return true
    }
    if (typeof api.on === 'function') api.on('message', handleOwnerConfirmMessage)

    /** 原生共享状态（没有帧计数，只有开始时间和自动停止倒计时）。 */
    function shareStatus() {
      const s = getSettings()
      const active = shareStartedAt > 0
      const remainingMs = active && s.shareAutoStopMinutes > 0
        ? Math.max(0, s.shareAutoStopMinutes * 60000 - (Date.now() - shareStartedAt))
        : null
      return {
        active,
        startedAt: shareStartedAt || 0,
        autoStopMinutes: s.shareAutoStopMinutes,
        remainingMs,
        lastMessage: qqLastMessage,
        pending: qqPending?.op === 'qq.share' ? pendingView() : null,
      }
    }
    function assistStatus() {
      return { active: assistStartedAt > 0, startedAt: assistStartedAt || 0, lastMessage: qqLastMessage, pending: qqPending?.op === 'qq.assist' ? pendingView() : null }
    }

    // 原生屏幕共享不会自己停：按面板设置到点调 QQ 的「停止共享」。
    // api.every 是插件接口；单测 fake api 不带这个面，按能力探测。
    if (typeof api.every === 'function') {
      let autoStopBusy = false
      api.every(10000, async () => {
        if (!shareStartedAt || autoStopBusy) return
        const mins = getSettings().shareAutoStopMinutes
        if (mins <= 0 || Date.now() - shareStartedAt < mins * 60000) return
        autoStopBusy = true
        try {
          const n = await resolveNames()
          if (!n.botName || !n.ownerName) return
          const s = getSettings()
          const r = await ops.run('qq.shareStop', { hwnd: s.qqWindowHwnd, botName: n.botName, ownerName: n.ownerName, botQQ: n.botQQ, ownerQQ: n.ownerQQ })
          if (r?.ok) {
            shareStartedAt = 0
            qqLastMessage = String(r.message || '')
            const chatId = ownerChatId()
            if (chatId && typeof api.send === 'function') api.send(chatId, `（QQ 屏幕共享已自动停止：${mins} 分钟到）`).catch(() => {})
          }
        } finally {
          autoStopBusy = false
        }
      }, 'QQ 屏幕共享自动停止')
    }

    /** 危险操作的摘要（确认队列里给主人看）。 */
    function summaryOf(op, args) {
      const r = ops.prepare(op, args)
      return r.summary
    }

    /** 带闸门执行：工具与命令统一走这里。 */
    async function exec(op, args = {}) {
      if (!getSettings().enabled) return offMsg()
      const cp = safety.checkOp(String(op))
      if (!cp.ok) return { ok: false, message: cp.reason }
      let gate
      try {
        gate = safety.gate({ op: String(op), summary: summaryOf(op, args) })
      } catch (e) {
        return { ok: false, message: e.message }
      }
      if (gate.verdict === 'REJECT') return { ok: false, message: gate.reason || '操作被拒绝' }
      if (gate.verdict === 'DRY_RUN') return { ok: true, message: `试运行：本该执行 ${OPS[op]?.label || op}，没有真动` }
      if (gate.verdict === 'NEED_CONFIRM') {
        return { ok: false, message: `危险操作需主人确认：${OPS[op]?.label || op}（${summaryOf(op, args)}）。主人发「/wops confirm 批准 ${gate.id.slice(-6)}」后放行一次`, confirmId: gate.id }
      }
      if (!safety.checkRate()) return { ok: false, message: `操作太频繁：每分钟上限 ${getSettings().rateLimit} 次` }
      try {
        const r = await ops.run(op, args)
        safety.log(String(op), r.message).catch(() => {})
        return r
      } catch (e) {
        safety.log(String(op), `失败：${e.message}`).catch(() => {})
        return { ok: false, message: e.message }
      }
    }

    // ================= 指引注入（总纲常驻 + 手册按需）=================
    api.rule('private', () => {
      const s = getSettings()
      if (!s.enabled) return ''
      const lines = ['【逛电脑总纲（操作这台电脑时必读，与按需取的手册一起看）】', guides.get('main')]
      if (!s.preferUia) lines.push('【本次设置】元素定位优先已关闭：按坐标操作（mouse.move / mouse.click），读无障碍树只用来确认界面状态。')
      lines.push('【QQ 原生共享与远程】主人说「共享屏幕 / 让我看看屏幕」→ windows_share_screen start：在机器人自己的 QQ 客户端里点聊天工具栏「屏幕共享」，选「桌面」再「确定」，不是截图发帧。要发给机器人好友列表里的某个人，就给 target 填 QQ 号或备注/昵称；不填 = 主人。主人说「邀请我远程协助 / 让我控制电脑」→ windows_remote_assist start：点「远程协助」右侧箭头，再点「邀请对方远程协助」，等对方在 QQ 里接受；target 同上。')
      lines.push('【本次设置】远程协助会把键鼠控制权交给主人，必须先打开「允许键鼠模拟」；共享屏幕不需要键鼠开关。')
      return lines.join('\n')
    })

    // ================= 工具面（只认主人会话，群友同轮也不借权）=================
    function ownerToolCall(ctx) {
      const sid = ctx?.agent?.session?.id || ctx?.session?.id || ctx?.sessionId || ''
      const hub = api.core?.hub
      if (!sid || typeof hub?.turnSendersAllOwner !== 'function') return false
      try { return hub.turnSendersAllOwner(sid) === true } catch { return false }
    }
    const notOwnerMsg = () => ({ ok: false, message: '逛电脑的工具只在主人会话里可用（群友/别人的会话不能操作这台电脑）。' })
    /** 工具当前聊天必须是主人私聊（共享/协助都在这个会话里发生）。 */
    function ownerPrivate(toolCtx) {
      const chat = toolCtx?.chat || {}
      const oq = ownerQQ()
      if (chat.kind !== 'private') return { ok: false, message: 'QQ 屏幕共享/远程协助只在主人私聊里发起，群里不行' }
      if (oq && String(chat.userId || '') && String(chat.userId) !== oq) return { ok: false, message: '当前私聊不是主人 QQ，拒绝发起共享/协助' }
      return { ok: true }
    }
    function locateHint() {
      return getSettings().preferUia
        ? '优先用 uia.tree 读无障碍树再按元素操作（uia.click / uia.setValue / uia.invoke 按选择器精确定位），坐标点击（mouse.*）仅作兜底。'
        : '本次设置已关闭元素定位优先：按坐标操作（先 screenshot 看清位置，再 mouse.move / mouse.click）。'
    }

    api.tool((toolCtx) => [
      api.defineTool({
        name: 'windows_ops',
        description: '操作主人这台 Windows 电脑：读无障碍树（UIA）并按元素点击/写值/读文本/触发表单、读/写剪贴板、全屏截图、枚举/激活/关闭窗口、移动/点击鼠标、键入文字、按键。'
          + locateHint()
          + '只在主人要求时用；第一次用某类操作前先用 windows_ops_guide 取对应手册。',
        properties: {
          op: { type: 'string', description: `操作 id，可选：${Object.keys(OPS).join(' / ')}` },
          text: { type: 'string', description: '文本（clipboard.write / key.text 写内容；uia.setValue 要写进控件的值）' },
          pid: { type: 'number', description: '目标窗口进程号（window.activate / window.close / 全部 uia.* 用），从 window.list 取' },
          sel: { type: 'string', description: 'UIA 选择器（uia.* 用）：「键=值&&键=值」，键只能是 AutomationId / Name / ControlType / ClassName，值按前缀匹配、不支持通配。例：AutomationId=submitBtn、Name=提交&&ControlType=Button。不知道元素叫什么先用 uia.tree 看' },
          x: { type: 'number', description: '屏幕横坐标（mouse.move / mouse.click 用）' },
          y: { type: 'number', description: '屏幕纵坐标（mouse.move / mouse.click 用）' },
          button: { type: 'string', description: 'mouse.click 的键：left（默认）/ right' },
          key: { type: 'string', description: 'key.press 的键名：enter/tab/esc/space/backspace/delete/up/down/left/right/home/end/pageup/pagedown/f1..f12' },
        },
        required: ['op'],
        execute: async (args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          return exec(String(args.op || ''), args)
        },
      }),
      api.defineTool({
        name: 'windows_ops_status',
        description: '看逛电脑现在能用什么：总开关/键鼠开关/待确认的危险操作/可用操作清单/QQ 原生共享与协助状态。主人问「你能不能操作我的电脑」时先看这个。',
        properties: {},
        execute: async (_args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const st = status()
          const confirms = st.confirms.length
            ? '\n待确认：' + st.confirms.map((c) => `${c.op}（${c.summary}）尾号 ${c.id.slice(-6)}`).join('、')
            : ''
          return {
            ok: true,
            message: `总开关${st.enabled ? '开' : '关'}，键鼠模拟${st.allowInput ? '开' : '关'}${st.dryRun ? '，试运行中' : ''}${confirms}`
              + `\nQQ 屏幕共享：${st.share.pending ? `待确认（${st.share.pending.id}）` : st.share.active ? '共享中' : '未共享'}；远程协助：${st.assist.pending ? `待确认（${st.assist.pending.id}）` : st.assist.active ? '邀请已发出' : '未邀请'}`
              + `\n可用操作：${st.ops.join(' / ')}`,
          }
        },
      }),
      api.defineTool({
        name: 'windows_ops_guide',
        description: '取逛电脑的操作手册（怎么稳妥地用某类操作）。UIA 元素操作/键鼠/窗口/剪贴板/截屏/通用各一份；第一次执行某类操作、或动作失败重试前取一份看。',
        properties: { op: { type: 'string', description: '按要做的操作取手册：如 uia.tree / uia.click / uia.setValue / mouse.click / window.close / clipboard.read / screenshot；不认识回通用手册' } },
        required: ['op'],
        execute: async ({ op }, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const key = guides.resolve({ op: String(op || '') })
          return { ok: true, message: guides.get(key) }
        },
      }),
      // ---- v1.3.1：QQ 原生屏幕共享（机器人客户端）----
      api.defineTool({
        name: 'windows_share_screen',
        description: '让机器人通过它自己的 QQ 客户端，向主人或指定好友发起 QQ 原生「屏幕共享」（不是截图发帧）。'
          + 'start：先把当前屏幕截图发到主人私聊，主人回复「确认」后才在机器人 QQ 里点「屏幕共享」→ 选「桌面」→「确定」；stop：点 QQ 的「停止共享」；status：看是否共享中、待确认或还剩多久自动停。'
          + 'target 可选：机器人好友列表里的 QQ 号或备注/昵称；不填 = 主人。',
        properties: {
          action: { type: 'string', description: 'start 开始 / stop 停止 / status 看状态' },
          target: { type: 'string', description: '可选：目标好友的 QQ 号或备注/昵称；不填就是主人' },
        },
        required: ['action'],
        execute: async (args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const gate = ownerPrivate(toolCtx)
          if (!gate.ok) return gate
          const action = String(args.action || 'status').toLowerCase()
          if (action === 'status') {
            const st = shareStatus()
            if (st.pending) {
              return { ok: true, message: `待主人确认：已把发起前截图发给主人，确认码 ${st.pending.id}；回复「确认」后才会真正共享（${st.pending.target.name}）` }
            }
            return {
              ok: true,
              message: st.active
                ? `QQ 屏幕共享中（原生），开始于 ${new Date(st.startedAt).toLocaleTimeString()}${st.remainingMs == null ? '' : `，约 ${Math.max(0, Math.ceil(st.remainingMs / 60000))} 分钟后自动停止`}`
                : `现在没有在共享屏幕。${qqLastMessage ? '上次：' + qqLastMessage : ''}`,
            }
          }
          if (action === 'stop') {
            const r = await runQq('qq.shareStop')
            return { ok: r.ok, message: r.message }
          }
          if (action === 'start') {
            const r = await runQq('qq.share', { target: String(args.target || '') })
            return { ok: r.ok, message: r.message }
          }
          return { ok: false, message: 'action 只能是 start / stop / status' }
        },
      }),
      // ---- v1.3.1：QQ 原生「邀请对方远程协助」----
      api.defineTool({
        name: 'windows_remote_assist',
        description: '让机器人通过它自己的 QQ 客户端，向主人或指定好友发 QQ 原生「邀请对方远程协助」：对方在 QQ 里点接受后，就能直接看这台电脑的屏幕并操作鼠标键盘。'
          + 'start：先把当前屏幕截图发到主人私聊，主人回复「确认」后才点「远程协助」右侧箭头 →「邀请对方远程协助」；stop：尝试点 QQ 里的停止/取消按钮；status：看邀请/待确认状态。需要先打开「允许键鼠模拟」。'
          + 'target 可选：机器人好友列表里的 QQ 号或备注/昵称；不填 = 主人。',
        properties: {
          action: { type: 'string', description: 'start 发邀请 / stop 取消 / status 看状态' },
          target: { type: 'string', description: '可选：目标好友的 QQ 号或备注/昵称；不填就是主人' },
        },
        required: ['action'],
        execute: async (args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const gate = ownerPrivate(toolCtx)
          if (!gate.ok) return gate
          const action = String(args.action || 'status').toLowerCase()
          if (action === 'status') {
            const st = assistStatus()
            if (st.pending) {
              return { ok: true, message: `待主人确认：已把发起前截图发给主人，确认码 ${st.pending.id}；回复「确认」后才会发出远程协助邀请（${st.pending.target.name}）` }
            }
            return {
              ok: true,
              message: st.active
                ? `QQ 远程协助邀请已发出（${new Date(st.startedAt).toLocaleTimeString()}），等对方在 QQ 里点接受。${st.lastMessage || ''}`
                : `现在没有发出中的远程协助邀请。${qqLastMessage ? '上次：' + qqLastMessage : ''}`,
            }
          }
          if (action === 'stop') {
            const r = await runQq('qq.assistStop')
            return { ok: r.ok, message: r.message }
          }
          if (action === 'start') {
            const r = await runQq('qq.assist', { target: String(args.target || '') })
            return { ok: r.ok, message: r.message }
          }
          return { ok: false, message: 'action 只能是 start / stop / status' }
        },
      }),
    ])

    // ================= /wops 命令（框架只认主人）=================
    api.command({
      name: 'wops',
      desc: '逛电脑：ops / status / shot / qq / share [QQ号或备注|开始|停止|状态] / assist [QQ号或备注|开始|停止|状态] / confirm 批准|拒绝 <尾号>（share/assist 发起后会先发截图给主人，回复「确认」才真正发起；也可 /wops confirm 批准 <确认码>）',
      async run(arg, msg) {
        const [verb, ...rest] = arg.trim().split(/\s+/)
        const ownerHint = String(msg?.nickname || '').trim()
        try {
          switch (verb) {
            case 'ops': {
              const lines = Object.entries(OPS).map(([k, m]) => `${k}｜${m.label}｜${m.danger === 'safe' ? '安全' : m.danger === 'input' ? '键鼠（要开开关）' : '危险（要确认）'}`)
              const wl = getSettings().opsWhitelist
              return lines.join('\n') + (wl.length ? `\n当前白名单：${wl.join('、')}` : '\n白名单未设置 = 按上面的开关规则放行')
            }
            case 'status':
              return JSON.stringify(status(), null, 2)
            case 'shot': {
              const r = await exec('screenshot', {})
              return r.message
            }
            case 'qq': {
              const r = await ops.run('qq.windows', {})
              return r.message
            }
            // ---- v1.3.1：/wops share [QQ号/备注] —— 机器人 QQ 原生屏幕共享 ----
            case 'share': {
              const sub = String(rest[0] || '').toLowerCase()
              if (sub === 'stop' || sub === '停止') {
                const r = await runQq('qq.shareStop', { ownerHint })
                return r.message
              }
              if (sub === 'status' || sub === '状态') {
                const st = shareStatus()
                if (st.pending) return `待主人确认：已把发起前截图发给主人（${st.pending.target.name}），确认码 ${st.pending.id}；回复「确认」后才发起。`
                return st.active
                  ? `QQ 屏幕共享中（原生）${st.remainingMs == null ? '' : `，约 ${Math.max(0, Math.ceil(st.remainingMs / 60000))} 分钟后自动停止`}`
                  : `现在没有在共享屏幕。${qqLastMessage || ''}`
              }
              if (msg?.kind !== 'private') return '共享屏幕只由主人在私聊里发起，群里不行。'
              if (!getSettings().enabled) return '逛电脑总开关没开：先到面板打开「总开关」'
              const target = (sub === 'start' || sub === '开始' || sub === '') ? '' : rest.join(' ').trim()
              const r = await runQq('qq.share', { ownerHint, target })
              return r.message + (target ? `（目标：${target}）` : '')
            }
            // ---- v1.3.1：/wops assist [QQ号/备注] —— QQ 原生「邀请对方远程协助」 ----
            case 'assist': {
              const sub = String(rest[0] || '').toLowerCase()
              if (sub === 'stop' || sub === '停止') {
                const r = await runQq('qq.assistStop', { ownerHint })
                return r.message
              }
              if (sub === 'status' || sub === '状态') {
                const st = assistStatus()
                if (st.pending) return `待主人确认：已把发起前截图发给主人（${st.pending.target.name}），确认码 ${st.pending.id}；回复「确认」后才发邀请。`
                return st.active
                  ? `QQ 远程协助邀请已发出，等对方在 QQ 里接受。${qqLastMessage || ''}`
                  : `现在没有发出中的远程协助邀请。${qqLastMessage || ''}`
              }
              if (msg?.kind !== 'private') return '远程协助邀请只由主人在私聊里发起，群里不行。'
              if (!getSettings().enabled) return '逛电脑总开关没开：先到面板打开「总开关」'
              const target = (sub === 'start' || sub === '开始' || sub === '') ? '' : rest.join(' ').trim()
              const r = await runQq('qq.assist', { ownerHint, target })
              return r.message + (target ? `（目标：${target}）` : '')
            }
            case 'confirm': {
              const [sub, tail] = rest
              const pending = qqPending
              const pendingId = String(tail || '').trim().toUpperCase()
              if (pending && (sub === '批准' || sub === 'approve' || sub === '确认') && (!pendingId || pending.id === pendingId)) {
                if (msg?.kind !== 'private') return 'QQ 发起前确认只由主人在私聊里确认，群里不行。'
                dropPending()
                const r = await executeQqOp(pending.op, pending.n, pending.t, { confirmed: true })
                return r.ok ? `已发起：${r.message}` : `发起失败：${r.message}`
              }
              if (pending && (sub === '拒绝' || sub === 'reject' || sub === '取消') && (!pendingId || pending.id === pendingId)) {
                if (msg?.kind !== 'private') return 'QQ 发起前确认只由主人在私聊里确认，群里不行。'
                dropPending()
                return `已取消：${pending.op === 'qq.assist' ? '远程协助邀请' : '屏幕共享'}没有发起。`
              }
              const list = safety.listConfirms()
              if (!sub || sub === 'list') {
                const lines = []
                if (pending) lines.push(`0. QQ 发起前确认：${pending.t.name}（${pending.t.qq}），确认码 ${pending.id}；回复「确认」或 /wops confirm 批准 ${pending.id}`)
                if (list.length) lines.push(...list.map((c, i) => `${i + 1}. ${c.op}（${c.summary}）尾号 ${c.id.slice(-6)}`))
                return lines.length ? lines.join('\n') : '没有待确认的危险操作。'
              }
              const item = list.find((c) => c.id.endsWith(String(tail || '')))
              if (!item) return '尾号不对，先发 /wops confirm 看列表。'
              if (sub === '批准' || sub === 'approve') {
                safety.approveConfirm(item.id)
                safety.log('confirm', `批准 ${item.op} ${item.summary}`).catch(() => {})
                return `已批准：${item.op}（${item.summary}）。下一次同动作直接放行。`
              }
              if (sub === '拒绝' || sub === 'reject') {
                safety.rejectConfirm(item.id)
                return `已拒绝：${item.op}（${item.summary}）`
              }
              return '用法：/wops confirm [批准|拒绝 <尾号>]（QQ 发起前确认也可用 /wops confirm 批准 <确认码>）'
            }
            case '':
              return '用法：/wops ops|status|shot|qq|share [QQ号或备注|开始|停止|状态]|assist [QQ号或备注|开始|停止|状态]|confirm ...'
            default:
              return `未知子命令 ${verb}`
          }
        } catch (e) {
          return `出错了：${e.message}`
        }
      },
    })

    // ================= 面板路由（精确匹配；/screenshot 回 PNG 二进制）=================
    api.route('/screenshot', async (req, res) => {
      if (!getSettings().enabled) return { ok: false, error: '总开关没开' }
      try {
        const r = await exec('screenshot', {})
        if (!r.ok) return { ok: false, error: r.message }
        const file = String(r.data || '')
        if (!file.startsWith(dataDir()) || !existsSync(file)) return { ok: false, error: '截图文件不在数据目录，拒绝读取' }
        return api.core.http.send(res, 200, readFileSync(file), 'image/png')
      } catch (e) {
        return { ok: false, error: e.message }
      }
    }, { access: 'panel' })
    api.route('/status', async () => {
      const st = status()
      return { ...st, confirms: st.confirms.map((c) => ({ id: c.id.slice(-6), op: c.op, summary: c.summary, at: c.at })) }
    }, { access: 'panel' })
    api.route('/ops', async () => {
      const s = getSettings()
      return { ok: true, ops: Object.entries(OPS).map(([id, m]) => ({ id, label: m.label, danger: m.danger })), whitelist: s.opsWhitelist }
    }, { access: 'panel' })
    api.route('/confirm', async (req) => {
      if (req.method === 'GET') return { ok: true, confirms: safety.listConfirms().map((c) => ({ id: c.id.slice(-6), op: c.op, summary: c.summary, at: c.at })) }
      if (req.method !== 'POST') return { ok: false, error: '只支持 POST' }
      const body = await api.core.http.body(req).catch(() => ({}))
      const list = safety.listConfirms()
      const item = list.find((c) => c.id.endsWith(String(body.id || '')))
      if (!item) return { ok: false, error: '没有这个待确认项' }
      if (body.approve) { safety.approveConfirm(item.id); safety.log('confirm', `批准 ${item.op} ${item.summary}`).catch(() => {}); return { ok: true } }
      if (body.reject) { safety.rejectConfirm(item.id); return { ok: true } }
      return { ok: false, error: '需要 { approve|reject, id }' }
    }, { access: 'panel' })
    // ---- v1.3.1：QQ 原生屏幕共享（GET 状态 / POST start|stop）----
    api.route('/share', async (req) => {
      if (req.method === 'GET') return { ok: true, ...shareStatus() }
      if (req.method !== 'POST') return { ok: false, error: '只支持 GET/POST' }
      const body = await api.core.http.body(req).catch(() => ({}))
      const action = String(body.action || 'status')
      if (action === 'stop') {
        const r = await runQq('qq.shareStop')
        return { ok: r.ok, message: r.message, error: r.ok ? undefined : r.message, ...shareStatus() }
      }
      if (action === 'start') {
        if (!getSettings().enabled) return { ok: false, error: '总开关没开：先打开「总开关」再共享屏幕' }
        const r = await runQq('qq.share', { target: String(body.target || '') })
        return { ok: r.ok, message: r.message, error: r.ok ? undefined : r.message, ...shareStatus() }
      }
      return { ok: true, ...shareStatus() }
    }, { access: 'panel' })
    // ---- v1.3.1：QQ 原生远程协助（GET 状态 / POST start|stop）----
    api.route('/assist', async (req) => {
      if (req.method === 'GET') return { ok: true, ...assistStatus() }
      if (req.method !== 'POST') return { ok: false, error: '只支持 GET/POST' }
      const body = await api.core.http.body(req).catch(() => ({}))
      const action = String(body.action || 'status')
      if (action === 'stop') {
        const r = await runQq('qq.assistStop')
        return { ok: r.ok, message: r.message, error: r.ok ? undefined : r.message, ...assistStatus() }
      }
      if (action === 'start') {
        if (!getSettings().enabled) return { ok: false, error: '总开关没开：先打开「总开关」再发远程协助邀请' }
        const r = await runQq('qq.assist', { target: String(body.target || '') })
        return { ok: r.ok, message: r.message, error: r.ok ? undefined : r.message, ...assistStatus() }
      }
      return { ok: true, ...assistStatus() }
    }, { access: 'panel' })
    // 诊断：列出机器人/主人 QQ 窗口（按机器人 QQ 号识别，输出里带账号）
    api.route('/qq', async () => {
      const r = await ops.run('qq.windows', {})
      return { ok: r.ok, message: r.message, windows: r.data || [] }
    }, { access: 'panel' })

    // ---- 指引提示词库：面板查看/编辑自定义指引（路由形态对齐 phone /guides）----
    api.route('/guides', async (req) => {
      if (req.method === 'GET') return { guides: guides.list() }
      if (req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        try {
          if (body.reset) return { ok: guides.remove(String(body.key || '')) }
          if (body.del) {
            const k = String(body.key || '')
            if (k === 'main' || k === 'generic') return { ok: false, error: '总纲与通用手册不可删除，只能还原成内置版' }
            return { ok: guides.remove(k) }
          }
          const g = guides.upsert(String(body.key || ''), { name: body.name, text: body.text })
          return { ok: true, guide: { key: g.key, name: g.name, source: 'custom' } }
        } catch (e) { return { ok: false, error: e.message } }
      }
      return { ok: false }
    }, { access: 'panel' })

    /** 导出的状态（工具/命令/路由共用）。 */
    function status() {
      const s = getSettings()
      return {
        enabled: s.enabled,
        allowInput: s.allowInput,
        dryRun: s.dryRun,
        rateLimit: s.rateLimit,
        whitelist: s.opsWhitelist,
        preferUia: s.preferUia,
        confirms: safety.listConfirms(),
        ops: Object.keys(OPS),
        guides: guides.list().map((g) => ({ key: g.key, name: g.name, source: g.source })),
        platform: process.platform,
        qq: qq.status(),
        share: shareStatus(),
        assist: assistStatus(),
      }
    }

    // 模块停下：撤掉还没确认的发起前截图，尽量把机器人客户端里还开着的共享/协助停掉（异步，失败不阻塞卸载）
    api.onDispose(() => {
      dropPending()
      Promise.resolve().then(async () => {
        try {
          const n = await resolveNames()
          if (!n.botName || !n.ownerName) return
          const s = getSettings()
          const args = { hwnd: s.qqWindowHwnd, botName: n.botName, ownerName: n.ownerName, botQQ: n.botQQ, ownerQQ: n.ownerQQ }
          if (shareStartedAt) await ops.run('qq.shareStop', args).catch(() => {})
          if (assistStartedAt) await ops.run('qq.assistStop', args).catch(() => {})
        } catch { /* 卸载失败不影响框架 */ }
      })
    })

    return {
      run: (op, args) => ops.run(op, args),
      exec,
      status,
      guides,
      OPS,
      confirm: { list: () => safety.listConfirms(), approve: (id) => safety.approveConfirm(id), reject: (id) => safety.rejectConfirm(id) },
      qq,
      share: { status: shareStatus, start: () => runQq('qq.share'), stop: () => runQq('qq.shareStop') },
      assist: { status: assistStatus, start: () => runQq('qq.assist'), stop: () => runQq('qq.assistStop') },
    }
  },
}
