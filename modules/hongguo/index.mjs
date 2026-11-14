// 扩展模块「刷红果短剧」：专用浏览器 + 定时刷 + QQ 私聊分享。
// 登录和取数都走 CDP（见 lib/site.mjs），登录态存在专用浏览器资料目录里。
const __lib = globalThis.aurabot.lib
const { defineTool } = __lib('tools/tools.js')
const { profileToolVisible, profilePermits } = __lib('chat/access.js')

import { createHongguo } from './lib/duty.mjs'

export default {
  id: 'hongguo',
  name: '刷红果短剧',
  version: '0.1.0',
  api: 1,
  description: '用专用浏览器刷红果短剧：看推荐、记下看过的，刷到好看的用 QQ 私聊告诉主人。',
  // 设置项和面板
  panel: 'panel.js',
  defaults: {
    enabled: false,
    intervalHours: 4,
    perRun: 3,
    maxWatchPerDay: 12,
    maxSharesPerDay: 3,
    dwellMin: 20,
    dwellMax: 90,
    browserPath: '',
    visionModel: ''
  },
  settings: [
    { key: 'enabled', label: '打开红果短剧', type: 'switch', hint: '先登录再打开' },
    { key: 'intervalHours', label: '多久刷一轮（小时）', type: 'number', min: 0.1, step: 0.5 },
    { key: 'perRun', label: '一轮看几部', type: 'number', min: 1 },
    { key: 'maxWatchPerDay', label: '每天最多看几部', type: 'number', min: 0 },
    { key: 'maxSharesPerDay', label: '每天最多分享几部', type: 'number', min: 0 },
    { key: 'dwellMin', label: '每部停留最少（秒）', type: 'number', min: 1 },
    { key: 'dwellMax', label: '每部停留最多（秒）', type: 'number', min: 1 },
    { key: 'browserPath', label: '浏览器路径', type: 'text', hint: '留空自动找 Edge / Chrome', placeholder: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { key: 'visionModel', label: '看画面用哪个模型', type: 'text', hint: '留空 = 跟聊天模型；默认模型看不懂画面时，填 xdpool/glm-5.3 这类支持图片的', placeholder: 'xdpool/glm-5.3' }
  ],

  setup (api) {
    const { hub, http } = api.core
    // 配置：把模块设置叠进插件的 hongguo 段
    const getConfig = () => {
      const cfg = api.config()
      return { ...cfg, hongguo: { ...(cfg.hongguo || {}), ...api.settings() } }
    }
    const hg = createHongguo({
      getConfig,
      hub,
      memory: api.lazy('memory'),
      log: api.log,
      dataDir: api.dataDir,
      // 宿主上下文：拿它调核心 llm 的看图通道（api.lib 加载 core/llm.js 的 askModel）
      dsh: api.dsh
    })
    api.every(60_000, () => hg.tick(), '刷红果')
    api.onDispose(() => hg.dispose())

    // 给她用的工具
    api.tool(({ chat, sessionId }) => {
      const cfg = getConfig()
      if (!cfg.hongguo.enabled || chat.kind === 'system') return []
      const guarded = (key, run) => async (args) => {
        const c = getConfig()
        if (!c.hongguo.enabled) return { ok: false, message: '红果没打开' }
        const p = profilePermits(c, key, chat, hub.turnSendersAllOwner(sessionId))
        if (!p.ok) return p
        return run(args)
      }
      const tools = []
      if (profileToolVisible(cfg, 'hongguoBrowse', chat)) {
        tools.push(defineTool({
          name: 'hongguo_browse',
          description: '去红果短剧刷一轮推荐：看几部剧，刷到觉得主人会喜欢的就用 QQ 私聊发给你自己想好的话（系统自动发）。',
          properties: {},
          execute: guarded('hongguoBrowse', async () => hg.runOnce())
        }))
        tools.push(defineTool({
          name: 'hongguo_recent',
          description: '看看最近刷过哪些红果短剧（剧名和你自己记下的感受）。',
          properties: {},
          execute: guarded('hongguoBrowse', async () => {
            const list = hg.recent(10)
            if (!list.length) return { ok: true, message: '最近还没刷过红果' }
            return { ok: true, message: list.map((x) => `${x.kind === 'share' ? '分享过' : '看过'}《${x.title}》`).join('；') }
          })
        }))
      }
      return tools
    })

    // 面板接口（扩展模块前缀是 /aurabot/api/ext/hongguo/…）
    // ?limit=N 控制展示墙往回看几条（默认 24，最多 200）
    api.route('/hongguo/state', async (req) => {
      const q = http.query(req)
      return { ok: true, recent: hg.recent(Math.min(200, Number(q && q.limit) || 24)) }
    })
    api.route('/hongguo/backfill-covers', async () => hg.backfillCovers())
    // 自检：她到底能不能看懂画面（真播十几秒抓一帧问她）
    api.route('/hongguo/vision-test', async () => hg.visionTest())
    api.route('/hongguo/login/start', async () => hg.loginStart())
    api.route('/hongguo/login/poll', async () => hg.loginPoll())
    // 显示 / 收起浏览器窗口：body { visible: false } 收起，缺省或 true 是显示
    api.route('/hongguo/show', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return hg.show(b && b.visible === false ? false : true)
    })
    api.route('/hongguo/run', async () => hg.runOnce())

    // 主人在 QQ 里发 /hongguo：手动刷一轮
    api.command({
      name: 'hongguo',
      desc: '去红果短剧刷一轮，看到好看的私聊发给你',
      run: async () => { const r = await hg.runOnce(); return r.message || (r.ok ? '刷完了' : '没刷成') }
    })

    return hg
  }
}
