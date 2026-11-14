// 模块入口的行为：不开不接管、没选不接管、筛选只影响列表不影响选择。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import mod from '../index.mjs'

/** 造一个只够用的假 api。 */
function fakeApi (settings, models) {
  const routes = new Map()
  const api = {
    settings: () => settings,
    route: (path, fn) => routes.set(path, fn),
    log: { info () {}, debug () {}, warn () {} },
    core: { http: { query: (req) => (req && req.query) || {} } },
    dsh: {
      llm: {
        listProviders: () => [{ id: 'doubao', name: '豆包' }],
        listModels: async () => models,
      },
    },
  }
  api.__routes = routes
  return api
}

const CATALOG = [
  { id: '2.1-pro', name: '豆包 2.1 Pro' },
  { id: 'image-gen', name: '豆包 生图（Seedream 5.0）' },
]

test('开关关着：不接管', () => {
  const api = fakeApi({ enabled: false, target: 'doubao\u0000image-gen' }, CATALOG)
  const out = mod.setup(api)
  assert.equal(out.ready(), false)
})

test('开着但没选模型：不接管（不自动挑第一个）', async () => {
  const api = fakeApi({ enabled: true, target: '' }, CATALOG)
  const out = mod.setup(api)
  assert.equal(out.ready(), false)
  // generate 也返回 null，让插件落回内置接法
  assert.equal(await out.generate('画一只猫'), null)
})

test('开着且选了模型：接管', async () => {
  const api = fakeApi({ enabled: true, target: 'doubao\u0000image-gen' }, CATALOG)
  const out = mod.setup(api)
  assert.equal(out.ready(), true)
})

test('选了一个已经不存在的模型：不接管', async () => {
  const api = fakeApi({ enabled: true, target: 'doubao\u0000gone' }, CATALOG)
  const out = mod.setup(api)
  assert.equal(out.ready(), true) // 设置层面"选了"
  assert.equal(await out.generate('画一只猫'), null) // 但目录里没有 → 不接管
})

test('清单只列出生图模型，普通聊天模型被排除', async () => {
  const api = fakeApi({ enabled: true, target: '' }, CATALOG)
  mod.setup(api)
  const r = await api.__routes.get('/models')({ query: {} })
  assert.equal(r.total, 1)
  assert.equal(r.models[0].model, 'image-gen')
})

test('筛选按名字/提供方缩小列表，并如实报告总数', async () => {
  const api = fakeApi({ enabled: true, target: '' }, CATALOG)
  mod.setup(api)
  const route = api.__routes.get('/models')

  const hit = await route({ query: { q: 'seedream' } })
  assert.equal(hit.models.length, 1)
  assert.equal(hit.total, 1)

  const miss = await route({ query: { q: '不存在的名字' } })
  assert.equal(miss.models.length, 0)
  assert.equal(miss.total, 1) // 总数仍是目录里的生图模型数

  const byProvider = await route({ query: { q: 'doubao' } })
  assert.equal(byProvider.models.length, 1)
})
