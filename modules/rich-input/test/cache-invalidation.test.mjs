// 缓存失效：同一张图的描述会缓存；手动换看图模型要清掉旧失败记录，超时记录躲得更久。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, imageSeg, textBlock, info, msgWith, allText } from './harness.mjs'

const BLIND = '你现在的模型看不了图，只能知道有这么回事（主人 发了 1 张图片，内容看不到）'
const GOOD = '一只橘猫，趴在沙发上'

test('同一张图的描述结果会缓存，下一轮不再调看图模型', async () => {
  const h = makeHarness({ ask: async () => GOOD })
  const prompt = () => h.prompt([textBlock(BLIND)], info())
  await h.message(msgWith('m1', [imageSeg({ url: 'http://x/same.png' })]))
  await prompt()
  assert.equal(h.calls.ask.length, 1)

  // 同一条消息 id、同一张图再来一轮
  await h.prompt([textBlock(BLIND)], info())
  const stats = h.mod.stats()
  assert.equal(stats.described, 1, '描述缓存里只有一条')
})

test('面板手动换看图模型，立刻清掉它之前的失败记录', async () => {
  let fail = true
  const h = makeHarness({
    settings: { visionModel: 'p::vision-main' },
    ask: async () => fail ? Promise.reject(new Error('连接失败')) : GOOD,
    listModels: async () => [
      { provider: 'p', model: 'vision-main', vision: true, name: 'Main' },
      { provider: 'p', model: 'vision-backup', vision: true, name: 'Backup' }
    ]
  })
  await h.message(msgWith('m1', [imageSeg()]))
  // 第一次：主模型失败，走回退
  await h.prompt([textBlock(BLIND)], info())
  const state1 = await h.calls.routes['/state']()
  assert.ok(state1.broken.some((b) => b.model.includes('vision-main')), '主模型被记进失败列表')

  // 主人到面板把首选换成别的
  fail = false
  h.setSettings({ visionModel: 'p::vision-backup' })
  await h.calls.routes['/state']()
  const state2 = await h.calls.routes['/state']()
  // 手动换模型会把那个模型的失败记录清掉；至少首选不再是坏的，也不该再报刚换成的这个坏
  assert.ok(!state2.broken.some((b) => b.model.includes('vision-backup')), '刚手动选的模型不该带旧失败记录')
})
