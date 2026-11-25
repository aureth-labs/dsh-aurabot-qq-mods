// qq-confirm.test.mjs —— 发起前截图确认的纯词法测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeQqConfirmId, parseQqConfirmReply, QQ_CONFIRM_TTL_MS } from '../lib/qq-confirm.mjs'

test('确认码：4 位、去掉易混字符、随机源边界安全', () => {
  const id = makeQqConfirmId(() => 0)
  assert.equal(id, 'AAAA')
  assert.equal(id.length, 4)
  assert.doesNotMatch(id, /[IO01]/)
  assert.equal(makeQqConfirmId(() => 0.999999).length, 4)
})

test('确认回复：只接受整句，不让「不确认/确认一下」误放行', () => {
  assert.deepEqual(parseQqConfirmReply('确认'), { action: 'confirm', id: '' })
  assert.deepEqual(parseQqConfirmReply(' 确认  Ab12 '), { action: 'confirm', id: 'AB12' })
  assert.deepEqual(parseQqConfirmReply('同意'), { action: 'confirm', id: '' })
  assert.deepEqual(parseQqConfirmReply('开始'), { action: 'confirm', id: '' })
  assert.deepEqual(parseQqConfirmReply('取消'), { action: 'cancel', id: '' })
  assert.deepEqual(parseQqConfirmReply('放弃'), { action: 'cancel', id: '' })
  assert.deepEqual(parseQqConfirmReply('不发'), { action: 'cancel', id: '' })
  assert.equal(parseQqConfirmReply('不确认'), null)
  assert.equal(parseQqConfirmReply('确认一下'), null)
  assert.equal(parseQqConfirmReply('确认 AB1'), null)
  assert.equal(parseQqConfirmReply(''), null)
})

test('有效期是 5 分钟，不会把截图长期挂起', () => {
  assert.equal(QQ_CONFIRM_TTL_MS, 5 * 60_000)
})
