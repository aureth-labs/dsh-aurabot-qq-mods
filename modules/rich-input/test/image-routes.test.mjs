// 图片三路：① 目标模型能看图就直接放行；② 看不了图用看图模型转文字；③ 主模型失败换回退模型。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, imageSeg, textBlock, info, msgWith, allText } from './harness.mjs'

const BLIND = '你现在的模型看不了图，只能知道有这么回事（主人 发了 1 张图片，内容看不到）'
const GOOD = '一只橘猫，趴在沙发上'

test('① 目标模型自己能看图：模块不动插件塞进来的图片块', async () => {
  const h = makeHarness({ canSeeImages: async () => true })
  const content = [textBlock('看图'), { type: 'image', data: 'base64...', mediaType: 'image/png', name: 'qq-900-1' }]
  const out = await h.prompt(content, info())
  assert.equal(out, undefined) // 没改动，插件原样放行
  assert.equal(h.calls.ask.length, 0)
})

test('② 目标模型看不了图：主看图模型把图片转成文字', async () => {
  const h = makeHarness({ ask: async () => GOOD })
  await h.message(msgWith('m1', [imageSeg()]))
  const out = await h.prompt([textBlock(BLIND)], info())
  const text = allText(out)

  assert.equal(h.calls.ask.length, 1)
  assert.equal(h.calls.ask[0].cfg.model.model, 'vision-main')
  assert.ok(h.calls.ask[0].images?.[0]?.data, '要把图片字节交给看图模型')
  assert.match(text, /转成的文字/)
  assert.match(text, new RegExp(GOOD))
  assert.doesNotMatch(text, /看不了图/, '那句误导她的提示要被换掉')
})

test('③ 主看图模型假装看到 / 失败，换回退模型再试', async () => {
  const h = makeHarness({
    ask: async (req) => req.cfg.model.model === 'vision-main' ? '我无法看到图片' : GOOD
  })
  await h.message(msgWith('m1', [imageSeg()]))
  const out = await h.prompt([textBlock(BLIND)], info())
  const text = allText(out)

  assert.equal(h.calls.ask.length, 2, '主模型 + 回退各调一次')
  assert.equal(h.calls.ask[0].cfg.model.model, 'vision-main')
  assert.equal(h.calls.ask[1].cfg.model.model, 'vision-backup')
  assert.match(text, new RegExp(GOOD))
  assert.match(text, /vision-backup/, '说明文字里要写明是回退模型转的')
})
