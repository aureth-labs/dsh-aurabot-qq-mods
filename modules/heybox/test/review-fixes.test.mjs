import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeybox } from '../lib/site.mjs'
import { POST_STYLES } from '../lib/styles.mjs'

process.env.TZ = 'Asia/Shanghai'

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const TODAY = () => new Date().toISOString().slice(0, 10)

/** 造一个发帖 fixture；uploads/links 记录调用，方便断言 */
function fx({ heybox = {}, imagegen = null, uploadOk = true, postOk = true, linkId = '1', memeRoot = 'empty', initialState = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-fix-'))
  const cfg = {
    enabled: true, dryRun: false, ownerName: '主人',
    heybox: {
      enabled: true, cookie: 'pkey=abc; heybox_id=1', maxPostsPerDay: 3, postStyle: 'diary',
      postWordsMin: 100, postWordsMax: 3000, dailyPosts: [], defaultTopic: 7214, ...heybox,
    },
  }
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify(initialState || {
    quota: { date: TODAY(), post: 0, like: 0, comment: 0, browse: 0, share: 0 },
    acts: { date: TODAY(), fetchedAt: 1, list: [{ id: '8401', name: '盒友日常', seen: 3, isAct: false }], plain: [] },
  }))
  const uploads = []
  let posted = null
  const client = {
    dispose: () => {},
    riskInfo: () => ({ level: 0, until: 0, leftMs: 0 }),
    riskToken: () => 't',
    get: async () => ({ status: 'ok', result: { link: { hashtags: [], content_tags: [] } } }),
    post: async (path, body) => {
      if (String(path).includes('upload/info')) {
        uploads.push(JSON.parse(body.file_infos))
        return uploadOk
          ? { status: 'ok', result: { keys: ['k/1.png'], bucket: 'b', region: 'r' } }
          : { status: 'ok', result: { keys: [] } }
      }
      if (String(path).includes('upload/token')) return { status: 'ok', result: { credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' } } }
      if (String(path).includes('upload/callback')) return { status: 'ok', result: { preview_urls: ['https://cdn.example/x.png'] } }
      if (String(path).includes('/link/post')) {
        if (!postOk) return { status: 'ok', result: { link_id: '' } }
        posted = body
        return { status: 'ok', result: { link_id: linkId } }
      }
      return { status: 'ok', result: {} }
    },
    putCOS: async () => true,
  }
  const hb = createHeybox({
    getConfig: () => ({ ...cfg, heybox: { ...cfg.heybox } }), setCookie: () => {}, hub: {}, memory: {},
    log: { info: () => {}, warn: () => {} },
    stateFile, credFile: join(dir, 'x.json'), clientFactory: () => client,
    imagegen,
    // 默认指向空目录：测试不该隐式依赖本机的 ~/.dsh/meme-packs
    memeRoot: memeRoot === 'empty' ? join(dir, 'packs') : memeRoot,
  })
  return { hb, cfg, uploads, dir, get posted() { return posted }, close() { rmSync(dir, { recursive: true, force: true }) } }
}

const body = (n) => '一二三四五'.repeat(Math.ceil(n / 5)).slice(0, n)
const img = (f) => { const p = join(f.dir, 'i.png'); writeFileSync(p, PNG_1x1); return p }

// ── 必改 1：并发不得超出每日上限 ────────────────────────────────
test('并发发帖不会超过每日上限：先占额再干活', async (t) => {
  const f = fx({ heybox: { maxPostsPerDay: 2 } })
  t.after(() => f.close())
  const p = img(f)
  // 同时发起 4 次：只有 2 次能拿到额度，其余立刻被拒
  const results = await Promise.all([1, 2, 3, 4].map((i) => f.hb.post({
    title: '并发' + i, text: body(200), imagesByPos: { tail: [p] },
  })))
  const okCount = results.filter((r) => r.ok).length
  assert.equal(okCount, 2, '并发 4 次只应成功 2 次')
  assert.equal(f.hb.state().quota.post, 2, '额度用掉 2')
})

test('发帖失败时额度退回，不会白扣一天的名额', async (t) => {
  const f = fx({ heybox: { maxPostsPerDay: 2 } })
  t.after(() => f.close())
  // 用字数不足来触发拒发（too_short）：这条在占额之后、发请求之前，
  // 能验证「占额已发生 + 失败必须退回」这条路径。
  const r1 = await f.hb.post({ title: '太短', text: body(50) })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'too_short')
  assert.equal(f.hb.state().quota.post, 0, '拒发之后额度应该退回 0')
  // 再发一次，额度仍然够（说明前一次的占额真的退了）
  const p = img(f)
  const r2 = await f.hb.post({ title: '够长', text: body(2000), imagesByPos: { tail: [p] } })
  assert.equal(r2.ok, true)
  assert.equal(f.hb.state().quota.post, 1, '成功一次只扣 1')
})

test('上传失败拒发时额度也退回', async (t) => {
  const f = fx({ uploadOk: false })
  t.after(() => f.close())
  const p = img(f)
  const r = await f.hb.post({ title: '传不上去', text: body(200), imagesByPos: { tail: [p] } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'image_upload_failed')
  assert.equal(f.hb.state().quota.post, 0, '上传失败拒发后额度应退回')
})

// ── 必改 2：排期下标错位（空项要保留）────────────────────────────
test('排期空项按「跟全局」处理，第 2 篇真正用上自己的配置', async (t) => {
  // 第 1 篇留空（跟全局），第 2 篇单独配 2000-3000 字 + news 风格
  const f = fx({ heybox: { dailyPosts: [{}, { style: 'news', wordsMin: 2000, wordsMax: 3000, hint: '第二篇的要求' }] } })
  t.after(() => f.close())

  // 今天还没发过 → 取第 1 篇（空项，跟全局）
  const plan1 = f.hb.currentPostPlan()
  assert.equal(plan1.slot, 0)
  assert.equal(plan1.empty, true, '空项要标成 empty')
  assert.equal(plan1.style, 'diary', '空项走全局默认风格')
  assert.equal(plan1.wordsMin, 100, '空项走全局字数下限')

  // 真发一篇让计数变成 1，然后再取 plan —— 这次应该拿到第 2 篇，且用的是第 2 篇自己的配置
  const img = join(f.dir, 'i.png'); writeFileSync(img, PNG_1x1)
  const r1 = await f.hb.post({ title: '第一篇', text: body(200), imagesByPos: { tail: [img] } })
  assert.equal(r1.ok, true)
  assert.equal(f.hb.state().quota.post, 1)

  const plan2 = f.hb.currentPostPlan()
  assert.equal(plan2.slot, 1, '发过一篇后取第 2 篇')
  assert.notEqual(plan2.empty, true)
  assert.equal(plan2.style, 'news', '第 2 篇用自己的风格，不能是第 1 篇的默认值')
  assert.equal(plan2.wordsMin, 2000, '第 2 篇用自己的字数下限')
  assert.equal(plan2.hint, '第二篇的要求', '第 2 篇用自己的 hint')

  // 状态里也要能看出来
  const items = f.hb.postPlanState().items
  assert.equal(items.length, 2, '两篇都要在列表里，空项不能被过滤')
  assert.equal(items[0].empty, true)
  assert.equal(items[1].empty, false)
  assert.equal(items[1].wordsMin, 2000)
})

// ── 必改 3：本篇额外要求（hint）不能被 ctx 覆盖 ────────────────────
test('排期 hint 与调用方 materials 合并，不会被覆盖', async (t) => {
  const f = fx({ heybox: { dailyPosts: [{ style: 'mix', wordsMin: 150, wordsMax: 500, hint: '求关注' }] } })
  t.after(() => f.close())
  const brief = f.hb.postBrief('', { materials: ['调用方给的素材'] })
  assert.match(brief, /调用方给的素材/, '调用方素材要在')
  assert.match(brief, /求关注/, '排期里的本篇要求不能被覆盖掉')
})

// ── 必改 4：deal 风格必须在工具 enum 里 ──────────────────────────
test('四种风格都能取到配置，deal 也在内', async () => {
  assert.ok('deal' in POST_STYLES, 'styles 里要有 deal')
  assert.equal(POST_STYLES.deal.id, 'deal')
  // 乱填的风格回落默认，不会崩
})

// ── 待确认项：分区校验 ────────────────────────────────────────
test('显式传入的非法分区被拦下，不会发出一个必然失败的请求', async (t) => {
  // 分区缓存里有一批真实分区时，表外的 id 才判 bad_topic（缓存空时按「不硬拦」处理）
  const f = fx({ initialState: { topics: { date: TODAY(), fetchedAt: 1, list: [
    { id: '7214', name: '盒友杂谈' }, { id: '18745', name: '数码硬件' },
  ] }, acts: { date: TODAY(), fetchedAt: 1, list: [], plain: [] } } })
  t.after(() => f.close())
  const p = img(f)
  const r = await f.hb.post({ title: '乱填分区', text: body(200), topic: '58144', imagesByPos: { tail: [p] } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'bad_topic')
  assert.match(String(r.message), /不在当前分区表/)
  assert.equal(f.hb.state().quota.post, 0, '被拦下不该扣额度')
})

// ── 待确认项：短文不下上传首图 ──────────────────────────────────
test('正文太短时不放文首图，而且不会白上传一张', async (t) => {
  const f = fx({ heybox: { postWordsMin: 100, postWordsMax: 300 } })
  t.after(() => f.close())
  const p1 = img(f)
  const p2 = join(f.dir, 'i2.png'); writeFileSync(p2, PNG_1x1)
  const r = await f.hb.post({
    title: '短文', text: body(200),   // 200 < 500，不放文首图
    imagesByPos: { intro: [p1], tail: [p2] },
  })
  assert.equal(r.ok, true)
  assert.equal(r.images.intro, 0, '短文不该有文首图')
  assert.equal(r.images.tail, 1)
  assert.equal(f.uploads.length, 1, '只上传了文末那张，首图没白传')
})

// ── 必改 5：分区校验要认动态分区（P0 回归）───────────────────────
test('动态分区（非内置 3 个）能通过校验，不会被 bad_topic 拒发', async (t) => {
  // 面板新增的 549999 校园 / 73907 沙雕 / 425422 Steam 都不在内置 TOPICS 里，
  // topicMode=auto 挑出来的动态分区也一样。只认内置 3 个会把正常发帖挡死。
  const today = new Date().toISOString().slice(0, 10)
  const f = fx({
    initialState: {
      quota: { date: today, post: 0 },
      acts: { date: today, fetchedAt: 1, list: [], plain: [] },
      topics: { date: today, fetchedAt: 1, list: [
        { id: '549999', name: '校园', hot: 1, game: false },
        { id: '73907', name: '沙雕', hot: 1, game: false },
        { id: '425422', name: 'Steam', hot: 1, game: false },
      ] },
    },
  })
  t.after(() => f.close())
  const img = join(f.dir, 'i.png'); writeFileSync(img, PNG_1x1)

  for (const topic of ['549999', '73907', '425422']) {
    const r = await f.hb.post({ title: '动态分区' + topic, text: body(200), topic, imagesByPos: { tail: [img] } })
    assert.notEqual(r.code, 'bad_topic', `分区 ${topic} 不该被判 bad_topic`)
  }
})

test('分区表为空时不硬拦（宁可发一次可能失败的帖，也别挡正常发帖）', async (t) => {
  const today = new Date().toISOString().slice(0, 10)
  const f = fx({ initialState: { quota: { date: today, post: 0 }, acts: { date: today, fetchedAt: 1, list: [], plain: [] }, topics: { date: '', fetchedAt: 0, list: [] } } })
  t.after(() => f.close())
  const img = join(f.dir, 'i.png'); writeFileSync(img, PNG_1x1)
  const r = await f.hb.post({ title: '冷启动', text: body(200), topic: '549999', imagesByPos: { tail: [img] } })
  assert.notEqual(r.code, 'bad_topic', '缓存空时不该拦')
})

// ── 必改 6：拿不到任何图时放行纯文字帖（否则干净机器上永远发不出去）──
test('生图没开 + 没有图库时，纯文字帖能发出去并标 textOnly', async (t) => {
  const today = new Date().toISOString().slice(0, 10)
  const f = fx({ imagegen: { enabled: async () => false, generate: async () => PNG_1x1 } })
  t.after(() => f.close())
  // 这个 fx 的 memeRoot 指向的空目录里没有图（见 fx 的实现）
  const r = await f.hb.post({ title: '纯文字', text: body(200) })
  assert.equal(r.ok, true, '既没图库又没生图时应放行')
  assert.equal(r.textOnly, true, '要被标成纯文字帖')
})

test('no_image 两种文案：有图库时让挑图，只有生图时让传 mood / 走自动配图', async (t) => {
  // 情形 A：本机有图库（真的造一个出来），拒发文案要给样例路径
  const dirA = mkdtempSync(join(tmpdir(), 'heybox-packs-'))
  const packDir = join(dirA, 'dafeiyu-learned', 'memes', 'daily')
  mkdirSync(packDir, { recursive: true })
  for (let i = 0; i < 3; i++) writeFileSync(join(packDir, 'm' + i + '.png'), PNG_1x1)
  const fA = fx({ memeRoot: dirA })
  t.after(() => fA.close())
  const rA = await fA.hb.post({ title: '有图库但不传', text: body(200), imagesByPos: {} })
  assert.equal(rA.code, 'no_image')
  assert.ok(Number(rA.available) > 0, '要报可用图数量')
  assert.match(String(rA.message), /形象图|挑/, '有图库时应让她去挑图')
  assert.ok(Array.isArray(rA.samplePaths) && rA.samplePaths.length > 0, '要给样例路径')
  rmSync(dirA, { recursive: true, force: true })

  // 情形 B：没有图库、生图开着 → 提示传 mood/look 或走自动配图
  const gen = { enabled: async () => true, generate: async () => PNG_1x1 }
  const fB = fx({ imagegen: gen })
  t.after(() => fB.close())
  const rB = await fB.hb.post({ title: '只有生图但不传', text: body(200), imagesByPos: {} })
  assert.equal(rB.code, 'no_image')
  assert.equal(rB.canGenerate, true, '要标出生图可用')
  assert.match(String(rB.message), /生图|自动配图/, '生图开着时应提示走自动配图')
})

test('能配图却没配时仍然拒发（no_image），文案说明怎么配', async (t) => {
  const gen = { enabled: async () => true, generate: async () => PNG_1x1 }
  const f = fx({ imagegen: gen })
  t.after(() => f.close())
  // 关掉自动配图：显式传 imagesByPos: {} 走「手动指定但没给图」
  const r = await f.hb.post({ title: '能配没配', text: body(200), imagesByPos: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no_image')
  assert.match(String(r.message), /没带图|没有发出/)
  assert.equal(f.hb.state().quota.post, 0, '拒发要退额')
})
