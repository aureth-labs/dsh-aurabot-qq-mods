import { createBridge } from './lib/bridge.mjs'

export default {
  id: 'wechat-bridge',
  name: '微信互通',
  version: '0.1.0',
  api: 1,
  description: '通过本机 Agent WeChat 接入主人私聊，与 QQ 共用人格和记忆。',
  defaults: { enabled: false, url: '', account: '', tokenFile: '', binding: null },
  settings: [
    { key: 'enabled', type: 'switch', label: '接收并回复主人微信' },
    { key: 'url', type: 'text', label: 'Agent WeChat 本机地址', placeholder: 'http://127.0.0.1:端口' },
    { key: 'account', type: 'text', label: 'Agent WeChat 档案 ID' },
    { key: 'tokenFile', type: 'text', label: 'API 密钥文件的绝对路径' },
  ],
  setup(api) {
    const bridge = createBridge(api)
    api.onDispose(bridge.stop)
    api.on('prompt', bridge.prompt)
    api.on('config', bridge.sync)
    api.every(2000, bridge.sync, '微信连接检查')
    api.command({ name: 'wx-bind', desc: '在 QQ 主人私聊发起微信绑定', run: (_, msg) => bridge.bind(msg) })
    api.command({ name: 'wx-status', desc: '查看微信互通状态', run: (_, msg) => bridge.getStatus(msg) })
    api.command({ name: 'wx-unbind', desc: '解除微信绑定并暂停回复', run: (_, msg) => bridge.unbind(msg) })
    api.command({ name: 'wx-adopt', desc: '复用旧合并版绑定，带 memory 可导入旧共享库的有效事实', run: (arg, msg) => bridge.adopt(arg, msg) })
    bridge.sync()
  },
}
