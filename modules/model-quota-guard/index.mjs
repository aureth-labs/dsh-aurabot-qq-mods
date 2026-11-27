// 额度守门（model-quota-guard）
//
// 为什么做成扩展模块：src/ 是安装目录，插件一升级就被覆盖；这里在
// plugins-data/aurabot/modules/ 下，升级不动，保存后几秒自动重载。
//
// 干的活：
//   1. 定时读 dsh-connect-workbuddy / dsh-connect-trae 的 usage 接口，拿剩余额度
//   2. 当前模型所在账号额度低于阈值时，按候选顺序挑一个「还有额度」的模型
//   3. api.on('model') 是同步事件，所以只读缓存快照，不在事件里发请求
//
// 读的是插件自己暴露的 /plugins/<id>/usage：不登录、不花钱、不占会话。

const QUOTA_PROVIDERS = {
  workbuddy: '/plugins/dsh-connect-workbuddy/usage',
  trae: '/plugins/dsh-connect-trae/usage',
}

const num = (...vals) => {
  for (const v of vals) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** 从 usage 里抠「这个 provider 还剩多少」；抠不出来返回 null（= 不参与判断） */
function remainingOf(provider, data) {
  if (!data || typeof data !== 'object') return null
  const c = data.credits || {}
  if (provider === 'workbuddy') return num(c.total, c.remaining, c.available)
  if (provider === 'trae') return num(c.available, c.generalAvailable, c.total)
  return num(c.available, c.remaining, c.total)
}

export default {
  id: 'model-quota-guard',
  name: '额度守门',
  version: '0.1.0',
  api: 1,
  description: '剩余额度低于阈值时，自动把当前聊天换成还有额度的模型（倍率低的优先）。',
  tab: 'model',
  defaults: {
    enabled: true,
    threshold: 10,
    pollMinutes: 5,
    announce: true,
    prefer: 'workbuddy:hy4flash-free\nworkbuddy:hy4flash\nworkbuddy:glm-5.3-flash\nworkbuddy:space-bunny\ntrae:deepseek-v4.1-flash',
  },
  settings: [
    { key: 'enabled', label: '自动切换', type: 'switch', hint: '关掉就只记录不切换' },
    { key: 'threshold', label: '额度低于多少就换', type: 'number', min: 1, max: 10000, step: 1 },
    { key: 'pollMinutes', label: '多少分钟探一次', type: 'number', min: 1, max: 120, step: 1 },
    { key: 'announce', label: '换的时候在聊天里说一句', type: 'switch' },
    { key: 'prefer', label: '候选顺序（一行一个 provider:model）', type: 'textarea', hint: '从上往下挑第一个还有额度的' },
  ],

  async setup(api) {
    const LOG = api.log
    const state = { snap: {}, lastSwitch: null, lastAt: 0 }

    const cfg = () => ({ ...(api.defaults || {}), ...(api.settings() || {}) })
    const prefers = () => String(cfg().prefer || '').split('\n').map((s) => s.trim()).filter(Boolean)

    /** 本机 Harness 端口：插件就是从这儿挂路由的 */
    function port() {
      const tries = [
        () => api.dsh?.get?.('webServer')?.port,
        () => api.core?.webServer?.port,
        () => api.core?.http?.port,
      ]
      for (const t of tries) {
        try {
          const n = Number(t())
          if (Number.isFinite(n) && n > 0) return n
        } catch {}
      }
      return 0
    }

    async function fetchUsage(provider) {
      const p = port()
      if (!p) return null
      try {
        const r = await fetch(`http://127.0.0.1:${p}${QUOTA_PROVIDERS[provider]}`, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) return null
        return await r.json()
      } catch {
        return null
      }
    }

    async function refresh() {
      const next = {}
      for (const provider of Object.keys(QUOTA_PROVIDERS)) {
        const remaining = remainingOf(provider, await fetchUsage(provider))
        next[provider] = { remaining, at: Date.now() }
      }
      state.snap = next
      state.lastAt = Date.now()
      return next
    }

    /** 该不该换：返回 { provider, model, reason } 或 null */
    function decide(sel) {
      const c = cfg()
      if (!c.enabled) return null
      const cur = sel && sel.provider ? String(sel.provider) : ''
      const curRem = cur ? state.snap[cur]?.remaining : null
      if (curRem == null) return null // 当前账号额度读不到，不插手
      if (curRem >= Number(c.threshold)) return null
      for (const key of prefers()) {
        const i = key.indexOf(':')
        if (i < 0) continue
        const provider = key.slice(0, i).trim()
        const model = key.slice(i + 1).trim()
        if (!provider || !model) continue
        if (provider === cur && model === sel?.model) continue
        const rem = state.snap[provider]?.remaining
        if (rem == null || rem < Number(c.threshold)) continue
        return { provider, model, reason: `${cur} 只剩 ${curRem}，${provider} 还有 ${rem}` }
      }
      return null
    }

    refresh().catch(() => {})
    api.every(Math.max(60000, Number(cfg().pollMinutes || 5) * 60000), () => { refresh().catch(() => {}) }, '额度探活')

    // 切换：同步事件，只读缓存；reasoningEffort 置空交给宿主按新模型收敛
    api.on('model', (sel, chat) => {
      try {
        const d = decide(sel)
        if (!d) return undefined
        const from = sel ? `${sel.provider}::${sel.model}` : ''
        state.lastSwitch = { at: Date.now(), from, to: `${d.provider}::${d.model}`, reason: d.reason }
        LOG.warn(`额度守门：${from} → ${d.provider}::${d.model}（${d.reason}）`)
        if (cfg().announce && chat?.chatId) {
          const chatId = chat.chatId
          api.later(0, () => { try { api.sendText(chatId, `（额度不多了，先换 ${d.model} 顶上）`) } catch {} })
        }
        return { provider: d.provider, model: d.model, reasoningEffort: '' }
      } catch {
        return undefined
      }
    })

    // 只读查看接口，方便核对端口/额度到底读到没
    api.route('/status', async () => {
      await refresh().catch(() => {})
      const c = cfg()
      return {
        ok: true,
        port: port(),
        threshold: c.threshold,
        enabled: c.enabled,
        prefer: prefers(),
        snap: state.snap,
        lastSwitch: state.lastSwitch,
      }
    }, { access: 'panel' })

    // 演算：不改任何东西，只看「阈值改成 X 会切到哪」
    api.route('/simulate', async (req) => {
      await refresh().catch(() => {})
      const q = api.core?.http?.query?.(req) || {}
      const threshold = Number(q.threshold || cfg().threshold)
      const cur = { provider: String(q.provider || 'workbuddy'), model: String(q.model || 'deepseek-v4.1-flash') }
      const curRem = state.snap[cur.provider]?.remaining
      let out
      if (curRem == null) out = { would: null, why: '当前账号额度读不到，不插手' }
      else if (curRem >= threshold) out = { would: null, why: `当前还剩 ${curRem}，没到阈值 ${threshold}` }
      else {
        out = { would: null, why: '候选里没有够用的' }
        for (const key of prefers()) {
          const i = key.indexOf(':')
          if (i < 0) continue
          const provider = key.slice(0, i).trim()
          const model = key.slice(i + 1).trim()
          if (provider === cur.provider && model === cur.model) continue
          const rem = state.snap[provider]?.remaining
          if (rem == null || rem < threshold) continue
          out = { would: { provider, model }, why: `${cur.provider} 只剩 ${curRem}，${provider} 还有 ${rem}` }
          break
        }
      }
      return { ok: true, threshold, cur, ...out, snap: state.snap }
    }, { access: 'panel' })

    api.command({
      name: '额度',
      desc: '看各账号还剩多少额度、守门最近有没有换过模型',
      run: async () => {
        await refresh().catch(() => {})
        const c = cfg()
        const lines = []
        for (const [provider, row] of Object.entries(state.snap)) {
          lines.push(`${provider}：${row.remaining == null ? '读不到' : row.remaining}`)
        }
        lines.push(`阈值 ${c.threshold}｜自动切换 ${c.enabled ? '开' : '关'}`)
        if (state.lastSwitch) lines.push(`上次换：${state.lastSwitch.from} → ${state.lastSwitch.to}（${state.lastSwitch.reason}）`)
        return lines.join('\n')
      },
    })

    api.tool(() => api.defineTool({
      name: 'model_quota_status',
      description: '查看各模型账号的剩余额度和守门的判断（只读，不花钱）。',
      properties: {},
      execute: async () => {
        await refresh().catch(() => {})
        return { ok: true, snap: state.snap, lastSwitch: state.lastSwitch, threshold: cfg().threshold, enabled: cfg().enabled }
      },
    }))

    LOG.info(`额度守门已就绪：阈值 ${cfg().threshold}｜候选 ${prefers().join(', ') || '（空）'}`)
    return { refresh, snap: () => state.snap, lastSwitch: () => state.lastSwitch }
  },
}
