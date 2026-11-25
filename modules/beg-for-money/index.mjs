// 讨饭（Aurabot 用户扩展）
//
// 移植自 MaiBot 插件 maibot-beg-for-money（作者 Lbcheng1145，MIT）：
// 群友提到钱时发收款码，收到打赏记进本地账本，记账要管理员点头，确认后在原群道谢。
//
// ## 四件事
//
// 1. 讨饭 —— `beg_for_money` 工具 / `/讨饭` 命令，发一张收款码。
// 2. 道谢 —— 讨饭后开一个窗口，窗口内有人说「打了」「转了」，或手动 `/已打钱`，
//    让她按人格生成一句感谢，发回原群。
// 3. 记账 —— `record_payment` 工具 / `/打赏 15` 命令，写进本地 JSON 账本。
//    群友触发的先挂成待确认记录并私聊管理员，管理员回 `/确认` 才真正记账。
// 4. 查账 —— `check_ledger` 工具 / `/收款` 命令，查今天、最近几天、指定日期或累计。
//
// ## 记账为什么要过一道审批
//
// 群友嘴上说「我转了 15」不代表真转了 —— 个人收款码没有到账回调，账本是纯手工
// 维护的，记错了只能改文件。所以群友触发的记账先挂成待确认（approvals.json），
// 私聊管理员，确认后才写账本。管理员自己触发的不用这道手续。
//
// ## 和参考插件的差异（都在 README 里写了）
//
//   · 收款码直接发图片（api.sendImage），不再发合并转发 —— Aurabot 没有 send.forward；
//   · 道谢用 api.ask 带上人格问一次（不建会话），参考插件的 maisaka.proactive.trigger 在这里没有对应能力；
//   · Aurabot 的 api.command 只认主人，群友的 /讨饭、/打赏、/收款 由 message 事件接管；
//   · 记账生效后，若装了印象卡片，就给打赏的人加一点「慷慨」（没装就静默跳过）。
//
// 数据都放 api.dataDir：ledger.json（账本）+ approvals.json（待确认）。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  CURRENCY_FALLBACK, formatLedgerBrief, formatLedgerLines, formatMoney, isoDay,
  createLedger, summarizeLedger,
} from './lib/ledger.mjs'
import { checkAmount, extractAmount, isPaymentClaim, sanitizeApprovals } from './lib/detect.mjs'

const VERSION = '1.0.1'
const DEFAULT_THANKS = '有人打了钱过来，去谢谢人家，别太肉麻，一两句就够'
const DEFAULT_FALLBACK = '谢谢你呀，收到了，我记着了。'
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
/** 待确认列表里最多列这么多条；再多在私聊里也刷屏。 */
const PENDING_LIMIT = 20
/** 待确认记录里备注最多留这么长。 */
const NOTE_LIMIT = 40
/** 道谢最小间隔：窗口内最多每 30 秒真的问一次模型，连发「已打钱」不会刷额度。 */
const THANKS_MIN_INTERVAL_MS = 30_000
/** api.ask 没有内建超时，挂死会把整个聊天永久卡在「正在道谢」。 */
const ASK_TIMEOUT_MS = 8000
/** message / activity 是同一条消息的两条通道：同一句在 10 秒内只算一次。 */
const THANKS_DEDUPE_MS = 10_000
/** 收款码游标按聊天记：6 小时没动就清掉，超过 200 个再按最旧淘汰。 */
const QR_CURSOR_TTL_MS = 6 * 3600 * 1000
const QR_CURSOR_LIMIT = 200

/** 给任意 Promise 加一个超时；超时按失败处理，调用方决定要不要兜底。 */
function withTimeout (promise, ms, label) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label || '等待超时')), Math.max(1, Number(ms) || 1))
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

function boundedNumber (value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function splitList (raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function groupDisplayName (chatId) {
  const id = String(chatId || '')
  if (id.startsWith('group:')) return '群 ' + id.slice(6)
  if (id.startsWith('private:')) return '私聊'
  return '当前会话'
}

const isGroupChat = (chatId) => String(chatId || '').startsWith('group:')

/** 原子写 JSON：先写同目录临时文件，再 rename 换上去。返回是否写成功。 */
function writeJsonAtomic (file, payload, log) {
  if (!file) return false
  // 临时文件名要唯一：热重载时新旧实例可能短暂并存，共用固定名会互相踩
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (error) {
    try { unlinkSync(tmp) } catch (e) {}
    if (log) log.error('写盘失败：' + (error && error.message ? error.message : error))
    return false
  }
}

export default {
  id: 'beg-for-money',
  name: '讨饭',
  version: VERSION,
  api: 1,
  description: '群友提到打钱时伸手要饭并发收款码，记账要管理员私聊确认，确认后在原群道谢（有印象卡片时加「慷慨」）',
  panel: 'panel.js',
  // 不写 group / __panelGroup：宿主不读这两个字段，用户模块的落点由导航逻辑决定
  // （本模块会落在「系统」组）。总开关是普通设置项，在模块设置表单里。

  defaults: {
    // enabled 留在 defaults 里：宿主用它记录模块开关，设置表单里也能改。
    enabled: true,
    qrImagePath: '',
    senderName: '大肥鱼',
    cooldownSeconds: 600,
    dailyLimit: 3,
    thanksWindowSeconds: 600,
    thankIntent: DEFAULT_THANKS,
    adminOnly: false,
    adminQQ: '',
    ledgerEnabled: true,
    currency: CURRENCY_FALLBACK,
    recentDays: 7,
    requireApproval: true,
    approvalTimeoutSeconds: 1800,
    approvalThrottleSeconds: 30,
    maxAmount: 10000,
    linkImpressionCard: true,
    generosityDimension: 'generosity',
    generosityDelta: 1,
    thankFallbackText: DEFAULT_FALLBACK,
  },

  settings: [
    // 总开关就是普通设置项：面板标题栏没有开关控件，用户在这里改、保存后生效。
    { key: 'enabled', label: '总开关', type: 'switch', hint: '关掉后命令、工具、面板接口都停，账本和待确认记录保留' },
    { key: 'qrImagePath', label: '收款码图片', type: 'textarea', hint: '一行一个路径，可以放多张（微信 / 支付宝各一张），按顺序轮着发。相对路径按扩展目录解析，也可以填绝对路径（带空格、带引号都能认）。留空或全都找不到时讨饭不可用' },
    { key: 'senderName', label: '署名', type: 'text', hint: '私聊管理员确认时显示的发送者昵称' },
    { key: 'cooldownSeconds', label: '冷却（秒）', type: 'number', min: 0, max: 86400, step: 60, hint: '同一个聊天两次讨饭的最小间隔，0 表示不冷却' },
    { key: 'dailyLimit', label: '每日上限', type: 'number', min: 0, max: 100, step: 1, hint: '每个聊天每天最多讨几次，0 表示不限' },
    { key: 'thanksWindowSeconds', label: '道谢窗口（秒）', type: 'number', min: 0, max: 86400, step: 60, hint: '讨饭后多久内有人说「打了」才触发道谢，0 关闭自动道谢' },
    { key: 'thankIntent', label: '道谢意图', type: 'textarea', hint: '不是固定话术，而是交给她按人格生成；改这里能换语气' },
    { key: 'adminOnly', label: '仅管理员用命令', type: 'switch', hint: '开启后 /讨饭、/已打钱、/收款 只给管理员；群里查账一律让她私聊说' },
    { key: 'adminQQ', label: '管理员 QQ', type: 'text', hint: '逗号或空格分隔；主人 QQ 自动算管理员' },
    { key: 'ledgerEnabled', label: '记账', type: 'switch', hint: '关掉后 /打赏 不记，/收款 也查不到' },
    { key: 'currency', label: '货币单位', type: 'text', hint: '默认「元」' },
    { key: 'recentDays', label: '默认最近几天', type: 'number', min: 1, max: 365, step: 1, hint: '/收款 不带范围时展示的天数' },
    { key: 'requireApproval', label: '记账要管理员确认', type: 'switch', hint: '开启后群友说的金额只挂成待确认，管理员私聊回 /确认 才落账；管理员自己记的直接生效' },
    { key: 'approvalTimeoutSeconds', label: '确认有效期（秒）', type: 'number', min: 60, max: 604800, step: 300, hint: '超时未确认就作废，免得几天前的记录突然被确认' },
    { key: 'approvalThrottleSeconds', label: '报批节流（秒）', type: 'number', min: 0, max: 3600, step: 10, hint: '同一个聊天多久内只报一次，防止连发把管理员私聊刷爆' },
    { key: 'maxAmount', label: '单笔上限', type: 'number', min: 1, max: 100000, step: 100, hint: '超过这个金额直接拒绝，防手滑' },
    { key: 'linkImpressionCard', label: '联动印象卡片', type: 'switch', hint: '记账生效后给打赏的人加一点「慷慨」；没装印象卡片时静默跳过' },
    { key: 'generosityDimension', label: '联动维度', type: 'text', hint: '默认 generosity（慷慨）；印象卡片改过维度 key 时填新的' },
    { key: 'generosityDelta', label: '联动加分', type: 'number', min: 0, max: 10, step: 0.5, hint: '每次记账生效加多少分，0 表示不加' },
    { key: 'thankFallbackText', label: '道谢兜底文案', type: 'textarea', hint: '模型生成失败时直接发这句，不要留空' },
  ],

  // dependencies 只给测试用（注入假的 think / now）；正常加载时 Aurabot 不会传。
  setup (api, dependencies = {}) {
    const log = api.log
    const nowMs = () => (typeof dependencies.now === 'function' ? dependencies.now() : Date.now())
    // 测试可以调小；正常加载没有 dependencies，固定 8 秒。
    const askTimeoutMs = Math.max(1, Number(dependencies.askTimeoutMs) || ASK_TIMEOUT_MS)
    let disposed = false
    api.onDispose(() => { disposed = true })

    /** 宿主的全局配置（试运行 / 总开关）。热重载和测试里可能没有，按默认放行。 */
    const hostCfg = () => {
      try { return api.config() || {} } catch (error) { return {} }
    }
    const isDryRun = () => hostCfg().dryRun === true
    const hostEnabled = () => hostCfg().enabled !== false

    // ---------- 设置 ----------

    /** 每次用的时候重新读：面板改完不用重载模块。 */
    function conf () {
      const s = api.settings()
      const ownerQQ = String(api.config().ownerQQ || '').trim()
      const admins = new Set(splitList(s.adminQQ).filter((x) => /^\d{4,}$/.test(x)))
      if (/^\d{4,}$/.test(ownerQQ)) admins.add(ownerQQ)
      return {
        enabled: s.enabled !== false,
        qrImagePath: String(s.qrImagePath || '').trim(),
        senderName: String(s.senderName || '').trim().slice(0, 20) || '大肥鱼',
        cooldownSeconds: Math.round(boundedNumber(s.cooldownSeconds, 600, 0, 86400)),
        dailyLimit: Math.round(boundedNumber(s.dailyLimit, 3, 0, 100)),
        thanksWindowSeconds: Math.round(boundedNumber(s.thanksWindowSeconds, 600, 0, 86400)),
        thankIntent: String(s.thankIntent || '').trim().slice(0, 400) || DEFAULT_THANKS,
        adminOnly: s.adminOnly === true,
        admins,
        ownerQQ,
        ledgerEnabled: s.ledgerEnabled !== false,
        currency: String(s.currency || '').trim().slice(0, 6) || CURRENCY_FALLBACK,
        recentDays: Math.round(boundedNumber(s.recentDays, 7, 1, 365)),
        requireApproval: s.requireApproval !== false,
        approvalTimeoutSeconds: Math.round(boundedNumber(s.approvalTimeoutSeconds, 1800, 60, 604800)),
        approvalThrottleSeconds: Math.round(boundedNumber(s.approvalThrottleSeconds, 30, 0, 3600)),
        maxAmount: boundedNumber(s.maxAmount, 10000, 0.01, 100000),
        linkImpressionCard: s.linkImpressionCard !== false,
        generosityDimension: String(s.generosityDimension || '').trim().slice(0, 32) || 'generosity',
        generosityDelta: boundedNumber(s.generosityDelta, 1, 0, 10),
        thankFallbackText: String(s.thankFallbackText || '').trim().slice(0, 300) || DEFAULT_FALLBACK,
      }
    }

    function isAdmin (userId) {
      const uid = String(userId || '').trim()
      return Boolean(uid) && conf().admins.has(uid)
    }

    // ---------- 账本 ----------

    const ledgerFile = api.dataDir('ledger.json')
    const approvalsFile = api.dataDir('approvals.json')
    const ledger = createLedger({ file: ledgerFile, log })
    const loaded = ledger.load()
    const startTotal = ledger.all().reduce((sum, row) => sum + Number(row.amount || 0), 0)
    log.info('讨饭账本已加载：' + loaded.count + ' 笔，累计 ' + formatMoney(startTotal, conf().currency) + '，文件=' + ledgerFile)

    // ---------- 待确认 ----------

    const approvals = new Map()
    let approvalSeq = 0
    // 和账本同一个口径：解析失败时坏文件改名留档，本次运行禁止写回。
    // 否则下一次 saveApprovals() 会用「空列表 + 新记录」覆盖掉历史待确认。
    let approvalsBroken = false

    /** 坏了就改名留档，绝不覆盖。 */
    function backupCorruptApprovals () {
      try {
        const to = approvalsFile + '.corrupt-' + Math.floor(Date.now() / 1000)
        renameSync(approvalsFile, to)
        log.error('坏待确认文件已备份为 ' + to + '，本次运行不写待确认记录，请修好后再重载模块')
      } catch (error) {
        log.error('坏待确认文件备份失败，为避免覆盖已停止写入：' + (error && error.message ? error.message : error))
      }
    }

    function loadApprovals () {
      approvals.clear()
      approvalSeq = 0
      approvalsBroken = false
      if (!existsSync(approvalsFile)) return 0
      try {
        const parsed = JSON.parse(readFileSync(approvalsFile, 'utf8').replace(/^\uFEFF/, ''))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('待确认文件里没有 { seq, items } 对象')
        if (parsed.items !== undefined && (!parsed.items || typeof parsed.items !== 'object' || Array.isArray(parsed.items))) {
          throw new Error('待确认文件里的 items 不是对象')
        }
        const clean = sanitizeApprovals(parsed)
        for (const [id, rec] of Object.entries(clean.items)) approvals.set(id, rec)
        approvalSeq = clean.seq
        if (clean.dropped) log.warn('待确认记录里有 ' + clean.dropped + ' 条格式不对，已丢弃')
      } catch (error) {
        approvalsBroken = true
        log.error('待确认记录读取失败，已停止写入：' + (error && error.message ? error.message : error))
        backupCorruptApprovals()
      }
      return approvals.size
    }

    function saveApprovals () {
      if (approvalsBroken) {
        log.error('待确认文件损坏已禁用写入，这次改动不会落盘')
        return false
      }
      const items = Object.fromEntries(approvals)
      return writeJsonAtomic(approvalsFile, { seq: approvalSeq, items }, log)
    }

    log.info('待确认记账已加载：' + loadApprovals() + ' 条，文件=' + approvalsFile)

    const state = {
      lastBeg: new Map(), // chatId → 上次讨饭的毫秒时间
      daily: new Map(), // chatId → { day, count }
      pendingThanks: new Map(), // chatId → 道谢窗口的到期毫秒时间
      thanksInflight: new Set(), // 正在道谢的聊天，防止同一条窗口触发两遍
      thanksTried: new Set(), // chatId：本窗口已经自动试过（失败也算），防双通道 / 连发刷模型
      lastThanksAt: new Map(), // chatId → 上次道谢尝试的毫秒时间，最小间隔用
      thanksSeen: new Map(), // 去重键 → { at }：message / activity 双通道只算一次
      lastApproval: new Map(), // chatId → 上次报批的毫秒时间
      qrCursor: new Map(), // chatId → { index, at }：多张收款码的下一张
    }
    // chatId → { uid, who, at }：这个聊天最后说话的人。只在 message / activity 里记，
    // 用来在群里给「打赏人」认人（模型传的 user_id 一律不采信）。
    const lastSpeaker = new Map()

    function rememberSpeaker (chatId, userId, nickname) {
      const id = String(chatId || '')
      const uid = String(userId || '')
      if (!id || !uid) return
      lastSpeaker.set(id, { uid, who: String(nickname || '').slice(0, 40), at: nowMs() })
      if (lastSpeaker.size > 200) {
        // 只留最近 6 小时的，别跟着聊天数一直长
        const cutoff = nowMs() - 6 * 3600 * 1000
        for (const [key, rec] of [...lastSpeaker]) if (rec.at < cutoff) lastSpeaker.delete(key)
      }
    }

    /** 关闭道谢窗口，顺手清掉这个窗口的限流痕迹。 */
    function closeThanksWindow (chatId) {
      const key = String(chatId || '')
      state.pendingThanks.delete(key)
      state.thanksTried.delete(key)
      state.lastThanksAt.delete(key)
    }

    function pruneState (now) {
      const c = conf()
      const today = isoDay(new Date(now))
      for (const [key, at] of [...state.lastBeg]) if (now - at >= c.cooldownSeconds * 1000) state.lastBeg.delete(key)
      for (const [key, rec] of [...state.daily]) if (rec.day !== today) state.daily.delete(key)
      for (const [key, until] of [...state.pendingThanks]) if (now > until) closeThanksWindow(key)
      // 窗口已经结束的标记顺手清掉（成功道谢时也会清，这里是兜底）
      for (const key of [...state.thanksTried]) if (!state.pendingThanks.has(key)) state.thanksTried.delete(key)
      for (const [key, at] of [...state.lastThanksAt]) if (now - at >= 10 * 60 * 1000) state.lastThanksAt.delete(key)
      for (const [key, rec] of [...state.thanksSeen]) if (now - rec.at >= THANKS_DEDUPE_MS) state.thanksSeen.delete(key)
      const throttle = Math.max(1, c.approvalThrottleSeconds) * 1000
      for (const [key, at] of [...state.lastApproval]) if (now - at >= throttle) state.lastApproval.delete(key)
      // 收款码游标也是按聊天长的：6 小时没动就清，超过上限再丢最旧的
      for (const [key, rec] of [...state.qrCursor]) if (now - Number(rec.at || 0) >= QR_CURSOR_TTL_MS) state.qrCursor.delete(key)
      if (state.qrCursor.size > QR_CURSOR_LIMIT) {
        const oldest = [...state.qrCursor].sort((a, b) => Number(a[1].at || 0) - Number(b[1].at || 0))
        for (const [key] of oldest.slice(0, state.qrCursor.size - QR_CURSOR_LIMIT)) state.qrCursor.delete(key)
      }
    }

    /** 丢掉超时的待确认。 */
    function purgeApprovals () {
      const ttl = conf().approvalTimeoutSeconds * 1000
      const now = nowMs()
      const stale = [...approvals.keys()].filter((id) => now - Number(approvals.get(id).created || 0) > ttl)
      for (const id of stale) approvals.delete(id)
      if (stale.length) {
        saveApprovals()
        log.info('清理超时待确认记录：' + stale.join('、'))
      }
      return stale.length > 0
    }

    // ---------- 收款码 ----------

    /**
     * 收款码路径列表：一行一个，去掉首尾空白和复制路径时带的引号。
     * 空行忽略 —— 用户常在末尾多敲一个回车。
     */
    function qrPathList () {
      return String(conf().qrImagePath || '')
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim())
        .filter(Boolean)
    }

    /** 一个路径 → 真实文件。返回 { ok, file?, reason? }。 */
    function resolveQrPath (raw) {
      // 扩展加载时整个文件夹被拍了一份快照，api.dir 指向快照；assets/qr.png 也会一起拍进去，
      // 所以相对路径先试快照，再试进程当前目录（用户可能填的是相对仓库根的路径）。
      const candidates = isAbsolute(raw) ? [raw] : [join(String(api.dir || ''), raw), resolve(raw)]
      for (const file of candidates) {
        try {
          if (!existsSync(file) || !statSync(file).isFile()) continue
          const ext = extname(file).toLowerCase()
          if (!IMAGE_EXT.has(ext)) return { ok: false, reason: '收款码要 png / jpg / gif / webp 图片：' + raw }
          if (statSync(file).size > 8 * 1024 * 1024) return { ok: false, reason: '这张收款码太大了（超过 8MB）：' + raw }
          return { ok: true, file }
        } catch (error) {
          // 权限之类的问题，试下一个候选
        }
      }
      return { ok: false, reason: '收款码图片找不到：' + raw }
    }

    /**
     * 解析全部收款码。支持多张（微信 / 支付宝各一张之类），一行一个路径。
     * 返回 { ok, files, missing } —— 部分坏了也照常发好的那些，全坏才算失败。
     */
    function resolveQrs () {
      const raw = qrPathList()
      if (!raw.length) return { ok: false, files: [], missing: [], reason: '还没配置收款码图片，发不了。' }
      const files = []
      const missing = []
      for (const path of raw) {
        const one = resolveQrPath(path)
        if (one.ok) files.push({ path, file: one.file })
        else missing.push(one.reason)
      }
      return {
        ok: files.length > 0,
        files,
        missing,
        // 有一张都没解析出来时用第一条原因；部分失败时由调用方拼提示
        reason: files.length ? '' : (missing[0] || '收款码图片找不到，发不了。'),
      }
    }

    // ---------- 道谢 ----------

    /**
     * 清理模型吐出来的话，只留「能直接发出去的文字 + <face:名字>」。
     *
     * 实测她会写出 `<img src="emoj表情:偷乐"/>` 这类 HTML，原样发出去群友看到的就是这串标签。
     * 所以：
     *   · 带 emoj表情 / emoji 名字的图片标签 → `<face:名字>`（网关认得就变成小黄脸，认不得由中枢丢掉）；
     *   · 其余 HTML 标签、markdown 图片、<sticker:> / <voice> / <poke> 一律去掉（sendText 不解析这些，
     *     留着只会原样显示）。
     */
    function sanitizeSayText (raw) {
      let text = String(raw === undefined || raw === null ? '' : raw)
      // 0) 先把 <face:…> 占住 —— 后面第 3 条会删掉所有 HTML 标签，不占住的话连它一起没了。
      //    这里不动两边的空格：原句怎么断的就怎么留。
      const faces = []
      text = text.replace(/<face:\s*([^>]{1,12}?)\s*>(?:\s*<\/face>)?/g, (m, name) => {
        faces.push(name)
        return '\u0000FACE' + (faces.length - 1) + '\u0000'
      })
      // 1) 表情图标 → <face:名字>。
      //    模型会写 <img src="emoj表情:偷乐"/>、src="emoj:偷乐"、src="emoji:偷乐" 几种；
      //    从 src 里取最后一个冒号后面的名字，所以 emoj/emoj表情/emoji 都能认。
      //    不吃掉前后的空格：原句怎么断的就怎么留，免得「挑时候 <表情>」变成「挑时候<表情>」。
      text = text.replace(/\s*<img\b[^>]*?src\s*=\s*["'][^"']*?[:：]\s*([^"'<>]{1,12}?)\s*["'][^>]*?\/?>\s*/gi, (m, name) => {
        const label = String(name).replace(/^(?:emoj表情|emoj|emoji|face)\s*[:：]?/i, '').trim()
        if (!label || /^(?:emoj表情|emoj|emoji)$/i.test(label)) return ''
        faces.push(label)
        return ' \u0000FACE' + (faces.length - 1) + '\u0000'
      })
      // 2) markdown 图片（模型偶尔会写 ![图](url)，发出去是一串符号）
      text = text.replace(/!\[[^\]]*\]\([^)\s]*\)/g, '')
      // 3) 其余 HTML 标签整个去掉
      text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '')
      // 4) 我们不解析的格式标签：命令通道用 sendText，原样发出去只会露出尖括号
      text = text.replace(/<sticker:[^>]*>(?:\s*<\/sticker>)?/g, '')
      text = text.replace(/<\/?voice>/g, '')
      text = text.replace(/<poke\s*\/?>/g, '')
      // 5) 收尾：连续空格压一个、行首行尾空白去掉
      text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
      // 6) 把占位的表情放回去
      text = text.replace(/\u0000FACE(\d+)\u0000/g, (m, i) => '<face:' + faces[Number(i)] + '>')
      return text.slice(0, 300)
    }

    /**
     * 让她自己说一句感谢，发回原来的聊天。成功才关窗口，失败留着让管理员/群友手动重试。
     * info：{ payerName, amount } —— 谁打的、打了多少，用来把场景说清楚。
     * 返回 { ok, text, delivered } —— text 是实际发出去的话，delivered 表示真的发出去了。
     */
    async function fireThanks (chatId, reason, info = {}) {
      const id = String(chatId || '').trim()
      if (!id) return { ok: false, text: '', delivered: false }
      // 同一个聊天同时只允许一次在途：窗口要等成功才清，这中间另一条「打了」
      // 也会通过判断，没有这个集合就会道谢两遍。
      if (state.thanksInflight.has(id)) return { ok: false, text: '', delivered: false, busy: true }
      const c = conf()
      const startedAt = nowMs()
      const last = state.lastThanksAt.get(id)
      if (last !== undefined && startedAt - last < THANKS_MIN_INTERVAL_MS) {
        const left = Math.max(1, Math.ceil((THANKS_MIN_INTERVAL_MS - (startedAt - last)) / 1000))
        return { ok: false, text: '', delivered: false, throttled: true, message: '刚试过，' + left + ' 秒后再试。' }
      }
      const cfg = hostCfg()
      const silent = cfg.enabled === false || cfg.dryRun === true
      // 无论成败，这轮窗口都算「已经试过」：自动通道不再重试，只有手动 /已打钱 能再来。
      state.thanksTried.add(id)
      state.lastThanksAt.set(id, startedAt)
      state.thanksInflight.add(id)
      let text = ''
      try {
        try {
          text = sanitizeSayText(await generateThanks(c, id, info))
        } catch (error) {
          log.warn('生成道谢失败：' + (error && error.message ? error.message : error))
        }
        // 模型没在道谢（反问、清空、只剩标签）就用兜底文案：
        // 宁可普通一点，也别让「已经道谢了」是句假话，更别把她一句「写啥啊」发到群里
        if (!text || looksLikeNonAnswer(text)) {
          if (text) log.info('道谢生成的不像话，改用兜底文案')
          text = sanitizeSayText(c.thankFallbackText) || DEFAULT_FALLBACK
        }
        let sent = null
        if (!silent) {
          try {
            sent = await api.sendText(id, text)
          } catch (error) {
            log.warn('道谢没发出去：' + (error && error.message ? error.message : error))
          }
        }
        const delivered = Boolean(sent)
        // 总开关关着 / 试运行时 sendSegments 返回 null：算模拟成功，但回执不能谎称真发了
        if (!sent && !silent) return { ok: false, text: '', delivered: false }
        closeThanksWindow(id)
        // 道谢原文不写日志：日志有可能被贴到外面去
        log.info('已道谢 chat=' + id + ' 原因=' + String(reason || '').slice(0, 40) + (delivered ? '' : '（试运行 / 总开关关着，没真发）'))
        return { ok: true, text, delivered }
      } finally {
        state.thanksInflight.delete(id)
      }
    }

    /**
     * 同一条消息会从 message 和 activity 两条通道各来一次。activity 没有 messageId，
     * 所以有 id 时按 id 去重，另外始终用「聊天 + 人 + 文本」做 10 秒兜底。
     */
    function thanksDedupeKeys (ev) {
      const chatId = String((ev && ev.chatId) || '')
      const uid = String((ev && ev.userId) || '')
      const text = String((ev && ev.text) || '').trim()
      const mid = String((ev && (ev.messageId || ev.seq)) || '')
      const keys = ['txt:' + chatId + ':' + uid + ':' + text]
      if (mid) keys.push('id:' + chatId + ':' + mid)
      return keys
    }

    function thanksSeenRecently (ev) {
      const now = nowMs()
      for (const key of thanksDedupeKeys(ev)) {
        const rec = state.thanksSeen.get(key)
        if (rec && now - rec.at < THANKS_DEDUPE_MS) return true
      }
      return false
    }

    function markThanksSeen (ev) {
      const now = nowMs()
      for (const key of thanksDedupeKeys(ev)) state.thanksSeen.set(key, { at: now })
      if (state.thanksSeen.size > 500) {
        for (const [key, rec] of [...state.thanksSeen]) if (now - rec.at >= THANKS_DEDUPE_MS) state.thanksSeen.delete(key)
        if (state.thanksSeen.size > 500) {
          const oldest = [...state.thanksSeen].sort((a, b) => a[1].at - b[1].at)
          for (const [key] of oldest.slice(0, state.thanksSeen.size - 500)) state.thanksSeen.delete(key)
        }
      }
    }

    /**
     * 窗口内的自动道谢：先同步占位（thanksTried），保证同一条消息的两条通道
     * 和窗口内后续几句「打了」都只触发一次；失败也不自动重试，只留手动 /已打钱。
     */
    function maybeAutoThanks (ev) {
      const chatId = String((ev && ev.chatId) || '')
      if (!chatId) return false
      if (state.thanksTried.has(chatId)) return false
      if (thanksSeenRecently(ev)) return false
      markThanksSeen(ev)
      const last = state.lastThanksAt.get(chatId)
      if (last !== undefined && nowMs() - last < THANKS_MIN_INTERVAL_MS) return false
      state.thanksTried.add(chatId)
      const info = {
        payer: String((ev && ev.userId) || ''),
        payerName: String((ev && ev.nickname) || ''),
        amount: extractAmount(ev && ev.text),
      }
      // 只读监听里不能 await：道谢丢后台跑，别卡住消息处理
      Promise.resolve().then(() =>
        fireThanks(chatId, '窗口内检测到打款说法', info)
      ).catch((error) => {
        log.warn('自动道谢失败：' + (error && error.message ? error.message : error))
      })
      return true
    }

    /**
     * 生成道谢。
     *
     * ⚠ 这里**不能**用 api.think：它走 hub.runSystemTurn，会在 DSH 里新建一个
     * `system:ext-beg-for-money` 会话（列表里凭空多出一个对话），还会占一个工作区。
     * 道谢只是一句短话，用 api.ask 问一次就行 —— 人格自己塞进 system 里，
     * 不建会话、不进记忆、不污染聊天。
     *
     * ⚠ 用户消息里必须把「发生了什么」写清楚。只写「写一句吧」会让模型反问
     * 「写啥啊，你倒是给个题」—— 它不知道自己被叫来干什么，人格再像也没用。
     */
    async function generateThanks (c, chatId, info) {
      const persona = readPersona()
      const who = String((info && info.payerName) || '').trim()
      const amount = Number(info && info.amount)
      const money = Number.isFinite(amount) && amount > 0 ? formatMoney(amount, c.currency) : ''
      // 交给模型的「场景」，写得越具体它越不会跑偏
      const scene = who && money
        ? '群友「' + who + '」刚给你打了 ' + money + '。'
        : who
          ? '群友「' + who + '」刚给你打了钱（没说具体多少）。'
          : money
            ? '刚才有人给你打了 ' + money + '。'
            : '刚才有人给你打了钱。'
      const system = [
        persona,
        '【现在这件事】你要在这条消息里真诚地道个谢：' + scene + '钱已经收到了。',
        '【怎么写】' + c.thankIntent,
        '只写你要发出去的那句话本身，一到两句，直接开口说，不要铺垫、不要引号、不要解释你在干什么。',
        '不要反问，也不要问「写什么」「给个题」「要我写啥」——你不是在接任务，你就是当场说这句话。',
        '不要提「讨饭」「道谢」「窗口」这些词，也不要提金额之外的任何系统信息。',
        '不要输出 HTML 或 <img> 标签；想带表情就写 <face:名字>，别的格式标签一律不要。',
        '当前聊天：' + groupDisplayName(chatId) + '。',
      ].filter(Boolean).join('\n')
      // 用户消息也要给足信息：只说「写一句吧」，模型只会回「写啥」
      const ask = scene + '在这个群里说一句谢谢吧，一两句就行。'
      if (typeof dependencies.generate === 'function') return String((await dependencies.generate(system, ask)) || '').trim()
      // api.ask 在核心里没有 timeout：模型挂死会把整个聊天永久卡在「正在道谢」。
      // 超时按失败处理，fireThanks 会改用 thankFallbackText 兜底。
      const reply = await withTimeout(api.ask({ system, text: ask, maxTokens: 220 }), askTimeoutMs, '生成道谢超时')
      return String(reply || '').trim()
    }

    /**
     * 模型没在道谢、而是在反问 / 讨论任务本身时，这句不能发出去。
     * 实测它回过「写啥啊，你倒是给个题。」「你想让我说什么？」——发到群里像她抽风。
     */
    function looksLikeNonAnswer (text) {
      const t = String(text || '').trim()
      if (!t) return true
      if (/(写啥|写什么|给个题|出个题|什么题|题目|要我写|你想让我|不知道怎么|该说些?什么|说什么好|怎么回|回什么)/.test(t)) return true
      // 整句就是一个反问：「说什么好？」「？」这种
      const isQuestion = /[?？]\s*$/.test(t)
      const hasThanks = /(谢|感谢|感激|谢谢)/.test(t)
      if (isQuestion && !hasThanks) return true
      return false
    }

    /** 当前人格文本。取不到就空串，道谢照样能生成（只是少点她自己的味道）。 */
    function readPersona () {
      try {
        const text = api.core && api.core.personas && typeof api.core.personas.current === 'function'
          ? api.core.personas.current()
          : ''
        return String(text || '').slice(0, 8000)
      } catch (error) {
        log.debug('读人格失败：' + (error && error.message ? error.message : error))
        return ''
      }
    }

    // ---------- 印象卡片联动（可选依赖） ----------

    /**
     * 给打赏的人加「慷慨」。
     * 印象卡片是**非强制**依赖：没装 / 没开 / 维度被改掉都只写 debug 日志，
     * 不影响记账、道谢和命令回执。
     */
    async function linkImpressionCard (entry, reason) {
      const c = conf()
      if (!c.linkImpressionCard || !(c.generosityDelta > 0)) return ''
      const payer = String(entry.payer || '').trim()
      if (!/^\d{4,}$/.test(payer)) {
        log.debug('这笔没有可用的 QQ 号，跳过印象卡片联动')
        return ''
      }
      let card = null
      try {
        card = api.use('impression-card')
      } catch (error) {
        card = null
      }
      if (!card || typeof card.adjust !== 'function') {
        log.debug('印象卡片没在跑，跳过「慷慨」联动')
        return ''
      }
      try {
        const out = await card.adjust('qq:' + payer, c.generosityDimension, c.generosityDelta, {
          reason: String(reason || ('打赏 ' + formatMoney(entry.amount, c.currency))).slice(0, 80),
          notify: false,
        })
        if (out && out.ok) {
          const label = out.label || '慷慨'
          log.info('已给 ' + payer + ' 加「' + label + '」' + out.delta)
          return '印象卡片「' + label + '」+' + out.delta
        }
        log.debug('印象卡片没加成：' + (out && out.message ? out.message : '没有返回结果'))
      } catch (error) {
        log.debug('印象卡片联动失败（不影响记账）：' + (error && error.message ? error.message : error))
      }
      return ''
    }

    // ---------- 记账 ----------

    /**
     * 记一笔并落账。
     * dryRun 是「不往外发消息」，账本是本地数据，照常记录；回执里会明确写「试运行」，
     * 不再声称「已在群里道谢」。
     */
    function writeEntry ({ amount, note, chatId, groupId, payer, payerName, source }) {
      if (!conf().ledgerEnabled) return { ok: false, message: '记账功能已关闭。' }
      if (ledger.broken) return { ok: false, message: '账本文件损坏已停止写入，先修好 ledger.json 再重载模块。' }
      const entry = ledger.record({ amount, note, chatId, groupId, payer, payerName, source })
      if (!entry) return { ok: false, message: '账本写不进去，这笔没记上。' }
      return { ok: true, entry }
    }

    /** 记账生效后的后处理：道谢（可选）+ 印象卡片「慷慨」（可选）。 */
    async function afterRecorded (entry, { sayThanks, reason } = {}) {
      const notes = []
      if (sayThanks) {
        const thanks = await fireThanks(entry.chatId, reason || '记账生效', { payerName: entry.payerName, amount: entry.amount })
        if (thanks.ok) notes.push(thanks.delivered ? '已在群里道谢' : '试运行：账本照常记录，道谢没有真发出去')
      }
      const linked = await linkImpressionCard(entry, reason)
      if (linked) notes.push(linked)
      return notes
    }

    async function recordPayment ({ amount, note, chatId, groupId, payer, payerName, source, byAdmin }) {
      const c = conf()
      if (!c.enabled) return { ok: false, message: '讨饭插件已关闭。' }
      if (!c.ledgerEnabled) return { ok: false, message: '记账功能已关闭。' }
      const checked = checkAmount(amount, c.maxAmount)
      if (!checked.ok) return { ok: false, message: checked.reason }

      // 群友触发 → 先问管理员；管理员自己触发就直接记
      if (c.requireApproval && !byAdmin) {
        if (!c.admins.size) return { ok: false, message: '还没配置管理员 QQ 号，记账审批用不了。' }
        if (approvalsBroken) return { ok: false, message: '待确认文件损坏已停止写入，先修好 approvals.json 再重载模块。' }
        const now = nowMs()
        const last = state.lastApproval.get(chatId)
        const throttleMs = c.approvalThrottleSeconds * 1000
        if (last !== undefined && throttleMs > 0 && now - last < throttleMs) {
          return { ok: false, message: '刚报过一笔，等管理员处理完再说。' }
        }
        state.lastApproval.set(chatId, now)
        const rec = await createApproval({ amount: checked.value, note, chatId, groupId, payer, payerName })
        if (!rec) {
          // 没建立成功，把节流标记退回去，别让一次失败也占节流
          state.lastApproval.delete(chatId)
          return { ok: false, message: '联系不上管理员（管理员可能还没私聊过机器人），这笔先记不了。' }
        }
        return {
          ok: true,
          pending: rec,
          message: isDryRun()
            ? '试运行：收到 ' + formatMoney(checked.value, c.currency) + ' 的说法（本地待确认，私聊不会真发出，编号 ' + rec.id + '）。'
            : '收到 ' + formatMoney(checked.value, c.currency) + ' 的说法，已经报给管理员了，等他点头才算数（编号 ' + rec.id + '）。',
        }
      }

      const written = writeEntry({ amount: checked.value, note, chatId, groupId, payer, payerName, source })
      if (!written.ok) return { ok: false, message: written.message }
      const view = summarizeLedger(ledger.all(), '今天', { todayISO: isoDay(), currency: c.currency, recentDays: c.recentDays })
      let message = '记下了 ' + formatMoney(checked.value, c.currency) + '，今天 ' + view.count + ' 笔共 ' + formatMoney(view.total, c.currency) + '。'
      const notes = await afterRecorded(written.entry, { sayThanks: true, reason: '记账 ' + formatMoney(checked.value, c.currency) })
      if (notes.length) message += ' ' + notes.join('，') + '。'
      log.info('讨饭收到记账：' + checked.value + ' ' + c.currency + '（' + String(source || '') + '）')
      return { ok: true, entry: written.entry, message }
    }

    // ---------- 待确认 ----------

    async function createApproval ({ amount, note, chatId, groupId, payer, payerName }) {
      if (approvalsBroken) return null
      purgeApprovals()
      const c = conf()
      approvalSeq += 1
      const rec = {
        id: String(approvalSeq),
        amount: Math.round(Number(amount) * 100) / 100,
        note: String(note || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, NOTE_LIMIT),
        chatId: String(chatId || ''),
        groupId: String(groupId || ''),
        groupName: groupDisplayName(chatId),
        payer: String(payer || ''),
        payerName: String(payerName || '').slice(0, 40),
        requester: String(payerName || payer || '有人').slice(0, 40),
        // 用墙上时间，不能用单调时钟：要跨重载 / 重启判断有效期
        created: nowMs(),
      }
      const lines = [
        '【记账确认 #' + rec.id + '】',
        rec.groupName + '里 ' + rec.requester + ' 说打了 ' + formatMoney(rec.amount, c.currency),
      ]
      if (rec.note) lines.push('备注：' + rec.note)
      // ⚠ 别写「/拒绝」：QQ 会把这个词转成表情，管理员收到的是图标，没法照做
      lines.push('回 /确认 ' + rec.id + ' 记账并在群里道谢')
      lines.push('回 /不记 ' + rec.id + ' 就忽略这笔')
      lines.push('（' + c.senderName + ' 发起的记账）')

      approvals.set(rec.id, rec)
      // 先登记落盘再私聊：管理员收到编号后可能立刻回 /确认，
      // 那一刻记录必须已经在内存和磁盘里。
      if (!saveApprovals()) {
        approvals.delete(rec.id)
        log.error('待确认记录落盘失败，编号 ' + rec.id + ' 作废')
        return null
      }
      if (!(await dmAdmins(lines.join('\n')))) {
        // 一个管理员都没送到：把刚登记的记录撤掉，别留个没人知道的编号
        approvals.delete(rec.id)
        saveApprovals()
        return null
      }
      log.info('记账待确认 #' + rec.id + '：' + rec.amount + c.currency + ' chat=' + rec.chatId)
      return rec
    }

    /** 私聊所有管理员。至少送到一个人就算成功。 */
    async function dmAdmins (text) {
      const ids = [...conf().admins]
      if (!ids.length) return false
      let delivered = 0
      // 试运行不真发私聊，但审批链要能继续跑：按「已经送到」处理，记录留在本地待确认。
      const dry = isDryRun()
      for (const uid of ids) {
        if (dry) { delivered += 1; continue }
        try {
          // sendText 发失败只返回 null / false，不抛异常；不判就会把「没送到」当「送到了」
          const ok = await api.sendText('private:' + uid, text)
          if (ok) delivered += 1
          else log.warn('私聊管理员 ' + uid + ' 没发出去')
        } catch (error) {
          log.warn('私聊管理员 ' + uid + ' 失败：' + (error && error.message ? error.message : error))
        }
      }
      return delivered > 0
    }

    function pickApproval (rawId) {
      purgeApprovals()
      const id = String(rawId || '').trim()
      if (id) return approvals.get(id) || null
      // 没给编号就取最近一条，管理员直接回 /确认 也能用
      const list = [...approvals.values()]
      if (!list.length) return null
      return list.sort((a, b) => b.created - a.created)[0]
    }

    /** 管理员确认 / 拒绝一条。返回 { ok, text }。 */
    async function resolveApproval (rawId, approve) {
      const c = conf()
      const rec = pickApproval(rawId)
      if (!rec) {
        const id = String(rawId || '').trim()
        return { ok: false, text: id ? '找不到编号 ' + id + ' 的待确认记录。' : '没有待确认的记账，或者都过期了。' }
      }
      if (!approve) {
        approvals.delete(rec.id)
        if (!saveApprovals()) {
          // 删不掉就先留在内存里，别让管理员以为已经处理完了
          approvals.set(rec.id, rec)
          return { ok: false, text: '待确认记录删不掉（写盘失败），这笔还在。' }
        }
        log.info('记账被拒 #' + rec.id)
        return { ok: true, text: '好，#' + rec.id + ' 那笔 ' + formatMoney(rec.amount, c.currency) + ' 不记了。' }
      }
      // 先落账再删待确认：账本写不进去的话，这条记录还得留着让管理员重试
      const written = writeEntry({
        amount: rec.amount, note: rec.note, chatId: rec.chatId, groupId: rec.groupId,
        payer: rec.payer, payerName: rec.payerName, source: '管理员确认',
      })
      if (!written.ok) return { ok: false, text: '账本写不进去，这笔还没记上：' + written.message + ' 待确认记录给你留着。' }

      approvals.delete(rec.id)
      if (!saveApprovals()) {
        // 审批记录没删掉：磁盘上它还在，重启后会被重新加载，管理员再点一次
        // 就会把同一笔记两遍。把刚记的这笔撤回去，保证两边一致。
        approvals.set(rec.id, rec)
        ledger.removeEntry(written.entry)
        log.error('删除待确认 #' + rec.id + ' 落盘失败，已回滚账本条目')
        return { ok: false, text: '待确认记录删不掉（写盘失败），这笔先不记，检查一下磁盘。' }
      }

      let text = '记上了 #' + rec.id + '（' + (rec.groupName || '当前会话') + '），' + formatMoney(rec.amount, c.currency) + '。'
      // 道谢要发回原来的群，不是管理员私聊。确认记账本身就意味着「他真的打了」，所以不用再等窗口
      const notes = await afterRecorded(written.entry, { sayThanks: true, reason: '确认记账 ' + formatMoney(rec.amount, c.currency) })
      if (notes.length) text += ' ' + notes.join('，') + '。'
      else text += ' 不过群里那句道谢没发出去，检查一下网关或者她的会话。'
      log.info('审批通过记账 #' + rec.id)
      return { ok: true, text, entry: written.entry }
    }

    // ---------- 查账 ----------

    function ledgerView (scope) {
      const c = conf()
      return summarizeLedger(ledger.all(), scope, { todayISO: isoDay(), currency: c.currency, recentDays: c.recentDays })
    }

    // ---------- 讨饭 ----------

    async function doBeg (chatId) {
      const c = conf()
      if (!c.enabled) return { ok: false, message: '讨饭功能已关闭。' }
      const target = String(chatId || '').trim()
      if (!target) return { ok: false, message: '拿不到当前聊天流，这次不发。' }
      const qr = resolveQrs()
      if (!qr.ok) {
        if (qrPathList().length) log.warn('收款码不可用：' + qr.reason)
        return { ok: false, message: qr.reason }
      }
      const now = nowMs()
      // 先清过期游标再读：否则 6 小时没动的聊天会先拿到旧 index，发送后才被 prune 掉。
      pruneState(now)
      // 配了好几张就轮着发：第一次发第一张，第二次第二张，避免每次都刷屏刷同样的图
      const cursorKey = target
      const cursor = state.qrCursor.get(cursorKey)
      const index = ((cursor && Number(cursor.index)) || 0) % qr.files.length
      const chosen = qr.files[index]
      const last = state.lastBeg.get(target)
      if (last !== undefined && now - last < c.cooldownSeconds * 1000) {
        const left = Math.ceil((c.cooldownSeconds * 1000 - (now - last)) / 1000)
        return { ok: false, message: '刚伸过手了，' + left + ' 秒内别再要。' }
      }
      const today = isoDay(new Date(now))
      const daily = state.daily.get(target)
      const count = daily && daily.day === today ? daily.count : 0
      if (c.dailyLimit > 0 && count >= c.dailyLimit) return { ok: false, message: '今天要够数了，明天再来。' }

      // 先占位再发送：从检查到写状态之间有一段 await，并发调用会同时通过上面的检查，
      // 结果两张收款码都发出去、计数却只加一次。占位放在第一个 await 之前就没有这个窗口。
      const prevLast = state.lastBeg.get(target)
      const prevDaily = state.daily.get(target)
      state.lastBeg.set(target, now)
      state.daily.set(target, { day: today, count: count + 1 })

      // 试运行 / 宿主总开关关着的时候 sendImage 返回 null 是预期行为：
      // 当成「模拟发送」，照常占冷却 / 每日额度 / 道谢窗口，不能回滚。
      const preview = isDryRun()
      const globalOff = !hostEnabled()
      const silent = preview || globalOff
      let sent = null
      if (!silent) {
        try {
          sent = await api.sendImage(target, chosen.file)
        } catch (error) {
          log.error('发送收款码失败：' + (error && error.message ? error.message : error))
          sent = null
        }
      }
      if (!sent && !silent) {
        // 发送失败：把占位退回去，别让一次失败白占冷却和每日额度
        if (prevLast === undefined) state.lastBeg.delete(target)
        else state.lastBeg.set(target, prevLast)
        if (prevDaily === undefined) state.daily.delete(target)
        else state.daily.set(target, prevDaily)
        return { ok: false, message: '收款码没发出去。' }
      }
      // 真发成功（或模拟成功）才推进到下一张
      if (qr.files.length > 1) state.qrCursor.set(cursorKey, { index: (index + 1) % qr.files.length, at: now })
      if (c.thanksWindowSeconds > 0) {
        // 新窗口从干净状态开始：上一笔无关的失败道谢（比如记账后网关抽风）
        // 不该把新窗口也标成「已试过」，否则这个窗口的自动道谢会被永久跳过。
        state.thanksTried.delete(target)
        state.lastThanksAt.delete(target)
        state.pendingThanks.set(target, now + c.thanksWindowSeconds * 1000)
      }
      pruneState(now)
      log.info('已发送收款码 chat=' + target + ' 今日第 ' + (count + 1) + ' 次' + (qr.files.length > 1 ? '（第 ' + (index + 1) + '/' + qr.files.length + ' 张）' : '') + (sent ? '' : '（未真发）'))
      const prefix = preview
        ? '试运行：收款码没有真发出去'
        : globalOff
          ? '插件总开关关着：收款码没有真发出去'
          : '已经伸手要过了，收款码发出去了'
      let message = prefix + '（今天第 ' + (count + 1) + ' 次）'
      // 部分图片没找到时顺口提一句，别让主人以为全都发了
      if (qr.missing.length) message += '，但另有 ' + qr.missing.length + ' 张找不到：' + qr.missing[0]
      return { ok: true, message: message + '。' }
    }

    // ---------- 命令上下文 ----------

    /** msg 里的群名只在群消息里才有意义；私聊不编群名。 */
    function commandContext (msg) {
      const chatId = String((msg && msg.chatId) || '')
      const groupId = String((msg && msg.groupId) || '')
      return {
        chatId,
        groupId,
        userId: String((msg && msg.userId) || ''),
        nickname: String((msg && msg.nickname) || ''),
        groupName: groupId ? '群 ' + groupId : groupDisplayName(chatId),
        isGroup: isGroupChat(chatId),
      }
    }

    function helpText () {
      const c = conf()
      return [
        '【讨饭】',
        '/讨饭 —— 发一张收款码（冷却 ' + c.cooldownSeconds + ' 秒，每天最多 ' + (c.dailyLimit || '不限') + ' 次）',
        '/已打钱 —— 道谢窗口内让她去道谢',
        '/打赏 15 [备注] —— 记一笔；群友触发要管理员私聊 /确认 才落账',
        '/收款 今天 | 7 | 全部 | 2026-10-27 —— 查账',
        '/待确认 —— 管理员私聊看等待确认的记账',
        '/确认 [编号] / /不记 [编号] —— 管理员私聊处理',
        c.linkImpressionCard ? '记账生效后会顺手给打赏的人加一点「慷慨」（装了印象卡片时）。' : '印象卡片联动关着。',
      ].join('\n')
    }

    /** 命令里记一笔：/打赏 15 备注。 */
    async function recordByCommand (arg, ctx, source, byAdmin) {
      const text = String(arg || '').trim()
      if (!text) return { ok: false, message: '要记多少？用法：/打赏 15 或者 /打赏 15 备注' }
      const matched = text.match(/^([0-9]+(?:\.[0-9]{1,2})?)\s*([\s\S]*)$/)
      if (!matched) return { ok: false, message: '金额要写成数字：/打赏 15 或者 /打赏 15 备注' }
      return recordPayment({
        amount: matched[1],
        note: String(matched[2] || '').trim(),
        chatId: ctx.chatId,
        groupId: ctx.groupId,
        payer: ctx.userId,
        payerName: ctx.nickname,
        source,
        byAdmin,
      })
    }

    /** 待确认列表文案：主人命令和非主人管理员私聊共用。 */
    function pendingText () {
      const c = conf()
      purgeApprovals()
      const list = [...approvals.values()].sort((a, b) => a.created - b.created)
      if (!list.length) return '没有待确认的记账。'
      const lines = ['待确认的记账：']
      for (const rec of list.slice(0, PENDING_LIMIT)) {
        lines.push('  #' + rec.id + ' ' + formatMoney(rec.amount, c.currency) + ' — ' + (rec.groupName || rec.chatId || '未知') + ' / ' + rec.requester)
      }
      if (list.length > PENDING_LIMIT) lines.push('  ……另有 ' + (list.length - PENDING_LIMIT) + ' 条')
      return lines.join('\n')
    }

    /** /已打钱 的回复：节流时把剩余秒数说清楚，别只说「失败了」。 */
    async function thanksByCommand (chatId) {
      const out = await fireThanks(chatId, '手动确认已打钱')
      if (out.ok) return out.delivered ? '收到，让她去道谢了。' : '试运行：道谢没有真发出去。'
      if (out.throttled && out.message) return out.message
      return '道谢没发出去，稍后再试。'
    }

    // ---------- 命令（主人） ----------

    api.command({
      name: '讨饭',
      aliases: ['要饭', 'beg_for_money', 'beg'],
      desc: '让她发一张收款码',
      run: async (arg, msg) => {
        const c = conf()
        const ctx = commandContext(msg)
        if (!c.enabled) return '讨饭插件已关闭。'
        if (c.adminOnly && !isAdmin(ctx.userId)) return '这个动作只有管理员能做。'
        return (await doBeg(ctx.chatId)).message
      },
    })

    api.command({
      name: '已打钱',
      aliases: ['打了', 'paid'],
      desc: '在道谢窗口内让她去道谢',
      run: async (arg, msg) => {
        const c = conf()
        const ctx = commandContext(msg)
        if (!c.enabled) return '讨饭插件已关闭。'
        if (c.adminOnly && !isAdmin(ctx.userId)) return '这个动作只有管理员能做。'
        if (c.thanksWindowSeconds <= 0) return '自动道谢关着，先把「道谢窗口」设成大于 0 秒。'
        if (!state.pendingThanks.has(ctx.chatId)) return '现在没有待道谢的讨饭记录，先 /讨饭 或者等窗口内有人打钱。'
        return thanksByCommand(ctx.chatId)
      },
    })

    api.command({
      name: '打赏',
      aliases: ['记账', 'record', 'record_payment'],
      desc: '记一笔打赏：/打赏 15 [备注]',
      run: async (arg, msg) => {
        const c = conf()
        if (!c.enabled) return '讨饭插件已关闭。'
        const ctx = commandContext(msg)
        const out = await recordByCommand(arg, ctx, '命令', isAdmin(ctx.userId))
        return out.message
      },
    })

    api.command({
      name: '收款',
      aliases: ['账本', '收入', 'ledger', 'check_ledger'],
      desc: '查账：/收款 今天 | 7 | 全部 | 2026-10-27',
      run: async (arg, msg) => {
        const c = conf()
        const ctx = commandContext(msg)
        if (!c.enabled) return '讨饭插件已关闭。'
        if (!c.ledgerEnabled) return '记账功能已关闭。'
        if (c.adminOnly && !isAdmin(ctx.userId)) return '这个动作只有管理员能做。'
        // 营收是敏感数据：开了 adminOnly 就说明不想公开，那群里也不给看
        if (c.adminOnly && ctx.isGroup) return '营收明细请私聊查。'
        return formatLedgerLines(ledgerView(String(arg || '').trim()))
      },
    })

    api.command({
      name: '待确认',
      aliases: ['待审', 'pending'],
      desc: '管理员私聊列出待确认的记账',
      run: async (arg, msg) => {
        const c = conf()
        const ctx = commandContext(msg)
        if (!c.enabled) return '讨饭插件已关闭。'
        if (!isAdmin(ctx.userId)) return '只有管理员能看。'
        // 列表里有别的群的群名、昵称和金额，群聊里发等于公开
        if (ctx.isGroup) return '待确认列表请私聊查。'
        return pendingText()
      },
    })

    api.command({
      name: '确认',
      aliases: ['同意', 'approve'],
      desc: '管理员私聊确认记账并在原群道谢：/确认 [编号]',
      run: async (arg, msg) => {
        const c = conf()
        const ctx = commandContext(msg)
        if (!c.enabled) return '讨饭插件已关闭。'
        if (!isAdmin(ctx.userId)) return '只有管理员能确认。'
        if (ctx.isGroup) return '确认请在私聊里说，别在群里。'
        return (await resolveApproval(String(arg || '').trim(), true)).text
      },
    })

    api.command({
      name: '不记',
      aliases: ['拒绝', '忽略', 'reject'],
      desc: '管理员私聊丢弃一笔待确认：/不记 [编号]',
      run: async (arg, msg) => {
        const c = conf()
        const ctx = commandContext(msg)
        if (!c.enabled) return '讨饭插件已关闭。'
        if (!isAdmin(ctx.userId)) return '只有管理员能确认。'
        if (ctx.isGroup) return '确认请在私聊里说，别在群里。'
        return (await resolveApproval(String(arg || '').trim(), false)).text
      },
    })

    api.command({
      name: '讨饭帮助',
      aliases: ['讨饭用法', 'beg_help'],
      desc: '讨饭扩展的用法',
      run: async () => helpText(),
    })

    // ---------- 群友 / 非主人管理员的命令：由 message 事件接管 ----------
    //
    // Aurabot 的 api.command 只认主人，群友发 /讨饭、/打赏、/收款 会被当成普通聊天；
    // 名单里的非主人管理员同样收不到命令分发，所以 /确认、/不记、/待确认 也在这里接管。
    // 返回 true = 这条不再交给她；只认完整命令，不做模糊匹配。
    const GUEST_RE = /^[/／]\s*(讨饭帮助|讨饭用法|beg_help|beg_for_money|beg|讨饭|要饭|已打钱|打了|paid|打赏|记账|record_payment|record|收款|账本|收入|check_ledger|ledger|待确认|待审|pending|确认|同意|approve|不记|拒绝|忽略|reject)(?![A-Za-z0-9_])([\s\S]*)$/

    api.on('message', async (msg) => {
      if (disposed) return false
      const text = String((msg && msg.text) || '').trim()
      if (!text) return false
      const c = conf()
      // 记下这个聊天最后说话的人：群里认「打赏人」时要用（不放 activity，是因为
      // 群里那句「转了」她未必会回，activity 就不一定发；message 每条都会来）。
      // 只认宿主给的 msg.userId，模型传的参数一律不采信。
      if (msg.userId && msg.chatId) rememberSpeaker(msg.chatId, msg.userId, msg.nickname)
      // 道谢窗口内的「我转了」：先看一眼，但**不接管**这条消息 ——
      // 她照常可以回话，道谢由后面那次 fireThanks 单独发。
      if (c.enabled && c.thanksWindowSeconds > 0 && msg.chatId) {
        const chatId = String(msg.chatId)
        const until = state.pendingThanks.get(chatId)
        if (until !== undefined) {
          if (nowMs() > until) closeThanksWindow(chatId)
          // maybeAutoThanks 自己负责双通道去重和「本窗口只试一次」。
          else if (isPaymentClaim(text)) maybeAutoThanks(msg)
        }
      }
      if (text[0] !== '/' && text[0] !== '／') return false
      // 主人的命令已经由 api.command 执行过了；把这条吞掉，避免她再对着命令本身回一句
      if (api.isOwner(msg.userId)) return GUEST_RE.test(text)
      const match = text.match(GUEST_RE)
      if (!match || !c.enabled) return false
      const word = match[1]
      const arg = String(match[2] || '').trim()
      const isGroup = isGroupChat(msg.chatId)
      try {
        if (word === '讨饭帮助' || word === '讨饭用法' || word === 'beg_help') {
          await api.reply(msg, helpText())
        } else if (word === '讨饭' || word === '要饭' || word === 'beg' || word === 'beg_for_money') {
          if (c.adminOnly && !isAdmin(msg.userId)) await api.reply(msg, '这个动作只有管理员能做。')
          else await api.reply(msg, (await doBeg(msg.chatId)).message)
        } else if (word === '已打钱' || word === '打了' || word === 'paid') {
          if (c.adminOnly && !isAdmin(msg.userId)) await api.reply(msg, '这个动作只有管理员能做。')
          else if (c.thanksWindowSeconds <= 0) await api.reply(msg, '自动道谢关着。')
          else if (!state.pendingThanks.has(msg.chatId)) await api.reply(msg, '现在没有待道谢的讨饭记录。')
          else await api.reply(msg, await thanksByCommand(msg.chatId))
        } else if (word === '打赏' || word === '记账' || word === 'record' || word === 'record_payment') {
          const out = await recordByCommand(arg, commandContext(msg), '群友命令', false)
          await api.reply(msg, out.message)
        } else if (word === '收款' || word === '账本' || word === '收入' || word === 'ledger' || word === 'check_ledger') {
          if (c.adminOnly && !isAdmin(msg.userId)) await api.reply(msg, '这个动作只有管理员能做。')
          else if (c.adminOnly && isGroup) await api.reply(msg, '营收明细请私聊查。')
          else if (!c.ledgerEnabled) await api.reply(msg, '记账功能已关闭。')
          else await api.reply(msg, formatLedgerLines(ledgerView(arg)))
        } else if (word === '待确认' || word === '待审' || word === 'pending') {
          if (!isAdmin(msg.userId)) await api.reply(msg, '只有管理员能看。')
          // 列表里有别的群的群名、昵称和金额，群聊里发等于公开
          else if (isGroup) await api.reply(msg, '待确认列表请私聊查。')
          else await api.reply(msg, pendingText())
        } else if (word === '确认' || word === '同意' || word === 'approve') {
          if (!isAdmin(msg.userId)) await api.reply(msg, '只有管理员能确认。')
          else if (isGroup) await api.reply(msg, '确认请在私聊里说，别在群里。')
          else await api.reply(msg, (await resolveApproval(arg, true)).text)
        } else if (word === '不记' || word === '拒绝' || word === '忽略' || word === 'reject') {
          if (!isAdmin(msg.userId)) await api.reply(msg, '只有管理员能确认。')
          else if (isGroup) await api.reply(msg, '确认请在私聊里说，别在群里。')
          else await api.reply(msg, (await resolveApproval(arg, false)).text)
        }
      } catch (error) {
        log.warn('处理讨饭命令出错：' + (error && error.message ? error.message : error))
        await api.reply(msg, '这条没处理成功，稍后再试。')
      }
      return true
    })

    // ---------- 道谢窗口内检测「打了钱」 ----------
    //
    // 用 activity 而不是 message：activity 收的是所有进出的消息（只看不改），
    // 不受「她回不回这条」影响；群友一句「转了」未必会交给她。
    // 和 message 通道共用 maybeAutoThanks，同一句只触发一次。
    api.on('activity', (a) => {
      if (disposed) return
      if (!a || a.kind !== 'in' || !a.chatId) return
      // 顺手记下这个聊天最后说话的人：群里记「打赏人」时要用。
      // 只在宿主给的事件里记（不采信模型传的参数），免得把「慷慨」加到别人头上。
      if (a.userId) rememberSpeaker(a.chatId, a.userId, a.nickname)
      const c = conf()
      if (!c.enabled || c.thanksWindowSeconds <= 0) return
      const chatId = String(a.chatId)
      const until = state.pendingThanks.get(chatId)
      if (until === undefined) return
      if (nowMs() > until) { closeThanksWindow(chatId); return }
      if (!isPaymentClaim(a.text)) return
      maybeAutoThanks(a)
    })

    // ---------- 工具 ----------
    api.tool(({ chat, level }) => {
      if (!chat || chat.kind === 'system') return []
      const c = conf()
      if (!c.enabled) return []
      const chatId = String(chat.chatId || '')
      const groupId = String(chat.groupId || '')
      // 工具参数里模型能编 user_id / nickname，所以身份一律用宿主给的会话：
      // 私聊就是对面那个人；群里认不出具体是谁，所以记「打赏人」时用最近在群里说话的人
      // （由 activity 事件顺手记下），认不出就不写 —— 宁可少一个「慷慨」，也别把分加到别人头上。
      // 认不出管理员就按「非管理员」处理，走审批（fail-closed）。
      const callerId = chat.kind === 'private' ? String(chat.userId || '') : ''
      const callerIsAdmin = level === 'full' || isAdmin(callerId)
      const payerOf = () => {
        if (chat.kind === 'private') return { payer: String(chat.userId || ''), payerName: '' }
        const last = lastSpeaker.get(chatId)
        return last ? { payer: last.uid, payerName: last.who } : { payer: '', payerName: '' }
      }

      const tools = [api.defineTool({
        name: 'beg_for_money',
        description: '伸手要钱：对方提到请客、打钱、投喂、发红包、赏你时调用。调用后发一张收款码，同一段对话最多一次，别反复要。',
        properties: {},
        execute: async () => doBeg(chatId),
      })]

      tools.push(api.defineTool({
        name: 'record_payment',
        description: '记一笔打赏：对方说自己已经转了 / 打了钱 / 发了红包，并且提到金额（「转了10块」「打赏15」）时调用。'
          + '不用等他发截图或等钱真的到账——这笔记的只是「他说他给了」，可不可信交给管理员点头，审批流程就是为这个准备的。'
          + '完全没提金额、明显在开玩笑、只是问价或者夸你才不记；同一笔只记一次。'
          + '返回「等管理员确认」时，回一句半信半疑的话（真的假的 / 等我问问），别道谢也别重调。',
        properties: {
          amount: { type: 'number', description: '金额，大于 0' },
          note: { type: 'string', description: '备注，可留空' },
        },
        required: ['amount'],
        execute: async ({ amount, note }) => {
          const who = payerOf()
          return recordPayment({
            amount,
            note: String(note || ''),
            chatId,
            groupId,
            payer: who.payer,
            payerName: who.payerName,
            source: '工具',
            byAdmin: callerIsAdmin,
          })
        },
      }))

      // 查账是看营收：只给主人 / 管理员；群里再受 adminOnly 的隐私限制
      if (callerIsAdmin) {
        tools.push(api.defineTool({
          name: 'check_ledger',
          description: '查打赏账本：有人问收到多少钱时调用。拿到数字用自己的话简短说，别念明细。',
          properties: {
            scope: { type: 'string', description: '今天 / 昨天 / 全部 / 天数（如 7）/ 日期（如 2026-10-27），不填为今天加最近几天' },
          },
          execute: async ({ scope }) => {
            const cfg = conf()
            if (!cfg.ledgerEnabled) return { ok: false, message: '账本功能没开，查不了。' }
            if (cfg.adminOnly && isGroupChat(chatId)) {
              return { ok: false, message: '营收明细不在群里念，让她私聊发 /收款。' }
            }
            const view = ledgerView(String(scope || '').trim())
            if (!view) return { ok: false, message: '看不懂「' + String(scope || '').slice(0, 20) + '」这个范围，能用今天、昨天、全部、7、2026-10-27。' }
            return { ok: true, message: formatLedgerBrief(view) }
          },
        }))
      }
      return tools
    })

    api.rule(() => {
      const c = conf()
      if (!c.enabled) return ''
      return '对方提到请客、打钱、投喂、发红包、赏你时，可以用 beg_for_money 发一张收款码（同一段对话最多一次）。'
        + '对方说自己转了 / 打了钱并提到金额时可以用 record_payment 记一笔：那只是「他说他给了」，别当成真的到账，'
        + '返回「等管理员确认」就回一句半信半疑的话，先别道谢。'
        + (c.adminOnly ? '营收明细不在群里说。' : '')
    })

    // ---------- 面板接口 ----------
    //
    // 这些接口能确认记账、往群里发消息、读出营收，所以：
    //   · 所有路由先过同源闸（照 history-vault / meme-wiki 的 crossSite 写法）；
    //   · /state、/ledger 再限本机回环，响应里不出现管理员 QQ 和绝对路径；
    //   · 有副作用的路由强制 POST，/approve 必须显式 id + 明确的 true/false。
    const LOOPBACK_RE = /^(?:::1|::ffff:127(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3})$/

    function crossSite (req) {
      const site = String(req?.headers?.['sec-fetch-site'] || '')
      if (site === 'cross-site') return { ok: false, message: '不允许跨站调用' }
      const origin = String(req?.headers?.origin || '')
      if (origin) {
        try {
          if (new URL(origin).host !== String(req?.headers?.host || '')) return { ok: false, message: '不允许跨站调用' }
        } catch (error) {
          return { ok: false, message: '来源不合法' }
        }
      }
      return null
    }

    /** 面板 Host 白名单：回环 / localhost / IP 字面量 / 配置的对外域名；挡 DNS rebinding。 */
    function panelHostAllowed (req) {
      const raw = String(req?.headers?.host || '').trim().toLowerCase()
      if (!raw) return true
      const host = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '')
      if (!host) return true
      if (host === 'localhost' || host.endsWith('.localhost')) return true
      if (host === '::1' || host === '0.0.0.0') return true
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
      if (/^[0-9a-f:.]+$/i.test(host) && host.includes(':')) return true
      const cfg = api.config() || {}
      const publicHost = String((cfg.security && cfg.security.publicHostname) || '')
        .trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '')
      return Boolean(publicHost) && host === publicHost
    }

    /** 面板接口只接受本机回环：DNS rebinding / 任意本机网页不能读账本。 */
    function panelGuard (req) {
      const blocked = crossSite(req)
      if (blocked) return blocked
      if (!panelHostAllowed(req)) return { ok: false, message: '不允许这个 Host 访问（疑似 DNS rebinding）' }
      const addr = String(req?.socket?.remoteAddress || '')
      // 没有 socket 的是宿主内部调用 / 测试；真实 HTTP 请求一定有。
      if (addr && !LOOPBACK_RE.test(addr)) return { ok: false, message: '面板接口只接受本机请求' }
      return null
    }

    /** QQ 号脱敏：面板只需要知道「有几个管理员」，不需要真号。 */
    function maskQQ (raw) {
      const s = String(raw || '').trim()
      if (!/^\d+$/.test(s)) return ''
      return '****' + s.slice(-4)
    }

    /** 纯 QQ 号脱敏；昵称原样保留。 */
    function maskQQish (raw) {
      const s = String(raw || '').trim()
      return /^\d{5,12}$/.test(s) ? maskQQ(s) : s
    }

    /** 聊天标识里的私聊 QQ 脱敏，群号保留。 */
    function maskChatId (raw) {
      const s = String(raw || '')
      const m = s.match(/^private:(\d{5,12})$/)
      return m ? 'private:' + maskQQ(m[1]) : s
    }

    /** 账本行里的打赏人：有昵称用昵称，没有昵称才用脱敏后的 QQ。 */
    function payerLabel (row) {
      const name = String((row && row.payerName) || '').trim()
      if (name) return name
      const payer = String((row && row.payer) || '').trim()
      return /^\d+$/.test(payer) ? maskQQ(payer) : payer
    }

    /** /ledger 返回的视图也脱敏，别把原始 QQ 再带出去一次。 */
    function publicLedgerView (view) {
      if (!view) return null
      return {
        ...view,
        rows: (view.rows || []).map((row) => ({
          date: row.date,
          time: row.time,
          amount: row.amount,
          note: row.note,
          group: row.groupId ? '群 ' + row.groupId : groupDisplayName(row.chatId),
          payer: payerLabel(row),
          source: row.source,
        })),
      }
    }

    api.route('/state', async (req) => {
      const blocked = panelGuard(req)
      if (blocked) return blocked
      const c = conf()
      const qr = resolveQrs()
      purgeApprovals()
      const today = isoDay()
      const view = summarizeLedger(ledger.all(), '今天', { todayISO: today, currency: c.currency, recentDays: c.recentDays })
      const recentView = summarizeLedger(ledger.all(), String(Math.max(1, c.recentDays)), { todayISO: today, currency: c.currency, recentDays: c.recentDays })
      return {
        ok: true,
        version: VERSION,
        enabled: c.enabled,
        ledgerEnabled: c.ledgerEnabled,
        currency: c.currency,
        ledgerBroken: ledger.broken,
        approvalsBroken,
        // 只给文件名：面板要显示「记在哪」，但绝对路径没有必要进 HTTP 响应
        ledgerFile: basename(ledgerFile),
        approvalsFile: basename(approvalsFile),
        accounts: ledger.count(),
        grandTotal: view.grand,
        today: { date: today, count: view.count, total: view.total },
        recent: {
          days: c.recentDays,
          count: recentView ? recentView.count : 0,
          total: recentView ? recentView.total : 0,
          buckets: recentView ? recentView.buckets : [],
        },
        qr: {
          configured: qrPathList().length > 0,
          path: c.qrImagePath,
          available: qr.ok,
          message: qr.ok ? '' : qr.reason,
          // 一张一行，配了几张就列几张：面板按这个显示「几张可用 / 哪张找不到」。
          // 只回配置里的路径，不回解析出来的绝对路径。
          items: qr.files.map((one) => ({ path: one.path })),
          missing: qr.missing,
          count: qr.files.length,
        },
        adminOnly: c.adminOnly,
        // 管理员 QQ 脱敏：面板不需要真号，泄露给 DNS-rebinding / 本机进程没有意义
        admins: [...c.admins].map(maskQQ),
        requireApproval: c.requireApproval,
        thanksWindowSeconds: c.thanksWindowSeconds,
        linkImpressionCard: c.linkImpressionCard,
        impressionCard: Boolean(api.use('impression-card')),
        // private:<QQ> / 纯 QQ 都脱敏；群号保留，面板需要区分群。
        pendingThanks: [...state.pendingThanks.keys()].map(maskChatId),
        approvals: [...approvals.values()].sort((a, b) => a.created - b.created).map((rec) => ({
          id: rec.id,
          amount: rec.amount,
          note: rec.note,
          groupName: rec.groupName,
          requester: maskQQish(rec.requester),
          payer: maskQQ(rec.payer),
          created: rec.created,
        })),
        rows: ledger.all().slice(-200).reverse().map((row) => ({
          date: row.date,
          time: row.time,
          amount: row.amount,
          note: row.note,
          group: row.groupId ? '群 ' + row.groupId : groupDisplayName(row.chatId),
          payer: payerLabel(row),
          source: row.source,
        })),
      }
    })

    api.route('/approve', async (req) => {
      const blocked = panelGuard(req)
      if (blocked) return blocked
      // 写操作必须 POST：GET /approve 会被浏览器预取 / <img> / DNS-rebinding 直接打穿。
      if (req?.method !== 'POST') return { ok: false, message: '只支持 POST' }
      if (!conf().enabled) return { ok: false, message: '讨饭插件已关闭。' }
      const body = await api.core.http.body(req)
      const id = String((body && body.id) || '').trim()
      // 不填编号就取最近一条 = 一个裸请求批准最近一笔，这里必须显式指定。
      if (!id) return { ok: false, message: '要指定待确认编号，不能确认「最近一条」。' }
      // 不能用 `!== false` 兜底：少传字段会被当成批准。
      if ((body && body.approve) !== true && (body && body.approve) !== false) {
        return { ok: false, message: 'approve 必须显式写 true 或 false。' }
      }
      const out = await resolveApproval(id, body.approve)
      return { ok: out.ok, message: out.text }
    })

    api.route('/ledger', async (req) => {
      const blocked = panelGuard(req)
      if (blocked) return blocked
      if (!conf().enabled) return { ok: false, message: '讨饭插件已关闭。' }
      const body = req?.method === 'POST'
        ? await api.core.http.body(req)
        : (api.core.http.query(req) || {})
      const view = ledgerView(String((body && body.scope) || '').trim())
      if (!view) return { ok: false, message: '看不懂这个范围。' }
      return { ok: true, view: publicLedgerView(view), text: formatLedgerLines(view) }
    })

    api.route('/beg', async (req) => {
      const blocked = panelGuard(req)
      if (blocked) return blocked
      // 有副作用（发图、占冷却 / 每日额度、开道谢窗口）：只收 POST。
      if (req?.method !== 'POST') return { ok: false, message: '只支持 POST' }
      const c = conf()
      if (!c.enabled) return { ok: false, message: '讨饭插件已关闭。' }
      if (!c.ownerQQ) return { ok: false, message: '还没配置主人 QQ，不知道往哪发。' }
      // 面板手动试发：目标是主人私聊，避免往群里发
      return doBeg('private:' + c.ownerQQ)
    })

    // ---------- 导出 ----------

    return {
      version: VERSION,
      // 别的模块（或测试）可以直接记账 / 查账
      recordPayment,
      resolveApproval,
      pending: () => [...approvals.values()].map((rec) => ({ ...rec })),
      ledger: () => ledger.all(),
      view: (scope) => ledgerView(scope),
      text: (scope) => formatLedgerLines(ledgerView(scope)),
      status: () => ({ enabled: conf().enabled, accounts: ledger.count(), pending: approvals.size, broken: ledger.broken, approvalsBroken }),
      dispose: () => { disposed = true },
    }
  },
}
