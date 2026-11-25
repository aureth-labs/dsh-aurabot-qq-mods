// 定时任务的纯判断：什么时候抓、什么时候发、什么时候放弃。
import { isHm } from './time.mjs'

export const RETRY_INTERVAL_MS = 30 * 60 * 1000
const ID = /^[1-9]\d*$/
const COMMAND_NAME = /^[A-Za-z0-9\u4e00-\u9fff_-]+$/
// 这些词是宿主自己的命令。自定义指令若占用，会把 /状态、/帮助 这类入口抢走。
const RESERVED_COMMANDS = new Set([
  'moyu', 'help', 'h', '帮助', '命令',
  'permissions', 'perms', '权限', 'groupsettings', '群设置',
  'silent', 'shutup', 'mute', '闭嘴', '安静', '静音',
  'active', 'unmute', '说话', '醒醒', '解除静音',
  'quiet', '少说', '话少', 'chatty', '多说', '话多', 'normal', '正常',
  'model', '模型', '换模型', 'effort', '思考', '思考强度',
  'sing', '唱', '点歌', '翻唱', 'status', '状态', 'mood', '心情',
  'diary', '日记', 'remember', '记住', '记一下',
  'speak', '搭话', '主动搭话', 'reset', '重开', 'on', '开机', 'off', '关机',
])

/** 一行一个触发词。斜杠可写可不写；/moyu 由命令名固定提供，这里不用再写。 */
export function parseCommandAliases(raw) {
  const seen = new Set()
  const names = []
  for (const part of String(raw ?? '').split(/[\s,，]+/)) {
    const name = part.trim().replace(/^[/／]+/, '')
    if (!COMMAND_NAME.test(name)) continue
    const key = name.toLowerCase()
    if (RESERVED_COMMANDS.has(key) || seen.has(key)) continue
    seen.add(key)
    names.push(name)
    if (names.length >= 20) break
  }
  return names
}

/**
 * 整句就是触发词时不用斜杠。带斜杠的留给宿主命令。
 * 「摸鱼人日历」发图，「摸鱼人日历 状态」或「摸鱼人日历状态」看任务。
 * 多出来的字不算，避免聊天里随口提到就发图。
 */
export function matchBareCommand(text, aliases) {
  const raw = String(text ?? '').trim()
  if (!raw || /^[/／]/.test(raw)) return null
  const names = [...(aliases || [])].map(name => String(name)).filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (raw.toLowerCase() === name.toLowerCase()) return { arg: '' }
    if (!raw.toLowerCase().startsWith(name.toLowerCase())) continue
    const rest = raw.slice(name.length).trim()
    if (/^(状态|status)$/i.test(rest)) return { arg: rest }
  }
  return null
}

export function initialState(stamp, settings) {
  const time = String(settings?.time || '')
  return {
    date: stamp.date,
    attempts: 0,
    lastAttempt: 0,
    sent: [],
    completed: '',
    noUpdate: '',
    // 首次安装如果已经过了开始时间，今天不再补发，从明天开始。
    firstSkip: isHm(time) && stamp.time >= time ? stamp.date : '',
    title: '',
    source: '',
  }
}

/**
 * 返回 { action, reason }。
 * action：skip 什么都不做；error 配置不合法；giveup 截止后仍没有图；
 * fetch 去找今天的文章；deliver 图已经在缓存里，只补发没送到的聊天。
 */
export function decideTick({ stamp, settings, state, enabled, dryRun, busy, nowMs, hasImage }) {
  if (busy) return { action: 'skip', reason: 'busy' }
  if (settings?.daily === false) return { action: 'skip', reason: 'daily-off' }
  if (!enabled || dryRun) return { action: 'skip', reason: 'paused' }
  if (!isHm(settings?.time) || !isHm(settings?.deadline)) return { action: 'error', reason: '时间格式必须是 HH:mm' }
  if (settings.deadline <= settings.time) return { action: 'error', reason: '截止时间要晚于开始时间' }
  if (stamp.time < settings.time) return { action: 'skip', reason: 'before-time' }
  if (state?.completed === stamp.date || state?.noUpdate === stamp.date || state?.firstSkip === stamp.date) {
    return { action: 'skip', reason: 'settled' }
  }
  const sameDay = state?.date === stamp.date
  const attempted = sameDay && (state?.attempts || 0) > 0
  // 截止后不再为「还没下到图」重试。已经下到的图继续补发，不受截止时间限制。
  if (!hasImage && stamp.time >= settings.deadline && attempted) return { action: 'giveup', reason: 'deadline' }
  const waited = !attempted || nowMs - (state?.lastAttempt || 0) >= RETRY_INTERVAL_MS
  if (!waited) return { action: 'skip', reason: 'retry-wait' }
  if (hasImage) return { action: 'deliver' }
  return { action: 'fetch' }
}

function readIds(raw, label) {
  const ids = []
  for (const part of String(raw ?? '').split(/[\s,，]+/)) {
    const token = part.trim().replace(/^(?:private|group):/i, '')
    if (!token) continue
    if (!ID.test(token)) throw new Error(`${label}要填数字，一行一个`)
    ids.push(token)
  }
  return ids
}

/**
 * 私聊、群聊分开填号码。私聊留空时发给主人；群聊留空则不发群。
 * 返回宿主要的 private:QQ号 / group:群号。
 */
export function parseTargets(privateChats, groupChats, ownerQQ) {
  const groups = readIds(groupChats, '群号')
  let privates = readIds(privateChats, '私聊 QQ 号')
  if (!privates.length && ID.test(String(ownerQQ || '').trim())) privates = [String(ownerQQ).trim()]
  const chats = [...new Set([
    ...privates.map(id => `private:${id}`),
    ...groups.map(id => `group:${id}`),
  ])]
  if (!chats.length) throw new Error('没有可发送的聊天：私聊留空时会发给主人，请先填写主人 QQ')
  return chats
}

/** 旧设置里的 private: / group: 拆成两栏号码。认不出的片段丢掉。 */
export function splitLegacyTargets(raw) {
  const privates = []
  const groups = []
  for (const part of String(raw ?? '').split(/[\s,，]+/)) {
    const matched = part.trim().match(/^(private|group):([1-9]\d*)$/i)
    if (!matched) continue
    ;(matched[1].toLowerCase() === 'group' ? groups : privates).push(matched[2])
  }
  return {
    privateChats: [...new Set(privates)].join('\n'),
    groupChats: [...new Set(groups)].join('\n'),
  }
}
