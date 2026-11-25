import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import mod from '../index.mjs'

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-module-'))
  const handlers = new Map(), commands = [], routes = new Map(), timers = [], sent = [], errors = []
  const feed = { log: [] }
  const config = { chatCooldownSeconds: 0, chatDailyLimit: 60, allowGroups: false }
  const api = {
    dataDir: () => dir, settings: () => config, isOwner: id => id === '123',
    on: (name, fn) => handlers.set(name, fn), command: c => commands.push(c),
    route: (path, fn) => routes.set(path, fn), every: (ms, fn) => timers.push(fn),
    use: id => id === 'feed' ? { state: () => feed } : null,
    reply: async (msg, text) => sent.push({ msg, text }),
    log: { info() {}, warn: e => errors.push(e) },
  }
  const exported = mod.setup(api)
  const message = (patch = {}) => ({ kind: 'private', chatId: 'private:123', userId: '123', text: '你好呀', messageId: '1', ...patch })
  return { dir, handlers, commands, routes, timers, sent, errors, feed, config, api, exported, message,
    close() { exported.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}

test('主人私聊计分、重发去重；陌生人和群聊默认不计', async () => {
  const h = harness()
  try {
    const on = h.handlers.get('message')
    await on(h.message())
    await on(h.message())
    await on(h.message({ userId: '999', messageId: '2' }))
    await on(h.message({ kind: 'group', chatId: 'group:456', mentioned: true, messageId: '3' }))
    assert.equal(h.exported.status().bond, 1)
    h.config.allowGroups = true
    await on(h.message({ kind: 'group', chatId: 'group:456', mentioned: false, messageId: '4' }))
    await on(h.message({ kind: 'group', chatId: 'group:456', mentioned: true, messageId: '5' }))
    assert.equal(h.exported.status().bond, 2)
    assert.equal(h.sent.length, 0)
  } finally { h.close() }
})

test('自然玩耍沿用原聊天流程，将真实结果注入主人的提示内容', async () => {
  const h = harness()
  try {
    assert.equal(await h.handlers.get('message')(h.message({ text: '陪你玩' })), false)
    assert.equal(h.exported.status().bond, 5)
    const original = [{ type: 'text', text: '陪你玩' }]
    const content = h.handlers.get('prompt')(original, { chat: { kind: 'private', chatId: 'private:123' }, senderId: '123', queryText: '陪你玩' })
    assert.equal(original.length, 1)
    assert.match(content.at(-1).text, /这次互动的实际结果：玩耍已记下/)
    assert.equal(h.handlers.get('prompt')(original, { chat: { kind: 'private', chatId: 'private:999' }, senderId: '999' }), undefined)
    assert.equal(h.sent.length, 0)
  } finally { h.close() }
})

test('状态查询接管一次回复，不偷偷增加聊天经验', async () => {
  const h = harness()
  try {
    assert.equal(await h.handlers.get('message')(h.message({ text: '养成状态' })), true)
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0].text, /Lv.1/)
    assert.equal(h.exported.status().xp, 0)
  } finally { h.close() }
})

test('投喂轮询不重算历史，持久化后重载不重复计分', () => {
  const h = harness()
  try {
    const since = h.exported.status().feedSince
    h.feed.log.push({ at: since, food: '米饭', source: '投喂', gain: 20 })
    h.timers[0]()
    assert.equal(h.exported.status().bond, 5)
    const again = mod.setup(h.api)
    h.timers.at(-1)()
    assert.equal(again.status().bond, 5)
    again.dispose()
  } finally { h.close() }
})

test('面板互动必须 POST；不支持任意动作或超长内容', async () => {
  const h = harness()
  const req = (method, text) => Object.assign(Readable.from([text]), { method })
  try {
    const route = h.routes.get('/interact')
    assert.equal((await route(req('GET', '{}'))).ok, false)
    assert.equal((await route(req('POST', '{broken'))).ok, false)
    assert.equal((await route(req('POST', JSON.stringify({ action: 'reset' })))).ok, false)
    assert.equal((await route(req('POST', 'x'.repeat(5000)))).ok, false)
    assert.equal((await route(req('POST', JSON.stringify({ action: 'touch' })))).ok, true)
    assert.equal(h.exported.status().bond, 2)
    assert.equal(h.sent.length, 0)
  } finally { h.close() }
})

test('写入失败时不提交内存奖励，不打断原本聊天', async () => {
  const h = harness()
  try {
    // 用同名目录模拟临时存档文件无法写入。
    mkdirSync(join(h.dir, 'state.json.tmp'))
    assert.equal(await h.handlers.get('message')(h.message()), false)
    assert.equal(h.exported.status().bond, 0)
    assert.equal(h.errors.length, 1)
    const saved = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf8'))
    assert.equal(saved.bond, 0)
  } finally { h.close() }
})

test('只保存计分和去重信息，不保存聊天正文', async () => {
  const h = harness()
  try {
    await h.handlers.get('message')(h.message({ text: '这句测试聊天正文不应该进入存档' }))
    assert.equal(readFileSync(join(h.dir, 'state.json'), 'utf8').includes('这句测试聊天正文'), false)
    const s = h.exported.status()
    assert.equal('seenMessages' in s, false)
    assert.equal('seenFeed' in s, false)
  } finally { h.close() }
})
