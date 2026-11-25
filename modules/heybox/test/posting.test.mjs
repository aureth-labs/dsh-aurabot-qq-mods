// 新功能的测试：分区（新接口+缓存+自动挑选）、话题（活动+普通+热度+搜索+上限）、
// 每天每篇排期、每日羊毛风格、配图（自动规划 + 手动的三处位置兼容）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, ok, json } from './helpers.mjs'

const NL = '\n'

// ── 分区 ──────────────────────────────────────────────────────

/**
 * 造 n 条「今天已发」的 history 记录。
 *
 * ⚠ 排期索引现在数是 history 里今天的 post 条数（不是 quota.post 计数），
 *   所以夹具必须真往 history 里塞记录，否则 postsToday() 永远是 0。
 */
function postsOn(day, n) {
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0).getTime()
  return Array.from({ length: n }, (_, i) => ({ at: at + i * 60_000, kind: 'post', linkId: 'L' + i, title: 't' + i }))
}

test('分区：从 /topic/categories 抽三组，去重并保留热度/游戏标记', async () => {
  const categories = {
    recommend_for_user_topics: { name: '为你推荐', children: [
      { topic_id: 18745, name: '数码硬件', hot: { raw_hot_value: 100 }, game: { app_id: 1 } },
    ] },
    latest_hot_topics: { name: '近期热门', children: [
      { topic_id: 18745, name: '数码硬件', hot: { raw_hot_value: 9999 }, game: { app_id: 1 } },
      { topic_id: 7214, name: '盒友杂谈', hot: { raw_hot_value: 500 } },
      { topic_id: 733575, name: '影之刃零', hot: { raw_hot_value: 800 }, game: { app_id: 2 } },
    ] },
    subscribed_topics: { name: '我的偏好', children: [] },
  }
  const f = fixture({
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) return ok(categories)
      return ok({})
    },
  })
  const r = await f.hb.refreshTopics(true)
  const ids = r.list.map((t) => t.id)
  assert.deepEqual(ids.sort(), ['18745', '7214', '733575'])
  const d = r.list.find((t) => t.id === '18745')
  assert.equal(d.hot, 9999, '同一分区出现在多组时保留更大热度')
  assert.equal(d.game, true)
  f.close()
})

test('分区：当天走缓存，force 才重拉', async () => {
  let calls = 0
  const f = fixture({
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) {
        calls += 1
        return ok({ latest_hot_topics: { name: '热门', children: [{ topic_id: 7214, name: '盒友杂谈' }] } })
      }
      return ok({})
    },
  })
  await f.hb.refreshTopics(true)
  assert.equal(calls, 1)
  const cached = await f.hb.refreshTopics(false)
  assert.equal(cached.cached, true)
  assert.equal(calls, 1, '同一天内不再请求')
  await f.hb.refreshTopics(true)
  assert.equal(calls, 2, 'force 会重拉')
  f.close()
})

test('分区：接口拿不到时回落内置三个', async () => {
  const f = fixture({ fetcher: async () => json({ status: 'failed' }) })
  const r = await f.hb.refreshTopics(true)
  assert.equal(r.fallback, true)
  assert.equal(r.list.length, 3)
  f.close()
})

test('分区：手动模式永远用默认分区', async () => {
  const f = fixture({
    config: { heybox: { topicMode: 'manual', defaultTopic: '7214' } },
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) {
        return ok({ latest_hot_topics: { name: '热门', children: [{ topic_id: 568547, name: '黑神话：悟空', game: { app_id: 3 } }] } })
      }
      return ok({})
    },
  })
  await f.hb.refreshTopics(true)
  const id = await f.hb.pickTopicFor('黑神话：悟空 的新 DLC 出了', '7214')
  assert.equal(id, '7214', '手动模式不自动挑')
  f.close()
})

test('分区：自动模式按内容匹配，挑不到回落', async () => {
  const cats = { latest_hot_topics: { name: '热门', children: [
    { topic_id: 568547, name: '黑神话：悟空', game: { app_id: 3 }, hot: { raw_hot_value: 100 } },
    { topic_id: 425422, name: 'Steam', game: { app_id: 4 }, hot: { raw_hot_value: 200 } },
    { topic_id: 806933, name: 'AI', hot: { raw_hot_value: 300 } },
  ] } }
  const f = fixture({
    config: { heybox: { topicMode: 'auto', defaultTopic: '7214' } },
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) return ok(cats)
      return ok({})
    },
  })
  await f.hb.refreshTopics(true)
  assert.equal(await f.hb.pickTopicFor('黑神话：悟空 新 DLC', '7214'), '568547')
  assert.equal(await f.hb.pickTopicFor('Steam 秋季特卖', '7214'), '425422')
  assert.equal(await f.hb.pickTopicFor('今天吃了碗白米饭', '7214'), '7214', '不匹配回落默认')
  // 更长的分区名优先：不因为「AI」二字误配到 AI 分区
  assert.equal(await f.hb.pickTopicFor('这个 AI 游戏叫黑神话：悟空', '7214'), '568547')
  f.close()
})

// ── 话题 ──────────────────────────────────────────────────────

test('话题：扫信息流收集活动与普通话题，活动带 end_ts 过滤', async () => {
  // module 用的是 fixture 注入的 now()（固定 2026-06-08 10:00）
  const fixtureNow = new Date(2026, 5, 8, 10).getTime()
  const feeds = { links: [
    { hashtags: [{ hashtag_id: 1001, name: '活动A', sub_title: '活动' }] },
    { hashtags: [{ hashtag_id: 2001, name: '普通1' }, { hashtag_id: 2002, name: '普通2' }] },
    { hashtags: [{ hashtag_id: 1002, name: '过期活动', sub_title: '活动' }] },
  ] }
  const f = fixture({
    fetcher: async (url) => {
      const u = String(url)
      if (u.includes('/bbs/app/feeds')) return ok(feeds)
      if (u.includes('/bbs/app/hashtag/feeds')) {
        const m = u.match(/hashtag_id=(\d+)/)
        const id = m ? m[1] : ''
        if (id === '1002') return ok({ hashtag: { act_prop: { end_ts: Math.floor(fixtureNow / 1000) - 60 } } })
        return ok({
          hashtag: { is_act_hashtag: 1, num: { content_num: 5000 }, act_prop: { end_ts: Math.floor(fixtureNow / 1000) + 3600 } },
          related_act_info: { title: '活动全名' },
        })
      }
      return ok({})
    },
  })
  const r = await f.hb.refreshActs(true)
  const actNames = r.list.map((a) => a.name)
  assert.ok(actNames.includes('活动A'), '进行中的活动保留')
  assert.ok(!actNames.includes('过期活动'), '过期的活动被过滤')
  assert.equal(r.list[0].actTitle, '活动全名')
  assert.ok(r.plain.some((p) => p.name === '普通1') || r.plain.length > 0, '普通话题也收进来了')
  assert.equal(r.list.every((a) => a.isAct === true), true)
  assert.equal(r.plain.every((a) => a.isAct === false), true)
  f.close()
})

test('话题：列表活动在前、都带热度，搜索按关键词且活动优先', async () => {
  const f = fixture({
    initialState: {
      acts: { date: new Date().toISOString().slice(0, 10), fetchedAt: 1, list: [
        { id: '1001', name: '活动A', actTitle: '活动甲', contentNum: 5000, seen: 2, isAct: true },
      ], plain: [
        { id: '2001', name: '普通游戏1', contentNum: 9000, seen: 3, isAct: false },
        { id: '2002', name: '普通2', contentNum: 8000, seen: 2, isAct: false },
      ] },
    },
  })
  const al = await f.hb.actList()
  assert.equal(al.list.length, 3)
  assert.equal(al.list[0].isAct, true, '活动排最前')
  assert.match(al.message, /【创作活动】/)
  assert.match(al.message, /【普通话题】/)
  assert.match(al.message, /热度/)

  const s1 = await f.hb.searchTopics('游戏')
  assert.ok(s1.list.length > 0)
  assert.ok(s1.list.every((t) => t.name.includes('游戏') || t.actTitle.includes('游戏')))
  const s2 = await f.hb.searchTopics('不存在的词')
  assert.equal(s2.list.length, 0)
  const s3 = await f.hb.searchTopics('')
  assert.ok(s3.list.length > 0, '空关键词返回全部')
  f.close()
})

test('话题：活动和普通不互斥，但共享总共 3 个名额（活动最多 1 个）', async () => {
  // 实测（2026-11-02）：「互斥只能选一类」是错的，活动和普通可以一起挂。
  // 主人定的口径（2026-11-12）：一帖的话题**总共 3 个名额，活动普通共享**
  // （小黑盒网页编辑器自己的上限是 5，这里按主人的规则收紧到 3）。
  // 排期里配了 4 个时截到 3 并 warn，别悄悄多挂一个没人知道。
  const f = fixture({
    fetcher: async (url) => {
      const u = String(url)
      if (u.includes('/bbs/app/feeds')) {
        return ok({ links: [
          { linkid: '1', hashtags: [
            { hashtag_id: 1515478, name: '分享我的养鱼日常', sub_title: '活动' },
            { hashtag_id: 8401, name: '盒友日常' },
            { hashtag_id: 689666, name: 'deepseek' },
            { hashtag_id: 135213, name: 'ai人工智能' },
            { hashtag_id: 106, name: '手机' },
          ] },
        ] })
      }
      if (u.includes('/bbs/app/hashtag/feeds')) return ok({ hashtag: { name: '活动', num: { content_num: 100 } } })
      return ok({})
    },
  })
  await f.hb.refreshActs(true)
  const items = await f.hb.resolveHashtagItems(['分享我的养鱼日常', '盒友日常', 'deepseek', '手机'])
  const names = items.map((x) => x.name)
  assert.equal(names.length, 3, '总数截到 3 个名额')
  assert.ok(names.includes('分享我的养鱼日常'), '活动优先占 1 席')
  assert.deepEqual(names.slice(1), ['盒友日常', 'deepseek'], '剩下 2 席按顺序给普通话题')
  // 没选活动时，普通话题同样最多 3 个
  const plainOnly = await f.hb.resolveHashtagItems(['盒友日常', 'deepseek', 'ai人工智能', '手机'])
  assert.equal(plainOnly.length, 3, '纯普通话题也受 3 席总闸约束')
  assert.deepEqual(plainOnly.map((x) => x.name), ['盒友日常', 'deepseek', 'ai人工智能'])
  // 1 活动 + 2 普通正好占满 3 席，不截断
  const twoActs = await f.hb.resolveHashtagItems(['分享我的养鱼日常', '盒友日常', '手机'])
  assert.equal(twoActs.length, 3)
  f.close()
})
test('排期：按今天第几篇取配置，用完回落全局', async () => {
  const plan = [
    { style: 'deal', topic: '', hashtags: ['活动A'], wordsMin: 150, wordsMax: 300, hint: '写养鱼' },
    { style: 'news', topic: '18745', hashtags: [], wordsMin: 200, wordsMax: 600, hint: '' },
  ]
  const base = { heybox: { enabled: true, postStyle: 'mix', defaultTopic: '7214', dailyPosts: plan } }

  for (const [done, wantStyle, wantTopic] of [[0, 'deal', ''], [1, 'news', '18745']]) {
    const f = fixture({ config: base, initialState: { quota: { date: '2026-06-08', post: done, like: 0, comment: 0, browse: 0, share: 0 }, history: postsOn(new Date(2026, 5, 8), done) } })
    const p = f.hb.currentPostPlan()
    assert.equal(p.style, wantStyle)
    assert.equal(p.topic, wantTopic)
    assert.equal(p.fromPlan, true)
    f.close()
  }

  // 第 3 篇：排期用完 → 回落全局
  const f3 = fixture({ config: base, initialState: { quota: { date: '2026-06-08', post: 2, like: 0, comment: 0, browse: 0, share: 0 }, history: postsOn(new Date(2026, 5, 8), 2) } })
  const p3 = f3.hb.currentPostPlan()
  assert.equal(p3.fromPlan, false)
  assert.equal(p3.style, 'mix')
  f3.close()
})

test('排期：postPlanState 反映配了几篇、已发几篇、当前第几篇', async () => {
  const plan = [{ style: 'deal' }, { style: 'news' }, { style: 'mix' }]
  const f = fixture({
    config: { heybox: { dailyPosts: plan } },
    initialState: { quota: { date: '2026-06-08', post: 1, like: 0, comment: 0, browse: 0, share: 0 }, history: postsOn(new Date(2026, 5, 8), 1) },
  })
  const st = f.hb.postPlanState()
  assert.equal(st.configured, 3)
  assert.equal(st.done, 1)
  assert.equal(st.current.style, 'news')
  assert.equal(st.items[0].done, true)
  assert.equal(st.items[1].done, false)
  f.close()
})

// ── 风格 ──────────────────────────────────────────────────────

test('风格：有「每日羊毛」，且要求直达链接、不许编造', async () => {
  const { POST_STYLES, stylePrompt } = await import('../lib/styles.mjs')
  assert.ok(POST_STYLES.deal, '有 deal 风格')
  assert.equal(POST_STYLES.deal.needLink, true)

  const withLinks = stylePrompt('deal', { links: ['https://www.xiaoheihe.cn/app/bbs/activity/1'] })
  assert.match(withLinks, /必须给直达链接/)
  assert.match(withLinks, /不许自己编造或拼凑 URL/)
  assert.match(withLinks, /activity\/1/)

  const noLinks = stylePrompt('deal', {})
  assert.match(noLinks, /没有就别发这贴/, '没链接时劝退')

  // 所有风格都要求首段自我介绍
  for (const id of ['diary', 'news', 'mix', 'deal']) {
    const t = stylePrompt(id, { owner: '主人' })
    assert.match(t, /开头第一段固定是自我介绍/, `${id} 要自我介绍`)
  }
})

test('风格：deal 没链接直接拒发（no_link），有链接才放行', async () => {
  // 提示词里写「没链接别发」不够，这里要有代码级硬校验
  const noLinkText = '今天有个限时免费的羊毛，赶紧去领。' + '这段凑字数。'.repeat(12)
  const f1 = await postFx({ heybox: { postStyle: 'deal', postWordsMin: 20, postWordsMax: 400 } })
  const r1 = await f1.hb.post({ title: '羊毛无链接', text: noLinkText, style: 'deal' })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'no_link')
  assert.match(String(r1.message), /必须带真实可点的入口链接/)
  assert.equal(f1.hb.state().quota.post, 0, '被拦下不该扣额度')
  f1.close()

  // 正文里带链接就放行
  const withLinkText = noLinkText + NL + NL + '入口：https://www.xiaoheihe.cn/app/bbs/activity/1'
  const f2 = await postFx({ heybox: { postStyle: 'deal', postWordsMin: 20, postWordsMax: 400 } })
  const r2 = await f2.hb.post({ title: '羊毛有链接', text: withLinkText, style: 'deal', imagesByPos: { tail: [join(f2.dir, 't.png')] } })
  // 没有图片会先被 no_image 拦，这里只验证链接这一关不再拦它
  assert.notEqual(r2.code, 'no_link', '有链接就不该报 no_link')
  f2.close()
})

test('风格：字数只认自定义值，风格不再自带', async () => {
  const { styleOf, POST_STYLES } = await import('../lib/styles.mjs')
  // 自带字数已取消：没配自定义值时不做硬校验（words 为空）
  for (const id of Object.keys(POST_STYLES)) {
    assert.equal(POST_STYLES[id].words, undefined, `${id} 不该再自带 words`)
    assert.deepEqual(styleOf(id).words, [], `${id} 没配字数时不校验`)
    assert.equal(styleOf(id).customWords, false)
  }
  const c = styleOf('mix', { postWordsMin: 300, postWordsMax: 900 })
  assert.deepEqual(c.words, [300, 900])
  assert.equal(c.customWords, true)
  // 上下颠倒的自动调正，不再是「整条不生效」
  assert.deepEqual(styleOf('mix', { postWordsMin: 900, postWordsMax: 300 }).words, [300, 900])
  // 非法值（NaN / 0 / 负数）不生效 → 不校验
  assert.deepEqual(styleOf('diary', { postWordsMin: 'x', postWordsMax: 'y' }).words, [])
  assert.deepEqual(styleOf('diary', { postWordsMin: 0, postWordsMax: 0 }).words, [])
  // 只填一个边也认（单边校验比「两个都填才生效」更符合面板直觉）
  assert.deepEqual(styleOf('diary', { postWordsMin: 800 }).words, [800, 0])
  assert.deepEqual(styleOf('diary', { postWordsMax: 800 }).words, [0, 800])
})

test('风格：提示词里的篇幅行跟着自定义字数走', async () => {
  const { stylePrompt } = await import('../lib/styles.mjs')
  const custom = stylePrompt('diary', { owner: '主人', cfg: { postWordsMin: 400, postWordsMax: 900 } })
  assert.match(custom, /篇幅 400~900 字/)
  const bare = stylePrompt('diary', { owner: '主人' })
  assert.doesNotMatch(bare, /篇幅 \d+~\d+ 字/, '没配字数时不许出现硬指标')
  assert.match(bare, /这次没设字数要求/)
  const oneSided = stylePrompt('mix', { owner: '主人', cfg: { postWordsMin: 600 } })
  assert.match(oneSided, /篇幅 600~不限 字/)
})

test('发帖：没配自定义字数时不做字数硬校验', async () => {
  const f = await postFx({ heybox: { postWordsMin: 0, postWordsMax: 0 } })
  const r = await f.hb.post({ title: '短', text: '就一句。' })
  // 旧版会拿风格自带值拦人，现在只有自定义值能拦
  assert.notEqual(r.code, 'too_short')
  f.close()
})

test('发帖：自定义下限仍然硬拦（这是唯一剩下的字数闸门）', async () => {
  const f = await postFx({ heybox: { postStyle: 'mix', postWordsMin: 1500, postWordsMax: 3000 } })
  const r = await f.hb.post({ title: '不够长', text: '这段只有几十个字。'.repeat(6) })
  assert.equal(r.code, 'too_short')
  assert.match(r.message, /低于设的字数下限 1500 字/)
  assert.doesNotMatch(r.message, /「肥鱼热搜」/, '消息里不该再引用风格名（字数与风格无关了）')
  f.close()
})

// ── 配图位置 ──────────────────────────────────────────────────

// 配图相关：从 #21 起改成「按字数自动规划」，不再由调用方按位置塞图。
// 旧的三位置参数 imagesByPos 仍然兼容（手动传就按传的放），下面是新老行为各测一遍。

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** 造一个能发帖的 fixture：上传走 mock，图片从临时文件读 */
async function postFx({ heybox = {}, text, imagesByPos, imagegen = null, memeRoot = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-post-'))
  const imageDir = join(dir, 'imgs')
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({
    quota: { date: new Date().toISOString().slice(0, 10), post: 0 },
    acts: { date: new Date().toISOString().slice(0, 10), fetchedAt: 1, list: [], plain: [] },
  }))
  const cfg = {
    enabled: true, dryRun: false, ownerName: '主人',
    heybox: { enabled: true, cookie: 'pkey=x; heybox_id=1', maxPostsPerDay: 99, postWordsMin: 100, postWordsMax: 4000, ...heybox },
  }
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
        return { status: 'ok', result: { keys: ['/k.png'], bucket: 'b', region: 'r' } }
      }
      if (String(path).includes('upload/token')) return { status: 'ok', result: { credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 's' } } }
      if (String(path).includes('upload/callback')) return { status: 'ok', result: { preview_urls: ['https://img/x.png'] } }
      if (String(path).includes('/link/post')) { posted = body; return { status: 'ok', result: { link_id: '1' } } }
      return { status: 'ok', result: {} }
    },
    putCOS: async () => true,
  }
  const hb = (await import('../lib/site.mjs')).createHeybox({
    getConfig: () => cfg, setCookie: () => {}, hub: {}, memory: {},
    log: { info: () => {}, warn: () => {} },
    stateFile, credFile: join(dir, 'x.json'), clientFactory: () => client, imagegen, imageDir,
    memeRoot: memeRoot ?? join(dir, 'packs'),
  })
  return { hb, dir, uploads, get posted() { return posted }, close() { rmSync(dir, { recursive: true, force: true }) } }
}

test('配图：手动传 imagesByPos 时按位置放（兼容老调用）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-img-'))
  const intro = join(dir, 'intro.png')
  const inline = join(dir, 'inline.png')
  const tail = join(dir, 'tail.png')
  for (const p of [intro, inline, tail]) writeFileSync(p, PNG)
  // 1000 字以上才有首图（不足 500 字会跳首图），所以正文要够长
  const longText = '我是主人养的大肥鱼。' + NL + NL + '第二段。' + NL + NL + '第三段。' + NL + NL + '填充内容。'.repeat(200)
  const f = await postFx({ text: longText, imagesByPos: { intro: [intro], inline: [inline], tail: [tail] } })
  const r = await f.hb.post({ title: '长文', text: longText, imagesByPos: { intro: [intro], inline: [inline], tail: [tail] } })
  assert.equal(r.ok, true, '长文应能发')
  assert.equal(r.images.intro, 1)
  assert.equal(r.images.inline, 1)
  assert.equal(r.images.tail, 1)
  assert.equal(r.images.total, 3)
  f.close()
})

test('配图：短文（<500 字）不放首图，光传首图会被跳掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-img-'))
  const intro = join(dir, 'intro.png')
  const tail = join(dir, 'tail.png')
  writeFileSync(intro, PNG); writeFileSync(tail, PNG)
  // 短文要比字数下限长一点才发得出去（这里把下限设成 10）
  const shortText = '我是主人养的大肥鱼。' + NL + NL + '这段很短。' + '一二三。'.repeat(10)
  const f = await postFx({ text: shortText, heybox: { postWordsMin: 10, postWordsMax: 400 } })
  const r = await f.hb.post({ title: '短文', text: shortText, imagesByPos: { intro: [intro], tail: [tail] } })
  assert.equal(r.ok, true)
  assert.equal(r.images.intro, 0, '短文不放首图')
  assert.equal(r.images.tail, 1, '文末图照旧')
  assert.equal(f.uploads.length, 1, '首图不该白上传')
  f.close()
})

test('配图：不传图时按字数自动规划（生图优先）', async () => {
  let calls = 0
  const gen = { enabled: async () => true, generate: async () => { calls++; return PNG } }
  const f = await postFx({ text: '', imagegen: gen })
  const text = '我是大肥鱼。'.repeat(30)       // 200 字 → 1 张（文末）
  const r = await f.hb.post({ title: '自动', text })
  assert.equal(r.ok, true)
  assert.equal(r.autoImages.planned, 1, '≤500 字 1 张')
  assert.equal(r.autoImages.generated, 1, '优先现画')
  assert.deepEqual(r.autoImages.kinds, ['tail'])
  assert.equal(calls, 1)
  f.close()
})
