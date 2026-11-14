// 小红书模块测试：链接/短链解析、摘要（site 纯函数）→ 刷一轮的写操作上限与试运行、验证码停手、
// 评论上限、发帖草稿确认流（未确认绝不 publish）、私信首次只记不回、主人核对防篡改、
// 装配层（index.mjs）的 defaults / settings / 工具面。全部用假浏览器 + 假 site 注入，不打真网络。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let site
let duty
let visionLib
let shotsLib
let xhsIndex
let access
let store

const ID1 = 'a'.repeat(24)
const ID2 = 'b'.repeat(24)
const ID3 = 'c'.repeat(24)
const OWNER_LINK = `https://www.xiaohongshu.com/user/profile/${'f'.repeat(24)}`
const OWNER = { userId: 'f'.repeat(24), nickname: '主人小号' }

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-xhs-'))
  site = await import('../lib/site.mjs')
  duty = await import('../lib/duty.mjs')
  visionLib = await import('../lib/vision.mjs')
  shotsLib = await import('../lib/shots.mjs')
  xhsIndex = (await import('../index.mjs')).default
  access = globalThis.aurabot.lib('chat/access.js')
  store = globalThis.aurabot.lib('core/store.js') // duty 的状态文件 xhs.json 也在插件数据目录
})

const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return fn() }

/** 一篇推荐流卡片（site.feed 的返回形状，契约 §2）。 */
const card = (id, o = {}) => ({ noteId: id, title: `笔记${id.slice(0, 4)}`, author: `作者${id.slice(0, 4)}`, cover: 'https://img.xhs/1.jpg', ...o })

/** site.readNote 的返回形状（契约 §2/§6：含封面与正文配图）。 */
const readOf = (id) => ({
  note: { noteId: id, title: `笔记${id.slice(0, 4)}`, desc: `${id} 的正文内容`, author: `作者${id.slice(0, 4)}`, likes: 1200, collects: 88, comments: 12, isVideo: false, cover: 'https://img.xhs/c.jpg', images: ['https://img.xhs/1.jpg', 'https://img.xhs/2.jpg'] },
  comments: [{ name: '路人甲', text: '太好了', likes: 99 }],
})

/**
 * 假的小红书网页（契约 §2/§6 的 site 接口面）：记下每次点赞/收藏/评论/发帖/分享落在哪篇笔记上。
 * siteOpts 扩展：feedFresh=每轮推荐给全新笔记（关键词交替测试用）；searchMap={词: 卡片[]}；
 * comments=commentsOfNote 的固定返回；shareError/shareAlready=站内分享行为；commentError=评论抛错。
 */
function fakeSite({
  feed = [card(ID1), card(ID2), card(ID3)], verify = '', likeError = null, publishCalls = [],
  feedFresh = false, searchMap = {}, comments = null, shareError = null, shareAlready = false, commentError = null,
  ownNotesList = null,
} = {}) {
  const calls = { ensure: 0, read: [], like: [], collect: [], comment: [], feed: 0, search: [], dms: 0, dm: [], publish: [], share: [], ownNotes: 0, commentsOf: [], reply: [] }
  const freshId = (k) => k.toString(16).padStart(24, '0')
  return {
    calls,
    publishCalls,
    ensure: async () => { calls.ensure++; return { ok: true } },
    verify: async () => verify,
    self: async () => ({ userId: OWNER.userId, nickname: '她的小号' }),
    feed: async () => {
      calls.feed++
      if (feedFresh) return [card(freshId(calls.feed * 3 - 2)), card(freshId(calls.feed * 3 - 1)), card(freshId(calls.feed * 3))]
      return calls.feed === 1 ? feed : []
    },
    search: async (word) => { calls.search.push(word); return searchMap[word] || [] },
    openNote: async () => {},
    readNote: async (id) => { calls.read.push(id); return readOf(id) },
    like: async (id) => { if (likeError) throw likeError; calls.like.push(id); return { ok: true } },
    collect: async (id) => { calls.collect.push(id); return { ok: true } },
    comment: async (id, text, o = {}) => {
      if (commentError) throw commentError
      calls.comment.push(o.at ? [id, text, o.at] : [id, text])
      return { ok: true, cid: 'cid1' }
    },
    // §6 站内分享：认人（who 由 duty 传 ownerConfirmed），「已发送」返回 already；shareError 模拟找不到人
    share: async (id, who) => {
      if (shareError) throw Object.assign(new Error('分享面板里没找到主人（可能需互关）'), { code: 'share' })
      calls.share.push([id, who.userId, who.nickname])
      return shareAlready ? { ok: true, already: true } : { ok: true }
    },
    // §6 回评论链路：自己的笔记 → 它的评论 → 回某条
    ownNotes: async () => { calls.ownNotes++; return ownNotesList || [{ noteId: ID1, title: `笔记${ID1.slice(0, 4)}` }] },
    commentsOfNote: async (id) => { calls.commentsOf.push(id); return comments || [{ cid: 'c1', userId: 'u1', nickname: '路人甲', text: '问个好' }, { cid: 'c2', userId: 'u2', nickname: '路人乙', text: '求链接' }] },
    replyComment: async (id, cid, text) => { calls.reply.push([id, cid, text]); return { ok: true, cid } },
    profileOf: async (link) => {
      const id = String(link).match(/user\/profile\/([0-9a-f]{24})/)?.[1]
      if (!id) throw new Error('没认出这是谁的主页')
      return { userId: id, nickname: OWNER.nickname }
    },
    dms: async () => { calls.dms++; return dmChat.slice() },
    sendDm: async (text) => { if (calls.dmFail > 0) { calls.dmFail--; throw new Error('小红书网页版私信结构变了，需要人工看看') } calls.dm.push(text); return { ok: true } },
    loginStart: async () => ({ ok: true, loggedIn: false, shot: 'data:image/png;base64,QR' }),
    loginPoll: async () => ({ ok: true, loggedIn: true, me: { userId: OWNER.userId, nickname: '她的小号' } }),
    publish: async (draft) => { calls.publish.push(draft); return { ok: true } },
    screenshot: async () => 'data:image/png;base64,SHOT',
    show: async () => {},
    connected: () => false,
  }
}

let dmChat = []

let n = 0
/** 组一套可跑的 duty：假 site + 假 think + 记录型 sendOwnerQQ；每次给全新的数据目录。 */
function setup({ decisions = [], cfg = {}, turn, siteOpts = {}, now, vision, shots, sendImageToOwner } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-xhs-' + n++ + '-'))
  const sent = []
  const images = [] // sendImageToOwner（图片通道：验证码截图 / 站内动作发图）的调用记录
  const events = []
  const g = {
    enabled: true, dryRun: false, browserPath: '',
    perRun: 3, dwellMin: 0, dwellMax: 0, maxWatchPerDay: 40, maxRunsPerDay: 4, intervalHours: 4,
    likeEnabled: true, collectEnabled: true, commentEnabled: true, shareEnabled: true, dmEnabled: true, publishEnabled: true,
    capLike: 20, capCollect: 10, capComment: 3, capShare: 5, capPublish: 1,
    minWriteGapSec: 0, newAccountDays: 0, shareTo: 'qq', dmPollMinutes: 7,
    ownerInput: OWNER_LINK,
    keywords: '', visionEnabled: false, shotChance: 0, atOwnerEnabled: false, capAtOwner: 3,
    replyEnabled: false, capReply: 5, replyPollMinutes: 30, shotLibrary: 30,
    // ownerQQ / ownerName 不在模块 settings 里（社区模块），duty 从 getConfig 整体读，这里照 index 的并法补上
    ownerQQ: '10000001', ownerName: '主人',
    ...cfg,
  }
  const fs = fakeSite(siteOpts)
  const notes = [] // memory.noteVia（小红书私信 ↔ QQ 记忆链路）的调用记录
  const queries = [] // memory.contextVia 的调用记录
  const prompts = [] // 每次 think 的完整 prompt（断言 @ 规则 / 画面描述 / 决策字段用）
  const memory = {
    addEvent: (e) => events.push(e.text),
    add: (m) => events.push('记住:' + m.text),
    noteVia: (entry) => notes.push(entry),
    contextVia: (entry) => { queries.push(entry); return '' },
  }
  const dy = duty.createXhs({
    getConfig: () => g,
    // 和 index 里同款：把 ownerConfirmed 并进状态文件（duty 写完会自己从文件并回）
    setOwnerConfirmed: (rec) => {
      const f = store.dataDir('xhs.json')
      const cur = store.readJson(f, () => ({ version: 1 }))
      store.writeJson(f, { ...(cur && typeof cur === 'object' ? cur : {}), version: 1, ownerConfirmed: rec })
      return rec
    },
    think: async (p) => { prompts.push(p); return turn ? turn(p) : JSON.stringify(decisions) },
    sendOwnerQQ: async (text, itemId) => { sent.push([text, itemId]); return true },
    sendImageToOwner: sendImageToOwner || (async (b64, caption, itemId) => { images.push([b64, caption, itemId]); return true }),
    pushToSession: async () => {},
    memory,
    log: { info() {}, warn() {}, debug() {} },
    site: fs,
    now,
    wait: async () => {},
    isSilence: (t) => !String(t || '').trim(),
    ...(vision ? { vision } : {}), // 假视觉（测试传；不传 duty 自建真实现但 visionEnabled 关着不会触发）
    ...(shots ? { shots } : {}),
    shotsDir: process.env.AURABOT_DATA_DIR, // 截图库目录（测试指到本轮临时目录）
  })
  return { dy, fs, sent, images, events, g, notes, queries, prompts }
}

// ---------- 1. site 纯函数：链接解析 / 短链 / 摘要 ----------

test('解析：认 explore / discovery / 裸 id 笔记链接与 xhslink 短链', () => {
  assert.deepEqual(site.findNoteId(`看这个 https://www.xiaohongshu.com/explore/${ID1}?x=1`), { noteId: ID1 })
  assert.deepEqual(site.findNoteId(`https://www.xiaohongshu.com/discovery/item/${ID2}`), { noteId: ID2 })
  assert.deepEqual(site.findNoteId(ID3), { noteId: ID3 }, '裸 24 位十六进制也算笔记 id')
  assert.deepEqual(site.findNoteId('7.4 复制打开小红书 https://xhslink.com/AbC-12/ 哈哈'), { short: 'https://xhslink.com/AbC-12/' })
  assert.equal(site.findNoteId('没有链接'), null)
  assert.equal(site.findNoteId('https://www.xiaohongshu.com/explore/只有23位0123456789abcdef01234'), null, '24 位十六进制才认')
})

test('解析：短链跟着跳转拿到笔记 id；跳不到就空串', async () => {
  const hops = { 'https://xhslink.com/abc/': `https://www.xiaohongshu.com/explore/${ID1}?share=x` }
  const fake = async (url) => ({ headers: { get: (k) => (k === 'location' ? hops[url] || null : null) } })
  assert.equal(await site.resolveShort('https://xhslink.com/abc/', fake), ID1)
  assert.equal(await site.resolveShort('https://xhslink.com/none/', fake), '')
})

test('给她看的摘要：标题、作者、赞藏评、正文节选、热评都在', () => {
  const d = site.digestOf(readOf(ID1).note, readOf(ID1).comments)
  assert.match(d, new RegExp(`《笔记${ID1.slice(0, 4)}》`))
  assert.match(d, new RegExp(`作者${ID1.slice(0, 4)}`))
  assert.match(d, /赞|藏|评/)
  assert.match(d, /正文内容/)
  assert.match(d, /热评|路人甲/)
})

// ---------- 2. 刷一轮：caps 与 dryRun ----------

test('刷一轮：一篇篇认真看，点赞/收藏/评论落在她说要动的笔记上，分享走 QQ，看完写成她的记忆', async () => {
  const { dy, fs, sent, events } = setup({ decisions: [
    { i: 1, feeling: '好喜欢', like: true, collect: true, comment: '收藏了！', share: '主人看这篇', remember: '' },
    { i: 2, feeling: '一般', like: false, collect: false, comment: '', share: '' },
    { i: 3, feeling: '不错', like: true, collect: false, comment: '', share: '', remember: '有篇讲收纳的' },
  ] })
  const r = await dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(fs.calls.read, [ID1, ID2, ID3], '三篇都认真看了')
  assert.deepEqual(fs.calls.like, [ID1, ID3])
  assert.deepEqual(fs.calls.collect, [ID1])
  assert.deepEqual(fs.calls.comment, [[ID1, '收藏了！']])
  assert.equal(sent.length, 1, '只分享了她说要分享的那篇')
  assert.match(sent[0][0], /主人看这篇/)
  assert.ok(sent[0][0].includes(`https://www.xiaohongshu.com/explore/${ID1}`), '分享带上笔记链接')
  // 记忆链路：addEvent（经历）与 add（记住的事）都要被调到
  assert.ok(events.some((e) => /在小红书看了.*作者.*的《/.test(e)), '每篇看完写一条经历记忆（addEvent）')
  assert.ok(events.some((e) => String(e).includes('记住:有篇讲收纳的')), '值得记的事写进记忆（add）')
  const st = dy.state()
  assert.ok(st.history.some((x) => x.kind === 'share'), '分享记进运行历史')
})

test('试运行：不真点赞收藏评论；发帖也不调 publish', async () => {
  const dry = setup({ cfg: { dryRun: true }, decisions: [{ i: 1, like: true, collect: true, comment: '好', share: '主人看' }] })
  await dry.dy.run({ force: true })
  assert.deepEqual(dry.fs.calls.like, [], '试运行不真点')
  assert.deepEqual(dry.fs.calls.collect, [])
  assert.deepEqual(dry.fs.calls.comment, [])
  const d = await dry.dy.saveDraft({ title: '试运行', desc: 'x', images: [] })
  await dry.dy.confirmDraft(d.id)
  assert.deepEqual(dry.fs.calls.publish, [], '试运行 publish 不调')
})

test('每天上限：评论超过上限不再发；主人让她点赞也受同一个上限管', async () => {
  const { dy, fs } = setup({ cfg: { capComment: 1 }, decisions: [
    { i: 1, comment: '第一条' },
    { i: 2, comment: '第二条' },
    { i: 3, comment: '第三条' },
  ] })
  const r = await dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(fs.calls.comment.length, 1, '评论每天上限 1 条')
  const one = await dy.commentNote(`https://www.xiaohongshu.com/explore/${ID2}`, '还想评')
  assert.equal(one.ok, false)
  assert.match(one.message, /次数|上限/)
})

// ---------- 3. 验证码停手 ----------

test('点赞遇到验证码：当天停手、通知主人一次，之后主人的指令也被挡', async () => {
  const err = Object.assign(new Error('要验证：请完成安全验证'), { code: 'verify' })
  const { dy, fs, sent } = setup({ siteOpts: { likeError: err }, decisions: [
    { i: 1, like: true }, { i: 2, like: true }, { i: 3, like: true },
  ] })
  const r = await dy.run({ force: true })
  assert.equal(r.ok, true)
  assert.equal(fs.calls.like.length, 0, '点赞没成功（验证码拦下），后面也不再试')
  assert.equal(sent.filter(([t]) => /验证/.test(t)).length, 1, '只通知主人一次')
  const st = dy.state()
  assert.match(String(st.pauseReason || ''), /验证/)
  const w = await dy.likeNote(`https://www.xiaohongshu.com/explore/${ID2}`)
  assert.equal(w.ok, false)
  assert.match(w.message, /暂停|停/)
})

// ---------- 4. 草稿确认流 ----------

test('发帖草稿流：saveDraft 只存草稿不发布；主人确认后才 publish；驳回的不发；没开启功能存不了', async () => {
  const { dy, fs } = setup()
  // 图片必须先放在本轮数据目录的 xhs/ 下（setup() 换过目录，先 setup 再造图）
  mkdirSync(join(process.env.AURABOT_DATA_DIR, 'xhs'), { recursive: true })
  const img = join(process.env.AURABOT_DATA_DIR, 'xhs', 'a.png')
  writeFileSync(img, 'png')
  const d = await dy.saveDraft({ title: '我的第一篇笔记', desc: '正文内容', images: [img] })
  assert.equal(d.ok, true, d.message)
  assert.equal(fs.calls.publish.length, 0, '存草稿绝不发布')
  const list = await dy.pendingDrafts()
  assert.equal(list.length, 1)
  // 乱传数据目录外的图片路径要被拒
  const bad = await dy.saveDraft({ title: '偷带图', desc: 'x', images: ['C:\\Windows\\system32\\evil.png'] })
  assert.equal(bad.ok, false)
  // 确认后真的发
  const ok = await dy.confirmDraft(d.id)
  assert.equal(ok.ok, true, ok.message)
  assert.equal(fs.calls.publish.length, 1)
  assert.equal(fs.calls.publish[0].title, '我的第一篇笔记')
  assert.deepEqual(await dy.pendingDrafts(), [], '发过的草稿不再列在待确认里')
  // 再确认一次不会发第二遍
  await dy.confirmDraft(d.id)
  assert.equal(fs.calls.publish.length, 1)
  // 驳回的不发
  const d2 = await dy.saveDraft({ title: '不要发这篇', desc: 'x', images: [] })
  await dy.rejectDraft(d2.id)
  assert.equal(fs.calls.publish.length, 1)
  // 功能没开存不了
  const off = setup({ cfg: { publishEnabled: false } })
  const no = await off.dy.saveDraft({ title: 'x', desc: 'y', images: [] })
  assert.equal(no.ok, false)
})

test('发帖：试运行不真发；publish 失败草稿留在待确认里可以再试', async () => {
  const dry = setup({ cfg: { dryRun: true } })
  const d = await dry.dy.saveDraft({ title: '试运行', desc: 'x', images: [] })
  await dry.dy.confirmDraft(d.id)
  assert.deepEqual(dry.fs.calls.publish, [], '试运行 publish 不调')

  const fail = setup({ siteOpts: { feed: [] } })
  const d2 = await fail.dy.saveDraft({ title: '会失败的', desc: 'x', images: [] })
  fail.fs.publish = async () => { throw Object.assign(new Error('发布按钮没点上'), { code: 'publish' }) }
  const r = await fail.dy.confirmDraft(d2.id)
  assert.equal(r.ok, false)
  assert.equal((await fail.dy.pendingDrafts()).length, 1, '失败的草稿保留 pending')
})

// ---------- 5. 私信：dmInit 首看不回 ----------

test('主人私信：第一次只记下旧消息不回；之后只回主人的新消息；[去刷小红书] 触发词去刷一轮并回来说结果', async () => {
  const t = Date.now()
  dmChat = [{ id: 'm1', mine: false, text: '昨天的话', at: t - 3600_000 }]
  const { dy, fs, notes, queries } = setup({ siteOpts: { feed: [] }, turn: (p) => (/系统消息|没刷成/.test(p) ? '刚才没刷成，推荐里没刷到新的' : '好呀等我\n[去刷小红书]'), now: () => t })
  const c = await dy.confirmOwner(OWNER_LINK)
  assert.equal(c.ok, true, c.message)
  let r = await dy.checkOwnerDms()
  assert.equal(r.replied, 0, '第一次只记不回')
  assert.equal(fs.calls.dm.length, 0)
  // 主人的新消息 → 回；标记不发出去；随后真的去刷了一轮（推荐里没刷到新笔记 → 回来说没刷成）
  dmChat.push({ id: 'm2', mine: false, text: '刷会儿小红书给我找篇笔记', at: t })
  r = await dy.checkOwnerDms()
  assert.equal(r.replied, 1)
  assert.deepEqual(fs.calls.dm, ['好呀等我'], '[去刷小红书] 标记不发出去')
  assert.ok(await until(() => fs.calls.feed > 0), '回完就去刷了一轮')
  assert.ok(await until(() => fs.calls.dm.length === 2), '刷完在私信里照实说一声')
  assert.equal(fs.calls.dm[1], '刚才没刷成，推荐里没刷到新的')
  // 记忆链路：主人的消息和她的回复都经 noteVia 写进 QQ 记忆；回复前经 contextVia 取印象
  assert.ok(notes.some((x) => x.via === 'xhs' && x.who === 'user' && x.text === '刷会儿小红书给我找篇笔记'), '主人消息经 noteVia 记进记忆')
  assert.ok(notes.some((x) => x.via === 'xhs' && x.who === 'bot' && x.text === '好呀等我'), '她的回复经 noteVia 记进记忆')
  assert.ok(queries.some((x) => x.qq === '10000001' && String(x.query).includes('刷会儿小红书')), '回复前经 contextVia 取主人相关印象')
  // 同一条不回第二次
  assert.equal((await dy.checkOwnerDms()).replied, 0)
})

// ---------- 6. ownerConfirmed 防篡改 ----------

test('主人核对：没核对不看私信；面板改了 ownerInput 后必须重新核对', async () => {
  const t = Date.now()
  dmChat = [{ id: 'm1', mine: false, text: '旧消息', at: t - 3600_000 }]
  const no = setup({ turn: () => '在呢', now: () => t })
  const r0 = await no.dy.checkOwnerDms()
  assert.equal(r0.ok, false, '没核对过主人号：不看私信')

  const { dy, fs, g } = setup({ turn: () => '在呢', now: () => t })
  await dy.confirmOwner(OWNER_LINK)
  let r = await dy.checkOwnerDms()
  assert.equal(r.replied, 0, '第一次只记不回')
  dmChat.push({ id: 'm2', mine: false, text: '在吗', at: t })
  assert.equal((await dy.checkOwnerDms()).replied, 1)
  // 改输入（比如有人在面板动了配置）：认不出主人了，必须重新核对
  g.ownerInput = `https://www.xiaohongshu.com/user/profile/${'e'.repeat(24)}`
  dmChat.push({ id: 'm3', mine: false, text: '又发了一条', at: t })
  const r2 = await dy.checkOwnerDms()
  assert.equal(r2.ok, false, '篡改后不再回新消息')
  assert.equal(fs.calls.dm.length, 1, '篡改后不再回新消息')
  // 重新核对新输入后恢复
  const c2 = await dy.confirmOwner(g.ownerInput)
  assert.equal(c2.ok, true, c2.message)
  assert.equal((await dy.checkOwnerDms()).replied, 1)
  assert.equal(fs.calls.dm.length, 2)
})

// ---------- 7. 装配层（index.mjs） ----------

function fakeApi(g) {
  const routes = new Map()
  const builders = []
  const api = {
    core: { hub: { sendText: async () => ({ message_id: 1 }), sendSegments: async () => ({ message_id: 1 }), pushToSession: async () => {}, turnHasOwner: () => true, turnSendersAllOwner: () => true }, http: { body: async () => ({}) } },
    dsh: { fake: true },
    config: () => ({ ownerQQ: '10000001', ownerName: '主人' }),
    settings: () => ({ ...xhsIndex.defaults, ...g }),
    dataDir: (...parts) => store.dataDir(...parts),
    log: { info() {}, warn() {}, debug() {} },
    lazy: () => ({}),
    every: () => () => {},
    onDispose: () => {},
    route: (p, h) => routes.set(p, h),
    tool: (b) => builders.push(b),
    defineTool: (t) => t,
    proactive: undefined,
    __xhsTestHooks: { site: fakeSite(), wait: async () => {} },
  }
  return { api, routes, builders }
}

test('装配：defaults 齐全；settings 留空由 panel.js 接管表单（平台页不再画原生表单）', () => {
  const keys = Object.keys(xhsIndex.defaults)
  for (const k of ['enabled', 'dryRun', 'browserPath', 'perRun', 'dwellMin', 'dwellMax', 'maxWatchPerDay', 'maxRunsPerDay', 'intervalHours', 'likeEnabled', 'collectEnabled', 'commentEnabled', 'shareEnabled', 'dmEnabled', 'publishEnabled', 'capLike', 'capCollect', 'capComment', 'capShare', 'capPublish', 'minWriteGapSec', 'newAccountDays', 'shareTo', 'dmPollMinutes', 'ownerInput', 'keywords', 'visionEnabled', 'shotChance', 'atOwnerEnabled', 'capAtOwner', 'replyEnabled', 'capReply', 'replyPollMinutes', 'shotLibrary']) {
    assert.ok(keys.includes(k), `defaults 缺 ${k}`)
  }
  assert.equal(xhsIndex.defaults.publishEnabled, false, '发帖默认关')
  assert.equal(xhsIndex.defaults.enabled, false, '模块默认关')
  assert.equal(xhsIndex.defaults.visionEnabled, false, '视觉默认关')
  assert.equal(xhsIndex.defaults.atOwnerEnabled, false, '@主人默认关')
  assert.equal(xhsIndex.defaults.replyEnabled, false, '回评论默认关')
  assert.equal(xhsIndex.defaults.shotChance, 0.3, '截图库存图概率默认 0.3')
  assert.deepEqual(xhsIndex.settings, [], 'settings 数组必须留空（原生表单由 panel.js 接管，平台页只渲染自定义面板）')
  assert.equal(xhsIndex.id, 'xhs')
  // 版本不再写死在测试里（和 heybox 同口径）：升版时这条不该跟着挂。
  const xhsManifest = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
  assert.equal(xhsIndex.version, xhsManifest.version, 'index.mjs 与 module.json 的 version 要一致')
})

test('装配：setup 注册全部面板路由；工具按权限档出现，模块没开时不挂', () => {
  const { api, routes, builders } = fakeApi({ enabled: true })
  const dy = xhsIndex.setup(api)
  assert.equal(typeof dy.tick, 'function', 'setup 返回 duty（面板/定时都要用）')
  for (const p of ['/state', '/account', '/login', '/login/status', '/window', '/run', '/share', '/dm', '/dms', '/replies/run', '/shots', '/shot/delete', '/vision/state', '/confirm-owner', '/drafts', '/draft/confirm', '/draft/reject']) {
    assert.ok(routes.has(p), `缺路由 ${p}`)
  }
  assert.equal(xhsIndex.panel, 'panel.js', '自定义面板要挂上（panel.js）')
  assert.ok(builders.length >= 1)
  const chat = { chatId: 'private:10000001', kind: 'private', userId: '10000001' }
  const tools = builders.flatMap((b) => b({ chat, sessionId: 's' }))
  const names = tools.map((t) => t.name)
  for (const want of ['xhs_watch', 'xhs_recent', 'xhs_browse', 'xhs_like', 'xhs_collect', 'xhs_comment', 'xhs_send_dm', 'xhs_confirm_owner', 'xhs_publish_draft', 'xhs_draft_list', 'xhs_publish_confirm', 'xhs_send_shot', 'xhs_shot_list', 'xhs_reply_comments']) {
    assert.ok(names.includes(want), `缺工具 ${want}`)
  }
  // 模块没开：一个工具都不挂
  const off = fakeApi({ enabled: false })
  xhsIndex.setup(off.api)
  assert.deepEqual(off.builders.flatMap((b) => b({ chat, sessionId: 's' })), [])
})

test('装配：权限档 permOf 对 xhs 键默认仅主人，off 能关掉工具；permOf 抛错时兜底放行', () => {
  const cfg = { profilePerms: {} }
  assert.equal(access.permOf(cfg, 'xhsLike'), 'owner', '没配过的档位默认仅主人')
  const off = access.permOf({ profilePerms: { xhsLike: 'off' } }, 'xhsLike')
  assert.equal(off, 'off')
  // permOf 抛错（社区模块没加载 access 时）兜底放行：用 index 里同款 try/catch 口径验
  const permAllow = (g, key) => { try { return access.permOf(g, key) !== 'off' } catch { return true } }
  assert.equal(permAllow({ profilePerms: { xhsLike: 'off' } }, 'xhsLike'), false)
  assert.equal(permAllow({}, 'xhsLike'), true)
})

// ---------- 8. v2 六件新功能 ----------

const IDA = 'd'.repeat(24)
const IDB = 'e'.repeat(24)

test('真·@主人：核对过 + 开了开关才真 @（上限管着、手打 @ 去掉、单独计数）', async () => {
  const at = setup({ cfg: { atOwnerEnabled: true, capAtOwner: 1 }, decisions: [
    { i: 1, comment: '@主人 你快看这个', at: true },
    { i: 2, comment: '普通的' },
    { i: 3, comment: '还想 @', at: true },
  ] })
  await at.dy.confirmOwner(OWNER_LINK)
  const r = await at.dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.match(at.prompts[0], /"at":true\/false/, '核对过 + 开关开着才在 prompt 里给 at 字段')
  assert.match(at.prompts[0], /这次最多 @ 1 次/)
  assert.deepEqual(at.fs.calls.comment[0], [ID1, '你快看这个', { userId: OWNER.userId, nickname: OWNER.nickname }], '手打的 @主人 被去掉，真 @ 由系统做、落在她说要动的笔记上')
  assert.equal(at.fs.calls.comment.filter((c) => c[2]).length, 1, '只真 @ 了 1 次（上限 1）')
  assert.equal(at.fs.calls.comment.length, 3, '没写 at / 超 @ 上限的照常普通评论')
  const st = at.dy.state()
  assert.equal(st.atOwner, 1, '@ 主人单独计数')
  assert.match(r.message, /@了/)
})

test('@ 主人：没核对 / 开关关不提也不 @；mention 失败按普通失败记，不当风控停手', async () => {
  // 开关关：prompt 里没有 at 字段
  const off = setup({ decisions: [{ i: 1, comment: '好看的' }] })
  await off.dy.run({ force: true })
  assert.doesNotMatch(off.prompts[0], /"at"/)
  // 开关开但没核对：也不 @
  const no = setup({ cfg: { atOwnerEnabled: true }, decisions: [{ i: 1, comment: '好看', at: true }] })
  await no.dy.run({ force: true })
  assert.equal(no.fs.calls.comment.filter((c) => c[2]).length, 0, '没核对主人的号就不真 @')
  // mention 失败：普通失败（记 error），不停手、之后还能正常写
  const mentionErr = Object.assign(new Error('@ 候选里没找到主人（可能互相没关注）'), { code: 'mention' })
  const m = setup({ cfg: { atOwnerEnabled: true, capAtOwner: 3 }, siteOpts: { commentError: mentionErr }, decisions: [{ i: 1, comment: '快看', at: true }, { i: 2, comment: '普通的' }] })
  await m.dy.confirmOwner(OWNER_LINK)
  const r = await m.dy.run({ force: true })
  assert.equal(r.ok, true)
  const st = m.dy.state()
  assert.equal(String(st.pauseReason || ''), '', 'mention 失败不算风控停手')
  assert.ok(st.history.some((x) => x.kind === 'error' && /没找到主人/.test(x.text)))
  const w = await m.dy.likeNote(`https://www.xiaohongshu.com/explore/${ID2}`)
  assert.equal(w.ok, true, '没停手：之后还能正常点赞')
})

test('站内分享：dm 只站内、both 两边都发、站内失败回落 QQ', async () => {
  const dm = setup({ cfg: { shareTo: 'dm' }, decisions: [{ i: 1, share: '主人看' }] })
  await dm.dy.confirmOwner(OWNER_LINK)
  const r = await dm.dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(dm.fs.calls.share.map((x) => [x[0], x[1]]), [[ID1, OWNER.userId]], '站内分享认的是核对过的主人')
  assert.deepEqual(dm.sent, [], 'dm 不发 QQ')
  assert.deepEqual(dm.dy.state().history.find((x) => x.kind === 'share').via, ['xhs'])

  const both = setup({ cfg: { shareTo: 'both' }, decisions: [{ i: 1, share: '主人看' }] })
  await both.dy.confirmOwner(OWNER_LINK)
  await both.dy.run({ force: true })
  assert.equal(both.fs.calls.share.length, 1)
  assert.equal(both.sent.length, 1, 'both 两边都发')

  const fail = setup({ cfg: { shareTo: 'dm' }, siteOpts: { shareError: true }, decisions: [{ i: 1, share: '主人看' }] })
  await fail.dy.confirmOwner(OWNER_LINK)
  await fail.dy.run({ force: true })
  assert.equal(fail.fs.calls.share.length, 0)
  assert.equal(fail.sent.length, 1, '站内失败回落 QQ')
  assert.ok(fail.dy.state().history.some((x) => x.kind === 'error' && /改发 QQ/.test(x.text)))
})

test('关键词巡游：隔轮交替搜（猫→狗），搜索轮照常看/赞/评', async () => {
  const kw = setup({
    cfg: { keywords: '猫\n狗', maxRunsPerDay: 99 },
    siteOpts: { feedFresh: true, searchMap: { '猫': [card(IDA)], '狗': [card(IDB)] } },
    decisions: [{ i: 1, like: true }],
  })
  // 不带 force：run 计数才走隔轮交替（s.runs 0→1→2→3）
  assert.equal((await kw.dy.run({})).ok, true, '第 1 轮（推荐）')
  assert.equal((await kw.dy.run({})).ok, true, '第 2 轮（搜「猫」）')
  assert.equal((await kw.dy.run({})).ok, true, '第 3 轮（推荐）')
  const r4 = await kw.dy.run({})
  assert.equal(r4.ok, true, '第 4 轮（搜「狗」）')
  assert.deepEqual(kw.fs.calls.search, ['猫', '狗'], '隔轮交替：先「猫」后「狗」')
  assert.ok(kw.fs.calls.read.includes(IDA) && kw.fs.calls.read.includes(IDB), '搜到的笔记也认真看了')
  const st = kw.dy.state()
  assert.equal(st.keyword.total, 2)
  assert.ok(st.watched >= 6, '推荐轮 + 搜索轮都看了笔记')
})

test('视觉看图：画面描述进 think prompt、按概率存截图库；开关关不碰视觉', async () => {
  let descCalls = 0
  const dl = []
  const fakeVision = {
    pickAndDownload: async ({ note }) => { dl.push(note.noteId); return { buf: Buffer.from('img-' + note.noteId) } },
    describeNote: async () => { descCalls++; return '一只橘猫趴在窗台上晒太阳' },
  }
  const saved = []
  const fakeShots = { saveShot: (x) => { saved.push(x); return { file: 'x.jpg' } } }
  const v = setup({ cfg: { visionEnabled: true, shotChance: 1 }, siteOpts: { feed: [card(ID1)] }, decisions: [{ i: 1 }], vision: fakeVision, shots: fakeShots })
  await v.dy.run({ force: true })
  assert.match(v.prompts[0], /画面：一只橘猫趴在窗台上晒太阳/, '画面描述拼进她看的 prompt')
  assert.equal(descCalls, 1, '一篇笔记问一次图')
  assert.equal(saved.length, 1, 'shotChance=1 存进截图库')
  assert.equal(saved[0].noteId, ID1)
  assert.ok(saved[0].note.includes('橘猫'), '截图条目带上画面描述')
  // 开关关：不碰视觉、prompt 无画面
  const off = setup({ siteOpts: { feed: [card(ID1)] }, decisions: [{ i: 1 }], vision: fakeVision })
  await off.dy.run({ force: true })
  assert.doesNotMatch(off.prompts[0], /画面：/)
  assert.equal(dl.length, 1, '开关关不下载图')
})

test('vision.mjs：canSeeImages false 时 describeNote 安静跳过；true 时问模型', async () => {
  let asked = 0
  const no = { canSeeImages: () => false, askModel: async () => { asked++; return '描述' } }
  assert.equal(await visionLib.describeNote({ dsh: {}, cfg: {}, note: {}, images: [Buffer.from('x')], deps: no }), '', '看不了图：跳过不抛')
  assert.equal(asked, 0)
  const yes = { canSeeImages: () => true, askModel: async () => '一只橘猫趴在窗台上' }
  assert.equal(await visionLib.describeNote({ dsh: {}, cfg: {}, note: {}, images: [Buffer.from('x')], deps: yes }), '一只橘猫趴在窗台上')
})

test('截图库：同图 md5 去重、maxKeep 删最旧、pickShot 按关键词挑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-xhs-shots-'))
  const a = Buffer.from('same-image-bytes')
  const s1 = shotsLib.saveShot({ dir, buf: a, noteId: ID1, title: '猫猫', note: '橘猫', maxKeep: 2 })
  const s2 = shotsLib.saveShot({ dir, buf: a, noteId: ID2, title: '同图', maxKeep: 2 })
  assert.equal(s2.file, s1.file, '同一张图去重：不重复入库')
  assert.equal(shotsLib.loadShots(dir).items.length, 1)
  shotsLib.saveShot({ dir, buf: Buffer.from('second'), noteId: ID3, title: '狗狗', maxKeep: 2 })
  shotsLib.saveShot({ dir, buf: Buffer.from('third'), noteId: ID3, title: '第三张', maxKeep: 2 })
  const left = shotsLib.loadShots(dir).items
  assert.equal(left.length, 2, 'maxKeep=2 只留最近两张')
  assert.equal(shotsLib.pickShot(left, '狗狗').title, '狗狗', '按关键词命中挑')
  assert.ok(shotsLib.shotPath(dir, left[0].file).includes(left[0].file))
  assert.equal(shotsLib.validFile('abc.jpg'), false, '库外文件名不认')
})

test('回评论：第一次只记不回；之后挑新评论回（上限管着、试运行不真回、看过的不回第二次）', async () => {
  const cms = [{ cid: 'c1', userId: 'u1', nickname: '路人甲', text: '问个好' }]
  const rp = setup({
    cfg: { replyEnabled: true, capReply: 1 },
    siteOpts: { comments: cms },
    turn: (p) => (p.includes('评论你笔记的人') ? JSON.stringify([{ i: 1, reply: '谢谢喜欢' }, { i: 2, reply: '链接晚上发' }]) : ''),
  })
  await rp.dy.confirmOwner(OWNER_LINK)
  let r = await rp.dy.replyComments()
  assert.equal(r.replied, 0)
  assert.match(r.message, /第一次/)
  assert.equal(rp.fs.calls.reply.length, 0, '开功能前的老评论不回')
  // 新评论来了：capReply=1 → 最多回 1 条
  cms.push({ cid: 'c2', userId: 'u2', nickname: '路人乙', text: '求链接' }, { cid: 'c3', userId: 'u3', nickname: '路人丙', text: '好可爱' })
  r = await rp.dy.replyComments()
  assert.equal(r.replied, 1, '评论上限 1 条')
  assert.deepEqual(rp.fs.calls.reply, [[ID1, 'c2', '谢谢喜欢']])
  assert.ok(rp.events.some((e) => /在小红书回评论/.test(e)), '回过的写成她的经历')
  assert.ok(rp.sent.some(([t]) => /回了 1 条评论/.test(t)), '给主人一条 QQ 汇总')
  // 同一批不回第二次（seen 去重）
  r = await rp.dy.replyComments()
  assert.match(r.message, /没有新评论/)
  // 试运行：不真回
  const cms2 = [{ cid: 'c1', userId: 'u1', nickname: '路人甲', text: '问个好' }]
  const dry = setup({ cfg: { replyEnabled: true, dryRun: true }, siteOpts: { comments: cms2 }, turn: () => JSON.stringify([{ i: 1, reply: '谢谢' }]) })
  await dry.dy.confirmOwner(OWNER_LINK)
  await dry.dy.replyComments()
  cms2.push({ cid: 'c2', userId: 'u2', nickname: '路人乙', text: '求链接' })
  const r2 = await dry.dy.replyComments()
  assert.equal(r2.ok, true)
  assert.equal(dry.fs.calls.reply.length, 0, '试运行不真回')
})

test('验证码停手把页面截图经图片通道发主人（v1 偏差的欠账）', async () => {
  const err = Object.assign(new Error('要验证：请完成安全验证'), { code: 'verify' })
  const vf = setup({ siteOpts: { likeError: err }, decisions: [{ i: 1, like: true }] })
  await vf.dy.run({ force: true })
  assert.ok(await until(() => vf.images.length >= 1), '图片通道被调到（截图链路是异步的）')
  assert.match(String(vf.images[0][1]), /验证/, 'caption 说明是验证页面截图')
  assert.match(String(vf.images[0][2]), /^xhs:pause:/, 'itemId 用暂停稳定键')
})
