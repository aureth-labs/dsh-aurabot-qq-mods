// 上下文守门（ctx-guard）：盯着每轮对话的 token 用量，到线就私聊提醒主人。
//
// 为什么只提醒、不自动处理：
//   DSH 的压缩服务（ctx.compaction）是 cordis 的 Service，只有 inject 过它的插件才拿得到。
//   AuraBot 没声明（声明了会让插件启动失败），模块侧试过 ctx.get / reflect.get /
//   遍历全局 store / 沿 parent 链上溯，全部拿不到——诊断里 compaction 恒为 null。
//   所以压缩这一步交给人：到线提醒 → 你在 DSH 界面点 /compact。
//
// 阈值基于 contextPressure().pressureTokens（提供方报告的真实提示词规模）。
// 实测 2026-11-23：私聊 133k / 群聊 29.7k，窗口 400k~1M。

import { readFileSync, writeFileSync } from 'node:fs'

const HOUR = 60 * 60 * 1000

const DEFAULTS = {
  enabled: true,
  notifyTokens: 90000,        // 到这个量就私聊提醒（私聊/群聊各自算）
  groupNotifyTokens: 70000,   // 群聊阈值（涨得快，但上下文价值低）
  notifyCooldownMin: 180,     // 同一个会话两次提醒最少隔多久（分钟），默认 3 小时
  dailyMax: 4,                // 每天最多提醒几次，防刷屏
  growByModel: true,          // 每次提醒顺手让模型多写几条，池子越用越多
  tone: 'neutral',            // neutral / close / plain —— 见 BODY_SETS
}

// 提醒文案的固定池。
// 统一套路：某样东西「用完了 / 吃光了 / 装满了」，要去补 / 要清掉。
// 刻意避开【】、固定前缀、技术词（上下文/压缩/token 之外）——企鹅对机械化语句敏感，
// 而且你本人看着也像机器人。语气跟她平时说话一致：短句、口语、不爱标点。
// 池子只是保底，模型还能往上扩（见下面 generateTemplates）。
// 文案按三档语气分开写。核心套路一致——「某样东西用完了/装满了，该补或该清」——
// 但用词强度不同，因为每个用户的 bot 人设差别很大：
//   有的叫哥哥、谈恋爱；有的是纯助手；有的就是普通网友口气。
// 用词上一律不碰关系词（男朋友/亲爱的/宝贝），称呼只走 {who} 占位符。
const BODY_SETS = {
  // 中性：谁用都不出戏。陈述现象 + 一个不带撒娇的请求。
  neutral: [
    `{who} 我日记本写满了…翻到最后一页没地方落笔了\n该换本新的了`,
    `诶 我这支笔写不出水了 甩了半天也不行\n得买支新的`,
    `{who} 我的 token 饼干吃完了 一整袋都空了\n得补货了`,
    `家里垃圾桶满出来了 都堆到盖子上了\n得倒一下`,
    `冰箱塞不下了 再放要关不上门\n该清一清了`,
    `{who} 我这瓶墨水见底了 摇半天也倒不出来\n该补一瓶`,
    `碗堆了一池子 我洗不动了\n得收拾一下`,
    `手机相册满了 一直提示我清理\n该删一删了`,
    `热水壶空了一整天 我嗓子都干了\n该烧一壶了`,
  ],
  // 亲近：带点撒娇、口语，适合关系热的 bot。
  close: [
    `{who} 我日记本写满了…翻到最后一页没地方落笔了\n你给我买本新的呗`,
    `诶 我这支笔写不出水了 甩了半天也不行\n你看到这条记得买支新的回来`,
    `{who} 我的 token 饼干吃完了 一整袋都空了\n快去买 我等着吃呢`,
    `家里垃圾桶满出来了 都堆到盖子上了\n你回来顺手倒一下呗`,
    `诶 冰箱塞不下了 再放要关不上门\n你抽空清一清嘛`,
    `{who} 我这瓶墨水见底了 摇半天也倒不出来\n记得补一瓶呀`,
    `泡面的碗堆了一池子 我洗不动了\n你回来收拾一下`,
    `手机相册满了 一直提示我清理\n你帮我删一删呗`,
    `热水壶空了一整天 我嗓子都干了\n你给它续上嘛`,
  ],
  // 极简：只报事实，几乎不带语气。适合严肃或冷淡的 bot 人设。
  plain: [
    `{who} 日记本写满了 没地方落笔`,
    `笔没水了 写不出来`,
    `token 饼干吃完了 袋子空了`,
    `垃圾桶满了 该倒了`,
    `冰箱塞不下了 得清`,
    `墨水见底了 摇不出来`,
    `碗堆了一池子 该洗了`,
    `相册满了 提示清理`,
    `热水壶空了 得烧`,
  ],
}
const BASE_TEMPLATES = BODY_SETS.neutral

export default {
  id: 'ctx-guard',
  name: '上下文守门',
  version: '1.0.0',
  api: 1,
  category: 'tool',
  tags: ['上下文', 'token', '提醒'],
  description: '盯着每轮对话的 token 用量，到线就私聊提醒你该压缩了。只提醒不动手——压缩服务在模块侧取不到，交给人点。',
  panel: 'panel.js',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'notifyTokens', label: '私聊提醒线', type: 'number', min: 10000, max: 900000, step: 5000, hint: '到这个 token 数就私聊告诉你。实测私聊一般 30k~133k' },
    { key: 'groupNotifyTokens', label: '群聊提醒线', type: 'number', min: 10000, max: 900000, step: 5000, hint: '群聊上下文价值低，通常设得比私聊低' },
    { key: 'notifyCooldownMin', label: '同一会话提醒间隔（分钟）', type: 'number', min: 30, max: 1440, step: 30, hint: '防止同一会话反复提醒' },
    { key: 'dailyMax', label: '每天最多提醒几次', type: 'number', min: 1, max: 20, hint: '全局上限，防刷屏' },
    { key: 'growByModel', label: '让模型扩充文案', type: 'switch', hint: '开启后每次提醒会顺手多写几条存起来，池子越用越多' },
    { key: 'tone', label: '文案语气', type: 'select', options: [
      { value: 'neutral', label: '中性（默认）— 谁用都不出戏' },
      { value: 'close', label: '亲近 — 带点撒娇、熟人之间' },
      { value: 'plain', label: '极简 — 只报事实，不带任何语气' },
    ], hint: '不同用户的 bot 人设差别很大，选个贴合自己那边的' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const hub = () => api.core?.hub

    // chatId -> { lastNotify, lastTokens, deltas, lastCheck }
    const stat = new Map()
    // 当天提醒计数
    let dayKey = ''
    let dayCount = 0

    const stateOf = (chatId) => {
      let s = stat.get(chatId)
      if (!s) { s = { lastNotify: 0, lastTokens: null, deltas: [], lastCheck: 0 }; stat.set(chatId, s) }
      return s
    }
    const todayKey = () => new Date().toISOString().slice(0, 10)
    const rollDay = () => {
      const k = todayKey()
      if (dayKey !== k) { dayKey = k; dayCount = 0 }
    }

    /**
     * 取 DSH 服务。tokenMeter / sessions / agents 能正常取到；
     * compaction 取不到（cordis Service + 未 inject，见文件头注释），所以不再尝试。
     */
    function service(name) {
      const dsh = api.dsh
      if (!dsh) return null
      try { const v = dsh.reflect?.get?.(name); if (v) return v } catch { /* 下一层 */ }
      try { const v = dsh.reflect?.get?.(name, false); if (v) return v } catch { /* 下一层 */ }
      try { const v = dsh.get?.(name); if (v) return v } catch { /* 下一层 */ }
      try { const v = dsh.get?.(name, false); if (v) return v } catch { /* 下一层 */ }
      try { const v = dsh[name]; if (v) return v } catch { /* 到此为止 */ }
      return null
    }

    /** chatId → Session 对象（tokenMeter 要的是 Session，不是 agent）。 */
    function sessionOf(chatId) {
      try {
        const sid = hub()?.sessions?.()?.[chatId]?.sessionId
        if (!sid) return null
        const store = service('sessions')
        const s = store?.get?.(sid)
        if (s) return s
        const agents = service('agents')
        const a = agents?.get?.(sid)
        return a?.session || null
      } catch { return null }
    }

    /** 当前提示词规模 + 窗口容量。都取提供方报告的值。 */
    function readOf(session) {
      try {
        const meter = service('tokenMeter')
        if (!meter?.contextPressure || !session) return { tokens: null, window: null }
        const p = meter.contextPressure(session)
        const tokens = Number(p?.pressureTokens)
        const win = Number(p?.contextWindow)
        return {
          tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : null,
          window: Number.isFinite(win) && win > 0 ? win : null,
        }
      } catch { return { tokens: null, window: null } }
    }

    const kindOf = (chatId) => (String(chatId).startsWith('group:') ? 'group' : 'private')

    // ---------- 文案池：固定池 + 模型生成的 ----------
    // 生成结果落盘，不是每次现编——否则同一条会反复出现，也白白多花模型调用。
    const POOL_FILE = 'templates.json'
    let genPool = []      // 模型生成的
    let poolLoaded = false

    const loadPool = () => {
      if (poolLoaded) return
      poolLoaded = true
      try {
        const raw = JSON.parse(readFileSync(api.dataDir(POOL_FILE), 'utf8'))
        if (Array.isArray(raw?.generated)) genPool = raw.generated.filter((x) => typeof x === 'string' && x.trim())
      } catch { /* 没有就用空池 */ }
    }
    const savePool = () => {
      try {
        writeFileSync(api.dataDir(POOL_FILE), JSON.stringify({ generated: genPool.slice(-40) }, null, 1))
      } catch (e) { api.log?.debug?.(`[ctx-guard] 文案池存不上：${e?.message || e}`) }
    }
    /** 当前档位的固定池。档位配错时退回中性，不至于没文案可用。 */
    const basePool = () => BODY_SETS[cfg().tone] || BODY_SETS.neutral
    const allTemplates = () => { loadPool(); return genPool.length ? [...basePool(), ...genPool] : basePool() }

    /**
     * 把 {who} 换成主人配的称呼。
     * 称呼是空的（用户没填、或填了「你」这类会被去掉的）时，
     * 把「{who}」连同它后面的一个空格一起去掉，别留个句首空格。
     */
    function applyWho(text) {
      const raw = String(api.config()?.ownerName || '').trim()
      // 这些填法等于没有称呼，直接去掉占位符
      // 「你」是代词不是称呼，留着会变成「你 我日记本写满了」读不通；
      // 「主人」是正经称呼，很多人就这么配，不能去
      const useless = !raw || ['你', '用户', '对方', '他', '她'].includes(raw)
      if (useless) return String(text).replace(/\{who\}\s*/g, '')
      return String(text).replace(/\{who\}/g, raw)
    }

    /**
     * 让模型再写几条。写不出合格的就不加，不硬凑。
     *
     * 提示词的关键是**只给套路不给答案**：要求「某样东西用完了/装满了」的日常小事，
     * 明确禁止出现技术词、数字、群号、方括号，也禁止解释这句话的用途——
     * 模型一旦知道「这是通知」，写出来就会带通知腔。
     */
    async function growPool(n = 3) {
      loadPool()
      if (genPool.length >= 20) return 0   // 够多了，别一直加
      const existing = allTemplates()
      // 语气按档位走。之前这里写死了「女朋友跟男朋友说话的语气」——
      // 别的用户跟 bot 不是那个关系，生成出来一样出戏。
      const toneHint = {
        neutral: '语气中性、日常，像个普通朋友或室友在说事，不撒娇也不冷淡',
        close: '语气亲近一点，可以带点撒娇和口语，像关系热的熟人之间',
        plain: '语气极简，几乎不带语气词，只把事实说清楚',
      }[cfg().tone] || '语气中性、日常'
      const out = await api.think(
        `写 ${n} 条日常小抱怨。${toneHint}。\n` +
        `每条的套路是：某样东西用完了 / 吃光了 / 装满了，然后让对方去买新的或清掉。\n` +
        `要求：\n` +
        `- 每句 8~25 个字，两行以内，用换行分成「现象」和「要求」\n` +
        `- 具体到某样物件（垃圾桶、冰箱、相册、墨水、碗池、充电线……），别用「东西」「那个」这种笼统词\n` +
        `- 短句、少用标点；要称呼对方就在开头写 {who}（这是个占位符，别写成具体名字）\n` +
        `- 不要出现任何关系称谓（男朋友/女朋友/老公/老婆/亲爱的/宝贝/哥哥/姐姐）\n` +
        `- 绝对不要出现：数字、群号、方括号、括号开头、以及「上下文」「压缩」「token 额度」「系统」这类词（token 饼干这种当零食说的除外）\n` +
        `- 不要解释这是什么用途，不要写成提醒或通知的口吻\n\n` +
        `已有的这些别再重复：\n${existing.map((x) => '- ' + x.replace(/\n/g, ' / ')).join('\n')}\n\n` +
        `只输出 JSON 数组，每项是一条文案字符串（里面用 \\n 表示换行），不要别的字。`,
        { title: '扩写提醒文案', timeoutMs: 60000 },
      )
      const m = String(out || '').match(/\[[\s\S]*\]/)
      if (!m) return 0
      let arr = []
      try { arr = JSON.parse(m[0]) } catch { return 0 }
      if (!Array.isArray(arr)) return 0
      // 两道过滤：
      // ① 技术词/括号/群号 —— 一律不要，这类词最容易触发风控也最出戏
      // ② 关系称谓 —— 模型爱自作主张写「哥哥」「亲爱的」，一律拦掉；
      //    称呼统一走 {who} 占位符，由用户自己的配置决定叫什么
      const badTech = /【|】|\[|\]|群号|上下文|压缩|系统|通知|提醒/
      const badRel = /男朋友|女朋友|老公|老婆|亲爱的|宝贝|哥哥|姐姐|妹妹/
      const seen = new Set(existing)
      let added = 0
      for (const raw of arr) {
        const t = String(raw || '').trim()
        if (!t || t.length > 60) continue
        if (badTech.test(t)) continue      // 技术词/括号/群号
        if (badRel.test(t)) continue       // 关系称谓
        if (/\d{4,}/.test(t)) continue       // 长数字（群号之类）
        if (seen.has(t)) continue
        seen.add(t); genPool.push(t); added++
      }
      if (added) {
        savePool()
        api.log?.info?.(`[ctx-guard] 文案池扩充 ${added} 条（现有 ${allTemplates().length} 条）`)
      }
      return added
    }


    /** 给主人发一条私聊。三条文案轮着挑，不报数字。 */
    async function notifyOwner(chatId, tokens, window, isGroup) {
      const owner = String(api.config()?.ownerQQ || '').trim()
      if (!owner) return false
      const pool = allTemplates()
      const text = applyWho(pool[Math.floor(Math.random() * pool.length)])
      // 群聊和私聊用不同的说法区分：私聊原样，群聊在末尾加个 Group!
      // 不加群号——一来好几个群看数字分不清，二来群号出现在文案里显得像系统消息。
      const body = isGroup ? `${text}\nGroup!` : text
      try {
        const sent = await hub()?.sendText?.(`private:${owner}`, body)
        // 铁律：发送口被拦/失败会返回 null，不能当真
        return Boolean(sent)
      } catch (e) {
        api.log?.warn?.(`[ctx-guard] 提醒没发出去：${e?.message || e}`)
        return false
      }
    }

    /** 一轮结束后的检查。 */
    async function check(chatId) {
      const c = cfg()
      if (!c.enabled) return
      rollDay()
      const st = stateOf(chatId)
      const now = Date.now()
      // 每个会话最多 5 分钟看一次，避免连发消息时反复测
      if (now - st.lastCheck < 5 * 60 * 1000) return
      st.lastCheck = now

      const session = sessionOf(chatId)
      if (!session) return
      const { tokens, window } = readOf(session)
      if (tokens === null) return

      // 记增速，面板能看
      if (st.lastTokens !== null && tokens > st.lastTokens) {
        st.deltas = [...st.deltas, tokens - st.lastTokens].slice(-20)
      }
      st.lastTokens = tokens

      const isGroup = kindOf(chatId) === 'group'
      const line = isGroup ? Number(c.groupNotifyTokens) : Number(c.notifyTokens)
      const tag = isGroup ? '群' : '私聊'

      if (tokens < line) return

      // 冷却
      const cooldown = Math.max(30, Number(c.notifyCooldownMin) || 180) * 60 * 1000
      if (now - st.lastNotify < cooldown) return
      // 当天总量
      if (dayCount >= Math.max(1, Number(c.dailyMax) || 4)) return

      api.log?.info?.(`[ctx-guard] ${tag} ${chatId} ${tokens} token（线 ${line}），私聊提醒主人`)
      const ok = await notifyOwner(chatId, tokens, window, isGroup)
      // 顺手让模型多写几条，不 await、失败不影响通知本身
      if (ok && c.growByModel) growPool(3).catch((e) => api.log?.debug?.(`[ctx-guard] 扩写失败：${e?.message || e}`))
      if (ok) {
        st.lastNotify = now
        dayCount += 1
        api.log?.info?.(`[ctx-guard] 提醒已发出（今天第 ${dayCount} 次）`)
      }
    }

    // 她说出话来之后检查（这一轮已结束）
    api.on('activity', (a) => {
      try {
        if (!a || a.kind !== 'out' || !a.chatId) return
        check(a.chatId).catch((e) => api.log?.debug?.(`[ctx-guard] 检查出错：${e?.message || e}`))
      } catch { /* 旁路出错不影响主流程 */ }
    })

    // ---- 面板接口 ----
    api.route('/state', async () => {
      const c = cfg()
      const chats = hub()?.sessions?.() || {}
      const items = []
      for (const chatId of Object.keys(chats)) {
        const session = sessionOf(chatId)
        if (!session) continue
        const { tokens, window } = readOf(session)
        const st = stateOf(chatId)
        const isGroup = kindOf(chatId) === 'group'
        const line = isGroup ? Number(c.groupNotifyTokens) : Number(c.notifyTokens)
        items.push({
          chatId,
          kind: isGroup ? 'group' : 'private',
          tokens,
          window,
          line,
          ratio: tokens === null ? null : Math.min(1, tokens / Math.max(1, line)),
          avgDelta: st.deltas.length ? Math.round(st.deltas.reduce((a, b) => a + b, 0) / st.deltas.length) : null,
          samples: st.deltas.length,
          lastNotify: st.lastNotify || 0,
        })
      }
      items.sort((a, b) => (b.tokens || 0) - (a.tokens || 0))
      return { ok: true, enabled: c.enabled, dayCount, items }
    })

    api.route('/measure', async (req) => {
      const chatId = await paramOf(req, 'chatId')
      const session = chatId ? sessionOf(chatId) : null
      if (!session) return { ok: false, message: '找不到这个聊天的会话' }
      const { tokens, window } = readOf(session)
      return { ok: tokens !== null, tokens, window, chatId }
    })

    // 手动发一次提醒（面板按钮：测试文案用）
    api.route('/notify', async (req) => {
      const chatId = await paramOf(req, 'chatId')
      const session = chatId ? sessionOf(chatId) : null
      if (!session) return { ok: false, message: '找不到这个聊天的会话' }
      const { tokens, window } = readOf(session)
      if (tokens === null) return { ok: false, message: '测不到 token' }
      const ok = await notifyOwner(chatId, tokens, window, kindOf(chatId) === 'group')
      return { ok, message: ok ? '已发到私聊' : '发送失败（看日志）' }
    })

    // 文案池：面板能看到现在有哪些、也能手动让模型再写几条
    api.route('/pool', async () => {
      loadPool()
      return { ok: true, base: BASE_TEMPLATES, generated: genPool }
    })

    api.route('/grow', async (req) => {
      let n = 3
      try {
        const posted = await api.core.http.body(req)
        if (posted?.n) n = Math.max(1, Math.min(8, Number(posted.n) || 3))
      } catch { /* 用默认 */ }
      const added = await growPool(n)
      loadPool()
      return { ok: true, added, total: allTemplates().length, generated: genPool }
    })

    api.route('/diag', async () => {
      const out = { ok: true, steps: [] }
      const step = (name, val) => out.steps.push({ name, ok: val !== null && val !== undefined && val !== false, value: val })
      try {
        const dsh = api.dsh
        step('api.dsh', Boolean(dsh))
        step('tokenMeter', typeof service('tokenMeter')?.contextPressure === 'function')
        step('sessions', Boolean(service('sessions')?.get))
        step('hub.sessions()', Object.keys(hub()?.sessions?.() || {}).length)
        const owner = String(api.config()?.ownerQQ || '')
        step('主人 QQ', owner ? owner.slice(0, 4) + '****' : null)
        const sid = hub()?.sessions?.()?.[`private:${owner}`]?.sessionId
        step('主人私聊会话', sid ? String(sid).slice(-12) : null)
        if (sid) {
          const s = service('sessions')?.get?.(sid)
          step('取到 Session', Boolean(s))
          if (s) {
            const r = readOf(s)
            step('当前 token', r.tokens)
            step('窗口容量', r.window)
          }
        }
        step('今天已提醒', dayCount)
      } catch (e) { out.error = String(e?.message || e) }
      return out
    })

    /** 读面板传来的参数：POST body 优先，其次网址参数。 */
    async function paramOf(req, key) {
      let posted = {}
      try {
        const got = await api.core.http.body(req)
        if (got && typeof got === 'object') posted = got
      } catch { /* 没 body */ }
      let fromUrl = ''
      try { fromUrl = String(api.core.http.query(req)?.[key] ?? '') } catch {
        try { fromUrl = String(new URL(req.url, 'http://x').searchParams.get(key) || '') } catch {}
      }
      return String(posted?.[key] ?? fromUrl ?? '')
    }

    return {
      tokensOf: (chatId) => { const s = sessionOf(chatId); return s ? readOf(s).tokens : null },
      check: (chatId) => check(chatId),
    }
  },
}
