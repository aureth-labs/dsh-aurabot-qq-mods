// 每日晚报模块测试：只测纯函数，不联网、不写文件。
// 覆盖：RSS 解析、多源去重、兴趣加权、三档提示词渲染、日期标题。
//
// 跑法（仓库根）：
//   node --test "modules/morning/test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseItems, pickTag, dedupeByTitle, rankByInterest, systemPrompt, todayLabel } from '../index.mjs'

const RSS = `<rss><channel>
<item>
  <title><![CDATA[台积电考虑进入内存行业]]></title>
  <link>https://example.com/a</link>
  <pubDate>Sun, 08 Nov 2026 14:20:00 GMT</pubDate>
</item>
<item>
  <title>上海交大做出能自己跑实验的 AI 实验室</title>
  <link>https://example.com/b</link>
  <pubDate>Sun, 08 Nov 2026 13:00:00 GMT</pubDate>
</item>
<item>
  <title>   </title>
  <link>https://example.com/empty</link>
</item>
<item>
  <title>没有日期的条目</title>
  <link>https://example.com/c</link>
</item>
</channel></rss>`

test('pickTag：能取普通标签和 CDATA，取不到返回空串', () => {
  assert.equal(pickTag('<title>普通标题</title>', 'title'), '普通标题')
  assert.equal(pickTag('<title><![CDATA[带 CDATA 的标题]]></title>', 'title'), '带 CDATA 的标题')
  assert.equal(pickTag('<title>a</title>', 'link'), '')
})

test('parseItems：解析标题/链接/时间，空白标题丢弃，没日期的置 0，带上来源', () => {
  const items = parseItems(RSS, 'IT之家')
  assert.equal(items.length, 3, '空白标题那条要被丢掉')
  assert.equal(items[0].title, '台积电考虑进入内存行业')
  assert.equal(items[0].link, 'https://example.com/a')
  assert.equal(items[0].source, 'IT之家')
  assert.ok(items[0].ts > 0, '正常日期要解析成时间戳')
  assert.equal(items[2].ts, 0, '没有 pubDate 的条目 ts 应该是 0')
})

test('dedupeByTitle：同一件事的不同写法只留先到的那条', () => {
  const items = [
    { title: '台积电考虑进入内存行业', source: 'IT之家', ts: 3 },
    { title: '台积电考虑进入内存行业！', source: '爱范儿', ts: 2 }, // 标点不同，前 14 字一样
    { title: '完全不相干的一条新闻标题内容', source: '少数派', ts: 1 },
  ]
  const out = dedupeByTitle(items)
  assert.equal(out.length, 2)
  assert.equal(out[0].source, 'IT之家', '保留先到的那个来源')
  assert.equal(out[1].title, '完全不相干的一条新闻标题内容')
})

test('dedupeByTitle：标题为空的条目不参与去重，也不会互相吞掉', () => {
  const out = dedupeByTitle([{ title: '' }, { title: '' }, { title: '正常标题' }])
  assert.equal(out.length, 3)
})

test('rankByInterest：命中关键词的排前面，同样命中按时间倒序', () => {
  const items = [
    { title: '苹果发布新款耳机', ts: 300 },
    { title: '国产 AI 芯片流片成功', ts: 100 },
    { title: '开源模型权重放出', ts: 200 },
    { title: '某游戏打折', ts: 400 },
  ]
  const out = rankByInterest(items, 'AI, 开源')
  assert.equal(out[0].title, '开源模型权重放出', '两个都命中，时间更新的排前面')
  assert.equal(out[1].title, '国产 AI 芯片流片成功')
  assert.equal(out[2].title, '某游戏打折', '没命中的按时间倒序排后面')
  assert.equal(out[3].title, '苹果发布新款耳机')
})

test('rankByInterest：不填兴趣时保持原顺序', () => {
  const items = [{ title: 'a', ts: 1 }, { title: 'b', ts: 2 }]
  assert.deepEqual(rankByInterest(items, '').map((x) => x.title), ['a', 'b'])
  assert.deepEqual(rankByInterest(items, '   ').map((x) => x.title), ['a', 'b'])
})

test('systemPrompt：三档条数正确，常规档听 maxItems', () => {
  const brief = systemPrompt('11月8日晚报', { detail: 'brief' })
  const normal = systemPrompt('11月8日晚报', { detail: 'normal', maxItems: 5 })
  const deep = systemPrompt('11月8日晚报', { detail: 'deep' })
  assert.match(brief, /最多 3 条/)
  assert.match(normal, /最多 5 条/)
  assert.match(deep, /最多 4 条/)
  assert.match(brief, /一句话/)
  assert.match(deep, /60~90 字/)
})

test('systemPrompt：标题行原样给出，并要求标出处', () => {
  const p = systemPrompt('11月8日晚报')
  assert.match(p, /11月8日晚报/, '标题必须由代码给死，不能让模型自己编日期')
  assert.doesNotMatch(p, /<N>月/, '不能再出现让模型填日期的占位符')
  assert.match(p, /标出来源媒体/)
})

test('systemPrompt：只在填了兴趣时才加那句', () => {
  assert.match(systemPrompt('11月8日晚报', { interests: 'AI, 芯片' }), /他最近更关心这些方向：AI、芯片/)
  assert.doesNotMatch(systemPrompt('11月8日晚报', { interests: '' }), /他最近更关心/)
})

test('todayLabel：是「M月D日晚报」，不是让模型猜的占位符', () => {
  const label = todayLabel()
  assert.match(label, /^\d{1,2}月\d{1,2}日晚报$/)
  const now = new Date()
  assert.equal(label, `${now.getMonth() + 1}月${now.getDate()}日晚报`)
})
