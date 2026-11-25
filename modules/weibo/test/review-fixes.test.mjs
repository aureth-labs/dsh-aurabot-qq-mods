import test from 'node:test'
import assert from 'node:assert/strict'
import { capOf, bizErrorOf } from '../index.mjs'

test('上限 0 表示关掉，不能被当成"没设"（审查 #3）', () => {
  assert.equal(capOf({ post: 0 }, 'post'), 0)
  assert.equal(capOf({ post: 5 }, 'post'), 5)
  assert.equal(capOf({}, 'post'), 5)
  assert.equal(capOf(undefined, 'comment'), 5)
})

test('业务层失败要识别出来（审查 #8）', () => {
  assert.equal(bizErrorOf({ ok: 1, data: { idstr: '1' } }), '')
  assert.equal(bizErrorOf({ code: '100000' }), '')
  assert.match(bizErrorOf({ ok: 0, msg: '出错' }), /出错/)
  assert.match(bizErrorOf({ code: 20003, msg: '权限不足' }), /权限不足/)
  assert.match(bizErrorOf(null), /不是对象/)
})

test('删除也走试运行和闸门（审查 #1）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const del = src.slice(src.indexOf('async function doDelPost'), src.indexOf('// ============ 渲染'))
  assert.match(del, /dryRun/)          // 试运行
  assert.match(del, /guardedWrite/)    // 闸门 + 计数 + 串行
})

test('写操作串行化，避免并发绕过上限（审查 #2）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(src, /withWriteLock/)
  assert.match(src, /guardedWrite\('post'/)
  assert.match(src, /guardedWrite\('repost'/)
  assert.match(src, /guardedWrite\('comment'/)
})

test('写工具和"读主人微博"只给主人私聊（审查 #4/#5）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(src, /const ownerOnly = level === 'full'/)
  assert.match(src, /if \(ownerOnly\) tools\.push/)
})
