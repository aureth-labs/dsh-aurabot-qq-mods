import { selectRule, validateConfig } from './lib/rules.mjs'

export default {
  id: 'auto-change-model',
  name: '自动切换模型',
  version: '1.0.0',
  api: 1,
  description: '按时段、星期、日期和会话人格自动选择聊天模型',
  defaults: { enabled: false, timeZone: 'Asia/Shanghai', rulesJson: '[]' },
  settings: [
    { key: 'enabled', label: '启用自动切换（先填写规则）', type: 'switch' },
    { key: 'timeZone', label: '时区（例如 Asia/Shanghai）', type: 'text' },
    { key: 'rulesJson', label: '规则 JSON 数组（见模块说明中的示例）', type: 'textarea' },
  ],
  panel: 'panel.js',
  setup(api) {
    let cachedKey
    let cached
    let lastWarning = ''
    const warn = (message) => {
      if (message !== lastWarning) api.log.warn(message)
      lastWarning = message
    }
    function configuration() {
      const settings = api.settings()
      const key = JSON.stringify([settings.enabled, settings.timeZone, settings.rulesJson])
      if (key === cachedKey) return cached
      cachedKey = key
      try {
        const config = { enabled: settings.enabled, timeZone: settings.timeZone, rules: JSON.parse(settings.rulesJson) }
        const errors = validateConfig(config)
        cached = { config, errors }
      } catch {
        cached = { config: null, errors: ['规则必须是合法的 JSON 数组。'] }
      }
      if (cached.errors.length) warn('自动切换已暂停：' + cached.errors.join('；'))
      else lastWarning = ''
      return cached
    }
    function personaId() {
      // Use the host's async-context identity, not the globally selected card.
      const personas = api.lib('persona/personas.js')
      if (typeof personas.personaNow !== 'function' || typeof personas.resolvePersonaId !== 'function') {
        throw new Error('宿主缺少会话人格接口，请使用兼容的 Aurabot 1.3.0。')
      }
      return personas.resolvePersonaId(personas.personaNow(api.config()))
    }
    function evaluate(now = new Date(), preview = false) {
      const { config, errors } = configuration()
      if (errors.length || (!preview && config.enabled === false)) return { rule: null, errors }
      let current = ''
      if (config.rules.some((r) => r.enabled !== false && r.personas?.length)) {
        current = personaId()
      }
      return { rule: selectRule(preview ? { ...config, enabled: true } : config, { now, personaId: current }), errors: [], personaId: current }
    }
    api.on('model', () => {
      try {
        const { rule } = evaluate()
        if (!rule) return undefined
        // Replace the entire selection; never inherit another model's reasoning effort.
        return { provider: rule.provider, model: rule.model, reasoningEffort: rule.reasoningEffort ?? '' }
      } catch (error) {
        warn('自动切换已暂停：' + error.message)
        return undefined
      }
    })
    api.route('/status', async () => {
      let result
      try { result = evaluate(new Date(), true) } catch (error) { result = { rule: null, errors: [error.message] } }
      let models = []
      let personas = []
      const warnings = []
      try { models = (await api.core.listModels()).map(({ provider, model }) => ({ provider, model })) }
      catch { warnings.push('无法读取模型列表，请在 DSH 模型设置中核对 ID。') }
      try { personas = api.core.personas.list().map(({ id, name }) => ({ id, name })) }
      catch { warnings.push('无法读取人格列表。') }
      return { checkedAt: new Date().toISOString(), enabled: api.settings().enabled === true, ...result, models, personas, warnings }
    }, { access: 'panel' })
    return { evaluate }
  },
}
