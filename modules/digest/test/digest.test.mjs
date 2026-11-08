// 群聊日报模块测试：只测纯函数，不读真聊天记录、不联网。
// 覆盖：提示词渲染、文本截断、噪音过滤、分组与预算分摊、主人私聊排除。
//
// 跑法（仓库根）：
//   node --test "modules/digest/test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInput, systemPrompt, cut, NOISE, dayKey } from '../index.mjs'

const msg = (chatId, who, text, t = 1) => ({ chatId, who, text, t, uid: String(t) })

test('systemPrompt：条数由代码填入，不留占位符', () => {
  const p = systemPrompt(192)
  assert.match(p, /今天192条消息/)
  assert.doesNotMatch(p, /<N>/, '不能让模型自己填条数')
  assert.match(p, /直接开始写正文/)
})

test('cut：超长截断加省略号，换行压成空格，短文本不动', () => {
  assert.equal(cut('短句', 10), '短句')
  assert.equal(cut('第一行\n第二行', 20), '第一行 第二行')
  assert.equal(cut('一二三四五', 3), '一二三…')
})

test('NOISE：寒暄和占位符算噪音，正常发言不算', () => {
  for (const s of ['嗯', '嗯嗯', '[图片]', '[表情]', '收到', '晚安', '哈', '1']) {
    assert.equal(NOISE.test(s), true, `${s} 应判为噪音`)
  }
  for (const s of ['今天下午我去图书馆了', '这个 bug 我改完了']) {
    assert.equal(NOISE.test(s), false, `${s} 不该被过滤`)
  }
})

test('buildInput：过滤噪音、统计非机器人条数', () => {
  const log = [
    msg('group:1', '小明', '下午三点见'),
    msg('group:1', '小红', '嗯'),
    msg('group:1', 'bot', '好呀'),
    msg('group:1', '小明', '[图片]'),
  ]
  const r = buildInput(log, { budget: 400 })
  assert.equal(r.total, 1, '只有一条真人有效发言')
  assert.equal(r.parts.length, 1)
  assert.match(r.parts[0], /下午三点见/)
  assert.match(r.parts[0], /她自己: 好呀/, '机器人发言保留但标成「她自己」')
  assert.doesNotMatch(r.parts[0], /嗯/)
})

test('buildInput：主人自己的私聊不进日报', () => {
  const log = [msg('private:999', '主人', '私密的话'), msg('group:1', '小明', '群里的消息')]
  const r = buildInput(log, { ownerQQ: '999', budget: 400 })
  assert.equal(r.parts.length, 1)
  assert.match(r.parts[0], /群里的消息/)
  assert.doesNotMatch(r.parts.join(), /私密的话/)
})

test('buildInput：关掉「私聊也算」后只剩群', () => {
  const log = [msg('private:123', '某人', '私聊内容'), msg('group:1', '小明', '群内容')]
  const r = buildInput(log, { includePrivate: false, budget: 400 })
  assert.equal(r.parts.length, 1)
  assert.doesNotMatch(r.parts.join(), /私聊内容/)
})

test('buildInput：群名从 nameOf 注入，取不到就用群号', () => {
  const log = [msg('group:888', '小明', '有名字的群'), msg('group:777', '小红', '没名字的群')]
  const r = buildInput(log, { nameOf: (gid) => (gid === '888' ? '摸鱼小分队' : '') })
  assert.match(r.parts.join(), /群「摸鱼小分队」/)
  assert.match(r.parts.join(), /群「777」/)
})

test('buildInput：每个聊天按预算分摊，超出只留最近的', () => {
  const rows = Array.from({ length: 80 }, (_, i) => msg('group:1', '小明', `第${i}条`, i))
  const r = buildInput(rows, { budget: 100 }) // 只有一个聊天 → per = 100，全留
  assert.equal(r.parts[0].split('\n').length, 81) // 一行标题 + 80 条
  const r2 = buildInput(rows, { budget: 50 }) // per = 50 → 只留最后 50 条
  const lines = r2.parts[0].split('\n')
  assert.equal(lines.length, 51)
  assert.match(lines[1], /第30条/, '留下的是最后 50 条，从第 30 条开始')
})

test('buildInput：空记录或全是噪音时 parts 为空', () => {
  assert.deepEqual(buildInput([], {}).parts, [])
  assert.deepEqual(buildInput([msg('group:1', '小明', '嗯')], {}).parts, [])
})

test('dayKey：是 YYYY-MM-DD', () => {
  assert.match(dayKey(new Date('2026-11-08T10:00:00').getTime()), /^2026-11-08$/)
})
