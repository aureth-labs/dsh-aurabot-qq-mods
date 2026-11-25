// 订阅状态与阅读节流：已读去重、条目兴趣粗筛、每日投喂额度。
// 纯逻辑 + 一个落盘 JSON（路径由调用方给，数据进 api.dataDir()，模块源码目录不写任何东西）。
//
// 设计要点（对齐 docs/OUTBOUND-POLICY-DESIGN.md 的素材口语义）：
//   · 这个模块只负责「发生了什么、什么值得说」——挑哪些条目值得交给她；
//   · 发不发、何时发、什么口吻全交给主动发言决策层（目的引擎 / 出站策略），本模块不自己发私聊；
//   · 已读账本按条目去重键推进，同一件事不会反复喂。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const STATE_VERSION = 1
const MAX_SEEN = 3000

/** 好奇/技术/生活向的关键词打分：只是粗筛「她可能想聊」，真正决策在引擎。 */
const INTEREST_WORDS = [
  // 技术 / AI / 工具
  ['ai', 3], ['人工智能', 3], ['大模型', 3], ['插件', 3], ['开源', 2], ['编程', 2], ['代码', 2],
  ['deepseek', 3], ['harness', 2], ['算法', 2], ['芯片', 2], ['机器人', 2], ['软件', 1], ['工具', 2],
  // 游戏 / 二次元
  ['游戏', 3], ['steam', 3], ['switch', 2], ['主机', 2], ['手游', 2], ['抽卡', 2], ['新番', 2],
  ['动画', 2], ['漫画', 2], ['手办', 2], ['cosplay', 2], ['二次元', 2],
  // 动物 / 可爱 / 治愈
  ['猫', 2], ['狗', 2], ['鲸', 2], ['可爱', 2], ['治愈', 2], ['萌', 2],
  // 科技新闻与生活
  ['发布', 1], ['更新', 1], ['开源项目', 2], ['研究', 1], ['发现', 1], ['新品', 1],
  ['电影', 1], ['音乐', 1], ['美食', 1], ['旅行', 1], ['科普', 2], ['教程', 2],
]

export function createStateStore(file) {
  let state = null
  const defaults = () => ({
    version: STATE_VERSION,
    seen: [],            // 已读条目去重键（最新在后）
    day: '',             // 当前统计日（YYYY-MM-DD）
    sentToday: 0,        // 今日已投喂条数（受 dailyMax 约束）
    lastFetchAt: 0,      // 上次拉取时间（退避用）
    failures: {},        // 每个源连续失败次数（{ url: n }）
    nextRetryAt: {},     // 每个源下次允许重试时间
    stats: { fetched: 0, skipped: 0, fed: 0 },
  })

  function load() {
    if (state) return state
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      state = { ...defaults(), ...(raw && typeof raw === 'object' ? raw : {}) }
      if (!Array.isArray(state.seen)) state.seen = []
      if (!state.failures || typeof state.failures !== 'object') state.failures = {}
      if (!state.nextRetryAt || typeof state.nextRetryAt !== 'object') state.nextRetryAt = {}
      if (!state.stats || typeof state.stats !== 'object') state.stats = defaults().stats
    } catch {
      state = defaults() // 坏文件当首次运行，不抛
    }
    return state
  }

  function save() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(load(), null, 2))
      return true
    } catch {
      return false // 落盘失败不影响本次运行（内存态仍在）
    }
  }

  const dayKey = (at = Date.now()) => {
    const d = new Date(at)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** 跨天重置今日计数。 */
  function ensureDay(at = Date.now()) {
    const s = load()
    const d = dayKey(at)
    if (s.day !== d) {
      s.day = d
      s.sentToday = 0
    }
    return s
  }

  return {
    file,
    get: load,
    save,
    ensureDay,
    dayKey,
    /** 已读去重键集合（Set，便于 O(1) 查）。 */
    seenSet() {
      const s = load()
      return new Set(s.seen)
    },
    /** 记一批已读；超上限从最旧裁掉。 */
    markSeen(keys) {
      const s = load()
      const seen = new Set(s.seen)
      for (const k of keys || []) if (k) seen.add(String(k))
      s.seen = [...seen].slice(-MAX_SEEN)
      return s
    },
    /** 今日额度还剩多少（dailyMax=0 视为不限，返回 Infinity）。 */
    remainingToday(dailyMax, at = Date.now()) {
      const s = ensureDay(at)
      if (!(Number(dailyMax) > 0)) return Infinity
      return Math.max(0, Number(dailyMax) - Number(s.sentToday || 0))
    },
    /** 记一次投喂（不是「发出去」——投喂给引擎也算占用当日额度，避免一口气塞满素材池）。 */
    countFed(n = 1, at = Date.now()) {
      const s = ensureDay(at)
      s.sentToday = Math.max(0, (Number(s.sentToday) || 0) + Math.max(0, Number(n) || 0))
      s.stats.fed = (Number(s.stats.fed) || 0) + Math.max(0, Number(n) || 0)
      return s
    },
    /** 失败退避：连续失败按 2^n 分钟封顶 6 小时；没失败过返回 minutes=0。 */
    backoffFor(url, now = Date.now()) {
      const s = load()
      const n = Math.min(8, Number(s.failures[url]) || 0)
      if (!n) return { until: 0, minutes: 0, now }
      const minutes = Math.min(6 * 60, Math.pow(2, n))
      return { until: (Number(s.nextRetryAt[url]) || 0), minutes, now }
    },
    recordFailure(url, at = Date.now()) {
      const s = load()
      s.failures[url] = Math.min(8, (Number(s.failures[url]) || 0) + 1)
      s.nextRetryAt[url] = at + Math.min(6 * 60, Math.pow(2, s.failures[url])) * 60_000
      s.stats.fetched = Number(s.stats.fetched) || 0
      return s
    },
    recordSuccess(url) {
      const s = load()
      s.failures[url] = 0
      s.nextRetryAt[url] = 0
      return s
    },
    /**
     * 条目打分：关键词命中加权 + 新鲜度加分。
     * 返回 { score, hits }；只用来排序挑「最值得聊的那几条」，不做内容判断。
     */
    scoreEntry(item, now = Date.now()) {
      const text = `${item?.title || ''} ${item?.summary || ''}`.toLowerCase()
      let score = 0
      const hits = []
      for (const [word, weight] of INTEREST_WORDS) {
        if (text.includes(word)) {
          score += weight
          hits.push(word)
        }
      }
      // 新鲜度：12 小时内的条目 +2，24 小时内 +1（旧文不硬塞）。
      const age = now - (Number(item?.at) || 0)
      if (age > 0 && age < 12 * 3600_000) score += 2
      else if (age > 0 && age < 24 * 3600_000) score += 1
      return { score, hits: hits.slice(0, 6) }
    },
    /** 面板/引擎用的轻量状态摘要（不含正文）。 */
    status() {
      const s = load()
      return {
        seenCount: s.seen.length,
        day: s.day,
        sentToday: Number(s.sentToday) || 0,
        lastFetchAt: Number(s.lastFetchAt) || 0,
        failing: Object.keys(s.failures || {}).filter((u) => Number(s.failures[u]) > 0),
        stats: { ...s.stats },
      }
    },
  }
}
