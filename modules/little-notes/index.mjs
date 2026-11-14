// 小本本：她想到就记一笔——他说过的话、她答应的事、关于他的事、随手记。
// 不是每天一篇的日记，是"想到就记、按人按事翻"的小本子。
// 数据存在 modules-data/little-notes/notes.json，按 chatId 分本。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const KINDS = ['said', 'promise', 'fact', 'note']
const KIND_LABEL = { said: '他说过', promise: '答应过', fact: '他的事', note: '随手记' }
const KIND_OF = new Set(KINDS)
const MAX_DEFAULT = 500

// 测试钩子：setup 时把定时任务的内部函数挂上来，测试可以直接调
export const hooks = {}

// ---------- 存储 ----------

function readDb(dir) {
  const p = join(dir, 'notes.json')
  try {
    if (!existsSync(p)) return {}
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

function writeDb(dir, db) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.json'), JSON.stringify(db, null, 2), 'utf8')
}

function listOf(db, chatId) {
  const arr = db[chatId]
  return Array.isArray(arr) ? arr : []
}

function newList(db, chatId) {
  if (!Array.isArray(db[chatId])) db[chatId] = []
  return db[chatId]
}

function newId() {
  return Date.now().toString(36) + randomBytes(2).toString('hex')
}

// 超上限时丢最旧的普通条目；标了星的（important）尽量保住；刚写入的这条（protectId）永不丢。
// 锁定的（locked）绝对不丢——就算本子超上限也保着，宁可暂时多几条。
function trim(list, max, protectId) {
  if (list.length <= max) return list
  const over = list.length - max
  const free = (e) => !e.locked && e.id !== protectId
  const normals = list.filter((e) => free(e) && !e.important)
  const stars = list.filter((e) => free(e) && e.important)
  const dropFrom = normals.length >= over ? normals : normals.concat(stars)
  const drop = new Set(dropFrom.slice(0, over).map((e) => e.id))
  if (!drop.size) return list
  return list.filter((e) => !drop.has(e.id))
}

function dayOf(at) {
  const t = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

function fmt(e, withId) {
  const head = [KIND_LABEL[e.kind] || '随手记']
  if (e.about) head.push(`关于${e.about}`)
  if (e.due) head.push(`日子 ${e.due}`)
  if (e.locked) head.push('已锁定')
  const tags = Array.isArray(e.tags) && e.tags.length ? ` #${e.tags.join(' #')}` : ''
  const star = e.important ? ' ⭐' : ''
  const id = withId ? `(${e.id}) ` : ''
  return `${id}[${head.join('·')}] ${dayOf(e.at)} ${String(e.text || '')}${tags}${star}`
}

// ---------- 匹配 ----------

function match(e, q) {
  if (q.kind && e.kind !== q.kind) return false
  if (q.about) {
    const a = String(e.about || '')
    if (!(a.includes(q.about) || q.about.includes(a))) return false
  }
  if (q.day) {
    const d = dayOf(e.at)
    if (!d.startsWith(q.day)) return false
  }
  if (q.keyword) {
    const kw = q.keyword.toLowerCase()
    const hay = `${String(e.text || '')} ${(Array.isArray(e.tags) ? e.tags : []).join(' ')} ${String(e.about || '')}`.toLowerCase()
    if (!hay.includes(kw)) return false
  }
  return true
}

// ---------- 主定义 ----------

export default {
  id: 'little-notes',
  name: '小本本',
  version: '1.2.2',
  api: 1,
  description: '她想到就记一笔的小本本：他说过的话、她答应的事、关于他的事，按人按事翻得出来。不是每天一篇的日记。',
  category: 'manage',
  tags: ['记忆', '笔记', '记事'],
  author: 'Ariz0324',
  license: 'MIT',
  minPluginVersion: '1.2.0',
  requires: [],
  capabilities: ['filesystem', 'plugin-config', 'plugin-internals'],
  defaults: { maxPerChat: MAX_DEFAULT, enabled: true, nightlyTidy: true, tidyHour: 23, dueRemind: true },
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用小本本', type: 'switch', hint: '关掉后她记不了也翻不了' },
    { key: 'maxPerChat', label: '每本最多几条', type: 'number', min: 50, max: 5000, step: 50, hint: '超了就丢最旧的' },
    { key: 'nightlyTidy', label: '每晚整理', type: 'switch', hint: '每晚扫一遍当天聊天，让她自己挑值得记的补进本子（每本最多补 5 条）' },
    { key: 'tidyHour', label: '每晚几点整理', type: 'number', min: 20, max: 23, step: 1 },
    { key: 'dueRemind', label: '日子到了主动提', type: 'switch', hint: '记了日子的事，当天早上 8 点后她会主动提一句' },
  ],

  setup(api) {
    const dir = api.dataDir()

    const on = () => api.settings().enabled !== false
    const cap = () => {
      const n = Number(api.settings().maxPerChat)
      return Number.isFinite(n) && n >= 10 ? Math.floor(n) : MAX_DEFAULT
    }
    const who = () => String(api.config().ownerName || '主人')

    function add(chatId, e) {
      const db = readDb(dir)
      const list = newList(db, chatId)
      const entry = {
        id: newId(),
        at: Date.now(),
        about: String(e.about || '').trim(),
        kind: KIND_OF.has(e.kind) ? e.kind : 'note',
        text: String(e.text || '').trim(),
        tags: Array.isArray(e.tags) ? e.tags.map(String).filter(Boolean).slice(0, 6) : [],
        important: e.important === true,
        due: String(e.due || '').trim(),
      }
      if (!entry.text) return null
      list.push(entry)
      const max = cap()
      db[chatId] = trim(list, max, entry.id)
      writeDb(dir, db)
      return entry
    }

    // ---------- 她的工具 ----------

    api.tool(({ chat, level, sessionId }) => {
      if (!on() || chat.kind === 'system') return []
      const isAllOwner = () => {
        try { return api.core.hub.turnSendersAllOwner(sessionId) } catch { return level === 'full' }
      }

      const addTool = api.defineTool({
        name: 'note_add',
        description: `在小本本上记一笔：${who()}说过的话（kind=said）、你答应过的事（kind=promise）、关于他的重要的事（kind=fact）、随手记（kind=note）。聊天里出现值得记住的就说一声的功夫记下来，text 里写清楚人物和时间。`,
        properties: {
          text: { type: 'string', description: '要记的内容，一句话写清楚（谁、什么时候、什么事）' },
          kind: { type: 'string', description: `类型：said（${who()}说过的话）/ promise（你答应他的事）/ fact（关于他的事）/ note（随手记）` },
          about: { type: 'string', description: `关于谁，比如「${who()}」或群友昵称。不填默认${who()}` },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，方便以后翻，比如 ["约定","生日"]' },
          important: { type: 'boolean', description: '重要的事标 true' },
          due: { type: 'string', description: '和日子有关时填，YYYY-MM-DD，比如答应下周去做就填那天' },
        },
        required: ['text'],
        execute: async ({ text, kind, about, tags, important, due }) => {
          const entry = add(chat.chatId, { text, kind, about: about || who(), tags, important, due })
          if (!entry) return { ok: false, message: '内容是空的，没记' }
          return { ok: true, message: `记好了：${fmt(entry, false)}` }
        },
      })

      const searchTool = api.defineTool({
        name: 'note_search',
        description: `翻小本本：按关键词、人、类型、日期查记过的事。${who()}问「我之前说过什么」「你答应过我什么来着」时，先翻再答，别凭空编。`,
        properties: {
          keyword: { type: 'string', description: '关键词，在内容、标签、人名里找' },
          about: { type: 'string', description: '按人查，比如「' + who() + '」或某人的昵称' },
          kind: { type: 'string', description: '按类型查：said / promise / fact / note' },
          day: { type: 'string', description: '按日子查，YYYY-MM-DD，也可以只写 YYYY-MM 查一个月' },
          limit: { type: 'number', description: '最多返回几条，默认 15' },
        },
        execute: async ({ keyword, about, kind, day, limit }) => {
          const db = readDb(dir)
          const all = listOf(db, chat.chatId).filter((e) => !e.deletedAt && match(e, { keyword, about, kind: KIND_OF.has(kind) ? kind : '', day }))
          if (!all.length) return { ok: true, message: '本子上没有对得上的记录。' }
          const n = Math.max(1, Math.min(50, Number(limit) || 15))
          const picked = all.slice(-n).reverse()
          const head = `翻到 ${all.length} 条，给你最新的 ${picked.length} 条：`
          return { ok: true, message: head + '\n' + picked.map((e) => fmt(e, true)).join('\n') }
        },
      })

      const recentTool = api.defineTool({
        name: 'note_recent',
        description: '看小本本最近记了什么。想不起来记没记过、或想回顾最近的事时用。',
        properties: {
          limit: { type: 'number', description: '最近几条，默认 10' },
        },
        execute: async ({ limit } = {}) => {
          const db = readDb(dir)
          const all = listOf(db, chat.chatId).filter((e) => !e.deletedAt)
          if (!all.length) return { ok: true, message: '本子还是空白的，想到值得记的就 note_add 记一笔。' }
          const n = Math.max(1, Math.min(50, Number(limit) || 10))
          const picked = all.slice(-n).reverse()
          return { ok: true, message: `本子上共 ${all.length} 条，最近 ${picked.length} 条：\n` + picked.map((e) => fmt(e, true)).join('\n') }
        },
      })

      const forgetTool = api.defineTool({
        name: 'note_forget',
        description: '从小本本上划掉一条记错的或过时的（会保留划掉的痕迹）。只有主人让删时才用。',
        properties: {
          id: { type: 'string', description: '要删的条目 id（note_search / note_recent 结果里括号里那个）' },
          keyword: { type: 'string', description: '没 id 时按关键词找，只删唯一对上的那条' },
        },
        execute: async ({ id, keyword }) => {
          if (!isAllOwner()) return { ok: false, message: '这个只能主人让我删才行。' }
          const db = readDb(dir)
          const list = listOf(db, chat.chatId)
          let idx = -1
          if (id) idx = list.findIndex((e) => e.id === id && !e.deletedAt)
          else if (keyword) {
            const hits = list.filter((e) => !e.deletedAt && match(e, { keyword }))
            if (hits.length !== 1) return { ok: false, message: hits.length ? `对上 ${hits.length} 条，说清楚一点或给我 id。` : '没找到对得上的。' }
            idx = list.findIndex((e) => e.id === hits[0].id)
          }
          if (idx < 0) return { ok: false, message: '没找到要划掉的那条，给个 id 或更准的关键词。' }
          const gone = list[idx]
          gone.deletedAt = Date.now()
          writeDb(dir, db)
          return { ok: true, message: `划掉了：${fmt(gone, false)}` }
        },
      })

      return [addTool, searchTool, recentTool, forgetTool]
    })

    // ---------- 告诉她有这个本子 ----------

    api.rule((kind) => {
      if (!on()) return ''
      if (kind === 'private') {
        return `你有一个小本本（note_add 记 / note_search 翻 / note_recent 看最近 / note_forget 删）。这些时候要**主动**记一笔：${who()}说了他的喜好、计划、烦恼、重要的事；你答应了他什么——答应了当场就记，别忘了；聊到具体的日期、生日、纪念日；他说「你记住」。翻的时机：他问「我之前说过什么」「你答应过什么」时，先 note_search 翻一翻再回答，别凭空编。`
      }
      return '群聊里有人说了值得记住的事（托付、约定、重要的事），也可以 note_add 记到这个群的本子上，翻用 note_search。'
    })

    // 每轮塞一句轻量上下文：本子上有什么
    api.context(({ chat }) => {
      if (!on() || chat.kind === 'system') return ''
      const db = readDb(dir)
      const all = listOf(db, chat.chatId).filter((e) => !e.deletedAt)
      if (!all.length) return ''
      const last = all[all.length - 1]
      const due = all.filter((e) => e.due).length
      return `【小本本】${who()}这本有 ${all.length} 条${due ? `（${due} 条带日子）` : ''}。最近一条：${fmt(last, false).slice(0, 80)}`
    })

    // ---------- 主人命令 ----------

    api.command({
      name: '本子',
      desc: '看小本本最近记了什么',
      run: async (arg, msg) => {
        const db = readDb(dir)
        const all = listOf(db, msg?.chatId || '')
        if (!all.length) return '本子还是空白的。'
        const n = Math.max(1, Math.min(30, Number(arg) || 10))
        return all.slice(-n).reverse().map((e) => fmt(e, true)).join('\n')
      },
    })

    api.command({
      name: '记',
      desc: '往小本本上记一笔：/记 明天下午3点取快递',
      run: async (arg, msg) => {
        if (!arg) return '记什么呀：/记 内容'
        const entry = add(msg.chatId, { text: arg, kind: 'note', about: who() })
        return entry ? `记好了：${fmt(entry, false)}` : '没记上，内容是空的。'
      },
    })

    api.command({
      name: '翻',
      desc: '翻小本本：/翻 关键词 或 /翻 约定',
      run: async (arg, msg) => {
        if (!arg) return '翻什么：/翻 关键词'
        const db = readDb(dir)
        const hits = listOf(db, msg?.chatId || '').filter((e) => match(e, { keyword: arg }))
        if (!hits.length) return '本子上没有对得上的。'
        return hits.slice(-15).reverse().map((e) => fmt(e, true)).join('\n')
      },
    })

    // ---------- 兜底一：每晚整理 ----------
    // 她当场没来得及记的，深夜让"她"自己扫一遍当天聊天，挑值得记的补进本子。

    function normText(s) {
      return String(s || '').toLowerCase().replace(/\s+/g, '')
    }

    let tidyDoneDay = ''

    async function tidyOnce(now) {
      if (api.settings().nightlyTidy === false || !on()) return
      const h = now.getHours()
      const wantHour = Number(api.settings().tidyHour)
      const hour = Number.isFinite(wantHour) ? Math.min(23, Math.max(20, Math.floor(wantHour))) : 23
      // 23 点后整理今天；凌晨 0-5 点当作"昨晚"，整理前一天
      let day
      if (h < 5) {
        const y = new Date(now)
        y.setDate(y.getDate() - 1)
        day = dayOf(y.getTime())
      } else if (h >= hour) {
        day = dayOf(now.getTime())
      } else {
        return
      }
      if (tidyDoneDay === day) return
      tidyDoneDay = day
      const db = readDb(dir)
      const chatIds = Object.keys(db).filter((c) => c.startsWith('private:') || c.startsWith('group:'))
      if (!chatIds.length) return
      let rows
      try { rows = api.core.hub.chatLogOf(day) || [] } catch { return }
      for (const chatId of chatIds) {
        const lines = rows.filter((r) => r && r.chatId === chatId && String(r.text || '').trim())
        if (lines.length < 6) continue
        const excerpt = lines.slice(-120).map((r) => `${r.who || '?'}：${String(r.text).slice(0, 80)}`).join('\n')
        const target = chatId.startsWith('group:') ? '群友们' : who()
        const answer = await api.think(
          `下面是今天的聊天记录。挑出值得写进你小本本的：${target}说过的重要的话、你答应过的事、关于${target}的重要信息。闲聊寒暄、重复的不要，最多 5 条，没有就给空数组。只回 JSON 数组：[{"kind":"said|promise|fact|note","about":"关于谁","text":"一句话写清楚（谁、什么时候、什么事）","tags":["标签"]}]，没有就只回 []。\n\n聊天记录：\n${excerpt}`,
          { title: '小本本·每晚整理', timeoutMs: 120000 },
        )
        if (!answer) continue
        const m = String(answer).match(/\[[\s\S]*\]/)
        if (!m) continue
        let items
        try { items = JSON.parse(m[0]) } catch { continue }
        if (!Array.isArray(items) || !items.length) continue
        let added = 0
        for (const it of items.slice(0, 5)) {
          const text = String(it.text || '').trim()
          if (!text) continue
          // 跟已有条目对一遍，明显重复的不补
          const t = normText(text)
          if (t.length >= 6 && listOf(readDb(dir), chatId).some((e) => {
            const x = normText(e.text)
            return x.includes(t) || t.includes(x)
          })) continue
          const entry = add(chatId, {
            text, kind: it.kind, about: it.about || target,
            tags: [...(Array.isArray(it.tags) ? it.tags.filter(Boolean) : []), '整理'],
            important: false, due: it.due,
          })
          if (entry) added++
        }
        if (added) api.log.info(`[little-notes] ${chatId} 晚间整理补了 ${added} 条`)
      }
    }

    api.every(20 * 60 * 1000, async () => { await tidyOnce(new Date()) }, '小本本每晚整理')

    // ---------- 兜底二：日子到了主动提 ----------

    async function remindOnce(now) {
      if (api.settings().dueRemind === false || !on()) return
      const h = now.getHours()
      if (h < 8 || h >= 23) return
      const today = dayOf(now.getTime())
      const db = readDb(dir)
      for (const [chatId, list] of Object.entries(db)) {
        if (!(chatId.startsWith('private:') || chatId.startsWith('group:'))) continue
        const due = list.filter((e) => e.due === today && !e.remindAt)
        if (!due.length) continue
        const names = due.map((e) => `「${String(e.text).slice(0, 40)}」`).join('、')
        const say = await api.think(
          `你小本本上记着今天（${today}）有日子到了：${names}。用你自己的语气主动跟对方提一句，就一句，像自己想起来那样自然地说，别提"小本本"和"工具"。`,
          { title: '小本本·日子提醒', timeoutMs: 60000 },
        )
        if (say && String(say).trim()) {
          api.send(chatId, String(say).trim())
          for (const e of due) e.remindAt = Date.now()
          writeDb(dir, db)
          api.log.info(`[little-notes] ${chatId} 提了 ${due.length} 个日子`)
        }
      }
    }

    api.every(15 * 60 * 1000, async () => { await remindOnce(new Date()) }, '小本本日子提醒')

    hooks.tidyOnce = tidyOnce
    hooks.remindOnce = remindOnce

    // ---------- 面板接口 ----------

    api.route('/notes', () => {
      const db = readDb(dir)
      const out = []
      for (const [chatId, list] of Object.entries(db)) {
        for (const e of list) out.push({ ...e, chatId })
      }
      out.sort((a, b) => b.at - a.at)
      return { ok: true, notes: out.slice(0, 300), total: out.length }
    })

    async function bodyOf(req) {
      try {
        const b = await api.core.http.body(req)
        return b && typeof b === 'object' ? b : {}
      } catch {
        return {}
      }
    }

    api.route('/add', async (req) => {
      const b = await bodyOf(req)
      const chatId = String(b.chatId || '').trim()
      const text = String(b.text || '').trim()
      if (!chatId || !text) return { ok: false, message: '缺 chatId 或内容' }
      const entry = add(chatId, { text, kind: b.kind, about: b.about, tags: b.tags, important: b.important, due: b.due })
      return entry ? { ok: true, entry } : { ok: false, message: '没记上' }
    })

    api.route('/del', async (req) => {
      const b = await bodyOf(req)
      const chatId = String(b.chatId || '')
      const id = String(b.id || '')
      const db = readDb(dir)
      const list = listOf(db, chatId)
      const e = list.find((x) => x.id === id)
      if (!e) return { ok: false, message: '没找到这条' }
      e.deletedAt = Date.now()
      writeDb(dir, db)
      return { ok: true, gone: e }
    })

    api.route('/pin', async (req) => {
      const b = await bodyOf(req)
      const chatId = String(b.chatId || '')
      const id = String(b.id || '')
      const db = readDb(dir)
      const list = listOf(db, chatId)
      const e = list.find((x) => x.id === id)
      if (!e) return { ok: false, message: '没找到这条' }
      e.important = !e.important
      writeDb(dir, db)
      return { ok: true, important: e.important }
    })

    api.route('/lock', async (req) => {
      const b = await bodyOf(req)
      const chatId = String(b.chatId || '')
      const id = String(b.id || '')
      const db = readDb(dir)
      const list = listOf(db, chatId)
      const e = list.find((x) => x.id === id)
      if (!e) return { ok: false, message: '没找到这条' }
      e.locked = !e.locked
      writeDb(dir, db)
      return { ok: true, locked: e.locked }
    })

    api.route('/undel', async (req) => {
      const b = await bodyOf(req)
      const chatId = String(b.chatId || '')
      const id = String(b.id || '')
      const db = readDb(dir)
      const list = listOf(db, chatId)
      const e = list.find((x) => x.id === id)
      if (!e) return { ok: false, message: '没找到这条' }
      delete e.deletedAt
      writeDb(dir, db)
      return { ok: true }
    })

    // 手账页：真的小本本，左右翻页，手写字，划掉有痕迹
    api.route('/page', async (req, res) => {
      try {
        const html = readFileSync(join(api.dir, 'lib', 'notes.html'), 'utf8')
        api.core.http.send(res, 200, html, 'text/html; charset=utf-8')
      } catch (error) {
        api.core.http.send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    api.log.info('小本本就绪：她想到就能记，按人按事翻')
  },
}
