import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, isTask } from '../lib/classify.mjs'

test('明显的活', () => {
  assert.equal(isTask('帮我查一下表格'), true)
  assert.equal(isTask('[文件 a.xlsx]'), true)
  assert.equal(isTask('算算合计'), true)
  assert.equal(isTask('最贵的是哪个'), true)
  assert.equal(isTask('加上你爸的工资一块'), true)
  assert.equal(isTask('就你说的存3年对吧'), true)
  assert.equal(isTask('你看这个是什么材质的'), true)
})

test('误报修复：这些是闲聊', () => {
  assert.equal(isTask('哈哈 是加上你爸'), false)
  assert.equal(isTask('不知道今天能不能发'), false)
  assert.equal(isTask('我都存上了'), false)
  assert.equal(isTask('嗯'), false)
  assert.equal(isTask('好的'), false)
  assert.equal(isTask('😂'), false)
  assert.equal(isTask('发工资了'), false)
  assert.equal(isTask('我吃饭啊'), false)
  assert.equal(isTask(''), false)
})
