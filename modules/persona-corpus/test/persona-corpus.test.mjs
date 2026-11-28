// persona-corpus（人格素材库）回归测试
//
// 模块语义：群里有人点名「这句太人机」，她把原话收进素材本；
// 主人要的直接入库，群友要的先待审，主人过了才进库。
//
// 重点锁住的约束：
//   · 原话必须照抄：除了压空白，一个字都不许改 —— 改写过的句子就没有收录价值了
//   · id 由「类型 + 原话」算出：同一句收两遍只能留一条，否则群里几个人同时喊「收了」就变三条
//   · 群友写的东西不许直接进库：待审是唯一的入口，先过审才落正本
//   · 演练模式（config.dryRun）不许落盘：模拟测试的假消息不能污染真素材
//   · 主人填的目录不对时要静默回落到数据目录，并且说明原因，不能写到奇怪的地方
//   · 坏行 / 坏文件不许把整个库读不出来
//
// 落盘都在临时目录里，不读真实用户目录，不联网。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const C = await import(new URL('../lib/corpus.js', import.meta.url).href)
const ST = await import(new URL('../lib/store.js', import.meta.url).href)
const H = await import(new URL('../lib/history.js', import.meta.url).href)
const { makeFakeApi, setupModule } = await import(new URL('../../../test/kit.mjs', import.meta.url).href)

const MODULE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENTRY_URL = new URL('../index.mjs', import.meta.url).href

/** 每个用例一个独立临时目录，跑完就删 */
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-persona-corpus-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const OWNER = { chat: { kind: 'private', chatId: 'private:10001' }, sessionId: 'owner-session' }
const MEMBER = { chat: { kind: 'group', chatId: 'group:200' }, sessionId: 'group-session' }

/**
 * 假 api：kit 里没有 context / rule / on 的捕获能力，这里补上，
 * 再给 core.hub 塞一个 turnSendersAllOwner —— 主人判定全靠它。
 */
function makeModule({ settings = {}, config = {}, ownerSessions = ['owner-session'] } = {}) {
  const contexts = []
  const rules = []
  const listeners = new Map()
  const kit = makeFakeApi({
    id: 'persona-corpus',
    moduleDir: MODULE_DIR,
    settings: {
      enabled: true,
      dir: '',
      maxEntries: 200,
      allowMemberAsk: true,
      injectDigest: true,
      digestLimit: 3,
      ...settings,
    },
    config,
    stubs: {
      on: (type, fn) => {
        listeners.set(type, fn)
        return () => listeners.delete(type)
      },
      context: (fn) => contexts.push(fn),
      rule: (fn) => rules.push(fn),
    },
  })
  kit.api.core.hub = { turnSendersAllOwner: (sid) => ownerSessions.includes(sid) }
  return { kit, contexts, rules, listeners }
}

describe('cleanText：原话照抄', () => {
  test('只压连续空白和首尾空白，字一个不改', () => {
    // 反面素材的价值全在「它原样长这样」，多一个字少一个字都会让复现失真
    assert.equal(C.cleanText('  作为AI语言模型，\n\n我无法  回答  '), '作为AI语言模型， 我无法 回答')
    assert.equal(C.cleanText('…你这句好怪[笑]'), '…你这句好怪[笑]')
  })

  test('空字符串和 null 都是空串，不产出 undefined', () => {
    assert.equal(C.cleanText(''), '')
    assert.equal(C.cleanText(null), '')
    assert.equal(C.cleanText('   \n\t '), '')
  })

  test('超长截断到上限并以省略号结尾', () => {
    const long = '啊'.repeat(C.MAX_TEXT + 50)
    const out = C.cleanText(long)
    assert.equal(out.length, C.MAX_TEXT)
    assert.ok(out.endsWith('…'))
  })
})

describe('entryId / parseTags', () => {
  test('类型 + 原话决定 id：同一句同类型永远同一个 id', () => {
    const a = C.entryId('negative', '作为AI语言模型，我无法回答')
    const b = C.entryId('negative', '  作为AI语言模型，我无法回答  ')
    assert.equal(a, b, '只有空白不同就不能算两条')
    assert.match(a, /^c-[0-9a-f]{12}$/)
  })

  test('类型不同 id 就不同（同一句话可以既是反面又是观察）', () => {
    assert.notEqual(C.entryId('negative', '同一句'), C.entryId('note', '同一句'))
  })

  test('标签：中文逗号顿号空格都算分隔，去重并截到 5 个', () => {
    assert.deepEqual(C.parseTags('人机味，自报家门、套话 人机味'), ['人机味', '自报家门', '套话'])
    assert.equal(C.parseTags('a b c d e f g').length, 5)
    assert.deepEqual(C.parseTags('   '), [])
    assert.deepEqual(C.parseTags(['x', 'x', 'y']), ['x', 'y'])
    assert.equal(C.parseTags('这个标签特别特别长长长长长')[0].length, C.MAX_TAG_LEN)
  })
})

describe('makeEntry：一条素材的形状', () => {
  test('空原话给 null，让调用方报错而不是存空壳', () => {
    assert.equal(C.makeEntry({ text: '  ' }), null)
    assert.equal(C.makeEntry({}), null)
  })

  test('默认是反面素材、走工具收录，来源缺字段也不会是 undefined', () => {
    const entry = C.makeEntry({ text: '希望对你有帮助' })
    assert.equal(entry.kind, 'negative')
    assert.equal(entry.via, 'tool')
    assert.deepEqual(entry.tags, [])
    assert.equal(entry.note, '')
    assert.equal(entry.fix, '')
    assert.deepEqual(entry.source, { chatId: '', who: 'member', userId: '', nickname: '' })
  })

  test('不认识的 kind / via / who 回落到安全默认值', () => {
    const entry = C.makeEntry({ kind: '随便写', via: 'hack', source: { who: 'admin' }, text: 'x' })
    assert.equal(entry.kind, 'negative')
    assert.equal(entry.via, 'tool')
    assert.equal(entry.source.who, 'member', '认不出的身份不能升级成主人')
  })

  test('坏时间戳回落成现在，而不是留一个读不出来的 at', () => {
    // at 参与「新的在前」排序和 md 渲染，NaN 会让整份镜像乱序
    const entry = C.makeEntry({ text: 'x', at: '不是时间' })
    assert.ok(Number.isFinite(Date.parse(entry.at)))
    assert.equal(C.formatTime('不是时间'), '时间不明')
  })
})

describe('addEntry：去重与上限', () => {
  test('同一句只收一条，重复时把已有那条还回去', () => {
    const first = C.addEntry([], C.makeEntry({ text: '总之，希望对你有所帮助' }))
    assert.equal(first.ok, true)
    const again = C.addEntry(first.list, C.makeEntry({ text: '总之，希望对你有所帮助' }))
    assert.equal(again.ok, false)
    assert.equal(again.duplicate, true)
    assert.equal(again.list.length, 1)
  })

  test('超过上限从最旧的开始丢，并报出丢了几条', () => {
    let list = []
    for (let i = 0; i < 3; i += 1) list = C.addEntry(list, C.makeEntry({ text: `第${i}句` }), { max: 2 }).list
    assert.deepEqual(list.map((e) => e.text), ['第1句', '第2句'])
    assert.equal(C.addEntry(list, C.makeEntry({ text: '第3句' }), { max: 2 }).dropped, 1)
  })

  test('列表里的脏数据被过滤，不会传染到新列表', () => {
    const result = C.addEntry([null, { text: '没 id' }, C.makeEntry({ text: '正常' })], C.makeEntry({ text: '新的' }))
    assert.equal(result.list.length, 2)
    assert.ok(result.list.every((e) => typeof e.id === 'string'))
  })
})

describe('removeEntries / summarize / pickEntries', () => {
  test('删掉指定的几条，没匹配就报 0', () => {
    const list = [C.makeEntry({ text: 'a' }), C.makeEntry({ text: 'b' })]
    assert.equal(C.removeEntries(list, [list[0].id]).removed, 1)
    assert.equal(C.removeEntries(list, ['c-不存在']).removed, 0)
    assert.equal(C.removeEntries(list, list.map((e) => e.id)).list.length, 0)
  })

  test('统计分类型数，待审只数条数', () => {
    const list = [
      C.makeEntry({ kind: 'negative', text: 'a', at: '2026-11-01T00:00:00.000Z' }),
      C.makeEntry({ kind: 'positive', text: 'b', at: '2026-11-02T00:00:00.000Z' }),
      C.makeEntry({ kind: 'note', text: 'c', at: '2026-11-03T00:00:00.000Z' }),
    ]
    const s = C.summarize(list, [C.makeEntry({ text: '待审的' })])
    assert.deepEqual(s, { total: 3, negative: 1, positive: 1, note: 1, pending: 1, updatedAt: '2026-11-03T00:00:00.000Z' })
    assert.deepEqual(C.summarize([]), { total: 0, negative: 0, positive: 0, note: 0, pending: 0, updatedAt: null })
  })

  test('翻库：新的在前，能按类型和关键词筛，limit 夹在 1~50', () => {
    const list = [
      C.makeEntry({ kind: 'negative', text: '作为AI我无法', note: '自报身份', at: '2026-11-01T00:00:00.000Z' }),
      C.makeEntry({ kind: 'positive', text: '破防了哈哈哈', tags: '口语', at: '2026-11-02T00:00:00.000Z' }),
    ]
    assert.deepEqual(C.pickEntries(list).map((e) => e.text), ['破防了哈哈哈', '作为AI我无法'])
    assert.deepEqual(C.pickEntries(list, { kind: 'negative' }).map((e) => e.text), ['作为AI我无法'])
    assert.deepEqual(C.pickEntries(list, { q: '自报' }).map((e) => e.text), ['作为AI我无法'])
    assert.deepEqual(C.pickEntries(list, { q: '口语' }).map((e) => e.text), ['破防了哈哈哈'])
    assert.equal(C.pickEntries(list, { limit: 999 }).length, 2)
  })
})

describe('renderDigest / renderMarkdown', () => {
  test('空库给空串：每轮拼提示词，空标题纯浪费 token', () => {
    assert.equal(C.renderDigest([], []), '')
    assert.equal(C.renderDigest([], []), '')
  })

  test('提要带上计数、最近几条反面和「换成什么」', () => {
    const list = [
      C.makeEntry({ text: '作为AI语言模型，我无法回答', fix: '这个我真不知道', at: '2026-11-01T00:00:00.000Z' }),
      C.makeEntry({ kind: 'positive', text: '好耶', at: '2026-11-02T00:00:00.000Z' }),
    ]
    const digest = C.renderDigest(list, [C.makeEntry({ text: '待审的' })])
    assert.ok(digest.startsWith('【人格素材】反面 1 · 正面 1 · 观察 0 · 待审 1'))
    assert.ok(digest.includes('作为AI语言模型'))
    assert.ok(digest.includes('这个我真不知道'), '提要里要给出换法，否则她只知道「别这么说」')
    assert.ok(digest.includes('待审'))
  })

  test('limit=0 只报数字，不列条目', () => {
    const list = [C.makeEntry({ text: '作为AI', at: '2026-11-01T00:00:00.000Z' })]
    const digest = C.renderDigest(list, [], { limit: 0 })
    assert.equal(digest.split('\n').length, 1)
    assert.ok(digest.includes('反面 1'))
  })

  test('镜像写清三块字段，并注明「改这份不生效」', () => {
    const entry = C.makeEntry({
      text: '总之，希望对你有帮助',
      note: '客服腔',
      fix: '走了走了',
      tags: '人机味',
      source: { who: 'owner', nickname: '主人' },
      at: '2026-11-01T12:00:00.000Z',
    })
    const md = C.renderMarkdown([entry], { pending: 2 })
    assert.ok(md.includes('# 人格素材库'))
    assert.ok(md.includes('改这份 md 不会生效'))
    assert.ok(md.includes('另有 2 条待审'))
    assert.ok(md.includes('反面素材（别这么说）'))
    assert.ok(md.includes('> 总之，希望对你有帮助'))
    assert.ok(md.includes('- 为什么：客服腔'))
    assert.ok(md.includes('- 换成：走了走了'))
    assert.ok(md.includes('- 标签：人机味'))
    assert.ok(md.includes(entry.id))
  })

  test('空库的镜像给一句「还空着」，不是一张空表', () => {
    assert.ok(C.renderMarkdown([]).includes('还空着'))
  })
})

describe('history：最近消息环', () => {
  test('只留最后 limit 条，空文本不占位', () => {
    const ring = H.makeRing({ limit: 2 })
    ring.push('g1', { who: 'in', text: '一' })
    ring.push('g1', { who: 'in', text: '   ' })
    ring.push('g1', { who: 'in', text: '二' })
    ring.push('g1', { who: 'in', text: '三' })
    assert.equal(ring.size('g1'), 2)
    assert.equal(ring.lastOf('g1').text, '三')
  })

  test('按 messageId 找得回原话，找不到返回 null', () => {
    const ring = H.makeRing()
    ring.push('g1', { who: 'in', text: '这句太人机了', messageId: -12345 })
    assert.equal(ring.findByMessageId('g1', -12345).text, '这句太人机了')
    assert.equal(ring.findByMessageId('g1', '999'), null)
    assert.equal(ring.findByMessageId('没聊过的群', -12345), null)
  })

  test('能不能只取她自己说的那条', () => {
    const ring = H.makeRing()
    ring.push('g1', { who: 'in', text: '群友说的' })
    ring.push('g1', { who: 'out', text: '她说的' })
    assert.equal(ring.at('g1', 0, { who: 'out' }).text, '她说的')
    assert.equal(ring.at('g1', 5), null)
  })
})

describe('store：目录解析与落盘', () => {
  test('没填就用数据目录；填了相对路径回落并说明原因', () => {
    const fallback = join(tmpdir(), 'fallback-dir')
    assert.equal(ST.resolveDir('', fallback).dir, fallback)
    assert.ok(ST.resolveDir('', fallback).note.includes('插件数据目录'))

    const relative = ST.resolveDir('corpus', fallback)
    assert.equal(relative.dir, fallback)
    assert.ok(relative.note.includes('不是绝对路径'), '要说清为什么没用主人填的那个')
  })

  test('指到一个文件上不能用，回落到数据目录', () => {
    withTmp((dir) => {
      const file = join(dir, 'a.txt')
      writeFileSync(file, 'x')
      const got = ST.resolveDir(file, dir)
      assert.equal(got.dir, dir)
      assert.ok(got.note.includes('不是目录'))
    })
  })

  test('绝对路径即使还不存在也接受（写的时候会建）', () => {
    withTmp((dir) => {
      const target = join(dir, '还没建的素材目录')
      const got = ST.resolveDir(target, join(dir, 'fallback'))
      assert.equal(got.dir, resolve(target))
      assert.ok(got.note.includes('主人指定'))
    })
  })

  test('JSONL 往返：中文、坏行、缺文件都不炸', () => {
    withTmp((dir) => {
      const file = join(dir, 'corpus.jsonl')
      assert.deepEqual(ST.readCorpus(file), [])

      const entry = C.makeEntry({ text: '作为AI语言模型，我无法回答' })
      ST.appendCorpus(file, entry)
      ST.appendCorpus(file, C.makeEntry({ text: '好耶' }))
      // 手改坏了一行，另外两行还得读得出来
      writeFileSync(file, `${readFileSync(file, 'utf8')}{这不是 json\n`)
      const list = ST.readCorpus(file)
      assert.equal(list.length, 2)
      assert.equal(list[0].text, '作为AI语言模型，我无法回答')
    })
  })

  test('整份重写能清空，也能覆盖', () => {
    withTmp((dir) => {
      const file = join(dir, 'corpus.jsonl')
      ST.writeCorpus(file, [C.makeEntry({ text: 'a' })])
      assert.equal(ST.readCorpus(file).length, 1)
      ST.writeCorpus(file, [])
      assert.equal(readFileSync(file, 'utf8'), '')
      assert.equal(ST.readCorpus(file).length, 0)
    })
  })

  test('待审队列同时认数组和 { items } 两种形状', () => {
    withTmp((dir) => {
      const file = join(dir, 'pending.json')
      assert.deepEqual(ST.readPending(file), [])

      writeFileSync(file, JSON.stringify([{ id: 'c-1', text: 'a' }]))
      assert.deepEqual(ST.readPending(file).map((e) => e.id), ['c-1'])

      writeFileSync(file, JSON.stringify({ items: [{ id: 'c-2', text: 'b' }, { nope: 1 }] }))
      assert.deepEqual(ST.readPending(file).map((e) => e.id), ['c-2'])

      writeFileSync(file, '不是 json')
      assert.deepEqual(ST.readPending(file), [])

      ST.writePending(file, [{ id: 'c-3', text: 'c' }])
      assert.deepEqual(ST.readPending(file).map((e) => e.id), ['c-3'])
    })
  })

  test('原子写自动建目录、不留临时文件、能覆盖', () => {
    withTmp((dir) => {
      const file = join(dir, 'deep', 'deeper', 'corpus.md')
      ST.writeAtomic(file, '一')
      ST.writeAtomic(file, '二')
      assert.equal(readFileSync(file, 'utf8'), '二')
      assert.deepEqual(readdirSync(join(dir, 'deep', 'deeper')), ['corpus.md'])
    })
  })

  test('statOf 对不存在的文件给 null，不抛', () => {
    withTmp((dir) => {
      assert.equal(ST.statOf(join(dir, 'nope.jsonl')), null)
      const file = join(dir, 'x.md')
      writeFileSync(file, 'abc')
      assert.equal(ST.statOf(file).bytes, 3)
    })
  })
})

describe('接线：工具 / 命令 / 提要', () => {
  test('setup 注册三个工具一个命令，不注册路由（没有面板）', async () => {
    const { kit } = makeModule()
    const { mod, exports } = await setupModule(ENTRY_URL, kit.api)
    try {
      assert.equal(mod.id, 'persona-corpus')
      assert.deepEqual(kit.toolDefs().map((t) => t.name).sort(), ['corpus_list', 'corpus_review', 'corpus_save'])
      assert.deepEqual(kit.commands.map((c) => c.name), ['素材'])
      assert.equal(kit.routes.size, 0, '没有 panel.js 就不该挂没人调用的路由')
      for (const key of ['list', 'recent', 'digest', 'summary', 'save', 'info']) {
        assert.equal(typeof exports[key], 'function', `要给别的模块用的 ${key} 不见了`)
      }
    } finally {
      kit.cleanup()
    }
  })

  test('主人要收的：直接进正本，镜像同时更新', async () => {
    const { kit } = makeModule()
    await setupModule(ENTRY_URL, kit.api)
    try {
      const result = await kit.runTool(
        'corpus_save',
        { text: '作为AI语言模型，我无法回答这个问题', note: '开头自报身份', fix: '这个我真不知道', tags: '人机味 自报家门' },
        OWNER,
      )
      assert.equal(result.ok, true)
      assert.ok(result.message.includes('收好了'))
      const raw = readFileSync(join(kit.dataRoot, 'modules-data/persona-corpus/corpus.jsonl'), 'utf8')
      assert.equal(raw.trim().split('\n').length, 1)
      const entry = JSON.parse(raw.trim())
      assert.equal(entry.kind, 'negative')
      assert.equal(entry.source.who, 'owner')
      assert.deepEqual(entry.tags, ['人机味', '自报家门'])

      const md = readFileSync(join(kit.dataRoot, 'modules-data/persona-corpus/corpus.md'), 'utf8')
      assert.ok(md.includes('作为AI语言模型'))
      assert.ok(md.includes('- 换成：这个我真不知道'))
    } finally {
      kit.cleanup()
    }
  })

  test('同一句收两遍只留一条，且告诉她「早就有」', async () => {
    const { kit } = makeModule()
    await setupModule(ENTRY_URL, kit.api)
    try {
      await kit.runTool('corpus_save', { text: '总之，希望对你有帮助' }, OWNER)
      const again = await kit.runTool('corpus_save', { text: '  总之，希望对你有帮助  ' }, OWNER)
      assert.equal(again.ok, true)
      assert.equal(again.duplicate, true)
      assert.ok(again.message.includes('早就有'))
      const raw = readFileSync(join(kit.dataRoot, 'modules-data/persona-corpus/corpus.jsonl'), 'utf8')
      assert.equal(raw.trim().split('\n').length, 1)
    } finally {
      kit.cleanup()
    }
  })

  test('群友要收的：先进待审，主人过审之后才进库', async () => {
    const { kit, listeners } = makeModule()
    await setupModule(ENTRY_URL, kit.api)
    try {
      // 群里那句从最近消息里捞（她不用整句复述）
      listeners.get('message')({ chatId: 'group:200', text: '这句太人机了', messageId: 777, userId: '20001', nickname: '小 A' })
      const saved = await kit.runTool('corpus_save', { messageId: '777', note: '群友点名' }, MEMBER)
      assert.equal(saved.ok, true)
      assert.equal(saved.pending, true)
      assert.ok(saved.message.includes('待审'))

      const dirOf = join(kit.dataRoot, 'modules-data/persona-corpus')
      assert.equal(existsSync(join(dirOf, 'corpus.jsonl')), false, '没过审就不该落正本')
      const pending = JSON.parse(readFileSync(join(dirOf, 'pending.json'), 'utf8')).items
      assert.equal(pending.length, 1)
      assert.equal(pending[0].text, '这句太人机了')
      assert.equal(pending[0].source.nickname, '小 A')

      // 群友自己过不了审
      const denied = await kit.runTool('corpus_review', { action: 'approve', ids: 'all' }, MEMBER)
      assert.equal(denied.ok, false)

      const approved = await kit.runTool('corpus_review', { action: 'approve', ids: 'all' }, OWNER)
      assert.equal(approved.ok, true)
      assert.equal(approved.added, 1)
      const corpus = readFileSync(join(dirOf, 'corpus.jsonl'), 'utf8').trim()
      assert.ok(corpus.includes('这句太人机了'))
      assert.equal(JSON.parse(readFileSync(join(dirOf, 'pending.json'), 'utf8')).items.length, 0)
    } finally {
      kit.cleanup()
    }
  })

  test('关掉「群友也能要求收录」以后，群友的要求直接不收', async () => {
    const { kit } = makeModule({ settings: { allowMemberAsk: false } })
    await setupModule(ENTRY_URL, kit.api)
    try {
      const result = await kit.runTool('corpus_save', { text: '作为AI' }, MEMBER)
      assert.equal(result.ok, false)
      assert.equal(existsSync(join(kit.dataRoot, 'modules-data/persona-corpus/pending.json')), false)
    } finally {
      kit.cleanup()
    }
  })

  test('演练模式不落盘：模拟测试的假消息不能污染真素材', async () => {
    const { kit } = makeModule({ config: { dryRun: true } })
    await setupModule(ENTRY_URL, kit.api)
    try {
      const result = await kit.runTool('corpus_save', { text: '作为AI语言模型' }, OWNER)
      assert.equal(result.ok, false)
      assert.equal(result.dryRun, true)
      assert.equal(existsSync(join(kit.dataRoot, 'modules-data/persona-corpus/corpus.jsonl')), false)
    } finally {
      kit.cleanup()
    }
  })

  test('主人把素材目录指到别处，文件就落在那里', async () => {
    withTmp((dir) => {
      const target = join(dir, '我的素材')
      const { kit } = makeModule({ settings: { dir: target } })
      return (async () => {
        await setupModule(ENTRY_URL, kit.api)
        try {
          const result = await kit.runTool('corpus_save', { text: '作为AI' }, OWNER)
          assert.equal(result.ok, true)
          assert.ok(existsSync(join(target, 'corpus.jsonl')))
          assert.ok(existsSync(join(target, 'corpus.md')))
          assert.equal(existsSync(join(kit.dataRoot, 'modules-data/persona-corpus/corpus.jsonl')), false)
        } finally {
          kit.cleanup()
        }
      })()
    })
  })

  test('翻库只有主人能用；群友问到就被挡回去', async () => {
    const { kit } = makeModule()
    await setupModule(ENTRY_URL, kit.api)
    try {
      await kit.runTool('corpus_save', { text: '作为AI语言模型' }, OWNER)
      const denied = await kit.runTool('corpus_list', {}, MEMBER)
      assert.equal(denied.ok, false)
      const got = await kit.runTool('corpus_list', { kind: 'negative' }, OWNER)
      assert.equal(got.ok, true)
      assert.equal(got.total, 1)
      assert.equal(got.items[0].text, '作为AI语言模型')
    } finally {
      kit.cleanup()
    }
  })

  test('每轮提要只给主人那一轮，群聊不塞（素材里有别人的原话）', async () => {
    const { kit, contexts, rules } = makeModule()
    await setupModule(ENTRY_URL, kit.api)
    try {
      assert.equal(contexts.length, 1)
      assert.equal(rules.length, 1)
      // 规则可以给字符串也可以给函数，插件两种都认
      const ruleText = typeof rules[0] === 'function' ? rules[0]() : String(rules[0])
      assert.ok(ruleText.includes('corpus_save'), '规则里要告诉她有这个本事')

      // 库空的时候不塞
      assert.equal(contexts[0]({ sessionId: 'owner-session' }), '')

      await kit.runTool('corpus_save', { text: '作为AI语言模型', fix: '这个我真不知道' }, OWNER)
      const ownerDigest = contexts[0]({ sessionId: 'owner-session' })
      assert.ok(ownerDigest.includes('【人格素材】'))
      assert.ok(ownerDigest.includes('这个我真不知道'))
      assert.equal(contexts[0]({ sessionId: 'group-session' }), '', '群聊里不该复读别人的原话')
      assert.equal(contexts[0]({}), '')
    } finally {
      kit.cleanup()
    }
  })

  test('命令：统计、列出、删、目录', async () => {
    const { kit } = makeModule()
    await setupModule(ENTRY_URL, kit.api)
    try {
      await kit.runTool('corpus_save', { text: '作为AI语言模型', note: '自报身份' }, OWNER)
      await kit.runTool('corpus_save', { kind: 'positive', text: '破防了哈哈哈' }, OWNER)
      const run = (arg) => kit.commands[0].run(arg)

      assert.ok(run('').includes('2 条'))
      assert.ok(run('列出 反面').includes('作为AI语言模型'))
      assert.ok(run('目录').includes('素材目录'))
      assert.ok(run('这不是命令').includes('素材库用法'))

      const id = C.entryId('negative', '作为AI语言模型')
      assert.ok(run(`删 ${id}`).includes('删了 1 条'))
      assert.ok(!readFileSync(join(kit.dataRoot, 'modules-data/persona-corpus/corpus.jsonl'), 'utf8').includes('作为AI语言模型'))
    } finally {
      kit.cleanup()
    }
  })

  test('超过上限以后最旧的被丢掉，工具会说明', async () => {
    const { kit } = makeModule({ settings: { maxEntries: 20 } })
    await setupModule(ENTRY_URL, kit.api)
    try {
      for (let i = 0; i < 20; i += 1) await kit.runTool('corpus_save', { text: `第${i}句` }, OWNER)
      const result = await kit.runTool('corpus_save', { text: '第20句' }, OWNER)
      assert.ok(result.message.includes('丢掉了 1 条最旧的'))
      const raw = readFileSync(join(kit.dataRoot, 'modules-data/persona-corpus/corpus.jsonl'), 'utf8')
      assert.equal(raw.trim().split('\n').length, 20)
      assert.ok(!raw.includes('第0句'))
    } finally {
      kit.cleanup()
    }
  })

  test('exports.save 走同一条路：别的模块替她收的当成主人要求', async () => {
    const { kit } = makeModule()
    const { exports } = await setupModule(ENTRY_URL, kit.api)
    try {
      const result = exports.save({ kind: 'note', text: '这次实验她开始用短句了' })
      assert.equal(result.ok, true)
      assert.equal(exports.summary().note, 1)
      assert.equal(exports.list({ kind: 'note' }).length, 1)
      assert.ok(exports.digest(3).includes('观察 1'))
    } finally {
      kit.cleanup()
    }
  })

  test('关掉素材库以后，工具只回「没开」', async () => {
    const { kit } = makeModule({ settings: { enabled: false } })
    await setupModule(ENTRY_URL, kit.api)
    try {
      const result = await kit.runTool('corpus_save', { text: '作为AI' }, OWNER)
      assert.equal(result.ok, false)
      assert.ok(result.message.includes('关着'))
    } finally {
      kit.cleanup()
    }
  })

  test('没有原文也没 id 就明确拒绝，不能存空条', async () => {
    const { kit } = makeModule()
    await setupModule(ENTRY_URL, kit.api)
    try {
      const result = await kit.runTool('corpus_save', {}, OWNER)
      assert.equal(result.ok, false)
      assert.ok(result.message.includes('没有原文'))
      const missId = await kit.runTool('corpus_save', { messageId: '404' }, MEMBER)
      assert.equal(missId.ok, false)
    } finally {
      kit.cleanup()
    }
  })
})

describe('module.json 与入口一致', () => {
  test('id / version / api 三处对齐，能力声明覆盖真实行为', async () => {
    const manifest = JSON.parse(readFileSync(join(MODULE_DIR, 'module.json'), 'utf8'))
    const { kit } = makeModule()
    try {
      const { mod } = await setupModule(ENTRY_URL, kit.api)
      assert.equal(manifest.id, mod.id)
      assert.equal(manifest.version, mod.version)
      assert.equal(manifest.api, mod.api)
      assert.deepEqual(manifest.capabilities, ['filesystem', 'plugin-config', 'plugin-internals'])
    } finally {
      kit.cleanup()
    }
  })
})
