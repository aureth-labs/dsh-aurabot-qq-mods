// 每日晚报：晚上 8 点把当天的科技新闻筛成几条要点，私聊推给主人。
//
// 数据源：IT之家 RSS（科技 / 硬件 / AI，中文，国内稳定）。
// 没加综合新闻源，原因：60s 那个接口不稳定（连请求两次就空响应），
// 而且综合热榜里时政比例高，容易踩线。科技源干净，也更贴主人的兴趣。
//
// 配置在 config.json → ext.morning：
//   enabled / atHour / atMinute / maxItems//
// 命令：/晚报（立刻生成一份）

import { readFileSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'

const FEEDS = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { name: 'Solidot', url: 'https://www.solidot.org/index.rss' },
  { name: '爱范儿', url: 'https://www.ifanr.com/feed' },
  { name: '少数派', url: 'https://sspai.com/feed' },
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// 日期由代码算好塞进提示词。原来写的是「<N>月<M>日晚报」让模型自己填，
// 模型看不到今天的日期，就编了一个「5月7日」出来（2026-11-08 用户发现）。
const todayLabel = () => {
  const d = new Date()
  return `${d.getMonth() + 1}月${d.getDate()}日晚报`
}

// 详细度档位：面板里选，直接决定提示词里的条数和每条的写法。
const DETAILS = {
  brief: { count: 3, rule: '每条只写一句话、不超过 25 字，说清「发生了什么」就停，不要解释为什么重要' },
  normal: { count: 6, rule: '每条不超过 45 字：先说是什么，再补一句为什么值得注意' },
  deep: { count: 4, rule: '每条 60~90 字、分两小句：第一句是什么（带关键数字或型号），第二句影响谁、为什么重要' },
}

const systemPrompt = (label, { detail = 'normal', interests = '', maxItems = 6 } = {}) => {
  const d = DETAILS[detail] || DETAILS.normal
  // 常规档尊重面板里的「最多几条」，简报/详细档用固定条数（写死了才不会和前两条规则打架）
  const count = detail === 'normal' ? Math.max(1, Math.min(10, Number(maxItems) || 6)) : d.count
  const like = String(interests || '').split(/[,，、\s]+/).filter(Boolean).slice(0, 12)
  return `你在给主人写今晚的科技新闻简报。下面是今天各来源抓到的标题（每条前面有序号，方括号里是来源媒体）。

挑出真正值得他知道的几条。判断标准：
一、影响面大——行业级、平台级的变化，不是某个小产品的促销
二、跟 AI、开发、硬件、开源、互联网产品有关
三、有信息量——能让他知道「发生了什么」，不是「又有新闻了」
${like.length ? `四、他最近更关心这些方向：${like.join('、')}。同类新闻优先考虑，但别硬凑，没有就不写` : ''}

一定要跳过的：股价涨跌、降价促销、明星八卦、发布会倒计时、纯娱乐、重复报道、时政。

输出格式（严格照这个，不要多写，不要 markdown）：
${label}

第一行必须一字不差地照抄上面那行标题，不要改日期、不要加年份、不要自己算今天是几号。

· ${d.rule}
· 每一条的末尾都要用括号标出来源媒体，照抄输入里给出的那个名字，比如（IT之家）（少数派）；没有来源的条目不要自己编一个

最多 ${count} 条。
如果今天确实没什么值得说的，就只输出一行：「今天没什么特别的。」

不要写「以下是」「希望对你有帮助」这类话。`
}

const pickTag = (s, tag) => {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)
  const m = s.match(re)
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
}

function fetchXml(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml,*/*' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve(data))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

function parseItems(xml, source = '') {
  const out = []
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const s = m[1]
    const title = pickTag(s, 'title')
    if (!title) continue
    const raw = pickTag(s, 'pubDate')
    const ts = Date.parse(raw)
    out.push({ title, link: pickTag(s, 'link'), ts: Number.isNaN(ts) ? 0 : ts, source })
  }
  return out
}

const dayKey = (t = Date.now()) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default {
  id: 'morning',
  name: '每日晚报',
  version: '1.0.0',
  description: '每晚定时抓多个科技媒体，筛成几条要点私聊推给主人（标注来源），也能随时问她「今天有什么新闻」',
  api: 1,
  defaults: {
    enabled: true,
    atHour: 20,
    atMinute: 0,
    maxItems: 6,
    detail: 'normal',
    interests: '',
  },
  settings: [
    { key: 'enabled', label: '定时推送', type: 'switch', hint: '关掉只停定时；/晚报 命令随时能用' },
    { key: 'atHour', label: '几点（小时）', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'atMinute', label: '几分', type: 'number', min: 0, max: 59, step: 5 },
    {
      key: 'detail',
      label: '详细程度',
      type: 'select',
      options: [
        { value: 'brief', label: '简报（3 条，每条一句话）' },
        { value: 'normal', label: '常规（6 条，是什么 + 为什么重要）' },
        { value: 'deep', label: '详细（4 条，每条带影响面）' },
      ],
    },
    { key: 'interests', label: '更关心的话题', type: 'text', placeholder: 'AI 芯片, 开源, 游戏引擎', hint: '逗号分隔。命中的新闻会被优先挑出来，留空就不偏科' },
    { key: 'maxItems', label: '最多几条（仅常规档生效）', type: 'number', min: 1, max: 10, step: 1 },
  ],
  setup(api) {
    const readJson = (name, fallback) => {
      try {
        return JSON.parse(readFileSync(api.dataDir(name), 'utf8'))
      } catch (error) {
        return fallback
      }
    }
    const writeJson = (name, data) => {
      try {
        writeFileSync(api.dataDir(name), JSON.stringify(data, null, 2), 'utf8')
      } catch (error) {
        api.log.warn('[morning] 写文件失败：', error.message)
      }
    }

    const state = readJson('state.json', { lastDay: '' })
    let running = false

    async function collect() {
      const all = []
      for (const feed of FEEDS) {
        try {
          const xml = await fetchXml(feed.url)
          const items = parseItems(xml, feed.name)
          api.log.info(`[morning] ${feed.name} 抓到 ${items.length} 条`)
          all.push(...items)
        } catch (error) {
          api.log.warn(`[morning] ${feed.name} 抓取失败：${error.message}`)
        }
      }
      // 多源之后同一件事会被好几家同时报道，按标题前 14 字去重，先到的（FEEDS 顺序）优先
      const seen = new Set()
      const unique = []
      for (const it of all) {
        const k = String(it.title).replace(/[\s\p{P}]/gu, '').slice(0, 14)
        if (k && seen.has(k)) continue
        if (k) seen.add(k)
        unique.push(it)
      }
      return unique
    }

    // 兴趣加权：命中关键词的条目前置。只影响排序，不影响模型最终挑哪几条。
    function rankByInterest(items, interests) {
      const words = String(interests || '').split(/[,，、\s]+/).filter(Boolean).slice(0, 12)
      if (!words.length) return items
      const score = (t) => words.reduce((n, w) => (String(t).includes(w) ? n + 1 : n), 0)
      return [...items]
        .map((x) => ({ x, s: score(x.title) }))
        .sort((a, b) => (b.s - a.s) || (b.x.ts - a.x.ts))
        .map((r) => r.x)
    }

    async function build(force = false) {
      if (running) return { ok: false, message: '上一份还在生成' }
      const s = api.settings()
      if (!s.enabled && !force) return { ok: true, skipped: true }
      running = true
      try {
        // 从 api.config() 取（文档里的正确写法）。原来读的是 core.config.ownerQQ，
        // 这两个都是 undefined，结果每晚都只生成不发送，主人压根没收到过晚报（2026-11-08 查实）。
        let ownerQQ = ''
        try {
          ownerQQ = api.config()?.ownerQQ || api.ownerQQ || ''
        } catch (error) {
          api.log.warn('[morning] 读配置失败：', error.message)
        }
        const items = await collect()
        if (!items.length) {
          return { ok: false, message: '一条新闻都没抓到（试试 /晚报 再跑一次）' }
        }

        // 只要最近 30 小时内的，按时间倒序，再按主人的兴趣加权前置
        const cutoff = Date.now() - 30 * 3600 * 1000
        const fresh = rankByInterest(
          items.filter((x) => !x.ts || x.ts >= cutoff).sort((a, b) => b.ts - a.ts),
          s.interests,
        ).slice(0, 40)

        if (!fresh.length) return { ok: false, message: '今天没有新抓到的新闻' }

        const text = fresh.map((x, i) => `${i + 1}. [${x.source || '来源未知'}] ${x.title}`).join('\n')
        const detail = DETAILS[s.detail] ? s.detail : 'normal'
        let answer = ''
        try {
          answer = await api.ask({
            system: systemPrompt(todayLabel(), { detail, interests: s.interests, maxItems: s.maxItems }),
            text,
            maxTokens: detail === 'deep' ? 900 : 700,
          })
        } catch (error) {
          api.log.warn('[morning] 生成失败：', error.message)
          return { ok: false, message: '生成失败：' + error.message }
        }
        const body = String(answer || '').trim()
        if (!body) return { ok: false, message: '模型没写出东西' }

        if (ownerQQ) {
          try {
            await api.sendText(`private:${ownerQQ}`, body)
          } catch (error) {
            api.log.warn('[morning] 发送失败：', error.message)
            return { ok: false, message: '发送失败：' + error.message }
          }
        } else {
          api.log.warn('[morning] 没拿到 ownerQQ，只生成不发送')
        }

        // 推完要给她自己留个底：这条是模块直接发到 QQ 的，不走她的会话，
        // 不记一笔的话，第二天她本人完全不知道推过什么（2026-11-08 用户反馈）。
        try {
          const memory = api.lazy('memory')
          const brief = fresh.slice(0, 8).map((x, i) => `${i + 1}.${x.title}`).join('；').slice(0, 360)
          memory?.addEvent?.({
            kind: 'seen',
            text: `今天 ${ownerQQ ? '给主人' : ''}推了晚报，共 ${fresh.length} 条，头条是：${brief}`,
            tags: ['新闻', '晚报'],
            importance: 0.5,
          })
        } catch (error) {
          api.log.warn('[morning] 晚报没记进记忆：', error.message)
        }

        if (!force) {
          state.lastDay = dayKey()
          writeJson('state.json', state)
        }
        api.log.info(`[morning] 晚报已生成（候选 ${fresh.length} 条），已发给主人`)
        return { ok: true, text: body, total: fresh.length }
      } catch (error) {
        api.log.error('[morning] 出错：', error.message)
        return { ok: false, message: error.message }
      } finally {
        running = false
      }
    }

    // 每 5 分钟看一次到点没有
    //
    // 2026-11-05 修：原来只判断「now >= due」，结果白天重启后只要今天还没发过，
    // 就会每 5 分钟抓一次新闻、调一次模型，把 LLM 占满导致聊天不回。
    // 现在加两道闸：
    //   1. 只在到点后 3 小时内发（20:00 → 23:00），过了不补发
    //   2. 连续失败 3 次就放弃今天，别一直重试
    let failCount = 0
    const checkDue = async () => {
      const s = api.settings()
      if (!s.enabled) return
      const now = new Date()
      if (state.lastDay === dayKey(now.getTime())) return
      const due = (Number(s.atHour) || 20) * 60 + (Number(s.atMinute) || 0)
      const nowMin = now.getHours() * 60 + now.getMinutes()
      if (nowMin < due) return
      if (nowMin > due + 180) return // 过了窗口就别补发，免得白天一直抢模型
      if (failCount >= 3) return
      const r = await build(false)
      if (r.ok) failCount = 0
      else {
        failCount += 1
        api.log.warn(`[morning] 第 ${failCount} 次没成功：${r.message || '未知原因'}`)
      }
    }

    api.every(5 * 60 * 1000, checkDue, '每日晚报')

    // 现查新闻的工具：对方问「今天有什么新闻」时自己抓一遍，别只能干等晚上那条推送。
    // 晚报是模块直接发到 QQ 的，不经过她的会话；不给个查的工具，她手上就是空的（2026-11-08）。
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'qq_today_news',
        description:
          '查今天最新的科技新闻（IT之家实时抓取）。对方说「今天有什么新闻」「最近科技圈有啥事」「念两条新闻听听」这类话时用。' +
          '返回的是标题列表，别自己编内容，标题里没写的细节不要说。',
        properties: {
          limit: { type: 'number', description: '要几条，默认 8，最多 15' },
          keyword: { type: 'string', description: '只看含这个词的新闻，可留空' },
        },
        execute: async ({ limit, keyword } = {}) => {
          const n = Math.max(1, Math.min(15, Number(limit) || 8))
          const kw = String(keyword || '').trim()
          const items = await collect()
          const cutoff = Date.now() - 30 * 3600 * 1000
          let fresh = items.filter((x) => !x.ts || x.ts >= cutoff).sort((a, b) => b.ts - a.ts)
          if (kw) fresh = fresh.filter((x) => String(x.title).includes(kw))
          if (!fresh.length) return { ok: false, message: kw ? `今天没有跟「${kw}」有关的新闻` : '今天还没抓到新新闻' }
          const lines = fresh.slice(0, n).map((x, i) => {
            const t = x.ts ? new Date(x.ts) : null
            const hm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} ` : ''
            return `${i + 1}. ${hm}${x.title}（${x.source || '来源未知'}）`
          })
          const srcs = [...new Set(fresh.map((x) => x.source).filter(Boolean))].join('、')
          return { ok: true, message: `今天 ${todayLabel()}（共抓到 ${fresh.length} 条，来自 ${srcs || '单一来源'}，给你最新的 ${lines.length} 条）：\n${lines.join('\n')}` }
        },
      })
    })

    // 启动后先自己查一次：原来只能等 5 分钟一班的定时器，重启后要干等最多 5 分钟
    // 才可能收到晚报（2026-11-08 用户重启后以为又坏了）。这里 8 秒后先跑一遍，
    // 今天已经发过的话 state.lastDay 会拦住，不会重复发。
    setTimeout(() => { checkDue().catch((error) => api.log.warn('[morning] 启动自检出错：', error.message)) }, 8000)

    api.command({
      name: '晚报',
      aliases: ['morning'],
      desc: '立刻生成一份晚报（不用等到点）',
      run: async () => {
        const r = await build(true)
        return r.ok ? `晚报已发出（候选 ${r.total} 条）` : r.message
      },
    })
  },
}
