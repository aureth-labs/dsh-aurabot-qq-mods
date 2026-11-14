// 刷小红书（xhs）v0.1.0：装配层。专用浏览器里登录一次；逛推荐/搜索、看笔记写记忆、
// 点赞收藏评论（人格生成、每日上限）、认别人发来的小红书链接、看主人私信并回复；
// 发帖走「草稿 → 主人确认」两步，绝不闷头发。各能力独立开关（默认全关）+ 权限档
// profilePerms.xhs*（社区模块没配时 permOf 抛错/缺档兜底放行，见 permAllow）。
// 实现层见 lib/duty.mjs（createXhs，契约 §3）与 lib/site.mjs（DOM 解析，契约 §2）。

import { readFileSync } from 'node:fs'
import { createXhs } from './lib/duty.mjs'
import { loadShots, pickShot, shotPath, deleteShot, validFile } from './lib/shots.mjs'

const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
const { str } = __lib('tools/tools.js')
const { dataDir, readJson, writeJson } = __lib('core/store.js') // duty 的状态文件也在插件数据目录（xhs.json）
const llm = (() => { try { return __lib('core/llm.js') } catch { return {} } })() // canSeeImages（视觉看图面板态用）
// 权限档：社区模块的 profilePerms 可能没配这些键，permOf 抛错时兜底放行（off 才关）。
const access = (() => { try { return __lib('chat/access.js') } catch { return {} } })()
const permAllow = (g, key) => {
  try { return access.permOf(g, key) !== 'off' } catch { return true }
}
const visible = (g, key, chat) => {
  try { return access.profileToolVisible(g, key, chat) } catch { return true }
}
const permits = (g, key, chat, allOwner) => {
  try { return access.profilePermits(g, key, chat, allOwner) } catch { return { ok: true } }
}
// 沉默判断（回私信时别把「[去刷小红书]」这类标记当话发出去）
const silenceOf = (() => { try { return __lib('chat/reply.js').isSilence } catch { return () => false } })()

export default {
  id: 'xhs',
  name: '刷小红书',
  version: '0.3.5',
  api: 1,
  description: '用专用浏览器刷小红书：逛推荐/搜索、看笔记写记忆、点赞收藏评论（人格生成、每日上限）、认别人发来的小红书链接、看主人的私信并回复；发帖走「草稿 → 主人确认」两步，绝不闷头发。各能力独立开关，默认全关。',
  panel: 'panel.js', // 自定义面板（panel.js 接管全部设置表单；settings 数组保留作兜底与检查用）
  defaults: {
    enabled: false,          // 总开关，默认关（要在面板打开）
    dryRun: false,           // 试运行：只记录不真动手
    browserPath: '',         // Edge/Chrome 路径，空 = 自动找
    perRun: 5,               // 每轮最多认真看几篇
    dwellMin: 8,             // 每篇停留秒数下限
    dwellMax: 25,            // 每篇停留秒数上限
    maxWatchPerDay: 40,      // 每天最多认真看几篇
    maxRunsPerDay: 4,        // 每天最多自动刷几轮
    intervalHours: 4,        // 两轮之间隔多久
    likeEnabled: true,       // 点赞开关
    collectEnabled: true,    // 收藏开关
    commentEnabled: true,    // 评论开关
    shareEnabled: true,      // 分享给主人开关（v0.1 只发 QQ）
    dmEnabled: true,         // 私信开关（看主人私信并回）
    publishEnabled: false,   // 发帖开关（默认关；开了也要主人确认草稿才发）
    capLike: 20,             // 每天点赞上限
    capCollect: 10,          // 每天收藏上限
    capComment: 3,           // 每天评论上限
    capShare: 5,             // 每天分享上限
    capPublish: 1,           // 每天发帖上限
    minWriteGapSec: 90,      // 两次写操作（赞/藏/评/发）最小间隔秒
    newAccountDays: 3,       // 刚登录前几天算新号，写上限减半
    shareTo: 'qq',           // 分享渠道：qq=QQ 私聊 / dm=站内私信 / both=两边都发（站内失败回落 QQ）
    dmPollMinutes: 7,        // 每隔几分钟看一次主人私信
    ownerInput: '',          // 主人的小红书主页链接或 userId（核对后才能看私信/发帖确认）
    keywords: '',            // 关键词巡游：每行一个关键词，隔轮交替搜；空=只刷推荐
    visionEnabled: false,    // 视觉看图：下载配图给模型看，描述写进她的观感（默认关）
    shotChance: 0.3,         // 看过的图按这个概率存进截图库（主人之后可以叫她发一张）
    atOwnerEnabled: false,   // 真·@主人：评论里真 @（只认「核对」写进来的主人号，默认关）
    capAtOwner: 3,           // 每天 @ 主人上限
    replyEnabled: false,     // 回复评论：定时回自己笔记下的新评论（默认关）
    capReply: 5,             // 每天回评论上限
    replyPollMinutes: 30,    // 每隔几分钟看一眼笔记下的新评论
    shotLibrary: 30,         // 截图库最多留几张（超了删最旧）
  },
  // 设置表单全部由 panel.js 接管（照 phone 模块的做法：settings 数组留空，
  // 平台页就不会再画一份原生表单压在自定义面板上面）；defaults 仍是运行时兜底值。
  // 各键的含义与默认值见 panel.js 顶部的 DEFAULTS 与各滑块/开关的 hint。
  settings: [],

  setup(api) {
    const { hub, http } = api.core
    const hooks = api.__xhsTestHooks || {}

    // 模块 settings 整体 + 插件主配置里的 ownerQQ/ownerName：duty 的暂停汇报、分享、
    // 私信记忆要用；权限档 profileToolVisible/profilePermits 判「是不是主人」也要用
    //（社区模块 settings 里没有这两项，不并上就永远判不出主人、工具一个都不挂）。
    const cfgAll = () => ({ ...api.settings(), ownerQQ: api.config().ownerQQ, ownerName: api.config().ownerName, browser: api.config().browser })

    // 分享/汇报给主人 QQ：先问出站治理面（api.proactive，宿主绑定模块身份），
    // 治理面没注入/不支持/被拦时退回 hub.sendText 直发；试运行短路治理面（不进账本），
    // 但暂停这类「系统消息」照样直发兜底（照抖音模块同口径）。
    const sendOwnerQQ = async (text, itemId, logTag) => {
      const g = cfgAll()
      const to = `private:${api.config().ownerQQ}`
      if (!g.dryRun && api.proactive?.submit) {
        try {
          const r = await api.proactive.submit({ itemId, to, channel: 'qq', text })
          if (r && r.deliveryId !== null && r.deliveryId !== undefined && r.state !== 'unsupported') {
            return ['sent', 'sending', 'pending'].includes(String(r.state || ''))
          }
        } catch (error) {
          api.log.warn(`${logTag}经 api.proactive 提交失败，回退直发：`, error?.message)
        }
      }
      try {
        return Boolean(await hub.sendText?.(to, text))
      } catch (error) {
        api.log.warn(`${logTag}直发失败：`, error?.message)
        return false
      }
    }

    // 主人核对记录：duty 只能经这个回调写状态文件里的 ownerConfirmed 字段（契约 §3）。
    // duty 在 confirmOwner 里写完会自己从文件并回状态再 save，这里只负责落盘。
    const setOwnerConfirmed = (rec) => {
      try {
        const file = dataDir('xhs.json')
        const cur = readJson(file, () => ({ version: 1 }))
        writeJson(file, { ...(cur && typeof cur === 'object' ? cur : {}), version: 1, ownerConfirmed: rec })
      } catch (error) {
        api.log.warn('主人核对记录没写进去：', error?.message)
      }
      return rec
    }

    // 截图库：目录由 index 定（数据目录 shots/），函数是 (dir, file) 二参式
    const shotsDir = hooks.shotsDir || api.dataDir('shots')

    // 图片通道（验证码截图/截图库发图）：图片段经 hub.sendSegments 直发（出站治理面只管文本，
    // 图片段宿主不支持就直发兜底）；caption 文本照旧先问治理面。dryRun 只 log 不发。
    const sendImageToOwner = async (b64png, caption, itemId) => {
      const g = cfgAll()
      const to = `private:${api.config().ownerQQ}`
      if (g.dryRun) {
        api.log.info(`试运行：本来要发图片给主人（${String(b64png || '').length} 字节 base64）：${caption || ''}`)
        return true
      }
      if (!b64png) return false
      let ok = false
      try {
        ok = Boolean(await hub.sendSegments?.(to, [{ type: 'image', data: { file: 'base64://' + b64png } }], caption || '[xhs]'))
      } catch (error) {
        api.log.warn('图片直发失败：', error?.message)
      }
      // 图片发出去了，文字说明照旧走治理面（失败不影响图片，也不回滚）
      if (ok && caption && api.proactive?.submit && itemId) {
        try { await api.proactive.submit({ itemId, to, channel: 'qq', text: caption }) } catch (error) { api.log.warn('图片说明经治理面提交失败（图已发）：', error?.message) }
      }
      return ok
    }

    const dy = createXhs({
      // 模块 settings 整体（平铺键）；再并上 ownerQQ/ownerName——duty 的暂停汇报、
      // 分享与私信记忆都要用，社区模块的 settings 里没有这两项，从插件主配置取。
      getConfig: cfgAll,
      setOwnerConfirmed,
      think: (prompt, opts) => api.think(prompt, opts),
      sendOwnerQQ,
      pushToSession: (chat, content, senderId, opts) => hub.pushToSession(chat, content, senderId, opts),
      memory: api.lazy('memory'),
      log: api.log,
      now: hooks.now,
      wait: hooks.wait,
      isSilence: hooks.isSilence || silenceOf,
      site: hooks.site,
      browser: hooks.browser,
      dsh: hooks.dsh || api.dsh,                       // 视觉看图要用的 DSH 句柄（不传视觉安静跳过）
      shotsDir,                                        // 截图库目录（index 定，shots.mjs 不写死）
      sendImageToOwner: hooks.sendImageToOwner || sendImageToOwner,
      shots: hooks.shots,                              // 测试可注入假的 shots/vision；不传用 lib 真实现
      vision: hooks.vision,
      proactive: api.proactive,         // duty 内可选链降级，不碰也不报错
    })
    api.every(60_000, () => dy.tick(), '刷小红书')
    api.onDispose(() => dy.dispose())

    // ---- 给鱼的工具（权限档 profilePerms.xhs*，社区模块没配时默认仅主人、off 才关）----
    api.tool(({ chat, sessionId }) => {
      const g = cfgAll()
      if (!g.enabled || chat?.kind === 'system') return []
      // 执行时再查一遍权限（面板可能刚改过）
      const guarded = (key, run) => async (args) => {
        const c = cfgAll()
        if (!c.enabled) return { ok: false, message: '小红书模块没打开' }
        if (!permAllow(c, key)) return { ok: false, message: '这个操作在面板里关掉了' }
        const p = permits(c, key, chat, hub.turnSendersAllOwner?.(sessionId))
        if (p && p.ok === false) return p
        return run(args)
      }
      const tools = []
      if (visible(g, 'xhsBrowse', chat)) {
        tools.push(api.defineTool({
          name: 'xhs_watch',
          description: '打开一个小红书笔记看看：读标题、正文、赞藏评和热评，看完再聊。别人发来小红书链接（xhslink.com 短链也行）或 24 位笔记 id 时用。',
          properties: { link: str('小红书笔记链接、xhslink.com 短链或 24 位笔记 id') },
          required: ['link'],
          execute: guarded('xhsBrowse', ({ link }) => dy.watch(String(link || ''))),
        }))
        tools.push(api.defineTool({
          name: 'xhs_recent',
          description: '查最近看过的小红书笔记及真实链接。有人问刚才刷了什么、要再打开某篇时先用；没有记录就如实说。',
          properties: {},
          execute: guarded('xhsBrowse', async () => {
            const seen = dy.recentNotes(10)
            return { ok: true, message: seen.length ? seen.map((x) => `《${x.title || '无标题'}》${x.url}`).join('\n') : '最近没有看过的笔记记录', notes: seen }
          }),
        }))
        tools.push(api.defineTool({
          name: 'xhs_browse',
          description: '现在去刷一会儿小红书推荐，有人让你去刷小红书、找篇笔记给他时用。只是开始刷：要几分钟，刷完系统会把结果（看了什么、分享了哪篇）告诉你，在那之前别说已经分享了。主人开口要的话，这轮一定会挑一篇分享给主人。',
          properties: {},
          execute: guarded('xhsBrowse', async () => dy.browse({ ownerAsked: Boolean(hub.turnHasOwner?.(sessionId)), report: chat })),
        }))
      }
      if (visible(g, 'xhsLike', chat)) tools.push(api.defineTool({
        name: 'xhs_like',
        description: '给一个小红书笔记点赞。有人明确让你点赞时用。link 填笔记链接或 id。',
        properties: { link: str('小红书笔记链接或 24 位笔记 id') },
        required: ['link'],
        execute: guarded('xhsLike', ({ link }) => dy.likeNote(String(link || ''))),
      }))
      if (visible(g, 'xhsLike', chat)) tools.push(api.defineTool({
        name: 'xhs_collect',
        description: '收藏一个小红书笔记。有人明确让你收藏时用。link 填笔记链接或 id。',
        properties: { link: str('小红书笔记链接或 24 位笔记 id') },
        required: ['link'],
        execute: guarded('xhsLike', ({ link }) => dy.collectNote(String(link || ''))),
      }))
      if (visible(g, 'xhsComment', chat)) tools.push(api.defineTool({
        name: 'xhs_comment',
        description: '在一个小红书笔记下发评论。有人明确让你去评论时用。link 填笔记链接或 id，text 是评论内容（100 字以内）。发完别说「已经赞了 / 已经评论了」之外没做的事。',
        properties: { link: str('小红书笔记链接或 24 位笔记 id'), text: str('评论内容') },
        required: ['link', 'text'],
        execute: guarded('xhsComment', ({ link, text }) => dy.commentNote(String(link || ''), String(text || ''))),
      }))
      if (visible(g, 'xhsDm', chat)) tools.push(api.defineTool({
        name: 'xhs_send_dm',
        description: '主人明确要求你给某个小红书用户发私信时用。target 填对方的主页链接或 userId，text 是要说的话（300 字以内）。只发给主人指定的人；网页版私信结构不稳，发不成就照实说。',
        properties: { target: str('对方小红书主页链接或 userId'), text: str('要说的话') },
        required: ['target', 'text'],
        execute: guarded('xhsDm', ({ target, text }) => dy.directDm({ target: String(target || ''), text: String(text || '') })),
      }))
      if (visible(g, 'xhsShareOwner', chat)) tools.push(api.defineTool({
        name: 'xhs_share_owner',
        description: '主人明确要求把某个小红书笔记分享给TA时用；link 填笔记链接、短链或 24 位笔记 id。分享发到主人 QQ 私聊。发完照实说，没发成就说没发成。',
        properties: { link: str('小红书笔记链接或 24 位笔记 id') },
        required: ['link'],
        execute: guarded('xhsShareOwner', ({ link }) => dy.shareNote(String(link || ''))),
      }))
      if (visible(g, 'xhsShareOwner', chat)) tools.push(api.defineTool({
        name: 'xhs_confirm_owner',
        description: '主人当面核对TA的小红书号时用：input 填主人自己主页的链接或 userId。核对通过后她才认主人的私信、才接受发帖确认。主人没亲口让你核对时不要乱填。',
        properties: { input: str('主人的小红书主页链接或 userId') },
        required: ['input'],
        execute: guarded('xhsShareOwner', ({ input }) => dy.confirmOwner(String(input || ''))),
      }))
      if (visible(g, 'xhsShareOwner', chat)) tools.push(api.defineTool({
        name: 'xhs_send_shot',
        description: '主人说「发张截图 / 给我看看你刷到的」时用：从截图库里挑一张最匹配的（query 填关键词，比如笔记标题里的词，不填就挑最新的）发到当前聊天。发完照实说；库里没有就说没有。',
        properties: { query: str('挑图的关键词，可选；不填挑最新一张') },
        required: [],
        execute: guarded('xhsShareOwner', async ({ query } = {}) => {
          const items = loadShots(shotsDir).items
          const it = pickShot(items, String(query || ''))
          if (!it) return { ok: false, message: items.length ? '截图库里没有匹配的截图' : '截图库还是空的，刷几轮有了才行' }
          let b64 = ''
          try { b64 = readFileSync(shotPath(shotsDir, it.file)).toString('base64') } catch (error) { return { ok: false, message: '截图文件读不出来：' + error.message } }
          const caption = `《${it.title || '无标题'}》的截图${it.note ? '：' + String(it.note).slice(0, 60) : ''}`
          const sent = await hub.sendSegments?.(chat.chatId, [{ type: 'image', data: { file: 'base64://' + b64 } }], caption)
          return sent ? { ok: true, message: `发了《${it.title || '无标题'}》的截图` } : { ok: false, message: '截图没发出去（网关没确认）' }
        }),
      }))
      if (visible(g, 'xhsShareOwner', chat)) tools.push(api.defineTool({
        name: 'xhs_shot_list',
        description: '查小红书截图库存：每张来自哪篇笔记、什么时候存的。主人问「你截了什么图 / 库里有什么」时用。',
        properties: {},
        execute: guarded('xhsShareOwner', async () => {
          const items = loadShots(shotsDir).items
          return { ok: true, shots: items, message: items.length ? items.map((x) => `《${x.title || '无标题'}》${x.at ? new Date(x.at).toLocaleString() : ''}`).join('\n') : '截图库还是空的' }
        }),
      }))
      if (visible(g, 'xhsComment', chat)) tools.push(api.defineTool({
        name: 'xhs_reply_comments',
        description: '有人让你「去看看评论 / 回一下笔记下的评论」时用：她会翻自己笔记下的新评论，挑该回的用她的人格回（第一次只记不回；每天有上限）。要几分钟，刷完系统会把结果告诉你，在那之前别说已经回了。',
        properties: {},
        execute: guarded('xhsComment', async () => dy.replyComments()),
      }))
      if (visible(g, 'xhsPublish', chat)) tools.push(api.defineTool({
        name: 'xhs_publish_draft',
        description: '有人要你发小红书笔记时用：先存成草稿（title 20 字内、desc 1000 字内、images 填已放进模块数据目录 xhs/ 下的图片路径）。草稿不会自己发出去，回复里要说清「已存草稿，等主人确认后才会发」，绝不说已经发了。',
        properties: { title: str('笔记标题（20 字以内）'), desc: str('笔记正文（1000 字以内）'), images: { type: 'array', items: { type: 'string' }, description: '图片路径数组，可选；必须在模块数据目录 xhs/ 下' } },
        required: ['title', 'desc'],
        execute: guarded('xhsPublish', async ({ title, desc, images }) => {
          const r = await dy.saveDraft({ title: String(title || ''), desc: String(desc || ''), images: Array.isArray(images) ? images.map(String) : [] })
          return r?.ok ? { ...r, message: `${r.message || '已存草稿'}（等主人确认后才会真的发，现在还没发）` } : r
        }),
      }))
      if (visible(g, 'xhsPublish', chat)) tools.push(api.defineTool({
        name: 'xhs_draft_list',
        description: '查小红书发帖草稿清单（等主人确认的、已发的）。主人问草稿/发帖进度时用。',
        properties: {},
        execute: guarded('xhsPublish', async () => {
          const list = await dy.pendingDrafts()
          return { ok: true, drafts: list, message: list.length ? list.map((d) => `#${d.id} 《${d.title}》待确认`).join('\n') : '没有待确认的草稿' }
        }),
      }))
      if (visible(g, 'xhsPublish', chat) && chat?.kind === 'private' && String(chat?.userId) === String(api.config().ownerQQ)) tools.push(api.defineTool({
        name: 'xhs_publish_confirm',
        description: '主人确认发帖草稿时用（只有主人私聊里有这个工具）：id 填草稿 id。确认后才会真的发到小红书；驳回用面板。',
        properties: { id: str('草稿 id'), reject: { type: 'boolean', description: 'true = 驳回这条草稿' } },
        required: ['id'],
        execute: guarded('xhsPublish', ({ id, reject }) => reject ? dy.rejectDraft(String(id || '')) : dy.confirmDraft(String(id || ''))),
      }))
      return tools
    })

    // ---- 面板路由（模块相对，最终挂在 /aurabot/api/ext/xhs/ 下）----
    api.route('/state', async () => {
      const s = { ok: true, ...dy.state() }
      // duty 的 state() 用 loadShots 直接取 length 会拿到 undefined（它返回 {items}）：
      // 装配层兜一道，别让面板截图库存数空着（duty 侧的下轮修正同步给 xhs-duty）。
      if (s.shots === undefined) { try { s.shots = loadShots(shotsDir).items.length } catch { s.shots = 0 } }
      return s
    })
    api.route('/account', async () => dy.account(true))
    api.route('/login', async () => dy.loginStep(true))
    api.route('/login/status', async () => dy.loginStep(false))
    api.route('/window', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.showWindow(Boolean(b?.visible))
    })
    api.route('/run', async () => dy.browse())
    api.route('/share', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.shareNote(String(b?.link ?? ''))
    })
    api.route('/dm', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.directDm({ target: String(b?.target ?? ''), text: String(b?.text ?? '') })
    })
    api.route('/dms', async () => dy.checkOwnerDms())
    api.route('/replies/run', async () => dy.replyComments())
    api.route('/shots', async () => {
      // 缩略图直接带 dataURL（模块路由回 JSON，没法给面板流二进制）；读不出来的标 src='' 让前端隐藏
      const items = loadShots(shotsDir).items.map((x) => {
        let src = ''
        try { src = 'data:image/jpeg;base64,' + readFileSync(shotPath(shotsDir, x.file)).toString('base64') } catch (error) { api.log.warn('截图读不出来（面板跳过）：', x.file, error?.message) }
        return { ...x, src }
      })
      return { ok: true, shots: items }
    })
    api.route('/shot/delete', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      const file = String(b?.file ?? '')
      if (!validFile(file)) return { ok: false, message: 'file 要是 12 位 hex.jpg 的库内文件名' }
      return deleteShot(shotsDir, file)
    })
    api.route('/vision/state', async () => {
      const g = cfgAll()
      let can = false
      try { can = Boolean(llm.canSeeImages?.(api.dsh, g)) } catch { can = false }
      return { ok: true, visionEnabled: g.visionEnabled === true, canSeeImages: can, usable: g.visionEnabled === true && can }
    })
    api.route('/confirm-owner', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.confirmOwner(String(b?.input ?? api.settings().ownerInput ?? ''))
    })
    api.route('/drafts', async () => ({ ok: true, drafts: await dy.pendingDrafts() }))
    api.route('/draft/confirm', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.confirmDraft(String(b?.id ?? ''))
    })
    api.route('/draft/reject', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return dy.rejectDraft(String(b?.id ?? ''))
    })
    return dy
  },
}
