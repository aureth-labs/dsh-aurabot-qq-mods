// 生图 · 用 DSH 里已接入的模型
//
// 插件自带的生图只认 OpenAI 兼容接口 / 自定义接口 / Codex 订阅；这里补上第四条：
// 直接用 DSH 的 llm 服务里已经接好的生图模型（例如豆包插件把
// 「豆包 生图（Seedream 5.0）」注册成一个对话模型）。模型清单是动态拉的：
// 主人在 DSH 里新接一个生图模型，这里刷新就能看见，不用等模块更新。
//
// 生图结果就是一张图（Buffer），交给插件的 hub 发到聊天里。

import { discoverImageModels, labelOf, pickEntry } from './lib/discover.mjs'
import { generateViaDsh } from './lib/generate.mjs'

export default {
  id: 'dsh-image',
  name: '生图 · DSH 已接入模型',
  version: '1.1.0',
  description: '用 DSH 里已经接好的生图模型（如豆包 Seedream 5.0）画图，模型清单动态拉取',
  tab: 'imagegen',
  api: 1,
  files: ['lib/discover.mjs', 'lib/generate.mjs'],
  panel: 'panel.js',
  // 不从自动表单生成：模型清单是动态的，面板自己画下拉（见 panel.js）。
  settings: [
    { key: 'enabled', label: '用 DSH 已接入的模型生图', type: 'switch', hint: '打开后，生图优先用面板里选中的模型（仍受「生图」总开关控制）' },
  ],
  setup (api) {
    // 缓存最近一次目录，面板下拉和生图都用它；刷新由用户或定时触发。
    let cache = { models: [], errors: [], at: 0 }
    const ttlMs = 30_000

    /** 拉一次 DSH 的模型目录，挑出生图模型。 */
    async function refresh (force = false) {
      if (!force && Date.now() - cache.at < ttlMs) return cache
      const llm = api.dsh?.llm || api.dsh?.get?.('llm')
      if (!llm || typeof llm.listProviders !== 'function') {
        cache = { models: [], errors: [{ provider: '', message: '宿主没有 llm 服务' }], at: Date.now() }
        return cache
      }
      const { models, errors } = await discoverImageModels(llm.listProviders() || [], (p) => llm.listModels(p))
      cache = { models, errors, at: Date.now() }
      return cache
    }

    /**
     * 当前设置指向的模型。
     *
     * 刻意不做兜底：没选就是没选，返回 null 让调用方落回内置接法。
     * 自动挑「第一个」看似省事，实际上会替使用者决定花哪份额度，
     * 也会让「我明明没选」变成一个查不出来的行为。
     */
    function resolveTarget (settings) {
      const raw = String(settings?.target || '')
      if (!raw) return null
      const chosen = pickEntry(cache.models, raw)
      if (chosen) return chosen
      // 老格式可能是 "provider / name"，按标签再认一次。
      return cache.models.find((m) => labelOf(m) === raw) || null
    }

    // 面板：可选的生图模型清单。绘图模型本来就不多，按关键词筛比长列表好找。
    api.route('/models', async (req) => {
      const { models, errors } = await refresh(true)
      const q = String(api.core?.http?.query?.(req)?.q || '').trim().toLowerCase()
      const listed = (q
        ? models.filter((m) => `${m.provider} ${m.name} ${m.model}`.toLowerCase().includes(q))
        : models
      ).map((m) => ({ ...m, key: `${m.provider}\u0000${m.model}`, label: labelOf(m) }))
      return { ok: true, models: listed, total: models.length, query: q, errors }
    })

    /** 插件的生图模块调这里拿图；DSH 这条路没开就返回 null，让它走原来的逻辑。 */
    const generate = async (prompt) => {
      const settings = api.settings()
      if (settings?.enabled !== true) return null
      await refresh()
      const target = resolveTarget(settings)
      if (!target) return null
      api.log.info(`用 DSH 模型生图：${target.provider}/${target.model} —— ${String(prompt || '').slice(0, 40)}`)
      return generateViaDsh({ dsh: api.dsh, target, prompt })
    }

    // 同步、不联网：只回答「这一轮我愿不愿意接管生图」。插件的 enabled() 会问它，
    // 所以不能在这里拉目录 —— 那是异步的，也会让判断带上网络延迟。
    // 必须「开着 + 已经选了模型」才算就绪：没选就落回内置接法，不替使用者挑。
    const ready = () => {
      const settings = api.settings()
      return settings?.enabled === true && String(settings?.target || '') !== ''
    }

    return { generate, ready, refresh, models: () => cache.models }
  },
}
