/** @type {import('../aurabot').AurabotModule} */

import { createBalanceQuery, matchesTrigger, DEFAULT_BASE_URL, DENY_TEXT } from './lib/balance.mjs'

export default {
  id: 'deepseek-balance',
  name: 'DeepSeek 余额',
  version: '1.1.1',
  api: 1,
  description: '让ta知道你的DeepSeek账户还有多少钱',
  defaults: {
    enabled: false,
    trigger: '余额',
    apiKey: '',
    allowOthers: false,
    baseUrl: DEFAULT_BASE_URL,
  },
  settings: [
    { key: 'enabled', label: '模块开关', type: 'switch', hint: '默认关闭。打开后才会响应触发词；关掉后完全不响应，也不发任何请求' },
    { key: 'trigger', label: '触发词', type: 'text', hint: '可以写多个，用逗号或空格分开', placeholder: '余额' },
    { key: 'apiKey', label: 'DeepSeek API Key', type: 'password', hint: '在 platform.deepseek.com 的「API keys」页创建，以 sk- 开头' },
    { key: 'allowOthers', label: '群友也能查', type: 'switch', hint: '关着时只有主人能查，别人发触发词会收到一句提示' },
    { key: 'baseUrl', label: '接口地址', type: 'text', hint: '一般不用改；走中转/代理时填你自己的地址', placeholder: DEFAULT_BASE_URL },
  ],

  setup(api) {
    // 每个实例一份缓存：模块重载后从干净状态开始
    const balance = createBalanceQuery()

    api.on('message', async (msg) => {
      const settings = api.settings()
      const enabled = settings.enabled !== false
      balance.syncEnabled(enabled)

      // 模块开关：关着时什么都不做，消息照常交给她
      if (!enabled) return false

      const text = String(msg.text || '').trim()
      if (!text || !matchesTrigger(settings, text)) return false

      // 鉴权：主人随时能查；别人要看「群友也能查」
      if (!api.isOwner(msg.userId) && !settings.allowOthers) {
        await api.reply(msg, DENY_TEXT)
        return true
      }

      const result = await balance.run(settings)
      if (!result.ok) api.log.warn('[deepseek-balance] 查询失败：' + result.message)
      await api.reply(msg, result.message)
      return true
    })
  },
}
