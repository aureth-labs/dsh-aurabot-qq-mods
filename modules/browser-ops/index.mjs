// index.mjs —— browser-ops「浏览器自动化」模块入口
// 来源：本项目自写（CDP 底座见 lib/browser.mjs，指引库见 lib/guides.mjs；
//       启动思路参考 mods-fork/modules/douyin/lib/browser.mjs、指引库结构仿 phone/lib/guides.mjs，代码重写）。
// 作用：封装一个带独立登录资料的专用浏览器（Edge/Chrome），经 CDP 对外提供原子操作，
//       供 douyin 等其他模块经 api.use('browser-ops') 复用；同时给主人私聊提供
//       /browser 命令与两个 AI 工具（开浏览器、看网页）。
// 契约：登录资料只写 api.dataDir('browser-profile')，绝不写模块源码目录；
//       自定义指引存 api.dataDir('guides/<key>.md')；AI 工具与触发入口默认仅主人可用；
//       导出 API 面见 setup 返回对象（launch/close/navigate/click*/input*/scroll/
//       screenshot/snapshot/evaluate/show/status/guides/runTask），全部原子操作，不做具体平台业务。
// 面板：settings 数组留空，字段全部由 panel.js 接管（布局照 phone：主卡 → 红色风险卡 →
//       站点白名单 → 指引卡）；默认值兜底在 defaults（运行时）与 panel.js 的 DEFAULTS（显示用）。
// 权限：capabilities = process（spawn 浏览器）+ filesystem（资料目录与指引读写）+
//       network（本机 CDP 调试口）+ plugin-internals（owner 判定用 api.core.hub）。

import { join } from 'node:path'
import { createBrowser } from './lib/browser.mjs'
import { createGuides } from './lib/guides.mjs'

export default {
  id: 'browser-ops',
  name: '逛网页（浏览器自动化）',
  version: '1.2.5',
  api: 1,
  description: '封装 CDP 专用浏览器（独立登录资料）：提供打开网页、点击、输入、滚动、截屏、页面快照等原子操作，供其他模块经 api.use(\'browser-ops\') 复用。',
  panel: 'panel.js',
  // settings 留空：面板字段全部由 panel.js 接管（总开关挂在模块名同一行，避免与原生表单重复）。
  // 默认值兜底有两处：panel.js 的 DEFAULTS（显示用）+ 下面 getSettings()（运行时兜底）。
  settings: [],
  defaults: {
    enabled: false,        // 总开关：默认关（关着时工具/命令/跨模块调用全部拒绝启动）
    ownerOnly: true,       // 默认仅主人：AI 工具只在主人会话里可用
    browserPath: '',       // 浏览器可执行文件路径；空 = 自动探测（Edge 优先，再 Chrome/Chromium）
    windowVisible: false,  // 默认窗口放屏幕外（不抢前台）；登录扫码时可临时挪进来
    snapshotChars: 3000,   // 页面快照最大字符数
    navigateTimeoutMs: 15000, // 打开网页等 load 的上限
    whitelist: '',         // 站点白名单（每行一个域名后缀），空 = 不限制
    injectGuides: true,    // 浏览任务注入指引（总纲 + 场景手册）：默认开
  },

  setup(api) {
    const dataDir = () => api.dataDir()
    // 登录资料（profile）只放数据目录：重启后 Cookie 还在，也绝不污染模块源码目录
    const profileDir = join(dataDir(), 'browser-profile')
    // 指引提示词库：自定义层存 dataDir/guides/<key>.md
    const guides = createGuides(dataDir())

    const getSettings = () => {
      const s = api.settings() || {}
      return {
        enabled: s.enabled === true, // 总开关：默认关，明确 true 才放行
        ownerOnly: s.ownerOnly !== false, // 默认仅主人
        browserPath: String(s.browserPath || ''),
        windowVisible: !!s.windowVisible,
        snapshotChars: clampInt(s.snapshotChars, 3000, 500, 8000),
        navigateTimeoutMs: clampInt(s.navigateTimeoutMs, 15000, 3000, 60000),
        whitelist: String(s.whitelist || '').split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter(Boolean),
        injectGuides: s.injectGuides !== false,
      }
    }

    // 测试钩子（照 pet/phone 模式）：测试注入 fake createBrowser，不打真进程
    const hooks = api.__browserOpsTestHooks || {}
    let browser = null
    /** 惰性建浏览器句柄：profileDir 等在 setup 时已定，测试可在 hooks 里换实现。 */
    function getBrowser() {
      if (!browser) {
        browser = (hooks.createBrowser || createBrowser)({
          profileDir,
          browserPath: () => getSettings().browserPath,
          log: api.log,
          // 全局开关：连 DSH 侧边浏览器（共享 ego 实例），关着走原来的专用浏览器
          useEgo: () => api.config().browser?.useDshSidebar === true,
        })
      }
      return browser
    }

    const offMsg = () => ({ ok: false, message: '浏览器自动化总开关没开：请先到面板打开「总开关」。' })

    // ---- 站点白名单（可选）：非空时只放行匹配域名的网址，navigate 入口统一过这道门 ----
    /** 网址是否在白名单内：白名单为空 = 不限制；按域名段精确匹配（bilibili.com 放行
     *  www.bilibili.com 与任意子域，但不放行 evil-example.com 这类后缀伪装域）。 */
    function urlAllowed(url, whitelist) {
      let host = ''
      try { host = new URL(String(url)).hostname.toLowerCase() } catch { return false }
      if (!whitelist.length) return true
      return whitelist.some((w) => host === w || host.endsWith('.' + w))
    }
    const checkUrl = (url) => {
      const s = getSettings()
      if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, message: '网址要以 http(s):// 开头' }
      if (!urlAllowed(url, s.whitelist)) return { ok: false, message: `站点不在白名单：${String(url).slice(0, 120)}（面板「站点白名单」可加，空 = 不限制）` }
      return { ok: true }
    }

    // ---- 权限门槛（默认仅主人）----
    /** AI 工具调用是否来自主人会话（照 phone 一审 #19-2）：拿不到会话一律按非主人处理。 */
    function ownerToolCall(exec) {
      const sid = exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || ''
      const hub = api.core?.hub
      if (!sid || typeof hub?.turnSendersAllOwner !== 'function') return false
      try { return hub.turnSendersAllOwner(sid) === true } catch { return false }
    }
    const notOwnerMsg = () => ({ ok: false, message: '浏览器自动化的工具只在主人会话里可用（默认仅主人）。' })
    /** 统一门槛：总开关 + （ownerOnly 时）主人会话。跨模块 API 面只受总开关管（模块间是代码调用）。 */
    function gate(exec) {
      if (!getSettings().enabled) return offMsg()
      if (getSettings().ownerOnly && !ownerToolCall(exec)) return notOwnerMsg()
      return null
    }

    // ---- 指引注入：浏览任务执行前组装「总纲（常驻）+ 场景手册（按目标关键词）」----
    /** 组装一段指引前缀：injectGuides 开着才注入；总纲常驻 + resolve 挑出的场景手册。 */
    function composeGuide(goal, sceneKey = '') {
      if (!getSettings().injectGuides) return ''
      const key = sceneKey || guides.resolve({ goal })
      const parts = []
      const main = guides.get('main')
      if (main) parts.push(main)
      if (key !== 'main') {
        const scene = guides.get(key)
        if (scene) parts.push(scene)
      }
      return parts.join('\n\n')
    }

    // ================= AI 工具（主人私聊可用）=================
    api.tool(() => [
      api.defineTool({
        name: 'browser_visit',
        description: '用专用浏览器打开一个网页，返回页面文本快照（标题/可点元素/正文摘要）。主人让你「看看这个网页」「打开这个链接」时用。返回开头带一份浏览指引（总纲+场景手册），照着它决定后续动作。',
        properties: { url: { type: 'string', description: '要打开的网址（http/https）' }, goal: { type: 'string', description: '这次浏览想干什么（用于挑场景指引，可选）' } },
        required: ['url'],
        execute: async ({ url, goal }, exec) => {
          const blocked = gate(exec)
          if (blocked) return blocked
          const cu = checkUrl(url)
          if (!cu.ok) return cu
          const b = getBrowser()
          const opened = await b.launch('主人要求看网页')
          if (!opened.ok) return opened
          await b.navigate(String(url), getSettings().navigateTimeoutMs)
          const snap = await b.snapshot({ mode: 'dom', maxChars: getSettings().snapshotChars })
          if (getSettings().windowVisible) await b.show(true).catch(() => {})
          // 指引注入（总纲常驻 + 按任务目标挑场景手册）：放在快照前，模型先读章法再读页面
          const guide = composeGuide(String(goal || url))
          return { ok: true, message: (guide ? guide + '\n\n——以下是当前页面——\n' : '') + snap.text, text: snap.text }
        },
      }),
      api.defineTool({
        name: 'browser_status',
        description: '查看专用浏览器的连接状态（是否在运行、资料目录、最近一次启动错误）。主人问浏览器状态时用。',
        properties: {},
        execute: async (_args, exec) => {
          const blocked = gate(exec)
          if (blocked) return blocked
          return { ok: true, message: JSON.stringify(getBrowser().status()) }
        },
      }),
    ])

    // ================= /browser 命令（api.command 本身只认主人）=================
    api.command({
      name: 'browser',
      desc: '浏览器自动化：status / open / close / goto <url> / snap [a11y] / shot / show <on|off> / guides',
      async run(arg) {
        const [verb, ...rest] = arg.trim().split(/\s+/)
        try {
          if (!getSettings().enabled && verb !== 'status' && verb !== 'guides') return offMsg().message
          const b = getBrowser()
          switch (verb) {
            case 'status':
              return JSON.stringify(b.status())
            case 'open': {
              const r = await b.launch('主人命令')
              return r.ok ? '专用浏览器已就绪。' : r.message
            }
            case 'close': {
              await b.close()
              return '已关闭专用浏览器。'
            }
            case 'goto': {
              const u = rest.join(' ').trim()
              const cu = checkUrl(u)
              if (!cu.ok) return cu.message
              const opened = await b.launch('主人命令')
              if (!opened.ok) return opened.message
              const r = await b.navigate(u, getSettings().navigateTimeoutMs)
              return `已打开：${r.title || r.url}`
            }
            case 'snap': {
              const snap = await b.snapshot({ mode: rest[0] === 'a11y' ? 'a11y' : 'dom', maxChars: getSettings().snapshotChars })
              return snap.text
            }
            case 'shot': {
              const data = await b.screenshot()
              return data ? `截图已生成（${data.length} 字节 base64）。` : '截图失败。'
            }
            case 'show': {
              const opened = await b.launch('主人命令')
              if (!opened.ok) return opened.message
              await b.show(!/^(off|0|false|关)$/i.test(rest[0] || ''))
              return '窗口已调整。'
            }
            case 'guides': {
              const list = guides.list()
              return list.length
                ? list.map((g) => `${g.key}｜${g.name}${g.source === 'custom' ? '（自定义）' : ''}，${(g.text || '').length} 字`).join('\n')
                : '指引库为空。'
            }
            case '':
              return '用法：browser status|open|close|goto <url>|snap [a11y]|shot|show <on|off>|guides'
            default:
              return `未知子命令 ${verb}`
          }
        } catch (e) {
          return `出错了：${e.message}`
        }
      },
    })

    // ================= 面板路由（精确匹配，前缀 /aurabot/api/ext/browser-ops）=================
    api.route('/status', async () => ({ ok: true, ...getBrowser().status(), settings: getSettings() }))
    api.route('/open', async () => {
      if (!getSettings().enabled) return { ok: false, error: '总开关没开，请先在面板打开' }
      return getBrowser().launch('面板')
    })
    api.route('/close', async () => {
      await getBrowser().close()
      return { ok: true }
    })
    // ---- 指引提示词库：面板查看/编辑自定义指引（仿 phone /guides 路由）----
    api.route('/guides', async (req) => {
      if (req.method === 'GET') return { guides: guides.list() }
      if (req.method === 'POST') {
        const body = await (api.core?.http?.body(req).catch(() => ({}))) || {}
        try {
          if (body.reset) return { ok: guides.remove(String(body.key || '')) } // 删自定义层 = 还原内置版
          if (body.del) { // 删除自定义指引（面板两道确认后才发；总纲 main 不可删，只能还原内置版）
            const k = String(body.key || '')
            if (k === 'main') return { ok: false, error: '主流程总纲不可删除，只能还原成内置版' }
            return { ok: guides.remove(k) }
          }
          const g = guides.upsert(String(body.key || ''), { name: body.name, text: body.text })
          return { ok: true, guide: { key: g.key, name: g.name, source: 'custom' } }
        } catch (e) { return { ok: false, error: e.message } }
      }
      if (req.method === 'DELETE') {
        const key = new URL(req.url, 'http://x').searchParams.get('key')
        if (key === 'main') return { ok: false, error: '主流程总纲不可删除，只能还原成内置版' }
        return { ok: guides.remove(key) }
      }
      return { ok: false }
    })

    // ================= 收尾：模块停下时关掉浏览器 =================
    api.onDispose(() => { getBrowser().close().catch(() => { /* 收尾尽力而为 */ }) })

    // ================= 跨模块 API 面（api.use('browser-ops') 拿到的对象）=================
    // 契约：全部原子操作；总开关关着时 launch 拒绝启动（其余操作会报「没连接」）。
    // 权限：模块间调用不查主人（是代码不是聊天入口），只受总开关约束。
    return {
      /** 确保浏览器已启动并连上 CDP。返回 { ok, message }，不抛错（失败带退避）。 */
      launch: (source = '跨模块调用') => getBrowser().launch(String(source || '跨模块调用')),
      /** 关闭浏览器（优雅退出优先）。 */
      close: () => getBrowser().close(),
      /** 连接状态。 */
      status: () => getBrowser().status(),
      /** 打开网址等加载完成 → { ok, url, title }。过站点白名单。 */
      navigate: (url, timeoutMs = 0) => {
        const cu = checkUrl(url)
        if (!cu.ok) return Promise.resolve(cu)
        return getBrowser().navigate(url, timeoutMs || getSettings().navigateTimeoutMs)
      },
      /** 真鼠标点屏幕坐标。 */
      click: (x, y) => getBrowser().clickXY(x, y),
      /** 点一个选择器命中的元素 → { ok, found }。 */
      clickSelector: (selector) => getBrowser().clickSelector(selector),
      /** 往当前焦点输入文字。 */
      input: (text) => getBrowser().input(text),
      /** 清空当前焦点输入框（Ctrl+A + 退格）。 */
      clearInput: () => getBrowser().clearFocused(),
      /** 按一下回车。 */
      pressEnter: () => getBrowser().pressEnter(),
      /** 滚动页面：scroll({ dx, dy })。 */
      scroll: (opts) => getBrowser().scroll(opts || {}),
      /** 截屏（可传 clip={x,y,width,height}）→ data:image/png;base64。 */
      screenshot: (clip) => getBrowser().screenshot(clip),
      /** 页面快照：snapshot({ mode:'dom'|'a11y', maxChars }) → { ok, mode, text }。 */
      snapshot: (opts) => getBrowser().snapshot({ maxChars: getSettings().snapshotChars, ...(opts || {}) }),
      /** 在页面里跑一段表达式拿返回值。 */
      evaluate: (expression, ms) => getBrowser().evaluate(expression, ms),
      /** 窗口挪进/挪出屏幕（show(true) 给主人扫二维码用）。 */
      show: (visible) => getBrowser().show(visible),
      /** 指引库面：list()/get(key)/resolve({goal})/compose(goal)（总纲+场景手册组装）。 */
      guides: {
        list: () => guides.list(),
        get: (key) => guides.get(key),
        resolve: (o) => guides.resolve(o || {}),
        /** 组装一段注入文本：总纲常驻 + 按目标关键词挑的场景手册；injectGuides 关着时空串。 */
        compose: (goal) => composeGuide(String(goal || '')),
      },
      /**
       * 浏览任务一站式入口：launch → navigate（过白名单）→ 注入总纲+场景手册 → 快照。
       * 返回 { ok, guide, message, text }：guide 是注入的指引文本（关注入为空串），
       * text 是页面快照，message 是两者拼好的完整上下文（可直接交给决策器）。
       */
      runTask: async ({ goal, url } = {}) => {
        if (!getSettings().enabled) return offMsg()
        const g = String(goal || '')
        if (url) {
          const cu = checkUrl(url)
          if (!cu.ok) return cu
        }
        const opened = await getBrowser().launch('跨模块浏览任务')
        if (!opened.ok) return opened
        if (url) {
          const nav = await getBrowser().navigate(String(url), getSettings().navigateTimeoutMs)
          if (!nav.ok) return nav
        }
        const snap = await getBrowser().snapshot({ mode: 'dom', maxChars: getSettings().snapshotChars })
        const guide = composeGuide(g)
        return {
          ok: true,
          guide,
          text: snap.text,
          message: (guide ? guide + '\n\n——以下是当前页面——\n' : '') + snap.text,
        }
      },
    }
  },
}

/** 读一个整型设置：非法退回默认值，再夹到 [lo, hi]。 */
function clampInt(v, def, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
