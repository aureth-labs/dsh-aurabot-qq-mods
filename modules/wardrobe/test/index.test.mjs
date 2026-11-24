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
  assert.equal(plugin.version, '1.2.1')
  assert.equal(plugin.api, 1)
  assert.equal(plugin.panel, 'panel.js')
  const keys = plugin.settings.map((s) => s.key)
  assert.deepEqual(keys, ['enabled', 'autoTag', 'visionModel'])
  assert.ok(keys.includes('enabled'))
  assert.ok(!keys.includes('autoDress'), '自动换装开关在面板里，不该占设置项')
  assert.ok(keys.includes('autoTag'), '新衣服自动打标开关')
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

// ---------- 场景标签 + 作息自动换装（v1.1.0） ----------

const rtOf = (res) => ({ stateAt: () => res })

test('场景标签：/update 存 scenes，非法值过滤，/list 返回场景选项', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const a = await env.call('/add', { name: '校服', desc: '蓝白水手服配百褶裙', scenes: ['out', 'fun'] })
  assert.deepEqual(a.item.scenes, ['out', 'fun'])
  const bad = await env.call('/update', { id: a.item.id, scenes: ['out', 'nonsense'] })
  assert.deepEqual(bad.item.scenes, ['out'])
  const list = await env.call('/list')
  assert.equal(list.scenes.length, 5, '五个场景选项')
})

test('自动换装：同场景随机挑、同场景当天不重挑、没标场景的衣服不动', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const a = await env.call('/add', { name: '睡衣A', desc: '蓝色棉质睡裙', scenes: ['sleep'] })
  const b = await env.call('/add', { name: '睡衣B', desc: '白色卡通短袖睡衣', scenes: ['sleep'] })
  const r = env.mod.autoDress('sleep')
  assert.equal(r.ok, true)
  assert.ok([a.item.id, b.item.id].includes(r.item.id), '只在标了该场景的衣服里挑')
  const list = await env.call('/list')
  assert.equal(list.today.autoScene, 'sleep')
  assert.ok(list.today.autoDate, '记录换装日期')
  // 同场景同天再对表：不动
  const r2 = env.mod.autoDress('sleep')
  assert.equal(r2.unchanged, true)
  // 换场景就重挑
  const c = await env.call('/add', { name: '居家服', desc: '灰色宽松卫衣', scenes: ['home'] })
  const r3 = env.mod.autoDress('home')
  assert.equal(r3.ok, true)
  const list2 = await env.call('/list')
  assert.equal(list2.today.set, c.item.id)
  assert.equal(list2.today.autoScene, 'home')
  // 没标任何场景的衣服永远进不了自动池
  const bare = await env.call('/add', { name: '没标签的', desc: '随便一套' })
  assert.equal(bare.item.scenes.length, 0)
  const r4 = env.mod.autoDress('lazy')
  assert.equal(r4.skipped, 'empty', '没标「休息宅家」的衣服就跳过')
  assert.notEqual(list2.today.set, bare.item.id)
})

test('自动换装：衣柜里没有该场景的衣服就跳过，不硬换', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const r = env.mod.autoDress('out')
  assert.equal(r.ok, false)
  assert.equal(r.skipped, 'empty')
})

test('手动优先：面板手动挑过的当天，自动换装让路', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await env.call('/add', { name: '外出服', desc: '米色风衣', scenes: ['out'] })
  const manual = await env.call('/add', { name: '女仆装', desc: '主人的选择' })
  await env.call('/today', { set: manual.item.id })
  const r = env.mod.autoDress('out')
  assert.equal(r.ok, false)
  assert.equal(r.skipped, 'manual')
  const list = await env.call('/list')
  assert.equal(list.today.set, manual.item.id, '手动挑的还在身上')
  assert.ok(!list.today.autoScene, '手动后场景标记被清掉')
})

test('sceneOf：作息状态映射场景', (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const m = env.mod
  // 上班/通勤 → out
  assert.equal(m.sceneOf(rtOf({ state: 'work', day: { type: 'work', segments: [[540, 1080]], src: 'week' } }), new Date(2026, 10, 16, 10, 0)), 'out')
  assert.equal(m.sceneOf(rtOf({ state: 'commute', day: { type: 'work', segments: [[540, 1080]] } }), new Date(2026, 10, 16, 8, 30)), 'out')
  // 她自己记的日程 → fun（多半是出门玩）
  assert.equal(m.sceneOf(rtOf({ state: 'work', day: { type: 'work', segments: [[600, 840]], src: 'self' } }), new Date(2026, 10, 16, 11, 0)), 'fun')
  // 休息日/请假在家 → lazy
  assert.equal(m.sceneOf(rtOf({ state: 'home', day: { type: 'rest', segments: [] } }), new Date(2026, 10, 16, 15, 0)), 'lazy')
  assert.equal(m.sceneOf(rtOf({ state: 'home', day: { type: 'leave', segments: [] } }), new Date(2026, 10, 16, 15, 0)), 'lazy')
  // 下班/放学到家 → home
  assert.equal(m.sceneOf(rtOf({ state: 'home', day: { type: 'work', segments: [[540, 1080]] } }), new Date(2026, 10, 16, 19, 0)), 'home')
  // 班间空档 → 不换
  assert.equal(m.sceneOf(rtOf({ state: 'home', day: { type: 'work', segments: [[600, 840], [990, 1260]] } }), new Date(2026, 10, 16, 15, 0)), null)
  // 还没出门 → 不换
  assert.equal(m.sceneOf(rtOf({ state: 'home', day: { type: 'work', segments: [[540, 1080]] } }), new Date(2026, 10, 16, 8, 0)), null)
  // 睡觉 → sleep
  assert.equal(m.sceneOf(rtOf({ state: 'sleep' }), new Date(2026, 10, 17, 2, 0)), 'sleep')
  // 下夜班补觉（跨午夜段结束不到中午）→ 不换（还穿着睡衣）
  assert.equal(m.sceneOf(rtOf({ state: 'home', day: { type: 'work', segments: [[1380, 480]] } }), new Date(2026, 10, 17, 9, 0)), null)
  // routine 没在跑 → null
  assert.equal(m.sceneOf(null), null)
  assert.equal(m.sceneOf({}), null)
})

test('syncDress 定时对表：作息在跑就自动换；开关关掉或作息没跑就完全不动', async (t) => {
  // 作息在跑：定时器触发换装
  const env = makeApi({ modules: { routine: rtOf({ state: 'home', day: { type: 'rest', segments: [] } }) } })
  t.after(env.cleanup)
  await env.call('/add', { name: '宅家服', desc: '宽松卫衣短裤', scenes: ['lazy'] })
  const fn = env.timers.find((x) => x.name === 'auto-dress').fn
  fn()
  const list = await env.call('/list')
  assert.equal(list.today.autoScene, 'lazy')
  assert.equal(list.today.set, (await env.call('/list')) && list.today.set)

  // 开关关掉：定时器跑了也不换
  const env2 = makeApi({ settings: { autoDress: false }, modules: { routine: rtOf({ state: 'home', day: { type: 'rest', segments: [] } }) } })
  t.after(env2.cleanup)
  await env2.call('/add', { name: '宅家服2', desc: '宽松卫衣短裤', scenes: ['lazy'] })
  const fn2 = env2.timers.find((x) => x.name === 'auto-dress').fn
  fn2()
  const list2 = await env2.call('/list')
  assert.ok(!list2.today.autoScene, '关掉自动换装就没有场景标记（today 只有种子女仆装）')

  // 作息模块没在跑：安静跳过
  const env3 = makeApi()
  t.after(env3.cleanup)
  await env3.call('/add', { name: '宅家服3', desc: '宽松卫衣短裤', scenes: ['lazy'] })
  const fn3 = env3.timers.find((x) => x.name === 'auto-dress').fn
  fn3()
  const list3 = await env3.call('/list')
  assert.ok(!list3.today.autoScene)
})

test('persona 注入：自动换装后带场景背景句（标注不进画稿），手动挑不带', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  await env.call('/add', { name: '睡衣A', desc: '蓝色棉质睡裙', scenes: ['sleep'] })
  env.mod.autoDress('sleep')
  const auto = await env.runHook('persona', '【人格】')
  assert.ok(auto.includes('穿着：蓝色棉质睡裙'))
  assert.ok(auto.includes('已经换上睡衣'))
  assert.ok(auto.includes('不要写进画面描述'), '场景句要明确标注不进画稿')
  // 手动挑之后（同一天）：场景句消失
  const another = await env.call('/add', { name: '女仆装', desc: '主人的选择' })
  await env.call('/today', { set: another.item.id })
  const manual = await env.runHook('persona', '【人格】')
  assert.ok(manual.includes('穿着：主人的选择'))
  assert.ok(!manual.includes('已经换上睡衣'))
})

// ---------- 场景打标：她自己标 + 一键标（v1.2.0） ----------

// 打标请求的假模型：按 desc 关键词给场景，顺便记下请求次数
const tagger = (map) => (o) => {
  if (!String(o.system || '').includes('场景标签')) return '深藏青毛衣配深灰阔腿裤'
  const lines = String(o.text || '').split('\n').filter(Boolean)
  const out = lines.map((l) => {
    const [id, name = '', desc = ''] = l.split('｜')
    const key = Object.keys(map).find((k) => (name + desc).includes(k))
    return { id, scenes: key ? map[key] : [] }
  })
  return '```json\n' + JSON.stringify(out) + '\n```'
}

test('一键标场景：只标没标过的，非法场景过滤，已标的不覆盖', async (t) => {
  // 先关掉加衣服时自动打标，保证进批量时都是「没标过」的
  const env = makeApi({
    settings: { autoTag: false },
    ask: tagger({ 睡裙: ['sleep'], 卫衣: ['home', 'lazy'], 风衣: ['out', 'bogus'] }),
  })
  t.after(env.cleanup)
  const a = await env.call('/add', { name: '蓝色睡裙', desc: '棉质睡裙', scenes: ['sleep'] }) // 手动标过
  const b = await env.call('/add', { name: '灰色卫衣', desc: '宽松卫衣', scenes: [] })
  const c = await env.call('/add', { name: '米色风衣', desc: '长款风衣', scenes: [] })
  const r = await env.call('/scenes/auto', {})
  assert.equal(r.ok, true)
  assert.ok(r.total >= 2, '只处理没标过的（池子里还有种子那件女仆装）')
  const list = await env.call('/list')
  const of = (id) => list.items.find((x) => x.id === id)
  assert.deepEqual(of(a.item.id).scenes, ['sleep'], '手动标过的不动')
  assert.deepEqual(of(b.item.id).scenes, ['home', 'lazy'])
  assert.deepEqual(of(c.item.id).scenes, ['out'], 'bogus 被过滤')
})

test('一键标场景：模型没给出结果就报失败、不改数据', async (t) => {
  const env = makeApi({ settings: { autoTag: false }, ask: () => '我判断不了' })
  t.after(env.cleanup)
  await env.call('/add', { name: '某件', desc: '不知道什么衣服', scenes: [] })
  const r = await env.call('/scenes/auto', {})
  assert.equal(r.ok, false)
  assert.match(r.message, /再试/)
})

test('新衣服自动打标：加进来就带场景；关掉开关就不问模型', async (t) => {
  const env = makeApi({ ask: tagger({ 睡裙: ['sleep'] }) })
  t.after(env.cleanup)
  const r = await env.call('/add', { name: '睡裙', desc: '白色棉质睡裙', scenes: [] })
  assert.deepEqual(r.item.scenes, ['sleep'])

  const env2 = makeApi({ settings: { autoTag: false }, ask: tagger({ 睡裙: ['sleep'] }) })
  t.after(env2.cleanup)
  const r2 = await env2.call('/add', { name: '睡裙2', desc: '白色棉质睡裙', scenes: [] })
  assert.deepEqual(r2.item.scenes, [])
  const tagCalls = env2.asked.filter((o) => String(o.system || '').includes('场景标签'))
  assert.equal(tagCalls.length, 0, '关掉自动打标就不该问模型')
})

test('她自己用的工具 wardrobe_tag：auto 批量 / one 按名字标', async (t) => {
  const env = makeApi({ settings: { autoTag: false }, ask: tagger({ 睡裙: ['sleep'], 卫衣: ['home'] }) })
  t.after(env.cleanup)
  const a = await env.call('/add', { name: '睡裙', desc: '棉质睡裙', scenes: [] })
  const b = await env.call('/add', { name: '卫衣', desc: '灰色卫衣', scenes: [] })
  const tg = env.tool('wardrobe_tag')
  assert.ok(tg && tg.name === 'wardrobe_tag', '工具挂上了')

  // one：按名字（几个字就行）标一件，中文场景名
  const r1 = await tg.execute({ action: 'one', name: '睡裙', scenes: '睡衣,日常居家' })
  assert.equal(r1.ok, true)
  assert.match(r1.message, /睡裙/)
  let list = await env.call('/list')
  assert.deepEqual(list.items.find((x) => x.id === a.item.id).scenes, ['sleep', 'home'])

  // one：场景写错要拒绝并给出可选范围
  const bad = await tg.execute({ action: 'one', name: '睡裙', scenes: '随便穿' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /上学上班/)

  // auto：把剩下没标的都标一遍
  const r2 = await tg.execute({ action: 'auto' })
  assert.equal(r2.ok, true)
  list = await env.call('/list')
  assert.deepEqual(list.items.find((x) => x.id === b.item.id).scenes, ['home'], '批量把她加的那件标上了')
  assert.deepEqual(list.items.find((x) => x.id === a.item.id).scenes, ['sleep', 'home'], '已标的不被批量覆盖')
})
test('自动换装开关在面板：/autodress/set 切换并反映到 /list', async (t) => {
  const env = makeApi()
  t.after(env.cleanup)
  const before = await env.call('/list')
  assert.equal(typeof before.autoDress, 'boolean', '/list 要给出 autoDress')
  assert.equal(before.hasRoutine, false, '没装 routine 时 hasRoutine 是 false')
  await env.call('/autodress/set', { on: false })
  assert.equal((await env.call('/list')).autoDress, false)
  await env.call('/autodress/set', { on: true })
  const after = await env.call('/list')
  assert.equal(after.autoDress, true)
  assert.equal(after.hasRoutine, false, '面板据此显示黄条')
})
