// 扩展模块「看你在干嘛」（activity）—— 从 DSH 那侧的 dsh-pet-activity 搬过来的。
// 放在 Aurabot 数据目录 modules/activity/ 里，插件升级不会动它；保存就生效。
//
// 它干的事：
//   1) 每 5 秒采一次主人在用什么窗口（PowerShell 读前台窗口标题 + 空闲秒数）
//   2) 纯规则分类：这是工作 / 游戏 / 看视频 / 聊天 / 私人应用，他专注还是在折腾
//   3) 每轮聊天前给 QQ 那边的她塞一句「主人现在在干什么」，决定说不说话、用什么语气
//   4) 给她两个工具：activity_now（现在在干嘛）、activity_trail（最近切了几次窗口）
//
// 省事的点：如果 DSH 那边的旧插件还在跑，它会往  写快照，
// 这里直接读那个文件，就不再起一个采样进程。两边只留一份。

/** @type {import('../aurabot').AurabotModule} */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ActivitySampler, formatSample } from './lib/sampler.js'
import { buildTables, classify } from './lib/keywords.js'
import { ActivityStateMachine, renderSnapshotLine, TONE_LINES } from './lib/state.js'

const TABLE_FILE = new URL('./assets/activity-keywords.json', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1')
const EXTERNAL = 'activity-data\\current.json'
const EXTERNAL_FRESH_MS = 25_000
const SELF_TAG = 'aurabot-activity' // 自己写快照时打的记号；看到它就不会把自己当成「别人在采」

const POLICY = [
  '【活动感知】你能看到主人当前在电脑上做什么，据此决定要不要说话、说多长、什么语气。',
  '规则：',
  '- private（私人应用）：一个字都别主动提，也别提他打开了什么。',
  '- restricted_screen_only：屏幕归他，只有他找你或明显卡住才开口，而且要短。',
  '- greeting_window：他刚回来，可以先打个招呼。',
  '- open：可以主动找他说话。',
  '语气按状态走，不要一律用同一种腔调；这不是角色扮演，是真的看情况说话。',
].join('\n')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readExternal() {
  try {
    const st = statSync(EXTERNAL)
    if (Date.now() - st.mtimeMs > EXTERNAL_FRESH_MS) return null
    const j = JSON.parse(readFileSync(EXTERNAL, 'utf8'))
    if (!j || typeof j !== 'object' || !j.at) return null
    // 这是咱自己刚写的那份：不算「别人在采」，否则会把自己刚起的采样进程又停掉，来回抖
    if (j.by === SELF_TAG) return null
    return j
  } catch {
    return null
  }
}

export default {
  id: 'activity',
  name: '看你在干嘛',
  version: '1.0.0',
  api: 1,
  tab: 'speakup',
  description: '看他现在在电脑上做什么（前台窗口 + 空闲），决定要不要主动说话、用什么语气',

  defaults: {
    enabled: true,
    intervalMs: 5000,
    injectContext: true,
    followExternal: true,
    dataDir: 'activity-data',
  },
  settings: [
    { key: 'enabled', label: '活动感知', type: 'switch', hint: '关掉以后她不知道你在干嘛，主动搭话会变回盲猜' },
    { key: 'intervalMs', label: '采样间隔（毫秒）', type: 'number', min: 1000, max: 120000, step: 1000, hint: '默认 5 秒。调大省资源，但状态反应会慢' },
    { key: 'injectContext', label: '让她知道', type: 'switch', hint: '每轮把「主人现在在干嘛」塞进她上下文；关掉只是不告诉她，工具还在' },
    { key: 'followExternal', label: '复用 DSH 那边的采样', type: 'switch', hint: '开着的话，DSH 那边的插件在跑就直接读它的快照，不再多起一个采样进程' },
    { key: 'dataDir', label: '活动数据目录', type: 'text', hint: '快照写在哪里；送 QQ、主动搭话的脚本也从这儿读' },
  ],

  setup(api) {
    let tables = null
    try {
      tables = buildTables(JSON.parse(readFileSync(TABLE_FILE, 'utf8')))
    } catch (error) {
      api.log.error('关键词表加载失败，活动感知不启用：', error.message)
      return {}
    }

    const machine = new ActivityStateMachine()
    const state = { snap: null, sample: null, count: 0, startedAt: Date.now(), lastError: null, source: '' }
    const history = [] // [{ timestamp, key }]

    // ---------- 快照落地 ----------
    const publish = (snap) => {
      const dir = String(api.settings().dataDir || 'activity-data')
      try {
        mkdirSync(dir, { recursive: true })
        const payload = {
          at: snap.at,
          atIso: new Date(snap.at).toISOString(),
          state: snap.state,
          label: snap.label,
          propensity: snap.propensity,
          tone: snap.tone,
          skipProbability: snap.skipProbability,
          period: snap.period,
          idleSeconds: snap.idleSeconds,
          dwellSeconds: snap.dwellSeconds,
          window: snap.window
            ? { category: snap.window.category, subcategory: snap.window.subcategory, canonical: snap.window.canonical, title: snap.window.title }
            : null,
          line: renderSnapshotLine(snap),
          by: SELF_TAG,
        }
        const file = join(dir, 'current.json')
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        renameSync(tmp, file)
      } catch (error) {
        state.lastError = error.message
      }
    }

    const pushHistory = (key, at) => {
      const last = history[history.length - 1]
      if (last && last.key === key) return
      history.push({ timestamp: at, key })
      if (history.length > 200) history.shift()
    }

    // ---------- 采样 → 分类 → 快照 ----------
    const onSample = (obs) => {
      state.sample = obs
      state.count += 1
      state.source = 'self'
      try {
        const obs2 = classify(tables, { title: obs.title, proc: obs.proc })
        const now = Date.now()
        machine.updateWindow(obs2, now)
        machine.updateSystem({ idle: typeof obs.idle === 'number' ? obs.idle : 0 })
        const snap = machine.getSnapshot(now)
        state.snap = snap
        pushHistory(snap.window?.canonical || snap.state, now)
        publish(snap)
      } catch (error) {
        state.lastError = error.message
      }
    }

    let sampler = null
    let samplerOn = false
    const startSampler = () => {
      if (samplerOn) return
      sampler = new ActivitySampler(
        {
          // 采样脚本跟着模块走（api.dir 是模块自己的文件夹，插件复制快照也不会丢）
          scriptPath: join(api.dir, 'assets', 'activity-sampler.ps1'),
          intervalMs: Number(api.settings().intervalMs) || 5000,
          dataDir: String(api.settings().dataDir || 'activity-data'),
        },
        {
          onSample,
          onError: (error) => { state.lastError = error && error.message ? error.message : String(error) },
          onExit: () => { api.log.warn('活动采样进程退出了，5 秒后重来') },
        },
      )
      sampler.start()
      samplerOn = true
      api.log.info('活动采样开始（自己起的进程）')
    }
    const stopSampler = () => {
      if (!samplerOn) return
      try { sampler.stop() } catch {}
      sampler = null
      samplerOn = false
      api.log.info('活动采样停下')
    }

    // ---------- 每 5 秒：优先读 DSH 那边的快照，没有再自己采 ----------
    const tick = () => {
      if (!api.settings().enabled) {
        stopSampler()
        return
      }
      const ext = api.settings().followExternal ? readExternal() : null
      if (ext) {
        stopSampler() // 别人在采，咱不抢
        state.source = 'external'
        const at = Number(ext.at) || Date.now()
        state.snap = {
          at,
          state: ext.state,
          label: ext.label,
          propensity: ext.propensity,
          tone: ext.tone,
          skipProbability: ext.skipProbability,
          period: ext.period,
          idleSeconds: ext.idleSeconds,
          dwellSeconds: ext.dwellSeconds,
          window: ext.window || null,
        }
        pushHistory(ext.window?.canonical || ext.state, at)
        return
      }
      startSampler()
    }

    // ---------- 每轮给她的一句话 ----------
    const contextLine = () => {
      if (!api.settings().injectContext) return ''
      const snap = state.snap
      if (!snap) return ''
      if (Date.now() - snap.at > 15 * 60_000) return '' // 采样卡死了，别让她以为主人还在原地
      return `【主人现在】${renderSnapshotLine(snap)}`
    }

    api.context(contextLine)
    api.rule(POLICY)

    // ---------- 给她用的工具 ----------
    const payload = () => {
      const snap = state.snap
      if (!snap) return { ok: false, message: '还没采到一次样本' }
      return {
        ok: true,
        message: [
          renderSnapshotLine(snap),
          `状态 ${snap.state}｜倾向 ${snap.propensity}｜语气 ${snap.tone}`,
          TONE_LINES[snap.tone] ? `语气提示：${TONE_LINES[snap.tone]}` : '',
          `空闲 ${snap.idleSeconds} 秒，这个窗口待了 ${snap.dwellSeconds} 秒`,
        ].filter(Boolean).join('\n'),
        at: new Date(snap.at).toLocaleString('zh-CN'),
        source: state.source,
      }
    }

    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return [
        api.defineTool({
          name: 'activity_now',
          description: '看主人此刻在电脑上干什么、要不要理他。想主动找他说话之前先问一句。',
          properties: {},
          execute: async () => payload(),
        }),
        api.defineTool({
          name: 'activity_trail',
          description: '看主人最近一段时间的窗口切换记录，判断他是在专注还是来回折腾。',
          properties: { minutes: { type: 'number', description: '回溯多少分钟，默认 30，上限 240' } },
          execute: async ({ minutes }) => {
            const m = Math.max(1, Math.min(240, Number(minutes) || 30))
            const now = Date.now()
            const trail = history.filter((e) => now - e.timestamp <= m * 60_000)
            if (!trail.length) return { ok: false, message: '这段时间没有窗口切换记录' }
            const lines = trail.slice(-40).map((e) => `- ${Math.round((now - e.timestamp) / 1000)} 秒前：${e.key}`)
            return { ok: true, message: [`最近 ${m} 分钟切了 ${trail.length} 次窗口：`, ...lines].join('\n') }
          },
        }),
      ]
    })

    // 面板接口：看采集器健不健康
    api.route('/status', async () => ({
      ok: true,
      enabled: Boolean(api.settings().enabled),
      source: state.source,
      samples: state.count,
      uptimeMinutes: Math.round((Date.now() - state.startedAt) / 60_000),
      lastSample: state.sample ? formatSample(state.sample) : null,
      snapshot: state.snap ? { at: state.snap.at, line: renderSnapshotLine(state.snap), tone: state.snap.tone } : null,
      lastError: state.lastError,
    }))

    // ---------- 启动 ----------
    api.every(5000, tick, '活动采样')
    api.later(1500, tick)
    api.onDispose(() => stopSampler())
    api.log.info('活动感知模块起来了（5 秒一次，优先复用 DSH 那边的快照）')

    return {
      now: () => (state.snap ? { ...state.snap } : null),
      line: contextLine,
      trail: () => history.slice(-40),
      state,
    }
  },
}
