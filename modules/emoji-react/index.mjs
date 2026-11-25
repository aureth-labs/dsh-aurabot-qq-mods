// 表情回应：偶尔长按消息贴一个 emoji 回应（不是发消息），用模型按语境挑。
// 概率很低，先掷骰子再调模型，不给每条消息都花 token。

const DEFAULT_EMOJIS = [
  '赞=128077',
  '笑哭=128514',
  '爱心=10084',
  '吃瓜=127817',
  '鼓掌=128079',
  '捂脸=128517',
  '思考=129300',
  '哭=128557',
  '玫瑰=127801',
  '鱼=128031',
].join('\n')

const DEFAULTS = {
  enabled: true,
  cooldownMinutes: 20,
  onlyOwner: false,
  emojis: DEFAULT_EMOJIS,
}

const MAX_LIST = 30

const lines = (text) => String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/** 每行「名字=表情ID」；ID 是 QQ 表情的数字 ID，网关原样收。 */
function parseEmojis(text) {
  const list = []
  for (const line of lines(text)) {
    const cut = line.indexOf('=')
    if (cut <= 0) continue
    const name = line.slice(0, cut).trim()
    const id = line.slice(cut + 1).trim()
    if (!name || !/^\d{1,8}$/.test(id)) continue
    list.push({ name, id })
    if (list.length >= MAX_LIST) break
  }
  return list
}

export default {
  id: 'emoji-react',
  name: '表情回应拓展',
  version: '1.0.0',
  api: 1,
  description: '遇到合适的消息才贴一个表情回应，由模型自己判断；不发言、不刷屏',
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'cooldownMinutes', label: '同一个会话冷却（分钟）', type: 'number', min: 1, max: 240, step: 1, hint: '刚回应过的群或私聊，这段时间内不再贴；不同会话互不影响' },
    { key: 'onlyOwner', label: '只回应主人', type: 'switch', hint: '打开后群友说话不贴，只给主人的消息贴' },
    { key: 'emojis', label: '可选表情', type: 'textarea', hint: '每行「名字=表情ID」，模型只能从这里挑。ID 填 QQ 表情的数字 ID（如 128077 是赞）' },
  ],

  setup(api) {
    const settings = () => ({ ...DEFAULTS, ...(api.settings() || {}) })

    try {
      const cur = api.settings() || {}
      if (Object.keys(DEFAULTS).some((key) => cur[key] === undefined)) {
        api.saveSettings({ ...DEFAULTS, ...cur })
        api.log.info('表情回应：已把默认参数写入配置')
      }
    } catch (error) { api.log.warn(`表情回应：写默认参数失败：${error.message}`) }

    const lastAt = new Map() // chatId -> 上次贴表情的时间

    const chatIdOf = (msg) => (msg.kind === 'group' ? `group:${msg.groupId || ''}` : `private:${msg.userId || ''}`)

    function inScope(msg) {
      const cfg = api.config()
      if (String(msg.userId || '') === String(cfg.botQQ || '')) return false
      if (msg.kind === 'group') {
        return (cfg.allow?.groups || []).map(String).includes(String(msg.groupId || ''))
      }
      if (api.isOwner(msg.userId)) return true
      return (cfg.allow?.private || []).map(String).includes(String(msg.userId || ''))
    }

    /** 让模型判断这条消息适不适合贴、贴哪个；返回 null 表示这次不贴。 */
    async function pickEmoji(text, pool) {
      const menu = pool.map((item, index) => `${index + 1}. ${item.name}`).join('\n')
      const out = await api.ask({
        system: [
          '你在帮一个 QQ 机器人决定要不要给一条刚收到的消息贴表情回应（相当于长按消息选表情，不是发言）。',
          '先判断这条消息适不适合回应，适合再从下面候选里挑一个最贴切的：',
          menu,
          '适合的例子：打招呼（早安、晚安、早上好）、生日祝福、好消息、分享开心的事、道谢、夸人、发有意思的内容。',
          '不适合的例子：正经讨论、争论吵架、抱怨发泄、求助提问、需要认真回答的事、纯链接、广告、看不懂的内容。',
          '不确定就不贴。只输出一个数字：贴就输出候选编号，不贴输出 0。不要解释。',
        ].join('\n'),
        text: `消息内容：${text.slice(0, 500)}`,
        maxTokens: 8,
        temperature: 0,
      })
      const hit = String(out || '').match(/\d+/)
      if (!hit) return null
      const index = Number(hit[0])
      if (!Number.isInteger(index) || index < 1 || index > pool.length) return null
      return pool[index - 1]
    }

    api.on('message', async (msg) => {
      if (!msg || msg.kind === 'system') return false
      const cfg = settings()
      if (!cfg.enabled) return false

      const text = String(msg.text || '').trim()
      if (!text) return false
      if (/^[#＃/／]/.test(text)) return false
      if (!inScope(msg)) return false
      if (cfg.onlyOwner && !api.isOwner(msg.userId)) return false

      const chatId = chatIdOf(msg)
      const cooldownMs = Math.max(1, Number(cfg.cooldownMinutes) || DEFAULTS.cooldownMinutes) * 60_000
      if (Date.now() - (lastAt.get(chatId) || 0) < cooldownMs) return false

      const pool = parseEmojis(cfg.emojis)
      if (!pool.length) return false
      if (!msg.messageId) return false

      try {
        const picked = await pickEmoji(text, pool)
        if (!picked) return false
        if (api.config().dryRun) {
          api.log.info(`表情回应：试运行，本来给「${text.slice(0, 12)}」贴 ${picked.name}`)
          return false
        }
        await api.onebot('set_msg_emoji_like', { message_id: msg.messageId, emoji_id: String(picked.id) })
        lastAt.set(chatId, Date.now())
        api.log.debug?.(`表情回应：给 ${chatId} 贴了 ${picked.name}`)
      } catch (error) {
        api.log.debug?.(`表情回应：没贴成：${error.message}`)
      }
      return false // 只贴表情，不接管消息
    })

    return {}
  },
}
