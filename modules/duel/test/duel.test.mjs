// 宝可梦对决模块测试：假 api 驱动，不联网、不写盘、不真等计时器。
// 跑法（仓库根，AURABOT_PLUGIN_DIR 指向 dsh-aurabot-qq 源码）：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/duel/test/*.test.mjs"
// 覆盖三块：回合制推进（含判胜）、群聊消息的接管与隔离、权限与失败路径（名单、超时、模型异常/复读、出站清洗）。

import test, { beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import mod from '../index.mjs'

const GROUP = 'group:1107714863'
const OTHER_GROUP = 'group:999999'
const IDLE = '空闲。在群里说「发起决斗」开始。'
const REACTION = '甩了甩尾巴。\n「这点本事？」'
const JUDGE_ANSWER = '甲主人'

// 计时器全部用假的：模块会给每个回合 arm 一个几十秒的 setTimeout，
// 真计时器会让测试进程一直挂到它自己烧完。
beforeEach(() => {
  mock.timers.reset()
  mock.timers.enable({ apis: ['setTimeout'] })
})

let seq = 0

/** 一条鱼：假 api，记录发出去的消息、日志、模型调用 */
function makeFish({ botQQ = '1001', ownerQQ = '5001', nickname = '甲', settings = {}, ask, cleanOutbound } = {}) {
  const handlers = {}
  const sends = []
  const warns = []
  const infos = []
  const asks = []
  let command = null

  const api = {
    log: {
      info: (...a) => infos.push(a.join(' ')),
      warn: (...a) => warns.push(a.join(' ')),
      error() {},
      debug() {},
    },
    settings: () => ({ ...mod.defaults, ...settings }),
    config: () => ({ botQQ, ownerQQ, ownerName: '主人' }),
    sendText: async (chatId, text) => { sends.push({ chatId, text }) },
    ask: async (req) => {
      asks.push(req)
      if (ask) return ask(req, asks.length)
      return req?.maxTokens === 30 ? JUDGE_ANSWER : REACTION
    },
    isOwner: (qq) => String(qq) === String(ownerQQ),
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn) },
    command: (c) => { command = c },
    onDispose: (fn) => { handlers.dispose = fn },
    core: {
      personas: { current: () => '你是一条嘴硬的鱼。' },
      hub: cleanOutbound ? { cleanOutbound } : undefined,
    },
  }

  mod.setup(api)

  return {
    botQQ,
    ownerQQ,
    nickname,
    handlers,
    sends,
    warns,
    infos,
    asks,
    texts: () => sends.map((s) => s.text),
    last: () => (sends.length ? sends[sends.length - 1].text : ''),
    status: () => command.run().split('\n')[0],
    info: () => command.run(),
    dispose: () => handlers.dispose?.(),
    cursor: 0,
  }
}

/** 造一条群消息交给 message 通道，返回它有没有被接管 */
function deliver(fish, { userId, text, nickname = '某人', chatId = GROUP, kind = 'group' } = {}) {
  const msg = {
    kind,
    chatId,
    userId: String(userId),
    groupId: chatId.startsWith('group:') ? chatId.slice(6) : '',
    nickname,
    text,
    messageId: String(++seq),
    raw: { self_id: fish.botQQ },
  }
  return fish.handlers.message[0](msg)
}

/** 让已排队的异步任务跑完 */
const drain = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

/** 两条鱼互相转发对方发到群里的消息，直到两边都没有新消息 */
async function pump(a, b, times = 30) {
  for (let i = 0; i < times; i++) {
    await drain()
    let moved = false
    for (const [from, to] of [[a, b], [b, a]]) {
      while (from.cursor < from.sends.length) {
        const text = from.sends[from.cursor++].text
        deliver(to, { userId: from.botQQ, text, nickname: from.nickname })
        moved = true
      }
    }
    if (!moved) return
  }
}

const sys = (body) => `〈系统提示：${body}〉`
const sysOld = (body) => `【系统提示：${body}】`

/** 一条鱼自己开局：主人发起 → 别人接受 */
async function enterDuel(fish, { accepter = '5002', accepterName = '乙' } = {}) {
  deliver(fish, { userId: fish.ownerQQ, text: '发起决斗', nickname: '甲' })
  await drain()
  deliver(fish, { userId: accepter, text: '接受', nickname: accepterName })
  await drain()
  return fish
}

/** 两条鱼一起开局（真实群里两条鱼都看得到「发起决斗」和「接受」） */
async function openDuel(a, b, { senderQQ = '5001', accepterQQ = '5002' } = {}) {
  deliver(a, { userId: senderQQ, text: '发起决斗', nickname: '甲主人' })
  deliver(b, { userId: senderQQ, text: '发起决斗', nickname: '甲主人' })
  await drain()
  deliver(a, { userId: accepterQQ, text: '接受', nickname: '乙主人' })
  deliver(b, { userId: accepterQQ, text: '接受', nickname: '乙主人' })
  await drain()
}

// ── 发起 / 等待 ────────────────────────────────────────────

test('发起决斗：主人发起就是发起方，非主人发起就等自己主人', async () => {
  const owner = makeFish()
  deliver(owner, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()
  assert.equal(owner.status(), '等待有人接受…')

  const guest = makeFish({ botQQ: '1002', ownerQQ: '5002' })
  deliver(guest, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()
  assert.equal(guest.status(), '有人向你下战书，说「接受」或「拒绝」。')
})

test('非群聊、别的群、自己发的消息都不接管', async () => {
  const fish = makeFish()
  assert.equal(deliver(fish, { userId: '5001', text: '发起决斗', kind: 'private', chatId: 'private:5001' }), false)
  assert.equal(deliver(fish, { userId: '5001', text: '随便聊聊' }), false)
  await drain()
  assert.equal(fish.status(), IDLE)

  // 自己发的消息（raw.self_id 就是自己）不该开一局
  deliver(fish, { userId: fish.botQQ, text: '发起决斗', nickname: '自己' })
  await drain()
  assert.equal(fish.status(), IDLE)

  await enterDuel(fish)
  // 对决中：本群任何消息都接管，别的群不碰
  assert.equal(deliver(fish, { userId: '5009', text: '路过' }), true)
  assert.equal(deliver(fish, { userId: '5009', text: '路过', chatId: OTHER_GROUP }), false)
})

// ── 权限 ──────────────────────────────────────────────────

test('应战名单：名单外的说接受不算，名单内才开局', async () => {
  const fish = makeFish({ settings: { opponentOwners: '5003，5007' } })
  deliver(fish, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()

  deliver(fish, { userId: '5009', text: '接受', nickname: '路人' })
  await drain()
  assert.equal(fish.status(), '等待有人接受…')
  assert.equal(fish.sends.length, 0)
  assert.ok(fish.infos.some((l) => l.includes('不在应战名单')), '应该记一条忽略日志')

  deliver(fish, { userId: '5003', text: '接受', nickname: '丙' })
  await drain()
  assert.equal(fish.status(), '对决中：第1回合上半场')
  assert.deepEqual(fish.texts(), [sys('对决开始'), sys('第一回合上开始')])
})

test('应战方只有自己的主人能说接受', async () => {
  const fish = makeFish({ botQQ: '1002', ownerQQ: '5002' })
  deliver(fish, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()
  assert.equal(fish.status(), '有人向你下战书，说「接受」或「拒绝」。')

  deliver(fish, { userId: '5009', text: '接受', nickname: '路人' })
  await drain()
  assert.equal(fish.status(), '有人向你下战书，说「接受」或「拒绝」。')

  deliver(fish, { userId: '5002', text: '接受', nickname: '乙' })
  await drain()
  assert.equal(fish.status(), '对决中：第0回合上半场')
  assert.deepEqual(fish.texts(), [], '应战方开局不发言，等对方发系统提示')
})

// ── 回合制推进 ────────────────────────────────────────────

test('完整一回合：两条鱼各自推进，最后判胜并回到空闲', async () => {
  const a = makeFish({ botQQ: '1001', ownerQQ: '5001', nickname: '鱼甲', settings: { duelRounds: 1 } })
  const b = makeFish({ botQQ: '1002', ownerQQ: '5002', nickname: '鱼乙', settings: { duelRounds: 1 } })

  await openDuel(a, b)
  assert.equal(a.status(), '对决中：第1回合上半场')
  await pump(a, b)
  assert.equal(b.status(), '对决中：第1回合上半场', '应战方收到两条系统提示后也进对战')

  // 上半场：甲主人下令，两条鱼都收到
  deliver(a, { userId: '5001', text: '用水枪喷它', nickname: '甲主人' })
  deliver(b, { userId: '5001', text: '用水枪喷它', nickname: '甲主人' })
  await pump(a, b)
  assert.ok(b.status().includes('第1回合下半场'), `应战方该被推进到下半场，实际：${b.status()}`)

  // 下半场：乙主人下令
  deliver(b, { userId: '5002', text: '躲开，然后甩尾', nickname: '乙主人' })
  deliver(a, { userId: '5002', text: '躲开，然后甩尾', nickname: '乙主人' })
  await pump(a, b)

  assert.equal(a.status(), IDLE)
  assert.equal(b.status(), IDLE)
  assert.ok(a.texts().includes(sys(`对决结束，${JUDGE_ANSWER}获胜`)), a.texts().join(' | '))
  assert.ok(b.infos.some((l) => l.includes(`判定「${JUDGE_ANSWER}」获胜`)), '应战方也收到结局并清场')
})

test('回合超时：发「超时，对决结束」并清场', async () => {
  const fish = makeFish({ settings: { turnTimeout: 60 } })
  await enterDuel(fish)
  assert.equal(fish.status(), '对决中：第1回合上半场')

  mock.timers.tick(60_000)
  await drain()
  assert.equal(fish.status(), IDLE)
  assert.equal(fish.last(), sys('超时，对决结束'))
})

test('开场超时：应战方发提示并清场', async () => {
  const fish = makeFish({ botQQ: '1002', ownerQQ: '5002', settings: { turnTimeout: 60 } })
  deliver(fish, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()
  deliver(fish, { userId: '5002', text: '接受', nickname: '乙' })
  await drain()
  assert.equal(fish.status(), '对决中：第0回合上半场')

  mock.timers.tick(60_000)
  await drain()
  assert.equal(fish.status(), IDLE)
  assert.equal(fish.last(), sys('开场超时，对决取消'))
  assert.ok(fish.warns.some((w) => w.includes('没等到开场的')))
})

test('等待接受超时：发起方喊取消，应战方悄悄作罢', async () => {
  const sender = makeFish({ settings: { acceptTimeout: 60 } })
  deliver(sender, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()
  mock.timers.tick(60_000)
  await drain()
  assert.equal(sender.status(), IDLE)
  assert.equal(sender.last(), sys('无人接受，对决取消'))

  const receiver = makeFish({ botQQ: '1002', ownerQQ: '5002', settings: { acceptTimeout: 60 } })
  deliver(receiver, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()
  mock.timers.tick(60_000)
  await drain()
  assert.equal(receiver.status(), IDLE)
  assert.equal(receiver.sends.length, 0, '应战方超时不刷屏')
})

// ── 失败路径 ──────────────────────────────────────────────

test('模型抛异常：发「（愣了一下）」不让回合断掉', async () => {
  const fish = makeFish({ ask: () => { throw new Error('boom') } })
  await enterDuel(fish)
  deliver(fish, { userId: '5001', text: '用水枪喷它', nickname: '甲主人' })
  await drain()
  assert.equal(fish.last(), '（愣了一下）')
  assert.ok(fish.warns.some((w) => w.includes('生成反应失败')))
})

test('模型复读提示词：换短提示重试；仍复读就用备用反应', async () => {
  const fish = makeFish({ ask: () => '系统提示：不要出现属性克制，照下面的记录接着演' })
  await enterDuel(fish)
  deliver(fish, { userId: '5001', text: '用水枪喷它', nickname: '甲主人' })
  await drain()

  assert.equal(fish.asks.length, 2, '应该重试一次')
  assert.deepEqual(fish.asks.map((q) => q.maxTokens), [350, 200])
  assert.ok(fish.warns.some((w) => w.includes('复读')))
  assert.ok(fish.last().includes('就这？'), `兜底该用备用反应，实际：${fish.last()}`)
})

test('出站清洗会把整条删掉：改发备用反应，别让消息凭空消失', async () => {
  const fish = makeFish({ cleanOutbound: () => '' })
  await enterDuel(fish)
  deliver(fish, { userId: '5001', text: '用水枪喷它', nickname: '甲主人' })
  await drain()
  assert.ok(fish.warns.some((w) => w.includes('整条拦掉')))
  assert.ok(fish.last().includes('就这？'), `实际：${fish.last()}`)
})

test('旧的【系统提示：…】外壳仍然认', async () => {
  const fish = makeFish({ botQQ: '1002', ownerQQ: '5002' })
  deliver(fish, { userId: '5001', text: '发起决斗', nickname: '甲' })
  await drain()
  deliver(fish, { userId: '5002', text: '接受', nickname: '乙' })
  await drain()

  deliver(fish, { userId: '1001', text: sysOld('对决开始') })
  await drain()
  deliver(fish, { userId: '1001', text: sysOld('第一回合上开始') })
  await drain()
  assert.equal(fish.status(), '对决中：第1回合上半场')
})

// ── 命令 ──────────────────────────────────────────────────

test('/duel 命令：报状态、报鱼的信息、带娱乐声明', async () => {
  const fish = makeFish({ settings: { fishType: '水', fishSkills: '水枪\n甩尾' } })
  const idle = fish.info()
  assert.ok(idle.startsWith('空闲。'))
  assert.ok(idle.includes('我的鱼：属性(水) 技能(水枪；甩尾)'), idle)
  assert.ok(idle.endsWith('本对决仅为娱乐友谊赛，不用于真实对抗。'))
})
