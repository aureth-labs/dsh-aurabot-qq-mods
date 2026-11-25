// 星图数据整理：把 memory 模块的数据变成节点、连线和正文。
// 纯函数，不碰磁盘和网络，index.mjs 只负责路由和缓存，测试可以直接喂假数据。

/** 一次最多画这么多节点，再多页面会卡。 */
export const MAX_NODES = 700

/** 节点尺寸：会话枢纽最大，档案次之，摘要居中，单条记忆按被想起次数长大。 */
export const SIZE = { session: 7, profile: 6, gist: 4.2, itemBase: 1.6 }

export const clean = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

const pad = (n) => String(n).padStart(2, '0')

/** 时间戳 → YYYY-MM-DD；空值给空串，页面据此决定显不显示。 */
export const fmt = (ms) => {
  const t = Number(ms) || 0
  if (!t) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 记忆来源 → 页面上的节点类型。 */
export const typeOf = (m) => {
  if (m.source === 'diary') return 'daily'
  if (m.source === 'event' || m.kind === 'seen') return 'daily'
  if (m.source === 'gist') return 'daily'
  return 'reference'
}

/** 单条记忆的星体大小：被想起越多、越重要，星越大，但有上限。 */
export const sizeOf = (m) => {
  const hits = Number(m.hits) || 0
  const importance = Number(m.importance) || 0.5
  return SIZE.itemBase + Math.min(5, Math.log1p(hits) * 1.3) + importance * 2.2
}

const empty = () => ({ nodes: [], links: [], texts: new Map() })

/**
 * @param {object|null} mem Aurabot 内置 memory 模块（list/gists/profiles/personaOverview）
 * @returns {{nodes: object[], links: object[], texts: Map<string, {label: string, text: string}>}}
 */
export function buildGraph(mem, opts = {}) {
  if (!mem) return empty()

  // 作用域：默认只保留「主人相关的」和「无归属的（她自己写的）」记忆。
  // 群聊里其他人的档案、别人的记忆不该出现在一个只要打开页面就能读的接口里。
  //   opts.owner 主人的 QQ
  //   opts.all   true 才返回全量（面板里显式打开「全部」时）
  // 传空对象（不传 owner）时不过滤 —— 保持纯函数语义，测试可以直接喂假数据。
  const owner = String(opts.owner || '').trim()
  const all = opts.all === true
  const keepAbout = (x) => {
    if (!x || all || !owner) return true
    const a = String(x.about || x.qq || '').trim()
    return !a || a === owner      // 无归属 = 她自己的；有归属只留主人的
  }

  const items = (mem.list?.('') || []).filter((m) => m && String(m.text || '').trim()).filter(keepAbout)
  const gists = (mem.gists?.({}) || []).filter((g) => g && String(g.text || '').trim()).filter(keepAbout)
  const profiles = (mem.profiles?.() || []).filter((p) => p && p.qq).filter(keepAbout)
  const people = (mem.personaOverview?.() || []).filter((p) => p && p.qq).filter(keepAbout)

  const nodes = new Map()
  const texts = new Map()
  const links = []
  const add = (node) => {
    if (!node?.id || nodes.has(node.id) || nodes.size >= MAX_NODES) return
    nodes.set(node.id, node)
  }
  const link = (source, target, weight = 0.5, kind = 'related') => {
    if (source && target && source !== target) links.push({ source, target, weight, kind })
  }

  const nameOf = new Map()
  for (const p of people) nameOf.set(String(p.qq), clean(p.alias || p.name || p.qq, 30))
  for (const p of profiles) if (!nameOf.has(String(p.qq))) nameOf.set(String(p.qq), clean(p.alias || p.name || p.qq, 30))

  const subjectNodes = new Set()
  const ensureSubject = (qq) => {
    const id = String(qq || '')
    if (!id) return ''
    if (!subjectNodes.has(id)) {
      subjectNodes.add(id)
      const name = nameOf.get(id) || id
      add({
        id: 'subject:' + id,
        label: name,
        desc: `${name}（${id}）`,
        title: name,
        type: 'session',
        session: id,
        uses: 0,
        created: '',
        updated: '',
        chars: 0,
        size: SIZE.session,
      })
      texts.set('subject:' + id, { label: name, text: `${name}（${id}）` })
    }
    return 'subject:' + id
  }

  for (const p of people) ensureSubject(p.qq)

  for (const p of profiles) {
    const qq = String(p.qq)
    const subject = ensureSubject(qq)
    const id = 'profile:' + qq
    const label = `档案 · ${clean(p.alias || p.name || nameOf.get(qq) || qq, 30)}`
    add({
      id,
      label,
      desc: clean(p.text || '', 220),
      title: label,
      type: 'project',
      session: qq,
      uses: 0,
      created: '',
      updated: fmt(p.at),
      chars: String(p.text || '').length,
      size: SIZE.profile,
    })
    texts.set(id, { label, text: p.text || '' })
    link(subject, id, 1, 'type')
  }

  for (const m of items) {
    const id = 'item:' + String(m.id)
    const label = clean(m.displayText || m.text, 44) || '记忆'
    add({
      id,
      label,
      desc: clean(m.text, 220),
      title: label,
      type: typeOf(m),
      session: clean(m.aboutName || m.about || m.chatId || '', 40),
      uses: Number(m.hits) || 0,
      created: fmt(m.at || m.saidAt),
      updated: fmt(m.at),
      chars: String(m.text || '').length,
      size: sizeOf(m),
    })
    texts.set(id, {
      label,
      text: `${m.text || ''}\n\n${fmt(m.at)}${m.source ? ' · ' + m.source : ''}${m.aboutName ? ' · ' + m.aboutName : ''}`,
    })
    if (m.about) link(id, ensureSubject(m.about), 0.8, 'session')
    for (const rel of m.related || []) link(id, 'item:' + String(rel), 0.35, 'related')
  }

  for (const g of gists) {
    const id = 'gist:' + String(g.id)
    const label = clean(g.text, 44) || '摘要'
    add({
      id,
      label,
      desc: clean(g.text, 220),
      title: label,
      type: 'daily',
      session: clean(g.aboutName || g.about || g.chatId || '', 40),
      uses: 0,
      created: fmt(g.at || g.saidAt),
      updated: fmt(g.at),
      chars: String(g.text || '').length,
      size: SIZE.gist,
    })
    texts.set(id, {
      label,
      text: `${g.text || ''}\n\n${fmt(g.at)}${g.source ? ' · ' + g.source : ''}`,
    })
    if (g.about) link(id, ensureSubject(g.about), 0.8, 'session')
  }

  const ids = new Set(nodes.keys())
  return {
    nodes: [...nodes.values()],
    links: links.filter((l) => ids.has(l.source) && ids.has(l.target)),
    texts,
  }
}
