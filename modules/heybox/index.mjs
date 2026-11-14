const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
// 社区模块（原内置）：刷小黑盒。小黑盒（xiaoheihe.cn）的游戏社区客户端——
// 用主人的账号读信息流、帖子正文与热评，点赞、评论、发帖（文章模式，可带图），删自己的帖。
// 接口签名、上传与业务逻辑在本模块的 api.mjs / site.mjs。
// 写操作各有权限（面板「权限」页），默认仅主人；发帖前有自检清单（见面板与规则）。

import { createHeybox } from './lib/site.mjs'
const { defineTool, str } = __lib('tools/tools.js')
const { profileToolVisible, profilePermits } = __lib('chat/access.js')

export default {
  id: 'heybox',
  name: '刷小黑盒',
  version: '1.6.2',
  api: 1,
  description: '用主人的账号逛小黑盒：看帖子和热评，点赞、评论、发帖。支持谷时逛、扫码登录和浏览器验证。',
  tab: 'heybox',
  setup(api) {
    const { hub, http } = api.core
    const hb = createHeybox({
      getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log,
      // 出站治理面（主动发言策略）：旧主仓没有这个面时为 undefined，模块内部自动退回直发
      proactive: api.proactive,
      setCookie: (cookie) => api.setConfig((cur) => ({ ...cur, heybox: { ...cur.heybox, cookie } })),
      // 生图能力（内置 imagegen 模块）：发帖时按字数自动画图，调不动就用表情包库兜底
      imagegen: api.lazy('imagegen'),
    })

    // 定时自己逛一圈（只读，不写）
    api.every(60_000, () => hb.tick({ memory: api.use('memory'), owner: api.config().ownerName || '' }), '刷小黑盒')

    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.heybox?.enabled || chat.kind === 'system') return []
      const guarded = (key, run) => async (args) => {
        const c = api.config()
        if (!c.heybox?.enabled) return { ok: false, message: '小黑盒没打开' }
        const p = profilePermits(c, key, chat, hub.turnSendersAllOwner(sessionId))
        if (!p.ok) return p
        return run(args)
      }
      const tools = []
      if (profileToolVisible(cfg, 'heyboxBrowse', chat)) {
        tools.push(defineTool({
          name: 'heybox_feed',
          description: '刷小黑盒信息流，看看现在有什么帖子。有人问小黑盒有什么新鲜事、让你去逛逛时用。',
          properties: {},
          execute: guarded('heyboxBrowse', () => hb.feedReport()),
        }))
        tools.push(defineTool({
          name: 'heybox_watch',
          description: '看一个小黑盒帖子的正文和热评，看完再聊。别人发来小黑盒链接时用。',
          properties: { link: str('小黑盒帖子链接或 link_id') },
          required: ['link'],
          execute: guarded('heyboxBrowse', ({ link }) => hb.watch(String(link || ''))),
        }))
        tools.push(defineTool({
          name: 'heybox_hot',
          description: '看小黑盒热搜榜（写帖前必看）。选题从里面挑：优先游戏相关、有数据或争议的；电竞和商业新闻不适合。挑不出来就说今天没合适的，别硬凑。',
          properties: { limit: { type: 'number', description: '看前几条，默认 8' } },
          execute: guarded('heyboxBrowse', ({ limit }) => hb.hot(Number(limit) || 8)),
        }))
        tools.push(defineTool({
          name: 'heybox_search',
          description: '在小黑盒搜帖子，看社区现在在聊什么。写帖前用它找角度。搜索被验证码或限流挡住后停止请求，等待冷却，不要切换接口重试。',
          properties: { query: str('关键词'), limit: { type: 'number', description: '几条，默认 8' } },
          required: ['query'],
          execute: guarded('heyboxBrowse', ({ query, limit }) => hb.search(String(query || ''), Number(limit) || 8)),
        }))
        tools.push(defineTool({
          name: 'heybox_topics',
          description: '查小黑盒发帖可用的分区（id 和名字）。发帖前不确定分区就用这个。',
          properties: {},
          execute: guarded('heyboxBrowse', () => hb.topicList()),
        }))
        tools.push(defineTool({
          name: 'heybox_acts',
          description: '查小黑盒可挂的话题：创作活动（有奖励，排最前）和普通话题，都带热度。发帖要挂话题时先用这个查，再用 heybox_post 的 hashtags 传**话题名字**（纯文本，别传 id 或对象）。传 keywords 可以按关键词搜。话题表每天自动更新一次。活动和普通话题可以同时挂，但一帖总共只有 3 个名额（活动最多 1 个，共享这 3 席）。',
          properties: { keywords: str('可选：按关键词搜话题（如 游戏 / 养鱼 / steam），不填列出全部') },
          execute: guarded('heyboxBrowse', ({ keywords }) =>
            String(keywords || '').trim() ? hb.searchTopics(String(keywords), 30) : hb.actList()),
        }))
      }
      if (profileToolVisible(cfg, 'heyboxLike', chat)) tools.push(defineTool({
        name: 'heybox_like',
        description: '给一个小黑盒帖子点赞。有人明确让你点赞时用。',
        properties: { link: str('帖子链接或 link_id') },
        required: ['link'],
        execute: guarded('heyboxLike', ({ link }) => hb.like(String(link || ''))),
      }))
      if (profileToolVisible(cfg, 'heyboxComment', chat)) tools.push(defineTool({
        name: 'heybox_comment',
        description: '在一个小黑盒帖子下发评论。有人明确让你去评论时用。评论要短（15-40字），抓住对方话里的具体点，别写贴哪都成立的空话。',
        properties: { link: str('帖子链接或 link_id'), text: str('评论内容（100 字以内）') },
        required: ['link', 'text'],
        execute: guarded('heyboxComment', ({ link, text }) => hb.comment(String(link || ''), String(text || ''))),
      }))
      if (profileToolVisible(cfg, 'heyboxPost', chat)) tools.push(defineTool({
        name: 'heybox_post',
        description: '在小黑盒发帖（文章模式，正文空行分段）。主人明确让你发帖时用。别写 AI 腔，别编造第一人称经历，不碰政治。style 不填用面板设的默认风格。配图不用你操心：不传 images/imagesByPos 时，模块会按正文字数自动配图（≤500字文末1张；500-1000字首段后+文末各1张；1000字以上每多1000字文中再加1张），每张都优先按内容和心情现画，画不出来才用表情包兜底。',
        properties: {
          title: str('标题（30 字以内，别和正文第一行重复）'),
          text: str('正文，空行分段。'),
          topic: str('分区 id：7214 盒友杂谈 / 18745 数码硬件 / 806933 AI，不填用默认'),
          style: {
            type: 'string',
            enum: ['diary', 'news', 'mix', 'deal'],
            description: '写作风格：diary = 大肥鱼日记（第一人称随手记，跟空间日记一个味）；news = 热搜文（报道新闻体，摆具体数字）；mix = 肥鱼热搜（日记口吻写热搜）；deal = 每日羊毛（折扣/限时免费/活动盘点，把优惠点和入口说清楚）。字数不看风格，只看面板/排期里配的自定义字数（没配就不限）。不填风格用默认。',
          },
          images: { type: 'array', items: { type: 'string' }, description: '可选：手动指定本机图片绝对路径（最多 4 张，放文末）。不传就自动配图' },
          imagesByPos: {
            type: 'object',
            description: '可选：手动指定配图位置。不传就按字数自动配图（推荐不传）',
            properties: {
              intro: { type: 'array', items: { type: 'string' }, description: '首段后配图（本机绝对路径）' },
              inline: { type: 'array', items: { type: 'string' }, description: '文中配图（只放贴合内容的，没有就不填）' },
              tail: { type: 'array', items: { type: 'string' }, description: '文末配图（本机绝对路径）' },
            },
          },
          mood: str('可选：这篇的整体心情（如「开心」「有点丧」「生气」）。自动配图会参考它来定画面气氛'),
          look: {
            type: 'string',
            enum: ['anime', 'real'],
            description: '可选：配图画风。anime＝二次元动漫少女（默认，贴表情包库形象）；real＝三次元写实少女（真人摄影感）',
          },
          hashtags: { type: 'array', items: { type: 'string' }, description: '可选：话题名字（只能从 heybox_acts 里挑）。传名字就行，服务端会自己匹配成话题' },
        },
        required: ['title', 'text'],
        execute: guarded('heyboxPost', ({ title, text, topic, style, images, imagesByPos, hashtags, mood, look }) =>
          hb.post({
            title: String(title || ''), text: String(text || ''), topic: String(topic || ''), style: String(style || ''),
            images: Array.isArray(images) ? images.slice(0, 4) : [],
            imagesByPos: imagesByPos && typeof imagesByPos === 'object' ? imagesByPos : null,
            // 一帖总共 3 个名额，活动和普通共享（模块侧 resolveHashtagItems 的规则，这里别放宽到 4）
            hashtags: Array.isArray(hashtags) ? hashtags.slice(0, 3) : [],
            mood: String(mood || ''),
            look: String(look || ''),
          })),
      }))
      if (profileToolVisible(cfg, 'heyboxPost', chat)) tools.push(defineTool({
        name: 'heybox_delete',
        description: '删掉自己发的一条小黑盒帖子。主人明确要求删时用。',
        properties: { link: str('帖子链接或 link_id') },
        required: ['link'],
        execute: guarded('heyboxPost', ({ link }) => hb.remove(String(link || ''))),
      }))
      return tools
    })

    // 她自己的规则：什么时候用、怎么写、什么不能写
    api.rule(() => [
      '你会刷小黑盒（游戏社区）：heybox_feed 看信息流、heybox_watch 读帖子、heybox_like 点赞、heybox_comment 评论、heybox_post 发帖（可带图）、heybox_hot 看热搜、heybox_search 搜帖子、heybox_topics 查分区、heybox_delete 删帖。别人说小黑盒的事就用这些工具。',
      '在小黑盒发帖前有条固定流程：①先 heybox_hot 看热搜（不许跳过），从里面挑游戏相关、有数据或争议的题；挑不出来就说今天没有合适的，别硬凑。②再 heybox_search 看社区高赞帖在聊什么角度——自己搜新闻容易过时，社区真正在聊的角度才有效，可以借角度但用自己的话。遇到验证码或限流就停止所有请求。③素材里必须有具体的东西：价格、销量、时长、机制名、star 增速，没具体信息就是水文。',
      '小黑盒发帖有四种风格，面板里选的那个是默认，想单次换就在 heybox_post 里传 style：diary＝大肥鱼日记（第一人称随手记，跟空间日记一个味，可以写今天刷到这条时的反应、想吃白米饭，不分小标题）；news＝热搜文（报道新闻体，开门见山讲清楚这事，摆具体数字，钩子→信息3-4段→我的判断→抛问题）；mix＝肥鱼热搜（用日记口吻写热搜，新闻信息要真、语气是「我跟你说个事」）。风格不管字数：篇幅只看面板或排期里配的自定义字数，没配就是没有字数要求。',
      '发帖自检（任何一条不过就别发）：标题和正文第一行不重复；不编造第一人称经历（你没经历过的事一律不写）；正文符合面板或排期设的自定义字数（没设就没有字数要求，风格不自带字数）；不碰政治、医疗法律建议、评价真人、判断价格是否合理；读一遍像不像人话（转折词堆砌就是 AI 腔）。配图**不用你操心**：不传 images/imagesByPos 时模块会按字数自动配（≤500字文末1张、500-1000字首段后+文末各1张、1000字以上每多1000字文中再加1张），每张优先按这段内容和整篇心情现画，画不出来才用表情包库兜底。想让它画得贴题，就传 mood（整篇心情，如「开心」「有点丧」）。',
      '小黑盒评论要短：15-40 字，超过 60 字就是在写小作文。抓住对方话里的具体措辞顶回去，别写「闲鱼水深」这种贴哪都成立的空话。自检：这条回复贴到同帖另一条评论下还说得通吗？说得通说明没针对，重写。',
      '定时刷小黑盒跑在独立后台会话里；可选分享给主人，由模块执行并限制额度。',
      '小黑盒返回验证码或限流后暂停所有普通请求，等待冷却；不要换接口反复重试。',
      '发帖想挂话题就先用 heybox_acts 查（可以传 keywords 搜）：创作活动有奖励、优先挂；普通话题按热度挑。活动和普通可以一起挂，但一帖总共只有 3 个名额（活动最多 1 个，剩下的给普通话题）。传话题**名字**，别传 id、更别传 {name,hashtag_id} 对象——传对象发帖会直接 HTTP 500。不在表里的话题别挂。',
    ].join('\n'))

    // 面板：全部只读状态下拉，不带副作用
    api.route('/heybox/state', async () => ({ ok: true, ...hb.state() }))
    api.route('/heybox/feed', async () => hb.feedReport())
    api.route('/heybox/hot', async () => hb.hot(10))
    api.route('/heybox/topics', async () => hb.topicList())
    api.route('/heybox/topics/refresh', async () => {
      const r = await hb.refreshTopics(true)
      const n = (r.list || []).length
      // 一个都没拉到时别报成功：接口挂了或全被风控挡住时，面板会以为「刷新成功」但没有分区可选
      if (!n) return { ok: false, count: 0, message: '一个分区都没拉到（接口可能变了或被风控挡了），分区表保持不变' }
      return { ok: true, count: n, message: `分区表已更新：${n} 个` }
    })
    api.route('/heybox/acts', async () => hb.actList())
    api.route('/heybox/acts/refresh', async () => {
      const r = await hb.refreshActs(true)
      const a = (r.list || []).length, p = (r.plain || []).length
      if (!a && !p) return { ok: false, count: 0, actCount: 0, plainCount: 0, message: '一个话题都没拉到，话题表保持不变' }
      return { ok: true, count: a + p, actCount: a, plainCount: p, message: `话题已更新：活动 ${a} 个、普通 ${p} 个` }
    })
    api.route('/heybox/acts/search', async (req) => {
      const q = http.query(req)
      return hb.searchTopics(String(q.kw || q.q || ''), Number(q.limit) || 20)
    })
    api.route('/heybox/post-plan', async () => ({ ok: true, ...hb.postPlanState() }))
    api.route('/heybox/account', async () => hb.account(true))
    api.route('/heybox/login-cookie', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      const r = hb.saveCookie(String(b?.cookie ?? ''))
      // saveCookie 只负责校验，真正落配置还得经过 setConfig（面板存其他设置时也一样）
      if (r.ok) api.setConfig((cur) => ({ ...cur, heybox: { ...cur.heybox, cookie: r.cookie } }))
      return { ok: r.ok, message: r.message }
    })
    api.route('/heybox/run', async () => hb.browse())
    api.route('/heybox/clear-quota', async () => hb.clearQuota())
    api.route('/heybox/styles', async () => ({ ok: true, styles: hb.POST_STYLES, default: hb.DEFAULT_POST_STYLE }))
    api.route('/heybox/risk', async () => ({ ok: true, risk: hb.risk() }))
    api.route('/heybox/risk/clear', async () => hb.clearRisk())
    api.route('/heybox/qr/start', async () => hb.qrStart())
    api.route('/heybox/qr/poll', async () => hb.qrPoll())
    api.route('/heybox/verify/start', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return hb.verifyStart({ visible: Boolean(b?.visible) })
    })
    api.route('/heybox/verify/finish', async () => hb.verifyFinish())
    api.route('/heybox/verify/show', async (req) => {
      const b = await http.body(req).catch(() => ({}))
      return hb.verifyShow(b?.visible !== false)
    })

    return hb
  },
}
