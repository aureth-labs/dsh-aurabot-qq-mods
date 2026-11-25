// 注册与路由单测：用假的 api 对象，不联网、不发消息。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import def from '../index.mjs'

const dataDir = mkdtempSync(join(tmpdir(), 'aibrief-'))
globalThis.fetch = async () => { throw new Error('offline') }

const handlers = {}
const routes = {}
const commands = []
const tools = []
const timers = []
const sent = []

const api = {
  settings: () => ({ forumEnabled: true }),
  config: () => ({ allow: { groups: ['10001'] }, ownerQQ: '1', botQQ: '2' }),
  dataDir: () => dataDir,
  log: { info() {}, warn() {}, debug() {} },
  on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn) },
  route: (path, fn) => { routes[path] = fn },
  command: (c) => { commands.push(c) },
  tool: (builder) => { tools.push(builder) },
  every: (ms, fn) => { timers.push({ ms, fn }) },
  use: () => null,
  ask: async () => '{"picks":[]}',
  sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  send: async (chatId, text) => { sent.push({ chatId, text }) },
  reply: async (msg, text) => { sent.push({ chatId: msg.chatId, text }) },
  defineTool: (tool) => tool,
  core: { http: { query: () => ({}), body: async () => ({}) } },
  lib: () => ({}),
}

def.setup(api)

test('注册了全部 HTTP 路由', () => {
  for (const p of ['/preview', '/sources', '/send', '/status', '/manual', '/forum/preview', '/forum/send', '/forum/search']) {
    assert.equal(typeof routes[p], 'function', '缺少路由 ' + p)
  }
})

test('注册了命令', () => {
  const names = commands.map((c) => c.name)
  for (const n of ['早报', '晚报', '论坛速报']) assert.ok(names.includes(n), '缺少命令 ' + n)
})

test('注册了 30 秒定时器', () => {
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 30000)
})

test('论坛启用时注册 forum_search 工具', () => {
  assert.equal(tools.length, 1)
  const list = tools[0]({ chat: { kind: 'group' }, sessionId: 's' })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'forum_search')
  assert.deepEqual(list[0].required, ['query'])
})

test('消息钩子只接管口令，不拦普通聊天', async () => {
  const hook = handlers.message[0]
  assert.equal(typeof hook, 'function')
  assert.equal(await hook({ chatId: 'group:10001', userId: '2', text: '今天吃啥' }), undefined)
  assert.equal(await hook({ chatId: 'group:10001', userId: '2', text: '早报' }), true)
  assert.equal(await hook({ chatId: 'group:10001', userId: '2', text: '来份晚报' }), true)
  assert.equal(await hook({ chatId: 'group:10001', userId: '2', text: '论坛速报' }), true)
})
