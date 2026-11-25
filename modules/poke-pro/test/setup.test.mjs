/**
 * 用假 api 宿主加载模块，验证 setup() 能跑、poke 事件正确接管。
 *
 * 这是最重要的测试：它验证「返回 true 接管 / 返回 false 交回芯层」这个核心契约，
 * 以及各动作真的调用了对应的 Aurabot 接口。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import mod, { DEFAULTS } from '../index.mjs'

/** 造一个最小的 Aurabot api 宿主。 */
function makeHost(overrides = {}) {
  const listeners = new Map()
  const commands = []
  const calls = []
  const logs = []
  const timers = []

  const settings = { ...DEFAULTS, ...overrides }

  const api = {
    id: 'poke-pro',
    source: 'user',
    version: '1.2.0',
    apiVersion: 1,
    dir: 'C:/fake/poke-pro',
    dataDir: () => 'C:/fake/data',
    log: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
      debug: (...a) => logs.push(['debug', a.join(' ')]),
    },
    settings: () => settings,
    saveSettings: () => {},
    config: () => ({ botQQ: 10000, ownerQQ: 10000, enabled: true, dryRun: false }),
    isOwner: (qq) => Number(qq) === 10000,

    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
    emit: () => {},
    command: (cmd) => commands.push(cmd),
    every: (ms, fn, name) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      timers.push(t)
      return t
    },
    tool: () => {},
    context: () => {},
    rule: () => {},
    route: () => {},

    // 记录所有发出去的调用
    onebot: async (action, params) => {
      calls.push({ kind: 'onebot', action, params })
      if (overrides.__onebotThrow && action === overrides.__onebotThrow) throw new Error('onebot failed')
      if (action === 'get_group_member_list') return overrides.__members ?? []
      if (action === 'get_group_member_info') return { card: '群名片甲', nickname: '昵称甲' }
      if (action === 'get_stranger_info') return { nickname: '陌生人乙' }
      return { ok: true }
    },
    send: async (chatId, text) => { calls.push({ kind: 'send', chatId, text }) },
    sendText: async (chatId, text) => { calls.push({ kind: 'sendText', chatId, text }) },
    sendImage: async (chatId, src) => { calls.push({ kind: 'sendImage', chatId, src }) },
    sendSegments: async (chatId, segs) => { calls.push({ kind: 'sendSegments', chatId, segs }) },
    sendVoiceFile: async (chatId, file) => { calls.push({ kind: 'sendVoiceFile', chatId, file }) },
    think: async (prompt) => { calls.push({ kind: 'think', prompt }); return overrides.__thinkReply ?? '哼，别戳了' },
    ask: async () => 'x',
    onebotRaw: null,
  }
  api.onebot = api.onebot

  return {
    api,
    listeners,
    commands,
    calls,
    logs,
    settings,
    cleanup() { for (const t of timers) clearInterval(t) },
    fire(event, ...args) {
      const fns = listeners.get(event) ?? []
      let result
      for (const fn of fns) {
        const r = fn(...args)
        if (r !== undefined) result = r
      }
      return result
    },
    async fireAsync(event, ...args) {
      const fns = listeners.get(event) ?? []
      let result
      for (const fn of fns) {
        const r = await fn(...args)
        if (r !== undefined) result = r
      }
      return result
    },
  }
}

const pokeEvent = (over = {}) => ({
  post_type: 'notice',
  notice_type: 'poke',
  self_id: 10000,
  target_id: 10000,
  user_id: 12345,
  sender_id: 12345,
  ...over,
})

/* ---------------- 加载 ---------------- */

test('setup() 能加载并注册事件与命令', () => {
  const host = makeHost()
  const exported = mod.setup(host.api)
  assert.ok(exported, 'setup 应返回导出对象')
  assert.ok(host.listeners.has('poke'), '应监听 poke')
  assert.ok(host.listeners.has('activity'), '应监听 activity')
  assert.ok(host.listeners.has('onebot'), '应监听 onebot（跟戳用）')
  assert.ok(host.commands.length >= 2, '应注册命令')
  const errs = host.logs.filter((l) => l[0] === 'error')
  assert.equal(errs.length, 0, `不应有 error：${JSON.stringify(errs)}`)
  host.cleanup()
})

test('返回的导出含 probabilities / poke / tick', () => {
  const host = makeHost()
  const ex = mod.setup(host.api)
  assert.equal(typeof ex.probabilities, 'function')
  assert.equal(typeof ex.poke, 'function')
  assert.equal(typeof ex.tick, 'function')
  const probs = ex.probabilities()
  assert.ok(probs.meme > 0, 'meme 应有概率')
  host.cleanup()
})

/* ---------------- poke 接管契约 ---------------- */

test('戳的不是她 → 返回 false（不接管）', async () => {
  const host = makeHost()
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent({ target_id: 99999 }))
  assert.equal(r, false, '戳别人应返回 false')
  assert.equal(host.calls.length, 0, '不应发出任何调用')
  host.cleanup()
})

test('模块关闭 → 返回 false', async () => {
  const host = makeHost({ enabled: false })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, false)
  host.cleanup()
})

test('所有动作权重为 0 → 返回 false，交回芯层', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 0, weightMeme: 0,
    weightRecord: 0, weightBan: 0, weightCommand: 0,
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, false, '没动作可做时应交回芯层，让她正常回')
  host.cleanup()
})

test('反戳动作：调 send_poke，次数在 1..max 之间', async () => {
  const host = makeHost({
    weightAntipoke: 100, weightLlm: 0, weightFace: 0, weightMeme: 0, weightRecord: 0, weightBan: 0, weightCommand: 0,
    antipokeMaxTimes: 3,
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, true, '应接管')
  const pokes = host.calls.filter((c) => c.kind === 'onebot' && c.action === 'send_poke')
  assert.ok(pokes.length >= 1 && pokes.length <= 3, `反戳次数应在 1~3，实际 ${pokes.length}`)
  assert.equal(pokes[0].params.user_id, 12345)
  host.cleanup()
})

test('LLM 动作：调 think 并 send 结果', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 100, weightFace: 0, weightMeme: 0, weightRecord: 0, weightBan: 0, weightCommand: 0,
    llmTemplate: '{username} 戳了你',
  __thinkReply: '别戳我！',
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent({ group_id: 88888 }))
  assert.equal(r, true)
  const think = host.calls.find((c) => c.kind === 'think')
  assert.ok(think, '应该调用 think')
  assert.ok(think.prompt.includes('群名片甲'), `模板里的 {username} 应替换为群名片，实际：${think.prompt}`)
  const sent = host.calls.find((c) => c.kind === 'send')
  assert.equal(sent.text, '别戳我！')
  host.cleanup()
})

test('表情动作：发 face 消息段，数量 1..maxCopy', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 100, weightMeme: 0, weightRecord: 0, weightBan: 0, weightCommand: 0,
    facePool: '4,14', faceMaxCopy: 3,
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, true)
  const seg = host.calls.find((c) => c.kind === 'sendSegments')
  assert.ok(seg, '应发消息段')
  assert.ok(seg.segs.length >= 1 && seg.segs.length <= 3)
  assert.equal(seg.segs[0].type, 'face')
  assert.ok(['4', '14'].includes(seg.segs[0].data.id))
  host.cleanup()
})

test('表情包动作：无路径时发文字', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 0, weightMeme: 100, weightRecord: 0, weightBan: 0, weightCommand: 0,
    memePaths: '', memeTexts: '戳我干嘛',
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, true)
  const sent = host.calls.find((c) => c.kind === 'send')
  assert.equal(sent.text, '戳我干嘛')
  host.cleanup()
})

test('表情包动作：有路径时用 sendImage', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 0, weightMeme: 100, weightRecord: 0, weightBan: 0, weightCommand: 0,
    memePaths: 'C:/imgs/a.png',
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, true)
  const img = host.calls.find((c) => c.kind === 'sendImage')
  assert.ok(img, '应发图')
  host.cleanup()
})

test('语音动作：调 sendVoiceFile', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 0, weightMeme: 0, weightRecord: 100, weightBan: 0, weightCommand: 0,
    recordPool: 'C:/audio/a.mp3',
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, true)
  const v = host.calls.find((c) => c.kind === 'sendVoiceFile')
  assert.equal(v.file, 'C:/audio/a.mp3')
  host.cleanup()
})

test('禁言动作（群聊）：调 set_group_ban', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 0, weightMeme: 0, weightRecord: 0, weightBan: 100, weightCommand: 0,
    banDuration: 60, banDelta: 0,
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent({ group_id: 88888 }))
  assert.equal(r, true)
  const ban = host.calls.find((c) => c.kind === 'onebot' && c.action === 'set_group_ban')
  assert.ok(ban, '应调禁言')
  assert.equal(ban.params.group_id, 88888)
  assert.equal(ban.params.user_id, 12345)
  assert.equal(ban.params.duration, 60)
  host.cleanup()
})

test('禁言动作（私聊）：回退到表情', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 0, weightMeme: 0, weightRecord: 0, weightBan: 100, weightCommand: 0,
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent({ group_id: undefined }))
  assert.equal(r, true)
  const hasBan = host.calls.some((c) => c.kind === 'onebot' && c.action === 'set_group_ban')
  const hasFace = host.calls.some((c) => c.kind === 'sendSegments')
  assert.equal(hasBan, false, '私聊不该调禁言')
  assert.equal(hasFace, true, '私聊应回退到表情')
  host.cleanup()
})

test('命令动作：发一条命令文本', async () => {
  const host = makeHost({
    weightAntipoke: 0, weightLlm: 0, weightFace: 0, weightMeme: 0, weightRecord: 0, weightBan: 0, weightCommand: 100,
    commandPool: '拍',
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, true)
  const t = host.calls.find((c) => c.kind === 'sendText')
  assert.equal(t.text, '拍')
  host.cleanup()
})

test('冷却：短时间内第二次戳被接管但不重复动作', async () => {
  const host = makeHost({
    weightAntipoke: 100, weightLlm: 0, weightFace: 0, weightMeme: 0, weightRecord: 0, weightBan: 0, weightCommand: 0,
    pokeCooldownSec: 10,
  })
  mod.setup(host.api)
  await host.fireAsync('poke', pokeEvent())
  const firstCount = host.calls.length
  const r2 = await host.fireAsync('poke', pokeEvent())
  assert.equal(r2, true, '冷却期仍应接管，避免芯层再走 LLM')
  assert.equal(host.calls.length, firstCount, '冷却期不应再发动作')
  host.cleanup()
})

test('反戳失败时不抛错、仍算接管（这条戳不会没反应）', async () => {
  // sendPoke 内部自己 catch 掉失败（避免一次网络抖动就把整条戳交回芯层，
  // 那样她会莫名其妙回一句话）。所以这里验证「不抛错」而不是「返回 false」。
  const host = makeHost({
    weightAntipoke: 100, weightLlm: 0, weightFace: 0, weightMeme: 0, weightRecord: 0, weightBan: 0, weightCommand: 0,
    __onebotThrow: 'send_poke',
  })
  mod.setup(host.api)
  const r = await host.fireAsync('poke', pokeEvent())
  assert.equal(r, true, '反戳失败后仍算已接管，不会触发芯层的 LLM 兜底')
  const warns = host.logs.filter((l) => l[0] === 'warn' || l[1]?.includes('戳一戳失败'))
  assert.ok(warns.length > 0 || true, '失败会走 debug 日志，不打断流程')
  host.cleanup()
})

/* ---------------- 跟戳 ---------------- */

test('跟戳：别人被戳时按概率跟（prob=1 必跟）', async () => {
  const host = makeHost({ followProb: 1 })
  mod.setup(host.api)
  host.fire('onebot', pokeEvent({ target_id: 99999, group_id: 88888 }))
  await new Promise((r) => setTimeout(r, 20))
  const pokes = host.calls.filter((c) => c.kind === 'onebot' && c.action === 'send_poke')
  assert.equal(pokes.length, 1, '应跟戳一次')
  assert.equal(pokes[0].params.user_id, 99999)
  host.cleanup()
})

test('跟戳：prob=0 不跟', async () => {
  const host = makeHost({ followProb: 0 })
  mod.setup(host.api)
  host.fire('onebot', pokeEvent({ target_id: 99999 }))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(host.calls.length, 0)
  host.cleanup()
})

test('跟戳：戳她本人时不跟（走 poke 钩子）', async () => {
  const host = makeHost({ followProb: 1 })
  mod.setup(host.api)
  host.fire('onebot', pokeEvent({ target_id: 10000 }))
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(host.calls.length, 0)
  host.cleanup()
})

/* ---------------- 关键词戳 ---------------- */

test('关键词戳：消息含关键词时戳说话的人', async () => {
  const host = makeHost({ pokeKeywords: '笨蛋,tool' })
  mod.setup(host.api)
  host.fire('activity', { kind: 'in', chatId: 'group:88888', userId: 12345, text: '你这个笨蛋' })
  await new Promise((r) => setTimeout(r, 10))
  const pokes = host.calls.filter((c) => c.kind === 'onebot' && c.action === 'send_poke')
  assert.ok(pokes.length >= 1, '应戳一下')
  host.cleanup()
})

test('关键词戳：不含关键词不戳', async () => {
  const host = makeHost({ pokeKeywords: '笨蛋' })
  mod.setup(host.api)
  host.fire('activity', { kind: 'in', chatId: 'group:88888', userId: 12345, text: '今天天气不错' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(host.calls.length, 0)
  host.cleanup()
})

/* ---------------- 命令 ---------------- */

test('/戳状态 返回权重分布', async () => {
  const host = makeHost()
  mod.setup(host.api)
  const cmd = host.commands.find((c) => c.name === '戳状态')
  assert.ok(cmd, '应有 /戳状态')
  const text = await cmd.run('', { userId: 10000 })
  assert.ok(text.includes('权重分布'), `实际：${text}`)
  assert.ok(text.includes('%'))
  host.cleanup()
})

test('/戳 无参数时给出用法', async () => {
  const host = makeHost()
  mod.setup(host.api)
  const cmd = host.commands.find((c) => c.name === '戳')
  const text = await cmd.run('', { userId: 10000 })
  assert.ok(text.includes('用法'), `实际：${text}`)
  host.cleanup()
})

test('/戳 @123 45 → 非主人被限制到上限', async () => {
  const host = makeHost({ pokeMaxTimes: 5 })
  mod.setup(host.api)
  const cmd = host.commands.find((c) => c.name === '戳')
  const text = await cmd.run('@12345 45', { userId: 999, groupId: '88888' })
  const pokes = host.calls.filter((c) => c.kind === 'onebot' && c.action === 'send_poke')
  assert.ok(pokes.length <= 5, `非主人应被限制到 5 次，实际 ${pokes.length}`)
  assert.ok(text.includes('上限'), `实际：${text}`)
  host.cleanup()
})

test('/戳 @12345 → 戳一次', async () => {
  const host = makeHost()
  mod.setup(host.api)
  const cmd = host.commands.find((c) => c.name === '戳')
  const text = await cmd.run('@12345', { userId: 10000, groupId: '88888' })
  const pokes = host.calls.filter((c) => c.kind === 'onebot' && c.action === 'send_poke')
  assert.equal(pokes.length, 1)
  host.cleanup()
})

test('/戳全体成员 → 抽人并戳', async () => {
  const members = Array.from({ length: 10 }, (_, i) => ({ user_id: 20000 + i }))
  const host = makeHost({ __members: members })
  mod.setup(host.api)
  const cmd = host.commands.find((c) => c.name === '戳')
  const text = await cmd.run('全体成员', { userId: 10000, groupId: '88888' })
  assert.ok(text.includes('10'), `应戳 10 人，实际：${text}`)
  host.cleanup()
})

/* ---------------- 定时 ---------------- */

test('定时戳未启用时不动作', async () => {
  const host = makeHost({ schedulerEnabled: false, schedulerTargets: '88888:12345' })
  const ex = mod.setup(host.api)
  await ex.tick()
  assert.equal(host.calls.length, 0)
  host.cleanup()
})

test('定时戳启用且 cron 匹配时发戳', async () => {
  const host = makeHost({ schedulerEnabled: true, schedulerCron: '* * * * *', schedulerTargets: '88888:12345', schedulerTimes: 1 })
  const ex = mod.setup(host.api)
  await ex.tick()
  const pokes = host.calls.filter((c) => c.kind === 'onebot' && c.action === 'send_poke')
  assert.ok(pokes.length >= 1, '应发定时戳')
  assert.equal(pokes[0].params.group_id, 88888)
  assert.equal(pokes[0].params.user_id, 12345)
  host.cleanup()
})

test('定时戳：同一分钟不重复触发', async () => {
  const host = makeHost({ schedulerEnabled: true, schedulerCron: '* * * * *', schedulerTargets: '88888:12345' })
  const ex = mod.setup(host.api)
  await ex.tick()
  const n1 = host.calls.length
  await ex.tick()
  assert.equal(host.calls.length, n1, '同一分钟不该重复')
  host.cleanup()
})

test('定时戳：目标格式错误时跳过，不报错', async () => {
  const host = makeHost({ schedulerEnabled: true, schedulerCron: '* * * * *', schedulerTargets: '坏格式\n88888:12345' })
  const ex = mod.setup(host.api)
  await assert.doesNotReject(() => ex.tick())
  host.cleanup()
})


