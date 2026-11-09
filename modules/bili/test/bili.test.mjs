// B站模块（bili）测试：链接识别 / Cookie 解析 / 权限门禁 / 视频筛选与摘要 /
// 评论查重 / 点赞额度 / 历史与日报。全部在临时数据目录里跑，不联网、不调真 B 站接口。
//
// 跑法见仓库根 scripts/plugin-env.mjs：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/bili/test/*.test.mjs"

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod from '../index.js'
import { findVideoId, parseCookie } from '../lib/api.js'
import { LEVELS, checkAllowed, levelFor, presetFor, isOwner, permOf, profileToolVisible, profilePermits } from '../lib/_access.js'
import { stripMarkdown, isSilence, stripToolText, cleanOutboundText, splitLines, SILENCE } from '../lib/_reply.js'
import { pickJson, filterVideos, digestOf } from '../lib/duty.js'
import { similarity, checkCommentStyle } from '../lib/style-guard.js'
import { appendLikeEvent, currentLike, countToday, listLikesForUi, readLikeEvents, rememberVerify, readVerify, judgeVerify } from '../lib/verify.js'
import { appendHistory, readHistory, groupByDay, dayOf, isBvid, writeDiary, readDiary, hasDiaryToday, renderReport, saveReport, readReport, reportDays } from '../lib/history.js'

const MOD_DIR = fileURLToPath(new URL('../', import.meta.url))
const meta = JSON.parse(readFileSync(join(MOD_DIR, 'module.json'), 'utf8'))
const BV = 'BV1xx411c7mD'

/**
 * 建临时目录：优先用系统临时目录，不可写时退到模块目录下（有些受限环境把 %TEMP% 锁了）。
 * 回退到模块目录的那份由本文件在 after 里删，别留垃圾、更别被误提交。
 */
const madeInModule = []
function tmp(tag) {
  for (const base of [tmpdir(), join(MOD_DIR, '.test-tmp')]) {
    try {
      mkdirSync(base, { recursive: true })
      const dir = mkdtempSync(join(base, tag + '-'))
      if (base !== tmpdir()) madeInModule.push(dir)
      return dir
    } catch (error) { /* 换下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}

after(() => {
  for (const dir of madeInModule) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { /* 删不掉就算了 */ }
  }
  madeInModule.length = 0
})

before(() => {
  process.env.AURABOT_DATA_DIR = tmp('aurabot-bili')
})
beforeEach(() => {
  process.env.AURABOT_DATA_DIR = tmp('aurabot-bili')
})

// ── module.json / 元信息 ─────────────────────────────────────────────────

test('module.json 与入口的 id/version/api 一致', () => {
  assert.equal(meta.id, mod.id)
  assert.equal(meta.id, 'bili')
  assert.equal(meta.version, mod.version)
  assert.equal(meta.api, mod.api)
  assert.equal(typeof mod.setup, 'function')
})

test('声明了替换内置模块，能力覆盖联网 / 文件 / 配置 / 内部对象', () => {
  assert.equal(meta.replacesBuiltin, true)
  for (const cap of ['network', 'filesystem', 'plugin-config', 'plugin-internals']) {
    assert.ok(meta.capabilities.includes(cap), `缺 ${cap}`)
  }
})

test('入口里有 lib/ 下全部实现文件（搬模块时要一起带上）', () => {
  assert.ok(Array.isArray(mod.files) && mod.files.length > 10)
  for (const f of mod.files) assert.match(f, /^lib\/[\w-]+\.js$/)
})

// ── 链接识别 ─────────────────────────────────────────────────────────────

test('findVideoId：BV 号 / av 号 / b23 短链 / 都不是', () => {
  assert.deepEqual(findVideoId(`看这个 https://www.bilibili.com/video/${BV}`), { bvid: BV })
  assert.deepEqual(findVideoId(BV), { bvid: BV })
  assert.deepEqual(findVideoId('av12345 好看'), { aid: '12345' })
  assert.deepEqual(findVideoId('https://b23.tv/AbCd12'), { short: 'https://b23.tv/AbCd12' })
  assert.equal(findVideoId('随便一句没有链接的话'), null)
  assert.equal(findVideoId(''), null)
  assert.equal(findVideoId(null), null)
})

test('findVideoId：BV 号后面紧跟别的字符也不会切错', () => {
  assert.equal(findVideoId(`${BV}?p=2`).bvid, BV)
  assert.equal(findVideoId(`（${BV}）`).bvid, BV)
})

// ── Cookie ───────────────────────────────────────────────────────────────

test('parseCookie：只认 B 站要用的几个键，其余丢弃', () => {
  const got = parseCookie('SESSDATA=abc%2C1; bili_jct=token; DedeUserID=42; 无关=xxx; buvid3=b3')
  assert.deepEqual(got, { SESSDATA: 'abc%2C1', bili_jct: 'token', DedeUserID: '42', buvid3: 'b3' })
})

test('parseCookie：空 / 脏值不炸', () => {
  assert.deepEqual(parseCookie(''), {})
  assert.deepEqual(parseCookie(null), {})
  assert.deepEqual(parseCookie('没有等号; =空键; SESSDATA='), { SESSDATA: '' })
})

// ── 权限 ─────────────────────────────────────────────────────────────────

const CFG = {
  ownerQQ: '10000',
  ownerLevel: 'full',
  allow: { private: ['20000'], groups: ['g1'] },
  profilePerms: {},
}

test('checkAllowed：主人 / 私聊白名单 / 群白名单 / 都不在', () => {
  assert.deepEqual(checkAllowed(CFG, { kind: 'private', userId: '10000' }), { allowed: true, reason: '主人' })
  assert.equal(checkAllowed(CFG, { kind: 'private', userId: '20000' }).allowed, true)
  assert.equal(checkAllowed(CFG, { kind: 'private', userId: '30000' }).allowed, false)
  assert.equal(checkAllowed(CFG, { kind: 'group', groupId: 'g1' }).allowed, true)
  assert.equal(checkAllowed(CFG, { kind: 'group', groupId: 'g2' }).allowed, false)
})

test('levelFor：主人私聊走 ownerLevel，其余一律最多 social（群聊永远不会拿到 full）', () => {
  assert.equal(levelFor(CFG, { kind: 'private', userId: '10000' }), 'full')
  assert.equal(levelFor({ ...CFG, ownerLevel: 'chat' }, { kind: 'private', userId: '10000' }), 'chat')
  assert.equal(levelFor({ ...CFG, ownerLevel: '乱写' }, { kind: 'private', userId: '10000' }), 'full', '认不出的档位回落 full')
  assert.equal(levelFor(CFG, { kind: 'private', userId: '20000' }), 'social')
  assert.equal(levelFor(CFG, { kind: 'group', groupId: 'g1' }), 'social')
  assert.deepEqual(LEVELS, ['full', 'social', 'chat'])
})

test('presetFor：只有 full 才给私有预设，长任务另有一档', () => {
  assert.equal(presetFor('full', {}), 'aurabot-private')
  assert.equal(presetFor('full', { longTasks: true }), 'aurabot-private-long')
  assert.equal(presetFor('social', {}), 'aurabot-social')
  assert.equal(presetFor('chat', {}), 'aurabot-social')
})

test('isOwner：空 id 永远不是主人（别把空字符串当成匹配成功）', () => {
  assert.equal(isOwner(CFG, '10000'), true)
  assert.equal(isOwner(CFG, '20000'), false)
  assert.equal(isOwner(CFG, ''), false)
  assert.equal(isOwner(CFG, null), false)
})

test('permOf：没设过的项一律默认仅主人', () => {
  assert.equal(permOf(CFG, 'biliSign'), 'owner')
  assert.equal(permOf({ profilePerms: { biliSign: 'all' } }, 'biliSign'), 'all')
  assert.equal(permOf({ profilePerms: { biliSign: '乱写' } }, 'biliSign'), 'owner')
  assert.equal(permOf(null, 'biliSign'), 'owner')
})

test('profileToolVisible：off 不挂 / owner 只在主人私聊 / all 私聊群聊都挂', () => {
  const ownerChat = { kind: 'private', userId: '10000' }
  const otherChat = { kind: 'private', userId: '20000' }
  const groupChat = { kind: 'group', groupId: 'g1' }
  assert.equal(profileToolVisible({ ...CFG, profilePerms: { k: 'off' } }, 'k', ownerChat), false)
  assert.equal(profileToolVisible({ ...CFG, profilePerms: { k: 'owner' } }, 'k', ownerChat), true)
  assert.equal(profileToolVisible({ ...CFG, profilePerms: { k: 'owner' } }, 'k', otherChat), false)
  assert.equal(profileToolVisible({ ...CFG, profilePerms: { k: 'owner' } }, 'k', groupChat), false)
  assert.equal(profileToolVisible({ ...CFG, profilePerms: { k: 'all' } }, 'k', groupChat), true)
})

test('profilePermits：执行时再查一遍，别人在场时 owner 档要拒', () => {
  const ownerChat = { kind: 'private', userId: '10000' }
  const cfg = { ...CFG, profilePerms: { k: 'owner' } }
  assert.equal(profilePermits(cfg, 'k', ownerChat, true).ok, true)
  const no = profilePermits(cfg, 'k', ownerChat, false)
  assert.equal(no.ok, false)
  assert.match(no.message, /只有主人/)
  assert.equal(profilePermits({ ...CFG, profilePerms: { k: 'off' } }, 'k', ownerChat, true).ok, false)
  assert.equal(profilePermits(cfg, 'k', { kind: 'group', groupId: 'g' }, true).ok, false)
})

// ── 出口清洗 ─────────────────────────────────────────────────────────────

test('stripMarkdown：去代码块 / 行内代码 / 加粗 / 标题 / 列表 / 引用，链保留文字和地址', () => {
  const out = stripMarkdown('## 标题\n**加粗** 和 `代码`\n- 列表\n> 引用\n[链接](https://x.com/a)')
  assert.match(out, /标题/)
  assert.match(out, /加粗/)
  assert.match(out, /列表/)
  assert.match(out, /引用/)
  assert.match(out, /链接 https:\/\/x\.com\/a/)
  assert.doesNotMatch(out, /##|\*\*|`|^> /m)
})

test('isSilence：空串 / [沉默] / （沉默）都算不说话', () => {
  assert.equal(isSilence(''), true)
  assert.equal(isSilence('   '), true)
  assert.equal(isSilence(SILENCE), true)
  assert.equal(isSilence('（沉默）'), true)
  assert.equal(isSilence('(沉默)'), true)
  assert.equal(isSilence('说点什么'), false)
})

test('stripToolText：只删成对的工具标签，正文里的尖括号不动', () => {
  assert.equal(stripToolText('前<tool>{\"a\":1}</tool>后'), '前后')
  assert.equal(stripToolText('前<invoke name="x">y</invoke>后'), '前后')
  assert.equal(stripToolText('a < b 和 c > d'), 'a < b 和 c > d', '不成对的不能删')
})

test('cleanOutboundText：整段都是工具调用文字时按沉默处理，并给出告警', () => {
  let warned = 0
  const out = cleanOutboundText('<tool>{"x":1}</tool>', { warn: () => { warned++ } })
  assert.equal(out, '', '整段都是工具痕迹 → 清洗后为空（上层据此当沉默）')
  assert.equal(warned, 1, '要告警，别静默吞掉')
  assert.equal(isSilence(out), true)
  assert.equal(cleanOutboundText('正常评论', { warn: () => {} }), '正常评论')
  assert.equal(cleanOutboundText('**加粗**的评论', { warn: () => {} }), '**加粗**的评论', '这一步只拦工具文字，去 Markdown 是另一道（stripMarkdown）')
})

test('splitLines：按行拆、去空行、去首尾空格', () => {
  assert.deepEqual(splitLines(' 甲 \n\n 乙\n'), ['甲', '乙'])
  assert.deepEqual(splitLines(''), [])
})

// ── 视频筛选 / 摘要 ──────────────────────────────────────────────────────

const NOW = 1_700_000_000_000
const V = (over = {}) => ({ bvid: BV, title: '标题', author: 'UP', play: 1000, pubdate: NOW - 86400_000, ...over })

test('filterVideos：没 BV 号的 / 看过的 / 播放不够的 / 太老的都剔掉', () => {
  const list = [
    V({ bvid: 'BV1aa411c7m1' }),
    V({ bvid: 'BV1bb411c7m2', play: 10 }),
    V({ bvid: 'BV1cc411c7m3', pubdate: NOW - 400 * 86400_000 }),
    V({ bvid: '' }),
  ]
  const kept = filterVideos(list, { minViews: 100, maxAgeDays: 30, now: NOW })
  assert.deepEqual(kept.map((v) => v.bvid), ['BV1aa411c7m1'])
})

test('filterVideos：seen 里的不重复看；没有 pubdate 的放过（不能因为缺字段就全丢）', () => {
  const list = [V({ bvid: 'BV1aa411c7m1' }), V({ bvid: 'BV1bb411c7m2', pubdate: undefined })]
  assert.deepEqual(filterVideos(list, { seen: new Set(['BV1aa411c7m1']), maxAgeDays: 30, now: NOW }).map((v) => v.bvid), ['BV1bb411c7m2'])
})

test('filterVideos：空输入 / null 返回空数组', () => {
  assert.deepEqual(filterVideos(null), [])
  assert.deepEqual(filterVideos([]), [])
})

test('digestOf：标题 / UP / 播放 / BV 号在第一行，简介截断，热评最多 8 条', () => {
  const text = digestOf(V({ title: '标题', author: 'UP主甲', play: 1234, tname: '科技', desc: 'x'.repeat(500) }), {
    subtitle: '字幕内容',
    comments: Array.from({ length: 20 }, (_, i) => ({ name: `人${i}`, text: `评${i}` })),
  })
  assert.match(text, /《标题》 UP主：UP主甲  播放 1234  分区：科技  BV1xx411c7mD/)
  assert.match(text, /简介：x{300}(?!x)/)
  assert.doesNotMatch(text, /x{301}/, '简介只留 300 字')
  assert.match(text, /字幕（节选）：字幕内容/)
  assert.equal((text.match(/评\d+/g) || []).length, 8, '热评只带 8 条')
})

test('digestOf：没字幕时说明「只能看标题 / 评论」，有画面描述时改口', () => {
  assert.match(digestOf(V()), /只能看标题、简介和评论/)
  assert.match(digestOf(V(), { vision: '画面描述' }), /只看了画面/)
  assert.match(digestOf(V(), { vision: '画面描述' }), /画面（抽帧）：画面描述/)
})

// ── pickJson ─────────────────────────────────────────────────────────────

test('pickJson：从带前后缀的输出里捞 JSON，捞不到给 fallback', () => {
  assert.deepEqual(pickJson('前面 [{"a":1}] 后面', null), [{ a: 1 }])
  assert.deepEqual(pickJson('思考… {"b":2} …', null), { b: 2 })
  assert.deepEqual(pickJson('没有 json', 'fb'), 'fb')
  assert.deepEqual(pickJson('{坏掉的', 'fb'), 'fb')
  assert.deepEqual(pickJson(null, 'fb'), 'fb')
})

// ── 评论查重 ─────────────────────────────────────────────────────────────

test('similarity：相同为 1，完全不同为 0，空串为 0', () => {
  assert.equal(similarity('这条视频讲了什么', '这条视频讲了什么'), 1)
  assert.equal(similarity('完全不一样的内容', '另一句话'), 0)
  assert.equal(similarity('', '有内容'), 0)
})

test('checkCommentStyle：开头套话直接拦下，并给改法', () => {
  for (const lead of ['这条我认', '值得一看', '不得不说', '学到了', '强烈推荐']) {
    const r = checkCommentStyle(`${lead}，视频不错`)
    assert.equal(r.ok, false, lead)
    assert.match(r.reason, /套话/)
    assert.ok(r.hint, '要给模型一条改法')
  }
})

test('checkCommentStyle：跟自己以前发过的太像要拦（治「每条一个味」）', () => {
  const old = '这个UP主把平衡树讲得像在叠积木'
  const r = checkCommentStyle(old, { history: [old] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /以前发过/)
})

test('checkCommentStyle：跟现有热评撞车要拦', () => {
  const peer = '他把红黑树讲成了街边小摊'
  const r = checkCommentStyle(peer, { peers: [peer] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /已经有一句很像的/)
})

test('checkCommentStyle：空评论 / 够具体的评论', () => {
  assert.equal(checkCommentStyle('').ok, false)
  assert.equal(checkCommentStyle('   ').ok, false)
  assert.equal(checkCommentStyle('第 3 分钟那个把 12 个节点逐层拆开的动画，看完终于懂左旋右旋了').ok, true)
})

test('checkCommentStyle：阈值可以调松（不同视频下允许更像一点）', () => {
  const a = '这个转场用了三次同样的运镜'
  const b = '这个转场用了四次一样的运镜'
  assert.equal(checkCommentStyle(a, { peers: [b] }).ok, false)
  assert.equal(checkCommentStyle(a, { peers: [b], peerThreshold: 0.99 }).ok, true)
})

// ── 点赞 / 收藏记账 ──────────────────────────────────────────────────────

test('appendLikeEvent / currentLike：当前状态取最后一条（赞了又撤 = 撤）', () => {
  appendLikeEvent({ ts: 1, day: '2026-11-01', kind: 'like', bvid: BV, like: true, reason: '讲得很清楚' })
  assert.deepEqual(currentLike('like', BV), { like: true, ts: 1, reason: '讲得很清楚' })
  appendLikeEvent({ ts: 2, day: '2026-11-01', kind: 'like', bvid: BV, like: false })
  assert.equal(currentLike('like', BV).like, false)
  assert.equal(currentLike('fav', BV), null)
})

test('readLikeEvents：坏行 / 非法 BV / 非法 kind 都跳过', () => {
  const p = process.env.AURABOT_DATA_DIR
  appendLikeEvent({ ts: 1, day: 'd', kind: 'like', bvid: BV, like: true })
  const events = readLikeEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].bvid, BV)
  assert.ok(p)
})

test('countToday：只数当天真的点出去的（like:true），撤销不返还额度', () => {
  const day = '2026-11-02'
  appendLikeEvent({ ts: 10, day, kind: 'like', bvid: 'BV1aa411c7m1', like: true })
  appendLikeEvent({ ts: 20, day, kind: 'like', bvid: 'BV1bb411c7m2', like: true })
  appendLikeEvent({ ts: 30, day, kind: 'like', bvid: 'BV1bb411c7m2', like: false })
  assert.equal(countToday('like', day), 2, '撤销也算用掉了一次')
  assert.equal(countToday('fav', day), 0)
  assert.equal(countToday('like', '2026-11-03'), 0)
  assert.equal(countToday('like', day, 15), 1, 'sinceTs 之后的才数')
})

test('listLikesForUi：每个视频一条、最近的在前、撤销的标 undone', () => {
  appendLikeEvent({ ts: 10, day: 'd1', kind: 'like', bvid: 'BV1aa411c7m1', like: true, title: '甲', owner: 'U1', reason: '理由一' })
  appendLikeEvent({ ts: 20, day: 'd1', kind: 'fav', bvid: 'BV1bb411c7m2', like: true, title: '乙', owner: 'U2' })
  appendLikeEvent({ ts: 30, day: 'd1', kind: 'like', bvid: 'BV1aa411c7m1', like: false })
  const ui = listLikesForUi()
  assert.equal(ui.like.length, 1)
  assert.equal(ui.like[0].undone, true)
  assert.equal(ui.fav.length, 1)
  assert.equal(ui.fav[0].title, '乙')
})

test('复核台账：rememberVerify 只留最近 200 条；judgeVerify 区分可见 / 进审核 / 没查到', () => {
  for (let i = 0; i < 205; i++) rememberVerify({ bvid: BV, visible: true })
  assert.equal(readVerify().length, 200)

  assert.deepEqual(judgeVerify(null), { level: 'unknown', text: '没复核' })
  assert.equal(judgeVerify({ visible: true }).level, 'ok')
  assert.equal(judgeVerify({ visible: false, state: 1 }).level, 'hidden')
  assert.match(judgeVerify({ visible: false, state: 1 }).text, /state=1/)
  // 没查到 ≠ 没发出去：措辞要留有余地
  const unknown = judgeVerify({ note: '翻页没翻到' })
  assert.equal(unknown.level, 'unknown')
  assert.match(unknown.text, /翻页没翻到/)
})

// ── 历史 / 日记 / 日报 ───────────────────────────────────────────────────

test('isBvid / dayOf：基本格式', () => {
  assert.equal(isBvid(BV), true)
  assert.equal(isBvid('BV123'), false)
  assert.equal(isBvid(null), false)
  assert.match(dayOf(new Date(2026, 10, 9, 13, 0, 0).getTime()), /^2026-11-09$/)
})

test('appendHistory / readHistory：按天留记录，坏行跳过，非 BV 号的条目不写', () => {
  assert.equal(appendHistory({ bvid: 'not-a-bv', title: 'x' }), null)
  const e = appendHistory({ bvid: BV, title: '标题甲', pick: 'pick', reason: '想看看' })
  assert.equal(e.bvid, BV)
  assert.equal(readHistory().length, 1)
  assert.equal(readHistory()[0].title, '标题甲')
})

test('groupByDay：按天分组，天的顺序和天内的顺序都稳定', () => {
  const entries = [
    { ts: 1, day: '2026-11-01', bvid: 'BV1aa411c7m1' },
    { ts: 3, day: '2026-11-02', bvid: 'BV1bb411c7m2' },
    { ts: 2, day: '2026-11-01', bvid: 'BV1cc411c7m3' },
  ]
  const grouped = groupByDay(entries)
  assert.ok(grouped)
  assert.equal(grouped.length, 2)
})

test('日记：写一天一篇、读得回来、hasDiaryToday 认当天', () => {
  assert.equal(hasDiaryToday(), false)
  const e = writeDiary({ text: '今天在 B 站看了三个讲树的视频' })
  assert.equal(e.day, dayOf())
  assert.equal(hasDiaryToday(), true)
  const list = readDiary()
  assert.equal(list.length, 1)
  assert.match(list[0].text, /三个讲树的视频/)
  // 空正文不写
  assert.equal(writeDiary({ text: '   ' }), null)
  assert.equal(readDiary().length, 1)
  // 别的日子查不到
  assert.equal(hasDiaryToday('2020-01-01'), false)
})

test('日报：渲染、保存、按天读回；没写过的天读不到', () => {
  const md = renderReport({
    day: '2026-11-09',
    entries: [
      { title: '标题甲', bvid: BV, pick: 'pick', reason: '想看看', owner: 'UP甲' },
      { title: '标题乙', bvid: 'BV1bb411c7m2', pick: 'skip', reason: '标题党' },
    ],
    diary: { text: '今天看树的视频看很久' },
    stats: { comments: 2 },
  })
  assert.match(md, /B 站日报 · 2026-11-09/)
  assert.match(md, /看了 2 个，挑中 1 个/)
  assert.match(md, /发了 2 条评论/)
  assert.match(md, /### 标题甲/)
  assert.match(md, /为什么：想看看/)
  assert.match(md, /## 看过但跳过/)
  assert.match(md, /标题乙 — 标题党/)
  assert.match(md, /## 今天想说的/)
  saveReport('2026-11-09', md)
  assert.equal(readReport('2026-11-09'), md)
  assert.equal(readReport('2026-01-01'), '')
  assert.ok(reportDays().includes('2026-11-09'))
})

test('日报：空的一天也能渲染（不报错、说明看了 0 个）', () => {
  const md = renderReport({ day: '2026-11-10' })
  assert.match(md, /看了 0 个，挑中 0 个/)
})

// ── 入口：setup 的接线（假 api，不联网） ────────────────────────────────

function makeEnv({ enabled = true, danmakuEnabled = false, owner = '10000', level = 'full', allOwner = true } = {}) {
  const cfg = {
    ownerQQ: owner,
    ownerName: '老大',
    dryRun: true,
    bili: {
      enabled, danmakuEnabled, like: false, fav: false, cookie: '',
      ownerMid: '', shotLibrary: 20, dmEnabled: false, reply: true,
      maxRepliesPerDay: 5, throttledMs: 0, perRun: 3, minViews: 0, maxAgeDays: 0,
      ...{}, 
    },
    profilePerms: {},
  }
  const routes = new Map()
  const tools = []
  const timers = []
  const events = []
  const api = {
    id: 'bili',
    dir: MOD_DIR,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: () => cfg,
    dsh: {},
    dataDir: (...p) => join(process.env.AURABOT_DATA_DIR, p.length ? p[0] : '.'),
    every: (ms, fn, name) => { timers.push({ ms, fn, name }); return () => {} },
    on: (ev, fn) => { events.push({ ev, fn }) },
    onDispose: () => {},
    later: () => {},
    use: () => null,
    has: () => false,
    lazy: () => null,
    saveSettings: (patch) => ({ ...cfg, ...patch }),
    route: (path, fn) => routes.set(path, fn),
    tool: (factory) => {
      const out = factory({ chat: { kind: 'private', chatId: 'private:' + owner, userId: owner }, level, sessionId: 's1' })
      if (Array.isArray(out)) tools.push(...out)
      else if (out) tools.push(out)
    },
    core: {
      hub: { turnSendersAllOwner: () => allOwner, chatOfSession: () => 'private:' + owner },
      http: {
        query: (req) => req?.query || {},
        body: async (req) => req?.body || {},
        send: (res, code, body, type) => { res.statusCode = code; res.body = body; res.type = type },
      },
    },
  }
  const bili = mod.setup(api)
  return { api, cfg, routes, tools, timers, events, bili, tool: (n) => tools.find((t) => t.name === n) }
}

test('setup：注册两个定时器（刷视频 / 私信各一条），私信不跟刷视频抢时间', () => {
  const { timers } = makeEnv()
  assert.equal(timers.length, 2)
  assert.deepEqual(timers.map((t) => t.name).sort(), ['B站私信', '刷B站'])
  assert.ok(timers.every((t) => t.ms === 60_000))
})

test('setup：B站关掉就不挂工具（看视频 / 评论都不挂）', () => {
  const { tools } = makeEnv({ enabled: false })
  assert.equal(tools.length, 0)
})

test('setup：开着的时候挂看视频 + 评论 + 截图 + 改资料工具；弹幕默认不挂', () => {
  const { tools } = makeEnv()
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['bili_comment', 'bili_set_avatar', 'bili_set_sign', 'bili_watch', 'qq_list_shots', 'qq_send_shot'])
  assert.equal(tools.find((t) => t.name === 'bili_danmaku'), undefined, '弹幕默认没开')
})

test('setup：开了弹幕也只给主人私聊挂', () => {
  const asOwner = makeEnv({ danmakuEnabled: true })
  assert.ok(asOwner.tool('bili_danmaku'), '主人私聊应该有')
  const asSocial = makeEnv({ danmakuEnabled: true, level: 'social' })
  assert.equal(asSocial.tool('bili_danmaku'), undefined, '非主人没有')
})

test('bili_comment：面板里关掉就拒；别人在场时「仅主人」档也拒', async () => {
  const off = makeEnv()
  off.cfg.profilePerms.biliComment = 'off'
  const r1 = await off.tool('bili_comment').execute({ link: BV, text: '说点什么' }, {})
  assert.equal(r1.ok, false)
  assert.match(r1.message, /关掉了/)

  const notOwner = makeEnv({ allOwner: false })
  const r2 = await notOwner.tool('bili_comment').execute({ link: BV, text: '说点什么' }, {})
  assert.equal(r2.ok, false)
  assert.match(r2.message, /只有主人/)
})

test('qq_send_shot / qq_list_shots：截图只给主人看', async () => {
  const { tool } = makeEnv({ allOwner: false })
  for (const name of ['qq_send_shot', 'qq_list_shots']) {
    const r = await tool(name).execute({}, {})
    assert.equal(r.ok, false)
    assert.match(r.message, /只给主人看/)
  }
})

test('面板路由齐全（B 站面板要挨个调）', () => {
  const { routes } = makeEnv()
  for (const path of ['/bili/state', '/bili/account', '/bili/run', '/bili/replies', '/bili/shots', '/bili/history', '/bili/report', '/bili/likes', '/bili/dm/state', '/bili/at/state', '/bili/danmaku/state']) {
    assert.ok(routes.has(path), '缺路由 ' + path)
  }
})

test('/bili/dm/relation：没填主人 mid 时给明确提示，不去打接口', async () => {
  const { routes } = makeEnv()
  const r = await routes.get('/bili/dm/relation')({ query: {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /还没填主人的 B 站 mid/)
})

test('/bili/report：没日报时 ok=false，不抛错', async () => {
  const { routes } = makeEnv()
  const r = await routes.get('/bili/report')({ query: { day: '2026-01-01' } })
  assert.equal(r.ok, false)
  assert.match(r.message, /还没有日报/)
})

test('/bili/danmaku/inspect：不是从面板发起的请求会被拒（防外部 CSRF）', async () => {
  const { routes } = makeEnv()
  const r = await routes.get('/bili/danmaku/inspect')({ query: {}, headers: {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /面板/)
})

test('setup 返回的对象是宿主用的那套接口', () => {
  const { bili } = makeEnv()
  for (const fn of ['tick', 'dmTick', 'state', 'account', 'watch', 'comment', 'checkReplies', 'sendShot', 'listShots', 'historyView']) {
    assert.equal(typeof bili[fn], 'function', `缺 ${fn}`)
  }
})

test('state()：默认形状（没跑过也不能炸）', () => {
  const { bili } = makeEnv()
  const s = bili.state()
  assert.equal(typeof s, 'object')
  assert.ok('runs' in s || 'lastRun' in s)
})
