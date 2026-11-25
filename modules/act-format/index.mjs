// 动作互动（act-format）
//
// 定位：**观察者**。它永远在 api.on('message') 里返回 false，绝不拦截消息，
// 所以必须排在 night（拦截者）之前注册才有意义 —— 模块目录名 act-format 的字母序在 night 之前。
//
// 职责：
// 1. 把消息里 *动作* / ((动作)) / 〖动作〗 / //动作// 这类包裹文本解析成结构化动作；
// 2. 醒着时：记录结构化动作（供别的模块/面板消费），并给模型注入一条「对方刚才的动作」提示；
// 3. 睡着时：**不记录任何结构化动作**，只累计一个模糊体感残留；醒来后只注入模糊描述，
//    让「睡眠期间发生的动作」变成不可准确回溯的东西（后门）。
//
// 睡眠判定以长夜如梦为准（它管睡/醒），不在场时退化成「没在睡」。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { actionWeight, parseMessage, DEFAULT_FORMATS } from './lib/parse.mjs'

const DEFAULTS = {
  enabled: true,
  // 睡眠状态来源：auto=自动探测已安装的睡眠模块；也可指定某一模块，或用 setSleepProbe 注入
  sleepSource: 'auto',
  inject: true,                 // 醒着时把对方动作注入上下文
  formats: DEFAULT_FORMATS.join(','),
  injectChars: 200,             // 单条动作注入上限
  keepHistory: 200,             // 结构化动作保留条数
  actionFreshMinutes: 5,        // 动作提示在多少分钟内仍然注入
  sleepResidue: true,           // 睡眠期间只留模糊体感（关掉=睡眠期间也结构化记录）
  residueDecayPerHour: 8,       // 体感残留每小时衰减多少
  residueInjectAt: 20,          // 残留超过多少才注入模糊提示
  residueRepeatMinutes: 15,     // 同一段残留最短重复提示间隔
}

const emptyState = () => ({
  actions: [],
  residue: 0,
  residueAt: 0,
  residueInjectAt: 0,
  asleepSeen: false,
  suppressedCount: 0,
  chats: {},
})

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || 0))
}

export default {
  id: 'act-format',
  name: '动作互动',
  version: '0.2.0',
  api: 1,
  description:
    '把 *动作* 这类包裹文本解析成结构化动作（观察者，不拦消息）；睡眠期间只保留模糊体感残留，不记录具体发生了什么',
  flag: 'enabled',
  defaults: DEFAULTS,
  // 面板字段全部用声明式表单，省掉自定义 panel.js
  settings: [
    { key: 'enabled', label: '启用动作解析', type: 'switch' },
    {
      key: 'sleepSource',
      label: '睡眠状态来源',
      type: 'select',
      options: [
        { label: '自动探测（优先用已装的睡眠模块）', value: 'auto' },
        { label: '长夜如梦（night）', value: 'night' },
        { label: '生理模块（real-life）', value: 'real-life' },
        { label: '自定义端口（api.use(\'act-format\').setSleepProbe）', value: 'custom' },
        { label: '不判断（永远当醒着）', value: 'none' },
      ],
    },
    { key: 'inject', label: '把对方动作注入上下文', type: 'switch', hint: '只在消息里真的带动作时才注入，普通聊天不花 token' },
    {
      key: 'formats',
      label: '识别的包裹格式',
      type: 'text',
      hint: 'star=*动作*  double-paren=((动作))  corner-paren=〖动作〗  slash=//动作//（逗号分隔）',
    },
    { key: 'actionFreshMinutes', label: '动作提示有效期（分钟）', type: 'number' },
    { key: 'keepHistory', label: '结构化动作保留条数', type: 'number' },
    { key: 'sleepResidue', label: '睡眠期间只留模糊体感', type: 'switch', hint: '开着：睡觉时收到的动作不记录，只累计说不清的身体感觉' },
    { key: 'residueDecayPerHour', label: '体感残留每小时衰减', type: 'number' },
    { key: 'residueInjectAt', label: '残留超过多少才提示', type: 'number' },
    { key: 'residueRepeatMinutes', label: '残留提示最短重复间隔（分钟）', type: 'number' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const formats = () => String(cfg().formats || '').trim() || DEFAULT_FORMATS.join(',')
    const file = api.dataDir('state.json')
    mkdirSync(dirname(file), { recursive: true })

    let st = emptyState()
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        if (raw && typeof raw === 'object') {
          st = { ...emptyState(), ...raw }
          if (!Array.isArray(st.actions)) st.actions = []
          if (!st.chats || typeof st.chats !== 'object') st.chats = {}
        }
      }
    } catch (error) {
      api.log.warn('动作模块状态读取失败，按空状态启动：' + (error?.message || error))
    }

    const save = () => {
      try {
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8')
        renameSync(tmp, file)
      } catch (error) {
        api.log.warn('动作模块状态保存失败：' + (error?.message || error))
      }
    }

    // ---------------------------------------------------------------- 睡眠状态端口（可插拔）
    // 本模块不绑定任何具体的睡眠模块：默认自动探测已安装的（night → real-life），
    // 也可以通过 api.use('act-format').setSleepProbe(fn) 把自家作息接进来。
    let sleepProbe = null

    const modeOf = (id) => {
      try {
        const snap = api.use(id)?.snapshot?.()
        const mode = snap && typeof snap === 'object' ? snap.mode : null
        return typeof mode === 'string' ? mode : null
      } catch {
        return null
      }
    }

    const askProbe = () => {
      if (typeof sleepProbe !== 'function') return undefined
      try {
        const v = sleepProbe()
        return v === undefined ? undefined : Boolean(v)
      } catch (error) {
        api.log.warn('[act-format] 自定义睡眠探针报错，按醒着处理：' + (error?.message || error))
        return false
      }
    }

    /** 睡着了没：来源由设置 sleepSource 决定，默认 auto（谁在就用谁）。 */
    const sleeping = () => {
      const src = String(cfg().sleepSource || 'auto')
      if (src === 'none') return false
      if (src === 'custom') return askProbe() === true
      if (src === 'night') return modeOf('night') === 'asleep'
      if (src === 'real-life') return modeOf('real-life') === 'asleep'
      // auto：先问自定义探针（它可能返回 undefined 表示“我不管”），再按 night → real-life 探测
      const asked = askProbe()
      if (asked !== undefined) return asked
      const nightMode = modeOf('night')
      if (nightMode) return nightMode === 'asleep'
      const lifeMode = modeOf('real-life')
      if (lifeMode) return lifeMode === 'asleep'
      return false
    }

    /** 残留按时间衰减后的当前值。 */
    const residueNow = () => {
      const decay = Math.max(0.5, Number(cfg().residueDecayPerHour) || 8)
      const hours = Math.max(0, (Date.now() - (Number(st.residueAt) || 0)) / 3_600_000)
      return Math.round(clamp(Number(st.residue) - hours * decay, 0, 100))
    }

    // 睡着 → 醒来的翻转：记一次，醒来后允许立刻提示残留
    const checkWake = () => {
      const asleep = sleeping()
      if (asleep) {
        st.asleepSeen = true
        return
      }
      if (st.asleepSeen) {
        st.asleepSeen = false
        st.residueInjectAt = 0
      }
    }

    // ---------------------------------------------------------------- 观察消息（永不拦截）
    /**
     * 统一入口：解析一条消息并按「睡/醒」决定落库还是只累计残留。
     * forceAsleep：由 night 的广播带进来（那条消息被睡眠拦下了，本模块自己收不到）。
     */
    async function ingest(msg, { forceAsleep = false } = {}) {
      try {
        const c = cfg()
        if (!c.enabled) return false
        const text = String(msg?.text || '')
        if (!text.trim()) return false
        const chatId = String(msg?.chatId || '')
        if (!chatId) return false

        const parsed = parseMessage(text, {
          formats: String(c.formats || '').split(/[,，\s]+/).filter(Boolean),
        })
        if (!parsed.actions.length) {
          // 这条消息没动作：清掉该会话上一轮的动作提示，避免一直挂着
          if (st.chats[chatId]) {
            delete st.chats[chatId]
            save()
          }
          return false
        }

        checkWake()
        const now = Date.now()
        const winner = parsed.actions.reduce((sum, a) => sum + actionWeight(a), 0)

        if ((forceAsleep || sleeping()) && c.sleepResidue !== false) {
          // 睡眠期间：不落任何结构化记录，只累计模糊体感
          const base = Math.max(0, residueNow())
          st.residue = clamp(base + winner, 0, 100)
          st.residueAt = now
          st.suppressedCount = (Number(st.suppressedCount) || 0) + parsed.actions.length
          delete st.chats[chatId]
          save()
          api.log.debug(`[act-format] 睡眠期间收到 ${parsed.actions.length} 个动作 → 只累计体感 ${st.residue}`)
          return false
        }

        // 醒着：结构化记录
        for (const a of parsed.actions) {
          st.actions.unshift({
            at: now,
            chatId,
            userId: String(msg?.userId || ''),
            nickname: String(msg?.nickname || '对方').slice(0, 32),
            kind: a.kind,
            wrapper: a.wrapper,
            text: String(a.text || '').slice(0, 300),
          })
        }
        const keep = Math.max(20, Math.min(2000, Number(c.keepHistory) || 200))
        if (st.actions.length > keep) st.actions.length = keep
        st.chats[chatId] = {
          at: now,
          actions: parsed.actions.map((a) => String(a.text || '').slice(0, 300)),
        }
        save()
        return false
      } catch (error) {
        api.log.warn('[act-format] 解析消息出错：' + (error?.message || error))
        return false
      }
    }

    // 醒着时走常规 message 链；睡着时这条会被 night 吞掉，所以另听它的广播
    api.on('message', (msg) => ingest(msg))
    api.on('night/message', (msg) => ingest(msg, { forceAsleep: true }))

    // ---------------------------------------------------------------- 上下文注入
    api.context(({ chat } = {}) => {
      try {
        const c = cfg()
        if (!c.enabled) return ''
        const chatId = String(chat?.chatId || '')
        const lines = []
        const freshMs = Math.max(1, Number(c.actionFreshMinutes) || 5) * 60_000
        const pending = st.chats?.[chatId]
        if (c.inject !== false && pending && Date.now() - (Number(pending.at) || 0) <= freshMs) {
          const list = (pending.actions || [])
            .map((t) => String(t || '').slice(0, Math.max(20, Number(c.injectChars) || 200)))
            .filter(Boolean)
          if (list.length) {
            lines.push(
              `【对方动作】对方刚才的动作/神态：${list.map((t, i) => `${i + 1}) ${t}`).join('；')}` +
                '（这些是动作描写，不是他说的话，别当成台词复述；按你自己的性格自然回应这个动作。）',
            )
          }
        }

        if (!sleeping()) {
          const res = residueNow()
          const threshold = Math.max(1, Number(c.residueInjectAt) || 20)
          const repeat = Math.max(1, Number(c.residueRepeatMinutes) || 15) * 60_000
          if (res >= threshold && Date.now() - (Number(st.residueInjectAt) || 0) >= repeat) {
            const text =
              res >= 75
                ? '你浑身发软发黏，身上像被弄过、留着说不清的味道，可你怎么想都想不起具体发生了什么。'
                : res >= 45
                  ? '你腰有点酸、身上有股说不清的味道，心里怪怪的，只觉得昨晚好像不太安分。'
                  : '你醒来后身上有点黏、不太舒服，说不上来是怎么弄的。'
            lines.push(`【身体残留】${text}（只有感觉，没有记忆：别编造具体经过。）`)
            st.residueInjectAt = Date.now()
            save()
          }
        }
        return lines.join('\n')
      } catch (error) {
        api.log.warn('[act-format] 注入上下文出错：' + (error?.message || error))
        return ''
      }
    })

    // ---------------------------------------------------------------- 查询接口（给别的模块 / 面板 / 工具）
    const recentActions = ({ chatId = '', limit = 20 } = {}) => {
      const n = Math.max(1, Math.min(200, Number(limit) || 20))
      const list = (st.actions || []).filter((a) => !chatId || a.chatId === chatId)
      return list.slice(0, n)
    }

    api.route('/actions', async () => ({
      ok: true,
      residue: residueNow(),
      suppressedCount: Number(st.suppressedCount) || 0,
      asleep: sleeping(),
      actions: recentActions({ limit: 50 }),
    }))

    api.route('/clear', async () => {
      const before = (st.actions || []).length
      st.actions = []
      st.chats = {}
      st.residue = 0
      st.residueAt = 0
      st.residueInjectAt = 0
      st.suppressedCount = 0
      save()
      return { ok: true, cleared: before }
    })

    api.tool(() => {
      if (!cfg().enabled) return []
      return [
        api.defineTool({
          name: 'act_recent',
          description:
            '查看最近被解析出来的动作互动（结构化记录：谁、什么时候、什么动作）。主人问你刚才/之前做过什么动作时用。',
          properties: {
            limit: { type: 'number', description: '取多少条，默认 10' },
          },
          execute: async ({ limit } = {}) => {
            const list = recentActions({ limit: limit || 10 })
            if (!list.length) return { ok: true, message: '最近没有记录到动作互动。' }
            return {
              ok: true,
              message: list
                .map((a) => `${new Date(a.at).toLocaleTimeString('zh-CN', { hour12: false })} ${a.nickname}：${a.text}`)
                .join('\n'),
            }
          },
        }),
      ]
    })

    api.onDispose(() => save())

    api.log.info(
      `动作解析已启动（观察者，不拦截消息）：格式=${formats()}，结构化 ${st.actions.length} 条，体感残留 ${residueNow()}`,
    )

    return {
      /** 预留端口：把自己的作息接进来。fn 返回 true/false，返回 undefined 表示“我不判断”。 */
      setSleepProbe: (fn) => {
        sleepProbe = typeof fn === 'function' ? fn : null
        return () => { if (sleepProbe === fn) sleepProbe = null }
      },
      clearSleepProbe: () => { sleepProbe = null },
      sleepSource: () => String(cfg().sleepSource || 'auto'),
      isAsleep: () => sleeping(),
      parse: (text) => parseMessage(text, { formats: formats().split(/[,，\s]+/).filter(Boolean) }),
      recentActions,
      residue: residueNow,
      suppressed: () => Number(st.suppressedCount) || 0,
      state: () => st,
    }
  },
}
