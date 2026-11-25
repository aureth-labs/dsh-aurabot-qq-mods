// lib/policy.mjs — bambu-print 的权限与脱敏规则（纯函数，无 IO、无依赖）。
//
// 规则见 ARCHITECTURE.md 第 4 节。要点：
//   * owner 恒可私聊；其他用户由 index 从 Aurabot 的 cfg.allow.private 传进来（settings.users，没有「管理员」这一级）；
//   * 群聊必须在 cfg.allow.groups 里（index 传成 settings.groups），且必须已经有「自己的」绑定
//     或别人给他的授权（由 index 计入）；模块不再单独维护群号列表；
//   * groupMode=off 一律拒绝；status 只读；control 才允许暂停/继续/停止/灯光/温度/速度/gcode，
//     但永远只作用于发起人自己的绑定（本文件只判定「能不能」，不选目标）；
//   * 群默认脱敏 hideProject 恒 true，hideName 需要三个条件同时成立；
//   * 绑定/解绑/改安全码/授权只允许私聊。
//
// 所有函数对缺省 settings 都安全降级（白名单为空 = 谁都不许）。

const QQ_MIN = 4
const QQ_MAX = 15
const QQ_RE = /^\d{4,15}$/

const GROUP_MODES = ['off', 'status', 'control']

/** 把设置里的 id 列表（字符串或数组）统一成字符串数组。 */
function idList (value) {
  if (!value) return []
  const raw = Array.isArray(value) ? value : String(value).split(/[,，、;；\s]+/)
  const out = []
  for (const item of raw) {
    const id = item == null ? '' : String(item).trim()
    if (!id || !QQ_RE.test(id)) continue
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** 会话类型归一：'private' | 'group' | ''（未知）。 */
function normalizeChat (chat) {
  const value = chat == null ? '' : String(chat).trim().toLowerCase()
  if (value === 'private' || value === 'friend' || value === 'dm') return 'private'
  if (value === 'group' || value === 'guild' || value === 'channel') return 'group'
  return ''
}

function normalizeId (value) {
  return value == null ? '' : String(value).trim()
}

/** 逗号/中文逗号/顿号/空白/换行分割，只留 4~15 位数字。 */
export function parseIdList (value) {
  return idList(value)
}

/**
 * 'owner' | 'user' | 'guest'
 *
 * 只有**一个**主人（config.ownerQQ），没有「管理员」这一级：主人想把某台打印机交给别人用，
 * 就走授权（grant），而不是把人提成管理员。这样每个人的权限都能追溯、能撤销、能限时。
 * 角色只决定「能不能用功能」，不决定秘密可见性 —— vault 里没有主人后门。
 */
export function roleOf ({ userId, isOwner, settings } = {}) {
  if (isOwner) return 'owner'
  const id = normalizeId(userId)
  if (!id) return 'guest'
  const cfg = settings || {}
  if (idList(cfg.users).includes(id)) return 'user'
  return 'guest'
}

/**
 * 绑定用户自己的群权限：绑定 token 的用户对自己的打印机有一票决定权，
 * 可以在私聊里把「在这个群允许到什么程度」调得比全局更松或更紧；不设就跟随全局。
 * prefs.groupMode 只影响「这个人自己的打印机在群里的表现」，不影响别人的。
 */
export function effectiveGroupMode (settings, prefs) {
  const own = prefs && typeof prefs.groupMode === 'string' ? prefs.groupMode : ''
  if (['off', 'status', 'control'].includes(own)) return own
  return groupMode(settings)
}

/** 绑定用户自己的「群里是否允许拍照」：null/undefined 跟随全局。 */
export function effectiveGroupPhoto (settings, prefs) {
  if (prefs && typeof prefs.groupPhoto === 'boolean') return prefs.groupPhoto
  return settings ? settings.groupPhoto !== false : true
}

/** 群模式：off / status / control（未知值一律 off，安全默认）。 */
export function groupMode (settings) {
  const value = settings && settings.groupMode
  if (typeof value === 'boolean') return value ? 'control' : 'off'
  const name = value == null ? '' : String(value).trim().toLowerCase()
  return GROUP_MODES.includes(name) ? name : 'off'
}

/**
 * 私聊准入。owner / 白名单用户可私聊；其余是 guest（只能看帮助）。
 * 这里的 settings.users 由 index 用 Aurabot 的 cfg.allow.private 组装而成。
 * hasBinding 只用于给出提示，不改变结论（绑定/解锁本身就发生在私聊）。
 */
export function checkPrivate ({ userId, isOwner, settings, hasBinding } = {}) {
  const id = normalizeId(userId)
  if (!id) return { ok: false, reason: '无法识别你的 QQ 号' }
  const role = roleOf({ userId: id, isOwner, settings })
  if (role === 'guest') {
    return { ok: false, reason: '你还不在白名单里，请让主人把你加入 Aurabot 的「私聊白名单」' }
  }
  if (role !== 'owner' && hasBinding !== true) {
    return { ok: true, reason: '', hint: '你还没有绑定打印机，发送「/打印机 绑定」添加' }
  }
  return { ok: true, reason: '' }
}

/**
 * 群聊准入。settings.groups 由 index 从 Aurabot 的 cfg.allow.groups 组装；为空 = 群里一律不响应。
 * hasBinding：发起人在本群可用的绑定（自己的绑定，或别人授权给他的）。
 */
export function checkGroup ({ groupId, userId, settings, hasBinding } = {}) {
  const gid = normalizeId(groupId)
  const uid = normalizeId(userId)
  if (!gid) return { ok: false, reason: '不在群聊里' }
  if (!uid) return { ok: false, reason: '无法识别你的 QQ 号' }
  const cfg = settings || {}
  // 绑定用户对自己的打印机有最高权限：即使全局是 off，他自己的群权限偏好也能覆盖，
  // 所以这里只检查「这个群允不允许本模块响应」，模式在选中打印机后再按所有者偏好判定。
  if (!idList(cfg.groups).includes(gid)) return { ok: false, reason: '本群不在白名单里' }
  if (hasBinding !== true) {
    return { ok: false, reason: '你还没有绑定打印机或授权，请在私聊里操作' }
  }
  return { ok: true, reason: '' }
}

/** 控制类动作（暂停/继续/停止/灯光/温度/速度）。opts.mode 传入生效的群模式（绑定用户偏好优先）。 */
export function canControl ({ chat, role, settings, mode } = {}) {
  const where = normalizeChat(chat)
  if (!where) return { ok: false, reason: '未知的会话类型' }
  if (where === 'group') {
    const effective = mode || groupMode(settings)
    if (effective !== 'control') {
      return { ok: false, reason: effective === 'off' ? '这个群的打印机功能没开' : '群里只允许查看状态，控制功能请私聊使用' }
    }
    return { ok: true, reason: '' }
  }
  const who = role || 'guest'
  if (who === 'guest') return { ok: false, reason: '你还不在白名单里，请让主人把你加入白名单' }
  return { ok: true, reason: '' }
}

/** 拍照（仅局域网打印机，云端由协议层拒绝）。 */
export function canPhoto ({ chat, role, settings, mode, photo } = {}) {
  const where = normalizeChat(chat)
  if (!where) return { ok: false, reason: '未知的会话类型' }
  if (where === 'group') {
    const effective = mode || groupMode(settings)
    if (effective === 'off') return { ok: false, reason: '本群未开启打印机功能' }
    const allowed = typeof photo === 'boolean' ? photo : (settings ? settings.groupPhoto !== false : true)
    if (!allowed) return { ok: false, reason: '本群未开启拍照' }
    return { ok: true, reason: '' }
  }
  const who = role || 'guest'
  if (who === 'guest') return { ok: false, reason: '你还不在白名单里，请让主人把你加入白名单' }
  return { ok: true, reason: '' }
}

/** 绑定 / 解绑：只私聊。 */
export function canBind ({ chat, role } = {}) {
  const where = normalizeChat(chat)
  if (where !== 'private') return { ok: false, reason: '绑定打印机只能在私聊里操作，请私聊我' }
  const who = role || ''
  if (who === '') return { ok: false, reason: '无法识别你的身份' }
  return { ok: true, reason: '' }
}

/**
 * 授权（发起 / 撤销）：只私聊，且只能由「绑定者本人」发起。
 * 授权按 QQ 直接生效，限时、可随时撤销。
 */
export function canGrant ({ chat, role, settings } = {}) {
  const where = normalizeChat(chat)
  if (where !== 'private') return { ok: false, reason: '授权只能在私聊里操作，请私聊我' }
  const who = role || (settings ? roleOf({ userId: '', isOwner: false, settings }) : 'guest')
  if (who === 'owner' || who === 'user') return { ok: true, reason: '' }
  return { ok: false, reason: '只有绑定者本人可以发起授权' }
}

/**
 * 输出脱敏。私聊不脱敏；群里默认 hideName + hideProject 全隐藏。
 * hideName 只在「发起人就是绑定所有者 + 用户开了 groupShowName + 主人开了 allowGroupName」
 * 三者同时成立时为 false；hideProject 在群里恒为 true。
 */
export function redaction ({ chat, requesterQQ, ownerQQ, prefs, settings } = {}) {
  const where = normalizeChat(chat)
  // 只有明确私聊才不脱敏；会话类型未知时按群处理（安全默认）
  if (where === 'private') return { hideName: false, hideProject: false }
  if (where !== 'group') return { hideName: true, hideProject: true }
  const requester = normalizeId(requesterQQ)
  const owner = normalizeId(ownerQQ)
  const showName = !!requester && requester === owner &&
    !!(prefs && prefs.groupShowName === true) &&
    !!(settings && settings.allowGroupName === true)
  return { hideName: !showName, hideProject: true }
}

/** 123****456；太短就整段遮住。 */
export function maskQQ (qq) {
  const text = normalizeId(qq).replace(/\D/g, '')
  if (!text) return '****'
  if (text.length <= 3) return '****'
  if (text.length <= 6) return text[0] + '***' + text[text.length - 1]
  return text.slice(0, 3) + '****' + text.slice(-3)
}

/** 192.168.*.*：只留前两段；IPv6 只留前两组。 */
export function maskIp (ip) {
  const text = normalizeId(ip)
  if (!text) return ''
  if (text.includes(':')) {
    const parts = text.split(':').filter((p) => p)
    if (parts.length < 2) return '***'
    return parts.slice(0, 2).join(':') + '::*'
  }
  const parts = text.split('.')
  if (parts.length !== 4) return '***'
  if (parts.some((p) => p === '' || !/^\d{1,3}$/.test(p) || Number(p) > 255)) return '***'
  return parts[0] + '.' + parts[1] + '.*.*'
}

/**
 * 内存限流器：hit(key, limit, windowMs) -> { ok, retryMs }。
 * 只用于抑制刷屏，不参与任何安全判定（安全判定看 vault 的失败计数）。
 */
export function createRateLimiter ({ now = Date.now } = {}) {
  const buckets = new Map()
  const clock = typeof now === 'function' ? now : Date.now

  function sweep (at) {
    if (buckets.size < 512) return
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key)
    }
  }

  return {
    hit (key, limit, windowMs) {
      const id = normalizeId(key) || 'anonymous'
      const max = Math.max(1, Math.floor(Number(limit) || 1))
      const window = Math.max(0, Number(windowMs) || 0)
      const at = clock()
      let bucket = buckets.get(id)
      if (!bucket || bucket.resetAt <= at) {
        bucket = { count: 0, resetAt: at + window }
        buckets.set(id, bucket)
        sweep(at)
      }
      if (bucket.count >= max) {
        return { ok: false, retryMs: Math.max(0, bucket.resetAt - at), remaining: 0 }
      }
      bucket.count += 1
      return { ok: true, retryMs: 0, remaining: Math.max(0, max - bucket.count) }
    },
    reset (key) {
      if (key == null) {
        buckets.clear()
        return true
      }
      return buckets.delete(normalizeId(key))
    }
  }
}

/**
 * 解析「解锁时长」这类分钟数：支持 30 / 30分钟 / 1小时 / 1.5小时 / 1天 / 30m / 2h。
 * 解析失败返回 fallback；结果夹在 [1, max]（fallback 本身非法时也会被夹住）。
 */
export function parseMinutes (value, fallback = 15, max = 1440) {
  const cap = Math.max(1, Math.floor(Number(max) || 1440))
  const fb = Number(fallback)
  const safeFallback = Number.isFinite(fb)
    ? Math.min(cap, Math.max(1, Math.floor(fb)))
    : Math.min(cap, 15)
  if (value == null) return safeFallback
  const text = String(value).trim().toLowerCase()
  if (!text) return safeFallback
  if (text === '半小时' || text === '半小時' || text === '0.5小时') return Math.min(cap, 30)
  if (/^-/.test(text)) return safeFallback // 负数不是合法时长
  const match = text.match(/(\d+(?:\.\d+)?)/)
  if (!match) return safeFallback
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return safeFallback
  let minutes = amount
  if (/小时|小時|hours?|hrs?|h\b/.test(text) || text === amount + 'h') minutes = amount * 60
  else if (/天|days?|d\b/.test(text)) minutes = amount * 60 * 24
  const rounded = Math.round(minutes)
  return Math.min(cap, Math.max(1, rounded))
}
