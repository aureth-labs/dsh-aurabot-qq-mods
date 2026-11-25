import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverImageModels, isImageModel, labelOf, pickEntry, providerIdOf } from '../lib/discover.mjs'
import { imageUrlsFromText, isPublicAddress } from '../lib/generate.mjs'

test('认出生图模型，不把聊天/图片理解模型当生图', () => {
  assert.equal(isImageModel({ id: 'image-gen', name: '豆包 生图（Seedream 5.0）' }), true)
  assert.equal(isImageModel({ id: 'doubao-seedream-5-0-pro' }), true)
  assert.equal(isImageModel({ id: 'x', name: '绘图模型' }), true)
  assert.equal(isImageModel({ id: 'gpt-image-2', name: 'GPT Image' }), true)
  // 普通聊天模型
  assert.equal(isImageModel({ id: '2.1-pro', name: '豆包 2.1 Pro' }), false)
  // 图片理解 ≠ 生图
  assert.equal(isImageModel({ id: 'vision-chat', name: '图片理解' }), false)
  assert.equal(isImageModel({ id: '', name: '' }), false)
})

test('提供方条目几种写法都认得', () => {
  assert.equal(providerIdOf('doubao'), 'doubao')
  assert.equal(providerIdOf({ id: 'doubao' }), 'doubao')
  assert.equal(providerIdOf({ provider: 'doubao' }), 'doubao')
  assert.equal(providerIdOf({ name: 'doubao' }), 'doubao')
  assert.equal(providerIdOf(null), '')
})

test('从目录里挑出生图模型，去重且保留顺序', async () => {
  const providers = ['doubao', 'openai']
  const catalogs = {
    doubao: [
      { id: '2.1-pro', name: '豆包 2.1 Pro' },
      { id: 'image-gen', name: '豆包 生图（Seedream 5.0）' },
    ],
    openai: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
  }
  const { models, errors } = await discoverImageModels(providers, async (p) => catalogs[p])
  assert.deepEqual(models, [
    { provider: 'doubao', model: 'image-gen', name: '豆包 生图（Seedream 5.0）' },
    { provider: 'openai', model: 'gpt-image-2', name: 'GPT Image 2' },
  ])
  assert.deepEqual(errors, [])
})

test('一个提供方挂了不影响其它，并如实记下错误', async () => {
  const { models, errors } = await discoverImageModels(['bad', 'doubao'], async (p) => {
    if (p === 'bad') throw new Error('连接超时')
    return [{ id: 'image-gen', name: '豆包 生图' }]
  })
  assert.equal(models.length, 1)
  assert.equal(models[0].provider, 'doubao')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].provider, 'bad')
  assert.match(errors[0].message, /连接超时/)
})

test('key 往返：labelOf 与 pickEntry 对得上', () => {
  const models = [{ provider: 'doubao', model: 'image-gen', name: '豆包 生图（Seedream 5.0）' }]
  assert.equal(labelOf(models[0]), 'doubao / 豆包 生图（Seedream 5.0）')
  assert.equal(pickEntry(models, 'doubao\u0000image-gen'), models[0])
  assert.equal(pickEntry(models, 'doubao\u0000nope'), null)
  assert.equal(pickEntry(models, ''), null)
})

test('Markdown 图片优先于正文里的普通链接', () => {
  const text = '详见 https://vendor.example/help。\n![result](https://cdn.example/r.png)'
  assert.deepEqual(imageUrlsFromText(text), ['https://cdn.example/r.png', 'https://vendor.example/help'])
})

test('裸链接、带标题、尖括号包起来的都能取到', () => {
  assert.deepEqual(imageUrlsFromText('画好了：https://img.example/a.png'), ['https://img.example/a.png'])
  assert.deepEqual(imageUrlsFromText('![x](https://img.example/b.png "标题")'), ['https://img.example/b.png'])
  assert.deepEqual(imageUrlsFromText('![x](<https://img.example/c.png>)'), ['https://img.example/c.png'])
  assert.deepEqual(imageUrlsFromText('没有图'), [])
})

test('内网地址一律不算公网', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.1.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPublicAddress(a), false, a)
  }
  for (const a of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPublicAddress(a), true, a)
  }
})
