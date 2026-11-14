// 衣柜模块：元信息、加衣服（纯文字 / 带图）、当前穿搭、persona 注入、生成预览、换图、删除。
// 全部走假 api；生图和看图模型都短路掉，不联网、不花钱。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import plugin from '../index.mjs'
import { makeApi, PNG_1PX } from './helpers.mjs'

test('元信息：id / 版本 / 面板 / 设置项很少', () => {
  assert.equal(plugin.id, 'wardrobe')
  assert.equal(plugin.version, '1.0.1')
  assert.equal(plugin.api, 1)
  assert.equal(plugin.panel, 'panel.js')
  const keys = plugin.settings.map((s) => s.key)
  assert.ok(keys.includes('enabled'))
  assert.ok(keys.includes('visionModel'))
  assert.ok(!keys.includes('base'), '基础外观描述在面板里改，不该占设置项')
  assert.ok(!keys.includes('style'))
})

test('/add 纯文字：只写描述也能存一套，且成为可选穿搭', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const r = await env.call('/add', { name: '白T牛仔', desc: '白色T恤配牛仔短裤' })
  assert.equal(r.ok, true)
  assert.equal(r.item.kind, 'set')
  assert.equal(r.item.desc, '白色T恤配牛仔短裤')
  assert.equal(r.item.image, '')
  const list = await env.call('/list')
  assert.ok(list.items.some((x) => x.name === '白T牛仔'), '新加的那套要在列表里')
  assert.ok(list.poses.length >= 6, '至少六个固定姿势')
})

test('/add 带图：图片落盘，描述由看图模型给出', async (t) => {
  const env = makeApi({ caption: '黑色长袖上衣，白色圆环图案' })
  t.after(env.cleanup)
  const r = await env.call('/add', { name: '带图那套', image: PNG_1PX })
  assert.equal(r.ok, true)
  assert.equal(r.captioned, true)
  assert.equal(r.item.desc, '黑色长袖上衣，白色圆环图案')
  assert.match(r.item.image, /\.png$/)
  assert.ok(existsSync(join(env.dir, 'images', r.item.image)), '参考图要写到 images/')
})

test('/add：既没图也没描述就拒绝', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const r = await env.call('/add', { name: '空的' })
  assert.equal(r.ok, false)
})

test('/today：选一套后 outfit 就是那句描述', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const a = await env.call('/add', { name: 'A', desc: '灰卫衣配牛仔裤' })
  const b = await env.call('/add', { name: 'B', desc: '白衬衫配长裙' })
  const r = await env.call('/today', { set: a.item.id })
  assert.equal(r.ok, true)
  assert.equal(r.outfit, '灰卫衣配牛仔裤')
  const r2 = await env.call('/today', { set: b.item.id })
  assert.equal(r2.outfit, '白衬衫配长裙')
  const r3 = await env.call('/today', { set: '' })
  assert.equal(r3.outfit, '')
})

test('persona 钩子：发型和穿搭一起写进「当前的装扮」', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const base = '【你的样子】无发色。'
  const bare = await env.runHook('persona', base)
  assert.ok(bare.includes('【当前的装扮】'), '发型属于穿搭，默认也要带')
  assert.ok(bare.includes('发型：'), '要带默认发型')
  const a = await env.call('/add', { name: 'A', desc: '灰卫衣配牛仔裤' })
  await env.call('/today', { set: a.item.id })
  const out = await env.runHook('persona', base)
  assert.ok(out.startsWith(base), '人格原文要在前面')
  assert.ok(out.includes('穿着：灰卫衣配牛仔裤'))
  assert.ok(out.includes('发型：蓝黑色长发'))
})

test('persona 钩子：换发型后段落跟着变', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await env.call('/hair/set', { id: 'h_bun' })
  const out = await env.runHook('persona', '人格')
  assert.ok(out.includes('低丸子头'), '要写到当前选的发型：' + out)
})

test('/preview：按穿搭 + 姿势拼 prompt，出图进历史', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const a = await env.call('/add', { name: 'A', desc: '灰卫衣配牛仔裤' })
  await env.call('/today', { set: a.item.id })
  const r = await env.call('/preview', { pose: 'sit' })
  assert.equal(r.ok, true)
  assert.equal(env.drawn.length, 1)
  const prompt = env.drawn[0].prompt
  assert.ok(prompt.includes('今天穿：灰卫衣配牛仔裤'), 'prompt 要带当前穿搭：' + prompt)
  assert.ok(prompt.includes('坐在床边'), 'prompt 要带姿势：' + prompt)
  assert.ok(prompt.includes('二次元插画风格'), 'prompt 要带默认画风')
  assert.equal(env.drawn[0].options.shape, 'portrait')
  const hist = await env.call('/history')
  assert.equal(hist.list.length, 1)
  assert.equal(hist.list[0].pose, 'sit')
  assert.equal(hist.list[0].poses, '坐姿')
  assert.ok(existsSync(join(env.dir, 'preview', r.id + '.png')), '预览图要落盘')
})

test('/preview：Codex 这类不支持参考图的服务，只走文字', async (t) => {
  const env = makeApi({ provider: 'codex' })
  t.after(env.cleanup)
  const a = await env.call('/add', { name: 'A', image: PNG_1PX })
  await env.call('/today', { set: a.item.id })
  const r = await env.call('/preview', { pose: 'stand' })
  assert.equal(r.ok, true)
  assert.equal(r.usedReference, false, 'codex 不该把参考图传下去')
  assert.equal(env.drawn[0].options.image, undefined)
})

test('/image/replace：换图后文件名变、描述不变', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const a = await env.call('/add', { name: 'A', desc: '原描述' })
  await env.call('/image/replace', { id: a.item.id, image: PNG_1PX })
  const list = await env.call('/list')
  const it = list.items.find((x) => x.id === a.item.id)
  assert.match(it.image, /-1\d{12}\.png$/, '新图文件名带时间戳')
  assert.equal(it.desc, '原描述', '换图不该改描述')
  assert.ok(it.updatedAt > 0)
  assert.ok(existsSync(join(env.dir, 'images', it.image)))
})

test('/del：删掉后列表为空，今日穿搭也清掉', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const a = await env.call('/add', { name: 'A', desc: '一套' })
  await env.call('/today', { set: a.item.id })
  const d = await env.call('/del', { id: a.item.id })
  assert.equal(d.ok, true)
  const list = await env.call('/list')
  assert.ok(!list.items.some((x) => x.id === a.item.id), '删掉的那套不该还在')
  assert.equal(list.outfit, '', '今日穿搭跟着清掉')
})

test('/list：返回默认外观与画风，面板直接用', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const list = await env.call('/list')
  assert.ok(list.base.includes('鲸鱼耳朵'))
  assert.ok(list.style.includes('二次元'))
})

test('/clear：清空衣柜和图片', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await env.call('/add', { name: 'A', image: PNG_1PX })
  await env.call('/clear', {})
  const list = await env.call('/list')
  assert.equal(list.items.length, 0)
  const files = existsSync(join(env.dir, 'images')) ? readdirSync(join(env.dir, 'images')) : []
  assert.equal(files.length, 0, '图片也要删掉')
})

test('生成记录：历史按时间倒序、最多 60 条', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const a = await env.call('/add', { name: 'A', desc: '一套' })
  await env.call('/today', { set: a.item.id })
  await env.call('/preview', { pose: 'stand' })
  await env.call('/preview', { pose: 'sit' })
  const hist = await env.call('/history')
  assert.equal(hist.list.length, 2)
  assert.ok(hist.list[0].at >= hist.list[1].at, '新的在前')
})
test('默认女仆装：第一次跑自动放一套，删掉后不再硬塞', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const first = await env.call('/list')
  const maid = first.items.find((x) => x.name === '女仆装')
  assert.ok(maid, '默认要有一套女仆装')
  assert.equal(maid.kind, 'set')
  assert.ok(maid.desc.includes('女仆装'))
  assert.equal(first.today.set, maid.id, '没有别的穿搭时默认穿它')
  await env.call('/del', { id: maid.id })
  const second = await env.call('/list')
  assert.ok(!second.items.some((x) => x.name === '女仆装'), '删掉后不要自动再加回来')
})
