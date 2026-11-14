// 观点：她自己的看法。
//   人格 → 怎么说话
//   记忆 → 发生过什么
//   观点 → 她信什么、会坚持什么
//
// 匹配：本地向量召回 + 模型重排，不用关键词。
// 两级：核心（三观，≤12 条，语气「一向认为」）/ 普通（可改，语气「目前觉得」，≤80 条）。
// 边界：新增时向量去重（>0.9 合并）、同主题 ≤8 条、超出普通上限归档最久没用的。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12)

function cosine(a, b) {
  let d = 0
  let x = 0
  let y = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  if (!x || !y) return 0
  return d / Math.sqrt(x * y)
}

const isLive = (x) => (x.status || 'active') === 'active'

export default {
  id: 'beliefs',
  name: '观点',
  version: '1.0.0',
  api: 1,
  description: '核心（三观）与普通两级；向量召回+模型重排；有数量上限与去重',
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'maxInject', label: '每轮最多带几条', type: 'number', min: 0, max: 4, step: 1 },
    { key: 'threshold', label: '相似度门槛', type: 'number', min: 0.3, max: 0.95, step: 0.01, hint: '重排关闭或失败时，低于它不带' },
    { key: 'recallFloor', label: '召回底线', type: 'number', min: 0.2, max: 0.9, step: 0.01, hint: '放进重排候选的最低相似度' },
    { key: 'corePerTurn', label: '每轮最多带几条核心', type: 'number', min: 0, max: 2, step: 1 },
    { key: 'maxCore', label: '核心观点上限', type: 'number', min: 1, max: 30, step: 1 },
    { key: 'maxActive', label: '普通观点上限', type: 'number', min: 10, max: 500, step: 10 },
    { key: 'maxPerTopic', label: '同主题上限', type: 'number', min: 1, max: 30, step: 1 },
    { key: 'rerank', label: '用模型重排', type: 'switch', hint: '关掉就只按相似度，会变噪' },
  ],

  setup(api) {
    // 向量服务跟随记忆模块（同一套 /v1 嵌入服务），这边不再单独配置
    const vectorCfg = () => {
      const mv = (api.config().memory && api.config().memory.vector) || {}
      return {
        baseUrl: String(mv.baseUrl || 'http://127.0.0.1:11434/v1'),
        model: String(mv.model || 'bge-m3'),
        shared: Boolean(mv.baseUrl && mv.model),
      }
    }

    const cfg = () => ({
      enabled: true,
      maxInject: 2,
      threshold: 0.7,
      corePerTurn: 1,
      maxCore: 12,
      maxActive: 80,
      maxPerTopic: 8,
      rerank: true,
      recallFloor: 0.45,
      ...(api.settings() || {}),
      ...vectorCfg(),
    })

    // 把默认值写进配置：设置页的输入框才会显示默认值，而不是空着
    const DEFAULTS = {
      enabled: true, maxInject: 2, threshold: 0.7, corePerTurn: 1,
      maxCore: 12, maxActive: 80, maxPerTopic: 8, rerank: true,
      recallFloor: 0.45,
    }
    try {
      const cur = api.settings() || {}
      if (Object.keys(DEFAULTS).some((k) => cur[k] === undefined)) {
        api.saveSettings({ ...DEFAULTS, ...cur })
        api.log.info('观点：已把默认参数写入配置')
      }
    } catch (error) { api.log.warn('写默认参数失败：', error.message) }
    const bfile = () => join(api.dataDir(), 'beliefs.json')
    const vfile = () => join(api.dataDir(), 'vectors.json')

    const load = () => {
      try {
        const s = JSON.parse(readFileSync(bfile(), 'utf8'))
        return { items: Array.isArray(s.items) ? s.items : [] }
      } catch (error) { return { items: [] } }
    }
    const save = (s) => { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(bfile(), JSON.stringify(s, null, 2)) }
    const loadV = () => {
      try {
        const s = JSON.parse(readFileSync(vfile(), 'utf8'))
        return { model: s.model || '', dims: s.dims || 0, map: s.map || {} }
      } catch (error) { return { model: '', dims: 0, map: {} } }
    }
    const saveV = (v) => { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(vfile(), JSON.stringify(v)) }

    const live = () => load().items.filter(isLive)

    // ---------- 向量 ----------
    async function embed(texts, timeoutMs = 15_000) {
      const c = cfg()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const r = await fetch(String(c.baseUrl).replace(/\/$/, '') + '/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: c.model, input: texts }),
          signal: ctrl.signal,
        })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        return (j.data || []).map((d) => d.embedding)
      } finally { clearTimeout(timer) }
    }

    let building = null
    async function ensureVectors() {
      const c = cfg()
      const list = live()
      const store = loadV()
      const stale = store.model !== c.model
      const need = list.filter((b) => stale || !store.map[b.id] || store.map[b.id].h !== hash(b.text))
      if (!need.length) return { ok: true, indexed: Object.keys(store.map).length, added: 0 }
      if (building) return building
      building = (async () => {
        const map = stale ? {} : { ...store.map }
        for (let i = 0; i < need.length; i += 16) {
          const chunk = need.slice(i, i + 16)
          try {
            const vs = await embed(chunk.map((b) => b.text + ' ' + (b.topic || '')))
            chunk.forEach((b, k) => { if (vs[k]) map[b.id] = { h: hash(b.text), v: vs[k] } })
          } catch (error) {
            api.log.warn('观点向量化失败：', error.message)
            break
          }
        }
        const dims = Object.values(map).find((x) => x && x.v)?.v?.length || 0
        saveV({ model: c.model, dims, map })
        return { ok: true, indexed: Object.keys(map).length, added: need.length }
      })()
      try { return await building } finally { building = null }
    }

    const qCache = new Map()
    async function queryVector(text) {
      const key = String(text || '').slice(0, 400)
      const hit = qCache.get(key)
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v
      const [v] = await embed([key], 8000)
      if (v) {
        qCache.set(key, { v, at: Date.now() })
        if (qCache.size > 200) qCache.delete(qCache.keys().next().value)
      }
      return v || null
    }

    // ---------- 观点 ----------
    async function add({ text, topic = '', confidence = 0.5, core = false, sources = [] }) {
      const c = cfg()
      const t = String(text || '').trim().slice(0, 60)
      if (!t) return { refused: 'empty' }
      const s = load()
      const same = s.items.find((x) => isLive(x) && x.text === t)
      if (same) {
        same.confidence = Math.min(0.95, Math.max(same.confidence || 0, confidence) + 0.03)
        same.lastConfirmed = Date.now()
        if (core) same.core = true
        save(s)
        return { item: same, merged: true }
      }

      // 向量去重：太像的直接合并
      try {
        const store = loadV()
        if (store.dims && Object.keys(store.map).length) {
          const [nv] = await embed([t + ' ' + (topic || '')])
          if (nv) {
            let best = null
            let bestSim = 0
            for (const x of s.items) {
              if (!isLive(x)) continue
              const e = store.map[x.id]
              if (!e || !e.v) continue
              const sim = cosine(nv, e.v)
              if (sim > bestSim) { bestSim = sim; best = x }
            }
            if (best && bestSim >= 0.9) {
              best.confidence = Math.min(0.95, (best.confidence || 0.5) + 0.03)
              best.lastConfirmed = Date.now()
              if (core) best.core = true
              save(s)
              return { item: best, merged: true, sim: Number(bestSim.toFixed(3)) }
            }
          }
        }
      } catch (error) { api.log.debug?.('观点去重跳过：', error.message) }

      const liveItems = s.items.filter(isLive)
      const coreCount = liveItems.filter((x) => x.core).length
      if (core && coreCount >= Number(c.maxCore)) return { refused: 'core-limit', count: coreCount }
      if (topic) {
        const n = liveItems.filter((x) => x.topic === topic).length
        if (n >= Number(c.maxPerTopic)) return { refused: 'topic-limit', topic, count: n }
      }

      const item = {
        id: 'b_' + Math.random().toString(36).slice(2, 8),
        text: t,
        topic: String(topic || '').slice(0, 12),
        confidence: Math.max(0, Math.min(0.95, confidence)),
        core: Boolean(core),
        sources: sources.slice(-10),
        formedAt: Date.now(),
        lastConfirmed: Date.now(),
        lastUsed: 0,
        status: 'active',
        revisions: [],
      }
      s.items.push(item)

      // 普通观点超出上限：归档最久没用的
      const normals = s.items.filter((x) => isLive(x) && !x.core)
      if (normals.length > Number(c.maxActive)) {
        normals.sort((a, b) => (a.lastUsed || a.lastConfirmed || a.formedAt || 0) - (b.lastUsed || b.lastConfirmed || b.formedAt || 0))
        const over = normals.length - Number(c.maxActive)
        for (let i = 0; i < over; i++) {
          const victim = normals[i]
          victim.status = 'archived'
          victim.archivedAt = Date.now()
        }
      }
      save(s)
      ensureVectors().catch(() => {})
      return { item }
    }

    async function remove(id) {
      const s = load()
      s.items = s.items.filter((x) => x.id !== id && x.text !== id)
      save(s)
      const v = loadV()
      delete v.map[id]
      saveV(v)
      return s.items.length
    }

    // 模型重排：向量只负责召回，是否「真的相关」交给模型判一次
    const rCache = new Map()
    async function rerank(q, cands, context) {
      const key = hash('v2|' + q + '|' + cands.map((x) => x.b.id).join(','))
      const hit = rCache.get(key)
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit.keep
      const list = cands.map((x, i) => (i + 1) + '. ' + x.b.text + (x.b.topic ? '（' + x.b.topic + '）' : '')).join('\n')
      let out = ''
      try {
        out = String(await api.ask({
          system: '对下面每一条「个人看法」，判断此刻说出来合不合适。逐条给结论，不要跳过。'
            + '先看这句话在做什么：陈述事件 / 请求 / 质问 / 吵架 / 赌气 / 撒娇 / 开玩笑 / 问该怎么办 / 讨论观点。'
            + '规则：'
            + '① 对方在吵架、质问、赌气、发泄时，讲道理和下判断的看法都不合适；安慰类、关系类可以。'
            + '② 话题不同就不合适——只是字面像、都带某个常见的词，不算。'
            + '③ 这句话已经完整表达了这条看法（几乎同义）就不合适；只是提到相关的事、需要看法来评判，合适。'
            + '④ 对方在问「该怎么办 / 你怎么看」时，她在同类事情上的一贯原则就算合适，哪怕不完全对应具体情形。'
            + '输出 JSON 数组，每条一个对象：{"i":序号,"ok":true或false,"why":"五个字以内"}。必须覆盖每一条。',
          text: (context ? '最近几轮：\n' + context + '\n\n' : '') + '这句话：' + q + '\n\n看法：\n' + list,
          maxTokens: 300,
          temperature: 0,
        }))
      } catch (error) {
        api.log.debug?.('观点重排失败，退回阈值判断：', error.message)
        return null
      }
      const arr = []
      for (const mm of out.matchAll(/\{[^{}]*\}/g)) {
        try {
          const o = JSON.parse(mm[0])
          if (o && o.ok === true && Number.isInteger(Number(o.i))) arr.push(Number(o.i) - 1)
        } catch (error) { /* 跳过坏对象 */ }
      }
      const keep = arr.filter((n) => n >= 0 && n < cands.length)
      rCache.set(key, { keep, at: Date.now() })
      if (rCache.size > 200) rCache.delete(rCache.keys().next().value)
      return keep
    }

    async function match(text, context = '') {
      const c = cfg()
      if (!c.enabled) return []
      const q = String(text || '').trim()
      if (q.length < 2) return []
      try {
        await ensureVectors()
        const store = loadV()
        if (!store.dims || store.model !== c.model) return []
        const qv = await queryVector(q)
        if (!qv) return []
        const cands = []
        for (const b of live()) {
          const e = store.map[b.id]
          if (!e || !e.v) continue
          const sim = cosine(qv, e.v)
          if (sim < Number(c.recallFloor ?? 0.45)) continue
          cands.push({ b, sim: sim + (b.core ? 0.01 : 0) })
        }
        cands.sort((x, y) => y.sim - x.sim)
        const top = cands.slice(0, 5)
        if (!top.length) return []

        let keep = null
        if (c.rerank !== false) keep = await rerank(q, top, context)
        const picked = keep === null ? top.filter((x) => x.sim >= Number(c.threshold)) : top.filter((x, i) => keep.includes(i))

        const out = []
        let coreCount = 0
        for (const x of picked) {
          if (out.length >= Number(c.maxInject)) break
          if (x.b.core) {
            if (coreCount >= Number(c.corePerTurn)) continue
            coreCount++
          }
          out.push({ ...x.b, sim: Number(x.sim.toFixed(3)) })
        }
        // 记一下被用到的
        if (out.length) {
          const s = load()
          for (const o of out) {
            const it = s.items.find((x) => x.id === o.id)
            if (it) { it.lastUsed = Date.now(); it.usedCount = (it.usedCount || 0) + 1 }
          }
          save(s)
        }
        return out
      } catch (error) {
        api.log.warn('观点匹配跳过：', error.message)
        return []
      }
    }

    /** 核心用「一向认为」，普通用「目前觉得」，短句，不解释。 */
    function hintOf(list) {
      if (!list.length) return ''
      const core = list.filter((b) => b.core).map((b) => b.text)
      const normal = list.filter((b) => !b.core).map((b) => b.text)
      const parts = []
      if (core.length) parts.push('你一向认为：' + core.join('；') + '。这点你不太会改。')
      if (normal.length) parts.push('你目前觉得：' + normal.join('；') + '。')
      return '（' + parts.join(' ') + '）'
    }

    async function derive(count = 3) {
      let items = []
      try {
        const mem = api.use('memory')
        items = mem && typeof mem.list === 'function' ? mem.list('').slice(0, 40) : []
      } catch (error) { /* 记忆没开 */ }
      if (!items.length) return { ok: false, message: '拿不到记忆' }
      let out = ''
      try {
        const askOnce = () => api.ask({
          system: '你在帮一个角色从她的经历里形成「看法」。只收三种：'
            + '① 价值判断（什么值得、什么不能忍）；② 关系和相处（怎么对人、别人怎么对我）；③ 对自己的认识（我是什么样、我要什么）。'
            + '不收：知识、技巧、方法、愿望（想去哪、想吃啥）、对别人行为的观察、对某件事的评论。'
            + '例：看了运镜教程 → 不收「把摄像机当无人机想」（那是技巧）；'
            + '例：听说有人流量大不带货 → 不收「流量最大不变现很难得」（那是对别人的观察），除非她因此形成了自己的判断。'
            + '规则：① 句子必须能独立成立，不能出现具体人名，也不能有 他/她/这次/那天/刚才/这件事 这类指代；'
            + '② 每条 20 字以内，第一人称，可以省略「我」；'
            + '③ 宁可只给 1 条，也不要凑数；'
            + '④ 置信度给 0.4~0.6。'
            + '输出 JSON 数组：[{"text":"…","topic":"两个字","confidence":0.5}]，撑不住输出 []。',
          text: items.map((m) => '- ' + m.text).join('\n'),
          maxTokens: 900,
          temperature: 0.4,
        })
        for (let i = 0; i < 2 && !out; i++) {
          out = String(await askOnce()).trim()
          if (!out) await new Promise((r) => setTimeout(r, 800))
        }
      } catch (error) { return { ok: false, message: '模型调用失败' } }
      let list = []
      const m = out.match(/\[[\s\S]*\]/)
      if (m) {
        try { list = JSON.parse(m[0]) } catch (error) { list = [] }
      }
      if (!Array.isArray(list) || !list.length) {
        // 输出被截断时，逐个抠对象
        for (const mm of out.matchAll(/\{[^{}]*"text"[^{}]*\}/g)) {
          try { list.push(JSON.parse(mm[0])) } catch (error) { /* 跳过坏的 */ }
        }
      }
      if (!Array.isArray(list) || !list.length) return { ok: false, message: '模型没给出可用的观点' }
      let added = 0
      let merged = 0
      let refused = 0
      for (const x of (Array.isArray(list) ? list : []).slice(0, count)) {
        if (!x || !x.text) continue
        const txt = String(x.text).trim()
        // 后置过滤：带具体指代、太长、像事件评论的，一律不要
        if (/他|她|这次|那天|刚才|这件事|这句话|行吧|真会|到位|教程|技巧|方法|镜头|摄像机|想去|想吃|想喝|想要|好想/.test(txt)) { refused++; continue }
        if (txt.length > 26) { refused++; continue }
        const conf = Math.min(0.6, Number(x.confidence) || 0.5)
        const r = await add({ text: txt, topic: x.topic || '', confidence: conf, sources: items.slice(0, 8).map((i) => i.id) })
        if (r.item) { if (r.merged) merged++; else added++ } else refused++
      }
      return { ok: true, added, merged, refused, total: live().length }
    }

    api.on('prompt', async (content, info) => {
      if (!cfg().enabled) return content
      const q = (info && (info.queryText || info.userText)) || ''
      const pre = (info && info.prevText) || ''
      const list = await match(q, pre)
      if (!list.length) return content
      return [{ type: 'text', text: hintOf(list) }, ...(Array.isArray(content) ? content : [])]
    })

    api.route('/list', async () => {
      const v = loadV()
      const c = cfg()
      const items = load().items
      return {
        ok: true,
        items: items.filter(isLive).map((b) => ({ ...b, indexed: Boolean(v.map[b.id]) })),
        archived: items.filter((x) => x.status === 'archived').length,
        model: v.model,
        dims: v.dims,
        vector: { baseUrl: c.baseUrl, model: c.model, shared: c.shared },
        caps: { core: Number(c.maxCore), normal: Number(c.maxActive), perTopic: Number(c.maxPerTopic) },
      }
    })
    api.route('/add', async (req) => {
      const b = await api.core.http.body(req)
      const r = await add({ text: b.text, topic: b.topic, confidence: Number(b.confidence) || 0.5, core: Boolean(b.core) })
      if (r.refused === 'core-limit') return { ok: false, message: '核心观点已经到上限了，先删一条' }
      if (r.refused === 'topic-limit') return { ok: false, message: '这个主题到上限了（' + r.topic + '）' }
      if (r.refused) return { ok: false, message: '内容不能为空' }
      return { ok: true, item: r.item, merged: Boolean(r.merged) }
    })
    api.route('/del', async (req) => {
      const b = await api.core.http.body(req)
      return { ok: true, left: await remove(String(b.id || '')) }
    })
    api.route('/match', async (req) => {
      const q = api.core.http.query(req).q || ''
      return { ok: true, items: await match(q) }
    })
    api.route('/config', async () => ({ ok: true, config: cfg() }))
    api.route('/reindex', async () => ({ ...(await ensureVectors()) }))
    api.route('/derive', async () => ({ ...(await derive()) }))
    api.route('/seed', async () => {
      const seeds = [
        ['不骗人，骗一次就再也信不回来了', '原则'],
        ['别人怎么对我，我就怎么对别人', '原则'],
        ['喜欢的东西要自己护着，指望别人没用', '原则'],
        ['人得有自己的钱，伸手要的感觉很难受', '钱'],
        ['答应的事要做到，做不到就早点说', '承诺'],
        ['吵架可以，但别翻旧账', '关系'],
        ['对不熟的人客气是礼貌，不代表亲近', '社交'],
        ['不想做的事直接说不，比拖着强', '边界'],
      ]
      let added = 0
      let merged = 0
      for (const [text, topic] of seeds) {
        const r = await add({ text, topic, confidence: 0.85, core: true })
        if (r.item) { if (r.merged) merged++; else added++ }
      }
      return { ok: true, added, merged, total: live().length }
    })
  },
}
