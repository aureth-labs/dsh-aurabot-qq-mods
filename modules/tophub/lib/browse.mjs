// 逛热榜循环：定时到点 → 挑榜 → 拉榜 → 让她读榜给感想 → 私聊分享 + 写记忆。
// 完全对照 B 站 duty.js 的三段式（选→看→产出），但纯读不写：不评论、不发帖，只在私聊里分享。
// 所有外部依赖（think/sendText/memory/fetcher）都从参数注入，测试好假。

import { readFileSync, writeFileSync } from 'node:fs'

const STATE_FILE = 'state.json'
const SEEN_FILE = 'seen.json'

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}
function saveJson(path, data) {
  try { writeFileSync(path, JSON.stringify(data)) } catch { /* 状态存不上就当没记住，不致命 */ }
}
/** 简单指纹：标题去掉空白取 hash，识别「这条之前分享过没」 */
function fp(title) {
  const s = String(title || '').replace(/\s+/g, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0
  return String(h)
}
/** 从模型输出里抠 JSON 数组（容错：带 ```json 围栏、前后废话都能取） */
function parseLlmJson(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

/**
 * @param {object} o
 * @param {object} o.api        模块 api（用 dataDir/every/log/settings；有 proactive 时优先走它发分享）
 * @param {object} o.fetcher    lib/fetch.mjs 的 createFetcher 产物
 * @param {object} o.memory     api.lazy('memory')（可缺）
 * @param {string} o.ownerQQ    主人 QQ
 * @param {Function} o.think    api.think（runSystemTurn 包装，这轮不发聊天）
 * @param {Function} o.sendText api.sendText（兜底通道；被拦/失败返回 null）
 * @param {object} [o.now]      注入当前时间（测试用），缺省 () => new Date()
 */
export function createBrowse({ api, fetcher, memory, ownerQQ, think, sendText, now = () => new Date() }) {
  const statePath = api.dataDir(STATE_FILE)
  const seenPath = api.dataDir(SEEN_FILE)
  const state = loadJson(statePath, { slots: {}, recent: [], lastTour: 0 })
  const seen = loadJson(seenPath, [])
  const seenSet = new Set(seen)
  let touring = false

  function save() { saveJson(statePath, state); saveJson(seenPath, seen.slice(-2000)) }

  const cfg = () => api.settings?.() || {}

  /**
   * 把一条分享发到主人私聊。宿主提供 api.proactive（出站治理面）且档位开到 broker 时，
   * 走 proactive.submit 把这条提交进统一账本；旧主仓没有这个面、档位不支持（state='unsupported'）、
   * 或压根没给投递单号时，退回原来的 sendText 直发。
   * 返回「确认发出」的真假：被拦（sendText 被拦/失败返回 null）或抛错都是假——
   * 调用方只能据此决定要不要记 seen（设计稿 §1.4：不许无视返回值无条件记账）。
   */
  async function deliverShare({ text, itemId }) {
    const to = `private:${ownerQQ}`
    const proactive = api.proactive
    // 试运行只记日志：别把「本来要发」的东西真提交进宿主账本（账本可能会真投递）
    const dryRun = Boolean(api.config?.()?.dryRun)
    if (!dryRun && proactive?.submit) {
      try {
        const r = await proactive.submit({ itemId, to, channel: 'qq', text })
        // 只有真的拿到投递单号才算进了账本；老宿主 / 非 broker 档位会明确回 unsupported + 空单号
        if (r && r.deliveryId !== null && r.deliveryId !== undefined && r.state !== 'unsupported') {
          // sent/sending/pending 算已受理（后续由账本负责投递）；被丢弃、失败、过期、状态不确定的都不算发出
          return ['sent', 'sending', 'pending'].includes(String(r.state || ''))
        }
      } catch (e) {
        // proactive 自己出错不能连累巡游：退回老通道，下次再看
        api.log?.warn?.(`热榜分享经 api.proactive 提交失败，回退直发：${e?.message || e}`)
      }
    }
    try {
      const sent = await sendText(to, text)
      return Boolean(sent)   // 铁律：旧调用口被拦/失败返回 null，不能当真
    } catch (e) {
      api.log?.warn?.(`热榜分享直发失败：${e?.message || e}`)
      return false
    }
  }

  /** 「09:30,21:00」→ ['09:30','21:00']，脏值全部丢掉 */
  function slots() {
    return String(cfg().tourTimes || '')
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
  }

  /** 每 60 秒 tick 一次：到点没做过今天的这个场次就逛一轮 */
  async function tick() {
    const c = cfg()
    if (!c.enabled || touring) return
    const d = now()
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    for (const s of slots()) {
      const key = `${day} ${s}`
      if (state.slots[key]) continue
      if (hm < s) continue           // 还没到点
      state.slots[key] = { startedAt: Date.now() }   // 先记账再逛，失败也不当天重试
      save()
      await tour().catch((e) => api.log?.warn?.(`逛热榜这轮出了岔子：${e.message}`))
      return                          // 一次 tick 只逛一场
    }
    // 槽位记账只留最近 7 天，别无限涨
    const keys = Object.keys(state.slots)
    if (keys.length > 40) {
      for (const k of keys.slice(0, keys.length - 20)) delete state.slots[k]
      save()
    }
  }

  /**
   * 逛一轮。force=true 跳过场次判断（面板手动跑、工具触发都走这里）。
   * 返回 { ok, message, ... } 给面板/工具展示。
   */
  async function tour(o = {}) {
    if (touring) return { ok: false, message: '上一轮还没逛完' }
    touring = true
    try {
      const c = cfg()

      // 读榜：按候选顺序逐个试，攒够 count 个成功的就停——个别榜死了换替补，不整轮报废
      const count = Math.max(1, Number(cfg().nodesPerTour) || 2)
      const candidates = await pickCandidates(o.nodes, count)
      const boards = []
      for (const name of candidates) {
        if (boards.length >= count) break
        const r = await fetcher.hot(name, { fresh: o.fresh })
        if (r.ok) boards.push({ node: name, items: r.items.slice(0, cfg().itemsPerNode || 15) })
        else api.log?.warn?.(`榜「${name}」这轮取不到，换下一个：${r.error}`)
      }
      if (!boards.length) return { ok: false, message: '榜都拉不下来（网络或接口问题）' }

      const about = memory?.recall?.('主人喜欢什么', { limit: 3 }) || []
      const recentText = state.recent.map((t) => '- ' + t).join('\n') || '（暂无）'
      const feed = boards.map((b) =>
        `【${b.node}】\n` + b.items.map((it, i) => `${i + 1}. ${it.title}${it.hot ? `（热度${it.hot}）` : ''}`).join('\n')
      ).join('\n\n')
      let out = ''
      let thinkError = ''
      try {
        out = await think(
          `你在逛全网热榜，不是聊天，这轮的产出不会自动发出去。你感兴趣的按你自己的性子来，也想想主人会喜欢什么。\n` +
          `你记得的关于主人的事：\n${about.map((x) => '- ' + (x.text || x)).join('\n') || '（暂无）'}\n` +
          `最近逛过的榜：\n${recentText}\n\n` +
          `今天的热榜：\n${feed}\n\n` +
          `看完给感想。输出 JSON 数组，每个榜一个对象：` +
          `{"node":"榜名","feeling":"一句你的真实感受","share":"想私聊分享给主人的话（挑主人可能感兴趣的 1~3 条热点，说人话、别像播报，觉得没什么可分享就空字符串）","remember":"值得记住的一件事（没有就空字符串）"}。` +
          `只输出 JSON。`,
          { title: '逛热榜', timeoutMs: 180000 }
        )
      } catch (e) {
        // 模型这轮挂了（限流/超时）不能连累「逛过」这件事：榜是真拉到了，记录照写
        thinkError = e?.message || String(e)
        api.log?.warn?.(`逛热榜：模型这轮没回话（${thinkError}），先把逛到的记下来`)
      }
      const verdicts = parseLlmJson(out)
      const feelings = (verdicts || []).map((v) => String(v?.feeling || '').trim()).filter(Boolean)
      if (!verdicts?.length) {
        // 模型没给出可用感想也算逛过了：照常记账 + 写经历，只是没有分享
        recordTour(boards, [], '')
        return {
          ok: false,
          message: thinkError
            ? `榜拉到了（${boards.map((b) => b.node).join('、')}），但模型这轮没回话：${thinkError}。已记入记录`
            : '逛完了但她没给出可用的感想（输出不是 JSON），已记入记录',
        }
      }

      // 产出：分享（去重 + 限量）、记忆
      const limit = Math.max(0, Number(c.shareLimit) || 0)
      let shared = 0, remembered = 0
      const sharedList = []
      for (const v of verdicts) {
        if (!v || typeof v !== 'object') continue
        if (v.remember && remembered < 3) {
          memory?.add?.({ text: `热榜上看到：${String(v.remember).slice(0, 200)}`, importance: 0.5, tags: ['热榜'], source: 'tophub' })
          remembered++
        }
        const share = String(v.share || '').trim()
        if (share && shared < limit) {
          // 同一条（榜名+感想+要说的话）的稳定指纹既做去重键，也做账本里的 itemId
          const id = fp(v.feeling + share)
          if (seenSet.has(id)) continue
          const src = boards.find((b) => b.node === v.node)
          const head = src?.items?.slice(0, 3).map((x) => x.title).join('、') || ''
          // 必须先确认真发出去了再记 seen：被拦/失败的不记账，下一场还有机会再分享
          // （设计稿 §1.4 点名的迁移项——旧代码无视 sendText 返回值无条件记 seen）
          const ok = await deliverShare({
            itemId: `tophub:${id}`,
            text: `${share}${head ? `\n（${v.node}：${head}）` : ''}`,
          })
          if (!ok) continue
          seenSet.add(id)
          seen.push(id)
          shared++
          sharedList.push({ node: v.node, text: share })
        }
      }

      recordTour(boards, sharedList, feelings.join('；'))

      const msg = `逛了 ${boards.length} 个榜（${boards.map((b) => b.node).join('、')}），分享给你 ${shared} 条${remembered ? `，记了 ${remembered} 件事` : ''}`
      api.log?.info?.('热榜巡游：' + msg)
      return { ok: true, message: msg, boards: boards.map((b) => b.node), shared, remembered }
    } finally {
      touring = false
    }
  }

  /**
   * 每轮必做的两件收尾（照 bili 的规矩：看过的都记成ta的经历）：
   * ① 巡游历史落盘（面板「记录」区翻得到）；② 写一条经历进记忆库——
   * 不依赖模型给不给 remember 字段，只要真逛了就写。
   */
  function recordTour(boards, sharedList, feeling) {
    const at = Date.now()
    state.lastTour = at
    state.recent = boards.map((b) => b.node)
    state.history = [
      { at, boards: boards.map((b) => b.node), tops: boards.map((b) => ({ node: b.node, titles: b.items.slice(0, 5).map((x) => x.title) })), shared: sharedList, feeling: String(feeling || '').slice(0, 300) },
      ...(state.history || []),
    ].slice(0, 50)   // 只留最近 50 轮，别无限涨
    save()
    const summary = `热榜巡游：逛了${boards.map((b) => b.node).join('、')}，看到的热点有${boards.flatMap((b) => b.items.slice(0, 3).map((x) => x.title)).slice(0, 6).join('、')}${feeling ? `。我的感受：${feeling}` : ''}`
    memory?.add?.({ text: summary.slice(0, 400), importance: 0.45, tags: ['热榜', '巡游'], source: 'tophub' })
  }

  /** 候选榜顺序：优先没最近逛过的，再排逛过的兜底；多备 3 个替补（2 个替补不够顶 60s 接口抽风） */
  async function pickCandidates(prefer, count) {
    const all = (Array.isArray(prefer) && prefer.length ? prefer : []).filter(Boolean)
    const names = all.length ? all : fetcher.nodes().map((x) => x.name)
    const freshOnes = names.filter((n) => !state.recent.includes(n))
    return [...freshOnes, ...names.filter((n) => !freshOnes.includes(n))].slice(0, count + 3)
  }

  /** 巡游历史（面板「记录」区用） */
  function history() { return state.history || [] }

  /** 面板 /state 用 */
  function status() {
    return {
      slots: state.slots, recent: state.recent, lastTour: state.lastTour,
      seenCount: seenSet.size, touring, todaySlots: slots(),
    }
  }

  return { tick, tour, status, history, slots }
}
