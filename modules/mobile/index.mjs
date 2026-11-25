import { createMobileService } from './lib/service.mjs'

export default {
  id: 'mobile',
  name: '手机端',
  api: 1,
  version: '1.0.0',
  description: '手机扫码连上她，在原来的会话里聊天、发图和语音，共用她的记忆，每台设备都能单独撤销。',
  panel: 'panel.js',
  settings: [],
  setup(api) {
    const service = createMobileService({ hub: api.core.hub, media: api.core.media, version: api.version, config: () => api.config(), use: (id) => api.use(id), dir: api.dataDir(), log: api.log })
    api.onDispose(() => service.dispose())
    api.on('chat/log', (row) => service.journal(row))
    api.on('config', () => service.identity())
    // 管理路由仅注册到宿主面板的 /ext/mobile，独立监听不提供管理能力。
    const route = (path, method, fn) => api.route('/' + path, async (req, res) => {
      try {
        if (req.method !== method) return api.core.http.send(res, 405, { ok: false, message: '请求方法不正确' })
        return await fn(req)
      } catch (error) {
        if (!error.status) api.log.warn('手机面板操作失败：', error.message)
        api.core.http.send(res, error.status || 500, { ok: false, error: error.code || 'internal_error', message: error.status ? error.message : '操作失败，请检查端口、TLS 证书路径及电脑日志' })
      }
    }, { access: 'panel' })
    route('status', 'GET', () => service.status())
    route('pairing', 'POST', () => service.issue())
    route('configure', 'POST', async (req) => service.configure(await api.core.http.body(req)))
    route('revoke', 'POST', async (req) => service.revoke((await api.core.http.body(req)).id))
    route('disable', 'POST', () => service.disable())
    if (service.enabled()) service.start().catch((error) => api.log.warn('手机端未能监听：', error.message))
    return service
  },
}
