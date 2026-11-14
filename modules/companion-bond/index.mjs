import { openStore } from './lib/store.mjs'
import { DEFAULTS, interact, parseAction, remember, settings, snapshot, syncFeed } from './lib/growth.mjs'

const HELP = [
  '相伴养成 · 养成的是正在和你聊天的她',
  '聊天会慢慢积累亲密度；连续刷屏只按设置里的间隔给成长奖励。',
  '“陪你玩”“摸摸你”“晚安”“早安”：互动后由她用原本的人格回应。',
  '“养成状态”：看亲密度、等级、精神与心情。',
  '主人命令：/养成 状态｜玩耍｜摸摸｜休息｜起床｜帮助。',
  '喂饭继续使用原来的“喂食”模块或 /喂食 食物，吃进去后约 15 秒内同步。',
  '长期不来不会扣亲密度。每天奖励在北京时间零点更新。',
].join('\n')

export default {
  id: 'companion-bond', name: '相伴养成', version: '1.0.0', api: 1,
  description: '聊天、投喂、玩耍，与她一起慢慢成长。',
  defaults: DEFAULTS,
  panel: 'panel.js',
  settings: [
    { key: 'chatCooldownSeconds', label: '聊天成长间隔（秒）', type: 'number', min: 0, max: 3600, step: 1, hint: '默认 30 秒；填 0 可每条聊天都计分，仍受每日上限限制。' },
    { key: 'chatDailyLimit', label: '每天聊天成长次数上限', type: 'number', min: 0, max: 1000, step: 1 },
    { key: 'allowGroups', label: '在群里也启用主人养成互动', type: 'switch', hint: '默认仅私聊。开启后，主人 @ 她的消息才计入；群里会展示相处状态。' },
  ],
  setup(api) {
    const store = openStore(api.dataDir(), Date.now())
    let state = store.state
    const pending = new Map()
    const cfg = () => settings(api.settings())
    const warn = error => api.log.warn('养成操作失败：' + error.message)
    function transaction(change) {
      const next = structuredClone(state)
      const result = change(next)
      if (JSON.stringify(next) !== JSON.stringify(state)) { store.save(next); state = next }
      return result
    }
    function feedRecords() {
      const feed = api.use('feed')
      return typeof feed?.state === 'function' ? feed.state()?.log : []
    }
    function sync() {
      const records = feedRecords()
      transaction(s => syncFeed(s, records, Date.now(), cfg()))
    }
    function status() {
      sync()
      const v = snapshot(state, Date.now())
      const feed = api.use('feed')
      // 面板不返回 QQ 号、聊天消息或原始喂食记录。
      const { seenMessages, seenFeed, ...publicState } = v
      return { ok: true, ...publicState, feedAvailable: typeof feed?.state === 'function' }
    }
    function statusText() {
      const s = status()
      return [
        `相伴养成 · ${s.stage} · Lv.${s.level}`,
        `亲密度 ${s.bond}/1000｜经验 ${s.xp}/${s.nextXp}`,
        `精神 ${s.energy}/100｜愉悦 ${s.joy}/100｜${s.sleeping ? '正在休息' : '醒着'}`,
        `今天：聊天 ${s.daily.chat} · 喂饭 ${s.daily.feed} · 玩耍 ${s.daily.play} · 摸摸 ${s.daily.touch}`,
        s.nextStage ? `再积累 ${s.nextBond - s.bond} 亲密度，就到「${s.nextStage}」。` : '你们已经积累了深厚的相处默契。',
        s.feedAvailable ? '喂饭沿用原来的喂食模块。' : '喂食模块尚未启用；聊天、玩耍照常可用。',
      ].join('\n')
    }
    const eligible = msg => api.isOwner(String(msg.userId || '')) &&
      (msg.kind === 'private' || (cfg().allowGroups && msg.kind === 'group' && msg.mentioned === true))

    api.on('message', async msg => {
      if (!eligible(msg) || !String(msg.text || '').trim()) return false
      const action = parseAction(msg.text)
      if (action === 'status' || action === 'help') {
        await api.reply(msg, action === 'help' ? HELP : statusText())
        return true
      }
      try {
        sync()
        const result = transaction(s => {
          const id = msg.messageId == null ? '' : `${msg.chatId}:${msg.messageId}`
          if (!remember(s, 'seenMessages', id)) return null
          const chat = interact(s, 'chat', Date.now(), cfg())
          return action ? interact(s, action, Date.now(), cfg()) : chat
        })
        if (action && result) {
          pending.set(msg.chatId, { at: Date.now(), text: String(msg.text).trim(), result })
          if (pending.size > 32) pending.delete(pending.keys().next().value)
          if (result.ok && (action === 'play' || action === 'touch')) {
            try { api.use('mood')?.nudge?.(action === 'play' ? 3 : 1, '主人陪伴互动') } catch (error) { warn(error) }
          }
        }
      } catch (error) { warn(error) }
      // 保留原本的聊天流程，交给她的现有人格回应，不另外问一次模型。
      return false
    })

    api.on('prompt', (content, info) => {
      const { chat, senderId, queryText } = info
      if (!chat || !api.isOwner(String(senderId || chat.userId || ''))) return
      if (chat.kind !== 'private' && !(chat.kind === 'group' && cfg().allowGroups)) return
      try {
        sync()
        const s = snapshot(state, Date.now())
        const lines = [
          '【相伴养成·可信状态】以下是本模块计算的状态，描述你本人和正在说话的主人之间的相处。',
          `关系阶段：${s.stage}；亲密度 ${s.bond}/1000；成长等级 ${s.level}；精神 ${s.energy}/100；愉悦 ${s.joy}/100；${s.sleeping ? '正在休息' : '醒着'}。`,
          '保持你原来的名字、人格、称呼和说话方式。把状态自然融入语气，平时不主动报数值；主人问状态时再说明。',
          '关系随相处逐步熟悉，阶段不等于恋爱承诺。不要因为主人离开而责怪、索取陪伴或制造内疚。',
          '休息是养成状态，仍然可以正常回复；玩耍会消耗精神，休息随时间恢复。',
          '喂饭是否吃到、吃了什么，以喂食模块的实际记录为准。不要编造经验增长或替本模块修改数值。',
        ]
        const p = pending.get(chat.chatId)
        if (p && Date.now() - p.at < 120_000 && String(queryText || '').includes(p.text)) {
          lines.push(`这次互动的实际结果：${p.result.message} 请据此自然回应。`)
          pending.delete(chat.chatId)
        }
        return [...content, { type: 'text', text: lines.join('\n') }]
      } catch (error) { warn(error) }
    })

    api.command({
      name: '养成', aliases: ['相伴'], desc: '和她一起成长：状态、玩耍、摸摸、休息、起床',
      run(arg, msg) {
        if (!api.isOwner(String(msg?.userId || ''))) return '这项互动只给主人使用。'
        if (msg.kind === 'group' && !cfg().allowGroups) return '群聊养成尚未开启，请在私聊使用。'
        const a = String(arg || '').trim()
        if (!a || a === '状态') return statusText()
        if (a === '帮助') return HELP
        const action = { 玩耍: 'play', 摸摸: 'touch', 抱抱: 'touch', 休息: 'sleep', 起床: 'wake' }[a]
        if (!action) return HELP
        sync()
        const result = transaction(s => interact(s, action, Date.now(), cfg()))
        return result.message + '\n' + statusText()
      },
    })

    api.route('/status', () => status())
    api.route('/interact', async req => {
      if (req.method !== 'POST') return { ok: false, message: '请使用 POST。' }
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > 4096) return { ok: false, message: '请求内容过长。' }
      }
      let action
      try { ({ action } = JSON.parse(body)) } catch { return { ok: false, message: '请求格式错误。' } }
      if (!['play', 'touch', 'sleep', 'wake'].includes(action)) return { ok: false, message: '不支持的互动。' }
      sync()
      return transaction(s => interact(s, action, Date.now(), cfg()))
    })
    api.every(15_000, () => { try { sync() } catch (error) { warn(error) } }, 'companion-bond-feed')
    api.log.info('相伴养成 1.0.0 已加载：主人私聊中自然互动，投喂沿用 feed。')
    return { status, dispose() { pending.clear() } }
  },
}
