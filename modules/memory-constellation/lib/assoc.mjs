// 记忆增强（联想半）：说一个名字，顺着记忆里的「人 / 关系 / 经历 / 意思相近」把相关的事串起来。
// 不建第二套记忆库：事实只读 memories.json；被串联起来的记忆按遗忘曲线回写 hitDays/lastHit。
// 合并进「记忆中枢」，真正的提示注入走 prompt，工具 recall_associated 可以主动翻。

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
const num = (v, def, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? clamp(n, min, max) : def
}
const norm = (s) => String(s || '').trim().toLowerCase()
const percent = (v, def = 100) => clamp(Number.isFinite(Number(v)) ? Number(v) : def, 0, 100)
const COMMON = new Set(['睡觉', '吃饭', '上班', '下班', '主人', '老大', '爸', '宝', '朋友', '老师', '同学', '猫', '狗'])
const splitNames = (s) => String(s || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 12)
const splitGroups = (s) => String(s || '').split(/[;；\n]/).map((g) => splitNames(g)).filter((g) => g.length).slice(0, 12)

const EMPTY_GRAPH = { version: 4, builtAt: 0, sig: '', entities: [], mEdges: [], pEdges: [] }

export function createAssoc(api, options = {}) {
    const { memoryLine, retention } = api.lib('features/memory.js')
    const { readJson, writeJson } = api.lib('core/store.js')
    const { defineTool, str } = api.lib('tools/tools.js')
    const { http } = api.core
    const defaults = options.defaults || {}
    const file = api.dataDir('assoc.json')
    const takeoverActive = options.takeoverActive || (() => false)
    const directCount = options.directCount || (() => 4)

    // 合并后新设置放在 memory-constellation 下；旧 memory-assoc 的值作为回退，避免用户重填。
    const settings = () => {
      const current = api.settings() || {}
      const cfg = api.config?.() || {}
      const old = (cfg.ext || {})['memory-assoc'] || {}
      const raw = (cfg.ext || {})['memory-constellation'] || {}
      const merged = { ...defaults, ...old, ...current }
      // 首次合并、还没写迁移标记时，旧值优先，避免新默认值把用户旧设置顶掉。
      if (raw.assocMigrated !== true) {
        for (const key of Object.keys(defaults)) {
          if (Object.prototype.hasOwnProperty.call(old, key)) merged[key] = old[key]
        }
      }
      return merged
    }
    const assocEnabled = () => {
      const cfg = api.config?.() || {}
      const old = (cfg.ext || {})['memory-assoc'] || {}
      const raw = (cfg.ext || {})['memory-constellation'] || {}
      if (Object.prototype.hasOwnProperty.call(raw, 'assocOn')) return raw.assocOn !== false
      if (Object.prototype.hasOwnProperty.call(old, 'enabled')) return old.enabled !== false
      return true
    }
    const off = () => (api.settings()?.enabled === false) || (api.settings()?.llmOn === false) || !assocEnabled()
    const mem = () => api.use('memory') || null

    /** 当前人格名：不同用户的 bot 叫法不一样，不能写死；缓存一分钟，避免每轮读人格文件 */
    let personaAt = 0
    let personaCached = ''
    function personaName() {
      if (Date.now() - personaAt < 60_000) return personaCached
      try {
        const cur = api.config?.()?.persona?.current
        const list = api.lib('persona/personas.js')?.listPersonas?.() || []
        personaCached = (list.find((p) => p.id === cur) || {}).name || ''
      } catch (error) {
        personaCached = ''
      }
      personaAt = Date.now()
      return personaCached
    }

    /** 本实例的称呼种子：主人、人格名、用户手动补的别名/项目 */
    function seedOf() {
      const cfg = api.config?.() || {}
      const s = settings()
      const botNames = [...new Set([...splitNames(s.botNames), personaName()].filter(Boolean))]
      return {
        ownerQQ: String(cfg.ownerQQ || ''),
        ownerName: String(cfg.ownerName || ''),
        ownerAliases: splitNames(s.ownerAliases),
        botNames,
        extraEntities: splitGroups(s.extraEntities),
      }
    }

    let graph = readJson(file, () => ({ ...EMPTY_GRAPH }))
    graph = { ...EMPTY_GRAPH, ...(graph || {}) }
    let runtime = makeRuntime(graph)
    let building = false
    let lastError = ''
    const logs = []

    function itemsNow() {
      const m = mem()
      if (!m || typeof m.list !== 'function') return null
      try {
        return (m.list('') || []).filter((it) => it && it.id && it.text && !it.invalidAt)
      } catch (error) {
        return null
      }
    }

    function sigOf(items) {
      const at = items.reduce((max, it) => Math.max(max, Number(it.at) || 0), 0)
      return `${items.length}:${at}:${items[0] ? items[0].id : ''}:${items.length ? items[items.length - 1].id : ''}`
    }
    const graphSig = (items) => `${sigOf(items)}:${JSON.stringify(seedOf())}`

    function makeRuntime(g) {
      const entities = new Map((g.entities || []).map((e) => [e.key, e]))
      const owners = new Map()
      for (const e of entities.values()) {
        for (const alias of e.aliases || []) {
          const a = norm(alias)
          if (!a) continue
          if (!owners.has(a)) owners.set(a, new Set())
          owners.get(a).add(e.key)
        }
      }
      const mAdj = new Map()
      for (const e of g.mEdges || []) {
        if (!mAdj.has(e.a)) mAdj.set(e.a, [])
        if (!mAdj.has(e.b)) mAdj.set(e.b, [])
        mAdj.get(e.a).push({ b: e.b, w: e.w, kind: e.kind })
        mAdj.get(e.b).push({ b: e.a, w: e.w, kind: e.kind })
      }
      const pAdj = new Map()
      for (const e of g.pEdges || []) {
        if (!pAdj.has(e.a)) pAdj.set(e.a, [])
        if (!pAdj.has(e.b)) pAdj.set(e.b, [])
        pAdj.get(e.a).push(e)
        pAdj.get(e.b).push(e)
      }
      return { entities, owners, mAdj, pAdj }
    }

    function buildEntities(items, profiles, seed) {
      const map = new Map()
      const owners = new Map()
      const ensure = (key, name, qq) => {
        if (!map.has(key)) map.set(key, { key, name: String(name || qq || key), qq: String(qq || ''), aliases: [], items: [], core: [] })
        const ent = map.get(key)
        if (name && (!ent.name || ent.name === ent.qq)) ent.name = String(name)
        return ent
      }
      const addAlias = (alias, key) => {
        const a = norm(alias)
        if (!a) return
        if (!owners.has(a)) owners.set(a, new Set())
        owners.get(a).add(key)
        const ent = map.get(key)
        if (ent && !ent.aliases.includes(a)) ent.aliases.push(a)
      }

      // 只从配置和记忆里取称呼，不再写死某套部署的 bot/项目名
      const ownerKey = seed.ownerQQ ? `q:${seed.ownerQQ}` : `n:${norm(seed.ownerName || '主人')}`
      ensure(ownerKey, seed.ownerName || '主人', seed.ownerQQ)
      addAlias('主人', ownerKey)
      if (seed.ownerName) addAlias(seed.ownerName, ownerKey)
      for (const alias of seed.ownerAliases || []) addAlias(alias, ownerKey)

      if (seed.botNames && seed.botNames.length) {
        const botKey = `n:${norm(seed.botNames[0])}`
        ensure(botKey, seed.botNames[0], '')
        for (const alias of seed.botNames) addAlias(alias, botKey)
      }
      for (const group of seed.extraEntities || []) {
        const name = group[0]
        if (!name) continue
        const key = `n:${norm(name)}`
        ensure(key, name, '')
        for (const alias of group) addAlias(alias, key)
      }
      const strong = new Set([...(seed.ownerAliases || []), ...(seed.botNames || []), ...((seed.extraEntities || []).flat())].map(norm))

      for (const p of profiles || []) {
        if (!p || !p.qq) continue
        const key = `q:${p.qq}`
        ensure(key, p.name || String(p.qq), p.qq)
        if (p.name) addAlias(p.name, key)
      }

      // 文本里被「」/“”括起来的短词，重复出现两次以上就当名字（昵称、项目名这类）
      const quoted = new Map()
      for (const it of items) {
        for (const m of String(it.text || '').matchAll(/「([^「」]{2,10})」|“([^“”]{2,10})”/g)) {
          const alias = String(m[1] || m[2] || '').trim()
          if (alias) quoted.set(alias, (quoted.get(alias) || 0) + 1)
        }
      }
      for (const [alias, count] of quoted) {
        if (count < 2 || owners.has(norm(alias))) continue
        const key = `n:${norm(alias)}`
        ensure(key, alias, '')
        addAlias(alias, key)
      }

      for (const it of items) {
        let key = ''
        if (it.about) {
          key = `q:${it.about}`
          ensure(key, it.aboutName || String(it.about), it.about)
        } else if (it.aboutName) {
          key = `n:${norm(it.aboutName)}`
          ensure(key, it.aboutName, '')
        }
        if (!key) continue
        addAlias(it.aboutName, key)
        const ent = map.get(key)
        if (ent && !ent.items.includes(it.id)) ent.items.push(it.id)
        // core：真的标注了「关于谁」的记忆；只靠正文提到名字的算软关联
        if (ent && !ent.core.includes(it.id)) ent.core.push(it.id)
      }

      // 只有名字、没有 QQ 的实体，如果这个名字也对应一个 QQ 实体，就并到条目最多的那个
      for (const [key, ent] of [...map.entries()]) {
        if (!key.startsWith('n:')) continue
        const alias = key.slice(2)
        const set = owners.get(alias)
        if (!set) continue
        const qKeys = [...set].filter((k) => k.startsWith('q:'))
        if (!qKeys.length) continue
        const target = qKeys.sort((a, b) => ((map.get(b) || {}).items.length || 0) - ((map.get(a) || {}).items.length || 0))[0]
        const to = map.get(target)
        if (!to || target === key) continue
        for (const id of ent.items) if (!to.items.includes(id)) to.items.push(id)
        for (const id of ent.core || []) if (!to.core.includes(id)) to.core.push(id)
        for (const a of ent.aliases) addAlias(a, target)
        map.delete(key)
        for (const s of owners.values()) s.delete(key)
      }

      // 只要文本里出现了某个名字，这条记忆就属于那个实体（不只是 aboutName 标注过的）
      for (const it of items) {
        const text = norm(it.text)
        for (const [alias, set] of owners) {
          if (alias.length < 2 && !strong.has(alias)) continue
          if (!text.includes(alias)) continue
          for (const key of set) {
            const ent = map.get(key)
            if (ent && !ent.items.includes(it.id)) ent.items.push(it.id)
          }
        }
      }

      return { entities: [...map.values()], owners }
    }

    function buildMemoryEdges(items) {
      const edges = new Map()
      const put = (a, b, kind, w) => {
        if (!a || !b || a === b) return
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        const prev = edges.get(key)
        if (!prev || prev.w < w) edges.set(key, { a: a < b ? a : b, b: a < b ? b : a, kind, w: Number(w.toFixed(3)) })
      }

      let vectors = new Map()
      try {
        const m = mem()
        if (m && m.vector && typeof m.vector.all === 'function') vectors = m.vector.all()
      } catch (error) {}

      // 语义边：每条记忆最多 4 个近邻，只算已有向量的条目（最多 900 条，避免大库时卡住）
      const pool = items.filter((it) => vectors.has(it.id))
        .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || (Number(b.at) || 0) - (Number(a.at) || 0))
        .slice(0, 900)
      const neighbors = new Map()
      for (let i = 0; i < pool.length; i += 1) {
        const a = pool[i]
        const va = vectors.get(a.id)
        for (let j = i + 1; j < pool.length; j += 1) {
          const b = pool[j]
          const vb = vectors.get(b.id)
          if (!va || !vb || va.length !== vb.length) continue
          let dot = 0
          for (let d = 0; d < va.length; d += 1) dot += va[d] * vb[d]
          if (dot < 0.45) continue
          if (!neighbors.has(a.id)) neighbors.set(a.id, [])
          if (!neighbors.has(b.id)) neighbors.set(b.id, [])
          neighbors.get(a.id).push({ id: b.id, sim: dot })
          neighbors.get(b.id).push({ id: a.id, sim: dot })
        }
      }
      for (const [id, list] of neighbors) {
        list.sort((a, b) => b.sim - a.sim)
        for (const n of list.slice(0, 4)) put(id, n.id, 'semantic', n.sim)
      }

      // 标签边：同一个标签下最近 6 条，两两连一条弱边
      const tags = new Map()
      for (const it of items) {
        for (const tag of (Array.isArray(it.tags) ? it.tags : []).slice(0, 5)) {
          const t = String(tag || '').trim()
          if (!t) continue
          if (!tags.has(t)) tags.set(t, [])
          tags.get(t).push(it)
        }
      }
      for (const list of tags.values()) {
        const top = list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 6)
        for (let i = 0; i < top.length; i += 1) {
          for (let j = i + 1; j < top.length; j += 1) put(top[i].id, top[j].id, 'tag', 0.55)
        }
      }

      // 每个节点最多 6 条边，按权重保留
      const degree = new Map()
      const out = []
      for (const e of [...edges.values()].sort((a, b) => b.w - a.w)) {
        const da = degree.get(e.a) || 0
        const db = degree.get(e.b) || 0
        if (da >= 6 || db >= 6) continue
        degree.set(e.a, da + 1)
        degree.set(e.b, db + 1)
        out.push(e)
      }
      return out
    }

    function buildPersonEdges(items, entities, owners) {
      const counts = new Map()
      for (const it of items) {
        const text = norm(it.text)
        const hits = new Set()
        for (const [alias, set] of owners) {
          if (alias.length < 2 || !text.includes(alias)) continue
          for (const key of set) if (entities.has(key)) hits.add(key)
        }
        const own = it.about
          ? `q:${it.about}`
          : it.aboutName
            ? ((owners.get(norm(it.aboutName)) && owners.get(norm(it.aboutName)).size === 1) ? [...owners.get(norm(it.aboutName))][0] : '')
            : ''
        if (own && entities.has(own)) hits.add(own)
        const arr = [...hits].sort()
        for (let i = 0; i < arr.length; i += 1) {
          for (let j = i + 1; j < arr.length; j += 1) {
            const key = `${arr[i]}|${arr[j]}`
            counts.set(key, (counts.get(key) || 0) + 1)
          }
        }
      }
      return [...counts.entries()]
        .map(([key, count]) => {
          const [a, b] = key.split('|')
          return { a, b, count, w: Math.min(0.95, 0.45 + count * 0.1) }
        })
        .filter((e) => e.count >= 2)
    }

    async function buildGraph({ force = false, quiet = false } = {}) {
      if (building) return { ok: false, message: '正在建图，等一下' }
      const items = itemsNow()
      if (!items) return { ok: false, message: '记忆模块没在跑' }
      const seed = seedOf()
      const sig = `${sigOf(items)}:${JSON.stringify(seed)}`
      if (!force && graph.builtAt && graph.version === 4 && graph.sig === sig) {
        return { ok: true, skipped: true, message: '记忆没变化', ...statsOf(items) }
      }
      building = true
      lastError = ''
      try {
        const profiles = mem()?.profiles?.() || []
        const { entities, owners } = buildEntities(items, profiles, seed)
        const entMap = new Map(entities.map((e) => [e.key, e]))
        const mEdges = buildMemoryEdges(items)
        const pEdges = buildPersonEdges(items, entMap, owners)
        graph = { version: 4, builtAt: Date.now(), sig, entities, mEdges, pEdges }
        runtime = makeRuntime(graph)
        writeJson(file, graph)
        const result = statsOf(items)
        if (!quiet) api.log.info?.(`[记忆中枢] ${result.entities} 个实体、${result.edges} 条记忆边、${result.personEdges} 条人物边`)
        options.onBuilt?.(result)
        return { ok: true, message: `建好了：${result.entities} 个实体、${result.edges} 条记忆边、${result.personEdges} 条人物边`, ...result, building: false }
      } catch (error) {
        lastError = error.message
        api.log.warn?.('[记忆中枢] 建图失败：' + error.message)
        return { ok: false, message: error.message }
      } finally {
        building = false
      }
    }

    function statsOf(items) {
      const list = items || itemsNow() || []
      return {
        memories: list.length,
        entities: graph.entities.length,
        edges: graph.mEdges.length,
        personEdges: graph.pEdges.length,
        builtAt: graph.builtAt,
        building,
        lastError,
      }
    }

    async function detectEntities(q, chat) {
      const text = norm(q)
      if (!text) return []
      const found = new Map()
      let aliasSeen = false
      for (const [alias, set] of runtime.owners) {
        if (!alias || !text.includes(alias)) continue
        aliasSeen = true
        for (const key of set) {
          const ent = runtime.entities.get(key)
          if (!ent) continue
          const self = chat && chat.kind === 'private' && ent.qq && String(chat.userId) === String(ent.qq)
          const unique = set.size === 1
          const exact = text.trim() === alias
          const cue = /(叫|是|关于|问一下|还记得|记得|想不起|最近|怎么样|呢|吗|吧|在哪|在干嘛|干啥|是谁|喜欢|讨厌|说过|提到|的事|什么)/.test(text)
          if (!unique && !self && !exact && !cue) continue
          if ((COMMON.has(alias) || alias.length < 2) && !self && !exact && !cue) continue
          const prev = found.get(key)
          if (!prev || alias.length > prev.alias.length || self) {
            found.set(key, { key, name: ent.name || alias, qq: ent.qq || '', alias, self, ambiguous: COMMON.has(alias) || !unique })
          }
        }
      }
      if (found.size) return [...found.values()].slice(0, 3)
      // 没在别名表里：短词/英文名再让向量找一次，够像才当成临时概念（如一个没登记过的项目名）
      const raw = String(q || '').trim()
      const latinName = /^[A-Za-z][A-Za-z0-9_-]{1,20}$/.test(raw)
      if (aliasSeen || (raw.length > 6 && !latinName)) return []
      if (!/^[\p{L}\p{N}_-]{2,12}$/u.test(raw) && !/「[^」]{2,10}」|“[^”]{2,10}”/.test(raw)) return []
      try {
        const m = mem()
        if (!m || !m.vector || typeof m.vector.neighbors !== 'function') return []
        const list = await m.vector.neighbors(raw, 6)
        if (list[0] && list[0].sim >= 0.55) return [{ key: `t:${norm(raw)}`, name: raw, qq: '', alias: raw, adHoc: true }]
      } catch (error) {}
      return []
    }

    function allowItem(it, chat, info, all) {
      if (!it || it.invalidAt) return false
      if (all) return true
      if (!it.about) return true
      if (chat && chat.kind === 'private') return String(it.about) === String(chat.userId)
      const speakers = new Set((Array.isArray(info?.speakers) ? info.speakers : []).map(String))
      if (info?.senderId) speakers.add(String(info.senderId))
      return speakers.has(String(it.about))
    }

    function brightnessOf(it, now) {
      return retention(it, now) * (0.6 + 0.4 * clamp(Number(it.importance) ?? 0.5, 0, 1))
    }

    async function associate(entities, q, chat, info, opts = {}) {
      const items = itemsNow()
      if (!items || !entities.length) return { ok: false, entities, lines: [], reinforce: [] }
      const byId = new Map(items.map((it) => [it.id, it]))
      const now = Date.now()
      const threshold = num(settings().threshold, 0.35, 0.1, 0.9)
      const maxItems = Math.round(num(settings().maxItems, 5, 3, 8))
      const maxHops = Math.round(num(settings().maxHops, 1, 1, 2))
      const existing = norm(opts.skipText)
      const all = Boolean(opts.all)
      const act = new Map()
      const put = (id, a, want, hop) => {
        const it = byId.get(id)
        if (!it || !allowItem(it, chat, info, all) || !(a > 0)) return
        const prev = act.get(id)
        if (!prev || a > prev.a) act.set(id, { a, want, hop })
      }

      // 直接：这个人的记忆；标注过「关于谁」的权重更高，只靠正文提到名字的稍低
      for (const ent of entities) {
        const live = runtime.entities.get(ent.key)
        if (!live) continue
        const core = new Set(live.core || [])
        for (const id of live.items) put(id, core.has(id) ? 1 : 0.82, 'direct', 0)
      }

      // 语义：问句向量近邻，作为种子
      try {
        const m = mem()
        if (m && m.vector && typeof m.vector.neighbors === 'function') {
          const list = await m.vector.neighbors(q, 16)
          for (const hit of list) {
            if (!hit || hit.sim < 0.45) continue
            put(hit.id, 0.78 * clamp(hit.sim / 0.65, 0, 1), entities.some((e) => e.adHoc) ? 'direct' : 'semantic', 0)
          }
        }
      } catch (error) {}

      // 关系：和这个人常一起出现的人，把他们最近的记忆也带进来
      for (const ent of entities) {
        for (const edge of runtime.pAdj.get(ent.key) || []) {
          const otherKey = edge.a === ent.key ? edge.b : edge.b === ent.key ? edge.a : ''
          const other = runtime.entities.get(otherKey)
          if (!other) continue
          for (const id of other.items.slice(0, 2)) put(id, 0.72 * edge.w, 'relation', 0)
        }
      }

      // 1~2 跳扩散
      let frontier = [...act.entries()].filter(([, v]) => v.hop === 0).map(([id, v]) => ({ id, ...v }))
      for (let hop = 1; hop <= maxHops; hop += 1) {
        const next = []
        for (const seed of frontier) {
          for (const edge of runtime.mAdj.get(seed.id) || []) {
            const it = byId.get(edge.b)
            if (!it || !allowItem(it, chat, info, all)) continue
            const a = seed.a * edge.w * Math.pow(0.7, hop) * (0.35 + 0.65 * brightnessOf(it, now))
            if (a < threshold * 0.5) continue
            const prev = act.get(edge.b)
            if (prev && prev.a >= a) continue
            const want = seed.want === 'direct' && edge.kind === 'tag' ? 'event' : 'semantic'
            act.set(edge.b, { a, want, hop })
            next.push({ id: edge.b, a, want, hop })
          }
        }
        frontier = next
      }

      const boost = { direct: 1.15, relation: 1.05, event: 0.95, semantic: 0.85 }
      const ranked = [...act.entries()]
        .map(([id, v]) => {
          const it = byId.get(id)
          if (!it) return null
          const b = brightnessOf(it, now)
          const importance = clamp(Number(it.importance) ?? 0.5, 0, 1)
          return { it, ...v, score: v.a * b * (0.7 + 0.3 * importance) * (boost[v.want] || 0.9) }
        })
        .filter((x) => x && x.score >= threshold)
        .sort((a, b) => b.score - a.score)

      const picked = []
      const perEntity = new Map()
      for (const hit of ranked) {
        const text = String(hit.it.text || '')
        if (text.length < 4) continue
        if (existing && existing.includes(norm(text).slice(0, 24))) continue
        const key = String(hit.it.about || hit.it.aboutName || (Array.isArray(hit.it.tags) && hit.it.tags[0]) || hit.it.id)
        const used = perEntity.get(key) || 0
        if (used >= 2) continue
        perEntity.set(key, used + 1)
        picked.push(hit)
        if (picked.length >= maxItems) break
      }

      const relations = []
      for (const ent of entities) {
        const list = (runtime.pAdj.get(ent.key) || []).slice().sort((a, b) => b.count - a.count)
        for (const edge of list.slice(0, 1)) {
          const otherKey = edge.a === ent.key ? edge.b : edge.b === ent.key ? edge.a : ''
          const other = runtime.entities.get(otherKey)
          if (!other) continue
          relations.push({ text: `[关系] ${ent.name} 常和 ${other.name} 一起出现（${edge.count} 条共同记忆）` })
        }
      }

      const labels = { direct: '直接', relation: '关系', event: '经历', semantic: '相近' }
      const bodyOf = (it) => memoryLine(it, now).replace(/[。；;]+$/, '')
      const direct = picked.filter((x) => x.want === 'direct').map((x) => ({ plain: bodyOf(x.it), text: `[直接] ${bodyOf(x.it)}` }))
      const rest = picked.filter((x) => x.want !== 'direct').map((x) => ({ plain: bodyOf(x.it), text: `[${labels[x.want] || '相近'}] ${bodyOf(x.it)}` }))
      const lines = []
      lines.push(...direct.slice(0, 2))
      if (relations.length) lines.push({ plain: relations[0].text, text: relations[0].text })
      lines.push(...direct.slice(2), ...rest)
      const finalLines = []
      for (const line of lines) {
        if (finalLines.some((x) => x.text === line.text)) continue
        if (existing && existing.includes(norm(line.plain || line.text).slice(0, 24))) continue
        finalLines.push(line)
      }

      const strength = num(settings().strength, 0.6, 0, 1)
      const reinforce = picked
        .filter((x) => x.want !== 'semantic' || x.score >= 0.55)
        .slice(0, 3)
        .map((x) => ({ id: x.it.id, a: clamp(x.score * strength, 0, 1) }))

      return {
        ok: true,
        entities: entities.map((e) => ({ key: e.key, name: e.name, qq: e.qq, alias: e.alias, ambiguous: e.ambiguous })),
        lines: finalLines.slice(0, maxItems + 1),
        reinforce,
      }
    }

    /** 没认出名字时，直接拿问句的向量近邻当种子，走一跳关联；最多补 2 条，避免每轮都塞一堆 */
    async function associateByVector(q, chat, info, opts = {}) {
      const items = itemsNow()
      if (!items) return { lines: [], reinforce: [] }
      const byId = new Map(items.map((it) => [it.id, it]))
      const now = Date.now()
      const existing = norm(opts.skipText)
      const all = Boolean(opts.all)
      const maxItems = Math.round(num(settings().autoMax, 2, 0, 4))
      if (!maxItems) return { lines: [], reinforce: [] }
      const threshold = num(settings().threshold, 0.35, 0.1, 0.9)
      const seedFloor = num(settings().autoFloor, 0.5, 0.4, 0.9)
      let seeds = []
      try {
        const m = mem()
        if (m && m.vector && typeof m.vector.neighbors === 'function') seeds = await m.vector.neighbors(q, 10)
      } catch (error) {}
      seeds = seeds.filter((h) => h && h.sim >= seedFloor && byId.has(h.id) && allowItem(byId.get(h.id), chat, info, all))
      if (!seeds.length) return { lines: [], reinforce: [] }
      const act = new Map()
      const put = (id, a) => {
        const it = byId.get(id)
        if (!it || !allowItem(it, chat, info, all) || !(a > 0)) return
        const prev = act.get(id)
        if (!prev || a > prev.a) act.set(id, { a })
      }
      for (const s of seeds.slice(0, 4)) {
        put(s.id, s.sim)
        for (const edge of runtime.mAdj.get(s.id) || []) {
          const it = byId.get(edge.b)
          if (!it || !allowItem(it, chat, info, all)) continue
          const a = s.sim * edge.w * 1.35 * (0.45 + 0.55 * brightnessOf(it, now))
          if (a >= 0.28) put(edge.b, a)
        }
      }
      const ranked = [...act.entries()]
        .map(([id, v]) => {
          const it = byId.get(id)
          if (!it) return null
          const b = brightnessOf(it, now)
          return { it, a: v.a, score: v.a * (0.5 + 0.5 * b) }
        })
        .filter((x) => x && x.score >= Math.max(0.1, threshold * 0.5))
        .sort((a, b) => b.score - a.score)
      const picked = []
      for (const hit of ranked) {
        const text = String(hit.it.text || '')
        if (text.length < 4) continue
        if (existing && existing.includes(norm(text).slice(0, 24))) continue
        if (picked.some((x) => norm(x.it.text).slice(0, 24) === norm(text).slice(0, 24))) continue
        picked.push(hit)
        if (picked.length >= maxItems) break
      }
      const lines = picked.map((x) => {
        const body = memoryLine(x.it, now).replace(/[。；;]+$/, '')
        return { plain: body, text: `[关联] ${body}` }
      })
      const strength = num(settings().strength, 0.6, 0, 1)
      const reinforce = picked.slice(0, 2).map((x) => ({ id: x.it.id, a: clamp(x.score * 2.5 * strength, 0, 1) }))
      return { lines, reinforce }
    }

    function scheduleReinforce(entries) {
      if (settings().reinforce === false || !entries.length) return
      setTimeout(() => {
        const m = mem()
        if (m && typeof m.reinforce === 'function') m.reinforce(entries).then(() => options.onReinforce?.()).catch(() => {})
      }, 0)
    }

    function mergeHint(content, lines) {
      const adds = lines.map((l) => l.text)
      if (!adds.length) return content
      const cap = num(settings().injectMaxChars, 420, 200, 800)
      const idx = content.findIndex((x) => x && x.type === 'text' && typeof x.text === 'string' && x.text.startsWith('（你记得这些事'))
      if (idx >= 0) {
        let text = content[idx].text
        for (const add of adds) {
          const plain = add.replace(/^\[[^\]]+\]\s*/, '')
          if (text.includes(plain.slice(0, 24))) continue
          const close = text.lastIndexOf('）')
          if (close <= 0) break
          const next = text.slice(0, close) + '；' + add + text.slice(close)
          if (next.length > cap) continue
          text = next
        }
        if (text !== content[idx].text) {
          const copy = content.slice()
          copy[idx] = { ...content[idx], text }
          return copy
        }
        return content
      }
      const hint = `（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：${adds.join('；')}）`
      return [{ type: 'text', text: hint.slice(0, cap) }, ...content]
    }

    function pushLog(entry) {
      logs.unshift(entry)
      logs.length = Math.min(logs.length, 12)
    }

    /** 中枢接管自动回忆时：直接走内置的「关键词一半 + 向量一半」召回。 */
    function directRecallLines(q, chat, skipText) {
      const m = mem()
      if (!m || typeof m.recall !== 'function') return []
      const limit = directCount()
      if (!limit) return []
      let hits = []
      try {
        hits = m.recall(q, { about: chat.userId, limit, where: `${chat.chatId || ''}（中枢自动）` }) || []
      } catch {
        return []
      }
      const out = []
      for (const h of hits) {
        const it = h?.it
        if (!it || it.archivedAt || it.invalidAt) continue
        const plain = String(memoryLine(it) || '').replace(/[。；;]+$/, '')
        if (!plain) continue
        if (skipText && skipText.includes(plain.slice(0, 24))) continue
        if (out.some((x) => norm(x).slice(0, 24) === norm(plain).slice(0, 24))) continue
        out.push(`[回忆] ${plain}`)
        if (out.length >= limit) break
      }
      return out
    }

    api.on('prompt', async (content, info) => {
      try {
        if (!info || !info.chat || info.chat.kind === 'system' || !Array.isArray(content)) return content
        if (off() || api.config?.()?.memory?.enabled === false) return content
        const q = String(info.queryText || '').trim()
        if (!q) return content
        const items = itemsNow()
        if (!items) return content
        if (!graph.builtAt) await buildGraph({ quiet: true })
        else if (graph.sig !== graphSig(items)) buildGraph({ quiet: true }).catch(() => {})
        const entities = await detectEntities(q, info.chat)
        const skipText = content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n')
        const namePct = percent(settings().nameChance, 100)
        const autoPct = percent(settings().autoChance, 60)
        const direct = takeoverActive() ? directRecallLines(q, info.chat, skipText) : []
        const lines = direct.map((text) => ({ text }))
        const reinforce = []
        let logEntities = []
        let logAuto = false
        let nameTried = false
        if (entities.length) {
          if (namePct > 0 && Math.random() * 100 <= namePct) {
            nameTried = true
            const plan = await associate(entities, q, info.chat, info, { skipText })
            if (plan.ok && plan.lines.length) {
              lines.push(...plan.lines)
              reinforce.push(...plan.reinforce)
              logEntities = plan.entities.map((e) => e.name)
            }
          }
        }
        const tryAuto = !entities.length || nameTried
        if (!logEntities.length && tryAuto && settings().autoAssoc !== false && autoPct > 0 && Math.random() * 100 <= autoPct) {
          const auto = await associateByVector(q, info.chat, info, { skipText })
          if (auto.lines.length) {
            lines.push(...auto.lines)
            reinforce.push(...auto.reinforce)
            logAuto = true
          }
        }
        if (!lines.length) return content
        pushLog({ at: Date.now(), query: q.slice(0, 80), entities: logEntities, auto: logAuto, direct: direct.length, reinforced: reinforce.length })
        scheduleReinforce(reinforce)
        return mergeHint(content, lines)
      } catch (error) {
        lastError = error.message
        api.log.warn?.('[记忆中枢] 提示注入失败：' + error.message)
        return content
      }
    })

    api.tool(({ chat }) => {
      if (off() || api.config?.()?.memory?.enabled === false || !chat || chat.kind === 'system') return []
      return [
        defineTool({
          name: 'recall_associated',
          description: '按名字翻记忆：想不起某个称呼/某个人以前发生过什么、和谁有关系时用。query 写名字或一句话；普通关键词回忆用 recall_memory。',
          properties: { query: str('名字或想问的事') },
          required: ['query'],
          execute: async ({ query }) => {
            const q = String(query || '').trim()
            if (!q) return { ok: false, message: '给个名字' }
            const items = itemsNow()
            if (items && !graph.builtAt) await buildGraph({ quiet: true })
            else if (items && graph.sig !== graphSig(items)) buildGraph({ quiet: true }).catch(() => {})
            const entities = await detectEntities(q, chat)
            if (!entities.length) return { ok: true, message: '这句里没认出要联想的人' }
            const plan = await associate(entities, q, chat, { senderId: chat.userId, speakers: [chat.userId] }, {})
            scheduleReinforce(plan.reinforce)
            return plan.lines.length
              ? { ok: true, message: plan.lines.map((l) => l.text).join('；') }
              : { ok: true, message: '关于这个人没联想到什么' }
          },
        }),
      ]
    })

    api.route('/assoc/state', async () => {
      const items = itemsNow()
      return {
        ok: true,
        enabled: !off(),
        memoryRunning: Boolean(items),
        recallTakeover: Boolean(takeoverActive()),
        directCount: directCount(),
        ...statsOf(items),
        settings: {
          maxHops: Math.round(num(settings().maxHops, 1, 1, 2)),
          maxItems: Math.round(num(settings().maxItems, 5, 3, 8)),
          threshold: num(settings().threshold, 0.35, 0.1, 0.9),
          reinforce: settings().reinforce !== false,
          strength: num(settings().strength, 0.6, 0, 1),
          autoAssoc: settings().autoAssoc !== false,
          nameChance: percent(settings().nameChance, 100),
          autoChance: percent(settings().autoChance, 60),
          autoFloor: num(settings().autoFloor, 0.5, 0.4, 0.9),
          autoMax: Math.round(num(settings().autoMax, 2, 0, 4)),
          ownerAliases: String(settings().ownerAliases || ''),
          botNames: String(settings().botNames || ''),
          extraEntities: String(settings().extraEntities || ''),
        },
        logs,
      }
    })
    api.route('/assoc/try', async (req) => {
      const q = String(http.query(req).q || '').trim()
      if (!q) return { ok: false, message: '给个名字或一句话' }
      const t0 = Date.now()
      const items = itemsNow()
      if (!items) return { ok: false, message: '记忆模块没在跑' }
      if (!graph.builtAt || graph.sig !== graphSig(items)) await buildGraph({ quiet: true })
      const entities = await detectEntities(q, { kind: 'panel' })
      if (!entities.length) {
        if (settings().autoAssoc === false) return { ok: true, ms: Date.now() - t0, entities: [], lines: [], auto: true, message: '没认出名字，问题联想关着' }
        const auto = await associateByVector(q, { kind: 'panel' }, { speakers: [] }, { all: true })
        return { ok: true, ms: Date.now() - t0, entities: [], lines: auto.lines, reinforce: auto.reinforce, auto: true }
      }
      const plan = await associate(entities, q, { kind: 'panel' }, { speakers: [] }, { all: true })
      return {
        ok: true,
        ms: Date.now() - t0,
        entities: entities.map((e) => ({ name: e.name, qq: e.qq, alias: e.alias, ambiguous: e.ambiguous })),
        lines: plan.lines,
        reinforce: plan.reinforce,
        auto: false,
      }
    })
    api.route('/assoc/rebuild', async () => {
      const r = await buildGraph({ force: true })
      return r
    })

    // 记忆中枢里的向量半：设置页需要自己的路由前缀，这里代理到「记忆（向量版）」内核。
    const vec = () => {
      const m = mem()
      return m && m.vector ? m.vector : null
    }
    const vecMissing = { ok: false, message: '记忆（向量版）没在跑：到「扩展」页启动它，或把「用内置的」关掉' }
    api.route('/vector/state', async () => {
      const v = vec()
      return v ? v.state() : vecMissing
    })
    api.route('/vector/try', async (req) => {
      const v = vec()
      return v ? v.search(http.query(req).q) : vecMissing
    })
    api.route('/vector/config', async (req) => {
      const v = vec()
      if (!v) return vecMissing
      if (req && req.method === 'POST') {
        let b = {}
        try { b = await http.body(req) } catch (error) {}
        return v.config(b)
      }
      return v.config()
    })
    api.route('/vector/rebuild', async (req) => {
      const v = vec()
      if (!v) return vecMissing
      let b = {}
      try { b = await http.body(req) } catch (error) {}
      return v.rebuild({ force: Boolean(b.force) })
    })

    api.later(8000, () => buildGraph({ quiet: true }).catch(() => {}))
    api.every(5 * 60_000, () => buildGraph({ quiet: true }).catch(() => {}), '重建记忆联想图')

    return {
      edges: () => graph.mEdges || [],
    }
}
