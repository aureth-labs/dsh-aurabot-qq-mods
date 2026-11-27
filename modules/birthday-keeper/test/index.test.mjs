import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod, { fromChatText, fromProfileText, parseTable, targetMinute } from '../index.mjs'

const OWNER = '10000001'
const BOT = '20000002'
const OTHER = '30000003'
const GROUP = '44444444'

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function makeEnv (settingsPatch = {}, opts = {}) {
  let settings = {}
  const dir = mkdtempSync(join(tmpdir(), 'birthday-keeper-'))
  const sent = []
  const replies = []
  const calls = []
  const listeners = new Map()
  let tickFn = null

  const api = {
    settings: () => settings,
    saveSettings: (update) => { settings = { ...settings, ...update } },
    dataDir: (name) => join(dir, name || ''),
    config: () => ({ ownerQQ: OWNER, botQQ: BOT }),
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    every: (_ms, fn) => { tickFn = fn },
    onebot: async (action, params) => {
      calls.push({ action, params })
      if (action === 'get_group_member_info') {
        if (opts.member === false) throw new Error('not in group')
        return { user_id: params.user_id, nickname: '成员' }
      }
      if (action === 'get_stranger_info') {
        if (opts.strangerSign === undefined) return { user_id: params.user_id, sign: '' }
        return { user_id: params.user_id, sign: opts.strangerSign, age: 18 }
      }
      return {}
    },
    sendText: async (chatId, text) => {
      sent.push({ chatId, text })
      return opts.sendOk !== false
    },
    reply: async (msg, text) => { replies.push({ chatId: msg.chatId, text }) },
    log: { info () {}, warn () {}, debug () {}, error () {} },
  }

  mod.setup(api)
  settings = { ...settings, termsAccepted: opts.consent !== false, ...settingsPatch }

  const emit = (name, payload) => Promise.all((listeners.get(name) || []).map((fn) => fn(payload)))
  return {
    dir,
    sent,
    replies,
    calls,
    settings: () => settings,
    emit,
    tick: () => tickFn(),
  }
}

const message = (patch = {}) => ({
  kind: 'group',
  chatId: `group:${GROUP}`,
  userId: OTHER,
  groupId: GROUP,
  role: '',
  text: '',
  messageId: '1',
  nickname: '小明',
  ...patch,
})

test('聊天里只记本人自述的生日', () => {
  assert.deepEqual(fromChatText('我生日是3月14日'), { month: 3, day: 14 })
  assert.deepEqual(fromChatText('我 12月31号生日'), { month: 12, day: 31 })
  assert.deepEqual(fromChatText('我2000年3月14日生日'), { month: 3, day: 14 })
  assert.equal(fromChatText('他生日是3月14日'), null)
  assert.equal(fromChatText('我生日是2月30日'), null)
})

test('资料里必须带生日字样，且能跳过注册日期', () => {
  assert.deepEqual(fromProfileText('生日 03-14 双鱼座'), { month: 3, day: 14 })
  assert.deepEqual(fromProfileText('出生于 2000 年 3 月 14 日'), { month: 3, day: 14 })
  assert.equal(fromProfileText('注册于 2020-03-14'), null)
})

test('生日表支持手改格式，坏行跳过', () => {
  const table = parseTable(`# 注释\n${OTHER}=03-14=小明\n坏行\n${OWNER}=2月29日`)
  assert.equal(table.get(OTHER).name, '小明')
  assert.equal(table.get(OWNER).day, 29)
  assert.equal(table.size, 2)
})

test('设置页会写上默认值', () => {
  const env = makeEnv({}, { consent: false })
  assert.equal(env.settings().wakeStart, 9)
  assert.equal(env.settings().wakeEnd, 21)
  assert.equal(env.settings().chatMode, 'group')
  assert.equal(env.settings().birthdays, '')
  assert.equal(env.settings().termsAccepted, false, '默认没同意协议')
})

test('聊天里说出自己的生日就记下来', async () => {
  const env = makeEnv({ learnProfile: false })
  await env.emit('message', message({ text: '我生日是3月14日' }))
  assert.equal(env.settings().birthdays, `${OTHER}=03-14=小明`)
  await env.emit('message', message({ text: '今天天气不错' }))
  assert.equal(env.settings().birthdays, `${OTHER}=03-14=小明`, '无关消息不改表')
})

test('私聊里的自述不记录，也不查资料', async () => {
  const env = makeEnv({ learnProfile: true }, { strangerSign: '生日 3月14日' })
  await env.emit('message', message({ kind: 'private', chatId: `private:${OTHER}`, groupId: '', text: '我生日是3月14日' }))
  assert.equal(env.settings().birthdays, '')
  assert.equal(env.calls.length, 0)
})

test('资料里带年份也只存月和日', async () => {
  const env = makeEnv({ learnChat: false }, { strangerSign: '出生于 1998 年 3 月 14 日' })
  await env.emit('message', message({ text: '随便聊聊' }))
  assert.equal(env.settings().birthdays, `${OTHER}=03-14`)
})

test('个人资料优先于聊天记录', async () => {
  const env = makeEnv({ learnProfile: true }, { strangerSign: '生日 3月14日' })
  // 同一条消息里先按聊天记成 03-15，再按资料改成 03-14。
  await env.emit('message', message({ text: '我生日是3月15日' }))
  assert.equal(env.settings().birthdays, `${OTHER}=03-14=小明`)
})

test('设置页手改过的日期不会被资料覆盖', async () => {
  const env = makeEnv({ learnProfile: true, birthdays: `${OTHER}=04-01=小明` }, { strangerSign: '生日 3月14日' })
  await env.emit('message', message({ text: '我生日是3月15日' }))
  assert.equal(env.settings().birthdays, `${OTHER}=04-01=小明`)
})

test('资料每个用户 7 天只查一次', async () => {
  const env = makeEnv({ learnChat: false }, { strangerSign: '' })
  await env.emit('message', message({ text: '一' }))
  await env.emit('message', message({ text: '二' }))
  assert.equal(env.calls.filter((c) => c.action === 'get_stranger_info').length, 1)
})

test('关掉学习就完全不记也不查资料', async () => {
  const env = makeEnv({ learnChat: false, learnProfile: false }, { strangerSign: '生日 3月14日' })
  await env.emit('message', message({ text: '我生日是3月14日' }))
  assert.equal(env.settings().birthdays, '')
  assert.equal(env.calls.length, 0)
})

test('没同意协议前不学习、不查资料、不发送', async () => {
  const base = new Date(2026, 2, 14, 0, 0, 0).getTime()
  mock.timers.enable({ apis: ['Date'], now: base })
  try {
    const env = makeEnv({
      termsAccepted: false,
      birthdays: `${OTHER}=03-14`,
      groupIds: GROUP,
    }, { strangerSign: '生日 3月14日' })

    await env.emit('message', message({ text: '我生日是3月15日' }))
    assert.equal(env.settings().birthdays, `${OTHER}=03-14`, '不改表')
    assert.equal(env.calls.length, 0, '不查任何资料')

    const minute = targetMinute('2026-03-14', OTHER, 9 * 60, 21 * 60)
    mock.timers.setTime(base + minute * 60_000)
    env.tick()
    await flush()
    assert.equal(env.sent.length, 0, '不同意就不发祝福')
  } finally {
    mock.timers.reset()
  }
})

test('#生日 忘了我 会删掉记录，并且不再自动学习', async () => {
  const env = makeEnv({ birthdays: `${OTHER}=03-14=小明` })
  const takeover = await env.emit('message', message({ text: '#生日 忘了我' }))
  assert.equal(takeover[0], true, '命令消息被接管')
  assert.equal(env.settings().birthdays, '')
  assert.match(env.replies[0].text, /已删除/)

  await env.emit('message', message({ text: '我生日是3月15日' }))
  assert.equal(env.settings().birthdays, '', '退出的人不再被记录')
  assert.equal(env.calls.filter((c) => c.action === 'get_stranger_info').length, 0)
})

test('删除自己的记录不需要先同意协议', async () => {
  const env = makeEnv({ termsAccepted: false, birthdays: `${OTHER}=03-14=小明` })
  await env.emit('message', message({ text: '#生日 删除' }))
  assert.equal(env.settings().birthdays, '')
})

test('要求删除后，到生日当天也不发', async () => {
  const base = new Date(2026, 2, 14, 0, 0, 0).getTime()
  mock.timers.enable({ apis: ['Date'], now: base })
  try {
    const env = makeEnv({ birthdays: `${OTHER}=03-14`, groupIds: GROUP })
    await env.emit('message', message({ text: '#生日 忘了我' }))
    // 主人再手动把这一天加回去，确认退出标记仍然压住发送。
    env.settings().birthdays = `${OTHER}=03-14`

    const minute = targetMinute('2026-03-14', OTHER, 9 * 60, 21 * 60)
    mock.timers.setTime(base + minute * 60_000)
    env.tick()
    await flush()
    assert.equal(env.sent.length, 0)
  } finally {
    mock.timers.reset()
  }
})

test('到生日当天，在窗口内随机一分钟于群里 @ 本人，且只发一次', async () => {
  const base = new Date(2026, 2, 14, 0, 0, 0).getTime()
  mock.timers.enable({ apis: ['Date'], now: base })
  try {
    const env = makeEnv({
      learnChat: false,
      learnProfile: false,
      birthdays: `${OTHER}=03-14=小明`,
      chatMode: 'group',
      groupIds: GROUP,
    })
    let sentMinute = -1
    for (let m = 9 * 60; m <= 21 * 60; m += 1) {
      mock.timers.setTime(base + m * 60_000)
      env.tick()
      await flush()
      if (env.sent.length) {
        sentMinute = m
        break
      }
    }
    assert.ok(sentMinute >= 9 * 60 && sentMinute < 21 * 60, '落在作息窗口内')
    assert.equal(env.sent.length, 1)
    assert.equal(env.sent[0].chatId, `group:${GROUP}`)
    assert.ok(env.sent[0].text.startsWith(`<at:${OTHER}> `), '群聊里 @ 本人')
    assert.match(env.sent[0].text, /生日快乐/)

    mock.timers.setTime(base + (sentMinute + 1) * 60_000)
    env.tick()
    await flush()
    assert.equal(env.sent.length, 1, '同一天不会重复发')
  } finally {
    mock.timers.reset()
  }
})

test('窗口开始前不发', async () => {
  const base = new Date(2026, 2, 14, 8, 0, 0).getTime()
  mock.timers.enable({ apis: ['Date'], now: base })
  try {
    const env = makeEnv({
      learnChat: false,
      learnProfile: false,
      birthdays: `${OTHER}=03-14`,
      groupIds: GROUP,
      wakeStart: 9,
      wakeEnd: 21,
    })
    env.tick()
    await flush()
    assert.equal(env.sent.length, 0)
  } finally {
    mock.timers.reset()
  }
})

test('不在群里就退回私聊，且不 @', async () => {
  const base = new Date(2026, 2, 14, 0, 0, 0).getTime()
  mock.timers.enable({ apis: ['Date'], now: base })
  try {
    const env = makeEnv({
      learnChat: false,
      learnProfile: false,
      birthdays: `${OTHER}=03-14=小明`,
      groupIds: GROUP,
      template: '{name}生日快乐！',
    }, { member: false })
    for (let m = 9 * 60; m <= 21 * 60; m += 1) {
      mock.timers.setTime(base + m * 60_000)
      env.tick()
      await flush()
      if (env.sent.length) break
    }
    assert.equal(env.sent.length, 1)
    assert.equal(env.sent[0].chatId, `private:${OTHER}`)
    assert.equal(env.sent[0].text, '小明生日快乐！')
  } finally {
    mock.timers.reset()
  }
})

test('关掉 @ 只发文字', async () => {
  const base = new Date(2026, 2, 14, 0, 0, 0).getTime()
  mock.timers.enable({ apis: ['Date'], now: base })
  try {
    const env = makeEnv({
      learnChat: false,
      learnProfile: false,
      birthdays: `${OTHER}=03-14`,
      groupIds: GROUP,
      mention: false,
      template: '生日快乐！',
    })
    for (let m = 9 * 60; m <= 21 * 60; m += 1) {
      mock.timers.setTime(base + m * 60_000)
      env.tick()
      await flush()
      if (env.sent.length) break
    }
    assert.equal(env.sent[0].text, '生日快乐！')
  } finally {
    mock.timers.reset()
  }
})

test('同一个日期算出来的发送分钟是固定的', () => {
  const a = targetMinute('2026-03-14', OTHER, 540, 1260)
  const b = targetMinute('2026-03-14', OTHER, 540, 1260)
  assert.equal(a, b)
  assert.ok(a >= 540 && a < 1260)
  assert.notEqual(targetMinute('2026-03-14', OTHER, 540, 1260), targetMinute('2026-03-15', OTHER, 540, 1260))
})
