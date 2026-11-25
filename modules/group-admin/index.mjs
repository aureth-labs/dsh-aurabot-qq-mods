const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
// 社区模块（原内置）：群管。主人开口时禁言、解禁、踢人、改头衔、发公告、全体禁言；她知道自己在每个群是什么身份。
// 1.1.0：自带一份「群管白名单」（默认只有主人，可加人），白名单里的人可以直接在群里发指令（如「全体禁言」）触发，
// 别人一律不触发；/群管功能 列出所有能用的指令。

const { defineTool, str, int } = __lib('tools/tools.js')

// 有人直接说的话里认指令：只认白名单 / 主人，别人一句都不理
export const CMD = [
  { re: /^(全体禁言|开启全体禁言|全员禁言)$/, action: 'wholeban' },
  { re: /^(关闭全体禁言|解除全体禁言|关闭全员禁言|解除全员禁言)$/, action: 'wholeoff' },
  { re: /^禁言\s*(@[^\n]+?|\S+?)\s*(?:(\d+)\s*(?:分钟|min)?)?$/, action: 'ban' },
  { re: /^(解禁|取消禁言)\s*(@[^\n]+|\S+)$/, action: 'unban' },
  { re: /^(踢人|踢出|踢了)\s*(@[^\n]+|\S+)$/, action: 'kick' },
  { re: /^(改头衔|设置头衔)\s*(\S+)\s+(.+)$/, action: 'title' },
  { re: /^(发公告|群公告)\s+([\s\S]+)$/, action: 'notice' },
  { re: /^添加白名单\s*([\s\S]+)$/, action: 'wladd' },
  { re: /^(移除白名单|删除白名单|取消白名单)\s*([\s\S]+)$/, action: 'wldel' },
  { re: /^(查看白名单|群管白名单)$/, action: 'wllist' },
]

const HELP = [
  '群管能做的事（只有主人和群管白名单里的人能发）：',
  '  全体禁言 / 关闭全体禁言',
  '  禁言 @某人 10 ／ 禁言 名字或QQ 分钟数',
  '  解禁 @某人 ／ 解禁 名字或QQ',
  '  踢人 @某人 ／ 踢人 名字或QQ',
  '  改头衔 名字或QQ 头衔内容',
  '  发公告 内容',
  '  添加白名单 @某人 或 QQ号 / 移除白名单 @某人 或 QQ号 / 查看白名单',
].join('\n')

/** 从一句话里认群管指令；认不出来返回 null。 */
export function matchCommand(text) {
  const s = String(text || '').trim()
  if (!s || s.length > 60) return null
  for (const c of CMD) {
    const m = s.match(c.re)
    if (m) return { action: c.action, m }
  }
  return null
}

export default {
  id: 'group-admin',
  name: '群管',
  version: '1.1.1',
  api: 1,
  description: '主人开口时帮忙管群：禁言、解禁、踢人、改头衔、发公告、全体禁言；自带群管白名单，白名单里的人可以直接发指令触发。',
  defaults: { extraWhitelist: '' },
  settings: [
    { key: 'extraWhitelist', label: '群管白名单（额外）', type: 'textarea', hint: '能直接发群管指令的 QQ 号，一行一个或用逗号隔开；主人始终有效，不用写在这儿' },
  ],
  setup(api) {
    const { hub, onebot, groupRoles } = api.core

    // 群管白名单：主人 + 面板里填的人
    const adminSet = () => {
      const cfg = api.config()
      const raw = String((api.settings() || {}).extraWhitelist || '')
      const extra = raw.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
      return new Set([String(cfg.ownerQQ), ...extra])
    }
    const isAdmin = (qq) => adminSet().has(String(qq || ''))

    // 她在这个群的身份：没管理权限就别答应禁言踢人
    api.context(({ chat }) => {
      if (chat.kind !== 'group') return ''
      const role = groupRoles.peek(chat.groupId)
      if (!role) return ''
      return groupRoles.canManage(role) ? `你在这个群是${groupRoles.label(role)}，主人要求时可以用群管工具。` : '你在这个群只是普通成员，没有管理权限：禁言、踢人这些做不了，主人要求时直接说明。'
    })

    // 按名字 / 群名片找到群成员 QQ 号；重名时返回候选列表
    const findMember = async (gid, name) => {
      if (!name) return { uid: 0, hits: [] }
      const list = await onebot.call('get_group_member_list', { group_id: Number(gid) })
      const rows = Array.isArray(list) ? list : (list && list.data) || []
      const key = String(name).trim().replace(/^[@＠]/, '')
      const exact = rows.filter((m) => String(m.card || '').trim() === key || String(m.nickname || '').trim() === key)
      const fuzzy = rows.filter((m) => String(m.card || '').includes(key) || String(m.nickname || '').includes(key))
      const hits = exact.length ? exact : fuzzy
      if (hits.length === 1) return { uid: Number(hits[0].user_id), hits }
      return { uid: 0, hits: hits.map((m) => `${m.card || m.nickname}(${m.user_id})`) }
    }

    // 真正的执行：工具和群里的一句话都走这里
    const run = async ({ gid, action, uid = 0, minutes, text }) => {
      const cfg = api.config()
      if (!gid) return { ok: false, message: '不知道是哪个群' }
      if (!cfg.allow.groups.includes(String(gid))) return { ok: false, message: '这个群不在白名单里' }
      const whole = action === 'wholeban' || action === 'wholeoff'
      if (action !== 'notice' && !whole && !uid) return { ok: false, message: '要说清楚对谁（QQ 号或名字）' }
      if (uid && String(uid) === String(cfg.ownerQQ) && action !== 'unban' && action !== 'title') return { ok: false, message: '不能对主人做这个' }
      const role = await groupRoles.get(gid, { fresh: true })
      if (role && !groupRoles.canManage(role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }
      if (role === 'admin' && action === 'title') return { ok: false, message: '改专属头衔要群主才行，我只是管理员' }
      if (cfg.dryRun) return { ok: true, message: `试运行：本来要对群 ${gid} 做 ${action}` }
      switch (action) {
        case 'ban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: Math.max(1, Number(minutes) || 10) * 60 }); break
        case 'unban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: 0 }); break
        case 'kick': await onebot.call('set_group_kick', { group_id: gid, user_id: uid, reject_add_request: false }); break
        case 'title': await onebot.call('set_group_special_title', { group_id: gid, user_id: uid, special_title: String(text || '') }); break
        case 'notice': await onebot.call('_send_group_notice', { group_id: gid, content: String(text || '') }); break
        case 'wholeban': await onebot.call('set_group_whole_ban', { group_id: gid, enable: true }); break
        case 'wholeoff': await onebot.call('set_group_whole_ban', { group_id: gid, enable: false }); break
        default: return { ok: false, message: '不认识的操作' }
      }
      return { ok: true, message: '做好了' }
    }

    // 名字 / QQ 号 → uid
    const resolveUid = async (gid, who) => {
      const s = String(who || '').trim().replace(/^[@＠]\s*/, '').replace(/\s+/g, ' ')
      if (/^\d{5,12}$/.test(s)) return { uid: Number(s) }
      const found = await findMember(gid, s)
      if (!found.uid) {
        if (found.hits && found.hits.length > 1) return { message: '有重名，选一个再告诉我：' + found.hits.join('、') }
        return { message: '群里没找到这个名字，直接说 QQ 号也行' }
      }
      return { uid: found.uid }
    }

    // 群管白名单里的人，在群里直接说一句就执行（别人说的完全不接）
    api.on('message', async (msg) => {
      // 这里拿到的是消息本体（kind / groupId / userId / text），不是 chat 对象
      const kind = msg?.chat?.kind || msg?.kind
      const gid0 = msg?.chat?.groupId || msg?.groupId
      if (kind !== 'group' || !gid0) return false
      if (!isAdmin(msg.userId)) return false
      const text = String(msg.text || '').trim()
      if (!text || text.length > 60) return false
      const hit = matchCommand(text)
      if (!hit) return false
      const gid = Number(gid0)
      // 白名单维护：主人（或已有白名单）可以加人 / 移人 / 看名单
      if (hit.action === 'wladd' || hit.action === 'wldel') {
        const who = String(hit.m[hit.action === 'wladd' ? 1 : 2] || '').trim()
        const r = await resolveUid(gid, who)
        if (!r.uid) {
          await onebot.call('send_group_msg', { group_id: gid, message: r.message || '要加谁？@他或者给个 QQ 号' })
          return false
        }
        const cfg = api.config()
        if (String(r.uid) === String(cfg.ownerQQ)) {
          await onebot.call('send_group_msg', { group_id: gid, message: '主人本来就在里面，不用加' })
          return false
        }
        const cur = String((api.settings() || {}).extraWhitelist || '')
        const list = cur.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
        const has = list.includes(String(r.uid))
        if (hit.action === 'wladd') {
          if (has) {
            await onebot.call('send_group_msg', { group_id: gid, message: `${r.uid} 已经在群管白名单里了` })
            return false
          }
          list.push(String(r.uid))
          api.saveSettings({ extraWhitelist: list.join('\n') })
          await onebot.call('send_group_msg', { group_id: gid, message: `把 ${r.uid} 加进群管白名单了` })
        } else {
          if (!has) {
            await onebot.call('send_group_msg', { group_id: gid, message: `${r.uid} 本来就不在白名单里` })
            return false
          }
          api.saveSettings({ extraWhitelist: list.filter((x) => x !== String(r.uid)).join('\n') })
          await onebot.call('send_group_msg', { group_id: gid, message: `把 ${r.uid} 移出群管白名单了` })
        }
        return false
      }
      if (hit.action === 'wllist') {
        const cfg = api.config()
        const extra = [...adminSet()].filter((qq) => qq !== String(cfg.ownerQQ))
        const say = `群管白名单：\n  主人 ${cfg.ownerQQ}\n` + (extra.length ? extra.map((qq) => '  ' + qq).join('\n') : '  （还没加别人）')
        await onebot.call('send_group_msg', { group_id: gid, message: say })
        return false
      }
      let uid = 0
      let extra = ''
      if (hit.action === 'ban') {
        const r = await resolveUid(gid, hit.m[1])
        if (!r.uid) { await onebot.call('send_group_msg', { group_id: gid, message: r.message }); return false }
        uid = r.uid
        extra = hit.m[2]
      } else if (hit.action === 'unban' || hit.action === 'kick') {
        const r = await resolveUid(gid, hit.m[2])
        if (!r.uid) { await onebot.call('send_group_msg', { group_id: gid, message: r.message }); return false }
        uid = r.uid
      } else if (hit.action === 'title') {
        const r = await resolveUid(gid, hit.m[2])
        if (!r.uid) { await onebot.call('send_group_msg', { group_id: gid, message: r.message }); return false }
        uid = r.uid
        extra = hit.m[3]
      } else if (hit.action === 'notice') {
        extra = hit.m[2]
      }
      const r = await run({ gid, action: hit.action, uid, minutes: extra, text: extra })
      const say = r.ok ? '好了' : r.message
      await onebot.call('send_group_msg', { group_id: gid, message: say })
      return false
    })

    api.command({
      name: '群管功能',
      aliases: ['群管', '群管帮助'],
      desc: '列出群管能用的指令',
      run: () => HELP,
    })

    // 工具层校验：这一轮说话的人里要有主人
    api.tool(({ chat, level, sessionId }) => {
      if (!(chat.kind === 'group' || level === 'full')) return []
      return defineTool({
        name: 'qq_group_admin',
        description: '群管理：禁言 / 解禁 / 踢人 / 改头衔 / 发群公告 / 全体禁言。只有主人或群管白名单里的人要求时才能用；别人要求会被系统拒绝。',
        properties: {
          action: { type: 'string', enum: ['ban', 'unban', 'kick', 'title', 'notice', 'wholeban', 'wholeoff'], description: 'ban 禁言，unban 解禁，kick 踢出，title 改专属头衔，notice 发公告，wholeban 开启全体禁言，wholeoff 关闭全体禁言' },
          group_id: str('群号；在群里用时可省略，默认当前群'),
          user_id: str('对象 QQ 号（notice / wholeban / wholeoff 不需要）'),
          minutes: int('禁言分钟数，默认 10'),
          text: str('头衔内容或公告内容'),
        },
        required: ['action'],
        execute: async ({ action, group_id, user_id, minutes, text }) => {
          // 这一轮说话的人里要有主人（或白名单里的人），而且这一轮只能有他们：
          // 主人和群友同轮合并时，群友不能借主人的话拿到群管权限；谁都不能拿群管对付主人
          const senders = typeof hub.turnSenders === 'function' ? hub.turnSenders(sessionId) || [] : []
          const senderOk = senders.length > 0 && senders.every((qq) => isAdmin(qq))
          if (!senderOk) return { ok: false, message: '只有主人和群管白名单能让我做群管操作' }
          const gid = Number(group_id || (chat.kind === 'group' ? chat.groupId : 0))
          const whole = action === 'wholeban' || action === 'wholeoff'
          let uid = Number(user_id || 0)
          let extra = text
          if (!uid && action !== 'notice' && !whole && text) {
            const r = await resolveUid(gid, text)
            if (!r.uid) return { ok: false, message: r.message }
            uid = r.uid
          }
          if (action === 'ban' && text && /^\d+$/.test(String(text).trim())) extra = text
          return run({ gid, action, uid, minutes, text: extra })
        },
      })
    })

    api.route('/groups/roles', async () => {
      const cfg = api.config()
      const list = await Promise.all(cfg.allow.groups.map(async (gid) => {
        const role = await groupRoles.get(gid, { fresh: true })
        return { groupId: gid, name: await hub.groupName(String(gid)), role, label: role ? groupRoles.label(role) : '查不到（她在群里吗？）', canManage: groupRoles.canManage(role) }
      }))
      return { ok: true, list }
    })
    return {}
  },
}
