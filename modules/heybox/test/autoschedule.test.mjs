import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeybox } from '../lib/site.mjs'

// 固定东八区 + 固定「今天」，让 postsToday/排期时刻可复算。
process.env.TZ = 'Asia/Shanghai'

// 正文要过字数硬校验（fixture 里 postWordsMin=100）
const BODY = ('今天在小黑盒刷到一条很有意思的帖子，说的是某款游戏的新版本更新内容。'
  + '我仔细看了更新日志，发现这次改动涉及三个系统：背包整理、任务追踪和公会战匹配。'
  + '其中任务追踪终于支持跨地图自动寻路了，玩起来省事不少。').repeat(2)

const isPostPrompt = (p) => String(p).includes('写一篇小黑盒帖子')
// 「带原文补长」那一轮的开头
const isFixPrompt = (p) => String(p).includes('把这篇小黑盒帖子补长一点')
// 分段扩写的两轮：先大纲、再逐段
const isOutlinePrompt = (p) => String(p).includes('做分段大纲')
const isSectionPrompt = (p) => String(p).includes('其中一段')

/** 一段 420 字（countWords 去空白计字，21 字 × 20）：三段拼成 1260，够过 1200 下限 */
const SEG = '这段讲了个具体细节，带了数字和时间点说明。'.repeat(20)

/** 造一个能跑 tick 全链路（逛 + 自动发帖）的 fixture：网络全 mock、时间可控
 *  发帖那一轮返回什么由 f.postMode 决定（ok | badJson | short），用来模拟模型写歪 / 写不够字数 */
function fx({ heybox = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-sched-'))
  mkdirSync(join(dir, 'packs'), { recursive: true })   // 空图库 → 纯文字帖放行
  const start = new Date(2026, 5, 8, 10, 0)            // 2026-06-08 10:00（周六）
  let time = start.getTime()
  const cfg = {
    enabled: true, dryRun: false, ownerQQ: '12345678', ownerName: '主人',
    speakUp: { awakeFrom: 0, awakeTo: 24 },
    heybox: {
      enabled: true, autoBrowse: true, cookie: 'pkey=abc; heybox_id=1',
      maxRunsPerDay: 1, intervalHours: 4, maxPostsPerDay: 2,
      dailyPosts: [{}, {}], postStyle: 'diary',
      postWordsMin: 100, postWordsMax: 3000, defaultTopic: 7214,
      ...heybox,
    },
  }
  const turns = []
  const posted = []
  let postMode = 'ok'   // 由测试通过 setPostMode 改：'ok' | 'badJson' | 'short' | 'shortThenFixed' | 'shortThenChunked'
  const chat = {
    runSystemTurn: async (ext, title, prompt, opts) => {
      turns.push({ ext, title, prompt, opts })
      if (isPostPrompt(prompt)) {
        if (postMode === 'badJson') return '抱歉，我这次没写成'
        if (postMode === 'short' || postMode === 'shortThenFixed' || postMode === 'shortThenChunked') return JSON.stringify({ title: '短稿', text: '今天刷到一条。' })
        return JSON.stringify({ title: '排期到点自动发的测试帖', text: BODY })
      }
      // 分段扩写：只有 shortThenChunked 给大纲和段落，其余模式回垃圾（好验证退回整篇补写那条路）
      if (isOutlinePrompt(prompt)) {
        if (postMode === 'shortThenChunked') return JSON.stringify({ title: '分块拼出来的测试帖', sections: [{ focus: '开头说清这事', points: '给个价格数字' }, { focus: '我自己的看法', points: '多讲一段' }, { focus: '收尾抛问题', points: '问盒友一句' }] })
        return '抱歉，我这次没写成'
      }
      if (isSectionPrompt(prompt)) return postMode === 'shortThenChunked' ? JSON.stringify({ text: SEG }) : '抱歉，我这次没写成'
      // 「带原文补长」那一轮：只有 shortThenFixed 会写成合格稿，其余模式仍回垃圾
      if (isFixPrompt(prompt)) {
        if (postMode === 'shortThenFixed') return JSON.stringify({ title: '补长后的测试帖', text: BODY })
        return '抱歉，我这次没写成'
      }
      return JSON.stringify({ note: '看到一个有趣的帖子', share: '', linkId: '', remember: '' })
    },
    sendText: async () => ({ message_id: 1 }),
  }
  const client = {
    dispose: () => {},
    riskInfo: () => ({ level: 0, until: 0, leftMs: 0 }),
    riskToken: () => 't',
    get: async (url) => {
      if (String(url).includes('/bbs/app/feeds')) {
        return {
          status: 'ok',
          result: { links: [{ linkid: '123456', title: '游戏新闻', user: { username: '盒友甲' }, link_like_count: 3, comment_num: 1, topics: [] }] },
        }
      }
      return { status: 'ok', result: {} }
    },
    post: async (path, body) => {
      if (String(path).includes('/link/post')) {
        posted.push(body)
        return { status: 'ok', result: { link_id: String(100000 + posted.length) } }
      }
      return { status: 'ok', result: {} }
    },
    putCOS: async () => true,
  }
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({
    quota: { date: '2026-06-08', post: 0, like: 0, comment: 0, browse: 0, share: 0 },
    acts: { date: '2026-06-08', fetchedAt: 1, list: [], plain: [] },
  }))
  const hb = createHeybox({
    getConfig: () => ({ ...cfg, heybox: { ...cfg.heybox } }),
    setCookie: () => {}, hub: chat, memory: {},
    log: { info: () => {}, warn: () => {} },
    stateFile, credFile: join(dir, 'x.json'), now: () => time,
    clientFactory: () => client,
    memeRoot: join(dir, 'packs'),
  })
  return {
    hb, cfg, turns, posted, stateFile, dir,
    get time() { return time },
    set time(v) { time = v },
    setPostMode(v) { postMode = v },
    at(h, m = 0) { time = new Date(2026, 5, 8, h, m).getTime() },
    close() { hb.dispose(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const postTurns = (f) => f.turns.filter((t) => isPostPrompt(t.prompt))

test('逛额度烧尽后到点仍能补发：每日排期不再只发出第 1 篇', async (t) => {
  const f = fx()
  t.after(() => f.close())

  // 第 1 轮：逛冷却过期（lastRun/browseAt 都是 0）→ runDuty 逛一圈 + 顺手发第 1 篇
  // 排期 slots=[0,12]：10:00 已过第 1 篇的点（rel=2 ≥ 0）
  const r1 = await f.hb.tick()
  assert.equal(r1.due, true)
  assert.equal(postTurns(f).length, 1, '第一轮该发出第 1 篇')
  assert.equal(f.hb.state().quota.browse, 1, '逛额度用掉 1')
  assert.equal(f.hb.state().quota.post, 1)

  // 第 2 篇的计划点在 12:00（唤醒窗口 0-24 均分 2 份）；11:00 还没到 → 不发
  f.at(11, 0)
  const r2 = await f.hb.tick()
  assert.equal(r2.due, false, '第 2 篇没到点不发')
  assert.equal(postTurns(f).length, 1)

  // 13:00：已过第 2 篇的点；逛额度烧尽（maxRunsPerDay=1）且逛冷却也没过。
  // 旧版这条路会先在 left('browse') 或 lastRun 冷却上早退，永远发不出第 2 篇。
  f.at(13, 0)
  const r3 = await f.hb.tick()
  assert.equal(r3.due, true, '到点就该补发，不受逛额度/冷却牵连')
  assert.equal(postTurns(f).length, 2, '第 2 篇到点自动发出')
  assert.equal(f.hb.state().quota.post, 2, '当日排期 2 篇发满')
  assert.equal(f.hb.state().quota.browse, 1, '补发这一轮不该再消耗逛额度')
  assert.equal(f.posted.length, 2, '真的 POST 了两次 /link/post')
  const hist = f.hb.state().history.filter((h) => h.kind === 'post')
  assert.equal(hist.length, 2, 'history 里要有两条 post 记录（postsToday 的依据）')

  // 4) 排期发满后不再触发
  f.at(13, 1)
  const r4 = await f.hb.tick()
  assert.equal(r4.due, false, '发满了就不该再 due')
  assert.equal(postTurns(f).length, 2)
})

test('postWindowOpen：到点才 due，发满/关掉自动发帖都不 due', async (t) => {
  const f = fx()
  t.after(() => f.close())
  const cfg = f.cfg
  const hh = (h, m = 0) => new Date(2026, 5, 8, h, m)

  // 还没发：第 1 篇的点是 0（一醒来就到点）→ 10:00 已过点 → due
  assert.equal(f.hb.postWindowOpen(cfg, hh(10)), true)
  // 手动造「已发 1 篇」→ 下一篇的点是 12:00：11:00 不到点 / 13:00 到点
  const { writeFileSync: w } = await import('node:fs')
  const st = JSON.parse((await import('node:fs')).readFileSync(f.stateFile, 'utf8'))
  st.history = [{ at: hh(10).getTime(), kind: 'post', linkId: '1' }, ...(st.history || [])]
  w(f.stateFile, JSON.stringify(st))
  assert.equal(f.hb.postWindowOpen(cfg, hh(11)), false, '11:00 第 2 篇还没到点')
  assert.equal(f.hb.postWindowOpen(cfg, hh(13)), true, '13:00 第 2 篇到点了')

  // 两篇都发完 → 不再 due
  st.history = [{ at: hh(10).getTime(), kind: 'post', linkId: '1' }, { at: hh(13).getTime(), kind: 'post', linkId: '2' }]
  w(f.stateFile, JSON.stringify(st))
  assert.equal(f.hb.postWindowOpen(cfg, hh(20)), false, '发满了不 due')

  // 面板关掉自动发帖 → 不 due（安全阀）
  const st2 = JSON.parse((await import('node:fs')).readFileSync(f.stateFile, 'utf8'))
  st2.history = []
  w(f.stateFile, JSON.stringify(st2))
  cfg.heybox.autoPost = false
  assert.equal(f.hb.postWindowOpen(cfg, hh(20)), false, 'autoPost=false 不 due')
  const r = await f.hb.maybeAutoPost({})
  assert.equal(r.skipped, true)
  assert.match(r.message, /自动发帖已关/)
})

test('没配排期就绝不自动发（maybeAutoPost 空排期安全阀）', async (t) => {
  const f = fx({ heybox: { dailyPosts: [] } })
  t.after(() => f.close())
  const r = await f.hb.maybeAutoPost({})
  assert.equal(r.skipped, true)
  assert.match(r.message, /没配排期/)
  assert.equal(f.posted.length, 0)
  assert.equal(f.hb.postWindowOpen(f.cfg, new Date(2026, 5, 8, 20)), false)
})

// ── 真失败要退避 ──────────────────────────────────────────────
//
// 线上事故的样子：排期欠着稿 → 每分钟叫模型写一篇 → 那篇要么写不够字数被 post()
// 硬拒、要么这一轮直接超时 → 旧版把 tick 的 failures/retryAt 一律清零，下一分钟
// 再来一遍。每次超时都会让宿主把卡住的 system:heybox 会话归档重建，于是一天多出
// 好几条会话。现在的闸门就是这两条测试。

test('模型这轮没写成：记退避，退避期内不再叫模型，到期后恢复', async (t) => {
  const f = fx()
  t.after(() => f.close())
  f.setPostMode('badJson')

  // 第 1 轮：逛 + 顺手发帖，发帖那一轮模型返回垃圾 → 标记 retry 并记退避
  f.at(10, 0)
  const r1 = await f.hb.tick()
  assert.equal(r1.due, true)
  assert.equal(postTurns(f).length, 1, '跑了一次发帖回合')
  const st1 = f.hb.state()
  assert.equal(st1.postFailures, 1, '真失败要记一次')
  assert.ok(st1.postRetryAt > f.time, '要记下退避时刻')
  assert.equal(st1.postRetryAt - f.time, 2 * 60_000, '第一次退避 2 分钟')

  // 第 2 分钟：还在退避期内 —— 不许再开模型回合（会话不再被耗光的关键）
  f.at(10, 1)
  await f.hb.tick()
  assert.equal(postTurns(f).length, 1, '退避期内不能再叫模型')
  assert.equal(f.posted.length, 0)

  // 退避到期后自动恢复
  f.setPostMode('ok')
  f.at(10, 3)
  const r3 = await f.hb.tick()
  assert.equal(postTurns(f).length, 2, '到期后应该再试一次')
  assert.equal(f.posted.length, 1, '这次真的发出去了')
  assert.equal(f.hb.state().postFailures, 0, '成功就清零')
})

test('稿子被 post() 硬拒（字数不够）：同样退避，不会每分钟重写一篇废稿', async (t) => {
  // fixture 默认 postWordsMin=100，模型只写 7 个字 → too_short
  const f = fx()
  t.after(() => f.close())
  f.setPostMode('short')

  f.at(10, 0)
  await f.hb.tick()
  assert.equal(postTurns(f).length, 1)
  const st = f.hb.state()
  assert.equal(st.postFailures, 1, '硬拒发要算真失败')
  assert.match(String(st.lastSkipReason), /字数下限|没有发出/)

  // 退避期内连试都不试
  f.at(10, 1)
  await f.hb.tick()
  assert.equal(postTurns(f).length, 1, '退避期内不许重写')

  // 第二次失败要按阶梯往上退（2 → 5 分钟）
  f.at(10, 3)
  await f.hb.tick()
  assert.equal(postTurns(f).length, 2, '退避过后重试一次')
  const st2 = f.hb.state()
  assert.equal(st2.postFailures, 2)
  assert.ok(st2.postRetryAt - f.time > 2 * 60_000, '第二次退得更久')
})

test('安全阀式跳过（关自动发帖/没排期/额度没了）不退避，也不算失败', async (t) => {
  const f = fx({ heybox: { autoPost: false } })
  t.after(() => f.close())
  f.at(10, 0)
  await f.hb.tick()
  const st = f.hb.state()
  assert.equal(st.postFailures || 0, 0, 'skipped 不该进退避阶梯')
  assert.equal(st.postRetryAt || 0, 0)
  assert.equal(postTurns(f).length, 0, '自动发帖关了就不叫模型')
})

test('高下限一稿写不满：先分段扩写，拼够就发出去', async (t) => {
  // 下限 1200 ≥ CHUNK_TARGET_MIN(1000) → 走分块；三段各 400 字拼成 1200
  const f = fx({ heybox: { postWordsMin: 1200, postWordsMax: 3000 } })
  t.after(() => f.close())
  f.setPostMode('shortThenChunked')

  f.at(10, 0)
  await f.hb.tick()

  assert.equal(f.turns.filter((x) => isPostPrompt(x.prompt)).length, 1, '先写一稿')
  assert.equal(f.turns.filter((x) => isOutlinePrompt(x.prompt)).length, 1, '一稿不够就出大纲')
  const secs = f.turns.filter((x) => isSectionPrompt(x.prompt))
  assert.equal(secs.length, 3, '大纲几段就生成几段')
  // 每段都要带上大纲顺序和这段的素材，否则模型会写成三篇独立帖子
  assert.match(secs[1].prompt, /整篇大纲（按顺序）/)
  assert.match(secs[1].prompt, /现在只写第 2 段/)
  assert.match(secs[1].prompt, /我自己的看法/, '要带上这段的 focus')
  assert.match(secs[1].prompt, /多讲一段/, '要带上这段的 points')

  assert.equal(f.posted.length, 1, '拼够之后发出去了')
  assert.match(String(f.posted[0].title), /分块拼出来的测试帖/)
  assert.equal(f.hb.state().postFailures || 0, 0)
})

test('低下限不走分块：一稿 + 带原文补写，别多烧回合', async (t) => {
  // 下限 100 < CHUNK_TARGET_MIN：维持老路径（一稿不够再补写整篇）
  const f = fx()
  t.after(() => f.close())
  f.setPostMode('shortThenFixed')

  f.at(10, 0)
  await f.hb.tick()

  assert.equal(f.turns.filter((x) => isPostPrompt(x.prompt)).length, 1, '写第一稿一次')
  assert.equal(f.turns.filter((x) => isOutlinePrompt(x.prompt)).length, 0, '低下限不该走分块')
  const fixTurns = f.turns.filter((x) => isFixPrompt(x.prompt))
  assert.equal(fixTurns.length, 1, '太短时补写一轮')
  // 补写那一轮必须把原文和差额都带上，否则模型只会从零再写一篇同样短的
  assert.match(fixTurns[0].prompt, /还差 \d+ 字/)
  assert.match(fixTurns[0].prompt, /今天刷到一条/, '要带上原文')
  assert.match(fixTurns[0].prompt, /保留原文的口吻和结构/)

  assert.equal(f.posted.length, 1, '补够之后真的发出去了')
  assert.match(String(f.posted[0].title), /补长后的测试帖/)
  assert.equal(f.hb.state().postFailures || 0, 0, '发成功要清零退避')
})

test('补写最多两轮就收：还不行按失败退避，不无限重写', async (t) => {
  const f = fx()
  t.after(() => f.close())
  f.setPostMode('short')   // 第一稿和两轮补写都回短稿

  f.at(10, 0)
  await f.hb.tick()
  assert.equal(f.turns.filter((x) => isPostPrompt(x.prompt)).length, 1, '第一稿只写一次')
  assert.equal(f.turns.filter((x) => isFixPrompt(x.prompt)).length, 2, '补写两轮就收手')
  assert.equal(f.posted.length, 0)
  assert.equal(f.hb.state().postFailures, 1, '这一整篇算一次失败（不是两次）')

  // 退避期内连试都不试
  f.at(10, 1)
  await f.hb.tick()
  assert.equal(f.turns.filter((x) => isFixPrompt(x.prompt)).length, 2, '退避期内不补写')
})

test('分块大纲拿不到：退回整篇补写，不硬发半截稿', async (t) => {
  // 高下限走分块，但大纲那一轮回垃圾 → 应退回全文补写，而不是发一条空的
  const f = fx({ heybox: { postWordsMin: 1200, postWordsMax: 3000 } })
  t.after(() => f.close())
  f.setPostMode('short')

  f.at(10, 0)
  await f.hb.tick()
  assert.equal(f.turns.filter((x) => isOutlinePrompt(x.prompt)).length, 1, '试过大纲')
  assert.equal(f.turns.filter((x) => isSectionPrompt(x.prompt)).length, 0, '没大纲就不逐段生成')
  assert.equal(f.turns.filter((x) => isFixPrompt(x.prompt)).length, 2, '退回整篇补写两轮')
  assert.equal(f.posted.length, 0)
  assert.equal(f.hb.state().postFailures, 1)
})
