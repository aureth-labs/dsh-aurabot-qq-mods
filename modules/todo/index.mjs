// 待办调度（scheduler）：她说「几点几分做什么，一共几次」，到点自动把念头送到指定聊天。
//
// 开关关掉时：工具不出现、定时器不排、已有的待办原样留着（重新打开会接着跑）。
//
// 一条待办一行，竖线分开六段（第六段可省略）：
//   来源对话|念头和原因|目的对话|时间(HH:MM)|次数
// 例：
//   private:123|想问问他作业写完没，怕他熬夜|private:456|14:30|3
//
// 次数：-1 表示每天重复；不写就是 1 次。
// 到点后按 1 分钟间隔重复，直到次数用完。

import { join } from 'node:path'
import { createTodoBook } from './todo.mjs'

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'todo',
  name: '待办调度',
  version: '1.1.0',
  api: 1,
  description: '到点自动把念头送到指定聊天；支持次数、每天重复',

  defaults: {
    crossChatUsers: '',
    autonomousEnabled: false,
    maxPerScan: 10,
    greetingsEnabled: false,
    greetingsCandidates: '',
    greetingsMorningMin: 1,
    greetingsMorningMax: 3,
    greetingsEveningMin: 1,
    greetingsEveningMax: 3,
    greetingsLastDay: '',
  },
  settings: [
    { key: 'crossChatUsers', label: '跨对话白名单 QQ', type: 'text', hint: '多个 QQ 号用逗号或空格分隔；主人默认允许' },
  ],

  panel: 'panel.js',

  setup(api) {
    const settings = () => api.settings()
    // 模块是否运行由模块管理器控制，这里不再提供第二个 enabled 开关。
    const on = () => true

    const pendingChanges = new Map()
    const book = createTodoBook(join(api.dataDir(), 'todo.json'), (m) => api.log.warn(m))

    // Confirmation is received directly from a real user, never from tool arguments.
    api.on('message', async (msg) => {
      const text = String(msg.text || '').trim()
      const match = /^确认 (撤回|修改|完成) ([a-f0-9]+) ([a-f0-9]+)$/.exec(text)
      if (!match) return false
      const key = match[2] + ':' + match[3]
      const request = pendingChanges.get(key)
      const uid = String(msg.userId || msg.uid || msg.sender?.user_id || '')
      if (!request || request.chatId !== msg.chatId || !request.senders.includes(uid) || request.action !== match[1]) return false
      pendingChanges.delete(key)
      const item = book.all().find(t => t.id === match[2])
      if (Date.now() > request.expires || !item || item.state !== 'open' || JSON.stringify(item) !== request.snapshot) {
        await api.send(msg.chatId, '确认已过期或任务发生变化，请重新查看任务并请求修改。')
        return true
      }
      book.clearTimer(item.id)
      if (request.action === '撤回') book.drop(item.id)
      else if (request.action === '完成') book.done(item.id)
      else {
        book.update(item.id, request.patch)
        book.scheduleOne(book.all().find(t => t.id === item.id), fire)
      }
      await api.send(msg.chatId, '已' + request.action + '待办 ' + item.id + '：' + item.thought)
      return true
    })

    const ymd = (d = new Date()) => {
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    const dayStamp = (day, hour, minute) => {
      const [y, m, d] = day.split('-').map(Number)
      return new Date(y, m - 1, d, hour, minute, 0, 0).getTime()
    }
    const shuffle = (list) => {
      const out = list.slice()
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    }
    function recentPrivateChats() {
      const hub = api.core.hub
      const cfg = api.config()
      const allowed = new Set([String(cfg.ownerQQ || ''), ...(cfg.allow?.private || []).map(String)].filter(Boolean))
      const owner = String(cfg.ownerQQ || '')
      const cutoff = Date.now() - 2 * 86400_000
      const seen = new Map()
      const days = typeof hub.chatLogDays === 'function' ? hub.chatLogDays() : []
      for (const day of days.slice(-3)) {
        for (const row of hub.chatLogOf(day) || []) {
          const chatId = String(row?.chatId || '')
          const qq = chatId.startsWith('private:') ? chatId.slice(8) : ''
          const at = Number(row?.t || row?.at || row?.timestamp || row?.time || 0)
          if (!/^\d+$/.test(qq) || !allowed.has(qq) || qq === owner || !at || at < cutoff || at > Date.now() || row.who === 'bot' || row.who === '系统') continue
          seen.set(`private:${qq}`, Math.max(seen.get(`private:${qq}`) || 0, at || Date.now()))
        }
      }
      return [...seen.keys()]
    }
    function randomCount(minKey, maxKey, poolSize) {
      const number = (key, fallback) => {
        const value = settings()[key]
        return value === '' || value == null || !Number.isFinite(Number(value)) ? fallback : Math.floor(Number(value))
      }
      const min = Math.max(0, Math.min(20, poolSize, number(minKey, 1)))
      const max = Math.max(min, Math.min(20, poolSize, number(maxKey, 3)))
      return min + Math.floor(Math.random() * (max - min + 1))
    }
    function createGreetingPlan() {
      const enabled = (period) => (settings()[`greetings${period}Enabled`] ?? settings().greetingsEnabled) === true
      if (!enabled('Morning') && !enabled('Evening')) return 0
      const day = ymd()
      if (String(settings().greetingsLastDay || '') === day) return 0
      const allowed = new Set((api.config().allow?.private || []).map(String))
      const owner = String(api.config().ownerQQ || '')
      const candidates = (period) => {
        const raw = String(settings()[`greetings${period}Candidates`] ?? settings().greetingsCandidates ?? '').trim()
        return raw
          ? [...new Set(raw.split(/[\s,，;；]+/).map((value) => value.replace(/^private:/i, '')).filter((qq) => /^\d+$/.test(qq) && qq !== owner && allowed.has(qq)).map((qq) => `private:${qq}`))]
          : recentPrivateChats()
      }
      const pick = (period) => {
        if (!enabled(period)) return []
        const pool = candidates(period)
        return shuffle(pool).slice(0, randomCount(`greetings${period}Min`, `greetings${period}Max`, pool.length))
      }
      const existing = new Set(book.all().filter((t) => t.from === 'todo:greetings' && t.date === day).map((t) => `${t.to}|${t.about}`))
      const morning = pick('Morning')
      const evening = pick('Evening')
      const ideas = [
        ['早安语音问候', 8, 10, morning],
        ['晚间语音问候', 20, 22, evening],
      ]
      let count = 0
      for (const [label, start, end, targets] of ideas) {
        for (const target of targets) {
          if (existing.has(`${target}|${label}`)) continue
          const minute = start * 60 + Math.floor(Math.random() * ((end - start) * 60))
          const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
          const thought = `每日问候：${label}，给对方发一条自然的语音，问候一下并顺着最近两天聊过的话题接一句`
          const result = book.add({ from: 'todo:greetings', thought, to: target, date: day, time, times: 1, about: label })
          if (result.ok) { book.scheduleOne(result.item, (f) => { fire(f) }); count += 1 }
        }
      }
      api.saveSettings({ greetingsLastDay: day })
      api.log.info(`每日问候：已写入 ${count} 条早晚 Todo`)
      return count
    }

    /** 到点了：把念头送到目的对话 */
    async function fire(event) {
      const t = event.item || event
      const target = t.to
      if (!target) return
      const hub = api.core.hub
      // 直接给她一个念头，让她自己开口
      const text = [
        '（你忽然想起了点什么，有点坐不住。不是谁在交代你，也不用汇报）',
        String(t.thought || '').trim(),
        String(t.thought || '').includes('语音') ? '想直接开口说给他听，那就发一条自然的语音，语气放松一点。' : '',
        '要不要找他说两句，说什么你自己看着办。',
      ].filter(Boolean).join('\n')
      const chat = {
        chatId: target,
        kind: String(target).startsWith('group:') ? 'group' : 'private',
        userId: String(target).split(':')[1],
        groupId: String(target).startsWith('group:') ? String(target).split(':')[1] : '',
      }
      try {
        await hub.pushToSession(chat, [{ type: 'text', text }], '', { wantVoice: t.from === 'todo:greetings' })
        api.log.info(`待办到点 → ${target}：${t.thought}`)
      } catch (error) {
        api.log.debug('待办递念头失败：' + (error?.message || error))
      }
    }

    // ---- 工具：只在开关打开、且不是 system 会话时给 ----
    api.tool((where) => {
      if (!on()) return []
      const chatId = String(where?.chat?.chatId || '')
      const sessionId = where?.sessionId
      if (!/^(private|group):\d+$/.test(chatId) || !sessionId) return []
      const crossAllowed = () => {
        const hub = api.core.hub
        const senders = hub.turnSenders?.(sessionId)
        const allowed = new Set(String(settings().crossChatUsers || '').split(/[\s,，]+/).filter((id) => /^\d+$/.test(id)))
        if (Array.isArray(senders) && senders.length > 0) {
          return senders.every((id) => api.isOwner(String(id)) || allowed.has(String(id)))
        }
        return hub.turnSendersAllOwner?.(sessionId) === true
      }
      const canAccess = (item) => crossAllowed() || (item.from === chatId && item.to === chatId)
      const tools = []

      tools.push(api.defineTool({
        name: 'todo_add',
        description:
          '记录并调度待办：有时间的到点递送念头；超出当前一轮或跨聊天的任务也可以写入，没指定时间时第四段填 0，立即安排执行。' +
          '一条一行，竖线分开：来源对话|念头和原因|目的对话|时间(HH:MM)|次数|重复间隔分钟（第六段可省略）。' +
          '例：private:123|想起来问问他作业写完没，怕他熬夜|private:456|14:30|3|5；无时间：private:123|答应去找对方确认消息并回来回复|private:456|0|1。' +
          '第二段一定要写原因。次数照对方说的填：说三次就填 3，说每天就填 -1，没说就填 1。' +
          '第六段由你根据对方要求填写重复间隔分钟；没说就省略，默认 1 分钟。时间只写几点几分，不用写日期（默认今天）。',
        properties: {
          raw: { type: 'string', description: '来源|念头和原因|目的对话|HH:MM或0|次数|间隔分钟' },
          date: { type: 'string', description: '指定日期 YYYY-MM-DD，明天必须明确填明天日期' },
          delayMinutes: { type: 'number', description: '从现在延迟的分钟数，优先于 raw 时间；必须大于0' },
        },
        required: ['raw'],
        execute: async ({ raw, date, delayMinutes }) => {
          const parts = String(raw || '').split('|').map((part) => part.trim())
          if (parts.length < 4) return { ok: false, message: '格式是：来源对话|念头|目的对话|时间(HH:MM)|次数' }
          if (!/^(private|group):\d+$/.test(parts[2])) return { ok: false, message: '目的对话须为 private:QQ号 或 group:群号' }
          if (parts[2] !== chatId && !crossAllowed()) return { ok: false, message: '你只能在当前对话创建待办' }
          parts[0] = chatId
          // 每条待办的重复间隔由 raw 第六段决定；省略时由待办本子使用默认值。
          let input = { from: chatId, thought: parts[1], to: parts[2], time: parts[3], times: parts[4] === undefined ? 1 : Number(parts[4]), gapMs: Number(parts[5]) * 60000, date }
          if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: '日期必须是 YYYY-MM-DD' }
          if (delayMinutes !== undefined) {
            if (!Number.isFinite(delayMinutes) || delayMinutes <= 0 || delayMinutes > 525600) return { ok: false, message: '延迟分钟数须大于0且不超过一年' }
            const when = new Date(Math.ceil((Date.now() + delayMinutes * 60000) / 60000) * 60000)
            input.date = ymd(when)
            input.time = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0')
          }
          const r = book.add(input)
          if (r.ok) {
            try { book.scheduleOne(r.item, (f) => { fire(f) }) } catch (error) {}
          }
          return r.ok ? { ok: true, message: r.message, item: r.item } : r
        },
      }))

      const addSpec = tools[tools.length - 1]
      tools.push({ ...addSpec, name: 'remind_me', description: 'todo_add 的别名，格式完全一样。' })
      tools.push({ ...addSpec, name: 'note_it', description: 'todo_add 的别名，格式完全一样。' })

      const requestChange = (action, id, patch = {}) => {
        const item = book.all().find(t => t.id === id && t.state === 'open' && canAccess(t))
        if (!item) return { ok: false, message: '未找到有权操作的待办；先用 todo_list 获取准确 ID' }
        const senders = api.core.hub.turnSenders?.(sessionId)
        if (!Array.isArray(senders) || !senders.length) return { ok: false, message: '当前没有可确认的用户，请在用户对话中操作' }
        const token = Math.random().toString(16).slice(2, 10)
        const command = `确认 ${action} ${id} ${token}`
        pendingChanges.set(id + ':' + token, { action, chatId, senders: senders.map(String), snapshot: JSON.stringify(item), patch, expires: Date.now() + 10 * 60000 })
        return { ok: true, pending: true, item, proposed: patch, message: `尚未${action}。请展示任务 ID、日期时间、目标和内容${action === '修改' ? '以及修改前后差异' : ''}，请用户明确回复「${command}」。10分钟内有效；任务变化后失效。` }
      }
      tools.push(api.defineTool({
        name: 'todo_done', description: '请求标记完成；必须使用准确 ID，用户确认后才执行。',
        properties: { id: { type: 'string', description: 'todo_list 返回的唯一 ID' } }, required: ['id'],
        execute: async ({ id }) => requestChange('完成', id),
      }))
      tools.push(api.defineTool({
        name: 'todo_update', description: '请求修改待办内容或时间，展示修改前后并让用户确认，不会直接修改。',
        properties: { id: { type: 'string' }, thought: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM' } }, required: ['id'],
        execute: async ({ id, thought, date, time }) => {
          const current = book.all().find(t => t.id === id && canAccess(t))
          if (!current) return { ok: false, message: '找不到任务' }
          const patch = {}
          if (thought !== undefined) { if (!thought.trim()) return { ok: false, message: '内容不能为空' }; patch.thought = thought.trim().slice(0,200) }
          if (date !== undefined || time !== undefined) {
            const d = date ?? current.date, h = time ?? current.hhmm
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) return { ok: false, message: '日期时间格式错误' }
            const at = new Date(d + 'T' + h + ':00').getTime()
            if (!Number.isFinite(at) || at <= Date.now()) return { ok: false, message: '修改后的时间必须在未来' }
            Object.assign(patch, { date: d, hhmm: h, at })
          }
          if (!Object.keys(patch).length) return { ok: false, message: '没有提出修改' }
          return requestChange('修改', id, patch)
        },
      }))

      tools.push(api.defineTool({
        name: 'todo_list',
        description: '看看手上还有哪些待办没触发完。',
        properties: {},
        execute: async () => {
          const list = book.all().filter(t => t.state === 'open' && canAccess(t))
          if (!list.length) return { ok: true, message: '手上没有待办' }
          return {
            ok: true,
            items: list,
            message: list.map((t) => `[${t.id}] ${t.date} ${t.at ? t.hhmm : '待处理（无定时）'} → ${t.to}：${t.thought}${t.at ? `（${t.times === -1 ? '每天' : '还有 ' + t.times + ' 次'}）` : ''}`).join('\n'),
          }
        },
      }))

      tools.push(api.defineTool({
        name: 'todo_cancel', description: '请求撤回指定待办。先列出任务，准确 ID 定位并向用户确认；不会直接撤回。',
        properties: { id: { type: 'string', description: '唯一任务 ID，不接受模糊关键词' } }, required: ['id'],
        execute: async ({ id }) => requestChange('撤回', id),
      }))

      return tools
    })

    // ---- 规则：让她知道自己有这个本子 ----
    // 跟工具共用同一个开关：关掉 scheduler 后，工具和这段提示一起消失。
    api.rule((kind) => {
      if (!on()) return ''
      const groupRule = kind === 'social'
        ? '群聊只在当前群属于配置里的群白名单时写入；不在白名单的群不要调用 todo_add，也不要承诺已经记下。'
        : '私聊可以把当前私聊作为来源和目的对话；如果工具调用失败，要如实说没记进去。'
      return [
        '（你有个小本子，工具叫 todo_add，一直都在。',
        settings().autonomousEnabled === true ? '【自主待办已开启】你可以在对话的任何方面自主决定是否需要后续行动，自行选择合理时间，无须用户明确指定情景或时刻。包括稍后回来、明天找人、等对方忙完、分享兴奋心情等，但不限于这些例子。使用 date 指定日期，或 delayMinutes 设置延迟；不要把明天写成今天。不要用时间0反复自我唤醒；通常先安排一次，再根据真实互动决定后续。尊重别打扰、拒绝联系及休息意愿，不要密集骚扰或绕过权限。' : '【自主待办已关闭】不要仅凭自己的想法主动安排联系；明确承诺仍须写待办。',
        '只要你做出明确承诺，或者事情会跨过当前这一轮、需要稍后/下一轮/明天/之后继续处理，就必须立刻写 todo，不能只说「我记着了」。',
        '明确承诺包括「我会……」「我去……」「回来……」「到时候……」「明天……」「晚点……」「之后……」「再提醒……」，以及答应替别人完成、发送、询问、提醒或跟进的事情。',
        '没有明确时间但超出当前一轮或涉及跨聊天的隐性任务也可以写入 todo，例如答应去另一个聊天找人、询问并带回结果；自主模式关闭时第四段填 0 表示立即安排执行；自主模式开启时可以自己选择合理的未来时间。跨聊天仍须遵守工具权限；排队不等于完成，不要声称已完成或已收到结果。',
        groupRule,
        '格式一条一行，竖线分开六段（第六段可省略）：来源对话|念头和原因|目的对话|时间(HH:MM)|次数。',
        '例：private:123456|想问问他作业写完没，怕他熬夜|private:123456|14:30|3',
        '【第二段一定要写原因】别只写「回来找他」，要写为什么。',
        '【时间和次数照着对方说的填】对方说「每分钟一次，一共三次」，次数就填 3。',
        `到点后每隔 第六段指定的分钟再来一次，直到次数用完。没写次数就是 1 次，写 -1 是每天。`,
        '修改、完成或撤销先用 todo_list 查唯一 ID，再调用 todo_update/todo_done/todo_cancel；展示具体任务和修改差异，请用户回复工具给出的确认口令，不得代替用户确认或声称已执行。别假装已经记下。）',
      ]
    })

    // ---- 定时器：开关打开时才排 ----
    let armed = 0
    function armAll() {
      if (!on()) {
        book.clearAllTimers()
        armed = 0
        api.log.info('待办调度：已关闭，定时器全部清空')
        return
      }
      armed = book.scheduleAll((f) => { fire(f) })
      api.log.info(`待办调度：定时器已排 ${armed} 个`)
    }

    armAll()

    // 开关变了就重新排
    api.on('config', () => {
      try { armAll() } catch (error) {}
    })

    // 兜底对表：新加的、漏掉的
    api.every(5 * 60_000, () => {
      if (!on()) return
      try { armAll() } catch (error) {}
    }, '待办对表')

    // 每天 0 点生成一次早晚问候计划；计划本身进入同一个 Todo 本子。
    api.every(60_000, () => {
      if (!on() || !((settings().greetingsMorningEnabled ?? settings().greetingsEnabled) === true || (settings().greetingsEveningEnabled ?? settings().greetingsEnabled) === true)) return
      const now = new Date()
      if (now.getHours() === 0 && now.getMinutes() < 2) {
        try { createGreetingPlan() } catch (error) { api.log.warn('每日问候生成失败：', error?.message || error) }
      }
    }, '每日问候计划')

    api.onDispose?.(() => { try { book.clearAllTimers() } catch (error) {} })

    // ---- 命令 ----
    api.command({
      name: 'todo',
      desc: '看看还有哪些待办：/todo',
      run: () => {
        if (!on()) return '待办调度是关着的（面板「扩展」→ 待办调度 打开）'
        const list = book.openItems()
        if (!list.length) return '手上没有待办'
        return list.map((t) => `${t.hhmm} → ${t.to}：${t.thought}（${t.times === -1 ? '每天' : '还剩 ' + t.times + ' 次'}）`).join('\n')
      },
    })

    // ---- 网页接口（面板用） ----
    const viewItem = (t) => ({
      id: t.id,
      hhmm: t.hhmm,
      to: t.to,
      thought: t.thought,
      times: t.times,
      state: t.state,
      at: t.at || 0,
      remainingMs: t.state === 'open' ? Math.max(0, (t.at || 0) - Date.now()) : 0,
    })

    api.route('/status', async () => {
      const all = book.all()
      const active = all
        .filter((t) => t.state === 'open')
        .sort((a, b) => (a.at || 0) - (b.at || 0))
        .map(viewItem)
      const items = all
        .filter((t) => t.state === 'open' || t.state === 'done')
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
        .slice(0, 50)
        .map(viewItem)
      return { ok: true, enabled: on(), armed, active, items }
    })

    api.route('/cancel', async (req) => {
      const data = await api.core.http.body(req).catch(() => ({}))
      const id = String(data?.id || '').trim()
      if (!id) return { ok: false, message: '缺少待办 id' }
      const item = book.all().find((t) => t.id === id && t.state === 'open')
      if (!item) return { ok: false, message: '没找到这条正在进行的待办' }
      book.update(id, { state: 'dropped' })
      book.clearTimer(id)
      return { ok: true, message: '已撤回：' + item.thought }
    })

    return { book, fire, armAll }
  },
}
