import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

const OWNER = '10000001'
const OTHER = '30000003'
const GROUP = '44444444'
const REPO = 'acme/widget'
const NOW = new Date().toISOString()

const repoInfo = {
  full_name: REPO,
  private: false,
  description: '一个小工具',
  default_branch: 'main',
  open_issues_count: 5,
  stargazers_count: 12,
  pushed_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
}

const commitInfo = {
  sha: 'abcdef1234567890',
  commit: { message: 'feat: 加个按钮\n\n详细说明', author: { name: 'HDB', date: NOW } },
  author: { login: 'HDB-Studio' },
}

const run = (patch = {}) => ({
  id: 1, name: 'tests', conclusion: 'success', status: 'completed',
  run_number: 3, head_branch: 'main', created_at: NOW,
  html_url: 'https://github.com/acme/widget/actions/runs/1', ...patch,
})

function makeFetch(routes) {
  const calls = []
  const headers = []
  const impl = async (url, options = {}) => {
    const href = String(url)
    calls.push(href)
    headers.push(options.headers || {})
    for (const [part, handler] of routes) {
      if (href.includes(part)) {
        const value = typeof handler === 'function' ? handler() : handler
        return { ok: value.status === undefined || value.status === 200, status: value.status || 200, json: async () => value.body ?? value }
      }
    }
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }
  }
  return { impl, calls, headers }
}

function makeEnv({ settings = {}, config = {}, routes = [] } = {}) {
  delete process.env.GITHUB_TOKEN
  const dir = mkdtempSync(join(tmpdir(), 'gh-assistant-'))
  let current = {
    token: 't0ken',
    repos: REPO,
    groupRepos: '',
    pollMinutes: 5,
    notifyCi: true,
    notifyReview: true,
    notifyMention: true,
    quietStart: 0,
    quietEnd: 0,
    groupDetail: 'normal',
    groupCooldown: 15,
    ...settings,
  }
  const sent = []
  const replies = []
  const listeners = new Map()
  let tick = null
  let tickLabel = ''
  const api = {
    settings: () => current,
    saveSettings: (patch) => { current = { ...current, ...patch } },
    dataDir: (name = '') => join(dir, name),
    every: (ms, fn, label) => { tick = fn; tickLabel = label; return () => {} },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    config: () => ({ ownerQQ: OWNER, dryRun: false, allow: { private: [OWNER], groups: [GROUP] }, ...config }),
    isOwner: (id) => String(id) === OWNER,
    send: async (chatId, text) => { sent.push({ chatId, text }) },
    reply: async (msg, text) => { replies.push({ chatId: msg.chatId, text }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const result = mod.setup(api)
  const emit = (name, payload) => Promise.all((listeners.get(name) || []).map((fn) => fn(payload)))
  return { api, dir, emit, sent, replies, tick: () => tick(), tickLabel, poll: result.poll, settings: () => current }
}

const message = (patch = {}) => ({
  kind: 'private', chatId: `private:${OWNER}`, userId: OWNER, groupId: '', role: '',
  text: '', messageId: '1', nickname: '主人', ...patch,
})

const statusRoutes = (extra = []) => [
  ['/repos/acme/widget/commits/main', { body: commitInfo }],
  ['/repos/acme/widget/actions/runs', { body: { workflow_runs: [run()] } }],
  ['/repos/acme/widget/pulls', { body: [{ id: 11, number: 7, title: '修好打包', user: { login: 'alice' } }] }],
  ['/repos/acme/widget/releases/latest', { body: { tag_name: 'v1.0.0' } }],
  ['/repos/acme/widget', { body: repoInfo }],
  ...extra,
]

test('群里 #项目 按别名查状态，normal 档带提交和 PR 数', async () => {
  const { impl } = makeFetch(statusRoutes())
  globalThis.fetch = impl
  const env = makeEnv({ settings: { groupRepos: 'widget=' + REPO, groupDetail: 'normal' } })
  const takeover = await env.emit('message', message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '#项目 widget' }))
  assert.equal(takeover[0], true)
  const text = env.replies[0].text
  assert.match(text, /acme\/widget/)
  assert.match(text, /CI: 通过/)
  assert.match(text, /最新提交: abcdef1 feat: 加个按钮/)
  assert.match(text, /开放: PR 1 · Issue 4 · Star 12/)
  assert.doesNotMatch(text, /待合并 PR/, 'normal 档不列 PR 标题')
})

test('detail 档追加最近 PR 和 Release', async () => {
  const { impl } = makeFetch(statusRoutes())
  globalThis.fetch = impl
  const env = makeEnv({ settings: { groupRepos: REPO, groupDetail: 'detail' } })
  await env.emit('message', message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '/项目' }))
  const text = env.replies[0].text
  assert.match(text, /待合并 PR:/)
  assert.match(text, /#7 修好打包（@alice）/)
  assert.match(text, /最新发布: v1\.0\.0/)
})

test('brief 档不查 PR，也不显示提交', async () => {
  const { impl, calls } = makeFetch(statusRoutes())
  globalThis.fetch = impl
  const env = makeEnv({ settings: { groupRepos: REPO, groupDetail: 'brief' } })
  await env.emit('message', message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '#项目' }))
  assert.doesNotMatch(env.replies[0].text, /最新提交/)
  assert.equal(calls.filter((url) => url.includes('/pulls')).length, 0)
})

test('群没配置仓库 / 不在白名单 / 仓库名不认识都给出提示', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
  const empty = makeEnv({ settings: { groupRepos: '' } })
  await empty.emit('message', message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '#项目' }))
  assert.match(empty.replies[0].text, /还没在/)

  const blocked = makeEnv({ settings: { groupRepos: REPO } })
  await blocked.emit('message', message({ kind: 'group', chatId: 'group:999', groupId: '999', userId: OTHER, text: '#项目' }))
  assert.match(blocked.replies[0].text, /不在白名单/)

  const { impl } = makeFetch(statusRoutes())
  globalThis.fetch = impl
  const wrong = makeEnv({ settings: { groupRepos: REPO } })
  await wrong.emit('message', message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '#项目 不存在' }))
  assert.match(wrong.replies[0].text, /没有「不存在」这个项目/)
})

test('#项目 只有主人能在私聊用', async () => {
  globalThis.fetch = async () => { throw new Error('不该联网') }
  const env = makeEnv()
  await env.emit('message', message({ userId: OTHER, text: '#项目' }))
  assert.match(env.replies[0].text, /只有主人/)
})

test('群里同一个仓库有冷却时间', async () => {
  const { impl } = makeFetch(statusRoutes())
  globalThis.fetch = impl
  const env = makeEnv({ settings: { groupRepos: REPO, groupCooldown: 60 } })
  const msg = message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '#项目' })
  await env.emit('message', msg)
  assert.equal(env.replies.length, 1)
  await env.emit('message', msg)
  assert.equal(env.replies.length, 1, '冷却期内不再回一条')
})

test('第一次巡检只记账，之后 CI 失败只提醒一次', async () => {
  let failing = false
  const { impl } = makeFetch([
    ['/repos/acme/widget/actions/runs', () => ({
      body: { workflow_runs: [run({ id: failing ? 2 : 1, conclusion: failing ? 'failure' : 'success' })] },
    })],
  ])
  globalThis.fetch = impl
  const env = makeEnv({ settings: { notifyReview: false, notifyMention: false } })

  await env.poll()
  assert.equal(env.sent.length, 0, '首次只记录现状')

  failing = true
  await env.poll()
  assert.equal(env.sent.length, 1)
  assert.equal(env.sent[0].chatId, `private:${OWNER}`)
  assert.match(env.sent[0].text, /\[CI 失败\] acme\/widget/)

  await env.poll()
  assert.equal(env.sent.length, 1, '同一条 run 不重复提醒')
})

test('待审 PR 和 @ 提醒各发一条，汇总成一条消息', async () => {
  let phase = 0
  const { impl } = makeFetch([
    ['/user', { body: { login: 'HDB-Studio' } }],
    ['/repos/acme/widget/actions/runs', { body: { workflow_runs: [] } }],
    ['/repos/acme/widget/pulls', () => ({ body: [{ id: 20 + phase, number: 8, title: '等我看看', user: { login: 'bob' }, requested_reviewers: [{ login: 'hdb-studio' }] }] })],
    ['/search/issues', () => ({ body: { items: [{ id: 30 + phase, number: 9, title: '@HDB-Studio 这个怎么弄', user: { login: 'carol' }, html_url: 'https://github.com/acme/widget/issues/9' }] } })],
  ])
  globalThis.fetch = impl
  const env = makeEnv({ settings: { notifyCi: false } })

  await env.poll() // 首次只记录
  assert.equal(env.sent.length, 0)

  phase = 1
  await env.poll()
  assert.equal(env.sent.length, 1)
  assert.match(env.sent[0].text, /\[等你审\] acme\/widget #8 等我看看/)
  assert.match(env.sent[0].text, /\[@ 你\] acme\/widget Issue #9/)
})

test('免打扰时段不巡检', async () => {
  globalThis.fetch = async () => { throw new Error('免打扰期间不该联网') }
  const hour = new Date().getHours()
  const env = makeEnv({ settings: { quietStart: hour, quietEnd: (hour + 2) % 24 } })
  await env.poll()
  assert.equal(env.sent.length, 0)
})

test('试运行只记日志不发私聊', async () => {
  let failing = false
  const { impl } = makeFetch([
    ['/repos/acme/widget/actions/runs', () => ({ body: { workflow_runs: [run({ id: failing ? 6 : 5, conclusion: failing ? 'failure' : 'success' })] } })],
  ])
  globalThis.fetch = impl
  const env = makeEnv({ config: { dryRun: true }, settings: { notifyReview: false, notifyMention: false } })
  await env.poll()
  failing = true
  await env.poll()
  assert.equal(env.sent.length, 0)
})

test('设置页挂了默认值，巡检定时器注册了', async () => {
  const env = makeEnv()
  assert.equal(env.settings().pollMinutes, 5)
  assert.equal(env.tickLabel, 'GitHub 助手巡检')
})

test('设置页里的 token 加载时移到数据目录并清空', () => {
  const env = makeEnv()
  assert.equal(env.settings().token, '', '配置里不再保留 token')
  assert.equal(readFileSync(join(env.dir, 'token'), 'utf8'), 't0ken')
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(env.dir, 'token')).mode & 0o777, 0o600, '只有本人可读')
  }
})

test('请求使用数据目录里的 token', async () => {
  const f = makeFetch(statusRoutes())
  globalThis.fetch = f.impl
  const env = makeEnv({ settings: { groupRepos: REPO } })
  await env.emit('message', message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '#项目' }))
  assert.equal(f.headers[0].Authorization, 'Bearer t0ken')
})

test('环境变量 GITHUB_TOKEN 优先于文件', async () => {
  const f = makeFetch(statusRoutes())
  globalThis.fetch = f.impl
  const env = makeEnv({ settings: { groupRepos: REPO } })
  process.env.GITHUB_TOKEN = 'env-token'
  try {
    await env.emit('message', message({ kind: 'group', chatId: `group:${GROUP}`, groupId: GROUP, userId: OTHER, text: '#项目' }))
  } finally {
    delete process.env.GITHUB_TOKEN
  }
  assert.equal(f.headers[0].Authorization, 'Bearer env-token')
})
