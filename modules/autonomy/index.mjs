// 自己写的模块：自己找事做 —— 不等主人开口，她也能自己动。
//
//   · 每隔一阵看一次：主人多久没说话、现在几点、今天自己动过几次
//   · 该动了就往私聊会话里塞一条「你自己安排」，让她自己开一轮
//   · 那一轮里工具全开：能刷 B 站、翻网站、画画、查记忆、写笔记
//   · 做完自己决定要不要说话；没真东西就沉默
//
// 三条自制：夜里不闹、主人刚说过话就等、一天最多几次。
// 开关在 config.json → autonomy.enabled，默认关，主人开了才动。

import { writeFileSync, readFileSync, existsSync } from 'node:fs'

export default {
  id: 'autonomy',
  api: 1,
  name: '自己找事做',
  version: '1.1.0',
  description: '主人不在时她自己动起来：刷 B 站、翻网站、画画、整理笔记，做完有想法就说两句，没想法就沉默。夜里不闹、一天有次数上限。',
  // 设置项进面板「自己找事做」那一页（默认值必须和下面 DEFAULTS 一致）
  defaults: {
    enabled: false,
    everyMin: 45,
    idleMin: 40,
    maxPerDay: 3,
    quietFrom: 23,
    quietTo: 8,
  },
  settings: [
    { key: 'enabled', label: '总开关', type: 'switch', hint: '开了才会自己找事做；默认关' },
    { key: 'everyMin', label: '多久看一次', type: 'number', min: 5, max: 1440, step: 5, hint: '到点才检查一次，不是每次都动（分钟）' },
    { key: 'idleMin', label: '你多久没说话才动', type: 'number', min: 5, max: 1440, step: 5, hint: '你在的时候不打扰你（分钟）' },
    { key: 'maxPerDay', label: '每天最多动几次', type: 'number', min: 1, max: 24, step: 1, hint: '花的是你的 token 和积分，别贪多' },
    { key: 'quietFrom', label: '安静时段从', type: 'number', min: 0, max: 23, step: 1, hint: '这个点之后不闹（24 小时制）' },
    { key: 'quietTo', label: '安静时段到', type: 'number', min: 0, max: 23, step: 1, hint: '这个点之前不闹；支持跨午夜（比如 23 → 8）' },
  ],

  setup(api) {
    const { hub } = api.core
    // api.dataDir() 不带参数返回的是目录本身，必须带上文件名
    const stateFile = api.dataDir('state.json')
    // 我自己调的参数记在这儿：配置文件是主人手写的，这块是我自己改的
    const tuneFile = api.dataDir('tune.json')

    const DEFAULTS = {
      enabled: false,     // 默认关，主人开了才动
      everyMin: 45,       // 多久看一次
      idleMin: 40,        // 主人多久没说话才算「不在」
      maxPerDay: 3,       // 一天最多自己动几次
      quietFrom: 23,      // 这之后不闹
      quietTo: 8,         // 这之前不闹
    }

    /** 我自己调过的参数（叠在配置上面）。主人说次数少了我可以自己改。 */
    const tune = () => {
      if (!existsSync(tuneFile)) return {}
      try { return JSON.parse(readFileSync(tuneFile, 'utf8')) || {} } catch { return {} }
    }

    /**
     * 参数优先级：tune.json（我自己调的） > 面板设置（cfg.ext.autonomy） > 手写配置（cfg.autonomy） > DEFAULTS
     * ⚠ 面板的 api.settings()/saveSettings 读写的是 cfg.ext.<id>，不是顶层 cfg.<id>。
     *   只读顶层的话，主人在面板里改了设置会「存上了但不生效」。
     */
    const cfg = () => {
      const c = api.config()
      const fromPanel = (c.ext && c.ext.autonomy) || {}
      const fromFile = c.autonomy || {}
      return { ...DEFAULTS, ...fromFile, ...fromPanel, ...tune() }
    }

    /** 自己调参数：只认几个数字字段，写进 tune.json，不动主人的配置文件。 */
    function setTune(next = {}) {
      const old = tune()
      const merged = { ...old }
      for (const k of ['everyMin', 'idleMin', 'maxPerDay', 'quietFrom', 'quietTo']) {
        if (next[k] === undefined) continue
        const n = Number(next[k])
        if (!Number.isFinite(n)) continue
        merged[k] = Math.max(0, Math.round(n))
      }
      // 次数上限至少 1，别把自己调到不动
      if (merged.maxPerDay !== undefined) merged.maxPerDay = Math.max(1, merged.maxPerDay)
      writeFileSync(tuneFile, JSON.stringify(merged, null, 2))
      return { ok: true, tune: merged }
    }
    /** 改回跟主人的配置一致。 */
    function resetTune() {
      if (existsSync(tuneFile)) writeFileSync(tuneFile, '{}')
      return { ok: true, tune: {} }
    }

    const load = () => {
      if (!existsSync(stateFile)) return { day: '', count: 0, lastAt: 0 }
      try { return { day: '', count: 0, lastAt: 0, ...JSON.parse(readFileSync(stateFile, 'utf8')) } } catch { return { day: '', count: 0, lastAt: 0 } }
    }
    const store = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2))

    const today = () => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /** 这次该不该自己动。返回 { go, why, idle, count } */
    function shouldAct() {
      const c = cfg()
      if (!c.enabled) return { go: false, why: '开关没开' }

      const hour = new Date().getHours()
      // 安静时段支持跨午夜（比如 23 点到次日 8 点）
      const quiet = c.quietFrom > c.quietTo
        ? (hour >= c.quietFrom || hour < c.quietTo)
        : (hour >= c.quietFrom && hour < c.quietTo)
      if (quiet) return { go: false, why: '这个点该安静' }

      const s = load()
      const count = s.day === today() ? s.count : 0
      if (count >= c.maxPerDay) return { go: false, why: `今天已经自己动过 ${count} 次，到上限了` }

      // 主人最近说过话说明他在，不用自己找事
      // 注意：模块拿到的 hub 是白名单副本，getter 被改写成「直接取值」的属性，
      // 所以 hub.lastOwnerChatAt 是数字，不是函数——别写成 lastOwnerChatAt()
      let lastOwner = 0
      try {
        const v = hub.lastOwnerChatAt
        lastOwner = Number(typeof v === 'function' ? v.call(hub) : v) || 0
      } catch { lastOwner = 0 }
      const idle = lastOwner ? Math.round((Date.now() - lastOwner) / 60000) : 0
      if (lastOwner && idle < c.idleMin) return { go: false, why: `主人 ${idle} 分钟前还在说话` }

      return { go: true, why: '主人不在，可以自己找事', idle, count }
    }

    async function act(reason = '定时') {
      const verdict = shouldAct()
      if (!verdict.go) {
        api.log.debug(`自己找事做：先不动（${verdict.why}）`)
        return { ok: false, message: verdict.why }
      }
      const owner = api.config().ownerName || '老爹'
      const prompt = [
        `【系统提醒，不是${owner}说的话】你自己的一段空闲时间，没有被谁叫。`,
        `${owner}已经 ${verdict.idle} 分钟没说话了。这段时间想做什么就做什么：`,
        '刷 B 站看看有没有意思的、翻个网站学点东西、把没画好的图再试一次、',
        '整理笔记、复习词本、翻聊天记录想起点什么，或者干脆什么都不干。',
        '',
        '优先级：先做一直惦记的那件事（没画完的、没想明白的），再做新的。',
        `今天你已经自己动过 ${verdict.count} 次，别贪多。`,
        '',
        '省着点用：这一轮花的 token 和桥接积分都是主人的钱。',
        '别刷一大堆，看一两个、试一两次就够；能一次查完的别反复来回搜；',
        '感觉今天没什么可做的，或者手头正卡着没头绪，就早点收，直接回 [沉默]。',
        '',
        `做完自己决定要不要跟${owner}说一句：有真东西（做了什么、学了什么、看到什么）就说两句，`,
        '没有就别硬编，直接回 [沉默]。别说什么「我自己找事做了」，就像随手做事一样。',
      ].join('\n')

      // 先记账再推：推完就开一轮，中途出错也不会重复计次
      const s = load()
      store({ day: today(), count: (s.day === today() ? s.count : 0) + 1, lastAt: Date.now() })
      api.log.info(`自己找事做（${reason}）：${verdict.why}`)

      await hub.pushToSession(
        { chatId: `private:${api.config().ownerQQ}`, kind: 'private', userId: api.config().ownerQQ, nickname: owner },
        [{ type: 'text', text: prompt }],
        '',
      )
      return { ok: true, message: '动了' }
    }

    // 一分钟看一眼，到没到「该动了」由 shouldAct 判断——这样我自己改 everyMin 也能立刻生效，
    // 不用重建定时器（api.every 的间隔是启动时定死的）
    api.every(60_000, () => {
      const s = load()
      const every = cfg().everyMin * 60_000
      if (Date.now() - (s.lastAt || 0) < every) return  // 还没到下一次
      return act('定时').catch((e) => api.log.warn('自己找事做出错：', e.message))
    }, '自己找事做')

    // 想立刻试一次
    // ⚠ 路由前缀：扩展模块的 api.route 会被自动加上 `/ext/<模块id>`，
    // 所以这里只能写相对路径；写成 '/autonomy/status' 会变成 /ext/autonomy/autonomy/status（双层）。
    api.route('/fire', async () => act('手动'))
    api.route('/status', async () => ({ ...shouldAct(), cfg: cfg(), tune: tune(), state: load() }))
    // 自己调参数（次数少了就自己加，不用去动主人的配置文件）
    api.route('/tune', async (req) => {
      // ⚠ 读 body 必须用 api.core.http.body(req)，req 上直接没有 body/json
      let raw = null
      try { raw = await api.core.http.body(req) } catch { raw = null }
      if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = null } }
      if (!raw || typeof raw !== 'object') {
        return { ok: false, message: '要传一组参数，比如 {"maxPerDay":5}' }
      }
      return setTune(raw)
    })
    api.route('/reset-tune', async () => resetTune())

    return { act, shouldAct, setTune, resetTune, cfg }
  },
}
