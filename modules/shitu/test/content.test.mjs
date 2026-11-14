/**
 * content.test.mjs —— 图片块改写与「有没有实质文字」判定
 *
 * 这组测试钉死两个踩过坑的地方：
 *   1. 表情包上只有一个「?」时，OCR 技术上「读到了字」，但那等于什么都没给，
 *      必须判成没字、转去走画面描述。
 *   2. prompt 钩子改写后：顺序不变；模型能看图时原图必须留着，
 *      否则等于把她唯一的画面信息换成几个字。
 *
 * 全部用假的 api，不启动 python、不联网、不发消息。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import mod, { isSubstantive } from '../index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELFTEST = readFileSync(join(HERE, '..', 'lib', 'assets', 'selftest.png'))
const IMG_B64 = SELFTEST.toString('base64')

// ── isSubstantive：纯函数，直接测 ─────────────────────────

test('正常一段字算有内容', () => {
  assert.equal(isSubstantive({ ok: true, text: '订单号 A20261108-0042' }), true)
})

test('只有一个标点不算有内容（表情包常见）', () => {
  for (const t of ['?', '？', '!', '！', '…', '.', '。', '·']) {
    assert.equal(isSubstantive({ ok: true, text: t }), false, `「${t}」不该算有字`)
  }
})

test('标点加空白也不算', () => {
  assert.equal(isSubstantive({ ok: true, text: '  ?  ' }), false)
})

test('单个汉字算内容（可能是真实信息）', () => {
  assert.equal(isSubstantive({ ok: true, text: '我' }), true)
})

test('单个数字、字母算内容', () => {
  assert.equal(isSubstantive({ ok: true, text: '8' }), true)
  assert.equal(isSubstantive({ ok: true, text: 'A' }), true)
})

test('两个以上字符不管是什么都算', () => {
  assert.equal(isSubstantive({ ok: true, text: '嗯嗯' }), true)
  assert.equal(isSubstantive({ ok: true, text: '88' }), true)
})

test('空文本、识别失败、没结果都不算', () => {
  assert.equal(isSubstantive({ ok: true, text: '' }), false)
  assert.equal(isSubstantive({ ok: false, text: '有字但失败了' }), false)
  assert.equal(isSubstantive(null), false)
  assert.equal(isSubstantive(undefined), false)
})

test('符号加字混合，只剩符号时不算', () => {
  assert.equal(isSubstantive({ ok: true, text: '？！' }), false)
  assert.equal(isSubstantive({ ok: true, text: '？！好' }), true)
})

// ── 模块定义与设置 ─────────────────────────────────────────

test('模块定义和 module.json 对得上', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, '..', 'module.json'), 'utf8'))
  assert.equal(mod.id, manifest.id)
  assert.equal(mod.version, manifest.version)
  assert.equal(mod.api, manifest.api)
  assert.equal(typeof mod.setup, 'function')
})

test('设置项 key 不重复，每个都有 label', () => {
  const keys = mod.settings.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length, '有重复的 key')
  for (const s of mod.settings) {
    assert.ok(s.label && s.label.trim(), `${s.key} 缺 label`)
    assert.ok(['switch', 'number', 'text', 'select', 'textarea', 'password'].includes(s.type), `${s.key} 的 type 不认识`)
  }
})

test('defaults 覆盖所有 switch 型设置', () => {
  for (const s of mod.settings.filter((x) => x.type === 'switch')) {
    assert.equal(typeof mod.defaults[s.key], 'boolean', `${s.key} 的默认值要是布尔`)
  }
})

test('没有残留的 onlyWhenBlind（会当门禁把功能关掉）', () => {
  assert.equal(mod.defaults.onlyWhenBlind, undefined)
  assert.equal(mod.settings.some((s) => s.key === 'onlyWhenBlind'), false)
})

// ── prompt 钩子：用假 api 跑真实逻辑 ───────────────────────

/**
 * 造一份假 api，返回 { api, hooks, tools, state }。
 * canSee 控制「当前模型能不能看图」，ask 记录被调用的次数。
 */
function fakeApi({ canSee = false, enabled = true, say = '【描述】一张卡通图，没有文字。' } = {}) {
  const hooks = new Map()
  const tools = []
  const state = { asked: [], settings: { ...mod.defaults, enabled, describeProvider: '', describeModelId: '' } }
  const api = {
    id: 'shitu',
    source: 'user',
    version: 'test',
    apiVersion: 1,
    dir: join(HERE, '..'),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    settings: () => state.settings,
    saveSettings: (p) => Object.assign(state.settings, p),
    dataDir: (...p) => join(process.env.TEMP || '/tmp', 'shitu-content-test', ...p),
    on: (n, fn) => hooks.set(n, fn),
    tool: (fn) => tools.push(fn),
    rule: () => {},
    command: () => {},
    route: () => {},
    later: () => {},
    config: () => ({ model: { provider: 'p', model: 'm', vision: 'auto' }, chatModels: { privates: {} } }),
    core: {
      hub: { referenceImage: async () => SELFTEST },
      http: { body: async () => ({}), query: () => ({}) },
      listModels: async () => [{ provider: 'p', model: 'vision-on', vision: true }],
    },
    dsh: {},
    lib: (p) => {
      if (p === 'core/llm.js') return { modelVision: async () => canSee }
      if (p === 'chat/chat-model.js') return { resolveChatModel: () => null }
      throw new Error('没有这个内部模块：' + p)
    },
    defineTool: (t) => t,
    ask: async (o) => {
      state.asked.push(o)
      return say
    },
    think: async () => '',
  }
  const exported = mod.setup(api)
  return { api, hooks: hooks, tools, state, exported }
}

const CHAT = { chatId: 'private:1', kind: 'private', userId: '1' }
const withImage = (text = '主人：这图上写的啥') => [
  { type: 'text', text },
  { type: 'image', data: IMG_B64, mediaType: 'image/png', name: 'x.png' },
]

test('总开关关掉：完全不碰内容', async () => {
  const { hooks, state } = fakeApi({ enabled: false })
  state.settings.dir = '/nonexistent-shitu-dir'
  const out = await hooks.get('prompt')(withImage(), { chat: CHAT })
  assert.equal(out, undefined, '应该原样放行')
})

test('没有图片：不动', async () => {
  const { hooks } = fakeApi()
  const out = await hooks.get('prompt')([{ type: 'text', text: '只说话' }], { chat: CHAT })
  assert.equal(out, undefined)
})

test('引擎没装好：图片原样放行，不抛错', async () => {
  const { hooks, state } = fakeApi()
  // 指到一个不存在的目录 → inspect 判定缺引擎，autoInstall 会尝试装但会失败
  state.settings.dir = join(process.env.TEMP || '/tmp', 'shitu-definitely-missing-' + Date.now())
  state.settings.autoInstall = false
  const out = await hooks.get('prompt')(withImage(), { chat: CHAT })
  assert.equal(out, undefined, '引擎没好就不该改内容')
})

test('引擎没装好时不吞内容、不抛异常（钩子要有兜底）', async () => {
  const { hooks, state } = fakeApi()
  state.settings.dir = join(process.env.TEMP || '/tmp', 'shitu-missing-' + Date.now())
  state.settings.autoInstall = false
  // 即使内部出错，也不能让整轮内容消失
  const out = await hooks.get('prompt')(withImage(), { chat: CHAT })
  assert.ok(out === undefined || Array.isArray(out), '要么原样放行，要么返回数组')
})

// ── 工具注册 ───────────────────────────────────────────────

test('开关开着时注册 shitu_read 工具', () => {
  const { tools, api } = fakeApi({ enabled: true })
  const list = tools[0]({ chat: { kind: 'private', chatId: 'private:1' } })
  const arr = Array.isArray(list) ? list : [list]
  const tool = arr.find((t) => t && t.name === 'shitu_read')
  assert.ok(tool, '没注册 shitu_read')
  assert.equal(typeof tool.execute, 'function')
  assert.ok(tool.description.includes('OCR'))
})

test('开关关掉时不注册工具', () => {
  const { tools } = fakeApi({ enabled: false })
  const list = tools[0]({ chat: { kind: 'private', chatId: 'private:1' } })
  const arr = Array.isArray(list) ? list : [list]
  assert.equal(arr.filter(Boolean).length, 0)
})

test('系统会话里不给工具', () => {
  const { tools } = fakeApi({ enabled: true })
  const list = tools[0]({ chat: { kind: 'system', chatId: 'system:x' } })
  assert.deepEqual(list, [])
})
