// 生日管家：记下群友 / 好友的生日，在可设定的作息时间窗里随机挑一分钟送祝福。
// 生日来源优先级：设置页手填 > 个人资料（简介 / 签名） > 聊天里的自述。
// 只使用公开接口：api.on / api.settings / api.saveSettings / api.onebot / api.sendText / api.dataDir / api.every / api.log。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const QQ_RE = /^\d{5,12}$/
const PROFILE_TTL = 7 * 24 * 60 * 60 * 1000
const RETRY_GAP = 10 * 60 * 1000
const MAX_TEXT = 200

const DEFAULTS = {
  termsAccepted: false,
  enabled: true,
  wakeStart: 9,
  wakeEnd: 21,
  chatMode: 'group',
  groupIds: '',
  mention: true,
  template: '生日快乐！今天是你生日，祝你天天开心。',
  birthdays: '',
  learnProfile: true,
  learnChat: true,
}

const pad2 = (n) => String(n).padStart(2, '0')

function validDate (month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(2024, month, 0).getDate()
}

/** 解析生日表：一行一条，`QQ=MM-DD` 或 `QQ=MM-DD=称呼`。改坏了就跳过那一行。 */
export function parseTable (text) {
  const map = new Map()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\d{5,12})\s*[=＝]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?\s*(?:[=＝]\s*(.+))?$/)
    if (!m) continue
    const month = Number(m[2])
    const day = Number(m[3])
    if (!validDate(month, day)) continue
    map.set(m[1], { qq: m[1], month, day, name: (m[4] || '').trim().slice(0, 20) })
  }
  return map
}

/** 写回设置页：按月日排序，方便人看和改。 */
export function formatTable (map) {
  return [...map.values()]
    .sort((a, b) => a.month - b.month || a.day - b.day || a.qq.localeCompare(b.qq))
    .map((e) => `${e.qq}=${pad2(e.month)}-${pad2(e.day)}${e.name ? '=' + e.name : ''}`)
    .join('\n')
}

/** 同一天、同一个人、同一个窗口，算出来的分钟固定，重启后不会换时间点。 */
export function targetMinute (dateKey, qq, from, to) {
  const span = Math.max(1, to - from)
  let h = 2166136261
  for (const ch of `${dateKey}|${qq}|birthday`) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return from + (Math.abs(h) % span)
}

/** 聊天里的自述，只认「我」开头的生日，避免把别人的生日记到发送者头上。 */
export function fromChatText (text) {
  const t = String(text || '').slice(0, MAX_TEXT)
  const grab = (m) => {
    if (!m) return null
    const month = Number(m[1])
    const day = Number(m[2])
    return validDate(month, day) ? { month, day } : null
  }
  return grab(t.match(/我(?:的)?生日[^0-9]{0,8}(?:\d{4}\s*[年/.-]\s*)?(\d{1,2})\s*[月/.-]\s*(\d{1,2})/)) ||
    grab(t.match(/我[^\n。！？]{0,10}?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号][^\n]{0,6}生日/)) ||
    grab(t.match(/我[^0-9\n]{0,6}(?:\d{4}\s*[年/.-]\s*)?(\d{1,2})\s*[月/.-]\s*(\d{1,2})[^0-9\n]{0,4}生日/))
}

/** 个人资料里的生日，必须带「生日 / 出生」字样，避免把注册日期当生日。 */
export function fromProfileText (text) {
  const t = String(text || '').slice(0, 500)
  if (!/生日|出生/.test(t)) return null
  const m = t.match(/(?:生日|出生)[^0-9]{0,12}(?:\d{4}\s*[年/.-]\s*)?(\d{1,2})\s*[月/.-]\s*(\d{1,2})/)
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  return validDate(month, day) ? { month, day } : null
}

/** 把资料对象里的字符串都翻出来，网关字段名不一样也能扫到简介。 */
function profileStrings (info) {
  const out = []
  const walk = (value, depth) => {
    if (out.length >= 40 || depth > 2 || value === null || value === undefined) return
    if (typeof value === 'string') {
      if (value.trim()) out.push(value)
      return
    }
    if (typeof value !== 'object') return
    for (const v of Object.values(value)) walk(v, depth + 1)
  }
  walk(info, 0)
  return out
}

const clampHour = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function qqList (text) {
  return [...new Set(String(text || '').split(/[\s,，]+/).map((s) => s.trim()).filter((s) => QQ_RE.test(s)))]
}

export default {
  id: 'birthday-keeper',
  name: '生日管家',
  version: '1.0.0',
  api: 1,
  description: '记录生日并在作息时间窗内随机送祝福，可 @ 本人；生日从资料和聊天里自动学习',
  settings: [
    { key: 'termsAccepted', label: '我已阅读并同意《使用协议》', type: 'switch', hint: '协议全文见模块 README 的「使用协议」一节：同意后才会读取个人资料、记录生日并在当天发送一条祝福；数据只存在本机，可随时删除' },
    { key: 'enabled', label: '启用', type: 'switch', hint: '关掉后不学习、不发送' },
    { key: 'wakeStart', label: '作息窗口开始（点）', type: 'number', min: 0, max: 23, hint: '默认 9 点。冬天作息晚就往后调，祝福会落在这个窗口里' },
    { key: 'wakeEnd', label: '作息窗口结束（点）', type: 'number', min: 1, max: 24, hint: '默认 21 点。窗口内随机挑一分钟发送，不是整点定时' },
    { key: 'chatMode', label: '怎么送', type: 'select', options: [
      { value: 'group', label: '在群里 @ 本人' },
      { value: 'private', label: '私聊本人' },
    ], hint: '群聊模式下找不到共同群时，会自动改成私聊' },
    { key: 'groupIds', label: '发送的群', type: 'textarea', placeholder: '123456789', hint: '填群号，每行一个；只在本人所在的群里 @' },
    { key: 'mention', label: '群聊里 @ 本人', type: 'switch', hint: '关掉只发文字，不提醒对方' },
    { key: 'template', label: '祝福语', type: 'textarea', placeholder: DEFAULTS.template, hint: '可用 {name} 代入称呼；留空用默认那句' },
    { key: 'birthdays', label: '生日表', type: 'textarea', placeholder: '123456789=03-14=小明', hint: '一行一条：QQ=月-日 或 QQ=月-日=称呼；只存月和日，不存年份。可以直接改、加、删' },
    { key: 'learnProfile', label: '从群成员资料里学', type: 'switch', hint: '只在群聊里读公开资料卡（简介 / 签名）的「生日 3-14」写法；私聊不读，每人 7 天最多查一次' },
    { key: 'learnChat', label: '从群聊里学', type: 'switch', hint: '只认群里公开说出的「我生日是…」；私聊内容一律不记录' },
  ],

  setup (api) {
    const log = api.log
    const conf = () => ({ ...DEFAULTS, ...(api.settings() || {}) })

    // 首次加载把默认值写进面板，避免设置页一片空白。
    try {
      const cur = api.settings() || {}
      if (Object.keys(DEFAULTS).some((k) => cur[k] === undefined)) api.saveSettings({ ...DEFAULTS, ...cur })
    } catch (error) {
      log.warn('写入生日管家默认设置失败：' + (error && error.message ? error.message : error))
    }

    if (!(api.settings() || {}).termsAccepted) {
      log.info('生日管家：尚未在设置里同意使用协议，不会读取资料、记录生日或发送祝福')
    }

    // ---------- 状态 ----------
    // 只记「今天发过没」「资料多久前查过」「这个生日是谁写进来的」，不存聊天内容。
    let state = { fired: {}, retry: {}, scanned: {}, sources: {}, known: {}, optOut: {} }
    try {
      const raw = JSON.parse(readFileSync(api.dataDir('state.json'), 'utf8'))
      if (raw && typeof raw === 'object') {
        state = {
          fired: raw.fired || {},
          retry: raw.retry || {},
          scanned: raw.scanned || {},
          sources: raw.sources || {},
          known: raw.known || {},
          optOut: raw.optOut || {},
        }
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') log.warn('读取生日管家状态失败：' + error.message)
    }

    function saveState () {
      try {
        const file = api.dataDir('state.json')
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(state, null, 2))
      } catch (error) {
        log.warn('保存生日管家状态失败：' + (error && error.message ? error.message : error))
      }
    }

    /** 没勾「同意使用协议」之前，不读资料、不记录、不发送；删除自己的记录不受限制。 */
    const termsOk = (cfg) => cfg.termsAccepted === true

    const botQQ = () => {
      try {
        return String(api.config().botQQ || '')
      } catch {
        return ''
      }
    }

    /**
     * 用户在设置页手改过生日表时，把对应条目升级成 manual，之后资料和聊天都不会再覆盖它。
     * 识别方式是「这次读到的日期」和「我们上次写进去的」不一样。
     */
    function reconcile (table) {
      let dirty = false
      for (const [qq, e] of table) {
        const value = `${e.month}-${e.day}`
        if (state.known[qq] && state.known[qq] !== value && state.sources[qq] !== 'manual') {
          state.sources[qq] = 'manual'
          dirty = true
        }
        if (!state.sources[qq]) {
          state.sources[qq] = 'manual'
          dirty = true
        }
        if (state.known[qq] !== value) {
          state.known[qq] = value
          dirty = true
        }
      }
      if (dirty) saveState()
    }

    function learn (qq, month, day, name, source) {
      if (!termsOk(conf()) || state.optOut[qq]) return false
      const table = parseTable(conf().birthdays)
      reconcile(table)
      const cur = table.get(qq)
      const src = state.sources[qq]
      if (cur && (src === 'manual' || src === 'profile')) return false
      if (cur && src === 'chat' && source !== 'profile') return false
      if (cur && cur.month === month && cur.day === day) return false
      const next = new Map(table)
      next.set(qq, { qq, month, day, name: name || (cur && cur.name) || '' })
      api.saveSettings({ birthdays: formatTable(next) })
      state.sources[qq] = source
      state.known[qq] = `${month}-${day}`
      saveState()
      log.info(`记下 QQ ${qq} 的生日 ${pad2(month)}-${pad2(day)}（来源：${source === 'profile' ? '个人资料' : '聊天'}）`)
      return true
    }

    // 资料里可能有年龄、性别、等级，统一翻成字符串再找生日。
    async function learnFromProfile (qq) {
      if (state.scanned[qq] && Date.now() - state.scanned[qq] < PROFILE_TTL) return
      state.scanned[qq] = Date.now()
      saveState()
      let info = null
      try {
        const raw = await api.onebot('get_stranger_info', { user_id: Number(qq) })
        info = raw && (raw.data || raw)
      } catch (error) {
        log.debug('查 QQ ' + qq + ' 的资料失败：' + (error && error.message ? error.message : error))
        return
      }
      for (const text of profileStrings(info)) {
        const hit = fromProfileText(text)
        if (hit && learn(qq, hit.month, hit.day, '', 'profile')) return
      }
    }

    // ---------- 发送 ----------
    async function isMember (groupId, qq) {
      try {
        const raw = await api.onebot('get_group_member_info', { group_id: Number(groupId), user_id: Number(qq) })
        const info = raw && (raw.data || raw)
        return Boolean(info && (info.user_id !== undefined || info.userId !== undefined || info.uin !== undefined))
      } catch {
        return false
      }
    }

    function render (template, entry) {
      const tpl = String(template || '').trim() || DEFAULTS.template
      const name = entry.name || '你'
      return tpl.replace(/\{name\}/g, name)
    }

    async function sendWish (entry, cfg) {
      const qq = String(entry.qq)
      const text = render(cfg.template, entry)
      if (cfg.chatMode !== 'private') {
        for (const gid of qqList(cfg.groupIds)) {
          if (!(await isMember(gid, qq))) continue
          const body = (cfg.mention === false ? '' : `<at:${qq}> `) + text
          const ok = await api.sendText(`group:${gid}`, body)
          if (ok !== false) return true
        }
      }
      const ok = await api.sendText(`private:${qq}`, text)
      if (ok === false) log.warn(`给 QQ ${qq} 发生日祝福失败`)
      return ok !== false
    }

    // ---------- 定时 ----------
    const inFlight = new Set()

    function tick () {
      const cfg = conf()
      if (!cfg.enabled || !termsOk(cfg)) return
      const now = new Date()
      const dateKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
      const table = parseTable(cfg.birthdays)
      reconcile(table)
      if (!table.size) return

      const start = clampHour(cfg.wakeStart, 0, 23, 9)
      const end = clampHour(cfg.wakeEnd, 1, 24, 21)
      const from = Math.min(start, end) * 60
      const to = Math.max(start, end) * 60
      const nowMinute = now.getHours() * 60 + now.getMinutes()

      for (const entry of table.values()) {
        if (state.optOut[entry.qq]) continue
        if (entry.month !== now.getMonth() + 1 || entry.day !== now.getDate()) continue
        if (state.fired[entry.qq] === dateKey || inFlight.has(entry.qq)) continue
        if ((state.retry[entry.qq] || 0) > Date.now()) continue
        if (nowMinute < targetMinute(dateKey, entry.qq, from, to)) continue

        inFlight.add(entry.qq)
        sendWish(entry, cfg)
          .then((ok) => {
            if (ok) {
              state.fired[entry.qq] = dateKey
              log.info(`已给 QQ ${entry.qq} 发生日祝福`)
            } else {
              state.retry[entry.qq] = Date.now() + RETRY_GAP
            }
          })
          .catch((error) => {
            state.retry[entry.qq] = Date.now() + RETRY_GAP
            log.warn(`给 QQ ${entry.qq} 发生日祝福出错：${error && error.message ? error.message : error}`)
          })
          .finally(() => {
            inFlight.delete(entry.qq)
            saveState()
          })
      }
    }

    // ---------- 学习 ----------
    const FORGET_RE = /^[#＃]\s*生日\s*(?:忘了我|删除|别记我|退出)$/

    /** 任何人都可以要求删除自己的记录，不需要主人同意，也不受协议开关影响。 */
    async function forget (qq, msg) {
      const table = parseTable(conf().birthdays)
      if (table.delete(qq)) api.saveSettings({ birthdays: formatTable(table) })
      state.optOut[qq] = true
      delete state.sources[qq]
      delete state.known[qq]
      delete state.fired[qq]
      delete state.retry[qq]
      saveState()
      log.info(`按 QQ ${qq} 的要求删除生日记录`)
      try {
        await api.reply(msg, '已删除你的生日记录，之后不会再自动记录或发送祝福。')
      } catch (error) {
        log.debug('回复删除生日记录失败：' + (error && error.message ? error.message : error))
      }
    }

    api.on('message', async (msg) => {
      const cfg = conf()
      if (!msg || msg.kind === 'system') return false
      const qq = String(msg.userId || '')
      if (!QQ_RE.test(qq) || qq === botQQ()) return false

      if (FORGET_RE.test(String(msg.text || '').trim())) {
        await forget(qq, msg)
        return true
      }

      if (!cfg.enabled || !termsOk(cfg) || state.optOut[qq]) return false
      // 只处理群里公开可见的信息：私聊里说的话、资料都不记录，避免把私下内容留档。
      if (msg.kind !== 'group') return false

      const table = parseTable(cfg.birthdays)
      const known = table.has(qq)

      if (cfg.learnChat === true && !known) {
        const hit = fromChatText(msg.text)
        if (hit) learn(qq, hit.month, hit.day, String(msg.nickname || '').slice(0, 12), 'chat')
      }

      if (cfg.learnProfile === true) {
        const src = state.sources[qq]
        if (!known || src === 'chat') await learnFromProfile(qq)
      }
      return false
    })

    api.every(30_000, () => {
      try {
        tick()
      } catch (error) {
        log.warn('生日管家巡检出错：' + (error && error.message ? error.message : error))
      }
    }, '生日管家')

    return {}
  },
}
