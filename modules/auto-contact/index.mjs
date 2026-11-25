// 自动接待：自动通过好友申请 / 群邀请并写入白名单；#sl 只有主人能触发。
// 只使用公开接口：api.on / api.config / api.setConfig / api.onebot / api.isOwner / api.send / api.reply / api.log。

const ID_RE = /^\d{5,12}$/
const HANDLED_MAX = 500

const DEFAULTS = {
  enabled: false,
  autoFriend: false,
  autoGroupInvite: false,
  autoGroupAdd: false,
  writeWhitelist: false,
  onlyBotInvite: true,
  slDefault: '在的，找你。',
}

export default {
  id: 'auto-contact',
  name: '自动接待',
  version: '1.0.0',
  api: 1,
  description: '自动通过好友申请和群邀请并写入白名单；#sl 只有主人能触发',
  settings: [
    { key: 'enabled', label: '启用', type: 'switch', hint: '默认关。关着时不会自动通过任何申请，#sl 也不响应' },
    { key: 'autoFriend', label: '自动通过好友申请', type: 'switch', hint: '默认关。打开后任何好友申请都会被通过' },
    { key: 'autoGroupInvite', label: '自动通过邀请机器人的群', type: 'switch', hint: '默认关。只处理邀请机器人本身的群邀请' },
    { key: 'autoGroupAdd', label: '自动通过别人的加群申请', type: 'switch', hint: '默认关。机器人在群里当管理员时，会替群主放行任何申请进群的人，风险较高' },
    { key: 'onlyBotInvite', label: '群邀请只认邀请机器人', type: 'switch', hint: '关掉后，别人被邀请的群也一并同意' },
    { key: 'writeWhitelist', label: '通过后写入白名单', type: 'switch', hint: '默认关。打开后会把通过的 QQ / 群写进 allow.private / allow.groups' },
    { key: 'slDefault', label: '#sl 不带内容时发什么', type: 'text', placeholder: '在的，找你。', hint: '留空则用默认这句' },
  ],

  setup(api) {
    const handled = new Set() // 已经处理过的申请 flag：同一条事件重复推送时不再调用网关

    const settings = () => ({ ...DEFAULTS, ...(api.settings() || {}) })

    // 把默认值写进配置，设置页才会显示默认值而不是空着。
    try {
      const cur = api.settings() || {}
      if (Object.keys(DEFAULTS).some((key) => cur[key] === undefined)) {
        api.saveSettings({ ...DEFAULTS, ...cur })
        api.log.info('自动接待：已把默认参数写入配置')
      }
    } catch (error) { api.log.warn(`自动接待：写默认参数失败：${error.message}`) }

    const ownerId = () => String(api.config().ownerQQ || '')
    const botId = () => String(api.config().botQQ || '')

    function markHandled(flag) {
      if (!flag || handled.has(flag)) return false
      if (handled.size >= HANDLED_MAX) handled.clear()
      handled.add(flag)
      return true
    }

    /** 写进 allow.private / allow.groups。用函数形式基于最新配置合并，避免盖掉面板刚改的。 */
    function addToWhitelist(kind, id) {
      if (!settings().writeWhitelist) return
      const key = kind === 'private' ? 'private' : 'groups'
      api.setConfig((cfg) => {
        const cur = (cfg.allow?.[key] || []).map(String)
        if (cur.includes(id)) return cfg
        return { ...cfg, allow: { ...cfg.allow, [key]: [...cur, id] } }
      })
    }

    // 好友申请：通过后把人加进私聊白名单。
    async function approveFriend(ev) {
      const qq = String(ev.user_id || '')
      if (!ID_RE.test(qq) || qq === ownerId() || qq === botId()) return
      if (api.config().dryRun) {
        api.log.info(`试运行：收到 QQ ${qq} 的好友申请，未自动通过`)
        return
      }
      try {
        await api.onebot('set_friend_add_request', { flag: String(ev.flag), approve: true })
        addToWhitelist('private', qq)
      } catch (error) {
        handled.delete(String(ev.flag))
        api.log.warn(`自动通过 QQ ${qq} 的好友申请失败：${error.message}`)
        return
      }
      api.log.info(`已自动通过 QQ ${qq} 的好友申请${settings().writeWhitelist ? '，并加入私聊白名单' : ''}`)
    }

    // 加群申请 / 邀请：通过后把群加进群白名单。
    // 默认只在邀请机器人本身时处理；别人被邀请不归我们管。
    async function approveGroup(ev) {
      const gid = String(ev.group_id || '')
      if (!ID_RE.test(gid)) return
      const subType = String(ev.sub_type || '')
      if (subType === 'invite' && settings().onlyBotInvite) {
        const invited = String(ev.invited_id || '')
        if (invited && invited !== botId()) return
      }
      if (api.config().dryRun) {
        api.log.info(`试运行：收到群 ${gid} 的${subType === 'invite' ? '邀请' : '加群申请'}，未自动通过`)
        return
      }
      try {
        await api.onebot('set_group_add_request', { flag: String(ev.flag), sub_type: subType, approve: true })
        addToWhitelist('groups', gid)
      } catch (error) {
        handled.delete(String(ev.flag))
        api.log.warn(`自动通过群 ${gid} 的申请失败：${error.message}`)
        return
      }
      api.log.info(`已自动通过群 ${gid} 的${subType === 'invite' ? '邀请' : '加群申请'}${settings().writeWhitelist ? '，并加入群白名单' : ''}`)
    }

    api.on('onebot', (ev) => {
      if (!ev || ev.post_type !== 'request' || !ev.flag) return
      const cfg = settings()
      if (!cfg.enabled) return
      if (ev.request_type === 'friend') {
        if (!cfg.autoFriend) return
        if (!markHandled(String(ev.flag))) return
        approveFriend(ev).catch((error) => api.log.warn(`处理好友申请出错：${error.message}`))
        return
      }
      if (ev.request_type === 'group' && ['add', 'invite'].includes(String(ev.sub_type || ''))) {
        const isInvite = String(ev.sub_type) === 'invite'
        if (isInvite ? !cfg.autoGroupInvite : !cfg.autoGroupAdd) return
        if (!markHandled(String(ev.flag))) return
        approveGroup(ev).catch((error) => api.log.warn(`处理加群申请出错：${error.message}`))
      }
    })

    // #sl [QQ号] [内容]：让机器人私聊自己或白名单里的人，只有主人能用。
    // 不带 QQ 号时发给主人自己；会先核对目标在私聊白名单里，避免替陌生人发起私聊。
    api.on('message', async (msg) => {
      if (!msg || msg.kind === 'system') return false
      const matched = String(msg.text || '').trim().match(/^[#＃]\s*sl(?:\s+([\s\S]*))?$/i)
      if (!matched) return false
      const own = settings()
      if (!own.enabled) return false

      if (!api.isOwner(msg.userId)) {
        await api.reply(msg, '只有主人能触发 #sl')
        return true
      }

      const cfg = api.config()
      const arg = String(matched[1] || '').trim()
      const hit = arg.match(/^(\d{5,12})(?:\s+([\s\S]*))?$/)
      const target = hit ? hit[1] : String(msg.userId)
      const text = (hit ? hit[2] || '' : arg).trim()

      if (target === botId()) {
        await api.reply(msg, '那是我自己的号，不用私聊')
        return true
      }
      const allowed = (cfg.allow?.private || []).map(String)
      if (target !== ownerId() && !allowed.includes(target)) {
        await api.reply(msg, `QQ ${target} 不在私聊白名单里，先加白名单再发`)
        return true
      }
      if (cfg.dryRun) {
        api.log.info(`试运行：#sl 未发送给 QQ ${target}`)
        await api.reply(msg, '试运行：没有真的发出私聊')
        return true
      }

      try {
        await api.send(`private:${target}`, text || String(own.slDefault || '').trim() || DEFAULTS.slDefault)
        await api.reply(msg, msg.kind === 'group' ? `已私聊 QQ ${target}` : '发好了')
      } catch (error) {
        api.log.warn(`#sl 私聊 QQ ${target} 失败：${error.message}`)
        await api.reply(msg, `私聊发送失败：${error.message}`)
      }
      return true
    })

    return {}
  },
}
