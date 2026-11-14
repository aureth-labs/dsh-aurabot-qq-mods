// 长夜如梦 · Aurabot 模块
//
// 她有一副会累的身体：
// - 精力 / 疲劳期 / 最晚睡觉时间
// - 四段睡眠（刚入睡、浅层、深度、REM），90 分钟一个周期
// - 睡着时按概率被叫醒，深睡最难叫
// - 只在 REM 做梦，梦按 1~5 级衰减，醒来只记得最强的那个
// - 睡前道别、收线识别、起床点浮动
//
// 醒后的「爬楼」只记会话清单，不生成爬楼语；梦的正文只留在本模块的私人记录里，
// 不进共享记忆，避免私人内容进到群聊上下文。

import { isClosing, closeMinutes, isAskingMe } from './close.mjs'
import { configureClock, wall } from './clock.mjs'
import { createLullaby, isFarewell } from './lullaby.mjs'
import { Dreamer } from './dream.mjs'
import { AWAKE, ASLEEP, NightService } from './state.mjs'
import * as energy from './energy.mjs'
import * as stages from './stages.mjs'

const DEFAULTS = {
  enabled: true,
  wakeTime: '08:00',
  wakeJitterMinutes: 40,
  nightFatigue: '23:30-07:00',
  noonFatigue: '13:00-14:30',
  latestSleepTime: '02:30',
  allowSleep: true,
  energyMax: 100,
  energyPerMinute: 0.8,
  energyPerMessage: 4,
  energyRecoverPerMinute: 1.5,
  energyAfterWake: 35,
  minTurnsBeforeSleep: 8,
  noonNapMinutes: 60,
  noonNapJitterMinutes: 15,
  wakingTimeoutMinutes: 5,
  crawlEnabled: true,

  stageEnabled: true,
  stageCycleMinutes: 90,
  stageN1Minutes: 8,
  stageDeepMaxMinutes: 36,
  stageDeepDecay: 0.28,
  stageRemBaseMinutes: 10,
  stageRemGrowMinutes: 6,
  stageRemMaxMinutes: 28,
  stageNoonLightOnly: true,

  dreamEnabled: true,
  dreamInRemOnly: true,
  dreamStartAfterMinutes: 60,
  dreamIntervalMinutes: 60,
  dreamMaxPerSleep: 8,
  dreamMaxTokens: 900,
  dreamTags: '旧房子,走不完的路,熟人,水,飞,找东西,错过,小时候,雨,光',
  noonDreamChance: 0.5,

  wakeMode: 'private_only',
  wakeWindowMinutes: 10,
  wakeStartCount: 2,
  wakeStepCount: 4,

  farewellEnabled: true,
  farewellUseLlm: false,

  closeEnabled: true,
  closeSleepStrength: 'strong',
  byeMuteMinutes: 30,
  noonMuteMinutes: 75,

  morningGreeting: false,

  timeZone: 'Asia/Shanghai',
}

const SETTINGS = [
  { key: 'enabled', label: '启用长夜如梦', type: 'switch' },
  { key: 'allowSleep', label: '允许真睡（关掉只算精力，不进入睡眠）', type: 'switch' },

  { key: 'wakeTime', label: '起床点（HH:MM）', type: 'text' },
  { key: 'wakeJitterMinutes', label: '起床浮动（±分钟，最多 90）', type: 'number' },
  { key: 'latestSleepTime', label: '最晚睡觉时间（HH:MM）', type: 'text' },
  { key: 'nightFatigue', label: '夜间疲劳时段（如 23:30-07:00）', type: 'text' },
  { key: 'noonFatigue', label: '午间疲劳时段（如 13:00-14:30）', type: 'text' },
  { key: 'noonNapMinutes', label: '午睡时长（分钟）', type: 'number' },
  { key: 'noonNapJitterMinutes', label: '午睡浮动（±分钟）', type: 'number' },

  { key: 'energyMax', label: '精力上限', type: 'number' },
  { key: 'energyPerMinute', label: '疲劳期每分钟消耗', type: 'number' },
  { key: 'energyPerMessage', label: '疲劳期每条消息消耗', type: 'number' },
  { key: 'energyRecoverPerMinute', label: '非疲劳期每分钟恢复', type: 'number' },
  { key: 'energyAfterWake', label: '爬起来后的精力', type: 'number' },
  { key: 'minTurnsBeforeSleep', label: '疲劳期至少聊几轮才睡', type: 'number' },

  { key: 'stageEnabled', label: '启用睡眠阶段', type: 'switch' },
  { key: 'stageCycleMinutes', label: '睡眠周期（分钟）', type: 'number' },
  { key: 'stageN1Minutes', label: '刚入睡时长（分钟）', type: 'number' },
  { key: 'stageDeepMaxMinutes', label: '首个周期深睡上限（分钟）', type: 'number' },
  { key: 'stageRemMaxMinutes', label: 'REM 上限（分钟）', type: 'number' },

  { key: 'dreamEnabled', label: '做梦', type: 'switch' },
  { key: 'dreamInRemOnly', label: '只在 REM 阶段做梦', type: 'switch' },
  { key: 'dreamStartAfterMinutes', label: '入睡多久后开始做梦', type: 'number' },
  { key: 'dreamIntervalMinutes', label: '两段梦最短间隔', type: 'number' },
  { key: 'dreamMaxPerSleep', label: '一次睡眠最多几段梦', type: 'number' },
  { key: 'dreamMaxTokens', label: '梦的最大输出 token', type: 'number' },
  { key: 'dreamTags', label: '梦的意象池（逗号分隔）', type: 'textarea' },
  { key: 'noonDreamChance', label: '午睡做梦概率（0~1）', type: 'number' },

  { key: 'wakeMode', label: '谁能叫醒她', type: 'select', options: [
    { label: '谁都不叫', value: 'never' },
    { label: '只有私聊', value: 'private_only' },
    { label: '私聊和群聊（群里要 @）', value: 'both' },
  ] },
  { key: 'wakeWindowMinutes', label: '唤醒计数窗口（分钟）', type: 'number' },
  { key: 'wakeStartCount', label: '第几条开始掷骰', type: 'number' },
  { key: 'wakeStepCount', label: '再几条必醒', type: 'number' },

  { key: 'farewellEnabled', label: '睡前道别', type: 'switch' },
  { key: 'farewellUseLlm', label: '道别用模型生成（更自然，费 token）', type: 'switch' },

  { key: 'closeEnabled', label: '识别对方收线', type: 'switch' },
  { key: 'closeSleepStrength', label: '什么强度才真睡', type: 'select', options: [
    { label: '只有「晚安 / 我睡了」这种强收线', value: 'strong' },
    { label: '强收线和中收线（拜拜 / 先这样）都睡', value: 'medium' },
  ] },
  { key: 'byeMuteMinutes', label: '中/弱收线后闭嘴多久（分钟）', type: 'number' },
  { key: 'noonMuteMinutes', label: '午睡收线后闭嘴多久（分钟）', type: 'number' },

  { key: 'morningGreeting', label: '自然醒后给主人发早安', type: 'switch' },
  { key: 'timeZone', label: '作息按哪个时区（容器跑 UTC 时要填）', type: 'text' },
]

function cfgOf(api) {
  const s = api.settings() || {}
  const n = (key, fallback) => {
    const value = Number(s[key])
    return Number.isFinite(value) ? value : fallback
  }
  const b = (key, fallback) => (typeof s[key] === 'boolean' ? s[key] : fallback)
  const str = (key, fallback) => String(s[key] ?? fallback ?? '').trim()
  const tags = Array.isArray(s.dreamTags) ? s.dreamTags : String(s.dreamTags || '').split(/[,，\n]/)
  return {
    enabled: b('enabled', DEFAULTS.enabled),
    allowSleep: b('allowSleep', DEFAULTS.allowSleep),
    wakeTime: str('wakeTime', DEFAULTS.wakeTime),
    wakeJitterMinutes: n('wakeJitterMinutes', DEFAULTS.wakeJitterMinutes),
    latestSleepTime: str('latestSleepTime', DEFAULTS.latestSleepTime),
    nightFatigue: str('nightFatigue', DEFAULTS.nightFatigue),
    noonFatigue: str('noonFatigue', DEFAULTS.noonFatigue),
    noonNapMinutes: n('noonNapMinutes', DEFAULTS.noonNapMinutes),
    noonNapJitterMinutes: n('noonNapJitterMinutes', DEFAULTS.noonNapJitterMinutes),
    wakingTimeoutMinutes: n('wakingTimeoutMinutes', DEFAULTS.wakingTimeoutMinutes),
    crawlEnabled: b('crawlEnabled', DEFAULTS.crawlEnabled),

    energyMax: n('energyMax', DEFAULTS.energyMax),
    energyPerMinute: n('energyPerMinute', DEFAULTS.energyPerMinute),
    energyPerMessage: n('energyPerMessage', DEFAULTS.energyPerMessage),
    energyRecoverPerMinute: n('energyRecoverPerMinute', DEFAULTS.energyRecoverPerMinute),
    energyAfterWake: n('energyAfterWake', DEFAULTS.energyAfterWake),
    minTurnsBeforeSleep: n('minTurnsBeforeSleep', DEFAULTS.minTurnsBeforeSleep),

    stageEnabled: b('stageEnabled', DEFAULTS.stageEnabled),
    stageCycleMinutes: n('stageCycleMinutes', DEFAULTS.stageCycleMinutes),
    stageN1Minutes: n('stageN1Minutes', DEFAULTS.stageN1Minutes),
    stageDeepMaxMinutes: n('stageDeepMaxMinutes', DEFAULTS.stageDeepMaxMinutes),
    stageDeepDecay: n('stageDeepDecay', DEFAULTS.stageDeepDecay),
    stageRemBaseMinutes: n('stageRemBaseMinutes', DEFAULTS.stageRemBaseMinutes),
    stageRemGrowMinutes: n('stageRemGrowMinutes', DEFAULTS.stageRemGrowMinutes),
    stageRemMaxMinutes: n('stageRemMaxMinutes', DEFAULTS.stageRemMaxMinutes),
    stageNoonLightOnly: b('stageNoonLightOnly', DEFAULTS.stageNoonLightOnly),

    dreamEnabled: b('dreamEnabled', DEFAULTS.dreamEnabled),
    dreamInRemOnly: b('dreamInRemOnly', DEFAULTS.dreamInRemOnly),
    dreamStartAfterMinutes: n('dreamStartAfterMinutes', DEFAULTS.dreamStartAfterMinutes),
    dreamIntervalMinutes: n('dreamIntervalMinutes', DEFAULTS.dreamIntervalMinutes),
    dreamMaxPerSleep: n('dreamMaxPerSleep', DEFAULTS.dreamMaxPerSleep),
    dreamMaxTokens: n('dreamMaxTokens', DEFAULTS.dreamMaxTokens),
    dreamTags: tags.map((x) => String(x).trim()).filter(Boolean),
    noonDreamChance: n('noonDreamChance', DEFAULTS.noonDreamChance),

    wakeMode: str('wakeMode', DEFAULTS.wakeMode),
    wakeWindowMinutes: n('wakeWindowMinutes', DEFAULTS.wakeWindowMinutes),
    wakeStartCount: n('wakeStartCount', DEFAULTS.wakeStartCount),
    wakeStepCount: n('wakeStepCount', DEFAULTS.wakeStepCount),

    farewellEnabled: b('farewellEnabled', DEFAULTS.farewellEnabled),
    farewellUseLlm: b('farewellUseLlm', DEFAULTS.farewellUseLlm),

    closeEnabled: b('closeEnabled', DEFAULTS.closeEnabled),
    closeSleepStrength: str('closeSleepStrength', DEFAULTS.closeSleepStrength),
    byeMuteMinutes: n('byeMuteMinutes', DEFAULTS.byeMuteMinutes),
    noonMuteMinutes: n('noonMuteMinutes', DEFAULTS.noonMuteMinutes),

    morningGreeting: b('morningGreeting', DEFAULTS.morningGreeting),

    timeZone: str('timeZone', DEFAULTS.timeZone),
  }
}

const dayText = (ts) => {
  if (!ts) return ''
  const w = wall(ts)
  return `${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`
}

const levelStars = (level) => '★'.repeat(Math.max(1, Math.min(5, Number(level) || 1)))

export default {
  id: 'night',
  name: '长夜如梦',
  version: '1.0.0',
  api: 1,
  description: '她会在夜里犯困、睡着、做梦，睡着时叫不一定醒；醒来记得多少，看梦有多重。',
  defaults: DEFAULTS,
  settings: SETTINGS,
  panel: 'panel.js',

  async setup(api) {
    const cfgOfFn = () => {
      const c = cfgOf(api)
      // 每次读配置都同步一次时区：容器可能跑在 UTC，面板上填 Asia/Shanghai 就按它算作息
      configureClock({ timeZone: c.timeZone })
      return c
    }
    cfgOfFn()
    const lullaby = createLullaby()
    const dreamer = new Dreamer({ api, cfgOf: cfgOfFn, log: api.log })
    const service = new NightService({ api, cfgOf: cfgOfFn, dreamer, lullaby, log: api.log })
    await service.load()

    // ---------------------------------------------------------------- 同源校验
    // 面板路由默认不做来源检查，而 /dreams 会把梦境正文整段吐出去 ——
    // 相当于「发一个链接就能读到她的梦」。DSH 的 csrfBlocked 只拦写方法
    // （POST/PUT…），GET 是放行的，所以这道闸得自己加。
    // 所有接口都只做同源校验，不按方法区分 —— 因为面板运行时的 call()
    // 在没传 body 时用的是 GET（`body === undefined ? get(...) : post(...)`），
    // 比如「叫醒」按钮就是 `call('/wake')` 一个纯 GET。按方法拒绝会把面板自己挡死。
    // 跨站请求（带外站 Origin 或 Sec-Fetch-Site: cross-site）一律拒绝，
    // 那才是真正要防的东西。
    const hostAllowed = (h) => {
      const host = String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/\.$/, '')
      if (!host) return false
      if (host === 'localhost' || host.endsWith('.localhost')) return true
      if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
      if (host.startsWith('127.')) return true
      if (host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return true
      try {
        const pub = String(api.config?.()?.security?.publicHostname || '').trim().toLowerCase()
        if (pub && host === pub) return true
      } catch {}
      return false
    }

    /** allowGet=true 表示这是读接口。非浏览器客户端（不带这两个头）放行，它们不是 CSRF 载体。 */
    const sameOriginOk = (req, allowGet) => {
      const method = String(req?.method || 'GET').toUpperCase()
      if (!allowGet && (method === 'GET' || method === 'HEAD')) return false
      const site = String(req?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
      if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false
      const origin = String(req?.headers?.origin || '').trim()
      if (origin) {
        let oh = ''
        try { oh = new URL(origin).hostname } catch { return false }
        if (!hostAllowed(oh)) return false
      }
      return true
    }

    const DENY_READ = { ok: false, denied: true, message: '只接受同源请求（防跨站读取作息和梦境）' }
    const DENY_WRITE = { ok: false, denied: true, message: '只接受同源请求（防跨站改她的作息）' }

    let lastDreamAttempt = 0
    let farewellBusy = false

    const morningGreeting = async () => {
      const cfg = cfgOfFn()
      if (!cfg.morningGreeting) return
      const owner = api.config()?.ownerQQ
      if (!owner) return
      const dream = service.state.morningDreamId ? dreamer.byId(service.state.morningDreamId) : null
      let text = ''
      try {
        text = await api.ask({
          system: '你刚睡醒。用一句很短的话告诉对方你醒了，可以提一下梦，但别解释设定。不要用括号动作。',
          text: `现在是${energy.clockText(Date.now())}。${dream ? `你记得的梦：${String(dream.text).slice(0, 200)}` : '你不记得做过梦。'}`,
          maxTokens: 120,
        })
      } catch {
        text = ''
      }
      text = String(text || '').trim() || '早，我醒了。'
      try {
        await api.send(`private:${owner}`, text)
      } catch (error) {
        api.log.warn('长夜：早安消息发送失败 ' + (error?.message || error))
      }
    }

    const maybeDream = async () => {
      const cfg = cfgOfFn()
      const s = service.state
      if (!cfg.enabled || !cfg.dreamEnabled || s.mode !== ASLEEP) return
      const now = Date.now()
      const stage = service.stage(now)
      if (!dreamer.due({ sleepAt: s.sleepAt, already: s.dreamCount, stage, dreamSkip: s.dreamSkip, now })) return
      const interval = Math.max(5, Number(cfg.dreamIntervalMinutes) || 60) * 60_000
      if (lastDreamAttempt && now - lastDreamAttempt < interval) return
      lastDreamAttempt = now
      s.dreamCount += 1
      await service.save()
      await dreamer.make({ kind: s.sleepKind })
    }

    // ---------------------------------------------------------------- 消息
    api.on('message', async (msg) => {
      const cfg = cfgOfFn()
      if (!cfg.enabled) return false

      // 主人自己在私聊里说话，就别再吊着「闭嘴」——不然一句「好」能让她沉默半小时
      const ownerPrivate = msg.kind === 'private' && Boolean(api.isOwner?.(msg.userId))
      if (ownerPrivate) {
        try {
          if (api.core?.mutes?.muted?.(msg.chatId)) api.core.mutes.clear(msg.chatId)
        } catch {
          // 没有这个接口就算了
        }
      }

      const result = await service.onMessage(msg)
      if (result.block) return true
      if (result.woke) return false

      // 精力耗尽：先让她把道别说完，等这条回复发出去再躺下
      if (result.sleepTriggered && cfg.allowSleep) {
        service.requestSleep('energy', result.kind || 'night', msg.chatId)
      }

      if (service.state.mode === AWAKE && !service.pendingSleep && cfg.closeEnabled && !isAskingMe(msg.text)) {
        const [closing, strength, word] = isClosing(msg.text, {})
        if (closing) {
          const wantSleep = strength === 'strong' || (cfg.closeSleepStrength === 'medium' && strength === 'medium')
          if (wantSleep && cfg.allowSleep) {
            service.requestSleep('talk', ['午', '眯', '盹', '躺'].some((m) => word.includes(m)) ? 'noon' : 'night', msg.chatId)
          } else if (!ownerPrivate && strength !== 'weak') {
            // 「嗯 / 好 / 收到」这种短答不是收线，别拿它当理由闭嘴；
            // 主人私聊更不该被静默——她不理人是最难解释的状态。
            const minutes = closeMinutes(cfg, strength, word)
            try {
              api.core?.mutes?.set?.(msg.chatId, minutes)
            } catch {
              // 没有闭嘴接口就只当没听见
            }
          }
        }
      }
      return false
    })

    // ---------------------------------------------------------------- 提示词
    api.on('prompt', async (content, info) => {
      const chat = info?.chat
      if (!chat || chat.kind === 'system') return content
      const hint = service.promptHint(chat)
      if (!hint) return content
      return [{ type: 'text', text: hint }, ...content]
    })

    // ---------------------------------------------------------------- 道别改写
    api.on('reply', async (text, info) => {
      // 正在醒的时候，回了哪个会话就算那个会话爬完了
      if (service.state.mode === 'waking' && info?.chatId) {
        await service.crawlDone(String(info.chatId))
      }
      const pending = service.pendingSleep
      if (!pending || pending.farewellDone || farewellBusy) return
      // 只给她要睡的那个会话加道别，别的地方照常说话
      if (pending.chatId && info?.chatId && pending.chatId !== info.chatId) return
      const cfg = cfgOfFn()
      const kind = pending.kind || 'night'
      let line = ''
      if (cfg.farewellEnabled) {
        if (cfg.farewellUseLlm) {
          farewellBusy = true
          try {
            line = await api.ask({
              system: '你要去睡了。写一句很短、自然、像随口说的道别，不要解释，不要问问题，不要括号动作。',
              text: `现在是${energy.clockText(Date.now())}，${kind === 'noon' ? '你要去午睡' : '你要去睡了'}。对方最后说：${info?.userText || ''}`,
              maxTokens: 80,
            })
          } catch {
            line = ''
          } finally {
            farewellBusy = false
          }
        }
        line = String(line || '').trim() || lullaby.compose({ kind, sessionId: info?.chatId })
      }
      pending.farewellDone = true
      // 兜底：activity 事件在某些路径（模拟测试、直接 deliver）不一定来，
      // 道别说过两秒就躺下，别让她一直挂着「马上要睡」的状态。
      api.later(2000, async () => {
        if (!service.pendingSleep) return
        const p = service.pendingSleep
        service.pendingSleep = null
        const ok = await service.sleepNow({ reason: p.reason, kind: p.kind, byUser: false })
        if (ok) lastDreamAttempt = 0
      })
      if (!line) return
      if (isFarewell(text)) return
      return text ? `${text}\n${line}` : line
    })

    // ---------------------------------------------------------------- 发出去之后才真正躺下
    api.on('activity', async (a) => {
      if (a?.kind !== 'out') return
      // 正在醒的时候，回了哪个会话就算爬完哪个；全爬完就正式醒
      if (service.state.mode === 'waking' && a.chatId) {
        await service.crawlDone(String(a.chatId))
        return
      }
      const pending = service.pendingSleep
      if (!pending) return
      if (pending.chatId && a.chatId && pending.chatId !== a.chatId) return
      service.pendingSleep = null
      const ok = await service.sleepNow({ reason: pending.reason, kind: pending.kind, byUser: false })
      if (ok) lastDreamAttempt = 0
    })

    // ---------------------------------------------------------------- 心跳
    api.every(60_000, async () => {
      if (!cfgOfFn().enabled) return
      const events = await service.tick()
      if (events.includes('wake_natural')) {
        lastDreamAttempt = 0
        await morningGreeting()
      }
      await maybeDream()
    }, '长夜心跳')

    // ---------------------------------------------------------------- 命令
    api.command({
      name: '长夜',
      desc: '看长夜如梦状态',
      run: async () => service.statusText(),
    })

    api.command({
      name: '睡',
      desc: '让她立刻去睡（可带「午」睡午觉）',
      run: async (arg) => {
        const kind = /午/.test(String(arg || '')) ? 'noon' : 'night'
        const ok = await service.sleepNow({ reason: 'manual', kind, byUser: true })
        if (!ok) return '现在睡不了（允许真睡关着）'
        return `好，去睡了。${lullaby.compose({ kind })}`
      },
    })

    api.command({
      name: '醒',
      desc: '把她叫醒',
      run: async () => {
        await service.wakeNow({ reason: 'manual' })
        service.pendingSleep = null
        return `醒了。${service.statusText()}`
      },
    })

    api.command({
      name: '梦',
      desc: '看她还记得的梦',
      run: async (arg, msg) => {
        if (msg?.kind === 'group') return '梦是私人的，私聊我再看。'
        const list = dreamer.living().slice(0, 6)
        if (!list.length) return '最近没做过记得住的梦。'
        return list
          .map((d) => `${levelStars(d.level)} ${dayText(d.createdAt)} ${(d.tags || []).join('、')}\n${String(d.text).slice(0, 160)}`)
          .join('\n\n')
      },
    })

    api.command({
      name: '做梦',
      desc: '现在做一段梦（调试用，得先睡着）',
      run: async (arg, msg) => {
        if (msg?.kind === 'group') return '梦是私人的，私聊我。'
        if (service.state.mode !== ASLEEP) return '得先睡着才能做梦。'
        const entry = await dreamer.make({ kind: service.state.sleepKind })
        if (!entry) return '这次没做出梦来。'
        return `${levelStars(entry.level)} ${(entry.tags || []).join('、')}\n${entry.text}`
      },
    })

    // ---------------------------------------------------------------- 工具
    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      const tools = [
        api.defineTool({
          name: 'night_status',
          description: '看她现在的作息状态：醒着还是睡着、精力、睡眠阶段、起床点。聊到困不困、睡没睡、几点醒时用。',
          properties: {},
          required: [],
          execute: async () => ({ ok: true, message: service.statusText() }),
        }),
      ]
      if (chat.kind === 'private') {
        tools.push(api.defineTool({
          name: 'recall_dream',
          description: '回想最近做过的梦。只有私下能看；聊到做梦、梦到什么时用。',
          properties: { query: { type: 'string', description: '想找的关键词，可不填' } },
          required: [],
          execute: async ({ query }) => {
            const list = dreamer.recall(query || '', 3)
            if (!list.length) return { ok: true, message: '最近没有记得住的梦。' }
            return {
              ok: true,
              message: list
                .map((d) => `${levelStars(d.level)} ${(d.tags || []).join('、')}：${String(d.text).slice(0, 220)}`)
                .join('\n'),
            }
          },
        }))
      }
      return tools
    })

    // ---------------------------------------------------------------- 规则
    api.rule((kind) => [
      '你有作息：会困、会睡着、会做梦。睡着时别人叫你，你不一定醒；被叫醒时可能还带着梦里的感觉。',
      '不要主动解释「长夜如梦」「精力值」「睡眠阶段」这些设定。用身体感觉说：困、睁不开眼、脑子发沉、刚醒。',
      kind === 'social'
        ? '群里不要展开梦的内容，也不要提私下做的梦。'
        : '梦的内容只私下说，别当成真实发生的事。',
    ])

    // ---------------------------------------------------------------- 面板接口
    api.route('/state', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_READ
      const ownerChat = `private:${api.config()?.ownerQQ || ''}`
      let muted = false
      try {
        muted = Boolean(api.core?.mutes?.muted?.(ownerChat))
      } catch {
        muted = false
      }
      return { ok: true, ...service.snapshot(), muted }
    })

    api.route('/dreams', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_READ
      const query = api.core?.http?.query?.(req) || {}
      const all = String(query.all || '') === '1'
      const items = all ? dreamer.items : dreamer.living()
      return {
        ok: true,
        items: items
          .slice()
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .map((d) => ({
            id: d.id,
            createdAt: d.createdAt,
            level: d.level,
            stars: levelStars(d.level),
            tags: d.tags || [],
            text: d.text,
            pinned: Boolean(d.pinned),
            strength: Math.round(dreamer.strengthOf(d) * 100),
            kind: d.kind || 'night',
          })),
      }
    })

    api.route('/sleep', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      const kind = String(body?.kind || '') === 'noon' ? 'noon' : 'night'
      const ok = await service.sleepNow({ reason: 'panel', kind, byUser: true })
      return { ok, message: ok ? '去睡了' : '允许真睡关着' }
    })

    api.route('/wake', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      await service.wakeNow({ reason: 'panel' })
      service.pendingSleep = null
      return { ok: true, message: '叫醒了' }
    })

    // 收线识别偶尔会误判成「她在生气不理人」，给个手动的出口
    api.route('/unmute', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      const chatId = String(body?.chatId || `private:${api.config()?.ownerQQ || ''}`)
      const was = Boolean(api.core?.mutes?.muted?.(chatId))
      try {
        api.core?.mutes?.clear?.(chatId)
      } catch {
        return { ok: false, message: '这个版本没有闭嘴接口' }
      }
      return { ok: true, wasMuted: was, message: was ? '解除了，她能说话了' : '本来就没闭嘴' }
    })

    api.route('/dream', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      if (service.state.mode !== ASLEEP && !body?.force) return { ok: false, message: '得先睡着' }
      const entry = await dreamer.make({ kind: service.state.sleepKind })
      return entry
        ? { ok: true, message: '做了一段梦', dream: entry }
        : { ok: false, message: '这次没做出梦来' }
    })

    api.route('/dreams/delete', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      return { ok: dreamer.remove(String(body?.id || '')) }
    })

    api.route('/dreams/pin', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_WRITE
      const body = await api.core.http.body(req)
      return { ok: dreamer.setPinned(String(body?.id || ''), Boolean(body?.pinned)) }
    })

    api.route('/health', async (req) => {
      if (!sameOriginOk(req, true)) return DENY_READ
      return {
      ok: true,
      id: 'night',
      version: '1.0.0',
      mode: service.state.mode,
      energy: Math.round(service.state.energy),
      dreams: dreamer.items.length,
      stages: stages.STAGE_KEYS,
      }
    })

    api.onDispose(async () => {
      await service.save()
    })

    api.log.info(`长夜如梦已启动：${service.statusText()}`)
    return {
      service,
      dreamer,
      status: () => service.statusText(),
      snapshot: () => service.snapshot(),
      sleep: (kind = 'night') => service.sleepNow({ reason: 'api', kind, byUser: true }),
      wake: () => service.wakeNow({ reason: 'api' }),
      dream: () => dreamer.make({ kind: service.state.sleepKind }),
    }
  },
}
