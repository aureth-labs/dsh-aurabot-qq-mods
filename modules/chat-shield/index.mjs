// 聊天屏蔽 —— 黑名单 + 自动防刷屏 / 防机器人互刷
//
// 主人 2026-11-27 的要求：「控制对话聊天，允许添加聊天黑名单；群聊、私聊里禁止黑名单
// 进行对话；增加屏蔽功能，避免对话污染以及机器人之间毫无营养的重复对话。」
// 追加：「黑名单放开填写，给一个输入框」—— 名单改成面板里两个输入框，一行一个号，
// QQ 里发 /屏蔽 加 xxx 也写进同一个输入框，两边看到的是同一份名单。
//
// 三条路：
//   1) 黑名单（永久）：按 QQ 号 / 群号，命中就静默 —— 在 message 事件里 return true 接管，
//      她一个字都不回，也不进模型。
//   2) 临时屏蔽（自动）：刷屏、复读同一句、把她刚说过的话原样丢回来 —— 自动静默 N 分钟。
//      按「会话 + 人」精确到具体聊天，A 群刷屏不会连带 B 群。
//   3) 自检：她自己 90 秒内复读几乎一样的话，第二条直接拦下不发。
//
// 主人永远放行 —— 黑名单把自己拉进去会出事，这条写在最前面。
// 名单存在模块设置里（面板输入框就是它），所以不碰任何文件、不联网。

const DEFAULTS = {
  enabled: true,
  blockUsers: '',
  blockGroups: '',
  blockPrivate: true,
  blockGroup: true,
  autoDetect: true,
  repeatLimit: 3,
  windowSec: 60,
  floodDetect: true,
  floodLimit: 12,
  echoDetect: true,
  echoSimilarity: 0.7,
  echoHits: 2,
  selfRepeat: true,
  muteMin: 10,
  logBlocked: true,
}

const MAX_PER_KIND = 2000 // 名单上限，防止一行行贴到天上去
const OUT_KEEP = 8         // 每个会话记她最近 8 条发言
const OUT_TTL = 30 * 60_000
const SELF_REPEAT_TTL = 90_000
const SELF_REPEAT_RATIO = 0.9
const ID_RE = /^\d{5,12}$/

// ---------- 文本比较 ----------
// 归一化：去掉占位符、表情、空白、标点，只留能比的字
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\[[^\]]{0,40}\]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

function grams(s) {
  const set = new Set()
  if (!s) return set
  if (s.length === 1) set.add(s)
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

// 双字组 Jaccard：短句也稳，不需要分词
export function similarity(a, b) {
  const A = grams(normalize(a))
  const B = grams(normalize(b))
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const x of A) if (B.has(x)) hit++
  return hit / (A.size + B.size - hit)
}

// ---------- 名单文本 ----------
// 一行一个：`123456789`、`123456789 广告号`、`123456789 #广告号`、`123456789,广告号` 都行
// 空行和 # 开头的注释行跳过
export function parseList(text) {
  const rows = []
  const bad = []
  const seen = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#')) continue
    const m = raw.match(/^(\d{5,12})(?:[\s,，、#|]+(.*))?$/)
    if (!m) { bad.push(raw); continue }
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id, note: String(m[2] ?? '').trim().slice(0, 40) })
    if (rows.length >= MAX_PER_KIND) break
  }
  return { rows, bad }
}

export function renderList(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => (r.note ? `${r.id} ${r.note}` : `${r.id}`))
    .join('\n')
}

export default {
  id: 'chat-shield',
  name: '聊天屏蔽',
  version: '1.1.0',
  api: 1,
  description: '群聊 / 私聊黑名单静默，被拉黑的人她一字不回；自动识别刷屏与机器人互刷，防对话污染。',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '总开关', type: 'switch', hint: '关掉后名单仍然保存，只是不生效' },
    {
      key: 'blockUsers',
      label: '黑名单：人',
      type: 'textarea',
      hint: '一行一个 QQ 号，后面可以跟备注，例如 123456789 广告号；空行和 # 开头的行会跳过',
      placeholder: '123456789 广告号\n987654321',
    },
    {
      key: 'blockGroups',
      label: '黑名单：群',
      type: 'textarea',
      hint: '一行一个群号，也可以跟备注；她不会在这些群里说话',
      placeholder: '123456789 广告群',
    },
    { key: 'blockPrivate', label: '私聊生效', type: 'switch' },
    { key: 'blockGroup', label: '群聊生效', type: 'switch' },
    { key: 'autoDetect', label: '自动识别刷屏 / 互刷', type: 'switch', hint: '不靠名单，自己看行为' },
    { key: 'repeatLimit', label: '同一句话重复几次算复读', type: 'number', min: 2, max: 10, step: 1 },
    { key: 'windowSec', label: '观察窗口（秒）', type: 'number', min: 10, max: 600, step: 10 },
    { key: 'floodDetect', label: '刷屏检测', type: 'switch' },
    { key: 'floodLimit', label: '窗口内多少条算刷屏', type: 'number', min: 3, max: 60, step: 1 },
    { key: 'echoDetect', label: '回声检测（对方复述她的话）', type: 'switch', hint: '机器人互刷的典型特征是把她刚说的话换个壳丢回来' },
    { key: 'echoSimilarity', label: '回声相似度门槛', type: 'number', min: 0.5, max: 1, step: 0.05, hint: '越高越不容易误伤' },
    { key: 'echoHits', label: '连续几次回声才动手', type: 'number', min: 1, max: 10, step: 1 },
    { key: 'selfRepeat', label: '拦住她自己复读', type: 'switch', hint: '同一会话 90 秒内几乎一样的话，第二条不发' },
    { key: 'muteMin', label: '临时屏蔽多久（分钟）', type: 'number', min: 1, max: 1440, step: 1 },
    { key: 'logBlocked', label: '面板日志里记一笔', type: 'switch' },
  ],

  setup(api) {
    const num = (v, d) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : d
    }
    const S = () => ({ ...DEFAULTS, ...api.settings() })

    // ---------- 名单（读设置里的两个输入框） ----------
    // 每次现解析，返回新数组 —— 调用方（命令）可以放心改，不会污染下一次读取
    let lastBad = ''
    function rowsOf(kind) {
      const text = String(S()[kind === 'group' ? 'blockGroups' : 'blockUsers'] ?? '')
      const { rows, bad } = parseList(text)
      if (bad.length && text !== lastBad) {
        lastBad = text
        api.log.warn(`黑名单里有 ${bad.length} 行没看懂，已跳过：${bad.slice(0, 3).join(' / ')}`)
      }
      return rows
    }
    const users = () => rowsOf('user')
    const groups = () => rowsOf('group')

    function saveRows(kind, rows) {
      api.saveSettings({ [kind === 'group' ? 'blockGroups' : 'blockUsers']: renderList(rows) })
    }

    // ---------- 临时屏蔽（只在内存，重启就清空） ----------
    const temp = new Map() // `${chatId}|${userId}` -> { until, reason, at, nickname, uid, chatId }
    const now = () => Date.now()
    const tmpKey = (chatId, uid) => `${chatId}|${uid}`

    function tempUntil(chatId, uid) {
      const key = tmpKey(chatId, uid)
      const rec = temp.get(key)
      if (!rec) return 0
      if (Number(rec.until) > now()) return Number(rec.until)
      temp.delete(key)
      return 0
    }

    const findUser = (id) => users().find((u) => u.id === id) || null
    const findGroup = (id) => groups().find((g) => g.id === id) || null

    // ---------- 运行期记录 ----------
    const seen = new Map()   // `${chatId}|${userId}` -> { times, texts, echo }
    const outbox = new Map() // chatId -> [{ text, at }]

    function bucketOf(key) {
      let b = seen.get(key)
      if (!b) { b = { times: [], texts: [], echo: [] }; seen.set(key, b) }
      return b
    }

    function pushOut(chatId, text) {
      const t = String(text ?? '').trim()
      if (!t) return
      const arr = outbox.get(chatId) || []
      arr.push({ text: t, at: now() })
      while (arr.length > OUT_KEEP) arr.shift()
      outbox.set(chatId, arr)
    }

    const recentOut = (chatId, span) => (outbox.get(chatId) || []).filter((x) => x.at >= now() - span)

    const clock = (ms) => {
      const d = new Date(Number(ms) || 0)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}`
    }

    // ---------- 判定 ----------
    // 只看名单，无副作用；decide / reply 用它，避免重复累计计数
    function hardJudge(msg) {
      const uid = String(msg?.userId ?? '')
      if (!uid) return null
      if (api.isOwner?.(uid)) return null

      const u = findUser(uid)
      if (u) return { why: u.note ? `黑名单（${u.note}）` : '黑名单', type: 'blacklist' }

      const until = tempUntil(msg.chatId, uid)
      if (until) return { why: `临时屏蔽中（到 ${clock(until)}）`, type: 'temp', until }

      if (msg.kind === 'group' && msg.groupId && findGroup(String(msg.groupId))) {
        return { why: '群在黑名单', type: 'group' }
      }
      return null
    }

    function mute(msg, reason, s) {
      const minutes = Math.max(1, num(s.muteMin, 10))
      const key = tmpKey(msg.chatId, String(msg.userId))
      temp.set(key, {
        until: now() + minutes * 60_000,
        reason,
        at: now(),
        nickname: String(msg.nickname ?? '').slice(0, 40),
        chatId: msg.chatId,
        uid: String(msg.userId),
      })
      api.log.warn(`临时屏蔽 ${msg.nickname || msg.userId}（${msg.userId}）${minutes} 分钟：${reason}`)
    }

    // 行为判定，有副作用（计数）
    function detect(msg, s) {
      const win = num(s.windowSec, 60) * 1000
      const since = now() - win
      const key = `${msg.chatId}|${msg.userId}`
      const b = bucketOf(key)
      b.times = b.times.filter((x) => x >= since)
      b.texts = b.texts.filter((x) => x.at >= since)
      b.echo = b.echo.filter((x) => x >= since)
      b.times.push(now())

      // 1) 刷屏
      if (s.floodDetect) {
        const limit = Math.max(3, num(s.floodLimit, 12))
        if (b.times.length >= limit) {
          const reason = `${Math.round(win / 1000)} 秒内发了 ${b.times.length} 条`
          mute(msg, reason, s)
          return { why: reason, type: 'temp' }
        }
      }

      const norm = normalize(msg.text)
      if (!norm) return null // 纯图 / 纯表情不参与文本判定

      // 2) 复读同一句
      b.texts.push({ t: norm, at: now() })
      const same = b.texts.filter((x) => x.t === norm).length
      const repeatLimit = Math.max(2, num(s.repeatLimit, 3))
      if (same >= repeatLimit) {
        const reason = `${Math.round(win / 1000)} 秒内重复同一句话 ${same} 次`
        mute(msg, reason, s)
        return { why: reason, type: 'temp' }
      }

      // 3) 把她刚说的话换个壳丢回来 —— 机器人互刷
      if (s.echoDetect) {
        const th = Math.min(1, Math.max(0.5, Number(s.echoSimilarity) || 0.7))
        let best = 0
        for (const m of recentOut(msg.chatId, OUT_TTL)) {
          const sim = similarity(m.text, msg.text)
          if (sim > best) best = sim
          if (best >= 1) break
        }
        if (best >= th) {
          b.echo.push(now())
          const need = Math.max(1, num(s.echoHits, 2))
          if (b.echo.length >= need) {
            const reason = `和她自己刚说的话高度雷同（${Math.round(best * 100)}%）`
            mute(msg, reason, s)
            return { why: reason, type: 'temp' }
          }
        }
      }
      return null
    }

    function judge(msg) {
      const s = S()
      if (!s.enabled) return null
      const isGroup = msg.kind === 'group'
      if (isGroup && !s.blockGroup) return null
      if (!isGroup && !s.blockPrivate) return null

      const hard = hardJudge(msg)
      if (hard) return hard
      if (!s.autoDetect) return null
      return detect(msg, s)
    }

    // 出站目标是否被屏蔽
    function blockedTarget(chatId) {
      const s = S()
      if (!s.enabled) return ''
      if (chatId.startsWith('private:')) {
        if (!s.blockPrivate) return ''
        const uid = chatId.slice(8)
        if (findUser(uid)) return '这个人在黑名单'
        if (tempUntil(chatId, uid)) return '这个人被临时屏蔽'
        return ''
      }
      if (chatId.startsWith('group:')) {
        if (!s.blockGroup) return ''
        if (findGroup(chatId.slice(6))) return '这个群在黑名单'
        return ''
      }
      return ''
    }

    // ---------- 事件 ----------
    // 黑名单 / 刷屏：直接接管，她不会看到这条消息
    api.on('message', async (msg) => {
      try {
        if (!msg?.chatId) return false
        const hit = judge(msg)
        if (!hit) return false
        if (S().logBlocked) {
          const where = msg.kind === 'group' ? `群 ${msg.groupId}` : '私聊'
          api.log.info(`静默 ${where} 的 ${msg.nickname || msg.userId}（${msg.userId}）：${hit.why}`)
        }
        return true
      } catch (e) {
        api.log.error('判定出错，放行：' + (e?.message || e))
        return false
      }
    })

    // 第二道闸：主动插话路径也走这里
    api.on('group/decide', (decision, info) => {
      try {
        const msg = info?.msg
        if (!msg) return
        const hit = hardJudge(msg)
        if (hit) return { reply: false, reason: hit.why }
      } catch { /* 不拦就按原样走 */ }
    })

    // 出站：不往屏蔽对象发；她自己复读就拦下
    api.on('reply', (text, info) => {
      try {
        const s = S()
        const chatId = String(info?.chatId ?? '')
        if (!s.enabled || !chatId) return

        const why = blockedTarget(chatId)
        if (why) {
          if (s.logBlocked) api.log.info(`拦下发往 ${chatId} 的消息：${why}`)
          return null
        }

        const body = String(text ?? '')
        if (s.selfRepeat && normalize(body).length >= 4) {
          for (const m of recentOut(chatId, SELF_REPEAT_TTL)) {
            const sim = similarity(m.text, body)
            if (sim >= SELF_REPEAT_RATIO) {
              if (s.logBlocked) api.log.info(`拦下复读（${chatId}，与「${m.text.slice(0, 20)}」相似 ${Math.round(sim * 100)}%）`)
              return null
            }
          }
        }
        pushOut(chatId, body)
      } catch (e) {
        api.log.warn('出站检查出错：' + (e?.message || e))
      }
    })

    // ---------- 命令 ----------
    function statusText() {
      const s = S()
      const scope = [s.blockPrivate ? '私聊' : '', s.blockGroup ? '群聊' : ''].filter(Boolean).join(' + ') || '无'
      const temps = [...temp.values()].filter((r) => Number(r?.until) > now()).length
      const auto = s.autoDetect
        ? `复读 ${num(s.repeatLimit, 3)} 次 / ${num(s.windowSec, 60)} 秒，刷屏 ${num(s.floodLimit, 12)} 条，回声 ${Math.round(Math.min(1, Number(s.echoSimilarity) || 0.7) * 100)}% ×${num(s.echoHits, 2)}`
        : '关'
      return [
        `总开关：${s.enabled ? '开' : '关'}　生效范围：${scope}`,
        `黑名单：${users().length} 人 / ${groups().length} 群　临时屏蔽：${temps} 人`,
        `自动识别：${auto}`,
        `自检复读：${s.selfRepeat ? '开' : '关'}　临时屏蔽时长：${num(s.muteMin, 10)} 分钟`,
        '名单就在面板「聊天屏蔽」的两个输入框里，一行一个号',
      ].join('\n')
    }

    function listText() {
      const us = users().slice(0, 20).map((u, i) => `${i + 1}. ${u.id}${u.note ? `（${u.note}）` : ''}`)
      const gs = groups().slice(0, 20).map((g, i) => `${i + 1}. 群 ${g.id}${g.note ? `（${g.note}）` : ''}`)
      if (!us.length && !gs.length) return '黑名单是空的，面板里两个输入框也能直接填'
      const parts = []
      if (us.length) parts.push(`人（${users().length}）：\n${us.join('\n')}`)
      if (gs.length) parts.push(`群（${groups().length}）：\n${gs.join('\n')}`)
      return parts.join('\n')
    }

    function tempText() {
      const rows = [...temp.values()].filter((r) => Number(r?.until) > now())
      if (!rows.length) return '没有临时屏蔽'
      return '临时屏蔽：\n' + rows
        .map((r, i) => `${i + 1}. ${r.nickname || r.uid}（${r.chatId}）到 ${clock(r.until)}，原因：${r.reason || '—'}`)
        .join('\n')
    }

    function addId(kind, id, note) {
      if (!ID_RE.test(id)) return '要 QQ 号或群号（5~12 位数字）'
      const rows = rowsOf(kind)
      const hit = rows.find((x) => x.id === id)
      if (hit) {
        if (note && !hit.note) { hit.note = note; saveRows(kind, rows) }
        return `${kind === 'group' ? '群' : '人'} ${id} 已经在名单里了`
      }
      rows.unshift({ id, note: note || '' })
      saveRows(kind, rows.slice(0, MAX_PER_KIND))
      return `已拉黑${kind === 'group' ? '群' : '人'} ${id}${note ? `（${note}）` : ''}`
    }

    function delId(kind, id) {
      const rows = rowsOf(kind)
      const i = rows.findIndex((x) => x.id === id)
      if (i < 0) return `${id} 不在名单里`
      rows.splice(i, 1)
      saveRows(kind, rows)
      return `已移出黑名单：${id}`
    }

    function onCommand(raw) {
      const text = String(raw ?? '').trim()
      const parts = text ? text.split(/\s+/) : []
      const head = (parts[0] || '').toLowerCase()

      if (!parts.length || ['状态', 'status', 'info'].includes(head)) return statusText()
      if (['列表', '名单', 'list', 'ls'].includes(head)) return listText()
      if (['临时', 'temp', 'mute'].includes(head)) return tempText()
      if (['开', 'on'].includes(head)) { api.saveSettings({ enabled: true }); return '屏蔽已打开' }
      if (['关', 'off'].includes(head)) { api.saveSettings({ enabled: false }); return '屏蔽已关闭（名单还在，只是不生效）' }

      // 群相关：/屏蔽 群 加 456 备注
      if (['群', 'group', 'g'].includes(head)) {
        const act = (parts[1] || '').toLowerCase()
        if (['列表', 'list', 'ls'].includes(act)) return listText()
        if (['加', '添加', 'add', '+'].includes(act)) return addId('group', String(parts[2] ?? '').trim(), parts.slice(3).join(' '))
        if (['删', '删除', '移除', 'del', 'rm', '-'].includes(act)) return delId('group', String(parts[2] ?? '').trim())
        if (parts[1]) return addId('group', String(parts[1]).trim(), parts.slice(2).join(' '))
        return '用法：/屏蔽 群 加 群号 [备注]'
      }

      // 解除临时屏蔽
      if (['解除', '恢复', 'unmute', 'unblock'].includes(head)) {
        const id = String(parts[1] ?? '').trim()
        let n = 0
        for (const key of [...temp.keys()]) {
          if (key.endsWith(`|${id}`)) { temp.delete(key); n++ }
        }
        return n ? `已解除 ${id} 的临时屏蔽（${n} 处）` : `${id} 没有被临时屏蔽`
      }

      // 清空
      if (['清空', 'clear'].includes(head)) {
        const u = users().length
        const g = groups().length
        if (parts[1] !== '确认') return `清空会删掉全部 ${u} 人和 ${g} 群，确认请发：/屏蔽 清空 确认`
        api.saveSettings({ blockUsers: '', blockGroups: '' })
        return '黑名单已清空'
      }

      const add = ['加', '添加', 'add', '+', '拉黑'].includes(head)
      const del = ['删', '删除', '移除', 'del', 'rm', '-', '取消'].includes(head)
      if (add) return addId('user', String(parts[1] ?? '').trim(), parts.slice(2).join(' '))
      if (del) return delId('user', String(parts[1] ?? '').trim())

      // /屏蔽 123456 备注 —— 省略动词也当加人
      if (ID_RE.test(head)) return addId('user', head, parts.slice(1).join(' '))

      return [
        '用法：',
        '/屏蔽 —— 看状态',
        '/屏蔽 列表 —— 看名单',
        '/屏蔽 加 123456789 备注 —— 拉黑这个人',
        '/屏蔽 删 123456789 —— 解除',
        '/屏蔽 群 加 987654321 —— 屏蔽整个群',
        '/屏蔽 临时 —— 看自动屏蔽的',
        '/屏蔽 解除 123456789 —— 解除某人的临时屏蔽',
        '/屏蔽 开 / 关 —— 总开关',
        '也可以直接改面板「聊天屏蔽」里的两个输入框，一行一个号',
      ].join('\n')
    }

    api.command({
      name: '屏蔽',
      aliases: ['blacklist', 'bl'],
      desc: '/屏蔽 —— 黑名单与自动屏蔽；/屏蔽 加 123456789 —— 拉黑一个人',
      run: (arg) => onCommand(arg),
    })

    // ---------- 清理 ----------
    api.every(30 * 60_000, () => {
      const cutoff = now() - 10 * 60_000
      for (const [k, b] of seen) {
        b.times = b.times.filter((x) => x >= cutoff)
        b.texts = b.texts.filter((x) => x.at >= cutoff)
        b.echo = b.echo.filter((x) => x >= cutoff)
        if (!b.times.length && !b.texts.length && !b.echo.length) seen.delete(k)
      }
      for (const [k, arr] of outbox) {
        const keep = arr.filter((x) => x.at >= now() - OUT_TTL)
        if (keep.length) outbox.set(k, keep)
        else outbox.delete(k)
      }
      for (const [k, r] of temp) {
        if (!(Number(r?.until) > now())) temp.delete(k)
      }
    }, '清理过期记录')

    // ---------- 给别的模块用 ----------
    return {
      isBlocked: (userId) => {
        const id = String(userId ?? '')
        return !!findUser(id) || !!tempUntil(`private:${id}`, id)
      },
      list: () => ({ users: users().map((u) => ({ ...u })), groups: groups().map((g) => ({ ...g })) }),
      add: (id, note) => addId('user', String(id ?? '').trim(), String(note ?? '')),
      remove: (id) => delId('user', String(id ?? '').trim()),
    }
  },
}
