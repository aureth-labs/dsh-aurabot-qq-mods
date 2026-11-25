// 陪伴记忆（companion）回归测试
//
// 模块语义：冷热分层记忆。每轮按 token 预算注入「连续性 + 固定事实 + 活跃记忆」，
// 冷库只在用户给出线索时按需召回。重点锁住的约束：
//   · 预算是天花板不是配额：超了就裁，不拿不相关条目凑数
//   · 固定事实超限必须告警（不能静默丢弃）
//   · 活跃记忆按优先级 / 热度 / 最近提及排序，同主题有条数上限
//   · 空数据、坏 JSON 一律不崩
//   · 冷库召回：无线索不许开库，命中不满就如实说没找到
//   · 面板路由返回的结构要跟客户端契约一致
//
// 写测试时发现并修掉的 bug：
//   1. store.js remove() 删除会「复活」。saveRecords() 保存前会从磁盘合并回外部
//      写入的新卡，而刚删掉的卡这时还在磁盘上，于是又被合回内存并写回文件——
//      表现为「删了还在，第二次删也返回 true」。修法：MemoryStore 记 removedIds，
//      合并时跳过已明确删除的 id，put() 时再解除。
//      （对应用例：存储 → put / get / remove 往返；面板 → /record/delete 契约）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, '..')

const E = await import(new URL('../engine.js', import.meta.url).href)
const R = await import(new URL('../render.js', import.meta.url).href)
const A = await import(new URL('../archive.js', import.meta.url).href)
const { ArchiveIndex } = await import(new URL('../archive-index.js', import.meta.url).href)
const { MemoryStore, resolveDataDir } = await import(new URL('../store.js', import.meta.url).href)
const { default: mod } = await import(new URL('../index.mjs', import.meta.url).href)

const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime()
const iso = (ms) => new Date(ms).toISOString()
const tmpDir = (tag) => mkdtempSync(join(tmpdir(), `aurabot-companion-${tag}-`))

/** 造一条记忆卡；只填测试关心的字段。 */
function mkRecord(over = {}) {
  const base = {
    id: 'r1',
    summary: '一条普通记忆',
    topic_id: 't1',
    status: 'valid',
    tier: 'hot',
    stage: 'detail',
    pinned: false,
    recall_only: false,
    created_at: iso(NOW - 3 * 86400000),
    last_user_mention_at: iso(NOW - 3600000),
    mention_events: [],
    facets: {},
    heat: 0.5,
  }
  return { ...base, ...over }
}

/** buildSnapshot / lifecyclePass 只用到 list() 和 state。 */
function mkStore(records, state = {}) {
  return {
    records,
    state: { entity: { base_persona: '', current_state: '', state_version: 1, updated_at: null }, pin_overflow: [], ...state },
    list() {
      return this.records
    },
  }
}

describe('token 估算与词法', () => {
  test('estimateTokens：中文按字、拉丁按 4 字符折一个 token', () => {
    assert.equal(E.estimateTokens(''), 0)
    assert.equal(E.estimateTokens(null), 0)
    assert.equal(E.estimateTokens('你好'), 2)
    assert.equal(E.estimateTokens('abcdefgh'), 2)
    assert.equal(E.estimateTokens('你好abcdefgh'), 4)
  })

  test('tokenList 出中文二元组与拉丁词，tokenize 去重', () => {
    const list = E.tokenList('看看 npm test')
    assert.deepEqual(list.filter((t) => /[a-z]/.test(t)), ['npm', 'test'])
    assert.ok(list.includes('看看'), '中文要切出二元组')
    const set = E.tokenize('看看看看')
    assert.equal(set.size, 1, 'tokenize 是集合，重复二元组只留一个')
  })

  test('lexicalSimilarity：同文为 1，空文本为 0', () => {
    assert.equal(E.lexicalSimilarity('小林搬家', '小林搬家'), 1)
    assert.equal(E.lexicalSimilarity('', '小林搬家'), 0)
    assert.ok(E.lexicalSimilarity('小林搬家', '小张换工作') < 0.2)
  })

  test('dayKey 按配置时区切日，坏时区回落到 UTC 日期', () => {
    assert.equal(E.dayKey(Date.parse('2026-11-09T15:30:00Z'), 'Asia/Shanghai'), '2026-11-09')
    assert.equal(E.dayKey(Date.parse('2026-11-09T15:30:00Z'), 'UTC'), '2026-11-09')
    assert.match(E.dayKey(Date.now(), '不是时区'), /^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('配置解析', () => {
  test('空配置走 defaults，且不被 null 带崩', () => {
    for (const raw of [undefined, null, 'x', 42]) {
      const c = E.resolveConfig(raw)
      assert.equal(c.budgets.hotTokens, 960)
      assert.equal(c.budgets.pinnedTokens, 160)
      assert.equal(c.selection.maxPinnedItems, 4)
      assert.equal(c.heat.weights.frequency, 0.45)
    }
  })

  test('局部覆盖只影响给到的键，权重单独合并', () => {
    const c = E.resolveConfig({ budgets: { hotTokens: 300 }, heat: { weights: { recency: 0.5 } } })
    assert.equal(c.budgets.hotTokens, 300)
    assert.equal(c.budgets.pinnedTokens, 160, '没给的键要保持默认')
    assert.equal(c.heat.weights.recency, 0.5)
    assert.equal(c.heat.weights.frequency, 0.45, '权重块要浅合并，不能整块替换')
  })
})

describe('热度计算', () => {
  test('computeHeat：3 次当日有效提及 + 刚提过 = 0.575', () => {
    const record = mkRecord({
      last_user_mention_at: iso(NOW),
      mention_events: [1, 2, 3].map((n) => ({
        interaction_id: `i${n}`,
        occurred_at: iso(NOW - n * 3600000),
        kind: 'substantive',
      })),
    })
    const h = E.computeHeat(record, NOW, E.resolveConfig(null).heat)
    assert.equal(h.mentions, 3)
    assert.ok(Math.abs(h.heat - 0.575) < 1e-9, `实际 ${h.heat}`)
  })

  test('computeHeat：久未提及按半衰期衰减，且不会为负', () => {
    const c = E.resolveConfig(null).heat
    const fresh = E.computeHeat(mkRecord({ last_user_mention_at: iso(NOW) }), NOW, c)
    const old = E.computeHeat(mkRecord({ last_user_mention_at: iso(NOW - 30 * 86400000) }), NOW, c)
    assert.ok(old.recency < fresh.recency / 10, '一个月没提过，recency 要显著掉下去')
    assert.ok(old.heat >= 0 && old.heat < 0.1)
  })

  test('进行中事项加 0.2；recall_only 不享受', () => {
    const c = E.resolveConfig(null).heat
    const base = () => mkRecord({ last_user_mention_at: iso(NOW), ongoing_until: iso(NOW + 86400000) })
    const ongoing = E.computeHeat(base(), NOW, c)
    const muted = E.computeHeat({ ...base(), recall_only: true }, NOW, c)
    assert.equal(ongoing.ongoing, 1)
    assert.equal(muted.ongoing, 0)
    assert.ok(Math.abs(ongoing.heat - muted.heat - 0.2) < 1e-9)
  })

  test('qualifyingMentions：同一次交互只算一次、当日封顶、窗口外不计', () => {
    const c = E.resolveConfig(null).heat
    const dup = mkRecord({
      mention_events: [1, 2, 3].map(() => ({ interaction_id: 'same', occurred_at: iso(NOW - 3600000), kind: 'substantive' })),
    })
    assert.equal(E.qualifyingMentions(dup, NOW, c), 1, '同一 interaction_id 只算一次')

    const many = mkRecord({
      mention_events: [1, 2, 3, 4, 5].map((n) => ({
        interaction_id: `i${n}`,
        occurred_at: iso(NOW - n * 60000),
        kind: 'substantive',
      })),
    })
    assert.equal(E.qualifyingMentions(many, NOW, c), 3, '每天封顶 3 次')

    const stale = mkRecord({
      mention_events: [{ interaction_id: 'old', occurred_at: iso(NOW - 40 * 86400000), kind: 'substantive' }],
    })
    assert.equal(E.qualifyingMentions(stale, NOW, c), 0, '30 天窗口外的不计')

    const nonSubstantive = mkRecord({
      mention_events: [{ interaction_id: 'x', occurred_at: iso(NOW - 60000), kind: 'reference' }],
    })
    assert.equal(E.qualifyingMentions(nonSubstantive, NOW, c), 0, '非实质提及不计分')
  })
})

describe('快照预算分层', () => {
  test('空库时快照为空但不崩', () => {
    const snap = E.buildSnapshot(mkStore([]), E.resolveConfig(null), NOW)
    assert.deepEqual(snap.pinned, [])
    assert.deepEqual(snap.hot, [])
    assert.equal(snap.tokens.pinned, 0)
    assert.equal(snap.tokens.hot, 0)
    assert.equal(snap.tokens.budgets.hot, 960)
    assert.deepEqual(snap.overflow, { pinned: [], pinnedTotal: 0 })
  })

  test('活跃记忆超预算时按热度挑，丢的是低热度那条', () => {
    const records = [
      mkRecord({ id: 'hot', heat: 0.9 }),
      mkRecord({ id: 'mid', heat: 0.5 }),
      mkRecord({ id: 'cold', heat: 0.1 }),
    ]
    const config = E.resolveConfig(null)
    const one = E.estimateTokens(E.renderRecordLine(records[0], NOW)) + 8
    const budget = one * 2 // 正好放得下两条
    const snap = E.buildSnapshot(mkStore(records), { ...config, budgets: { ...config.budgets, hotTokens: budget } }, NOW)
    assert.deepEqual(snap.hot.map((i) => i.id), ['hot', 'mid'])
    assert.ok(snap.tokens.hot <= budget, `用量 ${snap.tokens.hot} 不能超 ${budget}`)
  })

  test('预算为 0 时活跃记忆一条不塞，连续性仍照常计入', () => {
    const records = [mkRecord({ id: 'a', heat: 0.9 })]
    const config = E.resolveConfig(null)
    const store = mkStore(records, { entity: { base_persona: '', current_state: '刚讲完梦', state_version: 3, updated_at: null } })
    const snap = E.buildSnapshot(store, { ...config, budgets: { ...config.budgets, hotTokens: 0 } }, NOW)
    assert.deepEqual(snap.hot, [])
    assert.equal(snap.continuity.current_state, '刚讲完梦')
    assert.ok(snap.tokens.continuity > 0, '连续性用的是同一个活跃池预算，要单独统计')
    assert.equal(snap.tokens.hot, snap.tokens.continuity)
  })

  test('同一主题最多 2 条，别的主题还能进', () => {
    const records = [
      mkRecord({ id: 't1a', topic_id: 't1', heat: 0.9 }),
      mkRecord({ id: 't1b', topic_id: 't1', heat: 0.8 }),
      mkRecord({ id: 't1c', topic_id: 't1', heat: 0.7 }),
      mkRecord({ id: 't2a', topic_id: 't2', heat: 0.1 }),
    ]
    const config = E.resolveConfig(null)
    const snap = E.buildSnapshot(mkStore(records), config, NOW)
    assert.equal(snap.hot.filter((i) => i.topic === 't1').length, 2)
    assert.ok(snap.hot.some((i) => i.id === 't2a'), '第三张同主题的卡被拦住后，别的主题要补进来')
  })

  test('固定事实排序稳定，最多 4 条，超出写进 overflow', () => {
    const records = [1, 2, 3, 4, 5].map((n) =>
      mkRecord({ id: `p${n}`, pinned: true, tier: 'pinned', last_user_mention_at: iso(NOW - (6 - n) * 86400000) }),
    )
    const config = E.resolveConfig(null)
    const store = mkStore(records)
    const report = E.lifecyclePass(store, config, NOW)
    assert.deepEqual(report.pinOverflow, ['p5'], '最新的那条被挤出去')
    assert.deepEqual(store.state.pin_overflow, ['p5'], '超额要落到 state 里，渲染时才有告警')

    const snap = E.buildSnapshot(store, config, NOW)
    assert.equal(snap.pinned.length, 4)
    assert.deepEqual(snap.overflow.pinned, ['p5'])
    assert.equal(snap.overflow.pinnedTotal, 5)
  })

  test('固定事实也吃 budget：放不下就停，不硬塞', () => {
    const records = [1, 2, 3].map((n) => mkRecord({ id: `p${n}`, pinned: true, tier: 'pinned', summary: '固定事实'.repeat(6) }))
    const config = E.resolveConfig(null)
    const snap = E.buildSnapshot(mkStore(records), { ...config, budgets: { ...config.budgets, pinnedTokens: 10 } }, NOW)
    assert.deepEqual(snap.pinned, [])
    assert.equal(snap.tokens.pinned, 0)
  })
})

describe('生命周期', () => {
  test('固定项永远停在 detail，不会被冷却', () => {
    const record = mkRecord({ id: 'p1', pinned: true, tier: 'pinned', stage: 'summary', last_user_mention_at: iso(NOW - 60 * 86400000) })
    const store = mkStore([record])
    E.lifecyclePass(store, E.resolveConfig(null), NOW)
    assert.equal(record.stage, 'detail')
    assert.equal(record.tier, 'pinned')
  })

  test('热记忆久不提且热度低时降为冷存', () => {
    const record = mkRecord({
      id: 'h1',
      tier: 'hot',
      stage: 'summary',
      summary: '很久以前的小事',
      created_at: iso(NOW - 40 * 86400000),
      last_user_mention_at: iso(NOW - 20 * 86400000),
      heat: 0.01,
    })
    const store = mkStore([record])
    const report = E.lifecyclePass(store, E.resolveConfig(null), NOW)
    assert.equal(record.tier, 'cold')
    assert.equal(record.stage, 'cold')
    assert.equal(report.changes[0].reason, 'low_heat')
  })

  test('冷库近 7 天 ≥3 次交互、≥2 个日期时重新升温', () => {
    const days = [1, 2, 5]
    const record = mkRecord({
      id: 'c1',
      tier: 'cold',
      stage: 'cold',
      last_user_mention_at: iso(NOW - 2 * 86400000),
      mention_events: days.map((d, n) => ({ interaction_id: `i${n}`, occurred_at: iso(NOW - d * 86400000), kind: 'substantive' })),
      heat: 0.2,
    })
    const store = mkStore([record])
    const report = E.lifecyclePass(store, E.resolveConfig(null), NOW)
    assert.equal(record.tier, 'hot')
    assert.equal(report.changes[0].reason, 'repeated_user_mention')
  })

  test('recall_only 立刻降冷，且连续 3 次也用不上', () => {
    const record = mkRecord({
      id: 'q1',
      tier: 'hot',
      recall_only: true,
      last_user_mention_at: iso(NOW - 60000),
      mention_events: [1, 2, 3].map((n) => ({ interaction_id: `i${n}`, occurred_at: iso(NOW - n * 86400000) })),
    })
    const store = mkStore([record])
    const report = E.lifecyclePass(store, E.resolveConfig(null), NOW)
    assert.equal(record.tier, 'cold')
    assert.equal(record.stage, 'cold')
    assert.equal(report.changes[0].reason, 'recall_only')
  })

  test('活跃池超出容量时淘汰热度最低的', () => {
    const config = E.resolveConfig(null)
    const records = Array.from({ length: config.selection.maxHotPoolItems + 3 }, (_, n) =>
      mkRecord({ id: `h${String(n).padStart(3, '0')}`, heat: 0.9, last_user_mention_at: iso(NOW - 60000) }),
    )
    records[0].heat = 0.01
    records[1].heat = 0.02
    records[2].heat = 0.03
    const store = mkStore(records)
    const report = E.lifecyclePass(store, config, NOW)
    const evicted = report.changes.filter((c) => c.reason === 'capacity_eviction').map((c) => c.id)
    assert.deepEqual(evicted.sort(), ['h000', 'h001', 'h002'])
    assert.equal(records.filter((r) => r.tier === 'hot').length, config.selection.maxHotPoolItems)
  })
})

describe('冷库召回', () => {
  test('没有用户线索时不开库', () => {
    const out = E.recallByCue(mkStore([]), '   ', E.resolveConfig(null), NOW)
    assert.equal(out.status, 'disabled')
    assert.equal(out.reason, 'no_user_cue')
    assert.deepEqual(out.items, [])
  })

  test('强命中（≥2 个维度对上）返回 matched', () => {
    const record = mkRecord({
      id: 'm1',
      summary: '陪小林去看了新房',
      facets: { people: [{ name: '小林' }], topics: ['搬家'], places: [{ name: '城南' }] },
    })
    const out = E.recallByCue(mkStore([record]), '小林搬家的事', E.resolveConfig(null), NOW)
    assert.equal(out.status, 'matched')
    assert.equal(out.items.length, 1)
    assert.ok(out.items[0].strong)
    assert.ok(out.supplied.includes('people') && out.supplied.includes('topics'))
    assert.equal(out.degraded, 'lexical_fallback')
  })

  test('完全对不上时说 not_found，不硬凑候选', () => {
    const record = mkRecord({ id: 'm2', summary: '关于天气的闲聊', facets: {} })
    const out = E.recallByCue(mkStore([record]), '量子色动力学', E.resolveConfig(null), NOW)
    assert.equal(out.status, 'not_found')
    assert.deepEqual(out.items, [])
    assert.ok(out.tokens === 0)
  })

  test('分数接近且只取一条时判 ambiguous，请用户补线索', () => {
    const twin = (id) => mkRecord({ id, summary: '小林搬家那天下了雨', facets: { people: [{ name: '小林' }], topics: ['搬家'] } })
    const config = E.resolveConfig({ selection: { maxRecalledItemsPerRequest: 1 } })
    const out = E.recallByCue(mkStore([twin('a1'), twin('a2')]), '小林搬家', config, NOW)
    assert.equal(out.status, 'ambiguous')
    assert.equal(out.items.length, 1)
    assert.equal(out.candidates.length, 2)
  })

  test('召回条数受 maxRecalledItemsPerRequest 限制并标记 truncated', () => {
    const records = Array.from({ length: 6 }, (_, n) =>
      mkRecord({
        id: `m${n}`,
        summary: `第 ${n} 次和小林搬家`,
        facets: { people: [{ name: '小林' }], topics: ['搬家'] },
      }),
    )
    const out = E.recallByCue(mkStore(records), '小林搬家', E.resolveConfig(null), NOW)
    assert.equal(out.items.length, 3, '默认每轮最多 3 条')
    assert.equal(out.truncated, true)
  })

  test('已失效（superseded）的卡不参与召回', () => {
    const record = mkRecord({ id: 'm3', status: 'superseded', facets: { people: [{ name: '小林' }], topics: ['搬家'] } })
    const out = E.recallByCue(mkStore([record]), '小林搬家', E.resolveConfig(null), NOW)
    assert.equal(out.status, 'not_found')
  })
})

describe('渲染', () => {
  test('真实度标签：梦 / 混 / 分不清都有标记，real 不加', () => {
    assert.equal(R.realityMark('dream'), '🌙（梦） ')
    assert.equal(R.realityMark('mixed'), '🌀（梦/现实混） ')
    assert.equal(R.realityMark('unclear'), '❓（分不清） ')
    assert.equal(R.realityMark('real'), '')
    assert.equal(R.realityMark(undefined), '')
    assert.equal(R.lineWithReality({ reality: 'dream', summary: '坐在台阶上' }), '🌙（梦） 坐在台阶上')
  })

  test('快照分段齐全：连续性 / 固定事实 / 活跃记忆 / 召回', () => {
    const records = [
      mkRecord({ id: 'p1', pinned: true, tier: 'pinned', summary: '老大是风止', reality: 'real' }),
      mkRecord({ id: 'h1', tier: 'hot', summary: '搬家的事', heat: 0.7 }),
    ]
    const store = mkStore(records, { entity: { base_persona: '测试人格', current_state: '刚讲完梦', state_version: 22, updated_at: null } })
    const snap = E.buildSnapshot(store, E.resolveConfig(null), NOW)
    const text = R.renderSnapshotText(snap, null, NOW)
    assert.ok(text.startsWith('【陪伴记忆快照】估算预算'), '开头要交代预算')
    assert.ok(text.includes('■ 连续性状态（不参加事件排序）'))
    assert.ok(text.includes('基础人格：测试人格'))
    assert.ok(text.includes('■ 固定事实'))
    assert.ok(text.includes('老大是风止'))
    assert.ok(text.includes('■ 活跃记忆'))
    assert.ok(text.includes('搬家的事'))
    assert.ok(text.includes('本轮无召回'), '没有召回时要说清冷库没打开')
    assert.ok(text.includes(`v${22}`), '连续性状态要带版本号')
  })

  test('固定事实超额时渲染 ⚠ 告警行，不是静默丢', () => {
    const records = [1, 2, 3, 4, 5].map((n) => mkRecord({ id: `p${n}`, pinned: true, tier: 'pinned' }))
    const store = mkStore(records)
    const config = E.resolveConfig(null)
    E.lifecyclePass(store, config, NOW)
    const text = R.renderSnapshotText(E.buildSnapshot(store, config, NOW), null, NOW)
    assert.ok(text.includes('⚠ 固定事实超限未注入：p5'))
    assert.ok(text.includes('共 5 条已固定'))
    assert.ok(text.includes('不要静默丢弃'))
  })

  test('召回在许可期内显示，过期后自动变回空', () => {
    const snap = E.buildSnapshot(mkStore([]), E.resolveConfig(null), NOW)
    const recall = {
      at: NOW - 60_000,
      cue: '小林搬家',
      status: 'matched',
      tokens: 20,
      degraded: 'lexical_fallback',
      items: [{ line: '- [a#1] 用户 2026-11-03：小林帮我搬了家' }],
    }
    const fresh = R.renderSnapshotText(snap, recall, NOW)
    assert.ok(fresh.includes('本线索召回（状态 matched，线索「小林搬家」）'))
    assert.ok(fresh.includes('小林帮我搬了家'))

    const stale = R.renderSnapshotText(snap, recall, NOW + R.RECALL_PERMIT_MS + 1)
    assert.ok(stale.includes('本轮无召回'), '过了许可窗口就当作没有召回')
    assert.ok(!stale.includes('小林帮我搬了家'), '过期召回不能继续泄漏原文')
  })
})

describe('归档事件折算', () => {
  test('user/message 折成一条轮次记录，带 turn / seq', () => {
    const entry = A.deriveTurnEntry(
      {
        type: 'user/message',
        seq: 7,
        time: NOW,
        data: { turn: 2, message: { content: [{ type: 'text', text: '你还记得那次搬家吗' }] } },
      },
      null,
    )
    assert.equal(entry.speaker, 'user')
    assert.equal(entry.text, '你还记得那次搬家吗')
    assert.equal(entry.turn, 2)
    assert.equal(entry.seq, 7)
    assert.equal(entry.system_context, false)
    assert.equal(entry.kind, 'turn')
  })

  test('注入的运行时上下文要打标，别当成用户说的话', () => {
    assert.equal(A.looksLikeInjectedContext('【陪伴记忆快照】估算预算'), true)
    assert.equal(A.looksLikeInjectedContext('Current runtime context. 天'), true)
    assert.equal(A.looksLikeInjectedContext('今天好累'), false)
    assert.equal(A.looksLikeInjectedContext(''), false)
    const entry = A.deriveTurnEntry(
      { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: '【陪伴记忆快照】xxx' }] } } },
      null,
    )
    assert.equal(entry.system_context, true)
  })

  test('非对话事件、无正文且无工具调用、缺 seq 一律返回 null', () => {
    assert.equal(A.deriveTurnEntry({ type: 'tool/result', seq: 1 }, null), null)
    assert.equal(A.deriveTurnEntry({ type: 'user/message', seq: 2, data: { message: { content: [] } } }, null), null)
    assert.equal(A.deriveTurnEntry({ type: 'user/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } }, null), null)
    assert.equal(A.deriveTurnEntry(null, null), null)
  })

  test('只有工具调用的轮次也留档，但正文为空', () => {
    const entry = A.deriveTurnEntry(
      {
        type: 'assistant/message',
        seq: 3,
        data: { message: { content: [{ type: 'tool-call', name: 'memory_recall' }] } },
      },
      null,
    )
    assert.equal(entry.text, '')
    assert.deepEqual(entry.tool_calls, ['memory_recall'])
  })

  test('advanceCursor / fillCursor 给 user 消息补上 turn 与 step', () => {
    const cursor = { turn: null, step: null }
    A.advanceCursor(cursor, { type: 'turn/start', data: { turn: 4 } })
    assert.deepEqual(cursor, { turn: 4, step: null })
    A.advanceCursor(cursor, { type: 'step/start', data: { step: 2 } })
    assert.deepEqual(cursor, { turn: 4, step: 2 })
    const entry = { turn: null, step: null }
    A.fillCursor(entry, cursor)
    assert.deepEqual(entry, { turn: 4, step: 2 })
  })
})

describe('归档词法索引', () => {
  const turn = (over = {}) => ({
    kind: 'turn',
    session_id: 's1',
    seq: 1,
    at: '2026-11-03T10:00:00.000Z',
    speaker: 'user',
    text: '普通的闲聊内容',
    ...over,
  })

  test('只收有效对话轮次：注入上下文、非 turn、重复 id 都拒收', () => {
    const index = new ArchiveIndex()
    assert.equal(index.addEntry(turn()), true)
    assert.equal(index.addEntry(turn()), false, '同 id 不能重复入索引')
    assert.equal(index.addEntry(turn({ seq: 2, system_context: true })), false)
    assert.equal(index.addEntry(turn({ seq: 3, kind: 'memory_card' })), false)
    assert.equal(index.addEntry(turn({ seq: 4, text: '   ' })), false)
    assert.equal(index.addEntry(null), false)
    assert.equal(index.size, 1)
  })

  test('关闭时一律不收，也不检索', () => {
    const index = new ArchiveIndex({ enabled: false })
    assert.equal(index.addEntry(turn()), false)
    assert.equal(index.search('npm').accepted, false)
    assert.equal(index.search('npm').degraded, 'disabled')
  })

  test('含拉丁/稀有词的线索才判定 accepted；纯中文线索只给候选', () => {
    const index = new ArchiveIndex()
    index.addEntry(turn({ seq: 1, text: 'npm install 失败 报错 卡住了' }))
    for (let i = 0; i < 40; i += 1) index.addEntry(turn({ seq: 10 + i, text: '普通的闲聊内容' }))

    const latin = index.search('npm 报错', 3)
    assert.equal(latin.hasLatinCue, true)
    assert.equal(latin.rareHit, true)
    assert.equal(latin.accepted, true)
    assert.ok(latin.items.length >= 1)
    assert.match(latin.items[0].excerpt, /npm/)

    const chinese = index.search('报错', 3)
    assert.equal(chinese.hasLatinCue, false)
    assert.equal(chinese.accepted, false, '中文二元组跨词边界会误命中，不足以定案')
    assert.ok(chinese.candidates.length >= 1, '但还是要给候选让用户补线索')
    assert.deepEqual(chinese.items, [])
  })

  test('同分时按 id 升序，结果可复现', () => {
    const index = new ArchiveIndex()
    index.addEntry(turn({ seq: 2, text: '小林 搬家' }))
    index.addEntry(turn({ seq: 1, text: '小林 搬家' }))
    const a = index.search('小林 搬家', 3).candidates.map((c) => c.id)
    const b = index.search('小林 搬家', 3).candidates.map((c) => c.id)
    assert.deepEqual(a, b)
    assert.deepEqual(a, [...a].sort())
  })

  test('rebuild 从归档行重建，坏行由 store 侧吞掉；ensureFresh 首轮全量', async () => {
    const lines = [turn({ seq: 1 }), turn({ seq: 2, text: '小林搬家' }), turn({ seq: 3, kind: 'memory_card' })]
    const fakeStore = { archivePath: join(tmpDir('idx'), 'archive.jsonl'), readArchiveLines: async () => lines }
    const index = new ArchiveIndex()
    const fresh = await index.ensureFresh(fakeStore)
    assert.equal(fresh.rebuilt, true)
    assert.equal(fresh.entries, 2)
    const again = await index.ensureFresh(fakeStore)
    assert.equal(again.rebuilt, false, '间隔内且文件没变，不重建')
    const stats = index.stats()
    assert.equal(stats.entries, 2)
    assert.ok(stats.distinctTokens > 0)
  })
})

describe('存储', () => {
  test('空目录 load 正常；坏 JSON 不崩，按空库处理', async () => {
    const empty = new MemoryStore(tmpDir('empty'))
    await empty.load()
    assert.equal(empty.size(), 0)

    const broken = tmpDir('broken')
    writeFileSync(join(broken, 'records.json'), '{ 这不是 json', 'utf8')
    writeFileSync(join(broken, 'state.json'), '[1,2', 'utf8')
    const store = new MemoryStore(broken)
    await store.load()
    assert.equal(store.size(), 0)
    assert.equal(store.state.entity.current_state, '')
    assert.equal(store.state.counters.interactions, 0)
    assert.deepEqual(store.state.pin_overflow, [])
  })

  test('put / get / remove 往返，落盘后新实例能读到', async () => {
    const dir = tmpDir('roundtrip')
    const store = new MemoryStore(dir)
    await store.load()
    await store.put(mkRecord({ id: 'a1', summary: '老大的生日' }))
    await store.saveState()
    assert.equal(store.get('a1').summary, '老大的生日')
    assert.equal(store.has('a1'), true)

    const reopened = new MemoryStore(dir)
    await reopened.load()
    assert.equal(reopened.size(), 1)
    assert.equal(reopened.get('a1').summary, '老大的生日')

    assert.equal(await reopened.remove('a1'), true)
    assert.equal(await reopened.remove('a1'), false, '删第二次要返回 false')
    assert.equal(reopened.size(), 0)
  })

  test('归档读取跳过坏行，purge 只删命中项并保留坏行', async () => {
    const dir = tmpDir('archive')
    const store = new MemoryStore(dir)
    await store.load()
    await store.archiveTurn({ kind: 'turn', session_id: 's1', seq: 1, at: '2026-11-01T00:00:00Z', speaker: 'user', text: '甲' })
    await store.archiveTurn({ kind: 'turn', session_id: 's2', seq: 1, at: '2026-11-02T00:00:00Z', speaker: 'user', text: '乙' })
    await store.archive({ kind: 'memory_card', memory_id: 'a1', summary: '丙' })

    const lines = (await store.readArchiveLines()).length
    assert.equal(lines, 3)

    const removed = await store.purgeArchive('a1')
    assert.equal(removed, 1, '按 memory_id 清派生副本')
    assert.equal((await store.readArchiveLines()).length, 2)

    writeFileSync(store.archivePath, `${readFileSync(store.archivePath, 'utf8')}这不是 json\n`, 'utf8')
    const kept = await store.readArchiveLines()
    assert.equal(kept.length, 2, '坏行只跳过，不影响其余条目')

    const stats = await store.archiveStats()
    assert.equal(stats.turns, 2)
    assert.equal(stats.memoryCards, 0)
    assert.equal(stats.bySpeaker.user, 2)
    assert.equal(stats.sessions, 2)
    assert.ok(stats.bytes > 0)
  })

  test('resolveDataDir：显式配置优先，其次 DSH_HOME', () => {
    const explicit = resolveDataDir({ dataDir: join(tmpdir(), 'x-mem') })
    assert.equal(explicit, join(tmpdir(), 'x-mem'))
    const old = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = join(tmpdir(), 'dsh-home')
      assert.equal(resolveDataDir(null), join(tmpdir(), 'dsh-home', 'companion-memory'))
    } finally {
      if (old === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = old
    }
  })
})

describe('模块装配与面板契约', () => {
  const dataDir = tmpDir('routes')

  function makeApi() {
    const routes = new Map()
    const toolFns = []
    const contexts = []
    let body = {}
    const promptCtx = {
      effect: (fn) => {
        fn()
        return () => {}
      },
      systemPrompt: {
        section: (def) => {
          contexts.push({ kind: 'section', def })
          return () => {}
        },
        context: (def) => {
          contexts.push({ kind: 'context', def })
          return () => {}
        },
      },
    }
    const dsh = {
      inject: (_deps, cb) => cb(promptCtx),
      on: () => {},
      get: () => null,
      effect: (fn) => fn(),
    }
    const api = {
      id: 'companion',
      dir: MOD,
      version: 'test',
      log: { info() {}, warn() {}, debug() {}, error() {} },
      dataDir: (...p) => join(dataDir, ...p),
      config: () => ({ companionDataDir: dataDir }),
      settings: () => ({ enabled: true, memorySnapshotTokens: 1600, pinnedTokens: 160, hotTokens: 960, recalledTokens: 480 }),
      saveSettings: () => ({}),
      route: (p, h) => routes.set(p, h),
      tool: (fn) => toolFns.push(fn),
      defineTool: (d) => d,
      onDispose: () => {},
      every: () => () => {},
      later: () => () => {},
      core: {
        hub: null,
        http: {
          send: () => {},
          query: (req) => (req && req.query) || {},
          body: async () => body,
        },
      },
      dsh,
    }
    return { api, routes, toolFns, contexts, setBody: (b) => { body = b } }
  }

  test('入口与 module.json 的 id / version / api 一致', () => {
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.id, mod.id)
    assert.equal(m.version, mod.version)
    assert.equal(m.api, mod.api)
    assert.equal(typeof mod.setup, 'function')
  })

  test('setup 注册 6 条面板路由，前缀统一是 /companion', () => {
    const { api, routes } = makeApi()
    mod.setup(api)
    for (const p of ['/companion/state', '/companion/records', '/companion/record/delete', '/companion/record/pin', '/companion/lifecycle', '/companion/archive/stats']) {
      assert.ok(routes.has(p), `${p} 没注册上`)
    }
  })

  test('/state 返回客户端需要的字段，空库也不崩', async () => {
    const { api, routes } = makeApi()
    mod.setup(api)
    const res = await routes.get('/companion/state')({})
    assert.equal(res.ok, true)
    assert.equal(res.dataDir, dataDir)
    assert.equal(typeof res.stats.records, 'number')
    assert.equal(res.budgets.pinnedTokens, 160)
    assert.ok(Array.isArray(res.snapshot.pinned) && Array.isArray(res.snapshot.hot))
    assert.equal(typeof res.continuity.basePersona, 'string')
    assert.equal(res.tokens.mode, 'estimated')
    assert.equal(res.tokens.budgets.recalled, 480)
    // 空库时给的是默认连续性实体（不是 undefined），客户端可以直接读字段
    assert.equal(res.entity.base_persona, '')
    assert.equal(res.entity.current_state, '')
    assert.equal(typeof res.entity.state_version, 'number')
  })

  test('/records 支持 q 过滤，返回 items + count', async () => {
    const { api, routes, setBody } = makeApi()
    const { store } = mod.setup(api)
    await routes.get('/companion/state')({}) // 等 ready
    await store.put(mkRecord({ id: 'a1', summary: '老大喜欢清淡的' }))
    await store.put(mkRecord({ id: 'b1', summary: '周末去钓鱼' }))

    const all = await routes.get('/companion/records')({ query: {} })
    assert.equal(all.ok, true)
    assert.ok(all.count >= 2)
    assert.ok(all.items.some((r) => r.id === 'a1'))

    const hit = await routes.get('/companion/records')({ query: { q: '钓鱼' } })
    assert.equal(hit.count, 1)
    assert.equal(hit.items[0].id, 'b1')
    setBody({})
  })

  test('/record/pin 与 /record/delete 的契约', async () => {
    const { api, routes, setBody } = makeApi()
    const { store } = mod.setup(api)
    await routes.get('/companion/state')({})
    await store.put(mkRecord({ id: 'a1', summary: '待固定' }))

    setBody({ id: 'a1', pinned: true })
    const pinned = await routes.get('/companion/record/pin')({})
    assert.equal(pinned.ok, true)
    assert.equal(pinned.message, '固定了')
    assert.equal(store.get('a1').tier, 'pinned')

    setBody({ id: 'a1', pinned: false })
    const unpinned = await routes.get('/companion/record/pin')({})
    assert.equal(unpinned.message, '取消固定')
    assert.equal(store.get('a1').tier, 'hot')

    setBody({ id: '不存在' })
    const missing = await routes.get('/companion/record/pin')({})
    assert.equal(missing.ok, false)
    assert.equal(missing.message, '没有这条记忆')

    setBody({ id: 'a1' })
    const deleted = await routes.get('/companion/record/delete')({})
    assert.equal(deleted.ok, true)
    assert.equal(store.has('a1'), false)
    assert.equal(existsSync(join(dataDir, 'records.json')), true)
  })

  test('/lifecycle 强制跑一次并返回 report', async () => {
    const { api, routes } = makeApi()
    mod.setup(api)
    const res = await routes.get('/companion/lifecycle')({})
    assert.equal(res.ok, true)
    assert.ok(Array.isArray(res.report.changes))
    assert.ok(Array.isArray(res.report.pinOverflow))
    assert.equal(typeof res.report.hotPoolSize, 'number')
  })

  test('注入的系统段落：策略文本非空，快照里带预算说明', async () => {
    const { api, routes, contexts } = makeApi()
    mod.setup(api)
    await routes.get('/companion/state')({}) // 等 store ready
    const section = contexts.find((c) => c.kind === 'section')
    const context = contexts.find((c) => c.kind === 'context')
    assert.ok(section && context, '策略与快照都要挂上')
    assert.ok(section.def.text().includes('冷热分层'))
    const snapshot = context.def.text()
    assert.ok(snapshot.includes('【陪伴记忆快照】'))
    assert.ok(snapshot.includes('互不借用'))
  })

  test('注册的 6 个记忆工具都在', async () => {
    const { api, toolFns } = makeApi()
    mod.setup(api)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const names = toolFns.map((fn) => fn({ chat: { kind: 'private' } }).name)
    assert.deepEqual(names.sort(), [
      'memory_archive',
      'memory_continuity',
      'memory_forget',
      'memory_recall',
      'memory_remember',
      'memory_status',
    ])
  })
})
