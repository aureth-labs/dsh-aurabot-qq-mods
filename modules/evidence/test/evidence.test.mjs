// evidence（记忆晋升）回归测试
//
// 模块语义：事实被反复提到就攒证据分，分数够了长成反思，反思够了长成人格片段。
// 重点锁住的约束：
//   · 半衰期数学必须准：30 天后正好剩一半，否则「最近还重要吗」的判断整体偏
//   · 阈值是边界敏感的：1.0 就该 confirmed，0.9999 还不该
//   · 连提加成只在 24 小时内算，隔天再说一遍不该白送分
//   · 降级有黏性：曾经钉稳的事实掉分了也留在 confirmed，免得来回跳
//   · 空账本 / 坏文件都不能炸（这个模块每 60 秒跑一次，炸一次就没人算账了）
// 这里只测纯逻辑：文件住在临时目录里，不读真实用户目录、不联网。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const E = await import(new URL('../lib/engine.js', import.meta.url).href)
const ST = await import(new URL('../lib/store.js', import.meta.url).href)

const DAY = 86400000
/** 固定「现在」，让所有衰减计算都是确定的 */
const NOW = Date.parse('2026-06-01T00:00:00.000Z')

const iso = (ms) => new Date(ms).toISOString()

/** 造一条事实记录（companion-memory 那边的形状）。默认「刚刚被实质提过一次」 */
function record(id, { topic = 'work', mentions = [[NOW]], pinned = false, status, recallOnly = false, summary } = {}) {
  const rec = {
    id,
    topic_id: topic,
    summary: summary ?? `关于 ${id} 的事实`,
    mention_events: mentions.map(([at, kind = 'substantive']) => ({ occurred_at: iso(at), kind })),
  }
  if (pinned) rec.pinned = true
  if (status) rec.status = status
  if (recallOnly) rec.recall_only = true
  return rec
}

describe('衰减：半衰期数学', () => {
  test('正好一个半衰期后剩一半（30 天 / 180 天两条都要准）', () => {
    // 这个数是整个模块的地基：偏一点，久远事实的分数就会系统性偏高低
    assert.equal(E.decayFactor(30 * DAY, E.REIN_HALF_LIFE_DAYS), 0.5)
    assert.equal(E.decayFactor(180 * DAY, E.DISP_HALF_LIFE_DAYS), 0.5)
  })

  test('两个半衰期剩四分之一，三个剩八分之一', () => {
    assert.equal(E.decayFactor(60 * DAY, 30), 0.25)
    assert.equal(E.decayFactor(90 * DAY, 30), 0.125)
  })

  test('年龄 0 或负数（时钟倒退）恒为 1，不放大分数', () => {
    // 系统时间往回跳时，如果算出 >1 的衰减因子，证据分会凭空暴涨
    assert.equal(E.decayFactor(0, 30), 1)
    assert.equal(E.decayFactor(-1, 30), 1)
    assert.equal(E.decayFactor(-DAY, 30), 1)
  })

  test('非法输入不产出 NaN', () => {
    // NaN 一旦流进 evidence，阈值比较全都会静默失效
    assert.equal(E.decayFactor(NaN, 30), 1)
    assert.equal(E.decayFactor(Infinity, 30), 1)
    assert.ok(Number.isFinite(E.decayFactor(DAY, 0)))
    assert.ok(Number.isFinite(E.decayFactor(DAY, null)))
  })
})

describe('mentionsOf：把提及事件整理成时间线', () => {
  test('按时间排序并保留 kind，乱序输入也要排好', () => {
    const rec = record('a', { mentions: [] })
    rec.mention_events = [
      { occurred_at: iso(NOW), kind: 'substantive' },
      { occurred_at: iso(NOW - 2 * DAY), kind: 'passing' },
      { occurred_at: iso(NOW - DAY), kind: 'substantive' },
    ]
    const list = E.mentionsOf(rec)
    assert.equal(list.length, 3)
    assert.deepEqual(list.map((m) => m.at), [NOW - 2 * DAY, NOW - DAY, NOW])
    assert.deepEqual(list.map((m) => m.kind), ['passing', 'substantive', 'substantive'])
  })

  test('坏时间戳的事件被丢掉，不会变成 NaN 参与计算', () => {
    const rec = record('a', { mentions: [] })
    rec.mention_events = [
      { occurred_at: '不是时间', kind: 'substantive' },
      { occurred_at: null },
      {},
      { occurred_at: iso(NOW), kind: 'substantive' },
    ]
    const list = E.mentionsOf(rec)
    assert.equal(list.length, 1)
    assert.equal(list[0].at, NOW)
  })

  test('没有 mention_events 的老数据回落到 last_user_mention_at / created_at', () => {
    // 老记录如果直接算成 0 分，会被立刻归档 —— 这是最伤的一种回归
    const byLast = E.mentionsOf({ id: 'x', last_user_mention_at: '2026-05-01T00:00:00.000Z' })
    assert.equal(byLast.length, 1)
    assert.equal(byLast[0].kind, 'substantive', '老数据默认按实质性提及算')

    const byCreated = E.mentionsOf({ id: 'x', created_at: '2026-05-01T00:00:00.000Z' })
    assert.equal(byCreated.length, 1)

    // 什么都没有就返回空数组，而不是塞一个 undefined
    assert.deepEqual(E.mentionsOf({ id: 'x' }), [])
    assert.deepEqual(E.mentionsOf(null), [])
  })
})

describe('scoreFact：打分与阈值边界', () => {
  test('刚提一次正好 1.0 分，落在 CONFIRMED 边界上', () => {
    const score = E.scoreFact(record('a', { mentions: [[NOW]] }), NOW)
    assert.equal(score.evidence, E.CONFIRMED_THRESHOLD, '刚刚说过一次必须正好等于确认阈值')
    assert.equal(score.substantive, 1)
    assert.equal(score.comboActive, false)
    assert.equal(E.stageFor(score.evidence), 'confirmed', '等于阈值就该算确认，不能卡在 candidate')
  })

  test('30 天前只提过一次 = 0.5 分，低于阈值还是 candidate', () => {
    const score = E.scoreFact(record('a', { mentions: [[NOW - 30 * DAY]] }), NOW)
    assert.equal(score.evidence, 0.5)
    assert.equal(E.stageFor(score.evidence), 'candidate')
  })

  test('passing 提及只计数不计分', () => {
    // 「随口带一句」不该被当成真的重要
    const score = E.scoreFact(record('a', { mentions: [[NOW, 'passing']] }), NOW)
    assert.equal(score.evidence, 0)
    assert.equal(score.mentions, 1)
    assert.equal(score.substantive, 0)
  })

  test('24 小时内连着提两次有 +0.5 加成，隔天再提就没有', () => {
    const close = E.scoreFact(record('a', { mentions: [[NOW - 3600_000], [NOW]] }), NOW)
    assert.equal(close.comboActive, true)
    // 两次各约 1 分 + 0.5 加成
    assert.ok(close.evidence > 2.4 && close.evidence < 2.6, `连提应该拿到加成，实际 ${close.evidence}`)

    const far = E.scoreFact(record('b', { mentions: [[NOW - 3 * DAY], [NOW]] }), NOW)
    assert.equal(far.comboActive, false, '间隔超过 24 小时不算连着说')
    // 1 分（刚说）+ 0.933（三天前说的衰减后），没有那 0.5 的加成
    assert.ok(far.evidence < 2, `不该白送加成，实际 ${far.evidence}`)
    assert.ok(Math.abs(far.evidence - 1.933) < 0.01, `实际 ${far.evidence}`)
  })

  test('pinned 直接锁在 PROMOTED_THRESHOLD，永不衰减', () => {
    // 主人手动钉住的东西不该因为「很久没提」掉下去
    const score = E.scoreFact(record('a', { mentions: [[NOW - 999 * DAY]], pinned: true }), NOW)
    assert.equal(score.evidence, E.PROMOTED_THRESHOLD)
    assert.equal(score.pinned, true)
    assert.equal(score.comboActive, false)
    assert.equal(score.lastAt, iso(NOW - 999 * DAY), '最后提及时间还是要报出来')
    assert.equal(E.stageFor(score.evidence), 'promoted')
  })

  test('同时被提很多次也不会超过合理量级（衰减是真的在算）', () => {
    const mentions = []
    // 每 40 天提一次，全部落在 40~1200 天前
    for (let i = 1; i <= 30; i++) mentions.push([NOW - i * 40 * DAY])
    const score = E.scoreFact(record('a', { mentions }), NOW)
    // 最早几次早已衰减到几乎为 0，总和应该只是个位数
    assert.ok(score.evidence < 5, `久远的一堆提及不该还高分，实际 ${score.evidence}`)
    assert.ok(score.evidence > 0, '也不该归零')
    assert.equal(score.substantive, 30)
  })
})

describe('stageFor：升降级', () => {
  test('三个阈值的边界都按「大于等于」算', () => {
    assert.equal(E.stageFor(E.PROMOTED_THRESHOLD), 'promoted')
    assert.equal(E.stageFor(E.PROMOTED_THRESHOLD - 0.0001), 'confirmed')
    assert.equal(E.stageFor(E.CONFIRMED_THRESHOLD), 'confirmed')
    assert.equal(E.stageFor(E.CONFIRMED_THRESHOLD - 0.0001), 'candidate')
    assert.equal(E.stageFor(E.ARCHIVE_THRESHOLD), 'archive')
    assert.equal(E.stageFor(E.ARCHIVE_THRESHOLD - 0.1), 'archive')
  })

  test('降级有黏性：曾经 confirmed 的掉分后仍留在 confirmed', () => {
    // 否则一条事实会在阈值附近每轮刷一次「discovered / stage」事件，日志和提示全被淹
    assert.equal(E.stageFor(0.2, 'confirmed'), 'confirmed')
    assert.equal(E.stageFor(0.2, 'promoted'), 'confirmed')
    assert.equal(E.stageFor(0.2, 'candidate'), 'candidate')
    assert.equal(E.stageFor(0.2, undefined), 'candidate')
  })

  test('掉到 ARCHIVE_THRESHOLD 以下就真的归档，黏性也拦不住', () => {
    assert.equal(E.stageFor(-2.5, 'promoted'), 'archive')
    assert.equal(E.stageFor(-2.5, 'confirmed'), 'archive')
  })

  test('isStableStage 只认 confirmed / promoted', () => {
    assert.equal(E.isStableStage('confirmed'), true)
    assert.equal(E.isStableStage('promoted'), true)
    assert.equal(E.isStableStage('candidate'), false)
    assert.equal(E.isStableStage('archive'), false)
    assert.equal(E.isStableStage('gone'), false)
    assert.equal(E.isStableStage(undefined), false)
  })
})

describe('幂等 id', () => {
  test('反思 id 对事实顺序不敏感，同一批事实永远是同一个 id', () => {
    const a = E.reflectionId('work', ['f1', 'f2', 'f3'])
    const b = E.reflectionId('work', ['f3', 'f1', 'f2'])
    assert.equal(a, b, '顺序变了 id 也变的话，每轮都会写出一条「新」反思')
    assert.notEqual(a, E.reflectionId('hobby', ['f1', 'f2', 'f3']), '主题不同必须是不同 id')
    assert.notEqual(a, E.reflectionId('work', ['f1', 'f2']), '事实集合不同必须是不同 id')
    assert.match(a, /^refl-[0-9a-f]{12}$/)
  })

  test('人格 id 只跟主题有关，且稳定', () => {
    assert.equal(E.personaId('work'), E.personaId('work'))
    assert.notEqual(E.personaId('work'), E.personaId('hobby'))
    assert.match(E.personaId('work'), /^persona-[0-9a-f]{12}$/)
  })
})

describe('advance：从事实推演出反思和人格', () => {
  test('两条同主题事实够格写反思，事件里要报出来', () => {
    const { store, events } = E.advance({}, [record('a'), record('b')], NOW)
    assert.equal(Object.keys(store.facts).length, 2)
    assert.equal(store.facts.a.stage, 'confirmed')
    assert.equal(store.reflections.length, 1, `两条事实就该产出一条待写反思（门槛 ${E.REFLECTION_MIN_FACTS}）`)
    const refl = store.reflections[0]
    assert.equal(refl.topic_id, 'work')
    assert.deepEqual(refl.fact_ids, ['a', 'b'])
    assert.equal(refl.status, 'pending')
    assert.equal(refl.evidence, 2)
    const types = events.map((e) => e.type)
    assert.ok(types.includes('discovered'))
    assert.ok(types.includes('reflection-pending'))
  })

  test('只有一条事实不够格写反思', () => {
    const { store } = E.advance({}, [record('a')], NOW)
    assert.equal(store.reflections.length, 0)
  })

  test('general / misc 这类泛用桶不算主题（凑一起就是胡编）', () => {
    for (const topic of ['general', 'misc', 'other', 'General', '']) {
      const { store } = E.advance({}, [record('a', { topic }), record('b', { topic })], NOW)
      assert.equal(store.reflections.length, 0, `主题「${topic}」不该长成反思`)
    }
    // 但事实本身照样记账
    const { store } = E.advance({}, [record('a', { topic: 'general' })], NOW)
    assert.ok(store.facts.a, '泛用桶里的事实还是要记分')
  })

  test('recall_only 和 superseded / deleted 的记录不进反思', () => {
    // recall_only = 主人说「别主动提」，那就不能拿它写反思；superseded 是被更正的旧事实
    const { store, events } = E.advance({}, [
      record('a', { recallOnly: true }),
      record('b', { status: 'superseded' }),
      record('c', { status: 'deleted' }),
      record('d'),
    ], NOW)
    assert.equal(store.reflections.length, 0)
    assert.equal(store.facts.b, undefined, '被更正的旧事实不该再占一个坑')
    assert.equal(store.facts.c, undefined)
    assert.equal(store.facts.a.recall_only, true)
    // 只有 d 是稳定的
    assert.ok(events.every((e) => e.id !== 'b' && e.id !== 'c'))
  })

  test('两轮 fact 集合没变时，反思不会重复长出来（幂等）', () => {
    const first = E.advance({}, [record('a'), record('b')], NOW)
    const second = E.advance(first.store, [record('a'), record('b')], NOW + 60_000)
    assert.equal(second.store.reflections.length, 1, '同一批事实只该有一条反思')
    assert.equal(second.store.reflections[0].id, first.store.reflections[0].id)
    assert.deepEqual(second.events, [], '什么都没变就不该冒事件')
    // 证据分随时间衰减，但阶段不能因此抖动
    assert.equal(second.store.facts.a.stage, 'confirmed')
    assert.equal(second.store.facts.a.firstSeen, first.store.facts.a.firstSeen, 'firstSeen 不能被刷新')
  })

  test('事实从记录里消失会标成 gone，而不是直接抹掉', () => {
    const first = E.advance({}, [record('a'), record('b')], NOW)
    const second = E.advance(first.store, [record('a')], NOW + 1000)
    assert.equal(second.store.facts.b.stage, 'gone')
    assert.equal(second.store.facts.a.stage, 'confirmed', '还在的事实不受影响')
    assert.ok(second.events.some((e) => e.type === 'gone' && e.id === 'b'))
  })

  test('撑起待写反思的事实全没了，反思要作废（已修：原来会一直让她写空账）', () => {
    // 不处理的话 renderDigest 会一直提示「还欠一段反思」，而那段反思指向的事实已经删了，
    // 她只能靠编。只丢 pending（还没动笔的），ready 是她真写下的痕迹，要留着。
    const first = E.advance({}, [record('a'), record('b')], NOW)
    const second = E.advance(first.store, [], NOW + 1000)
    assert.equal(second.store.reflections[0].status, 'archived')
    assert.ok(second.events.some((e) => e.type === 'reflection-dropped'))
    assert.equal(E.renderDigest(second.store), '', '没有东西可说时不该吐提要')
  })

  test('已写好的反思不会因为事实被删就消失', () => {
    const first = E.advance({}, [record('a'), record('b')], NOW)
    E.writeReflection(first.store, first.store.reflections[0].id, '他很在意把活干完')
    const second = E.advance(first.store, [], NOW + 1000)
    assert.equal(second.store.reflections[0].status, 'ready')
    assert.equal(second.store.reflections[0].text, '他很在意把活干完')
  })

  test('两条写好的反思 + 足够证据会长出人格片段', () => {
    const first = E.advance({}, [record('a'), record('b')], NOW)
    E.writeReflection(first.store, first.store.reflections[0].id, '他很在意把活干完')
    // 手工补一条同主题的 ready 反思，凑够 PERSONA_MIN_REFLECTIONS
    first.store.reflections.push({
      id: 'refl-manual', topic_id: 'work', fact_ids: ['zzz'], evidence: 3, status: 'ready', text: '他习惯先做难的',
    })
    const second = E.advance(first.store, [record('a'), record('b')], NOW + 2000)
    assert.equal(second.store.persona.length, 1)
    const persona = second.store.persona[0]
    assert.equal(persona.topic_id, 'work')
    assert.equal(persona.id, E.personaId('work'))
    assert.equal(persona.status, 'pending')
    assert.ok(persona.evidence >= E.PERSONA_MIN_EVIDENCE)
    assert.ok(second.events.some((e) => e.type === 'persona-pending'))
  })

  test('证据不够 PERSONA_MIN_EVIDENCE 时长不出人格', () => {
    const store = {
      reflections: [
        { id: 'r1', topic_id: 'work', fact_ids: ['a'], evidence: 1, status: 'ready', text: '一' },
        { id: 'r2', topic_id: 'work', fact_ids: ['b'], evidence: 1, status: 'ready', text: '二' },
      ],
    }
    const { store: next } = E.advance(store, [], NOW)
    assert.equal(next.persona.length, 0, '两条薄反思加起来才 2 分，不该长人格')
  })

  test('空账本 advance 不炸，版本号补上', () => {
    const { store, events } = E.advance({}, [], NOW)
    assert.equal(store.version, 1)
    assert.deepEqual(store.facts, {})
    assert.deepEqual(store.reflections, [])
    assert.deepEqual(store.persona, [])
    assert.deepEqual(events, [])
    assert.equal(store.updated_at, iso(NOW))
  })

  test('没有 id 的脏记录被跳过，不影响别的记录', () => {
    const { store } = E.advance({}, [null, {}, { id: 42 }, record('ok')], NOW)
    assert.deepEqual(Object.keys(store.facts), ['ok'])
  })
})

describe('renderDigest / summarize：空账本与提要', () => {
  test('空 store 的 summarize 全是 0，renderDigest 给空串', () => {
    // 这个提要是每轮拼进提示词的，空账本时返回 '【记忆证据】' 这种空标题纯浪费 token
    const summary = E.summarize({})
    assert.deepEqual(summary, {
      facts: 0, candidate: 0, confirmed: 0, promoted: 0,
      reflections: 0, reflectionsPending: 0, reflectionsReady: 0,
      persona: 0, personaReady: 0, updatedAt: null,
    })
    assert.equal(E.renderDigest({}), '')
    assert.equal(E.renderDigest(ST.EMPTY_STORE), '')
    assert.equal(E.summarize(ST.EMPTY_STORE).facts, 0)
  })

  test('summarize 按阶段数清楚，gone 的也算在总数里', () => {
    const first = E.advance({}, [record('a'), record('b')], NOW)
    const second = E.advance(first.store, [record('a')], NOW + 1000)
    const s = E.summarize(second.store)
    assert.equal(s.facts, 2, 'gone 的事实仍在账上留痕，总数为 2')
    assert.equal(s.confirmed, 1)
    assert.equal(s.reflections, 1)
    assert.equal(s.reflectionsPending, 1)
    assert.equal(s.updatedAt, iso(NOW + 1000))
  })

  test('有欠着的反思时提要会说清楚是哪几件事实', () => {
    const { store } = E.advance({}, [record('a', { summary: '喜欢深夜写代码' }), record('b', { summary: '讨厌被打断' })], NOW)
    const digest = E.renderDigest(store)
    assert.ok(digest.startsWith('【记忆证据】'))
    assert.ok(digest.includes('work'), `要说清主题，实际：${digest}`)
    assert.ok(digest.includes('喜欢深夜写代码'), `要带上支撑的事实，实际：${digest}`)
    assert.ok(digest.includes('讨厌被打断'))
  })

  test('maxLines 为 0 时给空串，而不是一个空标题（已修）', () => {
    const { store } = E.advance({}, [record('a'), record('b')], NOW)
    assert.equal(E.renderDigest(store, { maxLines: 0 }), '')
    // maxLines 正常时按行数截断
    const limited = E.renderDigest(store, { maxLines: 1 })
    assert.ok(limited.split('\n').length <= 2, '标题 + 一行')
  })
})

describe('store：落盘与读取', () => {
  /** 每个用例一个独立临时目录，跑完就删 */
  function withTmp(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'aurabot-evidence-'))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('saveStore / readStore 往返保真', () => {
    withTmp((dir) => {
      const file = join(dir, 'evidence.json')
      const store = {
        version: 1,
        updated_at: iso(NOW),
        facts: { a: { id: 'a', stage: 'confirmed', evidence: 1.5, summary: '中文也要能存' } },
        reflections: [{ id: 'r1', topic_id: 'work', status: 'pending' }],
        persona: [],
      }
      ST.saveStore(file, store)
      assert.deepEqual(ST.readStore(file), store)

      // 文件名里的中文也不要出问题
      const cn = join(dir, '证据-账本.json')
      ST.saveStore(cn, store)
      assert.equal(ST.readStore(cn).facts.a.summary, '中文也要能存')
    })
  })

  test('读不到 / 读坏了 / 空文件都回落到空账本，不抛', () => {
    withTmp((dir) => {
      assert.deepEqual(ST.readStore(join(dir, '不存在.json')), ST.EMPTY_STORE)

      const blank = join(dir, 'blank.json')
      writeFileSync(blank, '   \n')
      assert.deepEqual(ST.readStore(blank), ST.EMPTY_STORE)

      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '{这不是 json')
      assert.deepEqual(ST.readStore(bad), ST.EMPTY_STORE)
    })
  })

  test('读到形状不对的字段会被修回可用类型', () => {
    // 手改账本或者旧版本写坏字段时，不能让 facts=null 一路传到渲染里
    withTmp((dir) => {
      const file = join(dir, 'weird.json')
      writeFileSync(file, JSON.stringify({ facts: null, reflections: 'x', persona: 3, updated_at: 'y' }))
      const store = ST.readStore(file)
      assert.deepEqual(store.facts, {})
      assert.deepEqual(store.reflections, [])
      assert.deepEqual(store.persona, [])
      assert.equal(store.version, 1, '缺的字段要补默认值')
      assert.equal(store.updated_at, 'y', '有的字段要保留')
    })
  })

  test('每次读空账本拿到的是新对象，改坏它不会污染 EMPTY_STORE', () => {
    withTmp((dir) => {
      const a = ST.readStore(join(dir, 'none.json'))
      a.facts.脏 = { id: '脏' }
      a.reflections.push({ id: 'x' })
      assert.deepEqual(ST.EMPTY_STORE.facts, {})
      assert.deepEqual(ST.EMPTY_STORE.reflections, [])
      assert.deepEqual(ST.readStore(join(dir, 'none.json')), ST.EMPTY_STORE)
    })
  })

  test('writeAtomic 自动建目录，并且不留临时文件', () => {
    withTmp((dir) => {
      const file = join(dir, 'deep', 'deeper', 'x.txt')
      ST.writeAtomic(file, 'hello')
      assert.equal(readFileSync(file, 'utf8'), 'hello')
      // 临时文件必须清干净，否则每分钟一次会把目录塞满
      assert.deepEqual(readdirSync(join(dir, 'deep', 'deeper')), ['x.txt'])
    })
  })

  test('writeAtomic 覆盖已有文件（rename 是原子替换）', () => {
    withTmp((dir) => {
      const file = join(dir, 'y.txt')
      ST.writeAtomic(file, '第一版')
      ST.writeAtomic(file, '第二版')
      assert.equal(readFileSync(file, 'utf8'), '第二版')
    })
  })

  test('readRecords 同时认数组和 { records: [...] } 两种形状', () => {
    // 两种格式都真实存在过，读错就一条事实都算不出来
    withTmp((dir) => {
      const arr = join(dir, 'arr.json')
      writeFileSync(arr, JSON.stringify([{ id: 'a' }, { id: 'b' }]))
      assert.deepEqual(ST.readRecords(arr).map((r) => r.id), ['a', 'b'])

      const obj = join(dir, 'obj.json')
      writeFileSync(obj, JSON.stringify({ records: [{ id: 'c' }] }))
      assert.deepEqual(ST.readRecords(obj).map((r) => r.id), ['c'])
    })
  })

  test('readRecords 丢掉没有 id 的脏记录，缺失/坏文件给空数组', () => {
    withTmp((dir) => {
      const mixed = join(dir, 'mixed.json')
      writeFileSync(mixed, JSON.stringify([{ id: 'a' }, { nope: 1 }, null, { id: 42 }, 'x']))
      assert.deepEqual(ST.readRecords(mixed).map((r) => r.id), ['a'])

      assert.deepEqual(ST.readRecords(join(dir, 'missing.json')), [])
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '不是 json')
      assert.deepEqual(ST.readRecords(bad), [])
    })
  })
})
